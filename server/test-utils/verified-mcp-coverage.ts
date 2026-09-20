import type { AppDatabase } from '../database/database.js';

// Synthetic records for exercising the Go Live gate in isolated test databases only.
export function addVerifiedMcpCoverage(
  database: AppDatabase,
  marketId = 'mkt-memory-foam',
  ownedProductId = 'verified-owned',
): void {
  const now = new Date().toISOString();
  const settings = database.prepare('SELECT marketplace FROM app_settings WHERE id = 1')
    .get() as { marketplace: string };
  const existingProduct = database.prepare('SELECT asin FROM products WHERE id = ?')
    .get(ownedProductId) as { asin: string } | undefined;
  database.prepare('UPDATE app_settings SET default_market_id = ? WHERE id = 1').run(marketId);
  database.prepare('UPDATE market_nodes SET category_id = ? WHERE id = ? AND marketplace = ?')
    .run('1055398:1063252', marketId, settings.marketplace);
  if (!existingProduct) {
    database.prepare(`INSERT INTO products (
      id, asin, sku, brand, title, image_url, marketplace, product_type, is_owned,
      market_node_id, source_type, created_at
    ) VALUES (?, 'B0TEST0001', 'TEST-1', 'Test', 'Synthetic owned test product', '', ?,
      'pillow', 1, ?, 'import', ?)`)
      .run(ownedProductId, settings.marketplace, marketId, now);
  }
  const asin = existingProduct?.asin ?? 'B0TEST0001';
  database.prepare(`INSERT INTO market_snapshots (
    id, market_node_id, date, product_count, source, source_type, collected_at,
    period, is_estimated, confidence, observation_date, dedup_key
  ) VALUES ('verified-market-test', ?, '2026-09-19', 10, 'Synthetic MCP test',
    'mcp', ?, '30D', 1, 0.8, '2026-09-19', 'verified-market-test')`)
    .run(marketId, now);
  database.prepare(`INSERT INTO product_snapshots (
    id, product_id, date, estimated_sales, source, source_type, collected_at,
    period, is_estimated, confidence, observation_date, dedup_key
  ) VALUES ('verified-product-test', ?, '2026-09-19', 10, 'Synthetic MCP test',
    'mcp', ?, '30D', 1, 0.8, '2026-09-19', 'verified-product-test')`)
    .run(ownedProductId, now);
  database.prepare(`INSERT INTO provider_capability_snapshots (
    id, provider_id, capabilities_json, collected_at
  ) VALUES ('verified-capabilities-test', 'sellersprite', ?, ?)`)
    .run(JSON.stringify({ capabilities: {
      MARKET_RESEARCH: 'market_research',
      MARKET_STATISTICS: 'market_research_statistics',
      PRODUCT_CONCENTRATION: 'market_product_concentration',
      ASIN_SALES_TREND: 'asin_sales_trend',
      ASIN_COMPETITOR_DISCOVERY: 'asin_competitor',
    } }), now);
  const addCall = database.prepare(`INSERT INTO mcp_call_logs (
    id, provider_id, capability, request_hash, status, entity_type,
    entity_id, result_count, started_at
  ) VALUES (?, 'sellersprite', ?, ?, 'success', ?, ?, 1, ?)`);
  addCall.run('verified-market-call-test', 'MARKET_STATISTICS', 'market-test',
    'market', '1055398:1063252', now);
  addCall.run('verified-asin-call-test', 'ASIN_SALES_TREND', 'asin-test',
    'product', asin, now);
  database.prepare(`UPDATE data_sources SET status = 'connected', last_sync_at = ?
    WHERE id = 'source-sellersprite-mcp'`).run(now);
}
