import { randomUUID } from 'node:crypto';
import type { Provenance } from '../../shared/types.js';
import type {
  SellerSpriteAsinTrend,
  SellerSpriteCompetitorCandidates,
  SellerSpriteConcentration,
  SellerSpriteData,
  SellerSpriteMarketResearchSummary,
  SellerSpriteStatistics,
} from '../adapters/sellersprite-mcp-adapter.js';
import type { AppDatabase } from '../database/database.js';
import { transaction } from '../database/database.js';
import { ProductIdentityResolver } from '../domain/product-identity-resolver.js';
import { sanitizeMcpError } from '../adapters/sellersprite-mcp-client.js';
import { requireConfirmedOwnedRoster, sellerSpriteRosterScope, ownedRosterState } from './owned-roster-declaration.js';
import { LocalObservationResolver } from './local-observation-resolver.js';
import { reusableCapabilitySnapshot, SELLERSPRITE_CAPABILITIES } from '../adapters/sellersprite-tool-registry.js';
import { SqliteMcpCapabilityStore } from '../adapters/sellersprite-mcp-store.js';
import { currentExecution, mcpExecution, McpBudgetManager, McpPolicyError, requestKey,
  type SellerSpriteSyncMode } from '../adapters/mcp-policy.js';

export interface SellerSpriteMarketSyncInput {
  marketId: string;
  month: string;
  syncMode?: SellerSpriteSyncMode;
  planId?: string;
  confirmed?: boolean;
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
  fetchMarketResearchSummary(input: {
    marketplace: string;
    nodeIdPath: string;
    month?: string;
  }, context?: { runId?: string; requireObservationMonth?: boolean }): Promise<SellerSpriteData<SellerSpriteMarketResearchSummary>>;
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
  }, context?: { runId?: string; secondary?: boolean }): Promise<SellerSpriteData<SellerSpriteAsinTrend>>;
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
  reusedHistoricalSnapshotId?: string;
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
      const prepared = await this.prepareMarket(input, runId, true);
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
    if (!mcpExecution.getStore()) {
      const id = randomUUID();
      this.database.prepare('INSERT INTO mcp_call_plans VALUES (?, ?, ?, ?, ?)').run(id,
        JSON.stringify(input), JSON.stringify({syncMode:'incremental',estimatedRemoteCalls:2,maximumRemoteCalls:4}),
        new Date().toISOString(),new Date().toISOString());
      return mcpExecution.run({syncMode:'incremental',remaining:4},async()=>{
        new McpBudgetManager(this.database).record(id,'incremental_plan_executed');
        return this.discoverCompetitors(input);
      });
    }
    const product = this.requireOwnedProduct(input.ownedProductId);
    const runId = randomUUID();
    currentExecution().runId = runId;
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
    const budget = new McpBudgetManager(this.database);
    const discoveryKey = requestKey([product.id, product.asin, product.marketplace, size ?? 20]);
    const state = this.database.prepare('SELECT collected_at FROM mcp_discovery_state WHERE scope_key=?').get(discoveryKey);
    const fresh = state && Date.now() - Date.parse(String(state.collected_at)) < budget.ttl('ASIN_COMPETITOR_DISCOVERY');
    if (currentExecution().syncMode === 'incremental' && (fresh || budget.summary().estimatedRemaining < 150)) {
      const candidates = this.database.prepare("SELECT id FROM competitor_candidates WHERE source_product_id=? AND marketplace=? AND source_type='mcp'").all(product.id, product.marketplace);
      transaction(this.database, () => {
        for (const candidate of candidates) this.database.prepare(`INSERT OR IGNORE INTO competitor_candidate_run_links
          (sync_run_id,candidate_id,source_product_id,disposition,created_at,observation_id)
          VALUES (?, ?, ?, 'reused', ?, (SELECT id FROM competitor_candidate_observations
            WHERE candidate_id=? ORDER BY collected_at DESC,rowid DESC LIMIT 1))`)
          .run(runId, candidate.id, product.id, new Date().toISOString(), candidate.id);
        budget.record(discoveryKey, fresh ? 'freshness_skip' : 'budget_blocked');
        if (fresh) budget.record(discoveryKey, 'local_hit');
        complete?.();
      });
      return {candidates: candidates.length};
    }
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
    const schema = this.database.prepare(`SELECT schema_hash FROM mcp_local_observations
      WHERE capability='ASIN_COMPETITOR_DISCOVERY' AND scope_key=? AND collected_at=?
      ORDER BY collected_at DESC LIMIT 1`).get(requestKey([product.marketplace,product.asin,null]),response.provenance.collectedAt);

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
          payload_json, status, created_at, sync_run_id, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, 'mcp', ?, 'pending_review', ?, ?, ?, ?)
      `);
      for (const candidate of candidates) {
        const candidateId = randomUUID();
        const result = statement.run(
          candidateId, product.marketplace, candidate.asin, product.id,
          response.provenance.source, JSON.stringify({ asin: candidate.asin }),
          response.provenance.collectedAt,
          runId,
          response.provenance.collectedAt, response.provenance.collectedAt,
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
          if (existing.sourceType !== 'mcp' || existing.source !== response.provenance.source) {
            throw new Error('竞品候选来源或标准化数据与已有记录不一致，需人工核对。');
          }
        }
        const linkedCandidateId = result.changes === 1 ? candidateId : existing?.id;
        if (!linkedCandidateId) throw new Error('竞品候选运行关联创建失败。');
        const previous = this.latestCandidatePayload(linkedCandidateId, existing?.payloadJson ?? '{}');
        const identityReview = ['title', 'brand', 'parentAsin'].some((field) =>
          previous[field] != null && candidate.payload[field] != null && previous[field] !== candidate.payload[field]);
        const observationId = randomUUID();
        this.database.prepare(`INSERT INTO competitor_candidate_observations
          (id,candidate_id,sync_run_id,collected_at,price,estimated_sales,revenue,rating,review_count,bsr,
           title,brand,normalized_payload_json,provenance_json,identity_review_required,schema_hash)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(observationId,linkedCandidateId,runId,
          response.provenance.collectedAt,candidate.payload.price,candidate.payload.units,candidate.payload.revenue,
          candidate.payload.rating,candidate.payload.ratings,candidate.payload.bsr,candidate.payload.title,
          candidate.payload.brand,JSON.stringify(candidate.payload),JSON.stringify(response.provenance),Number(identityReview),
          schema?.schema_hash ?? null);
        this.database.prepare('UPDATE competitor_candidates SET last_seen_at=MAX(COALESCE(last_seen_at,created_at),?) WHERE id=?')
          .run(response.provenance.collectedAt,linkedCandidateId);
        const link = this.database.prepare(`
          INSERT INTO competitor_candidate_run_links (
            sync_run_id, candidate_id, source_product_id, disposition, created_at, observation_id
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(runId, linkedCandidateId, product.id, disposition, new Date().toISOString(), observationId);
        observed += Number(link.changes);
      }
      this.database.prepare('INSERT OR REPLACE INTO mcp_discovery_state VALUES (?, ?)').run(discoveryKey, response.provenance.collectedAt);
      if (complete) complete();
      return { candidates: observed };
    });
  }

  private latestCandidatePayload(candidateId: string, fallback: string): Record<string, unknown> {
    const row = this.database.prepare(`SELECT normalized_payload_json AS payload FROM competitor_candidate_observations
      WHERE candidate_id=? ORDER BY collected_at DESC, rowid DESC LIMIT 1`).get(candidateId);
    return safeJsonObject(row ? String(row.payload) : fallback);
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
      const payload = this.latestCandidatePayload(row.id, row.payloadJson);
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
    const payload = this.latestCandidatePayload(candidate.id, candidate.payloadJson);

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

  planCritical(input: SellerSpriteMarketSyncInput) {
    const market = this.requireMarket(input.marketId);
    const products = this.activeOwnedProducts(market.marketplace, market.id);
    const nodes = this.criticalMarketNodes(market, products);
    const month = compactMonth(input.month);
    const mode = input.syncMode ?? 'incremental';
    const resolver = new LocalObservationResolver(this.database);
    const budget = new McpBudgetManager(this.database);
    const quota = budget.summary();
    const entries: Array<{ target: string; remote: number; local: number; reason: string }> = [];
    const cached = (capability: string, entity: string, period: string | null = null) => mode === 'incremental'
      && Boolean(this.database.prepare(`SELECT 1 FROM mcp_local_observations WHERE capability=? AND scope_key=?
        AND (historical_stable=1 OR expires_at>?)`).get(capability, requestKey([market.marketplace, entity, period]), new Date().toISOString()));
    for (const node of nodes) for (const period of [previousMonth(month), month]) {
      const historical = mode !== 'force' && resolver.historicalMarket(node.id, monthEnd(period));
      const local = historical || (mode === 'incremental' && resolver.market(node.id, monthEnd(period)));
      const reuse = local ? 3 : ['MARKET_RESEARCH', 'MARKET_STATISTICS', 'PRODUCT_CONCENTRATION'].filter((cap) => cached(cap, node.sellerSpriteNodePath, period)).length;
      entries.push({ target: `market:${node.id}:${period}`, remote: 3 - reuse, local: reuse,
        reason: historical ? 'closed_month_snapshot_reuse' : reuse === 3 ? 'freshness_skip' : 'missing_or_expired' });
    }
    for (const product of products) {
      const local = mode === 'incremental' && (resolver.product(product.id).length > 0 || cached('ASIN_SALES_TREND', product.asin));
      entries.push({ target: `owned:${product.id}`, remote: local ? 0 : 1, local: local ? 1 : 0,
        reason: local ? 'freshness_skip' : 'missing_or_expired' });
      const state = this.database.prepare('SELECT collected_at FROM mcp_discovery_state WHERE scope_key=?').get(requestKey([product.id, product.asin, product.marketplace, 20]));
      const reuse = mode === 'incremental' && ((state && Date.now() - Date.parse(String(state.collected_at)) < budget.ttl('ASIN_COMPETITOR_DISCOVERY')) || cached('ASIN_COMPETITOR_DISCOVERY', product.asin));
      entries.push({ target: `discovery:${product.id}`, remote: reuse || (quota.estimatedRemaining < 150 && mode === 'incremental') ? 0 : 1,
        local: reuse ? 1 : 0, reason: reuse ? 'freshness_skip' : quota.estimatedRemaining < 150 ? 'budget_blocked' : 'missing_or_expired' });
    }
    const competitors = this.database.prepare(`SELECT DISTINCT p.id FROM products p
      JOIN competitor_relations r ON r.competitor_product_id=p.id
      JOIN products owned ON owned.id=r.owned_product_id
      WHERE p.marketplace=? AND p.status='active' AND r.relation_type='direct'
        AND p.is_owned=0 AND p.is_parent=0 AND p.source_type<>'mock'
        AND owned.marketplace=p.marketplace AND owned.is_owned=1 AND owned.is_parent=0
        AND owned.status='active' AND owned.source_type<>'mock' ORDER BY p.id`).all(market.marketplace);
    for (const product of competitors) {
      const local = mode === 'incremental' && resolver.product(String(product.id), true).length > 0;
      entries.push({ target: `competitor:${product.id}`, remote: local || (mode === 'incremental' && quota.estimatedRemaining < 150) ? 0 : 1,
        local: local ? 1 : 0, reason: local ? 'freshness_skip' : mode === 'incremental' && quota.estimatedRemaining < 150 ? 'budget_blocked' : 'missing_or_expired' });
    }
    const toolFresh = reusableCapabilitySnapshot(new SqliteMcpCapabilityStore(this.database).latest(),
      SELLERSPRITE_CAPABILITIES, budget.ttl('LIST_TOOLS'));
    const remote = entries.reduce((n, e) => n + e.remote, 0) + (mode !== 'incremental' || !toolFresh ? 1 : 0);
    const blockers: string[] = [];
    try { requireConfirmedOwnedRoster(this.database, market.marketplace); } catch { blockers.push('自有 SKU 清单尚未确认'); }
    if (products.length === 0) blockers.push('没有启用的自有 SKU');
    if (nodes.some((node) => !/^\d+(?::\d+)*$/.test(node.sellerSpriteNodePath))) blockers.push('市场节点路径尚未确认');
    if (mode === 'incremental' && remote > Math.max(0, quota.estimatedRemaining - quota.reserve)) blockers.push('预计调用超过可用额度');
    const scope = sellerSpriteRosterScope(this.database, market.marketplace);
    const fingerprint = requestKey([market, products, nodes, competitors, quota.policy, quota.reserve,scope.digest]);
    const plan = { id: randomUUID(), syncMode: mode, entries, estimatedRemoteCalls: remote,
      ownedProductRosterCoverage:{...ownedRosterState(this.database,market.marketplace),total:scope.rows.length},
      sellerSpriteEnrichmentCoverage:{required:scope.eligible.length,excluded:scope.excluded},
      marketCoverage:{remoteEligibleNodes:nodes.length,internalOnlyProductIds:scope.excluded.map(p=>p.id)},
      competitorCoverage:{confirmed:competitors.length,discoveryProducts:products.length},
      rosterScopeDigest:scope.digest,
      localSnapshotReuse: entries.filter(e => e.reason === 'closed_month_snapshot_reuse').length,
      historicalMcpCallsSkipped: entries.filter(e => e.reason === 'closed_month_snapshot_reuse').length * 3,
      marketRemoteCalls: entries.filter(e => e.target.startsWith('market:')).reduce((n,e) => n+e.remote,0),
      ownedTrendCalls: entries.filter(e => e.target.startsWith('owned:')).reduce((n,e) => n+e.remote,0),
      competitorDiscoveryCalls: entries.filter(e => e.target.startsWith('discovery:')).reduce((n,e) => n+e.remote,0),
      confirmedCompetitorTrendCalls: entries.filter(e => e.target.startsWith('competitor:')).reduce((n,e) => n+e.remote,0),
      toolDiscoveryCalls: mode !== 'incremental' || !toolFresh ? 1 : 0,
      retryAttemptsPerRequest: 2, additionalPaginationAllowance: 2,
      localReuse: entries.reduce((n, e) => n + e.local, 0), cacheReuse: 0,
      maximumRemoteCalls: remote * 2 + 2, estimatedRemaining: quota.estimatedRemaining,
      projectedRemaining: Math.max(0, quota.estimatedRemaining - remote),
      requiresConfirmation: mode !== 'incremental' || remote > 20, blockers, fingerprint };
    this.database.prepare('INSERT INTO mcp_call_plans VALUES (?, ?, ?, ?, NULL)').run(plan.id,
      JSON.stringify({ marketId: input.marketId, month, syncMode: mode }), JSON.stringify(plan), new Date().toISOString());
    return plan;
  }

  async syncCriticalBatch(input: SellerSpriteMarketSyncInput) {
    const mode = input.syncMode ?? 'incremental';
    const current = this.planCritical(input);
    let plan = current;
    if (input.planId) {
      const saved = this.database.prepare('SELECT * FROM mcp_call_plans WHERE id=? AND consumed_at IS NULL').get(input.planId);
      if (!saved || Date.now() - Date.parse(String(saved.created_at)) > 600_000
        || saved.input_json !== JSON.stringify({marketId: input.marketId, month: compactMonth(input.month), syncMode: mode})) throw new Error('调用计划已失效，请重新预览。');
      plan = JSON.parse(String(saved.plan_json)) as typeof current;
      if (plan.fingerprint !== current.fingerprint || current.estimatedRemoteCalls > plan.estimatedRemoteCalls) throw new Error('数据范围或新鲜度已变化，请重新预览。');
    }
    if (current.blockers.length) throw new Error(current.blockers.join('；'));
    if (plan.requiresConfirmation && (!input.planId || !input.confirmed)) throw new McpPolicyError('CONFIRMATION_REQUIRED');
    const consumed = this.database.prepare('UPDATE mcp_call_plans SET consumed_at=? WHERE id=? AND consumed_at IS NULL').run(new Date().toISOString(), plan.id);
    if (consumed.changes !== 1) throw new Error('调用计划已执行，请重新预览。');
    return mcpExecution.run({syncMode: mode, confirmed: Boolean(input.planId && input.confirmed), remaining: plan.maximumRemoteCalls}, async () => {
      new McpBudgetManager(this.database).record(plan.id, `${mode}_plan_executed`);
      return this.executeCriticalBatch(input);
    });
  }

  private async executeCriticalBatch(input: SellerSpriteMarketSyncInput): Promise<{
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
    requireConfirmedOwnedRoster(this.database, market.marketplace);
    const products = this.activeOwnedProducts(market.marketplace, market.id);
    const marketNodes = this.criticalMarketNodes(market, products);
    const runId = randomUUID();
    currentExecution().runId = runId;
    const startedAt = new Date().toISOString();
    const scope = {
      rosterScopeDigest:sellerSpriteRosterScope(this.database, market.marketplace).digest,
      ownedProductRosterCoverage:ownedRosterState(this.database,market.marketplace),
      sellerSpriteEnrichmentCoverage:sellerSpriteRosterScope(this.database,market.marketplace),
      syncMode: currentExecution().syncMode,
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
    const primaryFailures: Array<{id:string;status:'failed'}> = [];
    const assertScope = () => {
      requireConfirmedOwnedRoster(this.database, market.marketplace);
      const currentMarket = this.requireMarket(market.id);
      if (currentMarket.marketplace !== market.marketplace
        || currentMarket.sellerSpriteNodePath !== market.sellerSpriteNodePath
        || sellerSpriteRosterScope(this.database,market.marketplace).digest !== scope.rosterScopeDigest
        || JSON.stringify(this.activeOwnedProducts(market.marketplace,market.id)) !== JSON.stringify(products)
        || JSON.stringify(this.criticalMarketNodes(currentMarket,products)) !== JSON.stringify(marketNodes)) {
        throw new Error('关键同步期间市场节点或自有 SKU 范围发生变化，请重新运行。');
      }
    };
    try {
      if (products.length === 0) throw new Error('关键同步需要至少一个启用中的自有 SKU。');
      // Commit each validated observation for audit, even if a later required step fails.
      let marketSnapshots = 0;
      let productSnapshots = 0;
      const strict = currentExecution().syncMode !== 'incremental';
      const preparedMarkets: PreparedMarketObservation[] = [];
      const preparedProducts: PreparedProductObservation[] = [];
      for (const node of marketNodes) for (const period of [month, baselineMonth]) {
        const prepared = await this.prepareMarket({ marketId: node.id, month: period }, runId, true);
        if (strict) marketSnapshots += transaction(this.database, () => { assertScope(); return this.persistMarket(prepared, runId); });
        else preparedMarkets.push(prepared);
      }
      let lastProductError: unknown;
      for (const product of products) {
        let prepared: PreparedProductObservation;
        try {
          prepared = await this.prepareProduct(product, runId);
        } catch (error) {
          if (strict) throw error;
          primaryFailures.push({id:product.id,status:'failed'});
          lastProductError=error;
          continue;
        }
        if (strict) productSnapshots += transaction(this.database, () => { assertScope(); return this.persistProduct(prepared, 'product', runId); });
        else preparedProducts.push(prepared);
      }
      if (primaryFailures.length===products.length) throw lastProductError;

      primary = transaction(this.database, () => {
        assertScope();
        for (const prepared of preparedMarkets) marketSnapshots += this.persistMarket(prepared, runId);
        for (const prepared of preparedProducts) productSnapshots += this.persistProduct(prepared, 'product', runId);
        const completedAt = new Date().toISOString();
        this.database.prepare(`
          INSERT INTO data_coverage_runs (
            id, marketplace, run_type, coverage_json, is_complete, created_at
          ) VALUES (?, ?, 'critical_sync', ?, 0, ?)
        `).run(runId, market.marketplace, JSON.stringify({
          ...scope, marketSnapshots, activeOwnedProducts: products.length, productSnapshots, primaryFailures,
        }), completedAt);
        return { runId, taskId: runId, marketSnapshots, productSnapshots };
      });
    } catch (error) {
      const completedAt = new Date().toISOString();
      transaction(this.database, () => {
        this.database.prepare(`
          UPDATE data_tasks SET status = 'failed', failed = 1, completed_at = ?, error_log = ?
          WHERE id = ?
        `).run(completedAt, 'SellerSprite 关键同步失败；已验证观察仅保留用于审计，本次运行不可用于 Go Live。', runId);
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
        requireConfirmedOwnedRoster(this.database, market.marketplace);
        if(sellerSpriteRosterScope(this.database,market.marketplace).digest!==scope.rosterScopeDigest)
          throw new Error('Provider scope changed during certification');
        const completedAt = new Date().toISOString();
        const coverageUpdate = this.database.prepare(`
          UPDATE data_coverage_runs SET is_complete = ?
          WHERE id = ? AND run_type = 'critical_sync' AND is_complete = 0
        `).run(primaryFailures.length===0 ? 1 : 0,runId);
        const taskUpdate = this.database.prepare(`
          UPDATE data_tasks SET status = ?, success = total-?, failed = ?, completed_at = ?
          WHERE id = ? AND sync_run_id = ? AND task_type = 'critical_sync' AND status = 'running'
        `).run(primaryFailures.length ? 'partial':'success',primaryFailures.length,primaryFailures.length,completedAt,runId,runId);
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
    let fatalError: Error | undefined;
    for (const product of products) {
      try {
        const result = await this.discoverCompetitorsForProduct(product, 20, runId);
        success += 1;
        candidates += result.candidates;
        covered.push({ id: product.id, asin: product.asin, candidates: result.candidates });
      } catch (error) {
        failed += 1;
        failures.push({ id: product.id, status: 'failed' });
        if (currentExecution().syncMode !== 'incremental') {
          fatalError = new Error(sanitizeMcpError(error));
          break;
        }
      }
    }
    const status: SellerSpriteCandidateCoverage['status'] = failed === 0
      ? 'success' : fatalError || success === 0 ? 'failed' : 'partial';
    const completedAt = new Date().toISOString();
    transaction(this.database, () => {
      this.database.prepare(`
        UPDATE data_tasks SET status = ?, completed_at = ?, success = ?, failed = ?, error_log = ?
        WHERE id = ? AND sync_run_id = ?
      `).run(status, completedAt, success, failed,
        failed > 0 ? `${failed} 个自有 SKU 的竞品候选未更新；未自动确认任何关系。` : null,
        taskId, runId);
      this.mergeRunCoverage(runId, 'candidateDiscovery', {
        observationVersion: 1,
        taskId, status, total: products.length, success, failed, candidates, covered, failures,
        unattempted: products.slice(success + failed).map(({ id }) => id),
      });
    });
    if (fatalError) throw fatalError;
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
    let fatalError: Error | undefined;
    for (const competitor of competitors) {
      try {
        const prepared = await this.prepareProduct(competitor, runId, true);
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
      } catch (error) {
        failed += 1;
        failures.push({ id: competitor.id, status: 'failed' });
        if (currentExecution().syncMode !== 'incremental') {
          fatalError = new Error(sanitizeMcpError(error));
          break;
        }
      }
    }
    const status: SellerSpriteCompetitorCoverage['status'] = failed === 0
      ? 'success' : fatalError || success === 0 ? 'failed' : 'partial';
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
        unattempted: competitors.slice(success + failed).map(({ id }) => id),
      });
    });
    if (fatalError) throw fatalError;
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
    const local = new LocalObservationResolver(this.database).market(market.id, observationDate);
    if (local) {
      new McpBudgetManager(this.database).record(`market:${market.id}:${observationDate}`, 'local_hit');
      new McpBudgetManager(this.database).record(`market:${market.id}:${observationDate}`, 'freshness_skip');
      const historical = new LocalObservationResolver(this.database).historicalMarket(market.id, observationDate, String(local.id));
      return { market, observationDate, provenance: localProvenance(local),
        reusedHistoricalSnapshotId: historical ? String(local.id) : undefined,
        metrics: Object.fromEntries(Object.entries(MARKET_METRIC_COLUMNS).map(([metric, column]) => [metric, local[column]])) as Record<MarketMetric, number | null>,
        concentration: JSON.parse(String(local.concentration_json)) as PreparedMarketObservation['concentration'] };
    }
    const request = {
      marketplace: market.marketplace,
      nodeIdPath: market.sellerSpriteNodePath,
      month: compactMonth(input.month),
    };
    const research = await this.port.fetchMarketResearchSummary(request, { runId, requireObservationMonth });
    const statistics = await this.port.fetchMarketStatistics(request, { runId, requireObservationMonth });
    const concentration = await this.port.fetchMarketConcentration(request, { runId, requireObservationMonth });
    ensureCompatibleProvenance(research.provenance, statistics.provenance);
    ensureCompatibleProvenance(statistics.provenance, concentration.provenance);
    ensureResponseScope(research.data, market.marketplace, request.nodeIdPath, request.month);
    ensureResponseScope(statistics.data, market.marketplace, request.nodeIdPath, request.month);
    for (const item of concentration.data) {
      ensureResponseScope(item, market.marketplace, request.nodeIdPath, request.month);
    }

    const normalizedConcentration = concentration.data.map((item) => ({
      asin: stringOrNull(item.asin),
      title: stringOrNull(item.title),
      brand: stringOrNull(item.brand),
      price: nonnegativeNumber(item.price),
      rating: ratingOrNull(item.rating),
      ratings: nonnegativeNumber(item.ratings),
      reviews: nonnegativeNumber(item.reviews),
      totalUnits: nonnegativeNumber(item.totalUnits),
      totalRevenue: nonnegativeNumber(item.totalRevenue),
      totalUnitsRatio: fractionOrNull(item.totalUnitsRatio),
      totalRevenueRatio: fractionOrNull(item.totalRevenueRatio),
    }));
    const researchData = research.data;
    const data = statistics.data;
    const totalProducts = nonnegativeInteger(researchData.totalProducts);
    const topProducts = positiveInteger(researchData.topProducts);
    const summaryCoversMarket = totalProducts !== null && topProducts === totalProducts;
    const asins = concentration.data.map((item) => stringOrNull(item.asin)?.toUpperCase());
    const concentrationCoversMarket = summaryCoversMarket
      && concentration.data.length === topProducts
      && asins.every((asin) => asin !== undefined && asin !== null)
      && new Set(asins).size === concentration.data.length;
    const monthlySales = summaryCoversMarket ? nonnegativeNumber(researchData.totalUnits) : null;
    const top10Sales = nonnegativeNumber(researchData.top10ProductSales);
    const top20Sales = nonnegativeNumber(researchData.top20ProductSales);
    const rankedSalesValid = monthlySales !== null && monthlySales > 0
      && top10Sales !== null && top20Sales !== null
      && top10Sales <= top20Sales && top20Sales <= monthlySales;
    const metrics: Record<MarketMetric, number | null> = {
      productCount: totalProducts ?? nonnegativeInteger(data.totalProducts),
      sellerCount: summaryCoversMarket ? nonnegativeInteger(data.sellers) : null,
      brandCount: summaryCoversMarket ? nonnegativeInteger(data.brands) : null,
      monthlySales,
      monthlyRevenue: summaryCoversMarket ? nonnegativeNumber(researchData.totalRevenue) : null,
      avgPrice: summaryCoversMarket ? nonnegativeNumber(data.avgPrice) : null,
      medianPrice: concentrationCoversMarket
        ? completeNonnegativeMedian(concentration.data.map((item) => item.price)) : null,
      avgRating: summaryCoversMarket ? ratingOrNull(data.avgRating) : null,
      medianReviews: concentrationCoversMarket
        ? completeNonnegativeMedian(concentration.data.map((item) => item.reviews)) : null,
      top10Share: rankedSalesValid ? top10Sales! / monthlySales * 100 : null,
      top20Share: rankedSalesValid ? top20Sales! / monthlySales * 100 : null,
      newProductShare: summaryCoversMarket
        ? percentOrNull(data.newProductShare) ?? percentOrNull(data.newProductProportion)
        : null,
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

  private async prepareProduct(product: ProductRow, runId?: string, secondary = false): Promise<PreparedProductObservation> {
    const local = new LocalObservationResolver(this.database).product(product.id, secondary);
    if (local.length) {
      new McpBudgetManager(this.database).record(`product:${product.id}`, 'local_hit');
      new McpBudgetManager(this.database).record(`product:${product.id}`, 'freshness_skip');
      return { product, parentAsin: null, provenance: localProvenance(local[0]!), points: local.map((row) => ({
        observationDate: String(row.observation_date), ...Object.fromEntries(PRODUCT_METRICS.map((key) => [key, row[PRODUCT_METRIC_COLUMNS[key]]])),
      })) as PreparedProductObservation['points'] };
    }
    if (secondary && currentExecution().syncMode === 'incremental'
      && new McpBudgetManager(this.database).summary().estimatedRemaining < 150) {
      new McpBudgetManager(this.database).record(`product:${product.id}`, 'budget_blocked');
      throw new McpPolicyError('BUDGET_BLOCKED');
    }
    const response = await this.port.fetchAsinSalesTrend({
      marketplace: product.marketplace,
      asin: product.asin,
    }, { runId, secondary });
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
        if (prepared.reusedHistoricalSnapshotId) {
          if (prepared.reusedHistoricalSnapshotId !== existing.id) throw new Error('Historical Snapshot identity changed');
          new LocalObservationResolver(this.database).recordMarketReuse(runId, String(existing.id), market.id, observationDate);
        }
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
    if (!mcpExecution.getStore()) {
      const budget = new McpBudgetManager(this.database);
      const estimatedRemoteCalls = input.taskType === 'market_refresh' ? 4 : 2;
      const planId = randomUUID();
      this.database.prepare('INSERT INTO mcp_call_plans VALUES (?, ?, ?, ?, ?)').run(planId,
        JSON.stringify(input), JSON.stringify({syncMode:'incremental',estimatedRemoteCalls,
          maximumRemoteCalls:estimatedRemoteCalls*2, note:'Conservative bound before local/cache resolution'}),
        new Date().toISOString(), new Date().toISOString());
      return mcpExecution.run({syncMode:'incremental',remaining:estimatedRemoteCalls*2}, async()=>{
        budget.record(planId,'incremental_plan_executed');
        return this.runTrackedObservationSync(input,prepare);
      });
    }
    const runId = randomUUID();
    currentExecution().runId = runId;
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
    const scope = sellerSpriteRosterScope(this.database,marketplace);
    const eligibleIds = new Set(scope.eligible.map(p=>String(p.id)));
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
    const eligible = rows.filter(p=>eligibleIds.has(p.id));
    if (eligible.length !== scope.eligible.length) {
      throw new Error('关键同步前置条件失败：全部真实自有 SKU 必须映射到主市场范围内已确认的 SellerSprite 节点。');
    }
    return eligible;
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
      units: finiteNumber(candidate.units ?? candidate.estimatedSales ?? candidate.sales),
      revenue: finiteNumber(candidate.revenue),
      rating: finiteNumber(candidate.rating),
      ratings: finiteNumber(candidate.ratings ?? candidate.reviewCount),
      bsr: finiteNumber(candidate.bsr ?? candidate.rank),
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

function localProvenance(row: Record<string, unknown>): Provenance {
  return { source: String(row.source), sourceType: 'mcp', collectedAt: String(row.collected_at),
    period: String(row.period), isEstimated: row.is_estimated === 1, confidence: Number(row.confidence) };
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

function nonnegativeNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function nonnegativeInteger(value: unknown): number | null {
  const number = nonnegativeNumber(value);
  return number !== null && Number.isSafeInteger(number) ? number : null;
}

function positiveInteger(value: unknown): number | null {
  const number = nonnegativeInteger(value);
  return number !== null && number > 0 ? number : null;
}

function completeNonnegativeMedian(values: unknown[]): number | null {
  if (values.length === 0) return null;
  const numbers = values.map(nonnegativeNumber);
  if (numbers.some((value) => value === null)) return null;
  const sorted = (numbers as number[]).sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function ratingOrNull(value: unknown): number | null {
  const number = nonnegativeNumber(value);
  return number !== null && number <= 5 ? number : null;
}

function fractionOrNull(value: unknown): number | null {
  const number = nonnegativeNumber(value);
  return number !== null && number <= 1 ? number : null;
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
