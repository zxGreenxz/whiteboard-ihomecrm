import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/loading/LoadingState';
import { useContract } from '@/hooks/useContracts';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { useOrganization } from '@/contexts/OrganizationContext';
import { canUse } from '@/lib/permissionPages';
import { noticeDueLabel } from '@/lib/moveOutNoticeQueue';
import { NOTICE_QUEUE_PAGE_SIZE, useMoveOutNoticeQueue } from '@/hooks/contracts/useMoveOutNoticeQueue';
import { MoveOutDialog } from './MoveOutDialog';

export function MoveOutNoticeQueue({ buildingIds = [] }: { buildingIds?: string[] }) {
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const { selectedOrganizationId } = useOrganization();
  const scopeKey = [...buildingIds].sort().join(',');
  useEffect(() => { setPage(0); setSelectedId(undefined); }, [scopeKey, selectedOrganizationId]);
  const queue = useMoveOutNoticeQueue(buildingIds, page);
  const selected = useContract(selectedId);
  const { data: permissions } = useMyPermissions();
  const canManage = canUse(permissions, 'contracts', 'terminate');

  // Removing the last notice on a page should reveal the preceding page,
  // rather than leave an empty page hiding still-open work.
  useEffect(() => {
    if (queue.data && page > 0 && page * NOTICE_QUEUE_PAGE_SIZE >= queue.data.total) {
      setPage(Math.max(0, Math.ceil(queue.data.total / NOTICE_QUEUE_PAGE_SIZE) - 1));
    }
  }, [queue.data, page]);

  if (queue.isPending) return null;
  if (queue.isError) return (
    <div role="alert" className="rounded-lg border p-3 text-sm">
      Chưa tải được danh sách cần xác nhận ngày trả phòng.
      <Button variant="link" onClick={() => void queue.refetch()}>Thử lại</Button>
    </div>
  );
  if (!queue.data || queue.data.total === 0) return null;
  return (
    <section aria-label="Cần xác nhận ngày trả phòng" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
      <h2 className="flex items-center gap-2 font-semibold">
        <CalendarClock className="h-4 w-4" /> Cần xác nhận ngày trả phòng ({queue.data.total})
      </h2>
      <p className="mt-1 text-muted-foreground">Đã đến ngày khách hẹn trả. Xác nhận thực tế, đổi ngày hoặc hủy báo trả nếu khách ở tiếp.</p>
      <ul className="mt-3 divide-y divide-amber-200">
        {queue.data.items.map((item) => (
          <li key={item.contract_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div>
              <Link className="font-medium underline" to={`/contracts/${item.contract_id}`}>
                {[item.building_name, item.room_name].filter(Boolean).join(' · ') || item.contract_number || 'Xem hợp đồng'}
              </Link>
              <p>{noticeDueLabel(item.expected_move_out_date, queue.data.today)} · {item.expected_move_out_date.split('-').reverse().join('/')}</p>
            </div>
            {canManage && <Button size="sm" variant="outline" onClick={() => setSelectedId(item.contract_id)}>Cập nhật ngày trả</Button>}
          </li>
        ))}
      </ul>
      {queue.data.total > NOTICE_QUEUE_PAGE_SIZE && (
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Trước</Button>
          <span>Trang {page + 1}/{Math.ceil(queue.data.total / NOTICE_QUEUE_PAGE_SIZE)}</span>
          <Button size="sm" variant="ghost" disabled={(page + 1) * NOTICE_QUEUE_PAGE_SIZE >= queue.data.total} onClick={() => setPage(page + 1)}>Sau</Button>
        </div>
      )}
      {selectedId && selected.isPending && <LoadingState label="hợp đồng" rows={2} className="mt-1" />}
      {selectedId && selected.isError && <p role="alert" className="mt-2">Chưa tải được hợp đồng. <Button variant="link" onClick={() => void selected.refetch()}>Thử lại</Button></p>}
      {selectedId && selected.data?.id === selectedId && (
        <MoveOutDialog open onOpenChange={(open) => { if (!open) setSelectedId(undefined); }} contract={selected.data} />
      )}
    </section>
  );
}
