import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from './database/database.js';
import { ImportService } from './services/import-service.js';
import { MetricAuthorityResolver } from './services/metric-authority-resolver.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

const report = [
  '(Parent) ASIN,(Child) ASIN,Title,SKU,Units Ordered,Ordered Product Sales,Sessions - Total',
  'B0PARENT01,B0ACTUAL01,Contour Pillow,PILLOW-01,132,"$1,299.50",803',
].join('\n');

const options = {
  format: 'csv' as const,
  filename: 'sales-and-traffic-by-child-item.csv',
  sourceType: 'amazon' as const,
  marketplace: 'US',
  reportStartDate: '2026-06-01',
  reportEndDate: '2026-06-30',
};

describe('Amazon child-item Sales and Traffic report import', () => {
  it('previews without a write, then persists actual units/revenue without inventing unrelated metrics', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const preview = service.preview(Buffer.from(report), options);

    expect(preview).toMatchObject({
      detectedType: 'amazon_business_report', entityType: 'product',
      totalCount: 1, newCount: 1, duplicateCount: 0, errorCount: 0,
    });
    expect(preview.mappings).toEqual(expect.arrayContaining([
      { sourceHeader: 'childasin', targetField: 'asin' },
      { sourceHeader: 'unitsordered', targetField: 'estimatedSales' },
      { sourceHeader: 'orderedproductsales', targetField: 'estimatedRevenue' },
    ]));
    expect(database.prepare('SELECT COUNT(*) AS count FROM products').get()).toMatchObject({ count: 0 });

    expect(service.confirm(preview.token)).toMatchObject({ successCount: 1, failureCount: 0 });
    const actual = database.prepare(`
      SELECT p.is_owned, p.asin, p.sku, p.parent_asin, s.observation_date,
        s.period, s.source_type, s.is_estimated, s.estimated_sales,
        s.estimated_revenue, s.price, s.bsr, s.growth_30d, s.rating
      FROM product_snapshots s JOIN products p ON p.id = s.product_id
      WHERE p.asin = 'B0ACTUAL01'
    `).get();
    expect(actual).toEqual({
      is_owned: 1, asin: 'B0ACTUAL01', sku: 'PILLOW-01', parent_asin: 'B0PARENT01',
      observation_date: '2026-06-30', period: '2026-06-01/2026-06-30',
      source_type: 'amazon', is_estimated: 0, estimated_sales: 132,
      estimated_revenue: 1299.5, price: null, bsr: null, growth_30d: null, rating: null,
    });
    expect(service.preview(Buffer.from(report), options)).toMatchObject({ newCount: 0, duplicateCount: 1 });
    expect(service.confirm(service.preview(Buffer.from(report), options).token))
      .toMatchObject({ successCount: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get())
      .toMatchObject({ count: 1 });
  });

  it('rejects missing report provenance and reports invalid rows before confirmation', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const noDates = service.preview(Buffer.from(report), {
      format: 'csv', filename: 'sales.csv', sourceType: 'amazon', marketplace: 'US',
    });
    expect(noDates).toMatchObject({ newCount: 0, errorCount: 1 });
    expect(noDates.errors[0]).toMatch(/第 2 行.*reportStartDate/);
    expect(service.confirm(noDates.token)).toMatchObject({ successCount: 0, failureCount: 1 });

    const noMarketplace = service.preview(Buffer.from(report), { ...options, marketplace: undefined });
    expect(noMarketplace).toMatchObject({ newCount: 0, errorCount: 1 });
    expect(noMarketplace.errors[0]).toMatch(/第 2 行.*marketplace/);

    const invalid = service.preview(Buffer.from(`${report}\nB0PARENT01,B0ACTUAL02,Another,PILLOW-02,12,not-money,44`), options);
    expect(invalid).toMatchObject({ newCount: 1, errorCount: 1 });
    expect(invalid.errors[0]).toMatch(/第 3 行.*Ordered Product Sales/);
    expect(service.confirm(invalid.token)).toMatchObject({ successCount: 1, failureCount: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get())
      .toMatchObject({ count: 1 });
  });

  it('keeps a different report period and chooses Amazon actual over SellerSprite estimate for the same observation date', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const sellerSprite = [
      'ASIN,SKU,Price,Rating,ReviewCount,BSR,EstimatedSales,EstimatedRevenue,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date',
      'B0ACTUAL01,PILLOW-01,39.99,4.5,100,1000,145,1400,2,1.2,4.1,8.2,true,0.8,2026-06-30',
    ].join('\n');
    expect(service.confirm(service.preview(Buffer.from(sellerSprite), {
      format: 'csv', filename: 'sellersprite.csv', sourceType: 'import', marketplace: 'US',
    }).token)).toMatchObject({ successCount: 1 });
    expect(service.confirm(service.preview(Buffer.from(report), options).token))
      .toMatchObject({ successCount: 1 });
    expect(service.confirm(service.preview(Buffer.from(report), {
      ...options, reportStartDate: '2026-06-15',
    }).token)).toMatchObject({ successCount: 1 });

    const product = database.prepare("SELECT id FROM products WHERE asin = 'B0ACTUAL01'").get() as { id: string };
    const snapshots = database.prepare(`
      SELECT source_type, period, estimated_sales FROM product_snapshots
      WHERE product_id = ? ORDER BY source_type, period
    `).all(product.id);
    expect(snapshots).toEqual([
      { source_type: 'amazon', period: '2026-06-01/2026-06-30', estimated_sales: 132 },
      { source_type: 'amazon', period: '2026-06-15/2026-06-30', estimated_sales: 132 },
      { source_type: 'import', period: '30D', estimated_sales: 145 },
    ]);
    const resolved = new MetricAuthorityResolver(database).resolveMetric({
      entityType: 'product', entityId: product.id, metric: 'estimated_sales', observationDate: '2026-06-30',
    });
    expect(resolved.selected).toMatchObject({ value: 132, sourceType: 'amazon', isEstimated: false });
    expect(resolved.alternatives).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 145, sourceType: 'import', isEstimated: true }),
    ]));
  });

  it('marks a child ASIN as owned even when the seller report does not include SKU', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const noSku = report.replace('PILLOW-01,132', ',132');
    const preview = service.preview(Buffer.from(noSku), options);
    expect(preview).toMatchObject({ newCount: 1, errorCount: 0 });
    expect(service.confirm(preview.token)).toMatchObject({ successCount: 1 });
    expect(database.prepare("SELECT is_owned FROM products WHERE asin = 'B0ACTUAL01'").get())
      .toMatchObject({ is_owned: 1 });
  });

  it('rejects non-integer units and an inverted report date range', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const fractional = service.preview(Buffer.from(report.replace(',132,', ',1.5,')), options);
    expect(fractional).toMatchObject({ newCount: 0, errorCount: 1 });
    expect(fractional.errors[0]).toMatch(/Units Ordered/);

    const inverted = service.preview(Buffer.from(report), {
      ...options, reportStartDate: '2026-07-01',
    });
    expect(inverted).toMatchObject({ newCount: 0, errorCount: 1 });
    expect(inverted.errors[0]).toMatch(/reportStartDate.*reportEndDate/);
  });

  it('rejects ambiguous localized money instead of silently misreading its decimal separator', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const localized = report.replace('"$1,299.50"', '"1.299,50"');
    const preview = service.preview(Buffer.from(localized), options);
    expect(preview).toMatchObject({ newCount: 0, errorCount: 1 });
    expect(preview.errors[0]).toMatch(/Ordered Product Sales/);
  });

  it('refuses to label a SellerSprite-shaped product export as Amazon actual during review', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const thirdParty = [
      'ASIN,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date',
      'B0ACTUAL01,39,4.5,100,1000,145,2,1,2,3,false,0.9,2026-06-30',
    ].join('\n');
    expect(() => service.preview(Buffer.from(thirdParty), options)).toThrow(/Amazon.*报表/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get())
      .toMatchObject({ count: 0 });
  });

  it('rejects a direct Amazon import of a non-report file before any product snapshot is written', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const thirdParty = [
      'ASIN,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date',
      'B0ACTUAL01,39,4.5,100,1000,145,2,1,2,3,false,0.9,2026-06-30',
    ].join('\n');
    expect(() => service.import(Buffer.from(thirdParty), { ...options, entityType: 'product' }))
      .toThrow(/Amazon.*报表/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get())
      .toMatchObject({ count: 0 });
  });

  it('does not permit an unknown Amazon file to be manually relabeled as sales data', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const preview = service.preview(Buffer.from('ASIN,Order Date\nB0ACTUAL01,2026-06-30'), options);
    expect(preview.detectedType).toBe('unknown');
    expect(() => service.selectType(preview.token, 'product')).toThrow(/Amazon.*报表/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get())
      .toMatchObject({ count: 0 });
  });

  it('reports changed values for the same child/date range as a conflict rather than a successful duplicate', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    expect(service.confirm(service.preview(Buffer.from(report), options).token))
      .toMatchObject({ successCount: 1 });

    const corrected = report.replace(',132,', ',133,');
    const preview = service.preview(Buffer.from(corrected), options);
    expect(preview).toMatchObject({ newCount: 0, duplicateCount: 0, errorCount: 1 });
    expect(preview.errors[0]).toMatch(/第 2 行.*冲突/);
    expect(service.confirm(preview.token)).toMatchObject({ successCount: 0, failureCount: 1 });
    expect(database.prepare("SELECT estimated_sales FROM product_snapshots WHERE source_type = 'amazon'").all())
      .toEqual([{ estimated_sales: 132 }]);
  });
});
