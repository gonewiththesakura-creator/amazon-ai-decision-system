import type { LucideIcon } from 'lucide-react';
import { ChartNoAxesCombined } from 'lucide-react';

export interface ChartEmptyStateProps {
  title: string;
  description: string;
  icon?: LucideIcon;
}

export function ChartEmptyState({ title, description, icon: Icon = ChartNoAxesCombined }: ChartEmptyStateProps) {
  return (
    <div className="dashboard-chart-empty" role="status">
      <span className="dashboard-chart-empty__icon"><Icon size={22} aria-hidden="true" /></span>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
    </div>
  );
}
