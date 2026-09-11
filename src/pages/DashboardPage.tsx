import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  BellRing,
  Boxes,
  BriefcaseBusiness,
  ChartNoAxesCombined,
  Clock3,
  Lightbulb,
  PackageSearch,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import type { BriefingItem, DashboardData } from '../../shared/types';
import { AIComposer } from '../components/AIComposer';
import { Badge } from '../components/Badge';
import { EvidenceDrawer } from '../components/EvidenceDrawer';
import { MetricCard } from '../components/MetricCard';
import { Onboarding } from '../components/Onboarding';
import { EmptyState, ErrorState, PageLoading } from '../components/StateViews';
import { useApi } from '../lib/api';
import { useApp } from '../lib/AppContext';
import { formatCurrency, formatDateTime, formatPercent } from '../lib/format';
import { severityMeta } from '../lib/status';

function briefingLink(item: BriefingItem): string {
  if (item.entityType.includes('development')) return `/development?project=${item.entityId}`;
  if (item.entityType.includes('opportunity')) return `/opportunities?opportunity=${item.entityId}`;
  if (item.entityType.includes('owned') || item.entityType.includes('product')) return `/owned-products/${item.entityId}`;
  if (item.entityType.includes('market')) return `/market?market=${item.entityId}`;
  return '/monitoring';
}

const briefingIcons = {
  critical: ShieldAlert,
  warning: AlertTriangle,
  opportunity: Lightbulb,
  info: BellRing,
};

