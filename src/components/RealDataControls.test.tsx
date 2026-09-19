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
};
const verification = {
  mockObservations: 6, realMarketSnapshots: 0, realOwnedProductSnapshots: 0,
  activeOwnedProducts: 4, sellerSpriteConnectionVerified: false, hasMinimumRealCoverage: false,
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const data = url.endsWith('/api/go-live/preview') ? preview
    : url.endsWith('/api/markets/market-1') ? { node: { categoryId: '' } }
      : url.endsWith('/api/markets/market-1/sellersprite-node')
        ? { marketId: 'market-1', nodeIdPath: '1055398:1063252:1199122:10671043011' }
    : url.endsWith('/api/go-live/verify') ? verification
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
});

describe('real-data administration controls', () => {
  it('shows sanitized diagnostics and requires backup plus exact confirmation before cleanup', async () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<RealDataControls isViewer={false} marketId="market-1" />);

    expect(await screen.findByText('Market Snapshots: 2')).toBeInTheDocument();
    expect(screen.getByText('演示产品主档: 12')).toBeInTheDocument();
    expect(screen.getByText(/连接 未验证/)).toBeInTheDocument();
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
    fireEvent.change(screen.getByLabelText('SellerSprite 节点路径'), {
      target: { value: '1055398:1063252:1199122:10671043011' },
    });
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
