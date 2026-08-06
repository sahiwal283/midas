import { useState, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import client from '../api/client';

type Tab = 'users' | 'categories' | 'connections';

export function Admin() {
  const [tab, setTab] = useState<Tab>('users');

  return (
    <div className="p-8">
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Admin Settings</h1>

      <div className="mb-6 flex gap-1 rounded-lg border border-gray-200 bg-gray-100 p-1 w-fit">
        {(['users', 'categories', 'connections'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium capitalize transition-colors ${tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'users' && <UsersTab />}
      {tab === 'categories' && <CategoriesTab />}
      {tab === 'connections' && <ConnectionsTab />}
    </div>
  );
}

function UsersTab() {
  const qc = useQueryClient();
  const { user: currentUser } = useAuth();

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', email: '', role: 'user', password: '' });
  const [createError, setCreateError] = useState('');

  const [tempPasswords, setTempPasswords] = useState<Record<string, string>>({});

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => client.get('/admin/users').then((r) => r.data.users),
  });

  const createMutation = useMutation({
    mutationFn: (body: typeof createForm) => client.post('/admin/users', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      setShowCreate(false);
      setCreateForm({ name: '', email: '', role: 'user', password: '' });
      setCreateError('');
    },
    onError: (err: any) => {
      setCreateError(err?.response?.data?.error ?? 'Failed to create user');
    },
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: string; isActive?: boolean; role?: string }) =>
      client.patch(`/admin/users/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
    onError: (err: any) => alert(err?.response?.data?.error?.message ?? 'Update failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id, purge }: { id: string; purge?: boolean }) =>
      client.delete(`/admin/users/${id}${purge ? '?purge=true' : ''}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  function handleDelete(u: { id: string; name: string }) {
    if (!window.confirm(`Delete ${u.name}? This cannot be undone.`)) return;
    deleteMutation.mutate({ id: u.id }, {
      onError: (err: any) => {
        const e = err?.response?.data?.error;
        if (e?.code === 'HAS_DATA') {
          const c = e.counts ?? {};
          const summary = [
            c.expenses ? `${c.expenses} expense(s)` : null,
            c.receipts ? `${c.receipts} receipt(s)` : null,
            c.messages ? `${c.messages} message(s)` : null,
            c.captures ? `${c.captures} capture(s)` : null,
            c.partnerExpenses ? `${c.partnerExpenses} partner expense(s)` : null,
          ].filter(Boolean).join(', ');
          if (window.confirm(`${u.name} owns: ${summary}.\n\nDelete the user AND all this data? This cannot be undone.`)) {
            deleteMutation.mutate({ id: u.id, purge: true }, {
              onError: (err2: any) => alert(err2?.response?.data?.error?.message ?? 'Delete failed'),
            });
          }
        } else {
          alert(e?.message ?? 'Delete failed');
        }
      },
    });
  }

  const resetMutation = useMutation({
    mutationFn: (id: string) => client.post(`/admin/users/${id}/reset-password`),
    onSuccess: (res, id) => {
      setTempPasswords((prev) => ({ ...prev, [id]: res.data.tempPassword }));
      qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });

  if (isLoading) return <div className="text-sm text-gray-400">Loading…</div>;

  return (
    <div className="space-y-5">
      {/* SSO boundary notice */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        <span className="font-semibold">Local user management — temporary.</span>{' '}
        These accounts use local bcrypt passwords. Once Authentik SSO is connected, identity will move to OIDC.
        Local accounts may remain as break-glass logins only.
      </div>

      {/* Header + create button */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{users.length} user{users.length !== 1 ? 's' : ''}</p>
        <button
          onClick={() => { setShowCreate((v) => !v); setCreateError(''); }}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          {showCreate ? 'Cancel' : '+ New User'}
        </button>
      </div>

      {/* Create user form */}
      {showCreate && (
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-5 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Create user</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Name</label>
              <input
                value={createForm.name}
                onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Full name"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Email</label>
              <input
                value={createForm.email}
                onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="email@example.com"
                type="email"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Role</label>
              <select
                value={createForm.role}
                onChange={(e) => setCreateForm((f) => ({ ...f, role: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
              >
                <option value="user">User</option>
                <option value="accountant">Accountant</option>
                <option value="admin">Admin</option>
                <option value="partner">Partner</option>
                <option value="developer">Developer</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Initial password</label>
              <input
                value={createForm.password}
                onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="Min 8 characters"
                type="password"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
              />
            </div>
          </div>
          {createError && <p className="text-xs text-red-600">{createError}</p>}
          <button
            onClick={() => createMutation.mutate(createForm)}
            disabled={createMutation.isPending || !createForm.name || !createForm.email || !createForm.password}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {createMutation.isPending ? 'Creating…' : 'Create User'}
          </button>
        </div>
      )}

      {/* User table */}
      <div className="rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
              <th className="px-5 py-3">Name</th>
              <th className="px-5 py-3">Email</th>
              <th className="px-5 py-3">Role</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map((u: any) => (
              <Fragment key={u.id}>
                <tr className="hover:bg-gray-50">
                  <td className="px-5 py-3 font-medium text-gray-900">{u.name}</td>
                  <td className="px-5 py-3 text-gray-600">{u.email}</td>
                  <td className="px-5 py-3 text-gray-600">
                    <select
                      value={u.role}
                      onChange={(e) => patchMutation.mutate({ id: u.id, role: e.target.value })}
                      disabled={u.id === currentUser?.id || patchMutation.isPending}
                      title={u.id === currentUser?.id ? 'You cannot change your own role' : ''}
                      className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm capitalize text-gray-700 focus:border-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:border-transparent disabled:bg-transparent disabled:appearance-none"
                    >
                      {['user', 'accountant', 'admin', 'partner', 'developer'].map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                    <span
                      className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500"
                      title="How this user can sign in"
                    >
                      {u.hasSso && u.hasPassword ? 'SSO + Local' : u.hasSso ? 'SSO-only' : u.hasPassword ? 'Local' : 'No login'}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${u.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                      {u.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      {u.isActive ? (
                        <button
                          onClick={() => patchMutation.mutate({ id: u.id, isActive: false })}
                          disabled={u.id === currentUser?.id || patchMutation.isPending}
                          title={u.id === currentUser?.id ? 'Cannot deactivate your own account' : ''}
                          className="rounded border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-40"
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          onClick={() => patchMutation.mutate({ id: u.id, isActive: true })}
                          disabled={patchMutation.isPending}
                          className="rounded border border-green-200 bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-100 disabled:opacity-40"
                        >
                          Reactivate
                        </button>
                      )}
                      <button
                        onClick={() => resetMutation.mutate(u.id)}
                        disabled={resetMutation.isPending}
                        className="rounded border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                      >
                        Reset Password
                      </button>
                      {u.id !== currentUser?.id && (
                        <button
                          onClick={() => handleDelete(u)}
                          disabled={deleteMutation.isPending}
                          className="rounded border border-red-300 bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {tempPasswords[u.id] && (
                  <tr className="bg-yellow-50">
                    <td colSpan={5} className="px-5 py-3">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-xs font-semibold text-yellow-800">Temporary password for {u.name} — shown once:</p>
                          <code className="mt-1 block select-all rounded bg-yellow-100 px-2 py-1 text-sm font-mono text-yellow-900">
                            {tempPasswords[u.id]}
                          </code>
                          <p className="mt-1 text-xs text-yellow-700">Copy this now and share it securely. It will not be shown again.</p>
                        </div>
                        <button
                          onClick={() => setTempPasswords((prev) => { const n = { ...prev }; delete n[u.id]; return n; })}
                          className="text-xs text-yellow-700 underline hover:text-yellow-900 shrink-0"
                        >
                          Dismiss
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CategoriesTab() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const { data: categories = [], isLoading } = useQuery({
    queryKey: ['admin-categories'],
    queryFn: () => client.get('/admin/categories').then((r) => r.data.categories),
  });

  const addMutation = useMutation({
    mutationFn: () => client.post('/admin/categories', { name }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-categories'] }); setName(''); },
  });

  if (isLoading) return <div className="text-sm text-gray-400">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New category name"
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none w-64"
        />
        <button
          onClick={() => addMutation.mutate()}
          disabled={!name.trim()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
        >
          Add
        </button>
      </div>
      <div className="rounded-xl border border-gray-200 bg-white">
        {categories.map((c: any) => (
          <div key={c.id} className="flex items-center justify-between border-b border-gray-100 px-5 py-3 last:border-0">
            <div>
              <p className="font-medium text-gray-900">{c.name}</p>
              {c.description && <p className="text-xs text-gray-400">{c.description}</p>}
            </div>
            <span className={`rounded-full px-2.5 py-0.5 text-xs ${c.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
              {c.isActive ? 'Active' : 'Hidden'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const EXT_SCOPES = [
  'expenses:create',
  'expenses:read',
  'expenses:update',
  'expenses:delete',
  'receipts:create',
  'expenses:import',
  'ocr:process',
] as const;

const TRADE_SHOW_DEFAULT_SCOPES = [...EXT_SCOPES];

function ConnectionsTab() {
  const qc = useQueryClient();
  const [appName, setAppName] = useState('');
  const [scopes, setScopes] = useState<string[]>([...TRADE_SHOW_DEFAULT_SCOPES]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const { data: connections = [] } = useQuery({
    queryKey: ['admin-connections'],
    queryFn: () => client.get('/admin/connections').then((r) => r.data.connections),
  });

  const createMutation = useMutation({
    mutationFn: () => client.post('/admin/connections', { appName, permissions: scopes }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['admin-connections'] });
      setNewKey(res.data.apiKey);
      setAppName('');
    },
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: string; isActive?: boolean; permissions?: string[] }) =>
      client.patch(`/admin/connections/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-connections'] }),
  });

  function toggleScope(scope: string) {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        API keys allow other internal apps to call <code>/api/v1/ext/</code>. Empty scopes deny all Ext routes.
        Use app name <code>trade_show</code> with all scopes checked for the Trade Show BFF.
      </p>
      <div className="flex flex-wrap items-start gap-3">
        <input
          value={appName}
          onChange={(e) => setAppName(e.target.value)}
          placeholder="App name (e.g. trade_show)"
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none w-64"
        />
        <button
          onClick={() => createMutation.mutate()}
          disabled={!appName.trim() || scopes.length === 0 || createMutation.isPending}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
        >
          Generate Key
        </button>
      </div>
      <div className="flex flex-wrap gap-3 rounded-lg border border-gray-200 bg-white p-3">
        {EXT_SCOPES.map((scope) => (
          <label key={scope} className="flex items-center gap-1.5 text-xs text-gray-700">
            <input
              type="checkbox"
              checked={scopes.includes(scope)}
              onChange={() => toggleScope(scope)}
              className="rounded border-gray-300"
            />
            {scope}
          </label>
        ))}
      </div>

      {newKey && (
        <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-4">
          <p className="mb-1 text-sm font-semibold text-yellow-800">API Key (shown once — copy it now):</p>
          <code className="break-all text-xs text-yellow-900">{newKey}</code>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white">
        {connections.map((c: { id: string; appName: string; permissions?: string[]; isActive: boolean }) => (
          <div key={c.id} className="flex items-center justify-between gap-4 border-b border-gray-100 px-5 py-3 last:border-0">
            <div className="min-w-0">
              <p className="font-medium text-gray-900">{c.appName}</p>
              <p className="text-xs text-gray-400 break-all">
                {c.permissions?.length ? c.permissions.join(', ') : 'no scopes (all Ext calls denied)'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className={`rounded-full px-2.5 py-0.5 text-xs ${c.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                {c.isActive ? 'Active' : 'Revoked'}
              </span>
              <button
                type="button"
                disabled={patchMutation.isPending}
                onClick={() => patchMutation.mutate({ id: c.id, isActive: !c.isActive })}
                className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-60"
              >
                {c.isActive ? 'Revoke' : 'Activate'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
