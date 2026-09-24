import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database/database.js';
import { activeOwnedRoster, ownedRosterDigest } from '../services/owned-roster-declaration.js';

// Isolated test fixtures with SQL-created masters still need an import lineage for Go Live.
export function seedConfirmedOwnedRoster(database: AppDatabase, marketplace = 'US'): void {
  const roster = activeOwnedRoster(database, marketplace);
  if (roster.length === 0) return;
  const digest = ownedRosterDigest(roster);
  const taskId = randomUUID();
  const batchId = randomUUID();
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO data_tasks (
    id, name, source_id, task_type, target, source, marketplace, status,
    started_at, completed_at, total, success, failed, created_at
  ) VALUES (?, 'Synthetic roster confirmation', 'source-sellersprite-import',
    'file_import', 'test-master.csv', 'Test master', ?, 'success',
    ?, ?, ?, ?, 0, ?)`).run(taskId, marketplace, now, now, roster.length, roster.length, now);
  database.prepare(`INSERT INTO import_batches (
    id, filename, format, entity_type, row_count, success_count,
    failure_count, errors_json, task_id, imported_at
  ) VALUES (?, 'test-master.csv', 'csv', 'owned_product_master', ?, ?, 0, '[]', ?, ?)`)
    .run(batchId, roster.length, roster.length, taskId, now);
  database.prepare(`INSERT INTO owned_roster_declarations (
    marketplace, declared_count, declared_digest, expected_count, expected_digest,
    preview_digest, status, import_batch_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)
  ON CONFLICT(marketplace) DO UPDATE SET
    declared_count = excluded.declared_count, declared_digest = excluded.declared_digest,
    expected_count = excluded.expected_count, expected_digest = excluded.expected_digest,
    preview_digest = excluded.preview_digest, status = excluded.status,
    import_batch_id = excluded.import_batch_id, updated_at = excluded.updated_at`)
    .run(marketplace, roster.length, digest, roster.length, digest, digest, batchId, now, now);
}
