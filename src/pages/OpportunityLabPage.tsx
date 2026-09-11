import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Ban,
  Boxes,
  BrainCircuit,
  Check,
  ChevronDown,
  CircleDot,
  FlaskConical,
  Layers3,
  Loader2,
  Network,
  Search,
  Send,
  Sparkles,
} from 'lucide-react';
import type {
  ApiResponse,
  Opportunity,
  OpportunityStatus,
  ResearchNode,
  ResearchResult,
  TaskStatus,
} from '../../shared/types';
import { useApp } from '../lib/AppContext';

const exampleQueries = [
  '小学一年级开学用品组合套装',
  '适合办公室久坐人群的轻量健康产品',
  '露营新手的一站式收纳组合',
];

const taskLabels: Record<TaskStatus, string> = {
  pending: '等待采集',
  running: '采集中',
  success: '已完成',
  partial: '部分完成',
  failed: '失败',
};

const statusLabels: Record<OpportunityStatus, string> = {
  pending_review: '待审核',
  researching: '深度研究',
  promoted: '已转待开发',
  rejected: '暂不考虑',
};

type LabAction = 'watch' | 'promote' | 'reject';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<ApiResponse<T>> & {
    error?: string;
    message?: string;
  };
  if (!response.ok) throw new Error(payload.error ?? payload.message ?? `请求失败 (${response.status})`);
  if (payload.data === undefined) throw new Error('接口没有返回数据');
  return payload.data;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function taskTone(status: TaskStatus): string {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'running') return 'info';
  if (status === 'partial') return 'warning';
  return 'neutral';
}

function opportunityTone(status: OpportunityStatus): string {
  if (status === 'promoted') return 'success';
  if (status === 'rejected') return 'danger';
  if (status === 'researching') return 'info';
  return 'warning';
}

function ResearchTree({ nodes }: { nodes: ResearchNode[] }) {
  const nodeIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);
  const children = useMemo(() => {
    const grouped = new Map<string | null, ResearchNode[]>();
    nodes.forEach((node) => {
      const parent = node.parentId && nodeIds.has(node.parentId) ? node.parentId : null;
      grouped.set(parent, [...(grouped.get(parent) ?? []), node]);
    });
    return grouped;
  }, [nodeIds, nodes]);

  function renderNode(node: ResearchNode, trail: Set<string>): React.ReactNode {
    const descendants = children.get(node.id) ?? [];
    const nextTrail = new Set(trail).add(node.id);
    const ready = node.taskStatus === 'success' && node.snapshotAvailable;
    return (
      <li key={node.id}>
        <div className="tree-node">
          <div className="tree-node-title"><CircleDot size={14} /><strong>{node.name}</strong><span>第 {node.level} 层</span></div>
          <div className="tree-node-metrics">
            <span>月销量 <b>{ready && node.monthlySales !== null ? new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(node.monthlySales) : '—'}</b></span>
            <span>增长 <b className={ready && node.growth30d !== null ? node.growth30d >= 0 ? 'positive' : 'negative' : ''}>{ready && node.growth30d !== null ? `${node.growth30d >= 0 ? '+' : ''}${node.growth30d.toFixed(1)}%` : '—'}</b></span>
            <span>竞争 <b>{ready && node.competitionScore !== null ? node.competitionScore.toFixed(0) : '—'}</b></span>
            <span>机会 <b>{ready && node.opportunityScore !== null ? node.opportunityScore.toFixed(0) : '—'}</b></span>
            <span className={`status-badge ${taskTone(node.taskStatus)}`}>{taskLabels[node.taskStatus]}</span>
          </div>
        </div>
        {descendants.length > 0 && (
          <ul>{descendants.filter((child) => !nextTrail.has(child.id)).map((child) => renderNode(child, nextTrail))}</ul>
        )}
      </li>
    );
  }

  const roots = children.get(null) ?? [];
  return roots.length ? <ul className="research-tree">{roots.map((node) => renderNode(node, new Set()))}</ul> : <div className="empty-state compact"><Network size={24} /><p>尚未生成研究节点</p></div>;
}

