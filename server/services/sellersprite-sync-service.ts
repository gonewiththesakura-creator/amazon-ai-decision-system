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
import { sanitizeMcpError } from '../adapters/sellersprite-mcp-client.js';

export interface SellerSpriteMarketSyncInput {
  marketId: string;
  month: string;
}

export interface SellerSpriteOwnedProductSyncInput {
  productId: string;
}

export interface SellerSpriteConfirmedCompetitorSyncInput {
  ownedProductId: string;
  competitorProductId: string;
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

export interface SellerSpriteCandidateReviewInput {
  ownedProductId: string;
  candidateId: string;
}

export interface SellerSpriteCandidateSummary {
  id: string;
  asin: string;
  status: 'pending_review' | 'confirmed' | 'rejected';
  title: string | null;
  brand: string | null;
  price: number | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface SellerSpriteCompetitorCoverage {
  taskId: string;
  status: 'success' | 'partial' | 'failed';
  total: number;
  success: number;
  failed: number;
}

export interface SellerSpriteCandidateCoverage extends SellerSpriteCompetitorCoverage {
  candidates: number;
}

export interface SellerSpriteCandidateDiscoveryResult {
  runId: string;
  taskId: string;
  candidates: number;
}

interface SellerSpriteTrackedSyncResult {
  runId: string;
  taskId: string;
  inserted: number;
}

export interface SellerSpriteSyncPort {
  fetchMarketStatistics(input: {
    marketplace: string;
    nodeIdPath: string;
    month?: string;
  }, context?: { runId?: string; requireObservationMonth?: boolean }): Promise<SellerSpriteData<SellerSpriteStatistics>>;
  fetchMarketConcentration(input: {
    marketplace: string;
    nodeIdPath: string;
    month?: string;
  }, context?: { runId?: string; requireObservationMonth?: boolean }): Promise<SellerSpriteData<SellerSpriteConcentration>>;
  fetchAsinSalesTrend(input: {
    marketplace: string;
    asin: string;
  }, context?: { runId?: string }): Promise<SellerSpriteData<SellerSpriteAsinTrend>>;
  discoverAsinCompetitors(input: {
    marketplace: string;
    asin: string;
    size?: number;
  }, context?: { runId?: string }): Promise<SellerSpriteData<SellerSpriteCompetitorCandidates>>;
}

interface MarketRow {
  id: string;
  marketplace: string;
  sellerSpriteNodePath: string;
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
const PRODUCT_METRIC_COLUMNS: Record<typeof PRODUCT_METRICS[number], string> = {
  price: 'price', rating: 'rating', reviewCount: 'review_count', bsr: 'bsr',
  estimatedSales: 'estimated_sales', estimatedRevenue: 'estimated_revenue',
  sellerCount: 'seller_count',
};

const SOURCE_ID = 'source-sellersprite-mcp';

export class SellerSpriteSyncService {
  private readonly identityResolver: ProductIdentityResolver;

  constructor(
    private readonly database: AppDatabase,
    private readonly port: SellerSpriteSyncPort,
  ) {
    this.identityResolver = new ProductIdentityResolver(database);
  }

  async syncMarket(input: SellerSpriteMarketSyncInput): Promise<SellerSpriteTrackedSyncResult> {
    const market = this.requireMarket(input.marketId);
    compactMonth(input.month);
    return this.runTrackedObservationSync({
      name: 'SellerSprite 市场同步', taskType: 'market_refresh', target: market.id,
      marketplace: market.marketplace,
    }, async (runId) => {
      const prepared = await this.prepareMarket(input, runId);
      return () => {
        const current = this.requireMarket(market.id);
        if (current.marketplace !== market.marketplace
          || current.sellerSpriteNodePath !== market.sellerSpriteNodePath) {
          throw new Error('市场节点在同步期间发生变化，请重新运行。');
        }
        return this.persistMarket(prepared, runId);
      };
    });
  }

  async syncOwnedProduct(input: SellerSpriteOwnedProductSyncInput): Promise<SellerSpriteTrackedSyncResult> {
    const product = this.requireOwnedProduct(input.productId);
    return this.runTrackedObservationSync({
      name: 'SellerSprite 自有 SKU 同步', taskType: 'owned_sku_refresh', target: product.id,
      marketplace: product.marketplace,
    }, async (runId) => {
      const prepared = await this.prepareProduct(product, runId);
      return () => {
        const current = this.requireOwnedProduct(product.id);
        if (current.asin !== product.asin || current.marketplace !== product.marketplace
          || current.marketNodeId !== product.marketNodeId) {
          throw new Error('自有产品身份或市场节点在同步期间发生变化，请重新运行。');
        }
        return this.persistProduct(prepared, 'product', runId);
      };
    });
  }

  async syncConfirmedCompetitor(
    input: SellerSpriteConfirmedCompetitorSyncInput,
  ): Promise<SellerSpriteTrackedSyncResult> {
    const product = this.requireConfirmedCompetitor(input);
    return this.runTrackedObservationSync({
      name: 'SellerSprite 已确认竞品同步', taskType: 'competitor_refresh', target: product.id,
      marketplace: product.marketplace,
    }, async (runId) => {
      const prepared = await this.prepareProduct(product, runId);
      return () => {
        const current = this.requireConfirmedCompetitor(input);
        if (current.asin !== product.asin || current.marketplace !== product.marketplace
          || current.marketNodeId !== product.marketNodeId) {
          throw new Error('竞品身份或市场节点在同步期间发生变化，请重新请求。');
        }
        return this.persistProduct(prepared, 'competitor', runId);
      };
    });
  }

