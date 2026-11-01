import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/loading/LoadingState';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useContract } from '@/hooks/useContracts';
import { useContractExitCase, useContractExitCases } from '@/hooks/useContractExitCases';
import { useContractExitSettlementDrafts } from '@/hooks/useContractExitSettlementDrafts';
import { draftSavedBy, type ExitSettlementDraftMeta } from '@/lib/contractExitSettlementDrafts';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { EXIT_KIND_LABELS } from './ContractReturnStep';
import { TerminateDialog } from './TerminateDialog';

// Hồ sơ có nháp: "Mở bản nháp" điền lại nháp, "Quyết toán" mở form mới (chủ chốt 30/10/2026).
function SettleActions({ draft, disabled, onOpen }: { draft?: ExitSettlementDraftMeta; disabled: boolean; onOpen: (resume: boolean) => void }) {
  return <div className="flex flex-col items-end gap-1">
    {draft && <p className="text-xs text-sky-800">Có nháp · lưu {draftSavedBy(draft)}</p>}
    <div className="flex flex-wrap justify-end gap-2">
      {draft && <Button size="sm" disabled={disabled} onClick={() => onOpen(true)}>Mở bản nháp</Button>}
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => onOpen(false)}>Quyết toán</Button>
    </div>
  </div>;
}

export function ContractExitQueue({ buildingIds = [], showEmpty = false }: { buildingIds?: string[]; showEmpty?: boolean }) {
  const [page, setPage] = useState(0);
  // resume: mở từ "Mở bản nháp" (điền lại nháp); "Quyết toán" mở form mới.
  const [selected, setSelected] = useState<{ id: string; resume: boolean } | null>(null);
  const selectedId = selected?.id ?? null;
  const { selectedOrganizationId } = useOrganization();
  const { data: permissions } = useMyPermissions();
  const scopeKey = [...buildingIds].sort().join(',');
  const query = useContractExitCases({ buildingIds, state: 'PENDING', limit: 10, offset: page * 10 });
  const opened = useContractExitCase(selectedId);
  const contract = useContract(opened.data?.contract_id);
  const canSettle = canUse(permissions, 'contracts', 'terminate');
  const drafts = useContractExitSettlementDrafts(canSettle ? query.data?.items.map(item => item.id) ?? [] : []);
  const draftByCase = new Map((drafts.data ?? []).map(draft => [draft.caseId, draft]));
  useEffect(() => { setPage(0); setSelected(null); }, [scopeKey, selectedOrganizationId]);
  useEffect(() => {
    if (query.data && page > 0 && !query.data.items.length) setPage(value => value - 1);
  }, [query.data, page]);
  // Ở danh sách hợp đồng khung này chỉ hiện khi có hồ sơ → chờ thì không vẽ gì; ở tab
  // "Chờ quyết toán" (showEmpty) nó là nội dung chính → khối xám dạng dòng.
  if (query.isLoading) return <LoadingState label="hồ sơ chờ quyết toán" variant={showEmpty ? 'table' : 'none'} rows={3} />;
  if (query.isError) return <div role="alert" className="rounded-md border p-3 text-sm">
    Không tải được hồ sơ chờ quyết toán. <Button variant="link" onClick={() => void query.refetch()}>Thử lại</Button>
  </div>;
  if (!query.data?.total) return showEmpty
    ? <p className="rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">Không có hợp đồng chờ quyết toán.</p>
    : null;
  return <section className="rounded-lg border border-amber-200 bg-amber-50/50 p-3" aria-label="Hồ sơ chờ quyết toán">
    <h2 className="font-semibold">Chờ quyết toán <span className="text-amber-800">({query.data.total})</span></h2>
    <p className="mb-2 text-xs text-muted-foreground">Khách đã trả phòng. Mở đúng hồ sơ cũ để xử lý tiếp.</p>
    {drafts.isError && <p role="status" className="mb-2 text-xs text-muted-foreground">Chưa tải được dấu bản nháp. Bấm "Quyết toán" vẫn thấy nháp nếu hồ sơ có.</p>}
    <div className="divide-y">{query.data.items.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
      <div className="text-sm">
        <Link to={`/contracts/${item.contract_id}`} className="font-medium underline underline-offset-2">
          {item.building_name || 'Tòa nhà'} · {item.room_name || 'Phòng'} · {item.contract_number || item.contract_id.slice(0, 8)}
        </Link>
        <p>{item.customer_name || 'Khách thuê'} · Đã trả {item.actual_move_out_on.split('-').reverse().join('/')}</p>
        <p className="text-xs text-muted-foreground">Loại đã ghi: {EXIT_KIND_LABELS[item.initial_kind]}</p>
      </div>
      {canSettle && <SettleActions draft={draftByCase.get(item.id)} disabled={!!selectedId}
        onOpen={resume => setSelected({ id: item.id, resume })} />}
    </div>)}</div>
    {query.data.total > 10 && <div className="flex items-center justify-end gap-2 pt-2 text-sm">
      <Button size="sm" variant="ghost" disabled={!page} onClick={() => setPage(value => value - 1)}>Trước</Button>
      <span>Trang {page + 1}/{Math.ceil(query.data.total / 10)}</span>
      <Button size="sm" variant="ghost" disabled={(page + 1) * 10 >= query.data.total} onClick={() => setPage(value => value + 1)}>Sau</Button>
    </div>}
    {selectedId && (opened.isLoading || contract.isLoading) && <p role="status" className="pt-2 text-sm">Đang mở hồ sơ…</p>}
    {selectedId && (opened.isError || contract.isError) && <p role="alert" className="pt-2 text-sm text-destructive">
      Không mở được hồ sơ. <Button variant="link" onClick={() => setSelected(null)}>Đóng và thử lại</Button>
    </p>}
    {selectedId && opened.data?.state === 'FINALIZED' && <p className="text-sm">Hồ sơ này đã được quyết toán. <Button variant="link" onClick={() => setSelected(null)}>Đóng</Button></p>}
    {selectedId && opened.data?.state === 'PENDING' && contract.data?.id === opened.data.contract_id && <TerminateDialog
      open onOpenChange={open => { if (!open) setSelected(null); }} contract={contract.data} exitCase={opened.data} resumeDraft={!!selected?.resume} />}
  </section>;
}
