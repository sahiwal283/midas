import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import client from '../api/client';
import { unsubscribeFromPush } from '../lib/push';
import type { User } from '../types';

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Directly set the session user (e.g. after invite acceptance issues the cookie). */
  setUser: (user: User | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    client.get<{ user: User }>('/auth/me')
      .then((r) => setUser(r.data.user))
      .catch(() => setUser(null))
      .finally(() => setIsLoading(false));
  }, []);

  async function login(identifier: string, password: string) {
    // Username or email — the API matches username first.
    const res = await client.post<{ user: User }>('/auth/login', { identifier, password });
    setUser(res.data.user);
  }

  async function logout() {
    // Drop this device's push subscription first (needs the session cookie) —
    // otherwise the next person at a shared machine sees this user's expense
    // notifications. Best-effort: never let it block logout.
    try {
      await unsubscribeFromPush();
    } catch {
      /* ignore */
    }
    await client.post('/auth/logout');
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
