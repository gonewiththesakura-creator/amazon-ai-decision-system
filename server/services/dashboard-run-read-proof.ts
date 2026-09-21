import type { AppDatabase } from '../database/database.js';
import type { MetricProvenance, ProductSnapshot, TrendPoint } from '../../shared/types.js';
import { deriveSnapshotGrowth } from '../domain/snapshot-growth.js';
import { IntelligenceRepository } from '../repository/intelligence-repository.js';
import { MetricAuthorityResolver } from './metric-authority-resolver.js';

export interface DashboardRunReadProofInput {
  runId: string;
  marketId: string;
  ownedProductIds: string[];
}

export interface DashboardRunReadProof {
  passed: boolean;
  marketVerified: boolean;
  verifiedOwnedProducts: number;
  requiredOwnedProducts: number;
}

const MARKET_METRICS = {
  monthlySales: 'monthly_sales', monthlyRevenue: 'monthly_revenue', productCount: 'product_count',
  sellerCount: 'seller_count', brandCount: 'brand_count', avgPrice: 'avg_price',
  medianPrice: 'median_price', top10Share: 'top10_share', top20Share: 'top20_share',
  newProductShare: 'new_product_share', medianReviews: 'median_reviews', avgRating: 'avg_rating',
} as const;

const PRODUCT_METRICS = {
  price: 'price', rating: 'rating', reviewCount: 'review_count', bsr: 'bsr',
  estimatedSales: 'estimated_sales', estimatedRevenue: 'estimated_revenue',
  sellerCount: 'seller_count', growth7d: 'growth_7d', growth90d: 'growth_90d',
} as const;
// growth30d is dynamically derived from selected estimated-sales history. It is
// validated through every selected sales point below, not a stored growth_30d field.

type ObservationKind = 'market' | 'product';
const DASHBOARD_RANGE_MS = 30 * 24 * 60 * 60 * 1_000;

interface RunOwnedProduct {
  id: string;
  asin: string;
  marketNodeId: string;
}

interface RunMarketNode {
  id: string;
  nodeIdPath: string;
}

interface CriticalRunCoverage {
  marketId: string;
  nodeIdPath: string;
  marketNodes: RunMarketNode[];
  ownedProducts: RunOwnedProduct[];
}

function parseCriticalRunCoverage(value: string): CriticalRunCoverage | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.marketId !== 'string' || typeof candidate.nodeIdPath !== 'string'
      || !Array.isArray(candidate.marketNodes) || !Array.isArray(candidate.ownedProducts)) return null;
    const marketNodes: RunMarketNode[] = [];
    for (const item of candidate.marketNodes) {
      if (!item || typeof item !== 'object') return null;
      const node = item as Record<string, unknown>;
      if (typeof node.id !== 'string' || typeof node.nodeIdPath !== 'string') return null;
      marketNodes.push({ id: node.id, nodeIdPath: node.nodeIdPath });
    }
    const ownedProducts: RunOwnedProduct[] = [];
    for (const item of candidate.ownedProducts) {
      if (!item || typeof item !== 'object') return null;
      const product = item as Record<string, unknown>;
      if (typeof product.id !== 'string' || typeof product.asin !== 'string'
        || typeof product.marketNodeId !== 'string') return null;
      ownedProducts.push({
        id: product.id, asin: product.asin, marketNodeId: product.marketNodeId,
      });
    }
    return {
      marketId: candidate.marketId, nodeIdPath: candidate.nodeIdPath, marketNodes, ownedProducts,
    };
  } catch {
    return null;
  }
}

