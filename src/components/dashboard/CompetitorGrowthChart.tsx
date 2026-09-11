import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartCard } from './ChartCard';
import { ChartEmptyState } from './ChartEmptyState';
import { formatCurrency, formatInteger, formatSignedPercent } from './format';
import type { CompetitorGrowthItem } from './types';

export interface CompetitorGrowthChartProps {
  competitors: CompetitorGrowthItem[];
  currency?: string;
  onSelectCompetitor?: (competitorId: string) => void;
}

export function CompetitorGrowthChart({ competitors, currency = 'USD', onSelectCompetitor }: CompetitorGrowthChartProps) {
  const plotted = useMemo(() => competitors
    .filter((item): item is CompetitorGrowthItem & { growth: number } => item.growth !== null && Number.isFinite(item.growth))
    .sort((left, right) => right.growth - left.growth)
    .slice(0, 10), [competitors]);

  return (
    <ChartCard title="竞品增长 TOP10" eyebrow="COMPETITOR MOVEMENT" description="仅展示已建立关系并有有效增长基线的竞品。">
      {plotted.length ? (
        <>
          <div className="dashboard-chart-frame dashboard-chart-frame--ranking" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={plotted} layout="vertical" margin={{ top: 2, right: 34, left: 12, bottom: 0 }}>
              <CartesianGrid stroke="#e7ecea" strokeDasharray="3 4" horizontal={false} />
              <XAxis type="number" tickFormatter={(value: number) => `${value > 0 ? '+' : ''}${value}%`} tick={{ fill: '#71807c', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis
                type="category"
                dataKey="name"
                width={150}
                axisLine={false}
                tickLine={false}
                tick={({ x, y, payload }) => {
                  const item = plotted.find((entry) => entry.name === String(payload.value));
                  const name = item?.name ?? String(payload.value);
                  const secondary = item
                    ? `${formatCurrency(item.price, currency)} · ★ ${item.rating?.toFixed(1) ?? '—'} · ${formatInteger(item.reviews)}${item.tags[0] ? ` · ${item.tags[0]}` : ''}`
                    : '';
                  return (
                    <g transform={`translate(${x},${y})`}>
                      <text x={-7} y={-3} textAnchor="end" fill="#33413e" fontSize={10} fontWeight={650}>{name.length > 16 ? `${name.slice(0, 16)}…` : name}</text>
                      <text x={-7} y={10} textAnchor="end" fill="#7b8784" fontSize={8}>{secondary.length > 27 ? `${secondary.slice(0, 27)}…` : secondary}</text>
                    </g>
                  );
                }}
              />
              <Tooltip
                cursor={{ fill: '#f3f6f5' }}
                content={({ active, payload }) => {
                  const item = payload?.[0]?.payload as CompetitorGrowthItem | undefined;
                  if (!active || !item || item.growth === null) return null;
                  return (
                    <div className="dashboard-chart-tooltip">
                      <strong>{item.name}</strong>
                      <span>{item.asin}</span>
                      <dl>
                        <div><dt>增长</dt><dd>{formatSignedPercent(item.growth)}</dd></div>
                        <div><dt>价格</dt><dd>{formatCurrency(item.price, currency)}</dd></div>
                        <div><dt>Rating</dt><dd>{item.rating?.toFixed(1) ?? '—'}</dd></div>
                        <div><dt>Review</dt><dd>{formatInteger(item.reviews)}</dd></div>
                      </dl>
                      {item.tags.length ? <div className="dashboard-chart-tooltip__tags">{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
                    </div>
                  );
                }}
              />
              <Bar dataKey="growth" radius={[0, 4, 4, 0]} maxBarSize={23} isAnimationActive={false}>
                {plotted.map((item) => (
                  <Cell key={item.id} fill={item.growth >= 0 ? '#147763' : '#b5433f'} cursor={onSelectCompetitor ? 'pointer' : 'default'} onClick={() => onSelectCompetitor?.(item.id)} />
                ))}
              </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <table className="dashboard-chart-data-table">
            <caption>竞品增长 TOP10 完整数据</caption>
            <thead>
              <tr>
                <th scope="col">排名</th>
                <th scope="col">竞品</th>
                <th scope="col">ASIN</th>
                <th scope="col">增长</th>
                <th scope="col">价格</th>
                <th scope="col">Rating</th>
                <th scope="col">Review</th>
                <th scope="col">标签</th>
              </tr>
            </thead>
            <tbody>
              {plotted.map((item, index) => (
                <tr key={item.id}>
                  <th scope="row">{index + 1}</th>
                  <td>{item.name}</td>
                  <td>{item.asin}</td>
                  <td>{formatSignedPercent(item.growth)}</td>
                  <td>{item.price === null ? '不可用' : formatCurrency(item.price, currency)}</td>
                  <td>{item.rating === null ? '不可用' : item.rating.toFixed(1)}</td>
                  <td>{item.reviews === null ? '不可用' : formatInteger(item.reviews)}</td>
                  <td>{item.tags.length ? item.tags.join('、') : '无'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <ChartEmptyState title="尚未建立直接竞品组" description="建立竞品关系并积累历史快照后展示增长排行。" />
      )}
    </ChartCard>
  );
}
