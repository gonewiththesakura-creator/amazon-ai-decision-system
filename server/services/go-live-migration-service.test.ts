import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { GoLiveMigrationService } from './go-live-migration-service.js';
import { seedDemoData } from '../database/demo-seed.js';
import { IntelligenceService } from './intelligence-service.js';
import { IntelligenceRepository } from '../repository/intelligence-repository.js';

let database: AppDatabase | undefined;
let temporaryDirectory: string | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

function insertObservationFixture(
  database: AppDatabase,
  marketSourceType: 'mock' | 'mcp' | 'amazon',
  productSourceType = marketSourceType,
  empty = false,
): void {
  const now = '2026-09-19T00:00:00.000Z';
  database.prepare(`
    INSERT INTO market_nodes (id, name, level, marketplace, status, source_type, created_at)
    VALUES ('market-us', 'US market', 1, 'US', 'active', ?, ?)
  `).run(marketSourceType, now);
  database.prepare(`
    INSERT INTO products (
      id, asin, sku, brand, title, image_url, marketplace, product_type, is_owned,
      market_node_id, source_type, created_at
    ) VALUES ('owned-product', 'B0LIVE0001', 'LIVE-1', 'Brand', 'Title', '', 'US', 'pillow',
      1, 'market-us', ?, ?)
  `).run(productSourceType, now);
  database.prepare(`
    INSERT INTO market_snapshots (
      id, market_node_id, date, product_count, seller_count, brand_count, monthly_sales,
      monthly_revenue, avg_price, median_price, avg_rating, median_reviews, source, source_type,
      collected_at, period, is_estimated, confidence, observation_date, dedup_key
    ) VALUES ('market-observation', 'market-us', '2026-09-18', ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, '30D', 0, 0.9, '2026-09-18', 'market-observation-key')
  `).run(...(empty ? Array(9).fill(null) : [10, 8, 6, 100, 3000, 30, 29, 4.3, 50]),
    `${marketSourceType} fixture`, marketSourceType, now);
  database.prepare(`
    INSERT INTO product_snapshots (
      id, product_id, date, price, rating, review_count, bsr, estimated_sales,
      estimated_revenue, seller_count, source, source_type, collected_at, period,
      is_estimated, confidence, observation_date, dedup_key
    ) VALUES ('product-observation', 'owned-product', '2026-09-18', ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, '30D', 0, 0.9, '2026-09-18', 'product-observation-key')
  `).run(...(empty ? Array(7).fill(null) : [30, 4.4, 12, 100, 120, 3600, 1]),
    `${productSourceType} fixture`, productSourceType, now);
  if (marketSourceType === 'mock') {
    const register = database.prepare(`
      INSERT INTO demo_seed_records (seed_id, table_name, record_id, created_at)
      VALUES ('v2-demo-seed', ?, ?, ?)
    `);
    register.run('market_snapshots', 'market-observation', now);
    register.run('product_snapshots', 'product-observation', now);
  }
}

