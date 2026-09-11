import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
import { AdapterRegistry } from './adapters/index.js';
import { openDatabase, type AppDatabase } from './database/database.js';
import { IntelligenceRepository } from './repository/intelligence-repository.js';
import { WorkflowRepository } from './repository/workflow-repository.js';
import { ImportService } from './services/import-service.js';
import { ExecutiveDashboardService } from './services/executive-dashboard-service.js';
import { IntelligenceService } from './services/intelligence-service.js';
import { WorkflowOrchestrator } from './services/workflow-orchestrator.js';

export interface CreateAppOptions {
  database?: AppDatabase;
  databasePath?: string;
  serveStatic?: boolean;
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
  const service = new IntelligenceService(database);
  const repository = service.repository;
  const workflowRepository = new WorkflowRepository(database, repository);
  const executiveDashboard = new ExecutiveDashboardService(database, repository, workflowRepository);
  const workflow = new WorkflowOrchestrator(database);
  const importer = new ImportService(database, new AdapterRegistry());
  const adminOnly = requireAdmin(repository);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  });
  const app = express();
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

  app.get('/api/markets', (_request, response) => sendData(response, repository.getMarkets(), repository));
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
    service.deleteOwnedProduct(id);
    sendData(response, { id, deleted: true }, repository);
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
      taskType: 'watchlist_refresh', watchlistId: routeParam(request, 'id'), source: 'Mock Adapter',
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
      watchlistId: z.string().optional(),
      retryTaskId: z.string().optional(),
    }).parse(request.body ?? {});
    sendData(response, await service.runDataTask(input), repository, 201);
  }));
  app.post('/api/data-tasks/:id/retry', adminOnly, asyncHandler(async (request, response) => {
    sendData(response, await service.runDataTask({ retryTaskId: routeParam(request, 'id') }), repository, 201);
  }));

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

  const importHandler = (format: 'csv' | 'xlsx') => (request: Request, response: Response): void => {
    if (!request.file) throw httpError(400, '请使用 multipart/form-data 的 file 字段上传文件。');
    const result = importer.import(request.file.buffer, {
      format,
      filename: request.file.originalname,
      entityType: stringBodyValue(request.body.entityType),
      marketplace: stringBodyValue(request.body.marketplace),
      marketNodeId: stringBodyValue(request.body.marketNodeId),
      researchJobId: stringBodyValue(request.body.researchJobId),
      sourceType: stringBodyValue(request.body.sourceType) === 'amazon' ? 'amazon' : 'import',
    });
    sendData(response, result, repository, 201);
  };
  app.post('/api/import/csv', adminOnly, upload.single('file'), importHandler('csv'));
  app.post('/api/import/xlsx', adminOnly, upload.single('file'), importHandler('xlsx'));

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
  if (/已有真实或导入数据/.test(error.message)) return 409;
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
