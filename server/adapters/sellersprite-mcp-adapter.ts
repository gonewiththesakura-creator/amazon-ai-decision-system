import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Product, ProductSnapshot, Provenance } from '../../shared/types.js';
import type { AppDatabase } from '../database/database.js';
import { SellerSpriteMcpClient, SellerSpriteMcpError, scrubSecrets } from './sellersprite-mcp-client.js';
import {
  sellerSpriteAsinIdentitySchema,
  sellerSpriteAsinTrendSchema,
  sellerSpriteEnvelope,
  sellerSpriteMarketResearchSchema,
  sellerSpriteMarketStatisticsSchema,
  sellerSpriteObjectSchema,
} from './sellersprite-mcp-schemas.js';
import {
  SqliteMcpCallLedgerStore, SqliteMcpCapabilityStore, SqliteMcpResponseCacheStore,
  type McpCapabilityStore,
} from './sellersprite-mcp-store.js';
import {
  SELLERSPRITE_CAPABILITIES,
  SellerSpriteToolRegistry,
  sellerSpriteSchemaHash,
  reusableCapabilitySnapshot,
  type SellerSpriteCapability,
} from './sellersprite-tool-registry.js';
import type {
  KeywordDataRecord, KeywordInput, MarketDataAdapter, MarketInput,
  MarketOverviewRecord, ProductDetailRecord, ProductInput,
} from './types.js';
import { AdapterUnavailableError } from './types.js';
import { freshExecution, McpBudgetManager, McpPolicyError, requestKey,
  type SellerSpriteSyncMode } from './mcp-policy.js';

const object = sellerSpriteObjectSchema;

const MARKET_STATISTICS_RETURN_FIELDS = [
  'marketplace', 'nodeIdPath', 'month', 'totalProducts', 'products', 'sellers', 'brands', 'totalUnits',
  'totalRevenue', 'avgPrice', 'medianPrice', 'avgRating', 'medianReviews', 'top10Share',
  'top20Share', 'newProductShare', 'newProductProportion',
].join(',');

const PRODUCT_CONCENTRATION_RETURN_FIELDS = [
  'marketplace', 'nodeIdPath', 'month', 'asin', 'title', 'brand', 'price', 'rating',
  'ratings', 'reviews', 'totalUnits', 'totalRevenue', 'totalUnitsRatio', 'totalRevenueRatio',
].join(',');

const MARKET_RESEARCH_SUMMARY_RETURN_FIELDS = [
  'marketplace', 'nodeIdPath', 'month', 'totalProducts', 'topProducts', 'totalUnits', 'totalRevenue',
  'avgUnits', 'avgRevenue', 'avgPrice', 'avgRatings', 'avgRating', 'brands', 'sellers',
  'top10ProductSales', 'top10ProductCrn', 'top20ProductSales', 'top20ProductCrn',
  'newProductProportion',
].join(',');

export interface SellerSpriteMarketRequest {
  marketplace: string;
  nodeIdPath: string;
  month?: string;
}

export interface SellerSpriteAsinRequest { marketplace: string; asin: string }
export interface SellerSpriteSyncContext {
  runId?: string;
  requireObservationMonth?: boolean;
  syncMode?: SellerSpriteSyncMode;
  secondary?: boolean;
}
export type SellerSpriteData<T> = { data: T; provenance: Provenance };
export type SellerSpriteStatistics = Record<string, unknown>;
export type SellerSpriteConcentration = Array<Record<string, unknown>>;
export type SellerSpriteMarketResearchSummary = Record<string, unknown> & {
  marketplace: string;
  nodeIdPath: string;
};
export type SellerSpriteAsinTrend = {
  asin: Record<string, unknown>;
  salesTrendPoints: Array<Record<string, unknown>>;
};
export type SellerSpriteAsinIdentity = z.infer<typeof sellerSpriteAsinIdentitySchema>;
export type SellerSpriteCompetitorCandidates = Array<Record<string, unknown>>;

export interface SellerSpriteConnectionDiagnostics {
  connected: boolean;
  authenticated: boolean;
  toolCount: number;
  requiredCapabilityCount: number;
  availableRequiredCapabilityCount: number;
  missingCapabilities: SellerSpriteCapability[];
  latencyMs: number;
  errorCode?: string;
}

export class SellerSpriteMCPAdapter implements MarketDataAdapter {
  readonly id = 'source-sellersprite-mcp';
  readonly name = 'SellerSprite MCP';
  readonly sourceType = 'mcp' as const;

  private readonly client: SellerSpriteMcpClient;
  private registry: SellerSpriteToolRegistry;
  private discoveryInvalidated = false;
  private readonly capabilityStore?: McpCapabilityStore;
  private readonly runRegistries = new Map<string, Promise<SellerSpriteToolRegistry>>();
  private registryExpiresAt = 0;
  private readonly injectedClient: boolean;
  private discovered = false;
  private readonly database?: AppDatabase;
  private readonly budget?: McpBudgetManager;
  private discoveredAt = 0;

