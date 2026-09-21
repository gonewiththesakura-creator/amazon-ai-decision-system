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
import {
  ProductIdentityResolver,
  type ParentLookupStatus,
  type ProductIdentityResolution,
} from '../domain/product-identity-resolver.js';

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

type SnapshotDisposition = 'new' | 'duplicate';
type SnapshotPayload = Record<string, unknown>;

interface PreviewSnapshotObservation {
  key: string;
  label: string;
  payload: SnapshotPayload;
}

type StagedImportRow = NormalizedFileImportRow;

class AllImportRowsFailedError extends Error {}

class ImportIntegrityError extends Error {
  readonly status = 409;
}

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
  ownedMasterPreconditions?: Map<number, OwnedMasterPrecondition>;
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
    familyKey?: string;
    parentLookupStatus?: ParentLookupStatus;
    variationTheme?: string;
    sourceType?: string;
    importBatchId?: string;
  }): ProductIdentityResolution;
}

interface OwnedMasterBatchIdentity {
  asinKey: string;
  skuKey: string;
  familyKey: string | null;
  parentAsin: string | null;
  variationTheme: string | null;
}

interface OwnedMasterIdentityInput {
  parentAsin: string | null;
  familyKey: string | null;
  parentLookupStatus: ParentLookupStatus;
  variationTheme: string | null;
}

type OwnedMasterDisposition = 'new' | 'update' | 'duplicate';

interface OwnedMasterPrecondition {
  disposition: OwnedMasterDisposition;
  productId: string | null;
  productDigest: string | null;
  targetMarketDigest: string | null;
  targetFamilyDigest: string | null;
}

interface OwnedMasterInspection {
  disposition: OwnedMasterDisposition;
  precondition: OwnedMasterPrecondition;
}

interface ExistingProductIdentity {
  id: string;
  is_owned: number;
  status: string;
  source_type: string;
  is_demo: number;
}

