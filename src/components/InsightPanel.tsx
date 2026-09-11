import { AlertOctagon, ArrowRight, CheckCircle2, Lightbulb, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Insight } from '../../shared/types';
import { formatConfidence, formatDateTime } from '../lib/format';
import { Badge } from './Badge';
import { EvidenceDrawer } from './EvidenceDrawer';

export function InsightPanel({ insight, title = 'AI 判断' }: { insight: Insight; title?: string }) {
  const insufficientData = insight.status === '数据不足';
  const workflowRequired = insight.insightType === 'workflow_required';
  const confidenceTone = insight.confidence >= 0.8 ? 'positive' : insight.confidence >= 0.6 ? 'warning' : 'critical';
  return (
    <section className="insight-panel">
      <header className="insight-panel__header">
        <div className="insight-panel__icon"><Sparkles size={19} aria-hidden="true" /></div>
        <div>
          <span className="eyebrow">{title}</span>
          <h2>{insight.title}</h2>
        </div>
        <div className="insight-panel__meta">
          {!insufficientData && insight.score !== undefined ? <strong>{insight.score}<small>/100</small></strong> : null}
          {insufficientData ? <Badge tone="warning">数据不足</Badge> : <Badge tone={confidenceTone}>置信度 {formatConfidence(insight.confidence)}</Badge>}
        </div>
      </header>
      <p className="insight-panel__summary">{insight.summary}</p>

      {!insufficientData ? <div className="insight-columns">
        <div>
          <h3><Lightbulb size={16} aria-hidden="true" />机会</h3>
          {insight.opportunities.length ? (
            <ul>{insight.opportunities.map((item) => <li key={item}>{item}</li>)}</ul>
          ) : <p className="muted">暂无明确机会信号</p>}
        </div>
        <div>
          <h3><AlertOctagon size={16} aria-hidden="true" />风险</h3>
          {insight.risks.length ? (
            <ul>{insight.risks.map((item) => <li key={item}>{item}</li>)}</ul>
          ) : <p className="muted">暂无高优先级风险</p>}
        </div>
        <div>
          <h3><CheckCircle2 size={16} aria-hidden="true" />建议动作</h3>
          {insight.recommendedActions.length ? (
            <ul>{insight.recommendedActions.map((item) => <li key={item}><ArrowRight size={14} aria-hidden="true" />{item}</li>)}</ul>
          ) : <p className="muted">等待更多数据后给出动作</p>}
        </div>
      </div> : null}

      <footer className="insight-panel__footer">
        {workflowRequired ? (
          <Link className="button button--secondary" to={`/research-jobs?entityType=${encodeURIComponent(insight.entityType)}&entityId=${encodeURIComponent(insight.entityId)}`}>
            创建或打开 Research Job <ArrowRight size={14} aria-hidden="true" />
          </Link>
        ) : (
          <>
            <span>生成于 {formatDateTime(insight.generatedAt)}</span>
            <span>数据版本 {insight.dataVersion}</span>
            <EvidenceDrawer insight={insight} />
          </>
        )}
      </footer>
    </section>
  );
}
