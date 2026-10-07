import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useCustomerResidenceHistory } from '@/hooks/useCustomerResidenceHistory';
import { residenceDate, residenceEventLabels, type CustomerResidenceContractContext } from '@/lib/customerResidenceHistory';

const contractStatusLabels: Record<string, string> = {
  DRAFT: 'Bản nháp', ACTIVE: 'Đang hiệu lực', EXTENDED: 'Đã gia hạn',
  EXPIRED: 'Đã hết hạn', TERMINATED: 'Đã kết thúc', TRANSFERRED: 'Đã nhượng'
};

function ContractContextCard({ contract }: { contract: CustomerResidenceContractContext }) {
  const number = contract.contract_number ?? 'Chưa rõ số';
  const dates = [
    ['Ngày ký HĐ', contract.signed_date],
    ['Bắt đầu HĐ', contract.start_date],
    ['Hết hạn HĐ', contract.end_date],
    ...(contract.actual_end_date || ['TERMINATED', 'TRANSFERRED'].includes(contract.status)
      ? [['Kết thúc thực tế ghi trên HĐ', contract.actual_end_date]] : [])
  ];
  const showRooms = contract.room_segments.length > 0;
  const currentContract = ['ACTIVE', 'EXTENDED', 'EXPIRED'].includes(contract.status) && !contract.actual_end_date;

  return (
    <article aria-label={`Hợp đồng ${number}`} className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{number}</h3>
        <span className="rounded bg-muted px-2 py-0.5 text-xs">{contractStatusLabels[contract.status] ?? contract.status}</span>
      </div>
      {(contract.building_name || contract.room_name) && (
        <p className="mt-1 text-muted-foreground">{[contract.building_name, contract.room_name ? `Phòng ${contract.room_name}` : null].filter(Boolean).join(' · ')}</p>
      )}
      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {dates.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd>{value ? residenceDate(value) : 'Chưa ghi trên hợp đồng'}</dd>
          </div>
        ))}
      </dl>
      {showRooms && (
        <div className="mt-3 border-t pt-3">
          <h4 className="font-medium">Lịch sử phòng của hợp đồng</h4>
          <ol className="mt-2 space-y-2">
            {contract.room_segments.map((segment, index) => (
              <li key={`${segment.room_id}-${index}`}>
                <p>{[segment.building_name, segment.room_name ? `Phòng ${segment.room_name}` : null].filter(Boolean).join(' · ') || 'Phòng chưa rõ tên'}</p>
                <p className="text-xs text-muted-foreground">
                  {segment.trusted
                    ? `${segment.from_date ? `Từ ${residenceDate(segment.from_date)}` : 'Chưa ghi nhận ngày bắt đầu'} · ${segment.to_date ? `Đến ${residenceDate(segment.to_date)}` : index === contract.room_segments.length - 1 ? currentContract ? 'Phòng hiện tại của HĐ' : 'Phòng cuối của HĐ' : 'Chưa ghi nhận mốc chuyển tiếp'}`
                    : 'Chưa xác nhận được khoảng thời gian của phòng này.'}
                </p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </article>
  );
}

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
  const contractsById = new Map<string, CustomerResidenceContractContext>();
  for (const page of query.data?.pages ?? []) {
    for (const contract of page.contract_contexts ?? []) {
      if (!contractsById.has(contract.contract_id)) contractsById.set(contract.contract_id, contract);
    }
  }
  const contracts = [...contractsById.values()];
  const actions = events.filter(event => event.kind !== 'OBSERVED' || !contractsById.has(event.contract_id));
  const onlyContractEvidence = contracts.length > 0 && events.every(event => event.kind === 'OBSERVED') && !query.hasNextPage && !query.isError;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Lịch sử lưu trú · {customerName}</DialogTitle>
          <DialogDescription>
            Các mốc hợp đồng và biến động đã được ghi nhận của khách.
          </DialogDescription>
        </DialogHeader>
        {query.isPending && <p role="status">Đang tải lịch sử…</p>}
        {contracts.length > 0 && (
          <section aria-label="Thông tin hợp đồng" className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold">Thông tin hợp đồng</h2>
              <p className="text-xs text-muted-foreground">Ngày trên hợp đồng có thể khác ngày khách thực tế nhận hoặc trả phòng.</p>
            </div>
            {contracts.map(contract => <ContractContextCard key={contract.contract_id} contract={contract} />)}
            {onlyContractEvidence && (
              <p className="text-sm text-muted-foreground">Hồ sơ này chưa có xác nhận ngày nhận/trả phòng riêng của khách. Các ngày trên là mốc của hợp đồng.</p>
            )}
          </section>
        )}
        {actions.length > 0 && (
          <section aria-label="Biến động đã ghi nhận" className="space-y-3">
            <h2 className="text-sm font-semibold">Biến động đã ghi nhận</h2>
            <p className="text-xs text-muted-foreground">Sắp xếp theo thứ tự ghi nhận mới nhất.</p>
            <ol className="space-y-3">
              {actions.map(event => (
                <li key={event.id} className="rounded-md border p-3 text-sm">
                  <div className="font-medium">
                    {residenceEventLabels[event.kind] ?? event.kind}{event.effective_date ? ` · ${residenceDate(event.effective_date)}` : ''}
                  </div>
                  <p>{[event.building_name, event.room_name ? `Phòng ${event.room_name}` : null].filter(Boolean).join(' · ') || 'Chưa rõ tòa/phòng'}</p>
                  <p>{event.contract_number ?? 'Hợp đồng chưa rõ số'}</p>
                  {event.reason && <p>Lý do: {event.reason}</p>}
                  {event.actor_name && <p>Người thực hiện: {event.actor_name}</p>}
                  {event.kind === 'OBSERVED'
                    ? <p className="text-muted-foreground">Liên kết này không có mốc nhận/trả phòng riêng của khách được ghi nhận.</p>
                    : <>
                      {!event.effective_date && <p className="text-muted-foreground">Chưa có ngày thực hiện được ghi nhận.</p>}
                      <p className="text-xs text-muted-foreground">Thời điểm ghi nhận: {new Date(event.recorded_at).toLocaleString('vi-VN')}</p>
                    </>}
                </li>
              ))}
            </ol>
          </section>
        )}
        {!query.isPending && !query.isError && events.length === 0 && contracts.length === 0 && (
          <p>Chưa có hợp đồng liên kết hoặc biến động được ghi nhận trong phạm vi được phép xem.</p>
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
