import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Product, ProductSnapshot, Provenance } from '../../shared/types.js';
import type { AppDatabase } from '../database/database.js';
import { SellerSpriteMcpClient, SellerSpriteMcpError } from './sellersprite-mcp-client.js';
import {
  sellerSpriteAsinTrendSchema,
  sellerSpriteEnvelope,
  sellerSpriteMarketResearchSchema,
  sellerSpriteMarketStatisticsSchema,
  sellerSpriteObjectSchema,
} from './sellersprite-mcp-schemas.js';
import {
  SqliteMcpCallLedgerStore, SqliteMcpCapabilityStore, SqliteMcpResponseCacheStore,
} from './sellersprite-mcp-store.js';
import {
  SELLERSPRITE_CAPABILITIES,
  SellerSpriteToolRegistry,
  type SellerSpriteCapability,
} from './sellersprite-tool-registry.js';
import type {
  KeywordDataRecord, KeywordInput, MarketDataAdapter, MarketInput,
  MarketOverviewRecord, ProductDetailRecord, ProductInput,
} from './types.js';
import { AdapterUnavailableError } from './types.js';

const object = sellerSpriteObjectSchema;

export interface SellerSpriteMarketRequest {
  marketplace: string;
  nodeIdPath: string;
  month?: string;
}

