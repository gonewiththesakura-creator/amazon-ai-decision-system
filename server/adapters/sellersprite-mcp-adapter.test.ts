import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { SellerSpriteMCPAdapter } from './sellersprite-mcp-adapter.js';
import { SellerSpriteMcpClient, type SellerSpriteMcpTransport } from './sellersprite-mcp-client.js';
import { SqliteMcpCallLedgerStore, SqliteMcpResponseCacheStore } from './sellersprite-mcp-store.js';
import { openDatabase } from '../database/database.js';
import { createApp } from '../app.js';
import { WorkflowRepository } from '../repository/workflow-repository.js';
import { SellerSpriteSyncService } from '../services/sellersprite-sync-service.js';
import { GoLiveMigrationService } from '../services/go-live-migration-service.js';
import { WorkflowOrchestrator } from '../services/workflow-orchestrator.js';
import { seedConfirmedOwnedRoster } from '../test-utils/owned-roster-declaration.js';

describe('SellerSpriteMCPAdapter', () => {
  it.each([false, true])('reuses persisted capability TTL across ASIN tasks despite unrelated redaction (run=%s)', async withRun => {
    const database = openDatabase(':memory:');
    class CatalogTransport extends AdapterTransport {
      override async listTools(): Promise<unknown> {
        const catalog = await super.listTools() as {tools: unknown[]};
        catalog.tools.push({name:'keyword_research_trends', inputSchema:{type:'object',
          properties:{keyword:{type:'string'}},required:['keyword']}});
        return catalog;
      }
    }
    const transport=new CatalogTransport();
    transport.includeAsinDetail=true;
    const invoke=async(index:number)=>{
      if (withRun) database.prepare(`INSERT INTO data_tasks (id,name,task_type,target,source,status,created_at)
        VALUES (?,'Offline fixture','identity','B000TEST01','test','running',?)`).run(`task-${index}`,new Date().toISOString());
      const adapter=new SellerSpriteMCPAdapter({database,client:new SellerSpriteMcpClient({transport})});
      await adapter.fetchAsinIdentity({marketplace:'US',asin:'B000TEST01'},withRun?{runId:`task-${index}`} : undefined);
      await adapter.close();
    };
    try {
      await invoke(1);
      const cached=database.prepare('SELECT capabilities_json FROM provider_capability_snapshots').get()!;
      expect(String(cached.capabilities_json)).toContain('[PII_PATH]');
      await invoke(2);
      await invoke(3);
      expect(transport.listToolsCallCount).toBe(1);
      const snapshot=database.prepare('SELECT id,capabilities_json FROM provider_capability_snapshots ORDER BY rowid DESC LIMIT 1').get()!;
      const broken=JSON.parse(String(snapshot.capabilities_json));
      const detail=broken.tools.find((t:{name:string})=>t.name==='asin_detail');
      detail.inputSchema.required=['marketplace','[PII_PATH]'];
      database.prepare('UPDATE provider_capability_snapshots SET capabilities_json=? WHERE id=?').run(JSON.stringify(broken),snapshot.id);
      await invoke(4);
      expect(transport.listToolsCallCount).toBe(2);
      database.exec("UPDATE provider_capability_snapshots SET collected_at='2000-01-01T00:00:00.000Z'");
      await invoke(5);
      expect(transport.listToolsCallCount).toBe(3);
      const adapter=new SellerSpriteMCPAdapter({database,client:new SellerSpriteMcpClient({transport})});
      await adapter.refreshCapabilities();
      expect(transport.listToolsCallCount).toBe(4);
      await adapter.close();
    } finally {database.close();}
  });
  it('pins callable tool schemas to each run when two run discoveries interleave', async () => {
    class RotatingTransport extends AdapterTransport {
      catalogVersion: 'a' | 'b' = 'a';

      override async listTools(): Promise<unknown> {
        const result = await super.listTools() as { tools: Array<{ name: string; description: string }> };
        if (this.catalogVersion === 'b') {
          result.tools = result.tools.map((entry) => entry.name === 'market_research_statistics'
            ? { ...entry, name: 'market_statistics_v2', description: 'Market statistics v2' }
            : entry);
        }
        return result;
      }
    }
    const transport = new RotatingTransport();
    transport.responseData = {
      marketplace: 'US', nodeIdPath: '1055398:1063252', products: 100,
    };
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });
    const input = { marketplace: 'US', nodeIdPath: '1055398:1063252' };
    const runA = '123e4567-e89b-42d3-a456-426614174001';
    const runB = '123e4567-e89b-42d3-a456-426614174002';

    await adapter.fetchMarketStatistics(input, { runId: runA });
    transport.catalogVersion = 'b';
    await adapter.fetchMarketStatistics(input, { runId: runB });
    await adapter.fetchMarketStatistics(input, { runId: runA });

    expect(transport.calls.map((call) => call.name)).toEqual([
      'market_research_statistics', 'market_statistics_v2', 'market_research_statistics',
    ]);
    expect(transport.listToolsCallCount).toBe(2);
  });

  it('discovers one immutable schema for parallel calls in the same run', async () => {
    const transport = new AdapterTransport();
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });
    const input = { marketplace: 'US', nodeIdPath: '1055398:1063252' };
    const runId = '123e4567-e89b-42d3-a456-426614174003';

    await Promise.all([
      adapter.fetchMarketStatistics(input, { runId }),
      adapter.fetchMarketConcentration(input, { runId }),
    ]);

    expect(transport.listToolsCallCount).toBe(1);
  });

  it('certifies one real transport run through workflows, dashboard, and Go Live Evidence', async () => {
    const database = openDatabase(':memory:');
    try {
      database.exec(`
        INSERT INTO market_nodes (
          id, name, level, marketplace, category_id, sellersprite_confirmed_node_path,
          status, source_type, created_at
        ) VALUES ('market-live', 'Memory Foam Pillows', 1, 'US', '1055398:1063252',
          '1055398:1063252', 'active', 'import', '2026-09-20T00:00:00Z');
        INSERT INTO products (
          id, asin, sku, brand, title, image_url, marketplace, product_type,
          is_owned, market_node_id, status, source_type, created_at
        ) VALUES ('owned-live', 'B000TEST01', 'LIVE-01', 'Own', 'Owned Pillow', '',
          'US', 'memory_foam_pillow', 1, 'market-live', 'active', 'import',
          '2026-09-20T00:00:00Z');
        INSERT INTO products (
          id, asin, sku, brand, title, image_url, marketplace, product_type,
          is_owned, market_node_id, status, source_type, created_at
        ) VALUES ('competitor-live', 'B000TEST02', NULL, 'Peer', 'Candidate', '',
          'US', 'memory_foam_pillow', 0, 'market-live', 'active', 'import',
          '2026-09-20T00:00:00Z');
        INSERT INTO competitor_candidates (
          id, marketplace, asin, source_product_id, source, source_type, payload_json,
          status, created_at, reviewed_at
        ) VALUES (
          'candidate-live-direct', 'US', 'B000TEST02', 'owned-live', 'SellerSprite MCP', 'mcp',
          '{"asin":"B000TEST02","parentAsin":null,"title":"Candidate","brand":null,"price":null,"units":300,"revenue":null,"rating":null,"ratings":null}',
          'confirmed', '2026-09-20T00:00:00Z', '2026-09-20T00:05:00Z'
        );
        INSERT INTO competitor_relations (
          id, owned_product_id, competitor_product_id, relation_type, similarity_score,
          reason, ai_tags_json, created_at, last_verified_at
        ) VALUES (
          'relation-live-direct', 'owned-live', 'competitor-live', 'direct', 90,
          'Human-confirmed integration fixture', '[]',
          '2026-09-20T00:05:00Z', '2026-09-20T00:05:00Z'
        );
        INSERT INTO market_snapshots (
          id, market_node_id, date, monthly_sales, source, source_type, collected_at,
          period, is_estimated, confidence, observation_date, dedup_key
        ) VALUES (
          'market-live-history', 'market-live', '2026-05-31', 1000,
          'Historical import fixture', 'import', '2026-06-01T00:00:00Z',
          '1M', 0, 1, '2026-05-31', 'market-live|2026-05-31|import'
        );
        UPDATE app_settings
        SET mode = 'live', marketplace = 'US', default_market_id = 'market-live'
        WHERE id = 1;
      `);
      for (const [id, asin] of [
        ['owned-live-2', 'B000TEST03'],
        ['owned-live-3', 'B000TEST04'],
        ['owned-live-4', 'B000TEST05'],
      ] as const) {
        database.prepare(`INSERT INTO products (
          id, asin, sku, brand, title, image_url, marketplace, product_type,
          is_owned, market_node_id, status, source_type, created_at
        ) VALUES (?, ?, ?, 'Own', 'Owned Pillow', '', 'US', 'memory_foam_pillow',
          1, 'market-live', 'active', 'import', '2026-09-20T00:00:00Z')`)
          .run(id, asin, id);
      }
      seedConfirmedOwnedRoster(database);
      const transport = new AdapterTransport();
      transport.marketToolsRequireMonth = true;
      transport.echoConcentrationMonth = true;
      transport.concentrationItems = transport.concentrationItems.map((item) => ({
        ...item, reviews: item.ratings,
      }));
      transport.marketStatisticsByMonth = {
        '202607': {
          marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202607',
          products: 2, brands: 2, sellers: 2, totalUnits: 1_000, totalRevenue: 40_000,
          avgPrice: 40, medianPrice: 39, avgRating: 4.2, medianReviews: 90,
          top10Share: 24, top20Share: 39, newProductShare: 9,
        },
        '202608': {
          marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608',
          products: 2, brands: 2, sellers: 2, totalUnits: 1_200, totalRevenue: 48_000,
          avgPrice: 42, medianPrice: 41, avgRating: 4.3, medianReviews: 100,
          top10Share: 25, top20Share: 40, newProductShare: 10,
        },
      };
      transport.marketResearchByMonth = {
        '202607': {
          marketplace: 'US', nodeIdPath: '1055398:1063252',
          totalProducts: 2, topProducts: 2, totalUnits: 1_000, totalRevenue: 40_000,
          top10ProductSales: 1_000, top20ProductSales: 1_000,
          top10ProductCrn: 1, top20ProductCrn: 1,
        },
        '202608': {
          marketplace: 'US', nodeIdPath: '1055398:1063252',
          totalProducts: 2, topProducts: 2, totalUnits: 1_200, totalRevenue: 48_000,
          top10ProductSales: 1_200, top20ProductSales: 1_200,
          top10ProductCrn: 1, top20ProductCrn: 1,
        },
      };
      transport.salesTrendPoints = [
        { month: '2026-07', childUnitSales: 200, childSalesRevenue: 8_000 },
        { month: '2026-08', childUnitSales: 240, childSalesRevenue: 9_600 },
      ];
      const client = new SellerSpriteMcpClient({
        transport,
        ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
      });
      const adapter = new SellerSpriteMCPAdapter({ client, database });
      const diagnostics = await adapter.testConnection();
      expect(diagnostics).toMatchObject({ connected: true, authenticated: true, missingCapabilities: [] });
      database.prepare(`UPDATE data_sources SET status = 'connected', last_sync_at = ?
        WHERE id = 'source-sellersprite-mcp'`).run(new Date().toISOString());

      const sync = new SellerSpriteSyncService(database, adapter);
      const input = { marketId: 'market-live', month: '202608', syncMode: 'certification' as const };
      const plan = sync.planCritical(input);
      const run = await sync.syncCriticalBatch({ ...input, planId: plan.id, confirmed: true });
      const workflowRepository = new WorkflowRepository(database);
      const workflow = new WorkflowOrchestrator(database);
      const marketJob = workflowRepository.createResearchJob({
        name: 'Live market workflow', type: 'existing_market', entityType: 'market_node',
        entityId: 'market-live', createdBy: 'integration-test', input: {}, taskBook: {},
      });
      const marketResult = workflow.run(marketJob.id);
      const ownedResults = ['owned-live', 'owned-live-2', 'owned-live-3', 'owned-live-4']
        .map((entityId) => {
          const job = workflowRepository.createResearchJob({
            name: `Live owned SKU workflow ${entityId}`, type: 'owned_product',
            entityType: 'owned_product', entityId, createdBy: 'integration-test',
            input: {}, taskBook: {},
          });
          return { entityId, job, result: workflow.run(job.id) };
        });
      const app = createApp({ database });
      const dashboard = (await request(app).get('/api/dashboard/briefing').expect(200)).body.data;
      const verification = new GoLiveMigrationService(database).verify();

      expect(run).toMatchObject({
        taskId: run.runId, marketSnapshots: 2, productSnapshots: 8,
        candidateCoverage: { status: 'success', total: 4, candidates: 4 },
        competitorCoverage: { status: 'success', total: 1, success: 1 },
      });
      expect(marketResult).toMatchObject({ status: 'monitoring', latestInsight: {
        researchJobId: marketJob.id, evidenceIds: expect.arrayContaining([expect.any(String)]),
      } });
      for (const { job, result } of ownedResults) {
        expect(result).toMatchObject({ status: 'monitoring', latestInsight: {
          researchJobId: job.id, evidenceIds: expect.arrayContaining([expect.any(String)]),
        } });
      }
      expect(dashboard.summaries.skus.analyzable).toBe(4);
      expect(dashboard.briefing).toEqual(expect.arrayContaining([
        expect.objectContaining({ entityType: 'market', entityId: 'market-live' }),
        expect.objectContaining({ entityType: 'owned_product', entityId: 'owned-live' }),
      ]));
      expect(dashboard.briefing.every((item: { insight?: { researchJobId?: string; evidenceIds?: string[] } }) => (
        Boolean(item.insight?.researchJobId && item.insight.evidenceIds?.length)
      ))).toBe(true);
      expect(verification).toMatchObject({
        sellerSpriteCriticalRunId: run.runId,
        verifiedEvidenceEntities: 5,
        requiredEvidenceEntities: 5,
        hasPrimaryMarketHistory90d: true,
        runLinkedCandidateGroups: 4,
        confirmedDirectCompetitors: 1,
        readyForDemoCleanup: true,
        hasMinimumRealCoverage: true,
      });
      expect(database.prepare(`
        SELECT DISTINCT sync_run_id AS runId FROM mcp_call_logs
        WHERE sync_run_id IS NOT NULL ORDER BY sync_run_id
      `).all()).toEqual([{ runId: run.runId }]);
      expect(database.prepare(`
        SELECT capability, COUNT(*) AS count FROM mcp_call_logs
        WHERE sync_run_id = ? GROUP BY capability ORDER BY capability
      `).all(run.runId)).toEqual(expect.arrayContaining([
        { capability: 'ASIN_COMPETITOR_DISCOVERY', count: 4 },
        { capability: 'ASIN_SALES_TREND', count: 5 },
        { capability: 'LIST_TOOLS', count: expect.any(Number) },
        { capability: 'MARKET_STATISTICS', count: 2 },
        { capability: 'PRODUCT_CONCENTRATION', count: 2 },
      ]));
    } finally { database.close(); }
  }, 15_000);

  it('keeps critical run context in the ledger and out of provider arguments', async () => {
    const database = openDatabase(':memory:');
    try {
      const runId = '123e4567-e89b-42d3-a456-426614174001';
      database.prepare(`INSERT INTO data_tasks (
        id, name, task_type, target, source, marketplace, status, created_at
      ) VALUES (?, 'Critical sync', 'critical_sync', 'market-1',
        'SellerSprite MCP', 'US', 'running', '2026-09-20T00:00:00.000Z')`).run(runId);
      const transport = new AdapterTransport();
      const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({
        transport, ledgerStore: new SqliteMcpCallLedgerStore(database),
      }) });

      await adapter.fetchMarketStatistics(
        { marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608' },
        { runId },
      );
      await adapter.fetchAsinSalesTrend({ marketplace: 'US', asin: 'B000TEST01' }, { runId });
      await adapter.discoverAsinCompetitors(
        { marketplace: 'US', asin: 'B000TEST01', size: 10 }, { runId },
      );

      expect(transport.calls.map((call) => call.arguments)).toEqual([
        { request: { marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608' } },
        { marketplace: 'US', asin: 'B000TEST01' },
        { marketplace: 'US', asin: 'B000TEST01', size: 10 },
      ]);
      expect(database.prepare(`SELECT capability, sync_run_id FROM mcp_call_logs
        WHERE capability <> 'LIST_TOOLS' ORDER BY rowid`).all())
        .toEqual([
          { capability: 'MARKET_STATISTICS', sync_run_id: runId },
          { capability: 'ASIN_SALES_TREND', sync_run_id: runId },
          { capability: 'ASIN_COMPETITOR_DISCOVERY', sync_run_id: runId },
        ]);
    } finally { database.close(); }
  });

  it('records the exact market path and ASIN with result counts for scoped go-live checks', async () => {
    const database = openDatabase(':memory:');
    try {
      const transport = new AdapterTransport();
      const client = new SellerSpriteMcpClient({ transport,
        ledgerStore: new SqliteMcpCallLedgerStore(database) });
      const adapter = new SellerSpriteMCPAdapter({ client });
      await adapter.fetchMarketStatistics({ marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608' });
      await adapter.fetchAsinSalesTrend({ marketplace: 'US', asin: 'B000TEST01' });

      expect(database.prepare(`SELECT capability, entity_type, entity_id, result_count
        FROM mcp_call_logs WHERE capability <> 'LIST_TOOLS' ORDER BY rowid`).all()).toEqual([
        { capability: 'MARKET_STATISTICS', entity_type: 'market', entity_id: '1055398:1063252', result_count: 1 },
        { capability: 'ASIN_SALES_TREND', entity_type: 'product', entity_id: 'B000TEST01', result_count: 1 },
      ]);
    } finally { database.close(); }
  });
  it('does not certify or cache a malformed capability response', async () => {
    const database = openDatabase(':memory:');
    try {
      const transport = new AdapterTransport();
      transport.responseData = { asin: { asin: 'B000TEST01' }, salesTrendPoints: 'not-an-array' };
      const client = new SellerSpriteMcpClient({ transport,
        ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
        retry: { maxAttempts: 1, baseDelayMs: 1 },
      });
      const adapter = new SellerSpriteMCPAdapter({ client });
      const input = { marketplace: 'US', asin: 'B000TEST01' };

      await expect(adapter.fetchAsinSalesTrend(input)).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
      expect(database.prepare(`SELECT status, error_code FROM mcp_call_logs
        WHERE capability <> 'LIST_TOOLS'`).all()).toEqual([
        { status: 'failed', error_code: 'INVALID_SCHEMA' },
      ]);
      expect(database.prepare('SELECT COUNT(*) AS total FROM mcp_response_cache').get()).toEqual({ total: 0 });

      transport.responseData = undefined;
      const valid = await adapter.fetchAsinSalesTrend(input);
      expect(valid.data.salesTrendPoints).toHaveLength(1);
      expect(transport.calls).toHaveLength(2);
    } finally { database.close(); }
  });
  it.each([
    ['marketplace', { marketplace: 'CA', nodeIdPath: '1055398:1063252', month: '2026-08' }],
    ['node', { marketplace: 'US', nodeIdPath: '9999999', month: '2026-08' }],
    ['month', { marketplace: 'US', nodeIdPath: '1055398:1063252', month: '2026-07' }],
  ])('rejects mismatched market %s before certifying or caching the response', async (_field, invalid) => {
    const database = openDatabase(':memory:');
    try {
      const transport = new AdapterTransport();
      transport.responseData = { products: 100, ...invalid };
      const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({
        transport, ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
      }) });
      const input = { marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608' };

      await expect(adapter.fetchMarketStatistics(input)).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
      expect(database.prepare("SELECT status, error_code FROM mcp_call_logs WHERE capability <> 'LIST_TOOLS'").all()).toEqual([
        { status: 'failed', error_code: 'INVALID_SCHEMA' },
      ]);
      expect(database.prepare('SELECT COUNT(*) AS total FROM mcp_response_cache').get()).toEqual({ total: 0 });

      transport.responseData = { products: 100, marketplace: 'US', nodeIdPath: input.nodeIdPath, month: '2026-08' };
      await expect(adapter.fetchMarketStatistics(input)).resolves.toMatchObject({ data: { products: 100 } });
      expect(transport.calls).toHaveLength(2);
    } finally { database.close(); }
  });
  it.each([
    ['marketplace', { nodeIdPath: '1055398:1063252', products: 100 }],
    ['nodeIdPath', { marketplace: 'US', products: 100 }],
  ])('rejects market statistics without documented %s scope', async (_field, responseData) => {
    const transport = new AdapterTransport();
    transport.responseData = responseData;
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    await expect(adapter.fetchMarketStatistics({
      marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608',
    })).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
  });

  it('accepts documented market rows that omit month while retaining verified market scope', async () => {
    const transport = new AdapterTransport();
    transport.responseData = {
      marketplace: 'US', nodeIdPath: '1055398:1063252', products: 100,
    };
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    await expect(adapter.fetchMarketStatistics({
      marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608',
    })).resolves.toMatchObject({ data: { products: 100 } });
  });

  it('certifies exact documented market tools from a fresh run schema without response month echoes', async () => {
    const database = openDatabase(':memory:');
    try {
      const runId = '123e4567-e89b-42d3-a456-426614174050';
      database.prepare(`INSERT INTO data_tasks (
        id, name, task_type, target, source, marketplace, status, created_at
      ) VALUES (?, 'Critical sync', 'critical_sync', 'market-1',
        'SellerSprite MCP', 'US', 'running', '2026-09-20T00:00:00.000Z')`).run(runId);
      const transport = new AdapterTransport();
      transport.marketToolsRequireMonth = true;
      transport.marketStatisticsByMonth = {
        '202607': { marketplace: 'US', nodeIdPath: '1055398:1063252', month: null, avgUnits: 100 },
        '202608': { marketplace: 'US', nodeIdPath: '1055398:1063252', avgUnits: 180 },
      };
      transport.concentrationItems = [
        { asin: 'B000TEST01', marketplace: null, nodeIdPath: null, month: null, totalUnitsRatio: 0.1 },
      ];
      const adapter = new SellerSpriteMCPAdapter({
        database,
        client: new SellerSpriteMcpClient({ transport,
          ledgerStore: new SqliteMcpCallLedgerStore(database),
          cacheStore: new SqliteMcpResponseCacheStore(database) }),
      });
      const context = { runId, requireObservationMonth: true };
      const input = { marketplace: 'US', nodeIdPath: '1055398:1063252' };

      const july = await adapter.fetchMarketStatistics({ ...input, month: '202607' }, context);
      const august = await adapter.fetchMarketStatistics({ ...input, month: '202608' }, context);
      const concentration = await adapter.fetchMarketConcentration({ ...input, month: '202608' }, context);

      expect([july.data.avgUnits, august.data.avgUnits]).toEqual([100, 180]);
      expect(concentration.data).toHaveLength(1);
      expect(transport.listToolsCallCount).toBe(1);
      expect(transport.calls).toHaveLength(3);
      const snapshot = database.prepare(`SELECT capabilities_json FROM provider_capability_snapshots
        WHERE sync_run_id = ?`).get(runId) as { capabilities_json: string };
      const hashes = (JSON.parse(snapshot.capabilities_json) as {
        capabilitySchemaHashes: Record<string, string>;
      }).capabilitySchemaHashes;
      const rows = database.prepare(`SELECT capability, status, cache_hit, observation_month,
        response_metadata_json FROM mcp_call_logs WHERE capability <> 'LIST_TOOLS'
        ORDER BY rowid`).all() as Array<Record<string, unknown>>;
      expect(rows.map(({ capability, status, cache_hit, observation_month, response_metadata_json }) => ({
        capability, status, cache_hit, observation_month,
        observationCertification: (JSON.parse(response_metadata_json as string) as Record<string, unknown>)
          .observationCertification,
      }))).toEqual([
        { capability: 'MARKET_STATISTICS', status: 'success', cache_hit: 0, observation_month: '202607',
          observationCertification: { method: 'documented_request_v1', schemaHash: hashes.MARKET_STATISTICS } },
        { capability: 'MARKET_STATISTICS', status: 'success', cache_hit: 0, observation_month: '202608',
          observationCertification: { method: 'documented_request_v1', schemaHash: hashes.MARKET_STATISTICS } },
        { capability: 'PRODUCT_CONCENTRATION', status: 'success', cache_hit: 0, observation_month: '202608',
          observationCertification: { method: 'documented_request_v1', schemaHash: hashes.PRODUCT_CONCENTRATION } },
      ]);
      expect(hashes.MARKET_STATISTICS).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(rows)).not.toMatch(/avgUnits|totalUnitsRatio|secret-key|"request"/i);
    } finally { database.close(); }
  });

  it('returns the unique exact market research summary and certifies the documented request', async () => {
    const database = openDatabase(':memory:');
    try {
      const runId = '123e4567-e89b-42d3-a456-426614174060';
      database.prepare(`INSERT INTO data_tasks (
        id, name, task_type, target, source, marketplace, status, created_at
      ) VALUES (?, 'Critical sync', 'critical_sync', 'market-1',
        'SellerSprite MCP', 'US', 'running', '2026-09-20T00:00:00.000Z')`).run(runId);
      const transport = new AdapterTransport();
      transport.marketToolsRequireMonth = true;
      transport.marketToolsSupportReturnFields = true;
      transport.marketItems = [
        {
          marketplace: 'US', nodeIdPath: '1055398:1063252:other', month: null,
          totalProducts: 9, totalUnits: 90, totalRevenue: 900,
          top10ProductCrn: 0.9, top20ProductCrn: 0.95,
        },
        {
          marketplace: 'US', nodeIdPath: '1055398:1063252', month: null,
          totalProducts: 100, totalUnits: 1_200, totalRevenue: 48_000,
          top10ProductCrn: 0.25, top20ProductCrn: 0.4,
        },
      ];
      const adapter = new SellerSpriteMCPAdapter({ database, client: new SellerSpriteMcpClient({
        transport, ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
      }) });

      const result = await adapter.fetchMarketResearchSummary({
        marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608',
      }, { runId, requireObservationMonth: true });

      expect(result).toMatchObject({
        data: {
          marketplace: 'US', nodeIdPath: '1055398:1063252',
          totalProducts: 100, totalUnits: 1_200, totalRevenue: 48_000,
          top10ProductCrn: 0.25, top20ProductCrn: 0.4,
        },
        provenance: { source: 'SellerSprite MCP', sourceType: 'mcp', period: 'monthly' },
      });
      expect(transport.calls).toEqual([{
        name: 'market_research',
        arguments: { request: {
          marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608',
          returnFields: 'marketplace,nodeIdPath,month,totalProducts,topProducts,totalUnits,totalRevenue,avgUnits,avgRevenue,avgPrice,avgRatings,avgRating,brands,sellers,top10ProductSales,top10ProductCrn,top20ProductSales,top20ProductCrn,newProductProportion',
        } },
      }]);
      const row = database.prepare(`SELECT capability, status, cache_hit, observation_month,
        response_metadata_json FROM mcp_call_logs WHERE capability = 'MARKET_RESEARCH'`).get() as {
          capability: string; status: string; cache_hit: number; observation_month: string;
          response_metadata_json: string;
        };
      expect({ ...row, response_metadata_json: undefined }).toEqual({
        capability: 'MARKET_RESEARCH', status: 'success', cache_hit: 0,
        observation_month: '202608', response_metadata_json: undefined,
      });
      expect(JSON.parse(row.response_metadata_json)).toMatchObject({
        observationCertification: {
          method: 'documented_request_v1', schemaHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
    } finally { database.close(); }
  });

  it.each([
    ['empty items', []],
    ['no exact scope', [{ marketplace: 'US', nodeIdPath: 'other', totalProducts: 1 }]],
    ['duplicate exact scope', [
      { marketplace: 'US', nodeIdPath: '1055398:1063252', totalProducts: 100 },
      { marketplace: 'us', nodeIdPath: '1055398:1063252', totalProducts: 101 },
    ]],
    ['explicit wrong month', [
      { marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202607', totalProducts: 100 },
    ]],
  ])('rejects market research summary with %s', async (_scenario, marketItems) => {
    const transport = new AdapterTransport();
    transport.marketToolsRequireMonth = true;
    transport.marketItems = marketItems;
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    await expect(adapter.fetchMarketResearchSummary({
      marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608',
    }, {
      runId: '123e4567-e89b-42d3-a456-426614174061', requireObservationMonth: true,
    })).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
  });

  it('does not log or cache a successful non-critical summary before unique scope validation', async () => {
    const database = openDatabase(':memory:');
    try {
      const transport = new AdapterTransport();
      transport.marketItems = [
        { marketplace: 'US', nodeIdPath: '1055398:1063252', totalProducts: 100 },
        { marketplace: 'US', nodeIdPath: '1055398:1063252', totalProducts: 101 },
      ];
      const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({
        transport, ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
      }) });

      await expect(adapter.fetchMarketResearchSummary({
        marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608',
      })).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });

      expect(database.prepare(`SELECT status, error_code AS errorCode FROM mcp_call_logs
        WHERE capability = 'MARKET_RESEARCH'`).get()).toEqual({
        status: 'failed', errorCode: 'INVALID_SCHEMA',
      });
      expect(database.prepare('SELECT COUNT(*) AS count FROM mcp_response_cache').get())
        .toEqual({ count: 0 });
    } finally { database.close(); }
  });

  it('requires a fresh run and a discovered string month for critical market research', async () => {
    const withoutFreshRun = new AdapterTransport();
    withoutFreshRun.marketToolsRequireMonth = true;
    withoutFreshRun.marketItems = [{
      marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608', totalProducts: 100,
    }];
    const noRunAdapter = new SellerSpriteMCPAdapter({
      client: new SellerSpriteMcpClient({ transport: withoutFreshRun }),
    });
    await expect(noRunAdapter.fetchMarketResearchSummary({
      marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608',
    }, { requireObservationMonth: true })).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
    expect(withoutFreshRun.calls).toHaveLength(0);

    const nonStringMonth = new AdapterTransport();
    nonStringMonth.marketToolsRequireMonth = true;
    nonStringMonth.marketMonthType = 'number';
    const wrongSchemaAdapter = new SellerSpriteMCPAdapter({
      client: new SellerSpriteMcpClient({ transport: nonStringMonth }),
    });
    await expect(wrongSchemaAdapter.fetchMarketResearchSummary({
      marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608',
    }, {
      runId: '123e4567-e89b-42d3-a456-426614174062', requireObservationMonth: true,
    })).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
    expect(nonStringMonth.calls).toHaveLength(0);
  });

  it('keeps market research aliases on response-echo certification', async () => {
    class ResearchAliasTransport extends AdapterTransport {
      override async listTools(): Promise<unknown> {
        const result = await super.listTools() as { tools: Array<{ name: string }> };
        result.tools = result.tools.map((entry) => entry.name === 'market_research'
          ? { ...entry, name: 'market_research_v2' } : entry);
        return result;
      }
    }
    const database = openDatabase(':memory:');
    try {
      const runId = '123e4567-e89b-42d3-a456-426614174063';
      database.prepare(`INSERT INTO data_tasks (
        id, name, task_type, target, source, marketplace, status, created_at
      ) VALUES (?, 'Critical sync', 'critical_sync', 'market-1',
        'SellerSprite MCP', 'US', 'running', '2026-09-20T00:00:00.000Z')`).run(runId);
      const transport = new ResearchAliasTransport();
      transport.marketToolsRequireMonth = true;
      transport.marketItems = [{
        marketplace: 'US', nodeIdPath: '1055398:1063252', totalProducts: 100,
      }];
      transport.responseData = { items: transport.marketItems };
      const adapter = new SellerSpriteMCPAdapter({ database, client: new SellerSpriteMcpClient({
        transport, ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
      }) });
      const input = { marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608' };
      const context = { runId, requireObservationMonth: true };

      await expect(adapter.fetchMarketResearchSummary(input, context))
        .rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
      transport.marketItems = [{ ...transport.marketItems[0], month: '202608' }];
      transport.responseData = { items: transport.marketItems };
      // An operator reviewed the corrected schema/response before resuming this capability.
      database.prepare("DELETE FROM mcp_schema_pauses WHERE capability='MARKET_RESEARCH'").run();
      await expect(adapter.fetchMarketResearchSummary(input, context))
        .resolves.toMatchObject({ data: { totalProducts: 100 } });

      const rows = database.prepare(`SELECT status, response_metadata_json FROM mcp_call_logs
        WHERE capability = 'MARKET_RESEARCH' ORDER BY rowid`).all() as Array<{
          status: string; response_metadata_json: string;
        }>;
      expect(rows.map(({ status, response_metadata_json }) => ({
        status,
        method: (JSON.parse(response_metadata_json) as {
          observationCertification?: { method: string };
        }).observationCertification?.method ?? null,
      }))).toEqual([
        { status: 'failed', method: null },
        { status: 'success', method: 'response_echo_v1' },
      ]);
    } finally { database.close(); }
  });

  it('requires a month argument and uses response echoes without a fresh run', async () => {
    const noMonthSchema = new AdapterTransport();
    const withoutSchema = new SellerSpriteMCPAdapter({
      client: new SellerSpriteMcpClient({ transport: noMonthSchema }),
    });
    await expect(withoutSchema.fetchMarketStatistics({
      marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608',
    }, { runId: '123e4567-e89b-42d3-a456-426614174000', requireObservationMonth: true }))
      .rejects.toMatchObject({ code: 'INVALID_SCHEMA' });

    const noFreshRun = new AdapterTransport();
    noFreshRun.marketToolsRequireMonth = true;
    const withoutFreshRun = new SellerSpriteMCPAdapter({
      client: new SellerSpriteMcpClient({ transport: noFreshRun }),
    });
    await expect(withoutFreshRun.fetchMarketStatistics({
      marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608',
    }, { requireObservationMonth: true }))
      .rejects.toMatchObject({ code: 'INVALID_SCHEMA' });

    noFreshRun.responseData = [
      { asin: 'B000TEST01', marketplace: 'US', nodeIdPath: '1055398:1063252' },
    ];
    await expect(withoutFreshRun.fetchMarketConcentration({
      marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608',
    }, { requireObservationMonth: true }))
      .rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
  });

  it('rejects a critical string month when the discovered schema declares another type', async () => {
    const transport = new AdapterTransport();
    transport.marketToolsRequireMonth = true;
    transport.marketMonthType = 'number';
    transport.responseData = {
      marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608', products: 100,
    };
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });
    const input = { marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608' };
    const context = { runId: '123e4567-e89b-42d3-a456-426614174051', requireObservationMonth: true };

    await expect(adapter.fetchMarketStatistics(input, context))
      .rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
    expect(transport.calls).toHaveLength(0);
  });

  it.each(['2026-08', '202613', 'nearly'])('rejects non-yyyyMM critical month %s before a provider call', async (month) => {
    const transport = new AdapterTransport();
    transport.marketToolsRequireMonth = true;
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    await expect(adapter.fetchMarketStatistics({ marketplace: 'US', nodeIdPath: '1055398:1063252', month }, {
      runId: '123e4567-e89b-42d3-a456-426614174052', requireObservationMonth: true,
    })).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
    expect(transport.calls).toHaveLength(0);
  });

  it('keeps aliases on response echo with complete scope and logs only successful certification', async () => {
    class AliasTransport extends AdapterTransport {
      override async listTools(): Promise<unknown> {
        const result = await super.listTools() as { tools: Array<{ name: string }> };
        result.tools = result.tools.map((entry) => ({ ...entry,
          name: entry.name === 'market_research_statistics' ? 'market_statistics'
            : entry.name === 'market_product_concentration' ? 'product_concentration' : entry.name,
        }));
        return result;
      }
    }
    const database = openDatabase(':memory:');
    try {
      const runId = '123e4567-e89b-42d3-a456-426614174053';
      database.prepare(`INSERT INTO data_tasks (
        id, name, task_type, target, source, marketplace, status, created_at
      ) VALUES (?, 'Critical sync', 'critical_sync', 'market-1',
        'SellerSprite MCP', 'US', 'running', '2026-09-20T00:00:00.000Z')`).run(runId);
      const transport = new AliasTransport();
      transport.marketToolsRequireMonth = true;
      const adapter = new SellerSpriteMCPAdapter({ database, client: new SellerSpriteMcpClient({
        transport, ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
      }) });
      const input = { marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608' };
      const context = { runId, requireObservationMonth: true };
      transport.responseData = { marketplace: input.marketplace, nodeIdPath: input.nodeIdPath, products: 100 };
      await expect(adapter.fetchMarketStatistics(input, context)).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
      transport.responseData = [{ asin: 'B000TEST01', totalUnitsRatio: 0.1 }];
      await expect(adapter.fetchMarketConcentration(input, context)).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
      expect(database.prepare('SELECT COUNT(*) AS total FROM mcp_response_cache').get()).toEqual({ total: 0 });

      transport.responseData = { ...input, products: 100 };
      database.prepare('DELETE FROM mcp_schema_pauses').run();
      await adapter.fetchMarketStatistics(input, context);
      transport.responseData = [{ ...input, asin: 'B000TEST01', totalUnitsRatio: 0.1 }];
      await adapter.fetchMarketConcentration(input, context);
      const rows = database.prepare(`SELECT status, error_code, response_metadata_json
        FROM mcp_call_logs WHERE capability <> 'LIST_TOOLS' ORDER BY rowid`).all() as Array<{
          status: string; error_code: string | null; response_metadata_json: string;
        }>;
      expect(rows.map(({ status, error_code, response_metadata_json }) => ({
        status, error_code,
        method: (JSON.parse(response_metadata_json) as { observationCertification?: { method: string } })
          .observationCertification?.method ?? null,
      }))).toEqual([
        { status: 'failed', error_code: 'INVALID_SCHEMA', method: null },
        { status: 'failed', error_code: 'INVALID_SCHEMA', method: null },
        { status: 'success', error_code: null, method: 'response_echo_v1' },
        { status: 'success', error_code: null, method: 'response_echo_v1' },
      ]);
      expect(database.prepare('SELECT COUNT(*) AS total FROM mcp_response_cache').get()).toEqual({ total: 2 });
    } finally { database.close(); }
  });

  it('revalidates a cached response echo and records the same schema certification', async () => {
    const database = openDatabase(':memory:');
    try {
      const transport = new AdapterTransport();
      transport.marketToolsRequireMonth = true;
      transport.responseData = {
        marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608', products: 100,
      };
      const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({
        transport, ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
      }) });
      const input = { marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608' };

      await adapter.fetchMarketStatistics(input, { requireObservationMonth: true });
      await adapter.fetchMarketStatistics(input, { requireObservationMonth: true });

      expect(transport.calls).toHaveLength(1);
      const rows = database.prepare(`SELECT cache_hit, response_metadata_json FROM mcp_call_logs
        WHERE capability = 'MARKET_STATISTICS' ORDER BY rowid`).all() as Array<{
          cache_hit: number; response_metadata_json: string;
        }>;
      const certifications = rows.map(({ cache_hit, response_metadata_json }) => ({
        cache_hit,
        certification: (JSON.parse(response_metadata_json) as {
          observationCertification: { method: string; schemaHash: string };
        }).observationCertification,
      }));
      expect(certifications).toEqual([
        { cache_hit: 0, certification: {
          method: 'response_echo_v1', schemaHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        } },
        { cache_hit: 1, certification: certifications[0].certification },
      ]);
    } finally { database.close(); }
  });

  it('does not certify rejected envelopes, invalid payloads, or empty documented concentration', async () => {
    const database = openDatabase(':memory:');
    try {
      const runId = '123e4567-e89b-42d3-a456-426614174054';
      database.prepare(`INSERT INTO data_tasks (
        id, name, task_type, target, source, marketplace, status, created_at
      ) VALUES (?, 'Critical sync', 'critical_sync', 'market-1',
        'SellerSprite MCP', 'US', 'running', '2026-09-20T00:00:00.000Z')`).run(runId);
      const transport = new AdapterTransport();
      transport.marketToolsRequireMonth = true;
      const adapter = new SellerSpriteMCPAdapter({ database, client: new SellerSpriteMcpClient({
        transport, ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
        retry: { maxAttempts: 1, baseDelayMs: 1 },
      }) });
      const input = { marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608' };
      const context = { runId, requireObservationMonth: true };
      transport.responsePayload = { code: 'DENIED', data: { ...input, products: 100 } };
      await expect(adapter.fetchMarketStatistics(input, context)).rejects.toMatchObject({ code: 'REMOTE_ERROR' });
      transport.responsePayload = { code: 'OK', data: { products: 100 } };
      await expect(adapter.fetchMarketStatistics(input, context)).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
      transport.responsePayload = undefined;
      transport.responseData = [];
      await expect(adapter.fetchMarketConcentration(input, context)).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
      expect(database.prepare('SELECT COUNT(*) AS total FROM mcp_response_cache').get()).toEqual({ total: 0 });
      const rows = database.prepare(`SELECT status, response_metadata_json FROM mcp_call_logs
        WHERE capability <> 'LIST_TOOLS' ORDER BY rowid`).all() as Array<{
          status: string; response_metadata_json: string;
        }>;
      expect(rows).toHaveLength(3);
      expect(rows.every(({ status, response_metadata_json }) => status === 'failed'
        && !Object.hasOwn(JSON.parse(response_metadata_json) as object, 'observationCertification'))).toBe(true);
    } finally { database.close(); }
  });

  it.each([
    ['an empty row', [{}]],
    ['a row without ASIN', [{ totalUnitsRatio: 0.1 }]],
    ['an invalid ASIN', [{ asin: 'not-an-asin', totalUnitsRatio: 0.1 }]],
    ['a row without a concentration metric', [{ asin: 'B000TEST01' }]],
    ['a row with only negative metrics', [{ asin: 'B000TEST01', totalUnits: -1, totalUnitsRatio: -0.1 }]],
    ['a row with only non-finite metrics', [{ asin: 'B000TEST01', totalRevenue: Number.NaN }]],
    ['a row with only a price', [{ asin: 'B000TEST01', price: 39 }]],
    ['a row with only ratings', [{ asin: 'B000TEST01', ratings: 100 }]],
  ])('does not certify documented concentration containing %s', async (_scenario, responseData) => {
    const database = openDatabase(':memory:');
    try {
      const runId = '123e4567-e89b-42d3-a456-426614174064';
      database.prepare(`INSERT INTO data_tasks (
        id, name, task_type, target, source, marketplace, status, created_at
      ) VALUES (?, 'Critical sync', 'critical_sync', 'market-1',
        'SellerSprite MCP', 'US', 'running', '2026-09-20T00:00:00.000Z')`).run(runId);
      const transport = new AdapterTransport();
      transport.marketToolsRequireMonth = true;
      transport.responseData = responseData;
      const adapter = new SellerSpriteMCPAdapter({ database, client: new SellerSpriteMcpClient({
        transport, ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
      }) });

      await expect(adapter.fetchMarketConcentration({
        marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608',
      }, { runId, requireObservationMonth: true })).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });

      expect(database.prepare('SELECT COUNT(*) AS total FROM mcp_response_cache').get()).toEqual({ total: 0 });
      const row = database.prepare(`SELECT status, response_metadata_json FROM mcp_call_logs
        WHERE capability = 'PRODUCT_CONCENTRATION'`).get() as {
          status: string; response_metadata_json: string;
        };
      expect(row.status).toBe('failed');
      expect(JSON.parse(row.response_metadata_json)).not.toHaveProperty('observationCertification');
    } finally { database.close(); }
  });

  it.each([
    ['empty marketplace', { marketplace: '', nodeIdPath: '1055398:1063252', month: '202608' }],
    ['wrong marketplace', { marketplace: 'CA', nodeIdPath: '1055398:1063252', month: '202608' }],
    ['empty nodeIdPath', { marketplace: 'US', nodeIdPath: '', month: '202608' }],
    ['wrong nodeIdPath', { marketplace: 'US', nodeIdPath: 'wrong', month: '202608' }],
    ['wrong month', { marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202607' }],
    ['empty month', { marketplace: 'US', nodeIdPath: '1055398:1063252', month: '' }],
  ])('rejects documented concentration items with explicit %s', async (_scenario, scope) => {
    const transport = new AdapterTransport();
    transport.marketToolsRequireMonth = true;
    transport.responseData = [{ asin: 'B000TEST01', totalUnitsRatio: 0.1, ...scope }];
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    await expect(adapter.fetchMarketConcentration({
      marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608',
    }, { runId: '123e4567-e89b-42d3-a456-426614174000', requireObservationMonth: true }))
      .rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
  });
  it.each([
    ['identity', { asin: { asin: 'B000TEST02', marketplace: 'US' }, salesTrendPoints: [{ month: '2026-07', childUnitSales: 10 }] }],
    ['history', { asin: { asin: 'B000TEST01', marketplace: 'US' }, salesTrendPoints: [{ asin: 'B000TEST02', month: '2026-07', childUnitSales: 10 }] }],
    ['marketplace', { asin: { asin: 'B000TEST01', marketplace: 'CA' }, salesTrendPoints: [{ month: '2026-07', childUnitSales: 10 }] }],
    ['top-level marketplace', { marketplace: 'CA', asin: { asin: 'B000TEST01', marketplace: 'US' }, salesTrendPoints: [{ month: '2026-07', childUnitSales: 10 }] }],
  ])('rejects mismatched ASIN %s before certifying or caching the response', async (_field, invalid) => {
    const database = openDatabase(':memory:');
    try {
      const transport = new AdapterTransport();
      transport.responseData = invalid;
      const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({
        transport, ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
      }) });
      const input = { marketplace: 'US', asin: 'B000TEST01' };

      await expect(adapter.fetchAsinSalesTrend(input)).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
      expect(database.prepare("SELECT status, error_code FROM mcp_call_logs WHERE capability <> 'LIST_TOOLS'").all()).toEqual([
        { status: 'failed', error_code: 'INVALID_SCHEMA' },
      ]);
      expect(database.prepare('SELECT COUNT(*) AS total FROM mcp_response_cache').get()).toEqual({ total: 0 });

      transport.responseData = undefined;
      await expect(adapter.fetchAsinSalesTrend(input)).resolves.toMatchObject({ data: { asin: { asin: input.asin } } });
      expect(transport.calls).toHaveLength(2);
    } finally { database.close(); }
  });
  it.each([
    ['ASIN', { asin: { marketplace: 'US' }, salesTrendPoints: [{ month: '2026-07', childUnitSales: 10 }] }],
    ['marketplace', { asin: { asin: 'B000TEST01' }, salesTrendPoints: [{ month: '2026-07', childUnitSales: 10 }] }],
  ])('rejects ASIN trends without documented %s identity scope', async (_field, responseData) => {
    const transport = new AdapterTransport();
    transport.responseData = responseData;
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    await expect(adapter.fetchAsinSalesTrend({ marketplace: 'US', asin: 'B000TEST01' }))
      .rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
  });

  it.each([
    ['marketplace', { asin: 'B000TEST02', title: 'Test', nodeIdPath: '1055398:1063252', month: '2026-08' }],
    ['nodeIdPath', { asin: 'B000TEST02', title: 'Test', marketplace: 'US', month: '2026-08' }],
  ])('rejects market research items without documented %s scope', async (_field, item) => {
    const transport = new AdapterTransport();
    transport.marketItems = [item];
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    await expect(adapter.fetchMarketProducts({
      marketplace: 'US', marketId: '1055398:1063252', keywords: ['pillow'],
    })).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
  });
  it.each([
    ['concentration', [{ asin: 'B000TEST01', marketplace: 'CA' }]],
    ['research', { items: [{ asin: 'B000TEST02', title: 'Test', nodeIdPath: 'wrong' }] }],
    ['competitors', [{ asin: 'B000TEST02', marketplace: 'CA' }]],
  ])('does not certify wrong-scope %s items', async (kind, invalid) => {
    const database = openDatabase(':memory:');
    try {
      const transport = new AdapterTransport();
      transport.responseData = invalid;
      const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({
        transport, ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
      }) });

      const request = kind === 'concentration'
        ? adapter.fetchMarketConcentration({ marketplace: 'US', nodeIdPath: '1055398:1063252' })
        : kind === 'research'
          ? adapter.fetchMarketProducts({ marketplace: 'US', marketId: '1055398:1063252', keywords: ['pillow'] })
          : adapter.discoverAsinCompetitors({ marketplace: 'US', asin: 'B000TEST01' });
      await expect(request).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
      expect(database.prepare("SELECT status, error_code FROM mcp_call_logs WHERE capability <> 'LIST_TOOLS'").all()).toEqual([
        { status: 'failed', error_code: 'INVALID_SCHEMA' },
      ]);
      expect(database.prepare('SELECT COUNT(*) AS total FROM mcp_response_cache').get()).toEqual({ total: 0 });
    } finally { database.close(); }
  });
  it('revalidates previously cached wrong-scope data before recording a cache-hit success', async () => {
    const database = openDatabase(':memory:');
    try {
      const transport = new AdapterTransport();
      transport.responseData = { products: 100, marketplace: 'CA' };
      const client = new SellerSpriteMcpClient({ transport,
        ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
      });
      const input = { marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608' };
      await client.callTool({
        tool: 'market_research_statistics', arguments: { request: input },
        context: { capability: 'MARKET_STATISTICS' },
      });
      transport.responseData = { products: 100, marketplace: 'US', nodeIdPath: input.nodeIdPath, month: input.month };

      const result = await new SellerSpriteMCPAdapter({ client }).fetchMarketStatistics(input);

      expect(result.data.marketplace).toBe('US');
      expect(transport.calls).toHaveLength(2);
      expect(database.prepare(`SELECT status, cache_hit FROM mcp_call_logs
        WHERE capability <> 'LIST_TOOLS' ORDER BY rowid`).all()).toEqual([
        { status: 'success', cache_hit: 0 },
        { status: 'success', cache_hit: 0 },
      ]);
    } finally { database.close(); }
  });
  it('marks a malformed SellerSprite envelope as a schema failure without retrying', async () => {
    const database = openDatabase(':memory:');
    try {
      const transport = new AdapterTransport();
      transport.responsePayload = { data: { asin: {}, salesTrendPoints: [] } };
      const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({
        transport, ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
      }) });

      await expect(adapter.fetchAsinSalesTrend({ marketplace: 'US', asin: 'B000TEST01' }))
        .rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
      expect(database.prepare("SELECT status, error_code FROM mcp_call_logs WHERE capability <> 'LIST_TOOLS'").all()).toEqual([
        { status: 'failed', error_code: 'INVALID_SCHEMA' },
      ]);
      expect(database.prepare('SELECT COUNT(*) AS total FROM mcp_response_cache').get()).toEqual({ total: 0 });
      expect(transport.calls).toHaveLength(1);
    } finally { database.close(); }
  });
  it('bypasses a previously cached malformed capability result', async () => {
    const database = openDatabase(':memory:');
    try {
      const transport = new AdapterTransport();
      transport.responseData = { asin: { asin: 'B000TEST01' }, salesTrendPoints: 'not-an-array' };
      const client = new SellerSpriteMcpClient({ transport,
        ledgerStore: new SqliteMcpCallLedgerStore(database),
        cacheStore: new SqliteMcpResponseCacheStore(database),
      });
      await client.callTool({
        tool: 'asin_sales_trend', arguments: { marketplace: 'US', asin: 'B000TEST01' },
        context: { capability: 'ASIN_SALES_TREND' },
      });
      transport.responseData = undefined;

      const result = await new SellerSpriteMCPAdapter({ client })
        .fetchAsinSalesTrend({ marketplace: 'US', asin: 'B000TEST01' });

      expect(result.data.salesTrendPoints).toHaveLength(1);
      expect(transport.calls).toHaveLength(2);
      expect(database.prepare(`SELECT status, cache_hit FROM mcp_call_logs
        WHERE capability <> 'LIST_TOOLS' ORDER BY rowid`).all()).toEqual([
        { status: 'success', cache_hit: 0 },
        { status: 'success', cache_hit: 0 },
      ]);
    } finally { database.close(); }
  });
  it('reports sanitized connection and required-capability diagnostics', async () => {
    const transport = new AdapterTransport();
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const result = await adapter.testConnection();

    expect(result).toMatchObject({
      connected: true,
      authenticated: true,
      toolCount: 5,
      requiredCapabilityCount: 5,
      availableRequiredCapabilityCount: 5,
      missingCapabilities: [],
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result)).not.toMatch(/secret|token|https?:\/\//i);
  });

  it('re-discovers tools remotely before certifying a connection capability snapshot', async () => {
    const transport = new AdapterTransport();
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });
    await adapter.fetchAsinSalesTrend({ marketplace: 'US', asin: 'B000TEST01' });
    transport.omitCompetitorTool = true;

    const result = await adapter.testConnection();

    expect(transport.listToolsCallCount).toBe(2);
    expect(result).toMatchObject({
      toolCount: 4,
      availableRequiredCapabilityCount: 4,
      missingCapabilities: ['ASIN_COMPETITOR_DISCOVERY'],
    });
  });

  it('keeps the original remote acquisition time when returning a cached response', async () => {
    const database = openDatabase(':memory:');
    try {
      let now = Date.parse('2026-09-20T00:00:00.000Z');
      const transport = new AdapterTransport();
      const client = new SellerSpriteMcpClient({
        transport,
        cacheStore: new SqliteMcpResponseCacheStore(database),
        now: () => now,
      });
      const adapter = new SellerSpriteMCPAdapter({ client });
      const request = { marketplace: 'US', nodeIdPath: '1055398:1063252', month: '202608' };

      const first = await adapter.fetchMarketStatistics(request);
      now += 60_000;
      const second = await adapter.fetchMarketStatistics(request);

      expect(first.provenance.collectedAt).toBe('2026-09-20T00:00:00.000Z');
      expect(second.provenance.collectedAt).toBe(first.provenance.collectedAt);
      expect(transport.calls).toHaveLength(1);
    } finally { database.close(); }
  });

  it('uses discovered nested market tool arguments and retains absent statistics as absent', async () => {
    const transport = new AdapterTransport();
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const result = await adapter.fetchMarketStatistics({
      marketplace: 'US', nodeIdPath: 'Home/Bed Pillows', month: '2026-08',
    });

    expect(transport.calls[0]).toEqual({
      name: 'market_research_statistics',
      arguments: { request: { marketplace: 'US', nodeIdPath: 'Home/Bed Pillows', month: '2026-08' } },
    });
    expect(result.data).toMatchObject({ products: 100, brands: 71, avgPrice: 44.83 });
    expect(result.data).not.toHaveProperty('totalUnits');
    expect(result.provenance).toMatchObject({ sourceType: 'mcp', isEstimated: true });
  });

  it('sends flat market arguments when the discovered tool schema requires flat fields', async () => {
    const transport = new AdapterTransport();
    transport.flatMarketTools = true;
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    await adapter.fetchMarketStatistics({
      marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608',
    });
    await adapter.fetchMarketConcentration({
      marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608',
    });
    await adapter.fetchMarketProducts({
      marketplace: 'US', marketId: 'bed-pillows', keywords: ['pillow'],
    });

    expect(transport.calls.map(({ arguments: args }) => args)).toEqual([
      { marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608' },
      { marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608' },
      { marketplace: 'US', nodeIdPath: 'bed-pillows', departmentKeyword: 'pillow' },
    ]);
  });

  it.each([
    ['nested request', false, {
      request: {
        marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608',
        returnFields: 'marketplace,nodeIdPath,month,totalProducts,products,sellers,brands,totalUnits,totalRevenue,avgPrice,medianPrice,avgRating,medianReviews,top10Share,top20Share,newProductShare,newProductProportion',
      },
    }],
    ['flat schema', true, {
      marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608',
      returnFields: 'marketplace,nodeIdPath,month,totalProducts,products,sellers,brands,totalUnits,totalRevenue,avgPrice,medianPrice,avgRating,medianReviews,top10Share,top20Share,newProductShare,newProductProportion',
    }],
  ])('projects only synchronized statistics fields for a %s supporting returnFields', async (_shape, flatMarketTools, expected) => {
    const transport = new AdapterTransport();
    transport.flatMarketTools = flatMarketTools;
    transport.marketToolsSupportReturnFields = true;
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    await adapter.fetchMarketStatistics({
      marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608',
    });

    expect(transport.calls).toEqual([{
      name: 'market_research_statistics', arguments: expected,
    }]);
  });

  it.each([
    ['nested request', false, {
      request: {
        marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608',
        returnFields: 'marketplace,nodeIdPath,month,asin,title,brand,price,rating,ratings,reviews,totalUnits,totalRevenue,totalUnitsRatio,totalRevenueRatio',
      },
    }],
    ['flat schema', true, {
      marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608',
      returnFields: 'marketplace,nodeIdPath,month,asin,title,brand,price,rating,ratings,reviews,totalUnits,totalRevenue,totalUnitsRatio,totalRevenueRatio',
    }],
  ])('projects only synchronized concentration fields for a %s supporting returnFields', async (_shape, flatMarketTools, expected) => {
    const transport = new AdapterTransport();
    transport.flatMarketTools = flatMarketTools;
    transport.marketToolsSupportReturnFields = true;
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    await adapter.fetchMarketConcentration({
      marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608',
    });

    expect(transport.calls).toEqual([{
      name: 'market_product_concentration', arguments: expected,
    }]);
  });

  it.each([
    ['nested statistics', false, 'market_research_statistics'],
    ['flat statistics', true, 'market_research_statistics'],
    ['nested concentration', false, 'market_product_concentration'],
    ['flat concentration', true, 'market_product_concentration'],
  ])('does not send returnFields to a %s tool declaring a non-string schema', async (
    _shape, flatMarketTools, toolName,
  ) => {
    const transport = new AdapterTransport();
    transport.flatMarketTools = flatMarketTools;
    transport.marketToolsSupportReturnFields = true;
    transport.marketReturnFieldsType = 'array';
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });
    const input = { marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608' };

    if (toolName === 'market_research_statistics') await adapter.fetchMarketStatistics(input);
    else await adapter.fetchMarketConcentration(input);

    expect(transport.calls).toEqual([{
      name: toolName,
      arguments: flatMarketTools
        ? { marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608' }
        : { request: { marketplace: 'US', nodeIdPath: 'bed-pillows', month: '202608' } },
    }]);
  });

  it('routes concentration, monthly ASIN trend, and competitor candidates through their discovered tools', async () => {
    const transport = new AdapterTransport();
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const concentration = await adapter.fetchMarketConcentration({ marketplace: 'US', nodeIdPath: 'Home/Bed Pillows' });
    const trend = await adapter.fetchAsinSalesTrend({ marketplace: 'US', asin: 'B000TEST01' });
    const candidates = await adapter.discoverAsinCompetitors({ marketplace: 'US', asin: 'B000TEST01', size: 10 });

    expect(concentration.data).toHaveLength(2);
    expect(trend.data.salesTrendPoints).toEqual([
      { month: '2026-07', childUnitSales: 200, childSalesRevenue: 8_000 },
    ]);
    expect(candidates.data[0]).toMatchObject({ asin: 'B000TEST02' });
    expect(transport.calls.map((call) => call.name)).toEqual([
      'market_product_concentration', 'asin_sales_trend', 'asin_competitor',
    ]);
    expect(transport.calls.at(-1)?.arguments).toEqual({ marketplace: 'US', asin: 'B000TEST01', size: 10 });
  });

  it('fetches only the requested ASIN identity fields and preserves nullable fields', async () => {
    const transport = new AdapterTransport();
    transport.includeAsinDetail = true;
    transport.asinDetail = {
      asin: 'B000TEST01', marketplace: 'US', title: null, brand: null,
      parent: null, nodeIdPath: null,
    };
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const identity = await adapter.fetchAsinIdentity({ marketplace: 'US', asin: 'B000TEST01' });

    expect(identity.data).toEqual({
      asin: 'B000TEST01', marketplace: 'US', title: null, brand: null,
      parent: null, nodeIdPath: null,
    });
    expect(transport.calls).toEqual([{
      name: 'asin_detail',
      arguments: {
        marketplace: 'US', asin: 'B000TEST01',
        returnFields: 'asin,title,brand,parent,nodeIdPath,marketplace',
      },
    }]);
  });

  it.each([
    ['absent', undefined],
    ['non-string', 'array'],
  ])('calls exact asin_detail without projection when returnFields is %s', async (
    _scenario, returnFieldsType,
  ) => {
    const transport = new AdapterTransport();
    transport.includeAsinDetail = true;
    transport.asinDetailReturnFieldsType = returnFieldsType;
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const identity = await adapter.fetchAsinIdentity({ marketplace: 'US', asin: 'B000TEST01' });

    expect(identity.data.title).toBe('Detailed product');
    expect(transport.calls).toEqual([{
      name: 'asin_detail', arguments: { marketplace: 'US', asin: 'B000TEST01' },
    }]);
  });

  it.each([
    ['ASIN', { asin: 'B000TEST02', marketplace: 'US' }],
    ['marketplace', { asin: 'B000TEST01', marketplace: 'CA' }],
  ])('rejects asin_detail responses with mismatched %s scope', async (_scope, asinDetail) => {
    const transport = new AdapterTransport();
    transport.includeAsinDetail = true;
    transport.asinDetail = asinDetail;
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    await expect(adapter.fetchAsinIdentity({ marketplace: 'US', asin: 'B000TEST01' }))
      .rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
  });

  it('records asin_detail with sanitized product ledger context', async () => {
    const database = openDatabase(':memory:');
    try {
      const transport = new AdapterTransport();
      transport.includeAsinDetail = true;
      const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({
        transport, ledgerStore: new SqliteMcpCallLedgerStore(database),
      }) });

      await adapter.fetchAsinIdentity({ marketplace: 'US', asin: 'B000TEST01' });

      expect(database.prepare(`SELECT capability, entity_type, entity_id, response_metadata_json
        FROM mcp_call_logs WHERE capability <> 'LIST_TOOLS'`).get()).toEqual({
        capability: 'ASIN_DETAIL', entity_type: 'product', entity_id: 'B000TEST01',
        response_metadata_json: JSON.stringify({ operation: 'product_detail', attempt: 1 }),
      });
    } finally { database.close(); }
  });

  it('keeps asin_detail run context in fresh discovery snapshots and call ledger only', async () => {
    const database = openDatabase(':memory:');
    try {
      const runId = '123e4567-e89b-42d3-a456-426614174009';
      database.prepare(`INSERT INTO data_tasks (
        id, name, task_type, target, source, marketplace, status, created_at
      ) VALUES (?, 'Identity sync', 'owned_sku_refresh', 'B000TEST01',
        'SellerSprite MCP', 'US', 'running', '2026-09-21T00:00:00.000Z')`).run(runId);
      const transport = new AdapterTransport();
      transport.includeAsinDetail = true;
      const client = new SellerSpriteMcpClient({
        transport, ledgerStore: new SqliteMcpCallLedgerStore(database),
      });
      const adapter = new SellerSpriteMCPAdapter({ client, database });

      await adapter.fetchAsinIdentity(
        { marketplace: 'US', asin: 'B000TEST01' }, { runId },
      );

      expect(transport.listToolsCallCount).toBe(1);
      expect(transport.calls).toEqual([{
        name: 'asin_detail', arguments: {
          marketplace: 'US', asin: 'B000TEST01',
          returnFields: 'asin,title,brand,parent,nodeIdPath,marketplace',
        },
      }]);
      expect(database.prepare(`SELECT sync_run_id AS runId
        FROM provider_capability_snapshots`).all()).toEqual([{ runId }]);
      expect(database.prepare(`SELECT capability, sync_run_id AS runId
        FROM mcp_call_logs ORDER BY rowid`).all()).toEqual([
        { capability: 'LIST_TOOLS', runId },
        { capability: 'ASIN_DETAIL', runId },
      ]);
    } finally { database.close(); }
  });

  it('uses optional asin_detail identity while requiring trend data for the snapshot', async () => {
    const transport = new AdapterTransport();
    transport.includeAsinDetail = true;
    transport.asinDetail = {
      asin: 'B000TEST01', marketplace: 'US', title: 'Detailed title', brand: 'Detailed brand',
      parent: 'B000PARENT', nodeIdPath: 'Home/Bed Pillows',
    };
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const detail = await adapter.fetchProductDetail({ marketplace: 'US', asin: 'B000TEST01' });

    expect(detail).toMatchObject({
      asin: 'B000TEST01', title: 'Detailed title', brand: 'Detailed brand',
      marketNodeId: 'Home/Bed Pillows', latest: { estimatedSales: 200 },
    });
    expect(transport.calls.map((call) => call.name)).toEqual(['asin_sales_trend', 'asin_detail']);

    transport.salesTrendPoints = [];
    const freshAdapter = new SellerSpriteMCPAdapter({
      client: new SellerSpriteMcpClient({ transport, cacheTtlMs: 0 }),
    });
    await expect(freshAdapter.fetchProductDetail({ marketplace: 'US', asin: 'B000TEST01' }))
      .rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
  });

  it('keeps previous snapshots out of strict SellerSprite product arguments', async () => {
    class StrictProductTransport extends AdapterTransport {
      override async listTools(): Promise<unknown> {
        const result = await super.listTools() as {
          tools: Array<{ name: string; inputSchema: { additionalProperties?: boolean } }>;
        };
        result.tools = result.tools.map((entry) => (
          entry.name === 'asin_sales_trend' || entry.name === 'asin_detail'
            ? { ...entry, inputSchema: { ...entry.inputSchema, additionalProperties: false } }
            : entry
        ));
        return result;
      }
    }
    const transport = new StrictProductTransport();
    transport.includeAsinDetail = true;
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    await expect(adapter.fetchProductDetail({
      marketplace: 'US',
      asin: 'B000TEST01',
      previousSnapshot: {
        id: 'private-snapshot-id', snapshotAvailable: true, productId: 'US:B000TEST01',
        date: '2026-06-30', price: 49, rating: 4.5, reviewCount: 300, bsr: 10,
        estimatedSales: 200, estimatedRevenue: 9_800, sellerCount: 2,
        growth7d: null, growth30d: null, growth30dAvailable: false, growth90d: null,
        provenance: {
          source: 'internal-private-source', sourceType: 'mcp', collectedAt: '2026-06-30T00:00:00Z',
          period: 'monthly', isEstimated: true, confidence: 0.75,
        },
      },
    })).resolves.toMatchObject({ asin: 'B000TEST01' });
    expect(transport.calls).toEqual([
      { name: 'asin_sales_trend', arguments: { marketplace: 'US', asin: 'B000TEST01' } },
      { name: 'asin_detail', arguments: {
        marketplace: 'US', asin: 'B000TEST01',
        returnFields: 'asin,title,brand,parent,nodeIdPath,marketplace',
      } },
    ]);
    expect(JSON.stringify(transport.calls)).not.toMatch(/private-snapshot|internal-private-source/);
  });

  it('falls back field by field to trend identity when optional detail fields are null', async () => {
    const transport = new AdapterTransport();
    transport.includeAsinDetail = true;
    transport.asinDetail = {
      asin: 'B000TEST01', marketplace: 'US', title: null, brand: 'Detailed brand',
      parent: null, nodeIdPath: null,
    };
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const detail = await adapter.fetchProductDetail({ marketplace: 'US', asin: 'B000TEST01' });

    expect(detail).toMatchObject({
      title: 'Test product', brand: 'Detailed brand', marketNodeId: '',
    });
  });

  it('keeps product detail available when optional asin_detail is absent', async () => {
    const transport = new AdapterTransport();
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const detail = await adapter.fetchProductDetail({ marketplace: 'US', asin: 'B000TEST01' });

    expect(detail.title).toBe('Test product');
    expect(transport.calls.map((call) => call.name)).toEqual(['asin_sales_trend']);
  });

  it('keeps diagnostics at five required capabilities when optional asin_detail is available', async () => {
    const transport = new AdapterTransport();
    transport.includeAsinDetail = true;
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const diagnostics = await adapter.testConnection();

    expect(diagnostics).toMatchObject({
      toolCount: 6, requiredCapabilityCount: 5,
      availableRequiredCapabilityCount: 5, missingCapabilities: [],
    });
  });

  it('rejects failed SellerSprite envelopes and missing legacy overview metrics without fabricating data', async () => {
    const transport = new AdapterTransport();
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });
    await expect(adapter.fetchMarketOverview({ marketplace: 'US', keywords: ['pillow'], marketId: 'Home/Bed Pillows' }))
      .rejects.toThrow(/missing|缺失/i);

    transport.remoteCode = 'DENIED';
    await expect(adapter.fetchAsinSalesTrend({ marketplace: 'US', asin: 'B000TEST01' }))
      .rejects.toThrow(/rejected|失败/i);
  });

  it.each([
    ['uses a finite newProductProportion alias', { newProductProportion: 12.5 }, 12.5],
    ['rejects a string newProductProportion alias', { newProductProportion: '12.5' }, null],
    ['rejects a non-finite newProductShare', { newProductShare: Infinity }, null],
  ])('%s in legacy market overview data', async (_scenario, newProductMetric, expectedShare) => {
    const transport = new AdapterTransport();
    transport.marketStatisticsByMonth = {
      undefined: {
        marketplace: 'US', nodeIdPath: 'Home/Bed Pillows',
        products: 100, sellers: 69, brands: 71, totalUnits: 8_000, totalRevenue: 320_000,
        avgPrice: 40, medianPrice: 38, avgRating: 4.3, medianReviews: 100, ...newProductMetric,
      },
    };
    transport.concentrationItems = Array.from({ length: 20 }, (_, index) => ({
      asin: `B000TEST${String(index).padStart(2, '0')}`, totalUnitsRatio: 0.01,
    }));
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const overview = adapter.fetchMarketOverview({
      marketplace: 'US', keywords: ['pillow'], marketId: 'Home/Bed Pillows',
    });

    if (expectedShare === null) {
      await expect(overview).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
    } else {
      await expect(overview).resolves.toMatchObject({ newProductShare: expectedShare });
    }
  });

  it.each([
    ['uses a finite alias after a non-finite canonical value', Infinity, 12.5, 12.5],
    ['rejects when canonical and alias values are both non-finite', Number.NaN, Infinity, null],
  ])('%s', async (_scenario, newProductShare, newProductProportion, expectedShare) => {
    const transport = new AdapterTransport();
    transport.structuredPayloadByTool.market_research_statistics = {
      code: 'OK',
      data: {
        marketplace: 'US', nodeIdPath: 'Home/Bed Pillows',
        products: 100, sellers: 69, brands: 71, totalUnits: 8_000, totalRevenue: 320_000,
        avgPrice: 40, medianPrice: 38, avgRating: 4.3, medianReviews: 100,
        newProductShare, newProductProportion,
      },
    };
    transport.concentrationItems = Array.from({ length: 20 }, (_, index) => ({
      asin: `B000TEST${String(index).padStart(2, '0')}`, totalUnitsRatio: 0.01,
    }));
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const overview = adapter.fetchMarketOverview({
      marketplace: 'US', keywords: ['pillow'], marketId: 'Home/Bed Pillows',
    });

    if (expectedShare === null) {
      await expect(overview).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
    } else {
      await expect(overview).resolves.toMatchObject({ newProductShare: expectedShare });
    }
  });

  it('fails closed with a configuration error when no server endpoint exists', async () => {
    const previous = process.env.SELLERSPRITE_MCP_URL;
    delete process.env.SELLERSPRITE_MCP_URL;
    try {
      const adapter = new SellerSpriteMCPAdapter();
      await expect(adapter.fetchProductDetail({ marketplace: 'US', asin: 'B000TEST01' }))
        .rejects.toThrow(/SELLERSPRITE_MCP_URL/);
    } finally {
      if (previous === undefined) delete process.env.SELLERSPRITE_MCP_URL;
      else process.env.SELLERSPRITE_MCP_URL = previous;
    }
  });

  it('normalizes monthly trend dates to month-end and rejects products without an observation date', async () => {
    const transport = new AdapterTransport();
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const detail = await adapter.fetchProductDetail({ marketplace: 'US', asin: 'B000TEST01' });
    expect(detail.latest.date).toBe('2026-07-31');

    transport.marketItems = [{
      asin: 'B000TEST02', title: 'Undated product', marketplace: 'US',
      nodeIdPath: 'Home/Bed Pillows',
    }];
    await expect(adapter.fetchMarketProducts({ marketplace: 'US', keywords: ['pillow'], marketId: 'Home/Bed Pillows' }))
      .rejects.toThrow(/observation|date/i);
  });

  it('keeps day-specific history and does not borrow current ASIN attributes for an old observation', async () => {
    const transport = new AdapterTransport();
    transport.salesTrendPoints = [{ month: '2026-08-05', childUnitSales: 10 }];
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });

    const detail = await adapter.fetchProductDetail({ marketplace: 'US', asin: 'B000TEST01' });

    expect(detail.latest).toMatchObject({
      date: '2026-08-05', estimatedSales: 10, price: null, rating: null,
      reviewCount: null, bsr: null, sellerCount: null,
    });
  });

  it('rejects impossible day-specific observations instead of silently normalizing them', async () => {
    const transport = new AdapterTransport();
    transport.salesTrendPoints = [{ month: '2026-02-31', childUnitSales: 10 }];
    const adapter = new SellerSpriteMCPAdapter({ client: new SellerSpriteMcpClient({ transport }) });
    await expect(adapter.fetchProductDetail({ marketplace: 'US', asin: 'B000TEST01' }))
      .rejects.toThrow(/date/i);
  });
});

