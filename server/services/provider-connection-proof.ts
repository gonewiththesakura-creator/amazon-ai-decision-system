import type { AppDatabase } from '../database/database.js';

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
        AND julianday(l.completed_at) BETWEEN julianday('now','-1 day') AND julianday('now','+5 minutes')
        AND julianday(c.collected_at) BETWEEN julianday(l.started_at,'-5 minutes') AND julianday(l.completed_at,'+5 minutes')
        AND NOT EXISTS(SELECT 1 FROM data_tasks t WHERE t.sync_run_id=l.sync_run_id AND t.status IN ('failed','partial'))
      ORDER BY l.completed_at DESC LIMIT 1`).get(runId);
    if (row) return {provider:'sellersprite',runId,collectedAt:String(row.completed_at),status:'success',method:'fresh_list_tools'};
  }
  const explicit = db.prepare(`SELECT last_sync_at FROM data_sources WHERE id='source-sellersprite-mcp'
    AND status='connected' AND julianday(last_sync_at) BETWEEN julianday('now','-1 day') AND julianday('now','+5 minutes')`).get();
  return explicit ? {provider:'sellersprite',runId:null,collectedAt:String(explicit.last_sync_at),status:'success',method:'explicit_connection_test'} : null;
}
