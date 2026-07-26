// =============================================
// QR decoder dùng chung cho upload ảnh và camera realtime.
//
// 3 engine xếp theo thứ tự thử (mỗi engine có điểm mạnh riêng):
//   1) Native BarcodeDetector — nhanh nhất, robust với ảnh thực tế. Chỉ có
//      trên Chrome/Edge desktop + Chrome Android.
//   2) jsQR (lazy-loaded) multi-scale — nhanh, nhẹ; tốt với QR sạch, kém với
//      pixel-grid noise (ảnh chụp màn hình) hoặc QR dense (version cao).
//   3) ZXing (lazy-loaded) — chậm hơn nhưng robust nhất: chịu được
//      screen-photo noise, blur, perspective, dense QR. Bật TRY_HARDER.
//
// Pipeline mở rộng:
//   - Multi-scale (800/1200/1600/2000) cho mỗi engine.
//   - Otsu binarize → jsQR cứu QR nền màu / tương phản kém.
//   - Center-crop 90/75/60/45% để focus vùng QR khi nền nhiễu.
//
// API:
//   - decodeQr(source)              : full pipeline (upload ảnh)
//   - decodeQrFromFile(file)        : decode File → string | null
//   - decodeQrFromRoi(source, roi)  : core pipeline trong 1 ROI (camera frame)
// =============================================

type DecodeSource =
  | HTMLImageElement
  | HTMLVideoElement
  | HTMLCanvasElement
  | ImageBitmap;

export interface Roi {
  x: number;
  y: number;
  width: number;
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
 * Vẽ source (hoặc 1 ROI) xuống canvas mới. Trả cả canvas (cho ZXing) lẫn
 * ImageData (cho jsQR) để tránh re-rasterize.
 */
function rasterize(
  source: DecodeSource,
  targetMax: number,
  roi?: Roi,
): { canvas: HTMLCanvasElement; imageData: ImageData } | null {
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
  const imageData = ctx.getImageData(0, 0, w, h);
  return { canvas, imageData };
}

// Lazy-load jsqr (~46 kB gzip) — pipeline ưu tiên BarcodeDetector native nên
// trên Chrome jsQR thường không chạy; đừng bắt chunk form khách trả phí parse.
let jsqrPromise: Promise<typeof import('jsqr')> | null = null;
function getJsQr() {
  // Không memoize promise BỊ REJECT: chunk 404 (deploy mới) hay rớt mạng 1 lần
  // mà giữ lại promise hỏng thì jsQR chết cả session dù mạng đã hồi.
  if (!jsqrPromise) {
    jsqrPromise = import('jsqr').catch((err) => {
      jsqrPromise = null;
      throw err;
    });
  }
  return jsqrPromise;
}

async function tryJsQr(data: ImageData): Promise<string | null> {
  try {
    const jsQR = (await getJsQr()).default;
    const r = jsQR(data.data, data.width, data.height, {
      inversionAttempts: 'attemptBoth',
    });
    return r?.data || null;
  } catch {
    // Lỗi tải chunk jsqr → coi như tier này không decode được (giống tryZxing),
    // pipeline vẫn chạy tiếp các tier khác thay vì abort + toast lỗi thô.
    return null;
  }
}

/** Otsu binarize + jsQR — cứu QR nền màu/contrast yếu. */
async function tryJsQrOtsu(data: ImageData): Promise<string | null> {
  const px = data.data;
  const n = data.width * data.height;
  const hist = new Uint32Array(256);
  const gray = new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const g = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
    const v = g | 0;
    gray[j] = v;
    hist[v]++;
  }
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
  const out = new Uint8ClampedArray(px.length);
  for (let j = 0, i = 0; j < n; j++, i += 4) {
    const v = gray[j] >= threshold ? 255 : 0;
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = 255;
  }
  return tryJsQr(new ImageData(out, data.width, data.height));
}

// Lazy-load @zxing/library — bundle ~250KB, không cần ở khởi động.
let zxingPromise: Promise<typeof import('@zxing/library')> | null = null;
function getZxing() {
  if (!zxingPromise) zxingPromise = import('@zxing/library');
  return zxingPromise;
}

