// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketDetail, MarketNode, Product } from '../../shared/types';
import MarketPage from './MarketPage';

const { useApiMock } = vi.hoisted(() => ({ useApiMock: vi.fn() }));

vi.mock('../lib/AppContext', () => ({
  useApp: () => ({
    settings: {
      mode: 'demo',
      marketplace: 'US',
      currency: 'USD',
      defaultMarketId: 'market-memory-foam',
      lastSuccessfulSync: '2026-09-11T01:30:00.000Z',
    },
    loading: false,
    refreshKey: 0,
  }),
}));

vi.mock('../lib/api', () => ({ useApi: useApiMock }));

vi.mock('recharts', () => {
  const Frame = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Empty = () => null;
  return {
    ResponsiveContainer: Frame,
    LineChart: Frame,
    BarChart: Frame,
    Bar: Frame,
    CartesianGrid: Empty,
    Cell: Empty,
    Line: Empty,
    Tooltip: Empty,
    XAxis: Empty,
    YAxis: Empty,
  };
});

const market: MarketNode = {
  id: 'market-memory-foam',
  name: '记忆棉枕市场',
  parentId: null,
  level: 1,
  marketplace: 'US',
  keywords: ['memory foam pillow'],
  status: '增长',
  snapshotAvailable: true,
  monthlySales: 12_000,
  monthlyRevenue: 480_000,
  growth30d: 8,
  growth30dAvailable: true,
  productCount: 120,
  avgPrice: 40,
  competitionScore: 62,
  opportunityScore: 71,
};

const detail: MarketDetail = {
  node: market,
  path: [{ id: market.id, name: market.name }],
  kpis: {
    monthlySales: 12_000,
    monthlyRevenue: 480_000,
    productCount: 120,
    sellerCount: 88,
    brandCount: 54,
    avgPrice: 40,
    medianPrice: 38,
    top10Share: 38,
    top20Share: 52,
    newProductShare: 14,
    medianReviews: 650,
    avgRating: 4.4,
  },
  trends: [
    { date: '2026-08-11', sales: 10_000, revenue: 390_000, avgPrice: 39, productCount: 112, sellerCount: 82, medianReviews: 620 },
    { date: '2026-09-10', sales: 12_000, revenue: 480_000, avgPrice: 40, productCount: 120, sellerCount: 88, medianReviews: 650 },
  ],
  tree: [market],
  priceBands: [{ label: '$30–39', productCount: 42, monthlySales: 5_300, revenue: 190_000, avgReviews: 700, newProducts: 5, growth: 6 }],
  concentration: [{ tier: 'TOP10', share: 38, avgPrice: 43, avgSales: 456 }],
  insight: {
    id: 'insight-market',
    entityType: 'market',
    entityId: market.id,
    insightType: 'market_assessment',
    status: '已完成',
    title: '市场保持增长',
    summary: '正式工作流结论。',
    facts: ['市场销量同比例增长。'],
    opportunities: ['中价带需求稳定。'],
    risks: [],
    recommendedActions: ['持续观察。'],
    evidence: [],
    confidence: 0.84,
    model: 'rule-engine-v1',
    dataVersion: 'snapshot-v1',
    generatedAt: '2026-09-11T01:30:00.000Z',
  },
  provenance: {
    source: 'Demo fixture',
    sourceType: 'mock',
    collectedAt: '2026-09-11T01:30:00.000Z',
    period: '30D',
    isEstimated: false,
    confidence: 0.9,
  },
};

function product(id: string, asin: string, sales: number | null, growth: number | null): Product {
  return {
    id,
    asin,
    brand: 'Fixture Brand',
    title: asin,
    imageUrl: '',
    marketplace: 'US',
    productType: '记忆棉枕',
    isOwned: false,
    marketNodeId: market.id,
    latest: {
      id: `${id}-snapshot`,
      snapshotAvailable: true,
      productId: id,
      date: '2026-09-10',
      price: 39,
      rating: 4.3,
      reviewCount: 500,
      bsr: 100,
      estimatedSales: sales,
      estimatedRevenue: sales === null ? null : sales * 39,
      sellerCount: 1,
      growth7d: null,
      growth30d: growth,
      growth30dAvailable: growth !== null,
      growth90d: null,
      provenance: detail.provenance,
    },
  };
}

beforeEach(() => {
  useApiMock.mockImplementation((path: string | null) => ({
    data: path?.startsWith('/api/markets/market-memory-foam/products')
      ? [product('product-a', 'B0A', 1000, 12), product('product-b', 'B0B', 800, null)]
      : path?.startsWith('/api/markets/market-memory-foam?')
        ? detail
        : [market],
    error: null,
    loading: false,
    refreshing: false,
    reload: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
});

describe('MarketPage V2.1 hierarchy', () => {
  it('places charts before TOP100, then shows the AI conclusion before supporting metrics', () => {
    render(<MemoryRouter initialEntries={['/market?market=market-memory-foam']}><MarketPage /></MemoryRouter>);

    const headings = screen.getAllByRole('heading', { level: 2 });
    const labels = headings.map((heading) => heading.textContent);
    const expected = ['市场销量趋势', '销售额趋势', '平均价格趋势', '价格带机会', 'TOP 集中度', '细分市场机会排名', 'TOP100 商品表', '市场保持增长', '补充经营指标'];
    const positions = expected.map((label) => labels.indexOf(label));
    expect(positions.every((position, index) => index === 0 || position > positions[index - 1])).toBe(true);
    expect(screen.getByText('Demo 数据')).toBeInTheDocument();
    expect(screen.getByText('产品数量')).toBeInTheDocument();
    expect(screen.queryByText('新品数量')).not.toBeInTheDocument();

    const productsSection = screen.getByRole('heading', { name: 'TOP100 商品表' }).closest('section');
    expect(productsSection).not.toBeNull();
    const table = within(productsSection as HTMLElement).getByRole('table');
    expect(within(table).getByText('B0B').closest('tr')).toHaveTextContent('—');
  });
});
