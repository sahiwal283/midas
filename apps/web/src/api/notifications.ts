import client from './client';
import type { Notification } from '../types';

export interface NotificationList {
  notifications: Notification[];
  unreadCount: number;
}

export const notificationApi = {
  list: (params?: { unread?: boolean; limit?: number }) =>
    client.get<NotificationList>('/notifications', {
      params: {
        ...(params?.unread ? { unread: 'true' } : {}),
        ...(params?.limit ? { limit: params.limit } : {}),
      },
    }).then((r) => r.data),

  markRead: (id: string) =>
    client.post<{ notification: Notification }>(`/notifications/${id}/read`)
      .then((r) => r.data.notification),

  markAllRead: () =>
    client.post<{ ok: boolean }>('/notifications/read-all').then((r) => r.data),

  pushPublicKey: () =>
    client.get<{ publicKey: string | null }>('/notifications/push/public-key')
      .then((r) => r.data),

  pushSubscribe: (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    client.post<{ id: string }>('/notifications/push/subscribe', subscription)
      .then((r) => r.data),

  pushUnsubscribe: (body: { endpoint: string }) =>
    client.post<{ ok: boolean }>('/notifications/push/unsubscribe', body)
      .then((r) => r.data),
};
