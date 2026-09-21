// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataCoverageReport, ExecutiveDashboardViewModel } from '../../shared/types';
import { ApiError } from '../lib/api';
import DashboardPage from './DashboardPage';

const { useApiMock, useAppMock } = vi.hoisted(() => ({ useApiMock: vi.fn(), useAppMock: vi.fn() }));
vi.mock('../lib/AppContext', () => ({ useApp: useAppMock }));
vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
  useApi: useApiMock,
}));
vi.mock('../components/dashboard', () => ({
  CompetitorGrowthChart: () => null, DailyInsights: () => null,
  DataFreshnessBadge: () => null, DevelopmentOpportunityChart: () => null,
  ExecutiveKpis: () => null, MarketConcentrationDonut: () => null,
  MarketSkuTrendChart: (props: {
    selectedComparisonSkuIds?: string[];
    onComparisonSkuIdsChange?: (skuIds: string[]) => void;
  }) => (
    <>
      <output aria-label="已选对比产品">{props.selectedComparisonSkuIds?.join(',')}</output>
      <button type="button" onClick={() => props.onComparisonSkuIdsChange?.([])}>清除对比产品</button>
    </>
  ), ResearchStatusChart: () => null,
  SkuFocusView: () => null, SkuRelativeBarChart: () => null,
}));

const dashboard = {
  marketplace: 'US', market: null, skuFocus: null,
  coreBusinessFreshness: { status: 'fresh', label: '新鲜', message: null, oldestRequiredSnapshotAt: null, isDemo: false },
  systemSyncStatus: { status: 'idle', message: null },
  kpis: [], trendComparison: [], trendComparisonMeta: { commonBaselineDate: null, excludedSeries: [] },
  marketDistribution: { concentration: [], priceBands: [] }, ownedSkuPerformance: [],
  fastGrowthCompetitors: [], dailyInsights: [], developmentOpportunities: [], researchStatus: [],
} as unknown as ExecutiveDashboardViewModel;

