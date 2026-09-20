import request from 'supertest';
import { previewAndConfirmCsv } from './test-utils/import-api.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { AdapterRegistry } from './adapters/adapter-registry.js';
import { DataSourceRouter } from './adapters/data-source-router.js';
import type {
  MarketDataAdapter,
  MarketOverviewRecord,
  ProductDetailRecord,
  ProductInput,
} from './adapters/types.js';
import { openDatabase, type AppDatabase } from './database/database.js';
import { seedDemoData } from './database/demo-seed.js';
import { IntelligenceService } from './services/intelligence-service.js';
import type { Provenance } from '../shared/types.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function testProvenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    source: 'SellerSprite fixture record ss-42',
    sourceType: 'mcp',
    collectedAt: '2026-09-12T02:00:00.000Z',
    period: '30D',
    isEstimated: true,
    confidence: 0.88,
    ...overrides,
  };
}

function testMarketOverview(provenance = testProvenance()): MarketOverviewRecord {
  return {
    productCount: 120,
    sellerCount: 90,
    brandCount: 48,
    monthlySales: 12_000,
    monthlyRevenue: 480_000,
    avgPrice: 40,
    medianPrice: 38,
    avgRating: 4.3,
    medianReviews: 240,
    top10Share: 32,
    top20Share: 54,
    newProductShare: 12,
    priceBands: [],
    concentration: [],
    provenance,
  };
}

function testProductDetail(
  input: ProductInput,
  provenance = testProvenance(),
): ProductDetailRecord {
  return {
    id: `external-${input.asin}`,
    asin: input.asin,
    brand: 'Route Brand',
    title: 'Route Product',
    imageUrl: '',
    marketplace: input.marketplace,
    productType: 'pillow',
    isOwned: false,
    marketNodeId: 'route-market',
    provenance,
    latest: {
      id: `snapshot-${input.asin}`,
      snapshotAvailable: true,
      productId: `external-${input.asin}`,
      date: '2026-09-12',
      price: 42.5,
      rating: 4.6,
      reviewCount: 321,
      bsr: 4321,
      estimatedSales: 880,
      estimatedRevenue: 37_400,
      sellerCount: 2,
      growth7d: 2.1,
      growth30d: 8.4,
      growth30dAvailable: true,
      growth90d: 18.2,
      provenance,
    },
  };
}

function testAdapter(overrides: Partial<MarketDataAdapter> = {}): MarketDataAdapter {
  return {
    id: 'source-sellersprite-mcp',
    name: 'Fixture connector alpha',
    sourceType: 'mcp',
    async fetchMarketOverview() { return testMarketOverview(); },
    async fetchMarketProducts() { return []; },
    async fetchKeywordData() { return []; },
    async fetchProductDetail(input) { return testProductDetail(input); },
    ...overrides,
  };
}

function testImportAdapter(overrides: Partial<MarketDataAdapter> = {}): MarketDataAdapter {
  const provenance = testProvenance({
    source: 'SellerSprite fixture import ss-42',
    sourceType: 'import',
  });
  return testAdapter({
    id: 'source-sellersprite-import',
    name: 'Fixture import connector',
    sourceType: 'import',
    async fetchMarketOverview() { return testMarketOverview(provenance); },
    async fetchProductDetail(input) { return testProductDetail(input, provenance); },
    ...overrides,
  });
}

