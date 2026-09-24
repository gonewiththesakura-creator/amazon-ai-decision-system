// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Competitor, OwnedProductDetail, ProductSnapshot, Provenance } from '../../shared/types';
import OwnedProductsPage from './OwnedProductsPage';

const { useApiMock } = vi.hoisted(() => ({ useApiMock: vi.fn() }));
const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));
const scrollIntoViewMock = vi.fn();
let reduceMotion = false;

vi.mock('../lib/AppContext', () => ({
  useApp: () => ({
    settings: {
      mode: 'demo',
      role: 'admin',
      marketplace: 'US',
      currency: 'USD',
      lastSuccessfulSync: '2026-09-11T01:30:00.000Z',
    },
    loading: false,
    refreshKey: 0,
  }),
}));

vi.mock('../lib/api', () => ({
  api: { get: getMock, post: postMock, patch: vi.fn(), delete: vi.fn() },
  useApi: useApiMock,
}));

vi.mock('recharts', () => {
  const Frame = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Empty = () => null;
  return {
    ResponsiveContainer: Frame,
    BarChart: Frame,
    LineChart: Frame,
    Bar: Frame,
    CartesianGrid: Empty,
    Cell: Empty,
    Legend: Empty,
    Line: Empty,
    ReferenceLine: Empty,
    Tooltip: Empty,
    XAxis: Empty,
    YAxis: Empty,
  };
});

const provenance: Provenance = {
  source: 'Demo fixture',
  sourceType: 'mock',
  collectedAt: '2026-09-11T01:30:00.000Z',
  period: '30D',
  isEstimated: false,
  confidence: 0.9,
};

function snapshot(productId: string, sales: number | null): ProductSnapshot {
  return {
    id: `${productId}-snapshot`,
    snapshotAvailable: true,
    productId,
    date: '2026-09-10',
    price: 39,
    rating: 4.3,
    reviewCount: 500,
    bsr: 100,
    estimatedSales: sales,
    estimatedRevenue: sales === null ? null : sales * 39,
    sellerCount: 1,
    growth7d: null,
    growth30d: null,
    growth30dAvailable: false,
    growth90d: null,
    provenance,
  };
}

function competitor(id: string, asin: string): Competitor {
  return {
    id,
    asin,
    brand: `${asin} Brand`,
    title: `${asin} Ergonomic Pillow`,
    imageUrl: '',
    marketplace: 'US',
    productType: 'memory_foam_pillow',
    isOwned: false,
    marketNodeId: 'market-memory-foam',
    latest: snapshot(id, 800),
    relationType: 'direct',
    similarityScore: 88,
    relationReason: 'Direct comparison',
    aiTags: ['直接竞品'],
    relationCreatedAt: '2026-09-10T00:00:00.000Z',
    lastVerifiedAt: '2026-09-11T00:00:00.000Z',
  };
}

const detail: OwnedProductDetail = {
  id: 'owned-1',
  asin: 'B0OWNED001',
  sku: 'OWNED-01',
  internalName: '自有记忆棉枕',
  brand: 'Owned Brand',
  title: 'Owned Memory Foam Pillow',
  imageUrl: '',
  marketplace: 'US',
  productType: 'memory_foam_pillow',
  isOwned: true,
  marketNodeId: 'market-memory-foam',
  marketPath: [{ id: 'market-memory-foam', name: '记忆棉枕市场' }],
  latest: snapshot('owned-1', 1_000),
  marketGrowth30d: null,
  marketGrowth30dAvailable: false,
  relativeDelta: null,
  relativePerformanceAvailable: false,
  performance: 'insufficient_data',
  anomalyCount: 0,
  insight: {
    id: 'insight-owned-1',
    entityType: 'owned_product',
    entityId: 'owned-1',
    insightType: 'owned_sku_analysis',
    status: '数据不足',
    title: '数据不足',
    summary: '等待更多快照。',
    facts: [],
    opportunities: [],
    risks: [],
    recommendedActions: [],
    evidence: [],
    confidence: 0,
    model: 'rule-engine-v1',
    dataVersion: 'fixture-v1',
    generatedAt: '2026-09-11T01:30:00.000Z',
  },
  snapshots: [snapshot('owned-1', 1_000)],
  percentiles: { sales: null, price: null, reviews: null, rating: null, growth: null },
  comparisons: {
    market: { growth30d: null },
    direct: { growth30d: null, sampleSize: 0 },
    top20: { growth30d: null, sampleSize: 0 },
  },
  competitors: [competitor('competitor-target', 'B0TARGET01'), competitor('competitor-other', 'B0OTHER001')],
};

