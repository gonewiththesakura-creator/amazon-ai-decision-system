import type {
  ResearchJobDetail,
  ResearchJobSummary,
  ResearchJobStatus,
  ResearchJobType,
  ResearchStepStatus,
  ResearchStepType,
  WorkflowEvidence,
} from '../../shared/types';

export const researchJobTypeLabels: Record<ResearchJobType, string> = {
  existing_market: '现有市场诊断',
  owned_product: '自有产品诊断',
  adjacent_product: '相邻产品研究',
  new_opportunity: '新机会研究',
};

export const researchJobStatusLabels: Record<ResearchJobStatus, string> = {
  draft: '草稿',
  planned: '已规划',
  collecting: '采集中',
  normalizing: '标准化中',
  validating: '校验中',
  calculating: '计算中',
  analyzing: 'AI 解释中',
  reverse_review: '反向审查中',
  waiting_approval: '待人工审批',
  approved: '已批准',
  watch: '继续观察',
  rejected: '已拒绝',
  monitoring: '持续监控',
  failed: '失败',
  needs_data: '待补数据',
};

export const researchStepLabels: Record<ResearchStepType, string> = {
  plan: '研究规划',
  collect_market: '采集市场数据',
  collect_products: '采集产品数据',
  collect_keywords: '采集关键词数据',
  collect_reviews: '采集评论数据',
  normalize: '数据标准化',
  validate: '完整性校验',
  calculate: '确定性指标计算',
  hard_gate: 'Hard Gate',
  score: '规则评分',
  ai_analysis: 'AI 解释',
  review_gap: '评论缺口分析',
  reverse_review: '反向审查',
  approval: '人工审批',
  snapshot: '保存快照',
  report: '生成报告',
};

export const researchStepStatusLabels: Record<ResearchStepStatus, string> = {
  pending: '等待中',
  running: '运行中',
  completed: '已完成',
  skipped: '已跳过',
  failed: '失败',
  needs_data: '待补数据',
};

const activeStatuses = new Set<ResearchJobStatus>([
  'collecting',
  'normalizing',
  'validating',
  'calculating',
  'analyzing',
  'reverse_review',
]);

export function isResearchJobActive(status: ResearchJobStatus): boolean {
  return activeStatuses.has(status);
}

export function canRunResearchJob(status: ResearchJobStatus): boolean {
  return status === 'draft' || status === 'planned';
}

export function canRetryResearchJob(status: ResearchJobStatus): boolean {
  return status === 'failed' || status === 'needs_data';
}

export function canApproveResearchJob(status: ResearchJobStatus): boolean {
  return status === 'waiting_approval';
}

export function selectCurrentVersionEvidence(
  job: Pick<ResearchJobDetail, 'id' | 'dataVersion'>,
  evidence: WorkflowEvidence[],
): WorkflowEvidence[] {
  return evidence.filter((item) => (
    item.researchJobId === job.id && item.dataVersion === job.dataVersion
  ));
}

export function selectCurrentInsightEvidence(
  job: Pick<ResearchJobDetail, 'id' | 'dataVersion' | 'latestInsight'>,
  evidence: WorkflowEvidence[],
): WorkflowEvidence[] {
  if (!job.latestInsight) return [];
  const currentEvidence = selectCurrentVersionEvidence(job, evidence);
  const declaredEvidenceIds = job.latestInsight.evidenceIds ?? [];
  if (declaredEvidenceIds.length > 0) {
    const declaredIds = new Set(declaredEvidenceIds);
    return currentEvidence.filter((item) => declaredIds.has(item.id));
  }
  return currentEvidence.filter((item) => item.insightId === job.latestInsight?.id);
}

export function findLatestResearchJobForEntity(
  jobs: ResearchJobSummary[],
  entityType: string,
  entityId: string,
): ResearchJobSummary | undefined {
  return jobs
    .filter((job) => job.entityType === entityType && job.entityId === entityId)
    .reduce<ResearchJobSummary | undefined>((latest, job) => {
      if (!latest) return job;
      const latestKey = `${latest.updatedAt}|${latest.createdAt}|${latest.id}`;
      const jobKey = `${job.updatedAt}|${job.createdAt}|${job.id}`;
      return jobKey > latestKey ? job : latest;
    }, undefined);
}

export function researchJobStatusTone(status: ResearchJobStatus): 'neutral' | 'positive' | 'warning' | 'critical' | 'info' {
  if (status === 'approved' || status === 'monitoring') return 'positive';
  if (status === 'failed' || status === 'rejected') return 'critical';
  if (status === 'needs_data' || status === 'waiting_approval' || status === 'watch') return 'warning';
  if (status === 'draft') return 'neutral';
  return 'info';
}

export function researchStepStatusTone(status: ResearchStepStatus): 'neutral' | 'positive' | 'warning' | 'critical' | 'info' {
  if (status === 'completed') return 'positive';
  if (status === 'failed') return 'critical';
  if (status === 'needs_data' || status === 'skipped') return 'warning';
  if (status === 'running') return 'info';
  return 'neutral';
}
