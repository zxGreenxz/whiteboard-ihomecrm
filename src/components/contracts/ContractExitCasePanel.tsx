import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/loading/LoadingState';
import { useContractExitCases } from '@/hooks/useContractExitCases';
import { useContractExitSettlementDrafts } from '@/hooks/useContractExitSettlementDrafts';
import { draftSavedBy } from '@/lib/contractExitSettlementDrafts';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import type { ContractWithRelations } from '@/types/contract';
import { EXIT_KIND_LABELS } from './ContractReturnStep';
import { TerminateDialog } from './TerminateDialog';
import { ContractMeterBoundaryPanel } from './ContractMeterBoundaryPanel';
import { ExitCommissionDialog } from './ExitCommissionForm';
import { earlyTermsStatus } from './ExitEarlyTermsPanel';
import { useContractExitEarlyTerms } from '@/hooks/contracts/useContractExitEarlyTerms';
import { EARLY_REASON_LABELS, needsExitCommission } from '@/lib/contractExitEarlyTerms';

const vnd = (value: number) => new Intl.NumberFormat('vi-VN').format(value);

export function ContractExitCasePanel({ contract }: { contract: ContractWithRelations }) {
  const query = useContractExitCases({ contractId: contract.id, limit: 1 });
  const { data: permissions } = useMyPermissions();
  const [open, setOpen] = useState(false);
  const [resumeDraft, setResumeDraft] = useState(false);
  const pendingCase = query.data?.items[0]?.state === 'PENDING' ? query.data.items[0] : undefined;
  const canSettle = canUse(permissions, 'contracts', 'terminate');
  const drafts = useContractExitSettlementDrafts(pendingCase && canSettle ? [pendingCase.id] : []);
  const draft = pendingCase ? drafts.data?.find(item => item.caseId === pendingCase.id) : undefined;
  const caseId = query.data?.items[0]?.id;
  const earlyQuery = useContractExitEarlyTerms(caseId ? { exitCaseId: caseId } : null);
  const earlyTerms = earlyQuery.data?.[0];
  const [commissionOpen, setCommissionOpen] = useState(false);
  const canCommission = canUse(permissions, 'income_expenses', 'create');
  // Khung hồ sơ chỉ có khi hợp đồng đã có hồ sơ trả phòng — chờ thì không vẽ gì để
  // khỏi hiện rồi biến (chủ chốt 02/10/2026: không chữ "Đang tải…").
  if (query.isLoading) return <LoadingState label="hồ sơ trả phòng" variant="none" />;
  if (query.isError) return <p role="alert" className="p-3 text-sm">Không tải được hồ sơ trả phòng. <Button variant="link" onClick={() => void query.refetch()}>Thử lại</Button></p>;
  const exitCase = query.data?.items[0];
  if (!exitCase) return null;
  return <section className="m-3 space-y-3 rounded-lg border bg-background p-4" aria-label="Hồ sơ trả phòng">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="font-semibold">{exitCase.state === 'PENDING' ? 'Đã trả phòng · Chờ quyết toán' : 'Đã chốt quyết toán'}</h2>
        <p className="text-sm">Ngày khách trả: {exitCase.actual_move_out_on.split('-').reverse().join('/')}</p></div>
      {exitCase.state === 'PENDING' && canSettle && <div className="flex flex-col items-end gap-1">
        {draft && <p className="text-xs text-sky-800">Có nháp · lưu {draftSavedBy(draft)}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          {draft && <Button onClick={() => { setResumeDraft(true); setOpen(true); }}>Mở bản nháp</Button>}
          <Button variant={draft ? 'outline' : 'default'} onClick={() => { setResumeDraft(false); setOpen(true); }}>Quyết toán hồ sơ này</Button>
        </div>
      </div>}
    </div>
    <div className="text-sm"><p>Loại ban đầu: <strong>{EXIT_KIND_LABELS[exitCase.initial_kind]}</strong></p>
      <p>Loại hiện tại: <strong>{EXIT_KIND_LABELS[exitCase.current_kind]}</strong></p>
      {earlyTerms && <p>Trường hợp: <strong>{EARLY_REASON_LABELS[earlyTerms.early_reason]}</strong>
        {earlyTerms.sale_name && <> · Sale: <strong>{earlyTerms.sale_name}</strong></>}
        {earlyTerms.early_reason === 'SALE_ASSISTED' && <> · Phí môi giới {vnd(earlyTerms.broker_fee)} đ</>}</p>}
      {earlyTerms && exitCase.state === 'PENDING' && <p className="text-muted-foreground">{earlyTermsStatus(earlyTerms)}</p>}
      {earlyTerms?.commission_voucher_id && <p>Phiếu hoa hồng môi giới: <strong>{earlyTerms.commission_code ?? ''}</strong>
        {earlyTerms.commission_live === false && <span className="text-amber-800"> (đã huỷ — lập lại phiếu mới)</span>}</p>}
      {!earlyTerms && !earlyQuery.isLoading && !earlyQuery.isError && exitCase.state === 'PENDING' && exitCase.current_kind === 'EARLY_RETURN'
        && <p className="text-amber-800">Chưa chọn trường hợp trả phòng trước hạn: chọn khi quyết toán.</p>}
      {earlyQuery.isError && <p role="alert" className="text-destructive">Không tải được trường hợp trả phòng trước hạn. <Button variant="link" className="h-auto p-0" onClick={() => void earlyQuery.refetch()}>Thử lại</Button></p>}
    </div>
    {needsExitCommission(earlyTerms) && earlyTerms && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p>Hồ sơ nhờ sale đã quyết toán nhưng chưa có phiếu hoa hồng môi giới cho sale {earlyTerms.sale_name} ({vnd(earlyTerms.broker_fee)} đ).</p>
      {canCommission && <Button size="sm" onClick={() => setCommissionOpen(true)}>Lập phiếu hoa hồng</Button>}
    </div>}
    {commissionOpen && earlyTerms && <ExitCommissionDialog exitCaseId={earlyTerms.exit_case_id} open={commissionOpen} onOpenChange={setCommissionOpen} />}
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
    <ContractMeterBoundaryPanel key={contract.id} contractId={contract.id} roomId={exitCase.room_at_handover_id}
      canEdit={canUse(permissions, 'contracts', 'edit')} exit={exitCase} />
    {open && <TerminateDialog open={open} onOpenChange={setOpen} contract={contract} exitCase={exitCase} resumeDraft={resumeDraft} />}
  </section>;
}
