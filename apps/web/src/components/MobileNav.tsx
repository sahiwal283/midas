import { useState } from 'react';
import { NavLink, Link } from 'react-router-dom';
import {
  LayoutDashboard, ReceiptText, Camera, X, ClipboardList, BarChart3,
  Briefcase, Settings, LogOut, Upload, FileSpreadsheet, Activity, Banknote,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

const itemCls = ({ isActive }: { isActive: boolean }) =>
  `flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${
    isActive ? 'text-brand-600' : 'text-charcoal/50'
  }`;

export function MobileNav() {
  const { user, logout } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);

  const role = user?.role;
  const isDeveloper = role === 'developer';
  const isPrivileged = role === 'accountant' || role === 'admin' || isDeveloper;
  const isPartner = role === 'partner' || isDeveloper;

  return (
    <>
      {moreOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-0 bg-ink/30" />
          <div
            className="absolute bottom-16 left-3 right-3 rounded-2xl border border-ink/10 bg-white p-2 shadow-panel"
            onClick={(e) => e.stopPropagation()}
          >
            {isPartner && (
              <SheetLink to="/partner-expenses" icon={<Briefcase className="h-4 w-4" />} label="Partner Expenses" onNavigate={() => setMoreOpen(false)} />
            )}
            {isPrivileged && (
              <>
                <SheetLink to="/accountant" icon={<ClipboardList className="h-4 w-4" />} label="Review Queue" onNavigate={() => setMoreOpen(false)} />
                <SheetLink to="/accountant/purchase-orders" icon={<FileSpreadsheet className="h-4 w-4" />} label="Purchase Orders" onNavigate={() => setMoreOpen(false)} />
                <SheetLink to="/accountant?reimbursementStatus=pending" icon={<Banknote className="h-4 w-4" />} label="Reimbursements" onNavigate={() => setMoreOpen(false)} />
                <SheetLink to="/reports" icon={<BarChart3 className="h-4 w-4" />} label="Reports" onNavigate={() => setMoreOpen(false)} />
                <SheetLink to="/integration-health" icon={<Activity className="h-4 w-4" />} label="Integration Health" onNavigate={() => setMoreOpen(false)} />
              </>
            )}
            <SheetLink to="/admin" icon={<Settings className="h-4 w-4" />} label="Settings" onNavigate={() => setMoreOpen(false)} />
            <button
              onClick={() => { setMoreOpen(false); logout(); }}
              className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-charcoal/70 hover:bg-cream"
            >
              <LogOut className="h-4 w-4" />
              Log out
            </button>
          </div>
        </div>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-ink/10 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden">
        <NavLink to="/dashboard" className={itemCls}>
          <LayoutDashboard className="h-5 w-5" />
          Home
        </NavLink>

        <div className="relative flex flex-1 justify-center">
          <Link
            to="/expenses/new?mode=scan"
            aria-label="Add transaction"
            className="-mt-5 flex h-14 w-14 items-center justify-center rounded-full bg-brand-500 text-cream shadow-lg ring-4 ring-cream active:bg-brand-600"
          >
            <Camera className="h-6 w-6" />
          </Link>
        </div>

        <NavLink to="/expenses" className={itemCls}>
          <ReceiptText className="h-5 w-5" />
          Expenses
        </NavLink>

        {isPrivileged ? (
          <NavLink to="/accountant" className={itemCls}>
            <ClipboardList className="h-5 w-5" />
            Queue
          </NavLink>
        ) : (
          <button
            onClick={() => setMoreOpen((o) => !o)}
            className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-charcoal/50"
          >
            {moreOpen ? <X className="h-5 w-5" /> : <MoreDots />}
            More
          </button>
        )}

        {isPrivileged && (
          <button
            onClick={() => setMoreOpen((o) => !o)}
            className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-charcoal/50"
          >
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
    <Link to={to} onClick={onNavigate} className="flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-ink hover:bg-cream">
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
