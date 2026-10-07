import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useCustomerResidenceHistory } from '@/hooks/useCustomerResidenceHistory';
import { residenceDate, residenceEventLabels } from '@/lib/customerResidenceHistory';

export interface CustomerResidenceHistoryDialogProps {
  customerId: string | null;
  customerName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CustomerResidenceHistoryDialog({
  customerId, customerName, open, onOpenChange,
}: CustomerResidenceHistoryDialogProps) {
  const query = useCustomerResidenceHistory(customerId, open);
  const events = query.data?.pages.flatMap(page => page.events) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Lịch sử lưu trú · {customerName}</DialogTitle>
          <DialogDescription>
            Các lần vào ở, chuyển phòng và rời đi. Một số thông tin cũ có thể chưa được ghi nhận đầy đủ.
          </DialogDescription>
        </DialogHeader>
        {query.isPending && <p role="status">Đang tải lịch sử…</p>}
        {events.length > 0 && (
          <ol className="space-y-4">
            {events.map(event => (
              <li key={event.id} className="rounded-md border p-3 text-sm">
                <div className="font-medium">
                  {residenceEventLabels[event.kind] ?? event.kind} · {residenceDate(event.effective_date)}
                </div>
                <p>{[event.building_name, event.room_name ? `Phòng ${event.room_name}` : null].filter(Boolean).join(' · ') || 'Chưa rõ tòa/phòng'}</p>
                <p>{event.contract_number ?? 'Hợp đồng chưa rõ số'}</p>
                {event.reason && <p>Lý do: {event.reason}</p>}
                {event.actor_name && <p>Người thực hiện: {event.actor_name}</p>}
                {event.incomplete && <p className="text-muted-foreground">Thông tin lần lưu trú này chưa đầy đủ</p>}
                <p className="text-xs text-muted-foreground">Ghi nhận: {new Date(event.recorded_at).toLocaleString('vi-VN')}</p>
              </li>
            ))}
          </ol>
        )}
        {!query.isPending && !query.isError && events.length === 0 && (
          <p>Chưa có lịch sử lưu trú trong phạm vi được phép xem.</p>
        )}
        {query.isError && (
          <div role="alert">
            <p>Không tải được lịch sử lưu trú.</p>
            <Button variant="outline" onClick={() => {
              if (query.isFetchNextPageError) void query.fetchNextPage();
              else void query.refetch();
            }}>Thử lại</Button>
          </div>
        )}
        {query.hasNextPage && !query.isFetchNextPageError && (
          <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {query.isFetchingNextPage ? 'Đang tải…' : 'Tải thêm lịch sử'}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
