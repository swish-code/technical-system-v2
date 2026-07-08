// Client-side image compression for chat/invoice uploads.
//
// Restaurant staff upload phone photos of invoices (often 3–12MB), which were
// previously stored and served at full size — slow to upload and slow for the
// office to open. We downscale to a max edge and re-encode as JPEG in the
// browser BEFORE upload, cutting a typical photo to a few hundred KB while
// keeping invoice text legible.
//
// Safe by design: if anything goes wrong, or the result isn't smaller, we fall
// back to the original file so a message can always still be sent.

const MAX_EDGE = 1600;   // longest side, in pixels — keeps invoice text readable
const QUALITY = 0.8;     // JPEG quality

async function loadImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      // `from-image` applies EXIF orientation so phone photos aren't rotated.
      return await createImageBitmap(file, { imageOrientation: 'from-image' } as any);
    } catch {
      // fall through to the <img> path
    }
  }
  return await new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

/**
 * Downscale + JPEG-compress an image file. Returns a new (smaller) File, or the
 * original unchanged when it isn't an image we should touch (video, PDF, GIF),
 * when compression fails, or when it wouldn't actually save space.
 */
export async function compressImage(file: File): Promise<File> {
  // Only re-encode raster photos. Skip videos/PDFs, and GIFs (animated — a
  // canvas would flatten them to a single frame).
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;

  try {
    const src = await loadImage(file);
    const width = (src as HTMLImageElement).naturalWidth || src.width;
    const height = (src as HTMLImageElement).naturalHeight || src.height;
    if (!width || !height) return file;

    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;

    // White backdrop so transparent PNGs (e.g. screenshots) don't turn black
    // when flattened into JPEG.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(src as CanvasImageSource, 0, 0, targetW, targetH);
    if (typeof (src as ImageBitmap).close === 'function') (src as ImageBitmap).close();

    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', QUALITY)
    );
    if (!blob || blob.size >= file.size) return file; // no gain — keep original

    const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return file; // never block a send on a compression failure
  }
}
