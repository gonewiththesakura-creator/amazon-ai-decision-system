import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { AppSettings, DashboardData, MarketDetail, OwnedProductSummary } from '../shared/types.js';
import type { SellerSpriteConnectionDiagnostics } from './adapters/sellersprite-mcp-adapter.js';
import { createApp } from './app.js';
import { openDatabase, type AppDatabase } from './database/database.js';
import { previewAndConfirmCsv } from './test-utils/import-api.js';
import type { SellerSpriteSyncPort } from './services/sellersprite-sync-service.js';

let database: AppDatabase | undefined;
let temporaryDirectory: string | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

function testApp() {
  database = openDatabase(':memory:');
  return createApp({ database });
}

function liveSyncPort(): SellerSpriteSyncPort {
  const provenance = {
    source: 'SellerSprite MCP', sourceType: 'mcp' as const,
    collectedAt: '2026-09-19T03:00:00.000Z', period: '1M',
    isEstimated: true, confidence: 0.85,
  };
  return {
    async fetchMarketStatistics(input) {
      return { data: { marketplace: input.marketplace, nodeIdPath: input.nodeIdPath,
        products: 1, brands: 1, sellers: 1, avgPrice: 39, avgRating: 4.5 }, provenance };
    },
    async fetchMarketConcentration() {
      return { data: [{ asin: 'B0PUBLIC01', price: 39, ratings: 12, totalUnits: 10,
        totalRevenue: 390, totalUnitsRatio: 1 }], provenance };
    },
    async fetchAsinSalesTrend(input) {
      return { data: { asin: { asin: input.asin, ratings: 10 }, salesTrendPoints: [
        { month: '2026-08', price: 39, childUnitSales: 10, childSalesRevenue: 390 },
      ] }, provenance };
    },
    async discoverAsinCompetitors() {
      return { data: [{ asin: 'B0PUBLIC02', title: 'Candidate', brand: 'Other' }], provenance };
    },
  };
}

function productResearchFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    new URL('../examples/research-job-u-shaped.json', import.meta.url),
    'utf8',
  )) as Record<string, unknown>;
}

const COMPLETE_PRODUCT_FIELDS = [
  'Price', 'Rating', 'Reviews', 'BSR', 'MonthlySales', 'SellerCount',
  'Growth7D', 'Growth30D', 'Growth90D', 'Confidence', 'IsEstimated', 'Date',
].join(',');

function completeProductValues(
  price: number,
  sales: number,
  growth30d: number,
  date = '2026-09-09',
): string {
  return [price, 4.4, 120, 8000, sales, 1, 1.2, growth30d, 9.4, 0.8, true, date].join(',');
}

