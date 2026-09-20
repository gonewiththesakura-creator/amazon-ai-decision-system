import type { AppDatabase } from '../database/database.js';

export type ObservationKind = 'fact' | 'market' | 'product';

export function isLiveObservationReadable(
  database: AppDatabase,
  kind: ObservationKind,
  recordId: string,
  sourceType: string,
  syncRunId: string | null,
): boolean {
  if (sourceType === 'mock') return false;
  if (!syncRunId && sourceType !== 'mcp') return true;
  const observationQuery = kind === 'fact' ? `
    SELECT fact.entity_id AS entityId, fact.marketplace, fact.source_type AS sourceType,
      fact.sync_run_id AS syncRunId
    FROM metric_facts fact WHERE fact.id = ?
  ` : kind === 'market' ? `
    SELECT snapshot.market_node_id AS entityId, market.marketplace,
      snapshot.source_type AS sourceType, snapshot.sync_run_id AS syncRunId
    FROM market_snapshots snapshot
    JOIN market_nodes market ON market.id = snapshot.market_node_id
    WHERE snapshot.id = ?
  ` : `
    SELECT snapshot.product_id AS entityId, product.marketplace,
      snapshot.source_type AS sourceType, snapshot.sync_run_id AS syncRunId
    FROM product_snapshots snapshot
    JOIN products product ON product.id = snapshot.product_id
    WHERE snapshot.id = ?
  `;
  const observation = database.prepare(observationQuery).get(recordId) as {
    entityId: string; marketplace: string; sourceType: string; syncRunId: string | null;
  } | undefined;
  if (!observation || observation.sourceType !== sourceType
    || observation.syncRunId !== syncRunId) return false;
  const direct = syncRunId ? database.prepare(`
    SELECT 1 FROM data_tasks task
    WHERE task.id = ? AND task.sync_run_id = task.id
      AND task.marketplace = ?
      AND task.source_id = 'source-sellersprite-mcp' AND task.status = 'success'
      AND task.failed = 0 AND task.success = task.total
      AND (task.task_type <> 'critical_sync' OR EXISTS (
        SELECT 1 FROM data_coverage_runs coverage
        WHERE coverage.id = task.id AND coverage.marketplace = task.marketplace
          AND coverage.run_type = 'critical_sync' AND coverage.is_complete = 1
      ))
    LIMIT 1
  `).get(syncRunId, observation.marketplace) : undefined;
  if (direct) return true;
  return Boolean(database.prepare(`
    SELECT 1
    FROM mcp_sync_observation_links link
    JOIN data_coverage_runs coverage ON coverage.id = link.sync_run_id
      AND coverage.run_type = 'critical_sync' AND coverage.is_complete = 1
    JOIN data_tasks task ON task.id = link.sync_run_id
      AND task.sync_run_id = link.sync_run_id AND task.task_type = 'critical_sync'
      AND task.source_id = 'source-sellersprite-mcp' AND task.status = 'success'
      AND task.marketplace = coverage.marketplace
      AND task.failed = 0 AND task.success = task.total
    WHERE link.snapshot_kind = ? AND link.snapshot_id = ?
      AND link.entity_id = ? AND coverage.marketplace = ?
    LIMIT 1
  `).get(kind, recordId, observation.entityId, observation.marketplace));
}
