import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, ReceiptText, ClipboardList, Settings, LogOut, Briefcase,
  BarChart3, Activity, FileSpreadsheet, PlusCircle, Upload, Banknote,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import client from '../api/client';
import { MIDAS_VERSION } from '@midas/shared';
import { MidasLogo, MidasWordmark } from './MidasLogo';
import { NotificationBell } from './NotificationBell';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
    isActive
      ? 'bg-brand-500/15 text-ink'
      : 'text-charcoal/70 hover:bg-ink/[0.04] hover:text-ink'
  }`;

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-charcoal/40">
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

  return (
    <aside className="flex h-screen w-60 flex-col border-r border-ink/10 bg-white">
      <div className="flex h-16 items-center gap-2.5 border-b border-ink/10 px-4">
        <MidasLogo size={30} />
        <MidasWordmark />
        <span className="rounded-md bg-brand-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700">
          Beta
        </span>
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
            Expenses
          </NavLink>
          <NavLink to="/transactions/new" className={linkClass}>
            <PlusCircle className="h-4 w-4" />
            Add Transaction
          </NavLink>
          <NavLink to="/to-upload" className={linkClass}>
            <Upload className="h-4 w-4" />
            To Upload
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
              <NavLink to="/accountant" className={linkClass}>
                <ClipboardList className="h-4 w-4" />
                Review Queue
              </NavLink>
              <NavLink to="/accountant/purchase-orders" className={linkClass}>
                <FileSpreadsheet className="h-4 w-4" />
                Purchase Orders
              </NavLink>
              <NavLink to="/accountant?reimbursementStatus=pending" className={linkClass}>
                <Banknote className="h-4 w-4" />
                Reimbursements
              </NavLink>
              <NavLink to="/reports" className={linkClass}>
                <BarChart3 className="h-4 w-4" />
                Reports
              </NavLink>
              <NavLink to="/integration-health" className={linkClass}>
                <Activity className="h-4 w-4" />
                Integration Health
              </NavLink>
            </div>
          </>
        )}

        <SectionLabel>{isAdmin ? 'Admin' : 'Account'}</SectionLabel>
        <NavLink to="/admin" className={linkClass}>
          <Settings className="h-4 w-4" />
          Settings
        </NavLink>
      </nav>

      <div className="px-4 pb-2 pt-2 text-center">
        <p className="text-[11px] text-charcoal/40">Built by your haute tech team</p>
        <p className="mt-0.5 text-[11px] text-charcoal/30">{version}</p>
      </div>

      <div className="border-t border-ink/10 p-3">
        <div className="flex items-center justify-between rounded-lg px-2 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">{user?.name}</p>
            <p className="truncate text-xs capitalize text-charcoal/50">{user?.role}</p>
          </div>
          <div className="ml-2 flex items-center gap-1">
            <NotificationBell align="left" direction="up" />
            <button
              onClick={logout}
              className="rounded p-1 text-charcoal/40 hover:bg-ink/[0.04] hover:text-ink"
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
