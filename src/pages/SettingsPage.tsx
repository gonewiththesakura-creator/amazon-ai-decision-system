import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Bot,
  CheckCircle2,
  CircleOff,
  CloudCog,
  Database,
  FileSpreadsheet,
  Loader2,
  PackagePlus,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Shield,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  X,
} from 'lucide-react';
import type {
  ApiResponse,
  AppSettings,
  DataSource,
  Product,
} from '../../shared/types';
import { ProductImage } from '../components/ProductImage';
import { useApp } from '../lib/AppContext';
import { importFailureMessage, importSummary, type FileImportResult, type ImportSource } from '../lib/importResult';

type SettingsTab = 'general' | 'products' | 'sources' | 'ai' | 'import';
type ImportEntityType = 'auto' | 'product' | 'market' | 'review';

interface OwnedProductForm {
  asin: string;
  sku: string;
  internalName: string;
  brand: string;
  title: string;
  imageUrl: string;
  marketplace: string;
  productType: string;
  marketNodeId: string;
  keywords: string;
  monitoringEnabled: boolean;
}

type BatchRowStatus = 'idle' | 'saving' | 'success' | 'error';
interface BatchProductRow extends OwnedProductForm {
  rowKey: string;
  status: BatchRowStatus;
  rowError: string;
}

const initialProductForm: OwnedProductForm = {
  asin: '',
  sku: '',
  internalName: '',
  brand: '',
  title: '',
  imageUrl: '',
  marketplace: '',
  productType: 'Memory Foam Pillow',
  marketNodeId: '',
  keywords: '',
  monitoringEnabled: true,
};

function buildBatchRows(products: Product[], marketplace: string): BatchProductRow[] {
  return Array.from({ length: 4 }, (_, index) => {
    const product = products[index];
    return {
      ...initialProductForm,
      asin: product?.asin ?? '',
      sku: product?.sku ?? '',
      internalName: product?.internalName ?? '',
      brand: product?.brand ?? '',
      title: product?.title ?? '',
      imageUrl: product?.imageUrl ?? '',
      marketplace,
      productType: product?.productType ?? initialProductForm.productType,
      marketNodeId: product?.marketNodeId ?? '',
      keywords: product?.keywords?.join('，') ?? '',
      monitoringEnabled: product?.monitoringEnabled ?? true,
      rowKey: product?.id ?? `new-${index + 1}`,
      status: product ? 'success' : 'idle',
      rowError: '',
    };
  });
}

const tabs: Array<{ value: SettingsTab; label: string; icon: typeof Settings2 }> = [
  { value: 'general', label: '基础设置', icon: Settings2 },
  { value: 'products', label: '自有产品', icon: PackagePlus },
  { value: 'sources', label: '数据源', icon: Database },
  { value: 'ai', label: 'AI 配置', icon: Bot },
  { value: 'import', label: '文件导入', icon: FileSpreadsheet },
];

function parseTab(value: string | null): SettingsTab {
  return value === 'products' || value === 'sources' || value === 'ai' || value === 'import' ? value : 'general';
}

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
  if (!response.ok) throw new Error(payload.error ?? payload.message ?? `请求失败 (${response.status})`);
  if (payload.data === undefined) throw new Error('接口没有返回数据');
  return payload.data;
}