describe('data refresh routing', () => {
  it('fails a generic Live SellerSprite task before a runless MCP call or snapshot write', async () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    database.prepare("UPDATE app_settings SET mode = 'live' WHERE id = 1").run();
    let remoteCalls = 0;
    const adapter = testAdapter({
      async fetchProductDetail(input) {
        remoteCalls += 1;
        return testProductDetail(input);
      },
    });
    const service = new IntelligenceService(
      database, new DataSourceRouter(new AdapterRegistry([adapter])),
    );
    const productId = service.repository.getOwnedProducts()[0].id;
    const before = database.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE product_id = ?
    `).get(productId);

    const task = await service.runDataTask({
      taskType: 'owned_sku_refresh', target: productId,
    });

    expect(task).toMatchObject({
      status: 'failed', sourceId: 'source-sellersprite-mcp', success: 0, failed: 1,
    });
    expect(task.errorLog).toMatch(/SellerSprite.*(?:关键同步|专用同步)/);
    expect(remoteCalls).toBe(0);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE product_id = ?
    `).get(productId)).toEqual(before);
  });

  it('fails a legacy generic Live SellerSprite retry before any MCP call', async () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    database.prepare("UPDATE app_settings SET mode = 'live' WHERE id = 1").run();
    let remoteCalls = 0;
    const adapter = testAdapter({
      async fetchProductDetail(input) {
        remoteCalls += 1;
        return testProductDetail(input);
      },
    });
    const service = new IntelligenceService(
      database, new DataSourceRouter(new AdapterRegistry([adapter])),
    );
    const productId = service.repository.getOwnedProducts()[0].id;
    const before = database.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE product_id = ?
    `).get(productId);
    database.prepare(`
      INSERT INTO data_tasks (
        id, name, source_id, task_type, target, source, marketplace, status,
        started_at, completed_at, total, success, failed, error_log, created_at
      ) VALUES ('legacy-generic-mcp', 'Legacy refresh', 'source-sellersprite-mcp',
        'owned_sku_refresh', ?, 'SellerSprite MCP', 'US', 'failed', ?, ?, 1, 0, 1,
        'prior failure', ?)
    `).run(productId, '2026-09-19T00:00:00Z', '2026-09-19T00:01:00Z', '2026-09-19T00:00:00Z');

    const task = await service.runDataTask({ retryTaskId: 'legacy-generic-mcp' });

    expect(task).toMatchObject({
      status: 'failed', sourceId: 'source-sellersprite-mcp', success: 0, failed: 1,
    });
    expect(task.errorLog).toMatch(/SellerSprite.*(?:关键同步|专用同步)/);
    expect(remoteCalls).toBe(0);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE product_id = ?
    `).get(productId)).toEqual(before);
  });

  it('records the resolved real adapter and appends no snapshot when live SellerSprite is unavailable', async () => {
    database = openDatabase(':memory:');
    const app = createApp({ database });
    const csv = [
      'ASIN,SKU,Brand,Title,MarketName,Price,Rating,Reviews,BSR,MonthlySales,SellerCount,Growth7D,Growth30D,Growth90D,Confidence,IsEstimated,Date',
      'B0ROUTE001,ROUTE-01,Route Brand,Route Product,Route Market,39.99,4.4,120,8000,700,1,1.2,4.2,9.4,0.8,true,2026-09-09',
    ].join('\n');
    await previewAndConfirmCsv(app, csv, 'route-live.csv', { entityType: 'product' });
    const products = await request(app).get('/api/owned-products').expect(200);
    const productId = products.body.data[0].id as string;
    const before = database.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE product_id = ?
    `).get(productId) as { count: number };

    const response = await request(app).post('/api/data-tasks/run').send({
      taskType: 'owned_sku_refresh',
      target: productId,
    }).expect(201);

    expect(response.body.data).toMatchObject({
      status: 'failed',
      source: 'SellerSprite MCP',
      success: 0,
      failed: 1,
    });
    expect(response.body.data.errorLog).toMatch(/SELLERSPRITE_MCP_URL|账号协议/);
    expect(response.body.data.errorLog).toContain('未写入任何 Mock 快照');
    expect(database.prepare('SELECT source_id FROM data_tasks WHERE id = ?')
      .get(response.body.data.id)).toMatchObject({ source_id: 'source-sellersprite-mcp' });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE product_id = ?
    `).get(productId)).toMatchObject({ count: before.count });
  });

  it('persists the exact resolved adapter and provenance when a live adapter succeeds', async () => {
    database = openDatabase(':memory:');
    database.exec(`
      UPDATE app_settings SET mode = 'live' WHERE id = 1;
      INSERT INTO market_nodes (
        id, name, parent_id, level, marketplace, keywords_json, status,
        competition_score, opportunity_score, source_type, created_at
      ) VALUES (
        'route-market', 'Route Market', NULL, 1, 'US', '["route"]', 'active',
        50, 50, 'mcp', '2026-09-12T01:00:00.000Z'
      );
      INSERT INTO products (
        id, asin, sku, internal_name, brand, title, image_url, marketplace,
        product_type, is_owned, market_node_id, keywords_json, monitoring_enabled,
        source_type, created_at
      ) VALUES (
        'route-product', 'B0ROUTE002', 'ROUTE-02', 'Route Product', 'Route Brand',
        'Route Product', '', 'US', 'pillow', 1, 'route-market', '["route"]', 1,
        'mcp', '2026-09-12T01:00:00.000Z'
      );
    `);
    const provenance = {
      source: 'SellerSprite fixture record ss-42',
      sourceType: 'import' as const,
      collectedAt: '2026-09-12T02:00:00.000Z',
      period: '30D',
      isEstimated: true,
      confidence: 0.88,
    };
    const adapter: MarketDataAdapter = {
      id: 'source-sellersprite-import',
      name: 'SellerSprite import fixture',
      sourceType: 'import',
      async fetchMarketOverview() { throw new Error('not used'); },
      async fetchMarketProducts() { return []; },
      async fetchKeywordData() { return []; },
      async fetchProductDetail(input) {
        return {
          id: 'external-product-id', asin: input.asin, brand: 'Route Brand', title: 'Route Product',
          imageUrl: '', marketplace: input.marketplace, productType: 'pillow', isOwned: false,
          marketNodeId: 'route-market', provenance,
          latest: {
            id: 'external-snapshot-id', snapshotAvailable: true, productId: 'external-product-id',
            date: '2026-09-12', price: 42.5, rating: 4.6, reviewCount: 321, bsr: 4321,
            estimatedSales: 880, estimatedRevenue: 37_400, sellerCount: 2,
            growth7d: 2.1, growth30d: 8.4, growth30dAvailable: true, growth90d: 18.2,
            provenance,
          },
        };
      },
    };
    const service = new IntelligenceService(
      database,
      new DataSourceRouter(new AdapterRegistry([adapter])),
    );

    const task = await service.runDataTask({
      taskType: 'owned_sku_refresh',
      target: 'route-product',
      sourcePreference: adapter.id,
    });

    expect(task.errorLog).toBeNull();
    expect(task).toMatchObject({ status: 'success', source: adapter.name, success: 1, failed: 0 });
    expect(database.prepare(`
      SELECT source_id FROM data_tasks WHERE id = ?
    `).get(task.id)).toMatchObject({ source_id: adapter.id });
    expect(database.prepare(`
      SELECT source, source_type, collected_at, period, is_estimated, confidence,
        estimated_sales, estimated_revenue
      FROM product_snapshots WHERE product_id = 'route-product'
    `).get()).toMatchObject({
      source: provenance.source,
      source_type: provenance.sourceType,
      collected_at: provenance.collectedAt,
      period: provenance.period,
      is_estimated: 1,
      confidence: provenance.confidence,
      estimated_sales: 880,
      estimated_revenue: 37_400,
    });
  });

  it('keeps dashboard core snapshots and insights unchanged when any staged fetch fails', async () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    database.exec(`UPDATE app_settings SET mode = 'live' WHERE id = 1`);
    const adapter = testImportAdapter({
      async fetchProductDetail() { throw new Error('fixture product fetch failed'); },
    });
    const service = new IntelligenceService(
      database,
      new DataSourceRouter(new AdapterRegistry([adapter])),
    );
    const before = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM market_snapshots) AS marketSnapshots,
        (SELECT COUNT(*) FROM product_snapshots) AS productSnapshots,
        (SELECT COUNT(*) FROM ai_insights) AS insights
    `).get() as { marketSnapshots: number; productSnapshots: number; insights: number };

    const task = await service.runDataTask({
      taskType: 'dashboard_core_refresh', target: 'all', sourcePreference: adapter.id,
    });

    expect(task).toMatchObject({
      status: 'failed',
      sourceId: adapter.id,
      source: adapter.name,
      success: 0,
      failed: 1,
    });
    expect(task.errorLog).toContain('fixture product fetch failed');
    expect(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM market_snapshots) AS marketSnapshots,
        (SELECT COUNT(*) FROM product_snapshots) AS productSnapshots,
        (SELECT COUNT(*) FROM ai_insights) AS insights
    `).get()).toEqual(before);
  });

  it('fails closed for refresh task types whose persistence paths are not implemented', async () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    database.exec(`UPDATE app_settings SET mode = 'live' WHERE id = 1`);
    const adapter = testImportAdapter();
    const service = new IntelligenceService(
      database,
      new DataSourceRouter(new AdapterRegistry([adapter])),
    );
    const marketId = service.repository.getSettings().defaultMarketId;
    const productId = service.repository.getOwnedProducts()[0].id;
    const before = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM market_snapshots) AS marketSnapshots,
        (SELECT COUNT(*) FROM product_snapshots) AS productSnapshots
    `).get();

    const keywordTask = await service.runDataTask({
      taskType: 'keyword_refresh', target: marketId, sourcePreference: adapter.id,
    });
    const reviewTask = await service.runDataTask({
      taskType: 'review_refresh', target: productId, sourcePreference: adapter.id,
    });

    expect(keywordTask).toMatchObject({ status: 'failed', sourceId: adapter.id });
    expect(keywordTask.errorLog).toContain('关键词刷新持久化尚未实现');
    expect(reviewTask).toMatchObject({ status: 'failed', sourceId: adapter.id });
    expect(reviewTask.errorLog).toContain('评论刷新持久化尚未实现');
    expect(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM market_snapshots) AS marketSnapshots,
        (SELECT COUNT(*) FROM product_snapshots) AS productSnapshots
    `).get()).toEqual(before);
  });

  it('retries through the immutable source id when the adapter display name has changed', async () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    database.exec(`UPDATE app_settings SET mode = 'live' WHERE id = 1`);
    const adapter = testImportAdapter({ name: 'Renamed SellerSprite import connector' });
    const service = new IntelligenceService(
      database,
      new DataSourceRouter(new AdapterRegistry([adapter])),
    );
    const productId = service.repository.getOwnedProducts()[0].id;
    database.prepare(`
      INSERT INTO data_tasks (
        id, name, source_id, task_type, target, source, marketplace, status,
        started_at, completed_at, total, success, failed, error_log, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, 1, 0, 1, ?, ?)
    `).run(
      'retry-by-source-id',
      'legacy refresh',
      adapter.id,
      'owned_sku_refresh',
      productId,
      'Legacy connector label no longer recognized',
      'US',
      '2026-09-11T00:00:00.000Z',
      '2026-09-11T00:01:00.000Z',
      'legacy failure',
      '2026-09-11T00:00:00.000Z',
    );

    const retry = await service.runDataTask({ retryTaskId: 'retry-by-source-id' });

    expect(retry).toMatchObject({
      status: 'success',
      sourceId: adapter.id,
      source: adapter.name,
      success: 1,
    });
  });

  it('rejects generic retries and direct execution for run-managed SellerSprite tasks', async () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    database.exec(`UPDATE app_settings SET mode = 'live' WHERE id = 1`);
    const service = new IntelligenceService(database);
    const now = '2026-09-20T00:00:00.000Z';
    const insert = database.prepare(`
      INSERT INTO data_tasks (
        id, sync_run_id, name, task_type, target, source, marketplace, status,
        started_at, completed_at, total, success, failed, error_log, created_at
      ) VALUES (?, ?, ?, ?, ?, 'SellerSprite MCP', 'US', 'failed', ?, ?, 1, 0, 1, 'failure', ?)
    `);
    insert.run('critical-run', 'critical-run', 'Critical sync', 'critical_sync', 'market-1', now, now, now);
    insert.run('secondary-task', 'critical-run', 'Competitor refresh', 'competitor_refresh', 'market-1', now, now, now);
    const before = database.prepare('SELECT COUNT(*) AS count FROM data_tasks').get();

    await expect(service.runDataTask({ retryTaskId: 'critical-run' }))
      .rejects.toThrow(/设置.*数据源.*关键同步/);
    await expect(service.runDataTask({ retryTaskId: 'secondary-task' }))
      .rejects.toThrow(/设置.*数据源.*关键同步/);
    await expect(service.runDataTask({ taskType: 'critical_sync', target: 'market-1' }))
      .rejects.toThrow(/设置.*数据源.*关键同步/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM data_tasks').get()).toEqual(before);
  });

  it('rejects generic retries for ResearchJob-owned tasks without creating a new task', async () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    database.exec(`UPDATE app_settings SET mode = 'live' WHERE id = 1`);
    const service = new IntelligenceService(database);
    const now = '2026-09-20T00:00:00.000Z';
    database.prepare(`
      INSERT INTO data_tasks (
        id, name, task_type, target, source, marketplace, status,
        started_at, completed_at, total, success, failed, error_log, created_at,
        research_job_id
      ) VALUES ('research-collection-task', 'Research collection', 'market_refresh',
        'mkt-memory-foam', 'Persisted Snapshot', 'US', 'failed', ?, ?, 1, 0, 1,
        'missing data', ?, 'research-job-1')
    `).run(now, now, now);
    const before = database.prepare('SELECT COUNT(*) AS count FROM data_tasks').get();

    await expect(service.runDataTask({ retryTaskId: 'research-collection-task' }))
      .rejects.toThrow(/Research Job.*工作流.*重试/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM data_tasks').get()).toEqual(before);
  });

  it('rejects mismatched product identity and non-ISO dates before persistence', async () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    database.exec(`UPDATE app_settings SET mode = 'live' WHERE id = 1`);
    const productId = new IntelligenceService(database).repository.getOwnedProducts()[0].id;
    const before = database.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE product_id = ?
    `).get(productId);
    const importProvenance = testProvenance({
      source: 'SellerSprite fixture import ss-42', sourceType: 'import',
    });
    const invalidDetails: Array<{ expected: RegExp; detail: (input: ProductInput) => ProductDetailRecord }> = [
      {
        expected: /ASIN.*不一致/,
        detail: (input) => ({ ...testProductDetail(input, importProvenance), asin: 'B0WRONGASIN' }),
      },
      {
        expected: /marketplace.*不一致/,
        detail: (input) => ({ ...testProductDetail(input, importProvenance), marketplace: 'CA' }),
      },
      {
        expected: /产品与快照身份不一致/,
        detail: (input) => ({
          ...testProductDetail(input, importProvenance),
          latest: { ...testProductDetail(input, importProvenance).latest, productId: 'another-external-product' },
        }),
      },
      {
        expected: /有效日期/,
        detail: (input) => ({
          ...testProductDetail(input, importProvenance),
          latest: { ...testProductDetail(input, importProvenance).latest, date: '2026-02-30' },
        }),
      },
      {
        expected: /ISO-8601/,
        detail: (input) => {
          const provenance = { ...importProvenance, collectedAt: '09/12/2026' };
          return testProductDetail(input, provenance);
        },
      },
    ];

    for (const invalid of invalidDetails) {
      const adapter = testImportAdapter({
        async fetchProductDetail(input) { return invalid.detail(input); },
      });
      const service = new IntelligenceService(
        database,
        new DataSourceRouter(new AdapterRegistry([adapter])),
      );
      const task = await service.runDataTask({
        taskType: 'owned_sku_refresh', target: productId, sourcePreference: adapter.id,
      });
      expect(task.status).toBe('failed');
      expect(task.errorLog).toMatch(invalid.expected);
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM product_snapshots WHERE product_id = ?
      `).get(productId)).toEqual(before);
    }
  });
});
