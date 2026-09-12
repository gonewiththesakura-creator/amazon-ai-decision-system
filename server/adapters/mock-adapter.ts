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
    const previous = input.previousSnapshot;
    const seededSales = Math.round(18_000 + fraction(seed, 2) * 110_000);
    const seededPrice = Math.round((22 + fraction(seed, 7) * 38) * 100) / 100;
    const seededTop10Share = Math.round((24 + fraction(seed, 11) * 30) * 10) / 10;
    const seededTop20Share = Math.round(
      Math.min(82, seededTop10Share + 14 + fraction(seed, 15) * 12) * 10,
    ) / 10;
    const monthlySales = previous?.monthlySales !== null && previous?.monthlySales !== undefined
      ? Math.round(previous.monthlySales * 1.003)
      : seededSales;
    const avgPrice = previous?.avgPrice ?? seededPrice;
    const top10Share = previous?.top10Share ?? seededTop10Share;
    const top20Share = previous?.top20Share ?? seededTop20Share;
    const defaultPriceBands: MarketOverviewRecord['priceBands'] = [
      { label: '< $30', productCount: 74, monthlySales: Math.round(monthlySales * 0.24), revenue: Math.round(monthlySales * 0.24 * 24), avgReviews: 420, newProducts: 12, growth: 2.4 },
      { label: '$30-49', productCount: 96, monthlySales: Math.round(monthlySales * 0.52), revenue: Math.round(monthlySales * 0.52 * 39), avgReviews: 760, newProducts: 18, growth: 8.1 },
      { label: '$50+', productCount: 43, monthlySales: Math.round(monthlySales * 0.24), revenue: Math.round(monthlySales * 0.24 * 61), avgReviews: 1_240, newProducts: 7, growth: 4.6 },
    ];
    const defaultConcentration: MarketOverviewRecord['concentration'] = [
      { tier: 'Top 10', share: top10Share, avgPrice, avgSales: Math.round(monthlySales * top10Share / 1_000) },
      { tier: 'Top 20', share: top20Share, avgPrice, avgSales: Math.round(monthlySales * top20Share / 2_000) },
    ];
    return {
      productCount: previous?.productCount ?? Math.round(120 + fraction(seed, 1) * 1_100),
      sellerCount: previous?.sellerCount ?? Math.round(80 + fraction(seed, 4) * 700),
      brandCount: previous?.brandCount ?? Math.round(45 + fraction(seed, 8) * 380),
      monthlySales,
      monthlyRevenue: Math.round(monthlySales * avgPrice * 100) / 100,
      avgPrice,
      medianPrice: previous?.medianPrice ?? Math.round(avgPrice * 0.94 * 100) / 100,
      avgRating: previous?.avgRating ?? Math.round((4.1 + fraction(seed, 13) * 0.35) * 100) / 100,
      medianReviews: previous?.medianReviews ?? Math.round(180 + fraction(seed, 17) * 1_400),
      top10Share,
      top20Share,
      newProductShare: previous?.newProductShare
        ?? Math.round((7 + fraction(seed, 21) * 18) * 10) / 10,
      priceBands: previous?.priceBands ?? defaultPriceBands,
      concentration: previous?.concentration ?? defaultConcentration,
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
    const generated = this.productFromSeed(input.asin, input.marketplace, 'unassigned', provenance);
    const previous = input.previousSnapshot?.snapshotAvailable ? input.previousSnapshot : null;
    const price = previous?.price ?? generated.latest.price;
    const previousSales = previous?.estimatedSales;
    const estimatedSales = previousSales !== null && previousSales !== undefined
      ? Math.round(previousSales * 1.002)
      : generated.latest.estimatedSales;
    const latest: ProductSnapshot = previous ? {
      ...generated.latest,
      date: provenance.collectedAt.slice(0, 10),
      price,
      rating: previous.rating ?? generated.latest.rating,
      reviewCount: previous.reviewCount ?? generated.latest.reviewCount,
      bsr: previous.bsr ?? generated.latest.bsr,
      estimatedSales,
      estimatedRevenue: price !== null && estimatedSales !== null
        ? Math.round(price * estimatedSales * 100) / 100
        : generated.latest.estimatedRevenue,
      sellerCount: previous.sellerCount ?? generated.latest.sellerCount,
      growth7d: previous.growth7d ?? generated.latest.growth7d,
      growth30d: previous.growth30d ?? generated.latest.growth30d,
      growth30dAvailable: previous.growth30dAvailable || generated.latest.growth30dAvailable,
      growth90d: previous.growth90d ?? generated.latest.growth90d,
      provenance,
    } : generated.latest;
    return {
      ...generated,
      asin: input.asin,
      latest,
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
