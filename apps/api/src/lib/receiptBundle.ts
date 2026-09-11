/**
 * Zoho Books holds ONE attachment per expense and per purchase order — a
 * second attach replaces the first. Midas allows many receipts per record, so
 * everything the user attached is merged into a single PDF at push time and
 * that PDF is what Zoho receives.
 *
 * A lone receipt is passed through untouched. Re-wrapping the overwhelmingly
 * common case in a PDF would re-encode a working path for no benefit, and
 * would change what accountants have been seeing in Zoho for every
 * single-receipt expense ever pushed.
 */

import fs from 'fs/promises';
import path from 'path';
import { PDFDocument } from 'pdf-lib';

export type BundleInput = {
  filename: string;
  mimeType: string;
  storagePath: string;
};

export type BundleFile = {
  buffer: Buffer;
  filename: string;
  mimeType: string;
};

export type BundleResult = {
  file: BundleFile | null;
  /** Filenames left out because pdf-lib cannot embed their type. */
  skipped: string[];
};

/**
 * pdf-lib embeds JPEG and PNG only, and copies pages out of an existing PDF.
 * `image/webp` is in the upload allow-list (`receipts.ts` ALLOWED_MIME) and is
 * NOT embeddable — the client transcodes new WebP uploads to JPEG, but
 * receipts already in storage from before that change still exist.
 */
const EMBEDDABLE = new Set(['image/jpeg', 'image/png', 'application/pdf']);

/** Split receipts into what can go into a PDF and what cannot. Pure. */
export function classifyReceipts(
  receipts: BundleInput[],
): { embeddable: BundleInput[]; skipped: string[] } {
  const embeddable: BundleInput[] = [];
  const skipped: string[] = [];
  for (const r of receipts) {
    if (EMBEDDABLE.has(r.mimeType.toLowerCase())) embeddable.push(r);
    else skipped.push(r.filename);
  }
  return { embeddable, skipped };
}

/**
 * Build the single file to hand to Zoho.
 *
 * Throws if a receipt file cannot be read from disk. Both callers already run
 * inside a try/catch that records `receipt file could not be read (<path>)`
 * and lets the push stand — that is the outage class from v1.3.2, where a
 * changed uploads mount made every readFile throw while pushes still reported
 * success. Do not swallow it here.
 */
export async function buildReceiptBundle(
  receipts: BundleInput[],
  uploadsDir: string,
): Promise<BundleResult> {
  if (receipts.length === 0) return { file: null, skipped: [] };

  const read = (r: BundleInput) => fs.readFile(path.join(uploadsDir, r.storagePath));

  // One receipt: verbatim bytes, verbatim name and type. No re-encode.
  if (receipts.length === 1) {
    const only = receipts[0];
    return {
      file: { buffer: await read(only), filename: only.filename, mimeType: only.mimeType },
      skipped: [],
    };
  }

  const { embeddable, skipped } = classifyReceipts(receipts);
  if (embeddable.length === 0) return { file: null, skipped };

  const doc = await PDFDocument.create();
  for (const r of embeddable) {
    const bytes = await read(r);
    const mime = r.mimeType.toLowerCase();

    if (mime === 'application/pdf') {
      // ignoreEncryption: a password-protected receipt should contribute its
      // pages rather than throw away the whole bundle.
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages = await doc.copyPages(src, src.getPageIndices());
      for (const p of pages) doc.addPage(p);
      continue;
    }

    const image = mime === 'image/png'
      ? await doc.embedPng(bytes)
      : await doc.embedJpg(bytes);
    // One page per photo, sized to the photo, so nothing is cropped or letterboxed.
    const page = doc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }

  const merged = Buffer.from(await doc.save());
  return {
    file: {
      buffer: merged,
      filename: `receipt-${doc.getPageCount()}-pages.pdf`,
      mimeType: 'application/pdf',
    },
    skipped,
  };
}