function formatDate(value: string | null): string {
  if (!value) return '从未同步';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function sourceTone(status: DataSource['status']): string {
  if (status === 'connected') return 'success';
  if (status === 'disconnected') return 'danger';
  return 'warning';
}

function sourceStatus(status: DataSource['status']): string {
  if (status === 'connected') return '已连接';
  if (status === 'disconnected') return '未连接';
  return '需要配置';
}

export default function SettingsPage() {
  const { settings: appSettings, reloadSettings: reloadAppSettings, refreshKey } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<SettingsTab>(() => parseTab(searchParams.get('tab')));
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [sources, setSources] = useState<DataSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showProductForm, setShowProductForm] = useState(false);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [deletingProductId, setDeletingProductId] = useState<string | null>(null);
  const [showBatchForm, setShowBatchForm] = useState(false);
  const [productForm, setProductForm] = useState<OwnedProductForm>(initialProductForm);
  const [batchRows, setBatchRows] = useState<BatchProductRow[]>([]);
  const [batchSaving, setBatchSaving] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [importSource, setImportSource] = useState<ImportSource>('import');
  const [importEntityType, setImportEntityType] = useState<ImportEntityType>('auto');
  const [importResearchJobId, setImportResearchJobId] = useState('');
  const [importWarnings, setImportWarnings] = useState<string[]>([]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [settingsResult, productsResult, sourcesResult] = await Promise.allSettled([
      request<AppSettings>('/api/settings'),
      request<Product[]>('/api/owned-products'),
      request<DataSource[]>('/api/data-sources'),
    ]);
    const errors: string[] = [];
    if (settingsResult.status === 'fulfilled') {
      setSettings(settingsResult.value);
      setDraft(settingsResult.value);
    } else {
      errors.push(settingsResult.reason instanceof Error ? settingsResult.reason.message : '基础设置加载失败');
    }
    if (productsResult.status === 'fulfilled') setProducts(productsResult.value);
    else errors.push(productsResult.reason instanceof Error ? productsResult.reason.message : '自有产品加载失败');
    if (sourcesResult.status === 'fulfilled') setSources(sourcesResult.value);
    else errors.push(sourcesResult.reason instanceof Error ? sourcesResult.reason.message : '数据源加载失败');
    setError(errors.length ? errors.join('；') : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    setProducts([]);
    setSources([]);
    setSelectedFile(null);
    setShowProductForm(false);
    void loadSettings();
  }, [appSettings.marketplace, loadSettings, refreshKey]);

  useEffect(() => {
    setTab(parseTab(searchParams.get('tab')));
  }, [searchParams]);

  useEffect(() => {
    setProductForm((current) => ({ ...current, marketplace: appSettings.marketplace }));
  }, [appSettings.marketplace]);

  const isViewer = settings?.role === 'viewer';

  function openBatchForm() {
    setBatchRows(buildBatchRows(products, appSettings.marketplace));
    setShowBatchForm(true);
    setError(null);
  }

  function updateBatchRow(index: number, patch: Partial<BatchProductRow>) {
    setBatchRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch, status: row.status === 'success' ? 'success' : 'idle', rowError: '' } : row));
  }

  function openProductEditor(product?: Product) {
    setEditingProductId(product?.id ?? null);
    setProductForm(product ? {
      asin: product.asin,
      sku: product.sku ?? '',
      internalName: product.internalName ?? '',
      brand: product.brand,
      title: product.title,
      imageUrl: product.imageUrl,
      marketplace: appSettings.marketplace,
      productType: product.productType,
      marketNodeId: product.marketNodeId,
      keywords: product.keywords?.join('，') ?? '',
      monitoringEnabled: product.monitoringEnabled ?? true,
    } : { ...initialProductForm, marketplace: appSettings.marketplace });
    setShowProductForm(true);
    setError(null);
  }

  async function saveSettings(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await request<AppSettings>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify(draft),
      });
      setSettings(updated);
      setDraft(updated);
      await reloadAppSettings();
      setNotice('设置已保存。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '设置保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function toggleDemo(enabled: boolean) {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await request<AppSettings>('/api/settings/demo', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      });
      setSettings(updated);
      setDraft(updated);
      await reloadAppSettings();
      setNotice(enabled ? '已进入 Demo 模式，所有演示数据都会明确标识。' : '已退出 Demo 模式。尚未接入真实数据时，页面会显示空状态。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Demo 模式切换失败');
    } finally {
      setSaving(false);
    }
  }

  async function addProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const product = await request<Product>(editingProductId ? `/api/owned-products/${encodeURIComponent(editingProductId)}` : '/api/owned-products', {
        method: editingProductId ? 'PATCH' : 'POST',
        body: JSON.stringify({
          ...(editingProductId ? {
            sku: productForm.sku,
            internalName: productForm.internalName,
            brand: productForm.brand,
            title: productForm.title,
            imageUrl: productForm.imageUrl,
            productType: productForm.productType,
            marketNodeId: productForm.marketNodeId || undefined,
            keywords: productForm.keywords.split(/[,，\n]/).map((keyword) => keyword.trim()).filter(Boolean),
            monitoringEnabled: productForm.monitoringEnabled,
          } : productForm),
          ...(!editingProductId ? {
            marketplace: appSettings.marketplace,
            isOwned: true,
            keywords: productForm.keywords.split(/[,，\n]/).map((keyword) => keyword.trim()).filter(Boolean),
          } : {}),
        }),
      });
      setProducts((current) => editingProductId
        ? current.map((item) => item.id === product.id ? product : item)
        : [product, ...current]);
      await reloadAppSettings();
      setProductForm({ ...initialProductForm, marketplace: appSettings.marketplace });
      setEditingProductId(null);
      setShowProductForm(false);
      setNotice(editingProductId ? `已更新 ${product.internalName || product.sku || product.asin}。` : `已添加 ${product.internalName || product.sku || product.asin}，可以开始建立历史快照和竞品关系。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : editingProductId ? '更新自有产品失败' : '添加自有产品失败');
    } finally {
      setSaving(false);
    }
  }

  async function removeProduct(product: Product) {
    if (!window.confirm(`确认删除 ${product.internalName || product.sku || product.asin}？相关快照、竞品关系和监控记录也会删除，此操作不可撤销。`)) return;
    setDeletingProductId(product.id);
    setError(null);
    try {
      await request<{ id: string; deleted: boolean }>(`/api/owned-products/${encodeURIComponent(product.id)}`, { method: 'DELETE' });
      setProducts((current) => current.filter((item) => item.id !== product.id));
      await reloadAppSettings();
      setNotice(`已删除 ${product.internalName || product.sku || product.asin}。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '删除产品失败');
    } finally {
      setDeletingProductId(null);
    }
  }

  async function initializeProducts(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBatchSaving(true);
    setError(null);
    let completed = batchRows.filter((row) => row.status === 'success').length;
    let failures = 0;

    for (let index = 0; index < batchRows.length; index += 1) {
      const row = batchRows[index];
      if (row.status === 'success') continue;
      setBatchRows((current) => current.map((item, rowIndex) => rowIndex === index ? { ...item, status: 'saving', rowError: '' } : item));
      try {
        const product = await request<Product>('/api/owned-products', {
          method: 'POST',
          body: JSON.stringify({
            ...row,
            marketplace: appSettings.marketplace,
            isOwned: true,
            keywords: row.keywords.split(/[,，\n]/).map((keyword) => keyword.trim()).filter(Boolean),
          }),
        });
        completed += 1;
        setProducts((current) => current.some((item) => item.id === product.id) ? current : [...current, product]);
        setBatchRows((current) => current.map((item, rowIndex) => rowIndex === index ? { ...item, rowKey: product.id, status: 'success', rowError: '' } : item));
      } catch (caught) {
        failures += 1;
        const message = caught instanceof Error ? caught.message : '产品录入失败';
        setBatchRows((current) => current.map((item, rowIndex) => rowIndex === index ? { ...item, status: 'error', rowError: message } : item));
      }
    }

    await reloadAppSettings();
    setBatchSaving(false);
    if (failures === 0 && completed === batchRows.length) {
      setShowBatchForm(false);
      setNotice(`${completed} 个自有 SKU 已完成初始化，可以继续导入快照并建立竞品关系。`);
    } else {
      setNotice(`已完成 ${completed}/${batchRows.length} 行；失败行已保留，可修正后再次提交。`);
    }
  }

  async function importFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFile) return;
    if (importEntityType === 'review' && !importResearchJobId.trim()) {
      setError('评论导入必须填写目标 Research Job ID。');
      return;
    }
    const extension = selectedFile.name.split('.').pop()?.toLocaleLowerCase();
    if (extension !== 'csv' && extension !== 'xlsx' && extension !== 'xls') {
      setError('请选择 CSV、XLSX 或 XLS 文件。');
      return;
    }
    setImporting(true);
    setError(null);
    setImportWarnings([]);
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('sourceType', importSource);
      formData.append('marketplace', appSettings.marketplace);
      if (importEntityType !== 'auto') formData.append('entityType', importEntityType);
      if (importEntityType === 'review') formData.append('researchJobId', importResearchJobId.trim());
      const result = await request<FileImportResult>(extension === 'csv' ? '/api/import/csv' : '/api/import/xlsx', {
        method: 'POST',
        body: formData,
      });
      const failure = importFailureMessage(result);
      if (failure) {
        setError(failure);
        setImportWarnings(result.errors);
        return;
      }
      await reloadAppSettings();
      if (result.failureCount > 0 || result.task.status === 'partial') {
        setNotice(null);
        setImportWarnings([importSummary(result), ...result.errors]);
      } else {
        setNotice(`${importSummary(result)} “${selectedFile.name}”的任务记录已保留。`);
        setImportWarnings([]);
      }
      setSelectedFile(null);
      setFileInputKey((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '文件导入失败');
    } finally {
      setImporting(false);
    }
  }

  if (loading) {
    return <main className="page settings-page"><header className="page-header"><div><div className="eyebrow">系统管理</div><h1>设置</h1></div></header><div className="loading-state"><Loader2 className="spin" size={22} /> 正在加载系统设置…</div></main>;
  }

  if (!draft || !settings) {
    return <main className="page settings-page"><header className="page-header"><div><div className="eyebrow">系统管理</div><h1>设置</h1></div></header><section className="empty-state"><CircleOff size={30} /><h2>设置暂时不可用</h2><p>{error ?? '接口没有返回设置数据。'}</p><button className="button button-primary" type="button" onClick={() => void loadSettings()}><RefreshCw size={16} />重新加载</button></section></main>;
  }

  return (
    <main className="page settings-page">
      <header className="page-header">
        <div><div className="eyebrow">系统管理</div><h1>设置</h1><p>管理自有产品、数据连接、刷新策略与 AI 分析配置。</p></div>
        <div className="settings-sync"><span>最近成功同步</span><strong>{formatDate(settings.lastSuccessfulSync)}</strong></div>
      </header>

      {error && <div className="alert alert-error" role="alert">{error}<button type="button" onClick={() => void loadSettings()}>重新加载</button></div>}
      {notice && <div className="alert alert-success" role="status">{notice}</div>}
      {importWarnings.length ? <div className="alert alert-warning" role="status"><span>{importWarnings.slice(0, 2).join('；')}</span><Link to="/data-tasks">查看数据任务</Link></div> : null}
      {isViewer && <div className="alert alert-info"><Shield size={17} />当前为 Viewer 权限预览：业务写操作已禁用，但可在基础设置中切回 Admin 退出预览。本版本不包含用户认证。</div>}

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {tabs.map((item) => {
            const Icon = item.icon;
            return <button className={tab === item.value ? 'active' : ''} type="button" key={item.value} onClick={() => { setTab(item.value); setSearchParams({ tab: item.value }); }}><Icon size={17} /><span>{item.label}</span></button>;
          })}
        </nav>

        <div className="settings-content">
          {tab === 'general' && (
            <form className="panel settings-section" onSubmit={(event) => void saveSettings(event)}>
              <div className="panel-header"><div><span className="eyebrow">Workspace</span><h2>基础设置</h2><p>这些选项决定系统的默认分析上下文。</p></div><Settings2 size={22} /></div>
              <div className="form-grid grid grid-2">
                <label className="field"><span>Marketplace</span><select className="input" value={draft.marketplace} disabled={isViewer} onChange={(event) => setDraft({ ...draft, marketplace: event.target.value })}><option value="US">Amazon US</option><option value="CA">Amazon CA</option><option value="UK">Amazon UK</option><option value="DE">Amazon DE</option><option value="JP">Amazon JP</option></select></label>
                <label className="field"><span>币种</span><select className="input" value={draft.currency} disabled={isViewer} onChange={(event) => setDraft({ ...draft, currency: event.target.value })}><option value="USD">USD ($)</option><option value="CAD">CAD (C$)</option><option value="GBP">GBP (£)</option><option value="EUR">EUR (€)</option><option value="JPY">JPY (¥)</option></select></label>
                <label className="field"><span>时区</span><select className="input" value={draft.timezone} disabled={isViewer} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}><option value="Asia/Shanghai">Asia/Shanghai</option><option value="America/Los_Angeles">America/Los_Angeles</option><option value="America/New_York">America/New_York</option><option value="Europe/London">Europe/London</option></select></label>
                <label className="field"><span>默认市场节点</span><input className="input" value={draft.defaultMarketId} disabled={isViewer} onChange={(event) => setDraft({ ...draft, defaultMarketId: event.target.value })} placeholder="MarketNode ID" /></label>
              </div>

              <div className="setting-group">
                <div><h3>权限预览模式</h3><p>用于预览 Viewer 的只读界面，不代表已配置登录鉴权；切回 Admin 即可退出。</p></div>
                <div className="segmented-control" role="radiogroup" aria-label="权限预览模式">
                  <button className={draft.role === 'admin' ? 'active' : ''} type="button" role="radio" aria-checked={draft.role === 'admin'} onClick={() => setDraft({ ...draft, role: 'admin' })}><Shield size={15} />Admin</button>
                  <button className={draft.role === 'viewer' ? 'active' : ''} type="button" role="radio" aria-checked={draft.role === 'viewer'} onClick={() => setDraft({ ...draft, role: 'viewer' })}><UserRound size={15} />Viewer 预览</button>
                </div>
              </div>

              <div className="setting-group demo-setting">
                <div><h3>Demo 模式</h3><p>演示数据会在全局显著标识，不会被描述为真实 Amazon 数据。</p></div>
                <label className="switch"><input type="checkbox" checked={draft.mode === 'demo'} disabled={saving || isViewer} onChange={(event) => void toggleDemo(event.target.checked)} /><span aria-hidden="true" /></label>
              </div>

              <div className="settings-actions"><button className="button button-primary" type="submit" disabled={saving || (isViewer && draft.role !== 'admin')}>{saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}{saving ? '保存中' : isViewer && draft.role === 'admin' ? '退出 Viewer 预览' : '保存基础设置'}</button></div>
            </form>
          )}

          {tab === 'products' && (
            <section className="panel settings-section">
              <div className="panel-header"><div><span className="eyebrow">Owned Products</span><h2>自有产品</h2><p>SKU 不写死在系统中，可按实际业务增减并关联 MarketNode。</p></div><button className="button button-primary" type="button" disabled={isViewer} onClick={() => products.length >= 4 ? openProductEditor() : openBatchForm()}><Plus size={16} />{products.length >= 4 ? '添加产品' : products.length ? '继续批量初始化' : '批量初始化自有 SKU'}</button></div>
              {products.length === 0 ? (
                <div className="empty-state compact"><PackagePlus size={27} /><h3>尚未录入自有 SKU</h3><p>使用批量向导初始化现有业务；每行独立保存，完成后再导入快照与设置竞品。</p><button className="button button-primary" type="button" disabled={isViewer} onClick={openBatchForm}><Plus size={16} />批量初始化自有 SKU</button></div>
              ) : (
                <div className="data-table-wrap"><table className="data-table"><thead><tr><th>产品</th><th>ASIN / SKU</th><th>类型</th><th>Marketplace</th><th>市场节点</th><th>监控</th><th><span className="visually-hidden">管理</span></th></tr></thead><tbody>{products.map((product) => <tr key={product.id}><td><div className="product-cell"><ProductImage src={product.imageUrl} alt={product.title} size="sm" /><div><strong>{product.internalName || product.title}</strong><small>{product.brand}</small></div></div></td><td><span>{product.asin}</span><small>{product.sku || '未设置 SKU'}</small></td><td>{product.productType}</td><td>{product.marketplace}</td><td>{product.marketNodeId}</td><td><span className={`status-badge ${product.monitoringEnabled ? 'success' : 'neutral'}`}>{product.monitoringEnabled ? '已启用' : '未启用'}</span></td><td><div className="row-actions"><button className="icon-button" type="button" aria-label={`编辑 ${product.internalName || product.asin}`} title="编辑产品" disabled={isViewer || deletingProductId !== null} onClick={() => openProductEditor(product)}><Pencil size={15} /></button><button className="icon-button danger-text" type="button" aria-label={`删除 ${product.internalName || product.asin}`} title="删除产品" disabled={isViewer || deletingProductId !== null} onClick={() => void removeProduct(product)}>{deletingProductId === product.id ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}</button></div></td></tr>)}</tbody></table></div>
              )}
            </section>
          )}

          {tab === 'sources' && (
            <section className="settings-section">
              <div className="section-heading"><div><span className="eyebrow">Data Adapters</span><h2>数据源</h2><p>业务逻辑通过统一 Adapter 使用数据源，页面不会直接调用第三方服务。</p></div><button className="button button-secondary" type="button" onClick={() => void loadSettings()}><RefreshCw size={16} />刷新状态</button></div>
              {sources.length === 0 ? (
                <div className="empty-state"><CloudCog size={30} /><h3>尚未配置数据源</h3><p>可以先通过 CSV/XLSX 导入真实文件，或在基础设置中进入 Demo 模式。</p></div>
              ) : (
                <div className="source-grid grid grid-2">{sources.map((source) => <article className="panel source-card" key={source.id}><div className="source-card-heading"><div className="source-icon"><Database size={20} /></div><div><h3>{source.name}</h3><span>{source.type.toLocaleUpperCase()}</span></div><span className={`status-badge ${sourceTone(source.status)}`}>{sourceStatus(source.status)}</span></div><p>{source.description}</p><div className="source-footer"><span>最近同步</span><strong>{formatDate(source.lastSyncAt)}</strong></div></article>)}</div>
              )}
            </section>
          )}

          {tab === 'ai' && (
            <form className="panel settings-section" onSubmit={(event) => void saveSettings(event)}>
              <div className="panel-header"><div><span className="eyebrow">AI Service</span><h2>AI 配置</h2><p>模型只生成结构化判断，关键结论仍需证据链和人工决策。</p></div><Bot size={22} /></div>
              <div className="form-grid grid grid-2">
                <label className="field"><span>分析模型</span><select className="input" value="rule-engine-v1" disabled><option value="rule-engine-v1">Rule Engine v1（本地）</option></select><small>当前版本仅启用可重复验证的本地规则引擎。</small></label>
                <label className="field"><span>默认刷新频率</span><select className="input" value={draft.refreshFrequency} disabled={isViewer} onChange={(event) => setDraft({ ...draft, refreshFrequency: event.target.value as AppSettings['refreshFrequency'] })}><option value="manual">手动</option><option value="daily">每日</option><option value="weekly">每周</option></select><small>具体监控对象可在监控中心使用独立频率。</small></label>
              </div>
              <div className="ai-policy-grid grid grid-3"><div><CheckCircle2 size={18} /><strong>证据优先</strong><span>结论必须指向指标与数据来源</span></div><div><Sparkles size={18} /><strong>结果缓存</strong><span>输入数据未变化时复用已有 Insight</span></div><div><Shield size={18} /><strong>拒绝编造</strong><span>数据不足时明确降低置信度</span></div></div>
              <div className="settings-actions"><button className="button button-primary" type="submit" disabled={saving || isViewer}>{saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}{saving ? '保存中' : '保存 AI 配置'}</button></div>
            </form>
          )}

          {tab === 'import' && (
            <section className="panel settings-section">
              <div className="panel-header"><div><span className="eyebrow">CSV / XLSX</span><h2>文件导入</h2><p>支持产品、市场快照和 Research Job 评论样本；第三方文件先经过来源 Adapter 再落库。</p></div><FileSpreadsheet size={22} /></div>
              <form className="import-form" onSubmit={(event) => void importFile(event)}>
                <div className="import-context">
                  <label className="field"><span>文件来源</span><select className="input" value={importSource} disabled={isViewer || importing} onChange={(event) => setImportSource(event.target.value as ImportSource)}><option value="import">SellerSprite 报表</option><option value="amazon">Amazon 报表</option></select><small>来源会写入每条快照的证据链。</small></label>
                  <label className="field"><span>归属站点</span><input className="input" value={`Amazon ${appSettings.marketplace}`} disabled readOnly /><small>未包含 Marketplace 列时使用顶部当前站点。</small></label>
                  <label className="field"><span>数据类型</span><select className="input" value={importEntityType} disabled={isViewer || importing} onChange={(event) => setImportEntityType(event.target.value as ImportEntityType)}><option value="auto">自动识别</option><option value="product">产品快照</option><option value="market">市场快照</option><option value="review">评论样本</option></select><small>评论会追加到指定 Research Job，不覆盖历史样本。</small></label>
                  {importEntityType === 'review' ? <label className="field"><span>Research Job ID</span><input className="input" required value={importResearchJobId} disabled={isViewer || importing} onChange={(event) => setImportResearchJobId(event.target.value)} placeholder="目标研究任务 ID" /><small>任务必须属于当前站点且尚未完成。</small></label> : null}
                </div>
                <label className={`file-drop ${selectedFile ? 'has-file' : ''}`}>
                  <input key={fileInputKey} type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" disabled={isViewer || importing} onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)} />
                  {selectedFile ? <><FileSpreadsheet size={30} /><strong>{selectedFile.name}</strong><span>{(selectedFile.size / 1024).toFixed(1)} KB · 点击可更换文件</span></> : <><Upload size={30} /><strong>选择 CSV 或 XLSX 文件</strong><span>单个文件将作为独立数据任务处理</span></>}
                </label>
                <div className="import-notes"><h3>导入规则</h3><ul><li>产品与市场行必须包含完整快照必填字段；缺失字段时该行不会写入。</li><li>评论行至少包含 ReviewId、ProductId 和 ReviewText；Rating 与 Date 缺失时保留为空。</li><li>模板见 <code>examples/product-snapshots.csv</code>、<code>examples/market-snapshots.csv</code>、<code>examples/reviews.csv</code>。</li><li>来源、采集时间和失败原因会保留在证据链与数据任务中。</li></ul></div>
                <div className="settings-actions"><button className="button button-primary" type="submit" disabled={isViewer || importing || !selectedFile || (importEntityType === 'review' && !importResearchJobId.trim())}>{importing ? <Loader2 className="spin" size={16} /> : <Upload size={16} />}{importing ? '正在上传' : '开始导入'}</button></div>
              </form>
            </section>
          )}
        </div>
      </div>

      {showProductForm && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowProductForm(false)}>
          <form className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="add-product-title" onSubmit={(event) => void addProduct(event)}>
            <div className="modal-header"><div><span className="eyebrow">Owned Product</span><h2 id="add-product-title">{editingProductId ? '编辑自有产品' : '添加自有产品'}</h2></div><button className="icon-button" type="button" aria-label="关闭" onClick={() => { setShowProductForm(false); setEditingProductId(null); }}><X size={18} /></button></div>
            <div className="form-grid grid grid-2">
              <label className="field"><span>ASIN</span><input className="input" required pattern="[A-Za-z0-9]{10}" maxLength={10} disabled={Boolean(editingProductId)} value={productForm.asin} onChange={(event) => setProductForm({ ...productForm, asin: event.target.value.toLocaleUpperCase() })} placeholder="10 位 ASIN" /><small>{editingProductId ? 'ASIN 是产品主键，编辑时不可修改。' : '录入后不可修改。'}</small></label>
              <label className="field"><span>内部 SKU</span><input className="input" value={productForm.sku} onChange={(event) => setProductForm({ ...productForm, sku: event.target.value })} placeholder="公司内部 SKU" /></label>
              <label className="field"><span>内部名称</span><input className="input" required value={productForm.internalName} onChange={(event) => setProductForm({ ...productForm, internalName: event.target.value })} placeholder="例如：SKU-01 颈椎枕" /></label>
              <label className="field"><span>品牌</span><input className="input" required value={productForm.brand} onChange={(event) => setProductForm({ ...productForm, brand: event.target.value })} /></label>
              <label className="field field-span-2"><span>Amazon 标题</span><input className="input" required value={productForm.title} onChange={(event) => setProductForm({ ...productForm, title: event.target.value })} /></label>
              <label className="field"><span>产品类型</span><input className="input" required value={productForm.productType} onChange={(event) => setProductForm({ ...productForm, productType: event.target.value })} /></label>
              <label className="field"><span>Marketplace</span><input className="input" value={`Amazon ${appSettings.marketplace}`} disabled readOnly /><small>产品固定录入到顶部当前站点。</small></label>
              <label className="field"><span>MarketNode ID（可选）</span><input className="input" value={productForm.marketNodeId} onChange={(event) => setProductForm({ ...productForm, marketNodeId: event.target.value })} placeholder="留空则按产品类型创建或关联市场" /></label>
              <label className="field"><span>主图 URL</span><input className="input" type="url" value={productForm.imageUrl} onChange={(event) => setProductForm({ ...productForm, imageUrl: event.target.value })} placeholder="https://…" /></label>
              <label className="field field-span-2"><span>主要关键词</span><input className="input" value={productForm.keywords} onChange={(event) => setProductForm({ ...productForm, keywords: event.target.value })} placeholder="用逗号分隔" /></label>
            </div>
            <label className="checkbox-field"><input type="checkbox" checked={productForm.monitoringEnabled} onChange={(event) => setProductForm({ ...productForm, monitoringEnabled: event.target.checked })} /><span>添加后立即启用监控</span></label>
            <div className="modal-actions"><button className="button button-secondary" type="button" onClick={() => { setShowProductForm(false); setEditingProductId(null); }}>取消</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? <Loader2 className="spin" size={16} /> : editingProductId ? <Save size={16} /> : <Plus size={16} />}{saving ? '保存中' : editingProductId ? '保存修改' : '添加产品'}</button></div>
          </form>
        </div>
      )}

      {showBatchForm && !isViewer && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !batchSaving && setShowBatchForm(false)}>
          <form className="modal modal-batch-products" role="dialog" aria-modal="true" aria-labelledby="batch-products-title" onSubmit={(event) => void initializeProducts(event)}>
            <div className="modal-header"><div><span className="eyebrow">OWNED BUSINESS SETUP</span><h2 id="batch-products-title">批量初始化自有 SKU</h2><p>当前站点：Amazon {appSettings.marketplace}。成功行会保留，失败行可单独修正后重试。</p></div><button className="icon-button" type="button" aria-label="关闭" disabled={batchSaving} onClick={() => setShowBatchForm(false)}><X size={18} /></button></div>
            <div className="batch-product-list">
              {batchRows.map((row, index) => (
                <fieldset className={`batch-product-row batch-product-row--${row.status}`} key={row.rowKey} disabled={batchSaving || row.status === 'success'}>
                  <legend><strong>SKU {index + 1}</strong><span className={`status-badge ${row.status === 'success' ? 'success' : row.status === 'error' ? 'danger' : row.status === 'saving' ? 'info' : 'neutral'}`}>{row.status === 'success' ? '已保存' : row.status === 'error' ? '需修正' : row.status === 'saving' ? '保存中' : '待填写'}</span></legend>
                  <div className="batch-product-fields">
                    <label className="field"><span>ASIN</span><input className="input" required pattern="[A-Za-z0-9]{10}" maxLength={10} value={row.asin} onChange={(event) => updateBatchRow(index, { asin: event.target.value.toUpperCase() })} /></label>
                    <label className="field"><span>SKU / 内部名称</span><input className="input" required value={row.internalName || row.sku} onChange={(event) => updateBatchRow(index, { sku: event.target.value, internalName: event.target.value })} placeholder="例如 SKU-01 颈椎枕" /></label>
                    <label className="field"><span>品牌</span><input className="input" required value={row.brand} onChange={(event) => updateBatchRow(index, { brand: event.target.value })} /></label>
                    <label className="field"><span>产品标题</span><input className="input" required value={row.title} onChange={(event) => updateBatchRow(index, { title: event.target.value })} /></label>
                    <label className="field"><span>细分市场 / 产品类型</span><input className="input" required value={row.productType} onChange={(event) => updateBatchRow(index, { productType: event.target.value })} /></label>
                    <label className="field"><span>主要关键词</span><input className="input" required value={row.keywords} onChange={(event) => updateBatchRow(index, { keywords: event.target.value })} placeholder="逗号分隔" /></label>
                  </div>
                  {row.rowError ? <p className="form-error" role="alert">{row.rowError}</p> : null}
                </fieldset>
              ))}
            </div>
            <div className="modal-actions"><button className="button button-secondary" type="button" disabled={batchSaving} onClick={() => setShowBatchForm(false)}>稍后继续</button><button className="button button-primary" type="submit" disabled={batchSaving || batchRows.every((row) => row.status === 'success')}>{batchSaving ? <Loader2 className="spin" size={16} /> : <PackagePlus size={16} />}{batchSaving ? '逐行保存中' : '保存未完成行'}</button></div>
          </form>
        </div>
      )}
    </main>
  );
}
