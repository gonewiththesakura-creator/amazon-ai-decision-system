import { backup as sqliteBackup } from 'node:sqlite';
import type { AppDatabase } from '../database/database.js';
import { transaction } from '../database/database.js';

interface CountRow {
  count: number;
}

export interface GoLivePreview {
  delete: Record<string, number>;
  archive: { products: number };
  preserve: { products: number; rules: number; decisions: number; realSnapshots: number };
  blockers: string[];
}

export interface GoLiveVerification {
  mockObservations: number;
  realMarketSnapshots: number;
  realOwnedProductSnapshots: number;
  activeOwnedProducts: number;
  sellerSpriteMarketSnapshots: number;
  sellerSpriteOwnedProductSnapshots: number;
  sellerSpriteConnectionVerified: boolean;
  sellerSpriteCapabilitiesAvailable: boolean;
  sellerSpriteMarketCalls: number;
  sellerSpriteAsinCalls: number;
  hasMinimumRealCoverage: boolean;
}

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
const SEEDED_IDS = `SELECT record_id FROM demo_seed_records WHERE seed_id = 'v2-demo-seed' AND table_name = ?`;
const DEMO_REFRESH_MARKET_SNAPSHOTS = `SELECT snapshot.id FROM market_snapshots snapshot
  WHERE snapshot.source_type = 'mock' AND snapshot.source = '演示数据 / Mock Adapter'
    AND EXISTS (SELECT 1 FROM demo_seed_records seed WHERE seed.seed_id = 'v2-demo-seed'
      AND seed.table_name = 'market_nodes' AND seed.record_id = snapshot.market_node_id)`;
const DEMO_REFRESH_PRODUCT_SNAPSHOTS = `SELECT snapshot.id FROM product_snapshots snapshot
  WHERE snapshot.source_type = 'mock' AND snapshot.source = '演示数据 / Mock Adapter'
    AND EXISTS (SELECT 1 FROM demo_seed_records seed WHERE seed.seed_id = 'v2-demo-seed'
      AND seed.table_name = 'products' AND seed.record_id = snapshot.product_id)`;
const CLEANUP_MARKET_SNAPSHOTS = `SELECT record_id FROM demo_seed_records
  WHERE seed_id = 'v2-demo-seed' AND table_name = 'market_snapshots'
  UNION ${DEMO_REFRESH_MARKET_SNAPSHOTS}`;
const CLEANUP_PRODUCT_SNAPSHOTS = `SELECT record_id FROM demo_seed_records
  WHERE seed_id = 'v2-demo-seed' AND table_name = 'product_snapshots'
  UNION ${DEMO_REFRESH_PRODUCT_SNAPSHOTS}`;
const MOCK_REFERENCING_INSIGHTS = `SELECT insight.id FROM ai_insights insight
  WHERE EXISTS (SELECT 1 FROM json_each(insight.evidence_json) evidence,
    json_each(evidence.value, '$.provenance') provenance
    WHERE json_extract(provenance.value, '$.sourceType') = 'mock')`;
const MOCK_ONLY_INSIGHTS = `SELECT insight.id FROM ai_insights insight
  WHERE insight.id IN (${MOCK_REFERENCING_INSIGHTS})
    AND NOT EXISTS (SELECT 1 FROM json_each(insight.evidence_json) evidence
      WHERE COALESCE(json_type(evidence.value, '$.provenance'), '') <> 'array'
        OR json_array_length(evidence.value, '$.provenance') = 0
        OR EXISTS (SELECT 1 FROM json_each(evidence.value, '$.provenance') provenance
          WHERE COALESCE(json_extract(provenance.value, '$.sourceType'), '') <> 'mock'
            OR COALESCE(json_extract(provenance.value, '$.source'), '') <> '演示数据 / Mock Adapter'))`;
const CLEANUP_INSIGHTS = `SELECT record_id FROM demo_seed_records
  WHERE seed_id = 'v2-demo-seed' AND table_name = 'ai_insights'
  UNION SELECT insight.id FROM ai_insights insight
    WHERE insight.id IN (${MOCK_ONLY_INSIGHTS})
      AND EXISTS (SELECT 1 FROM demo_seed_records seed
        WHERE seed.seed_id = 'v2-demo-seed' AND seed.record_id = insight.entity_id
          AND seed.table_name IN ('products', 'market_nodes', 'development_projects', 'opportunities'))`;
