import { lazy, Suspense, useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useContractCommissionFollowups, useRecordContractCommissionEvent } from '@/hooks/useContractCommissionFollowup';
import { COMMISSION_FOLLOWUP_PAGE_SIZE, type ContractCommissionFollowup } from '@/lib/contractCommissionFollowup';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const CommissionModal = lazy(() => import('./CommissionVoucherModal').then(module => ({ default: module.CommissionVoucherModal })));
const KIND_LABEL = { broker: 'Hoa hồng môi giới', sale: 'Thưởng Sale' } as const;
const STATE_LABEL = {
  PENDING: 'Chưa xử lý', UNKNOWN: 'Chưa rõ kết quả tạo phiếu', FAILED: 'Lần xử lý trước báo lỗi',
  NOT_APPLICABLE: 'Đã xác nhận không phát sinh', VOUCHER_CREATED: 'Đã có phiếu',
} as const;
const ACTION_LABEL = { ATTEMPTED: 'Bắt đầu tạo phiếu', FAILED: 'Ghi nhận lỗi', NOT_APPLICABLE: 'Xác nhận không phát sinh', REOPENED: 'Mở lại để kiểm tra' } as const;
const APPROVAL_LABEL: Record<string, string> = { APPROVED: 'Đã duyệt', UNAPPROVED: 'Chờ duyệt', REJECTED: 'Từ chối duyệt' };
const formatTime = (value: string) => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
const formatMoney = (value: number) => `${value.toLocaleString('vi-VN')} đ`;