function hasCurrentRunRoster(
  database: AppDatabase, marketplace: string, input: DashboardRunReadProofInput,
  coverageJson: string,
): boolean {
  const coverage = parseCriticalRunCoverage(coverageJson);
  const market = database.prepare(`
    SELECT sellersprite_confirmed_node_path AS nodeIdPath FROM market_nodes
    WHERE id = ? AND marketplace = ? AND source_type <> 'mock'
    LIMIT 1
  `).get(input.marketId, marketplace) as { nodeIdPath: string | null } | undefined;
  if (!coverage || !market?.nodeIdPath || coverage.marketId !== input.marketId
    || coverage.nodeIdPath !== market.nodeIdPath) return false;
  const total = database.prepare(`
    SELECT COUNT(*) AS count FROM products
    WHERE marketplace = ? AND is_owned = 1 AND is_parent = 0
      AND status = 'active' AND source_type <> 'mock'
  `).get(marketplace) as { count: number };
  const current = database.prepare(`
    WITH RECURSIVE market_scope(id) AS (
      SELECT id FROM market_nodes
      WHERE id = ? AND marketplace = ? AND source_type <> 'mock'
      UNION
      SELECT child.id FROM market_nodes child
      JOIN market_scope parent ON child.parent_id = parent.id
      WHERE child.marketplace = ? AND child.source_type <> 'mock'
    )
    SELECT product.id, product.asin, product.market_node_id AS marketNodeId
    FROM products product
    JOIN market_nodes market ON market.id = product.market_node_id
      AND market.marketplace = product.marketplace
      AND market.source_type <> 'mock'
      AND market.sellersprite_confirmed_node_path IS NOT NULL
    JOIN market_scope scope ON scope.id = product.market_node_id
    WHERE product.marketplace = ? AND product.is_owned = 1 AND product.is_parent = 0
      AND product.status = 'active' AND product.source_type <> 'mock'
    ORDER BY product.id
  `).all(input.marketId, marketplace, marketplace, marketplace) as unknown as RunOwnedProduct[];
  const inputIds = [...input.ownedProductIds].sort();
  const childNodeIds = [...new Set(current.map((product) => product.marketNodeId))]
    .filter((id) => id !== input.marketId).sort();
  const currentMarketNodes = [input.marketId, ...childNodeIds].map((id) => {
    const node = database.prepare(`
      SELECT sellersprite_confirmed_node_path AS nodeIdPath FROM market_nodes
      WHERE id = ? AND marketplace = ? AND source_type <> 'mock'
    `).get(id, marketplace) as { nodeIdPath: string | null } | undefined;
    return node?.nodeIdPath ? { id, nodeIdPath: node.nodeIdPath } : null;
  });
  return current.length > 0 && current.length === total.count
    && currentMarketNodes.every((node): node is RunMarketNode => node !== null)
    && JSON.stringify(inputIds) === JSON.stringify(current.map((product) => product.id))
    && JSON.stringify(coverage.marketNodes) === JSON.stringify(currentMarketNodes)
    && JSON.stringify(coverage.ownedProducts) === JSON.stringify(current);
}

function isLinkedMetric(
  database: AppDatabase, runId: string, marketplace: string,
  entityId: string, kind: ObservationKind, date: string,
  metric: string, value: number, provenance: MetricProvenance,
): boolean {
  if (provenance.sourceType !== 'mcp' || !provenance.sourceRecordId) return false;
  if (provenance.sourceRecordType === 'metric_fact') {
    return Boolean(database.prepare(`
      SELECT 1 FROM mcp_sync_observation_links link
      JOIN metric_facts fact ON fact.id = link.snapshot_id
      WHERE link.sync_run_id = ? AND link.snapshot_kind = 'fact'
        AND link.snapshot_id = ? AND link.entity_id = ?
        AND fact.entity_type = ? AND fact.entity_id = ? AND fact.marketplace = ?
        AND fact.source_type = 'mcp' AND fact.source_id = 'source-sellersprite-mcp'
        AND fact.metric_name = ? AND fact.observation_date = ? AND fact.numeric_value = ?
        AND ((link.disposition = 'inserted' AND fact.sync_run_id = link.sync_run_id)
          OR (link.disposition = 'reused' AND fact.sync_run_id IS NOT link.sync_run_id))
      LIMIT 1
    `).get(runId, provenance.sourceRecordId, entityId, kind, entityId,
      marketplace, metric, date, value));
  }
  if (provenance.sourceRecordType !== 'snapshot') return false;
  const table = kind === 'market' ? 'market_snapshots' : 'product_snapshots';
  const entityTable = kind === 'market' ? 'market_nodes' : 'products';
  const entityColumn = kind === 'market' ? 'market_node_id' : 'product_id';
  // metric is selected only from the static whitelist above, never caller input.
  return Boolean(database.prepare(`
    SELECT 1 FROM mcp_sync_observation_links link
    JOIN ${table} snapshot ON snapshot.id = link.snapshot_id
    JOIN ${entityTable} entity ON entity.id = snapshot.${entityColumn}
    WHERE link.sync_run_id = ? AND link.snapshot_kind = ?
      AND link.snapshot_id = ? AND link.entity_id = ?
      AND snapshot.${entityColumn} = ? AND entity.marketplace = ?
      AND snapshot.source_type = 'mcp' AND snapshot.source = 'SellerSprite MCP'
      AND snapshot.observation_date = ? AND snapshot.${metric} = ?
      AND ((link.disposition = 'inserted' AND snapshot.sync_run_id = link.sync_run_id)
        OR (link.disposition = 'reused' AND snapshot.sync_run_id IS NOT link.sync_run_id))
    LIMIT 1
  `).get(runId, kind, provenance.sourceRecordId, entityId, entityId,
    marketplace, date, value));
}

