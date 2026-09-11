import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  Filter,
  Loader2,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import type { ApiResponse, DataTask, WatchlistItem } from '../../shared/types';
import { useApp } from '../lib/AppContext';

const frequencyLabels: Record<WatchlistItem['frequency'], string> = {
  manual: '手动',
  daily: '每日',
  weekly: '每周',
};

const typeLabels: Record<string, string> = {
  market: '市场',
  market_node: '细分类目',
  owned_product: '自有 SKU',
  competitor: '竞品 ASIN',
  development_project: '待开发项目',
  opportunity: '新机会',
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

function formatDate(value: string | null): string {
  if (!value) return '尚未运行';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

export default function MonitoringPage() {
  const { settings, refreshKey, reloadSettings } = useApp();
  const canEdit = settings.role === 'admin';
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | WatchlistItem['status']>('all');
  const [frequencyFilter, setFrequencyFilter] = useState<'all' | WatchlistItem['frequency']>('all');
  const [anomalyOnly, setAnomalyOnly] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const loadWatchlist = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await request<WatchlistItem[]>('/api/watchlist'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法加载监控对象');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setItems([]);
    setQuery('');
    setTypeFilter('all');
    setStatusFilter('all');
    setFrequencyFilter('all');
    setAnomalyOnly(false);
    void loadWatchlist();
  }, [loadWatchlist, refreshKey, settings.marketplace]);

  useEffect(() => setNotice(null), [settings.marketplace]);

  const availableTypes = useMemo(() => [...new Set(items.map((item) => item.itemType))], [items]);
  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      const matchesQuery = !normalized || [item.name, item.itemId, item.latestFinding].join(' ').toLocaleLowerCase().includes(normalized);
      return matchesQuery
        && (typeFilter === 'all' || item.itemType === typeFilter)
        && (statusFilter === 'all' || item.status === statusFilter)
        && (frequencyFilter === 'all' || item.frequency === frequencyFilter)
        && (!anomalyOnly || item.anomaly);
    });
  }, [anomalyOnly, frequencyFilter, items, query, statusFilter, typeFilter]);

  const anomalies = items.filter((item) => item.anomaly).length;
  const active = items.filter((item) => item.status === 'active').length;
  const scheduled = items.filter((item) => item.frequency !== 'manual' && item.status === 'active').length;

  async function refreshItem(item: WatchlistItem) {
    setRefreshingId(item.id);
    setError(null);
    setNotice(null);
    try {
      const task = await request<DataTask>(`/api/watchlist/${encodeURIComponent(item.id)}/refresh`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (task.status === 'failed' || task.status === 'partial') {
        throw new Error(task.errorLog || (task.status === 'failed' ? '刷新任务执行失败' : '刷新任务仅部分完成'));
      }
      await reloadSettings();
      setNotice(`“${item.name}”的刷新任务已创建，可在数据任务中心查看进度。`);
      await loadWatchlist();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '手动刷新失败');
    } finally {
      setRefreshingId(null);
    }
  }

  async function updateItem(item: WatchlistItem, patch: Partial<Pick<WatchlistItem, 'frequency' | 'status'>>) {
    setUpdatingId(item.id);
    setError(null);
    setNotice(null);
    try {
      const updated = await request<WatchlistItem>(`/api/watchlist/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setItems((current) => current.map((currentItem) => currentItem.id === updated.id ? updated : currentItem));
      setNotice(patch.status ? `“${item.name}”已${patch.status === 'paused' ? '暂停' : '恢复'}监控。` : `“${item.name}”已改为${frequencyLabels[updated.frequency]}更新。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '监控设置更新失败');
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <main className="page monitoring-page">
      <header className="page-header">
        <div><div className="eyebrow">持续监控</div><h1>监控中心</h1><p>跟踪市场、SKU、竞品和产品机会；异常会进入今日 AI 简报。</p></div>
        <button className="button button-secondary" type="button" onClick={() => void loadWatchlist()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={16} /> 刷新列表</button>
      </header>

      {error && <div className="alert alert-error" role="alert">{error}<button type="button" onClick={() => void loadWatchlist()}>重试</button></div>}
      {notice && <div className="alert alert-success" role="status">{notice}</div>}
      {!canEdit && <div className="alert alert-info">当前为 Viewer 角色，可查看监控结果，但不能手动创建刷新任务。</div>}

      <section className="metric-grid grid grid-4">
        <div className="metric"><span>监控对象</span><strong>{items.length}</strong><small>所有类型</small></div>
        <div className="metric"><span>运行中</span><strong>{active}</strong><small>{items.length ? `${Math.round((active / items.length) * 100)}% 已启用` : '尚无对象'}</small></div>
        <div className={`metric ${anomalies ? 'metric-alert' : ''}`}><span>当前异常</span><strong>{anomalies}</strong><small>{anomalies ? '需要优先处理' : '暂无需处理'}</small></div>
        <div className="metric"><span>已设置频率</span><strong>{scheduled}</strong><small>调度器未启用，当前需手动刷新</small></div>
      </section>

      <section className="panel monitoring-controls">
        <div className="toolbar filter-toolbar">
          <label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、ASIN 或最新发现" /></label>
          <label className="select-field"><Filter size={15} /><select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="all">全部类型</option>{availableTypes.map((type) => <option value={type} key={type}>{typeLabels[type] ?? type}</option>)}</select></label>
          <label className="select-field"><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | WatchlistItem['status'])}><option value="all">全部状态</option><option value="active">运行中</option><option value="paused">已暂停</option></select></label>
          <label className="select-field"><select value={frequencyFilter} onChange={(event) => setFrequencyFilter(event.target.value as 'all' | WatchlistItem['frequency'])}><option value="all">全部频率</option><option value="manual">手动</option><option value="daily">每日</option><option value="weekly">每周</option></select></label>
          <label className="checkbox-field"><input type="checkbox" checked={anomalyOnly} onChange={(event) => setAnomalyOnly(event.target.checked)} /><span>仅看异常</span></label>
        </div>
      </section>

      {loading ? (
        <div className="loading-state"><Loader2 className="spin" size={22} /> 正在加载监控状态…</div>
      ) : filteredItems.length === 0 ? (
        <section className="empty-state">
          <Activity size={30} />
          <h2>{items.length ? '没有匹配的监控对象' : '还没有监控对象'}</h2>
          <p>{items.length ? '调整筛选条件或关闭“仅看异常”。' : '从市场、SKU、待开发项目或机会页加入监控。'}</p>
        </section>
      ) : (
        <section className="monitor-list">
          {filteredItems.map((item) => (
            <article className={`panel monitor-row ${item.anomaly ? 'has-anomaly' : ''}`} key={item.id}>
              <div className={`monitor-icon ${item.anomaly ? 'danger' : item.status === 'active' ? 'success' : 'neutral'}`}>
                {item.anomaly ? <AlertTriangle size={20} /> : item.status === 'active' ? <Activity size={20} /> : <PauseCircle size={20} />}
              </div>
              <div className="monitor-main">
                <div className="monitor-heading"><div><span className="eyebrow">{typeLabels[item.itemType] ?? item.itemType}</span><h2>{item.name}</h2></div><div className="badge-row"><span className={`status-badge ${item.status === 'active' ? 'success' : 'neutral'}`}>{item.status === 'active' ? '运行中' : '已暂停'}</span>{item.anomaly && <span className="status-badge danger">发现异常</span>}</div></div>
                <div className={`latest-finding ${item.anomaly ? 'danger-copy' : ''}`}>
                  {item.anomaly ? <AlertTriangle size={15} /> : <ShieldCheck size={15} />}
                  <span>{item.latestFinding || '尚无监控结论，运行一次刷新以建立基线。'}</span>
                </div>
                <div className="monitor-meta">
                  <span><CalendarClock size={14} />频率：{frequencyLabels[item.frequency]}</span>
                  <span>上次：{formatDate(item.lastRunAt)}</span>
                  <span>{item.frequency === 'manual' ? '执行方式：手动触发' : `计划频率：${frequencyLabels[item.frequency]}（未自动执行）`}</span>
                </div>
              </div>
              <div className="monitor-actions">
                <label className="select-field monitor-frequency">
                  <CalendarClock size={15} aria-hidden="true" />
                  <select aria-label={`${item.name} 刷新频率`} value={item.frequency} disabled={!canEdit || updatingId !== null} onChange={(event) => void updateItem(item, { frequency: event.target.value as WatchlistItem['frequency'] })}>
                    <option value="manual">手动</option><option value="daily">每日</option><option value="weekly">每周</option>
                  </select>
                </label>
                <button className="icon-button" type="button" aria-label={`${item.status === 'active' ? '暂停' : '恢复'} ${item.name}`} title={item.status === 'active' ? '暂停监控' : '恢复监控'} disabled={!canEdit || updatingId !== null} onClick={() => void updateItem(item, { status: item.status === 'active' ? 'paused' : 'active' })}>
                  {updatingId === item.id ? <Loader2 className="spin" size={16} /> : item.status === 'active' ? <PauseCircle size={16} /> : <PlayCircle size={16} />}
                </button>
                <button className="button button-secondary" type="button" disabled={!canEdit || refreshingId !== null || item.status === 'paused'} onClick={() => void refreshItem(item)}>
                  {refreshingId === item.id ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                  {refreshingId === item.id ? '正在创建' : item.status === 'paused' ? '已暂停' : '手动刷新'}
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
