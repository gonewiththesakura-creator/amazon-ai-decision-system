import { readFileSync } from 'node:fs';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ExecutiveDashboardViewModel,
  ExecutiveSkuPerformance,
  OwnedProductSummary,
  ResearchJobDetail,
} from '../shared/types.js';
import { createApp } from './app.js';
import { openDatabase, type AppDatabase } from './database/database.js';
import { DashboardFreshnessService } from './services/dashboard-freshness-service.js';
import { buildIndexedSeries, indexTrendSeries, selectOverviewProducts } from './services/executive-dashboard-service.js';

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

function configureActivePortfolio(total: number): void {
  if (!database) throw new Error('Test database is not open.');
  const existing = database.prepare(`
    SELECT id FROM products WHERE marketplace = 'US' AND is_owned = 1 ORDER BY id
  `).all() as unknown as Array<{ id: string }>;
  database.prepare(`UPDATE products SET status = 'inactive' WHERE marketplace = 'US' AND is_owned = 1`).run();
  const activate = database.prepare(`UPDATE products SET status = 'active' WHERE id = ?`);
  existing.slice(0, total).forEach((row) => activate.run(row.id));

  const insertProduct = database.prepare(`
    INSERT INTO products (
      id, asin, sku, internal_name, brand, title, image_url, marketplace, product_type,
      is_owned, market_node_id, keywords_json, monitoring_enabled, source_type, created_at, status
    ) VALUES (?, ?, ?, ?, 'Portfolio Brand', ?, '', 'US', 'memory_foam_pillow',
      1, 'mkt-memory-foam', '[]', 1, 'import', '2026-09-10T00:00:00.000Z', 'active')
  `);
  const insertSnapshot = database.prepare(`
    INSERT INTO product_snapshots (
      id, product_id, date, price, rating, review_count, bsr, estimated_sales,
      estimated_revenue, seller_count, growth_7d, growth_30d, growth_90d,
      source, source_type, collected_at, period, is_estimated, confidence,
      observation_date, dedup_key
    ) VALUES (?, ?, ?, 39, 4.3, 500, 100, ?, ?, 1, NULL, NULL, NULL,
      'Portfolio fixture', 'import', ?, '30D', 1, 0.9, ?, ?)
  `);
  for (let index = existing.length; index < total; index += 1) {
    const suffix = String(index + 1).padStart(2, '0');
    const productId = `portfolio-sku-${suffix}`;
    insertProduct.run(productId, `B0PORT${suffix}`, `PORT-${suffix}`, `Portfolio SKU ${suffix}`, `Portfolio SKU ${suffix}`);
    const baselineSales = 1_000;
    const latestSales = index % 2 === 0 ? 1_500 + index : 650 - index;
    insertSnapshot.run(
      `${productId}-old`, productId, '2026-08-10', baselineSales, baselineSales * 39,
      '2026-08-10T08:00:00.000Z', '2026-08-10', `${productId}|old`,
    );
    insertSnapshot.run(
      `${productId}-new`, productId, '2026-09-09', latestSales, latestSales * 39,
      '2026-09-09T08:00:00.000Z', '2026-09-09', `${productId}|new`,
    );
  }
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
      { date: '2026-01-03', index: 100, relativeToMarket: null },
      { date: '2026-01-04', index: 150, relativeToMarket: null },
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
        id: 'sku', label: 'SKU', kind: 'owned_sku',
        points: [
          { date: '2026-08-01', value: 50 },
          { date: '2026-08-31', value: 55 },
        ],
      },
      {
        id: 'invalid-future', label: '缺失序列', kind: 'owned_sku',
        points: [{ date: '2099-01-01', value: null }],
      },
    ], '30D', 'sku_focus')).toEqual({
      series: [
        {
          id: 'market', label: '市场', kind: 'market',
          points: [
            { date: '2026-08-01', index: 100, relativeToMarket: null },
            { date: '2026-08-31', index: 120, relativeToMarket: null },
          ],
        },
        {
          id: 'sku', label: 'SKU', kind: 'owned_sku',
          points: [
            { date: '2026-08-01', index: 100, relativeToMarket: 0 },
            { date: '2026-08-31', index: 110, relativeToMarket: -10 },
          ],
        },
      ],
      commonBaselineDate: '2026-08-01',
      excludedSeries: [
        { id: 'invalid-future', label: '缺失序列', reason: 'insufficient_history' },
      ],
    });
  });

  it('keeps a real zero observation after a positive baseline', () => {
    const result = buildIndexedSeries([
      {
        id: 'market', label: '市场', kind: 'market',
        points: [
          { date: '2026-08-01', value: 100 },
          { date: '2026-08-31', value: 0 },
        ],
      },
      {
        id: 'sku', label: 'SKU', kind: 'owned_sku',
        points: [
          { date: '2026-08-01', value: 10 },
          { date: '2026-08-31', value: 20 },
        ],
      },
    ], '30D', 'sku_focus');
    expect(result.series.find((series) => series.id === 'market')?.points).toEqual([
      { date: '2026-08-01', index: 100, relativeToMarket: null },
      { date: '2026-08-31', index: 0, relativeToMarket: null },
    ]);
  });

  it('uses one common baseline for all comparable series and calculates relative-to-market server-side', () => {
    const result = buildIndexedSeries([
      {
        id: 'market', label: '市场', kind: 'market',
        points: [
          { date: '2026-09-01', value: 100 },
          { date: '2026-09-10', value: 110 },
          { date: '2026-09-20', value: 121 },
        ],
      },
      {
        id: 'sku-a', label: 'SKU A', kind: 'owned_sku',
        points: [
          { date: '2026-09-01', value: 50 },
          { date: '2026-09-10', value: 55 },
          { date: '2026-09-20', value: 66 },
        ],
      },
      {
        id: 'sku-b', label: 'SKU B', kind: 'owned_sku',
        points: [
          { date: '2026-09-10', value: 20 },
          { date: '2026-09-20', value: 30 },
        ],
      },
    ], '30D');

    expect(result.commonBaselineDate).toBe('2026-09-10');
    expect(result.excludedSeries).toEqual([]);
    expect(result.series.map((series) => series.points[0])).toEqual([
      { date: '2026-09-10', index: 100, relativeToMarket: null },
      { date: '2026-09-10', index: 100, relativeToMarket: 0 },
      { date: '2026-09-10', index: 100, relativeToMarket: 0 },
    ]);
    expect(result.series.find((series) => series.id === 'sku-a')?.points.at(-1))
      .toEqual({ date: '2026-09-20', index: 120, relativeToMarket: 10 });
    expect(result.series.find((series) => series.id === 'sku-b')?.points.at(-1))
      .toEqual({ date: '2026-09-20', index: 150, relativeToMarket: 40 });
  });

  it('excludes a single-point SKU without shifting the common baseline for valid peers', () => {
    const result = buildIndexedSeries([
      {
        id: 'market', label: '市场', kind: 'market',
        points: [{ date: '2026-09-01', value: 100 }, { date: '2026-09-20', value: 120 }],
      },
      {
        id: 'sku-a', label: 'SKU A', kind: 'owned_sku',
        points: [{ date: '2026-09-01', value: 50 }, { date: '2026-09-20', value: 60 }],
      },
      {
        id: 'sku-b', label: 'SKU B', kind: 'owned_sku',
        points: [{ date: '2026-09-01', value: 30 }, { date: '2026-09-20', value: 33 }],
      },
      {
        id: 'sku-c', label: 'SKU C', kind: 'owned_sku',
        points: [{ date: '2026-09-20', value: 99 }],
      },
    ], '30D');

    expect(result).toMatchObject({
      commonBaselineDate: '2026-09-01',
      excludedSeries: [{ id: 'sku-c', label: 'SKU C', reason: 'insufficient_history' }],
    });
    expect(result.series.map((series) => series.id)).toEqual(['market', 'sku-a', 'sku-b']);
  });

  it('anchors the range to the market instead of an excluded future positive SKU', () => {
    const result = buildIndexedSeries([
      {
        id: 'market', label: '市场', kind: 'market',
        points: [{ date: '2026-09-01', value: 100 }, { date: '2026-09-20', value: 120 }],
      },
      {
        id: 'sku-a', label: 'SKU A', kind: 'owned_sku',
        points: [{ date: '2026-09-01', value: 50 }, { date: '2026-09-20', value: 60 }],
      },
      {
        id: 'sku-b', label: 'SKU B', kind: 'owned_sku',
        points: [{ date: '2026-09-01', value: 30 }, { date: '2026-09-20', value: 33 }],
      },
      {
        id: 'future', label: 'Future SKU', kind: 'owned_sku',
        points: [{ date: '2099-01-01', value: 1 }],
      },
    ], '30D');

    expect(result.commonBaselineDate).toBe('2026-09-01');
    expect(result.series.map((series) => series.id)).toEqual(['market', 'sku-a', 'sku-b']);
    expect(result.excludedSeries).toContainEqual({
      id: 'future', label: 'Future SKU', reason: 'insufficient_history',
    });
  });

  it('degrades to the largest market plus two-SKU cohort when every eligible series has no common date', () => {
    const result = buildIndexedSeries([
      {
        id: 'market', label: '市场', kind: 'market',
        points: [
          { date: '2026-09-01', value: 100 },
          { date: '2026-09-10', value: 110 },
          { date: '2026-09-20', value: 120 },
        ],
      },
      {
        id: 'sku-a', label: 'SKU A', kind: 'owned_sku',
        points: [
          { date: '2026-09-01', value: 50 },
          { date: '2026-09-10', value: 55 },
          { date: '2026-09-20', value: 60 },
        ],
      },
      {
        id: 'sku-b', label: 'SKU B', kind: 'owned_sku',
        points: [
          { date: '2026-09-01', value: 20 },
          { date: '2026-09-10', value: 22 },
          { date: '2026-09-20', value: 24 },
        ],
      },
      {
        id: 'sku-c', label: 'SKU C', kind: 'owned_sku',
        points: [
          { date: '2026-09-05', value: 30 },
          { date: '2026-09-15', value: 33 },
        ],
      },
    ], '30D');

    expect(result.commonBaselineDate).toBe('2026-09-01');
    expect(result.series.map((item) => item.id)).toEqual(['market', 'sku-a', 'sku-b']);
    expect(result.series.every((item) => item.points[0].index === 100)).toBe(true);
    expect(result.excludedSeries).toEqual([
      { id: 'sku-c', label: 'SKU C', reason: 'no_common_baseline' },
    ]);
  });

  it('uses the same staggered common baseline for SKU Focus and direct-competitor average', () => {
    const result = buildIndexedSeries([
      {
        id: 'sku', label: '本 SKU', kind: 'owned_sku',
        points: [
          { date: '2026-09-10', value: 20 },
          { date: '2026-09-20', value: 24 },
        ],
      },
      {
        id: 'market', label: '所属市场', kind: 'market',
        points: [
          { date: '2026-09-01', value: 100 },
          { date: '2026-09-10', value: 110 },
          { date: '2026-09-20', value: 120 },
        ],
      },
      {
        id: 'direct-average', label: '直接竞品平均', kind: 'competitor_average',
        points: [
          { date: '2026-09-01', value: 40 },
          { date: '2026-09-10', value: 44 },
          { date: '2026-09-20', value: 48 },
        ],
      },
    ], '30D', 'sku_focus');

    expect(result.commonBaselineDate).toBe('2026-09-10');
    expect(result.excludedSeries).toEqual([]);
    expect(result.series.map((item) => item.points[0])).toEqual([
      { date: '2026-09-10', index: 100, relativeToMarket: 0 },
      { date: '2026-09-10', index: 100, relativeToMarket: null },
      { date: '2026-09-10', index: 100, relativeToMarket: 0 },
    ]);
  });
});

