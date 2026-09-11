import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronRight,
  DatabaseZap,
  FileSearch,
  Filter,
  Gauge,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  X,
} from 'lucide-react';
import type {
  MissingDataItem,
  DevelopmentProject,
  MarketNode,
  Opportunity,
  OwnedProductSummary,
  ResearchJobDetail,
  ResearchJobStatus,
  ResearchJobSummary,
  ResearchJobType,
  RuleProfile,
  WorkflowEvidence,
} from '../../shared/types';
import { Badge } from '../components/Badge';
import { ResearchApprovalPanel, type ResearchApprovalDecision } from '../components/ResearchApprovalPanel';
import { ResearchWorkflowTimeline } from '../components/ResearchWorkflowTimeline';
import { EmptyState, ErrorState, PageLoading } from '../components/StateViews';
import { WorkflowEvidenceList } from '../components/WorkflowEvidenceList';
import { api, useApi } from '../lib/api';
import { useApp } from '../lib/AppContext';
import { formatDateTime, formatDecimal } from '../lib/format';
import { missingFieldLabel, missingValueKind, parseMissingFieldValue } from '../lib/researchJobMissingData';
import { parsePastedReviews } from '../lib/reviewInput';
import {
  canApproveResearchJob,
  canRetryResearchJob,
  canRunResearchJob,
  isResearchJobActive,
  researchJobStatusLabels,
  researchJobStatusTone,
  researchJobTypeLabels,
  selectCurrentInsightEvidence,
  selectCurrentVersionEvidence,
} from '../lib/researchJobs';

type JobStatusFilter = 'all' | ResearchJobStatus;
type JobTypeFilter = 'all' | ResearchJobType;

interface CreateJobForm {
  name: string;
  type: ResearchJobType;
  entityType: string;
  entityId: string;
  ruleProfileId: string;
  createdBy: string;
  objective: string;
  keywords: string;
  taskBook: {
    categoryScope: string;
    productIdea: string;
    priceMin: string;
    priceMax: string;
    totalBudget: string;
    perProductBudget: string;
    minProfitRate: string;
    maxWeight: string;
    maxLength: string;
    maxWidth: string;
    maxHeight: string;
    allowedMaterials: string;
    supplyChainCapability: string;
    prohibitedProductTypes: string;
    complianceTolerance: 'low' | 'medium' | 'high';
    seasonalityTolerance: 'low' | 'medium' | 'high';
    targetCustomer: string;
    buyerNeed: string;
    notes: string;
  };
  workflowInput: {
    ipRisk: '' | 'low' | 'medium' | 'high' | 'critical';
    certificationRequired: '' | 'true' | 'false';
    certificationAvailable: '' | 'true' | 'false';
    estimatedContributionProfitRate: string;
    moqCost: string;
    weight: string;
    length: string;
    width: string;
    height: string;
    supplyChainValidation: '' | 'true' | 'false';
    monthlySales: string;
    growth30d: string;
    top10SalesShare: string;
    medianReviews: string;
    supplyChainFitScore: string;
    riskControlScore: string;
    reviewSamples: string;
  };
}

interface ResearchEntityOption {
  id: string;
  label: string;
}

type ResearchEntityOptions = Record<ResearchJobType, ResearchEntityOption[]>;

const createFormInitial: CreateJobForm = {
  name: '',
  type: 'existing_market',
  entityType: 'market_node',
  entityId: '',
  ruleProfileId: '',
  createdBy: 'Admin',
  objective: '',
  keywords: '',
  taskBook: {
    categoryScope: '', productIdea: '', priceMin: '', priceMax: '', totalBudget: '', perProductBudget: '',
    minProfitRate: '', maxWeight: '', maxLength: '', maxWidth: '', maxHeight: '', allowedMaterials: '',
    supplyChainCapability: '', prohibitedProductTypes: '', complianceTolerance: 'medium',
    seasonalityTolerance: 'medium', targetCustomer: '', buyerNeed: '', notes: '',
  },
  workflowInput: {
    ipRisk: '', certificationRequired: '', certificationAvailable: '', estimatedContributionProfitRate: '',
    moqCost: '', weight: '', length: '', width: '', height: '', supplyChainValidation: '', monthlySales: '',
    growth30d: '', top10SalesShare: '', medianReviews: '', supplyChainFitScore: '', riskControlScore: '',
    reviewSamples: '',
  },
};

const jobStatuses = Object.keys(researchJobStatusLabels) as ResearchJobStatus[];
const jobTypes = Object.keys(researchJobTypeLabels) as ResearchJobType[];

const reverseVerdictLabels: Record<NonNullable<ResearchJobDetail['reverseReview']>['verdict'], string> = {
  proceed: '可继续',
  proceed_with_caution: '谨慎推进',
  needs_data: '需补数据',
  reject: '建议拒绝',
};

const hardGateLabels: Record<'pass' | 'reject' | 'needs_data', string> = {
  pass: 'PASS',
  reject: 'REJECT',
  needs_data: 'NEEDS DATA',
};

const reviewIssueLabels: Record<string, string> = {
  too_firm: '太硬',
  too_soft: '太软',
  odor: '气味',
  neck_pressure: '颈部压力',
  height_discomfort: '高度不适',
  center_depression: '中央凹陷',
  cover: '枕套',
  size: '尺寸',
  temperature: '温度',
  cleaning: '清洁',
  packaging: '包装',
  expectation_gap: '使用预期落差',
  other: '其他',
};

const reviewOpportunityLabels: Record<ResearchJobDetail['reviewInsights'][number]['opportunityLevel'], string> = {
  insufficient_evidence: '证据不足',
  low: '低',
  medium: '中',
  high: '高',
};

function entityTypeForJob(type: ResearchJobType): string {
  if (type === 'existing_market') return 'market_node';
  if (type === 'owned_product') return 'owned_product';
  if (type === 'adjacent_product') return 'development_project';
  return '';
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return formatDecimal(value);
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function titleCaseKey(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
}

function optionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalBoolean(value: '' | 'true' | 'false'): boolean | undefined {
  if (!value) return undefined;
  return value === 'true';
}

function commaList(value: string): string[] {
  return value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0)));
}

function buildTaskBook(form: CreateJobForm, marketplace: string, currency: string): Record<string, unknown> {
  if (form.type !== 'adjacent_product' && form.type !== 'new_opportunity') return {};
  const taskBook = form.taskBook;
  const priceMin = optionalNumber(taskBook.priceMin);
  const priceMax = optionalNumber(taskBook.priceMax);
  const maxLength = optionalNumber(taskBook.maxLength);
  const maxWidth = optionalNumber(taskBook.maxWidth);
  const maxHeight = optionalNumber(taskBook.maxHeight);
  return compactRecord({
    marketplace,
    category_scope: taskBook.categoryScope.trim(),
    product_idea: taskBook.productIdea.trim(),
    price_range: priceMin !== undefined && priceMax !== undefined ? { min: priceMin, max: priceMax, currency } : undefined,
    total_budget: optionalNumber(taskBook.totalBudget),
    per_product_budget: optionalNumber(taskBook.perProductBudget),
    min_profit_rate: optionalNumber(taskBook.minProfitRate),
    max_weight: optionalNumber(taskBook.maxWeight),
    max_dimension: maxLength !== undefined && maxWidth !== undefined && maxHeight !== undefined
      ? { length: maxLength, width: maxWidth, height: maxHeight, unit: 'cm' }
      : undefined,
    allowed_materials: commaList(taskBook.allowedMaterials),
    supply_chain_capability: commaList(taskBook.supplyChainCapability),
    prohibited_product_types: commaList(taskBook.prohibitedProductTypes),
    compliance_tolerance: taskBook.complianceTolerance,
    seasonality_tolerance: taskBook.seasonalityTolerance,
    target_customer: taskBook.targetCustomer.trim(),
    buyer_need: taskBook.buyerNeed.trim(),
    notes: taskBook.notes.trim(),
  });
}

