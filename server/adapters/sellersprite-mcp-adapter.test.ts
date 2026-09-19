import { describe, expect, it } from 'vitest';
import { SellerSpriteMCPAdapter } from './sellersprite-mcp-adapter.js';
import { SellerSpriteMcpClient, type SellerSpriteMcpTransport } from './sellersprite-mcp-client.js';
import { SqliteMcpCallLedgerStore, SqliteMcpResponseCacheStore } from './sellersprite-mcp-store.js';
import { openDatabase } from '../database/database.js';

describe('SellerSpriteMCPAdapter', () => {
  it('records the exact market path and ASIN with result counts for scoped go-live checks', async () => {
    const database = openDatabase(':memory:');
    try {
      const transport = new AdapterTransport();
      const client = new SellerSpriteMcpClient({ transport,
        ledgerStore: new SqliteMcpCallLedgerStore(database) });
      const adapter = new SellerSpriteMCPAdapter({ client });
      await adapter.fetchMarketStatistics({ marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608' });
      await adapter.fetchAsinSalesTrend({ marketplace: 'US', asin: 'B000TEST01' });

      expect(database.prepare(`SELECT capability, entity_type, entity_id, result_count
        FROM mcp_call_logs ORDER BY rowid`).all()).toEqual([
        { capability: 'MARKET_STATISTICS', entity_type: 'market', entity_id: '1055398:1063252', result_count: 1 },
        { capability: 'ASIN_SALES_TREND', entity_type: 'product', entity_id: 'B000TEST01', result_count: 1 },
      ]);
    } finally { database.close(); }
  });
  it('does not certify or cache a malformed capability response', async () => {
    const database = openDatabase(':memory:');
    try {
      const transport = new AdapterTransport();
      transport.responseData = { asin: { asin: 'B000TEST01' }, salesTrendPoints: 'not-an-array' };
      const client = new SellerSpriteMcpClient({ transport,
        ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
        retry: { maxAttempts: 1, baseDelayMs: 1 },
      });
      const adapter = new SellerSpriteMCPAdapter({ client });
      const input = { marketplace: 'US', asin: 'B000TEST01' };

      await expect(adapter.fetchAsinSalesTrend(input)).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
      expect(database.prepare(`SELECT status, error_code FROM mcp_call_logs`).all()).toEqual([
        { status: 'failed', error_code: 'INVALID_SCHEMA' },
      ]);
      expect(database.prepare('SELECT COUNT(*) AS total FROM mcp_response_cache').get()).toEqual({ total: 0 });

      transport.responseData = undefined;
      const valid = await adapter.fetchAsinSalesTrend(input);
      expect(valid.data.salesTrendPoints).toHaveLength(1);
      expect(transport.calls).toHaveLength(2);
    } finally { database.close(); }
  });
  it('marks a malformed SellerSprite envelope as a schema failure without retrying', async () => {
    const database = openDatabase(':memory:');
    try {
      const transport = new AdapterTransport();
      transport.responsePayload = { data: { asin: {}, salesTrendPoints: [] } };
      const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({
        transport, ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
      }) });

      await expect(adapter.fetchAsinSalesTrend({ marketplace: 'US', asin: 'B000TEST01' }))
        .rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
      expect(database.prepare('SELECT status, error_code FROM mcp_call_logs').all()).toEqual([
        { status: 'failed', error_code: 'INVALID_SCHEMA' },
      ]);
      expect(database.prepare('SELECT COUNT(*) AS total FROM mcp_response_cache').get()).toEqual({ total: 0 });
      expect(transport.calls).toHaveLength(1);
    } finally { database.close(); }
  });
  it('bypasses a previously cached malformed capability result', async () => {
    const database = openDatabase(':memory:');
    try {
      const transport = new AdapterTransport();
      transport.responseData = { asin: { asin: 'B000TEST01' }, salesTrendPoints: 'not-an-array' };
      const client = new SellerSpriteMcpClient({ transport,
        ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
      });
      await client.callTool({
        tool: 'asin_sales_trend', arguments: { marketplace: 'US', asin: 'B000TEST01' },
        context: { capability: 'ASIN_SALES_TREND' },
      });
      transport.responseData = undefined;

      const result = await new SellerSpriteMCPAdapter({ client })
        .fetchAsinSalesTrend({ marketplace: 'US', asin: 'B000TEST01' });

      expect(result.data.salesTrendPoints).toHaveLength(1);
      expect(transport.calls).toHaveLength(2);
      expect(database.prepare('SELECT status, cache_hit FROM mcp_call_logs ORDER BY rowid').all()).toEqual([
        { status: 'success', cache_hit: 0 },
        { status: 'success', cache_hit: 0 },
      ]);
    } finally { database.close(); }
  });
  it('reports sanitized connection and required-capability diagnostics', async () => {
    const transport = new AdapterTransport();
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const result = await adapter.testConnection();

    expect(result).toMatchObject({
      connected: true,
      authenticated: true,
      toolCount: 5,
      requiredCapabilityCount: 5,
      availableRequiredCapabilityCount: 5,
      missingCapabilities: [],
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result)).not.toMatch(/secret|token|https?:\/\//i);
  });

  it('uses discovered nested market tool arguments and retains absent statistics as absent', async () => {
    const transport = new AdapterTransport();
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const result = await adapter.fetchMarketStatistics({
      marketplace: 'US', nodeIdPath: 'Home/Bed Pillows', month: '2026-08',
    });

    expect(transport.calls[0]).toEqual({
      name: 'market_research_statistics',
      arguments: { request: { marketplace: 'US', nodeIdPath: 'Home/Bed Pillows', month: '2026-08' } },
    });
    expect(result.data).toMatchObject({ products: 100, brands: 71, avgPrice: 44.83 });
    expect(result.data).not.toHaveProperty('totalUnits');
    expect(result.provenance).toMatchObject({ sourceType: 'mcp', isEstimated: true });
  });

  it('sends flat market arguments when the discovered tool schema requires flat fields', async () => {
    const transport = new AdapterTransport();
    transport.flatMarketTools = true;
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    await adapter.fetchMarketStatistics({
      marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608',
    });
    await adapter.fetchMarketConcentration({
      marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608',
    });
    await adapter.fetchMarketProducts({
      marketplace: 'US', marketId: 'bed-pillows', keywords: ['pillow'],
    });

    expect(transport.calls.map(({ arguments: args }) => args)).toEqual([
      { marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608' },
      { marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608' },
      { marketplace: 'US', nodeIdPath: 'bed-pillows', departmentKeyword: 'pillow' },
    ]);
  });

  it('routes concentration, monthly ASIN trend, and competitor candidates through their discovered tools', async () => {
    const transport = new AdapterTransport();
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const concentration = await adapter.fetchMarketConcentration({ marketplace: 'US', nodeIdPath: 'Home/Bed Pillows' });
    const trend = await adapter.fetchAsinSalesTrend({ marketplace: 'US', asin: 'B000TEST01' });
    const candidates = await adapter.discoverAsinCompetitors({ marketplace: 'US', asin: 'B000TEST01', size: 10 });

    expect(concentration.data).toHaveLength(2);
    expect(trend.data.salesTrendPoints).toEqual([
      { month: '2026-07', childUnitSales: 200, childSalesRevenue: 8_000 },
    ]);
    expect(candidates.data[0]).toMatchObject({ asin: 'B000TEST02' });
    expect(transport.calls.map((call) => call.name)).toEqual([
      'market_product_concentration', 'asin_sales_trend', 'asin_competitor',
    ]);
    expect(transport.calls.at(-1)?.arguments).toEqual({ marketplace: 'US', asin: 'B000TEST01', size: 10 });
  });

  it('rejects failed SellerSprite envelopes and missing legacy overview metrics without fabricating data', async () => {
    const transport = new AdapterTransport();
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });
    await expect(adapter.fetchMarketOverview({ marketplace: 'US', keywords: ['pillow'], marketId: 'Home/Bed Pillows' }))
      .rejects.toThrow(/missing|缺失/i);

    transport.remoteCode = 'DENIED';
    await expect(adapter.fetchAsinSalesTrend({ marketplace: 'US', asin: 'B000TEST01' }))
      .rejects.toThrow(/rejected|失败/i);
  });

  it('fails closed with a configuration error when no server endpoint exists', async () => {
    const previous = process.env.SELLERSPRITE_MCP_URL;
    delete process.env.SELLERSPRITE_MCP_URL;
    try {
      const adapter = new SellerSpriteMCPAdapter();
      await expect(adapter.fetchProductDetail({ marketplace: 'US', asin: 'B000TEST01' }))
        .rejects.toThrow(/SELLERSPRITE_MCP_URL/);
    } finally {
      if (previous === undefined) delete process.env.SELLERSPRITE_MCP_URL;
      else process.env.SELLERSPRITE_MCP_URL = previous;
    }
  });

  it('normalizes monthly trend dates to month-end and rejects products without an observation date', async () => {
    const transport = new AdapterTransport();
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const detail = await adapter.fetchProductDetail({ marketplace: 'US', asin: 'B000TEST01' });
    expect(detail.latest.date).toBe('2026-07-31');

    transport.marketItems = [{ asin: 'B000TEST02', title: 'Undated product' }];
    await expect(adapter.fetchMarketProducts({ marketplace: 'US', keywords: ['pillow'], marketId: 'Home/Bed Pillows' }))
      .rejects.toThrow(/observation|date/i);
  });

  it('keeps day-specific history and does not borrow current ASIN attributes for an old observation', async () => {
    const transport = new AdapterTransport();
    transport.salesTrendPoints = [{ month: '2026-08-05', childUnitSales: 10 }];
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const detail = await adapter.fetchProductDetail({ marketplace: 'US', asin: 'B000TEST01' });

    expect(detail.latest).toMatchObject({
      date: '2026-08-05', estimatedSales: 10, price: null, rating: null,
      reviewCount: null, bsr: null, sellerCount: null,
    });
  });

  it('rejects impossible day-specific observations instead of silently normalizing them', async () => {
    const transport = new AdapterTransport();
    transport.salesTrendPoints = [{ month: '2026-02-31', childUnitSales: 10 }];
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });
    await expect(adapter.fetchProductDetail({ marketplace: 'US', asin: 'B000TEST01' }))
      .rejects.toThrow(/date/i);
  });
});

