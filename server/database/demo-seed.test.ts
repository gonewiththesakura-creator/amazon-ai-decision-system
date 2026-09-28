import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from './database.js';
import { disableDemoMode, seedDemoData } from './demo-seed.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function db(): AppDatabase {
  database = openDatabase(':memory:');
  return database;
}

describe('Demo seed isolation', () => {
  it('does not delete newly added real market and product records on repeated enable', () => {
    const database = db();
    seedDemoData(database);
    database.prepare(`
      INSERT INTO market_nodes (id, name, level, marketplace, status, source_type, created_at)
      VALUES ('real-market', 'Real market', 1, 'US', 'active', 'mcp', ?)
    `).run('2026-09-19T00:00:00.000Z');
    database.prepare(`
      INSERT INTO products (
        id, asin, brand, title, image_url, marketplace, product_type, is_owned,
        market_node_id, source_type, created_at
      ) VALUES ('real-owned', 'B0LIVE00001', 'Real', 'Real owned product', '', 'US', 'pillow', 1,
        'real-market', 'import', ?)
    `).run('2026-09-19T00:00:00.000Z');
    database.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, source, source_type, collected_at, period,
        is_estimated, confidence, observation_date, dedup_key
      ) VALUES ('real-observation', 'real-market', '2026-09-18', 'SellerSprite MCP', 'mcp', ?,
        '30D', 1, 0.8, '2026-09-18', 'real-market-observation')
    `).run('2026-09-19T00:00:00.000Z');
    const before = database.prepare(`
      SELECT COUNT(*) AS count FROM demo_seed_records WHERE seed_id = 'v2-demo-seed'
    `).get();

    seedDemoData(database);

    expect(database.prepare(`SELECT id FROM market_nodes WHERE id = 'real-market'`).get())
      .toEqual({ id: 'real-market' });
    expect(database.prepare(`SELECT id FROM products WHERE id = 'real-owned'`).get())
      .toEqual({ id: 'real-owned' });
    expect(database.prepare(`SELECT id FROM market_snapshots WHERE id = 'real-observation'`).get())
      .toEqual({ id: 'real-observation' });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM demo_seed_records WHERE seed_id = 'v2-demo-seed'
    `).get()).toEqual(before);

    expect(() => disableDemoMode(database)).toThrow(/Go Live 迁移/);
    expect(database.prepare(`SELECT id FROM market_snapshots WHERE id = 'real-observation'`).get())
      .toEqual({ id: 'real-observation' });
  });

  it('refuses initial Demo seeding when an unregistered business task already exists', () => {
    const database = db();
    database.prepare(`
      INSERT INTO data_tasks (
        id, name, source_id, task_type, target, source, status, total, success,
        failed, created_at
      ) VALUES ('real-task', 'Real task', 'source-sellersprite-mcp', 'market_refresh',
        'market', 'SellerSprite MCP', 'pending', 0, 0, 0, ?)
    `).run('2026-09-19T00:00:00.000Z');

    expect(() => seedDemoData(database)).toThrow(/不能进入 Demo 模式/);
    expect(database.prepare(`SELECT id FROM data_tasks WHERE id = 'real-task'`).get())
      .toEqual({ id: 'real-task' });
  });

  it('requires explicit Go Live cleanup before disabling Demo and leaves evidence intact', () => {
    const database = db();
    seedDemoData(database);
    const snapshotCount = database.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE source_type = 'mock'
    `).get();
    const insightCount = database.prepare(`
      SELECT COUNT(*) AS count FROM ai_insights WHERE data_version = 'demo-2026-09-09'
    `).get();

    expect(() => disableDemoMode(database)).toThrow(/Go Live 迁移/);

    expect(database.prepare('SELECT mode FROM app_settings WHERE id = 1').get())
      .toEqual({ mode: 'demo' });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE source_type = 'mock'
    `).get()).toEqual(snapshotCount);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM ai_insights WHERE data_version = 'demo-2026-09-09'
    `).get()).toEqual(insightCount);
  });
});
