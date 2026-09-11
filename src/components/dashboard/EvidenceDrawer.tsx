import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, CalendarClock, Database, FileSearch, X } from 'lucide-react';
import { formatDashboardDate } from './format';
import type { DashboardEvidenceItem, DashboardInsightLineage } from './types';

export interface EvidenceDrawerProps {
  evidence: DashboardEvidenceItem[];
  lineage: DashboardInsightLineage;
  label?: string;
  researchJobHref: string | null;
}

function evidenceValue(value: string | number, unit?: string): string {
  if (typeof value === 'number') {
    const formatted = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
    return `${formatted}${unit ?? ''}`;
  }
  return `${value}${unit ?? ''}`;
}

function availableText(value: string | null): string {
  return value?.trim() || '不可用';
}

function readableMetricLabel(label: string): string {
  return label.replace(/_/g, ' ');
}

export function EvidenceDrawer({
  evidence,
  lineage,
  label = '查看依据',
  researchJobHref,
}: EvidenceDrawerProps) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const selector = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => drawerRef.current?.querySelector<HTMLElement>(selector)?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !drawerRef.current) return;
      const focusable = Array.from(drawerRef.current.querySelectorAll<HTMLElement>(selector));
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
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      trigger?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        className="dashboard-evidence-trigger"
        type="button"
        disabled={!evidence.length}
        onClick={() => setOpen(true)}
      >
        <FileSearch size={14} aria-hidden="true" />
        {label}
      </button>
      {open ? createPortal(
        <div className="dashboard-evidence-layer" role="presentation" onMouseDown={() => setOpen(false)}>
          <aside
            ref={drawerRef}
            className="dashboard-evidence-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="dashboard-evidence-drawer__header">
              <div>
                <span>DATA BASIS</span>
                <h2 id={titleId}>查看数据依据</h2>
                <p>Evidence、计算方法与版本血缘集中在这里。</p>
              </div>
              <button className="dashboard-icon-button" type="button" onClick={() => setOpen(false)} aria-label="关闭数据依据">
                <X size={18} aria-hidden="true" />
              </button>
            </header>

            <div className="dashboard-evidence-drawer__list">
              <section className="dashboard-evidence-lineage" aria-label="结论版本血缘">
                <div className="dashboard-evidence-section-heading">
                  <span>LINEAGE</span>
                  <h3>版本血缘</h3>
                </div>
                <dl>
                  <div><dt>数据版本</dt><dd>{availableText(lineage.dataVersion)}</dd></div>
                  <div><dt>规则配置</dt><dd>{availableText(lineage.ruleProfileId)}</dd></div>
                  <div>
                    <dt>规则版本</dt>
                    <dd>{lineage.ruleProfileVersion === null ? '不可用' : `v${lineage.ruleProfileVersion}`}</dd>
                  </div>
                  <div><dt>Prompt 版本</dt><dd>{availableText(lineage.promptVersion)}</dd></div>
                </dl>
              </section>

              <div className="dashboard-evidence-section-heading">
                <span>EVIDENCE</span>
                <h3>结论依据</h3>
              </div>
              {evidence.map((item, index) => (
                <article className="dashboard-evidence-item" key={`${item.claim}-${index}`}>
                  <div className="dashboard-evidence-item__title">
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <h3>{item.claim}</h3>
                  </div>
                  {item.metrics.length ? (
                    <dl className="dashboard-evidence-metrics">
                      {item.metrics.map((metric, metricIndex) => (
                        <div key={`${metric.label}-${metricIndex}`}>
                          <dt>{readableMetricLabel(metric.label)}</dt>
                          <dd>{evidenceValue(metric.value, metric.unit)}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : <p className="dashboard-evidence-unavailable">指标不可用</p>}
                  <div className="dashboard-evidence-calculation">
                    <span>计算方法</span>
                    <code>{availableText(item.calculation)}</code>
                  </div>
                  <div className="dashboard-evidence-sources">
                    {item.sources.length ? item.sources.map((source, sourceIndex) => (
                      <div key={`${source.source}-${source.collectedAt}-${sourceIndex}`}>
                        <Database size={14} aria-hidden="true" />
                        <span><strong>{source.source}</strong>{source.period ? ` · ${source.period}` : ''}</span>
                        <small><CalendarClock size={13} aria-hidden="true" />{formatDashboardDate(source.collectedAt, true)}</small>
                      </div>
                    )) : <p className="dashboard-evidence-unavailable">来源不可用</p>}
                  </div>
                </article>
              ))}
            </div>

            <footer className="dashboard-evidence-drawer__footer">
              {researchJobHref
                ? <a href={researchJobHref}>打开研究任务 <ArrowUpRight size={14} aria-hidden="true" /></a>
                : <span>研究任务不可用</span>}
            </footer>
          </aside>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