  constructor(options: {
    client?: SellerSpriteMcpClient;
    registry?: SellerSpriteToolRegistry;
    database?: AppDatabase;
  } = {}) {
    this.database = options.database;
    this.budget = options.database ? new McpBudgetManager(options.database) : undefined;
    this.client = options.client ?? new SellerSpriteMcpClient(options.database ? {
      budget: this.budget,
      ledgerStore: new SqliteMcpCallLedgerStore(options.database),
      cacheStore: new SqliteMcpResponseCacheStore(options.database),
    } : {});
    this.capabilityStore = options.database ? new SqliteMcpCapabilityStore(options.database) : undefined;
    this.registry = options.registry ?? new SellerSpriteToolRegistry({ store: this.capabilityStore });
    this.injectedClient = Boolean(options.client);
  }

  async testConnection(): Promise<SellerSpriteConnectionDiagnostics> {
    const previous = this.capabilityStore?.latest();
    if (previous && Date.now() - Date.parse(previous.discoveredAt) < (this.budget?.ttl('CONNECTION') ?? 1800_000) && !freshExecution()) {
      this.budget?.record('connection', 'local_hit');
      return { connected: true, authenticated: true, toolCount: previous.tools.length,
        requiredCapabilityCount: SELLERSPRITE_CAPABILITIES.length,
        availableRequiredCapabilityCount: SELLERSPRITE_CAPABILITIES.length - previous.missingCapabilities.length,
        missingCapabilities: previous.missingCapabilities, latencyMs: 0 };
    }
    const startedAt = Date.now();
    const status = await this.client.connectionTest();
    let missingCapabilities = [...SELLERSPRITE_CAPABILITIES] as SellerSpriteCapability[];
    if (status.connected) {
      await this.registry.refresh(() => this.client.listTools());
      missingCapabilities = this.registry.missing();
      this.discovered = true;
    }
    return {
      ...status,
      requiredCapabilityCount: SELLERSPRITE_CAPABILITIES.length,
      availableRequiredCapabilityCount: SELLERSPRITE_CAPABILITIES.length - missingCapabilities.length,
      missingCapabilities,
      latencyMs: Math.max(0, Date.now() - startedAt),
    };
  }

  async fetchMarketStatistics(
    input: SellerSpriteMarketRequest, context?: SellerSpriteSyncContext,
  ): Promise<SellerSpriteData<SellerSpriteStatistics>> {
    return this.fetchMarketCapability(
      'MARKET_STATISTICS', input, sellerSpriteMarketStatisticsSchema,
      MARKET_STATISTICS_RETURN_FIELDS, context,
    );
  }

  async fetchMarketConcentration(
    input: SellerSpriteMarketRequest, context?: SellerSpriteSyncContext,
  ): Promise<SellerSpriteData<SellerSpriteConcentration>> {
    return this.fetchMarketCapability(
      'PRODUCT_CONCENTRATION', input, z.array(object), PRODUCT_CONCENTRATION_RETURN_FIELDS, context,
    );
  }

  async fetchMarketResearchSummary(
    input: SellerSpriteMarketRequest, context?: SellerSpriteSyncContext,
  ): Promise<SellerSpriteData<SellerSpriteMarketResearchSummary>> {
    if (context?.requireObservationMonth && !context.runId) {
      throw new SellerSpriteMcpError(
        'INVALID_SCHEMA', 'SellerSprite MARKET_RESEARCH requires a fresh run to certify an observation month',
      );
    }
    const result = await this.fetchCapability(
      'MARKET_RESEARCH', (registry) => ({ request: {
        marketplace: input.marketplace,
        nodeIdPath: input.nodeIdPath,
        ...optionalMonth(input.month),
        ...(registry.supportsStringArgument('MARKET_RESEARCH', 'returnFields')
          ? { returnFields: MARKET_RESEARCH_SUMMARY_RETURN_FIELDS } : {}),
      } }), sellerSpriteMarketResearchSchema, 'market_refresh', context,
      (data) => { uniqueMarketResearchItem(data.items, input); },
    );
    return {
      data: uniqueMarketResearchItem(result.data.items, input),
      provenance: result.provenance,
    };
  }

  async fetchAsinSalesTrend(
    input: SellerSpriteAsinRequest, context?: SellerSpriteSyncContext,
  ): Promise<SellerSpriteData<SellerSpriteAsinTrend>> {
    return this.fetchCapability(
      'ASIN_SALES_TREND', { ...input }, sellerSpriteAsinTrendSchema, 'owned_sku_refresh', context,
    );
  }

