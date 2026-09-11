import type { PropsWithChildren } from 'react';
import clsx from 'clsx';

interface BadgeProps extends PropsWithChildren {
  tone?: 'neutral' | 'positive' | 'warning' | 'critical' | 'info' | 'demo';
  className?: string;
}

export function Badge({ children, tone = 'neutral', className }: BadgeProps) {
  return <span className={clsx('badge', `badge--${tone}`, className)}>{children}</span>;
}
