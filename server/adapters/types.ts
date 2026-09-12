import type { MarketDetail, Product, ProductSnapshot, Provenance } from '../../shared/types.js';

export interface MarketRefreshBaseline {
  productCount: number | null;
  sellerCount: number | null;
  brandCount: number | null;
  monthlySales: number | null;
  monthlyRevenue: number | null;
  avgPrice: number | null;
  medianPrice: number | null;
  avgRating: number | null;
  medianReviews: number | null;
  top10Share: number | null;
  top20Share: number | null;
  newProductShare: number | null;
  priceBands: MarketDetail['priceBands'];
  concentration: MarketDetail['concentration'];
}

export interface MarketInput {
  marketId?: string;
  marketplace: string;
  keywords: string[];
  previousSnapshot?: MarketRefreshBaseline;
}

export interface ProductInput {
  asin: string;
  marketplace: string;
  previousSnapshot?: ProductSnapshot;
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
  top10Share: number;
  top20Share: number;
  newProductShare: number;
  priceBands: MarketDetail['priceBands'];
  concentration: MarketDetail['concentration'];
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
