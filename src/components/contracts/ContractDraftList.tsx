import { useRef, useState } from 'react';
import { Pencil, Loader2, FileCheck2, Printer, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useContractDrafts, useDeleteContractDraft } from '@/hooks/useContractDrafts';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from '@/components/ui/alert-dialog';
import { draftErrorMessage, type ContractDraft } from '@/lib/contractDrafts';

export interface ContractDraftListProps {
  buildingId?: string; buildingIds?: string[]; canEdit: boolean; canExport: boolean; canSign: boolean;
  onEdit: (draft: ContractDraft) => void; onPrint: (draft: ContractDraft) => void;
  onSign: (draft: ContractDraft) => void;
  onTransfer: (draft: ContractDraft) => void;
  canDelete?: (draft: ContractDraft) => boolean;
}
export function ContractDraftList({ buildingId, buildingIds, canEdit, canExport, canSign, canDelete, onEdit, onPrint, onSign, onTransfer }: ContractDraftListProps) {
  const query = useContractDrafts(buildingId);
  const remove = useDeleteContractDraft();
  const [deleting, setDeleting] = useState<ContractDraft>();
  const [deleteError, setDeleteError] = useState('');
  const inFlight = useRef(false);
  const confirmDelete = async () => {
    if (!deleting || !canDelete?.(deleting) || inFlight.current) return;
    inFlight.current = true; setDeleteError('');
    try { await remove.mutateAsync(deleting); setDeleting(undefined); }
    catch (error) { setDeleteError(draftErrorMessage(error)); }
    finally { inFlight.current = false; }
  };
  if (query.isLoading) return <p className="flex gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Đang tải bản nháp…</p>;
  if (query.isError) return <div role="alert" className="p-4 text-sm text-destructive">{draftErrorMessage(query.error)}<Button variant="link" onClick={() => void query.refetch()}>Thử lại</Button></div>;
  const drafts = query.data?.filter(draft => !buildingIds?.length || buildingIds.includes(draft.building_id)) ?? [];
  if (!drafts.length) return <p className="p-6 text-sm text-muted-foreground text-center">Chưa có bản nháp. Chọn “Soạn nháp” để lưu thông tin trước khi ký.</p>;
  return <><div className="divide-y rounded-md border">{drafts.map(draft => <div key={draft.id} className="p-4 flex flex-wrap items-start justify-between gap-3">
    <div><div className="font-medium">{draft.status === 'SIGNED' ? 'Đã ký từ nháp' : 'Bản nháp'} · {draft.payload.customers.find(c => c.is_representative)?.full_name || 'Chưa chọn khách đại diện'}</div><p className="text-sm text-muted-foreground">Phiên bản {draft.revision} · {draft.room_id ? 'Đã chọn phòng' : 'Chưa chọn phòng'} · {draft.payload.form.start_date || 'Chưa có ngày bắt đầu'}</p><p className="text-xs text-muted-foreground">Cập nhật {new Date(draft.updated_at).toLocaleString('vi-VN')}</p></div>
    <div className="flex flex-wrap gap-2">{canEdit && draft.status !== 'SIGNED' && <Button variant="outline" size="sm" onClick={() => onEdit(draft)}><Pencil className="h-4 w-4 mr-1" />Sửa nháp</Button>}{canExport && <Button variant="outline" size="sm" onClick={() => onPrint(draft)}><Printer className="h-4 w-4 mr-1" />In</Button>}
      {canSign && draft.status !== 'SIGNED' && <Button size="sm" onClick={() => onSign(draft)}><FileCheck2 className="h-4 w-4 mr-1" />Xác nhận đã ký</Button>}
      {canEdit && <Button variant="outline" size="sm" onClick={() => onTransfer(draft)}>Liên kết nhượng</Button>}
      {draft.status !== 'SIGNED' && canDelete?.(draft) && <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => { setDeleteError(''); setDeleting(draft); }}><Trash2 className="h-4 w-4 mr-1" />Xóa nháp</Button>}
    </div>
  </div>)}</div>
    <AlertDialog open={!!deleting} onOpenChange={open => { if (!open && !inFlight.current) setDeleting(undefined); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Xóa bản nháp này?</AlertDialogTitle>
        <AlertDialogDescription>Bản nháp của {deleting?.payload.customers.find(c => c.is_representative)?.full_name || 'khách chưa được chọn'} sẽ được bỏ khỏi danh sách và không thể tiếp tục sửa hoặc ký.</AlertDialogDescription>
      </AlertDialogHeader>
      {deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}
      <AlertDialogFooter><AlertDialogCancel disabled={remove.isPending}>Hủy</AlertDialogCancel>
        <Button variant="destructive" disabled={remove.isPending} onClick={() => void confirmDelete()}>{remove.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Xóa nháp</Button>
      </AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </>;
}
