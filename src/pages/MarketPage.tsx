import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AreaChart,
  Boxes,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Database,
  DatabaseZap,
  DollarSign,
  FileSpreadsheet,
  Layers3,
  PackageSearch,
  ShoppingBasket,
  Star,
  Store,
  Users,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MarketDetail, MarketNode, TimeRange, TrendPoint } from '../../shared/types';
import { Badge } from '../components/Badge';
import { InsightPanel } from '../components/InsightPanel';
import { MetricCard } from '../components/MetricCard';
import { Onboarding } from '../components/Onboarding';
import { EmptyState, ErrorState, PageLoading } from '../components/StateViews';
import { useApi } from '../lib/api';
import { useApp } from '../lib/AppContext';
import { hasMarketGrowthBaseline, hasTrustedMarketData } from '../lib/productData';
import {
  formatCompact,
  formatConfidence,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatDecimal,
  formatInteger,
  formatPercent,
} from '../lib/format';

type MarketTab = 'overview' | 'structure' | 'insight';
type TrendMetric = 'sales' | 'revenue' | 'avgPrice';

const timeRanges: TimeRange[] = ['7D', '30D', '90D', '180D', '1Y'];
const rangeDays: Record<TimeRange, number> = { '7D': 7, '30D': 30, '90D': 90, '180D': 180, '1Y': 365 };

const trendConfig: Record<TrendMetric, { label: string; color: string }> = {
  sales: { label: '销量', color: '#16836f' },
  revenue: { label: '销售额', color: '#2764b7' },
  avgPrice: { label: '平均售价', color: '#b46a24' },
};

