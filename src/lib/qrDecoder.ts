// =============================================
// QR decoder dùng chung cho upload ảnh và camera realtime.
//
// Chiến lược (xếp theo thứ tự thử):
//   1) Native BarcodeDetector — chính xác và chịu ảnh thực tế (tilt, ánh sáng,
//      perspective, nền nhiễu) tốt hơn jsQR. Có sẵn trên Chrome/Edge desktop và
//      Chrome Android. Trên Safari/iOS sẽ rơi xuống jsQR.
//   2) jsQR multi-scale trên ảnh đầy đủ (1600/1200/800).
//   3) jsQR multi-scale trên center-crop nhiều mức (90/75/60/45%) — focus vào
//      vùng QR khi nền có hoạ tiết nhiễu (vd. CCCD chụp trên vải hoa văn).
//   4) jsQR sau khi binarize Otsu — tăng tương phản, giảm ảnh hưởng nền màu.
//
// API:
//   - decodeQr(source)              : decode toàn bộ source (image/video/canvas)
//   - decodeQrFromFile(file)        : decode File → string | null
//   - decodeQrFromRoi(source, roi)  : decode đúng 1 ROI (camera viewfinder)
// =============================================

import jsQR from 'jsqr';

type DecodeSource =
  | HTMLImageElement
  | HTMLVideoElement
  | HTMLCanvasElement
  | ImageBitmap;

export interface Roi {
  /** Toạ độ x của ROI tính theo pixel của source. */
  x: number;
  /** Toạ độ y của ROI tính theo pixel của source. */
  y: number;
  /** Chiều rộng ROI. */
  width: number;
  /** Chiều cao ROI. */
  height: number;
}

interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): {
    detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>>;
  };
  getSupportedFormats?: () => Promise<string[]>;
}

function getBarcodeDetector(): BarcodeDetectorCtor | null {
  const w = window as unknown as { BarcodeDetector?: BarcodeDetectorCtor };
  return w.BarcodeDetector || null;
}

let cachedDetector: InstanceType<BarcodeDetectorCtor> | null = null;
let detectorChecked = false;

async function getDetector() {
  if (detectorChecked) return cachedDetector;
  detectorChecked = true;
  const Ctor = getBarcodeDetector();
  if (!Ctor) return null;
  try {
    const supported = Ctor.getSupportedFormats ? await Ctor.getSupportedFormats() : ['qr_code'];
    if (!supported.includes('qr_code')) return null;
    cachedDetector = new Ctor({ formats: ['qr_code'] });
    return cachedDetector;
  } catch {
    return null;
  }
}

function sourceSize(source: DecodeSource): { w: number; h: number } {
  if (source instanceof HTMLVideoElement) {
    return { w: source.videoWidth, h: source.videoHeight };
  }
  return {
    w: (source as HTMLImageElement | HTMLCanvasElement | ImageBitmap).width,
    h: (source as HTMLImageElement | HTMLCanvasElement | ImageBitmap).height,
  };
}

/**
 * Vẽ source (hoặc 1 ROI của source) xuống canvas. `targetMax` = cạnh dài nhất
 * sau resize; 0 = giữ nguyên kích thước.
 */
function rasterize(
  source: DecodeSource,
  targetMax: number,
  roi?: Roi,
): ImageData | null {
  const { w: srcW, h: srcH } = sourceSize(source);
  if (!srcW || !srcH) return null;

  const sx = roi ? Math.max(0, Math.round(roi.x)) : 0;
  const sy = roi ? Math.max(0, Math.round(roi.y)) : 0;
  const sw = roi ? Math.min(srcW - sx, Math.round(roi.width)) : srcW;
  const sh = roi ? Math.min(srcH - sy, Math.round(roi.height)) : srcH;
  if (sw <= 0 || sh <= 0) return null;

  const scale = targetMax > 0 ? Math.min(1, targetMax / Math.max(sw, sh)) : 1;
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source as CanvasImageSource, sx, sy, sw, sh, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** jsQR cơ bản trên 1 ImageData. */
function tryJsQr(data: ImageData): string | null {
  const r = jsQR(data.data, data.width, data.height, {
    inversionAttempts: 'attemptBoth',
  });
  return r?.data || null;
}

/**
 * Binarize ảnh bằng Otsu threshold rồi chạy jsQR. Giúp với QR trên nền màu/nhiễu
 * (vd. CCCD trên vải hoa văn) nơi mà jsQR raw thất bại vì local contrast yếu.
 */
function tryJsQrOtsu(data: ImageData): string | null {
  const px = data.data;
  const n = data.width * data.height;
  // Histogram grayscale
  const hist = new Uint32Array(256);
  const gray = new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const g = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
    const v = g | 0;
    gray[j] = v;
    hist[v]++;
  }
  // Otsu
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let varMax = -1;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > varMax) {
      varMax = v;
      threshold = t;
    }
  }
  // Apply threshold
  const out = new Uint8ClampedArray(px.length);
  for (let j = 0, i = 0; j < n; j++, i += 4) {
    const v = gray[j] >= threshold ? 255 : 0;
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = 255;
  }
  const binarized = new ImageData(out, data.width, data.height);
  return tryJsQr(binarized);
}

