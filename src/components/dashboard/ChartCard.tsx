import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface ChartCardProps {
  title: string;
  eyebrow?: string;
  description?: string;
  action?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  spacious?: boolean;
}

export function ChartCard({
  title,
  eyebrow,
  description,
  action,
  footer,
  children,
  className,
  spacious = false,
}: ChartCardProps) {
  return (
    <section className={clsx('dashboard-chart-card', spacious && 'dashboard-chart-card--spacious', className)}>
      <header className="dashboard-chart-card__header">
        <div>
          {eyebrow ? <span className="dashboard-chart-card__eyebrow">{eyebrow}</span> : null}
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {action ? <div className="dashboard-chart-card__action">{action}</div> : null}
      </header>
      <div className="dashboard-chart-card__body">{children}</div>
      {footer ? <footer className="dashboard-chart-card__footer">{footer}</footer> : null}
    </section>
  );
}
