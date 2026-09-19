import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Product, ProductSnapshot, Provenance } from '../../shared/types.js';
import type { AppDatabase } from '../database/database.js';
import { SellerSpriteMcpClient, SellerSpriteMcpError } from './sellersprite-mcp-client.js';
import { sellerSpriteEnvelope } from './sellersprite-mcp-schemas.js';
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

const object = z.record(z.string(), z.unknown());
const trendSchema = z.object({ asin: object, salesTrendPoints: z.array(object) }).passthrough();
const researchSchema = z.object({ items: z.array(object), total: z.number().optional() }).passthrough();

export interface SellerSpriteMarketRequest {
  marketplace: string;
  nodeIdPath: string;
  month?: string;
}

export interface SellerSpriteAsinRequest { marketplace: string; asin: string }
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
    }
    return {
      ...status,
      requiredCapabilityCount: SELLERSPRITE_CAPABILITIES.length,
      availableRequiredCapabilityCount: SELLERSPRITE_CAPABILITIES.length - missingCapabilities.length,
      missingCapabilities,
      latencyMs: Math.max(0, Date.now() - startedAt),
    };
  }

  async fetchMarketStatistics(input: SellerSpriteMarketRequest): Promise<SellerSpriteData<SellerSpriteStatistics>> {
    return this.fetchCapability('MARKET_STATISTICS', {
      request: { marketplace: input.marketplace, nodeIdPath: input.nodeIdPath, ...optionalMonth(input.month) },
    }, object, 'market_refresh');
  }

  async fetchMarketConcentration(input: SellerSpriteMarketRequest): Promise<SellerSpriteData<SellerSpriteConcentration>> {
    return this.fetchCapability('PRODUCT_CONCENTRATION', {
      request: { marketplace: input.marketplace, nodeIdPath: input.nodeIdPath, ...optionalMonth(input.month) },
    }, z.array(object), 'market_refresh');
  }

  async fetchAsinSalesTrend(input: SellerSpriteAsinRequest): Promise<SellerSpriteData<SellerSpriteAsinTrend>> {
    return this.fetchCapability('ASIN_SALES_TREND', { ...input }, trendSchema, 'owned_sku_refresh');
  }

  async discoverAsinCompetitors(
    input: SellerSpriteAsinRequest & { size?: number },
  ): Promise<SellerSpriteData<SellerSpriteCompetitorCandidates>> {
    return this.fetchCapability('ASIN_COMPETITOR_DISCOVERY', { ...input }, z.array(object), 'competitor_refresh');
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
    const { data, provenance } = await this.fetchCapability('MARKET_RESEARCH', { request }, researchSchema, 'market_refresh');
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

  async close(): Promise<void> { await this.client.close(); }

  private async fetchCapability<T>(
    capability: SellerSpriteCapability, args: Record<string, unknown>, schema: z.ZodType<T>, operation: string,
  ): Promise<SellerSpriteData<T>> {
    if (!this.injectedClient && !process.env.SELLERSPRITE_MCP_URL) {
      throw new AdapterUnavailableError('未配置 SELLERSPRITE_MCP_URL，请在服务端环境变量中设置。');
    }
    if (!this.discovered) {
      await this.registry.refresh(() => this.client.listTools());
      this.discovered = true;
    }
    const tool = this.registry.resolve(capability);
    if (!tool) throw new SellerSpriteMcpError('TOOL_NOT_FOUND', `SellerSprite capability unavailable: ${capability}`);
    let toolArgs: Record<string, unknown>;
    try { toolArgs = this.registry.argumentsFor(capability, args); }
    catch { throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite tool arguments do not match discovered schema'); }
    const request = args.request && typeof args.request === 'object'
      ? args.request as Record<string, unknown> : args;
    const entityType = capability === 'ASIN_SALES_TREND' || capability === 'ASIN_COMPETITOR_DISCOVERY'
      ? 'product' as const : 'market' as const;
    const entityId = entityType === 'product' ? request.asin : request.nodeIdPath;
    const data = await this.client.callTool({ tool: tool.name, arguments: toolArgs, context: {
      capability, operation, entityType,
      ...(typeof entityId === 'string' ? { entityId: entityId.toUpperCase() } : {}),
    } }, (result) => {
      let payload: unknown;
      try { payload = sellerSpriteEnvelope(result); }
      catch { throw new SellerSpriteMcpError('INVALID_SCHEMA', 'Invalid SellerSprite response envelope'); }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new SellerSpriteMcpError('INVALID_SCHEMA', 'SellerSprite response does not match discovered capability');
      return parsed.data;
    });
    return {
      data,
      provenance: {
        source: 'SellerSprite MCP', sourceType: 'mcp', collectedAt: new Date().toISOString(),
        period: 'monthly', isEstimated: true, confidence: 0.75,
      },
    };
  }
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
