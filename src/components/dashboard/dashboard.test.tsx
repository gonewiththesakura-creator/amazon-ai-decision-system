// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import {
  DataFreshnessBadge,
  DailyInsights,
  CompetitorGrowthChart,
  DevelopmentOpportunityChart,
  ExecutiveKpis,
  MarketSkuTrendChart,
  ResearchStatusChart,
  SkuRelativeBarChart,
  SkuFocusView,
} from './index';
import { indexedTrendDomain } from './format';

afterEach(() => cleanup());

Object.defineProperty(window, 'requestAnimationFrame', {
  configurable: true,
  value: (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  },
});
Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: () => undefined });

describe('executive dashboard presentation invariants', () => {
  it('uses a padded indexed domain around the observed values and baseline', () => {
    expect(indexedTrendDomain([94.4, 100, 108.2, 118.9])).toEqual([91, 122]);
    expect(indexedTrendDomain([100, 100])).toEqual([98, 102]);
  });

  it('keeps the Demo label explicit and exposes a partial-sync action', () => {
    const onClick = vi.fn();
    render(<DataFreshnessBadge status="partial" updatedAt="2026-09-11T09:30:00.000Z" isDemo onClick={onClick} />);

    expect(screen.getByText('DEMO / 演示数据')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /部分数据未更新/ }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders a missing market baseline as a dash rather than zero percent', () => {
    const { container } = render(<ExecutiveKpis kpis={{
      marketGrowth: null,
      marketGrowthLabel: '历史数据不足',
      outperformingSkus: 1,
      totalSkus: 4,
      attentionSkus: 2,
      fastGrowthCompetitors: 6,
    }} />);

    expect(screen.getByText('暂无完整30日基线')).toBeInTheDocument();
    expect(container.textContent).not.toContain('0%');
  });

  it('shows the trend empty state when no series has two valid points', () => {
    render(<MarketSkuTrendChart
      commonBaselineDate={null}
      excludedSeries={[{ id: 'market', label: '记忆棉枕头市场', reason: 'insufficient_history' }]}
      marketConfigured
      series={[{
        id: 'market',
        label: '记忆棉枕头市场',
        kind: 'market',
        points: [],
      }]}
    />);

    expect(screen.getByText('历史快照不足')).toBeInTheDocument();
    expect(screen.getByText('市场与自有 SKU 形成共同有效基准后自动生成趋势。')).toBeInTheDocument();
  });

  it('exposes every plotted trend observation as an accessible data table', () => {
    render(<MarketSkuTrendChart
      range="30D"
      commonBaselineDate="2026-09-01T00:00:00.000Z"
      excludedSeries={[{ id: 'sku-b', label: '历史较短 SKU', reason: 'no_common_baseline' }]}
      marketConfigured
      series={[
      {
        id: 'market',
        label: '记忆棉枕头市场',
        kind: 'market',
        points: [
          { date: '2026-09-01T00:00:00.000Z', index: 100, relativeToMarket: null },
          { date: '2026-09-11T00:00:00.000Z', index: 106, relativeToMarket: null },
        ],
      },
      {
        id: 'sku-a',
        label: '灰色人体工学枕',
        kind: 'owned_sku',
        points: [
          { date: '2026-09-01T00:00:00.000Z', index: 100, relativeToMarket: 0 },
          { date: '2026-09-11T00:00:00.000Z', index: 111, relativeToMarket: 5 },
        ],
      },
      ]}
    />);

    const table = screen.getByRole('table', { name: '市场 VS 自有 SKU 趋势完整数据，时间范围 30D' });
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(within(table).getByRole('columnheader', { name: '指数' })).toBeInTheDocument();
    expect(within(table).getAllByText('灰色人体工学枕')).toHaveLength(2);
    expect(within(table).getByText('+5.0 点')).toBeInTheDocument();
    expect(screen.getByLabelText('趋势时间范围')).toBeInTheDocument();
    expect(screen.getByText(/共同基准：09\/01/)).toBeInTheDocument();
    expect(screen.getByText(/历史较短 SKU因历史数据不足未参与当前周期比较/)).toBeInTheDocument();
  });

  it('never treats the first SKU as a market series when no primary market is configured', () => {
    render(
      <MemoryRouter>
        <MarketSkuTrendChart
          commonBaselineDate={null}
          excludedSeries={[]}
          marketConfigured={false}
          series={[{
            id: 'sku-a',
            label: '灰色人体工学枕',
            kind: 'owned_sku',
            points: [
              { date: '2026-09-01T00:00:00.000Z', index: 100, relativeToMarket: null },
              { date: '2026-09-11T00:00:00.000Z', index: 108, relativeToMarket: null },
            ],
          }]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('尚未设置主市场')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '前往设置主市场' })).toHaveAttribute('href', '/settings');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('市场基准')).not.toBeInTheDocument();
  });

  it('does not calculate relative-to-market values in the browser', () => {
    render(<MarketSkuTrendChart
      commonBaselineDate="2026-09-01T00:00:00.000Z"
      excludedSeries={[]}
      marketConfigured
      series={[
        {
          id: 'market', label: '主市场', kind: 'market',
          points: [
            { date: '2026-09-01T00:00:00.000Z', index: 100, relativeToMarket: null },
            { date: '2026-09-11T00:00:00.000Z', index: 105, relativeToMarket: null },
          ],
        },
        {
          id: 'sku-a', label: '自有 SKU A', kind: 'owned_sku',
          points: [
            { date: '2026-09-01T00:00:00.000Z', index: 100, relativeToMarket: null },
            { date: '2026-09-11T00:00:00.000Z', index: 110, relativeToMarket: null },
          ],
        },
      ]}
    />);

    const table = screen.getByRole('table', { name: '市场 VS 自有 SKU 趋势完整数据，时间范围 30D' });
    const skuRows = within(table).getAllByText('自有 SKU A').map((cell) => cell.closest('tr'));
    expect(skuRows).toHaveLength(2);
    expect(skuRows.every((row) => row?.textContent?.endsWith('不可用'))).toBe(true);
  });

  it('exposes the sorted competitor Top10 and nullable fields in a data table', () => {
    render(<CompetitorGrowthChart competitors={[
      { id: 'c-low', name: '慢增长枕', asin: 'B0LOW', growth: 4, price: null, rating: null, reviews: null, tags: [] },
      { id: 'c-high', name: '快增长枕', asin: 'B0HIGH', growth: 18, price: 39.99, rating: 4.6, reviews: 2300, tags: ['直接竞品', '快速增长'] },
    ]} />);

    const table = screen.getByRole('table', { name: '竞品增长 TOP10 完整数据' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('1快增长枕B0HIGH+18.0%');
    expect(rows[1]).toHaveTextContent('直接竞品、快速增长');
    expect(rows[2]).toHaveTextContent('2慢增长枕B0LOW+4.0%不可用不可用不可用无');
  });

  it('includes excluded SKU values as explicit unavailable rows', () => {
    render(<SkuRelativeBarChart items={[
      { id: 'sku-a', name: '灰色枕', relativeDelta: 8, performance: 'outperform' },
      { id: 'sku-b', name: '白色枕', relativeDelta: null, performance: 'insufficient_data' },
    ]} />);

    const table = screen.getByRole('table', { name: '自有 SKU 相对市场表现完整数据' });
    expect(within(table).getByText('白色枕').closest('tr')).toHaveTextContent('白色枕不可用数据不足');
    expect(within(table).getByText('灰色枕').closest('tr')).toHaveTextContent('灰色枕+8.0%跑赢');
  });

  it('labels unavailable opportunities without manufacturing zero scores', () => {
    const { container } = render(<DevelopmentOpportunityChart opportunities={[
      {
        id: 'massage', name: '按摩枕', scoreStatus: 'needs_data', score: null,
        hardGate: 'needs_data', systemRecommendation: 'needs_data', approvalStatus: 'not_required',
        approvedAction: null,
      },
      {
        id: 'leg', name: '腿枕', scoreStatus: 'rejected', score: null,
        hardGate: 'reject', systemRecommendation: 'reject', approvalStatus: 'not_required',
        approvedAction: null,
      },
    ]} />);

    expect(screen.getByText(/按摩枕 · 待补数据/)).toBeInTheDocument();
    expect(screen.getByText(/腿枕 · Hard Gate 未通过/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /按摩枕，AI 建议：待补数据，审批状态：无需审批/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /腿枕，AI 建议：暂不开发，审批状态：无需审批/ })).toBeInTheDocument();
    expect(container.textContent).not.toContain('0 分');
    expect(container.querySelector('.recharts-responsive-container')).not.toBeInTheDocument();
  });

  it('keeps a system recommendation separate from its pending approval', () => {
    render(<DevelopmentOpportunityChart opportunities={[{
      id: 'travel',
      name: 'U 型旅行枕',
      scoreStatus: 'scored',
      score: 78,
      hardGate: 'pass',
      systemRecommendation: 'test',
      approvalStatus: 'waiting',
      approvedAction: null,
    }]} />);

    expect(screen.getByRole('button', {
      name: 'U 型旅行枕，AI 建议：小规模验证，审批状态：待审批',
    })).toBeInTheDocument();
    expect(screen.getByText(/AI 建议：小规模验证 · 审批状态：待审批/)).toBeInTheDocument();
    expect(screen.queryByText('继续观察')).not.toBeInTheDocument();
  });

  it('uses horizontal status bars instead of a donut above five categories', () => {
    render(<ResearchStatusChart statuses={[
      { key: 'develop', label: '建议开发', count: 2 },
      { key: 'test', label: '小规模验证', count: 1 },
      { key: 'watch', label: '继续观察', count: 3 },
      { key: 'reject', label: '暂不开发', count: 1 },
      { key: 'needs-data', label: '待补数据', count: 2 },
      { key: 'archived', label: '已归档', count: 4 },
    ]} />);

    expect(screen.getByLabelText('产品研究建议水平条')).toBeInTheDocument();
    expect(screen.queryByLabelText('产品研究建议环形图')).not.toBeInTheDocument();
    expect(screen.getByText('仅统计系统建议，不混入人工审批结果。')).toBeInTheDocument();
  });

  it('keeps evidence details behind an accessible drawer without exposing evidence ids', () => {
    render(<DailyInsights insights={[{
      id: 'insight-key',
      type: 'risk',
      title: '灰色 SKU 明显跑输市场',
      summary: '相对市场落后 20 个百分点。',
      researchJobHref: '/research-jobs?job=job-key',
      lineage: {
        dataVersion: 'workflow-data-v3',
        ruleProfileId: 'owned-product-default',
        ruleProfileVersion: 3,
        promptVersion: 'owned-sku-analysis.v2',
      },
      evidence: [{
        claim: '相对市场表现已计算',
        metrics: [{ label: '相对市场差', value: -20, unit: '%' }],
        sources: [{ source: 'SellerSprite import', collectedAt: '2026-09-11T09:30:00.000Z', period: '30D' }],
        calculation: 'relative_delta = sku_growth_30d - market_growth_30d',
      }],
    }]} />);

    expect(screen.queryByText('SellerSprite import')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看依据' }));
    expect(screen.getByRole('dialog', { name: '查看数据依据' })).toBeInTheDocument();
    expect(screen.getByText('SellerSprite import')).toBeInTheDocument();
    expect(screen.getByText('-20%')).toBeInTheDocument();
    expect(screen.getByText('relative_delta = sku_growth_30d - market_growth_30d')).toBeInTheDocument();
    expect(screen.getByText('workflow-data-v3')).toBeInTheDocument();
    expect(screen.getByText('owned-product-default')).toBeInTheDocument();
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(screen.getByText('owned-sku-analysis.v2')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /打开研究任务/ })).toHaveAttribute(
      'href', '/research-jobs?job=job-key',
    );
    expect(screen.queryByText('evidence-secret-id')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('uses business language when there are no daily insights', () => {
    const { container } = render(<DailyInsights insights={[]} />);

    expect(screen.getByText('完成数据分析后，带数据依据的结论会出现在这里。')).toBeInTheDocument();
    expect(container).not.toHaveTextContent('Research Job');
  });

  it('marks missing technical lineage as unavailable instead of inventing values', () => {
    render(<DailyInsights insights={[{
      id: 'insight-with-gaps',
      type: 'data_warning',
      title: '当前结论存在血缘缺口',
      summary: '这里只验证缺失信息的展示。',
      researchJobHref: null,
      lineage: {
        dataVersion: null,
        ruleProfileId: null,
        ruleProfileVersion: null,
        promptVersion: null,
      },
      evidence: [{
        claim: '存在一条可读结论',
        metrics: [],
        sources: [],
        calculation: null,
      }],
    }]} />);

    fireEvent.click(screen.getByRole('button', { name: '查看依据' }));
    expect(screen.getAllByText('不可用')).toHaveLength(5);
    expect(screen.getByText('指标不可用')).toBeInTheDocument();
    expect(screen.getByText('来源不可用')).toBeInTheDocument();
    expect(screen.getByText('研究任务不可用')).toBeInTheDocument();
  });

  it('keeps missing SKU focus operating metrics unknown instead of zero', () => {
    render(<SkuFocusView data={{
      sku: { id: 'sku-a', name: '灰色人体工学枕', asin: 'B0TEST', sku: 'GRAY-01' },
      market: { id: 'market-a', name: '记忆棉枕头市场' },
      trendComparison: [],
      trendComparisonMeta: { commonBaselineDate: null, excludedSeries: [] },
      operatingMetrics: {
        estimatedSales: null,
        estimatedRevenue: null,
        price: null,
        rating: null,
        reviews: null,
        bsr: null,
        growth30d: null,
        marketGrowth30d: null,
        relativeDelta: null,
      },
      directCompetitors: [],
      insight: null,
      missingDataLabels: ['广告', '流量和转化数据'],
    }} onBack={() => undefined} />);

    expect(screen.getByText('月销量').closest('div')).toHaveTextContent('—');
    expect(screen.getByText('月销售额').closest('div')).toHaveTextContent('—');
    expect(screen.getByText('市场 30D').closest('div')).toHaveTextContent('—');
    expect(screen.getByText('进一步诊断仍需：广告、流量和转化数据')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /返回全部自有 SKU/ })).toBeInTheDocument();
  });
});