  async fetchAsinIdentity(
    input: SellerSpriteAsinRequest, context?: SellerSpriteSyncContext,
  ): Promise<SellerSpriteData<SellerSpriteAsinIdentity>> {
    return this.fetchCapability('ASIN_DETAIL', (registry) => ({
      ...input,
      ...(registry.supportsStringArgument('ASIN_DETAIL', 'returnFields')
        ? { returnFields: 'asin,title,brand,parent,nodeIdPath,marketplace' } : {}),
    }), sellerSpriteAsinIdentitySchema, 'product_detail', context);
  }

  async discoverAsinCompetitors(
    input: SellerSpriteAsinRequest & { size?: number },
    context?: SellerSpriteSyncContext,
  ): Promise<SellerSpriteData<SellerSpriteCompetitorCandidates>> {
    return this.fetchCapability('ASIN_COMPETITOR_DISCOVERY', { ...input }, z.array(object), 'competitor_refresh', context);
  }

  async fetchMarketOverview(input: MarketInput): Promise<MarketOverviewRecord> {
    const nodeIdPath = input.marketId;
    if (!nodeIdPath) throw new AdapterUnavailableError('SellerSprite market statistics require a nodeIdPath');
    const { data, provenance } = await this.fetchMarketStatistics({ marketplace: input.marketplace, nodeIdPath });
    const required = [
      'products', 'sellers', 'brands', 'totalUnits', 'totalRevenue', 'avgPrice',
      'medianPrice', 'avgRating', 'medianReviews',
    ] as const;
    const newProductShare = firstFiniteNumber(
      data.newProductShare, data.newProductProportion,
    );
    const missing = required.filter((key) => typeof data[key] !== 'number');
    if (missing.length > 0 || newProductShare === null) {
      const missingMetrics = [
        ...missing,
        ...(newProductShare === null ? ['newProductShare'] : []),
      ];
      throw new SellerSpriteMcpError('INVALID_SCHEMA', `SellerSprite overview missing required metrics: ${missingMetrics.join(', ')}`);
    }
    const concentration = await this.fetchMarketConcentration({ marketplace: input.marketplace, nodeIdPath });
    const unitsRatios = concentration.data.map((item) => item.totalUnitsRatio);
    if (unitsRatios.length < 20 || unitsRatios.some((ratio) => typeof ratio !== 'number')) {
      throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite overview missing concentration ratios');
    }
    const top10Share = sumRatios(unitsRatios.slice(0, 10) as number[]);
    const top20Share = sumRatios(unitsRatios.slice(0, 20) as number[]);
    return {
      productCount: data.products as number, sellerCount: data.sellers as number,
      brandCount: data.brands as number, monthlySales: data.totalUnits as number,
      monthlyRevenue: data.totalRevenue as number, avgPrice: data.avgPrice as number,
      medianPrice: data.medianPrice as number, avgRating: data.avgRating as number,
      medianReviews: data.medianReviews as number, top10Share, top20Share,
      newProductShare,
      priceBands: [], concentration: [], provenance,
    };
  }

  async fetchMarketProducts(input: MarketInput): Promise<Product[]> {
    const request = {
      marketplace: input.marketplace,
      ...(input.marketId ? { nodeIdPath: input.marketId } : {}),
      ...(input.keywords[0] ? { departmentKeyword: input.keywords[0] } : {}),
    };
    const { data, provenance } = await this.fetchCapability(
      'MARKET_RESEARCH', { request }, sellerSpriteMarketResearchSchema, 'market_refresh',
    );
    return data.items.map((item) => productFromItem(item, input.marketplace, input.marketId ?? '', provenance));
  }

  async fetchProductDetail(input: ProductInput): Promise<ProductDetailRecord> {
    const request = { marketplace: input.marketplace, asin: input.asin };
    const { data, provenance } = await this.fetchAsinSalesTrend(request);
    const latest = data.salesTrendPoints.at(-1);
    if (!latest || typeof latest.month !== 'string') {
      throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite product detail missing identity or observation period');
    }
    const info = this.registry.resolve('ASIN_DETAIL')
      ? identityWithFallback((await this.fetchAsinIdentity(request)).data, data.asin)
      : data.asin;
    if (typeof info.asin !== 'string' || typeof info.title !== 'string') {
      throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite product detail missing identity or observation period');
    }
    const id = `${input.marketplace}:${info.asin}`;
    const isParentAsin = typeof info.parent === 'string'
      && info.parent.toUpperCase() === info.asin.toUpperCase();
    const snapshot: ProductSnapshot = {
      id: randomUUID(), snapshotAvailable: true, productId: id, date: observationDate(latest.month),
      price: numberOrNull(latest.price), rating: numberOrNull(latest.rating),
      reviewCount: numberOrNull(latest.ratings), bsr: numberOrNull(latest.bsr ?? latest.bsrRank),
      estimatedSales: numberOrNull(latest.childUnitSales
        ?? (isParentAsin ? latest.parentUnitSales : null)),
      estimatedRevenue: numberOrNull(latest.childSalesRevenue
        ?? (isParentAsin ? latest.parentSalesRevenue : null)),
      sellerCount: numberOrNull(latest.sellers),
      growth7d: null, growth30d: null, growth30dAvailable: false, growth90d: null,
      provenance,
    };
    return {
      id, asin: info.asin, title: info.title, brand: typeof info.brand === 'string' ? info.brand : '',
      imageUrl: typeof info.imageUrl === 'string' ? info.imageUrl : '',
      marketplace: input.marketplace, productType: 'unknown', isOwned: false,
      marketNodeId: typeof info.nodeIdPath === 'string' ? info.nodeIdPath : '',
      latest: snapshot, provenance,
    };
  }

