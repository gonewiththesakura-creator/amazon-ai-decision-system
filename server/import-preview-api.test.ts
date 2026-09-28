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

const identityAwareProductMasterHeader = [
  'marketplace', 'asin', 'sku', 'internalName', 'brand', 'title', 'productType',
  'parentAsin', 'variationFamilyKey', 'parentLookupStatus', 'variationTheme',
  'marketNode', 'monitoringEnabled', 'status',
].join(',');

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

  it('imports pending siblings into one provisional family with import-batch lineage', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const csv = [
      identityAwareProductMasterHeader,
      'US,B0CHILD101,CHILD-101,Gray Pillow,ELOVNOVA,Gray Contour Pillow,contour pillow,,ELOVNOVA-CONTOUR,pending,Color,Memory Foam,true,active',
      'US,B0CHILD102,CHILD-102,Blue Pillow,ELOVNOVA,Blue Contour Pillow,contour pillow,,elovnova-contour,pending,Color,Memory Foam,true,active',
    ].join('\n');

    const preview = service.preview(Buffer.from(csv), {
      format: 'csv', filename: 'pending-family.csv',
    });
    expect(preview).toMatchObject({
      detectedType: 'owned_product_master', newCount: 2, errorCount: 0,
    });
    expect(preview.mappings).toEqual(expect.arrayContaining([
      { sourceHeader: 'variationfamilykey', targetField: 'variationFamilyKey' },
      { sourceHeader: 'parentlookupstatus', targetField: 'parentLookupStatus' },
    ]));

    const result = service.confirm(preview.token);
    expect(result).toMatchObject({ successCount: 2, failureCount: 0 });
    const products = database.prepare(`
      SELECT asin, variation_family_id AS familyId, parent_asin AS parentAsin,
        parent_lookup_status AS lookupStatus, is_parent AS isParent
      FROM products WHERE asin IN ('B0CHILD101', 'B0CHILD102') ORDER BY asin
    `).all() as Array<Record<string, unknown>>;
    expect(products).toEqual([
      { asin: 'B0CHILD101', familyId: expect.any(String), parentAsin: null,
        lookupStatus: 'pending', isParent: 0 },
      { asin: 'B0CHILD102', familyId: expect.any(String), parentAsin: null,
        lookupStatus: 'pending', isParent: 0 },
    ]);
    expect(products[0]?.familyId).toBe(products[1]?.familyId);
    expect(database.prepare(`
      SELECT family_key AS familyKey, identity_status AS identityStatus,
        source_type AS sourceType, parent_asin AS parentAsin
      FROM variation_families
    `).get()).toEqual({
      familyKey: 'ELOVNOVA-CONTOUR', identityStatus: 'pending',
      sourceType: 'import', parentAsin: null,
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM product_identity_events event
      JOIN import_batches batch ON batch.id = event.import_batch_id
      WHERE batch.id = ?
    `).get(result.batchId)).toEqual({ count: 2 });
  });

  it('keeps pending without a known family distinct and represents standalone explicitly', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const csv = [
      identityAwareProductMasterHeader,
      'US,B0PENDING01,PENDING-1,Pending Pillow,ELOVNOVA,Pending Lumbar Pillow,lumbar pillow,,,pending,,Lumbar,true,active',
      'US,B0STAND001,STAND-1,Standalone Pillow,ELOVNOVA,Standalone Contour Pillow,contour pillow,,,standalone,,Memory Foam,true,active',
    ].join('\n');

    const preview = service.preview(Buffer.from(csv), {
      format: 'csv', filename: 'lookup-statuses.csv',
    });
    expect(preview).toMatchObject({ newCount: 2, errorCount: 0 });
    service.confirm(preview.token);

    expect(database.prepare(`
      SELECT asin, variation_family_id AS familyId, parent_asin AS parentAsin,
        parent_lookup_status AS lookupStatus, is_parent AS isParent
      FROM products WHERE asin IN ('B0PENDING01', 'B0STAND001') ORDER BY asin
    `).all()).toEqual([
      { asin: 'B0PENDING01', familyId: null, parentAsin: null,
        lookupStatus: 'pending', isParent: 0 },
      { asin: 'B0STAND001', familyId: null, parentAsin: null,
        lookupStatus: 'standalone', isParent: 0 },
    ]);
  });

  it.each([
    ['placeholder parent', 'Pending lookup', '', 'verified', /parent ASIN.*占位值|10 位/],
    ['pending status with parent', 'B0PARENT01', 'FAMILY-1', 'pending', /真实 parent ASIN.*verified/],
    ['verified status without parent', '', 'FAMILY-1', 'verified', /真实 parent ASIN|不能标记 verified/],
    ['standalone status with family', '', 'FAMILY-1', 'standalone', /familyKey.*冲突/],
  ])('rejects an invalid Product Master identity combination: %s', (
    _caseName, parentAsin, familyKey, lookupStatus, expected,
  ) => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const csv = [
      identityAwareProductMasterHeader,
      `US,B0INVALID01,INVALID-1,Invalid Pillow,ELOVNOVA,Invalid Pillow,contour pillow,${parentAsin},${familyKey},${lookupStatus},,Memory Foam,true,active`,
    ].join('\n');

    const preview = service.preview(Buffer.from(csv), {
      format: 'csv', filename: 'invalid-identity.csv',
    });
    expect(preview).toMatchObject({ newCount: 0, errorCount: 1 });
    expect(preview.errors[0]).toMatch(expected);
    expect(() => service.confirm(preview.token)).toThrow(/产品主数据.*整批/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM products').get()).toEqual({ count: 0 });
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

    expect(() => service.confirm(preview.token)).toThrow(/产品主数据.*整批/);
    expect(database.prepare('SELECT asin, sku, internal_name FROM products').all()).toEqual([]);
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

  it('treats an unchanged Product Master row as a lineage-preserving no-op', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    service.confirm(service.preview(Buffer.from(productMasterCsv), {
      format: 'csv', filename: 'original-master.csv',
    }).token);
    database.prepare(`
      UPDATE products SET source_type = 'mcp', updated_at = '2026-09-20T00:00:00.000Z'
      WHERE asin = 'B0OWNED001'
    `).run();
    database.prepare(`
      UPDATE variation_families SET updated_at = '2026-09-20T00:00:00.000Z'
      WHERE parent_asin = 'B0PARENT01'
    `).run();

    const preview = service.preview(Buffer.from(productMasterCsv), {
      format: 'csv', filename: 'unchanged-master.csv',
    });
    expect(preview).toMatchObject({ newCount: 0, updateCount: 0, duplicateCount: 1, errorCount: 0 });
    expect(service.confirm(preview.token)).toMatchObject({ successCount: 1, failureCount: 0 });

    expect(database.prepare(`
      SELECT source_type AS sourceType, updated_at AS updatedAt
      FROM products WHERE asin = 'B0OWNED001'
    `).get()).toEqual({ sourceType: 'mcp', updatedAt: '2026-09-20T00:00:00.000Z' });
    expect(database.prepare(`
      SELECT variation_theme AS variationTheme, updated_at AS updatedAt
      FROM variation_families WHERE parent_asin = 'B0PARENT01'
    `).get()).toEqual({ variationTheme: 'SizeName', updatedAt: '2026-09-20T00:00:00.000Z' });
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

  it('rejects confirmation of an error-containing owned master without writing any business rows', async () => {
    database = openDatabase(':memory:');
    const app = createApp({ database });
    const [header, template] = productMasterCsv.split('\n');
    const rows = Array.from({ length: 5 }, (_, index) => template
      .replace('B0OWNED001', `B0MASTER0${index + 1}`)
      .replace('OWN-001', `MASTER-00${index + 1}`)
      .replace('Contour Pillow', `Master Pillow ${index + 1}`));
    rows[4] = rows[4].replace('Northstar,Contour Pillow,memory foam', 'Northstar,,memory foam');
    const preview = await request(app).post('/api/import/preview/csv')
      .attach('file', Buffer.from([header, ...rows].join('\n')), 'owned-product-master.csv')
      .expect(200);

    expect(preview.body.data).toMatchObject({
      entityType: 'owned_product_master', totalCount: 5, newCount: 4, errorCount: 1,
    });
    const confirmed = await request(app).post('/api/import/confirm')
      .send({ token: preview.body.data.token })
      .expect(409);
    expect(confirmed.body.error).toMatch(/产品主数据.*整批/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM products').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM market_nodes').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM variation_families').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM import_batches').get()).toEqual({ count: 0 });
  });

  it('persists an invalid five-row roster declaration without importing products or allowing a smaller replacement', () => {
    database = openDatabase(':memory:');
    const [header, template] = productMasterCsv.split('\n');
    const rows = Array.from({ length: 5 }, (_, index) => template
      .replace('B0OWNED001', `B0MASTER0${index + 1}`)
      .replace('OWN-001', `MASTER-00${index + 1}`));
    rows[4] = rows[4].replace('Northstar,Contour Pillow,memory foam', 'Northstar,,memory foam');
    const service = new ImportService(database);
    const preview = service.preview(Buffer.from([header, ...rows].join('\n')), {
      format: 'csv', filename: 'five-owned.csv',
    });
    expect(preview).toMatchObject({ totalCount: 5, errorCount: 1 });
    expect(database.prepare(`SELECT marketplace, declared_count AS declaredCount,
      expected_count AS expectedCount, status, import_batch_id AS importBatchId
      FROM owned_roster_declarations`).get()).toEqual({
      marketplace: 'US', declaredCount: 5, expectedCount: null,
      status: 'pending_validation', importBatchId: null,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM products').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM import_batches').get()).toEqual({ count: 0 });

    const nextProcess = new ImportService(database);
    expect(() => nextProcess.preview(Buffer.from([header, ...rows.slice(0, 3)].join('\n')), {
      format: 'csv', filename: 'smaller-owned.csv',
    })).toThrow(/roster|声明|范围|缩减|冲突/);
    expect(database.prepare(`SELECT declared_count AS declaredCount, status
      FROM owned_roster_declarations WHERE marketplace = 'US'`).get())
      .toEqual({ declaredCount: 5, status: 'pending_validation' });
    expect(new GoLiveMigrationService(database).verify()).toMatchObject({
      expectedOwnedProducts: 5, ownedRosterDeclarationStatus: 'pending_validation',
      ownedRosterMatches: false, readyForDemoCleanup: false,
    });
  });

  it('rejects a master with missing roster identity without replacing the prior declaration', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    service.preview(Buffer.from(productMasterCsv), { format: 'csv', filename: 'original.csv' });
    const before = database.prepare(`SELECT declared_count AS declaredCount,
      declared_digest AS declaredDigest, preview_digest AS previewDigest, status
      FROM owned_roster_declarations WHERE marketplace = 'US'`).get();
    const missingIdentity = productMasterCsv.replace('B0OWNED001', '');
    expect(() => service.preview(Buffer.from(missingIdentity), {
      format: 'csv', filename: 'missing-asin.csv',
    })).toThrow(/roster|身份|ASIN/i);
    expect(database.prepare(`SELECT declared_count AS declaredCount,
      declared_digest AS declaredDigest, preview_digest AS previewDigest, status
      FROM owned_roster_declarations WHERE marketplace = 'US'`).get()).toEqual(before);
  });

  it.each(['asin', 'sku'])('does not declare an initial roster with a missing %s identity', (field) => {
    database = openDatabase(':memory:');
    const blank = field === 'asin'
      ? productMasterCsv.replace('B0OWNED001', '')
      : productMasterCsv.replace('OWN-001', '');
    expect(() => new ImportService(database!).preview(Buffer.from(blank), {
      format: 'csv', filename: 'missing-identity.csv',
    })).toThrow(/roster|身份|ASIN|SKU/i);
    expect(database.prepare('SELECT COUNT(*) AS count FROM owned_roster_declarations').get())
      .toEqual({ count: 0 });
  });

  it('confirms a corrected same-identity declaration atomically with its complete Product Master', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const [header, template] = productMasterCsv.split('\n');
    const rows = Array.from({ length: 5 }, (_, index) => template
      .replace('B0OWNED001', `B0MASTER0${index + 1}`)
      .replace('OWN-001', `MASTER-00${index + 1}`));
    rows[4] = rows[4].replace('Northstar,Contour Pillow,memory foam', 'Northstar,,memory foam');
    service.preview(Buffer.from([header, ...rows].join('\n')), {
      format: 'csv', filename: 'invalid-five.csv',
    });
    const corrected = rows[4]!.replace('Northstar,,memory foam', 'Northstar,Contour Pillow,memory foam');
    const preview = service.preview(Buffer.from([header, ...rows.slice(0, 4), corrected].join('\n')), {
      format: 'csv', filename: 'corrected-five.csv',
    });
    expect(preview.errorCount).toBe(0);
    const result = service.confirm(preview.token);
    expect(result).toMatchObject({ successCount: 5, failureCount: 0 });
    expect(database.prepare(`SELECT declared_count AS declaredCount,
      LENGTH(declared_digest) AS declaredDigestLength, expected_count AS expectedCount,
      LENGTH(expected_digest) AS expectedDigestLength, status, import_batch_id AS importBatchId
      FROM owned_roster_declarations WHERE marketplace = 'US'`).get()).toEqual({
      declaredCount: 5, declaredDigestLength: 64, expectedCount: 5,
      expectedDigestLength: 64, status: 'confirmed', importBatchId: result.batchId,
    });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM products
      WHERE is_owned = 1 AND is_parent = 0 AND status = 'active' AND source_type <> 'mock'`).get())
      .toEqual({ count: 5 });
  });

  it('rejects confirmation when an active owned SKU is omitted from a superseding roster', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    service.confirm(service.preview(Buffer.from(productMasterCsv), {
      format: 'csv', filename: 'original.csv',
    }).token);
    const current = database.prepare(`SELECT preview_digest AS previewDigest
      FROM owned_roster_declarations WHERE marketplace = 'US'`).get() as { previewDigest: string };
    const replacement = productMasterCsv
      .replace('B0OWNED001', 'B0OWNED002')
      .replace('OWN-001', 'OWN-002');
    const preview = service.preview(Buffer.from(replacement), {
      format: 'csv', filename: 'replacement.csv',
      supersedesRosterDigest: current.previewDigest,
    });

    expect(() => service.confirm(preview.token)).toThrow(/active|活跃|文件|roster/i);
    expect(database.prepare(`SELECT asin, status FROM products ORDER BY asin`).all())
      .toEqual([{ asin: 'B0OWNED001', status: 'active' }]);
    expect(database.prepare(`SELECT declared_digest AS declaredDigest, status
      FROM owned_roster_declarations WHERE marketplace = 'US'`).get())
      .toMatchObject({ status: 'pending_validation' });
  });

  it('confirms an explicit CAS roster supersede when omitted active SKUs are declared inactive', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    service.confirm(service.preview(Buffer.from(productMasterCsv), {
      format: 'csv', filename: 'original.csv',
    }).token);
    const current = database.prepare(`SELECT preview_digest AS previewDigest
      FROM owned_roster_declarations WHERE marketplace = 'US'`).get() as { previewDigest: string };
    const [header, originalRow] = productMasterCsv.split('\n');
    const inactiveRow = originalRow.replace(',true,active', ',false,inactive');
    const newRow = originalRow
      .replace('B0OWNED001', 'B0OWNED002')
      .replace('OWN-001', 'OWN-002')
      .replace('Contour Pillow', 'Replacement Pillow');
    const preview = service.preview(Buffer.from([header, inactiveRow, newRow].join('\n')), {
      format: 'csv', filename: 'reviewed-replacement.csv',
      supersedesRosterDigest: current.previewDigest,
    });
    const result = service.confirm(preview.token);

    expect(result).toMatchObject({ successCount: 2, failureCount: 0 });
    expect(database.prepare(`SELECT asin, status FROM products ORDER BY asin`).all()).toEqual([
      { asin: 'B0OWNED001', status: 'inactive' },
      { asin: 'B0OWNED002', status: 'active' },
    ]);
    expect(database.prepare(`SELECT declared_count AS declaredCount,
      expected_count AS expectedCount, status FROM owned_roster_declarations
      WHERE marketplace = 'US'`).get()).toEqual({
      declaredCount: 2, expectedCount: 1, status: 'confirmed',
    });
    expect(database.prepare(`SELECT event_type AS eventType
      FROM owned_roster_declaration_events ORDER BY rowid`).all()).toEqual([
      { eventType: 'declared' }, { eventType: 'confirmed' },
      { eventType: 'superseded' }, { eventType: 'confirmed' },
    ]);
  });

  it('rejects a cross-market master before changing the current roster declaration', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    service.confirm(service.preview(Buffer.from(productMasterCsv), {
      format: 'csv', filename: 'original.csv',
    }).token);
    const before = database.prepare(`SELECT * FROM owned_roster_declarations
      WHERE marketplace = 'US'`).get();

    expect(() => service.preview(Buffer.from(productMasterCsv.replace('US,', 'CA,')), {
      format: 'csv', filename: 'wrong-market.csv',
    })).toThrow(/站点|marketplace|工作区/i);
    expect(database.prepare(`SELECT * FROM owned_roster_declarations
      WHERE marketplace = 'US'`).get()).toEqual(before);
  });

  it('requires a current declaration preview digest for every explicit CAS refresh', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    service.preview(Buffer.from(productMasterCsv), { format: 'csv', filename: 'first.csv' });
    const first = database.prepare(`SELECT preview_digest AS previewDigest
      FROM owned_roster_declarations WHERE marketplace = 'US'`).get() as { previewDigest: string };
    const corrected = productMasterCsv.replace('Contour Pillow,Northstar', 'Reviewed Pillow,Northstar');
    service.preview(Buffer.from(corrected), {
      format: 'csv', filename: 'corrected.csv', supersedesRosterDigest: first.previewDigest,
    });
    const current = database.prepare(`SELECT preview_digest AS previewDigest
      FROM owned_roster_declarations WHERE marketplace = 'US'`).get() as { previewDigest: string };
    expect(current.previewDigest).not.toBe(first.previewDigest);

    expect(() => service.preview(Buffer.from(productMasterCsv), {
      format: 'csv', filename: 'stale.csv', supersedesRosterDigest: first.previewDigest,
    })).toThrow(/过期|陈旧|最新|digest|版本/i);
    expect(database.prepare(`SELECT preview_digest AS previewDigest
      FROM owned_roster_declarations WHERE marketplace = 'US'`).get()).toEqual(current);
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

  it.each([
    ['ASIN', productMasterCsv.replace('B0OWNED001', 'B0DEMO0001')],
    ['SKU', productMasterCsv.replace('OWN-001', 'MF-ERG-01')],
  ])('rejects a real Product Master that collides with a Demo %s', (_identity, csv) => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    const service = new ImportService(database);
    const original = database.prepare(`
      SELECT id, asin, sku, source_type AS sourceType, market_node_id AS marketNodeId
      FROM products WHERE id = 'owned-sku-01'
    `).get();
    const preview = service.preview(Buffer.from(csv), {
      format: 'csv', filename: 'demo-collision.csv',
    });
    expect(preview).toMatchObject({ newCount: 0, errorCount: 1 });
    expect(preview.errors[0]).toMatch(/Demo|Mock/);
    expect(() => service.confirm(preview.token)).toThrow(/产品主数据.*整批/);
    expect(database.prepare(`
      SELECT id, asin, sku, source_type AS sourceType, market_node_id AS marketNodeId
      FROM products WHERE id = 'owned-sku-01'
    `).get()).toEqual(original);
    expect(database.prepare('SELECT COUNT(*) AS count FROM import_batches').get())
      .toEqual({ count: 0 });
  });

  it('rejects real history written against a Demo product identity', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    const service = new ImportService(database);
    const before = database.prepare(`SELECT COUNT(*) AS count
      FROM product_snapshots WHERE product_id = 'owned-sku-01'`).get();
    const csv = [
      'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date',
      'B0DEMO0001,MF-ERG-01,Nuvora,Real Pillow,,Memory Foam Pillow,39.99,4.5,120,1000,280,1,1.2,4.1,8.2,false,0.9,2026-06-30',
    ].join('\n');
    const preview = service.preview(Buffer.from(csv), {
      format: 'csv', filename: 'demo-history.csv', entityType: 'product',
    });
    expect(preview).toMatchObject({ newCount: 0, errorCount: 1 });
    expect(preview.errors[0]).toMatch(/Demo|Mock/);
    expect(service.confirm(preview.token)).toMatchObject({ successCount: 0, failureCount: 1 });
    expect(database.prepare(`SELECT COUNT(*) AS count
      FROM product_snapshots WHERE product_id = 'owned-sku-01'`).get()).toEqual(before);
  });

  it('keeps a same-name real market node separate from the retained Demo node', () => {
    database = openDatabase(':memory:');
    seedDemoData(database);
    const service = new ImportService(database);
    const sameNameMaster = productMasterCsv
      .replace('Memory Foam,true,active', 'Memory Foam Pillow,true,active');
    const [header, firstRow] = sameNameMaster.split('\n');
    const secondRow = firstRow
      .replace('B0OWNED001', 'B0OWNED002')
      .replace('OWN-001', 'OWN-002')
      .replace('Contour Pillow,Northstar', 'Second Pillow,Northstar');

    expect(service.confirm(service.preview(Buffer.from([header, firstRow, secondRow].join('\n')), {
      format: 'csv', filename: 'same-name-real-master.csv',
    }).token)).toMatchObject({ successCount: 2, failureCount: 0 });

    const imported = database.prepare(`
      SELECT product.market_node_id AS marketNodeId, market.source_type AS sourceType
      FROM products product
      JOIN market_nodes market ON market.id = product.market_node_id
      WHERE product.asin = 'B0OWNED001'
    `).get() as { marketNodeId: string; sourceType: string };
    expect(imported).toMatchObject({ sourceType: 'import' });
    expect(imported.marketNodeId).not.toBe('mkt-memory-foam');
    expect(database.prepare(`
      SELECT source_type AS sourceType FROM market_nodes WHERE id = 'mkt-memory-foam'
    `).get()).toEqual({ sourceType: 'mock' });

    expect(database.prepare(`
      SELECT COUNT(DISTINCT market_node_id) AS count FROM products
      WHERE asin IN ('B0OWNED001', 'B0OWNED002')
    `).get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM market_nodes
      WHERE name = 'Memory Foam Pillow' AND source_type <> 'mock'
    `).get()).toEqual({ count: 1 });
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

  it('rejects conflicting master identities during preview', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const first = service.preview(Buffer.from(productMasterCsv), { format: 'csv', filename: 'first.csv' });
    service.confirm(first.token);
    database.prepare(`DELETE FROM owned_roster_declarations WHERE marketplace = 'US'`).run();
    const rekeyedAsin = productMasterCsv.replace('B0OWNED001', 'B0OWNED999');
    const conflicting = service.preview(Buffer.from(rekeyedAsin), { format: 'csv', filename: 'sku-conflict.csv' });
    expect(conflicting).toMatchObject({ duplicateCount: 0, errorCount: 1 });
    expect(conflicting.errors[0]).toMatch(/新 ASIN/);
  });

  it('revalidates an owned master at confirmation and rolls back the whole batch when identity state changed', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const [header, firstRow] = productMasterCsv.split('\n');
    const secondRow = firstRow
      .replace('B0OWNED001', 'B0OWNED002')
      .replace('OWN-001', 'OWN-002')
      .replace('Contour Pillow', 'Second Pillow');
    const staged = service.preview(Buffer.from([header, firstRow, secondRow].join('\n')), {
      format: 'csv', filename: 'staged-master.csv',
    });
    expect(staged).toMatchObject({ totalCount: 2, newCount: 2, errorCount: 0 });

    database.exec(`
      INSERT INTO market_nodes (
        id, name, level, marketplace, status, source_type, created_at
      ) VALUES ('collision-market', 'Collision market', 1, 'US', 'active', 'import', '2026-09-22');
      INSERT INTO products (
        id, asin, sku, brand, title, image_url, marketplace, product_type,
        is_owned, market_node_id, source_type, created_at
      ) VALUES ('collision-product', 'B0COLLIDE1', 'OWN-002', 'Northstar',
        'Collision Pillow', '', 'US', 'memory_foam_pillow', 1,
        'collision-market', 'import', '2026-09-22');
    `);

    expect(() => service.confirm(staged.token)).toThrow(/产品主数据.*整批/);
    expect(database.prepare('SELECT asin, sku FROM products ORDER BY asin').all()).toEqual([
      { asin: 'B0COLLIDE1', sku: 'OWN-002' },
    ]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM import_batches').get()).toEqual({ count: 0 });
  });

  it('rejects a staged new Product Master when the exact identity was created after preview', () => {
    database = openDatabase(':memory:');
    const stagedService = new ImportService(database);
    const staged = stagedService.preview(Buffer.from(productMasterCsv), {
      format: 'csv', filename: 'staged-new-master.csv',
    });
    expect(staged).toMatchObject({ newCount: 1, updateCount: 0, errorCount: 0 });

    const concurrentService = new ImportService(database);
    concurrentService.confirm(concurrentService.preview(Buffer.from(productMasterCsv), {
      format: 'csv', filename: 'concurrent-master.csv',
    }).token);

    expect(() => stagedService.confirm(staged.token))
      .toThrow(/声明.*预览|发生变化.*重新预览|重新预览.*发生变化/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM products').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM import_batches').get()).toEqual({ count: 1 });
  });

  it('rejects a staged Product Master update when the existing master changed after preview', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    service.confirm(service.preview(Buffer.from(productMasterCsv), {
      format: 'csv', filename: 'baseline-master.csv',
    }).token);
    const revised = productMasterCsv.replace('Contour Pillow,Northstar', 'Reviewed Pillow,Northstar');
    const staged = service.preview(Buffer.from(revised), {
      format: 'csv', filename: 'staged-update-master.csv',
    });
    expect(staged).toMatchObject({ newCount: 0, updateCount: 1, errorCount: 0 });

    database.prepare(`
      UPDATE products SET internal_name = 'Concurrent owner edit',
        updated_at = '2026-09-21T01:00:00.000Z'
      WHERE asin = 'B0OWNED001'
    `).run();

    expect(() => service.confirm(staged.token)).toThrow(/发生变化.*重新预览|重新预览.*发生变化/);
    expect(database.prepare(`SELECT internal_name AS internalName FROM products WHERE asin = 'B0OWNED001'`).get())
      .toEqual({ internalName: 'Concurrent owner edit' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM import_batches').get()).toEqual({ count: 1 });
  });

  it('keeps partial confirmation for ordinary historical imports', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const valid = [
      'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date',
      'B0PARTIAL1,PARTIAL-1,Northstar,Partial Pillow,partial-market,Partial Market,39.99,4.5,120,1000,280,1,1.2,4.1,8.2,false,0.9,2026-06-30',
    ];
    const preview = service.preview(Buffer.from([...valid, 'B0INVALID1'].join('\n')), {
      format: 'csv', filename: 'partial-history.csv', entityType: 'product',
    });
    expect(preview).toMatchObject({ totalCount: 2, newCount: 1, errorCount: 1 });

    expect(service.confirm(preview.token)).toMatchObject({ successCount: 1, failureCount: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get()).toEqual({ count: 1 });
  });

  it('rejects history for an inactive owned SKU without changing product lineage or writing a snapshot', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const inactiveMaster = productMasterCsv.replace('Memory Foam,true,active', 'Memory Foam,false,inactive');
    service.confirm(service.preview(Buffer.from(inactiveMaster), {
      format: 'csv', filename: 'inactive-master.csv',
    }).token);
    database.prepare("UPDATE products SET source_type = 'mcp' WHERE asin = 'B0OWNED001'").run();
    const csv = [
      'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date',
      'B0OWNED001,OWN-001,Northstar,Inactive Pillow,inactive-market,Inactive Market,39.99,4.5,120,1000,280,1,1.2,4.1,8.2,false,0.9,2026-06-30',
    ].join('\n');

    const preview = service.preview(Buffer.from(csv), {
      format: 'csv', filename: 'inactive-history.csv', entityType: 'product',
    });
    expect(preview).toMatchObject({ newCount: 0, duplicateCount: 0, errorCount: 1 });
    expect(preview.errors[0]).toMatch(/停用.*Product Master.*重新激活/);
    expect(service.confirm(preview.token)).toMatchObject({
      successCount: 0, failureCount: 1, errors: [expect.stringMatching(/停用.*Product Master.*重新激活/)],
    });
    expect(database.prepare(`
      SELECT status, source_type AS sourceType FROM products WHERE asin = 'B0OWNED001'
    `).get()).toEqual({ status: 'inactive', sourceType: 'mcp' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT status, success, failed FROM data_tasks ORDER BY rowid DESC LIMIT 1
    `).get()).toEqual({ status: 'failed', success: 0, failed: 1 });
  });

  it('finishes a competitor history import without post-commit analysis of an inactive relation owner', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const inactiveMaster = productMasterCsv.replace('Memory Foam,true,active', 'Memory Foam,false,inactive');
    service.confirm(service.preview(Buffer.from(inactiveMaster), {
      format: 'csv', filename: 'inactive-master.csv',
    }).token);
    const header = 'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date';
    const first = 'B0RIVAL001,,Rival,Rival Pillow,,Memory Foam,29.99,4.3,80,900,210,2,1,3,6,true,0.8,2026-05-31';
    expect(service.import(Buffer.from([header, first].join('\n')), {
      format: 'csv', filename: 'competitor-first.csv', entityType: 'product',
    })).toMatchObject({ successCount: 1, failureCount: 0 });
    const owner = database.prepare("SELECT id FROM products WHERE asin = 'B0OWNED001'").get() as { id: string };
    const competitor = database.prepare("SELECT id FROM products WHERE asin = 'B0RIVAL001'").get() as { id: string };
    database.prepare(`
      INSERT INTO competitor_relations (
        id, owned_product_id, competitor_product_id, relation_type, similarity_score,
        reason, ai_tags_json
      ) VALUES ('inactive-owner-rival', ?, ?, 'direct', 90, 'shared competitor', '[]')
    `).run(owner.id, competitor.id);
    const second = first.replace('2026-05-31', '2026-06-30').replace(',210,', ',220,');

    expect(service.import(Buffer.from([header, second].join('\n')), {
      format: 'csv', filename: 'competitor-second.csv', entityType: 'product',
    })).toMatchObject({ successCount: 1, failureCount: 0 });
    expect(database.prepare(`
      SELECT status, success, failed FROM data_tasks ORDER BY rowid DESC LIMIT 1
    `).get()).toEqual({ status: 'success', success: 1, failed: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE product_id = ?
    `).get(competitor.id)).toEqual({ count: 2 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM ai_insights
      WHERE entity_type = 'owned_product' AND entity_id = ?
    `).get(owner.id)).toEqual({ count: 0 });
  });

  it('rejects every row in an invalid owned master instead of importing its valid subset', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const mixed = `${productMasterCsv}\nUS,B0BAD001,BAD-001,,Northstar,Bad Pillow,memory foam,,,Memory Foam,true,active`;
    const preview = service.preview(Buffer.from(mixed), { format: 'csv', filename: 'mixed.csv' });
    expect(preview).toMatchObject({ totalCount: 2, newCount: 1, errorCount: 1 });
    expect(() => service.confirm(preview.token)).toThrow(/产品主数据.*整批/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM products').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM import_batches').get()).toEqual({ count: 0 });
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

  it('never lets a historical product import rewrite an existing Product Master', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    service.confirm(service.preview(Buffer.from(productMasterCsv), {
      format: 'csv', filename: 'owned-master.csv',
    }).token);
    const original = database.prepare(`
      SELECT id, market_node_id AS marketNodeId FROM products WHERE asin = 'B0OWNED001'
    `).get() as { id: string; marketNodeId: string };
    database.prepare(`
      UPDATE products SET source_type = 'mcp', updated_at = '2026-09-20T00:00:00.000Z'
      WHERE id = ?
    `).run(original.id);
    const csv = [
      'ASIN,SKU,InternalName,Brand,Title,ProductType,MarketNodeId,MarketName,IsOwned,MonitoringEnabled,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date',
      'B0OWNED001,OWN-001,Injected Name,Injected Brand,Injected Title,competitor,other-market,Other Market,false,false,39.99,4.5,120,1000,280,1,1.2,4.1,8.2,false,0.9,2026-06-30',
    ].join('\n');

    const first = service.import(Buffer.from(csv), {
      format: 'csv', filename: 'history-with-metadata.csv', entityType: 'product',
    });
    expect(first).toMatchObject({ successCount: 1, failureCount: 0 });
    expect(service.import(Buffer.from(csv), {
      format: 'csv', filename: 'history-with-metadata.csv', entityType: 'product',
    })).toMatchObject({ successCount: 1, failureCount: 0 });

    expect(database.prepare(`
      SELECT sku, internal_name AS internalName, brand, title, product_type AS productType,
        is_owned AS isOwned, market_node_id AS marketNodeId, monitoring_enabled AS monitoringEnabled,
        source_type AS sourceType, updated_at AS updatedAt
      FROM products WHERE id = ?
    `).get(original.id)).toEqual({
      sku: 'OWN-001', internalName: 'Contour Pillow', brand: 'Northstar', title: 'Contour Pillow',
      productType: 'memory foam', isOwned: 1, marketNodeId: original.marketNodeId,
      monitoringEnabled: 1, sourceType: 'mcp', updatedAt: '2026-09-20T00:00:00.000Z',
    });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM market_nodes WHERE id = 'other-market'`).get())
      .toEqual({ count: 0 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM product_snapshots WHERE product_id = ?`).get(original.id))
      .toEqual({ count: 1 });
  });

  it('keeps a committed import idempotent when post-import analysis fails', () => {
    database = openDatabase(':memory:');
    database.exec(`
      CREATE TRIGGER fail_post_import_analysis
      BEFORE INSERT ON ai_insights
      BEGIN
        SELECT RAISE(ABORT, 'SELLERSPRITE_MCP_SECRET=must-not-be-persisted');
      END;
    `);
    const service = new ImportService(database);
    const csv = [
      'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date',
      'B0POSTFAIL,POST-FAIL,Northstar,Post-process Pillow,post-market,Post Market,39.99,4.5,120,1000,280,1,1.2,4.1,8.2,false,0.9,2026-06-30',
    ].join('\n');
    const preview = service.preview(Buffer.from(csv), {
      format: 'csv', filename: 'post-process.csv', entityType: 'product',
    });

    const first = service.confirm(preview.token);
    expect(first).toMatchObject({ successCount: 1, failureCount: 0 });
    expect(service.confirm(preview.token)).toEqual(first);
    expect(database.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM import_batches').get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT task_type AS taskType, status, target, error_log AS errorLog
      FROM data_tasks WHERE task_type = 'post_import_analysis'
    `).all()).toEqual([{
      taskType: 'post_import_analysis', status: 'failed', target: first.batchId,
      errorLog: '导入已提交；导入后分析失败，需单独重试分析。',
    }]);
    expect(JSON.stringify(database.prepare(`
      SELECT * FROM data_tasks WHERE task_type = 'post_import_analysis'
    `).all())).not.toContain('must-not-be-persisted');
  });

  it('keeps a committed import successful when post-import failure auditing also fails', () => {
    database = openDatabase(':memory:');
    database.exec(`
      CREATE TRIGGER fail_post_import_analysis
      BEFORE INSERT ON ai_insights
      BEGIN
        SELECT RAISE(ABORT, 'forced post-import analysis failure');
      END;
      CREATE TRIGGER fail_post_import_failure_audit
      BEFORE INSERT ON data_tasks
      WHEN NEW.task_type = 'post_import_analysis'
      BEGIN
        SELECT RAISE(ABORT, 'forced post-import audit failure');
      END;
    `);
    const service = new ImportService(database);
    const csv = [
      'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date',
      'B0AUDITFAIL,AUDIT-FAIL,Northstar,Audit Failure Pillow,audit-market,Audit Market,39.99,4.5,120,1000,280,1,1.2,4.1,8.2,false,0.9,2026-06-30',
    ].join('\n');
    const preview = service.preview(Buffer.from(csv), {
      format: 'csv', filename: 'post-process-audit-failure.csv', entityType: 'product',
    });

    const first = service.confirm(preview.token);
    expect(first).toMatchObject({ successCount: 1, failureCount: 0 });
    expect(service.confirm(preview.token)).toEqual(first);
    expect(database.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM import_batches').get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM data_tasks WHERE task_type = 'post_import_analysis'
    `).get()).toEqual({ count: 0 });
  });

  it('classifies an identical observation repeated in the same file as one new row and one duplicate', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const header = 'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date';
    const row = 'B0INFILE01,INFILE-1,Northstar,In-file Pillow,in-file-market,In-file Market,39.99,4.5,120,1000,280,1,1.2,4.1,8.2,false,0.9,2026-06-30';
    const preview = service.preview(Buffer.from([header, row, row].join('\n')), {
      format: 'csv', filename: 'same-observation.csv', entityType: 'product',
    });

    expect(preview).toMatchObject({ totalCount: 2, newCount: 1, duplicateCount: 1, errorCount: 0 });
    expect(service.confirm(preview.token)).toMatchObject({ successCount: 2, failureCount: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM product_snapshots').get()).toEqual({ count: 1 });
  });

  it('reports changed values for the same observation inside one file and keeps the first row', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const header = 'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date';
    const first = 'B0INFILE02,INFILE-2,Northstar,In-file Pillow,in-file-market,In-file Market,39.99,4.5,120,1000,280,1,1.2,4.1,8.2,false,0.9,2026-06-30';
    const changed = first.replace(',39.99,', ',41,');
    const preview = service.preview(Buffer.from([header, first, changed].join('\n')), {
      format: 'csv', filename: 'conflicting-observation.csv', entityType: 'product',
    });

    expect(preview).toMatchObject({ totalCount: 2, newCount: 1, duplicateCount: 0, errorCount: 1 });
    expect(preview.errors[0]).toMatch(/第 3 行.*第 2 行.*冲突/);
    expect(service.confirm(preview.token)).toMatchObject({ successCount: 1, failureCount: 1 });
    expect(database.prepare('SELECT price FROM product_snapshots').all()).toEqual([{ price: 39.99 }]);
  });

  it.each([
    ['growth90d', ',8.2,false,0.9,', ',8.3,false,0.9,'],
    ['isEstimated', ',8.2,false,0.9,', ',8.2,true,0.9,'],
    ['confidence', ',8.2,false,0.9,', ',8.2,false,0.8,'],
  ])('treats a changed %s value as a snapshot conflict', (_field, before, after) => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const header = 'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date';
    const row = 'B0FULLCMP1,FULL-CMP-1,Northstar,Compared Pillow,compare-market,Compare Market,39.99,4.5,120,1000,280,1,1.2,4.1,8.2,false,0.9,2026-06-30';
    service.import(Buffer.from([header, row].join('\n')), {
      format: 'csv', filename: 'baseline.csv', entityType: 'product',
    });

    const changed = row.replace(before, after);
    const preview = service.preview(Buffer.from([header, changed].join('\n')), {
      format: 'csv', filename: 'changed.csv', entityType: 'product',
    });
    expect(preview).toMatchObject({ newCount: 0, duplicateCount: 0, errorCount: 1 });
    expect(preview.errors[0]).toMatch(new RegExp(`${_field}.*冲突|冲突.*${_field}`));
  });

  it('rechecks snapshot values at confirmation when the database changed after preview', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const header = 'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date';
    const candidate = 'B0CONFIRM1,CONFIRM-1,Northstar,Confirm Pillow,confirm-market,Confirm Market,41,4.5,120,1000,280,1,1.2,4.1,8.2,false,0.9,2026-06-30';
    const preview = service.preview(Buffer.from([header, candidate].join('\n')), {
      format: 'csv', filename: 'staged-history.csv', entityType: 'product',
    });
    expect(preview).toMatchObject({ newCount: 1, duplicateCount: 0, errorCount: 0 });

    const competing = candidate.replace(',41,', ',40,');
    expect(service.import(Buffer.from([header, competing].join('\n')), {
      format: 'csv', filename: 'competing-history.csv', entityType: 'product',
    })).toMatchObject({ successCount: 1, failureCount: 0 });

    expect(service.confirm(preview.token)).toMatchObject({
      successCount: 0, failureCount: 1, errors: [expect.stringMatching(/price.*冲突|冲突.*price/)],
    });
    expect(database.prepare(`
      SELECT price FROM product_snapshots
      WHERE product_id = (SELECT id FROM products WHERE asin = 'B0CONFIRM1')
    `).all()).toEqual([{ price: 40 }]);
  });

  it('classifies same-file market observations by normalized values', () => {
    database = openDatabase(':memory:');
    const service = new ImportService(database);
    const header = 'MarketNodeId,Name,ProductCount,SellerCount,BrandCount,MonthlySales,AvgPrice,MedianPrice,AvgRating,MedianReviews,Top10Share,Top20Share,NewProductShare,Confidence,IsEstimated,Date';
    const row = 'same-file-market,Same File Market,100,50,20,1000,30,28,4.2,180,20,35,10,0.9,false,2026-06-30';
    const identical = service.preview(Buffer.from([header, row, row].join('\n')), {
      format: 'csv', filename: 'identical-markets.csv', entityType: 'market',
    });
    expect(identical).toMatchObject({ totalCount: 2, newCount: 1, duplicateCount: 1, errorCount: 0 });

    const changed = service.preview(Buffer.from([header, row, row.replace(',1000,', ',1100,')].join('\n')), {
      format: 'csv', filename: 'conflicting-markets.csv', entityType: 'market',
    });
    expect(changed).toMatchObject({ totalCount: 2, newCount: 1, duplicateCount: 0, errorCount: 1 });
    expect(changed.errors[0]).toMatch(/第 3 行.*第 2 行.*monthlySales.*冲突|第 3 行.*第 2 行.*冲突.*monthlySales/);
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

    const preview = service.preview(Buffer.from(csv), { format: 'csv', filename: 'new.csv', entityType: 'product' });
    expect(preview).toMatchObject({ newCount: 0, duplicateCount: 0, errorCount: 1 });
    expect(preview.errors[0]).toMatch(/冲突/);
    expect(service.import(Buffer.from(csv), { format: 'csv', filename: 'new.csv', entityType: 'product' }))
      .toMatchObject({ successCount: 0, failureCount: 1, errors: [expect.stringMatching(/冲突/)] });
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

    const preview = service.preview(Buffer.from(csv), { format: 'csv', filename: 'new.csv', entityType: 'market' });
    expect(preview).toMatchObject({ newCount: 0, duplicateCount: 0, errorCount: 1 });
    expect(preview.errors[0]).toMatch(/冲突/);
    expect(service.import(Buffer.from(csv), { format: 'csv', filename: 'new.csv', entityType: 'market' }))
      .toMatchObject({ successCount: 0, failureCount: 1, errors: [expect.stringMatching(/冲突/)] });
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
    const [header, firstRow] = productMasterCsv.split('\n');
    const secondRow = firstRow.replaceAll('B0OWNED001', 'B0OTHER001').replaceAll('OWN-001', 'OWN-002');
    service.confirm(service.preview(Buffer.from([header, firstRow, secondRow].join('\n')), {
      format: 'csv', filename: 'two-product-master.csv',
    }).token);
    const csv = [
      'ASIN,SKU,Brand,Title,MarketNodeId,MarketName,Price,Rating,ReviewCount,BSR,EstimatedSales,SellerCount,Growth7D,Growth30D,Growth90D,IsEstimated,Confidence,Date',
      'B0OWNED001,OWN-002,Northstar,Conflict,identity-market,Identity Market,39.99,4.5,120,1000,280,1,1.2,4.1,8.2,false,0.9,2026-06-30',
    ].join('\n');

    expect(service.import(Buffer.from(csv), { format: 'csv', filename: 'conflict.csv', entityType: 'product' }))
      .toMatchObject({ successCount: 0, failureCount: 1, errors: [expect.stringMatching(/拒绝合并身份/)] });
  });
});
