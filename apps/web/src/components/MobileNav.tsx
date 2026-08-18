import { useState } from 'react';
import { NavLink, Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard, ReceiptText, Camera, X, ClipboardList, BarChart3,
  Briefcase, Settings, LogOut, Upload, Activity,
} from 'lucide-react';
import { MIDAS_VERSION } from '@midas/shared';
import client from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { setPendingCapture } from '../lib/pendingCapture';

// Matches the desktop navy rail: gold marks the active destination.
const itemCls = ({ isActive }: { isActive: boolean }) =>
  `flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors ${
    isActive ? 'text-gold-400' : 'text-brand-300'
  }`;

export function MobileNav() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);
  // Both scoped review pages share one bottom-bar tab, so match either instead
  // of relying on NavLink's own (single-path) active check.
  const queueActive = location.pathname.startsWith('/accountant');

  // Same source as the desktop sidebar: live API version, constant fallback.
  const { data: meta } = useQuery({
    queryKey: ['meta'],
    queryFn: () => client.get<{ version: string }>('/meta').then((r) => r.data),
    staleTime: Infinity,
  });
  const version = `v${meta?.version ?? MIDAS_VERSION}`;

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
            <p className="border-t border-ink/5 px-4 pb-1 pt-2 text-center text-[11px] text-charcoal/35">
              Midas {version}
            </p>
          </div>
        </div>
      )}

      {/* Equal-width tab groups flank a fixed-width slot so the camera FAB sits
          at the exact horizontal center regardless of how many tabs a role has. */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-white/10 bg-brand-800 pb-[env(safe-area-inset-bottom)] lg:hidden">
        <div className="flex flex-1 items-stretch">
          <NavLink to="/dashboard" className={itemCls}>
            <LayoutDashboard className="h-5 w-5" />
            Home
          </NavLink>
          <NavLink to="/expenses" className={itemCls}>
            <ReceiptText className="h-5 w-5" />
            Expenses
          </NavLink>
        </div>

        <div className="flex w-16 shrink-0 justify-center">
          {/* A label wrapping the file input opens the native camera directly,
              inside the tap gesture — navigating first and clicking the input
              programmatically gets blocked by mobile browsers. */}
          <label
            aria-label="Scan a receipt"
            className="-mt-5 flex h-14 w-14 cursor-pointer items-center justify-center rounded-full bg-gold-400 text-brand-800 shadow-lg ring-4 ring-brand-800 transition-colors active:bg-gold-500"
          >
            <Camera className="h-6 w-6" />
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) {
                  setPendingCapture(file);
                  navigate('/expenses/new?mode=scan');
                }
              }}
            />
          </label>
        </div>

        <div className="flex flex-1 items-stretch">
          {isPrivileged && (
            <NavLink to="/accountant/daily" className={() => itemCls({ isActive: queueActive })}>
              <ClipboardList className="h-5 w-5" />
              Queue
            </NavLink>
          )}
          <button
            onClick={() => setMoreOpen((o) => !o)}
            className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-brand-300"
          >
            {moreOpen ? <X className="h-5 w-5" /> : <MoreDots />}
            More
          </button>
        </div>
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