async function tryZxing(canvas: HTMLCanvasElement): Promise<string | null> {
  try {
    const zx = await getZxing();
    const source = new zx.HTMLCanvasElementLuminanceSource(canvas);
    const bitmap = new zx.BinaryBitmap(new zx.HybridBinarizer(source));
    const reader = new zx.MultiFormatReader();
    const hints = new Map<number, unknown>();
    hints.set(zx.DecodeHintType.POSSIBLE_FORMATS, [zx.BarcodeFormat.QR_CODE]);
    hints.set(zx.DecodeHintType.TRY_HARDER, true);
    reader.setHints(hints);
    const result = reader.decode(bitmap);
    return result?.getText() || null;
  } catch {
    // ZXing ném NotFoundException khi không thấy QR — coi như không decode được.
    return null;
  }
}

interface CoreOpts {
  /** Có chạy tier ZXing không. Camera realtime nên tắt vì chậm/frame. */
  zxing: boolean;
}

async function decodeQrCore(
  source: DecodeSource,
  roi: Roi | undefined,
  opts: CoreOpts,
): Promise<string | null> {
  const detector = await getDetector();

  // ---- BarcodeDetector ----
  if (detector && !roi) {
    try {
      const results = await detector.detect(source as CanvasImageSource);
      if (results.length > 0 && results[0].rawValue) return results[0].rawValue;
    } catch {
      /* detector chưa sẵn sàng → fallback */
    }
  }
  if (detector && roi) {
    const r = rasterize(source, 0, roi);
    if (r) {
      try {
        const results = await detector.detect(r.canvas);
        if (results.length > 0 && results[0].rawValue) return results[0].rawValue;
      } catch {
        /* ignore */
      }
    }
  }

  // ---- jsQR multi-scale ----
  const jsqrScales = [800, 1200, 1600, 2000];
  // Cache rasterize ở các scale để ZXing dùng lại
  const cache = new Map<number, { canvas: HTMLCanvasElement; imageData: ImageData }>();
  for (const target of jsqrScales) {
    const r = rasterize(source, target, roi);
    if (!r) continue;
    cache.set(target, r);
    const hit = await tryJsQr(r.imageData);
    if (hit) return hit;
  }

  // ---- jsQR + Otsu trên scale 1600 ----
  const otsuRaster = cache.get(1600) || rasterize(source, 1600, roi);
  if (otsuRaster) {
    const hit = await tryJsQrOtsu(otsuRaster.imageData);
    if (hit) return hit;
  }

  // ---- ZXing TRY_HARDER ở vài scale ----
  if (opts.zxing) {
    const zxScales = [1600, 2000, 1200];
    for (const target of zxScales) {
      const r = cache.get(target) || rasterize(source, target, roi);
      if (!r) continue;
      cache.set(target, r);
      const hit = await tryZxing(r.canvas);
      if (hit) return hit;
    }
  }

  return null;
}

/**
 * Decode QR từ source (upload ảnh). Full pipeline: BarcodeDetector → jsQR
 * multi-scale → jsQR+Otsu → ZXing. Sau khi pipeline full thất bại, thử
 * center-crop nhiều mức (90/75/60/45%) để bỏ nền nhiễu.
 */
export async function decodeQr(source: DecodeSource): Promise<string | null> {
  const raw = await decodeQrCore(source, undefined, { zxing: true });
  if (raw) return raw;

  const { w, h } = sourceSize(source);
  if (!w || !h) return null;
  const ratios = [0.9, 0.75, 0.6, 0.45];
  for (const r of ratios) {
    const cw = Math.round(w * r);
    const ch = Math.round(h * r);
    const cx = Math.round((w - cw) / 2);
    const cy = Math.round((h - ch) / 2);
    const cropped = await decodeQrCore(
      source,
      { x: cx, y: cy, width: cw, height: ch },
      { zxing: true },
    );
    if (cropped) return cropped;
  }
  return null;
}

/**
 * Decode QR chỉ trong 1 ROI (camera viewfinder). Tắt ZXing để giữ frame rate
 * — viewfinder vốn đã focus được vùng QR rồi.
 */
export async function decodeQrFromRoi(
  source: DecodeSource,
  roi: Roi,
): Promise<string | null> {
  return decodeQrCore(source, roi, { zxing: false });
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
