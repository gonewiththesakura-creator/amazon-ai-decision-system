import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ExecutiveDevelopmentOpportunity } from '../../../shared/types';
import { ChartCard } from './ChartCard';
import { ChartEmptyState } from './ChartEmptyState';

const recommendationLabels: Record<ExecutiveDevelopmentOpportunity['systemRecommendation'], string> = {
  develop: '建议开发',
  test: '小规模验证',
  watch: '继续观察',
  reject: '暂不开发',
  needs_data: '待补数据',
};

function approvalLabel(item: ExecutiveDevelopmentOpportunity): string {
  if (item.approvalStatus === 'waiting') return '待审批';
  if (item.approvalStatus === 'approved') {
    const action = item.approvedAction && item.approvedAction in recommendationLabels
      ? recommendationLabels[item.approvedAction as ExecutiveDevelopmentOpportunity['systemRecommendation']]
      : item.approvedAction;
    return action ? `已批准（${action}）` : '已批准';
  }
  if (item.approvalStatus === 'watch') return '审批结论：继续观察';
  if (item.approvalStatus === 'rejected') return '已拒绝';
  if (item.approvalStatus === 'needs_data') return '已退回补数据';
  return '无需审批';
}

function statusTone(item: ExecutiveDevelopmentOpportunity): string | undefined {
  if (item.approvalStatus === 'rejected' || item.systemRecommendation === 'reject') return 'is-rejected';
  if (item.approvalStatus === 'waiting' || item.approvalStatus === 'watch'
    || item.approvalStatus === 'needs_data' || item.systemRecommendation === 'needs_data') {
    return 'is-pending';
  }
  return undefined;
}

export interface DevelopmentOpportunityChartProps {
  opportunities: ExecutiveDevelopmentOpportunity[];
  onSelectOpportunity?: (opportunityId: string) => void;
}

export function DevelopmentOpportunityChart({ opportunities, onSelectOpportunity }: DevelopmentOpportunityChartProps) {
  const scored = useMemo(() => opportunities
    .filter((item): item is ExecutiveDevelopmentOpportunity & { scoreStatus: 'scored'; score: number } => item.scoreStatus === 'scored' && item.score !== null && Number.isFinite(item.score))
    .sort((left, right) => right.score - left.score), [opportunities]);

  return (
    <ChartCard title="开发机会评分" eyebrow="FUTURE PRODUCTS" description="只绘制已通过前置约束且有有效评分的项目。">
      {!opportunities.length ? (
        <ChartEmptyState title="暂无完成评分的待开发产品" description="完成产品研究后，合法评分与数据状态会显示在这里。" />
      ) : (
        <div className="dashboard-opportunity-layout">
          {scored.length ? (
            <>
              <div className="dashboard-chart-frame dashboard-chart-frame--opportunities" aria-label="待开发产品机会评分柱状图">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={scored} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#e7ecea" strokeDasharray="3 4" vertical={false} />
                    <XAxis dataKey="name" tick={{ fill: '#33413e', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(value: string) => value.length > 7 ? `${value.slice(0, 7)}…` : value} />
                    <YAxis domain={[0, 100]} tick={{ fill: '#71807c', fontSize: 11 }} axisLine={false} tickLine={false} width={30} />
                    <Tooltip formatter={(value) => [typeof value === 'number' ? value.toFixed(0) : String(value), '机会评分']} contentStyle={{ border: '1px solid #dfe5e3', borderRadius: 6 }} />
                    <Bar dataKey="score" radius={[4, 4, 0, 0]} maxBarSize={54} isAnimationActive={false}>
                      {scored.map((item) => <Cell key={item.id} fill="#147763" cursor={onSelectOpportunity ? 'pointer' : 'default'} onClick={() => onSelectOpportunity?.(item.id)} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="dashboard-chart-values" aria-label="机会评分明细">
                {scored.map((item) => onSelectOpportunity ? (
                  <button type="button" key={item.id} onClick={() => onSelectOpportunity(item.id)}>{item.name}<strong>{item.score.toFixed(0)}</strong></button>
                ) : <span key={item.id}>{item.name}<strong>{item.score.toFixed(0)}</strong></span>)}
              </div>
            </>
          ) : null}

          <div className="dashboard-opportunity-status" aria-label="开发机会建议与审批状态">
            {opportunities.map((item) => (
              <button
                type="button"
                key={item.id}
                disabled={!onSelectOpportunity}
                onClick={() => onSelectOpportunity?.(item.id)}
                aria-label={`${item.name}，AI 建议：${recommendationLabels[item.systemRecommendation]}，审批状态：${approvalLabel(item)}`}
              >
                <span>
                  {item.name} · {item.scoreStatus === 'scored' && item.score !== null
                    ? `${item.score.toFixed(0)} 分`
                    : item.hardGate === 'reject' ? 'Hard Gate 未通过' : '待补数据'}
                </span>
                <strong className={statusTone(item)}>
                  AI 建议：{recommendationLabels[item.systemRecommendation]} · 审批状态：{approvalLabel(item)}
                </strong>
              </button>
            ))}
          </div>
        </div>
      )}
    </ChartCard>
  );
}