describe('GoLiveMigrationService', () => {
  it('reports exact demo observation counts, removes only observations, and rejects activation before real coverage', async () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mock');
    const service = new GoLiveMigrationService(database);

    expect(service.preview().delete).toMatchObject({ marketSnapshots: 1, productSnapshots: 1 });
    expect(() => service.activateLiveMode()).toThrow(/真实数据覆盖|Mock/);
    service.clearDemoObservations();
    expect(database.prepare('SELECT COUNT(*) AS count FROM products').get()).toMatchObject({ count: 1 });
    expect(service.verify()).toMatchObject({ mockObservations: 0, hasMinimumRealCoverage: false });
    expect(() => service.activateLiveMode()).toThrow(/真实数据覆盖/);
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'go-live-backup-'));
    const backupPath = join(temporaryDirectory, 'backup.db');
    await service.backup(backupPath);
    expect(existsSync(backupPath)).toBe(true);
  });

  it('activates only when market and active owned-product coverage are real', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp');
    database.prepare(`UPDATE app_settings SET marketplace = 'US', default_market_id = 'market-us' WHERE id = 1`).run();
    database.prepare(`UPDATE market_nodes SET category_id = '1055398:1063252' WHERE id = 'market-us'`).run();
    const service = new GoLiveMigrationService(database);

    expect(service.verify()).toMatchObject({ hasMinimumRealCoverage: false });
    database.prepare(`
      INSERT INTO provider_capability_snapshots (id, provider_id, capabilities_json, collected_at)
      VALUES ('capabilities', 'sellersprite', ?, ?)
    `).run(JSON.stringify({ capabilities: {
      MARKET_RESEARCH: 'market_research',
      MARKET_STATISTICS: 'market_research_statistics',
      PRODUCT_CONCENTRATION: 'market_product_concentration',
      ASIN_SALES_TREND: 'asin_sales_trend',
      ASIN_COMPETITOR_DISCOVERY: 'asin_competitor',
    } }), '2026-09-19T00:00:00.000Z');
    const addCall = (id: string, capability: string, entityType: string, entityId: string) => {
      database!.prepare(`
        INSERT INTO mcp_call_logs (id, provider_id, capability, request_hash, status,
          entity_type, entity_id, result_count, started_at)
        VALUES (?, 'sellersprite', ?, ?, 'success', ?, ?, 1, ?)
      `).run(id, capability, id, entityType, entityId, '2026-09-19T00:00:00.000Z');
    };
    addCall('other-market-call', 'MARKET_STATISTICS', 'market', 'other-node');
    addCall('other-asin-call', 'ASIN_SALES_TREND', 'product', 'B0OTHER001');
    expect(service.verify()).toMatchObject({ hasMinimumRealCoverage: false });
    addCall('market-call', 'MARKET_STATISTICS', 'market', '1055398:1063252');
    database.prepare(`
      INSERT INTO products (id, asin, sku, brand, title, image_url, marketplace,
        product_type, is_owned, market_node_id, source_type, created_at)
      VALUES ('import-owned', 'B0LIVE0002', 'LIVE-2', 'Brand', 'Import product', '',
        'US', 'pillow', 1, 'market-us', 'import', '2026-09-19')
    `).run();
    database.prepare(`
      INSERT INTO product_snapshots (id, product_id, date, price, source, source_type,
        collected_at, period, is_estimated, confidence, observation_date, dedup_key)
      VALUES ('import-observation', 'import-owned', '2026-09-19', 42, 'import', 'import',
        '2026-09-19', '30D', 0, 1, '2026-09-19', 'import-observation')
    `).run();
    addCall('import-asin-call', 'ASIN_SALES_TREND', 'product', 'B0LIVE0002');
    expect(service.verify()).toMatchObject({
      sellerSpriteAsinCalls: 0, hasMinimumRealCoverage: false,
    });
    addCall('asin-call', 'ASIN_SALES_TREND', 'product', 'B0LIVE0001');
    expect(service.verify()).toMatchObject({
      sellerSpriteConnectionVerified: false, hasMinimumRealCoverage: false,
    });
    database.prepare(`
      UPDATE data_sources SET status = 'connected', last_sync_at = ?
      WHERE id = 'source-sellersprite-mcp'
    `).run(new Date().toISOString());
    expect(service.verify()).toMatchObject({
      sellerSpriteConnectionVerified: true, hasMinimumRealCoverage: true,
    });
    database.prepare(`UPDATE data_sources SET status = 'disconnected'
      WHERE id = 'source-sellersprite-mcp'`).run();
    expect(service.verify()).toMatchObject({
      sellerSpriteConnectionVerified: false, hasMinimumRealCoverage: false,
    });
    database.prepare(`
      UPDATE data_sources SET status = 'connected', last_sync_at = ?
      WHERE id = 'source-sellersprite-mcp'
    `).run(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
    expect(service.verify()).toMatchObject({
      sellerSpriteConnectionVerified: false, hasMinimumRealCoverage: false,
    });
    database.prepare(`
      UPDATE data_sources SET last_sync_at = ? WHERE id = 'source-sellersprite-mcp'
    `).run(new Date().toISOString());
    expect(service.verify()).toMatchObject({ hasMinimumRealCoverage: true });
    service.activateLiveMode();
    expect(database.prepare('SELECT mode FROM app_settings WHERE id = 1').get()).toEqual({ mode: 'live' });
  });

  it('blocks Demo cleanup when real Evidence or research jobs reference seeded records', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    const profile = database.prepare(`SELECT id, version FROM rule_profiles LIMIT 1`).get() as { id: string; version: number };
    database.prepare(`
      INSERT INTO research_jobs (
        id, name, job_type, marketplace, status, entity_type, entity_id, rule_profile_id,
        rule_profile_version, rule_profile_snapshot_json, is_demo, created_by, data_version,
        prompt_version, created_at, updated_at
      ) VALUES ('real-job', 'Real review', 'existing_market', 'US', 'draft',
        'development_project', 'dev-lumbar', ?, ?, '{}', 0, 'admin', 'real-v1',
        'prompt-v1', '2026-09-19', '2026-09-19')
    `).run(profile.id, profile.version);
    database.prepare(`
      INSERT INTO evidence_records (
        id, research_job_id, insight_id, claim, metric_name, metric_value_json,
        source, collected_at, calculation, confidence, created_at
      ) VALUES ('real-evidence', 'real-job', 'insight-market-memory', 'Real claim',
        'sales', '100', 'amazon', '2026-09-19', 'reported', 1, '2026-09-19')
    `).run();
    const service = new GoLiveMigrationService(database);
    expect(service.preview().blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/Evidence/), expect.stringMatching(/research/i),
    ]));
    expect(() => service.clearDemoObservations()).toThrow(/引用/);
    expect(database.prepare(`SELECT insight_id FROM evidence_records WHERE id = 'real-evidence'`).get())
      .toEqual({ insight_id: 'insight-market-memory' });
    expect(database.prepare(`SELECT id FROM development_projects WHERE id = 'dev-lumbar'`).get())
      .toEqual({ id: 'dev-lumbar' });
  });

  it('does not count empty observations or imports alone as live SellerSprite coverage', () => {
    database = openDatabase(':memory:');
    insertObservationFixture(database, 'mcp', 'mcp', true);
    database.prepare(`UPDATE app_settings SET default_market_id = 'market-us' WHERE id = 1`).run();
    expect(new GoLiveMigrationService(database).verify()).toMatchObject({
      realMarketSnapshots: 0, realOwnedProductSnapshots: 0, hasMinimumRealCoverage: false,
    });
  });

  it('archives mock-only seeded owned and competitor masters while retaining real-linked products', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    database.prepare(`
      INSERT INTO products (
        id, asin, sku, brand, title, image_url, marketplace, product_type, is_owned,
        market_node_id, source_type, created_at
      ) VALUES ('real-owned', 'B0LIVE0001', 'REAL-1', 'Brand', 'Real product', '', 'US', 'pillow',
        1, 'mkt-memory-foam', 'import', '2026-09-19')
    `).run();
    database.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, price, source, source_type, collected_at, period,
        is_estimated, confidence, observation_date, dedup_key
      ) VALUES ('real-on-seed', 'owned-sku-01', '2026-09-19', 39, 'amazon', 'amazon',
        '2026-09-19', '30D', 0, 1, '2026-09-19', 'real-on-seed')
    `).run();
    database.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, price, source, source_type, collected_at, period,
        is_estimated, confidence, observation_date, dedup_key
      ) VALUES ('real-on-competitor', 'competitor-01', '2026-09-19', 42, 'sellersprite', 'mcp',
        '2026-09-19', '30D', 1, 0.8, '2026-09-19', 'real-on-competitor')
    `).run();

    const service = new GoLiveMigrationService(database);
    expect(service.preview().archive).toMatchObject({ products: 10 });
    service.clearDemoObservations();
    expect(database.prepare(`
      SELECT id, status FROM products WHERE is_owned = 1 ORDER BY id
    `).all()).toEqual([
      { id: 'owned-sku-01', status: 'active' },
      { id: 'owned-sku-02', status: 'inactive' },
      { id: 'owned-sku-03', status: 'inactive' },
      { id: 'owned-sku-04', status: 'inactive' },
      { id: 'real-owned', status: 'active' },
    ]);
    expect(database.prepare(`SELECT id FROM product_snapshots WHERE id = 'real-on-seed'`).get())
      .toEqual({ id: 'real-on-seed' });
    expect(database.prepare(`SELECT id FROM product_snapshots WHERE id = 'real-on-competitor'`).get())
      .toEqual({ id: 'real-on-competitor' });
    expect(database.prepare(`SELECT id, status FROM products WHERE id LIKE 'competitor-%' ORDER BY id`).all())
      .toEqual(Array.from({ length: 8 }, (_, index) => ({
        id: `competitor-0${index + 1}`, status: index === 0 ? 'active' : 'inactive',
      })));
    expect(new IntelligenceRepository(database).getMarketProducts('mkt-memory-foam')
      .filter((product) => product.id.startsWith('competitor-')).map((product) => product.id))
      .toEqual(['competitor-01']);
    expect(service.verify().activeOwnedProducts).toBe(2);
  });

  it('cleans identifiable Demo refresh snapshots and blocks unrelated Mock observations atomically', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    const addMockMarket = database.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, source, source_type, collected_at, period,
        is_estimated, confidence, observation_date, dedup_key
      ) VALUES (?, 'mkt-memory-foam', '2026-09-19', ?, 'mock',
        '2026-09-19', '30D', 1, 0.8, '2026-09-19', ?)
    `);
    addMockMarket.run('demo-refresh', '演示数据 / Mock Adapter', 'demo-refresh');
    database.prepare(`
      INSERT INTO ai_insights (
        id, entity_type, entity_id, insight_type, status, title, summary,
        facts_json, opportunities_json, risks_json, recommendations_json, evidence_json,
        confidence, model, data_version, input_hash, generated_at
      ) VALUES ('demo-refresh-insight', 'owned_product', 'owned-sku-02', 'sku_diagnosis',
        'demo', 'Demo finding', 'Mock only', '[]', '[]', '[]', '[]', ?,
        0.8, 'rule-engine-v1', 'demo-refresh', 'demo-refresh', '2026-09-19')
    `).run(JSON.stringify([{ id: 'mock-evidence', claim: 'Mock claim', metrics: [], provenance: [{
      source: '演示数据 / Mock Adapter', sourceType: 'mock', collectedAt: '2026-09-19',
      period: '30D', isEstimated: true, confidence: 0.8,
    }] }]));
    const service = new GoLiveMigrationService(database);
    expect(service.preview().delete.marketSnapshots).toBe(29);
    expect(service.preview().delete.aiInsights).toBe(9);
    expect(service.preview().archive.products).toBe(12);
    expect(service.preview().blockers).toEqual([]);

    addMockMarket.run('unrelated-mock', 'User fixture', 'unrelated-mock');
    expect(service.preview().blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/unregistered Mock/i),
    ]));
    expect(() => service.clearDemoObservations()).toThrow(/禁止清理/);
    expect(database.prepare(`SELECT id FROM market_snapshots WHERE id = 'demo-refresh'`).get())
      .toEqual({ id: 'demo-refresh' });
    database.prepare(`DELETE FROM market_snapshots WHERE id = 'unrelated-mock'`).run();

    service.clearDemoObservations();
    expect(database.prepare(`SELECT id FROM market_snapshots WHERE id = 'demo-refresh'`).get())
      .toBeUndefined();
    expect(database.prepare(`SELECT id FROM ai_insights WHERE id = 'demo-refresh-insight'`).get())
      .toBeUndefined();
    expect(service.verify().mockObservations).toBe(0);
  });

  it('does not delete a Demo refresh snapshot cited as real Evidence', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    database.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, source, source_type, collected_at, period,
        is_estimated, confidence, observation_date, dedup_key
      ) VALUES ('demo-refresh', 'owned-sku-02', '2026-09-19', '演示数据 / Mock Adapter',
        'mock', '2026-09-19', '30D', 1, 0.8, '2026-09-19', 'demo-refresh')
    `).run();
    const profile = database.prepare(`SELECT id, version FROM rule_profiles LIMIT 1`).get() as { id: string; version: number };
    database.prepare(`
      INSERT INTO research_jobs (
        id, name, job_type, marketplace, status, entity_type, entity_id, rule_profile_id,
        rule_profile_version, rule_profile_snapshot_json, is_demo, created_by, data_version,
        prompt_version, created_at, updated_at
      ) VALUES ('real-job', 'Real review', 'existing_market', 'US', 'draft',
        'owned_product', 'owned-sku-02', ?, ?, '{}', 0, 'admin', 'real-v1',
        'prompt-v1', '2026-09-19', '2026-09-19')
    `).run(profile.id, profile.version);
    database.prepare(`
      INSERT INTO evidence_records (
        id, research_job_id, source_record_id, claim, metric_name, metric_value_json,
        source, collected_at, calculation, confidence, created_at
      ) VALUES ('real-evidence', 'real-job', 'demo-refresh', 'Claim', 'sales', '100',
        'amazon', '2026-09-19', 'reported', 1, '2026-09-19')
    `).run();
    const service = new GoLiveMigrationService(database);
    expect(service.preview().blockers).toEqual(expect.arrayContaining([expect.stringMatching(/Evidence/)]));
    expect(() => service.clearDemoObservations()).toThrow(/禁止清理/);
    expect(database.prepare(`SELECT id FROM product_snapshots WHERE id = 'demo-refresh'`).get())
      .toEqual({ id: 'demo-refresh' });
  });

  it('cleans snapshots and findings generated by an actual Demo adapter refresh', async () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    const task = await new IntelligenceService(database).runDataTask({
      taskType: 'owned_sku_refresh', target: 'owned-sku-02', sourcePreference: 'Mock Adapter',
    });
    expect(task.status).toBe('success');
    const dynamicSnapshots = database.prepare(`
      SELECT id FROM product_snapshots WHERE product_id = 'owned-sku-02'
        AND id NOT LIKE 'ps-owned-sku-02-%'
    `).all();
    expect(dynamicSnapshots).toHaveLength(1);

    const service = new GoLiveMigrationService(database);
    expect(service.preview().delete.productSnapshots).toBe(33);
    expect(service.preview().archive.products).toBe(12);
    expect(service.preview().blockers).toEqual([]);
    service.clearDemoObservations();
    expect(database.prepare(`SELECT id FROM product_snapshots WHERE source_type = 'mock'`).all()).toEqual([]);
    expect(database.prepare(`SELECT status FROM products WHERE id = 'owned-sku-02'`).get())
      .toEqual({ status: 'inactive' });
    expect(service.verify().mockObservations).toBe(0);
  });

  it('preserves and blocks a mixed-provenance insight rather than classifying it as Demo-only', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    database.prepare(`
      INSERT INTO ai_insights (
        id, entity_type, entity_id, insight_type, status, title, summary,
        facts_json, opportunities_json, risks_json, recommendations_json, evidence_json,
        confidence, model, data_version, input_hash, generated_at
      ) VALUES ('mixed-insight', 'owned_product', 'owned-sku-02', 'sku_diagnosis',
        'review', 'Mixed finding', 'Needs review', '[]', '[]', '[]', '[]', ?,
        0.8, 'rule-engine-v1', 'mixed', 'mixed', '2026-09-19')
    `).run(JSON.stringify([
      { id: 'demo-evidence', claim: 'Demo', metrics: [], provenance: [{ sourceType: 'mock' }] },
      { id: 'unknown-evidence', claim: 'Unknown', metrics: [], provenance: [] },
    ]));
    const service = new GoLiveMigrationService(database);
    expect(service.preview().blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/unregistered Mock insights/i),
    ]));
    expect(() => service.clearDemoObservations()).toThrow(/禁止清理/);
    expect(database.prepare(`SELECT id FROM ai_insights WHERE id = 'mixed-insight'`).get())
      .toEqual({ id: 'mixed-insight' });
  });

  it('keeps a seeded SKU active when a real research job still targets it', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    const profile = database.prepare(`SELECT id, version FROM rule_profiles LIMIT 1`).get() as { id: string; version: number };
    database.prepare(`
      INSERT INTO research_jobs (
        id, name, job_type, marketplace, status, entity_type, entity_id, rule_profile_id,
        rule_profile_version, rule_profile_snapshot_json, is_demo, created_by, data_version,
        prompt_version, created_at, updated_at
      ) VALUES ('real-sku-job', 'Real review', 'owned_product', 'US', 'draft',
        'owned_product', 'owned-sku-04', ?, ?, '{}', 0, 'admin', 'real-v1',
        'prompt-v1', '2026-09-19', '2026-09-19')
    `).run(profile.id, profile.version);
    const service = new GoLiveMigrationService(database);
    expect(service.preview().archive.products).toBe(11);
    service.clearDemoObservations();
    expect(database.prepare(`SELECT status FROM products WHERE id = 'owned-sku-04'`).get())
      .toEqual({ status: 'active' });
    expect(database.prepare(`SELECT entity_id FROM research_jobs WHERE id = 'real-sku-job'`).get())
      .toEqual({ entity_id: 'owned-sku-04' });
    expect(service.verify()).toMatchObject({ activeOwnedProducts: 1, hasMinimumRealCoverage: false });
  });
});
