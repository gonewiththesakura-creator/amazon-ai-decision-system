import type { ReactNode } from 'react';
import { AlertTriangle, DatabaseZap, LoaderCircle, RefreshCw } from 'lucide-react';
import { formatDateTime } from '../lib/format';

export function PageLoading({ label = '正在读取最新情报' }: { label?: string }) {
  return (
    <div className="state-view state-view--loading" role="status">
      <LoaderCircle className="spin" size={24} aria-hidden="true" />
      <div>
        <strong>{label}</strong>
        <p>正在校验历史快照与数据来源…</p>
      </div>
      <div className="skeleton-lines" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

interface ErrorStateProps {
  error?: Error | null;
  onRetry?: () => void;
  lastSuccessfulSync?: string | null;
  compact?: boolean;
}

export function ErrorState({ error, onRetry, lastSuccessfulSync, compact = false }: ErrorStateProps) {
  return (
    <div className={compact ? 'inline-alert inline-alert--critical' : 'state-view state-view--error'} role="alert">
      <AlertTriangle size={compact ? 18 : 24} aria-hidden="true" />
      <div className="state-view__copy">
        <strong>本次数据同步失败</strong>
        <p>{error?.message ?? '服务暂时不可用，请稍后重试。'}</p>
        {lastSuccessfulSync ? <small>上次成功同步：{formatDateTime(lastSuccessfulSync)}，可继续查看最近一次成功数据。</small> : null}
      </div>
      {onRetry ? (
        <button className="button button--secondary button--sm" type="button" onClick={onRetry}>
          <RefreshCw size={15} aria-hidden="true" />
          重试
        </button>
      ) : null}
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="state-view state-view--empty">
      <DatabaseZap size={28} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
