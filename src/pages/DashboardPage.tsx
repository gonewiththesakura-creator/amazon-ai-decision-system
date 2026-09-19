import { useEffect, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { DatabaseZap, RefreshCw, Settings2, Store } from 'lucide-react';
import type { DataCoverageReport, ExecutiveDashboardViewModel, TimeRange } from '../../shared/types';
import {
  CompetitorGrowthChart,
  DailyInsights,
  DataFreshnessBadge,
  DevelopmentOpportunityChart,
  ExecutiveKpis,
  MarketConcentrationDonut,
  MarketSkuTrendChart,
  ResearchStatusChart,
  SkuFocusView,
  SkuRelativeBarChart,
} from '../components/dashboard';
import { Onboarding } from '../components/Onboarding';
import { ErrorState, PageLoading } from '../components/StateViews';
import { useApi } from '../lib/api';
import { useApp } from '../lib/AppContext';
import './dashboard-page.css';

const ranges: TimeRange[] = ['7D', '30D', '90D', '180D', '1Y'];

function isTimeRange(value: string | null): value is TimeRange {
  return ranges.includes(value as TimeRange);
}

export default function DashboardPage() {
  const { settings, loading: settingsLoading, refreshKey } = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const previousMarketplace = useRef(settings.marketplace);
  const range = isTimeRange(searchParams.get('range')) ? searchParams.get('range') as TimeRange : '30D';
  const selectedSkuId = searchParams.get('sku');
  const marketplace = encodeURIComponent(settings.marketplace);
  const skuParam = selectedSkuId ? `&skuId=${encodeURIComponent(selectedSkuId)}` : '';
  const query = useApi<ExecutiveDashboardViewModel>(
    `/api/dashboard/executive?marketplace=${marketplace}&range=${range}${skuParam}`,
    refreshKey,
  );
  const coverageQuery = useApi<DataCoverageReport>(
    `/api/data-coverage?marketplace=${marketplace}`,
    refreshKey,
  );

  useEffect(() => {
    if (previousMarketplace.current === settings.marketplace) return;
    previousMarketplace.current = settings.marketplace;
    setSearchParams({}, { replace: true });
  }, [setSearchParams, settings.marketplace]);

  useEffect(() => {
    if (!selectedSkuId || !query.data || query.data.skuFocus) return;
    const next = new URLSearchParams(searchParams);
    next.delete('sku');
    setSearchParams(next, { replace: true });
  }, [query.data, searchParams, selectedSkuId, setSearchParams]);

  const updateParameter = (key: 'range' | 'sku', value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  if (settingsLoading) return <PageLoading label="正在检查数据连接" />;
  if (query.loading && !query.data) return <PageLoading label="正在读取经营快照" />;
  if (query.error && !query.data) {
    return <ErrorState error={query.error} onRetry={query.reload} lastSuccessfulSync={settings.lastSuccessfulSync} />;
  }
  if (!query.data) return null;
  if (settings.mode === 'empty' && !query.data.market && query.data.ownedSkuPerformance.length === 0) {
    return <Onboarding />;
  }

  const data = query.data;
  const focus = data.skuFocus;

  return (
    <div className="page-stack executive-dashboard-page">
      {query.error ? <ErrorState compact error={query.error} onRetry={query.reload} lastSuccessfulSync={settings.lastSuccessfulSync} /> : null}

      <section className="executive-dashboard-header" aria-labelledby="executive-dashboard-title">
        <div>
          <span className="eyebrow">EXECUTIVE OPERATING VIEW</span>
          <h1 id="executive-dashboard-title">AI 经营驾驶舱</h1>
          {data.market ? (
            <p>{data.market.name} · Amazon {data.marketplace}</p>
          ) : (
            <p className="executive-dashboard-header__missing-market">
              尚未设置主市场
              <Link to="/settings"><Settings2 size={14} aria-hidden="true" />前往设置</Link>
            </p>
          )}
        </div>
        <div className="executive-dashboard-header__meta">
          <span><Store size={14} aria-hidden="true" />Amazon {data.marketplace}</span>
          {coverageQuery.loading && !coverageQuery.data ? (
            <span role="status" aria-label="正在检查数据覆盖">正在检查数据覆盖…</span>
          ) : (
            <button className={`executive-system-sync executive-coverage--${coverageSummary(coverageQuery.data)}`} type="button"
              aria-label={`${coverageQuery.error && !coverageQuery.data ? '数据覆盖不可用' : coverageLabel(coverageSummary(coverageQuery.data))}，查看详情`}
              title={coverageQuery.error?.message ?? undefined} onClick={() => navigate('/data-tasks')}>
              <DatabaseZap size={14} aria-hidden="true" />
              {coverageQuery.error && !coverageQuery.data ? '数据覆盖不可用' : coverageLabel(coverageSummary(coverageQuery.data))}
            </button>
          )}
          <div className="executive-segmented-control" aria-label="驾驶舱时间范围">
            {ranges.map((item) => (
              <button
                className={range === item ? 'is-active' : ''}
                aria-pressed={range === item}
                type="button"
                key={item}
                onClick={() => updateParameter('range', item)}
              >
                {item}
              </button>
            ))}
          </div>
          <DataFreshnessBadge
            status={data.coreBusinessFreshness.status}
            updatedAt={data.coreBusinessFreshness.oldestRequiredSnapshotAt}
            isDemo={data.coreBusinessFreshness.isDemo}
            label={data.coreBusinessFreshness.label}
            message={data.coreBusinessFreshness.message}
            onClick={() => navigate('/data-tasks')}
          />
          <button
            className={`executive-system-sync executive-system-sync--${data.systemSyncStatus.status}`}
            type="button"
            title={data.systemSyncStatus.message ?? undefined}
            onClick={() => navigate('/data-tasks')}
          >
            <RefreshCw size={14} aria-hidden="true" />
            系统同步：{systemSyncLabel(data.systemSyncStatus.status)}
          </button>
        </div>
      </section>

      {focus ? (
        <SkuFocusView
          data={focus}
          range={range}
          currency={settings.currency}
          onRangeChange={(nextRange) => updateParameter('range', nextRange)}
          onBack={() => updateParameter('sku', null)}
          onSelectCompetitor={(competitorId) => navigate(`/owned-products/${focus.sku.id}?tab=competitors&competitor=${encodeURIComponent(competitorId)}`)}
        />
      ) : (
        <>
          <ExecutiveKpis kpis={data.kpis} />

          <div className="executive-dashboard-grid executive-dashboard-grid--lead">
            <MarketSkuTrendChart
              series={data.trendComparison}
              commonBaselineDate={data.trendComparisonMeta.commonBaselineDate}
              excludedSeries={data.trendComparisonMeta.excludedSeries}
              marketConfigured={Boolean(data.market)}
              range={range}
              onRangeChange={(nextRange) => updateParameter('range', nextRange)}
              marketHref={data.market ? `/market?market=${encodeURIComponent(data.market.id)}` : undefined}
            />
            <MarketConcentrationDonut
              concentration={data.marketDistribution.concentration}
              priceBands={data.marketDistribution.priceBands}
            />
          </div>

          <div className="executive-dashboard-grid executive-dashboard-grid--equal">
            <SkuRelativeBarChart items={data.ownedSkuPerformance} onSelectSku={(skuId) => updateParameter('sku', skuId)} />
            <CompetitorGrowthChart competitors={data.fastGrowthCompetitors} currency={settings.currency} />
          </div>

          <DailyInsights insights={data.dailyInsights} maxItems={5} />

          <div className="executive-dashboard-grid executive-dashboard-grid--future">
            <DevelopmentOpportunityChart
              opportunities={data.developmentOpportunities}
              onSelectOpportunity={(projectId) => navigate(`/development?project=${encodeURIComponent(projectId)}`)}
            />
            <ResearchStatusChart statuses={data.researchStatus} />
          </div>
        </>
      )}
    </div>
  );
}

function coverageSummary(report: DataCoverageReport | null): 'complete' | 'partial' | 'missing' {
  if (!report) return 'missing';
  const counters = [report.primaryMarket, report.activeOwnedProducts, report.coreCompetitors, report.history90d, report.amazonActual]
    .filter((counter) => counter.status !== 'not_applicable');
  if (counters.length > 0 && counters.every((counter) => counter.status === 'complete')) return 'complete';
  if (counters.length === 0 || counters.every((counter) => counter.status === 'missing')) return 'missing';
  return 'partial';
}

function coverageLabel(status: ReturnType<typeof coverageSummary>): string {
  return { complete: '数据覆盖完整', partial: '数据部分覆盖', missing: '数据覆盖缺失' }[status];
}

function systemSyncLabel(status: ExecutiveDashboardViewModel['systemSyncStatus']['status']): string {
  const labels = {
    idle: '尚无任务',
    running: '进行中',
    partial: '部分完成',
    failed: '失败',
    success: '已完成',
  } as const;
  return labels[status];
}