describe('executive dashboard portfolio selection', () => {
  it('selects focus, attention, strongest, and weakest deterministically from 13 products', () => {
    const definitions = [
      ['focus', 0, false],
      ['attention-b', -20, true],
      ['attention-a', -20, true],
      ['strong-b', 30, false],
      ['strong-a', 30, false],
      ['weak-b', -15, false],
      ['weak-a', -15, false],
      ['middle-a', 5, false],
      ['middle-b', 4, false],
      ['middle-c', 3, false],
      ['middle-d', 2, false],
      ['middle-e', 1, false],
      ['unknown', null, false],
    ] as const;
    const owned = definitions.map(([id]) => ({ id } as unknown as OwnedProductSummary));
    const performance = definitions.map(([id, relativeDelta, attention]) => ({
      id, relativeDelta, attention,
    } as unknown as ExecutiveSkuPerformance));
    const select = () => selectOverviewProducts(owned, performance, 'focus').map((item) => item.id);

    expect(select()).toEqual(['focus', 'attention-a', 'attention-b', 'strong-a', 'weak-a']);
    expect(select()).toEqual(['focus', 'attention-a', 'attention-b', 'strong-a', 'weak-a']);
  });

  it('uses only explicitly selected SKU IDs in their supplied order', () => {
    const owned = ['sku-a', 'sku-b', 'sku-c', 'sku-d', 'sku-e', 'sku-f']
      .map((id) => ({ id } as unknown as OwnedProductSummary));
    const performance = owned.map((product) => ({
      id: product.id, relativeDelta: 0, attention: false,
    } as unknown as ExecutiveSkuPerformance));

    expect(selectOverviewProducts(owned, performance, undefined, ['sku-f', 'sku-b']))
      .toEqual([owned[5], owned[1]]);
  });

  it('keeps every SKU in a five-or-fewer portfolio despite an explicit subset', () => {
    const owned = ['sku-a', 'sku-b', 'sku-c', 'sku-d']
      .map((id) => ({ id } as unknown as OwnedProductSummary));
    const performance = owned.map((product) => ({
      id: product.id, relativeDelta: 0, attention: false,
    } as unknown as ExecutiveSkuPerformance));

    expect(selectOverviewProducts(owned, performance, undefined, ['sku-d'])).toEqual(owned);
  });
});