class OwnedMasterBatchGuard {
  private readonly asins = new Map<string, number>();
  private readonly skus = new Map<string, number>();
  private readonly families = new Map<string, {
    rowNumber: number;
    parentAsin: string | null;
    variationTheme: string | null;
  }>();
  private readonly parents = new Map<string, { rowNumber: number; familyKey: string }>();

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
    const identity = ownedMasterIdentityInput(row);
    const familyKey = identity.familyKey
      ?? (identity.parentAsin && identity.parentAsin !== requiredString(row, ['asin']).toUpperCase()
        ? identity.parentAsin : null);
    return {
      asinKey,
      skuKey,
      familyKey: familyKey ? JSON.stringify([marketplace, familyKey]) : null,
      parentAsin: identity.parentAsin,
      variationTheme: identity.variationTheme,
    };
  }

  accept(identity: OwnedMasterBatchIdentity, rowNumber: number): void {
    let familyUpdate: { key: string; value: {
      rowNumber: number;
      parentAsin: string | null;
      variationTheme: string | null;
    } } | undefined;
    let parentUpdate: { key: string; value: { rowNumber: number; familyKey: string } } | undefined;
    if (identity.familyKey) {
      const prior = this.families.get(identity.familyKey);
      if (prior?.parentAsin && identity.parentAsin && prior.parentAsin !== identity.parentAsin) {
        throw new Error(`同一文件中的 Variation Family 已在第 ${prior.rowNumber} 行绑定不同 parent ASIN。`);
      }
      if (prior?.variationTheme && identity.variationTheme
        && prior.variationTheme !== identity.variationTheme) {
        throw new Error(`同一文件中的 Variation Family 已在第 ${prior.rowNumber} 行使用不同 variationTheme。`);
      }
      const familyKeyValue = JSON.parse(identity.familyKey) as [string, string];
      if (identity.parentAsin) {
        const parentKey = JSON.stringify([familyKeyValue[0], identity.parentAsin]);
        const priorParent = this.parents.get(parentKey);
        if (priorParent && priorParent.familyKey !== identity.familyKey) {
          throw new Error(`同一文件中的 parent ASIN 已在第 ${priorParent.rowNumber} 行绑定不同 Variation Family。`);
        }
        parentUpdate = { key: parentKey, value: { rowNumber, familyKey: identity.familyKey } };
      }
      familyUpdate = {
        key: identity.familyKey,
        value: {
          rowNumber: prior?.rowNumber ?? rowNumber,
          parentAsin: prior?.parentAsin ?? identity.parentAsin,
          variationTheme: prior?.variationTheme ?? identity.variationTheme,
        },
      };
    }
    this.asins.set(identity.asinKey, rowNumber);
    this.skus.set(identity.skuKey, rowNumber);
    if (familyUpdate) this.families.set(familyUpdate.key, familyUpdate.value);
    if (parentUpdate) this.parents.set(parentUpdate.key, parentUpdate.value);
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
    const ownedMasterPreconditions = new Map<number, OwnedMasterPrecondition>();
    const snapshotObservations = new Map<string, { rowNumber: number; label: string; payload: SnapshotPayload }>();
    for (const row of batch.rows) {
      try {
        if (!entityType) throw new Error('未知文件类型必须由操作员选择。');
        validateImportRow(row.values, entityType, options);
        this.assertProductIdentityIsConsistent(row.values, entityType, options);
        if (entityType === 'owned_product_master') {
          const identity = ownedMasterGuard.check(row.values);
          const inspection = this.inspectOwnedMasterPreviewRow(row.values);
          const disposition = inspection.disposition;
          ownedMasterGuard.accept(identity, row.rowNumber);
          if (disposition === 'duplicate') duplicateCount += 1;
          else if (disposition === 'update') updateCount += 1;
          else validCount += 1;
          ownedMasterPreconditions.set(row.rowNumber, inspection.precondition);
        } else {
          const observation = this.previewSnapshotObservation(row.values, entityType, options);
          const prior = observation ? snapshotObservations.get(observation.key) : undefined;
          if (observation && prior) {
            const differences = snapshotPayloadDifferences(prior.payload, observation.payload);
            if (differences.length > 0) {
              throw new Error(
                `与第 ${prior.rowNumber} 行的相同 ${observation.label} 身份数值冲突（字段：${differences.join('、')}）；历史 Snapshot 不可覆盖。`,
              );
            }
            duplicateCount += 1;
          } else {
            if (this.isDuplicatePreviewRow(row.values, entityType, options)) duplicateCount += 1;
            else validCount += 1;
            if (observation) snapshotObservations.set(observation.key, {
              rowNumber: row.rowNumber,
              label: observation.label,
              payload: observation.payload,
            });
          }
        }
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
      ownedMasterPreconditions: entityType === 'owned_product_master'
        ? ownedMasterPreconditions
        : undefined,
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
    if (entityType === 'owned_product_master' && staged.preview.errorCount > 0) {
      throw new ImportIntegrityError(
        `产品主数据必须整批通过校验；当前 ${staged.preview.totalCount} 行中有 ${staged.preview.errorCount} 行被拒绝，未写入任何产品。请修正文件并重新预览。`,
      );
    }
    if (hashBuffer(staged.buffer) !== staged.hash) throw new Error('导入预览校验失败。');
    const batch = { ...staged.batch, entityType };
    const result = this.import(
      staged.buffer,
      { ...staged.options, entityType },
      batch,
      staged.ownedMasterPreconditions,
    );
    staged.confirmed = result;
    return result;
  }

  import(
    buffer: Buffer,
    options: ImportOptions,
    preparedBatch?: FileImportBatch,
    ownedMasterPreconditions?: Map<number, OwnedMasterPrecondition>,
  ): ImportResult {
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
    if (entityType === 'owned_product_master') {
      return this.importOwnedProductMaster(batch, normalizedOptions, ownedMasterPreconditions);
    }
    const errors: string[] = [];
    const stagedRows: StagedImportRow[] = [];
    batch.rows.forEach(({ values, rowNumber }) => {
      try {
        validateImportRow(values, entityType, normalizedOptions);
        this.assertProductIdentityIsConsistent(values, entityType, normalizedOptions);
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
    const result: ImportResult = {
      batchId,
      entityType,
      rowCount,
      successCount,
      failureCount: rowCount - successCount,
      errors,
      task,
    };
    try {
      transaction(this.database, () => {
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
      });
    } catch {
      this.recordPostImportAnalysisFailure({
        batchId,
        filename: options.filename,
        marketplace: taskMarketplace,
        sourceId,
        sourceLabel,
      });
    }
    return result;
  }

  private importOwnedProductMaster(
    batch: FileImportBatch,
    options: ImportOptions,
    expectedPreconditions?: Map<number, OwnedMasterPrecondition>,
  ): ImportResult {
    const taskId = randomUUID();
    const batchId = randomUUID();
    const now = new Date().toISOString();
    const sourceId = options.sourceType === 'amazon' ? 'source-amazon-import' : 'source-sellersprite-import';
    const adapter = this.adapters.getFile(sourceId);
    const sourceLabel = `${adapter.name}: ${options.filename} @ ${now}`;
    const successfulRows: Array<{ rowNumber: number; asin: string; sku: string }> = [];
    const dispositions = new Map<number, OwnedMasterDisposition>();

    transaction(this.database, () => {
      const ownedMasterGuard = new OwnedMasterBatchGuard();
      const validationErrors: string[] = [];
      for (const row of batch.rows) {
        try {
          validateImportRow(row.values, 'owned_product_master', options);
          const identity = ownedMasterGuard.check(row.values);
          const inspection = this.inspectOwnedMasterPreviewRow(row.values);
          const expected = expectedPreconditions?.get(row.rowNumber);
          if (expectedPreconditions && (!expected
            || !sameOwnedMasterPrecondition(expected, inspection.precondition))) {
            throw new Error('产品主数据在预览后发生变化；请重新预览文件再确认。');
          }
          dispositions.set(row.rowNumber, inspection.disposition);
          ownedMasterGuard.accept(identity, row.rowNumber);
        } catch (error) {
          validationErrors.push(`第 ${row.rowNumber} 行：${error instanceof Error ? error.message : '未知错误'}`);
        }
      }
      if (validationErrors.length > 0) {
        throw new ImportIntegrityError(
          `产品主数据必须整批通过确认阶段校验，未写入任何产品：${validationErrors.join('；')}`,
        );
      }

      this.database.prepare(`
        INSERT INTO data_tasks (
          id, name, source_id, task_type, target, source, marketplace, status, started_at,
          total, success, failed, created_at
        ) VALUES (?, ?, ?, 'file_import', ?, ?, ?, 'running', ?, 0, 0, 0, ?)
      `).run(
        taskId, `导入 ${options.filename}`, sourceId, options.filename, sourceLabel,
        this.repository.getSettings().marketplace, now, now,
      );
      this.database.prepare(`
        INSERT INTO import_batches (
          id, filename, format, entity_type, row_count, success_count, failure_count,
          errors_json, task_id, imported_at
        ) VALUES (?, ?, ?, 'owned_product_master', ?, 0, 0, '[]', ?, ?)
      `).run(batchId, options.filename, options.format, batch.rowCount, taskId, now);
      for (const row of batch.rows) {
        try {
          this.importOwnedProductMasterRow(
            row.values,
            options,
            dispositions.get(row.rowNumber) ?? 'new',
            batchId,
          );
          successfulRows.push({
            rowNumber: row.rowNumber,
            asin: requiredString(row.values, ['asin']).toUpperCase(),
            sku: requiredString(row.values, ['sku']),
          });
        } catch (error) {
          throw new ImportIntegrityError(
            `产品主数据写入第 ${row.rowNumber} 行失败，整批已回滚：${error instanceof Error ? error.message : '未知错误'}`,
          );
        }
      }
      const completedAt = new Date().toISOString();
      this.database.prepare(`
        UPDATE data_tasks SET status = ?, completed_at = ?, total = ?, success = ?, failed = ?, error_log = ?
        WHERE id = ?
      `).run('success', completedAt, batch.rowCount, batch.rowCount, 0, null, taskId);
      this.database.prepare(`
        UPDATE import_batches
        SET success_count = ?, failure_count = 0, errors_json = ?, imported_at = ?
        WHERE id = ?
      `).run(batch.rowCount, JSON.stringify({ errors: [], successfulRows }), completedAt, batchId);
      if (batch.rowCount > 0) {
        this.database.prepare('UPDATE data_sources SET last_sync_at = ? WHERE id = ?').run(completedAt, sourceId);
      }
    });
    const task = this.repository.getDataTask(taskId);
    if (!task) throw new Error('导入任务记录未创建。');
    return {
      batchId,
      entityType: 'owned_product_master',
      rowCount: batch.rowCount,
      successCount: batch.rowCount,
      failureCount: 0,
      errors: [],
      task,
    };
  }

  private importOwnedProductMasterRow(
    row: ImportRow,
    options: ImportOptions,
    disposition: OwnedMasterDisposition,
    batchId: string,
  ): void {
    if (disposition === 'duplicate') return;
    const marketplace = requiredString(row, ['marketplace']).toUpperCase();
    this.assertActiveMarketplace(marketplace);
    const asin = requiredString(row, ['asin']).toUpperCase();
    const sku = requiredString(row, ['sku']);
    const identityInput = ownedMasterIdentityInput(row);
    const marketNodeId = this.ensureMarketNode(
      undefined,
      requiredString(row, ['marketnode']),
      marketplace,
    );
    const now = new Date().toISOString();
    const identity = this.identity.resolve({
      marketplace,
      asin,
      sku,
      parentAsin: identityInput.parentAsin ?? undefined,
      familyKey: identityInput.familyKey ?? undefined,
      parentLookupStatus: identityInput.parentLookupStatus,
      variationTheme: identityInput.variationTheme ?? undefined,
      sourceType: options.sourceType ?? 'import',
      importBatchId: batchId,
    });
    const variationFamilyId = identity.variationFamilyId;
    if (variationFamilyId && identityInput.variationTheme) {
      this.database.prepare(`
        UPDATE variation_families
        SET variation_theme = COALESCE(NULLIF(TRIM(?), ''), variation_theme), updated_at = ?
        WHERE id = ?
      `).run(identityInput.variationTheme, now, variationFamilyId);
    }
    const resolvedIdentity = identity.productId ? this.database.prepare(`
      SELECT variation_family_id AS variationFamilyId, parent_asin AS parentAsin,
        parent_lookup_status AS parentLookupStatus, is_parent AS isParent
      FROM products WHERE id = ?
    `).get(identity.productId) as {
      variationFamilyId: string | null;
      parentAsin: string | null;
      parentLookupStatus: ParentLookupStatus;
      isParent: number;
    } | undefined : undefined;
    const values = [
      sku,
      requiredString(row, ['internalname']),
      requiredString(row, ['brand']),
      requiredString(row, ['title']),
      requiredString(row, ['producttype']),
      marketNodeId,
      options.sourceType ?? 'import',
      resolvedIdentity?.variationFamilyId ?? variationFamilyId,
      resolvedIdentity?.parentAsin ?? null,
      resolvedIdentity?.parentLookupStatus ?? identityInput.parentLookupStatus,
      resolvedIdentity?.isParent ?? 0,
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
          source_type = ?, variation_family_id = ?, parent_asin = ?, parent_lookup_status = ?, is_parent = ?, monitoring_enabled = ?,
          status = ?, updated_at = ? WHERE id = ?
      `).run(...values, identity.productId);
      return;
    }
    this.database.prepare(`
      INSERT INTO products (
        id, asin, sku, internal_name, brand, title, image_url, marketplace, product_type, is_owned,
        market_node_id, keywords_json, monitoring_enabled, source_type, created_at, status, updated_at,
        variation_family_id, parent_asin, parent_lookup_status, is_parent, variation_attributes_json
      ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, 1, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')
    `).run(randomUUID(), asin, sku, requiredString(row, ['internalname']), requiredString(row, ['brand']),
      requiredString(row, ['title']), marketplace, requiredString(row, ['producttype']), marketNodeId,
      requiredBoolean(row, ['monitoringenabled']) ? 1 : 0, options.sourceType ?? 'import', now,
      requiredProductStatus(row), now, variationFamilyId, identityInput.parentAsin,
      identityInput.parentLookupStatus, 0);
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
      if (!product) return false;
      return this.classifyProductSnapshotObservation(
        product.id, productSnapshotInput(row, options), options.sourceType ?? 'import', period,
      ) === 'duplicate';
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
      if (!marketId) return false;
      return this.classifyMarketSnapshotObservation(
        marketId, marketSnapshotInput(row), options.sourceType ?? 'import', period,
      ) === 'duplicate';
    }
    return false;
  }

  private previewSnapshotObservation(
    row: ImportRow,
    entityType: ImportEntityType,
    options: ImportOptions,
  ): PreviewSnapshotObservation | null {
    const sourceType = options.sourceType ?? 'import';
    const marketplace = (optionalString(row, ['marketplace', 'market'])
      ?? options.marketplace
      ?? this.repository.getSettings().marketplace).toUpperCase();
    if (entityType === 'product') {
      const reportRow = isAmazonBusinessReportRow(row, options);
      const asin = requiredString(row, [reportRow ? 'childasin' : 'asin']).toUpperCase();
      const sku = optionalString(row, ['sku'])?.toUpperCase();
      const snapshot = productSnapshotInput(row, options);
      const period = reportRow
        ? `${options.reportStartDate}/${options.reportEndDate}`
        : optionalString(row, ['period', '周期']) ?? '30D';
      const product = this.database.prepare(`
        SELECT id FROM products WHERE marketplace = ? AND (asin = ? OR (sku IS NOT NULL AND UPPER(sku) = ?))
      `).get(marketplace, asin, sku ?? '') as { id: string } | undefined;
      return {
        key: importSnapshotDedupKey(
          'product', marketplace, product?.id ?? `asin:${asin}`, snapshot.date, sourceType, period,
        ),
        label: '产品 Snapshot',
        payload: productSnapshotPayload(snapshot),
      };
    }
    if (entityType === 'market') {
      const id = optionalString(row, ['marketnodeid', 'marketid', 'market_node_id']) ?? options.marketNodeId;
      const name = optionalString(row, ['marketname', 'name', 'category', '市场名称']) ?? '导入市场';
      const snapshot = marketSnapshotInput(row);
      const period = optionalString(row, ['period', '周期']) ?? '30D';
      const market = id
        ? this.database.prepare('SELECT id FROM market_nodes WHERE id = ? AND marketplace = ?').get(id, marketplace)
        : this.database.prepare('SELECT id FROM market_nodes WHERE name = ? AND marketplace = ?').get(name, marketplace);
      const marketId = (market as { id: string } | undefined)?.id ?? (id ? `id:${id}` : `name:${name.toLowerCase()}`);
      return {
        key: importSnapshotDedupKey('market', marketplace, marketId, snapshot.date, sourceType, period),
        label: '市场 Snapshot',
        payload: marketSnapshotPayload(snapshot),
      };
    }
    return null;
  }

  private inspectOwnedMasterPreviewRow(row: ImportRow): OwnedMasterInspection {
    const marketplace = requiredString(row, ['marketplace']).toUpperCase();
    this.assertActiveMarketplace(marketplace);
    const asin = requiredString(row, ['asin']).toUpperCase();
    const sku = requiredString(row, ['sku']);
    const select = `
      SELECT p.id, p.asin, p.sku, p.internal_name, p.brand, p.title, p.product_type,
        p.is_owned, p.parent_asin, p.is_parent, p.monitoring_enabled, p.status,
        p.parent_lookup_status, p.market_node_id, p.source_type, p.variation_family_id,
        p.updated_at, m.name AS market_name, f.variation_theme, f.family_key,
        f.identity_status AS family_identity_status, f.source_type AS family_source_type,
        f.parent_asin AS family_parent_asin, f.verified_at AS family_verified_at,
        f.updated_at AS family_updated_at,
        EXISTS(SELECT 1 FROM demo_seed_records seed
          WHERE seed.table_name = 'products' AND seed.record_id = p.id) AS is_demo
      FROM products p
      JOIN market_nodes m ON m.id = p.market_node_id
      LEFT JOIN variation_families f ON f.id = p.variation_family_id
      WHERE p.marketplace = ? AND `;
    interface ExistingMaster {
      id: string; asin: string; sku: string | null; internal_name: string | null;
      brand: string; title: string; product_type: string; is_owned: number;
      parent_asin: string | null; is_parent: number; monitoring_enabled: number;
      status: string; market_name: string; variation_theme: string | null;
      market_node_id: string; source_type: string; variation_family_id: string | null;
      parent_lookup_status: ParentLookupStatus; updated_at: string | null;
      family_key: string | null; family_identity_status: 'pending' | 'verified' | null;
      family_source_type: string | null; family_parent_asin: string | null;
      family_verified_at: string | null; family_updated_at: string | null;
      is_demo: number;
    }
    const byAsin = this.database.prepare(`${select}UPPER(p.asin) = ?`).get(marketplace, asin) as ExistingMaster | undefined;
    const bySku = this.database.prepare(`${select}UPPER(p.sku) = ?`).get(marketplace, sku.toUpperCase()) as ExistingMaster | undefined;
    if (byAsin && bySku && byAsin.id !== bySku.id) {
      throw new Error('ASIN 与 SKU 分别匹配不同产品，拒绝合并身份。');
    }
    if ([byAsin, bySku].some((product) => product
      && (product.source_type === 'mock' || product.is_demo === 1))) {
      throw new Error('Demo/Mock 产品身份不能复用为真实 Product Master；请单独核对迁移身份。');
    }
    if (!byAsin && bySku) throw new Error('新 ASIN 不能覆盖已存在 SKU 的产品身份。');
    const existing = byAsin;
    const identityInput = ownedMasterIdentityInput(row);
    const marketName = requiredString(row, ['marketnode']);
    const targetMarket = this.database.prepare(`
      SELECT id, source_type AS sourceType
      FROM market_nodes
      WHERE name = ? AND marketplace = ? AND source_type <> 'mock'
      ORDER BY created_at, id
      LIMIT 1
    `).get(marketName, marketplace) as { id: string; sourceType: string } | undefined;
    const targetFamilies = identityInput.familyKey || identityInput.parentAsin ? this.database.prepare(`
      SELECT id, family_key AS familyKey, parent_asin AS parentAsin,
        identity_status AS identityStatus, variation_theme AS variationTheme,
        source_type AS sourceType, verified_at AS verifiedAt, updated_at AS updatedAt
      FROM variation_families
      WHERE marketplace = ? AND (
        (? IS NOT NULL AND UPPER(TRIM(family_key)) = ?)
        OR (? IS NOT NULL AND UPPER(TRIM(parent_asin)) = ?)
      )
      ORDER BY id
    `).all(
      marketplace,
      identityInput.familyKey, identityInput.familyKey,
      identityInput.parentAsin, identityInput.parentAsin,
    ) as Array<{
      id: string;
      familyKey: string;
      parentAsin: string | null;
      identityStatus: 'pending' | 'verified';
      variationTheme: string | null;
      sourceType: string;
      verifiedAt: string | null;
      updatedAt: string;
    }> : [];
    if (new Set(targetFamilies.map((family) => family.id)).size > 1) {
      throw new Error('variationFamilyKey 与 parent ASIN 分别绑定不同族，拒绝覆盖。');
    }
    const targetFamily = targetFamilies[0];
    if (targetFamily?.identityStatus === 'verified' && identityInput.parentAsin
      && targetFamily.parentAsin !== identityInput.parentAsin) {
      throw new Error('variationFamilyKey 已绑定其他 parent ASIN，拒绝覆盖。');
    }
    if (targetFamily && identityInput.familyKey && targetFamily.familyKey !== identityInput.familyKey) {
      throw new Error('parent ASIN 已绑定其他 variationFamilyKey，拒绝覆盖。');
    }
    if (existing?.parent_lookup_status === 'verified'
      && (identityInput.parentLookupStatus !== 'verified'
        || (identityInput.parentAsin !== null
          && identityInput.parentAsin !== existing.parent_asin)
        || (identityInput.familyKey !== null
          && identityInput.familyKey !== existing.family_key))) {
      throw new Error('已验证产品身份不能降级或改绑到其他 Variation Family，拒绝覆盖。');
    }
    const expectedFamilyId = identityInput.parentLookupStatus === 'standalone'
      || identityInput.parentLookupStatus === 'unknown'
      ? null : targetFamily?.id ?? existing?.variation_family_id ?? null;
    const expectedLookupStatus = targetFamily?.identityStatus === 'verified'
      ? 'verified' : identityInput.parentLookupStatus;
    const expectedParentAsin = expectedLookupStatus === 'verified'
      ? identityInput.parentAsin ?? targetFamily?.parentAsin ?? existing?.parent_asin ?? null
      : null;
    const expectedFamilyKey = expectedFamilyId
      ? targetFamily?.familyKey ?? existing?.family_key ?? identityInput.familyKey ?? identityInput.parentAsin
      : null;
    const expectedVariationTheme = expectedFamilyId
      ? identityInput.variationTheme ?? targetFamily?.variationTheme ?? existing?.variation_theme ?? null
      : null;
    const unchanged = Boolean(existing)
      && existing!.is_owned === 1 && existing!.sku === sku
      && existing!.internal_name === requiredString(row, ['internalname'])
      && existing!.brand === requiredString(row, ['brand'])
      && existing!.title === requiredString(row, ['title'])
      && existing!.product_type === requiredString(row, ['producttype'])
      && existing!.market_name === marketName
      && existing!.parent_asin === expectedParentAsin
      && existing!.parent_lookup_status === expectedLookupStatus
      && existing!.is_parent === 0
      && existing!.variation_family_id === expectedFamilyId
      && existing!.family_key === expectedFamilyKey
      && existing!.variation_theme === expectedVariationTheme
      && existing!.monitoring_enabled === Number(requiredBoolean(row, ['monitoringenabled']))
      && existing!.status === requiredProductStatus(row);
    const disposition: OwnedMasterDisposition = !existing ? 'new' : unchanged ? 'duplicate' : 'update';
    return {
      disposition,
      precondition: {
        disposition,
        productId: existing?.id ?? null,
        productDigest: existing ? canonicalStateDigest({
          id: existing.id,
          asin: existing.asin,
          sku: existing.sku,
          internalName: existing.internal_name,
          brand: existing.brand,
          title: existing.title,
          productType: existing.product_type,
          isOwned: existing.is_owned,
          parentAsin: existing.parent_asin,
          parentLookupStatus: existing.parent_lookup_status,
          isParent: existing.is_parent,
          monitoringEnabled: existing.monitoring_enabled,
          status: existing.status,
          marketNodeId: existing.market_node_id,
          marketName: existing.market_name,
          sourceType: existing.source_type,
          variationFamilyId: existing.variation_family_id,
          familyKey: existing.family_key,
          familyIdentityStatus: existing.family_identity_status,
          familySourceType: existing.family_source_type,
          familyParentAsin: existing.family_parent_asin,
          familyVerifiedAt: existing.family_verified_at,
          familyUpdatedAt: existing.family_updated_at,
          variationTheme: existing.variation_theme,
          updatedAt: existing.updated_at,
        }) : null,
        targetMarketDigest: targetMarket ? canonicalStateDigest(targetMarket) : null,
        targetFamilyDigest: targetFamily ? canonicalStateDigest(targetFamily) : null,
      },
    };
  }

  private classifyProductSnapshotObservation(
    productId: string,
    snapshot: ProductSnapshotInput,
    sourceType: 'import' | 'amazon',
    period: string,
  ): SnapshotDisposition {
    const existing = this.database.prepare(`
      SELECT price, rating, review_count AS reviewCount, bsr,
        estimated_sales AS estimatedSales, estimated_revenue AS estimatedRevenue,
        seller_count AS sellerCount, growth_7d AS growth7d, growth_30d AS growth30d,
        growth_90d AS growth90d, is_estimated AS isEstimated, confidence
      FROM product_snapshots
      WHERE product_id = ? AND LOWER(TRIM(source_type)) = ?
        AND LOWER(TRIM(period)) = ? AND COALESCE(observation_date, date) = ?
    `).all(productId, sourceType, period.trim().toLowerCase(), snapshot.date) as SnapshotPayload[];
    return classifyStoredSnapshots('产品 Snapshot', existing, productSnapshotPayload(snapshot));
  }

  private classifyMarketSnapshotObservation(
    marketNodeId: string,
    snapshot: MarketSnapshotInput,
    sourceType: 'import' | 'amazon',
    period: string,
  ): SnapshotDisposition {
    const rows = this.database.prepare(`
      SELECT product_count AS productCount, seller_count AS sellerCount, brand_count AS brandCount,
        monthly_sales AS monthlySales, monthly_revenue AS monthlyRevenue, avg_price AS avgPrice,
        median_price AS medianPrice, avg_rating AS avgRating, median_reviews AS medianReviews,
        top10_share AS top10Share, top20_share AS top20Share, new_product_share AS newProductShare,
        price_bands_json AS priceBandsJson, concentration_json AS concentrationJson,
        is_estimated AS isEstimated, confidence
      FROM market_snapshots
      WHERE market_node_id = ? AND LOWER(TRIM(source_type)) = ?
        AND LOWER(TRIM(period)) = ? AND COALESCE(observation_date, date) = ?
    `).all(marketNodeId, sourceType, period.trim().toLowerCase(), snapshot.date) as Array<SnapshotPayload & {
      priceBandsJson: unknown;
      concentrationJson: unknown;
    }>;
    const existing = rows.map(({ priceBandsJson, concentrationJson, ...row }) => ({
      ...row,
      priceBands: parseStoredSnapshotJson(priceBandsJson),
      concentration: parseStoredSnapshotJson(concentrationJson),
    }));
    return classifyStoredSnapshots('市场 Snapshot', existing, marketSnapshotPayload(snapshot));
  }

  private assertProductIdentityIsConsistent(
    row: ImportRow,
    entityType: ImportEntityType,
    options: ImportOptions,
  ): ExistingProductIdentity | undefined {
    if (entityType !== 'product') return undefined;
    const marketplace = (optionalString(row, ['marketplace', 'market'])
      ?? options.marketplace
      ?? this.repository.getSettings().marketplace).toUpperCase();
    const asin = requiredString(row, [isAmazonBusinessReportRow(row, options) ? 'childasin' : 'asin']).toUpperCase();
    const sku = optionalString(row, ['sku']);
    const asinProduct = this.database.prepare(`
      SELECT product.id, product.is_owned, product.status, product.source_type,
        EXISTS(SELECT 1 FROM demo_seed_records seed
          WHERE seed.table_name = 'products' AND seed.record_id = product.id) AS is_demo
      FROM products product WHERE product.marketplace = ? AND UPPER(TRIM(product.asin)) = ?
    `).get(marketplace, asin) as ExistingProductIdentity | undefined;
    const skuProduct = sku ? this.database.prepare(`
      SELECT product.id, product.is_owned, product.status, product.source_type,
        EXISTS(SELECT 1 FROM demo_seed_records seed
          WHERE seed.table_name = 'products' AND seed.record_id = product.id) AS is_demo
      FROM products product WHERE product.marketplace = ? AND UPPER(TRIM(product.sku)) = ?
    `).get(marketplace, sku.toUpperCase()) as ExistingProductIdentity | undefined : undefined;
    if (asinProduct && skuProduct && asinProduct.id !== skuProduct.id) {
      throw new Error('ASIN 与 SKU 分别匹配不同产品，拒绝合并身份。');
    }
    if ([asinProduct, skuProduct].some((product) => product
      && (product.source_type === 'mock' || product.is_demo === 1))) {
      throw new Error('Demo/Mock 产品身份不能接收真实历史 Snapshot；请单独核对迁移身份。');
    }
    const existing = asinProduct ?? skuProduct;
    if (existing?.is_owned === 1 && existing.status !== 'active') {
      throw new Error('该自有 SKU 已停用；历史 Snapshot 导入不能重新激活产品，请先通过 Product Master 显式重新激活。');
    }
    return existing;
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

  private recordPostImportAnalysisFailure(input: {
    batchId: string;
    filename: string;
    marketplace: string;
    sourceId: string;
    sourceLabel: string;
  }): void {
    const now = new Date().toISOString();
    try {
      this.database.prepare(`
        INSERT INTO data_tasks (
          id, name, source_id, task_type, target, source, marketplace, status,
          started_at, completed_at, total, success, failed, error_log, created_at
        ) VALUES (?, ?, ?, 'post_import_analysis', ?, ?, ?, 'failed', ?, ?, 1, 0, 1, ?, ?)
      `).run(
        randomUUID(), `导入后分析 ${input.filename}`, input.sourceId, input.batchId,
        input.sourceLabel, input.marketplace, now, now,
        '导入已提交；导入后分析失败，需单独重试分析。', now,
      );
    } catch {
      // The import is already committed; a secondary audit failure cannot invalidate it.
    }
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
      SELECT id, is_owned, marketplace, status FROM products WHERE id = ?
    `).get(productId) as { id: string; is_owned: number; marketplace: string; status: string } | undefined;
    if (product?.marketplace !== this.repository.getSettings().marketplace) return;
    const ownedIds = new Set<string>();
    if (product?.is_owned === 1 && product.status === 'active') ownedIds.add(product.id);
    const relations = this.database.prepare(`
      SELECT relation.owned_product_id AS id
      FROM competitor_relations relation
      JOIN products owned ON owned.id = relation.owned_product_id
      WHERE relation.competitor_product_id = ?
        AND owned.is_owned = 1 AND owned.is_parent = 0 AND owned.status = 'active'
        AND owned.marketplace = ?
    `).all(productId, this.repository.getSettings().marketplace) as Array<{ id: string }>;
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
    const sourceType = options.sourceType ?? 'import';
    const period = reportRow
      ? `${options.reportStartDate}/${options.reportEndDate}`
      : optionalString(row, ['period', '周期']) ?? '30D';
    const existingIdentity = this.assertProductIdentityIsConsistent(row, 'product', options);
    const identity = this.identity.resolve({
      marketplace, asin, sku,
      parentAsin: !existingIdentity && reportRow ? optionalString(row, ['parentasin']) : undefined,
    });
    if (!identity.productId) throw new Error('产品身份解析未返回产品 ID。');
    const observationDisposition = this.classifyProductSnapshotObservation(
      identity.productId, snapshot, sourceType, period,
    );
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
    const productId = identity.productId;
    let marketNodeId = existing.market_node_id;
    const collectedAt = new Date().toISOString();
    if (identity.disposition === 'created') {
      const requestedMarketId = optionalString(row, ['marketnodeid', 'marketid', 'market_node_id'])
        ?? options.marketNodeId;
      const requestedMarketName = optionalString(row, ['marketname', 'category', 'market_name']);
      marketNodeId = this.ensureMarketNode(
        requestedMarketId,
        requestedMarketName ?? '导入市场',
        marketplace,
      );
      const explicitOwned = optionalBoolean(row, ['isowned', 'owned', 'is_owned']);
      const isOwned = reportRow ? true : explicitOwned ?? Boolean(sku);
      const monitoringEnabled = optionalBoolean(row, ['monitoringenabled', 'monitoring_enabled']) ?? isOwned;
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
        JSON.stringify(optionalList(row, ['keywords', '关键词'])),
        monitoringEnabled ? 1 : 0,
        sourceType,
        collectedAt,
        productId,
      );
      this.deleteUnusedIdentityPlaceholderMarket(marketplace);
    }

    if (observationDisposition === 'new') {
      this.database.prepare(`
        INSERT INTO product_snapshots (
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
    const observationDisposition = this.classifyMarketSnapshotObservation(
      marketNodeId, snapshot, sourceType, period,
    );
    if (observationDisposition === 'new') {
      this.database.prepare(`
        INSERT INTO market_snapshots (
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
        SELECT id, marketplace, source_type AS sourceType FROM market_nodes WHERE id = ?
      `).get(id) as { id: string; marketplace: string; sourceType: string } | undefined;
      if (existing) {
        if (existing.marketplace !== marketplace) {
          throw new Error(`MarketNode ID「${id}」已属于 ${existing.marketplace} 站点，不能关联到 ${marketplace}。`);
        }
        if (existing.sourceType === 'mock') {
          throw new Error(`MarketNode ID「${id}」属于 Demo，真实导入必须使用独立市场节点。`);
        }
        return id;
      }
    }
    const byName = this.database.prepare(`
      SELECT id, source_type AS sourceType FROM market_nodes
      WHERE name = ? AND marketplace = ?
      ORDER BY CASE WHEN source_type = 'mock' THEN 1 ELSE 0 END, created_at, id
      LIMIT 1
    `).get(name, marketplace) as { id: string; sourceType: string } | undefined;
    if (byName && byName.sourceType !== 'mock') return byName.id;
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

function productSnapshotPayload(snapshot: ProductSnapshotInput): SnapshotPayload {
  return {
    price: snapshot.price,
    rating: snapshot.rating,
    reviewCount: snapshot.reviewCount,
    bsr: snapshot.bsr,
    estimatedSales: snapshot.estimatedSales,
    estimatedRevenue: snapshot.estimatedRevenue,
    sellerCount: snapshot.sellerCount,
    growth7d: snapshot.growth7d,
    growth30d: snapshot.growth30d,
    growth90d: snapshot.growth90d,
    isEstimated: Number(snapshot.isEstimated),
    confidence: snapshot.confidence,
  };
}

function marketSnapshotPayload(snapshot: MarketSnapshotInput): SnapshotPayload {
  return {
    productCount: snapshot.productCount,
    sellerCount: snapshot.sellerCount,
    brandCount: snapshot.brandCount,
    monthlySales: snapshot.monthlySales,
    monthlyRevenue: snapshot.monthlyRevenue,
    avgPrice: snapshot.avgPrice,
    medianPrice: snapshot.medianPrice,
    avgRating: snapshot.avgRating,
    medianReviews: snapshot.medianReviews,
    top10Share: snapshot.top10Share,
    top20Share: snapshot.top20Share,
    newProductShare: snapshot.newProductShare,
    priceBands: snapshot.priceBands,
    concentration: snapshot.concentration,
    isEstimated: Number(snapshot.isEstimated),
    confidence: snapshot.confidence,
  };
}

function classifyStoredSnapshots(
  label: string,
  existing: SnapshotPayload[],
  candidate: SnapshotPayload,
): SnapshotDisposition {
  if (existing.length === 0) return 'new';
  const differences = new Set<string>();
  existing.forEach((payload) => {
    snapshotPayloadDifferences(payload, candidate).forEach((field) => differences.add(field));
  });
  if (differences.size > 0) {
    throw new Error(
      `${label} 与已有相同实体、来源、观察日期和周期的记录字段数值冲突（字段：${[...differences].join('、')}）；历史 Snapshot 不可覆盖。`,
    );
  }
  return 'duplicate';
}

function snapshotPayloadDifferences(left: SnapshotPayload, right: SnapshotPayload): string[] {
  const fields = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...fields].filter((field) => canonicalSnapshotValue(left[field]) !== canonicalSnapshotValue(right[field]));
}

function parseStoredSnapshotJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function canonicalSnapshotValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') return `number:${Object.is(value, -0) ? 0 : value}`;
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return `boolean:${value}`;
  if (Array.isArray(value)) return `array:[${value.map(canonicalSnapshotValue).join(',')}]`;
  if (typeof value === 'object') {
    return `object:{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalSnapshotValue(entry)}`)
      .join(',')}}`;
  }
  return `${typeof value}:${String(value)}`;
}

function canonicalStateDigest(value: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalSnapshotValue(value)).digest('hex');
}

function sameOwnedMasterPrecondition(
  expected: OwnedMasterPrecondition,
  actual: OwnedMasterPrecondition,
): boolean {
  return expected.disposition === actual.disposition
    && expected.productId === actual.productId
    && expected.productDigest === actual.productDigest
    && expected.targetMarketDigest === actual.targetMarketDigest
    && expected.targetFamilyDigest === actual.targetFamilyDigest;
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

function ownedMasterIdentityInput(row: ImportRow): OwnedMasterIdentityInput {
  const asin = requiredString(row, ['asin']).toUpperCase();
  const parentAsin = optionalString(row, ['parentasin'])?.toUpperCase() ?? null;
  const familyKey = optionalString(row, ['variationfamilykey', 'familykey'])?.toUpperCase() ?? null;
  const variationTheme = optionalString(row, ['variationtheme']) ?? null;
  const rawStatus = optionalString(row, ['parentlookupstatus'])?.toLowerCase();
  if (rawStatus && !['unknown', 'pending', 'verified', 'standalone'].includes(rawStatus)) {
    throw new Error('字段 parentLookupStatus 必须为 unknown、pending、verified 或 standalone。');
  }
  if (parentAsin && !/^[A-Z0-9]{10}$/.test(parentAsin)) {
    throw new Error(`parent ASIN 必须是 10 位字母数字，不能使用占位值: ${parentAsin}`);
  }
  const selfParent = parentAsin === asin;
  const parentLookupStatus = (rawStatus as ParentLookupStatus | undefined)
    ?? (selfParent ? 'standalone' : parentAsin ? 'verified' : familyKey ? 'pending' : 'unknown');

  if (selfParent) {
    if (rawStatus && rawStatus !== 'standalone') {
      throw new Error('parent ASIN 与当前 ASIN 相同时只能标记 standalone。');
    }
    if (familyKey || variationTheme) {
      throw new Error('standalone 产品不能绑定 variationFamilyKey 或 variationTheme。');
    }
    return { parentAsin: null, familyKey: null, parentLookupStatus: 'standalone', variationTheme: null };
  }
  if (parentAsin && parentLookupStatus !== 'verified') {
    throw new Error('真实 parent ASIN 只能使用 verified 查询状态。');
  }
  if (!parentAsin && parentLookupStatus === 'verified') {
    throw new Error('verified 查询状态需要真实 parent ASIN。');
  }
  if (parentLookupStatus === 'standalone' && (parentAsin || familyKey)) {
    throw new Error('familyKey 或 parent ASIN 与 standalone 查询状态冲突。');
  }
  if (parentLookupStatus === 'unknown' && (parentAsin || familyKey)) {
    throw new Error('familyKey 或 parent ASIN 与 unknown 查询状态冲突。');
  }
  if (parentLookupStatus === 'pending' && parentAsin) {
    throw new Error('pending 查询状态不能包含 parent ASIN。');
  }
  if (variationTheme && !familyKey && !parentAsin) {
    throw new Error('variationTheme 需要 variationFamilyKey 或真实 parent ASIN。');
  }
  return { parentAsin, familyKey, parentLookupStatus, variationTheme };
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
    ownedMasterIdentityInput(row);
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
    variationfamilykey: 'variationFamilyKey', parentlookupstatus: 'parentLookupStatus',
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
