import { readFileSync } from 'node:fs';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ExecutiveDashboardViewModel,
  ResearchJobDetail,
} from '../shared/types.js';
import { createApp } from './app.js';
import { openDatabase, type AppDatabase } from './database/database.js';
import { buildIndexedSeries, indexTrendSeries } from './services/executive-dashboard-service.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function testApp(): Express {
  database = openDatabase(':memory:');
  return createApp({ database });
}

async function enableDemo(app: Express): Promise<void> {
  await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);
}

function uShapedFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    new URL('../examples/research-job-u-shaped.json', import.meta.url),
    'utf8',
  )) as Record<string, unknown>;
}

async function createAndRun(
  app: Express,
  body: Record<string, unknown>,
): Promise<ResearchJobDetail> {
  const created = await request(app).post('/api/research-jobs').send(body).expect(201);
  const completed = await request(app)
    .post(`/api/research-jobs/${created.body.data.id as string}/run`)
    .send({})
    .expect(200);
  return completed.body.data as ResearchJobDetail;
}

describe('executive dashboard indexing', () => {
  it('uses the first valid positive point as 100 and ignores invalid leading observations', () => {
    expect(indexTrendSeries([
      { date: '2026-01-01', value: null },
      { date: '2026-01-02', value: 0 },
      { date: 'invalid-date', value: 99 },
      { date: '2026-01-03', value: 50 },
      { date: '2026-01-04', value: 75 },
    ])).toEqual([
      { date: '2026-01-03', index: 100 },
      { date: '2026-01-04', index: 150 },
    ]);
  });

  it('does not create a series from a null, zero, invalid, or single-point baseline', () => {
    expect(indexTrendSeries([
      { date: '2026-01-01', value: null },
      { date: '2026-01-02', value: 0 },
      { date: '2026-01-03', value: Number.NaN },
    ])).toBeNull();
    expect(indexTrendSeries([{ date: '2026-01-03', value: 10 }])).toBeNull();
  });

  it('does not let an invalid future observation move the shared range anchor', () => {
    expect(buildIndexedSeries([
      {
        id: 'market', label: '市场', kind: 'market',
        points: [
          { date: '2026-08-01', value: 100 },
          { date: '2026-08-31', value: 120 },
        ],
      },
      {
        id: 'invalid-future', label: '缺失序列', kind: 'owned_sku',
        points: [{ date: '2099-01-01', value: null }],
      },
    ], '30D')).toEqual([{
      id: 'market', label: '市场', kind: 'market',
      points: [
        { date: '2026-08-01', index: 100 },
        { date: '2026-08-31', index: 120 },
      ],
    }]);
  });

  it('keeps a real zero observation after a positive baseline', () => {
    expect(buildIndexedSeries([{
      id: 'market', label: '市场', kind: 'market',
      points: [
        { date: '2026-08-01', value: 100 },
        { date: '2026-08-31', value: 0 },
      ],
    }], '30D')).toEqual([{
      id: 'market', label: '市场', kind: 'market',
      points: [
        { date: '2026-08-01', index: 100 },
        { date: '2026-08-31', index: 0 },
      ],
    }]);
  });
});

