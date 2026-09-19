import { afterEach, describe, expect, it } from 'vitest';
import { ImportService } from './services/import-service.js';
import { openDatabase, type AppDatabase } from './database/database.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

const productMasterCsv = [
  'marketplace,asin,sku,internalName,brand,title,productType,parentAsin,variationTheme,marketNode,monitoringEnabled,status',
  'US,B0OWNED001,OWN-001,Contour Pillow,Northstar,Contour Pillow,memory foam,B0PARENT01,SizeName,Memory Foam,true,active',
].join('\n');

describe('import preview API', () => {
  it('previews the owned product master without writing business data, then confirms exactly once', async () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const preview = service.preview(Buffer.from(productMasterCsv), {
      format: 'csv', filename: 'owned-product-master.csv',
    });

    expect(preview).toMatchObject({
      detectedType: 'owned_product_master', totalCount: 1, newCount: 1, duplicateCount: 0, errorCount: 0,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM products').get()).toMatchObject({ count: 0 });

    const first = service.confirm(preview.token);
    expect(first).toMatchObject({ entityType: 'owned_product_master', successCount: 1, failureCount: 0 });
    expect(database.prepare(`
      SELECT product.sku, product.internal_name, product.parent_asin, product.status, product.monitoring_enabled,
             family.variation_theme
      FROM products product
      LEFT JOIN variation_families family ON family.id = product.variation_family_id
      WHERE product.asin = 'B0OWNED001'
    `).get()).toMatchObject({
      sku: 'OWN-001', internal_name: 'Contour Pillow', parent_asin: 'B0PARENT01',
      variation_theme: 'SizeName', status: 'active', monitoring_enabled: 1,
    });

    const repeated = service.confirm(preview.token);
    expect(repeated).toMatchObject({ entityType: 'owned_product_master', successCount: 1, failureCount: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM products').get()).toMatchObject({ count: 1 });

    const reimport = service.preview(Buffer.from(productMasterCsv), {
      format: 'csv', filename: 'owned-product-master.csv',
    });
    expect(reimport.duplicateCount).toBe(1);
  });

  it('requires an explicit type before confirming an unknown file', async () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const preview = service.preview(Buffer.from('Mystery\nvalue'), { format: 'csv', filename: 'mystery.csv' });

    expect(preview.detectedType).toBe('unknown');
    expect(() => service.confirm(preview.token)).toThrow(/明确选择/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM products').get()).toMatchObject({ count: 0 });
  });

  it('preserves the historical observation date and does not duplicate an identical product import', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const csv = [
      'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date',
      'B0HISTORY1,HIS-001,Northstar,History Pillow,history-market,History Market,39.99,4.5,120,1000,280,1,1.2,4.1,8.2,false,0.9,2026-06-30',
    ].join('\n');

    const first = service.import(Buffer.from(csv), { format: 'csv', filename: 'history.csv', entityType: 'product' });
    expect(first.errors).toEqual([]);
    expect(first).toMatchObject({ successCount: 1, failureCount: 0 });
    expect(service.import(Buffer.from(csv), { format: 'csv', filename: 'history.csv', entityType: 'product' }))
      .toMatchObject({ successCount: 1, failureCount: 0 });

    expect(database.prepare(`
      SELECT observation_date AS observationDate FROM product_snapshots
      WHERE product_id = (SELECT id FROM products WHERE asin = 'B0HISTORY1')
    `).all()).toEqual([{ observationDate: '2026-06-30' }]);
  });
});
