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
