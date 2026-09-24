import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import {
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
import { useApp } from '../lib/AppContext';
import { formatFreshness } from '../lib/format';
import { ExecutiveAiDrawer } from './ExecutiveAiDrawer';
import { PageLoading } from './StateViews';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
  collapsible?: boolean;
}

const navGroups: NavGroup[] = [
  {
    id: 'dashboard',
    label: '',
    items: [
      { to: '/', label: 'AI 经营驾驶舱', icon: CircleGauge, end: true },
    ],
  },
  {
    id: 'current',
    label: '现有业务',
    items: [
      { to: '/market', label: '市场情报', icon: ChartNoAxesCombined },
      { to: '/owned-products', label: '自有产品', icon: Boxes },
    ],
  },
  {
    id: 'growth',
    label: '增长机会',
    items: [
      { to: '/development', label: '待开发产品', icon: PackageSearch },
      { to: '/opportunity-lab', label: '新赛道实验室', icon: FlaskConical },
      { to: '/opportunities', label: '机会池', icon: BriefcaseBusiness },
    ],
  },
  {
    id: 'research',
    label: '研究与数据',
    collapsible: true,
    items: [
      { to: '/research-jobs', label: '研究任务', icon: Workflow },
      { to: '/data-tasks', label: '数据任务', icon: ListChecks },
    ],
  },
  {
    id: 'settings',
    label: '设置',
    collapsible: true,
    items: [{ to: '/settings', label: '设置', icon: Settings }],
  },
];

const pageNames: Array<[string, string]> = [
  ['/research-jobs', '研究任务工作流'],
  ['/owned-products', '自有产品战情室'],
  ['/opportunity-lab', '新赛道机会实验室'],
  ['/opportunities', '机会池 / 淘汰池'],
  ['/development', '待开发产品'],
  ['/monitoring', '监控中心'],
  ['/data-tasks', '数据任务中心'],
  ['/settings', '系统设置'],
  ['/market', '市场情报'],
  ['/', 'AI 经营驾驶舱'],
];

function SidebarNavigation({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => Object.fromEntries(
    navGroups.filter((group) => group.collapsible).map((group) => [
      group.id,
      group.items.some((item) => location.pathname.startsWith(item.to)),
    ]),
  ));

  useEffect(() => {
    setExpanded((current) => {
      const next = { ...current };
      navGroups.filter((group) => group.collapsible).forEach((group) => {
        if (group.items.some((item) => location.pathname.startsWith(item.to))) next[group.id] = true;
      });
      return next;
    });
  }, [location.pathname]);

  return (
    <nav className="sidebar-nav" aria-label="主导航">
      {navGroups.map((group) => (
        <div className={clsx('nav-group', !group.label && 'nav-group--primary')} key={group.id}>
          {group.collapsible ? (
            <button
              className="nav-group__toggle"
              type="button"
              aria-expanded={expanded[group.id] ?? false}
              onClick={() => setExpanded((current) => ({ ...current, [group.id]: !current[group.id] }))}
            >
              <span>{group.label}</span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          ) : group.label ? <span className="nav-group__label">{group.label}</span> : null}
          {!group.collapsible || expanded[group.id] ? (
            <div className="nav-group__items">
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
          ) : null}
        </div>
      ))}
    </nav>
  );
}

