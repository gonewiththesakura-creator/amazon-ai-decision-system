import type {
  DataCoverageCounter,
  DataCoverageReport,
  DataCoverageStatus,
} from '../../shared/types.js';
import type { AppDatabase } from '../database/database.js';
import { confirmedDirectCompetitors } from './confirmed-direct-competitor-coverage.js';
import { isLiveObservationReadable } from './live-observation-readability.js';
import { validMarketHistorySpan, validProductHistorySpans } from './real-history-coverage.js';

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
    if (this.isLiveMode()) return this.liveCoverage(marketplace, primaryMarketId);
    const activeOwnedTotal = this.count(`
      SELECT COUNT(*) AS count
      FROM products
      WHERE marketplace = ? AND is_owned = 1 AND status = 'active' AND is_parent = 0
    `, marketplace);
    const activeOwnedCovered = this.count(`
      SELECT COUNT(DISTINCT product.id) AS count
      FROM products product
      WHERE product.marketplace = ? AND product.is_owned = 1 AND product.status = 'active'
        AND product.is_parent = 0
        AND ${productEvidence('product.id')}
    `, marketplace);
    const coreCompetitorTotal = this.count(`
      SELECT COUNT(DISTINCT relation.competitor_product_id) AS count
      FROM competitor_relations relation
      JOIN products owned ON owned.id = relation.owned_product_id
      JOIN products competitor ON competitor.id = relation.competitor_product_id
      WHERE owned.marketplace = ? AND owned.is_owned = 1 AND owned.status = 'active' AND owned.is_parent = 0
        AND competitor.marketplace = ? AND competitor.is_parent = 0
        AND relation.relation_type = 'direct'
    `, marketplace, marketplace);
    const coreCompetitorCovered = this.count(`
      SELECT COUNT(DISTINCT relation.competitor_product_id) AS count
      FROM competitor_relations relation
      JOIN products owned ON owned.id = relation.owned_product_id
      JOIN products competitor ON competitor.id = relation.competitor_product_id
      WHERE owned.marketplace = ? AND owned.is_owned = 1 AND owned.status = 'active' AND owned.is_parent = 0
        AND competitor.marketplace = ? AND competitor.is_parent = 0
        AND relation.relation_type = 'direct'
        AND ${productEvidence('competitor.id')}
    `, marketplace, marketplace);
    const history90dCovered = this.count(`
      SELECT COUNT(*) AS count FROM (
        SELECT product.id
        FROM products product
        JOIN product_snapshots snapshot ON snapshot.product_id = product.id
        WHERE product.marketplace = ? AND product.is_owned = 1 AND product.status = 'active'
          AND product.is_parent = 0
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
        AND product.is_parent = 0
        AND ${productEvidence('product.id', true)}
    `, marketplace);
    const supplemental = this.supplementalCoverage(marketplace, primaryMarketId);

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
      ...supplemental,
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

  private isLiveMode(): boolean {
    const row = this.database.prepare(`SELECT mode FROM app_settings WHERE id = 1`)
      .get() as { mode: string } | undefined;
    return row?.mode === 'live';
  }

  private liveCoverage(marketplace: string, primaryMarketId: string | null): DataCoverageReport {
    const owned = this.database.prepare(`
      SELECT product.id FROM products product
      WHERE product.marketplace = ? AND product.is_owned = 1 AND product.status = 'active'
        AND product.is_parent = 0
        AND product.source_type <> 'mock'
      ORDER BY product.id
    `).all(marketplace) as Array<{ id: string }>;
    const eligibleOwned = this.database.prepare(`
      WITH RECURSIVE market_scope(id) AS (
        SELECT id FROM market_nodes
        WHERE id = ? AND marketplace = ? AND source_type <> 'mock'
        UNION
        SELECT child.id FROM market_nodes child
        JOIN market_scope parent ON child.parent_id = parent.id
        WHERE child.marketplace = ? AND child.source_type <> 'mock'
      )
      SELECT product.id FROM products product
      JOIN market_scope scope ON scope.id = product.market_node_id
      JOIN market_nodes assigned ON assigned.id = product.market_node_id
        AND assigned.marketplace = product.marketplace
        AND assigned.source_type <> 'mock'
        AND assigned.sellersprite_confirmed_node_path IS NOT NULL
      WHERE product.marketplace = ? AND product.is_owned = 1 AND product.status = 'active'
        AND product.is_parent = 0
        AND product.source_type <> 'mock'
      ORDER BY product.id
    `).all(primaryMarketId, marketplace, marketplace, marketplace) as Array<{ id: string }>;
    const competitors = this.database.prepare(`
      WITH RECURSIVE market_scope(id) AS (
        SELECT id FROM market_nodes
        WHERE id = ? AND marketplace = ? AND source_type <> 'mock'
        UNION
        SELECT child.id FROM market_nodes child
        JOIN market_scope parent ON child.parent_id = parent.id
        WHERE child.marketplace = ? AND child.source_type <> 'mock'
      )
      SELECT DISTINCT relation.competitor_product_id AS id
      FROM competitor_relations relation
      JOIN products owned ON owned.id = relation.owned_product_id
      JOIN market_scope scope ON scope.id = owned.market_node_id
      JOIN market_nodes assigned ON assigned.id = owned.market_node_id
        AND assigned.marketplace = owned.marketplace
        AND assigned.source_type <> 'mock'
        AND assigned.sellersprite_confirmed_node_path IS NOT NULL
      JOIN products competitor ON competitor.id = relation.competitor_product_id
      WHERE owned.marketplace = ? AND owned.is_owned = 1 AND owned.status = 'active' AND owned.is_parent = 0
        AND owned.source_type <> 'mock' AND relation.relation_type = 'direct'
        AND competitor.marketplace = owned.marketplace AND competitor.is_owned = 0
        AND competitor.is_parent = 0
        AND competitor.status = 'active' AND competitor.source_type <> 'mock'
      ORDER BY competitor.id
    `).all(primaryMarketId, marketplace, marketplace, marketplace) as Array<{ id: string }>;
    const eligibleOwnedIds = new Set(eligibleOwned.map((product) => product.id));
    const trackedIds = new Set([...eligibleOwnedIds, ...competitors.map((product) => product.id)]);
    const coveredProducts = new Set<string>();
    const amazonActualProducts = new Set<string>();

    const snapshots = this.database.prepare(`
      SELECT snapshot.id, snapshot.product_id AS productId,
        snapshot.source_type AS sourceType, snapshot.sync_run_id AS syncRunId,
        snapshot.is_estimated AS isEstimated,
        julianday(COALESCE(snapshot.observation_date, snapshot.date)) AS observationDay
      FROM product_snapshots snapshot
      JOIN products product ON product.id = snapshot.product_id
      WHERE product.marketplace = ? AND snapshot.source_type IN (${REAL_SOURCE_TYPES})
        AND ${PRODUCT_METRICS}
    `).all(marketplace) as Array<{
      id: string; productId: string; sourceType: string; syncRunId: string | null;
      isEstimated: number; observationDay: number | null;
    }>;
    for (const snapshot of snapshots) {
      if (!trackedIds.has(snapshot.productId) || !isLiveObservationReadable(
        this.database, 'product', snapshot.id, snapshot.sourceType, snapshot.syncRunId,
      )) continue;
      coveredProducts.add(snapshot.productId);
      if (snapshot.sourceType === 'amazon' && snapshot.isEstimated === 0) {
        amazonActualProducts.add(snapshot.productId);
      }
    }

    const facts = this.database.prepare(`
      SELECT fact.id, fact.entity_id AS productId, fact.source_type AS sourceType,
        fact.sync_run_id AS syncRunId, fact.is_estimated AS isEstimated
      FROM metric_facts fact
      WHERE fact.entity_type = 'product' AND fact.marketplace = ?
        AND fact.source_type IN (${REAL_SOURCE_TYPES}) AND fact.numeric_value IS NOT NULL
    `).all(marketplace) as Array<{
      id: string; productId: string; sourceType: string; syncRunId: string | null;
      isEstimated: number;
    }>;
    for (const fact of facts) {
      if (!trackedIds.has(fact.productId) || !isLiveObservationReadable(
        this.database, 'fact', fact.id, fact.sourceType, fact.syncRunId,
      )) continue;
      coveredProducts.add(fact.productId);
      if (fact.sourceType === 'amazon' && fact.isEstimated === 0) {
        amazonActualProducts.add(fact.productId);
      }
    }

    let primaryMarketCovered = false;
    if (primaryMarketId) {
      const marketSnapshots = this.database.prepare(`
        SELECT snapshot.id, snapshot.source_type AS sourceType, snapshot.sync_run_id AS syncRunId
        FROM market_snapshots snapshot
        JOIN market_nodes market ON market.id = snapshot.market_node_id
          AND market.marketplace = ? AND market.source_type <> 'mock'
          AND market.sellersprite_confirmed_node_path IS NOT NULL
        WHERE snapshot.market_node_id = ? AND snapshot.source_type IN (${REAL_SOURCE_TYPES})
          AND ${MARKET_METRICS}
      `).all(marketplace, primaryMarketId) as Array<{
        id: string; sourceType: string; syncRunId: string | null;
      }>;
      primaryMarketCovered = marketSnapshots.some((snapshot) => isLiveObservationReadable(
        this.database, 'market', snapshot.id, snapshot.sourceType, snapshot.syncRunId,
      ));
      if (!primaryMarketCovered) {
        const marketFacts = this.database.prepare(`
          SELECT fact.id, fact.source_type AS sourceType, fact.sync_run_id AS syncRunId
          FROM metric_facts fact
          JOIN market_nodes market ON market.id = fact.entity_id
            AND market.marketplace = fact.marketplace AND market.source_type <> 'mock'
            AND market.sellersprite_confirmed_node_path IS NOT NULL
          WHERE fact.entity_type = 'market' AND fact.entity_id = ? AND fact.marketplace = ?
            AND fact.source_type IN (${REAL_SOURCE_TYPES}) AND fact.numeric_value IS NOT NULL
        `).all(primaryMarketId, marketplace) as Array<{
          id: string; sourceType: string; syncRunId: string | null;
        }>;
        primaryMarketCovered = marketFacts.some((fact) => isLiveObservationReadable(
          this.database, 'fact', fact.id, fact.sourceType, fact.syncRunId,
        ));
      }
    }

    const supplemental = this.supplementalCoverage(marketplace, primaryMarketId);
    return {
      generatedAt: new Date().toISOString(), marketplace,
      primaryMarket: counter(primaryMarketCovered ? 1 : 0, 1),
      activeOwnedProducts: counter(owned.filter((product) => coveredProducts.has(product.id)).length, owned.length),
      coreCompetitors: counter(competitors.filter((product) => coveredProducts.has(product.id)).length,
        competitors.length),
      history90d: supplemental.ownedProductHistory90d,
      ...supplemental,
      amazonActual: counter(owned.filter((product) => amazonActualProducts.has(product.id)).length, owned.length),
    };
  }

  private supplementalCoverage(
    marketplace: string,
    primaryMarketId: string | null,
  ): Pick<DataCoverageReport,
    'primaryMarketHistory90d' | 'ownedProductHistory90d' | 'ownedProductHistory180d'
    | 'coreCompetitorHistory90d' | 'coreDirectCompetitorTarget'> {
    const owned = this.database.prepare(`
      SELECT id FROM products
      WHERE marketplace = ? AND is_owned = 1 AND is_parent = 0
        AND status = 'active' AND source_type <> 'mock'
      ORDER BY id
    `).all(marketplace) as Array<{ id: string }>;
    const competitors = this.database.prepare(`
      SELECT DISTINCT competitor.id
      FROM competitor_relations relation
      JOIN products owned ON owned.id = relation.owned_product_id
      JOIN products competitor ON competitor.id = relation.competitor_product_id
      WHERE relation.relation_type = 'direct'
        AND owned.marketplace = ? AND owned.is_owned = 1 AND owned.is_parent = 0
        AND owned.status = 'active' AND owned.source_type <> 'mock'
        AND competitor.marketplace = owned.marketplace AND competitor.is_owned = 0
        AND competitor.is_parent = 0 AND competitor.status = 'active'
        AND competitor.source_type <> 'mock'
      ORDER BY competitor.id
    `).all(marketplace) as Array<{ id: string }>;
    const ownedSpans = validProductHistorySpans(
      this.database, marketplace, owned.map((product) => product.id),
    );
    const competitorSpans = validProductHistorySpans(
      this.database, marketplace, competitors.map((product) => product.id),
    );
    const confirmed = confirmedDirectCompetitors(this.database, marketplace);
    const confirmedByOwned = new Map<string, Set<string>>();
    for (const relation of confirmed) {
      const competitorsForOwned = confirmedByOwned.get(relation.ownedProductId) ?? new Set<string>();
      competitorsForOwned.add(relation.competitorProductId);
      confirmedByOwned.set(relation.ownedProductId, competitorsForOwned);
    }
    const confirmedMarket = primaryMarketId ? this.database.prepare(`
      SELECT id FROM market_nodes WHERE id = ? AND marketplace = ?
        AND source_type <> 'mock' AND sellersprite_confirmed_node_path IS NOT NULL
    `).get(primaryMarketId, marketplace) as { id: string } | undefined : undefined;
    const primaryMarketHistory = validMarketHistorySpan(
      this.database, marketplace, confirmedMarket?.id ?? null,
    );
    return {
      primaryMarketHistory90d: counter(primaryMarketHistory.days >= 90 ? 1 : 0, 1),
      ownedProductHistory90d: counter(
        owned.filter((product) => (ownedSpans.get(product.id)?.days ?? 0) >= 90).length,
        owned.length,
      ),
      ownedProductHistory180d: counter(
        owned.filter((product) => (ownedSpans.get(product.id)?.days ?? 0) >= 180).length,
        owned.length,
      ),
      coreCompetitorHistory90d: counter(
        competitors.filter((product) => (competitorSpans.get(product.id)?.days ?? 0) >= 90).length,
        competitors.length,
      ),
      coreDirectCompetitorTarget: {
        ...counter(
          owned.filter((product) => (confirmedByOwned.get(product.id)?.size ?? 0) >= 3).length,
          owned.length,
        ),
        minimumPerOwnedProduct: 3,
        preferredMaximumPerOwnedProduct: 5,
      },
    };
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
