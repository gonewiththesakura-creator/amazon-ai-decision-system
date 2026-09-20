import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { IntelligenceRepository } from '../repository/intelligence-repository.js';
import { proveDashboardRunReadPath } from './dashboard-run-read-proof.js';

const MARKET_ID = 'market-real';
const RUN_ID = 'critical-current';
const OWNED_IDS = ['owned-one', 'owned-two'];
const OBSERVATION_DATE = '2026-09-30';
const COLLECTED_AT = '2026-09-30T12:00:00Z';
const NODE_ID_PATH = '1055398:1063252';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function addRun(db: AppDatabase, runId: string, status = 'success'): void {
  db.prepare(`INSERT INTO data_tasks (
    id, sync_run_id, name, source_id, task_type, target, source, marketplace,
    status, total, success, failed, created_at
  ) VALUES (?, ?, 'Critical proof test', 'source-sellersprite-mcp', 'critical_sync',
    ?, 'SellerSprite MCP', 'US', ?, 3, ?, ?, ?)`)
    .run(runId, runId, MARKET_ID, status, status === 'success' ? 3 : 0,
      status === 'success' ? 0 : 1, COLLECTED_AT);
  db.prepare(`INSERT INTO data_coverage_runs (
    id, marketplace, run_type, coverage_json, is_complete, created_at
  ) VALUES (?, 'US', 'critical_sync', ?, ?, ?)`)
    .run(runId, JSON.stringify({
      marketId: MARKET_ID,
      nodeIdPath: NODE_ID_PATH,
      marketNodes: [{ id: MARKET_ID, nodeIdPath: NODE_ID_PATH }],
      ownedProducts: [...OWNED_IDS].sort().map((id) => ({
        id, asin: `B0${id.toUpperCase()}`, marketNodeId: MARKET_ID,
      })),
    }), status === 'success' ? 1 : 0, COLLECTED_AT);
}

function addLink(
  db: AppDatabase, runId: string, kind: 'market' | 'product' | 'fact',
  recordId: string, entityId: string, disposition: 'inserted' | 'reused' = 'inserted',
): void {
  db.prepare(`INSERT INTO mcp_sync_observation_links (
    sync_run_id, snapshot_kind, snapshot_id, entity_id, disposition
  ) VALUES (?, ?, ?, ?, ?)`)
    .run(runId, kind, recordId, entityId, disposition);
}

function addMarketObservation(db: AppDatabase, sourceRun = RUN_ID, sales: number | null = 20): void {
  db.prepare(`INSERT INTO market_snapshots (
    id, market_node_id, date, monthly_sales, product_count, source, source_type, collected_at,
    period, is_estimated, confidence, observation_date, dedup_key, sync_run_id
  ) VALUES ('market-observation', ?, ?, ?, 18, 'SellerSprite MCP', 'mcp', ?,
    '1M', 1, 0.8, ?, 'market-observation', ?)`)
    .run(MARKET_ID, OBSERVATION_DATE, sales, COLLECTED_AT, OBSERVATION_DATE, sourceRun);
  db.prepare(`INSERT INTO metric_facts (
    id, entity_type, entity_id, marketplace, metric_name, numeric_value,
    source, source_id, source_type, is_estimated, confidence, observation_date,
    collected_at, dedup_key, sync_run_id
  ) VALUES ('market-fact', 'market', ?, 'US', 'product_count', 18,
    'SellerSprite MCP', 'source-sellersprite-mcp', 'mcp', 1, 0.8, ?,
    ?, 'market-fact', ?)`)
    .run(MARKET_ID, OBSERVATION_DATE, COLLECTED_AT, sourceRun);
}

