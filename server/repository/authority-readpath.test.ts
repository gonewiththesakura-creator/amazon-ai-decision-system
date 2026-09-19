import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { DeterministicAIService } from '../services/ai-service.js';
import { ExecutiveDashboardService } from '../services/executive-dashboard-service.js';
import { MetricAuthorityResolver } from '../services/metric-authority-resolver.js';
import { IntelligenceRepository } from './intelligence-repository.js';
import { WorkflowRepository } from './workflow-repository.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function openFixture(): { db: AppDatabase; repository: IntelligenceRepository } {
  const db = openDatabase(':memory:');
  database = db;
  db.prepare(`
    INSERT INTO market_nodes (
      id, name, level, marketplace, status, source_type, created_at,
      competition_score, opportunity_score
    ) VALUES (
      'market-us', 'Memory foam pillows', 1, 'US', 'active', 'import', '2026-09-19T00:00:00Z', 20, 60
    )
  `).run();
  db.prepare(`UPDATE app_settings SET default_market_id = 'market-us', mode = 'live' WHERE id = 1`).run();
  return { db, repository: new IntelligenceRepository(db) };
}

function addMarketSnapshot(
  db: AppDatabase, id: string, date: string, source: string, sourceType: string,
  collectedAt: string, sales: number | null, revenue: number | null, price: number | null,
): void {
  db.prepare(`
    INSERT INTO market_snapshots (
      id, market_node_id, date, monthly_sales, monthly_revenue, avg_price,
      product_count, seller_count, top20_share, source, source_type,
      collected_at, period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES (?, 'market-us', ?, ?, ?, ?, 500, 30, 20, ?, ?, ?, '30D', 1, 0.9, ?, ?)
  `).run(id, date, sales, revenue, price, source, sourceType, collectedAt, date, id);
}

function addProduct(db: AppDatabase): void {
  db.prepare(`
    INSERT INTO products (
      id, asin, sku, brand, title, image_url, marketplace, product_type,
      is_owned, market_node_id, source_type, created_at
    ) VALUES (
      'owned-sku', 'B0AUTH0001', 'AUTH-1', 'Brand', 'Memory foam pillow', '', 'US', 'pillow',
      1, 'market-us', 'import', '2026-09-19T00:00:00Z'
    )
  `).run();
}

function addProductSnapshot(
  db: AppDatabase, id: string, date: string, source: string, sourceType: string,
  collectedAt: string, estimated: boolean, sales: number | null, revenue: number | null,
): void {
  db.prepare(`
    INSERT INTO product_snapshots (
      id, product_id, date, price, rating, review_count, bsr, estimated_sales,
      estimated_revenue, seller_count, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES (?, 'owned-sku', ?, 40, 4.4, 300, 100, ?, ?, 1, ?, ?, ?, '30D', ?, 0.9, ?, ?)
  `).run(id, date, sales, revenue, source, sourceType, collectedAt, estimated ? 1 : 0, date, id);
}

function addFact(
  db: AppDatabase, id: string, entityType: 'product' | 'market', entityId: string,
  metric: string, value: number | null, source: string, sourceId: string,
  sourceType: string, estimated: boolean, date = '2026-09-18',
): void {
  db.prepare(`
    INSERT INTO metric_facts (
      id, entity_type, entity_id, marketplace, metric_name, numeric_value,
      source, source_id, source_type, is_estimated, confidence,
      observation_date, collected_at, dedup_key
    ) VALUES (?, ?, ?, 'US', ?, ?, ?, ?, ?, ?, 0.9, ?, '2026-09-18T08:00:00Z', ?)
  `).run(id, entityType, entityId, metric, value, source, sourceId, sourceType, estimated ? 1 : 0, date, id);
}

