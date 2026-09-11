import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReceiptBundle, classifyReceipts } from '../lib/receiptBundle';

// A 1x1 transparent PNG. Any real PNG works; this one keeps the test hermetic.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

// A 1x1 JPEG. If pdf-lib rejects this constant, replace it with the bytes of
// any real .jpg — the point of the assertion is the mime dispatch, not this
// particular fixture.
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

let dir: string;

/** Write `bytes` into the fake uploads dir and return a BundleInput for it. */
async function put(name: string, mimeType: string, bytes: Buffer) {
  await fs.writeFile(path.join(dir, name), bytes);
  return { filename: name, mimeType, storagePath: name };
}

/** A real 2-page PDF, built with the same library that has to read it back. */
async function twoPagePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'midas-bundle-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('classifyReceipts', () => {
  it('accepts jpeg, png and pdf', () => {
    const input = [
      { filename: 'a.jpg', mimeType: 'image/jpeg', storagePath: 'a.jpg' },
      { filename: 'b.png', mimeType: 'image/png', storagePath: 'b.png' },
      { filename: 'c.pdf', mimeType: 'application/pdf', storagePath: 'c.pdf' },
    ];
    const { embeddable, skipped } = classifyReceipts(input);
    expect(embeddable).toHaveLength(3);
    expect(skipped).toEqual([]);
  });

  it('skips webp, which pdf-lib cannot embed', () => {
    const { embeddable, skipped } = classifyReceipts([
      { filename: 'a.jpg', mimeType: 'image/jpeg', storagePath: 'a.jpg' },
      { filename: 'old.webp', mimeType: 'image/webp', storagePath: 'old.webp' },
    ]);
    expect(embeddable.map((r) => r.filename)).toEqual(['a.jpg']);
    expect(skipped).toEqual(['old.webp']);
  });

  it('matches the mime type case-insensitively', () => {
    const { embeddable } = classifyReceipts([
      { filename: 'a.JPG', mimeType: 'IMAGE/JPEG', storagePath: 'a.JPG' },
    ]);
    expect(embeddable).toHaveLength(1);
  });
});

describe('buildReceiptBundle', () => {
  it('returns no file for no receipts', async () => {
    expect(await buildReceiptBundle([], dir)).toEqual({ file: null, skipped: [] });
  });

  it('passes a single receipt through byte-for-byte', async () => {
    const only = await put('single.png', 'image/png', PNG_1X1);
    const { file, skipped } = await buildReceiptBundle([only], dir);
    expect(skipped).toEqual([]);
    expect(file!.filename).toBe('single.png');
    expect(file!.mimeType).toBe('image/png');
    expect(file!.buffer.equals(PNG_1X1)).toBe(true);
  });

  it('passes a single PDF through without rewrapping it', async () => {
    const pdf = await twoPagePdf();
    const only = await put('single.pdf', 'application/pdf', pdf);
    const { file } = await buildReceiptBundle([only], dir);
    expect(file!.mimeType).toBe('application/pdf');
    expect(file!.buffer.equals(pdf)).toBe(true);
  });

  it('merges two images into a two-page PDF', async () => {
    const a = await put('one.png', 'image/png', PNG_1X1);
    const b = await put('two.png', 'image/png', PNG_1X1);
    const { file, skipped } = await buildReceiptBundle([a, b], dir);
    expect(skipped).toEqual([]);
    expect(file!.mimeType).toBe('application/pdf');
    expect(file!.filename).toBe('receipt-2-pages.pdf');
    const out = await PDFDocument.load(file!.buffer);
    expect(out.getPageCount()).toBe(2);
  });

  it('embeds a jpeg alongside a png', async () => {
    const a = await put('photo.jpg', 'image/jpeg', JPEG_1X1);
    const b = await put('scan.png', 'image/png', PNG_1X1);
    const { file } = await buildReceiptBundle([a, b], dir);
    const out = await PDFDocument.load(file!.buffer);
    expect(out.getPageCount()).toBe(2);
  });

  it('inlines the pages of an existing PDF in order', async () => {
    const a = await put('img.png', 'image/png', PNG_1X1);
    const b = await put('doc.pdf', 'application/pdf', await twoPagePdf());
    const { file } = await buildReceiptBundle([a, b], dir);
    const out = await PDFDocument.load(file!.buffer);
    // 1 image page + 2 copied PDF pages
    expect(out.getPageCount()).toBe(3);
    expect(file!.filename).toBe('receipt-3-pages.pdf');
  });

  it('names skipped receipts but still bundles the rest', async () => {
    const a = await put('good.png', 'image/png', PNG_1X1);
    const b = await put('bad.webp', 'image/webp', Buffer.from('not really webp'));
    const c = await put('also-good.png', 'image/png', PNG_1X1);
    const { file, skipped } = await buildReceiptBundle([a, b, c], dir);
    expect(skipped).toEqual(['bad.webp']);
    const out = await PDFDocument.load(file!.buffer);
    expect(out.getPageCount()).toBe(2);
  });

  it('returns no file when every receipt is unembeddable', async () => {
    const a = await put('x.webp', 'image/webp', Buffer.from('x'));
    const b = await put('y.webp', 'image/webp', Buffer.from('y'));
    const { file, skipped } = await buildReceiptBundle([a, b], dir);
    expect(file).toBeNull();
    expect(skipped).toEqual(['x.webp', 'y.webp']);
  });

  it('throws when a receipt file is missing from disk', async () => {
    const ghost = { filename: 'gone.png', mimeType: 'image/png', storagePath: 'gone.png' };
    await expect(buildReceiptBundle([ghost], dir)).rejects.toThrow();
  });
});
