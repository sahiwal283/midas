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
};
