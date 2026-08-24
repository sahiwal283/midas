import type { FormEvent } from 'react';
import { AlertCircle, Send } from 'lucide-react';
import { MESSAGE_MAX_LENGTH } from './MessageBubble';

/** Show the remaining-characters hint only once the cap is in sight. */
const COUNTER_VISIBLE_FROM = MESSAGE_MAX_LENGTH - 200;

/**
 * The send box for an expense conversation, shared by ExpenseDetail and
 * AccountantReview. Owns the length cap and the failure message so neither
 * page can silently drop a send the way both previously did.
 */
export function MessageComposer({
  value,
  onChange,
  onSubmit,
  pending,
  error,
  placeholder,
  highlight = false,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  pending: boolean;
  /** Server-supplied failure text; null when the last send was fine. */
  error?: string | null;
  placeholder: string;
  /** Amber treatment for an owner who owes the accountant an answer. */
  highlight?: boolean;
}) {
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim() || pending) return;
    onSubmit();
  }

  const remaining = MESSAGE_MAX_LENGTH - value.length;

  return (
    <form onSubmit={handleSubmit}>
      <div className="flex gap-2">
        <input
          value={value}
          maxLength={MESSAGE_MAX_LENGTH}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label="Message"
          aria-invalid={error ? true : undefined}
          className={`min-w-0 flex-1 rounded-lg border px-3 py-3 text-sm focus:outline-none lg:py-2 ${
            error
              ? 'border-danger/50 focus:border-danger'
              : highlight
              ? 'border-amber-300 bg-amber-50 focus:border-amber-500'
              : 'border-ink/15 focus:border-brand-500'
          }`}
        />
        <button
          type="submit"
          disabled={!value.trim() || pending}
          aria-label="Send message"
          className="min-h-11 min-w-11 rounded-lg bg-brand-600 px-3 py-2 text-cream hover:bg-brand-700 disabled:opacity-60 lg:min-h-0 lg:min-w-0"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
      {value.length >= COUNTER_VISIBLE_FROM && (
        <p className={`mt-1 text-right text-xs ${remaining === 0 ? 'text-danger' : 'text-charcoal/40'}`}>
          {remaining} character{remaining === 1 ? '' : 's'} left
        </p>
      )}
      {error && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </form>
  );
}
