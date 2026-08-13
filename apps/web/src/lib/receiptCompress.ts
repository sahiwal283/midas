/**
 * Downscale large receipt photos before upload. Phone cameras produce 4–10 MB
 * JPEGs; a 2000px-long-edge JPEG (~0.5 MB) uploads far faster on mobile data
 * and loses nothing OCR cares about. HEIC/PDF pass through untouched — the
 * server converts HEIC itself. Any failure falls back to the original file.
 */

const COMPRESSIBLE = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SKIP_BELOW_BYTES = 1_000_000;
const MAX_EDGE_PX = 2000;
const JPEG_QUALITY = 0.82;

export async function compressReceiptImage(file: File): Promise<File> {
  if (!COMPRESSIBLE.has(file.type) || file.size < SKIP_BELOW_BYTES) return file;

  const url = URL.createObjectURL(file);
  try {
    // Decode via <img>, not createImageBitmap: browsers apply EXIF orientation
    // when rendering an image element, so the canvas copy comes out upright.
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('decode failed'));
      i.src = url;
    });

    const scale = Math.min(1, MAX_EDGE_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob || blob.size >= file.size) return file;

    return new File(
      [blob],
      file.name.replace(/\.(png|webp|jpeg|jpg)$/i, '') + '.jpg',
      { type: 'image/jpeg' },
    );
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}
