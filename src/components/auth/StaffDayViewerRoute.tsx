// Cửa hiển thị của các màn chủ xem theo từng quản lý. Hàng rào thật nằm ở các hàm SQL
// `staff_day_*`: chúng tự kiểm vai Chủ công ty/super admin và trả 42501 cho người khác.
import { Navigate } from "react-router-dom";
import { LoadingState, SkeletonBar } from "@/components/loading/LoadingState";
import { Button } from "@/components/ui/button";
import { useStaffViewer } from "@/hooks/staff-day/useStaffDay";

export function StaffDayViewerRoute({ children }: { children: React.ReactNode }) {
  const viewer = useStaffViewer();

  if (viewer.isLoading) {
    return (
      <div className="space-y-3 p-6">
        <div className="ld-appear" aria-hidden="true"><SkeletonBar className="h-8 w-1/3" /></div>
        <LoadingState label="quyền xem" variant="detail" rows={6} onRetry={() => { void viewer.refetch(); }} />
      </div>
    );
  }

  if (viewer.isError) {
    return (
      <div role="alert" className="m-6 rounded-md border border-destructive/40 p-4 text-sm">
        <p className="font-medium text-destructive">Chưa kiểm tra được quyền xem.</p>
        <p className="mt-1 text-muted-foreground">Nội dung được giữ kín cho đến khi xác nhận được quyền.</p>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { void viewer.refetch(); }}>Tải lại</Button>
      </div>
    );
  }

  if (!viewer.canView) return <Navigate to="/my-day" replace />;
  return <>{children}</>;
}
