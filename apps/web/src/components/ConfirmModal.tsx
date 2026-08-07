import { ReactNode } from 'react';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  /** Body content — plain text or richer markup (counts lists, warnings…). */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive (red). */
  danger?: boolean;
  /** Disables all actions and shows a busy label on confirm. */
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional second action, e.g. "Delete permanently" beside "Deactivate instead". */
  secondaryLabel?: string;
  secondaryDanger?: boolean;
  onSecondary?: () => void;
}

/** Shared confirmation dialog — replaces window.confirm()/alert() flows. */
export function ConfirmModal({
  open,
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
  secondaryLabel,
  secondaryDanger = false,
  onSecondary,
}: ConfirmModalProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => { if (!loading) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        {children && <div className="mt-2 text-sm text-gray-600">{children}</div>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            {cancelLabel}
          </button>
          {secondaryLabel && onSecondary && (
            <button
              type="button"
              onClick={onSecondary}
              disabled={loading}
              className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60 ${
                secondaryDanger
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'border border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              {secondaryLabel}
            </button>
          )}
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={`rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 ${
              danger ? 'bg-red-600 hover:bg-red-700' : 'bg-brand-600 hover:bg-brand-700'
            }`}
          >
            {loading ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