  async fetchKeywordData(input: KeywordInput): Promise<KeywordDataRecord[]> {
    void input;
    throw new AdapterUnavailableError('SellerSprite keyword capability is not mapped from discovered tools');
  }

  async close(): Promise<void> {
    await this.client.close();
    this.discovered = false;
    this.runRegistries.clear();
  }

  async refreshCapabilities() {
    const previous = this.capabilityStore?.latest();
    const next = await this.registry.refresh(() => this.client.listTools({fresh:true}));
    for (const capability of SELLERSPRITE_CAPABILITIES) {
      if (previous?.capabilitySchemaHashes?.[capability]
        && previous.capabilitySchemaHashes[capability] !== next.capabilitySchemaHashes?.[capability]) {
        this.database?.prepare('INSERT OR REPLACE INTO mcp_schema_pauses VALUES (?, ?, ?)')
          .run(capability, next.capabilitySchemaHashes?.[capability] ?? '', new Date().toISOString());
      }
    }
    this.runRegistries.clear();
    this.discovered = true;
    this.discoveryInvalidated = false;
    this.discoveredAt = Date.now();
    return next;
  }

  private async registryForRun(runId: string, fresh: boolean, capability: SellerSpriteCapability): Promise<SellerSpriteToolRegistry> {
    if (!fresh && Date.now() >= this.registryExpiresAt) this.runRegistries.clear();
    const registryKey = `${runId}:${fresh}`;
    const existing = this.runRegistries.get(registryKey);
    if (existing) return existing;
    const previous = this.capabilityStore?.latest();
    const ttl = this.budget?.ttl('LIST_TOOLS') ?? 7 * 86400_000;
    const reusable = !fresh && !this.discoveryInvalidated
      && reusableCapabilitySnapshot(previous, [capability], ttl);
    this.registryExpiresAt = (reusable ? Date.parse(previous!.discoveredAt) : Date.now()) + ttl;
    const registry = new SellerSpriteToolRegistry(reusable ? {} : { store: this.capabilityStore });
    const discovery = registry.refresh(
      () => reusable ? Promise.resolve(previous.tools) : this.client.listTools({ fresh: true, runId }),
      reusable ? null : runId,
    ).then((next) => {
      this.discoveryInvalidated = false;
      if (!reusable && previous && this.database) {
        for (const capability of SELLERSPRITE_CAPABILITIES) {
          if (previous.capabilitySchemaHashes?.[capability] && previous.capabilitySchemaHashes[capability] !== next.capabilitySchemaHashes?.[capability]) {
            this.database.prepare('INSERT OR REPLACE INTO mcp_schema_pauses VALUES (?, ?, ?)')
              .run(capability, next.capabilitySchemaHashes?.[capability] ?? '', new Date().toISOString());
          }
        }
      }
      return registry;
    });
    this.runRegistries.set(registryKey, discovery);
    try { return await discovery; }
    catch (error) {
      if (this.runRegistries.get(registryKey) === discovery) this.runRegistries.delete(registryKey);
      throw error;
    }
  }

