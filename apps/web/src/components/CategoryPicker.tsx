import { useMemo } from 'react';
import { flattenTree, pathFromRoot, type CategoryTreeNode } from '../lib/categoryTree';
import { SearchableSelect, type SearchableOption } from './SearchableSelect';

interface Props {
  categories: CategoryTreeNode[];
  /** Selected category id, '' for none. */
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  /** Selectable row that maps to '' — use "All categories" on filters. */
  emptyLabel?: string;
  inputClassName?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
}

/**
 * Type-to-search category picker: one flat list in tree order where nested
 * categories show their full path ("Show Operations › Parking Fees"), so a
 * search for "parking" finds them without walking the hierarchy.
 */
export function CategoryPicker({
  categories,
  value,
  onChange,
  placeholder = 'Search categories…',
  emptyLabel,
  inputClassName,
  className,
  disabled,
  id,
}: Props) {
  const options = useMemo<SearchableOption[]>(() => {
    const byId = new Map(categories.map((c) => [c.id, c]));
    const rows: SearchableOption[] = flattenTree(categories).map(({ cat }) => {
      const path = pathFromRoot(categories, cat.id).map((nodeId) => byId.get(nodeId)!.name);
      return {
        value: cat.id,
        label: cat.name,
        hint: path.length > 1 ? path.slice(0, -1).join(' › ') : undefined,
      };
    });
    if (emptyLabel) rows.unshift({ value: '', label: emptyLabel });
    return rows;
  }, [categories, emptyLabel]);

  return (
    <SearchableSelect
      id={id}
      options={options}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      inputClassName={inputClassName}
      className={className}
      disabled={disabled}
      aria-label={placeholder}
    />
  );
}