function isLinkedMarketPresentationSnapshot(
  database: AppDatabase, runId: string, marketplace: string,
  marketId: string, snapshotId: string | null,
): boolean {
  if (!snapshotId) return false;
  return Boolean(database.prepare(`
    SELECT 1 FROM mcp_sync_observation_links link
    JOIN market_snapshots snapshot ON snapshot.id = link.snapshot_id
    JOIN market_nodes market ON market.id = snapshot.market_node_id
    WHERE link.sync_run_id = ? AND link.snapshot_kind = 'market'
      AND link.snapshot_id = ? AND link.entity_id = ?
      AND snapshot.market_node_id = ? AND market.marketplace = ?
      AND snapshot.source_type = 'mcp' AND snapshot.source = 'SellerSprite MCP'
      AND ((link.disposition = 'inserted' AND snapshot.sync_run_id = link.sync_run_id)
        OR (link.disposition = 'reused' AND snapshot.sync_run_id IS NOT link.sync_run_id))
    LIMIT 1
  `).get(runId, snapshotId, marketId, marketId, marketplace));
}

function isVerifiedAmazonActual(
  database: AppDatabase, marketplace: string, entityId: string,
  kind: ObservationKind, date: string, metric: string, value: number,
  provenance: MetricProvenance,
): boolean {
  if (kind !== 'product' || !['estimated_sales', 'estimated_revenue'].includes(metric)
    || provenance.sourceType !== 'amazon' || provenance.isEstimated
    || !provenance.sourceRecordId) return false;
  if (provenance.sourceRecordType === 'metric_fact') {
    return Boolean(database.prepare(`
      SELECT 1 FROM metric_facts fact
      WHERE fact.id = ? AND fact.entity_type = 'product' AND fact.entity_id = ?
        AND fact.marketplace = ? AND fact.metric_name = ?
        AND fact.observation_date = ? AND fact.numeric_value = ?
        AND fact.source_type = 'amazon' AND fact.is_estimated = 0
        AND fact.source = ? AND fact.collected_at = ?
        AND (fact.source_id = 'amazon_api' OR (
          fact.source_id = 'source-amazon-import' AND EXISTS (
            SELECT 1 FROM data_tasks task
            WHERE task.source_id = fact.source_id AND task.source = fact.source
              AND task.marketplace = fact.marketplace AND task.status = 'success'
              AND task.failed = 0 AND task.success = task.total
          )
        ))
      LIMIT 1
    `).get(provenance.sourceRecordId, entityId, marketplace, metric, date, value,
      provenance.source, provenance.collectedAt));
  }
  if (provenance.sourceRecordType !== 'snapshot') return false;
  // metric is limited to the two static product columns above.
  return Boolean(database.prepare(`
    SELECT 1 FROM product_snapshots snapshot
    JOIN products product ON product.id = snapshot.product_id
    WHERE snapshot.id = ? AND snapshot.product_id = ? AND product.marketplace = ?
      AND snapshot.observation_date = ? AND snapshot.${metric} = ?
      AND snapshot.source_type = 'amazon' AND snapshot.is_estimated = 0
      AND snapshot.source = ? AND snapshot.collected_at = ?
      AND EXISTS (
        SELECT 1 FROM data_tasks task
        WHERE task.source_id = 'source-amazon-import' AND task.source = snapshot.source
          AND task.marketplace = product.marketplace AND task.status = 'success'
          AND task.failed = 0 AND task.success = task.total
      )
    LIMIT 1
  `).get(provenance.sourceRecordId, entityId, marketplace, date, value,
    provenance.source, provenance.collectedAt));
}

