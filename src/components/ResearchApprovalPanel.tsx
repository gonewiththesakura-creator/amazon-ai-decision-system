import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Eye, RotateCcw, ShieldCheck, XCircle } from 'lucide-react';
import type { MissingDataItem, ResearchJobDetail, WorkflowEvidence } from '../../shared/types';
import { formatDateTime } from '../lib/format';
import { missingFieldLabel } from '../lib/researchJobMissingData';
import { canApproveResearchJob, selectCurrentInsightEvidence } from '../lib/researchJobs';
import { Badge } from './Badge';

export type ResearchApprovalDecision = 'approved' | 'watch' | 'needs_data' | 'rejected';

interface ResearchApprovalPanelProps {
  job: ResearchJobDetail;
  evidence: WorkflowEvidence[];
  missingData: MissingDataItem[];
  canEdit: boolean;
  busy: boolean;
  onDecision: (decision: ResearchApprovalDecision, reason: string, decidedBy: string) => Promise<void>;
}

const decisionOptions: Array<{
  value: ResearchApprovalDecision;
  label: string;
  description: string;
  icon: typeof CheckCircle2;
}> = [
  { value: 'approved', label: '批准下一阶段', description: '只批准当前审批门对应的下一步，不触发采购或付款。', icon: CheckCircle2 },
  { value: 'watch', label: '继续观察', description: '保留研究结果，等待后续数据变化再评估。', icon: Eye },
  { value: 'needs_data', label: '退回补数据', description: '回到缺失数据队列，补齐证据后重新运行。', icon: RotateCcw },
  { value: 'rejected', label: '拒绝', description: '保留当时证据、规则与人工理由，不删除研究记录。', icon: XCircle },
];

