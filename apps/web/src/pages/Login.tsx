import { useState, useEffect, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../api/client';
import { MidasLogo, MidasWordmark } from '../components/MidasLogo';

interface AuthConfig {
  authMode: 'local' | 'authentik';
  showLocalLogin: boolean;
}

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('');
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
      await login(identifier, password);
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
      case 'denied_no_identity': return 'Your SSO account has neither a username nor an email address, so Midas could not create your account. Contact an administrator.';
      case 'denied_no_match': return 'Your SSO account is not linked to a Midas account. Contact an administrator.';
      case 'denied_inactive': return 'Your account has been deactivated. Contact an administrator.';
      case 'missing_params': return 'SSO callback was incomplete. Please try again.';
      default: return 'SSO sign-in failed. Please try again or contact an administrator.';
    }
  }

  const isAuthentikMode = authConfig.authMode === 'authentik';
  const inputCls = 'w-full rounded-lg border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink placeholder:text-charcoal/40 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-cream px-4">
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          // Champagne gold wash above, deep navy settling below — restrained,
          // no visible banding, and it never sits behind body copy.
          background:
            'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(212,175,55,0.20), transparent 55%), radial-gradient(ellipse 70% 45% at 50% 110%, rgba(11,31,51,0.10), transparent 60%)',
        }}
      />

      <div className="relative w-full max-w-sm">
        <div className="mb-10 text-center">
          <MidasLogo size={56} className="mx-auto mb-4" />
          <MidasWordmark className="block text-[2rem]" />
          <p className="mt-2 text-sm tracking-wide text-charcoal/55">Expense management</p>
        </div>

        <div className="rounded-2xl border border-ink/10 bg-white p-8 shadow-panel">
          <h2 className="mb-6 font-display text-xl font-semibold text-ink">Sign in</h2>

          {oidcError && (
            <div className="mb-4 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">
              <p>{oidcErrorLabel(oidcError)}</p>
              {oidcRequestId && (
                <p className="mt-1 text-xs opacity-70">Reference: {oidcRequestId}</p>
              )}
            </div>
          )}

          {isAuthentikMode && (
            <a
              href="/api/v1/auth/oidc/login"
              className="mb-6 flex w-full items-center justify-center rounded-lg bg-brand-500 px-4 py-3 text-sm font-semibold text-cream hover:bg-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-cream"
            >
              Sign in with Authentik
            </a>
          )}

          {isAuthentikMode && authConfig.showLocalLogin && (
            <details className="group">
              <summary className="cursor-pointer select-none list-none text-xs text-charcoal/40 hover:text-charcoal/70">
                <span className="border-b border-dashed border-ink/20">Break-glass local login</span>
              </summary>
              <p className="mt-2 text-xs text-brand-700">
                Use local login only for break-glass/admin fallback.
              </p>
              <form onSubmit={handleSubmit} className="mt-3 space-y-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-charcoal" htmlFor="identifier">Username or email</label>
                  <input id="identifier" type="text" required value={identifier} onChange={(e) => setIdentifier(e.target.value)} className={inputCls} placeholder="username" autoComplete="username" />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-charcoal" htmlFor="password">Password</label>
                  <input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} autoComplete="current-password" />
                </div>
                {error && <p className="rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>}
                <button type="submit" disabled={loading} className="w-full rounded-lg border border-ink/15 bg-white px-4 py-2 text-sm font-medium text-ink hover:bg-cream disabled:opacity-60">
                  {loading ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
            </details>
          )}

          {!isAuthentikMode && authConfig.showLocalLogin && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-charcoal" htmlFor="identifier">Username or email</label>
                <input id="identifier" type="text" required value={identifier} onChange={(e) => setIdentifier(e.target.value)} className={inputCls} placeholder="username" autoComplete="username" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-charcoal" htmlFor="password">Password</label>
                <input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} autoComplete="current-password" />
              </div>
              {error && <p className="rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>}
              <button type="submit" disabled={loading} className="w-full rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-semibold text-cream hover:bg-brand-600 disabled:opacity-60">
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
