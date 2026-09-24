import { afterEach, describe, expect, it } from 'vitest';
import { SellerSpriteMCPAdapter } from './adapters/sellersprite-mcp-adapter.js';
import {
  SellerSpriteMcpClient,
  type SellerSpriteMcpTransport,
} from './adapters/sellersprite-mcp-client.js';
import {
  SqliteMcpCallLedgerStore,
  SqliteMcpResponseCacheStore,
} from './adapters/sellersprite-mcp-store.js';
import { openDatabase, type AppDatabase } from './database/database.js';
import { WorkflowRepository } from './repository/workflow-repository.js';
import { DataCoverageService } from './services/data-coverage-service.js';
import { GoLiveMigrationService } from './services/go-live-migration-service.js';
import { SellerSpriteSyncService } from './services/sellersprite-sync-service.js';
import { WorkflowOrchestrator } from './services/workflow-orchestrator.js';
import { seedConfirmedOwnedRoster } from './test-utils/owned-roster-declaration.js';

const MARKET_ID = 'dynamic-market';
const NODE_PATH = '1055398:1063252:1199122:10671043011';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe('dynamic owned roster integration', () => {
  it('rejects a zero-SKU roster before certifying a market-only critical run', async () => {
    const fixture = createFixture(0);

    await expect(fixture.sync.syncCriticalBatch({ marketId: MARKET_ID, month: '202608' }))
      .rejects.toThrow(/自有 SKU/i);

    expect(fixture.transport.calls).toEqual([]);
    expect(database!.prepare(`
      SELECT status, total, success, failed FROM data_tasks WHERE task_type = 'critical_sync'
    `).get()).toBeUndefined();
    expect(database!.prepare(`
      SELECT is_complete AS isComplete FROM data_coverage_runs WHERE run_type = 'critical_sync'
    `).get()).toBeUndefined();
    expect(new DataCoverageService(database!).getCoverage('US').activeOwnedProducts)
      .toMatchObject({ covered: 0, total: 0, status: 'not_applicable' });
    expect(new GoLiveMigrationService(database!).verify()).toMatchObject({
      activeOwnedProducts: 0,
      sellerSpriteCriticalRunId: null,
      verifiedEvidenceEntities: 0,
      requiredEvidenceEntities: 1,
      readyForDemoCleanup: false,
      hasMinimumRealCoverage: false,
    });
  });

  it.each([1, 4, 5, 12, 50])(
    'keeps all %i saleable owned SKUs in one critical run, coverage, and Go Live proof',
    async (total) => {
      const fixture = createFixture(total);
      const diagnostics = await fixture.adapter.testConnection();
      expect(diagnostics).toMatchObject({ connected: true, authenticated: true, missingCapabilities: [] });
      database!.prepare(`
        UPDATE data_sources SET status = 'connected', last_sync_at = ?
        WHERE id = 'source-sellersprite-mcp'
      `).run(new Date().toISOString());

      const directOwner = fixture.ownedProducts[0]!;
      await fixture.sync.discoverCompetitors({ ownedProductId: directOwner.id });
      const candidate = fixture.sync.listCompetitorCandidates(directOwner.id)[0]!;
      fixture.sync.confirmCompetitorCandidate({
        ownedProductId: directOwner.id,
        candidateId: candidate.id,
        relationType: 'direct',
        reason: 'Dynamic roster human confirmation',
      });

      const input = { marketId: MARKET_ID, month: '202608', syncMode: 'certification' as const };
      const plan = fixture.sync.planCritical(input);
      const run = await fixture.sync.syncCriticalBatch({ ...input, planId: plan.id, confirmed: true });

      expect(run).toMatchObject({
        taskId: run.runId,
        marketSnapshots: 2,
        productSnapshots: total * 2,
        candidateCoverage: { status: 'success', total, success: total, failed: 0, candidates: total },
        competitorCoverage: { status: 'success', total: 1, success: 1, failed: 0 },
      });
      expect(database!.prepare(`
        SELECT total, success, failed, status FROM data_tasks WHERE id = ?
      `).get(run.runId)).toEqual({ total: total + 1, success: total + 1, failed: 0, status: 'success' });
      expect(database!.prepare(`
        SELECT COUNT(*) AS count FROM mcp_call_logs
        WHERE sync_run_id = ? AND capability = 'ASIN_SALES_TREND'
          AND status = 'success' AND cache_hit = 0
      `).get(run.runId)).toEqual({ count: total + 1 });
      expect(database!.prepare(`
        SELECT COUNT(*) AS count FROM mcp_call_logs
        WHERE sync_run_id = ? AND capability = 'ASIN_COMPETITOR_DISCOVERY'
          AND status = 'success' AND cache_hit = 0
      `).get(run.runId)).toEqual({ count: total });

      const coverageRow = database!.prepare(`
        SELECT coverage_json AS coverageJson, is_complete AS isComplete
        FROM data_coverage_runs WHERE id = ?
      `).get(run.runId) as { coverageJson: string; isComplete: number };
      const runCoverage = JSON.parse(coverageRow.coverageJson) as {
        activeOwnedProducts: number;
        productSnapshots: number;
        ownedProducts: Array<{ id: string; asin: string; marketNodeId: string }>;
      };
      expect(coverageRow.isComplete).toBe(1);
      expect(runCoverage).toMatchObject({
        activeOwnedProducts: total,
        productSnapshots: total * 2,
      });
      expect(runCoverage.ownedProducts).toHaveLength(total);
      expect(new Set(runCoverage.ownedProducts.map((item) => item.id)))
        .toEqual(new Set(fixture.ownedProducts.map((item) => item.id)));
      expect(runCoverage.ownedProducts.every((item) => (
        item.marketNodeId === MARKET_ID
          && fixture.ownedProducts.some((product) => (
            product.id === item.id && product.asin === item.asin
          ))
      ))).toBe(true);
      expect(database!.prepare(`
        SELECT COUNT(*) AS count, COUNT(DISTINCT entity_id) AS entities
        FROM mcp_sync_observation_links
        WHERE sync_run_id = ? AND snapshot_kind = 'product'
      `).get(run.runId)).toEqual({ count: (total + 1) * 2, entities: total + 1 });

      const coverage = new DataCoverageService(database!).getCoverage('US');
      expect(coverage.primaryMarket).toMatchObject({ covered: 1, total: 1, status: 'complete' });
      expect(coverage.activeOwnedProducts).toMatchObject({
        covered: total,
        total,
        status: 'complete',
      });

      const workflowRepository = new WorkflowRepository(database!);
      const workflow = new WorkflowOrchestrator(database!);
      const marketJob = workflowRepository.createResearchJob({
        name: `Dynamic market ${total}`,
        type: 'existing_market',
        entityType: 'market_node',
        entityId: MARKET_ID,
        createdBy: 'dynamic-roster-test',
        input: {},
        taskBook: {},
      });
      expect(workflow.run(marketJob.id).status).toBe('monitoring');
      for (const product of fixture.ownedProducts) {
        const job = workflowRepository.createResearchJob({
          name: `Dynamic owned ${product.id}`,
          type: 'owned_product',
          entityType: 'owned_product',
          entityId: product.id,
          createdBy: 'dynamic-roster-test',
          input: {},
          taskBook: {},
        });
        expect(workflow.run(job.id).status).toBe('monitoring');
      }

      const evidenceEntities = database!.prepare(`
        SELECT DISTINCT job.entity_id AS entityId, evidence.sync_run_id AS runId
        FROM evidence_records evidence
        JOIN research_jobs job ON job.id = evidence.research_job_id
        WHERE job.created_by = 'dynamic-roster-test' AND evidence.source_type = 'mcp'
        ORDER BY job.entity_id
      `).all() as Array<{ entityId: string; runId: string }>;
      expect(evidenceEntities).toHaveLength(total + 1);
      expect(new Set(evidenceEntities.map((item) => item.entityId)).size).toBe(total + 1);
      expect(new Set(evidenceEntities.map((item) => item.runId))).toEqual(new Set([run.runId]));

      const verification = new GoLiveMigrationService(database!).verify();
      expect(verification).toMatchObject({
        activeOwnedProducts: total,
        sellerSpriteAsinCalls: total,
        sellerSpriteCriticalRunId: run.runId,
        verifiedEvidenceEntities: total + 1,
        requiredEvidenceEntities: total + 1,
        hasPrimaryMarketHistory90d: true,
        runLinkedCandidateGroups: total,
        confirmedDirectCompetitors: 1,
        readyForDemoCleanup: true,
        hasMinimumRealCoverage: true,
      });
    },
    30_000,
  );
});

