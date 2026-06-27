// =============================================================================
// imageCompress — nén ảnh phía client TRƯỚC khi upload.
// Resize cạnh dài ≤ MAX_EDGE, xuất WebP chất lượng QUALITY (giữ alpha, nhỏ hơn
// JPEG/PNG nhiều). Mục đích: giảm dung lượng kho + băng thông egress, tải nhanh
// hơn cho sale/khách. An toàn tuyệt đối: mọi lỗi / ảnh đã nhỏ / định dạng không
// nén được (gif/svg/heic) → trả lại file gốc nguyên vẹn.
// =============================================================================

const MAX_EDGE = 1600;              // cạnh dài tối đa (px)
const QUALITY = 0.82;              // chất lượng WebP
const MIN_BYTES = 200 * 1024;     // < 200KB coi như đã đủ nhỏ, bỏ qua
const COMPRESSIBLE = /^image\/(jpeg|jpg|png|webp)$/i;

export interface CompressOpts {
  maxEdge?: number;
  quality?: number;
}

/**
 * Nén 1 ảnh. Trả về File mới (WebP) nếu nén có lợi, ngược lại trả file gốc.
 * KHÔNG ném lỗi — luôn trả về một File dùng được.
 */
export async function compressImage(file: File, opts: CompressOpts = {}): Promise<File> {
  try {
    if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return file;
    if (!file || !COMPRESSIBLE.test(file.type)) return file;       // gif/svg/heic… giữ nguyên
    if (file.size <= MIN_BYTES) return file;                       // đã nhỏ

    const maxEdge = opts.maxEdge ?? MAX_EDGE;
    const quality = opts.quality ?? QUALITY;

    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    const canvas: HTMLCanvasElement | OffscreenCanvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = (canvas as HTMLCanvasElement).getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) {
      bitmap.close?.();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const outType = 'image/webp';
    const blob = await canvasToBlob(canvas, outType, quality);
    if (!blob || blob.size >= file.size) return file;             // không nhỏ hơn → giữ gốc

    const base = file.name.replace(/\.[^./]+$/, '') || 'image';
    return new File([blob], `${base}.webp`, { type: outType, lastModified: file.lastModified });
  } catch {
    return file;                                                  // mọi lỗi → giữ file gốc
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality: number,
): Promise<Blob | null> {
  if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise((resolve) =>
    (canvas as HTMLCanvasElement).toBlob((b) => resolve(b), type, quality),
  );
}