describe('GET /api/dashboard/executive', () => {
  it.each([0, 1, 4, 5, 12, 50])(
    'uses all %i active products for KPIs while limiting the overview to five owned series',
    async (total) => {
      const app = testApp();
      await enableDemo(app);
      configureActivePortfolio(total);

      const dashboard = (await request(app).get('/api/dashboard/executive').expect(200))
        .body.data as ExecutiveDashboardViewModel;
      const ownedSeries = dashboard.trendComparison.filter((item) => item.kind === 'owned_sku');

      expect(dashboard.kpis.totalSkus).toBe(total);
      expect(dashboard.ownedSkuPerformance).toHaveLength(total);
      expect(ownedSeries).toHaveLength(Math.min(total, 5));
      expect(dashboard.trendComparison).toHaveLength(total === 0 ? 0 : Math.min(total, 5) + 1);
      expect(dashboard.comparisonSkuIds).toHaveLength(Math.min(total, 5));
      expect(new Set(ownedSeries.map((item) => item.id)).size).toBe(ownedSeries.length);
    },
  );

  it('keeps an explicit focus SKU in the five-series overview selection', async () => {
    const app = testApp();
    await enableDemo(app);
    configureActivePortfolio(12);

    const dashboard = (await request(app)
      .get('/api/dashboard/executive?skuId=portfolio-sku-12')
      .expect(200)).body.data as ExecutiveDashboardViewModel;

    expect(dashboard.trendComparison.filter((item) => item.kind === 'owned_sku')).toHaveLength(5);
    expect(dashboard.trendComparison.map((item) => item.id)).toContain('sku:portfolio-sku-12');
  });

  it('uses the explicitly selected owned SKUs in request order after deduplicating IDs', async () => {
    const app = testApp();
    await enableDemo(app);
    configureActivePortfolio(12);

    const dashboard = (await request(app)
      .get('/api/dashboard/executive?compareSkuIds=portfolio-sku-12,owned-sku-02,portfolio-sku-12')
      .expect(200)).body.data as ExecutiveDashboardViewModel;

    expect(dashboard.trendComparison.filter((item) => item.kind === 'owned_sku').map((item) => item.id))
      .toEqual(['sku:portfolio-sku-12', 'sku:owned-sku-02']);
    expect(dashboard.comparisonSkuIds).toEqual(['portfolio-sku-12', 'owned-sku-02']);
  });

  it('ignores an explicit comparison subset when five or fewer sellable SKUs are active', async () => {
    const app = testApp();
    await enableDemo(app);
    configureActivePortfolio(4);

    const dashboard = (await request(app)
      .get('/api/dashboard/executive?compareSkuIds=owned-sku-01')
      .expect(200)).body.data as ExecutiveDashboardViewModel;

    expect(dashboard.comparisonSkuIds).toHaveLength(4);
    expect(dashboard.comparisonSkuIds).toContain('owned-sku-01');
    expect(dashboard.trendComparison.filter((item) => item.kind === 'owned_sku')).toHaveLength(4);
  });

  it('retains explicitly selected SKU IDs when a SKU is excluded for insufficient history', async () => {
    const app = testApp();
    await enableDemo(app);
    configureActivePortfolio(12);
    database!.prepare("DELETE FROM product_snapshots WHERE product_id = 'portfolio-sku-12'").run();

    const dashboard = (await request(app)
      .get('/api/dashboard/executive?compareSkuIds=portfolio-sku-12,owned-sku-02')
      .expect(200)).body.data as ExecutiveDashboardViewModel;

    expect(dashboard.comparisonSkuIds).toEqual(['portfolio-sku-12', 'owned-sku-02']);
    expect(dashboard.trendComparison.map((series) => series.id)).not.toContain('sku:portfolio-sku-12');
    expect(dashboard.trendComparisonMeta.excludedSeries.map((series) => series.id))
      .toContain('sku:portfolio-sku-12');
  });

  it('rejects comparison selections beyond five and inactive or unknown owned SKUs', async () => {
    const app = testApp();
    await enableDemo(app);
    configureActivePortfolio(12);
    database!.prepare("UPDATE products SET status = 'inactive' WHERE id = 'portfolio-sku-03'").run();

    await request(app).get('/api/dashboard/executive?compareSkuIds=portfolio-sku-01,portfolio-sku-02,portfolio-sku-04,portfolio-sku-05,portfolio-sku-06,portfolio-sku-07')
      .expect(400);
    await request(app).get('/api/dashboard/executive?compareSkuIds=portfolio-sku-03').expect(404);
    await request(app).get('/api/dashboard/executive?compareSkuIds=missing-sku').expect(404);
  });

  it('excludes inactive products from current KPIs without deleting their historical snapshots', async () => {
    const app = testApp();
    await enableDemo(app);
    const before = Number((database!.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE product_id = 'owned-sku-01'
    `).get() as { count: number }).count);
    database!.prepare(`UPDATE products SET status = 'inactive' WHERE id = 'owned-sku-01'`).run();

    const dashboard = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    const after = Number((database!.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE product_id = 'owned-sku-01'
    `).get() as { count: number }).count);

    expect(dashboard.kpis.totalSkus).toBe(3);
    expect(dashboard.ownedSkuPerformance.map((item) => item.id)).not.toContain('owned-sku-01');
    expect(after).toBe(before);
  });

  it('returns an explicit unconfigured state when no primary market exists', async () => {
    const app = testApp();

    const dashboard = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;

    expect(dashboard.market).toBeNull();
    expect(dashboard.trendComparison).toEqual([]);
    expect(dashboard.trendComparisonMeta.commonBaselineDate).toBeNull();
    expect(dashboard.coreBusinessFreshness).toMatchObject({
      status: 'insufficient',
      label: '数据不足',
      oldestRequiredSnapshotAt: null,
      message: expect.stringContaining('尚未设置主市场'),
    });
  });

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
      coreBusinessFreshness: { status: 'normal', label: '正常', isDemo: true },
      systemSyncStatus: { status: 'success' },
      skuFocus: null,
    });
    expect(dashboard.trendComparison).toHaveLength(5);
    expect(dashboard.trendComparisonMeta).toEqual({
      commonBaselineDate: '2026-08-10',
      excludedSeries: [],
    });
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
      item.scoreStatus === 'needs_data'
      && item.systemRecommendation === 'needs_data'
      && item.approvalStatus === 'needs_data'
      && item.score === null
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

  it('does not let an unrelated failed task contaminate core freshness', async () => {
    const app = testApp();
    await enableDemo(app);
    const before = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    database!.prepare(`
      INSERT INTO data_tasks (
        id, name, source_id, task_type, target, source, status, started_at, completed_at,
        total, success, failed, error_log, created_at, marketplace
      ) VALUES (
        'dashboard-latest-failed', '无关同步失败', 'source-mock', 'keyword_refresh',
        'unrelated-keyword-set', 'Test Adapter', 'failed', '2099-01-01T00:00:00Z',
        '2099-01-01T00:01:00Z', 1, 0, 1, 'fixture failure',
        '2099-01-01T00:00:00Z', 'US'
      )
    `).run();

    const after = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(after.coreBusinessFreshness).toEqual(before.coreBusinessFreshness);
    expect(after.systemSyncStatus).toMatchObject({
      status: 'failed',
      latestTaskAt: '2099-01-01T00:01:00Z',
      message: '最近一次同步失败。',
    });
    expect(after.trendComparison).toEqual(before.trendComparison);
    expect(after.kpis.marketGrowth).toBe(before.kpis.marketGrowth);
  });

  it('marks a relevant failed refresh partial while retaining all prior legal snapshots', async () => {
    const app = testApp();
    await enableDemo(app);
    const before = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(before.coreBusinessFreshness.oldestRequiredSnapshotAt).toEqual(expect.any(String));
    database!.prepare(`
      INSERT INTO data_tasks (
        id, name, source_id, task_type, target, source, status, started_at, completed_at,
        total, success, failed, error_log, created_at, marketplace
      ) VALUES (
        'dashboard-current-failed', '主市场刷新失败', 'source-mock', 'market_refresh',
        'mkt-memory-foam', 'Test Adapter', 'failed', '2099-01-02T00:00:00Z',
        '2099-01-02T00:01:00Z', 1, 0, 1, 'fixture relevant failure',
        '2099-01-02T00:00:00Z', 'US'
      )
    `).run();

    const after = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(after.coreBusinessFreshness).toMatchObject({
      status: 'partial',
      label: '部分未更新',
      message: expect.stringContaining('上一次合法快照'),
      oldestRequiredSnapshotAt: before.coreBusinessFreshness.oldestRequiredSnapshotAt,
    });
    expect(after.systemSyncStatus.status).toBe('failed');
    expect(after.trendComparison).toEqual(before.trendComparison);
    expect(after.kpis).toEqual(before.kpis);
  });

  it.each([
    ['market_refresh', 'all'],
    ['owned_sku_refresh', 'all'],
    ['competitor_refresh', 'all'],
  ])('treats failed %s target=%s as a core refresh issue', async (taskType, target) => {
    const app = testApp();
    await enableDemo(app);
    database!.prepare(`
      INSERT INTO data_tasks (
        id, name, source_id, task_type, target, source, status, started_at, completed_at,
        total, success, failed, error_log, created_at, marketplace
      ) VALUES (?, '批量核心刷新失败', 'source-mock', ?, ?, 'Test Adapter', 'failed',
        '2099-01-03T00:00:00Z', '2099-01-03T00:01:00Z', 1, 0, 1,
        'fixture batch failure', '2099-01-03T00:00:00Z', 'US')
    `).run(`batch-${taskType}`, taskType, target);

    const dashboard = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(dashboard.coreBusinessFreshness.status).toBe('partial');
  });

  it('does not let a later SKU success hide an unresolved market failure', async () => {
    const app = testApp();
    await enableDemo(app);
    database!.prepare(`
      INSERT INTO data_tasks (
        id, name, source_id, task_type, target, source, status, started_at, completed_at,
        total, success, failed, error_log, created_at, marketplace
      ) VALUES
        ('market-unresolved', '市场失败', 'source-mock', 'market_refresh',
          'mkt-memory-foam', 'Test Adapter', 'failed', '2099-01-04T00:00:00Z',
          '2099-01-04T00:01:00Z', 1, 0, 1, 'failure', '2099-01-04T00:00:00Z', 'US'),
        ('sku-later-success', 'SKU 后续成功', 'source-mock', 'owned_sku_refresh',
          'owned-sku-01', 'Test Adapter', 'success', '2099-01-05T00:00:00Z',
          '2099-01-05T00:01:00Z', 1, 1, 0, NULL, '2099-01-05T00:00:00Z', 'US')
    `).run();

    const dashboard = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(dashboard.coreBusinessFreshness.status).toBe('partial');
    expect(dashboard.systemSyncStatus.status).toBe('success');
  });

  it('clears a relevant failure after that entity receives a newer legal snapshot', async () => {
    const app = testApp();
    await enableDemo(app);
    database!.prepare(`
      INSERT INTO data_tasks (
        id, name, source_id, task_type, target, source, status, started_at, completed_at,
        total, success, failed, error_log, created_at, marketplace
      ) VALUES (
        'market-recovered', '市场失败后恢复', 'source-mock', 'market_refresh',
        'mkt-memory-foam', 'Test Adapter', 'failed', '2026-09-09T11:00:00+08:00',
        '2026-09-09T11:01:00+08:00', 1, 0, 1, 'failure',
        '2026-09-09T11:00:00+08:00', 'US'
      )
    `).run();
    database!.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, product_count, seller_count, brand_count, monthly_sales,
        monthly_revenue, avg_price, median_price, avg_rating, median_reviews, top10_share,
        top20_share, new_product_share, price_bands_json, concentration_json, source,
        source_type, collected_at, period, is_estimated, confidence, observation_date, dedup_key
      )
      SELECT 'market-recovery-snapshot', market_node_id, date, product_count, seller_count,
        brand_count, monthly_sales, monthly_revenue, avg_price, median_price, avg_rating,
        median_reviews, top10_share, top20_share, new_product_share, price_bands_json,
        concentration_json, source, source_type, '2026-09-09T11:02:00+08:00',
        period, is_estimated, confidence, date, 'market-recovery-snapshot'
      FROM market_snapshots WHERE market_node_id = 'mkt-memory-foam'
      ORDER BY date(date) DESC, rowid DESC LIMIT 1
    `).run();

    const dashboard = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(dashboard.coreBusinessFreshness.status).toBe('normal');
  });

  it('tracks a direct competitor product refresh failure and clears it after that entity recovers', async () => {
    const app = testApp();
    await enableDemo(app);
    database!.prepare(`
      INSERT INTO data_tasks (
        id, name, source_id, task_type, target, source, status, started_at, completed_at,
        total, success, failed, error_log, created_at, marketplace
      ) VALUES (
        'competitor-product-failed', '直接竞品产品刷新失败', 'source-mock', 'product_refresh',
        'competitor-03', 'Test Adapter', 'failed', '2026-09-09T10:21:00+08:00',
        '2026-09-09T10:21:30+08:00', 1, 0, 1, 'failure',
        '2026-09-09T10:21:00+08:00', 'US'
      )
    `).run();

    const failed = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(failed.coreBusinessFreshness.status).toBe('partial');

    database!.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, price, rating, review_count, bsr, estimated_sales,
        estimated_revenue, seller_count, growth_7d, growth_30d, growth_90d, source,
        source_type, collected_at, period, is_estimated, confidence, observation_date, dedup_key
      )
      SELECT 'competitor-product-recovered', product_id, date, price, rating, review_count,
        bsr, estimated_sales, estimated_revenue, seller_count, growth_7d, growth_30d,
        growth_90d, source, source_type, '2026-09-09T10:22:00+08:00', period,
        is_estimated, confidence, date, 'competitor-product-recovered'
      FROM product_snapshots WHERE product_id = 'competitor-03'
      ORDER BY date(date) DESC, julianday(collected_at) DESC, rowid DESC LIMIT 1
    `).run();

    const recovered = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(recovered.coreBusinessFreshness.status).toBe('normal');
    expect(recovered.coreBusinessFreshness.competitorsUpdatedAt)
      .toBe('2026-09-09T10:20:00+08:00');
  });

  it('keeps a failed core batch partial until every affected entity has a newer snapshot', async () => {
    const app = testApp();
    await enableDemo(app);
    database!.prepare(`
      INSERT INTO data_tasks (
        id, name, source_id, task_type, target, source, status, started_at, completed_at,
        total, success, failed, error_log, created_at, marketplace
      ) VALUES (
        'core-batch-failed', '核心批量刷新失败', 'source-mock', 'dashboard_core_refresh',
        'all', 'Test Adapter', 'failed', '2026-09-09T10:21:00+08:00',
        '2026-09-09T10:21:30+08:00', 10, 1, 9, 'failure',
        '2026-09-09T10:21:00+08:00', 'US'
      )
    `).run();
    database!.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, product_count, seller_count, brand_count, monthly_sales,
        monthly_revenue, avg_price, median_price, avg_rating, median_reviews, top10_share,
        top20_share, new_product_share, price_bands_json, concentration_json, source,
        source_type, collected_at, period, is_estimated, confidence, observation_date, dedup_key
      )
      SELECT 'core-batch-market-recovered', market_node_id, date, product_count, seller_count,
        brand_count, monthly_sales, monthly_revenue, avg_price, median_price, avg_rating,
        median_reviews, top10_share, top20_share, new_product_share, price_bands_json,
        concentration_json, source, source_type, '2026-09-09T10:22:00+08:00',
        period, is_estimated, confidence, date, 'core-batch-market-recovered'
      FROM market_snapshots WHERE market_node_id = 'mkt-memory-foam'
      ORDER BY date(date) DESC, julianday(collected_at) DESC, rowid DESC LIMIT 1
    `).run();

    const partiallyRecovered = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(partiallyRecovered.coreBusinessFreshness).toMatchObject({
      status: 'partial',
      marketUpdatedAt: '2026-09-09T10:22:00+08:00',
      oldestRequiredSnapshotAt: '2026-09-09T10:20:00+08:00',
    });

    database!.prepare(`
      WITH ranked AS (
        SELECT snapshot.*,
          ROW_NUMBER() OVER (
            PARTITION BY snapshot.product_id
            ORDER BY date(snapshot.date) DESC, julianday(snapshot.collected_at) DESC, snapshot.rowid DESC
          ) AS snapshot_rank
        FROM product_snapshots snapshot
        WHERE snapshot.product_id IN (
          SELECT id FROM products WHERE is_owned = 1 AND marketplace = 'US'
          UNION
          SELECT relation.competitor_product_id
          FROM competitor_relations relation
          JOIN products owned ON owned.id = relation.owned_product_id
          JOIN products competitor ON competitor.id = relation.competitor_product_id
          WHERE relation.relation_type = 'direct'
            AND owned.marketplace = 'US' AND competitor.marketplace = 'US'
        )
      )
      INSERT INTO product_snapshots (
        id, product_id, date, price, rating, review_count, bsr, estimated_sales,
        estimated_revenue, seller_count, growth_7d, growth_30d, growth_90d, source,
        source_type, collected_at, period, is_estimated, confidence, observation_date, dedup_key
      )
      SELECT 'core-batch-recovered-' || product_id, product_id, date, price, rating,
        review_count, bsr, estimated_sales, estimated_revenue, seller_count, growth_7d,
        growth_30d, growth_90d, source, source_type, '2026-09-09T10:23:00+08:00',
        period, is_estimated, confidence, date, 'core-batch-recovered|' || product_id
      FROM ranked WHERE snapshot_rank = 1
    `).run();

    const fullyRecovered = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(fullyRecovered.coreBusinessFreshness.status).toBe('normal');
    expect(fullyRecovered.coreBusinessFreshness.oldestRequiredSnapshotAt)
      .toBe('2026-09-09T10:22:00+08:00');
  });

  it('ignores malformed collection clocks and selects the newest valid collected snapshot', async () => {
    const app = testApp();
    await enableDemo(app);
    const freshness = new DashboardFreshnessService(database!);
    const input = {
      marketplace: 'US',
      mode: 'demo' as const,
      marketId: 'mkt-memory-foam',
      ownedProductIds: ['owned-sku-01'],
      competitorProductIds: [],
    };
    database!.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, product_count, seller_count, brand_count, monthly_sales,
        monthly_revenue, avg_price, median_price, avg_rating, median_reviews, top10_share,
        top20_share, new_product_share, price_bands_json, concentration_json, source,
        source_type, collected_at, period, is_estimated, confidence, observation_date, dedup_key
      )
      SELECT 'invalid-market-clock', market_node_id, '2099-01-01', product_count, seller_count,
        brand_count, monthly_sales, monthly_revenue, avg_price, median_price, avg_rating,
        median_reviews, top10_share, top20_share, new_product_share, price_bands_json,
        concentration_json, source, source_type, 'not-a-timestamp', period, is_estimated,
        confidence, '2099-01-01', 'invalid-market-clock'
      FROM market_snapshots WHERE market_node_id = 'mkt-memory-foam'
      ORDER BY date(date) DESC, rowid DESC LIMIT 1
    `).run();

    expect(freshness.getStatus(input).coreBusinessFreshness.marketUpdatedAt)
      .toBe('2026-09-09T10:20:00+08:00');

    database!.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, product_count, seller_count, brand_count, monthly_sales,
        monthly_revenue, avg_price, median_price, avg_rating, median_reviews, top10_share,
        top20_share, new_product_share, price_bands_json, concentration_json, source,
        source_type, collected_at, period, is_estimated, confidence, observation_date, dedup_key
      )
      SELECT 'valid-later-market-clock', market_node_id, '2026-08-01', product_count,
        seller_count, brand_count, monthly_sales, monthly_revenue, avg_price, median_price,
        avg_rating, median_reviews, top10_share, top20_share, new_product_share,
        price_bands_json, concentration_json, source, source_type,
        '2026-09-09T10:25:00+08:00', period, is_estimated, confidence,
        '2026-08-01', 'valid-later-market-clock'
      FROM market_snapshots WHERE market_node_id = 'mkt-memory-foam'
      ORDER BY date(date) DESC, julianday(collected_at) DESC, rowid DESC LIMIT 1
    `).run();

    expect(freshness.getStatus(input).coreBusinessFreshness.marketUpdatedAt)
      .toBe('2026-09-09T10:25:00+08:00');
  });

  it('marks complete core data stale when valid collection clocks drift by at least 24 hours', async () => {
    const app = testApp();
    await enableDemo(app);
    database!.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, product_count, seller_count, brand_count, monthly_sales,
        monthly_revenue, avg_price, median_price, avg_rating, median_reviews, top10_share,
        top20_share, new_product_share, price_bands_json, concentration_json, source,
        source_type, collected_at, period, is_estimated, confidence, observation_date, dedup_key
      )
      SELECT 'stale-skew-market', market_node_id, date, product_count, seller_count,
        brand_count, monthly_sales, monthly_revenue, avg_price, median_price, avg_rating,
        median_reviews, top10_share, top20_share, new_product_share, price_bands_json,
        concentration_json, source, source_type, '2026-09-11T10:20:00+08:00',
        period, is_estimated, confidence, date, 'stale-skew-market'
      FROM market_snapshots WHERE market_node_id = 'mkt-memory-foam'
      ORDER BY date(date) DESC, julianday(collected_at) DESC, rowid DESC LIMIT 1
    `).run();

    const dashboard = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(dashboard.coreBusinessFreshness).toMatchObject({
      status: 'stale',
      label: '数据陈旧',
      marketUpdatedAt: '2026-09-11T10:20:00+08:00',
      oldestRequiredSnapshotAt: '2026-09-09T10:20:00+08:00',
      newestRequiredSnapshotAt: '2026-09-11T10:20:00+08:00',
    });
  });

  it('uses the oldest required timestamp when core snapshot dates differ', async () => {
    const app = testApp();
    await enableDemo(app);
    database!.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, price, rating, review_count, bsr, estimated_sales,
        estimated_revenue, seller_count, growth_7d, growth_30d, growth_90d, source,
        source_type, collected_at, period, is_estimated, confidence, observation_date, dedup_key
      )
      SELECT 'freshness-owned-sku-01', product_id, '2026-09-10', price, rating,
        review_count, bsr, estimated_sales, estimated_revenue, seller_count, growth_7d,
        growth_30d, growth_90d, source, source_type, '2026-09-10T09:00:00+08:00',
        period, is_estimated, confidence, '2026-09-10', 'freshness-owned-sku-01'
      FROM product_snapshots
      WHERE product_id = 'owned-sku-01'
      ORDER BY date(date) DESC, rowid DESC LIMIT 1
    `).run();

    const dashboard = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(dashboard.coreBusinessFreshness).toMatchObject({
      status: 'partial',
      label: '部分未更新',
      ownedProductsUpdatedAt: '2026-09-09T10:20:00+08:00',
      oldestRequiredSnapshotAt: '2026-09-09T10:20:00+08:00',
      newestRequiredSnapshotAt: '2026-09-10T09:00:00+08:00',
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
        id: 'dev-travel', scoreStatus: 'scored', score: expect.any(Number),
        hardGate: 'pass', systemRecommendation: 'test', approvalStatus: 'waiting',
      }),
      expect.objectContaining({
        id: 'dev-seat', scoreStatus: 'rejected', score: null,
        systemRecommendation: 'reject', approvalStatus: 'not_required',
      }),
      expect.objectContaining({
        id: 'dev-lumbar', scoreStatus: 'needs_data', score: null,
        systemRecommendation: 'needs_data', approvalStatus: 'needs_data',
      }),
    ]));
    expect(dashboard.researchStatus).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'small_test', count: 1 }),
      expect.objectContaining({ key: 'watch', count: 0 }),
      expect.objectContaining({ key: 'do_not_develop', count: 1 }),
      expect.objectContaining({ key: 'needs_data', count: 1 }),
    ]));
  });

  it('keeps system recommendations and deterministic scores unchanged after human watch or reject', async () => {
    const app = testApp();
    await enableDemo(app);
    const watchInput = uShapedFixture();
    watchInput.name = '人工观察不改系统建议';
    watchInput.entityId = 'dev-travel';
    const waitingWatch = await createAndRun(app, watchInput);
    const rejectInput = uShapedFixture();
    rejectInput.name = '人工拒绝不改系统建议';
    rejectInput.entityId = 'dev-seat';
    const waitingReject = await createAndRun(app, rejectInput);

    expect(waitingWatch.latestInsight?.decision).toBe('test');
    expect(waitingReject.latestInsight?.decision).toBe('test');
    await request(app).post(`/api/research-jobs/${waitingWatch.id}/approve`).send({
      decision: 'watch',
      reason: '负责人决定继续观察，但不改写系统建议。',
      decidedBy: 'Executive Dashboard Test',
    }).expect(201);
    await request(app).post(`/api/research-jobs/${waitingReject.id}/reject`).send({
      reason: '负责人暂时拒绝，但保留系统建议与原始评分。',
      decidedBy: 'Executive Dashboard Test',
    }).expect(201);

    const dashboard = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    const watched = dashboard.developmentOpportunities.find((item) => item.id === 'dev-travel');
    const rejected = dashboard.developmentOpportunities.find((item) => item.id === 'dev-seat');
    expect(watched).toMatchObject({
      scoreStatus: 'scored',
      score: waitingWatch.latestScoreResult?.total,
      systemRecommendation: 'test',
      approvalStatus: 'watch',
      approvedAction: null,
    });
    expect(rejected).toMatchObject({
      scoreStatus: 'scored',
      score: waitingReject.latestScoreResult?.total,
      systemRecommendation: 'test',
      approvalStatus: 'rejected',
      approvedAction: null,
    });
    expect(dashboard.researchStatus).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'small_test', count: 2 }),
      expect.objectContaining({ key: 'watch', count: 0 }),
      expect.objectContaining({ key: 'do_not_develop', count: 0 }),
    ]));
  });

  it('never manufactures a system recommendation from an approval action', async () => {
    const app = testApp();
    await enableDemo(app);
    const input = uShapedFixture();
    input.name = '审批不反向生成系统建议';
    input.entityId = 'dev-travel';
    const waiting = await createAndRun(app, input);

    await request(app).post(`/api/research-jobs/${waiting.id}/approve`).send({
      decision: 'approved',
      reason: '这条人工批准记录不能成为系统建议的来源。',
      decidedBy: 'Executive Dashboard Test',
    }).expect(201);
    database!.prepare(`UPDATE rule_executions SET output_json = '{}' WHERE research_job_id = ?`)
      .run(waiting.id);
    database!.prepare(`UPDATE ai_insights SET data_version = 'superseded-test-version' WHERE research_job_id = ?`)
      .run(waiting.id);

    const dashboard = (await request(app).get('/api/dashboard/executive').expect(200))
      .body.data as ExecutiveDashboardViewModel;
    expect(dashboard.developmentOpportunities.find((item) => item.id === 'dev-travel'))
      .toMatchObject({
        scoreStatus: 'scored',
        systemRecommendation: 'needs_data',
        approvalStatus: 'approved',
        approvedAction: 'test',
      });
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
      coreBusinessFreshness: { status: 'insufficient', oldestRequiredSnapshotAt: null },
      systemSyncStatus: { status: 'idle', latestTaskAt: null },
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
