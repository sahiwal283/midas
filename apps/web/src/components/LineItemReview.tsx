import { SearchableSelect } from './SearchableSelect';
import type { LineDraft } from '../lib/ocrLineItems';

/** Below this, OCR read the line poorly enough that a human should look. */
export const LOW_CONFIDENCE = 0.7;

export interface LineItemOption {
  value: string;
  label: string;
  hint?: string;
  /** Catalogue unit, copied into a line that has none when the item is picked. */
  unit?: string | null;
}

export interface LineItemReviewProps {
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  itemOptions: LineItemOption[];
  itemsLoading: boolean;
}

function recalc(line: LineDraft): LineDraft {
  const qty = Number(line.quantity) || 0;
  const price = Number(line.unitPrice) || 0;
  const tax = Number(line.tax) || 0;
  return { ...line, total: (qty * price + tax).toFixed(2) };
}

/**
 * One editor for PO line items, rendering as cards on phones and a table from
 * `md` up. Both layouts write through the same `onChange`, so a line edited on a
 * phone and the same line edited on a desktop go through identical code.
 */
export function LineItemReview({ lines, onChange, itemOptions, itemsLoading }: LineItemReviewProps) {
  function update(idx: number, patch: Partial<LineDraft>, recompute = false) {
    const next = [...lines];
    const merged = { ...next[idx], ...patch };
    next[idx] = recompute ? recalc(merged) : merged;
    onChange(next);
  }

  // Picking from the catalogue seeds an empty description and unit from the
  // item itself — a line with no description is dropped on save, so leaving it
  // blank after an explicit pick would silently lose the line.
  function pickItem(idx: number, itemId: string) {
    const line = lines[idx];
    const option = itemOptions.find((o) => o.value === itemId);
    update(idx, {
      zohoItemId: itemId,
      // The score described the OCR guess, not this deliberate choice.
      matchScore: null,
      description: line.description || option?.label || '',
      unit: line.unit || option?.unit || '',
    });
  }

  function remove(idx: number) {
    onChange(lines.filter((_, i) => i !== idx));
  }

  const numericProps = { inputMode: 'decimal' as const };

  return (
    <>
      {/* Mobile: stacked cards */}
      <div className="md:hidden space-y-3 mb-4">
        {lines.map((line, idx) => {
          const lowConf = line.ocrConfidence != null && line.ocrConfidence < LOW_CONFIDENCE;
          return (
            <div key={line.lineNumber} className="rounded-lg border border-brand-100 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-charcoal/60">
                  Line {idx + 1}
                  {lowConf && (
                    <span className="ml-2 normal-case text-amber-700">
                      verify ({Math.round(line.ocrConfidence! * 100)}%)
                    </span>
                  )}
                </span>
                {lines.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove line ${idx + 1}`}
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded text-xs text-danger"
                    onClick={() => remove(idx)}
                  >
                    ✕ Remove
                  </button>
                )}
              </div>
              <label className="block text-sm">
                <span className="text-charcoal/80">
                  Zoho item {!line.zohoItemId && <span className="text-amber-700">— pick an item</span>}
                  {line.zohoItemId && line.matchScore != null && (
                    <span className="text-charcoal/50"> — matched {Math.round(line.matchScore * 100)}%</span>
                  )}
                </span>
                <SearchableSelect
                  className="mt-1"
                  disabled={itemsLoading}
                  placeholder="Search item…"
                  value={line.zohoItemId}
                  onChange={(id) => pickItem(idx, id)}
                  options={itemOptions}
                />
              </label>
              <label className="block text-sm">
                <span className="text-charcoal/80">Description</span>
                <input
                  className="mt-1 w-full rounded border border-brand-200 px-3 py-3"
                  value={line.description}
                  onChange={(e) => update(idx, { description: e.target.value })}
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm">
                  <span className="text-charcoal/80">Qty</span>
                  <input
                    {...numericProps}
                    className="mt-1 w-full rounded border border-brand-200 px-3 py-3"
                    value={line.quantity}
                    onChange={(e) => update(idx, { quantity: e.target.value }, true)}
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-charcoal/80">Unit</span>
                  <input
                    className="mt-1 w-full rounded border border-brand-200 px-3 py-3"
                    value={line.unit}
                    onChange={(e) => update(idx, { unit: e.target.value })}
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-charcoal/80">Price</span>
                  <input
                    {...numericProps}
                    className="mt-1 w-full rounded border border-brand-200 px-3 py-3"
                    value={line.unitPrice}
                    onChange={(e) => update(idx, { unitPrice: e.target.value }, true)}
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-charcoal/80">Tax</span>
                  <input
                    {...numericProps}
                    className="mt-1 w-full rounded border border-brand-200 px-3 py-3"
                    value={line.tax}
                    onChange={(e) => update(idx, { tax: e.target.value }, true)}
                  />
                </label>
              </div>
              <div className="flex items-center justify-between border-t border-brand-100 pt-2 text-sm">
                <span className="text-charcoal/60">Amount</span>
                <span className="font-mono text-xs">{line.total}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Desktop: editable table */}
      <div className="hidden md:block overflow-x-auto border border-brand-100 rounded-lg mb-4">
        <table className="min-w-full text-sm">
          <thead className="bg-brand-50/60 text-left">
            <tr>
              <th className="px-2 py-2">Zoho item</th>
              <th className="px-2 py-2">Description</th>
              <th className="px-2 py-2 w-20">Qty</th>
              <th className="px-2 py-2 w-24">Unit</th>
              <th className="px-2 py-2 w-24">Price</th>
              <th className="px-2 py-2 w-20">Tax</th>
              <th className="px-2 py-2 w-24">Total</th>
              <th className="px-2 py-2 w-10" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, idx) => {
              const lowConf = line.ocrConfidence != null && line.ocrConfidence < LOW_CONFIDENCE;
              return (
                <tr key={line.lineNumber} className="border-t border-brand-100">
                  <td className="px-2 py-1 min-w-[12rem]">
                    <SearchableSelect
                      disabled={itemsLoading}
                      placeholder={line.zohoItemId ? 'Search item…' : 'Pick an item…'}
                      value={line.zohoItemId}
                      onChange={(id) => pickItem(idx, id)}
                      options={itemOptions}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      className="w-full rounded border border-brand-200 px-2 py-1"
                      value={line.description}
                      onChange={(e) => update(idx, { description: e.target.value })}
                    />
                    {lowConf && (
                      <span className="text-[11px] text-amber-700">
                        verify ({Math.round(line.ocrConfidence! * 100)}%)
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1">
                    <input
                      {...numericProps}
                      className="w-full rounded border border-brand-200 px-2 py-1"
                      value={line.quantity}
                      onChange={(e) => update(idx, { quantity: e.target.value }, true)}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      className="w-full rounded border border-brand-200 px-2 py-1"
                      value={line.unit}
                      onChange={(e) => update(idx, { unit: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      {...numericProps}
                      className="w-full rounded border border-brand-200 px-2 py-1"
                      value={line.unitPrice}
                      onChange={(e) => update(idx, { unitPrice: e.target.value }, true)}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      {...numericProps}
                      className="w-full rounded border border-brand-200 px-2 py-1"
                      value={line.tax}
                      onChange={(e) => update(idx, { tax: e.target.value }, true)}
                    />
                  </td>
                  <td className="px-2 py-1 font-mono text-xs">{line.total}</td>
                  <td className="px-2 py-1">
                    {lines.length > 1 && (
                      <button type="button" className="text-danger text-xs" onClick={() => remove(idx)}>✕</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
