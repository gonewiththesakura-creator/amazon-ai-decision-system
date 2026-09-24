import { useEffect, useState } from 'react';
import { Check, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import type { RelationType } from '../../shared/types';
import { api } from '../lib/api';

interface Candidate {
  id: string;
  asin: string;
  status: 'pending_review' | 'confirmed' | 'rejected';
  title: string | null;
  brand: string | null;
  price: number | null;
  createdAt: string;
}

export default function CompetitorCandidateReview({ productId, isViewer, onConfirmed }: {
  productId: string;
  isViewer: boolean;
  onConfirmed: () => void;
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [relationType, setRelationType] = useState<Record<string, RelationType>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/owned-products/${encodeURIComponent(productId)}/competitor-candidates`;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    api.get<Candidate[]>(base).then((items) => {
      if (active) setCandidates(items);
    }).catch(() => {
      if (active) setError('候选竞品读取失败。');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [base]);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      setCandidates(await api.get<Candidate[]>(base));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '候选竞品操作失败。');
    } finally { setBusy(false); }
  }

  const pending = candidates.filter((item) => item.status === 'pending_review');
  return (
    <section className="candidate-review" aria-label="SellerSprite 候选竞品审核">
      <header className="section-header">
        <div><span className="eyebrow">SELLERSPRITE DISCOVERY</span><h3>待审核候选 <span>{pending.length}</span></h3></div>
        <button className="button button--secondary" type="button" disabled={busy || isViewer}
          onClick={() => void run(async () => { await api.post(base, { size: 20 }); })}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}发现候选
        </button>
      </header>
      {loading ? <p role="status">正在读取候选…</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {!loading && pending.length === 0 ? <p className="section-header__note">暂无待审核候选。</p> : null}
      {pending.length > 0 ? (
        <div className="table-scroll">
          <table className="data-table candidate-table">
            <thead><tr><th>候选产品</th><th>关联类型</th><th>纳入理由</th><th>审核</th></tr></thead>
            <tbody>{pending.map((item) => (
              <tr key={item.id}>
                <td><strong>{item.brand || '品牌待核实'}</strong><br />{item.title || '标题待核实'}<br /><small>{item.asin}</small></td>
                <td><select aria-label={`${item.asin} 关联类型`} className="input"
                  disabled={busy || isViewer} value={relationType[item.id] ?? 'direct'}
                  onChange={(event) => setRelationType((current) => ({ ...current, [item.id]: event.target.value as RelationType }))}>
                  <option value="direct">直接竞品</option><option value="price_peer">同价竞品</option>
                  <option value="top100">TOP100</option><option value="benchmark">头部标杆</option>
                  <option value="fast_growth">快速增长</option>
                </select></td>
                <td><input className="input" aria-label={`${item.asin} 纳入理由`}
                  value={reason[item.id] ?? ''} disabled={busy || isViewer}
                  onChange={(event) => setReason((current) => ({ ...current, [item.id]: event.target.value }))}
                  placeholder="人工核对后的理由" /></td>
                <td><div className="candidate-actions">
                  <button type="button" className="icon-button" title="确认纳入竞品" aria-label={`确认候选 ${item.asin}`}
                    disabled={busy || isViewer || !reason[item.id]?.trim()}
                    onClick={() => void run(async () => {
                      await api.post(`${base}/${encodeURIComponent(item.id)}/confirm`, {
                        relationType: relationType[item.id] ?? 'direct', reason: reason[item.id].trim(),
                      });
                      onConfirmed();
                    })}><Check size={16} /></button>
                  <button type="button" className="icon-button" title="拒绝候选" aria-label={`拒绝候选 ${item.asin}`}
                    disabled={busy || isViewer}
                    onClick={() => void run(async () => {
                      await api.post(`${base}/${encodeURIComponent(item.id)}/reject`, {});
                    })}><X size={16} /></button>
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}
      {candidates.length > pending.length ? (
        <p className="section-header__note"><RefreshCw size={13} aria-hidden="true" />
          已审核 {candidates.length - pending.length} 个候选</p>
      ) : null}
    </section>
  );
}
