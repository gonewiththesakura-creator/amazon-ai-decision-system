import { createHash, randomUUID } from 'node:crypto';
import type { DataTask, MarketDetail } from '../../shared/types.js';
import { AdapterRegistry } from '../adapters/index.js';
import type {
  FileImportEntityType as ImportEntityType,
  FileImportBatch,
  FileImportDetectedType,
  FileImportFormat as ImportFormat,
  NormalizedFileImportRow,
} from '../adapters/types.js';
import type { AppDatabase } from '../database/database.js';
import { transaction } from '../database/database.js';
import {
  calculateMarketOpportunityMetrics,
  type MarketOpportunityMetricsInput,
} from '../domain/calculations.js';
import { IntelligenceRepository } from '../repository/intelligence-repository.js';
import { DeterministicAIService } from './ai-service.js';
import { ProductIdentityResolver, type ProductIdentityResolution } from '../domain/product-identity-resolver.js';

type ImportRow = Record<string, unknown>;

interface ProductSnapshotInput {
  date: string;
  price: number | null;
  rating: number | null;
  reviewCount: number | null;
  bsr: number | null;
  estimatedSales: number | null;
  estimatedRevenue: number | null;
  sellerCount: number | null;
  growth7d: number | null;
  growth30d: number | null;
  growth90d: number | null;
  isEstimated: boolean;
  confidence: number;
}

interface MarketSnapshotInput {
  date: string;
  productCount: number;
  sellerCount: number;
  brandCount: number;
  monthlySales: number;
  monthlyRevenue: number;
  avgPrice: number;
  medianPrice: number;
  avgRating: number;
  medianReviews: number;
  top10Share: number;
  top20Share: number;
  newProductShare: number;
  priceBands: PriceBandInput[];
  concentration: ConcentrationInput[];
  isEstimated: boolean;
  confidence: number;
}

interface PriceBandInput {
  label: string;
  productCount: number;
  monthlySales: number;
  revenue: number;
  avgReviews: number;
  newProducts: number;
  growth: number;
}

interface ConcentrationInput {
  tier: string;
  share: number;
  avgPrice: number;
  avgSales: number;
}

interface CompleteMarketMetrics extends MarketOpportunityMetricsInput {
  monthlySales: number;
  sellerCount: number;
  brandCount: number;
  avgPrice: number;
  avgRating: number;
  newProductShare: number;
}

type StagedImportRow = NormalizedFileImportRow;

class AllImportRowsFailedError extends Error {}

export interface ImportOptions {
  format: ImportFormat;
  filename: string;
  entityType?: string;
  marketplace?: string;
  marketNodeId?: string;
  researchJobId?: string;
  sourceType?: 'import' | 'amazon';
  reportStartDate?: string;
  reportEndDate?: string;
}

export interface ImportResult {
  batchId: string;
  entityType: ImportEntityType;
  rowCount: number;
  successCount: number;
  failureCount: number;
  errors: string[];
  task: DataTask;
}

export interface ImportPreview {
  token: string;
  contentDigest: string;
  detectedType: FileImportDetectedType;
  entityType: ImportEntityType | null;
  totalCount: number;
  newCount: number;
  updateCount: number;
  duplicateCount: number;
  errorCount: number;
  errors: string[];
  mappings: ImportFieldMapping[];
  rows: NormalizedFileImportRow[];
  previewRowLimit: number;
  previewedCount: number;
  rowsOmitted: number;
  expiresAt: string;
}

export interface ImportFieldMapping {
  sourceHeader: string;
  targetField: string;
}

interface StagedImportPreview {
  hash: string;
  buffer: Buffer;
  batch: FileImportBatch;
  options: ImportOptions;
  preview: ImportPreview;
  confirmed?: ImportResult;
}

const PREVIEW_TTL_MS = 10 * 60 * 1_000;
const MAX_STAGED_PREVIEWS = 50;
const MAX_STAGED_BYTES = 10 * 1024 * 1024;
const MAX_PREVIEW_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_ROWS = 20;

interface ProductIdentityPort {
  resolve(input: {
    marketplace: string;
    asin?: string;
    sku?: string;
    parentAsin?: string;
    variationTheme?: string;
  }): ProductIdentityResolution;
}

interface OwnedMasterBatchIdentity {
  asinKey: string;
  skuKey: string;
}

class OwnedMasterBatchGuard {
  private readonly asins = new Map<string, number>();
  private readonly skus = new Map<string, number>();

  check(row: ImportRow): OwnedMasterBatchIdentity {
    const marketplace = requiredString(row, ['marketplace']).toUpperCase();
    const asinKey = JSON.stringify([marketplace, requiredString(row, ['asin']).toUpperCase()]);
    const skuKey = JSON.stringify([marketplace, requiredString(row, ['sku']).toUpperCase()]);
    const priorAsinRow = this.asins.get(asinKey);
    if (priorAsinRow !== undefined) {
      throw new Error(`同一文件中的 ASIN 已在第 ${priorAsinRow} 行出现，拒绝重复或冲突产品身份。`);
    }
    const priorSkuRow = this.skus.get(skuKey);
    if (priorSkuRow !== undefined) {
      throw new Error(`同一文件中的 SKU 已在第 ${priorSkuRow} 行出现，拒绝重复或冲突产品身份。`);
    }
    return { asinKey, skuKey };
  }

  accept(identity: OwnedMasterBatchIdentity, rowNumber: number): void {
    this.asins.set(identity.asinKey, rowNumber);
    this.skus.set(identity.skuKey, rowNumber);
  }
}

export class ImportService {
  private readonly repository: IntelligenceRepository;
  private readonly ai: DeterministicAIService;
  private readonly stagedPreviews = new Map<string, StagedImportPreview>();
  private readonly identity: ProductIdentityPort;

  constructor(
    private readonly database: AppDatabase,
    private readonly adapters: Pick<AdapterRegistry, 'getFile'> = new AdapterRegistry(),
    identity?: ProductIdentityPort,
  ) {
    this.repository = new IntelligenceRepository(database);
    this.ai = new DeterministicAIService(this.repository);
    this.identity = identity ?? new ProductIdentityResolver(database);
  }

  /** Parses and validates a file through its adapter without writing business records. */
  preview(buffer: Buffer, options: ImportOptions): ImportPreview {
    this.deleteExpiredPreviews();
    if (buffer.length > MAX_PREVIEW_BUFFER_BYTES) throw new Error('预览文件超过 2 MB 限制。');
    this.evictForPreview(buffer.length);
    const sourceId = options.sourceType === 'amazon' ? 'source-amazon-import' : 'source-sellersprite-import';
    const adapter = this.adapters.getFile(sourceId);
    const batch = adapter.ingest({
      buffer,
      format: options.format,
      filename: options.filename,
      entityType: options.entityType,
    });
    if (adapter.sourceType === 'amazon' && batch.detectedType.startsWith('sellersprite_')) {
      throw new Error('Amazon 数据源只接受可识别的 Amazon Business Report，不能导入 SellerSprite 报表。');
    }
    return this.stagePreview(buffer, batch, { ...options, sourceType: adapter.sourceType }, batch.detectedType,
      batch.detectedType === 'unknown' ? null : batch.entityType);
  }

  /** Revalidates Unknown input against an operator-selected type and returns a replacement review token. */
  selectType(token: string, explicitEntityType: string): ImportPreview {
    this.deleteExpiredPreviews();
    const staged = this.stagedPreviews.get(token);
    if (!staged) throw new Error('确认令牌无效或已过期，请重新预览文件。');
    if (staged.preview.entityType) throw new Error('已识别文件不允许更改导入类型。');
    if (hashBuffer(staged.buffer) !== staged.hash) throw new Error('导入预览校验失败。');
    const entityType = normalizeExplicitEntityType(explicitEntityType);
    if (!entityType) throw new Error('必须选择导入类型。');
    assertAmazonReportType(staged.options.sourceType, staged.batch.detectedType, entityType);
    this.stagedPreviews.delete(token);
    return this.stagePreview(staged.buffer, { ...staged.batch, entityType },
      { ...staged.options, entityType }, staged.preview.detectedType, entityType);
  }

