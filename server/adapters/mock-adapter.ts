import { createHash, randomUUID } from 'node:crypto';
import type { Product, ProductSnapshot, Provenance } from '../../shared/types.js';
import type {
  KeywordDataRecord,
  KeywordInput,
  MarketDataAdapter,
  MarketInput,
  MarketOverviewRecord,
  ProductDetailRecord,
  ProductInput,
} from './types.js';

function numericSeed(value: string): number {
  return Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16);
}

function fraction(seed: number, offset: number): number {
  return ((seed >>> (offset % 24)) % 10_000) / 10_000;
}

export class MockAdapter implements MarketDataAdapter {
  readonly id = 'source-mock';
  readonly name = '演示数据 / Mock Adapter';
  readonly sourceType = 'mock' as const;

  private provenance(period = '30D'): Provenance {
    return {
      source: this.name,
      sourceType: this.sourceType,
      collectedAt: new Date().toISOString(),
      period,
      isEstimated: true,
      confidence: 0.72,
    };
  }

  async fetchMarketOverview(input: MarketInput): Promise<MarketOverviewRecord> {
    const seed = numericSeed(`${input.marketplace}:${input.keywords.join('|')}`);
    const monthlySales = Math.round(18_000 + fraction(seed, 2) * 110_000);
    const avgPrice = Math.round((22 + fraction(seed, 7) * 38) * 100) / 100;
    return {
      productCount: Math.round(120 + fraction(seed, 1) * 1_100),
      sellerCount: Math.round(80 + fraction(seed, 4) * 700),
      brandCount: Math.round(45 + fraction(seed, 8) * 380),
      monthlySales,
      monthlyRevenue: Math.round(monthlySales * avgPrice * 100) / 100,
      avgPrice,
      medianPrice: Math.round(avgPrice * 0.94 * 100) / 100,
      avgRating: Math.round((4.1 + fraction(seed, 13) * 0.35) * 100) / 100,
      medianReviews: Math.round(180 + fraction(seed, 17) * 1_400),
      provenance: this.provenance(),
    };
  }

  async fetchMarketProducts(input: MarketInput): Promise<Product[]> {
    const overview = await this.fetchMarketOverview(input);
    return Promise.all(Array.from({ length: 8 }, (_, index) => this.productFromSeed(
      `${input.keywords.join('-')}-${index}`,
      input.marketplace,
      input.marketId ?? 'unassigned',
      overview.provenance,
    )));
  }

  async fetchProductDetail(input: ProductInput): Promise<ProductDetailRecord> {
    const provenance = this.provenance();
    return {
      ...this.productFromSeed(input.asin, input.marketplace, 'unassigned', provenance),
      asin: input.asin,
      provenance,
    };
  }

  async fetchKeywordData(input: KeywordInput): Promise<KeywordDataRecord[]> {
    return input.keywords.map((keyword) => {
      const seed = numericSeed(`${input.marketplace}:${keyword}`);
      return {
        keyword,
        monthlySearches: Math.round(1_000 + fraction(seed, 2) * 75_000),
        growth30d: Math.round((-5 + fraction(seed, 9) * 35) * 10) / 10,
        competingProducts: Math.round(80 + fraction(seed, 15) * 2_000),
        provenance: this.provenance(),
      };
    });
  }

  private productFromSeed(
    key: string,
    marketplace: string,
    marketNodeId: string,
    provenance: Provenance,
  ): Product {
    const seed = numericSeed(key);
    const price = Math.round((19 + fraction(seed, 3) * 55) * 100) / 100;
    const sales = Math.round(250 + fraction(seed, 8) * 5_000);
    const snapshot: ProductSnapshot = {
      id: randomUUID(),
      snapshotAvailable: true,
      productId: `mock-${seed}`,
      date: provenance.collectedAt.slice(0, 10),
      price,
      rating: Math.round((4 + fraction(seed, 11) * 0.7) * 10) / 10,
      reviewCount: Math.round(50 + fraction(seed, 16) * 8_000),
      bsr: Math.round(800 + fraction(seed, 19) * 32_000),
      estimatedSales: sales,
      estimatedRevenue: Math.round(sales * price * 100) / 100,
      sellerCount: 1,
      growth7d: Math.round((-8 + fraction(seed, 21) * 30) * 10) / 10,
      growth30d: Math.round((-10 + fraction(seed, 6) * 45) * 10) / 10,
      growth30dAvailable: false,
      growth90d: Math.round((-12 + fraction(seed, 14) * 60) * 10) / 10,
      provenance,
    };
    return {
      id: snapshot.productId,
      asin: `MOCK${seed.toString().slice(0, 6).padStart(6, '0')}`,
      brand: '演示品牌',
      title: `${key.replaceAll('-', ' ')} 演示产品`,
      imageUrl: '',
      marketplace,
      productType: 'mock_product',
      isOwned: false,
      marketNodeId,
      latest: snapshot,
    };
  }
}
