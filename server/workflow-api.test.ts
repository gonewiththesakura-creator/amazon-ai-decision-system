import { readFileSync } from 'node:fs';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DevelopmentProject,
  MissingDataItem,
  ProductSnapshot,
  ResearchJobDetail,
  ResearchJobSummary,
  RuleProfile,
  TrendPoint,
  WorkflowEvidence,
} from '../shared/types.js';
import { createApp } from './app.js';
import { openDatabase, type AppDatabase } from './database/database.js';
import { IntelligenceRepository } from './repository/intelligence-repository.js';
import { WorkflowRepository } from './repository/workflow-repository.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function testApp(): Express {
  database = openDatabase(':memory:');
  return createApp({ database });
}

function fixture(name: 'research-job-gray-sku.json' | 'research-job-u-shaped.json') {
  return JSON.parse(readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

async function enableDemo(app: Express): Promise<void> {
  await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);
}

async function createJob(app: Express, body: Record<string, unknown>): Promise<ResearchJobDetail> {
  const response = await request(app).post('/api/research-jobs').send(body);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as ResearchJobDetail;
}

async function runJob(app: Express, id: string): Promise<ResearchJobDetail> {
  const response = await request(app).post(`/api/research-jobs/${id}/run`).send({});
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as ResearchJobDetail;
}

async function importCsv(
  app: Express,
  entityType: 'product' | 'market',
  filename: string,
  csv: string,
): Promise<void> {
  await request(app)
    .post('/api/import/csv')
    .field('entityType', entityType)
    .field('sourceType', 'amazon')
    .field('marketplace', 'US')
    .attach('file', Buffer.from(csv), filename)
    .expect(201);
}

const PRODUCT_HEADER = [
  'ASIN', 'SKU', 'Brand', 'Title', 'Marketplace', 'ProductType', 'IsOwned',
  'MarketNodeId', 'MarketName', 'Price', 'Rating', 'Reviews', 'BSR',
  'MonthlySales', 'SellerCount', 'Growth7D', 'Growth30D', 'Growth90D',
  'Confidence', 'IsEstimated', 'Date',
].join(',');

function graySkuCsv(date: string, sales: number, suppliedGrowth30d: number): string {
  return [
    PRODUCT_HEADER,
    [
      'B0GRAYE2E01', 'GRAY-E2E-01', 'Traceable', 'Gray Memory Foam Pillow', 'US',
      'ergonomic_pillow', true, 'mkt-gray-e2e', 'Gray Pillow Market', 39.99, 4.4,
      210, 7500, sales, 1, 1.2, suppliedGrowth30d, 6.1, 0.94, false, date,
    ].join(','),
  ].join('\n');
}

const MARKET_HEADER = [
  'MarketNodeId', 'MarketName', 'Marketplace', 'Date', 'ProductCount', 'SellerCount',
  'BrandCount', 'MonthlySales', 'AvgPrice', 'MedianPrice', 'AvgRating',
  'MedianReviews', 'Top10Share', 'Top20Share', 'NewProductShare', 'Confidence',
  'IsEstimated', 'PriceBands', 'Concentration',
].join(',');

function grayMarketCsv(date: string, sales: number, withStructures = false): string {
  const current = sales === 23_000;
  const priceBands = current
    ? [{ label: '$30-$39.99', productCount: 52, monthlySales: 12_000, revenue: 420_000, avgReviews: 420, newProducts: 9, growth: 18 }]
    : [{ label: '$30-$39.99', productCount: 40, monthlySales: 9_000, revenue: 300_000, avgReviews: 350, newProducts: 6, growth: 10 }];
  const concentration = current
    ? [{ tier: 'TOP10', share: 31, avgPrice: 39, avgSales: 713 }]
    : [{ tier: 'TOP10', share: 28, avgPrice: 37, avgSales: 620 }];
  return [
    MARKET_HEADER,
    [
      'mkt-gray-e2e', 'Gray Pillow Market', 'US', date,
      current ? 120 : 100, current ? 80 : 75, current ? 45 : 40, sales,
      current ? 36 : 30, current ? 34.99 : 30, current ? 4.3 : 4.2,
      current ? 380 : 300, current ? 31 : 28, current ? 47 : 43,
      current ? 14 : 10, 0.92, false,
      withStructures ? csvJson(priceBands) : '',
      withStructures ? csvJson(concentration) : '',
    ].join(','),
  ].join('\n');
}

function csvJson(value: unknown): string {
  return `"${JSON.stringify(value).replaceAll('"', '""')}"`;
}

async function publishOwnedRuleV2(app: Express): Promise<RuleProfile> {
  const profiles = (
    await request(app).get('/api/rules/profiles').expect(200)
  ).body.data as RuleProfile[];
  const v1 = profiles.find((profile) => profile.id === 'amazon_owned_sku_relative_v1');
  if (!v1) throw new Error('Seeded owned-SKU v1 profile was not returned by the API.');
  const thresholds = { ...v1.thresholds, strongUnderperformMax: -25 };
  const response = await request(app).post('/api/rules/profiles').send({
    id: 'amazon_owned_sku_relative_v2',
    name: v1.name,
    version: 2,
    active: true,
    jobTypes: v1.jobTypes,
    hardGates: v1.hardGates,
    scoring: v1.scoring,
    thresholds,
  }).expect(201);
  return response.body.data as RuleProfile;
}

function cloneUShapedFixture(): Record<string, unknown> {
  return structuredClone(fixture('research-job-u-shaped.json'));
}

describe('V2 workflow API', () => {
  it('appends both snapshot observations and calculates gray SKU -5% versus market +15% as -20pp', async () => {
    const app = testApp();

    await importCsv(app, 'product', 'gray-sku-baseline.csv', graySkuCsv('2026-08-10', 1_000, 71));
    const products = await request(app).get('/api/owned-products').expect(200);
    const graySku = (products.body.data as Array<{ id: string; asin: string }>).find(
      (product) => product.asin === 'B0GRAYE2E01',
    );
    expect(graySku).toBeDefined();

    await importCsv(app, 'market', 'gray-market-baseline.csv', grayMarketCsv('2026-08-10', 20_000));
    expect(
      (await request(app).get(`/api/owned-products/${graySku!.id}/snapshots`).expect(200)).body.data,
    ).toHaveLength(1);
    expect(
      (await request(app).get('/api/markets/mkt-gray-e2e/snapshots').expect(200)).body.data,
    ).toHaveLength(1);

    await importCsv(app, 'product', 'gray-sku-current.csv', graySkuCsv('2026-09-09', 950, 83));
    await importCsv(app, 'market', 'gray-market-current.csv', grayMarketCsv('2026-09-09', 23_000));

    const readModel = (await request(app).get(`/api/owned-products/${graySku!.id}`).expect(200))
      .body.data as { latest: { growth30d: number; growth30dAvailable: boolean }; marketGrowth30d: number; relativeDelta: number };
    expect(readModel).toMatchObject({
      latest: { growth30d: -5, growth30dAvailable: true },
      marketGrowth30d: 15,
      relativeDelta: -20,
    });

    const productSnapshots = (
      await request(app).get(`/api/owned-products/${graySku!.id}/snapshots`).expect(200)
    ).body.data as ProductSnapshot[];
    const marketSnapshots = (
      await request(app).get('/api/markets/mkt-gray-e2e/snapshots').expect(200)
    ).body.data as TrendPoint[];
    expect(productSnapshots).toHaveLength(2);
    expect(marketSnapshots).toHaveLength(2);
    expect(new Set(productSnapshots.map((snapshot) => snapshot.id)).size).toBe(2);
    expect(productSnapshots.map((snapshot) => snapshot.date).sort()).toEqual(['2026-08-10', '2026-09-09']);
    expect(marketSnapshots.map((snapshot) => snapshot.date).sort()).toEqual(['2026-08-10', '2026-09-09']);

    const createInput = fixture('research-job-gray-sku.json');
    createInput.entityId = graySku!.id;
    const created = await createJob(app, createInput);
    expect(created).toMatchObject({
      status: 'draft',
      marketplace: 'US',
      ruleProfileId: 'amazon_owned_sku_relative_v1',
      ruleProfileVersion: 1,
    });

    // A later active profile must not change the immutable profile snapshot locked to this job.
    const v2 = await publishOwnedRuleV2(app);
    expect(v2).toMatchObject({ id: 'amazon_owned_sku_relative_v2', version: 2, active: true });
    const profiles = (
      await request(app).get('/api/rules/profiles').expect(200)
    ).body.data as RuleProfile[];
    expect(profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'amazon_owned_sku_relative_v2', version: 2, active: true }),
    ]));
    const newVersionInput = structuredClone(createInput);
    newVersionInput.name = 'New profile selection check';
    const newVersionJob = await createJob(app, newVersionInput);
    expect(newVersionJob).toMatchObject({
      ruleProfileId: 'amazon_owned_sku_relative_v2',
      ruleProfileVersion: 2,
    });

    const completed = await runJob(app, created.id);
    expect(completed.status).toBe('monitoring');
    expect(completed.latestRuleExecution).toMatchObject({
      ruleProfileId: 'amazon_owned_sku_relative_v1',
      ruleVersion: 1,
      hardGateStatus: 'pass',
      score: null,
      input: {
        sku_growth_30d: -5,
        market_growth_30d: 15,
      },
      output: {
        relative_delta: -20,
        performance: 'strong_underperform',
      },
    });
    expect(completed.latestInsight).toMatchObject({
      researchJobId: created.id,
      dataVersion: completed.dataVersion,
      hardGate: 'pass',
    });
    expect(completed.latestInsight?.summary).toContain('-20');
    const formalProduct = (await request(app).get(`/api/owned-products/${graySku!.id}`).expect(200)).body.data;
    expect(formalProduct.insight).toMatchObject({
      entityType: 'research_job',
      entityId: created.id,
      researchJobId: created.id,
      dataVersion: completed.dataVersion,
      promptVersion: completed.promptVersion,
    });
    expect(formalProduct.insight.evidenceIds.length).toBeGreaterThan(0);
    expect((await request(app).get(`/api/owned-products/${graySku!.id}/insights`).expect(200)).body.data)
      .toEqual([expect.objectContaining({ researchJobId: created.id })]);
    const repository = new IntelligenceRepository(database!);
    expect(repository.getCurrentWorkflowInsightForEntity('owned_product', graySku!.id))
      .toMatchObject({ researchJobId: created.id });
    const formalAnswer = (await request(app).post('/api/ai/analyze').send({
      question: '这个 SKU 为什么跑输市场？',
      entityType: 'owned_product',
      entityId: graySku!.id,
    }).expect(200)).body.data;
    expect(formalAnswer).toMatchObject({
      formal: true,
      cached: true,
      insight: { researchJobId: created.id, dataVersion: completed.dataVersion },
    });
    const dashboard = (await request(app).get('/api/dashboard/briefing').expect(200)).body.data;
    expect(dashboard.briefing).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'owned_product', entityId: graySku!.id }),
    ]));
    expect(dashboard.briefing.every((item: { insight: { researchJobId?: string; evidenceIds?: string[] } }) => (
      Boolean(item.insight.researchJobId && item.insight.evidenceIds?.length)
    ))).toBe(true);

    const diagnosticGaps = (
      await request(app).get(`/api/research-jobs/${created.id}/missing-data`).expect(200)
    ).body.data as MissingDataItem[];
    expect(completed.missingDataCount).toBe(6);
    expect(diagnosticGaps).toHaveLength(6);
    expect(diagnosticGaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldName: 'sessions', requiredForDecision: false, status: 'open' }),
      expect.objectContaining({ fieldName: 'conversion_rate', requiredForDecision: false, status: 'open' }),
      expect.objectContaining({ fieldName: 'ad_spend', requiredForDecision: false, status: 'open' }),
      expect.objectContaining({ fieldName: 'return_rate', requiredForDecision: false, status: 'open' }),
      expect.objectContaining({ fieldName: 'direct_competitor_history', requiredForDecision: false, status: 'open' }),
      expect.objectContaining({ fieldName: 'top100_history', requiredForDecision: false, status: 'open' }),
    ]));
    expect(completed.latestInsight?.missingData).toEqual(expect.arrayContaining([
      'direct_competitor_history', 'top100_history',
    ]));
    expect(completed.latestInsight?.recommendedActions.join(' ')).toContain('当前结论只覆盖 SKU 与市场');
    if (!database) throw new Error('Test database is not open.');
    const workflowRepository = new WorkflowRepository(database);
    workflowRepository.upsertMissingData(created.id, [{
      fieldName: 'sessions',
      reason: 'Optional diagnostic gap remains optional when refreshed.',
      requiredForDecision: false,
      manualValidationRequired: false,
    }]);
    expect(workflowRepository.getMissingData(created.id).find((item) => item.fieldName === 'sessions'))
      .toMatchObject({ requiredForDecision: false, status: 'open' });

    const evidence = (
      await request(app).get(`/api/research-jobs/${created.id}/evidence`).expect(200)
    ).body.data as WorkflowEvidence[];
    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ metricName: 'sku_growth_30d', metricValue: -5 }),
      expect.objectContaining({ metricName: 'market_growth_30d', metricValue: 15 }),
      expect.objectContaining({ metricName: 'relative_delta', metricValue: -20 }),
    ]));
    expect(evidence.every((item) => (
      item.researchJobId === created.id && item.dataVersion === completed.dataVersion
    ))).toBe(true);

    // Historical jobs used both aliases; both must resolve to the same owned-product read model.
    database!.prepare('UPDATE research_jobs SET entity_type = ? WHERE id = ?').run('product', created.id);
    expect(repository.getCurrentWorkflowInsightForEntity('product', graySku!.id))
      .toMatchObject({ researchJobId: created.id });
    database!.prepare('UPDATE rule_executions SET rule_version = ? WHERE research_job_id = ?')
      .run(999, created.id);
    expect(repository.getCurrentWorkflowInsightForEntity('owned_product', graySku!.id)).toBeNull();
    database!.prepare('UPDATE rule_executions SET rule_version = ? WHERE research_job_id = ?')
      .run(completed.ruleProfileVersion, created.id);
    database!.prepare('UPDATE research_jobs SET prompt_version = ? WHERE id = ?')
      .run('stale-prompt-version', created.id);
    expect(repository.getCurrentWorkflowInsightForEntity('owned_product', graySku!.id)).toBeNull();
    database!.prepare('UPDATE research_jobs SET prompt_version = ? WHERE id = ?')
      .run(completed.promptVersion, created.id);
    database!.prepare('UPDATE ai_insights SET evidence_ids_json = ? WHERE id = ?')
      .run(JSON.stringify(['missing-evidence-id']), completed.latestInsight!.id);
    expect(repository.getCurrentWorkflowInsightForEntity('owned_product', graySku!.id)).toBeNull();
    database!.prepare('UPDATE ai_insights SET evidence_ids_json = ? WHERE id = ?')
      .run(JSON.stringify(completed.latestInsight!.evidenceIds), completed.latestInsight!.id);
    database!.prepare('UPDATE research_jobs SET data_version = ? WHERE id = ?')
      .run('stale-read-model-version', created.id);
    expect(repository.getCurrentWorkflowInsightForEntity('owned_product', graySku!.id)).toBeNull();
    expect((await request(app).get(`/api/owned-products/${graySku!.id}`).expect(200)).body.data.insight)
      .toMatchObject({ insightType: 'workflow_required', evidence: [], evidenceIds: [] });
    expect((await request(app).get(`/api/owned-products/${graySku!.id}/insights`).expect(200)).body.data)
      .toEqual([]);
  });

  it('keeps the complete existing-market structure in rule output, Insight, and Evidence', async () => {
    const app = testApp();
    await importCsv(app, 'market', 'market-baseline.csv', grayMarketCsv('2026-08-10', 20_000, true));
    await importCsv(app, 'market', 'market-current.csv', grayMarketCsv('2026-09-09', 23_000, true));

    const created = await createJob(app, {
      name: 'Existing market structure traceability',
      type: 'existing_market',
      entityType: 'market_node',
      entityId: 'mkt-gray-e2e',
      createdBy: 'E2E Runner',
      input: {},
      taskBook: {},
    });
    const completed = await runJob(app, created.id);

    const formalMarket = (await request(app).get('/api/markets/mkt-gray-e2e').expect(200)).body.data;
    expect(formalMarket.insight).toMatchObject({
      entityType: 'research_job', researchJobId: created.id, dataVersion: completed.dataVersion,
    });
    expect((await request(app).get('/api/markets/mkt-gray-e2e/insights').expect(200)).body.data)
      .toEqual([expect.objectContaining({ researchJobId: created.id })]);

    expect(completed).toMatchObject({
      status: 'monitoring',
      latestRuleExecution: {
        hardGateStatus: 'pass',
        output: {
          monthly_sales: 23_000,
          monthly_revenue: 828_000,
          product_count: 120,
          seller_count: 80,
          brand_count: 45,
          avg_price: 36,
          median_price: 34.99,
          avg_rating: 4.3,
          median_reviews: 380,
          top10_sales_share: 31,
          top20_sales_share: 47,
          new_product_share: 14,
          market_growth_30d: 15,
          market_growth_elapsed_days: 30,
          monthly_revenue_change_30d_pct: 38,
          product_count_change_30d_pct: 20,
          avg_price_change_30d_pct: 20,
          avg_rating_change_30d: 0.1,
          top10_sales_share_change_30d_pp: 3,
          new_product_share_change_30d_pp: 4,
          price_bands_change_30d: {
            currentSnapshotId: expect.any(String),
            baselineSnapshotId: expect.any(String),
            elapsedDays: 30,
            matchedChanges: [expect.objectContaining({
              label: '$30-$39.99', productCountPct: 30, monthlySalesPct: 33.3,
              growthPp: 8,
            })],
          },
          concentration_change_30d: {
            currentSnapshotId: expect.any(String),
            baselineSnapshotId: expect.any(String),
            elapsedDays: 30,
            matchedChanges: [expect.objectContaining({
              tier: 'TOP10', sharePp: 3, avgSalesPct: 15,
            })],
          },
        },
      },
    });
    expect(completed.latestInsight?.facts.join(' ')).toMatch(/TOP10\/TOP20.*同基线需求变化.*价格带 current\/baseline/s);
    expect(completed.latestInsight?.missingData).toEqual(['top100_history', 'submarket_history']);

    const missing = (
      await request(app).get(`/api/research-jobs/${created.id}/missing-data`).expect(200)
    ).body.data as MissingDataItem[];
    expect(missing).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldName: 'top100_history', requiredForDecision: false }),
      expect.objectContaining({ fieldName: 'submarket_history', requiredForDecision: false }),
    ]));
    expect(missing.map((item) => item.fieldName)).not.toContain('price_band_history');

    const evidence = (
      await request(app).get(`/api/research-jobs/${created.id}/evidence`).expect(200)
    ).body.data as WorkflowEvidence[];
    const metrics = new Map(evidence.map((item) => [item.metricName, item.metricValue]));
    expect(Object.fromEntries(metrics)).toMatchObject({
      monthly_sales: 23_000,
      monthly_revenue: 828_000,
      product_count: 120,
      seller_count: 80,
      brand_count: 45,
      avg_price: 36,
      median_price: 34.99,
      avg_rating: 4.3,
      median_reviews: 380,
      top10_sales_share: 31,
      top20_sales_share: 47,
      new_product_share: 14,
      market_growth_30d: 15,
      market_growth_elapsed_days: 30,
      monthly_revenue_change_30d_pct: 38,
      product_count_change_30d_pct: 20,
      avg_price_change_30d_pct: 20,
      avg_rating_change_30d: 0.1,
      top10_sales_share_change_30d_pp: 3,
      new_product_share_change_30d_pp: 4,
    });
    const revenueDelta = evidence.find((item) => item.metricName === 'monthly_revenue_change_30d_pct');
    expect(revenueDelta?.calculation).toMatch(/current .* 828000 \/ baseline .* 600000.*= 38%/);
    expect(evidence.find((item) => item.metricName === 'price_bands_change_30d')?.metricValue)
      .toMatchObject({ matchedChanges: [expect.objectContaining({ productCountPct: 30 })] });
    expect(evidence.every((item) => item.dataVersion === completed.dataVersion)).toBe(true);
  });

  it('persists valid market structure JSON and rejects only the row with malformed JSON', async () => {
    const app = testApp();
    const valid = grayMarketCsv('2026-08-10', 20_000, true).split('\n')[1];
    const withoutOptionalStructures = [
      'mkt-no-structure', 'No Structure Market', 'US', '2026-08-10', 15, 10, 6,
      1_200, 26, 25, 4.2, 100, 26, 41, 13, 0.81, false, '', '',
    ].join(',');
    const invalid = [
      'mkt-bad-json', 'Bad JSON Market', 'US', '2026-08-10', 10, 8, 4, 1_000,
      25, 24, 4.1, 90, 25, 40, 12, 0.8, false, 'not-json', '',
    ].join(',');
    const response = await request(app)
      .post('/api/import/csv')
      .field('entityType', 'market')
      .field('sourceType', 'amazon')
      .field('marketplace', 'US')
      .attach('file', Buffer.from([
        MARKET_HEADER, valid, withoutOptionalStructures, invalid,
      ].join('\n')), 'market-json.csv')
      .expect(201);

    expect(response.body.data).toMatchObject({ rowCount: 3, successCount: 2, failureCount: 1 });
    expect(response.body.data.errors[0]).toContain('PriceBands 不是有效 JSON');
    const stored = database?.prepare(`
      SELECT price_bands_json, concentration_json FROM market_snapshots
      WHERE market_node_id = 'mkt-gray-e2e'
    `).get() as { price_bands_json: string; concentration_json: string } | undefined;
    expect(JSON.parse(stored?.price_bands_json ?? '[]')).toEqual([
      expect.objectContaining({ label: '$30-$39.99', productCount: 40 }),
    ]);
    expect(JSON.parse(stored?.concentration_json ?? '[]')).toEqual([
      expect.objectContaining({ tier: 'TOP10', share: 28 }),
    ]);
    expect(database?.prepare(`
      SELECT price_bands_json, concentration_json FROM market_snapshots
      WHERE market_node_id = 'mkt-no-structure'
    `).get()).toMatchObject({ price_bands_json: '[]', concentration_json: '[]' });
    expect(database?.prepare(`SELECT COUNT(*) AS count FROM market_nodes WHERE id = 'mkt-bad-json'`).get())
      .toMatchObject({ count: 0 });
  });

  it('keeps owned-SKU competitor comparisons when Demo has valid historical cohorts', async () => {
    const app = testApp();
    await enableDemo(app);
    const created = await createJob(app, {
      name: 'Demo owned SKU cohort coverage',
      type: 'owned_product',
      entityType: 'owned_product',
      entityId: 'owned-sku-01',
      createdBy: 'E2E Runner',
      input: {},
      taskBook: {},
    });
    const completed = await runJob(app, created.id);
    expect(completed).toMatchObject({
      status: 'monitoring',
      latestRuleExecution: {
        output: {
          direct_competitor_sample_size: expect.any(Number),
          top100_sample_size: expect.any(Number),
        },
      },
    });
    expect(Number(completed.latestRuleExecution?.output.direct_competitor_sample_size)).toBeGreaterThan(0);
    expect(Number(completed.latestRuleExecution?.output.top100_sample_size)).toBeGreaterThan(0);
    expect(completed.latestInsight?.facts.join(' ')).toMatch(/直接竞品.*TOP100/);
    const missing = (
      await request(app).get(`/api/research-jobs/${created.id}/missing-data`).expect(200)
    ).body.data as MissingDataItem[];
    expect(missing.map((item) => item.fieldName)).not.toContain('direct_competitor_history');
    expect(missing.map((item) => item.fieldName)).not.toContain('top100_history');
  });

  it('runs the U-shaped pillow through reverse review and waiting approval, then records a human approval', async () => {
    const app = testApp();
    await enableDemo(app);

    const created = await createJob(app, cloneUShapedFixture());
    const waiting = await runJob(app, created.id);
    expect(waiting).toMatchObject({
      status: 'waiting_approval',
      marketplace: 'US',
      latestRuleExecution: {
        hardGateStatus: 'pass',
        ruleProfileId: waiting.ruleProfileId,
        ruleVersion: waiting.ruleProfileVersion,
      },
      approval: { status: 'pending' },
    });
    expect(waiting.latestRuleExecution?.score).toBeTypeOf('number');
    expect(waiting.latestScoreResult?.total).toBe(waiting.latestRuleExecution?.score);
    expect(waiting.reverseReview).toMatchObject({
      dataVersion: waiting.dataVersion,
      ruleProfileId: waiting.ruleProfileId,
      ruleProfileVersion: waiting.ruleProfileVersion,
      promptVersion: waiting.promptVersion,
    });
    expect(waiting.approval).toMatchObject({
      dataVersion: waiting.dataVersion,
      ruleProfileId: waiting.ruleProfileId,
      ruleProfileVersion: waiting.ruleProfileVersion,
      promptVersion: waiting.promptVersion,
      reverseReviewId: waiting.reverseReview?.id,
    });
    expect(waiting.latestInsight?.promptVersion).toBe(waiting.promptVersion);

    const project = (
      await request(app).get('/api/development-projects/dev-travel').expect(200)
    ).body.data as DevelopmentProject;
    expect(project.insight).toMatchObject({
      id: waiting.latestInsight?.id,
      researchJobId: waiting.id,
      dataVersion: waiting.dataVersion,
      promptVersion: waiting.promptVersion,
    });
    expect(project.insight.id).not.toBe('insight-dev-travel');
    expect(project.insight.evidenceIds?.length).toBeGreaterThan(0);

    const steps = (
      await request(app).get(`/api/research-jobs/${created.id}/steps`).expect(200)
    ).body.data as ResearchJobDetail['steps'];
    const completedStepTypes = steps
      .filter((step) => step.status === 'completed')
      .map((step) => step.stepType);
    expect(completedStepTypes).toEqual(expect.arrayContaining([
      'plan', 'collect_market', 'collect_products', 'normalize', 'validate', 'calculate',
      'hard_gate', 'score', 'ai_analysis', 'reverse_review', 'approval',
    ]));

    const evidence = (
      await request(app).get(`/api/research-jobs/${created.id}/evidence`).expect(200)
    ).body.data as WorkflowEvidence[];
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.every((item) => (
      item.researchJobId === waiting.id && item.dataVersion === waiting.dataVersion
    ))).toBe(true);
    const evidenceIds = new Set(evidence.map((item) => item.id));
    expect(waiting.latestInsight?.evidenceIds?.length).toBeGreaterThan(0);
    expect(waiting.latestInsight?.evidenceIds?.every((id) => evidenceIds.has(id))).toBe(true);
    expect(waiting.reverseReview?.topFailureModes.every((mode) => (
      mode.evidenceIds.every((id) => evidenceIds.has(id))
    ))).toBe(true);
    const dataTasks = database?.prepare(`
      SELECT status, success, failed, source, source_id FROM data_tasks WHERE research_job_id = ?
    `).all(created.id) as Array<{
      status: string; success: number; failed: number; source: string; source_id: string | null;
    }>;
    expect(dataTasks.length).toBeGreaterThan(0);
    expect(dataTasks.every((task) => (
      task.status === 'success' && Number(task.success) === 1 && Number(task.failed) === 0
    ))).toBe(true);

    const approvedResponse = await request(app)
      .post(`/api/research-jobs/${created.id}/approve`)
      .send({
        decision: 'approved',
        reason: '证据与风险已由负责人复核，只批准下一阶段验证。',
        decidedBy: 'E2E Approver',
      });
    expect([200, 201]).toContain(approvedResponse.status);
    const approved = approvedResponse.body.data as ResearchJobDetail;
    expect(approved).toMatchObject({
      status: 'approved',
      approval: {
        status: 'approved',
        decidedBy: 'E2E Approver',
      },
      decision: {
        decision: 'approved',
        researchJobId: created.id,
        dataVersion: waiting.dataVersion,
        approvalId: waiting.approval?.id,
        reverseReviewId: waiting.reverseReview?.id,
      },
    });
    expect(approved.completedAt).not.toBeNull();
  });

  it('never falls back to an older formal insight when the latest entity job is unfinished', async () => {
    const app = testApp();
    await enableDemo(app);

    const first = await createJob(app, cloneUShapedFixture());
    const waiting = await runJob(app, first.id);
    expect(waiting.status).toBe('waiting_approval');

    const newer = await createJob(app, {
      ...cloneUShapedFixture(),
      name: 'U 型旅行枕二次研究',
    });
    expect(newer.status).toBe('draft');

    const project = (
      await request(app).get('/api/development-projects/dev-travel').expect(200)
    ).body.data as DevelopmentProject;
    expect(project.insight).toMatchObject({
      id: '',
      insightType: 'workflow_required',
      dataVersion: 'workflow-required',
    });
    expect(project.insight.researchJobId).toBeUndefined();
    expect(project.decision).toBeUndefined();
  });

  it('stops at needs_data and exposes every unresolved required field without inventing zeroes', async () => {
    const app = testApp();
    await enableDemo(app);
    const incomplete = cloneUShapedFixture();
    const input = incomplete.input as Record<string, unknown>;
    delete input.ip_risk;

    const created = await createJob(app, incomplete);
    const result = await runJob(app, created.id);
    expect(result.status).toBe('needs_data');
    expect(result.latestRuleExecution).toMatchObject({
      hardGateStatus: 'needs_data',
      score: null,
    });
    expect(result.latestScoreResult).toBeUndefined();

    const missing = (
      await request(app).get(`/api/research-jobs/${created.id}/missing-data`).expect(200)
    ).body.data as MissingDataItem[];
    expect(missing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fieldName: 'ip_risk',
        requiredForDecision: true,
        manualValidationRequired: true,
        status: 'open',
      }),
    ]));
    expect(missing.find((item) => item.fieldName === 'ip_risk')).not.toHaveProperty('resolvedValue');
    expect(result.missingDataCount).toBe(missing.filter((item) => item.status === 'open').length);
    expect(result.approval).toBeUndefined();
    expect(result.decision).toBeUndefined();
    const dataTasks = database?.prepare(`
      SELECT status, success, failed, source, source_id
      FROM data_tasks WHERE research_job_id = ?
    `).all(created.id) as Array<{
      status: string;
      success: number;
      failed: number;
      source: string;
      source_id: string | null;
    }>;
    expect(dataTasks.length).toBeGreaterThan(0);
    expect(dataTasks.every((task) => (
      task.status === 'failed' && Number(task.success) === 0 && Number(task.failed) === 1
    ))).toBe(true);
    expect(dataTasks.every((task) => task.source === 'Persisted Demo Data (DEMO)' && task.source_id === null))
      .toBe(true);
  });

  it('persists resolved IP data and retries needs_data steps into waiting approval', async () => {
    const app = testApp();
    await enableDemo(app);
    const incomplete = cloneUShapedFixture();
    delete (incomplete.input as Record<string, unknown>).ip_risk;

    const created = await createJob(app, incomplete);
    const needsData = await runJob(app, created.id);
    expect(needsData.status).toBe('needs_data');
    const firstValidate = needsData.steps.find((step) => step.stepType === 'validate');
    expect(firstValidate).toMatchObject({ status: 'needs_data', retryCount: 0 });

    const retryResponse = await request(app)
      .post(`/api/research-jobs/${created.id}/retry`)
      .send({ resolvedData: { ip_risk: 'low' }, resolvedBy: 'E2E Data Owner' });
    expect(retryResponse.status, JSON.stringify(retryResponse.body)).toBe(200);
    const retried = retryResponse.body.data as ResearchJobDetail;
    expect(retried).toMatchObject({
      status: 'waiting_approval',
      input: { ip_risk: 'low' },
      latestRuleExecution: { hardGateStatus: 'pass' },
      approval: { status: 'pending' },
    });
    expect(retried.dataVersion).not.toBe(needsData.dataVersion);
    expect(retried.steps.find((step) => step.stepType === 'validate')).toMatchObject({
      status: 'completed',
      retryCount: 1,
    });
    expect(retried.steps.find((step) => step.stepType === 'hard_gate')).toMatchObject({
      status: 'completed',
      retryCount: 1,
    });

    const missing = (
      await request(app).get(`/api/research-jobs/${created.id}/missing-data`).expect(200)
    ).body.data as MissingDataItem[];
    expect(missing.find((item) => item.fieldName === 'ip_risk')).toMatchObject({
      status: 'resolved',
      resolvedValue: 'low',
      resolvedBy: 'E2E Data Owner',
    });
  });

  it('rejects a known critical IP risk at the Hard Gate and never creates a score or approval', async () => {
    const app = testApp();
    await enableDemo(app);
    const criticalIp = cloneUShapedFixture();
    (criticalIp.input as Record<string, unknown>).ip_risk = 'critical';

    const created = await createJob(app, criticalIp);
    const rejected = await runJob(app, created.id);
    expect(rejected.status).toBe('rejected');
    expect(rejected.latestRuleExecution).toMatchObject({
      hardGateStatus: 'reject',
      score: null,
      output: {
        suggestedDecision: 'reject',
        calculation: {
          order: ['hard_gate', 'score'],
          scoreSkipped: true,
        },
      },
    });
    expect(rejected.latestScoreResult).toBeUndefined();
    expect(rejected.approval).toBeUndefined();
    expect(rejected.decision).toBeUndefined();

    const steps = (
      await request(app).get(`/api/research-jobs/${created.id}/steps`).expect(200)
    ).body.data as ResearchJobDetail['steps'];
    expect(steps.find((step) => step.stepType === 'hard_gate')?.status).toBe('completed');
    expect(steps.find((step) => step.stepType === 'score')?.status).toBe('skipped');
  });

  it('blocks malformed Hard Gate domains instead of letting type mismatches pass', async () => {
    const app = testApp();
    await enableDemo(app);
    const malformed = cloneUShapedFixture();
    Object.assign(malformed.input as Record<string, unknown>, {
      ip_risk: 'definitely-safe',
      certification_required: 'no',
      certification_available: 'true',
      supply_chain_validation: 'true',
      moq_cost: '6000',
      dimensions: { length: '30', width: 28, height: 12 },
    });

    const created = await createJob(app, malformed);
    const blocked = await runJob(app, created.id);
    expect(blocked).toMatchObject({
      status: 'needs_data',
      latestRuleExecution: { hardGateStatus: 'needs_data', score: null },
    });
    expect(blocked.latestScoreResult).toBeUndefined();
    expect(blocked.approval).toBeUndefined();
    const missing = (
      await request(app).get(`/api/research-jobs/${created.id}/missing-data`).expect(200)
    ).body.data as MissingDataItem[];
    expect(missing).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldName: 'ip_risk', requiredForDecision: true }),
      expect.objectContaining({ fieldName: 'certification_required', requiredForDecision: true }),
      expect.objectContaining({ fieldName: 'certification_available', requiredForDecision: true }),
      expect.objectContaining({ fieldName: 'supply_chain_validation', requiredForDecision: true }),
      expect.objectContaining({ fieldName: 'moq_cost', requiredForDecision: true }),
      expect.objectContaining({ fieldName: 'dimensions.length', requiredForDecision: true }),
    ]));

    const unknownIp = cloneUShapedFixture();
    (unknownIp.input as Record<string, unknown>).ip_risk = 'unknown';
    const unknownCreated = await createJob(app, unknownIp);
    const unknownBlocked = await runJob(app, unknownCreated.id);
    expect(unknownBlocked).toMatchObject({
      status: 'needs_data',
      latestRuleExecution: { hardGateStatus: 'needs_data', score: null },
    });
  });

  it('enforces the safety floor even when an API-created profile removes every configured gate', async () => {
    const app = testApp();
    await enableDemo(app);
    const profiles = (
      await request(app).get('/api/rules/profiles').expect(200)
    ).body.data as RuleProfile[];
    const defaultProfile = profiles.find((item) => item.id === 'amazon_us_new_product_default_v1');
    expect(defaultProfile).toBeDefined();
    const weakProfile = {
      id: 'malicious-no-hard-gates',
      name: 'Malicious profile with safety gates removed',
      version: 1,
      active: true,
      jobTypes: ['adjacent_product'],
      hardGates: { reject: { ipRisk: [], certificationAvailable: [] }, needsData: [] },
      scoring: defaultProfile!.scoring,
      thresholds: defaultProfile!.thresholds,
    };
    await request(app).post('/api/rules/profiles').send(weakProfile).expect(201);

    const criticalIp = cloneUShapedFixture();
    criticalIp.ruleProfileId = weakProfile.id;
    (criticalIp.input as Record<string, unknown>).ip_risk = 'critical';
    const created = await createJob(app, criticalIp);
    const rejected = await runJob(app, created.id);
    expect(rejected).toMatchObject({
      status: 'rejected',
      latestRuleExecution: { hardGateStatus: 'reject', score: null },
    });
    expect(rejected.latestRuleExecution?.output.rejectionReasons).toEqual([
      expect.stringMatching(/IP/),
    ]);
    expect(rejected.latestScoreResult).toBeUndefined();
    expect(rejected.approval).toBeUndefined();
  });

  it('blocks out-of-range product and task-book numbers before Hard Gate scoring', async () => {
    const app = testApp();
    await enableDemo(app);
    const invalid = cloneUShapedFixture();
    Object.assign(invalid.input as Record<string, unknown>, {
      estimated_contribution_profit_rate: 101,
      moq_cost: 0,
      weight: -1,
      dimensions: { length: 0, width: 28, height: 12 },
    });
    Object.assign(invalid.taskBook as Record<string, unknown>, {
      total_budget: 0,
      per_product_budget: -1,
      min_profit_rate: 101,
      max_weight: 0,
      max_dimension: { length: 0, width: 35, height: 20 },
      price_range: { min: 50, max: 40, currency: 'USD' },
    });

    const created = await createJob(app, invalid);
    const blocked = await runJob(app, created.id);
    expect(blocked).toMatchObject({
      status: 'needs_data',
      latestRuleExecution: { hardGateStatus: 'needs_data', score: null },
    });
    expect(blocked.latestScoreResult).toBeUndefined();
    expect(blocked.approval).toBeUndefined();
    const missing = (
      await request(app).get(`/api/research-jobs/${created.id}/missing-data`).expect(200)
    ).body.data as MissingDataItem[];
    expect(missing.map((item) => item.fieldName)).toEqual(expect.arrayContaining([
      'estimated_contribution_profit_rate', 'moq_cost', 'weight', 'dimensions.length',
      'total_budget', 'per_product_budget', 'min_profit_rate', 'max_weight',
      'max_dimension.length', 'price_range.max',
    ]));
    expect(missing.every((item) => item.requiredForDecision)).toBe(true);
  });

  it('isolates job lists and subordinate resources by the active marketplace', async () => {
    const app = testApp();
    await enableDemo(app);
    const created = await createJob(app, cloneUShapedFixture());
    await runJob(app, created.id);

    const usJobs = (
      await request(app).get('/api/research-jobs?marketplace=US').expect(200)
    ).body.data as ResearchJobSummary[];
    expect(usJobs.map((job) => job.id)).toContain(created.id);

    await request(app).patch('/api/settings').send({ marketplace: 'CA' }).expect(200);
    const caJobs = (
      await request(app).get('/api/research-jobs?marketplace=CA').expect(200)
    ).body.data as ResearchJobSummary[];
    expect(caJobs.map((job) => job.id)).not.toContain(created.id);
    await request(app).get(`/api/research-jobs/${created.id}?marketplace=CA`).expect(404);
    await request(app).get(`/api/research-jobs/${created.id}/steps?marketplace=CA`).expect(404);
    await request(app).get(`/api/research-jobs/${created.id}/evidence?marketplace=CA`).expect(404);
    await request(app).get(`/api/research-jobs/${created.id}/missing-data?marketplace=CA`).expect(404);
    await request(app).post(`/api/research-jobs/${created.id}/approve`).send({
      decision: 'approved', reason: 'cross-market attempt', decidedBy: 'CA Admin',
    }).expect(404);

    await request(app).patch('/api/settings').send({ marketplace: 'US' }).expect(200);
    await request(app).get(`/api/research-jobs/${created.id}?marketplace=US`).expect(200);
  });

  it('rejects a Task Book whose declared marketplace differs from the active workspace', async () => {
    const app = testApp();
    await enableDemo(app);
    const mismatched = cloneUShapedFixture();
    (mismatched.taskBook as Record<string, unknown>).marketplace = 'CA';

    const response = await request(app).post('/api/research-jobs').send(mismatched).expect(400);
    expect(response.body.error).toMatch(/Task Book.*CA.*US.*不一致/);
    expect(database?.prepare('SELECT COUNT(*) AS count FROM research_jobs').get())
      .toMatchObject({ count: 0 });
  });

  it('rolls back an invalid missing-data resolution without falsely closing the queue item', async () => {
    const app = testApp();
    await enableDemo(app);
    const incomplete = cloneUShapedFixture();
    delete (incomplete.taskBook as Record<string, unknown>).marketplace;
    const created = await createJob(app, incomplete);
    const needsData = await runJob(app, created.id);
    expect(needsData.status).toBe('needs_data');

    await request(app).post(`/api/research-jobs/${created.id}/retry`).send({
      resolvedData: { marketplace: 'CA' }, resolvedBy: 'Invalid Resolver',
    }).expect(400);

    const unchanged = (await request(app).get(`/api/research-jobs/${created.id}`).expect(200))
      .body.data as ResearchJobDetail;
    const missing = (await request(app).get(`/api/research-jobs/${created.id}/missing-data`).expect(200))
      .body.data as MissingDataItem[];
    expect(unchanged).toMatchObject({ status: 'needs_data', dataVersion: needsData.dataVersion });
    expect(unchanged.taskBook).not.toHaveProperty('marketplace');
    expect(missing.find((item) => item.fieldName === 'marketplace')).toMatchObject({ status: 'open' });
  });

  it('keeps approval atomic and enforces every gate inside the orchestrator', async () => {
    const app = testApp();
    await enableDemo(app);
    const created = await createJob(app, cloneUShapedFixture());
    const waiting = await runJob(app, created.id);
    if (!database) throw new Error('Test database is not open.');
    const executionId = waiting.latestRuleExecution?.id;
    const reverseReviewId = waiting.reverseReview?.id;
    if (!executionId || !reverseReviewId) throw new Error('Workflow gates were not created.');

    database.prepare(`
      UPDATE rule_executions SET hard_gate_status = 'reject'
      WHERE id = ?
    `).run(executionId);
    await request(app).post(`/api/research-jobs/${created.id}/approve`).send({
      decision: 'approved', reason: 'must fail the hard gate guard', decidedBy: 'Guard Tester',
    }).expect(409);
    database.prepare(`UPDATE rule_executions SET hard_gate_status = 'pass' WHERE id = ?`)
      .run(executionId);

    database.prepare(`UPDATE reverse_reviews SET verdict = 'reject' WHERE id = ?`)
      .run(reverseReviewId);
    await request(app).post(`/api/research-jobs/${created.id}/approve`).send({
      decision: 'approved', reason: 'must fail the reverse review guard', decidedBy: 'Guard Tester',
    }).expect(409);
    database.prepare(`UPDATE reverse_reviews SET verdict = 'proceed_with_caution' WHERE id = ?`)
      .run(reverseReviewId);

    database.exec(`
      CREATE TRIGGER fail_workflow_decision BEFORE INSERT ON decisions
      WHEN NEW.research_job_id IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'forced workflow decision failure'); END;
    `);
    await request(app).post(`/api/research-jobs/${created.id}/approve`).send({
      decision: 'approved', reason: 'transaction must roll back', decidedBy: 'Guard Tester',
    }).expect(400);
    const unchanged = (await request(app).get(`/api/research-jobs/${created.id}`).expect(200))
      .body.data as ResearchJobDetail;
    expect(unchanged).toMatchObject({ status: 'waiting_approval', approval: { status: 'pending' } });
    expect(unchanged.decision).toBeUndefined();
  });

  it('blocks legacy development and opportunity mutations after an entity enters a V2 job', async () => {
    const app = testApp();
    await enableDemo(app);
    await createJob(app, cloneUShapedFixture());

    const analyze = await request(app)
      .post('/api/development-projects/dev-travel/analyze')
      .send({});
    expect(analyze.status, JSON.stringify(analyze.body)).toBe(409);
    expect(analyze.body.error).toMatch(/V2 Research Job|工作流/);

    const decision = await request(app)
      .post('/api/development-projects/dev-travel/decision')
      .send({
        decision: 'develop',
        reason: 'attempt to bypass V2',
        decidedBy: 'Legacy Caller',
      });
    expect(decision.status, JSON.stringify(decision.body)).toBe(409);
    expect(decision.body.error).toMatch(/V2 Research Job|工作流/);

    await createJob(app, {
      name: 'Opportunity bypass guard',
      type: 'new_opportunity',
      entityType: 'opportunity',
      entityId: 'opp-school-kit',
      createdBy: 'E2E Runner',
      input: { objective: 'Verify the V2 decision boundary.' },
      taskBook: {},
    });
    await request(app).post('/api/opportunities/opp-school-kit/promote').send({}).expect(409);
    await request(app).post('/api/opportunities/opp-school-kit/reject').send({
      reason: 'attempt to bypass V2', decidedBy: 'Legacy Caller',
    }).expect(409);
  });

  it('rejects an Evidence ID whose immutable data version differs from its job', async () => {
    const app = testApp();
    const created = await createJob(app, {
      name: 'Evidence version guard',
      type: 'new_opportunity',
      createdBy: 'E2E Runner',
      input: { objective: 'Verify evidence version ownership.' },
      taskBook: {},
    });
    if (!database) throw new Error('Test database is not open.');
    const workflowRepository = new WorkflowRepository(database);
    const evidenceInput = {
      claim: 'This fact belongs to a stale data version.',
      metricName: 'monthly_sales',
      metricValue: 4_200,
      source: 'Version guard fixture',
      sourceType: 'manual',
      sourceRecordId: 'stale-snapshot-1',
      collectedAt: '2026-09-10T08:00:00.000Z',
      period: '30D',
      isEstimated: false,
      calculation: 'fixture value',
      confidence: 1,
      dataVersion: created.dataVersion,
    } as const;

    expect(() => workflowRepository.createEvidence(created.id, {
      ...evidenceInput,
      dataVersion: `${created.dataVersion}-stale`,
    })).toThrow(/当前数据版本/);
    const currentEvidence = workflowRepository.createEvidence(created.id, {
      ...evidenceInput,
      sourceRecordId: 'current-snapshot-1',
    });
    expect(() => workflowRepository.assertEvidenceIds(created.id, [currentEvidence.id])).not.toThrow();
    database.prepare('UPDATE research_jobs SET data_version = ? WHERE id = ?')
      .run(`${created.dataVersion}-next`, created.id);
    expect(() => workflowRepository.assertEvidenceIds(created.id, [currentEvidence.id]))
      .toThrow(/跨任务或跨数据版本/);
  });

  it('does not expose stale conclusions after the current data version changes', async () => {
    const app = testApp();
    await enableDemo(app);
    const created = await createJob(app, cloneUShapedFixture());
    const waiting = await runJob(app, created.id);
    expect(waiting.latestInsight).toBeDefined();
    expect(waiting.latestRuleExecution).toBeDefined();
    expect(waiting.reviewInsights.length).toBeGreaterThan(0);
    if (!database) throw new Error('Test database is not open.');

    database.prepare(`UPDATE research_jobs SET data_version = ? WHERE id = ?`)
      .run('workflow-current-version-guard', created.id);
    const current = new WorkflowRepository(database).getResearchJob(created.id);
    expect(current?.dataVersion).toBe('workflow-current-version-guard');
    expect(current?.latestInsight).toBeUndefined();
    expect(current?.latestRuleExecution).toBeUndefined();
    expect(current?.latestScoreResult).toBeUndefined();
    expect(current?.reviewInsights).toEqual([]);
    expect(current?.reverseReview).toBeUndefined();
    expect(current?.approval).toBeUndefined();
    expect((await request(app).get(`/api/research-jobs/${created.id}/evidence`).expect(200)).body.data)
      .toEqual([]);
    const historicalEvidenceCount = database.prepare(`
      SELECT COUNT(*) AS count FROM evidence_records WHERE research_job_id = ?
    `).get(created.id) as { count: number };
    expect(Number(historicalEvidenceCount.count)).toBeGreaterThan(0);

    await request(app).post(`/api/research-jobs/${created.id}/approve`).send({
      decision: 'approved', reason: 'stale evidence must not authorize approval', decidedBy: 'Version Guard',
    }).expect(409);
    const stale = (await request(app).get(`/api/research-jobs/${created.id}`).expect(200))
      .body.data as ResearchJobDetail;
    expect(stale.status).toBe('waiting_approval');
    expect(stale.reverseReview).toBeUndefined();
    expect(stale.approval).toBeUndefined();
    expect(() => new WorkflowRepository(database!).createPendingApproval(
      waiting,
      'stale job objects cannot create approvals',
    )).toThrow(/版本不一致/);
  });

  it('retains an old needs-data decision for audit without presenting it as the current decision', async () => {
    const app = testApp();
    await enableDemo(app);
    const created = await createJob(app, cloneUShapedFixture());
    const waiting = await runJob(app, created.id);

    const returned = (await request(app).post(`/api/research-jobs/${created.id}/approve`).send({
      decision: 'needs_data', reason: '请补充样品复核记录。', decidedBy: 'Approval Owner',
    }).expect(201)).body.data as ResearchJobDetail;
    expect(returned).toMatchObject({ status: 'needs_data', decision: { decision: 'needs_data' } });

    const rerun = (await request(app).post(`/api/research-jobs/${created.id}/retry`).send({
      resolvedData: { approval_follow_up: '样品复核记录已补充并由负责人签字。' },
      resolvedBy: 'Data Owner',
    }).expect(200)).body.data as ResearchJobDetail;
    expect(rerun).toMatchObject({ status: 'waiting_approval', approval: { status: 'pending' } });
    expect(rerun.dataVersion).not.toBe(waiting.dataVersion);
    expect(rerun.decision).toBeUndefined();
    expect(rerun.reverseReview).toMatchObject({
      dataVersion: rerun.dataVersion,
      ruleProfileId: rerun.ruleProfileId,
      ruleProfileVersion: rerun.ruleProfileVersion,
      promptVersion: rerun.promptVersion,
    });
    expect(rerun.approval).toMatchObject({
      dataVersion: rerun.dataVersion,
      ruleProfileId: rerun.ruleProfileId,
      ruleProfileVersion: rerun.ruleProfileVersion,
      promptVersion: rerun.promptVersion,
      reverseReviewId: rerun.reverseReview?.id,
    });
    expect(database?.prepare(`
      SELECT COUNT(*) AS count FROM decisions WHERE research_job_id = ?
    `).get(created.id)).toMatchObject({ count: 1 });
    expect(database?.prepare(`
      SELECT COUNT(*) AS count FROM reverse_reviews WHERE research_job_id = ?
    `).get(created.id)).toMatchObject({ count: 2 });
    expect(database?.prepare(`
      SELECT COUNT(*) AS count FROM approvals WHERE research_job_id = ?
    `).get(created.id)).toMatchObject({ count: 2 });
  });
});
