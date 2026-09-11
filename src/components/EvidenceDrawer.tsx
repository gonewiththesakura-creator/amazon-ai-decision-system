import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Clock3, Database, FileSearch, ShieldCheck, X } from 'lucide-react';
import type { Evidence, Insight } from '../../shared/types';
import { formatConfidence, formatDateTime, formatDecimal } from '../lib/format';
import { Badge } from './Badge';

interface EvidenceDrawerProps {
  insight?: Insight;
  evidence?: Evidence[];
  label?: string;
  className?: string;
}

function metricValue(value: number | string, unit?: string) {
  const formatted = typeof value === 'number' ? formatDecimal(value) : value;
  return `${formatted}${unit ?? ''}`;
}

export function EvidenceDrawer({ insight, evidence, label = '为什么？', className }: EvidenceDrawerProps) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const entries = evidence ?? insight?.evidence ?? [];

  useEffect(() => {
    if (!open) return;
    const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !drawerRef.current) return;
      const focusable = Array.from(drawerRef.current.querySelectorAll<HTMLElement>(focusableSelector));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    const trigger = triggerRef.current;
    const frame = window.requestAnimationFrame(() => {
      drawerRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus();
    });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      trigger?.focus();
    };
  }, [open]);

  return (
    <>
      <button ref={triggerRef} className={className ?? 'evidence-trigger'} type="button" onClick={() => setOpen(true)} disabled={!entries.length}>
        <FileSearch size={15} aria-hidden="true" />
        {label}
        {entries.length ? <span>{entries.length}</span> : null}
      </button>
      {open
        ? createPortal(
            <div className="drawer-layer" role="presentation" onMouseDown={() => setOpen(false)}>
              <aside
                ref={drawerRef}
                className="evidence-drawer"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                onMouseDown={(event) => event.stopPropagation()}
              >
                <header className="drawer-header">
                  <div>
                    <span className="eyebrow">AI EVIDENCE</span>
                    <h2 id={titleId}>结论证据链</h2>
                  </div>
                  <button className="icon-button" type="button" onClick={() => setOpen(false)} aria-label="关闭证据链">
                    <X size={19} aria-hidden="true" />
                  </button>
                </header>

                {insight ? (
                  <div className="drawer-summary">
                    <ShieldCheck size={20} aria-hidden="true" />
                    <div>
                      <strong>{insight.title}</strong>
                      <p>{insight.summary}</p>
                    </div>
                    <Badge tone={insight.confidence >= 0.8 ? 'positive' : insight.confidence >= 0.6 ? 'warning' : 'critical'}>
                      置信度 {formatConfidence(insight.confidence)}
                    </Badge>
                  </div>
                ) : null}

                <div className="evidence-list">
                  {entries.map((item, index) => (
                    <article className="evidence-item" key={item.id || `${item.claim}-${index}`}>
                      <div className="evidence-item__claim">
                        <CheckCircle2 size={18} aria-hidden="true" />
                        <div>
                          <span>证据 {String(index + 1).padStart(2, '0')}</span>
                          <h3>{item.claim}</h3>
                        </div>
                      </div>
                      <div className="evidence-metrics">
                        {item.metrics.map((metric) => (
                          <div key={`${item.id}-${metric.name}`}>
                            <span>{metric.label}</span>
                            <strong>{metricValue(metric.value, metric.unit)}</strong>
                          </div>
                        ))}
                      </div>
                      <div className="provenance-list">
                        {item.provenance.map((source, sourceIndex) => (
                          <div className="provenance-row" key={`${item.id}-${source.source}-${sourceIndex}`}>
                            <Database size={15} aria-hidden="true" />
                            <div>
                              <strong>{source.source}</strong>
                              <span>{source.sourceType.toUpperCase()} · {source.period}{source.isEstimated ? ' · 估算数据' : ''}</span>
                            </div>
                            <div className="provenance-row__time">
                              <Clock3 size={14} aria-hidden="true" />
                              <span>{formatDateTime(source.collectedAt)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>

                {insight ? (
                  <footer className="drawer-footer">
                    <span>模型 {insight.model}</span>
                    <span>数据版本 {insight.dataVersion}</span>
                    <span>生成于 {formatDateTime(insight.generatedAt)}</span>
                  </footer>
                ) : null}
              </aside>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
