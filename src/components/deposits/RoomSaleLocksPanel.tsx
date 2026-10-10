import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/loading/LoadingState';
import { CreateDepositDialog } from '@/components/deposits/CreateDepositDialog';
import { useRoomSaleLocks, useReleaseRoomSaleLock } from '@/hooks/useRoomSaleLocks';
import { can, useMyPermissions } from '@/hooks/useMyPermissions';
import { saleLockErrorMessage, saleLockRemaining, type RoomSaleLock } from '@/lib/roomSaleLockRpc';

/**
 * Phòng đang lock tạm chờ quản lý tạo phiếu cọc (chủ chốt 10/10/2026). Ẩn hẳn khi không có lock.
 * "Tạo phiếu cọc" mở form cọc chung, chọn sẵn đúng phòng đang lock.
 */
export function RoomSaleLocksPanel({ enabled = true }: { enabled?: boolean }) {
  const { data: perms } = useMyPermissions();
  const canRead = can(perms, 'deposits', 'view');
  const canRelease = can(perms, 'deposits', 'create');
  const query = useRoomSaleLocks(enabled && canRead);
  const release = useReleaseRoomSaleLock();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [createRoomId, setCreateRoomId] = useState<string | null>(null);
  // Form cọc luôn là con thứ hai của cùng một Fragment ở MỌI nhánh: lock hết hạn, poll lỗi hay
  // tạo xong lock cuối làm khối danh sách biến mất, nhưng React phải giữ nguyên form đang nhập/vừa lưu.
  const createDialog = createRoomId
    ? <CreateDepositDialog open onOpenChange={open => { if (!open) setCreateRoomId(null); }} initialRoomId={createRoomId} />
    : null;
  const doRelease = async (lock: RoomSaleLock) => {
    try { await release.mutateAsync(lock.id); toast.success(`Đã gỡ lock phòng ${lock.room_name}`); setConfirmId(null); }
    catch (e) { toast.error(saleLockErrorMessage(e)); }
  };
  const locks = query.data?.locks ?? [];
  let content: ReactNode = null;
  if (!enabled || !canRead) content = null;
  else if (query.isLoading) content = <LoadingState label="phòng đang lock" rows={1} onRetry={() => void query.refetch()} />;
  // Poll nền lỗi mà vẫn còn dữ liệu cũ thì giữ danh sách cũ; chỉ báo lỗi khi chưa có gì để hiện.
  else if (query.isError && !query.data) content = <p role="alert" className="text-xs text-destructive">Không tải được phòng đang lock. <Button variant="link" className="h-auto p-0 text-xs" onClick={() => void query.refetch()}>Thử lại</Button></p>;
  else if (locks.length) content = <section className="space-y-2 rounded-lg border p-3" aria-label="Phòng đang lock chờ tạo phiếu">
    <h2 className="flex items-center gap-1.5 text-sm font-semibold"><Lock className="h-3.5 w-3.5" aria-hidden />Phòng đang lock chờ tạo phiếu · {locks.length}</h2>
    <ul className="space-y-1.5">{locks.map(lock => <li key={lock.id} className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1.5 text-sm">
      <div className="min-w-0">
        <strong>{lock.room_name}</strong>{lock.room_code ? <span className="text-muted-foreground"> ({lock.room_code})</span> : null} · {lock.building_name} · <span>{saleLockRemaining(lock.expires_at)}</span> · {lock.locked_by_name}
        {lock.note ? <p className="truncate text-xs text-muted-foreground">{lock.note}</p> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {confirmId === lock.id
          ? <><span className="text-xs">Gỡ lock phòng {lock.room_name}?</span>
              <Button size="sm" variant="destructive" disabled={release.isPending} onClick={() => void doRelease(lock)}>Xác nhận gỡ</Button>
              <Button size="sm" variant="ghost" disabled={release.isPending} onClick={() => setConfirmId(null)}>Không</Button></>
          : <>{canRelease && <Button size="sm" variant="outline" onClick={() => setConfirmId(lock.id)}>Gỡ lock</Button>}
              {canRelease && <Button size="sm" onClick={() => setCreateRoomId(lock.room_id)}>Tạo phiếu cọc</Button>}</>}
      </div>
    </li>)}</ul>
  </section>;
  return <>{content}{createDialog}</>;
}
