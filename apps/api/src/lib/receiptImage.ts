/**
 * HEIC/HEIF (iPhone photos) are converted to JPEG at upload time so OCR and
 * browsers only ever deal with JPEG.
 */

export function needsHeicConversion(mimeType: string, filename: string): boolean {
  const mt = mimeType.toLowerCase();
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return mt === 'image/heic' || mt === 'image/heif' || ext === 'heic' || ext === 'heif';
}

export function convertedName(filename: string): string {
  return filename.replace(/\.(heic|heif)$/i, '') + '.jpg';
}

export async function toJpegIfHeic(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  if (!needsHeicConversion(mimeType, filename)) return { buffer, mimeType, filename };
  const convert = (await import('heic-convert')).default;
  const out = await convert({ buffer, format: 'JPEG', quality: 0.9 });
  return { buffer: Buffer.from(out), mimeType: 'image/jpeg', filename: convertedName(filename) };
}