  private stagePreview(
    buffer: Buffer,
    batch: FileImportBatch,
    options: ImportOptions,
    detectedType: FileImportDetectedType,
    entityType: ImportEntityType | null,
  ): ImportPreview {
    const errors: string[] = [];
    let validCount = 0;
    let updateCount = 0;
    let duplicateCount = 0;
    const ownedMasterGuard = new OwnedMasterBatchGuard();
    for (const row of batch.rows) {
      try {
        if (!entityType) throw new Error('未知文件类型必须由操作员选择。');
        validateImportRow(row.values, entityType, options);
        this.assertProductIdentityIsConsistent(row.values, entityType, options);
        if (entityType === 'owned_product_master') {
          const identity = ownedMasterGuard.check(row.values);
          const disposition = this.classifyOwnedMasterPreviewRow(row.values);
          if (disposition === 'duplicate') duplicateCount += 1;
          else if (disposition === 'update') updateCount += 1;
          else validCount += 1;
          ownedMasterGuard.accept(identity, row.rowNumber);
        } else if (this.isDuplicatePreviewRow(row.values, entityType, options)) duplicateCount += 1;
        else validCount += 1;
      } catch (error) {
        errors.push(`第 ${row.rowNumber} 行：${error instanceof Error ? error.message : '未知错误'}`);
      }
    }
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
    const previewedCount = Math.min(batch.rows.length, MAX_PREVIEW_ROWS);
    const contentDigest = hashBuffer(buffer);
    const preview: ImportPreview = {
      token,
      contentDigest,
      detectedType,
      entityType,
      totalCount: batch.rowCount,
      newCount: validCount,
      updateCount,
      duplicateCount,
      errorCount: errors.length,
      errors,
      mappings: fieldMappings(batch.rows[0]?.values ?? {}),
      rows: batch.rows.slice(0, previewedCount).map(previewRow),
      previewRowLimit: MAX_PREVIEW_ROWS,
      previewedCount,
      rowsOmitted: batch.rows.length - previewedCount,
      expiresAt,
    };
    this.stagedPreviews.set(token, {
      hash: contentDigest,
      buffer: Buffer.from(buffer),
      batch,
      options: { ...options },
      preview,
    });
    return preview;
  }

  /** Writes only the normalized rows captured by preview. Confirmation is idempotent per token. */
  confirm(token: string, explicitEntityType?: string): ImportResult {
    this.deleteExpiredPreviews();
    const staged = this.stagedPreviews.get(token);
    if (!staged) throw new Error('确认令牌无效或已过期，请重新预览文件。');
    if (staged.confirmed) return staged.confirmed;
    if (!staged.preview.entityType) {
      if (explicitEntityType) throw new Error('未知文件选择类型后必须重新预览并使用新令牌确认。');
      throw new Error('未知文件类型必须先明确选择导入类型。');
    }
    const entityType = staged.preview.entityType;
    if (explicitEntityType && normalizeExplicitEntityType(explicitEntityType) !== entityType) {
      throw new Error('确认类型与预览文件不一致；请使用所选类型重新预览。');
    }
    if (hashBuffer(staged.buffer) !== staged.hash) throw new Error('导入预览校验失败。');
    const batch = { ...staged.batch, entityType };
    const result = this.import(staged.buffer, { ...staged.options, entityType }, batch);
    staged.confirmed = result;
    return result;
  }