export function AppShell() {
  const location = useLocation();
  const { settings, error: settingsError, refreshAll, setDemoMode, updateSettings } = useApp();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [marketplaceBusy, setMarketplaceBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia?.('(max-width: 1100px)').matches
  ));
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setMobileOpen(false), [location.pathname]);

  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 1100px)');
    if (!media) return;
    const updateViewport = () => setIsMobileViewport(media.matches);
    updateViewport();
    media.addEventListener('change', updateViewport);
    return () => media.removeEventListener('change', updateViewport);
  }, []);

  useEffect(() => {
    if (!isMobileViewport) setMobileOpen(false);
  }, [isMobileViewport]);

  useEffect(() => {
    if (!mobileOpen || !isMobileViewport) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => sidebarCloseRef.current?.focus());
    const selector = 'a[href], button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !sidebarRef.current) return;
      const focusable = Array.from(sidebarRef.current.querySelectorAll<HTMLElement>(selector));
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
  }, [isMobileViewport, mobileOpen]);

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
      refreshAll();
      setNotice('已刷新本地数据。需要采集时，请在数据源设置中预览调用计划。');
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

      <aside
        ref={sidebarRef}
        id="primary-sidebar"
        className={clsx('sidebar', mobileOpen && 'is-open')}
        aria-hidden={isMobileViewport && !mobileOpen ? true : undefined}
        aria-modal={isMobileViewport && mobileOpen ? true : undefined}
        aria-label={isMobileViewport ? '主导航面板' : undefined}
        role={isMobileViewport ? 'dialog' : undefined}
        inert={isMobileViewport && !mobileOpen}
      >
        <div className="brand-lockup">
          <Link to="/" onClick={() => setMobileOpen(false)} aria-label="Amazon AI Opportunity Intelligence 首页">
            <span className="brand-mark"><Radar size={24} aria-hidden="true" /></span>
            <span>
              <strong>AI 经营驾驶舱</strong>
              <small>Amazon Decision System</small>
            </span>
          </Link>
          <button ref={sidebarCloseRef} className="icon-button sidebar-close" type="button" onClick={() => setMobileOpen(false)} aria-label="关闭导航">
            <X size={19} aria-hidden="true" />
          </button>
        </div>
        <SidebarNavigation onNavigate={() => setMobileOpen(false)} />
        <div className="sidebar-footer">
          <div className="sidebar-footer__status">
            <span className={clsx('status-dot', settings.mode === 'live' ? 'is-live' : settings.mode === 'demo' ? 'is-demo' : '')} />
            <div>
              <strong>{settings.mode === 'live' ? 'Live 工作区' : settings.mode === 'demo' ? 'Demo 数据源' : '等待数据接入'}</strong>
              <small>{formatFreshness(settings.lastSuccessfulSync)}</small>
            </div>
          </div>
          <Link to="/settings?tab=sources" aria-label="管理数据源"><Blocks size={17} aria-hidden="true" /></Link>
        </div>
      </aside>

      {mobileOpen ? <button className="sidebar-backdrop" type="button" onClick={() => setMobileOpen(false)} aria-label="关闭导航" /> : null}

      <div className="app-column" inert={isMobileViewport && mobileOpen}>
        <header className="topbar">
          <div className="topbar__left">
            <button className="icon-button mobile-menu" type="button" onClick={() => setMobileOpen(true)} aria-label="打开导航" aria-controls="primary-sidebar" aria-expanded={mobileOpen}>
              <Menu size={20} aria-hidden="true" />
            </button>
            <div>
              <span className="topbar__context">Amazon {settings.marketplace}</span>
              <strong className="topbar__page-name">{location.pathname === '/' ? '经营总览' : pageName}</strong>
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
                <small>{settings.mode === 'demo' ? 'Mock Adapter' : settings.mode === 'live' ? '系统最近同步' : '尚未同步'}</small>
                <strong>{formatFreshness(settings.lastSuccessfulSync)}</strong>
              </span>
            </div>
            <ExecutiveAiDrawer />
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

      <nav className="mobile-tabbar" aria-label="移动端快捷导航" inert={isMobileViewport && mobileOpen}>
        <NavLink to="/" end><Home size={19} aria-hidden="true" /><span>驾驶舱</span></NavLink>
        <NavLink to="/market"><ChartNoAxesCombined size={19} aria-hidden="true" /><span>市场</span></NavLink>
        <NavLink to="/owned-products"><Boxes size={19} aria-hidden="true" /><span>SKU</span></NavLink>
        <NavLink to="/opportunity-lab"><Sparkles size={19} aria-hidden="true" /><span>实验室</span></NavLink>
        <button type="button" onClick={() => setMobileOpen(true)} aria-controls="primary-sidebar" aria-expanded={mobileOpen}><Menu size={19} aria-hidden="true" /><span>更多</span></button>
      </nav>

      {notice ? <div className="toast" role="status"><Bot size={16} aria-hidden="true" />{notice}</div> : null}
    </div>
  );
}