describe('V2.2 real-data administration routes', () => {
  it('guards Go Live cleanup with dry-run, backup, exact confirmation, and coverage verification', async () => {
    database = openDatabase(':memory:');
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'ys-go-live-api-'));
    const app = createApp({ database, backupDirectory: temporaryDirectory });
    await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);

    const preview = await request(app).get('/api/go-live/preview').expect(200);
    expect(preview.body.data.delete).toMatchObject({
      marketSnapshots: expect.any(Number),
      productSnapshots: expect.any(Number),
    });
    await request(app).post('/api/go-live/cleanup')
      .send({ confirmation: 'wrong' }).expect(409);
    const backup = await request(app).post('/api/go-live/backup').send({}).expect(201);
    expect(backup.body.data).toMatchObject({ created: true, filename: expect.stringMatching(/\.db$/) });
    await request(app).post('/api/go-live/cleanup')
      .send({ confirmation: 'CLEAR DEMO DATA' }).expect(200);
    const verification = await request(app).get('/api/go-live/verify').expect(200);
    expect(verification.body.data).toMatchObject({ mockObservations: 0, hasMinimumRealCoverage: false });
    await request(app).post('/api/go-live/activate')
      .send({ confirmation: 'ACTIVATE LIVE' }).expect(409);
  });

  it('returns only sanitized SellerSprite connection and capability diagnostics', async () => {
    database = openDatabase(':memory:');
    const diagnostic: SellerSpriteConnectionDiagnostics = {
      connected: true,
      authenticated: true,
      toolCount: 49,
      requiredCapabilityCount: 5,
      availableRequiredCapabilityCount: 5,
      missingCapabilities: [],
      latencyMs: 42,
    };
    const app = createApp({
      database,
      sellerSpritePort: liveSyncPort(),
      sellerSpriteDiagnostics: { async testConnection() { return diagnostic; } },
    });

    const response = await request(app).post('/api/integrations/sellersprite/test').send({}).expect(200);
    expect(response.body.data).toEqual(diagnostic);
    expect(JSON.stringify(response.body)).not.toMatch(/secret|authorization|https?:\/\//i);
    const capabilities = await request(app).get('/api/integrations/sellersprite/capabilities').expect(200);
    expect(capabilities.body.data).toMatchObject({ toolCount: 0, collectedAt: null });
    expect(capabilities.body.data.required).toHaveLength(5);
  });

  it('syncs market and owned history through admin routes without remote calls on dashboard GET', async () => {
    database = openDatabase(':memory:');
    database.exec(`
      INSERT INTO market_nodes (
        id, name, parent_id, level, marketplace, category_id, keywords_json, status,
        source_type, created_at
      ) VALUES (
        'market-live', 'Bed Pillows', NULL, 1, 'US', '1055398:1063252:1199122:10671043011', '[]',
        'active', 'import', '2026-09-01T00:00:00.000Z'
      );
      INSERT INTO products (
        id, asin, sku, internal_name, brand, title, image_url, marketplace,
        product_type, is_owned, market_node_id, keywords_json, monitoring_enabled,
        source_type, created_at
      ) VALUES (
        'owned-live', 'B0OWNED001', 'LIVE-01', 'Live One', 'Own', 'Live One', '',
        'US', 'memory_foam_pillow', 1, 'market-live', '[]', 1, 'import',
        '2026-09-01T00:00:00.000Z'
      );
      UPDATE app_settings SET default_market_id = 'market-live' WHERE id = 1;
    `);
    let calls = 0;
    const delegate = liveSyncPort();
    const port: SellerSpriteSyncPort = {
      async fetchMarketStatistics(input) { calls += 1; return delegate.fetchMarketStatistics(input); },
      async fetchMarketConcentration(input) { calls += 1; return delegate.fetchMarketConcentration(input); },
      async fetchAsinSalesTrend(input) { calls += 1; return delegate.fetchAsinSalesTrend(input); },
      async discoverAsinCompetitors(input) { calls += 1; return delegate.discoverAsinCompetitors(input); },
    };
    const app = createApp({ database, sellerSpritePort: port });

    await request(app).post('/api/integrations/sellersprite/sync/market')
      .send({ marketId: 'market-live', month: '202608' }).expect(201);
    await request(app).post('/api/integrations/sellersprite/sync/products')
      .send({ productIds: ['owned-live'] }).expect(201);
    expect(calls).toBe(3);

    await request(app).get('/api/dashboard/executive?range=30D').expect(200);
    const coverage = await request(app).get('/api/data-coverage?marketplace=US').expect(200);
    expect(coverage.body.data).toMatchObject({ marketplace: 'US' });
    expect(calls).toBe(3);
    expect((database.prepare(`SELECT COUNT(*) AS count FROM market_snapshots`).get() as { count: number }).count).toBe(1);
    expect((database.prepare(`SELECT COUNT(*) AS count FROM product_snapshots`).get() as { count: number }).count).toBe(1);
    await request(app).patch('/api/markets/market-live/sellersprite-node')
      .send({ nodeIdPath: '1055398:1063252:1199122', confirmed: true }).expect(409);
  });

  it('requires an admin-confirmed numeric SellerSprite market path before market sync', async () => {
    database = openDatabase(':memory:');
    database.prepare(`INSERT INTO market_nodes (
      id, name, level, marketplace, status, source_type, created_at
    ) VALUES ('unmapped', 'Memory Foam Pillow', 1, 'US', 'active', 'import', '2026-09-19')`).run();
    const app = createApp({ database, sellerSpritePort: liveSyncPort() });
    await request(app).post('/api/integrations/sellersprite/sync/market')
      .send({ marketId: 'unmapped', month: '202608' }).expect(400);
    await request(app).patch('/api/markets/unmapped/sellersprite-node')
      .send({ nodeIdPath: 'unverified-name', confirmed: true }).expect(400);
    await request(app).patch('/api/markets/unmapped/sellersprite-node')
      .send({ nodeIdPath: '1055398:1063252:1199122:10671043011' }).expect(400);
    await request(app).patch('/api/markets/unmapped/sellersprite-node')
      .send({ nodeIdPath: '1055398:1063252:1199122:10671043011', confirmed: true }).expect(200);
    expect(database.prepare(`SELECT category_id AS path FROM market_nodes WHERE id = 'unmapped'`).get())
      .toEqual({ path: '1055398:1063252:1199122:10671043011' });
  });

  it('requires human confirmation before a discovered competitor becomes a relation', async () => {
    database = openDatabase(':memory:');
    database.exec(`
      INSERT INTO market_nodes (
        id, name, level, marketplace, status, source_type, created_at
      ) VALUES ('market-live', 'Bed Pillows', 1, 'US', 'active', 'import', '2026-09-01T00:00:00.000Z');
      INSERT INTO products (
        id, asin, brand, title, image_url, marketplace, product_type, is_owned,
        market_node_id, source_type, created_at
      ) VALUES (
        'owned-live', 'B0OWNED001', 'Own', 'Live One', '', 'US', 'pillow', 1,
        'market-live', 'import', '2026-09-01T00:00:00.000Z'
      );
    `);
    const app = createApp({ database, sellerSpritePort: liveSyncPort() });

    await request(app).post('/api/owned-products/owned-live/competitor-candidates')
      .send({ size: 5 }).expect(201);
    expect((database.prepare(`SELECT COUNT(*) AS count FROM competitor_relations`).get() as { count: number }).count).toBe(0);
    const review = await request(app).get('/api/owned-products/owned-live/competitor-candidates').expect(200);
    expect(review.body.data).toEqual([expect.objectContaining({ asin: 'B0PUBLIC02', status: 'pending_review' })]);
    const candidate = review.body.data[0] as { id: string };
    const confirmed = await request(app)
      .post(`/api/owned-products/owned-live/competitor-candidates/${candidate.id}/confirm`)
      .send({ relationType: 'direct', reason: '人工确认' }).expect(201);
    expect((database.prepare(`SELECT COUNT(*) AS count FROM competitor_relations`).get() as { count: number }).count).toBe(1);
    expect((await request(app).get('/api/owned-products/owned-live/competitor-candidates').expect(200))
      .body.data[0].status).toBe('confirmed');
    const competitorProductId = confirmed.body.data.competitorProductId as string;
    const sync = await request(app).post('/api/integrations/sellersprite/sync/competitor')
      .send({ ownedProductId: 'owned-live', competitorProductId }).expect(201);
    expect(sync.body.data).toMatchObject({ inserted: 1 });
    expect(database.prepare(`SELECT source_type, estimated_sales FROM product_snapshots
      WHERE product_id = ?`).get(competitorProductId))
      .toEqual({ source_type: 'mcp', estimated_sales: 10 });
    database.prepare(`INSERT INTO competitor_candidates (
      id, marketplace, asin, source_product_id, source, source_type, status, created_at
    ) VALUES ('reject-me', 'US', 'B0PUBLIC03', 'owned-live', 'SellerSprite', 'mcp', 'pending_review', '2026-09-19')`).run();
    await request(app).post('/api/owned-products/owned-live/competitor-candidates/reject-me/reject')
      .send({}).expect(200);
    expect((database.prepare(`SELECT status FROM competitor_candidates WHERE id = 'reject-me'`).get() as { status: string })
      .status).toBe('rejected');
  });

  it('wires review-first import preview and confirmation routes', async () => {
    const app = testApp();
    const csv = [
      'marketplace,asin,sku,internalName,brand,title,productType,parentAsin,variationTheme,marketNode,monitoringEnabled,status',
      'US,B0MASTER01,SKU-01,Pillow One,Own,Pillow One,memory_foam_pillow,,,Bed Pillows,true,active',
    ].join('\n');
    const preview = await request(app).post('/api/import/preview/csv')
      .attach('file', Buffer.from(csv), 'owned-products.csv').expect(200);
    expect(preview.body.data).toMatchObject({ detectedType: 'owned_product_master', newCount: 1 });
    expect(preview.body.data.rows).toHaveLength(1);

    const confirmed = await request(app).post('/api/import/confirm')
      .send({ token: preview.body.data.token }).expect(201);
    expect(confirmed.body.data).toMatchObject({ successCount: 1, failureCount: 0 });
  });

  it('rejects legacy direct uploads without creating an import task or business records', async () => {
    const app = testApp();
    const csv = [
      'ASIN,SKU,Brand,Title,MarketName,Price,Rating,Reviews,BSR,MonthlySales,SellerCount,Growth7D,Growth30D,Growth90D,Confidence,IsEstimated,Date',
      'B0BYPASS01,SKU-01,Brand,Product,Market,39.99,4.4,120,8000,700,1,1.2,4.2,9.4,0.8,true,2026-09-09',
    ].join('\n');
    for (const endpoint of ['/api/import/csv', '/api/import/xlsx']) {
      const response = await request(app).post(endpoint).field('entityType', 'product')
        .attach('file', Buffer.from(csv), 'products.csv').expect(410);
      expect(response.body.error).toMatch(/预览|审核/);
    }
    expect(database?.prepare('SELECT COUNT(*) AS count FROM products').get()).toEqual({ count: 0 });
    expect(database?.prepare('SELECT COUNT(*) AS count FROM data_tasks').get()).toEqual({ count: 0 });
  });

  it('passes Amazon report dates through preview and preserves actual source authority', async () => {
    const app = testApp();
    const master = [
      'marketplace,asin,sku,internalName,brand,title,productType,parentAsin,variationTheme,marketNode,monitoringEnabled,status',
      'US,B0ACTUAL01,SKU-01,Owned Pillow,Own,Owned Pillow,memory_foam_pillow,,,Memory Foam,true,active',
    ].join('\n');
    const masterPreview = await request(app).post('/api/import/preview/csv')
      .attach('file', Buffer.from(master), 'master.csv').expect(200);
    await request(app).post('/api/import/confirm')
      .send({ token: masterPreview.body.data.token }).expect(201);
    const report = [
      '(Parent) ASIN,(Child) ASIN,Title,SKU,Units Ordered,Ordered Product Sales',
      'B0PARENT01,B0ACTUAL01,Owned Pillow,SKU-01,120,$4800',
    ].join('\n');
    const missingPeriod = await request(app).post('/api/import/preview/csv')
      .field('sourceType', 'amazon').field('marketplace', 'US')
      .attach('file', Buffer.from(report), 'report.csv').expect(200);
    expect(missingPeriod.body.data).toMatchObject({ newCount: 0, errorCount: 1 });
    const preview = await request(app).post('/api/import/preview/csv')
      .field('sourceType', 'amazon').field('marketplace', 'US')
      .field('reportStartDate', '2026-08-01').field('reportEndDate', '2026-08-31')
      .attach('file', Buffer.from(report), 'report.csv').expect(200);
    expect(preview.body.data).toMatchObject({ detectedType: 'amazon_business_report', newCount: 1 });
    await request(app).post('/api/import/confirm').send({ token: preview.body.data.token }).expect(201);
    expect(database!.prepare(`SELECT estimated_sales, estimated_revenue, bsr, source_type,
      is_estimated, observation_date, period FROM product_snapshots WHERE source_type = 'amazon'`).get())
      .toEqual({ estimated_sales: 120, estimated_revenue: 4800, bsr: null,
        source_type: 'amazon', is_estimated: 0, observation_date: '2026-08-31',
        period: '2026-08-01/2026-08-31' });
  });

  it('does not automatically enter Live when only a product master exists', async () => {
    const app = testApp();

    await request(app).post('/api/owned-products').send({
      asin: 'B0LIVEONLY', brand: 'Own', title: 'Configured pillow',
      productType: 'memory_foam_pillow',
    }).expect(201);

    const settings = await request(app).get('/api/settings').expect(200);
    expect(settings.body.data.mode).toBe('empty');
    const verification = await request(app).get('/api/go-live/verify').expect(200);
    expect(verification.body.data.hasMinimumRealCoverage).toBe(false);
  });
});