function selectedMetricStatus(
  database: AppDatabase, runId: string, marketplace: string,
  entityId: string, kind: ObservationKind, date: string,
  metric: string, value: number, provenance: MetricProvenance | undefined,
): 'linked' | 'authority' | 'invalid' {
  if (!provenance || provenance.sourceType === 'mock') return 'invalid';
  if (isLinkedMetric(
    database, runId, marketplace, entityId, kind, date, metric, value, provenance,
  )) return 'linked';
  if (isVerifiedAmazonActual(
    database, marketplace, entityId, kind, date, metric, value, provenance,
  )) return 'authority';
  return 'invalid';
}

function hasSelectedLinkedMetric(
  database: AppDatabase, runId: string, marketplace: string,
  entityId: string, kind: ObservationKind, date: string,
  values: object, columns: Record<string, string>,
  lineage?: Record<string, MetricProvenance>,
): boolean {
  if (!date || !lineage) return false;
  const selected = Object.entries(columns).flatMap(([property, metric]) => {
    const value: unknown = Reflect.get(values, property);
    return typeof value === 'number' && Number.isFinite(value)
      ? [{ metric, value, source: lineage[metric] }]
      : [];
  });
  let linkedMetrics = 0;
  const valid = selected.length > 0 && selected.every(({ metric, value, source }) => {
    const status = selectedMetricStatus(
      database, runId, marketplace, entityId, kind, date, metric, value, source,
    );
    if (status === 'linked') linkedMetrics += 1;
    return status !== 'invalid';
  });
  return valid && linkedMetrics > 0;
}

function hasValidMarketSalesHistory(
  database: AppDatabase, runId: string, marketplace: string,
  marketId: string, trends: TrendPoint[],
): boolean {
  const authority = new MetricAuthorityResolver(database);
  const dates = relevantSalesDates(trends.map((point) => ({
    date: point.date, value: point.sales,
  })), trends);
  return trends.every((point) => {
    if (point.sales === null || !dates.has(point.date)) return true;
    const fact = authority.resolveMetric({
      entityType: 'market', entityId: marketId,
      metric: 'monthly_sales', observationDate: point.date,
    }).selected;
    if (!fact || fact.value !== point.sales) return false;
    return selectedMetricStatus(
      database, runId, marketplace, marketId, 'market', point.date,
      'monthly_sales', point.sales, {
        sourceRecordId: fact.id,
        sourceRecordType: fact.sourceRecordType,
        source: fact.source,
        sourceType: fact.sourceType as MetricProvenance['sourceType'],
        collectedAt: fact.collectedAt,
        period: fact.period ?? '',
        isEstimated: fact.isEstimated,
        confidence: fact.confidence,
      },
    ) === 'linked';
  });
}

function hasValidProductSalesHistory(
  database: AppDatabase, runId: string, marketplace: string,
  productId: string, snapshots: ProductSnapshot[], marketTrends: TrendPoint[],
): boolean {
  const dates = relevantSalesDates(snapshots.map((snapshot) => ({
    date: snapshot.date, value: snapshot.estimatedSales,
  })), marketTrends);
  return snapshots.every((snapshot) => (
    snapshot.estimatedSales === null || !dates.has(snapshot.date)
    || selectedMetricStatus(
      database, runId, marketplace, productId, 'product', snapshot.date,
      'estimated_sales', snapshot.estimatedSales,
      snapshot.metricProvenance?.estimated_sales,
    ) !== 'invalid'
  ));
}

function relevantSalesDates(
  points: Array<{ date: string; value: number | null }>,
  marketTrends: TrendPoint[],
): Set<string> {
  const result = new Set<string>();
  const anchor = marketTrends.reduce<number | null>((latest, point) => {
    const time = metricTime(point.date);
    if (point.sales === null || !Number.isFinite(point.sales) || point.sales < 0
      || time === null) return latest;
    return latest === null || time > latest ? time : latest;
  }, null);
  if (anchor !== null) {
    const cutoff = anchor - DASHBOARD_RANGE_MS;
    for (const point of points) {
      const time = metricTime(point.date);
      if (point.value !== null && Number.isFinite(point.value) && point.value >= 0
        && time !== null && time >= cutoff && time <= anchor) result.add(point.date);
    }
  }
  const growth = deriveSnapshotGrowth(points.map((point, index) => ({
    id: `${point.date}:${index}`, date: point.date, value: point.value,
  })));
  if (growth) {
    result.add(growth.latest.date);
    result.add(growth.baseline.date);
  }
  return result;
}

