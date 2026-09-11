import type {
  DevelopmentProject,
  Evidence,
  ExecutiveCompetitorGrowth,
  ExecutiveDailyInsight,
  ExecutiveDashboardViewModel,
  ExecutiveDataStatus,
  ExecutiveDevelopmentOpportunity,
  ExecutiveDistributionItem,
  ExecutiveMarketDistribution,
  ExecutiveResearchStatus,
  ExecutiveSkuFocus,
  ExecutiveSkuFocusCompetitor,
  ExecutiveSkuPerformance,
  IndexedTrendPoint,
  IndexedTrendSeries,
  Insight,
  MarketDetail,
  OwnedProductDetail,
  OwnedProductSummary,
  ProductSnapshot,
  ResearchJobDetail,
  TimeRange,
  WorkflowEvidence,
} from '../../shared/types.js';
import type { AppDatabase } from '../database/database.js';
import { IntelligenceRepository } from '../repository/intelligence-repository.js';
import { WorkflowRepository } from '../repository/workflow-repository.js';

export interface RawTrendPoint {
  date: string;
  value: number | null;
}

export interface RawTrendSeries {
  id: string;
  label: string;
  kind: IndexedTrendSeries['kind'];
  points: RawTrendPoint[];
}

const RANGE_DAYS: Record<TimeRange, number> = {
  '7D': 7,
  '30D': 30,
  '90D': 90,
  '180D': 180,
  '1Y': 365,
};

const RESEARCH_STATUS_DEFINITIONS: ExecutiveResearchStatus[] = [
  { key: 'recommend_develop', label: '建议开发', count: 0 },
  { key: 'small_test', label: '小规模验证', count: 0 },
  { key: 'watch', label: '继续观察', count: 0 },
  { key: 'do_not_develop', label: '暂不开发', count: 0 },
  { key: 'needs_data', label: '待补数据', count: 0 },
];

