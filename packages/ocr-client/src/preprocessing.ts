/**
 * Receipt image preprocessing — verbatim behavior from Trade Show /
 * expense-app `receiptExternalOcr.ts` (prepareReceiptImageForExternalOcr).
 * Same ImageMagick commands, same HEIC failure semantics.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, unlinkSync } from 'fs';
import { extname } from 'path';

const execAsync = promisify(exec);

export interface PreparedReceiptImage {
  pathForRequest: string;
  cleanup: string[];
}

async function convertHEICToJPEG(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (ext !== '.heic' && ext !== '.heif') {
    return filePath;
  }
  const jpegPath = filePath.replace(/\.(heic|heif)$/i, '.jpg');
  try {
    await execAsync(`convert "${filePath}" -resize 2000x2000\\> -quality 85 "${jpegPath}"`);
    unlinkSync(filePath);
    return jpegPath;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ocr-client] HEIC conversion failed:', message);
    throw new Error('Failed to process HEIC file. Please convert to JPEG and try again.');
  }
}

/**
 * Auto-orient and cap max dimension (matches expense-app OCR v2 behavior for raster images).
 */
async function normalizeRasterForOcr(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
    return filePath;
  }
  const base = filePath.replace(/\.(jpg|jpeg|png|webp)$/i, '');
  const outExt = ext === '.png' ? '.png' : '.jpg';
  const outPath = `${base}-ocrprep${outExt}`;
  try {
    await execAsync(`convert "${filePath}" -auto-orient -resize 2000x2000\\> -strip "${outPath}"`);
    return outPath;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[ocr-client] Raster normalize skipped (ImageMagick?):', message);
    return filePath;
  }
}

/**
 * Prepare file before POST to /ocr/ (HEIC → JPEG, raster normalize). PDF unchanged.
 */
export async function prepareReceiptImageForOcr(filePath: string): Promise<PreparedReceiptImage> {
  const ext = extname(filePath).toLowerCase();
  const cleanup: string[] = [];
  if (ext === '.pdf') {
    return { pathForRequest: filePath, cleanup };
  }

  const current = await convertHEICToJPEG(filePath);
  const normalized = await normalizeRasterForOcr(current);
  if (normalized !== current) {
    cleanup.push(normalized);
  }
  return { pathForRequest: normalized, cleanup };
}

export function cleanupPreparedFiles(originalPath: string, cleanup: string[]): void {
  for (const p of cleanup) {
    try {
      if (p !== originalPath && existsSync(p)) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}
