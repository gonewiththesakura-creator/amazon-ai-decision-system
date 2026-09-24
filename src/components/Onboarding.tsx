import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Database, FileSpreadsheet, FlaskConical, LoaderCircle, PackagePlus, PlugZap } from 'lucide-react';
import { useApp } from '../lib/AppContext';

export function Onboarding() {
  const navigate = useNavigate();
  const { settings, setDemoMode } = useApp();
  const [busy, setBusy] = useState<'demo' | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        <span>归属站点 <strong>Amazon {settings.marketplace}</strong></span>
      </div>

      <div className="onboarding-actions">
        <button type="button" onClick={() => navigate('/settings?tab=products')}>
          <span><PackagePlus size={21} aria-hidden="true" /></span>
          <strong>批量初始化自有 SKU</strong>
          <small>录入 ASIN、市场与直接竞品</small>
        </button>
        <button type="button" onClick={() => navigate('/settings?tab=sources')}>
          <span><PlugZap size={21} aria-hidden="true" /></span>
          <strong>连接 SellerSprite</strong>
          <small>配置数据源与同步方式</small>
        </button>
        <button type="button" onClick={() => navigate('/data-tasks#import-center-title')}>
          <span><FileSpreadsheet size={21} aria-hidden="true" /></span>
          <strong>导入 CSV / XLSX</strong>
          <small>使用已有市场或 Amazon 报表</small>
        </button>
        <button type="button" onClick={() => void enableDemo()} disabled={busy !== null}>
          <span>{busy === 'demo' ? <LoaderCircle className="spin" size={21} aria-hidden="true" /> : <FlaskConical size={21} aria-hidden="true" />}</span>
          <strong>进入 Demo 模式</strong>
          <small>加载明确标记的演示数据</small>
        </button>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </section>
  );
}
