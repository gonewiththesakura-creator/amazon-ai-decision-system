import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type {
  ApiResponse,
  AppSettings,
  DataMode,
  ResearchJobDetail,
  TimeRange,
  TrendPoint,
} from '../shared/types.js';
import {
  AdapterRegistry,
  DataSourceRouter,
  SELLERSPRITE_CAPABILITIES,
  SellerSpriteMCPAdapter,
  type SellerSpriteConnectionDiagnostics,
} from './adapters/index.js';
import { sellerSpriteSchemaHash } from './adapters/sellersprite-tool-registry.js';
import type { SellerSpriteSyncPort } from './services/sellersprite-sync-service.js';
import { openDatabase, type AppDatabase } from './database/database.js';
import { IntelligenceRepository } from './repository/intelligence-repository.js';
import { WorkflowRepository } from './repository/workflow-repository.js';
import { ImportService } from './services/import-service.js';
import { ExecutiveDashboardService } from './services/executive-dashboard-service.js';
import { proveDashboardRunReadPath } from './services/dashboard-run-read-proof.js';
import { DataCoverageService } from './services/data-coverage-service.js';
import { IntelligenceService } from './services/intelligence-service.js';
import { GoLiveMigrationService } from './services/go-live-migration-service.js';
import { SellerSpriteSyncService } from './services/sellersprite-sync-service.js';
import { WorkflowOrchestrator } from './services/workflow-orchestrator.js';

export interface CreateAppOptions {
  database?: AppDatabase;
  databasePath?: string;
  serveStatic?: boolean;
  sellerSpritePort?: SellerSpriteSyncPort;
  sellerSpriteDiagnostics?: Pick<SellerSpriteMCPAdapter, 'testConnection'>;
  backupDirectory?: string;
}

const settingsSchema = z.object({
  mode: z.enum(['empty', 'demo', 'live']).optional(),
  role: z.enum(['admin', 'viewer']).optional(),
  marketplace: z.string().min(1).optional(),
  currency: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  defaultMarketId: z.string().optional(),
  aiModel: z.literal('rule-engine-v1').optional(),
  refreshFrequency: z.enum(['manual', 'daily', 'weekly']).optional(),
  lastSuccessfulSync: z.string().nullable().optional(),
});

const ownedProductSchema = z.object({
  asin: z.string().trim().min(1),
  sku: z.string().trim().optional(),
  internalName: z.string().trim().optional(),
  brand: z.string().trim().min(1),
  title: z.string().trim().min(1),
  imageUrl: z.string().trim().optional().default(''),
  marketplace: z.string().trim().optional(),
  productType: z.string().trim().optional(),
  isOwned: z.boolean().optional(),
  marketNodeId: z.string().trim().optional(),
  keywords: z.array(z.string()).optional().default([]),
  monitoringEnabled: z.boolean().optional().default(false),
});

const ownedProductPatchSchema = z.object({
  sku: z.string().trim().optional(),
  internalName: z.string().trim().optional(),
  brand: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  imageUrl: z.string().trim().optional(),
  productType: z.string().trim().min(1).optional(),
  marketNodeId: z.string().trim().min(1).optional(),
  keywords: z.array(z.string()).optional(),
  monitoringEnabled: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: '至少提供一个可更新字段。' });

const relationTypeSchema = z.enum(['direct', 'top100', 'benchmark', 'fast_growth', 'price_peer']);

const developmentSchema = z.object({
  name: z.string().trim().min(1),
  productType: z.string().trim().min(1),
  keywords: z.array(z.string()).default([]),
  notes: z.string().optional().default(''),
  marketplace: z.string().optional(),
  supplyChainRelation: z.string().optional().default(''),
  marketNodeId: z.string().trim().optional(),
});

const researchJobTypeSchema = z.enum([
  'existing_market', 'owned_product', 'adjacent_product', 'new_opportunity',
]);

const jsonObjectSchema = z.record(z.string(), z.unknown());

const researchJobSchema = z.object({
  name: z.string().trim().min(1),
  type: researchJobTypeSchema,
  marketplace: z.string().trim().min(1).optional(),
  entityType: z.string().trim().min(1).optional(),
  entityId: z.string().trim().min(1).optional(),
  ruleProfileId: z.string().trim().min(1).optional(),
  input: jsonObjectSchema.optional(),
  taskBook: jsonObjectSchema.optional(),
  createdBy: z.string().trim().min(1),
});

const ruleProfileSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  version: z.number().int().positive(),
  active: z.boolean().default(true),
  jobTypes: z.array(researchJobTypeSchema).min(1),
  hardGates: jsonObjectSchema,
  scoring: jsonObjectSchema,
  thresholds: jsonObjectSchema,
});

const asyncHandler = (
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>,
) => (request: Request, response: Response, next: NextFunction): void => {
  void handler(request, response, next).catch(next);
};