function BriefingRow({ item, index }: { item: BriefingItem; index: number }) {
  const meta = severityMeta[item.severity];
  const Icon = briefingIcons[item.severity];
  return (
    <article className={`briefing-row briefing-row--${meta.tone}`}>
      <div className="briefing-row__index">{String(index + 1).padStart(2, '0')}</div>
      <div className="briefing-row__icon"><Icon size={18} aria-hidden="true" /></div>
      <div className="briefing-row__body">
        <div className="briefing-row__meta">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <span>{item.category}</span>
          <strong>{item.metric}</strong>
        </div>
        <h3>{item.title}</h3>
        <p>{item.summary}</p>
        <div className="briefing-row__action"><Sparkles size={14} aria-hidden="true" />建议：{item.action}</div>
      </div>
      <div className="briefing-row__tools">
        <EvidenceDrawer insight={item.insight} />
        <Link className="icon-button" to={briefingLink(item)} aria-label={`查看 ${item.title}`}>
          <ArrowRight size={17} aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}

export default function DashboardPage() {
  const { settings, loading: settingsLoading, refreshKey } = useApp();
  const query = useApi<DashboardData>(settings.mode === 'empty' ? null : `/api/dashboard/briefing?marketplace=${encodeURIComponent(settings.marketplace)}`, refreshKey);

  if (settingsLoading) return <PageLoading label="正在检查数据连接" />;
  if (settings.mode === 'empty') return <Onboarding />;
  if (query.loading && !query.data) return <PageLoading label="正在生成今日 AI 简报" />;
  if (query.error && !query.data) {
    return <ErrorState error={query.error} onRetry={query.reload} lastSuccessfulSync={settings.lastSuccessfulSync} />;
  }
  if (!query.data) return null;

  const { briefing, summaries, suggestedQuestions, generatedAt } = query.data;

  return (
    <div className="page-stack dashboard-page">
      {query.error ? <ErrorState compact error={query.error} onRetry={query.reload} lastSuccessfulSync={settings.lastSuccessfulSync} /> : null}

      <section className="page-heading page-heading--compact">
        <div>
          <span className="eyebrow">DECISION BRIEF · {settings.marketplace}</span>
          <h1>今天最值得你关注的变化</h1>
          <p>优先呈现会改变产品、市场或开发决策的信号。</p>
        </div>
        <div className="page-heading__meta">
          <Clock3 size={15} aria-hidden="true" />
          <span>简报生成于 {formatDateTime(generatedAt)}</span>
          {query.refreshing ? <Badge tone="info">正在刷新</Badge> : null}
        </div>
      </section>

      <div className="dashboard-lead">
        <section className="briefing-section">
          <header className="section-header">
            <div>
              <span className="eyebrow">AI BRIEFING</span>
              <h2>优先级简报</h2>
            </div>
            <Badge tone={briefing.some((item) => item.severity === 'critical') ? 'critical' : 'positive'}>
              {briefing.length} 条有效信号
            </Badge>
          </header>
          {briefing.length ? (
            <div className="briefing-list">
              {briefing.map((item, index) => <BriefingRow item={item} index={index} key={item.id} />)}
            </div>
          ) : (
            <EmptyState title="暂无正式工作流结论" description="创建并运行市场或 SKU Research Job 后，带规则版本与 Evidence 的结论会出现在这里。" />
          )}
        </section>

        <aside className="decision-pulse">
          <header>
            <span className="eyebrow">BUSINESS PULSE</span>
            <h2>业务脉搏</h2>
          </header>
          <div className="pulse-row">
            <span><ChartNoAxesCombined size={16} aria-hidden="true" />记忆棉市场</span>
            <strong>{summaries.market.growth30dAvailable ? formatPercent(summaries.market.growth30d) : '—'}</strong>
            <small>{!summaries.market.snapshotAvailable ? '待采集市场快照' : summaries.market.growth30dAvailable ? `30 天 · ${summaries.market.status}` : '已采集单期 · 基线不足'}</small>
          </div>
          <div className="pulse-row">
            <span><Boxes size={16} aria-hidden="true" />自有 SKU</span>
            <strong>{summaries.skus.analyzable ? summaries.skus.underperform : '—'}</strong>
            <small>{summaries.skus.analyzable ? `个跑输 · ${summaries.skus.anomalies} 个异常` : `${summaries.skus.pendingData} 个待补数据`}</small>
          </div>
          <div className="pulse-row">
            <span><PackageSearch size={16} aria-hidden="true" />待开发</span>
            <strong>{summaries.development.recommended}</strong>
            <small>个建议开发</small>
          </div>
          <div className="pulse-row">
            <span><BriefcaseBusiness size={16} aria-hidden="true" />新机会</span>
            <strong>{summaries.opportunities.pending}</strong>
            <small>个等待审核</small>
          </div>
          <Link className="button button--secondary button--block" to="/monitoring">查看全部监控 <ArrowRight size={16} aria-hidden="true" /></Link>
        </aside>
      </div>

      <section>
        <header className="section-header section-header--spaced">
          <div>
            <span className="eyebrow">AT A GLANCE</span>
            <h2>四条业务线</h2>
          </div>
        </header>
        <div className="metric-grid metric-grid--four">
          <MetricCard
            label="现有市场月销售额"
            value={summaries.market.snapshotAvailable ? formatCurrency(summaries.market.monthlyRevenue, settings.currency, true) : '—'}
            trend={summaries.market.growth30dAvailable && summaries.market.growth30d !== null ? summaries.market.growth30d : undefined}
            detail={!summaries.market.snapshotAvailable ? '待采集市场快照' : summaries.market.growth30dAvailable ? '30 天' : '单期快照 · 基线不足'}
            icon={ChartNoAxesCombined}
            tone={!summaries.market.snapshotAvailable || !summaries.market.growth30dAvailable || summaries.market.growth30d === null ? 'warning' : summaries.market.growth30d >= 0 ? 'positive' : 'warning'}
          />
          <MetricCard
            label="自有 SKU 相对表现"
            value={summaries.skus.analyzable ? `${summaries.skus.outperform} 跑赢` : '—'}
            detail={summaries.skus.analyzable ? `${summaries.skus.inLine} 同步 · ${summaries.skus.underperform} 跑输` : `${summaries.skus.pendingData} 个待补数据`}
            icon={Boxes}
            tone={!summaries.skus.analyzable ? 'warning' : summaries.skus.underperform > summaries.skus.outperform ? 'critical' : 'default'}
          />
          <MetricCard
            label="邻近开发项目"
            value={summaries.development.analyzable ? `${summaries.development.watching} 个观察中` : '—'}
            detail={summaries.development.analyzable ? `${summaries.development.riskRising} 个风险上升` : `${summaries.development.pendingData} 个待采集数据`}
            icon={PackageSearch}
            tone={!summaries.development.analyzable || summaries.development.riskRising ? 'warning' : 'default'}
          />
          <MetricCard
            label="本周发现机会"
            value={`${summaries.opportunities.foundThisWeek} 个`}
            detail={`${summaries.opportunities.pooled} 个已入池`}
            icon={BriefcaseBusiness}
            tone="positive"
          />
        </div>
      </section>

      <AIComposer suggestions={suggestedQuestions} />
    </div>
  );
}
