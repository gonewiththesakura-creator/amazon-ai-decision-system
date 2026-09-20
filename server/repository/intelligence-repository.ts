import type {
  AppSettings,
  Competitor,
  DataSource,
  DataTask,
  DecisionRecord,
  DevelopmentProject,
  Insight,
  MarketDetail,
  MarketNode,
  MetricProvenance,
  Opportunity,
  OwnedProductDetail,
  OwnedProductSummary,
  Product,
  ProductSnapshot,
  Provenance,
  ScoreBreakdown,
  TrendPoint,
  WatchlistItem,
} from '../../shared/types.js';
import { calculateRelativePerformance, detectProductAnomalies, percentileRank } from '../domain/calculations.js';
import type { AppDatabase } from '../database/database.js';
import { deriveSnapshotGrowth, type SnapshotGrowthPair } from '../domain/snapshot-growth.js';
import { MetricAuthorityResolver, type MetricFact } from '../services/metric-authority-resolver.js';
import { isLiveObservationReadable } from '../services/live-observation-readability.js';

type DbPrimitive = string | number | bigint | null;
type DbRow = Record<string, DbPrimitive>;

export type OpportunityRecord = Opportunity;

function stringValue(value: DbPrimitive | undefined, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value);
}

function numberValue(value: DbPrimitive | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumberValue(value: DbPrimitive | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value: DbPrimitive | undefined): boolean {
  return numberValue(value) === 1;
}

function jsonValue<T>(value: DbPrimitive | undefined, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const PRODUCT_SELECT = `
  SELECT p.*,
    ps.id AS snapshot_id, ps.date AS snapshot_date, ps.price AS snapshot_price,
    ps.rating AS snapshot_rating, ps.review_count AS snapshot_review_count,
    ps.bsr AS snapshot_bsr, ps.estimated_sales AS snapshot_estimated_sales,
    ps.estimated_revenue AS snapshot_estimated_revenue, ps.seller_count AS snapshot_seller_count,
    ps.growth_7d AS snapshot_growth_7d, ps.growth_30d AS snapshot_growth_30d,
    ps.growth_90d AS snapshot_growth_90d, ps.source AS snapshot_source,
    ps.source_type AS snapshot_source_type, ps.collected_at AS snapshot_collected_at,
    ps.period AS snapshot_period, ps.is_estimated AS snapshot_is_estimated,
    ps.confidence AS snapshot_confidence
  FROM products p
  LEFT JOIN product_snapshots ps ON ps.id = (
    SELECT newest.id FROM product_snapshots newest
    WHERE newest.product_id = p.id
    ORDER BY newest.date DESC, newest.collected_at DESC LIMIT 1
  )
`;

const MARKET_METRICS = [
  'monthly_sales', 'monthly_revenue', 'product_count', 'seller_count', 'brand_count',
  'avg_price', 'median_price', 'avg_rating', 'median_reviews', 'top10_share',
  'top20_share', 'new_product_share',
] as const;
const PRODUCT_METRICS = [
  'price', 'rating', 'review_count', 'bsr', 'estimated_sales', 'estimated_revenue',
  'seller_count', 'growth_7d', 'growth_30d', 'growth_90d',
] as const;

export class IntelligenceRepository {
  private readonly metricLineage = new WeakMap<DbRow, Record<string, MetricProvenance>>();

  constructor(readonly database: AppDatabase) {}

  getSettings(): AppSettings {
    const row = this.database.prepare('SELECT * FROM app_settings WHERE id = 1').get() as DbRow;
    return {
      mode: stringValue(row.mode, 'empty') as AppSettings['mode'],
      role: stringValue(row.role, 'admin') as AppSettings['role'],
      marketplace: stringValue(row.marketplace, 'US'),
      currency: stringValue(row.currency, 'USD'),
      timezone: stringValue(row.timezone, 'Asia/Shanghai'),
      defaultMarketId: stringValue(row.default_market_id),
      aiModel: stringValue(row.ai_model, 'rule-engine-v1'),
      refreshFrequency: stringValue(row.refresh_frequency, 'manual') as AppSettings['refreshFrequency'],
      lastSuccessfulSync: row.last_successful_sync === null ? null : stringValue(row.last_successful_sync),
    };
  }

  getDataSources(): DataSource[] {
    const rows = this.database.prepare('SELECT * FROM data_sources ORDER BY rowid').all() as DbRow[];
    return rows.map((row) => ({
      id: stringValue(row.id),
      name: stringValue(row.name),
      type: stringValue(row.type) as DataSource['type'],
      status: stringValue(row.status) as DataSource['status'],
      lastSyncAt: row.last_sync_at === null ? null : stringValue(row.last_sync_at),
      description: stringValue(row.description),
    }));
  }

  getMarkets(): MarketNode[] {
    const marketplace = this.getSettings().marketplace;
    const rows = this.database.prepare(`
      SELECT * FROM market_nodes WHERE marketplace = ? ORDER BY level, rowid
    `).all(marketplace) as DbRow[];
    const nodes = rows.map((row) => this.mapMarketNode(row));
    const byParent = new Map<string | null, MarketNode[]>();
    for (const node of nodes) {
      const siblings = byParent.get(node.parentId) ?? [];
      siblings.push(node);
      byParent.set(node.parentId, siblings);
    }
    const attach = (node: MarketNode, visited: Set<string>): MarketNode => {
      if (visited.has(node.id)) return { ...node, children: [] };
      const nextVisited = new Set(visited).add(node.id);
      return { ...node, children: (byParent.get(node.id) ?? []).map((child) => attach(child, nextVisited)) };
    };
    // Return a flat discoverable list while retaining each node's descendants for tree renderers.
    return nodes.map((node) => attach(node, new Set()));
  }

  getMarket(id: string): MarketDetail | null {
    const row = this.database.prepare(`
      SELECT * FROM market_nodes WHERE id = ? AND marketplace = ?
    `).get(id, this.getSettings().marketplace) as DbRow | undefined;
    if (!row) return null;
    const snapshots = this.getMarketSnapshotRows(id);
    const latest = snapshots.at(-1);
    const node = this.mapMarketNode(row);
    const markets = this.getMarkets();
    const fullNode = markets.find((item) => item.id === id) ?? node;
    const insight = this.getCurrentWorkflowInsightForEntity('market', id)
      ?? this.workflowRequiredInsight('market', id, node.name);
    const provenance: Provenance = latest ? this.provenanceFromRow(latest) : {
      source: '尚未导入市场快照', sourceType: 'import', collectedAt: '', period: '30D',
      isEstimated: true, confidence: 0,
    };
    return {
      node: fullNode,
      path: this.getMarketPath(id),
      kpis: {
        monthlySales: latest ? nullableNumberValue(latest.monthly_sales) : null,
        monthlyRevenue: latest ? nullableNumberValue(latest.monthly_revenue) : null,
        productCount: latest ? nullableNumberValue(latest.product_count) : null,
        sellerCount: latest ? nullableNumberValue(latest.seller_count) : null,
        brandCount: latest ? nullableNumberValue(latest.brand_count) : null,
        avgPrice: latest ? nullableNumberValue(latest.avg_price) : null,
        medianPrice: latest ? nullableNumberValue(latest.median_price) : null,
        top10Share: latest ? nullableNumberValue(latest.top10_share) : null,
        top20Share: latest ? nullableNumberValue(latest.top20_share) : null,
        newProductShare: latest ? nullableNumberValue(latest.new_product_share) : null,
        medianReviews: latest ? nullableNumberValue(latest.median_reviews) : null,
        avgRating: latest ? nullableNumberValue(latest.avg_rating) : null,
      },
      trends: snapshots.map((snapshot) => this.mapTrend(snapshot)),
      tree: [fullNode],
      priceBands: latest ? jsonValue(latest.price_bands_json, []) : [],
      concentration: latest ? jsonValue(latest.concentration_json, []) : [],
      insight,
      provenance,
      metricProvenance: latest ? this.metricLineage.get(latest) : undefined,
    };
  }

  getMarketSnapshots(id: string): TrendPoint[] {
    return this.getMarketSnapshotRows(id).map((row) => this.mapTrend(row));
  }

  getSelectedMarketSnapshotId(id: string): string | null {
    const latest = this.getMarketSnapshotRows(id).at(-1);
    return latest ? stringValue(latest.id) : null;
  }

  getMarketProducts(id: string): Product[] {
    const rows = this.database.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM market_nodes WHERE id = ?
        UNION ALL
        SELECT child.id FROM market_nodes child JOIN descendants parent ON child.parent_id = parent.id
      )
      ${PRODUCT_SELECT}
      WHERE p.market_node_id IN (SELECT id FROM descendants) AND p.status = 'active'
        AND p.is_parent = 0
      ORDER BY p.id
    `).all(id) as DbRow[];
    return rows.map((row) => this.mapProduct(row)).sort((left, right) => (
      (right.latest.estimatedSales ?? Number.NEGATIVE_INFINITY)
        - (left.latest.estimatedSales ?? Number.NEGATIVE_INFINITY)
      || left.id.localeCompare(right.id)
    ));
  }

  getOwnedProducts(): OwnedProductSummary[] {
    return this.getOwnedProductSummaries(false);
  }

  getSellableOwnedProducts(): OwnedProductSummary[] {
    return this.getOwnedProductSummaries(true);
  }

  private getOwnedProductSummaries(sellableOnly: boolean): OwnedProductSummary[] {
    const rows = this.database.prepare(`
      ${PRODUCT_SELECT}
      WHERE p.is_owned = 1 AND p.status = 'active' AND p.marketplace = ?
        AND (? = 0 OR p.is_parent = 0)
      ORDER BY p.created_at, p.id
    `).all(this.getSettings().marketplace, sellableOnly ? 1 : 0) as DbRow[];
    return rows.map((row) => this.mapOwnedSummary(row));
  }

  getOwnedProduct(id: string): OwnedProductDetail | null {
    const row = this.database.prepare(`
      ${PRODUCT_SELECT} WHERE p.id = ? AND p.is_owned = 1 AND p.status = 'active' AND p.marketplace = ?
    `).get(id, this.getSettings().marketplace) as DbRow | undefined;
    if (!row) return null;
    const summary = this.mapOwnedSummary(row);
    const snapshots = this.getProductSnapshots(id);
    const population = this.getMarketProducts(summary.marketNodeId);
    const comparisonSnapshots = population
      .filter((item) => item.id !== id)
      .map((item) => item.latest)
      .filter((snapshot) => snapshot.snapshotAvailable);
    const competitors = this.getCompetitors(id);
    const directCohort = competitors.filter((item) => (
      item.relationType === 'direct' && item.latest.id && item.latest.growth30dAvailable
        && item.latest.growth30d !== null
    ));
    const top20Cohort = population
      .filter((item) => item.id !== id && !item.isOwned && item.latest.id
        && item.latest.growth30dAvailable && item.latest.growth30d !== null
        && item.latest.bsr !== null && item.latest.bsr > 0)
      .sort((left, right) => (left.latest.bsr ?? Number.POSITIVE_INFINITY)
        - (right.latest.bsr ?? Number.POSITIVE_INFINITY))
      .slice(0, 20);
    return {
      ...summary,
      snapshots,
      percentiles: {
        sales: nullablePercentile(summary.latest.estimatedSales, comparisonSnapshots.map((item) => item.estimatedSales)),
        price: nullablePercentile(summary.latest.price, comparisonSnapshots.map((item) => item.price)),
        reviews: nullablePercentile(summary.latest.reviewCount, comparisonSnapshots.map((item) => item.reviewCount)),
        rating: nullablePercentile(summary.latest.rating, comparisonSnapshots.map((item) => item.rating)),
        growth: nullablePercentile(
          summary.latest.growth30d,
          comparisonSnapshots.filter((item) => item.growth30dAvailable).map((item) => item.growth30d),
        ),
      },
      comparisons: {
        market: { growth30d: summary.marketGrowth30d },
        direct: {
          growth30d: average(directCohort.map((item) => item.latest.growth30d)),
          sampleSize: directCohort.length,
        },
        top20: {
          growth30d: average(top20Cohort.map((item) => item.latest.growth30d)),
          sampleSize: top20Cohort.length,
        },
      },
      competitors,
    };
  }

  getProductSnapshots(productId: string): ProductSnapshot[] {
    const live = this.getSettings().mode === 'live';
    const rows = this.database.prepare(`
      SELECT * FROM product_snapshots WHERE product_id = ?
      ORDER BY observation_date, collected_at, id
    `).all(productId) as DbRow[];
    const readableRows = live ? rows.filter((row) => isLiveObservationReadable(
      this.database, 'product', stringValue(row.id), stringValue(row.source_type),
      row.sync_run_id === null ? null : stringValue(row.sync_run_id),
    )) : rows;
    const product = this.database.prepare('SELECT is_owned FROM products WHERE id = ?')
      .get(productId) as DbRow | undefined;
    const entityType = product && !booleanValue(product.is_owned) ? 'competitor' : 'product';
    const selectedRows = this.authoritativeSnapshotRows(
      readableRows, entityType, productId, PRODUCT_METRICS, 'estimated_sales',
    );
    return selectedRows.map((row, index) => {
      const growth = deriveSnapshotGrowth(selectedRows.slice(0, index + 1).map((snapshot) => ({
        id: stringValue(snapshot.id),
        date: stringValue(snapshot.date),
        value: nullableNumberValue(snapshot.estimated_sales),
      })));
      return this.mapProductSnapshot(row, growth?.latest.id === stringValue(row.id) ? growth : null);
    });
  }

  getCompetitors(ownedProductId: string): Competitor[] {
    const rows = this.database.prepare(`
      SELECT products_with_snapshot.*,
        r.relation_type, r.similarity_score, r.reason AS relation_reason, r.ai_tags_json,
        r.created_at AS relation_created_at, r.last_verified_at
      FROM (${PRODUCT_SELECT}) products_with_snapshot
      JOIN competitor_relations r ON r.competitor_product_id = products_with_snapshot.id
      WHERE r.owned_product_id = ?
      ORDER BY CASE r.relation_type
        WHEN 'direct' THEN 1 WHEN 'fast_growth' THEN 2 WHEN 'benchmark' THEN 3 ELSE 4 END,
        r.similarity_score DESC
    `).all(ownedProductId) as DbRow[];
    return rows.map((row) => ({
      ...this.mapProduct(row),
      relationType: stringValue(row.relation_type) as Competitor['relationType'],
      similarityScore: numberValue(row.similarity_score),
      relationReason: stringValue(row.relation_reason),
      aiTags: jsonValue(row.ai_tags_json, []),
      relationCreatedAt: stringValue(row.relation_created_at),
      lastVerifiedAt: stringValue(row.last_verified_at),
    }));
  }

  getInsights(entityType: string, entityId: string): Insight[] {
    const rows = this.database.prepare(`
      SELECT * FROM ai_insights
      WHERE entity_type = ? AND entity_id = ?
      ORDER BY generated_at DESC, rowid DESC
    `).all(entityType, entityId) as DbRow[];
    return rows.map((row) => this.mapInsight(row));
  }

  getCurrentWorkflowInsightForEntity(entityType: string, entityId: string): Insight | null {
    const normalizedType = entityType === 'market_node'
      ? 'market'
      : entityType === 'product' || entityType === 'ownedProduct'
        ? 'owned_product'
        : entityType;
    const mappings: Record<string, { entityTypes: string[]; jobTypes: string[] }> = {
      market: { entityTypes: ['market', 'market_node'], jobTypes: ['existing_market'] },
      owned_product: { entityTypes: ['owned_product', 'product'], jobTypes: ['owned_product'] },
      development_project: { entityTypes: ['development_project'], jobTypes: ['adjacent_product'] },
      opportunity: { entityTypes: ['opportunity'], jobTypes: ['new_opportunity'] },
    };
    const mapping = mappings[normalizedType];
    if (!mapping) return null;
    const entityPlaceholders = mapping.entityTypes.map(() => '?').join(',');
    const jobPlaceholders = mapping.jobTypes.map(() => '?').join(',');
    const rows = this.database.prepare(`
      WITH current_job AS (
        SELECT latest.id
        FROM research_jobs latest
        WHERE latest.marketplace = ? AND latest.entity_id = ?
          AND latest.entity_type IN (${entityPlaceholders})
          AND latest.job_type IN (${jobPlaceholders})
          AND (? = 0 OR latest.is_demo = 0)
        ORDER BY latest.updated_at DESC, latest.created_at DESC, latest.id DESC
        LIMIT 1
      )
      SELECT insight.*
      FROM current_job current
      JOIN research_jobs job ON job.id = current.id
      JOIN ai_insights insight
        ON insight.entity_type = 'research_job'
        AND insight.entity_id = job.id
        AND insight.research_job_id = job.id
        AND insight.data_version = job.data_version
        AND insight.prompt_version = job.prompt_version
      WHERE job.status IN ('monitoring', 'waiting_approval', 'approved', 'watch', 'rejected')
        AND EXISTS (
          SELECT 1 FROM rule_executions execution
          WHERE execution.research_job_id = job.id
            AND execution.data_version = job.data_version
            AND execution.rule_profile_id = job.rule_profile_id
            AND execution.rule_version = job.rule_profile_version
            AND execution.created_at <= insight.generated_at
        )
      ORDER BY job.updated_at DESC, insight.generated_at DESC, insight.rowid DESC
    `).all(
      this.getSettings().marketplace,
      entityId,
      ...mapping.entityTypes,
      ...mapping.jobTypes,
      this.getSettings().mode === 'live' ? 1 : 0,
    ) as DbRow[];

    for (const row of rows) {
      const insight = this.mapInsight(row);
      if (this.hasWorkflowEvidence(insight)) return insight;
    }
    return null;
  }

  workflowRequiredInsight(entityType: string, entityId: string, label = entityId): Insight {
    return {
      id: '',
      entityType,
      entityId,
      insightType: 'workflow_required',
      status: '数据不足',
      title: `${label}：尚无正式工作流结论`,
      summary: '当前页面只有确定性指标，没有可引用的当前版本 Research Job 结论。请创建或运行研究任务后再做判断。',
      facts: [],
      opportunities: [],
      risks: ['未找到同时匹配当前数据版本、规则版本、Prompt 版本与 Evidence 的研究结论'],
      recommendedActions: ['创建或打开对应 Research Job，完成数据校验、规则计算和 Evidence 绑定'],
      evidence: [],
      evidenceIds: [],
      confidence: 0,
      model: 'workflow-gate',
      dataVersion: 'workflow-required',
      generatedAt: new Date().toISOString(),
    };
  }

  getInsightByCacheKey(entityType: string, entityId: string, insightType: string, inputHash: string): Insight | null {
    const row = this.database.prepare(`
      SELECT * FROM ai_insights
      WHERE entity_type = ? AND entity_id = ? AND insight_type = ? AND input_hash = ?
      LIMIT 1
    `).get(entityType, entityId, insightType, inputHash) as DbRow | undefined;
    return row ? this.mapInsight(row) : null;
  }

  getDevelopmentProjects(): DevelopmentProject[] {
    const rows = this.database.prepare(`
      SELECT * FROM development_projects WHERE marketplace = ? ORDER BY updated_at DESC
    `).all(this.getSettings().marketplace) as DbRow[];
    return rows.map((row) => this.mapDevelopmentProject(row));
  }

  getDevelopmentProject(id: string): DevelopmentProject | null {
    const row = this.database.prepare(`
      SELECT * FROM development_projects WHERE id = ? AND marketplace = ?
    `).get(id, this.getSettings().marketplace) as DbRow | undefined;
    return row ? this.mapDevelopmentProject(row) : null;
  }

  getOpportunities(): OpportunityRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM opportunities WHERE marketplace = ? ORDER BY updated_at DESC
    `).all(this.getSettings().marketplace) as DbRow[];
    return rows.map((row) => this.mapOpportunity(row));
  }

  getOpportunity(id: string): OpportunityRecord | null {
    const row = this.database.prepare(`
      SELECT * FROM opportunities WHERE id = ? AND marketplace = ?
    `).get(id, this.getSettings().marketplace) as DbRow | undefined;
    return row ? this.mapOpportunity(row) : null;
  }

  getWatchlist(): WatchlistItem[] {
    const rows = this.database.prepare(`
      SELECT * FROM watchlist_items WHERE marketplace = ? ORDER BY anomaly DESC, created_at DESC
    `).all(this.getSettings().marketplace) as DbRow[];
    return rows.map((row) => ({
      id: stringValue(row.id),
      itemType: stringValue(row.item_type),
      itemId: stringValue(row.item_id),
      name: stringValue(row.name),
      frequency: stringValue(row.frequency) as WatchlistItem['frequency'],
      status: stringValue(row.status) as WatchlistItem['status'],
      lastRunAt: row.last_run_at === null ? null : stringValue(row.last_run_at),
      nextRunAt: row.next_run_at === null ? null : stringValue(row.next_run_at),
      latestFinding: stringValue(row.latest_finding),
      anomaly: booleanValue(row.anomaly),
    }));
  }

  getDataTasks(): DataTask[] {
    const rows = this.database.prepare(`
      SELECT * FROM data_tasks WHERE marketplace = ? ORDER BY created_at DESC
    `).all(this.getSettings().marketplace) as DbRow[];
    return rows.map((row) => this.mapDataTask(row));
  }

  getDataTask(id: string): DataTask | null {
    const row = this.database.prepare(`
      SELECT * FROM data_tasks WHERE id = ? AND marketplace = ?
    `).get(id, this.getSettings().marketplace) as DbRow | undefined;
    return row ? this.mapDataTask(row) : null;
  }

  getLatestResearchResult(id: string): {
    id: string;
    query: string;
    summary: string;
    nodes: unknown[];
    combinations: unknown[];
    opportunityIds: string[];
    tasksCreated: number;
    generatedAt: string;
    researchJobId?: string;
    evidenceIds?: string[];
    promptVersion?: string;
  } | null {
    const row = this.database.prepare('SELECT * FROM research_results WHERE id = ?').get(id) as DbRow | undefined;
    if (!row) return null;
    return {
      id: stringValue(row.id),
      query: stringValue(row.query),
      summary: stringValue(row.summary),
      nodes: jsonValue(row.nodes_json, []),
      combinations: jsonValue(row.combinations_json, []),
      opportunityIds: jsonValue(row.opportunity_ids_json, []),
      tasksCreated: numberValue(row.tasks_created),
      generatedAt: stringValue(row.generated_at),
      researchJobId: row.research_job_id === null ? undefined : stringValue(row.research_job_id),
      evidenceIds: jsonValue(row.evidence_ids_json, []),
      promptVersion: stringValue(row.prompt_version, 'legacy-v1'),
    };
  }

  getMarketGrowth(id: string): number | null {
    const pair = this.getMarketGrowthPair(id);
    return pair?.growth ?? null;
  }

  hasMarketGrowthBaseline(id: string): boolean {
    return this.getMarketGrowthPair(id) !== null;
  }

  private getMarketGrowthPair(id: string): SnapshotGrowthPair | null {
    const rows = this.getMarketSnapshotRows(id);
    return deriveSnapshotGrowth(rows.map((row) => ({
      id: stringValue(row.id),
      date: stringValue(row.date),
      value: nullableNumberValue(row.monthly_sales),
    })));
  }

  private mapMarketNode(row: DbRow): MarketNode {
    const latest = this.getMarketSnapshotRows(stringValue(row.id)).at(-1);
    return {
      id: stringValue(row.id),
      name: stringValue(row.name),
      parentId: row.parent_id === null ? null : stringValue(row.parent_id),
      level: numberValue(row.level),
      marketplace: stringValue(row.marketplace),
      categoryId: row.category_id === null ? undefined : stringValue(row.category_id),
      keywords: jsonValue(row.keywords_json, []),
      status: stringValue(row.status),
      snapshotAvailable: Boolean(latest),
      monthlySales: latest ? nullableNumberValue(latest.monthly_sales) : null,
      monthlyRevenue: latest ? nullableNumberValue(latest.monthly_revenue) : null,
      growth30d: this.getMarketGrowth(stringValue(row.id)),
      growth30dAvailable: this.hasMarketGrowthBaseline(stringValue(row.id)),
      productCount: latest ? nullableNumberValue(latest.product_count) : null,
      avgPrice: latest ? nullableNumberValue(latest.avg_price) : null,
      competitionScore: latest ? nullableNumberValue(row.competition_score) : null,
      opportunityScore: latest ? nullableNumberValue(row.opportunity_score) : null,
    };
  }

  private getMarketSnapshotRows(id: string): DbRow[] {
    const live = this.getSettings().mode === 'live';
    const rows = this.database.prepare(`
      SELECT * FROM market_snapshots WHERE market_node_id = ?
      ORDER BY observation_date, collected_at, id
    `).all(id) as DbRow[];
    const readableRows = live ? rows.filter((row) => isLiveObservationReadable(
      this.database, 'market', stringValue(row.id), stringValue(row.source_type),
      row.sync_run_id === null ? null : stringValue(row.sync_run_id),
    )) : rows;
    return this.authoritativeSnapshotRows(readableRows, 'market', id, MARKET_METRICS, 'monthly_sales');
  }

  private authoritativeSnapshotRows(
    rows: DbRow[], entityType: 'market' | 'product' | 'competitor', entityId: string,
    metrics: readonly string[], primaryMetric: string,
  ): DbRow[] {
    const byDate = new Map<string, DbRow[]>();
    for (const row of rows) {
      const date = stringValue(row.observation_date, stringValue(row.date));
      const candidates = byDate.get(date) ?? [];
      candidates.push(row);
      byDate.set(date, candidates);
    }
    const authority = new MetricAuthorityResolver(this.database);
    const live = this.getSettings().mode === 'live';
    return [...byDate.entries()].map(([date, candidates]) => {
      const resolve = (metric: string): MetricFact | null => {
        const resolution = authority.resolveMetric({
          entityType, entityId, metric, observationDate: date,
        });
        const selected = [resolution.selected, ...resolution.alternatives]
          .find((fact) => fact && (!live || fact.sourceType !== 'mock')) ?? null;
        if (entityType !== 'competitor'
          || (selected?.sourceRecordType === 'metric_fact' && selected.sourceType === 'mcp'
            && selected.sourceId === 'source-sellersprite-mcp')) return selected;

        // Pre-fix competitor syncs saved facts under 'product'. Keep those immutable
        // records usable until a canonical competitor fact exists for this metric.
        const historical = authority.resolveMetric({
          entityType: 'product', entityId, metric, observationDate: date,
        });
        return [historical.selected, ...historical.alternatives].find((fact) => (
          fact?.sourceRecordType === 'metric_fact' && fact.sourceType === 'mcp'
            && fact.sourceId === 'source-sellersprite-mcp'
        )) ?? selected;
      };
      const primary = resolve(primaryMetric);
      const representative = candidates.find((row) => row.id === primary?.id)
        ?? candidates.find((row) => (
          row.source_type === primary?.sourceType && row.source === primary.source
        ))
        ?? candidates.at(-1)!;
      const selected: DbRow = { ...representative, date, observation_date: date };
      const lineage: Record<string, MetricProvenance> = {};
      for (const metric of metrics) {
        const fact = resolve(metric);
        selected[metric] = fact?.value ?? null;
        if (fact) lineage[metric] = {
          sourceRecordId: fact.id,
          sourceRecordType: fact.sourceRecordType,
          source: fact.source,
          sourceType: fact.sourceType as Provenance['sourceType'],
          collectedAt: fact.collectedAt,
          period: fact.period ?? '',
          isEstimated: fact.isEstimated,
          confidence: fact.confidence,
        };
      }
      this.metricLineage.set(selected, lineage);
      if (primary) this.applyFactProvenance(selected, primary);
      return selected;
    });
  }

  private applyFactProvenance(row: DbRow, fact: MetricFact): void {
    row.source = fact.source;
    row.source_type = fact.sourceType;
    row.collected_at = fact.collectedAt;
    row.is_estimated = fact.isEstimated ? 1 : 0;
    row.confidence = fact.confidence;
    if (fact.period) row.period = fact.period;
  }

  private mapTrend(row: DbRow): TrendPoint {
    return {
      date: stringValue(row.date),
      sales: nullableNumberValue(row.monthly_sales),
      revenue: nullableNumberValue(row.monthly_revenue),
      avgPrice: nullableNumberValue(row.avg_price),
      productCount: nullableNumberValue(row.product_count),
      sellerCount: nullableNumberValue(row.seller_count),
      medianReviews: nullableNumberValue(row.median_reviews),
    };
  }

  private getMarketPath(id: string): Array<{ id: string; name: string }> {
    const result: Array<{ id: string; name: string }> = [];
    let cursor: string | null = id;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const row = this.database.prepare('SELECT id, name, parent_id FROM market_nodes WHERE id = ?').get(cursor) as DbRow | undefined;
      if (!row) break;
      result.unshift({ id: stringValue(row.id), name: stringValue(row.name) });
      cursor = row.parent_id === null ? null : stringValue(row.parent_id);
    }
    return result;
  }

  private mapProduct(row: DbRow): Product {
    const productId = stringValue(row.id);
    const snapshots = this.getProductSnapshots(productId);
    const latest = snapshots.at(-1)
      ?? (this.getSettings().mode === 'live'
        ? this.emptyProductSnapshot(productId)
        : this.mapJoinedSnapshot(row, productId));
    return {
      id: productId,
      asin: stringValue(row.asin),
      sku: row.sku === null ? undefined : stringValue(row.sku),
      internalName: row.internal_name === null ? undefined : stringValue(row.internal_name),
      brand: stringValue(row.brand),
      title: stringValue(row.title),
      imageUrl: stringValue(row.image_url),
      marketplace: stringValue(row.marketplace),
      productType: stringValue(row.product_type),
      isOwned: booleanValue(row.is_owned),
      marketNodeId: stringValue(row.market_node_id),
      marketPath: this.getMarketPath(stringValue(row.market_node_id)),
      keywords: jsonValue(row.keywords_json, []),
      monitoringEnabled: booleanValue(row.monitoring_enabled),
      latest,
    };
  }

  private mapOwnedSummary(row: DbRow): OwnedProductSummary {
    const product = this.mapProduct(row);
    const hasMarketSnapshots = this.getMarketSnapshotRows(product.marketNodeId).length > 0;
    const marketGrowth30dAvailable = hasMarketSnapshots && this.hasMarketGrowthBaseline(product.marketNodeId);
    const marketGrowth30d = marketGrowth30dAvailable ? this.getMarketGrowth(product.marketNodeId) : null;
    const relativePerformanceAvailable = marketGrowth30dAvailable && marketGrowth30d !== null
      && product.latest.growth30dAvailable && product.latest.growth30d !== null;
    const relative = relativePerformanceAvailable
      ? calculateRelativePerformance(product.latest.growth30d!, marketGrowth30d!)
      : { relativeDelta: null, performance: 'insufficient_data' as const };
    const snapshots = this.getProductSnapshots(product.id);
    const previous = snapshots.length > 1 ? snapshots[snapshots.length - 2] : undefined;
    const anomalies = detectProductAnomalies({
      growth7d: product.latest.growth7d,
      relativeDelta: relative.relativeDelta,
      currentBsr: product.latest.bsr,
      previousBsr: previous?.bsr,
      currentPrice: product.latest.price,
      previousPrice: previous?.price,
    });
    return {
      ...product,
      marketGrowth30d,
      marketGrowth30dAvailable,
      relativePerformanceAvailable,
      ...relative,
      anomalyCount: anomalies.length,
      insight: this.getCurrentWorkflowInsightForEntity('owned_product', product.id)
        ?? this.workflowRequiredInsight(
          'owned_product',
          product.id,
          product.internalName ?? product.sku ?? product.asin,
        ),
    };
  }

  private mapJoinedSnapshot(row: DbRow, productId: string): ProductSnapshot {
    if (row.snapshot_id === null || row.snapshot_id === undefined
      || (this.getSettings().mode === 'live' && row.snapshot_source_type === 'mock')) {
      const provenance: Provenance = {
        source: '尚未导入数据', sourceType: 'import', collectedAt: '', period: '30D',
        isEstimated: true, confidence: 0,
      };
      return {
        id: '', snapshotAvailable: false, productId, date: '', price: null, rating: null,
        reviewCount: null, bsr: null, estimatedSales: null, estimatedRevenue: null,
        sellerCount: null, growth7d: null, growth30d: null, growth30dAvailable: false,
        growth90d: null, provenance,
      };
    }
    return {
      id: stringValue(row.snapshot_id),
      snapshotAvailable: true,
      productId,
      date: stringValue(row.snapshot_date),
      price: nullableNumberValue(row.snapshot_price),
      rating: nullableNumberValue(row.snapshot_rating),
      reviewCount: nullableNumberValue(row.snapshot_review_count),
      bsr: nullableNumberValue(row.snapshot_bsr),
      estimatedSales: nullableNumberValue(row.snapshot_estimated_sales),
      estimatedRevenue: nullableNumberValue(row.snapshot_estimated_revenue),
      sellerCount: nullableNumberValue(row.snapshot_seller_count),
      growth7d: nullableNumberValue(row.snapshot_growth_7d),
      growth30d: null,
      growth30dAvailable: false,
      growth90d: nullableNumberValue(row.snapshot_growth_90d),
      provenance: {
        source: stringValue(row.snapshot_source),
        sourceType: stringValue(row.snapshot_source_type, 'import') as Provenance['sourceType'],
        collectedAt: stringValue(row.snapshot_collected_at),
        period: stringValue(row.snapshot_period),
        isEstimated: booleanValue(row.snapshot_is_estimated),
        confidence: numberValue(row.snapshot_confidence),
      },
    };
  }

  private emptyProductSnapshot(productId: string): ProductSnapshot {
    const provenance: Provenance = {
      source: '尚未导入数据', sourceType: 'import', collectedAt: '', period: '30D',
      isEstimated: true, confidence: 0,
    };
    return {
      id: '', snapshotAvailable: false, productId, date: '', price: null, rating: null,
      reviewCount: null, bsr: null, estimatedSales: null, estimatedRevenue: null,
      sellerCount: null, growth7d: null, growth30d: null, growth30dAvailable: false,
      growth90d: null, provenance,
    };
  }

  private mapProductSnapshot(row: DbRow, growth: SnapshotGrowthPair | null = null): ProductSnapshot {
    return {
      id: stringValue(row.id),
      snapshotAvailable: true,
      productId: stringValue(row.product_id),
      date: stringValue(row.date),
      price: nullableNumberValue(row.price),
      rating: nullableNumberValue(row.rating),
      reviewCount: nullableNumberValue(row.review_count),
      bsr: nullableNumberValue(row.bsr),
      estimatedSales: nullableNumberValue(row.estimated_sales),
      estimatedRevenue: nullableNumberValue(row.estimated_revenue),
      sellerCount: nullableNumberValue(row.seller_count),
      growth7d: nullableNumberValue(row.growth_7d),
      growth30d: growth?.growth ?? null,
      growth30dAvailable: growth !== null,
      growth90d: nullableNumberValue(row.growth_90d),
      provenance: this.provenanceFromRow(row),
      metricProvenance: this.metricLineage.get(row),
    };
  }

  private provenanceFromRow(row: DbRow): Provenance {
    return {
      source: stringValue(row.source),
      sourceType: stringValue(row.source_type, 'import') as Provenance['sourceType'],
      collectedAt: stringValue(row.collected_at),
      period: stringValue(row.period),
      isEstimated: booleanValue(row.is_estimated),
      confidence: numberValue(row.confidence),
    };
  }

  private mapInsight(row: DbRow): Insight {
    return {
      id: stringValue(row.id),
      entityType: stringValue(row.entity_type),
      entityId: stringValue(row.entity_id),
      insightType: stringValue(row.insight_type),
      status: stringValue(row.status),
      title: stringValue(row.title),
      summary: stringValue(row.summary),
      score: row.score === null ? undefined : numberValue(row.score),
      facts: jsonValue(row.facts_json, []),
      opportunities: jsonValue(row.opportunities_json, []),
      risks: jsonValue(row.risks_json, []),
      recommendedActions: jsonValue(row.recommendations_json, []),
      evidence: jsonValue(row.evidence_json, []),
      confidence: numberValue(row.confidence),
      model: stringValue(row.model),
      dataVersion: stringValue(row.data_version),
      generatedAt: stringValue(row.generated_at),
      researchJobId: row.research_job_id === null || row.research_job_id === undefined
        ? undefined
        : stringValue(row.research_job_id),
      evidenceIds: jsonValue(row.evidence_ids_json, []),
      promptVersion: stringValue(row.prompt_version, 'legacy-v1'),
      missingData: jsonValue(row.missing_data_json, []),
      possibleCauses: jsonValue(row.possible_causes_json, []),
      hardGate: row.hard_gate === null || row.hard_gate === undefined
        ? undefined
        : stringValue(row.hard_gate) as Insight['hardGate'],
      decision: row.decision_recommendation === null || row.decision_recommendation === undefined
        ? undefined
        : stringValue(row.decision_recommendation) as Insight['decision'],
    };
  }

  private emptyInsight(entityType: string, entityId: string, status: string): Insight {
    return {
      id: '', entityType, entityId, insightType: 'insufficient_data', status,
      title: '当前数据不足', summary: '当前数据不足，结论置信度低，建议先导入市场与产品快照。',
      facts: [], opportunities: [], risks: ['缺少可用历史快照'], recommendedActions: ['导入 CSV/XLSX 或连接数据源'],
      evidence: [], confidence: 0, model: 'rule-engine-v1', dataVersion: 'empty', generatedAt: new Date().toISOString(),
    };
  }

  private mapDevelopmentProject(row: DbRow): DevelopmentProject {
    const id = stringValue(row.id);
    const marketplace = stringValue(row.marketplace);
    const sourceOpportunityId = row.source_opportunity_id === null
      || row.source_opportunity_id === undefined
      ? null
      : stringValue(row.source_opportunity_id);
    const hasDirectWorkflow = Boolean(this.database.prepare(`
      SELECT 1 FROM research_jobs
      WHERE marketplace = ? AND entity_type = 'development_project' AND entity_id = ?
      LIMIT 1
    `).get(marketplace, id));
    const directWorkflowInsight = this.getCurrentWorkflowInsightForEntity('development_project', id);
    const inheritedDecisionRow = !hasDirectWorkflow && sourceOpportunityId
      ? this.database.prepare(`
          SELECT decision.*
          FROM decisions decision
          JOIN research_jobs job ON job.id = decision.research_job_id
          JOIN ai_insights insight ON insight.id = decision.ai_insight_id
          JOIN approvals approval ON approval.id = decision.approval_id
          JOIN reverse_reviews review ON review.id = decision.reverse_review_id
          WHERE decision.entity_type = 'development_project' AND decision.entity_id = ?
            AND decision.decision IN ('develop', 'test')
            AND job.marketplace = ? AND job.entity_type = 'opportunity' AND job.entity_id = ?
            AND job.status = 'approved'
            AND decision.data_version = job.data_version
            AND insight.entity_type = 'research_job' AND insight.entity_id = job.id
            AND insight.research_job_id = job.id AND insight.data_version = job.data_version
            AND insight.prompt_version = job.prompt_version
            AND approval.research_job_id = job.id AND approval.status = 'approved'
            AND approval.action = decision.decision
            AND approval.data_version = job.data_version
            AND approval.rule_profile_id = job.rule_profile_id
            AND approval.rule_profile_version = job.rule_profile_version
            AND approval.prompt_version = job.prompt_version
            AND approval.reverse_review_id = review.id
            AND review.research_job_id = job.id AND review.data_version = job.data_version
            AND review.rule_profile_id = job.rule_profile_id
            AND review.rule_profile_version = job.rule_profile_version
            AND review.prompt_version = job.prompt_version
            AND review.verdict IN ('proceed', 'proceed_with_caution')
            AND EXISTS (
              SELECT 1 FROM rule_executions execution
              WHERE execution.research_job_id = job.id
                AND execution.data_version = job.data_version
                AND execution.rule_profile_id = job.rule_profile_id
                AND execution.rule_version = job.rule_profile_version
                AND execution.hard_gate_status = 'pass'
            )
          ORDER BY decision.decided_at DESC, decision.rowid DESC LIMIT 1
        `).get(id, marketplace, sourceOpportunityId) as DbRow | undefined
      : undefined;
    const inheritedInsightCandidate = inheritedDecisionRow
      ? this.getInsightById(stringValue(inheritedDecisionRow.ai_insight_id))
      : null;
    const inheritedWorkflowInsight = inheritedInsightCandidate
      && this.hasWorkflowEvidence(inheritedInsightCandidate)
      ? inheritedInsightCandidate
      : null;
    const workflowInsight = directWorkflowInsight ?? inheritedWorkflowInsight;
    const hasWorkflow = hasDirectWorkflow || sourceOpportunityId !== null;
    const directDecisionRow = directWorkflowInsight?.researchJobId
      ? this.database.prepare(`
          SELECT * FROM decisions
          WHERE entity_type = 'development_project' AND entity_id = ?
            AND research_job_id = ? AND ai_insight_id = ? AND data_version = ?
          ORDER BY decided_at DESC, rowid DESC LIMIT 1
        `).get(
          id, directWorkflowInsight.researchJobId,
          directWorkflowInsight.id, directWorkflowInsight.dataVersion,
        ) as DbRow | undefined
      : undefined;
    const decisionRow = directDecisionRow
      ?? (inheritedWorkflowInsight ? inheritedDecisionRow : undefined)
      ?? (!hasWorkflow
        ? this.database.prepare(`
            SELECT * FROM decisions
            WHERE entity_type = 'development_project' AND entity_id = ?
              AND research_job_id IS NULL
            ORDER BY decided_at DESC, rowid DESC LIMIT 1
          `).get(id) as DbRow | undefined
        : undefined);
    const insightId = row.insight_id === null ? '' : stringValue(row.insight_id);
    const legacyInsight = insightId ? this.getInsightById(insightId) : null;
    const insight = workflowInsight
      ?? (hasWorkflow
        ? this.workflowRequiredInsight('development_project', id, stringValue(row.name))
        : legacyInsight ?? this.emptyInsight('development_project', id, stringValue(row.status)));
    return {
      id,
      marketNodeId: stringValue(row.market_node_id),
      name: stringValue(row.name),
      productType: stringValue(row.product_type),
      keywords: jsonValue(row.keywords_json, []),
      notes: stringValue(row.notes),
      marketplace: stringValue(row.marketplace),
      supplyChainRelation: stringValue(row.supply_chain_relation),
      createdAt: stringValue(row.created_at),
      marketSize: nullableNumberValue(row.market_size),
      growth30d: nullableNumberValue(row.growth_30d),
      competitionScore: nullableNumberValue(row.competition_score),
      opportunityScore: nullableNumberValue(row.opportunity_score),
      status: stringValue(row.status) as DevelopmentProject['status'],
      scoreBreakdown: jsonValue<ScoreBreakdown | null>(row.score_breakdown_json, null),
      insight,
      decision: decisionRow ? this.mapDecision(decisionRow) : undefined,
    };
  }

  private getInsightById(id: string): Insight | null {
    const row = this.database.prepare('SELECT * FROM ai_insights WHERE id = ?').get(id) as DbRow | undefined;
    return row ? this.mapInsight(row) : null;
  }

  private hasWorkflowEvidence(insight: Insight): boolean {
    const evidenceIds = [...new Set(insight.evidenceIds ?? [])];
    if (!insight.researchJobId || evidenceIds.length === 0 || insight.evidence.length === 0) {
      return false;
    }
    const live = this.getSettings().mode === 'live';
    if (live && insight.evidence.some((item) => (
      item.provenance.some((source) => source.sourceType === 'mock')
    ))) return false;
    const placeholders = evidenceIds.map(() => '?').join(',');
    const rows = this.database.prepare(`
      SELECT id FROM evidence_records
      WHERE research_job_id = ? AND data_version = ? AND id IN (${placeholders})
        AND (? = 0 OR source_type <> 'mock')
    `).all(insight.researchJobId, insight.dataVersion, ...evidenceIds, live ? 1 : 0) as DbRow[];
    return rows.length === evidenceIds.length;
  }

  private mapDecision(row: DbRow): DecisionRecord {
    return {
      id: stringValue(row.id),
      entityType: stringValue(row.entity_type),
      entityId: stringValue(row.entity_id),
      decision: stringValue(row.decision) as DecisionRecord['decision'],
      reason: stringValue(row.reason),
      aiInsightId: stringValue(row.ai_insight_id),
      dataVersion: stringValue(row.data_version),
      decidedBy: stringValue(row.decided_by),
      decidedAt: stringValue(row.decided_at),
      researchJobId: row.research_job_id === null ? undefined : stringValue(row.research_job_id),
      reverseReviewId: row.reverse_review_id === null ? undefined : stringValue(row.reverse_review_id),
      approvalId: row.approval_id === null ? undefined : stringValue(row.approval_id),
    };
  }

  private mapOpportunity(row: DbRow): OpportunityRecord {
    const id = stringValue(row.id);
    const decisionRow = this.database.prepare(`
      SELECT * FROM decisions WHERE entity_type = 'opportunity' AND entity_id = ?
      ORDER BY decided_at DESC LIMIT 1
    `).get(id) as DbRow | undefined;
    const decision = decisionRow ? this.mapDecision(decisionRow) : undefined;
    const rejectionReason = row.rejection_reason === null ? undefined : stringValue(row.rejection_reason);
    const baseSummary = stringValue(row.summary);
    const summary = decision && stringValue(row.status) === 'rejected'
      ? `${baseSummary} 淘汰原因：${decision.reason}；决策人：${decision.decidedBy}；决策时间：${decision.decidedAt}。`
      : baseSummary;
    return {
      id,
      name: stringValue(row.name),
      sourceType: stringValue(row.source_type),
      market: stringValue(row.market_name),
      opportunityScore: numberValue(row.opportunity_score),
      marketGrowth: numberValue(row.market_growth),
      competitionScore: numberValue(row.competition_score),
      priceRoom: stringValue(row.price_room),
      recommendedAction: stringValue(row.recommended_action),
      status: stringValue(row.status) as Opportunity['status'],
      summary,
      evidence: jsonValue(row.evidence_json, []),
      createdAt: stringValue(row.created_at),
      marketplace: stringValue(row.marketplace, 'US'),
      rejectionReason,
      decision,
    };
  }

  private mapDataTask(row: DbRow): DataTask {
    return {
      id: stringValue(row.id),
      syncRunId: row.sync_run_id === null || row.sync_run_id === undefined
        ? null : stringValue(row.sync_run_id),
      name: stringValue(row.name),
      taskType: stringValue(row.task_type),
      target: stringValue(row.target),
      sourceId: row.source_id === null ? null : stringValue(row.source_id),
      source: stringValue(row.source),
      marketplace: stringValue(row.marketplace, 'US'),
      status: stringValue(row.status) as DataTask['status'],
      startedAt: row.started_at === null ? null : stringValue(row.started_at),
      completedAt: row.completed_at === null ? null : stringValue(row.completed_at),
      total: numberValue(row.total),
      success: numberValue(row.success),
      failed: numberValue(row.failed),
      errorLog: row.error_log === null ? null : stringValue(row.error_log),
      researchJobId: row.research_job_id === null ? undefined : stringValue(row.research_job_id),
      createdAt: stringValue(row.created_at),
    };
  }
}

function nullablePercentile(value: number | null, population: Array<number | null>): number | null {
  if (value === null) return null;
  const valid = population.filter((candidate): candidate is number => candidate !== null);
  return valid.length ? percentileRank(value, valid) : null;
}

function average(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value !== null);
  if (valid.length === 0) return null;
  return Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length * 10) / 10;
}
