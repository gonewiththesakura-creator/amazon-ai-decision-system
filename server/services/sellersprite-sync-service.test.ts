import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { IntelligenceRepository } from '../repository/intelligence-repository.js';
import { SellerSpriteSyncService, type SellerSpriteSyncPort } from './sellersprite-sync-service.js';
import { MetricAuthorityResolver } from './metric-authority-resolver.js';
import { DashboardFreshnessService } from './dashboard-freshness-service.js';
import { proveDashboardRunReadPath } from './dashboard-run-read-proof.js';
import { seedConfirmedOwnedRoster } from '../test-utils/owned-roster-declaration.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

const provenance = {
  source: 'SellerSprite MCP',
  sourceType: 'mcp' as const,
  collectedAt: '2026-09-19T02:30:00.000Z',
  period: '1M',
  isEstimated: true,
  confidence: 0.85,
};
const NODE_PATH = '1055398:1063252:1199122:10671043011';

function fixturePort(overrides: Partial<SellerSpriteSyncPort> = {}): SellerSpriteSyncPort {
  return {
    async fetchMarketResearchSummary(input: {
      marketplace: string;
      nodeIdPath: string;
      month?: string;
    }) {
      return {
        data: {
          marketplace: input.marketplace,
          nodeIdPath: input.nodeIdPath,
          month: input.month,
          totalProducts: 2,
          topProducts: 2,
        },
        provenance,
      };
    },
    async fetchMarketStatistics() {
      return {
        data: {
          marketplace: 'US', nodeIdPath: NODE_PATH, products: 2, brands: 2,
          sellers: 2, avgPrice: 40, avgRating: 4.4,
        },
        provenance,
      };
    },
    async fetchMarketConcentration() {
      return {
        data: [
          { asin: 'B0PUBLIC01', title: 'Pillow One', brand: 'One', price: 30,
            rating: 4.5, ratings: 100, totalUnits: 10, totalRevenue: 300,
            totalUnitsRatio: 0.3333 },
          { asin: 'B0PUBLIC02', title: 'Pillow Two', brand: 'Two', price: 50,
            rating: 4.3, ratings: 50, totalUnits: 20, totalRevenue: 1000,
            totalUnitsRatio: 0.6667 },
        ],
        provenance,
      };
    },
    async fetchAsinSalesTrend(input) {
      return {
        data: {
          asin: { asin: input.asin, marketplace: input.marketplace, parent: 'B0PARENT01',
            title: 'Owned Pillow', brand: 'Owned', price: 42, rating: 4.6, ratings: 90 },
          salesTrendPoints: [
            { month: '2026-07', price: 40, childUnitSales: 100, childSalesRevenue: 4000 },
            { month: '2026-08', price: 42, childUnitSales: 120, childSalesRevenue: 5040 },
          ],
        },
        provenance,
      };
    },
    async discoverAsinCompetitors() {
      return {
        data: [{ asin: 'B0PUBLIC03', brand: 'Candidate', title: 'Candidate Pillow',
          parent: 'B0PARENT03', price: 39, units: 90, rating: 4.2, ratings: 70 }],
        provenance,
      };
    },
    ...overrides,
  };
}

function fixtureDatabase(): AppDatabase {
  const connection = openDatabase(':memory:');
  connection.exec(`
    INSERT INTO market_nodes (
      id, name, parent_id, level, marketplace, category_id,
      sellersprite_confirmed_node_path, keywords_json, status, source_type, created_at
    ) VALUES (
      'market-1', 'Bed Pillows', NULL, 1, 'US', '1055398:1063252:1199122:10671043011',
      '1055398:1063252:1199122:10671043011', '["memory foam pillow"]',
      'active', 'import', '2026-09-01T00:00:00.000Z'
    );
    INSERT INTO products (
      id, asin, sku, internal_name, brand, title, image_url, marketplace, product_type,
      is_owned, market_node_id, keywords_json, monitoring_enabled, source_type, created_at
    ) VALUES (
      'owned-1', 'B0OWNED001', 'SKU-01', 'Owned Pillow', 'Owned', 'Owned Pillow', '',
      'US', 'memory_foam_pillow', 1, 'market-1', '[]', 1, 'import',
      '2026-09-01T00:00:00.000Z'
    );
    UPDATE app_settings SET mode = 'live', default_market_id = 'market-1' WHERE id = 1;
  `);
  seedConfirmedOwnedRoster(connection);
  return connection;
}

