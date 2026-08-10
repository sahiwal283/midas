import { useMemo, useState } from 'react';
import { flattenTree, type CategoryTreeNode } from './categoryTree';

export interface VisibleRow<T> {
  cat: T;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  /** Total descendants, shown as a count on a collapsed parent. */
  descendantCount: number;
}

/**
 * Collapsible rendering for a category tree. Every parent starts collapsed, so
 * the initial view is just the top-level categories.
 */
export function useCollapsibleTree<T extends CategoryTreeNode>(cats: T[]) {
  // Ids explicitly expanded by the user; everything else stays collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const ordered = useMemo(() => flattenTree(cats), [cats]);

  const childCount = useMemo(() => {
    const direct = new Map<string, number>();
    for (const c of cats) {
      if (!c.parentId) continue;
      direct.set(c.parentId, (direct.get(c.parentId) ?? 0) + 1);
    }
    return direct;
  }, [cats]);

  const descendantCount = useMemo(() => {
    const counts = new Map<string, number>();
    // Walk deepest-first so children are counted before their parent.
    for (const { cat } of [...ordered].reverse()) {
      const own = (childCount.get(cat.id) ?? 0);
      let total = own;
      for (const c of cats) {
        if (c.parentId === cat.id) total += counts.get(c.id) ?? 0;
      }
      counts.set(cat.id, total);
    }
    return counts;
  }, [ordered, cats, childCount]);

  const rows = useMemo<VisibleRow<T>[]>(() => {
    const byId = new Map(cats.map((c) => [c.id, c]));
    const isVisible = (cat: T) => {
      // Visible when every ancestor is expanded.
      let parent = cat.parentId ? byId.get(cat.parentId) : null;
      let hops = 0;
      while (parent && hops++ < cats.length) {
        if (!expanded.has(parent.id)) return false;
        parent = parent.parentId ? byId.get(parent.parentId) ?? null : null;
      }
      return true;
    };
    return ordered
      .filter(({ cat }) => isVisible(cat))
      .map(({ cat, depth }) => ({
        cat,
        depth,
        hasChildren: (childCount.get(cat.id) ?? 0) > 0,
        collapsed: !expanded.has(cat.id),
        descendantCount: descendantCount.get(cat.id) ?? 0,
      }));
  }, [ordered, cats, expanded, childCount, descendantCount]);

  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const expandAll = () => setExpanded(new Set(cats.map((c) => c.id)));
  const collapseAll = () => setExpanded(new Set());
  /** Expand every ancestor of `id` so a deep row becomes visible. */
  const revealPathTo = (id: string) => setExpanded((prev) => {
    const byId = new Map(cats.map((c) => [c.id, c]));
    const next = new Set(prev);
    let parentId = byId.get(id)?.parentId ?? null;
    let hops = 0;
    while (parentId && hops++ < cats.length) {
      next.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return next;
  });

  return { rows, toggle, expandAll, collapseAll, revealPathTo, allOrdered: ordered };
}
