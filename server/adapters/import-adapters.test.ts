import * as XLSX from 'xlsx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { ImportService } from '../services/import-service.js';
import { AmazonImportAdapter, SellerSpriteImportAdapter } from './import-adapters.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe('file import adapters', () => {
  it('ingests and normalizes review CSV before persistence', () => {
    const adapter = new SellerSpriteImportAdapter();
    const batch = adapter.ingest({
      buffer: Buffer.from('Review ID,Product_ID,Review Text\nr-1,p-1,Too firm'),
      format: 'csv', filename: 'reviews.csv', entityType: 'review',
    });
    expect(batch).toMatchObject({ entityType: 'review', rowCount: 1 });
    expect(batch.rows[0]).toEqual({
      rowNumber: 2,
      values: { reviewid: 'r-1', productid: 'p-1', reviewtext: 'Too firm' },
    });
  });

  it('uses the Amazon adapter for XLSX ingestion', () => {
    const adapter = new AmazonImportAdapter();
    const worksheet = XLSX.utils.json_to_sheet([{ MarketName: 'Travel Pillow', MonthlySales: 1200 }]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Market');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const batch = adapter.ingest({ buffer, format: 'xlsx', filename: 'market.xlsx', entityType: 'market' });
    expect(batch.entityType).toBe('market');
    expect(batch.rows[0]?.values).toMatchObject({ marketname: 'Travel Pillow', monthlysales: '1200' });
  });

  it('recognizes only a child-ASIN Amazon Sales and Traffic report signature', () => {
    const adapter = new AmazonImportAdapter();
    const report = adapter.ingest({
      buffer: Buffer.from([
        '(Parent) ASIN,(Child) ASIN,Title,SKU,Units Ordered,Ordered Product Sales,Sessions - Total',
        'B0PARENT01,B0ACTUAL01,Contour Pillow,PILLOW-01,132,"$1,299.50",803',
      ].join('\n')),
      format: 'csv', filename: 'sales-and-traffic-by-child-item.csv',
    });
    expect(report).toMatchObject({ entityType: 'product', detectedType: 'amazon_business_report', rowCount: 1 });
    expect(report.rows[0]?.values).toMatchObject({
      parentasin: 'B0PARENT01', childasin: 'B0ACTUAL01', sku: 'PILLOW-01',
      unitsordered: '132', orderedproductsales: '$1,299.50',
    });

    const generic = adapter.ingest({
      buffer: Buffer.from('ASIN,Order Date\nB0ACTUAL01,2026-06-30'),
      format: 'csv', filename: 'generic-orders.csv',
    });
    expect(generic.detectedType).toBe('unknown');
  });

  it('detects the reviewed owned product master header independently of data rows', () => {
    const adapter = new SellerSpriteImportAdapter();
    const batch = adapter.ingest({
      buffer: Buffer.from([
        'marketplace,asin,sku,internalName,brand,title,productType,parentAsin,variationTheme,marketNode,monitoringEnabled,status',
        'US,B0OWNED001,OWN-001,Contour Pillow,Northstar,Contour Pillow,memory foam,,,Memory Foam,true,active',
      ].join('\n')),
      format: 'csv', filename: 'owned-product-master.csv',
    });

    expect(batch.entityType).toBe('owned_product_master');
  });

  it('preserves UTF-8 Chinese text in CSV rows', () => {
    const adapter = new SellerSpriteImportAdapter();
    const batch = adapter.ingest({
      buffer: Buffer.from([
        'marketplace,asin,sku,internalName,brand,title,productType,parentAsin,variationTheme,marketNode,monitoringEnabled,status',
        'US,B0CHINESE001,SKU-中文,刘总枕头,ELOVNOVA,颈椎记忆棉枕头,人体工学枕,,,,true,active',
      ].join('\n'), 'utf8'),
      format: 'csv', filename: 'utf8-owned-products.csv', entityType: 'owned_product_master',
    });

    expect(batch.rows[0]?.values).toMatchObject({
      sku: 'SKU-中文',
      internalname: '刘总枕头',
      title: '颈椎记忆棉枕头',
      producttype: '人体工学枕',
    });
  });

  it('preserves UTF-8 BOM CSV headers, separator directives, and Chinese text', () => {
    const adapter = new SellerSpriteImportAdapter();
    const csv = [
      'sep=;',
      '"marketplace";"asin";"sku";"internalName";"brand";"title";"productType";"parentAsin";"variationTheme";"marketNode";"monitoringEnabled";"status"',
      '"US";"B0CHINESE02";"SKU-中文";"刘总枕头";"ELOVNOVA";"颈椎记忆棉枕头";"人体工学枕";;;"颈椎枕";"true";"active"',
    ].join('\r\n');
    const batch = adapter.ingest({
      buffer: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv, 'utf8')]),
      format: 'csv', filename: 'utf8-bom-owned-products.csv',
    });

    expect(batch.entityType).toBe('owned_product_master');
    expect(batch.rows[0]?.values).toMatchObject({
      marketplace: 'US', sku: 'SKU-中文', internalname: '刘总枕头', title: '颈椎记忆棉枕头',
    });
  });

  it('preserves UTF-16LE BOM CSV support', () => {
    const adapter = new SellerSpriteImportAdapter();
    const csv = [
      'marketplace,asin,sku,internalName,brand,title,productType,parentAsin,variationTheme,marketNode,monitoringEnabled,status',
      'US,B0CHINESE03,SKU-中文,腰枕,ELOVNOVA,腰部支撑枕,人体工学枕,,,腰枕,true,active',
    ].join('\r\n');
    const batch = adapter.ingest({
      buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, 'utf16le')]),
      format: 'csv', filename: 'utf16le-owned-products.csv',
    });

    expect(batch.entityType).toBe('owned_product_master');
    expect(batch.rows[0]?.values).toMatchObject({
      marketplace: 'US', sku: 'SKU-中文', internalname: '腰枕', title: '腰部支撑枕',
    });
  });

  it('does not let ImportService bypass a selected adapter', () => {
    database = openDatabase(':memory:');
    const adapter = new SellerSpriteImportAdapter();
    const ingest = vi.spyOn(adapter, 'ingest').mockImplementation(() => {
      throw new Error('adapter boundary reached');
    });
    const registry = { getFile: vi.fn(() => adapter) };
    const service = new ImportService(database, registry);
    expect(() => service.import(Buffer.from('ASIN\nB0TEST0001'), {
      format: 'csv', filename: 'products.csv', entityType: 'product', sourceType: 'import',
    })).toThrow(/adapter boundary reached/);
    expect(registry.getFile).toHaveBeenCalledWith('source-sellersprite-import');
    expect(ingest).toHaveBeenCalledOnce();
  });
});
