import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { seedDemoData } from '../database/demo-seed.js';
import { WorkflowRepository } from './workflow-repository.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe('Research Job Demo classification', () => {
  it('uses target provenance while real records coexist with retained Demo data', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    database.exec(`
      INSERT INTO market_nodes (
        id, name, parent_id, level, marketplace, category_id, keywords_json,
        status, source_type, created_at
      ) VALUES (
        'real-market', 'Verified Memory Foam Market', NULL, 1, 'US',
        '1055398:1063252:1199122', '[]', 'active', 'import', '2026-09-21T00:00:00.000Z'
      );
      INSERT INTO products (
        id, asin, sku, internal_name, brand, title, image_url, marketplace,
        product_type, is_owned, market_node_id, keywords_json, monitoring_enabled,
        source_type, created_at, status
      ) VALUES (
        'real-owned', 'B0REAL0001', 'REAL-001', 'Real owned SKU', 'Real Brand',
        'Real Memory Foam Pillow', '', 'US', 'memory_foam_pillow', 1,
        'real-market', '[]', 1, 'import', '2026-09-21T00:00:00.000Z', 'active'
      );
      UPDATE app_settings SET default_market_id = 'real-market' WHERE id = 1;
    `);

    expect(database.prepare('SELECT mode FROM app_settings WHERE id = 1').get())
      .toEqual({ mode: 'demo' });

    const repository = new WorkflowRepository(database);
    const realMarket = repository.createResearchJob({
      name: 'Real market acceptance',
      type: 'existing_market',
      entityType: 'market_node',
      entityId: 'real-market',
      createdBy: 'acceptance-test',
    });
    const realOwned = repository.createResearchJob({
      name: 'Real owned acceptance',
      type: 'owned_product',
      entityType: 'owned_product',
      entityId: 'real-owned',
      createdBy: 'acceptance-test',
    });
    const demoMarket = repository.createResearchJob({
      name: 'Demo market check',
      type: 'existing_market',
      entityType: 'market_node',
      entityId: 'mkt-memory-foam',
      createdBy: 'acceptance-test',
    });
    const demoOwned = repository.createResearchJob({
      name: 'Demo owned check',
      type: 'owned_product',
      entityType: 'owned_product',
      entityId: 'owned-sku-01',
      createdBy: 'acceptance-test',
    });

    expect(realMarket.isDemo).toBe(false);
    expect(realOwned.isDemo).toBe(false);
    expect(demoMarket.isDemo).toBe(true);
    expect(demoOwned.isDemo).toBe(true);
  });

  it('refuses a Mock target outside Demo mode', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    database.prepare("UPDATE app_settings SET mode = 'live' WHERE id = 1").run();

    const repository = new WorkflowRepository(database);
    expect(() => repository.createResearchJob({
      name: 'Invalid live Mock job',
      type: 'existing_market',
      entityType: 'market_node',
      entityId: 'mkt-memory-foam',
      createdBy: 'acceptance-test',
    })).toThrow(/Mock|Demo/);
  });
});
