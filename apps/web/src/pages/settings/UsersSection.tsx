import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import client from '../../api/client';
import { companyApi } from '../../api/companies';
import { paymentMethodsApi } from '../../api/expenses';
import { ConfirmModal } from '../../components/ConfirmModal';
import { useAuth } from '../../contexts/AuthContext';
import type { User } from '../../types';

export interface AdminUser extends User {
  hasPassword: boolean;
  hasSso: boolean;
  inviteExpiresAt?: string | null;
}

const ROLES = ['user', 'accountant', 'admin', 'partner', 'developer'] as const;

const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-3 text-sm focus:border-brand-500 focus:outline-none lg:py-2';

function ErrorPanel({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  if (!message) return null;
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      <span>{message}</span>
      <button onClick={onDismiss} className="shrink-0 text-xs text-red-500 underline hover:text-red-700">
        Dismiss
      </button>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="shrink-0 rounded border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
    >
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
  );
}

function InviteLinkPanel({ title, url, onDismiss }: { title: string; url: string; onDismiss: () => void }) {
  return (
    <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-yellow-800">{title}</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="block select-all break-all rounded bg-yellow-100 px-2 py-1 text-xs text-yellow-900">{url}</code>
            <CopyButton text={url} />
          </div>
          <p className="mt-1 text-xs text-yellow-700">
            This link is shown once and expires in 7 days. Share it securely with the user.
          </p>
        </div>
        <button onClick={onDismiss} className="shrink-0 text-xs text-yellow-700 underline hover:text-yellow-900">
          Dismiss
        </button>
      </div>
    </div>
  );
}

function TempPasswordPanel({ name, password, onDismiss }: { name: string; password: string; onDismiss: () => void }) {
  return (
    <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold text-yellow-800">Temporary password for {name} — shown once:</p>
          <code className="mt-1 block select-all rounded bg-yellow-100 px-2 py-1 font-mono text-sm text-yellow-900">
            {password}
          </code>
          <p className="mt-1 text-xs text-yellow-700">Copy this now and share it securely. It will not be shown again.</p>
        </div>
        <button onClick={onDismiss} className="shrink-0 text-xs text-yellow-700 underline hover:text-yellow-900">
          Dismiss
        </button>
      </div>
    </div>
  );
}

function authLabel(u: AdminUser): string {
  return u.hasSso && u.hasPassword ? 'SSO + Local' : u.hasSso ? 'SSO-only' : u.hasPassword ? 'Local' : 'Invited';
}

function AuthBadge({ user }: { user: AdminUser }) {
  return (
    <span
      className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500"
      title="How this user can sign in"
    >
      {authLabel(user)}
    </span>
  );
}

