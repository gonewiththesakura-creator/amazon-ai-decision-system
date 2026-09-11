import { describe, expect, it } from 'vitest';
import {
  formatCompact,
  formatConfidence,
  formatCurrency,
  formatDecimal,
  formatInteger,
  formatPercent,
} from './format';

describe('numeric formatters', () => {
  it('renders missing and non-finite values as unavailable', () => {
    expect(formatInteger(null)).toBe('—');
    expect(formatDecimal(undefined)).toBe('—');
    expect(formatCompact(Number.NaN)).toBe('—');
    expect(formatCurrency(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatPercent(Number.NEGATIVE_INFINITY)).toBe('—');
    expect(formatConfidence(null)).toBe('—');
  });

  it('keeps a real zero distinguishable from missing data', () => {
    expect(formatInteger(0)).toBe('0');
    expect(formatCurrency(0)).not.toBe('—');
    expect(formatPercent(0)).toBe('0%');
    expect(formatConfidence(0)).toBe('0%');
  });
});