export interface SellerSpriteAsinRequest { marketplace: string; asin: string }
export interface SellerSpriteSyncContext {
  runId?: string;
  requireObservationMonth?: boolean;
}
export type SellerSpriteData<T> = { data: T; provenance: Provenance };
export type SellerSpriteStatistics = Record<string, unknown>;
export type SellerSpriteConcentration = Array<Record<string, unknown>>;
export type SellerSpriteAsinTrend = {
  asin: Record<string, unknown>;
  salesTrendPoints: Array<Record<string, unknown>>;
};
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
  private readonly registry: SellerSpriteToolRegistry;
  private readonly injectedClient: boolean;
  private discovered = false;
  private discoveredRunId: string | null = null;

  constructor(options: {
    client?: SellerSpriteMcpClient;
    registry?: SellerSpriteToolRegistry;
    database?: AppDatabase;
  } = {}) {
    this.client = options.client ?? new SellerSpriteMcpClient(options.database ? {
      ledgerStore: new SqliteMcpCallLedgerStore(options.database),
      cacheStore: new SqliteMcpResponseCacheStore(options.database),
    } : {});
    this.registry = options.registry ?? new SellerSpriteToolRegistry(options.database
      ? { store: new SqliteMcpCapabilityStore(options.database) } : {});
    this.injectedClient = Boolean(options.client);
  }

  async testConnection(): Promise<SellerSpriteConnectionDiagnostics> {
    const startedAt = Date.now();
    const status = await this.client.connectionTest();
    let missingCapabilities = [...SELLERSPRITE_CAPABILITIES] as SellerSpriteCapability[];
    if (status.connected) {
      await this.registry.refresh(() => this.client.listTools());
      missingCapabilities = this.registry.missing();
      this.discovered = true;
      this.discoveredRunId = null;
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
    return this.fetchCapability('MARKET_STATISTICS', {
      request: { marketplace: input.marketplace, nodeIdPath: input.nodeIdPath, ...optionalMonth(input.month) },
    }, sellerSpriteMarketStatisticsSchema, 'market_refresh', context);
  }

  async fetchMarketConcentration(
    input: SellerSpriteMarketRequest, context?: SellerSpriteSyncContext,
  ): Promise<SellerSpriteData<SellerSpriteConcentration>> {
    return this.fetchCapability('PRODUCT_CONCENTRATION', {
      request: { marketplace: input.marketplace, nodeIdPath: input.nodeIdPath, ...optionalMonth(input.month) },
    }, z.array(object), 'market_refresh', context);
  }

  async fetchAsinSalesTrend(
    input: SellerSpriteAsinRequest, context?: SellerSpriteSyncContext,
  ): Promise<SellerSpriteData<SellerSpriteAsinTrend>> {
    return this.fetchCapability(
      'ASIN_SALES_TREND', { ...input }, sellerSpriteAsinTrendSchema, 'owned_sku_refresh', context,
    );
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
      'medianPrice', 'avgRating', 'medianReviews', 'newProductShare',
    ] as const;
    const missing = required.filter((key) => typeof data[key] !== 'number');
    if (missing.length > 0) {
      throw new SellerSpriteMcpError('INVALID_SCHEMA', `SellerSprite overview missing required metrics: ${missing.join(', ')}`);
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
      newProductShare: data.newProductShare as number,
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
    const { data, provenance } = await this.fetchAsinSalesTrend(input);
    const info = data.asin;
    const latest = data.salesTrendPoints.at(-1);
    if (typeof info.asin !== 'string' || typeof info.title !== 'string' || !latest || typeof latest.month !== 'string') {
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
    this.discoveredRunId = null;
  }

  private async fetchCapability<T>(
    capability: SellerSpriteCapability, args: Record<string, unknown>, schema: z.ZodType<T>, operation: string,
    context?: SellerSpriteSyncContext,
  ): Promise<SellerSpriteData<T>> {
    if (!this.injectedClient && !process.env.SELLERSPRITE_MCP_URL) {
      throw new AdapterUnavailableError('未配置 SELLERSPRITE_MCP_URL，请在服务端环境变量中设置。');
    }
    if (!this.discovered || (context?.runId !== undefined && this.discoveredRunId !== context.runId)) {
      await this.registry.refresh(
        () => this.client.listTools({ fresh: true, runId: context?.runId }),
        context?.runId ?? null,
      );
      this.discovered = true;
      this.discoveredRunId = context?.runId ?? null;
    }
    const tool = this.registry.resolve(capability);
    if (!tool) throw new SellerSpriteMcpError('TOOL_NOT_FOUND', `SellerSprite capability unavailable: ${capability}`);
    const request = args.request && typeof args.request === 'object'
      ? args.request as Record<string, unknown> : args;
    if (context?.requireObservationMonth
      && (capability === 'MARKET_STATISTICS' || capability === 'PRODUCT_CONCENTRATION')
      && (!this.registry.supportsArgument(capability, 'month') || request.month === undefined)) {
      throw new SellerSpriteMcpError(
        'INVALID_SCHEMA',
        `SellerSprite ${capability} cannot certify a requested observation month`,
      );
    }
    let toolArgs: Record<string, unknown>;
    try { toolArgs = this.registry.argumentsFor(capability, args); }
    catch { throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite tool arguments do not match discovered schema'); }
    const entityType = capability === 'ASIN_SALES_TREND' || capability === 'ASIN_COMPETITOR_DISCOVERY'
      ? 'product' as const : 'market' as const;
    const entityId = entityType === 'product' ? request.asin : request.nodeIdPath;
    const accepted = await this.client.callTool({ tool: tool.name, arguments: toolArgs, context: {
      capability, operation, entityType,
      ...(typeof entityId === 'string' ? { entityId: entityId.toUpperCase() } : {}),
      ...(context?.runId ? { runId: context.runId } : {}),
      ...(context?.runId ? { fresh: true } : {}),
    } }, (result, acquisition) => {
      let payload: unknown;
      try { payload = sellerSpriteEnvelope(result); }
      catch { throw new SellerSpriteMcpError('INVALID_SCHEMA', 'Invalid SellerSprite response envelope'); }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite response does not match discovered capability');
      validateCapabilityScope(
        capability, parsed.data, request, context?.requireObservationMonth === true,
      );
      return { data: parsed.data, acquisition };
    });
    return {
      data: accepted.data,
      provenance: {
        source: 'SellerSprite MCP', sourceType: 'mcp', collectedAt: accepted.acquisition.acquiredAt,
        period: 'monthly', isEstimated: true, confidence: 0.75,
      },
    };
  }
}

function validateCapabilityScope(
  capability: SellerSpriteCapability,
  data: unknown,
  request: Record<string, unknown>,
  requireObservationMonth = false,
): void {
  if (capability === 'MARKET_STATISTICS') {
    assertRequestedScope(data as Record<string, unknown>, request);
    if (requireObservationMonth) {
      assertCertifiedObservationMonth(data as Record<string, unknown>, request);
    }
  } else if (capability === 'PRODUCT_CONCENTRATION' || capability === 'ASIN_COMPETITOR_DISCOVERY') {
    const items = data as Array<Record<string, unknown>>;
    if (requireObservationMonth && capability === 'PRODUCT_CONCENTRATION' && items.length === 0) {
      throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite concentration month cannot be certified');
    }
    for (const item of items) {
      assertRequestedScope(item, request);
      if (requireObservationMonth && capability === 'PRODUCT_CONCENTRATION') {
        assertCertifiedObservationMonth(item, request);
      }
    }
  } else if (capability === 'MARKET_RESEARCH') {
    const research = data as { items: Array<Record<string, unknown>> } & Record<string, unknown>;
    assertRequestedScope(research, request);
    for (const item of research.items) assertRequestedScope(item, request);
  } else if (capability === 'ASIN_SALES_TREND') {
    const trend = data as SellerSpriteAsinTrend;
    assertRequestedScope(data as Record<string, unknown>, request);
    assertRequestedScope(trend.asin, request);
    assertRequestedAsin(trend.asin, request);
    for (const point of trend.salesTrendPoints) {
      assertRequestedScope(point, request);
      assertRequestedAsin(point, request);
    }
  }
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
function sumRatios(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) * 100; }

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
