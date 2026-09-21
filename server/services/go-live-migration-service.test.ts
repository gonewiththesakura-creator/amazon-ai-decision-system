import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { GoLiveMigrationService } from './go-live-migration-service.js';
import { seedDemoData } from '../database/demo-seed.js';
import { IntelligenceService } from './intelligence-service.js';
import { IntelligenceRepository } from '../repository/intelligence-repository.js';
import { addVerifiedMcpCoverage } from '../test-utils/verified-mcp-coverage.js';

let database: AppDatabase | undefined;
let temporaryDirectory: string | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

function insertObservationFixture(
  database: AppDatabase,
  marketSourceType: 'mock' | 'mcp' | 'amazon',
  productSourceType = marketSourceType,
  empty = false,
): void {
  const now = '2026-09-19T00:00:00.000Z';
  database.prepare(`
    INSERT INTO market_nodes (id, name, level, marketplace, status, source_type, created_at)
    VALUES ('market-us', 'US market', 1, 'US', 'active', ?, ?)
  `).run(marketSourceType, now);
  database.prepare(`
    INSERT INTO products (
      id, asin, sku, brand, title, image_url, marketplace, product_type, is_owned,
      market_node_id, source_type, created_at
    ) VALUES ('owned-product', 'B0LIVE0001', 'LIVE-1', 'Brand', 'Title', '', 'US', 'pillow',
      1, 'market-us', ?, ?)
  `).run(productSourceType, now);
  database.prepare(`
    INSERT INTO market_snapshots (
      id, market_node_id, date, product_count, seller_count, brand_count, monthly_sales,
      monthly_revenue, avg_price, median_price, avg_rating, median_reviews, source, source_type,
      collected_at, period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES ('market-observation', 'market-us', '2026-09-18', ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, '30D', 0, 0.9, '2026-09-18', 'market-observation-key')
  `).run(...(empty ? Array(9).fill(null) : [10, 8, 6, 100, 3000, 30, 29, 4.3, 50]),
    `${marketSourceType} fixture`, marketSourceType, now);
  database.prepare(`
    INSERT INTO product_snapshots (
      id, product_id, date, price, rating, review_count, bsr, estimated_sales,
      estimated_revenue, seller_count, source, source_type, collected_at, period,
      is_estimated, confidence, observation_date, dedup_key
    ) VALUES ('product-observation', 'owned-product', '2026-09-18', ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, '30D', 0, 0.9, '2026-09-18', 'product-observation-key')
  `).run(...(empty ? Array(7).fill(null) : [30, 4.4, 12, 100, 120, 3600, 1]),
    `${productSourceType} fixture`, productSourceType, now);
  if (marketSourceType === 'mock') {
    const register = database.prepare(`
      INSERT INTO demo_seed_records (seed_id, table_name, record_id, created_at)
      VALUES ('v2-demo-seed', ?, ?, ?)
    `);
    register.run('market_snapshots', 'market-observation', now);
    register.run('product_snapshots', 'product-observation', now);
  }
}

function addChildMarketCriticalFixture(db: AppDatabase): string {
  insertObservationFixture(db, 'mcp', 'mcp');
  db.prepare(`INSERT INTO market_nodes (
    id, name, parent_id, level, marketplace, category_id,
    sellersprite_confirmed_node_path, status, source_type, created_at
  ) VALUES ('child-market', 'Child market', 'market-us', 2, 'US',
    '1055398:1063252:999', '1055398:1063252:999', 'active', 'import', '2026-09-19')`).run();
  db.prepare(`UPDATE products SET market_node_id = 'child-market'
    WHERE id = 'owned-product'`).run();
  addVerifiedMcpCoverage(db, 'market-us', 'owned-product');
  return (db.prepare(`SELECT id FROM data_coverage_runs WHERE run_type = 'critical_sync'`)
    .get() as { id: string }).id;
}

