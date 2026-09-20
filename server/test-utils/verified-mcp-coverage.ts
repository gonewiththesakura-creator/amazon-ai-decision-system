import type { AppDatabase } from '../database/database.js';
import { randomUUID } from 'node:crypto';

// Synthetic records for exercising the Go Live gate in isolated test databases only.
export function addVerifiedMcpCoverage(
  database: AppDatabase,
  marketId = 'mkt-memory-foam',
  ownedProductId = 'verified-owned',
  productCollectedAt?: string,
): void {
  const now = new Date().toISOString();
  const productObservationCollectedAt = productCollectedAt ?? now;
  const settings = database.prepare('SELECT marketplace FROM app_settings WHERE id = 1')
    .get() as { marketplace: string };
  const existingProduct = database.prepare('SELECT asin FROM products WHERE id = ?')
    .get(ownedProductId) as { asin: string } | undefined;
  const runId = randomUUID();
  const candidateTaskId = randomUUID();
  const competitorTaskId = randomUUID();
  database.prepare('UPDATE app_settings SET default_market_id = ? WHERE id = 1').run(marketId);
  database.prepare(`UPDATE market_nodes SET category_id = ?, status = 'active',
    source_type = CASE WHEN source_type = 'mock' THEN 'import' ELSE source_type END
    WHERE id = ? AND marketplace = ?`)
    .run('1055398:1063252', marketId, settings.marketplace);
  if (!existingProduct) {
    database.prepare(`INSERT INTO products (
      id, asin, sku, brand, title, image_url, marketplace, product_type, is_owned,
      market_node_id, source_type, created_at
    ) VALUES (?, 'B0TEST0001', 'TEST-1', 'Test', 'Synthetic owned test product', '', ?,
      'pillow', 1, ?, 'import', ?)`)
      .run(ownedProductId, settings.marketplace, marketId, now);
  }
  const owned = database.prepare(`
    WITH RECURSIVE market_scope(id) AS (
      SELECT id FROM market_nodes
      WHERE id = ? AND marketplace = ? AND status = 'active' AND source_type <> 'mock'
      UNION
      SELECT child.id FROM market_nodes child
      JOIN market_scope parent ON child.parent_id = parent.id
      WHERE child.marketplace = ? AND child.status = 'active' AND child.source_type <> 'mock'
    )
    SELECT product.id, product.asin, product.market_node_id AS marketNodeId FROM products product
    JOIN market_scope scope ON scope.id = product.market_node_id
    WHERE product.marketplace = ? AND product.is_owned = 1 AND product.is_parent = 0
      AND product.status = 'active'
      AND product.source_type <> 'mock' ORDER BY product.id
  `).all(marketId, settings.marketplace, settings.marketplace, settings.marketplace) as Array<{
    id: string; asin: string; marketNodeId: string;
  }>;
  const rootNodeIdPath = '1055398:1063252';
  const marketNodes = [{ id: marketId, nodeIdPath: rootNodeIdPath }];
  for (const id of [...new Set(owned.map((product) => product.marketNodeId))]
    .filter((id) => id !== marketId).sort()) {
    const child = database.prepare(`SELECT category_id AS nodeIdPath FROM market_nodes
      WHERE id = ? AND marketplace = ? AND status = 'active' AND source_type <> 'mock'`)
      .get(id, settings.marketplace) as { nodeIdPath: string | null } | undefined;
    if (!child?.nodeIdPath) throw new Error('Synthetic child market requires a mapped category path.');
    marketNodes.push({ id, nodeIdPath: child.nodeIdPath });
  }
  const directCompetitors = database.prepare(`
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
  `).all(settings.marketplace) as Array<{ id: string; asin: string }>;
  database.prepare(`INSERT INTO data_tasks (
    id, sync_run_id, name, source_id, task_type, target, source, marketplace,
    status, started_at, completed_at, total, success, failed, created_at
  ) VALUES (?, ?, 'Synthetic critical proof', 'source-sellersprite-mcp',
    'critical_sync', ?, 'SellerSprite MCP', ?, 'success', ?, ?, ?, ?, 0, ?)`)
    .run(runId, runId, marketId, settings.marketplace, now, now,
      owned.length + marketNodes.length, owned.length + marketNodes.length, now);
  database.prepare(`INSERT INTO data_tasks (
    id, sync_run_id, name, source_id, task_type, target, source, marketplace,
    status, started_at, completed_at, total, success, failed, created_at
  ) VALUES (?, ?, 'Synthetic candidate coverage', 'source-sellersprite-mcp',
    'competitor_discovery', 'owned-products', 'SellerSprite MCP', ?, 'success',
    ?, ?, ?, ?, 0, ?)`)
    .run(candidateTaskId, runId, settings.marketplace, now, now, owned.length, owned.length, now);
  database.prepare(`INSERT INTO data_tasks (
    id, sync_run_id, name, source_id, task_type, target, source, marketplace,
    status, started_at, completed_at, total, success, failed, created_at
  ) VALUES (?, ?, 'Synthetic competitor coverage', 'source-sellersprite-mcp',
    'competitor_refresh', 'watched-competitors', 'SellerSprite MCP', ?, 'success',
    ?, ?, ?, ?, 0, ?)`)
    .run(competitorTaskId, runId, settings.marketplace, now, now,
      directCompetitors.length, directCompetitors.length, now);
  const marketMonths = [
    { month: '202608', date: '2026-08-31' },
    { month: '202609', date: '2026-09-30' },
  ];
  let marketSnapshotId = '';
  const insertMarketSnapshot = database.prepare(`INSERT INTO market_snapshots (
    id, market_node_id, date, product_count, source, source_type, collected_at,
    period, is_estimated, confidence, observation_date, dedup_key, sync_run_id
  ) VALUES (?, ?, ?, 10, 'SellerSprite MCP',
    'mcp', ?, '1M', 1, 0.8, ?, ?, ?)`);
  const insertMarketLink = database.prepare(`INSERT INTO mcp_sync_observation_links (
    sync_run_id, snapshot_kind, snapshot_id, entity_id, disposition
  ) VALUES (?, 'market', ?, ?, 'inserted')`);
  const insertMarketFact = database.prepare(`INSERT INTO metric_facts (
    id, entity_type, entity_id, marketplace, metric_name, numeric_value,
    source, source_id, source_type, is_estimated, confidence, observation_date,
    collected_at, dedup_key, sync_run_id
  ) VALUES (?, 'market', ?, ?, 'product_count', 10, 'SellerSprite MCP',
    'source-sellersprite-mcp', 'mcp', 1, 0.8, ?, ?, ?, ?)`);
  const insertFactLink = database.prepare(`INSERT INTO mcp_sync_observation_links (
    sync_run_id, snapshot_kind, snapshot_id, entity_id, disposition
  ) VALUES (?, 'fact', ?, ?, 'inserted')`);
  for (const marketNode of marketNodes) {
    for (const marketMonth of marketMonths) {
      const snapshotId = randomUUID();
      insertMarketSnapshot.run(snapshotId, marketNode.id, marketMonth.date, now, marketMonth.date,
        `verified-market-${marketNode.id}-${marketMonth.month}-${runId}`, runId);
      insertMarketLink.run(runId, snapshotId, marketNode.id);
      const factId = randomUUID();
      insertMarketFact.run(factId, marketNode.id, settings.marketplace, marketMonth.date, now,
        `verified-market-fact-${marketNode.id}-${marketMonth.month}-${runId}`, runId);
      insertFactLink.run(runId, factId, marketNode.id);
      if (marketNode.id === marketId && marketMonth.month === '202609') marketSnapshotId = snapshotId;
    }
  }
  addWorkflowEvidence(database, runId, settings.marketplace, 'market', marketId, marketSnapshotId, now);
  for (const product of owned) {
    const snapshotId = randomUUID();
    database.prepare(`INSERT INTO product_snapshots (
      id, product_id, date, estimated_sales, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key, sync_run_id
    ) VALUES (?, ?, '2026-09-30', 10, 'SellerSprite MCP',
      'mcp', ?, '1M', 1, 0.8, '2026-09-30', ?, ?)`)
      .run(snapshotId, product.id, productObservationCollectedAt,
        `verified-product-${product.id}-${runId}`, runId);
    database.prepare(`INSERT INTO mcp_sync_observation_links (
      sync_run_id, snapshot_kind, snapshot_id, entity_id, disposition
    ) VALUES (?, 'product', ?, ?, 'inserted')`).run(runId, snapshotId, product.id);
    const factId = randomUUID();
    database.prepare(`INSERT INTO metric_facts (
      id, entity_type, entity_id, marketplace, metric_name, numeric_value,
      source, source_id, source_type, is_estimated, confidence, observation_date,
      collected_at, dedup_key, sync_run_id
    ) VALUES (?, 'product', ?, ?, 'estimated_sales', 10, 'SellerSprite MCP',
      'source-sellersprite-mcp', 'mcp', 1, 0.8, '2026-09-30', ?, ?, ?)`)
      .run(factId, product.id, settings.marketplace, productObservationCollectedAt,
        `verified-product-fact-${product.id}-${runId}`, runId);
    database.prepare(`INSERT INTO mcp_sync_observation_links (
      sync_run_id, snapshot_kind, snapshot_id, entity_id, disposition
    ) VALUES (?, 'fact', ?, ?, 'inserted')`).run(runId, factId, product.id);
    addWorkflowEvidence(database, runId, settings.marketplace, 'owned_product', product.id, snapshotId, now);
  }
  database.prepare(`INSERT INTO provider_capability_snapshots (
    id, provider_id, capabilities_json, collected_at, sync_run_id
  ) VALUES (?, 'sellersprite', ?, ?, ?)`)
    .run(`verified-capabilities-${runId}`, JSON.stringify({ capabilities: {
      MARKET_RESEARCH: 'market_research',
      MARKET_STATISTICS: 'market_research_statistics',
      PRODUCT_CONCENTRATION: 'market_product_concentration',
      ASIN_SALES_TREND: 'asin_sales_trend',
      ASIN_COMPETITOR_DISCOVERY: 'asin_competitor',
    } }), now, runId);
  const addCall = database.prepare(`INSERT INTO mcp_call_logs (
    id, provider_id, capability, request_hash, status, entity_type,
    entity_id, result_count, started_at, sync_run_id, observation_month
  ) VALUES (?, 'sellersprite', ?, ?, 'success', ?, ?, 1, ?, ?, ?)`);
  addCall.run(randomUUID(), 'LIST_TOOLS', `list-tools-${runId}`,
    null, null, now, runId, null);
  for (const marketNode of marketNodes) {
    for (const marketMonth of marketMonths) {
      addCall.run(randomUUID(), 'MARKET_STATISTICS',
        `market-${marketNode.id}-${marketMonth.month}-${runId}`,
        'market', marketNode.nodeIdPath, now, runId, marketMonth.month);
      addCall.run(randomUUID(), 'PRODUCT_CONCENTRATION',
        `concentration-${marketNode.id}-${marketMonth.month}-${runId}`,
        'market', marketNode.nodeIdPath, now, runId, marketMonth.month);
    }
  }
  for (const product of owned) {
    addCall.run(randomUUID(), 'ASIN_SALES_TREND', `asin-${product.id}-${runId}`,
      'product', product.asin.toUpperCase(), now, runId, null);
    addCall.run(randomUUID(), 'ASIN_COMPETITOR_DISCOVERY', `candidates-${product.id}-${runId}`,
      'product', product.asin.toUpperCase(), now, runId, null);
  }
  database.prepare(`INSERT INTO data_coverage_runs (
    id, marketplace, run_type, coverage_json, is_complete, created_at
  ) VALUES (?, ?, 'critical_sync', ?, 1, ?)`).run(runId, settings.marketplace,
    JSON.stringify({ marketId, nodeIdPath: '1055398:1063252', month: '202609', baselineMonth: '202608',
      marketMonths: marketMonths.map(({ month }) => month),
      marketNodes,
      ownedProducts: owned.map(({ id, asin, marketNodeId }) => ({ id, asin, marketNodeId })),
      marketSnapshots: marketNodes.length * marketMonths.length,
      productSnapshots: owned.length, activeOwnedProducts: owned.length,
      candidateDiscovery: {
        taskId: candidateTaskId, status: 'success', total: owned.length,
        success: owned.length, failed: 0, candidates: 0,
        covered: owned.map(({ id, asin }) => ({ id, asin, candidates: 0 })), failures: [],
      },
      secondaryCompetitors: {
        taskId: competitorTaskId, status: 'success', total: directCompetitors.length,
        success: directCompetitors.length, failed: 0,
        roster: directCompetitors,
        covered: directCompetitors.map(({ id, asin }) => ({ id, asin, snapshots: 1 })),
        failures: [],
      },
    }), now);
  database.prepare(`UPDATE data_sources SET status = 'connected', last_sync_at = ?
    WHERE id = 'source-sellersprite-mcp'`).run(now);
}