beforeEach(() => {
  getMock.mockReset().mockResolvedValue([]);
  postMock.mockReset().mockResolvedValue({ inserted: 1 });
  reduceMotion = false;
  scrollIntoViewMock.mockReset();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoViewMock,
  });
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: reduceMotion && query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
  useApiMock.mockImplementation((path: string | null) => ({
    data: path?.startsWith('/api/owned-products/owned-1?') ? detail : [detail],
    error: null,
    loading: false,
    refreshing: false,
    reload: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
  vi.unstubAllGlobals();
});

describe('OwnedProductsPage competitor deep link', () => {
  function createRouter(competitorId: string) {
    return createMemoryRouter([
      { path: '/owned-products/:productId', element: <OwnedProductsPage /> },
    ], {
      initialEntries: [`/owned-products/owned-1?tab=competitors&competitor=${competitorId}`],
    });
  }

  it('filters, scrolls, and focuses the requested competitor only once', async () => {
    const router = createRouter('competitor-target');
    render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );

    const targetAsin = await screen.findByText('B0TARGET01');
    const targetRow = targetAsin.closest('tr');
    expect(targetRow).not.toBeNull();
    await waitFor(() => expect(targetRow).toHaveFocus());
    expect(targetRow).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('textbox', { name: '搜索竞品' })).toHaveValue('B0TARGET01');
    expect(screen.queryByText('B0OTHER001')).not.toBeInTheDocument();
    expect(scrollIntoViewMock).toHaveBeenCalledOnce();
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center', inline: 'nearest' });

    fireEvent.change(screen.getByRole('textbox', { name: '搜索竞品' }), { target: { value: 'B0TARGET' } });
    expect(scrollIntoViewMock).toHaveBeenCalledOnce();
  });

  it('waits until filtering mounts the newly requested competitor row', async () => {
    const router = createRouter('competitor-other');
    render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByText('B0OTHER001').closest('tr')).toHaveFocus());
    expect(screen.queryByText('B0TARGET01')).not.toBeInTheDocument();
    scrollIntoViewMock.mockClear();

    await act(async () => {
      await router.navigate('/owned-products/owned-1?tab=competitors&competitor=competitor-target');
    });

    const targetRow = (await screen.findByText('B0TARGET01')).closest('tr');
    await waitFor(() => expect(targetRow).toHaveFocus());
    expect(screen.queryByText('B0OTHER001')).not.toBeInTheDocument();
    expect(scrollIntoViewMock).toHaveBeenCalledOnce();
  });

  it('uses instant scrolling when reduced motion is preferred', async () => {
    reduceMotion = true;
    const router = createRouter('competitor-target');
    render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );

    await waitFor(() => expect(scrollIntoViewMock).toHaveBeenCalledOnce());
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'auto', block: 'center', inline: 'nearest' });
  });

  it('syncs an already confirmed competitor from its row', async () => {
    render(<RouterProvider router={createRouter('competitor-target')} />);
    fireEvent.click(await screen.findByRole('button', { name: '同步竞品 B0TARGET01' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      '/api/integrations/sellersprite/sync/competitor',
      { ownedProductId: 'owned-1', competitorProductId: 'competitor-target' },
    ));
  });
});