function createFixture(total: number): {
  sync: SellerSpriteSyncService;
  transport: DynamicRosterTransport;
  adapter: SellerSpriteMCPAdapter;
  ownedProducts: Array<{ id: string; asin: string; marketNodeId: string }>;
} {
  database = openDatabase(':memory:');
  database.exec(`
    INSERT INTO market_nodes (
      id, name, parent_id, level, marketplace, category_id, keywords_json,
      status, source_type, created_at, sellersprite_confirmed_node_path
    ) VALUES (
      '${MARKET_ID}', 'Dynamic Memory Foam', NULL, 1, 'US', '${NODE_PATH}', '[]',
      'active', 'import', '2026-09-20T00:00:00.000Z', '${NODE_PATH}'
    );
    UPDATE app_settings
    SET mode = 'live', marketplace = 'US', default_market_id = '${MARKET_ID}'
    WHERE id = 1;
    INSERT INTO market_snapshots (
      id, market_node_id, date, monthly_sales, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES (
      'dynamic-market-history', '${MARKET_ID}', '2026-05-31', 1000,
      'Historical import fixture', 'import', '2026-06-01T00:00:00.000Z',
      '1M', 0, 1, '2026-05-31', 'dynamic-market-history|2026-05-31|import'
    );
  `);
  const insertProduct = database.prepare(`
    INSERT INTO products (
      id, asin, sku, internal_name, brand, title, image_url, marketplace,
      product_type, is_owned, market_node_id, keywords_json, monitoring_enabled,
      source_type, created_at, status
    ) VALUES (?, ?, ?, ?, 'Dynamic Brand', ?, '', 'US', 'memory_foam_pillow',
      1, ?, '[]', 1, 'import', '2026-09-20T00:00:00.000Z', 'active')
  `);
  const ownedProducts: Array<{ id: string; asin: string; marketNodeId: string }> = [];
  for (let index = 1; index <= total; index += 1) {
    const suffix = String(index).padStart(5, '0');
    const product = {
      id: `dynamic-owned-${index}`,
      asin: `B0DYN${suffix}`,
      marketNodeId: MARKET_ID,
    };
    insertProduct.run(
      product.id,
      product.asin,
      `DYN-${index}`,
      `Dynamic SKU ${index}`,
      `Dynamic SKU ${index}`,
      MARKET_ID,
    );
    ownedProducts.push(product);
  }
  if (total > 0) seedConfirmedOwnedRoster(database);

  const transport = new DynamicRosterTransport();
  const client = new SellerSpriteMcpClient({
    transport,
    ledgerStore: new SqliteMcpCallLedgerStore(database),
    cacheStore: new SqliteMcpResponseCacheStore(database),
    cacheTtlMs: 0,
    rateLimit: { capacity: 256, refillPerSecond: 256 },
    retry: { maxAttempts: 1, baseDelayMs: 0 },
  });
  const adapter = new SellerSpriteMCPAdapter({ client, database });
  return { sync: new SellerSpriteSyncService(database, adapter), transport, adapter, ownedProducts };
}

