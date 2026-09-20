import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import * as XLSX from 'xlsx';
import { ImportService } from './services/import-service.js';
import { openDatabase, type AppDatabase } from './database/database.js';
import { SellerSpriteImportAdapter } from './adapters/import-adapters.js';
import { createApp } from './app.js';
import { disableDemoMode, seedDemoData } from './database/demo-seed.js';
import { GoLiveMigrationService } from './services/go-live-migration-service.js';
import { addVerifiedMcpCoverage } from './test-utils/verified-mcp-coverage.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

const productMasterCsv = [
  'marketplace,asin,sku,internalName,brand,title,productType,parentAsin,variationTheme,marketNode,monitoringEnabled,status',
  'US,B0OWNED001,OWN-001,Contour Pillow,Northstar,Contour Pillow,memory foam,B0PARENT01,SizeName,Memory Foam,true,active',
].join('\n');

function productSnapshotWorkbook(): Buffer {
  const excelDate = (Date.UTC(2026, 5, 30) - Date.UTC(1899, 11, 30)) / 86_400_000;
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([
    [
      'ASIN', 'SKU', 'Brand', 'Title', 'MarketNodeId', 'MarketName', 'Price', 'Rating',
      'ReviewCount', 'BSR', 'EstimatedSales', 'SellerCount', 'Growth7D', 'Growth30D',
      'Growth90D', 'IsEstimated', 'Confidence', 'Date',
    ],
    [
      'B0XLSX001', 'XLSX-001', 'Test Brand', 'Test Pillow', 'xlsx-market', 'XLSX Market',
      39.99, 4.5, 120, 1000, 280, 1, 1.2, 4.1, 8.2, false, 0.9,
      excelDate,
    ],
  ]);
  worksheet.R2!.z = 'yyyy-mm-dd';
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Snapshots');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellDates: true }) as Buffer;
}