  async discoverCompetitors(
    input: SellerSpriteCompetitorDiscoveryInput,
  ): Promise<SellerSpriteCandidateDiscoveryResult> {
    const product = this.requireOwnedProduct(input.ownedProductId);
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO data_tasks (
        id, sync_run_id, name, source_id, task_type, target, source, marketplace,
        status, started_at, total, success, failed, created_at
      ) VALUES (?, ?, 'SellerSprite 竞品候选发现', ?, 'competitor_discovery', ?,
        'SellerSprite MCP', ?, 'running', ?, 1, 0, 0, ?)
    `).run(runId, runId, SOURCE_ID, product.id, product.marketplace, startedAt, startedAt);
    try {
      const result = await this.discoverCompetitorsForProduct(
        product, input.size, runId, () => {
          const completedAt = new Date().toISOString();
          const update = this.database.prepare(`
            UPDATE data_tasks SET status = 'success', completed_at = ?, success = 1
            WHERE id = ? AND sync_run_id = ? AND task_type = 'competitor_discovery'
              AND status = 'running'
          `).run(completedAt, runId, runId);
          if (update.changes !== 1) throw new Error('SellerSprite 竞品候选任务状态发生冲突。');
        },
      );
      return { runId, taskId: runId, candidates: result.candidates };
    } catch (error) {
      const completedAt = new Date().toISOString();
      transaction(this.database, () => {
        this.database.prepare(`
          UPDATE data_tasks SET status = 'failed', failed = 1, completed_at = ?, error_log = ?
          WHERE id = ? AND sync_run_id = ? AND task_type = 'competitor_discovery'
            AND status = 'running'
        `).run(
          completedAt,
          'SellerSprite 竞品候选发现失败；本次未更新候选，请检查连接和数据范围。',
          runId,
          runId,
        );
      });
      throw new Error(sanitizeMcpError(error));
    }
  }

  private async discoverCompetitorsForProduct(
    product: ProductRow,
    size: number | undefined,
    runId: string,
    complete?: () => void,
  ): Promise<{ candidates: number }> {
    const response = await this.port.discoverAsinCompetitors({
      marketplace: product.marketplace,
      asin: product.asin,
      ...(size === undefined ? {} : { size }),
    }, { runId });
    ensureMcpProvenance(response.provenance);
    const normalized = response.data
      .map((candidate) => {
        ensureResponseScope(candidate, product.marketplace);
        return normalizeCandidate(candidate);
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => (
        candidate !== null && candidate.asin !== product.asin.toUpperCase()
      ));
    const candidates = [...new Map(normalized.map((candidate) => [candidate.asin, candidate])).values()];

    return transaction(this.database, () => {
      const current = this.requireOwnedProduct(product.id);
      if (current.asin !== product.asin || current.marketplace !== product.marketplace
        || current.marketNodeId !== product.marketNodeId) {
        throw new Error('自有产品身份或市场节点在候选发现期间发生变化。');
      }
      let observed = 0;
      const statement = this.database.prepare(`
        INSERT OR IGNORE INTO competitor_candidates (
          id, marketplace, asin, source_product_id, source, source_type,
          payload_json, status, created_at, sync_run_id
        ) VALUES (?, ?, ?, ?, ?, 'mcp', ?, 'pending_review', ?, ?)
      `);
      for (const candidate of candidates) {
        const candidateId = randomUUID();
        const result = statement.run(
          candidateId, product.marketplace, candidate.asin, product.id,
          response.provenance.source, JSON.stringify(candidate.payload),
          response.provenance.collectedAt,
          runId,
        );
        const disposition = result.changes === 1 ? 'inserted' : 'reused';
        const existing = result.changes === 1 ? undefined : this.database.prepare(`
          SELECT id, source, source_type AS sourceType, payload_json AS payloadJson
          FROM competitor_candidates
          WHERE marketplace = ? AND source_product_id = ? AND asin = ?
        `).get(product.marketplace, product.id, candidate.asin) as {
          id: string; source: string; sourceType: string; payloadJson: string;
        } | undefined;
        if (existing) {
          const storedPayload = safeJsonObject(existing.payloadJson);
          const fields = Object.keys(candidate.payload);
          if (existing.sourceType !== 'mcp' || existing.source !== response.provenance.source
            || Object.keys(storedPayload).length !== fields.length
            || fields.some((field) => storedPayload[field] !== candidate.payload[field])) {
            throw new Error('竞品候选来源或标准化数据与已有记录不一致，需人工核对。');
          }
        }
        const linkedCandidateId = result.changes === 1 ? candidateId : existing?.id;
        if (!linkedCandidateId) throw new Error('竞品候选运行关联创建失败。');
        const link = this.database.prepare(`
          INSERT INTO competitor_candidate_run_links (
            sync_run_id, candidate_id, source_product_id, disposition, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `).run(runId, linkedCandidateId, product.id, disposition, new Date().toISOString());
        observed += Number(link.changes);
      }
      if (complete) complete();
      return { candidates: observed };
    });
  }

  listCompetitorCandidates(ownedProductId: string): SellerSpriteCandidateSummary[] {
    const owned = this.requireOwnedProduct(ownedProductId);
    const rows = this.database.prepare(`
      SELECT id, asin, status, payload_json AS payloadJson,
        created_at AS createdAt, reviewed_at AS reviewedAt
      FROM competitor_candidates
      WHERE source_product_id = ? AND marketplace = ?
      ORDER BY created_at DESC, id
    `).all(owned.id, owned.marketplace) as Array<{
      id: string;
      asin: string;
      status: SellerSpriteCandidateSummary['status'];
      payloadJson: string;
      createdAt: string;
      reviewedAt: string | null;
    }>;
    return rows.map((row) => {
      const payload = safeJsonObject(row.payloadJson);
      return {
        id: row.id,
        asin: row.asin,
        status: row.status,
        title: stringOrNull(payload.title),
        brand: stringOrNull(payload.brand),
        price: finiteNumber(payload.price),
        createdAt: row.createdAt,
        reviewedAt: row.reviewedAt,
      };
    });
  }

  rejectCompetitorCandidate(input: SellerSpriteCandidateReviewInput): { status: 'rejected' } {
    const owned = this.requireOwnedProduct(input.ownedProductId);
    return transaction(this.database, () => {
      const result = this.database.prepare(`
        UPDATE competitor_candidates SET status = 'rejected', reviewed_at = ?
        WHERE id = ? AND source_product_id = ? AND marketplace = ? AND status = 'pending_review'
      `).run(new Date().toISOString(), input.candidateId, owned.id, owned.marketplace);
      if (result.changes !== 1) throw new Error('竞争候选不存在或已经处理。');
      return { status: 'rejected' as const };
    });
  }

  confirmCompetitorCandidate(input: SellerSpriteCandidateConfirmationInput): {
    ownedProductId: string;
    competitorProductId: string;
    relationType: SellerSpriteCandidateConfirmationInput['relationType'];
  } {
    const owned = this.requireOwnedProduct(input.ownedProductId);
    const candidate = this.database.prepare(`
      SELECT id, asin, marketplace, payload_json AS payloadJson,
        sync_run_id AS syncRunId, status
      FROM competitor_candidates
      WHERE id = ? AND source_product_id = ?
    `).get(input.candidateId, owned.id) as {
      id: string;
      asin: string;
      marketplace: string;
      payloadJson: string;
      syncRunId: string | null;
      status: string;
    } | undefined;
    if (!candidate) throw new Error('竞争候选不存在。');
    if (candidate.marketplace !== owned.marketplace) throw new Error('竞争候选站点不匹配。');
    if (candidate.status !== 'pending_review') throw new Error('竞争候选已经处理。');
    const payload = safeJsonObject(candidate.payloadJson);

    return transaction(this.database, () => {
      const existing = this.database.prepare(`
        SELECT is_owned AS isOwned FROM products
        WHERE marketplace = ? AND UPPER(TRIM(asin)) = ?
      `).get(owned.marketplace, candidate.asin.toUpperCase()) as { isOwned: number } | undefined;
      if (existing?.isOwned === 1) throw new Error('自有产品不能确认成竞品。');
      const resolution = this.identityResolver.resolve({
        marketplace: owned.marketplace,
        asin: candidate.asin,
        parentAsin: existing ? undefined : stringOrNull(payload.parentAsin) ?? undefined,
        sourceType: 'mcp',
        syncRunId: candidate.syncRunId ?? undefined,
      });
      if (!resolution.productId) throw new Error('竞争候选产品身份创建失败。');
      if (resolution.disposition === 'created') {
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
      }
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
    runId: string;
    taskId: string;
    marketSnapshots: number;
    productSnapshots: number;
    candidateCoverage: SellerSpriteCandidateCoverage;
    competitorCoverage: SellerSpriteCompetitorCoverage;
  }> {
    const market = this.requireMarket(input.marketId);
    const month = compactMonth(input.month);
    const baselineMonth = previousMonth(month);
    const products = this.activeOwnedProducts(market.marketplace, market.id);
    const marketNodes = this.criticalMarketNodes(market, products);
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const scope = {
      marketId: market.id, nodeIdPath: market.sellerSpriteNodePath, month, baselineMonth,
      marketMonths: [baselineMonth, month],
      marketNodes: marketNodes.map((node) => ({ id: node.id, nodeIdPath: node.sellerSpriteNodePath })),
      ownedProducts: products.map(({ id, asin, marketNodeId }) => ({ id, asin, marketNodeId })),
    };
    this.database.prepare(`
      INSERT INTO data_tasks (
        id, sync_run_id, name, source_id, task_type, target, source, marketplace,
        status, started_at, total, success, failed, created_at
      ) VALUES (?, ?, 'SellerSprite 关键同步', ?, 'critical_sync', ?, 'SellerSprite MCP', ?,
        'running', ?, ?, 0, 0, ?)
    `).run(runId, runId, SOURCE_ID, market.id, market.marketplace, startedAt,
      products.length + marketNodes.length, startedAt);

    let primary: { runId: string; taskId: string; marketSnapshots: number; productSnapshots: number };
    try {
      if (products.length === 0) throw new Error('关键同步需要至少一个启用中的自有 SKU。');
      // Remote calls finish outside the write transaction; a failure cannot commit half a batch.
      const preparedMarkets = await Promise.all(marketNodes.flatMap((node) => [
        this.prepareMarket({ marketId: node.id, month }, runId, true),
        this.prepareMarket({ marketId: node.id, month: baselineMonth }, runId, true),
      ]));
      const preparedProducts: PreparedProductObservation[] = [];
      for (const product of products) preparedProducts.push(await this.prepareProduct(product, runId));

      primary = transaction(this.database, () => {
        const currentMarket = this.requireMarket(market.id);
        if (currentMarket.marketplace !== market.marketplace
          || currentMarket.sellerSpriteNodePath !== market.sellerSpriteNodePath
          || JSON.stringify(this.activeOwnedProducts(market.marketplace, market.id)) !== JSON.stringify(products)
          || JSON.stringify(this.criticalMarketNodes(currentMarket, products)) !== JSON.stringify(marketNodes)) {
          throw new Error('关键同步期间市场节点或自有 SKU 范围发生变化，请重新运行。');
        }
        const marketSnapshots = preparedMarkets.reduce(
          (count, prepared) => count + this.persistMarket(prepared, runId), 0,
        );
        let productSnapshots = 0;
        for (const product of preparedProducts) productSnapshots += this.persistProduct(product, 'product', runId);
        const completedAt = new Date().toISOString();
        this.database.prepare(`
          INSERT INTO data_coverage_runs (
            id, marketplace, run_type, coverage_json, is_complete, created_at
          ) VALUES (?, ?, 'critical_sync', ?, 0, ?)
        `).run(runId, market.marketplace, JSON.stringify({
          ...scope, marketSnapshots, activeOwnedProducts: products.length, productSnapshots,
        }), completedAt);
        return { runId, taskId: runId, marketSnapshots, productSnapshots };
      });
    } catch (error) {
      const completedAt = new Date().toISOString();
      transaction(this.database, () => {
        this.database.prepare(`
          UPDATE data_tasks SET status = 'failed', failed = 1, completed_at = ?, error_log = ?
          WHERE id = ?
        `).run(completedAt, 'SellerSprite 关键同步失败；本次未更新任何观察，请检查连接和数据范围。', runId);
        this.database.prepare(`
          INSERT INTO data_coverage_runs (
            id, marketplace, run_type, coverage_json, is_complete, created_at
          ) VALUES (?, ?, 'critical_sync', ?, 0, ?)
        `).run(runId, market.marketplace, JSON.stringify(scope), completedAt);
      });
      throw new Error(sanitizeMcpError(error));
    }
    try {
      const candidateCoverage = await this.syncCandidateDiscoveryBatch(runId, market.marketplace, products);
      const competitorCoverage = await this.syncCoreCompetitorBatch(runId, market.marketplace);
      transaction(this.database, () => {
        const completedAt = new Date().toISOString();
        const coverageUpdate = this.database.prepare(`
          UPDATE data_coverage_runs SET is_complete = 1
          WHERE id = ? AND run_type = 'critical_sync' AND is_complete = 0
        `).run(runId);
        const taskUpdate = this.database.prepare(`
          UPDATE data_tasks SET status = 'success', success = total, completed_at = ?
          WHERE id = ? AND sync_run_id = ? AND task_type = 'critical_sync' AND status = 'running'
        `).run(completedAt, runId, runId);
        if (coverageUpdate.changes !== 1 || taskUpdate.changes !== 1) {
          throw new Error('SellerSprite 关键同步完成状态发生冲突。');
        }
      });
      return { ...primary, candidateCoverage, competitorCoverage };
    } catch (error) {
      const completedAt = new Date().toISOString();
      transaction(this.database, () => {
        this.database.prepare(`
          UPDATE data_tasks SET status = 'failed', failed = 1, completed_at = ?, error_log = ?
          WHERE id = ? AND sync_run_id = ? AND task_type = 'critical_sync' AND status = 'running'
        `).run(completedAt,
          'SellerSprite secondary coverage 未完整记录；主批观察已保留，但本次运行不可用于 Go Live。',
          runId, runId);
      });
      throw new Error(sanitizeMcpError(error));
    }
  }

  private async syncCandidateDiscoveryBatch(
    runId: string, marketplace: string, products: ProductRow[],
  ): Promise<SellerSpriteCandidateCoverage> {
    const taskId = randomUUID();
    const startedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO data_tasks (
        id, sync_run_id, name, source_id, task_type, target, source, marketplace,
        status, started_at, total, success, failed, created_at
      ) VALUES (?, ?, 'SellerSprite 竞品候选发现', ?, 'competitor_discovery',
        'owned-products', 'SellerSprite MCP', ?, 'running', ?, ?, 0, 0, ?)
    `).run(taskId, runId, SOURCE_ID, marketplace, startedAt, products.length, startedAt);
    let success = 0;
    let failed = 0;
    let candidates = 0;
    const covered: Array<{ id: string; asin: string; candidates: number }> = [];
    const failures: Array<{ id: string; status: 'failed' }> = [];
    for (const product of products) {
      try {
        const result = await this.discoverCompetitorsForProduct(product, 20, runId);
        success += 1;
        candidates += result.candidates;
        covered.push({ id: product.id, asin: product.asin, candidates: result.candidates });
      } catch {
        failed += 1;
        failures.push({ id: product.id, status: 'failed' });
      }
    }
    const status: SellerSpriteCandidateCoverage['status'] = failed === 0
      ? 'success' : success === 0 ? 'failed' : 'partial';
    const completedAt = new Date().toISOString();
    transaction(this.database, () => {
      this.database.prepare(`
        UPDATE data_tasks SET status = ?, completed_at = ?, success = ?, failed = ?, error_log = ?
        WHERE id = ? AND sync_run_id = ?
      `).run(status, completedAt, success, failed,
        failed > 0 ? `${failed} 个自有 SKU 的竞品候选未更新；未自动确认任何关系。` : null,
        taskId, runId);
      this.mergeRunCoverage(runId, 'candidateDiscovery', {
        taskId, status, total: products.length, success, failed, candidates, covered, failures,
      });
    });
    return { taskId, status, total: products.length, success, failed, candidates };
  }

