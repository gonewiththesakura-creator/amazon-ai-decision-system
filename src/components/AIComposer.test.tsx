// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Insight } from '../../shared/types';
import { AIComposer } from './AIComposer';
import { InsightPanel } from './InsightPanel';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('../lib/api', () => ({ api: { post: postMock } }));
vi.mock('../lib/AppContext', () => ({
  useApp: () => ({ settings: { role: 'admin' } }),
}));

const workflowRequired: Insight = {
  id: '',
  entityType: 'owned_product',
  entityId: 'owned-sku-01',
  insightType: 'workflow_required',
  status: '数据不足',
  title: '灰色枕头：尚无正式工作流结论',
  summary: '当前页面只有确定性指标，请先运行研究任务。',
  facts: [],
  opportunities: [],
  risks: [],
  recommendedActions: ['创建 Research Job'],
  evidence: [],
  evidenceIds: [],
  confidence: 0,
  model: 'workflow-gate',
  dataVersion: 'workflow-required',
  generatedAt: '2026-09-11T00:00:00.000Z',
};

const formalInsight: Insight = {
  ...workflowRequired,
  id: 'insight-1',
  entityType: 'research_job',
  entityId: 'job-1',
  insightType: 'owned_product_diagnosis',
  status: '明显跑输',
  title: '灰色枕头：明显跑输',
  summary: 'SKU 相对市场低 20 个百分点。',
  evidence: [{
    id: 'evidence-1',
    claim: 'SKU 相对市场低 20 个百分点',
    metrics: [{ name: 'relative_delta', label: '相对差', value: -20, unit: '%' }],
    provenance: [{
      source: 'SellerSprite import', sourceType: 'import', collectedAt: '2026-09-11T00:00:00.000Z',
      period: '30D', isEstimated: false, confidence: 0.9,
    }],
  }],
  evidenceIds: ['evidence-1'],
  researchJobId: 'job-1',
  promptVersion: 'owned-sku-analysis.v1',
  confidence: 0.9,
  dataVersion: 'workflow-current',
};

afterEach(() => {
  cleanup();
  postMock.mockReset();
});

describe('AIComposer workflow provenance', () => {
  it('turns a workflow-required detail insight into a Research Job action', () => {
    render(<MemoryRouter><InsightPanel insight={workflowRequired} title="AI SKU 诊断" /></MemoryRouter>);

    expect(screen.getByText('灰色枕头：尚无正式工作流结论')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /创建或打开 Research Job/ }))
      .toHaveAttribute('href', '/research-jobs?entityType=owned_product&entityId=owned-sku-01');
    expect(screen.queryByText(/数据版本 workflow-required/)).not.toBeInTheDocument();
  });

  it('shows a Research Job action instead of confidence or Evidence for an informal answer', async () => {
    postMock.mockResolvedValue({
      answer: workflowRequired.summary,
      insight: workflowRequired,
      formal: false,
      notice: '当前实体没有可引用的正式工作流结论。',
    });
    render(<MemoryRouter><AIComposer suggestions={['为什么跑输？']} /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: '为什么跑输？' }));

    expect(await screen.findByText('需运行 Research Job')).toBeInTheDocument();
    expect(screen.queryByText(/正式结论 · 置信度/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '创建或打开 Research Job' }))
      .toHaveAttribute('href', '/research-jobs?entityType=owned_product&entityId=owned-sku-01');
  });

  it('marks only a Research Job insight with Evidence ids as a formal answer', async () => {
    postMock.mockResolvedValue({
      answer: formalInsight.summary,
      insight: formalInsight,
      formal: true,
      notice: '回答引用当前版本 Research Job、Rule 与 Evidence。',
    });
    render(<MemoryRouter><AIComposer suggestions={['查看正式结论']} /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: '查看正式结论' }));

    expect(await screen.findByText(/正式结论 · 置信度/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /为什么/ })).toBeEnabled();
    expect(screen.queryByRole('link', { name: '创建或打开 Research Job' })).not.toBeInTheDocument();
  });
});