function count(table: 'market_snapshots' | 'product_snapshots' | 'competitor_candidates'): number {
  return (database!.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe('SellerSprite real-data sync', () => {
  it('rejects a critical batch without a confirmed owned-roster declaration before contacting MCP', async () => {
    database = fixtureDatabase();
    database.prepare(`DELETE FROM owned_roster_declarations WHERE marketplace = 'US'`).run();
    let calls = 0;
    const port = fixturePort({
      async fetchMarketResearchSummary() {
        calls += 1;
        throw new Error('MCP should not be called');
      },
    });
    await expect(new SellerSpriteSyncService(database, port)
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' }))
      .rejects.toThrow(/roster|声明|确认/);
    expect(calls).toBe(0);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM data_tasks
      WHERE task_type = 'critical_sync'`).get()).toEqual({ count: 0 });
  });
  it('requires an explicit confirmed SellerSprite path before market sync', async () => {
    database = fixtureDatabase();
    database.prepare(`UPDATE market_nodes SET sellersprite_confirmed_node_path = NULL
      WHERE id = 'market-1'`).run();
    await expect(new SellerSpriteSyncService(database, fixturePort())
      .syncMarket({ marketId: 'market-1', month: '202608' }))
      .rejects.toThrow(/category|节点路径|映射/i);
    expect(count('market_snapshots')).toBe(0);
  });
  it('does not let historical analysis status changes disable a confirmed market sync', async () => {
    database = fixtureDatabase();
    database.prepare(`UPDATE market_nodes SET status = '等待30D对照' WHERE id = 'market-1'`).run();

    await expect(new SellerSpriteSyncService(database, fixturePort())
      .syncMarket({ marketId: 'market-1', month: '202608' }))
      .resolves.toMatchObject({ inserted: 1 });
  });
  it('persists a market observation with real source and nullable missing metrics', async () => {
    database = fixtureDatabase();
    const service = new SellerSpriteSyncService(database, fixturePort());

    const result = await service.syncMarket({ marketId: 'market-1', month: '202608' });

    expect(result.inserted).toBe(1);
    expect(result.runId).toMatch(/^[a-f0-9-]{36}$/i);
    expect(database.prepare(`
      SELECT observation_date, date, collected_at, source_type, monthly_sales,
        monthly_revenue, median_reviews
      FROM market_snapshots WHERE market_node_id = 'market-1'
    `).get()).toMatchObject({
      observation_date: '2026-08-31', date: '2026-08-31',
      collected_at: provenance.collectedAt, source_type: 'mcp',
      monthly_sales: null, monthly_revenue: null, median_reviews: null,
    });
    expect(database.prepare(`
      SELECT id, sync_run_id AS syncRunId, status, success, failed
      FROM data_tasks WHERE id = ?
    `).get(result.runId)).toEqual({
      id: result.runId, syncRunId: result.runId, status: 'success', success: 1, failed: 0,
    });
    expect(database.prepare(`SELECT DISTINCT sync_run_id AS runId FROM market_snapshots`).all())
      .toEqual([{ runId: result.runId }]);
    expect(database.prepare(`SELECT DISTINCT sync_run_id AS runId FROM metric_facts`).all())
      .toEqual([{ runId: result.runId }]);
  });

  it('uses one certified three-source request to normalize fully covered market metrics', async () => {
    database = fixtureDatabase();
    const calls: Array<{
      source: string;
      month: string | undefined;
      runId: string | undefined;
      requireObservationMonth: boolean | undefined;
    }> = [];
    const port = Object.assign(fixturePort(), {
      async fetchMarketResearchSummary(
        input: { marketplace: string; nodeIdPath: string; month?: string },
        context?: { runId?: string; requireObservationMonth?: boolean },
      ) {
        calls.push({
          source: 'research', month: input.month, runId: context?.runId,
          requireObservationMonth: context?.requireObservationMonth,
        });
        return {
          data: {
            marketplace: input.marketplace, nodeIdPath: input.nodeIdPath, month: input.month,
            totalProducts: 4, topProducts: 4, totalUnits: 12_345, totalRevenue: 456_789,
            top10ProductCrn: 18.5, top20ProductCrn: 31.25,
          },
          provenance,
        };
      },
      async fetchMarketStatistics(
        input: { marketplace: string; nodeIdPath: string; month?: string },
        context?: { runId?: string; requireObservationMonth?: boolean },
      ) {
        calls.push({
          source: 'statistics', month: input.month, runId: context?.runId,
          requireObservationMonth: context?.requireObservationMonth,
        });
        return {
          data: {
            marketplace: input.marketplace, nodeIdPath: input.nodeIdPath, month: input.month,
            products: 999, totalProducts: 400, sellers: 70, brands: 62,
            totalUnits: 1, totalRevenue: 2,
            avgPrice: 36.38, medianPrice: 999, avgRating: 4.2, medianReviews: 999,
            top10Share: 99, top20Share: 100, newProductProportion: 41,
          },
          provenance,
        };
      },
      async fetchMarketConcentration(
        input: { marketplace: string; nodeIdPath: string; month?: string },
        context?: { runId?: string; requireObservationMonth?: boolean },
      ) {
        calls.push({
          source: 'concentration', month: input.month, runId: context?.runId,
          requireObservationMonth: context?.requireObservationMonth,
        });
        return {
          data: [
            { marketplace: input.marketplace, nodeIdPath: input.nodeIdPath,
              month: input.month, asin: 'B0MEDIAN001', price: 20, reviews: 9, ratings: 900 },
            { marketplace: input.marketplace, nodeIdPath: input.nodeIdPath,
              month: input.month, asin: 'B0MEDIAN002', price: 40, reviews: 1, ratings: 100 },
            { marketplace: input.marketplace, nodeIdPath: input.nodeIdPath,
              month: input.month, asin: 'B0MEDIAN003', price: 10, reviews: 5, ratings: 500 },
            { marketplace: input.marketplace, nodeIdPath: input.nodeIdPath,
              month: input.month, asin: 'B0MEDIAN004', price: 30, reviews: 13, ratings: 1300 },
          ],
          provenance,
        };
      },
    });

    const result = await new SellerSpriteSyncService(database, port)
      .syncMarket({ marketId: 'market-1', month: '202608' });

    expect(calls.map(({ source }) => source).sort()).toEqual([
      'concentration', 'research', 'statistics',
    ]);
    expect(calls.every((call) => call.month === '202608'
      && call.runId === result.runId && call.requireObservationMonth === true)).toBe(true);
    expect(database.prepare(`
      SELECT product_count AS productCount, seller_count AS sellerCount,
        brand_count AS brandCount, monthly_sales AS monthlySales,
        monthly_revenue AS monthlyRevenue, avg_price AS avgPrice,
        median_price AS medianPrice, avg_rating AS avgRating,
        median_reviews AS medianReviews, top10_share AS top10Share,
        top20_share AS top20Share, new_product_share AS newProductShare
      FROM market_snapshots WHERE market_node_id = 'market-1'
    `).get()).toEqual({
      productCount: 4, sellerCount: 70, brandCount: 62,
      monthlySales: 12_345, monthlyRevenue: 456_789,
      avgPrice: 36.38, medianPrice: 25, avgRating: 4.2, medianReviews: 7,
      top10Share: null, top20Share: null, newProductShare: 41,
    });
  });

  it('keeps medians null when the research summary does not define a full cohort', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchMarketConcentration(input) {
        return {
          data: [
            { marketplace: input.marketplace, nodeIdPath: input.nodeIdPath,
              asin: 'B0PUBLIC01', price: 11, reviews: 0 },
            { marketplace: input.marketplace, nodeIdPath: input.nodeIdPath,
              asin: 'B0PUBLIC02', price: 19, reviews: 10 },
            { marketplace: input.marketplace, nodeIdPath: input.nodeIdPath,
              asin: 'B0PUBLIC03', price: 15, reviews: 3 },
            { marketplace: input.marketplace, nodeIdPath: input.nodeIdPath,
              asin: 'B0PUBLIC04', price: -1, reviews: -1 },
            { marketplace: input.marketplace, nodeIdPath: input.nodeIdPath,
              asin: 'B0PUBLIC05', price: Number.POSITIVE_INFINITY, reviews: Number.NaN },
          ],
          provenance,
        };
      },
    });

    await new SellerSpriteSyncService(database, port)
      .syncMarket({ marketId: 'market-1', month: '202608' });

    expect(database.prepare(`
      SELECT monthly_sales AS monthlySales, monthly_revenue AS monthlyRevenue,
        median_price AS medianPrice, median_reviews AS medianReviews,
        top10_share AS top10Share, top20_share AS top20Share
      FROM market_snapshots WHERE market_node_id = 'market-1'
    `).get()).toEqual({
      monthlySales: null, monthlyRevenue: null, medianPrice: null, medianReviews: null,
      top10Share: null, top20Share: null,
    });
  });

  it.each([
    {
      scenario: 'top products cover only part of the market', totalProducts: 3,
      rows: [
        { asin: 'B0PUBLIC01', price: 10, reviews: 10 },
        { asin: 'B0PUBLIC02', price: 30, reviews: 20 },
      ], sales: null, price: null, reviews: null, top10: null,
    },
    {
      scenario: 'the concentration result omits a product', totalProducts: 2,
      rows: [{ asin: 'B0PUBLIC01', price: 10, reviews: 10 }],
      sales: 30, price: null, reviews: null, top10: null,
    },
    {
      scenario: 'the concentration result repeats an ASIN', totalProducts: 2,
      rows: [
        { asin: 'B0PUBLIC01', price: 10, reviews: 10 },
        { asin: 'B0PUBLIC01', price: 30, reviews: 20 },
      ], sales: 30, price: null, reviews: null, top10: null,
    },
    {
      scenario: 'one product has no reviews count', totalProducts: 2,
      rows: [
        { asin: 'B0PUBLIC01', price: 10, reviews: 10 },
        { asin: 'B0PUBLIC02', price: 30, ratings: 999 },
      ], sales: 30, price: 20, reviews: null, top10: null,
    },
    {
      scenario: 'one product has an invalid price', totalProducts: 2,
      rows: [
        { asin: 'B0PUBLIC01', price: 10, reviews: 10 },
        { asin: 'B0PUBLIC02', price: -30, reviews: 20 },
      ], sales: 30, price: null, reviews: 15, top10: null,
    },
  ])('never imputes medians from $scenario', async ({
    totalProducts, rows, sales, price, reviews, top10,
  }) => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchMarketResearchSummary(input) {
        return { data: {
          marketplace: input.marketplace, nodeIdPath: input.nodeIdPath,
          totalProducts, topProducts: 2, totalUnits: 30, totalRevenue: 600,
          top10ProductCrn: 10, top20ProductCrn: 20,
        }, provenance };
      },
      async fetchMarketConcentration() { return { data: rows, provenance }; },
    });

    await new SellerSpriteSyncService(database, port)
      .syncMarket({ marketId: 'market-1', month: '202608' });

    expect(database.prepare(`
      SELECT monthly_sales AS sales, median_price AS price,
        median_reviews AS reviews, top10_share AS top10
      FROM market_snapshots WHERE market_node_id = 'market-1'
    `).get()).toEqual({ sales, price, reviews, top10 });
  });

  it('uses only explicit totalProducts fields for market size, never the statistics sample count', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchMarketResearchSummary(input) {
        return { data: { marketplace: input.marketplace,
          nodeIdPath: input.nodeIdPath }, provenance };
      },
      async fetchMarketStatistics() {
        return { data: { marketplace: 'US', nodeIdPath: NODE_PATH,
          products: 100, totalProducts: 123, avgPrice: 40 }, provenance };
      },
    });

    await new SellerSpriteSyncService(database, port)
      .syncMarket({ marketId: 'market-1', month: '202608' });

    expect(database.prepare(`SELECT product_count AS productCount,
      monthly_sales AS monthlySales FROM market_snapshots`).get())
      .toEqual({ productCount: 123, monthlySales: null });
  });

  it('does not present TOP100 sample statistics as full-market metrics', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchMarketResearchSummary(input) {
        return { data: {
          marketplace: input.marketplace, nodeIdPath: input.nodeIdPath,
          totalProducts: 3290, topProducts: 100,
          totalUnits: 252_013, totalRevenue: 9_000_000,
          top10ProductCrn: 0.3185,
        }, provenance };
      },
      async fetchMarketStatistics() {
        return { data: {
          marketplace: 'US', nodeIdPath: NODE_PATH,
          products: 100, sellers: 70, brands: 62, avgPrice: 36.38,
          avgRating: 4.2, newProductProportion: 41,
        }, provenance };
      },
    });

    await new SellerSpriteSyncService(database, port)
      .syncMarket({ marketId: 'market-1', month: '202608' });

    expect(database.prepare(`SELECT product_count AS productCount,
      seller_count AS sellerCount, brand_count AS brandCount,
      monthly_sales AS monthlySales, monthly_revenue AS monthlyRevenue,
      avg_price AS avgPrice, avg_rating AS avgRating,
      new_product_share AS newProductShare, top10_share AS top10Share
      FROM market_snapshots`).get()).toEqual({
      productCount: 3290, sellerCount: null, brandCount: null,
      monthlySales: null, monthlyRevenue: null, avgPrice: null,
      avgRating: null, newProductShare: null, top10Share: null,
    });
  });

  it('derives full-market TOP shares from ranked sales rather than an unverified CRn unit', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchMarketResearchSummary(input) {
        return { data: {
          marketplace: input.marketplace, nodeIdPath: input.nodeIdPath,
          totalProducts: 2, topProducts: 2, totalUnits: 100,
          top10ProductSales: 25, top20ProductSales: 40,
          top10ProductCrn: 0.25, top20ProductCrn: 0.4,
        }, provenance };
      },
    });

    await new SellerSpriteSyncService(database, port)
      .syncMarket({ marketId: 'market-1', month: '202608' });

    expect(database.prepare(`SELECT monthly_sales AS monthlySales,
      top10_share AS top10Share, top20_share AS top20Share
      FROM market_snapshots`).get()).toEqual({
      monthlySales: 100, top10Share: 25, top20Share: 40,
    });
  });

  it.each([
    ['zero market denominator', 0, 0, 0],
    ['ranked sales exceed total', 100, 20, 101],
    ['TOP20 sales are less than TOP10 sales', 100, 50, 40],
    ['negative TOP10 sales', 100, -1, 40],
  ])('keeps ranked shares null for %s', async (_scenario, totalUnits, top10, top20) => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchMarketResearchSummary(input) {
        return { data: {
          marketplace: input.marketplace, nodeIdPath: input.nodeIdPath,
          totalProducts: 2, topProducts: 2, totalUnits,
          top10ProductSales: top10, top20ProductSales: top20,
          top10ProductCrn: 0.25, top20ProductCrn: 0.4,
        }, provenance };
      },
    });

    await new SellerSpriteSyncService(database, port)
      .syncMarket({ marketId: 'market-1', month: '202608' });

    expect(database.prepare(`SELECT top10_share AS top10Share,
      top20_share AS top20Share FROM market_snapshots`).get())
      .toEqual({ top10Share: null, top20Share: null });
  });

  it('keeps product count null when only the statistics sample count exists', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchMarketResearchSummary(input) {
        return { data: { marketplace: input.marketplace,
          nodeIdPath: input.nodeIdPath }, provenance };
      },
    });

    await expect(new SellerSpriteSyncService(database, port)
      .syncMarket({ marketId: 'market-1', month: '202608' }))
      .rejects.toThrow(/没有有效指标/);
    expect(count('market_snapshots')).toBe(0);
  });

  it('rejects negative measures and anomalous percentages without replacing missing with zero', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchMarketResearchSummary(input) {
        return { data: {
          marketplace: input.marketplace, nodeIdPath: input.nodeIdPath,
          totalProducts: 2, topProducts: 2, totalUnits: -30, totalRevenue: -600,
          top10ProductCrn: 110, top20ProductCrn: -10,
        }, provenance };
      },
      async fetchMarketStatistics() {
        return { data: {
          marketplace: 'US', nodeIdPath: NODE_PATH,
          sellers: -1, brands: -2, avgPrice: -40, avgRating: 6,
          newProductShare: 105, newProductProportion: 25,
        }, provenance };
      },
    });

    await new SellerSpriteSyncService(database, port)
      .syncMarket({ marketId: 'market-1', month: '202608' });

    expect(database.prepare(`SELECT product_count AS productCount,
      seller_count AS sellerCount, brand_count AS brandCount,
      monthly_sales AS monthlySales, monthly_revenue AS monthlyRevenue,
      avg_price AS avgPrice, avg_rating AS avgRating, top10_share AS top10,
      top20_share AS top20, new_product_share AS newProductShare
      FROM market_snapshots`).get()).toEqual({
      productCount: 2, sellerCount: null, brandCount: null,
      monthlySales: null, monthlyRevenue: null, avgPrice: null,
      avgRating: null, top10: null, top20: null, newProductShare: 25,
    });
  });

  it('records provider-confirmed parent identity with MCP run lineage', async () => {
    database = fixtureDatabase();
    const service = new SellerSpriteSyncService(database, fixturePort());
    const result = await service.syncOwnedProduct({ productId: 'owned-1' });

    expect(database.prepare(`
      SELECT product_id AS productId, old_lookup_status AS oldStatus,
        new_lookup_status AS newStatus, source_type AS sourceType,
        sync_run_id AS syncRunId, import_batch_id AS importBatchId
      FROM product_identity_events WHERE product_id = 'owned-1'
    `).get()).toEqual({
      productId: 'owned-1', oldStatus: 'unknown', newStatus: 'verified',
      sourceType: 'mcp', syncRunId: result.runId, importBatchId: null,
    });
  });

  it('records a sanitized failed standalone run without writing observations', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchAsinSalesTrend() { throw new Error('token=standalone-secret'); },
    });

    const exposed = await new SellerSpriteSyncService(database, port)
      .syncOwnedProduct({ productId: 'owned-1' })
      .then(() => '', (error: unknown) => error instanceof Error ? error.message : String(error));

    expect(exposed).not.toContain('standalone-secret');
    expect(exposed).toContain('[REDACTED]');
    expect(count('product_snapshots')).toBe(0);
    const task = database.prepare(`
      SELECT id, sync_run_id AS syncRunId, status, failed, error_log AS errorLog
      FROM data_tasks WHERE task_type = 'owned_sku_refresh'
    `).get() as { id: string; syncRunId: string; status: string; failed: number; errorLog: string };
    expect(task).toMatchObject({ syncRunId: task.id, status: 'failed', failed: 1 });
    expect(task.errorLog).not.toContain('standalone-secret');
  });

  it('does not turn an incomplete concentration cohort into totals or ranked shares', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchMarketResearchSummary(input) {
        return { data: { marketplace: input.marketplace,
          nodeIdPath: input.nodeIdPath, totalProducts: 100, topProducts: 2 }, provenance };
      },
      async fetchMarketStatistics() {
        return { data: { marketplace: 'US', nodeIdPath: NODE_PATH, products: 100,
          brands: 71, sellers: 69, avgPrice: 40 }, provenance };
      },
    });
    const service = new SellerSpriteSyncService(database, port);

    await service.syncMarket({ marketId: 'market-1', month: '202608' });

    expect(database.prepare(`
      SELECT monthly_sales, monthly_revenue, median_price, median_reviews,
        top10_share, top20_share
      FROM market_snapshots WHERE market_node_id = 'market-1'
    `).get()).toEqual({
      monthly_sales: null, monthly_revenue: null, median_price: null,
      median_reviews: null, top10_share: null, top20_share: null,
    });
  });

  it('does not infer ranked top shares from an unordered concentration cohort', async () => {
    database = fixtureDatabase();
    const service = new SellerSpriteSyncService(database, fixturePort());

    await service.syncMarket({ marketId: 'market-1', month: '202608' });

    expect(database.prepare(`
      SELECT top10_share, top20_share FROM market_snapshots WHERE market_node_id = 'market-1'
    `).get()).toEqual({ top10_share: null, top20_share: null });
  });

  it('does not accept legacy statistics aliases for research totals or cohort medians', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchMarketResearchSummary(input) {
        return { data: { marketplace: input.marketplace,
          nodeIdPath: input.nodeIdPath, totalProducts: 100, topProducts: 2 }, provenance };
      },
      async fetchMarketStatistics() {
        return { data: { marketplace: 'US', nodeIdPath: NODE_PATH, month: '2026-08',
          products: 100, totalUnits: 12000, avgPrice: 40, medianPrice: 42,
          medianReviews: 300, top10Share: 18.5 }, provenance };
      },
    });

    await new SellerSpriteSyncService(database, port).syncMarket({ marketId: 'market-1', month: '202608' });

    expect(database.prepare(`
      SELECT monthly_sales, median_price, median_reviews, top10_share, top20_share
      FROM market_snapshots WHERE market_node_id = 'market-1'
    `).get()).toEqual({
      monthly_sales: null, median_price: null, median_reviews: null,
      top10_share: null, top20_share: null,
    });
  });

  it('rejects explicit wrong marketplace or node before persisting a market response', async () => {
    database = fixtureDatabase();
    const mismatchedStatistics = fixturePort({
      async fetchMarketStatistics() {
        return { data: { marketplace: 'UK', nodeIdPath: NODE_PATH, products: 100 }, provenance };
      },
    });
    await expect(new SellerSpriteSyncService(database, mismatchedStatistics)
      .syncMarket({ marketId: 'market-1', month: '202608' })).rejects.toThrow(/站点|marketplace/i);
    const mismatchedConcentration = fixturePort({
      async fetchMarketConcentration() {
        return { data: [{ asin: 'B0PUBLIC01', nodeIdPath: 'other-node', totalUnits: 100 }],
          provenance };
      },
    });
    await expect(new SellerSpriteSyncService(database, mismatchedConcentration)
      .syncMarket({ marketId: 'market-1', month: '202608' })).rejects.toThrow(/节点|node/i);
    const mismatchedResearch = fixturePort({
      async fetchMarketResearchSummary() {
        return { data: { marketplace: 'US', nodeIdPath: 'other-node', totalProducts: 100 },
          provenance };
      },
    });
    await expect(new SellerSpriteSyncService(database, mismatchedResearch)
      .syncMarket({ marketId: 'market-1', month: '202608' })).rejects.toThrow(/节点|node/i);
    expect(count('market_snapshots')).toBe(0);
  });

  it('rejects an explicit wrong observation month and a null-only market response', async () => {
    database = fixtureDatabase();
    const wrongMonth = fixturePort({
      async fetchMarketStatistics() {
        return { data: { marketplace: 'US', nodeIdPath: NODE_PATH,
          month: '202607', products: 100 }, provenance };
      },
    });
    await expect(new SellerSpriteSyncService(database, wrongMonth)
      .syncMarket({ marketId: 'market-1', month: '202608' })).rejects.toThrow(/月份|month/i);
    const nullOnly = fixturePort({
      async fetchMarketResearchSummary(input) {
        return { data: { marketplace: input.marketplace,
          nodeIdPath: input.nodeIdPath }, provenance };
      },
      async fetchMarketStatistics() {
        return { data: { marketplace: 'US', nodeIdPath: NODE_PATH }, provenance };
      },
      async fetchMarketConcentration() {
        return { data: [], provenance };
      },
    });
    await expect(new SellerSpriteSyncService(database, nullOnly)
      .syncMarket({ marketId: 'market-1', month: '202608' })).rejects.toThrow(/有效.*指标|metric/i);
    expect(count('market_snapshots')).toBe(0);
  });

  it('checks a numeric provider month when it is explicitly returned', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchMarketStatistics() {
        return { data: { marketplace: 'US', nodeIdPath: NODE_PATH,
          month: 202607, products: 100 }, provenance };
      },
    });

    await expect(new SellerSpriteSyncService(database, port)
      .syncMarket({ marketId: 'market-1', month: '202608' })).rejects.toThrow(/月份|month/i);
    expect(count('market_snapshots')).toBe(0);
  });

  it.each(['research', 'statistics', 'concentration'] as const)(
    'fails standalone market sync when %s cannot certify the requested month', async (capability) => {
      database = fixtureDatabase();
      const base = fixturePort();
      const port = fixturePort({
        async fetchMarketResearchSummary(input, context) {
          if (capability === 'research' && context?.requireObservationMonth) {
            throw new Error('SellerSprite research cannot certify observation month');
          }
          return base.fetchMarketResearchSummary(input, context);
        },
        async fetchMarketStatistics(input, context) {
          if (capability === 'statistics' && context?.requireObservationMonth) {
            throw new Error('SellerSprite statistics cannot certify observation month');
          }
          return base.fetchMarketStatistics(input, context);
        },
        async fetchMarketConcentration(input, context) {
          if (capability === 'concentration' && context?.requireObservationMonth) {
            throw new Error('SellerSprite concentration cannot certify observation month');
          }
          return base.fetchMarketConcentration(input, context);
        },
      });

      await expect(new SellerSpriteSyncService(database, port)
        .syncMarket({ marketId: 'market-1', month: '202608' }))
        .rejects.toThrow(/cannot certify observation month/);
      expect(count('market_snapshots')).toBe(0);
      expect(database.prepare('SELECT COUNT(*) AS count FROM metric_facts').get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT status FROM data_tasks WHERE task_type = 'market_refresh'").get())
        .toEqual({ status: 'failed' });
    },
  );

  it('rejects a day-specific market request instead of silently dropping the day', async () => {
    database = fixtureDatabase();
    await expect(new SellerSpriteSyncService(database, fixturePort())
      .syncMarket({ marketId: 'market-1', month: '2026-08-05' }))
      .rejects.toThrow(/YYYYMM|YYYY-MM/);
    expect(count('market_snapshots')).toBe(0);
  });

  it('preserves historical business months and does not double-count repeated sync', async () => {
    database = fixtureDatabase();
    const service = new SellerSpriteSyncService(database, fixturePort());

    expect((await service.syncOwnedProduct({ productId: 'owned-1' })).inserted).toBe(2);
    expect((await service.syncOwnedProduct({ productId: 'owned-1' })).inserted).toBe(0);
    expect(count('product_snapshots')).toBe(2);
    expect(database.prepare(`
      SELECT observation_date, date, collected_at, estimated_sales, estimated_revenue,
        bsr, review_count
      FROM product_snapshots WHERE product_id = 'owned-1' ORDER BY observation_date
    `).all()).toEqual([
      { observation_date: '2026-07-31', date: '2026-07-31',
        collected_at: provenance.collectedAt, estimated_sales: 100,
        estimated_revenue: 4000, bsr: null, review_count: null },
      { observation_date: '2026-08-31', date: '2026-08-31',
        collected_at: provenance.collectedAt, estimated_sales: 120,
        estimated_revenue: 5040, bsr: null, review_count: null },
    ]);
  });

  it('does not certify or append over conflicting legacy MCP observations', async () => {
    database = fixtureDatabase();
    database.prepare(`INSERT INTO market_snapshots (
      id, market_node_id, date, product_count, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES ('legacy-market', 'market-1', '2026-08-31', 88, 'SellerSprite MCP', 'mcp',
      '2026-09-01', '1M', 1, 0.8, '2026-08-31', 'legacy-market-key')`).run();
    database.prepare(`INSERT INTO product_snapshots (
      id, product_id, date, estimated_sales, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES ('legacy-product', 'owned-1', '2026-08-31', 99, 'SellerSprite MCP', 'mcp',
      '2026-09-01', '1M', 1, 0.8, '2026-08-31', 'legacy-product-key')`).run();
    const service = new SellerSpriteSyncService(database, fixturePort());

    await expect(service.syncMarket({ marketId: 'market-1', month: '202608' }))
      .rejects.toThrow(/不可变观察|不一致/);
    await expect(service.syncOwnedProduct({ productId: 'owned-1' }))
      .rejects.toThrow(/不可变观察|不一致/);
    expect(count('market_snapshots')).toBe(1);
    expect(count('product_snapshots')).toBe(1);
    expect(database.prepare(`SELECT product_count FROM market_snapshots WHERE id = 'legacy-market'`).get())
      .toEqual({ product_count: 88 });
    expect(database.prepare(`SELECT estimated_sales FROM product_snapshots WHERE id = 'legacy-product'`).get())
      .toEqual({ estimated_sales: 99 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM metric_facts
      WHERE entity_type = 'market' AND observation_date = '2026-08-31'`).get())
      .toEqual({ count: 0 });
    expect(database.prepare(`SELECT status FROM data_tasks
      WHERE task_type <> 'file_import' ORDER BY created_at, id`).all())
      .toEqual([{ status: 'failed' }, { status: 'failed' }]);
  });

  it('preserves explicit historical day and rejects an all-null trend point', async () => {
    database = fixtureDatabase();
    const dayPort = fixturePort({
      async fetchAsinSalesTrend(input) {
        return { data: { asin: { asin: input.asin, marketplace: input.marketplace },
          salesTrendPoints: [{ month: '2026-08-05', childUnitSales: 10 }] }, provenance };
      },
    });
    await new SellerSpriteSyncService(database, dayPort).syncOwnedProduct({ productId: 'owned-1' });
    expect(database.prepare(`
      SELECT observation_date FROM product_snapshots WHERE product_id = 'owned-1'
    `).get()).toEqual({ observation_date: '2026-08-05' });

    const emptyPort = fixturePort({
      async fetchAsinSalesTrend(input) {
        return { data: { asin: { asin: input.asin, marketplace: input.marketplace, price: 42 },
          salesTrendPoints: [{ month: '2026-09' }] }, provenance };
      },
    });
    await expect(new SellerSpriteSyncService(database, emptyPort)
      .syncOwnedProduct({ productId: 'owned-1' })).rejects.toThrow(/有效.*指标|metric/i);
    expect(count('product_snapshots')).toBe(1);
  });

  it('rejects explicit wrong ASIN marketplace before persisting its history', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchAsinSalesTrend(input) {
        return { data: { asin: { asin: input.asin, marketplace: 'UK' },
          salesTrendPoints: [{ month: '2026-08', childUnitSales: 10 }] }, provenance };
      },
    });
    await expect(new SellerSpriteSyncService(database, port)
      .syncOwnedProduct({ productId: 'owned-1' })).rejects.toThrow(/站点|marketplace/i);
    expect(count('product_snapshots')).toBe(0);
  });

  it('keeps discovered competitors as candidates until a human confirms one', async () => {
    database = fixtureDatabase();
    const service = new SellerSpriteSyncService(database, fixturePort());

    const result = await service.discoverCompetitors({ ownedProductId: 'owned-1' });

    expect(result.candidates).toBe(1);
    expect(count('competitor_candidates')).toBe(1);
    expect((database.prepare(`
      SELECT COUNT(*) AS count FROM competitor_relations WHERE owned_product_id = 'owned-1'
    `).get() as { count: number }).count).toBe(0);

    const candidate = database.prepare(`
      SELECT id FROM competitor_candidates WHERE source_product_id = 'owned-1'
    `).get() as { id: string };
    const confirmed = service.confirmCompetitorCandidate({
      ownedProductId: 'owned-1',
      candidateId: candidate.id,
      relationType: 'direct',
      reason: '人工核对后确认',
    });

    expect(confirmed).toMatchObject({ ownedProductId: 'owned-1', relationType: 'direct' });
    expect((database.prepare(`
      SELECT status FROM competitor_candidates WHERE id = ?
    `).get(candidate.id) as { status: string }).status).toBe('confirmed');
    expect((database.prepare(`
      SELECT COUNT(*) AS count FROM competitor_relations WHERE owned_product_id = 'owned-1'
    `).get() as { count: number }).count).toBe(1);
    expect(database.prepare(`
      SELECT event.source_type AS sourceType, event.sync_run_id AS syncRunId
      FROM product_identity_events event
      WHERE event.product_id = ?
    `).get(confirmed.competitorProductId)).toEqual({
      sourceType: 'mcp', syncRunId: result.runId,
    });
  });

  it('tracks standalone candidate discovery and preserves the same candidate across runs', async () => {
    database = fixtureDatabase();
    const observedRunIds: Array<string | undefined> = [];
    const base = fixturePort();
    const port = fixturePort({
      async discoverAsinCompetitors(input, context) {
        observedRunIds.push(context?.runId);
        return base.discoverAsinCompetitors(input, context);
      },
    });
    const service = new SellerSpriteSyncService(database, port);

    const first = await service.discoverCompetitors({ ownedProductId: 'owned-1' });
    const second = await service.discoverCompetitors({ ownedProductId: 'owned-1' });

    expect(first).toMatchObject({ runId: expect.any(String), taskId: first.runId, candidates: 1 });
    expect(second).toMatchObject({ runId: expect.any(String), taskId: second.runId, candidates: 1 });
    expect(second.runId).not.toBe(first.runId);
    expect(observedRunIds).toEqual([first.runId]);
    expect(database.prepare(`
      SELECT id, sync_run_id AS syncRunId, status, total, success, failed
      FROM data_tasks WHERE task_type = 'competitor_discovery' ORDER BY created_at, id
    `).all()).toEqual(expect.arrayContaining([
      { id: first.runId, syncRunId: first.runId, status: 'success', total: 1, success: 1, failed: 0 },
      { id: second.runId, syncRunId: second.runId, status: 'success', total: 1, success: 1, failed: 0 },
    ]));
    const candidate = database.prepare(`
      SELECT id, sync_run_id AS originRunId FROM competitor_candidates
      WHERE source_product_id = 'owned-1'
    `).get() as { id: string; originRunId: string };
    expect(candidate.originRunId).toBe(first.runId);
    expect(database.prepare(`
      SELECT sync_run_id AS runId, disposition FROM competitor_candidate_run_links
      WHERE candidate_id = ? ORDER BY created_at, sync_run_id
    `).all(candidate.id)).toEqual(expect.arrayContaining([
      { runId: first.runId, disposition: 'inserted' },
      { runId: second.runId, disposition: 'reused' },
    ]));
  });

  it('rejects a same-key Mock candidate instead of certifying its old payload as MCP', async () => {
    database = fixtureDatabase();
    database.prepare(`
      INSERT INTO competitor_candidates (
        id, marketplace, asin, source_product_id, source, source_type,
        payload_json, status, created_at
      ) VALUES ('mock-candidate', 'US', 'B0PUBLIC03', 'owned-1', 'Demo', 'mock',
        '{"asin":"B0PUBLIC03","title":"Demo Pillow"}', 'pending_review', ?)
    `).run('2026-09-01T00:00:00Z');

    await expect(new SellerSpriteSyncService(database, fixturePort())
      .discoverCompetitors({ ownedProductId: 'owned-1' }))
      .rejects.toThrow(/候选.*(来源|冲突|不一致)/);

    expect(database.prepare(`
      SELECT source_type AS sourceType, payload_json AS payload, sync_run_id AS runId
      FROM competitor_candidates WHERE id = 'mock-candidate'
    `).get()).toEqual({
      sourceType: 'mock', payload: '{"asin":"B0PUBLIC03","title":"Demo Pillow"}', runId: null,
    });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM competitor_candidate_run_links`).get())
      .toEqual({ count: 0 });
    expect(database.prepare(`SELECT status FROM data_tasks WHERE task_type = 'competitor_discovery'`).get())
      .toEqual({ status: 'failed' });
  });

  it('fails candidate secondary coverage when a repeated MCP payload conflicts', async () => {
    database = fixtureDatabase();
    const service = new SellerSpriteSyncService(database, fixturePort());
    const first = await service.discoverCompetitors({ ownedProductId: 'owned-1' });
    const candidate = database.prepare(`
      SELECT id, payload_json AS payload FROM competitor_candidates WHERE source_product_id = 'owned-1'
    `).get() as { id: string; payload: string };
    const base = fixturePort();
    const changed = fixturePort({
      async discoverAsinCompetitors(input, context) {
        const response = await base.discoverAsinCompetitors(input, context);
        return { ...response, data: response.data.map((item) => ({ ...item, price: 41 })) };
      },
    });

    const sync = new SellerSpriteSyncService(database, changed);
    const input = { marketId: 'market-1', month: '202608', syncMode: 'certification' as const };
    const plan = sync.planCritical(input);
    const result = await sync.syncCriticalBatch({ ...input, planId: plan.id, confirmed: true });

    expect(result.candidateCoverage).toMatchObject({ status: 'failed', total: 1, success: 0, failed: 1 });
    expect(database.prepare(`
      SELECT status, sync_run_id AS runId FROM data_tasks WHERE task_type = 'competitor_discovery'
        AND sync_run_id = ?
    `).get(result.runId)).toEqual({ status: 'failed', runId: result.runId });
    expect(database.prepare(`SELECT payload_json AS payload FROM competitor_candidates WHERE id = ?`)
      .get(candidate.id)).toEqual({ payload: candidate.payload });
    expect(database.prepare(`SELECT sync_run_id AS runId FROM competitor_candidate_run_links
      WHERE candidate_id = ?`).all(candidate.id)).toEqual([{ runId: first.runId }]);
  });

  it('rejects a Mock owned master before creating a candidate run or calling MCP', async () => {
    database = fixtureDatabase();
    database.prepare(`UPDATE products SET source_type = 'mock' WHERE id = 'owned-1'`).run();
    let calls = 0;
    const port = fixturePort({
      async discoverAsinCompetitors() {
        calls += 1;
        return { data: [], provenance };
      },
    });

    await expect(new SellerSpriteSyncService(database, port)
      .discoverCompetitors({ ownedProductId: 'owned-1' })).rejects.toThrow(/自有产品/);

    expect(calls).toBe(0);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM data_tasks
      WHERE task_type = 'competitor_discovery'`).get()).toEqual({ count: 0 });
  });

  it('records a sanitized failed standalone candidate run without retaining candidates', async () => {
    database = fixtureDatabase();
    let observedRunId: string | undefined;
    const port = fixturePort({
      async discoverAsinCompetitors(_input, context) {
        observedRunId = context?.runId;
        throw new Error('secret-key=candidate-private-value');
      },
    });

    const exposed = await new SellerSpriteSyncService(database, port)
      .discoverCompetitors({ ownedProductId: 'owned-1' })
      .then(() => '', (error: unknown) => error instanceof Error ? error.message : String(error));

    expect(exposed).not.toContain('candidate-private-value');
    expect(exposed).toContain('[REDACTED]');
    expect(observedRunId).toMatch(/^[a-f0-9-]{36}$/i);
    expect(database.prepare(`
      SELECT id, sync_run_id AS syncRunId, status, failed, error_log AS errorLog
      FROM data_tasks WHERE task_type = 'competitor_discovery'
    `).get()).toEqual({
      id: observedRunId,
      syncRunId: observedRunId,
      status: 'failed',
      failed: 1,
      errorLog: 'SellerSprite 竞品候选发现失败；本次未更新候选，请检查连接和数据范围。',
    });
    expect(count('competitor_candidates')).toBe(0);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM competitor_candidate_run_links`).get())
      .toEqual({ count: 0 });
  });

  it('syncs only a confirmed competitor into immutable MCP history and facts', async () => {
    database = fixtureDatabase();
    const service = new SellerSpriteSyncService(database, fixturePort());
    await service.discoverCompetitors({ ownedProductId: 'owned-1' });
    const candidate = service.listCompetitorCandidates('owned-1')[0]!;
    database.prepare(`
      INSERT INTO products (id, asin, brand, title, image_url, marketplace, product_type,
        is_owned, market_node_id, source_type, created_at)
      VALUES ('pending-competitor', 'B0PUBLIC03', 'Curated', 'Public Pillow', '',
        'US', 'competitor', 0, 'market-1', 'import', '2026-09-01T00:00:00Z')
    `).run();

    await expect(service.syncConfirmedCompetitor({
      ownedProductId: 'owned-1', competitorProductId: 'pending-competitor',
    })).rejects.toThrow(/竞品|关联|确认/);
    expect(count('product_snapshots')).toBe(0);
    const { competitorProductId } = service.confirmCompetitorCandidate({
      ownedProductId: 'owned-1', candidateId: candidate.id,
      relationType: 'direct', reason: '人工核对后确认',
    });

    expect((await service.syncConfirmedCompetitor({ ownedProductId: 'owned-1', competitorProductId })).inserted).toBe(2);
    expect((await service.syncConfirmedCompetitor({ ownedProductId: 'owned-1', competitorProductId })).inserted).toBe(0);
    expect(database.prepare(`
      SELECT product_id, observation_date, estimated_sales, estimated_revenue,
        review_count, source_type, period FROM product_snapshots ORDER BY observation_date
    `).all()).toEqual([
      { product_id: competitorProductId, observation_date: '2026-07-31',
        estimated_sales: 100, estimated_revenue: 4000, review_count: null, source_type: 'mcp', period: '1M' },
      { product_id: competitorProductId, observation_date: '2026-08-31',
        estimated_sales: 120, estimated_revenue: 5040, review_count: null, source_type: 'mcp', period: '1M' },
    ]);
    expect(database.prepare(`
      SELECT metric_name, numeric_value, source_type FROM metric_facts
      WHERE entity_type = 'competitor' AND entity_id = ? AND metric_name = 'estimated_sales'
      ORDER BY observation_date
    `).all(competitorProductId)).toEqual([
      { metric_name: 'estimated_sales', numeric_value: 100, source_type: 'mcp' },
      { metric_name: 'estimated_sales', numeric_value: 120, source_type: 'mcp' },
    ]);
  });

  it('selects a confirmed competitor MCP fact over a later same-date import with fact lineage', async () => {
    database = fixtureDatabase();
    const original = fixturePort();
    const service = new SellerSpriteSyncService(database, fixturePort({
      async fetchAsinSalesTrend(input, context) {
        const result = await original.fetchAsinSalesTrend(input, context);
        return { ...result, data: {
          ...result.data, asin: { ...result.data.asin, parent: 'B0PARENT03' },
        } };
      },
    }));
    await service.discoverCompetitors({ ownedProductId: 'owned-1' });
    const { competitorProductId } = service.confirmCompetitorCandidate({
      ownedProductId: 'owned-1', candidateId: service.listCompetitorCandidates('owned-1')[0]!.id,
      relationType: 'direct', reason: '人工核对后确认',
    });
    await service.syncConfirmedCompetitor({ ownedProductId: 'owned-1', competitorProductId });
    database.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, estimated_sales, estimated_revenue, review_count,
        source, source_type, collected_at, period, is_estimated, confidence,
        observation_date, dedup_key
      ) VALUES (
        'later-import', ?, '2026-08-31', 900, 36000, 70,
        'SellerSprite CSV', 'import', '2026-09-20T02:30:00Z', '1M', 1, 0.99,
        '2026-08-31', 'later-import-competitor'
      )
    `).run(competitorProductId);

    const snapshots = new IntelligenceRepository(database).getProductSnapshots(competitorProductId);
    const selected = snapshots.at(-1)!;
    const fact = database.prepare(`
      SELECT id FROM metric_facts
      WHERE entity_type = 'competitor' AND entity_id = ?
        AND metric_name = 'estimated_sales' AND observation_date = '2026-08-31'
    `).get(competitorProductId) as { id: string } | undefined;

    expect(fact).toBeDefined();
    expect(snapshots).toHaveLength(2);
    expect(selected).toMatchObject({
      date: '2026-08-31', estimatedSales: 120, estimatedRevenue: 5040, reviewCount: 70,
      provenance: { source: 'SellerSprite MCP', sourceType: 'mcp' },
      metricProvenance: {
        estimated_sales: { sourceRecordId: fact!.id, sourceRecordType: 'metric_fact',
          source: 'SellerSprite MCP', sourceType: 'mcp' },
        review_count: { sourceRecordId: 'later-import', sourceRecordType: 'snapshot' },
      },
    });
    expect(database.prepare(`SELECT numeric_value FROM metric_facts WHERE id = ?`)
      .get(selected.metricProvenance?.estimated_sales.sourceRecordId ?? ''))
      .toEqual({ numeric_value: 120 });
  });

  it('rejects a mismatched remote competitor ASIN before writing any observation', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchAsinSalesTrend(input) {
        return { data: { asin: { asin: 'B0WRONG001', marketplace: input.marketplace },
          salesTrendPoints: [{ month: '2026-08', childUnitSales: 100 }] }, provenance };
      },
    });
    const service = new SellerSpriteSyncService(database, port);
    await service.discoverCompetitors({ ownedProductId: 'owned-1' });
    const { competitorProductId } = service.confirmCompetitorCandidate({
      ownedProductId: 'owned-1', candidateId: service.listCompetitorCandidates('owned-1')[0]!.id,
      relationType: 'direct', reason: '人工核对',
    });

    await expect(service.syncConfirmedCompetitor({ ownedProductId: 'owned-1', competitorProductId }))
      .rejects.toThrow(/ASIN.*不一致/);
    expect(count('product_snapshots')).toBe(0);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM metric_facts`).get()).toEqual({ count: 0 });
  });

  it('does not persist a competitor response after its human-approved relation is revoked in flight', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchAsinSalesTrend(input) {
        database!.prepare(`DELETE FROM competitor_relations
          WHERE owned_product_id = 'owned-1' AND competitor_product_id = 'pending-competitor'`).run();
        return { data: { asin: { asin: input.asin, marketplace: input.marketplace },
          salesTrendPoints: [{ month: '2026-08', childUnitSales: 100 }] }, provenance };
      },
    });
    database.prepare(`
      INSERT INTO products (id, asin, brand, title, image_url, marketplace, product_type,
        is_owned, market_node_id, source_type, created_at)
      VALUES ('pending-competitor', 'B0PUBLIC03', 'Curated', 'Public Pillow', '',
        'US', 'competitor', 0, 'market-1', 'import', '2026-09-01T00:00:00Z')
    `).run();
    database.prepare(`
      INSERT INTO competitor_relations (id, owned_product_id, competitor_product_id,
        relation_type, similarity_score, reason, ai_tags_json)
      VALUES ('approved-link', 'owned-1', 'pending-competitor', 'direct', 80, '人工确认', '[]')
    `).run();

    await expect(new SellerSpriteSyncService(database, port).syncConfirmedCompetitor({
      ownedProductId: 'owned-1', competitorProductId: 'pending-competitor',
    })).rejects.toThrow(/确认.*关联/);
    expect(count('product_snapshots')).toBe(0);
  });

  it('refuses to label non-MCP competitor discoveries as MCP candidates', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
      async discoverAsinCompetitors() {
        return { data: [{ asin: 'B0PUBLIC03', title: 'Imported result' }],
          provenance: { ...provenance, sourceType: 'import' } };
      },
    });

    await expect(new SellerSpriteSyncService(database, port)
      .discoverCompetitors({ ownedProductId: 'owned-1' })).rejects.toThrow(/MCP/);
    expect(count('competitor_candidates')).toBe(0);
  });

  it('lists and rejects a candidate without creating a competitor product or relation', async () => {
    database = fixtureDatabase();
    const service = new SellerSpriteSyncService(database, fixturePort());
    await service.discoverCompetitors({ ownedProductId: 'owned-1' });

    const candidates = service.listCompetitorCandidates('owned-1');
    expect(candidates).toEqual([expect.objectContaining({
      asin: 'B0PUBLIC03', status: 'pending_review', title: 'Candidate Pillow',
    })]);
    service.rejectCompetitorCandidate({ ownedProductId: 'owned-1', candidateId: candidates[0]!.id });

    expect(service.listCompetitorCandidates('owned-1')[0]?.status).toBe('rejected');
    expect(() => service.confirmCompetitorCandidate({
      ownedProductId: 'owned-1', candidateId: candidates[0]!.id,
      relationType: 'direct', reason: 'cannot approve rejection',
    })).toThrow(/处理/);
    expect((database.prepare(`SELECT COUNT(*) AS count FROM products`).get() as { count: number }).count).toBe(1);
  });

  it('never turns another owned product into a competitor when confirming a candidate', async () => {
    database = fixtureDatabase();
    database.prepare(`
      INSERT INTO products (
        id, asin, sku, brand, title, image_url, marketplace, product_type,
        is_owned, market_node_id, source_type, created_at
      ) VALUES ('owned-2', 'B0PUBLIC03', 'SKU-02', 'Own', 'Second owned', '',
        'US', 'memory_foam_pillow', 1, 'market-1', 'import', '2026-09-01T00:00:00Z')
    `).run();
    const service = new SellerSpriteSyncService(database, fixturePort());
    await service.discoverCompetitors({ ownedProductId: 'owned-1' });
    const candidate = service.listCompetitorCandidates('owned-1')[0]!;

    expect(() => service.confirmCompetitorCandidate({
      ownedProductId: 'owned-1', candidateId: candidate.id,
      relationType: 'direct', reason: 'mistaken identity',
    })).toThrow(/自有产品/);
    expect(database.prepare(`SELECT is_owned, title, product_type FROM products WHERE id = 'owned-2'`).get())
      .toEqual({ is_owned: 1, title: 'Second owned', product_type: 'memory_foam_pillow' });
    expect(candidate.status).toBe('pending_review');
  });

  it('preserves curated metadata when confirming an already-known competitor', async () => {
    database = fixtureDatabase();
    database.prepare(`
      INSERT INTO products (
        id, asin, brand, title, image_url, marketplace, product_type,
        is_owned, market_node_id, source_type, parent_asin, created_at
      ) VALUES ('known-competitor', 'B0PUBLIC03', 'Curated Brand', 'Curated title', '',
        'US', 'premium_pillow', 0, 'market-1', 'import', 'B0MANUAL01', '2026-09-01T00:00:00Z')
    `).run();
    const service = new SellerSpriteSyncService(database, fixturePort());
    await service.discoverCompetitors({ ownedProductId: 'owned-1' });
    const candidate = service.listCompetitorCandidates('owned-1')[0]!;

    const confirmed = service.confirmCompetitorCandidate({
      ownedProductId: 'owned-1', candidateId: candidate.id,
      relationType: 'direct', reason: 'manual match',
    });

    expect(confirmed.competitorProductId).toBe('known-competitor');
    expect(database.prepare(`
      SELECT brand, title, product_type, source_type, parent_asin
      FROM products WHERE id = 'known-competitor'
    `).get()).toEqual({
      brand: 'Curated Brand', title: 'Curated title',
      product_type: 'premium_pillow', source_type: 'import', parent_asin: 'B0MANUAL01',
    });
  });

  it('keeps missing provider fields null in normalized facts', async () => {
    database = fixtureDatabase();
    const service = new SellerSpriteSyncService(database, fixturePort());

    await service.syncMarket({ marketId: 'market-1', month: '202608' });

    expect(database.prepare(`
      SELECT numeric_value AS value FROM metric_facts
      WHERE entity_type = 'market' AND entity_id = 'market-1'
        AND metric_name = 'new_product_share'
    `).get()).toEqual({ value: null });
  });

  it('selects the actual SellerSprite market fact over an alternate source', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchMarketResearchSummary() {
        return { data: { marketplace: 'US', nodeIdPath: NODE_PATH,
          totalProducts: 2, topProducts: 2, totalUnits: 30 }, provenance };
      },
      async fetchMarketStatistics() {
        return { data: { marketplace: 'US', nodeIdPath: NODE_PATH,
          products: 2 }, provenance };
      },
    });
    await new SellerSpriteSyncService(database, port)
      .syncMarket({ marketId: 'market-1', month: '202608' });
    database.prepare(`
      INSERT INTO metric_facts (
        id, entity_type, entity_id, marketplace, metric_name, numeric_value,
        source, source_id, source_type, is_estimated, confidence,
        observation_date, collected_at, dedup_key
      ) VALUES (
        'alternate', 'market', 'market-1', 'US', 'monthlySales', 99,
        'Amazon report', 'source-amazon-import', 'amazon', 0, 0.99,
        '2026-08-31', '2026-09-19T02:30:00Z', 'alternate-market-sales'
      )
    `).run();

    const selected = new MetricAuthorityResolver(database).resolveMetric({
      entityType: 'market', entityId: 'market-1', metric: 'monthly_sales',
      observationDate: '2026-08-31',
    });

    expect(selected.selected).toMatchObject({ sourceId: 'source-sellersprite-mcp', value: 30 });
    expect(selected.alternatives).toHaveLength(1);
  });

  it('makes persisted MCP facts resolvable by the authoritative read path', async () => {
    database = fixtureDatabase();
    const service = new SellerSpriteSyncService(database, fixturePort({
      async fetchMarketResearchSummary(input) {
        return { data: { marketplace: input.marketplace,
          nodeIdPath: input.nodeIdPath, totalProducts: 2 }, provenance };
      },
    }));
    await service.syncMarket({ marketId: 'market-1', month: '202608' });
    await service.syncOwnedProduct({ productId: 'owned-1' });
    const resolver = new MetricAuthorityResolver(database);
    const market = resolver.resolveMetric({ entityType: 'market', entityId: 'market-1',
      metric: 'product_count', observationDate: '2026-08-31' });
    const product = resolver.resolveMetric({ entityType: 'product', entityId: 'owned-1',
      metric: 'estimated_sales', observationDate: '2026-08-31' });
    expect(market.selected).toMatchObject({ sourceType: 'mcp', value: 2 });
    expect(product.selected).toMatchObject({ sourceType: 'mcp', value: 120 });
    expect(database.prepare(`SELECT metric_name FROM metric_facts WHERE id = ?`).get(market.selected!.id))
      .toEqual({ metric_name: 'product_count' });
    expect(database.prepare(`SELECT metric_name FROM metric_facts WHERE id = ?`).get(product.selected!.id))
      .toEqual({ metric_name: 'estimated_sales' });
  });

  it('does not assign one parent total to sibling child SKUs with missing child sales', async () => {
    database = fixtureDatabase();
    database.prepare(`
      INSERT INTO products (id, asin, sku, brand, title, image_url, marketplace,
        product_type, is_owned, market_node_id, source_type, created_at)
      VALUES ('owned-2', 'B0OWNED002', 'SKU-02', 'Owned', 'Second child', '',
        'US', 'pillow', 1, 'market-1', 'import', '2026-09-01T00:00:00Z')
    `).run();
    seedConfirmedOwnedRoster(database);
    const port = fixturePort({
      async fetchAsinSalesTrend(input) {
        return { data: { asin: { asin: input.asin, marketplace: input.marketplace,
          parent: 'B0PARENT01' }, salesTrendPoints: [
          { month: '2026-08', parentUnitSales: 600, parentSalesRevenue: 24_000,
            price: 40 },
        ] }, provenance };
      },
    });

    await new SellerSpriteSyncService(database, port).syncCriticalBatch({ marketId: 'market-1', month: '202608' });

    expect(database.prepare(`
      SELECT product_id, estimated_sales, estimated_revenue FROM product_snapshots
      ORDER BY product_id
    `).all()).toEqual([
      { product_id: 'owned-1', estimated_sales: null, estimated_revenue: null },
      { product_id: 'owned-2', estimated_sales: null, estimated_revenue: null },
    ]);
  });

  it('can use parent totals only when the requested ASIN itself is the parent', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchAsinSalesTrend(input) {
        return { data: { asin: { asin: input.asin, marketplace: input.marketplace,
          parent: input.asin }, salesTrendPoints: [
          { month: '2026-08', parentUnitSales: 600, parentSalesRevenue: 24_000 },
        ] }, provenance };
      },
    });

    await new SellerSpriteSyncService(database, port).syncOwnedProduct({ productId: 'owned-1' });

    expect(database.prepare(`
      SELECT estimated_sales, estimated_revenue FROM product_snapshots
      WHERE product_id = 'owned-1'
    `).get()).toEqual({ estimated_sales: 600, estimated_revenue: 24_000 });
  });

  it('rejects standalone owned sync when its market node is Mock or unmapped', async () => {
    database = fixtureDatabase();
    let calls = 0;
    const base = fixturePort();
    const port = fixturePort({
      async fetchAsinSalesTrend(input, context) {
        calls += 1;
        return base.fetchAsinSalesTrend(input, context);
      },
    });
    database.prepare(`UPDATE market_nodes SET source_type = 'mock' WHERE id = 'market-1'`).run();

    await expect(new SellerSpriteSyncService(database, port)
      .syncOwnedProduct({ productId: 'owned-1' })).rejects.toThrow(/自有产品|市场节点/);

    database.prepare(`UPDATE market_nodes SET source_type = 'import' WHERE id = 'market-1'`).run();
    database.exec('PRAGMA foreign_keys = OFF');
    database.prepare(`UPDATE products SET market_node_id = 'missing-market' WHERE id = 'owned-1'`).run();
    database.exec('PRAGMA foreign_keys = ON');
    await expect(new SellerSpriteSyncService(database, port)
      .syncOwnedProduct({ productId: 'owned-1' })).rejects.toThrow(/自有产品|市场节点/);

    expect(calls).toBe(0);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM data_tasks
      WHERE task_type <> 'file_import'`).get()).toEqual({ count: 0 });
  });

  it('rejects a critical run when an active real owned SKU is outside the main-market tree', async () => {
    database = fixtureDatabase();
    database.exec(`
      INSERT INTO market_nodes (
        id, name, parent_id, level, marketplace, category_id,
        sellersprite_confirmed_node_path, keywords_json, status, source_type, created_at
      ) VALUES ('other-market', 'Other', NULL, 1, 'US', '999', '999', '[]', 'active',
        'import', '2026-09-01T00:00:00Z');
      UPDATE products SET market_node_id = 'other-market' WHERE id = 'owned-1';
    `);
    let calls = 0;
    const base = fixturePort();
    const port = fixturePort({
      async fetchMarketStatistics(input, context) {
        calls += 1;
        return base.fetchMarketStatistics(input, context);
      },
    });

    await expect(new SellerSpriteSyncService(database, port)
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' }))
      .rejects.toThrow(/前置条件|主市场|范围/);

    expect(calls).toBe(0);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM data_tasks
      WHERE task_type = 'critical_sync'`).get()).toEqual({ count: 0 });
  });

  it('does not commit any critical observation when one owned ASIN fails', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchAsinSalesTrend() { throw new Error('remote trend unavailable'); },
    });
    const service = new SellerSpriteSyncService(database, port);

    await expect(service.syncCriticalBatch({ marketId: 'market-1', month: '202608' }))
      .rejects.toThrow('remote trend unavailable');

    expect(count('market_snapshots')).toBe(0);
    expect(count('product_snapshots')).toBe(0);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM metric_facts`).get()).toEqual({ count: 0 });
    const task = database.prepare(`
      SELECT id, sync_run_id, status, total, success, failed, error_log
      FROM data_tasks WHERE task_type = 'critical_sync'
    `).get() as Record<string, unknown>;
    expect(task).toMatchObject({ sync_run_id: task.id, status: 'failed', total: 2, failed: 1 });
    expect(String(task.error_log)).not.toContain('remote trend unavailable');
    expect(database.prepare(`
      SELECT id, is_complete FROM data_coverage_runs WHERE run_type = 'critical_sync'
    `).get()).toEqual({ id: task.id, is_complete: 0 });
  });

  it('records one successful run through scoped market and all active owned product observations', async () => {
    database = fixtureDatabase();
    const contexts: Array<string | undefined> = [];
    const base = fixturePort();
    const port = fixturePort({
      async fetchMarketStatistics(input, context) {
        contexts.push(context?.runId);
        return base.fetchMarketStatistics(input);
      },
      async fetchMarketConcentration(input, context) {
        contexts.push(context?.runId);
        return base.fetchMarketConcentration(input);
      },
      async fetchAsinSalesTrend(input, context) {
        contexts.push(context?.runId);
        return base.fetchAsinSalesTrend(input);
      },
    });

    const result = await new SellerSpriteSyncService(database, port)
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' });

    expect(result).toMatchObject({ taskId: result.runId, marketSnapshots: 2, productSnapshots: 2 });
    expect(result.runId).toMatch(/^[a-f0-9-]{36}$/i);
    expect(contexts).toEqual([
      result.runId, result.runId, result.runId, result.runId, result.runId,
    ]);
    expect(database.prepare(`
      SELECT id, sync_run_id, status, total, success, failed FROM data_tasks WHERE id = ?
    `).get(result.runId)).toEqual({
      id: result.runId, sync_run_id: result.runId, status: 'success', total: 2, success: 2, failed: 0,
    });
    expect(new IntelligenceRepository(database).getDataTask(result.runId))
      .toMatchObject({ id: result.runId, syncRunId: result.runId });
    const coverage = database.prepare(`
      SELECT coverage_json AS coverageJson, is_complete AS isComplete
      FROM data_coverage_runs WHERE id = ?
    `).get(result.runId) as { coverageJson: string; isComplete: number };
    expect(coverage.isComplete).toBe(1);
    expect(JSON.parse(coverage.coverageJson)).toMatchObject({
      marketId: 'market-1', nodeIdPath: NODE_PATH, month: '202608',
      ownedProducts: [{ id: 'owned-1', asin: 'B0OWNED001', marketNodeId: 'market-1' }],
    });
    for (const table of ['market_snapshots', 'product_snapshots', 'metric_facts'] as const) {
      const rows = database.prepare(`SELECT DISTINCT sync_run_id AS runId FROM ${table}`).all();
      expect(rows).toEqual([{ runId: result.runId }]);
    }
    expect(database.prepare(`
      SELECT snapshot_kind AS kind, entity_id AS entityId, disposition
      FROM mcp_sync_observation_links WHERE sync_run_id = ? AND snapshot_kind <> 'fact'
      ORDER BY kind, entityId
    `).all(result.runId)).toEqual([
      { kind: 'market', entityId: 'market-1', disposition: 'inserted' },
      { kind: 'market', entityId: 'market-1', disposition: 'inserted' },
      { kind: 'product', entityId: 'owned-1', disposition: 'inserted' },
      { kind: 'product', entityId: 'owned-1', disposition: 'inserted' },
    ]);
  });

  it('captures the current and comparable baseline market months in one critical run', async () => {
    database = fixtureDatabase();
    const requests: Array<{ capability: string; month: string | undefined; runId: string | undefined }> = [];
    const base = fixturePort();
    const port = fixturePort({
      async fetchMarketResearchSummary(input, context) {
        requests.push({ capability: 'research', month: input.month, runId: context?.runId });
        const current = input.month === '202608';
        return {
          data: {
            marketplace: input.marketplace, nodeIdPath: input.nodeIdPath, month: input.month,
            totalProducts: 2, topProducts: 2,
            totalUnits: current ? 1_200 : 1_000,
            totalRevenue: current ? 48_000 : 40_000,
            top10ProductCrn: 25, top20ProductCrn: 40,
          },
          provenance,
        };
      },
      async fetchMarketStatistics(input, context) {
        requests.push({ capability: 'statistics', month: input.month, runId: context?.runId });
        const current = input.month === '202608';
        return {
          data: {
            marketplace: input.marketplace, nodeIdPath: input.nodeIdPath, month: input.month,
            products: current ? 120 : 100, brands: 20, sellers: 30,
            totalUnits: current ? 1_200 : 1_000,
            totalRevenue: current ? 48_000 : 40_000,
            avgPrice: 40, medianPrice: 39, avgRating: 4.4, medianReviews: 100,
            top10Share: 25, top20Share: 40, newProductShare: 10,
          },
          provenance,
        };
      },
      async fetchMarketConcentration(input, context) {
        requests.push({ capability: 'concentration', month: input.month, runId: context?.runId });
        return base.fetchMarketConcentration(input, context);
      },
    });

    const result = await new SellerSpriteSyncService(database, port)
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' });

    expect(result.marketSnapshots).toBe(2);
    expect(requests.map(({ capability, month }) => ({ capability, month }))).toEqual([
      { capability: 'research', month: '202608' },
      { capability: 'statistics', month: '202608' },
      { capability: 'concentration', month: '202608' },
      { capability: 'research', month: '202607' },
      { capability: 'statistics', month: '202607' },
      { capability: 'concentration', month: '202607' },
    ]);
    expect(requests.every((request) => request.runId === result.runId)).toBe(true);
    expect(database.prepare(`
      SELECT observation_date AS observationDate, monthly_sales AS monthlySales,
        sync_run_id AS runId
      FROM market_snapshots ORDER BY observation_date
    `).all()).toEqual([
      { observationDate: '2026-07-31', monthlySales: 1_000, runId: result.runId },
      { observationDate: '2026-08-31', monthlySales: 1_200, runId: result.runId },
    ]);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM mcp_sync_observation_links
      WHERE sync_run_id = ? AND snapshot_kind = 'market' AND entity_id = 'market-1'
    `).get(result.runId)).toEqual({ count: 2 });
    const coverage = database.prepare(`
      SELECT coverage_json AS coverageJson FROM data_coverage_runs WHERE id = ?
    `).get(result.runId) as { coverageJson: string };
    expect(JSON.parse(coverage.coverageJson)).toMatchObject({
      month: '202608', baselineMonth: '202607', marketMonths: ['202607', '202608'],
    });
  });

  it.each([
    ['uses a finite alias after a non-finite canonical share', Infinity, 12.5, 12.5],
    ['keeps the share null when canonical and alias are both non-finite', Number.NaN, Infinity, null],
  ])('%s during a critical batch', async (
    _scenario, newProductShare, newProductProportion, expectedShare,
  ) => {
    database = fixtureDatabase();
    const base = fixturePort();
    const port = fixturePort({
      async fetchMarketStatistics(input) {
        return {
          data: {
            marketplace: input.marketplace, nodeIdPath: input.nodeIdPath, month: input.month,
            products: 100, avgPrice: 40, newProductShare, newProductProportion,
          },
          provenance,
        };
      },
      async fetchMarketConcentration(input, context) {
        return base.fetchMarketConcentration(input, context);
      },
    });

    await new SellerSpriteSyncService(database, port)
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' });

    expect(database.prepare(`SELECT observation_date AS observationDate,
      new_product_share AS newProductShare FROM market_snapshots
      WHERE market_node_id = 'market-1' ORDER BY observation_date`).all()).toEqual([
      { observationDate: '2026-07-31', newProductShare: expectedShare },
      { observationDate: '2026-08-31', newProductShare: expectedShare },
    ]);
  });

  it('captures the root and each distinct owned child market within one critical run', async () => {
    database = fixtureDatabase();
    database.exec(`
      INSERT INTO market_nodes (
        id, name, parent_id, level, marketplace, category_id,
        sellersprite_confirmed_node_path, status, source_type, created_at
      ) VALUES ('child-market', 'Child pillows', 'market-1', 2, 'US',
        '1055398:1063252:1199122:10671043011:999',
        '1055398:1063252:1199122:10671043011:999', 'active', 'import', '2026-09-01');
      INSERT INTO products (
        id, asin, sku, brand, title, image_url, marketplace, product_type,
        is_owned, market_node_id, source_type, created_at
      ) VALUES ('owned-child', 'B0OWNED002', 'SKU-02', 'Owned', 'Child Pillow', '', 'US',
        'memory_foam_pillow', 1, 'child-market', 'import', '2026-09-01');
    `);
    seedConfirmedOwnedRoster(database);
    const requests: Array<{ path: string; month: string | undefined; runId: string | undefined }> = [];
    const port = fixturePort({
      async fetchMarketResearchSummary(input, context) {
        requests.push({ path: input.nodeIdPath, month: input.month, runId: context?.runId });
        return { data: {
          marketplace: input.marketplace, nodeIdPath: input.nodeIdPath, month: input.month,
          totalProducts: 20, totalUnits: input.month === '202608' ? 120 : 100,
        }, provenance };
      },
      async fetchMarketStatistics(input, context) {
        requests.push({ path: input.nodeIdPath, month: input.month, runId: context?.runId });
        return { data: {
          marketplace: input.marketplace, nodeIdPath: input.nodeIdPath, month: input.month,
          products: 20, totalUnits: input.month === '202608' ? 120 : 100,
        }, provenance };
      },
      async fetchMarketConcentration(input, context) {
        requests.push({ path: input.nodeIdPath, month: input.month, runId: context?.runId });
        return { data: [], provenance };
      },
    });

    const result = await new SellerSpriteSyncService(database, port)
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' });
    const childPath = `${NODE_PATH}:999`;
    const scopes = [NODE_PATH, childPath].flatMap((path) => ['202607', '202608']
      .map((month) => `${path}/${month}`));
    expect(result).toMatchObject({ marketSnapshots: 4, productSnapshots: 4 });
    expect(requests).toHaveLength(12);
    expect(requests.map((item) => `${item.path}/${item.month}`).sort())
      .toEqual([...scopes, ...scopes, ...scopes].sort());
    expect(requests.every((item) => item.runId === result.runId)).toBe(true);
    expect(database.prepare(`SELECT total, success, failed FROM data_tasks WHERE id = ?`)
      .get(result.runId)).toEqual({ total: 4, success: 4, failed: 0 });
    expect(database.prepare(`
      SELECT entity_id AS entityId, COUNT(*) AS count
      FROM mcp_sync_observation_links WHERE sync_run_id = ? AND snapshot_kind = 'market'
      GROUP BY entity_id ORDER BY entity_id
    `).all(result.runId)).toEqual([
      { entityId: 'child-market', count: 2 }, { entityId: 'market-1', count: 2 },
    ]);
    const coverage = database.prepare(`SELECT coverage_json AS coverageJson
      FROM data_coverage_runs WHERE id = ?`).get(result.runId) as { coverageJson: string };
    expect(JSON.parse(coverage.coverageJson)).toMatchObject({
      marketNodes: [
        { id: 'market-1', nodeIdPath: NODE_PATH },
        { id: 'child-market', nodeIdPath: childPath },
      ],
    });
    expect(proveDashboardRunReadPath(database, {
      runId: result.runId,
      marketId: 'market-1',
      ownedProductIds: ['owned-1', 'owned-child'],
    })).toEqual({
      passed: true,
      marketVerified: true,
      verifiedOwnedProducts: 2,
      requiredOwnedProducts: 2,
    });
  });

  it('does not commit root observations when a required child market fails', async () => {
    database = fixtureDatabase();
    database.exec(`
      INSERT INTO market_nodes (
        id, name, parent_id, level, marketplace, category_id,
        sellersprite_confirmed_node_path, status, source_type, created_at
      ) VALUES ('child-market', 'Child pillows', 'market-1', 2, 'US',
        '1055398:1063252:1199122:10671043011:999',
        '1055398:1063252:1199122:10671043011:999', 'active', 'import', '2026-09-01');
      UPDATE products SET market_node_id = 'child-market' WHERE id = 'owned-1';
    `);
    const base = fixturePort();
    const port = fixturePort({
      async fetchMarketStatistics(input, context) {
        if (input.nodeIdPath.endsWith(':999')) throw new Error('secret-key=child-private');
        return base.fetchMarketStatistics(input, context);
      },
    });

    await expect(new SellerSpriteSyncService(database, port)
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' }))
      .rejects.not.toThrow(/child-private/);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM market_snapshots`).get())
      .toEqual({ count: 0 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM product_snapshots`).get())
      .toEqual({ count: 0 });
    expect(database.prepare(`SELECT status, total, failed FROM data_tasks
      WHERE task_type = 'critical_sync'`).get()).toEqual({ status: 'failed', total: 3, failed: 1 });
  });

  it('rejects a child market path changed during a critical run', async () => {
    database = fixtureDatabase();
    database.exec(`
      INSERT INTO market_nodes (
        id, name, parent_id, level, marketplace, category_id,
        sellersprite_confirmed_node_path, status, source_type, created_at
      ) VALUES ('child-market', 'Child pillows', 'market-1', 2, 'US',
        '1055398:1063252:1199122:10671043011:999',
        '1055398:1063252:1199122:10671043011:999', 'active', 'import', '2026-09-01');
      UPDATE products SET market_node_id = 'child-market' WHERE id = 'owned-1';
    `);
    const base = fixturePort();
    const port = fixturePort({
      async fetchMarketStatistics(input) {
        return { data: {
          marketplace: input.marketplace, nodeIdPath: input.nodeIdPath,
          month: input.month, products: 20, totalUnits: 100, avgPrice: 40,
        }, provenance };
      },
      async fetchMarketConcentration() { return { data: [], provenance }; },
      async fetchAsinSalesTrend(input, context) {
        database!.prepare(`UPDATE market_nodes SET category_id = ?,
          sellersprite_confirmed_node_path = ? WHERE id = 'child-market'`)
          .run(`${NODE_PATH}:888`, `${NODE_PATH}:888`);
        return base.fetchAsinSalesTrend(input, context);
      },
    });

    await expect(new SellerSpriteSyncService(database, port)
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' }))
      .rejects.toThrow(/范围发生变化/);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM market_snapshots`).get())
      .toEqual({ count: 0 });
    expect(database.prepare(`SELECT status FROM data_tasks WHERE task_type = 'critical_sync'`).get())
      .toEqual({ status: 'failed' });
  });

  it('keeps the critical run incomplete until both secondary coverage stages are recorded', async () => {
    database = fixtureDatabase();
    const base = fixturePort();
    const states: Array<{ status: string; isComplete: number }> = [];
    const port = fixturePort({
      async discoverAsinCompetitors(input, context) {
        states.push(database!.prepare(`
          SELECT task.status, coverage.is_complete AS isComplete
          FROM data_tasks task
          JOIN data_coverage_runs coverage ON coverage.id = task.id
          WHERE task.id = ? AND task.sync_run_id = task.id
        `).get(context?.runId ?? null) as { status: string; isComplete: number });
        return base.discoverAsinCompetitors(input, context);
      },
    });

    const result = await new SellerSpriteSyncService(database, port)
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' });

    expect(states).toEqual([{ status: 'running', isComplete: 0 }]);
    expect(database.prepare(`
      SELECT task.status, coverage.is_complete AS isComplete
      FROM data_tasks task JOIN data_coverage_runs coverage ON coverage.id = task.id
      WHERE task.id = ?
    `).get(result.runId)).toEqual({ status: 'success', isComplete: 1 });
  });

  it('does not send retained Demo-owned masters to the real critical MCP run', async () => {
    database = fixtureDatabase();
    database.prepare(`
      INSERT INTO products (id, asin, sku, brand, title, image_url, marketplace,
        product_type, is_owned, market_node_id, source_type, created_at)
      VALUES ('demo-owned', 'B0DEMO0001', 'DEMO-01', 'Demo', 'Demo Pillow', '', 'US',
        'memory_foam_pillow', 1, 'market-1', 'mock', '2026-09-01T00:00:00Z')
    `).run();
    const called: string[] = [];
    const base = fixturePort();
    const port = fixturePort({
      async fetchAsinSalesTrend(input) {
        called.push(input.asin);
        return base.fetchAsinSalesTrend(input);
      },
    });

    const result = await new SellerSpriteSyncService(database, port)
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' });

    expect(called).toEqual(['B0OWNED001']);
    expect(result.productSnapshots).toBe(2);
    expect(database.prepare(`SELECT coverage_json AS coverage FROM data_coverage_runs WHERE id = ?`)
      .get(result.runId)).toEqual({ coverage: expect.not.stringContaining('demo-owned') });
  });

  it('does not certify a roster changed during an in-flight critical run', async () => {
    database = fixtureDatabase();
    const base = fixturePort();
    const port = fixturePort({
      async fetchAsinSalesTrend(input) {
        database!.prepare(`
          INSERT INTO products (id, asin, sku, brand, title, image_url, marketplace,
            product_type, is_owned, market_node_id, source_type, created_at)
          VALUES ('owned-2', 'B0OWNED002', 'SKU-02', 'Owned', 'New owned', '', 'US',
            'memory_foam_pillow', 1, 'market-1', 'import', '2026-09-01T00:00:00Z')
        `).run();
        return base.fetchAsinSalesTrend(input);
      },
    });

    await expect(new SellerSpriteSyncService(database, port)
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' }))
      .rejects.toThrow(/自有|范围|变化/);
    expect(count('market_snapshots')).toBe(0);
    expect(count('product_snapshots')).toBe(0);
    expect(database.prepare(`SELECT status FROM data_tasks WHERE task_type = 'critical_sync'`).get())
      .toEqual({ status: 'failed' });
  });

  it('links identical immutable observations to a new run without rewriting their origin', async () => {
    database = fixtureDatabase();
    const service = new SellerSpriteSyncService(database, fixturePort());
    const first = await service.syncCriticalBatch({ marketId: 'market-1', month: '202608' });
    const second = await service.syncCriticalBatch({ marketId: 'market-1', month: '202608' });

    expect(second.runId).not.toBe(first.runId);
    expect(second).toMatchObject({ marketSnapshots: 0, productSnapshots: 0 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM market_snapshots`).get()).toEqual({ count: 2 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM product_snapshots`).get()).toEqual({ count: 2 });
    expect(database.prepare(`
      SELECT DISTINCT sync_run_id AS runId FROM product_snapshots
    `).all()).toEqual([{ runId: first.runId }]);
    expect(database.prepare(`
      SELECT snapshot_kind AS kind, disposition FROM mcp_sync_observation_links
      WHERE sync_run_id = ? AND snapshot_kind <> 'fact' ORDER BY kind, snapshot_id
    `).all(second.runId)).toEqual([
      { kind: 'market', disposition: 'reused' },
      { kind: 'market', disposition: 'reused' },
      { kind: 'product', disposition: 'reused' },
      { kind: 'product', disposition: 'reused' },
    ]);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM mcp_sync_observation_links
      WHERE sync_run_id = ? AND snapshot_kind = 'fact'
    `).get(second.runId)).toEqual({ count: 38 });
    expect(database.prepare(`SELECT status FROM data_tasks WHERE id = ?`).get(second.runId))
      .toEqual({ status: 'success' });
  });

  it('rejects revised same-period values rather than certifying a reused observation', async () => {
    database = fixtureDatabase();
    await new SellerSpriteSyncService(database, fixturePort())
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' });
    const changed = fixturePort({
      async fetchMarketStatistics() {
        return { data: { marketplace: 'US', nodeIdPath: NODE_PATH, products: 2,
          brands: 3, sellers: 2, avgPrice: 40, avgRating: 4.4 }, provenance };
      },
    });

    await expect(new SellerSpriteSyncService(database, changed)
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' }))
      .rejects.toThrow(/不可变观察|不一致/);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM market_snapshots`).get()).toEqual({ count: 2 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM product_snapshots`).get()).toEqual({ count: 2 });
    expect(database.prepare(`
      SELECT status, sync_run_id AS runId FROM data_tasks WHERE task_type = 'critical_sync'
      ORDER BY created_at DESC
    `).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'failed' }), expect.objectContaining({ status: 'success' }),
    ]));
    expect(database.prepare(`SELECT COUNT(*) AS count FROM mcp_sync_observation_links
      WHERE snapshot_kind <> 'fact'`).get())
      .toEqual({ count: 4 });
  });

  it('keeps the last legal real observations and marks Live partially unrefreshed after failure', async () => {
    database = fixtureDatabase();
    const base = fixturePort();
    const healthy = fixturePort({
      async fetchMarketResearchSummary(input, context) {
        const result = await base.fetchMarketResearchSummary(input, context);
        return { ...result, data: { ...result.data,
          totalProducts: 2, topProducts: 2, totalUnits: 450 } };
      },
    });
    await new SellerSpriteSyncService(database, healthy)
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' });
    const before = database.prepare(`
      SELECT id, monthly_sales AS sales FROM market_snapshots WHERE market_node_id = 'market-1'
    `).get();
    const productBefore = database.prepare(`
      SELECT id, estimated_sales AS sales FROM product_snapshots
      WHERE product_id = 'owned-1' AND date = '2026-08-31'
    `).get();
    const failed = fixturePort({
      async fetchAsinSalesTrend() { throw new Error('secret-key=never-store-this'); },
    });

    const exposedFailure = await new SellerSpriteSyncService(database, failed)
      .syncCriticalBatch({ marketId: 'market-1', month: '202609' })
      .then(() => '', (error: unknown) => error instanceof Error ? error.message : String(error));
    expect(exposedFailure).not.toContain('never-store-this');
    expect(exposedFailure).toContain('[REDACTED]');

    expect(database.prepare(`
      SELECT id, monthly_sales AS sales FROM market_snapshots WHERE market_node_id = 'market-1'
    `).get()).toEqual(before);
    expect(database.prepare(`
      SELECT id, estimated_sales AS sales FROM product_snapshots
      WHERE product_id = 'owned-1' AND date = '2026-08-31'
    `).get()).toEqual(productBefore);
    expect(database.prepare(`SELECT error_log FROM data_tasks WHERE status = 'failed'`).get())
      .not.toEqual(expect.objectContaining({ error_log: expect.stringContaining('never-store-this') }));
    const freshness = new DashboardFreshnessService(database).getStatus({
      marketplace: 'US', mode: 'live', marketId: 'market-1',
      ownedProductIds: ['owned-1'], competitorProductIds: [],
    });
    expect(freshness.coreBusinessFreshness).toMatchObject({
      status: 'partial', label: '部分未更新',
      message: expect.stringContaining('上一次合法快照'),
    });
    expect(freshness.systemSyncStatus.status).toBe('failed');
  });

  it('records partial secondary direct-competitor coverage without failing the critical run', async () => {
    database = fixtureDatabase();
    database.exec(`
      INSERT INTO products (id, asin, brand, title, image_url, marketplace, product_type,
        is_owned, market_node_id, status, source_type, created_at) VALUES
        ('competitor-1', 'B0DIRECT01', 'One', 'Direct One', '', 'US', 'competitor',
          0, 'market-1', 'active', 'import', '2026-09-01T00:00:00Z'),
        ('competitor-2', 'B0DIRECT02', 'Two', 'Direct Two', '', 'US', 'competitor',
          0, 'market-1', 'active', 'import', '2026-09-01T00:00:00Z');
      INSERT INTO competitor_relations (id, owned_product_id, competitor_product_id,
        relation_type, similarity_score, reason, ai_tags_json) VALUES
        ('direct-1', 'owned-1', 'competitor-1', 'direct', 90, '人工确认', '[]'),
        ('direct-2', 'owned-1', 'competitor-2', 'direct', 85, '人工确认', '[]');
    `);
    const base = fixturePort();
    const port = fixturePort({
      async fetchAsinSalesTrend(input, context) {
        if (input.asin === 'B0DIRECT02') throw new Error('remote competitor failure token=private');
        return base.fetchAsinSalesTrend(input, context);
      },
    });

    const result = await new SellerSpriteSyncService(database, port)
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' });

    expect(result.competitorCoverage).toMatchObject({
      status: 'partial', total: 2, success: 1, failed: 1,
    });
    expect(database.prepare(`SELECT status FROM data_tasks WHERE id = ?`).get(result.runId))
      .toEqual({ status: 'success' });
    expect(database.prepare(`
      SELECT sync_run_id AS runId, status, total, success, failed, error_log AS errorLog
      FROM data_tasks WHERE task_type = 'competitor_refresh'
    `).get()).toMatchObject({
      runId: result.runId, status: 'partial', total: 2, success: 1, failed: 1,
      errorLog: expect.not.stringContaining('private'),
    });
    expect(database.prepare(`
      SELECT product_id AS productId, sync_run_id AS runId FROM product_snapshots
      WHERE product_id LIKE 'competitor-%' ORDER BY product_id
    `).all()).toEqual([
      { productId: 'competitor-1', runId: result.runId },
      { productId: 'competitor-1', runId: result.runId },
    ]);
    expect(JSON.parse((database.prepare(`
      SELECT coverage_json AS coverage FROM data_coverage_runs WHERE id = ?
    `).get(result.runId) as { coverage: string }).coverage).secondaryCompetitors).toMatchObject({
      status: 'partial', total: 2, success: 1, failed: 1,
    });
  });

  it('rejects a direct competitor whose identity changes during its remote refresh', async () => {
    database = fixtureDatabase();
    database.exec(`
      INSERT INTO products (id, asin, brand, title, image_url, marketplace, product_type,
        is_owned, market_node_id, status, source_type, created_at)
      VALUES ('competitor-1', 'B0DIRECT01', 'One', 'Direct One', '', 'US', 'competitor',
        0, 'market-1', 'active', 'import', '2026-09-01T00:00:00Z');
      INSERT INTO competitor_relations (id, owned_product_id, competitor_product_id,
        relation_type, similarity_score, reason, ai_tags_json)
      VALUES ('direct-1', 'owned-1', 'competitor-1', 'direct', 90, '人工确认', '[]');
    `);
    const base = fixturePort();
    const port = fixturePort({
      async fetchAsinSalesTrend(input, context) {
        if (input.asin === 'B0DIRECT01') {
          database!.prepare(`UPDATE products SET asin = 'B0DIRECT99' WHERE id = 'competitor-1'`).run();
        }
        return base.fetchAsinSalesTrend(input, context);
      },
    });

    const result = await new SellerSpriteSyncService(database, port)
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' });

    expect(result.competitorCoverage).toMatchObject({ status: 'failed', total: 1, failed: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE product_id = 'competitor-1'
    `).get()).toEqual({ count: 0 });
  });

  it('records an empty successful secondary batch when no core competitor is confirmed', async () => {
    database = fixtureDatabase();

    const result = await new SellerSpriteSyncService(database, fixturePort())
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' });

    expect(result.competitorCoverage).toMatchObject({
      status: 'success', total: 0, success: 0, failed: 0,
    });
    expect(database.prepare(`
      SELECT sync_run_id AS runId, status, total FROM data_tasks WHERE task_type = 'competitor_refresh'
    `).get()).toEqual({ runId: result.runId, status: 'success', total: 0 });
  });

  it('discovers review-only competitor candidates under the same run without blocking critical success', async () => {
    database = fixtureDatabase();
    let discoveryRunId: string | undefined;
    const base = fixturePort();
    const port = fixturePort({
      async discoverAsinCompetitors(input, context) {
        discoveryRunId = context?.runId;
        return base.discoverAsinCompetitors(input);
      },
    });

    const service = new SellerSpriteSyncService(database, port);
    const result = await service
      .syncCriticalBatch({ marketId: 'market-1', month: '202608' });

    expect(discoveryRunId).toBe(result.runId);
    expect(result.candidateCoverage).toMatchObject({
      status: 'success', total: 1, success: 1, failed: 0, candidates: 1,
    });
    expect(database.prepare(`
      SELECT sync_run_id AS runId, status, total, success, failed
      FROM data_tasks WHERE task_type = 'competitor_discovery'
    `).get()).toEqual({
      runId: result.runId, status: 'success', total: 1, success: 1, failed: 0,
    });
    const candidate = database.prepare(`
      SELECT id, status, sync_run_id AS originRunId FROM competitor_candidates
    `).get() as { id: string; status: string; originRunId: string };
    expect(candidate).toMatchObject({ status: 'pending_review', originRunId: result.runId });
    expect(database.prepare(`
      SELECT sync_run_id AS runId, disposition FROM competitor_candidate_run_links
      WHERE candidate_id = ?
    `).all(candidate.id)).toEqual([{ runId: result.runId, disposition: 'inserted' }]);

    const repeated = await service.syncCriticalBatch({ marketId: 'market-1', month: '202608' });

    expect(repeated.candidateCoverage.candidates).toBe(1);
    expect(database.prepare(`
      SELECT sync_run_id AS runId, disposition FROM competitor_candidate_run_links
      WHERE candidate_id = ? ORDER BY sync_run_id
    `).all(candidate.id)).toEqual(expect.arrayContaining([
      { runId: result.runId, disposition: 'inserted' },
      { runId: repeated.runId, disposition: 'reused' },
    ]));
  });
});
