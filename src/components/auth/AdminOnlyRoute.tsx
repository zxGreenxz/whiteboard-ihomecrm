// Route guard — chỉ super_admin hoặc admin role được vào.
//
// Dùng cho `/admin/users` và các trang quản trị cấp hệ thống.

import { Navigate } from "react-router-dom";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { Skeleton } from "@/components/ui/skeleton";

interface AdminOnlyRouteProps {
  /** Redirect path khi không phải admin. Mặc định `/`. */
  fallbackPath?: string;
  children: React.ReactNode;
}

export function AdminOnlyRoute({ fallbackPath = "/", children }: AdminOnlyRouteProps) {
  const { data: isAdmin, isLoading } = useIsAdmin();

  if (isLoading) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!isAdmin) {
    return <Navigate to={fallbackPath} replace />;
  }

  return <>{children}</>;
}
