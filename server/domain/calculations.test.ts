import { describe, expect, it } from 'vitest';
import {
  calculateOpportunityScore,
  calculateMarketOpportunityMetrics,
  calculateRelativePerformance,
  detectProductAnomalies,
  median,
  opportunityStatus,
  percentileRank,
} from './calculations.js';

describe('calculateOpportunityScore', () => {
  it('adds the weighted components to a 100 point score', () => {
    expect(calculateOpportunityScore({
      demand: 18,
      growth: 17,
      competition: 15,
      newProductFriendly: 12,
      priceRoom: 8,
      concentration: 7,
      confidence: 4,
    })).toBe(81);
    expect(opportunityStatus(81)).toBe('强机会');
  });

  it('derives opportunity components only from observed market metrics', () => {
    expect(calculateMarketOpportunityMetrics({
      monthlyRevenue: 3_000_000,
      growth30d: 12,
      productCount: 500,
      medianReviews: 450,
      medianPrice: 40,
      top10Share: 22,
      top20Share: 38,
      confidence: 0.8,
    })).toMatchObject({
      competitionScore: 33.8,
      breakdown: { demand: 12, confidence: 4 },
    });
  });

  it('clamps invalid or excessive components', () => {
    expect(calculateOpportunityScore({
      demand: 99,
      growth: -3,
      competition: Number.NaN,
      newProductFriendly: 15,
      priceRoom: 10,
      concentration: 10,
      confidence: 5,
    })).toBe(60);
  });
});

describe('calculateRelativePerformance', () => {
  it.each([
    [25, 15, 10, 'strong_outperform'],
    [18, 15, 3, 'outperform'],
    [12, 15, -3, 'underperform'],
    [5, 15, -10, 'strong_underperform'],
    [12.1, 15, -2.9, 'in_line'],
  ] as const)('classifies %s versus %s at the specified boundaries', (
    sku,
    market,
    delta,
    performance,
  ) => {
    expect(calculateRelativePerformance(sku, market)).toEqual({
      relativeDelta: delta,
      performance,
    });
  });
});

describe('supporting statistics', () => {
  it('calculates midpoint percentiles and medians', () => {
    expect(percentileRank(20, [10, 20, 30, 40])).toBe(38);
    expect(median([9, 1, 5, 3])).toBe(4);
  });

  it('detects threshold-based anomalies', () => {
    expect(detectProductAnomalies({
      growth7d: -25,
      relativeDelta: -18,
      currentBsr: 150,
      previousBsr: 100,
      currentPrice: 45,
      previousPrice: 39,
    })).toEqual([
      'sales_drop_7d',
      'relative_underperformance',
      'bsr_change',
      'price_change',
    ]);
  });
});