class AdapterTransport implements SellerSpriteMcpTransport {
  readonly calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  remoteCode = 'OK';
  responseData: unknown;
  responsePayload: unknown;
  structuredPayloadByTool: Record<string, Record<string, unknown>> = {};
  marketItems: Array<Record<string, unknown>> = [];
  marketStatisticsByMonth: Record<string, Record<string, unknown>> | undefined;
  marketResearchByMonth: Record<string, Record<string, unknown>> | undefined;
  concentrationItems: Array<Record<string, unknown>> = [
    {
      asin: 'B000TEST01', price: 39, ratings: 90, totalUnits: 300, totalRevenue: 11_700,
      totalUnitsRatio: 0.1, totalRevenueRatio: 0.12,
    },
    {
      asin: 'B000TEST02', price: 43, ratings: 110, totalUnits: 240, totalRevenue: 10_320,
      totalUnitsRatio: 0.08, totalRevenueRatio: 0.09,
    },
  ];
  flatMarketTools = false;
  marketToolsRequireMonth = false;
  marketMonthType = 'string';
  marketToolsSupportReturnFields = false;
  marketReturnFieldsType = 'string';
  echoConcentrationMonth = false;
  omitCompetitorTool = false;
  includeAsinDetail = false;
  asinDetailReturnFieldsType: string | undefined = 'string';
  asinDetail: Record<string, unknown> = {
    asin: 'B000TEST01', marketplace: 'US', title: 'Detailed product',
    brand: 'Detailed brand', parent: null, nodeIdPath: 'Home/Bed Pillows',
  };
  listToolsCallCount = 0;
  salesTrendPoints: Array<Record<string, unknown>> = [
    { month: '2026-07', childUnitSales: 200, childSalesRevenue: 8_000 },
  ];

