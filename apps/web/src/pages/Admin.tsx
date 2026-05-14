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
  });

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
                  <td className="px-5 py-3 capitalize text-gray-600">{u.role}</td>
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

function ConnectionsTab() {
  const qc = useQueryClient();
  const [appName, setAppName] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const { data: connections = [] } = useQuery({
    queryKey: ['admin-connections'],
    queryFn: () => client.get('/admin/connections').then((r) => r.data.connections),
  });

  const createMutation = useMutation({
    mutationFn: () => client.post('/admin/connections', { appName }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['admin-connections'] });
      setNewKey(res.data.apiKey);
      setAppName('');
    },
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">API keys allow other internal apps to create expenses in Midas via the <code>/api/v1/ext/</code> endpoints.</p>
      <div className="flex gap-2">
        <input
          value={appName}
          onChange={(e) => setAppName(e.target.value)}
          placeholder="App name (e.g. argo)"
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none w-64"
        />
        <button
          onClick={() => createMutation.mutate()}
          disabled={!appName.trim()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
        >
          Generate Key
        </button>
      </div>

      {newKey && (
        <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-4">
          <p className="mb-1 text-sm font-semibold text-yellow-800">API Key (shown once — copy it now):</p>
          <code className="break-all text-xs text-yellow-900">{newKey}</code>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white">
        {connections.map((c: any) => (
          <div key={c.id} className="flex items-center justify-between border-b border-gray-100 px-5 py-3 last:border-0">
            <div>
              <p className="font-medium text-gray-900">{c.appName}</p>
              <p className="text-xs text-gray-400">{c.permissions?.join(', ') || 'all permissions'}</p>
            </div>
            <span className={`rounded-full px-2.5 py-0.5 text-xs ${c.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
              {c.isActive ? 'Active' : 'Revoked'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
