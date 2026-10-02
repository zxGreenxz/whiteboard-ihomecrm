import { lazy, Suspense } from 'react';
// Route guard — chỉ super_admin hoặc admin role được vào.
//
// Dùng cho `/admin/users` và các trang quản trị cấp hệ thống.

import { Navigate } from "react-router-dom";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { LoadingState, SkeletonBar } from "@/components/loading/LoadingState";
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

  // Chờ đọc quyền quản trị: khối xám dạng trang, KHÔNG mở nội dung trang trước khi có
  // quyền (chủ chốt 02/10/2026 — không chữ "Đang tải…", câu đó chỉ cho trình đọc màn hình).
  if (isLoading) {
    return (
      <div className="p-6 space-y-3">
        <div className="ld-appear" aria-hidden="true"><SkeletonBar className="h-8 w-1/3" /></div>
        <LoadingState label="quyền quản trị" variant="detail" rows={6} onRetry={() => void query.refetch()} />
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
  }><QueryRegion queries={[query]} label="quyền quản trị" skeleton="detail" rows={6}><></></QueryRegion></Suspense>;

  if (!isAdmin) {
    return <Navigate to={fallbackPath} replace />;
  }

  return <>{children}</>;
}
