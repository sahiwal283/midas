import type { PushState } from './push';

/**
 * When to put "turn on notifications" in front of someone unprompted.
 *
 * Only an installed app gets the banner: installing Midas to the home screen
 * is the signal that this person wants it to behave like an app, and on iOS it
 * is also the only place web push works at all. The browser cannot grant the
 * permission without a tap, so the banner is as automatic as this gets. In a
 * plain tab the bell and the dashboard carry notifications instead, and the
 * bell keeps its own opt-in for anyone who wants push there too.
 */

/** How long "Not now" keeps the banner away. */
export const PUSH_PROMPT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

const DISMISSED_KEY = 'midas.pushPromptDismissedAt';

export function shouldPromptForPush(input: {
  standalone: boolean;
  state: PushState | undefined;
  dismissedAt: number | null;
  now: number;
}): boolean {
  if (!input.standalone || input.state !== 'ready') return false;
  return input.dismissedAt === null || input.now - input.dismissedAt > PUSH_PROMPT_SNOOZE_MS;
}

/** True when running as an installed PWA rather than in a browser tab. */
export function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches
    // iOS Safari predates the media query and still reports it this way.
    || (navigator as { standalone?: boolean }).standalone === true;
}

export function readPushPromptDismissedAt(): number | null {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const at = raw ? Number(raw) : NaN;
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

export function dismissPushPrompt(now: number): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, String(now));
  } catch {
    // Private mode / blocked storage: the banner just comes back next visit.
  }
}
