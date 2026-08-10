import { useMemo } from 'react';
import { buildChildrenMap, pathFromRoot, type CategoryTreeNode } from '../lib/categoryTree';

const selectCls = 'w-full rounded-lg border border-ink/15 bg-white px-3 py-3 lg:py-2 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

interface Props {
  categories: CategoryTreeNode[];
  /** Deepest selected category id, '' for none. */
  value: string;
  onChange: (id: string) => void;
}

/**
 * Cascading category picker: one select per tree level. Selecting a node with
 * children reveals an optional "refine" select below; any level is a valid
 * final answer (the deepest selection wins).
 */
export function CategoryPicker({ categories, value, onChange }: Props) {
  const children = useMemo(() => buildChildrenMap(categories), [categories]);
  const path = useMemo(() => (value ? pathFromRoot(categories, value) : []), [categories, value]);

  // Levels to render: root select, then one per selected node that has children.
  const levels: { parent: string | null; selected: string }[] = [{ parent: null, selected: path[0] ?? '' }];
  for (let i = 0; i < path.length; i++) {
    if ((children.get(path[i]) ?? []).length > 0) {
      levels.push({ parent: path[i], selected: path[i + 1] ?? '' });
    }
  }

  return (
    <div className="space-y-2">
      {levels.map((level, idx) => {
        const options = children.get(level.parent) ?? [];
        if (options.length === 0) return null;
        return (
          <select
            key={level.parent ?? 'root'}
            value={level.selected}
            onChange={(e) => {
              // Selecting sets the deepest choice; clearing falls back to this level's parent.
              onChange(e.target.value || level.parent || '');
            }}
            className={selectCls}
          >
            <option value="">{idx === 0 ? '— Select category —' : '— refine (optional) —'}</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        );
      })}
    </div>
  );
}