/**
 * Thử decode trên source. Chạy:
 *  1) BarcodeDetector (nếu có)
 *  2) jsQR multi-scale trên toàn ảnh (raw + Otsu)
 *
 * Không tự crop — caller có thể gọi {@link decodeQrFromRoi} hoặc
 * {@link decodeQr} (full pipeline với center-crop attempts).
 */
async function decodeQrCore(source: DecodeSource, roi?: Roi): Promise<string | null> {
  const detector = await getDetector();
  if (detector && !roi) {
    try {
      const results = await detector.detect(source as CanvasImageSource);
      if (results.length > 0 && results[0].rawValue) return results[0].rawValue;
    } catch {
      // detector throws khi source chưa sẵn sàng — bỏ qua và rơi xuống jsQR
    }
  }
  // Nếu có ROI, BarcodeDetector cũng nên thử trên ROI đã crop để hưởng lợi.
  if (detector && roi) {
    const rasterFull = rasterize(source, 0, roi);
    if (rasterFull) {
      const canvas = document.createElement('canvas');
      canvas.width = rasterFull.width;
      canvas.height = rasterFull.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.putImageData(rasterFull, 0, 0);
        try {
          const results = await detector.detect(canvas);
          if (results.length > 0 && results[0].rawValue) return results[0].rawValue;
        } catch {
          /* ignore */
        }
      }
    }
  }

  const scales = [800, 1200, 1600];
  for (const target of scales) {
    const data = rasterize(source, target, roi);
    if (!data) continue;
    const raw = tryJsQr(data);
    if (raw) return raw;
  }
  // Lần thử cuối: full size + Otsu — đắt nhưng cứu được ảnh nền nhiễu
  const full = rasterize(source, 1600, roi);
  if (full) {
    const otsu = tryJsQrOtsu(full);
    if (otsu) return otsu;
  }
  return null;
}

/**
 * Decode QR từ source. Thử full image trước, sau đó center-crop nhiều mức để
 * focus vào vùng QR khi nền có hoạ tiết nhiễu (vd. CCCD chụp trên vải hoa văn).
 *
 * Multi-region crop chỉ chạy ở phase fallback (sau khi pipeline full thất bại).
 */
export async function decodeQr(source: DecodeSource): Promise<string | null> {
  // Phase 1: full image
  const raw = await decodeQrCore(source);
  if (raw) return raw;

  // Phase 2: center-crop attempts (focus QR, bỏ nền nhiễu)
  const { w, h } = sourceSize(source);
  if (!w || !h) return null;
  const ratios = [0.9, 0.75, 0.6, 0.45];
  for (const r of ratios) {
    const cw = Math.round(w * r);
    const ch = Math.round(h * r);
    const cx = Math.round((w - cw) / 2);
    const cy = Math.round((h - ch) / 2);
    const cropped = await decodeQrCore(source, { x: cx, y: cy, width: cw, height: ch });
    if (cropped) return cropped;
  }
  return null;
}

/**
 * Decode QR chỉ trong một ROI (camera viewfinder). Nhanh hơn full pipeline
 * vì bỏ qua center-crop fallback và chỉ rasterize phần ROI.
 */
export async function decodeQrFromRoi(
  source: DecodeSource,
  roi: Roi,
): Promise<string | null> {
  return decodeQrCore(source, roi);
}

/** Decode QR từ File (PNG/JPG/WEBP). Trả raw string hoặc null. */
export async function decodeQrFromFile(file: File): Promise<string | null> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Không thể đọc ảnh'));
    el.src = dataUrl;
  });
  return decodeQr(img);
}
