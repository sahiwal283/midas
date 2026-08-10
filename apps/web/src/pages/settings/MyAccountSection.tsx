import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { accountApi } from '../../api/account';
import { useAuth } from '../../contexts/AuthContext';
import { reopenExtensionSetup } from '../../components/ExtensionSetupModal';

const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none';

export function MyAccountSection() {
  const qc = useQueryClient();
  const { user: sessionUser, setUser } = useAuth();

  const { data: me, isLoading } = useQuery({
    queryKey: ['me-account'],
    queryFn: () => accountApi.me(),
  });

  // ── Profile ────────────────────────────────────────────────────────────────
  const [name, setName] = useState('');
  const [profileError, setProfileError] = useState('');
  const [profileSaved, setProfileSaved] = useState(false);

  useEffect(() => {
    if (me) setName(me.name);
  }, [me]);

  const profileMutation = useMutation({
    mutationFn: () => accountApi.updateMe({ name: name.trim() }),
    onSuccess: (updated) => {
      setProfileError('');
      setProfileSaved(true);
      qc.setQueryData(['me-account'], updated);
      // Keep the session (sidebar footer etc.) in sync with the new name.
      if (sessionUser) setUser({ ...sessionUser, name: updated.name });
    },
    onError: (err: any) => {
      setProfileSaved(false);
      setProfileError(err?.response?.data?.error?.message ?? 'Could not update profile');
    },
  });

  // ── Change password ────────────────────────────────────────────────────────
  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState(false);
  const [ssoOnly, setSsoOnly] = useState(false);
  const [ssoMessage, setSsoMessage] = useState('Your account signs in with SSO — password is managed in Authentik.');

  const pwMutation = useMutation({
    mutationFn: () => accountApi.changePassword({ currentPassword: pwForm.current, newPassword: pwForm.next }),
    onSuccess: () => {
      setPwError('');
      setPwSuccess(true);
      setPwForm({ current: '', next: '', confirm: '' });
    },
    onError: (err: any) => {
      setPwSuccess(false);
      const e = err?.response?.data?.error;
      if (e?.code === 'NO_PASSWORD') {
        setSsoOnly(true);
        if (e.message) setSsoMessage(e.message);
        setPwError('');
      } else {
        setPwError(e?.message ?? 'Could not change password');
      }
    },
  });

  function submitPassword() {
    setPwSuccess(false);
    if (pwForm.next.length < 8) {
      setPwError('New password must be at least 8 characters.');
      return;
    }
    if (pwForm.next !== pwForm.confirm) {
      setPwError('New password and confirmation do not match.');
      return;
    }
    setPwError('');
    pwMutation.mutate();
  }

  if (isLoading) return <div className="text-sm text-gray-400">Loading…</div>;
  if (!me) return <div className="text-sm text-red-600">Could not load your account.</div>;

  const showSsoNote = ssoOnly || me.hasPassword === false;
  const nameChanged = name.trim().length > 0 && name.trim() !== me.name;

  return (
    <div className="max-w-2xl space-y-6">
      {/* Profile card */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="mb-4 text-sm font-semibold text-gray-700">Profile</h2>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Name</label>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setProfileSaved(false); }}
              maxLength={100}
              className={inputCls}
            />
          </div>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium text-gray-600">Email</dt>
              <dd className="mt-1 text-sm text-gray-900">{me.email}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-600">Role</dt>
              <dd className="mt-1 text-sm capitalize text-gray-900">{me.role}</dd>
            </div>
            {me.department && (
              <div>
                <dt className="text-xs font-medium text-gray-600">Department</dt>
                <dd className="mt-1 text-sm text-gray-900">{me.department}</dd>
              </div>
            )}
            {me.costCenter && (
              <div>
                <dt className="text-xs font-medium text-gray-600">Cost center</dt>
                <dd className="mt-1 text-sm text-gray-900">{me.costCenter}</dd>
              </div>
            )}
          </dl>
          {profileError && <p className="text-xs text-red-600">{profileError}</p>}
          {profileSaved && <p className="text-xs text-green-600">Profile updated.</p>}
          <button
            onClick={() => profileMutation.mutate()}
            disabled={!nameChanged || profileMutation.isPending}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {profileMutation.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/* Change password card */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="mb-4 text-sm font-semibold text-gray-700">Change password</h2>
        {showSsoNote ? (
          <p className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            {ssoMessage}
          </p>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Current password</label>
              <input
                type="password"
                autoComplete="current-password"
                value={pwForm.current}
                onChange={(e) => setPwForm((f) => ({ ...f, current: e.target.value }))}
                className={inputCls}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">New password</label>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={pwForm.next}
                  onChange={(e) => setPwForm((f) => ({ ...f, next: e.target.value }))}
                  placeholder="Min 8 characters"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Confirm new password</label>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={pwForm.confirm}
                  onChange={(e) => setPwForm((f) => ({ ...f, confirm: e.target.value }))}
                  className={inputCls}
                />
              </div>
            </div>
            {pwError && <p className="text-xs text-red-600">{pwError}</p>}
            {pwSuccess && <p className="text-xs text-green-600">Password changed.</p>}
            <button
              onClick={submitPassword}
              disabled={!pwForm.current || !pwForm.next || !pwForm.confirm || pwMutation.isPending}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {pwMutation.isPending ? 'Changing…' : 'Change password'}
            </button>
          </div>
        )}
      </div>

      {/* Browser extension card — desktop only, like the setup modal itself. */}
      <div className="hidden rounded-xl border border-gray-200 bg-white p-5 lg:block">
        <h2 className="mb-1 text-sm font-semibold text-gray-700">Browser extension</h2>
        <p className="mb-3 text-xs text-gray-500">
          Capture receipts from any webpage with the Midas Capture extension for Chrome and Edge.
        </p>
        <button
          onClick={reopenExtensionSetup}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Show setup instructions
        </button>
      </div>
    </div>
  );
}
