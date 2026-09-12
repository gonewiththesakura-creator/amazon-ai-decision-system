import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { ChartCard } from './ChartCard';
import { ChartEmptyState } from './ChartEmptyState';
import type { ResearchStatusItem } from './types';

const statusColors = ['#147763', '#2e689f', '#a86120', '#7b8784', '#b5433f', '#517c72', '#8a6d4d'];

export interface ResearchStatusChartProps {
  statuses: ResearchStatusItem[];
}

export function ResearchStatusChart({ statuses }: ResearchStatusChartProps) {
  const visible = statuses.filter((item) => Number.isFinite(item.count) && item.count > 0);
  const total = visible.reduce((sum, item) => sum + item.count, 0);
  const maxCount = Math.max(1, ...visible.map((item) => item.count));

  return (
    <ChartCard title="产品研究建议" eyebrow="SYSTEM RECOMMENDATIONS" description="仅统计系统建议，不混入人工审批结果。">
      {!visible.length ? (
        <ChartEmptyState title="暂无产品研究建议" description="完成产品研究流程后展示系统建议分布。" />
      ) : visible.length <= 5 ? (
        <div className="dashboard-donut-layout dashboard-donut-layout--status">
          <div className="dashboard-donut" aria-label="产品研究建议环形图">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={visible} dataKey="count" nameKey="label" innerRadius="62%" outerRadius="88%" paddingAngle={2} stroke="#fff" strokeWidth={2} isAnimationActive={false}>
                  {visible.map((item, index) => <Cell key={item.key} fill={item.color ?? statusColors[index % statusColors.length]} />)}
                </Pie>
                <Tooltip formatter={(value) => [typeof value === 'number' ? value : Number(value), '项目']} contentStyle={{ border: '1px solid #dfe5e3', borderRadius: 6 }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="dashboard-donut__center"><strong>{total}</strong><span>研究项目</span></div>
          </div>
          <div className="dashboard-donut-legend">
            {visible.map((item, index) => (
              <div key={item.key}>
                <i style={{ backgroundColor: item.color ?? statusColors[index % statusColors.length] }} />
                <span>{item.label}</span>
                <strong>{item.count}</strong>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="dashboard-status-bars" aria-label="产品研究建议水平条">
          {visible.map((item, index) => (
            <div key={item.key}>
              <span>{item.label}</span>
              <div><i style={{ width: `${(item.count / maxCount) * 100}%`, backgroundColor: item.color ?? statusColors[index % statusColors.length] }} /></div>
              <strong>{item.count}</strong>
            </div>
          ))}
        </div>
      )}
    </ChartCard>
  );
}