describe('OwnedProductsPage large portfolio selector', () => {
  it('filters and paginates a 25-product portfolio without hiding the total', async () => {
    const products = Array.from({ length: 25 }, (_, index) => {
      const number = index + 1;
      return {
        ...detail,
        id: `owned-${number}`,
        asin: `B0OWNED${String(number).padStart(3, '0')}`,
        sku: `SKU-${String(number).padStart(2, '0')}`,
        internalName: `Portfolio SKU ${String(number).padStart(2, '0')}`,
        title: `Portfolio Memory Foam Pillow ${String(number).padStart(2, '0')}`,
        latest: snapshot(`owned-${number}`, 1_000 + number),
        snapshots: [snapshot(`owned-${number}`, 1_000 + number)],
      } satisfies OwnedProductDetail;
    });
    useApiMock.mockImplementation((path: string | null) => {
      const match = path?.match(/^\/api\/owned-products\/([^?]+)/);
      const selected = match ? products.find((product) => product.id === decodeURIComponent(match[1])) : null;
      return {
        data: selected ?? products,
        error: null,
        loading: false,
        refreshing: false,
        reload: vi.fn(),
      };
    });
    const router = createMemoryRouter([
      { path: '/owned-products/:productId', element: <OwnedProductsPage /> },
    ], { initialEntries: ['/owned-products/owned-1'] });
    render(<RouterProvider router={router} />);

    expect(screen.getByText('25 个产品')).toBeInTheDocument();
    const selector = screen.getByRole('navigation', { name: '选择自有 SKU' });
    expect(within(selector).getAllByRole('link')).toHaveLength(12);
    expect(within(selector).getByText('Portfolio SKU 01')).toBeInTheDocument();
    expect(within(selector).queryByText('Portfolio SKU 13')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(within(selector).getByText('Portfolio SKU 13')).toBeInTheDocument();
    expect(within(selector).queryByText('Portfolio SKU 01')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索自有 SKU' }), {
      target: { value: 'SKU 25' },
    });
    expect(within(selector).getAllByRole('link')).toHaveLength(1);
    expect(within(selector).getByText('Portfolio SKU 25')).toBeInTheDocument();
    expect(screen.getByText('显示 1 / 25')).toBeInTheDocument();
  });

  it('keeps a deep-linked product on its page and exposes current selection and pagination semantics', async () => {
    const products = Array.from({ length: 25 }, (_, index) => ({
      ...detail,
      id: `owned-${index + 1}`,
      sku: `SKU-${String(index + 1).padStart(2, '0')}`,
      internalName: `Portfolio SKU ${String(index + 1).padStart(2, '0')}`,
      latest: snapshot(`owned-${index + 1}`, 1_000 + index),
    } satisfies OwnedProductDetail));
    useApiMock.mockImplementation((path: string | null) => {
      const match = path?.match(/^\/api\/owned-products\/([^?]+)/);
      return {
        data: match ? products.find((product) => product.id === decodeURIComponent(match[1])) : products,
        error: null, loading: false, refreshing: false, reload: vi.fn(),
      };
    });
    const router = createMemoryRouter([
      { path: '/owned-products/:productId', element: <OwnedProductsPage /> },
    ], { initialEntries: ['/owned-products/owned-25'] });
    render(<RouterProvider router={router} />);

    const selector = await screen.findByRole('navigation', { name: '选择自有 SKU' });
    const selected = within(selector).getByRole('link', { name: /Portfolio SKU 25/ });
    expect(selected).toHaveAttribute('aria-current', 'page');
    selected.focus();
    expect(selected).toHaveFocus();
    expect(screen.getByRole('status', { name: '自有 SKU 分页状态' })).toHaveTextContent('3 / 3');
    expect(screen.getByRole('navigation', { name: '自有 SKU 分页' })).toBeInTheDocument();
  });
});