describe('GET /api/dashboard/executive', () => {
  it('aggregates the scoped market, four SKUs, saved competitor facts, and real distributions', async () => {
    const app = testApp();
    await enableDemo(app);

    const response = await request(app).get('/api/dashboard/executive').expect(200);
    const dashboard = response.body.data as ExecutiveDashboardViewModel;

    expect(dashboard).toMatchObject({
      range: '30D',
      marketplace: 'US',
      market: { id: 'mkt-memory-foam', name: 'Memory Foam Pillow' },
      kpis: {
        marketGrowth: 8.2,
        marketGrowthLabel: '稳定增长',
        totalSkus: 4,
        fastGrowthCompetitors: 2,
      },
      dataStatus: { status: 'normal', label: '正常', isDemo: true },
      skuFocus: null,
    });
    expect(dashboard.trendComparison).toHaveLength(5);
    expect(dashboard.trendComparison.every((series) => (
      series.points.length >= 2 && series.points[0].index === 100
    ))).toBe(true);
    expect(dashboard.ownedSkuPerformance.map((item) => item.relativeDelta)).toEqual(
      [...dashboard.ownedSkuPerformance.map((item) => item.relativeDelta)]
        .sort((left, right) => (right ?? Number.NEGATIVE_INFINITY) - (left ?? Number.NEGATIVE_INFINITY)),
    );
    expect(dashboard.marketDistribution.concentration.reduce((sum, item) => sum + item.value, 0))
      .toBeCloseTo(100, 1);
    expect(dashboard.marketDistribution.priceBands.length).toBeGreaterThan(0);
    expect(dashboard.fastGrowthCompetitors.map((item) => item.id)).toEqual([
      'competitor-08', 'competitor-04', 'competitor-06', 'competitor-07',
      'competitor-01', 'competitor-05', 'competitor-03', 'competitor-02',
    ]);
    expect(dashboard.fastGrowthCompetitors).toHaveLength(8);
    expect(dashboard.fastGrowthCompetitors.find((item) => item.id === 'competitor-06')?.tags)
      .toContain('直接竞品');
    expect(dashboard.kpis.fastGrowthCompetitors).toBe(2);
    expect(dashboard.dailyInsights).toEqual([]);
    expect(dashboard.developmentOpportunities).toHaveLength(3);
    expect(dashboard.developmentOpportunities.every((item) => (
      item.status === 'needs_data' && item.score === null
    ))).toBe(true);
  });

  it('omits short-range lines without changing the deterministic 30D market KPI', async () => {
    const app = testApp();
    await enableDemo(app);

    const response = await request(app).get('/api/dashboard/executive?range=7D').expect(200);
    const dashboard = response.body.data as ExecutiveDashboardViewModel;
    expect(dashboard.range).toBe('7D');
    expect(dashboard.trendComparison).toEqual([]);
    expect(dashboard.kpis).toMatchObject({
      marketGrowth: 8.2,
      marketGrowthLabel: '稳定增长',
    });
    await request(app).get('/api/dashboard/executive?range=BAD').expect(400);
  });

  it('returns a null 30D KPI instead of zero when the market has no valid baseline', async () => {
    const app = testApp();
    await request(app).post('/api/owned-products').send({
      asin: 'B0NOBASE01',
      sku: 'NO-BASE-01',
      internalName: '无基线 SKU',
      brand: 'Traceable',
      title: 'Memory Foam Pillow Without Baseline',
      productType: 'memory_foam_pillow',
      marketNodeId: 'mkt-no-baseline',
      keywords: ['memory foam pillow'],
    }).expect(201);

    const dashboard = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(dashboard.market).toMatchObject({ id: 'mkt-no-baseline' });
    expect(dashboard.kpis).toMatchObject({
      marketGrowth: null,
      marketGrowthLabel: '历史数据不足',
    });
    expect(dashboard.trendComparison).toEqual([]);
  });

  it('reports a failed latest sync while retaining all prior legal snapshots', async () => {
    const app = testApp();
    await enableDemo(app);
    const before = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    database!.prepare(`
      INSERT INTO data_tasks (
        id, name, source_id, task_type, target, source, status, started_at, completed_at,
        total, success, failed, error_log, created_at, marketplace
      ) VALUES (
        'dashboard-latest-failed', '最新同步失败', 'source-mock', 'market_refresh',
        'mkt-memory-foam', 'Test Adapter', 'failed', '2099-01-01T00:00:00Z',
        '2099-01-01T00:01:00Z', 1, 0, 1, 'fixture failure',
        '2099-01-01T00:00:00Z', 'US'
      )
    `).run();

    const after = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(after.dataStatus).toMatchObject({
      status: 'failed',
      label: '同步失败',
      message: expect.stringContaining('上一次合法快照'),
      updatedAt: before.dataStatus.updatedAt,
    });
    expect(after.trendComparison).toEqual(before.trendComparison);
    expect(after.kpis.marketGrowth).toBe(before.kpis.marketGrowth);
  });

  it('treats a partial task at the last successful sync timestamp as current', async () => {
    const app = testApp();
    await enableDemo(app);
    const before = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(before.dataStatus.updatedAt).toEqual(expect.any(String));
    database!.prepare(`
      INSERT INTO data_tasks (
        id, name, source_id, task_type, target, source, status, started_at, completed_at,
        total, success, failed, error_log, created_at, marketplace
      ) VALUES (
        'dashboard-current-partial', '当前同步部分完成', 'source-mock', 'market_refresh',
        'mkt-memory-foam', 'Test Adapter', 'partial', ?, ?, 2, 1, 1,
        'fixture partial', ?, 'US'
      )
    `).run(before.dataStatus.updatedAt, before.dataStatus.updatedAt, before.dataStatus.updatedAt);

    const after = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(after.dataStatus).toMatchObject({
      status: 'partial',
      label: '部分未更新',
      updatedAt: before.dataStatus.updatedAt,
    });
  });

  it('only surfaces current formal workflow insights and legal Hard Gate scores', async () => {
    const app = testApp();
    await enableDemo(app);
    expect((await request(app).get('/api/dashboard/executive').expect(200))
      .body.data.dailyInsights).toEqual([]);

    const ownedJob = await createAndRun(app, {
      name: '老板驾驶舱 SKU 正式诊断',
      type: 'owned_product',
      entityType: 'owned_product',
      entityId: 'owned-sku-03',
      createdBy: 'Executive Dashboard Test',
      input: {},
      taskBook: {},
    });
    expect(ownedJob.status).toBe('monitoring');

    const scoredJob = await createAndRun(app, uShapedFixture());
    expect(scoredJob).toMatchObject({
      status: 'waiting_approval',
      latestRuleExecution: { hardGateStatus: 'pass' },
    });
    const rejectedInput = structuredClone(uShapedFixture());
    rejectedInput.name = '坐垫 Hard Gate 拒绝';
    rejectedInput.entityId = 'dev-seat';
    rejectedInput.input = {
      ...(rejectedInput.input as Record<string, unknown>),
      ip_risk: 'critical',
    };
    const rejectedJob = await createAndRun(app, rejectedInput);
    expect(rejectedJob).toMatchObject({
      status: 'rejected',
      latestRuleExecution: { hardGateStatus: 'reject' },
    });

    const dashboard = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(dashboard.dailyInsights).toEqual([
      expect.objectContaining({
        entityType: 'owned_product',
        entityId: 'owned-sku-03',
        type: 'risk',
        researchJobHref: `/research-jobs/${ownedJob.id}`,
      }),
    ]);
    expect(dashboard.dailyInsights.every((item) => (
      item.evidence.length > 0
      && item.evidence.every((evidence) => evidence.sources.length > 0)
    ))).toBe(true);
    const formalInsight = dashboard.dailyInsights[0];
    expect(formalInsight.lineage).toEqual({
      dataVersion: ownedJob.dataVersion,
      ruleProfileId: ownedJob.ruleProfileId,
      ruleProfileVersion: ownedJob.ruleProfileVersion,
      promptVersion: ownedJob.promptVersion,
    });
    expect(formalInsight.evidence.every((item) => Boolean(item.calculation))).toBe(true);
    expect(formalInsight.evidence.flatMap((item) => item.metrics.map((metric) => metric.label)))
      .toEqual(expect.arrayContaining(['SKU 30D 增长', '市场 30D 增长', '相对市场差']));
    expect(formalInsight.evidence.every((item) => !Object.hasOwn(item, 'id'))).toBe(true);
    for (const evidenceId of ownedJob.latestInsight?.evidenceIds ?? []) {
      expect(JSON.stringify(formalInsight)).not.toContain(evidenceId);
    }
    expect(dashboard.developmentOpportunities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'dev-travel', status: 'scored', score: expect.any(Number),
        hardGate: 'pass', recommendation: 'watch',
      }),
      expect.objectContaining({ id: 'dev-seat', status: 'rejected', score: null, recommendation: 'reject' }),
      expect.objectContaining({ id: 'dev-lumbar', status: 'needs_data', score: null }),
    ]));
    expect(dashboard.researchStatus).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'small_test', count: 0 }),
      expect.objectContaining({ key: 'watch', count: 1 }),
      expect.objectContaining({ key: 'do_not_develop', count: 1 }),
    ]));
  });

  it('returns SKU focus trends, operating metrics, TOP5 direct competitors, and friendly gaps', async () => {
    const app = testApp();
    await enableDemo(app);

    const initial = (await request(app)
      .get('/api/dashboard/executive?range=30D&skuId=owned-sku-02')
      .expect(200)).body.data as ExecutiveDashboardViewModel;
    expect(initial.skuFocus).toMatchObject({
      sku: { id: 'owned-sku-02', name: '深眠蝶翼枕', asin: 'B0DEMO0002', sku: 'MF-CER-02' },
      market: { id: 'mkt-cervical', name: 'Cervical Pillow' },
      operatingMetrics: {
        estimatedSales: 2865,
        estimatedRevenue: 131761.35,
        price: 45.99,
        rating: 4.5,
        reviews: 812,
        bsr: 4980,
        growth30d: 18.9,
        marketGrowth30d: 15.6,
        relativeDelta: 3.3,
      },
      insight: null,
    });
    expect(initial.skuFocus?.trendComparison.map((series) => series.kind).sort()).toEqual([
      'competitor_average', 'market', 'owned_sku',
    ]);
    expect(initial.skuFocus?.trendComparison.every((series) => series.points[0].index === 100)).toBe(true);
    expect(initial.skuFocus?.directCompetitors.length).toBeGreaterThan(0);
    expect(initial.skuFocus?.directCompetitors.length).toBeLessThanOrEqual(5);
    expect(initial.skuFocus?.directCompetitors.every((competitor) => (
      competitor.tags.includes('直接竞品')
    ))).toBe(true);

    const job = await createAndRun(app, {
      name: 'SKU Focus 正式诊断',
      type: 'owned_product',
      entityType: 'owned_product',
      entityId: 'owned-sku-02',
      createdBy: 'Executive Dashboard Test',
      input: {},
      taskBook: {},
    });
    const formal = (await request(app)
      .get('/api/dashboard/executive?skuId=owned-sku-02')
      .expect(200)).body.data as ExecutiveDashboardViewModel;
    expect(formal.skuFocus?.insight).toMatchObject({
      entityId: 'owned-sku-02',
      researchJobHref: `/research-jobs/${job.id}`,
    });
    expect(formal.skuFocus?.missingDataLabels).toEqual(expect.arrayContaining([
      '广告投放数据', '流量数据', '转化率数据', '退货数据',
    ]));
    expect(formal.skuFocus?.missingDataLabels.every((label) => (
      !label.includes('_') && !label.includes(job.id)
    ))).toBe(true);
    await request(app).get('/api/dashboard/executive?skuId=not-a-sku').expect(404);
  });

  it('never leaks entities from another marketplace', async () => {
    const app = testApp();
    await enableDemo(app);
    await request(app).patch('/api/settings').send({ marketplace: 'CA' }).expect(200);
    await request(app).post('/api/owned-products').send({
      asin: 'B0CANADA01',
      sku: 'CA-01',
      internalName: '加拿大 SKU',
      brand: 'Scoped',
      title: 'Canada Memory Foam Pillow',
      productType: 'memory_foam_pillow',
      marketNodeId: 'mkt-ca-memory-foam',
      keywords: ['memory foam pillow'],
    }).expect(201);

    const dashboard = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(dashboard).toMatchObject({
      marketplace: 'CA',
      market: { id: 'mkt-ca-memory-foam' },
      kpis: {
        totalSkus: 1,
        marketGrowth: null,
        outperformingSkus: null,
        attentionSkus: null,
        fastGrowthCompetitors: null,
      },
      trendComparison: [],
      fastGrowthCompetitors: [],
      dailyInsights: [],
      developmentOpportunities: [],
      dataStatus: { status: 'insufficient', updatedAt: null },
    });
    expect(dashboard.ownedSkuPerformance).toEqual([
      expect.objectContaining({ asin: 'B0CANADA01', relativeDelta: null, label: '数据不足' }),
    ]);
    await request(app).get('/api/dashboard/executive?skuId=owned-sku-01').expect(404);
  });

  it('rejects a dashboard query for a marketplace outside the active workspace', async () => {
    const app = testApp();
    await enableDemo(app);
    await request(app).get('/api/dashboard/executive?marketplace=CA').expect(409);
    await request(app).get('/api/dashboard/executive?marketplace=US').expect(200);
  });
});

