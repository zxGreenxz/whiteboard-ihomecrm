import { lazy, Suspense, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useContractExitCases } from '@/hooks/useContractExitCases';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import type { ContractWithRelations } from '@/types/contract';
import { EXIT_KIND_LABELS } from './ContractReturnStep';
import { TerminateDialog } from './TerminateDialog';
import { ContractMeterBoundaryPanel } from './ContractMeterBoundaryPanel';

const TransferPanel = lazy(() => import('./ContractTransferLinkPanel').then(module => ({ default: module.ContractTransferLinkPanel })));

export function ContractExitCasePanel({ contract }: { contract: ContractWithRelations }) {
  const query = useContractExitCases({ contractId: contract.id, limit: 1 });
  const { data: permissions } = useMyPermissions();
  const [open, setOpen] = useState(false);
  if (query.isLoading) return <p className="p-3 text-sm text-muted-foreground">Đang tải hồ sơ trả phòng…</p>;
  if (query.isError) return <p role="alert" className="p-3 text-sm">Không tải được hồ sơ trả phòng. <Button variant="link" onClick={() => void query.refetch()}>Thử lại</Button></p>;
  const exitCase = query.data?.items[0];
  if (!exitCase) return null;
  return <section className="m-3 space-y-3 rounded-lg border bg-background p-4" aria-label="Hồ sơ trả phòng">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="font-semibold">{exitCase.state === 'PENDING' ? 'Đã trả phòng · Chờ quyết toán' : 'Đã chốt quyết toán'}</h2>
        <p className="text-sm">Ngày khách trả: {exitCase.actual_move_out_on.split('-').reverse().join('/')}</p></div>
      {exitCase.state === 'PENDING' && canUse(permissions, 'contracts', 'terminate') && <Button onClick={() => setOpen(true)}>Quyết toán hồ sơ này</Button>}
    </div>
    <div className="text-sm"><p>Loại ban đầu: <strong>{EXIT_KIND_LABELS[exitCase.initial_kind]}</strong></p>
      <p>Loại hiện tại: <strong>{EXIT_KIND_LABELS[exitCase.current_kind]}</strong></p></div>
    <section aria-label="Nội dung thanh lý" className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
      <h3 className="font-medium">Nội dung thanh lý</h3>
      <p className="whitespace-pre-wrap break-words">{exitCase.return_note || 'Chưa có nội dung thanh lý'}</p>
    </section>
    {!!exitCase.kind_history.length && <details className="text-sm"><summary className="cursor-pointer font-medium">Lịch sử đổi loại thanh lý ({exitCase.kind_history.length})</summary>
      <ol className="mt-2 space-y-2">{exitCase.kind_history.map(change => <li key={change.version} className="border-l-2 pl-3">
        <p>{EXIT_KIND_LABELS[change.before_kind]} → {EXIT_KIND_LABELS[change.after_kind]}</p>
        <p>Lý do: {change.reason}</p><p className="text-xs text-muted-foreground">{change.actor_name || change.changed_by} · {new Date(change.changed_at).toLocaleString('vi-VN')}</p>
      </li>)}</ol>
    </details>}
    {exitCase.state === 'FINALIZED' && <p className="text-xs text-muted-foreground">Theo dõi tiền khách trả và tiền hoàn trên các chứng từ hiện có của hợp đồng.</p>}
    <Suspense fallback={<p className="text-sm">Đang tải liên kết nhượng…</p>}><TransferPanel exitCase={exitCase} /></Suspense>
    <ContractMeterBoundaryPanel key={contract.id} contractId={contract.id} roomId={exitCase.room_at_handover_id}
      canEdit={canUse(permissions, 'contracts', 'edit')} />
    {open && exitCase.state === 'PENDING' && <TerminateDialog open={open} onOpenChange={setOpen} contract={contract} exitCase={exitCase} />}
  </section>;
}
