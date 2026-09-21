// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RealDataControls from './RealDataControls';

const preview = {
  archive: { products: 12 },
  delete: {
    marketSnapshots: 2, productSnapshots: 4, competitorRelations: 3,
    dataTasks: 1, aiInsights: 1, opportunities: 1,
  },
  preserve: { products: 4, rules: 3, decisions: 0 },
  blockers: [] as string[],
  retainedDemoHistory: [] as Array<{
    kind: 'demo_rule_score_evidence' | 'legacy_demo_rejection';
    ref: string;
    detail: string;
    status: string;
    linkedMockInsights: number;
  }>,
};
const verification = {
  mockObservations: 6, realMarketSnapshots: 0, realOwnedProductSnapshots: 0,
  activeOwnedProducts: 4, sellerSpriteMarketSnapshots: 0, sellerSpriteOwnedProductSnapshots: 0,
  sellerSpriteConnectionVerified: false, sellerSpriteCapabilitiesAvailable: false,
  sellerSpriteMarketCalls: 0, sellerSpriteAsinCalls: 0,
  sellerSpriteCriticalRunId: null as string | null,
  verifiedEvidenceEntities: 0, requiredEvidenceEntities: 5,
  readyForDemoCleanup: false, hasMinimumRealCoverage: false,
};
let currentVerification = verification;
let currentPreview = preview;
let cleanupExpired = false;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith('/api/go-live/cleanup') && cleanupExpired) {
    return {
      ok: false, status: 409, headers: { get: () => 'application/json' },
      json: async () => ({ error: '备份已过期：数据库在备份后发生变更，请重新备份。' }),
    } as unknown as Response;
  }
  const data = url.endsWith('/api/go-live/preview') ? currentPreview
    : url.endsWith('/api/markets/market-1') ? {
      node: { categoryId: '1055398:1063252:1199122:10671043011' },
    }
      : url.endsWith('/api/markets/market-1/sellersprite-node')
        ? { marketId: 'market-1', nodeIdPath: '1055398:1063252:1199122:10671043011' }
    : url.endsWith('/api/go-live/verify') ? currentVerification
      : url.endsWith('/api/integrations/sellersprite/capabilities')
        ? { toolCount: 0, required: [], collectedAt: null }
        : url.endsWith('/api/integrations/sellersprite/test')
          ? { connected: true, authenticated: true, toolCount: 49,
            availableRequiredCapabilityCount: 5, requiredCapabilityCount: 5,
            missingCapabilities: [], latencyMs: 42 }
          : url.endsWith('/api/go-live/backup')
            ? { created: true, filename: 'backup.db', createdAt: '2026-09-19T00:00:00Z' }
            : url.endsWith('/api/go-live/cleanup') ? { cleanup: preview }
              : { activated: true };
  return {
    ok: true, status: init?.method === 'POST' ? 201 : 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ data }),
  } as unknown as Response;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockClear();
  currentVerification = verification;
  currentPreview = preview;
  cleanupExpired = false;
});