function addOwnedObservation(db: AppDatabase, productId: string, sales: number, sourceRun = RUN_ID): void {
  const snapshotId = `snapshot-${productId}`;
  const factId = `fact-${productId}`;
  db.prepare(`INSERT INTO product_snapshots (
    id, product_id, date, estimated_sales, source, source_type, collected_at,
    period, is_estimated, confidence, observation_date, dedup_key, sync_run_id
  ) VALUES (?, ?, ?, ?, 'SellerSprite MCP', 'mcp', ?,
    '1M', 1, 0.8, ?, ?, ?)`)
    .run(snapshotId, productId, OBSERVATION_DATE, sales, COLLECTED_AT,
      OBSERVATION_DATE, snapshotId, sourceRun);
  db.prepare(`INSERT INTO metric_facts (
    id, entity_type, entity_id, marketplace, metric_name, numeric_value,
    source, source_id, source_type, is_estimated, confidence, observation_date,
    collected_at, dedup_key, sync_run_id
  ) VALUES (?, 'product', ?, 'US', 'estimated_sales', ?,
    'SellerSprite MCP', 'source-sellersprite-mcp', 'mcp', 1, 0.8, ?,
    ?, ?, ?)`)
    .run(factId, productId, sales, OBSERVATION_DATE, COLLECTED_AT, factId, sourceRun);
}

function openFixture(options: {
  sourceRun?: string; linkRun?: string; retainedDemo?: boolean; marketSales?: number | null;
} = {}): AppDatabase {
  const db = openDatabase(':memory:');
  database = db;
  db.prepare(`INSERT INTO market_nodes (
    id, name, level, marketplace, category_id, status, source_type, created_at
  ) VALUES (?, 'Real market', 1, 'US', ?, 'active', 'import', ?)`)
    .run(MARKET_ID, NODE_ID_PATH, COLLECTED_AT);
  db.prepare(`UPDATE app_settings SET mode = 'demo', default_market_id = ? WHERE id = 1`)
    .run(MARKET_ID);
  for (const productId of OWNED_IDS) {
    db.prepare(`INSERT INTO products (
      id, asin, brand, title, image_url, marketplace, product_type, is_owned,
      is_parent, market_node_id, source_type, created_at
    ) VALUES (?, ?, 'Brand', 'Owned pillow', '', 'US', 'pillow', 1,
      0, ?, 'import', ?)`)
      .run(productId, `B0${productId.toUpperCase()}`, MARKET_ID, COLLECTED_AT);
  }
  if (options.retainedDemo) {
    db.prepare(`INSERT INTO market_nodes (
      id, name, level, marketplace, status, source_type, created_at
    ) VALUES ('demo-market', 'Demo market', 1, 'US', 'active', 'mock', ?)`)
      .run(COLLECTED_AT);
    db.prepare(`INSERT INTO products (
      id, asin, brand, title, image_url, marketplace, product_type, is_owned,
      is_parent, market_node_id, source_type, created_at
    ) VALUES ('demo-owned', 'B0DEMO0001', 'Demo', 'Demo pillow', '', 'US',
      'pillow', 1, 0, 'demo-market', 'mock', ?)`)
      .run(COLLECTED_AT);
    db.prepare(`INSERT INTO product_snapshots (
      id, product_id, date, estimated_sales, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES ('demo-snapshot', 'demo-owned', ?, 99, 'Demo', 'mock', ?,
      '1M', 1, 0.9, ?, 'demo-snapshot')`)
      .run(OBSERVATION_DATE, COLLECTED_AT, OBSERVATION_DATE);
  }
  const sourceRun = options.sourceRun ?? RUN_ID;
  const linkRun = options.linkRun ?? RUN_ID;
  addRun(db, sourceRun);
  if (linkRun !== sourceRun) addRun(db, linkRun);
  addMarketObservation(db, sourceRun, options.marketSales === undefined ? 20 : options.marketSales);
  addOwnedObservation(db, OWNED_IDS[0], 11, sourceRun);
  addOwnedObservation(db, OWNED_IDS[1], 12, sourceRun);
  const disposition = linkRun === sourceRun ? 'inserted' : 'reused';
  addLink(db, linkRun, 'market', 'market-observation', MARKET_ID, disposition);
  addLink(db, linkRun, 'fact', 'market-fact', MARKET_ID, disposition);
  for (const productId of OWNED_IDS) {
    addLink(db, linkRun, 'product', `snapshot-${productId}`, productId, disposition);
    addLink(db, linkRun, 'fact', `fact-${productId}`, productId, disposition);
  }
  return db;
}

