import { describe, expect, it } from 'vitest';
import {
  canApproveResearchJob,
  canRetryResearchJob,
  canRunResearchJob,
  findLatestResearchJobForEntity,
  isResearchJobActive,
  researchJobStatusLabels,
  selectCurrentInsightEvidence,
  selectCurrentVersionEvidence,
} from './researchJobs';
import type { ResearchJobDetail, ResearchJobSummary, WorkflowEvidence } from '../../shared/types';

describe('research job action gates', () => {
  it('only starts jobs that have not entered execution', () => {
    expect(canRunResearchJob('draft')).toBe(true);
    expect(canRunResearchJob('planned')).toBe(true);
    expect(canRunResearchJob('needs_data')).toBe(false);
    expect(canRunResearchJob('waiting_approval')).toBe(false);
  });

  it('keeps retry and approval actions in their legal states', () => {
    expect(canRetryResearchJob('failed')).toBe(true);
    expect(canRetryResearchJob('needs_data')).toBe(true);
    expect(canRetryResearchJob('rejected')).toBe(false);
    expect(canApproveResearchJob('waiting_approval')).toBe(true);
    expect(canApproveResearchJob('approved')).toBe(false);
  });

  it('polls only transient orchestrator states', () => {
    expect(isResearchJobActive('collecting')).toBe(true);
    expect(isResearchJobActive('reverse_review')).toBe(true);
    expect(isResearchJobActive('monitoring')).toBe(false);
    expect(isResearchJobActive('needs_data')).toBe(false);
  });

  it('has a readable label for every workflow status', () => {
    expect(researchJobStatusLabels.waiting_approval).toBe('待人工审批');
    expect(researchJobStatusLabels.needs_data).toBe('待补数据');
  });

  it('keeps historical and cross-job evidence out of the current decision version', () => {
    const job = {
      id: 'job-1',
      dataVersion: 'data-v2',
      latestInsight: { id: 'insight-2', evidenceIds: ['evidence-current'] },
    } as Pick<ResearchJobDetail, 'id' | 'dataVersion' | 'latestInsight'>;
    const evidence = [
      { id: 'evidence-current', researchJobId: 'job-1', insightId: 'insight-2', dataVersion: 'data-v2' },
      { id: 'evidence-history', researchJobId: 'job-1', insightId: 'insight-1', dataVersion: 'data-v1' },
      { id: 'evidence-other-job', researchJobId: 'job-2', insightId: 'insight-2', dataVersion: 'data-v2' },
    ] as WorkflowEvidence[];

    expect(selectCurrentVersionEvidence(job, evidence).map((item) => item.id)).toEqual(['evidence-current']);
    expect(selectCurrentInsightEvidence(job, evidence).map((item) => item.id)).toEqual(['evidence-current']);
  });

  it('selects the latest workflow linked to a legacy entity', () => {
    const base = {
      name: '研究任务', type: 'new_opportunity', marketplace: 'US', status: 'draft',
      ruleProfileId: 'rule-1', ruleProfileVersion: 1, isDemo: false, createdBy: 'Admin',
      dataVersion: 'data-v1', promptVersion: 'prompt-v1', missingDataCount: 0,
      completedAt: null, error: null,
    } as const;
    const jobs = [
      { ...base, id: 'older', entityType: 'opportunity', entityId: 'opp-1', createdAt: '2026-09-01', updatedAt: '2026-09-01' },
      { ...base, id: 'newer', entityType: 'opportunity', entityId: 'opp-1', createdAt: '2026-09-02', updatedAt: '2026-09-03' },
      { ...base, id: 'other', entityType: 'opportunity', entityId: 'opp-2', createdAt: '2026-09-04', updatedAt: '2026-09-04' },
    ] as ResearchJobSummary[];

    expect(findLatestResearchJobForEntity(jobs, 'opportunity', 'opp-1')?.id).toBe('newer');
    expect(findLatestResearchJobForEntity(jobs, 'development_project', 'opp-1')).toBeUndefined();
  });
});
