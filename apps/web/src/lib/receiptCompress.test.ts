import { describe, expect, it } from 'vitest';
import { shouldTranscode } from './receiptCompress';

const MB = 1_000_000;

describe('shouldTranscode', () => {
  it('leaves a small jpeg alone — it is already small and already embeddable', () => {
    expect(shouldTranscode('image/jpeg', 0.4 * MB)).toBe(false);
  });

  it('shrinks a large jpeg', () => {
    expect(shouldTranscode('image/jpeg', 4 * MB)).toBe(true);
  });

  it('always transcodes webp, whatever its size', () => {
    // pdf-lib cannot embed WebP, so a WebP receipt would be dropped from the
    // merged PDF that reaches Zoho. Correctness of the bundle beats bytes saved.
    expect(shouldTranscode('image/webp', 0.1 * MB)).toBe(true);
    expect(shouldTranscode('image/webp', 4 * MB)).toBe(true);
  });

  it('never touches PDFs or HEIC — the server converts HEIC itself', () => {
    expect(shouldTranscode('application/pdf', 8 * MB)).toBe(false);
    expect(shouldTranscode('image/heic', 8 * MB)).toBe(false);
  });
});
