import type {
  DataCoverageCounter,
  DataCoverageReport,
  DataCoverageStatus,
} from '../../shared/types.js';
import type { AppDatabase } from '../database/database.js';

interface CountRow {
  count: number;
}

const REAL_SOURCE_TYPES = "'mcp', 'amazon', 'import'";
const PRODUCT_METRICS = `(
  snapshot.price IS NOT NULL OR snapshot.rating IS NOT NULL
  OR snapshot.review_count IS NOT NULL OR snapshot.bsr IS NOT NULL
  OR snapshot.estimated_sales IS NOT NULL OR snapshot.estimated_revenue IS NOT NULL
  OR snapshot.seller_count IS NOT NULL OR snapshot.growth_7d IS NOT NULL
  OR snapshot.growth_30d IS NOT NULL OR snapshot.growth_90d IS NOT NULL
)`;
const MARKET_METRICS = `(
  snapshot.product_count IS NOT NULL OR snapshot.seller_count IS NOT NULL
  OR snapshot.brand_count IS NOT NULL OR snapshot.monthly_sales IS NOT NULL
  OR snapshot.monthly_revenue IS NOT NULL OR snapshot.avg_price IS NOT NULL
  OR snapshot.median_price IS NOT NULL OR snapshot.avg_rating IS NOT NULL
  OR snapshot.median_reviews IS NOT NULL OR snapshot.top10_share IS NOT NULL
  OR snapshot.top20_share IS NOT NULL OR snapshot.new_product_share IS NOT NULL
)`;

export class DataCoverageService {
  constructor(private readonly database: AppDatabase) {}

  getCoverage(marketplace: string): DataCoverageReport {
    const primaryMarketId = this.primaryMarketId(marketplace);
    const activeOwnedTotal = this.count(`
      SELECT COUNT(*) AS count
      FROM products
      WHERE marketplace = ? AND is_owned = 1 AND status = 'active'
    `, marketplace);
    const activeOwnedCovered = this.count(`
      SELECT COUNT(DISTINCT product.id) AS count
      FROM products product
      WHERE product.marketplace = ? AND product.is_owned = 1 AND product.status = 'active'
        AND ${productEvidence('product.id')}
    `, marketplace);
    const coreCompetitorTotal = this.count(`
      SELECT COUNT(DISTINCT relation.competitor_product_id) AS count
      FROM competitor_relations relation
      JOIN products owned ON owned.id = relation.owned_product_id
      JOIN products competitor ON competitor.id = relation.competitor_product_id
      WHERE owned.marketplace = ? AND owned.is_owned = 1 AND owned.status = 'active'
        AND competitor.marketplace = ? AND relation.relation_type = 'direct'
    `, marketplace, marketplace);
    const coreCompetitorCovered = this.count(`
      SELECT COUNT(DISTINCT relation.competitor_product_id) AS count
      FROM competitor_relations relation
      JOIN products owned ON owned.id = relation.owned_product_id
      JOIN products competitor ON competitor.id = relation.competitor_product_id
      WHERE owned.marketplace = ? AND owned.is_owned = 1 AND owned.status = 'active'
        AND competitor.marketplace = ? AND relation.relation_type = 'direct'
        AND ${productEvidence('competitor.id')}
    `, marketplace, marketplace);
    const history90dCovered = this.count(`
      SELECT COUNT(*) AS count FROM (
        SELECT product.id
        FROM products product
        JOIN product_snapshots snapshot ON snapshot.product_id = product.id
        WHERE product.marketplace = ? AND product.is_owned = 1 AND product.status = 'active'
          AND snapshot.source_type IN (${REAL_SOURCE_TYPES})
          AND ${PRODUCT_METRICS}
          AND date(COALESCE(snapshot.observation_date, snapshot.date)) IS NOT NULL
        GROUP BY product.id
        HAVING julianday(MAX(COALESCE(snapshot.observation_date, snapshot.date)))
          - julianday(MIN(COALESCE(snapshot.observation_date, snapshot.date))) >= 90
      )
    `, marketplace);
    const amazonActualCovered = this.count(`
      SELECT COUNT(DISTINCT product.id) AS count
      FROM products product
      WHERE product.marketplace = ? AND product.is_owned = 1 AND product.status = 'active'
        AND ${productEvidence('product.id', true)}
    `, marketplace);

    return {
      generatedAt: new Date().toISOString(),
      marketplace,
      primaryMarket: counter(
        primaryMarketId && this.count(`
          SELECT COUNT(*) AS count
          FROM market_nodes market
          WHERE market.id = ? AND market.marketplace = ?
            AND (
              EXISTS (
                SELECT 1 FROM market_snapshots snapshot
                WHERE snapshot.market_node_id = market.id
                  AND snapshot.source_type IN (${REAL_SOURCE_TYPES}) AND ${MARKET_METRICS}
              ) OR EXISTS (
                SELECT 1 FROM metric_facts fact
                WHERE fact.entity_type = 'market' AND fact.entity_id = market.id
                  AND fact.marketplace = market.marketplace
                  AND fact.source_type IN (${REAL_SOURCE_TYPES}) AND fact.numeric_value IS NOT NULL
              )
            )
        `, primaryMarketId, marketplace) > 0 ? 1 : 0,
        1,
      ),
      activeOwnedProducts: counter(activeOwnedCovered, activeOwnedTotal),
      coreCompetitors: counter(coreCompetitorCovered, coreCompetitorTotal),
      history90d: counter(history90dCovered, activeOwnedTotal),
      amazonActual: counter(amazonActualCovered, activeOwnedTotal),
    };
  }

  private primaryMarketId(marketplace: string): string | null {
    const row = this.database.prepare(`
      SELECT settings.default_market_id AS id
      FROM app_settings settings
      JOIN market_nodes market ON market.id = settings.default_market_id
      WHERE settings.id = 1 AND settings.marketplace = ? AND market.marketplace = ?
    `).get(marketplace, marketplace) as { id: string } | undefined;
    return row?.id || null;
  }

  private count(sql: string, ...params: Array<string | number>): number {
    const row = this.database.prepare(sql).get(...params) as unknown as CountRow | undefined;
    return Number(row?.count ?? 0);
  }
}

function productEvidence(productId: string, amazonActual = false): string {
  const snapshotSource = amazonActual
    ? "snapshot.source_type = 'amazon' AND snapshot.is_estimated = 0"
    : `snapshot.source_type IN (${REAL_SOURCE_TYPES})`;
  const factSource = amazonActual
    ? "fact.source_type = 'amazon' AND fact.is_estimated = 0"
    : `fact.source_type IN (${REAL_SOURCE_TYPES})`;
  return `(
    EXISTS (
      SELECT 1 FROM product_snapshots snapshot
      WHERE snapshot.product_id = ${productId} AND ${snapshotSource}
        AND ${PRODUCT_METRICS}
    ) OR EXISTS (
      SELECT 1 FROM metric_facts fact
      WHERE fact.entity_type = 'product' AND fact.entity_id = ${productId}
        AND ${factSource}
        AND fact.numeric_value IS NOT NULL
    )
  )`;
}

function counter(covered: number, total: number): DataCoverageCounter {
  const status: DataCoverageStatus = total === 0
    ? 'not_applicable'
    : covered === 0
      ? 'missing'
      : covered >= total
        ? 'complete'
        : 'partial';
  const labels: Record<DataCoverageStatus, DataCoverageCounter['label']> = {
    complete: '完整',
    partial: '部分覆盖',
    missing: '缺失',
    not_applicable: '不适用',
  };
  return { covered, total, status, label: labels[status] };
}
