import { Navigate } from 'react-router-dom';
import { usePersonalFinancePermissions, type PersonalFinancePermissions } from '@/hooks/personal-finance/usePersonalFinancePermissions';
import type { ActionKey } from '@/lib/permissions';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';

/** No organization is selected on behalf of a user entering their own wallet. */
export function RequirePersonalFinancePermission({ children, action = 'view', fallbackPath = '/' }: { children: React.ReactNode; action?: ActionKey; fallbackPath?: string }) {
  const permission = usePersonalFinancePermissions();
  if (permission.isError) {
    return <div className="p-6 space-y-3">
      <h2 className="text-lg font-semibold">Không tải được quyền</h2>
      <p className="text-sm text-muted-foreground">Chưa đọc được quyền Ví cá nhân của tài khoản. Vui lòng thử lại.</p>
      <Button type="button" variant="outline" onClick={() => void permission.refetch()}>Thử lại</Button>
    </div>;
  }
  if (permission.isPending) return <div className="p-6 space-y-3"><Skeleton className="h-8 w-1/3" /><Skeleton className="h-32 w-full" /></div>;
  if (!permission.data?.[action as keyof PersonalFinancePermissions]) return <Navigate to={fallbackPath} replace />;
  return <>{children}</>;
}
