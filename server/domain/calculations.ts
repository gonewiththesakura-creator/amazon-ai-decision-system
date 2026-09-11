import type { PerformanceLevel, ScoreBreakdown } from '../../shared/types.js';

export const OPPORTUNITY_SCORE_LIMITS: Readonly<Record<keyof ScoreBreakdown, number>> = {
  demand: 20,
  growth: 20,
  competition: 20,
  newProductFriendly: 15,
  priceRoom: 10,
  concentration: 10,
  confidence: 5,
};

export interface MarketOpportunityMetricsInput {
  monthlyRevenue: number;
  growth30d: number;
  productCount: number;
  medianReviews: number;
  medianPrice: number;
  top10Share: number;
  top20Share: number;
  confidence: number;
}

export interface MarketOpportunityMetrics {
  breakdown: ScoreBreakdown;
  competitionScore: number;
  opportunityScore: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function calculateOpportunityScore(breakdown: ScoreBreakdown): number {
  const total = (Object.keys(OPPORTUNITY_SCORE_LIMITS) as Array<keyof ScoreBreakdown>)
    .reduce((sum, key) => sum + clamp(breakdown[key], 0, OPPORTUNITY_SCORE_LIMITS[key]), 0);
  return Math.round(total * 10) / 10;
}

export function calculateMarketOpportunityMetrics(
  input: MarketOpportunityMetricsInput,
): MarketOpportunityMetrics {
  const competitionScore = round1(clamp(
    input.top20Share * 0.6
      + input.top10Share * 0.25
      + Math.min(input.medianReviews / 100, 20)
      + Math.min(input.productCount / 500, 10),
    0,
    100,
  ));
  const breakdown: ScoreBreakdown = {
    demand: round1(clamp(input.monthlyRevenue / 250_000, 0, 20)),
    growth: round1(clamp((input.growth30d + 10) * 2 / 3, 0, 20)),
    competition: round1(clamp(20 - competitionScore / 5, 0, 20)),
    newProductFriendly: round1(clamp(15 - input.medianReviews / 100, 0, 15)),
    priceRoom: round1(clamp((input.medianPrice - 15) / 5, 0, 10)),
    concentration: round1(clamp(10 - input.top20Share / 10, 0, 10)),
    confidence: round1(clamp(input.confidence * 5, 0, 5)),
  };
  return { breakdown, competitionScore, opportunityScore: calculateOpportunityScore(breakdown) };
}

export function opportunityStatus(score: number): string {
  if (score >= 80) return '强机会';
  if (score >= 65) return '值得研究';
  if (score >= 50) return '继续观察';
  return '不建议';
}

export function calculateRelativePerformance(
  skuGrowth30d: number,
  marketGrowth30d: number,
): { relativeDelta: number; performance: PerformanceLevel } {
  const relativeDelta = Math.round((skuGrowth30d - marketGrowth30d) * 10) / 10;
  let performance: PerformanceLevel;

  if (relativeDelta >= 10) performance = 'strong_outperform';
  else if (relativeDelta >= 3) performance = 'outperform';
  else if (relativeDelta > -3) performance = 'in_line';
  else if (relativeDelta > -10) performance = 'underperform';
  else performance = 'strong_underperform';

  return { relativeDelta, performance };
}

export function percentileRank(value: number, population: number[]): number {
  if (population.length === 0) return 0;
  const valid = population.filter(Number.isFinite);
  if (valid.length === 0) return 0;
  const less = valid.filter((candidate) => candidate < value).length;
  const equal = valid.filter((candidate) => candidate === value).length;
  return Math.round(((less + equal * 0.5) / valid.length) * 100);
}

export function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function detectProductAnomalies(input: {
  growth7d: number | null;
  relativeDelta: number | null;
  currentBsr: number | null;
  previousBsr?: number | null;
  currentPrice: number | null;
  previousPrice?: number | null;
}): string[] {
  const anomalies: string[] = [];
  if (input.growth7d !== null && input.growth7d < -20) anomalies.push('sales_drop_7d');
  if (input.relativeDelta !== null && input.relativeDelta < -15) anomalies.push('relative_underperformance');

  if (input.currentBsr !== null && input.previousBsr && input.previousBsr > 0) {
    const bsrChange = Math.abs(input.currentBsr - input.previousBsr) / input.previousBsr * 100;
    if (bsrChange > 30) anomalies.push('bsr_change');
  }

  if (input.currentPrice !== null && input.previousPrice && input.previousPrice > 0) {
    const priceChange = Math.abs(input.currentPrice - input.previousPrice) / input.previousPrice * 100;
    if (priceChange > 10) anomalies.push('price_change');
  }
  return anomalies;
}