  private async syncCoreCompetitorBatch(
    runId: string, marketplace: string,
  ): Promise<SellerSpriteCompetitorCoverage> {
    const competitors = this.database.prepare(`
      SELECT DISTINCT competitor.id, competitor.asin, competitor.marketplace,
        competitor.market_node_id AS marketNodeId
      FROM competitor_relations relation
      JOIN products owned ON owned.id = relation.owned_product_id
      JOIN products competitor ON competitor.id = relation.competitor_product_id
      WHERE relation.relation_type = 'direct'
        AND owned.marketplace = ? AND owned.is_owned = 1 AND owned.is_parent = 0 AND owned.status = 'active'
        AND owned.source_type <> 'mock'
        AND competitor.marketplace = owned.marketplace AND competitor.is_owned = 0
        AND competitor.is_parent = 0
        AND competitor.status = 'active' AND competitor.source_type <> 'mock'
      ORDER BY competitor.id
    `).all(marketplace) as unknown as ProductRow[];
    const taskId = randomUUID();
    const startedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO data_tasks (
        id, sync_run_id, name, source_id, task_type, target, source, marketplace,
        status, started_at, total, success, failed, created_at
      ) VALUES (?, ?, 'SellerSprite 核心竞品同步', ?, 'competitor_refresh',
        'watched-competitors', 'SellerSprite MCP', ?, 'running', ?, ?, 0, 0, ?)
    `).run(taskId, runId, SOURCE_ID, marketplace, startedAt, competitors.length, startedAt);

    let success = 0;
    let failed = 0;
    const covered: Array<{ id: string; asin: string; snapshots: number }> = [];
    const failures: Array<{ id: string; status: 'failed' }> = [];
    for (const competitor of competitors) {
      try {
        const prepared = await this.prepareProduct(competitor, runId);
        const snapshots = transaction(this.database, () => {
          if (!this.isCurrentDirectCompetitor(competitor.id, marketplace)) {
            throw new Error('核心竞品关系在同步期间发生变化。');
          }
          const current = this.database.prepare(`
            SELECT asin, marketplace, market_node_id AS marketNodeId
            FROM products WHERE id = ? AND is_owned = 0 AND status = 'active'
          `).get(competitor.id) as Pick<ProductRow, 'asin' | 'marketplace' | 'marketNodeId'> | undefined;
          if (!current || current.asin !== competitor.asin
            || current.marketplace !== competitor.marketplace
            || current.marketNodeId !== competitor.marketNodeId) {
            throw new Error('核心竞品身份或市场节点在同步期间发生变化。');
          }
          return this.persistProduct(prepared, 'competitor', runId);
        });
        success += 1;
        covered.push({ id: competitor.id, asin: competitor.asin, snapshots });
      } catch {
        failed += 1;
        failures.push({ id: competitor.id, status: 'failed' });
      }
    }
    const status: SellerSpriteCompetitorCoverage['status'] = failed === 0
      ? 'success' : success === 0 ? 'failed' : 'partial';
    const completedAt = new Date().toISOString();
    transaction(this.database, () => {
      this.database.prepare(`
        UPDATE data_tasks SET status = ?, completed_at = ?, success = ?, failed = ?, error_log = ?
        WHERE id = ? AND sync_run_id = ?
      `).run(status, completedAt, success, failed,
        failed > 0 ? `${failed} 个核心竞品未更新；已保留上一次合法真实 Snapshot。` : null,
        taskId, runId);
      this.mergeRunCoverage(runId, 'secondaryCompetitors', {
        taskId, status, total: competitors.length, success, failed,
        roster: competitors.map(({ id, asin }) => ({ id, asin })), covered, failures,
      });
    });
    return { taskId, status, total: competitors.length, success, failed };
  }

  private async prepareMarket(
    input: SellerSpriteMarketSyncInput,
    runId?: string,
    requireObservationMonth = false,
  ): Promise<PreparedMarketObservation> {
    const market = this.requireMarket(input.marketId);
    if (!/^\d+(?::\d+)*$/.test(market.sellerSpriteNodePath)) {
      throw new Error('请先确认并映射 SellerSprite 市场节点路径。');
    }
    const observationDate = monthEnd(input.month);
    const request = {
      marketplace: market.marketplace,
      nodeIdPath: market.sellerSpriteNodePath,
      month: compactMonth(input.month),
    };
    const [statistics, concentration] = await Promise.all([
      this.port.fetchMarketStatistics(request, { runId, requireObservationMonth }),
      this.port.fetchMarketConcentration(request, { runId, requireObservationMonth }),
    ]);
    ensureCompatibleProvenance(statistics.provenance, concentration.provenance);
    ensureResponseScope(statistics.data, market.marketplace, request.nodeIdPath, request.month);
    for (const item of concentration.data) {
      ensureResponseScope(item, market.marketplace, request.nodeIdPath, request.month);
    }

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
    const data = statistics.data;
    const metrics: Record<MarketMetric, number | null> = {
      productCount: finiteNumber(data.products),
      sellerCount: finiteNumber(data.sellers),
      brandCount: finiteNumber(data.brands),
      monthlySales: finiteNumber(data.totalUnits),
      monthlyRevenue: finiteNumber(data.totalRevenue),
      avgPrice: finiteNumber(data.avgPrice),
      medianPrice: finiteNumber(data.medianPrice),
      avgRating: finiteNumber(data.avgRating),
      medianReviews: finiteNumber(data.medianReviews),
      top10Share: percentOrNull(data.top10Share),
      top20Share: percentOrNull(data.top20Share),
      newProductShare: finiteNumber(data.newProductShare)
        ?? finiteNumber(data.newProductProportion),
    };
    if (Object.values(metrics).every((value) => value === null)) {
      throw new Error('SellerSprite 市场响应没有有效指标。');
    }
    return {
      market,
      observationDate,
      provenance: statistics.provenance,
      metrics,
      concentration: normalizedConcentration,
    };
  }

  private async prepareProduct(product: ProductRow, runId?: string): Promise<PreparedProductObservation> {
    const response = await this.port.fetchAsinSalesTrend({
      marketplace: product.marketplace,
      asin: product.asin,
    }, { runId });
    ensureMcpProvenance(response.provenance);
    const info = response.data.asin;
    ensureResponseScope(info, product.marketplace);
    const remoteAsin = stringOrNull(info.asin)?.toUpperCase();
    if (remoteAsin && remoteAsin !== product.asin.toUpperCase()) {
      throw new Error('SellerSprite 返回的 ASIN 与请求产品不一致。');
    }
    const isParentAsin = stringOrNull(info.parent)?.toUpperCase() === product.asin.toUpperCase();
    const points = response.data.salesTrendPoints.map((point) => {
      ensureResponseScope(point, product.marketplace);
      const pointAsin = stringOrNull(point.asin)?.toUpperCase();
      if (pointAsin && pointAsin !== product.asin.toUpperCase()) {
        throw new Error('SellerSprite 历史观察 ASIN 与请求产品不一致。');
      }
      const entry = {
        observationDate: historicalDate(requiredString(point.month, '销售趋势月份')),
        price: finiteNumber(point.price),
        rating: finiteNumber(point.rating),
        reviewCount: finiteNumber(point.ratings),
        bsr: finiteNumber(point.bsr ?? point.bsrRank),
        estimatedSales: finiteNumber(point.childUnitSales)
          ?? (isParentAsin ? finiteNumber(point.parentUnitSales) : null),
        estimatedRevenue: finiteNumber(point.childSalesRevenue)
          ?? (isParentAsin ? finiteNumber(point.parentSalesRevenue) : null),
        sellerCount: finiteNumber(point.sellers),
      };
      if (PRODUCT_METRICS.every((metric) => entry[metric] === null)) {
        throw new Error('SellerSprite 产品历史观察没有有效指标。');
      }
      return entry;
    });
    if (points.length === 0) throw new Error('SellerSprite 未返回产品历史观察。');
    return {
      product,
      parentAsin: stringOrNull(info.parent)?.toUpperCase() ?? null,
      provenance: response.provenance,
      points,
    };
  }

  private persistMarket(prepared: PreparedMarketObservation, runId?: string): number {
    const { market, metrics, observationDate, provenance } = prepared;
    const existing = this.database.prepare(`
      SELECT * FROM market_snapshots
      WHERE market_node_id = ? AND COALESCE(observation_date, date) = ?
        AND source_type = 'mcp' AND LOWER(TRIM(period)) = LOWER(TRIM(?))
        AND (product_count IS NOT NULL OR seller_count IS NOT NULL OR brand_count IS NOT NULL
          OR monthly_sales IS NOT NULL OR monthly_revenue IS NOT NULL OR avg_price IS NOT NULL
          OR median_price IS NOT NULL OR avg_rating IS NOT NULL OR median_reviews IS NOT NULL
          OR top10_share IS NOT NULL OR top20_share IS NOT NULL OR new_product_share IS NOT NULL)
      LIMIT 1
    `).get(market.id, observationDate, provenance.period) as Record<string, unknown> | undefined;
    if (existing) {
      if (runId) {
        const matches = (Object.keys(MARKET_METRIC_COLUMNS) as MarketMetric[])
          .every((metric) => existing[MARKET_METRIC_COLUMNS[metric]] === metrics[metric]);
        if (!matches || existing.source !== provenance.source
          || existing.concentration_json !== JSON.stringify(prepared.concentration)) {
          throw new Error('本次 SellerSprite 市场数据与同周期不可变观察不一致，需人工核对后重新同步。');
        }
        this.linkObservation(runId, 'market', String(existing.id), market.id, 'reused');
        for (const metric of Object.keys(MARKET_METRIC_COLUMNS) as MarketMetric[]) {
          this.persistFact('market', market.id, market.marketplace,
            MARKET_METRIC_COLUMNS[metric], metrics[metric], observationDate, provenance, runId);
        }
      }
      return 0;
    }
    const dedupKey = snapshotDedupKey('market', market.marketplace, market.id, observationDate, provenance);
    const snapshotId = randomUUID();
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO market_snapshots (
        id, market_node_id, date, product_count, seller_count, brand_count,
        monthly_sales, monthly_revenue, avg_price, median_price, avg_rating,
        median_reviews, top10_share, top20_share, new_product_share,
        price_bands_json, concentration_json, source, source_type, collected_at,
        period, is_estimated, confidence, observation_date, dedup_key, sync_run_id
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 'mcp', ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      snapshotId, market.id, observationDate, metrics.productCount, metrics.sellerCount,
      metrics.brandCount, metrics.monthlySales, metrics.monthlyRevenue, metrics.avgPrice,
      metrics.medianPrice, metrics.avgRating, metrics.medianReviews, metrics.top10Share,
      metrics.top20Share, metrics.newProductShare, JSON.stringify(prepared.concentration),
      provenance.source, provenance.collectedAt, provenance.period,
      provenance.isEstimated ? 1 : 0, provenance.confidence, observationDate, dedupKey, runId ?? null,
    );
    if (runId && result.changes !== 1) throw new Error('本次 SellerSprite 市场观察未能独立验证。');
    if (runId) this.linkObservation(runId, 'market', snapshotId, market.id, 'inserted');
    for (const metric of Object.keys(MARKET_METRIC_COLUMNS) as MarketMetric[]) {
      this.persistFact('market', market.id, market.marketplace,
        MARKET_METRIC_COLUMNS[metric], metrics[metric], observationDate, provenance, runId);
    }
    return Number(result.changes);
  }

  private persistProduct(
    prepared: PreparedProductObservation, entityType: 'product' | 'competitor' = 'product', runId?: string,
  ): number {
    if (prepared.parentAsin) {
      this.identityResolver.resolve({
        marketplace: prepared.product.marketplace,
        asin: prepared.product.asin,
        parentAsin: prepared.parentAsin,
        sourceType: 'mcp',
        syncRunId: runId,
      });
    }
    let inserted = 0;
    const statement = this.database.prepare(`
      INSERT OR IGNORE INTO product_snapshots (
        id, product_id, date, price, rating, review_count, bsr, estimated_sales,
        estimated_revenue, seller_count, growth_7d, growth_30d, growth_90d,
        source, source_type, collected_at, period, is_estimated, confidence,
        observation_date, dedup_key, sync_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 'mcp', ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const point of prepared.points) {
      const existing = this.database.prepare(`
        SELECT * FROM product_snapshots
        WHERE product_id = ? AND COALESCE(observation_date, date) = ?
          AND source_type = 'mcp' AND LOWER(TRIM(period)) = LOWER(TRIM(?))
          AND (price IS NOT NULL OR rating IS NOT NULL OR review_count IS NOT NULL
            OR bsr IS NOT NULL OR estimated_sales IS NOT NULL OR estimated_revenue IS NOT NULL
            OR seller_count IS NOT NULL OR growth_7d IS NOT NULL OR growth_30d IS NOT NULL
            OR growth_90d IS NOT NULL)
        LIMIT 1
      `).get(prepared.product.id, point.observationDate, prepared.provenance.period) as Record<string, unknown> | undefined;
      if (existing) {
        if (runId) {
          const matches = PRODUCT_METRICS.every((metric) => existing[PRODUCT_METRIC_COLUMNS[metric]] === point[metric]);
          if (!matches || existing.source !== prepared.provenance.source) {
            throw new Error('本次 SellerSprite 产品数据与同周期不可变观察不一致，需人工核对后重新同步。');
          }
          this.linkObservation(runId, 'product', String(existing.id), prepared.product.id, 'reused');
          for (const metric of PRODUCT_METRICS) {
            this.persistFact(
              entityType, prepared.product.id, prepared.product.marketplace,
              PRODUCT_METRIC_COLUMNS[metric], point[metric], point.observationDate,
              prepared.provenance, runId,
            );
          }
        }
        continue;
      }
      const dedupKey = snapshotDedupKey(
        'product', prepared.product.marketplace, prepared.product.id,
        point.observationDate, prepared.provenance,
      );
      const snapshotId = randomUUID();
      const result = statement.run(
        snapshotId, prepared.product.id, point.observationDate, point.price, point.rating,
        point.reviewCount, point.bsr, point.estimatedSales, point.estimatedRevenue,
        point.sellerCount, prepared.provenance.source, prepared.provenance.collectedAt,
        prepared.provenance.period, prepared.provenance.isEstimated ? 1 : 0,
        prepared.provenance.confidence, point.observationDate, dedupKey, runId ?? null,
      );
      if (runId && result.changes !== 1) throw new Error('本次 SellerSprite 产品观察未能独立验证。');
      if (runId) this.linkObservation(runId, 'product', snapshotId, prepared.product.id, 'inserted');
      inserted += Number(result.changes);
      for (const metric of PRODUCT_METRICS) {
        this.persistFact(
          entityType, prepared.product.id, prepared.product.marketplace, PRODUCT_METRIC_COLUMNS[metric],
          point[metric], point.observationDate, prepared.provenance, runId,
        );
      }
    }
    return inserted;
  }

