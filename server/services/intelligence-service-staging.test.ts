import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { IntelligenceService } from './intelligence-service.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe('staged real data before Go Live', () => {
  it('keeps an untouched empty workspace empty', () => {
    database = openDatabase(':memory:');
    const service = new IntelligenceService(database);

    expect(service.getDashboard().summaries).toMatchObject({
      market: { monthlyRevenue: null, status: '尚未接入真实数据' },
      skus: { pendingData: 0 },
    });
    expect(service.repository.getSettings().mode).toBe('empty');
  });

  it('shows imported observations and pending SKU coverage without activating Live', () => {
    database = openDatabase(':memory:');
    const service = new IntelligenceService(database);
    service.createOwnedProduct({
      asin: 'B0STAGING001', sku: 'STAGING-01', brand: 'Example', title: 'Memory Foam Pillow',
      marketNodeId: 'staged-market', marketplace: 'US',
    });
    database.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, product_count, seller_count, brand_count,
        monthly_sales, monthly_revenue, avg_price, median_price, avg_rating, median_reviews,
        source, source_type, collected_at, period, is_estimated, confidence,
        observation_date, dedup_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'staged-market-snapshot', 'staged-market', '2026-08-31', 100, 75, 40,
      12_000, 480_000, 40, 38, 4.3, 240,
      'SellerSprite import', 'import', '2026-09-01T00:00:00.000Z', 'monthly', 1, 0.8,
      '2026-08-31', 'staged-market:2026-08-31:import',
    );

    const dashboard = service.getDashboard();

    expect(dashboard.summaries.market.monthlyRevenue).toBe(480_000);
    expect(dashboard.summaries.market.snapshotAvailable).toBe(true);
    expect(dashboard.summaries.skus.pendingData).toBe(1);
    expect(dashboard.briefing).toEqual([]);
    expect(service.repository.getSettings().mode).toBe('empty');
  });

  it('fails the legacy core refresh explicitly for the actual MCP adapter without writes', async () => {
    database = openDatabase(':memory:');
    const service = new IntelligenceService(database);
    service.createOwnedProduct({
      asin: 'B0STAGING002', brand: 'Example', title: 'Memory Foam Pillow',
      marketNodeId: 'staged-market', marketplace: 'US',
    });

    const task = await service.runDataTask({ taskType: 'dashboard_core_refresh', target: 'all' });

    expect(task.status).toBe('failed');
    expect(task.sourceId).toBe('source-sellersprite-mcp');
    expect(task.errorLog).toMatch(/V2\.2.*同步|不支持.*旧版刷新/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM market_snapshots').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get()).toEqual({ count: 0 });
    expect(service.repository.getSettings().mode).toBe('empty');
  });
});
