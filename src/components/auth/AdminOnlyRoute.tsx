import { lazy, Suspense } from 'react';
// Route guard — chỉ super_admin hoặc admin role được vào.
//
// Dùng cho `/admin/users` và các trang quản trị cấp hệ thống.

import { Navigate } from "react-router-dom";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

const QueryRegion = lazy(() => import("@/components/errors/QueryRegion").then(module => ({ default: module.QueryRegion })));

interface AdminOnlyRouteProps {
  /** Redirect path khi không phải admin. Mặc định `/`. */
  fallbackPath?: string;
  children: React.ReactNode;
}

export function AdminOnlyRoute({ fallbackPath = "/", children }: AdminOnlyRouteProps) {
  const query=useIsAdmin();
  const { data: isAdmin, isLoading } = query;

  if (isLoading) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (query.isError) return <Suspense fallback={
    <div role="alert" className="rounded-md border border-destructive/40 p-4 text-sm">
      <p className="font-medium text-destructive">Chưa tải được quyền quản trị.</p>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => {
        void Promise.allSettled([Promise.resolve().then(() => query.refetch())]);
      }}>Tải lại</Button>
    </div>
  }><QueryRegion queries={[query]} label="quyền quản trị"><></></QueryRegion></Suspense>;

  if (!isAdmin) {
    return <Navigate to={fallbackPath} replace />;
  }

  return <>{children}</>;
}
