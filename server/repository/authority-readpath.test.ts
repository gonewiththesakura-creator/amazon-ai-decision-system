import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { DeterministicAIService } from '../services/ai-service.js';
import { ExecutiveDashboardService } from '../services/executive-dashboard-service.js';
import { DashboardFreshnessService } from '../services/dashboard-freshness-service.js';
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
  syncRunId: string | null = null,
): void {
  db.prepare(`
    INSERT INTO market_snapshots (
      id, market_node_id, date, monthly_sales, monthly_revenue, avg_price,
      product_count, seller_count, top20_share, source, source_type,
      collected_at, period, is_estimated, confidence, observation_date, dedup_key, sync_run_id
    ) VALUES (?, 'market-us', ?, ?, ?, ?, 500, 30, 20, ?, ?, ?, '30D', 1, 0.9, ?, ?, ?)
  `).run(id, date, sales, revenue, price, source, sourceType, collectedAt, date, id, syncRunId);
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
  syncRunId: string | null = null,
): void {
  db.prepare(`
    INSERT INTO product_snapshots (
      id, product_id, date, price, rating, review_count, bsr, estimated_sales,
      estimated_revenue, seller_count, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key, sync_run_id
    ) VALUES (?, 'owned-sku', ?, 40, 4.4, 300, 100, ?, ?, 1, ?, ?, ?, '30D', ?, 0.9, ?, ?, ?)
  `).run(id, date, sales, revenue, source, sourceType, collectedAt, estimated ? 1 : 0, date, id, syncRunId);
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

function linkVerifiedMcpObservations(
  db: AppDatabase, links: Array<{ kind: 'market' | 'product' | 'fact'; id: string; entityId: string }>,
): void {
  const runId = `verified-${links.map((link) => link.id).join('-')}`;
  db.prepare(`
    INSERT INTO data_tasks (
      id, sync_run_id, name, source_id, task_type, target, source, marketplace,
      status, total, success, failed, created_at, completed_at
    ) VALUES (?, ?, 'Verified fixture', 'source-sellersprite-mcp', 'critical_sync',
      'market-us', 'SellerSprite MCP', 'US', 'success', 1, 1, 0, '2026-09-18', '2026-09-18')
  `).run(runId, runId);
  db.prepare(`
    INSERT INTO data_coverage_runs (id, marketplace, run_type, coverage_json, is_complete, created_at)
    VALUES (?, 'US', 'critical_sync', '{}', 1, '2026-09-18')
  `).run(runId);
  const insert = db.prepare(`
    INSERT INTO mcp_sync_observation_links
      (sync_run_id, snapshot_kind, snapshot_id, entity_id, disposition)
    VALUES (?, ?, ?, ?, 'reused')
  `);
  for (const link of links) insert.run(runId, link.kind, link.id, link.entityId);
}

function addFormalMarketInsight(
  db: AppDatabase, jobId: string, isDemo: boolean, generatedAt: string,
  evidenceSourceType: 'mcp' | 'mock' = isDemo ? 'mock' : 'mcp',
  storedEvidenceSourceType: 'mcp' | 'mock' = evidenceSourceType,
): void {
  const profile = db.prepare(`
    SELECT id, version FROM rule_profiles WHERE job_types_json LIKE '%existing_market%' LIMIT 1
  `).get() as { id: string; version: number };
  const version = `${jobId}-data-v1`;
  const evidenceId = `${jobId}-evidence`;
  const source = evidenceSourceType === 'mock' ? 'Demo' : 'SellerSprite MCP';
  db.prepare(`
    INSERT INTO research_jobs (
      id, name, job_type, marketplace, status, entity_type, entity_id,
      rule_profile_id, rule_profile_version, rule_profile_snapshot_json,
      is_demo, created_by, data_version, prompt_version, created_at, updated_at
    ) VALUES (?, ?, 'existing_market', 'US', 'monitoring', 'market', 'market-us',
      ?, ?, '{}', ?, 'test', ?, 'prompt-v1', ?, ?)
  `).run(jobId, jobId, profile.id, profile.version, isDemo ? 1 : 0, version, generatedAt, generatedAt);
  db.prepare(`
    INSERT INTO rule_executions (
      id, research_job_id, rule_profile_id, rule_version, input_json, output_json,
      hard_gate_status, created_at, data_version
    ) VALUES (?, ?, ?, ?, '{}', '{}', 'pass', ?, ?)
  `).run(`${jobId}-rule`, jobId, profile.id, profile.version, generatedAt, version);
  db.prepare(`
    INSERT INTO ai_insights (
      id, entity_type, entity_id, insight_type, status, title, summary,
      evidence_json, confidence, model, data_version, input_hash, generated_at,
      research_job_id, evidence_ids_json, prompt_version
    ) VALUES (?, 'research_job', ?, 'market_research', 'monitoring', ?, ?,
      ?, 0.8, 'rule-engine-v1', ?, ?, ?, ?, ?, 'prompt-v1')
  `).run(`${jobId}-insight`, jobId, jobId, jobId,
    JSON.stringify([{
      id: evidenceId, claim: 'market observation', metrics: [],
      provenance: [{ source, sourceType: evidenceSourceType }],
    }]), version, `${jobId}-input`, generatedAt, jobId, JSON.stringify([evidenceId]));
  db.prepare(`
    INSERT INTO evidence_records (
      id, research_job_id, insight_id, claim, metric_name, metric_value_json,
      source, source_type, collected_at, calculation, confidence, data_version, created_at
    ) VALUES (?, ?, ?, 'market observation', 'monthly_sales', '200',
      ?, ?, ?, 'from market snapshot', 0.8, ?, ?)
  `).run(evidenceId, jobId, `${jobId}-insight`, source, storedEvidenceSourceType,
    generatedAt, version, generatedAt);
}

describe('read-time metric authority', () => {
  it('keeps the last real market observation in Live when later Mock data and same-date Mock facts exist', () => {
    const { db, repository } = openFixture();
    addMarketSnapshot(db, 'market-real', '2026-09-18', 'SellerSprite MCP', 'mcp',
      '2026-09-18T08:00:00Z', 200, 5_000, 40);
    addMarketSnapshot(db, 'market-mock', '2026-09-19', 'Demo', 'mock',
      '2026-09-19T08:00:00Z', 900, 99_000, 99);
    addFact(db, 'market-mock-revenue', 'market', 'market-us', 'monthly_revenue', 88_000,
      'Demo', 'source-mock', 'mock', true);
    linkVerifiedMcpObservations(db, [{ kind: 'market', id: 'market-real', entityId: 'market-us' }]);

    const market = repository.getMarket('market-us');
    expect(market?.kpis).toMatchObject({ monthlySales: 200, monthlyRevenue: 5_000, avgPrice: 40 });
    expect(market?.provenance.sourceType).toBe('mcp');
    expect(market?.trends).toEqual([
      { date: '2026-09-18', sales: 200, revenue: 5_000, avgPrice: 40,
        productCount: 500, sellerCount: 30, medianReviews: null },
    ]);
    expect(repository.getMarkets()[0]).toMatchObject({ snapshotAvailable: true, monthlySales: 200 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM market_snapshots').get()).toEqual({ count: 2 });
  });

  it('keeps real SKU observations in Live and leaves missing fields empty instead of using Mock', () => {
    const { db, repository } = openFixture();
    addProduct(db);
    addProductSnapshot(db, 'sku-real', '2026-09-18', 'Amazon Report CSV', 'amazon',
      '2026-09-18T08:00:00Z', false, 120, null);
    addProductSnapshot(db, 'sku-mock', '2026-09-19', 'Demo', 'mock',
      '2026-09-19T08:00:00Z', true, 900, 36_000);
    addFact(db, 'sku-mock-revenue', 'product', 'owned-sku', 'estimated_revenue', 88_000,
      'Demo', 'source-mock', 'mock', true);

    expect(repository.getProductSnapshots('owned-sku')).toMatchObject([
      { id: 'sku-real', estimatedSales: 120, estimatedRevenue: null,
        provenance: { sourceType: 'amazon' } },
    ]);
    expect(repository.getOwnedProducts()[0].latest).toMatchObject({
      id: 'sku-real', estimatedSales: 120, estimatedRevenue: null,
      provenance: { sourceType: 'amazon' },
    });
    const dashboard = new ExecutiveDashboardService(db, repository, new WorkflowRepository(db))
      .getDashboard('30D');
    expect(dashboard.ownedSkuPerformance).toMatchObject([
      { id: 'owned-sku', skuGrowth: null, label: '数据不足' },
    ]);
  });

  it('does not use a joined Mock snapshot as the Live fallback when no real observations exist', () => {
    const { db, repository } = openFixture();
    addProduct(db);
    addMarketSnapshot(db, 'market-mock', '2026-09-19', 'Demo', 'mock',
      '2026-09-19T08:00:00Z', 900, 99_000, 99);
    addProductSnapshot(db, 'sku-mock', '2026-09-19', 'Demo', 'mock',
      '2026-09-19T08:00:00Z', true, 900, 36_000);

    expect(repository.getMarket('market-us')?.kpis).toMatchObject({
      monthlySales: null, monthlyRevenue: null,
    });
    expect(repository.getMarketSnapshots('market-us')).toEqual([]);
    expect(repository.getOwnedProducts()[0].latest).toMatchObject({
      id: '', snapshotAvailable: false, estimatedSales: null, estimatedRevenue: null,
    });
    expect(repository.getProductSnapshots('owned-sku')).toEqual([]);
  });

  it('continues to show Mock snapshots in Demo mode', () => {
    const { db, repository } = openFixture();
    db.prepare("UPDATE app_settings SET mode = 'demo' WHERE id = 1").run();
    addProduct(db);
    addMarketSnapshot(db, 'market-mock', '2026-09-19', 'Demo', 'mock',
      '2026-09-19T08:00:00Z', 900, 99_000, 99);
    addProductSnapshot(db, 'sku-mock', '2026-09-19', 'Demo', 'mock',
      '2026-09-19T08:00:00Z', true, 900, 36_000);

    expect(repository.getMarket('market-us')?.kpis.monthlySales).toBe(900);
    expect(repository.getOwnedProducts()[0].latest).toMatchObject({
      id: 'sku-mock', estimatedSales: 900, provenance: { sourceType: 'mock' },
    });
    expect(new DashboardFreshnessService(db).getStatus({
      marketplace: 'US', mode: 'demo', marketId: 'market-us',
      ownedProductIds: ['owned-sku'], competitorProductIds: [],
    }).coreBusinessFreshness).toMatchObject({
      marketUpdatedAt: '2026-09-19T08:00:00Z',
      ownedProductsUpdatedAt: '2026-09-19T08:00:00Z',
    });
  });

  it('uses the latest genuine formal market conclusion in Live instead of a newer Demo job', () => {
    const { db, repository } = openFixture();
    addFormalMarketInsight(db, 'real-market-job', false, '2026-09-18T08:00:00Z');
    addFormalMarketInsight(db, 'demo-market-job', true, '2026-09-19T08:00:00Z');

    expect(repository.getCurrentWorkflowInsightForEntity('market', 'market-us'))
      .toMatchObject({ researchJobId: 'real-market-job' });
    expect(repository.getMarket('market-us')?.insight)
      .toMatchObject({ researchJobId: 'real-market-job' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM research_jobs').get()).toEqual({ count: 2 });
  });

  it('does not promote a Mock-sourced formal conclusion in Live, even on a non-Demo job', () => {
    const { db, repository } = openFixture();
    addFormalMarketInsight(db, 'mixed-market-job', false, '2026-09-19T08:00:00Z', 'mock', 'mcp');

    expect(repository.getCurrentWorkflowInsightForEntity('market', 'market-us')).toBeNull();
    expect(repository.getMarket('market-us')?.insight).toMatchObject({
      insightType: 'workflow_required', evidenceIds: [],
    });
    db.prepare("UPDATE app_settings SET mode = 'demo' WHERE id = 1").run();
    expect(repository.getCurrentWorkflowInsightForEntity('market', 'market-us'))
      .toMatchObject({ researchJobId: 'mixed-market-job' });
  });

  it('does not promote a formal conclusion backed by a persisted Mock Evidence record in Live', () => {
    const { db, repository } = openFixture();
    addFormalMarketInsight(db, 'stored-mock-job', false, '2026-09-19T08:00:00Z', 'mcp', 'mock');

    expect(repository.getCurrentWorkflowInsightForEntity('market', 'market-us')).toBeNull();
    db.prepare("UPDATE app_settings SET mode = 'demo' WHERE id = 1").run();
    expect(repository.getCurrentWorkflowInsightForEntity('market', 'market-us'))
      .toMatchObject({ researchJobId: 'stored-mock-job' });
  });

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
    linkVerifiedMcpObservations(db, [
      { kind: 'market', id: 'market-mcp', entityId: 'market-us' },
      { kind: 'fact', id: 'market-mcp-sales', entityId: 'market-us' },
    ]);
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
    linkVerifiedMcpObservations(db, [
      { kind: 'product', id: 'product-mcp', entityId: 'owned-sku' },
      { kind: 'fact', id: 'product-mcp-sales', entityId: 'owned-sku' },
    ]);

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

  it('preserves lineage for historical competitor MCP facts recorded as product facts', () => {
    const { db, repository } = openFixture();
    db.prepare(`
      INSERT INTO products (
        id, asin, brand, title, image_url, marketplace, product_type,
        is_owned, market_node_id, source_type, created_at
      ) VALUES ('rival', 'B0RIVAL001', 'Rival', 'Rival pillow', '', 'US',
        'competitor', 0, 'market-us', 'mcp', '2026-09-18T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, estimated_sales, source, source_type,
        collected_at, period, is_estimated, confidence, observation_date, dedup_key
      ) VALUES (
        'rival-mcp', 'rival', '2026-09-18', 120, 'SellerSprite MCP', 'mcp',
        '2026-09-19T00:00:00Z', '1M', 1, 0.85, '2026-09-18', 'rival-mcp'
      ), (
        'rival-import', 'rival', '2026-09-18', 900, 'SellerSprite CSV', 'import',
        '2026-09-20T00:00:00Z', '1M', 1, 0.99, '2026-09-18', 'rival-import'
      )
    `).run();
    db.prepare(`
      INSERT INTO metric_facts (
        id, entity_type, entity_id, marketplace, metric_name, numeric_value,
        source, source_id, source_type, is_estimated, confidence,
        observation_date, collected_at, dedup_key
      ) VALUES (
        'historical-rival-sales', 'product', 'rival', 'US', 'estimated_sales', 125,
        'SellerSprite MCP', 'source-sellersprite-mcp', 'mcp', 1, 0.85,
        '2026-09-18', '2026-09-19T00:00:00Z', 'historical-rival-sales'
      )
    `).run();
    linkVerifiedMcpObservations(db, [
      { kind: 'product', id: 'rival-mcp', entityId: 'rival' },
      { kind: 'fact', id: 'historical-rival-sales', entityId: 'rival' },
    ]);

    const selected = repository.getProductSnapshots('rival')[0];
    expect(selected).toMatchObject({
      estimatedSales: 125,
      provenance: { source: 'SellerSprite MCP', sourceType: 'mcp' },
      metricProvenance: {
        estimated_sales: {
          sourceRecordId: 'historical-rival-sales', sourceRecordType: 'metric_fact',
        },
      },
    });
    expect(db.prepare(`SELECT entity_type, numeric_value FROM metric_facts WHERE id = ?`)
      .get(selected.metricProvenance?.estimated_sales.sourceRecordId ?? ''))
      .toEqual({ entity_type: 'product', numeric_value: 125 });
  });

  it('excludes observations from failed critical runs while allowing a later complete reuse link', () => {
    const { db, repository } = openFixture();
    addProduct(db);
    addProductSnapshot(db, 'product-valid', '2026-09-18', 'Legacy import', 'import',
      '2026-09-18T08:00:00Z', true, 100, 4_000);
    const failedRun = 'failed-critical-run';
    db.prepare(`
      INSERT INTO data_tasks (
        id, sync_run_id, name, source_id, task_type, target, source, marketplace,
        status, total, success, failed, created_at, completed_at
      ) VALUES (?, ?, 'Failed critical', 'source-sellersprite-mcp', 'critical_sync',
        'market-us', 'SellerSprite MCP', 'US', 'failed', 2, 1, 1, '2026-09-19', '2026-09-19')
    `).run(failedRun, failedRun);
    addProductSnapshot(db, 'product-failed-run', '2026-09-18', 'SellerSprite MCP', 'mcp',
      '2026-09-19T08:00:00Z', true, 220, 8_800, failedRun);
    addFact(db, 'failed-product-fact', 'product', 'owned-sku', 'estimated_sales', 220,
      'SellerSprite MCP', 'source-sellersprite-mcp', 'mcp', true);
    db.prepare(`UPDATE metric_facts SET sync_run_id = ? WHERE id = 'failed-product-fact'`).run(failedRun);

    expect(repository.getProductSnapshots('owned-sku')[0]).toMatchObject({
      id: 'product-valid', estimatedSales: 100,
    });
    expect(repository.getProductSnapshots('owned-sku')).toHaveLength(1);
    expect(repository.getOwnedProducts()[0].latest.id).toBe('product-valid');
    expect(new MetricAuthorityResolver(db).resolveMetric({
      entityType: 'product', entityId: 'owned-sku', metric: 'estimated_sales',
      observationDate: '2026-09-18',
    }).selected).toMatchObject({ id: 'product-valid', value: 100 });

    const completeRun = 'complete-critical-run';
    db.prepare(`
      INSERT INTO data_tasks (
        id, sync_run_id, name, source_id, task_type, target, source, marketplace,
        status, total, success, failed, created_at, completed_at
      ) VALUES (?, ?, 'Complete critical', 'source-sellersprite-mcp', 'critical_sync',
        'market-us', 'SellerSprite MCP', 'US', 'success', 2, 2, 0, '2026-09-20', '2026-09-20')
    `).run(completeRun, completeRun);
    db.prepare(`
      INSERT INTO data_coverage_runs (id, marketplace, run_type, coverage_json, is_complete, created_at)
      VALUES (?, 'US', 'critical_sync', '{}', 1, '2026-09-20')
    `).run(completeRun);
    db.prepare(`
      INSERT INTO mcp_sync_observation_links
        (sync_run_id, snapshot_kind, snapshot_id, entity_id, disposition)
      VALUES (?, 'product', 'product-failed-run', 'owned-sku', 'reused'),
        (?, 'fact', 'failed-product-fact', 'owned-sku', 'reused')
    `).run(completeRun, completeRun);

    expect(db.prepare(`SELECT sync_run_id FROM product_snapshots WHERE id = 'product-failed-run'`).get())
      .toEqual({ sync_run_id: failedRun });
    expect(db.prepare(`SELECT sync_run_id FROM metric_facts WHERE id = 'failed-product-fact'`).get())
      .toEqual({ sync_run_id: failedRun });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM mcp_sync_observation_links WHERE sync_run_id = ?`)
      .get(completeRun)).toEqual({ count: 2 });
    expect(db.prepare(`
      SELECT 1 FROM mcp_sync_observation_links link
      JOIN data_coverage_runs coverage ON coverage.id = link.sync_run_id
        AND coverage.run_type = 'critical_sync' AND coverage.is_complete = 1
      JOIN data_tasks task ON task.id = link.sync_run_id
        AND task.sync_run_id = link.sync_run_id AND task.task_type = 'critical_sync'
        AND task.status = 'success'
      WHERE link.snapshot_kind = 'fact' AND link.snapshot_id = 'failed-product-fact'
    `).get()).toEqual({ 1: 1 });
    expect(db.prepare(`
      SELECT 1 FROM data_tasks task
      WHERE task.id = ? AND task.status = 'success'
        AND (task.task_type <> 'critical_sync' OR EXISTS (
          SELECT 1 FROM data_coverage_runs coverage
          WHERE coverage.id = task.sync_run_id AND coverage.run_type = 'critical_sync'
            AND coverage.is_complete = 1
        ))
    `).get(completeRun)).toEqual({ 1: 1 });
    expect(db.prepare(`
      SELECT 1 FROM mcp_sync_observation_links link
      JOIN data_coverage_runs coverage ON coverage.id = link.sync_run_id
        AND coverage.run_type = 'critical_sync' AND coverage.is_complete = 1
      JOIN data_tasks task ON task.id = link.sync_run_id
        AND task.sync_run_id = link.sync_run_id AND task.task_type = 'critical_sync'
        AND task.status = 'success'
      WHERE link.snapshot_kind = ? AND link.snapshot_id = ?
      LIMIT 1
    `).get('fact', 'failed-product-fact')).toEqual({ 1: 1 });
    expect(db.prepare(`SELECT id, entity_type, entity_id, metric_name, observation_date, source_type
      FROM metric_facts WHERE id = 'failed-product-fact'`).get()).toMatchObject({
      id: 'failed-product-fact', entity_type: 'product', entity_id: 'owned-sku',
      metric_name: 'estimated_sales', observation_date: '2026-09-18', source_type: 'mcp',
    });
    expect(new MetricAuthorityResolver(db).resolveMetric({
      entityType: 'product', entityId: 'owned-sku', metric: 'estimated_sales',
      observationDate: '2026-09-18',
    }).selected).toMatchObject({ id: 'failed-product-fact', value: 220 });
    expect(repository.getProductSnapshots('owned-sku')[0]).toMatchObject({
      id: 'product-failed-run', estimatedSales: 220,
    });
  });

  it('keeps the prior market snapshot when a failed run writes a newer observation', () => {
    const { db, repository } = openFixture();
    addMarketSnapshot(db, 'market-valid', '2026-09-18', 'SellerSprite CSV', 'import',
      '2026-09-18T08:00:00Z', 100, 4_000, 40);
    const runId = 'failed-market-critical';
    db.prepare(`
      INSERT INTO data_tasks (
        id, sync_run_id, name, source_id, task_type, target, source, marketplace,
        status, total, success, failed, created_at, completed_at
      ) VALUES (?, ?, 'Failed market critical', 'source-sellersprite-mcp', 'critical_sync',
        'market-us', 'SellerSprite MCP', 'US', 'failed', 2, 1, 1, '2026-09-19', '2026-09-19')
    `).run(runId, runId);
    addMarketSnapshot(db, 'market-failed', '2026-09-19', 'SellerSprite MCP', 'mcp',
      '2026-09-19T08:00:00Z', 500, 20_000, 40, runId);

    expect(repository.getMarketSnapshots('market-us')).toHaveLength(1);
    expect(repository.getMarket('market-us')?.kpis.monthlySales).toBe(100);
    expect(repository.getMarkets()[0].snapshotAvailable).toBe(true);
  });

  it('keeps the prior SKU snapshot when a failed run writes a newer observation', () => {
    const { db, repository } = openFixture();
    addProduct(db);
    addProductSnapshot(db, 'product-valid', '2026-09-18', 'Amazon Report CSV', 'amazon',
      '2026-09-18T08:00:00Z', false, 100, 4_000);
    const runId = 'failed-product-critical';
    db.prepare(`
      INSERT INTO data_tasks (
        id, sync_run_id, name, source_id, task_type, target, source, marketplace,
        status, total, success, failed, created_at, completed_at
      ) VALUES (?, ?, 'Failed product critical', 'source-sellersprite-mcp', 'critical_sync',
        'market-us', 'SellerSprite MCP', 'US', 'failed', 2, 1, 1, '2026-09-19', '2026-09-19')
    `).run(runId, runId);
    addProductSnapshot(db, 'product-failed', '2026-09-19', 'SellerSprite MCP', 'mcp',
      '2026-09-19T08:00:00Z', true, 200, 8_000, runId);

    expect(repository.getProductSnapshots('owned-sku')).toHaveLength(1);
    expect(repository.getOwnedProducts()[0].latest).toMatchObject({
      id: 'product-valid', estimatedSales: 100,
    });
  });

  it('does not certify a runless MCP snapshot linked under a different entity', () => {
    const { db, repository } = openFixture();
    addMarketSnapshot(db, 'mislinked-market', '2026-09-19', 'SellerSprite MCP', 'mcp',
      '2026-09-19T08:00:00Z', 500, 20_000, 40);
    linkVerifiedMcpObservations(db, [
      { kind: 'market', id: 'mislinked-market', entityId: 'another-market' },
    ]);

    expect(repository.getMarketSnapshots('market-us')).toEqual([]);
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
