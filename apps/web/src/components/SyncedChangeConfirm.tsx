interface Props {
  fieldLabel: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Confirm Midas-only edits on an expense that already exists in Zoho Books. */
export function SyncedChangeConfirm({ fieldLabel, pending, onCancel, onConfirm }: Props) {
  return (
    <div
      role="alertdialog"
      aria-labelledby="synced-change-title"
      aria-describedby="synced-change-desc"
      className="rounded-lg border border-amber-300 bg-amber-50 p-3"
    >
      <p id="synced-change-title" className="text-sm font-semibold text-amber-950">
        Already in Zoho Books
      </p>
      <p id="synced-change-desc" className="mt-1 text-xs leading-5 text-amber-900">
        Changing {fieldLabel} updates Midas only. The Zoho record is not changed.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="min-h-11 cursor-pointer rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-charcoal/80 hover:bg-ink/[0.03] disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className="min-h-11 cursor-pointer rounded-lg bg-amber-800 px-3 py-2 text-sm font-semibold text-cream hover:bg-amber-900 disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0"
        >
          {pending ? 'Saving…' : 'Update Midas only'}
        </button>
      </div>
    </div>
  );
}
