import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Home,
  type LucideIcon,
  Layers,
  ListChecks,
  Lock,
  LogOut,
  Mail,
  Monitor,
  Moon,
  Settings as SettingsIcon,
  Sun,
  Trash2,
  User as UserIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';

// ============================================================================
// Context — per-page customisation
// ============================================================================

type LayoutCtx = {
  setHeaderLeft: (n: ReactNode | null) => void;
  setHeaderAction: (n: ReactNode | null) => void;
  setSidebarTitle: (s: string | null) => void;
  setSidebarIcon: (icon: LucideIcon | null) => void;
  setFooter: (n: ReactNode | null) => void;
};

const LayoutContext = createContext<LayoutCtx | null>(null);

function useLayout() {
  const c = useContext(LayoutContext);
  if (!c) throw new Error('useLayout must be used inside <Layout>');
  return c;
}

// ---- Per-page hooks (declarative) ------------------------------------------

export function useHeaderLeft(node: ReactNode | null, deps: unknown[] = []) {
  const { setHeaderLeft } = useLayout();
  useEffect(() => {
    setHeaderLeft(node);
    return () => setHeaderLeft(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function useHeaderAction(node: ReactNode | null, deps: unknown[] = []) {
  const { setHeaderAction } = useLayout();
  useEffect(() => {
    setHeaderAction(node);
    return () => setHeaderAction(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function useSidebarTitle(title: string) {
  const { setSidebarTitle } = useLayout();
  useEffect(() => {
    setSidebarTitle(title);
    return () => setSidebarTitle(null);
  }, [title, setSidebarTitle]);
}

export function useSidebarIcon(icon: LucideIcon | null) {
  const { setSidebarIcon } = useLayout();
  useEffect(() => {
    setSidebarIcon(icon);
    return () => setSidebarIcon(null);
  }, [icon, setSidebarIcon]);
}

export function useFooter(node: ReactNode | null, deps: unknown[] = []) {
  const { setFooter } = useLayout();
  useEffect(() => {
    setFooter(node);
    return () => setFooter(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// ============================================================================
// Page-title fallback (header-left when no override)
// ============================================================================

const PAGE_TITLES: Array<{ pattern: RegExp; title: string }> = [
  { pattern: /^\/$/, title: 'Overview' },
  { pattern: /^\/migrations\/new\/step2$/, title: 'Migrations' },
  { pattern: /^\/migrations\/new$/, title: 'Migrations' },
  { pattern: /^\/migrations\/[^/]+\/progress$/, title: 'Migrations' },
  { pattern: /^\/migrations\/[^/]+$/, title: 'Your Migration' },
  { pattern: /^\/bulk\/new$/, title: 'Bulk Migration' },
  { pattern: /^\/settings$/, title: 'Settings' },
  { pattern: /^\/change-password$/, title: 'Change Password' },
];

function pageTitleFor(pathname: string): string {
  return PAGE_TITLES.find((p) => p.pattern.test(pathname))?.title ?? 'MailMigrate';
}

// ============================================================================
// Layout
// ============================================================================

export function Layout({ onLogout }: { onLogout: () => void }) {
  const { pathname } = useLocation();
  const [headerLeft, setHeaderLeft] = useState<ReactNode | null>(null);
  const [headerAction, setHeaderAction] = useState<ReactNode | null>(null);
  const [sidebarTitle, setSidebarTitle] = useState<string | null>(null);
  const [sidebarIcon, setSidebarIcon] = useState<LucideIcon | null>(null);
  const [footer, setFooter] = useState<ReactNode | null>(null);

  const ctx = useMemo<LayoutCtx>(
    () => ({ setHeaderLeft, setHeaderAction, setSidebarTitle, setSidebarIcon, setFooter }),
    [],
  );

  return (
    <LayoutContext.Provider value={ctx}>
      <div className="fixed inset-0 w-full flex flex-col overflow-hidden">
        <Header
          left={headerLeft ?? <HeaderTitle title={pageTitleFor(pathname)} />}
          action={headerAction}
          onLogout={onLogout}
        />

        <div className="flex flex-1 overflow-hidden pb-[88px]">
          <Sidebar title={sidebarTitle ?? pageTitleFor(pathname)} Icon={sidebarIcon ?? Home} />

          <main
            className="flex-1 flex flex-col relative overflow-hidden"
            data-purpose="main-content"
          >
            <div className="flex-1 overflow-y-auto p-4 md:p-8 lg:p-10">
              <Outlet />
              {/* Bottom spacer — keeps the last bit of page content from
                  sliding under the sticky action footer. Padding on the
                  scroll container collapses with the child's flow margins
                  on some pages, so we drop a real height-occupying div
                  here. h-24 = 6rem = 96px which clears the typical
                  ~90-120px tall footer with room to breathe. */}
              {footer && <div className="h-24 shrink-0" aria-hidden />}
            </div>
            {footer && (
              <div className="absolute bottom-0 inset-x-0 bg-white/80 backdrop-blur-md border-t border-slate-200/60 pt-4 pb-6 flex flex-col items-center z-10 px-4 md:px-10">
                {footer}
              </div>
            )}
          </main>
        </div>

        <BottomNav />
      </div>
    </LayoutContext.Provider>
  );
}

// ============================================================================
// Header — variants
// ============================================================================

function Header({
  left,
  action,
  onLogout,
}: {
  left: ReactNode;
  action: ReactNode | null;
  onLogout: () => void;
}) {
  return (
    <header
      data-purpose="main-header"
      className="w-full bg-white border-b border-slate-200/80 px-4 md:px-6 py-4 flex justify-between items-center z-30"
    >
      <div className="flex items-center space-x-4 md:space-x-6">{left}</div>
      <div className="flex items-center space-x-4 md:space-x-8">
        {action}
        <div className="flex items-center space-x-3 md:space-x-5">
          <NotificationsBell />
          <ProfileMenu onLogout={onLogout} />
        </div>
      </div>
    </header>
  );
}

// ---- Header LEFT variants ---------------------------------------------------

function HeaderTitle({ title }: { title: string }) {
  return <h1 className="text-primary font-bold text-lg leading-none">{title}</h1>;
}

/** Back link — used by detail pages (your-migration, settings, change-password) */
export function HeaderBackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="flex items-center space-x-4 md:space-x-6 group hover:opacity-80 transition-opacity no-underline"
    >
      <ArrowLeft
        className="h-5 w-5 md:h-6 md:w-6 text-primary group-hover:-translate-x-1 transition-transform"
        strokeWidth={2.5}
      />
      <span className="text-primary font-bold text-lg leading-none">{label}</span>
    </Link>
  );
}

/** Step counter — used by wizard pages */
export function HeaderStepCounter({ current, total }: { current: number; total: number }) {
  return (
    <div className="text-primary font-bold text-lg leading-none">
      {current} / {total}
    </div>
  );
}

// ---- Header ACTION variants -------------------------------------------------

export function HeaderDeleteFinished({ onClick }: { onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="hidden md:flex items-center text-primary/80 hover:text-primary transition-all text-sm font-semibold group"
    >
      <Trash2 className="h-5 w-5 mr-2 group-hover:scale-110 transition-transform" />
      Delete Finished
    </button>
  );
}

export function HeaderDelete({ onClick }: { onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="hidden md:flex items-center text-primary/80 hover:text-primary transition-all text-sm font-semibold group"
    >
      <Trash2 className="h-5 w-5 mr-2 group-hover:scale-110 transition-transform" />
      Delete
    </button>
  );
}

export function HeaderStepArrows({ prev, next }: { prev?: string; next?: string }) {
  return (
    <div className="flex items-center gap-6">
      {prev !== undefined ? (
        <Link
          to={prev}
          title="Previous"
          className="text-slate-400 hover:text-primary transition-colors duration-200"
        >
          <ChevronLeft className="h-6 w-6" strokeWidth={2.5} />
        </Link>
      ) : (
        <span className="text-slate-200 cursor-not-allowed">
          <ChevronLeft className="h-6 w-6" strokeWidth={2.5} />
        </span>
      )}
      {next !== undefined ? (
        <Link
          to={next}
          title="Next"
          className="text-primary hover:text-blue-600 transition-colors duration-200"
        >
          <ChevronRight className="h-6 w-6" strokeWidth={2.5} />
        </Link>
      ) : (
        <span className="text-slate-200 cursor-not-allowed">
          <ChevronRight className="h-6 w-6" strokeWidth={2.5} />
        </span>
      )}
    </div>
  );
}

// ============================================================================
// Notifications bell
// ============================================================================

type Notif = {
  id: string;
  kind: 'success' | 'error' | 'warning' | 'info' | string;
  title: string;
  body: string;
  linkPath: string | null;
  readAt: string | null;
  createdAt: string;
};

/** "2 minutes ago" / "yesterday" / "May 28" formatter. Locale-aware
 *  via toLocaleDateString for dates >1 week old. */
function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(t).toLocaleDateString();
}

function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notif[]>([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);

  // Poll unread list every 30s so the bell stays current without a
  // websocket. When dropdown is open, refresh on open + every 10s so
  // items dropping out of unread (via click) feel snappy.
  const fetchList = async () => {
    setLoading(true);
    try {
      const rows = (await api.listNotifications()) as Notif[];
      setItems(rows);
    } catch {
      // Silent — bell isn't critical-path UI.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchList();
    const pollMs = open ? 10_000 : 30_000;
    const t = setInterval(fetchList, pollMs);
    return () => clearInterval(t);
  }, [open]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);

  /** Click a notification → mark read + navigate. Optimistically remove
   *  from the list so the bell badge updates instantly without waiting
   *  for the next poll tick. */
  const onClickItem = async (n: Notif) => {
    setItems((prev) => prev.filter((x) => x.id !== n.id));
    setOpen(false);
    void api.markNotificationRead(n.id).catch(() => {
      /* swallow — UI already moved on, next poll will reconcile */
    });
    if (n.linkPath) navigate(n.linkPath);
  };

  const onMarkAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setItems([]);
    try {
      await api.markAllNotificationsRead();
    } catch {
      // Next poll will reconcile.
    }
  };

  const unread = items.length;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
        className="relative cursor-pointer flex items-center focus:outline-none active:scale-95 transition-transform"
      >
        <Bell
          className="h-6 w-6 text-slate-400 hover:text-slate-600 transition-colors"
          strokeWidth={2}
        />
        {unread > 0 && (
          <span className="absolute -top-2.5 -right-3 bg-white text-blue-600 text-[10px] font-extrabold px-1.5 py-0.5 rounded-full border border-blue-500 shadow-sm leading-none">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2.5 w-80 bg-white border border-slate-200/80 rounded-xl shadow-xl z-50 overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <span className="text-primary-dark font-bold text-sm">
              Notifications
              {loading && <span className="ml-2 text-[10px] text-slate-400 font-medium">…</span>}
            </span>
            {unread > 0 && (
              <button
                onClick={onMarkAll}
                className="text-xs text-blue-600 hover:text-blue-800 font-semibold"
              >
                Mark all as read
              </button>
            )}
          </div>
          <div className="max-h-72 overflow-y-auto divide-y divide-slate-100/60">
            {items.length === 0 ? (
              <div className="px-4 py-8 text-center text-slate-400 text-xs font-medium">
                <Bell className="h-6 w-6 mx-auto text-slate-300 mb-2" strokeWidth={1.5} />
                You&rsquo;re all caught up
              </div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => void onClickItem(n)}
                  className="w-full text-left p-3.5 hover:bg-slate-50 transition-colors flex gap-3 cursor-pointer"
                >
                  <div
                    className={cn(
                      'w-8 h-8 rounded-full flex items-center justify-center shrink-0 border text-sm font-bold',
                      n.kind === 'success' && 'bg-green-50 border-green-200 text-green-500',
                      n.kind === 'error' && 'bg-red-50 border-red-200 text-red-500',
                      n.kind === 'warning' && 'bg-amber-50 border-amber-200 text-amber-500',
                      n.kind === 'info' && 'bg-blue-50 border-blue-200 text-blue-500',
                    )}
                  >
                    {n.kind === 'success'
                      ? '✓'
                      : n.kind === 'error'
                        ? '!'
                        : n.kind === 'warning'
                          ? '!'
                          : 'i'}
                  </div>
                  <div className="flex flex-col gap-0.5 pr-2 min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-slate-700 leading-tight truncate">
                      {n.title}
                    </p>
                    {n.body && (
                      <p className="text-[11px] text-slate-500 leading-snug line-clamp-2">
                        {n.body}
                      </p>
                    )}
                    <span className="text-[9.5px] text-slate-400 mt-0.5">
                      {relativeTime(n.createdAt)}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Profile dropdown
// ============================================================================

type ThemeMode = 'light' | 'dark' | 'system';

function getInitialTheme(): ThemeMode {
  return (localStorage.getItem('theme-mode') as ThemeMode) || 'system';
}

function applyTheme(mode: ThemeMode) {
  localStorage.setItem('theme-mode', mode);
  const isDark =
    mode === 'dark' ||
    (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', isDark);
}

function ProfileMenu({ onLogout }: { onLogout: () => void }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState<string>('');
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .me()
      .then((r) => setEmail(r.email))
      .catch(() => {});
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);

  const initial = (email[0] ?? 'A').toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex items-center space-x-1 cursor-pointer group rounded-full hover:bg-slate-100/50 transition-colors p-1 focus:outline-none"
      >
        <div className="h-9 w-9 md:h-10 md:w-10 rounded-full bg-black text-white flex items-center justify-center font-bold text-[15px] md:text-[16px] select-none ring-2 ring-white shadow-sm">
          {initial}
        </div>
        <ChevronDown className="h-4 w-4 text-slate-400 group-hover:text-slate-600 transition-colors" />
      </button>
      {open && (
        <div className="absolute right-0 mt-2.5 w-64 bg-white border border-slate-200/80 rounded-xl shadow-xl z-50 overflow-hidden flex flex-col">
          <button
            onClick={() => {
              setOpen(false);
              navigate('/settings');
            }}
            className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50 border-b border-slate-100 text-primary-dark font-semibold text-sm text-left"
          >
            <UserIcon className="h-5 w-5 text-slate-400" />
            <span>Admin</span>
          </button>
          <button
            onClick={() => {
              setOpen(false);
              navigate('/change-password');
            }}
            className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50 border-b border-slate-100 text-primary-dark font-semibold text-sm text-left"
          >
            <Lock className="h-5 w-5 text-slate-400" />
            <span>Change Password</span>
          </button>
          <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between gap-2">
            <ThemeBtn
              active={theme === 'light'}
              onClick={() => setTheme('light')}
              title="Light mode"
            >
              <Sun className="h-4 w-4" />
            </ThemeBtn>
            <ThemeBtn active={theme === 'dark'} onClick={() => setTheme('dark')} title="Dark mode">
              <Moon className="h-4 w-4" />
            </ThemeBtn>
            <ThemeBtn active={theme === 'system'} onClick={() => setTheme('system')} title="System">
              <Monitor className="h-4 w-4" />
            </ThemeBtn>
          </div>
          <button
            onClick={onLogout}
            className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50 text-primary-dark font-semibold text-sm text-left"
          >
            <LogOut className="h-5 w-5 text-slate-400" />
            <span>Sign out</span>
          </button>
        </div>
      )}
    </div>
  );
}

function ThemeBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      className={cn(
        'flex-1 py-2 flex items-center justify-center rounded-lg transition-colors',
        active
          ? 'bg-slate-100 text-blue-600 hover:bg-slate-200/60'
          : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600',
      )}
    >
      {children}
    </button>
  );
}

// ============================================================================
// Sidebar
// ============================================================================

function Sidebar({ title, Icon }: { title: string; Icon: LucideIcon }) {
  return (
    <aside
      data-purpose="left-sidebar"
      className="border-r border-slate-200/60 bg-white/40 backdrop-blur-sm flex-col relative hidden md:flex w-64 lg:w-80"
    >
      <div className="p-8 flex-1 flex flex-col justify-center">
        <h2 className="text-3xl font-bold text-primary-dark leading-tight mt-20">{title}</h2>
      </div>
      <div className="absolute bottom-10 left-10 opacity-[0.05] pointer-events-none">
        <Icon className="text-primary-dark" size={200} strokeWidth={1} />
      </div>
    </aside>
  );
}

// ============================================================================
// Bottom Nav
// ============================================================================

const NAV_ITEMS = [
  { to: '/', label: 'Overview', icon: ListChecks, matches: (p: string) => p === '/' },
  {
    to: '/migrations/new',
    label: 'Migrations',
    icon: Mail,
    matches: (p: string) =>
      p === '/migrations/new' ||
      p === '/migrations/new/step2' ||
      /^\/migrations\/[^/]+$/.test(p) ||
      /^\/migrations\/[^/]+\/progress$/.test(p),
  },
  {
    to: '/bulk/new',
    label: 'Bulk Migration',
    icon: Layers,
    matches: (p: string) => p.startsWith('/bulk'),
  },
  {
    to: '/settings',
    label: 'Settings',
    icon: SettingsIcon,
    matches: (p: string) => p === '/settings' || p === '/change-password',
  },
];

function BottomNav() {
  const { pathname } = useLocation();
  return (
    <nav
      data-purpose="bottom-nav"
      className="absolute bottom-0 inset-x-0 bg-white border-t border-slate-200/80 px-4 md:px-6 py-3 flex justify-center z-[60] shadow-[0_-4px_20px_-10px_rgba(0,0,0,0.05)]"
    >
      <ul className="flex w-full max-w-4xl justify-around items-center">
        {NAV_ITEMS.map((it) => {
          const active = it.matches(pathname);
          return (
            <li key={it.to}>
              <NavLink
                to={it.to}
                className={cn(
                  'group flex flex-col items-center justify-center w-20 md:w-24 space-y-1 transition-colors',
                  active ? 'text-blue-500' : 'text-primary hover:text-blue-600',
                )}
              >
                <div
                  className={cn(
                    'p-2 rounded-xl transition-colors',
                    active ? 'bg-blue-50' : 'group-hover:bg-slate-50',
                  )}
                >
                  <it.icon className="h-6 w-6 md:h-7 md:w-7" strokeWidth={1.5} />
                </div>
                <span
                  className={cn(
                    'text-[10px] md:text-[11px] tracking-wide',
                    active ? 'font-semibold' : 'font-medium',
                  )}
                >
                  {it.label}
                </span>
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
