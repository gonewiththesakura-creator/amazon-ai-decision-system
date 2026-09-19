import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { GoLiveMigrationService } from './go-live-migration-service.js';

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
    ) VALUES ('market-observation', 'market-us', '2026-09-18', 10, 8, 6, 100, 3000, 30, 29,
      4.3, 50, ?, ?, ?, '30D', 0, 0.9, '2026-09-18', 'market-observation-key')
  `).run(`${marketSourceType} fixture`, marketSourceType, now);
  database.prepare(`
    INSERT INTO product_snapshots (
      id, product_id, date, price, rating, review_count, bsr, estimated_sales,
      estimated_revenue, seller_count, source, source_type, collected_at, period,
      is_estimated, confidence, observation_date, dedup_key
    ) VALUES ('product-observation', 'owned-product', '2026-09-18', 30, 4.4, 12, 100, 120,
      3600, 1, ?, ?, ?, '30D', 0, 0.9, '2026-09-18', 'product-observation-key')
  `).run(`${productSourceType} fixture`, productSourceType, now);
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
    const service = new GoLiveMigrationService(database);

    service.activateLiveMode();
    expect(database.prepare('SELECT mode FROM app_settings WHERE id = 1').get()).toEqual({ mode: 'live' });
  });
});
