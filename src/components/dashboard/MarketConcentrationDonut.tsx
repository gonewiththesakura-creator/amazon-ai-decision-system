import { useState } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { ChartCard } from './ChartCard';
import { ChartEmptyState } from './ChartEmptyState';
import { formatPercent } from './format';
import type { DistributionSlice } from './types';

const defaultColors = ['#2e689f', '#147763', '#a86120', '#7b8784'];
export type ConcentrationMode = 'concentration' | 'price_band';

export interface MarketConcentrationDonutProps {
  concentration: DistributionSlice[];
  priceBands: DistributionSlice[];
  mode?: ConcentrationMode;
  onModeChange?: (mode: ConcentrationMode) => void;
}

export function MarketConcentrationDonut({ concentration, priceBands, mode, onModeChange }: MarketConcentrationDonutProps) {
  const [internalMode, setInternalMode] = useState<ConcentrationMode>('concentration');
  const activeMode = mode ?? internalMode;
  const source = activeMode === 'concentration' ? concentration : priceBands;
  const slices = source.filter((item): item is DistributionSlice & { value: number } => item.value !== null && Number.isFinite(item.value) && item.value > 0);
  const total = slices.reduce((sum, item) => sum + item.value, 0);

  const setMode = (nextMode: ConcentrationMode) => {
    if (mode === undefined) setInternalMode(nextMode);
    onModeChange?.(nextMode);
  };

  return (
    <ChartCard
      title={activeMode === 'concentration' ? '市场销量集中度' : '市场价格带'}
      eyebrow="MARKET STRUCTURE"
      action={(
        <div className="executive-segmented-control executive-segmented-control--compact" aria-label="市场结构模式">
          <button className={activeMode === 'concentration' ? 'is-active' : ''} aria-pressed={activeMode === 'concentration'} type="button" onClick={() => setMode('concentration')}>集中度</button>
          <button className={activeMode === 'price_band' ? 'is-active' : ''} aria-pressed={activeMode === 'price_band'} type="button" onClick={() => setMode('price_band')}>价格带</button>
        </div>
      )}
    >
      {slices.length && total > 0 ? (
        <div className="dashboard-donut-layout">
          <div className="dashboard-donut" aria-label={`${activeMode === 'concentration' ? '销量集中度' : '价格带'}环形图`}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={slices} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="88%" paddingAngle={2} stroke="#fff" strokeWidth={2} isAnimationActive={false}>
                  {slices.map((item, index) => <Cell key={item.label} fill={item.color ?? defaultColors[index % defaultColors.length]} />)}
                </Pie>
                <Tooltip formatter={(value) => [formatPercent(typeof value === 'number' ? value : Number(value), 1), '占比']} contentStyle={{ border: '1px solid #dfe5e3', borderRadius: 6 }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="dashboard-donut__center"><strong>{formatPercent(total, 0)}</strong><span>合计占比</span></div>
          </div>
          <div className="dashboard-donut-legend">
            {slices.map((item, index) => (
              <div key={item.label}>
                <i style={{ backgroundColor: item.color ?? defaultColors[index % defaultColors.length] }} />
                <span>{item.label}</span>
                <strong>{formatPercent(item.value, 1)}</strong>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <ChartEmptyState title="暂无市场结构数据" description="同步有效市场快照后展示集中度与价格带占比。" />
      )}
    </ChartCard>
  );
}
