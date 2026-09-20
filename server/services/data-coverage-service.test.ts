import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { DataCoverageService } from './data-coverage-service.js';
import { DashboardFreshnessService } from './dashboard-freshness-service.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function insertProduct(id: string, owned: boolean): void {
  database!.prepare(`
    INSERT INTO products (
      id, asin, sku, brand, title, image_url, marketplace, product_type, is_owned,
      market_node_id, keywords_json, monitoring_enabled, source_type, created_at, status
    ) VALUES (?, ?, ?, 'Coverage Brand', ?, '', 'US', 'memory_foam_pillow', ?,
      'coverage-market', '[]', 1, 'import', '2026-09-19T00:00:00.000Z', 'active')
  `).run(id, `ASIN-${id}`, `SKU-${id}`, id, owned ? 1 : 0);
}

function insertProductSnapshot(
  productId: string,
  date: string,
  sourceType: 'mcp' | 'import' | 'amazon' | 'mock' = 'mcp',
  isEstimated = true,
): void {
  database!.prepare(`
    INSERT INTO product_snapshots (
      id, product_id, date, price, rating, review_count, bsr, estimated_sales,
      estimated_revenue, seller_count, source, source_type, collected_at, period,
      is_estimated, confidence, observation_date, dedup_key
    ) VALUES (?, ?, ?, 39, 4.3, 100, 50, 1000, 39000, 1, ?, ?, ?, '30D', ?, 0.9, ?, ?)
  `).run(
    `${productId}-${date}-${sourceType}`, productId, date, `${sourceType} fixture`, sourceType,
    `${date}T08:00:00.000Z`, isEstimated ? 1 : 0, date,
    `${productId}|${date}|${sourceType}|${isEstimated ? 'estimated' : 'actual'}`,
  );
}

function insertNullOnlyProductSnapshot(
  productId: string,
  date: string,
  sourceType: 'mcp' | 'amazon' = 'mcp',
  isEstimated = true,
): void {
  database!.prepare(`
    INSERT INTO product_snapshots (
      id, product_id, date, source, source_type, collected_at, period,
      is_estimated, confidence, observation_date, dedup_key
    ) VALUES (?, ?, ?, 'Null-only fixture', ?, ?, '30D', ?, 0.9, ?, ?)
  `).run(
    `${productId}-${date}-${sourceType}-null`, productId, date, sourceType,
    `${date}T08:00:00.000Z`, isEstimated ? 1 : 0, date,
    `${productId}|${date}|${sourceType}|null`,
  );
}

function insertLiveCoverageFixture(): void {
  database!.prepare(`
    INSERT INTO market_nodes (
      id, name, parent_id, level, marketplace, keywords_json, status, source_type, created_at
    ) VALUES ('coverage-market', 'Coverage Market', NULL, 1, 'US', '[]', 'active', 'import',
      '2026-09-19T00:00:00.000Z')
  `).run();
  database!.prepare(`UPDATE app_settings SET mode = 'live', marketplace = 'US',
    default_market_id = 'coverage-market' WHERE id = 1`).run();
  insertProduct('owned-live', true);
  insertProduct('competitor-live', false);
  database!.prepare(`INSERT INTO competitor_relations (
    id, owned_product_id, competitor_product_id, relation_type, similarity_score,
    reason, ai_tags_json, created_at, last_verified_at
  ) VALUES ('live-relation', 'owned-live', 'competitor-live', 'direct', 90,
    'fixture', '[]', '2026-09-19T00:00:00.000Z', '2026-09-19T00:00:00.000Z')`).run();
}

