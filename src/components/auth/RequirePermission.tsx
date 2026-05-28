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

import { Navigate } from "react-router-dom";
import { useMyPermissions, can } from "@/hooks/useMyPermissions";
import { Skeleton } from "@/components/ui/skeleton";

interface RequirePermissionProps {
  module: string;
  action?: string;
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
  const { data: perms, isLoading } = useMyPermissions();

  if (isLoading) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!can(perms, module, action)) {
    return <Navigate to={fallbackPath} replace />;
  }

  return <>{children}</>;
}