class AdapterTransport implements SellerSpriteMcpTransport {
  readonly calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  remoteCode = 'OK';
  responseData: unknown;
  responsePayload: unknown;
  marketItems: Array<Record<string, unknown>> = [];
  flatMarketTools = false;
  salesTrendPoints: Array<Record<string, unknown>> = [
    { month: '2026-07', childUnitSales: 200, childSalesRevenue: 8_000 },
  ];

  async connect(): Promise<void> {}
  async ping(): Promise<unknown> { return { _meta: { progressToken: 'test' } }; }
  async close(): Promise<void> {}

  async listTools(): Promise<unknown> {
    const marketTool = this.flatMarketTools
      ? (name: string, required: string[]) => tool(name, required)
      : (name: string) => tool(name, ['request'], { marketplace: {}, nodeIdPath: {} });
    return {
      tools: [
        marketTool('market_research_statistics', this.flatMarketTools ? ['marketplace', 'nodeIdPath'] : ['request']),
        marketTool('market_product_concentration', this.flatMarketTools ? ['marketplace', 'nodeIdPath'] : ['request']),
        tool('asin_sales_trend', ['marketplace', 'asin']),
        tool('asin_competitor', ['marketplace', 'asin']),
        this.flatMarketTools
          ? tool('market_research', ['marketplace', 'nodeIdPath'])
          : tool('market_research', ['request'], { marketplace: {} }),
      ],
      _meta: { progressToken: 'test' },
    };
  }

