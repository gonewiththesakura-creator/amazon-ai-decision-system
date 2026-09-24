import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { WorkflowRepository } from './workflow-repository.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function fixture(): { db: AppDatabase; repository: WorkflowRepository; jobId: string; dataVersion: string } {
  const db = openDatabase(':memory:');
  database = db;
  const repository = new WorkflowRepository(db);
  const job = repository.createResearchJob({
    name: 'Trace selected metric', type: 'new_opportunity', createdBy: 'Evidence test',
  });
  repository.createDataTask(job, 'evidence_collection', 'market-us', 'Trace Evidence source');
  const insertTask = db.prepare(`
    INSERT INTO data_tasks (
      id, sync_run_id, name, source_id, task_type, target, source, status, marketplace,
      completed_at, created_at
    ) VALUES (?, ?, 'MCP observation', 'source-sellersprite-mcp', 'market_refresh', 'market-us',
      'SellerSprite MCP', 'success', 'US', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z')
  `);
  insertTask.run('mcp-run-a', 'mcp-run-a');
  insertTask.run('mcp-run-b', 'mcp-run-b');
  db.prepare(`
    INSERT INTO market_nodes (id, name, level, marketplace, status, source_type, created_at)
    VALUES ('market-us', 'Memory foam pillows', 1, 'US', 'active', 'mcp', '2026-09-19T00:00:00Z')
  `).run();
  db.prepare(`
    INSERT INTO products (
      id, asin, brand, title, image_url, marketplace, product_type, is_owned,
      market_node_id, source_type, created_at
    ) VALUES ('owned-sku', 'B0EVID001', 'Brand', 'Pillow', '', 'US', 'pillow',
      1, 'market-us', 'mcp', '2026-09-19T00:00:00Z')
  `).run();
  return { db, repository, jobId: job.id, dataVersion: job.dataVersion };
}

function evidence(dataVersion: string, sourceRecordId: string, sourceType: 'mcp' | 'import' | 'manual' = 'mcp') {
  return {
    claim: `Observed ${sourceRecordId}`,
    metricName: 'monthly_sales', metricValue: 120,
    source: sourceType === 'mcp' ? 'SellerSprite MCP' : 'Imported or reviewed source',
    sourceType, sourceRecordId,
    collectedAt: '2026-09-19T00:00:00Z', period: '30D', isEstimated: true,
    calculation: 'stored observation', confidence: 0.9, dataVersion,
  } as const;
}