  private async fetchCapability<T>(
    capability: SellerSpriteCapability,
    args: Record<string, unknown> | ((registry: SellerSpriteToolRegistry) => Record<string, unknown>),
    schema: z.ZodType<T>, operation: string,
    context?: SellerSpriteSyncContext,
    validate?: (data: T) => void,
  ): Promise<SellerSpriteData<T>> {
    if (!this.injectedClient && !process.env.SELLERSPRITE_MCP_URL) {
      throw new AdapterUnavailableError('未配置 SELLERSPRITE_MCP_URL，请在服务端环境变量中设置。');
    }
    let registry = this.registry;
    const fresh = context?.syncMode ? context.syncMode !== 'incremental' : freshExecution();
    if (fresh && this.database && !freshExecution()) throw new McpPolicyError('CONFIRMATION_REQUIRED');
    if (context?.runId) {
      registry = await this.registryForRun(context.runId, fresh, capability);
    } else {
      if (!this.discovered || Date.now() - this.discoveredAt > (this.budget?.ttl('LIST_TOOLS') ?? 7 * 86400_000) || fresh) {
        const previous = this.capabilityStore?.latest();
        const reusable = !fresh && !this.discoveryInvalidated
          && reusableCapabilitySnapshot(previous, [capability], this.budget?.ttl('LIST_TOOLS') ?? 7 * 86400_000);
        if (reusable) {
          const restored = new SellerSpriteToolRegistry();
          await restored.refresh(() => Promise.resolve(previous.tools));
          registry = restored;
          this.registry = restored;
        } else await this.refreshCapabilities();
        this.discovered = true;
        this.discoveredAt = reusable ? Date.parse(previous!.discoveredAt) : Date.now();
      }
      registry ??= this.registry;
    }
    if (!fresh && this.database?.prepare('SELECT 1 FROM mcp_schema_pauses WHERE capability=?').get(capability)) {
      throw new McpPolicyError('SCHEMA_PAUSED');
    }
    const tool = registry.resolve(capability);
    if (!tool) {
      this.discoveryInvalidated = true;
      this.discovered = false;
      this.runRegistries.clear();
      throw new SellerSpriteMcpError('TOOL_NOT_FOUND', `SellerSprite capability unavailable: ${capability}`);
    }
    const resolvedArgs = typeof args === 'function' ? args(registry) : args;
    const request = resolvedArgs.request && typeof resolvedArgs.request === 'object'
      ? resolvedArgs.request as Record<string, unknown> : resolvedArgs;
    if (context?.requireObservationMonth
      && isMarketObservationCapability(capability)
      && (!registry.supportsStringArgument(capability, 'month') || !isRequestedMonth(request.month))) {
      throw new SellerSpriteMcpError(
        'INVALID_SCHEMA',
        `SellerSprite ${capability} cannot certify a requested observation month`,
      );
    }
    let toolArgs: Record<string, unknown>;
    try { toolArgs = registry.argumentsFor(capability, resolvedArgs); }
    catch {
      this.discoveryInvalidated = true;
      this.discovered = false;
      this.runRegistries.clear();
      throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite tool arguments do not match discovered schema');
    }
    const entityType = capability === 'ASIN_SALES_TREND' || capability === 'ASIN_COMPETITOR_DISCOVERY'
      || capability === 'ASIN_DETAIL'
      ? 'product' as const : 'market' as const;
    const entityId = entityType === 'product' ? request.asin : request.nodeIdPath;
    const criticalMarket = context?.requireObservationMonth === true
      && isMarketObservationCapability(capability);
    const documentedRequest = criticalMarket && Boolean(context?.runId)
      && ((capability === 'MARKET_STATISTICS' && tool.name === 'market_research_statistics')
        || (capability === 'PRODUCT_CONCENTRATION' && tool.name === 'market_product_concentration')
        || (capability === 'MARKET_RESEARCH' && tool.name === 'market_research'))
      && registry.supportsStringArgument(capability, 'month');
    const schemaHash = (!fresh && this.capabilityStore?.latest()?.capabilitySchemaHashes?.[capability])
      || sellerSpriteSchemaHash(tool.inputSchema);
    const localKey = requestKey(['sellersprite', capability, toolArgs, schemaHash]);
    const ttl = this.budget?.ttl(capability === 'ASIN_DETAIL' ? 'PENDING_IDENTITY'
      : context?.secondary && capability === 'ASIN_SALES_TREND' ? 'CORE_COMPETITOR' : capability)
      ?? 86400_000;
    const local = !fresh ? this.database?.prepare(`SELECT * FROM mcp_local_observations WHERE request_key=?
      AND (historical_stable=1 OR expires_at>?)`).get(localKey, new Date().toISOString()) as
      { payload_json: string; collected_at: string; historical_stable: number } | undefined : undefined;
    if (local) {
      let payload: unknown;
      try { payload = JSON.parse(local.payload_json); } catch { payload = null; }
      const parsed = schema.safeParse(payload);
      const effectiveTtl = capability === 'ASIN_DETAIL' && payload && typeof payload === 'object' && 'parent' in payload && payload.parent
        ? this.budget?.ttl('ASIN_DETAIL') ?? ttl : ttl;
      if (parsed.success && (local.historical_stable === 1 || Date.now() - Date.parse(local.collected_at) < effectiveTtl)) {
        validateCapabilityScope(capability, parsed.data, request, criticalMarket, documentedRequest);
        validate?.(parsed.data);
        this.budget?.record(localKey, 'local_hit');
        this.budget?.record(localKey, 'freshness_skip');
        return { data: parsed.data, provenance: { source: 'SellerSprite MCP', sourceType: 'mcp',
          collectedAt: local.collected_at, period: 'monthly', isEstimated: true, confidence: 0.75 } };
      }
    }
    const accepted = await this.client.callTool({ tool: tool.name, arguments: toolArgs, context: {
      capability, operation, entityType,
      ...(typeof entityId === 'string' ? { entityId: entityId.toUpperCase() } : {}),
      ...(isMarketObservationCapability(capability)
        && typeof request.month === 'string' ? { observationMonth: request.month } : {}),
      ...(context?.runId ? { runId: context.runId } : {}),
      fresh, schemaHash, cacheTtlMs: ttl,
      secondary: context?.secondary || capability === 'ASIN_COMPETITOR_DISCOVERY',
    } }, (result, acquisition) => {
      let payload: unknown;
      try { payload = sellerSpriteEnvelope(result); }
      catch { throw new SellerSpriteMcpError('INVALID_SCHEMA', 'Invalid SellerSprite response envelope'); }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite response does not match discovered capability');
      validateCapabilityScope(
        capability, parsed.data, request, criticalMarket, documentedRequest,
      );
      validate?.(parsed.data);
      return { value: { data: parsed.data, acquisition }, ...(criticalMarket ? {
        observationCertification: {
          method: documentedRequest ? 'documented_request_v1' as const : 'response_echo_v1' as const,
          schemaHash: sellerSpriteSchemaHash(tool.inputSchema),
        },
      } : {}) };
    }).catch((error: unknown) => {
      if (error instanceof SellerSpriteMcpError && ['TOOL_NOT_FOUND', 'INVALID_SCHEMA'].includes(error.code)) {
        this.discoveryInvalidated = true;
        this.discovered = false;
        this.runRegistries.clear();
        this.database?.prepare('INSERT OR REPLACE INTO mcp_schema_pauses VALUES (?, ?, ?)')
          .run(capability, schemaHash, new Date().toISOString());
      }
      throw error;
    });
    const stable = criticalMarket && typeof request.month === 'string'
      && request.month < new Date().toISOString().slice(0, 7).replace('-', '')
      && new Date(accepted.acquisition.acquiredAt).toISOString().slice(0, 7).replace('-', '') > request.month;
    const localTtl = capability === 'ASIN_DETAIL' && accepted.data && typeof accepted.data === 'object'
      && 'parent' in accepted.data && accepted.data.parent ? this.budget?.ttl('ASIN_DETAIL') ?? ttl : ttl;
    this.database?.prepare(`INSERT INTO mcp_local_observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_key) DO UPDATE SET payload_json=excluded.payload_json,
      collected_at=excluded.collected_at, expires_at=excluded.expires_at,
      historical_stable=excluded.historical_stable, backfill_complete=excluded.backfill_complete`)
      .run(localKey, JSON.stringify(scrubSecrets(accepted.data)), accepted.acquisition.acquiredAt,
        new Date(Date.parse(accepted.acquisition.acquiredAt) + localTtl).toISOString(), stable ? 1 : 0, stable ? 1 : 0, schemaHash,
        capability, requestKey([request.marketplace, entityId, request.month ?? null]));
    return {
      data: accepted.data,
      provenance: {
        source: 'SellerSprite MCP', sourceType: 'mcp', collectedAt: accepted.acquisition.acquiredAt,
        period: 'monthly', isEstimated: true, confidence: 0.75,
      },
    };
  }

