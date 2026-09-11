import { Suspense, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import {
  BellRing,
  Blocks,
  Bot,
  Boxes,
  BriefcaseBusiness,
  ChartNoAxesCombined,
  ChevronDown,
  CircleGauge,
  DatabaseZap,
  FlaskConical,
  Home,
  ListChecks,
  Menu,
  PackageSearch,
  Radar,
  RefreshCw,
  Settings,
  ShieldAlert,
  Sparkles,
  Workflow,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { DataTask } from '../../shared/types';
import { api } from '../lib/api';
import { useApp } from '../lib/AppContext';
import { formatFreshness } from '../lib/format';
import { Badge } from './Badge';
import { PageLoading } from './StateViews';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    label: 'AI 选品中心',
    items: [
      { to: '/', label: '今日简报', icon: CircleGauge, end: true },
      { to: '/research-jobs', label: '研究任务', icon: Workflow },
    ],
  },
  {
    label: '现有业务',
    items: [
      { to: '/market', label: '记忆棉市场', icon: ChartNoAxesCombined },
      { to: '/owned-products', label: '自有 4 SKU', icon: Boxes },
    ],
  },
  {
    label: '增长机会',
    items: [
      { to: '/development', label: '待开发产品', icon: PackageSearch },
      { to: '/opportunity-lab', label: '新赛道实验室', icon: FlaskConical },
      { to: '/opportunities', label: '机会池', icon: BriefcaseBusiness },
    ],
  },
  {
    label: '监控',
    items: [
      { to: '/monitoring', label: '监控中心', icon: BellRing },
      { to: '/data-tasks', label: '数据任务', icon: ListChecks },
    ],
  },
  {
    label: '系统',
    items: [{ to: '/settings', label: '设置', icon: Settings }],
  },
];

const pageNames: Array<[string, string]> = [
  ['/research-jobs', '研究任务工作流'],
  ['/owned-products', '自有 4 SKU 战情室'],
  ['/opportunity-lab', '新赛道机会实验室'],
  ['/opportunities', '机会池 / 淘汰池'],
  ['/development', '待开发产品'],
  ['/monitoring', '监控中心'],
  ['/data-tasks', '数据任务中心'],
  ['/settings', '系统设置'],
  ['/market', '记忆棉枕头市场'],
  ['/', '今日 AI 简报'],
];