  private persistFact(
    entityType: 'market' | 'product' | 'competitor', entityId: string, marketplace: string,
    metricName: string, value: number | null, observationDate: string, provenance: Provenance,
    runId?: string,
  ): void {
    const period = normalizeKeyPart(provenance.period);
    const dedupKey = [
      'fact', entityType, normalizeKeyPart(marketplace), entityId, metricName,
      observationDate, SOURCE_ID, period,
    ].join('|');
    const existing = this.database.prepare(`
      SELECT id, numeric_value AS numericValue, source, source_id AS sourceId,
        source_type AS sourceType
      FROM metric_facts WHERE dedup_key = ?
    `).get(dedupKey) as {
      id: string; numericValue: number | null; source: string;
      sourceId: string | null; sourceType: string;
    } | undefined;
    if (existing) {
      if (runId) {
        if (existing.numericValue !== value || existing.source !== provenance.source
          || existing.sourceId !== SOURCE_ID || existing.sourceType !== 'mcp') {
          throw new Error('本次 SellerSprite 指标与同周期不可变事实不一致，需人工核对后重新同步。');
        }
        this.linkObservation(runId, 'fact', existing.id, entityId, 'reused');
      }
      return;
    }
    const factId = randomUUID();
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO metric_facts (
        id, entity_type, entity_id, marketplace, metric_name, numeric_value,
        source, source_id, source_type, is_estimated, confidence,
        observation_date, collected_at, dedup_key, sync_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'mcp', ?, ?, ?, ?, ?, ?)
    `).run(
      factId, entityType, entityId, marketplace, metricName, value,
      provenance.source, SOURCE_ID, provenance.isEstimated ? 1 : 0,
      provenance.confidence, observationDate, provenance.collectedAt, dedupKey, runId ?? null,
    );
    if (runId && result.changes !== 1) throw new Error('本次 SellerSprite 指标未能独立验证。');
    if (runId) this.linkObservation(runId, 'fact', factId, entityId, 'inserted');
  }

  private linkObservation(
    runId: string, snapshotKind: 'market' | 'product' | 'fact', snapshotId: string,
    entityId: string, disposition: 'inserted' | 'reused',
  ): void {
    this.database.prepare(`
      INSERT INTO mcp_sync_observation_links (
        sync_run_id, snapshot_kind, snapshot_id, entity_id, disposition
      ) VALUES (?, ?, ?, ?, ?)
    `).run(runId, snapshotKind, snapshotId, entityId, disposition);
  }

  private async runTrackedObservationSync(
    input: { name: string; taskType: string; target: string; marketplace: string },
    prepare: (runId: string) => Promise<() => number>,
  ): Promise<SellerSpriteTrackedSyncResult> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO data_tasks (
        id, sync_run_id, name, source_id, task_type, target, source, marketplace,
        status, started_at, total, success, failed, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'SellerSprite MCP', ?, 'running', ?, 1, 0, 0, ?)
    `).run(
      runId, runId, input.name, SOURCE_ID, input.taskType, input.target,
      input.marketplace, startedAt, startedAt,
    );
    try {
      const persist = await prepare(runId);
      const inserted = transaction(this.database, () => {
        const count = persist();
        const completedAt = new Date().toISOString();
        const update = this.database.prepare(`
          UPDATE data_tasks SET status = 'success', success = 1, completed_at = ?
          WHERE id = ? AND sync_run_id = ? AND status = 'running'
        `).run(completedAt, runId, runId);
        if (update.changes !== 1) throw new Error('SellerSprite 同步任务状态发生冲突。');
        return count;
      });
      return { runId, taskId: runId, inserted };
    } catch (error) {
      const completedAt = new Date().toISOString();
      const sanitized = sanitizeMcpError(error);
      transaction(this.database, () => {
        this.database.prepare(`
          UPDATE data_tasks SET status = 'failed', failed = 1, completed_at = ?, error_log = ?
          WHERE id = ? AND sync_run_id = ?
        `).run(completedAt, 'SellerSprite 同步失败；本次未更新任何观察，请检查连接和数据范围。', runId, runId);
      });
      throw new Error(sanitized);
    }
  }

