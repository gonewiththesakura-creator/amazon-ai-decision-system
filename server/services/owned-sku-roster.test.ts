import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterRegistry } from '../adapters/adapter-registry.js';
import { DataSourceRouter } from '../adapters/data-source-router.js';
import type { MarketDataAdapter, ProductInput } from '../adapters/types.js';
import { createApp } from '../app.js';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { DataCoverageService } from './data-coverage-service.js';
import { GoLiveMigrationService } from './go-live-migration-service.js';
import { IntelligenceService } from './intelligence-service.js';
import {
  SellerSpriteSyncService,
  type SellerSpriteSyncPort,
} from './sellersprite-sync-service.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function setupFamily(): AppDatabase {
  const connection = openDatabase(':memory:');
  connection.exec(`
    INSERT INTO market_nodes (
      id, name, parent_id, level, marketplace, category_id,
      sellersprite_confirmed_node_path, keywords_json, status, source_type, created_at
    ) VALUES ('market-1', 'Memory foam pillows', NULL, 1, 'US', '101:202', '101:202',
      '[]', 'active', 'import', '2026-09-20');
    UPDATE app_settings SET mode = 'live', marketplace = 'US', default_market_id = 'market-1' WHERE id = 1;
    INSERT INTO products (
      id, asin, sku, internal_name, brand, title, image_url, marketplace, product_type, is_owned,
      market_node_id, keywords_json, monitoring_enabled, source_type, created_at, status, parent_asin, is_parent
    ) VALUES
      ('parent', 'B0PARENT01', 'PARENT-01', 'Family parent', 'Owned', 'Family parent', '', 'US', 'pillow', 1,
        'market-1', '[]', 1, 'import', '2026-09-20', 'active', 'B0PARENT01', 1),
      ('child', 'B0CHILD001', 'CHILD-01', 'Sellable child', 'Owned', 'Sellable child', '', 'US', 'pillow', 1,
        'market-1', '[]', 1, 'import', '2026-09-20', 'active', 'B0PARENT01', 0),
      ('competitor', 'B0RIVAL001', 'RIVAL-01', 'Rival', 'Rival', 'Rival', '', 'US', 'pillow', 0,
        'market-1', '[]', 1, 'import', '2026-09-20', 'active', NULL, 0),
      ('competitor-parent', 'B0RIVALP01', 'RIVAL-P', 'Rival parent', 'Rival', 'Rival parent', '', 'US', 'pillow', 0,
        'market-1', '[]', 1, 'import', '2026-09-20', 'active', 'B0RIVALP01', 1);
    INSERT INTO competitor_relations (
      id, owned_product_id, competitor_product_id, relation_type, similarity_score, reason, ai_tags_json, created_at
    ) VALUES
      ('parent-rival', 'parent', 'competitor', 'direct', 90, 'family-level relation', '[]', '2026-09-20'),
      ('child-rival', 'child', 'competitor', 'direct', 90, 'sellable relation', '[]', '2026-09-20'),
      ('child-rival-parent', 'child', 'competitor-parent', 'direct', 90, 'parent competitor relation', '[]', '2026-09-20');
    INSERT INTO product_snapshots (
      id, product_id, date, price, estimated_sales, estimated_revenue, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES
      ('parent-history', 'parent', '2026-08-31', 40, 900, 36000, 'Historical import', 'import', '2026-09-01',
        '1M', 1, 0.9, '2026-08-31', 'parent-history'),
      ('child-history', 'child', '2026-08-31', 40, 100, 4000, 'Historical import', 'import', '2026-09-01',
        '1M', 1, 0.9, '2026-08-31', 'child-history');
    INSERT INTO market_snapshots (
      id, market_node_id, date, monthly_sales, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES ('market-history', 'market-1', '2026-08-31', 10000, 'Historical import', 'import', '2026-09-01',
      '1M', 1, 0.9, '2026-08-31', 'market-history');
  `);
  return connection;
}

