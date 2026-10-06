import { describe, it, expect } from 'vitest';
import { shouldPromptForPush, PUSH_PROMPT_SNOOZE_MS } from './pushPrompt';

const now = 1_800_000_000_000;

describe('shouldPromptForPush', () => {
  it('prompts an installed app that can enable push and has not', () => {
    expect(shouldPromptForPush({ standalone: true, state: 'ready', dismissedAt: null, now })).toBe(true);
  });

  it('stays quiet in a browser tab — the bell and dashboard cover that case', () => {
    expect(shouldPromptForPush({ standalone: false, state: 'ready', dismissedAt: null, now })).toBe(false);
  });

  it('stays quiet once push is on', () => {
    expect(shouldPromptForPush({ standalone: true, state: 'subscribed', dismissedAt: null, now })).toBe(false);
  });

  it('stays quiet when push cannot be enabled from here', () => {
    for (const state of ['unsupported', 'unavailable', 'denied'] as const) {
      expect(shouldPromptForPush({ standalone: true, state, dismissedAt: null, now })).toBe(false);
    }
  });

  it('stays quiet while the push state is still loading', () => {
    expect(shouldPromptForPush({ standalone: true, state: undefined, dismissedAt: null, now })).toBe(false);
  });

  it('respects a recent "not now"', () => {
    expect(shouldPromptForPush({ standalone: true, state: 'ready', dismissedAt: now - 1000, now })).toBe(false);
  });

  it('asks again once the snooze has run out', () => {
    expect(shouldPromptForPush({
      standalone: true, state: 'ready', dismissedAt: now - PUSH_PROMPT_SNOOZE_MS - 1, now,
    })).toBe(true);
  });
});