export function ContractCommissionFollowupPanel({ contractId, buildingIds }: { contractId?: string; buildingIds?: string[] }) {
  const { selectedOrganizationId } = useOrganization();
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [modalContractId, setModalContractId] = useState<string | null>(null);
  const [decision, setDecision] = useState<ContractCommissionFollowup | null>(null);
  const [reason, setReason] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const scope = `${selectedOrganizationId}:${contractId ?? ''}:${[...(buildingIds ?? [])].sort().join(',')}`;
  const query = useContractCommissionFollowups({ contractId, buildingIds, unresolvedOnly: !contractId, page });
  const record = useRecordContractCommissionEvent();
  useEffect(() => {
    setPage(0); setModalContractId(null); setDecision(null); setReason(''); setSaveError(null);
  }, [scope]);
  useEffect(() => {
    if (page > 0 && query.data && !query.data.rows.length && !query.isError) setPage(value => value - 1);
  }, [page, query.data, query.isError]);
  const isExpanded = !!contractId || expanded;
  const rows = query.data?.rows ?? [];

  const recordDecision = async (row: ContractCommissionFollowup, action: 'NOT_APPLICABLE' | 'REOPENED') => {
    if (!row.can_manage || record.isPending || (action === 'NOT_APPLICABLE' && !reason.trim())) return;
    setSaveError(null);
    try {
      await record.mutateAsync({ contractId: row.contract_id, kind: row.kind, action,
        ...(action === 'NOT_APPLICABLE' ? { reason: reason.trim() } : {}) });
      setDecision(null); setReason('');
    } catch {
      setSaveError('Chưa lưu được quyết định. Kiểm tra quyền hoặc kết nối rồi thử lại.');
    }
  };

  return <section aria-label="Theo dõi hoa hồng và thưởng Sale" className="rounded-lg border bg-background p-3 space-y-3">
    {contractId ? <h2 className="font-semibold">Hoa hồng và thưởng Sale</h2> : <Button type="button" variant="ghost"
      className="h-auto w-full justify-between px-0 text-left whitespace-normal" aria-expanded={isExpanded} onClick={() => setExpanded(value => !value)}>
      <span className="font-semibold">Hoa hồng và thưởng Sale</span><ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
    </Button>}
    <p className="text-xs text-muted-foreground">Việc cần kiểm tra, chưa phải khoản nợ đã xác nhận. Có phiếu hoặc được duyệt chưa xác nhận đã chi tiền.
      {!contractId && ' Theo toà đang chọn, không giới hạn kỳ ký.'}</p>
    {query.isError ? <Alert variant="destructive"><AlertDescription>Không tải được theo dõi hoa hồng và thưởng Sale.
      <Button type="button" variant="link" onClick={() => void query.refetch()}>Thử lại</Button>
    </AlertDescription></Alert> : query.isPending ? <p role="status" className="text-sm">Đang kiểm tra hoa hồng và thưởng Sale…</p> : <>
      {!contractId && query.data && <p className="text-sm font-medium">{query.data.total} khoản cần kiểm tra</p>}
      {isExpanded && <>
        {!rows.length && <p className="text-sm text-muted-foreground">{contractId ? 'Chưa có dữ liệu theo dõi cho hợp đồng này.' : 'Chưa ghi nhận việc cần kiểm tra trong phạm vi này.'}</p>}
        <div className="space-y-3">{rows.map(row => <article key={`${row.contract_id}:${row.kind}`} aria-label={KIND_LABEL[row.kind]} className="rounded-md border p-3 space-y-2">
          {!contractId && <p className="text-sm font-medium">{row.building_name} · {row.room_name} · {row.contract_number || 'Hợp đồng cũ'}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{KIND_LABEL[row.kind]}</h3>
            <Badge variant={row.state === 'UNKNOWN' || row.state === 'FAILED' ? 'destructive' : 'secondary'}>{STATE_LABEL[row.state]}</Badge>
          </div>
          {(row.state === 'UNKNOWN' || row.state === 'FAILED') && <p className="text-sm">Đối chiếu phiếu đã có trước khi tiếp tục; lỗi hoặc mất phản hồi chưa đủ để kết luận chưa tạo phiếu.</p>}
          {row.voucher_id && <div className="text-sm"><p>Phiếu {row.voucher_code || 'chưa có mã'} · <span>{APPROVAL_LABEL[row.voucher_status ?? ''] ?? 'Trạng thái duyệt chưa xác minh'}</span></p>
            <p className="text-xs text-muted-foreground">Kiểm tra tình trạng chi và ghi sổ tại Thu chi.</p></div>}
          {row.attempted_amount !== null && <p className="text-sm">Số tiền đề nghị lần trước: {formatMoney(row.attempted_amount)}</p>}
          {row.last_reason && <p className="text-sm break-words">Lý do: {row.last_reason}</p>}
          {row.last_at && <p className="text-xs text-muted-foreground">{row.last_actor || 'Người xử lý chưa xác định'} · {formatTime(row.last_at)}</p>}
          {row.can_manage && row.state !== 'VOUCHER_CREATED' && <div className="flex flex-wrap gap-2">
            {row.state === 'NOT_APPLICABLE' ? <Button type="button" size="sm" variant="outline" disabled={record.isPending}
              onClick={() => void recordDecision(row, 'REOPENED')}>Mở lại để kiểm tra</Button> : <>
              <Button type="button" size="sm" onClick={() => setModalContractId(row.contract_id)}>Tiếp tục xử lý</Button>
              <Button type="button" size="sm" variant="outline" disabled={record.isPending} onClick={() => { setDecision(row); setReason(''); setSaveError(null); }}>Không phát sinh</Button>
            </>}
          </div>}
          {row.events.length > 0 && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Lịch sử ({row.events.length})</summary>
            <ol className="mt-2 space-y-2 border-l pl-3">{row.events.map((event, index) => <li key={`${event.created_at}:${index}`}>
              <p>{ACTION_LABEL[event.action]} · {event.actor_name || 'Người xử lý chưa xác định'} · {formatTime(event.created_at)}</p>
              {event.reason && <p className="break-words">{event.reason}</p>}
              {event.amount !== null && <p>Đề nghị: {formatMoney(event.amount)}</p>}
            </li>)}</ol>
          </details>}
        </article>)}</div>
        {!contractId && query.data && query.data.total > COMMISSION_FOLLOWUP_PAGE_SIZE && <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
          <Button type="button" size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Trang trước</Button>
          <span>Trang {page + 1}/{Math.ceil(query.data.total / COMMISSION_FOLLOWUP_PAGE_SIZE)}</span>
          <Button type="button" size="sm" variant="outline" disabled={(page + 1) * COMMISSION_FOLLOWUP_PAGE_SIZE >= query.data.total} onClick={() => setPage(value => value + 1)}>Trang sau</Button>
        </div>}
      </>}
    </>}
    {saveError && !decision && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
    <Dialog open={!!decision} onOpenChange={open => { if (!open && !record.isPending) { setDecision(null); setSaveError(null); } }}>
      <DialogContent><DialogHeader><DialogTitle>Không phát sinh {decision ? KIND_LABEL[decision.kind].toLowerCase() : ''}</DialogTitle>
        <DialogDescription>Ghi lý do để người khác có thể đối chiếu. Có thể mở lại quyết định sau.</DialogDescription></DialogHeader>
        <Label htmlFor="commission-followup-reason">Lý do</Label>
        <Textarea id="commission-followup-reason" value={reason} maxLength={2000} disabled={record.isPending} onChange={event => setReason(event.target.value)} />
        {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
        <Button type="button" disabled={record.isPending || !reason.trim()} onClick={() => { if (decision) void recordDecision(decision, 'NOT_APPLICABLE'); }}>Lưu quyết định</Button>
      </DialogContent>
    </Dialog>
    {modalContractId && <Suspense fallback={<p role="status">Đang mở phiếu hoa hồng…</p>}><CommissionModal open contractId={modalContractId}
      onOpenChange={open => { if (!open) setModalContractId(null); }} /></Suspense>}
  </section>;
}