  private async fetchMarketCapability<T>(
    capability: 'MARKET_STATISTICS' | 'PRODUCT_CONCENTRATION', input: SellerSpriteMarketRequest,
    schema: z.ZodType<T>, returnFields: string, context?: SellerSpriteSyncContext,
  ): Promise<SellerSpriteData<T>> {
    return this.fetchCapability(capability, (registry) => ({ request: {
      marketplace: input.marketplace,
      nodeIdPath: input.nodeIdPath,
      ...optionalMonth(input.month),
      ...(registry.supportsStringArgument(capability, 'returnFields') ? { returnFields } : {}),
    } }), schema, 'market_refresh', context);
  }
}

function validateCapabilityScope(
  capability: SellerSpriteCapability,
  data: unknown,
  request: Record<string, unknown>,
  requireObservationMonth = false,
  documentedRequest = false,
): void {
  if (capability === 'MARKET_STATISTICS') {
    assertRequestedScope(data as Record<string, unknown>, request);
    if (requireObservationMonth) {
      assertRequiredMarketScope(data as Record<string, unknown>, request);
      if (documentedRequest) assertDocumentedMonthIfPresent(data as Record<string, unknown>, request);
      else assertCertifiedObservationMonth(data as Record<string, unknown>, request);
    }
  } else if (capability === 'PRODUCT_CONCENTRATION' || capability === 'ASIN_COMPETITOR_DISCOVERY') {
    const items = data as Array<Record<string, unknown>>;
    if (requireObservationMonth && capability === 'PRODUCT_CONCENTRATION' && items.length === 0) {
      throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite concentration month cannot be certified');
    }
    for (const item of items) {
      if (requireObservationMonth && capability === 'PRODUCT_CONCENTRATION') {
        assertMeaningfulConcentrationItem(item);
        if (documentedRequest) {
          assertDocumentedScopeIfPresent(item, request);
          assertDocumentedMonthIfPresent(item, request);
        } else {
          assertRequiredMarketScope(item, request);
          assertCertifiedObservationMonth(item, request);
        }
      } else {
        assertRequestedScope(item, request);
      }
    }
  } else if (capability === 'MARKET_RESEARCH') {
    const research = data as { items: Array<Record<string, unknown>> } & Record<string, unknown>;
    if (requireObservationMonth) {
      if (documentedRequest) {
        assertDocumentedScopeIfPresent(research, request);
        assertDocumentedMonthIfPresent(research, request);
      } else {
        assertRequestedScope(research, request);
      }
      const target = uniqueMarketResearchItem(research.items, request);
      if (documentedRequest) assertDocumentedMonthIfPresent(target, request);
      else assertCertifiedObservationMonth(target, request);
    } else {
      assertRequestedScope(research, request);
      for (const item of research.items) assertRequestedScope(item, request);
    }
  } else if (capability === 'ASIN_SALES_TREND') {
    const trend = data as SellerSpriteAsinTrend;
    assertRequestedScope(data as Record<string, unknown>, request);
    assertRequestedScope(trend.asin, request);
    assertRequestedAsin(trend.asin, request);
    for (const point of trend.salesTrendPoints) {
      assertRequestedScope(point, request);
      assertRequestedAsin(point, request);
    }
  } else if (capability === 'ASIN_DETAIL') {
    const identity = data as SellerSpriteAsinIdentity;
    assertRequestedScope(identity, request);
    assertRequestedAsin(identity, request);
  }
}

