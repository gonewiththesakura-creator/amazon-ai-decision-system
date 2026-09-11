import * as XLSX from 'xlsx';
import type { Product } from '../../shared/types.js';
import type {
  FileDataAdapter,
  FileImportBatch,
  FileImportEntityType,
  FileImportInput,
  KeywordDataRecord,
  KeywordInput,
  MarketInput,
  MarketOverviewRecord,
  ProductDetailRecord,
  ProductInput,
} from './types.js';
import { AdapterUnavailableError } from './types.js';

type ImportRow = Record<string, unknown>;

abstract class FileImportAdapter implements FileDataAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly sourceType: 'import' | 'amazon';

  ingest(input: FileImportInput): FileImportBatch {
    const rows = readRows(input.buffer, input.format);
    const normalizedRows = rows.map((row, index) => ({
      rowNumber: index + 2,
      values: normalizeRow(row),
    }));
    return {
      entityType: normalizeEntityType(input.entityType, normalizedRows[0]?.values ?? {}),
      rowCount: rows.length,
      rows: normalizedRows,
    };
  }

  async fetchMarketOverview(input: MarketInput): Promise<MarketOverviewRecord> {
    void input;
    throw this.fileOnlyError();
  }

  async fetchMarketProducts(input: MarketInput): Promise<Product[]> {
    void input;
    throw this.fileOnlyError();
  }

  async fetchProductDetail(input: ProductInput): Promise<ProductDetailRecord> {
    void input;
    throw this.fileOnlyError();
  }

  async fetchKeywordData(input: KeywordInput): Promise<KeywordDataRecord[]> {
    void input;
    throw this.fileOnlyError();
  }

  private fileOnlyError(): AdapterUnavailableError {
    return new AdapterUnavailableError(`${this.name} 是文件摄取 Adapter，请使用 ingest 提交 CSV/XLSX。`);
  }
}

export class SellerSpriteImportAdapter extends FileImportAdapter {
  readonly id = 'source-sellersprite-import';
  readonly name = 'SellerSprite Import';
  readonly sourceType = 'import' as const;
}

export class AmazonImportAdapter extends FileImportAdapter {
  readonly id = 'source-amazon-import';
  readonly name = 'Amazon Report Import';
  readonly sourceType = 'amazon' as const;
}

function readRows(buffer: Buffer, format: FileImportInput['format']): ImportRow[] {
  if (buffer.length === 0) throw new Error('文件为空。');
  const workbook = XLSX.read(buffer, { type: 'buffer', raw: false, dense: false });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) throw new Error(`${format.toUpperCase()} 文件没有工作表。`);
  const worksheet = workbook.Sheets[firstSheet];
  const rows = XLSX.utils.sheet_to_json<ImportRow>(worksheet, { defval: null, raw: false });
  if (rows.length === 0) throw new Error('文件中没有可导入的数据行。');
  return rows;
}

function normalizeRow(row: ImportRow): ImportRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeKey(key), value]));
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function normalizeEntityType(value: string | undefined, firstRow: ImportRow): FileImportEntityType {
  if (value) {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'market' || normalized.includes('market')) return 'market';
    if (normalized === 'product' || normalized.includes('sku') || normalized.includes('asin')) return 'product';
    if (normalized === 'review' || normalized.includes('comment') || normalized.includes('评论')) return 'review';
    throw new Error(`不支持的导入实体类型：${value}。`);
  }
  if (
    firstRow.reviewtext !== undefined
    || firstRow.reviewbody !== undefined
    || firstRow.comment !== undefined
    || firstRow.评论正文 !== undefined
  ) return 'review';
  return firstRow.asin !== undefined || firstRow.sku !== undefined ? 'product' : 'market';
}
