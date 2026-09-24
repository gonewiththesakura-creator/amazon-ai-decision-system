import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Quota {
  estimatedRemaining: number; reserve: number; status: string; todayRemoteCalls: number;
  weekRemoteCalls: number; localHitRate: number | null; cacheHitRate: number | null;
  remoteCallRate: number | null; circuit: string; policy: Record<string, number>;
}
interface Plan {
  id: string; estimatedRemoteCalls: number; maximumRemoteCalls: number; localReuse: number;
  projectedRemaining: number; blockers: string[]; entries: Array<{target: string; remote: number; reason: string}>;
}

export default function McpQuotaControls({marketId, month, isViewer, onComplete}: {
  marketId: string; month: string; isViewer: boolean; onComplete: () => Promise<void>;
}) {
  const [quota, setQuota] = useState<Quota | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [mode, setMode] = useState('incremental');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [baseline, setBaseline] = useState('');
  const [policyText, setPolicyText] = useState('');
  const [details, setDetails] = useState('');
  const [schemaConfirmed, setSchemaConfirmed] = useState(false);
  const [pauses, setPauses] = useState<Array<{capability:string;schema_hash:string}>>([]);
  async function refresh() { setQuota(await api.get<Quota>('/api/integrations/sellersprite/quota')); }
  useEffect(() => { void refresh().catch(() => setMessage('额度状态读取失败')); }, []);
  useEffect(() => { setPlan(null); setConfirmed(false); }, [marketId, month, mode]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await action(); await refresh(); } catch (error) { setMessage(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(false); }
  }
  const percent = (value: number | null) => value === null ? '暂无样本' : `${Math.round(value * 100)}%`;
  return <section aria-label="MCP 额度与调用计划" className="real-data-band">
    <h3>MCP 额度与调用计划</h3>
    {quota && <>
      <p>本地估算剩余 ≈{quota.estimatedRemaining} · 预留 {quota.reserve} · {quota.status} · 熔断 {quota.circuit}</p>
      <p>最近 24 小时 {quota.todayRemoteCalls} 次 · 最近 7 天 {quota.weekRemoteCalls} 次 · 重置日期未知</p>
      <p>本地命中 {percent(quota.localHitRate)} · 缓存命中 {percent(quota.cacheHitRate)} · 远端调用 {percent(quota.remoteCallRate)}</p>
    </>}
    {!isViewer && <>
      <label className="field">同步模式<select className="input" value={mode} disabled={busy} onChange={(e) => setMode(e.target.value)}>
        <option value="incremental">普通增量：优先本地</option>
        <option value="certification">完整认证：重新采集</option>
        <option value="force">强制重新抓取</option>
      </select></label>
      <button className="button button-primary" disabled={busy || !marketId || !month} onClick={() => void run(async () => {
        setPlan(await api.post<Plan>('/api/integrations/sellersprite/sync/plan', {marketId, month, syncMode: mode}));
        setConfirmed(false);
      })}>预览调用计划</button>
      {plan && <div>
        <p>预计远端 ≤{plan.estimatedRemoteCalls} 次 · 本地复用 {plan.localReuse} 项 · 预计剩余 ≈{plan.projectedRemaining}</p>
        <p>缓存命中可进一步减少调用；含重试和分页的执行上限为 {plan.maximumRemoteCalls} 次。计划 10 分钟内有效。</p>
        {mode !== 'incremental' && <p>这会忽略本地数据并消耗远端额度。执行将留下审计记录。</p>}
        <ul>{plan.entries.map((entry) => <li key={entry.target}>{entry.target}：{entry.remote} 次 · {entry.reason}</li>)}</ul>
        {plan.blockers.map((blocker) => <p key={blocker} role="alert">{blocker}</p>)}
        <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />已审阅调用范围与额度，同意执行</label>
        <button className="button button-primary" disabled={busy || !confirmed || plan.blockers.length > 0} onClick={() => void run(async () => {
          await api.post('/api/integrations/sellersprite/sync/critical', {marketId, month, syncMode: mode, planId: plan.id, confirmed: true});
          setPlan(null); setConfirmed(false); setMessage('同步完成；认证资格以 Go Live 检查结果为准。'); await onComplete();
        })}>确认执行</button>
      </div>}
      <details><summary>管理额度与新鲜度策略</summary>
        <label>校准剩余额度<input className="input" type="number" min="0" value={baseline} onChange={(e) => setBaseline(e.target.value)} /></label>
        <label>TTL 策略（毫秒，可留空保留当前值）<textarea className="input" value={policyText} placeholder={JSON.stringify(quota?.policy)} onChange={(e) => setPolicyText(e.target.value)} /></label>
        <button className="button button-secondary" disabled={busy || !baseline || !quota} onClick={() => void run(async () => {
          await api.post('/api/integrations/sellersprite/quota', {remaining: Number(baseline), reserve: quota!.reserve,
            confirmed: true, ...(policyText ? {policy: JSON.parse(policyText)} : {})}); setPlan(null); setMessage('已校准本地估算，并写入审计。');
        })}>确认校准</button>
        <button className="button button-secondary" disabled={busy} onClick={() => void run(async () => {
          await api.post('/api/integrations/sellersprite/circuit/reset', {confirmed: true});
        })}>人工解除熔断</button>
        <button className="button button-secondary" disabled={busy} onClick={() => void run(async () => {
          setDetails(JSON.stringify(await api.get('/api/integrations/sellersprite/usage'), null, 2));
        })}>调用明细</button>
        {details && <pre>{details}</pre>}
        <p>能力刷新预计 1 次远端调用，含重试与分页最多 4 次；变化的能力需核验后恢复。</p>
        <label><input type="checkbox" checked={schemaConfirmed} onChange={(e)=>setSchemaConfirmed(e.target.checked)} />确认消耗额度刷新能力定义</label>
        <button className="button button-secondary" disabled={busy || !schemaConfirmed} onClick={()=>void run(async()=>{
          await api.post('/api/integrations/sellersprite/capabilities/refresh',{confirmed:true});
          setSchemaConfirmed(false); setPlan(null);
          setPauses(await api.get('/api/integrations/sellersprite/schema-pauses'));
        })}>刷新 Provider 能力</button>
        <button className="button button-secondary" disabled={busy} onClick={()=>void run(async()=>{
          setPauses(await api.get('/api/integrations/sellersprite/schema-pauses'));
        })}>查看暂停的能力</button>
        {pauses.map((pause)=><p key={pause.capability}>{pause.capability} · {pause.schema_hash}
          <button className="button button-secondary" disabled={busy} onClick={()=>void run(async()=>{
            await api.post('/api/integrations/sellersprite/schema-pauses/acknowledge', {
              capability:pause.capability,schemaHash:pause.schema_hash,confirmed:true,
            }); setPauses(await api.get('/api/integrations/sellersprite/schema-pauses'));
          })}>已核验此 Schema，恢复自动同步</button></p>)}
      </details>
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
