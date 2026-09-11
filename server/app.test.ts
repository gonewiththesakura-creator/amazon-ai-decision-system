import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { AppSettings, DashboardData, MarketDetail, OwnedProductSummary } from '../shared/types.js';
import { createApp } from './app.js';
import { openDatabase, type AppDatabase } from './database/database.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function testApp() {
  database = openDatabase(':memory:');
  return createApp({ database });
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
    expect(settings.body.data).toMatchObject({ mode: 'live', defaultMarketId: 'mkt-memory-foam' });
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
      .toBe('live');
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

  it('replaces demo rows on real import and never lets Demo overwrite live data', async () => {
    const app = testApp();
    await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);
    const csv = [
      `ASIN,SKU,Brand,Title,MarketName,Keywords,MonitoringEnabled,${COMPLETE_PRODUCT_FIELDS}`,
      `B0LIVE0001,LIVE-01,Live Brand,Imported Pillow,Imported Memory Foam,pillow|foam,true,${completeProductValues(39.99, 900, 6.2)}`,
    ].join('\n');
    const imported = await request(app)
      .post('/api/import/csv')
      .field('entityType', 'product')
      .attach('file', Buffer.from(csv), 'products.csv')
      .expect(201);
    expect(imported.body.data).toMatchObject({ rowCount: 1, successCount: 1, failureCount: 0 });
    expect(imported.body.meta.mode).toBe('live');
    const products = await request(app).get('/api/owned-products').expect(200);
    expect(products.body.data).toHaveLength(1);
    expect(products.body.data[0].latest.provenance.sourceType).toBe('import');
    expect(products.body.data[0]).toMatchObject({
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
    await request(app)
      .post('/api/import/csv')
      .field('entityType', 'product')
      .attach('file', Buffer.from(updateCsv), 'snapshot.csv')
      .expect(201);
    const updatedProducts = await request(app).get('/api/owned-products').expect(200);
    expect(updatedProducts.body.data[0]).toMatchObject({ monitoringEnabled: true, keywords: ['pillow', 'foam'] });

    await request(app).post('/api/settings/demo').send({ enabled: true }).expect(409);
    await request(app).post('/api/settings/demo').send({ enabled: false }).expect(200);
    expect(await request(app).get('/api/owned-products').then((result) => result.body.data)).toHaveLength(1);
  });

  it('keeps imported products and market nodes in the same marketplace', async () => {
    const app = testApp();
    await request(app).patch('/api/settings').send({ marketplace: 'CA' }).expect(200);
    const currentMarketplaceCsv = [
      `ASIN,SKU,Brand,Title,MarketNodeId,MarketName,${COMPLETE_PRODUCT_FIELDS}`,
      `B0CAIMPORT1,CA-I1,CA Brand,CA Import,mkt-ca-import,CA Imported Market,${completeProductValues(45, 320, 3.4)}`,
    ].join('\n');
    await request(app).post('/api/import/csv').field('entityType', 'product')
      .attach('file', Buffer.from(currentMarketplaceCsv), 'ca.csv').expect(201);
    const caProducts = await request(app).get('/api/owned-products').expect(200);
    expect(caProducts.body.data[0]).toMatchObject({ asin: 'B0CAIMPORT1', marketplace: 'CA' });
    expect(database?.prepare('SELECT marketplace FROM market_nodes WHERE id = ?').get('mkt-ca-import'))
      .toMatchObject({ marketplace: 'CA' });

    const collisionCsv = [
      `ASIN,SKU,Brand,Title,Marketplace,MarketNodeId,MarketName,${COMPLETE_PRODUCT_FIELDS}`,
      `B0USIMPORT1,US-I1,US Brand,US Import,US,mkt-shared-id,US Shared Market,${completeProductValues(30, 500, 4.1)}`,
      `B0CAIMPORT2,CA-I2,CA Brand,CA Collision,CA,mkt-shared-id,CA Shared Market,${completeProductValues(42, 410, 2.8)}`,
    ].join('\n');
    const collision = await request(app).post('/api/import/csv').field('entityType', 'product')
      .attach('file', Buffer.from(collisionCsv), 'collision.csv').expect(201);
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
    const productImport = await request(app).post('/api/import/csv').field('entityType', 'product')
      .attach('file', Buffer.from(partialProduct), 'partial-product.csv').expect(201);
    expect(productImport.body.data).toMatchObject({ successCount: 0, failureCount: 1 });
    expect(productImport.body.data.errors[0]).toContain('缺少或无法解析字段 estimatedsales');

    const partialMarket = [
      'MarketNodeId,MarketName,MonthlySales,AvgPrice,Date',
      'mkt-partial-market,Partial Market,1000,30,2026-09-09',
    ].join('\n');
    const marketImport = await request(app).post('/api/import/csv').field('entityType', 'market')
      .attach('file', Buffer.from(partialMarket), 'partial-market.csv').expect(201);
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

    const firstImport = await request(app).post('/api/import/csv').field('entityType', 'market')
      .attach('file', Buffer.from([header, baseline].join('\n')), 'market-baseline.csv').expect(201);
    expect(firstImport.body.data).toMatchObject({ successCount: 1, failureCount: 0 });
    const firstRead = await request(app).get('/api/markets/mkt-baseline-guard').expect(200);
    expect(firstRead.body.data.node).toMatchObject({
      status: '等待30D对照', growth30d: null, growth30dAvailable: false,
    });
    expect(database?.prepare(`
      SELECT COUNT(*) AS count FROM ai_insights
      WHERE entity_type = 'market' AND entity_id = 'mkt-baseline-guard'
    `).get()).toMatchObject({ count: 0 });

    const secondImport = await request(app).post('/api/import/csv').field('entityType', 'market')
      .attach('file', Buffer.from([header, current].join('\n')), 'market-current.csv').expect(201);
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
    await request(app).post('/api/import/csv').field('entityType', 'product')
      .attach('file', Buffer.from(csv), 'live.csv').expect(201);
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
    await request(app).post('/api/import/csv').field('entityType', 'product')
      .attach('file', Buffer.from(csv), 'live.csv').expect(201);
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
    await request(app).post('/api/import/csv').field('entityType', 'product')
      .attach('file', Buffer.from(usCsv), 'us-market.csv').expect(201);
    expect(await request(app).get('/api/owned-products').then((result) => result.body.data)).toHaveLength(1);

    await request(app).patch('/api/settings').send({ marketplace: 'CA' }).expect(200);
    const caCsv = [
      `ASIN,SKU,Brand,Title,MarketName,Marketplace,${COMPLETE_PRODUCT_FIELDS}`,
      `B0CAN00001,CA-01,Brand CA,CA Pillow,CA Memory Market,CA,${completeProductValues(48, 420, 3.7)}`,
    ].join('\n');
    await request(app).post('/api/import/csv').field('entityType', 'product')
      .attach('file', Buffer.from(caCsv), 'ca-market.csv').expect(201);
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
