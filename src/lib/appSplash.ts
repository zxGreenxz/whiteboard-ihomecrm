/**
 * Ẩn splash tức thì (#app-splash trong index.html) khi app đã sẵn sàng hiển thị
 * nội dung trang đầu. Gọi từ các trang "vào đầu tiên" (Login / Home launcher /
 * Dashboard) khi mount. main.tsx cũng đặt timeout an toàn để splash không kẹt.
 */
let hidden = false;

export function hideAppSplash(): void {
  if (hidden) return;
  hidden = true;
  const el = document.getElementById('app-splash');
  if (!el) return;
  el.style.opacity = '0';
  el.style.pointerEvents = 'none';
  // Gỡ khỏi DOM sau khi fade xong (khớp transition .28s).
  window.setTimeout(() => el.remove(), 320);
}
