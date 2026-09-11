import { Database, FileSearch } from 'lucide-react';
import type { WorkflowEvidence } from '../../shared/types';
import { formatConfidence, formatDateTime } from '../lib/format';
import { Badge } from './Badge';

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function WorkflowEvidenceList({ evidence }: { evidence: WorkflowEvidence[] }) {
  if (!evidence.length) {
    return (
      <div className="workflow-empty">
        <FileSearch size={22} aria-hidden="true" />
        <div><strong>尚无可引用证据</strong><span>在证据记录生成前，页面不会把 AI 文本展示为已确认结论。</span></div>
      </div>
    );
  }

  return (
    <div className="workflow-evidence-list">
      {evidence.map((item, index) => (
        <article className="workflow-evidence" id={`evidence-${item.id}`} key={item.id}>
          <div className="workflow-evidence__index">{String(index + 1).padStart(2, '0')}</div>
          <div className="workflow-evidence__claim">
            <span>结论</span>
            <strong>{item.claim}</strong>
            <div className="workflow-evidence__source">
              <Database size={13} aria-hidden="true" />
              <span>{item.source}</span>
              <span>{item.sourceType.toUpperCase()}{item.isEstimated ? ' · 估算' : ''}</span>
              {item.sourceRecordId ? <code>{item.sourceRecordId}</code> : null}
              <time>{formatDateTime(item.collectedAt)}</time>
            </div>
          </div>
          <div className="workflow-evidence__metric">
            <span>{item.metricName}</span>
            <strong>{displayValue(item.metricValue)}</strong>
          </div>
          <div className="workflow-evidence__calculation">
            <span>计算 / 依据</span>
            <code>{item.calculation || '未记录计算过程'}</code>
            <small>{item.period} · 数据版本 {item.dataVersion}</small>
          </div>
          <Badge tone={item.confidence >= 0.8 ? 'positive' : item.confidence >= 0.6 ? 'warning' : 'critical'}>
            置信度 {formatConfidence(item.confidence)}
          </Badge>
        </article>
      ))}
    </div>
  );
}
