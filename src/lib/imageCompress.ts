// =============================================================================
// imageCompress — nén ảnh phía client TRƯỚC khi upload.
// Resize cạnh dài ≤ MAX_EDGE, xuất WebP chất lượng QUALITY (giữ alpha, nhỏ hơn
// JPEG/PNG nhiều). Mục đích: giảm dung lượng kho + băng thông egress, tải nhanh
// hơn cho sale/khách. An toàn tuyệt đối: mọi lỗi / ảnh đã nhỏ / định dạng không
// nén được (gif/svg/heic) → trả lại file gốc nguyên vẹn.
//
// Safari trên iPhone KHÔNG mã hoá được WebP: xin `image/webp` thì nó lặng lẽ trả
// PNG (đo 30/09/2026: `IMG_2758.webp` trong kho thực chất là PNG 740×1600). Hàm
// cũ vừa dán nhãn WebP lên byte PNG, vừa trả nguyên ảnh camera 2–3 MB vì PNG thu
// nhỏ còn nặng hơn bản gốc. Nay dò trước bằng canvas 1×1: không có WebP thì xuất
// JPEG (Safari mã hoá JPEG được), và chỉ nhận blob ĐÚNG định dạng đã xin.
// =============================================================================

const MAX_EDGE = 1600;              // cạnh dài tối đa (px)
const QUALITY = 0.82;              // chất lượng WebP/JPEG
const MIN_BYTES = 200 * 1024;     // < 200KB coi như đã đủ nhỏ, bỏ qua
const COMPRESSIBLE = /^image\/(jpeg|jpg|png|webp)$/i;

/**
 * Ảnh CHỨNG TỪ là ảnh chụp màn hình điện thoại (bill chuyển khoản): chữ app ngân
 * hàng to, nén mạnh vẫn đọc rõ. Đo 03/10/2026 trên bill thật trong kho: 1024 px
 * chất lượng 0,5 ra 13–43 KB (WebP) / 20–55 KB (JPEG của iPhone), số tiền và mã
 * giao dịch vẫn rõ; 600 px thì giờ chuyển và nội dung chuyển khoản đã nhoè.
 * Ảnh camera chụp giấy tờ thì 1024 px mất chữ nhỏ (mã số thuế, tên hàng) — giữ
 * mức thường. Ảnh chụp màn hình máy tính (ngang, chữ nhỏ) cũng giữ mức thường.
 */
const SCREENSHOT_MAX_EDGE = 1024;
const SCREENSHOT_QUALITY = 0.5;
/** Ảnh chứng từ nhỏ hơn mức này mới bỏ qua nén (PNG bill 100–200 KB vẫn nén được ~5 lần). */
const EVIDENCE_MIN_BYTES = 48 * 1024;

/**
 * Ảnh chụp màn hình ĐIỆN THOẠI: PNG đúng khổ màn hình điện thoại dựng đứng — cao
 * gấp 1,6–2,4 lần rộng (16:9 … 21:9). Ngoài khoảng đó KHÔNG tính: iPad 4:3, ảnh
 * chụp cuộn dài (1080×5000 xuống 1024 px là còn 221 px bề ngang), hoá đơn điện tử
 * dạng dải dài.
 */
export function isPhoneScreenshot(type: string, width: number, height: number): boolean {
  if (!/^image\/png$/i.test(type) || width <= 0) return false;
  const ratio = height / width;
  return ratio >= 1.6 && ratio <= 2.4;
}

/**
 * Đang dùng máy cảm ứng (điện thoại/máy tính bảng). Trên máy tính, ảnh dán bằng
 * Ctrl+V LUÔN là PNG kể cả ảnh chụp giấy tờ copy từ Zalo — không nén mạnh ở đó
 * (mạng máy tính cũng nhanh, lợi ít).
 */
function onTouchDevice(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  } catch {
    return false; // trình duyệt không hỗ trợ truy vấn này: coi như máy tính
  }
}
/**
 * Nén quá hạn này thì bỏ, tải ảnh gốc. Nén thường xong dưới 1 giây; quá hạn là
 * máy đang kẹt (bộ nhớ, bộ giải mã) — không được giữ người dùng ở "Đang tải...".
 */
export const COMPRESS_TIMEOUT_MS = 12_000;

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type OutType = 'image/webp' | 'image/jpeg';

export interface CompressOpts {
  maxEdge?: number;
  quality?: number;
  /** Hạn cho cả bước nén (ms). Mặc định COMPRESS_TIMEOUT_MS. */
  timeoutMs?: number;
  /** `evidence`: ảnh chứng từ — chụp màn hình điện thoại nén mạnh hơn (xem trên). */
  profile?: 'evidence';
  /** Có phải máy cảm ứng không; mặc định tự dò (`pointer: coarse`). */
  touchDevice?: boolean;
}

/**
 * Nén LẦN LƯỢT từng ảnh: giải mã cùng lúc nhiều ảnh camera 12–48 MP trên máy yếu dễ
 * quá hạn nén (trả ảnh gốc to) hoặc làm iOS đóng tab. Việc gửi qua mạng vẫn song song.
 * Mỗi lượt không bao giờ ném (xem compressWithTimeout) nên hàng đợi không bị kẹt.
 */
let compressQueue: Promise<unknown> = Promise.resolve();

/**
 * Nén 1 ảnh. Trả về File mới (WebP, hoặc JPEG khi trình duyệt không mã hoá
 * được WebP) nếu nén có lợi, ngược lại trả file gốc.
 * KHÔNG ném lỗi — luôn trả về một File dùng được, kể cả khi bước nén treo.
 */
