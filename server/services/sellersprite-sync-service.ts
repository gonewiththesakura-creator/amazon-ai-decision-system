import { randomUUID } from 'node:crypto';
import type { Provenance } from '../../shared/types.js';
import type {
  SellerSpriteAsinTrend,
  SellerSpriteCompetitorCandidates,
  SellerSpriteConcentration,
  SellerSpriteData,
  SellerSpriteStatistics,
} from '../adapters/sellersprite-mcp-adapter.js';
import type { AppDatabase } from '../database/database.js';
import { transaction } from '../database/database.js';
import { ProductIdentityResolver } from '../domain/product-identity-resolver.js';

export interface SellerSpriteMarketSyncInput {
  marketId: string;
  month: string;
}

export interface SellerSpriteOwnedProductSyncInput {
  productId: string;
}

export interface SellerSpriteCompetitorDiscoveryInput {
  ownedProductId: string;
  size?: number;
}

export interface SellerSpriteCandidateConfirmationInput {
  ownedProductId: string;
  candidateId: string;
  relationType: 'direct' | 'top100' | 'benchmark' | 'fast_growth' | 'price_peer';
  reason: string;
  similarityScore?: number;
}

export interface SellerSpriteSyncPort {
  fetchMarketStatistics(input: {
    marketplace: string;
    nodeIdPath: string;
    month?: string;
  }): Promise<SellerSpriteData<SellerSpriteStatistics>>;
  fetchMarketConcentration(input: {
    marketplace: string;
    nodeIdPath: string;
    month?: string;
  }): Promise<SellerSpriteData<SellerSpriteConcentration>>;
  fetchAsinSalesTrend(input: {
    marketplace: string;
    asin: string;
  }): Promise<SellerSpriteData<SellerSpriteAsinTrend>>;
  discoverAsinCompetitors(input: {
    marketplace: string;
    asin: string;
    size?: number;
  }): Promise<SellerSpriteData<SellerSpriteCompetitorCandidates>>;
}

interface MarketRow {
  id: string;
  marketplace: string;
  categoryId: string | null;
}

interface ProductRow {
  id: string;
  asin: string;
  marketplace: string;
  marketNodeId: string;
}

interface PreparedMarketObservation {
  market: MarketRow;
  observationDate: string;
  provenance: Provenance;
  metrics: Record<MarketMetric, number | null>;
  concentration: Array<Record<string, string | number | null>>;
}

interface PreparedProductObservation {
  product: ProductRow;
  parentAsin: string | null;
  provenance: Provenance;
  points: Array<{
    observationDate: string;
    price: number | null;
    rating: number | null;
    reviewCount: number | null;
    bsr: number | null;
    estimatedSales: number | null;
    estimatedRevenue: number | null;
    sellerCount: number | null;
  }>;
}

type MarketMetric =
  | 'productCount'
  | 'sellerCount'
  | 'brandCount'
  | 'monthlySales'
  | 'monthlyRevenue'
  | 'avgPrice'
  | 'medianPrice'
  | 'avgRating'
  | 'medianReviews'
  | 'top10Share'
  | 'top20Share'
  | 'newProductShare';

const MARKET_METRIC_COLUMNS: Record<MarketMetric, string> = {
  productCount: 'product_count',
  sellerCount: 'seller_count',
  brandCount: 'brand_count',
  monthlySales: 'monthly_sales',
  monthlyRevenue: 'monthly_revenue',
  avgPrice: 'avg_price',
  medianPrice: 'median_price',
  avgRating: 'avg_rating',
  medianReviews: 'median_reviews',
  top10Share: 'top10_share',
  top20Share: 'top20_share',
  newProductShare: 'new_product_share',
};

const PRODUCT_METRICS = [
  'price', 'rating', 'reviewCount', 'bsr', 'estimatedSales', 'estimatedRevenue', 'sellerCount',
] as const;

const SOURCE_ID = 'source-sellersprite-mcp';

export class SellerSpriteSyncService {
  private readonly identityResolver: ProductIdentityResolver;

  constructor(
    private readonly database: AppDatabase,
    private readonly port: SellerSpriteSyncPort,
  ) {
    this.identityResolver = new ProductIdentityResolver(database);
  }

  async syncMarket(input: SellerSpriteMarketSyncInput): Promise<{ inserted: number }> {
    const prepared = await this.prepareMarket(input);
    return transaction(this.database, () => ({ inserted: this.persistMarket(prepared) }));
  }

