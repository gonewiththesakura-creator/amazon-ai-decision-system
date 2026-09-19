import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { SellerSpriteSyncService, type SellerSpriteSyncPort } from './sellersprite-sync-service.js';
import { MetricAuthorityResolver } from './metric-authority-resolver.js';

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
      id, name, parent_id, level, marketplace, category_id, keywords_json, status,
      source_type, created_at
    ) VALUES (
      'market-1', 'Bed Pillows', NULL, 1, 'US', '1055398:1063252:1199122:10671043011', '["memory foam pillow"]',
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
  it('requires an explicit SellerSprite category path before market sync', async () => {
    database = fixtureDatabase();
    database.prepare(`UPDATE market_nodes SET category_id = NULL WHERE id = 'market-1'`).run();
    await expect(new SellerSpriteSyncService(database, fixturePort())
      .syncMarket({ marketId: 'market-1', month: '202608' }))
      .rejects.toThrow(/category|节点路径|映射/i);
    expect(count('market_snapshots')).toBe(0);
  });
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
      monthly_sales: null, monthly_revenue: null, median_reviews: null,
    });
  });

  it('does not turn an incomplete concentration cohort into total market sales', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
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

  it('accepts direct provider market metrics without promoting a partial product sample', async () => {
    database = fixtureDatabase();
    const port = fixturePort({
      async fetchMarketStatistics() {
        return { data: { marketplace: 'US', nodeIdPath: NODE_PATH, month: '2026-08',
          products: 100, totalUnits: 12000, medianPrice: 42,
          medianReviews: 300, top10Share: 18.5 }, provenance };
      },
    });

    await new SellerSpriteSyncService(database, port).syncMarket({ marketId: 'market-1', month: '202608' });

    expect(database.prepare(`
      SELECT monthly_sales, median_price, median_reviews, top10_share, top20_share
      FROM market_snapshots WHERE market_node_id = 'market-1'
    `).get()).toEqual({
      monthly_sales: 12000, median_price: 42, median_reviews: 300,
      top10_share: 18.5, top20_share: null,
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
      async fetchMarketStatistics() {
        return { data: { marketplace: 'US', nodeIdPath: NODE_PATH }, provenance };
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

  it('does not append another MCP observation over a legacy key for the same source and period', async () => {
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

    expect((await service.syncMarket({ marketId: 'market-1', month: '202608' })).inserted).toBe(0);
    expect((await service.syncOwnedProduct({ productId: 'owned-1' })).inserted).toBe(1);
    expect(count('market_snapshots')).toBe(1);
    expect(count('product_snapshots')).toBe(2);
    expect(database.prepare(`SELECT product_count FROM market_snapshots WHERE id = 'legacy-market'`).get())
      .toEqual({ product_count: 88 });
    expect(database.prepare(`SELECT estimated_sales FROM product_snapshots WHERE id = 'legacy-product'`).get())
      .toEqual({ estimated_sales: 99 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM metric_facts
      WHERE entity_type = 'market' AND observation_date = '2026-08-31'`).get())
      .toEqual({ count: 0 });
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
      WHERE entity_type = 'product' AND entity_id = ? AND metric_name = 'estimated_sales'
      ORDER BY observation_date
    `).all(competitorProductId)).toEqual([
      { metric_name: 'estimated_sales', numeric_value: 100, source_type: 'mcp' },
      { metric_name: 'estimated_sales', numeric_value: 120, source_type: 'mcp' },
    ]);
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
      async fetchMarketStatistics() {
        return { data: { marketplace: 'US', nodeIdPath: NODE_PATH,
          products: 2, totalUnits: 30 }, provenance };
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
    const service = new SellerSpriteSyncService(database, fixturePort());
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