function report(status: 'complete' | 'partial' | 'missing'): DataCoverageReport {
  const counter = { covered: status === 'missing' ? 0 : 1, total: status === 'complete' ? 1 : 2, status, label: status === 'complete' ? '完整' : status === 'partial' ? '部分覆盖' : '缺失' } as const;
  return {
    generatedAt: '', marketplace: 'US', primaryMarket: counter,
    activeOwnedProducts: counter, coreCompetitors: counter, history90d: counter,
    primaryMarketHistory90d: counter, ownedProductHistory90d: counter,
    ownedProductHistory180d: counter, coreCompetitorHistory90d: counter,
    coreDirectCompetitorTarget: {
      ...counter, minimumPerOwnedProduct: 3, preferredMaximumPerOwnedProduct: 5,
    },
    amazonActual: counter,
  };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function setMode(mode: 'demo' | 'empty') {
  useAppMock.mockReturnValue({
    settings: { mode, marketplace: 'US', currency: 'USD', lastSuccessfulSync: null },
    loading: false, refreshKey: 0,
  });
}

describe('DashboardPage coverage summary', () => {
  it.each([
    ['complete', '数据覆盖完整'], ['partial', '数据部分覆盖'], ['missing', '数据覆盖缺失'],
  ] as const)('renders the %s state concisely', (status, label) => {
    setMode('demo');
    useApiMock.mockImplementation((path: string) => path.startsWith('/api/data-coverage')
      ? { data: report(status), loading: false, error: null, reload: vi.fn() }
      : { data: dashboard, loading: false, error: null, reload: vi.fn() });
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    expect(screen.getByRole('button', { name: `${label}，查看详情` })).toBeInTheDocument();
  });

  it('exposes loading and error states without blocking the dashboard', () => {
    setMode('demo');
    useApiMock.mockImplementation((path: string) => path.startsWith('/api/data-coverage')
      ? { data: null, loading: true, error: null, reload: vi.fn() }
      : { data: dashboard, loading: false, error: null, reload: vi.fn() });
    const view = render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    expect(screen.getByRole('status', { name: '正在检查数据覆盖' })).toBeInTheDocument();
    view.unmount();
    useApiMock.mockImplementation((path: string) => path.startsWith('/api/data-coverage')
      ? { data: null, loading: false, error: new Error('失败'), reload: vi.fn() }
      : { data: dashboard, loading: false, error: null, reload: vi.fn() });
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    expect(screen.getByRole('button', { name: '数据覆盖不可用，查看详情' })).toHaveAttribute('title', '失败');
  });

  it('shows imported staging market data before live activation, but keeps onboarding for a truly empty workspace', () => {
    setMode('empty');
    useApiMock.mockImplementation((path: string) => path.startsWith('/api/data-coverage')
      ? { data: report('partial'), loading: false, error: null, reload: vi.fn() }
      : { data: { ...dashboard, market: { id: 'real-market', name: '已导入市场' } },
        loading: false, error: null, reload: vi.fn() });
    const view = render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'AI 经营驾驶舱' })).toBeInTheDocument();
    expect(screen.getByText('已导入市场 · Amazon US')).toBeInTheDocument();
    expect(useApiMock).toHaveBeenCalledWith(expect.stringContaining('/api/dashboard/executive'), 0);
    view.unmount();

    useApiMock.mockImplementation((path: string) => path.startsWith('/api/data-coverage')
      ? { data: report('missing'), loading: false, error: null, reload: vi.fn() }
      : { data: dashboard, loading: false, error: null, reload: vi.fn() });
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '尚未接入真实数据' })).toBeInTheDocument();
  });

  it('replays a deduplicated comparison selection from the URL in the executive request', () => {
    setMode('demo');
    useApiMock.mockImplementation((path: string) => path.startsWith('/api/data-coverage')
      ? { data: report('complete'), loading: false, error: null, reload: vi.fn() }
      : { data: dashboard, loading: false, error: null, reload: vi.fn() });

    render(<MemoryRouter initialEntries={['/?compareSkuIds=sku-b,sku-a,sku-b']}><DashboardPage /></MemoryRouter>);

    expect(useApiMock).toHaveBeenCalledWith(
      expect.stringContaining('compareSkuIds=sku-b%2Csku-a'),
      0,
    );
  });

  it('uses the server-returned default comparison selection when the URL is empty', () => {
    setMode('demo');
    useApiMock.mockImplementation((path: string) => path.startsWith('/api/data-coverage')
      ? { data: report('complete'), loading: false, error: null, reload: vi.fn() }
      : {
        data: {
          ...dashboard,
          ownedSkuPerformance: Array.from({ length: 6 }, (_, index) => ({ id: `sku-${index + 1}` })),
          comparisonSkuIds: ['sku-6', 'sku-3', 'sku-1', 'sku-4', 'sku-2'],
        },
        loading: false, error: null, reload: vi.fn(),
      });

    render(<MemoryRouter><DashboardPage /></MemoryRouter>);

    expect(screen.getByLabelText('已选对比产品')).toHaveTextContent('sku-6,sku-3,sku-1,sku-4,sku-2');
  });

  it('removes an explicit comparison subset for a five-or-fewer SKU portfolio', async () => {
    setMode('demo');
    useApiMock.mockImplementation((path: string) => path.startsWith('/api/data-coverage')
      ? { data: report('complete'), loading: false, error: null, reload: vi.fn() }
      : {
        data: {
          ...dashboard,
          ownedSkuPerformance: [{ id: 'sku-a' }, { id: 'sku-b' }],
          comparisonSkuIds: ['sku-a', 'sku-b'],
        },
        loading: false, error: null, reload: vi.fn(),
      });

    render(<MemoryRouter initialEntries={['/?compareSkuIds=sku-a']}>
      <DashboardPage />
      <LocationProbe />
    </MemoryRouter>);

    await waitFor(() => expect(screen.getByLabelText('当前位置')).toHaveTextContent('/'));
    expect(screen.getByLabelText('已选对比产品')).toHaveTextContent('sku-a,sku-b');
  });

  it('removes only a stale comparison selection after the executive API returns 404', async () => {
    setMode('demo');
    useApiMock.mockImplementation((path: string) => {
      if (path.startsWith('/api/data-coverage')) return { data: report('complete'), loading: false, error: null, reload: vi.fn() };
      if (path.includes('compareSkuIds=')) return { data: null, loading: false, error: new ApiError('自有产品不存在。', 404), reload: vi.fn() };
      return { data: { ...dashboard, comparisonSkuIds: ['sku-default'] }, loading: false, error: null, reload: vi.fn() };
    });

    render(<MemoryRouter initialEntries={['/?compareSkuIds=stale-sku']}>
      <DashboardPage />
      <LocationProbe />
    </MemoryRouter>);

    await waitFor(() => expect(screen.getByLabelText('当前位置')).toHaveTextContent('/'));
    expect(useApiMock).toHaveBeenCalledWith(expect.not.stringContaining('compareSkuIds='), 0);
  });

  it('does not remove a comparison selection for a SKU-focus 404 or a non-404 error', async () => {
    setMode('demo');
    useApiMock.mockImplementation((path: string) => path.startsWith('/api/data-coverage')
      ? { data: report('complete'), loading: false, error: null, reload: vi.fn() }
      : { data: null, loading: false, error: new ApiError('自有产品不存在。', 404), reload: vi.fn() });

    render(<MemoryRouter initialEntries={['/?sku=missing&compareSkuIds=sku-a']}>
      <DashboardPage />
      <LocationProbe />
    </MemoryRouter>);

    await waitFor(() => expect(screen.getByLabelText('当前位置')).toHaveTextContent('/?sku=missing&compareSkuIds=sku-a'));
  });

  it('keeps a comparison selection when the executive API returns a non-404 error', async () => {
    setMode('demo');
    useApiMock.mockImplementation((path: string) => path.startsWith('/api/data-coverage')
      ? { data: report('complete'), loading: false, error: null, reload: vi.fn() }
      : { data: null, loading: false, error: new ApiError('服务不可用。', 500), reload: vi.fn() });

    render(<MemoryRouter initialEntries={['/?compareSkuIds=sku-a']}>
      <DashboardPage />
      <LocationProbe />
    </MemoryRouter>);

    await waitFor(() => expect(screen.getByLabelText('当前位置')).toHaveTextContent('/?compareSkuIds=sku-a'));
  });

  it('clearing the final explicit comparison SKU removes the URL parameter and returns to default selection', () => {
    setMode('demo');
    useApiMock.mockImplementation((path: string) => path.startsWith('/api/data-coverage')
      ? { data: report('complete'), loading: false, error: null, reload: vi.fn() }
      : {
        data: { ...dashboard, comparisonSkuIds: ['sku-default'] },
        loading: false, error: null, reload: vi.fn(),
      });

    render(<MemoryRouter initialEntries={['/?compareSkuIds=sku-explicit']}>
      <DashboardPage />
      <LocationProbe />
    </MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: '清除对比产品' }));
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/');
    expect(screen.getByLabelText('已选对比产品')).toHaveTextContent('sku-default');
  });
});

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="当前位置">{location.pathname}{location.search}</output>;
}