const CLEANUP_DESCENDANTS = `SELECT record_id FROM demo_seed_records
  WHERE seed_id = 'v2-demo-seed' AND table_name NOT IN ('products', 'market_nodes')
  UNION ${DEMO_REFRESH_MARKET_SNAPSHOTS}
  UNION ${DEMO_REFRESH_PRODUCT_SNAPSHOTS}
  UNION ${CLEANUP_INSIGHTS}`;
const ARCHIVABLE_SEED_PRODUCTS = `SELECT product.id FROM products product
  JOIN demo_seed_records seed ON seed.table_name = 'products' AND seed.record_id = product.id
    AND seed.seed_id = 'v2-demo-seed'
  WHERE product.status = 'active' AND product.source_type = 'mock'
    AND product.asin IN ('B0DEMO0001', 'B0DEMO0002', 'B0DEMO0003', 'B0DEMO0004',
      'B0DEMO1001', 'B0DEMO1002', 'B0DEMO1003', 'B0DEMO1004',
      'B0DEMO1005', 'B0DEMO1006', 'B0DEMO1007', 'B0DEMO1008')
    AND NOT EXISTS (SELECT 1 FROM product_snapshots snapshot WHERE snapshot.product_id = product.id
      AND snapshot.source_type <> 'mock')
    AND NOT EXISTS (SELECT 1 FROM metric_facts fact WHERE fact.entity_id = product.id
      AND fact.source_type <> 'mock')
    AND NOT EXISTS (SELECT 1 FROM research_jobs job WHERE job.entity_id = product.id AND job.is_demo = 0)
    AND NOT EXISTS (SELECT 1 FROM decisions decision WHERE decision.entity_id = product.id)
    AND NOT EXISTS (SELECT 1 FROM evidence_records evidence WHERE evidence.source_record_id = product.id)
    AND NOT EXISTS (SELECT 1 FROM reviews review WHERE review.product_id = product.id)
    AND NOT EXISTS (SELECT 1 FROM competitor_candidates candidate WHERE candidate.source_product_id = product.id)
    AND NOT EXISTS (SELECT 1 FROM competitor_relations relation
      WHERE (relation.owned_product_id = product.id OR relation.competitor_product_id = product.id)
        AND relation.id NOT IN (${SEEDED_IDS}))
    AND NOT EXISTS (SELECT 1 FROM watchlist_items item WHERE item.item_id = product.id
      AND item.id NOT IN (${SEEDED_IDS}))
    AND NOT EXISTS (SELECT 1 FROM ai_insights insight WHERE insight.entity_id = product.id
      AND insight.id NOT IN (${CLEANUP_INSIGHTS}))`;

export class GoLiveMigrationService {
  constructor(private readonly database: AppDatabase) {}

  preview(): GoLivePreview {
    const seedId = 'v2-demo-seed';
    const countSeeded = (table: string): number => this.count(`
      SELECT COUNT(*) AS count FROM demo_seed_records WHERE seed_id = ? AND table_name = ?
    `, false, seedId, table);
    return {
      delete: {
        marketSnapshots: this.count(`SELECT COUNT(*) AS count FROM market_snapshots
          WHERE id IN (${CLEANUP_MARKET_SNAPSHOTS})`),
        productSnapshots: this.count(`SELECT COUNT(*) AS count FROM product_snapshots
          WHERE id IN (${CLEANUP_PRODUCT_SNAPSHOTS})`),
        competitorRelations: countSeeded('competitor_relations'),
        dataTasks: countSeeded('data_tasks'),
        importBatches: countSeeded('import_batches'),
        aiInsights: this.count(`SELECT COUNT(*) AS count FROM ai_insights WHERE id IN (${CLEANUP_INSIGHTS})`),
        developmentProjects: countSeeded('development_projects'),
        opportunities: countSeeded('opportunities'),
        researchResults: countSeeded('research_results'),
        watchlistItems: countSeeded('watchlist_items'),
      },
      archive: { products: this.count(`SELECT COUNT(*) AS count FROM (${ARCHIVABLE_SEED_PRODUCTS})`, false,
        'competitor_relations', 'watchlist_items') },
      preserve: {
        products: this.count('SELECT COUNT(*) AS count FROM products'),
        rules: this.count('SELECT COUNT(*) AS count FROM rule_profiles'),
        decisions: this.count('SELECT COUNT(*) AS count FROM decisions'),
        realSnapshots: this.count(`
          SELECT COUNT(*) AS count FROM market_snapshots WHERE source_type <> 'mock'
          UNION ALL SELECT COUNT(*) AS count FROM product_snapshots WHERE source_type <> 'mock'
        `, true),
      },
      blockers: this.cleanupBlockers(),
    };
  }

