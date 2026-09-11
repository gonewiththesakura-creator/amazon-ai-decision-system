// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Competitor, OwnedProductDetail, ProductSnapshot, Provenance } from '../../shared/types';
import OwnedProductsPage from './OwnedProductsPage';

const { useApiMock } = vi.hoisted(() => ({ useApiMock: vi.fn() }));
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
  api: { post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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
});
