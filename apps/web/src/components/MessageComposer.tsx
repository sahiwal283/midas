import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { AlertCircle, Send } from 'lucide-react';
import { activeMentionQuery, insertMention, type MentionQuery } from '@midas/shared';
import { MESSAGE_MAX_LENGTH } from './MessageBubble';
import { useAuth } from '../contexts/AuthContext';
import { filterMentionable, useMentionable, type MentionableUser } from '../lib/mentionPicker';

/** Show the remaining-characters hint only once the cap is in sight. */
const COUNTER_VISIBLE_FROM = MESSAGE_MAX_LENGTH - 200;

/**
 * The send box for an expense conversation, shared by ExpenseDetail and
 * AccountantReview. Owns the length cap and the failure message so neither
 * page can silently drop a send the way both previously did.
 *
 * Typing `@` opens a picker of the people who can see this thread; choosing
 * one inserts `@username`, and the API notifies them when the message posts.
 */
export function MessageComposer({
  expenseId,
  value,
  onChange,
  onSubmit,
  pending,
  error,
  placeholder,
  highlight = false,
}: {
  expenseId: string;
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
  const { user } = useAuth();
  const mentionable = useMentionable(expenseId);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  /** Where to put the caret once React has rendered an inserted mention. */
  const pendingCaret = useRef<number | null>(null);

  const options = mention ? filterMentionable(mentionable, mention.query, user?.id) : [];
  const pickerOpen = options.length > 0;
  const active = Math.min(activeIndex, options.length - 1);

  useEffect(() => {
    if (pendingCaret.current === null) return;
    inputRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [value]);

  /** Re-read the mention under the caret after any edit or caret move. */
  function syncMention(input: HTMLInputElement) {
    const next = activeMentionQuery(input.value, input.selectionStart ?? input.value.length);
    setMention(next);
    if (next?.query !== mention?.query) setActiveIndex(0);
  }

  function choose(picked: MentionableUser) {
    if (!mention) return;
    const next = insertMention(value, mention, picked.username);
    // The cap is enforced by maxLength on typing; an insert must respect it too.
    if (next.value.length > MESSAGE_MAX_LENGTH) return;
    pendingCaret.current = next.caret;
    onChange(next.value);
    setMention(null);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!pickerOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((active + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((active - 1 + options.length) % options.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      // Enter picks the person rather than sending a half-typed message.
      e.preventDefault();
      choose(options[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setMention(null);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim() || pending) return;
    onSubmit();
  }

  const remaining = MESSAGE_MAX_LENGTH - value.length;

  return (
    <form onSubmit={handleSubmit}>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          {pickerOpen && (
            <ul
              id={listId}
              role="listbox"
              aria-label="Mention someone"
              className="absolute bottom-full left-0 z-20 mb-1 max-h-64 w-full max-w-xs overflow-y-auto rounded-lg border border-ink/15 bg-white py-1 shadow-lg"
            >
              {options.map((option, i) => (
                <li
                  key={option.id}
                  id={`${listId}-${option.id}`}
                  role="option"
                  aria-selected={i === active}
                  // mousedown, not click: keep focus in the input so the caret survives.
                  onMouseDown={(e) => { e.preventDefault(); choose(option); }}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm lg:min-h-0 ${
                    i === active ? 'bg-brand-50' : ''
                  }`}
                >
                  <span className="min-w-0 truncate">
                    <span className="font-medium text-ink">{option.name}</span>
                    <span className="ml-1.5 text-muted">@{option.username}</span>
                  </span>
                  {option.role !== 'user' && (
                    <span className="shrink-0 text-xs capitalize text-charcoal/50">{option.role}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <input
            ref={inputRef}
            value={value}
            maxLength={MESSAGE_MAX_LENGTH}
            onChange={(e) => { onChange(e.target.value); syncMention(e.target); }}
            onSelect={(e) => syncMention(e.currentTarget)}
            onKeyDown={handleKeyDown}
            onBlur={() => setMention(null)}
            placeholder={placeholder}
            aria-label="Message"
            aria-invalid={error ? true : undefined}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={pickerOpen}
            aria-controls={pickerOpen ? listId : undefined}
            aria-activedescendant={pickerOpen ? `${listId}-${options[active].id}` : undefined}
            autoComplete="off"
            className={`w-full rounded-lg border px-3 py-3 text-sm focus:outline-none lg:py-2 ${
              error
                ? 'border-danger/50 focus:border-danger'
                : highlight
                ? 'border-amber-300 bg-amber-50 focus:border-amber-500'
                : 'border-ink/15 focus:border-brand-500'
            }`}
          />
        </div>
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
