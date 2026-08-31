// =============================================================================
// PeriodFeeSharedModals — cụm 5 modal mà PeriodFeePanel (desktop) và
// PeriodFeeSheet (mobile) trước đây mỗi bên chép một bản (audit 31/08 P3-02:
// ~55 dòng wiring × 2, đã lệch nhau một lần suýt gây bug seed defaultBookId).
//
// GIỮ NGUYÊN kiến trúc "modal local từng bề mặt" (usePeriodFeeState.ts:43-44):
// mỗi bề mặt mount MỘT instance của component này với state S CỦA RIÊNG NÓ —
// dùng chung là mở hai hộp thoại xếp lớp, đúng chủ ý cũ. Đây là dedupe WIRING,
// không phải hợp nhất modal-instance.
//
// KHÔNG gom vào đây (khác nhau THẬT giữa hai bề mặt — đừng "thống nhất"):
//   • UtilityCancelModal: Sheet trộn nguồn huỷ của cả Điện-Nước (EN), Panel không;
//   • AttachmentLightbox: Sheet trộn 2 nguồn ảnh (GRID + EN receipt).
// =============================================================================

import type { usePeriodFeeState } from '@/hooks/usePeriodFeeState';
import type { FeeCategory } from '@/lib/feeCategories';
import type { PeriodCommissionRow } from '@/hooks/usePeriodFees';
import { PeriodFeeEditModal } from './PeriodFeeEditModal';
import { PeriodFeeVoucherList, PeriodFeePayDraftModal, PeriodFeeDupConfirmModal } from './PeriodFeeVoucherList';
import { PeriodCommissionModal } from './PeriodCommissionModal';

interface Props {
  S: ReturnType<typeof usePeriodFeeState>;
  isAdmin: boolean;
  canRecordPayment: boolean;
  cat: FeeCategory | undefined;
  buildings: { id: string; name: string }[];
  /** Toà đang mở danh sách phiếu (tab Lịch sử) — state của TỪNG bề mặt. */
  vlistFor: string | null;
  setVlistFor: (id: string | null) => void;
  /** Dòng hoa hồng đang mở modal trả — state của TỪNG bề mặt. */
  commRow: PeriodCommissionRow | null;
  setCommRow: (row: PeriodCommissionRow | null) => void;
  onView: (attachments: string[], index?: number) => void;
}

export function PeriodFeeSharedModals({
  S, isAdmin, canRecordPayment, cat, buildings,
  vlistFor, setVlistFor, commRow, setCommRow, onView,
}: Props) {
  return (
    <>
      <PeriodFeeEditModal
        target={S.editTarget}
        isAdmin={isAdmin}
        myBooks={S.myBooks}
        saving={S.saving}
        uploading={S.uploadingKey === '__edit__'}
        onAttach={S.onEditAttachClick}
        onView={onView}
        onClose={S.closeEdit}
        onSave={(args) => S.submitEdit({ isAdmin, ...args })}
      />
      <PeriodFeeVoucherList
        open={!!vlistFor}
        title={vlistFor ? `${cat?.label ?? ''} · ${buildings.find((b) => b.id === vlistFor)?.name ?? ''}` : ''}
        vouchers={vlistFor ? S.vouchersOf(vlistFor) : []}
        canRecordPayment={canRecordPayment}
        onView={onView}
        onEdit={(v) => { S.openEdit(vlistFor!, v); setVlistFor(null); }}
        onCancel={(v) => { S.requestCancel(vlistFor!, v); setVlistFor(null); }}
        onPayDraft={(v) => { S.openPayDraft(vlistFor!, v); setVlistFor(null); }}
        onClose={() => setVlistFor(null)}
      />
      <PeriodFeePayDraftModal
        target={S.draftTarget}
        myBooks={S.myBooks}
        defaultBookId={S.draftTarget ? S.defaultBookFor(S.draftTarget.buildingId) : S.defaultBookId}
        attachments={S.draftPayAttachments}
        uploading={S.uploadingKey === '__draftpay__'}
        busy={S.payingDraft}
        onAttach={S.onDraftPayAttachClick}
        onView={onView}
        onClose={S.closePayDraft}
        onSubmit={S.submitPayDraft}
      />
      <PeriodFeeDupConfirmModal
        target={S.dupConfirm}
        busy={S.payingKey != null}
        onClose={S.closeDupConfirm}
        onConfirm={S.confirmPayDup}
      />
      <PeriodCommissionModal
        row={commRow}
        myBooks={S.myBooks}
        defaultBookId={S.defaultBookId}
        onClose={() => setCommRow(null)}
      />
    </>
  );
}
