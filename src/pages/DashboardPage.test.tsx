// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataCoverageReport, ExecutiveDashboardViewModel } from '../../shared/types';
import DashboardPage from './DashboardPage';

const { useApiMock, useAppMock } = vi.hoisted(() => ({ useApiMock: vi.fn(), useAppMock: vi.fn() }));
vi.mock('../lib/AppContext', () => ({ useApp: useAppMock }));
vi.mock('../lib/api', () => ({ useApi: useApiMock }));
vi.mock('../components/dashboard', () => ({
  CompetitorGrowthChart: () => null, DailyInsights: () => null,
  DataFreshnessBadge: () => null, DevelopmentOpportunityChart: () => null,
  ExecutiveKpis: () => null, MarketConcentrationDonut: () => null,
  MarketSkuTrendChart: () => null, ResearchStatusChart: () => null,
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
  return { generatedAt: '', marketplace: 'US', primaryMarket: counter, activeOwnedProducts: counter, coreCompetitors: counter, history90d: counter, amazonActual: counter };
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
});
