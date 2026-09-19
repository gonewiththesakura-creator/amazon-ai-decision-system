import type { AppDatabase } from '../database/database.js';

export interface ResolveMetricInput {
  entityId: string;
  entityType?: 'product' | 'market';
  metric: string;
  observationDate: string;
}

export interface MetricFact {
  id: string;
  sourceType: string;
  source: string;
  value: number | null;
  isEstimated: boolean;
  confidence: number;
}

export interface MetricAuthorityResolution {
  selected: MetricFact | null;
  alternatives: MetricFact[];
  reason: string;
}

interface SnapshotRow {
  id: string;
  source_type: string;
  source: string;
  metric_value: number | null;
  is_estimated: number;
  confidence: number;
}

export class MetricAuthorityResolver {
  constructor(private readonly database: AppDatabase) {}

  resolveMetric(input: ResolveMetricInput): MetricAuthorityResolution {
    const entityType = input.entityType ?? 'product';
    const factRows = this.database.prepare(`
      SELECT id, source_type, source, numeric_value AS metric_value, is_estimated, confidence
      FROM metric_facts
      WHERE entity_type = ? AND entity_id = ? AND metric_name = ?
        AND observation_date = ? AND numeric_value IS NOT NULL
    `).all(entityType, input.entityId, input.metric, input.observationDate) as unknown as SnapshotRow[];
    const rows = factRows.length > 0
      ? factRows
      : this.legacyProductSnapshotFacts(input, entityType);
    const facts = rows.map(toFact).sort(compareAuthority);
    const [selected, ...alternatives] = facts;
    return {
      selected: selected ?? null,
      alternatives,
      reason: selected ? authorityReason(selected) : '该观察日期没有可用指标事实。',
    };
  }

  private legacyProductSnapshotFacts(input: ResolveMetricInput, entityType: 'product' | 'market'): SnapshotRow[] {
    if (entityType !== 'product' || !PRODUCT_SNAPSHOT_METRICS.has(input.metric)) return [];
    return this.database.prepare(`
      SELECT id, source_type, source, ${input.metric} AS metric_value, is_estimated, confidence
      FROM product_snapshots
      WHERE product_id = ? AND observation_date = ?
    `).all(input.entityId, input.observationDate) as unknown as SnapshotRow[];
  }
}

const PRODUCT_SNAPSHOT_METRICS = new Set(['estimated_sales', 'estimated_revenue']);

function toFact(row: SnapshotRow): MetricFact {
  return {
    id: row.id,
    sourceType: row.source_type,
    source: row.source,
    value: row.metric_value,
    isEstimated: row.is_estimated === 1,
    confidence: row.confidence,
  };
}

function compareAuthority(left: MetricFact, right: MetricFact): number {
  const priority = (fact: MetricFact): number => {
    if (fact.sourceType === 'amazon' && !fact.isEstimated) return 0;
    if (fact.sourceType === 'amazon') return 1;
    if (fact.sourceType === 'mcp') return 2;
    if (fact.sourceType === 'import') return 3;
    return 4;
  };
  return priority(left) - priority(right) || Number(right.confidence) - Number(left.confidence) || left.id.localeCompare(right.id);
}

function authorityReason(fact: MetricFact): string {
  if (fact.sourceType === 'amazon' && !fact.isEstimated) return 'Amazon 实际数据优先于估算数据。';
  if (fact.sourceType === 'amazon') return 'Amazon 数据优先于第三方来源。';
  if (fact.sourceType === 'mcp') return 'SellerSprite MCP 是市场与竞品指标的首选来源。';
  return '按可用来源优先级选择。';
}