function flattenNodes(nodes: MarketNode[]): MarketNode[] {
  const output: MarketNode[] = [];
  const visit = (node: MarketNode) => {
    output.push(node);
    node.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return output;
}

function ScoreBar({ value, tone = 'teal' }: { value: number | null; tone?: 'teal' | 'orange' }) {
  if (value === null) return <strong>—</strong>;
  return (
    <div className={`score-bar score-bar--${tone}`}>
      <span><i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></span>
      <strong>{value}</strong>
    </div>
  );
}

function TrendChart({ points, metric, currency }: { points: TrendPoint[]; metric: TrendMetric; currency: string }) {
  const config = trendConfig[metric];
  const formatter = (value: number | null | undefined) => metric === 'sales'
    ? formatCompact(value)
    : formatCurrency(value, currency, metric === 'revenue');
  if (!points.some((point) => typeof point[metric] === 'number' && Number.isFinite(point[metric]))) {
    return <div className="empty-state compact"><DatabaseZap size={25} aria-hidden="true" /><h3>该指标暂无数据</h3><p>当前快照未提供{config.label}，不会以零值绘制趋势。</p></div>;
  }
  return (
    <div className="chart-frame chart-frame--large" aria-label={`${config.label}历史趋势图`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 12, right: 18, left: 4, bottom: 2 }}>
          <CartesianGrid stroke="#e8eceb" strokeDasharray="3 4" vertical={false} />
          <XAxis dataKey="date" tickFormatter={(value: string) => formatDate(value)} tick={{ fill: '#73807d', fontSize: 12 }} axisLine={false} tickLine={false} minTickGap={28} />
          <YAxis tickFormatter={formatter} tick={{ fill: '#73807d', fontSize: 12 }} axisLine={false} tickLine={false} width={62} />
          <Tooltip
            labelFormatter={(value) => formatDate(String(value), 'yyyy-MM-dd')}
            formatter={(value) => [formatter(typeof value === 'number' ? value : null), config.label]}
            contentStyle={{ border: '1px solid #dfe5e3', borderRadius: 6, boxShadow: '0 10px 30px rgba(23, 38, 34, .10)' }}
          />
          <Line type="monotone" dataKey={metric} name={config.label} stroke={config.color} strokeWidth={2.5} dot={false} connectNulls={false} activeDot={{ r: 4, strokeWidth: 0 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function MarketPage() {
  const { settings, loading: settingsLoading, refreshKey } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const [range, setRange] = useState<TimeRange>('30D');
  const [tab, setTab] = useState<MarketTab>('overview');
  const [trendMetric, setTrendMetric] = useState<TrendMetric>('sales');
  const previousMarketplace = useRef(settings.marketplace);

  const marketplaceQuery = encodeURIComponent(settings.marketplace);
  const marketsQuery = useApi<MarketNode[]>(settings.mode === 'empty' ? null : `/api/markets?marketplace=${marketplaceQuery}`, refreshKey);
  const requestedMarket = searchParams.get('market');
  const selectedId = requestedMarket || settings.defaultMarketId || marketsQuery.data?.[0]?.id || '';
  const detailPath = selectedId ? `/api/markets/${encodeURIComponent(selectedId)}?range=${range}&marketplace=${marketplaceQuery}` : null;
  const detailQuery = useApi<MarketDetail>(settings.mode === 'empty' ? null : detailPath, refreshKey);

  useEffect(() => {
    if (!requestedMarket && selectedId) setSearchParams({ market: selectedId }, { replace: true });
  }, [requestedMarket, selectedId, setSearchParams]);

  useEffect(() => {
    if (previousMarketplace.current === settings.marketplace) return;
    previousMarketplace.current = settings.marketplace;
    setTab('overview');
    setSearchParams({}, { replace: true });
  }, [setSearchParams, settings.marketplace]);

  const flatTree = useMemo(() => flattenNodes(detailQuery.data?.tree ?? []), [detailQuery.data?.tree]);
  const visibleTrends = useMemo(() => {
    const trends = detailQuery.data?.trends ?? [];
    if (!trends.length) return trends;
    const latest = new Date(trends[trends.length - 1].date).getTime();
    const threshold = latest - rangeDays[range] * 24 * 60 * 60 * 1000;
    const filtered = trends.filter((point) => new Date(point.date).getTime() >= threshold);
    return filtered.length >= 2 ? filtered : trends.slice(-2);
  }, [detailQuery.data?.trends, range]);

  if (settingsLoading) return <PageLoading label="正在检查市场数据源" />;
  if (settings.mode === 'empty') return <Onboarding />;
  if ((marketsQuery.loading || detailQuery.loading) && !detailQuery.data) return <PageLoading label="正在读取市场历史快照" />;
  if ((marketsQuery.error || detailQuery.error) && !detailQuery.data) {
    return (
      <ErrorState
        error={marketsQuery.error ?? detailQuery.error}
        onRetry={() => { marketsQuery.reload(); detailQuery.reload(); }}
        lastSuccessfulSync={settings.lastSuccessfulSync}
      />
    );
  }
  if (!marketsQuery.data?.length) {
    return <EmptyState title="尚未建立市场" description="连接数据源或导入市场文件后，系统会自动生成可扩展的 MarketNode 市场树。" />;
  }
  if (!detailQuery.data) return null;

  const detail = detailQuery.data;
  const { kpis, node, provenance } = detail;
  const hasTrustedData = hasTrustedMarketData(detail);
  const hasGrowthBaseline = hasMarketGrowthBaseline(detail);

  const selectMarket = (id: string) => {
    setSearchParams({ market: id });
    setTab('overview');
  };

  return (
    <div className="page-stack market-page">
      {detailQuery.error ? <ErrorState compact error={detailQuery.error} onRetry={detailQuery.reload} lastSuccessfulSync={settings.lastSuccessfulSync} /> : null}

      <section className="page-heading page-heading--market">
        <div>
          <span className="eyebrow">EXISTING BUSINESS · MARKET INTELLIGENCE</span>
          <div className="market-title-row">
            <h1>{node.name}</h1>
            <Badge tone={hasGrowthBaseline && node.growth30d !== null ? node.growth30d >= 5 ? 'positive' : node.growth30d < 0 ? 'warning' : 'neutral' : 'warning'}>{!hasTrustedData ? '尚无快照' : hasGrowthBaseline ? node.status : '基线不足'}</Badge>
          </div>
          <div className="breadcrumb" aria-label="市场层级">
            {detail.path.map((item, index) => (
              <span key={item.id}>{index ? <i>/</i> : null}{item.name}</span>
            ))}
          </div>
        </div>
        <div className="market-filters">
          <label className="field-control field-control--select">
            <span>当前市场</span>
            <select value={selectedId} onChange={(event) => selectMarket(event.target.value)}>
              {marketsQuery.data.map((market) => <option value={market.id} key={market.id}>{market.name}</option>)}
            </select>
            <ChevronDown size={15} aria-hidden="true" />
          </label>
          <div className="segmented-control" aria-label="时间范围">
            {timeRanges.map((item) => (
              <button className={range === item ? 'is-active' : ''} type="button" key={item} onClick={() => setRange(item)}>{item}</button>
            ))}
          </div>
        </div>
      </section>

      {hasTrustedData ? <div className="source-strip">
        <span><Database size={15} aria-hidden="true" />{provenance.source}</span>
        <span><Clock3 size={15} aria-hidden="true" />采集于 {formatDateTime(provenance.collectedAt)}</span>
        <span>周期 {provenance.period}</span>
        {provenance.isEstimated ? <Badge tone="warning">估算数据</Badge> : <Badge tone="positive">原始数据</Badge>}
        <span>可信度 {formatConfidence(provenance.confidence)}</span>
      </div> : <div className="source-strip source-strip--pending"><span><DatabaseZap size={15} aria-hidden="true" />尚无市场快照</span><Badge tone="warning">待补数据</Badge></div>}

      {!hasTrustedData ? (
        <>
          <section className="snapshot-required" role="status">
            <span className="snapshot-required__icon"><DatabaseZap size={25} aria-hidden="true" /></span>
            <div>
              <span className="eyebrow">MARKET DATA REQUIRED</span>
              <h2>尚无市场快照</h2>
              <p>该市场节点已建立，但还没有可用于观察的销量、价格或竞争结构数据。系统不会把默认零值当成市场结论。</p>
              <small>导入当前站点的市场报表后，KPI、趋势与结构分析会自动出现。</small>
            </div>
            <div className="snapshot-required__actions">
              <Link className="button button--primary" to="/settings?tab=import"><FileSpreadsheet size={16} aria-hidden="true" />导入市场快照</Link>
              <Link className="button button--secondary" to="/settings?tab=sources">配置数据源</Link>
            </div>
          </section>
          <InsightPanel insight={detail.insight} title="AI 市场判断" />
        </>
      ) : null}

      {hasTrustedData ? <>

      <nav className="page-tabs" aria-label="市场分析视图">
        <button type="button" className={tab === 'overview' ? 'is-active' : ''} onClick={() => setTab('overview')}>市场概览</button>
        <button type="button" className={tab === 'structure' ? 'is-active' : ''} onClick={() => setTab('structure')}>竞争结构</button>
        <button type="button" className={tab === 'insight' ? 'is-active' : ''} onClick={() => setTab('insight')}>AI 判断 <span>{detail.insight.status === '数据不足' ? '—' : detail.insight.score ?? '—'}</span></button>
      </nav>

      {tab === 'overview' ? (
        <>
          <section>
            <header className="section-header">
              <div><span className="eyebrow">MARKET KPI</span><h2>市场基本盘</h2></div>
              <span className="section-header__note">月度口径 · {range} 观察窗</span>
            </header>
            <div className="metric-grid metric-grid--six">
              <MetricCard label="月销量" value={formatInteger(kpis.monthlySales)} trend={hasGrowthBaseline && node.growth30d !== null ? node.growth30d : undefined} detail={hasGrowthBaseline ? '30 天' : '单期快照'} icon={ShoppingBasket} tone="positive" />
              <MetricCard label="月销售额" value={formatCurrency(kpis.monthlyRevenue, settings.currency, true)} icon={DollarSign} />
              <MetricCard label="产品数" value={formatInteger(kpis.productCount)} detail={`${formatInteger(kpis.sellerCount)} 个卖家`} icon={Boxes} />
              <MetricCard label="品牌数" value={formatInteger(kpis.brandCount)} icon={Store} />
              <MetricCard label="平均售价" value={formatCurrency(kpis.avgPrice, settings.currency)} detail={`中位 ${formatCurrency(kpis.medianPrice, settings.currency)}`} icon={CircleDollarSign} />
              <MetricCard label="平均 Rating" value={formatDecimal(kpis.avgRating)} detail={`Review 中位 ${formatInteger(kpis.medianReviews)}`} icon={Star} />
              <MetricCard label="TOP10 销量占比" value={formatPercent(kpis.top10Share, false)} icon={Layers3} tone={kpis.top10Share !== null && kpis.top10Share > 50 ? 'warning' : 'default'} />
              <MetricCard label="TOP20 销量占比" value={formatPercent(kpis.top20Share, false)} icon={Users} />
              <MetricCard label="新品占比" value={formatPercent(kpis.newProductShare, false)} icon={PackageSearch} tone="positive" />
            </div>
          </section>

          <section className="analysis-section">
            <header className="section-header">
              <div><span className="eyebrow">HISTORICAL SNAPSHOTS</span><h2>历史趋势</h2></div>
              <div className="segmented-control segmented-control--compact" aria-label="趋势指标">
                {(Object.keys(trendConfig) as TrendMetric[]).map((metric) => (
                  <button className={trendMetric === metric ? 'is-active' : ''} type="button" key={metric} onClick={() => setTrendMetric(metric)}>{trendConfig[metric].label}</button>
                ))}
              </div>
            </header>
            <TrendChart points={visibleTrends} metric={trendMetric} currency={settings.currency} />
            <div className="trend-context-row">
              <div><span>新品数量</span><strong>{formatInteger(detail.trends.at(-1)?.productCount)}</strong></div>
              <div><span>卖家数量</span><strong>{formatInteger(detail.trends.at(-1)?.sellerCount)}</strong></div>
              <div><span>Review 门槛</span><strong>{formatInteger(detail.trends.at(-1)?.medianReviews)}</strong></div>
              <div><span>30D 增长</span><strong className={hasGrowthBaseline && node.growth30d !== null ? node.growth30d >= 0 ? 'text-positive' : 'text-critical' : ''}>{hasGrowthBaseline ? formatPercent(node.growth30d) : '—'}</strong><small>{hasGrowthBaseline ? '' : '基线不足'}</small></div>
            </div>
          </section>
        </>
      ) : null}

      {tab === 'structure' ? (
        <div className="structure-stack">
          <section className="analysis-section">
            <header className="section-header">
              <div><span className="eyebrow">MARKET TREE</span><h2>细分市场树</h2></div>
              <span className="section-header__note">点击市场名称切换分析对象</span>
            </header>
            <div className="table-scroll">
              <table className="data-table market-tree-table">
                <thead><tr><th>细分市场</th><th>月销量</th><th>30D 增长</th><th>产品数</th><th>均价</th><th>竞争评分</th><th>机会评分</th></tr></thead>
                <tbody>
                  {flatTree.map((market) => (
                    <tr key={market.id} className={market.id === node.id ? 'is-selected' : ''}>
                      <td><button type="button" onClick={() => selectMarket(market.id)} style={{ paddingLeft: `${Math.max(0, market.level - 1) * 18}px` }}><span className="tree-node-mark" />{market.name}</button></td>
                      <td>{formatInteger(market.monthlySales)}</td>
                      <td className={market.growth30dAvailable && market.growth30d !== null ? market.growth30d >= 0 ? 'text-positive' : 'text-critical' : ''}>{market.growth30dAvailable ? formatPercent(market.growth30d) : '—'}</td>
                      <td>{formatInteger(market.productCount)}</td>
                      <td>{formatCurrency(market.avgPrice, settings.currency)}</td>
                      <td><ScoreBar value={market.competitionScore} tone="orange" /></td>
                      <td><ScoreBar value={market.opportunityScore} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="two-column-analysis">
            <section className="analysis-section">
              <header className="section-header"><div><span className="eyebrow">PRICE BANDS</span><h2>价格带机会</h2></div></header>
              <div className="chart-frame chart-frame--medium">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={detail.priceBands} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#e8eceb" strokeDasharray="3 4" vertical={false} />
                    <XAxis dataKey="label" tick={{ fill: '#73807d', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={formatCompact} tick={{ fill: '#73807d', fontSize: 11 }} axisLine={false} tickLine={false} width={46} />
                    <Tooltip formatter={(value) => [formatInteger(Number(value)), '月销量']} contentStyle={{ border: '1px solid #dfe5e3', borderRadius: 6 }} />
                    <Bar dataKey="monthlySales" radius={[3, 3, 0, 0]}>
                      {detail.priceBands.map((band) => <Cell key={band.label} fill={band.growth >= 0 ? '#16836f' : '#c4504c'} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="compact-table-wrap">
                <table className="data-table data-table--compact">
                  <thead><tr><th>价格带</th><th>产品</th><th>销量</th><th>新品</th><th>增长</th></tr></thead>
                  <tbody>{detail.priceBands.map((band) => <tr key={band.label}><td><strong>{band.label}</strong></td><td>{band.productCount}</td><td>{formatCompact(band.monthlySales)}</td><td>{band.newProducts}</td><td className={hasGrowthBaseline ? band.growth >= 0 ? 'text-positive' : 'text-critical' : ''}>{hasGrowthBaseline ? formatPercent(band.growth) : '—'}</td></tr>)}</tbody>
                </table>
              </div>
            </section>

            <section className="analysis-section">
              <header className="section-header"><div><span className="eyebrow">CONCENTRATION</span><h2>头部集中度</h2></div></header>
              <div className="concentration-list">
                {detail.concentration.map((tier, index) => (
                  <div className="concentration-row" key={tier.tier}>
                    <div><strong>{tier.tier}</strong><span>均价 {formatCurrency(tier.avgPrice, settings.currency)} · 均销量 {formatInteger(tier.avgSales)}</span></div>
                    <div className="concentration-track"><span style={{ width: `${Math.min(tier.share, 100)}%`, backgroundColor: ['#1c7765', '#377caa', '#b17635', '#777c79'][index % 4] }} /></div>
                    <strong>{formatPercent(tier.share, false)}</strong>
                  </div>
                ))}
              </div>
              <div className="structure-note">
                <AreaChart size={18} aria-hidden="true" />
                <p><strong>如何解读</strong>集中度越高，头部品牌对流量和定价的控制越强；应结合新品占比与 Review 门槛判断进入窗口。</p>
              </div>
            </section>
          </div>
        </div>
      ) : null}

      {tab === 'insight' ? (
        <>
          <InsightPanel insight={detail.insight} title="AI 市场判断" />
          <section className="fact-ledger">
            <header className="section-header"><div><span className="eyebrow">VERIFIED FACTS</span><h2>本次判断使用的事实</h2></div></header>
            <ol>{detail.insight.facts.map((fact, index) => <li key={fact}><span>{String(index + 1).padStart(2, '0')}</span><p>{fact}</p></li>)}</ol>
          </section>
        </>
      ) : null}
      </> : null}
    </div>
  );
}
