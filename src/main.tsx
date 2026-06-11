import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { reloadOnceForStaleChunk } from "./lib/chunkReload";

// Sau mỗi lần deploy, chunk hash cũ bị 404 khi điều hướng → Vite bắn
// vite:preloadError. Tự reload để lấy index.html mới; nếu guard chống loop
// từ chối (đã reload trong vòng 1 phút) thì để lỗi rơi xuống ErrorBoundary.
window.addEventListener("vite:preloadError", (event) => {
  if (reloadOnceForStaleChunk()) event.preventDefault();
});

createRoot(document.getElementById("root")!).render(<App />);
