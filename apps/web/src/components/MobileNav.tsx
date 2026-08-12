import { useState } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, ReceiptText, Camera, X, ClipboardList, BarChart3,
  Briefcase, Settings, LogOut, Upload, Activity,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

// Matches the desktop navy rail: gold marks the active destination.
const itemCls = ({ isActive }: { isActive: boolean }) =>
  `flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors ${
    isActive ? 'text-gold-400' : 'text-brand-300'
  }`;

export function MobileNav() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  // Both scoped review pages share one bottom-bar tab, so match either instead
  // of relying on NavLink's own (single-path) active check.
  const queueActive = location.pathname.startsWith('/accountant');

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
                <SheetLink to="/accountant/events" icon={<ClipboardList className="h-4 w-4" />} label="Event Review" onNavigate={() => setMoreOpen(false)} />
                <SheetLink to="/accountant/daily" icon={<ReceiptText className="h-4 w-4" />} label="Daily Review" onNavigate={() => setMoreOpen(false)} />
                <SheetLink to="/reports" icon={<BarChart3 className="h-4 w-4" />} label="Reports" onNavigate={() => setMoreOpen(false)} />
              </>
            )}
            {(role === 'admin' || isDeveloper) && (
              <SheetLink to="/integration-health" icon={<Activity className="h-4 w-4" />} label="Integration Health" onNavigate={() => setMoreOpen(false)} />
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

      <nav className="fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-white/10 bg-brand-800 pb-[env(safe-area-inset-bottom)] lg:hidden">
        <NavLink to="/dashboard" className={itemCls}>
          <LayoutDashboard className="h-5 w-5" />
          Home
        </NavLink>

        <div className="relative flex flex-1 justify-center">
          <Link
            to="/expenses/new?mode=scan"
            aria-label="Add transaction"
            className="-mt-5 flex h-14 w-14 items-center justify-center rounded-full bg-gold-400 text-brand-800 shadow-lg ring-4 ring-brand-800 transition-colors active:bg-gold-500"
          >
            <Camera className="h-6 w-6" />
          </Link>
        </div>

        <NavLink to="/expenses" className={itemCls}>
          <ReceiptText className="h-5 w-5" />
          Expenses
        </NavLink>

        {isPrivileged ? (
          <NavLink to="/accountant/daily" className={() => itemCls({ isActive: queueActive })}>
            <ClipboardList className="h-5 w-5" />
            Queue
          </NavLink>
        ) : (
          <button
            onClick={() => setMoreOpen((o) => !o)}
            className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-brand-300"
          >
            {moreOpen ? <X className="h-5 w-5" /> : <MoreDots />}
            More
          </button>
        )}

        {isPrivileged && (
          <button
            onClick={() => setMoreOpen((o) => !o)}
            className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-brand-300"
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
