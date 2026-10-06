import { describe, it, expect } from 'vitest';
import { activeMentionQuery, insertMention, resolveMentions, splitMentions } from './mentions';

const digi = { id: 'u-digi', username: 'digi' };
const seri = { id: 'u-seri', username: 'seri.k' };
const dash = { id: 'u-dash', username: 'a-b' };
const people = [digi, seri, dash];

describe('resolveMentions', () => {
  it('finds a mention at the start of a message', () => {
    expect(resolveMentions('@digi please map the category', people)).toEqual([digi]);
  });

  it('finds a mention mid-sentence', () => {
    expect(resolveMentions('over to @digi now', people)).toEqual([digi]);
  });

  it('ignores trailing punctuation', () => {
    expect(resolveMentions('thanks @digi, and @seri.k.', people)).toEqual([digi, seri]);
    expect(resolveMentions('(cc @digi)', people)).toEqual([digi]);
    expect(resolveMentions('is that right @digi?', people)).toEqual([digi]);
  });

  it('keeps punctuation that belongs to the username', () => {
    expect(resolveMentions('@seri.k and @a-b', people)).toEqual([seri, dash]);
  });

  it('is case-insensitive', () => {
    expect(resolveMentions('@Digi hello', people)).toEqual([digi]);
  });

  it('returns each person once, in order of first appearance', () => {
    expect(resolveMentions('@seri.k @digi @seri.k', people)).toEqual([seri, digi]);
  });

  it('does not treat an email address as a mention', () => {
    expect(resolveMentions('mail billing@digi.com or x@digi', people)).toEqual([]);
  });

  it('leaves unknown handles alone', () => {
    expect(resolveMentions('@nobody and @dig', people)).toEqual([]);
  });

  it('does not match a longer handle that merely starts with a username', () => {
    expect(resolveMentions('@digital team', people)).toEqual([]);
  });

  it('returns nothing for a body without mentions', () => {
    expect(resolveMentions('just a note', people)).toEqual([]);
    expect(resolveMentions('', people)).toEqual([]);
  });
});

describe('splitMentions', () => {
  it('returns the whole body as text when nobody is mentioned', () => {
    expect(splitMentions('just a note', people)).toEqual([{ type: 'text', text: 'just a note' }]);
  });

  it('splits around mentions and keeps every character', () => {
    const segments = splitMentions('hey @Digi, see @nobody and @seri.k.', people);
    expect(segments).toEqual([
      { type: 'text', text: 'hey ' },
      { type: 'mention', text: '@Digi', user: digi },
      { type: 'text', text: ', see @nobody and ' },
      { type: 'mention', text: '@seri.k', user: seri },
      { type: 'text', text: '.' },
    ]);
    expect(segments.map((s) => s.text).join('')).toBe('hey @Digi, see @nobody and @seri.k.');
  });

  it('handles a body that is only a mention', () => {
    expect(splitMentions('@digi', people)).toEqual([{ type: 'mention', text: '@digi', user: digi }]);
  });
});

describe('activeMentionQuery', () => {
  it('opens on a bare @', () => {
    expect(activeMentionQuery('@', 1)).toEqual({ start: 0, query: '' });
  });

  it('tracks what has been typed after the @', () => {
    expect(activeMentionQuery('hey @di', 7)).toEqual({ start: 4, query: 'di' });
  });

  it('only looks at the text before the caret', () => {
    expect(activeMentionQuery('hey @di rest', 7)).toEqual({ start: 4, query: 'di' });
    expect(activeMentionQuery('hey @di rest', 12)).toBeNull();
  });

  it('closes once a space is typed', () => {
    expect(activeMentionQuery('hey @digi ', 10)).toBeNull();
  });

  it('stays closed inside an email address', () => {
    expect(activeMentionQuery('bill@di', 7)).toBeNull();
  });

  it('is closed when there is no @', () => {
    expect(activeMentionQuery('hello', 5)).toBeNull();
  });
});

describe('insertMention', () => {
  it('replaces the partial handle and leaves the caret after a space', () => {
    expect(insertMention('hey @di', { start: 4, query: 'di' }, 'digi'))
      .toEqual({ value: 'hey @digi ', caret: 10 });
  });

  it('preserves text after the caret without doubling the space', () => {
    expect(insertMention('hey @di can you look', { start: 4, query: 'di' }, 'digi'))
      .toEqual({ value: 'hey @digi can you look', caret: 10 });
  });

  it('works on a bare @', () => {
    expect(insertMention('@', { start: 0, query: '' }, 'seri.k'))
      .toEqual({ value: '@seri.k ', caret: 8 });
  });
});
