import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  LoaderCircle,
  MinusCircle,
} from 'lucide-react';
import type { ResearchStep, ResearchStepStatus } from '../../shared/types';
import { formatDateTime } from '../lib/format';
import { researchStepLabels, researchStepStatusLabels, researchStepStatusTone } from '../lib/researchJobs';
import { Badge } from './Badge';

function StepIcon({ status }: { status: ResearchStepStatus }) {
  if (status === 'completed') return <CheckCircle2 size={18} aria-hidden="true" />;
  if (status === 'running') return <LoaderCircle className="spin" size={18} aria-hidden="true" />;
  if (status === 'failed') return <AlertTriangle size={18} aria-hidden="true" />;
  if (status === 'needs_data') return <Clock3 size={18} aria-hidden="true" />;
  if (status === 'skipped') return <MinusCircle size={18} aria-hidden="true" />;
  return <CircleDashed size={18} aria-hidden="true" />;
}

function hasRecordValues(record: Record<string, unknown>): boolean {
  return Object.keys(record).length > 0;
}

export function ResearchWorkflowTimeline({ steps }: { steps: ResearchStep[] }) {
  if (!steps.length) {
    return (
      <div className="workflow-empty">
        <CircleDashed size={22} aria-hidden="true" />
        <div><strong>尚未生成执行步骤</strong><span>运行任务后，采集、校验、规则、AI 与审批过程会按实际结果记录在这里。</span></div>
      </div>
    );
  }

  return (
    <ol className="workflow-timeline">
      {steps.map((step, index) => {
        const hasTrace = hasRecordValues(step.input) || hasRecordValues(step.output);
        return (
          <li className={`workflow-step workflow-step--${step.status}`} key={step.id}>
            <span className="workflow-step__rail" aria-hidden="true"><StepIcon status={step.status} /></span>
            <div className="workflow-step__body">
              <div className="workflow-step__heading">
                <div><small>STEP {String(index + 1).padStart(2, '0')}</small><strong>{researchStepLabels[step.stepType]}</strong></div>
                <Badge tone={researchStepStatusTone(step.status)}>{researchStepStatusLabels[step.status]}</Badge>
              </div>
              <div className="workflow-step__meta">
                <span>开始：{formatDateTime(step.startedAt)}</span>
                <span>完成：{formatDateTime(step.completedAt)}</span>
                {step.retryCount > 0 ? <span>已重试 {step.retryCount} 次</span> : null}
              </div>
              {step.error ? <p className="workflow-step__error" role="alert">{step.error}</p> : null}
              {hasTrace ? (
                <details className="workflow-trace">
                  <summary>查看步骤输入与输出</summary>
                  {hasRecordValues(step.input) ? <div><span>输入</span><pre>{JSON.stringify(step.input, null, 2)}</pre></div> : null}
                  {hasRecordValues(step.output) ? <div><span>输出</span><pre>{JSON.stringify(step.output, null, 2)}</pre></div> : null}
                </details>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
