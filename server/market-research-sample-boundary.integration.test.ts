import { afterEach, describe, expect, it } from 'vitest';
import { SellerSpriteMCPAdapter } from './adapters/sellersprite-mcp-adapter.js';
import {
  SellerSpriteMcpClient, type SellerSpriteMcpTransport,
} from './adapters/sellersprite-mcp-client.js';
import {
  SqliteMcpCallLedgerStore, SqliteMcpResponseCacheStore,
} from './adapters/sellersprite-mcp-store.js';
import { openDatabase, type AppDatabase } from './database/database.js';
import { WorkflowRepository } from './repository/workflow-repository.js';
import { GoLiveMigrationService } from './services/go-live-migration-service.js';
import { ownedRosterDigest } from './services/owned-roster-declaration.js';
import { SellerSpriteSyncService } from './services/sellersprite-sync-service.js';
import { WorkflowOrchestrator } from './services/workflow-orchestrator.js';

const MARKET_ID = 'sample-boundary-market';
const NODE_PATH = '1055398:1063252:1199122:10671043011';
const PRODUCT_ID = 'sample-boundary-owned';
const ASIN = 'B0OWND0001';
const SKU = 'OWN-001';
let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe('real market research sample boundary', () => {
  it('persists 3290 full-market products but refuses TOP100 sample totals as market Evidence', async () => {
    database = setupDatabase();
    const transport = new SampleBoundaryTransport();
    const client = new SellerSpriteMcpClient({
      transport,
      ledgerStore: new SqliteMcpCallLedgerStore(database),
      cacheStore: new SqliteMcpResponseCacheStore(database),
      cacheTtlMs: 0,
      rateLimit: { capacity: 64, refillPerSecond: 64 },
      retry: { maxAttempts: 1, baseDelayMs: 0 },
    });
    const adapter = new SellerSpriteMCPAdapter({ client, database });
    expect(await adapter.testConnection()).toMatchObject({
      connected: true, authenticated: true, missingCapabilities: [],
    });
    database.prepare(`UPDATE data_sources SET status = 'connected', last_sync_at = ?
      WHERE id = 'source-sellersprite-mcp'`).run(new Date().toISOString());

    const run = await new SellerSpriteSyncService(database, adapter)
      .syncCriticalBatch({ marketId: MARKET_ID, month: '202608' });
    const marketSnapshots = database.prepare(`
      SELECT observation_date AS date, product_count AS products,
        monthly_sales AS sales, monthly_revenue AS revenue,
        top10_share AS top10Share, median_reviews AS medianReviews,
        sync_run_id AS runId
      FROM market_snapshots WHERE market_node_id = ? ORDER BY observation_date
    `).all(MARKET_ID);
    const monthlyCalls = database.prepare(`
      SELECT capability, observation_month AS month, status, cache_hit AS cacheHit,
        response_metadata_json AS metadata
      FROM mcp_call_logs WHERE sync_run_id = ?
        AND capability IN ('MARKET_RESEARCH', 'MARKET_STATISTICS', 'PRODUCT_CONCENTRATION')
      ORDER BY capability, observation_month
    `).all(run.runId) as Array<{
      capability: string; month: string; status: string; cacheHit: number; metadata: string | null;
    }>;

    expect(run).toMatchObject({
      taskId: run.runId, marketSnapshots: 2, productSnapshots: 2,
      candidateCoverage: { status: 'success', total: 1, success: 1, candidates: 1 },
      competitorCoverage: { status: 'success', total: 0 },
    });
    expect(marketSnapshots).toEqual([
      { date: '2026-07-31', products: 3290, sales: null, revenue: null,
        top10Share: null, medianReviews: null, runId: run.runId },
      { date: '2026-08-31', products: 3290, sales: null, revenue: null,
        top10Share: null, medianReviews: null, runId: run.runId },
    ]);
    expect(monthlyCalls.map(({ capability, month, status, cacheHit }) => (
      { capability, month, status, cacheHit }
    ))).toEqual([
      { capability: 'MARKET_RESEARCH', month: '202607', status: 'success', cacheHit: 0 },
      { capability: 'MARKET_RESEARCH', month: '202608', status: 'success', cacheHit: 0 },
      { capability: 'MARKET_STATISTICS', month: '202607', status: 'success', cacheHit: 0 },
      { capability: 'MARKET_STATISTICS', month: '202608', status: 'success', cacheHit: 0 },
      { capability: 'PRODUCT_CONCENTRATION', month: '202607', status: 'success', cacheHit: 0 },
      { capability: 'PRODUCT_CONCENTRATION', month: '202608', status: 'success', cacheHit: 0 },
    ]);
    expect(monthlyCalls.every(({ metadata }) => (
      JSON.parse(metadata ?? '{}').observationCertification?.method === 'documented_request_v1'
    ))).toBe(true);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM product_snapshots
      WHERE product_id = ? AND sync_run_id = ?`).get(PRODUCT_ID, run.runId))
      .toEqual({ count: 2 });

    const workflowRepository = new WorkflowRepository(database);
    const workflow = new WorkflowOrchestrator(database);
    const marketJob = workflowRepository.createResearchJob({
      name: 'Sample-boundary market', type: 'existing_market', entityType: 'market_node',
      entityId: MARKET_ID, createdBy: 'sample-boundary-test', input: {}, taskBook: {},
    });
    const ownedJob = workflowRepository.createResearchJob({
      name: 'Sample-boundary owned', type: 'owned_product', entityType: 'owned_product',
      entityId: PRODUCT_ID, createdBy: 'sample-boundary-test', input: {}, taskBook: {},
    });
    const marketResult = workflow.run(marketJob.id);
    const ownedResult = workflow.run(ownedJob.id);
    expect(marketResult.status).toBe('needs_data');
    expect(ownedResult.status).toBe('needs_data');
    expect(workflowRepository.getMissingData(marketJob.id).map(({ fieldName }) => fieldName))
      .toEqual(expect.arrayContaining(['monthly_sales', 'market_growth_baseline']));
    expect(workflowRepository.getMissingData(ownedJob.id).map(({ fieldName }) => fieldName))
      .toEqual(expect.arrayContaining(['market_growth_30d']));
    expect(database.prepare(`SELECT COUNT(*) AS count FROM evidence_records
      WHERE research_job_id IN (?, ?)`).get(marketJob.id, ownedJob.id))
      .toEqual({ count: 0 });
    expect(new GoLiveMigrationService(database).verify()).toMatchObject({
      activeOwnedProducts: 1, expectedOwnedProducts: 1,
      ownedRosterDeclarationStatus: 'confirmed', ownedRosterMatches: true,
      verifiedEvidenceEntities: 0, requiredEvidenceEntities: 2,
      sellerSpriteCriticalRunId: null, readyForDemoCleanup: false,
      hasMinimumRealCoverage: false,
    });
  }, 15_000);
});

function setupDatabase(): AppDatabase {
  const connection = openDatabase(':memory:');
  const now = new Date().toISOString();
  connection.prepare(`
    INSERT INTO market_nodes (
      id, name, parent_id, level, marketplace, category_id, keywords_json,
      status, source_type, created_at, sellersprite_confirmed_node_path
    ) VALUES (?, 'Sample-boundary market', NULL, 1, 'US', ?, '[]',
      'active', 'import', ?, ?)
  `).run(MARKET_ID, NODE_PATH, now, NODE_PATH);
  connection.prepare(`
    INSERT INTO products (
      id, asin, sku, brand, title, image_url, marketplace, product_type,
      is_owned, market_node_id, monitoring_enabled, source_type, created_at, status
    ) VALUES (?, ?, ?, 'Owned', 'Owned pillow', '', 'US', 'memory_foam_pillow',
      1, ?, 1, 'import', ?, 'active')
  `).run(PRODUCT_ID, ASIN, SKU, MARKET_ID, now);
  connection.prepare(`UPDATE app_settings SET mode = 'live', marketplace = 'US',
    default_market_id = ? WHERE id = 1`).run(MARKET_ID);

  const digest = ownedRosterDigest([{ asin: ASIN, sku: SKU }]);
  connection.prepare(`
    INSERT INTO data_tasks (
      id, name, task_type, target, source, marketplace, status,
      total, success, failed, created_at
    ) VALUES ('sample-master-task', 'Sample owned master import', 'file_import',
      'owned_product_master', 'Local import', 'US', 'success', 1, 1, 0, ?)
  `).run(now);
  connection.prepare(`
    INSERT INTO import_batches (
      id, filename, format, entity_type, row_count, success_count, failure_count,
      task_id, imported_at
    ) VALUES ('sample-master-batch', 'sample-owned-master.csv', 'csv',
      'owned_product_master', 1, 1, 0, 'sample-master-task', ?)
  `).run(now);
  connection.prepare(`
    INSERT INTO owned_roster_declarations (
      marketplace, declared_count, declared_digest, expected_count, expected_digest,
      preview_digest, status, import_batch_id, created_at, updated_at
    ) VALUES ('US', 1, ?, 1, ?, ?, 'confirmed', 'sample-master-batch', ?, ?)
  `).run(digest, digest, digest, now, now);
  return connection;
}

class SampleBoundaryTransport implements SellerSpriteMcpTransport {
  async connect(): Promise<void> {}
  async ping(): Promise<unknown> { return { _meta: { progressToken: 'sample-boundary' } }; }
  async close(): Promise<void> {}

  async listTools(): Promise<unknown> {
    return { tools: [
      requestTool('market_research'),
      requestTool('market_research_statistics'),
      requestTool('market_product_concentration'),
      flatTool('asin_sales_trend'),
      flatTool('asin_competitor'),
    ] };
  }

  async callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown> {
    const request = params.arguments.request && typeof params.arguments.request === 'object'
      ? params.arguments.request as Record<string, unknown> : params.arguments;
    const current = request.month === '202608';
    const result: Record<string, unknown> = {
      market_research: {
        page: 1, size: 1, total: 1, hasNextPage: false,
        items: [{ marketplace: request.marketplace, nodeIdPath: request.nodeIdPath,
          totalProducts: 3290, topProducts: 100,
          totalUnits: current ? 120_000 : 100_000,
          totalRevenue: current ? 4_800_000 : 4_000_000,
          top10ProductSales: current ? 12_000 : 10_000,
          top20ProductSales: current ? 24_000 : 20_000,
          top10ProductCrn: 0.1, top20ProductCrn: 0.2 }],
      },
      market_research_statistics: {
        marketplace: request.marketplace, nodeIdPath: request.nodeIdPath,
        products: 100, sellers: 70, brands: 62, avgPrice: 36.38,
        avgRating: 4.2, newProductProportion: 41,
      },
      market_product_concentration: Array.from({ length: 100 }, (_, index) => ({
        asin: `B0PEER${String(index + 1).padStart(4, '0')}`,
        price: 35, rating: 4.2, ratings: 120, reviews: 20,
        totalUnits: 1000, totalRevenue: 35_000,
        totalUnitsRatio: 0.01, totalRevenueRatio: 0.01,
      })),
      asin_sales_trend: {
        asin: { asin: request.asin, marketplace: request.marketplace,
          title: 'Owned pillow', brand: 'Owned', price: 45.99, rating: 4.6, ratings: 90 },
        salesTrendPoints: [
          { month: '2026-07', childUnitSales: 100, childSalesRevenue: 4_599 },
          { month: '2026-08', childUnitSales: 120, childSalesRevenue: 5_518.8 },
        ],
      },
      asin_competitor: [{ asin: 'B0PEER0001', brand: 'Peer', title: 'Peer pillow', units: 100 }],
    };
    return { content: [{ type: 'text', text: JSON.stringify({
      code: 'OK', message: 'success', data: result[params.name],
    }) }], isError: false };
  }
}

function requestTool(name: string): Record<string, unknown> {
  return { name, description: name, inputSchema: { type: 'object',
    required: ['request'], properties: { request: { type: 'object',
      required: ['marketplace', 'nodeIdPath', 'month'], properties: {
        marketplace: { type: 'string' }, nodeIdPath: { type: 'string' },
        month: { type: 'string' },
      },
    } },
  } };
}

function flatTool(name: string): Record<string, unknown> {
  return { name, description: name, inputSchema: { type: 'object',
    required: ['marketplace', 'asin'], properties: {
      marketplace: { type: 'string' }, asin: { type: 'string' },
    },
  } };
}
