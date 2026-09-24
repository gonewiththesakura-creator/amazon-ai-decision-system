import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { createApp } from '../app.js';
import { McpBudgetManager, mcpExecution } from './mcp-policy.js';
import { SellerSpriteMcpClient, type SellerSpriteMcpTransport } from './sellersprite-mcp-client.js';
import { SellerSpriteMCPAdapter } from './sellersprite-mcp-adapter.js';
import { SqliteMcpResponseCacheStore } from './sellersprite-mcp-store.js';

let database: AppDatabase;
afterEach(() => { database?.close(); vi.useRealTimers(); });
function fixture() {
  database = openDatabase(':memory:');
  const budget = new McpBudgetManager(database);
  const transport: SellerSpriteMcpTransport = {
    connect: vi.fn(async () => {}), close: vi.fn(async () => {}), ping: vi.fn(async () => ({})),
    listTools: vi.fn(async () => ({tools: [
      {name: 'market_research_statistics', inputSchema: {type: 'object', required: ['marketplace', 'nodeIdPath'],
        properties: {marketplace: {type:'string'}, nodeIdPath: {type:'string'}, month: {type:'string'}}}},
      {name: 'asin_competitor', inputSchema: {type: 'object', required: ['marketplace','asin'],
        properties: {marketplace: {type:'string'}, asin: {type:'string'}}}},
    ]})),
    callTool: vi.fn(async ({arguments: args, name}) => ({content: [], structuredContent: name === 'asin_competitor'
      ? {code:'OK', data: []} : {code:'OK', data: {marketplace: 'US', nodeIdPath: '123', month: args.month, products: 3, totalProducts: 3}}})),
  };
  const client = new SellerSpriteMcpClient({transport, budget, cacheStore: new SqliteMcpResponseCacheStore(database),
    retry: {maxAttempts: 10, baseDelayMs: 0}, rateLimit: {capacity:100, refillPerSecond:100}});
  const adapter = new SellerSpriteMCPAdapter({client, database});
  return {budget, transport, client, adapter};
}
const call = {tool:'test', arguments:{asin:'B000TEST01'}, context:{}};