  import(buffer: Buffer, options: ImportOptions, preparedBatch?: FileImportBatch): ImportResult {
    const taskId = randomUUID();
    const batchId = randomUUID();
    const now = new Date().toISOString();
    const taskMarketplace = this.repository.getSettings().marketplace;
    const sourceId = options.sourceType === 'amazon' ? 'source-amazon-import' : 'source-sellersprite-import';
    const adapter = this.adapters.getFile(sourceId);
    const normalizedOptions = { ...options, sourceType: adapter.sourceType };
    const sourceLabel = `${adapter.name}: ${options.filename} @ ${now}`;
    let batch = preparedBatch;
    try {
      batch ??= adapter.ingest({
        buffer, format: options.format, filename: options.filename, entityType: options.entityType,
      });
      assertAmazonReportType(adapter.sourceType, batch.detectedType, batch.entityType);
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法解析文件';
      this.database.prepare(`
        INSERT INTO data_tasks (
          id, name, source_id, task_type, target, source, marketplace, status, started_at,
          completed_at, total, success, failed, error_log, created_at
        ) VALUES (?, ?, ?, 'file_import', ?, ?, ?, 'failed', ?, ?, 0, 0, 1, ?, ?)
      `).run(
        taskId, `导入 ${options.filename}`, sourceId, options.filename, sourceLabel, taskMarketplace,
        now, new Date().toISOString(), message, now,
      );
      throw error;
    }

    const { entityType, rowCount } = batch;
    if (entityType === 'owned_product_master') return this.importOwnedProductMaster(batch, normalizedOptions);
    const errors: string[] = [];
    const stagedRows: StagedImportRow[] = [];
    batch.rows.forEach(({ values, rowNumber }) => {
      try {
        validateImportRow(values, entityType, normalizedOptions);
        stagedRows.push({ values, rowNumber });
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        errors.push(`第 ${rowNumber} 行：${message}`);
      }
    });

    if (entityType === 'review' && this.repository.getSettings().mode === 'demo') {
      errors.push('评论文件不能写入 Demo Research Job；请先退出 Demo 并创建真实研究任务。');
      stagedRows.length = 0;
    }

    if (stagedRows.length === 0) {
      const task = this.recordFailedImport(
        taskId, batchId, normalizedOptions, entityType, sourceId, sourceLabel, taskMarketplace,
        rowCount, errors, now,
      );
      return {
        batchId, entityType, rowCount, successCount: 0,
        failureCount: rowCount, errors, task,
      };
    }

    let successCount = 0;
    const affectedMarketIds = new Set<string>();
    const affectedProductIds = new Set<string>();
    const analyzableMarketIds = new Set<string>();
    try {
      transaction(this.database, () => {
        this.database.prepare(`
          INSERT INTO data_tasks (
            id, name, source_id, task_type, target, source, marketplace, status, started_at,
            total, success, failed, created_at
          ) VALUES (?, ?, ?, 'file_import', ?, ?, ?, 'running', ?, 0, 0, 0, ?)
        `).run(
          taskId, `导入 ${options.filename}`, sourceId, options.filename, sourceLabel,
          taskMarketplace, now, now,
        );
        stagedRows.forEach(({ values: row, rowNumber }) => {
          this.database.exec('SAVEPOINT import_row');
          try {
            if (entityType === 'product') {
              const imported = this.importProduct(row, normalizedOptions, sourceLabel);
              affectedProductIds.add(imported.productId);
              affectedMarketIds.add(imported.marketNodeId);
            } else if (entityType === 'market') {
              affectedMarketIds.add(this.importMarket(row, normalizedOptions, sourceLabel));
            } else {
              this.importReview(row, normalizedOptions, sourceLabel, adapter.id);
            }
            this.database.exec('RELEASE SAVEPOINT import_row');
            successCount += 1;
          } catch (error) {
            this.database.exec('ROLLBACK TO SAVEPOINT import_row');
            this.database.exec('RELEASE SAVEPOINT import_row');
            const message = error instanceof Error ? error.message : '未知错误';
            errors.push(`第 ${rowNumber} 行：${message}`);
          }
        });

        if (successCount === 0) throw new AllImportRowsFailedError('所有导入行均写入失败。');

        affectedMarketIds.forEach((marketId) => {
          if (this.reconcileMarketData(marketId)) analyzableMarketIds.add(marketId);
        });

        const completedAt = new Date().toISOString();
        const failureCount = rowCount - successCount;
        const status = successCount === 0 ? 'failed' : failureCount > 0 ? 'partial' : 'success';
        this.database.prepare(`
          UPDATE data_tasks SET status = ?, completed_at = ?, total = ?, success = ?, failed = ?,
            error_log = ? WHERE id = ?
        `).run(status, completedAt, rowCount, successCount, failureCount, errors.length ? errors.join('\n') : null, taskId);
        this.database.prepare(`
          INSERT INTO import_batches (
            id, filename, format, entity_type, row_count, success_count, failure_count,
            errors_json, task_id, imported_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          batchId, options.filename, options.format, entityType, rowCount, successCount,
          failureCount, JSON.stringify(errors), taskId, completedAt,
        );
        if (successCount > 0) {
          this.database.prepare(`
            UPDATE app_settings SET last_successful_sync = ? WHERE id = 1
          `).run(completedAt);
          this.database.prepare('UPDATE data_sources SET last_sync_at = ? WHERE id = ?').run(completedAt, sourceId);
        }
      });
    } catch (error) {
      if (error instanceof AllImportRowsFailedError) {
        const task = this.recordFailedImport(
          taskId, batchId, normalizedOptions, entityType, sourceId, sourceLabel, taskMarketplace,
          rowCount, errors, now,
        );
        return {
          batchId, entityType, rowCount, successCount: 0,
          failureCount: rowCount, errors, task,
        };
      }
      const message = error instanceof Error ? error.message : '无法解析文件';
      this.recordFailedImport(
        taskId, batchId, normalizedOptions, entityType, sourceId, sourceLabel, taskMarketplace,
        rowCount, [...errors, message], now,
      );
      throw error;
    }

    const task = this.repository.getDataTask(taskId);
    if (!task) throw new Error('导入任务记录未创建。');
    analyzableMarketIds.forEach((marketId) => {
      const marketOwner = this.database.prepare(`
        SELECT marketplace FROM market_nodes WHERE id = ?
      `).get(marketId) as { marketplace: string } | undefined;
      if (marketOwner?.marketplace !== this.repository.getSettings().marketplace) return;
      this.ai.analyze({ entityType: 'market', entityId: marketId });
      const projectRows = this.database.prepare(`
        SELECT id FROM development_projects WHERE market_node_id = ? AND marketplace = ?
      `).all(marketId, this.repository.getSettings().marketplace) as Array<{ id: string }>;
      projectRows.forEach((row) => this.ai.analyze({ entityType: 'development_project', entityId: row.id }));
      const opportunityRows = this.database.prepare(`
        SELECT id FROM opportunities WHERE market_node_id = ? AND marketplace = ? AND evidence_json <> '[]'
      `).all(marketId, this.repository.getSettings().marketplace) as Array<{ id: string }>;
      opportunityRows.forEach((row) => this.ai.analyze({ entityType: 'opportunity', entityId: row.id }));
    });
    affectedProductIds.forEach((productId) => this.regenerateAffectedProductInsights(productId));
    return {
      batchId,
      entityType,
      rowCount,
      successCount,
      failureCount: rowCount - successCount,
      errors,
      task,
    };
  }

  private importOwnedProductMaster(batch: FileImportBatch, options: ImportOptions): ImportResult {
    const taskId = randomUUID();
    const batchId = randomUUID();
    const now = new Date().toISOString();
    const sourceId = options.sourceType === 'amazon' ? 'source-amazon-import' : 'source-sellersprite-import';
    const adapter = this.adapters.getFile(sourceId);
    const sourceLabel = `${adapter.name}: ${options.filename} @ ${now}`;
    const errors: string[] = [];
    const successfulRows: Array<{ rowNumber: number; asin: string; sku: string }> = [];
    const ownedMasterGuard = new OwnedMasterBatchGuard();
    let successCount = 0;

    transaction(this.database, () => {
      this.database.prepare(`
        INSERT INTO data_tasks (
          id, name, source_id, task_type, target, source, marketplace, status, started_at,
          total, success, failed, created_at
        ) VALUES (?, ?, ?, 'file_import', ?, ?, ?, 'running', ?, 0, 0, 0, ?)
      `).run(
        taskId, `导入 ${options.filename}`, sourceId, options.filename, sourceLabel,
        this.repository.getSettings().marketplace, now, now,
      );
      for (const row of batch.rows) {
        this.database.exec('SAVEPOINT import_owned_master_row');
        try {
          validateImportRow(row.values, 'owned_product_master', options);
          const identity = ownedMasterGuard.check(row.values);
          this.importOwnedProductMasterRow(row.values, options);
          this.database.exec('RELEASE SAVEPOINT import_owned_master_row');
          ownedMasterGuard.accept(identity, row.rowNumber);
          successfulRows.push({
            rowNumber: row.rowNumber,
            asin: requiredString(row.values, ['asin']).toUpperCase(),
            sku: requiredString(row.values, ['sku']),
          });
          successCount += 1;
        } catch (error) {
          this.database.exec('ROLLBACK TO SAVEPOINT import_owned_master_row');
          this.database.exec('RELEASE SAVEPOINT import_owned_master_row');
          errors.push(`第 ${row.rowNumber} 行：${error instanceof Error ? error.message : '未知错误'}`);
        }
      }
      const completedAt = new Date().toISOString();
      const failureCount = batch.rowCount - successCount;
      const status = successCount === 0 ? 'failed' : failureCount > 0 ? 'partial' : 'success';
      this.database.prepare(`
        UPDATE data_tasks SET status = ?, completed_at = ?, total = ?, success = ?, failed = ?, error_log = ?
        WHERE id = ?
      `).run(status, completedAt, batch.rowCount, successCount, failureCount, errors.length ? errors.join('\n') : null, taskId);
      this.database.prepare(`
        INSERT INTO import_batches (
          id, filename, format, entity_type, row_count, success_count, failure_count,
          errors_json, task_id, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batchId, options.filename, options.format, 'owned_product_master', batch.rowCount,
        successCount, failureCount, JSON.stringify({ errors, successfulRows }), taskId, completedAt,
      );
      if (successCount > 0) {
        this.database.prepare('UPDATE data_sources SET last_sync_at = ? WHERE id = ?').run(completedAt, sourceId);
      }
    });
    const task = this.repository.getDataTask(taskId);
    if (!task) throw new Error('导入任务记录未创建。');
    return {
      batchId,
      entityType: 'owned_product_master',
      rowCount: batch.rowCount,
      successCount,
      failureCount: batch.rowCount - successCount,
      errors,
      task,
    };
  }

  private importOwnedProductMasterRow(row: ImportRow, options: ImportOptions): void {
    const marketplace = requiredString(row, ['marketplace']).toUpperCase();
    this.assertActiveMarketplace(marketplace);
    const asin = requiredString(row, ['asin']).toUpperCase();
    const sku = requiredString(row, ['sku']);
    const parentAsin = optionalString(row, ['parentasin'])?.toUpperCase() ?? null;
    const variationTheme = optionalString(row, ['variationtheme']) ?? null;
    const marketNodeId = this.ensureMarketNode(
      undefined,
      requiredString(row, ['marketnode']),
      marketplace,
    );
    const now = new Date().toISOString();
    const identity = this.identity.resolve({ marketplace, asin, sku, parentAsin: parentAsin ?? undefined, variationTheme: variationTheme ?? undefined });
    const variationFamilyId = identity.variationFamilyId;
    if (variationFamilyId) {
      this.database.prepare(`
        UPDATE variation_families SET variation_theme = ?, updated_at = ? WHERE id = ?
      `).run(variationTheme, now, variationFamilyId);
    }
    const values = [
      sku,
      requiredString(row, ['internalname']),
      requiredString(row, ['brand']),
      requiredString(row, ['title']),
      requiredString(row, ['producttype']),
      marketNodeId,
      options.sourceType ?? 'import',
      parentAsin,
      asin === parentAsin ? 1 : 0,
      variationFamilyId,
      requiredBoolean(row, ['monitoringenabled']) ? 1 : 0,
      requiredProductStatus(row),
      now,
    ];
    if (identity.productId) {
      const ownershipClause = identity.disposition === 'created'
        ? 'is_owned = 1'
        : 'is_owned = CASE WHEN is_owned = 0 THEN 1 ELSE is_owned END';
      this.database.prepare(`
        UPDATE products SET ${ownershipClause}, sku = ?, internal_name = ?, brand = ?, title = ?, product_type = ?, market_node_id = ?,
          source_type = ?, parent_asin = ?, is_parent = ?, variation_family_id = ?, monitoring_enabled = ?,
          status = ?, updated_at = ? WHERE id = ?
      `).run(...values, identity.productId);
      return;
    }
    this.database.prepare(`
      INSERT INTO products (
        id, asin, sku, internal_name, brand, title, image_url, marketplace, product_type, is_owned,
        market_node_id, keywords_json, monitoring_enabled, source_type, created_at, status, updated_at,
        variation_family_id, parent_asin, is_parent, variation_attributes_json
      ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, 1, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, '{}')
    `).run(randomUUID(), asin, sku, requiredString(row, ['internalname']), requiredString(row, ['brand']),
      requiredString(row, ['title']), marketplace, requiredString(row, ['producttype']), marketNodeId,
      requiredBoolean(row, ['monitoringenabled']) ? 1 : 0, options.sourceType ?? 'import', now,
      requiredProductStatus(row), now, variationFamilyId, parentAsin, asin === parentAsin ? 1 : 0);
  }

  private isDuplicatePreviewRow(row: ImportRow, entityType: ImportEntityType, options: ImportOptions): boolean {
    const marketplace = (optionalString(row, ['marketplace', 'market']) ?? options.marketplace ?? this.repository.getSettings().marketplace).toUpperCase();
    if (entityType === 'product') {
      const asin = optionalString(row, [isAmazonBusinessReportRow(row, options) ? 'childasin' : 'asin'])?.toUpperCase();
      const sku = optionalString(row, ['sku'])?.toUpperCase();
      const date = isAmazonBusinessReportRow(row, options) ? options.reportEndDate : optionalImportDate(row);
      const period = isAmazonBusinessReportRow(row, options)
        ? `${options.reportStartDate}/${options.reportEndDate}`
        : optionalString(row, ['period', '周期']) ?? '30D';
      if (!date || (!asin && !sku)) return false;
      const product = this.database.prepare(`
        SELECT id FROM products WHERE marketplace = ? AND (asin = ? OR (sku IS NOT NULL AND UPPER(sku) = ?))
      `).get(marketplace, asin ?? '', sku ?? '') as { id: string } | undefined;
      if (product && isAmazonBusinessReportRow(row, options)) {
        this.assertAmazonReportObservationIsUnchanged(product.id, row, options);
      }
      return Boolean(product && this.hasSnapshotObservation(
        'product', product.id, date, options.sourceType ?? 'import', period,
      ));
    }
    if (entityType === 'market') {
      const id = optionalString(row, ['marketnodeid', 'marketid', 'market_node_id']) ?? options.marketNodeId;
      const name = optionalString(row, ['marketname', 'name', 'category', '市场名称']);
      const date = optionalImportDate(row);
      const period = optionalString(row, ['period', '周期']) ?? '30D';
      if (!date) return false;
      const market = id
        ? this.database.prepare('SELECT id FROM market_nodes WHERE id = ? AND marketplace = ?').get(id, marketplace)
        : this.database.prepare('SELECT id FROM market_nodes WHERE name = ? AND marketplace = ?').get(name ?? '导入市场', marketplace);
      const marketId = (market as { id: string } | undefined)?.id;
      return Boolean(marketId && this.hasSnapshotObservation(
        'market', marketId, date, options.sourceType ?? 'import', period,
      ));
    }
    return false;
  }

  private classifyOwnedMasterPreviewRow(row: ImportRow): 'new' | 'update' | 'duplicate' {
    const marketplace = requiredString(row, ['marketplace']).toUpperCase();
    this.assertActiveMarketplace(marketplace);
    const asin = requiredString(row, ['asin']).toUpperCase();
    const sku = requiredString(row, ['sku']);
    const select = `
      SELECT p.id, p.asin, p.sku, p.internal_name, p.brand, p.title, p.product_type,
        p.is_owned, p.parent_asin, p.is_parent, p.monitoring_enabled, p.status,
        m.name AS market_name, f.variation_theme
      FROM products p
      JOIN market_nodes m ON m.id = p.market_node_id
      LEFT JOIN variation_families f ON f.id = p.variation_family_id
      WHERE p.marketplace = ? AND `;
    interface ExistingMaster {
      id: string; asin: string; sku: string | null; internal_name: string | null;
      brand: string; title: string; product_type: string; is_owned: number;
      parent_asin: string | null; is_parent: number; monitoring_enabled: number;
      status: string; market_name: string; variation_theme: string | null;
    }
    const byAsin = this.database.prepare(`${select}UPPER(p.asin) = ?`).get(marketplace, asin) as ExistingMaster | undefined;
    const bySku = this.database.prepare(`${select}UPPER(p.sku) = ?`).get(marketplace, sku.toUpperCase()) as ExistingMaster | undefined;
    if (byAsin && bySku && byAsin.id !== bySku.id) {
      throw new Error('ASIN 与 SKU 分别匹配不同产品，拒绝合并身份。');
    }
    if (!byAsin && bySku) throw new Error('新 ASIN 不能覆盖已存在 SKU 的产品身份。');
    const existing = byAsin;
    if (!existing) return 'new';
    const parentAsin = optionalString(row, ['parentasin'])?.toUpperCase() ?? null;
    const variationTheme = parentAsin ? optionalString(row, ['variationtheme']) ?? null : null;
    const unchanged = existing.is_owned === 1 && existing.sku === sku
      && existing.internal_name === requiredString(row, ['internalname'])
      && existing.brand === requiredString(row, ['brand'])
      && existing.title === requiredString(row, ['title'])
      && existing.product_type === requiredString(row, ['producttype'])
      && existing.market_name === requiredString(row, ['marketnode'])
      && existing.parent_asin === parentAsin
      && existing.is_parent === Number(asin === parentAsin)
      && existing.variation_theme === variationTheme
      && existing.monitoring_enabled === Number(requiredBoolean(row, ['monitoringenabled']))
      && existing.status === requiredProductStatus(row);
    return unchanged ? 'duplicate' : 'update';
  }

  private hasSnapshotObservation(
    entityType: 'market' | 'product', entityId: string, date: string,
    sourceType: 'import' | 'amazon', period: string,
  ): boolean {
    const table = entityType === 'product' ? 'product_snapshots' : 'market_snapshots';
    const idColumn = entityType === 'product' ? 'product_id' : 'market_node_id';
    return Boolean(this.database.prepare(`
      SELECT 1 FROM ${table}
      WHERE ${idColumn} = ? AND LOWER(TRIM(source_type)) = ?
        AND LOWER(TRIM(period)) = ? AND COALESCE(observation_date, date) = ?
      LIMIT 1
    `).get(entityId, sourceType, period.trim().toLowerCase(), date));
  }

  private assertAmazonReportObservationIsUnchanged(
    productId: string, row: ImportRow, options: ImportOptions,
  ): void {
    const snapshot = amazonReportSnapshotInput(row, options);
    const period = `${options.reportStartDate}/${options.reportEndDate}`;
    const existing = this.database.prepare(`
      SELECT estimated_sales, estimated_revenue FROM product_snapshots
      WHERE product_id = ? AND source_type = 'amazon'
        AND observation_date = ? AND period = ? LIMIT 1
    `).get(productId, snapshot.date, period) as {
      estimated_sales: number | null;
      estimated_revenue: number | null;
    } | undefined;
    if (existing && (existing.estimated_sales !== snapshot.estimatedSales
      || existing.estimated_revenue !== snapshot.estimatedRevenue)) {
      throw new Error('Amazon 报表与已有相同站点、子 ASIN 和日期范围的 Snapshot 数值冲突；历史记录不可覆盖。');
    }
  }

  private assertProductIdentityIsConsistent(
    row: ImportRow,
    entityType: ImportEntityType,
    options: ImportOptions,
  ): void {
    if (entityType !== 'product') return;
    const marketplace = (optionalString(row, ['marketplace', 'market'])
      ?? options.marketplace
      ?? this.repository.getSettings().marketplace).toUpperCase();
    const asin = requiredString(row, [isAmazonBusinessReportRow(row, options) ? 'childasin' : 'asin']).toUpperCase();
    const sku = optionalString(row, ['sku']);
    if (!sku) return;
    const asinProduct = this.database.prepare(`
      SELECT id FROM products WHERE marketplace = ? AND asin = ?
    `).get(marketplace, asin) as { id: string } | undefined;
    const skuProduct = this.database.prepare(`
      SELECT id FROM products WHERE marketplace = ? AND UPPER(sku) = ?
    `).get(marketplace, sku.toUpperCase()) as { id: string } | undefined;
    if (asinProduct && skuProduct && asinProduct.id !== skuProduct.id) {
      throw new Error('ASIN 与 SKU 分别匹配不同产品，拒绝合并身份。');
    }
  }

  private deleteExpiredPreviews(): void {
    const now = Date.now();
    for (const [token, staged] of this.stagedPreviews) {
      if (Date.parse(staged.preview.expiresAt) <= now) this.stagedPreviews.delete(token);
    }
  }

  private evictForPreview(incomingBytes: number): void {
    while (
      this.stagedPreviews.size >= MAX_STAGED_PREVIEWS
      || this.stagedPreviewBytes() + incomingBytes > MAX_STAGED_BYTES
    ) {
      const oldest = this.stagedPreviews.keys().next().value as string | undefined;
      if (!oldest) break;
      this.stagedPreviews.delete(oldest);
    }
    if (this.stagedPreviewBytes() + incomingBytes > MAX_STAGED_BYTES) {
      throw new Error('预览暂存容量已满，请稍后重试。');
    }
  }

  private stagedPreviewBytes(): number {
    return [...this.stagedPreviews.values()].reduce((total, staged) => total + staged.buffer.length, 0);
  }

  private recordFailedImport(
    taskId: string,
    batchId: string,
    options: ImportOptions,
    entityType: ImportEntityType,
    sourceId: string,
    sourceLabel: string,
    marketplace: string,
    rowCount: number,
    errors: string[],
    startedAt: string,
  ): DataTask {
    const completedAt = new Date().toISOString();
    const errorLog = errors.join('\n') || '所有导入行均失败。';
    transaction(this.database, () => {
      this.database.prepare(`
        INSERT INTO data_tasks (
          id, name, source_id, task_type, target, source, marketplace, status, started_at,
          completed_at, total, success, failed, error_log, created_at
        ) VALUES (?, ?, ?, 'file_import', ?, ?, ?, 'failed', ?, ?, ?, 0, ?, ?, ?)
      `).run(
        taskId, `导入 ${options.filename}`, sourceId, options.filename, sourceLabel, marketplace,
        startedAt, completedAt, rowCount, rowCount, errorLog, startedAt,
      );
      this.database.prepare(`
        INSERT INTO import_batches (
          id, filename, format, entity_type, row_count, success_count, failure_count,
          errors_json, task_id, imported_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `).run(
        batchId, options.filename, options.format, entityType, rowCount, rowCount,
        JSON.stringify(errors), taskId, completedAt,
      );
    });
    const task = this.repository.getDataTask(taskId);
    if (!task) throw new Error('导入失败任务未创建。');
    return task;
  }

  private reconcileMarketData(marketId: string): boolean {
    const market = this.repository.getMarket(marketId);
    if (!market || market.trends.length === 0) return false;
    const now = new Date().toISOString();
    const calculationInput = completeMarketOpportunityInput(market);
    if (!calculationInput) {
      const status = market.node.growth30dAvailable
        ? '市场快照字段不完整'
        : '等待30D对照';
      this.database.prepare('UPDATE market_nodes SET status = ? WHERE id = ?').run(status, marketId);
      return false;
    }
    const calculated = calculateMarketOpportunityMetrics(calculationInput);
    const {
      avgPrice, growth30d, medianPrice, monthlyRevenue, monthlySales, productCount,
    } = calculationInput;
    this.database.prepare(`
      UPDATE market_nodes SET status = ?, competition_score = ?, opportunity_score = ? WHERE id = ?
    `).run(
      calculated.opportunityScore >= 65 ? '值得研究' : '继续观察',
      calculated.competitionScore, calculated.opportunityScore, marketId,
    );

    this.database.prepare(`
      UPDATE data_tasks SET status = 'success', started_at = COALESCE(started_at, ?),
        completed_at = ?, total = 1, success = 1, failed = 0, error_log = NULL
      WHERE task_type = 'opportunity_research' AND target = ? AND status = 'pending'
    `).run(now, now, marketId);

    const projects = this.database.prepare(`
      SELECT id FROM development_projects WHERE market_node_id = ? AND marketplace = ?
    `).all(marketId, market.node.marketplace) as Array<{ id: string }>;
    for (const project of projects) {
      const existingDecision = this.database.prepare(`
        SELECT decision FROM decisions
        WHERE entity_type = 'development_project' AND entity_id = ?
        ORDER BY decided_at DESC LIMIT 1
      `).get(project.id) as { decision: string } | undefined;
      this.database.prepare(`
        UPDATE development_projects SET market_size = ?, growth_30d = ?, competition_score = ?,
          opportunity_score = ?, score_breakdown_json = ?, status = ?, updated_at = ? WHERE id = ?
      `).run(
        monthlyRevenue, growth30d, calculated.competitionScore,
        calculated.opportunityScore, JSON.stringify(calculated.breakdown),
        existingDecision?.decision ?? 'watch', now, project.id,
      );
      this.database.prepare(`
        UPDATE data_tasks SET status = 'success', started_at = COALESCE(started_at, ?),
          completed_at = ?, total = 1, success = 1, failed = 0, error_log = NULL
        WHERE task_type = 'development_research' AND target = ? AND status = 'pending'
      `).run(now, now, project.id);
    }

    const priceFloor = Math.max(0, Math.round(medianPrice * 0.8));
    const priceCeiling = Math.round(medianPrice * 1.2);
    const evidence = [{
      id: randomUUID(),
      claim: `${market.node.name} 真实导入数据机会分 ${calculated.opportunityScore}`,
      metrics: [
        { name: 'opportunity_score', label: '机会评分', value: calculated.opportunityScore },
        { name: 'market_30d_growth', label: '市场 30D 增长', value: growth30d, unit: '%' },
        { name: 'competition_score', label: '竞争强度', value: calculated.competitionScore },
      ],
      provenance: [market.provenance],
    }];
    this.database.prepare(`
      UPDATE opportunities SET opportunity_score = ?, market_growth = ?, competition_score = ?,
        price_room = ?, recommended_action = ?, summary = ?, evidence_json = ?, updated_at = ?
      WHERE market_node_id = ? AND marketplace = ? AND status IN ('pending_review', 'researching')
    `).run(
      calculated.opportunityScore, growth30d, calculated.competitionScore,
      `$${priceFloor}-${priceCeiling}`,
      calculated.opportunityScore >= 65 ? '进入机会池审核' : '继续观察并补充验证',
      `基于真实导入快照：月销售额 ${monthlyRevenue.toLocaleString()}，30D 增长 ${growth30d}%，机会分 ${calculated.opportunityScore}。`,
      JSON.stringify(evidence), now, marketId, market.node.marketplace,
    );

    const researchRows = this.database.prepare(`
      SELECT id, nodes_json FROM research_results
    `).all() as Array<{ id: string; nodes_json: string }>;
    for (const result of researchRows) {
      const nodes = JSON.parse(result.nodes_json) as Array<Record<string, unknown>>;
      const target = nodes.find((node) => node.id === marketId);
      if (!target) continue;
      Object.assign(target, {
        status: '已完成真实数据采集',
        monthlySales,
        monthlyRevenue,
        growth30d,
        growth30dAvailable: true,
        productCount,
        avgPrice,
        competitionScore: calculated.competitionScore,
        opportunityScore: calculated.opportunityScore,
        taskStatus: 'success',
      });
      this.database.prepare(`UPDATE research_results SET nodes_json = ? WHERE id = ?`)
        .run(JSON.stringify(nodes), result.id);
    }
    return true;
  }

  private regenerateAffectedProductInsights(productId: string): void {
    const product = this.database.prepare(`
      SELECT id, is_owned, marketplace FROM products WHERE id = ?
    `).get(productId) as { id: string; is_owned: number; marketplace: string } | undefined;
    if (product?.marketplace !== this.repository.getSettings().marketplace) return;
    const ownedIds = new Set<string>();
    if (product?.is_owned === 1) ownedIds.add(product.id);
    const relations = this.database.prepare(`
      SELECT owned_product_id AS id FROM competitor_relations WHERE competitor_product_id = ?
    `).all(productId) as Array<{ id: string }>;
    relations.forEach((relation) => ownedIds.add(relation.id));
    ownedIds.forEach((id) => this.ai.analyze({ entityType: 'owned_product', entityId: id }));
  }

  private importProduct(
    row: ImportRow,
    options: ImportOptions,
    sourceLabel: string,
  ): { productId: string; marketNodeId: string } {
    const reportRow = isAmazonBusinessReportRow(row, options);
    const asin = requiredString(row, [reportRow ? 'childasin' : 'asin']).toUpperCase();
    const sku = optionalString(row, ['sku']);
    const marketplace = (optionalString(row, ['marketplace', 'market'])
      ?? options.marketplace
      ?? this.repository.getSettings().marketplace).toUpperCase();
    this.assertActiveMarketplace(marketplace);
    // Parse the entire observation before creating or updating any entity. A partial
    // snapshot must never turn an unknown metric into a trusted numeric zero.
    const snapshot = productSnapshotInput(row, options);
    const identity = this.identity.resolve({
      marketplace, asin, sku,
      parentAsin: reportRow ? optionalString(row, ['parentasin']) : undefined,
    });
    if (!identity.productId) throw new Error('产品身份解析未返回产品 ID。');
    if (reportRow) this.assertAmazonReportObservationIsUnchanged(identity.productId, row, options);
    const existing = this.database.prepare(`
      SELECT id, is_owned, monitoring_enabled, keywords_json, market_node_id
      FROM products WHERE id = ?
    `).get(identity.productId) as {
      id: string;
      is_owned: number;
      monitoring_enabled: number;
      keywords_json: string;
      market_node_id: string;
    } | undefined;
    if (!existing) throw new Error('产品身份解析后的产品不存在。');
    const requestedMarketId = optionalString(row, ['marketnodeid', 'marketid', 'market_node_id']) ?? options.marketNodeId;
    const requestedMarketName = optionalString(row, ['marketname', 'category', 'market_name']);
    const marketNodeId = identity.disposition === 'existing' && !requestedMarketId && !requestedMarketName
      ? existing.market_node_id
      : this.ensureMarketNode(requestedMarketId, requestedMarketName ?? '导入市场', marketplace);
    const productId = identity.productId;
    const explicitOwned = optionalBoolean(row, ['isowned', 'owned', 'is_owned']);
    const isOwned = reportRow ? true : explicitOwned ?? (identity.disposition === 'created'
      ? Boolean(sku)
      : existing.is_owned === 1);
    const explicitMonitoring = optionalBoolean(row, ['monitoringenabled', 'monitoring_enabled']);
    const monitoringEnabled = explicitMonitoring
      ?? (existing ? existing.monitoring_enabled === 1 : isOwned);
    const rawKeywords = valueFrom(row, ['keywords', '关键词']);
    const keywordsJson = rawKeywords === undefined && existing
      ? existing.keywords_json
      : JSON.stringify(optionalList(row, ['keywords', '关键词']));
    const collectedAt = new Date().toISOString();
    const period = reportRow
      ? `${options.reportStartDate}/${options.reportEndDate}`
      : optionalString(row, ['period', '周期']) ?? '30D';

    this.database.prepare(`
      UPDATE products SET
        sku = COALESCE(?, sku), internal_name = COALESCE(?, internal_name),
        brand = COALESCE(NULLIF(?, ''), brand), title = COALESCE(NULLIF(?, ''), title),
        image_url = COALESCE(NULLIF(?, ''), image_url), product_type = COALESCE(NULLIF(?, ''), product_type),
        is_owned = ?, market_node_id = ?, keywords_json = ?, monitoring_enabled = ?, source_type = ?, updated_at = ?
      WHERE id = ?
    `).run(
      sku ?? null,
      optionalString(row, ['internalname', 'internal_name', '内部名称']) ?? null,
      optionalString(row, ['brand', '品牌']) ?? '',
      optionalString(row, ['title', '标题']) ?? '',
      optionalString(row, ['imageurl', 'image_url', '主图']) ?? '',
      optionalString(row, ['producttype', 'product_type', '产品类型']) ?? '',
      isOwned ? 1 : 0,
      marketNodeId,
      keywordsJson,
      monitoringEnabled ? 1 : 0,
      options.sourceType ?? 'import',
      collectedAt,
      productId,
    );
    this.deleteUnusedIdentityPlaceholderMarket(marketplace);

    const sourceType = options.sourceType ?? 'import';
    if (!this.hasSnapshotObservation('product', productId, snapshot.date, sourceType, period)) {
      this.database.prepare(`
        INSERT OR IGNORE INTO product_snapshots (
          id, product_id, date, price, rating, review_count, bsr, estimated_sales,
          estimated_revenue, seller_count, growth_7d, growth_30d, growth_90d,
          source, source_type, collected_at, period, is_estimated, confidence, observation_date, dedup_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), productId, snapshot.date, snapshot.price, snapshot.rating,
        snapshot.reviewCount, snapshot.bsr, snapshot.estimatedSales, snapshot.estimatedRevenue,
        snapshot.sellerCount, snapshot.growth7d, snapshot.growth30d, snapshot.growth90d,
        sourceLabel, sourceType, collectedAt,
        period,
        snapshot.isEstimated ? 1 : 0, snapshot.confidence,
        snapshot.date, importSnapshotDedupKey('product', marketplace, productId, snapshot.date, sourceType, period),
      );
    }
    return { productId, marketNodeId };
  }

  private deleteUnusedIdentityPlaceholderMarket(marketplace: string): void {
    const id = `identity-unassigned-${marketplace}`;
    this.database.prepare(`
      DELETE FROM market_nodes
      WHERE id = ? AND NOT EXISTS (SELECT 1 FROM products WHERE market_node_id = ?)
    `).run(id, id);
  }

  private importMarket(row: ImportRow, options: ImportOptions, sourceLabel: string): string {
    const marketplace = optionalString(row, ['marketplace'])
      ?? options.marketplace
      ?? this.repository.getSettings().marketplace;
    this.assertActiveMarketplace(marketplace);
    const marketName = optionalString(row, ['marketname', 'name', 'category', '市场名称']) ?? '导入市场';
    const snapshot = marketSnapshotInput(row);
    const marketNodeId = this.ensureMarketNode(
      optionalString(row, ['marketnodeid', 'marketid', 'market_node_id']) ?? options.marketNodeId,
      marketName,
      marketplace,
    );
    const collectedAt = new Date().toISOString();
    const period = optionalString(row, ['period', '周期']) ?? '30D';
    const sourceType = options.sourceType ?? 'import';
    if (!this.hasSnapshotObservation('market', marketNodeId, snapshot.date, sourceType, period)) {
      this.database.prepare(`
        INSERT OR IGNORE INTO market_snapshots (
          id, market_node_id, date, product_count, seller_count, brand_count, monthly_sales,
          monthly_revenue, avg_price, median_price, avg_rating, median_reviews, top10_share,
          top20_share, new_product_share, price_bands_json, concentration_json, source,
          source_type, collected_at, period, is_estimated, confidence, observation_date, dedup_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), marketNodeId, snapshot.date, snapshot.productCount, snapshot.sellerCount,
        snapshot.brandCount, snapshot.monthlySales, snapshot.monthlyRevenue, snapshot.avgPrice,
        snapshot.medianPrice, snapshot.avgRating, snapshot.medianReviews, snapshot.top10Share,
        snapshot.top20Share, snapshot.newProductShare,
        JSON.stringify(snapshot.priceBands), JSON.stringify(snapshot.concentration),
        sourceLabel, sourceType, collectedAt,
        period,
        snapshot.isEstimated ? 1 : 0, snapshot.confidence,
        snapshot.date, importSnapshotDedupKey('market', marketplace, marketNodeId, snapshot.date, sourceType, period),
      );
    }
    return marketNodeId;
  }

  private importReview(
    row: ImportRow,
    options: ImportOptions,
    sourceLabel: string,
    adapterId: string,
  ): void {
    const review = reviewImportInput(row, options);
    const marketplace = optionalString(row, ['marketplace', 'market'])
      ?? options.marketplace
      ?? this.repository.getSettings().marketplace;
    this.assertActiveMarketplace(marketplace);
    const job = this.database.prepare(`
      SELECT id, status, job_type FROM research_jobs WHERE id = ? AND marketplace = ?
    `).get(review.researchJobId, marketplace) as { id: string; status: string; job_type: string } | undefined;
    if (!job) throw new Error(`Research Job ${review.researchJobId} 不存在或不属于当前站点。`);
    if (!['adjacent_product', 'new_opportunity'].includes(job.job_type)) {
      throw new Error(`Research Job ${review.researchJobId} 不是支持 Review Gap 的产品研究任务。`);
    }
    if (!['draft', 'planned', 'needs_data'].includes(job.status)) {
      throw new Error(`Research Job ${review.researchJobId} 当前为 ${job.status}，不能追加本轮评论。`);
    }
    const existing = this.database.prepare(`
      SELECT id FROM reviews WHERE research_job_id = ? AND source_record_id = ? LIMIT 1
    `).get(job.id, review.sourceRecordId);
    if (existing) throw new Error(`评论来源记录 ${review.sourceRecordId} 已导入，历史记录不会被覆盖。`);

    const localProduct = this.database.prepare(`
      SELECT id FROM products
      WHERE marketplace = ? AND (id = ? OR asin = ?)
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1
    `).get(marketplace, review.productReference, review.productReference, review.productReference) as { id: string } | undefined;
    const collectedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO reviews (
        id, research_job_id, product_id, external_review_id, review_text, rating,
        review_date, source, source_record_id, collected_at, normalized_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), job.id, localProduct?.id ?? null, review.sourceRecordId, review.text,
      review.rating, review.date, sourceLabel, review.sourceRecordId, collectedAt,
      JSON.stringify({
        productId: review.productReference,
        marketplace,
        adapterId,
        sourceType: options.sourceType,
        rating: review.rating,
        reviewDate: review.date,
      }),
    );
  }

  private ensureMarketNode(id: string | undefined, name: string, marketplace: string): string {
    if (id) {
      const existing = this.database.prepare(`
        SELECT id, marketplace FROM market_nodes WHERE id = ?
      `).get(id) as { id: string; marketplace: string } | undefined;
      if (existing) {
        if (existing.marketplace !== marketplace) {
          throw new Error(`MarketNode ID「${id}」已属于 ${existing.marketplace} 站点，不能关联到 ${marketplace}。`);
        }
        return id;
      }
    }
    const byName = this.database.prepare(`
      SELECT id FROM market_nodes WHERE name = ? AND marketplace = ? LIMIT 1
    `).get(name, marketplace) as { id: string } | undefined;
    if (byName) return byName.id;
    const marketId = id ?? randomUUID();
    this.database.prepare(`
      INSERT INTO market_nodes (
        id, name, parent_id, level, marketplace, keywords_json, status,
        competition_score, opportunity_score, source_type, created_at
      ) VALUES (?, ?, NULL, 1, ?, '[]', '待分析', NULL, NULL, 'import', ?)
    `).run(marketId, name, marketplace, new Date().toISOString());
    const settings = this.repository.getSettings();
    if (!settings.defaultMarketId && settings.marketplace === marketplace) {
      this.database.prepare('UPDATE app_settings SET default_market_id = ? WHERE id = 1').run(marketId);
    }
    return marketId;
  }

  private assertActiveMarketplace(marketplace: string): void {
    const activeMarketplace = this.repository.getSettings().marketplace;
    if (marketplace !== activeMarketplace) {
      throw new Error(`导入行站点 ${marketplace} 与当前工作区站点 ${activeMarketplace} 不一致。`);
    }
  }
}

function completeMarketOpportunityInput(market: MarketDetail): CompleteMarketMetrics | null {
  const {
    avgPrice,
    avgRating,
    brandCount,
    medianPrice,
    medianReviews,
    monthlyRevenue,
    monthlySales,
    newProductShare,
    productCount,
    sellerCount,
    top10Share,
    top20Share,
  } = market.kpis;
  const growth30d = market.node.growth30d;
  const confidence = market.provenance.confidence;
  if (
    !market.node.growth30dAvailable
    || !isFiniteNumber(avgPrice)
    || !isFiniteNumber(avgRating)
    || !isFiniteNumber(brandCount)
    || !isFiniteNumber(growth30d)
    || !isFiniteNumber(medianPrice)
    || !isFiniteNumber(medianReviews)
    || !isFiniteNumber(monthlyRevenue)
    || !isFiniteNumber(monthlySales)
    || !isFiniteNumber(newProductShare)
    || !isFiniteNumber(productCount)
    || !isFiniteNumber(sellerCount)
    || !isFiniteNumber(top10Share)
    || !isFiniteNumber(top20Share)
    || !isFiniteNumber(confidence)
  ) return null;
  return {
    avgPrice,
    avgRating,
    brandCount,
    confidence,
    growth30d,
    medianPrice,
    medianReviews,
    monthlyRevenue,
    monthlySales,
    newProductShare,
    productCount,
    sellerCount,
    top10Share,
    top20Share,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function valueFrom(row: ImportRow, names: string[]): unknown {
  for (const name of names) {
    const value = row[normalizeKey(name)];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return undefined;
}

function optionalString(row: ImportRow, names: string[]): string | undefined {
  const value = valueFrom(row, names);
  return value === undefined ? undefined : String(value).trim();
}

function requiredString(row: ImportRow, names: string[]): string {
  const value = optionalString(row, names);
  if (!value) throw new Error(`缺少必填字段 ${names[0]}。`);
  return value;
}

function optionalNumber(row: ImportRow, names: string[]): number | undefined {
  const value = valueFrom(row, names);
  if (value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const normalized = String(value).replace(/[$,¥€£\s]/g, '').replace(/%$/, '');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requiredNumber(row: ImportRow, names: string[]): number {
  const value = optionalNumber(row, names);
  if (value === undefined) throw new Error(`缺少或无法解析字段 ${names[0]}。`);
  return value;
}

function requiredNumberInRange(
  row: ImportRow,
  names: string[],
  minimum: number,
  maximum = Number.POSITIVE_INFINITY,
): number {
  const value = requiredNumber(row, names);
  if (value < minimum || value > maximum) {
    throw new Error(`字段 ${names[0]} 必须在 ${minimum} 到 ${maximum} 之间。`);
  }
  return value;
}

function optionalBoolean(row: ImportRow, names: string[]): boolean | undefined {
  const value = valueFrom(row, names);
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['true', 'yes', '1', 'y', '是'].includes(normalized)) return true;
  if (['false', 'no', '0', 'n', '否'].includes(normalized)) return false;
  return undefined;
}

function requiredBoolean(row: ImportRow, names: string[]): boolean {
  const value = optionalBoolean(row, names);
  if (value === undefined) throw new Error(`缺少或无法解析字段 ${names[0]}。`);
  return value;
}

function requiredProductStatus(row: ImportRow): 'active' | 'inactive' {
  const status = requiredString(row, ['status']).toLowerCase();
  if (status === 'active' || status === 'inactive') return status;
  throw new Error('字段 status 必须为 active 或 inactive。');
}

function optionalList(row: ImportRow, names: string[]): string[] {
  const value = valueFrom(row, names);
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value).split(/[,;，；|]/).map((item) => item.trim()).filter(Boolean);
}

function requiredDate(row: ImportRow): string {
  const value = requiredString(row, ['date', 'snapshotdate', '日期']);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('字段 date 不是有效日期。');
  return parsed.toISOString().slice(0, 10);
}

function isAmazonBusinessReportRow(row: ImportRow, options: ImportOptions): boolean {
  return options.sourceType === 'amazon' && Object.hasOwn(row, 'childasin')
    && (Object.hasOwn(row, 'unitsordered') || Object.hasOwn(row, 'unitsorderedtotal'))
    && (Object.hasOwn(row, 'orderedproductsales') || Object.hasOwn(row, 'orderedproductsalestotal'));
}

function amazonReportSnapshotInput(row: ImportRow, options: ImportOptions): ProductSnapshotInput {
  if (!options.marketplace) throw new Error('Amazon Business Report 必须指定 marketplace。');
  const start = requiredIsoDate(options.reportStartDate, 'reportStartDate');
  const end = requiredIsoDate(options.reportEndDate, 'reportEndDate');
  if (start > end) throw new Error('reportStartDate 不得晚于 reportEndDate。');
  requiredString(row, ['childasin']);
  return {
    date: end,
    price: null, rating: null, reviewCount: null, bsr: null,
    estimatedSales: requiredAmazonReportNumber(row, ['unitsordered', 'unitsorderedtotal'], 'Units Ordered', true),
    estimatedRevenue: requiredAmazonReportNumber(row, ['orderedproductsales', 'orderedproductsalestotal'], 'Ordered Product Sales'),
    sellerCount: null, growth7d: null, growth30d: null, growth90d: null,
    isEstimated: false, confidence: 1,
  };
}

function requiredIsoDate(value: string | undefined, field: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} 必须是有效的 YYYY-MM-DD 日期。`);
  }
  return value;
}

function requiredAmazonReportNumber(row: ImportRow, names: string[], label: string, integer = false): number {
  const raw = valueFrom(row, names);
  const formatted = raw === undefined ? '' : String(raw).trim().replace(/[$¥€£\s]/g, '');
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(formatted)) {
    throw new Error(`${label} 必须是非负数字。`);
  }
  const value = Number(formatted.replaceAll(',', ''));
  if (!Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${label} 必须是非负${integer ? '整数' : '数字'}。`);
  }
  return value;
}

function productSnapshotInput(row: ImportRow, options: ImportOptions): ProductSnapshotInput {
  if (isAmazonBusinessReportRow(row, options)) return amazonReportSnapshotInput(row, options);
  const price = requiredNumberInRange(row, ['price', '价格'], 0);
  const estimatedSales = requiredNumberInRange(
    row, ['estimatedsales', 'monthlysales', 'sales', '月销量'], 0,
  );
  return {
    date: requiredDate(row),
    price,
    rating: requiredNumberInRange(row, ['rating', '评分'], 0, 5),
    reviewCount: requiredNumberInRange(row, ['reviewcount', 'reviews', '评论数'], 0),
    bsr: requiredNumberInRange(row, ['bsr', '排名'], 0),
    estimatedSales,
    estimatedRevenue: optionalNumber(row, ['estimatedrevenue', 'monthlyrevenue', 'revenue', '月销售额'])
      ?? price * estimatedSales,
    sellerCount: requiredNumberInRange(row, ['sellercount', 'seller_count', '卖家数'], 0),
    growth7d: requiredNumber(row, ['growth7d', '7dgrowth', 'growth_7d']),
    growth30d: requiredNumber(row, ['growth30d', '30dgrowth', 'growth_30d']),
    growth90d: requiredNumber(row, ['growth90d', '90dgrowth', 'growth_90d']),
    isEstimated: requiredBoolean(row, ['isestimated', 'is_estimated']),
    confidence: requiredNumberInRange(row, ['confidence', '置信度'], 0, 1),
  };
}

function marketSnapshotInput(row: ImportRow): MarketSnapshotInput {
  const monthlySales = requiredNumberInRange(row, ['monthlysales', 'sales', '月销量'], 0);
  const avgPrice = requiredNumberInRange(row, ['avgprice', 'averageprice', '平均价格'], 0);
  return {
    date: requiredDate(row),
    productCount: requiredNumberInRange(row, ['productcount', 'product_count', '产品数'], 0),
    sellerCount: requiredNumberInRange(row, ['sellercount', 'seller_count', '卖家数'], 0),
    brandCount: requiredNumberInRange(row, ['brandcount', 'brand_count', '品牌数'], 0),
    monthlySales,
    monthlyRevenue: optionalNumber(row, ['monthlyrevenue', 'revenue', '月销售额'])
      ?? monthlySales * avgPrice,
    avgPrice,
    medianPrice: requiredNumberInRange(row, ['medianprice', 'median_price', '中位价格'], 0),
    avgRating: requiredNumberInRange(row, ['avgrating', 'avg_rating', '平均评分'], 0, 5),
    medianReviews: requiredNumberInRange(
      row, ['medianreviews', 'median_reviews', 'reviewmedian', '评论中位数'], 0,
    ),
    top10Share: requiredNumberInRange(row, ['top10share', 'top10_share'], 0, 100),
    top20Share: requiredNumberInRange(row, ['top20share', 'top20_share'], 0, 100),
    newProductShare: requiredNumberInRange(row, ['newproductshare', 'new_product_share'], 0, 100),
    priceBands: optionalJsonArray(
      row,
      ['pricebands', 'price_bands', 'pricebandsjson', 'price_bands_json', '价格带JSON'],
      'PriceBands',
      parsePriceBand,
    ),
    concentration: optionalJsonArray(
      row,
      ['concentration', 'concentrationjson', 'concentration_json', '集中度JSON'],
      'Concentration',
      parseConcentration,
    ),
    isEstimated: requiredBoolean(row, ['isestimated', 'is_estimated']),
    confidence: requiredNumberInRange(row, ['confidence', '置信度'], 0, 1),
  };
}

function optionalJsonArray<T>(
  row: ImportRow,
  names: string[],
  label: string,
  parseItem: (value: unknown, index: number) => T,
): T[] {
  const raw = valueFrom(row, names);
  if (raw === undefined) return [];
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`字段 ${label} 不是有效 JSON。`);
    }
  }
  if (!Array.isArray(parsed)) throw new Error(`字段 ${label} 必须是 JSON 数组。`);
  return parsed.map(parseItem);
}