  async backup(targetPath: string): Promise<void> {
    await sqliteBackup(this.database, targetPath);
  }

  clearDemoObservations(): GoLivePreview {
    const preview = this.preview();
    transaction(this.database, () => {
      const blockers = this.cleanupBlockers();
      if (blockers.length > 0) throw new Error(`Demo 记录存在引用或未归属的 Mock 观察，禁止清理：${blockers.join('；')}`);
      for (const table of [
        'import_batches', 'competitor_relations', 'watchlist_items', 'development_projects',
        'opportunities', 'research_results', 'ai_insights', 'product_snapshots', 'market_snapshots', 'data_tasks',
      ] as const) {
        if (table === 'market_snapshots' || table === 'product_snapshots') {
          const candidates = table === 'market_snapshots' ? CLEANUP_MARKET_SNAPSHOTS : CLEANUP_PRODUCT_SNAPSHOTS;
          this.database.prepare(`DELETE FROM ${table} WHERE id IN (${candidates})`).run();
        } else if (table === 'ai_insights') {
          this.database.prepare(`DELETE FROM ai_insights WHERE id IN (${CLEANUP_INSIGHTS})`).run();
        } else {
          this.database.prepare(`DELETE FROM ${table} WHERE id IN (${SEEDED_IDS})`).run(table);
        }
      }
      this.database.prepare(`UPDATE products SET status = 'inactive', monitoring_enabled = 0,
        updated_at = ? WHERE id IN (${ARCHIVABLE_SEED_PRODUCTS})`)
        .run(new Date().toISOString(), 'competitor_relations', 'watchlist_items');
      this.database.prepare(`DELETE FROM demo_seed_records WHERE seed_id = 'v2-demo-seed'`).run();
    });
    return preview;
  }

