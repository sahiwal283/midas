import { useState, useMemo, useEffect, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import client from '../api/client';
import { ConfirmModal } from '../components/ConfirmModal';
import { companyApi } from '../api/companies';
import { paymentMethodsApi } from '../api/expenses';
import { MyAccountSection } from './settings/MyAccountSection';
import { PaymentMethodsSection } from './settings/PaymentMethodsSection';
import { BudgetsSection } from './settings/BudgetsSection';
import type { User } from '../types';
import { flattenTree, descendantIdSet, type CategoryTreeNode } from '../lib/categoryTree';
import { useCollapsibleTree } from '../lib/useCollapsibleTree';
import { ChartOfAccountsSection } from './settings/ChartOfAccountsSection';
import { ClosedPeriodsSection } from './settings/ClosedPeriodsSection';

type Section = 'account' | 'companies' | 'users' | 'categories' | 'chart-of-accounts' | 'payment-methods' | 'budgets' | 'closed-periods' | 'connections' | 'audit';

interface AdminUser extends User {
  hasPassword: boolean;
  hasSso: boolean;
  inviteExpiresAt?: string | null;
}

type NavGroup = { label: string; items: { id: Section; label: string }[] };

const ACCOUNT_GROUP: NavGroup = { label: 'Account', items: [{ id: 'account', label: 'My Account' }] };
const EXPENSES_GROUP: NavGroup = {
  label: 'Expenses',
  items: [
    { id: 'categories', label: 'Categories' },
    { id: 'chart-of-accounts', label: 'Chart of Accounts' },
    { id: 'payment-methods', label: 'Payment Methods' },
    { id: 'budgets', label: 'Budgets' },
    { id: 'closed-periods', label: 'Closed Periods' },
  ],
};

/** Role-scoped settings nav: everyone gets My Account; accountants add the
 *  Expenses group; admins (and developers) see everything. */
function navGroupsForRole(role: string | undefined): NavGroup[] {
  if (role === 'admin' || role === 'developer') {
    return [
      ACCOUNT_GROUP,
      { label: 'Company', items: [{ id: 'companies', label: 'Companies' }] },
      { label: 'People', items: [{ id: 'users', label: 'Users' }] },
      EXPENSES_GROUP,
      { label: 'Integrations', items: [{ id: 'connections', label: 'Connections' }] },
      { label: 'Security', items: [{ id: 'audit', label: 'Audit Log' }] },
    ];
  }
  if (role === 'accountant') {
    return [
      ACCOUNT_GROUP,
      EXPENSES_GROUP,
    ];
  }
  return [ACCOUNT_GROUP];
}

function defaultSectionForRole(role: string | undefined): Section {
  if (role === 'admin' || role === 'developer') return 'users';
  if (role === 'accountant') return 'categories';
  return 'account';
}

const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none';

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

export function Admin() {
  const { user } = useAuth();
  const [section, setSection] = useState<Section>(() => defaultSectionForRole(user?.role));

  const navGroups = navGroupsForRole(user?.role);
  const allowedSections = new Set(navGroups.flatMap((g) => g.items.map((i) => i.id)));
  const activeSection = allowedSections.has(section) ? section : defaultSectionForRole(user?.role);

  return (
    <div className="p-8">
      <h1 className="mb-6 font-display text-3xl font-semibold text-ink">Settings</h1>

      <div className="flex flex-col gap-8 lg:flex-row">
        {/* Grouped section nav */}
        <nav className="w-full shrink-0 lg:w-52">
          <div className="space-y-5 rounded-xl border border-gray-200 bg-white p-4">
            {navGroups.map((group) => (
              <div key={group.label}>
                <p className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setSection(item.id)}
                      className={`block w-full rounded-lg px-2 py-1.5 text-left text-sm font-medium transition-colors ${
                        activeSection === item.id
                          ? 'bg-brand-50 text-brand-700'
                          : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </nav>

        <div className="min-w-0 flex-1">
          {activeSection === 'account' && <MyAccountSection />}
          {activeSection === 'users' && <UsersTab />}
          {activeSection === 'companies' && <CompaniesTab />}
          {activeSection === 'categories' && <CategoriesTab />}
          {activeSection === 'chart-of-accounts' && <ChartOfAccountsSection />}
          {activeSection === 'payment-methods' && <PaymentMethodsSection />}
          {activeSection === 'budgets' && <BudgetsSection />}
          {activeSection === 'closed-periods' && <ClosedPeriodsSection />}
          {activeSection === 'connections' && <ConnectionsTab />}
          {activeSection === 'audit' && <AuditTab />}
        </div>
      </div>
    </div>
  );
}

// ── Companies ────────────────────────────────────────────────────────────────

function CompaniesTab() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const { data: companies = [], isLoading } = useQuery({
    queryKey: ['admin-companies'],
    queryFn: () => client.get('/admin/companies').then((r) => r.data.companies),
  });

  const createMutation = useMutation({
    mutationFn: () => client.post('/admin/companies', { name }),
    onSuccess: () => {
      setName('');
      setError('');
      qc.invalidateQueries({ queryKey: ['admin-companies'] });
      qc.invalidateQueries({ queryKey: ['companies'] });
    },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Could not add company'),
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: string; zohoEnabled?: boolean; isActive?: boolean }) =>
      client.patch(`/admin/companies/${id}`, body),
    onSuccess: () => {
      setError('');
      qc.invalidateQueries({ queryKey: ['admin-companies'] });
      qc.invalidateQueries({ queryKey: ['companies'] });
    },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Update failed'),
  });

  if (isLoading) return <div className="text-sm text-gray-400">Loading…</div>;

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500">
        Companies appear in the expense form's Company picker. Companies with Zoho off never sync to Zoho —
        their expenses always go to the accountant.
      </p>

      <ErrorPanel message={error} onDismiss={() => setError('')} />

      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New company name"
          className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        />
        <button
          onClick={() => createMutation.mutate()}
          disabled={!name.trim() || createMutation.isPending}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
        >
          Add Company
        </button>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
              <th className="px-5 py-3">Name</th>
              <th className="px-5 py-3">Zoho</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {companies.map((c: any) => (
              <tr key={c.id} className="hover:bg-gray-50">
                <td className="px-5 py-3 font-medium text-gray-900">{c.name}</td>
                <td className="px-5 py-3">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${c.zohoEnabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                    {c.zohoEnabled ? 'Syncs to Zoho' : 'No Zoho'}
                  </span>
                </td>
                <td className="px-5 py-3">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${c.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {c.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => patchMutation.mutate({ id: c.id, zohoEnabled: !c.zohoEnabled })}
                      disabled={patchMutation.isPending}
                      className="rounded border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                    >
                      {c.zohoEnabled ? 'Disable Zoho' : 'Enable Zoho'}
                    </button>
                    <button
                      onClick={() => patchMutation.mutate({ id: c.id, isActive: !c.isActive })}
                      disabled={patchMutation.isPending}
                      className={`rounded border px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
                        c.isActive
                          ? 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
                          : 'border-green-200 bg-green-50 text-green-700 hover:bg-green-100'
                      }`}
                    >
                      {c.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Users ────────────────────────────────────────────────────────────────────

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

function UsersTab() {
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

  const [editingId, setEditingId] = useState<string | null>(null);
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

  const resendMutation = useMutation({
    mutationFn: (id: string) => client.post(`/admin/users/${id}/invite/resend`),
    onSuccess: (res, id) => {
      setInviteLinks((prev) => ({ ...prev, [id]: res.data.inviteUrl }));
      setActionError('');
    },
    onError: (err: any) => setActionError(err?.response?.data?.error?.message ?? 'Could not resend invite'),
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: string; isActive?: boolean; role?: string }) =>
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

  const resetMutation = useMutation({
    mutationFn: (id: string) => client.post(`/admin/users/${id}/reset-password`),
    onSuccess: (res, id) => {
      setTempPasswords((prev) => ({ ...prev, [id]: res.data.tempPassword }));
      qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (err: any) => setActionError(err?.response?.data?.error?.message ?? 'Password reset failed'),
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
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            {showInvite ? 'Cancel' : 'Invite User'}
          </button>
          <button
            onClick={() => { setShowCreate((v) => !v); setShowInvite(false); setCreateError(''); }}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
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
                {['user', 'accountant', 'admin', 'partner', 'developer'].map((r) => (
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
          <div className="grid grid-cols-2 gap-3">
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
        <table className="w-full text-sm">
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
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map((u) => (
              <Fragment key={u.id}>
                <tr className="hover:bg-gray-50">
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
                    <select
                      value={u.role}
                      onChange={(e) => patchMutation.mutate({ id: u.id, role: e.target.value })}
                      disabled={u.id === currentUser?.id || patchMutation.isPending}
                      title={u.id === currentUser?.id ? 'You cannot change your own role' : ''}
                      className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm capitalize text-gray-700 focus:border-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:appearance-none disabled:border-transparent disabled:bg-transparent"
                    >
                      {['user', 'accountant', 'admin', 'partner', 'developer'].map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                    <span
                      className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500"
                      title="How this user can sign in"
                    >
                      {u.hasSso && u.hasPassword ? 'SSO + Local' : u.hasSso ? 'SSO-only' : u.hasPassword ? 'Local' : 'Invited'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${u.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                      {u.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600" title={u.lastLoginAt ?? undefined}>
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => setEditingId((id) => (id === u.id ? null : u.id))}
                        className="rounded border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
                      >
                        {editingId === u.id ? 'Close' : 'Edit profile'}
                      </button>
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
                      {!u.hasPassword && !u.hasSso && (
                        <button
                          onClick={() => resendMutation.mutate(u.id)}
                          disabled={resendMutation.isPending}
                          className="rounded border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-40"
                        >
                          Resend invite
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
                          onClick={() => setDeleteTarget(u)}
                          disabled={deleteMutation.isPending}
                          className="rounded border border-red-300 bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {editingId === u.id && (
                  <tr className="bg-gray-50">
                    <td colSpan={7} className="px-5 py-4">
                      <UserProfileEditor
                        user={u}
                        allUsers={users}
                        onClose={() => setEditingId(null)}
                        onError={setActionError}
                      />
                    </td>
                  </tr>
                )}
                {inviteLinks[u.id] && (
                  <tr className="bg-yellow-50">
                    <td colSpan={7} className="px-5 py-3">
                      <InviteLinkPanel
                        title={`Fresh invitation link for ${u.name} — shown once:`}
                        url={inviteLinks[u.id]}
                        onDismiss={() => setInviteLinks((prev) => { const n = { ...prev }; delete n[u.id]; return n; })}
                      />
                    </td>
                  </tr>
                )}
                {tempPasswords[u.id] && (
                  <tr className="bg-yellow-50">
                    <td colSpan={7} className="px-5 py-3">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-xs font-semibold text-yellow-800">Temporary password for {u.name} — shown once:</p>
                          <code className="mt-1 block select-all rounded bg-yellow-100 px-2 py-1 font-mono text-sm text-yellow-900">
                            {tempPasswords[u.id]}
                          </code>
                          <p className="mt-1 text-xs text-yellow-700">Copy this now and share it securely. It will not be shown again.</p>
                        </div>
                        <button
                          onClick={() => setTempPasswords((prev) => { const n = { ...prev }; delete n[u.id]; return n; })}
                          className="shrink-0 text-xs text-yellow-700 underline hover:text-yellow-900"
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

function UserProfileEditor({ user, allUsers, onClose, onError }: {
  user: AdminUser;
  allUsers: AdminUser[];
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
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

  const saveMutation = useMutation({
    mutationFn: () => client.patch(`/admin/users/${user.id}`, {
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
      onError('');
      onClose();
    },
    onError: (err: any) => onError(err?.response?.data?.error?.message ?? 'Profile update failed'),
  });

  function set(key: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Org profile — {user.name}</h4>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Authentik username</label>
          <input
            value={form.ssoUsername}
            onChange={(e) => set('ssoUsername', e.target.value)}
            placeholder="e.g. jsmith"
            className={inputCls}
          />
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
      <div className="flex gap-2">
        <button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {saveMutation.isPending ? 'Saving…' : 'Save profile'}
        </button>
        <button
          onClick={onClose}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Categories ───────────────────────────────────────────────────────────────

interface AdminCategory extends CategoryTreeNode {
  description: string | null;
  isActive: boolean;
}

function CategoriesTab() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [newParent, setNewParent] = useState('');
  const [error, setError] = useState('');
  const { data: categories = [], isLoading } = useQuery<AdminCategory[]>({
    queryKey: ['admin-categories'],
    queryFn: () => client.get('/admin/categories').then((r) => r.data.categories),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-categories'] });
    qc.invalidateQueries({ queryKey: ['expense-categories'] });
  };
  const addMutation = useMutation({
    mutationFn: () => client.post('/admin/categories', { name, parentId: newParent || null }),
    onSuccess: () => { invalidate(); setName(''); setError(''); },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Could not add category'),
  });
  const patchMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; isActive?: boolean; parentId?: string | null }) =>
      client.patch(`/admin/categories/${id}`, body),
    onSuccess: () => { invalidate(); setError(''); },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Could not update category'),
  });

  const ordered = useMemo(() => flattenTree(categories), [categories]);
  const { rows, toggle, expandAll, collapseAll } = useCollapsibleTree(categories);
  // Valid parents for a node: everything except itself and its own descendants.
  const validParents = (id: string) => {
    const blocked = descendantIdSet(categories, id);
    return categories.filter((c) => !blocked.has(c.id));
  };

  if (isLoading) return <div className="text-sm text-gray-400">Loading…</div>;

  return (
    <div className="space-y-4">
      <ErrorPanel message={error} onDismiss={() => setError('')} />
      <div className="flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New category name"
          className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        />
        <select
          value={newParent}
          onChange={(e) => setNewParent(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        >
          <option value="">— top level —</option>
          {ordered.map(({ cat, depth }) => (
            <option key={cat.id} value={cat.id}>{' '.repeat(depth * 3)}{cat.name}</option>
          ))}
        </select>
        <button
          onClick={() => addMutation.mutate()}
          disabled={!name.trim()}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
        >
          Add
        </button>
      </div>
      <div className="flex items-center gap-3 text-xs">
        <button onClick={expandAll} className="text-brand-600 underline hover:text-brand-700">Expand all</button>
        <button onClick={collapseAll} className="text-brand-600 underline hover:text-brand-700">Collapse all</button>
      </div>
      <div className="rounded-xl border border-gray-200 bg-white">
        {rows.map(({ cat, depth, hasChildren, collapsed, descendantCount }) => (
          <div key={cat.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-5 py-3 last:border-0">
            <div className="flex items-center gap-1.5" style={{ paddingLeft: depth * 20 }}>
              {hasChildren ? (
                <button
                  onClick={() => toggle(cat.id)}
                  className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                  aria-label={collapsed ? `Expand ${cat.name}` : `Collapse ${cat.name}`}
                  aria-expanded={!collapsed}
                >
                  {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
              ) : (
                <span className="inline-block w-5" />
              )}
              <div>
                <p className="font-medium text-gray-900">
                  {cat.name}
                  {hasChildren && collapsed && (
                    <span className="ml-2 text-xs font-normal text-gray-400">{descendantCount}</span>
                  )}
                </p>
                {cat.description && <p className="text-xs text-gray-400">{cat.description}</p>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={cat.parentId ?? ''}
                onChange={(e) => patchMutation.mutate({ id: cat.id, parentId: e.target.value || null })}
                className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-600 focus:border-brand-500 focus:outline-none"
                title="Parent category"
              >
                <option value="">— top level —</option>
                {validParents(cat.id).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <button
                onClick={() => patchMutation.mutate({ id: cat.id, isActive: !cat.isActive })}
                className={`rounded-full px-2.5 py-0.5 text-xs ${cat.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}
                title={cat.isActive ? 'Click to hide (hides whole subtree from pickers)' : 'Click to activate'}
              >
                {cat.isActive ? 'Active' : 'Hidden'}
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-400">
        Hiding a category hides its whole subtree from pickers. Existing expenses keep their category either way.
      </p>
    </div>
  );
}

// ── Audit Log ────────────────────────────────────────────────────────────────

interface AuditEntry {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  before: unknown;
  after: unknown;
  metadata: unknown;
  createdAt: string;
  actorId: string | null;
  actorName: string | null;
}

const AUDIT_PAGE_SIZE = 50;

function AuditTab() {
  const [filters, setFilters] = useState({ entityType: '', action: '', from: '', to: '', search: '' });
  const [page, setPage] = useState(1);
  const [seenEntityTypes, setSeenEntityTypes] = useState<string[]>([]);

  const params: Record<string, string | number> = { page, pageSize: AUDIT_PAGE_SIZE };
  for (const [k, v] of Object.entries(filters)) {
    if (v.trim()) params[k] = v.trim();
  }

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-audit', params],
    queryFn: () => client
      .get<{ entries: AuditEntry[]; total: number; page: number; pageSize: number }>('/admin/audit', { params })
      .then((r) => {
        setSeenEntityTypes((prev) => Array.from(new Set([...prev, ...r.data.entries.map((e) => e.entityType)])).sort());
        return r.data;
      }),
    placeholderData: keepPreviousData,
  });

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));

  function setFilter(key: keyof typeof filters, value: string) {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        Immutable, append-only record of every significant action. Newest first.
      </p>

      {/* Filter bar */}
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:grid-cols-3 lg:grid-cols-5">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Entity type</label>
          <input
            list="audit-entity-types"
            value={filters.entityType}
            onChange={(e) => setFilter('entityType', e.target.value)}
            placeholder="e.g. user"
            className={inputCls}
          />
          <datalist id="audit-entity-types">
            {seenEntityTypes.map((t) => <option key={t} value={t} />)}
          </datalist>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Action prefix</label>
          <input
            value={filters.action}
            onChange={(e) => setFilter('action', e.target.value)}
            placeholder="e.g. admin.user"
            className={inputCls}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">From</label>
          <input type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">To</label>
          <input type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Search</label>
          <input
            value={filters.search}
            onChange={(e) => setFilter('search', e.target.value)}
            placeholder="action or entity type"
            className={inputCls}
          />
        </div>
      </div>

      {/* Results */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {isLoading ? (
          <div className="px-6 py-12 text-center text-sm text-gray-400">Loading…</div>
        ) : isError ? (
          <div className="px-6 py-12 text-center text-sm text-red-600">Could not load the audit log.</div>
        ) : entries.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-gray-400">No audit entries match these filters.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Actor</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Entity</th>
                <th className="px-4 py-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {entries.map((e) => (
                <tr key={e.id} className="align-top hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-3 text-gray-600">{new Date(e.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-3 text-gray-600">{e.actorName ?? <span className="text-gray-400">system</span>}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-800">{e.action}</td>
                  <td className="px-4 py-3 text-gray-600">
                    <span className="font-medium">{e.entityType}</span>
                    <span className="ml-1 font-mono text-xs text-gray-400" title={e.entityId}>
                      {e.entityId.length > 12 ? `${e.entityId.slice(0, 12)}…` : e.entityId}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {(e.before || e.after || e.metadata) ? (
                      <details>
                        <summary className="cursor-pointer select-none text-xs text-brand-700 hover:underline">View</summary>
                        <div className="mt-2 max-w-md space-y-2">
                          {e.before != null && <AuditJson label="Before" value={e.before} />}
                          {e.after != null && <AuditJson label="After" value={e.after} />}
                          {e.metadata != null && <AuditJson label="Metadata" value={e.metadata} />}
                        </div>
                      </details>
                    ) : (
                      <span className="text-xs text-gray-300">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm text-gray-600">
        <span>
          {total} entr{total === 1 ? 'y' : 'ies'}{total > 0 ? ` · page ${page} of ${lastPage}` : ''}
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            ← Prev
          </button>
          <button
            onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
            disabled={page >= lastPage}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}

function AuditJson({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      <pre className="mt-0.5 max-h-48 overflow-auto rounded bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-700">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

// ── Connections ──────────────────────────────────────────────────────────────

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
  const [error, setError] = useState('');
  const [vocabFor, setVocabFor] = useState<string | null>(null);
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
      setError('');
    },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Could not generate key'),
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: string; isActive?: boolean; permissions?: string[] }) =>
      client.patch(`/admin/connections/${id}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-connections'] }); setError(''); },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Update failed'),
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
      <ErrorPanel message={error} onDismiss={() => setError('')} />
      <div className="flex flex-wrap items-start gap-3">
        <input
          value={appName}
          onChange={(e) => setAppName(e.target.value)}
          placeholder="App name (e.g. trade_show)"
          className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
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
              <p className="break-all text-xs text-gray-400">
                {c.permissions?.length ? c.permissions.join(', ') : 'no scopes (all Ext calls denied)'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className={`rounded-full px-2.5 py-0.5 text-xs ${c.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                {c.isActive ? 'Active' : 'Revoked'}
              </span>
              <button
                type="button"
                onClick={() => setVocabFor(vocabFor === c.id ? null : c.id)}
                className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
              >
                Categories
              </button>
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

      {vocabFor && (
        <ConnectionCategories
          connectionId={vocabFor}
          appName={connections.find((c: { id: string; appName: string }) => c.id === vocabFor)?.appName ?? ''}
          onClose={() => setVocabFor(null)}
        />
      )}
    </div>
  );
}

/**
 * Which categories a consuming app sees from GET /ext/categories.
 * Selecting none means unrestricted — the app sees every active category.
 */
function ConnectionCategories({ connectionId, appName, onClose }: {
  connectionId: string;
  appName: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string> | null>(null);

  const { data: categories = [] } = useQuery<AdminCategory[]>({
    queryKey: ['admin-categories'],
    queryFn: () => client.get('/admin/categories').then((r) => r.data.categories),
  });
  const { data: vocab } = useQuery<{ categoryIds: string[]; unrestricted: boolean }>({
    queryKey: ['connection-categories', connectionId],
    queryFn: () => client.get(`/admin/connections/${connectionId}/categories`).then((r) => r.data),
  });

  useEffect(() => {
    if (vocab && selected === null) setSelected(new Set(vocab.categoryIds));
  }, [vocab, selected]);

  const saveMutation = useMutation({
    mutationFn: () => client.put(`/admin/connections/${connectionId}/categories`, {
      categoryIds: [...(selected ?? [])],
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connection-categories', connectionId] });
      setError('');
      onClose();
    },
    onError: (err: any) => setError(err?.response?.data?.error?.message ?? 'Could not save'),
  });

  const ordered = useMemo(() => flattenTree(categories), [categories]);
  const chosen = selected ?? new Set<string>();

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="font-medium text-gray-900">Categories visible to {appName}</h3>
          <p className="mt-0.5 text-xs text-gray-500">
            {chosen.size === 0
              ? 'None selected — this app sees every active category.'
              : `${chosen.size} selected — this app sees only these.`}
          </p>
        </div>
        <button onClick={onClose} className="text-xs text-gray-400 underline hover:text-gray-600">Close</button>
      </div>

      <ErrorPanel message={error} onDismiss={() => setError('')} />

      <div className="max-h-80 overflow-y-auto rounded-lg border border-gray-100">
        {ordered.map(({ cat, depth }) => (
          <label
            key={cat.id}
            className="flex cursor-pointer items-center gap-2 border-b border-gray-50 px-3 py-1.5 text-sm last:border-0 hover:bg-gray-50"
            style={{ paddingLeft: 12 + depth * 18 }}
          >
            <input
              type="checkbox"
              checked={chosen.has(cat.id)}
              onChange={() => toggle(cat.id)}
              className="h-3.5 w-3.5"
            />
            <span className={cat.isActive ? 'text-gray-800' : 'text-gray-400 line-through'}>{cat.name}</span>
          </label>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
        >
          Save
        </button>
        <button
          onClick={() => setSelected(new Set())}
          className="text-xs text-gray-500 underline hover:text-gray-700"
        >
          Clear all (unrestricted)
        </button>
      </div>
    </div>
  );
}