describe('real-data administration controls', () => {
  it('lists retained Demo history in Dry Run but keeps cleanup blocked', async () => {
    currentVerification = { ...verification, readyForDemoCleanup: true };
    currentPreview = {
      ...preview,
      blockers: ['Evidence: 32', 'unregistered Mock insights: 4'],
      retainedDemoHistory: [
        { kind: 'demo_rule_score_evidence', ref: 'demo-aaaaaaaaaaaa',
          detail: '规则派生得分；原记录标记为 manual，关联 Demo Research Job',
          status: 'waiting_approval', linkedMockInsights: 1 },
        { kind: 'legacy_demo_rejection', ref: 'demo-bbbbbbbbbbbb',
          detail: '已拒绝的 Demo 机会；关联 Mock Insight 与决策记录',
          status: 'rejected', linkedMockInsights: 1 },
      ],
    };
    vi.stubGlobal('fetch', fetchMock);
    render(<RealDataControls isViewer={false} marketId="market-1" />);

    expect(await screen.findByRole('list', { name: 'Demo 历史保留核对' })).toHaveTextContent(/规则派生得分/);
    expect(screen.getByRole('list', { name: 'Demo 历史保留核对' })).toHaveTextContent(/已拒绝的 Demo 机会/);
    expect(screen.getByText(/demo-aaaaaaaaaaaa/)).toBeInTheDocument();
    expect(screen.getByText(/demo-bbbbbbbbbbbb/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/Demo 记录仍有引用或未归属的 Mock 结论/);
    expect(screen.queryByText(/真实工作流引用了待清理/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '备份数据库' }));
    await waitFor(() => expect(screen.getByText(/backup.db/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('清理确认文本'), { target: { value: 'CLEAR DEMO DATA' } });
    expect(screen.getByRole('button', { name: '清除演示数据' })).toBeDisabled();
    expect(screen.queryByText(/private metric claim|private rejection rationale|private-owner/)).not.toBeInTheDocument();
  });

  it('requires another backup when the database changed after backup', async () => {
    currentVerification = { ...verification, readyForDemoCleanup: true };
    cleanupExpired = true;
    vi.stubGlobal('fetch', fetchMock);
    render(<RealDataControls isViewer={false} marketId="market-1" />);

    await screen.findByText(/清理前真实链路已通过/);
    fireEvent.click(screen.getByRole('button', { name: '备份数据库' }));
    await waitFor(() => expect(screen.getByText(/backup.db/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('清理确认文本'), { target: { value: 'CLEAR DEMO DATA' } });
    fireEvent.click(screen.getByRole('button', { name: '清除演示数据' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/备份已过期.*重新备份/);
    expect(screen.queryByText('backup.db')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '清除演示数据' })).toBeDisabled();
  });

  it('keeps demo cleanup disabled when pre-cleanup real proof is missing', async () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<RealDataControls isViewer={false} marketId="market-1" />);

    expect(await screen.findByText(/清理前真实链路未通过/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '备份数据库' }));
    await waitFor(() => expect(screen.getByText(/backup.db/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('清理确认文本'), { target: { value: 'CLEAR DEMO DATA' } });
    expect(screen.getByRole('button', { name: '清除演示数据' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/go-live/cleanup', expect.anything());
  });

  it('shows sanitized diagnostics and requires backup plus exact confirmation before cleanup', async () => {
    currentVerification = {
      ...verification,
      realMarketSnapshots: 1, realOwnedProductSnapshots: 1,
      sellerSpriteMarketSnapshots: 1, sellerSpriteOwnedProductSnapshots: 1,
      sellerSpriteConnectionVerified: true, sellerSpriteCapabilitiesAvailable: true,
      sellerSpriteMarketCalls: 1, sellerSpriteAsinCalls: 1,
      sellerSpriteCriticalRunId: '12345678-abcd-4abc-8abc-1234567890ab',
      verifiedEvidenceEntities: 5, requiredEvidenceEntities: 5,
      readyForDemoCleanup: true,
    };
    vi.stubGlobal('fetch', fetchMock);
    render(<RealDataControls isViewer={false} marketId="market-1" />);

    expect(await screen.findByText('Market Snapshots: 2')).toBeInTheDocument();
    expect(screen.getByText('演示产品主档: 12')).toBeInTheDocument();
    expect(screen.getByText(/清理前真实链路已通过/)).toBeInTheDocument();
    expect(screen.getByText(/关键运行 12345678-abcd-4abc-8abc-1234567890ab/)).toBeInTheDocument();
    expect(screen.getByText(/运行 Evidence 5 \/ 5/)).toBeInTheDocument();
    expect(screen.getByText(/Live 切换条件未满足/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '清除演示数据' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '连接测试' }));
    expect(await screen.findByText(/已认证.*49 个工具/)).toBeInTheDocument();
    expect(screen.getByText(/5 \/ 5 项必需能力/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '备份数据库' }));
    await waitFor(() => expect(screen.getByText(/backup.db/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('清理确认文本'), { target: { value: 'CLEAR DEMO DATA' } });
    expect(screen.getByRole('button', { name: '清除演示数据' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '清除演示数据' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/go-live/cleanup', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ confirmation: 'CLEAR DEMO DATA' }),
    })));
    expect(screen.getByRole('button', { name: '切换 Live' })).toBeDisabled();
    expect(screen.queryByText(/secret|ghp_/i)).not.toBeInTheDocument();
  });

  it('keeps all mutations disabled for Viewer', async () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<RealDataControls isViewer marketId="market-1" />);

    await screen.findByText('Market Snapshots: 2');
    expect(screen.getByRole('button', { name: '连接测试' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '同步关键数据' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '备份数据库' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '清除演示数据' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '切换 Live' })).toBeDisabled();
  });

  it('requires a confirmed market path before enabling critical SellerSprite sync', async () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<RealDataControls isViewer={false} marketId="market-1" />);
    await screen.findByText('Market Snapshots: 2');
    expect(screen.getByRole('button', { name: '同步关键数据' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存映射' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('已核对站点和类目范围'));
    fireEvent.click(screen.getByRole('button', { name: '保存映射' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/markets/market-1/sellersprite-node', expect.objectContaining({
        method: 'PATCH', body: JSON.stringify({
          nodeIdPath: '1055398:1063252:1199122:10671043011', confirmed: true,
        }),
      }),
    ));
    expect(screen.getByRole('button', { name: '同步关键数据' })).toBeEnabled();
  });
});