function buildWorkflowInput(form: CreateJobForm): Record<string, unknown> {
  const base = compactRecord({
    objective: form.objective.trim(),
    keywords: commaList(form.keywords),
  });
  if (form.type !== 'adjacent_product' && form.type !== 'new_opportunity') return base;
  const input = form.workflowInput;
  const length = optionalNumber(input.length);
  const width = optionalNumber(input.width);
  const height = optionalNumber(input.height);
  return compactRecord({
    ...base,
    ip_risk: input.ipRisk,
    certification_required: optionalBoolean(input.certificationRequired),
    certification_available: input.certificationRequired === 'true' ? optionalBoolean(input.certificationAvailable) : undefined,
    estimated_contribution_profit_rate: optionalNumber(input.estimatedContributionProfitRate),
    moq_cost: optionalNumber(input.moqCost),
    weight: optionalNumber(input.weight),
    dimensions: length !== undefined && width !== undefined && height !== undefined
      ? { length, width, height, unit: 'cm' }
      : undefined,
    supply_chain_validation: optionalBoolean(input.supplyChainValidation),
    monthly_sales: optionalNumber(input.monthlySales),
    growth_30d: optionalNumber(input.growth30d),
    top10_sales_share: optionalNumber(input.top10SalesShare),
    median_reviews: optionalNumber(input.medianReviews),
    supply_chain_fit_score: optionalNumber(input.supplyChainFitScore),
    risk_control_score: optionalNumber(input.riskControlScore),
    reviews: parsePastedReviews(input.reviewSamples),
  });
}

const taskBookLabels: Record<string, string> = {
  marketplace: 'Marketplace', category_scope: '类目范围', product_idea: '产品设想', price_range: '目标价格带',
  total_budget: '总预算', per_product_budget: '单品预算', min_profit_rate: '最低利润率', max_weight: '最大重量',
  max_dimension: '最大尺寸', allowed_materials: '允许材料', supply_chain_capability: '供应链能力',
  prohibited_product_types: '禁做品类', compliance_tolerance: '合规容忍度', seasonality_tolerance: '季节性容忍度',
  target_customer: '目标客户', buyer_need: '买家需求', notes: '备注',
};

function TaskBookSummary({ job }: { job: ResearchJobDetail }) {
  if (job.type !== 'adjacent_product' && job.type !== 'new_opportunity') return null;
  const entries = Object.entries(taskBookLabels);
  return (
    <section className="research-detail-section research-task-book">
      <div className="section-heading"><div><span className="eyebrow">RESEARCH TASK BOOK</span><h2>选品任务书</h2><p>Hard Gate 与评分使用的业务边界，空值保持未填写。</p></div></div>
      <dl className="task-book-grid">
        {entries.map(([key, label]) => <div className={!Object.prototype.hasOwnProperty.call(job.taskBook, key) ? 'is-missing' : ''} key={key}><dt>{label}</dt><dd>{Object.prototype.hasOwnProperty.call(job.taskBook, key) ? stringifyValue(job.taskBook[key]) : '— 未填写'}</dd></div>)}
      </dl>
    </section>
  );
}

