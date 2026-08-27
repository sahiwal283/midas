import { ReactNode, useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

/**
 * Shared modal shell. Every dialog in the app should use this rather than
 * hand-rolling `fixed inset-0` — that drift is how we ended up with five
 * different paddings, one Escape handler between them, and no focus trap.
 *
 * Handles: body scroll lock, focus trap + restore, Escape, backdrop click,
 * mobile bottom-sheet layout, safe-area padding, entrance motion.
 * Reduced motion is covered globally by the media query in index.css.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// ── Body scroll lock (ref-counted so nested modals don't unlock early) ────────

let lockCount = 0;
let prevOverflow = '';
let prevPaddingRight = '';

function lockScroll() {
  if (lockCount === 0) {
    // Compensate for the vanishing scrollbar so the page behind doesn't jump.
    const gutter = window.innerWidth - document.documentElement.clientWidth;
    prevOverflow = document.body.style.overflow;
    prevPaddingRight = document.body.style.paddingRight;
    document.body.style.overflow = 'hidden';
    if (gutter > 0) document.body.style.paddingRight = `${gutter}px`;
  }
  lockCount += 1;
}

function unlockScroll() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    document.body.style.overflow = prevOverflow;
    document.body.style.paddingRight = prevPaddingRight;
  }
}

// ── Stack: only the topmost modal reacts to Escape ───────────────────────────

const stack: symbol[] = [];

const SIZES = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-3xl',
} as const;

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Secondary line under the title (merchant, email, event…). */
  subtitle?: ReactNode;
  /** Icon rendered before the title. */
  icon?: ReactNode;
  /** Extra nodes beside the title — badges, pills. */
  titleAdornment?: ReactNode;
  children: ReactNode;
  /** Sticky action bar. Omit for modals whose actions live in the body. */
  footer?: ReactNode;
  size?: keyof typeof SIZES;
  /** `navy` gives the branded dark header; `plain` a white one with a hairline. */
  tone?: 'navy' | 'plain';
  /** Blocks Escape, backdrop click and the X — use while a mutation is in flight. */
  busy?: boolean;
  /** Opt out of backdrop-click dismissal (deliberate-choice dialogs). */
  dismissOnBackdrop?: boolean;
  /** Hide the X. Escape and the backdrop still work unless also disabled. */
  hideClose?: boolean;
  /** Applied to the scrolling body — override the default padding if needed. */
  bodyClassName?: string;
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  icon,
  titleAdornment,
  children,
  footer,
  size = 'md',
  tone = 'plain',
  busy = false,
  dismissOnBackdrop = true,
  hideClose = false,
  bodyClassName = 'px-5 py-5 sm:px-6',
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const tokenRef = useRef<symbol>(Symbol('modal'));

  // Scroll lock + focus restore, tied to the open lifetime.
  useEffect(() => {
    if (!open) return;
    const token = tokenRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    stack.push(token);
    lockScroll();

    // Focus the panel itself rather than the first control: it announces the
    // dialog without arming a destructive button under the user's Enter key.
    panelRef.current?.focus({ preventScroll: true });

    return () => {
      unlockScroll();
      const i = stack.indexOf(token);
      if (i !== -1) stack.splice(i, 1);
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [open]);

  // Escape to close + Tab containment.
  useEffect(() => {
    if (!open) return;
    const token = tokenRef.current;

    function onKeyDown(e: KeyboardEvent) {
      if (stack[stack.length - 1] !== token) return;

      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;

      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, busy, onClose]);

  if (!open) return null;

  const navy = tone === 'navy';

  return (
    <div
      className="fixed inset-0 z-50 flex animate-overlay-in items-end justify-center bg-ink/50 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (busy || !dismissOnBackdrop) return;
        onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`flex max-h-[92dvh] w-full animate-sheet-in flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl shadow-ink/20 outline-none sm:max-h-[88dvh] sm:animate-modal-in sm:rounded-2xl ${SIZES[size]}`}
      >
        {/* Grab affordance — sheet on mobile only. Carries the header's own
            background, or it renders on white above a navy header and vanishes. */}
        <div
          className={`flex justify-center pt-2.5 sm:hidden ${navy ? 'bg-brand-800' : 'bg-white'}`}
          aria-hidden="true"
        >
          <span className={`h-1 w-9 rounded-full ${navy ? 'bg-white/30' : 'bg-ink/15'}`} />
        </div>

        <header
          className={`flex items-start justify-between gap-3 px-5 pb-4 pt-2.5 sm:px-6 sm:pt-5 ${
            navy
              ? 'border-b border-gold-400/50 bg-brand-800 text-cream'
              : 'border-b border-ink/10 bg-white'
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2
                id={titleId}
                className={`flex items-center gap-2 font-display text-lg font-semibold tracking-tight ${
                  navy ? 'text-cream' : 'text-ink'
                }`}
              >
                {icon}
                {title}
              </h2>
              {titleAdornment}
            </div>
            {subtitle && (
              <p className={`mt-1 truncate text-sm ${navy ? 'text-brand-200' : 'text-muted'}`}>
                {subtitle}
              </p>
            )}
          </div>
          {!hideClose && (
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              aria-label="Close"
              className={`-mr-1.5 -mt-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors duration-150 disabled:opacity-40 ${
                navy
                  ? 'text-cream/80 hover:bg-white/10 hover:text-cream focus-visible:ring-2 focus-visible:ring-gold-400'
                  : 'text-muted hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-2 focus-visible:ring-brand-500'
              } focus-visible:outline-none`}
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </header>

        <div className={`flex-1 overflow-y-auto overscroll-contain ${bodyClassName}`}>
          {children}
        </div>

        {footer && (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-ink/10 bg-cream px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