function parsePriceBand(value: unknown, index: number): PriceBandInput {
  const record = structuredJsonRecord(value, 'PriceBands', index);
  return {
    label: structuredString(record, 'label', 'PriceBands', index),
    productCount: structuredNumber(record, 'productCount', 'PriceBands', index, 0),
    monthlySales: structuredNumber(record, 'monthlySales', 'PriceBands', index, 0),
    revenue: structuredNumber(record, 'revenue', 'PriceBands', index, 0),
    avgReviews: structuredNumber(record, 'avgReviews', 'PriceBands', index, 0),
    newProducts: structuredNumber(record, 'newProducts', 'PriceBands', index, 0),
    growth: structuredNumber(record, 'growth', 'PriceBands', index),
  };
}

function parseConcentration(value: unknown, index: number): ConcentrationInput {
  const record = structuredJsonRecord(value, 'Concentration', index);
  return {
    tier: structuredString(record, 'tier', 'Concentration', index),
    share: structuredNumber(record, 'share', 'Concentration', index, 0, 100),
    avgPrice: structuredNumber(record, 'avgPrice', 'Concentration', index, 0),
    avgSales: structuredNumber(record, 'avgSales', 'Concentration', index, 0),
  };
}

function structuredJsonRecord(
  value: unknown,
  label: string,
  index: number,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`字段 ${label}[${index}] 必须是 JSON 对象。`);
  }
  return value as Record<string, unknown>;
}

