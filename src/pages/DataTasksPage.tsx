import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  DatabaseZap,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  X,
  XCircle,
} from 'lucide-react';
import type { ApiResponse, DataTask, TaskStatus } from '../../shared/types';
import { useApp } from '../lib/AppContext';

const statusLabels: Record<TaskStatus, string> = {
  pending: '等待中',
  running: '运行中',
  success: '成功',
  partial: '部分成功',
  failed: '失败',
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

function statusTone(status: TaskStatus): string {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'partial') return 'warning';
  if (status === 'running') return 'info';
  return 'neutral';
}

function StatusIcon({ status }: { status: TaskStatus }) {
  if (status === 'success') return <CheckCircle2 size={17} />;
  if (status === 'failed') return <XCircle size={17} />;
  if (status === 'partial') return <AlertCircle size={17} />;
  if (status === 'running') return <Loader2 className="spin" size={17} />;
  return <Clock3 size={17} />;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function duration(task: DataTask): string {
  if (!task.startedAt) return '尚未开始';
  const start = new Date(task.startedAt).getTime();
  const end = task.completedAt ? new Date(task.completedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return '—';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export default function DataTasksPage() {
  const { settings } = useApp();
  const [searchParams] = useSearchParams();
  const canEdit = settings.role === 'admin';
  const [tasks, setTasks] = useState<DataTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | TaskStatus>('all');
  const [marketplaceFilter, setMarketplaceFilter] = useState('all');
  const [detailTask, setDetailTask] = useState<DataTask | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const loadTasks = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      setTasks(await request<DataTask[]>('/api/data-tasks'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法加载数据任务');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const hasActiveTasks = tasks.some((task) => task.status === 'pending' || task.status === 'running');
  useEffect(() => {
    if (!hasActiveTasks) return undefined;
    const timer = window.setInterval(() => void loadTasks(false), 5000);
    return () => window.clearInterval(timer);
  }, [hasActiveTasks, loadTasks]);

  const filteredTasks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return tasks.filter((task) => {
      const matchesQuery = !normalized || [task.name, task.target, task.source, task.taskType, task.marketplace].join(' ').toLocaleLowerCase().includes(normalized);
      return matchesQuery
        && (statusFilter === 'all' || task.status === statusFilter)
        && (marketplaceFilter === 'all' || task.marketplace === marketplaceFilter);
    });
  }, [marketplaceFilter, query, statusFilter, tasks]);

  const marketplaces = useMemo(() => [...new Set(tasks.map((task) => task.marketplace).filter(Boolean))].sort(), [tasks]);

  const counts = useMemo(() => ({
    active: tasks.filter((task) => task.status === 'pending' || task.status === 'running').length,
    success: tasks.filter((task) => task.status === 'success').length,
    partial: tasks.filter((task) => task.status === 'partial').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
  }), [tasks]);

  async function retryTask(task: DataTask) {
    setRetryingId(task.id);
    setError(null);
    try {
      const retry = await request<DataTask>('/api/data-tasks/run', {
        method: 'POST',
        body: JSON.stringify({ retryTaskId: task.id }),
      });
      if (retry.status === 'failed' || retry.status === 'partial') {
        throw new Error(retry.errorLog || (retry.status === 'failed' ? '重试任务执行失败' : '重试任务仅部分完成'));
      }
      setDetailTask(null);
      setNotice(`“${task.name}”的重试任务已创建。`);
      await loadTasks(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '重试任务创建失败');
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <main className="page data-tasks-page">
      <header className="page-header">
        <div><div className="eyebrow">数据基础设施 · 全局审计</div><h1>全部站点任务</h1><p>集中查看所有 Marketplace 的采集、同步和导入记录；顶部站点切换不会缩小这份审计列表。</p></div>
        <button className="button button-secondary" type="button" onClick={() => void loadTasks()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={16} /> 刷新状态</button>
      </header>

      {error && <div className="alert alert-error" role="alert">{error}<button type="button" onClick={() => void loadTasks()}>重试</button></div>}
      {notice && <div className="alert alert-success" role="status">{notice}</div>}
      {searchParams.get('import') === 'partial' ? <div className="alert alert-warning" role="status">文件仅部分导入：{searchParams.get('success') ?? '0'} 行成功，{searchParams.get('failed') ?? '0'} 行失败。请打开对应任务查看错误。</div> : null}
      {!canEdit && <div className="alert alert-info">当前为 Viewer 角色，可查看任务与错误日志，但不能创建重试任务。</div>}

      <section className="metric-grid grid grid-4 task-summary">
        <button className={`metric ${statusFilter === 'running' ? 'selected' : ''}`} type="button" onClick={() => setStatusFilter(statusFilter === 'running' ? 'all' : 'running')}><span>运行中</span><strong>{counts.active}</strong><small>{hasActiveTasks ? '每 5 秒自动更新' : '当前无活动任务'}</small></button>
        <button className={`metric ${statusFilter === 'success' ? 'selected' : ''}`} type="button" onClick={() => setStatusFilter(statusFilter === 'success' ? 'all' : 'success')}><span>成功</span><strong>{counts.success}</strong><small>完整获取</small></button>
        <button className={`metric ${statusFilter === 'partial' ? 'selected' : ''}`} type="button" onClick={() => setStatusFilter(statusFilter === 'partial' ? 'all' : 'partial')}><span>部分成功</span><strong>{counts.partial}</strong><small>存在失败记录</small></button>
        <button className={`metric ${statusFilter === 'failed' ? 'selected' : ''}`} type="button" onClick={() => setStatusFilter(statusFilter === 'failed' ? 'all' : 'failed')}><span>失败</span><strong>{counts.failed}</strong><small>可查看日志并重试</small></button>
      </section>

      <div className="toolbar filter-toolbar">
        <label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、目标或数据源" /></label>
        <label className="select-field"><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | TaskStatus)}><option value="all">全部状态</option><option value="pending">等待中</option><option value="running">运行中</option><option value="success">成功</option><option value="partial">部分成功</option><option value="failed">失败</option></select></label>
        <label className="select-field"><select aria-label="按 Marketplace 筛选" value={marketplaceFilter} onChange={(event) => setMarketplaceFilter(event.target.value)}><option value="all">全部站点</option>{marketplaces.map((marketplace) => <option key={marketplace} value={marketplace}>Amazon {marketplace}</option>)}</select></label>
        <span className="result-count">{filteredTasks.length} 个任务</span>
      </div>

      {loading ? (
        <div className="loading-state"><Loader2 className="spin" size={22} /> 正在读取任务状态…</div>
      ) : filteredTasks.length === 0 ? (
        <section className="empty-state"><DatabaseZap size={30} /><h2>{tasks.length ? '没有匹配的数据任务' : '还没有数据任务'}</h2><p>{tasks.length ? '清空搜索或选择其他状态。' : '运行市场研究、手动刷新或导入文件后，任务会显示在这里。'}</p></section>
      ) : (
        <section className="panel table-panel">
          <div className="data-table-wrap">
            <table className="data-table task-table">
              <thead><tr><th>任务</th><th>站点</th><th>类型 / 数据源</th><th>状态</th><th>进度</th><th>开始 / 完成</th><th>耗时</th><th><span className="sr-only">详情</span></th></tr></thead>
              <tbody>{filteredTasks.map((task) => {
                const processed = task.success + task.failed;
                const progress = task.total > 0 ? Math.min(100, Math.round((processed / task.total) * 100)) : task.status === 'success' ? 100 : 0;
                return (
                  <tr key={task.id}>
                    <td><strong>{task.name}</strong><small>{task.target}</small></td>
                    <td><span className="status-badge neutral">Amazon {task.marketplace || '—'}</span></td>
                    <td><span>{task.taskType}</span><small>{task.source}</small></td>
                    <td><span className={`status-badge ${statusTone(task.status)}`}><StatusIcon status={task.status} />{statusLabels[task.status]}</span></td>
                    <td><div className="task-progress"><div className="progress-track"><i style={{ width: `${progress}%` }} /></div><span>{processed}/{task.total}</span></div><small className={task.failed ? 'negative' : ''}>{task.success} 成功 · {task.failed} 失败</small></td>
                    <td><span>{formatDate(task.startedAt)}</span><small>{formatDate(task.completedAt)}</small></td>
                    <td>{duration(task)}</td>
                    <td>{task.errorLog ? <button className="icon-button" type="button" aria-label={`查看 ${task.name} 错误详情`} onClick={() => setDetailTask(task)}><ChevronRight size={18} /></button> : (task.status === 'failed' || task.status === 'partial') ? <button className="button button-small" type="button" disabled={!canEdit || retryingId !== null} onClick={() => void retryTask(task)}>{retryingId === task.id ? <Loader2 className="spin" size={14} /> : <RotateCcw size={14} />}重试</button> : null}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </section>
      )}

      {detailTask && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setDetailTask(null)}>
          <section className="modal task-error-modal" role="dialog" aria-modal="true" aria-labelledby="task-error-title">
            <div className="modal-header"><div><span className="eyebrow">任务错误详情</span><h2 id="task-error-title">{detailTask.name}</h2></div><button className="icon-button" type="button" aria-label="关闭" onClick={() => setDetailTask(null)}><X size={18} /></button></div>
            <div className="task-error-summary"><span className={`status-badge ${statusTone(detailTask.status)}`}><StatusIcon status={detailTask.status} />{statusLabels[detailTask.status]}</span><span>{detailTask.success} 成功</span><span className="negative">{detailTask.failed} 失败</span></div>
            <pre className="error-log">{detailTask.errorLog ?? '没有记录具体错误日志。'}</pre>
            <p className="muted">重试会创建一个新任务，原任务及错误日志将继续保留。</p>
            <div className="modal-actions"><button className="button button-secondary" type="button" onClick={() => setDetailTask(null)}>关闭</button><button className="button button-primary" type="button" disabled={!canEdit || retryingId !== null} onClick={() => void retryTask(detailTask)}>{retryingId === detailTask.id ? <Loader2 className="spin" size={16} /> : <RotateCcw size={16} />}创建重试任务</button></div>
          </section>
        </div>
      )}
    </main>
  );
}
