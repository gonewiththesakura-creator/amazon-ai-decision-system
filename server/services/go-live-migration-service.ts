import { backup as sqliteBackup } from 'node:sqlite';
import { createHash } from 'node:crypto';
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
  retainedDemoHistory: Array<{
    kind: 'demo_rule_score_evidence' | 'legacy_demo_rejection';
    ref: string;
    detail: string;
    status: string;
    linkedMockInsights: number;
  }>;
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
  sellerSpriteCriticalRunId: string | null;
  verifiedEvidenceEntities: number;
  requiredEvidenceEntities: number;
  readyForDemoCleanup: boolean;
  hasMinimumRealCoverage: boolean;
}

interface CoverageEntity { id: string; asin: string }

function coveragePartition(
  summary: Record<string, unknown>, roster: CoverageEntity[],
): { covered: CoverageEntity[]; failed: CoverageEntity[] } | null {
  if (!Array.isArray(summary.covered) || !Array.isArray(summary.failures)) return null;
  const byId = new Map(roster.map((item) => [item.id, item]));
  const read = (items: unknown[], failed: boolean): CoverageEntity[] | null => {
    const result: CoverageEntity[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const entry = item as Record<string, unknown>;
      if (typeof entry.id !== 'string') return null;
      const expected = byId.get(entry.id);
      if (!expected || (!failed && entry.asin !== expected.asin)
        || (failed && entry.status !== 'failed')) return null;
      result.push(expected);
    }
    return result;
  };
  const covered = read(summary.covered, false);
  const failed = read(summary.failures, true);
  if (!covered || !failed || covered.length !== summary.success || failed.length !== summary.failed) return null;
  const ids = [...covered, ...failed].map((item) => item.id);
  if (new Set(ids).size !== roster.length || ids.some((id) => !byId.has(id))) return null;
  return { covered, failed };
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
      retainedDemoHistory: this.retainedDemoHistory(),
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
      if (!this.verify().readyForDemoCleanup) {
        throw new Error('Go Live 迁移需要先验证真实 SellerSprite MCP 市场及自有 ASIN 数据，禁止清理 Demo。');
      }
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
      UNION ALL SELECT COUNT(*) AS count FROM metric_facts WHERE source_type = 'mock'
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
      SELECT COUNT(*) AS count FROM products
      WHERE is_owned = 1 AND is_parent = 0 AND status = 'active' AND marketplace = ?
    `, false, settings.marketplace);
    const activeMockOwnedProducts = this.count(`
      SELECT COUNT(*) AS count FROM products
      WHERE is_owned = 1 AND status = 'active' AND source_type = 'mock' AND marketplace = ?
    `, false, settings.marketplace);
    const realOwnedProductSnapshots = this.count(`
      SELECT COUNT(DISTINCT snapshot.product_id) AS count
      FROM product_snapshots snapshot
      JOIN products product ON product.id = snapshot.product_id
      WHERE product.is_owned = 1 AND product.is_parent = 0
        AND product.status = 'active' AND product.marketplace = ?
        AND snapshot.source_type IN ('mcp', 'amazon', 'import')
        AND ${PRODUCT_METRICS}
    `, false, settings.marketplace);
    const sellerSpriteOwnedProductSnapshots = this.count(`
      SELECT COUNT(DISTINCT snapshot.product_id) AS count
      FROM product_snapshots snapshot
      JOIN products product ON product.id = snapshot.product_id
      WHERE product.is_owned = 1 AND product.is_parent = 0
        AND product.status = 'active' AND product.marketplace = ?
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
        AND julianday(collected_at) BETWEEN julianday('now', '-1 day')
          AND julianday('now', '+5 minutes')
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
    const marketNode = this.database.prepare(`
      SELECT category_id, status, source_type FROM market_nodes
      WHERE id = ? AND marketplace = ?
    `).get(settings.default_market_id, settings.marketplace) as {
      category_id: string | null; status: string; source_type: string;
    } | undefined;
    const verifiedMarketPath = /^\d+(?::\d+)*$/.test(marketNode?.category_id ?? '')
      && marketNode?.status === 'active' && marketNode.source_type !== 'mock';
    const sellerSpriteAsinCalls = this.count(`
      WITH RECURSIVE market_scope(id) AS (
        SELECT id FROM market_nodes WHERE id = ? AND marketplace = ?
          AND status = 'active' AND source_type <> 'mock'
        UNION
        SELECT child.id FROM market_nodes child
        JOIN market_scope parent ON child.parent_id = parent.id
        WHERE child.marketplace = ? AND child.status = 'active' AND child.source_type <> 'mock'
      )
      SELECT COUNT(*) AS count FROM mcp_call_logs log
      JOIN products product ON product.asin = log.entity_id
        AND product.is_owned = 1 AND product.is_parent = 0 AND product.status = 'active'
        AND product.source_type <> 'mock' AND product.marketplace = ?
      JOIN market_scope scope ON scope.id = product.market_node_id
      WHERE log.provider_id = 'sellersprite' AND log.status = 'success'
        AND log.capability = 'ASIN_SALES_TREND' AND log.entity_type = 'product'
        AND log.result_count > 0
        AND EXISTS (SELECT 1 FROM product_snapshots snapshot
          WHERE snapshot.product_id = product.id AND snapshot.source_type = 'mcp'
            AND ${PRODUCT_METRICS})
    `, false, settings.default_market_id, settings.marketplace,
      settings.marketplace, settings.marketplace);
    const criticalProof = verifiedMarketPath
      ? this.completeCriticalRun(settings.marketplace, settings.default_market_id, marketNode!.category_id!)
      : { runId: null, verifiedEvidenceEntities: 0, requiredEvidenceEntities: activeOwnedProducts + 1 };
    const sellerSpriteCriticalRunId = criticalProof.runId;
    const readyForDemoCleanup = verifiedMarketPath
      && sellerSpriteConnectionVerified
      && sellerSpriteCapabilitiesAvailable
      && sellerSpriteCriticalRunId !== null;
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
      sellerSpriteCriticalRunId,
      verifiedEvidenceEntities: criticalProof.verifiedEvidenceEntities,
      requiredEvidenceEntities: criticalProof.requiredEvidenceEntities,
      readyForDemoCleanup,
      hasMinimumRealCoverage: mockObservations === 0
        && activeOwnedProducts > 0
        && activeMockOwnedProducts === 0
        && realMarketSnapshots > 0
        && realOwnedProductSnapshots === activeOwnedProducts
        && sellerSpriteOwnedProductSnapshots > 0
        && readyForDemoCleanup,
    };
  }

  private completeCriticalRun(marketplace: string, marketId: string, nodeIdPath: string): {
    runId: string | null;
    verifiedEvidenceEntities: number;
    requiredEvidenceEntities: number;
  } {
    const owned = this.database.prepare(`
      WITH RECURSIVE market_scope(id) AS (
        SELECT id FROM market_nodes
        WHERE id = ? AND marketplace = ? AND status = 'active' AND source_type <> 'mock'
        UNION
        SELECT child.id FROM market_nodes child
        JOIN market_scope parent ON child.parent_id = parent.id
        WHERE child.marketplace = ? AND child.status = 'active' AND child.source_type <> 'mock'
      )
      SELECT product.id, product.asin, product.market_node_id AS marketNodeId,
        CASE WHEN scope.id IS NOT NULL THEN 1 ELSE 0 END AS inScope
      FROM products product
      LEFT JOIN market_scope scope ON scope.id = product.market_node_id
      WHERE product.marketplace = ? AND product.is_owned = 1 AND product.is_parent = 0
        AND product.status = 'active'
        AND product.source_type <> 'mock' ORDER BY product.id
    `).all(marketId, marketplace, marketplace, marketplace) as Array<{
      id: string; asin: string; marketNodeId: string; inScope: number;
    }>;
    const requiredEvidenceEntities = owned.length + 1;
    const incomplete = { runId: null, verifiedEvidenceEntities: 0, requiredEvidenceEntities };
    if (owned.length === 0 || owned.some((product) => product.inScope !== 1)) return incomplete;
    const directCompetitorRoster = this.currentDirectCompetitorRoster(marketplace);
    let latestEvidenceCount: number | null = null;

    const runs = this.database.prepare(`
      SELECT run.id, run.coverage_json AS coverageJson
      FROM data_coverage_runs run
      JOIN data_tasks task ON task.id = run.id AND task.sync_run_id = run.id
      WHERE run.marketplace = ? AND run.run_type = 'critical_sync' AND run.is_complete = 1
        AND task.marketplace = ? AND task.task_type = 'critical_sync' AND task.target = ?
        AND task.source_id = 'source-sellersprite-mcp' AND task.status = 'success'
        AND task.total = ? AND task.success = task.total AND task.failed = 0
        AND julianday(run.created_at) BETWEEN julianday('now', '-1 day')
          AND julianday('now', '+5 minutes')
        AND julianday(task.completed_at) BETWEEN julianday('now', '-1 day')
          AND julianday('now', '+5 minutes')
      ORDER BY run.created_at DESC, run.id DESC
    `).all(marketplace, marketplace, marketId, owned.length + 1) as Array<{
      id: string; coverageJson: string;
    }>;
    for (const run of runs) {
      let coverage: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(run.coverageJson);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        coverage = parsed as Record<string, unknown>;
      } catch { continue; }
      const roster = coverage.ownedProducts;
      const month = coverage.month;
      if (coverage.marketId !== marketId || coverage.nodeIdPath !== nodeIdPath
        || typeof month !== 'string' || !/^\d{6}$/.test(month)
        || !Array.isArray(roster) || roster.length !== owned.length
        || !roster.every((item, index) => {
          if (!item || typeof item !== 'object') return false;
          const entry = item as Record<string, unknown>;
           return entry.id === owned[index]!.id && entry.asin === owned[index]!.asin
             && entry.marketNodeId === owned[index]!.marketNodeId;
        })) continue;
      if (!this.secondaryTaskRecorded(coverage.candidateDiscovery, run.id, marketplace,
        'competitor_discovery', 'owned-products', owned.length)
        || !this.secondaryTaskRecorded(coverage.secondaryCompetitors, run.id, marketplace,
          'competitor_refresh', 'watched-competitors', undefined,
          directCompetitorRoster)) continue;
      const candidateSummary = coverage.candidateDiscovery as Record<string, unknown>;
      const competitorSummary = coverage.secondaryCompetitors as Record<string, unknown>;
      const candidatePartition = coveragePartition(candidateSummary, owned);
      const competitorPartition = coveragePartition(competitorSummary, directCompetitorRoster);
      if (candidateSummary.status !== 'success' || candidateSummary.success !== owned.length
        || candidateSummary.failed !== 0
        || !candidatePartition || !competitorPartition
        || !this.candidateLinksMatchRun(candidateSummary, owned, run.id)
        || (directCompetitorRoster.length > 0 && competitorSummary.success === 0)) continue;
      const year = Number(month.slice(0, 4));
      const monthNumber = Number(month.slice(4));
      if (monthNumber < 1 || monthNumber > 12) continue;
      const marketDate = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
      const runCapabilitiesAvailable = this.count(`
        SELECT CASE WHEN
          json_extract(capabilities_json, '$.capabilities.MARKET_RESEARCH') IS NOT NULL
          AND json_extract(capabilities_json, '$.capabilities.MARKET_STATISTICS') IS NOT NULL
          AND json_extract(capabilities_json, '$.capabilities.PRODUCT_CONCENTRATION') IS NOT NULL
          AND json_extract(capabilities_json, '$.capabilities.ASIN_SALES_TREND') IS NOT NULL
          AND json_extract(capabilities_json, '$.capabilities.ASIN_COMPETITOR_DISCOVERY') IS NOT NULL
          AND julianday(collected_at) BETWEEN julianday('now', '-1 day')
            AND julianday('now', '+5 minutes')
          THEN 1 ELSE 0 END AS count
        FROM provider_capability_snapshots
        WHERE provider_id = 'sellersprite' AND sync_run_id = ?
        ORDER BY collected_at DESC, rowid DESC LIMIT 1
      `, false, run.id) === 1;
      if (!runCapabilitiesAvailable) continue;
      const calls = this.database.prepare(`
        SELECT provider_id AS providerId, capability, entity_type AS entityType, entity_id AS entityId,
          status, result_count AS resultCount, cache_hit AS cacheHit,
          CASE WHEN julianday(started_at) BETWEEN julianday('now', '-1 day')
            AND julianday('now', '+5 minutes')
            AND julianday(COALESCE(completed_at, started_at)) BETWEEN julianday('now', '-1 day')
            AND julianday('now', '+5 minutes') THEN 1 ELSE 0 END AS isFresh
        FROM mcp_call_logs WHERE sync_run_id = ?
      `).all(run.id) as Array<{
        providerId: string;
        capability: string;
        entityType: string | null;
        entityId: string | null;
        status: string;
        resultCount: number | null;
        cacheHit: number;
        isFresh: number;
      }>;
      if (calls.length === 0 || calls.some((call) => call.cacheHit !== 0 || call.isFresh !== 1)) continue;
      const hasCall = (capability: string, type: string, id: string, allowEmpty = false): boolean => calls.some((call) => (
        call.providerId === 'sellersprite' && call.capability === capability
          && call.entityType === type && call.entityId === id
          && call.status === 'success' && call.resultCount !== null
          && (allowEmpty ? call.resultCount >= 0 : call.resultCount > 0)
      ));
      const hasToolDiscovery = calls.some((call) => (
        call.providerId === 'sellersprite' && call.capability === 'LIST_TOOLS'
          && call.status === 'success' && call.cacheHit === 0
          && call.resultCount !== null && call.resultCount > 0
      ));
      if (!hasToolDiscovery
        || !hasCall('MARKET_STATISTICS', 'market', nodeIdPath)
        || !hasCall('PRODUCT_CONCENTRATION', 'market', nodeIdPath)
        || !owned.every((product) => hasCall('ASIN_SALES_TREND', 'product', product.asin.toUpperCase()))
        || !owned.every((product) => hasCall(
          'ASIN_COMPETITOR_DISCOVERY', 'product', product.asin.toUpperCase(), true,
        ))
        || !competitorPartition.covered.every((product) => hasCall(
          'ASIN_SALES_TREND', 'product', product.asin.toUpperCase(),
        ))) continue;
      const marketLinks = this.count(`
        SELECT COUNT(*) AS count FROM mcp_sync_observation_links link
        JOIN market_snapshots snapshot ON snapshot.id = link.snapshot_id
        WHERE link.sync_run_id = ? AND link.snapshot_kind = 'market'
          AND link.entity_id = ? AND snapshot.market_node_id = link.entity_id
          AND snapshot.source_type = 'mcp' AND snapshot.source = 'SellerSprite MCP'
          AND COALESCE(snapshot.observation_date, snapshot.date) = ?
          AND (link.disposition = 'reused' OR snapshot.sync_run_id = link.sync_run_id)
          AND ${MARKET_METRICS}
      `, false, run.id, marketId, marketDate);
      if (marketLinks === 0) continue;
      const marketFacts = this.count(`
        SELECT COUNT(*) AS count FROM mcp_sync_observation_links link
        JOIN metric_facts fact ON fact.id = link.snapshot_id
        WHERE link.sync_run_id = ? AND link.snapshot_kind = 'fact'
          AND link.entity_id = ? AND fact.entity_type = 'market'
          AND fact.entity_id = link.entity_id AND fact.marketplace = ?
          AND fact.source_type = 'mcp' AND fact.source_id = 'source-sellersprite-mcp'
          AND fact.observation_date = ? AND fact.numeric_value IS NOT NULL
          AND (link.disposition = 'reused' OR fact.sync_run_id = link.sync_run_id)
      `, false, run.id, marketId, marketplace, marketDate);
      if (marketFacts === 0) continue;
      const hasProductLink = (productId: string): boolean => this.count(`
        SELECT COUNT(*) AS count FROM mcp_sync_observation_links link
        JOIN product_snapshots snapshot ON snapshot.id = link.snapshot_id
        WHERE link.sync_run_id = ? AND link.snapshot_kind = 'product'
          AND link.entity_id = ? AND snapshot.product_id = link.entity_id
          AND snapshot.source_type = 'mcp' AND snapshot.source = 'SellerSprite MCP'
          AND (link.disposition = 'reused' OR snapshot.sync_run_id = link.sync_run_id)
          AND ${PRODUCT_METRICS}
      `, false, run.id, productId) > 0;
      const allProductsLinked = owned.every((product) => hasProductLink(product.id));
      if (!allProductsLinked) continue;
      const hasProductFact = (
        productId: string, entityType: 'product' | 'competitor',
      ): boolean => this.count(`
        SELECT COUNT(*) AS count FROM mcp_sync_observation_links link
        JOIN metric_facts fact ON fact.id = link.snapshot_id
        WHERE link.sync_run_id = ? AND link.snapshot_kind = 'fact'
          AND link.entity_id = ? AND fact.entity_type = ?
          AND fact.entity_id = link.entity_id AND fact.marketplace = ?
          AND fact.source_type = 'mcp' AND fact.source_id = 'source-sellersprite-mcp'
          AND fact.numeric_value IS NOT NULL
          AND (link.disposition = 'reused' OR fact.sync_run_id = link.sync_run_id)
      `, false, run.id, productId, entityType, marketplace) > 0;
      const allProductFactsLinked = owned.every((product) => hasProductFact(product.id, 'product'));
      const coveredCompetitorsLinked = competitorPartition.covered.every((product) => (
        hasProductLink(product.id) && hasProductFact(product.id, 'competitor')
      ));
      if (!allProductFactsLinked || !coveredCompetitorsLinked) continue;
      const verifiedEvidenceEntities = Number(this.hasLinkedWorkflowEvidence(
        run.id, marketplace, 'market', marketId,
      )) + owned.filter((product) => this.hasLinkedWorkflowEvidence(
        run.id, marketplace, 'owned_product', product.id,
      )).length;
      latestEvidenceCount ??= verifiedEvidenceEntities;
      if (verifiedEvidenceEntities === requiredEvidenceEntities) {
        return { runId: run.id, verifiedEvidenceEntities, requiredEvidenceEntities };
      }
    }
    return { ...incomplete, verifiedEvidenceEntities: latestEvidenceCount ?? 0 };
  }

  private hasLinkedWorkflowEvidence(
    runId: string, marketplace: string,
    entityType: 'market' | 'owned_product', entityId: string,
  ): boolean {
    const snapshotKind = entityType === 'market' ? 'market' : 'product';
    const snapshotTable = entityType === 'market' ? 'market_snapshots' : 'product_snapshots';
    const snapshotEntityColumn = entityType === 'market' ? 'market_node_id' : 'product_id';
    const snapshotMetrics = entityType === 'market' ? MARKET_METRICS : PRODUCT_METRICS;
    const factEntityType = entityType === 'market' ? 'market' : 'product';
    const expectedJobType = entityType === 'market' ? 'existing_market' : 'owned_product';
    const expectedInsightType = entityType === 'market' ? 'market_diagnosis' : 'owned_product_diagnosis';
    const jobEntityTypes = entityType === 'market'
      ? ['market', 'market_node'] as const
      : ['owned_product', 'product'] as const;
    return Boolean(this.database.prepare(`
      SELECT 1 FROM evidence_records evidence
      JOIN research_jobs job ON job.id = evidence.research_job_id
      JOIN mcp_sync_observation_links link
        ON link.sync_run_id = evidence.sync_run_id
          AND link.snapshot_id = evidence.source_record_id
          AND link.entity_id = job.entity_id
      WHERE evidence.sync_run_id = ? AND evidence.source_type = 'mcp'
        AND job.is_demo = 0 AND job.marketplace = ?
        AND job.entity_type IN (?, ?) AND job.entity_id = ?
        AND job.job_type = ? AND job.status = 'monitoring' AND job.error IS NULL
        AND evidence.data_version = job.data_version
        AND evidence.insight_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM ai_insights insight
          WHERE insight.id = evidence.insight_id
            AND insight.research_job_id = job.id
            AND insight.entity_type = 'research_job' AND insight.entity_id = job.id
            AND insight.insight_type = ?
            AND insight.data_version = job.data_version
            AND insight.prompt_version = job.prompt_version
            AND json_valid(insight.evidence_ids_json) = 1
            AND EXISTS (
              SELECT 1 FROM json_each(insight.evidence_ids_json) referenced
              WHERE referenced.value = evidence.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM json_each(insight.evidence_ids_json) referenced
              LEFT JOIN evidence_records component ON component.id = referenced.value
              WHERE component.id IS NULL
                OR component.research_job_id <> job.id
                OR component.data_version <> job.data_version
                OR (component.source_type = 'mcp'
                  AND (component.sync_run_id IS NULL OR component.sync_run_id <> ?))
            )
        )
        AND EXISTS (
          SELECT 1 FROM research_steps report
          WHERE report.research_job_id = job.id AND report.step_type = 'report'
            AND report.status = 'completed' AND report.completed_at IS NOT NULL
        )
        AND EXISTS (
          SELECT 1 FROM research_steps analysis
          WHERE analysis.research_job_id = job.id AND analysis.step_type = 'ai_analysis'
            AND analysis.status = 'completed' AND analysis.completed_at IS NOT NULL
        )
        AND (
          (link.snapshot_kind = ? AND EXISTS (
            SELECT 1 FROM ${snapshotTable} snapshot
            WHERE snapshot.id = link.snapshot_id
              AND snapshot.${snapshotEntityColumn} = link.entity_id
              AND snapshot.source_type = 'mcp' AND snapshot.source = 'SellerSprite MCP'
              AND (link.disposition = 'reused' OR snapshot.sync_run_id = link.sync_run_id)
              AND ${snapshotMetrics}
          ))
          OR (link.snapshot_kind = 'fact' AND EXISTS (
            SELECT 1 FROM metric_facts fact
            WHERE fact.id = link.snapshot_id AND fact.entity_type = ?
              AND fact.entity_id = link.entity_id AND fact.marketplace = ?
              AND fact.source_type = 'mcp' AND fact.source_id = 'source-sellersprite-mcp'
              AND fact.numeric_value IS NOT NULL
              AND (link.disposition = 'reused' OR fact.sync_run_id = link.sync_run_id)
          ))
        )
      LIMIT 1
    `).get(runId, marketplace, ...jobEntityTypes, entityId,
      expectedJobType, expectedInsightType, runId, snapshotKind, factEntityType, marketplace));
  }

  private candidateLinksMatchRun(
    summary: Record<string, unknown>, owned: Array<{ id: string; asin: string }>, runId: string,
  ): boolean {
    if (!Number.isSafeInteger(summary.candidates) || (summary.candidates as number) < 0
      || !Array.isArray(summary.covered)) return false;
    const expected = new Map<string, number>();
    for (const item of summary.covered) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const entry = item as Record<string, unknown>;
      if (typeof entry.id !== 'string' || !owned.some((product) => product.id === entry.id)
        || !Number.isSafeInteger(entry.candidates) || (entry.candidates as number) < 0) return false;
      expected.set(entry.id, entry.candidates as number);
    }
    if (expected.size !== owned.length
      || [...expected.values()].reduce((sum, value) => sum + value, 0) !== summary.candidates) return false;
    const rows = this.database.prepare(`
      SELECT link.source_product_id AS productId, COUNT(*) AS count,
        SUM(CASE WHEN candidate.source_product_id = link.source_product_id
          AND candidate.source_type = 'mcp' AND candidate.source = 'SellerSprite MCP'
          AND ((link.disposition = 'inserted' AND candidate.sync_run_id = link.sync_run_id)
            OR (link.disposition = 'reused' AND candidate.sync_run_id IS NOT link.sync_run_id))
          THEN 0 ELSE 1 END) AS invalid
      FROM competitor_candidate_run_links link
      JOIN competitor_candidates candidate ON candidate.id = link.candidate_id
      WHERE link.sync_run_id = ?
      GROUP BY link.source_product_id
    `).all(runId) as Array<{ productId: string; count: number; invalid: number }>;
    return rows.every((row) => expected.get(row.productId) === row.count && row.invalid === 0)
      && rows.reduce((sum, row) => sum + row.count, 0) === summary.candidates;
  }

  private secondaryTaskRecorded(
    summary: unknown, runId: string, marketplace: string, taskType: string,
    target: string, expectedTotal?: number,
    expectedRoster?: Array<{ id: string; asin: string }>,
  ): boolean {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return false;
    const value = summary as Record<string, unknown>;
    if (typeof value.taskId !== 'string' || value.taskId.length === 0
      || typeof value.status !== 'string'
      || !['success', 'partial', 'failed'].includes(value.status)
      || !Number.isSafeInteger(value.total) || !Number.isSafeInteger(value.success)
      || !Number.isSafeInteger(value.failed)) return false;
    const total = value.total as number;
    const success = value.success as number;
    const failed = value.failed as number;
    if (total < 0 || success < 0 || failed < 0 || success + failed !== total
      || (expectedTotal !== undefined && total !== expectedTotal)
      || value.status !== (failed === 0 ? 'success' : success === 0 ? 'failed' : 'partial')) return false;
    if (expectedRoster !== undefined) {
      if (total !== expectedRoster.length
        || !Array.isArray(value.roster) || value.roster.length !== expectedRoster.length
        || !value.roster.every((item, index) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
          const entry = item as Record<string, unknown>;
          return entry.id === expectedRoster[index]?.id && entry.asin === expectedRoster[index]?.asin;
        })) return false;
    }

    const task = this.database.prepare(`
      SELECT status, total, success, failed FROM data_tasks
      WHERE id = ? AND sync_run_id = ? AND marketplace = ?
        AND source_id = 'source-sellersprite-mcp' AND task_type = ? AND target = ?
        AND julianday(completed_at) BETWEEN julianday('now', '-1 day')
          AND julianday('now', '+5 minutes')
    `).get(value.taskId, runId, marketplace, taskType, target) as {
      status: string; total: number; success: number; failed: number;
    } | undefined;
    if (!task) return false;
    return task.status === value.status && task.total === total
      && task.success === success && task.failed === failed;
  }

  private currentDirectCompetitorRoster(marketplace: string): Array<{ id: string; asin: string }> {
    return this.database.prepare(`
      SELECT DISTINCT competitor.id, competitor.asin
      FROM competitor_relations relation
      JOIN products owned ON owned.id = relation.owned_product_id
      JOIN products competitor ON competitor.id = relation.competitor_product_id
      WHERE relation.relation_type = 'direct'
        AND owned.marketplace = ? AND owned.is_owned = 1 AND owned.is_parent = 0 AND owned.status = 'active'
        AND owned.source_type <> 'mock'
        AND competitor.marketplace = owned.marketplace AND competitor.is_owned = 0
        AND competitor.is_parent = 0
        AND competitor.status = 'active' AND competitor.source_type <> 'mock'
      ORDER BY competitor.id
    `).all(marketplace) as Array<{ id: string; asin: string }>;
  }

  activateLiveMode(): void {
    transaction(this.database, () => {
      const verification = this.verify();
      if (!verification.hasMinimumRealCoverage) {
        const problem = verification.mockObservations > 0 ? 'Mock 观察仍存在。' : '真实数据覆盖不足。';
        throw new Error(`无法切换 Live 模式：${problem}`);
      }
      this.database.prepare(`UPDATE app_settings SET mode = 'live' WHERE id = 1`).run();
    });
  }

  private retainedDemoHistory(): GoLivePreview['retainedDemoHistory'] {
    const derivedScores = this.database.prepare(`
      SELECT evidence.id, job.status FROM evidence_records evidence
      JOIN research_jobs job ON job.id = evidence.research_job_id
      JOIN ai_insights insight ON insight.id = evidence.insight_id
      WHERE job.is_demo = 1 AND evidence.source_type = 'manual'
        AND evidence.metric_name = 'opportunity_score' AND evidence.period = 'research_run'
        AND evidence.source_record_id IS NULL
        AND evidence.source = job.rule_profile_id || '@' || job.rule_profile_version
        AND evidence.data_version = job.data_version
        AND CASE WHEN json_valid(evidence.calculation)
          THEN json_type(evidence.calculation) = 'object' ELSE 0 END
        AND insight.research_job_id = job.id AND insight.entity_type = 'research_job'
        AND insight.data_version = job.data_version
        AND insight.id IN (${MOCK_REFERENCING_INSIGHTS})
        AND EXISTS (SELECT 1 FROM json_each(insight.evidence_ids_json) ref
          WHERE ref.value = evidence.id)
        AND NOT EXISTS (SELECT 1 FROM json_each(insight.evidence_json) item
          WHERE COALESCE(json_type(item.value, '$.provenance'), '') <> 'array'
            OR json_array_length(item.value, '$.provenance') = 0
            OR EXISTS (SELECT 1 FROM json_each(item.value, '$.provenance') provenance
              WHERE NOT (
                json_extract(provenance.value, '$.sourceType') = 'mock'
                OR (json_extract(provenance.value, '$.sourceType') = 'manual'
                  AND json_extract(provenance.value, '$.source') = evidence.source
                  AND json_extract(item.value, '$.id') = evidence.id)
              )))
      ORDER BY evidence.id
    `).all() as Array<{ id: string; status: string }>;
    const rejectedOpportunities = this.database.prepare(`
      SELECT decision.id, opportunity.status FROM decisions decision
      JOIN opportunities opportunity ON opportunity.id = decision.entity_id
      JOIN ai_insights insight ON insight.id = decision.ai_insight_id
      WHERE decision.entity_type = 'opportunity' AND decision.decision = 'reject'
        AND decision.research_job_id IS NULL AND opportunity.status = 'rejected'
        AND insight.entity_type = 'opportunity' AND insight.entity_id = opportunity.id
        AND insight.data_version = decision.data_version
        AND insight.data_version LIKE 'demo-%'
        AND insight.id IN (${MOCK_ONLY_INSIGHTS})
        AND EXISTS (SELECT 1 FROM research_results result
          JOIN demo_seed_records seed ON seed.seed_id = 'v2-demo-seed'
            AND seed.table_name = 'research_results' AND seed.record_id = result.id
          JOIN json_each(result.opportunity_ids_json) linked ON linked.value = opportunity.id)
      ORDER BY decision.id
    `).all() as Array<{ id: string; status: string }>;
    const reference = (kind: string, id: string): string =>
      `demo-${createHash('sha256').update(`${kind}:${id}`).digest('hex').slice(0, 12)}`;

    return [
      ...derivedScores.map(({ id, status }) => ({
        kind: 'demo_rule_score_evidence' as const,
        ref: reference('demo_rule_score_evidence', id),
        detail: '规则派生得分；原记录标记为 manual，关联 Demo Research Job',
        status,
        linkedMockInsights: 1,
      })),
      ...rejectedOpportunities.map(({ id, status }) => ({
        kind: 'legacy_demo_rejection' as const,
        ref: reference('legacy_demo_rejection', id),
        detail: '已拒绝的 Demo 机会；关联 Mock Insight 与决策记录',
        status,
        linkedMockInsights: 1,
      })),
    ];
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
      ['unregistered Mock metric facts', `SELECT COUNT(*) AS count FROM metric_facts
        WHERE source_type = 'mock'`],
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