function metricTime(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) ? time : null;
}

export function proveDashboardRunReadPath(
  database: AppDatabase,
  input: DashboardRunReadProofInput,
): DashboardRunReadProof {
  const result: DashboardRunReadProof = {
    passed: false,
    marketVerified: false,
    verifiedOwnedProducts: 0,
    requiredOwnedProducts: input.ownedProductIds.length,
  };
  if (!input.runId || !input.marketId || input.ownedProductIds.length === 0
    || new Set(input.ownedProductIds).size !== input.ownedProductIds.length) return result;
  const repository = new IntelligenceRepository(database);
  const settings = repository.getSettings();
  if (settings.defaultMarketId !== input.marketId) return result;
  const completeRun = database.prepare(`
    SELECT coverage.coverage_json AS coverageJson FROM data_tasks task
    JOIN data_coverage_runs coverage ON coverage.id = task.id
    WHERE task.id = ? AND task.sync_run_id = task.id
      AND task.task_type = 'critical_sync' AND task.source_id = 'source-sellersprite-mcp'
      AND task.target = ? AND task.marketplace = ? AND task.status = 'success'
      AND task.failed = 0 AND task.success = task.total
      AND coverage.marketplace = task.marketplace AND coverage.run_type = 'critical_sync'
      AND coverage.is_complete = 1
    LIMIT 1
  `).get(input.runId, input.marketId, settings.marketplace) as { coverageJson: string } | undefined;
  if (!completeRun || !hasCurrentRunRoster(
    database, settings.marketplace, input, completeRun.coverageJson,
  )) return result;

  const market = repository.getMarket(input.marketId);
  const realMarket = database.prepare(`
    SELECT 1 FROM market_nodes
    WHERE id = ? AND marketplace = ? AND source_type <> 'mock'
      AND sellersprite_confirmed_node_path IS NOT NULL
    LIMIT 1
  `).get(input.marketId, settings.marketplace);
  result.marketVerified = Boolean(realMarket && market && isLinkedMarketPresentationSnapshot(
    database, input.runId, settings.marketplace, input.marketId,
    repository.getSelectedMarketSnapshotId(input.marketId),
  ) && hasSelectedLinkedMetric(
    database, input.runId, settings.marketplace, input.marketId, 'market',
    market.trends.at(-1)?.date ?? '', market.kpis, MARKET_METRICS, market.metricProvenance,
  ) && hasValidMarketSalesHistory(
    database, input.runId, settings.marketplace, input.marketId, market.trends,
  ));
  const realChildIds = new Set((database.prepare(`
    SELECT id FROM products
    WHERE marketplace = ? AND is_owned = 1 AND is_parent = 0
      AND status = 'active' AND source_type <> 'mock'
  `).all(settings.marketplace) as Array<{ id: string }>).map((row) => row.id));
  const owned = new Map(repository.getSellableOwnedProducts().map((product) => [product.id, product]));
  for (const id of input.ownedProductIds) {
    const product = owned.get(id);
    const productMarket = product?.marketNodeId === input.marketId
      ? market : product ? repository.getMarket(product.marketNodeId) : null;
    const productMarketGrowthVerified = !product?.marketGrowth30dAvailable
      || Boolean(productMarket && hasValidMarketSalesHistory(
        database, input.runId, settings.marketplace, product.marketNodeId, productMarket.trends,
      ));
    if (realChildIds.has(id) && product && product.marketPath?.some((node) => node.id === input.marketId)
      && productMarketGrowthVerified
      && hasSelectedLinkedMetric(
        database, input.runId, settings.marketplace, id, 'product',
        product.latest.date, product.latest, PRODUCT_METRICS, product.latest.metricProvenance,
      ) && hasValidProductSalesHistory(
        database, input.runId, settings.marketplace, id,
        repository.getProductSnapshots(id), market?.trends ?? [],
      )) result.verifiedOwnedProducts += 1;
  }
  result.passed = result.marketVerified
    && result.verifiedOwnedProducts === result.requiredOwnedProducts;
  return result;
}
