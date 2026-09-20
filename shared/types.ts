export type DataMode = 'empty' | 'demo' | 'live';
export type Role = 'admin' | 'viewer';
export type TimeRange = '7D' | '30D' | '90D' | '180D' | '1Y';
export type PerformanceLevel =
  | 'insufficient_data'
  | 'strong_outperform'
  | 'outperform'
  | 'in_line'
  | 'underperform'
  | 'strong_underperform';
export type DecisionType = 'develop' | 'test' | 'watch' | 'reject';
export type TaskStatus = 'pending' | 'running' | 'success' | 'partial' | 'failed';
export type OpportunityStatus = 'pending_review' | 'researching' | 'promoted' | 'rejected';
export type RelationType = 'direct' | 'top100' | 'benchmark' | 'fast_growth' | 'price_peer';

export type ResearchJobType =
  | 'existing_market'
  | 'owned_product'
  | 'adjacent_product'
  | 'new_opportunity';
export type ResearchJobStatus =
  | 'draft'
  | 'planned'
  | 'collecting'
  | 'normalizing'
  | 'validating'
  | 'calculating'
  | 'analyzing'
  | 'reverse_review'
  | 'waiting_approval'
  | 'approved'
  | 'watch'
  | 'rejected'
  | 'monitoring'
  | 'failed'
  | 'needs_data';
export type ResearchStepType =
  | 'plan'
  | 'collect_market'
  | 'collect_products'
  | 'collect_keywords'
  | 'collect_reviews'
  | 'normalize'
  | 'validate'
  | 'calculate'
  | 'hard_gate'
  | 'score'
  | 'ai_analysis'
  | 'review_gap'
  | 'reverse_review'
  | 'approval'
  | 'snapshot'
  | 'report';
export type ResearchStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'needs_data';

export interface Provenance {
  source: string;
  sourceType: 'mock' | 'import' | 'mcp' | 'amazon' | 'manual';
  collectedAt: string;
  period: string;
  isEstimated: boolean;
  confidence: number;
}

export interface MetricProvenance extends Provenance {
  sourceRecordId: string;
  sourceRecordType: 'metric_fact' | 'snapshot';
}

export interface EvidenceMetric {
  name: string;
  label: string;
  value: number | string;
  unit?: string;
}

export interface Evidence {
  id: string;
  claim: string;
  metrics: EvidenceMetric[];
  provenance: Provenance[];
}

export interface Insight {
  id: string;
  entityType: string;
  entityId: string;
  insightType: string;
  status: string;
  title: string;
  summary: string;
  score?: number;
  facts: string[];
  opportunities: string[];
  risks: string[];
  recommendedActions: string[];
  evidence: Evidence[];
  confidence: number;
  model: string;
  dataVersion: string;
  generatedAt: string;
  researchJobId?: string;
  evidenceIds?: string[];
  promptVersion?: string;
  missingData?: string[];
  possibleCauses?: string[];
  hardGate?: 'pass' | 'reject' | 'needs_data';
  decision?: 'develop' | 'test' | 'watch' | 'reject' | 'needs_data';
}

export interface MarketNode {
  id: string;
  name: string;
  parentId: string | null;
  level: number;
  marketplace: string;
  categoryId?: string;
  keywords: string[];
  status: string;
  snapshotAvailable: boolean;
  monthlySales: number | null;
  monthlyRevenue: number | null;
  growth30d: number | null;
  growth30dAvailable: boolean;
  productCount: number | null;
  avgPrice: number | null;
  competitionScore: number | null;
  opportunityScore: number | null;
  children?: MarketNode[];
}

export interface TrendPoint {
  date: string;
  sales: number | null;
  revenue: number | null;
  avgPrice: number | null;
  productCount: number | null;
  sellerCount: number | null;
  medianReviews: number | null;
}

export interface MarketDetail {
  node: MarketNode;
  path: Array<{ id: string; name: string }>;
  kpis: {
    monthlySales: number | null;
    monthlyRevenue: number | null;
    productCount: number | null;
    sellerCount: number | null;
    brandCount: number | null;
    avgPrice: number | null;
    medianPrice: number | null;
    top10Share: number | null;
    top20Share: number | null;
    newProductShare: number | null;
    medianReviews: number | null;
    avgRating: number | null;
  };
  trends: TrendPoint[];
  tree: MarketNode[];
  priceBands: Array<{
    label: string;
    productCount: number;
    monthlySales: number;
    revenue: number;
    avgReviews: number;
    newProducts: number;
    growth: number;
  }>;
  concentration: Array<{ tier: string; share: number; avgPrice: number; avgSales: number }>;
  insight: Insight;
  provenance: Provenance;
  metricProvenance?: Record<string, MetricProvenance>;
}