class DynamicRosterTransport implements SellerSpriteMcpTransport {
  readonly calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  async connect(): Promise<void> {}
  async ping(): Promise<unknown> { return { _meta: { progressToken: 'dynamic-roster' } }; }
  async close(): Promise<void> {}

  async listTools(): Promise<unknown> {
    return {
      tools: [
        requestTool('market_research_statistics', ['marketplace', 'nodeIdPath', 'month']),
        requestTool('market_product_concentration', ['marketplace', 'nodeIdPath', 'month']),
        flatTool('asin_sales_trend', ['marketplace', 'asin']),
        flatTool('asin_competitor', ['marketplace', 'asin']),
        requestTool('market_research', ['marketplace', 'nodeIdPath', 'month']),
      ],
      _meta: { progressToken: 'dynamic-roster' },
    };
  }

  async callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown> {
    this.calls.push(params);
    const request = params.arguments.request && typeof params.arguments.request === 'object'
      ? params.arguments.request as Record<string, unknown>
      : params.arguments;
    const responses: Record<string, unknown> = {
      market_research_statistics: {
        marketplace: request.marketplace,
        nodeIdPath: request.nodeIdPath,
        month: request.month,
        products: 100,
        brands: 40,
        sellers: 50,
        totalUnits: request.month === '202608' ? 1_200 : 1_000,
        totalRevenue: request.month === '202608' ? 48_000 : 40_000,
        avgPrice: 40,
        medianPrice: 39,
        avgRating: 4.4,
        medianReviews: 100,
        top10Share: 25,
        top20Share: 40,
        newProductShare: 10,
      },
      market_product_concentration: Array.from({ length: 100 }, (_, index) => ({
        asin: `B0PEER${String(index + 1).padStart(4, '0')}`,
        marketplace: request.marketplace,
        nodeIdPath: request.nodeIdPath,
        month: request.month,
        title: 'Peer Pillow',
        brand: 'Peer',
        price: 40,
        rating: 4.3,
        ratings: 100,
        reviews: 20,
        totalUnits: request.month === '202608' ? 12 : 10,
        totalRevenue: request.month === '202608' ? 480 : 400,
        totalUnitsRatio: 0.01,
        totalRevenueRatio: 0.01,
      })),
      asin_sales_trend: {
        asin: {
          asin: request.asin,
          marketplace: request.marketplace,
          title: 'Dynamic owned product',
          brand: 'Dynamic Brand',
          price: 40,
          rating: 4.5,
          ratings: 100,
        },
        salesTrendPoints: [
          { month: '2026-07', childUnitSales: 100, childSalesRevenue: 4_000 },
          { month: '2026-08', childUnitSales: 120, childSalesRevenue: 4_800 },
        ],
      },
      asin_competitor: [{
        asin: 'B0PEER0001',
        title: 'Dynamic direct competitor',
        brand: 'Peer',
        units: 100,
      }],
      market_research: {
        marketplace: request.marketplace,
        nodeIdPath: request.nodeIdPath,
        page: 1,
        size: 1,
        total: 1,
        items: [{
          marketplace: request.marketplace,
          nodeIdPath: request.nodeIdPath,
          month: request.month,
          totalProducts: 100,
          topProducts: 100,
          totalUnits: request.month === '202608' ? 1_200 : 1_000,
          totalRevenue: request.month === '202608' ? 48_000 : 40_000,
          top10ProductSales: request.month === '202608' ? 120 : 100,
          top20ProductSales: request.month === '202608' ? 240 : 200,
          top10ProductCrn: 0.1,
          top20ProductCrn: 0.2,
        }],
        hasNextPage: false,
      },
    };
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ code: 'OK', message: 'success', data: responses[params.name] }),
        annotations: { audience: ['assistant'], priority: 1 },
      }],
      isError: false,
      _meta: { progressToken: 'dynamic-roster' },
    };
  }
}

function requestTool(name: string, fields: string[]): Record<string, unknown> {
  return {
    name,
    description: name.replaceAll('_', ' '),
    inputSchema: {
      type: 'object',
      required: ['request'],
      properties: {
        request: {
          type: 'object',
          required: fields,
          properties: Object.fromEntries(fields.map((field) => [field, { type: 'string' }])),
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: { provider: 'sellersprite' },
  };
}

function flatTool(name: string, fields: string[]): Record<string, unknown> {
  return {
    name,
    description: name.replaceAll('_', ' '),
    inputSchema: {
      type: 'object',
      required: fields,
      properties: Object.fromEntries(fields.map((field) => [field, { type: 'string' }])),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    _meta: { provider: 'sellersprite' },
  };
}
