import { type ReactNode, useEffect, useRef } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { usePermission } from "@/hooks/usePermissions";

interface PermissionRouteProps {
  resource: string;
  action: string;
  children: ReactNode;
  // Optional: nơi redirect khi không có quyền (mặc định "/")
  redirectTo?: string;
}

// Bọc 1 route để chặn user không có quyền. Khi không có quyền:
//   - Hiện toast "Bạn không có quyền truy cập"
//   - Redirect về `/` (hoặc redirectTo)
//
// Lưu ý: PermissionRoute không thay thế ProtectedRoute. Thứ tự compose:
//   <ProtectedRoute>            // check đã login
//     <PermissionRoute ...>     // check có quyền
//       <Page />
//     </PermissionRoute>
//   </ProtectedRoute>
export const PermissionRoute = ({ resource, action, children, redirectTo = "/" }: PermissionRouteProps) => {
  const { allowed, loading } = usePermission(resource, action);
  const location = useLocation();
  const toastedRef = useRef(false);

  useEffect(() => {
    if (!loading && !allowed && !toastedRef.current) {
      toastedRef.current = true;
      toast.error("Bạn không có quyền truy cập trang này");
    }
  }, [loading, allowed]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }
  if (!allowed) {
    return <Navigate to={redirectTo} replace state={{ from: location }} />;
  }
  return <>{children}</>;
};

export default PermissionRoute;
