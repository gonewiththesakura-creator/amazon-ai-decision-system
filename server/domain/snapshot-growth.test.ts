import { describe, expect, it } from 'vitest';
import { deriveSnapshotGrowth } from './snapshot-growth.js';

describe('snapshot growth', () => {
  it('derives growth from the nearest 21-45 day positive baseline', () => {
    const result = deriveSnapshotGrowth([
      { id: 'jan', date: '2026-01-01', value: 500 },
      { id: 'aug', date: '2026-08-10', value: 1000 },
      { id: 'sep', date: '2026-09-09', value: 1120 },
    ]);
    expect(result).toMatchObject({ growth: 12, elapsedDays: 30, baseline: { id: 'aug' } });
  });

  it('does not call an old or zero baseline 30-day growth', () => {
    expect(deriveSnapshotGrowth([
      { id: 'jan', date: '2026-01-01', value: 500 },
      { id: 'sep', date: '2026-09-09', value: 1120 },
    ])).toBeNull();
    expect(deriveSnapshotGrowth([
      { id: 'aug', date: '2026-08-10', value: 0 },
      { id: 'sep', date: '2026-09-09', value: 1120 },
    ])).toBeNull();
  });

  it('does not convert a missing latest or baseline metric into zero', () => {
    expect(deriveSnapshotGrowth([
      { id: 'aug', date: '2026-08-10', value: 1000 },
      { id: 'sep', date: '2026-09-09', value: null },
    ])).toBeNull();
    expect(deriveSnapshotGrowth([
      { id: 'aug', date: '2026-08-10', value: undefined },
      { id: 'sep', date: '2026-09-09', value: 1120 },
    ])).toBeNull();
  });
});