describe('system bootstrap and demo mode', () => {
  it('starts empty and enters explicitly marked demo mode', async () => {
    const app = testApp();
    const emptySettings = await request(app).get('/api/settings').expect(200);
    expect((emptySettings.body.data as AppSettings).mode).toBe('empty');
    expect(await request(app).get('/api/owned-products').then((result) => result.body.data)).toEqual([]);

    const enabled = await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);
    expect(enabled.body.data.mode).toBe('demo');
    expect(enabled.body.meta.mode).toBe('demo');

    const products = await request(app).get('/api/owned-products').expect(200);
    const owned = products.body.data as OwnedProductSummary[];
    expect(owned).toHaveLength(4);
    expect(owned.find((item) => item.id === 'owned-sku-01')).toMatchObject({
      relativeDelta: -11.6,
      performance: 'strong_underperform',
    });
    expect(owned.every((item) => item.latest.provenance.sourceType === 'mock')).toBe(true);

    const projects = await request(app).get('/api/development-projects').expect(200);
    expect(projects.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'dev-lumbar', status: 'watch' }),
      expect.objectContaining({ id: 'dev-travel', status: 'watch' }),
    ]));
    expect(projects.body.data.every((project: { decision?: unknown }) => !project.decision)).toBe(true);
    const opportunities = await request(app).get('/api/opportunities').expect(200);
    expect(opportunities.body.data.every((item: { status: string }) => item.status !== 'promoted')).toBe(true);
  });

  it('returns market history and competitors without presenting seeded legacy insights as workflow conclusions', async () => {
    const app = testApp();
    await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);

    const marketResponse = await request(app).get('/api/markets/mkt-memory-foam').expect(200);
    const market = marketResponse.body.data as MarketDetail;
    expect(market.trends.length).toBeGreaterThanOrEqual(6);
    expect(market.tree[0].children?.length).toBeGreaterThanOrEqual(6);
    expect(market.insight).toMatchObject({
      insightType: 'workflow_required', status: '数据不足', evidence: [], evidenceIds: [],
    });
    expect(await request(app).get('/api/markets/mkt-memory-foam/insights')
      .then((result) => result.body.data)).toEqual([]);
    expect(await request(app).get('/api/ai/insights/owned_product/owned-sku-02')
      .then((result) => result.body.data)).toEqual([]);
    const month = await request(app).get('/api/markets/mkt-memory-foam?range=30D').expect(200);
    const year = await request(app).get('/api/markets/mkt-memory-foam?range=1Y').expect(200);
    expect(month.body.data.trends.length).toBeLessThan(year.body.data.trends.length);
    const monthSnapshots = await request(app).get('/api/markets/mkt-memory-foam/snapshots?range=30D').expect(200);
    expect(monthSnapshots.body.data).toHaveLength(month.body.data.trends.length);
    await request(app).get('/api/markets/mkt-memory-foam?range=bad').expect(400);

    const competitors = await request(app).get('/api/owned-products/owned-sku-02/competitors').expect(200);
    expect(competitors.body.data.length).toBeGreaterThanOrEqual(3);
    expect(competitors.body.data.some((item: { relationType: string }) => item.relationType === 'direct')).toBe(true);
    const productDetail = await request(app).get('/api/owned-products/owned-sku-02').expect(200);
    const marketProducts = await request(app).get(`/api/markets/${productDetail.body.data.marketNodeId}/products`).expect(200);
    const top20Cohort = marketProducts.body.data
      .filter((item: { id: string; isOwned: boolean; latest: { id: string; bsr: number } }) => (
        item.id !== 'owned-sku-02' && !item.isOwned && item.latest.id && item.latest.bsr > 0
      ))
      .sort((left: { latest: { bsr: number } }, right: { latest: { bsr: number } }) => left.latest.bsr - right.latest.bsr)
      .slice(0, 20) as Array<{ latest: { growth30d: number } }>;
    const top20Growth = top20Cohort.reduce((sum, item) => sum + item.latest.growth30d, 0) / top20Cohort.length;
    expect(productDetail.body.data.comparisons.top20.growth30d).toBeCloseTo(top20Growth, 1);
    expect(productDetail.body.data.comparisons.top20.sampleSize).toBe(top20Cohort.length);
    expect(productDetail.body.data.comparisons.direct.sampleSize).toBeGreaterThan(0);

    const dashboard = await request(app).get('/api/dashboard/briefing').expect(200);
    const data = dashboard.body.data as DashboardData;
    expect(data.briefing).toEqual([]);
    expect(data.summaries.skus.underperform).toBeGreaterThanOrEqual(1);
  });

  it('creates the first configured SKU and its requested market without hardcoded seed data', async () => {
    const app = testApp();
    const created = await request(app).post('/api/owned-products').send({
      asin: 'B0FIRST001',
      sku: 'FIRST-01',
      internalName: '首个自有 SKU',
      brand: 'Own Brand',
      title: 'First Memory Foam Pillow',
      marketplace: 'US',
      productType: 'Memory Foam Pillow',
      marketNodeId: 'mkt-memory-foam',
      keywords: ['memory foam pillow'],
      monitoringEnabled: true,
    }).expect(201);
    expect(created.body.data).toMatchObject({
      asin: 'B0FIRST001',
      marketNodeId: 'mkt-memory-foam',
      monitoringEnabled: true,
    });
    expect(created.body.data.latest.id).toBe('');
    expect(created.body.data).toMatchObject({
      marketGrowth30d: null,
      relativeDelta: null,
      relativePerformanceAvailable: false,
      performance: 'insufficient_data',
      latest: {
        snapshotAvailable: false,
        estimatedSales: null,
        price: null,
        growth30d: null,
        growth30dAvailable: false,
      },
    });
    expect(created.body.data.insight).toMatchObject({ status: '数据不足', confidence: 0, evidence: [] });
    const settings = await request(app).get('/api/settings').expect(200);
    expect(settings.body.data).toMatchObject({ mode: 'empty', defaultMarketId: 'mkt-memory-foam' });
    const marketList = await request(app).get('/api/markets').expect(200);
    expect(marketList.body.data[0].name).toBe('Memory Foam Pillow');
    const marketDetail = await request(app).get('/api/markets/mkt-memory-foam').expect(200);
    expect(marketDetail.body.data).toMatchObject({
      trends: [],
      node: { snapshotAvailable: false, growth30dAvailable: false },
      kpis: { monthlySales: null, monthlyRevenue: null },
      insight: { status: '数据不足', evidence: [] },
    });
    const productDetail = await request(app).get(`/api/owned-products/${created.body.data.id as string}`).expect(200);
    expect(productDetail.body.data).toMatchObject({
      percentiles: { sales: null, price: null, reviews: null, rating: null, growth: null },
      comparisons: {
        market: { growth30d: null },
        direct: { growth30d: null, sampleSize: 0 },
        top20: { growth30d: null, sampleSize: 0 },
      },
    });
  });

  it('keeps empty opportunity research as a pending plan without zero-valued entities', async () => {
    const app = testApp();
    const researched = await request(app).post('/api/opportunity-lab/research').send({
      query: '无数据露营枕组合',
    }).expect(201);

    expect(researched.body.data).toMatchObject({
      opportunities: [],
      tasksCreated: 4,
    });
    expect(researched.body.data.nodes).toHaveLength(4);
    for (const node of researched.body.data.nodes as Array<Record<string, unknown>>) {
      expect(node).toMatchObject({
        snapshotAvailable: false,
        monthlySales: null,
        monthlyRevenue: null,
        growth30d: null,
        growth30dAvailable: false,
        productCount: null,
        avgPrice: null,
        competitionScore: null,
        opportunityScore: null,
        taskStatus: 'pending',
      });
    }
    expect(database?.prepare('SELECT COUNT(*) AS count FROM opportunities').get())
      .toMatchObject({ count: 0 });
    expect(database?.prepare('SELECT COUNT(*) AS count FROM market_nodes').get())
      .toMatchObject({ count: 0 });
    expect(database?.prepare(`
      SELECT COUNT(*) AS count FROM data_tasks WHERE status = 'pending'
    `).get()).toMatchObject({ count: 4 });
    expect(database?.prepare(`
      SELECT opportunity_ids_json FROM research_results
    `).get()).toMatchObject({ opportunity_ids_json: '[]' });
    expect(await request(app).get('/api/settings').then((result) => result.body.data.mode))
      .toBe('empty');
  });
});

