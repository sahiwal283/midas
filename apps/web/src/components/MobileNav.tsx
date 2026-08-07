import { useState } from 'react';
import { NavLink, Link } from 'react-router-dom';
import {
  LayoutDashboard, ReceiptText, Camera, X, ClipboardList, BarChart3,
  Briefcase, CreditCard, Settings, LogOut, Camera as CaptureIcon,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

const itemCls = ({ isActive }: { isActive: boolean }) =>
  `flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${
    isActive ? 'text-brand-700' : 'text-gray-500'
  }`;

/** Bottom navigation for phones. Desktop keeps the sidebar (lg:hidden here). */
export function MobileNav() {
  const { user, logout } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);

  const role = user?.role;
  const isDeveloper = role === 'developer';
  const isPrivileged = role === 'accountant' || role === 'admin' || isDeveloper;
  const isAdmin = role === 'admin' || isDeveloper;
  const isPartner = role === 'partner' || isDeveloper;
  const hasMore = true; // Captures + logout live here for everyone

  return (
    <>
      {moreOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div
            className="absolute bottom-16 left-3 right-3 rounded-2xl border border-gray-200 bg-white p-2 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <SheetLink to="/captures" icon={<CaptureIcon className="h-4 w-4" />} label="Captures" onNavigate={() => setMoreOpen(false)} />
            {isPartner && (
              <SheetLink to="/partner-expenses" icon={<Briefcase className="h-4 w-4" />} label="Partner Expenses" onNavigate={() => setMoreOpen(false)} />
            )}
            {isPrivileged && (
              <>
                <SheetLink to="/accountant" icon={<ClipboardList className="h-4 w-4" />} label="Review Queue" onNavigate={() => setMoreOpen(false)} />
                <SheetLink to="/reports" icon={<BarChart3 className="h-4 w-4" />} label="Reports" onNavigate={() => setMoreOpen(false)} />
              </>
            )}
            {isAdmin && (
              <>
                <SheetLink to="/payment-methods" icon={<CreditCard className="h-4 w-4" />} label="Payment Methods" onNavigate={() => setMoreOpen(false)} />
                <SheetLink to="/admin" icon={<Settings className="h-4 w-4" />} label="Admin Settings" onNavigate={() => setMoreOpen(false)} />
              </>
            )}
            <button
              onClick={() => { setMoreOpen(false); logout(); }}
              className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              <LogOut className="h-4 w-4" />
              Log out
            </button>
          </div>
        </div>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden">
        <NavLink to="/dashboard" className={itemCls}>
          <LayoutDashboard className="h-5 w-5" />
          Home
        </NavLink>

        {/* Centered, raised camera action — straight into scan mode */}
        <div className="relative flex flex-1 justify-center">
          <Link
            to="/expenses/new?mode=scan"
            aria-label="Add expense"
            className="-mt-5 flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-white shadow-lg ring-4 ring-white active:bg-brand-700"
          >
            <Camera className="h-6 w-6" />
          </Link>
        </div>

        <NavLink to="/expenses" className={itemCls}>
          <ReceiptText className="h-5 w-5" />
          Expenses
        </NavLink>

        {hasMore && (
          <button onClick={() => setMoreOpen((o) => !o)} className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-gray-500">
            {moreOpen ? <X className="h-5 w-5" /> : <MoreDots />}
            More
          </button>
        )}
      </nav>
    </>
  );
}

function SheetLink({ to, icon, label, onNavigate }: { to: string; icon: React.ReactNode; label: string; onNavigate: () => void }) {
  return (
    <Link to={to} onClick={onNavigate} className="flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50">
      {icon}
      {label}
    </Link>
  );
}

function MoreDots() {
  return (
    <span className="flex h-5 items-center gap-0.5">
      <span className="h-1 w-1 rounded-full bg-current" />
      <span className="h-1 w-1 rounded-full bg-current" />
      <span className="h-1 w-1 rounded-full bg-current" />
    </span>
  );
}
