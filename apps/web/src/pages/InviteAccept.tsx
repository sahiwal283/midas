import { useState, FormEvent } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import client from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { MidasLogo, MidasWordmark } from '../components/MidasLogo';
import type { User } from '../types';

interface InviteInfo {
  valid: boolean;
  name?: string;
  email?: string;
}

/** Public set-password page for invited users (outside ProtectedRoute). */
export function InviteAccept() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { setUser } = useAuth();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { data: invite, isLoading } = useQuery({
    queryKey: ['invite', token],
    queryFn: () => client.get<InviteInfo>(`/auth/invite/${token}`).then((r) => r.data),
    enabled: !!token,
    retry: false,
  });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await client.post<{ user: User }>(`/auth/invite/${token}`, { password });
      setUser(res.data.user);
      navigate('/dashboard');
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: { code?: string; message?: string } } } };
      const apiErr = axiosErr?.response?.data?.error;
      setError(
        apiErr?.code === 'INVITE_INVALID'
          ? 'This invite link is no longer valid — ask your administrator for a new one.'
          : apiErr?.message ?? 'Something went wrong. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-cream px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <MidasLogo size={48} className="mx-auto mb-3" />
          <MidasWordmark className="text-3xl" />
          <p className="mt-2 text-sm text-charcoal/55">Expense management</p>
        </div>

        <div className="rounded-2xl border border-ink/10 bg-white p-8 shadow-panel">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" />
            </div>
          ) : !invite?.valid ? (
            <div className="text-center">
              <h2 className="font-display text-xl font-semibold text-ink">Invite not valid</h2>
              <p className="mt-3 text-sm text-charcoal/60">
                This invite link is invalid or has expired. Invitations are single-use and expire
                after 7 days — ask your administrator to send you a new one.
              </p>
              <Link
                to="/login"
                className="mt-6 inline-block rounded-lg border border-ink/15 px-4 py-2 text-sm font-medium text-ink hover:bg-cream"
              >
                Go to sign in
              </Link>
            </div>
          ) : (
            <>
              <h2 className="font-display text-xl font-semibold text-ink">Welcome{invite.name ? `, ${invite.name}` : ''}</h2>
              <p className="mt-1 text-sm text-charcoal/55">
                Set a password for <span className="font-medium text-ink">{invite.email}</span> to finish
                setting up your account.
              </p>

              <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="password">
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    placeholder="Min 8 characters"
                    autoComplete="new-password"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="confirm">
                    Confirm password
                  </label>
                  <input
                    id="confirm"
                    type="password"
                    required
                    minLength={8}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    autoComplete="new-password"
                  />
                </div>
                {error && (
                  <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
                )}
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
                >
                  {submitting ? 'Setting up…' : 'Set password & sign in'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
