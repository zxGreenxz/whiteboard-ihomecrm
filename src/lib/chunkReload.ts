// =============================================================================
// chunkReload — phục hồi khi chunk lazy bị 404 sau một lần deploy mới (stale
// chunk): tự reload trang để lấy index.html mới. Guard bằng sessionStorage để
// không bao giờ rơi vào vòng lặp reload (tối đa 1 lần/phút); lần lỗi thứ hai
// trong cửa sổ guard sẽ rơi xuống UI lỗi của ErrorBoundary như cũ.
// =============================================================================

const KEY = 'chunk-reload-at';
const WINDOW_MS = 60_000;

/** Reload tối đa 1 lần/phút. Trả về true nếu đã kích hoạt reload. */
export function reloadOnceForStaleChunk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < WINDOW_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // sessionStorage bị chặn (privacy mode) → vẫn reload, chấp nhận mất guard
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
