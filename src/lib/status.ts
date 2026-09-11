import type { BriefingItem, PerformanceLevel, Provenance, TaskStatus } from '../../shared/types';

export const performanceMeta: Record<
  PerformanceLevel,
  { label: string; tone: 'positive' | 'neutral' | 'warning' | 'critical' }
> = {
  insufficient_data: { label: '数据不足', tone: 'warning' },
  strong_outperform: { label: '明显跑赢', tone: 'positive' },
  outperform: { label: '轻度跑赢', tone: 'positive' },
  in_line: { label: '基本同步', tone: 'neutral' },
  underperform: { label: '轻度跑输', tone: 'warning' },
  strong_underperform: { label: '明显跑输', tone: 'critical' },
};

export const severityMeta: Record<
  BriefingItem['severity'],
  { label: string; tone: 'critical' | 'warning' | 'positive' | 'info' }
> = {
  critical: { label: '风险', tone: 'critical' },
  warning: { label: '注意', tone: 'warning' },
  opportunity: { label: '机会', tone: 'positive' },
  info: { label: '情报', tone: 'info' },
};

export const taskStatusMeta: Record<TaskStatus, { label: string; tone: string }> = {
  pending: { label: '等待中', tone: 'neutral' },
  running: { label: '执行中', tone: 'info' },
  success: { label: '已完成', tone: 'positive' },
  partial: { label: '部分完成', tone: 'warning' },
  failed: { label: '失败', tone: 'critical' },
};

export function provenanceLabel(provenance: Provenance): string {
  const estimate = provenance.isEstimated ? ' · 估算' : '';
  return `${provenance.source}${estimate}`;
}