function ProductResearchInputs({
  form,
  currency,
  onTaskBookChange,
  onInputChange,
}: {
  form: CreateJobForm;
  currency: string;
  onTaskBookChange: (key: keyof CreateJobForm['taskBook'], value: string) => void;
  onInputChange: (key: keyof CreateJobForm['workflowInput'], value: string) => void;
}) {
  const taskBookNumbers: Array<[keyof CreateJobForm['taskBook'], string, string]> = [
    ['totalBudget', '总预算', currency],
    ['perProductBudget', '单品预算', currency],
    ['minProfitRate', '最低利润率', '%'],
    ['maxWeight', '最大重量', 'kg'],
  ];
  const workflowNumbers: Array<[keyof CreateJobForm['workflowInput'], string, string]> = [
    ['estimatedContributionProfitRate', '预计贡献利润率', '%'],
    ['moqCost', 'MOQ 成本', currency],
    ['weight', '产品重量', 'kg'],
    ['monthlySales', '月销量', '件'],
    ['growth30d', '30D 增长', '%'],
    ['top10SalesShare', 'TOP10 销售占比', '%'],
    ['medianReviews', 'Review 中位数', '条'],
    ['supplyChainFitScore', '供应链适配分', '0–100'],
    ['riskControlScore', '风险可控分', '0–100'],
  ];

  return (
    <div className="product-research-inputs field-span-2">
      <fieldset className="research-form-group">
        <legend>选品任务书</legend>
        <p>定义业务边界；未填写项不会自动推断或补 0。</p>
        <div className="form-grid grid grid-2">
          <label className="field"><span>类目范围</span><input className="input" value={form.taskBook.categoryScope} onChange={(event) => onTaskBookChange('categoryScope', event.target.value)} /></label>
          <label className="field"><span>产品设想</span><input className="input" value={form.taskBook.productIdea} onChange={(event) => onTaskBookChange('productIdea', event.target.value)} /></label>
          <label className="field"><span>目标价格下限（{currency}）</span><input className="input" type="number" step="0.01" min="0" value={form.taskBook.priceMin} onChange={(event) => onTaskBookChange('priceMin', event.target.value)} /></label>
          <label className="field"><span>目标价格上限（{currency}）</span><input className="input" type="number" step="0.01" min="0" value={form.taskBook.priceMax} onChange={(event) => onTaskBookChange('priceMax', event.target.value)} /></label>
          {taskBookNumbers.map(([key, label, unit]) => <label className="field" key={key}><span>{label}（{unit}）</span><input className="input" type="number" step="any" min={key === 'minProfitRate' ? undefined : 0} value={form.taskBook[key]} onChange={(event) => onTaskBookChange(key, event.target.value)} /></label>)}
          <div className="dimension-fields field-span-2"><span>最大尺寸（cm）</span><div><input className="input" type="number" step="0.1" min="0" value={form.taskBook.maxLength} onChange={(event) => onTaskBookChange('maxLength', event.target.value)} aria-label="最大长度" placeholder="长" /><span>×</span><input className="input" type="number" step="0.1" min="0" value={form.taskBook.maxWidth} onChange={(event) => onTaskBookChange('maxWidth', event.target.value)} aria-label="最大宽度" placeholder="宽" /><span>×</span><input className="input" type="number" step="0.1" min="0" value={form.taskBook.maxHeight} onChange={(event) => onTaskBookChange('maxHeight', event.target.value)} aria-label="最大高度" placeholder="高" /></div></div>
          <label className="field"><span>允许材料</span><input className="input" value={form.taskBook.allowedMaterials} onChange={(event) => onTaskBookChange('allowedMaterials', event.target.value)} placeholder="逗号分隔" /></label>
          <label className="field"><span>供应链能力</span><input className="input" value={form.taskBook.supplyChainCapability} onChange={(event) => onTaskBookChange('supplyChainCapability', event.target.value)} placeholder="逗号分隔" /></label>
          <label className="field field-span-2"><span>禁做产品类型</span><input className="input" value={form.taskBook.prohibitedProductTypes} onChange={(event) => onTaskBookChange('prohibitedProductTypes', event.target.value)} placeholder="逗号分隔" /></label>
          <label className="field"><span>合规风险容忍度</span><select className="input" value={form.taskBook.complianceTolerance} onChange={(event) => onTaskBookChange('complianceTolerance', event.target.value)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
          <label className="field"><span>季节性容忍度</span><select className="input" value={form.taskBook.seasonalityTolerance} onChange={(event) => onTaskBookChange('seasonalityTolerance', event.target.value)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
          <label className="field"><span>目标客户</span><input className="input" value={form.taskBook.targetCustomer} onChange={(event) => onTaskBookChange('targetCustomer', event.target.value)} /></label>
          <label className="field"><span>买家需求</span><input className="input" value={form.taskBook.buyerNeed} onChange={(event) => onTaskBookChange('buyerNeed', event.target.value)} /></label>
          <label className="field field-span-2"><span>任务书备注</span><textarea className="input" value={form.taskBook.notes} onChange={(event) => onTaskBookChange('notes', event.target.value)} /></label>
        </div>
      </fieldset>

      <fieldset className="research-form-group">
        <legend>Hard Gate 与评分输入</legend>
        <p>只填写已经验证的值。关键字段缺失时，任务会暂停并生成待补数据。</p>
        <div className="form-grid grid grid-2">
          <label className="field"><span>IP 风险</span><select className="input" value={form.workflowInput.ipRisk} onChange={(event) => onInputChange('ipRisk', event.target.value)}><option value="">尚未验证</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="critical">严重</option></select></label>
          <label className="field"><span>需要认证</span><select className="input" value={form.workflowInput.certificationRequired} onChange={(event) => onInputChange('certificationRequired', event.target.value)}><option value="">尚未验证</option><option value="false">否</option><option value="true">是</option></select></label>
          {form.workflowInput.certificationRequired === 'true' ? <label className="field"><span>认证能力可用</span><select className="input" value={form.workflowInput.certificationAvailable} onChange={(event) => onInputChange('certificationAvailable', event.target.value)}><option value="">尚未验证</option><option value="false">否</option><option value="true">是</option></select></label> : null}
          <label className="field"><span>供应链已验证</span><select className="input" value={form.workflowInput.supplyChainValidation} onChange={(event) => onInputChange('supplyChainValidation', event.target.value)}><option value="">尚未验证</option><option value="false">否</option><option value="true">是</option></select></label>
          {workflowNumbers.map(([key, label, unit]) => <label className="field" key={key}><span>{label}（{unit}）</span><input className="input" type="number" step="any" min={key === 'growth30d' || key === 'estimatedContributionProfitRate' ? undefined : 0} max={key === 'supplyChainFitScore' || key === 'riskControlScore' || key === 'top10SalesShare' ? 100 : undefined} value={form.workflowInput[key]} onChange={(event) => onInputChange(key, event.target.value)} /></label>)}
          <div className="dimension-fields field-span-2"><span>实际产品尺寸（cm）</span><div><input className="input" type="number" step="0.1" min="0" value={form.workflowInput.length} onChange={(event) => onInputChange('length', event.target.value)} aria-label="产品长度" placeholder="长" /><span>×</span><input className="input" type="number" step="0.1" min="0" value={form.workflowInput.width} onChange={(event) => onInputChange('width', event.target.value)} aria-label="产品宽度" placeholder="宽" /><span>×</span><input className="input" type="number" step="0.1" min="0" value={form.workflowInput.height} onChange={(event) => onInputChange('height', event.target.value)} aria-label="产品高度" placeholder="高" /></div></div>
          <label className="field field-span-2"><span>评论样本</span><textarea className="input" value={form.workflowInput.reviewSamples} onChange={(event) => onInputChange('reviewSamples', event.target.value)} placeholder={'每行：ProductId | ReviewText\n或粘贴 JSON 数组'} /><small>来源将记录为 Operator pasted review；Rating/Date 未提供时保持为空。大量样本可在设置页用评论 CSV/XLSX 导入。</small></label>
        </div>
      </fieldset>
    </div>
  );
}

function jobMutationMessage(job: ResearchJobSummary, action: 'run' | 'retry'): string {
  if (job.status === 'failed') return `任务${action === 'run' ? '运行' : '重试'}失败：${job.error || '请查看失败步骤'}`;
  if (job.status === 'needs_data') return '工作流已暂停，需先补齐缺失数据。';
  if (job.status === 'waiting_approval') return '工作流已到达人工审批门。';
  if (isResearchJobActive(job.status)) return action === 'run' ? '研究任务已开始执行。' : '研究任务已重新开始执行。';
  return `任务状态已更新为“${researchJobStatusLabels[job.status]}”。`;
}

function MissingValueControl({ item, value, disabled, onChange }: { item: MissingDataItem; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const kind = missingValueKind(item.fieldName);
  if (kind === 'boolean') {
    return <select className="input" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>;
  }
  if (kind === 'risk') {
    return <select className="input" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}><option value="">请选择</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="critical">严重</option></select>;
  }
  const placeholder = item.fieldName === 'dimensions' || item.fieldName === 'max_dimension'
    ? '{"length":40,"width":20,"height":10,"unit":"cm"}'
    : item.fieldName === 'price_range'
      ? '{"min":20,"max":40,"currency":"USD"}'
      : item.fieldName === 'reviews'
        ? '[{"text":"..."}]'
        : kind === 'list'
          ? '使用逗号分隔多个值'
          : undefined;
  return <input className="input" type={kind === 'number' ? 'number' : 'text'} step={kind === 'number' ? 'any' : undefined} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} placeholder={placeholder} />;
}

function JobList({
  jobs,
  selectedId,
}: {
  jobs: ResearchJobSummary[];
  selectedId: string;
}) {
  if (!jobs.length) {
    return <div className="research-job-list-empty"><Search size={20} aria-hidden="true" /><span>没有符合筛选条件的研究任务</span></div>;
  }

  return (
    <div className="research-job-list">
      {jobs.map((job) => (
        <Link className={job.id === selectedId ? 'research-job-row is-active' : 'research-job-row'} to={`/research-jobs/${encodeURIComponent(job.id)}`} key={job.id}>
          <div className="research-job-row__top">
            <Badge tone={researchJobStatusTone(job.status)}>{researchJobStatusLabels[job.status]}</Badge>
            {job.isDemo ? <Badge tone="demo">DEMO</Badge> : null}
            <time>{formatDateTime(job.updatedAt)}</time>
          </div>
          <strong>{job.name}</strong>
          <span>{researchJobTypeLabels[job.type]} · Amazon {job.marketplace}</span>
          <div className="research-job-row__footer">
            <small>{job.entityId || '未关联业务实体'}</small>
            {job.missingDataCount > 0 ? <em><DatabaseZap size={12} aria-hidden="true" />{job.missingDataCount} 项待补</em> : null}
            <ChevronRight size={16} aria-hidden="true" />
          </div>
        </Link>
      ))}
    </div>
  );
}

function RuleExecutionSection({ job }: { job: ResearchJobDetail }) {
  const execution = job.latestRuleExecution;
  if (!execution) {
    return (
      <section className="research-detail-section">
        <div className="section-heading"><div><span className="eyebrow">RULE ENGINE</span><h2>规则执行</h2></div></div>
        <div className="workflow-empty"><Gauge size={22} aria-hidden="true" /><div><strong>尚无规则执行记录</strong><span>Hard Gate 与评分只会在校验完成后显示。</span></div></div>
      </section>
    );
  }

  const outputEntries = Object.entries(execution.output);
  return (
    <section className="research-detail-section">
      <div className="section-heading">
        <div><span className="eyebrow">RULE ENGINE</span><h2>规则执行</h2><p>{execution.ruleProfileId} · v{execution.ruleVersion}</p></div>
        <div className="rule-result-summary">
          <Badge tone={execution.hardGateStatus === 'pass' ? 'positive' : execution.hardGateStatus === 'reject' ? 'critical' : 'warning'}>{hardGateLabels[execution.hardGateStatus]}</Badge>
          <span>规则得分 <strong>{execution.score === null ? '—' : `${formatDecimal(execution.score)} / 100`}</strong></span>
        </div>
      </div>
      {outputEntries.length ? (
        <dl className="rule-output-grid">
          {outputEntries.map(([key, value]) => <div key={key}><dt>{titleCaseKey(key)}</dt><dd>{stringifyValue(value)}</dd></div>)}
        </dl>
      ) : <p className="muted research-section-note">本次执行未记录额外规则输出。</p>}
      <footer className="research-section-footer">执行于 {formatDateTime(execution.createdAt)} · Hard Gate 不可被总分抵消</footer>
    </section>
  );
}

function ReviewGapSection({ job, evidence }: { job: ResearchJobDetail; evidence: WorkflowEvidence[] }) {
  if (job.type !== 'adjacent_product' && job.type !== 'new_opportunity') return null;
  const evidenceIds = new Set(evidence.map((item) => item.id));
  return (
    <section className="research-detail-section">
      <div className="section-heading">
        <div><span className="eyebrow">REVIEW GAP</span><h2>评论缺口</h2><p>频率与受影响商品数来自评论 Evidence；供应链与成本为空表示证据不足，不代表否或 0。</p></div>
        <Badge tone={job.reviewInsights.length ? 'info' : 'neutral'}>{job.reviewInsights.length} 个问题</Badge>
      </div>
      {job.reviewInsights.length ? (
        <div className="review-gap-list">
          {job.reviewInsights.map((item) => (
            <article className="review-gap-row" key={item.id}>
              <div className="review-gap-row__issue"><strong>{reviewIssueLabels[item.issue] ?? item.issue}</strong><code>{item.issue}</code><small>{item.isCrossMarketIssue ? '已证明跨市场问题' : '当前样本未证明跨市场'}</small></div>
              <dl>
                <div><dt>频率</dt><dd>{formatDecimal(item.frequency * 100)}%</dd></div>
                <div><dt>受影响商品</dt><dd>{item.competitorsAffected}</dd></div>
                <div><dt>供应链可解决</dt><dd>{item.supplyChainSolvable === null ? '未知（缺供应商证据）' : item.supplyChainSolvable ? '是' : '否'}</dd></div>
                <div><dt>成本影响</dt><dd>{item.costImpact ?? '未知（缺成本证据）'}</dd></div>
              </dl>
              <div className="review-gap-row__status">
                <Badge tone={item.opportunityLevel === 'high' ? 'positive' : item.opportunityLevel === 'insufficient_evidence' ? 'warning' : item.opportunityLevel === 'medium' ? 'info' : 'neutral'}>{reviewOpportunityLabels[item.opportunityLevel]}</Badge>
                {item.evidenceIds.length ? <div className="evidence-links">证据：{item.evidenceIds.map((id) => evidenceIds.has(id) ? <a href={`#evidence-${id}`} key={id}>{id}</a> : <code key={id}>{id}</code>)}</div> : <small>没有关联证据</small>}
              </div>
            </article>
          ))}
        </div>
      ) : <div className="workflow-empty"><FileSearch size={22} aria-hidden="true" /><div><strong>尚无评论缺口结果</strong><span>未提供可追溯评论时，系统不会生成产品机会结论。</span></div></div>}
    </section>
  );
}

function ReverseReviewSection({ job, evidence }: { job: ResearchJobDetail; evidence: WorkflowEvidence[] }) {
  const review = job.reverseReview;
  if (!review) {
    return (
      <section className="research-detail-section">
        <div className="section-heading"><div><span className="eyebrow">REVERSE REVIEW</span><h2>反向审查</h2></div></div>
        <div className="workflow-empty"><ShieldAlert size={22} aria-hidden="true" /><div><strong>尚未进入反向审查</strong><span>产品型任务在给出开发建议前必须先记录失败模式与未知项。</span></div></div>
      </section>
    );
  }

  const evidenceIds = new Set(evidence.map((item) => item.id));
  return (
    <section className="research-detail-section">
      <div className="section-heading">
        <div><span className="eyebrow">REVERSE REVIEW</span><h2>反向审查</h2><p>{review.recommendation || '未记录反向建议'}</p></div>
        <Badge tone={review.verdict === 'proceed' ? 'positive' : review.verdict === 'reject' ? 'critical' : 'warning'}>{reverseVerdictLabels[review.verdict]}</Badge>
      </div>
      {review.topFailureModes.length ? (
        <div className="failure-mode-list">
          {review.topFailureModes.map((item, index) => (
            <article className={item.resolved ? 'failure-mode is-resolved' : 'failure-mode'} key={`${item.risk}-${index}`}>
              <span className={`risk-severity risk-severity--${item.severity}`}>{item.severity}</span>
              <div><strong>{item.risk}</strong><p>{item.requiredAction || '未记录所需动作'}</p>
                {item.evidenceIds.length ? <div className="evidence-links">证据：{item.evidenceIds.map((id) => evidenceIds.has(id) ? <a href={`#evidence-${id}`} key={id}>{id}</a> : <code key={id}>{id}</code>)}</div> : <small>没有关联证据</small>}
              </div>
              <Badge tone={item.resolved ? 'positive' : 'warning'}>{item.resolved ? '已排除' : '未排除'}</Badge>
            </article>
          ))}
        </div>
      ) : <p className="muted research-section-note">本次反向审查未记录失败模式。</p>}
      {review.unknowns.length ? <div className="reverse-unknowns"><strong>仍未知</strong><ul>{review.unknowns.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></div> : null}
      <footer className="research-section-footer">审查记录于 {formatDateTime(review.createdAt)}</footer>
    </section>
  );
}

interface MissingDataSectionProps {
  job: ResearchJobDetail;
  items: MissingDataItem[];
  loading: boolean;
  error: Error | null;
  canEdit: boolean;
  busy: boolean;
  onRetry: (resolvedData: Record<string, unknown>, resolvedBy: string) => Promise<void>;
}

function MissingDataSection({ job, items, loading, error, canEdit, busy, onRetry }: MissingDataSectionProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [resolvedBy, setResolvedBy] = useState('Admin');
  const [formError, setFormError] = useState<string | null>(null);
  const openItems = items.filter((item) => item.status === 'open');
  const hasFilledValue = openItems.some((item) => Boolean(values[item.id]?.trim()));

  useEffect(() => {
    setValues({});
    setFormError(null);
  }, [job.id]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const filledItems = openItems.filter((item) => Boolean(values[item.id]?.trim()));
    if (!filledItems.length || !resolvedBy.trim()) {
      setFormError('请至少补录一项数据，并填写验证人。');
      return;
    }
    try {
      const resolvedData = Object.fromEntries(filledItems.map((item) => [item.fieldName, parseMissingFieldValue(item.fieldName, values[item.id].trim())]));
      setFormError(null);
      await onRetry(resolvedData, resolvedBy.trim());
    } catch (parseError) {
      setFormError(parseError instanceof Error ? parseError.message : '补录值格式无效');
    }
  };

  return (
    <section className="research-detail-section" id="missing-data">
      <div className="section-heading">
        <div><span className="eyebrow">MISSING DATA QUEUE</span><h2>缺失数据</h2><p>缺失值保持为空，不会自动补成 0。</p></div>
        <Badge tone={openItems.length ? 'warning' : 'neutral'}>{openItems.length} 项开放</Badge>
      </div>
      {error ? <div className="alert alert-error" role="alert">缺失数据读取失败：{error.message}</div> : null}
      {loading && !items.length ? <div className="inline-loading"><LoaderCircle className="spin" size={17} aria-hidden="true" />读取缺失数据…</div> : null}
      {!loading && !items.length ? <div className="workflow-empty"><CheckCircle2 size={22} aria-hidden="true" /><div><strong>当前没有缺失数据记录</strong><span>这只表示队列为空，不代表尚未执行的校验已经通过。</span></div></div> : null}
      {items.length ? (
        <form onSubmit={(event) => void submit(event)}>
          <div className="missing-data-list">
            {items.map((item) => (
              <div className={`missing-data-row missing-data-row--${item.status}`} key={item.id}>
                <div className="missing-data-row__main">
                  <div><strong>{missingFieldLabel(item.fieldName, item.label)}</strong><code>{item.fieldName}</code></div>
                  <p>{item.missingReason}</p>
                  <div className="badge-row">
                    <Badge tone={item.requiredForDecision ? 'critical' : 'neutral'}>{item.requiredForDecision ? '阻断决策' : '非阻断'}</Badge>
                    {item.manualValidationRequired ? <Badge tone="warning">需人工验证</Badge> : null}
                    <Badge tone={item.status === 'open' ? 'warning' : item.status === 'resolved' ? 'positive' : 'neutral'}>{item.status === 'open' ? '待补录' : item.status === 'resolved' ? '已解决' : '已豁免'}</Badge>
                  </div>
                </div>
                {item.status === 'open' && canRetryResearchJob(job.status) ? (
                  <label className="field missing-data-row__input"><span>补录值</span><MissingValueControl item={item} value={values[item.id] ?? ''} onChange={(value) => setValues((current) => ({ ...current, [item.id]: value }))} disabled={!canEdit || busy} /></label>
                ) : item.resolvedValue !== undefined ? <div className="missing-data-row__resolved"><span>已记录</span><strong>{stringifyValue(item.resolvedValue)}</strong><small>{item.resolvedBy || '未记录验证人'} · {formatDateTime(item.resolvedAt)}</small></div> : null}
              </div>
            ))}
          </div>
          {openItems.length && canRetryResearchJob(job.status) ? (
            <div className="missing-data-submit">
              <label className="field"><span>验证人</span><input className="input" value={resolvedBy} onChange={(event) => setResolvedBy(event.target.value)} disabled={!canEdit || busy} /></label>
              <div><span>仅已填写字段会提交；工作流将再次校验所有必填项。</span><button className="button button--primary" type="submit" disabled={!canEdit || busy || !resolvedBy.trim() || !hasFilledValue}>{busy ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}{busy ? '正在重试' : '补充并重试'}</button></div>
            </div>
          ) : null}
          {formError ? <p className="form-error" role="alert">{formError}</p> : null}
        </form>
      ) : null}
    </section>
  );
}

function CreateResearchJobModal({
  open,
  busy,
  error,
  marketplace,
  currency,
  rules,
  rulesError,
  entityOptions,
  onClose,
  onCreate,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  marketplace: string;
  currency: string;
  rules: RuleProfile[];
  rulesError: Error | null;
  entityOptions: ResearchEntityOptions;
  onClose: () => void;
  onCreate: (form: CreateJobForm) => Promise<void>;
}) {
  const [form, setForm] = useState<CreateJobForm>(createFormInitial);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  busyRef.current = busy;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    setForm(createFormInitial);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector));
      if (!focusable.length) return;
      const first = event.shiftKey && document.activeElement === focusable[0];
      const movingPastEnd = !event.shiftKey && document.activeElement === focusable[focusable.length - 1];
      if (first || movingPastEnd) {
        event.preventDefault();
        (movingPastEnd ? focusable[0] : focusable[focusable.length - 1]).focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;
  const compatibleRules = rules.filter((rule) => rule.active && rule.jobTypes.includes(form.type));
  const isProductWorkflow = form.type === 'adjacent_product' || form.type === 'new_opportunity';
  const availableEntities = entityOptions[form.type];
  const requiresEntity = form.type !== 'new_opportunity';

  const updateTaskBook = (key: keyof CreateJobForm['taskBook'], value: string) => {
    setForm((current) => ({
      ...current,
      taskBook: { ...current.taskBook, [key]: value } as CreateJobForm['taskBook'],
    }));
  };

  const updateWorkflowInput = (key: keyof CreateJobForm['workflowInput'], value: string) => {
    setForm((current) => ({
      ...current,
      workflowInput: { ...current.workflowInput, [key]: value } as CreateJobForm['workflowInput'],
    }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onCreate(form);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section ref={dialogRef} className="modal modal-wide research-create-modal" role="dialog" aria-modal="true" aria-labelledby="create-research-heading">
        <div className="modal-header"><div><span className="eyebrow">NEW RESEARCH JOB</span><h2 id="create-research-heading">创建研究任务</h2></div><button ref={closeButtonRef} className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label="关闭"><X size={18} aria-hidden="true" /></button></div>
        <form onSubmit={(event) => void submit(event)}>
          <div className="form-grid grid grid-2">
            <label className="field field-span-2"><span>任务名称</span><input className="input" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
            <label className="field"><span>研究类型</span><select className="input" value={form.type} onChange={(event) => { const type = event.target.value as ResearchJobType; setForm({ ...form, type, entityType: entityTypeForJob(type), entityId: '', ruleProfileId: '' }); }}>{jobTypes.map((type) => <option value={type} key={type}>{researchJobTypeLabels[type]}</option>)}</select></label>
            <label className="field"><span>Marketplace</span><input className="input" value={`Amazon ${marketplace}`} disabled /></label>
            <label className="field"><span>关联实体类型</span>{form.type === 'new_opportunity' ? <select className="input" value={form.entityType} onChange={(event) => setForm({ ...form, entityType: event.target.value, entityId: '' })}><option value="">不关联现有实体</option><option value="opportunity">已有机会</option></select> : <input className="input" value={form.entityType} disabled />}</label>
            <label className="field"><span>当前站点关联对象</span><select className="input" value={form.entityId} required={requiresEntity} disabled={!form.entityType || !availableEntities.length} onChange={(event) => setForm({ ...form, entityId: event.target.value })}><option value="">{availableEntities.length ? '请选择' : '当前站点暂无可关联对象'}</option>{availableEntities.map((entity) => <option value={entity.id} key={entity.id}>{entity.label}</option>)}</select><small>{requiresEntity && !availableEntities.length ? '请先在对应业务页创建当前站点对象。' : '仅列出当前 Marketplace 的实体。'}</small></label>
            <label className="field"><span>规则版本</span><select className="input" value={form.ruleProfileId} onChange={(event) => setForm({ ...form, ruleProfileId: event.target.value })}><option value="">使用该类型的默认规则</option>{compatibleRules.map((rule) => <option value={rule.id} key={rule.id}>{rule.name} · v{rule.version}</option>)}</select><small>{rulesError ? '规则列表暂不可用，将由后端选择默认规则。' : compatibleRules.length ? `${compatibleRules.length} 个启用版本可选` : '没有可选启用版本，将由后端校验。'}</small></label>
            <label className="field"><span>创建人</span><input className="input" required value={form.createdBy} onChange={(event) => setForm({ ...form, createdBy: event.target.value })} /></label>
            <label className="field field-span-2"><span>研究目标</span><textarea className="input" required value={form.objective} onChange={(event) => setForm({ ...form, objective: event.target.value })} /></label>
            <label className="field field-span-2"><span>研究关键词</span><input className="input" value={form.keywords} onChange={(event) => setForm({ ...form, keywords: event.target.value })} placeholder="使用逗号分隔" /><small>这里只记录研究输入；缺少的业务数据会进入 Missing Data Queue。</small></label>
            {isProductWorkflow ? <ProductResearchInputs form={form} currency={currency} onTaskBookChange={updateTaskBook} onInputChange={updateWorkflowInput} /> : null}
          </div>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="modal-actions"><button className="button button--secondary" type="button" disabled={busy} onClick={onClose}>取消</button><button className="button button--primary" type="submit" disabled={busy || !form.name.trim() || !form.objective.trim() || (requiresEntity && !form.entityId)}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}{busy ? '正在创建' : '创建草稿'}</button></div>
        </form>
      </section>
    </div>
  );
}

export default function ResearchJobsPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const { settings, loading: settingsLoading, refreshKey, refreshAll, reloadSettings } = useApp();
  const previousMarketplace = useRef(settings.marketplace);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>('all');
  const [typeFilter, setTypeFilter] = useState<JobTypeFilter>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [mutation, setMutation] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const marketplace = encodeURIComponent(settings.marketplace);
  const listQuery = useApi<ResearchJobSummary[]>(`/api/research-jobs?marketplace=${marketplace}`, refreshKey);
  const rulesQuery = useApi<RuleProfile[]>('/api/rules/profiles', refreshKey);
  const marketsQuery = useApi<MarketNode[]>(`/api/markets?marketplace=${marketplace}`, refreshKey);
  const productsQuery = useApi<OwnedProductSummary[]>(`/api/owned-products?marketplace=${marketplace}`, refreshKey);
  const developmentQuery = useApi<DevelopmentProject[]>(`/api/development-projects?marketplace=${marketplace}`, refreshKey);
  const opportunitiesQuery = useApi<Opportunity[]>(`/api/opportunities?marketplace=${marketplace}`, refreshKey);
  const siteJobs = useMemo(() => (listQuery.data ?? []).filter((job) => job.marketplace === settings.marketplace), [listQuery.data, settings.marketplace]);
  const selectedId = jobId || '';
  const detailQuery = useApi<ResearchJobDetail>(selectedId ? `/api/research-jobs/${encodeURIComponent(selectedId)}?marketplace=${marketplace}` : null, refreshKey);
  const stepsQuery = useApi<ResearchJobDetail['steps']>(selectedId ? `/api/research-jobs/${encodeURIComponent(selectedId)}/steps?marketplace=${marketplace}` : null, refreshKey);
  const evidenceQuery = useApi<WorkflowEvidence[]>(selectedId ? `/api/research-jobs/${encodeURIComponent(selectedId)}/evidence?marketplace=${marketplace}` : null, refreshKey);
  const missingQuery = useApi<MissingDataItem[]>(selectedId ? `/api/research-jobs/${encodeURIComponent(selectedId)}/missing-data?marketplace=${marketplace}` : null, refreshKey);
  const reloadJobs = listQuery.reload;
  const reloadDetail = detailQuery.reload;
  const reloadSteps = stepsQuery.reload;
  const reloadEvidence = evidenceQuery.reload;
  const reloadMissing = missingQuery.reload;
  const canEdit = settings.role === 'admin';
  const entityOptions = useMemo<ResearchEntityOptions>(() => ({
    existing_market: (marketsQuery.data ?? []).filter((item) => item.marketplace === settings.marketplace).map((item) => ({ id: item.id, label: `${item.name} · ${item.id}` })),
    owned_product: (productsQuery.data ?? []).filter((item) => item.marketplace === settings.marketplace).map((item) => ({ id: item.id, label: `${item.internalName || item.title} · ${item.asin}` })),
    adjacent_product: (developmentQuery.data ?? []).filter((item) => item.marketplace === settings.marketplace).map((item) => ({ id: item.id, label: `${item.name} · ${item.productType}` })),
    new_opportunity: (opportunitiesQuery.data ?? []).filter((item) => item.marketplace === settings.marketplace).map((item) => ({ id: item.id, label: `${item.name} · ${item.id}` })),
  }), [developmentQuery.data, marketsQuery.data, opportunitiesQuery.data, productsQuery.data, settings.marketplace]);

  const filteredJobs = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return siteJobs.filter((job) => {
      const matchesQuery = !normalized || [job.name, job.id, job.entityId, researchJobTypeLabels[job.type]].join(' ').toLocaleLowerCase().includes(normalized);
      return matchesQuery && (statusFilter === 'all' || job.status === statusFilter) && (typeFilter === 'all' || job.type === typeFilter);
    });
  }, [query, siteJobs, statusFilter, typeFilter]);

  useEffect(() => {
    if (listQuery.loading || !jobId || siteJobs.some((job) => job.id === jobId)) return;
    navigate('/research-jobs', { replace: true });
  }, [jobId, listQuery.loading, navigate, siteJobs]);

  useEffect(() => {
    if (previousMarketplace.current === settings.marketplace) return;
    previousMarketplace.current = settings.marketplace;
    setQuery('');
    setStatusFilter('all');
    setTypeFilter('all');
    setMutationError(null);
    setNotice(null);
    navigate('/research-jobs', { replace: true });
  }, [navigate, settings.marketplace]);

  const hasActiveJobs = siteJobs.some((job) => isResearchJobActive(job.status));
  useEffect(() => {
    if (!hasActiveJobs) return undefined;
    const timer = window.setInterval(() => {
      reloadJobs();
      if (selectedId) {
        reloadDetail();
        reloadSteps();
        reloadEvidence();
        reloadMissing();
      }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [hasActiveJobs, reloadDetail, reloadEvidence, reloadJobs, reloadMissing, reloadSteps, selectedId]);

  const reloadSelected = () => {
    reloadJobs();
    reloadDetail();
    reloadSteps();
    reloadEvidence();
    reloadMissing();
  };

  const runJob = async (retry = false, resolvedData?: Record<string, unknown>, resolvedBy?: string) => {
    if (!selectedId) return;
    setMutation(retry ? 'retry' : 'run');
    setMutationError(null);
    setNotice(null);
    try {
      const result = retry
        ? await api.post<ResearchJobDetail>(`/api/research-jobs/${encodeURIComponent(selectedId)}/retry`, { resolvedData, resolvedBy })
        : await api.post<ResearchJobDetail>(`/api/research-jobs/${encodeURIComponent(selectedId)}/run`, {});
      if (result.status === 'failed') setMutationError(jobMutationMessage(result, retry ? 'retry' : 'run'));
      else setNotice(jobMutationMessage(result, retry ? 'retry' : 'run'));
      reloadSelected();
      refreshAll();
      await reloadSettings();
    } catch (requestError) {
      setMutationError(requestError instanceof Error ? requestError.message : '研究任务操作失败');
    } finally {
      setMutation(null);
    }
  };

  const createJob = async (form: CreateJobForm) => {
    setMutation('create');
    setMutationError(null);
    try {
      const created = await api.post<ResearchJobSummary>('/api/research-jobs', {
        name: form.name.trim(),
        type: form.type,
        marketplace: settings.marketplace,
        entityType: form.entityType || undefined,
        entityId: form.entityId.trim() || undefined,
        ruleProfileId: form.ruleProfileId || undefined,
        createdBy: form.createdBy.trim(),
        input: buildWorkflowInput(form),
        taskBook: buildTaskBook(form, settings.marketplace, settings.currency),
      });
      setShowCreate(false);
      setNotice('研究任务草稿已创建，运行前不会产生业务决策。');
      navigate(`/research-jobs/${encodeURIComponent(created.id)}`);
      refreshAll();
      await reloadSettings();
      reloadJobs();
    } catch (requestError) {
      setMutationError(requestError instanceof Error ? requestError.message : '研究任务创建失败');
    } finally {
      setMutation(null);
    }
  };

  const decide = async (decision: ResearchApprovalDecision, reason: string, decidedBy: string) => {
    if (!selectedId) return;
    setMutation('decision');
    setMutationError(null);
    setNotice(null);
    try {
      const endpoint = decision === 'rejected' ? 'reject' : 'approve';
      const body = decision === 'rejected' ? { reason, decidedBy } : { decision, reason, decidedBy };
      const updated = await api.post<ResearchJobDetail>(`/api/research-jobs/${encodeURIComponent(selectedId)}/${endpoint}`, body);
      setNotice(`人工决定已记录：${researchJobStatusLabels[updated.status]}。`);
      reloadSelected();
      refreshAll();
    } catch (requestError) {
      setMutationError(requestError instanceof Error ? requestError.message : '人工决定记录失败');
    } finally {
      setMutation(null);
    }
  };

  if (settingsLoading || (listQuery.loading && !listQuery.data)) return <PageLoading label="正在读取研究任务" />;
  if (listQuery.error && !listQuery.data) return <ErrorState error={listQuery.error} onRetry={listQuery.reload} lastSuccessfulSync={settings.lastSuccessfulSync} />;

  const detail = detailQuery.data?.marketplace === settings.marketplace ? detailQuery.data : null;
  const steps = stepsQuery.data ?? detail?.steps ?? [];
  const allEvidence = evidenceQuery.data ?? [];
  const evidence = detail ? selectCurrentVersionEvidence(detail, allEvidence) : [];
  const currentInsightEvidence = detail ? selectCurrentInsightEvidence(detail, allEvidence) : [];
  const historicalEvidenceCount = allEvidence.length - evidence.length;
  const missingData = missingQuery.data ?? [];
  const completedSteps = steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length;
  const progress = steps.length ? Math.round((completedSteps / steps.length) * 100) : 0;
  const counts = {
    active: siteJobs.filter((job) => isResearchJobActive(job.status)).length,
    needsData: siteJobs.filter((job) => job.status === 'needs_data').length,
    approval: siteJobs.filter((job) => job.status === 'waiting_approval').length,
    closed: siteJobs.filter((job) => ['approved', 'watch', 'rejected', 'monitoring'].includes(job.status)).length,
  };

  return (
    <main className="page research-jobs-page">
      <header className="page-header">
        <div><span className="eyebrow">WORKFLOW CONTROL</span><h1>研究任务</h1><p>查看从采集、标准化、规则判断到证据、反向审查和人工审批的完整过程。</p></div>
        <div className="header-actions"><button className="button button--secondary" type="button" onClick={reloadSelected} disabled={listQuery.refreshing}><RefreshCw className={listQuery.refreshing ? 'spin' : ''} size={16} aria-hidden="true" />刷新状态</button><button className="button button--primary" type="button" onClick={() => { setMutationError(null); setShowCreate(true); }} disabled={!canEdit}><Plus size={16} aria-hidden="true" />创建任务</button></div>
      </header>

      {!canEdit ? <div className="alert alert-info">当前为 Viewer 预览，可查看工作流、证据与审批记录，但不能创建、运行或审批。</div> : null}
      {mutationError ? <div className="alert alert-error" role="alert"><AlertTriangle size={16} aria-hidden="true" />{mutationError}<button type="button" onClick={() => setMutationError(null)}>关闭</button></div> : null}
      {notice ? <div className="alert alert-success" role="status"><CheckCircle2 size={16} aria-hidden="true" />{notice}</div> : null}

      <section className="research-job-summary" aria-label="当前站点研究任务概况">
        <div><span>当前站点</span><strong>Amazon {settings.marketplace}</strong><small>{siteJobs.length} 个任务</small></div>
        <div><span>执行中</span><strong>{counts.active}</strong><small>{counts.active ? '每 4 秒更新' : '当前无运行任务'}</small></div>
        <div><span>待补数据</span><strong>{counts.needsData}</strong><small>缺失值不会补 0</small></div>
        <div><span>待审批</span><strong>{counts.approval}</strong><small>必须由人工决定</small></div>
        <div><span>已形成决定</span><strong>{counts.closed}</strong><small>保留版本与理由</small></div>
      </section>

      {!siteJobs.length ? (
        <EmptyState title="当前站点还没有研究任务" description="创建一个任务草稿，再由工作流编排器执行采集、规则、AI 解释与审批步骤。" action={<button className="button button--primary" type="button" disabled={!canEdit} onClick={() => setShowCreate(true)}><Plus size={16} aria-hidden="true" />创建第一个任务</button>} />
      ) : (
        <div className={jobId ? 'research-job-layout has-selection' : 'research-job-layout'}>
          <aside className="research-job-master" aria-label="研究任务列表">
            <div className="research-job-master__toolbar">
              <label className="search-field"><Search size={15} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务或实体" aria-label="搜索研究任务" /></label>
              <div className="research-job-master__filters">
                <label className="select-field"><Filter size={14} aria-hidden="true" /><select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as JobTypeFilter)} aria-label="按任务类型筛选"><option value="all">全部类型</option>{jobTypes.map((type) => <option key={type} value={type}>{researchJobTypeLabels[type]}</option>)}</select></label>
                <label className="select-field"><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as JobStatusFilter)} aria-label="按任务状态筛选"><option value="all">全部状态</option>{jobStatuses.map((status) => <option key={status} value={status}>{researchJobStatusLabels[status]}</option>)}</select></label>
              </div>
              <span>{filteredJobs.length} / {siteJobs.length} 个任务</span>
            </div>
            <JobList jobs={filteredJobs} selectedId={selectedId} />
          </aside>

          <div className="research-job-detail">
            {detailQuery.loading && !detail ? <PageLoading label="正在读取任务详情" /> : null}
            {detailQuery.error && !detail ? <ErrorState error={detailQuery.error} onRetry={detailQuery.reload} lastSuccessfulSync={settings.lastSuccessfulSync} /> : null}
            {!selectedId ? <EmptyState title="选择一个研究任务" description="从左侧列表打开任务，查看执行步骤、证据、缺失数据与审批材料。" /> : null}
            {detail ? (
              <>
                <section className="research-job-identity">
                  <Link className="research-mobile-back" to="/research-jobs"><ArrowLeft size={15} aria-hidden="true" />任务列表</Link>
                  <div className="research-job-identity__heading">
                    <div><div className="badge-row"><Badge tone={researchJobStatusTone(detail.status)}>{researchJobStatusLabels[detail.status]}</Badge><Badge>{researchJobTypeLabels[detail.type]}</Badge>{detail.isDemo ? <Badge tone="demo">DEMO 数据</Badge> : null}</div><h2>{detail.name}</h2><p>{detail.entityType ? `${detail.entityType} · ${detail.entityId || '未指定 ID'}` : '未关联业务实体'}</p></div>
                    <div className="header-actions">
                      {canRunResearchJob(detail.status) ? <button className="button button--primary" type="button" disabled={!canEdit || mutation !== null} onClick={() => void runJob(false)}>{mutation === 'run' ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}{mutation === 'run' ? '运行中' : '运行任务'}</button> : null}
                      {canRetryResearchJob(detail.status) && (detail.status === 'failed' || !missingData.some((item) => item.status === 'open')) ? <button className="button button--secondary" type="button" disabled={!canEdit || mutation !== null} onClick={() => void runJob(true, {}, 'Admin')}>{mutation === 'retry' ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}{mutation === 'retry' ? '重试中' : '重新运行'}</button> : null}
                      {detail.status === 'needs_data' && missingData.some((item) => item.status === 'open') ? <a className="button button--secondary" href="#missing-data"><DatabaseZap size={16} aria-hidden="true" />补充数据</a> : null}
                    </div>
                  </div>
                  {detail.error ? <div className="alert alert-error" role="alert">{detail.error}</div> : null}
                  <div className="research-progress">
                    <div><span>步骤进度</span><strong>{steps.length ? `${completedSteps} / ${steps.length}` : '尚未开始'}</strong></div>
                    <div className="progress-track" aria-label={`工作流完成 ${progress}%`}><i style={{ width: `${progress}%` }} /></div>
                    <span>{steps.length ? `${progress}%` : '草稿'}</span>
                  </div>
                  <dl className="research-job-meta">
                    <div><dt>规则版本</dt><dd>{detail.ruleProfileId} · v{detail.ruleProfileVersion}</dd></div>
                    <div><dt>数据版本</dt><dd>{detail.dataVersion || '尚未生成'}</dd></div>
                    <div><dt>Prompt 版本</dt><dd>{detail.promptVersion || '尚未生成'}</dd></div>
                    <div><dt>创建 / 更新</dt><dd>{formatDateTime(detail.createdAt)}<small>{formatDateTime(detail.updatedAt)}</small></dd></div>
                  </dl>
                  {(Object.keys(detail.input).length || Object.keys(detail.taskBook).length) ? <details className="research-input-trace"><summary>查看任务输入与任务册原始记录</summary>{Object.keys(detail.input).length ? <div><span>输入</span><pre>{JSON.stringify(detail.input, null, 2)}</pre></div> : null}{Object.keys(detail.taskBook).length ? <div><span>任务册</span><pre>{JSON.stringify(detail.taskBook, null, 2)}</pre></div> : null}</details> : null}
                </section>

                <TaskBookSummary job={detail} />

                <section className="research-detail-section">
                  <div className="section-heading"><div><span className="eyebrow">STEP TIMELINE</span><h2>执行时间线</h2><p>步骤状态由 orchestrator 写入，页面不能跳过或改写。</p></div>{stepsQuery.refreshing ? <LoaderCircle className="spin" size={17} aria-label="正在更新步骤" /> : null}</div>
                  {stepsQuery.error ? <div className="alert alert-error" role="alert">步骤读取失败：{stepsQuery.error.message}</div> : <ResearchWorkflowTimeline steps={steps} />}
                </section>

                <div className="research-two-column">
                  <MissingDataSection job={detail} items={missingData} loading={missingQuery.loading} error={missingQuery.error} canEdit={canEdit} busy={mutation === 'retry'} onRetry={(resolvedData, resolvedBy) => runJob(true, resolvedData, resolvedBy)} />
                  <RuleExecutionSection job={detail} />
                </div>

                <ReviewGapSection job={detail} evidence={evidence} />

                <section className="research-detail-section">
                  <div className="section-heading"><div><span className="eyebrow">AI EXPLANATION</span><h2>AI 解释</h2><p>AI 不重新计算指标，也不代替规则或审批。</p></div>{detail.latestInsight ? <Badge tone={currentInsightEvidence.length ? 'info' : 'warning'}>{detail.latestInsight.model}</Badge> : null}</div>
                  {detail.latestInsight ? <div className="workflow-insight"><Bot size={20} aria-hidden="true" /><div><strong>{detail.latestInsight.title}</strong><p>{detail.latestInsight.summary}</p><div className="workflow-insight__columns"><div><span>风险</span>{detail.latestInsight.risks.length ? <ul>{detail.latestInsight.risks.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul> : <small>未记录</small>}</div><div><span>建议动作</span>{detail.latestInsight.recommendedActions.length ? <ul>{detail.latestInsight.recommendedActions.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul> : <small>未记录</small>}</div></div></div></div> : <div className="workflow-empty"><Bot size={22} aria-hidden="true" /><div><strong>尚未生成 AI 解释</strong><span>必须先完成数据校验与确定性计算。</span></div></div>}
                </section>

                <section className="research-detail-section" id="workflow-evidence">
                  <div className="section-heading"><div><span className="eyebrow">EVIDENCE TRACE</span><h2>证据链</h2><p>仅显示当前数据版本；每条结论都可追溯到来源记录、采集时间与计算过程。{historicalEvidenceCount ? ` 已归档 ${historicalEvidenceCount} 条历史证据。` : ''}</p></div><Badge tone={evidence.length ? 'positive' : 'warning'}>{evidence.length} 条当前证据</Badge></div>
                  {evidenceQuery.error ? <div className="alert alert-error" role="alert">证据读取失败：{evidenceQuery.error.message}</div> : evidenceQuery.loading && !evidence.length ? <div className="inline-loading"><LoaderCircle className="spin" size={17} />读取证据记录…</div> : <WorkflowEvidenceList evidence={evidence} />}
                </section>

                <ReverseReviewSection job={detail} evidence={evidence} />
                <ResearchApprovalPanel job={detail} evidence={currentInsightEvidence} missingData={missingData} canEdit={canEdit} busy={mutation === 'decision'} onDecision={decide} />

                {canApproveResearchJob(detail.status) && !currentInsightEvidence.length ? <div className="alert alert-warning"><FileSearch size={16} aria-hidden="true" />当前 Insight 没有明确关联的证据。历史证据不会自动用于本轮审批，请先核对并考虑退回补数据或拒绝。</div> : null}
              </>
            ) : null}
          </div>
        </div>
      )}

      <CreateResearchJobModal open={showCreate} busy={mutation === 'create'} error={showCreate ? mutationError : null} marketplace={settings.marketplace} currency={settings.currency} rules={rulesQuery.data ?? []} rulesError={rulesQuery.error} entityOptions={entityOptions} onClose={() => { setShowCreate(false); setMutationError(null); }} onCreate={createJob} />
    </main>
  );
}
