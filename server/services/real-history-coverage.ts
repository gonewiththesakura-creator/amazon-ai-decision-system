import type { AppDatabase } from '../database/database.js';
import { isLiveObservationReadable, type ObservationKind } from './live-observation-readability.js';

const REAL_SOURCE_TYPES = "'mcp', 'amazon', 'import'";
const MARKET_METRICS = `(
  snapshot.product_count IS NOT NULL OR snapshot.seller_count IS NOT NULL
  OR snapshot.brand_count IS NOT NULL OR snapshot.monthly_sales IS NOT NULL
  OR snapshot.monthly_revenue IS NOT NULL OR snapshot.avg_price IS NOT NULL
  OR snapshot.median_price IS NOT NULL OR snapshot.avg_rating IS NOT NULL
  OR snapshot.median_reviews IS NOT NULL OR snapshot.top10_share IS NOT NULL
  OR snapshot.top20_share IS NOT NULL OR snapshot.new_product_share IS NOT NULL
)`;
const PRODUCT_METRICS = `(
  snapshot.price IS NOT NULL OR snapshot.rating IS NOT NULL
  OR snapshot.review_count IS NOT NULL OR snapshot.bsr IS NOT NULL
  OR snapshot.estimated_sales IS NOT NULL OR snapshot.estimated_revenue IS NOT NULL
  OR snapshot.seller_count IS NOT NULL OR snapshot.growth_7d IS NOT NULL
  OR snapshot.growth_30d IS NOT NULL OR snapshot.growth_90d IS NOT NULL
)`;

interface ObservationDateRow {
  id: string;
  entityId: string;
  sourceType: string;
  syncRunId: string | null;
  observationDay: number | null;
  kind: ObservationKind;
}

export interface HistorySpan {
  days: number;
  observationDates: number;
}

export function validMarketHistorySpan(
  database: AppDatabase,
  marketplace: string,
  marketId: string | null,
): HistorySpan {
  if (!marketId) return emptySpan();
  const snapshots = database.prepare(`
    SELECT snapshot.id, snapshot.market_node_id AS entityId,
      snapshot.source_type AS sourceType, snapshot.sync_run_id AS syncRunId,
      julianday(COALESCE(snapshot.observation_date, snapshot.date)) AS observationDay,
      'market' AS kind
    FROM market_snapshots snapshot
    JOIN market_nodes market ON market.id = snapshot.market_node_id
    WHERE market.marketplace = ? AND snapshot.market_node_id = ?
      AND snapshot.source_type IN (${REAL_SOURCE_TYPES}) AND ${MARKET_METRICS}
  `).all(marketplace, marketId) as unknown as ObservationDateRow[];
  const facts = database.prepare(`
    SELECT fact.id, fact.entity_id AS entityId, fact.source_type AS sourceType,
      fact.sync_run_id AS syncRunId, julianday(fact.observation_date) AS observationDay,
      'fact' AS kind
    FROM metric_facts fact
    WHERE fact.entity_type = 'market' AND fact.marketplace = ? AND fact.entity_id = ?
      AND fact.source_type IN (${REAL_SOURCE_TYPES}) AND fact.numeric_value IS NOT NULL
  `).all(marketplace, marketId) as unknown as ObservationDateRow[];
  return spanForRows(database, [...snapshots, ...facts]);
}

export function validProductHistorySpans(
  database: AppDatabase,
  marketplace: string,
  productIds: string[],
): Map<string, HistorySpan> {
  const spans = new Map(productIds.map((id) => [id, emptySpan()]));
  if (productIds.length === 0) return spans;
  const placeholders = productIds.map(() => '?').join(', ');
  const snapshots = database.prepare(`
    SELECT snapshot.id, snapshot.product_id AS entityId,
      snapshot.source_type AS sourceType, snapshot.sync_run_id AS syncRunId,
      julianday(COALESCE(snapshot.observation_date, snapshot.date)) AS observationDay,
      'product' AS kind
    FROM product_snapshots snapshot
    JOIN products product ON product.id = snapshot.product_id
    WHERE product.marketplace = ? AND snapshot.product_id IN (${placeholders})
      AND snapshot.source_type IN (${REAL_SOURCE_TYPES}) AND ${PRODUCT_METRICS}
  `).all(marketplace, ...productIds) as unknown as ObservationDateRow[];
  const facts = database.prepare(`
    SELECT fact.id, fact.entity_id AS entityId, fact.source_type AS sourceType,
      fact.sync_run_id AS syncRunId, julianday(fact.observation_date) AS observationDay,
      'fact' AS kind
    FROM metric_facts fact
    WHERE fact.entity_type IN ('product', 'competitor') AND fact.marketplace = ?
      AND fact.entity_id IN (${placeholders})
      AND fact.source_type IN (${REAL_SOURCE_TYPES}) AND fact.numeric_value IS NOT NULL
  `).all(marketplace, ...productIds) as unknown as ObservationDateRow[];
  const byEntity = new Map<string, ObservationDateRow[]>();
  for (const row of [...snapshots, ...facts]) {
    const rows = byEntity.get(row.entityId) ?? [];
    rows.push(row);
    byEntity.set(row.entityId, rows);
  }
  for (const productId of productIds) {
    spans.set(productId, spanForRows(database, byEntity.get(productId) ?? []));
  }
  return spans;
}

function spanForRows(database: AppDatabase, rows: ObservationDateRow[]): HistorySpan {
  const dates = new Set<number>();
  for (const row of rows) {
    if (row.observationDay === null || !Number.isFinite(row.observationDay)) continue;
    if (!isLiveObservationReadable(
      database, row.kind, row.id, row.sourceType, row.syncRunId,
    )) continue;
    dates.add(row.observationDay);
  }
  if (dates.size === 0) return emptySpan();
  const ordered = [...dates].sort((left, right) => left - right);
  return {
    days: Math.max(0, Math.floor(ordered[ordered.length - 1]! - ordered[0]!)),
    observationDates: dates.size,
  };
}

function emptySpan(): HistorySpan {
  return { days: 0, observationDates: 0 };
}
