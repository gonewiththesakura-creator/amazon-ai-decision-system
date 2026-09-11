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
import { ChartCard } from './ChartCard';
import { ChartEmptyState } from './ChartEmptyState';
import { formatDashboardDate, formatSignedPercent, indexedTrendDomain } from './format';
import type { DashboardRange, IndexedTrendSeries } from './types';

const ranges: DashboardRange[] = ['7D', '30D', '90D', '180D', '1Y'];
const rangeDays: Record<DashboardRange, number> = { '7D': 7, '30D': 30, '90D': 90, '180D': 180, '1Y': 365 };
const ownedSkuColors = ['#147763', '#a86120', '#775b8c', '#3d7782', '#8b5b45'];

export interface MarketSkuTrendChartProps {
  series: IndexedTrendSeries[];
  range?: DashboardRange;
  onRangeChange?: (range: DashboardRange) => void;
  title?: string;
  description?: string;
  marketHref?: string;
}

type ChartTrendRow = Record<string, string | number | null> & { date: string };

function seriesKey(series: IndexedTrendSeries): string {
  return series.key ?? series.id;
}

function seriesColor(series: IndexedTrendSeries, ownedIndex: number): string {
  if (series.color) return series.color;
  if (series.kind === 'market') return '#2e689f';
  if (series.kind === 'competitor_average') return '#61706d';
  return ownedSkuColors[ownedIndex % ownedSkuColors.length];
}

function buildChartRows(series: IndexedTrendSeries[], range: DashboardRange): ChartTrendRow[] {
  const allDates = series.flatMap((item) => item.points.map((point) => new Date(point.date).getTime())).filter(Number.isFinite);
  const latest = allDates.length ? Math.max(...allDates) : null;
  const threshold = latest === null ? null : latest - rangeDays[range] * 24 * 60 * 60 * 1000;
  const rows = new Map<string, ChartTrendRow>();

  series.forEach((item) => {
    const key = seriesKey(item);
    item.points.forEach((point) => {
      const timestamp = new Date(point.date).getTime();
      if (threshold !== null && Number.isFinite(timestamp) && timestamp < threshold) return;
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
  if (key === marketKey) return '市场基准';
  const explicitRelative = row[`${key}__relative`];
  if (typeof explicitRelative === 'number') return formatSignedPercent(explicitRelative);
  const value = row[key];
  const marketValue = marketKey ? row[marketKey] : null;
  return typeof value === 'number' && typeof marketValue === 'number'
    ? formatSignedPercent(value - marketValue)
    : '不可用';
}

export function MarketSkuTrendChart({
  series,
  range,
  onRangeChange,
  title = '市场 VS 4 SKU 趋势',
  description = '选定时间范围起点统一为 100，比较走势而非绝对体量。',
  marketHref,
}: MarketSkuTrendChartProps) {
  const [internalRange, setInternalRange] = useState<DashboardRange>('30D');
  const activeRange = range ?? internalRange;
  const rows = useMemo(() => buildChartRows(series, activeRange), [activeRange, series]);
  const visibleSeries = series.filter((item) => rows.filter((row) => typeof row[seriesKey(item)] === 'number').length >= 2);
  const marketSeries = visibleSeries.find((item) => item.kind === 'market') ?? visibleSeries[0];
  const marketKey = marketSeries ? seriesKey(marketSeries) : null;
  const labelByKey = new Map(series.map((item) => [seriesKey(item), item.label]));
  const chartDomain = indexedTrendDomain(visibleSeries.flatMap((item) => (
    rows.map((row) => typeof row[seriesKey(item)] === 'number' ? row[seriesKey(item)] as number : null)
  )));
  let legendOwnedIndex = 0;
  let lineOwnedIndex = 0;

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

  return (
    <ChartCard
      className="dashboard-chart-card--trend"
      title={title}
      eyebrow="INDEXED PERFORMANCE"
      description={description}
      action={rangeControl}
    >
      {visibleSeries.length && rows.length >= 2 ? (
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
                    const marketValue = marketKey ? row[marketKey] : null;
                    const relative = typeof explicitRelative === 'number'
                      ? explicitRelative
                      : key !== marketKey && typeof marketValue === 'number'
                        ? numericValue - marketValue
                        : null;
                    return [
                      `${numericValue.toFixed(1)}${relative !== null ? ` · 相对市场 ${formatSignedPercent(relative)}` : ''}`,
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
        <ChartEmptyState title="历史快照不足" description="完成至少两个有效时间点后自动生成趋势。" />
      )}
    </ChartCard>
  );
}
