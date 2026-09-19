import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { MetricAuthorityResolver } from './metric-authority-resolver.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe('MetricAuthorityResolver', () => {
  it('selects Amazon actual owned-sales data while returning SellerSprite estimates as alternatives', () => {
    database = openDatabase(':memory:');
    const now = '2026-09-19T00:00:00.000Z';
    database.prepare(`
      INSERT INTO market_nodes (id, name, level, marketplace, status, source_type, created_at)
      VALUES ('market-us', 'US market', 1, 'US', 'active', 'import', ?)
    `).run(now);
    database.prepare(`
      INSERT INTO products (
        id, asin, sku, brand, title, image_url, marketplace, product_type, is_owned,
        market_node_id, source_type, created_at
      ) VALUES ('owned-product', 'B0AUTH0001', 'AUTH-1', 'Brand', 'Title', '', 'US', 'pillow',
        1, 'market-us', 'import', ?)
    `).run(now);
    const insert = database.prepare(`
      INSERT INTO metric_facts (
        id, entity_type, entity_id, marketplace, metric_name, numeric_value, source, source_type,
        is_estimated, confidence, observation_date, collected_at, dedup_key
      ) VALUES (?, 'product', 'owned-product', 'US', 'estimated_sales', ?, ?, ?, ?, 0.9,
        '2026-09-18', ?, ?)
    `);
    insert.run('estimated-fact', 100, 'SellerSprite MCP', 'mcp', 1, now, 'estimated-fact-key');
    insert.run('actual-fact', 120, 'Amazon SP-API', 'amazon', 0, now, 'actual-fact-key');

    const authority = new MetricAuthorityResolver(database).resolveMetric({
      entityId: 'owned-product', metric: 'estimated_sales', observationDate: '2026-09-18',
    });

    expect(authority.selected).toMatchObject({ id: 'actual-fact', sourceType: 'amazon', value: 120 });
    expect(authority.alternatives).toEqual([
      expect.objectContaining({ id: 'estimated-fact', sourceType: 'mcp', value: 100 }),
    ]);
    expect(authority.reason).toContain('Amazon');
  });

  it('selects SellerSprite MCP market facts over imported third-party facts without deleting either', () => {
    database = openDatabase(':memory:');
    const now = '2026-09-19T00:00:00.000Z';
    const insert = database.prepare(`
      INSERT INTO metric_facts (
        id, entity_type, entity_id, marketplace, metric_name, numeric_value, source, source_type,
        is_estimated, confidence, observation_date, collected_at, dedup_key
      ) VALUES (?, 'market', 'market-us', 'US', 'monthly_sales', ?, ?, ?, 1, 0.9,
        '2026-09-18', ?, ?)
    `);
    insert.run('import-market-fact', 100, 'SellerSprite CSV', 'import', now, 'import-market-fact-key');
    insert.run('mcp-market-fact', 120, 'SellerSprite MCP', 'mcp', now, 'mcp-market-fact-key');

    const authority = new MetricAuthorityResolver(database).resolveMetric({
      entityId: 'market-us', entityType: 'market', metric: 'monthly_sales', observationDate: '2026-09-18',
    });

    expect(authority.selected).toMatchObject({ id: 'mcp-market-fact', sourceType: 'mcp', value: 120 });
    expect(authority.alternatives).toEqual([
      expect.objectContaining({ id: 'import-market-fact', sourceType: 'import', value: 100 }),
    ]);
  });
});