export function ResearchApprovalPanel({ job, evidence, missingData, canEdit, busy, onDecision }: ResearchApprovalPanelProps) {
  const [decision, setDecision] = useState<ResearchApprovalDecision>('approved');
  const [reason, setReason] = useState('');
  const [decidedBy, setDecidedBy] = useState('Admin');
  const [formError, setFormError] = useState<string | null>(null);
  const openMissingData = missingData.filter((item) => item.status === 'open');
  const blockingMissingData = openMissingData.filter((item) => item.requiredForDecision);
  const currentInsightEvidence = selectCurrentInsightEvidence(job, evidence);
  const approvalEvidenceReady = currentInsightEvidence.length > 0;
  const hardGatePassed = job.latestRuleExecution?.hardGateStatus === 'pass'
    && job.latestRuleExecution.dataVersion === job.dataVersion;
  const reverseReviewPassed = job.reverseReview !== undefined
    && ['proceed', 'proceed_with_caution'].includes(job.reverseReview.verdict);
  const approvalAllowed = !blockingMissingData.length
    && approvalEvidenceReady
    && hardGatePassed
    && reverseReviewPassed;
  const unresolvedRisks = useMemo(
    () => [...(job.reverseReview?.topFailureModes ?? [])]
      .filter((item) => !item.resolved)
      .sort((a, b) => ['critical', 'high', 'medium', 'low'].indexOf(a.severity) - ['critical', 'high', 'medium', 'low'].indexOf(b.severity)),
    [job.reverseReview],
  );

  useEffect(() => {
    setDecision(approvalAllowed ? 'approved' : 'needs_data');
    setReason('');
    setFormError(null);
  }, [approvalAllowed, job.id, job.status]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reason.trim() || !decidedBy.trim()) {
      setFormError('请填写审批人和可追溯的决策理由。');
      return;
    }
    setFormError(null);
    await onDecision(decision, reason.trim(), decidedBy.trim());
  };

  const approvalOpen = canApproveResearchJob(job.status);
  const confirmedFacts = currentInsightEvidence.map((item) => item.claim);
  const nextAction = job.latestInsight?.recommendedActions[0] ?? job.reverseReview?.recommendation;
  const maximumRisk = unresolvedRisks[0]?.risk ?? job.latestInsight?.risks[0];

  return (
    <section className="research-approval-panel" aria-labelledby="approval-panel-heading">
      <div className="section-heading">
        <div><span className="eyebrow">APPROVAL GATE</span><h2 id="approval-panel-heading">人工审批</h2><p>AI、规则引擎和 worker 均不能代替此处的业务决策。</p></div>
        <Badge tone={approvalOpen ? 'warning' : job.approval?.status === 'approved' ? 'positive' : 'neutral'}>
          {approvalOpen ? '等待人工决定' : job.approval ? `审批状态：${job.approval.status}` : '尚未进入审批门'}
        </Badge>
      </div>

      <dl className="approval-facts">
        <div><dt>当前 Insight 的证据事实</dt><dd>{confirmedFacts.length ? <ul>{confirmedFacts.map((fact, index) => <li key={`${fact}-${index}`}>{fact}</li>)}</ul> : <span className="muted">尚无与当前 Insight 明确关联的证据事实</span>}</dd></div>
        <div><dt>尚未确认的数据</dt><dd>{openMissingData.length ? <ul>{openMissingData.map((item) => <li key={item.id}>{missingFieldLabel(item.fieldName, item.label)}{item.requiredForDecision ? '（阻断决策）' : ''}</li>)}</ul> : <span className="muted">当前无开放的缺失数据记录</span>}</dd></div>
        <div><dt>AI 当前建议</dt><dd>{job.latestInsight?.summary ?? <span className="muted">尚未生成 AI 解释</span>}</dd></div>
        <div><dt>最大未排除风险</dt><dd>{maximumRisk ?? <span className="muted">尚无反向审查风险记录</span>}</dd></div>
        <div><dt>下一建议动作</dt><dd>{nextAction ?? <span className="muted">尚未形成建议动作</span>}</dd></div>
        <div><dt>审批责任</dt><dd>Admin 人工审批{job.approval?.requestedBy ? ` · 由 ${job.approval.requestedBy} 发起` : ''}</dd></div>
      </dl>

      {job.approval && !approvalOpen ? (
        <div className="approval-record">
          <ShieldCheck size={18} aria-hidden="true" />
          <div><strong>{job.approval.status === 'approved' ? '已批准' : job.approval.status === 'watch' ? '继续观察' : job.approval.status === 'needs_data' ? '已退回补数据' : job.approval.status === 'rejected' ? '已拒绝' : '审批待处理'}</strong><p>{job.approval.reason || '未记录理由'}</p><small>{job.approval.decidedBy ? `${job.approval.decidedBy} · ${formatDateTime(job.approval.decidedAt)}` : `发起于 ${formatDateTime(job.approval.requestedAt)}`}</small></div>
        </div>
      ) : null}

      {approvalOpen ? (
        <form className="approval-form" onSubmit={(event) => void submit(event)}>
          {!canEdit ? <div className="alert alert-info">Viewer 预览只能查看审批材料，请切回 Admin 后进行人工决策。</div> : null}
          {!approvalAllowed ? <div className="alert alert-warning"><AlertTriangle size={15} aria-hidden="true" />“批准下一阶段”已锁定：{blockingMissingData.length ? `${blockingMissingData.length} 项阻断数据未解决` : !hardGatePassed ? '当前数据版本的 Hard Gate 尚未通过' : !reverseReviewPassed ? 'Reverse Review 未完成或结论不允许推进' : '当前 Insight 缺少明确关联证据'}。</div> : null}
          <fieldset disabled={!canEdit || busy}>
            <legend>选择本次人工决定</legend>
            <div className="approval-options">
              {decisionOptions.map(({ value, label, description, icon: Icon }) => (
                <label className={`${decision === value ? 'approval-option is-selected' : 'approval-option'}${value === 'approved' && !approvalAllowed ? ' is-disabled' : ''}`} key={value}>
                  <input type="radio" name="research-decision" value={value} checked={decision === value} disabled={value === 'approved' && !approvalAllowed} onChange={() => setDecision(value)} />
                  <Icon size={18} aria-hidden="true" />
                  <span><strong>{label}</strong><small>{description}</small></span>
                </label>
              ))}
            </div>
            <div className="form-grid grid grid-2">
              <label className="field"><span>审批人</span><input className="input" value={decidedBy} onChange={(event) => setDecidedBy(event.target.value)} autoComplete="name" /></label>
              <label className="field field-span-2"><span>决策理由</span><textarea className="input" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="记录采用或不采用建议的依据" /></label>
            </div>
          </fieldset>
          {formError ? <p className="form-error" role="alert"><AlertTriangle size={14} aria-hidden="true" />{formError}</p> : null}
          <div className="approval-submit">
            <span>决定将连同数据版本、规则版本和当前证据永久记录。</span>
            <button className={decision === 'rejected' ? 'button button-danger' : 'button button--primary'} type="submit" disabled={!canEdit || busy || (decision === 'approved' && !approvalAllowed)}>{busy ? '正在记录' : decisionOptions.find((item) => item.value === decision)?.label}</button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
