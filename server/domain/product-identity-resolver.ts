import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database/database.js';

export type ParentLookupStatus = 'unknown' | 'pending' | 'verified' | 'standalone';

export interface ProductIdentityInput {
  marketplace: string;
  asin?: string;
  sku?: string;
  parentAsin?: string;
  familyKey?: string;
  parentLookupStatus?: ParentLookupStatus;
  variationTheme?: string;
  sourceType?: string;
  syncRunId?: string;
  importBatchId?: string;
}

export interface ProductIdentityResolution {
  productId: string | null;
  variationFamilyId: string | null;
  disposition: 'existing' | 'created';
}

interface ProductRow {
  id: string;
  asin: string;
  variationFamilyId: string | null;
  parentAsin: string | null;
  parentLookupStatus: ParentLookupStatus;
  isParent: number;
}

interface FamilyRow {
  id: string;
  parentAsin: string | null;
  familyKey: string;
  identityStatus: 'pending' | 'verified';
  variationTheme: string | null;
}

interface IdentityState {
  familyId: string | null;
  parentAsin: string | null;
  lookupStatus: ParentLookupStatus;
}

interface IdentityContext {
  sourceType: string;
  syncRunId: string | null;
  importBatchId: string | null;
  now: string;
}

export class ProductIdentityResolver {
  constructor(private readonly database: AppDatabase) {}