  async syncOwnedProduct(input: SellerSpriteOwnedProductSyncInput): Promise<{ inserted: number }> {
    const prepared = await this.prepareOwnedProduct(input.productId);
    return transaction(this.database, () => ({ inserted: this.persistProduct(prepared) }));
  }

  async discoverCompetitors(
    input: SellerSpriteCompetitorDiscoveryInput,
  ): Promise<{ candidates: number }> {
    const product = this.requireOwnedProduct(input.ownedProductId);
    const response = await this.port.discoverAsinCompetitors({
      marketplace: product.marketplace,
      asin: product.asin,
      ...(input.size === undefined ? {} : { size: input.size }),
    });
    const candidates = response.data
      .map((candidate) => normalizeCandidate(candidate))
      .filter((candidate): candidate is NonNullable<typeof candidate> => (
        candidate !== null && candidate.asin !== product.asin.toUpperCase()
      ));

    return transaction(this.database, () => {
      let inserted = 0;
      const statement = this.database.prepare(`
        INSERT OR IGNORE INTO competitor_candidates (
          id, marketplace, asin, source_product_id, source, source_type,
          payload_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'mcp', ?, 'pending_review', ?)
      `);
      for (const candidate of candidates) {
        const result = statement.run(
          randomUUID(), product.marketplace, candidate.asin, product.id,
          response.provenance.source, JSON.stringify(candidate.payload),
          response.provenance.collectedAt,
        );
        inserted += Number(result.changes);
      }
      return { candidates: inserted };
    });
  }

  confirmCompetitorCandidate(input: SellerSpriteCandidateConfirmationInput): {
    ownedProductId: string;
    competitorProductId: string;
    relationType: SellerSpriteCandidateConfirmationInput['relationType'];
  } {
    const owned = this.requireOwnedProduct(input.ownedProductId);
    const candidate = this.database.prepare(`
      SELECT id, asin, marketplace, payload_json AS payloadJson, status
      FROM competitor_candidates
      WHERE id = ? AND source_product_id = ?
    `).get(input.candidateId, owned.id) as {
      id: string;
      asin: string;
      marketplace: string;
      payloadJson: string;
      status: string;
    } | undefined;
    if (!candidate) throw new Error('竞争候选不存在。');
    if (candidate.marketplace !== owned.marketplace) throw new Error('竞争候选站点不匹配。');
    if (candidate.status !== 'pending_review') throw new Error('竞争候选已经处理。');
    const payload = safeJsonObject(candidate.payloadJson);

    return transaction(this.database, () => {
      const resolution = this.identityResolver.resolve({
        marketplace: owned.marketplace,
        asin: candidate.asin,
        parentAsin: stringOrNull(payload.parentAsin) ?? undefined,
      });
      if (!resolution.productId) throw new Error('竞争候选产品身份创建失败。');
      if (resolution.productId === owned.id) throw new Error('自有产品不能确认成自身竞品。');
      this.database.prepare(`
        UPDATE products
        SET brand = ?, title = ?, product_type = 'competitor', market_node_id = ?,
          source_type = 'mcp', updated_at = ?
        WHERE id = ? AND is_owned = 0
      `).run(
        stringOrNull(payload.brand) ?? '未知品牌',
        stringOrNull(payload.title) ?? candidate.asin,
        owned.marketNodeId,
        new Date().toISOString(),
        resolution.productId,
      );
      this.database.prepare(`
        INSERT INTO competitor_relations (
          id, owned_product_id, competitor_product_id, relation_type,
          similarity_score, reason, ai_tags_json, created_at, last_verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)
      `).run(
        randomUUID(), owned.id, resolution.productId, input.relationType,
        input.similarityScore ?? 0, input.reason,
        new Date().toISOString(), new Date().toISOString(),
      );
      this.database.prepare(`
        UPDATE competitor_candidates SET status = 'confirmed', reviewed_at = ? WHERE id = ?
      `).run(new Date().toISOString(), candidate.id);
      return {
        ownedProductId: owned.id,
        competitorProductId: resolution.productId,
        relationType: input.relationType,
      };
    });
  }