describe('read-time metric authority', () => {
  it('coalesces market dates and uses MCP values despite a later import, including dashboard and candidate Evidence', () => {
    const { db, repository } = openFixture();
    addMarketSnapshot(db, 'market-old', '2026-08-19', 'SellerSprite Import', 'import',
      '2026-08-20T08:00:00Z', 100, 5_000, 35);
    addMarketSnapshot(db, 'market-mcp', '2026-09-18', 'SellerSprite MCP', 'mcp',
      '2026-09-18T08:00:00Z', 200, null, 40);
    addMarketSnapshot(db, 'market-import', '2026-09-18', 'SellerSprite Import', 'import',
      '2026-09-19T08:00:00Z', 900, 18_000, 99);
    addFact(db, 'market-mcp-sales', 'market', 'market-us', 'monthly_sales', 210,
      'SellerSprite MCP', 'sellersprite_mcp', 'mcp', true);
    addProduct(db);
    addProductSnapshot(db, 'sku-old', '2026-08-19', 'Amazon Report CSV', 'amazon',
      '2026-08-20T08:00:00Z', false, 100, 4_000);
    addProductSnapshot(db, 'sku-latest', '2026-09-18', 'Amazon Report CSV', 'amazon',
      '2026-09-18T08:00:00Z', false, 120, 4_800);

    const market = repository.getMarket('market-us');
    expect(market?.trends).toEqual([
      { date: '2026-08-19', sales: 100, revenue: 5_000, avgPrice: 35,
        productCount: 500, sellerCount: 30, medianReviews: null },
      { date: '2026-09-18', sales: 210, revenue: 18_000, avgPrice: 40,
        productCount: 500, sellerCount: 30, medianReviews: null },
    ]);
    expect(market?.kpis).toMatchObject({ monthlySales: 210, monthlyRevenue: 18_000, avgPrice: 40 });
    expect(market?.provenance.source).toBe('SellerSprite MCP');
    expect(market?.metricProvenance).toMatchObject({
      monthly_sales: { sourceRecordId: 'market-mcp-sales', sourceRecordType: 'metric_fact' },
      monthly_revenue: { sourceRecordId: 'market-import', sourceRecordType: 'snapshot' },
    });
    expect(repository.getMarkets()[0]).toMatchObject({ monthlySales: 210, growth30d: 110 });
    expect(repository.getMarketSnapshots('market-us')).toHaveLength(2);

    const dashboard = new ExecutiveDashboardService(db, repository, new WorkflowRepository(db))
      .getDashboard('90D');
    expect(dashboard.trendComparison.find((series) => series.id === 'market:market-us')?.points)
      .toEqual(expect.arrayContaining([{ date: '2026-09-18', index: 210, relativeToMarket: null }]));
    const candidate = new DeterministicAIService(repository).preview({
      entityType: 'market', entityId: 'market-us',
    });
    expect(candidate.formal).toBe(false);
    expect(candidate.insight.evidence[0]?.metrics).toEqual(expect.arrayContaining([
      { name: 'monthly_sales', label: '月销量', value: 210 },
    ]));
    expect(candidate.insight.evidence[0]?.provenance[0]?.source).toBe('SellerSprite MCP');
    expect(db.prepare('SELECT COUNT(*) AS count FROM market_snapshots').get()).toMatchObject({ count: 3 });
    expect(db.prepare("SELECT monthly_sales FROM market_snapshots WHERE id = 'market-import'").get())
      .toMatchObject({ monthly_sales: 900 });
  });

  it('selects Amazon report actual sales across fact and snapshot stores, falling back for a missing field', () => {
    const { db, repository } = openFixture();
    addProduct(db);
    addProductSnapshot(db, 'product-old', '2026-08-19', 'Amazon Report CSV', 'amazon',
      '2026-08-20T08:00:00Z', false, 100, 4_000);
    addProductSnapshot(db, 'product-report', '2026-09-18', 'Amazon Report CSV', 'amazon',
      '2026-09-18T08:00:00Z', false, 120, null);
    addProductSnapshot(db, 'product-mcp', '2026-09-18', 'SellerSprite MCP', 'mcp',
      '2026-09-19T08:00:00Z', true, 80, 3_200);
    addFact(db, 'product-mcp-sales', 'product', 'owned-sku', 'estimated_sales', 80,
      'SellerSprite MCP', 'sellersprite_mcp', 'mcp', true);

    const resolved = new MetricAuthorityResolver(db).resolveMetric({
      entityId: 'owned-sku', metric: 'estimated_sales', observationDate: '2026-09-18',
    });
    expect(resolved.selected).toMatchObject({ id: 'product-report', value: 120, sourceType: 'amazon' });
    expect(resolved.alternatives).toEqual([
      expect.objectContaining({ value: 80, sourceType: 'mcp' }),
    ]);
    const snapshots = repository.getProductSnapshots('owned-sku');
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toMatchObject({
      date: '2026-09-18', estimatedSales: 120, estimatedRevenue: 3_200,
      growth30d: 20, growth30dAvailable: true,
      provenance: { source: 'Amazon Report CSV', isEstimated: false },
      metricProvenance: {
        estimated_sales: { sourceRecordId: 'product-report', sourceRecordType: 'snapshot' },
        estimated_revenue: { sourceRecordId: 'product-mcp', sourceRecordType: 'snapshot' },
      },
    });
    expect(repository.getOwnedProducts()[0].latest.estimatedSales).toBe(120);
    expect(repository.getOwnedProduct('owned-sku')?.latest.estimatedRevenue).toBe(3_200);
    expect(db.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get()).toMatchObject({ count: 3 });
    expect(db.prepare("SELECT estimated_sales FROM product_snapshots WHERE id = 'product-mcp'").get())
      .toMatchObject({ estimated_sales: 80 });
  });

  it('selects Amazon API actual facts over report snapshots and does not turn missing facts into zero', () => {
    const { db, repository } = openFixture();
    addProduct(db);
    addProductSnapshot(db, 'product-report', '2026-09-18', 'Amazon Report CSV', 'amazon',
      '2026-09-18T08:00:00Z', false, 120, null);
    addFact(db, 'product-api-sales', 'product', 'owned-sku', 'estimated_sales', 140,
      'Amazon SP-API', 'amazon_api', 'amazon', false);
    addFact(db, 'product-api-revenue-empty', 'product', 'owned-sku', 'estimated_revenue', null,
      'Amazon SP-API', 'amazon_api', 'amazon', false);

    const resolution = new MetricAuthorityResolver(db).resolveMetric({
      entityId: 'owned-sku', metric: 'estimated_sales', observationDate: '2026-09-18',
    });
    expect(resolution.selected).toMatchObject({ id: 'product-api-sales', value: 140 });
    expect(resolution.alternatives).toEqual([
      expect.objectContaining({ id: 'product-report', value: 120 }),
    ]);
    const latest = repository.getProductSnapshots('owned-sku')[0];
    expect(latest).toMatchObject({
      id: 'product-report',
      estimatedSales: 140, estimatedRevenue: null,
      provenance: { source: 'Amazon SP-API', isEstimated: false },
      metricProvenance: {
        estimated_sales: { sourceRecordId: 'product-api-sales', sourceRecordType: 'metric_fact' },
      },
    });
    expect(repository.getOwnedProducts()[0].latest.id).toBe('product-report');
    expect(db.prepare('SELECT id FROM product_snapshots WHERE id = ?').get(latest.id))
      .toEqual({ id: 'product-report' });
    expect(db.prepare('SELECT source, numeric_value FROM metric_facts WHERE id = ?')
      .get(latest.metricProvenance?.estimated_sales.sourceRecordId ?? ''))
      .toMatchObject({ source: 'Amazon SP-API', numeric_value: 140 });
  });

  it('excludes archived seed SKUs from active owned and market portfolios without deleting their history', () => {
    const { db, repository } = openFixture();
    addProduct(db);
    addProductSnapshot(db, 'product-archive', '2026-09-18', 'Demo', 'mock',
      '2026-09-18T08:00:00Z', true, 120, 4_800);
    db.prepare("UPDATE products SET status = 'inactive' WHERE id = 'owned-sku'").run();

    expect(repository.getOwnedProducts()).toEqual([]);
    expect(repository.getOwnedProduct('owned-sku')).toBeNull();
    expect(repository.getMarketProducts('market-us')).toEqual([]);
    expect(db.prepare("SELECT id FROM product_snapshots WHERE id = 'product-archive'").get())
      .toEqual({ id: 'product-archive' });
  });
});
