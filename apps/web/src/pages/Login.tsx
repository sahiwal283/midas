import { useState, useEffect, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../api/client';
import { MidasLogo } from '../components/MidasLogo';

interface AuthConfig {
  authMode: 'local' | 'authentik';
  showLocalLogin: boolean;
}

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [authConfig, setAuthConfig] = useState<AuthConfig>({ authMode: 'local', showLocalLogin: true });

  const params = new URLSearchParams(window.location.search);
  const oidcError = params.get('oidc_error');
  const oidcRequestId = params.get('oidc_request_id');

  useEffect(() => {
    api.get<AuthConfig>('/auth/config').then((r) => setAuthConfig(r.data)).catch(() => {});
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/dashboard');
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: { message?: string } }; status?: number } };
      const apiMsg = axiosErr?.response?.data?.error?.message;
      const status = axiosErr?.response?.status;
      if (apiMsg) {
        setError(apiMsg);
      } else if (status) {
        setError(`Login failed (HTTP ${status}). Check server logs.`);
      } else {
        setError('Cannot reach the server. Check your network or try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  function oidcErrorLabel(code: string | null): string {
    switch (code) {
      case 'token_error': return 'SSO sign-in failed. Please contact an administrator.';
      case 'invalid_state': return 'SSO session expired. Please try again.';
      case 'denied_no_group': return 'Your account is not assigned to a Midas access group.';
      case 'denied_no_match': return 'Your SSO account is not linked to a Midas account. Contact an administrator.';
      case 'denied_inactive': return 'Your account has been deactivated. Contact an administrator.';
      case 'missing_params': return 'SSO callback was incomplete. Please try again.';
      default: return 'SSO sign-in failed. Please try again or contact an administrator.';
    }
  }

  const isAuthentikMode = authConfig.authMode === 'authentik';

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <MidasLogo size={48} className="mx-auto mb-3" />
          <h1 className="text-3xl font-bold text-brand-700">Midas</h1>
          <p className="mt-1 text-sm text-gray-500">Internal Expense Platform</p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
          <h2 className="mb-6 text-xl font-semibold text-gray-900">Sign in</h2>

          {oidcError && (
            <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              <p>{oidcErrorLabel(oidcError)}</p>
              {oidcRequestId && (
                <p className="mt-1 text-xs text-red-500">Reference: {oidcRequestId}</p>
              )}
            </div>
          )}

          {isAuthentikMode && (
            <a
              href="/api/v1/auth/oidc/login"
              className="mb-6 flex w-full items-center justify-center rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
            >
              Sign in with Authentik
            </a>
          )}

          {isAuthentikMode && authConfig.showLocalLogin && (
            <details className="group">
              <summary className="cursor-pointer select-none list-none text-xs text-gray-400 hover:text-gray-600">
                <span className="border-b border-dashed border-gray-300">Break-glass local login</span>
              </summary>
              <p className="mt-2 text-xs text-amber-600">
                Use local login only for break-glass/admin fallback.
              </p>
              <form onSubmit={handleSubmit} className="mt-3 space-y-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="email">
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    placeholder="you@company.com"
                    autoComplete="email"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="password">
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    autoComplete="current-password"
                  />
                </div>
                {error && (
                  <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
                )}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                >
                  {loading ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
            </details>
          )}

          {!isAuthentikMode && authConfig.showLocalLogin && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="email">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  placeholder="you@company.com"
                  autoComplete="email"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="password">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  autoComplete="current-password"
                />
              </div>
              {error && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
              )}
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
              >
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