function legacyImportAdapter(calls: string[]): MarketDataAdapter {
  const provenance = {
    source: 'SellerSprite reviewed import', sourceType: 'import' as const,
    collectedAt: '2026-09-21T01:00:00.000Z', period: '30D', isEstimated: true, confidence: 0.9,
  };
  return {
    id: 'source-sellersprite-import',
    name: 'SellerSprite reviewed import',
    sourceType: 'import',
    async fetchMarketOverview(input) {
      const previous = input.previousSnapshot;
      return {
        productCount: previous?.productCount ?? 20,
        sellerCount: previous?.sellerCount ?? 10,
        brandCount: previous?.brandCount ?? 5,
        monthlySales: (previous?.monthlySales ?? 10_000) + 100,
        monthlyRevenue: (previous?.monthlyRevenue ?? 400_000) + 4_000,
        avgPrice: previous?.avgPrice ?? 40,
        medianPrice: previous?.medianPrice ?? 39,
        avgRating: previous?.avgRating ?? 4.4,
        medianReviews: previous?.medianReviews ?? 100,
        top10Share: previous?.top10Share ?? 30,
        top20Share: previous?.top20Share ?? 45,
        newProductShare: previous?.newProductShare ?? 10,
        priceBands: previous?.priceBands ?? [],
        concentration: previous?.concentration ?? [],
        provenance,
      };
    },
    async fetchMarketProducts() { return []; },
    async fetchKeywordData() { return []; },
    async fetchProductDetail(input: ProductInput) {
      calls.push(input.asin);
      return {
        id: `external-${input.asin}`, asin: input.asin, brand: 'Imported', title: 'Imported product',
        imageUrl: '', marketplace: input.marketplace, productType: 'pillow', isOwned: false,
        marketNodeId: 'market-1', provenance,
        latest: {
          id: `external-snapshot-${input.asin}`, snapshotAvailable: true,
          productId: `external-${input.asin}`, date: '2026-09-21', price: 40,
          rating: 4.5, reviewCount: 100, bsr: 1_000, estimatedSales: 120,
          estimatedRevenue: 4_800, sellerCount: 1, growth7d: 1, growth30d: 2,
          growth30dAvailable: true, growth90d: 3, provenance,
        },
      };
    },
  };
}

function sellerSpritePort(asinCalls: string[]): SellerSpriteSyncPort {
  const provenance = {
    source: 'SellerSprite MCP', sourceType: 'mcp' as const, collectedAt: '2026-09-21T00:00:00.000Z',
    period: '1M', isEstimated: true, confidence: 0.9,
  };
  return {
    async fetchMarketStatistics(input) {
      return { data: { marketplace: input.marketplace, nodeIdPath: input.nodeIdPath, products: 20, totalUnits: 1000 }, provenance };
    },
    async fetchMarketConcentration() {
      return { data: [], provenance };
    },
    async fetchAsinSalesTrend(input) {
      asinCalls.push(input.asin);
      return {
        data: {
          asin: { asin: input.asin, marketplace: input.marketplace, title: 'Product', brand: 'Brand' },
          salesTrendPoints: [{ month: '2026-08', childUnitSales: 100, childSalesRevenue: 4000 }],
        },
        provenance,
      };
    },
    async discoverAsinCompetitors() {
      return { data: [], provenance };
    },
  };
}