describe('V2.2.1 quota acceptance (offline)', () => {
  it('reads dashboard ten times without remote calls', async () => {
    const {transport, budget} = fixture();
    const app = createApp({database});
    for (let i=0; i<10; i++) await request(app).get('/api/dashboard/briefing').expect(200);
    expect(transport.callTool).not.toHaveBeenCalled();
    expect(budget.summary().todayRemoteCalls).toBe(0);
  });
  it('reuses closed months permanently and preserves acquisition time', async () => {
    const {adapter, transport} = fixture();
    const input = {marketplace:'US',nodeIdPath:'123',month:'202608'};
    const first = await adapter.fetchMarketStatistics(input, {requireObservationMonth:true});
    database.prepare("UPDATE mcp_local_observations SET expires_at='2000-01-01'").run();
    const second = await adapter.fetchMarketStatistics(input, {requireObservationMonth:true});
    expect(second.provenance.collectedAt).toBe(first.provenance.collectedAt);
    expect(transport.callTool).toHaveBeenCalledTimes(1);
  });
  it('reuses current month within 72 hours and across adapter restart', async () => {
    const {adapter, client, transport} = fixture();
    const input = {marketplace:'US',nodeIdPath:'123',month:new Date().toISOString().slice(0,7).replace('-','')};
    await adapter.fetchMarketStatistics(input);
    await new SellerSpriteMCPAdapter({client, database}).fetchMarketStatistics(input);
    expect(transport.callTool).toHaveBeenCalledTimes(1);
    expect(transport.listTools).toHaveBeenCalledTimes(1);
  });
  it('reuses discovery for fourteen days, including empty result sets', async () => {
    const {adapter, transport} = fixture();
    const input = {marketplace:'US',asin:'B000TEST01'};
    await adapter.discoverAsinCompetitors(input);
    await adapter.discoverAsinCompetitors(input);
    expect(transport.callTool).toHaveBeenCalledTimes(1);
  });
  it('coalesces five concurrent identical requests before rate limiting', async () => {
    const {client, transport, budget} = fixture();
    await Promise.all(Array.from({length:5}, () => client.callTool(call)));
    expect(transport.callTool).toHaveBeenCalledTimes(1);
    expect(budget.summary().todayRemoteCalls).toBe(1);
  });
  it('applies shorter TTL policy to already persisted observations and raw cache', async () => {
    const {adapter, budget, transport} = fixture();
    const input = {marketplace:'US',nodeIdPath:'123',month:new Date().toISOString().slice(0,7).replace('-','')};
    await adapter.fetchMarketStatistics(input);
    const old = new Date(Date.now()-120000).toISOString();
    database.prepare('UPDATE mcp_local_observations SET collected_at=?').run(old);
    database.prepare('UPDATE mcp_response_cache SET created_at=?').run(old);
    budget.calibrate(500,100,{MARKET_STATISTICS:60000});
    await adapter.fetchMarketStatistics(input);
    expect(transport.callTool).toHaveBeenCalledTimes(2);
  });
  it('blocks automatic requests at remaining 70', async () => {
    const {client, budget, transport} = fixture();
    budget.calibrate(70,100);
    await expect(client.callTool(call)).rejects.toMatchObject({code:'BUDGET_BLOCKED'});
    expect(transport.callTool).not.toHaveBeenCalled();
  });
  it('shares an acquisition between independent clients through SQLite leases and cache', async () => {
    const {client, transport, budget} = fixture();
    const second = new SellerSpriteMcpClient({transport, budget, cacheStore:new SqliteMcpResponseCacheStore(database)});
    await Promise.all([client.callTool(call), second.callTool(call)]);
    expect(transport.callTool).toHaveBeenCalledTimes(1);
    expect(budget.summary().todayRemoteCalls).toBe(1);
  });
  it('allows confirmed force with an audit trail and blocks unconfirmed force', async () => {
    const {client, budget} = fixture();
    budget.calibrate(70,100);
    await expect(mcpExecution.run({syncMode:'force'}, () => client.callTool(call))).rejects.toMatchObject({code:'CONFIRMATION_REQUIRED'});
    await mcpExecution.run({syncMode:'force',confirmed:true,runId:'test'}, () => client.callTool({...call,context:{fresh:true}}));
    expect(database.prepare("SELECT sync_mode FROM mcp_usage_events WHERE outcome='remote_call'").get()).toEqual({sync_mode:'force'});
  });
  it('certification ignores caches while ordinary run IDs do not', async () => {
    const {adapter, transport} = fixture();
    const input = {marketplace:'US',nodeIdPath:'123',month:'202608'};
    for (const id of ['a','b','c']) database.prepare(`INSERT INTO data_tasks
      (id,name,task_type,target,source,marketplace,status,created_at)
      VALUES (?, 'test','critical_sync','market','SellerSprite MCP','US','running',?)`).run(id, new Date().toISOString());
    await adapter.fetchMarketStatistics(input,{runId:'a'});
    await adapter.fetchMarketStatistics(input,{runId:'b'});
    expect(transport.callTool).toHaveBeenCalledTimes(1);
    await mcpExecution.run({syncMode:'certification',confirmed:true}, () => adapter.fetchMarketStatistics(input,{runId:'c'}));
    expect(transport.callTool).toHaveBeenCalledTimes(2);
    expect(transport.listTools).toHaveBeenCalledTimes(2);
  });
  it('limits retries to two billed attempts regardless of legacy options', async () => {
    const {client, transport, budget} = fixture();
    vi.mocked(transport.callTool).mockRejectedValue(new Error('timeout'));
    await expect(client.callTool(call)).rejects.toMatchObject({code:'TIMEOUT'});
    expect(transport.callTool).toHaveBeenCalledTimes(2);
    expect(budget.summary().todayRemoteCalls).toBe(2);
  });
  it('opens after three same failures, then allows only one half-open probe', async () => {
    const {client, transport, budget} = fixture();
    vi.mocked(transport.callTool).mockRejectedValue(new Error('timeout'));
    await client.callTool(call).catch(() => {});
    await client.callTool(call).catch(() => {});
    await expect(client.callTool(call)).rejects.toMatchObject({code:'CIRCUIT_OPEN'});
    expect(transport.callTool).toHaveBeenCalledTimes(3);
    expect(budget.summary().circuit).toBe('OPEN');
    database.prepare("UPDATE provider_quota_state SET open_until='2000-01-01'").run();
    budget.beforeRemote('probe');
    expect(() => budget.beforeRemote('second-probe')).toThrow('CIRCUIT_OPEN');
    budget.result();
    expect(budget.summary().circuit).toBe('CLOSED');
  });
});