  verify(): GoLiveVerification {
    const mockObservations = this.count(`
      SELECT COUNT(*) AS count FROM demo_seed_records WHERE seed_id = 'v2-demo-seed'
      UNION ALL SELECT COUNT(*) AS count FROM market_snapshots WHERE source_type = 'mock'
      UNION ALL SELECT COUNT(*) AS count FROM product_snapshots WHERE source_type = 'mock'
      UNION ALL SELECT COUNT(*) AS count FROM ai_insights WHERE id IN (${MOCK_REFERENCING_INSIGHTS})
    `, true);
    const settingsRow = this.database.prepare(`SELECT marketplace, default_market_id FROM app_settings WHERE id = 1`).get();
    const settings = settingsRow as unknown as { marketplace: string; default_market_id: string };
    const realMarketSnapshots = this.count(`
      SELECT COUNT(*) AS count FROM market_snapshots snapshot
      JOIN market_nodes market ON market.id = snapshot.market_node_id
      WHERE market.marketplace = ? AND snapshot.market_node_id = ?
        AND snapshot.source_type IN ('mcp', 'amazon', 'import')
        AND ${MARKET_METRICS}
    `, false, settings.marketplace, settings.default_market_id);
    const sellerSpriteMarketSnapshots = this.count(`
      SELECT COUNT(*) AS count FROM market_snapshots snapshot
      JOIN market_nodes market ON market.id = snapshot.market_node_id
      WHERE market.marketplace = ? AND snapshot.market_node_id = ?
        AND snapshot.source_type = 'mcp' AND ${MARKET_METRICS}
    `, false, settings.marketplace, settings.default_market_id);
    const activeOwnedProducts = this.count(`
      SELECT COUNT(*) AS count FROM products WHERE is_owned = 1 AND status = 'active' AND marketplace = ?
    `, false, settings.marketplace);
    const realOwnedProductSnapshots = this.count(`
      SELECT COUNT(DISTINCT snapshot.product_id) AS count
      FROM product_snapshots snapshot
      JOIN products product ON product.id = snapshot.product_id
      WHERE product.is_owned = 1 AND product.status = 'active' AND product.marketplace = ?
        AND snapshot.source_type IN ('mcp', 'amazon', 'import')
        AND ${PRODUCT_METRICS}
    `, false, settings.marketplace);
    const sellerSpriteOwnedProductSnapshots = this.count(`
      SELECT COUNT(DISTINCT snapshot.product_id) AS count
      FROM product_snapshots snapshot
      JOIN products product ON product.id = snapshot.product_id
      WHERE product.is_owned = 1 AND product.status = 'active' AND product.marketplace = ?
        AND snapshot.source_type = 'mcp' AND ${PRODUCT_METRICS}
    `, false, settings.marketplace);
    const sellerSpriteConnectionVerified = this.count(`
      SELECT COUNT(*) AS count FROM data_sources
      WHERE id = 'source-sellersprite-mcp' AND status = 'connected'
        AND julianday(last_sync_at) BETWEEN julianday('now', '-1 day')
          AND julianday('now', '+5 minutes')
    `) > 0;
    const sellerSpriteCapabilitiesAvailable = this.count(`
      SELECT CASE WHEN
        json_extract(capabilities_json, '$.capabilities.MARKET_RESEARCH') IS NOT NULL
        AND json_extract(capabilities_json, '$.capabilities.MARKET_STATISTICS') IS NOT NULL
        AND json_extract(capabilities_json, '$.capabilities.PRODUCT_CONCENTRATION') IS NOT NULL
        AND json_extract(capabilities_json, '$.capabilities.ASIN_SALES_TREND') IS NOT NULL
        AND json_extract(capabilities_json, '$.capabilities.ASIN_COMPETITOR_DISCOVERY') IS NOT NULL
        THEN 1 ELSE 0 END AS count
      FROM provider_capability_snapshots WHERE provider_id = 'sellersprite'
      ORDER BY collected_at DESC, rowid DESC LIMIT 1
    `) === 1;
    const sellerSpriteMarketCalls = this.count(`
      SELECT COUNT(*) AS count FROM mcp_call_logs
      WHERE provider_id = 'sellersprite' AND status = 'success'
        AND capability IN ('MARKET_RESEARCH', 'MARKET_STATISTICS', 'PRODUCT_CONCENTRATION')
        AND entity_type = 'market' AND entity_id = (
          SELECT category_id FROM market_nodes WHERE id = ? AND marketplace = ?)
        AND result_count > 0
    `, false, settings.default_market_id, settings.marketplace);
    const sellerSpriteAsinCalls = this.count(`
      SELECT COUNT(*) AS count FROM mcp_call_logs log
      JOIN products product ON product.asin = log.entity_id
        AND product.is_owned = 1 AND product.status = 'active' AND product.marketplace = ?
      WHERE log.provider_id = 'sellersprite' AND log.status = 'success'
        AND log.capability = 'ASIN_SALES_TREND' AND log.entity_type = 'product'
        AND log.result_count > 0
        AND EXISTS (SELECT 1 FROM product_snapshots snapshot
          WHERE snapshot.product_id = product.id AND snapshot.source_type = 'mcp'
            AND ${PRODUCT_METRICS})
    `, false, settings.marketplace);
    return {
      mockObservations,
      realMarketSnapshots,
      realOwnedProductSnapshots,
      activeOwnedProducts,
      sellerSpriteMarketSnapshots,
      sellerSpriteOwnedProductSnapshots,
      sellerSpriteConnectionVerified,
      sellerSpriteCapabilitiesAvailable,
      sellerSpriteMarketCalls,
      sellerSpriteAsinCalls,
      hasMinimumRealCoverage: mockObservations === 0
        && activeOwnedProducts > 0
        && realMarketSnapshots > 0
        && realOwnedProductSnapshots === activeOwnedProducts
        && sellerSpriteMarketSnapshots > 0
        && sellerSpriteOwnedProductSnapshots > 0
        && sellerSpriteConnectionVerified
        && sellerSpriteCapabilitiesAvailable
        && sellerSpriteMarketCalls > 0
        && sellerSpriteAsinCalls > 0,
    };
  }

