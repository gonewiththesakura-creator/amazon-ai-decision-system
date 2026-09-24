import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ExecutiveSkuPerformance, IndexedTrendExcludedSeries } from '../../../shared/types';
import { ChartCard } from './ChartCard';
import { ChartEmptyState } from './ChartEmptyState';
import { formatDashboardDate, indexedTrendDomain } from './format';
import type { DashboardRange, IndexedTrendSeries } from './types';

const ranges: DashboardRange[] = ['7D', '30D', '90D', '180D', '1Y'];
const ownedSkuColors = ['#147763', '#a86120', '#775b8c', '#3d7782', '#8b5b45'];

export interface MarketSkuTrendChartProps {
  series: IndexedTrendSeries[];
  commonBaselineDate: string | null;
  excludedSeries: IndexedTrendExcludedSeries[];
  marketConfigured: boolean;
  range?: DashboardRange;
  onRangeChange?: (range: DashboardRange) => void;
  title?: string;
  description?: string;
  marketHref?: string;
  comparisonSkus?: Array<Pick<ExecutiveSkuPerformance, 'id' | 'name'>>;
  selectedComparisonSkuIds?: string[];
  onComparisonSkuIdsChange?: (skuIds: string[]) => void;
}

type ChartTrendRow = Record<string, string | number | null> & { date: string };

function seriesKey(series: IndexedTrendSeries): string {
  return series.id;
}

function seriesColor(series: IndexedTrendSeries, ownedIndex: number): string {
  if (series.kind === 'market') return '#2e689f';
  if (series.kind === 'competitor_average') return '#61706d';
  return ownedSkuColors[ownedIndex % ownedSkuColors.length];
}

function buildChartRows(series: IndexedTrendSeries[]): ChartTrendRow[] {
  const rows = new Map<string, ChartTrendRow>();

  series.forEach((item) => {
    const key = seriesKey(item);
    item.points.forEach((point) => {
      const row = rows.get(point.date) ?? { date: point.date };
      row[key] = point.index !== null && Number.isFinite(point.index) ? point.index : null;
      row[`${key}__relative`] = point.relativeToMarket !== null
        && point.relativeToMarket !== undefined
        && Number.isFinite(point.relativeToMarket)
        ? point.relativeToMarket
        : null;
      rows.set(point.date, row);
    });
  });

  return [...rows.values()].sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime());
}

function relativeToMarketLabel(
  row: ChartTrendRow,
  key: string,
  marketKey: string | null,
): string {
  if (marketKey !== null && key === marketKey) return '市场基准';
  const explicitRelative = row[`${key}__relative`];
  if (typeof explicitRelative === 'number') return formatIndexDelta(explicitRelative);
  return '不可用';
}

