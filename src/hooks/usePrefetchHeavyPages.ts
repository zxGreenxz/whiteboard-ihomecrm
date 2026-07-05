// =============================================================
// usePrefetchHeavyPages — mount ở màn chính (Dashboard desktop +
// HomeLauncher mobile). Sau khi màn chính settle, tranh thủ lúc rảnh
// (requestIdleCallback) tải nền trang đầu + stats của các trang danh sách
// nặng (xem src/lib/prefetchPages.ts) để bấm vào là hiện ngay.
//
// HÂM LẠI mỗi lần về màn chính, throttle 60s (trước đây chặn vĩnh viễn 1 lần/
// phiên → cache prefetch bị GC sau ~5' mà KHÔNG được nạp lại khi quay về Home,
// nên bấm vào lại "Đang tải"). prefetchQuery tôn trọng staleTime 60s nên lần
// hâm sau gần như miễn phí (data còn tươi = no-op); warmedChunks đã warm chunk
// từ lần đầu nên không parse lại (an toàn với bug giật màn 04/07).
// =============================================================

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useMyPermissions } from "@/hooks/useMyPermissions";

let lastPrefetchAt = 0;
const REWARM_THROTTLE_MS = 60_000;

export function usePrefetchHeavyPages() {
  const queryClient = useQueryClient();
  const { data: perms } = useMyPermissions();

  useEffect(() => {
    if (!perms) return;
    if (Date.now() - lastPrefetchAt < REWARM_THROTTLE_MS) return;

    const run = () => {
      lastPrefetchAt = Date.now();
      // Import động: prefetchPages kéo theo hooks của 4 trang — không nhét
      // vào chunk màn chính, chỉ tải khi thật sự chạy prefetch (lúc idle).
      import("@/lib/prefetchPages")
        .then((m) => m.prefetchHeavyPages(queryClient, perms))
        .catch(() => {});
    };

    // Nhường màn chính tải xong trước — chạy lúc idle, trần 4s để không
    // chờ vô hạn trên trang bận. Safari chưa có requestIdleCallback → setTimeout;
    // trên PHONE lùi hẳn 3s: burst 1.5s từng trúng đúng nhịp entrance fade của
    // màn chính khi quay lại → parse chunk chặn main thread giữa fade = "giật
    // màn hình" (bug 04/07). 3s = màn đã đứng yên, khựng nhẹ không thấy được.
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof w.requestIdleCallback === "function") {
      const id = w.requestIdleCallback(run, { timeout: 4000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const isPhone = window.matchMedia("(max-width: 767px)").matches;
    const t = setTimeout(run, isPhone ? 3000 : 1500);
    return () => clearTimeout(t);
  }, [perms, queryClient]);
}
