import {friendlyError} from '@/lib/friendlyError';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useContractCommissionFollowups, useRecordContractCommissionEvent } from '@/hooks/useContractCommissionFollowup';
import { useRetryCommissionVoucher } from '@/hooks/useCommissionVoucher';
import { readContractCommissionFollowups, safeCommissionReason, type ContractCommissionFollowup, type CommissionKind } from '@/lib/contractCommissionFollowup';
import { useOrganization } from '@/contexts/OrganizationContext';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/loading/LoadingState';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { COMMISSION_REASON_MAX, commissionReasonValid } from '@/lib/commissionCreationPolicy';
import { CommissionRequestEvidence } from './CommissionRequestEvidence';

const CommissionModal = lazy(() => import('./CommissionVoucherModal').then(module => ({ default: module.CommissionVoucherModal })));
const KIND_LABEL = { broker: 'Hoa hồng môi giới', sale: 'Thưởng Sale' } as const;
const isFailure = (row: ContractCommissionFollowup) => ['FAILED', 'UNKNOWN', 'PROCESSING'].includes(row.state);
type FollowupQuery = ReturnType<typeof useContractCommissionFollowups>;

/** Lỗi tạo đã ghi nhận là hồ sơ riêng, không phải phiếu chi hoặc khoản nợ. */
export function CommissionFailureList({ query, scope, empty = false }: {
  query: FollowupQuery; scope: string; empty?: boolean;
}) {
  const retry = useRetryCommissionVoucher();
  const { selectedOrganizationId } = useOrganization();
  const [legacy, setLegacy] = useState<{ contractId: string; kind: CommissionKind; replacementRequestId?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setLegacy(null); setError(null); setBusy(false); }, [scope]);
  const rows = (query.data?.rows ?? []).filter(isFailure);
  const retryRow = async (row: ContractCommissionFollowup, replace = false) => {
    if (busy || retry.isPending || !row.can_manage) return;
    const currentGeneration = generation.current;
    setBusy(true); setError(null);
    try {
      if (!selectedOrganizationId) throw new Error('scope');
      // A row can shift off a queue page; only exact-contract truth can resolve it.
      const fresh = await readContractCommissionFollowups(selectedOrganizationId, { contractId: row.contract_id });
      if (generation.current !== currentGeneration) return;
      const current = fresh.rows.find(r => r.contract_id === row.contract_id && r.kind === row.kind);
      if (!current) throw new Error('missing');
      if (current.state === 'VOUCHER_CREATED' || current.state === 'SETTLED_BY_SUPPORT') {
        await query.refetch();
        toast.info(current.state === 'SETTLED_BY_SUPPORT' ? 'Đã xử lý bằng hỗ trợ tiền thuê; không cần tạo phiếu chi.' : current.voucher_code ? `Đã có phiếu ${current.voucher_code}.` : 'Yêu cầu đã được đối chiếu; không cần tạo lại.');
        return;
      }
      if (!isFailure(current) || !current.can_manage || current.state === 'PROCESSING') return;
      if (replace && current.request_id) {
        setLegacy({ contractId: current.contract_id, kind: current.kind, replacementRequestId: current.request_id });
      } else if (current.can_retry && current.request_id) {
        const result = await retry.mutateAsync({ contract_id: current.contract_id, kind: current.kind, request_id: current.request_id });
        toast.success(result.status === 'SETTLED_BY_SUPPORT' ? 'Đã xử lý bằng hỗ trợ tiền thuê; không tạo phiếu chi 0.' : `${result.status === 'ALREADY_EXISTS' ? 'Đã có phiếu' : 'Đã tạo phiếu'}${result.code ? ` ${result.code}` : ''}.`);
      } else if (!current.can_retry) {
        setLegacy({ contractId: current.contract_id, kind: current.kind, replacementRequestId: current.request_id ?? undefined });
      }
    } catch (cause) {
      if (generation.current === currentGeneration) {
        const feedback=friendlyError(cause,'Chưa xác minh được kết quả tạo phiếu',{operation:'tạo phiếu hoa hồng',financial:true});
        setError(`${feedback.title}. ${feedback.description}`);
      }
    } finally {
      if (generation.current === currentGeneration) setBusy(false);
    }
  };
  return <>
    {query.isError ? <div role="alert" className="text-sm text-destructive">Không tải được trạng thái tạo hoa hồng và thưởng Sale.
      <Button type="button" variant="link" onClick={() => void query.refetch()}>Tải lại</Button>
    </div> : query.isPending
      // Chờ đọc trạng thái: không hiện chữ (chủ chốt 02/10/2026). Dưới nút "Tạo phiếu
      // hoa hồng" danh sách này thường rỗng nên không vẽ gì — nút vẫn khoá tới khi đọc
      // xong; nơi hiện cả danh sách (`empty`) thì là khối xám.
      ? <LoadingState label="trạng thái tạo phiếu" variant={empty ? 'lines' : 'none'} rows={2} /> : <>
      {rows.map(row => <div key={`${row.contract_id}:${row.kind}`} role={row.state === 'PROCESSING' ? 'status' : 'alert'}
        className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 space-y-1">
        <p className="font-medium">{row.building_name} · {row.room_name} · {row.contract_number || row.contract_id.slice(0, 8)} · {KIND_LABEL[row.kind]}</p>
        <CommissionRequestEvidence row={row} />
        {row.can_manage && row.last_reason && row.state !== 'PROCESSING'
          ? <p className="break-words">{safeCommissionReason(row.last_reason)}</p>
          : <p>{row.state === 'PROCESSING' ? 'Yêu cầu tạo phiếu đang được xử lý. Hãy kiểm tra lại trạng thái.'
            : row.state === 'UNKNOWN' ? 'Chưa xác minh được kết quả tạo phiếu.' : 'Lần tạo phiếu trước báo lỗi.'}</p>}
        {row.can_manage && row.state !== 'PROCESSING' &&
          <Button type="button" size="sm" variant="outline" disabled={busy || retry.isPending} onClick={() => void retryRow(row)}>Tạo lại</Button>}
        {row.can_manage && row.request_id && row.state !== 'PROCESSING' && <Button type="button" size="sm" variant="outline"
          disabled={busy || retry.isPending} onClick={() => void retryRow(row, true)}>Lập lại yêu cầu</Button>}
      </div>)}
      {empty && !rows.length && <p className="text-sm text-muted-foreground">Chưa ghi nhận lỗi tạo phiếu trong phạm vi đang xem.</p>}
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {legacy && <Suspense fallback={<p role="status">Đang mở phiếu hoa hồng…</p>}><CommissionModal open contractId={legacy.contractId}
      onlyKind={legacy.kind} replacementRequestId={legacy.replacementRequestId} onOpenChange={open => { if (!open) setLegacy(null); }} /></Suspense>}
  </>;
}

