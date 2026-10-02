import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { useRoomTurnoverQueue } from '@/hooks/rooms/useRoomTurnover';
import { canUse } from '@/lib/permissionPages';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/loading/LoadingState';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RoomTurnoverPanel } from './RoomTurnoverPanel';

const PAGE_SIZE = 10;

export function RoomTurnoverQueue({ buildingIds = [] }: { buildingIds?: string[] }) {
  const [page, setPage] = useState(0);
  const [selectedRoomId, setSelectedRoomId] = useState<string>();
  const { selectedOrganizationId } = useOrganization();
  const { data: permissions } = useMyPermissions();
  const canManage = canUse(permissions, 'rooms', 'edit');
  const scopeKey = [...buildingIds].sort().join(',');
  const queue = useRoomTurnoverQueue(buildingIds, page, PAGE_SIZE);
  useEffect(() => { setPage(0); setSelectedRoomId(undefined); }, [scopeKey, selectedOrganizationId]);
  useEffect(() => {
    if (queue.data && page > 0 && page * PAGE_SIZE >= queue.data.total) {
      setPage(Math.max(0, Math.ceil(queue.data.total / PAGE_SIZE) - 1));
    }
  }, [queue.data, page]);

  if (!selectedOrganizationId) return null;
  // Hàng đợi thường rỗng (không hiện gì) — lúc chờ không dựng khối xám để khỏi chớp ô
  // rồi biến mất; chỉ báo cho trình đọc màn hình (chủ chốt 02/10/2026).
  if (queue.isPending) return <LoadingState label="việc dọn/sửa cần cập nhật" variant="none" />;
  if (queue.isError || !queue.data) return <div role="alert" className="rounded-lg border p-3 text-sm">
    Chưa tải được việc dọn/sửa cần cập nhật.
    <Button variant="link" onClick={() => void queue.refetch()}>Thử tải lại</Button>
  </div>;
  if (queue.data.total === 0) return null;
  const data = queue.data;
  return <section aria-label="Dọn/sửa cần cập nhật" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
    <h2 className="flex items-center gap-2 font-semibold"><CalendarClock className="h-4 w-4" />Dọn/sửa cần cập nhật ({data.total})</h2>
    <p className="mt-1 text-muted-foreground">Xác nhận ngày xong, phân công người phụ trách hoặc ghi nhận phòng đã sẵn sàng nhận khách.</p>
    <ul className="mt-3 divide-y divide-amber-200">
      {data.items.map(item => <li key={item.room_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <div>
          <Link className="font-medium underline" to={`/rooms/${item.room_id}`}>{item.building_name} · {item.room_name}</Link>
          <p>{item.expected_ready_on
            ? `${item.expected_ready_on < data.today ? 'Quá ngày dự kiến xong' : 'Đến ngày dự kiến xong'} · ${item.expected_ready_on.split('-').reverse().join('/')}`
            : 'Chưa hẹn ngày xong'}</p>
        </div>
        {canManage && <Button size="sm" variant="outline" aria-label={`Cập nhật dọn/sửa ${item.room_name}`} onClick={() => setSelectedRoomId(item.room_id)}>Cập nhật dọn/sửa</Button>}
      </li>)}
    </ul>
    {data.total > PAGE_SIZE && <div className="mt-2 flex items-center justify-end gap-2">
      <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Trước</Button>
      <span>Trang {page + 1}/{Math.ceil(data.total / PAGE_SIZE)}</span>
      <Button size="sm" variant="ghost" disabled={(page + 1) * PAGE_SIZE >= data.total} onClick={() => setPage(page + 1)}>Sau</Button>
    </div>}
    <Dialog open={Boolean(selectedRoomId)} onOpenChange={open => { if (!open) setSelectedRoomId(undefined); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>Cập nhật dọn/sửa phòng</DialogTitle><DialogDescription>Ghi nhận tiến độ và ngày dự kiến chuẩn bị xong phòng.</DialogDescription></DialogHeader>
        {selectedRoomId && <RoomTurnoverPanel roomId={selectedRoomId} />}
      </DialogContent>
    </Dialog>
  </section>;
}
