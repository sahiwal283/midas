import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BellRing, ChevronRight } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notificationApi } from '../api/notifications';
import { getPushState, subscribeToPush } from '../lib/push';
import {
  dismissPushPrompt, isStandalone, readPushPromptDismissedAt, shouldPromptForPush,
} from '../lib/pushPrompt';
import { shownUnreadCount } from '../lib/notificationCount';
import { timeAgo } from './NotificationBell';
import type { Notification } from '../types';

/**
 * Dashboard surface for notifications: an install-aware "turn on push" banner
 * and the unread list. The bell holds the same list, but it is a small icon in
 * a corner — the dashboard is where people land, so unread items are spelled
 * out here. Renders nothing when there is nothing to say.
 */
export function NotificationsCard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Same key as NotificationBell, so the two share one request and stay in step.
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => notificationApi.list(),
    refetchInterval: 60_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });
  const markRead = useMutation({ mutationFn: notificationApi.markRead, onSettled: invalidate });
  const markAllRead = useMutation({ mutationFn: notificationApi.markAllRead, onSettled: invalidate });

  const unread = (data?.notifications ?? []).filter((n) => !n.readAt);
  const unreadCount = data?.unreadCount ?? 0;
  // unreadCount sums grouped rows, so what is shown is counted the same way.
  const shown = shownUnreadCount(unread);

  const open = (n: Notification) => {
    markRead.mutate(n.id);
    navigate(n.path);
  };

  return (
    <>
      <PushPromptBanner />
      {unread.length > 0 && (
        <section className="mb-6 rounded-xl border border-ink/10 bg-white shadow-panel" aria-label="Unread notifications">
          <div className="flex items-center justify-between border-b border-gold-400/60 px-4 py-3 lg:px-6">
            <h2 className="font-display text-lg font-semibold text-ink">
              Needs your attention
              <span className="ml-2 rounded-full bg-danger px-2 py-0.5 align-middle text-xs font-semibold text-cream">
                {unreadCount}
              </span>
            </h2>
            <button
              onClick={() => markAllRead.mutate()}
              disabled={markAllRead.isPending}
              className="min-h-11 px-2 text-xs font-medium text-brand-700 hover:text-brand-900 disabled:opacity-50"
            >
              Mark all read
            </button>
          </div>
          <ul className="divide-y divide-ink/5">
            {unread.map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => open(n)}
                  className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left hover:bg-brand-50 lg:px-6"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-ink">{n.title}</span>
                    {n.body && <span className="mt-0.5 block text-sm text-muted">{n.body}</span>}
                    <span className="mt-1 block text-xs text-charcoal/40">{timeAgo(n.createdAt)}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-charcoal/40" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
          {unreadCount > shown && (
            <p className="border-t border-ink/5 px-4 py-2.5 text-xs text-charcoal/40 lg:px-6">
              Showing the latest {shown} of {unreadCount}. Open the bell for the full list.
            </p>
          )}
        </section>
      )}
    </>
  );
}

/** One-tap push opt-in, shown only inside an installed app (see lib/pushPrompt). */
function PushPromptBanner() {
  const queryClient = useQueryClient();
  const [standalone] = useState(isStandalone);
  const [dismissedAt, setDismissedAt] = useState(readPushPromptDismissedAt);

  const { data: state } = useQuery({
    queryKey: ['push-state'],
    queryFn: getPushState,
    enabled: standalone,
    staleTime: 30_000,
  });
  const enable = useMutation({
    mutationFn: subscribeToPush,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['push-state'] }),
  });

  // One reading per mount is enough; the snooze is measured in days.
  const [now] = useState(() => Date.now());

  if (!shouldPromptForPush({ standalone, state, dismissedAt, now })) return null;

  return (
    <div className="mb-6 rounded-xl border border-brand-200 bg-brand-50 p-4">
      <div className="flex items-start gap-3">
        <BellRing className="mt-0.5 h-5 w-5 shrink-0 text-brand-700" aria-hidden />
        <div className="flex-1">
          <p className="font-semibold text-ink">Turn on notifications</p>
          <p className="mt-0.5 text-sm text-muted">
            Get an alert on this device when your accountant writes or an expense changes.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => enable.mutate()}
              disabled={enable.isPending}
              className="btn-primary min-h-11"
            >
              {enable.isPending ? 'Turning on…' : 'Turn on'}
            </button>
            <button
              onClick={() => { dismissPushPrompt(Date.now()); setDismissedAt(Date.now()); }}
              className="min-h-11 rounded-lg px-3 text-sm font-medium text-muted hover:text-ink"
            >
              Not now
            </button>
          </div>
          {enable.isError && (
            <p className="mt-2 text-xs text-danger">
              Couldn&apos;t turn on notifications — check this app&apos;s notification permission in your device settings.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