function unknownWorkbook(): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Mystery'], ['value']]), 'Unknown');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('import preview API', () => {
  it('previews the owned product master without writing business data, then confirms exactly once', async () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const preview = service.preview(Buffer.from(productMasterCsv), {
      format: 'csv', filename: 'owned-product-master.csv',
    });

    expect(preview).toMatchObject({
      detectedType: 'owned_product_master', totalCount: 1, newCount: 1, updateCount: 0, duplicateCount: 0, errorCount: 0,
    });
    expect(preview.mappings).toEqual(expect.arrayContaining([
      { sourceHeader: 'asin', targetField: 'asin' },
      { sourceHeader: 'monitoringenabled', targetField: 'monitoringEnabled' },
    ]));
    expect(preview.rows).toEqual([expect.objectContaining({ rowNumber: 2, values: expect.objectContaining({ asin: 'B0OWNED001' }) })]);
    expect(preview).toMatchObject({ previewRowLimit: 20, previewedCount: 1, rowsOmitted: 0, contentDigest: expect.any(String) });
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
    expect(reimport.updateCount).toBe(0);
  });

  it('previews changed owned-product metadata as an actionable update rather than an unchanged duplicate', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    service.confirm(service.preview(Buffer.from(productMasterCsv), {
      format: 'csv', filename: 'original-master.csv',
    }).token);

    const revised = productMasterCsv.replace('Contour Pillow,Northstar', 'Updated Contour Pillow,Northstar')
      .replace('Memory Foam,true,active', 'Memory Foam,false,inactive');
    const preview = service.preview(Buffer.from(revised), { format: 'csv', filename: 'revised-master.csv' });
    expect(preview).toMatchObject({ newCount: 0, updateCount: 1, duplicateCount: 0, errorCount: 0 });
    expect(service.confirm(preview.token)).toMatchObject({ successCount: 1 });
    expect(database.prepare(`
      SELECT internal_name, monitoring_enabled, status FROM products WHERE asin = 'B0OWNED001'
    `).get()).toEqual({
      internal_name: 'Updated Contour Pillow', monitoring_enabled: 0, status: 'inactive',
    });
  });

  it.each([
    ['identical row', (row: string) => row],
    ['same ASIN and different SKU', (row: string) => row.replace('OWN-001', 'OWN-002')
      .replace('Contour Pillow,Northstar', 'Second Pillow,Northstar')],
    ['same SKU and different ASIN', (row: string) => row.replace('B0OWNED001', 'B0OWNED002')
      .replace('Contour Pillow,Northstar', 'Second Pillow,Northstar')],
  ])('flags a later %s in one owned-master upload before confirmation', (_caseName, secondRow) => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const [header, firstRow] = productMasterCsv.split('\n');
    const csv = [header, firstRow, secondRow(firstRow)].join('\n');

    const preview = service.preview(Buffer.from(csv), { format: 'csv', filename: 'same-upload.csv' });

    expect(preview).toMatchObject({ totalCount: 2, newCount: 1, updateCount: 0,
      duplicateCount: 0, errorCount: 1 });
    expect(preview.errors).toEqual([expect.stringMatching(/第 3 行.*第 2 行/)]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM products').get()).toEqual({ count: 0 });

    const result = service.confirm(preview.token);
    expect(result).toMatchObject({ rowCount: 2, successCount: 1, failureCount: 1,
      errors: [expect.stringMatching(/第 3 行.*第 2 行/)] });
    expect(database.prepare('SELECT asin, sku, internal_name FROM products').all()).toEqual([{
      asin: 'B0OWNED001', sku: 'OWN-001', internal_name: 'Contour Pillow',
    }]);
  });

  it('applies a reviewed variation-theme update to the existing family', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    service.confirm(service.preview(Buffer.from(productMasterCsv), {
      format: 'csv', filename: 'original-master.csv',
    }).token);
    const revised = productMasterCsv.replace('SizeName', 'ColorName');
    const preview = service.preview(Buffer.from(revised), { format: 'csv', filename: 'family-update.csv' });
    expect(preview).toMatchObject({ newCount: 0, updateCount: 1, duplicateCount: 0 });
    expect(service.confirm(preview.token)).toMatchObject({ successCount: 1 });
    expect(database.prepare(`
      SELECT variation_theme FROM variation_families WHERE parent_asin = 'B0PARENT01'
    `).get()).toEqual({ variation_theme: 'ColorName' });
  });

  it('creates a visible owned product through the preview and confirmation API', async () => {
    database = openDatabase(':memory:');
    const app = createApp({ database });
    const preview = await request(app).post('/api/import/preview/csv')
      .attach('file', Buffer.from(productMasterCsv), 'owned-product-master.csv')
      .expect(200);

    const confirmed = await request(app).post('/api/import/confirm')
      .send({ token: preview.body.data.token })
      .expect(201);
    expect(confirmed.body.data).toMatchObject({ successCount: 1, failureCount: 0 });
    const owned = await request(app).get('/api/owned-products').expect(200);
    expect(owned.body.data).toEqual([expect.objectContaining({ asin: 'B0OWNED001', isOwned: true })]);
  });

  it('imports an XLSX product snapshot over HTTP only after confirmation and keeps the observation idempotent', async () => {
    database = openDatabase(':memory:');
    const app = createApp({ database });
    const workbook = productSnapshotWorkbook();

    const preview = await request(app).post('/api/import/preview/xlsx')
      .attach('file', workbook, 'product-snapshot.xlsx')
      .expect(200);
    expect(preview.body.data).toMatchObject({
      detectedType: 'sellersprite_product', entityType: 'product', totalCount: 1,
      newCount: 1, errorCount: 0,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM products').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM import_batches').get()).toEqual({ count: 0 });

    const confirmed = await request(app).post('/api/import/confirm')
      .send({ token: preview.body.data.token })
      .expect(201);
    expect(confirmed.body.data).toMatchObject({ successCount: 1, failureCount: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count, MIN(observation_date) AS observationDate
      FROM product_snapshots
    `).get()).toEqual({ count: 1, observationDate: '2026-06-30' });
    expect(database.prepare('SELECT format FROM import_batches').all()).toEqual([{ format: 'xlsx' }]);

    await request(app).post('/api/import/confirm')
      .send({ token: preview.body.data.token })
      .expect(201);
    expect(database.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM import_batches').get()).toEqual({ count: 1 });

    const replayPreview = await request(app).post('/api/import/preview/xlsx')
      .attach('file', workbook, 'product-snapshot.xlsx')
      .expect(200);
    expect(replayPreview.body.data).toMatchObject({ duplicateCount: 1, newCount: 0, errorCount: 0 });
    await request(app).post('/api/import/confirm')
      .send({ token: replayPreview.body.data.token })
      .expect(201);
    expect(database.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT format FROM import_batches ORDER BY imported_at').all())
      .toEqual([{ format: 'xlsx' }, { format: 'xlsx' }]);
  });

  it('does not let an unknown XLSX file bypass preview confirmation', async () => {
    database = openDatabase(':memory:');
    const app = createApp({ database });
    const preview = await request(app).post('/api/import/preview/xlsx')
      .attach('file', unknownWorkbook(), 'unknown.xlsx')
      .expect(200);

    expect(preview.body.data).toMatchObject({ detectedType: 'unknown', entityType: null, errorCount: 1 });
    await request(app).post('/api/import/confirm')
      .send({ token: preview.body.data.token })
      .expect(400);
    expect(database.prepare('SELECT COUNT(*) AS count FROM products').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM import_batches').get()).toEqual({ count: 0 });
  });

  it('preserves Demo and real lineage during import until explicit scoped Demo disable', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    const service = new ImportService(database);
    const master = service.preview(Buffer.from(productMasterCsv.replace('B0OWNED001', 'B0REAL0001').replace('OWN-001', 'REAL-001')), {
      format: 'csv', filename: 'real-master.csv',
    });
    expect(service.confirm(master.token)).toMatchObject({ successCount: 1 });
    const beforeMock = database.prepare(`SELECT COUNT(*) AS count FROM product_snapshots WHERE source_type = 'mock'`).get() as { count: number };
    const csv = [
      'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date',
      'B0REAL0001,REAL-001,Northstar,Real Pillow,real-market,Real Market,39.99,4.5,120,1000,280,1,1.2,4.1,8.2,false,0.9,2026-06-30',
    ].join('\n');

    expect(service.import(Buffer.from(csv), { format: 'csv', filename: 'real-snapshot.csv', entityType: 'product' }))
      .toMatchObject({ successCount: 1 });
    expect(database.prepare('SELECT mode FROM app_settings WHERE id = 1').get()).toMatchObject({ mode: 'demo' });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM product_snapshots WHERE source_type = 'mock'`).get())
      .toMatchObject({ count: beforeMock.count });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM product_snapshots WHERE source_type = 'import'`).get())
      .toMatchObject({ count: 1 });

    expect(() => disableDemoMode(database!)).toThrow(/Go Live/);
    expect(new GoLiveMigrationService(database).preview().blockers).toEqual([]);
    const importedProduct = database.prepare(`SELECT id, market_node_id FROM products WHERE asin = 'B0REAL0001'`)
      .get() as { id: string; market_node_id: string };
    addVerifiedMcpCoverage(database, importedProduct.market_node_id, importedProduct.id);
    new GoLiveMigrationService(database).clearDemoObservations();
    disableDemoMode(database);
    expect(database.prepare('SELECT mode FROM app_settings WHERE id = 1').get()).toMatchObject({ mode: 'empty' });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM product_snapshots WHERE source_type = 'mock'`).get())
      .toMatchObject({ count: 0 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM product_snapshots WHERE source_type = 'import'`).get())
      .toMatchObject({ count: 1 });
  });

  it('requires an explicit type before confirming an unknown file', async () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const preview = service.preview(Buffer.from('Mystery\nvalue'), { format: 'csv', filename: 'mystery.csv' });

    expect(preview.detectedType).toBe('unknown');
    expect(() => service.confirm(preview.token)).toThrow(/明确选择/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM products').get()).toMatchObject({ count: 0 });
  });

  it('lets an operator select a valid type for an unknown header signature', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const csv = [
      'Name,ProductCount,SellerCount,BrandCount,MonthlySales,AvgPrice,MedianPrice,AvgRating,MedianReviews,Top10Share,Top20Share,NewProductShare,Confidence,IsEstimated,Date',
      'Operator Selected Market,100,50,20,1000,30,28,4.2,180,20,35,10,0.9,false,2026-06-30',
    ].join('\n');
    const preview = service.preview(Buffer.from(csv), { format: 'csv', filename: 'operator-market.csv' });

    expect(preview.detectedType).toBe('unknown');
    expect(() => service.confirm(preview.token, 'market')).toThrow(/重新预览/);
    const selected = service.selectType(preview.token, 'market');
    expect(selected).toMatchObject({ entityType: 'market', newCount: 1, errorCount: 0 });
    expect(service.confirm(selected.token)).toMatchObject({ entityType: 'market', successCount: 1 });
  });

  it('confirms the staged normalized rows without invoking the adapter a second time', () => {
    database = openDatabase(':memory:');
    const adapter = new SellerSpriteImportAdapter();
    let calls = 0;
    const ingest = adapter.ingest.bind(adapter);
    adapter.ingest = (input) => {
      calls += 1;
      return ingest(input);
    };
    const registry = { getFile: () => adapter };
    const service = new ImportService(database, registry);
    const preview = service.preview(Buffer.from(productMasterCsv), { format: 'csv', filename: 'master.csv' });

    service.confirm(preview.token);
    expect(calls).toBe(1);
  });

  it('does not reparse staged product snapshot rows during confirmation', () => {
    database = openDatabase(':memory:');
    const adapter = new SellerSpriteImportAdapter();
    let calls = 0;
    const ingest = adapter.ingest.bind(adapter);
    adapter.ingest = (input) => {
      calls += 1;
      return ingest(input);
    };
    const service = new ImportService(database, { getFile: () => adapter });
    const csv = [
      'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date',
      'B0STAGED1,STAGED-1,Northstar,Staged Pillow,staged-market,Staged Market,39.99,4.5,120,1000,280,1,1.2,4.1,8.2,false,0.9,2026-06-30',
    ].join('\n');
    const preview = service.preview(Buffer.from(csv), { format: 'csv', filename: 'staged.csv' });

    service.confirm(preview.token);
    expect(calls).toBe(1);
  });

  it('rejects conflicting master identities during preview and audits successful rows after partial failure', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const first = service.preview(Buffer.from(productMasterCsv), { format: 'csv', filename: 'first.csv' });
    service.confirm(first.token);
    const rekeyedAsin = productMasterCsv.replace('B0OWNED001', 'B0OWNED999');
    const conflicting = service.preview(Buffer.from(rekeyedAsin), { format: 'csv', filename: 'sku-conflict.csv' });
    expect(conflicting).toMatchObject({ duplicateCount: 0, errorCount: 1 });
    expect(conflicting.errors[0]).toMatch(/新 ASIN/);

    const mixed = `${productMasterCsv}\nUS,B0BAD001,BAD-001,,Northstar,Bad Pillow,memory foam,,,Memory Foam,true,active`;
    const preview = service.preview(Buffer.from(mixed), { format: 'csv', filename: 'mixed.csv' });
    const result = service.confirm(preview.token);
    expect(result).toMatchObject({ successCount: 1, failureCount: 1 });
    const audit = database.prepare('SELECT errors_json FROM import_batches WHERE id = ?').get(result.batchId) as { errors_json: string };
    expect(JSON.parse(audit.errors_json)).toMatchObject({ successfulRows: [expect.objectContaining({ rowNumber: 2 })] });
  });

  it('bounds preview staging by evicting the oldest token after the cache limit', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const first = service.preview(Buffer.from('Mystery\nfirst'), { format: 'csv', filename: '0.csv' });
    for (let index = 1; index <= 50; index += 1) {
      service.preview(Buffer.from(`Mystery\n${index}`), { format: 'csv', filename: `${index}.csv` });
    }

    expect(() => service.confirm(first.token, 'market')).toThrow(/无效或已过期/);
  });

  it('truthfully marks rows beyond the bounded review sample as omitted', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const [header, row] = productMasterCsv.split('\n');
    const csv = [header, ...Array.from({ length: 21 }, (_, index) => row.replace('B0OWNED001', `B0SAMPLE${index}`)
      .replace('OWN-001', `SAMPLE-${index}`))].join('\n');

    expect(service.preview(Buffer.from(csv), { format: 'csv', filename: 'large-master.csv' }))
      .toMatchObject({ totalCount: 21, previewRowLimit: 20, previewedCount: 20, rowsOmitted: 1 });
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
    expect(database.prepare('SELECT mode FROM app_settings WHERE id = 1').get()).toMatchObject({ mode: 'empty' });
    expect(service.preview(Buffer.from(csv), { format: 'csv', filename: 'history-preview.csv' }).duplicateCount).toBe(1);
    expect(service.import(Buffer.from(csv), { format: 'csv', filename: 'history.csv', entityType: 'product' }))
      .toMatchObject({ successCount: 1, failureCount: 0 });

    expect(database.prepare(`
      SELECT observation_date AS observationDate FROM product_snapshots
      WHERE product_id = (SELECT id FROM products WHERE asin = 'B0HISTORY1')
    `).all()).toEqual([{ observationDate: '2026-06-30' }]);
  });

  it.each([
    'product|US|legacy-product|2026-06-30|import|sellersprite import: old.csv @ 2026-07-01|30D',
    'product|legacy-product|2026-06-30|import|30D',
  ])('does not append a product snapshot when legacy import identity already exists (%s)', (legacyKey) => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const master = productMasterCsv.replace('B0OWNED001', 'B0LEGACY01').replace('OWN-001', 'LEGACY-01');
    service.confirm(service.preview(Buffer.from(master), { format: 'csv', filename: 'master.csv' }).token);
    const product = database.prepare("SELECT id FROM products WHERE asin = 'B0LEGACY01'").get() as { id: string };
    database.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, price, source, source_type, collected_at, period,
        is_estimated, confidence, observation_date, dedup_key
      ) VALUES ('legacy-snapshot', ?, '2026-06-30', 40, 'SellerSprite import: old.csv',
        'import', '2026-07-01T00:00:00.000Z', '30D', 1, 0.8, '2026-06-30', ?)
    `).run(product.id, legacyKey.replace('legacy-product', product.id));
    const csv = [
      'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date',
      'B0LEGACY01,LEGACY-01,Northstar,Legacy Pillow,legacy-market,Memory Foam,41,4.5,120,1000,280,1,1.2,4.1,8.2,false,0.9,2026-06-30',
    ].join('\n');

    expect(service.preview(Buffer.from(csv), { format: 'csv', filename: 'new.csv', entityType: 'product' }).duplicateCount).toBe(1);
    expect(service.import(Buffer.from(csv), { format: 'csv', filename: 'new.csv', entityType: 'product' }))
      .toMatchObject({ successCount: 1, failureCount: 0 });
    expect(database.prepare('SELECT id, price FROM product_snapshots WHERE product_id = ?').all(product.id))
      .toEqual([{ id: 'legacy-snapshot', price: 40 }]);
  });

  it('does not append a market snapshot when a V19 import for the same observation exists', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    database.prepare(`
      INSERT INTO market_nodes (id, name, level, marketplace, status, source_type, created_at)
      VALUES ('legacy-market', 'Memory Foam', 1, 'US', '等待数据', 'import', '2026-07-01T00:00:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, product_count, monthly_sales, source, source_type,
        collected_at, period, is_estimated, confidence, observation_date, dedup_key
      ) VALUES ('legacy-market-snapshot', 'legacy-market', '2026-06-30', 100, 1000,
        'SellerSprite import: old.csv', 'import', '2026-07-01T00:00:00.000Z',
        '30D', 1, 0.8, '2026-06-30',
        'market|US|legacy-market|2026-06-30|import|sellersprite import: old.csv|30D')
    `).run();
    const csv = [
      'MarketNodeId,Name,ProductCount,SellerCount,BrandCount,MonthlySales,AvgPrice,MedianPrice,AvgRating,MedianReviews,Top10Share,Top20Share,NewProductShare,Confidence,IsEstimated,Date',
      'legacy-market,Memory Foam,100,50,20,1100,30,28,4.2,180,20,35,10,0.9,false,2026-06-30',
    ].join('\n');

    expect(service.import(Buffer.from(csv), { format: 'csv', filename: 'new.csv', entityType: 'market' }))
      .toMatchObject({ successCount: 1, failureCount: 0 });
    expect(database.prepare("SELECT id, monthly_sales FROM market_snapshots WHERE market_node_id = 'legacy-market'").all())
      .toEqual([{ id: 'legacy-market-snapshot', monthly_sales: 1000 }]);
  });

  it('appends distinct authentic import sources on the same date while keeping each source idempotent', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const csv = [
      'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date',
      'B0TWOSOURCE,TWO-001,Northstar,Source Pillow,source-market,Memory Foam,41,4.5,120,1000,280,1,1.2,4.1,8.2,false,0.9,2026-06-30',
    ].join('\n');

    const amazonReport = [
      '(Parent) ASIN,(Child) ASIN,Title,SKU,Units Ordered,Ordered Product Sales',
      'B0PARENT01,B0TWOSOURCE,Source Pillow,TWO-001,280,$11480',
    ].join('\n');
    service.import(Buffer.from(csv), { format: 'csv', filename: 'sellersprite.csv', entityType: 'product' });
    const preview = service.preview(Buffer.from(amazonReport), {
      format: 'csv', filename: 'amazon.csv', sourceType: 'amazon', marketplace: 'US',
      reportStartDate: '2026-06-01', reportEndDate: '2026-06-30',
    });
    service.confirm(preview.token);
    service.import(Buffer.from(csv), { format: 'csv', filename: 'retry.csv', entityType: 'product' });
    const snapshots = database.prepare(`
      SELECT source_type, dedup_key FROM product_snapshots
      WHERE product_id = (SELECT id FROM products WHERE asin = 'B0TWOSOURCE')
      ORDER BY source_type
    `).all() as Array<{ source_type: string; dedup_key: string }>;
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((row) => row.source_type)).toEqual(['amazon', 'import']);
    expect(snapshots.map((row) => row.dedup_key)).toEqual([
      expect.stringMatching(/^product\|us\|.+\|2026-06-30\|source-amazon-import\|2026-06-01\/2026-06-30$/),
      expect.stringMatching(/^product\|us\|.+\|2026-06-30\|source-sellersprite-import\|30d$/),
    ]);
  });

  it('rejects a product snapshot that changes an existing SKU to a new ASIN', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const master = service.preview(Buffer.from(productMasterCsv), { format: 'csv', filename: 'master.csv' });
    service.confirm(master.token);
    const csv = [
      'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date',
      'B0RENAMED,OWN-001,Northstar,Resolved by SKU,identity-market,Identity Market,39.99,4.5,120,1000,280,1,1.2,4.1,8.2,false,0.9,2026-06-30',
    ].join('\n');

    expect(service.import(Buffer.from(csv), { format: 'csv', filename: 'sku-resolution.csv', entityType: 'product' }))
      .toMatchObject({ successCount: 0, failureCount: 1, errors: [expect.stringMatching(/新 ASIN|ASIN 与 SKU/)] });
    expect(database.prepare('SELECT COUNT(*) AS count FROM products').get()).toMatchObject({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get()).toMatchObject({ count: 0 });
  });

  it('rejects product snapshots when ASIN and SKU resolve to different products', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const first = service.preview(Buffer.from(productMasterCsv), { format: 'csv', filename: 'first.csv' });
    service.confirm(first.token);
    const second = productMasterCsv.replaceAll('B0OWNED001', 'B0OTHER001').replaceAll('OWN-001', 'OWN-002');
    service.confirm(service.preview(Buffer.from(second), { format: 'csv', filename: 'second.csv' }).token);
    const csv = [
      'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date',
      'B0OWNED001,OWN-002,Northstar,Conflict,identity-market,Identity Market,39.99,4.5,120,1000,280,1,1.2,4.1,8.2,false,0.9,2026-06-30',
    ].join('\n');

    expect(service.import(Buffer.from(csv), { format: 'csv', filename: 'conflict.csv', entityType: 'product' }))
      .toMatchObject({ successCount: 0, failureCount: 1, errors: [expect.stringMatching(/拒绝合并身份/)] });
  });
});
