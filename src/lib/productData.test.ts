import { describe, expect, it } from 'vitest';
import {
  compareNullableMetric,
  hasMarketGrowthBaseline,
  hasTrustedMarketData,
  hasTrustedRelativePerformance,
} from './productData';

describe('hasTrustedRelativePerformance', () => {
  it('rejects placeholder values when a manually added SKU has no snapshots', () => {
    expect(hasTrustedRelativePerformance({
      latest: { id: '' },
      insight: { status: '数据不足' },
      marketGrowth30dAvailable: false,
    }, [])).toBe(false);
  });

  it('requires both recorded history and a conclusive insight', () => {
    const snapshot = {
      latest: { id: 'snapshot-1', growth30d: 4, growth30dAvailable: true },
      insight: { status: '基本同步' },
      marketGrowth30d: 2,
      marketGrowth30dAvailable: true,
      relativeDelta: 2,
      relativePerformanceAvailable: true,
    };
    expect(hasTrustedRelativePerformance(snapshot, [])).toBe(false);
    expect(hasTrustedRelativePerformance(snapshot, [{ id: 'snapshot-1' }])).toBe(true);
    expect(hasTrustedRelativePerformance({
      ...snapshot,
      latest: { id: 'snapshot-1', growth30d: 4, growth30dAvailable: true },
      insight: { status: '数据不足' },
    }, [{ id: 'snapshot-1' }])).toBe(false);
    expect(hasTrustedRelativePerformance({
      ...snapshot,
      marketGrowth30dAvailable: false,
    }, [{ id: 'snapshot-1' }])).toBe(false);
    expect(hasTrustedRelativePerformance({
      ...snapshot,
      latest: { id: 'snapshot-1', growth30dAvailable: false },
      relativePerformanceAvailable: false,
    }, [{ id: 'snapshot-1' }])).toBe(false);
  });
});

describe('hasTrustedMarketData', () => {
  it('does not treat a newly created market node as observed data', () => {
    expect(hasTrustedMarketData({ trends: [], node: { growth30dAvailable: false } })).toBe(false);
  });

  it('requires a dated snapshot and an explicit finite growth baseline', () => {
    expect(hasTrustedMarketData({
      trends: [{ date: '2026-09-09' }],
      node: { growth30dAvailable: false },
    })).toBe(true);
    expect(hasMarketGrowthBaseline({
      trends: [{ date: '2026-09-09' }],
      node: { growth30dAvailable: false },
    })).toBe(false);
    expect(hasMarketGrowthBaseline({
      trends: [{ date: '2026-09-09' }, { date: '2026-09-10' }],
      node: { growth30dAvailable: true, growth30d: 3.2 },
    })).toBe(true);
  });
});

describe('compareNullableMetric', () => {
  it('keeps missing metrics last in both sort directions without conflating zero', () => {
    const values = [null, 4, 0, undefined, -2];
    expect([...values].sort((left, right) => compareNullableMetric(left, right, true)))
      .toEqual([4, 0, -2, null, undefined]);
    expect([...values].sort((left, right) => compareNullableMetric(left, right, false)))
      .toEqual([-2, 0, 4, null, undefined]);
  });
});