/** Hành động tại chi tiết hợp đồng; ghi chú lỗi nằm ngay dưới nút tạo. */
export function ContractCommissionFollowupPanel({ contractId }: { contractId: string }) {
  const query = useContractCommissionFollowups({ contractId });
  const record = useRecordContractCommissionEvent();
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<{ kind: CommissionKind; action: 'NOT_APPLICABLE' | 'REOPENED' } | null>(null);
  const [reason, setReason] = useState('');
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setOpen(false); setDecision(null); setReason(''); setDecisionError(null); setDeciding(false); return () => { generation.current++; }; }, [contractId]);
  const rows = query.data?.rows ?? [];
  const canCreate = !query.isPending && !query.isError && rows.some(row => row.can_manage && row.state === 'PENDING');
  const saveDecision = async () => {
    if (!decision || deciding || record.isPending || !commissionReasonValid(reason)) return;
    const current = generation.current;
    setDeciding(true); setDecisionError(null);
    try {
      const fresh = await query.refetch();
      if (current !== generation.current) return;
      const row = fresh.data?.rows.find(item => item.kind === decision.kind);
      const expectedState = decision.action === 'REOPENED' ? 'NOT_APPLICABLE' : 'PENDING';
      if (fresh.isError || !row?.can_manage || row.state !== expectedState || row.can_retry)
        throw new Error('Trạng thái hoa hồng đã thay đổi. Đối chiếu lại trước khi ghi quyết định.');
      await record.mutateAsync({ contractId, ...decision, reason: reason.trim() });
      if (current === generation.current) { setDecision(null); setReason(''); }
    } catch (cause) {
      if (current === generation.current) {
        const feedback = friendlyError(cause, 'Chưa lưu được quyết định hoa hồng', { operation: 'ghi quyết định hoa hồng', financial: true });
        setDecisionError(`${feedback.title}. ${feedback.description}`);
      }
    } finally { if (current === generation.current) setDeciding(false); }
  };
  return <div className="space-y-2" aria-label="Tạo hoa hồng và thưởng Sale">
    <div><Button type="button" size="sm" variant="outline" disabled={!canCreate} onClick={() => setOpen(true)}>Tạo phiếu hoa hồng</Button></div>
    <CommissionFailureList query={query} scope={contractId} />
    {!query.isError && rows.filter(row => row.state === 'VOUCHER_CREATED').map(row =>
      <p key={row.kind} className="text-xs text-muted-foreground">{KIND_LABEL[row.kind]}: Đã có phiếu{row.voucher_code ? ` ${row.voucher_code}` : ''}.</p>)}
    {!query.isError && rows.filter(row => row.state === 'SETTLED_BY_SUPPORT').map(row =>
      <p key={row.kind} className="text-xs text-muted-foreground">{KIND_LABEL[row.kind]}: Đã xử lý bằng hỗ trợ tiền thuê.</p>)}
    {!query.isError && !query.isPending && rows.filter(row => row.can_manage).map(row => <div key={`decision:${row.kind}`} className="space-y-1 text-sm">
      {row.state === 'PENDING' && !row.can_retry && <Button variant="outline" size="sm" onClick={() => { setDecision({ kind: row.kind, action: 'NOT_APPLICABLE' }); setReason(''); setDecisionError(null); }}>Không phát sinh {KIND_LABEL[row.kind].toLowerCase()}</Button>}
      {row.state === 'NOT_APPLICABLE' && <div><span>{KIND_LABEL[row.kind]}: Không phát sinh. </span><Button variant="outline" size="sm" onClick={() => { setDecision({ kind: row.kind, action: 'REOPENED' }); setReason(''); setDecisionError(null); }}>Mở lại {KIND_LABEL[row.kind].toLowerCase()}</Button></div>}
      {row.events.length > 0 && <details><summary className="cursor-pointer text-xs">Lịch sử quyết định {KIND_LABEL[row.kind].toLowerCase()}</summary><ol className="space-y-2 pt-2">{row.events.map((event, index) => <li key={`${event.created_at}:${index}`} className="text-xs">
        <p>{({ ATTEMPTED: 'Lập yêu cầu', FAILED: 'Tạo chưa thành công', NOT_APPLICABLE: 'Không phát sinh', REOPENED: 'Mở lại', COMPLETED: 'Đã tạo phiếu' } as const)[event.action]} · {event.actor_name || 'Chưa xác định người thực hiện'} · {new Date(event.created_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</p>
        {event.reason && <p>Lý do: {safeCommissionReason(event.reason)}</p>}
      </li>)}</ol></details>}
    </div>)}
    {open && <Suspense fallback={<p role="status">Đang mở phiếu hoa hồng…</p>}><CommissionModal open contractId={contractId}
      onOpenChange={setOpen} /></Suspense>}
    <Dialog open={!!decision} onOpenChange={value => { if (!value && !deciding) setDecision(null); }}><DialogContent>
      <DialogHeader><DialogTitle>{decision?.action === 'REOPENED' ? 'Mở lại khoản hoa hồng / thưởng' : 'Ghi nhận không phát sinh'}</DialogTitle>
        <DialogDescription>{decision ? KIND_LABEL[decision.kind] : ''}. Quyết định và lý do được lưu trong lịch sử hợp đồng.</DialogDescription></DialogHeader>
      <label htmlFor="commission-decision-reason">Lý do quyết định *</label>
      <Textarea id="commission-decision-reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={COMMISSION_REASON_MAX} disabled={deciding} />
      <p className="text-xs text-muted-foreground">Nhập từ 8 đến 2000 ký tự.</p>
      {decisionError && <p role="alert" className="text-sm text-destructive">{decisionError}</p>}
      <DialogFooter><Button variant="outline" disabled={deciding} onClick={() => setDecision(null)}>Để sau</Button><Button disabled={deciding || record.isPending || !commissionReasonValid(reason)} onClick={() => void saveDecision()}>Lưu quyết định</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
