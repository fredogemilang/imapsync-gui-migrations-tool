import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Mail, ListChecks, Settings as SettingsIcon, LogOut, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Layout({ onLogout }: { onLogout: () => void }) {
  return (
    <div className="fixed inset-0 w-full flex flex-col overflow-hidden">
      <Header onLogout={onLogout} />
      <div className="flex flex-1 overflow-hidden pb-[88px]">
        <Sidebar />
        <main className="flex-1 flex flex-col relative overflow-hidden">
          <div className="flex-1 overflow-y-auto p-4 md:p-8 lg:p-10">
            <Outlet />
          </div>
        </main>
      </div>
      <BottomNav />
    </div>
  );
}

function Header({ onLogout }: { onLogout: () => void }) {
  return (
    <header className="px-4 md:px-8 py-4 bg-white/80 backdrop-blur-md border-b border-slate-200/60 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="bg-primary text-white rounded-xl p-2">
          <Mail className="h-5 w-5" />
        </div>
        <h1 className="text-primary-dark font-extrabold text-lg">MailMigrate</h1>
      </div>
      <button
        onClick={onLogout}
        className="flex items-center gap-2 text-slate-500 hover:text-primary text-sm font-bold"
      >
        <LogOut className="h-4 w-4" /> Logout
      </button>
    </header>
  );
}

function Sidebar() {
  const items = [
    { to: '/', label: 'Overview', icon: ListChecks },
    { to: '/migrations/new', label: 'New Migration', icon: Mail },
    { to: '/bulk/new', label: 'Bulk Migration', icon: Layers },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
  ];
  return (
    <aside
      data-purpose="sidebar"
      className="hidden md:flex flex-col w-60 p-4 border-r border-slate-200/60"
      style={{
        background: 'linear-gradient(to bottom, rgba(255,255,255,0.4), rgba(255,255,255,0.1))',
        backdropFilter: 'blur(16px)',
      }}
    >
      <nav className="space-y-1">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.to === '/'}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-bold transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-slate-500 hover:bg-white/60 hover:text-primary',
              )
            }
          >
            <it.icon className="h-4 w-4" />
            {it.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}

function BottomNav() {
  const { pathname } = useLocation();
  const items = [
    { to: '/', label: 'Overview', icon: ListChecks },
    { to: '/migrations/new', label: 'Migrate', icon: Mail },
    { to: '/bulk/new', label: 'Bulk', icon: Layers },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
  ];
  return (
    <nav
      data-purpose="bottom-nav"
      className="md:hidden fixed bottom-0 inset-x-0 bg-white/95 backdrop-blur-xl border-t border-slate-200/60 flex items-center justify-around py-2 z-30"
    >
      {items.map((it) => {
        const active = pathname === it.to || (it.to !== '/' && pathname.startsWith(it.to));
        return (
          <NavLink
            key={it.to}
            to={it.to}
            className="group flex flex-col items-center gap-1 p-2 rounded-lg"
          >
            <it.icon className={cn('h-5 w-5', active ? 'text-blue-600' : 'text-slate-400')} />
            <span
              className={cn('text-[10px] font-bold', active ? 'text-blue-600' : 'text-slate-400')}
            >
              {it.label}
            </span>
          </NavLink>
        );
      })}
    </nav>
  );
}