export function createApp(options: CreateAppOptions = {}): express.Express {
  const database = options.database ?? openDatabase(options.databasePath);
  const adapters = new AdapterRegistry(undefined, { database });
  const sellerSpriteAdapter = adapters.get('source-sellersprite-mcp') as SellerSpriteMCPAdapter;
  const service = new IntelligenceService(database, new DataSourceRouter(adapters));
  const repository = service.repository;
  const workflowRepository = new WorkflowRepository(database, repository);
  const executiveDashboard = new ExecutiveDashboardService(database, repository, workflowRepository);
  const dataCoverage = new DataCoverageService(database);
  const goLive = new GoLiveMigrationService(database);
  const workflow = new WorkflowOrchestrator(database);
  const importer = new ImportService(database, adapters);
  const sellerSprite = new SellerSpriteSyncService(
    database,
    options.sellerSpritePort ?? sellerSpriteAdapter,
  );
  const sellerSpriteDiagnostics = options.sellerSpriteDiagnostics ?? sellerSpriteAdapter;
  const adminOnly = requireAdmin(repository);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  });
  const app = express();
  let latestGoLiveBackup: { filename: string; createdAt: string; revision: string } | null = null;
  const databaseRevision = (): string => {
    const ownWrites = database.prepare('SELECT total_changes() AS count').get() as { count: number };
    const otherWrites = database.prepare('PRAGMA data_version').get() as { data_version: number };
    return `${ownWrites.count}:${otherWrites.data_version}`;
  };
  app.locals.database = database;

  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.setHeader('Access-Control-Allow-Origin', process.env.APP_URL ?? 'http://127.0.0.1:5173');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    if (request.method === 'OPTIONS') {
      response.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_request, response) => {
    sendData(response, { status: 'ok', database: 'connected' }, repository);
  });

  app.get('/api/settings', (_request, response) => sendData(response, repository.getSettings(), repository));
  app.patch('/api/settings', (request, response) => {
    const patch = settingsSchema.parse(request.body) as Partial<AppSettings>;
    const current = repository.getSettings();
    if (current.role === 'viewer') {
      const changedKeys = (Object.keys(patch) as Array<keyof AppSettings>)
        .filter((key) => JSON.stringify(patch[key]) !== JSON.stringify(current[key]));
      if (changedKeys.some((key) => key !== 'role') || patch.role !== 'admin') {
        throw httpError(403, 'Viewer 为只读角色，只能切换回 Admin 工作区。');
      }
    }
    sendData(response, service.updateSettings(patch), repository);
  });
  app.post('/api/settings/demo', adminOnly, (request, response) => {
    const body = z.object({ enabled: z.boolean().default(true) }).parse(request.body ?? {});
    sendData(response, service.setDemoMode(body.enabled), repository);
  });
  app.get('/api/data-sources', (_request, response) => sendData(response, repository.getDataSources(), repository));

  app.get('/api/go-live/preview', (_request, response) => {
    sendData(response, goLive.preview(), repository);
  });
  app.post('/api/go-live/backup', adminOnly, asyncHandler(async (_request, response) => {
    const backupDirectory = resolve(options.backupDirectory ?? join('data', 'backups'));
    mkdirSync(backupDirectory, { recursive: true });
    const filename = `opportunity-intelligence-${Date.now()}-${randomUUID()}.db`;
    const revisionBefore = databaseRevision();
    await goLive.backup(join(backupDirectory, filename));
    const revision = databaseRevision();
    if (revision !== revisionBefore) {
      latestGoLiveBackup = null;
      throw httpError(409, '备份期间数据库已变更，请重新备份。');
    }
    const createdAt = new Date().toISOString();
    latestGoLiveBackup = { filename, createdAt, revision };
    sendData(response, { created: true, filename, createdAt }, repository, 201);
  }));
  app.post('/api/go-live/cleanup', adminOnly, (request, response) => {
    const input = z.object({ confirmation: z.string() }).parse(request.body ?? {});
    if (input.confirmation !== 'CLEAR DEMO DATA') {
      throw httpError(409, '确认文本不匹配，未清除任何数据。');
    }
    if (!latestGoLiveBackup) throw httpError(409, '清除 Demo 前必须先创建数据库备份。');
    if (latestGoLiveBackup.revision !== databaseRevision()) {
      latestGoLiveBackup = null;
      throw httpError(409, '备份已过期：数据库在备份后发生变更，请重新备份。');
    }
    sendData(response, {
      cleanup: goLive.clearDemoObservations(),
      backup: { filename: basename(latestGoLiveBackup.filename), createdAt: latestGoLiveBackup.createdAt },
    }, repository);
  });
  app.get('/api/go-live/verify', (_request, response) => {
    sendData(response, goLive.verify(), repository);
  });
  app.post('/api/go-live/activate', adminOnly, (request, response) => {
    const input = z.object({ confirmation: z.string() }).parse(request.body ?? {});
    if (input.confirmation !== 'ACTIVATE LIVE') {
      throw httpError(409, '确认文本不匹配，未切换 Live 模式。');
    }
    goLive.activateLiveMode();
    sendData(response, { activated: true, verification: goLive.verify() }, repository);
  });

  app.get('/api/dashboard/briefing', (_request, response) => sendData(response, service.getDashboard(), repository));
  app.get('/api/dashboard/executive', (request, response) => {
    const query = z.object({
      range: z.enum(['7D', '30D', '90D', '180D', '1Y']).default('30D'),
      skuId: z.string().trim().min(1).optional(),
      marketplace: z.string().trim().min(1).optional(),
    }).parse(request.query);
    assertRequestedMarketplace(repository, query.marketplace);
    if (query.skuId) requireOwnedProduct(repository, query.skuId);
    sendData(response, executiveDashboard.getDashboard(query.range, query.skuId), repository);
  });
  app.get('/api/dashboard/executive/run-proof/:runId', adminOnly, (request, response) => {
    const runId = z.string().uuid().parse(routeParam(request, 'runId'));
    const roster = completedCriticalRoster(database, repository.getSettings().marketplace, runId);
    sendData(response, proveDashboardRunReadPath(database, { runId, ...roster }), repository);
  });
  app.get('/api/data-coverage', (request, response) => {
    const query = z.object({ marketplace: z.string().trim().min(1).optional() }).parse(request.query);
    assertRequestedMarketplace(repository, query.marketplace);
    sendData(response, dataCoverage.getCoverage(repository.getSettings().marketplace), repository);
  });

  app.get('/api/markets', (_request, response) => sendData(response, repository.getMarkets(), repository));
  app.patch('/api/markets/:id/sellersprite-node', adminOnly, (request, response) => {
    const id = routeParam(request, 'id');
    const market = requireMarket(repository, id);
    const input = z.object({ nodeIdPath: z.string().trim().regex(/^\d+(?::\d+)*$/), confirmed: z.literal(true) })
      .parse(request.body ?? {});
    const current = database.prepare(`SELECT category_id AS categoryId,
      sellersprite_confirmed_node_path AS confirmedPath FROM market_nodes WHERE id = ?`)
      .get(id) as { categoryId: string | null; confirmedPath: string | null };
    const canonicalPath = current.confirmedPath ?? current.categoryId;
    if (canonicalPath !== input.nodeIdPath) {
      const existing = database.prepare(`
        SELECT EXISTS(SELECT 1 FROM market_snapshots
          WHERE market_node_id = ? AND source_type = 'mcp') AS found
      `).get(id) as { found: number };
      if (existing.found) throw httpError(409, '该市场已有 SellerSprite 历史观察；变更节点路径需要新建市场。');
    }
    database.prepare(`UPDATE market_nodes
      SET category_id = ?, sellersprite_confirmed_node_path = ?
      WHERE id = ? AND marketplace = ?`)
      .run(input.nodeIdPath, input.nodeIdPath, id, market.node.marketplace);
    sendData(response, {
      marketId: id,
      nodeIdPath: input.nodeIdPath,
      sellerSpriteNodePath: input.nodeIdPath,
    }, repository);
  });
  app.get('/api/markets/:id/snapshots', (request, response) => {
    requireMarket(repository, request.params.id);
    const range = parseTimeRange(request.query.range);
    sendData(response, filterTrendRange(repository.getMarketSnapshots(request.params.id), range), repository);
  });
  app.get('/api/markets/:id/products', (request, response) => {
    requireMarket(repository, request.params.id);
    sendData(response, repository.getMarketProducts(request.params.id), repository);
  });
  app.get('/api/markets/:id/insights', (request, response) => {
    requireMarket(repository, request.params.id);
    const insight = repository.getCurrentWorkflowInsightForEntity('market', request.params.id);
    sendData(response, insight ? [insight] : [], repository);
  });
  app.get('/api/markets/:id', (request, response) => {
    const range = parseTimeRange(request.query.range);
    const market = requireMarket(repository, request.params.id);
    sendData(response, { ...market, trends: filterTrendRange(market.trends, range) }, repository);
  });

  app.get('/api/owned-products', (_request, response) => sendData(response, repository.getOwnedProducts(), repository));
  app.post('/api/owned-products', adminOnly, (request, response) => {
    const input = ownedProductSchema.parse(request.body);
    sendData(response, service.createOwnedProduct(input), repository, 201);
  });
  app.patch('/api/owned-products/:id', adminOnly, (request, response) => {
    const input = ownedProductPatchSchema.parse(request.body ?? {});
    sendData(response, service.updateOwnedProduct(routeParam(request, 'id'), input), repository);
  });
  app.delete('/api/owned-products/:id', adminOnly, (request, response) => {
    const id = routeParam(request, 'id');
    service.deactivateOwnedProduct(id);
    sendData(response, { id, deactivated: true }, repository);
  });
  app.get('/api/owned-products/:id/snapshots', (request, response) => {
    requireOwnedProduct(repository, request.params.id);
    sendData(response, repository.getProductSnapshots(request.params.id), repository);
  });
  app.get('/api/owned-products/:id/competitors', (request, response) => {
    requireOwnedProduct(repository, request.params.id);
    sendData(response, repository.getCompetitors(request.params.id), repository);
  });
  app.post('/api/owned-products/:id/competitors', adminOnly, (request, response) => {
    const input = z.object({
      competitorProductId: z.string().optional(),
      asin: z.string().optional(),
      brand: z.string().optional(),
      title: z.string().optional(),
      imageUrl: z.string().optional(),
      relationType: relationTypeSchema,
      similarityScore: z.number().min(0).max(100).optional(),
      reason: z.string().optional(),
      aiTags: z.array(z.string()).optional(),
    }).parse(request.body);
    sendData(response, service.addCompetitor(routeParam(request, 'id'), input), repository, 201);
  });
  app.patch('/api/owned-products/:id/competitors/:competitorId', adminOnly, (request, response) => {
    const input = z.object({
      currentRelationType: relationTypeSchema,
      relationType: relationTypeSchema.optional(),
      similarityScore: z.number().min(0).max(100).optional(),
      reason: z.string().optional(),
      aiTags: z.array(z.string()).optional(),
    }).parse(request.body ?? {});
    sendData(response, service.updateCompetitorRelation(
      routeParam(request, 'id'), routeParam(request, 'competitorId'), input,
    ), repository);
  });
  app.delete('/api/owned-products/:id/competitors/:competitorId', adminOnly, (request, response) => {
    const relationType = relationTypeSchema.parse(request.query.relationType);
    const id = routeParam(request, 'id');
    const competitorId = routeParam(request, 'competitorId');
    const deleted = service.deleteCompetitorRelation(id, competitorId, relationType);
    if (!deleted) throw httpError(404, '竞品关系不存在。');
    sendData(response, { id: competitorId, relationType, deleted: true }, repository);
  });
  app.get('/api/owned-products/:id/insights', (request, response) => {
    requireOwnedProduct(repository, request.params.id);
    const insight = repository.getCurrentWorkflowInsightForEntity('owned_product', request.params.id);
    sendData(response, insight ? [insight] : [], repository);
  });
  app.get('/api/owned-products/:id', (request, response) => {
    sendData(response, requireOwnedProduct(repository, request.params.id), repository);
  });

  app.get('/api/development-projects', (_request, response) => sendData(response, repository.getDevelopmentProjects(), repository));
  app.post('/api/development-projects', adminOnly, asyncHandler(async (request, response) => {
    const input = developmentSchema.parse(request.body);
    sendData(response, await service.createDevelopmentProject(input), repository, 201);
  }));
  app.post('/api/development-projects/:id/analyze', adminOnly, (request, response) => {
    const id = routeParam(request, 'id');
    assertNoWorkflowBypass(workflowRepository, 'development_project', id);
    const result = service.analyzeDevelopmentProject(id);
    sendData(response, result.project, repository);
  });
  app.post('/api/development-projects/:id/decision', adminOnly, (request, response) => {
    const input = z.object({
      decision: z.enum(['develop', 'test', 'watch', 'reject']),
      reason: z.string().trim().min(1),
      decidedBy: z.string().trim().min(1),
    }).parse(request.body);
    const id = routeParam(request, 'id');
    if (!repository.getDevelopmentProject(id)) throw httpError(404, '待开发项目不存在。');
    let approvedJob: ResearchJobDetail | undefined;
    if (input.decision === 'develop' || input.decision === 'test') {
      approvedJob = assertApprovedWorkflowForAdvancement(
        workflowRepository, 'development_project', id, [input.decision],
      );
    } else {
      assertNoWorkflowBypass(workflowRepository, 'development_project', id);
    }
    const result = service.decideDevelopmentProject(id, input, approvedJob);
    sendData(response, result.project, repository, 201);
  });
  app.get('/api/development-projects/:id', (request, response) => {
    const project = repository.getDevelopmentProject(request.params.id);
    if (!project) throw httpError(404, '待开发项目不存在。');
    sendData(response, project, repository);
  });

  app.post('/api/opportunity-lab/research', adminOnly, (request, response) => {
    const { query } = z.object({ query: z.string().trim().min(2).max(300) }).parse(request.body);
    sendData(response, service.researchOpportunity(query), repository, 201);
  });
  app.get('/api/opportunities', (_request, response) => sendData(response, repository.getOpportunities(), repository));
  app.get('/api/opportunities/:id', (request, response) => {
    const opportunity = repository.getOpportunity(routeParam(request, 'id'));
    if (!opportunity) throw httpError(404, '机会不存在。');
    sendData(response, opportunity, repository);
  });
  app.post('/api/opportunities/:id/watch', adminOnly, (request, response) => {
    sendData(response, service.watchOpportunity(routeParam(request, 'id')), repository);
  });
  app.post('/api/opportunities/:id/promote', adminOnly, asyncHandler(async (request, response) => {
    const id = routeParam(request, 'id');
    if (!repository.getOpportunity(id)) throw httpError(404, '机会不存在。');
    const approvedJob = assertApprovedWorkflowForAdvancement(
      workflowRepository, 'opportunity', id, ['develop', 'test'],
    );
    sendData(response, await service.promoteOpportunity(id, approvedJob), repository, 201);
  }));
  app.post('/api/opportunities/:id/reject', adminOnly, (request, response) => {
    const { reason, decidedBy } = z.object({
      reason: z.string().optional().default(''),
      decidedBy: z.string().optional().default('Admin'),
    }).parse(request.body ?? {});
    const id = routeParam(request, 'id');
    assertNoWorkflowBypass(workflowRepository, 'opportunity', id);
    sendData(response, service.rejectOpportunity(id, reason, decidedBy), repository);
  });

  app.get('/api/watchlist', (_request, response) => sendData(response, repository.getWatchlist(), repository));
  app.post('/api/watchlist', adminOnly, (request, response) => {
    const input = z.object({
      itemType: z.string().trim().min(1),
      itemId: z.string().trim().min(1),
      name: z.string().optional(),
      frequency: z.enum(['manual', 'daily', 'weekly']).optional(),
      status: z.enum(['active', 'paused']).optional(),
    }).parse(request.body);
    sendData(response, service.addWatchlist(input), repository, 201);
  });
  app.patch('/api/watchlist/:id', adminOnly, (request, response) => {
    const input = z.object({
      frequency: z.enum(['manual', 'daily', 'weekly']).optional(),
      status: z.enum(['active', 'paused']).optional(),
    }).refine((value) => value.frequency !== undefined || value.status !== undefined, {
      message: '至少提供 frequency 或 status。',
    }).parse(request.body ?? {});
    sendData(response, service.updateWatchlist(routeParam(request, 'id'), input), repository);
  });
  app.post('/api/watchlist/:id/refresh', adminOnly, asyncHandler(async (request, response) => {
    sendData(response, await service.runDataTask({
      taskType: 'watchlist_refresh', watchlistId: routeParam(request, 'id'),
    }), repository, 201);
  }));
  app.delete('/api/watchlist/:id', adminOnly, (request, response) => {
    const id = routeParam(request, 'id');
    const deleted = service.removeWatchlist(id);
    if (!deleted) throw httpError(404, '监控项不存在。');
    sendData(response, { id, deleted: true }, repository);
  });

  app.get('/api/data-tasks', (_request, response) => sendData(response, repository.getDataTasks(), repository));
  app.post('/api/data-tasks/run', adminOnly, asyncHandler(async (request, response) => {
    const input = z.object({
      taskType: z.string().optional(),
      target: z.string().optional(),
      source: z.string().optional(),
      sourcePreference: z.string().optional(),
      watchlistId: z.string().optional(),
      retryTaskId: z.string().optional(),
    }).parse(request.body ?? {});
    sendData(response, await service.runDataTask(input), repository, 201);
  }));
  app.post('/api/data-tasks/:id/retry', adminOnly, asyncHandler(async (request, response) => {
    sendData(response, await service.runDataTask({ retryTaskId: routeParam(request, 'id') }), repository, 201);
  }));

  app.post('/api/integrations/sellersprite/test', adminOnly, asyncHandler(async (_request, response) => {
    const result: SellerSpriteConnectionDiagnostics = await sellerSpriteDiagnostics.testConnection();
    database.prepare(`
      UPDATE data_sources
      SET status = ?, last_sync_at = CASE WHEN ? = 1 THEN ? ELSE last_sync_at END
      WHERE id = 'source-sellersprite-mcp'
    `).run(
      result.connected ? 'connected' : result.authenticated ? 'disconnected' : 'needs_configuration',
      result.connected ? 1 : 0,
      new Date().toISOString(),
    );
    sendData(response, result, repository);
  }));
  app.get('/api/integrations/sellersprite/capabilities', (request, response) => {
    const query = z.object({ runId: z.string().uuid().optional() }).parse(request.query);
    const row = database.prepare(`
      SELECT capabilities_json AS capabilitiesJson, collected_at AS collectedAt
      FROM provider_capability_snapshots
      WHERE provider_id = 'sellersprite' AND (? IS NULL OR sync_run_id = ?)
      ORDER BY collected_at DESC, rowid DESC LIMIT 1
    `).get(query.runId ?? null, query.runId ?? null) as {
      capabilitiesJson: string; collectedAt: string;
    } | undefined;
    if (query.runId && !row) throw httpError(404, '该运行没有 SellerSprite 能力快照。');
    const payload = row ? safeJsonObject(row.capabilitiesJson) : {};
    const mappings = safeJsonObject(payload.capabilities);
    const capabilitySchemaHashes = safeJsonObject(payload.capabilitySchemaHashes);
    const tools = Array.isArray(payload.tools)
      ? payload.tools.filter((tool): tool is Record<string, unknown> => (
        Boolean(tool) && typeof tool === 'object' && !Array.isArray(tool)
      ))
      : [];
    const missing = Array.isArray(payload.missingCapabilities)
      ? new Set(payload.missingCapabilities.filter((value): value is string => typeof value === 'string'))
      : new Set<string>(SELLERSPRITE_CAPABILITIES);
    sendData(response, {
      collectedAt: row?.collectedAt ?? null,
      toolCount: tools.length,
      required: SELLERSPRITE_CAPABILITIES.map((capability) => {
        const mappedName = mappings[capability];
        const matchingTools = typeof mappedName === 'string'
          ? tools.filter((tool) => tool.name === mappedName)
          : [];
        const directHash = validSchemaHash(capabilitySchemaHashes[capability]);
        const legacyTool = matchingTools.length === 1 ? matchingTools[0] : undefined;
        const legacyHash = legacyTool?.inputSchema && typeof legacyTool.inputSchema === 'object'
          ? sellerSpriteSchemaHash(legacyTool.inputSchema)
          : null;
        const schemaHash = directHash ?? legacyHash;
        const available = !missing.has(capability)
          && matchingTools.length > 0
          && schemaHash !== null;
        return {
          capability,
          available,
          schemaHash: available ? schemaHash : null,
        };
      }),
    }, repository);
  });

  app.post('/api/integrations/sellersprite/sync/market', adminOnly, asyncHandler(async (request, response) => {
    const input = z.object({
      marketId: z.string().trim().min(1),
      month: z.string().regex(/^\d{4}-?\d{2}(?:-\d{2})?$/),
    }).parse(request.body);
    requireMarket(repository, input.marketId);
    sendData(response, await sellerSprite.syncMarket(input), repository, 201);
  }));
  app.post('/api/integrations/sellersprite/sync/products', adminOnly, asyncHandler(async (request, response) => {
    const input = z.object({ productIds: z.array(z.string().trim().min(1)).max(100).optional() })
      .parse(request.body ?? {});
    const productIds = input.productIds ?? database.prepare(`
      SELECT id FROM products
      WHERE marketplace = ? AND is_owned = 1 AND is_parent = 0 AND status = 'active'
      ORDER BY id
    `).all(repository.getSettings().marketplace).map((row) => String((row as { id: string }).id));
    const results = [];
    for (const productId of productIds) {
      requireOwnedProduct(repository, productId);
      results.push({ productId, ...await sellerSprite.syncOwnedProduct({ productId }) });
    }
    sendData(response, { results }, repository, 201);
  }));
  app.post('/api/integrations/sellersprite/sync/competitor', adminOnly, asyncHandler(async (request, response) => {
    const input = z.object({
      ownedProductId: z.string().trim().min(1),
      competitorProductId: z.string().trim().min(1),
    }).parse(request.body);
    requireOwnedProduct(repository, input.ownedProductId);
    sendData(response, await sellerSprite.syncConfirmedCompetitor(input), repository, 201);
  }));
  app.post('/api/integrations/sellersprite/sync/critical', adminOnly, asyncHandler(async (request, response) => {
    const input = z.object({
      marketId: z.string().trim().min(1),
      month: z.string().regex(/^\d{4}-?\d{2}(?:-\d{2})?$/),
    }).parse(request.body);
    requireMarket(repository, input.marketId);
    sendData(response, await sellerSprite.syncCriticalBatch(input), repository, 201);
  }));
  app.get('/api/integrations/sellersprite/sync/critical/:runId/roster', adminOnly, (request, response) => {
    const runId = z.string().uuid().parse(routeParam(request, 'runId'));
    sendData(response, completedCriticalRoster(database, repository.getSettings().marketplace, runId), repository);
  });
  app.post('/api/owned-products/:id/competitor-candidates', adminOnly, asyncHandler(async (request, response) => {
    const ownedProductId = routeParam(request, 'id');
    requireOwnedProduct(repository, ownedProductId);
    const input = z.object({ size: z.number().int().min(1).max(100).optional() }).parse(request.body ?? {});
    sendData(response, await sellerSprite.discoverCompetitors({ ownedProductId, ...input }), repository, 201);
  }));
  app.get('/api/owned-products/:id/competitor-candidates', (request, response) => {
    const ownedProductId = routeParam(request, 'id');
    requireOwnedProduct(repository, ownedProductId);
    sendData(response, sellerSprite.listCompetitorCandidates(ownedProductId), repository);
  });
  app.post('/api/owned-products/:id/competitor-candidates/:candidateId/confirm', adminOnly, (request, response) => {
    const ownedProductId = routeParam(request, 'id');
    requireOwnedProduct(repository, ownedProductId);
    const input = z.object({
      relationType: relationTypeSchema.default('direct'),
      reason: z.string().trim().min(1),
      similarityScore: z.number().min(0).max(100).optional(),
    }).parse(request.body ?? {});
    sendData(response, sellerSprite.confirmCompetitorCandidate({
      ownedProductId,
      candidateId: routeParam(request, 'candidateId'),
      ...input,
    }), repository, 201);
  });
  app.post('/api/owned-products/:id/competitor-candidates/:candidateId/reject', adminOnly, (request, response) => {
    const ownedProductId = routeParam(request, 'id');
    requireOwnedProduct(repository, ownedProductId);
    sendData(response, sellerSprite.rejectCompetitorCandidate({
      ownedProductId,
      candidateId: routeParam(request, 'candidateId'),
    }), repository);
  });

  app.get('/api/rules/profiles', (_request, response) => {
    sendData(response, workflowRepository.getRuleProfiles(), repository);
  });
  app.post('/api/rules/profiles', adminOnly, (request, response) => {
    sendData(response, workflowRepository.createRuleProfile(ruleProfileSchema.parse(request.body)), repository, 201);
  });

  app.get('/api/research-jobs', (_request, response) => {
    sendData(response, workflowRepository.getResearchJobs(), repository);
  });
  app.post('/api/research-jobs', adminOnly, (request, response) => {
    const input = researchJobSchema.parse(request.body);
    assertRequestedMarketplace(repository, input.marketplace);
    sendData(response, workflowRepository.createResearchJob(input), repository, 201);
  });
  app.post('/api/research-jobs/:id/run', adminOnly, (request, response) => {
    const input = z.object({ inputPatch: jsonObjectSchema.optional() }).parse(request.body ?? {});
    sendData(response, workflow.run(routeParam(request, 'id'), input.inputPatch), repository);
  });
  app.post('/api/research-jobs/:id/retry', adminOnly, (request, response) => {
    const input = z.object({
      resolvedData: jsonObjectSchema.default({}),
      resolvedBy: z.string().trim().min(1),
    }).parse(request.body ?? {});
    const id = routeParam(request, 'id');
    const job = requireResearchJob(workflowRepository, id);
    assertRetryFields(workflowRepository, job, input.resolvedData);
    sendData(response, workflow.retry(id, input), repository);
  });
  app.post('/api/research-jobs/:id/approve', adminOnly, (request, response) => {
    const input = z.object({
      decision: z.enum(['approved', 'watch', 'needs_data']),
      reason: z.string().trim().min(1),
      decidedBy: z.string().trim().min(1),
    }).parse(request.body);
    sendData(response, workflow.decide(routeParam(request, 'id'), input), repository, 201);
  });
  app.post('/api/research-jobs/:id/reject', adminOnly, (request, response) => {
    const input = z.object({
      reason: z.string().trim().min(1),
      decidedBy: z.string().trim().min(1),
    }).parse(request.body);
    sendData(response, workflow.decide(routeParam(request, 'id'), {
      decision: 'rejected', ...input,
    }), repository, 201);
  });
  app.get('/api/research-jobs/:id/steps', (request, response) => {
    const job = requireResearchJob(workflowRepository, routeParam(request, 'id'));
    sendData(response, job.steps, repository);
  });
  app.get('/api/research-jobs/:id/evidence', (request, response) => {
    const job = requireResearchJob(workflowRepository, routeParam(request, 'id'));
    sendData(response, workflowRepository.getEvidence(job.id), repository);
  });
  app.get('/api/research-jobs/:id/missing-data', (request, response) => {
    const job = requireResearchJob(workflowRepository, routeParam(request, 'id'));
    sendData(response, workflowRepository.getMissingData(job.id), repository);
  });
  app.get('/api/research-jobs/:id', (request, response) => {
    sendData(response, requireResearchJob(workflowRepository, routeParam(request, 'id')), repository);
  });

  app.post(['/api/import/csv', '/api/import/xlsx'], adminOnly, () => {
    throw httpError(410, '直接导入已停用；请先通过 /api/import/preview/csv 或 /api/import/preview/xlsx 审核文件，再使用确认令牌导入。');
  });
  const previewImportHandler = (format: 'csv' | 'xlsx') => (request: Request, response: Response): void => {
    if (!request.file) throw httpError(400, '请使用 multipart/form-data 的 file 字段上传文件。');
    sendData(response, importer.preview(request.file.buffer, {
      format,
      filename: request.file.originalname,
      entityType: stringBodyValue(request.body.entityType),
      marketplace: stringBodyValue(request.body.marketplace),
      marketNodeId: stringBodyValue(request.body.marketNodeId),
      reportStartDate: stringBodyValue(request.body.reportStartDate),
      reportEndDate: stringBodyValue(request.body.reportEndDate),
      researchJobId: stringBodyValue(request.body.researchJobId),
      sourceType: stringBodyValue(request.body.sourceType) === 'amazon' ? 'amazon' : 'import',
    }), repository);
  };
  app.post('/api/import/preview/csv', adminOnly, upload.single('file'), previewImportHandler('csv'));
  app.post('/api/import/preview/xlsx', adminOnly, upload.single('file'), previewImportHandler('xlsx'));
  app.post('/api/import/preview/type', adminOnly, (request, response) => {
    const input = z.object({
      token: z.string().uuid(),
      entityType: z.string().trim().min(1),
    }).parse(request.body);
    sendData(response, importer.selectType(input.token, input.entityType), repository);
  });
  app.post('/api/import/confirm', adminOnly, (request, response) => {
    const input = z.object({
      token: z.string().uuid(),
      entityType: z.string().trim().min(1).optional(),
    }).parse(request.body);
    sendData(response, importer.confirm(input.token, input.entityType), repository, 201);
  });

  app.post('/api/ai/analyze', adminOnly, (request, response) => {
    const body = z.object({
      entityType: z.string().optional(),
      entityId: z.string().optional(),
      insightType: z.string().optional(),
      question: z.string().optional(),
      prompt: z.string().optional(),
    }).parse(request.body ?? {});
    const question = body.question ?? body.prompt;
    const result = question
      ? service.ai.answerQuestion(question, { entityType: body.entityType, entityId: body.entityId })
      : service.ai.preview({
        entityType: body.entityType ?? '', entityId: body.entityId ?? '', insightType: body.insightType,
      });
    sendData(response, result, repository);
  });
  app.get('/api/ai/insights/:entityType/:entityId', (request, response) => {
    const entityType = normalizeInsightEntityType(routeParam(request, 'entityType'));
    const entityId = routeParam(request, 'entityId');
    requireInsightEntity(repository, workflowRepository, entityType, entityId);
    const insight = entityType === 'research_job'
      ? workflowRepository.getResearchJob(entityId)?.latestInsight
      : repository.getCurrentWorkflowInsightForEntity(entityType, entityId);
    sendData(response, insight ? [insight] : [], repository);
  });

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'API 路由不存在。' });
  });

  const shouldServeStatic = options.serveStatic ?? process.env.NODE_ENV === 'production';
  const distPath = resolve('dist');
  if (shouldServeStatic && existsSync(distPath)) {
    app.use(express.static(distPath));
    app.use((request, response, next) => {
      if (request.method !== 'GET') return next();
      response.sendFile(join(distPath, 'index.html'));
    });
  }

  app.use((error: unknown, request: Request, response: Response, next: NextFunction) => {
    void request;
    void next;
    if (error instanceof z.ZodError) {
      response.status(400).json({
        error: '请求数据校验失败。', details: error.issues,
      });
      return;
    }
    if (error instanceof multer.MulterError) {
      response.status(400).json({ error: `文件上传失败：${error.message}` });
      return;
    }
    const status = isHttpError(error) ? error.status : inferErrorStatus(error);
    const message = error instanceof Error ? error.message : '服务器发生未知错误。';
    response.status(status).json({ error: message });
  });

  return app;
}