function structuredString(
  record: Record<string, unknown>,
  field: string,
  label: string,
  index: number,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`字段 ${label}[${index}].${field} 必须是非空字符串。`);
  }
  return value.trim();
}

function structuredNumber(
  record: Record<string, unknown>,
  field: string,
  label: string,
  index: number,
  minimum = Number.NEGATIVE_INFINITY,
  maximum = Number.POSITIVE_INFINITY,
): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`字段 ${label}[${index}].${field} 必须是 ${minimum} 到 ${maximum} 之间的数字。`);
  }
  return value;
}

function reviewImportInput(row: ImportRow, options: ImportOptions) {
  const rowJobId = optionalString(row, ['researchjobid', 'jobid', 'research_job_id']);
  if (rowJobId && options.researchJobId && rowJobId !== options.researchJobId) {
    throw new Error(`字段 researchJobId 与导入目标 ${options.researchJobId} 不一致。`);
  }
  const researchJobId = options.researchJobId ?? rowJobId;
  if (!researchJobId) throw new Error('评论导入必须指定 researchJobId。');
  const rawRating = valueFrom(row, ['rating', '评分']);
  const rating = optionalNumber(row, ['rating', '评分']);
  if (rawRating !== undefined && (rating === undefined || rating < 0 || rating > 5)) {
    throw new Error('字段 rating 必须是 0 到 5 之间的数字。');
  }
  const rawDate = optionalString(row, ['date', 'reviewdate', '评论日期']);
  let date: string | null = null;
  if (rawDate) {
    const parsed = new Date(rawDate);
    if (Number.isNaN(parsed.getTime())) throw new Error('字段 date 不是有效日期。');
    date = parsed.toISOString().slice(0, 10);
  }
  return {
    researchJobId,
    sourceRecordId: requiredString(row, ['reviewid', 'externalreviewid', '评论ID', 'id']),
    productReference: requiredString(row, ['productid', 'asin', 'competitorid', '产品ID']),
    text: requiredString(row, ['reviewtext', 'reviewbody', 'text', 'comment', '评论正文']),
    rating: rating ?? null,
    date,
  };
}

