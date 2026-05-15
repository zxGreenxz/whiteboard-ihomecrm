import { type ReactNode } from "react";
import ProtectedRoute from "./ProtectedRoute";
import { PermissionRoute } from "@/components/permissions/PermissionRoute";

interface GuardedRouteProps {
  resource: string;
  action?: string;
  children: ReactNode;
}

// Compose: yêu cầu đăng nhập (ProtectedRoute) + yêu cầu quyền (PermissionRoute).
// Super admin và tenant admin được short-circuit ở SQL effective_permissions(),
// nên cả 2 layer đều cho qua tự động.
export const GuardedRoute = ({ resource, action = "view", children }: GuardedRouteProps) => (
  <ProtectedRoute>
    <PermissionRoute resource={resource} action={action}>
      {children}
    </PermissionRoute>
  </ProtectedRoute>
);

export default GuardedRoute;
