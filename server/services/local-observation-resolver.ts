import type { AppDatabase } from '../database/database.js';
import { McpBudgetManager, freshExecution } from '../adapters/mcp-policy.js';

/** Only immutable observations from a successful, validated MCP sync are reusable. */
export class LocalObservationResolver {
  constructor(private readonly database: AppDatabase, private readonly now = Date.now) {}
  market(id: string, observationDate: string) {
    if (freshExecution()) return undefined;
    const row = this.database.prepare(`SELECT s.* FROM market_snapshots s
      JOIN data_tasks t ON t.id=s.sync_run_id AND t.status='success'
      WHERE s.market_node_id=? AND s.observation_date=? AND s.source_type='mcp'
        AND s.source='SellerSprite MCP' AND s.period='monthly'
      ORDER BY s.collected_at DESC LIMIT 1`).get(id, observationDate);
    if (!row || !this.fresh(row, 'MARKET_STATISTICS', observationDate)) return undefined;
    return row;
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
