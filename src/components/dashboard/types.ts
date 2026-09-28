import type { IndexedTrendSeries as SharedIndexedTrendSeries } from '../../../shared/types';

export type DashboardRange = '7D' | '30D' | '90D' | '180D' | '1Y';
export type DashboardTone = 'neutral' | 'positive' | 'warning' | 'critical' | 'info';

export interface ExecutiveKpiData {
  marketGrowth: number | null;
  marketGrowthLabel: string;
  outperformingSkus: number | null;
  totalSkus: number;
  attentionSkus: number | null;
  fastGrowthCompetitors: number | null;
}

export type IndexedTrendSeries = SharedIndexedTrendSeries;

export interface SkuRelativePerformanceItem {
  id: string;
  name: string;
  relativeDelta: number | null;
  performance: 'strong_outperform' | 'outperform' | 'in_line' | 'underperform' | 'strong_underperform' | 'insufficient_data';
  attention?: boolean;
}

export interface DistributionSlice {
  label: string;
  value: number | null;
  color?: string;
}

export interface CompetitorGrowthItem {
  id: string;
  name: string;
  asin: string;
  growth: number | null;
  price: number | null;
  rating: number | null;
  reviews: number | null;
  tags: string[];
}

export interface DashboardEvidenceMetric {
  label: string;
  value: string | number;
  unit?: string;
}

export interface DashboardEvidenceSource {
  source: string;
  collectedAt: string;
  period?: string;
}

export interface DashboardEvidenceItem {
  claim: string;
  metrics: DashboardEvidenceMetric[];
  sources: DashboardEvidenceSource[];
  calculation: string | null;
}

export interface DashboardInsightLineage {
  dataVersion: string | null;
  ruleProfileId: string | null;
  ruleProfileVersion: number | null;
  promptVersion: string | null;
}

export interface DashboardInsightItem {
  id: string;
  type: 'risk' | 'opportunity' | 'competitor' | 'positive' | 'data_warning';
  title: string;
  summary: string;
  evidence: DashboardEvidenceItem[];
  lineage: DashboardInsightLineage;
  researchJobHref: string | null;
}

export interface ResearchStatusItem {
  key: string;
  label: string;
  count: number;
  color?: string;
}

export type DataFreshnessState = 'normal' | 'partial' | 'insufficient' | 'stale';
