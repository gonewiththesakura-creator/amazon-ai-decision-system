import type { AppDatabase } from '../database/database.js';
import { McpBudgetManager, freshExecution, currentExecution, requestKey } from '../adapters/mcp-policy.js';

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { return null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function certifiedMarketCall(call: {
  capability: string; actualTool: string | null; responseMetadataJson: string; observationMonth: string | null;
}, discovery: Record<string, unknown>): boolean {
  const cert = object(object(call.responseMetadataJson)?.observationCertification);
  const caps = object(discovery.capabilities), hashes = object(discovery.capabilitySchemaHashes);
  if (!cert || !caps || !hashes || !Array.isArray(discovery.tools) || !call.actualTool
    || caps[call.capability] !== call.actualTool || typeof cert.schemaHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(cert.schemaHash) || hashes[call.capability] !== cert.schemaHash) return false;
  const tools = discovery.tools.filter(t => object(t)?.name === call.actualTool);
  if (tools.length !== 1 || object(tools[0])?.schemaHash !== cert.schemaHash) return false;
  const schema = object(object(tools[0])?.inputSchema);
  const nested = Array.isArray(schema?.required) && schema.required.includes('request');
  const input = nested ? object(object(schema?.properties)?.request) : schema;
  if ((nested && input?.type !== 'object') || object(object(input?.properties)?.month)?.type !== 'string'
    || !/^\d{4}(0[1-9]|1[0-2])$/.test(call.observationMonth ?? '')) return false;
  if (cert.method === 'response_echo_v1') return true;
  const names: Record<string, string> = {MARKET_RESEARCH:'market_research', MARKET_STATISTICS:'market_research_statistics', PRODUCT_CONCENTRATION:'market_product_concentration'};
  return cert.method === 'documented_request_v1' && names[call.capability] === call.actualTool;
}

/** Only immutable observations from a successful, validated MCP sync are reusable. */
export class LocalObservationResolver {
  constructor(private readonly database: AppDatabase, private readonly now = Date.now) {}
  market(id: string, observationDate: string) {
    if (currentExecution().syncMode === 'force') return undefined;
    const historical = this.historicalMarket(id, observationDate);
    if (historical) return historical.snapshot;
    if (freshExecution()) return undefined;
    const row = this.database.prepare(`SELECT s.* FROM market_snapshots s
      JOIN data_tasks t ON t.id=s.sync_run_id AND t.status='success'
      WHERE s.market_node_id=? AND s.observation_date=? AND s.source_type='mcp'
        AND s.source='SellerSprite MCP' AND s.period='monthly'
      ORDER BY s.collected_at DESC LIMIT 1`).get(id, observationDate);
    if (!row || !this.fresh(row, 'MARKET_STATISTICS', observationDate)) return undefined;
    return row;
  }
  /** Revalidate original acquisition proof, never relabel an old acquisition as fresh. */
  historicalMarket(id: string, date: string, snapshotId?: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(date)) return undefined;
    const rows = this.database.prepare(`SELECT s.* FROM market_snapshots s
      JOIN data_tasks t ON t.id=s.sync_run_id AND t.status='success'
      WHERE s.market_node_id=? AND s.observation_date=? AND s.source_type='mcp'
        AND s.source='SellerSprite MCP' AND s.period='monthly'
      ORDER BY s.collected_at DESC, s.id`).all(id, date);
    const node = this.database.prepare('SELECT sellersprite_confirmed_node_path FROM market_nodes WHERE id=?').get(id);
    const path = node?.sellersprite_confirmed_node_path;
    if (typeof path !== 'string' || !/^\d+(?::\d+)*$/.test(path)) return undefined;
    const month = date.slice(0,7).replace('-', '');
    const end = new Date(Date.UTC(Number(month.slice(0,4)), Number(month.slice(4)), 0)).toISOString().slice(0,10);
    if (date !== end || date.slice(0,7) >= new Date(this.now()).toISOString().slice(0,7)) return undefined;
    for (const snapshot of rows) {
      if (snapshotId && snapshot.id !== snapshotId) continue;
      const acquired = Date.parse(String(snapshot.collected_at));
      if (!Number.isFinite(acquired) || acquired > this.now() + 300_000
        || String(snapshot.collected_at).slice(0,7) <= date.slice(0,7)) continue;
      const cap = this.database.prepare(`SELECT id, capabilities_json FROM provider_capability_snapshots
        WHERE provider_id='sellersprite' AND sync_run_id=? ORDER BY collected_at DESC, rowid DESC LIMIT 1`).get(snapshot.sync_run_id);
      const discovery = object(cap?.capabilities_json);
      if (!discovery) continue;
      const calls = this.database.prepare(`SELECT id, capability, actual_tool AS actualTool,
        response_metadata_json AS responseMetadataJson, observation_month AS observationMonth
        FROM mcp_call_logs WHERE provider_id='sellersprite' AND sync_run_id=? AND entity_type='market'
          AND entity_id=? AND observation_month=? AND status='success' AND cache_hit=0 AND result_count>0
          AND julianday(started_at) <= julianday(?) + 5.0/1440
          AND julianday(started_at) >= julianday(?) + 1
        ORDER BY id`).all(snapshot.sync_run_id, path, month, snapshot.collected_at, date) as unknown as Array<{
          id:string; capability:string; actualTool:string; responseMetadataJson:string; observationMonth:string;
        }>;
      const proof = ['MARKET_RESEARCH','MARKET_STATISTICS','PRODUCT_CONCENTRATION'].map(capability =>
        calls.find(call => call.capability === capability && certifiedMarketCall(call, discovery)));
      if (proof.some(call => !call)) continue;
      const lineage = { snapshotId:snapshot.id, originalRunId:snapshot.sync_run_id, source:snapshot.source,
        sourceType:snapshot.source_type, observationDate:snapshot.observation_date, collectedAt:snapshot.collected_at,
        marketNodeId:id, nodeIdPath:path, capabilitySnapshotId:cap?.id, snapshotHash:requestKey(snapshot),
        calls:proof.map(call => ({id:call!.id, capability:call!.capability,
          schemaHash:object(object(call!.responseMetadataJson)?.observationCertification)?.schemaHash,
          proofHash:requestKey(call)})), capabilityHash:requestKey(discovery) };
      return {snapshot, lineage};
    }
    return undefined;
  }
  recordMarketReuse(runId: string, snapshotId: string, id: string, date: string) {
    const historical = this.historicalMarket(id, date, snapshotId);
    if (!historical) throw new Error('Historical Snapshot no longer has valid acquisition evidence');
    this.database.prepare(`INSERT INTO mcp_market_reuse_lineage (sync_run_id,snapshot_id,lineage_json,created_at)
      VALUES (?,?,?,?)`).run(runId, snapshotId, JSON.stringify(historical.lineage), new Date(this.now()).toISOString());
  }
  hasMarketReuse(runId: string, id: string, date: string): boolean {
    const records = this.database.prepare(`SELECT r.snapshot_id,r.lineage_json FROM mcp_market_reuse_lineage r
      JOIN mcp_sync_observation_links l ON l.sync_run_id=r.sync_run_id AND l.snapshot_id=r.snapshot_id
        AND l.snapshot_kind='market' AND l.disposition='reused' AND l.entity_id=?
      WHERE r.sync_run_id=?`).all(id,runId);
    return records.some(record => {
      const historical = this.historicalMarket(id,date,String(record.snapshot_id));
      return historical && JSON.stringify(historical.lineage) === record.lineage_json;
    });
  }
  product(id: string, secondary = false) {
    if (freshExecution()) return [];
    const latest = this.database.prepare(`SELECT s.* FROM product_snapshots s
      JOIN data_tasks t ON t.sync_run_id=s.sync_run_id AND t.status='success'
      WHERE s.product_id=? AND s.source_type='mcp' AND s.source='SellerSprite MCP'
      ORDER BY s.collected_at DESC LIMIT 1`).get(id);
    if (!latest || !this.fresh(latest, secondary ? 'CORE_COMPETITOR' : 'ASIN_SALES_TREND')) return [];
    return this.database.prepare(`SELECT * FROM product_snapshots WHERE product_id=?
      AND source_type='mcp' AND source='SellerSprite MCP' AND collected_at=? ORDER BY observation_date`)
      .all(id, latest.collected_at);
  }
  private fresh(row: Record<string, unknown>, capability: string, month?: string) {
    const acquired = Date.parse(String(row.collected_at));
    if (!Number.isFinite(acquired) || acquired > this.now() + 300_000) return false;
    const stable = month && month.slice(0, 7) < new Date(this.now()).toISOString().slice(0, 7)
      && String(row.collected_at).slice(0, 7) > month.slice(0, 7);
    return stable || this.now() - acquired < new McpBudgetManager(this.database).ttl(capability);
  }
}
