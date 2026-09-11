import { describe, expect, it } from 'vitest';
import type { ReviewInsight, WorkflowEvidence } from '../../shared/types.js';
import { assessReverseReview, reverseReviewRequiredChecks } from './reverse-review-engine.js';

const evidence = [
  ['ip_risk', 'ev-ip', 'low'],
  ['moq_cost', 'ev-moq', 6000],
  ['growth_30d', 'ev-growth', 6.8],
  ['top10_sales_share', 'ev-concentration', 38],
  ['estimated_contribution_profit_rate', 'ev-profit', 28],
].map(([metricName, id, metricValue]) => ({
  id,
  researchJobId: 'job-1',
  claim: `${metricName} input`,
  metricName,
  metricValue,
  source: 'fixture',
  sourceType: 'manual',
  collectedAt: '2026-09-10T00:00:00.000Z',
  period: 'point_in_time',
  isEstimated: false,
  calculation: `validated ${metricName}`,
  confidence: 0.8,
  dataVersion: 'v1',
})) as WorkflowEvidence[];

const reviewInsights: ReviewInsight[] = [{
  id: 'review-insight-1',
  researchJobId: 'job-1',
  issue: '气味',
  frequency: 0.5,
  competitorsAffected: 2,
  isCrossMarketIssue: false,
  supplyChainSolvable: true,
  costImpact: 'medium',
  opportunityLevel: 'high',
  evidenceIds: ['ev-review-1'],
  dataVersion: 'v1',
  createdAt: '2026-09-10T00:00:00.000Z',
}];

describe('reverse review engine', () => {
  it('always audits all required categories and returns five evidence-aware failure modes', () => {
    const result = assessReverseReview({
      jobInput: {
        ip_risk: 'low',
        moq_cost: 6000,
        growth_30d: 6.8,
        top10_sales_share: 38,
        estimated_contribution_profit_rate: 28,
      },
      taskBook: { per_product_budget: 10000, seasonality_tolerance: 'medium' },
      suggestedDecision: 'test',
      evidence,
      reviewInsights,
    });

    expect(reverseReviewRequiredChecks()).toHaveLength(12);
    expect(result.checklist.map((item) => item.check)).toEqual(reverseReviewRequiredChecks());
    expect(result.checklist.every((item) => ['supported', 'risk', 'unknown'].includes(item.status))).toBe(true);
    expect(result.topFailureModes).toHaveLength(5);
    expect(result.verdict).toBe('proceed_with_caution');
    expect(result.topFailureModes[0]).toMatchObject({ severity: 'high', resolved: false });
    expect(result.topFailureModes.some((item) => item.evidenceIds.includes('ev-ip'))).toBe(true);
    expect(result.unknowns).toEqual(expect.arrayContaining([
      expect.stringMatching(/IP/),
      expect.stringMatching(/广告/),
      expect.stringMatching(/库存/),
    ]));
    expect(result.recommendation).toMatch(/不授权采购、付款、上线/);
  });

  it('derives a rejection instead of returning a fixed caution verdict', () => {
    const result = assessReverseReview({
      jobInput: { ip_risk: 'critical' },
      taskBook: {},
      suggestedDecision: 'test',
      evidence,
      reviewInsights: [],
    });
    expect(result.verdict).toBe('reject');
    expect(result.topFailureModes[0]).toMatchObject({ severity: 'critical', resolved: false });
  });
});
