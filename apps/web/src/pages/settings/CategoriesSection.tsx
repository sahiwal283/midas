import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ChevronDown, Search } from 'lucide-react';
import client from '../../api/client';
import { ConfirmModal } from '../../components/ConfirmModal';
import { CategoryPicker } from '../../components/CategoryPicker';
import { flattenTree, descendantIdSet } from '../../lib/categoryTree';
import { useCollapsibleTree } from '../../lib/useCollapsibleTree';
import { matchingCategoryIdSet } from '@midas/shared';
import type { ExpenseCategory } from '../../types';

const searchCls = 'w-full rounded-lg border border-ink/15 bg-white py-2.5 pl-9 pr-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 lg:py-2';
const pickerInput = 'w-full rounded-lg border border-ink/15 px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none lg:py-2';

export function CategoriesSection() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [newParent, setNewParent] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ExpenseCategory | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const { data: categories = [], isLoading } = useQuery<ExpenseCategory[]>({
    queryKey: ['admin-categories'],
    queryFn: () => client.get('/admin/categories').then((r) => r.data.categories),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-categories'] });
    qc.invalidateQueries({ queryKey: ['expense-categories'] });
    qc.invalidateQueries({ queryKey: ['coa-mappings'] });
  };

  const addMutation = useMutation({
    mutationFn: () => client.post('/admin/categories', { name, parentId: newParent || null }),
    onSuccess: () => { invalidate(); setName(''); setNewParent(''); setError(''); },
    onError: (err: unknown) => setError(axiosMessage(err, 'Could not add category')),
  });
  const patchMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; isActive?: boolean; parentId?: string | null }) =>
      client.patch(`/admin/categories/${id}`, body),
    onSuccess: (_data, vars) => {
      invalidate();
      setError('');
      if (vars.name !== undefined) setEditingId(null);
    },
    onError: (err: unknown) => setError(axiosMessage(err, 'Could not update category')),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => client.delete(`/admin/categories/${id}`),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
      setError('');
    },
    onError: (err: unknown) => {
      setDeleteTarget(null);
      setError(axiosMessage(err, 'Could not delete category'));
    },
  });

  const hitIds = useMemo(() => matchingCategoryIdSet(categories, search), [categories, search]);
  const searching = search.trim().length > 0;
  const { rows: treeRows, toggle, expandAll, collapseAll } = useCollapsibleTree(categories);
  const searchRows = useMemo(() => (
    flattenTree(categories)
      .filter(({ cat }) => hitIds.has(cat.id))
      .map(({ cat, depth }) => ({
        cat,
        depth,
        hasChildren: categories.some((c) => c.parentId === cat.id && hitIds.has(c.id)),
        collapsed: false,
        descendantCount: 0,
      }))
  ), [categories, hitIds]);
  const rows = searching ? searchRows : treeRows;

  const validParents = (id: string) => {
    const blocked = descendantIdSet(categories, id);
    return categories.filter((c) => !blocked.has(c.id));
  };

  function startRename(cat: ExpenseCategory) {
    setEditingId(cat.id);
    setEditName(cat.name);
    setError('');
  }

  function commitRename(cat: ExpenseCategory) {
    if (editingId !== cat.id) return;
    const next = editName.trim();
    if (!next || next === cat.name) {
      setEditingId(null);
      return;
    }
    patchMutation.mutate({ id: cat.id, name: next });
  }

  if (isLoading) return <div className="text-sm text-charcoal/40">Loading…</div>;

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-start justify-between gap-4 rounded-lg border border-danger/25 bg-danger/10 px-4 py-3 text-sm text-danger">
          <span>{error}</span>
          <button onClick={() => setError('')} className="shrink-0 text-xs underline">Dismiss</button>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New category name"
          className="w-full rounded-lg border border-ink/15 px-3 py-2.5 text-sm focus:border-brand-500 focus:outline-none sm:w-64 lg:py-2"
        />
        <div className="w-full sm:w-72">
          <CategoryPicker
            categories={categories}
            value={newParent}
            onChange={setNewParent}
            emptyLabel="— top level —"
            placeholder="Parent category"
            inputClassName={pickerInput}
          />
        </div>
        <button
          onClick={() => addMutation.mutate()}
          disabled={!name.trim() || addMutation.isPending}
          className="min-h-11 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-cream hover:bg-brand-700 disabled:opacity-60 lg:min-h-0"
        >
          Add
        </button>
      </div>

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal/40" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search categories…"
          aria-label="Search categories"
          className={searchCls}
        />
      </div>

      {!searching && (
        <div className="flex items-center gap-3 text-xs">
          <button onClick={expandAll} className="inline-flex min-h-11 items-center text-brand-600 underline hover:text-brand-700 lg:min-h-0">Expand all</button>
          <button onClick={collapseAll} className="inline-flex min-h-11 items-center text-brand-600 underline hover:text-brand-700 lg:min-h-0">Collapse all</button>
        </div>
      )}

      <div className="rounded-xl border border-ink/10 bg-white">
        {rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted">
            {searching ? `No categories match “${search.trim()}”.` : 'No categories yet.'}
          </p>
        ) : rows.map(({ cat, depth, hasChildren, collapsed, descendantCount }) => (
          <div key={cat.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-ink/5 px-5 py-3 last:border-0">
            <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: depth * 20 }}>
              {hasChildren && !searching ? (
                <button
                  onClick={() => toggle(cat.id)}
                  className="rounded p-0.5 text-charcoal/40 hover:bg-brand-50 hover:text-charcoal/70"
                  aria-label={collapsed ? `Expand ${cat.name}` : `Collapse ${cat.name}`}
                  aria-expanded={!collapsed}
                >
                  {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
              ) : (
                <span className="inline-block w-5" />
              )}
              <div className="min-w-0">
                {editingId === cat.id ? (
                  <input
                    autoFocus
                    value={editName}
                    aria-label="Category name"
                    disabled={patchMutation.isPending}
                    className="w-full min-w-[12rem] rounded-lg border border-brand-500 px-2 py-1 text-sm font-medium text-ink focus:outline-none focus:ring-1 focus:ring-brand-500"
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename(cat); }
                      if (e.key === 'Escape') { e.preventDefault(); setEditingId(null); }
                    }}
                    onBlur={() => commitRename(cat)}
                  />
                ) : (
                  <p className="font-medium text-ink">
                    <button
                      type="button"
                      onClick={() => startRename(cat)}
                      className="rounded text-left hover:underline focus:outline-none focus:ring-1 focus:ring-brand-500"
                      title="Rename"
                    >
                      {cat.name}
                    </button>
                    {hasChildren && collapsed && !searching && (
                      <span className="ml-2 text-xs font-normal text-charcoal/40">{descendantCount}</span>
                    )}
                  </p>
                )}
                {cat.description && <p className="text-xs text-charcoal/40">{cat.description}</p>}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-52">
                <CategoryPicker
                  categories={validParents(cat.id)}
                  value={cat.parentId ?? ''}
                  onChange={(parentId) => patchMutation.mutate({ id: cat.id, parentId: parentId || null })}
                  emptyLabel="— top level —"
                  placeholder="Parent"
                  inputClassName="w-full rounded-lg border border-ink/10 px-2 py-1.5 text-xs text-charcoal/70 focus:border-brand-500 focus:outline-none"
                />
              </div>
              <button
                onClick={() => patchMutation.mutate({ id: cat.id, isActive: !cat.isActive })}
                className={`rounded-full px-2.5 py-0.5 text-xs ${cat.isActive ? 'bg-success/15 text-success' : 'bg-brand-50 text-muted'}`}
                title={cat.isActive ? 'Click to hide (hides whole subtree from pickers)' : 'Click to activate'}
              >
                {cat.isActive ? 'Active' : 'Hidden'}
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => (editingId === cat.id ? setEditingId(null) : startRename(cat))}
                className="text-xs font-medium text-brand-700 hover:underline"
              >
                {editingId === cat.id ? 'Cancel' : 'Rename'}
              </button>
              <button
                type="button"
                onClick={() => setDeleteTarget(cat)}
                className="text-xs text-charcoal/40 hover:text-danger"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-charcoal/40">
        Click a name or Rename to fix spelling. Enter saves, Escape cancels. Delete only works when
        nothing uses the category — otherwise hide it so pickers drop it and history keeps the name.
      </p>

      <ConfirmModal
        open={deleteTarget !== null}
        title={`Delete ${deleteTarget?.name}?`}
        confirmLabel="Delete"
        danger
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
      >
        <p>
          This removes the category from Midas. If expenses, child categories, or budgets still
          use it, the server will refuse and you can hide it instead.
        </p>
      </ConfirmModal>
    </div>
  );
}

function axiosMessage(err: unknown, fallback: string): string {
  const data = err && typeof err === 'object' && 'response' in err
    ? (err as { response?: { data?: { error?: { message?: string } } } }).response?.data
    : undefined;
  return data?.error?.message ?? fallback;
}
