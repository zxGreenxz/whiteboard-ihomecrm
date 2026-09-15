// Route guard — redirect về `/` nếu caller không có (module, action).
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
//
// Route của MỘT TOÀ thì truyền `buildingId` (thường từ `useParams`) để guard
// hỏi đúng toà đó — xem `canUse`. Không truyền = câu hỏi yếu hơn, đúng cho
// route không gắn toà.

import { Navigate } from "react-router-dom";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import type { ActionKey } from "@/lib/permissions";
import { Skeleton } from "@/components/ui/skeleton";

interface RequirePermissionProps {
  module: string;
  action?: ActionKey;
  /**
   * Toà nhà mà route này đang đứng trên đó.
   *
   * Truyền vào thì guard hỏi câu ĐẦY ĐỦ ("được làm việc đó TRÊN TOÀ NÀY
   * không") thay vì câu yếu ("có quyền ở đâu đó không"). Route không gắn toà
   * nào thì bỏ trống — hành vi giữ nguyên như trước.
   */
  buildingId?: string | null;
  /** Redirect path khi thiếu quyền. Mặc định `/`. */
  fallbackPath?: string;
  children: React.ReactNode;
}

export function RequirePermission({
  module,
  action = "view",
  buildingId,
  fallbackPath = "/",
  children,
}: RequirePermissionProps) {
  const { data: perms, isLoading } = useMyPermissions();

  if (isLoading) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!canUse(perms, module, action, buildingId)) {
    return <Navigate to={fallbackPath} replace />;
  }

  return <>{children}</>;
}
