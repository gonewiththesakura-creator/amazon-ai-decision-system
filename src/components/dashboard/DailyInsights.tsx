import clsx from 'clsx';
import { AlertTriangle, CircleCheck, DatabaseZap, Lightbulb, TrendingUp } from 'lucide-react';
import { ChartCard } from './ChartCard';
import { ChartEmptyState } from './ChartEmptyState';
import { EvidenceDrawer } from './EvidenceDrawer';
import type { DashboardInsightItem } from './types';

const insightMeta = {
  risk: { label: '风险', icon: AlertTriangle },
  opportunity: { label: '机会', icon: Lightbulb },
  competitor: { label: '竞品变化', icon: TrendingUp },
  positive: { label: '正向表现', icon: CircleCheck },
  data_warning: { label: '数据提醒', icon: DatabaseZap },
} satisfies Record<DashboardInsightItem['type'], { label: string; icon: typeof AlertTriangle }>;

export interface DailyInsightsProps {
  insights: DashboardInsightItem[];
  maxItems?: number;
}

export function DailyInsights({ insights, maxItems = 5 }: DailyInsightsProps) {
  const visibleInsights = insights.slice(0, Math.max(0, maxItems));
  return (
    <ChartCard title="AI 今日判断" eyebrow="TODAY'S SIGNALS" description="只展示会改变经营判断的正式结论。">
      {visibleInsights.length ? (
        <div className="executive-insight-list">
          {visibleInsights.map((insight) => {
            const meta = insightMeta[insight.type];
            const Icon = meta.icon;
            return (
              <article className={clsx('executive-insight', `executive-insight--${insight.type}`)} key={insight.id}>
                <span className="executive-insight__icon"><Icon size={17} aria-hidden="true" /></span>
                <div className="executive-insight__copy">
                  <span>{meta.label}</span>
                  <h3>{insight.title}</h3>
                  <p>{insight.summary}</p>
                </div>
                <EvidenceDrawer
                  evidence={insight.evidence}
                  lineage={insight.lineage}
                  researchJobHref={insight.researchJobHref}
                />
              </article>
            );
          })}
        </div>
      ) : (
        <ChartEmptyState title="今天暂无正式判断" description="完成数据分析后，带数据依据的结论会出现在这里。" />
      )}
    </ChartCard>
  );
}
