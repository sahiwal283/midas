import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellRing } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notificationApi } from '../api/notifications';
import { getPushState, subscribeToPush, unsubscribeFromPush } from '../lib/push';
import type { Notification } from '../types';

/** "5m ago" style relative time — small enough to not need a dependency. */
function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Bell with unread badge + dropdown panel. Mounted in the desktop sidebar
 * footer (opens upward) and the mobile header (opens downward). `align`
 * controls which edge the panel hugs.
 */
export function NotificationBell({
  align = 'left',
  direction = 'down',
}: {
  align?: 'left' | 'right';
  direction?: 'up' | 'down';
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => notificationApi.list(),
    refetchInterval: 60_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });
  const markRead = useMutation({ mutationFn: notificationApi.markRead, onSettled: invalidate });
  const markAllRead = useMutation({ mutationFn: notificationApi.markAllRead, onSettled: invalidate });

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const unreadCount = data?.unreadCount ?? 0;
  const notifications = data?.notifications ?? [];

  // Device push state — only checked while the panel is open.
  const { data: pushState } = useQuery({
    queryKey: ['push-state'],
    queryFn: getPushState,
    enabled: open,
    staleTime: 30_000,
  });
  const invalidatePush = () => queryClient.invalidateQueries({ queryKey: ['push-state'] });
  const enablePush = useMutation({ mutationFn: subscribeToPush, onSettled: invalidatePush });
  const disablePush = useMutation({ mutationFn: unsubscribeFromPush, onSettled: invalidatePush });

  const openNotification = (n: Notification) => {
    setOpen(false);
    if (!n.readAt) markRead.mutate(n.id);
    if (n.expenseId) navigate(`/expenses/${n.expenseId}`);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-lg p-2 text-muted hover:bg-brand-50 hover:text-ink"
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-cream">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className={`absolute z-50 w-80 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-ink/10 bg-white shadow-xl ${
            direction === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'
          } ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          <div className="flex items-center justify-between border-b border-ink/5 px-4 py-2.5">
            <p className="text-sm font-semibold text-ink">Notifications</p>
            {unreadCount > 0 && (
              <button
                onClick={() => markAllRead.mutate()}
                className="text-xs font-medium text-brand-700 hover:text-brand-900"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-charcoal/40">No notifications yet</p>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => openNotification(n)}
                  className={`block w-full border-b border-ink/5 px-4 py-3 text-left last:border-b-0 hover:bg-ink/[0.03] ${
                    n.readAt ? '' : 'bg-brand-50'
                  }`}
                >
                  <p className="text-sm font-semibold text-ink">{n.title}</p>
                  {n.body && <p className="mt-0.5 text-xs text-muted">{n.body}</p>}
                  <p className="mt-1 text-xs text-charcoal/40">{timeAgo(n.createdAt)}</p>
                </button>
              ))
            )}
          </div>

          {/* Device push controls — hidden when unsupported or not configured */}
          {pushState === 'ready' && (
            <div className="border-t border-ink/5 px-4 py-2.5">
              <button
                onClick={() => enablePush.mutate()}
                disabled={enablePush.isPending}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand-50 px-3 text-sm font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50"
              >
                <BellRing className="h-4 w-4" />
                {enablePush.isPending ? 'Enabling…' : 'Enable notifications on this device'}
              </button>
              {enablePush.isError && (
                <p className="mt-1.5 text-xs text-danger">
                  Couldn't enable push — check browser notification permissions.
                </p>
              )}
            </div>
          )}
          {pushState === 'subscribed' && (
            <div className="flex min-h-11 items-center justify-between gap-2 border-t border-ink/5 px-4 py-2">
              <span className="flex items-center gap-1.5 text-xs text-muted">
                <BellRing className="h-3.5 w-3.5 text-success" />
                Push enabled on this device
              </span>
              <button
                onClick={() => disablePush.mutate()}
                disabled={disablePush.isPending}
                className="min-h-11 px-2 text-xs font-medium text-charcoal/40 hover:text-charcoal/70 disabled:opacity-50"
              >
                Disable
              </button>
            </div>
          )}
          {pushState === 'denied' && (
            <p className="border-t border-ink/5 px-4 py-2.5 text-xs text-charcoal/40">
              Push notifications are blocked in your browser settings.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
