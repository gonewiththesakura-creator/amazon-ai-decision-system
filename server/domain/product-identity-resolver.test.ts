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

    const resolved = resolver.resolve({ marketplace: 'us', asin: 'b0asin0001', sku: 'sku-asin' });

    expect(resolved).toMatchObject({ productId: 'asin-product', disposition: 'existing' });
  });

  it('rejects conflicting ASIN and SKU matches instead of merging products', () => {
    const db = createDatabase();
    insertProduct(db, 'asin-product', 'US', 'B0ASIN0001', 'SKU-ASIN');
    insertProduct(db, 'sku-product', 'US', 'B0OTHER001', 'SHARED-SKU');
    expect(() => new ProductIdentityResolver(db).resolve({
      marketplace: 'US', asin: 'B0ASIN0001', sku: 'shared-sku',
    })).toThrow(/拒绝合并/);
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

  it('shares a provisional family and upgrades every member in place when a real parent arrives', () => {
    const db = createDatabase();
    insertProduct(db, 'child-one', 'US', 'B0CHILD001', 'CHILD-1');
    insertProduct(db, 'child-two', 'US', 'B0CHILD002', 'CHILD-2');
    const now = '2026-09-21T00:00:00.000Z';
    db.prepare(`INSERT INTO data_tasks (
      id, name, task_type, target, source, status, created_at
    ) VALUES ('identity-run', 'Identity lookup', 'identity_lookup', 'children',
      'SellerSprite MCP', 'success', ?)`).run(now);
    db.prepare(`INSERT INTO import_batches (
      id, filename, format, entity_type, row_count, success_count, failure_count,
      errors_json, task_id, imported_at
    ) VALUES ('identity-import', 'identity.csv', 'csv', 'product', 2, 2, 0,
      '[]', 'identity-run', ?)`).run(now);
    const resolver = new ProductIdentityResolver(db);

    const first = resolver.resolve({
      marketplace: 'US', asin: 'B0CHILD001', familyKey: 'catalog-family-1',
      parentLookupStatus: 'pending', sourceType: 'import', importBatchId: 'identity-import',
    });
    const second = resolver.resolve({
      marketplace: 'US', asin: 'B0CHILD002', familyKey: 'CATALOG-FAMILY-1',
      parentLookupStatus: 'pending', sourceType: 'import', importBatchId: 'identity-import',
    });

    expect(first.variationFamilyId).toEqual(expect.any(String));
    expect(second.variationFamilyId).toBe(first.variationFamilyId);
    expect(db.prepare(`SELECT parent_asin AS parentAsin, family_key AS familyKey,
      identity_status AS identityStatus, source_type AS sourceType, verified_at AS verifiedAt
      FROM variation_families WHERE id = ?`).get(first.variationFamilyId)).toEqual({
      parentAsin: null, familyKey: 'CATALOG-FAMILY-1', identityStatus: 'pending',
      sourceType: 'import', verifiedAt: null,
    });

    const upgraded = resolver.resolve({
      marketplace: 'US', asin: 'B0CHILD001', familyKey: 'catalog-family-1',
      parentAsin: 'b0parent01', parentLookupStatus: 'verified',
      sourceType: 'mcp', syncRunId: 'identity-run',
    });

    expect(upgraded.variationFamilyId).toBe(first.variationFamilyId);
    expect(db.prepare(`SELECT parent_asin AS parentAsin, family_key AS familyKey,
      identity_status AS identityStatus, source_type AS sourceType,
      verified_at AS verifiedAt FROM variation_families WHERE id = ?`)
      .get(first.variationFamilyId)).toMatchObject({
      parentAsin: 'B0PARENT01', familyKey: 'CATALOG-FAMILY-1',
      identityStatus: 'verified', sourceType: 'mcp', verifiedAt: expect.any(String),
    });
    expect(db.prepare(`SELECT id, variation_family_id AS familyId,
      parent_asin AS parentAsin, parent_lookup_status AS lookupStatus
      FROM products WHERE id IN ('child-one', 'child-two') ORDER BY id`).all()).toEqual([
      { id: 'child-one', familyId: first.variationFamilyId,
        parentAsin: 'B0PARENT01', lookupStatus: 'verified' },
      { id: 'child-two', familyId: first.variationFamilyId,
        parentAsin: 'B0PARENT01', lookupStatus: 'verified' },
    ]);
    expect(db.prepare(`SELECT product_id AS productId, old_lookup_status AS oldStatus,
      new_lookup_status AS newStatus, source_type AS sourceType,
      sync_run_id AS syncRunId, import_batch_id AS importBatchId
      FROM product_identity_events ORDER BY rowid`).all()).toEqual([
      { productId: 'child-one', oldStatus: 'unknown', newStatus: 'pending',
        sourceType: 'import', syncRunId: null, importBatchId: 'identity-import' },
      { productId: 'child-two', oldStatus: 'unknown', newStatus: 'pending',
        sourceType: 'import', syncRunId: null, importBatchId: 'identity-import' },
      { productId: 'child-one', oldStatus: 'pending', newStatus: 'verified',
        sourceType: 'mcp', syncRunId: 'identity-run', importBatchId: null },
      { productId: 'child-two', oldStatus: 'pending', newStatus: 'verified',
        sourceType: 'mcp', syncRunId: 'identity-run', importBatchId: null },
    ]);
  });

  it('preserves a verified identity when later input has no usable identity fields', () => {
    const db = createDatabase();
    insertProduct(db, 'verified-child', 'US', 'B0CHILD003', 'CHILD-3');
    const resolver = new ProductIdentityResolver(db);
    const verified = resolver.resolve({
      marketplace: 'US', asin: 'B0CHILD003', familyKey: 'verified-family',
      parentAsin: 'B0PARENT02', parentLookupStatus: 'verified', sourceType: 'mcp',
    });
    const eventCount = db.prepare(`SELECT COUNT(*) AS count FROM product_identity_events`).get();

    const resolved = resolver.resolve({
      marketplace: 'US', asin: 'B0CHILD003', parentAsin: '  ', familyKey: '   ',
      sourceType: 'import',
    });

    expect(resolved.variationFamilyId).toBe(verified.variationFamilyId);
    expect(db.prepare(`SELECT variation_family_id AS familyId, parent_asin AS parentAsin,
      parent_lookup_status AS lookupStatus FROM products WHERE id = 'verified-child'`).get()).toEqual({
      familyId: verified.variationFamilyId, parentAsin: 'B0PARENT02', lookupStatus: 'verified',
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM product_identity_events`).get()).toEqual(eventCount);
  });

  it.each([
    ['unknown', { parentLookupStatus: 'unknown' as const }],
    ['standalone', { parentLookupStatus: 'standalone' as const }],
    ['another verified parent', {
      parentAsin: 'B0PARENT99', familyKey: 'OTHER-FAMILY', parentLookupStatus: 'verified' as const,
    }],
  ])('rejects changing a verified identity to %s', (_label, change) => {
    const db = createDatabase();
    insertProduct(db, 'locked-child', 'US', 'B0LOCKED01', 'LOCKED-1');
    const resolver = new ProductIdentityResolver(db);
    const verified = resolver.resolve({
      marketplace: 'US', asin: 'B0LOCKED01', familyKey: 'LOCKED-FAMILY',
      parentAsin: 'B0PARENT01', parentLookupStatus: 'verified', sourceType: 'mcp',
    });
    const before = db.prepare(`SELECT variation_family_id AS familyId,
      parent_asin AS parentAsin, parent_lookup_status AS lookupStatus
      FROM products WHERE id = 'locked-child'`).get();
    const eventCount = db.prepare(`SELECT COUNT(*) AS count FROM product_identity_events`).get();

    expect(() => resolver.resolve({
      marketplace: 'US', asin: 'B0LOCKED01', sourceType: 'mcp', ...change,
    })).toThrow(/已验证产品身份.*拒绝|冲突/);
    expect(db.prepare(`SELECT variation_family_id AS familyId,
      parent_asin AS parentAsin, parent_lookup_status AS lookupStatus
      FROM products WHERE id = 'locked-child'`).get()).toEqual(before);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM product_identity_events`).get()).toEqual(eventCount);
    expect(verified.variationFamilyId).toBe((before as { familyId: string }).familyId);
  });

  it('reuses a custom family key when a verified parent is later resolved by parent only', () => {
    const db = createDatabase();
    insertProduct(db, 'parent-only-child', 'US', 'B0CHILD009', 'CHILD-9');
    const resolver = new ProductIdentityResolver(db);
    const pending = resolver.resolve({
      marketplace: 'US', asin: 'B0CHILD009', familyKey: 'CUSTOM-FAMILY-9',
      parentLookupStatus: 'pending', sourceType: 'import',
    });
    const upgraded = resolver.resolve({
      marketplace: 'US', asin: 'B0CHILD009', parentAsin: 'B0PARENT09',
      parentLookupStatus: 'verified', sourceType: 'mcp',
    });

    expect(upgraded.variationFamilyId).toBe(pending.variationFamilyId);
    expect(() => resolver.resolve({
      marketplace: 'US', asin: 'B0CHILD009', parentAsin: 'B0PARENT09',
      parentLookupStatus: 'verified', sourceType: 'mcp',
    })).not.toThrow();
    expect(db.prepare(`SELECT family_key AS familyKey, parent_asin AS parentAsin,
      identity_status AS identityStatus FROM variation_families WHERE id = ?`)
      .get(pending.variationFamilyId)).toEqual({
      familyKey: 'CUSTOM-FAMILY-9', parentAsin: 'B0PARENT09', identityStatus: 'verified',
    });
  });

  it('rejects familyKey and parent conflicts atomically', () => {
    const db = createDatabase();
    insertProduct(db, 'pending-child', 'US', 'B0CHILD004', 'CHILD-4');
    insertProduct(db, 'verified-child', 'US', 'B0CHILD005', 'CHILD-5');
    const resolver = new ProductIdentityResolver(db);
    const pending = resolver.resolve({
      marketplace: 'US', asin: 'B0CHILD004', familyKey: 'pending-family',
      parentLookupStatus: 'pending', sourceType: 'import',
    });
    const verified = resolver.resolve({
      marketplace: 'US', asin: 'B0CHILD005', familyKey: 'verified-family',
      parentAsin: 'B0PARENT03', parentLookupStatus: 'verified', sourceType: 'mcp',
    });
    const beforeEvents = db.prepare(`SELECT COUNT(*) AS count FROM product_identity_events`).get();

    expect(() => resolver.resolve({
      marketplace: 'US', asin: 'B0CHILD004', familyKey: 'pending-family',
      parentAsin: 'B0PARENT03', parentLookupStatus: 'verified', sourceType: 'mcp',
    })).toThrow(/分别绑定不同族|冲突|拒绝覆盖/);

    expect(db.prepare(`SELECT parent_asin AS parentAsin, identity_status AS identityStatus
      FROM variation_families WHERE id = ?`).get(pending.variationFamilyId)).toEqual({
      parentAsin: null, identityStatus: 'pending',
    });
    expect(db.prepare(`SELECT parent_asin AS parentAsin, identity_status AS identityStatus
      FROM variation_families WHERE id = ?`).get(verified.variationFamilyId)).toEqual({
      parentAsin: 'B0PARENT03', identityStatus: 'verified',
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM product_identity_events`).get()).toEqual(beforeEvents);
  });

  it('rejects placeholder parent values without changing identity', () => {
    const db = createDatabase();
    insertProduct(db, 'placeholder-child', 'US', 'B0CHILD006', 'CHILD-6');
    const resolver = new ProductIdentityResolver(db);

    expect(() => resolver.resolve({
      marketplace: 'US', asin: 'B0CHILD006', familyKey: 'placeholder-family',
      parentAsin: 'Pending lookup', parentLookupStatus: 'verified', sourceType: 'import',
    })).toThrow(/parent ASIN.*占位值/);
    expect(db.prepare(`SELECT variation_family_id AS familyId, parent_asin AS parentAsin,
      parent_lookup_status AS lookupStatus FROM products WHERE id = 'placeholder-child'`).get()).toEqual({
      familyId: null, parentAsin: null, lookupStatus: 'unknown',
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM variation_families`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM product_identity_events`).get()).toEqual({ count: 0 });
  });

  it('rejects a conflicting variation theme while verifying a provisional family', () => {
    const db = createDatabase();
    insertProduct(db, 'theme-child', 'US', 'B0THEME001', 'THEME-1');
    const resolver = new ProductIdentityResolver(db);
    const pending = resolver.resolve({
      marketplace: 'US', asin: 'B0THEME001', familyKey: 'PENDING-THEME',
      parentLookupStatus: 'pending', variationTheme: 'Color', sourceType: 'import',
    });
    expect(() => resolver.resolve({
      marketplace: 'US', asin: 'B0THEME001', familyKey: 'PENDING-THEME',
      parentAsin: 'B0PARENT11', parentLookupStatus: 'verified',
      variationTheme: 'Size', sourceType: 'mcp',
    })).toThrow(/variationTheme.*冲突/);
    expect(db.prepare(`SELECT identity_status AS identityStatus, parent_asin AS parentAsin,
      variation_theme AS variationTheme FROM variation_families WHERE id = ?`)
      .get(pending.variationFamilyId)).toEqual({
      identityStatus: 'pending', parentAsin: null, variationTheme: 'Color',
    });
  });

  it('recognizes a SKU-only self-parent observation as standalone', () => {
    const db = createDatabase();
    insertProduct(db, 'sku-self', 'US', 'B0SELF0002', 'SELF-2');
    const resolver = new ProductIdentityResolver(db);
    const resolved = resolver.resolve({
      marketplace: 'US', sku: 'SELF-2', parentAsin: 'B0SELF0002', sourceType: 'mcp',
    });
    expect(resolved.variationFamilyId).toBeNull();
    expect(db.prepare(`SELECT parent_asin AS parentAsin,
      parent_lookup_status AS lookupStatus FROM products WHERE id = 'sku-self'`).get())
      .toEqual({ parentAsin: null, lookupStatus: 'standalone' });
  });

  it('normalizes a self-parent on an unverified product to standalone without mutating historical trend snapshots', () => {
    const db = createDatabase();
    insertProduct(db, 'self-child', 'US', 'B0SELF0001', 'SELF-1');
    const resolver = new ProductIdentityResolver(db);
    db.prepare(`INSERT INTO product_snapshots (
      id, product_id, date, price, rating, review_count, bsr, estimated_sales,
      estimated_revenue, seller_count, growth_7d, growth_30d, growth_90d,
      source, source_type, collected_at, period, is_estimated, confidence,
      observation_date, dedup_key
    ) VALUES ('self-trend', 'self-child', '2026-09-20', 29.99, 4.5, 120, 500,
      30, 899.7, 1, 0.1, 0.2, 0.3, 'SellerSprite', 'mcp',
      '2026-09-20T00:00:00.000Z', '30D', 1, 0.9, '2026-09-20',
      'product|US|self-child|2026-09-20|mcp|sellersprite|30D')`).run();
    const beforeSnapshot = db.prepare(`SELECT * FROM product_snapshots WHERE id = 'self-trend'`).get();

    const resolved = resolver.resolve({
      marketplace: 'US', asin: 'B0SELF0001', parentAsin: 'B0SELF0001',
      parentLookupStatus: 'verified', sourceType: 'mcp',
    });

    expect(resolved.variationFamilyId).toBeNull();
    expect(db.prepare(`SELECT variation_family_id AS familyId, parent_asin AS parentAsin,
      parent_lookup_status AS lookupStatus, is_parent AS isParent
      FROM products WHERE id = 'self-child'`).get()).toEqual({
      familyId: null, parentAsin: null, lookupStatus: 'standalone', isParent: 0,
    });
    expect(db.prepare(`SELECT * FROM product_snapshots WHERE id = 'self-trend'`).get()).toEqual(beforeSnapshot);
    expect(db.prepare(`SELECT old_lookup_status AS oldStatus, new_lookup_status AS newStatus,
      old_parent_asin AS oldParent, new_parent_asin AS newParent
      FROM product_identity_events WHERE product_id = 'self-child' ORDER BY rowid DESC LIMIT 1`).get())
      .toEqual({ oldStatus: 'unknown', newStatus: 'standalone', oldParent: null, newParent: null });
  });
});
