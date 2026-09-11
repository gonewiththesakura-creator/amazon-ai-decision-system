import type { Product, Provenance } from '../../shared/types.js';

export interface MarketInput {
  marketId?: string;
  marketplace: string;
  keywords: string[];
}

export interface ProductInput {
  asin: string;
  marketplace: string;
}

export interface KeywordInput {
  keywords: string[];
  marketplace: string;
}

export interface MarketOverviewRecord {
  productCount: number;
  sellerCount: number;
  brandCount: number;
  monthlySales: number;
  monthlyRevenue: number;
  avgPrice: number;
  medianPrice: number;
  avgRating: number;
  medianReviews: number;
  provenance: Provenance;
}

export interface ProductDetailRecord extends Product {
  provenance: Provenance;
}

export interface KeywordDataRecord {
  keyword: string;
  monthlySearches: number;
  growth30d: number;
  competingProducts: number;
  provenance: Provenance;
}

export type FileImportFormat = 'csv' | 'xlsx';
export type FileImportEntityType = 'product' | 'market' | 'review';
export type FileImportSourceType = 'import' | 'amazon';

export interface FileImportInput {
  buffer: Buffer;
  format: FileImportFormat;
  filename: string;
  entityType?: string;
}

export interface NormalizedFileImportRow {
  rowNumber: number;
  values: Record<string, unknown>;
}

export interface FileImportBatch {
  entityType: FileImportEntityType;
  rowCount: number;
  rows: NormalizedFileImportRow[];
}

/** Boundary for third-party files before any row reaches persistence services. */
export interface FileDataAdapter extends MarketDataAdapter {
  readonly sourceType: FileImportSourceType;
  ingest(input: FileImportInput): FileImportBatch;
}

export interface MarketDataAdapter {
  readonly id: string;
  readonly name: string;
  readonly sourceType: Provenance['sourceType'];
  fetchMarketOverview(input: MarketInput): Promise<MarketOverviewRecord>;
  fetchMarketProducts(input: MarketInput): Promise<Product[]>;
  fetchProductDetail(input: ProductInput): Promise<ProductDetailRecord>;
  fetchKeywordData(input: KeywordInput): Promise<KeywordDataRecord[]>;
}

export class AdapterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterUnavailableError';
  }
}
