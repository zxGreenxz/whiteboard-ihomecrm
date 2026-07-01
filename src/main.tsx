import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { reloadOnceForStaleChunk } from "./lib/chunkReload";
import { hideAppSplash } from "./lib/appSplash";
import { registerServiceWorker } from "./lib/push";
import { initPerfTrace } from "./lib/perfTrace";

// Lưu vết hiệu năng (đo request Supabase chậm + tổng hợp __perfReport()).
initPerfTrace();

// Sau mỗi lần deploy, chunk hash cũ bị 404/poisoned khi điều hướng → Vite bắn
// vite:preloadError (event.payload = lỗi gốc). Bust cache độc + reload lấy
// index.html mới; nếu guard chống loop từ chối thì để lỗi rơi xuống ErrorBoundary.
window.addEventListener("vite:preloadError", (event) => {
  const payload = (event as Event & { payload?: unknown }).payload;
  if (reloadOnceForStaleChunk(payload)) event.preventDefault();
});

createRoot(document.getElementById("root")!).render(<App />);

// Lưới an toàn: nếu trang đầu chưa kịp gọi hideAppSplash (lỗi/route lạ),
// vẫn ẩn splash sau 4.5s để không bao giờ kẹt màn chờ.
window.setTimeout(hideAppSplash, 4500);

// Đăng ký service worker (PWA + Web Push). Không chặn render.
window.addEventListener("load", () => {
  registerServiceWorker();
});