describe('executive AI questions', () => {
  it('does not disguise an unrelated market insight as a competitor answer', async () => {
    const app = testApp();
    await enableDemo(app);
    const marketJob = await createAndRun(app, {
      name: '市场正式结论',
      type: 'existing_market',
      entityType: 'market',
      entityId: 'mkt-memory-foam',
      createdBy: 'Executive AI Test',
      input: {},
      taskBook: {},
    });
    expect(marketJob.status).toBe('monitoring');

    const result = (await request(app).post('/api/ai/analyze').send({
      question: '最近哪个竞品涨得最快？',
      entityType: 'dashboard',
      entityId: 'overview',
    }).expect(200)).body.data;

    expect(result).toMatchObject({
      formal: false,
      cached: false,
      insight: { entityType: 'dashboard', entityId: 'overview', insightType: 'workflow_required' },
      answer: expect.stringContaining('尚不能证明单个竞品'),
    });
    expect(result.insight.researchJobId).toBeUndefined();
  });

  it('routes today attention to the weakest SKU that has a formal conclusion', async () => {
    const app = testApp();
    await enableDemo(app);
    const ownedJob = await createAndRun(app, {
      name: '今日重点 SKU 诊断',
      type: 'owned_product',
      entityType: 'owned_product',
      entityId: 'owned-sku-01',
      createdBy: 'Executive AI Test',
      input: {},
      taskBook: {},
    });

    const result = (await request(app).post('/api/ai/analyze').send({
      question: '今天最值得关注什么？',
      entityType: 'dashboard',
      entityId: 'overview',
    }).expect(200)).body.data;

    expect(result).toMatchObject({
      formal: true,
      cached: true,
      insight: { researchJobId: ownedJob.id, entityType: 'research_job' },
    });
  });

  it('returns an explicit informal limitation for an unrecognized question', async () => {
    const app = testApp();
    await enableDemo(app);
    await createAndRun(app, {
      name: '市场正式结论',
      type: 'existing_market',
      entityType: 'market',
      entityId: 'mkt-memory-foam',
      createdBy: 'Executive AI Test',
      input: {},
      taskBook: {},
    });

    const result = (await request(app).post('/api/ai/analyze').send({
      question: '下周办公室午餐吃什么？',
      entityType: 'dashboard',
      entityId: 'overview',
    }).expect(200)).body.data;

    expect(result).toMatchObject({
      formal: false,
      cached: false,
      insight: { entityType: 'dashboard', entityId: 'overview', insightType: 'workflow_required' },
      answer: expect.stringContaining('当前 Evidence 无法回答'),
    });
    expect(result.insight.researchJobId).toBeUndefined();
  });
});