export interface ProductSnapshot {
  id: string;
  snapshotAvailable: boolean;
  productId: string;
  date: string;
  price: number | null;
  rating: number | null;
  reviewCount: number | null;
  bsr: number | null;
  estimatedSales: number | null;
  estimatedRevenue: number | null;
  sellerCount: number | null;
  growth7d: number | null;
  growth30d: number | null;
  growth30dAvailable: boolean;
  growth90d: number | null;
  provenance: Provenance;
  metricProvenance?: Record<string, MetricProvenance>;
}

export interface Product {
  id: string;
  asin: string;
  sku?: string;
  internalName?: string;
  brand: string;
  title: string;
  imageUrl: string;
  marketplace: string;
  productType: string;
  isOwned: boolean;
  marketNodeId: string;
  marketPath?: Array<{ id: string; name: string }>;
  keywords?: string[];
  monitoringEnabled?: boolean;
  latest: ProductSnapshot;
}

export interface OwnedProductSummary extends Product {
  marketGrowth30d: number | null;
  marketGrowth30dAvailable: boolean;
  relativeDelta: number | null;
  relativePerformanceAvailable: boolean;
  performance: PerformanceLevel;
  anomalyCount: number;
  insight: Insight;
}

export interface Competitor extends Product {
  relationType: RelationType;
  similarityScore: number;
  relationReason: string;
  aiTags: string[];
  relationCreatedAt: string;
  lastVerifiedAt: string;
}

export interface OwnedProductDetail extends OwnedProductSummary {
  snapshots: ProductSnapshot[];
  percentiles: {
    sales: number | null;
    price: number | null;
    reviews: number | null;
    rating: number | null;
    growth: number | null;
  };
  comparisons: {
    market: { growth30d: number | null };
    direct: { growth30d: number | null; sampleSize: number };
    top20: { growth30d: number | null; sampleSize: number };
  };
  competitors: Competitor[];
}

export interface ScoreBreakdown {
  demand: number;
  growth: number;
  competition: number;
  newProductFriendly: number;
  priceRoom: number;
  concentration: number;
  confidence: number;
}

export interface DevelopmentProject {
  id: string;
  marketNodeId: string;
  name: string;
  productType: string;
  keywords: string[];
  notes: string;
  marketplace: string;
  supplyChainRelation: string;
  createdAt: string;
  marketSize: number | null;
  growth30d: number | null;
  competitionScore: number | null;
  opportunityScore: number | null;
  status: DecisionType;
  scoreBreakdown: ScoreBreakdown | null;
  insight: Insight;
  decision?: DecisionRecord;
}

export interface DecisionRecord {
  id: string;
  entityType: string;
  entityId: string;
  decision: DecisionType | 'approved' | 'needs_data';
  reason: string;
  aiInsightId: string;
  dataVersion: string;
  decidedBy: string;
  decidedAt: string;
  researchJobId?: string;
  reverseReviewId?: string;
  approvalId?: string;
}

