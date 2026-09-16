// =============================================================
// Hai cửa chặn cho lượt prefetch mà HUB REALTIME gọi.
// (15/09/2026, plan con B của đợt rà soát toàn hệ thống.)
//
// prefetchDomain sinh ra để giữ cache trang danh sách nặng luôn ấm KHI NGƯỜI
// DÙNG ĐANG Ở MÀN KHÁC. Hub gọi lại nó sau mỗi lần invalidate, và ở đó nó thừa
// theo hai cách:
//
//   1. ĐANG Ở CHÍNH TRANG ĐÓ. invalidateQueries vừa refetch đúng những query ấy
//      rồi; prefetch lặp lại y hệt bộ query (list + statistics) bằng key trùng.
//      React Query có dedupe trong cửa sổ rất hẹp, nhưng hai lượt cách nhau vài
//      chục ms thì không trúng — thành hai lượt RPC thật.
//
//   2. BÃO SỰ KIỆN. Debounce của hub gom theo TỪNG BẢNG, mà một domain có nhiều
//      bảng (miền tiền: invoices/income_expenses/payments/items/accounts…). Một
//      thao tác chạm 5 bảng ⇒ 5 lần flush ⇒ 5 lượt prefetch cùng domain, lệch
//      nhau vài trăm ms. Throttle theo domain cắt cụm đó về một.
//
// Cả hai cửa đều FAIL-OPEN: không đọc được route thì coi như đang ở màn khác và
// vẫn prefetch — hành vi cũ. Một lần đổi đường dẫn route mà quên sửa bảng dưới
// đây thì hậu quả xấu nhất là mất phần tiết kiệm, không phải mất dữ liệu.
// =============================================================

import type { PrefetchDomain } from "@/lib/prefetchPages";

/** Khoảng cách tối thiểu giữa hai lượt prefetch CÙNG domain do hub kích hoạt. */
export const THROTTLE_PREFETCH_MS = 10_000;

/**
 * Đường dẫn route của từng domain — nguồn: src/app/routes/financeWorkRoutes.tsx
 * và customerRoutes.tsx. Bản mobile dùng CHUNG route với bản desktop (trang tự
 * đổi theo viewport), nên mỗi domain đúng một đường dẫn.
 */
const DUONG_DAN_DOMAIN: Record<PrefetchDomain, string> = {
  invoices: "/invoices",
  "income-expenses": "/income-expense",
  contracts: "/contracts",
  jobs: "/tasks",
};

const mocPrefetchCuoi = new Map<PrefetchDomain, number>();

function dangDungOTrang(domain: PrefetchDomain): boolean {
  if (typeof window === "undefined") return false;
  const duongDan = window.location?.pathname;
  if (typeof duongDan !== "string") return false;
  const route = DUONG_DAN_DOMAIN[domain];
  return duongDan === route || duongDan.startsWith(`${route}/`);
}

/**
 * Có nên để hub hâm lại cache prefetch của domain này không.
 *
 * GHI SỔ NGAY khi trả `true` — người gọi nạp prefetchPages bằng dynamic import,
 * nên nếu đợi tới lúc module về mới ghi thì hai event sát nhau đều lọt cửa.
 */
export function nenPrefetchTuHub(domain: PrefetchDomain): boolean {
  if (dangDungOTrang(domain)) return false;
  const bayGio = Date.now();
  const truoc = mocPrefetchCuoi.get(domain);
  if (truoc !== undefined && bayGio - truoc < THROTTLE_PREFETCH_MS) return false;
  mocPrefetchCuoi.set(domain, bayGio);
  return true;
}

/** Dọn sổ mốc — chỉ dùng trong test, vì Map này ở cấp module. */
export function __resetPrefetchGateForTest(): void {
  mocPrefetchCuoi.clear();
}