describe('GoLiveMigrationService', () => {
  it('itemizes retained Demo rule and rejection history without exposing record payloads', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    const profile = database.prepare('SELECT id, version FROM rule_profiles LIMIT 1').get() as {
      id: string; version: number;
    };
    database.prepare(`
      INSERT INTO research_jobs (
        id, name, job_type, marketplace, status, entity_type, entity_id, rule_profile_id,
        rule_profile_version, rule_profile_snapshot_json, is_demo, created_by, data_version,
        prompt_version, created_at, updated_at
      ) VALUES ('demo-adjacent-history', 'Private job', 'adjacent_product', 'US',
        'waiting_approval', 'development_project', 'dev-lumbar', ?, ?, '{}', 1,
        'private-owner', 'demo-retain-v1', 'prompt-v1', '2026-09-19', '2026-09-19')
    `).run(profile.id, profile.version);
    const mixedEvidence = [
      { id: 'mock-fact', claim: 'private mock claim', metrics: [], provenance: [{
        source: 'Demo task input (DEMO)', sourceType: 'mock',
      }] },
      { id: 'demo-rule-score', claim: 'private metric claim', metrics: [], provenance: [{
        source: `${profile.id}@${profile.version}`, sourceType: 'manual',
      }] },
    ];
    database.prepare(`
      INSERT INTO ai_insights (
        id, entity_type, entity_id, insight_type, status, title, summary,
        evidence_json, confidence, model, data_version, input_hash, generated_at,
        research_job_id, evidence_ids_json
      ) VALUES ('demo-history-insight', 'research_job', 'demo-adjacent-history',
        'new_product_research', 'pending_approval', 'Private title', 'Private summary',
        ?, 0.8, 'rule-engine-v1', 'demo-retain-v1', 'history-input', '2026-09-19',
        'demo-adjacent-history', '["demo-rule-score"]')
    `).run(JSON.stringify(mixedEvidence));
    database.prepare(`
      INSERT INTO evidence_records (
        id, research_job_id, insight_id, claim, metric_name, metric_value_json,
        source, source_type, collected_at, period, calculation, confidence,
        data_version, created_at
      ) VALUES ('demo-rule-score', 'demo-adjacent-history', 'demo-history-insight',
        'private metric claim', 'opportunity_score', '71', ?, 'manual',
        '2026-09-19', 'research_run', '{"private":"calculation"}', 1,
        'demo-retain-v1', '2026-09-19')
    `).run(`${profile.id}@${profile.version}`);
    database.prepare(`
      INSERT INTO approvals (
        id, research_job_id, action, status, requested_by, requested_at
      ) VALUES ('demo-pending-approval', 'demo-adjacent-history', 'test', 'pending',
        'private-owner', '2026-09-19')
    `).run();
    database.prepare(`
      UPDATE opportunities SET status = 'rejected', updated_at = '2026-09-19'
      WHERE id = 'opp-school-kit'
    `).run();
    database.prepare(`
      DELETE FROM demo_seed_records WHERE seed_id = 'v2-demo-seed'
        AND table_name = 'opportunities' AND record_id = 'opp-school-kit'
    `).run();
    database.prepare(`
      INSERT INTO ai_insights (
        id, entity_type, entity_id, insight_type, status, title, summary,
        evidence_json, confidence, model, data_version, input_hash, generated_at
      ) VALUES ('demo-rejection-insight', 'opportunity', 'opp-school-kit',
        'opportunity_analysis', 'rejected', 'Private title', 'Private summary', ?,
        0.8, 'rule-engine-v1', 'demo-rejection-v1', 'rejection-input', '2026-09-19')
    `).run(JSON.stringify([{ id: 'rejection-evidence', claim: 'private rejection claim', metrics: [],
      provenance: [{ source: '演示数据 / Mock Adapter', sourceType: 'mock' }] }]));
    database.prepare(`
      INSERT INTO decisions (
        id, entity_type, entity_id, decision, reason, ai_insight_id,
        data_version, decided_by, decided_at
      ) VALUES ('demo-rejection-decision', 'opportunity', 'opp-school-kit', 'reject',
        'private rejection rationale', 'demo-rejection-insight', 'demo-rejection-v1',
        'private-owner', '2026-09-19')
    `).run();

    const service = new GoLiveMigrationService(database);
    const writesBefore = database.prepare('SELECT total_changes() AS count').get();
    const preview = service.preview();

    expect(preview.retainedDemoHistory).toEqual([
      expect.objectContaining({ kind: 'demo_rule_score_evidence', status: 'waiting_approval' }),
      expect.objectContaining({ kind: 'legacy_demo_rejection', status: 'rejected' }),
    ]);
    expect(preview.retainedDemoHistory.map((item) => item.ref)).toEqual([
      expect.stringMatching(/^demo-[0-9a-f]{12}$/), expect.stringMatching(/^demo-[0-9a-f]{12}$/),
    ]);
    expect(preview.blockers).toContain('unregistered Mock insights: 2');
    expect(database.prepare('SELECT total_changes() AS count').get()).toEqual(writesBefore);
    const exposed = JSON.stringify(preview);
    for (const sensitive of [
      'demo-rule-score', 'demo-rejection-decision', 'opp-school-kit', 'private metric claim',
      'private rejection rationale', 'private-owner', 'Private title', 'calculation', '71',
    ]) expect(exposed).not.toContain(sensitive);

    database.prepare(`UPDATE ai_insights SET evidence_json = ? WHERE id = 'demo-history-insight'`)
      .run(JSON.stringify([...mixedEvidence, {
        id: 'real-fact', claim: 'private real claim', metrics: [], provenance: [{
          source: 'SellerSprite Import', sourceType: 'import',
        }],
      }]));
    expect(service.preview().retainedDemoHistory.map((item) => item.kind))
      .toEqual(['legacy_demo_rejection']);
  });

  it('preserves Demo until the current market and a real owned ASIN have verified MCP coverage', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    const service = new GoLiveMigrationService(database);
    const before = service.verify().mockObservations;

    expect(service.verify()).toMatchObject({ readyForDemoCleanup: false });
    expect(() => service.clearDemoObservations()).toThrow(/真实.*MCP|MCP.*真实/);
    expect(service.verify().mockObservations).toBe(before);
    expect(database.prepare('SELECT COUNT(*) AS count FROM demo_seed_records').get())
      .not.toEqual({ count: 0 });
    addVerifiedMcpCoverage(database);
    expect(service.verify()).toMatchObject({ readyForDemoCleanup: true, hasMinimumRealCoverage: false });
    database.prepare(`UPDATE products SET source_type = 'mock' WHERE id = 'verified-owned'`).run();
    expect(service.verify()).toMatchObject({ readyForDemoCleanup: false });
    database.prepare(`UPDATE products SET source_type = 'import' WHERE id = 'verified-owned'`).run();
    database.prepare(`INSERT INTO market_nodes (
      id, name, level, marketplace, status, source_type, created_at
    ) VALUES ('unrelated-market', 'Unrelated market', 1, 'US', 'active', 'import', '2026-09-19')`).run();
    database.prepare(`UPDATE products SET market_node_id = 'unrelated-market' WHERE id = 'verified-owned'`).run();
    expect(service.verify()).toMatchObject({ readyForDemoCleanup: false });
    database.prepare(`UPDATE market_nodes SET source_type = 'import', status = 'active'
      WHERE id = 'mkt-cervical'`).run();
    database.prepare(`UPDATE products SET market_node_id = 'mkt-cervical' WHERE id = 'verified-owned'`).run();
    expect(service.verify()).toMatchObject({ readyForDemoCleanup: false });
    database.prepare(`UPDATE market_nodes SET sellersprite_confirmed_node_path = NULL
      WHERE id = 'mkt-memory-foam'`).run();
    expect(service.verify()).toMatchObject({ readyForDemoCleanup: false });
  });

  it('keeps cleanup ready but blocks Live below 90 days of valid primary-market history', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    database.prepare(`DELETE FROM market_snapshots
      WHERE source = 'Historical import fixture'`).run();
    const service = new GoLiveMigrationService(database);

    expect(service.verify()).toMatchObject({
      primaryMarketHistoryDays: 30,
      hasPrimaryMarketHistory90d: false,
      confirmedDirectCompetitors: 1,
      readyForDemoCleanup: true,
      hasMinimumRealCoverage: false,
    });
    expect(() => service.activateLiveMode()).toThrow(/真实数据覆盖/);
  });

  it('requires a reviewed candidate behind an active real direct relation only for Live', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    database.exec(`
      INSERT INTO products (
        id, asin, sku, brand, title, image_url, marketplace, product_type,
        is_owned, market_node_id, source_type, created_at, status
      ) VALUES ('manual-direct', 'B0MANUAL01', 'MANUAL-1', 'Brand', 'Manual direct', '',
        'US', 'competitor', 0, 'market-us', 'import', '2026-09-19', 'active');
      INSERT INTO competitor_relations (
        id, owned_product_id, competitor_product_id, relation_type,
        similarity_score, reason, ai_tags_json
      ) VALUES ('manual-direct-relation', 'owned-product', 'manual-direct', 'direct',
        90, 'Manually selected relation', '[]');
    `);
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product', undefined, {
      includeConfirmedDirectCompetitor: false,
    });
    const service = new GoLiveMigrationService(database);

    expect(service.verify()).toMatchObject({
      confirmedDirectCompetitors: 0,
      readyForDemoCleanup: true,
      hasMinimumRealCoverage: false,
    });

    database.prepare(`INSERT INTO competitor_candidates (
      id, marketplace, asin, source_product_id, source, source_type, payload_json,
      status, created_at, reviewed_at
    ) VALUES ('manual-direct-candidate', 'US', 'B0MANUAL01', 'owned-product',
      'SellerSprite MCP', 'mcp', '{}', 'confirmed', '2026-09-19', '2026-09-20')`).run();

    expect(service.verify()).toMatchObject({
      confirmedDirectCompetitors: 1,
      readyForDemoCleanup: true,
      hasMinimumRealCoverage: true,
    });
  });

  it('invalidates a complete run when an owned SKU market node is Mock, cross-site, or out of scope', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const service = new GoLiveMigrationService(database);
    expect(service.verify().sellerSpriteCriticalRunId).toEqual(expect.any(String));

    database.prepare(`UPDATE market_nodes SET source_type = 'mock' WHERE id = 'market-us'`).run();
    expect(service.verify().sellerSpriteCriticalRunId).toBeNull();
    database.prepare(`UPDATE market_nodes SET source_type = 'mcp' WHERE id = 'market-us'`).run();

    database.prepare(`INSERT INTO market_nodes (
      id, name, level, marketplace, status, source_type, created_at
    ) VALUES ('outside-us', 'Outside', 1, 'US', 'active', 'import', '2026-09-20')`).run();
    database.prepare(`UPDATE products SET market_node_id = 'outside-us' WHERE id = 'owned-product'`).run();
    expect(service.verify()).toMatchObject({ sellerSpriteCriticalRunId: null, readyForDemoCleanup: false });

    database.prepare(`INSERT INTO market_nodes (
      id, name, level, marketplace, status, source_type, created_at
    ) VALUES ('outside-uk', 'Outside UK', 1, 'UK', 'active', 'import', '2026-09-20')`).run();
    database.prepare(`UPDATE products SET market_node_id = 'outside-uk' WHERE id = 'owned-product'`).run();
    expect(service.verify()).toMatchObject({ sellerSpriteCriticalRunId: null, readyForDemoCleanup: false });
  });

  it('records both root and child market months for an owned SKU assigned to a child node', () => {
    database = openDatabase(':memory:');
    const runId = addChildMarketCriticalFixture(database);
    const run = database.prepare(`SELECT coverage_json AS coverageJson FROM data_coverage_runs
      WHERE id = ?`).get(runId) as { coverageJson: string };
    expect(JSON.parse(run.coverageJson)).toMatchObject({
      marketNodes: [
        { id: 'market-us', nodeIdPath: '1055398:1063252' },
        { id: 'child-market', nodeIdPath: '1055398:1063252:999' },
      ],
    });
    expect(database.prepare(`SELECT total, success FROM data_tasks WHERE id = ?`)
      .get(runId)).toEqual({ total: 3, success: 3 });
    expect(database.prepare(`SELECT market_node_id AS marketId, COUNT(*) AS count
      FROM market_snapshots WHERE sync_run_id = ? GROUP BY market_node_id ORDER BY market_node_id`)
      .all(runId)).toEqual([
      { marketId: 'child-market', count: 2 }, { marketId: 'market-us', count: 2 },
    ]);
    expect(database.prepare(`SELECT entity_id AS nodeIdPath, capability, COUNT(*) AS count
      FROM mcp_call_logs WHERE sync_run_id = ? AND entity_type = 'market'
      GROUP BY entity_id, capability ORDER BY entity_id, capability`).all(runId)).toEqual([
      { nodeIdPath: '1055398:1063252', capability: 'MARKET_STATISTICS', count: 2 },
      { nodeIdPath: '1055398:1063252', capability: 'PRODUCT_CONCENTRATION', count: 2 },
      { nodeIdPath: '1055398:1063252:999', capability: 'MARKET_STATISTICS', count: 2 },
      { nodeIdPath: '1055398:1063252:999', capability: 'PRODUCT_CONCENTRATION', count: 2 },
    ]);
  });

  it('accepts a complete root and child run after market analysis statuses are reconciled', () => {
    database = openDatabase(':memory:');
    const runId = addChildMarketCriticalFixture(database);
    database.prepare(`UPDATE market_nodes SET status = CASE id
      WHEN 'market-us' THEN '等待30D对照' ELSE '值得研究' END
      WHERE id IN ('market-us', 'child-market')`).run();

    expect(new GoLiveMigrationService(database).verify()).toMatchObject({
      sellerSpriteCriticalRunId: runId,
      verifiedEvidenceEntities: 2,
      requiredEvidenceEntities: 2,
      readyForDemoCleanup: true,
    });
  });

  it.each([
    ['baseline statistics call', (db: AppDatabase, runId: string) => db.prepare(`
      DELETE FROM mcp_call_logs WHERE sync_run_id = ? AND capability = 'MARKET_STATISTICS'
        AND entity_id = '1055398:1063252:999' AND observation_month = '202608'
    `).run(runId)],
    ['current concentration call', (db: AppDatabase, runId: string) => db.prepare(`
      DELETE FROM mcp_call_logs WHERE sync_run_id = ? AND capability = 'PRODUCT_CONCENTRATION'
        AND entity_id = '1055398:1063252:999' AND observation_month = '202609'
    `).run(runId)],
    ['baseline snapshot link', (db: AppDatabase, runId: string) => db.prepare(`
      DELETE FROM mcp_sync_observation_links WHERE sync_run_id = ? AND snapshot_kind = 'market'
        AND entity_id = 'child-market' AND snapshot_id IN (
          SELECT id FROM market_snapshots WHERE market_node_id = 'child-market'
            AND observation_date = '2026-08-31'
        )
    `).run(runId)],
    ['current fact link', (db: AppDatabase, runId: string) => db.prepare(`
      DELETE FROM mcp_sync_observation_links WHERE sync_run_id = ? AND snapshot_kind = 'fact'
        AND entity_id = 'child-market' AND snapshot_id IN (
          SELECT id FROM metric_facts WHERE entity_type = 'market'
            AND entity_id = 'child-market' AND observation_date = '2026-09-30'
        )
    `).run(runId)],
  ])('rejects a child market missing its %s', (_case, removeLineage) => {
    database = openDatabase(':memory:');
    const runId = addChildMarketCriticalFixture(database);
    const service = new GoLiveMigrationService(database);
    expect(service.verify().sellerSpriteCriticalRunId).toBe(runId);

    removeLineage(database, runId);

    expect(service.verify()).toMatchObject({
      sellerSpriteCriticalRunId: null,
      readyForDemoCleanup: false,
      hasMinimumRealCoverage: false,
    });
  });

  it.each([
    ['omits the child market', (db: AppDatabase, runId: string) => {
      const row = db.prepare(`SELECT coverage_json AS coverageJson FROM data_coverage_runs WHERE id = ?`)
        .get(runId) as { coverageJson: string };
      const coverage = JSON.parse(row.coverageJson) as Record<string, unknown>;
      coverage.marketNodes = [{ id: 'market-us', nodeIdPath: '1055398:1063252' }];
      db.prepare(`UPDATE data_coverage_runs SET coverage_json = ? WHERE id = ?`)
        .run(JSON.stringify(coverage), runId);
    }],
    ['changes the child node path', (db: AppDatabase, runId: string) => {
      const row = db.prepare(`SELECT coverage_json AS coverageJson FROM data_coverage_runs WHERE id = ?`)
        .get(runId) as { coverageJson: string };
      const coverage = JSON.parse(row.coverageJson) as { marketNodes: Array<Record<string, unknown>> };
      coverage.marketNodes[1]!.nodeIdPath = '1055398:1063252:777';
      db.prepare(`UPDATE data_coverage_runs SET coverage_json = ? WHERE id = ?`)
        .run(JSON.stringify(coverage), runId);
    }],
    ['uses the old root-only task total', (db: AppDatabase, runId: string) => {
      db.prepare(`UPDATE data_tasks SET total = 2, success = 2 WHERE id = ?`).run(runId);
    }],
  ])('rejects a child market run whose coverage %s', (_case, corruptCoverage) => {
    database = openDatabase(':memory:');
    const runId = addChildMarketCriticalFixture(database);
    const service = new GoLiveMigrationService(database);
    expect(service.verify().sellerSpriteCriticalRunId).toBe(runId);

    corruptCoverage(database, runId);

    expect(service.verify()).toMatchObject({
      sellerSpriteCriticalRunId: null,
      readyForDemoCleanup: false,
      hasMinimumRealCoverage: false,
    });
  });

  it('requires the latest SellerSprite capability catalog to be fresh', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const service = new GoLiveMigrationService(database);
    expect(service.verify()).toMatchObject({
      sellerSpriteCapabilitiesAvailable: true,
      readyForDemoCleanup: true,
    });

    database.prepare(`UPDATE provider_capability_snapshots
      SET collected_at = datetime('now', '-25 hours') WHERE provider_id = 'sellersprite'`).run();

    expect(service.verify()).toMatchObject({
      sellerSpriteCapabilitiesAvailable: false,
      readyForDemoCleanup: false,
      hasMinimumRealCoverage: false,
    });
  });

  it('requires tool discovery and its capability snapshot from the same critical run', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const service = new GoLiveMigrationService(database);
    expect(service.verify().sellerSpriteCriticalRunId).toEqual(expect.any(String));

    database.prepare(`UPDATE provider_capability_snapshots SET sync_run_id = NULL
      WHERE provider_id = 'sellersprite'`).run();
    expect(service.verify()).toMatchObject({
      sellerSpriteCriticalRunId: null,
      readyForDemoCleanup: false,
    });

    const run = database.prepare(`SELECT id FROM data_tasks WHERE task_type = 'critical_sync'
      ORDER BY created_at DESC LIMIT 1`).get() as { id: string };
    database.prepare(`UPDATE provider_capability_snapshots SET sync_run_id = ?
      WHERE provider_id = 'sellersprite'`).run(run.id);
    database.prepare(`DELETE FROM mcp_call_logs WHERE sync_run_id = ?
      AND capability = 'LIST_TOOLS'`).run(run.id);
    expect(service.verify()).toMatchObject({
      sellerSpriteCriticalRunId: null,
      readyForDemoCleanup: false,
    });
  });

  it('requires linked non-Demo workflow Evidence for the market and each owned SKU', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const service = new GoLiveMigrationService(database);
    expect(service.verify()).toMatchObject({
      readyForDemoCleanup: true,
      verifiedEvidenceEntities: 2,
      requiredEvidenceEntities: 2,
    });
    database.prepare(`UPDATE research_jobs SET entity_type = 'product'
      WHERE entity_type = 'owned_product'`).run();
    expect(service.verify()).toMatchObject({
      readyForDemoCleanup: true,
      verifiedEvidenceEntities: 2,
      requiredEvidenceEntities: 2,
    });

    const evidence = database.prepare(`
      SELECT evidence.id, evidence.source_record_id AS sourceRecordId,
        job.entity_type AS entityType
      FROM evidence_records evidence
      JOIN research_jobs job ON job.id = evidence.research_job_id
      WHERE evidence.sync_run_id IS NOT NULL
      ORDER BY job.entity_type
    `).all() as Array<{ id: string; sourceRecordId: string; entityType: string }>;
    const market = evidence.find((item) => item.entityType === 'market_node')!;
    const owned = evidence.find((item) => item.entityType === 'product')!;
    database.prepare(`DELETE FROM evidence_records WHERE id = ?`).run(market.id);
    expect(service.verify()).toMatchObject({
      sellerSpriteCriticalRunId: null,
      readyForDemoCleanup: false,
      verifiedEvidenceEntities: 1,
      requiredEvidenceEntities: 2,
    });

    database.prepare(`UPDATE evidence_records SET source_record_id = ? WHERE id = ?`)
      .run(market.sourceRecordId, owned.id);
    expect(service.verify()).toMatchObject({ sellerSpriteCriticalRunId: null, readyForDemoCleanup: false });
  });

  it('does not certify Demo or mismatched-run Evidence as current critical proof', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const service = new GoLiveMigrationService(database);
    expect(service.verify().readyForDemoCleanup).toBe(true);

    database.prepare(`UPDATE research_jobs SET is_demo = 1
      WHERE entity_type = 'owned_product'`).run();
    expect(service.verify().sellerSpriteCriticalRunId).toBeNull();
    database.prepare(`UPDATE research_jobs SET is_demo = 0
      WHERE entity_type = 'owned_product'`).run();
    database.prepare(`UPDATE evidence_records SET sync_run_id = NULL
      WHERE research_job_id IN (SELECT id FROM research_jobs WHERE entity_type = 'owned_product')`).run();
    expect(service.verify().sellerSpriteCriticalRunId).toBeNull();
  });

  it.each([
    ['runless', "sync_run_id = NULL"],
    ['wrong-run', "sync_run_id = '00000000-0000-4000-8000-000000000001'"],
    ['unfinished', "status = 'running', completed_at = NULL, success = 0"],
  ])('requires %s workflow DataTask completion lineage for every Evidence entity', (_case, update) => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const service = new GoLiveMigrationService(database);
    expect(service.verify().readyForDemoCleanup).toBe(true);

    const ownedJob = database.prepare(`
      SELECT id FROM research_jobs WHERE entity_type = 'owned_product' LIMIT 1
    `).get() as { id: string };
    database.exec(`UPDATE data_tasks SET ${update} WHERE research_job_id = '${ownedJob.id}'`);

    expect(service.verify()).toMatchObject({
      sellerSpriteCriticalRunId: null,
      verifiedEvidenceEntities: 1,
      requiredEvidenceEntities: 2,
      readyForDemoCleanup: false,
      hasMinimumRealCoverage: false,
    });
  });

  it('rejects an Insight that mixes MCP Evidence from another run into the candidate run', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const service = new GoLiveMigrationService(database);
    expect(service.verify()).toMatchObject({
      readyForDemoCleanup: true,
      verifiedEvidenceEntities: 2,
      requiredEvidenceEntities: 2,
    });
    const job = database.prepare(`
      SELECT job.id, job.data_version AS dataVersion, insight.id AS insightId,
        insight.evidence_ids_json AS evidenceIdsJson
      FROM research_jobs job
      JOIN ai_insights insight ON insight.research_job_id = job.id
      WHERE job.entity_id = 'owned-product' AND job.status = 'monitoring'
      LIMIT 1
    `).get() as { id: string; dataVersion: string; insightId: string; evidenceIdsJson: string };
    const otherRunId = '123e4567-e89b-42d3-a456-426614174099';
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO data_tasks (
      id, sync_run_id, name, source_id, task_type, target, source, marketplace,
      status, started_at, completed_at, total, success, failed, created_at
    ) VALUES (?, ?, 'Other complete critical run', 'source-sellersprite-mcp',
      'critical_sync', 'other-market', 'SellerSprite MCP', 'US', 'success',
      ?, ?, 1, 1, 0, ?)`)
      .run(otherRunId, otherRunId, now, now, now);
    database.prepare(`INSERT INTO data_coverage_runs (
      id, marketplace, run_type, coverage_json, is_complete, created_at
    ) VALUES (?, 'US', 'critical_sync', '{}', 1, ?)`)
      .run(otherRunId, now);
    database.prepare(`INSERT INTO product_snapshots (
      id, product_id, date, estimated_sales, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key, sync_run_id
    ) VALUES ('other-run-owned-snapshot', 'owned-product', '2026-08-31', 9,
      'SellerSprite MCP', 'mcp', ?, '1M', 1, 0.8, '2026-08-31',
      'other-run-owned-snapshot', ?)`)
      .run(now, otherRunId);
    database.prepare(`INSERT INTO mcp_sync_observation_links (
      sync_run_id, snapshot_kind, snapshot_id, entity_id, disposition
    ) VALUES (?, 'product', 'other-run-owned-snapshot', 'owned-product', 'inserted')`)
      .run(otherRunId);
    const crossRunEvidenceId = 'cross-run-owned-evidence';
    database.prepare(`INSERT INTO evidence_records (
      id, research_job_id, insight_id, claim, metric_name, metric_value_json,
      source, source_type, source_record_id, collected_at, period, is_estimated,
      calculation, confidence, data_version, created_at, sync_run_id
    ) VALUES (?, ?, ?, 'Cross-run measured observation', 'estimated_sales', '9',
      'SellerSprite MCP', 'mcp', 'other-run-owned-snapshot', ?, '1M', 1,
      'provider observation', 0.8, ?, ?, ?)`)
      .run(crossRunEvidenceId, job.id, job.insightId, now, job.dataVersion, now, otherRunId);
    const evidenceIds = JSON.parse(job.evidenceIdsJson) as string[];
    database.prepare(`UPDATE ai_insights SET evidence_ids_json = ? WHERE id = ?`)
      .run(JSON.stringify([...evidenceIds, crossRunEvidenceId]), job.insightId);

    expect(service.verify()).toMatchObject({
      sellerSpriteCriticalRunId: null,
      readyForDemoCleanup: false,
      verifiedEvidenceEntities: 1,
      requiredEvidenceEntities: 2,
    });
  });

  it('rejects Mock components in a non-Demo Insight but permits real manual components', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const service = new GoLiveMigrationService(database);
    const job = database.prepare(`
      SELECT job.id, job.data_version AS dataVersion, insight.id AS insightId,
        insight.evidence_ids_json AS evidenceIdsJson
      FROM research_jobs job
      JOIN ai_insights insight ON insight.research_job_id = job.id
      WHERE job.entity_id = 'owned-product' AND job.status = 'monitoring'
      LIMIT 1
    `).get() as { id: string; dataVersion: string; insightId: string; evidenceIdsJson: string };
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO evidence_records (
      id, research_job_id, insight_id, claim, metric_name, metric_value_json,
      source, source_type, collected_at, period, is_estimated,
      calculation, confidence, data_version, created_at
    ) VALUES ('mixed-mock-component', ?, ?, 'Mock component', 'current_price', '99',
      'Demo task input (DEMO)', 'mock', ?, 'point_in_time', 0,
      'fixture', 0.9, ?, ?)`)
      .run(job.id, job.insightId, now, job.dataVersion, now);
    database.prepare(`UPDATE ai_insights SET evidence_ids_json = ? WHERE id = ?`)
      .run(JSON.stringify([...JSON.parse(job.evidenceIdsJson) as string[], 'mixed-mock-component']),
        job.insightId);

    expect(service.verify()).toMatchObject({
      sellerSpriteCriticalRunId: null,
      readyForDemoCleanup: false,
      verifiedEvidenceEntities: 1,
      requiredEvidenceEntities: 2,
    });

    database.prepare(`UPDATE evidence_records SET source = 'Operator validation', source_type = 'manual'
      WHERE id = 'mixed-mock-component'`).run();
    expect(service.verify()).toMatchObject({
      readyForDemoCleanup: true,
      verifiedEvidenceEntities: 2,
      requiredEvidenceEntities: 2,
    });
  });

  it('rejects orphan Evidence from an unfinished or failed workflow', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const service = new GoLiveMigrationService(database);
    expect(service.verify().readyForDemoCleanup).toBe(true);

    database.prepare(`UPDATE research_jobs SET status = 'failed'
      WHERE entity_id = 'owned-product'`).run();
    expect(service.verify()).toMatchObject({
      sellerSpriteCriticalRunId: null,
      readyForDemoCleanup: false,
      verifiedEvidenceEntities: 1,
    });

    database.prepare(`UPDATE research_jobs SET status = 'monitoring'
      WHERE entity_id = 'owned-product'`).run();
    database.prepare(`DELETE FROM research_steps WHERE research_job_id = (
      SELECT id FROM research_jobs WHERE entity_id = 'owned-product' LIMIT 1
    ) AND step_type = 'report'`).run();
    expect(service.verify()).toMatchObject({
      sellerSpriteCriticalRunId: null,
      readyForDemoCleanup: false,
      verifiedEvidenceEntities: 1,
    });
  });

  it('rejects a complete current run whose candidate group is empty', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const service = new GoLiveMigrationService(database);
    expect(service.verify().readyForDemoCleanup).toBe(true);
    const run = database.prepare(`SELECT id, coverage_json AS coverageJson
      FROM data_coverage_runs WHERE run_type = 'critical_sync'`).get() as {
      id: string; coverageJson: string;
    };
    const coverage = JSON.parse(run.coverageJson) as Record<string, Record<string, unknown>>;
    const candidate = coverage.candidateDiscovery!;
    candidate.candidates = 0;
    candidate.covered = (candidate.covered as Array<Record<string, unknown>>)
      .map((item) => ({ ...item, candidates: 0 }));
    database.prepare(`DELETE FROM competitor_candidate_run_links WHERE sync_run_id = ?`).run(run.id);
    database.prepare(`DELETE FROM competitor_candidates WHERE sync_run_id = ?`).run(run.id);
    database.prepare(`UPDATE data_coverage_runs SET coverage_json = ? WHERE id = ?`)
      .run(JSON.stringify(coverage), run.id);

    expect(service.verify()).toMatchObject({
      sellerSpriteCriticalRunId: null,
      readyForDemoCleanup: false,
    });
  });

  it('does not splice independent successful calls and snapshots into Go Live proof', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const service = new GoLiveMigrationService(database);
    expect(service.verify().readyForDemoCleanup).toBe(true);

    database.prepare(`UPDATE mcp_call_logs SET sync_run_id = NULL
      WHERE provider_id = 'sellersprite'`).run();

    expect(service.verify()).toMatchObject({
      readyForDemoCleanup: false, hasMinimumRealCoverage: false,
      sellerSpriteCriticalRunId: null,
    });
    expect(() => service.activateLiveMode()).toThrow(/真实数据覆盖/);
  });

  it('does not splice a fact from another run into critical coverage', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const service = new GoLiveMigrationService(database);
    const run = database.prepare(`
      SELECT id FROM data_coverage_runs WHERE run_type = 'critical_sync' AND is_complete = 1
      ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string };
    const fact = database.prepare(`
      SELECT id FROM metric_facts WHERE sync_run_id = ? AND entity_type = 'product' LIMIT 1
    `).get(run.id) as { id: string };
    database.prepare(`UPDATE metric_facts SET sync_run_id = NULL WHERE id = ?`).run(fact.id);

    expect(service.verify()).toMatchObject({
      sellerSpriteCriticalRunId: null,
      readyForDemoCleanup: false,
      hasMinimumRealCoverage: false,
    });
  });

  it('requires the run, completed task, and call ledger to be within 24 hours', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const service = new GoLiveMigrationService(database);
    const run = database.prepare(`
      SELECT id FROM data_coverage_runs WHERE run_type = 'critical_sync' AND is_complete = 1
      ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string };
    expect(service.verify().sellerSpriteCriticalRunId).toBe(run.id);

    database.prepare(`
      UPDATE data_coverage_runs SET created_at = datetime('now', '-25 hours') WHERE id = ?
    `).run(run.id);

    expect(service.verify()).toMatchObject({
      sellerSpriteConnectionVerified: true,
      sellerSpriteCriticalRunId: null,
      readyForDemoCleanup: false,
      hasMinimumRealCoverage: false,
    });
    database.prepare(`
      UPDATE data_coverage_runs SET created_at = datetime('now') WHERE id = ?
    `).run(run.id);
    database.prepare(`
      UPDATE data_tasks SET completed_at = datetime('now', '-25 hours') WHERE id = ?
    `).run(run.id);

    expect(service.verify()).toMatchObject({
      sellerSpriteConnectionVerified: true,
      sellerSpriteCriticalRunId: null,
      readyForDemoCleanup: false,
      hasMinimumRealCoverage: false,
    });
    database.prepare(`
      UPDATE data_tasks SET completed_at = datetime('now') WHERE id = ?
    `).run(run.id);
    expect(service.verify().sellerSpriteCriticalRunId).toBe(run.id);
    database.prepare(`
      UPDATE mcp_call_logs SET started_at = datetime('now', '-25 hours')
      WHERE sync_run_id = ? AND capability = 'ASIN_SALES_TREND'
    `).run(run.id);
    expect(service.verify()).toMatchObject({
      sellerSpriteConnectionVerified: true,
      sellerSpriteCriticalRunId: null,
      readyForDemoCleanup: false,
      hasMinimumRealCoverage: false,
    });
    database.prepare(`
      UPDATE mcp_call_logs SET started_at = datetime('now'), completed_at = datetime('now', '-25 hours')
      WHERE sync_run_id = ? AND capability = 'ASIN_SALES_TREND'
    `).run(run.id);
    expect(service.verify().sellerSpriteCriticalRunId).toBeNull();
  });

  it('accepts historical monthly observations revalidated by a recent uncached critical run', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product', '2026-09-18T00:00:00.000Z');
    const service = new GoLiveMigrationService(database);
    const run = database.prepare(`
      SELECT id FROM data_coverage_runs WHERE run_type = 'critical_sync' AND is_complete = 1
      ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string };
    expect(service.verify().sellerSpriteCriticalRunId).toBe(run.id);

    expect(service.verify()).toMatchObject({
      realOwnedProductSnapshots: 1,
      sellerSpriteCriticalRunId: run.id,
      readyForDemoCleanup: true,
      hasMinimumRealCoverage: true,
    });
    expect(database.prepare(`SELECT collected_at FROM product_snapshots
      WHERE sync_run_id = ?`).get(run.id)).toEqual({ collected_at: '2026-09-18T00:00:00.000Z' });
  });

  it('does not certify cached calls as a fresh critical acquisition', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const service = new GoLiveMigrationService(database);
    const run = database.prepare(`
      SELECT id FROM data_coverage_runs WHERE run_type = 'critical_sync' AND is_complete = 1
      ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string };
    expect(service.verify().sellerSpriteCriticalRunId).toBe(run.id);

    database.prepare(`
      INSERT INTO mcp_call_logs (
        id, provider_id, capability, request_hash, status, cache_hit,
        entity_type, entity_id, result_count, started_at, sync_run_id
      ) VALUES ('cached-associated-call', 'sellersprite', 'MARKET_RESEARCH',
        'cached-associated-call', 'success', 1, 'market', '1055398:1063252', 1, ?, ?)
    `).run(new Date().toISOString(), run.id);

    expect(service.verify()).toMatchObject({
      sellerSpriteCriticalRunId: null,
      readyForDemoCleanup: false,
      hasMinimumRealCoverage: false,
    });
  });

  it('requires both secondary coverage summaries to match completed child tasks', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const service = new GoLiveMigrationService(database);
    const run = database.prepare(`
      SELECT id, coverage_json AS coverageJson FROM data_coverage_runs
      WHERE run_type = 'critical_sync' AND is_complete = 1
      ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string; coverageJson: string };
    const coverage = JSON.parse(run.coverageJson) as Record<string, unknown>;
    expect(service.verify().sellerSpriteCriticalRunId).toBe(run.id);

    delete coverage.candidateDiscovery;
    database.prepare(`UPDATE data_coverage_runs SET coverage_json = ? WHERE id = ?`)
      .run(JSON.stringify(coverage), run.id);
    expect(service.verify().sellerSpriteCriticalRunId).toBeNull();

    const child = database.prepare(`
      SELECT id, status, total, success, failed FROM data_tasks
      WHERE sync_run_id = ? AND task_type = 'competitor_discovery'
    `).get(run.id) as { id: string; status: string; total: number; success: number; failed: number };
    coverage.candidateDiscovery = {
      taskId: child.id,
      status: child.status,
      total: child.total + 1,
      success: child.success + 1,
      failed: child.failed,
    };
    database.prepare(`UPDATE data_coverage_runs SET coverage_json = ? WHERE id = ?`)
      .run(JSON.stringify(coverage), run.id);
    expect(service.verify().sellerSpriteCriticalRunId).toBeNull();
  });

  it('allows partial direct-competitor coverage but rejects a fully failed current roster', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    database.exec(`
      INSERT INTO products (
        id, asin, sku, brand, title, image_url, marketplace, product_type,
        is_owned, market_node_id, source_type, created_at
      ) VALUES
        ('direct-one', 'B0DIRECT01', 'DIRECT-1', 'Brand', 'Direct one', '',
          'US', 'pillow', 0, 'market-us', 'import', '2026-09-19'),
        ('direct-two', 'B0DIRECT02', 'DIRECT-2', 'Brand', 'Direct two', '',
          'US', 'pillow', 0, 'market-us', 'import', '2026-09-19');
      INSERT INTO competitor_relations (
        id, owned_product_id, competitor_product_id, relation_type,
        similarity_score, reason, ai_tags_json
      ) VALUES
        ('direct-relation-one', 'owned-product', 'direct-one', 'direct', 90, 'confirmed', '[]'),
        ('direct-relation-two', 'owned-product', 'direct-two', 'direct', 85, 'confirmed', '[]');
    `);
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product', undefined, {
      includeConfirmedDirectCompetitor: false,
    });
    const service = new GoLiveMigrationService(database);
    const run = database.prepare(`
      SELECT id, coverage_json AS coverageJson FROM data_coverage_runs
      WHERE run_type = 'critical_sync' AND is_complete = 1
      ORDER BY created_at DESC LIMIT 1
    `).get() as { id: string; coverageJson: string };
    const coverage = JSON.parse(run.coverageJson) as Record<string, Record<string, unknown>>;
    const taskId = coverage.secondaryCompetitors!.taskId as string;
    database.prepare(`
      UPDATE data_tasks SET status = 'partial', total = 2, success = 1, failed = 1
      WHERE id = ? AND sync_run_id = ?
    `).run(taskId, run.id);
    coverage.secondaryCompetitors = {
      taskId, status: 'partial', total: 2, success: 1, failed: 1,
      roster: [
        { id: 'direct-one', asin: 'B0DIRECT01' },
        { id: 'direct-two', asin: 'B0DIRECT02' },
      ],
      covered: [{ id: 'direct-one', asin: 'B0DIRECT01', snapshots: 1 }],
      failures: [{ id: 'direct-two', asin: 'B0DIRECT02', status: 'failed' }],
    };
    database.prepare(`UPDATE data_coverage_runs SET coverage_json = ? WHERE id = ?`)
      .run(JSON.stringify(coverage), run.id);
    expect(service.verify()).toMatchObject({
      sellerSpriteCriticalRunId: run.id,
      readyForDemoCleanup: true,
    });

    database.prepare(`
      UPDATE data_tasks SET status = 'failed', total = 2, success = 0, failed = 2
      WHERE id = ? AND sync_run_id = ?
    `).run(taskId, run.id);
    coverage.secondaryCompetitors = {
      taskId, status: 'failed', total: 2, success: 0, failed: 2,
      roster: [
        { id: 'direct-one', asin: 'B0DIRECT01' },
        { id: 'direct-two', asin: 'B0DIRECT02' },
      ],
    };
    database.prepare(`UPDATE data_coverage_runs SET coverage_json = ? WHERE id = ?`)
      .run(JSON.stringify(coverage), run.id);

    expect(service.verify()).toMatchObject({
      sellerSpriteCriticalRunId: null,
      readyForDemoCleanup: false,
      hasMinimumRealCoverage: false,
    });
  });

  it('rejects an old run after the direct competitor roster changes', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const service = new GoLiveMigrationService(database);
    expect(service.verify().readyForDemoCleanup).toBe(true);

    database.exec(`
      INSERT INTO products (
        id, asin, sku, brand, title, image_url, marketplace, product_type,
        is_owned, market_node_id, source_type, created_at
      ) VALUES (
        'new-direct', 'B0DIRECT01', 'DIRECT-1', 'Brand', 'New direct competitor', '',
        'US', 'pillow', 0, 'market-us', 'import', '2026-09-19'
      );
      INSERT INTO competitor_relations (
        id, owned_product_id, competitor_product_id, relation_type,
        similarity_score, reason, ai_tags_json
      ) VALUES (
        'new-direct-relation', 'owned-product', 'new-direct', 'direct', 90,
        'confirmed after sync', '[]'
      );
    `);

    expect(service.verify()).toMatchObject({
      sellerSpriteCriticalRunId: null,
      readyForDemoCleanup: false,
      hasMinimumRealCoverage: false,
    });
  });

  it('requires concentration and every current real owned ASIN in the same complete run', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const service = new GoLiveMigrationService(database);
    expect(service.verify().readyForDemoCleanup).toBe(true);

    database.prepare(`UPDATE mcp_call_logs SET status = 'failed'
      WHERE capability = 'PRODUCT_CONCENTRATION'`).run();
    expect(service.verify().readyForDemoCleanup).toBe(false);
    database.prepare(`UPDATE mcp_call_logs SET status = 'success'
      WHERE capability = 'PRODUCT_CONCENTRATION'`).run();
    database.prepare(`
      INSERT INTO products (id, asin, sku, brand, title, image_url, marketplace,
        product_type, is_owned, market_node_id, source_type, created_at)
      VALUES ('added-owned', 'B0LIVE0002', 'LIVE-2', 'Brand', 'New title', '', 'US',
        'pillow', 1, 'market-us', 'import', '2026-09-19')
    `).run();
    expect(service.verify().readyForDemoCleanup).toBe(false);
  });

  it('requires per-month market call lineage for the critical run', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const service = new GoLiveMigrationService(database);
    expect(service.verify().readyForDemoCleanup).toBe(true);

    database.prepare(`DELETE FROM mcp_call_logs
      WHERE capability = 'MARKET_STATISTICS' AND observation_month = '202608'`).run();

    expect(service.verify()).toMatchObject({
      sellerSpriteCriticalRunId: null,
      readyForDemoCleanup: false,
      hasMinimumRealCoverage: false,
    });
  });

  it.each(['market', 'fact'] as const)(
    'requires the previous month %s observation link in the same run', (kind) => {
      database = openDatabase(':memory:');
      insertObservationFixture(database, 'mcp', 'mcp');
      addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
      const service = new GoLiveMigrationService(database);
      expect(service.verify().readyForDemoCleanup).toBe(true);

      const table = kind === 'market' ? 'market_snapshots' : 'metric_facts';
      database.prepare(`
        DELETE FROM mcp_sync_observation_links
        WHERE snapshot_kind = ? AND snapshot_id IN (
          SELECT id FROM ${table} WHERE observation_date = '2026-08-31'
        )
      `).run(kind);

      expect(service.verify()).toMatchObject({
        sellerSpriteCriticalRunId: null,
        readyForDemoCleanup: false,
        hasMinimumRealCoverage: false,
      });
    },
  );

  it('accepts one complete roster across multiple nodes inside the main-market tree', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    database.exec(`
      INSERT INTO market_nodes (
        id, name, parent_id, level, marketplace, category_id,
        sellersprite_confirmed_node_path, status, source_type, created_at
      ) VALUES ('secondary-node', 'Secondary owned category', 'market-us', 2, 'US',
        '1055398:1063252:888', '1055398:1063252:888', 'active', 'import',
        '2026-09-19T00:00:00.000Z');
      INSERT INTO products (
        id, asin, sku, brand, title, image_url, marketplace, product_type, is_owned,
        market_node_id, source_type, created_at
      ) VALUES ('second-owned', 'B0LIVE0002', 'LIVE-2', 'Brand', 'Second owned', '',
        'US', 'pillow', 1, 'secondary-node', 'import', '2026-09-19T00:00:00.000Z');
    `);

    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');

    expect(new GoLiveMigrationService(database).verify()).toMatchObject({
      readyForDemoCleanup: true,
      sellerSpriteCriticalRunId: expect.any(String),
    });
  });

  it('requires verified coverage before clearing observations and rejects Live with active mock masters', async () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mock');
    const service = new GoLiveMigrationService(database);

    expect(service.preview().delete).toMatchObject({ marketSnapshots: 1, productSnapshots: 1 });
    expect(() => service.activateLiveMode()).toThrow(/真实数据覆盖|Mock/);
    expect(() => service.clearDemoObservations()).toThrow(/真实.*MCP/);
    addVerifiedMcpCoverage(database, 'market-us');
    service.clearDemoObservations();
    expect(database.prepare('SELECT COUNT(*) AS count FROM products').get()).toMatchObject({ count: 3 });
    expect(service.verify()).toMatchObject({ mockObservations: 0, hasMinimumRealCoverage: false });
    expect(() => service.activateLiveMode()).toThrow(/真实数据覆盖/);
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'go-live-backup-'));
    const backupPath = join(temporaryDirectory, 'backup.db');
    await service.backup(backupPath);
    expect(existsSync(backupPath)).toBe(true);
  });

  it('blocks Live and Demo cleanup when Mock metric facts remain without deleting them', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    database.prepare(`
      INSERT INTO metric_facts (
        id, entity_type, entity_id, marketplace, metric_name, numeric_value,
        source, source_id, source_type, is_estimated, confidence, observation_date,
        collected_at, dedup_key
      ) VALUES ('mock-fact', 'product', 'owned-product', 'US', 'estimated_sales', 99,
        'Mock Adapter', 'source-mock', 'mock', 1, 0.5, '2026-09-19', ?, 'mock-fact')
    `).run(new Date().toISOString());
    const service = new GoLiveMigrationService(database);

    expect(service.verify()).toMatchObject({ mockObservations: 1, hasMinimumRealCoverage: false });
    expect(service.preview().blockers).toContain('unregistered Mock metric facts: 1');
    expect(() => service.activateLiveMode()).toThrow(/Mock/);
    expect(() => service.clearDemoObservations()).toThrow(/禁止清理/);
    expect(database.prepare(`SELECT id FROM metric_facts WHERE id = 'mock-fact'`).get())
      .toEqual({ id: 'mock-fact' });
  });

  it('activates only when market and active owned-product coverage are real', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    database.prepare(`UPDATE app_settings SET marketplace = 'US', default_market_id = 'market-us' WHERE id = 1`).run();
    database.prepare(`UPDATE market_nodes SET category_id = '1055398:1063252' WHERE id = 'market-us'`).run();
    const service = new GoLiveMigrationService(database);

    expect(service.verify()).toMatchObject({ hasMinimumRealCoverage: false });
    database.prepare(`
      INSERT INTO provider_capability_snapshots (id, provider_id, capabilities_json, collected_at)
      VALUES ('capabilities', 'sellersprite', ?, ?)
    `).run(JSON.stringify({ capabilities: {
      MARKET_RESEARCH: 'market_research',
      MARKET_STATISTICS: 'market_research_statistics',
      PRODUCT_CONCENTRATION: 'market_product_concentration',
      ASIN_SALES_TREND: 'asin_sales_trend',
      ASIN_COMPETITOR_DISCOVERY: 'asin_competitor',
    } }), '2026-09-19T00:00:00.000Z');
    const addCall = (id: string, capability: string, entityType: string, entityId: string) => {
      database!.prepare(`
        INSERT INTO mcp_call_logs (id, provider_id, capability, request_hash, status,
          entity_type, entity_id, result_count, started_at)
        VALUES (?, 'sellersprite', ?, ?, 'success', ?, ?, 1, ?)
      `).run(id, capability, id, entityType, entityId, '2026-09-19T00:00:00.000Z');
    };
    addCall('other-market-call', 'MARKET_STATISTICS', 'market', 'other-node');
    addCall('other-asin-call', 'ASIN_SALES_TREND', 'product', 'B0OTHER001');
    expect(service.verify()).toMatchObject({ hasMinimumRealCoverage: false });
    addCall('market-call', 'MARKET_STATISTICS', 'market', '1055398:1063252');
    database.prepare(`
      INSERT INTO products (id, asin, sku, brand, title, image_url, marketplace,
        product_type, is_owned, market_node_id, source_type, created_at)
      VALUES ('import-owned', 'B0LIVE0002', 'LIVE-2', 'Brand', 'Import product', '',
        'US', 'pillow', 1, 'market-us', 'import', '2026-09-19')
    `).run();
    database.prepare(`
      INSERT INTO product_snapshots (id, product_id, date, price, source, source_type,
        collected_at, period, is_estimated, confidence, observation_date, dedup_key)
      VALUES ('import-observation', 'import-owned', '2026-09-19', 42, 'import', 'import',
        '2026-09-19', '30D', 0, 1, '2026-09-19', 'import-observation')
    `).run();
    addCall('import-asin-call', 'ASIN_SALES_TREND', 'product', 'B0LIVE0002');
    expect(service.verify()).toMatchObject({
      sellerSpriteAsinCalls: 0, hasMinimumRealCoverage: false,
    });
    addCall('asin-call', 'ASIN_SALES_TREND', 'product', 'B0LIVE0001');
    expect(service.verify()).toMatchObject({
      sellerSpriteConnectionVerified: false, hasMinimumRealCoverage: false,
    });
    database.prepare(`
      UPDATE data_sources SET status = 'connected', last_sync_at = ?
      WHERE id = 'source-sellersprite-mcp'
    `).run(new Date().toISOString());
    expect(service.verify()).toMatchObject({
      sellerSpriteConnectionVerified: true, hasMinimumRealCoverage: false,
    });
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    expect(service.verify()).toMatchObject({
      sellerSpriteConnectionVerified: true, hasMinimumRealCoverage: true,
      sellerSpriteCriticalRunId: expect.any(String),
    });
    database.prepare(`
      INSERT INTO products (
        id, asin, sku, brand, title, image_url, marketplace, product_type, is_owned,
        market_node_id, source_type, created_at, status, parent_asin, is_parent
      ) VALUES (
        'mock-parent', 'B0MOCKPAR1', 'MOCK-PARENT', 'Mock', 'Mock parent', '', 'US',
        'pillow', 1, 'market-us', 'mock', '2026-09-21', 'active', 'B0MOCKPAR1', 1
      )
    `).run();
    expect(service.verify()).toMatchObject({ hasMinimumRealCoverage: false });
    database.prepare(`DELETE FROM products WHERE id = 'mock-parent'`).run();
    expect(service.verify()).toMatchObject({ hasMinimumRealCoverage: true });
    database.prepare(`UPDATE data_sources SET status = 'disconnected'
      WHERE id = 'source-sellersprite-mcp'`).run();
    expect(service.verify()).toMatchObject({
      sellerSpriteConnectionVerified: false, hasMinimumRealCoverage: false,
    });
    database.prepare(`
      UPDATE data_sources SET status = 'connected', last_sync_at = ?
      WHERE id = 'source-sellersprite-mcp'
    `).run(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
    expect(service.verify()).toMatchObject({
      sellerSpriteConnectionVerified: false, hasMinimumRealCoverage: false,
    });
    database.prepare(`
      UPDATE data_sources SET last_sync_at = ? WHERE id = 'source-sellersprite-mcp'
    `).run(new Date().toISOString());
    expect(service.verify()).toMatchObject({ hasMinimumRealCoverage: true });
    service.activateLiveMode();
    expect(database.prepare('SELECT mode FROM app_settings WHERE id = 1').get()).toEqual({ mode: 'live' });
  });

  it('holds the write lock from verification through Live activation', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'go-live-atomic-'));
    const databasePath = join(temporaryDirectory, 'atomic.db');
    database = openDatabase(databasePath);
    insertObservationFixture(database, 'mcp', 'mcp');
    addVerifiedMcpCoverage(database, 'market-us', 'owned-product');
    const competingDatabase = openDatabase(databasePath);
    competingDatabase.exec('PRAGMA busy_timeout = 0');
    let competingWriteBlocked = false;
    const guardedDatabase = new Proxy(database, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (/UPDATE app_settings SET mode = 'live'/u.test(sql)) {
              try {
                competingDatabase.prepare(`
                  UPDATE data_sources SET status = 'disconnected'
                  WHERE id = 'source-sellersprite-mcp'
                `).run();
              } catch (error) {
                competingWriteBlocked = error instanceof Error && /locked|busy/u.test(error.message);
              }
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as AppDatabase;

    try {
      new GoLiveMigrationService(guardedDatabase).activateLiveMode();
    } finally {
      competingDatabase.close();
    }

    expect(competingWriteBlocked).toBe(true);
    expect(database.prepare(`SELECT status FROM data_sources
      WHERE id = 'source-sellersprite-mcp'`).get()).toEqual({ status: 'connected' });
    expect(database.prepare('SELECT mode FROM app_settings WHERE id = 1').get()).toEqual({ mode: 'live' });
  });

  it('blocks Demo cleanup when real Evidence or research jobs reference seeded records', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    const profile = database.prepare(`SELECT id, version FROM rule_profiles LIMIT 1`).get() as { id: string; version: number };
    database.prepare(`
      INSERT INTO research_jobs (
        id, name, job_type, marketplace, status, entity_type, entity_id, rule_profile_id,
        rule_profile_version, rule_profile_snapshot_json, is_demo, created_by, data_version,
        prompt_version, created_at, updated_at
      ) VALUES ('real-job', 'Real review', 'existing_market', 'US', 'draft',
        'development_project', 'dev-lumbar', ?, ?, '{}', 0, 'admin', 'real-v1',
        'prompt-v1', '2026-09-19', '2026-09-19')
    `).run(profile.id, profile.version);
    database.prepare(`
      INSERT INTO evidence_records (
        id, research_job_id, insight_id, claim, metric_name, metric_value_json,
        source, collected_at, calculation, confidence, created_at
      ) VALUES ('real-evidence', 'real-job', 'insight-market-memory', 'Real claim',
        'sales', '100', 'amazon', '2026-09-19', 'reported', 1, '2026-09-19')
    `).run();
    const service = new GoLiveMigrationService(database);
    expect(service.preview().blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/Evidence/), expect.stringMatching(/research/i),
    ]));
    expect(() => service.clearDemoObservations()).toThrow(/引用/);
    expect(database.prepare(`SELECT insight_id FROM evidence_records WHERE id = 'real-evidence'`).get())
      .toEqual({ insight_id: 'insight-market-memory' });
    expect(database.prepare(`SELECT id FROM development_projects WHERE id = 'dev-lumbar'`).get())
      .toEqual({ id: 'dev-lumbar' });
  });

  it('does not count empty observations or imports alone as live SellerSprite coverage', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp', true);
    database.prepare(`UPDATE app_settings SET default_market_id = 'market-us' WHERE id = 1`).run();
    expect(new GoLiveMigrationService(database).verify()).toMatchObject({
      realMarketSnapshots: 0, realOwnedProductSnapshots: 0, hasMinimumRealCoverage: false,
    });
  });

  it('archives mock-only seeded owned and competitor masters while retaining real-linked products', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    database.prepare(`
      INSERT INTO products (
        id, asin, sku, brand, title, image_url, marketplace, product_type, is_owned,
        market_node_id, source_type, created_at
      ) VALUES ('real-owned', 'B0LIVE0001', 'REAL-1', 'Brand', 'Real product', '', 'US', 'pillow',
        1, 'mkt-memory-foam', 'import', '2026-09-19')
    `).run();
    database.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, price, source, source_type, collected_at, period,
        is_estimated, confidence, observation_date, dedup_key
      ) VALUES ('real-on-seed', 'owned-sku-01', '2026-09-19', 39, 'amazon', 'amazon',
        '2026-09-19', '30D', 0, 1, '2026-09-19', 'real-on-seed')
    `).run();
    database.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, price, source, source_type, collected_at, period,
        is_estimated, confidence, observation_date, dedup_key
      ) VALUES ('real-on-competitor', 'competitor-01', '2026-09-19', 42, 'sellersprite', 'mcp',
        '2026-09-19', '30D', 1, 0.8, '2026-09-19', 'real-on-competitor')
    `).run();

    const service = new GoLiveMigrationService(database);
    expect(service.preview().archive).toMatchObject({ products: 10 });
    addVerifiedMcpCoverage(database, 'mkt-memory-foam', 'real-owned');
    expect(service.verify().readyForDemoCleanup).toBe(true);
    service.clearDemoObservations();
    expect(database.prepare(`
      SELECT id, status FROM products WHERE is_owned = 1 ORDER BY id
    `).all()).toEqual([
      { id: 'owned-sku-01', status: 'active' },
      { id: 'owned-sku-02', status: 'inactive' },
      { id: 'owned-sku-03', status: 'inactive' },
      { id: 'owned-sku-04', status: 'inactive' },
      { id: 'real-owned', status: 'active' },
    ]);
    expect(database.prepare(`SELECT id FROM product_snapshots WHERE id = 'real-on-seed'`).get())
      .toEqual({ id: 'real-on-seed' });
    expect(database.prepare(`SELECT id FROM product_snapshots WHERE id = 'real-on-competitor'`).get())
      .toEqual({ id: 'real-on-competitor' });
    expect(database.prepare(`SELECT id, status FROM products WHERE id LIKE 'competitor-%' ORDER BY id`).all())
      .toEqual(Array.from({ length: 8 }, (_, index) => ({
        id: `competitor-0${index + 1}`, status: index === 0 ? 'active' : 'inactive',
      })));
    expect(new IntelligenceRepository(database).getMarketProducts('mkt-memory-foam')
      .filter((product) => product.id.startsWith('competitor-')).map((product) => product.id))
      .toEqual(['competitor-01']);
    expect(service.verify().activeOwnedProducts).toBe(2);
  });

  it('cleans identifiable Demo refresh snapshots and blocks unrelated Mock observations atomically', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    const addMockMarket = database.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, source, source_type, collected_at, period,
        is_estimated, confidence, observation_date, dedup_key
      ) VALUES (?, 'mkt-memory-foam', '2026-09-19', ?, 'mock',
        '2026-09-19', '30D', 1, 0.8, '2026-09-19', ?)
    `);
    addMockMarket.run('demo-refresh', '演示数据 / Mock Adapter', 'demo-refresh');
    database.prepare(`
      INSERT INTO ai_insights (
        id, entity_type, entity_id, insight_type, status, title, summary,
        facts_json, opportunities_json, risks_json, recommendations_json, evidence_json,
        confidence, model, data_version, input_hash, generated_at
      ) VALUES ('demo-refresh-insight', 'owned_product', 'owned-sku-02', 'sku_diagnosis',
        'demo', 'Demo finding', 'Mock only', '[]', '[]', '[]', '[]', ?,
        0.8, 'rule-engine-v1', 'demo-refresh', 'demo-refresh', '2026-09-19')
    `).run(JSON.stringify([{ id: 'mock-evidence', claim: 'Mock claim', metrics: [], provenance: [{
      source: '演示数据 / Mock Adapter', sourceType: 'mock', collectedAt: '2026-09-19',
      period: '30D', isEstimated: true, confidence: 0.8,
    }] }]));
    const service = new GoLiveMigrationService(database);
    expect(service.preview().delete.marketSnapshots).toBe(29);
    expect(service.preview().delete.aiInsights).toBe(9);
    expect(service.preview().archive.products).toBe(12);
    expect(service.preview().blockers).toEqual([]);

    addMockMarket.run('unrelated-mock', 'User fixture', 'unrelated-mock');
    expect(service.preview().blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/unregistered Mock/i),
    ]));
    expect(() => service.clearDemoObservations()).toThrow(/禁止清理/);
    expect(database.prepare(`SELECT id FROM market_snapshots WHERE id = 'demo-refresh'`).get())
      .toEqual({ id: 'demo-refresh' });
    database.prepare(`DELETE FROM market_snapshots WHERE id = 'unrelated-mock'`).run();

    addVerifiedMcpCoverage(database);
    service.clearDemoObservations();
    expect(database.prepare(`SELECT id FROM market_snapshots WHERE id = 'demo-refresh'`).get())
      .toBeUndefined();
    expect(database.prepare(`SELECT id FROM ai_insights WHERE id = 'demo-refresh-insight'`).get())
      .toBeUndefined();
    expect(service.verify().mockObservations).toBe(0);
  });

  it('does not delete a Demo refresh snapshot cited as real Evidence', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    database.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, source, source_type, collected_at, period,
        is_estimated, confidence, observation_date, dedup_key
      ) VALUES ('demo-refresh', 'owned-sku-02', '2026-09-19', '演示数据 / Mock Adapter',
        'mock', '2026-09-19', '30D', 1, 0.8, '2026-09-19', 'demo-refresh')
    `).run();
    const profile = database.prepare(`SELECT id, version FROM rule_profiles LIMIT 1`).get() as { id: string; version: number };
    database.prepare(`
      INSERT INTO research_jobs (
        id, name, job_type, marketplace, status, entity_type, entity_id, rule_profile_id,
        rule_profile_version, rule_profile_snapshot_json, is_demo, created_by, data_version,
        prompt_version, created_at, updated_at
      ) VALUES ('real-job', 'Real review', 'existing_market', 'US', 'draft',
        'owned_product', 'owned-sku-02', ?, ?, '{}', 0, 'admin', 'real-v1',
        'prompt-v1', '2026-09-19', '2026-09-19')
    `).run(profile.id, profile.version);
    database.prepare(`
      INSERT INTO evidence_records (
        id, research_job_id, source_record_id, claim, metric_name, metric_value_json,
        source, collected_at, calculation, confidence, created_at
      ) VALUES ('real-evidence', 'real-job', 'demo-refresh', 'Claim', 'sales', '100',
        'amazon', '2026-09-19', 'reported', 1, '2026-09-19')
    `).run();
    const service = new GoLiveMigrationService(database);
    expect(service.preview().blockers).toEqual(expect.arrayContaining([expect.stringMatching(/Evidence/)]));
    expect(() => service.clearDemoObservations()).toThrow(/禁止清理/);
    expect(database.prepare(`SELECT id FROM product_snapshots WHERE id = 'demo-refresh'`).get())
      .toEqual({ id: 'demo-refresh' });
  });

  it('cleans snapshots and findings generated by an actual Demo adapter refresh', async () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    const task = await new IntelligenceService(database).runDataTask({
      taskType: 'owned_sku_refresh', target: 'owned-sku-02', sourcePreference: 'Mock Adapter',
    });
    expect(task.status).toBe('success');
    const dynamicSnapshots = database.prepare(`
      SELECT id FROM product_snapshots WHERE product_id = 'owned-sku-02'
        AND id NOT LIKE 'ps-owned-sku-02-%'
    `).all();
    expect(dynamicSnapshots).toHaveLength(1);

    const service = new GoLiveMigrationService(database);
    expect(service.preview().delete.productSnapshots).toBe(33);
    expect(service.preview().archive.products).toBe(12);
    expect(service.preview().blockers).toEqual([]);
    addVerifiedMcpCoverage(database);
    service.clearDemoObservations();
    expect(database.prepare(`SELECT id FROM product_snapshots WHERE source_type = 'mock'`).all()).toEqual([]);
    expect(database.prepare(`SELECT status FROM products WHERE id = 'owned-sku-02'`).get())
      .toEqual({ status: 'inactive' });
    expect(service.verify().mockObservations).toBe(0);
  });

  it('preserves and blocks a mixed-provenance insight rather than classifying it as Demo-only', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    database.prepare(`
      INSERT INTO ai_insights (
        id, entity_type, entity_id, insight_type, status, title, summary,
        facts_json, opportunities_json, risks_json, recommendations_json, evidence_json,
        confidence, model, data_version, input_hash, generated_at
      ) VALUES ('mixed-insight', 'owned_product', 'owned-sku-02', 'sku_diagnosis',
        'review', 'Mixed finding', 'Needs review', '[]', '[]', '[]', '[]', ?,
        0.8, 'rule-engine-v1', 'mixed', 'mixed', '2026-09-19')
    `).run(JSON.stringify([
      { id: 'demo-evidence', claim: 'Demo', metrics: [], provenance: [{ sourceType: 'mock' }] },
      { id: 'unknown-evidence', claim: 'Unknown', metrics: [], provenance: [] },
    ]));
    const service = new GoLiveMigrationService(database);
    expect(service.preview().blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/unregistered Mock insights/i),
    ]));
    expect(() => service.clearDemoObservations()).toThrow(/禁止清理/);
    expect(database.prepare(`SELECT id FROM ai_insights WHERE id = 'mixed-insight'`).get())
      .toEqual({ id: 'mixed-insight' });
  });

  it('keeps a seeded SKU active when a real research job still targets it', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    const profile = database.prepare(`SELECT id, version FROM rule_profiles LIMIT 1`).get() as { id: string; version: number };
    database.prepare(`
      INSERT INTO research_jobs (
        id, name, job_type, marketplace, status, entity_type, entity_id, rule_profile_id,
        rule_profile_version, rule_profile_snapshot_json, is_demo, created_by, data_version,
        prompt_version, created_at, updated_at
      ) VALUES ('real-sku-job', 'Real review', 'owned_product', 'US', 'draft',
        'owned_product', 'owned-sku-04', ?, ?, '{}', 0, 'admin', 'real-v1',
        'prompt-v1', '2026-09-19', '2026-09-19')
    `).run(profile.id, profile.version);
    const service = new GoLiveMigrationService(database);
    expect(service.preview().archive.products).toBe(11);
    addVerifiedMcpCoverage(database);
    service.clearDemoObservations();
    expect(database.prepare(`SELECT status FROM products WHERE id = 'owned-sku-04'`).get())
      .toEqual({ status: 'active' });
    expect(database.prepare(`SELECT entity_id FROM research_jobs WHERE id = 'real-sku-job'`).get())
      .toEqual({ entity_id: 'owned-sku-04' });
    expect(service.verify()).toMatchObject({ activeOwnedProducts: 2, hasMinimumRealCoverage: false });
  });
});
