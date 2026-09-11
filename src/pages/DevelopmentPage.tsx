import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  CircleGauge,
  Clock3,
  DatabaseZap,
  FileSpreadsheet,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  ApiResponse,
  DecisionType,
  DevelopmentProject,
  MarketDetail,
  ResearchJobSummary,
  ScoreBreakdown,
} from '../../shared/types';
import { useApi } from '../lib/api';
import { useApp } from '../lib/AppContext';
import { formatCurrency, formatInteger, formatPercent } from '../lib/format';
import { findLatestResearchJobForEntity } from '../lib/researchJobs';

const decisions: Array<{ value: DecisionType; label: string; description: string }> = [
  { value: 'develop', label: '建议开发', description: '进入正式开发与供应链评估' },
  { value: 'test', label: '小规模验证', description: '用小批量或投放测试验证关键假设' },
  { value: 'watch', label: '继续观察', description: '保留监控，等待指标改善' },
  { value: 'reject', label: '暂不开发', description: '记录原因并停止当前研究' },
];

const scoreItems: Array<{ key: keyof ScoreBreakdown; label: string; weight: string; max: number }> = [
  { key: 'demand', label: '市场需求', weight: '20%', max: 20 },
  { key: 'growth', label: '增长趋势', weight: '20%', max: 20 },
  { key: 'competition', label: '竞争强度', weight: '20%', max: 20 },
  { key: 'newProductFriendly', label: '新品友好度', weight: '15%', max: 15 },
  { key: 'priceRoom', label: '价格空间', weight: '10%', max: 10 },
  { key: 'concentration', label: '市场集中度', weight: '10%', max: 10 },
  { key: 'confidence', label: '数据可信度', weight: '5%', max: 5 },
];

const decisionLabels: Record<DecisionType, string> = {
  develop: '建议开发',
  test: '小规模验证',
  watch: '继续观察',
  reject: '暂不开发',
};

type DisplayDecision = DevelopmentProject['decision'] extends { decision: infer T } | undefined ? T : DecisionType;

function displayDecisionLabel(value: DisplayDecision): string {
  if (value === 'approved') return '已批准';
  if (value === 'needs_data') return '待补数据';
  return decisionLabels[value];
}

interface ProjectForm {
  name: string;
  productType: string;
  keywords: string;
  notes: string;
  marketplace: string;
  supplyChainRelation: string;
}

const initialForm: ProjectForm = {
  name: '',
  productType: '',
  keywords: '',
  notes: '',
  marketplace: '',
  supplyChainRelation: '',
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body instanceof FormData
      ? init.headers
      : { 'Content-Type': 'application/json', ...init?.headers },
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<ApiResponse<T>> & {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error ?? payload.message ?? `请求失败 (${response.status})`);
  }
  if (payload.data === undefined) throw new Error('接口没有返回数据');
  return payload.data;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function statusTone(status: DisplayDecision): string {
  if (status === 'approved') return 'success';
  if (status === 'needs_data') return 'warning';
  return status === 'develop' ? 'success' : status === 'reject' ? 'danger' : status === 'test' ? 'warning' : 'neutral';
}

interface ProjectMetrics {
  marketSize: number;
  growth30d: number;
  competitionScore: number;
  opportunityScore: number;
  scoreBreakdown: ScoreBreakdown;
}

function getProjectMetrics(project: DevelopmentProject): ProjectMetrics | null {
  if (
    project.insight.status === '数据不足'
    || project.insight.evidence.length === 0
    || project.marketSize === null
    || project.growth30d === null
    || project.competitionScore === null
    || project.opportunityScore === null
    || project.scoreBreakdown === null
  ) return null;
  return {
    marketSize: project.marketSize,
    growth30d: project.growth30d,
    competitionScore: project.competitionScore,
    opportunityScore: project.opportunityScore,
    scoreBreakdown: project.scoreBreakdown,
  };
}

