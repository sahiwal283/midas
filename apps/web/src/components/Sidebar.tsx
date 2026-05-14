import { NavLink } from 'react-router-dom';
import { LayoutDashboard, ReceiptText, Camera, ClipboardList, Settings, LogOut, CreditCard } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import client from '../api/client';
import { MIDAS_VERSION } from '@midas/shared';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
    isActive
      ? 'bg-brand-100 text-brand-900'
      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
  }`;

export function Sidebar() {
  const { user, logout } = useAuth();
  const isPrivileged = user?.role === 'accountant' || user?.role === 'admin';
  const isAdmin = user?.role === 'admin';

  const { data: meta } = useQuery({
    queryKey: ['meta'],
    queryFn: () => client.get<{ version: string }>('/meta').then((r) => r.data),
    staleTime: Infinity,
  });

  const version = `v${meta?.version ?? MIDAS_VERSION}`;

  return (
    <aside className="flex h-screen w-60 flex-col border-r border-gray-200 bg-white">
      {/* Logo */}
      <div className="flex h-16 items-center gap-2 border-b border-gray-200 px-5">
        <span className="text-xl font-bold text-brand-700">Midas</span>
        <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs text-brand-600">Beta</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto p-3 space-y-1">
        <NavLink to="/dashboard" className={linkClass}>
          <LayoutDashboard className="h-4 w-4" />
          Dashboard
        </NavLink>
        <NavLink to="/expenses" className={linkClass}>
          <ReceiptText className="h-4 w-4" />
          My Expenses
        </NavLink>
        <NavLink to="/captures" className={linkClass}>
          <Camera className="h-4 w-4" />
          Captures
        </NavLink>

        {isPrivileged && (
          <>
            <div className="my-2 border-t border-gray-100" />
            <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-gray-400">Accountant</p>
            <NavLink to="/accountant" className={linkClass}>
              <ClipboardList className="h-4 w-4" />
              Review Queue
            </NavLink>
          </>
        )}

        {isAdmin && (
          <>
            <div className="my-2 border-t border-gray-100" />
            <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-gray-400">Admin</p>
            <NavLink to="/payment-methods" className={linkClass}>
              <CreditCard className="h-4 w-4" />
              Payment Methods
            </NavLink>
            <NavLink to="/admin" className={linkClass}>
              <Settings className="h-4 w-4" />
              Settings
            </NavLink>
          </>
        )}
      </nav>

      {/* Branding footer */}
      <div className="px-4 pb-2 pt-3 text-center">
        <p className="text-xs text-gray-400">
          Built by your haute tech team
        </p>
        <p className="mt-0.5 text-xs text-gray-300">{version}</p>
      </div>

      {/* User footer */}
      <div className="border-t border-gray-200 p-3">
        <div className="flex items-center justify-between rounded-lg px-2 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-gray-900">{user?.name}</p>
            <p className="truncate text-xs text-gray-500 capitalize">{user?.role}</p>
          </div>
          <button
            onClick={logout}
            className="ml-2 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            title="Logout"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