export interface ResearchJobSummary {
  id: string;
  name: string;
  type: ResearchJobType;
  marketplace: string;
  status: ResearchJobStatus;
  entityType?: string;
  entityId?: string;
  ruleProfileId: string;
  ruleProfileVersion: number;
  isDemo: boolean;
  createdBy: string;
  dataVersion: string;
  promptVersion: string;
  missingDataCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface ResearchStep {
  id: string;
  researchJobId: string;
  stepType: ResearchStepType;
  status: ResearchStepStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  retryCount: number;
}

export interface NormalizedField<T = unknown> {
  value: T | null;
  source: string;
  sourceType: 'mock' | 'import' | 'mcp' | 'amazon' | 'manual';
  collectedAt: string;
  period: string;
  originalUnit: string;
  normalizedUnit: string;
  isEstimated: boolean;
  confidence: number;
}

export interface MissingDataItem {
  id: string;
  researchJobId: string;
  fieldName: string;
  label: string;
  missingReason: string;
  requiredForDecision: boolean;
  manualValidationRequired: boolean;
  status: 'open' | 'resolved' | 'waived';
  resolvedValue?: unknown;
  resolvedBy?: string;
  resolvedAt?: string;
  createdAt: string;
}

export interface WorkflowEvidence {
  id: string;
  researchJobId: string;
  insightId?: string;
  claim: string;
  metricName: string;
  metricValue: unknown;
  source: string;
  sourceType: 'mock' | 'import' | 'mcp' | 'amazon' | 'manual';
  sourceRecordId?: string;
  syncRunId?: string | null;
  collectedAt: string;
  period: string;
  isEstimated: boolean;
  calculation: string;
  confidence: number;
  dataVersion: string;
}

export interface RuleProfile {
  id: string;
  name: string;
  version: number;
  active: boolean;
  jobTypes: ResearchJobType[];
  hardGates: Record<string, unknown>;
  scoring: Record<string, unknown>;
  thresholds: Record<string, unknown>;
  createdAt: string;
}

export interface RuleExecution {
  id: string;
  researchJobId: string;
  ruleProfileId: string;
  ruleVersion: number;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  hardGateStatus: 'pass' | 'reject' | 'needs_data';
  score: number | null;
  dataVersion: string;
  createdAt: string;
}

export interface ScoreResult {
  id: string;
  researchJobId: string;
  ruleExecutionId: string;
  total: number;
  breakdown: {
    demandQuality: number;
    competitiveEntry: number;
    profitAndCashEfficiency: number;
    supplyChainFit: number;
    riskControl: number;
  };
  calculation: Record<string, unknown>;
  createdAt: string;
}

export interface ReverseReviewFailureMode {
  risk: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  evidenceIds: string[];
  resolved: boolean;
  requiredAction: string;
}

export interface ReverseReview {
  id: string;
  researchJobId: string;
  dataVersion: string;
  ruleProfileId: string;
  ruleProfileVersion: number;
  promptVersion: string;
  verdict: 'proceed' | 'proceed_with_caution' | 'needs_data' | 'reject';
  topFailureModes: ReverseReviewFailureMode[];
  unknowns: string[];
  recommendation: string;
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  researchJobId: string;
  dataVersion: string;
  ruleProfileId: string;
  ruleProfileVersion: number;
  promptVersion: string;
  reverseReviewId: string;
  action: string;
  status: 'pending' | 'approved' | 'watch' | 'needs_data' | 'rejected';
  requestedBy: string;
  requestedAt: string;
  decidedBy?: string;
  reason?: string;
  decidedAt?: string;
}

export interface ReviewInsight {
  id: string;
  researchJobId: string;
  issue: string;
  frequency: number;
  competitorsAffected: number;
  isCrossMarketIssue: boolean;
  supplyChainSolvable: boolean | null;
  costImpact: string | null;
  opportunityLevel: 'insufficient_evidence' | 'low' | 'medium' | 'high';
  evidenceIds: string[];
  dataVersion: string;
  createdAt: string;
}

export interface ResearchJobDetail extends ResearchJobSummary {
  input: Record<string, unknown>;
  taskBook: Record<string, unknown>;
  steps: ResearchStep[];
  latestRuleExecution?: RuleExecution;
  latestScoreResult?: ScoreResult;
  latestInsight?: Insight;
  reverseReview?: ReverseReview;
  approval?: ApprovalRecord;
  decision?: DecisionRecord;
  reviewInsights: ReviewInsight[];
}

export interface ResearchNode extends MarketNode {
  taskStatus: TaskStatus;
}

export interface Opportunity {
  id: string;
  name: string;
  sourceType: string;
  market: string;
  opportunityScore: number;
  marketGrowth: number;
  competitionScore: number;
  priceRoom: string;
  recommendedAction: string;
  status: OpportunityStatus;
  summary: string;
  evidence: Evidence[];
  createdAt: string;
  marketplace: string;
  rejectionReason?: string;
  decision?: DecisionRecord;
}

export interface ResearchResult {
  id: string;
  query: string;
  summary: string;
  nodes: ResearchNode[];
  combinations: Array<{
    name: string;
    items: string[];
    rationale: string;
    fit: 'recommended' | 'watch' | 'avoid';
  }>;
  opportunities: Opportunity[];
  tasksCreated: number;
  generatedAt: string;
  researchJobId?: string;
  evidenceIds?: string[];
  promptVersion?: string;
}

export interface WatchlistItem {
  id: string;
  itemType: string;
  itemId: string;
  name: string;
  frequency: 'manual' | 'daily' | 'weekly';
  status: 'active' | 'paused';
  lastRunAt: string | null;
  nextRunAt: string | null;
  latestFinding: string;
  anomaly: boolean;
}

export interface DataTask {
  id: string;
  syncRunId: string | null;
  name: string;
  taskType: string;
  target: string;
  sourceId: string | null;
  source: string;
  marketplace: string;
  status: TaskStatus;
  startedAt: string | null;
  completedAt: string | null;
  total: number;
  success: number;
  failed: number;
  errorLog: string | null;
  researchJobId?: string;
  createdAt: string;
}

export interface DataSource {
  id: string;
  name: string;
  type: 'mock' | 'import' | 'mcp' | 'amazon' | 'manual';
  status: 'connected' | 'disconnected' | 'needs_configuration';
  lastSyncAt: string | null;
  description: string;
}

export interface BriefingItem {
  id: string;
  severity: 'critical' | 'warning' | 'opportunity' | 'info';
  category: string;
  entityType: string;
  entityId: string;
  title: string;
  summary: string;
  metric: string;
  action: string;
  insight: Insight;
}

export interface DashboardData {
  generatedAt: string;
  briefing: BriefingItem[];
  summaries: {
    market: {
      monthlyRevenue: number | null;
      growth30d: number | null;
      growth90d: number | null;
      status: string;
      snapshotAvailable: boolean;
      growth30dAvailable: boolean;
    };
    skus: {
      outperform: number;
      inLine: number;
      underperform: number;
      anomalies: number;
      analyzable: number;
      pendingData: number;
    };
    development: {
      watching: number;
      recommended: number;
      riskRising: number;
      analyzable: number;
      pendingData: number;
    };
    opportunities: { foundThisWeek: number; pending: number; pooled: number };
  };
  suggestedQuestions: string[];
}

export interface IndexedTrendPoint {
  date: string;
  index: number;
  relativeToMarket: number | null;
}

export interface IndexedTrendSeries {
  id: string;
  label: string;
  kind: 'market' | 'owned_sku' | 'competitor_average';
  points: IndexedTrendPoint[];
}

export interface IndexedTrendExcludedSeries {
  id: string;
  label: string;
  reason: 'insufficient_history' | 'no_common_baseline';
}

export interface IndexedTrendComparisonMeta {
  commonBaselineDate: string | null;
  excludedSeries: IndexedTrendExcludedSeries[];
}

export type ExecutiveTrendSeries = IndexedTrendSeries;

export interface ExecutiveDashboardKpis {
  marketGrowth: number | null;
  marketGrowthLabel: string;
  outperformingSkus: number | null;
  totalSkus: number;
  attentionSkus: number | null;
  fastGrowthCompetitors: number | null;
}

export interface ExecutiveSkuPerformance {
  id: string;
  name: string;
  asin: string;
  skuGrowth: number | null;
  marketGrowth: number | null;
  relativeDelta: number | null;
  performance: PerformanceLevel;
  label: '跑赢' | '同步' | '跑输' | '数据不足';
  attention: boolean;
}

export interface ExecutiveDistributionItem {
  label: string;
  value: number;
  productCount?: number;
  monthlySales?: number;
  revenue?: number;
}

export interface ExecutiveMarketDistribution {
  concentration: ExecutiveDistributionItem[];
  priceBands: ExecutiveDistributionItem[];
}

export interface ExecutiveCompetitorGrowth {
  id: string;
  name: string;
  asin: string;
  growth: number;
  price: number | null;
  rating: number | null;
  reviews: number | null;
  tags: string[];
}

export interface ExecutiveInsightEvidence {
  claim: string;
  metrics: Array<{
    label: string;
    value: number | string;
    unit?: string;
  }>;
  sources: Provenance[];
  calculation: string | null;
}

export interface ExecutiveInsightLineage {
  dataVersion: string | null;
  ruleProfileId: string | null;
  ruleProfileVersion: number | null;
  promptVersion: string | null;
}

export interface ExecutiveDailyInsight {
  id: string;
  type: 'risk' | 'opportunity' | 'competitor' | 'positive' | 'data_warning';
  entityType: 'market' | 'owned_product' | 'development_project';
  entityId: string;
  entityName: string;
  title: string;
  summary: string;
  evidence: ExecutiveInsightEvidence[];
  lineage: ExecutiveInsightLineage;
  researchJobHref: string | null;
}

export interface ExecutiveDevelopmentOpportunity {
  id: string;
  name: string;
  scoreStatus: 'scored' | 'needs_data' | 'rejected';
  score: number | null;
  hardGate: 'pass' | 'needs_data' | 'reject';
  systemRecommendation: 'develop' | 'test' | 'watch' | 'reject' | 'needs_data';
  approvalStatus: 'not_required' | 'waiting' | 'approved' | 'watch' | 'rejected' | 'needs_data';
  approvedAction: string | null;
}

export interface ExecutiveResearchStatus {
  key: 'recommend_develop' | 'small_test' | 'watch' | 'do_not_develop' | 'needs_data';
  label: '建议开发' | '小规模验证' | '继续观察' | '暂不开发' | '待补数据';
  count: number;
}

export interface CoreBusinessFreshness {
  status: 'normal' | 'partial' | 'insufficient' | 'stale';
  label: '正常' | '部分未更新' | '数据不足' | '数据陈旧';
  message: string;
  marketUpdatedAt: string | null;
  ownedProductsUpdatedAt: string | null;
  competitorsUpdatedAt: string | null;
  oldestRequiredSnapshotAt: string | null;
  newestRequiredSnapshotAt: string | null;
  missingEntityIds: string[];
  isDemo: boolean;
}

export interface SystemSyncStatus {
  status: 'idle' | 'running' | 'partial' | 'failed' | 'success';
  latestTaskAt: string | null;
  source: string | null;
  message: string | null;
}

export interface ExecutiveSkuFocusCompetitor {
  id: string;
  name: string;
  asin: string;
  growth: number | null;
  price: number | null;
  rating: number | null;
  reviews: number | null;
  estimatedSales: number | null;
  tags: string[];
}

export interface ExecutiveSkuFocus {
  sku: {
    id: string;
    name: string;
    asin: string;
    sku: string | null;
  };
  market: { id: string; name: string };
  trendComparison: IndexedTrendSeries[];
  trendComparisonMeta: IndexedTrendComparisonMeta;
  operatingMetrics: {
    estimatedSales: number | null;
    estimatedRevenue: number | null;
    price: number | null;
    rating: number | null;
    reviews: number | null;
    bsr: number | null;
    growth30d: number | null;
    marketGrowth30d: number | null;
    relativeDelta: number | null;
  };
  directCompetitors: ExecutiveSkuFocusCompetitor[];
  insight: ExecutiveDailyInsight | null;
  missingDataLabels: string[];
}

export interface ExecutiveDashboardViewModel {
  generatedAt: string;
  range: TimeRange;
  marketplace: string;
  market: { id: string; name: string } | null;
  kpis: ExecutiveDashboardKpis;
  trendComparison: IndexedTrendSeries[];
  trendComparisonMeta: IndexedTrendComparisonMeta;
  ownedSkuPerformance: ExecutiveSkuPerformance[];
  marketDistribution: ExecutiveMarketDistribution;
  fastGrowthCompetitors: ExecutiveCompetitorGrowth[];
  dailyInsights: ExecutiveDailyInsight[];
  developmentOpportunities: ExecutiveDevelopmentOpportunity[];
  researchStatus: ExecutiveResearchStatus[];
  coreBusinessFreshness: CoreBusinessFreshness;
  systemSyncStatus: SystemSyncStatus;
  skuFocus: ExecutiveSkuFocus | null;
}

export type DataCoverageStatus = 'complete' | 'partial' | 'missing' | 'not_applicable';

export interface DataCoverageCounter {
  covered: number;
  total: number;
  status: DataCoverageStatus;
  label: '完整' | '部分覆盖' | '缺失' | '不适用';
}

export interface DataCoverageReport {
  generatedAt: string;
  marketplace: string;
  primaryMarket: DataCoverageCounter;
  activeOwnedProducts: DataCoverageCounter;
  coreCompetitors: DataCoverageCounter;
  history90d: DataCoverageCounter;
  amazonActual: DataCoverageCounter;
}

export interface AppSettings {
  mode: DataMode;
  role: Role;
  marketplace: string;
  currency: string;
  timezone: string;
  defaultMarketId: string;
  aiModel: string;
  refreshFrequency: 'manual' | 'daily' | 'weekly';
  lastSuccessfulSync: string | null;
}

export interface ApiResponse<T> {
  data: T;
  meta?: {
    mode: DataMode;
    generatedAt: string;
  };
}