  async connect(): Promise<void> {}
  async ping(): Promise<unknown> { return { _meta: { progressToken: 'test' } }; }
  async close(): Promise<void> {}

  async listTools(): Promise<unknown> {
    this.listToolsCallCount += 1;
    const marketTool = this.flatMarketTools
      ? (name: string, required: string[]) => {
          const result = tool(name, required);
          if (this.marketToolsSupportReturnFields) {
            result.inputSchema.properties.returnFields = { type: this.marketReturnFieldsType };
          }
          if (this.marketToolsRequireMonth) {
            result.inputSchema.properties.month = { type: this.marketMonthType };
          }
          return result;
        }
      : (name: string) => tool(name, ['request'], {
          marketplace: {}, nodeIdPath: {}, ...(this.marketToolsRequireMonth
            ? { month: { type: this.marketMonthType } } : {}),
          ...(this.marketToolsSupportReturnFields
            ? { returnFields: { type: this.marketReturnFieldsType } } : {}),
        });
    const asinDetailTool = tool('asin_detail', ['marketplace', 'asin']);
    if (this.asinDetailReturnFieldsType) {
      asinDetailTool.inputSchema.properties.returnFields = { type: this.asinDetailReturnFieldsType };
    }
    return {
      tools: [
        marketTool('market_research_statistics', this.flatMarketTools ? ['marketplace', 'nodeIdPath'] : ['request']),
        marketTool('market_product_concentration', this.flatMarketTools ? ['marketplace', 'nodeIdPath'] : ['request']),
        tool('asin_sales_trend', ['marketplace', 'asin']),
        ...(this.includeAsinDetail ? [asinDetailTool] : []),
        ...(this.omitCompetitorTool ? [] : [tool('asin_competitor', ['marketplace', 'asin'])]),
        this.flatMarketTools
          ? marketTool('market_research', ['marketplace', 'nodeIdPath'])
          : marketTool('market_research', ['request']),
      ],
      _meta: { progressToken: 'test' },
    };
  }

