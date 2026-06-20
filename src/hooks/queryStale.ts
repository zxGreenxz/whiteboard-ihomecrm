// Hằng staleTime dùng chung cho React Query.
// - STALE_LIVE: dữ liệu danh sách biến động (hợp đồng/khách/hoá đơn) — bằng
//   default global của QueryClient, khai báo tường minh để rõ ý + giúp prefetch
//   dedupe (prefetch rồi mount trong khoảng này không refetch lần 2).
// - STALE_SLOW: dữ liệu tham chiếu ít đổi (buildings/rooms) — sống lâu hơn để
//   điều hướng qua lại không gọi lại mạng.
export const STALE_LIVE = 60_000;
export const STALE_SLOW = 5 * 60_000;
