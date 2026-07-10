import { useState } from "react";
import { X, Ban, Layers, ChevronRight, Pencil, FileText, ImagePlus } from "lucide-react";
import { format } from "date-fns";
import { formatPeriod } from "@/lib/monthPeriod";
import { StorageImage } from "@/components/ui/storage-image";
import { AttachmentLightbox } from "@/components/ui/attachment-lightbox";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { useAuth } from "@/hooks/useAuth";
import { useAccounts } from "@/hooks/useAccounts";
import { useUpdateBatchAccount, useUpdateBatchAttachments } from "@/hooks/useIncomeExpenses";
import AttachmentUpload from "./AttachmentUpload";
import type {
  IncomeExpenseBatchSummary,
  IncomeExpenseWithRelations,
} from "@/hooks/useIncomeExpenses";
import IncomeExpenseDetailMobile from "./IncomeExpenseDetailMobile";

interface Props {
  batch: IncomeExpenseBatchSummary;
  onClose: () => void;
  onCancelBatch?: (batchId: string) => void;
  onEditVoucher?: (voucher: IncomeExpenseWithRelations) => void;
  onCancelVoucher?: (voucherId: string) => void;
  onApproveVoucher?: (voucher: IncomeExpenseWithRelations) => void;
}

const fmtVND = (n: number) => `${n.toLocaleString("vi-VN")} đ`;
const isPdf = (url: string) => /\.pdf(\?|$)/i.test(url);

/**
 * Chi tiết phiếu tổng — bottom-sheet warm-neutral, dựng cùng "ngôn ngữ Thu tiền".
 * Hiện thông tin đợt + đính kèm dùng chung + danh sách phiếu con; chạm phiếu con
 * → mở chi tiết phiếu (IncomeExpenseDetailMobile). Giữ nguyên nghiệp vụ của dialog
 * cũ: huỷ cả đợt, đổi sổ quỹ cả đợt (admin), sửa/huỷ/duyệt từng phiếu con.
 */