  resolve(input: ProductIdentityInput): ProductIdentityResolution {
    const marketplace = normalizeRequired(input.marketplace, 'marketplace');
    const asin = normalizeOptional(input.asin);
    const sku = normalizeOptional(input.sku);
    const parentAsin = normalizeOptional(input.parentAsin);
    const familyKey = normalizeOptional(input.familyKey);
    const lookupStatus = normalizeLookupStatus(input.parentLookupStatus);
    const context: IdentityContext = {
      sourceType: normalizeSourceType(input.sourceType),
      syncRunId: normalizeLineageId(input.syncRunId),
      importBatchId: normalizeLineageId(input.importBatchId),
      now: new Date().toISOString(),
    };
    if (!asin && !sku) throw new Error('ASIN 或 SKU 至少需要一个。');
    if (parentAsin) validateParentAsin(parentAsin);

    const savepoint = `product_identity_${randomUUID().replaceAll('-', '')}`;
    this.database.exec(`SAVEPOINT ${savepoint}`);
    try {
      const resolution = this.resolveWithinSavepoint({
        ...input,
        marketplace,
        asin,
        sku,
        parentAsin,
        familyKey,
        parentLookupStatus: lookupStatus,
      }, context);
      this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return resolution;
    } catch (error) {
      this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  private resolveWithinSavepoint(
    input: ProductIdentityInput & { marketplace: string; parentLookupStatus?: ParentLookupStatus },
    context: IdentityContext,
  ): ProductIdentityResolution {
    const { marketplace, asin, sku, parentAsin, familyKey } = input;

    const product = asin
      ? this.findProductByAsin(marketplace, asin)
      : undefined;
    const skuProduct = sku
      ? this.findProductBySku(marketplace, sku)
      : undefined;
    if (product && skuProduct && product.id !== skuProduct.id) {
      throw new Error('ASIN 与 SKU 分别匹配不同产品，拒绝合并身份。');
    }
    if (asin && !product && skuProduct) {
      throw new Error('新 ASIN 不能覆盖已存在 SKU 的产品身份。');
    }
    const matched = product ?? skuProduct;
    const identitySupplied = Boolean(parentAsin || familyKey || input.parentLookupStatus);

    if (!identitySupplied) {
      if (matched) {
        return {
          productId: matched.id,
          variationFamilyId: matched.variationFamilyId,
          disposition: 'existing',
        };
      }
      if (!asin) throw new Error('创建产品身份需要 ASIN。');
      const productId = this.createProduct(marketplace, asin, sku, {
        familyId: null,
        parentAsin: null,
        lookupStatus: 'unknown',
      }, context);
      return { productId, variationFamilyId: null, disposition: 'created' };
    }

    const selfParent = Boolean(parentAsin && parentAsin === (asin ?? matched?.asin));
    const target = selfParent
      ? { familyId: null, parentAsin: null, lookupStatus: 'standalone' as const }
      : this.resolveTargetIdentity({
        marketplace,
        familyKey,
        parentAsin,
        requestedStatus: input.parentLookupStatus,
        variationTheme: input.variationTheme,
        matched,
        context,
      });

    if (matched && matched.parentLookupStatus === 'verified'
      && (target.lookupStatus !== 'verified'
        || target.parentAsin !== matched.parentAsin
        || target.familyId !== matched.variationFamilyId)) {
      throw new Error('已验证产品身份不能降级或改绑到其他 Variation Family，拒绝覆盖。');
    }

    let productId: string;
    if (matched) {
      const current = this.findProductById(matched.id);
      if (!current) throw new Error('产品身份在解析期间消失。');
      this.applyProductIdentity(current, target, context);
      productId = matched.id;
    } else {
      if (!asin) throw new Error('创建产品身份需要 ASIN。');
      productId = this.createProduct(marketplace, asin, sku, target, context);
    }

    return {
      productId,
      variationFamilyId: target.familyId,
      disposition: matched ? 'existing' : 'created',
    };
  }

  private resolveTargetIdentity(args: {
    marketplace: string;
    familyKey?: string;
    parentAsin?: string;
    requestedStatus?: ParentLookupStatus;
    variationTheme?: string;
    matched?: ProductRow;
    context: IdentityContext;
  }): IdentityState {
    const {
      marketplace, parentAsin, requestedStatus, variationTheme, matched, context,
    } = args;
    let familyKey = args.familyKey;

    if (parentAsin) {
      if (requestedStatus && requestedStatus !== 'verified') {
        throw new Error('真实 parent ASIN 只能使用 verified 查询状态。');
      }
      let byParent = this.findFamilyByParent(marketplace, parentAsin);
      if (!familyKey && matched?.variationFamilyId) {
        const current = this.findFamilyById(matched.variationFamilyId);
        if (current && (current.identityStatus === 'pending' || current.parentAsin === parentAsin)) {
          familyKey = current.familyKey;
        }
      }
      familyKey ??= byParent?.familyKey ?? parentAsin;

      const byKey = this.findFamilyByKey(marketplace, familyKey);
      byParent ??= this.findFamilyByParent(marketplace, parentAsin);
      if (byKey && byParent && byKey.id !== byParent.id) {
        throw new Error('familyKey 与 parent ASIN 分别绑定不同族，拒绝覆盖。');
      }
      if (byKey?.parentAsin && byKey.parentAsin !== parentAsin) {
        throw new Error('familyKey 已绑定其他 parent ASIN，拒绝覆盖。');
      }
      if (byParent && byParent.familyKey !== familyKey) {
        throw new Error('parent ASIN 已绑定其他 familyKey，拒绝覆盖。');
      }

      const family = byKey ?? byParent;
      if (family?.identityStatus === 'pending') {
        this.upgradeFamily(family, parentAsin, variationTheme, context);
        return { familyId: family.id, parentAsin, lookupStatus: 'verified' };
      }
      if (family) return { familyId: family.id, parentAsin, lookupStatus: 'verified' };

      const familyId = this.createFamily({
        marketplace,
        parentAsin,
        familyKey,
        identityStatus: 'verified',
        variationTheme,
        context,
      });
      return { familyId, parentAsin, lookupStatus: 'verified' };
    }

    if (familyKey) {
      const family = this.findFamilyByKey(marketplace, familyKey);
      if (family) {
        if (requestedStatus === 'standalone' || requestedStatus === 'unknown') {
          throw new Error('familyKey 与无族查询状态冲突。');
        }
        if (requestedStatus === 'verified' && family.identityStatus !== 'verified') {
          throw new Error('provisional family 尚无真实 parent ASIN，不能标记 verified。');
        }
        return family.identityStatus === 'verified'
          ? { familyId: family.id, parentAsin: family.parentAsin, lookupStatus: 'verified' }
          : { familyId: family.id, parentAsin: null, lookupStatus: 'pending' };
      }
      if (requestedStatus === 'verified' || requestedStatus === 'standalone' || requestedStatus === 'unknown') {
        throw new Error('无真实 parent ASIN 时，新的 familyKey 只能处于 pending 状态。');
      }
      const familyId = this.createFamily({
        marketplace,
        parentAsin: null,
        familyKey,
        identityStatus: 'pending',
        variationTheme,
        context,
      });
      return { familyId, parentAsin: null, lookupStatus: 'pending' };
    }

    if (requestedStatus === 'verified') {
      if (matched?.parentLookupStatus === 'verified' && matched.parentAsin) {
        return {
          familyId: matched.variationFamilyId,
          parentAsin: matched.parentAsin,
          lookupStatus: 'verified',
        };
      }
      throw new Error('verified 查询状态需要真实 parent ASIN。');
    }
    if (requestedStatus === 'standalone') {
      return { familyId: null, parentAsin: null, lookupStatus: 'standalone' };
    }
    return {
      familyId: null,
      parentAsin: null,
      lookupStatus: requestedStatus ?? 'unknown',
    };
  }

  private createFamily(args: {
    marketplace: string;
    parentAsin: string | null;
    familyKey: string;
    identityStatus: 'pending' | 'verified';
    variationTheme?: string;
    context: IdentityContext;
  }): string {
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO variation_families (
        id, marketplace, parent_asin, family_key, variation_theme, attributes_json,
        status, identity_status, source_type, verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '{}', 'active', ?, ?, ?, ?, ?)
    `).run(
      id,
      args.marketplace,
      args.parentAsin,
      args.familyKey,
      args.variationTheme?.trim() || null,
      args.identityStatus,
      args.context.sourceType,
      args.identityStatus === 'verified' ? args.context.now : null,
      args.context.now,
      args.context.now,
    );
    return id;
  }

  private upgradeFamily(
    family: FamilyRow,
    parentAsin: string,
    variationTheme: string | undefined,
    context: IdentityContext,
  ): void {
    if (family.variationTheme && variationTheme?.trim()
      && family.variationTheme !== variationTheme.trim()) {
      throw new Error('Variation Family 的 variationTheme 与已暂存身份冲突，拒绝覆盖。');
    }
    this.database.prepare(`
      UPDATE variation_families
      SET parent_asin = ?, identity_status = 'verified', source_type = ?, verified_at = ?,
        variation_theme = COALESCE(NULLIF(TRIM(?), ''), variation_theme), updated_at = ?
      WHERE id = ? AND identity_status = 'pending'
    `).run(parentAsin, context.sourceType, context.now, variationTheme ?? null, context.now, family.id);

    const members = this.database.prepare(`
      SELECT id, asin, variation_family_id AS variationFamilyId, parent_asin AS parentAsin,
        parent_lookup_status AS parentLookupStatus, is_parent AS isParent
      FROM products WHERE variation_family_id = ? ORDER BY rowid
    `).all(family.id) as unknown as ProductRow[];
    const target: IdentityState = { familyId: family.id, parentAsin, lookupStatus: 'verified' };
    for (const member of members) this.applyProductIdentity(member, target, context);
  }

  private applyProductIdentity(product: ProductRow, target: IdentityState, context: IdentityContext): void {
    const previous: IdentityState = {
      familyId: product.variationFamilyId,
      parentAsin: product.parentAsin,
      lookupStatus: product.parentLookupStatus,
    };
    if (sameIdentity(previous, target)) return;
    this.database.prepare(`
      UPDATE products
      SET variation_family_id = ?, parent_asin = ?, parent_lookup_status = ?,
        is_parent = 0, updated_at = ?
      WHERE id = ?
    `).run(target.familyId, target.parentAsin, target.lookupStatus, context.now, product.id);
    this.appendIdentityEvent(product.id, previous, target, context);
  }

  private createProduct(
    marketplace: string,
    asin: string,
    sku: string | undefined,
    identity: IdentityState,
    context: IdentityContext,
  ): string {
    const marketNodeId = `identity-unassigned-${marketplace}`;
    this.database.prepare(`
      INSERT OR IGNORE INTO market_nodes (
        id, name, level, marketplace, status, source_type, created_at
      ) VALUES (?, 'Identity unassigned', 0, ?, 'pending', 'import', ?)
    `).run(marketNodeId, marketplace, context.now);
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO products (
        id, asin, sku, brand, title, image_url, marketplace, product_type, is_owned,
        market_node_id, source_type, created_at, updated_at, variation_family_id,
        parent_asin, parent_lookup_status, is_parent
      ) VALUES (?, ?, ?, 'Unknown', ?, '', ?, 'unclassified', 0, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      id,
      asin,
      sku ?? null,
      asin,
      marketplace,
      marketNodeId,
      context.sourceType,
      context.now,
      context.now,
      identity.familyId,
      identity.parentAsin,
      identity.lookupStatus,
    );
    if (!sameIdentity(unknownIdentity(), identity)) {
      this.appendIdentityEvent(id, unknownIdentity(), identity, context);
    }
    return id;
  }

  private appendIdentityEvent(
    productId: string,
    previous: IdentityState,
    next: IdentityState,
    context: IdentityContext,
  ): void {
    this.database.prepare(`
      INSERT INTO product_identity_events (
        id, product_id, old_family_id, new_family_id, old_parent_asin, new_parent_asin,
        old_lookup_status, new_lookup_status, source_type, sync_run_id, import_batch_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      productId,
      previous.familyId,
      next.familyId,
      previous.parentAsin,
      next.parentAsin,
      previous.lookupStatus,
      next.lookupStatus,
      context.sourceType,
      context.syncRunId,
      context.importBatchId,
      context.now,
    );
  }

  private findProductByAsin(marketplace: string, asin: string): ProductRow | undefined {
    return this.database.prepare(`
      SELECT id, asin, variation_family_id AS variationFamilyId, parent_asin AS parentAsin,
        parent_lookup_status AS parentLookupStatus, is_parent AS isParent
      FROM products WHERE marketplace = ? AND UPPER(TRIM(asin)) = ?
    `).get(marketplace, asin) as unknown as ProductRow | undefined;
  }

  private findProductById(id: string): ProductRow | undefined {
    return this.database.prepare(`
      SELECT id, asin, variation_family_id AS variationFamilyId, parent_asin AS parentAsin,
        parent_lookup_status AS parentLookupStatus, is_parent AS isParent
      FROM products WHERE id = ?
    `).get(id) as unknown as ProductRow | undefined;
  }

  private findProductBySku(marketplace: string, sku: string): ProductRow | undefined {
    return this.database.prepare(`
      SELECT id, asin, variation_family_id AS variationFamilyId, parent_asin AS parentAsin,
        parent_lookup_status AS parentLookupStatus, is_parent AS isParent
      FROM products WHERE marketplace = ? AND UPPER(TRIM(sku)) = ?
    `).get(marketplace, sku) as unknown as ProductRow | undefined;
  }

  private findFamilyById(id: string): FamilyRow | undefined {
    return this.database.prepare(`
      SELECT id, parent_asin AS parentAsin, family_key AS familyKey,
        identity_status AS identityStatus, variation_theme AS variationTheme
      FROM variation_families WHERE id = ?
    `).get(id) as unknown as FamilyRow | undefined;
  }

  private findFamilyByKey(marketplace: string, familyKey: string): FamilyRow | undefined {
    return this.database.prepare(`
      SELECT id, parent_asin AS parentAsin, family_key AS familyKey,
        identity_status AS identityStatus, variation_theme AS variationTheme
      FROM variation_families
      WHERE marketplace = ? AND UPPER(TRIM(family_key)) = ?
    `).get(marketplace, familyKey) as unknown as FamilyRow | undefined;
  }

  private findFamilyByParent(marketplace: string, parentAsin: string): FamilyRow | undefined {
    return this.database.prepare(`
      SELECT id, parent_asin AS parentAsin, family_key AS familyKey,
        identity_status AS identityStatus, variation_theme AS variationTheme
      FROM variation_families
      WHERE marketplace = ? AND UPPER(TRIM(parent_asin)) = ?
    `).get(marketplace, parentAsin) as unknown as FamilyRow | undefined;
  }
}

function unknownIdentity(): IdentityState {
  return { familyId: null, parentAsin: null, lookupStatus: 'unknown' };
}

function sameIdentity(left: IdentityState, right: IdentityState): boolean {
  return left.familyId === right.familyId
    && left.parentAsin === right.parentAsin
    && left.lookupStatus === right.lookupStatus;
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

function normalizeLineageId(value?: string): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function normalizeSourceType(value?: string): string {
  const normalized = value?.trim().toLowerCase();
  return normalized || 'import';
}

function normalizeLookupStatus(value?: ParentLookupStatus): ParentLookupStatus | undefined {
  if (value === undefined) return undefined;
  if (value === 'unknown' || value === 'pending' || value === 'verified' || value === 'standalone') {
    return value;
  }
  throw new Error(`不支持的 parentLookupStatus: ${String(value)}`);
}

function validateParentAsin(parentAsin: string): void {
  if (!/^[A-Z0-9]{10}$/.test(parentAsin)) {
    throw new Error(`parent ASIN 必须是 10 位字母数字，不能使用占位值: ${parentAsin}`);
  }
}
