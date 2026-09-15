// Route guard — redirect về `/` nếu caller KHÔNG CÓ (module, action).
//
// BA TRẠNG THÁI, chỉ MỘT được phép chuyển hướng
//   Chuyển hướng là một KẾT LUẬN: "bạn không có quyền vào đây". Chỉ kết luận
//   được khi đã đọc được quyền. Trước 15/09/2026 guard chỉ tách "đang tải" với
//   "phần còn lại", mà useMyPermissions lại trả `{}` khi RPC lỗi — nên một lần
//   5xx / đứt mạng / JWT vừa hết hạn đọc ra y hệt "không có quyền gì" và người
//   dùng bị đá về `/`. Im lặng, không nút thử lại, và vì query vẫn ở trạng thái
//   success nên cũng không tự retry.
//
//   Nay: isPending → skeleton · isError → màn có nút thử lại · có dữ liệu →
//   mới xét quyền. `{}` giờ CHỈ còn nghĩa "đã đọc được và thật sự không có
//   quyền" (xem useMyPermissions.fetchMyPermissions).
//
// Pattern:
//   <Route element={<ProtectedRoute>
//     <RequirePermission module="invoices" action="view">
//       <InvoicesPage />
//     </RequirePermission>
//   </ProtectedRoute>} />
//
// Super admin & owner (__superadmin sentinel) tự động pass.
// Check qua canUse (catalog permissionPages.ts) — key chi tiết chưa tồn tại
// trong JSONB cũ sẽ fallback về quyền legacy, nhân viên hiện hữu không bị
// khoá đột ngột.

import { Navigate } from "react-router-dom";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import type { ActionKey } from "@/lib/permissions";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

interface RequirePermissionProps {
  module: string;
  action?: ActionKey;
  /** Redirect path khi thiếu quyền. Mặc định `/`. */
  fallbackPath?: string;
  children: React.ReactNode;
}

export function RequirePermission({
  module,
  action = "view",
  fallbackPath = "/",
  children,
}: RequirePermissionProps) {
  const { data: perms, isPending, isError, refetch } = useMyPermissions();

  if (isPending) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-6 space-y-3">
        <h2 className="text-lg font-semibold">Không tải được quyền</h2>
        <p className="text-sm text-muted-foreground">
          Chưa đọc được danh sách quyền của tài khoản nên chưa mở được trang này. Đây là
          lỗi tải dữ liệu, không phải bạn bị thu hồi quyền.
        </p>
        <Button type="button" variant="outline" onClick={() => refetch()}>
          Thử lại
        </Button>
      </div>
    );
  }

  if (!canUse(perms, module, action)) {
    return <Navigate to={fallbackPath} replace />;
  }

  return <>{children}</>;
}
