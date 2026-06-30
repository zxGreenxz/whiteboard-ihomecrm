// =============================================================================
// chunkReload — phục hồi khi chunk lazy bị 404 sau một lần deploy mới (stale
// chunk): tự reload trang để lấy index.html mới.
//
// Guard bằng sessionStorage để KHÔNG bao giờ rơi vào vòng lặp reload:
//   - Cho phép tối đa MAX_ATTEMPTS lần reload trong cửa sổ WINDOW_MS (mở rộng
//     60s → 180s + 2 lần) để vẫn tự phục hồi khi lần load lại đầu tiên rơi
//     đúng lúc CDN còn phục vụ bản cũ / mạng chập chờn giữa lúc rolling deploy.
//   - Hết lượt (hoặc sessionStorage bị chặn ở privacy mode) → trả về false để
//     ErrorBoundary hiện thẻ "có phiên bản mới" + nút "Tải lại" THỦ CÔNG thay vì
//     kẹt màn trắng hay reload vô hạn.
// =============================================================================

const KEY = 'chunk-reload';
const WINDOW_MS = 180_000; // 3 phút
const MAX_ATTEMPTS = 2;

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

/**
 * Reload tối đa MAX_ATTEMPTS lần trong WINDOW_MS. Trả về true nếu ĐÃ kích hoạt
 * reload, false nếu đã hết lượt hoặc không ghi được guard (để hiện nút thủ công).
 */
export function reloadOnceForStaleChunk(): boolean {
  const s = readState();
  if (s.count >= MAX_ATTEMPTS) return false;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), count: s.count + 1 }));
  } catch {
    // Không ghi được guard (privacy mode) → KHÔNG auto-reload để tránh vòng lặp;
    // user vẫn có nút "Tải lại" thủ công ở ErrorBoundary.
    return false;
  }
  window.location.reload();
  return true;
}

/** Nhận diện lỗi load chunk động trên Chrome / Firefox / Safari. */
export function isChunkLoadError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '');
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Failed to load module script/i.test(
    msg
  );
}
