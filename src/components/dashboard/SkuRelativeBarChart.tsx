import { useMemo } from 'react';
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
  const plotted = useMemo(() => items
    .filter((item): item is SkuRelativePerformanceItem & { relativeDelta: number } => item.relativeDelta !== null && Number.isFinite(item.relativeDelta))
    .sort((left, right) => right.relativeDelta - left.relativeDelta), [items]);
  const pendingCount = items.length - plotted.length;
  const pending = items.filter((item) => item.relativeDelta === null || !Number.isFinite(item.relativeDelta));

  return (
    <ChartCard
      title="4 SKU 相对市场表现"
      eyebrow="RELATIVE PERFORMANCE"
      description="SKU 30D 增长减去所属市场 30D 增长。"
      footer={pendingCount ? <span className="dashboard-chart-note">{pendingCount} 个 SKU 因历史数据不足未参与比较</span> : null}
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
            <caption>4 SKU 相对市场表现完整数据</caption>
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
              {pending.map((item) => (
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