export function IncomeExpenseBatchDetailMobile({
  batch,
  onClose,
  onCancelBatch,
  onEditVoucher,
  onCancelVoucher,
  onApproveVoucher,
}: Props) {
  const [child, setChild] = useState<IncomeExpenseWithRelations | null>(null);
  // Xem ảnh đính kèm dùng chung ngay trên trang (overlay), KHÔNG mở tab mới.
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  // Chế độ bổ sung/xoá ảnh đính kèm dùng chung. Giữ danh sách đang sửa ở
  // state cục bộ để dropzone phản hồi ngay, mutation auto-save từng thay đổi.
  const [editAtts, setEditAtts] = useState<string[] | null>(null);
  const { data: isAdmin = false } = useIsAdmin();
  const { data: authUser } = useAuth();
  const { data: accounts = [] } = useAccounts();
  const updateBatchAccount = useUpdateBatchAccount();
  const updateBatchAttachments = useUpdateBatchAttachments();

  const isExpense = batch.type === "EXPENSE";
  const accent = isExpense ? "#d6453f" : "#1f9d57";

  const allSameAccount =
    batch.vouchers.length > 0 &&
    batch.vouchers.every((v) => v.account_id === batch.vouchers[0].account_id);
  const sharedAccountId = allSameAccount ? batch.vouchers[0]?.account_id ?? null : null;
  const canEditAccount = isAdmin && allSameAccount && !batch.all_cancelled;
  // Người tạo đợt hoặc admin được bổ sung/xoá ảnh giao dịch sau khi đã tạo.
  const canEditAttachments =
    (isAdmin || authUser?.id === batch.user_id) && !batch.all_cancelled;

  const handleAttachmentsChange = (urls: string[]) => {
    setEditAtts(urls);
    updateBatchAttachments.mutate({ batchId: batch.id, attachments: urls });
  };

  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="vd-row">
      <div className="vd-row-l">{label}</div>
      <div className="vd-row-v">{value || "—"}</div>
    </div>
  );

  return (
    // stopPropagation cho nhất quán với sheet con (chống nổi bọt khi lồng sheet).
    <div className="sheet-ov" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="vd-hd">
          <span className="vd-hd-t" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Layers size={15} />
            CHI TIẾT PHIẾU TỔNG
          </span>
          <button className="sheet-x" onClick={onClose} aria-label="Đóng">
            <X size={18} />
          </button>
        </div>

        <div className="vd-sec">
          <span className="vd-sec-t">Thông tin chung</span>
          {batch.has_approved && onCancelBatch && (
            <div className="vd-acts">
              <button
                className="vd-act"
                style={{ background: "#f97316" }}
                aria-label="Huỷ cả đợt"
                title="Huỷ cả đợt"
                onClick={() => {
                  onCancelBatch(batch.id);
                  onClose();
                }}
              >
                <Ban size={15} />
              </button>
            </div>
          )}
        </div>

        <div className="vd-table">
          <div className="vd-row">
            <div className="vd-row-l">Tên đợt</div>
            <div className="vd-row-v">
              <b>{batch.name}</b>
              {batch.all_cancelled && (
                <span className="vd-tag" style={{ color: "#b91c1c", background: "#fee2e2" }}>
                  Đã huỷ toàn bộ
                </span>
              )}
            </div>
          </div>
          <div className="vd-row">
            <div className="vd-row-l">Tổng tiền</div>
            <div className="vd-row-v" style={{ color: accent, fontWeight: 700 }}>
              {isExpense ? "−" : "+"}
              {fmtVND(batch.total_amount)}
            </div>
          </div>
          <Row
            label="Số phiếu trong đợt"
            value={`${batch.voucher_count} phiếu (${batch.building_names.length} toà nhà)`}
          />
          <div className="vd-row">
            <div className="vd-row-l">Sổ quỹ</div>
            <div className="vd-row-v">
              {canEditAccount && sharedAccountId ? (
                <select
                  className="vd-accsel"
                  value={sharedAccountId}
                  disabled={updateBatchAccount.isPending}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value && value !== sharedAccountId) {
                      updateBatchAccount.mutate({ batchId: batch.id, accountId: value });
                    }
                  }}
                  style={{
                    height: 34,
                    maxWidth: "100%",
                    borderRadius: 8,
                    border: "1px solid var(--line)",
                    background: "var(--surface-2)",
                    padding: "0 8px",
                    fontFamily: "var(--font)",
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "var(--ink)",
                  }}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.bank_name ? ` (${a.bank_name})` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                batch.account_name || "—"
              )}
            </div>
          </div>
          <Row label={isExpense ? "Người nhận" : "Người nộp"} value={batch.payer_name} />
          <Row
            label="Ngày"
            value={batch.voucher_date ? format(new Date(batch.voucher_date), "dd-MM-yyyy") : "—"}
          />
          <Row
            label="Ngày tạo"
            value={batch.created_at ? format(new Date(batch.created_at), "dd-MM-yyyy HH:mm") : "—"}
          />
          <Row label="Người tạo" value={batch.creator_name} />
          <Row
            label="Hạch toán KQKD"
            value={
              ((batch.vouchers?.[0]?.counts_in_business_result ?? true)
                ? "Có hạch toán"
                : "Không hạch toán") +
              (batch.business_result_accounting == null ? " (tự động)" : " (override)")
            }
          />
          {batch.notes && <Row label="Ghi chú" value={batch.notes} />}
        </div>

        {((batch.attachments && batch.attachments.length > 0) || canEditAttachments) && (
          <>
            <div className="vd-sec">
              <span className="vd-sec-t">Đính kèm (dùng chung)</span>
              {canEditAttachments && (
                <div className="vd-acts">
                  <button
                    className="vd-act"
                    style={{ background: editAtts !== null ? "#64748b" : accent }}
                    aria-label={editAtts !== null ? "Xong" : "Bổ sung ảnh"}
                    title={editAtts !== null ? "Xong" : "Bổ sung ảnh giao dịch"}
                    onClick={() =>
                      setEditAtts(editAtts !== null ? null : batch.attachments ?? [])
                    }
                  >
                    {editAtts !== null ? <X size={15} /> : <ImagePlus size={15} />}
                  </button>
                </div>
              )}
            </div>
            {editAtts !== null ? (
              <AttachmentUpload
                attachments={editAtts}
                onChange={handleAttachmentsChange}
                userId={authUser?.id ?? batch.user_id}
              />
            ) : (
              <div className="vd-atts">
                {(batch.attachments ?? []).map((url, idx) => (
                  <button
                    type="button"
                    key={url}
                    className="vd-att"
                    onClick={() => setLightboxIdx(idx)}
                    title="Xem ảnh / tệp"
                  >
                    {isPdf(url) ? (
                      <FileText size={26} />
                    ) : (
                      <StorageImage value={url} alt="Đính kèm" loading="lazy" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        <div className="vd-sec">
          <span className="vd-sec-t">Các phiếu trong đợt ({batch.voucher_count})</span>
        </div>
        <div className="bchild-list">
          {batch.vouchers.map((v) => {
            const cancelled = v.approval_status === "CANCELLED";
            const unapproved = v.approval_status === "UNAPPROVED";
            const canEditInline = (unapproved || isAdmin) && !!onEditVoucher;
            const itemName = v.items[0]?.type_name ?? "";
            const itemPeriod = formatPeriod(v.items[0]?.start_date, v.items[0]?.end_date);
            const vAccent = v.type === "INCOME" ? "#1f9d57" : "#d6453f";
            return (
              <div className={"bchild" + (cancelled ? " off" : "")} key={v.id}>
                <div className="bchild-main" onClick={() => setChild(v)}>
                  <div className="bchild-l1">
                    <span className={"bchild-code" + (cancelled ? " off" : "")}>{v.code}</span>
                    {cancelled ? (
                      <span className="vd-tag" style={{ color: "#b91c1c", background: "#fee2e2" }}>
                        Đã huỷ
                      </span>
                    ) : unapproved ? (
                      <span className="vd-tag" style={{ color: "#b45309", background: "#fef3c7" }}>
                        Nháp
                      </span>
                    ) : null}
                  </div>
                  <div className="bchild-loc">
                    {v.building_name}
                    {v.room_name ? ` / ${v.room_name}` : ""}
                  </div>
                  {(itemName || itemPeriod) && (
                    <div className="bchild-sub">
                      {itemName}
                      {itemName && itemPeriod ? " · " : ""}
                      {itemPeriod ? `Kỳ: ${itemPeriod}` : ""}
                    </div>
                  )}
                </div>
                <div className="bchild-r">
                  <span className="bchild-amt" style={{ color: vAccent }}>
                    {v.type === "INCOME" ? "+" : "−"}
                    {fmtVND(v.total_amount)}
                  </span>
                  {canEditInline ? (
                    <button
                      className="bchild-edit"
                      aria-label="Sửa phiếu"
                      title={unapproved ? "Sửa phiếu nháp" : "Sửa phiếu (Super Admin)"}
                      onClick={() => {
                        onClose();
                        onEditVoucher?.(v);
                      }}
                    >
                      <Pencil size={14} />
                    </button>
                  ) : (
                    <ChevronRight size={16} style={{ color: "var(--ink-faint)" }} onClick={() => setChild(v)} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Chi tiết phiếu con — sheet chồng lên */}
      {child && (
        <IncomeExpenseDetailMobile
          voucher={child}
          onClose={() => setChild(null)}
          onEdit={
            onEditVoucher
              ? (v) => {
                  setChild(null);
                  onClose();
                  onEditVoucher(v);
                }
              : undefined
          }
          onCancel={
            onCancelVoucher
              ? (id) => {
                  setChild(null);
                  onCancelVoucher(id);
                }
              : undefined
          }
          onApprove={
            onApproveVoucher
              ? (v) => {
                  setChild(null);
                  onApproveVoucher(v);
                }
              : undefined
          }
        />
      )}

      <AttachmentLightbox
        attachments={batch.attachments ?? []}
        index={lightboxIdx}
        onIndexChange={setLightboxIdx}
      />
    </div>
  );
}

export default IncomeExpenseBatchDetailMobile;
