/**
 * @-mentions in an expense conversation.
 *
 * A mention is `@username`. Nothing is stored: the API derives who to notify
 * from the message body when it is posted, and the web app derives what to
 * highlight when it is rendered. Both go through this file so they cannot
 * disagree about what counts as a mention.
 *
 * A handle only counts when it resolves to one of the candidates the caller
 * supplies — the people who can actually open the thread.
 */

export interface MentionCandidate {
  username: string;
}

export type MentionSegment<T extends MentionCandidate> =
  | { type: 'text'; text: string }
  | { type: 'mention'; text: string; user: T };

/**
 * `@` followed by username characters (see usernameSchema in the API's
 * routes/admin.ts). The leading group keeps `billing@digi.com` from
 * mentioning digi — spelled as a capture rather than a lookbehind, which
 * older iOS Safari refuses to parse.
 */
const MENTION_RE = /(^|[^a-z0-9._@-])@([a-z0-9._-]+)/gi;

/** Username characters that are far more often sentence punctuation at the end of a handle. */
const TRAILING_PUNCTUATION = /[._-]$/;

/** The body cut into plain text and resolved mentions, losing no characters. */
export function splitMentions<T extends MentionCandidate>(
  body: string,
  candidates: T[],
): MentionSegment<T>[] {
  const byUsername = new Map(candidates.map((c) => [c.username.toLowerCase(), c]));
  const segments: MentionSegment<T>[] = [];
  let textStart = 0;

  for (const match of body.matchAll(MENTION_RE)) {
    // "@digi." — the full stop ends the sentence, it is not part of the name.
    let handle = match[2].toLowerCase();
    while (!byUsername.has(handle) && TRAILING_PUNCTUATION.test(handle)) {
      handle = handle.slice(0, -1);
    }
    const user = byUsername.get(handle);
    if (!user) continue;

    const at = match.index + match[1].length;
    const end = at + 1 + handle.length;
    if (at > textStart) segments.push({ type: 'text', text: body.slice(textStart, at) });
    segments.push({ type: 'mention', text: body.slice(at, end), user });
    textStart = end;
  }

  if (textStart < body.length) segments.push({ type: 'text', text: body.slice(textStart) });
  return segments;
}

/** Everyone the body mentions — each once, in order of first appearance. */
export function resolveMentions<T extends MentionCandidate>(body: string, candidates: T[]): T[] {
  const seen = new Set<T>();
  for (const segment of splitMentions(body, candidates)) {
    if (segment.type === 'mention') seen.add(segment.user);
  }
  return [...seen];
}

export interface MentionQuery {
  /** Index of the `@` in the composer value. */
  start: number;
  /** What has been typed after it so far. */
  query: string;
}

const ACTIVE_QUERY_RE = /(^|[^a-z0-9._@-])@([a-z0-9._-]*)$/i;

/** The mention being typed at the caret, or null when the picker should be closed. */
export function activeMentionQuery(value: string, caret: number): MentionQuery | null {
  const match = ACTIVE_QUERY_RE.exec(value.slice(0, caret));
  if (!match) return null;
  return { start: match.index + match[1].length, query: match[2] };
}

/** Swap the partial handle for the chosen username; caret lands after a space. */
export function insertMention(
  value: string,
  query: MentionQuery,
  username: string,
): { value: string; caret: number } {
  const before = `${value.slice(0, query.start)}@${username} `;
  const after = value.slice(query.start + 1 + query.query.length).replace(/^ /, '');
  return { value: before + after, caret: before.length };
}
