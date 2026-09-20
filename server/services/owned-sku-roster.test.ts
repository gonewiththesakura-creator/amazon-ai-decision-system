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
      id, name, parent_id, level, marketplace, category_id, keywords_json, status, source_type, created_at
    ) VALUES ('market-1', 'Memory foam pillows', NULL, 1, 'US', '101:202', '[]', 'active', 'import', '2026-09-20');
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
    async fetchMarketOverview() { throw new Error('not used'); },
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

    expect(asinCalls).toEqual(['B0CHILD001', 'B0RIVAL001']);
    expect(result).toMatchObject({ productSnapshots: 1, candidateCoverage: { total: 1 }, competitorCoverage: { total: 1 } });
    expect(JSON.parse((database.prepare(`SELECT coverage_json AS coverageJson FROM data_coverage_runs WHERE id = ?`)
      .get(result.runId) as { coverageJson: string }).coverageJson).ownedProducts)
      .toEqual([{ id: 'child', asin: 'B0CHILD001', marketNodeId: 'market-1' }]);
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
});
