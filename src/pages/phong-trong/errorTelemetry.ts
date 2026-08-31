/**
 * Chuẩn hoá — phân loại — vân tay lỗi của trang công khai "Phòng trống".
 *
 * Module THUẦN (không đụng DOM, không đụng mạng) để test được ở môi trường node
 * — repo cố ý không cài jsdom.
 *
 * Ba việc:
 *
 *  1. `normalizeError`: gom mọi nguồn lỗi (window.onerror, unhandledrejection,
 *     tài nguyên tải hỏng, lỗi nghiệp vụ tự báo, ErrorBoundary) về MỘT hình
 *     dạng duy nhất, cắt độ dài từng trường. Bản cũ mỗi nơi ghi một kiểu: chỗ
 *     có `kind` chỗ không, chỗ có `ua` chỗ không, nên bảng nhật ký lỗi đầy ô
 *     "—" mà không ai biết vì sao.
 *
 *  2. `classifySource`: tách lỗi DO ỨNG DỤNG khỏi lỗi do trình duyệt in-app của
 *     bên thứ ba tiêm vào trang. Án lệ: `ReferenceError: Can't find variable:
 *     zaloJSV2` — script cầu nối của WebView Zalo (iOS/WebKit), chiếm gần hết
 *     nhật ký lỗi trong khi mã của mình không hề nhắc tới `zaloJSV2` ở bất cứ
 *     đâu. Không sửa được, nhưng cũng không được phép chôn lấp lỗi thật.
 *
 *  3. `fingerprint`: vân tay ổn định để gộp lỗi lặp. Một script hỏng có thể bắn
 *     cùng một lỗi mỗi giây; ghi từng lần là ngập bảng mà chẳng biết thêm gì.
 *     Gộp lại thành 1 dòng + bộ đếm thì vẫn đủ để phân tích.
 */

/** Nguồn phát sinh lỗi. Giá trị đi thẳng vào metadata.kind của sự kiện. */
export type PtErrorKind =
  | "js" // window 'error' từ mã JS
  | "unhandledrejection" // promise bị bỏ rơi
  | "resource" // <img>/<script>/<link> tải hỏng (bắt ở pha capture)
  | "fetch_or_token" // tải dữ liệu phòng trống thất bại / token sai
  | "deposit" // luồng đặt cọc nhanh
  | "ui" // thao tác của khách không thực hiện được (chia sẻ, tải ảnh…)
  | "react_boundary"; // React render crash, bắt ở ErrorBoundary

export type PtErrorSource = "app" | "external";

/** Đầu vào thô — mọi trường đều tuỳ chọn trừ `kind`. */
export interface PtErrorInput {
  kind: PtErrorKind;
  msg?: string | null;
  /** Đường dẫn file/tài nguyên gây lỗi (ev.filename hoặc src của thẻ). */
  src?: string | null;
  /** Vị trí trong ứng dụng do lập trình viên tự đặt tên ("QuickDepositModal"). */
  where?: string | null;
  line?: number | null;
  col?: number | null;
  stack?: string | null;
  href?: string | null;
  ua?: string | null;
  /** Kích thước khung nhìn "390x844". */
  vp?: string | null;
  /** Mã build (VITE_BUILD_SHA) — biết lỗi thuộc bản phát hành nào. */
  build?: string | null;
  /** Mốc thời gian phía client (ms). created_at của DB là giờ GỬI, lệch tới 8 giây. */
  ts?: number | null;
  room_id?: string;
}

/** Hình dạng cuối cùng nằm trong `metadata` của sự kiện 'error'. */
export interface PtErrorMeta {
  kind: PtErrorKind;
  msg: string;
  src?: string;
  where?: string;
  line?: number;
  col?: number;
  stack?: string;
  href?: string;
  ua?: string;
  vp?: string;
  build?: string;
  ts?: number;
  source: PtErrorSource;
  fp: string;
  n: number;
}

/** Trần độ dài từng trường — cộng lại phải nằm dưới mức clamp 8192 của RPC ghi. */
export const LIMITS = {
  msg: 500,
  stack: 2000,
  src: 300,
  where: 120,
  href: 300,
  ua: 400,
  vp: 24,
  build: 64,
} as const;

