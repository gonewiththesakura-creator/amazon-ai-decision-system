import clsx from 'clsx';
import { ArrowLeft, DatabaseZap } from 'lucide-react';
import { ChartCard } from './ChartCard';
import { DailyInsights } from './DailyInsights';
import { MarketSkuTrendChart } from './MarketSkuTrendChart';
import { formatCurrency, formatInteger, formatSignedPercent } from './format';
import type { DashboardRange, SkuFocusData } from './types';

export interface SkuFocusViewProps {
  data: SkuFocusData;
  range?: DashboardRange;
  currency?: string;
  onRangeChange?: (range: DashboardRange) => void;
  onBack: () => void;
  onSelectCompetitor?: (competitorId: string) => void;
}

export function SkuFocusView({ data, range, currency = 'USD', onRangeChange, onBack, onSelectCompetitor }: SkuFocusViewProps) {
  const metrics = [
    { label: '当前价格', value: formatCurrency(data.operatingMetrics.price, currency), tone: 'neutral' },
    { label: 'Rating', value: data.operatingMetrics.rating?.toFixed(1) ?? '—', tone: 'neutral' },
    { label: 'Review', value: formatInteger(data.operatingMetrics.reviews), tone: 'neutral' },
    { label: 'BSR', value: formatInteger(data.operatingMetrics.bsr), tone: 'neutral' },
    { label: '月销量', value: formatInteger(data.operatingMetrics.estimatedSales), tone: 'neutral' },
    { label: '月销售额', value: formatCurrency(data.operatingMetrics.estimatedRevenue, currency), tone: 'neutral' },
    {
      label: '30D Growth',
      value: data.operatingMetrics.growth30d === null ? '—' : formatSignedPercent(data.operatingMetrics.growth30d),
      tone: data.operatingMetrics.growth30d === null ? 'warning' : data.operatingMetrics.growth30d >= 0 ? 'positive' : 'critical',
    },
    {
      label: '市场 30D',
      value: data.operatingMetrics.marketGrowth30d === null ? '—' : formatSignedPercent(data.operatingMetrics.marketGrowth30d),
      tone: data.operatingMetrics.marketGrowth30d === null ? 'warning' : data.operatingMetrics.marketGrowth30d >= 0 ? 'positive' : 'critical',
    },
    {
      label: 'Relative Performance',
      value: data.operatingMetrics.relativeDelta === null ? '—' : formatSignedPercent(data.operatingMetrics.relativeDelta),
      tone: data.operatingMetrics.relativeDelta === null ? 'warning' : data.operatingMetrics.relativeDelta >= 0 ? 'positive' : 'critical',
    },
  ] as const;

  return (
    <section className="executive-sku-focus" aria-label={`${data.sku.name}聚焦视图`}>
      <header className="executive-sku-focus__header">
        <button type="button" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />返回全部 4 SKU</button>
        <div>
          <span>SKU FOCUS</span>
          <h2>{data.sku.name}</h2>
          <p>ASIN: {data.sku.asin}{data.sku.sku ? ` · SKU: ${data.sku.sku}` : ''}</p>
        </div>
      </header>

      <div className="executive-sku-focus__lead">
        <MarketSkuTrendChart
          series={data.trendComparison}
          range={range}
          onRangeChange={onRangeChange}
          title="本 SKU VS 市场"
          description={`同时对比 ${data.market.name} 与直接竞品平均走势。`}
        />
        <ChartCard title="当前经营数据" eyebrow="LATEST SNAPSHOT">
          <dl className="executive-focus-metrics">
            {metrics.map((metric) => (
              <div key={metric.label}>
                <dt>{metric.label}</dt>
                <dd className={clsx(metric.tone && `is-${metric.tone}`)}>{metric.value}</dd>
              </div>
            ))}
          </dl>
        </ChartCard>
      </div>

      <div className="executive-sku-focus__secondary">
        <ChartCard title="直接竞品 TOP5" eyebrow="DIRECT COMPETITORS">
          {data.directCompetitors.length ? (
            <div className="executive-focus-competitors">
              {data.directCompetitors.slice(0, 5).map((competitor) => (
                <button type="button" key={competitor.id} disabled={!onSelectCompetitor} onClick={() => onSelectCompetitor?.(competitor.id)}>
                  <span><strong>{competitor.name}</strong><small>{formatCurrency(competitor.price, currency)} · Rating {competitor.rating?.toFixed(1) ?? '—'} · {formatInteger(competitor.reviews)} Reviews</small></span>
                  <b className={competitor.growth !== null && competitor.growth < 0 ? 'is-critical' : 'is-positive'}>{competitor.growth === null ? '—' : formatSignedPercent(competitor.growth)}</b>
                </button>
              ))}
            </div>
          ) : <p className="dashboard-inline-empty">尚未建立直接竞品组。</p>}
        </ChartCard>
        <DailyInsights insights={data.insight ? [data.insight] : []} />
      </div>

      {data.missingDataLabels.length ? (
        <div className="executive-focus-missing" role="status">
          <DatabaseZap size={17} aria-hidden="true" />
          <span>进一步诊断仍需：{data.missingDataLabels.join('、')}</span>
        </div>
      ) : null}
    </section>
  );
}
