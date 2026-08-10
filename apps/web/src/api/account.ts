import client from './client';
import type { User } from '../types';

/** GET/PATCH /auth/me shape — includes a boolean-only SSO signal. */
export interface MeUser extends User {
  hasPassword?: boolean;
}

export const accountApi = {
  me: () =>
    client.get<{ user: MeUser }>('/auth/me').then((r) => r.data.user),

  updateMe: (data: { name: string }) =>
    client.patch<{ user: MeUser }>('/auth/me', data).then((r) => r.data.user),

  changePassword: (data: { currentPassword: string; newPassword: string }) =>
    client.post<{ ok: boolean }>('/auth/change-password', data).then((r) => r.data),
};
