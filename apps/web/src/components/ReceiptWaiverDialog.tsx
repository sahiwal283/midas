import { useState } from 'react';
import { MAX_WAIVER_REASON } from '@midas/shared';
import { Modal } from './Modal';

export interface ReceiptWaiverDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  /** Shown as the subtitle so the accountant can see what they are waiving. */
  subtitle: string;
  pending: boolean;
  error?: string | null;
}

/**
 * Asks why an expense is being pushed with no receipt.
 *
 * The copy states that the note reaches Zoho, because an accountant writing an
 * internal aside would word it differently from one writing into the
 * accounting record.
 */
export function ReceiptWaiverDialog({
  open, onClose, onConfirm, subtitle, pending, error,
}: ReceiptWaiverDialogProps) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const tooLong = trimmed.length > MAX_WAIVER_REASON;
  const canConfirm = trimmed.length > 0 && !tooLong && !pending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={pending}
      dismissOnBackdrop={false}
      title="Push without a receipt"
      subtitle={subtitle}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="min-h-11 rounded-lg border border-ink/15 px-4 py-2 text-sm font-medium text-ink disabled:opacity-50 lg:min-h-0"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(trimmed)}
            disabled={!canConfirm}
            className="min-h-11 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-cream hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0"
          >
            {pending ? 'Pushing…' : 'Push to Zoho'}
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm text-charcoal/70">
        This expense has no receipt. Explain why it is being pushed anyway — your
        note goes to Zoho and stays on the Midas record.
      </p>
      <label className="block text-sm">
        <span className="flex items-center justify-between">
          <span className="text-charcoal/80">Reason (required)</span>
          <span className={`text-xs ${tooLong ? 'text-danger' : 'text-charcoal/50'}`}>
            {trimmed.length}/{MAX_WAIVER_REASON}
          </span>
        </span>
        <textarea
          autoFocus
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          placeholder="e.g. submitter lost the receipt; charge verified against the card statement"
        />
      </label>
      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}
