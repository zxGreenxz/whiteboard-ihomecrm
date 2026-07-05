// =============================================================
// prefetchOnIntent — nạp nền theo Ý ĐỊNH của người dùng.
//
// Rê chuột / focus (desktop) hoặc chạm (mobile) vào mục menu của 1 trong 4 trang
// list nặng → nạp NGAY data + chunk để cú bấm ngay sau ra dữ liệu tức thì thay vì
// "Đang tải". Bổ trợ cho prefetch-1-lần-ở-màn-chính (usePrefetchHeavyPages): phủ
// MỌI đường vào — kể cả khi đi thẳng giữa các trang mà không ghé lại Bảng tin,
// hay lúc cache đã nguội (gcTime).
//
// Rẻ & ít egress: prefetchDomain idempotent — warm chunk có guard (warmedChunks),
// prefetchQuery tôn trọng staleTime 60s (data còn tươi = KHÔNG bắn request). Thêm
// throttle 5s/domain trong RAM để rê lướt qua nhiều mục không spam import động.
// =============================================================

import type { QueryClient } from "@tanstack/react-query";
import type { PrefetchDomain } from "./prefetchPages";

// href sidebar/launcher → domain prefetch. Chỉ 4 trang được nạp nền; href khác
// (thu-tien, sổ quỹ, báo cáo…) không map → bỏ qua.
const HREF_TO_DOMAIN: Record<string, PrefetchDomain> = {
  "/invoices": "invoices",
  "/income-expense": "income-expenses",
  "/contracts": "contracts",
  "/tasks": "jobs",
};

const lastAt = new Map<PrefetchDomain, number>();
const THROTTLE_MS = 5_000;

/** Nạp nền domain ứng với href (nếu là 1 trong 4 trang list). Idempotent + throttle. */
export function prefetchOnIntent(qc: QueryClient, href: string): void {
  const domain = HREF_TO_DOMAIN[href];
  if (!domain) return;
  const now = Date.now();
  if (now - (lastAt.get(domain) ?? 0) < THROTTLE_MS) return;
  lastAt.set(domain, now);
  // Import động: prefetchPages kéo theo hooks 4 trang — không nhét vào chunk layout.
  import("./prefetchPages")
    .then((m) => m.prefetchDomain(qc, domain))
    .catch(() => {});
}
