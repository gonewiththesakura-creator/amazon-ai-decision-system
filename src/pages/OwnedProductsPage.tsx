import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  ChartNoAxesCombined,
  ChevronLeft,
  ChevronRight,
  Clock3,
  DatabaseZap,
  FileSpreadsheet,
  Filter,
  Gauge,
  LoaderCircle,
  Plus,
  PackagePlus,
  RefreshCw,
  Trash2,
  Search,
  ShieldAlert,
  Star,
  Users,
  X,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  Competitor,
  OwnedProductDetail,
  OwnedProductSummary,
  RelationType,
} from '../../shared/types';
import { Badge } from '../components/Badge';
import CompetitorCandidateReview from '../components/CompetitorCandidateReview';
import { EvidenceDrawer } from '../components/EvidenceDrawer';
import { InsightPanel } from '../components/InsightPanel';
import { Onboarding } from '../components/Onboarding';
import { ProductImage } from '../components/ProductImage';
import { EmptyState, ErrorState, PageLoading } from '../components/StateViews';
import { api, useApi } from '../lib/api';
import { useApp } from '../lib/AppContext';
import {
  formatCompact,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatDecimal,
  formatInteger,
  formatPercent,
  truncate,
} from '../lib/format';
import { performanceMeta } from '../lib/status';
import { compareNullableMetric, hasTrustedRelativePerformance } from '../lib/productData';

type ProductTab = 'performance' | 'competitors' | 'diagnosis';
type RelationFilter = 'all' | RelationType;
type GrowthFilter = 'all' | 'growing' | 'declining';
type SortKey = 'sales' | 'growth' | 'price' | 'reviews' | 'similarity';

const PORTFOLIO_PAGE_SIZE = 12;

interface CompetitorForm {
  asin: string;
  brand: string;
  title: string;
  relationType: RelationType;
  similarityScore: string;
  reason: string;
}

const emptyCompetitorForm: CompetitorForm = {
  asin: '', brand: '', title: '', relationType: 'direct', similarityScore: '', reason: '',
};

const relationOptions: Array<{ value: RelationFilter; label: string }> = [
  { value: 'all', label: '全部竞品' },
  { value: 'direct', label: '直接竞品' },
  { value: 'price_peer', label: '同价竞品' },
  { value: 'top100', label: 'TOP100' },
  { value: 'benchmark', label: '头部标杆' },
  { value: 'fast_growth', label: '快速增长' },
];

const relationLabels: Record<RelationType, string> = {
  direct: '直接竞品',
  price_peer: '同价竞品',
  top100: 'TOP100',
  benchmark: '头部标杆',
  fast_growth: '快速增长',
};

function PercentileRow({ label, value, inverse = false }: { label: string; value: number | null; inverse?: boolean }) {
  if (value === null) {
    return <div className="percentile-row"><div><span>{label}</span><strong>—</strong></div></div>;
  }
  const normalized = Math.max(0, Math.min(100, value));
  const good = inverse ? normalized <= 50 : normalized >= 60;
  return (
    <div className="percentile-row">
      <div><span>{label}</span><strong className={good ? 'text-positive' : ''}>P{Math.round(normalized)}</strong></div>
      <div className="percentile-track"><span style={{ width: `${normalized}%` }} /><i style={{ left: `${normalized}%` }} /></div>
    </div>
  );
}

