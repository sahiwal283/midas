import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, ReceiptText, ClipboardList, Settings, LogOut, Briefcase,
  BarChart3, Activity, Heart,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import client from '../api/client';
import { MIDAS_VERSION } from '@midas/shared';
import { MidasLogo, MidasWordmark } from './MidasLogo';
import { NotificationBell } from './NotificationBell';
import { accountantNavActive } from '../lib/navActive';

// Navy rail. The active row carries a gold spine — gold reads 7.94:1 on navy,
// where on the light content area it would only manage 1.98:1.
const linkClass = ({ isActive }: { isActive: boolean }) =>
  `relative flex items-center gap-3 rounded-lg py-2 pl-4 pr-3 text-sm font-medium transition-colors duration-150 ${
    isActive
      ? 'bg-white/[0.08] text-cream before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-full before:bg-gold-400'
      : 'text-brand-200 hover:bg-white/[0.05] hover:text-cream'
  }`;

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 pt-4 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-300">
      {children}
    </p>
  );
}

export function Sidebar() {
  const { user, logout } = useAuth();
  const isDeveloper = user?.role === 'developer';
  const isPrivileged = user?.role === 'accountant' || user?.role === 'admin' || isDeveloper;
  const isAdmin = user?.role === 'admin' || isDeveloper;
  const isPartner = user?.role === 'partner' || isDeveloper;

  const { data: meta } = useQuery({
    queryKey: ['meta'],
    queryFn: () => client.get<{ version: string }>('/meta').then((r) => r.data),
    staleTime: Infinity,
  });

  const version = `v${meta?.version ?? MIDAS_VERSION}`;
  const accountantActive = accountantNavActive(useLocation());

  return (
    <aside className="flex h-screen w-60 flex-col bg-brand-800">
      {/* Bare gold mark: a plate would vanish against the navy rail. */}
      <div className="flex h-16 items-center gap-2.5 border-b border-white/10 px-4">
        <MidasLogo size={28} bare className="text-gold-400" />
        <MidasWordmark className="text-[1.35rem] leading-none text-cream" />
      </div>

      <nav className="flex-1 overflow-y-auto p-3">
        <SectionLabel>Workspace</SectionLabel>
        <div className="space-y-0.5">
          <NavLink to="/dashboard" className={linkClass}>
            <LayoutDashboard className="h-4 w-4" />
            Dashboard
          </NavLink>
          <NavLink to="/expenses" className={linkClass}>
            <ReceiptText className="h-4 w-4" />
            My Expenses
          </NavLink>
        </div>

        {isPartner && (
          <>
            <SectionLabel>Partner</SectionLabel>
            <NavLink to="/partner-expenses" className={linkClass}>
              <Briefcase className="h-4 w-4" />
              Partner Expenses
            </NavLink>
          </>
        )}

        {isPrivileged && (
          <>
            <SectionLabel>Accountant</SectionLabel>
            <div className="space-y-0.5">
              {/* Active state is computed rather than left to NavLink so that
                  an expense detail page (/accountant/<id>) lights up neither. */}
              <NavLink to="/accountant/events" className={() => linkClass({ isActive: accountantActive.eventReview })}>
                <ClipboardList className="h-4 w-4" />
                Event Review
              </NavLink>
              <NavLink to="/accountant/daily" className={() => linkClass({ isActive: accountantActive.dailyReview })}>
                <ReceiptText className="h-4 w-4" />
                Daily Review
              </NavLink>
              <NavLink to="/reports" className={linkClass}>
                <BarChart3 className="h-4 w-4" />
                Reports
              </NavLink>
            </div>
          </>
        )}

        <SectionLabel>{isAdmin ? 'Admin' : 'Account'}</SectionLabel>
        {isAdmin && (
          <NavLink to="/integration-health" className={linkClass}>
            <Activity className="h-4 w-4" />
            Integration Health
          </NavLink>
        )}
        <NavLink to="/admin" className={linkClass}>
          <Settings className="h-4 w-4" />
          Settings
        </NavLink>
      </nav>

      <div className="px-4 pb-2 pt-2 text-center">
        <p className="flex items-center justify-center gap-1 text-[11px] text-brand-300">
          <span>Made with</span>
          <Heart className="h-3 w-3 shrink-0 fill-danger text-danger" role="img" aria-label="love" />
          <span>by your Haute tech team</span>
        </p>
        <p className="mt-0.5 text-[11px] text-brand-400">{version}</p>
      </div>

      <div className="border-t border-white/10 p-3">
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
      </div>
    </aside>
  );
}