function insertCriticalRun(id: string, status: 'success' | 'failed' | 'running'): void {
  database!.prepare(`INSERT INTO data_tasks (
    id, sync_run_id, name, source_id, task_type, target, source, marketplace,
    status, started_at, completed_at, total, success, failed, created_at
  ) VALUES (?, ?, 'Coverage critical run', 'source-sellersprite-mcp', 'critical_sync',
    'coverage-market', 'SellerSprite MCP', 'US', ?, '2026-09-19T08:00:00.000Z',
    ?, 2, ?, ?, '2026-09-19T08:00:00.000Z')`).run(
    id, id, status, status === 'running' ? null : '2026-09-19T08:01:00.000Z',
    status === 'success' ? 2 : 0, status === 'failed' ? 2 : 0,
  );
  database!.prepare(`INSERT INTO data_coverage_runs (
    id, marketplace, run_type, coverage_json, is_complete, created_at
  ) VALUES (?, 'US', 'critical_sync', '{}', ?, '2026-09-19T08:00:00.000Z')`)
    .run(id, status === 'success' ? 1 : 0);
}

function insertRunMarketSnapshot(id: string, runId: string, collectedAt: string): void {
  database!.prepare(`INSERT INTO market_snapshots (
    id, market_node_id, date, monthly_sales, source, source_type, collected_at,
    period, is_estimated, confidence, observation_date, dedup_key, sync_run_id
  ) VALUES (?, 'coverage-market', '2026-09-19', 10000, 'SellerSprite MCP', 'mcp',
    ?, '30D', 1, 0.9, '2026-09-19', ?, ?)`)
    .run(id, collectedAt, id, runId);
}

function insertRunProductSnapshot(
  id: string, productId: string, date: string, runId: string, collectedAt: string,
): void {
  database!.prepare(`INSERT INTO product_snapshots (
    id, product_id, date, estimated_sales, source, source_type, collected_at,
    period, is_estimated, confidence, observation_date, dedup_key, sync_run_id
  ) VALUES (?, ?, ?, 1000, 'SellerSprite MCP', 'mcp', ?, '30D', 1, 0.9, ?, ?, ?)`)
    .run(id, productId, date, collectedAt, date, id, runId);
}

