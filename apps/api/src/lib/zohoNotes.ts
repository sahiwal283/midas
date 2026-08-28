/**
 * The note Midas writes onto a Zoho Books record.
 *
 * Zoho keeps the accounting facts but none of the provenance: who submitted a
 * receipt, which event it belongs to, whether it arrived through the browser
 * extension or Argo, and who pushed it. All of that already travels in the
 * payload's nested `source` object, which is stripped before the wire because
 * Zoho treats unknown keys as Books fields and rejects them. This folds it into
 * the one free-text field Zoho does store.
 *
 * Deliberately imports nothing (no db, no env) so it stays unit-testable —
 * same reason lib/zohoErrors and lib/categoryAccountPick are standalone.
 */

/**
 * Zoho Books' documented ceiling for these free-text fields. Overshooting it
 * earns a Zoho 1002 rejection, which reaches the accountant as an opaque
 * "sync failed", so the builder never emits more than this.
 */
export const ZOHO_NOTE_MAX = 500;

/** Shown for a core field with no value, so the block keeps one shape. */
const ABSENT = '—';

const ORIGIN_NAMES: Record<string, string> = {
  // The payload defaults source.app to 'midas' where the column is null.
  midas: 'Midas',
  browser_extension: 'Midas Extension',
  trade_show: 'Argo (Trade Show)',
};

/** An unmapped source app is passed through: better an odd name than a hidden one. */
function originName(sourceApp: string | null | undefined): string {
  if (!sourceApp) return 'Midas';
  return ORIGIN_NAMES[sourceApp] ?? sourceApp;
}

function actorLine(name: string | null | undefined, on: string | null | undefined): string {
  if (!name) return ABSENT;
  return on ? `${name} on ${on}` : name;
}

export interface ZohoNoteInput {
  /** The human sentence — "merchant — description". Null when there is none. */
  headline: string | null;
  /** Event this belongs to (expenses.source_label). */
  event: string | null;
  submittedBy: string | null;
  submittedOn: string | null;
  pushedBy: string | null;
  pushedOn: string | null;
  /** Raw source_app; mapped to a name an accountant recognises. */
  origin: string | null;
  /** Deep link back into Midas, or null when no web base url is configured. */
  midasUrl: string | null;
  /** Record id, used as the fallback when there is no link. */
  midasId: string;
  /** Page a browser-extension capture came from. Omitted when absent. */
  sourceUrl?: string | null;
  maxLength?: number;
}

/**
 * Composes the note. The provenance block is the part that exists *only* in
 * Zoho, so when the result has to be shortened the human line gives way first
 * — that prose is still on the expense in Midas.
 */
export function buildZohoNote(input: ZohoNoteInput): string {
  const max = input.maxLength ?? ZOHO_NOTE_MAX;

  const lines = [
    `Event: ${input.event || ABSENT}`,
    `Submitted by: ${actorLine(input.submittedBy, input.submittedOn)}`,
    `Pushed by: ${actorLine(input.pushedBy, input.pushedOn)}`,
    `Origin: ${originName(input.origin)}`,
    `Midas: ${input.midasUrl || input.midasId}`,
  ];
  if (input.sourceUrl) lines.push(`Source: ${input.sourceUrl}`);

  const block = lines.join('\n').slice(0, max);

  const headline = input.headline?.trim();
  if (!headline) return block;

  // Two newlines separate the sentence from the block.
  const budget = max - block.length - 2;
  if (budget <= 0) return block;
  const head = headline.length > budget ? `${headline.slice(0, Math.max(0, budget - 1))}…` : headline;
  return `${head}\n\n${block}`;
}