function StatusPill({ active }: { active: boolean }) {
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

export function UsersSection() {
  const qc = useQueryClient();
  const { user: currentUser } = useAuth();

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', username: '', email: '', role: 'user', password: '' });
  const [createError, setCreateError] = useState('');

  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState({ name: '', username: '', email: '', role: 'user' });
  const [inviteError, setInviteError] = useState('');
  const [newInvite, setNewInvite] = useState<{ name: string; url: string } | null>(null);

  const [tempPasswords, setTempPasswords] = useState<Record<string, string>>({});
  const [inviteLinks, setInviteLinks] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState('');

  const [detailId, setDetailId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<'deactivate' | 'reactivate' | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<{ user: AdminUser; counts: Record<string, number> } | null>(null);

  const { data: users = [], isLoading } = useQuery<AdminUser[]>({
    queryKey: ['admin-users'],
    queryFn: () => client.get('/admin/users').then((r) => r.data.users),
  });

  // Two accounts with the same person's name are usually one person who was
  // created twice (once locally, once via SSO). Surface it before it calcifies.
  const duplicateNames = useMemo(() => {
    const seen = new Map<string, number>();
    for (const u of users) {
      const key = u.name.trim().toLowerCase().replace(/\s+/g, ' ');
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k));
  }, [users]);

  const detailUser = detailId ? users.find((u) => u.id === detailId) ?? null : null;

  const createMutation = useMutation({
    mutationFn: (body: typeof createForm) => client.post('/admin/users', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      setShowCreate(false);
      setCreateForm({ name: '', username: '', email: '', role: 'user', password: '' });
      setCreateError('');
    },
    onError: (err: any) => {
      setCreateError(err?.response?.data?.error?.message ?? 'Failed to create user');
    },
  });

  const inviteMutation = useMutation({
    mutationFn: (body: typeof inviteForm) => client.post('/admin/users/invite', body),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      setNewInvite({ name: inviteForm.name, url: res.data.inviteUrl });
      setShowInvite(false);
      setInviteForm({ name: '', username: '', email: '', role: 'user' });
      setInviteError('');
    },
    onError: (err: any) => {
      setInviteError(err?.response?.data?.error?.message ?? 'Failed to send invite');
    },
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: string; isActive?: boolean }) =>
      client.patch(`/admin/users/${id}`, body),
    onSuccess: () => {
      setActionError('');
      qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (err: any) => setActionError(err?.response?.data?.error?.message ?? 'Update failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id, purge }: { id: string; purge?: boolean }) =>
      client.delete(`/admin/users/${id}${purge ? '?purge=true' : ''}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  const bulkMutation = useMutation({
    mutationFn: (body: { ids: string[]; action: 'deactivate' | 'reactivate' }) =>
      client.post('/admin/users/bulk', body),
    onSuccess: (res) => {
      const skipped: Array<{ id: string; reason: string }> = res.data.skipped ?? [];
      const blocked = skipped.filter((s) => s.reason === 'last_admin');
      setActionError(blocked.length > 0 ? 'Some users were skipped: the last active admin cannot be deactivated.' : '');
      setSelected(new Set());
      setBulkAction(null);
      qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (err: any) => {
      setBulkAction(null);
      setActionError(err?.response?.data?.error?.message ?? 'Bulk update failed');
    },
  });

  /** Stage 1 confirmed: try the plain delete; a HAS_DATA 409 escalates to stage 2. */
  function handleDeletePermanently(u: AdminUser) {
    deleteMutation.mutate({ id: u.id }, {
      onSuccess: () => setDeleteTarget(null),
      onError: (err: any) => {
        const e = err?.response?.data?.error;
        setDeleteTarget(null);
        if (e?.code === 'HAS_DATA') {
          setPurgeTarget({ user: u, counts: e.counts ?? {} });
        } else {
          setActionError(e?.message ?? 'Delete failed');
        }
      },
    });
  }

  function handlePurge(u: AdminUser) {
    deleteMutation.mutate({ id: u.id, purge: true }, {
      onSuccess: () => setPurgeTarget(null),
      onError: (err: any) => {
        setPurgeTarget(null);
        setActionError(err?.response?.data?.error?.message ?? 'Delete failed');
      },
    });
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectableUsers = users.filter((u) => u.id !== currentUser?.id);
  const allSelected = selectableUsers.length > 0 && selectableUsers.every((u) => selected.has(u.id));
  const selectedUsers = users.filter((u) => selected.has(u.id));

  if (isLoading) return <div className="text-sm text-gray-400">Loading…</div>;

  return (
    <div className="space-y-5">
      {/* SSO boundary notice */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        <span className="font-semibold">Local user management — temporary.</span>{' '}
        These accounts use local bcrypt passwords. Once Authentik SSO is connected, identity will move to OIDC.
        Local accounts may remain as break-glass logins only.
      </div>

      <ErrorPanel message={actionError} onDismiss={() => setActionError('')} />

      {/* Header + actions */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-500">{users.length} user{users.length !== 1 ? 's' : ''}</p>
        <div className="flex gap-2">
          <button
            onClick={() => { setShowInvite((v) => !v); setShowCreate(false); setInviteError(''); }}
            className="min-h-11 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 lg:min-h-0"
          >
            {showInvite ? 'Cancel' : 'Invite User'}
          </button>
          <button
            onClick={() => { setShowCreate((v) => !v); setShowInvite(false); setCreateError(''); }}
            className="min-h-11 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 lg:min-h-0"
          >
            {showCreate ? 'Cancel' : '+ New User'}
          </button>
        </div>
      </div>

      {/* One-time invite link display */}
      {newInvite && (
        <InviteLinkPanel
          title={`Invitation link for ${newInvite.name} — shown once:`}
          url={newInvite.url}
          onDismiss={() => setNewInvite(null)}
        />
      )}

      {/* One-time panels for users whose modal is closed — never lose a
          shown-once secret just because the details modal was dismissed. */}
      {Object.entries(inviteLinks).filter(([id]) => id !== detailId).map(([id, url]) => (
        <InviteLinkPanel
          key={id}
          title={`Fresh invitation link for ${users.find((u) => u.id === id)?.name ?? 'user'} — shown once:`}
          url={url}
          onDismiss={() => setInviteLinks((prev) => { const n = { ...prev }; delete n[id]; return n; })}
        />
      ))}
      {Object.entries(tempPasswords).filter(([id]) => id !== detailId).map(([id, password]) => (
        <TempPasswordPanel
          key={id}
          name={users.find((u) => u.id === id)?.name ?? 'user'}
          password={password}
          onDismiss={() => setTempPasswords((prev) => { const n = { ...prev }; delete n[id]; return n; })}
        />
      ))}

      {/* Invite user form */}
      {showInvite && (
        <div className="space-y-3 rounded-xl border border-gray-200 bg-gray-50 p-5">
          <h3 className="text-sm font-semibold text-gray-700">Invite user</h3>
          <p className="text-xs text-gray-500">
            Creates the account without a password and returns a single-use invite link (valid 7 days).
            Email delivery isn't wired up yet — copy the link and share it yourself.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Name</label>
              <input
                value={inviteForm.name}
                onChange={(e) => setInviteForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Full name"
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Username</label>
              <input
                value={inviteForm.username}
                onChange={(e) => setInviteForm((f) => ({ ...f, username: e.target.value }))}
                placeholder="jsmith"
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Email</label>
              <input
                value={inviteForm.email}
                onChange={(e) => setInviteForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="email@example.com"
                type="email"
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Role</label>
              <select
                value={inviteForm.role}
                onChange={(e) => setInviteForm((f) => ({ ...f, role: e.target.value }))}
                className={inputCls}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          </div>
          {inviteError && <p className="text-xs text-red-600">{inviteError}</p>}
          <button
            onClick={() => inviteMutation.mutate(inviteForm)}
            disabled={inviteMutation.isPending || !inviteForm.name || !inviteForm.email}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {inviteMutation.isPending ? 'Creating invite…' : 'Create Invite'}
          </button>
        </div>
      )}

      {/* Create user form (with password) */}
      {showCreate && (
        <div className="space-y-3 rounded-xl border border-gray-200 bg-gray-50 p-5">
          <h3 className="text-sm font-semibold text-gray-700">Create user</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Name</label>
              <input
                value={createForm.name}
                onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Full name"
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Username</label>
              <input
                value={createForm.username}
                onChange={(e) => setCreateForm((f) => ({ ...f, username: e.target.value }))}
                placeholder="jsmith"
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                Email <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <input
                value={createForm.email}
                onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="email@example.com"
                type="email"
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Role</label>
              <select
                value={createForm.role}
                onChange={(e) => setCreateForm((f) => ({ ...f, role: e.target.value }))}
                className={inputCls}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Initial password</label>
              <input
                value={createForm.password}
                onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="Min 8 characters"
                type="password"
                className={inputCls}
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

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2.5">
          <span className="text-sm font-medium text-brand-800">{selected.size} selected</span>
          <button
            onClick={() => setBulkAction('deactivate')}
            className="rounded border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
          >
            Deactivate
          </button>
          <button
            onClick={() => setBulkAction('reactivate')}
            className="rounded border border-green-200 bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700 hover:bg-green-100"
          >
            Reactivate
          </button>
          <button onClick={() => setSelected(new Set())} className="text-xs text-gray-500 underline hover:text-gray-700">
            Clear selection
          </button>
        </div>
      )}

      {/* User table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {/* Mobile cards */}
        <div className="md:hidden">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 border-b border-gray-100 px-4 text-xs font-semibold uppercase tracking-wider text-gray-500">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(selectableUsers.map((u) => u.id)))}
              className="rounded border-gray-300"
              aria-label="Select all users"
            />
            Select all
          </label>
          <div className="divide-y divide-gray-100">
            {users.map((u) => (
              <div key={u.id} className="flex items-center gap-1 p-4 pl-2">
                {/* Oversized label = 44px tap area; toggles selection only */}
                <label className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
                  <input
                    type="checkbox"
                    checked={selected.has(u.id)}
                    onChange={() => toggleSelected(u.id)}
                    disabled={u.id === currentUser?.id}
                    title={u.id === currentUser?.id ? 'You cannot bulk-edit your own account' : ''}
                    className="rounded border-gray-300 disabled:opacity-30"
                    aria-label={`Select ${u.name}`}
                  />
                </label>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-gray-900">
                    {u.name}
                    {duplicateNames.has(u.name.trim().toLowerCase().replace(/\s+/g, ' ')) && (
                      <span
                        className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800"
                        title="Another account has this name — they may be the same person recorded twice."
                      >
                        possible duplicate
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-gray-500">{u.email ?? '—'}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="text-xs capitalize text-gray-600">{u.role}</span>
                    <AuthBadge user={u} />
                    <StatusPill active={u.isActive} />
                  </div>
                </div>
                <button
                  onClick={() => setDetailId(u.id)}
                  className="min-h-11 shrink-0 rounded-lg border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                >
                  Manage
                </button>
              </div>
            ))}
          </div>
        </div>
        <table className="hidden w-full text-sm md:table">
          <thead>
            <tr className="border-b text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
              <th className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(selectableUsers.map((u) => u.id)))}
                  className="rounded border-gray-300"
                  aria-label="Select all users"
                />
              </th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Last login</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map((u) => (
              <tr key={u.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selected.has(u.id)}
                    onChange={() => toggleSelected(u.id)}
                    disabled={u.id === currentUser?.id}
                    title={u.id === currentUser?.id ? 'You cannot bulk-edit your own account' : ''}
                    className="rounded border-gray-300 disabled:opacity-30"
                    aria-label={`Select ${u.name}`}
                  />
                </td>
                <td className="px-4 py-3 font-medium text-gray-900">
                  {u.name}
                  {duplicateNames.has(u.name.trim().toLowerCase().replace(/\s+/g, ' ')) && (
                    <span
                      className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800"
                      title="Another account has this name — they may be the same person recorded twice."
                    >
                      possible duplicate
                    </span>
                  )}
                  {u.department && <span className="ml-2 text-xs font-normal text-gray-400">{u.department}</span>}
                </td>
                <td className="px-4 py-3 text-gray-600">{u.email ?? <span className="text-gray-300">—</span>}</td>
                <td className="px-4 py-3 text-gray-600">
                  <span className="capitalize">{u.role}</span>
                  <span className="ml-2">
                    <AuthBadge user={u} />
                  </span>
                </td>
                <td className="px-4 py-3">
                  <StatusPill active={u.isActive} />
                </td>
                <td className="px-4 py-3 text-gray-600" title={u.lastLoginAt ?? undefined}>
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => setDetailId(u.id)}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
                  >
                    Manage
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* User detail modal */}
      {detailUser && (
        <UserDetailModal
          user={detailUser}
          allUsers={users}
          onClose={() => setDetailId(null)}
          onDelete={() => {
            setDetailId(null);
            setDeleteTarget(detailUser);
          }}
          inviteLink={inviteLinks[detailUser.id]}
          tempPassword={tempPasswords[detailUser.id]}
          onInviteLink={(url) => setInviteLinks((prev) => ({ ...prev, [detailUser.id]: url }))}
          onTempPassword={(pw) => setTempPasswords((prev) => ({ ...prev, [detailUser.id]: pw }))}
          onDismissInviteLink={() => setInviteLinks((prev) => { const n = { ...prev }; delete n[detailUser.id]; return n; })}
          onDismissTempPassword={() => setTempPasswords((prev) => { const n = { ...prev }; delete n[detailUser.id]; return n; })}
        />
      )}

      {/* Bulk confirm */}
      <ConfirmModal
        open={bulkAction !== null}
        title={bulkAction === 'deactivate' ? `Deactivate ${selected.size} user${selected.size !== 1 ? 's' : ''}?` : `Reactivate ${selected.size} user${selected.size !== 1 ? 's' : ''}?`}
        confirmLabel={bulkAction === 'deactivate' ? 'Deactivate' : 'Reactivate'}
        danger={bulkAction === 'deactivate'}
        loading={bulkMutation.isPending}
        onConfirm={() => bulkAction && bulkMutation.mutate({ ids: [...selected], action: bulkAction })}
        onCancel={() => setBulkAction(null)}
      >
        <p>
          {bulkAction === 'deactivate'
            ? 'Deactivated users keep all their data but can no longer sign in.'
            : 'Reactivated users will be able to sign in again.'}
        </p>
        <ul className="mt-2 max-h-32 list-inside list-disc overflow-y-auto text-xs text-gray-500">
          {selectedUsers.slice(0, 8).map((u) => <li key={u.id}>{u.name}</li>)}
          {selectedUsers.length > 8 && <li>…and {selectedUsers.length - 8} more</li>}
        </ul>
      </ConfirmModal>

      {/* Delete stage 1: prefer deactivation */}
      <ConfirmModal
        open={deleteTarget !== null}
        title={`Delete ${deleteTarget?.name}?`}
        confirmLabel="Deactivate instead"
        secondaryLabel="Delete permanently"
        secondaryDanger
        loading={deleteMutation.isPending || patchMutation.isPending}
        onConfirm={() => {
          if (!deleteTarget) return;
          patchMutation.mutate({ id: deleteTarget.id, isActive: false }, { onSettled: () => setDeleteTarget(null) });
        }}
        onSecondary={() => deleteTarget && handleDeletePermanently(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      >
        <p>
          Deactivating keeps their expense history intact and simply blocks sign-in — this is
          almost always the right choice. Permanent deletion cannot be undone.
        </p>
      </ConfirmModal>

      {/* Delete stage 2: user owns data → purge */}
      <ConfirmModal
        open={purgeTarget !== null}
        title={`${purgeTarget?.user.name} owns data`}
        confirmLabel="Delete user AND all their data"
        danger
        loading={deleteMutation.isPending}
        onConfirm={() => purgeTarget && handlePurge(purgeTarget.user)}
        onCancel={() => setPurgeTarget(null)}
      >
        <p>This user still owns:</p>
        <ul className="mt-2 list-inside list-disc text-sm text-gray-700">
          {Object.entries({
            expenses: 'expense(s)',
            receipts: 'receipt(s)',
            messages: 'message(s)',
            captures: 'capture(s)',
          }).map(([key, label]) => {
            const n = purgeTarget?.counts?.[key] ?? 0;
            return n > 0 ? <li key={key}>{n} {label}</li> : null;
          })}
        </ul>
        <p className="mt-2 font-medium text-red-700">
          Deleting will permanently remove the user and everything listed above. This cannot be undone.
        </p>
      </ConfirmModal>
    </div>
  );
}

// ── User detail modal ─────────────────────────────────────────────────────────

function UserDetailModal({
  user,
  allUsers,
  onClose,
  onDelete,
  inviteLink,
  tempPassword,
  onInviteLink,
  onTempPassword,
  onDismissInviteLink,
  onDismissTempPassword,
}: {
  user: AdminUser;
  allUsers: AdminUser[];
  onClose: () => void;
  onDelete: () => void;
  inviteLink?: string;
  tempPassword?: string;
  onInviteLink: (url: string) => void;
  onTempPassword: (pw: string) => void;
  onDismissInviteLink: () => void;
  onDismissTempPassword: () => void;
}) {
  const qc = useQueryClient();
  const { user: currentUser } = useAuth();
  const isSelf = user.id === currentUser?.id;
  const isInvited = !user.hasPassword && !user.hasSso;
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    name: user.name,
    role: user.role as string,
    ssoUsername: user.ssoUsername ?? '',
    department: user.department ?? '',
    employeeId: user.employeeId ?? '',
    costCenter: user.costCenter ?? '',
    managerId: user.managerId ?? '',
    defaultZohoEntity: user.defaultZohoEntity ?? '',
    defaultPaymentMethodId: user.defaultPaymentMethodId ?? '',
  });

  const { data: companies = [] } = useQuery({
    queryKey: ['companies'],
    queryFn: () => companyApi.list(),
  });
  const { data: paymentMethods = [] } = useQuery({
    queryKey: ['payment-methods'],
    queryFn: () => paymentMethodsApi.list(),
  });

  function set(key: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const saveMutation = useMutation({
    mutationFn: () => client.patch(`/admin/users/${user.id}`, {
      name: form.name.trim() || undefined,
      // Own role is immutable — the select is disabled, and we never send it.
      ...(isSelf ? {} : { role: form.role }),
      ssoUsername: form.ssoUsername.trim() || null,
      department: form.department.trim() || null,
      employeeId: form.employeeId.trim() || null,
      costCenter: form.costCenter.trim() || null,
      managerId: form.managerId || null,
      defaultZohoEntity: form.defaultZohoEntity || null,
      defaultPaymentMethodId: form.defaultPaymentMethodId || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      setError('');
      onClose();
    },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Update failed'),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: () => client.patch(`/admin/users/${user.id}`, { isActive: !user.isActive }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      setError('');
    },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Update failed'),
  });

  const resetMutation = useMutation({
    mutationFn: () => client.post(`/admin/users/${user.id}/reset-password`),
    onSuccess: (res) => {
      onTempPassword(res.data.tempPassword);
      setError('');
      qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Password reset failed'),
  });

  const resendMutation = useMutation({
    mutationFn: () => client.post(`/admin/users/${user.id}/invite/resend`),
    onSuccess: (res) => {
      onInviteLink(res.data.inviteUrl);
      setError('');
    },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Could not resend invite'),
  });

  const actionBtnCls = 'min-h-11 rounded-lg border px-3.5 py-1.5 text-sm font-medium shadow-sm disabled:opacity-40 sm:min-h-0';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center" onClick={onClose}>
      <div
        className="my-4 w-full max-w-2xl rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-6 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-bold text-gray-900">{user.name}</h2>
              <StatusPill active={user.isActive} />
              <AuthBadge user={user} />
            </div>
            <p className="mt-0.5 truncate text-sm text-gray-500">
              {user.email ?? 'No email'}
              {user.username ? ` · @${user.username}` : ''}
            </p>
            <p className="mt-0.5 text-xs text-gray-400">
              Last login: {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'never'}
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          <ErrorPanel message={error} onDismiss={() => setError('')} />

          {/* One-time secrets for this user */}
          {inviteLink && (
            <InviteLinkPanel
              title={`Fresh invitation link for ${user.name} — shown once:`}
              url={inviteLink}
              onDismiss={onDismissInviteLink}
            />
          )}
          {tempPassword && (
            <TempPasswordPanel name={user.name} password={tempPassword} onDismiss={onDismissTempPassword} />
          )}

          {/* Profile */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Profile</h3>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Name</label>
                <input value={form.name} onChange={(e) => set('name', e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Role</label>
                <select
                  value={form.role}
                  onChange={(e) => set('role', e.target.value)}
                  disabled={isSelf}
                  title={isSelf ? 'You cannot change your own role' : ''}
                  className={`${inputCls} capitalize disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400`}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Authentik username</label>
                <input value={form.ssoUsername} onChange={(e) => set('ssoUsername', e.target.value)} placeholder="e.g. jsmith" className={inputCls} />
                <p className="mt-1 text-[11px] text-gray-400">
                  Links this person to their SSO account before their first login, so they are not created twice.
                </p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Department</label>
                <input value={form.department} onChange={(e) => set('department', e.target.value)} placeholder="e.g. Marketing" className={inputCls} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Employee ID</label>
                <input value={form.employeeId} onChange={(e) => set('employeeId', e.target.value)} placeholder="e.g. E-1042" className={inputCls} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Cost center</label>
                <input value={form.costCenter} onChange={(e) => set('costCenter', e.target.value)} placeholder="e.g. CC-200" className={inputCls} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Manager</label>
                <select value={form.managerId} onChange={(e) => set('managerId', e.target.value)} className={inputCls}>
                  <option value="">— No manager —</option>
                  {allUsers.filter((u) => u.id !== user.id).map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Default company</label>
                <select value={form.defaultZohoEntity} onChange={(e) => set('defaultZohoEntity', e.target.value)} className={inputCls}>
                  <option value="">— No default —</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.name}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Default payment method</label>
                <select value={form.defaultPaymentMethodId} onChange={(e) => set('defaultPaymentMethodId', e.target.value)} className={inputCls}>
                  <option value="">— No default —</option>
                  {paymentMethods.map((pm) => (
                    <option key={pm.id} value={pm.id}>{pm.label}{pm.lastFour ? ` ···${pm.lastFour}` : ''}</option>
                  ))}
                </select>
              </div>
            </div>
            <button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !form.name.trim()}
              className="mt-3 min-h-11 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60 sm:min-h-0"
            >
              {saveMutation.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </div>

          {/* Account actions */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Account</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {user.isActive ? (
                <button
                  onClick={() => toggleActiveMutation.mutate()}
                  disabled={isSelf || toggleActiveMutation.isPending}
                  title={isSelf ? 'Cannot deactivate your own account' : 'Blocks sign-in; keeps all data'}
                  className={`${actionBtnCls} border-red-200 bg-white text-red-700 hover:bg-red-50`}
                >
                  Deactivate
                </button>
              ) : (
                <button
                  onClick={() => toggleActiveMutation.mutate()}
                  disabled={toggleActiveMutation.isPending}
                  className={`${actionBtnCls} border-green-200 bg-white text-green-700 hover:bg-green-50`}
                >
                  Reactivate
                </button>
              )}
              <button
                onClick={() => resetMutation.mutate()}
                disabled={resetMutation.isPending}
                title="Generates a temporary local password, shown once"
                className={`${actionBtnCls} border-gray-300 bg-white text-gray-700 hover:bg-gray-50`}
              >
                {resetMutation.isPending ? 'Resetting…' : 'Reset password'}
              </button>
              {isInvited && (
                <button
                  onClick={() => resendMutation.mutate()}
                  disabled={resendMutation.isPending}
                  className={`${actionBtnCls} border-brand-200 bg-white text-brand-700 hover:bg-brand-50`}
                >
                  {resendMutation.isPending ? 'Creating link…' : 'Resend invite'}
                </button>
              )}
            </div>
          </div>

          {/* Danger zone */}
          {!isSelf && (
            <div className="rounded-lg border border-red-200 bg-red-50/50 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-red-800">Delete this user</p>
                  <p className="text-xs text-red-600">Deactivating is usually the right choice — deletion cannot be undone.</p>
                </div>
                <button
                  onClick={onDelete}
                  className="min-h-11 rounded-lg bg-red-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-red-700 sm:min-h-0"
                >
                  Delete…
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