  async syncCriticalBatch(input: SellerSpriteMarketSyncInput): Promise<{
    marketSnapshots: number;
    productSnapshots: number;
  }> {
    // Network work deliberately completes before BEGIN IMMEDIATE. A remote error can
    // never leave a half-written critical batch or hold the database write lock.
    const preparedMarket = await this.prepareMarket(input);
    const products = this.database.prepare(`
      SELECT id
      FROM products
      WHERE marketplace = ? AND is_owned = 1 AND status = 'active'
      ORDER BY id
    `).all(preparedMarket.market.marketplace) as Array<{ id: string }>;
    const preparedProducts: PreparedProductObservation[] = [];
    for (const product of products) preparedProducts.push(await this.prepareOwnedProduct(product.id));

    return transaction(this.database, () => {
      const marketSnapshots = this.persistMarket(preparedMarket);
      let productSnapshots = 0;
      for (const product of preparedProducts) productSnapshots += this.persistProduct(product);
      this.database.prepare(`
        INSERT INTO data_coverage_runs (
          id, marketplace, run_type, coverage_json, is_complete, created_at
        ) VALUES (?, ?, 'critical_sync', ?, 1, ?)
      `).run(
        randomUUID(), preparedMarket.market.marketplace,
        JSON.stringify({
          marketId: preparedMarket.market.id,
          marketSnapshots,
          activeOwnedProducts: preparedProducts.length,
          productSnapshots,
        }),
        new Date().toISOString(),
      );
      return { marketSnapshots, productSnapshots };
    });
  }

  private async prepareMarket(input: SellerSpriteMarketSyncInput): Promise<PreparedMarketObservation> {
    const market = this.requireMarket(input.marketId);
    const observationDate = monthEnd(input.month);
    const request = {
      marketplace: market.marketplace,
      nodeIdPath: market.categoryId ?? market.id,
      month: compactMonth(input.month),
    };
    const [statistics, concentration] = await Promise.all([
      this.port.fetchMarketStatistics(request),
      this.port.fetchMarketConcentration(request),
    ]);
    ensureCompatibleProvenance(statistics.provenance, concentration.provenance);

    const normalizedConcentration = concentration.data.map((item) => ({
      asin: stringOrNull(item.asin),
      title: stringOrNull(item.title),
      brand: stringOrNull(item.brand),
      price: finiteNumber(item.price),
      rating: finiteNumber(item.rating),
      ratings: finiteNumber(item.ratings),
      totalUnits: finiteNumber(item.totalUnits),
      totalRevenue: finiteNumber(item.totalRevenue),
      totalUnitsRatio: finiteNumber(item.totalUnitsRatio),
      totalRevenueRatio: finiteNumber(item.totalRevenueRatio),
    }));
    const prices = compactNumbers(normalizedConcentration.map((item) => item.price));
    const reviews = compactNumbers(normalizedConcentration.map((item) => item.ratings));
    const units = compactNumbers(normalizedConcentration.map((item) => item.totalUnits));
    const revenues = compactNumbers(normalizedConcentration.map((item) => item.totalRevenue));
    const ratios = compactNumbers(normalizedConcentration.map((item) => item.totalUnitsRatio));
    const data = statistics.data;
    const metrics: Record<MarketMetric, number | null> = {
      productCount: finiteNumber(data.products),
      sellerCount: finiteNumber(data.sellers),
      brandCount: finiteNumber(data.brands),
      monthlySales: units.length > 0 ? sum(units) : finiteNumber(data.totalUnits),
      monthlyRevenue: revenues.length > 0 ? sum(revenues) : finiteNumber(data.totalRevenue),
      avgPrice: finiteNumber(data.avgPrice) ?? average(prices),
      medianPrice: finiteNumber(data.medianPrice) ?? median(prices),
      avgRating: finiteNumber(data.avgRating),
      medianReviews: finiteNumber(data.medianReviews) ?? median(reviews),
      top10Share: sharePercent(ratios.slice(0, 10)),
      top20Share: sharePercent(ratios.slice(0, 20)),
      newProductShare: finiteNumber(data.newProductShare ?? data.newProductProportion),
    };
    return {
      market,
      observationDate,
      provenance: statistics.provenance,
      metrics,
      concentration: normalizedConcentration,
    };
  }

