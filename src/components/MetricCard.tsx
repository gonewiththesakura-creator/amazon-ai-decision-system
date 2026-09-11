import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';

interface MetricCardProps {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  trend?: number;
  icon?: LucideIcon;
  tone?: 'default' | 'positive' | 'warning' | 'critical';
}

export function MetricCard({ label, value, detail, trend, icon: Icon, tone = 'default' }: MetricCardProps) {
  const TrendIcon = trend === undefined || trend === 0 ? Minus : trend > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <div className={clsx('metric-card', `metric-card--${tone}`)}>
      <div className="metric-card__header">
        <span>{label}</span>
        {Icon ? <Icon size={16} aria-hidden="true" /> : null}
      </div>
      <div className="metric-card__value">{value}</div>
      {trend !== undefined ? (
        <div className={clsx('metric-card__trend', trend > 0 && 'is-positive', trend < 0 && 'is-negative')}>
          <TrendIcon size={14} aria-hidden="true" />
          <span>{trend > 0 ? '+' : ''}{trend.toFixed(1)}%</span>
          {detail ? <span className="metric-card__detail">{detail}</span> : null}
        </div>
      ) : detail ? (
        <div className="metric-card__detail">{detail}</div>
      ) : null}
    </div>
  );
}
