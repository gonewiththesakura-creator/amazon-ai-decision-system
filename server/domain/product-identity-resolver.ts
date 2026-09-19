import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database/database.js';

export interface ProductIdentityInput {
  marketplace: string;
  asin?: string;
  sku?: string;
  parentAsin?: string;
  variationTheme?: string;
}

export interface ProductIdentityResolution {
  productId: string | null;
  variationFamilyId: string | null;
  disposition: 'existing' | 'created';
}

interface ProductRow {
  id: string;
}

interface FamilyRow {
  id: string;
}

export class ProductIdentityResolver {
  constructor(private readonly database: AppDatabase) {}

  resolve(input: ProductIdentityInput): ProductIdentityResolution {
    const marketplace = normalizeRequired(input.marketplace, 'marketplace');
    const asin = normalizeOptional(input.asin);
    const sku = normalizeOptional(input.sku);
    const parentAsin = normalizeOptional(input.parentAsin);
    if (!asin && !sku) throw new Error('ASIN 或 SKU 至少需要一个。');

    const product = asin
      ? this.database.prepare(`SELECT id FROM products WHERE marketplace = ? AND UPPER(TRIM(asin)) = ?`).get(marketplace, asin) as ProductRow | undefined
      : undefined;
    const skuProduct = sku
      ? this.database.prepare(`SELECT id FROM products WHERE marketplace = ? AND UPPER(sku) = ?`).get(marketplace, sku) as ProductRow | undefined
      : undefined;
    if (product && skuProduct && product.id !== skuProduct.id) {
      throw new Error('ASIN 与 SKU 分别匹配不同产品，拒绝合并身份。');
    }
    if (asin && !product && skuProduct) {
      throw new Error('新 ASIN 不能覆盖已存在 SKU 的产品身份。');
    }
    const matched = product ?? skuProduct;
    const variationFamilyId = parentAsin
      ? this.findOrCreateFamily(marketplace, parentAsin, input.variationTheme)
      : null;

    if (matched && variationFamilyId) {
      this.database.prepare(`
        UPDATE products
        SET variation_family_id = ?, parent_asin = ?, updated_at = ?
        WHERE id = ?
      `).run(variationFamilyId, parentAsin!, new Date().toISOString(), matched.id);
    }
    const createdProductId = !matched && asin
      ? this.createProduct(marketplace, asin, sku, variationFamilyId, parentAsin)
      : null;
    if (!matched && !createdProductId) throw new Error('创建产品身份需要 ASIN。');
    return {
      productId: matched?.id ?? createdProductId,
      variationFamilyId,
      disposition: matched ? 'existing' : 'created',
    };
  }

  private findOrCreateFamily(marketplace: string, parentAsin: string, variationTheme?: string): string {
    const existing = this.database.prepare(`
      SELECT id FROM variation_families WHERE marketplace = ? AND parent_asin = ?
    `).get(marketplace, parentAsin) as FamilyRow | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO variation_families (
        id, marketplace, parent_asin, variation_theme, attributes_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '{}', 'active', ?, ?)
    `).run(id, marketplace, parentAsin, variationTheme?.trim() || null, now, now);
    return id;
  }

  private createProduct(
    marketplace: string,
    asin: string,
    sku: string | undefined,
    variationFamilyId: string | null,
    parentAsin: string | undefined,
  ): string {
    const marketNodeId = `identity-unassigned-${marketplace}`;
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT OR IGNORE INTO market_nodes (
        id, name, level, marketplace, status, source_type, created_at
      ) VALUES (?, 'Identity unassigned', 0, ?, 'pending', 'import', ?)
    `).run(marketNodeId, marketplace, now);
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO products (
        id, asin, sku, brand, title, image_url, marketplace, product_type, is_owned,
        market_node_id, source_type, created_at, updated_at, variation_family_id, parent_asin
      ) VALUES (?, ?, ?, 'Unknown', ?, '', ?, 'unclassified', 0, ?, 'import', ?, ?, ?, ?)
    `).run(id, asin, sku ?? null, asin, marketplace, marketNodeId, now, now, variationFamilyId, parentAsin ?? null);
    return id;
  }
}

function normalizeRequired(value: string, label: string): string {
  const normalized = normalizeOptional(value);
  if (!normalized) throw new Error(`${label} 不能为空。`);
  return normalized;
}

function normalizeOptional(value?: string): string | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized || undefined;
}