describe('Evidence source-run lineage', () => {
  it('persists and reads the actual MCP run of a selected metric fact', () => {
    const { db, repository, jobId, dataVersion } = fixture();
    db.prepare(`
      INSERT INTO metric_facts (
        id, entity_type, entity_id, marketplace, metric_name, numeric_value,
        source, source_id, source_type, is_estimated, confidence, observation_date,
        collected_at, sync_run_id
      ) VALUES ('mcp-sales-fact', 'market', 'market-us', 'US', 'monthly_sales', 120,
        'SellerSprite MCP', 'sellersprite_mcp', 'mcp', 1, 0.9, '2026-09-18',
        '2026-09-19T00:00:00Z', 'mcp-run-a')
    `).run();

    const saved = repository.createEvidence(jobId, {
      ...evidence(dataVersion, 'mcp-sales-fact'), syncRunId: 'mcp-run-a',
    });

    expect(saved).toMatchObject({ sourceRecordId: 'mcp-sales-fact', syncRunId: 'mcp-run-a' });
    expect(repository.getEvidence(jobId)).toEqual([expect.objectContaining({
      id: saved.id, syncRunId: 'mcp-run-a',
    })]);
    expect(db.prepare('SELECT sync_run_id FROM evidence_records WHERE id = ?').get(saved.id))
      .toMatchObject({ sync_run_id: 'mcp-run-a' });
    expect(db.prepare(`SELECT sync_run_id FROM data_tasks WHERE research_job_id = ?`).get(jobId))
      .toMatchObject({ sync_run_id: 'mcp-run-a' });
  });

  it('binds one workflow to one MCP run, rejects runless or cross-run MCP, and leaves imports unlinked', () => {
    const { db, repository, jobId, dataVersion } = fixture();
    const insertMarket = db.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, monthly_sales, source, source_type, collected_at,
        period, is_estimated, confidence, observation_date, dedup_key, sync_run_id
      ) VALUES (?, 'market-us', '2026-09-18', 120, ?, ?, '2026-09-19T00:00:00Z',
        '30D', 1, 0.9, '2026-09-18', ?, ?)
    `);
    insertMarket.run('mcp-market-snapshot', 'SellerSprite MCP', 'mcp', 'mcp-market-key', 'mcp-run-a');
    insertMarket.run('legacy-mcp-snapshot', 'SellerSprite MCP', 'mcp', 'legacy-key', null);
    insertMarket.run('import-market-snapshot', 'SellerSprite Import', 'import', 'import-key', null);
    db.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, estimated_sales, source, source_type, collected_at,
        period, is_estimated, confidence, observation_date, dedup_key, sync_run_id
      ) VALUES ('mcp-product-snapshot', 'owned-sku', '2026-09-18', 120,
        'SellerSprite MCP', 'mcp', '2026-09-19T00:00:00Z', '30D', 1, 0.9,
        '2026-09-18', 'mcp-product-key', 'mcp-run-b')
    `).run();

    const market = repository.createEvidence(jobId, evidence(dataVersion, 'mcp-market-snapshot'));
    expect(() => repository.createEvidence(jobId, evidence(dataVersion, 'mcp-product-snapshot')))
      .toThrow(/同一.*运行|sync run/i);
    expect(() => repository.createEvidence(jobId, evidence(dataVersion, 'legacy-mcp-snapshot')))
      .toThrow(/同步运行|关联成功/);
    const imported = repository.createEvidence(jobId, evidence(dataVersion, 'import-market-snapshot', 'import'));

    expect([market.syncRunId, imported.syncRunId])
      .toEqual(['mcp-run-a', null]);
    expect(repository.getEvidence(jobId).map((item) => item.syncRunId))
      .toEqual(['mcp-run-a', null]);
    expect(db.prepare(`SELECT sync_run_id FROM data_tasks WHERE research_job_id = ?`).get(jobId))
      .toMatchObject({ sync_run_id: 'mcp-run-a' });
  });

  it('rejects a caller-supplied run that differs from the immutable source row, including idempotent writes', () => {
    const { db, repository, jobId, dataVersion } = fixture();
    db.prepare(`
      INSERT INTO metric_facts (
        id, entity_type, entity_id, marketplace, metric_name, numeric_value,
        source, source_id, source_type, is_estimated, confidence, observation_date,
        collected_at, sync_run_id
      ) VALUES ('mcp-sales-fact', 'market', 'market-us', 'US', 'monthly_sales', 120,
        'SellerSprite MCP', 'sellersprite_mcp', 'mcp', 1, 0.9, '2026-09-18',
        '2026-09-19T00:00:00Z', 'mcp-run-a')
    `).run();
    const correct = repository.createEvidence(jobId, evidence(dataVersion, 'mcp-sales-fact'));

    expect(() => repository.createEvidence(jobId, {
      ...evidence(dataVersion, 'mcp-sales-fact'), syncRunId: 'mcp-run-b',
    })).toThrow(/同步批次|sync run/i);
    expect(() => repository.createEvidence(jobId, {
      ...evidence(dataVersion, 'unknown-record', 'manual'), syncRunId: 'mcp-run-a',
    })).toThrow(/同步批次|sync run/i);
    expect(repository.getEvidence(jobId)).toHaveLength(1);
    expect(repository.getEvidence(jobId)[0].id).toBe(correct.id);
  });

  it('inherits a complete critical run that revalidated runless immutable sources', () => {
    const { db, repository, jobId, dataVersion } = fixture();
    const runId = '123e4567-e89b-42d3-a456-426614174009';
    db.prepare(`
      INSERT INTO data_tasks (
        id, sync_run_id, name, source_id, task_type, target, source, marketplace,
        status, total, success, failed, created_at
      ) VALUES (?, ?, 'Critical sync', 'source-sellersprite-mcp', 'critical_sync',
        'market-us', 'SellerSprite MCP', 'US', 'success', 2, 2, 0,
        '2026-09-20T00:00:00Z')
    `).run(runId, runId);
    db.prepare(`
      INSERT INTO data_coverage_runs (
        id, marketplace, run_type, coverage_json, is_complete, created_at
      ) VALUES (?, 'US', 'critical_sync', '{}', 1, '2026-09-20T00:00:00Z')
    `).run(runId);
    db.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, monthly_sales, source, source_type, collected_at,
        period, is_estimated, confidence, observation_date, dedup_key, sync_run_id
      ) VALUES ('runless-market', 'market-us', '2026-09-18', 120, 'SellerSprite MCP',
        'mcp', '2026-09-19T00:00:00Z', '30D', 1, 0.9, '2026-09-18',
        'runless-market-key', NULL)
    `).run();
    db.prepare(`
      INSERT INTO metric_facts (
        id, entity_type, entity_id, marketplace, metric_name, numeric_value,
        source, source_id, source_type, is_estimated, confidence, observation_date,
        collected_at, dedup_key, sync_run_id
      ) VALUES ('runless-fact', 'market', 'market-us', 'US', 'monthly_sales', 120,
        'SellerSprite MCP', 'source-sellersprite-mcp', 'mcp', 1, 0.9, '2026-09-18',
        '2026-09-19T00:00:00Z', 'runless-fact-key', NULL)
    `).run();
    const link = db.prepare(`
      INSERT INTO mcp_sync_observation_links (
        sync_run_id, snapshot_kind, snapshot_id, entity_id, disposition
      ) VALUES (?, ?, ?, 'market-us', 'reused')
    `);
    link.run(runId, 'market', 'runless-market');
    link.run(runId, 'fact', 'runless-fact');

    const market = repository.createEvidence(jobId, evidence(dataVersion, 'runless-market'));
    const fact = repository.createEvidence(jobId, {
      ...evidence(dataVersion, 'runless-fact'), claim: 'Observed revalidated fact',
    });

    expect([market.syncRunId, fact.syncRunId]).toEqual([runId, runId]);
  });

  it('rejects a reused link whose entity differs from the immutable MCP source', () => {
    const { db, repository, jobId, dataVersion } = fixture();
    const runId = '123e4567-e89b-42d3-a456-426614174012';
    db.prepare(`
      INSERT INTO data_tasks (
        id, sync_run_id, name, source_id, task_type, target, source, marketplace,
        status, total, success, failed, created_at
      ) VALUES (?, ?, 'Critical sync', 'source-sellersprite-mcp', 'critical_sync',
        'market-us', 'SellerSprite MCP', 'US', 'success', 1, 1, 0, '2026-09-20')
    `).run(runId, runId);
    db.prepare(`
      INSERT INTO data_coverage_runs (id, marketplace, run_type, coverage_json, is_complete, created_at)
      VALUES (?, 'US', 'critical_sync', '{}', 1, '2026-09-20')
    `).run(runId);
    db.prepare(`
      INSERT INTO metric_facts (
        id, entity_type, entity_id, marketplace, metric_name, numeric_value,
        source, source_id, source_type, is_estimated, confidence, observation_date,
        collected_at, dedup_key
      ) VALUES ('mislinked-fact', 'market', 'market-us', 'US', 'monthly_sales', 120,
        'SellerSprite MCP', 'source-sellersprite-mcp', 'mcp', 1, 0.9, '2026-09-18',
        '2026-09-19', 'mislinked-fact')
    `).run();
    db.prepare(`
      INSERT INTO mcp_sync_observation_links
        (sync_run_id, snapshot_kind, snapshot_id, entity_id, disposition)
      VALUES (?, 'fact', 'mislinked-fact', 'another-market', 'reused')
    `).run(runId);

    expect(() => repository.createEvidence(jobId, evidence(dataVersion, 'mislinked-fact')))
      .toThrow(/同步运行|关联成功/);
  });

  it('does not reuse legacy Evidence after its source is revalidated by a complete run', () => {
    const { db, repository, jobId, dataVersion } = fixture();
    const runId = '123e4567-e89b-42d3-a456-426614174010';
    db.prepare(`
      INSERT INTO data_tasks (
        id, sync_run_id, name, source_id, task_type, target, source, marketplace,
        status, total, success, failed, created_at
      ) VALUES (?, ?, 'Critical sync', 'source-sellersprite-mcp', 'critical_sync',
        'market-us', 'SellerSprite MCP', 'US', 'success', 2, 2, 0, '2026-09-20')
    `).run(runId, runId);
    db.prepare(`
      INSERT INTO data_coverage_runs (id, marketplace, run_type, coverage_json, is_complete, created_at)
      VALUES (?, 'US', 'critical_sync', '{}', 1, '2026-09-20')
    `).run(runId);
    db.prepare(`
      INSERT INTO metric_facts (
        id, entity_type, entity_id, marketplace, metric_name, numeric_value,
        source, source_id, source_type, is_estimated, confidence, observation_date,
        collected_at, dedup_key, sync_run_id
      ) VALUES ('legacy-revalidated-fact', 'market', 'market-us', 'US', 'monthly_sales', 120,
        'SellerSprite MCP', 'source-sellersprite-mcp', 'mcp', 1, 0.9, '2026-09-18',
        '2026-09-19', 'legacy-revalidated-fact', NULL)
    `).run();
    const input = evidence(dataVersion, 'legacy-revalidated-fact');
    db.prepare(`
      INSERT INTO evidence_records (
        id, research_job_id, claim, metric_name, metric_value_json, source, source_type,
        source_record_id, collected_at, period, is_estimated, calculation, confidence,
        data_version, created_at, sync_run_id
      ) VALUES ('legacy-evidence', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-09-19', NULL)
    `).run(
      jobId, input.claim, input.metricName, JSON.stringify(input.metricValue), input.source,
      input.sourceType, input.sourceRecordId, input.collectedAt, input.period,
      input.isEstimated ? 1 : 0, input.calculation, input.confidence, input.dataVersion,
    );
    db.prepare(`
      INSERT INTO mcp_sync_observation_links
        (sync_run_id, snapshot_kind, snapshot_id, entity_id, disposition)
      VALUES (?, 'fact', 'legacy-revalidated-fact', 'market-us', 'reused')
    `).run(runId);

    const saved = repository.createEvidence(jobId, input);

    expect(saved).toMatchObject({ syncRunId: runId });
    expect(saved.id).not.toBe('legacy-evidence');
    expect(repository.getEvidence(jobId)).toHaveLength(2);
  });
});