  private async prepareOwnedProduct(productId: string): Promise<PreparedProductObservation> {
    const product = this.requireOwnedProduct(productId);
    const response = await this.port.fetchAsinSalesTrend({
      marketplace: product.marketplace,
      asin: product.asin,
    });
    const info = response.data.asin;
    const remoteAsin = stringOrNull(info.asin)?.toUpperCase();
    if (remoteAsin && remoteAsin !== product.asin.toUpperCase()) {
      throw new Error('SellerSprite 返回的 ASIN 与请求产品不一致。');
    }
    const points = response.data.salesTrendPoints.map((point) => ({
      observationDate: monthEnd(requiredString(point.month, '销售趋势月份')),
      price: finiteNumber(point.price) ?? finiteNumber(info.price),
      rating: finiteNumber(point.rating) ?? finiteNumber(info.rating),
      reviewCount: finiteNumber(point.ratings) ?? finiteNumber(info.ratings),
      bsr: finiteNumber(point.bsr ?? point.bsrRank ?? info.bsr ?? info.bsrRank),
      estimatedSales: finiteNumber(point.childUnitSales) ?? finiteNumber(point.parentUnitSales),
      estimatedRevenue: finiteNumber(point.childSalesRevenue) ?? finiteNumber(point.parentSalesRevenue),
      sellerCount: finiteNumber(point.sellers) ?? finiteNumber(info.sellers),
    }));
    if (points.length === 0) throw new Error('SellerSprite 未返回产品历史观察。');
    return {
      product,
      parentAsin: stringOrNull(info.parent)?.toUpperCase() ?? null,
      provenance: response.provenance,
      points,
    };
  }

  private persistMarket(prepared: PreparedMarketObservation): number {
    const { market, metrics, observationDate, provenance } = prepared;
    const dedupKey = snapshotDedupKey('market', market.marketplace, market.id, observationDate, provenance);
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO market_snapshots (
        id, market_node_id, date, product_count, seller_count, brand_count,
        monthly_sales, monthly_revenue, avg_price, median_price, avg_rating,
        median_reviews, top10_share, top20_share, new_product_share,
        price_bands_json, concentration_json, source, source_type, collected_at,
        period, is_estimated, confidence, observation_date, dedup_key
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 'mcp', ?, ?, ?, ?, ?, ?
      )
    `).run(
      randomUUID(), market.id, observationDate, metrics.productCount, metrics.sellerCount,
      metrics.brandCount, metrics.monthlySales, metrics.monthlyRevenue, metrics.avgPrice,
      metrics.medianPrice, metrics.avgRating, metrics.medianReviews, metrics.top10Share,
      metrics.top20Share, metrics.newProductShare, JSON.stringify(prepared.concentration),
      provenance.source, provenance.collectedAt, provenance.period,
      provenance.isEstimated ? 1 : 0, provenance.confidence, observationDate, dedupKey,
    );
    for (const metric of Object.keys(MARKET_METRIC_COLUMNS) as MarketMetric[]) {
      this.persistFact('market', market.id, market.marketplace, metric, metrics[metric], observationDate, provenance);
    }
    return Number(result.changes);
  }

  private persistProduct(prepared: PreparedProductObservation): number {
    if (prepared.parentAsin) {
      this.identityResolver.resolve({
        marketplace: prepared.product.marketplace,
        asin: prepared.product.asin,
        parentAsin: prepared.parentAsin,
      });
    }
    let inserted = 0;
    const statement = this.database.prepare(`
      INSERT OR IGNORE INTO product_snapshots (
        id, product_id, date, price, rating, review_count, bsr, estimated_sales,
        estimated_revenue, seller_count, growth_7d, growth_30d, growth_90d,
        source, source_type, collected_at, period, is_estimated, confidence,
        observation_date, dedup_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 'mcp', ?, ?, ?, ?, ?, ?)
    `);
    for (const point of prepared.points) {
      const dedupKey = snapshotDedupKey(
        'product', prepared.product.marketplace, prepared.product.id,
        point.observationDate, prepared.provenance,
      );
      const result = statement.run(
        randomUUID(), prepared.product.id, point.observationDate, point.price, point.rating,
        point.reviewCount, point.bsr, point.estimatedSales, point.estimatedRevenue,
        point.sellerCount, prepared.provenance.source, prepared.provenance.collectedAt,
        prepared.provenance.period, prepared.provenance.isEstimated ? 1 : 0,
        prepared.provenance.confidence, point.observationDate, dedupKey,
      );
      inserted += Number(result.changes);
      for (const metric of PRODUCT_METRICS) {
        this.persistFact(
          'product', prepared.product.id, prepared.product.marketplace, metric,
          point[metric], point.observationDate, prepared.provenance,
        );
      }
    }
    return inserted;
  }

  private persistFact(
    entityType: 'market' | 'product', entityId: string, marketplace: string,
    metricName: string, value: number | null, observationDate: string, provenance: Provenance,
  ): void {
    const period = normalizeKeyPart(provenance.period);
    const dedupKey = [
      'fact', entityType, normalizeKeyPart(marketplace), entityId, metricName,
      observationDate, SOURCE_ID, period,
    ].join('|');
    this.database.prepare(`
      INSERT OR IGNORE INTO metric_facts (
        id, entity_type, entity_id, marketplace, metric_name, numeric_value,
        source, source_id, source_type, is_estimated, confidence,
        observation_date, collected_at, dedup_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'mcp', ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), entityType, entityId, marketplace, metricName, value,
      provenance.source, SOURCE_ID, provenance.isEstimated ? 1 : 0,
      provenance.confidence, observationDate, provenance.collectedAt, dedupKey,
    );
  }

  private requireMarket(marketId: string): MarketRow {
    const row = this.database.prepare(`
      SELECT id, marketplace, category_id AS categoryId
      FROM market_nodes WHERE id = ?
    `).get(marketId) as MarketRow | undefined;
    if (!row) throw new Error(`市场不存在：${marketId}`);
    return row;
  }

  private requireOwnedProduct(productId: string): ProductRow {
    const row = this.database.prepare(`
      SELECT id, asin, marketplace, market_node_id AS marketNodeId
      FROM products
      WHERE id = ? AND is_owned = 1 AND status = 'active'
    `).get(productId) as ProductRow | undefined;
    if (!row) throw new Error(`启用中的自有产品不存在：${productId}`);
    return row;
  }
}

