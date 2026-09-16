import type { ReactNode } from "react";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";

import { reportBoundaryError } from "@/components/errors/boundaryReporter";
import { classifyDbError, type ErrorCategory } from "@/lib/contracts/errors";

/**
 * Cấu hình TanStack Query của toàn app.
 *
 * CRM nội bộ: dữ liệu 1 phút tuổi chấp nhận được. `staleTime = 0` +
 * `refetchOnWindowFocus` mặc định khiến MỌI query đang mount refetch lại mỗi lần
 * Alt-Tab — nhân 3–5 lần số request không cần thiết. Hook cần tươi hơn
 * (notifications, dashboard-stats) tự khai staleTime/refetchInterval riêng nên
 * không bị ảnh hưởng; mutation vẫn cập nhật đúng vì toàn repo dùng
 * invalidateQueries sau mutation.
 *
 * VỀ `retry: 1` — ĐÂY LÀ MỘT KHOẢNG TRỐNG ĐÃ BIẾT, ghi ra để không ai tưởng nó
 * đã được cân nhắc kỹ. Thử lại một lần cho MỌI lỗi nghĩa là một lời gọi GHI đã
 * thành công rồi hỏng ở đường về sẽ được gửi lại — trên đường tiền, đó là cách
 * tạo bút toán trùng. src/lib/contracts/envelopes.ts có `retryOnlyConcurrency`
 * làm đúng việc này theo PHÂN LOẠI lỗi; chuyển mặc định toàn cục sang nó là một
 * lượt riêng vì nó đổi hành vi của mọi query đang chạy.
 */

/**
 * Cửa sổ chống lặp toast, theo queryKey.
 *
 * Vì sao cần: hub realtime invalidate hàng chục key một lúc (một `create_contract_v2`
 * chạm 5 bảng → ~70 key). Mất mạng đúng lúc đó mà mỗi query một toast thì người
 * dùng nhận một bức tường thông báo và học được đúng một việc: bấm tắt không đọc.
 * 10 giây đủ để một cơn bão gộp về một dòng, và vẫn đủ ngắn để lần hỏng tiếp
 * theo sau khi người dùng thao tác lại được báo lại.
 */
export const KHOANG_LAP_TOAST_MS = 10_000;

const daBaoGanDay = new Map<string, number>();

export function nenBaoLoi(
  khoa: string,
  mocMs: number,
  bo: Map<string, number> = daBaoGanDay,
): boolean {
  const truoc = bo.get(khoa);
  if (truoc !== undefined && mocMs - truoc < KHOANG_LAP_TOAST_MS) return false;
  bo.set(khoa, mocMs);
  return true;
}

interface TruyVanLoi {
  queryKey: unknown;
  meta?: Record<string, unknown>;
}

/**
 * Thông điệp cho đường ĐỌC. Cố ý KHÔNG dùng `src/lib/friendlyError.ts`: catalogue
 * ở đó viết cho đường GHI ("Trùng dữ liệu", "Thiếu thông tin bắt buộc") và những
 * câu đó vô nghĩa khi một lần tải danh sách hỏng.
 *
 * Điều người đọc cần biết gọn trong hai ý: có phải do quyền không, và có đáng
 * thử lại không.
 */
export function thongDiepLoiDoc(error: unknown): string {
  const loi = error as { message?: unknown } | null;
  const tin = typeof loi?.message === "string" ? loi.message : "";
  if (/Failed to fetch|NetworkError|network error|ERR_INTERNET/i.test(tin)) {
    return "Mất kết nối — chưa tải được dữ liệu";
  }
  const nhom: ErrorCategory = classifyDbError(error);
  if (nhom === "permission") return "Không có quyền xem dữ liệu này";
  if (nhom === "concurrency" || nhom === "rate_limit") return "Hệ thống đang bận — thử lại sau giây lát";
  if (nhom === "internal_invariant") return "Trang đang cũ hơn máy chủ — tải lại trang";
  return "Không tải được dữ liệu";
}

/**
 * Đón MỌI lỗi query đọc ở một chỗ.
 *
 * Trước 15/09/2026 chỗ này không tồn tại, nên 42 hook đọc chọn cách "an toàn"
 * là trả `[]`/`null` — lỗi biến mất và màn hình hiện "không có dữ liệu". Đổi
 * chúng sang `throw` chỉ có nghĩa khi có người đón; nếu không thì lỗi vẫn im,
 * chỉ đổi chỗ im.
 *
 * `meta: { silent: true }` cho query được phép im với NGƯỜI DÙNG (prefetch,
 * thăm dò tính năng tuỳ chọn) — nhưng vẫn báo lên `reportBoundaryError`, vì im
 * với người dùng không có nghĩa là im với nhật ký.
 */
export function xuLyLoiQuery(
  error: unknown,
  query: TruyVanLoi,
  phuThuoc?: { bo?: Map<string, number>; now?: () => number },
): void {
  try {
    const goc = error as { message?: string } | null;
    const loi =
      error instanceof Error
        ? error
        : Object.assign(new Error(String(goc?.message ?? error)), { cause: error });
    reportBoundaryError(loi);

    if (query.meta?.silent === true) return;

    const khoa = JSON.stringify(query.queryKey ?? null);
    const now = phuThuoc?.now ?? Date.now;
    if (!nenBaoLoi(khoa, now(), phuThuoc?.bo ?? daBaoGanDay)) return;

    toast.error(thongDiepLoiDoc(error), {
      description: `Mục dữ liệu: ${khoa}. Thao tác lại hoặc tải lại trang; nếu vẫn lỗi, gửi dòng này cho quản trị.`,
    });
  } catch {
    /* bộ báo lỗi không được tự làm sập app — nuốt ở ĐÚNG chỗ này là có chủ ý */
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => xuLyLoiQuery(error, query as unknown as TruyVanLoi),
  }),
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export function QueryProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
