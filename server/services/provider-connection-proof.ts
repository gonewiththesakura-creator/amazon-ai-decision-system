import type { AppDatabase } from '../database/database.js';
import {randomUUID} from 'node:crypto';

export interface ProviderConnectionProof {
  provider: 'sellersprite';
  runId: string | null;
  collectedAt: string;
  status: 'success';
  method: 'fresh_list_tools' | 'explicit_connection_test';
}

/** Read existing evidence only. Never updates a connection timestamp or performs I/O. */
export function providerConnectionProof(db: AppDatabase, runId: string | null): ProviderConnectionProof | null {
  if (runId) {
    const row = db.prepare(`SELECT l.completed_at FROM mcp_call_logs l
      JOIN provider_capability_snapshots c ON c.sync_run_id=l.sync_run_id AND c.provider_id=l.provider_id
      WHERE l.sync_run_id=? AND l.provider_id='sellersprite' AND l.capability='LIST_TOOLS'
        AND l.status='success' AND l.error_code IS NULL AND l.cache_hit=0 AND l.result_count>0
        AND julianday(l.completed_at) >= julianday(l.started_at)
        AND EXISTS (SELECT 1 FROM data_tasks run WHERE run.id=l.sync_run_id AND run.sync_run_id=run.id
          AND run.task_type='critical_sync' AND run.status='success'
          AND julianday(l.started_at) >= julianday(run.started_at)
          AND julianday(l.completed_at) <= julianday(run.completed_at))
        AND julianday(c.collected_at) BETWEEN julianday(l.started_at,'-5 minutes') AND julianday(l.completed_at,'+5 minutes')
        AND NOT EXISTS(SELECT 1 FROM data_tasks t WHERE t.sync_run_id=l.sync_run_id AND t.status IN ('failed','partial'))
      ORDER BY l.completed_at DESC LIMIT 1`).get(runId);
    if (row) return {provider:'sellersprite',runId,collectedAt:String(row.completed_at),status:'success',method:'fresh_list_tools'};
    // A requested run can never inherit a manual test or another run's connection.
    return null;
  }
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_connection_proofs'").get())return null;
  const explicit = db.prepare(`SELECT p.collected_at AS last_sync_at FROM provider_connection_proofs p
    JOIN data_sources s ON s.id='source-sellersprite-mcp' AND s.status='connected' AND s.last_sync_at=p.collected_at
    WHERE p.provider='sellersprite' AND p.status='success' AND p.method='explicit_connection_test'
      AND julianday(p.collected_at) BETWEEN julianday('now','-1 day') AND julianday('now','+5 minutes')
      AND julianday(p.expires_at)>julianday('now') ORDER BY p.collected_at DESC LIMIT 1`).get();
  return explicit ? {provider:'sellersprite',runId:null,collectedAt:String(explicit.last_sync_at),status:'success',method:'explicit_connection_test'} : null;
}

/** Operational age only; never a certification validity condition. */
export function connectionFreshness(proof: ProviderConnectionProof | null, now = Date.now()): 'FRESH' | 'STALE' | 'UNKNOWN' {
  if (!proof || !Number.isFinite(Date.parse(proof.collectedAt))) return 'UNKNOWN';
  const age = now - Date.parse(proof.collectedAt);
  return age < -300000 ? 'UNKNOWN' : age <= 86400000 ? 'FRESH' : 'STALE';
}

/** Only the explicit connection-test route calls this after successful authentication. */
export function recordExplicitConnectionProof(db:AppDatabase,collectedAt:string):void {
  db.prepare(`INSERT INTO provider_connection_proofs VALUES(?,'sellersprite',NULL,?,?,'success','explicit_connection_test')`)
    .run(randomUUID(),collectedAt,new Date(Date.parse(collectedAt)+86400000).toISOString());
}
