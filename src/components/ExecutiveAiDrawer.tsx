import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Bot, LoaderCircle, RotateCcw, Sparkles, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import type { Insight } from '../../shared/types';
import { api } from '../lib/api';
import { useApp } from '../lib/AppContext';
import { formatConfidence } from '../lib/format';
import { Badge } from './Badge';
import { EvidenceDrawer } from './EvidenceDrawer';
import './executive-ai-drawer.css';

interface AIAnalyzeResult {
  answer?: string;
  insight?: Insight;
  formal?: boolean;
  notice?: string;
}

const defaultQuestions = [
  '今天最值得关注什么？',
  '哪个 SKU 跑输最严重？',
  '最近哪个竞品涨得最快？',
  '记忆棉市场最近如何？',
];

export function ExecutiveAiDrawer() {
  const { settings } = useApp();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [insight, setInsight] = useState<Insight>();
  const [formal, setFormal] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const triggerButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = triggerButton.current
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (document.querySelector('.drawer-layer .evidence-drawer')) return;
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = drawer.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) {
        event.preventDefault();
        return;
      }
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
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, [open]);

  const reset = () => {
    setQuestion('');
    setAnswer(null);
    setInsight(undefined);
    setFormal(false);
    setNotice(undefined);
    setError(null);
  };

  const ask = async (suggested?: string) => {
    const prompt = (suggested ?? question).trim();
    if (!prompt || loading || settings.role === 'viewer') return;
    setQuestion(prompt);
    setLoading(true);
    setError(null);
    try {
      const result = await api.post<AIAnalyzeResult>('/api/ai/analyze', {
        question: prompt,
        entityType: 'dashboard',
        entityId: 'overview',
      });
      const isFormal = result.formal === true
        && Boolean(result.insight?.researchJobId && result.insight.evidenceIds?.length);
      setAnswer(result.answer ?? result.insight?.summary ?? '当前没有可引用的正式结论。');
      setInsight(result.insight);
      setFormal(isFormal);
      setNotice(result.notice);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '暂时无法回答');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button ref={triggerButton} className="button button--secondary button--sm executive-ai-trigger" type="button" onClick={() => setOpen(true)} aria-label="问 AI">
        <Sparkles size={16} aria-hidden="true" />
        <span>问 AI</span>
      </button>
      {open ? createPortal(
        <div className="executive-ai-layer" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}>
          <aside ref={drawer} className="executive-ai-drawer" role="dialog" aria-modal="true" aria-labelledby="executive-ai-title">
            <header className="executive-ai-drawer__header">
              <span className="executive-ai-drawer__mark"><Bot size={19} aria-hidden="true" /></span>
              <div>
                <span>经营问答</span>
                <h2 id="executive-ai-title">问 AI</h2>
              </div>
              <button ref={closeButton} className="icon-button" type="button" onClick={() => setOpen(false)} aria-label="关闭问 AI">
                <X size={18} aria-hidden="true" />
              </button>
            </header>

            <div className="executive-ai-drawer__body">
              <div className="executive-ai-policy"><Sparkles size={15} aria-hidden="true" />只引用当前正式结论与证据</div>
              {settings.role === 'viewer' ? (
                <div className="executive-ai-state">
                  <strong>当前为只读预览</strong>
                  <p>已有结论与证据仍可查看，AI 提问不会执行。</p>
                </div>
              ) : answer ? (
                <div className="executive-ai-answer" aria-live="polite">
                  <small>{question}</small>
                  <p>{answer}</p>
                  {notice ? <span>{notice}</span> : null}
                  <footer>
                    {formal && insight ? (
                      <>
                        <Badge tone={insight.confidence >= 0.8 ? 'positive' : 'warning'}>
                          正式结论 · 置信度 {formatConfidence(insight.confidence)}
                        </Badge>
                        <EvidenceDrawer insight={insight} />
                      </>
                    ) : (
                      <>
                        <Badge tone="warning">暂无正式结论</Badge>
                        <Link className="text-button" to="/research-jobs" onClick={() => setOpen(false)}>前往研究任务</Link>
                      </>
                    )}
                    <button className="text-button" type="button" onClick={reset}><RotateCcw size={14} aria-hidden="true" />继续提问</button>
                  </footer>
                </div>
              ) : (
                <>
                  <div className="executive-ai-suggestions" aria-label="建议问题">
                    {defaultQuestions.map((item) => (
                      <button type="button" key={item} disabled={loading} onClick={() => void ask(item)}>{item}</button>
                    ))}
                  </div>
                  <form className="executive-ai-input" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
                    <label htmlFor="executive-ai-question">你的问题</label>
                    <div>
                      <textarea id="executive-ai-question" rows={3} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：哪个 SKU 最需要关注？" />
                      <button type="submit" disabled={!question.trim() || loading} aria-label="提交问题">
                        {loading ? <LoaderCircle className="spin" size={18} aria-hidden="true" /> : <ArrowUp size={18} aria-hidden="true" />}
                      </button>
                    </div>
                  </form>
                  {error ? <p className="form-error" role="alert">{error}</p> : null}
                </>
              )}
            </div>
          </aside>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
