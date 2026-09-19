import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { SellerSpriteSyncService, type SellerSpriteSyncPort } from './sellersprite-sync-service.js';

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

function fixturePort(overrides: Partial<SellerSpriteSyncPort> = {}): SellerSpriteSyncPort {
  return {
    async fetchMarketStatistics() {
      return {
        data: {
          marketplace: 'US', nodeIdPath: 'bed-pillows', products: 2, brands: 2,
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
      id, name, parent_id, level, marketplace, category_id, keywords_json, status,
      source_type, created_at
    ) VALUES (
      'market-1', 'Bed Pillows', NULL, 1, 'US', 'bed-pillows', '["memory foam pillow"]',
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
  return connection;
}

function count(table: 'market_snapshots' | 'product_snapshots' | 'competitor_candidates'): number {
  return (database!.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe('SellerSprite real-data sync', () => {
  it('persists a market observation with real source and nullable missing metrics', async () => {
    database = fixtureDatabase();
    const service = new SellerSpriteSyncService(database, fixturePort());

    const result = await service.syncMarket({ marketId: 'market-1', month: '202608' });

    expect(result.inserted).toBe(1);
    expect(database.prepare(`
      SELECT observation_date, date, collected_at, source_type, monthly_sales,
        monthly_revenue, median_reviews
      FROM market_snapshots WHERE market_node_id = 'market-1'
    `).get()).toMatchObject({
      observation_date: '2026-08-31', date: '2026-08-31',
      collected_at: provenance.collectedAt, source_type: 'mcp',
      monthly_sales: 30, monthly_revenue: 1300, median_reviews: 75,
    });
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
        estimated_revenue: 4000, bsr: null, review_count: 90 },
      { observation_date: '2026-08-31', date: '2026-08-31',
        collected_at: provenance.collectedAt, estimated_sales: 120,
        estimated_revenue: 5040, bsr: null, review_count: 90 },
    ]);
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
  });

  it('keeps missing provider fields null in normalized facts', async () => {
    database = fixtureDatabase();
    const service = new SellerSpriteSyncService(database, fixturePort());

    await service.syncMarket({ marketId: 'market-1', month: '202608' });

    expect(database.prepare(`
      SELECT numeric_value AS value FROM metric_facts
      WHERE entity_type = 'market' AND entity_id = 'market-1'
        AND metric_name = 'newProductShare'
    `).get()).toEqual({ value: null });
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
  });
});