function validateImportRow(
  row: ImportRow,
  entityType: ImportEntityType,
  options: ImportOptions,
): void {
  if (entityType === 'owned_product_master') {
    requiredString(row, ['marketplace']);
    requiredString(row, ['asin']);
    requiredString(row, ['sku']);
    requiredString(row, ['internalname']);
    requiredString(row, ['brand']);
    requiredString(row, ['title']);
    requiredString(row, ['producttype']);
    requiredString(row, ['marketnode']);
    requiredBoolean(row, ['monitoringenabled']);
    requiredProductStatus(row);
    return;
  }
  if (entityType === 'product') {
    productSnapshotInput(row, options);
    if (!isAmazonBusinessReportRow(row, options)) requiredString(row, ['asin']);
    return;
  }
  if (entityType === 'market') {
    marketSnapshotInput(row);
    return;
  }
  reviewImportInput(row, options);
}

function normalizeExplicitEntityType(value: string | undefined): ImportEntityType | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'owned_product_master') return 'owned_product_master';
  if (normalized === 'product' || normalized === 'sellersprite_product' || normalized === 'amazon_business_report') return 'product';
  if (normalized === 'market' || normalized === 'sellersprite_market') return 'market';
  if (normalized === 'review') return 'review';
  throw new Error(`不支持的确认导入类型：${value}。`);
}