describe('DataCoverageService', () => {
  it('excludes failed and running critical MCP observations from every Live coverage counter', () => {
    database = openDatabase(':memory:');
    insertLiveCoverageFixture();
    insertCriticalRun('run-failed', 'failed');
    insertCriticalRun('run-running', 'running');
    insertRunMarketSnapshot('failed-market', 'run-failed', '2026-09-19T08:05:00.000Z');
    insertRunProductSnapshot('failed-owned', 'owned-live', '2026-06-19',
      'run-failed', '2026-09-19T08:05:00.000Z');
    insertRunProductSnapshot('running-owned', 'owned-live', '2026-09-19',
      'run-running', '2026-09-19T08:06:00.000Z');
    database.prepare(`INSERT INTO metric_facts (
      id, entity_type, entity_id, marketplace, metric_name, numeric_value,
      source, source_id, source_type, is_estimated, confidence, observation_date,
      collected_at, dedup_key, sync_run_id
    ) VALUES ('failed-competitor-fact', 'product', 'competitor-live', 'US',
      'estimated_sales', 1000, 'SellerSprite MCP', 'source-sellersprite-mcp',
      'mcp', 1, 0.9, '2026-09-19', '2026-09-19T08:05:00.000Z',
      'failed-competitor-fact', 'run-failed')`).run();

    const coverage = new DataCoverageService(database).getCoverage('US');

    expect(coverage.primaryMarket).toMatchObject({ covered: 0, status: 'missing' });
    expect(coverage.activeOwnedProducts).toMatchObject({ covered: 0, total: 1, status: 'missing' });
    expect(coverage.coreCompetitors).toMatchObject({ covered: 0, total: 1, status: 'missing' });
    expect(coverage.history90d).toMatchObject({ covered: 0, total: 1, status: 'missing' });
  });

  it('retains old completed critical observations after a newer failed run and reports partial update', () => {
    database = openDatabase(':memory:');
    insertLiveCoverageFixture();
    insertCriticalRun('run-complete', 'success');
    insertRunMarketSnapshot('old-market', 'run-complete', '2026-09-19T08:00:00.000Z');
    insertRunProductSnapshot('old-owned', 'owned-live', '2026-09-19',
      'run-complete', '2026-09-19T08:00:00.000Z');
    insertRunProductSnapshot('old-competitor', 'competitor-live', '2026-09-19',
      'run-complete', '2026-09-19T08:00:00.000Z');
    insertCriticalRun('run-failed', 'failed');
    insertRunMarketSnapshot('failed-market', 'run-failed', '2026-09-19T09:00:00.000Z');
    insertRunProductSnapshot('failed-owned', 'owned-live', '2026-06-19',
      'run-failed', '2026-09-19T09:00:00.000Z');

    const coverage = new DataCoverageService(database).getCoverage('US');
    const freshness = new DashboardFreshnessService(database).getStatus({
      marketplace: 'US', mode: 'live', marketId: 'coverage-market',
      ownedProductIds: ['owned-live'], competitorProductIds: ['competitor-live'],
    });

    expect(coverage.primaryMarket).toMatchObject({ covered: 1, status: 'complete' });
    expect(coverage.activeOwnedProducts).toMatchObject({ covered: 1, status: 'complete' });
    expect(coverage.coreCompetitors).toMatchObject({ covered: 1, status: 'complete' });
    expect(coverage.history90d).toMatchObject({ covered: 0, status: 'missing' });
    expect(freshness.coreBusinessFreshness).toMatchObject({ status: 'partial', label: '部分未更新' });
  });

  it('counts active real owned products outside the primary market tree as missing Live coverage', () => {
    database = openDatabase(':memory:');
    insertLiveCoverageFixture();
    insertProductSnapshot('owned-live', '2026-09-19', 'import');
    insertProductSnapshot('competitor-live', '2026-09-19', 'import');
    database.prepare(`INSERT INTO market_nodes (
      id, name, parent_id, level, marketplace, keywords_json, status, source_type, created_at
    ) VALUES ('outside-market', 'Outside', NULL, 1, 'US', '[]', 'active', 'import',
      '2026-09-19T00:00:00.000Z')`).run();
    for (const [id, ownerId, sourceType, status, marketNodeId] of [
      ['mock-competitor', 'owned-live', 'mock', 'active', 'coverage-market'],
      ['inactive-competitor', 'owned-live', 'import', 'inactive', 'coverage-market'],
      ['outside-owned', null, 'import', 'active', 'outside-market'],
      ['outside-competitor', 'outside-owned', 'import', 'active', 'outside-market'],
      ['mock-owned', null, 'mock', 'active', 'coverage-market'],
      ['mock-owned-competitor', 'mock-owned', 'import', 'active', 'coverage-market'],
    ] as const) {
      insertProduct(id, ownerId === null);
      database.prepare(`UPDATE products SET source_type = ?, status = ?, market_node_id = ? WHERE id = ?`)
        .run(sourceType, status, marketNodeId, id);
      insertProductSnapshot(id, '2026-09-19', 'import');
      if (ownerId) {
        database.prepare(`INSERT INTO competitor_relations (
          id, owned_product_id, competitor_product_id, relation_type, similarity_score,
          reason, ai_tags_json, created_at, last_verified_at
        ) VALUES (?, ?, ?, 'direct', 90, 'fixture', '[]',
          '2026-09-19T00:00:00.000Z', '2026-09-19T00:00:00.000Z')`)
          .run(`relation-${id}`, ownerId, id);
      }
    }

    const coverage = new DataCoverageService(database).getCoverage('US');

    expect(coverage.activeOwnedProducts).toMatchObject({ covered: 1, total: 2, status: 'partial' });
    expect(coverage.coreCompetitors).toMatchObject({ covered: 1, total: 1, status: 'complete' });
  });
  it('reports missing and not-applicable states without manufacturing zero coverage', () => {
    database = openDatabase(':memory:');

    const coverage = new DataCoverageService(database).getCoverage('US');

    expect(coverage.primaryMarket).toMatchObject({ covered: 0, total: 1, status: 'missing' });
    expect(coverage.activeOwnedProducts).toMatchObject({ covered: 0, total: 0, status: 'not_applicable' });
    expect(coverage.coreCompetitors).toMatchObject({ covered: 0, total: 0, status: 'not_applicable' });
    expect(coverage.history90d).toMatchObject({ covered: 0, total: 0, status: 'not_applicable' });
    expect(coverage.amazonActual).toMatchObject({ covered: 0, total: 0, status: 'not_applicable' });
  });

  it('derives partial counters only from persisted real facts', () => {
    database = openDatabase(':memory:');
    database.prepare(`
      INSERT INTO market_nodes (
        id, name, parent_id, level, marketplace, keywords_json, status, source_type, created_at
      ) VALUES ('coverage-market', 'Coverage Market', NULL, 1, 'US', '[]', 'active', 'mcp', '2026-09-19T00:00:00.000Z')
    `).run();
    database.prepare(`UPDATE app_settings SET marketplace = 'US', default_market_id = 'coverage-market' WHERE id = 1`).run();
    database.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, monthly_sales, source, source_type, collected_at,
        period, is_estimated, confidence, observation_date, dedup_key
      ) VALUES ('market-real', 'coverage-market', '2026-09-19', 10000, 'SellerSprite MCP', 'mcp',
        '2026-09-19T08:00:00.000Z', '30D', 1, 0.9, '2026-09-19', 'market-real')
    `).run();

    for (let index = 1; index <= 10; index += 1) {
      const ownedId = `owned-${index}`;
      const competitorId = `competitor-${index}`;
      insertProduct(ownedId, true);
      insertProduct(competitorId, false);
      database.prepare(`
        INSERT INTO competitor_relations (
          id, owned_product_id, competitor_product_id, relation_type, similarity_score,
          reason, ai_tags_json, created_at, last_verified_at
        ) VALUES (?, ?, ?, 'direct', 90, 'fixture', '[]', '2026-09-19T00:00:00.000Z', '2026-09-19T00:00:00.000Z')
      `).run(`relation-${index}`, ownedId, competitorId);
      if (index <= 9) insertProductSnapshot(ownedId, '2026-09-19');
      if (index <= 6) insertProductSnapshot(ownedId, '2026-06-19');
      if (index <= 4) insertProductSnapshot(ownedId, '2026-09-19', 'amazon', false);
      if (index <= 8) insertProductSnapshot(competitorId, '2026-09-19');
    }
    insertProductSnapshot('owned-10', '2026-09-19', 'mock');
    insertProductSnapshot('competitor-9', '2026-09-19', 'mock');

    const coverage = new DataCoverageService(database).getCoverage('US');

    expect(coverage.primaryMarket).toMatchObject({ covered: 1, total: 1, status: 'complete' });
    expect(coverage.activeOwnedProducts).toMatchObject({ covered: 9, total: 10, status: 'partial' });
    expect(coverage.coreCompetitors).toMatchObject({ covered: 8, total: 10, status: 'partial' });
    expect(coverage.history90d).toMatchObject({ covered: 6, total: 10, status: 'partial' });
    expect(coverage.amazonActual).toMatchObject({ covered: 4, total: 10, status: 'partial' });
  });

  it('ignores inactive owned products while retaining their persisted observations', () => {
    database = openDatabase(':memory:');
    database.prepare(`
      INSERT INTO market_nodes (
        id, name, parent_id, level, marketplace, keywords_json, status, source_type, created_at
      ) VALUES ('coverage-market', 'Coverage Market', NULL, 1, 'US', '[]', 'active', 'mcp', '2026-09-19T00:00:00.000Z')
    `).run();
    insertProduct('inactive-owned', true);
    insertProductSnapshot('inactive-owned', '2026-09-19', 'amazon', false);
    database.prepare(`UPDATE products SET status = 'inactive' WHERE id = 'inactive-owned'`).run();

    const coverage = new DataCoverageService(database).getCoverage('US');
    const historyCount = Number((database.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE product_id = 'inactive-owned'
    `).get() as { count: number }).count);

    expect(coverage.activeOwnedProducts.total).toBe(0);
    expect(coverage.amazonActual.total).toBe(0);
    expect(historyCount).toBe(1);
  });

  it('does not treat null-only snapshot rows as product, history, Amazon, competitor, or market coverage', () => {
    database = openDatabase(':memory:');
    database.prepare(`
      INSERT INTO market_nodes (
        id, name, parent_id, level, marketplace, keywords_json, status, source_type, created_at
      ) VALUES ('coverage-market', 'Coverage Market', NULL, 1, 'US', '[]', 'active', 'mcp', '2026-09-19T00:00:00.000Z')
    `).run();
    database.prepare(`UPDATE app_settings SET marketplace = 'US', default_market_id = 'coverage-market' WHERE id = 1`).run();
    database.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, source, source_type, collected_at, period,
        is_estimated, confidence, observation_date, dedup_key
      ) VALUES ('market-null', 'coverage-market', '2026-09-19', 'Null-only fixture', 'mcp',
        '2026-09-19T08:00:00.000Z', '30D', 1, 0.9, '2026-09-19', 'market-null')
    `).run();
    insertProduct('owned-null', true);
    insertProduct('competitor-null', false);
    database.prepare(`
      INSERT INTO competitor_relations (
        id, owned_product_id, competitor_product_id, relation_type, similarity_score,
        reason, ai_tags_json, created_at, last_verified_at
      ) VALUES ('relation-null', 'owned-null', 'competitor-null', 'direct', 90,
        'fixture', '[]', '2026-09-19T00:00:00.000Z', '2026-09-19T00:00:00.000Z')
    `).run();
    insertNullOnlyProductSnapshot('owned-null', '2026-06-19');
    insertNullOnlyProductSnapshot('owned-null', '2026-09-19', 'amazon', false);
    insertNullOnlyProductSnapshot('competitor-null', '2026-09-19');

    const coverage = new DataCoverageService(database).getCoverage('US');

    expect(coverage.primaryMarket.covered).toBe(0);
    expect(coverage.activeOwnedProducts.covered).toBe(0);
    expect(coverage.coreCompetitors.covered).toBe(0);
    expect(coverage.history90d.covered).toBe(0);
    expect(coverage.amazonActual.covered).toBe(0);
  });

  it('accepts non-null persisted metric facts when a legacy snapshot is absent', () => {
    database = openDatabase(':memory:');
    database.prepare(`
      INSERT INTO market_nodes (
        id, name, parent_id, level, marketplace, keywords_json, status, source_type, created_at
      ) VALUES ('coverage-market', 'Coverage Market', NULL, 1, 'US', '[]', 'active', 'mcp', '2026-09-19T00:00:00.000Z')
    `).run();
    database.prepare(`UPDATE app_settings SET marketplace = 'US', default_market_id = 'coverage-market' WHERE id = 1`).run();
    insertProduct('owned-fact', true);
    const insertFact = database.prepare(`
      INSERT INTO metric_facts (
        id, entity_type, entity_id, marketplace, metric_name, numeric_value, source,
        source_type, is_estimated, confidence, observation_date, collected_at, dedup_key
      ) VALUES (?, ?, ?, 'US', 'monthly_sales', 123, 'Amazon', 'amazon', 0, 0.95,
        '2026-09-19', '2026-09-19T08:00:00.000Z', ?)
    `);
    insertFact.run('market-fact', 'market', 'coverage-market', 'market-fact');
    insertFact.run('product-fact', 'product', 'owned-fact', 'product-fact');

    const coverage = new DataCoverageService(database).getCoverage('US');

    expect(coverage.primaryMarket.covered).toBe(1);
    expect(coverage.activeOwnedProducts.covered).toBe(1);
    expect(coverage.amazonActual.covered).toBe(1);
  });
});