  async callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown> {
    this.calls.push(params);
    const data: Record<string, unknown> = {
      market_research_statistics: {
        products: 100, brands: 71, sellers: 69, avgUnits: 8_919, avgRevenue: 398_295,
        avgPrice: 44.83, avgRating: 4.3,
      },
      market_product_concentration: [
        { asin: 'B000TEST01', totalUnitsRatio: 0.1, totalRevenueRatio: 0.12 },
        { asin: 'B000TEST02', totalUnitsRatio: 0.08, totalRevenueRatio: 0.09 },
      ],
      asin_sales_trend: {
        asin: { asin: 'B000TEST01', title: 'Test product', marketplace: 'US',
          price: 50, rating: 4.5, ratings: 300, bsr: 10, sellers: 2 },
        salesTrendPoints: this.salesTrendPoints,
      },
      asin_competitor: [{ asin: 'B000TEST02', title: 'Candidate', units: 300 }],
      market_research: { pages: 1, page: 1, size: 5, total: this.marketItems.length, items: this.marketItems, hasNextPage: false },
    };
    const payload = this.responsePayload ?? { code: this.remoteCode, message: this.remoteCode === 'OK' ? 'success' : 'denied',
      data: this.responseData === undefined ? data[params.name] : this.responseData };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload), annotations: { audience: ['assistant'], priority: 1 } }],
      isError: false,
      _meta: { progressToken: 'test' },
    };
  }
}

function tool(name: string, required: string[], requestProperties?: Record<string, unknown>) {
  return {
    name,
    description: name.replaceAll('_', ' '),
    inputSchema: {
      type: 'object',
      required,
      properties: Object.fromEntries(required.map((field) => [field, field === 'request'
        ? { type: 'object', required: Object.keys(requestProperties ?? {}), properties: requestProperties }
        : { type: 'string' }])),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: { provider: 'sellersprite' },
  };
}
