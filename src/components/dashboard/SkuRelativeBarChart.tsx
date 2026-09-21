import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartCard } from './ChartCard';
import { ChartEmptyState } from './ChartEmptyState';
import { formatSignedPercent } from './format';
import type { SkuRelativePerformanceItem } from './types';

const performanceMeta = {
  strong_outperform: { label: '跑赢', color: '#147763' },
  outperform: { label: '跑赢', color: '#147763' },
  in_line: { label: '同步', color: '#6f7d79' },
  underperform: { label: '跑输', color: '#b5433f' },
  strong_underperform: { label: '跑输', color: '#b5433f' },
  insufficient_data: { label: '数据不足', color: '#a86120' },
} satisfies Record<SkuRelativePerformanceItem['performance'], { label: string; color: string }>;

export interface SkuRelativeBarChartProps {
  items: SkuRelativePerformanceItem[];
  onSelectSku?: (skuId: string) => void;
}

export function SkuRelativeBarChart({ items, onSelectSku }: SkuRelativeBarChartProps) {
  const comparable = useMemo(() => items
    .filter((item): item is SkuRelativePerformanceItem & { relativeDelta: number } => item.relativeDelta !== null && Number.isFinite(item.relativeDelta)), [items]);
  const isSummary = items.length >= 13;
  const plotted = useMemo(() => {
    const sorted = [...comparable].sort(compareByRelativeDeltaDescending);
    if (!isSummary) return sorted;

    const extremeItems = [
      ...sorted.slice(0, 5),
      ...[...comparable].sort(compareByRelativeDeltaAscending).slice(0, 5),
    ];
    const extremeIds = new Set(extremeItems.map((item) => item.id));
    const additionalAttention = [...comparable]
      .filter((item) => item.attention && !extremeIds.has(item.id))
      .sort(compareByRelativeDeltaAscending)
      .slice(0, 5);
    const selectedIds = new Set([...extremeItems, ...additionalAttention].map((item) => item.id));

    return sorted.filter((item) => selectedIds.has(item.id));
  }, [comparable, isSummary]);
  const pendingCount = items.length - comparable.length;
  const pending = items.filter((item) => item.relativeDelta === null || !Number.isFinite(item.relativeDelta));

  return (
    <ChartCard
      title="自有 SKU 相对市场表现"
      eyebrow="RELATIVE PERFORMANCE"
      description="SKU 30D 增长减去所属市场 30D 增长。"
      footer={pendingCount || isSummary ? (
        <span className="dashboard-chart-note">
          {pendingCount ? `${pendingCount} 个 SKU 因历史数据不足未参与比较` : null}
          {isSummary ? <>{pendingCount ? '；' : null}{comparable.length ? '已显示相对表现最高和最低及最多 5 个重点监控 SKU，' : null}<Link to="/owned-products">查看完整产品组合</Link></> : null}
        </span>
      ) : null}
    >
      {plotted.length ? (
        <>
          <div className="dashboard-chart-frame dashboard-chart-frame--bars" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={plotted} layout="vertical" margin={{ top: 4, right: 34, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="#e7ecea" strokeDasharray="3 4" horizontal={false} />
                <XAxis type="number" tickFormatter={(value: number) => `${value > 0 ? '+' : ''}${value}%`} tick={{ fill: '#71807c', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" width={90} tick={{ fill: '#33413e', fontSize: 12, fontWeight: 600 }} axisLine={false} tickLine={false} tickFormatter={(value: string) => value.length > 10 ? `${value.slice(0, 10)}…` : value} />
                <ReferenceLine x={0} stroke="#9ca8a4" />
                <Tooltip
                  cursor={{ fill: '#f3f6f5' }}
                  formatter={(value, _name, item) => {
                    const entry = item.payload as SkuRelativePerformanceItem;
                    const numericValue = typeof value === 'number' ? value : Number(value);
                    return [`${formatSignedPercent(numericValue)} · ${performanceMeta[entry.performance].label}`, '相对市场'];
                  }}
                  contentStyle={{ border: '1px solid #dfe5e3', borderRadius: 6 }}
                />
                <Bar dataKey="relativeDelta" radius={[0, 4, 4, 0]} maxBarSize={30} isAnimationActive={false}>
                  {plotted.map((item) => (
                    <Cell
                      key={item.id}
                      fill={performanceMeta[item.performance].color}
                      cursor={onSelectSku ? 'pointer' : 'default'}
                      onClick={() => onSelectSku?.(item.id)}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="dashboard-relative-values" aria-label="SKU 相对表现明细">
            {plotted.map((item) => (
              <button type="button" key={item.id} disabled={!onSelectSku} onClick={() => onSelectSku?.(item.id)}>
                <i style={{ backgroundColor: performanceMeta[item.performance].color }} />
                <span>{item.name}</span>
                <strong>{formatSignedPercent(item.relativeDelta)} · {performanceMeta[item.performance].label}</strong>
              </button>
            ))}
          </div>
          <table className="dashboard-chart-data-table">
            <caption>自有 SKU 相对市场表现{isSummary ? '摘要数据' : '完整数据'}</caption>
            <thead>
              <tr>
                <th scope="col">SKU</th>
                <th scope="col">相对市场</th>
                <th scope="col">判断</th>
              </tr>
            </thead>
            <tbody>
              {plotted.map((item) => (
                <tr key={item.id}>
                  <th scope="row">{item.name}</th>
                  <td>{formatSignedPercent(item.relativeDelta)}</td>
                  <td>{performanceMeta[item.performance].label}</td>
                </tr>
              ))}
              {!isSummary && pending.map((item) => (
                <tr key={item.id}>
                  <th scope="row">{item.name}</th>
                  <td>不可用</td>
                  <td>{performanceMeta[item.performance].label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <ChartEmptyState title="暂无可比较的 SKU" description="市场与 SKU 都形成 30 日基线后才会计算相对表现。" />
      )}
    </ChartCard>
  );
}

function compareByRelativeDeltaDescending(
  left: SkuRelativePerformanceItem & { relativeDelta: number },
  right: SkuRelativePerformanceItem & { relativeDelta: number },
): number {
  return right.relativeDelta - left.relativeDelta || left.id.localeCompare(right.id);
}

function compareByRelativeDeltaAscending(
  left: SkuRelativePerformanceItem & { relativeDelta: number },
  right: SkuRelativePerformanceItem & { relativeDelta: number },
): number {
  return left.relativeDelta - right.relativeDelta || left.id.localeCompare(right.id);
}
