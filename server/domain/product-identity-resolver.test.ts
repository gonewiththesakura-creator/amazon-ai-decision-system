import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from '../database/database.js';
import { ProductIdentityResolver } from './product-identity-resolver.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function createDatabase(): AppDatabase {
  database = openDatabase(':memory:');
  return database;
}

function insertProduct(database: AppDatabase, id: string, marketplace: string, asin: string, sku: string): void {
  const now = '2026-09-19T00:00:00.000Z';
  const marketId = `market-${marketplace}`;
  database.prepare(`
    INSERT OR IGNORE INTO market_nodes (id, name, level, marketplace, status, source_type, created_at)
    VALUES (?, ?, 1, ?, 'active', 'import', ?)
  `).run(marketId, `${marketplace} market`, marketplace, now);
  database.prepare(`
    INSERT INTO products (
      id, asin, sku, brand, title, image_url, marketplace, product_type, is_owned,
      market_node_id, source_type, created_at
    ) VALUES (?, ?, ?, 'Brand', 'Title', '', ?, 'pillow', 1, ?, 'import', ?)
  `).run(id, asin, sku, marketplace, marketId, now);
}

describe('ProductIdentityResolver', () => {
  it('normalizes marketplace and ASIN casing and prefers an ASIN match over SKU', () => {
    const db = createDatabase();
    insertProduct(db, 'asin-product', 'US', 'B0ASIN0001', 'SKU-ASIN');
    insertProduct(db, 'sku-product', 'US', 'B0OTHER001', 'SHARED-SKU');
    const resolver = new ProductIdentityResolver(db);

    const resolved = resolver.resolve({ marketplace: 'us', asin: 'b0asin0001', sku: 'shared-sku' });

    expect(resolved).toMatchObject({ productId: 'asin-product', disposition: 'existing' });
  });

  it('does not merge a matching ASIN across marketplaces and associates a parent family', () => {
    const db = createDatabase();
    insertProduct(db, 'us-product', 'US', 'B0SAMEASIN', 'US-SKU');
    insertProduct(db, 'uk-product', 'UK', 'B0SAMEASIN', 'UK-SKU');
    const resolver = new ProductIdentityResolver(db);

    const resolved = resolver.resolve({
      marketplace: 'uk', asin: 'b0sameasin', parentAsin: 'b0parent01', variationTheme: 'Color',
    });

    expect(resolved).toMatchObject({ productId: 'uk-product', disposition: 'existing' });
    expect(resolved.variationFamilyId).toEqual(expect.any(String));
    expect(db.prepare(`SELECT marketplace, parent_asin FROM variation_families WHERE id = ?`).get(resolved.variationFamilyId))
      .toEqual({ marketplace: 'UK', parent_asin: 'B0PARENT01' });
  });

  it('creates a marketplace-scoped product identity for a previously unseen ASIN', () => {
    const db = createDatabase();
    const resolver = new ProductIdentityResolver(db);

    const resolved = resolver.resolve({ marketplace: 'ca', asin: 'b0newasin01', sku: 'new-sku' });

    expect(resolved).toMatchObject({ disposition: 'created', productId: expect.any(String) });
    expect(db.prepare(`SELECT marketplace, asin, sku FROM products WHERE id = ?`).get(resolved.productId))
      .toEqual({ marketplace: 'CA', asin: 'B0NEWASIN01', sku: 'NEW-SKU' });
  });
});
