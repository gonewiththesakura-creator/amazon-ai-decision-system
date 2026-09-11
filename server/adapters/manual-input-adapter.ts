import type { NormalizedField } from '../../shared/types.js';

export interface ManualInputContext {
  source?: string;
  collectedAt?: string;
  period?: string;
  confidence?: number;
  units?: Record<string, { original: string; normalized: string }>;
}

/** Validated boundary for operator-supplied research and supply-chain facts. */
export class ManualInputAdapter {
  readonly id = 'manual-input';
  readonly name = 'Manual Input';

  normalize(
    input: Record<string, unknown>,
    context: ManualInputContext = {},
  ): Record<string, NormalizedField> {
    if (!isPlainObject(input)) throw new Error('Manual input must be a JSON object.');
    const confidence = context.confidence ?? 0.75;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error('Manual input confidence must be between 0 and 1.');
    }
    const collectedAt = context.collectedAt ?? new Date().toISOString();

    return Object.fromEntries(Object.entries(input).map(([field, value]) => {
      validateValue(field, value);
      const units = context.units?.[field];
      const normalized: NormalizedField = {
        value: value ?? null,
        source: context.source ?? this.name,
        sourceType: 'manual',
        collectedAt,
        period: context.period ?? 'point_in_time',
        originalUnit: units?.original ?? 'unitless',
        normalizedUnit: units?.normalized ?? units?.original ?? 'unitless',
        isEstimated: false,
        confidence,
      };
      return [field, normalized];
    }));
  }
}

function validateValue(field: string, value: unknown): void {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`Manual input field ${field} must be finite.`);
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`Manual input field ${field} is not JSON-compatible.`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
