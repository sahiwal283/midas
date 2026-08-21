import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, ReceiptText, ClipboardList, Settings, LogOut, Briefcase,
  BarChart3, Activity, Heart, PanelLeftClose, PanelLeftOpen, Wallet,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import client from '../api/client';
import { MIDAS_VERSION } from '@midas/shared';
import { MidasLogo, MidasWordmark } from './MidasLogo';
import { NotificationBell } from './NotificationBell';
import { accountantNavActive } from '../lib/navActive';

const COLLAPSE_KEY = 'midas.sidebarCollapsed';

// Navy rail. The active row carries a gold spine — gold reads 7.94:1 on navy,
// where on the light content area it would only manage 1.98:1.
const linkClass = (isActive: boolean, collapsed: boolean) =>
  `relative flex items-center rounded-lg py-2 text-sm font-medium transition-colors duration-150 ${
    collapsed ? 'justify-center px-0' : 'gap-3 pl-4 pr-3'
  } ${
    isActive
      ? 'bg-white/[0.08] text-cream before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-full before:bg-gold-400'
      : 'text-brand-200 hover:bg-white/[0.05] hover:text-cream'
  }`;

function SectionLabel({ children, collapsed }: { children: React.ReactNode; collapsed: boolean }) {
  // Collapsed rail keeps the grouping as a quiet divider instead of a label.
  if (collapsed) return <div className="mx-2 mb-1.5 mt-3 border-t border-white/10" />;
  return (
    <p className="px-4 pt-4 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-300">
      {children}
    </p>
  );
}

function RailLink({
  to, icon, label, collapsed, isActive,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
  /** Override NavLink's own matching (used by the accountant routes). */
  isActive?: boolean;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive: navActive }) => linkClass(isActive ?? navActive, collapsed)}
      title={collapsed ? label : undefined}
      aria-label={label}
    >
      {icon}
      {!collapsed && <span className="truncate">{label}</span>}
    </NavLink>
  );
}

export function Sidebar() {
  const { user, logout } = useAuth();
  const isDeveloper = user?.role === 'developer';
  const isPrivileged = user?.role === 'accountant' || user?.role === 'admin' || isDeveloper;
  const isAdmin = user?.role === 'admin' || isDeveloper;
  const isPartner = user?.role === 'partner' || isDeveloper;

  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1');
  function toggleCollapsed() {
    setCollapsed((c) => {
      localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      return !c;
    });
  }

  const { data: meta } = useQuery({
    queryKey: ['meta'],
    queryFn: () => client.get<{ version: string }>('/meta').then((r) => r.data),
    staleTime: Infinity,
  });

  const version = `v${meta?.version ?? MIDAS_VERSION}`;
  const accountantActive = accountantNavActive(useLocation());

  return (
    <aside
      className={`flex h-screen flex-col bg-brand-800 transition-[width] duration-200 ease-out ${
        collapsed ? 'w-[72px]' : 'w-60'
      }`}
    >
      {/* Bare gold mark: a plate would vanish against the navy rail. */}
      <div className={`flex h-16 items-center border-b border-white/10 ${collapsed ? 'justify-center' : 'gap-2.5 px-4'}`}>
        <MidasLogo size={28} bare className="shrink-0 text-gold-400" />
        {!collapsed && <MidasWordmark className="text-[1.35rem] leading-none text-cream" />}
      </div>

      <nav className={`flex-1 overflow-y-auto ${collapsed ? 'p-2' : 'p-3'}`}>
        <SectionLabel collapsed={collapsed}>Workspace</SectionLabel>
        <div className="space-y-0.5">
          <RailLink to="/dashboard" icon={<LayoutDashboard className="h-4 w-4 shrink-0" />} label="Dashboard" collapsed={collapsed} />
          <RailLink to="/expenses" icon={<ReceiptText className="h-4 w-4 shrink-0" />} label="My Expenses" collapsed={collapsed} />
        </div>

        {isPartner && (
          <>
            <SectionLabel collapsed={collapsed}>Partner</SectionLabel>
            <RailLink to="/partner-expenses" icon={<Briefcase className="h-4 w-4 shrink-0" />} label="Partner Expenses" collapsed={collapsed} />
          </>
        )}

        {isPrivileged && (
          <>
            <SectionLabel collapsed={collapsed}>Accountant</SectionLabel>
            <div className="space-y-0.5">
              {/* Active state is computed rather than left to NavLink so that
                  an expense detail page (/accountant/<id>) lights up neither. */}
              <RailLink to="/accountant/events" icon={<ClipboardList className="h-4 w-4 shrink-0" />} label="Event Review" collapsed={collapsed} isActive={accountantActive.eventReview} />
              <RailLink to="/accountant/daily" icon={<ReceiptText className="h-4 w-4 shrink-0" />} label="Daily Review" collapsed={collapsed} isActive={accountantActive.dailyReview} />
              <RailLink to="/cashbook" icon={<Wallet className="h-4 w-4 shrink-0" />} label="Cashbook" collapsed={collapsed} />
              <RailLink to="/reports" icon={<BarChart3 className="h-4 w-4 shrink-0" />} label="Reports" collapsed={collapsed} />
            </div>
          </>
        )}

        <SectionLabel collapsed={collapsed}>{isAdmin ? 'Admin' : 'Account'}</SectionLabel>
        {isAdmin && (
          <RailLink to="/integration-health" icon={<Activity className="h-4 w-4 shrink-0" />} label="Integration Health" collapsed={collapsed} />
        )}
        <RailLink to="/admin" icon={<Settings className="h-4 w-4 shrink-0" />} label="Settings" collapsed={collapsed} />
      </nav>

      {!collapsed && (
        <div className="px-4 pb-2 pt-2 text-center">
          <p className="flex items-center justify-center gap-1 text-[11px] text-brand-300">
            <span>Made with</span>
            <Heart className="h-3 w-3 shrink-0 fill-danger text-danger" role="img" aria-label="love" />
            <span>by your Haute tech team</span>
          </p>
          <p className="mt-0.5 text-[11px] text-brand-400">{version}</p>
        </div>
      )}

      {/* Collapse toggle — its own row so the control is always discoverable */}
      <div className={`border-t border-white/10 ${collapsed ? 'p-2' : 'px-3 py-1.5'}`}>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={`flex w-full cursor-pointer items-center rounded-lg py-2 text-sm font-medium text-brand-300 transition-colors duration-150 hover:bg-white/[0.05] hover:text-cream ${
            collapsed ? 'justify-center px-0' : 'gap-3 pl-4 pr-3'
          }`}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4 shrink-0" /> : <PanelLeftClose className="h-4 w-4 shrink-0" />}
          {!collapsed && 'Collapse'}
        </button>
      </div>

      <div className={`border-t border-white/10 ${collapsed ? 'p-2' : 'p-3'}`}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-1.5 py-1">
            <NotificationBell align="left" direction="up" />
            <button
              onClick={logout}
              className="rounded p-1.5 text-brand-300 transition-colors hover:bg-white/10 hover:text-cream"
              title={`Logout ${user?.name ?? ''}`.trim()}
              aria-label="Logout"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between rounded-lg px-2 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-cream">{user?.name}</p>
              <p className="truncate text-xs capitalize text-brand-300">{user?.role}</p>
            </div>
            <div className="ml-2 flex items-center gap-1">
              <NotificationBell align="left" direction="up" />
              <button
                onClick={logout}
                className="rounded p-1 text-brand-300 transition-colors hover:bg-white/10 hover:text-cream"
                title="Logout"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
