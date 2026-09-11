import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArchiveX,
  ArrowUpRight,
  BrainCircuit,
  ChevronDown,
  Filter,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import type { ApiResponse, Opportunity, OpportunityStatus, ResearchJobSummary } from '../../shared/types';
import { useApi } from '../lib/api';
import { useApp } from '../lib/AppContext';
import { findLatestResearchJobForEntity, researchJobStatusLabels } from '../lib/researchJobs';

const statusLabels: Record<OpportunityStatus, string> = {
  pending_review: '待审核',
  researching: '深度研究',
  promoted: '已转待开发',
  rejected: '已放弃',
};

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

function statusTone(status: OpportunityStatus): string {
  if (status === 'promoted') return 'success';
  if (status === 'rejected') return 'danger';
  if (status === 'researching') return 'info';
  return 'warning';
}

export default function OpportunitiesPage() {
  const { settings, refreshKey } = useApp();
  const [searchParams] = useSearchParams();
  const requestedOpportunityId = searchParams.get('opportunity');
  const canEdit = settings.role === 'admin';
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<'pool' | 'rejected'>('pool');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | OpportunityStatus>('all');
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Opportunity | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const researchJobsQuery = useApi<ResearchJobSummary[]>(
    `/api/research-jobs?marketplace=${encodeURIComponent(settings.marketplace)}`,
    refreshKey,
  );

  const loadOpportunities = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOpportunities(await request<Opportunity[]>('/api/opportunities'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法加载机会池');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setOpportunities([]);
    setRejectTarget(null);
    setActiveAction(null);
    setNotice(null);
    void loadOpportunities();
  }, [loadOpportunities, refreshKey, settings.marketplace]);

  useEffect(() => {
    if (!requestedOpportunityId || loading) return;
    const target = opportunities.find((item) => item.id === requestedOpportunityId);
    if (!target) return;
    setTab(target.status === 'rejected' ? 'rejected' : 'pool');
    setStatusFilter('all');
    window.requestAnimationFrame(() => document.getElementById(`opportunity-${target.id}`)?.scrollIntoView({ block: 'center' }));
  }, [loading, opportunities, requestedOpportunityId]);

  const poolCount = opportunities.filter((item) => item.status !== 'rejected').length;
  const rejectedCount = opportunities.length - poolCount;
  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return opportunities.filter((item) => {
      const inTab = tab === 'rejected' ? item.status === 'rejected' : item.status !== 'rejected';
      const inStatus = statusFilter === 'all' || item.status === statusFilter;
      const matchesQuery = !normalized || [item.name, item.market, item.summary, item.sourceType]
        .join(' ')
        .toLocaleLowerCase()
        .includes(normalized);
      return inTab && inStatus && matchesQuery;
    });
  }, [opportunities, query, statusFilter, tab]);

  async function runAction(opportunity: Opportunity, action: 'promote' | 'watch', reason?: string) {
    const actionKey = `${opportunity.id}:${action}`;
    setActiveAction(actionKey);
    setError(null);
    try {
      await request<unknown>(`/api/opportunities/${opportunity.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason ?? '', requestedBy: 'Admin' }),
      });
      await loadOpportunities();
      setNotice(action === 'promote' ? `“${opportunity.name}”已转为待开发项目。` : `“${opportunity.name}”已重新进入研究队列。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '更新机会失败');
    } finally {
      setActiveAction(null);
    }
  }

  async function rejectOpportunity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rejectTarget) return;
    const target = rejectTarget;
    setActiveAction(`${target.id}:reject`);
    setError(null);
    try {
      await request<unknown>(`/api/opportunities/${target.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: rejectReason.trim(), decidedBy: 'Admin' }),
      });
      setRejectTarget(null);
      setRejectReason('');
      await loadOpportunities();
      setNotice(`“${target.name}”已移入淘汰池，历史判断不会被删除。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '移入淘汰池失败');
    } finally {
      setActiveAction(null);
    }
  }

  return (
    <main className="page opportunities-page">
      <header className="page-header">
        <div><div className="eyebrow">增长机会</div><h1>机会池</h1><p>集中审核新赛道候选；被放弃的机会保留当时数据，指标改善后可重新评估。</p></div>
        <button className="button button-secondary" type="button" onClick={() => void loadOpportunities()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={16} /> 刷新</button>
      </header>

      {error && <div className="alert alert-error" role="alert">{error}<button type="button" onClick={() => void loadOpportunities()}>重试</button></div>}
      {notice && <div className="alert alert-success" role="status">{notice}</div>}
      {!canEdit && <div className="alert alert-info">当前为 Viewer 角色，可查看机会与证据，但不能流转或淘汰项目。</div>}

      <div className="segmented-control opportunity-tabs" role="tablist" aria-label="机会分组">
        <button className={tab === 'pool' ? 'active' : ''} type="button" role="tab" aria-selected={tab === 'pool'} onClick={() => { setTab('pool'); setStatusFilter('all'); }}><Sparkles size={16} />机会池 <span>{poolCount}</span></button>
        <button className={tab === 'rejected' ? 'active' : ''} type="button" role="tab" aria-selected={tab === 'rejected'} onClick={() => { setTab('rejected'); setStatusFilter('all'); }}><ArchiveX size={16} />淘汰池 <span>{rejectedCount}</span></button>
      </div>

      <div className="toolbar filter-toolbar">
        <label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索机会、市场或来源" /></label>
        {tab === 'pool' && <label className="select-field"><Filter size={15} /><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | OpportunityStatus)}><option value="all">全部状态</option><option value="pending_review">待审核</option><option value="researching">深度研究</option><option value="promoted">已转待开发</option></select></label>}
        <span className="result-count">{visibleItems.length} 个结果</span>
      </div>

      {loading ? (
        <div className="loading-state"><Loader2 className="spin" size={22} /> 正在加载机会判断…</div>
      ) : visibleItems.length === 0 ? (
        <section className="empty-state">
          {tab === 'pool' ? <Sparkles size={30} /> : <ArchiveX size={30} />}
          <h2>{query || statusFilter !== 'all' ? '没有匹配的机会' : tab === 'pool' ? '机会池还是空的' : '淘汰池还是空的'}</h2>
          <p>{query || statusFilter !== 'all' ? '清空搜索或调整筛选条件。' : tab === 'pool' ? '在新赛道实验室完成研究后，可将候选加入这里集中审核。' : '放弃的项目会保留数据、AI 判断和决策时间。'}</p>
        </section>
      ) : (
        <div className="opportunity-list">
          {visibleItems.map((opportunity) => {
            const researchJob = findLatestResearchJobForEntity(
              researchJobsQuery.data ?? [], 'opportunity', opportunity.id,
            );
            const workflowLookupPending = researchJobsQuery.loading && !researchJobsQuery.data;
            return (
            <article id={`opportunity-${opportunity.id}`} className={`panel opportunity-row ${requestedOpportunityId === opportunity.id ? 'is-target' : ''}`} key={opportunity.id}>
              <div className="opportunity-score"><strong>{opportunity.evidence.length ? opportunity.opportunityScore.toFixed(0) : '—'}</strong><span>{opportunity.evidence.length ? '机会分' : '数据不足'}</span></div>
              <div className="opportunity-main">
                <div className="opportunity-title-row"><div><span className={`status-badge ${opportunity.evidence.length ? statusTone(opportunity.status) : 'warning'}`}>{opportunity.evidence.length ? statusLabels[opportunity.status] : '等待数据任务'}</span><h2>{opportunity.name}</h2></div><small>{opportunity.sourceType} · {formatDate(opportunity.createdAt)}</small></div>
                <p>{opportunity.summary}</p>
                {opportunity.status === 'rejected' && opportunity.decision ? (
                  <div className="recommendation">
                    <ArchiveX size={15} />
                    <span>
                      淘汰原因：{opportunity.decision.reason} · {opportunity.decision.decidedBy} · {formatDate(opportunity.decision.decidedAt)}
                    </span>
                  </div>
                ) : null}
                <div className="opportunity-metrics"><span>市场 <b>{opportunity.market}</b></span><span>30D 增长 <b className={opportunity.evidence.length ? opportunity.marketGrowth >= 0 ? 'positive' : 'negative' : ''}>{opportunity.evidence.length ? `${opportunity.marketGrowth >= 0 ? '+' : ''}${opportunity.marketGrowth.toFixed(1)}%` : '—'}</b></span><span>竞争度 <b>{opportunity.evidence.length ? opportunity.competitionScore.toFixed(0) : '—'}</b></span><span>价格空间 <b>{opportunity.evidence.length ? opportunity.priceRoom : '—'}</b></span></div>
                <div className="recommendation"><BrainCircuit size={15} /><span>{opportunity.evidence.length ? opportunity.recommendedAction : '等待数据任务完成后生成建议'}</span></div>
                {researchJob ? <div className="recommendation"><ArrowUpRight size={15} /><span>V2 任务：{researchJobStatusLabels[researchJob.status]}</span></div> : null}
                <details className="evidence-block">
                  <summary><ChevronDown size={15} /> 为什么？查看证据链（{opportunity.evidence.length}）</summary>
                  {opportunity.evidence.length ? opportunity.evidence.map((evidence) => (
                    <article className="evidence-item" key={evidence.id}>
                      <strong>{evidence.claim}</strong>
                      <div className="evidence-metrics">{evidence.metrics.map((metric) => <span key={metric.name}>{metric.label}: <b>{metric.value}{metric.unit ?? ''}</b></span>)}</div>
                      {evidence.provenance.map((source, index) => <small key={`${source.source}-${index}`}>{source.source} · {source.period} · {formatDate(source.collectedAt)} · 置信度 {(source.confidence * 100).toFixed(0)}%{source.isEstimated ? ' · 估算' : ''}</small>)}
                    </article>
                  )) : <p className="muted">当前数据不足，尚未形成可展示的证据。</p>}
                </details>
              </div>
              <div className="opportunity-actions">
                {researchJob && researchJob.status !== 'approved' ? (
                  <Link className="button button-primary" to={`/research-jobs/${encodeURIComponent(researchJob.id)}`}><ArrowUpRight size={16} />打开 V2 任务</Link>
                ) : opportunity.status === 'rejected' ? (
                  <button className="button button-primary" type="button" disabled={!canEdit || activeAction !== null} onClick={() => void runAction(opportunity, 'watch', '关键指标变化，重新评估')}>
                    {activeAction === `${opportunity.id}:watch` ? <Loader2 className="spin" size={16} /> : <RotateCcw size={16} />}重新评估
                  </button>
                ) : (
                  <>
                    {researchJob?.status === 'approved' ? <button className="button button-primary" type="button" disabled={!canEdit || activeAction !== null || opportunity.status === 'promoted' || !opportunity.evidence.length} title={!opportunity.evidence.length ? '等待证据数据后才能转待开发' : undefined} onClick={() => void runAction(opportunity, 'promote')}>
                      {activeAction === `${opportunity.id}:promote` ? <Loader2 className="spin" size={16} /> : <ArrowUpRight size={16} />}{opportunity.status === 'promoted' ? '已转待开发' : '转待开发'}
                    </button> : <Link className="button button-primary" to="/research-jobs"><ArrowUpRight size={16} />创建 V2 研究</Link>}
                    {!researchJob ? <button className="button button-secondary danger-text" type="button" disabled={!canEdit || activeAction !== null || !opportunity.evidence.length || workflowLookupPending} title={!opportunity.evidence.length ? '等待证据数据后才能淘汰' : undefined} onClick={() => setRejectTarget(opportunity)}><ArchiveX size={16} />淘汰</button> : null}
                  </>
                )}
              </div>
            </article>
            );
          })}
        </div>
      )}

      {rejectTarget && canEdit && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setRejectTarget(null)}>
          <form className="modal" role="dialog" aria-modal="true" aria-labelledby="reject-title" onSubmit={(event) => void rejectOpportunity(event)}>
            <div className="modal-header"><div><span className="eyebrow">保留决策历史</span><h2 id="reject-title">将“{rejectTarget.name}”移入淘汰池？</h2></div><button className="icon-button" type="button" aria-label="关闭" onClick={() => setRejectTarget(null)}><X size={18} /></button></div>
            <p>项目不会被删除。系统会保留当前数据和判断，未来可以重新评估。</p>
            <label className="field"><span>淘汰原因</span><textarea className="input" rows={5} required value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} placeholder="例如：竞争门槛过高，当前供应链没有成本优势" /></label>
            <div className="modal-actions"><button className="button button-secondary" type="button" onClick={() => setRejectTarget(null)}>取消</button><button className="button button-danger" type="submit" disabled={activeAction !== null}>{activeAction && <Loader2 className="spin" size={16} />}确认淘汰</button></div>
          </form>
        </div>
      )}
    </main>
  );
}