function sendData<T>(
  response: Response,
  data: T,
  repository: IntelligenceRepository,
  status = 200,
): void {
  const mode: DataMode = repository.getSettings().mode;
  const payload: ApiResponse<T> = { data, meta: { mode, generatedAt: new Date().toISOString() } };
  response.status(status).json(payload);
}

function safeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function validSchemaHash(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function completedCriticalRoster(
  database: AppDatabase, marketplace: string, runId: string,
): { marketId: string; ownedProductIds: string[] } {
  const row = database.prepare(`
    SELECT run.coverage_json AS coverageJson
    FROM data_coverage_runs run
    JOIN data_tasks task ON task.id = run.id AND task.sync_run_id = run.id
    WHERE run.id = ? AND run.marketplace = ? AND run.run_type = 'critical_sync'
      AND run.is_complete = 1 AND task.task_type = 'critical_sync' AND task.status = 'success'
      AND task.success = task.total AND task.failed = 0
  `).get(runId, marketplace) as { coverageJson: string } | undefined;
  if (!row) throw httpError(404, '关键同步运行不存在或尚未完整完成。');
  const coverage = safeJsonObject(row.coverageJson);
  const roster = Array.isArray(coverage.ownedProducts) ? coverage.ownedProducts : [];
  const ownedProductIds = roster.map((item) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>).id
      : undefined
  ));
  if (typeof coverage.marketId !== 'string' || ownedProductIds.length === 0
    || ownedProductIds.some((id) => typeof id !== 'string' || id.length === 0)
    || new Set(ownedProductIds).size !== ownedProductIds.length) {
    throw httpError(409, '关键同步运行范围记录无效。');
  }
  return { marketId: coverage.marketId, ownedProductIds: ownedProductIds as string[] };
}