function assertAmazonReportType(
  sourceType: 'import' | 'amazon' | undefined,
  detectedType: FileImportDetectedType,
  entityType: ImportEntityType,
): void {
  if (sourceType === 'amazon' && (entityType === 'product' || entityType === 'market')
    && detectedType !== 'amazon_business_report') {
    throw new Error('Amazon 数据源的销量必须使用可识别的按子 ASIN Business Report 报表。');
  }
}

function importSnapshotDedupKey(
  entityType: 'market' | 'product', marketplace: string, entityId: string,
  observationDate: string, sourceType: 'import' | 'amazon', period: string,
): string {
  const sourceId = sourceType === 'amazon' ? 'source-amazon-import' : 'source-sellersprite-import';
  return [
    entityType, marketplace.trim().toLowerCase(), entityId, observationDate,
    sourceId, period.trim().toLowerCase(),
  ].join('|');
}

function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function optionalImportDate(row: ImportRow): string | undefined {
  const raw = optionalString(row, ['date', 'snapshotdate', '日期']);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

function previewRow(row: NormalizedFileImportRow): NormalizedFileImportRow {
  return {
    rowNumber: row.rowNumber,
    values: Object.fromEntries(Object.entries(row.values).map(([key, value]) => [key, previewValue(value)])),
  };
}

function previewValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

function fieldMappings(values: ImportRow): ImportFieldMapping[] {
  return Object.keys(values).map((sourceHeader) => ({
    sourceHeader,
    targetField: previewFieldName(sourceHeader),
  }));
}

function previewFieldName(value: string): string {
  const aliases: Record<string, string> = {
    childasin: 'asin', unitsordered: 'estimatedSales', unitsorderedtotal: 'estimatedSales',
    orderedproductsales: 'estimatedRevenue', orderedproductsalestotal: 'estimatedRevenue',
    internalname: 'internalName', parentasin: 'parentAsin', variationtheme: 'variationTheme',
    marketnode: 'marketNode', monitoringenabled: 'monitoringEnabled', producttype: 'productType',
    marketnodeid: 'marketNodeId', reviewcount: 'reviewCount', estimatedsales: 'estimatedSales',
    sellercount: 'sellerCount', growth7d: 'growth7d', growth30d: 'growth30d', growth90d: 'growth90d',
    isestimated: 'isEstimated', productcount: 'productCount', brandcount: 'brandCount',
    monthlysales: 'monthlySales', avgprice: 'avgPrice', medianprice: 'medianPrice',
    avgrating: 'avgRating', medianreviews: 'medianReviews', top10share: 'top10Share',
    top20share: 'top20Share', newproductshare: 'newProductShare',
  };
  return aliases[value] ?? value;
}
