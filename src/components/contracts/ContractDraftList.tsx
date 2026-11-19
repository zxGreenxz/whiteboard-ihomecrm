import { useRef, useState } from 'react';
import { Pencil, Loader2, FileCheck2, Printer, Trash2, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/loading/LoadingState';
import { useContractDrafts, useDeleteContractDraft } from '@/hooks/useContractDrafts';
import { useRooms } from '@/hooks/useRooms';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from '@/components/ui/alert-dialog';
import { draftErrorMessage, type ContractDraft } from '@/lib/contractDrafts';

export interface ContractDraftListProps {
  buildingId?: string; buildingIds?: string[]; canEdit: boolean; canExport: boolean; canSign: boolean;
  onEdit: (draft: ContractDraft) => void; onPrint: (draft: ContractDraft) => void;
  onSign: (draft: ContractDraft) => void;
  onTransfer: (draft: ContractDraft) => void;
  canDelete?: (draft: ContractDraft) => boolean;
  /** "sheet": dòng gọn cho bảng trượt của mobile, thao tác phụ gom sau nút "⋯". */
  layout?: 'page' | 'sheet';
}

type DraftActions = Pick<ContractDraftListProps, 'canEdit' | 'canExport' | 'canSign' | 'canDelete' | 'onEdit' | 'onPrint' | 'onSign' | 'onTransfer'>;

// "31/10 19:30": toLocale* của vi-VN với ngày + tháng lại ghi "31-10", lệch mọi ngày khác trên trang.
const editedAt = (value: string) => {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

function DraftSheetRows({ drafts, canEdit, canExport, canSign, canDelete, onEdit, onPrint, onSign, onTransfer, onDelete }: DraftActions & {
  drafts: ContractDraft[]; onDelete: (draft: ContractDraft) => void;
}) {
  const { data: roomsData } = useRooms();
  const [openId, setOpenId] = useState<string>();
  const rooms = new Map((Array.isArray(roomsData) ? roomsData : []).map(room => [room.id, room]));
  return <div className="cm-qrows">{drafts.map(draft => {
    const signed = draft.status === 'SIGNED';
    const room = draft.room_id ? rooms.get(draft.room_id) : undefined;
    const start = draft.payload.form.start_date;
    const canSignRow = canSign && !signed;
    const canDeleteRow = !signed && !!canDelete?.(draft);
    const hasMore = canSignRow || canExport || canEdit || canDeleteRow;
    const open = openId === draft.id;
    return <div key={draft.id} className="cm-qdraft">
      <div className="cm-qdraft-top">
        <div className="cm-qrow-main">
          <div className="cm-qrow-head">
            <span className="cm-qrow-loc plain">{room ? `P.${room.name} · ${room.building?.name ?? '—'}` : draft.room_id ? 'Đã chọn phòng' : 'Chưa chọn phòng'}</span>
            {signed && <span className="cm-qrow-tag done">Đã ký</span>}
          </div>
          <p className="cm-qrow-detail">{draft.payload.customers.find(c => c.is_representative)?.full_name || 'Chưa chọn khách đại diện'}</p>
          <p className="cm-qdraft-meta">{start ? `Bắt đầu ${start.split('-').reverse().join('/')}` : 'Chưa có ngày bắt đầu'} · Bản {draft.revision} · Sửa {editedAt(draft.updated_at)}</p>
        </div>
        {canEdit && !signed && <Button variant="outline" className="cm-qbtn" aria-label="Sửa nháp" onClick={() => onEdit(draft)}>Sửa</Button>}
        {hasMore && <Button variant="ghost" size="icon" className="cm-qbtn-icon" aria-label="Thao tác khác" aria-expanded={open}
          onClick={() => setOpenId(open ? undefined : draft.id)}><MoreHorizontal className="h-5 w-5" /></Button>}
      </div>
      {open && <div className="cm-qdraft-actions">
        {canSignRow && <Button className="cm-qbtn cm-qbtn-primary wide" onClick={() => onSign(draft)}><FileCheck2 className="mr-1 h-4 w-4" />Xác nhận đã ký</Button>}
        {canExport && <Button variant="outline" className="cm-qbtn" onClick={() => onPrint(draft)}><Printer className="mr-1 h-4 w-4" />In</Button>}
        {canEdit && <Button variant="outline" className="cm-qbtn" onClick={() => onTransfer(draft)}>Liên kết nhượng</Button>}
        {canDeleteRow && <Button variant="outline" className="cm-qbtn danger" onClick={() => onDelete(draft)}><Trash2 className="mr-1 h-4 w-4" />Xóa nháp</Button>}
      </div>}
    </div>;
  })}</div>;
}

export function ContractDraftList({ buildingId, buildingIds, canEdit, canExport, canSign, canDelete, onEdit, onPrint, onSign, onTransfer, layout = 'page' }: ContractDraftListProps) {
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
  if (query.isLoading) return <LoadingState label="bản nháp" variant="table" rows={3} className="px-3" />;
  if (query.isError) return <div role="alert" className="p-4 text-sm text-destructive">{draftErrorMessage(query.error)}<Button variant="link" onClick={() => void query.refetch()}>Thử lại</Button></div>;
  const drafts = query.data?.filter(draft => !buildingIds?.length || buildingIds.includes(draft.building_id)) ?? [];
  if (!drafts.length) return <p className="p-6 text-sm text-muted-foreground text-center">Chưa có bản nháp. Chọn “Soạn nháp” để lưu thông tin trước khi ký.</p>;
  return <>{layout === 'sheet' ? <DraftSheetRows drafts={drafts} canEdit={canEdit} canExport={canExport} canSign={canSign} canDelete={canDelete}
    onEdit={onEdit} onPrint={onPrint} onSign={onSign} onTransfer={onTransfer} onDelete={draft => { setDeleteError(''); setDeleting(draft); }} />
    : <div className="divide-y rounded-md border">{drafts.map(draft => <div key={draft.id} className="p-4 flex flex-wrap items-start justify-between gap-3">
    <div><div className="font-medium">{draft.status === 'SIGNED' ? 'Đã ký từ nháp' : 'Bản nháp'} · {draft.payload.customers.find(c => c.is_representative)?.full_name || 'Chưa chọn khách đại diện'}</div><p className="text-sm text-muted-foreground">Phiên bản {draft.revision} · {draft.room_id ? 'Đã chọn phòng' : 'Chưa chọn phòng'} · {draft.payload.form.start_date || 'Chưa có ngày bắt đầu'}</p><p className="text-xs text-muted-foreground">Cập nhật {new Date(draft.updated_at).toLocaleString('vi-VN')}</p></div>
    <div className="flex flex-wrap gap-2">{canEdit && draft.status !== 'SIGNED' && <Button variant="outline" size="sm" onClick={() => onEdit(draft)}><Pencil className="h-4 w-4 mr-1" />Sửa nháp</Button>}{canExport && <Button variant="outline" size="sm" onClick={() => onPrint(draft)}><Printer className="h-4 w-4 mr-1" />In</Button>}
      {canSign && draft.status !== 'SIGNED' && <Button size="sm" onClick={() => onSign(draft)}><FileCheck2 className="h-4 w-4 mr-1" />Xác nhận đã ký</Button>}
      {canEdit && <Button variant="outline" size="sm" onClick={() => onTransfer(draft)}>Liên kết nhượng</Button>}
      {draft.status !== 'SIGNED' && canDelete?.(draft) && <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => { setDeleteError(''); setDeleting(draft); }}><Trash2 className="h-4 w-4 mr-1" />Xóa nháp</Button>}
    </div>
  </div>)}</div>}
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
