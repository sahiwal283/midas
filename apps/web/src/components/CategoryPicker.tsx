import { useMemo } from 'react';
import { flattenTree, pathFromRoot, type CategoryTreeNode } from '../lib/categoryTree';
import { SearchableSelect, type SearchableOption } from './SearchableSelect';

interface Props {
  categories: CategoryTreeNode[];
  /** Selected category id, '' for none. */
  value: string;
  onChange: (id: string) => void;
}

/**
 * Type-to-search category picker: one flat list in tree order where nested
 * categories show their full path ("Show Operations › Parking Fees"), so a
 * search for "parking" finds them without walking the hierarchy.
 */
export function CategoryPicker({ categories, value, onChange }: Props) {
  const options = useMemo<SearchableOption[]>(() => {
    const byId = new Map(categories.map((c) => [c.id, c]));
    return flattenTree(categories).map(({ cat }) => {
      const path = pathFromRoot(categories, cat.id).map((id) => byId.get(id)!.name);
      return {
        value: cat.id,
        label: cat.name,
        hint: path.length > 1 ? path.slice(0, -1).join(' › ') : undefined,
      };
    });
  }, [categories]);

  return (
    <SearchableSelect
      options={options}
      value={value}
      onChange={onChange}
      placeholder="Search categories…"
    />
  );
}
