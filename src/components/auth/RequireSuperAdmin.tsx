import { Navigate } from 'react-router-dom';
import { useIsSuperAdmin } from '@/hooks/useIsAdmin';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/** The organization-owner permission sentinel is deliberately never consulted. */
export function RequireSuperAdmin({ children }: { children: React.ReactNode }) {
  const permission = useIsSuperAdmin();
  if (permission.isError) return <div role="alert" className="p-6 space-y-3">
    <h1 className="text-lg font-semibold">Chưa kiểm tra được quyền super admin</h1>
    <p className="text-sm text-muted-foreground">Nội dung được giữ kín cho đến khi xác nhận được quyền.</p>
    <Button variant="outline" onClick={() => { void permission.refetch(); }}>Thử lại</Button>
  </div>;
  if (permission.isLoading || permission.isPending) return <div aria-label="Đang kiểm tra quyền" className="p-6 space-y-4"><Skeleton className="h-10 w-64" /><Skeleton className="h-64 w-full" /></div>;
  if (permission.data !== true) return <Navigate to="/" replace />;
  return <>{children}</>;
}
