import {friendlyError} from '@/lib/friendlyError';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useContractCommissionFollowups } from '@/hooks/useContractCommissionFollowup';
import { useRetryCommissionVoucher } from '@/hooks/useCommissionVoucher';
import { readContractCommissionFollowups, safeCommissionReason, type ContractCommissionFollowup, type CommissionKind } from '@/lib/contractCommissionFollowup';
import { useOrganization } from '@/contexts/OrganizationContext';
import { Button } from '@/components/ui/button';

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
  const [legacy, setLegacy] = useState<{ contractId: string; kind: CommissionKind } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setLegacy(null); setError(null); setBusy(false); }, [scope]);
  const rows = (query.data?.rows ?? []).filter(isFailure);
  const retryRow = async (row: ContractCommissionFollowup) => {
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
      if (current.can_retry && current.request_id) {
        const result = await retry.mutateAsync({ contract_id: current.contract_id, kind: current.kind, request_id: current.request_id });
        toast.success(result.status === 'SETTLED_BY_SUPPORT' ? 'Đã xử lý bằng hỗ trợ tiền thuê; không tạo phiếu chi 0.' : `${result.status === 'ALREADY_EXISTS' ? 'Đã có phiếu' : 'Đã tạo phiếu'}${result.code ? ` ${result.code}` : ''}.`);
      } else if (!current.can_retry) {
        setLegacy({ contractId: current.contract_id, kind: current.kind });
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
    </div> : query.isPending ? <p role="status" className="text-sm text-muted-foreground">Đang kiểm tra trạng thái tạo phiếu…</p> : <>
      {rows.map(row => <div key={`${row.contract_id}:${row.kind}`} role={row.state === 'PROCESSING' ? 'status' : 'alert'}
        className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 space-y-1">
        <p className="font-medium">{row.building_name} · {row.room_name} · {row.contract_number || row.contract_id.slice(0, 8)} · {KIND_LABEL[row.kind]}</p>
        {row.can_manage && row.last_reason && row.state !== 'PROCESSING'
          ? <p className="break-words">{safeCommissionReason(row.last_reason)}</p>
          : <p>{row.state === 'PROCESSING' ? 'Yêu cầu tạo phiếu đang được xử lý. Hãy kiểm tra lại trạng thái.'
            : row.state === 'UNKNOWN' ? 'Chưa xác minh được kết quả tạo phiếu.' : 'Lần tạo phiếu trước báo lỗi.'}</p>}
        {row.can_manage && row.state !== 'PROCESSING' &&
          <Button type="button" size="sm" variant="outline" disabled={busy || retry.isPending} onClick={() => void retryRow(row)}>Tạo lại</Button>}
      </div>)}
      {empty && !rows.length && <p className="text-sm text-muted-foreground">Chưa ghi nhận lỗi tạo phiếu trong phạm vi đang xem.</p>}
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {legacy && <Suspense fallback={<p role="status">Đang mở phiếu hoa hồng…</p>}><CommissionModal open contractId={legacy.contractId}
      onlyKind={legacy.kind} onOpenChange={open => { if (!open) setLegacy(null); }} /></Suspense>}
  </>;
}

/** Hành động tại chi tiết hợp đồng; ghi chú lỗi nằm ngay dưới nút tạo. */
export function ContractCommissionFollowupPanel({ contractId }: { contractId: string }) {
  const query = useContractCommissionFollowups({ contractId });
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [contractId]);
  const rows = query.data?.rows ?? [];
  const canCreate = !query.isPending && !query.isError && rows.some(row => row.can_manage && row.state === 'PENDING');
  return <div className="space-y-2" aria-label="Tạo hoa hồng và thưởng Sale">
    <div><Button type="button" size="sm" variant="outline" disabled={!canCreate} onClick={() => setOpen(true)}>Tạo phiếu hoa hồng</Button></div>
    <CommissionFailureList query={query} scope={contractId} />
    {!query.isError && rows.filter(row => row.state === 'VOUCHER_CREATED').map(row =>
      <p key={row.kind} className="text-xs text-muted-foreground">{KIND_LABEL[row.kind]}: Đã có phiếu{row.voucher_code ? ` ${row.voucher_code}` : ''}.</p>)}
    {!query.isError && rows.filter(row => row.state === 'SETTLED_BY_SUPPORT').map(row =>
      <p key={row.kind} className="text-xs text-muted-foreground">{KIND_LABEL[row.kind]}: Đã xử lý bằng hỗ trợ tiền thuê.</p>)}
    {open && <Suspense fallback={<p role="status">Đang mở phiếu hoa hồng…</p>}><CommissionModal open contractId={contractId}
      onOpenChange={setOpen} /></Suspense>}
  </div>;
}
