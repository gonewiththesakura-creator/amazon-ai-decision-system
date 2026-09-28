import type { AppDatabase } from '../database/database.js';
import { isLiveObservationReadable } from './live-observation-readability.js';

export interface ResolveMetricInput {
  entityId: string;
  entityType?: 'product' | 'market' | 'competitor';
  metric: string;
  observationDate: string;
  sourceId?: string;
}

export interface MetricFact {
  id: string;
  sourceRecordType: 'metric_fact' | 'snapshot';
  sourceType: string;
  source: string;
  value: number | null;
  isEstimated: boolean;
  confidence: number;
  sourceId: string | null;
  collectedAt: string;
  period: string | null;
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
  source_id?: string | null;
  collected_at: string;
  period?: string | null;
}

interface Candidate {
  fact: MetricFact;
  store: 'fact' | 'snapshot';
}

export class MetricAuthorityResolver {
  constructor(private readonly database: AppDatabase) {}

  resolveMetric(input: ResolveMetricInput): MetricAuthorityResolution {
    const entityType = input.entityType ?? 'product';
    const legacyMetric = input.metric.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    const factRows = this.database.prepare(`
      SELECT id, source_type, source, source_id, numeric_value AS metric_value,
        is_estimated, confidence, collected_at, NULL AS period
      FROM metric_facts
      WHERE entity_type = ? AND entity_id = ? AND metric_name IN (?, ?)
        AND observation_date = ? AND numeric_value IS NOT NULL
        AND (? IS NULL OR source_id = ?)
    `).all(entityType, input.entityId, input.metric, legacyMetric, input.observationDate, input.sourceId ?? null, input.sourceId ?? null) as unknown as SnapshotRow[];
    const readableFacts = factRows.filter((row) => this.isReadable('fact', row.id, row.source_type));
    const candidates: Candidate[] = [
      ...readableFacts.map((row) => ({ fact: toFact(row, 'metric_fact'), store: 'fact' as const })),
      ...this.legacySnapshotFacts(input, entityType)
        .map((row) => ({ fact: toFact(row), store: 'snapshot' as const })),
    ];
    const byProvider = new Map<string, Candidate>();
    for (const candidate of candidates) {
      const key = providerKey(candidate.fact);
      const previous = byProvider.get(key);
      if (!previous || compareWithinProvider(candidate, previous) < 0) byProvider.set(key, candidate);
    }
    const facts = [...byProvider.values()]
      .map((candidate) => candidate.fact)
      .sort((left, right) => compareAuthority(entityType, input.metric, left, right));
    const [selected, ...alternatives] = facts;
    return {
      selected: selected ?? null,
      alternatives,
      reason: selected ? authorityReason(selected) : '该观察日期没有可用指标事实。',
    };
  }

  private legacySnapshotFacts(input: ResolveMetricInput, entityType: 'product' | 'market' | 'competitor'): SnapshotRow[] {
    const market = entityType === 'market';
    const metrics = market ? MARKET_SNAPSHOT_METRICS : PRODUCT_SNAPSHOT_METRICS;
    if (!metrics.has(input.metric)) return [];
    const table = market ? 'market_snapshots' : 'product_snapshots';
    const entityColumn = market ? 'market_node_id' : 'product_id';
    const rows = this.database.prepare(`
      SELECT id, source_type, source, NULL AS source_id, ${input.metric} AS metric_value,
        is_estimated, confidence, collected_at, period
      FROM ${table}
      WHERE ${entityColumn} = ? AND observation_date = ? AND ${input.metric} IS NOT NULL
    `).all(input.entityId, input.observationDate) as unknown as SnapshotRow[];
    return rows.filter((row) => this.isReadable(
      entityType === 'market' ? 'market-snapshot' : 'snapshot', row.id, row.source_type,
    )).filter((row) => (
      input.sourceId === undefined
      || providerId(toFact(row)) === normalizeProviderId(input.sourceId)
    ));
  }