function requireMarket(repository: IntelligenceRepository, id: string) {
  const market = repository.getMarket(id);
  if (!market) throw httpError(404, '市场节点不存在。');
  return market;
}

function requireOwnedProduct(repository: IntelligenceRepository, id: string) {
  const product = repository.getOwnedProduct(id);
  if (!product) throw httpError(404, '自有产品不存在。');
  return product;
}

function requireResearchJob(repository: WorkflowRepository, id: string): ResearchJobDetail {
  const job = repository.getResearchJob(id);
  if (!job) throw httpError(404, 'Research Job 不存在或不属于当前站点。');
  return job;
}

function assertRequestedMarketplace(repository: IntelligenceRepository, requested?: string): void {
  if (requested && requested !== repository.getSettings().marketplace) {
    throw httpError(409, `请求站点 ${requested} 与当前工作区站点不一致。`);
  }
}

function assertRetryFields(
  repository: WorkflowRepository,
  job: ResearchJobDetail,
  resolvedData: Record<string, unknown>,
): void {
  if (job.status !== 'needs_data' && job.status !== 'failed') {
    throw httpError(409, `当前状态 ${job.status} 不允许重试。`);
  }
  const openFields = new Set(repository.getMissingData(job.id)
    .filter((item) => item.status === 'open')
    .map((item) => item.fieldName));
  const unexpected = Object.keys(resolvedData).filter((field) => !openFields.has(field));
  if (unexpected.length > 0) {
    throw httpError(400, `只能补充当前 Missing Data Queue 中的字段：${unexpected.join(', ')}`);
  }
}

