// =============================================================
// usePrefetchHeavyPages — mount ở màn chính (Dashboard desktop +
// HomeLauncher mobile). Sau khi màn chính settle, tranh thủ lúc rảnh
// (requestIdleCallback) tải nền trang đầu + stats của các trang danh sách
// nặng (xem src/lib/prefetchPages.ts) để bấm vào là hiện ngay.
//
// Chạy tối đa 1 lần mỗi phiên (cờ module-level) — việc giữ cache TƯƠI sau đó
// do realtime hub (useRealtimeDataSync) đảm nhiệm, không cần prefetch lại
// mỗi lần quay về màn chính.
// =============================================================

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMyPermissions } from "@/hooks/useMyPermissions";

let ranThisSession = false;

export function usePrefetchHeavyPages() {
  const queryClient = useQueryClient();
  const { data: perms } = useMyPermissions();

  useEffect(() => {
    if (!perms || ranThisSession) return;

    const run = () => {
      ranThisSession = true;
      // Import động: prefetchPages kéo theo hooks của 4 trang — không nhét
      // vào chunk màn chính, chỉ tải khi thật sự chạy prefetch (lúc idle).
      import("@/lib/prefetchPages")
        .then((m) => m.prefetchHeavyPages(queryClient, perms))
        .catch(() => {});
    };

    // Nhường màn chính tải xong trước — chạy lúc idle, trần 4s để không
    // chờ vô hạn trên trang bận. Safari chưa có requestIdleCallback → setTimeout.
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof w.requestIdleCallback === "function") {
      const id = w.requestIdleCallback(run, { timeout: 4000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(run, 1500);
    return () => clearTimeout(t);
  }, [perms, queryClient]);
}