/** Indexes a series against its first valid positive observation. */
export function indexTrendSeries(points: RawTrendPoint[]): IndexedTrendPoint[] | null {
  const byDate = new Map<string, number>();
  for (const point of points) {
    if (!Number.isFinite(point.value) || point.value === null || point.value < 0) continue;
    if (!Number.isFinite(dateTime(point.date))) continue;
    byDate.set(point.date, point.value);
  }
  const valid = [...byDate.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((left, right) => dateTime(left.date) - dateTime(right.date));
  const baseIndex = valid.findIndex((point) => point.value > 0);
  if (baseIndex < 0) return null;
  const indexed = valid.slice(baseIndex).map((point) => ({
    date: point.date,
    index: round1(point.value / valid[baseIndex].value * 100),
  }));
  return indexed.length >= 2 ? indexed : null;
}

export class ExecutiveDashboardService {
  constructor(
    private readonly database: AppDatabase,
    private readonly intelligence: IntelligenceRepository,
    private readonly workflow: WorkflowRepository,
  ) {}

  getDashboard(range: TimeRange, skuId?: string): ExecutiveDashboardViewModel {
    const settings = this.intelligence.getSettings();
    const owned = this.intelligence.getOwnedProducts();
    const market = settings.defaultMarketId
      ? this.intelligence.getMarket(settings.defaultMarketId)
      : null;
    const formalOwnedInsights = new Map(owned.map((product) => [
      product.id,
      this.intelligence.getCurrentWorkflowInsightForEntity('owned_product', product.id),
    ]));
    const rawTrend = this.generalTrendSeries(market, owned);
    const trendComparison = buildIndexedSeries(rawTrend, range);
    const marketGrowth = market?.node.growth30dAvailable
      ? market.node.growth30d
      : null;
    const ownedSkuPerformance = this.ownedPerformance(owned, formalOwnedInsights);
    const fastGrowth = this.fastGrowthCompetitors(owned, settings.marketplace);
    const developmentOpportunities = this.developmentOpportunities(
      this.intelligence.getDevelopmentProjects(),
    );
    const dailyInsights = this.dailyInsights(
      market,
      owned,
      formalOwnedInsights,
    );

    return {
      generatedAt: new Date().toISOString(),
      range,
      marketplace: settings.marketplace,
      market: market ? { id: market.node.id, name: market.node.name } : null,
      kpis: {
        marketGrowth,
        marketGrowthLabel: marketGrowthLabel(marketGrowth),
        outperformingSkus: ownedSkuPerformance.some((item) => item.relativeDelta !== null)
          ? ownedSkuPerformance.filter((item) => item.label === '跑赢').length
          : null,
        totalSkus: ownedSkuPerformance.length,
        attentionSkus: ownedSkuPerformance.some((item) => (
          item.relativeDelta !== null || isFormalInsight(formalOwnedInsights.get(item.id) ?? null)
        )) ? ownedSkuPerformance.filter((item) => item.attention).length : null,
        fastGrowthCompetitors: fastGrowth.total,
      },
      trendComparison,
      ownedSkuPerformance,
      marketDistribution: buildMarketDistribution(market),
      fastGrowthCompetitors: fastGrowth.items,
      dailyInsights,
      developmentOpportunities,
      researchStatus: buildResearchStatus(developmentOpportunities),
      dataStatus: this.dataStatus(market, owned),
      skuFocus: skuId ? this.skuFocus(skuId, range) : null,
    };
  }

  private generalTrendSeries(
    market: MarketDetail | null,
    owned: OwnedProductSummary[],
  ): RawTrendSeries[] {
    const series: RawTrendSeries[] = [];
    if (market) {
      series.push({
        id: `market:${market.node.id}`,
        label: market.node.name,
        kind: 'market',
        points: market.trends.map((point) => ({ date: point.date, value: point.sales })),
      });
    }
    for (const product of owned) {
      series.push({
        id: `sku:${product.id}`,
        label: productName(product),
        kind: 'owned_sku',
        points: this.intelligence.getProductSnapshots(product.id).map((point) => ({
          date: point.date,
          value: point.estimatedSales,
        })),
      });
    }
    return series;
  }

  private ownedPerformance(
    owned: OwnedProductSummary[],
    formalInsights: Map<string, Insight | null>,
  ): ExecutiveSkuPerformance[] {
    return owned.map((product) => {
      const formalInsight = formalInsights.get(product.id) ?? null;
      const underperforming = ['underperform', 'strong_underperform'].includes(product.performance);
      const attention = underperforming || insightMarksAttention(formalInsight);
      return {
        id: product.id,
        name: productName(product),
        asin: product.asin,
        skuGrowth: product.latest.growth30d,
        marketGrowth: product.marketGrowth30d,
        relativeDelta: product.relativeDelta,
        performance: product.performance,
        label: performanceLabel(product.performance),
        attention,
      };
    }).sort((left, right) => compareNullableDescending(left.relativeDelta, right.relativeDelta));
  }

  private fastGrowthCompetitors(
    owned: OwnedProductSummary[],
    marketplace: string,
  ): { total: number | null; items: ExecutiveCompetitorGrowth[] } {
    const saved = new Map<string, ExecutiveCompetitorGrowth>();
    const fastGrowthIds = new Set<string>();
    let hasSavedCompetitors = false;
    for (const product of owned) {
      for (const competitor of this.intelligence.getCompetitors(product.id)) {
        if (competitor.marketplace !== marketplace) continue;
        hasSavedCompetitors = true;
        const isSavedGrowthFact = competitor.relationType === 'fast_growth'
          || competitor.aiTags.some((tag) => /fast.?growth|growth.?anomaly|高增长|增长异常/i.test(tag));
        if (!competitor.latest.growth30dAvailable || competitor.latest.growth30d === null) continue;
        if (isSavedGrowthFact) fastGrowthIds.add(competitor.id);
        const tags = unique([
          ...competitor.aiTags,
          relationTag(competitor.relationType),
        ]);
        const existing = saved.get(competitor.id);
        if (existing) {
          existing.tags = unique([...existing.tags, ...tags]);
          continue;
        }
        saved.set(competitor.id, {
          id: competitor.id,
          name: competitorName(competitor.brand, competitor.title),
          asin: competitor.asin,
          growth: competitor.latest.growth30d,
          price: competitor.latest.price,
          rating: competitor.latest.rating,
          reviews: competitor.latest.reviewCount,
          tags,
        });
      }
    }
    const all = [...saved.values()].sort((left, right) => right.growth - left.growth);
    return { total: hasSavedCompetitors ? fastGrowthIds.size : null, items: all.slice(0, 10) };
  }

  private dailyInsights(
    market: MarketDetail | null,
    owned: OwnedProductSummary[],
    formalOwnedInsights: Map<string, Insight | null>,
  ): ExecutiveDailyInsight[] {
    const candidates: Array<{ priority: number; item: ExecutiveDailyInsight }> = [];
    if (market) {
      const insight = this.intelligence.getCurrentWorkflowInsightForEntity('market', market.node.id);
      if (isFormalInsight(insight)) {
        candidates.push({
          priority: insight.status === 'opportunity' ? 2 : 3,
          item: toDailyInsight(
            this.workflow,
            insight,
            'market',
            market.node.id,
            market.node.name,
            market.node.growth30d !== null && market.node.growth30d < 0
              ? 'risk'
              : insight.status === 'opportunity' ? 'opportunity' : 'positive',
          ),
        });
      }
    }
    for (const product of owned) {
      const insight = formalOwnedInsights.get(product.id) ?? null;
      if (!isFormalInsight(insight)) continue;
      const risk = ['underperform', 'strong_underperform'].includes(insight.status);
      candidates.push({
        priority: risk ? 0 : 3,
        item: toDailyInsight(
          this.workflow,
          insight,
          'owned_product',
          product.id,
          productName(product),
          risk ? 'risk' : 'positive',
        ),
      });
    }
    const used = new Set<string>();
    return candidates
      .sort((left, right) => left.priority - right.priority)
      .map((candidate) => candidate.item)
      .filter((item) => {
        if (used.has(item.id)) return false;
        used.add(item.id);
        return true;
      })
      .slice(0, 5);
  }

  private developmentOpportunities(
    projects: DevelopmentProject[],
  ): ExecutiveDevelopmentOpportunity[] {
    return projects.map((project) => {
      const direct = this.workflow.getCurrentResearchJobForEntity('development_project', project.id);
      const inherited = !direct && project.decision?.researchJobId
        ? this.workflow.getResearchJob(project.decision.researchJobId)
        : null;
      return developmentOpportunity(project, direct ?? inherited);
    }).sort(compareDevelopmentOpportunities);
  }

  private dataStatus(
    market: MarketDetail | null,
    owned: OwnedProductSummary[],
  ): ExecutiveDataStatus {
    const settings = this.intelligence.getSettings();
    const latestTask = this.database.prepare(`
      SELECT status, started_at, completed_at, created_at
      FROM data_tasks WHERE marketplace = ?
      ORDER BY julianday(COALESCE(completed_at, started_at, created_at)) DESC, rowid DESC LIMIT 1
    `).get(settings.marketplace) as {
      status: string;
      started_at: string | null;
      completed_at: string | null;
      created_at: string;
    } | undefined;
    const latestSuccessfulTask = this.database.prepare(`
      SELECT started_at, completed_at, created_at
      FROM data_tasks WHERE marketplace = ? AND status = 'success'
      ORDER BY julianday(COALESCE(completed_at, started_at, created_at)) DESC, rowid DESC LIMIT 1
    `).get(settings.marketplace) as {
      started_at: string | null;
      completed_at: string | null;
      created_at: string;
    } | undefined;
    const latestCoreSnapshotAt = newestTimestamp([
      market?.provenance.collectedAt,
      ...owned
        .filter((product) => product.latest.snapshotAvailable)
        .map((product) => product.latest.provenance.collectedAt),
    ].filter((value): value is string => Boolean(value)));
    const latestSuccessfulTaskAt = latestSuccessfulTask
      ? newestTimestamp([
          latestSuccessfulTask.completed_at,
          latestSuccessfulTask.started_at,
          latestSuccessfulTask.created_at,
        ].filter((value): value is string => Boolean(value)))
      : null;
    const updatedAt = newestTimestamp([
      latestCoreSnapshotAt,
      latestSuccessfulTaskAt,
    ].filter((value): value is string => Boolean(value)));
    const taskAt = latestTask
      ? newestTimestamp([
          latestTask.completed_at,
          latestTask.started_at,
          latestTask.created_at,
        ].filter((value): value is string => Boolean(value)))
      : null;
    const taskIsNewer = Boolean(taskAt && (!updatedAt || dateTime(taskAt) >= dateTime(updatedAt)));
    const marketReady = Boolean(market?.trends.some((point) => isUsableMetric(point.sales)));
    const skuSnapshots = owned.filter((product) => (
      product.latest.snapshotAvailable && isUsableMetric(product.latest.estimatedSales)
    )).length;
    const comparableSkus = owned.filter((product) => (
      product.latest.growth30dAvailable && product.relativeDelta !== null
    )).length;
    const allCoreDataReady = marketReady && owned.length > 0
      && skuSnapshots === owned.length && comparableSkus === owned.length;

    if (latestTask?.status === 'failed' && taskIsNewer) {
      return {
        status: 'failed', label: '同步失败',
        message: updatedAt
          ? '最近一次同步失败，当前仍展示上一次合法快照。'
          : '最近一次同步失败，当前还没有可展示的合法快照。',
        updatedAt, isDemo: settings.mode === 'demo',
      };
    }
    if (latestTask && ['partial', 'pending', 'running'].includes(latestTask.status) && taskIsNewer) {
      return {
        status: 'partial', label: '部分未更新',
        message: '部分数据尚未更新，当前继续展示已完成校验的快照。',
        updatedAt, isDemo: settings.mode === 'demo',
      };
    }
    if (!marketReady || owned.length === 0 || skuSnapshots === 0 || comparableSkus === 0) {
      return {
        status: 'insufficient', label: '数据不足',
        message: '市场或自有 SKU 缺少可用快照。',
        updatedAt, isDemo: settings.mode === 'demo',
      };
    }
    if (!allCoreDataReady) {
      return {
        status: 'partial', label: '部分未更新',
        message: '部分 SKU 尚无可用快照，已保留其余合法数据。',
        updatedAt, isDemo: settings.mode === 'demo',
      };
    }
    return {
      status: 'normal', label: '正常', message: '市场与自有 SKU 数据可用。',
      updatedAt, isDemo: settings.mode === 'demo',
    };
  }

  private skuFocus(skuId: string, range: TimeRange): ExecutiveSkuFocus | null {
    const product = this.intelligence.getOwnedProduct(skuId);
    if (!product) return null;
    const market = this.intelligence.getMarket(product.marketNodeId);
    const marketplace = this.intelligence.getSettings().marketplace;
    const direct = product.competitors
      .filter((competitor) => competitor.marketplace === marketplace && competitor.relationType === 'direct');
    const rawSeries: RawTrendSeries[] = [
      {
        id: `sku:${product.id}`,
        label: productName(product),
        kind: 'owned_sku',
        points: product.snapshots.map(snapshotSalesPoint),
      },
    ];
    if (market) {
      rawSeries.push({
        id: `market:${market.node.id}`,
        label: market.node.name,
        kind: 'market',
        points: market.trends.map((point) => ({ date: point.date, value: point.sales })),
      });
    }
    const competitorAverage = directCompetitorAverage(
      direct.map((competitor) => this.intelligence.getProductSnapshots(competitor.id)),
    );
    if (competitorAverage.length > 0) {
      rawSeries.push({
        id: 'direct-competitor-average', label: '直接竞品平均',
        kind: 'competitor_average', points: competitorAverage,
      });
    }
    const formalInsight = this.intelligence.getCurrentWorkflowInsightForEntity('owned_product', product.id);
    const currentJob = this.workflow.getCurrentResearchJobForEntity('owned_product', product.id);
    const missingDataLabels = this.focusMissingData(product, market, direct.length, currentJob);
    return {
      sku: {
        id: product.id,
        name: productName(product),
        asin: product.asin,
        sku: product.sku ?? null,
      },
      market: {
        id: market?.node.id ?? '',
        name: market?.node.name ?? '所属市场数据不可用',
      },
      trendComparison: buildIndexedSeries(rawSeries, range),
      operatingMetrics: {
        estimatedSales: product.latest.estimatedSales,
        estimatedRevenue: product.latest.estimatedRevenue,
        price: product.latest.price,
        rating: product.latest.rating,
        reviews: product.latest.reviewCount,
        bsr: product.latest.bsr,
        growth30d: product.latest.growth30d,
        marketGrowth30d: product.marketGrowth30d,
        relativeDelta: product.relativeDelta,
      },
      directCompetitors: direct
        .map(toFocusCompetitor)
        .sort((left, right) => compareNullableDescending(left.estimatedSales, right.estimatedSales))
        .slice(0, 5),
      insight: isFormalInsight(formalInsight)
        ? toDailyInsight(
            this.workflow,
            formalInsight,
            'owned_product',
            product.id,
            productName(product),
            insightMarksAttention(formalInsight) ? 'risk' : 'positive',
          )
        : null,
      missingDataLabels,
    };
  }

  private focusMissingData(
    product: OwnedProductDetail,
    market: MarketDetail | null,
    directCompetitorCount: number,
    currentJob: ResearchJobDetail | null,
  ): string[] {
    const labels = currentJob
      ? this.workflow.getMissingData(currentJob.id)
          .filter((item) => item.status === 'open')
          .map((item) => friendlyMissingDataLabel(item.fieldName, item.label))
      : ['广告投放数据', '流量数据', '转化率数据', '退货数据'];
    if (!product.latest.snapshotAvailable) labels.push('SKU 经营快照');
    if (!product.latest.growth30dAvailable) labels.push('SKU 历史销量快照');
    if (!market?.node.growth30dAvailable) labels.push('所属市场历史快照');
    if (directCompetitorCount === 0) labels.push('直接竞品组');
    return unique(labels);
  }
}

export function buildIndexedSeries(series: RawTrendSeries[], range: TimeRange): IndexedTrendSeries[] {
  const anchor = newestTrendTime(series.flatMap((item) => item.points));
  if (anchor === null) return [];
  const cutoff = anchor - RANGE_DAYS[range] * 24 * 60 * 60 * 1_000;
  return series.flatMap((item) => {
    const points = item.points.filter((point) => {
      const time = dateTime(point.date);
      return Number.isFinite(time) && time >= cutoff && time <= anchor;
    });
    const indexed = indexTrendSeries(points);
    return indexed ? [{ id: item.id, label: item.label, kind: item.kind, points: indexed }] : [];
  });
}

function buildMarketDistribution(market: MarketDetail | null): ExecutiveMarketDistribution {
  if (!market) return { concentration: [], priceBands: [] };
  return {
    concentration: concentrationParts(market),
    priceBands: priceBandParts(market),
  };
}

function concentrationParts(market: MarketDetail): ExecutiveDistributionItem[] {
  const tiers = new Map(market.concentration.flatMap((item) => {
    const share = finiteNumber(item.share);
    return share === null ? [] : [[item.tier.toUpperCase().replaceAll(/[^A-Z0-9]/g, ''), share] as const];
  }));
  const top10 = validShare(tiers.get('TOP10') ?? market.kpis.top10Share);
  if (top10 === null) return [];
  const top50 = validShare(tiers.get('TOP50'));
  if (top50 !== null && top50 >= top10) {
    return [
      { label: 'TOP10', value: round1(top10) },
      { label: 'TOP11-50', value: round1(top50 - top10) },
      { label: '其他', value: round1(100 - top50) },
    ];
  }
  const top20 = validShare(tiers.get('TOP20') ?? market.kpis.top20Share);
  if (top20 !== null && top20 >= top10) {
    return [
      { label: 'TOP10', value: round1(top10) },
      { label: 'TOP11-20', value: round1(top20 - top10) },
      { label: '其他', value: round1(100 - top20) },
    ];
  }
  return [
    { label: 'TOP10', value: round1(top10) },
    { label: '其他', value: round1(100 - top10) },
  ];
}

function priceBandParts(market: MarketDetail): ExecutiveDistributionItem[] {
  const bands = market.priceBands.flatMap((band) => {
    const monthlySales = finiteNumber(band.monthlySales);
    return monthlySales === null || monthlySales < 0 ? [] : [{ band, monthlySales }];
  });
  const total = bands.reduce((sum, item) => sum + item.monthlySales, 0);
  if (total <= 0) return [];
  return bands.map(({ band, monthlySales }) => ({
    label: band.label,
    value: round1(monthlySales / total * 100),
    monthlySales,
    ...(finiteNumber(band.productCount) === null ? {} : { productCount: band.productCount }),
    ...(finiteNumber(band.revenue) === null ? {} : { revenue: band.revenue }),
  }));
}

function developmentOpportunity(
  project: DevelopmentProject,
  job: ResearchJobDetail | null,
): ExecutiveDevelopmentOpportunity {
  const execution = job?.latestRuleExecution;
  const score = job?.latestScoreResult;
  const lineageValid = Boolean(
    job
      && execution
      && execution.dataVersion === job.dataVersion
      && execution.ruleProfileId === job.ruleProfileId
      && execution.ruleVersion === job.ruleProfileVersion,
  );
  const recommendation = researchRecommendation(job);
  if (lineageValid && (execution?.hardGateStatus === 'reject' || job?.status === 'rejected'
    || recommendation === 'reject')) {
    return {
      id: project.id, name: project.name, status: 'rejected', score: null,
      hardGate: execution?.hardGateStatus ?? 'reject', recommendation: 'reject',
    };
  }
  if (lineageValid && execution?.hardGateStatus === 'pass' && score
    && score.ruleExecutionId === execution.id && Number.isFinite(score.total)) {
    return {
      id: project.id, name: project.name, status: 'scored', score: score.total,
      hardGate: 'pass', recommendation,
    };
  }
  return {
    id: project.id, name: project.name, status: 'needs_data', score: null,
    hardGate: execution?.hardGateStatus === 'reject' ? 'reject' : 'needs_data',
    recommendation: 'needs_data',
  };
}

function researchRecommendation(
  job: ResearchJobDetail | null,
): ExecutiveDevelopmentOpportunity['recommendation'] {
  const candidate = job?.approval?.status === 'approved'
    ? job.approval.action
    : 'watch';
  return ['develop', 'test', 'watch', 'reject', 'needs_data'].includes(candidate ?? '')
    ? candidate as ExecutiveDevelopmentOpportunity['recommendation']
    : 'watch';
}

function compareDevelopmentOpportunities(
  left: ExecutiveDevelopmentOpportunity,
  right: ExecutiveDevelopmentOpportunity,
): number {
  const rank = { scored: 0, needs_data: 1, rejected: 2 } as const;
  if (rank[left.status] !== rank[right.status]) return rank[left.status] - rank[right.status];
  return compareNullableDescending(left.score, right.score);
}

function buildResearchStatus(
  opportunities: ExecutiveDevelopmentOpportunity[],
): ExecutiveResearchStatus[] {
  const counts = new Map(RESEARCH_STATUS_DEFINITIONS.map((item) => [item.key, 0]));
  for (const opportunity of opportunities) {
    let key: ExecutiveResearchStatus['key'];
    if (opportunity.status === 'needs_data') key = 'needs_data';
    else if (opportunity.status === 'rejected') key = 'do_not_develop';
    else if (opportunity.recommendation === 'develop') key = 'recommend_develop';
    else if (opportunity.recommendation === 'test') key = 'small_test';
    else key = 'watch';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return RESEARCH_STATUS_DEFINITIONS.map((item) => ({ ...item, count: counts.get(item.key) ?? 0 }));
}

function directCompetitorAverage(snapshots: ProductSnapshot[][]): RawTrendPoint[] {
  if (snapshots.length === 0) return [];
  const valuesByDate = new Map<string, Map<number, number>>();
  snapshots.forEach((productSnapshots, productIndex) => {
    for (const snapshot of productSnapshots) {
      if (!isUsableMetric(snapshot.estimatedSales)) continue;
      const values = valuesByDate.get(snapshot.date) ?? new Map<number, number>();
      values.set(productIndex, snapshot.estimatedSales);
      valuesByDate.set(snapshot.date, values);
    }
  });
  return [...valuesByDate.entries()]
    .filter(([, values]) => values.size === snapshots.length)
    .map(([date, values]) => ({
      date,
      value: round1([...values.values()].reduce((sum, value) => sum + value, 0) / values.size),
    }))
    .sort((left, right) => dateTime(left.date) - dateTime(right.date));
}

function toFocusCompetitor(
  competitor: OwnedProductDetail['competitors'][number],
): ExecutiveSkuFocusCompetitor {
  return {
    id: competitor.id,
    name: competitorName(competitor.brand, competitor.title),
    asin: competitor.asin,
    growth: competitor.latest.growth30d,
    price: competitor.latest.price,
    rating: competitor.latest.rating,
    reviews: competitor.latest.reviewCount,
    estimatedSales: competitor.latest.estimatedSales,
    tags: unique(['直接竞品', ...competitor.aiTags]),
  };
}

function toDailyInsight(
  workflow: WorkflowRepository,
  insight: Insight,
  entityType: ExecutiveDailyInsight['entityType'],
  entityId: string,
  entityName: string,
  type: ExecutiveDailyInsight['type'],
): ExecutiveDailyInsight {
  const requestedJob = insight.researchJobId
    ? workflow.getResearchJob(insight.researchJobId)
    : null;
  const job = requestedJob?.dataVersion === insight.dataVersion
    && requestedJob.latestInsight?.id === insight.id
    ? requestedJob
    : null;
  const declaredEvidenceIds = new Set(insight.evidenceIds ?? []);
  const currentEvidenceById = new Map(
    (job ? workflow.getEvidence(job.id) : [])
      .filter((item) => declaredEvidenceIds.has(item.id))
      .map((item) => [item.id, item]),
  );
  return {
    id: insight.id,
    type,
    entityType,
    entityId,
    entityName,
    title: insight.title,
    summary: insight.summary,
    evidence: insight.evidence.map((item) => (
      toExecutiveEvidence(item, currentEvidenceById.get(item.id))
    )),
    lineage: {
      dataVersion: job?.dataVersion ?? null,
      ruleProfileId: job?.ruleProfileId ?? null,
      ruleProfileVersion: job?.ruleProfileVersion ?? null,
      promptVersion: job?.promptVersion ?? null,
    },
    researchJobHref: job ? `/research-jobs/${encodeURIComponent(job.id)}` : null,
  };
}

function toExecutiveEvidence(evidence: Evidence, workflowEvidence?: WorkflowEvidence) {
  return {
    claim: evidence.claim,
    metrics: evidence.metrics.map((metric) => ({
      label: friendlyEvidenceMetricLabel(metric.name, metric.label),
      value: metric.value,
      ...(metric.unit ? { unit: metric.unit } : {}),
    })),
    sources: evidence.provenance,
    calculation: nonEmptyText(workflowEvidence?.calculation),
  };
}

const EVIDENCE_METRIC_LABELS: Record<string, string> = {
  sku_growth_30d: 'SKU 30D 增长',
  market_growth_30d: '市场 30D 增长',
  relative_delta: '相对市场差',
  direct_competitor_growth_30d: '直接竞品 30D 平均增长',
  top100_growth_30d: 'TOP100 30D 平均增长',
  monthly_sales: '月销量',
  monthly_revenue: '月销售额',
  avg_price: '平均价格',
  top10_share: 'TOP10 销量占比',
  top20_share: 'TOP20 销量占比',
};

function friendlyEvidenceMetricLabel(name: string, existingLabel: string): string {
  const key = name.trim().toLowerCase();
  const labelKey = existingLabel.trim().toLowerCase();
  const known = EVIDENCE_METRIC_LABELS[key] ?? EVIDENCE_METRIC_LABELS[labelKey];
  if (known) return known;
  const label = existingLabel.trim() || name.trim();
  return label.replace(/_/g, ' ');
}

function nonEmptyText(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isFormalInsight(insight: Insight | null): insight is Insight {
  return Boolean(
    insight
      && insight.entityType === 'research_job'
      && insight.researchJobId
      && insight.evidenceIds?.length
      && insight.evidence.length,
  );
}

function insightMarksAttention(insight: Insight | null): boolean {
  if (!isFormalInsight(insight)) return false;
  return ['underperform', 'strong_underperform'].includes(insight.status)
    || /异常|风险|跑输|underperform|anomaly|risk/i.test(`${insight.status} ${insight.insightType}`);
}

function performanceLabel(performance: OwnedProductSummary['performance']): ExecutiveSkuPerformance['label'] {
  if (['strong_outperform', 'outperform'].includes(performance)) return '跑赢';
  if (performance === 'in_line') return '同步';
  if (['underperform', 'strong_underperform'].includes(performance)) return '跑输';
  return '数据不足';
}

function marketGrowthLabel(growth: number | null): string {
  if (growth === null) return '历史数据不足';
  if (growth >= 5) return '稳定增长';
  if (growth <= -5) return '市场回落';
  return '基本稳定';
}

function friendlyMissingDataLabel(fieldName: string, storedLabel: string): string {
  const labels: Record<string, string> = {
    sessions: '流量数据',
    traffic: '流量数据',
    conversion_rate: '转化率数据',
    ad_spend: '广告投放数据',
    advertising: '广告投放数据',
    return_rate: '退货数据',
    direct_competitor_history: '直接竞品历史数据',
    top100_history: 'TOP100 商品历史数据',
    price_band_history: '价格带历史数据',
    submarket_history: '细分市场历史数据',
    market_growth_30d: '所属市场 30 日历史数据',
    sku_growth_30d: 'SKU 30 日历史数据',
  };
  if (labels[fieldName]) return labels[fieldName];
  if (storedLabel && !storedLabel.includes('_') && !/^[a-z\d ]+$/i.test(storedLabel)) return storedLabel;
  return '其他待补业务数据';
}

function snapshotSalesPoint(snapshot: ProductSnapshot): RawTrendPoint {
  return { date: snapshot.date, value: snapshot.estimatedSales };
}

function productName(product: OwnedProductSummary | OwnedProductDetail): string {
  return product.internalName ?? product.sku ?? product.asin;
}

function competitorName(brand: string, title: string): string {
  return title.toLowerCase().startsWith(brand.toLowerCase()) ? title : `${brand} ${title}`;
}

function relationTag(relationType: OwnedProductDetail['competitors'][number]['relationType']): string {
  const labels = {
    direct: '直接竞品',
    top100: '头部',
    benchmark: '标杆',
    fast_growth: '高增长',
    price_peer: '同价带',
  } as const;
  return labels[relationType];
}

function compareNullableDescending(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

function newestTrendTime(points: RawTrendPoint[]): number | null {
  const valid = points
    .filter((point) => point.value !== null && Number.isFinite(point.value) && point.value >= 0)
    .map((point) => dateTime(point.date))
    .filter(Number.isFinite);
  return valid.length ? Math.max(...valid) : null;
}

function newestTimestamp(values: string[]): string | null {
  return values.reduce<string | null>((latest, value) => {
    if (!Number.isFinite(dateTime(value))) return latest;
    if (!latest || dateTime(value) > dateTime(latest)) return value;
    return latest;
  }, null);
}

function dateTime(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function validShare(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 && number <= 100 ? number : null;
}

function isUsableMetric(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