export default function DevelopmentPage() {
  const { settings: appSettings, refreshKey, reloadSettings } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedProjectId = searchParams.get('project');
  const canEdit = appSettings.role === 'admin';
  const [projects, setProjects] = useState<DevelopmentProject[]>([]);
  const [selected, setSelected] = useState<DevelopmentProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<ProjectForm>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [showDecision, setShowDecision] = useState(false);
  const [decision, setDecision] = useState<DecisionType>('watch');
  const [reason, setReason] = useState('');
  const [decidedBy, setDecidedBy] = useState('Admin');
  const [notice, setNotice] = useState<string | null>(null);
  const marketContextQuery = useApi<MarketDetail>(
    selected?.marketNodeId
      ? `/api/markets/${encodeURIComponent(selected.marketNodeId)}?marketplace=${encodeURIComponent(appSettings.marketplace)}`
      : null,
    refreshKey,
  );
  const researchJobsQuery = useApi<ResearchJobSummary[]>(
    `/api/research-jobs?marketplace=${encodeURIComponent(appSettings.marketplace)}`,
    refreshKey,
  );

  useEffect(() => {
    setForm((current) => ({ ...current, marketplace: appSettings.marketplace }));
  }, [appSettings.marketplace]);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProjects(await request<DevelopmentProject[]>('/api/development-projects'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法加载待开发项目');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setProjects([]);
    setSelected(null);
    setShowCreate(false);
    setShowDecision(false);
    setError(null);
    void loadProjects();
  }, [appSettings.marketplace, loadProjects, refreshKey]);

  useEffect(() => {
    if (!requestedProjectId || loading) return;
    const project = projects.find((item) => item.id === requestedProjectId);
    if (!project) return;
    let active = true;
    setSelected(project);
    setDetailLoading(true);
    request<DevelopmentProject>(`/api/development-projects/${encodeURIComponent(project.id)}`)
      .then((detail) => { if (active) setSelected(detail); })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : '无法加载项目详情'); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [loading, projects, requestedProjectId]);

  const filteredProjects = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return projects;
    return projects.filter((project) =>
      [project.name, project.productType, project.keywords.join(' ')]
        .join(' ')
        .toLocaleLowerCase()
        .includes(keyword),
    );
  }, [projects, query]);

  function openProject(project: DevelopmentProject) {
    setError(null);
    setDetailLoading(true);
    setSelected(project);
    setSearchParams({ project: project.id });
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const created = await request<DevelopmentProject>('/api/development-projects', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          marketplace: appSettings.marketplace,
          keywords: form.keywords.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean),
        }),
      });
      setProjects((current) => [created, ...current]);
      setSelected(created);
      await reloadSettings();
      setForm({ ...initialForm, marketplace: appSettings.marketplace });
      setShowCreate(false);
      setNotice('项目已创建，研究任务与监控对象正在准备。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '创建项目失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function analyzeProject() {
    if (!selected) return;
    setAnalyzing(true);
    setError(null);
    try {
      const updated = await request<DevelopmentProject>(`/api/development-projects/${selected.id}/analyze`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setSelected(updated);
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNotice('分析已更新，评分和证据链已保存。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '重新分析失败');
    } finally {
      setAnalyzing(false);
    }
  }

  async function saveDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await request<DevelopmentProject>(`/api/development-projects/${selected.id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason: reason.trim(), decidedBy: decidedBy.trim() }),
      });
      setSelected(updated);
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
      setShowDecision(false);
      setReason('');
      setNotice(`决策已保存：${decisionLabels[decision]}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存决策失败');
    } finally {
      setSubmitting(false);
    }
  }

  if (selected) {
    const metrics = getProjectMetrics(selected);
    const projectReady = metrics !== null;
    const linkedResearchJob = findLatestResearchJobForEntity(
      researchJobsQuery.data ?? [], 'development_project', selected.id,
    );
    const researchJobId = linkedResearchJob?.id ?? selected.insight.researchJobId ?? selected.decision?.researchJobId;
    const displayedDecision = researchJobId ? undefined : selected.decision?.decision;
    return (
      <main className="page development-page">
        <header className="page-header detail-header">
          <div>
            <button className="button button-ghost" type="button" onClick={() => { setSelected(null); setSearchParams({}, { replace: true }); }}>
              <ArrowLeft size={16} /> 返回项目列表
            </button>
            <div className="eyebrow">待开发产品 / 项目详情</div>
            <h1>{selected.name}</h1>
            <p>{selected.productType} · {selected.marketplace} · 创建于 {formatDate(selected.createdAt)}</p>
          </div>
          <div className="header-actions">
            {!researchJobId ? <button className="button button-secondary" type="button" onClick={() => void analyzeProject()} disabled={analyzing || !canEdit || (researchJobsQuery.loading && !researchJobsQuery.data)}>
              {analyzing ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
              {analyzing ? '分析中' : projectReady ? '重新分析' : '采集并分析'}
            </button> : null}
            {researchJobId ? (
              <Link className="button button-primary" to={`/research-jobs/${encodeURIComponent(researchJobId)}`}>
                <CheckCircle2 size={16} /> 进入 V2 审批门
              </Link>
            ) : (
              <button className="button button-primary" type="button" onClick={() => setShowDecision(true)} disabled={!canEdit || !projectReady} title={!projectReady ? '获得有效证据后才能记录新决策' : undefined}>
                <CheckCircle2 size={16} /> 记录历史项目决策
              </button>
            )}
          </div>
        </header>

        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {notice && <div className="alert alert-success" role="status">{notice}</div>}
        {detailLoading ? (
          <div className="loading-state"><Loader2 className="spin" size={22} /> 正在加载项目详情…</div>
        ) : (
          <>
            <section className="metric-grid grid grid-4">
              <div className="metric"><span>市场规模</span><strong>{metrics ? formatNumber(metrics.marketSize) : '—'}</strong><small>{projectReady ? '预估月销量' : '待采集数据'}</small></div>
              <div className="metric"><span>30D 增速</span><strong className={metrics ? metrics.growth30d >= 0 ? 'positive' : 'negative' : ''}>{metrics ? `${metrics.growth30d >= 0 ? '+' : ''}${metrics.growth30d.toFixed(1)}%` : '—'}</strong><small>{projectReady ? '当前研究市场' : '待采集数据'}</small></div>
              <div className="metric"><span>竞争评分</span><strong>{metrics ? metrics.competitionScore.toFixed(0) : '—'}</strong><small>{projectReady ? '分数越低越友好' : '待采集数据'}</small></div>
              <div className={projectReady ? 'metric metric-emphasis' : 'metric'}><span>机会评分</span><strong>{metrics ? metrics.opportunityScore.toFixed(0) : '—'}</strong><small>{projectReady ? '/ 100' : '待采集数据'}</small></div>
            </section>

            {!projectReady ? (
              <section className="snapshot-required" role="status">
                <span className="snapshot-required__icon"><DatabaseZap size={25} /></span>
                <div><span className="eyebrow">RESEARCH DATA REQUIRED</span><h2>项目待采集数据</h2><p>{selected.insight.summary}</p><small>运行研究任务或导入当前站点报表后，系统才会生成机会分与自动建议。</small></div>
                <div className="snapshot-required__actions">{researchJobId ? <Link className="button button-primary" to={`/research-jobs/${encodeURIComponent(researchJobId)}`}><CheckCircle2 size={16} />打开 V2 任务</Link> : <button className="button button-primary" type="button" disabled={analyzing || !canEdit || (researchJobsQuery.loading && !researchJobsQuery.data)} onClick={() => void analyzeProject()}>{analyzing ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}运行研究</button>}<Link className="button button-secondary" to="/settings?tab=import"><FileSpreadsheet size={16} />导入数据</Link></div>
              </section>
            ) : null}

            <div className="content-grid grid grid-main-aside">
              <section className="panel">
                <div className="panel-header">
                  <div><span className="eyebrow">AI 判断</span><h2>{selected.insight.title}</h2></div>
                  <span className={`status-badge ${researchJobId ? 'info' : displayedDecision ? statusTone(displayedDecision) : projectReady ? statusTone(selected.status) : 'warning'}`}>{researchJobId ? 'V2 工作流审批' : displayedDecision ? displayDecisionLabel(displayedDecision) : projectReady ? decisionLabels[selected.status] : '待采集数据'}</span>
                </div>
                <p className="lead">{selected.insight.summary}</p>
                {projectReady ? <div className="insight-columns grid grid-3">
                  <div><h3>机会</h3>{selected.insight.opportunities.length ? <ul>{selected.insight.opportunities.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="muted">暂无明确机会</p>}</div>
                  <div><h3>风险</h3>{selected.insight.risks.length ? <ul>{selected.insight.risks.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="muted">暂无新增风险</p>}</div>
                  <div><h3>建议动作</h3>{selected.insight.recommendedActions.length ? <ul>{selected.insight.recommendedActions.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="muted">等待更多数据</p>}</div>
                </div> : <p className="alert alert-info">自动建议已暂停，等待可验证的数据与证据。</p>}
                <details className="evidence-block">
                  <summary><BrainCircuit size={16} /> 为什么？查看 {selected.insight.evidence.length} 条证据</summary>
                  {selected.insight.evidence.map((evidence) => (
                    <article className="evidence-item" key={evidence.id}>
                      <strong>{evidence.claim}</strong>
                      <div className="evidence-metrics">
                        {evidence.metrics.map((metric) => <span key={metric.name}>{metric.label}: <b>{metric.value}{metric.unit ?? ''}</b></span>)}
                      </div>
                      {evidence.provenance.map((source, index) => (
                        <small key={`${source.source}-${index}`}>{source.source} · {source.period} · {formatDate(source.collectedAt)} · 置信度 {(source.confidence * 100).toFixed(0)}%{source.isEstimated ? ' · 估算' : ''}</small>
                      ))}
                    </article>
                  ))}
                </details>
              </section>

              <aside className="panel score-panel">
                <div className="panel-header"><div><span className="eyebrow">Opportunity Score</span><h2>评分拆解</h2></div><CircleGauge size={22} /></div>
                {metrics ? <><div className="score-total"><strong>{metrics.opportunityScore.toFixed(0)}</strong><span>/ 100</span></div>
                <div className="score-list">
                  {scoreItems.map((item) => (
                    <div className="score-row" key={item.key}>
                      <div><span>{item.label}</span><small>权重 {item.weight}</small></div>
                      <div className="score-track"><i style={{ width: `${Math.max(0, Math.min(100, metrics.scoreBreakdown[item.key] / item.max * 100))}%` }} /></div>
                      <b>{metrics.scoreBreakdown[item.key].toFixed(0)}/{item.max}</b>
                    </div>
                  ))}
                </div></> : <div className="empty-state compact"><DatabaseZap size={24} /><h3>暂无评分</h3><p>采集完成后显示各维度权重。</p></div>}
              </aside>
            </div>

            <section className="analysis-section development-market-context">
              <div className="section-heading">
                <div><span className="eyebrow">LINKED MARKET EVIDENCE</span><h2>关联市场上下文</h2><p>只展示关联 MarketNode 已保存的真实快照，不用项目占位值补齐。</p></div>
                {selected.marketNodeId ? <Link className="button button-secondary" to={`/market?market=${encodeURIComponent(selected.marketNodeId)}`}>查看完整市场</Link> : null}
              </div>
              <div className="development-research-scope">
                <div><span>推荐研究关键词（假设）</span><div className="tag-list">{selected.keywords.length ? selected.keywords.map((keyword) => <span key={keyword}>{keyword}</span>) : <small>尚未设置关键词</small>}</div></div>
                {marketContextQuery.data?.path.length ? <div><span>关联市场路径</span><div className="breadcrumb">{marketContextQuery.data.path.map((item, index) => <span key={item.id}>{index ? <i>/</i> : null}{item.name}</span>)}</div></div> : null}
              </div>
              {marketContextQuery.loading && !marketContextQuery.data ? <div className="loading-state"><Loader2 className="spin" size={20} />正在读取关联市场快照…</div> : marketContextQuery.error ? <div className="alert alert-error" role="alert">{marketContextQuery.error.message}<button type="button" onClick={marketContextQuery.reload}>重试</button></div> : !marketContextQuery.data?.trends.length ? <div className="empty-state compact"><DatabaseZap size={25} /><h3>关联市场尚无快照</h3><p>导入市场报表后，这里会显示价格、新品、Review 门槛、集中度与历史趋势。</p></div> : (() => {
                const market = marketContextQuery.data;
                const history = market.trends.slice(-8);
                return <>
                  <div className="metric-grid grid grid-4 development-market-kpis">
                    <div className="metric"><span>最新均价</span><strong>{formatCurrency(market.kpis.avgPrice, appSettings.currency)}</strong><small>中位 {formatCurrency(market.kpis.medianPrice, appSettings.currency)}</small></div>
                    <div className="metric"><span>新品占比</span><strong>{formatPercent(market.kpis.newProductShare, false)}</strong><small>最新市场快照</small></div>
                    <div className="metric"><span>Review 门槛</span><strong>{formatInteger(market.kpis.medianReviews)}</strong><small>Review 中位数</small></div>
                    <div className="metric"><span>TOP20 集中度</span><strong>{formatPercent(market.kpis.top20Share, false)}</strong><small>销量份额</small></div>
                  </div>
                  <div className="table-scroll">
                    <table className="data-table development-market-history"><thead><tr><th>快照日期</th><th>月销量</th><th>均价</th><th>产品数</th><th>卖家数</th><th>Review 中位</th></tr></thead><tbody>{history.map((point) => <tr key={point.date}><td>{formatDate(point.date)}</td><td>{formatInteger(point.sales)}</td><td>{formatCurrency(point.avgPrice, appSettings.currency)}</td><td>{formatInteger(point.productCount)}</td><td>{formatInteger(point.sellerCount)}</td><td>{formatInteger(point.medianReviews)}</td></tr>)}</tbody></table>
                  </div>
                </>;
              })()}
            </section>

            <section className="panel project-context">
              <div className="panel-header"><h2>研究上下文</h2></div>
              <dl className="definition-grid">
                <div><dt>关键词</dt><dd>{selected.keywords.join('、') || '未设置'}</dd></div>
                <div><dt>供应链关系</dt><dd>{selected.supplyChainRelation || '未填写'}</dd></div>
                <div><dt>备注</dt><dd>{selected.notes || '暂无备注'}</dd></div>
                <div><dt>数据版本</dt><dd>{selected.insight.dataVersion}</dd></div>
              </dl>
              {selected.decision && !researchJobId && (
                <div className="decision-record">
                  <Clock3 size={18} />
                  <div><strong>{displayDecisionLabel(selected.decision.decision)}</strong><p>{selected.decision.reason}</p><small>{selected.decision.decidedBy} · {formatDate(selected.decision.decidedAt)}</small></div>
                </div>
              )}
            </section>
          </>
        )}

        {showDecision && (
          <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowDecision(false)}>
            <form className="modal" role="dialog" aria-modal="true" aria-labelledby="decision-title" onSubmit={(event) => void saveDecision(event)}>
              <div className="modal-header"><div><span className="eyebrow">人工最终判断</span><h2 id="decision-title">记录项目决策</h2></div><button className="icon-button" type="button" aria-label="关闭" onClick={() => setShowDecision(false)}><X size={18} /></button></div>
              <div className="decision-options">
                {decisions.map((item) => (
                  <label className={`decision-option ${decision === item.value ? 'selected' : ''}`} key={item.value}>
                    <input type="radio" name="decision" value={item.value} checked={decision === item.value} onChange={() => setDecision(item.value)} />
                    <span><strong>{item.label}</strong><small>{item.description}</small></span>
                  </label>
                ))}
              </div>
              <label className="field"><span>决策原因</span><textarea className="input" rows={4} required value={reason} onChange={(event) => setReason(event.target.value)} placeholder="记录当时的判断依据，便于未来复盘" /></label>
              <label className="field"><span>决策人</span><input className="input" required value={decidedBy} onChange={(event) => setDecidedBy(event.target.value)} /></label>
              <div className="modal-actions"><button className="button button-secondary" type="button" onClick={() => setShowDecision(false)}>取消</button><button className="button button-primary" type="submit" disabled={submitting}>{submitting && <Loader2 className="spin" size={16} />}保存决策</button></div>
            </form>
          </div>
        )}
      </main>
    );
  }

  return (
    <main className="page development-page">
      <header className="page-header">
        <div><div className="eyebrow">增长机会</div><h1>待开发产品</h1><p>评估与现有供应链相邻的产品机会，并沉淀每一次开发决策。</p></div>
        <button className="button button-primary" type="button" onClick={() => setShowCreate(true)} disabled={!canEdit}><Plus size={17} /> 新建项目</button>
      </header>
      {error && <div className="alert alert-error" role="alert">{error}<button type="button" onClick={() => void loadProjects()}>重试</button></div>}
      {notice && <div className="alert alert-success" role="status">{notice}</div>}
      {!canEdit && <div className="alert alert-info">当前为 Viewer 角色，可查看项目与证据，但不能新建、分析或记录决策。</div>}
      <div className="toolbar"><label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目、类型或关键词" /></label><span className="result-count">{filteredProjects.length} 个项目</span></div>

      {loading ? (
        <div className="loading-state"><Loader2 className="spin" size={22} /> 正在加载待开发项目…</div>
      ) : filteredProjects.length === 0 ? (
        <section className="empty-state"><Sparkles size={30} /><h2>{projects.length ? '没有匹配的项目' : '还没有待开发项目'}</h2><p>{projects.length ? '调整搜索条件，或清空关键词。' : '从一个产品想法开始，AI 会建立研究任务、评分和监控。'}</p>{!projects.length && <button className="button button-primary" type="button" onClick={() => setShowCreate(true)}><Plus size={16} /> 新建第一个项目</button>}</section>
      ) : (
        <section className="panel table-panel">
          <div className="data-table-wrap"><table className="data-table"><thead><tr><th>项目</th><th>市场规模</th><th>30D 增速</th><th>竞争</th><th>机会分</th><th>状态</th><th>最近 AI 结论</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>
            {filteredProjects.map((project) => {
              const metrics = getProjectMetrics(project);
              const projectReady = metrics !== null;
              const researchJobId = findLatestResearchJobForEntity(
                researchJobsQuery.data ?? [], 'development_project', project.id,
              )?.id ?? project.insight.researchJobId ?? project.decision?.researchJobId;
              const displayedDecision = researchJobId ? undefined : project.decision?.decision;
              return <tr key={project.id}><td><strong>{project.name}</strong><small>{project.productType} · {formatDate(project.createdAt)}</small></td><td>{metrics ? formatNumber(metrics.marketSize) : '—'}</td><td className={metrics ? metrics.growth30d >= 0 ? 'positive' : 'negative' : ''}>{metrics ? `${metrics.growth30d >= 0 ? '+' : ''}${metrics.growth30d.toFixed(1)}%` : '—'}</td><td>{metrics ? metrics.competitionScore.toFixed(0) : '—'}</td><td><strong>{metrics ? metrics.opportunityScore.toFixed(0) : '—'}</strong></td><td><span className={`status-badge ${researchJobId ? 'info' : displayedDecision ? statusTone(displayedDecision) : projectReady ? statusTone(project.status) : 'warning'}`}>{researchJobId ? 'V2 工作流审批' : displayedDecision ? displayDecisionLabel(displayedDecision) : projectReady ? decisionLabels[project.status] : '待采集数据'}</span></td><td className="summary-cell">{project.insight.summary}</td><td><button className="icon-button" type="button" aria-label={`查看 ${project.name}`} onClick={() => void openProject(project)}><ChevronRight size={18} /></button></td></tr>;
            })}
          </tbody></table></div>
        </section>
      )}

      {showCreate && canEdit && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowCreate(false)}>
          <form className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="create-project-title" onSubmit={(event) => void createProject(event)}>
            <div className="modal-header"><div><span className="eyebrow">相邻供应链机会</span><h2 id="create-project-title">新建待开发项目</h2></div><button className="icon-button" type="button" aria-label="关闭" onClick={() => setShowCreate(false)}><X size={18} /></button></div>
            <div className="form-grid grid grid-2">
              <label className="field"><span>产品名称</span><input className="input" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：人体工学腰靠" /></label>
              <label className="field"><span>产品类型</span><input className="input" required value={form.productType} onChange={(event) => setForm({ ...form, productType: event.target.value })} placeholder="例如：Memory Foam Lumbar Pillow" /></label>
              <label className="field"><span>Marketplace</span><input className="input" value={`Amazon ${appSettings.marketplace}`} disabled readOnly /><small>项目固定创建在顶部当前站点。</small></label>
              <label className="field"><span>与现有供应链关系</span><input className="input" required value={form.supplyChainRelation} onChange={(event) => setForm({ ...form, supplyChainRelation: event.target.value })} placeholder="材料、模具、工艺或供应商复用情况" /></label>
            </div>
            <label className="field"><span>研究关键词</span><input className="input" required value={form.keywords} onChange={(event) => setForm({ ...form, keywords: event.target.value })} placeholder="用逗号分隔，AI 会继续补充" /></label>
            <label className="field"><span>备注</span><textarea className="input" rows={4} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="产品假设、目标客群、成本限制等" /></label>
            <div className="modal-actions"><button className="button button-secondary" type="button" onClick={() => setShowCreate(false)}>取消</button><button className="button button-primary" type="submit" disabled={submitting}>{submitting ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}{submitting ? '创建中' : '创建并研究'}</button></div>
          </form>
        </div>
      )}
    </main>
  );
}