  async callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown> {
    this.calls.push(params);
    const request = params.arguments.request && typeof params.arguments.request === 'object'
      ? params.arguments.request as Record<string, unknown> : params.arguments;
    const defaultMarketStatistics = {
      marketplace: request.marketplace, nodeIdPath: request.nodeIdPath,
      products: 100, brands: 71, sellers: 69, avgUnits: 8_919, avgRevenue: 398_295,
      avgPrice: 44.83, avgRating: 4.3,
    };
    const data: Record<string, unknown> = {
      market_research_statistics: this.marketStatisticsByMonth?.[String(request.month)]
        ?? defaultMarketStatistics,
      market_product_concentration: this.concentrationItems.map((item) => ({
        ...item, ...(this.echoConcentrationMonth ? {
          marketplace: request.marketplace,
          nodeIdPath: request.nodeIdPath,
          month: request.month,
        } : {}),
      })),
      asin_sales_trend: {
        asin: { asin: request.asin, title: 'Test product', marketplace: request.marketplace,
          price: 50, rating: 4.5, ratings: 300, bsr: 10, sellers: 2 },
        salesTrendPoints: this.salesTrendPoints,
      },
      asin_detail: this.asinDetail,
      asin_competitor: [{ asin: 'B000TEST02', title: 'Candidate', units: 300 }],
      market_research: {
        pages: 1, page: 1, size: 5,
        total: this.marketResearchByMonth?.[String(request.month)] ? 1 : this.marketItems.length,
        items: this.marketResearchByMonth?.[String(request.month)]
          ? [this.marketResearchByMonth[String(request.month)]] : this.marketItems,
        hasNextPage: false,
      },
    };
    const payload = this.responsePayload ?? { code: this.remoteCode, message: this.remoteCode === 'OK' ? 'success' : 'denied',
      data: this.responseData === undefined ? data[params.name] : this.responseData };
    const structuredContent = this.structuredPayloadByTool[params.name];
    if (structuredContent) return { content: [], structuredContent, isError: false };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload), annotations: { audience: ['assistant'], priority: 1 } }],
      isError: false,
      _meta: { progressToken: 'test' },
    };
  }
}

function tool(name: string, required: string[], requestProperties?: Record<string, unknown>) {
  return {
    name,
    description: name.replaceAll('_', ' '),
    inputSchema: {
      type: 'object',
      required,
      properties: Object.fromEntries(required.map((field) => [field, field === 'request'
        ? { type: 'object', required: Object.keys(requestProperties ?? {})
            .filter((property) => property !== 'returnFields'), properties: requestProperties }
        : { type: 'string' }])),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: { provider: 'sellersprite' },
  };
}
