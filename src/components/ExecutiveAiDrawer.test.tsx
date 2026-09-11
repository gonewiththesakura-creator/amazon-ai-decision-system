// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Insight } from '../../shared/types';
import { ExecutiveAiDrawer } from './ExecutiveAiDrawer';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('../lib/api', () => ({ api: { post: postMock } }));
vi.mock('../lib/AppContext', () => ({
  useApp: () => ({ settings: { role: 'admin' } }),
}));

const formalInsight: Insight = {
  id: 'insight-1',
  entityType: 'research_job',
  entityId: 'job-1',
  insightType: 'owned_product_diagnosis',
  status: '明显跑输',
  title: '灰色枕头：明显跑输',
  summary: 'SKU 相对市场低 20 个百分点。',
  facts: ['相对市场低 20 个百分点'],
  opportunities: [],
  risks: ['相对表现偏弱'],
  recommendedActions: ['检查直接竞品变化'],
  evidence: [{
    id: 'evidence-1',
    claim: 'SKU 相对市场低 20 个百分点',
    metrics: [{ name: 'relative_delta', label: '相对差', value: -20, unit: '%' }],
    provenance: [{
      source: 'SellerSprite import',
      sourceType: 'import',
      collectedAt: '2026-09-11T00:00:00.000Z',
      period: '30D',
      isEstimated: false,
      confidence: 0.9,
    }],
  }],
  evidenceIds: ['evidence-1'],
  researchJobId: 'job-1',
  promptVersion: 'owned-sku-analysis.v1',
  confidence: 0.9,
  model: 'workflow-gate',
  dataVersion: 'workflow-current',
  generatedAt: '2026-09-11T00:00:00.000Z',
};

afterEach(() => {
  cleanup();
  postMock.mockReset();
});

describe('ExecutiveAiDrawer', () => {
  it('opens a compact drawer with the four executive questions', () => {
    render(<MemoryRouter><ExecutiveAiDrawer /></MemoryRouter>);

    const trigger = screen.getByRole('button', { name: '问 AI' });
    fireEvent.click(trigger);

    expect(screen.getByRole('dialog', { name: '问 AI' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '问 AI' }).parentElement?.parentElement).toBe(document.body);
    const close = screen.getByRole('button', { name: '关闭问 AI' });
    expect(close).toHaveFocus();
    expect(screen.getByRole('button', { name: '今天最值得关注什么？' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '最近哪个竞品涨得最快？' })).toBeInTheDocument();
    expect(screen.getByText('只引用当前正式结论与证据')).toBeInTheDocument();

    const textarea = screen.getByRole('textbox', { name: '你的问题' });
    textarea.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '问 AI' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('does not label an answer formal when lineage is incomplete', async () => {
    postMock.mockResolvedValue({
      answer: formalInsight.summary,
      insight: { ...formalInsight, evidenceIds: [] },
      formal: true,
    });
    render(<MemoryRouter><ExecutiveAiDrawer /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: '问 AI' }));
    fireEvent.click(screen.getByRole('button', { name: '哪个 SKU 跑输最严重？' }));

    expect(await screen.findByText('暂无正式结论')).toBeInTheDocument();
    expect(screen.queryByText(/正式结论 · 置信度/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '前往研究任务' })).toHaveAttribute('href', '/research-jobs');
  });

  it('shows the Evidence entry only for a fully linked formal insight', async () => {
    postMock.mockResolvedValue({
      answer: formalInsight.summary,
      insight: formalInsight,
      formal: true,
    });
    render(<MemoryRouter><ExecutiveAiDrawer /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: '问 AI' }));
    fireEvent.click(screen.getByRole('button', { name: '哪个 SKU 跑输最严重？' }));

    expect(await screen.findByText(/正式结论 · 置信度/)).toBeInTheDocument();
    const evidenceTrigger = screen.getByRole('button', { name: /为什么/ });
    expect(evidenceTrigger).toBeEnabled();
    expect(screen.queryByRole('link', { name: '前往研究任务' })).not.toBeInTheDocument();

    fireEvent.click(evidenceTrigger);
    expect(screen.getByRole('dialog', { name: '结论证据链' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '结论证据链' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '问 AI' })).toBeInTheDocument();
  });
});
