import { FileDown, Pencil, Loader2, FileCheck2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useContractDrafts, useDownloadContractDraftDocument } from '@/hooks/useContractDrafts';
import { draftErrorMessage, type ContractDraft } from '@/lib/contractDrafts';

export interface ContractDraftListProps {
  buildingId?: string; canEdit: boolean; canExport: boolean; canSign: boolean;
  onEdit: (draft: ContractDraft) => void; onExport: (draft: ContractDraft) => void;
  onSign: (draft: ContractDraft) => void;
  onTransfer: (draft: ContractDraft) => void;
}
export function ContractDraftList({ buildingId, canEdit, canExport, canSign, onEdit, onExport, onSign, onTransfer }: ContractDraftListProps) {
  const query = useContractDrafts(buildingId);
  const download = useDownloadContractDraftDocument();
  if (query.isLoading) return <p className="flex gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Đang tải bản nháp…</p>;
  if (query.isError) return <div role="alert" className="p-4 text-sm text-destructive">{draftErrorMessage(query.error)}<Button variant="link" onClick={() => void query.refetch()}>Thử lại</Button></div>;
  if (!query.data?.length) return <p className="p-6 text-sm text-muted-foreground text-center">Chưa có bản nháp. Chọn “Soạn nháp” để lưu thông tin trước khi ký.</p>;
  return <div className="divide-y rounded-md border">{query.data.map(draft => <div key={draft.id} className="p-4 flex flex-wrap items-start justify-between gap-3">
    <div><div className="font-medium">{draft.status === 'SIGNED' ? 'Đã ký từ nháp' : 'Bản nháp'} · {draft.payload.customers.find(c => c.is_representative)?.full_name || 'Chưa chọn khách đại diện'}</div><p className="text-sm text-muted-foreground">Phiên bản {draft.revision} · {draft.room_id ? 'Đã chọn phòng' : 'Chưa chọn phòng'} · {draft.payload.form.start_date || 'Chưa có ngày bắt đầu'}</p><p className="text-xs text-muted-foreground">Cập nhật {new Date(draft.updated_at).toLocaleString('vi-VN')}</p></div>
    <div className="flex flex-wrap gap-2">{canEdit && draft.status !== 'SIGNED' && <Button variant="outline" size="sm" onClick={() => onEdit(draft)}><Pencil className="h-4 w-4 mr-1" />Sửa nháp</Button>}{canExport && canEdit && draft.status !== 'SIGNED' && <Button variant="outline" size="sm" onClick={() => onExport(draft)}><FileDown className="h-4 w-4 mr-1" />Xuất nháp</Button>}
      {(canSign || (canExport && draft.status === 'SIGNED')) && <Button size="sm" variant={draft.status === 'SIGNED' ? 'outline' : 'default'}
        onClick={() => onSign(draft)}><FileCheck2 className="h-4 w-4 mr-1" />{draft.status === 'SIGNED' ? 'Xem hợp đồng đã ký' : 'Xác nhận đã ký'}</Button>}
      {canEdit && <Button variant="outline" size="sm" onClick={() => onTransfer(draft)}>Liên kết nhượng</Button>}
      {canExport && draft.documents.map(document => <Button key={document.id} variant="secondary" size="sm" disabled={download.isPending} onClick={() => download.mutate(document)}><FileDown className="h-4 w-4 mr-1" />Tải v{document.revision}</Button>)}
    </div>
  </div>)}</div>;
}