/**
 * Dấu hiệu của script bên thứ ba tiêm vào trang. Danh sách này phải khớp với
 * biểu thức phân loại trong migration `20260831100100_pra_errors_v2_nhom_loi.sql`
 * — bên SQL lo các dòng cũ chưa có khoá `source`, bên này lo dòng mới.
 */
export const EXTERNAL_PATTERNS: readonly RegExp[] = [
  /zalojsv2/i, // cầu nối WebView Zalo
  /zalojsbridge/i,
  /fbnavigatorbridge/i, // WebView Facebook / Messenger
  /__gcrweb/i, // Chrome iOS
  /webkit\.messagehandlers/i, // cầu nối WKWebView chung
];

const EXTENSION_SCHEME = /^(chrome|safari|moz|ms-browser)-extension:/i;

const cut = (v: unknown, max: number): string | undefined => {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s ? s.slice(0, max) : undefined;
};

const int = (v: unknown): number | undefined => {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const i = Math.trunc(v);
  return i >= 0 && i <= 999_999_999 ? i : undefined;
};

/**
 * Mốc thời gian epoch (ms) — CỬA SỔ RIÊNG, không dùng chung `int`.
 *
 * `int` chặn ở 999.999.999 vì nó dành cho số dòng/cột; epoch ms hiện tại đã là
 * ~1,78e12 nên đi qua `int` là LUÔN LUÔN bị vứt. Bản trước mắc đúng lỗi đó và
 * hậu quả không nhìn thấy được: cả đường ống `ts` (pt-boot.js → fromEarlyRecord
 * → metadata) trở thành mã chết, mà máy chủ vẫn ghi `created_at = now()` nên
 * không ai phát hiện — trong khi thứ ta cần chính là khoảng lệch giữa lúc lỗi
 * XẢY RA và lúc lô được GỬI (tối đa 8 giây, hoặc cả một phiên nếu ký gửi).
 * Cửa sổ 2001→2096 đủ rộng để không phải sửa lại, đủ hẹp để loại giá trị rác.
 */
const epochMs = (v: unknown): number | undefined => {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const i = Math.trunc(v);
  return i >= 1_000_000_000_000 && i <= 4_000_000_000_000 ? i : undefined;
};

const sameOrigin = (url: string, origin: string | undefined): boolean => {
  if (!origin) return true; // không biết origin thì đừng suy đoán
  if (url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) return true;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return true; // đường dẫn tương đối
  return url.startsWith(origin);
};

/**
 * App hay ngoài app?
 *
 * Quy tắc, theo thứ tự:
 *  - thông điệp khớp danh sách cầu nối in-app → ngoài app;
 *  - nguồn (hoặc stack) là URL của tiện ích mở rộng → ngoài app;
 *  - "Script error." trần trụi (trình duyệt giấu chi tiết vì script khác origin
 *    không có CORS) → ngoài app;
 *  - lỗi JS đến từ file khác origin → ngoài app.
 *
 * `resource` KHÔNG áp luật khác-origin: ảnh phòng nằm trên CDN, tải hỏng vẫn là
 * lỗi của mình và phải hiện ra.
 */
export function classifySource(
  input: Pick<PtErrorInput, "kind" | "msg" | "src" | "stack">,
  origin?: string,
): PtErrorSource {
  const msg = String(input.msg ?? "");
  const src = String(input.src ?? "");
  const stack = String(input.stack ?? "");

  for (const re of EXTERNAL_PATTERNS) {
    if (re.test(msg) || re.test(src) || re.test(stack)) return "external";
  }
  if (EXTENSION_SCHEME.test(src) || /(chrome|safari|moz|ms-browser)-extension:/i.test(stack)) {
    return "external";
  }
  if (/^script error/i.test(msg.trim()) && !src) return "external";
  if (input.kind === "js" && src && !sameOrigin(src, origin)) return "external";
  return "app";
}

