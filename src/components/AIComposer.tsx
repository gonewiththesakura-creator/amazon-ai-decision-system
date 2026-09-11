import { useState } from 'react';
import { ArrowUp, Bot, LoaderCircle, RotateCcw, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Insight } from '../../shared/types';
import { api } from '../lib/api';
import { useApp } from '../lib/AppContext';
import { formatConfidence } from '../lib/format';
import { Badge } from './Badge';
import { EvidenceDrawer } from './EvidenceDrawer';

interface AIComposerProps {
  suggestions: string[];
  entityType?: string;
  entityId?: string;
}

interface AIAnalyzeResult {
  answer?: string;
  insight?: Insight;
  formal?: boolean;
  notice?: string;
}

function normalizeAIComposerResult(result: Insight | AIAnalyzeResult): {
  answer: string;
  insight?: Insight;
  formal: boolean;
  notice?: string;
} {
  if ('summary' in result && 'evidence' in result) {
    const formal = Boolean(result.researchJobId && result.evidenceIds?.length);
    return { answer: result.summary, insight: result, formal };
  }
  const formal = result.formal === true
    && Boolean(result.insight?.researchJobId && result.insight.evidenceIds?.length);
  return {
    answer: result.answer ?? result.insight?.summary ?? '当前没有可引用的正式工作流结论。',
    insight: result.insight,
    formal,
    notice: result.notice,
  };
}

export function AIComposer({ suggestions, entityType = 'dashboard', entityId = 'overview' }: AIComposerProps) {
  const { settings } = useApp();
  const isViewer = settings.role === 'viewer';
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [insight, setInsight] = useState<Insight | undefined>();
  const [formal, setFormal] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async (nextQuestion?: string) => {
    const prompt = (nextQuestion ?? question).trim();
    if (!prompt || loading || isViewer) return;
    setQuestion(prompt);
    setLoading(true);
    setError(null);
    try {
      const result = await api.post<Insight | AIAnalyzeResult>('/api/ai/analyze', {
        question: prompt,
        entityType,
        entityId,
      });
      const normalized = normalizeAIComposerResult(result);
      setAnswer(normalized.answer);
      setInsight(normalized.insight);
      setFormal(normalized.formal);
      setNotice(normalized.notice);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'AI 分析暂时不可用');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="ai-composer">
      <header>
        <div className="ai-composer__mark"><Bot size={20} aria-hidden="true" /></div>
        <div>
          <span className="eyebrow">ASK YOUR DATA</span>
          <h2>向选品情报提问</h2>
        </div>
        <Badge tone="info"><Sparkles size={13} aria-hidden="true" /> 仅引用正式工作流</Badge>
      </header>

      {isViewer ? (
        <div className="ai-readonly">
          <p>当前为 Viewer 权限预览。AI 提问不会执行，已有结论与证据仍可正常查看；可在设置中退出预览。</p>
        </div>
      ) : answer ? (
        <div className="ai-answer" aria-live="polite">
          <div className="ai-answer__question">{question}</div>
          <p>{answer}</p>
          {notice ? <small className="muted">{notice}</small> : null}
          <footer>
            {formal && insight ? <Badge tone={insight.confidence >= 0.8 ? 'positive' : 'warning'}>正式结论 · 置信度 {formatConfidence(insight.confidence)}</Badge> : <Badge tone="warning">需运行 Research Job</Badge>}
            {formal && insight ? <EvidenceDrawer insight={insight} /> : null}
            {!formal && insight ? (
              <Link className="text-button" to={`/research-jobs?entityType=${encodeURIComponent(insight.entityType)}&entityId=${encodeURIComponent(insight.entityId)}`}>
                创建或打开 Research Job
              </Link>
            ) : null}
            <button className="text-button" type="button" onClick={() => { setAnswer(null); setInsight(undefined); setFormal(false); setNotice(undefined); setQuestion(''); }}>
              <RotateCcw size={14} aria-hidden="true" />继续提问
            </button>
          </footer>
        </div>
      ) : (
        <>
          <form className="ai-input" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="例如：SKU-01 为什么跑输市场？"
              rows={2}
              aria-label="向 AI 提问"
            />
            <button className="ai-submit" type="submit" disabled={!question.trim() || loading} aria-label="提交问题">
              {loading ? <LoaderCircle className="spin" size={18} aria-hidden="true" /> : <ArrowUp size={18} aria-hidden="true" />}
            </button>
          </form>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="suggestion-row" aria-label="建议问题">
            {suggestions.slice(0, 5).map((suggestion) => (
              <button type="button" key={suggestion} onClick={() => void ask(suggestion)} disabled={loading}>{suggestion}</button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