describe('workflow mutations', () => {
  it('requires approved V2 jobs before promotion or development advancement', async () => {
    const app = testApp();
    await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);
    const research = await request(app)
      .post('/api/opportunity-lab/research')
      .send({ query: '小学一年级开学用品组合' })
      .expect(201);
    expect(research.body.data.nodes).toHaveLength(4);
    expect(research.body.data.tasksCreated).toBe(4);
    const opportunityId = research.body.data.opportunities[0].id as string;

    await request(app).post(`/api/opportunities/${opportunityId}/watch`).send({}).expect(200);
    await request(app).post(`/api/opportunities/${opportunityId}/promote`).send({}).expect(409);
    const opportunityJob = productResearchFixture();
    Object.assign(opportunityJob, {
      name: 'Opportunity advancement gate',
      type: 'new_opportunity',
      entityType: 'opportunity',
      entityId: opportunityId,
    });
    const createdOpportunityJob = (await request(app).post('/api/research-jobs')
      .send(opportunityJob).expect(201)).body.data;
    const waitingOpportunityJob = (await request(app)
      .post(`/api/research-jobs/${createdOpportunityJob.id}/run`).send({}).expect(200)).body.data;
    await request(app).post(`/api/research-jobs/${createdOpportunityJob.id}/approve`).send({
      decision: 'approved', reason: '只批准进入待开发阶段。', decidedBy: '机会负责人',
    }).expect(201);
    expect(waitingOpportunityJob.status).toBe('waiting_approval');

    const promoted = await request(app).post(`/api/opportunities/${opportunityId}/promote`).send({}).expect(201);
    expect(promoted.body.data.opportunity.status).toBe('promoted');
    const projectId = promoted.body.data.project.id as string;

    await request(app)
      .post(`/api/development-projects/${projectId}/decision`)
      .send({ decision: 'test', reason: '先测小批量', decidedBy: '测试用户' })
      .expect(409);
    const projectJob = productResearchFixture();
    Object.assign(projectJob, {
      name: 'Development advancement gate',
      type: 'adjacent_product',
      entityType: 'development_project',
      entityId: projectId,
    });
    const createdProjectJob = (await request(app).post('/api/research-jobs')
      .send(projectJob).expect(201)).body.data;
    await request(app).post(`/api/research-jobs/${createdProjectJob.id}/run`).send({}).expect(200);
    await request(app).post(`/api/research-jobs/${createdProjectJob.id}/approve`).send({
      decision: 'approved', reason: '批准小批量测试，不授权采购。', decidedBy: '开发负责人',
    }).expect(201);
    const decision = await request(app)
      .post(`/api/development-projects/${projectId}/decision`)
      .send({ decision: 'test', reason: '先测小批量', decidedBy: '测试用户' })
      .expect(201);
    expect(decision.body.data.decision).toMatchObject({ decision: 'test', decidedBy: '测试用户' });
    expect(decision.body.data.status).toBe('test');

    const rejectedOpportunityId = research.body.data.opportunities[1].id as string;
    await request(app).post(`/api/opportunities/${rejectedOpportunityId}/reject`)
      .send({ reason: '竞争门槛过高', decidedBy: '机会审核人' }).expect(200);
    const audit = database?.prepare(`
      SELECT d.reason, d.decided_by, d.ai_insight_id, i.data_version
      FROM decisions d JOIN ai_insights i ON i.id = d.ai_insight_id
      WHERE d.entity_type = 'opportunity' AND d.entity_id = ? AND d.decision = 'reject'
    `).get(rejectedOpportunityId) as {
      reason: string;
      decided_by: string;
      ai_insight_id: string;
      data_version: string;
    } | undefined;
    expect(audit).toMatchObject({ reason: '竞争门槛过高', decided_by: '机会审核人' });
    expect(audit?.ai_insight_id).toBeTruthy();
    expect(audit?.data_version).toBeTruthy();
    const rejected = await request(app).get(`/api/opportunities/${rejectedOpportunityId}`).expect(200);
    expect(rejected.body.data.decision).toMatchObject({
      decision: 'reject',
      reason: '竞争门槛过高',
      decidedBy: '机会审核人',
    });
    expect(rejected.body.data.summary).toContain('决策人：机会审核人');
  });

  it('isolates opportunities by marketplace and blocks cross-market promotion', async () => {
    const app = testApp();
    await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);
    const usOpportunities = await request(app).get('/api/opportunities').expect(200);
    expect(usOpportunities.body.data).toHaveLength(3);
    const usOpportunityId = usOpportunities.body.data[0].id as string;

    await request(app).patch('/api/settings').send({ marketplace: 'CA' }).expect(200);
    expect(await request(app).get('/api/opportunities').then((result) => result.body.data)).toEqual([]);
    expect(await request(app).get('/api/watchlist').then((result) => result.body.data)).toEqual([]);
    await request(app).delete('/api/watchlist/watch-market').expect(404);
    await request(app).get(`/api/opportunities/${usOpportunityId}`).expect(404);
    await request(app).post(`/api/opportunities/${usOpportunityId}/promote`).send({}).expect(404);
    const caDashboard = await request(app).get('/api/dashboard/briefing').expect(200);
    expect(caDashboard.body.data.summaries.opportunities).toEqual({ foundThisWeek: 0, pending: 0, pooled: 0 });

    const caResearch = await request(app).post('/api/opportunity-lab/research')
      .send({ query: '加拿大露营枕组合' }).expect(201);
    const caOpportunityId = caResearch.body.data.opportunities[0].id as string;
    expect(caResearch.body.data.opportunities[0].marketplace).toBe('CA');
    await request(app).patch('/api/settings').send({ marketplace: 'US' }).expect(200);
    expect(await request(app).get('/api/watchlist').then((result) => result.body.data))
      .toContainEqual(expect.objectContaining({ id: 'watch-market' }));
    await request(app).get(`/api/opportunities/${caOpportunityId}`).expect(404);
    await request(app).post(`/api/opportunities/${caOpportunityId}/promote`).send({}).expect(404);
  });

  it('uses the current marketplace and rolls back an owned-product failure atomically', async () => {
    const app = testApp();
    await request(app).patch('/api/settings').send({ marketplace: 'CA' }).expect(200);
    const first = await request(app).post('/api/owned-products').send({
      asin: 'B0ATOMIC01', sku: 'CA-ATOMIC-01', internalName: 'CA 首个 SKU',
      brand: 'Own Brand', title: 'CA Product', marketplace: 'US',
      productType: 'CA Memory Pillow', marketNodeId: 'mkt-ca-first',
      keywords: ['ca pillow'], monitoringEnabled: true,
    }).expect(201);
    expect(first.body.data).toMatchObject({ marketplace: 'CA', marketNodeId: 'mkt-ca-first' });
    const settingsBeforeFailure = await request(app).get('/api/settings').then((result) => result.body.data);

    await request(app).post('/api/owned-products').send({
      asin: 'B0ATOMIC01', sku: 'DUPLICATE', internalName: '重复 SKU',
      brand: 'Own Brand', title: 'Duplicate Product', marketplace: 'US',
      productType: 'Should Roll Back', marketNodeId: 'mkt-should-rollback',
      keywords: ['rollback'], monitoringEnabled: true,
    }).expect(409);
    expect(database?.prepare(`SELECT COUNT(*) AS count FROM products WHERE asin = 'B0ATOMIC01'`).get())
      .toMatchObject({ count: 1 });
    expect(database?.prepare(`SELECT COUNT(*) AS count FROM market_nodes WHERE id = 'mkt-should-rollback'`).get())
      .toMatchObject({ count: 0 });
    expect(await request(app).get('/api/settings').then((result) => result.body.data.defaultMarketId))
      .toBe(settingsBeforeFailure.defaultMarketId);
    const watchlist = await request(app).get('/api/watchlist').expect(200);
    expect(watchlist.body.data.filter((item: { itemType: string }) => item.itemType === 'owned_product')).toHaveLength(1);
  });

  it('never cascades away historical snapshots through the owned-product delete API', async () => {
    const app = testApp();
    await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);
    const before = database?.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE product_id = 'owned-sku-01'
    `).get() as { count: number };
    expect(before.count).toBeGreaterThan(0);

    await request(app).delete('/api/owned-products/owned-sku-01').expect(409);
    expect(database?.prepare(`SELECT 1 AS found FROM products WHERE id = 'owned-sku-01'`).get())
      .toMatchObject({ found: 1 });
    expect(database?.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE product_id = 'owned-sku-01'
    `).get()).toMatchObject({ count: before.count });
  });

  it('still allows deleting a newly configured owned product that has no snapshot history', async () => {
    const app = testApp();
    const created = await request(app).post('/api/owned-products').send({
      asin: 'B0DELETEEMPTY', sku: 'DELETE-EMPTY', brand: 'Own Brand',
      title: 'Snapshotless Product', productType: 'memory_pillow',
      marketNodeId: 'mkt-delete-empty', monitoringEnabled: false,
    }).expect(201);

    await request(app).delete(`/api/owned-products/${created.body.data.id as string}`).expect(200);
    expect(database?.prepare('SELECT 1 AS found FROM products WHERE id = ?')
      .get(created.body.data.id as string)).toBeUndefined();
  });

  it('creates development research and monitoring atomically in the current marketplace', async () => {
    const app = testApp();
    await request(app).patch('/api/settings').send({ marketplace: 'CA' }).expect(200);
    database?.exec(`
      CREATE TRIGGER fail_test_insight BEFORE INSERT ON ai_insights
      BEGIN
        SELECT RAISE(ABORT, 'forced insight failure');
      END;
    `);
    await request(app).post('/api/development-projects').send({
      name: '必须完整回滚的项目', productType: 'test', keywords: ['rollback'],
      marketplace: 'US', supplyChainRelation: '测试',
    }).expect(400);
    expect(database?.prepare(`SELECT COUNT(*) AS count FROM development_projects`).get()).toMatchObject({ count: 0 });
    expect(database?.prepare(`SELECT COUNT(*) AS count FROM data_tasks`).get()).toMatchObject({ count: 0 });
    expect(database?.prepare(`SELECT COUNT(*) AS count FROM watchlist_items`).get()).toMatchObject({ count: 0 });
    expect(database?.prepare(`SELECT COUNT(*) AS count FROM market_nodes`).get()).toMatchObject({ count: 0 });
    database?.exec('DROP TRIGGER fail_test_insight');

    const created = await request(app).post('/api/development-projects').send({
      name: '加拿大坐垫项目', productType: 'seat_cushion', keywords: ['seat cushion'],
      marketplace: 'US', supplyChainRelation: '现有海绵供应链',
    }).expect(201);
    expect(created.body.data).toMatchObject({
      marketplace: 'CA',
      marketSize: null,
      growth30d: null,
      competitionScore: null,
      opportunityScore: null,
      scoreBreakdown: null,
    });
    const projectId = created.body.data.id as string;
    expect(database?.prepare(`
      SELECT marketplace, market_size, growth_30d, competition_score, opportunity_score,
        score_breakdown_json
      FROM development_projects WHERE id = ?
    `).get(projectId)).toMatchObject({
      marketplace: 'CA',
      market_size: null,
      growth_30d: null,
      competition_score: null,
      opportunity_score: null,
      score_breakdown_json: 'null',
    });
    const tasks = await request(app).get('/api/data-tasks').expect(200);
    expect(tasks.body.data.some((task: { target: string }) => task.target === projectId)).toBe(true);
    const watchlist = await request(app).get('/api/watchlist').expect(200);
    expect(watchlist.body.data).toContainEqual(expect.objectContaining({
      itemType: 'development_project', itemId: projectId,
    }));
  });

  it('refreshes analyzable watch targets and fails unsupported types without fake success', async () => {
    const app = testApp();
    await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);
    const developmentTask = await request(app).post('/api/data-tasks/run').send({
      taskType: 'watchlist_refresh', target: 'dev-lumbar',
      source: 'configured_adapter', watchlistId: 'watch-lumbar',
    }).expect(201);
    expect(developmentTask.body.data).toMatchObject({ status: 'success', source: '演示数据 / Mock Adapter' });
    expect(database?.prepare('SELECT source_id FROM data_tasks WHERE id = ?').get(developmentTask.body.data.id))
      .toMatchObject({ source_id: 'source-mock' });

    const watched = await request(app).post('/api/opportunities/opp-school-kit/watch').send({}).expect(200);
    const opportunityTask = await request(app).post('/api/data-tasks/run').send({
      taskType: 'watchlist_refresh', target: 'opp-school-kit', source: 'configured_adapter',
      watchlistId: watched.body.data.watchlistItem.id,
    }).expect(201);
    expect(opportunityTask.body.data).toMatchObject({ status: 'success', success: 1, failed: 0 });

    const unsupported = await request(app).post('/api/watchlist').send({
      itemType: 'unsupported_entity', itemId: 'unsupported-1', name: '不支持的监控对象',
    }).expect(201);
    const failed = await request(app).post('/api/data-tasks/run').send({
      taskType: 'watchlist_refresh', target: 'unsupported-1', source: 'configured_adapter',
      watchlistId: unsupported.body.data.id,
    }).expect(201);
    expect(failed.body.data).toMatchObject({ status: 'failed', success: 0, failed: 1 });
    expect(failed.body.data.errorLog).toContain('暂不支持刷新监控类型');
  });

  it('updates watch frequency and status only inside the current marketplace', async () => {
    const app = testApp();
    await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);
    const paused = await request(app).patch('/api/watchlist/watch-market').send({
      frequency: 'weekly', status: 'paused',
    }).expect(200);
    expect(paused.body.data).toMatchObject({ frequency: 'weekly', status: 'paused', nextRunAt: null });
    const active = await request(app).patch('/api/watchlist/watch-market').send({ status: 'active' }).expect(200);
    expect(active.body.data.status).toBe('active');
    expect(active.body.data.nextRunAt).toBeTruthy();

    await request(app).patch('/api/settings').send({ marketplace: 'CA' }).expect(200);
    await request(app).patch('/api/watchlist/watch-market').send({ status: 'paused' }).expect(404);
    await request(app).patch('/api/settings').send({ marketplace: 'US', role: 'viewer' }).expect(200);
    await request(app).patch('/api/watchlist/watch-market').send({ status: 'paused' }).expect(403);
  });

  it('preserves Demo and real observations until explicit scoped Demo cleanup', async () => {
    const app = testApp();
    await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);
    const demoSnapshotCount = (database!.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE source_type = 'mock'
    `).get() as { count: number }).count;
    const csv = [
      `ASIN,SKU,Brand,Title,MarketName,Keywords,MonitoringEnabled,${COMPLETE_PRODUCT_FIELDS}`,
      `B0LIVE0001,LIVE-01,Live Brand,Imported Pillow,Imported Memory Foam,pillow|foam,true,${completeProductValues(39.99, 900, 6.2)}`,
    ].join('\n');
    const imported = await previewAndConfirmCsv(app, csv, 'products.csv', { entityType: 'product' });
    expect(imported.body.data).toMatchObject({ rowCount: 1, successCount: 1, failureCount: 0 });
    expect(imported.body.meta.mode).toBe('demo');
    const products = await request(app).get('/api/owned-products').expect(200);
    expect(products.body.data).toHaveLength(5);
    expect((database!.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE source_type = 'mock'
    `).get() as { count: number }).count).toBe(demoSnapshotCount);
    const importedProduct = products.body.data.find((item: { asin: string }) => item.asin === 'B0LIVE0001');
    expect(importedProduct.latest.provenance.sourceType).toBe('import');
    expect(importedProduct).toMatchObject({
      monitoringEnabled: true,
      keywords: ['pillow', 'foam'],
      latest: { snapshotAvailable: true, growth30d: null, growth30dAvailable: false },
      relativePerformanceAvailable: false,
      performance: 'insufficient_data',
    });

    const updateCsv = [
      `ASIN,${COMPLETE_PRODUCT_FIELDS}`,
      `B0LIVE0001,${completeProductValues(41.99, 950, 7.1, '2026-09-10')}`,
    ].join('\n');
    await previewAndConfirmCsv(app, updateCsv, 'snapshot.csv', { entityType: 'product' });
    const updatedProducts = await request(app).get('/api/owned-products').expect(200);
    expect(updatedProducts.body.data.find((item: { asin: string }) => item.asin === 'B0LIVE0001'))
      .toMatchObject({ monitoringEnabled: true, keywords: ['pillow', 'foam'] });

    await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);
    await request(app).post('/api/settings/demo').send({ enabled: false }).expect(409);
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'ys-demo-cleanup-'));
    const migrationApp = createApp({ database: database!, backupDirectory: temporaryDirectory });
    await request(migrationApp).post('/api/go-live/backup').send({}).expect(201);
    await request(migrationApp).post('/api/go-live/cleanup')
      .send({ confirmation: 'CLEAR DEMO DATA' }).expect(200);
    await request(migrationApp).post('/api/settings/demo').send({ enabled: false }).expect(200);
    expect(await request(app).get('/api/owned-products').then((result) => result.body.data))
      .toEqual([expect.objectContaining({ asin: 'B0LIVE0001' })]);
    expect(database!.prepare(`SELECT COUNT(*) AS count FROM products WHERE is_owned = 1`).get())
      .toEqual({ count: 5 });
    expect(database!.prepare(`SELECT COUNT(*) AS count FROM products
      WHERE is_owned = 1 AND source_type = 'mock' AND status = 'inactive'`).get())
      .toEqual({ count: 4 });
    expect((database!.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE source_type = 'mock'
    `).get() as { count: number }).count).toBe(0);
    expect((database!.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE source_type = 'import'
    `).get() as { count: number }).count).toBe(2);
  });

  it('keeps imported products and market nodes in the same marketplace', async () => {
    const app = testApp();
    await request(app).patch('/api/settings').send({ marketplace: 'CA' }).expect(200);
    const currentMarketplaceCsv = [
      `ASIN,SKU,Brand,Title,MarketNodeId,MarketName,${COMPLETE_PRODUCT_FIELDS}`,
      `B0CAIMPORT1,CA-I1,CA Brand,CA Import,mkt-ca-import,CA Imported Market,${completeProductValues(45, 320, 3.4)}`,
    ].join('\n');
    await previewAndConfirmCsv(app, currentMarketplaceCsv, 'ca.csv', { entityType: 'product' });
    const caProducts = await request(app).get('/api/owned-products').expect(200);
    expect(caProducts.body.data[0]).toMatchObject({ asin: 'B0CAIMPORT1', marketplace: 'CA' });
    expect(database?.prepare('SELECT marketplace FROM market_nodes WHERE id = ?').get('mkt-ca-import'))
      .toMatchObject({ marketplace: 'CA' });

    const collisionCsv = [
      `ASIN,SKU,Brand,Title,Marketplace,MarketNodeId,MarketName,${COMPLETE_PRODUCT_FIELDS}`,
      `B0USIMPORT1,US-I1,US Brand,US Import,US,mkt-shared-id,US Shared Market,${completeProductValues(30, 500, 4.1)}`,
      `B0CAIMPORT2,CA-I2,CA Brand,CA Collision,CA,mkt-shared-id,CA Shared Market,${completeProductValues(42, 410, 2.8)}`,
    ].join('\n');
    const collision = await previewAndConfirmCsv(app, collisionCsv, 'collision.csv', { entityType: 'product' });
    expect(collision.body.data).toMatchObject({ rowCount: 2, successCount: 1, failureCount: 1 });
    expect(collision.body.data.errors[0]).toContain('US 与当前工作区站点 CA 不一致');
    expect(database?.prepare(`SELECT COUNT(*) AS count FROM products WHERE asin = 'B0USIMPORT1'`).get())
      .toMatchObject({ count: 0 });
    expect(database?.prepare('SELECT marketplace FROM market_nodes WHERE id = ?').get('mkt-shared-id'))
      .toMatchObject({ marketplace: 'CA' });
  });

  it('rejects incomplete snapshots before creating product or market entities', async () => {
    const app = testApp();
    const partialProduct = [
      'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price',
      'B0PARTIAL1,P-1,Brand,Partial Product,mkt-partial-product,Partial Product Market,29.99',
    ].join('\n');
    const productImport = await previewAndConfirmCsv(app, partialProduct, 'partial-product.csv', { entityType: 'product' });
    expect(productImport.body.data).toMatchObject({ successCount: 0, failureCount: 1 });
    expect(productImport.body.data.errors[0]).toContain('缺少或无法解析字段 estimatedsales');

    const partialMarket = [
      'MarketNodeId,MarketName,MonthlySales,AvgPrice,Date',
      'mkt-partial-market,Partial Market,1000,30,2026-09-09',
    ].join('\n');
    const marketImport = await previewAndConfirmCsv(app, partialMarket, 'partial-market.csv', { entityType: 'market' });
    expect(marketImport.body.data).toMatchObject({ successCount: 0, failureCount: 1 });
    expect(marketImport.body.data.errors[0]).toContain('缺少或无法解析字段 productcount');

    expect(database?.prepare('SELECT COUNT(*) AS count FROM products').get()).toMatchObject({ count: 0 });
    expect(database?.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get()).toMatchObject({ count: 0 });
    expect(database?.prepare('SELECT COUNT(*) AS count FROM market_nodes').get()).toMatchObject({ count: 0 });
    expect(database?.prepare('SELECT COUNT(*) AS count FROM market_snapshots').get()).toMatchObject({ count: 0 });
    expect(await request(app).get('/api/settings').then((result) => result.body.data.mode)).toBe('empty');
  });

  it('waits for a historical market baseline before deriving scores or persisting analysis', async () => {
    const app = testApp();
    const header = [
      'MarketNodeId', 'MarketName', 'Marketplace', 'ProductCount', 'SellerCount',
      'BrandCount', 'MonthlySales', 'AvgPrice', 'MedianPrice', 'AvgRating',
      'MedianReviews', 'Top10Share', 'Top20Share', 'NewProductShare',
      'Confidence', 'IsEstimated', 'Date',
    ].join(',');
    const baseline = [
      'mkt-baseline-guard', 'Baseline Guard Market', 'US', 100, 70, 35, 1_000,
      30, 29, 4.2, 180, 25, 42, 12, 0.9, false, '2026-08-10',
    ].join(',');
    const current = [
      'mkt-baseline-guard', 'Baseline Guard Market', 'US', 110, 74, 38, 1_200,
      31, 30, 4.3, 190, 27, 44, 14, 0.92, false, '2026-09-09',
    ].join(',');

    const firstImport = await previewAndConfirmCsv(app, [header, baseline].join('\n'),
      'market-baseline.csv', { entityType: 'market' });
    expect(firstImport.body.data).toMatchObject({ successCount: 1, failureCount: 0 });
    const firstRead = await request(app).get('/api/markets/mkt-baseline-guard').expect(200);
    expect(firstRead.body.data.node).toMatchObject({
      status: '等待30D对照', growth30d: null, growth30dAvailable: false,
    });
    expect(database?.prepare(`
      SELECT COUNT(*) AS count FROM ai_insights
      WHERE entity_type = 'market' AND entity_id = 'mkt-baseline-guard'
    `).get()).toMatchObject({ count: 0 });

    const secondImport = await previewAndConfirmCsv(app, [header, current].join('\n'),
      'market-current.csv', { entityType: 'market' });
    expect(secondImport.body.data).toMatchObject({ successCount: 1, failureCount: 0 });
    const secondRead = await request(app).get('/api/markets/mkt-baseline-guard').expect(200);
    expect(secondRead.body.data.node).toMatchObject({ growth30d: 20, growth30dAvailable: true });
    expect(secondRead.body.data.node.status).not.toBe('等待30D对照');
    expect(database?.prepare(`
      SELECT COUNT(*) AS count FROM ai_insights
      WHERE entity_type = 'market' AND entity_id = 'mkt-baseline-guard'
    `).get()).toMatchObject({ count: 1 });
  });

  it('returns deterministic analysis only as a non-persisted candidate preview', async () => {
    const app = testApp();
    await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);
    const before = database?.prepare('SELECT COUNT(*) AS count FROM ai_insights').get() as { count: number };
    const first = await request(app)
      .post('/api/ai/analyze')
      .send({ entityType: 'market', entityId: 'mkt-cervical' })
      .expect(200);
    expect(first.body.data).toMatchObject({
      cached: false,
      formal: false,
      notice: expect.stringContaining('不是正式 Research Job 结论'),
      insight: { insightType: 'candidate_preview', status: '非正式候选' },
    });
    const second = await request(app)
      .post('/api/ai/analyze')
      .send({ entityType: 'market', entityId: 'mkt-cervical' })
      .expect(200);
    expect(second.body.data.cached).toBe(false);
    expect(second.body.data.insight.id).not.toBe(first.body.data.insight.id);
    expect(database?.prepare('SELECT COUNT(*) AS count FROM ai_insights').get()).toEqual(before);
  });

  it('binds AI questions to the provided entity context', async () => {
    const app = testApp();
    await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);
    const before = database?.prepare('SELECT COUNT(*) AS count FROM ai_insights').get();
    const result = await request(app).post('/api/ai/analyze').send({
      question: '这个 SKU 为什么是当前状态？',
      entityType: 'owned_product',
      entityId: 'owned-sku-02',
    }).expect(200);
    expect(result.body.data.insight).toMatchObject({
      entityType: 'owned_product',
      entityId: 'owned-sku-02',
      insightType: 'workflow_required',
    });
    expect(result.body.data).toMatchObject({ formal: false, cached: false });
    expect(database?.prepare('SELECT COUNT(*) AS count FROM ai_insights').get()).toEqual(before);
  });

  it('enforces the viewer role at mutation boundaries', async () => {
    const app = testApp();
    await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);
    await request(app).patch('/api/settings').send({ role: 'viewer' }).expect(200);

    const read = await request(app).get('/api/opportunities').expect(200);
    expect(read.body.data.length).toBeGreaterThan(0);
    const mutation = await request(app)
      .post('/api/opportunity-lab/research')
      .send({ query: '只读用户不能创建研究' })
      .expect(403);
    expect(mutation.body.error).toContain('Viewer');
    await request(app).post('/api/settings/demo').send({ enabled: false }).expect(403);
    await request(app).patch('/api/settings').send({ currency: 'EUR' }).expect(403);
    await request(app).patch('/api/watchlist/watch-market').send({ status: 'paused' }).expect(403);
    await request(app).patch('/api/settings').send({ role: 'admin' }).expect(200);
  });

  it('does not let deterministic insights masquerade as an external AI model', async () => {
    const app = testApp();
    await request(app).patch('/api/settings').send({ aiModel: 'gpt-5' }).expect(400);
    const settings = await request(app).get('/api/settings').expect(200);
    expect(settings.body.data.aiModel).toBe('rule-engine-v1');
    await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);
    const analyzed = await request(app).post('/api/ai/analyze').send({
      entityType: 'market', entityId: 'mkt-cervical',
    }).expect(200);
    expect(analyzed.body.data.insight.model).toBe('rule-engine-v1');
    expect(analyzed.body.data).toMatchObject({ formal: false, cached: false });
  });

  it('does not fabricate mock snapshots when live refresh has no real adapter', async () => {
    const app = testApp();
    const csv = [
      `ASIN,SKU,Brand,Title,MarketName,${COMPLETE_PRODUCT_FIELDS}`,
      `B0LIVE0002,LIVE-02,Live Brand,Real Imported Pillow,Real Market,${completeProductValues(39.99, 700, 4.2)}`,
    ].join('\n');
    await previewAndConfirmCsv(app, csv, 'live.csv', { entityType: 'product' });
    const product = await request(app).get('/api/owned-products').then((result) => result.body.data[0]);
    const before = await request(app).get(`/api/owned-products/${product.id}/snapshots`).expect(200);
    const task = await request(app).post('/api/data-tasks/run')
      .send({ taskType: 'manual_refresh', target: product.id, source: 'Mock Adapter' }).expect(201);
    expect(task.body.data.status).toBe('failed');
    expect(task.body.data.errorLog).toContain('未写入任何 Mock');
    const after = await request(app).get(`/api/owned-products/${product.id}/snapshots`).expect(200);
    expect(after.body.data).toHaveLength(before.body.data.length);
  });

  it('keeps live development analysis explicitly inconclusive without market metrics', async () => {
    const app = testApp();
    const csv = [
      `ASIN,SKU,Brand,Title,MarketName,${COMPLETE_PRODUCT_FIELDS}`,
      `B0LIVE0003,LIVE-03,Live Brand,Imported Product,Imported Market,${completeProductValues(28, 400, 1.6)}`,
    ].join('\n');
    await previewAndConfirmCsv(app, csv, 'live.csv', { entityType: 'product' });
    const project = await request(app).post('/api/development-projects').send({
      name: '尚未采集的邻近产品',
      productType: 'adjacent',
      keywords: ['adjacent product'],
      notes: '',
      marketplace: 'US',
      supplyChainRelation: '待评估',
    }).expect(201);
    expect(project.body.data.insight).toMatchObject({ status: '数据不足', confidence: 0.1, evidence: [] });
    expect(project.body.data.insight.recommendedActions[0]).toContain('导入');
  });

  it('scopes markets and products by marketplace and adjusts the default market', async () => {
    const app = testApp();
    const usCsv = [
      `ASIN,SKU,Brand,Title,MarketName,Marketplace,${COMPLETE_PRODUCT_FIELDS}`,
      `B0USA00001,US-01,Brand US,US Pillow,US Memory Market,US,${completeProductValues(35, 500, 4.8)}`,
    ].join('\n');
    await previewAndConfirmCsv(app, usCsv, 'us-market.csv', { entityType: 'product' });
    expect(await request(app).get('/api/owned-products').then((result) => result.body.data)).toHaveLength(1);

    await request(app).patch('/api/settings').send({ marketplace: 'CA' }).expect(200);
    const caCsv = [
      `ASIN,SKU,Brand,Title,MarketName,Marketplace,${COMPLETE_PRODUCT_FIELDS}`,
      `B0CAN00001,CA-01,Brand CA,CA Pillow,CA Memory Market,CA,${completeProductValues(48, 420, 3.7)}`,
    ].join('\n');
    await previewAndConfirmCsv(app, caCsv, 'ca-market.csv', { entityType: 'product' });
    const settings = await request(app).get('/api/settings').expect(200);
    expect(settings.body.data.defaultMarketId).not.toBe('');
    const markets = await request(app).get('/api/markets').expect(200);
    expect(markets.body.data).toHaveLength(1);
    expect(markets.body.data[0].marketplace).toBe('CA');
    const products = await request(app).get('/api/owned-products').expect(200);
    expect(products.body.data).toHaveLength(1);
    expect(products.body.data[0].asin).toBe('B0CAN00001');

    await request(app).patch('/api/settings').send({ marketplace: 'US' }).expect(200);
    expect(await request(app).get('/api/owned-products').then((result) => result.body.data))
      .toEqual([expect.objectContaining({ asin: 'B0USA00001', marketplace: 'US' })]);
  });

  it('uses a 30-day baseline after an additional same-day market sync', async () => {
    const app = testApp();
    await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);
    const before = await request(app).get('/api/markets/mkt-memory-foam').expect(200);
    expect(before.body.data.node.growth30d).toBe(8.2);
    const snapshotsBefore = before.body.data.trends.length as number;
    await request(app).post('/api/data-tasks/run')
      .send({ taskType: 'market_refresh', target: 'mkt-memory-foam', source: 'Mock Adapter' })
      .expect(201);
    const after = await request(app).get('/api/markets/mkt-memory-foam').expect(200);
    expect(after.body.data.trends).toHaveLength(snapshotsBefore + 1);
    expect(after.body.data.node.growth30d).toBeGreaterThan(8);
  });
});