function SkuSelector({ product, active }: { product: OwnedProductSummary; active: boolean }) {
  const performance = performanceMeta[product.performance];
  const hasTrustedData = hasTrustedRelativePerformance(product);
  const hasProductData = product.latest.snapshotAvailable;
  const pendingReason = !hasProductData
    ? '等待产品与市场快照'
    : !product.latest.growth30dAvailable
      ? '等待 SKU 30D 对照快照'
      : '等待市场 30D 对照快照';
  return (
    <Link className={`sku-selector ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined} to={`/owned-products/${product.id}`}>
      <div className="sku-selector__top">
        <ProductImage src={product.imageUrl} alt={product.title} size="md" />
        <div>
          <span>{product.sku ?? product.asin}</span>
          <strong>{product.internalName ?? truncate(product.title, 26)}</strong>
        </div>
        <Badge tone={hasTrustedData ? performance.tone : 'warning'}>{hasTrustedData ? performance.label : hasProductData ? '基线不足' : '待补数据'}</Badge>
      </div>
      <div className="sku-selector__metrics">
        <span><small>月销量</small><strong>{hasProductData ? formatInteger(product.latest.estimatedSales) : '—'}</strong></span>
        <span><small>SKU 30D</small><strong className={hasTrustedData ? product.latest.growth30d >= 0 ? 'text-positive' : 'text-critical' : ''}>{hasTrustedData ? formatPercent(product.latest.growth30d) : '—'}</strong></span>
        <span><small>相对市场</small><strong className={hasTrustedData ? product.relativeDelta >= 0 ? 'text-positive' : 'text-critical' : ''}>{hasTrustedData ? formatPercent(product.relativeDelta) : '—'}</strong></span>
      </div>
      {!hasTrustedData ? <span className="sku-pending"><DatabaseZap size={13} aria-hidden="true" />{pendingReason}</span> : product.anomalyCount ? <span className="sku-anomaly"><ShieldAlert size={13} aria-hidden="true" />{product.anomalyCount} 项异常</span> : <span className="sku-stable">暂无异常</span>}
    </Link>
  );
}

function sortValue(competitor: Competitor, key: SortKey): number | null {
  if (key === 'sales') return competitor.latest.estimatedSales;
  if (key === 'growth') return competitor.latest.growth30dAvailable ? competitor.latest.growth30d : null;
  if (key === 'price') return competitor.latest.price;
  if (key === 'reviews') return competitor.latest.reviewCount;
  return competitor.similarityScore;
}

function SortButton({ label, value, active, descending, onClick }: { label: string; value: SortKey; active: SortKey; descending: boolean; onClick: (value: SortKey) => void }) {
  return (
    <button type="button" className="table-sort" onClick={() => onClick(value)}>
      {label}
      {active === value ? descending ? <ArrowDown size={13} aria-hidden="true" /> : <ArrowUp size={13} aria-hidden="true" /> : <ArrowUpDown size={13} aria-hidden="true" />}
    </button>
  );
}

function CompetitorTable({
  competitors,
  currency,
  canEdit,
  updatingId,
  initialQuery,
  focusCompetitorId,
  onReclassify,
  onRemove,
  onSync,
}: {
  competitors: Competitor[];
  currency: string;
  canEdit: boolean;
  updatingId: string | null;
  initialQuery?: string;
  focusCompetitorId?: string;
  onReclassify: (competitor: Competitor, relationType: RelationType) => void;
  onRemove: (competitor: Competitor) => void;
  onSync: (competitor: Competitor) => void;
}) {
  const [relation, setRelation] = useState<RelationFilter>('all');
  const [growth, setGrowth] = useState<GrowthFilter>('all');
  const [query, setQuery] = useState(initialQuery ?? '');
  const [sortKey, setSortKey] = useState<SortKey>('sales');
  const [descending, setDescending] = useState(true);
  const handledDeepLinkRef = useRef<string | null>(null);

  useEffect(() => {
    setQuery(initialQuery ?? '');
    if (focusCompetitorId) {
      setRelation('all');
      setGrowth('all');
    }
  }, [focusCompetitorId, initialQuery]);

  const counts = useMemo(() => {
    const result: Record<RelationFilter, number> = { all: competitors.length, direct: 0, price_peer: 0, top100: 0, benchmark: 0, fast_growth: 0 };
    competitors.forEach((item) => { result[item.relationType] += 1; });
    return result;
  }, [competitors]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return competitors
      .filter((item) => relation === 'all' || item.relationType === relation)
      .filter((item) => growth === 'all' || (item.latest.growth30dAvailable && item.latest.growth30d !== null
        && (growth === 'growing' ? item.latest.growth30d > 0 : item.latest.growth30d < 0)))
      .filter((item) => !normalizedQuery || `${item.asin} ${item.brand} ${item.title}`.toLowerCase().includes(normalizedQuery))
      .sort((a, b) => compareNullableMetric(
        sortValue(a, sortKey),
        sortValue(b, sortKey),
        descending,
      ) || a.asin.localeCompare(b.asin));
  }, [competitors, descending, growth, query, relation, sortKey]);

  useEffect(() => {
    if (!focusCompetitorId) handledDeepLinkRef.current = null;
  }, [focusCompetitorId]);

  const handleDeepLinkTarget = useCallback((target: HTMLElement | null) => {
    if (!target || !focusCompetitorId || handledDeepLinkRef.current === focusCompetitorId) return;

    handledDeepLinkRef.current = focusCompetitorId;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'center',
      inline: 'nearest',
    });
  }, [focusCompetitorId]);

  const hasDeepLinkCompetitor = Boolean(
    focusCompetitorId && competitors.some((item) => item.id === focusCompetitorId),
  );

  const changeSort = (key: SortKey) => {
    if (key === sortKey) setDescending((value) => !value);
    else { setSortKey(key); setDescending(true); }
  };

  return (
    <section
      ref={focusCompetitorId && !hasDeepLinkCompetitor ? handleDeepLinkTarget : undefined}
      className="competitor-section"
      aria-label="竞品筛选与列表"
      tabIndex={-1}
    >
      <div className="relation-tabs" aria-label="竞品分组">
        {relationOptions.map((option) => (
          <button type="button" key={option.value} className={relation === option.value ? 'is-active' : ''} onClick={() => setRelation(option.value)}>
            {option.label}<span>{counts[option.value]}</span>
          </button>
        ))}
      </div>

      <div className="table-toolbar">
        <label className="search-control">
          <Search size={16} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 ASIN、品牌或标题" aria-label="搜索竞品" />
        </label>
        <label className="field-control field-control--inline">
          <Filter size={15} aria-hidden="true" />
          <select value={growth} onChange={(event) => setGrowth(event.target.value as GrowthFilter)} aria-label="按增长筛选">
            <option value="all">全部增长</option>
            <option value="growing">30D 增长</option>
            <option value="declining">30D 下滑</option>
          </select>
        </label>
        <span className="table-count">显示 {filtered.length} / {competitors.length}</span>
      </div>

      {filtered.length ? (
        <div className="table-scroll competitor-table-wrap">
          <table className="data-table competitor-table">
            <thead>
              <tr>
                <th>产品 / ASIN</th><th>竞品组</th>
                <th><SortButton label="价格" value="price" active={sortKey} descending={descending} onClick={changeSort} /></th>
                <th>Rating / Review</th><th>BSR</th>
                <th><SortButton label="月销量" value="sales" active={sortKey} descending={descending} onClick={changeSort} /></th>
                <th>月销售额</th><th>7D</th>
                <th><SortButton label="30D" value="growth" active={sortKey} descending={descending} onClick={changeSort} /></th>
                <th>90D</th><th><SortButton label="相似度" value="similarity" active={sortKey} descending={descending} onClick={changeSort} /></th><th>AI 标签</th>{canEdit ? <th><span className="visually-hidden">管理</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => {
                const isDeepLinkTarget = item.id === focusCompetitorId;
                return (
                  <tr
                    key={`${item.id}:${item.relationType}`}
                    ref={isDeepLinkTarget ? handleDeepLinkTarget : undefined}
                    aria-current={isDeepLinkTarget ? 'true' : undefined}
                    tabIndex={isDeepLinkTarget ? -1 : undefined}
                  >
                  <td>
                    <div className="product-cell">
                      <ProductImage src={item.imageUrl} alt={item.title} size="sm" />
                      <div><strong>{item.brand}</strong><span title={item.title}>{truncate(item.title, 34)}</span><small>{item.asin}</small></div>
                    </div>
                  </td>
                  <td><Badge tone={item.relationType === 'direct' ? 'info' : item.relationType === 'fast_growth' ? 'positive' : 'neutral'}>{relationLabels[item.relationType]}</Badge></td>
                  <td>{item.latest.snapshotAvailable ? formatCurrency(item.latest.price, currency) : '—'}</td>
                  <td>{item.latest.snapshotAvailable ? <span className="rating-cell">{item.latest.rating !== null ? <Star size={13} fill="currentColor" aria-hidden="true" /> : null}{formatDecimal(item.latest.rating)} <small>({formatCompact(item.latest.reviewCount)})</small></span> : <Badge tone="warning">待补数据</Badge>}</td>
                  <td>{item.latest.bsr !== null ? `#${formatInteger(item.latest.bsr)}` : '—'}</td>
                  <td><strong>{formatInteger(item.latest.estimatedSales)}</strong></td>
                  <td>{formatCurrency(item.latest.estimatedRevenue, currency, true)}</td>
                  <td className={item.latest.growth7d !== null ? item.latest.growth7d >= 0 ? 'text-positive' : 'text-critical' : ''}>{formatPercent(item.latest.growth7d)}</td>
                  <td className={item.latest.growth30dAvailable && item.latest.growth30d !== null ? item.latest.growth30d >= 0 ? 'text-positive' : 'text-critical' : ''}><strong>{item.latest.growth30dAvailable ? formatPercent(item.latest.growth30d) : '—'}</strong></td>
                  <td className={item.latest.growth90d !== null ? item.latest.growth90d >= 0 ? 'text-positive' : 'text-critical' : ''}>{formatPercent(item.latest.growth90d)}</td>
                  <td><span className="similarity-value">{Math.round(item.similarityScore)}%</span></td>
                  <td><div className="tag-list">{item.aiTags.slice(0, 2).map((tag) => <span key={tag}>{tag}</span>)}</div></td>
                  {canEdit ? <td><div className="competitor-row-actions"><select aria-label={`调整 ${item.asin} 竞品分组`} value={item.relationType} disabled={updatingId !== null} onChange={(event) => onReclassify(item, event.target.value as RelationType)}>{relationOptions.filter((option) => option.value !== 'all').map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><button className="icon-button" type="button" aria-label={`同步竞品 ${item.asin}`} title="从 SellerSprite 同步已确认竞品" disabled={updatingId !== null} onClick={() => onSync(item)}>{updatingId === `sync:${item.id}` ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}</button><button className="icon-button" type="button" aria-label={`移除竞品 ${item.asin}`} title="移除竞品关系" disabled={updatingId !== null} onClick={() => onRemove(item)}>{updatingId === `${item.id}:${item.relationType}` ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}</button></div></td> : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="没有符合条件的竞品" description="调整竞品分组、增长条件或搜索关键词后重试。" />
      )}
    </section>
  );
}

export default function OwnedProductsPage() {
  const { productId } = useParams<{ productId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { settings, loading: settingsLoading, refreshKey } = useApp();
  const previousMarketplace = useRef(settings.marketplace);
  const [tab, setTab] = useState<ProductTab>('performance');
  const [showCompetitorForm, setShowCompetitorForm] = useState(false);
  const [competitorForm, setCompetitorForm] = useState<CompetitorForm>(emptyCompetitorForm);
  const [competitorSaving, setCompetitorSaving] = useState(false);
  const [competitorUpdatingId, setCompetitorUpdatingId] = useState<string | null>(null);
  const [competitorError, setCompetitorError] = useState<string | null>(null);
  const [portfolioQuery, setPortfolioQuery] = useState('');
  const [portfolioPage, setPortfolioPage] = useState(1);
  const marketplaceQuery = encodeURIComponent(settings.marketplace);
  const listQuery = useApi<OwnedProductSummary[]>(`/api/owned-products?marketplace=${marketplaceQuery}`, refreshKey);
  const selectedId = productId || listQuery.data?.[0]?.id || '';
  const requestedTab = searchParams.get('tab');
  const requestedCompetitorId = searchParams.get('competitor');
  const detailQuery = useApi<OwnedProductDetail>(selectedId ? `/api/owned-products/${encodeURIComponent(selectedId)}?marketplace=${marketplaceQuery}` : null, refreshKey);

  useEffect(() => {
    if (portfolioQuery.trim()) return;
    const index = listQuery.data?.findIndex((product) => product.id === selectedId) ?? -1;
    if (index >= 0) setPortfolioPage(Math.floor(index / PORTFOLIO_PAGE_SIZE) + 1);
  }, [listQuery.data, portfolioQuery, selectedId]);

  useEffect(() => {
    if (!productId && selectedId) navigate(`/owned-products/${selectedId}`, { replace: true });
  }, [navigate, productId, selectedId]);

  useEffect(() => {
    setTab(requestedTab === 'competitors' || requestedTab === 'diagnosis' ? requestedTab : 'performance');
  }, [requestedTab, selectedId]);

  useEffect(() => {
    if (previousMarketplace.current === settings.marketplace) return;
    previousMarketplace.current = settings.marketplace;
    setShowCompetitorForm(false);
    setCompetitorError(null);
    navigate('/owned-products', { replace: true });
  }, [navigate, settings.marketplace]);

  useEffect(() => {
    if (!showCompetitorForm) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !competitorSaving) setShowCompetitorForm(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [competitorSaving, showCompetitorForm]);

  if (settingsLoading) return <PageLoading label="正在检查自有产品数据" />;
  if ((listQuery.loading || detailQuery.loading) && !detailQuery.data) return <PageLoading label="正在建立 SKU 与市场对照" />;
  if ((listQuery.error || detailQuery.error) && !detailQuery.data) {
    return <ErrorState error={listQuery.error ?? detailQuery.error} onRetry={() => { listQuery.reload(); detailQuery.reload(); }} lastSuccessfulSync={settings.lastSuccessfulSync} />;
  }
  if (!listQuery.data?.length) {
    if (settings.mode === 'empty') return <Onboarding />;
    return (
      <EmptyState
        title="尚未录入自有 SKU"
        description="先添加 ASIN、所属市场与主要关键词，系统才能建立相对市场表现和竞品关系。"
        action={<Link className="button button--primary" to="/settings?tab=products"><PackagePlus size={16} aria-hidden="true" />添加自有产品</Link>}
      />
    );
  }
  if (!detailQuery.data) return null;

  const detail = detailQuery.data;
  const normalizedPortfolioQuery = portfolioQuery.trim().toLocaleLowerCase();
  const filteredPortfolio = listQuery.data.filter((product) => (
    !normalizedPortfolioQuery
    || [product.sku, product.asin, product.internalName, product.brand, product.title]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedPortfolioQuery)
  ));
  const portfolioPageCount = Math.max(1, Math.ceil(filteredPortfolio.length / PORTFOLIO_PAGE_SIZE));
  const safePortfolioPage = Math.min(portfolioPage, portfolioPageCount);
  const visiblePortfolio = filteredPortfolio.slice(
    (safePortfolioPage - 1) * PORTFOLIO_PAGE_SIZE,
    safePortfolioPage * PORTFOLIO_PAGE_SIZE,
  );
  const performance = performanceMeta[detail.performance];
  const hasTrustedData = hasTrustedRelativePerformance(detail, detail.snapshots);
  const hasProductData = detail.latest.snapshotAvailable
    && detail.snapshots.some((snapshot) => snapshot.snapshotAvailable);
  const needsProductGrowthBaseline = hasProductData && !detail.latest.growth30dAvailable;
  const comparisonData = [
    { name: detail.sku ?? '当前 SKU', growth: detail.latest.growth30d, own: true },
    { name: '所属市场', growth: detail.comparisons.market.growth30d, own: false },
    ...(detail.comparisons.direct.sampleSize > 0
      ? [{ name: `直接竞品均值（n=${detail.comparisons.direct.sampleSize}）`, growth: detail.comparisons.direct.growth30d, own: false }]
      : []),
    ...(detail.comparisons.top20.sampleSize > 0 ? [{
      name: detail.comparisons.top20.sampleSize === 20
        ? 'TOP20 均值（n=20）'
        : `头部样本均值（n=${detail.comparisons.top20.sampleSize}）`,
      growth: detail.comparisons.top20.growth30d,
      own: false,
    }] : []),
  ].filter((item): item is { name: string; growth: number; own: boolean } => (
    typeof item.growth === 'number' && Number.isFinite(item.growth)
  ));

  const addCompetitor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCompetitorSaving(true);
    setCompetitorError(null);
    try {
      await api.post(`/api/owned-products/${encodeURIComponent(detail.id)}/competitors`, {
        asin: competitorForm.asin.trim().toUpperCase(),
        brand: competitorForm.brand.trim() || undefined,
        title: competitorForm.title.trim() || undefined,
        relationType: competitorForm.relationType,
        similarityScore: competitorForm.similarityScore ? Number(competitorForm.similarityScore) : undefined,
        reason: competitorForm.reason.trim() || undefined,
        aiTags: [relationLabels[competitorForm.relationType]],
      });
      setCompetitorForm(emptyCompetitorForm);
      setShowCompetitorForm(false);
      detailQuery.reload();
    } catch (requestError) {
      setCompetitorError(requestError instanceof Error ? requestError.message : '竞品添加失败');
    } finally {
      setCompetitorSaving(false);
    }
  };

  const reclassifyCompetitor = async (competitor: Competitor, relationType: RelationType) => {
    if (relationType === competitor.relationType) return;
    const actionId = `${competitor.id}:${competitor.relationType}`;
    setCompetitorUpdatingId(actionId);
    setCompetitorError(null);
    try {
      await api.patch(`/api/owned-products/${encodeURIComponent(detail.id)}/competitors/${encodeURIComponent(competitor.id)}`, {
        currentRelationType: competitor.relationType,
        relationType,
      });
      detailQuery.reload();
    } catch (requestError) {
      setCompetitorError(requestError instanceof Error ? requestError.message : '竞品分组更新失败');
    } finally {
      setCompetitorUpdatingId(null);
    }
  };

  const removeCompetitor = async (competitor: Competitor) => {
    if (!window.confirm(`确认移除 ${competitor.asin} 的“${relationLabels[competitor.relationType]}”关系？产品历史快照不会被删除。`)) return;
    const actionId = `${competitor.id}:${competitor.relationType}`;
    setCompetitorUpdatingId(actionId);
    setCompetitorError(null);
    try {
      await api.delete(`/api/owned-products/${encodeURIComponent(detail.id)}/competitors/${encodeURIComponent(competitor.id)}?relationType=${competitor.relationType}`);
      detailQuery.reload();
    } catch (requestError) {
      setCompetitorError(requestError instanceof Error ? requestError.message : '竞品关系移除失败');
    } finally {
      setCompetitorUpdatingId(null);
    }
  };

  const syncCompetitor = async (competitor: Competitor) => {
    setCompetitorUpdatingId(`sync:${competitor.id}`);
    setCompetitorError(null);
    try {
      await api.post('/api/integrations/sellersprite/sync/competitor', {
        ownedProductId: detail.id,
        competitorProductId: competitor.id,
      });
      detailQuery.reload();
    } catch (requestError) {
      setCompetitorError(requestError instanceof Error ? requestError.message : '竞品同步失败');
    } finally { setCompetitorUpdatingId(null); }
  };

  return (
    <div className="page-stack owned-products-page">
      {detailQuery.error ? <ErrorState compact error={detailQuery.error} onRetry={detailQuery.reload} lastSuccessfulSync={settings.lastSuccessfulSync} /> : null}

      <section className="page-heading page-heading--compact">
        <div>
          <span className="eyebrow">OWNED BUSINESS · WAR ROOM</span>
          <h1>自有 SKU 相对市场表现</h1>
          <p>不要只看绝对涨跌；先判断每个 SKU 是否跑赢它所在的市场。</p>
        </div>
        <Badge tone={listQuery.data.length > 0 ? 'positive' : 'warning'}>{listQuery.data.length} 个产品</Badge>
      </section>

      <div className="toolbar portfolio-toolbar">
        <label className="search-field">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索自有 SKU"
            placeholder="搜索 SKU、ASIN 或产品名"
            value={portfolioQuery}
            onChange={(event) => {
              setPortfolioQuery(event.target.value);
              setPortfolioPage(1);
            }}
          />
        </label>
        <span className="result-count" role="status" aria-live="polite">显示 {filteredPortfolio.length} / {listQuery.data.length}</span>
        {portfolioPageCount > 1 ? (
          <nav className="portfolio-pagination" aria-label="自有 SKU 分页">
            <button className="icon-button" type="button" aria-label="上一页" disabled={safePortfolioPage === 1} onClick={() => setPortfolioPage((page) => Math.max(1, page - 1))}><ChevronLeft size={16} /></button>
            <span role="status" aria-live="polite" aria-label="自有 SKU 分页状态">{safePortfolioPage} / {portfolioPageCount}</span>
            <button className="icon-button" type="button" aria-label="下一页" disabled={safePortfolioPage === portfolioPageCount} onClick={() => setPortfolioPage((page) => Math.min(portfolioPageCount, page + 1))}><ChevronRight size={16} /></button>
          </nav>
        ) : null}
      </div>
      <nav className="sku-selector-grid" aria-label="选择自有 SKU">
        {visiblePortfolio.map((product) => <SkuSelector key={product.id} product={product} active={product.id === detail.id} />)}
      </nav>

      <section className="product-identity-band">
        <ProductImage src={detail.imageUrl} alt={detail.title} size="lg" />
        <div className="product-identity-band__main">
          <div className="product-identity-band__title">
            <div><span>{detail.sku} · {detail.asin}</span><h2>{detail.internalName ?? detail.title}</h2></div>
            <Badge tone={hasTrustedData ? performance.tone : 'warning'}>{hasTrustedData ? performance.label : hasProductData ? '基线不足' : '数据不足'}</Badge>
          </div>
          <p>{detail.title}</p>
          <div className="breadcrumb">{detail.marketPath?.map((item, index) => <span key={item.id}>{index ? <i>/</i> : null}{item.name}</span>)}</div>
        </div>
        <div className="product-identity-band__stats">
          <div><span>价格</span><strong>{hasProductData ? formatCurrency(detail.latest.price, settings.currency) : '—'}</strong></div>
          <div><span>Rating</span><strong>{hasProductData ? <>{formatDecimal(detail.latest.rating)} <Star size={13} fill="currentColor" aria-hidden="true" /></> : '—'}</strong></div>
          <div><span>Review</span><strong>{hasProductData ? formatInteger(detail.latest.reviewCount) : '—'}</strong></div>
          <div><span>BSR</span><strong>{hasProductData ? `#${formatInteger(detail.latest.bsr)}` : '—'}</strong></div>
          <div><span>月销量</span><strong>{hasProductData ? formatInteger(detail.latest.estimatedSales) : '—'}</strong></div>
          <div><span>月销售额</span><strong>{hasProductData ? formatCurrency(detail.latest.estimatedRevenue, settings.currency, true) : '—'}</strong></div>
        </div>
      </section>

      <nav className="page-tabs" aria-label="SKU 分析视图">
        <button type="button" className={tab === 'performance' ? 'is-active' : ''} onClick={() => setTab('performance')}>相对表现</button>
        <button type="button" className={tab === 'competitors' ? 'is-active' : ''} onClick={() => setTab('competitors')}>竞品情报 <span>{detail.competitors.length}</span></button>
        <button type="button" className={tab === 'diagnosis' ? 'is-active' : ''} onClick={() => setTab('diagnosis')}>AI 诊断 <span>{hasTrustedData ? detail.anomalyCount : '—'}</span></button>
      </nav>

      {tab === 'performance' && !hasTrustedData ? (
        <section className="snapshot-required" role="status">
          <span className="snapshot-required__icon"><DatabaseZap size={25} aria-hidden="true" /></span>
          <div>
            <span className="eyebrow">DATA REQUIRED</span>
              <h2>{needsProductGrowthBaseline ? 'SKU 增长基线不足' : hasProductData ? '市场增长基线不足' : '该 SKU 尚不能判断相对表现'}</h2>
              <p>{needsProductGrowthBaseline ? '已保留当前产品快照，但 SKU 尚未形成可比较的 30D 销量基线。导入文件中的增长值不会直接作为结论。' : hasProductData ? '已保留当前产品快照，但所属市场尚未形成可比较的 30D 增长基线。相对差值与百分位暂不计算。' : '当前没有可用的产品与市场快照。系统不会用默认零值生成“基本同步”、百分位或增长结论。'}</p>
              <small>{needsProductGrowthBaseline ? '补充该 SKU 约 30 天前的销量快照后，系统会确定性计算增长。' : hasProductData ? '补充所属市场的第二个时点后，系统会重新计算相对表现。' : '请至少导入一个产品快照和对应市场快照；形成两个时点后，趋势判断会更可靠。'}</small>
          </div>
          <div className="snapshot-required__actions">
            <Link className="button button--primary" to="/settings?tab=import"><FileSpreadsheet size={16} aria-hidden="true" />导入快照</Link>
            <Link className="button button--secondary" to="/data-tasks">查看数据任务</Link>
          </div>
        </section>
      ) : null}

      {tab === 'performance' && hasTrustedData ? (
        <>
          <div className="performance-lead">
            <section className={`relative-verdict relative-verdict--${performance.tone}`}>
              <header><span className="eyebrow">RELATIVE PERFORMANCE</span><Badge tone={performance.tone}>{performance.label}</Badge></header>
              <div className="relative-verdict__formula">
                <div><span>SKU 30D</span><strong>{formatPercent(detail.latest.growth30d)}</strong></div>
                <i>−</i>
                <div><span>市场 30D</span><strong>{formatPercent(detail.marketGrowth30d)}</strong></div>
                <i>=</i>
                <div><span>相对差值</span><strong>{formatPercent(detail.relativeDelta)}</strong></div>
              </div>
              <p>{detail.insight.summary}</p>
              <EvidenceDrawer insight={detail.insight} />
            </section>

            <section className="analysis-section percentile-section">
              <header className="section-header"><div><span className="eyebrow">MARKET POSITION</span><h2>市场百分位</h2></div><span className="section-header__note">P100 为市场最高</span></header>
              <div className="percentile-list">
                <PercentileRow label="销量" value={detail.percentiles.sales} />
                <PercentileRow label="价格" value={detail.percentiles.price} inverse />
                <PercentileRow label="Review" value={detail.percentiles.reviews} />
                <PercentileRow label="Rating" value={detail.percentiles.rating} />
                <PercentileRow label="增长" value={detail.percentiles.growth} />
              </div>
            </section>
          </div>

          <div className="two-column-analysis two-column-analysis--balanced">
            <section className="analysis-section">
              <header className="section-header"><div><span className="eyebrow">BENCHMARK</span><h2>SKU vs 市场 / 竞品</h2></div></header>
              <div className="chart-frame chart-frame--medium">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={comparisonData} layout="vertical" margin={{ top: 5, right: 25, left: 20, bottom: 0 }}>
                    <CartesianGrid stroke="#e8eceb" strokeDasharray="3 4" horizontal={false} />
                    <XAxis type="number" tickFormatter={(value: number) => `${value}%`} tick={{ fill: '#73807d', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="name" tick={{ fill: '#52605d', fontSize: 12 }} axisLine={false} tickLine={false} width={164} />
                    <ReferenceLine x={0} stroke="#99a5a2" />
                    <Tooltip formatter={(value) => [formatPercent(typeof value === 'number' ? value : null), '30D 增长']} contentStyle={{ border: '1px solid #dfe5e3', borderRadius: 6 }} />
                    <Bar dataKey="growth" radius={[0, 3, 3, 0]} barSize={22}>
                      {comparisonData.map((item) => <Cell key={item.name} fill={item.own ? '#16836f' : item.growth !== null && item.growth >= 0 ? '#7d9ba8' : '#c4504c'} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="comparison-legend"><span><i className="is-own" />当前 SKU</span><span><i />对照组</span><strong>相对市场 {formatPercent(detail.relativeDelta)}</strong></div>
            </section>

            <section className="analysis-section">
              <header className="section-header"><div><span className="eyebrow">SNAPSHOT HISTORY</span><h2>销量与价格快照</h2></div><span className="section-header__note">{detail.snapshots.length} 个历史版本</span></header>
              <div className="chart-frame chart-frame--medium">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={detail.snapshots} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#e8eceb" strokeDasharray="3 4" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={(value: string) => formatDate(value)} tick={{ fill: '#73807d', fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={22} />
                    <YAxis yAxisId="sales" tickFormatter={formatCompact} tick={{ fill: '#73807d', fontSize: 11 }} axisLine={false} tickLine={false} width={42} />
                    <YAxis yAxisId="price" orientation="right" tickFormatter={(value: number) => formatCurrency(value, settings.currency)} tick={{ fill: '#73807d', fontSize: 11 }} axisLine={false} tickLine={false} width={58} />
                    <Tooltip labelFormatter={(value) => formatDate(String(value), 'yyyy-MM-dd')} contentStyle={{ border: '1px solid #dfe5e3', borderRadius: 6 }} />
                    <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
                    <Line yAxisId="sales" type="monotone" dataKey="estimatedSales" name="预估月销量" stroke="#16836f" strokeWidth={2.2} dot={false} connectNulls={false} />
                    <Line yAxisId="price" type="stepAfter" dataKey="price" name="价格" stroke="#b46a24" strokeWidth={1.8} dot={false} connectNulls={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <footer className="snapshot-footer"><Clock3 size={14} aria-hidden="true" />最近快照 {formatDateTime(detail.latest.provenance.collectedAt)} · {detail.latest.estimatedSales === null ? '快照来源' : '月销量来源'}：{detail.latest.provenance.source}{detail.latest.provenance.isEstimated ? ' · 估算' : ''}{new Set(Object.values(detail.latest.metricProvenance ?? {}).map((source) => source.sourceRecordId)).size > 1 ? ' · 多来源指标' : ''}</footer>
            </section>
          </div>
        </>
      ) : null}

      {tab === 'competitors' ? (
        <>
          <div className="competitor-heading">
            <div>
              <span className="eyebrow">COMPETITOR GROUPS</span>
              <h2>竞品关系</h2>
              <p>竞品关系可先建立；销量、增长等快照指标会在导入后出现。</p>
            </div>
            {settings.role === 'admin' ? (
              <button
                type="button"
                className="button button--primary"
                onClick={() => {
                  setCompetitorError(null);
                  setShowCompetitorForm(true);
                }}
              >
                <Plus size={16} aria-hidden="true" />添加竞品
              </button>
            ) : <Badge tone="neutral">Viewer 只读</Badge>}
          </div>
          {competitorError && !showCompetitorForm ? <p className="form-error" role="alert">{competitorError}</p> : null}
          <CompetitorCandidateReview key={detail.id} productId={detail.id}
            isViewer={settings.role !== 'admin'} onConfirmed={detailQuery.reload} />
          <CompetitorTable
            competitors={detail.competitors}
            currency={settings.currency}
            canEdit={settings.role === 'admin'}
            updatingId={competitorUpdatingId}
            initialQuery={detail.competitors.find((item) => item.id === requestedCompetitorId)?.asin}
            focusCompetitorId={requestedCompetitorId ?? undefined}
            onReclassify={(competitor, relationType) => void reclassifyCompetitor(competitor, relationType)}
            onRemove={(competitor) => void removeCompetitor(competitor)}
            onSync={(competitor) => void syncCompetitor(competitor)}
          />
        </>
      ) : null}

      {tab === 'diagnosis' ? (
        hasTrustedData ? <>
          <InsightPanel insight={detail.insight} title="AI SKU 诊断" />
          <section className="diagnosis-ledger">
            <header className="section-header"><div><span className="eyebrow">DIAGNOSIS TRACE</span><h2>诊断结构</h2></div></header>
            <div className="diagnosis-grid">
              <div><Gauge size={18} aria-hidden="true" /><span>当前状态</span><strong>{performance.label}</strong><p>相对市场 {formatPercent(detail.relativeDelta)}</p></div>
              <div><ChartNoAxesCombined size={18} aria-hidden="true" /><span>市场背景</span><strong>{formatPercent(detail.marketGrowth30d)} / 30D</strong><p>{detail.insight.facts[0] ?? '等待更多市场事实'}</p></div>
              <div><Users size={18} aria-hidden="true" /><span>竞品变化</span><strong>{detail.competitors.filter((item) => item.latest.growth30dAvailable && item.latest.growth30d !== null && item.latest.growth30d > 10).length} 个高增长</strong><p>{detail.insight.facts[1] ?? '竞品分组持续监控中'}</p></div>
              <div><BarChart3 size={18} aria-hidden="true" /><span>主要问题</span><strong>{detail.insight.risks.length} 项风险</strong><p>{detail.insight.risks[0] ?? '暂无明确风险'}</p></div>
            </div>
          </section>
        </> : (
          <section className="snapshot-required" role="status">
            <span className="snapshot-required__icon"><DatabaseZap size={25} aria-hidden="true" /></span>
            <div>
              <span className="eyebrow">INSUFFICIENT EVIDENCE</span>
              <h2>数据不足，暂不生成 SKU 诊断</h2>
              <p>{detail.insight.summary}</p>
              <small>导入产品和所属市场快照后，系统会重新生成带证据链的判断。</small>
            </div>
            <div className="snapshot-required__actions">
              <EvidenceDrawer insight={detail.insight} />
              <Link className="button button--primary" to="/settings?tab=import"><FileSpreadsheet size={16} aria-hidden="true" />导入快照</Link>
            </div>
          </section>
        )
      ) : null}

      {showCompetitorForm && settings.role === 'admin' ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => event.target === event.currentTarget && !competitorSaving && setShowCompetitorForm(false)}
        >
          <form className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="add-competitor-title" onSubmit={addCompetitor}>
            <div className="modal-header">
              <div><span className="eyebrow">COMPETITOR GROUP</span><h2 id="add-competitor-title">添加竞品</h2></div>
              <button className="icon-button" type="button" aria-label="关闭" disabled={competitorSaving} onClick={() => setShowCompetitorForm(false)}><X size={18} aria-hidden="true" /></button>
            </div>
            <div className="form-grid grid grid-2">
              <label className="field"><span>ASIN</span><input className="input" autoFocus required pattern="[A-Za-z0-9]{10}" maxLength={10} value={competitorForm.asin} onChange={(event) => setCompetitorForm({ ...competitorForm, asin: event.target.value.toUpperCase() })} placeholder="10 位 ASIN" /></label>
              <label className="field"><span>竞品分组</span><select className="input" value={competitorForm.relationType} onChange={(event) => setCompetitorForm({ ...competitorForm, relationType: event.target.value as RelationType })}>{relationOptions.filter((option) => option.value !== 'all').map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <label className="field"><span>品牌（可选）</span><input className="input" value={competitorForm.brand} onChange={(event) => setCompetitorForm({ ...competitorForm, brand: event.target.value })} /></label>
              <label className="field"><span>相似度（可选）</span><input className="input" type="number" min="0" max="100" step="1" value={competitorForm.similarityScore} onChange={(event) => setCompetitorForm({ ...competitorForm, similarityScore: event.target.value })} placeholder="0–100" /></label>
              <label className="field field-span-2"><span>标题（可选）</span><input className="input" value={competitorForm.title} onChange={(event) => setCompetitorForm({ ...competitorForm, title: event.target.value })} /></label>
              <label className="field field-span-2"><span>纳入理由（可选）</span><textarea className="input" rows={3} value={competitorForm.reason} onChange={(event) => setCompetitorForm({ ...competitorForm, reason: event.target.value })} placeholder="例如：核心词排名相邻，价格带一致" /></label>
            </div>
            {competitorError ? <p className="form-error" role="alert">{competitorError}</p> : null}
            <div className="modal-actions">
              <button className="button button--secondary" type="button" disabled={competitorSaving} onClick={() => setShowCompetitorForm(false)}>取消</button>
              <button className="button button--primary" type="submit" disabled={competitorSaving || competitorForm.asin.trim().length !== 10}>{competitorSaving ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}{competitorSaving ? '添加中' : '添加竞品'}</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
