import { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';

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
  return (
    <Modal
      open={open}
      onClose={onCancel}
      size="sm"
      title={title}
      busy={loading}
      // A confirmation is a deliberate choice; a stray backdrop click
      // shouldn't silently answer it. Escape and Cancel still dismiss.
      dismissOnBackdrop={false}
      icon={
        danger ? <AlertTriangle className="h-5 w-5 shrink-0 text-danger" aria-hidden="true" /> : undefined
      }
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="btn-secondary"
          >
            {cancelLabel}
          </button>
          {secondaryLabel && onSecondary && (
            <button
              type="button"
              onClick={onSecondary}
              disabled={loading}
              className={secondaryDanger ? 'btn-danger' : 'btn-secondary'}
            >
              {secondaryLabel}
            </button>
          )}
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={danger ? 'btn-danger' : 'btn-primary'}
          >
            {loading ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {children && <div className="text-sm leading-relaxed text-charcoal/75">{children}</div>}
    </Modal>
  );
}
