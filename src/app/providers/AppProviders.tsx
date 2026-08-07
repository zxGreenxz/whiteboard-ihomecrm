import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ErrorBoundary from "@/components/errors/ErrorBoundary";
import { RealtimeDataSync } from "@/hooks/useRealtimeDataSync";
import { NotificationsRealtime } from "@/hooks/useNotifications";
import { AuthCacheSync } from "./AuthCacheSync";
import { QueryProvider } from "./QueryProvider";

/**
 * Mọi provider cấp app, gom một chỗ — P1.2 của plan.
 *
 * THỨ TỰ LỒNG NHAU Ở ĐÂY LÀ HỢP ĐỒNG, KHÔNG PHẢI THẨM MỸ
 *   `AuthCacheSync`, `RealtimeDataSync` và `NotificationsRealtime` đều gọi
 *   `useQueryClient()`, nên chúng BẮT BUỘC nằm trong `QueryProvider`. Đặt nhầm ra
 *   ngoài thì lỗi chỉ xuất hiện lúc chạy, ở lần render đầu, dưới dạng "No
 *   QueryClient set" — tức trắng màn hình ngay khi mở app.
 *
 *   `ErrorBoundary` bọc ba cái đó để một lỗi trong listener realtime không hạ cả
 *   cây, nhưng nằm TRONG QueryProvider chứ không ngoài — nếu không, chính lỗi
 *   thiếu QueryClient lại không có ai bắt.
 *
 * VÌ SAO KHÔNG CÓ BrowserRouter Ở ĐÂY
 *   Router thuộc về phần ĐIỀU HƯỚNG, và test render một màn lẻ thường muốn dựng
 *   provider mà tự cấp `MemoryRouter` của mình. Gộp vào đây sẽ buộc mọi test phải
 *   nhận cả BrowserRouter thật.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <TooltipProvider>
        <ErrorBoundary>
          <Toaster />
          <Sonner />
          {/* Listener auth giữ cache ['auth','user'] / ['auth','session'] tươi.
              Trước đây đăng ký ở module scope ngay trong App.tsx và vứt luôn
              subscription; xem AuthCacheSync để biết vì sao phải có cleanup. */}
          <AuthCacheSync />
          {/* Hub realtime nghiệp vụ: invalidate + hâm cache prefetch khi
              invoices/income_expenses/contracts/jobs/customers đổi. */}
          <RealtimeDataSync />
          {/* Kênh realtime RIÊNG cho hộp thư: hub trên không khai được filter nên
              mỗi thông báo của một người sẽ đánh thức tất cả. Kênh này lọc
              user_id=eq.<uid> ngay ở server. */}
          <NotificationsRealtime />
          {children}
        </ErrorBoundary>
      </TooltipProvider>
    </QueryProvider>
  );
}
