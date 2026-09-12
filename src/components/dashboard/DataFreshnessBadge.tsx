import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, CircleHelp, ClockAlert } from 'lucide-react';
import { formatDashboardDate } from './format';
import type { DataFreshnessState } from './types';

const stateMeta = {
  normal: { label: '数据正常', icon: CheckCircle2 },
  partial: { label: '部分数据未更新', icon: AlertTriangle },
  insufficient: { label: '数据不足', icon: CircleHelp },
  stale: { label: '数据陈旧', icon: ClockAlert },
} satisfies Record<DataFreshnessState, { label: string; icon: typeof CheckCircle2 }>;

export interface DataFreshnessBadgeProps {
  status: DataFreshnessState;
  updatedAt: string | null;
  isDemo?: boolean;
  label?: string;
  message?: string;
  onClick?: () => void;
}

export function DataFreshnessBadge({ status, updatedAt, isDemo = false, label, message, onClick }: DataFreshnessBadgeProps) {
  const meta = stateMeta[status];
  const Icon = meta.icon;
  const statusLabel = label === '正常' ? '数据正常' : label ?? meta.label;
  const contents = (
    <>
      <Icon size={14} aria-hidden="true" />
      <span>{statusLabel}</span>
      {updatedAt ? <small>更新于 {formatDashboardDate(updatedAt, true)}</small> : null}
    </>
  );

  return (
    <div className="executive-data-state">
      {isDemo ? <strong className="executive-demo-label">DEMO / 演示数据</strong> : null}
      {onClick ? (
        <button className={clsx('executive-freshness', `executive-freshness--${status}`)} type="button" title={message} onClick={onClick}>
          {contents}
        </button>
      ) : (
        <span className={clsx('executive-freshness', `executive-freshness--${status}`)} title={message}>{contents}</span>
      )}
    </div>
  );
}