/**
 * Vân tay FNV-1a 32-bit (hex 8 ký tự) của `kind|msg|src|line`.
 *
 * Không dùng hàm băm mã hoá: chỉ cần ổn định và rẻ, chạy được cả ở ngữ cảnh
 * không có `crypto.subtle` (WebView cũ, trang http nội bộ).
 */
export function fingerprint(parts: Pick<PtErrorInput, "kind" | "msg" | "src" | "line">): string {
  const key = [
    parts.kind,
    cut(parts.msg, LIMITS.msg) ?? "",
    cut(parts.src, LIMITS.src) ?? "",
    int(parts.line ?? undefined) ?? "",
  ].join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Chuẩn hoá + phân loại + vân tay. `n` mặc định 1, tracker sẽ tăng khi lặp. */
export function normalizeError(input: PtErrorInput, origin?: string): PtErrorMeta {
  const msg = cut(input.msg, LIMITS.msg) ?? "(không có thông điệp)";
  const src = cut(input.src, LIMITS.src);
  const line = int(input.line ?? undefined);
  const source = classifySource({ kind: input.kind, msg, src, stack: input.stack }, origin);

  const meta: PtErrorMeta = {
    kind: input.kind,
    msg,
    source,
    fp: fingerprint({ kind: input.kind, msg, src, line }),
    n: 1,
  };
  if (src) meta.src = src;
  const where = cut(input.where, LIMITS.where);
  if (where) meta.where = where;
  if (line !== undefined) meta.line = line;
  const col = int(input.col ?? undefined);
  if (col !== undefined) meta.col = col;
  const stack = cut(input.stack, LIMITS.stack);
  if (stack) meta.stack = stack;
  const href = cut(input.href, LIMITS.href);
  if (href) meta.href = href;
  const ua = cut(input.ua, LIMITS.ua);
  if (ua) meta.ua = ua;
  const vp = cut(input.vp, LIMITS.vp);
  if (vp) meta.vp = vp;
  const build = cut(input.build, LIMITS.build);
  if (build) meta.build = build;
  const ts = epochMs(input.ts ?? undefined);
  if (ts !== undefined) meta.ts = ts;
  return meta;
}

/* ── Hàng đợi bắt sớm (public/pt-boot.js) ─────────────────────────────────── */

/** Bản ghi thô do pt-boot.js đẩy vào hàng đợi — khoá ngắn để nhẹ. */
export interface EarlyErrorRecord {
  k?: string;
  msg?: string;
  src?: string;
  line?: number;
  col?: number;
  stack?: string;
  ts?: number;
}

export interface EarlyErrorQueue {
  q: EarlyErrorRecord[];
  hook: ((rec: EarlyErrorRecord) => void) | null;
}

const EARLY_KINDS: readonly string[] = ["js", "unhandledrejection", "resource"];

/**
 * Cầu nối tới `window.__ptErr` do pt-boot.js dựng TRƯỚC khi bundle chạy.
 * Trả undefined khi script chưa chạy (điều hướng SPA vào trang, môi trường test)
 * — lúc đó tracker tự gắn listener dự phòng.
 */
export function getEarlyErrorQueue(): EarlyErrorQueue | undefined {
  if (typeof window === "undefined") return undefined;
  const bag = (window as unknown as { __ptErr?: unknown }).__ptErr;
  if (!bag || typeof bag !== "object") return undefined;
  const cast = bag as Partial<EarlyErrorQueue>;
  return Array.isArray(cast.q) ? (bag as EarlyErrorQueue) : undefined;
}

/** Bản ghi thô → đầu vào chuẩn. Trả null nếu bản ghi dị dạng. */
export function fromEarlyRecord(rec: EarlyErrorRecord | null | undefined): PtErrorInput | null {
  if (!rec || typeof rec !== "object") return null;
  const kind = EARLY_KINDS.includes(String(rec.k)) ? (rec.k as PtErrorKind) : "js";
  return {
    kind,
    msg: rec.msg,
    src: rec.src,
    line: rec.line,
    col: rec.col,
    stack: rec.stack,
    ts: rec.ts,
  };
}