function assertMeaningfulConcentrationItem(item: Record<string, unknown>): void {
  if (typeof item.asin !== 'string' || !/^[A-Z0-9]{10}$/i.test(item.asin.trim())) {
    throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite concentration item is missing a valid ASIN');
  }
  if (!['totalUnits', 'totalRevenue', 'totalUnitsRatio', 'totalRevenueRatio']
    .some((key) => typeof item[key] === 'number' && Number.isFinite(item[key]) && item[key] >= 0)) {
    throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite concentration item has no valid metric');
  }
}

function isMarketObservationCapability(capability: SellerSpriteCapability): boolean {
  return capability === 'MARKET_RESEARCH'
    || capability === 'MARKET_STATISTICS'
    || capability === 'PRODUCT_CONCENTRATION';
}

function uniqueMarketResearchItem(
  items: Array<Record<string, unknown>>,
  request: Pick<SellerSpriteMarketRequest, 'marketplace' | 'nodeIdPath'> | Record<string, unknown>,
): SellerSpriteMarketResearchSummary {
  const expectedMarketplace = scopeString(request.marketplace);
  const expectedNodeIdPath = scopeString(request.nodeIdPath);
  const matches = items.filter((item) => {
    const marketplace = scopeString(item.marketplace);
    const nodeIdPath = scopeString(item.nodeIdPath);
    return marketplace?.toUpperCase() === expectedMarketplace?.toUpperCase()
      && nodeIdPath === expectedNodeIdPath;
  });
  if (matches.length !== 1) {
    throw new SellerSpriteMcpError(
      'INVALID_SCHEMA', 'SellerSprite market research must contain exactly one requested market summary',
    );
  }
  return matches[0] as SellerSpriteMarketResearchSummary;
}

function assertDocumentedScopeIfPresent(
  data: Record<string, unknown>, request: Record<string, unknown>,
): void {
  for (const key of ['marketplace', 'nodeIdPath'] as const) {
    if (!Object.hasOwn(data, key) || data[key] === null || data[key] === undefined) continue;
    const actual = scopeString(data[key]);
    const expected = scopeString(request[key]);
    if (!actual || !expected || (key === 'marketplace'
      ? actual.toUpperCase() !== expected.toUpperCase() : actual !== expected)) {
      throw new SellerSpriteMcpError('INVALID_SCHEMA', `SellerSprite response ${key} does not match request`);
    }
  }
}