function addWorkflowEvidence(
  database: AppDatabase, runId: string, marketplace: string,
  entityType: 'market' | 'owned_product', entityId: string,
  sourceRecordId: string, now: string,
): void {
  const jobType = entityType === 'market' ? 'existing_market' : 'owned_product';
  const jobEntityType = entityType === 'market' ? 'market_node' : entityType;
  const insightType = entityType === 'market' ? 'market_diagnosis' : 'owned_product_diagnosis';
  const profile = database.prepare(`SELECT id, version FROM rule_profiles
    WHERE EXISTS (SELECT 1 FROM json_each(rule_profiles.job_types_json) WHERE value = ?)
    LIMIT 1`).get(jobType) as { id: string; version: number };
  const jobId = randomUUID();
  const dataVersion = `test-critical-${runId}`;
  database.prepare(`INSERT INTO research_jobs (
    id, name, job_type, marketplace, status, entity_type, entity_id,
    rule_profile_id, rule_profile_version, rule_profile_snapshot_json,
    is_demo, created_by, data_version, prompt_version, created_at, updated_at
  ) VALUES (?, 'Synthetic workflow evidence', ?, ?, 'monitoring', ?, ?,
    ?, ?, '{}', 0, 'test', ?, 'test-prompt-v1', ?, ?)`)
    .run(jobId, jobType, marketplace, jobEntityType, entityId,
      profile.id, profile.version, dataVersion, now, now);
  database.prepare(`INSERT INTO data_tasks (
    id, sync_run_id, name, source_id, task_type, target, source, marketplace,
    status, started_at, completed_at, total, success, failed, created_at,
    research_job_id
  ) VALUES (?, ?, 'Synthetic workflow collection', 'source-sellersprite-mcp',
    'workflow_collection', ?, 'Persisted SellerSprite Snapshot', ?, 'success',
    ?, ?, 1, 1, 0, ?, ?)`)
    .run(randomUUID(), runId, entityId, marketplace, now, now, now, jobId);
  const evidenceId = randomUUID();
  database.prepare(`INSERT INTO evidence_records (
    id, research_job_id, claim, metric_name, metric_value_json, source,
    source_type, source_record_id, collected_at, period, is_estimated,
    calculation, confidence, data_version, created_at, sync_run_id
  ) VALUES (?, ?, 'Synthetic measured observation', ?, '10', 'SellerSprite MCP',
    'mcp', ?, ?, '1M', 1, 'provider observation', 0.8, ?, ?, ?)`)
    .run(evidenceId, jobId, entityType === 'market' ? 'product_count' : 'estimated_sales',
      sourceRecordId, now, dataVersion, now, runId);
  const insightId = randomUUID();
  database.prepare(`INSERT INTO ai_insights (
    id, entity_type, entity_id, insight_type, status, title, summary,
    evidence_json, confidence, model, data_version, input_hash, generated_at,
    research_job_id, prompt_version, evidence_ids_json
  ) VALUES (?, 'research_job', ?, ?, 'stable', 'Synthetic completed insight',
    'Synthetic completed workflow proof', '[]', 0.8, 'rule-engine-v1', ?, ?, ?,
    ?, 'test-prompt-v1', ?)`)
    .run(insightId, jobId, insightType, dataVersion, `test-insight-${jobId}`, now,
      jobId, JSON.stringify([evidenceId]));
  database.prepare(`UPDATE evidence_records SET insight_id = ? WHERE id = ?`)
    .run(insightId, evidenceId);
  database.prepare(`INSERT INTO research_steps (
    id, research_job_id, step_type, status, input_json, output_json,
    started_at, completed_at, created_at
  ) VALUES (?, ?, 'report', 'completed', '{}', '{}', ?, ?, ?)`)
    .run(randomUUID(), jobId, now, now, now);
  database.prepare(`INSERT INTO research_steps (
    id, research_job_id, step_type, status, input_json, output_json,
    started_at, completed_at, created_at
  ) VALUES (?, ?, 'ai_analysis', 'completed', '{}', '{}', ?, ?, ?)`)
    .run(randomUUID(), jobId, now, now, now);
}