function SidebarNavigation({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="sidebar-nav" aria-label="主导航">
      {navGroups.map((group) => (
        <div className="nav-group" key={group.label}>
          <span className="nav-group__label">{group.label}</span>
          {group.items.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              to={to}
              end={end}
              key={to}
              onClick={onNavigate}
              className={({ isActive }) => clsx('nav-link', isActive && 'is-active')}
            >
              <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

export function AppShell() {
  const location = useLocation();
  const { settings, error: settingsError, refreshAll, reloadSettings, setDemoMode, updateSettings } = useApp();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [marketplaceBusy, setMarketplaceBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => setMobileOpen(false), [location.pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [mobileOpen]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 3600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const pageName = useMemo(
    () => pageNames.find(([path]) => path === '/' ? location.pathname === '/' : location.pathname.startsWith(path))?.[1] ?? '页面',
    [location.pathname],
  );

  const manualRefresh = async () => {
    setSyncing(true);
    try {
      if (settings.mode !== 'empty' && settings.role === 'admin') {
        const task = await api.post<DataTask>('/api/data-tasks/run', { taskType: 'manual_refresh', target: 'all' });
        if (task.status === 'failed' || task.status === 'partial') {
          throw new Error(task.errorLog || (task.status === 'failed' ? '刷新任务执行失败' : '刷新任务仅部分完成'));
        }
        await reloadSettings();
      }
      refreshAll();
      setNotice(settings.mode === 'empty' ? '已重新检查数据连接' : '刷新任务已提交');
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : '刷新失败');
    } finally {
      setSyncing(false);
    }
  };

  const changeMarketplace = async (marketplace: string) => {
    setMarketplaceBusy(true);
    try {
      await updateSettings({ marketplace });
      setNotice(`已切换到 Amazon ${marketplace}`);
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : 'Marketplace 切换失败');
    } finally {
      setMarketplaceBusy(false);
    }
  };

  const exitDemo = async () => {
    try {
      await setDemoMode(false);
      setNotice('已退出演示数据模式');
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : '无法退出演示模式');
    }
  };

  return (
    <div className={clsx('app-shell', settings.mode === 'demo' && 'has-demo-banner')}>
      {settings.mode === 'demo' ? (
        <div className="demo-banner" role="status">
          <FlaskConical size={15} aria-hidden="true" />
          <strong>当前为演示数据模式</strong>
          <span>所有销量、销售额与 AI 结论均为 MOCK，不代表真实业务。</span>
          <button type="button" disabled={settings.role === 'viewer'} title={settings.role === 'viewer' ? '请先在设置中退出 Viewer 预览' : undefined} onClick={() => void exitDemo()}>退出 Demo</button>
        </div>
      ) : null}

      <aside className={clsx('sidebar', mobileOpen && 'is-open')}>
        <div className="brand-lockup">
          <Link to="/" onClick={() => setMobileOpen(false)} aria-label="Amazon AI Opportunity Intelligence 首页">
            <span className="brand-mark"><Radar size={24} aria-hidden="true" /></span>
            <span>
              <strong>ORBIT</strong>
              <small>Opportunity Intelligence</small>
            </span>
          </Link>
          <button className="icon-button sidebar-close" type="button" onClick={() => setMobileOpen(false)} aria-label="关闭导航">
            <X size={19} aria-hidden="true" />
          </button>
        </div>
        <SidebarNavigation onNavigate={() => setMobileOpen(false)} />
        <div className="sidebar-footer">
          <div className="sidebar-footer__status">
            <span className={clsx('status-dot', settings.mode === 'live' ? 'is-live' : settings.mode === 'demo' ? 'is-demo' : '')} />
            <div>
              <strong>{settings.mode === 'live' ? '真实数据已连接' : settings.mode === 'demo' ? 'Demo 数据源' : '等待数据接入'}</strong>
              <small>{formatFreshness(settings.lastSuccessfulSync)}</small>
            </div>
          </div>
          <Link to="/settings?tab=sources" aria-label="管理数据源"><Blocks size={17} aria-hidden="true" /></Link>
        </div>
      </aside>

      {mobileOpen ? <button className="sidebar-backdrop" type="button" onClick={() => setMobileOpen(false)} aria-label="关闭导航" /> : null}

      <div className="app-column">
        <header className="topbar">
          <div className="topbar__left">
            <button className="icon-button mobile-menu" type="button" onClick={() => setMobileOpen(true)} aria-label="打开导航">
              <Menu size={20} aria-hidden="true" />
            </button>
            <div>
              <span className="topbar__context">Amazon {settings.marketplace}</span>
              <h1>{pageName}</h1>
            </div>
          </div>

          <div className="topbar__controls">
            <label className="select-control" title="Marketplace">
              <span>站点</span>
              <select
                value={settings.marketplace}
                disabled={marketplaceBusy || settings.role === 'viewer'}
                onChange={(event) => void changeMarketplace(event.target.value)}
                aria-label="选择 Marketplace"
              >
                <option value="US">US</option>
                <option value="CA">CA</option>
                <option value="UK">UK</option>
                <option value="DE">DE</option>
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </label>
            <div className="freshness-control" title={settings.lastSuccessfulSync ?? '尚未同步'}>
              <DatabaseZap size={16} aria-hidden="true" />
              <span>
                <small>{settings.mode === 'demo' ? 'Mock Adapter' : settings.mode === 'live' ? '已连接数据源' : '未连接'}</small>
                <strong>{formatFreshness(settings.lastSuccessfulSync)}</strong>
              </span>
            </div>
            <Badge tone={settings.role === 'admin' ? 'neutral' : 'info'}>{settings.role === 'admin' ? 'Admin' : 'Viewer 预览'}</Badge>
            <button className="button button--secondary button--sm top-refresh" type="button" onClick={() => void manualRefresh()} disabled={syncing || settings.role === 'viewer'} title={settings.role === 'viewer' ? 'Viewer 预览仅可查看数据' : '提交全量刷新任务'}>
              <RefreshCw className={syncing ? 'spin' : ''} size={16} aria-hidden="true" />
              <span>刷新数据</span>
            </button>
          </div>
        </header>

        {settingsError ? (
          <div className="global-warning" role="alert">
            <ShieldAlert size={16} aria-hidden="true" />
            无法读取系统设置，当前以安全默认值运行。
          </div>
        ) : null}

        <main className="main-content">
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      <nav className="mobile-tabbar" aria-label="移动端快捷导航">
        <NavLink to="/" end><Home size={19} aria-hidden="true" /><span>简报</span></NavLink>
        <NavLink to="/market"><ChartNoAxesCombined size={19} aria-hidden="true" /><span>市场</span></NavLink>
        <NavLink to="/owned-products"><Boxes size={19} aria-hidden="true" /><span>SKU</span></NavLink>
        <NavLink to="/opportunity-lab"><Sparkles size={19} aria-hidden="true" /><span>实验室</span></NavLink>
        <button type="button" onClick={() => setMobileOpen(true)}><Menu size={19} aria-hidden="true" /><span>更多</span></button>
      </nav>

      {notice ? <div className="toast" role="status"><Bot size={16} aria-hidden="true" />{notice}</div> : null}
    </div>
  );
}