export default function OpportunityLabPage() {
  const { settings, refreshKey, reloadSettings } = useApp();
  const canEdit = settings.role === 'admin';
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);

  useEffect(() => {
    setResult(null);
    setActiveAction(null);
    setError(null);
    setNotice(null);
  }, [refreshKey, settings.marketplace]);

  async function research(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const normalized = query.trim();
    if (!normalized) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const researchResult = await request<ResearchResult>('/api/opportunity-lab/research', {
        method: 'POST',
        body: JSON.stringify({ query: normalized }),
      });
      setResult(researchResult);
      await reloadSettings();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '研究任务创建失败');
    } finally {
      setLoading(false);
    }
  }

  async function performAction(opportunity: Opportunity, action: LabAction) {
    if (action !== 'watch' && opportunity.evidence.length === 0) return;
    const actionKey = `${opportunity.id}:${action}`;
    setActiveAction(actionKey);
    setError(null);
    try {
      await request<unknown>(`/api/opportunities/${opportunity.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ source: 'opportunity_lab' }),
      });
      const nextStatus: OpportunityStatus = action === 'promote' ? 'promoted' : action === 'reject' ? 'rejected' : 'researching';
      setResult((current) => current ? {
        ...current,
        opportunities: current.opportunities.map((item) => item.id === opportunity.id ? { ...item, status: nextStatus } : item),
      } : current);
      setNotice(action === 'promote' ? '已转为待开发项目。' : action === 'reject' ? '已保留到淘汰池，可在未来重新评估。' : '已加入机会池并开启持续研究。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '机会状态更新失败');
    } finally {
      setActiveAction(null);
    }
  }

  return (
    <main className="page opportunity-lab-page">
      <header className="page-header">
        <div><div className="eyebrow">增长机会 / AI Research</div><h1>新赛道机会实验室</h1><p>用一句自然语言提出产品想法，AI 会拆解市场、建立数据任务并给出可追溯的机会判断。</p></div>
      </header>

      <section className="lab-query-panel">
        <form className="lab-query" onSubmit={(event) => void research(event)}>
          <Sparkles size={22} />
          <textarea aria-label="新品研究问题" rows={3} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：小学一年级开学用品组合套装" disabled={loading} />
          <button className="button button-primary" type="submit" disabled={loading || !query.trim() || !canEdit}>
            {loading ? <Loader2 className="spin" size={17} /> : <Send size={17} />}{loading ? '正在研究' : '开始研究'}
          </button>
        </form>
        {!result && !loading && (
          <div className="suggestion-row">
            <span>试试：</span>
            {exampleQueries.map((example) => <button type="button" key={example} onClick={() => setQuery(example)}>{example}<ArrowRight size={13} /></button>)}
          </div>
        )}
      </section>

      {error && <div className="alert alert-error" role="alert">{error}{result && <button type="button" disabled={!canEdit} onClick={() => void research()}>重试研究</button>}</div>}
      {notice && <div className="alert alert-success" role="status">{notice}</div>}
      {!canEdit && <div className="alert alert-info">当前为 Viewer 角色，可查看已有研究，但不能创建研究或改变机会状态。</div>}

      {loading && (
        <section className="research-loading">
          <div className="loading-orbit"><BrainCircuit size={30} /><Loader2 className="spin" size={54} /></div>
          <div><h2>AI 正在拆解这个市场</h2><p>正在生成市场层级、数据采集任务和组合假设…</p></div>
          <div className="research-steps"><span className="active"><Check size={14} />理解需求</span><span className="active"><Loader2 className="spin" size={14} />拆解市场</span><span>评估竞争</span><span>形成机会</span></div>
        </section>
      )}

      {!loading && !result && !error && (
        <section className="empty-state lab-empty"><FlaskConical size={38} /><h2>从一个尚未被验证的想法开始</h2><p>研究结果会明确区分演示数据、估算数据与真实来源，不会用没有证据的数字代替判断。</p></section>
      )}

      {!loading && result && (
        <div className="lab-results">
          <section className="panel result-summary">
            <div className="panel-header"><div><span className="eyebrow">研究摘要</span><h2>“{result.query}”</h2></div><div className="meta-stack"><span>{result.tasksCreated} 个数据任务</span><small>{formatDate(result.generatedAt)}</small></div></div>
            <p className="lead">{result.summary}</p>
          </section>

          <section className="panel">
            <div className="panel-header"><div><span className="eyebrow">MarketNode</span><h2>AI 研究树</h2></div><Network size={22} /></div>
            {result.nodes.length ? <ResearchTree nodes={result.nodes} /> : <div className="empty-state compact"><Network size={24} /><p>本次研究没有生成市场节点，请补充更具体的产品或人群。</p></div>}
          </section>

          <section className="panel">
            <div className="panel-header"><div><span className="eyebrow">Bundle Intelligence</span><h2>组合机会</h2></div><Boxes size={22} /></div>
            {result.combinations.length ? (
              <div className="combination-grid grid grid-3">
                {result.combinations.map((combination) => (
                  <article className={`combination-item fit-${combination.fit}`} key={combination.name}>
                    <div className="combination-heading"><span className={`status-badge ${combination.fit === 'recommended' ? 'success' : combination.fit === 'avoid' ? 'danger' : 'warning'}`}>{combination.fit === 'recommended' ? '推荐组合' : combination.fit === 'avoid' ? '不建议' : '继续观察'}</span><h3>{combination.name}</h3></div>
                    <div className="tag-list">{combination.items.map((item) => <span key={item}>{item}</span>)}</div>
                    <p>{combination.rationale}</p>
                  </article>
                ))}
              </div>
            ) : <div className="empty-state compact"><Layers3 size={24} /><p>当前没有足够证据形成组合建议。</p></div>}
          </section>

          <section>
            <div className="section-heading"><div><span className="eyebrow">Actionable Opportunities</span><h2>机会建议</h2></div><span>{result.opportunities.length} 个候选</span></div>
            {result.opportunities.length ? (
              <div className="opportunity-grid grid grid-2">
                {result.opportunities.map((opportunity) => (
                  <article className="panel opportunity-card" key={opportunity.id}>
                    <div className="opportunity-card-header">
                      <div><span className={`status-badge ${opportunity.evidence.length ? opportunityTone(opportunity.status) : 'warning'}`}>{opportunity.evidence.length ? statusLabels[opportunity.status] : '等待数据任务'}</span><h3>{opportunity.name}</h3><small>{opportunity.market}</small></div>
                      <div className="score-disc"><strong>{opportunity.evidence.length ? opportunity.opportunityScore.toFixed(0) : '—'}</strong><span>{opportunity.evidence.length ? '机会分' : '数据不足'}</span></div>
                    </div>
                    <p>{opportunity.summary}</p>
                    <div className="opportunity-metrics"><span>市场增长 <b className={opportunity.evidence.length ? opportunity.marketGrowth >= 0 ? 'positive' : 'negative' : ''}>{opportunity.evidence.length ? `${opportunity.marketGrowth >= 0 ? '+' : ''}${opportunity.marketGrowth.toFixed(1)}%` : '—'}</b></span><span>竞争度 <b>{opportunity.evidence.length ? opportunity.competitionScore.toFixed(0) : '—'}</b></span><span>价格空间 <b>{opportunity.evidence.length ? opportunity.priceRoom : '—'}</b></span></div>
                    <div className="recommendation"><Sparkles size={15} /><span>{opportunity.evidence.length ? opportunity.recommendedAction : '等待数据任务完成后生成建议'}</span></div>
                    <details className="evidence-block">
                      <summary><ChevronDown size={15} /> 数据依据（{opportunity.evidence.length}）</summary>
                      {opportunity.evidence.map((evidence) => <article className="evidence-item" key={evidence.id}><strong>{evidence.claim}</strong><div className="evidence-metrics">{evidence.metrics.map((metric) => <span key={metric.name}>{metric.label}: <b>{metric.value}{metric.unit ?? ''}</b></span>)}</div>{evidence.provenance.map((source, index) => <small key={`${source.source}-${index}`}>{source.source} · {source.period} · {formatDate(source.collectedAt)}{source.isEstimated ? ' · 估算数据' : ''} · 置信度 {(source.confidence * 100).toFixed(0)}%</small>)}</article>)}
                    </details>
                    <div className="card-actions">
                      <button className="button button-secondary" type="button" disabled={!canEdit || activeAction !== null || opportunity.status === 'researching'} onClick={() => void performAction(opportunity, 'watch')}>{activeAction === `${opportunity.id}:watch` ? <Loader2 className="spin" size={15} /> : <Search size={15} />}加入机会池</button>
                      <Link className="button button-primary" to="/research-jobs"><ArrowRight size={15} />创建 V2 研究</Link>
                      <button className="icon-button" type="button" title={!opportunity.evidence.length ? '等待证据数据后才能暂不考虑' : '暂不考虑'} aria-label={`暂不考虑 ${opportunity.name}`} disabled={!canEdit || activeAction !== null || opportunity.status === 'rejected' || !opportunity.evidence.length} onClick={() => void performAction(opportunity, 'reject')}>{activeAction === `${opportunity.id}:reject` ? <Loader2 className="spin" size={15} /> : <Ban size={16} />}</button>
                    </div>
                  </article>
                ))}
              </div>
            ) : <div className="empty-state"><Search size={28} /><h3>暂无可行动机会</h3><p>当前数据不足以形成机会卡，可换一个更具体的研究问题。</p></div>}
          </section>
        </div>
      )}
    </main>
  );
}