function assertNoWorkflowBypass(
  repository: WorkflowRepository,
  entityType: string,
  entityId: string,
): void {
  if (repository.hasWorkflowLineageForEntity(entityType, entityId)) {
    throw httpError(409, '该对象已纳入 V2 Research Job，必须在工作流中完成 Hard Gate、Reverse Review 和人工 Approval。');
  }
}

function assertApprovedWorkflowForAdvancement(
  repository: WorkflowRepository,
  entityType: string,
  entityId: string,
  allowedActions: string[],
): ResearchJobDetail {
  try {
    return repository.requireApprovedResearchJobForAdvancement(
      entityType, entityId, allowedActions,
    );
  } catch {
    throw httpError(
      409,
      '推进新产品前必须由最新 V2 Research Job 完成 Hard Gate、Reverse Review，并人工批准当前动作。',
    );
  }
}

function requireInsightEntity(
  repository: IntelligenceRepository,
  workflowRepository: WorkflowRepository,
  entityType: string,
  entityId: string,
): void {
  if (entityType === 'research_job') {
    requireResearchJob(workflowRepository, entityId);
    return;
  }
  if (entityType === 'market') {
    requireMarket(repository, entityId);
    return;
  }
  if (entityType === 'owned_product') {
    requireOwnedProduct(repository, entityId);
    return;
  }
  if (entityType === 'development_project') {
    if (!repository.getDevelopmentProject(entityId)) throw httpError(404, '待开发项目不存在。');
    return;
  }
  if (entityType === 'opportunity') {
    if (!repository.getOpportunity(entityId)) throw httpError(404, '机会不存在。');
    return;
  }
  throw httpError(400, `不支持的 Insight 实体类型：${entityType}`);
}