  activateLiveMode(): void {
    const verification = this.verify();
    if (!verification.hasMinimumRealCoverage) {
      const problem = verification.mockObservations > 0 ? 'Mock 观察仍存在。' : '真实数据覆盖不足。';
      throw new Error(`无法切换 Live 模式：${problem}`);
    }
    this.database.prepare(`UPDATE app_settings SET mode = 'live' WHERE id = 1`).run();
  }

  private cleanupBlockers(): string[] {
    const checks: Array<[string, string]> = [
      ['Evidence', `SELECT COUNT(*) AS count FROM evidence_records evidence
        WHERE evidence.insight_id IN (${CLEANUP_DESCENDANTS})
          OR evidence.source_record_id IN (${CLEANUP_DESCENDANTS})`],
      ['research jobs', `SELECT COUNT(*) AS count FROM research_jobs job
        WHERE job.is_demo = 0 AND job.entity_id IN (${CLEANUP_DESCENDANTS})`],
      ['decisions', `SELECT COUNT(*) AS count FROM decisions decision
        WHERE decision.ai_insight_id IN (${CLEANUP_DESCENDANTS})
          OR decision.entity_id IN (${CLEANUP_DESCENDANTS})`],
      ['real insights', `SELECT COUNT(*) AS count FROM ai_insights insight
        WHERE insight.id NOT IN (${CLEANUP_DESCENDANTS})
          AND insight.entity_id IN (${CLEANUP_DESCENDANTS})`],
      ['real development projects', `SELECT COUNT(*) AS count FROM development_projects project
        WHERE project.id NOT IN (${CLEANUP_DESCENDANTS})
          AND (project.insight_id IN (${CLEANUP_DESCENDANTS})
            OR project.source_opportunity_id IN (${CLEANUP_DESCENDANTS}))`],
      ['real opportunities', `SELECT COUNT(*) AS count FROM opportunities opportunity
        WHERE opportunity.id NOT IN (${CLEANUP_DESCENDANTS})
          AND opportunity.research_result_id IN (${CLEANUP_DESCENDANTS})`],
      ['real watchlist items', `SELECT COUNT(*) AS count FROM watchlist_items item
        WHERE item.id NOT IN (${CLEANUP_DESCENDANTS})
          AND item.item_id IN (${CLEANUP_DESCENDANTS})`],
      ['real import batches', `SELECT COUNT(*) AS count FROM import_batches batch
        WHERE batch.id NOT IN (${CLEANUP_DESCENDANTS})
          AND batch.task_id IN (${CLEANUP_DESCENDANTS})`],
      ['unregistered Mock observations', `SELECT COUNT(*) AS count FROM market_snapshots
        WHERE source_type = 'mock' AND id NOT IN (${CLEANUP_MARKET_SNAPSHOTS})
        UNION ALL SELECT COUNT(*) AS count FROM product_snapshots
        WHERE source_type = 'mock' AND id NOT IN (${CLEANUP_PRODUCT_SNAPSHOTS})`],
      ['unregistered Mock insights', `SELECT COUNT(*) AS count FROM ai_insights
        WHERE id IN (${MOCK_REFERENCING_INSIGHTS}) AND id NOT IN (${CLEANUP_INSIGHTS})`],
    ];
    return checks.flatMap(([label, sql]) => {
      const count = this.count(sql, label === 'unregistered Mock observations');
      return count > 0 ? [`${label}: ${count}`] : [];
    });
  }

  private count(sql: string, sum = false, ...parameters: Array<string | null>): number {
    const rows = this.database.prepare(sql).all(...parameters) as unknown as CountRow[];
    return sum ? rows.reduce((total, row) => total + Number(row.count), 0) : Number(rows[0]?.count ?? 0);
  }
}