describe('sellable child SKU roster', () => {
  it('excludes an active parent from dashboard KPI and Live coverage denominators while preserving its history', async () => {
    database = setupFamily();
    const app: Express = createApp({ database });

    const dashboard = (await request(app).get('/api/dashboard/executive').expect(200)).body.data;
    const briefing = (await request(app).get('/api/dashboard/briefing').expect(200)).body.data;
    const products = (await request(app).get('/api/owned-products').expect(200)).body.data;
    const parent = (await request(app).get('/api/owned-products/parent').expect(200)).body.data;
    const marketProducts = (await request(app).get('/api/markets/market-1/products').expect(200)).body.data;
    const coverage = new DataCoverageService(database).getCoverage('US');

    expect(dashboard.kpis.totalSkus).toBe(1);
    expect(dashboard.ownedSkuPerformance.map((product: { id: string }) => product.id)).toEqual(['child']);
    expect(briefing.summaries.skus.pendingData).toBe(1);
    expect(new Set(products.map((product: { id: string }) => product.id)))
      .toEqual(new Set(['parent', 'child']));
    expect(parent.snapshots.map((snapshot: { id: string }) => snapshot.id)).toContain('parent-history');
    expect(marketProducts.map((product: { id: string }) => product.id))
      .not.toEqual(expect.arrayContaining(['parent', 'competitor-parent']));
    expect(coverage.activeOwnedProducts).toMatchObject({ covered: 1, total: 1, status: 'complete' });
    expect(coverage.coreCompetitors.total).toBe(1);
    expect(database.prepare(`SELECT id FROM product_snapshots WHERE id = 'parent-history'`).get())
      .toEqual({ id: 'parent-history' });
  });

  it('rejects an active parent master as an executive comparison SKU', async () => {
    database = setupFamily();
    const app = createApp({ database });

    await request(app).get('/api/dashboard/executive?compareSkuIds=parent').expect(404);
  });

  it('uses only sellable children for Go Live Evidence requirements', () => {
    database = setupFamily();

    const verification = new GoLiveMigrationService(database).verify();

    expect(verification.activeOwnedProducts).toBe(1);
    expect(verification.requiredEvidenceEntities).toBe(2);
  });

  it('does not call SellerSprite for a parent or use its competitor relation in a critical roster', async () => {
    database = setupFamily();
    const asinCalls: string[] = [];

    const result = await new SellerSpriteSyncService(database, sellerSpritePort(asinCalls))
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' });
    const roster = (await request(createApp({ database }))
      .get(`/api/integrations/sellersprite/sync/critical/${result.runId}/roster`)
      .expect(200)).body.data;

    expect(asinCalls).toEqual(['B0CHILD001', 'B0RIVAL001']);
    expect(result).toMatchObject({ productSnapshots: 1, candidateCoverage: { total: 1 }, competitorCoverage: { total: 1 } });
    expect(roster).toEqual({ marketId: 'market-1', ownedProductIds: ['child'] });
    expect(JSON.stringify(roster)).not.toMatch(/B0CHILD001|101:202|Sellable child/);
    expect(JSON.parse((database.prepare(`SELECT coverage_json AS coverageJson FROM data_coverage_runs WHERE id = ?`)
      .get(result.runId) as { coverageJson: string }).coverageJson).ownedProducts)
      .toEqual([{ id: 'child', asin: 'B0CHILD001', marketNodeId: 'market-1' }]);
  });

  it('rejects a run roster while its critical task is incomplete or failed', async () => {
    database = setupFamily();
    const runId = '11111111-1111-4111-8111-111111111111';
    database.prepare(`
      INSERT INTO data_coverage_runs (
        id, marketplace, run_type, coverage_json, is_complete, created_at
      ) VALUES (?, 'US', 'critical_sync', ?, 0, '2026-09-21T00:00:00.000Z')
    `).run(runId, JSON.stringify({
      marketId: 'market-1', ownedProducts: [{ id: 'child' }],
    }));
    database.prepare(`
      INSERT INTO data_tasks (
        id, sync_run_id, name, task_type, target, source, marketplace,
        status, total, success, failed, created_at
      ) VALUES (?, ?, 'failed critical', 'critical_sync', 'market-1',
        'SellerSprite MCP', 'US', 'failed', 2, 1, 1, '2026-09-21T00:00:00.000Z')
    `).run(runId, runId);

    await request(createApp({ database }))
      .get(`/api/integrations/sellersprite/sync/critical/${runId}/roster`)
      .expect(404);
  });

  it.each([
    ['empty', []],
    ['duplicate', [{ id: 'child' }, { id: 'child' }]],
  ])('rejects %s product coverage in a completed run roster', async (_label, ownedProducts) => {
    database = setupFamily();
    const runId = '22222222-2222-4222-8222-222222222222';
    database.prepare(`
      INSERT INTO data_coverage_runs (
        id, marketplace, run_type, coverage_json, is_complete, created_at
      ) VALUES (?, 'US', 'critical_sync', ?, 1, '2026-09-21T00:00:00.000Z')
    `).run(runId, JSON.stringify({ marketId: 'market-1', ownedProducts }));
    database.prepare(`
      INSERT INTO data_tasks (
        id, sync_run_id, name, task_type, target, source, marketplace,
        status, total, success, failed, created_at
      ) VALUES (?, ?, 'complete critical', 'critical_sync', 'market-1',
        'SellerSprite MCP', 'US', 'success', 2, 2, 0, '2026-09-21T00:00:00.000Z')
    `).run(runId, runId);

    await request(createApp({ database }))
      .get(`/api/integrations/sellersprite/sync/critical/${runId}/roster`)
      .expect(409);
  });

  it.each(['owned_sku_refresh', 'product_refresh'])(
    'excludes parent masters from legacy %s batch refreshes',
    async (taskType) => {
      database = setupFamily();
      const calls: string[] = [];
      const adapter = legacyImportAdapter(calls);
      const service = new IntelligenceService(
        database, new DataSourceRouter(new AdapterRegistry([adapter])),
      );

      const task = await service.runDataTask({
        taskType, target: 'all', sourcePreference: adapter.id,
      });

      expect(task.status).toBe('success');
      expect(calls).toEqual(['B0CHILD001']);
    },
  );

  it('excludes parent owners and parent competitors from legacy competitor batches', async () => {
    database = setupFamily();
    const calls: string[] = [];
    const adapter = legacyImportAdapter(calls);
    const service = new IntelligenceService(
      database, new DataSourceRouter(new AdapterRegistry([adapter])),
    );

    const task = await service.runDataTask({
      taskType: 'competitor_refresh', target: 'all', sourcePreference: adapter.id,
    });

    expect(task.status).toBe('success');
    expect(calls).toEqual(['B0RIVAL001']);
  });

  it.each([
    ['manual refresh', { taskType: 'manual_refresh', target: 'child' }],
    ['owned SKU batch', { taskType: 'owned_sku_refresh', target: 'all' }],
    ['product batch', { taskType: 'product_refresh', target: 'all' }],
    ['competitor batch', { taskType: 'competitor_refresh', target: 'all' }],
    ['dashboard core batch', { taskType: 'dashboard_core_refresh', target: 'all' }],
  ])('does not refresh a deactivated owned SKU through %s', async (_label, taskInput) => {
    database = setupFamily();
    const calls: string[] = [];
    const adapter = legacyImportAdapter(calls);
    const service = new IntelligenceService(
      database, new DataSourceRouter(new AdapterRegistry([adapter])),
    );
    expect(service.deactivateOwnedProduct('child')).toBe(true);
    const before = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM product_snapshots WHERE product_id = 'child') AS snapshots,
        (SELECT COUNT(*) FROM ai_insights
          WHERE entity_type = 'owned_product' AND entity_id = 'child') AS insights
    `).get();

    await service.runDataTask({ ...taskInput, sourcePreference: adapter.id });

    expect(calls).toEqual([]);
    expect(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM product_snapshots WHERE product_id = 'child') AS snapshots,
        (SELECT COUNT(*) FROM ai_insights
          WHERE entity_type = 'owned_product' AND entity_id = 'child') AS insights
    `).get()).toEqual(before);
  });

  it('does not refresh a deactivated owned SKU through a stale watchlist item', async () => {
    database = setupFamily();
    const calls: string[] = [];
    const adapter = legacyImportAdapter(calls);
    const service = new IntelligenceService(
      database, new DataSourceRouter(new AdapterRegistry([adapter])),
    );
    expect(service.deactivateOwnedProduct('child')).toBe(true);
    database.prepare(`
      INSERT INTO watchlist_items (
        id, item_type, item_id, name, marketplace, frequency, status,
        latest_finding, anomaly, created_at
      ) VALUES ('stale-child-watch', 'owned_product', 'child', 'Stale child', 'US',
        'manual', 'active', '', 0, '2026-09-21T00:00:00.000Z')
    `).run();
    const before = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM product_snapshots WHERE product_id = 'child') AS snapshots,
        (SELECT COUNT(*) FROM ai_insights
          WHERE entity_type = 'owned_product' AND entity_id = 'child') AS insights
    `).get();

    const task = await service.runDataTask({
      taskType: 'watchlist_refresh', target: 'child', watchlistId: 'stale-child-watch',
      sourcePreference: adapter.id,
    });

    expect(task.status).toBe('failed');
    expect(calls).toEqual([]);
    expect(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM product_snapshots WHERE product_id = 'child') AS snapshots,
        (SELECT COUNT(*) FROM ai_insights
          WHERE entity_type = 'owned_product' AND entity_id = 'child') AS insights
    `).get()).toEqual(before);
  });

  it('does not analyze an inactive owner when a shared competitor batch refreshes', async () => {
    database = setupFamily();
    database.exec(`
      INSERT INTO products (
        id, asin, sku, internal_name, brand, title, image_url, marketplace, product_type, is_owned,
        market_node_id, keywords_json, monitoring_enabled, source_type, created_at, status, is_parent
      ) VALUES ('active-peer', 'B0ACTIVE02', 'ACTIVE-02', 'Active peer', 'Owned', 'Active peer', '',
        'US', 'pillow', 1, 'market-1', '[]', 1, 'import', '2026-09-20', 'active', 0);
      INSERT INTO product_snapshots (
        id, product_id, date, price, estimated_sales, estimated_revenue, source, source_type,
        collected_at, period, is_estimated, confidence, observation_date, dedup_key
      ) VALUES ('active-peer-history', 'active-peer', '2026-08-31', 40, 110, 4400,
        'Historical import', 'import', '2026-09-01', '1M', 1, 0.9, '2026-08-31', 'active-peer-history');
      INSERT INTO competitor_relations (
        id, owned_product_id, competitor_product_id, relation_type, similarity_score,
        reason, ai_tags_json, created_at
      ) VALUES ('active-peer-rival', 'active-peer', 'competitor', 'direct', 90,
        'shared competitor', '[]', '2026-09-20');
    `);
    const calls: string[] = [];
    const adapter = legacyImportAdapter(calls);
    const service = new IntelligenceService(
      database, new DataSourceRouter(new AdapterRegistry([adapter])),
    );
    expect(service.deactivateOwnedProduct('child')).toBe(true);
    const inactiveInsightsBefore = database.prepare(`
      SELECT COUNT(*) AS count FROM ai_insights
      WHERE entity_type = 'owned_product' AND entity_id = 'child'
    `).get();

    const task = await service.runDataTask({
      taskType: 'competitor_refresh', target: 'all', sourcePreference: adapter.id,
    });

    expect(task.status).toBe('success');
    expect(calls).toEqual(['B0RIVAL001']);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM ai_insights
      WHERE entity_type = 'owned_product' AND entity_id = 'child'
    `).get()).toEqual(inactiveInsightsBefore);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM ai_insights
      WHERE entity_type = 'owned_product' AND entity_id = 'active-peer'
    `).get()).toEqual({ count: 1 });
  });
});