function normalizeCandidate(candidate: Record<string, unknown>): {
  asin: string;
  payload: Record<string, string | number | null>;
} | null {
  const asin = stringOrNull(candidate.asin)?.trim().toUpperCase();
  if (!asin) return null;
  return {
    asin,
    payload: {
      asin,
      parentAsin: stringOrNull(candidate.parent),
      title: stringOrNull(candidate.title),
      brand: stringOrNull(candidate.brand),
      price: finiteNumber(candidate.price),
      units: finiteNumber(candidate.units),
      revenue: finiteNumber(candidate.revenue),
      rating: finiteNumber(candidate.rating),
      ratings: finiteNumber(candidate.ratings),
    },
  };
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function snapshotDedupKey(
  entityType: 'market' | 'product', marketplace: string, entityId: string,
  observationDate: string, provenance: Provenance,
): string {
  return [
    entityType, normalizeKeyPart(marketplace), entityId, observationDate,
    SOURCE_ID, normalizeKeyPart(provenance.period),
  ].join('|');
}

function ensureCompatibleProvenance(left: Provenance, right: Provenance): void {
  if (left.sourceType !== 'mcp' || right.sourceType !== 'mcp') {
    throw new Error('SellerSprite 同步只能持久化 MCP 来源数据。');
  }
  if (left.source !== right.source) throw new Error('SellerSprite 市场响应来源不一致。');
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label}缺失。`);
  return value.trim();
}

function compactMonth(value: string): string {
  const normalized = value.trim();
  if (/^\d{6}$/.test(normalized)) {
    monthEnd(normalized);
    return normalized;
  }
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(normalized);
  if (!match) throw new Error('月份必须使用 YYYYMM、YYYY-MM 或 YYYY-MM-DD。');
  monthEnd(normalized);
  return `${match[1]}${match[2]}`;
}

function monthEnd(value: string): string {
  const normalized = value.trim();
  const match = /^(\d{4})(?:-)?(\d{2})(?:-\d{2})?$/.exec(normalized);
  if (!match) throw new Error('月份必须使用 YYYYMM、YYYY-MM 或 YYYY-MM-DD。');
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error('月份超出有效范围。');
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function compactNumbers(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value !== null);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: number[]): number | null {
  return values.length > 0 ? sum(values) / values.length : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]!
    : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function sharePercent(values: number[]): number | null {
  if (values.length === 0) return null;
  const total = sum(values);
  return values.every((value) => Math.abs(value) <= 1) ? total * 100 : total;
}

function normalizeKeyPart(value: string): string {
  return value.trim().toLowerCase();
}
