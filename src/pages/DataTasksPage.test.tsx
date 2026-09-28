// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataCoverageReport } from '../../shared/types';
import DataTasksPage from './DataTasksPage';
import { confirmImport, previewImport } from '../lib/api';

const { reloadCoverage, useApiMock } = vi.hoisted(() => ({
  reloadCoverage: vi.fn(),
  useApiMock: vi.fn(),
}));

vi.mock('../lib/AppContext', () => ({
  useApp: () => ({ settings: { role: 'admin', marketplace: 'US' }, refreshKey: 0 }),
}));
vi.mock('../lib/api', () => ({
  confirmImport: vi.fn(), previewImport: vi.fn(), selectImportPreviewType: vi.fn(), useApi: useApiMock,
}));

const coverage: DataCoverageReport = {
  generatedAt: '2026-09-19T00:00:00.000Z', marketplace: 'US',
  primaryMarket: { covered: 1, total: 1, status: 'complete', label: '完整' },
  activeOwnedProducts: { covered: 3, total: 4, status: 'partial', label: '部分覆盖' },
  coreCompetitors: { covered: 0, total: 5, status: 'missing', label: '缺失' },
  history90d: { covered: 2, total: 4, status: 'partial', label: '部分覆盖' },
  primaryMarketHistory90d: { covered: 1, total: 1, status: 'complete', label: '完整' },
  ownedProductHistory90d: { covered: 2, total: 4, status: 'partial', label: '部分覆盖' },
  ownedProductHistory180d: { covered: 1, total: 4, status: 'partial', label: '部分覆盖' },
  coreCompetitorHistory90d: { covered: 0, total: 5, status: 'missing', label: '缺失' },
  coreDirectCompetitorTarget: {
    covered: 1, total: 4, status: 'partial', label: '部分覆盖',
    minimumPerOwnedProduct: 3, preferredMaximumPerOwnedProduct: 5,
  },
  amazonActual: { covered: 0, total: 4, status: 'missing', label: '缺失' },
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }));
  useApiMock.mockReturnValue({ data: coverage, loading: false, error: null, reload: reloadCoverage });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('DataTasksPage coverage', () => {
  it('renders hard market history and non-blocking owned and competitor targets', async () => {
    render(<MemoryRouter><DataTasksPage /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: '真实数据覆盖' })).toBeInTheDocument();
    expect(screen.getByLabelText('主市场覆盖：1 / 1，完整')).toBeInTheDocument();
    expect(screen.getByLabelText('活跃自有产品覆盖：3 / 4，部分覆盖')).toBeInTheDocument();
    expect(screen.getByLabelText('核心竞品覆盖：0 / 5，缺失')).toBeInTheDocument();
    expect(screen.getByLabelText('主市场 90 天历史覆盖：1 / 1，完整')).toBeInTheDocument();
    expect(screen.getByLabelText('自有 SKU 90 天历史覆盖：2 / 4，部分覆盖')).toBeInTheDocument();
    expect(screen.getByLabelText('自有 SKU 180 天历史覆盖：1 / 4，部分覆盖')).toBeInTheDocument();
    expect(screen.getByLabelText('核心竞品 90 天历史覆盖：0 / 5，缺失')).toBeInTheDocument();
    expect(screen.getByLabelText('人工确认 Direct 竞品目标（每 SKU 3-5）覆盖：1 / 4，部分覆盖'))
      .toBeInTheDocument();
    expect(screen.getByLabelText('Amazon 实际数据覆盖：0 / 4，缺失')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '审核文件导入' })).toBeInTheDocument();
  });

  it('lands the homepage import link on the lazily mounted review center', async () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true, value: scroll,
    });
    render(<MemoryRouter initialEntries={['/data-tasks#import-center-title']}><DataTasksPage /></MemoryRouter>);
    const heading = await screen.findByRole('heading', { name: '审核文件导入' });
    expect(heading).toHaveFocus();
    expect(scroll).toHaveBeenCalledWith({ block: 'start' });
  });

  it('exposes coverage loading and recoverable error states', async () => {
    useApiMock.mockReturnValueOnce({ data: null, loading: true, error: null, reload: reloadCoverage });
    const view = render(<MemoryRouter><DataTasksPage /></MemoryRouter>);
    expect(screen.getByRole('status', { name: '正在检查真实数据覆盖' })).toBeInTheDocument();
    await screen.findByRole('heading', { name: '还没有数据任务' });
    view.unmount();
    useApiMock.mockReturnValueOnce({ data: null, loading: false, error: new Error('覆盖接口失败'), reload: reloadCoverage });
    render(<MemoryRouter><DataTasksPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '重试覆盖检查' }));
    expect(reloadCoverage).toHaveBeenCalledOnce();
    await screen.findByRole('heading', { name: '还没有数据任务' });
  });

  it('routes run-managed SellerSprite retries back through critical sync', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{
          id: 'critical-run', syncRunId: 'critical-run', name: 'SellerSprite 关键同步',
          taskType: 'critical_sync', target: 'market-1', sourceId: 'source-sellersprite-mcp',
          source: 'SellerSprite MCP', marketplace: 'US', status: 'failed',
          startedAt: '2026-09-20T00:00:00.000Z', completedAt: '2026-09-20T00:01:00.000Z',
          total: 5, success: 0, failed: 5, errorLog: '连接失败', createdAt: '2026-09-20T00:00:00.000Z',
        }],
      }),
    }));
    render(<MemoryRouter><DataTasksPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: '查看 SellerSprite 关键同步 错误详情' }));
    expect(screen.queryByRole('button', { name: '创建重试任务' })).not.toBeInTheDocument();
    expect(screen.getByText(/设置.*数据源.*关键同步/)).toBeInTheDocument();
  });

  it('routes ResearchJob-owned task failures back to the owning workflow', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{
          id: 'research-task', syncRunId: null, researchJobId: 'research-job-1',
          name: '市场数据采集', taskType: 'collect_market', target: 'market-1',
          sourceId: null, source: 'Persisted Snapshot', marketplace: 'US', status: 'failed',
          startedAt: '2026-09-20T00:00:00.000Z', completedAt: '2026-09-20T00:01:00.000Z',
          total: 1, success: 0, failed: 1, errorLog: '缺少可比较的历史快照。',
          createdAt: '2026-09-20T00:00:00.000Z',
        }],
      }),
    }));
    render(<MemoryRouter><DataTasksPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: '查看 市场数据采集 错误详情' }));

    expect(screen.queryByRole('button', { name: '创建重试任务' })).not.toBeInTheDocument();
    expect(screen.getByText(/Research Job.*工作流/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '打开 Research Job' }))
      .toHaveAttribute('href', '/research-jobs/research-job-1');
  });

  it('does not offer generic retry for a failed post-import analysis audit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{
        id: 'analysis-task', syncRunId: null, researchJobId: null,
        name: '导入后分析', taskType: 'post_import_analysis', target: 'import-batch-1',
        sourceId: 'source-sellersprite-import', source: 'SellerSprite Import',
        marketplace: 'US', status: 'failed', startedAt: '2026-09-20T00:00:00.000Z',
        completedAt: '2026-09-20T00:01:00.000Z', total: 1, success: 0, failed: 1,
        errorLog: '导入已提交，自动分析未完成。', createdAt: '2026-09-20T00:00:00.000Z',
      }] }),
    }));
    render(<MemoryRouter><DataTasksPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: '查看 导入后分析 错误详情' }));
    expect(screen.queryByRole('button', { name: '创建重试任务' })).not.toBeInTheDocument();
  });

  it('passes explicit Amazon report period and marketplace to preview', async () => {
    vi.mocked(previewImport).mockResolvedValue({
      token: 'preview', detectedType: 'amazon_business_report', entityType: 'product',
      totalCount: 1, newCount: 1, updateCount: 0, duplicateCount: 0, errorCount: 0,
      contentDigest: 'digest', errors: [], mappings: [{ sourceHeader: 'childasin', targetField: 'asin' }],
      rows: [{ rowNumber: 2, values: { childasin: 'B0TEST0001' } }], previewRowLimit: 20,
      previewedCount: 1, rowsOmitted: 0, expiresAt: '2026-09-20T00:00:00.000Z',
    });
    render(<MemoryRouter><DataTasksPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('文件来源'), { target: { value: 'amazon' } });
    fireEvent.change(screen.getByLabelText('报表开始日期'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('报表结束日期'), { target: { value: '2026-08-31' } });
    const file = new File(['(Child) ASIN,SKU,Units Ordered\nB0TEST0001,SKU-1,10'], 'sales.csv', { type: 'text/csv' });
    fireEvent.change(document.getElementById('import-center-file')!, { target: { files: [file] } });
    await waitFor(() => expect(previewImport).toHaveBeenCalledWith(file, {
      sourceType: 'amazon', marketplace: 'US',
      reportStartDate: '2026-08-01', reportEndDate: '2026-08-31',
    }));
  });

  it('shows mappings, normalized sample values, and row-level rejection reasons without claiming review', async () => {
    vi.mocked(previewImport).mockResolvedValue({
      token: 'sample-preview', contentDigest: 'digest', detectedType: 'sellersprite_product', entityType: 'product',
      totalCount: 3, newCount: 1, updateCount: 0, duplicateCount: 0, errorCount: 1,
      mappings: [{ sourceHeader: 'childasin', targetField: 'asin' }, { sourceHeader: 'estimatedsales', targetField: 'estimatedSales' }],
      rows: [{ rowNumber: 2, values: { childasin: 'B0SAMPLE01', estimatedsales: 120 } }],
      errors: ['第 3 行：缺少 ASIN'], previewRowLimit: 20, previewedCount: 1, rowsOmitted: 2,
      expiresAt: '2026-09-20T00:00:00.000Z',
    });
    render(<MemoryRouter><DataTasksPage /></MemoryRouter>);
    const file = new File(['childasin,estimatedsales\nB0SAMPLE01,120'], 'products.csv', { type: 'text/csv' });
    fireEvent.change(document.getElementById('import-center-file')!, { target: { files: [file] } });

    expect(await screen.findByRole('heading', { name: '字段映射' })).toBeInTheDocument();
    expect(screen.getAllByText('childasin')).toHaveLength(2);
    expect(screen.getByText('estimatedSales')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '样例行' })).toBeInTheDocument();
    expect(screen.getByText('B0SAMPLE01')).toBeInTheDocument();
    expect(screen.getByText('第 3 行：缺少 ASIN')).toBeInTheDocument();
    expect(screen.getByText(/另有 2 行未展开/)).toBeInTheDocument();
    expect(screen.queryByText(/已审核/)).not.toBeInTheDocument();
  });

  it('requires explicit acknowledgement before importing valid rows from a partially rejected file', async () => {
    vi.mocked(previewImport).mockResolvedValue({
      token: 'partial-preview', contentDigest: 'digest', detectedType: 'sellersprite_product', entityType: 'product',
      totalCount: 2, newCount: 1, updateCount: 0, duplicateCount: 0, errorCount: 1,
      mappings: [{ sourceHeader: 'asin', targetField: 'asin' }], rows: [], errors: ['第 3 行：ASIN 无效'],
      previewRowLimit: 20, previewedCount: 0, rowsOmitted: 2, expiresAt: '2026-09-20T00:00:00.000Z',
    });
    vi.mocked(confirmImport).mockResolvedValue({
      batchId: 'batch', entityType: 'product', rowCount: 2, successCount: 1, failureCount: 1, errors: ['第 3 行：ASIN 无效'],
    });
    render(<MemoryRouter><DataTasksPage /></MemoryRouter>);
    const file = new File(['asin\nB0VALID001'], 'partial.csv', { type: 'text/csv' });
    fireEvent.change(document.getElementById('import-center-file')!, { target: { files: [file] } });

    const confirm = await screen.findByRole('button', { name: '确认导入' });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /只导入有效行/ }));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(confirmImport).toHaveBeenCalledWith('partial-preview'));
    expect(await screen.findByRole('status')).toHaveTextContent('1 行未写入');
  });

  it('does not offer partial confirmation for an owned-product master with rejected rows', async () => {
    vi.mocked(previewImport).mockResolvedValue({
      token: 'invalid-master', contentDigest: 'digest', detectedType: 'owned_product_master',
      entityType: 'owned_product_master', totalCount: 5, newCount: 4, updateCount: 0,
      duplicateCount: 0, errorCount: 1,
      mappings: [{ sourceHeader: 'asin', targetField: 'asin' }], rows: [],
      errors: ['第 6 行：缺少必填字段 title。'], previewRowLimit: 20, previewedCount: 0,
      rowsOmitted: 5, expiresAt: '2026-09-20T00:00:00.000Z',
    });
    render(<MemoryRouter><DataTasksPage /></MemoryRouter>);
    const file = new File(['asin\nB0VALID001'], 'owned-product-master.csv', { type: 'text/csv' });
    fireEvent.change(document.getElementById('import-center-file')!, { target: { files: [file] } });

    const confirm = await screen.findByRole('button', { name: '确认导入' });
    expect(confirm).toBeDisabled();
    expect(screen.queryByRole('checkbox', { name: /只导入有效行/ })).not.toBeInTheDocument();
    expect(screen.getByText(/产品主数据必须整批通过校验/)).toBeInTheDocument();
    fireEvent.click(confirm);
    expect(confirmImport).not.toHaveBeenCalled();
  });

  it('locks the file and report period while the preview request is pending', async () => {
    let resolvePreview!: (value: Awaited<ReturnType<typeof previewImport>>) => void;
    vi.mocked(previewImport).mockImplementation(() => new Promise((resolve) => { resolvePreview = resolve; }));
    render(<MemoryRouter><DataTasksPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('文件来源'), { target: { value: 'amazon' } });
    fireEvent.change(screen.getByLabelText('报表开始日期'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('报表结束日期'), { target: { value: '2026-08-31' } });
    const input = document.getElementById('import-center-file')!;
    fireEvent.change(input, { target: { files: [new File(['x'], 'report.csv', { type: 'text/csv' })] } });
    await waitFor(() => expect(previewImport).toHaveBeenCalledOnce());

    expect(input).toBeDisabled();
    expect(screen.getByLabelText('报表开始日期')).toBeDisabled();
    expect(screen.getByLabelText('报表结束日期')).toBeDisabled();

    resolvePreview({
      token: 'preview', contentDigest: 'digest', detectedType: 'amazon_business_report', entityType: 'product',
      totalCount: 1, newCount: 1, updateCount: 0, duplicateCount: 0, errorCount: 0,
      mappings: [{ sourceHeader: 'childasin', targetField: 'asin' }],
      rows: [{ rowNumber: 2, values: { childasin: 'B0TEST0001' } }], errors: [],
      previewRowLimit: 20, previewedCount: 1, rowsOmitted: 0, expiresAt: '2026-09-20T00:00:00.000Z',
    });
    await waitFor(() => expect(input).toBeEnabled());
  });
});