  private activeOwnedProducts(marketplace: string, rootMarketId: string): ProductRow[] {
    const total = this.database.prepare(`
      SELECT COUNT(*) AS count FROM products
      WHERE marketplace = ? AND is_owned = 1 AND is_parent = 0
        AND status = 'active' AND source_type <> 'mock'
    `).get(marketplace) as { count: number };
    const rows = this.database.prepare(`
      WITH RECURSIVE market_scope(id) AS (
        SELECT id FROM market_nodes
        WHERE id = ? AND marketplace = ? AND source_type <> 'mock'
        UNION
        SELECT child.id FROM market_nodes child
        JOIN market_scope parent ON child.parent_id = parent.id
        WHERE child.marketplace = ? AND child.source_type <> 'mock'
      )
      SELECT product.id, product.asin, product.marketplace,
        product.market_node_id AS marketNodeId
      FROM products product
      JOIN market_nodes market ON market.id = product.market_node_id
        AND market.marketplace = product.marketplace
        AND market.source_type <> 'mock'
        AND market.sellersprite_confirmed_node_path IS NOT NULL
      JOIN market_scope scope ON scope.id = product.market_node_id
      WHERE product.marketplace = ? AND product.is_owned = 1 AND product.is_parent = 0
        AND product.status = 'active' AND product.source_type <> 'mock'
      ORDER BY product.id
    `).all(rootMarketId, marketplace, marketplace, marketplace) as unknown as ProductRow[];
    if (rows.length !== total.count) {
      throw new Error('关键同步前置条件失败：全部真实自有 SKU 必须映射到主市场范围内已确认的 SellerSprite 节点。');
    }
    return rows;
  }