interface HttpError extends Error {
  status: number;
}

function httpError(status: number, message: string): HttpError {
  return Object.assign(new Error(message), { status });
}

function isHttpError(error: unknown): error is HttpError {
  return error instanceof Error && 'status' in error && typeof error.status === 'number';
}

function inferErrorStatus(error: unknown): number {
  if (!(error instanceof Error)) return 500;
  if (/UNIQUE constraint failed/.test(error.message)) return 409;
  if (/无法切换 Live 模式/.test(error.message)) return 409;
  if (/已有真实或导入数据|真实工作流仍引用 Demo|Demo 不能覆盖|Go Live 迁移/.test(error.message)) return 409;
  if (/机会数据不足/.test(error.message)) return 409;
  if (/存在历史 Snapshot/.test(error.message)) return 409;
  if (/当前状态|没有待处理的.*Approval|阻断决策|不能批准|Reverse Review/.test(error.message)) return 409;
  if (/不存在|未找到/.test(error.message)) return 404;
  return 400;
}

function stringBodyValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeInsightEntityType(value: string): string {
  const aliases: Record<string, string> = {
    ownedProduct: 'owned_product', product: 'owned_product',
    developmentProject: 'development_project', development: 'development_project',
  };
  return aliases[value] ?? value;
}

function requireAdmin(repository: IntelligenceRepository) {
  return (_request: Request, response: Response, next: NextFunction): void => {
    if (repository.getSettings().role !== 'admin') {
      response.status(403).json({ error: 'Viewer 为只读角色，无法执行此操作。' });
      return;
    }
    next();
  };
}

function routeParam(request: Request, name: string): string {
  const value = request.params[name];
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

function parseTimeRange(value: unknown): TimeRange {
  const normalized = Array.isArray(value) ? value[0] : value;
  if (normalized === undefined) return '1Y';
  return z.enum(['7D', '30D', '90D', '180D', '1Y']).parse(normalized);
}

function filterTrendRange(points: TrendPoint[], range: TimeRange): TrendPoint[] {
  if (points.length < 2 || range === '1Y') return points;
  const days: Record<Exclude<TimeRange, '1Y'>, number> = {
    '7D': 7,
    '30D': 30,
    '90D': 90,
    '180D': 180,
  };
  const latestTime = Math.max(...points.map((point) => new Date(`${point.date}T00:00:00Z`).getTime()));
  if (!Number.isFinite(latestTime)) return points;
  const cutoff = latestTime - days[range] * 24 * 60 * 60 * 1_000;
  return points.filter((point) => new Date(`${point.date}T00:00:00Z`).getTime() >= cutoff);
}
