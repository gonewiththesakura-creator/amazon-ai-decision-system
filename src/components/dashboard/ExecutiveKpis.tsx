import clsx from 'clsx';
import { ChartNoAxesCombined, CircleGauge, Rocket, TriangleAlert } from 'lucide-react';
import type { ExecutiveKpiData } from './types';
import { formatSignedPercent } from './format';

export interface ExecutiveKpisProps {
  kpis: ExecutiveKpiData;
}

export function ExecutiveKpis({ kpis }: ExecutiveKpisProps) {
  const marketAvailable = kpis.marketGrowth !== null && Number.isFinite(kpis.marketGrowth);
  const skuComparisonAvailable = kpis.outperformingSkus !== null;
  const attentionAvailable = kpis.attentionSkus !== null;
  const competitorAvailable = kpis.fastGrowthCompetitors !== null;
  const entries = [
    {
      key: 'market',
      label: '市场 30D',
      value: marketAvailable ? formatSignedPercent(kpis.marketGrowth as number) : '—',
      detail: marketAvailable ? kpis.marketGrowthLabel : '暂无完整30日基线',
      tone: marketAvailable && (kpis.marketGrowth as number) < 0 ? 'critical' : 'info',
      Icon: ChartNoAxesCombined,
    },
    {
      key: 'outperform',
      label: '跑赢市场 SKU',
      value: skuComparisonAvailable ? `${kpis.outperformingSkus} / ${kpis.totalSkus}` : `— / ${kpis.totalSkus}`,
      detail: skuComparisonAvailable ? '当前有效对比' : '暂无可比历史基线',
      tone: skuComparisonAvailable ? 'positive' : 'warning',
      Icon: CircleGauge,
    },
    {
      key: 'attention',
      label: '需要关注 SKU',
      value: attentionAvailable ? String(kpis.attentionSkus) : '—',
      detail: attentionAvailable ? kpis.attentionSkus ? '建议今天查看' : '当前无异常' : '暂无有效诊断',
      tone: attentionAvailable ? kpis.attentionSkus ? 'critical' : 'neutral' : 'warning',
      Icon: TriangleAlert,
    },
    {
      key: 'competitors',
      label: '高增长竞品',
      value: competitorAvailable ? String(kpis.fastGrowthCompetitors) : '—',
      detail: competitorAvailable ? '规则识别结果' : '竞品组尚未建立',
      tone: competitorAvailable ? kpis.fastGrowthCompetitors ? 'warning' : 'neutral' : 'warning',
      Icon: Rocket,
    },
  ] as const;

  return (
    <section className="executive-kpi-grid" aria-label="经营关键指标">
      {entries.map(({ key, label, value, detail, tone, Icon }) => (
        <article className={clsx('executive-kpi', `executive-kpi--${tone}`)} key={key}>
          <div className="executive-kpi__heading">
            <span>{label}</span>
            <Icon size={17} aria-hidden="true" />
          </div>
          <strong className="executive-kpi__value">{value}</strong>
          <span className="executive-kpi__detail">{detail}</span>
        </article>
      ))}
    </section>
  );
}