  private criticalMarketNodes(root: MarketRow, products: ProductRow[]): MarketRow[] {
    const childIds = [...new Set(products.map((product) => product.marketNodeId))]
      .filter((id) => id !== root.id).sort();
    return [root, ...childIds.map((id) => {
      const node = this.requireMarket(id);
      if (node.marketplace !== root.marketplace) {
        throw new Error('关键同步的自有 SKU 市场节点与主市场站点不一致。');
      }
      return node;
    })];
  }

  private isCurrentDirectCompetitor(competitorId: string, marketplace: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM competitor_relations relation
      JOIN products owned ON owned.id = relation.owned_product_id
      JOIN products competitor ON competitor.id = relation.competitor_product_id
      WHERE relation.competitor_product_id = ? AND relation.relation_type = 'direct'
        AND owned.marketplace = ? AND owned.is_owned = 1 AND owned.is_parent = 0 AND owned.status = 'active'
        AND owned.source_type <> 'mock'
        AND competitor.marketplace = owned.marketplace AND competitor.is_owned = 0
        AND competitor.is_parent = 0
        AND competitor.status = 'active' AND competitor.source_type <> 'mock'
      LIMIT 1
    `).get(competitorId, marketplace));
  }

  private mergeRunCoverage(runId: string, key: string, value: Record<string, unknown>): void {
    const row = this.database.prepare(`
      SELECT coverage_json AS coverageJson FROM data_coverage_runs WHERE id = ?
    `).get(runId) as { coverageJson: string } | undefined;
    if (!row) throw new Error('关键同步覆盖记录不存在。');
    const coverage = safeJsonObject(row.coverageJson);
    this.database.prepare(`UPDATE data_coverage_runs SET coverage_json = ? WHERE id = ?`)
      .run(JSON.stringify({ ...coverage, [key]: value }), runId);
  }

  private requireMarket(marketId: string): MarketRow {
    const row = this.database.prepare(`
      SELECT id, marketplace,
        sellersprite_confirmed_node_path AS sellerSpriteNodePath
      FROM market_nodes WHERE id = ? AND source_type <> 'mock'
    `).get(marketId) as (Omit<MarketRow, 'sellerSpriteNodePath'> & {
      sellerSpriteNodePath: string | null;
    }) | undefined;
    if (!row) throw new Error(`市场不存在：${marketId}`);
    if (!row.sellerSpriteNodePath) {
      throw new Error(`市场尚未确认 SellerSprite 节点路径：${marketId}`);
    }
    return { ...row, sellerSpriteNodePath: row.sellerSpriteNodePath };
  }

  private requireOwnedProduct(productId: string): ProductRow {
    const row = this.database.prepare(`
      SELECT product.id, product.asin, product.marketplace,
        product.market_node_id AS marketNodeId
      FROM products product
      JOIN market_nodes market ON market.id = product.market_node_id
        AND market.marketplace = product.marketplace
        AND market.source_type <> 'mock'
        AND market.sellersprite_confirmed_node_path IS NOT NULL
      WHERE product.id = ? AND product.is_owned = 1
        AND product.status = 'active' AND product.source_type <> 'mock'
    `).get(productId) as ProductRow | undefined;
    if (!row) throw new Error(`启用中的自有产品不存在：${productId}`);
    return row;
  }

  private requireConfirmedCompetitor(input: SellerSpriteConfirmedCompetitorSyncInput): ProductRow {
    const row = this.database.prepare(`
      SELECT competitor.id, competitor.asin, competitor.marketplace,
        competitor.market_node_id AS marketNodeId
      FROM competitor_relations relation
      JOIN products owned ON owned.id = relation.owned_product_id
      JOIN products competitor ON competitor.id = relation.competitor_product_id
      WHERE relation.owned_product_id = ? AND relation.competitor_product_id = ?
        AND owned.is_owned = 1 AND owned.is_parent = 0 AND owned.status = 'active'
        AND owned.source_type <> 'mock'
        AND competitor.is_owned = 0 AND competitor.is_parent = 0 AND competitor.status = 'active'
        AND competitor.source_type <> 'mock'
        AND competitor.marketplace = owned.marketplace
      LIMIT 1
    `).get(input.ownedProductId, input.competitorProductId) as ProductRow | undefined;
    if (!row) throw new Error('启用中的自有产品与竞品之间不存在已确认的同站点关联。');
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
  ensureMcpProvenance(left);
  ensureMcpProvenance(right);
  if (left.source !== right.source) throw new Error('SellerSprite 市场响应来源不一致。');
}

function ensureMcpProvenance(value: Provenance): void {
  if (value.sourceType !== 'mcp') throw new Error('SellerSprite 同步只能持久化 MCP 来源数据。');
}

function ensureResponseScope(
  data: Record<string, unknown>, marketplace: string, nodeIdPath?: string, month?: string,
): void {
  const remoteMarketplace = stringOrNull(data.marketplace);
  if (remoteMarketplace && remoteMarketplace.toUpperCase() !== marketplace.toUpperCase()) {
    throw new Error('SellerSprite 响应站点与请求 marketplace 不一致。');
  }
  const remoteNode = stringOrNull(data.nodeIdPath);
  if (nodeIdPath && remoteNode && remoteNode !== nodeIdPath) {
    throw new Error('SellerSprite 响应市场节点 nodeIdPath 与请求不一致。');
  }
  if (month && data.month !== undefined && data.month !== null) {
    const remoteMonth = typeof data.month === 'number' && Number.isInteger(data.month)
      ? String(data.month) : stringOrNull(data.month);
    if (!remoteMonth || compactObservationMonth(remoteMonth) !== month) {
      throw new Error('SellerSprite 响应月份与请求 month 不一致。');
    }
  }
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
  const match = /^(\d{4})-(\d{2})$/.exec(normalized);
  if (!match) throw new Error('月份必须使用 YYYYMM 或 YYYY-MM。');
  monthEnd(normalized);
  return `${match[1]}${match[2]}`;
}

function previousMonth(value: string): string {
  const normalized = compactMonth(value);
  const date = new Date(Date.UTC(Number(normalized.slice(0, 4)), Number(normalized.slice(4)) - 2, 1));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthEnd(value: string): string {
  const normalized = value.trim();
  const match = /^(\d{4})(?:-)?(\d{2})$/.exec(normalized);
  if (!match) throw new Error('月份必须使用 YYYYMM 或 YYYY-MM。');
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error('月份超出有效范围。');
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function historicalDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new Error('销售趋势日期不在有效日历范围内。');
    }
    return value;
  }
  return monthEnd(value);
}

function compactObservationMonth(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    historicalDate(value);
    return value.slice(0, 4) + value.slice(5, 7);
  }
  return compactMonth(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function percentOrNull(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 && number <= 100 ? number : null;
}

function normalizeKeyPart(value: string): string {
  return value.trim().toLowerCase();
}
