import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
export const queryClient = new QueryClient({
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
