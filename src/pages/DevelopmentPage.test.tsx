// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DevelopmentProject, Insight } from '../../shared/types';
import DevelopmentPage from './DevelopmentPage';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('../lib/AppContext', () => ({
  useApp: () => ({
    settings: { role: 'admin', marketplace: 'US', currency: 'USD' },
    refreshKey: 0,
    reloadSettings: vi.fn(),
  }),
}));

vi.mock('../lib/api', () => ({
  useApi: () => ({
    data: null,
    error: null,
    loading: false,
    refreshing: false,
    reload: vi.fn(),
  }),
}));

const legacyInsight: Insight = {
  id: 'insight-dev-travel',
  entityType: 'development_project',
  entityId: 'dev-travel',
  insightType: 'development_assessment',
  status: '待 V2 工作流审批',
  title: '旧 Demo 结论',
  summary: '这是项目列表中的旧结论。',
  facts: [],
  opportunities: [],
  risks: [],
  recommendedActions: [],
  evidence: [],
  confidence: 0.6,
  model: 'rule-engine-v1',
  dataVersion: 'demo-v1',
  generatedAt: '2026-08-29T00:00:00.000Z',
};

const formalInsight: Insight = {
  ...legacyInsight,
  id: 'formal-insight',
  entityType: 'research_job',
  entityId: 'job-current',
  insightType: 'adjacent_product_decision',
  title: '当前正式 V2 结论',
  summary: 'Hard Gate 已通过，等待人工审批。',
  evidence: [{
    id: 'evidence-current',
    claim: '当前版本证据',
    metrics: [{ name: 'score', label: '确定性评分', value: 67.1 }],
    provenance: [{
      source: 'workflow fixture',
      sourceType: 'manual',
      collectedAt: '2026-09-11T00:00:00.000Z',
      period: 'point_in_time',
      isEstimated: false,
      confidence: 0.9,
    }],
  }],
  evidenceIds: ['evidence-current'],
  researchJobId: 'job-current',
  promptVersion: 'product-research.v1+reverse-review.v1',
  dataVersion: 'workflow-current',
};

const project: DevelopmentProject = {
  id: 'dev-travel',
  marketNodeId: 'mkt-travel',
  name: 'U 型记忆棉旅行枕',
  productType: 'travel_pillow',
  keywords: ['travel pillow'],
  notes: '',
  marketplace: 'US',
  supplyChainRelation: '海绵工艺可复用',
  createdAt: '2026-08-29T00:00:00.000Z',
  marketSize: 1_253_460,
  growth30d: 6.8,
  competitionScore: 64,
  opportunityScore: 71,
  status: 'watch',
  scoreBreakdown: {
    demand: 16,
    growth: 12,
    competition: 12,
    newProductFriendly: 10,
    priceRoom: 8,
    concentration: 9,
    confidence: 4,
  },
  insight: legacyInsight,
};

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('DevelopmentPage direct detail route', () => {
  it('finishes loading and replaces the list item with the current formal detail', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      const data = url.endsWith('/dev-travel')
        ? { ...project, insight: formalInsight }
        : [project];
      return Promise.resolve(new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/development?project=dev-travel']}>
        <DevelopmentPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('当前正式 V2 结论')).toBeInTheDocument();
    expect(screen.queryByText('正在加载项目详情…')).not.toBeInTheDocument();
    expect(screen.queryByText('旧 Demo 结论')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/development-projects/dev-travel', expect.anything());
  });
});
