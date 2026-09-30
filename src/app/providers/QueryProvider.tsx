import type { ReactNode } from "react";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";

import { reportBoundaryError } from "@/components/errors/boundaryReporter";
import { classifyDbError, type ErrorCategory } from "@/lib/contracts/errors";
import { notifyActionError } from "@/lib/asyncActionFeedback";

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
 * Query đọc được thử lại một lần. Mutation ghi không tự thử lại; kết quả
 * chưa rõ cần đối chiếu theo ID giao dịch trước khi người dùng gửi tiếp.
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
  fetch?: () => Promise<unknown>;
}

/**
 * Thông điệp cho đường ĐỌC. Cố ý KHÔNG dùng `src/lib/friendlyError.ts`: catalogue
 * ở đó viết cho đường GHI ("Trùng dữ liệu", "Thiếu thông tin bắt buộc") và những
 * câu đó vô nghĩa khi một lần tải danh sách hỏng.
 *
 * Điều người đọc cần biết gọn trong hai ý: có phải do quyền không, và có đáng
 * thử lại không.
 */
/** Câu chung khi không phân loại được lỗi đọc — màn nào có câu riêng thì so với nó. */
export const LOI_DOC_MAC_DINH = "Không tải được dữ liệu";

export function thongDiepLoiDoc(error: unknown): string {
  const loi = error as { message?: unknown } | null;
  const tin = typeof loi?.message === "string" ? loi.message : "";
  // "Load failed" là cách Safari/iPhone báo mất mạng (Chrome nói "Failed to fetch").
  // \b để "upload failed"/"download failed" (lỗi nghiệp vụ) không bị đọc thành mất mạng.
  if (/Failed to fetch|\bLoad failed|NetworkError|network error|ERR_INTERNET/i.test(tin)) {
    return "Mất kết nối — chưa tải được dữ liệu";
  }
  const nhom: ErrorCategory = classifyDbError(error);
  if (nhom === "permission") return "Không có quyền xem dữ liệu này";
  if (nhom === "concurrency" || nhom === "rate_limit") return "Hệ thống đang bận — thử lại sau giây lát";
  if (nhom === "internal_invariant") return "Chưa tải được dữ liệu do lỗi hệ thống; tải lại trang";
  return LOI_DOC_MAC_DINH;
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

    if (query.meta?.silent === true || query.meta?.errorDisplay === 'inline' || query.meta?.feedback === 'inline') return;

    const khoa = JSON.stringify(query.queryKey ?? null);
    const now = phuThuoc?.now ?? Date.now;
    if (!nenBaoLoi(khoa, now(), phuThuoc?.bo ?? daBaoGanDay)) return;

    const showToast = (label: string) => {
      try {
        toast.error(`Chưa tải được ${label}.`, {
          description: `${thongDiepLoiDoc(error)}.`,
          ...(query.fetch ? { action: { label: "Tải lại", onClick: () => { void query.fetch!().catch(() => { /* QueryCache reports the next read failure. */ }); } } } : {}),
        });
      } catch {
        /* A broken toast sink must not reject the asynchronous feedback handler. */
      }
    };
    void import("@/lib/queryFeedback")
      .then(({ queryLabel }) => showToast(queryLabel(query.queryKey, query.meta?.label)))
      .catch(cause => {
        try {
          reportBoundaryError(cause instanceof Error ? cause : Object.assign(new Error('Query feedback labels failed to load'), { cause }));
        } catch {
          /* Diagnostics cannot prevent the safe fallback toast. */
        }
        showToast('dữ liệu của mục đang mở');
      });
  } catch {
    /* bộ báo lỗi không được tự làm sập app — nuốt ở ĐÚNG chỗ này là có chủ ý */
  }
}

export const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      // A form/hook with its own handler owns the result. Explicitly silent
      // background operations remain silent; diagnostics still retain cause.
      reportBoundaryError(error instanceof Error ? error : Object.assign(new Error('Mutation failed'), { cause: error }));
      if (mutation.options.onError || mutation.meta?.silent || mutation.meta?.handlesFeedback) return;
      const operation = typeof mutation.meta?.operation === 'string' ? mutation.meta.operation : undefined;
      notifyActionError(error, operation ? `Chưa ${operation}.` : 'Chưa hoàn tất thao tác đang thực hiện', { operation, financial: mutation.meta?.financial === true });
    },
  }),
  queryCache: new QueryCache({
    onError: (error, query) => xuLyLoiQuery(error, query as unknown as TruyVanLoi),
  }),
  defaultOptions: {
    mutations: { retry: false },
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