describe('dashboard run read-path proof', () => {
  it('proves the selected market and exact owned children while retaining unrelated Demo rows', () => {
    const db = openFixture({ retainedDemo: true });
    expect(new IntelligenceRepository(db).getOwnedProducts().map((product) => product.id))
      .toContain('demo-owned');

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: true, marketVerified: true,
      verifiedOwnedProducts: 2, requiredOwnedProducts: 2,
    });
  });

  it('rejects an unlinked representative market snapshot even when selected numeric facts are run-linked', () => {
    const db = openFixture({ marketSales: null });
    db.prepare(`INSERT INTO market_snapshots (
      id, market_node_id, date, product_count, price_bands_json, concentration_json,
      source, source_type, collected_at, period, is_estimated, confidence,
      observation_date, dedup_key
    ) VALUES ('unlinked-market-distribution', ?, ?, 18, ?, ?,
      'Legacy import', 'import', '2026-09-30T13:00:00Z', '1M', 1, 0.8,
      ?, 'unlinked-market-distribution')`)
      .run(MARKET_ID, OBSERVATION_DATE,
        JSON.stringify([{ label: '$20-30', monthlySales: 100 }]),
        JSON.stringify([{ tier: 'TOP10', share: 75 }]), OBSERVATION_DATE);
    const market = new IntelligenceRepository(db).getMarket(MARKET_ID);
    expect(market?.kpis.productCount).toBe(18);
    expect(market?.metricProvenance?.product_count?.sourceRecordId).toBe('market-fact');
    expect(market?.priceBands).toEqual([{ label: '$20-30', monthlySales: 100 }]);
    expect(market?.concentration).toEqual([{ tier: 'TOP10', share: 75 }]);

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: false,
      verifiedOwnedProducts: 2, requiredOwnedProducts: 2,
    });
  });

  it('rejects unlinked child-market growth shown for a real owned SKU', () => {
    const db = openFixture();
    db.prepare(`INSERT INTO market_nodes (
      id, name, parent_id, level, marketplace, category_id, status, source_type, created_at
    ) VALUES ('child-market', 'Real child market', ?, 2, 'US', '1055398:1063252:999',
      'active', 'import', ?)`)
      .run(MARKET_ID, COLLECTED_AT);
    db.prepare(`UPDATE products SET market_node_id = 'child-market' WHERE id = ?`)
      .run(OWNED_IDS[0]);
    const coverage = JSON.parse((db.prepare(`
      SELECT coverage_json AS coverageJson FROM data_coverage_runs WHERE id = ?
    `).get(RUN_ID) as { coverageJson: string }).coverageJson) as {
      ownedProducts: Array<{ id: string; marketNodeId: string }>;
      marketNodes: Array<{ id: string; nodeIdPath: string }>;
    };
    coverage.ownedProducts.find((item) => item.id === OWNED_IDS[0])!.marketNodeId = 'child-market';
    coverage.marketNodes.push({ id: 'child-market', nodeIdPath: `${NODE_ID_PATH}:999` });
    db.prepare(`UPDATE data_coverage_runs SET coverage_json = ? WHERE id = ?`)
      .run(JSON.stringify(coverage), RUN_ID);
    const insertChildMarket = db.prepare(`INSERT INTO market_snapshots (
      id, market_node_id, date, monthly_sales, source, source_type,
      collected_at, period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES (?, 'child-market', ?, ?, 'Demo', 'mock', ?, '1M', 1, 0.9, ?, ?)`);
    insertChildMarket.run('child-mock-prior', '2026-08-31', 10,
      '2026-08-31T12:00:00Z', '2026-08-31', 'child-mock-prior');
    insertChildMarket.run('child-mock-latest', OBSERVATION_DATE, 20,
      COLLECTED_AT, OBSERVATION_DATE, 'child-mock-latest');
    const owned = new IntelligenceRepository(db).getOwnedProducts()
      .find((item) => item.id === OWNED_IDS[0]);
    expect(owned).toMatchObject({ marketNodeId: 'child-market', marketGrowth30d: 100 });

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: true,
      verifiedOwnedProducts: 1, requiredOwnedProducts: 2,
    });
  });

  it('does not credit an MCP observation linked only to a different run', () => {
    const db = openFixture();
    addRun(db, 'critical-other');

    expect(proveDashboardRunReadPath(db, {
      runId: 'critical-other', marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: false,
      verifiedOwnedProducts: 0, requiredOwnedProducts: 2,
    });
  });

  it('does not credit an unlinked selected SKU even when its MCP metric exists', () => {
    const db = openFixture();
    db.prepare(`DELETE FROM mcp_sync_observation_links
      WHERE sync_run_id = ? AND entity_id = ?`).run(RUN_ID, OWNED_IDS[1]);

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: true,
      verifiedOwnedProducts: 1, requiredOwnedProducts: 2,
    });
  });

  it('accepts immutable observations correctly reused and linked by this run', () => {
    const db = openFixture({ sourceRun: 'critical-original', linkRun: RUN_ID });

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: true, marketVerified: true,
      verifiedOwnedProducts: 2, requiredOwnedProducts: 2,
    });
  });

  it('rejects a newer selected Mock observation even if this run linked the prior MCP data', () => {
    const db = openFixture();
    db.prepare(`INSERT INTO product_snapshots (
      id, product_id, date, estimated_sales, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES ('newer-demo', ?, '2026-10-31', 999, 'Demo', 'mock',
      '2026-10-31T12:00:00Z', '1M', 1, 0.9, '2026-10-31', 'newer-demo')`)
      .run(OWNED_IDS[0]);

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: true,
      verifiedOwnedProducts: 1, requiredOwnedProducts: 2,
    });
  });

  it('does not certify selected products whose master records remain Demo', () => {
    const db = openFixture();
    db.prepare(`UPDATE products SET source_type = 'mock' WHERE id = ?`).run(OWNED_IDS[0]);

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: false,
      verifiedOwnedProducts: 0, requiredOwnedProducts: 2,
    });
  });

  it('does not certify a selected market whose master record remains Demo', () => {
    const db = openFixture();
    db.prepare(`UPDATE market_nodes SET source_type = 'mock' WHERE id = ?`).run(MARKET_ID);

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: false,
      verifiedOwnedProducts: 0, requiredOwnedProducts: 2,
    });
  });

  it('accepts selected MCP snapshot metrics when no separate metric facts exist', () => {
    const db = openFixture();
    db.prepare(`DELETE FROM mcp_sync_observation_links WHERE snapshot_kind = 'fact'`).run();
    db.prepare(`DELETE FROM metric_facts`).run();
    const selected = new IntelligenceRepository(db).getOwnedProducts().find(
      (product) => product.id === OWNED_IDS[0],
    );
    expect(selected?.latest.metricProvenance?.estimated_sales.sourceRecordType).toBe('snapshot');

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: true, marketVerified: true,
      verifiedOwnedProducts: 2, requiredOwnedProducts: 2,
    });
  });

  it('does not substitute a linked snapshot when the selected metric comes from an unlinked fact', () => {
    const db = openFixture();
    db.prepare(`DELETE FROM mcp_sync_observation_links
      WHERE snapshot_kind = 'fact' AND snapshot_id = ?`).run(`fact-${OWNED_IDS[0]}`);
    const selected = new IntelligenceRepository(db).getOwnedProducts().find(
      (product) => product.id === OWNED_IDS[0],
    );
    expect(selected?.latest.metricProvenance?.estimated_sales.sourceRecordId).toBe(`fact-${OWNED_IDS[0]}`);

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: true,
      verifiedOwnedProducts: 1, requiredOwnedProducts: 2,
    });
  });

  it('rejects an inserted link to an observation actually owned by an older run', () => {
    const db = openFixture({ sourceRun: 'critical-original', linkRun: RUN_ID });
    db.prepare(`UPDATE mcp_sync_observation_links SET disposition = 'inserted'
      WHERE sync_run_id = ? AND entity_id = ?`).run(RUN_ID, OWNED_IDS[0]);

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: true,
      verifiedOwnedProducts: 1, requiredOwnedProducts: 2,
    });
  });

  it('does not treat a requested child with missing observations as covered', () => {
    const db = openFixture();
    db.prepare(`DELETE FROM mcp_sync_observation_links WHERE entity_id = ?`).run(OWNED_IDS[1]);
    db.prepare(`DELETE FROM metric_facts WHERE entity_id = ?`).run(OWNED_IDS[1]);
    db.prepare(`DELETE FROM product_snapshots WHERE product_id = ?`).run(OWNED_IDS[1]);

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: true,
      verifiedOwnedProducts: 1, requiredOwnedProducts: 2,
    });
  });

  it('rejects a failed critical run even if its selected records and links remain', () => {
    const db = openFixture();
    db.prepare(`UPDATE data_tasks SET status = 'failed', success = 0, failed = 1
      WHERE id = ?`).run(RUN_ID);

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: false,
      verifiedOwnedProducts: 0, requiredOwnedProducts: 2,
    });
  });

  it('rejects a market whose same-date projection mixes a linked MCP metric with Mock sales', () => {
    const db = openFixture({ marketSales: null });
    db.prepare(`INSERT INTO market_snapshots (
      id, market_node_id, date, monthly_sales, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES ('market-mixed-mock', ?, ?, 999, 'Demo', 'mock', ?,
      '1M', 1, 0.99, ?, 'market-mixed-mock')`)
      .run(MARKET_ID, OBSERVATION_DATE, COLLECTED_AT, OBSERVATION_DATE);
    const selected = new IntelligenceRepository(db).getMarket(MARKET_ID);
    expect(selected?.kpis).toMatchObject({ monthlySales: 999, productCount: 18 });
    expect(selected?.metricProvenance).toMatchObject({
      monthly_sales: { sourceType: 'mock' },
      product_count: { sourceType: 'mcp' },
    });

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: false,
      verifiedOwnedProducts: 2, requiredOwnedProducts: 2,
    });
  });

  it('rejects a SKU whose same-date projection mixes a linked MCP metric with a Mock price', () => {
    const db = openFixture();
    db.prepare(`INSERT INTO product_snapshots (
      id, product_id, date, price, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES ('product-mixed-mock', ?, ?, 99, 'Demo', 'mock', ?,
      '1M', 1, 0.99, ?, 'product-mixed-mock')`)
      .run(OWNED_IDS[0], OBSERVATION_DATE, COLLECTED_AT, OBSERVATION_DATE);
    const selected = new IntelligenceRepository(db).getOwnedProducts()
      .find((product) => product.id === OWNED_IDS[0]);
    expect(selected?.latest).toMatchObject({ estimatedSales: 11, price: 99 });
    expect(selected?.latest.metricProvenance).toMatchObject({
      estimated_sales: { sourceType: 'mcp' },
      price: { sourceType: 'mock' },
    });

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: true,
      verifiedOwnedProducts: 1, requiredOwnedProducts: 2,
    });
  });

  it('permits selected non-estimated Amazon sales while requiring another exact-run MCP metric', () => {
    const db = openFixture();
    db.prepare(`INSERT INTO metric_facts (
      id, entity_type, entity_id, marketplace, metric_name, numeric_value,
      source, source_id, source_type, is_estimated, confidence, observation_date,
      collected_at, dedup_key, sync_run_id
    ) VALUES ('mcp-linked-rating', 'product', ?, 'US', 'rating', 4.6,
      'SellerSprite MCP', 'source-sellersprite-mcp', 'mcp', 1, 0.8, ?,
      ?, 'mcp-linked-rating', ?)`)
      .run(OWNED_IDS[0], OBSERVATION_DATE, COLLECTED_AT, RUN_ID);
    addLink(db, RUN_ID, 'fact', 'mcp-linked-rating', OWNED_IDS[0]);
    db.prepare(`INSERT INTO metric_facts (
      id, entity_type, entity_id, marketplace, metric_name, numeric_value,
      source, source_id, source_type, is_estimated, confidence, observation_date,
      collected_at, dedup_key
    ) VALUES ('amazon-actual-sales', 'product', ?, 'US', 'estimated_sales', 15,
      'Amazon SP-API', 'amazon_api', 'amazon', 0, 1, ?, ?, 'amazon-actual-sales')`)
      .run(OWNED_IDS[0], OBSERVATION_DATE, COLLECTED_AT);
    const selected = new IntelligenceRepository(db).getOwnedProducts()
      .find((product) => product.id === OWNED_IDS[0]);
    expect(selected?.latest).toMatchObject({ estimatedSales: 15, rating: 4.6 });
    expect(selected?.latest.metricProvenance).toMatchObject({
      estimated_sales: { sourceRecordId: 'amazon-actual-sales', sourceType: 'amazon', isEstimated: false },
      rating: { sourceRecordId: 'mcp-linked-rating', sourceType: 'mcp' },
    });

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: true, marketVerified: true,
      verifiedOwnedProducts: 2, requiredOwnedProducts: 2,
    });
  });

  it('rejects a run after a new active real owned child is added', () => {
    const db = openFixture();
    db.prepare(`INSERT INTO products (
      id, asin, brand, title, image_url, marketplace, product_type, is_owned,
      is_parent, market_node_id, source_type, created_at
    ) VALUES ('owned-added', 'B0OWNEDADDED', 'Brand', 'Added pillow', '', 'US',
      'pillow', 1, 0, ?, 'import', ?)`)
      .run(MARKET_ID, COLLECTED_AT);

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: false,
      verifiedOwnedProducts: 0, requiredOwnedProducts: 2,
    });
  });

  it('rejects a run after an owned child ASIN changes', () => {
    const db = openFixture();
    db.prepare(`UPDATE products SET asin = 'B0IDENTITYDRIFT' WHERE id = ?`).run(OWNED_IDS[0]);

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: false,
      verifiedOwnedProducts: 0, requiredOwnedProducts: 2,
    });
  });

  it('rejects a run after an owned child moves to another node in the market tree', () => {
    const db = openFixture();
    db.prepare(`INSERT INTO market_nodes (
      id, name, parent_id, level, marketplace, category_id, status, source_type, created_at
    ) VALUES ('market-child', 'Real child market', ?, 2, 'US', '1055398:1063252:999',
      'active', 'import', ?)`)
      .run(MARKET_ID, COLLECTED_AT);
    db.prepare(`UPDATE products SET market_node_id = 'market-child' WHERE id = ?`).run(OWNED_IDS[0]);

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: false,
      verifiedOwnedProducts: 0, requiredOwnedProducts: 2,
    });
  });

  it('rejects a run after the selected market category path changes', () => {
    const db = openFixture();
    db.prepare(`UPDATE market_nodes SET category_id = '1055398:9999999' WHERE id = ?`)
      .run(MARKET_ID);

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: false,
      verifiedOwnedProducts: 0, requiredOwnedProducts: 2,
    });
  });

  it('rejects a Mock prior market-sales point retained in the selected dashboard trend', () => {
    const db = openFixture();
    db.prepare(`INSERT INTO market_snapshots (
      id, market_node_id, date, monthly_sales, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES ('market-prior-mock', ?, '2026-08-31', 9, 'Demo', 'mock',
      '2026-08-31T12:00:00Z', '1M', 1, 0.9, '2026-08-31', 'market-prior-mock')`)
      .run(MARKET_ID);
    expect(new IntelligenceRepository(db).getMarketSnapshots(MARKET_ID)).toEqual([
      expect.objectContaining({ date: '2026-08-31', sales: 9 }),
      expect.objectContaining({ date: OBSERVATION_DATE, sales: 20 }),
    ]);

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: false,
      verifiedOwnedProducts: 0, requiredOwnedProducts: 2,
    });
  });

  it('rejects a prior product-sales point linked only to an older run that drives 30-day growth', () => {
    const db = openFixture();
    const priorRun = 'critical-prior';
    addRun(db, priorRun);
    db.prepare(`INSERT INTO product_snapshots (
      id, product_id, date, estimated_sales, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key, sync_run_id
    ) VALUES ('product-prior-other-run', ?, '2026-08-31', 10, 'SellerSprite MCP', 'mcp',
      '2026-08-31T12:00:00Z', '1M', 1, 0.8, '2026-08-31',
      'product-prior-other-run', ?)`)
      .run(OWNED_IDS[0], priorRun);
    addLink(db, priorRun, 'product', 'product-prior-other-run', OWNED_IDS[0]);
    const snapshots = new IntelligenceRepository(db).getProductSnapshots(OWNED_IDS[0]);
    expect(snapshots).toEqual([
      expect.objectContaining({
        id: 'product-prior-other-run', estimatedSales: 10,
        metricProvenance: { estimated_sales: expect.objectContaining({ sourceType: 'mcp' }) },
      }),
      expect.objectContaining({ date: OBSERVATION_DATE, estimatedSales: 11, growth30d: 10 }),
    ]);

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: true,
      verifiedOwnedProducts: 1, requiredOwnedProducts: 2,
    });
  });

  it('ignores stale imported sales history outside both the 30-day chart and growth pair', () => {
    const db = openFixture();
    db.prepare(`INSERT INTO market_snapshots (
      id, market_node_id, date, monthly_sales, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES ('market-stale-import', ?, '2025-01-31', 7, 'Legacy import', 'import',
      '2025-01-31T12:00:00Z', '1M', 1, 0.8, '2025-01-31', 'market-stale-import')`)
      .run(MARKET_ID);
    db.prepare(`INSERT INTO product_snapshots (
      id, product_id, date, estimated_sales, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES ('product-stale-import', ?, '2025-01-31', 5, 'Legacy import', 'import',
      '2025-01-31T12:00:00Z', '1M', 1, 0.8, '2025-01-31', 'product-stale-import')`)
      .run(OWNED_IDS[0]);

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: true, marketVerified: true,
      verifiedOwnedProducts: 2, requiredOwnedProducts: 2,
    });
  });

  it('rejects an Amazon-labeled actual snapshot from an unknown provider', () => {
    const db = openFixture();
    db.prepare(`INSERT INTO product_snapshots (
      id, product_id, date, estimated_sales, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES ('unknown-amazon-sales', ?, ?, 17, 'Amazon-looking source', 'amazon', ?,
      '1M', 0, 1, ?, 'unknown-amazon-sales')`)
      .run(OWNED_IDS[0], OBSERVATION_DATE, COLLECTED_AT, OBSERVATION_DATE);
    db.prepare(`INSERT INTO metric_facts (
      id, entity_type, entity_id, marketplace, metric_name, numeric_value,
      source, source_id, source_type, is_estimated, confidence, observation_date,
      collected_at, dedup_key, sync_run_id
    ) VALUES ('mcp-linked-price', 'product', ?, 'US', 'price', 39,
      'SellerSprite MCP', 'source-sellersprite-mcp', 'mcp', 1, 0.8, ?,
      ?, 'mcp-linked-price', ?)`)
      .run(OWNED_IDS[0], OBSERVATION_DATE, COLLECTED_AT, RUN_ID);
    addLink(db, RUN_ID, 'fact', 'mcp-linked-price', OWNED_IDS[0]);
    const selected = new IntelligenceRepository(db).getOwnedProducts()
      .find((product) => product.id === OWNED_IDS[0]);
    expect(selected?.latest.metricProvenance).toMatchObject({
      estimated_sales: { sourceRecordId: 'unknown-amazon-sales' },
      price: { sourceRecordId: 'mcp-linked-price' },
    });

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: true,
      verifiedOwnedProducts: 1, requiredOwnedProducts: 2,
    });
  });

  it('rejects Amazon-only latest product metrics without a selected exact-run MCP metric', () => {
    const db = openFixture();
    db.prepare(`DELETE FROM mcp_sync_observation_links
      WHERE snapshot_id IN (?, ?)`).run(`fact-${OWNED_IDS[0]}`, `snapshot-${OWNED_IDS[0]}`);
    db.prepare(`DELETE FROM metric_facts WHERE id = ?`).run(`fact-${OWNED_IDS[0]}`);
    db.prepare(`DELETE FROM product_snapshots WHERE id = ?`).run(`snapshot-${OWNED_IDS[0]}`);
    db.prepare(`INSERT INTO metric_facts (
      id, entity_type, entity_id, marketplace, metric_name, numeric_value,
      source, source_id, source_type, is_estimated, confidence, observation_date,
      collected_at, dedup_key
    ) VALUES ('amazon-only-sales', 'product', ?, 'US', 'estimated_sales', 15,
      'Amazon SP-API', 'amazon_api', 'amazon', 0, 1, ?, ?, 'amazon-only-sales')`)
      .run(OWNED_IDS[0], OBSERVATION_DATE, COLLECTED_AT);
    db.prepare(`INSERT INTO product_snapshots (
      id, product_id, date, estimated_sales, source, source_type, collected_at,
      period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES ('amazon-only-snapshot', ?, ?, 15, 'Amazon SP-API', 'amazon', ?,
      '1M', 0, 1, ?, 'amazon-only-snapshot')`)
      .run(OWNED_IDS[0], OBSERVATION_DATE, COLLECTED_AT, OBSERVATION_DATE);

    expect(proveDashboardRunReadPath(db, {
      runId: RUN_ID, marketId: MARKET_ID, ownedProductIds: OWNED_IDS,
    })).toEqual({
      passed: false, marketVerified: true,
      verifiedOwnedProducts: 1, requiredOwnedProducts: 2,
    });
  });
});