export function compressImage(file: File, opts: CompressOpts = {}): Promise<File> {
  const turn = compressQueue.then(() => compressWithTimeout(file, opts));
  compressQueue = turn;
  return turn;
}

/** Hạn nén tính từ lúc tới lượt, không tính thời gian xếp hàng. */
async function compressWithTimeout(file: File, opts: CompressOpts): Promise<File> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const giveUp = new Promise<File>((resolve) => {
    timer = setTimeout(() => resolve(file), opts.timeoutMs ?? COMPRESS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([compressNow(file, opts), giveUp]);
  } finally {
    clearTimeout(timer);
  }
}

async function compressNow(file: File, opts: CompressOpts): Promise<File> {
  try {
    if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return file;
    if (!file || !COMPRESSIBLE.test(file.type)) return file;       // gif/svg/heic… giữ nguyên
    const evidence = opts.profile === 'evidence';
    if (file.size <= (evidence ? EVIDENCE_MIN_BYTES : MIN_BYTES)) return file; // đã nhỏ

    const outType: OutType = (await canEncode('image/webp')) ? 'image/webp' : 'image/jpeg';

    const bitmap = await decodeUpright(file);
    if (!bitmap) return file;
    let canvas: AnyCanvas | null = null;
    try {
      const { width, height } = bitmap;
      const screenshot = evidence
        && (opts.touchDevice ?? onTouchDevice())
        && isPhoneScreenshot(file.type, width, height);
      const maxEdge = opts.maxEdge ?? (screenshot ? SCREENSHOT_MAX_EDGE : MAX_EDGE);
      const quality = opts.quality ?? (screenshot ? SCREENSHOT_QUALITY : QUALITY);
      const scale = Math.min(1, maxEdge / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));

      canvas = makeCanvas(w, h);
      const ctx = context2d(canvas);
      if (!ctx) return file;
      if (outType === 'image/jpeg') {
        // JPEG không có kênh trong suốt: không tô nền thì ảnh PNG trong suốt
        // (con dấu, chữ ký) hoá nền đen.
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
      }
      ctx.drawImage(bitmap, 0, 0, w, h);

      const blob = await canvasToBlob(canvas, outType, quality);
      // Chỉ nhận đúng định dạng đã xin — không bao giờ dán nhãn WebP lên byte PNG.
      if (!blob || blob.type !== outType || blob.size >= file.size) return file;

      const base = file.name.replace(/\.[^./]+$/, '') || 'image';
      const ext = outType === 'image/webp' ? 'webp' : 'jpg';
      return new File([blob], `${base}.${ext}`, { type: outType, lastModified: file.lastModified });
    } finally {
      bitmap.close?.();
      if (canvas) releaseCanvas(canvas);
    }
  } catch {
    return file;                                                  // mọi lỗi → giữ file gốc
  }
}

/**
 * Giải mã theo ĐÚNG CHIỀU ảnh; `null` = không nén được an toàn, giữ ảnh gốc.
 *
 * Ảnh chụp thẳng từ camera iPhone (`image.jpg`) có điểm ảnh nằm ngang 4032×3024
 * kèm cờ xoay EXIF 6 (soi kho 30/09/2026); vẽ lại qua canvas làm mất cờ đó, nên
 * phải xoay ngay lúc giải mã. Nói rõ `from-image` thay vì trông vào mặc định (bản
 * spec cũ mặc định 'none'). Trình duyệt cũ chưa biết giá trị này ném TypeError:
 * JPEG có thể mang cờ xoay mà mặc định cũ bỏ qua ⇒ giữ ảnh gốc (đúng như trước khi
 * nén); PNG/WebP không có cờ xoay ⇒ giải mã lại theo mặc định. Lỗi khác (ảnh hỏng)
 * ⇒ giữ ảnh gốc.
 */
async function decodeUpright(file: File): Promise<ImageBitmap | null> {
  const upright = await createImageBitmap(file, { imageOrientation: 'from-image' }).then(
    (bitmap) => ({ bitmap, error: null as unknown }),
    (error: unknown) => ({ bitmap: null, error }),
  );
  if (upright.bitmap) return upright.bitmap;
  const mayCarryExifRotation = /^image\/jpe?g$/i.test(file.type);
  if (!(upright.error instanceof TypeError) || mayCarryExifRotation) return null;
  return createImageBitmap(file);
}

/** Trình duyệt có mã hoá được `type` không — thử trên canvas 1×1 (~1 ms). */
async function canEncode(type: OutType): Promise<boolean> {
  const probe = makeCanvas(1, 1);
  try {
    context2d(probe);
    const blob = await canvasToBlob(probe, type, QUALITY);
    return blob?.type === type;
  } catch {
    return false;
  } finally {
    releaseCanvas(probe);
  }
}

function makeCanvas(w: number, h: number): AnyCanvas {
  return typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
}

function context2d(canvas: AnyCanvas) {
  return (canvas as HTMLCanvasElement).getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
}

/**
 * Trả bộ nhớ canvas ngay. Safari giới hạn TỔNG bộ nhớ canvas của trang và GC
 * dọn chậm — app mở lâu, nén nhiều ảnh là chạm trần, getContext trả null.
 */
function releaseCanvas(canvas: AnyCanvas) {
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // canvas đã bị tách/đóng — không còn gì để trả
  }
}

function canvasToBlob(
  canvas: AnyCanvas,
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
