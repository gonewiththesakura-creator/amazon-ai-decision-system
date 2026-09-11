import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Database, FileSpreadsheet, FlaskConical, LoaderCircle, PackagePlus, PlugZap } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/AppContext';
import { importFailureMessage, type FileImportResult, type ImportSource } from '../lib/importResult';

export function Onboarding() {
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const { settings, setDemoMode, refreshAll, reloadSettings } = useApp();
  const [busy, setBusy] = useState<'demo' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importSource, setImportSource] = useState<ImportSource>('import');

  const enableDemo = async () => {
    setBusy('demo');
    setError(null);
    try {
      await setDemoMode(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '无法进入演示模式');
    } finally {
      setBusy(null);
    }
  };

  const importFile = async (file?: File) => {
    if (!file) return;
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (extension !== 'csv' && extension !== 'xlsx') {
      setError('请选择 CSV 或 XLSX 文件。');
      return;
    }
    const formData = new FormData();
    formData.append('file', file);
    formData.append('sourceType', importSource);
    formData.append('marketplace', settings.marketplace);
    setBusy('import');
    setError(null);
    try {
      const result = await api.upload<FileImportResult>(extension === 'csv' ? '/api/import/csv' : '/api/import/xlsx', formData);
      const failure = importFailureMessage(result);
      if (failure) {
        setError(failure);
        return;
      }
      await reloadSettings();
      refreshAll();
      const params = new URLSearchParams({
        import: result.task.status,
        success: String(result.successCount),
        failed: String(result.failureCount),
      });
      navigate(`/data-tasks?${params}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '文件导入失败');
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <section className="onboarding">
      <div className="onboarding__intro">
        <span className="onboarding__icon"><Database size={25} aria-hidden="true" /></span>
        <div>
          <span className="eyebrow">START WITH TRUSTED DATA</span>
          <h1>尚未接入真实数据</h1>
          <p>先录入当前业务或连接数据源。系统会从第一条快照开始保留历史，并为每项 AI 判断附上来源与证据。</p>
        </div>
      </div>

      <div className="onboarding-import-context">
        <label className="field-control field-control--select">
          <span>导入文件来源</span>
          <select value={importSource} disabled={busy !== null} onChange={(event) => setImportSource(event.target.value as ImportSource)}>
            <option value="import">SellerSprite 报表</option>
            <option value="amazon">Amazon 报表</option>
          </select>
        </label>
        <span>归属站点 <strong>Amazon {settings.marketplace}</strong></span>
      </div>

      <div className="onboarding-actions">
        <button type="button" onClick={() => navigate('/settings?tab=products')}>
          <span><PackagePlus size={21} aria-hidden="true" /></span>
          <strong>初始化现有 4 SKU</strong>
          <small>录入 ASIN、市场与直接竞品</small>
        </button>
        <button type="button" onClick={() => navigate('/settings?tab=sources')}>
          <span><PlugZap size={21} aria-hidden="true" /></span>
          <strong>连接 SellerSprite</strong>
          <small>配置数据源与同步方式</small>
        </button>
        <button type="button" onClick={() => fileInput.current?.click()} disabled={busy !== null}>
          <span>{busy === 'import' ? <LoaderCircle className="spin" size={21} aria-hidden="true" /> : <FileSpreadsheet size={21} aria-hidden="true" />}</span>
          <strong>导入 CSV / XLSX</strong>
          <small>使用已有市场或 Amazon 报表</small>
        </button>
        <button type="button" onClick={() => void enableDemo()} disabled={busy !== null}>
          <span>{busy === 'demo' ? <LoaderCircle className="spin" size={21} aria-hidden="true" /> : <FlaskConical size={21} aria-hidden="true" />}</span>
          <strong>进入 Demo 模式</strong>
          <small>加载明确标记的演示数据</small>
        </button>
      </div>
      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        accept=".csv,.xlsx"
        onChange={(event) => void importFile(event.target.files?.[0])}
      />
      <p className="onboarding-import-note">导入需包含完整快照字段；可参照 <code>examples/product-snapshots.csv</code> 与 <code>examples/market-snapshots.csv</code>。</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </section>
  );
}