  private isReadable(kind: 'fact' | 'snapshot' | 'market-snapshot', id: string, sourceType: string): boolean {
    const live = (this.database.prepare(`SELECT mode FROM app_settings WHERE id = 1`).get() as {
      mode?: string;
    } | undefined)?.mode === 'live';
    if (!live) return true;
    if (sourceType === 'mock') return false;
    const table = kind === 'fact'
      ? 'metric_facts' : kind === 'market-snapshot' ? 'market_snapshots' : 'product_snapshots';
    const row = this.database.prepare(`SELECT sync_run_id AS syncRunId FROM ${table} WHERE id = ?`)
      .get(id) as { syncRunId: string | null } | undefined;
    const observationKind = kind === 'market-snapshot' ? 'market' : kind === 'snapshot' ? 'product' : kind;
    return isLiveObservationReadable(this.database, observationKind, id, sourceType, row?.syncRunId ?? null);
  }
}

const MARKET_SNAPSHOT_METRICS = new Set([
  'monthly_sales', 'monthly_revenue', 'product_count', 'seller_count', 'brand_count',
  'avg_price', 'median_price', 'avg_rating', 'median_reviews', 'top10_share',
  'top20_share', 'new_product_share',
]);
const PRODUCT_SNAPSHOT_METRICS = new Set([
  'price', 'rating', 'review_count', 'bsr', 'estimated_sales', 'estimated_revenue',
  'seller_count', 'growth_7d', 'growth_30d', 'growth_90d',
]);

function toFact(row: SnapshotRow, sourceRecordType: MetricFact['sourceRecordType'] = 'snapshot'): MetricFact {
  return {
    id: row.id,
    sourceRecordType,
    sourceType: row.source_type,
    source: row.source,
    value: row.metric_value,
    isEstimated: row.is_estimated === 1,
    confidence: row.confidence,
    sourceId: row.source_id ?? null,
    collectedAt: row.collected_at,
    period: row.period ?? null,
  };
}

function normalizeProviderId(sourceId: string): string {
  const value = sourceId.toLowerCase();
  return value.startsWith('source-') ? value.slice('source-'.length).replaceAll('-', '_') : value;
}

function providerId(fact: MetricFact): string {
  if (fact.sourceId) return normalizeProviderId(fact.sourceId);
  if (fact.sourceType === 'amazon') {
    return /\b(?:sp[ -]?)?api\b/i.test(fact.source) ? 'amazon_api' : 'amazon_import';
  }
  if (fact.sourceType === 'mcp' && /sellersprite|卖家精灵/i.test(fact.source)) return 'sellersprite_mcp';
  if (fact.sourceType === 'import' && /sellersprite|卖家精灵/i.test(fact.source)) return 'sellersprite_import';
  return '';
}

function providerKey(fact: MetricFact): string {
  return `${fact.sourceType}|${providerId(fact) || fact.source.toLowerCase()}`;
}

function compareWithinProvider(left: Candidate, right: Candidate): number {
  return (left.store === 'fact' ? 0 : 1) - (right.store === 'fact' ? 0 : 1)
    || right.fact.confidence - left.fact.confidence
    || right.fact.collectedAt.localeCompare(left.fact.collectedAt)
    || left.fact.id.localeCompare(right.fact.id);
}

function compareAuthority(entityType: string, metric: string, left: MetricFact, right: MetricFact): number {
  const priority = (fact: MetricFact): number => {
    const sourceId = providerId(fact);
    const amazonApi = fact.sourceType === 'amazon'
      && sourceId === 'amazon_api' && !fact.isEstimated;
    const amazonReport = fact.sourceType === 'amazon'
      && ['amazon_report', 'amazon_import'].includes(sourceId) && !fact.isEstimated;
    if (entityType === 'product' && ['estimated_sales', 'estimated_revenue'].includes(metric)) {
      if (amazonApi) return 0;
      if (amazonReport) return 1;
      if (fact.isEstimated) return 2;
      return 3;
    }
    if (entityType === 'market' || entityType === 'competitor') {
      if (fact.sourceType === 'mcp'
        && sourceId === 'sellersprite_mcp') return 0;
      if (fact.sourceType === 'import'
        && sourceId === 'sellersprite_import') return 1;
      return 2;
    }
    return 0;
  };
  return priority(left) - priority(right) || Number(right.confidence) - Number(left.confidence) || left.id.localeCompare(right.id);
}

function authorityReason(fact: MetricFact): string {
  if (fact.sourceType === 'amazon' && !fact.isEstimated) return 'Amazon 实际数据优先于估算数据。';
  if (fact.sourceType === 'amazon') return 'Amazon 数据优先于第三方来源。';
  if (fact.sourceType === 'mcp') return 'SellerSprite MCP 是市场与竞品指标的首选来源。';
  return '按可用来源优先级选择。';
}
