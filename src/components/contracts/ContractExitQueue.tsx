import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useContract } from '@/hooks/useContracts';
import { useContractExitCase, useContractExitCases } from '@/hooks/useContractExitCases';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { EXIT_KIND_LABELS } from './ContractReturnStep';
import { TerminateDialog } from './TerminateDialog';

export function ContractExitQueue({ buildingIds = [], showEmpty = false }: { buildingIds?: string[]; showEmpty?: boolean }) {
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { selectedOrganizationId } = useOrganization();
  const { data: permissions } = useMyPermissions();
  const scopeKey = [...buildingIds].sort().join(',');
  const query = useContractExitCases({ buildingIds, state: 'PENDING', limit: 10, offset: page * 10 });
  const selected = useContractExitCase(selectedId);
  const contract = useContract(selected.data?.contract_id);
  const canSettle = canUse(permissions, 'contracts', 'terminate');
  useEffect(() => { setPage(0); setSelectedId(null); }, [scopeKey, selectedOrganizationId]);
  useEffect(() => {
    if (query.data && page > 0 && !query.data.items.length) setPage(value => value - 1);
  }, [query.data, page]);
  if (query.isLoading) return <p className="text-sm text-muted-foreground">Đang tải hồ sơ chờ quyết toán…</p>;
  if (query.isError) return <div role="alert" className="rounded-md border p-3 text-sm">
    Không tải được hồ sơ chờ quyết toán. <Button variant="link" onClick={() => void query.refetch()}>Thử lại</Button>
  </div>;
  if (!query.data?.total) return showEmpty
    ? <p className="rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">Không có hợp đồng chờ quyết toán.</p>
    : null;
  return <section className="rounded-lg border border-amber-200 bg-amber-50/50 p-3" aria-label="Hồ sơ chờ quyết toán">
    <h2 className="font-semibold">Chờ quyết toán <span className="text-amber-800">({query.data.total})</span></h2>
    <p className="mb-2 text-xs text-muted-foreground">Khách đã trả phòng. Mở đúng hồ sơ cũ để xử lý tiếp.</p>
    <div className="divide-y">{query.data.items.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
      <div className="text-sm">
        <Link to={`/contracts/${item.contract_id}`} className="font-medium underline underline-offset-2">
          {item.building_name || 'Tòa nhà'} · {item.room_name || 'Phòng'} · {item.contract_number || item.contract_id.slice(0, 8)}
        </Link>
        <p>{item.customer_name || 'Khách thuê'} · Đã trả {item.actual_move_out_on.split('-').reverse().join('/')}</p>
        <p className="text-xs text-muted-foreground">Loại đã ghi: {EXIT_KIND_LABELS[item.initial_kind]}</p>
      </div>
      {canSettle && <Button size="sm" variant="outline" disabled={!!selectedId} onClick={() => setSelectedId(item.id)}>Quyết toán</Button>}
    </div>)}</div>
    {query.data.total > 10 && <div className="flex items-center justify-end gap-2 pt-2 text-sm">
      <Button size="sm" variant="ghost" disabled={!page} onClick={() => setPage(value => value - 1)}>Trước</Button>
      <span>Trang {page + 1}/{Math.ceil(query.data.total / 10)}</span>
      <Button size="sm" variant="ghost" disabled={(page + 1) * 10 >= query.data.total} onClick={() => setPage(value => value + 1)}>Sau</Button>
    </div>}
    {selectedId && (selected.isLoading || contract.isLoading) && <p role="status" className="pt-2 text-sm">Đang mở hồ sơ…</p>}
    {selectedId && (selected.isError || contract.isError) && <p role="alert" className="pt-2 text-sm text-destructive">
      Không mở được hồ sơ. <Button variant="link" onClick={() => setSelectedId(null)}>Đóng và thử lại</Button>
    </p>}
    {selectedId && selected.data?.state === 'FINALIZED' && <p className="text-sm">Hồ sơ này đã được quyết toán. <Button variant="link" onClick={() => setSelectedId(null)}>Đóng</Button></p>}
    {selectedId && selected.data?.state === 'PENDING' && contract.data?.id === selected.data.contract_id && <TerminateDialog
      open onOpenChange={open => { if (!open) setSelectedId(null); }} contract={contract.data} exitCase={selected.data} />}
  </section>;
}
