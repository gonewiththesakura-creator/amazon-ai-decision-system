import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  DatabaseZap,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import type { ApiResponse, DataCoverageCounter, DataCoverageReport, DataTask, TaskStatus } from '../../shared/types';
import { useApp } from '../lib/AppContext';
import {
  confirmImport, previewImport, selectImportPreviewType, useApi, type ImportPreviewResult,
} from '../lib/api';

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
  const { settings, refreshKey } = useApp();
  const coverageQuery = useApi<DataCoverageReport>(
    `/api/data-coverage?marketplace=${encodeURIComponent(settings.marketplace)}`,
    refreshKey,
  );
  const [searchParams] = useSearchParams();
  const { hash } = useLocation();
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
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreviewResult | null>(null);
  const [acceptPartialImport, setAcceptPartialImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selectedImportType, setSelectedImportType] = useState('');
  const [importSource, setImportSource] = useState<'import' | 'amazon'>('import');
  const [reportStartDate, setReportStartDate] = useState('');
  const [reportEndDate, setReportEndDate] = useState('');
  const importFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (hash !== '#import-center-title' || !canEdit) return;
    const heading = document.getElementById('import-center-title');
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView?.({ block: 'start' });
  }, [canEdit, hash]);

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

  async function inspectImport(file: File | null) {
    setImportFile(file);
    setImportPreview(null);
    setAcceptPartialImport(false);
    setSelectedImportType('');
    if (!file) return;
    if (importSource === 'amazon' && (!reportStartDate || !reportEndDate || reportStartDate > reportEndDate)) {
      setError('请选择有效的 Amazon 报表起止日期。');
      return;
    }
    setImporting(true);
    setError(null);
    try {
      setImportPreview(await previewImport(file, {
        sourceType: importSource,
        marketplace: settings.marketplace,
        ...(importSource === 'amazon' ? { reportStartDate, reportEndDate } : {}),
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '文件预览失败');
    } finally {
      setImporting(false);
    }
  }

  async function confirmPreview() {
    if (!importPreview || importPreview.newCount + (importPreview.updateCount ?? 0) === 0 || !importPreview.entityType
      || (importPreview.errorCount > 0 && !acceptPartialImport)) return;
    setImporting(true);
    setError(null);
    try {
      const result = await confirmImport(importPreview.token);
      setNotice(`已确认导入 ${result.successCount} 行，${result.failureCount} 行未写入。`);
      setImportPreview(null);
      setAcceptPartialImport(false);
      setImportFile(null);
      setSelectedImportType('');
      if (importFileRef.current) importFileRef.current.value = '';
      await loadTasks(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '确认导入失败');
    } finally {
      setImporting(false);
    }
  }

  async function selectUnknownImportType(entityType: string) {
    setSelectedImportType(entityType);
    setAcceptPartialImport(false);
    if (!importPreview || !entityType) return;
    setImporting(true);
    setError(null);
    try {
      setImportPreview(await selectImportPreviewType(importPreview.token, entityType));
      setSelectedImportType('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '重新预览文件失败');
    } finally {
      setImporting(false);
    }
  }

  return (
    <main className="page data-tasks-page">
      <header className="page-header">
        <div><div className="eyebrow">数据基础设施 · 全局审计</div><h1>全部站点任务</h1><p>集中查看所有 Marketplace 的采集、同步和导入记录；顶部站点切换不会缩小这份审计列表。</p></div>
        <button className="button button-secondary" type="button" onClick={() => { void loadTasks(); coverageQuery.reload(); }} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={16} /> 刷新状态</button>
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

      <section className="panel data-coverage" aria-labelledby="data-coverage-title">
        <div className="panel-header"><div><span className="eyebrow">CURRENT MARKETPLACE · {settings.marketplace}</span><h2 id="data-coverage-title">真实数据覆盖</h2></div><DatabaseZap size={20} aria-hidden="true" /></div>
        {coverageQuery.loading && !coverageQuery.data ? (
          <p role="status" aria-label="正在检查真实数据覆盖">正在检查真实数据覆盖…</p>
        ) : coverageQuery.error && !coverageQuery.data ? (
          <div className="alert alert-error" role="alert">覆盖检查失败：{coverageQuery.error.message}<button type="button" onClick={coverageQuery.reload} aria-label="重试覆盖检查">重试</button></div>
        ) : coverageQuery.data ? (
          <ul className="data-coverage__list">
            {([
              ['主市场', coverageQuery.data.primaryMarket],
              ['活跃自有产品', coverageQuery.data.activeOwnedProducts],
              ['核心竞品', coverageQuery.data.coreCompetitors],
              ['90 天历史', coverageQuery.data.history90d],
              ['Amazon 实际数据', coverageQuery.data.amazonActual],
            ] as Array<[string, DataCoverageCounter]>).map(([label, counter]) => (
              <li key={label} aria-label={`${label}覆盖：${counter.covered} / ${counter.total}，${counter.label}`}>
                <span>{label}</span><strong>{counter.covered} / {counter.total}</strong>
                <span className={`status-badge ${coverageTone(counter.status)}`}>{counter.label}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {canEdit && (
        <section className="panel" aria-labelledby="import-center-title">
          <div className="panel-header"><div><span className="eyebrow">IMPORT CENTER V2</span><h2 id="import-center-title" tabIndex={-1} style={{ scrollMarginTop: 96 }}>审核文件导入</h2></div><FileSpreadsheet size={22} /></div>
          <div className="real-data-actions">
            <label className="field"><span>文件来源</span><select className="input" aria-label="文件来源"
              value={importSource} disabled={importing} onChange={(event) => {
                setImportSource(event.target.value as 'import' | 'amazon');
                setImportPreview(null);
                setAcceptPartialImport(false);
              }}><option value="import">SellerSprite / 产品主数据</option><option value="amazon">Amazon Business Report</option></select></label>
            {importSource === 'amazon' ? <>
              <label className="field"><span>报表开始日期</span><input className="input" type="date" value={reportStartDate}
                disabled={importing}
                onChange={(event) => { setReportStartDate(event.target.value); setImportPreview(null); setAcceptPartialImport(false); }} /></label>
              <label className="field"><span>报表结束日期</span><input className="input" type="date" value={reportEndDate}
                disabled={importing}
                onChange={(event) => { setReportEndDate(event.target.value); setImportPreview(null); setAcceptPartialImport(false); }} /></label>
              <span className="result-count">Amazon {settings.marketplace}</span>
            </> : null}
          </div>
          <div className="toolbar">
            <label className="button button-secondary" htmlFor="import-center-file" aria-disabled={importing}><Upload size={16} />{importFile?.name ?? '选择 CSV / XLSX'}</label>
            <input ref={importFileRef} id="import-center-file" className="sr-only" type="file" accept=".csv,.xlsx,.xls" disabled={importing} onChange={(event) => void inspectImport(event.target.files?.[0] ?? null)} />
            {importFile && !importPreview ? <button className="button button-secondary" type="button"
              disabled={importing || (importSource === 'amazon' && (!reportStartDate || !reportEndDate || reportStartDate > reportEndDate))}
              onClick={() => void inspectImport(importFile)}><Search size={16} />预览文件</button> : null}
            {importPreview && <><span className="status-badge neutral">{importPreview.detectedType}</span><span className="result-count">{importPreview.totalCount} 行 · {importPreview.newCount} 新增 · {importPreview.updateCount ?? 0} 更新 · {importPreview.duplicateCount} 重复 · {importPreview.errorCount} 拒绝</span>{importPreview.detectedType === 'unknown' && !importPreview.entityType && <label className="select-field"><select aria-label="选择未知文件类型" value={selectedImportType} disabled={importing} onChange={(event) => void selectUnknownImportType(event.target.value)}><option value="">选择导入类型</option><option value="product">产品快照</option><option value="market">市场快照</option><option value="review">评论</option><option value="owned_product_master">产品主数据</option></select></label>}<button className="button button-primary" type="button" disabled={importing || importPreview.newCount + (importPreview.updateCount ?? 0) === 0 || !importPreview.entityType || (importPreview.errorCount > 0 && !acceptPartialImport)} onClick={() => void confirmPreview()}>{importing ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />}确认导入</button></>}
          </div>
          {importPreview && (
            <div className="import-preview-review">
              <section aria-labelledby="import-mappings-title">
                <h3 id="import-mappings-title">字段映射</h3>
                {importPreview.mappings.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>文件列</th><th>系统字段</th></tr></thead><tbody>
                  {importPreview.mappings.map((mapping) => <tr key={mapping.sourceHeader}><td>{mapping.sourceHeader}</td><td>{mapping.targetField}</td></tr>)}
                </tbody></table></div> : <p className="muted">未识别到字段映射。</p>}
              </section>
              <section aria-labelledby="import-sample-title">
                <h3 id="import-sample-title">样例行</h3>
                <p className="muted">展示 {importPreview.previewedCount}/{importPreview.totalCount} 行样例，尚未人工逐行审核。{importPreview.rowsOmitted > 0 ? `另有 ${importPreview.rowsOmitted} 行未展开；确认导入将处理整个文件。` : ''}</p>
                {importPreview.rows.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>文件行</th>{importPreview.mappings.map((mapping) => <th key={mapping.sourceHeader}>{mapping.sourceHeader}</th>)}</tr></thead><tbody>
                  {importPreview.rows.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td>{importPreview.mappings.map((mapping) => <td key={mapping.sourceHeader}>{formatImportValue(row.values[mapping.sourceHeader])}</td>)}</tr>)}
                </tbody></table></div> : <p className="muted">没有可展示的样例行。</p>}
              </section>
              {importPreview.errorCount > 0 && <section aria-labelledby="import-errors-title">
                <h3 id="import-errors-title">拒绝明细（{importPreview.errorCount} 行）</h3>
                <div className="alert alert-warning"><ul>{importPreview.errors.map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}</ul></div>
                {importPreview.newCount + (importPreview.updateCount ?? 0) > 0 && <label className="field"><span><input type="checkbox" checked={acceptPartialImport} onChange={(event) => setAcceptPartialImport(event.target.checked)} /> 只导入有效行；我已查看拒绝原因，错误行不会写入。</span></label>}
              </section>}
              {importPreview.duplicateCount > 0 && <p className="muted">{importPreview.duplicateCount} 行重复记录不会再次写入。</p>}
            </div>
          )}
        </section>
      )}

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

function coverageTone(status: DataCoverageCounter['status']): string {
  if (status === 'complete') return 'success';
  if (status === 'partial') return 'warning';
  if (status === 'missing') return 'danger';
  return 'neutral';
}

function formatImportValue(value: unknown): string {
  if (value === null || value === undefined) return '缺失';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