function assertDocumentedMonthIfPresent(
  data: Record<string, unknown>, request: Record<string, unknown>,
): void {
  if (!Object.hasOwn(data, 'month') || data.month === null || data.month === undefined) return;
  if (normalizedMonth(data.month) !== normalizedMonth(request.month)) {
    throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite response month does not match request');
  }
}

function isRequestedMonth(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{4}(0[1-9]|1[0-2])$/.test(value);
}

function assertCertifiedObservationMonth(
  data: Record<string, unknown>, request: Record<string, unknown>,
): void {
  if (request.month === undefined || data.month === undefined || data.month === null) {
    throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite response does not certify its observation month');
  }
  if (normalizedMonth(data.month) !== normalizedMonth(request.month)) {
    throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite response month does not match request');
  }
}

function assertRequestedScope(data: Record<string, unknown>, request: Record<string, unknown>): void {
  for (const key of ['marketplace', 'nodeIdPath'] as const) {
    const actual = scopeString(data[key]);
    const expected = scopeString(request[key]);
    if (actual && expected && (key === 'marketplace'
      ? actual.toUpperCase() !== expected.toUpperCase() : actual !== expected)) {
      throw new SellerSpriteMcpError('INVALID_SCHEMA', `SellerSprite response ${key} does not match request`);
    }
  }
  if (request.month !== undefined && data.month !== undefined && data.month !== null) {
    const actual = normalizedMonth(data.month);
    const expected = normalizedMonth(request.month);
    if (actual !== expected) {
      throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite response month does not match request');
    }
  }
}

function assertRequiredMarketScope(
  data: Record<string, unknown>, request: Record<string, unknown>,
): void {
  for (const key of ['marketplace', 'nodeIdPath'] as const) {
    const actual = scopeString(data[key]);
    const expected = scopeString(request[key]);
    if (!actual || !expected || (key === 'marketplace'
      ? actual.toUpperCase() !== expected.toUpperCase() : actual !== expected)) {
      throw new SellerSpriteMcpError('INVALID_SCHEMA', `SellerSprite response ${key} does not match request`);
    }
  }
}

function assertRequestedAsin(data: Record<string, unknown>, request: Record<string, unknown>): void {
  const actual = scopeString(data.asin);
  const expected = scopeString(request.asin);
  if (actual && expected && actual.toUpperCase() !== expected.toUpperCase()) {
    throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite response ASIN does not match request');
  }
}

function scopeString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite response scope is invalid');
  }
  return value.trim();
}

function normalizedMonth(value: unknown): string {
  const text = typeof value === 'number' && Number.isInteger(value) ? String(value) : scopeString(value);
  const match = text && /^(\d{4})-?(\d{2})(?:-(\d{2}))?$/.exec(text);
  if (!match) throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite response month is invalid');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = match[3] ? Number(match[3]) : 1;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite response month is invalid');
  }
  return `${match[1]}${match[2]}`;
}

function optionalMonth(month?: string): { month?: string } { return month ? { month } : {}; }
function numberOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const finite = numberOrNull(value);
    if (finite !== null) return finite;
  }
  return null;
}
function sumRatios(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) * 100; }

function identityWithFallback(
  detail: SellerSpriteAsinIdentity, trend: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...trend };
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === 'string' && value.trim()) merged[key] = value;
  }
  return merged;
}

function productFromItem(item: Record<string, unknown>, marketplace: string, marketNodeId: string, provenance: Provenance): Product {
  if (typeof item.asin !== 'string' || typeof item.title !== 'string') {
    throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite market product missing ASIN or title');
  }
  const id = `${marketplace}:${item.asin}`;
  return {
    id, asin: item.asin, brand: typeof item.brand === 'string' ? item.brand : '',
    title: item.title, imageUrl: typeof item.imageUrl === 'string' ? item.imageUrl : '',
    marketplace, productType: 'unknown', isOwned: false, marketNodeId,
    latest: {
      id: randomUUID(), snapshotAvailable: true, productId: id,
      date: observationDate(item.month),
      price: numberOrNull(item.price), rating: numberOrNull(item.rating),
      reviewCount: numberOrNull(item.ratings), bsr: numberOrNull(item.bsr),
      estimatedSales: numberOrNull(item.units), estimatedRevenue: numberOrNull(item.revenue),
      sellerCount: numberOrNull(item.sellers), growth7d: null, growth30d: null,
      growth30dAvailable: false, growth90d: null, provenance,
    },
  };
}

function observationDate(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite product missing observation date');
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value) return value;
  }
  if (/^\d{4}-\d{2}$/.test(value)) {
    const [year, month] = value.split('-').map(Number);
    if (month >= 1 && month <= 12) return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  }
  throw new SellerSpriteMcpError('INVALID_SCHEMA', 'Invalid SellerSprite observation date');
}
