// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MissingDataItem, ResearchJobDetail, WorkflowEvidence } from '../../shared/types';
import { ResearchApprovalPanel } from './ResearchApprovalPanel';

const now = '2026-09-10T08:00:00.000Z';

function makeJob(overrides: Partial<ResearchJobDetail> = {}): ResearchJobDetail {
  return {
    id: 'job-1',
    name: '相邻产品研究',
    type: 'adjacent_product',
    marketplace: 'US',
    status: 'waiting_approval',
    ruleProfileId: 'rule-1',
    ruleProfileVersion: 1,
    isDemo: false,
    createdBy: 'Admin',
    dataVersion: 'data-v2',
    promptVersion: 'prompt-v1',
    missingDataCount: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    error: null,
    input: {},
    taskBook: {},
    steps: [],
    reviewInsights: [],
    latestRuleExecution: {
      id: 'execution-1',
      researchJobId: 'job-1',
      ruleProfileId: 'rule-1',
      ruleVersion: 1,
      input: {},
      output: {},
      hardGateStatus: 'pass',
      score: 78,
      dataVersion: 'data-v2',
      createdAt: now,
    },
    latestInsight: {
      id: 'insight-1',
      entityType: 'research_job',
      entityId: 'job-1',
      insightType: 'research_decision',
      status: 'ready',
      title: '研究结论',
      summary: '当前证据支持进入人工审批。',
      facts: [],
      opportunities: [],
      risks: [],
      recommendedActions: ['人工复核后决定'],
      evidence: [],
      confidence: 0.8,
      model: 'rule-engine-v1',
      dataVersion: 'data-v2',
      generatedAt: now,
      researchJobId: 'job-1',
      evidenceIds: ['evidence-1'],
      promptVersion: 'prompt-v1',
    },
    reverseReview: {
      id: 'reverse-1',
      researchJobId: 'job-1',
      dataVersion: 'data-v2',
      ruleProfileId: 'rule-1',
      ruleProfileVersion: 1,
      promptVersion: 'prompt-v1',
      verdict: 'proceed_with_caution',
      topFailureModes: [],
      unknowns: [],
      recommendation: '谨慎推进',
      createdAt: now,
    },
    ...overrides,
  };
}

function makeEvidence(): WorkflowEvidence {
  return {
    id: 'evidence-1',
    researchJobId: 'job-1',
    insightId: 'insight-1',
    claim: '样本月销量达到研究阈值',
    metricName: 'monthly_sales',
    metricValue: 4200,
    source: 'Amazon 导入快照',
    sourceType: 'amazon',
    sourceRecordId: 'snapshot-1',
    collectedAt: now,
    period: '30D',
    isEstimated: false,
    calculation: 'SUM(estimated_sales)',
    confidence: 0.9,
    dataVersion: 'data-v2',
  };
}

function makeMissing(index: number): MissingDataItem {
  return {
    id: `missing-${index}`,
    researchJobId: 'job-1',
    fieldName: `required_field_${index}`,
    label: `阻断字段 ${index}`,
    missingReason: '规则计算需要该字段',
    requiredForDecision: true,
    manualValidationRequired: false,
    status: 'open',
    createdAt: now,
  };
}

afterEach(cleanup);

describe('ResearchApprovalPanel', () => {
  it('does not expose decision controls before the approval gate', () => {
    render(
      <ResearchApprovalPanel
        job={makeJob({ status: 'needs_data' })}
        evidence={[]}
        missingData={[makeMissing(1)]}
        canEdit
        busy={false}
        onDecision={vi.fn()}
      />,
    );

    expect(screen.getByText('尚未进入审批门')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('locks approval when hard gates or required data remain unresolved and lists every open item', () => {
    const missingData = Array.from({ length: 6 }, (_, index) => makeMissing(index + 1));
    const job = makeJob({
      missingDataCount: missingData.length,
      latestRuleExecution: {
        ...makeJob().latestRuleExecution!,
        hardGateStatus: 'needs_data',
        score: null,
      },
    });

    render(
      <ResearchApprovalPanel
        job={job}
        evidence={[makeEvidence()]}
        missingData={missingData}
        canEdit
        busy={false}
        onDecision={vi.fn()}
      />,
    );

    const approve = screen.getByRole('radio', { name: /批准下一阶段/ });
    const needsData = screen.getByRole('radio', { name: /退回补数据/ });
    expect(approve).toBeDisabled();
    expect(needsData).toBeChecked();
    expect(screen.getByText(/6 项阻断数据未解决/)).toBeInTheDocument();
    for (const item of missingData) {
      expect(screen.getByText(`${item.label}（阻断决策）`)).toBeInTheDocument();
    }
  });

  it('enables approval only when a current evidence fact exists and the hard gate passed', () => {
    render(
      <ResearchApprovalPanel
        job={makeJob()}
        evidence={[makeEvidence()]}
        missingData={[]}
        canEdit
        busy={false}
        onDecision={vi.fn()}
      />,
    );

    expect(screen.getByText('样本月销量达到研究阈值')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /批准下一阶段/ })).toBeEnabled();
    expect(screen.getByRole('radio', { name: /批准下一阶段/ })).toBeChecked();
    expect(screen.queryByText(/“批准下一阶段”已锁定/)).not.toBeInTheDocument();
  });

  it('keeps approval locked when no evidence is associated with the current insight', () => {
    render(
      <ResearchApprovalPanel
        job={makeJob()}
        evidence={[]}
        missingData={[]}
        canEdit
        busy={false}
        onDecision={vi.fn()}
      />,
    );

    expect(screen.getByRole('radio', { name: /批准下一阶段/ })).toBeDisabled();
    expect(screen.getByText(/当前 Insight 缺少明确关联证据/)).toBeInTheDocument();
  });

  it('keeps approval locked without an actionable Reverse Review', () => {
    render(
      <ResearchApprovalPanel
        job={makeJob({ reverseReview: undefined })}
        evidence={[makeEvidence()]}
        missingData={[]}
        canEdit
        busy={false}
        onDecision={vi.fn()}
      />,
    );

    expect(screen.getByRole('radio', { name: /批准下一阶段/ })).toBeDisabled();
    expect(screen.getByText(/Reverse Review 未完成或结论不允许推进/)).toBeInTheDocument();
  });

  it('does not accept evidence or Hard Gate output from an older data version', () => {
    const staleEvidence = { ...makeEvidence(), dataVersion: 'data-v1' };
    const job = makeJob({
      latestRuleExecution: { ...makeJob().latestRuleExecution!, dataVersion: 'data-v1' },
    });

    render(
      <ResearchApprovalPanel
        job={job}
        evidence={[staleEvidence]}
        missingData={[]}
        canEdit
        busy={false}
        onDecision={vi.fn()}
      />,
    );

    expect(screen.getByRole('radio', { name: /批准下一阶段/ })).toBeDisabled();
    expect(screen.getByText(/当前数据版本的 Hard Gate 尚未通过/)).toBeInTheDocument();
    expect(screen.getByText(/尚无与当前 Insight 明确关联的证据事实/)).toBeInTheDocument();
  });
});
