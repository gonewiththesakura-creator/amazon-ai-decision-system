import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database/database.js';

export type SellerSpriteSyncMode = 'incremental' | 'certification' | 'force';
export interface McpExecution { syncMode: SellerSpriteSyncMode; confirmed?: boolean; runId?: string; remaining?: number }
export const mcpExecution = new AsyncLocalStorage<McpExecution>();
export const currentExecution = (): McpExecution => mcpExecution.getStore() ?? { syncMode: 'incremental' };
export const freshExecution = () => currentExecution().syncMode !== 'incremental';
const HOUR = 3_600_000;
export const DEFAULT_FRESHNESS = {
  LIST_TOOLS: 168 * HOUR, CONNECTION: HOUR / 2, MARKET_RESEARCH: 72 * HOUR,
  MARKET_STATISTICS: 72 * HOUR, PRODUCT_CONCENTRATION: 72 * HOUR,
  ASIN_SALES_TREND: 24 * HOUR, CORE_COMPETITOR: 168 * HOUR,
  ASIN_COMPETITOR_DISCOVERY: 336 * HOUR, ASIN_DETAIL: 720 * HOUR,
  PENDING_IDENTITY: 168 * HOUR,
};
export function requestKey(value: unknown): string {
  const ordered = (v: unknown): unknown => Array.isArray(v) ? v.map(ordered)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, ordered(x)])) : v;
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}
export class McpPolicyError extends Error {
  constructor(readonly code: 'BUDGET_BLOCKED' | 'CIRCUIT_OPEN' | 'SCHEMA_PAUSED' | 'CONFIRMATION_REQUIRED') {
    super(`SellerSprite ${code}`);
  }
}
interface QuotaRow {
  baseline_remaining: number; baseline_at: string; estimated_remote_calls_since_baseline: number;
  reserved_calls: number; policy_json: string; failure_code: string | null; failure_count: number;
  open_until: string | null; half_open_until: string | null;
}
export class McpBudgetManager {
  constructor(readonly database: AppDatabase, readonly now: () => number = Date.now) {}
  row() { return this.database.prepare("SELECT * FROM provider_quota_state WHERE provider_id='sellersprite'").get() as unknown as QuotaRow; }
  ttl(capability: string) {
    const row = this.row();
    const policy = JSON.parse(row.policy_json) as Record<string, number>;
    const ttl = policy[capability] ?? DEFAULT_FRESHNESS[capability as keyof typeof DEFAULT_FRESHNESS] ?? 24 * HOUR;
    const remaining = row.baseline_remaining - row.estimated_remote_calls_since_baseline;
    return capability === 'CORE_COMPETITOR' && remaining <= 300 ? ttl * 2 : ttl;
  }
  summary() {
    const row = this.row();
    const remaining = Math.max(0, row.baseline_remaining - row.estimated_remote_calls_since_baseline);
    const status = remaining > 300 ? 'NORMAL' : remaining >= 150 ? 'CONSERVE' : remaining >= 75 ? 'CRITICAL' : 'EMERGENCY';
    const counts = this.database.prepare(`SELECT outcome, COUNT(*) AS count FROM mcp_usage_events GROUP BY outcome`).all() as Array<{outcome: string; count: number}>;
    const count = (outcome: string) => counts.find((r) => r.outcome === outcome)?.count ?? 0;
    const hits = count('local_hit') + count('cache_hit') + count('remote_call');
    const since = (hours: number) => (this.database.prepare(`SELECT COUNT(*) AS n FROM mcp_usage_events
      WHERE outcome='remote_call' AND created_at >= ?`).get(new Date(this.now() - hours * HOUR).toISOString()) as {n: number}).n;
    return { estimatedRemaining: remaining, baselineRemaining: row.baseline_remaining, baselineAt: row.baseline_at,
      reserve: row.reserved_calls, periodEnd: null, status, todayRemoteCalls: since(24), weekRemoteCalls: since(168),
      localHitRate: hits ? count('local_hit') / hits : null, cacheHitRate: hits ? count('cache_hit') / hits : null,
      remoteCallRate: hits ? count('remote_call') / hits : null, outcomes: counts,
      circuit: row.open_until && Date.parse(row.open_until) > this.now() ? 'OPEN' : row.open_until ? 'HALF_OPEN' : 'CLOSED',
      policy: { ...DEFAULT_FRESHNESS, ...JSON.parse(row.policy_json) } };
  }
  record(key: string, outcome: string) {
    const context = currentExecution();
    this.database.prepare('INSERT INTO mcp_usage_events VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), key, outcome, context.syncMode, context.runId ?? null, new Date(this.now()).toISOString());
  }
  calibrate(remaining: number, reserve: number, policy: Record<string, number> = {}) {
    this.database.prepare(`UPDATE provider_quota_state SET baseline_remaining=?, baseline_at=?,
      estimated_remote_calls_since_baseline=0, reserved_calls=?, policy_json=?, updated_at=? WHERE provider_id='sellersprite'`)
      .run(remaining, new Date(this.now()).toISOString(), reserve, JSON.stringify(policy), new Date(this.now()).toISOString());
    this.record('quota', 'manual_calibration');
  }
  resetCircuit() {
    this.database.prepare(`UPDATE provider_quota_state SET failure_code=NULL, failure_count=0, open_until=NULL,
      half_open_until=NULL WHERE provider_id='sellersprite'`).run();
    this.record('circuit', 'manual_reset');
  }
  beforeRemote(key: string, secondary = false) {
    const context = currentExecution();
    if (context.syncMode !== 'incremental' && !context.confirmed) throw new McpPolicyError('CONFIRMATION_REQUIRED');
    this.database.exec('BEGIN IMMEDIATE');
    let blocked: 'BUDGET_BLOCKED' | 'CIRCUIT_OPEN' | undefined;
    try {
      const row = this.row();
      const remaining = row.baseline_remaining - row.estimated_remote_calls_since_baseline;
      const override = context.confirmed && context.syncMode !== 'incremental';
      if ((row.open_until && Date.parse(row.open_until) > this.now())
        || (row.half_open_until && Date.parse(row.half_open_until) > this.now())) blocked = 'CIRCUIT_OPEN';
      else if (remaining <= (override ? 0 : row.reserved_calls)
        || (!override && (remaining < 75 || (secondary && remaining < 150)))
        || (context.remaining !== undefined && context.remaining <= 0)) blocked = 'BUDGET_BLOCKED';
      if (!blocked) {
        this.database.prepare(`UPDATE provider_quota_state SET estimated_remote_calls_since_baseline=
          estimated_remote_calls_since_baseline+1, updated_at=?, half_open_until=? WHERE provider_id='sellersprite'`)
          .run(new Date(this.now()).toISOString(), row.open_until ? new Date(this.now() + 60_000).toISOString() : null);
        this.record(key, 'remote_call');
        if (context.remaining !== undefined) context.remaining -= 1;
      } else this.record(key, blocked === 'CIRCUIT_OPEN' ? 'circuit_open' : 'budget_blocked');
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    if (blocked) throw new McpPolicyError(blocked);
  }
  result(code?: string) {
    const initial = this.row();
    if (!code && initial.open_until && Date.parse(initial.open_until) > this.now() && !initial.half_open_until) return;
    if (!code) { this.database.prepare(`UPDATE provider_quota_state SET failure_count=0, failure_code=NULL,
      open_until=NULL, half_open_until=NULL WHERE provider_id='sellersprite'`).run(); return; }
    const row = this.row();
    const count = row.failure_code === code ? row.failure_count + 1 : 1;
    this.database.prepare(`UPDATE provider_quota_state SET failure_code=?, failure_count=?, open_until=?,
      half_open_until=NULL WHERE provider_id='sellersprite'`).run(code, count,
      count >= 3 || row.open_until ? new Date(this.now() + 15 * 60_000).toISOString() : null);
  }
}

// Clients coalesce before throttling. SQLite leases additionally protect persistent cache fills.
export class RemoteRequestSingleflight {
  private pending = new Map<string, Promise<unknown>>();
  async run<T>(key: string, action: () => Promise<T>, onJoin?: () => void): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) { onJoin?.(); return existing as Promise<T>; }
    const promise = action();
    this.pending.set(key, promise);
    try { return await promise; }
    finally { if (this.pending.get(key) === promise) this.pending.delete(key); }
  }
}
