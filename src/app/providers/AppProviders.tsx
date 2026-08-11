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
 *
 * VÌ SAO KHÔNG TÁCH RIÊNG `RealtimeProviders.tsx` — quyết định 08/08/2026
 *   Plan liệt kê một file riêng cho nhóm realtime. Cố ý KHÔNG tách, và ghi ở đây
 *   để lần sau không ai coi đó là việc bỏ quên:
 *
 *   Hiện có ĐÚNG HAI listener (`RealtimeDataSync`, `NotificationsRealtime`), và cả
 *   hai bị ràng buộc bởi chính hợp đồng thứ tự lồng nhau ở trên — chúng phải nằm
 *   trong `QueryProvider` và trong `ErrorBoundary`. Tách ra file khác không gỡ được
 *   ràng buộc đó; nó chỉ chuyển ràng buộc sang một chỗ mà người đọc AppProviders
 *   không còn nhìn thấy. Đổi một file 52 dòng đọc hết trong một màn hình lấy hai
 *   file phải đọc chéo là lỗ, không phải lãi.
 *
 *   ĐIỀU KIỆN ĐỔI Ý: khi có listener realtime THỨ BA. Lúc đó nhóm đủ lớn để tên
 *   file mang thông tin, và việc đọc chéo mới trả đủ giá.
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