function formatIndexDelta(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} 点`;
}

export function MarketSkuTrendChart({
  series,
  commonBaselineDate,
  excludedSeries,
  marketConfigured,
  range,
  onRangeChange,
  title = '市场 VS 自有 SKU 趋势',
  description = '所有参与序列使用同一有效日期作为 100 基准，比较走势而非绝对体量。',
  marketHref,
  comparisonSkus,
  selectedComparisonSkuIds = [],
  onComparisonSkuIdsChange,
}: MarketSkuTrendChartProps) {
  const [internalRange, setInternalRange] = useState<DashboardRange>('30D');
  const activeRange = range ?? internalRange;
  const rows = useMemo(() => buildChartRows(series), [series]);
  const visibleSeries = series.filter((item) => rows.filter((row) => typeof row[seriesKey(item)] === 'number').length >= 2);
  const marketSeries = visibleSeries.find((item) => item.kind === 'market');
  const marketKey = marketSeries ? seriesKey(marketSeries) : null;
  const labelByKey = new Map(series.map((item) => [seriesKey(item), item.label]));
  const chartDomain = indexedTrendDomain(visibleSeries.flatMap((item) => (
    rows.map((row) => typeof row[seriesKey(item)] === 'number' ? row[seriesKey(item)] as number : null)
  )));
  let legendOwnedIndex = 0;
  let lineOwnedIndex = 0;
  const canCompare = Boolean(marketSeries) && visibleSeries.length >= 2 && rows.length >= 2 && commonBaselineDate !== null;
  const baselineLabel = commonBaselineDate
    ? `共同基准：${formatDashboardDate(commonBaselineDate)}`
    : null;
  const excludedLabel = excludedSeries.length
    ? `${excludedSeries.map((item) => item.label).join('、')}因历史数据不足未参与当前周期比较`
    : null;
  const footer = baselineLabel || excludedLabel ? (
    <span className="dashboard-chart-note">{[baselineLabel, excludedLabel].filter(Boolean).join(' · ')}</span>
  ) : null;

  const changeRange = (nextRange: DashboardRange) => {
    if (range === undefined) setInternalRange(nextRange);
    onRangeChange?.(nextRange);
  };

  const rangeControl = (
    <div className="executive-segmented-control" aria-label="趋势时间范围">
      {ranges.map((item) => (
        <button
          className={activeRange === item ? 'is-active' : ''}
          type="button"
          aria-pressed={activeRange === item}
          key={item}
          onClick={() => changeRange(item)}
        >
          {item}
        </button>
      ))}
    </div>
  );

  const comparisonControl = comparisonSkus && comparisonSkus.length > 5 && onComparisonSkuIdsChange ? (
    <details className="dashboard-trend-comparison-selector">
      <summary>选择对比产品 {selectedComparisonSkuIds.length}/5</summary>
      <div className="dashboard-trend-comparison-selector__options">
        {comparisonSkus.map((sku) => {
          const checked = selectedComparisonSkuIds.includes(sku.id);
          const disabled = !checked && selectedComparisonSkuIds.length >= 5;
          return (
            <label key={sku.id}>
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => onComparisonSkuIdsChange(
                  checked
                    ? selectedComparisonSkuIds.filter((id) => id !== sku.id)
                    : [...selectedComparisonSkuIds, sku.id],
                )}
              />
              {sku.name}
            </label>
          );
        })}
      </div>
      {selectedComparisonSkuIds.length >= 5 ? <small>最多选择 5 个产品</small> : null}
    </details>
  ) : null;

  return (
    <ChartCard
      className="dashboard-chart-card--trend"
      title={title}
      eyebrow="INDEXED PERFORMANCE"
      description={description}
      action={rangeControl}
      footer={footer}
    >
      {comparisonControl}
      {canCompare ? (
        <>
          <div className="dashboard-chart-legend" aria-hidden="true">
            {visibleSeries.map((item) => {
              const color = seriesColor(item, legendOwnedIndex);
              if (item.kind !== 'market' && item.kind !== 'competitor_average') legendOwnedIndex += 1;
              return <span key={item.id}><i style={{ backgroundColor: color }} />{item.label}</span>;
            })}
          </div>
          {marketHref ? <Link className="dashboard-chart-link" to={marketHref}>打开市场详情</Link> : null}
          <div className="dashboard-chart-frame dashboard-chart-frame--large" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 10, right: 14, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#e7ecea" strokeDasharray="3 4" vertical={false} />
                <XAxis dataKey="date" tickFormatter={(value: string) => formatDashboardDate(value)} tick={{ fill: '#71807c', fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24} />
                <YAxis domain={chartDomain} tickFormatter={(value: number) => value.toFixed(0)} tick={{ fill: '#71807c', fontSize: 11 }} axisLine={false} tickLine={false} width={38} />
                <ReferenceLine y={100} stroke="#a9b4b1" strokeDasharray="4 4" />
                <Tooltip
                  labelFormatter={(value) => formatDashboardDate(String(value), true)}
                  formatter={(value, name, item) => {
                    const numericValue = typeof value === 'number' ? value : Number(value);
                    const row = item.payload as ChartTrendRow;
                    const key = String(name);
                    const explicitRelative = row[`${key}__relative`];
                    const relative = typeof explicitRelative === 'number'
                      ? explicitRelative
                      : null;
                    return [
                      `${numericValue.toFixed(1)}${relative !== null ? ` · 相对市场 ${formatIndexDelta(relative)}` : ''}`,
                      labelByKey.get(key) ?? key,
                    ];
                  }}
                  contentStyle={{ border: '1px solid #dfe5e3', borderRadius: 6, boxShadow: '0 12px 30px rgba(23, 33, 31, .10)' }}
                />
                {visibleSeries.map((item) => {
                  const color = seriesColor(item, lineOwnedIndex);
                  if (item.kind !== 'market' && item.kind !== 'competitor_average') lineOwnedIndex += 1;
                  return (
                    <Line
                      key={item.id}
                      isAnimationActive={false}
                      type="monotone"
                      dataKey={seriesKey(item)}
                      name={seriesKey(item)}
                      stroke={color}
                      strokeWidth={item.kind === 'market' ? 3 : 2.2}
                      strokeDasharray={item.kind === 'competitor_average' ? '5 4' : undefined}
                      dot={false}
                      connectNulls={false}
                      activeDot={{ r: 4, strokeWidth: 0 }}
                    />
                  );
                })}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <table className="dashboard-chart-data-table">
            <caption>{title}完整数据，时间范围 {activeRange}</caption>
            <thead>
              <tr>
                <th scope="col">日期</th>
                <th scope="col">系列</th>
                <th scope="col">指数</th>
                <th scope="col">相对市场</th>
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((row) => visibleSeries.map((item) => {
                const key = seriesKey(item);
                const index = row[key];
                return (
                  <tr key={`${row.date}-${item.id}`}>
                    <th scope="row">{formatDashboardDate(row.date, true)}</th>
                    <td>{item.label}</td>
                    <td>{typeof index === 'number' ? index.toFixed(1) : '不可用'}</td>
                    <td>{relativeToMarketLabel(row, key, marketKey)}</td>
                  </tr>
                );
              }))}
            </tbody>
          </table>
        </>
      ) : (
        <>
          <ChartEmptyState
            title={marketConfigured ? '历史快照不足' : '尚未设置主市场'}
            description={marketConfigured
              ? '市场与自有 SKU 形成共同有效基准后自动生成趋势。'
              : '设置主市场后才能比较市场与自有 SKU。'}
          />
          {!marketConfigured ? (
            <Link className="dashboard-chart-link" to="/settings">前往设置主市场</Link>
          ) : null}
        </>
      )}
    </ChartCard>
  );
}
