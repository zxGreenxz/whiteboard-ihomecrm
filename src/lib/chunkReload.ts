// =============================================================================
// chunkReload — phục hồi khi chunk lazy bị lỗi sau một lần deploy mới.
//
// NGUYÊN NHÂN GỐC (đo trên prod 2026-07-01): request tới một file
// `/assets/<hash>.js` KHÔNG tồn tại (chunk của deploy cũ đã bị gỡ, hoặc edge
// miss trong lúc rolling deploy) bị SPA-rewrite `/(.*) → /index.html` nuốt và
// trả về **index.html (text/html) status 200**, NHƯNG vì path khớp `/assets/*`
// nên bị đóng header `Cache-Control: immutable, max-age=1 năm`. Trình duyệt cache
// "HTML giả" dưới URL của file JS đó → mọi lần load sau:
//   - `import()` nhận text/html → "Expected a JavaScript module... MIME text/html"
//   - `location.reload()` (F5) KHÔNG revalidate subresource còn-fresh + immutable
//     → reload VÔ ÍCH; chỉ "xoá cache" thủ công mới gỡ được entry độc.
//
// CÁCH CHỮA: trước khi reload, chủ động `fetch(url, { cache: 'reload' })` các URL
// nghi độc (chunk lỗi trong message + các <link rel=modulepreload> Vite chèn vào
// DOM lúc fail). `cache:'reload'` BỎ QUA cache đọc VÀ GHI ĐÈ entry bằng response
// tươi từ network → nếu file nay đã có (200 JS) thì entry độc bị thay, reload kế
// tiếp import thành công. Nếu chunk mất hẳn (deploy cũ) thì reload lấy index.html
// mới → main bundle mới không còn trỏ tới chunk cũ nữa.
//
// Guard sessionStorage để KHÔNG bao giờ lặp reload vô hạn (tối đa MAX_ATTEMPTS
// lần trong WINDOW_MS). Hết lượt (hoặc privacy mode chặn sessionStorage) → trả
// về false để ErrorBoundary hiện thẻ "có phiên bản mới" + nút "Tải lại" thủ công.
// =============================================================================

const KEY = 'chunk-reload';
const WINDOW_MS = 180_000; // 3 phút
const MAX_ATTEMPTS = 2;
const BUST_TIMEOUT_MS = 2_000; // trần thời gian bust cache trước khi reload dù sao

interface ReloadState {
  at: number;
  count: number;
}

function readState(): ReloadState {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return { at: 0, count: 0 };
    const s = JSON.parse(raw) as ReloadState;
    // Quá cửa sổ → coi như đợt mới, reset bộ đếm.
    if (Date.now() - s.at > WINDOW_MS) return { at: 0, count: 0 };
    return s;
  } catch {
    return { at: 0, count: 0 };
  }
}

/** Rút URL file .js (nếu có) từ message lỗi import động của Chrome/FF/Safari. */
export function extractChunkUrl(err: unknown): string | undefined {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '');
  const m = msg.match(/https?:\/\/[^\s"')]+?\.[mc]?js\b/i);
  return m?.[0];
}

/**
 * Gom các URL nghi bị "poison" cache: chunk lỗi + mọi <link rel=modulepreload>
 * (Vite chèn dep của route lazy vào <head> ngay trước khi import — đây chính là
 * các file phát sinh lỗi "Failed to load module script"). CHỈ lấy same-origin.
 */
function collectSuspectUrls(failingUrl?: string): string[] {
  const urls = new Set<string>();
  if (failingUrl) urls.add(failingUrl);
  try {
    const links = document.querySelectorAll<HTMLLinkElement>(
      'link[rel="modulepreload"][href], link[rel="preload"][as="script"][href]'
    );
    links.forEach((l) => {
      if (l.href && l.href.startsWith(window.location.origin)) urls.add(l.href);
    });
  } catch {
    /* DOM chưa sẵn sàng — bỏ qua, vẫn còn failingUrl */
  }
  return [...urls];
}

/**
 * Ghi đè các entry cache độc bằng response tươi từ network. Best-effort: lỗi
 * mạng/CORS đều nuốt, vì bước reload phía sau mới là chốt chặn.
 */
async function bustPoisonedCache(failingUrl?: string): Promise<void> {
  const urls = collectSuspectUrls(failingUrl);
  if (urls.length === 0) return;
  await Promise.allSettled(
    urls.map((u) => fetch(u, { cache: 'reload', credentials: 'same-origin' }))
  );
}

/**
 * Phục hồi stale/poisoned chunk: bust cache độc rồi reload, tối đa MAX_ATTEMPTS
 * lần trong WINDOW_MS. Trả về true nếu ĐÃ kích hoạt phục hồi, false nếu hết lượt
 * hoặc không ghi được guard (để ErrorBoundary hiện nút "Tải lại" thủ công).
 *
 * @param err lỗi gốc (nếu có) để rút URL chunk hỏng cần bust.
 */
export function reloadOnceForStaleChunk(err?: unknown): boolean {
  const s = readState();
  if (s.count >= MAX_ATTEMPTS) return false;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), count: s.count + 1 }));
  } catch {
    // Không ghi được guard (privacy mode) → KHÔNG auto-reload để tránh vòng lặp;
    // user vẫn có nút "Tải lại" thủ công ở ErrorBoundary.
    return false;
  }
  const failingUrl = extractChunkUrl(err);
  // Bust cache (có trần thời gian) RỒI reload — không bao giờ treo trước reload.
  void Promise.race([
    bustPoisonedCache(failingUrl),
    new Promise<void>((resolve) => window.setTimeout(resolve, BUST_TIMEOUT_MS)),
  ]).finally(() => window.location.reload());
  return true;
}

/** Nhận diện lỗi load chunk động trên Chrome / Firefox / Safari. */
export function isChunkLoadError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '');
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Failed to load module script/i.test(
    msg
  );
}
