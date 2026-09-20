import { useEffect, useState } from 'react';
import { DatabaseBackup, PlugZap, RefreshCw, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';

interface ConnectionDiagnostics {
  connected: boolean;
  authenticated: boolean;
  toolCount: number;
  requiredCapabilityCount: number;
  availableRequiredCapabilityCount: number;
  missingCapabilities: string[];
  latencyMs: number;
  errorCode?: string;
}

interface CapabilitySummary {
  collectedAt: string | null;
  toolCount: number;
  required: Array<{ capability: string; available: boolean }>;
}

interface GoLivePreview {
  archive: Record<string, number>;
  delete: Record<string, number>;
  preserve: Record<string, number>;
  blockers: string[];
  retainedDemoHistory: Array<{
    kind: 'demo_rule_score_evidence' | 'legacy_demo_rejection';
    ref: string;
    detail: string;
    status: string;
    linkedMockInsights: number;
  }>;
}

interface GoLiveVerification {
  mockObservations: number;
  realMarketSnapshots: number;
  realOwnedProductSnapshots: number;
  activeOwnedProducts: number;
  sellerSpriteMarketSnapshots: number;
  sellerSpriteOwnedProductSnapshots: number;
  sellerSpriteConnectionVerified: boolean;
  sellerSpriteCapabilitiesAvailable: boolean;
  sellerSpriteMarketCalls: number;
  sellerSpriteAsinCalls: number;
  sellerSpriteCriticalRunId: string | null;
  verifiedEvidenceEntities: number;
  requiredEvidenceEntities: number;
  readyForDemoCleanup: boolean;
  hasMinimumRealCoverage: boolean;
}

const previewLabels: Record<string, string> = {
  marketSnapshots: 'Market Snapshots',
  productSnapshots: 'Product Snapshots',
  aiInsights: 'Insights',
  opportunities: 'Opportunities',
  developmentProjects: 'Development Projects',
  researchResults: 'Research Results',
  dataTasks: 'Data Tasks',
  competitorRelations: 'Competitor Relations',
  watchlistItems: 'Watchlist Items',
  importBatches: 'Import Batches',
};

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export default function RealDataControls({
  isViewer,
  marketId,
}: { isViewer: boolean; marketId: string }) {
  const [connection, setConnection] = useState<ConnectionDiagnostics | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilitySummary | null>(null);
  const [preview, setPreview] = useState<GoLivePreview | null>(null);
  const [verification, setVerification] = useState<GoLiveVerification | null>(null);
  const [backupName, setBackupName] = useState<string | null>(null);
  const [month, setMonth] = useState(currentMonth);
  const [nodePath, setNodePath] = useState('');
  const [mappedPath, setMappedPath] = useState('');
  const [mappingConfirmed, setMappingConfirmed] = useState(false);
  const [cleanupText, setCleanupText] = useState('');
  const [activationText, setActivationText] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    const [nextPreview, nextVerification, nextCapabilities] = await Promise.all([
      api.get<GoLivePreview>('/api/go-live/preview'),
      api.get<GoLiveVerification>('/api/go-live/verify'),
      api.get<CapabilitySummary>('/api/integrations/sellersprite/capabilities'),
    ]);
    setPreview(nextPreview);
    setVerification(nextVerification);
    setCapabilities(nextCapabilities);
  }

  useEffect(() => {
    let active = true;
    Promise.all([
      api.get<GoLivePreview>('/api/go-live/preview'),
      api.get<GoLiveVerification>('/api/go-live/verify'),
      api.get<CapabilitySummary>('/api/integrations/sellersprite/capabilities'),
    ]).then(([nextPreview, nextVerification, nextCapabilities]) => {
      if (!active) return;
      setPreview(nextPreview);
      setVerification(nextVerification);
      setCapabilities(nextCapabilities);
    }).catch(() => {
      if (active) setError('实时数据状态读取失败。');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!marketId) {
      setNodePath('');
      setMappedPath('');
      return;
    }
    let active = true;
    api.get<{ node: { categoryId?: string } }>(`/api/markets/${encodeURIComponent(marketId)}`)
      .then((market) => {
        if (!active) return;
        const path = market.node?.categoryId ?? '';
        setNodePath(path);
        setMappedPath(path);
      }).catch(() => { if (active) setError('市场节点读取失败。'); });
    return () => { active = false; };
  }, [marketId]);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try { await action(); }
    catch (failure) {
      if (failure instanceof ApiError && failure.status === 409 && failure.message.startsWith('备份已过期')) {
        setBackupName(null);
        setError('备份已过期：数据库已变更，请重新备份。');
      } else {
        setError('操作失败，请检查服务端配置或数据覆盖。');
      }
    }
    finally { setBusy(false); }
  }

  return (
    <div className="real-data-controls">
      <section className="real-data-band" aria-label="SellerSprite MCP">
        <div className="section-heading">
          <div><h3>SellerSprite MCP</h3></div>
          <button className="button button-secondary" type="button" disabled={busy || isViewer}
            onClick={() => void run(async () => {
              const next = await api.post<ConnectionDiagnostics>('/api/integrations/sellersprite/test', {});
              setConnection(next);
              await refresh();
            })}>
            <PlugZap size={16} />连接测试
          </button>
        </div>
        {connection && (
          <p role="status" className={connection.connected ? 'text-success' : 'text-warning'}>
            {connection.connected ? '已认证' : connection.authenticated ? '连接失败' : '认证失败'} · {connection.toolCount} 个工具 ·
            {' '}{connection.availableRequiredCapabilityCount} / {connection.requiredCapabilityCount} 项必需能力 · {connection.latencyMs} ms
          </p>
        )}
        {capabilities && capabilities.required.length > 0 && (
          <ul className="real-data-capabilities" aria-label="必需 MCP 能力">
            {capabilities.required.map((item) => (
              <li key={item.capability}>
                <span className={`status-badge ${item.available ? 'success' : 'warning'}`}>
                  {item.available ? '可用' : '缺失'}
                </span>
                {item.capability}
              </li>
            ))}
          </ul>
        )}
        <div className="real-data-actions">
          <label className="field"><span>SellerSprite 节点路径</span>
            <input className="input" value={nodePath} disabled={busy || isViewer || !marketId}
              placeholder="1055398:1063252:…" onChange={(event) => {
                setNodePath(event.target.value.trim());
                setMappingConfirmed(false);
              }} />
          </label>
          <label className="real-data-confirmation"><input type="checkbox" checked={mappingConfirmed}
            disabled={busy || isViewer || !marketId} onChange={(event) => setMappingConfirmed(event.target.checked)} />
            已核对站点和类目范围
          </label>
          <button className="button button-secondary" type="button" disabled={busy || isViewer || !marketId
            || !mappingConfirmed || !/^\d+(?::\d+)*$/.test(nodePath) || nodePath === mappedPath}
            onClick={() => void run(async () => {
              await api.patch(`/api/markets/${encodeURIComponent(marketId)}/sellersprite-node`, {
                nodeIdPath: nodePath, confirmed: true,
              });
              setMappedPath(nodePath);
              setMappingConfirmed(false);
              setBackupName(null);
              setNotice('市场节点映射已保存。');
            })}><Save size={16} />保存映射</button>
        </div>
        <div className="real-data-actions">
          <label className="field"><span>观察月份</span>
            <input className="input" type="month" value={month} disabled={busy || isViewer}
              onChange={(event) => setMonth(event.target.value)} />
          </label>
          <button className="button button-primary" type="button" disabled={busy || isViewer || !marketId
            || !/^\d+(?::\d+)*$/.test(mappedPath) || !month}
            onClick={() => void run(async () => {
              await api.post('/api/integrations/sellersprite/sync/critical', {
                marketId,
                month: month.replace('-', ''),
              });
              setBackupName(null);
              setNotice('关键市场与自有 SKU 历史已同步。');
              await refresh();
            })}>
            <RefreshCw size={16} />同步关键数据
          </button>
        </div>
      </section>

      <section className="real-data-band" aria-label="Go Live 迁移">
        <div className="section-heading">
          <div><h3>Go Live 迁移</h3></div>
          <button className="button button-secondary" type="button" disabled={busy || loading}
            onClick={() => void run(refresh)} aria-label="刷新迁移状态">
            <RefreshCw size={16} />刷新
          </button>
        </div>
        {loading ? <p role="status">正在读取状态…</p> : null}
        {preview && (
          <div className="real-data-preview">
            <div><strong>预计归档</strong>
              <ul>{Object.entries(preview.archive ?? {}).map(([key, count]) => (
                <li key={key}>{key === 'products' ? '演示产品主档' : key}: {count}</li>
              ))}</ul>
            </div>
            <div><strong>预计删除</strong>
              <ul>{Object.entries(preview.delete).map(([key, count]) => (
                <li key={key}>{previewLabels[key] ?? key}: {count}</li>
              ))}</ul>
            </div>
            <div><strong>保留</strong>
              <ul>{Object.entries(preview.preserve).map(([key, count]) => <li key={key}>{key}: {count}</li>)}</ul>
            </div>
            {preview.retainedDemoHistory?.length ? (
              <div><strong>Demo 历史保留核对</strong>
                <ul aria-label="Demo 历史保留核对">{preview.retainedDemoHistory.map((item) => (
                  <li key={item.ref}>{item.detail} ·
                    {' '}{item.status === 'waiting_approval' ? '待人工审批' : item.status === 'rejected' ? '已拒绝' : '历史记录'} ·
                    {' '}<code>{item.ref}</code>
                  </li>
                ))}</ul>
              </div>
            ) : null}
          </div>
        )}
        {preview?.blockers?.length ? (
          <p className="alert alert-error" role="alert">待清理的 Demo 记录仍有引用或未归属的 Mock 结论：{preview.blockers.join('；')}</p>
        ) : null}
        {verification && (
          <div className="real-data-verification" role="status">
            <ShieldCheck size={17} />
            <span>{verification.readyForDemoCleanup ? '清理前真实链路已通过' : '清理前真实链路未通过'} ·
              {' '}{verification.hasMinimumRealCoverage ? 'Live 切换条件已满足' : 'Live 切换条件未满足'} ·
              {' '}主市场 {verification.realMarketSnapshots} · 自有 SKU {verification.realOwnedProductSnapshots} / {verification.activeOwnedProducts} · Mock {verification.mockObservations}
              <br />SellerSprite 连接 {verification.sellerSpriteConnectionVerified ? '已验证' : '未验证'} · 市场 {verification.sellerSpriteMarketSnapshots} · 自有 SKU {verification.sellerSpriteOwnedProductSnapshots} ·
              {' '}能力 {verification.sellerSpriteCapabilitiesAvailable ? '已发现' : '未验证'} · 市场调用 {verification.sellerSpriteMarketCalls} · ASIN 调用 {verification.sellerSpriteAsinCalls}
              <br />运行 Evidence {verification.verifiedEvidenceEntities} / {verification.requiredEvidenceEntities} ·
              {' '}<span className="real-data-run-id">关键运行 {verification.sellerSpriteCriticalRunId ?? '尚无完整运行'}</span></span>
          </div>
        )}
        <div className="real-data-actions">
          <button className="button button-secondary" type="button" disabled={busy || isViewer}
            onClick={() => void run(async () => {
              const result = await api.post<{ created: boolean; filename: string }>('/api/go-live/backup', {});
              setBackupName(result.filename);
              setNotice('数据库备份已创建。');
            })}>
            <DatabaseBackup size={16} />备份数据库
          </button>
          {backupName && <span role="status">{backupName}</span>}
        </div>
        <div className="real-data-actions">
          <label className="field"><span>清理确认文本</span>
            <input className="input" value={cleanupText} disabled={busy || isViewer}
              onChange={(event) => setCleanupText(event.target.value)} placeholder="CLEAR DEMO DATA" />
          </label>
          <button className="button button-danger" type="button"
            disabled={busy || isViewer || verification?.readyForDemoCleanup !== true || !backupName
              || Boolean(preview?.blockers?.length) || cleanupText !== 'CLEAR DEMO DATA'}
            onClick={() => void run(async () => {
              await api.post('/api/go-live/cleanup', { confirmation: cleanupText });
              setCleanupText('');
              setNotice('已清除明确登记的演示数据。');
              await refresh();
            })}>
            <Trash2 size={16} />清除演示数据
          </button>
        </div>
        <div className="real-data-actions">
          <label className="field"><span>Live 确认文本</span>
            <input className="input" value={activationText} disabled={busy || isViewer}
              onChange={(event) => setActivationText(event.target.value)} placeholder="ACTIVATE LIVE" />
          </label>
          <button className="button button-primary" type="button"
            disabled={busy || isViewer || !verification?.hasMinimumRealCoverage || activationText !== 'ACTIVATE LIVE'}
            onClick={() => void run(async () => {
              await api.post('/api/go-live/activate', { confirmation: activationText });
              setActivationText('');
              setNotice('已切换 Live。');
              await refresh();
            })}>
            <ShieldCheck size={16} />切换 Live
          </button>
        </div>
      </section>
      {error && <p className="alert alert-error" role="alert">{error}</p>}
      {notice && <p className="alert alert-success" role="status">{notice}</p>}
    </div>
  );
}
