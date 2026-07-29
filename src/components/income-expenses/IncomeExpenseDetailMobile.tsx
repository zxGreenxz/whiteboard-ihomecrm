import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  X,
  Pencil,
  CheckCircle2,
  Ban,
  Printer,
  ChevronRight,
  Banknote,
  FileText,
  RotateCcw,
  History,
  CopyPlus,
} from "lucide-react";
import { useState } from "react";
import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { StorageImage } from "@/components/ui/storage-image";
import { AttachmentLightbox } from "@/components/ui/attachment-lightbox";
import { formatPeriod } from "@/lib/monthPeriod";
import { kqkdStatusLabel } from "@/lib/kqkd";
import { useIsAdmin, useIsSuperAdmin } from "@/hooks/useIsAdmin";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { canShowAnnotateAction } from "@/lib/voucherAnnotate";
import { useAuth } from "@/hooks/useAuth";
import PayViaBankAppSheet from "@/components/income-expenses/PayViaBankAppSheet";
// Finance V2 (§12.2 mobile parity): nút Thu/Chi phiếu đã duyệt + Hoàn tác phiếu
// đã ghi sổ — chỉ hiện khi org đọc CANONICAL (đối xứng IncomeExpenseList desktop).
import { useFinanceV2Routes, isCanonicalRead } from "@/lib/financeV2Route";
import {
  useIncomeExpenseHistory,
  type IncomeExpenseWithRelations,
} from "@/hooks/useIncomeExpenses";

interface Props {
  voucher: IncomeExpenseWithRelations;
  onClose: () => void;
  onEdit?: (v: IncomeExpenseWithRelations) => void;
  onQuickEdit?: (v: IncomeExpenseWithRelations) => void;
  onApprove?: (voucher: IncomeExpenseWithRelations) => void;
  onCancel?: (id: string) => void;
  /** Khôi phục phiếu đã huỷ (chỉ super admin). */
  onRestore?: (id: string) => void;
  /** Tạo bản sao từ phiếu đã HUỶ: mở form tạo mới prefill toàn bộ (kể cả ảnh). */
  onCopy?: (v: IncomeExpenseWithRelations) => void;
  /** V2 §12.3: Thu/Chi phiếu ĐÃ DUYỆT - CHƯA GHI SỔ (gồm cả Thu/Chi LẠI sau hoàn tác). */
  onPostApproved?: (v: IncomeExpenseWithRelations) => void;
  /** Mô hình 2 nút: HOÀN TÁC phiếu ĐÃ GHI SỔ (tiền về sổ, phiếu chờ chi lại/huỷ). */
  onReversePosting?: (v: IncomeExpenseWithRelations) => void;
}

const fmtVND = (n: number) => `${n.toLocaleString("vi-VN")} đ`;
const fmtBillingMonth = (m: string | null | undefined) => {
  const match = /^(\d{4})-(\d{2})$/.exec(m ?? "");
  return match ? `${match[2]}/${match[1]}` : m ?? "";
};
const isPdf = (url: string) => /\.pdf(\?|$)/i.test(url);

const REPEAT_LABEL: Record<string, string> = {
  WEEK: "Hàng tuần",
  MONTH: "Hàng tháng",
  QUARTER: "Hàng quý",
  YEAR: "Hàng năm",
};

/**
 * Chi tiết phiếu thu/chi — bottom-sheet warm-neutral, dựng theo handoff Claude
 * Design (ui_kits/mobile-app: VoucherDetailSheet). Nối dữ liệu THẬT
 * (IncomeExpenseWithRelations) + cùng logic quyền như IncomeExpenseDetailDialog
 * (sửa đầy đủ / sửa nhanh / duyệt / huỷ / in). Hiển thị trong khung .cm-app.
 */
export function IncomeExpenseDetailMobile({
  voucher: v,
  onClose,
  onEdit,
  onQuickEdit,
  onApprove,
  onCancel,
  onRestore,
  onCopy,
  onPostApproved,
  onReversePosting,
}: Props) {
  const navigate = useNavigate();
  const [paySheetOpen, setPaySheetOpen] = useState(false);
  // Xem ảnh đính kèm ngay trên trang (overlay), KHÔNG mở tab mới.
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const { data: isAdmin = false } = useIsAdmin();
  const { data: perms } = useMyPermissions();
  const { data: isSuperAdmin = false } = useIsSuperAdmin();
  const { data: authUser } = useAuth();
  const currentUserId = authUser?.id ?? null;
  const { data: history = [] } = useIncomeExpenseHistory(v.id);

  const invoiceId = v.invoice_id ?? null;
  const { data: relatedInvoice } = useQuery({
    queryKey: ["ie-related-invoice", invoiceId],
    enabled: !!invoiceId,
    queryFn: async (): Promise<{
      id: string;
      invoice_number: string | null;
      billing_month: string | null;
    } | null> => {
      const { data, error } = await (supabase as any)
        .from("invoices")
        .select("id, invoice_number, billing_month")
        .eq("id", invoiceId)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
  });

  const isCancelled = v.approval_status === "CANCELLED";
  const isUnapproved = v.approval_status === "UNAPPROVED";
  // V2 route-aware: posting_status/organization_id chưa vào generated types → cast.
  const v2Routes = useFinanceV2Routes();
  const vv = v as { organization_id?: string | null; posting_status?: string | null };
  const canonicalV2 = isCanonicalRead(v2Routes.getOrg(vv.organization_id ?? null));
  const postingStatus = vv.posting_status ?? null;
  const isExpense = v.type === "EXPENSE";
  const accent = v.type === "INCOME" ? "#1f9d57" : "#d6453f";
  const isCreator = !!currentUserId && v.user_id === currentUserId;
  const showFullEdit = !!onEdit && (isUnapproved || isAdmin);
  const showQuickEdit = canShowAnnotateAction({
    hasHandler: !!onQuickEdit,
    isUnapproved,
    isAdmin,
    isCreator,
    canEdit: canUse(perms, "income_expenses", "edit"),
  });

  const Row = ({
    label,
    value,
    mono,
  }: {
    label: string;
    value: React.ReactNode;
    mono?: boolean;
  }) => (
    <div className="vd-row">
      <div className="vd-row-l">{label}</div>
      <div
        className="vd-row-v"
        style={mono ? { fontFamily: "var(--mono)", fontSize: 13 } : undefined}
      >
        {value || "—"}
      </div>
    </div>
  );

  return (
    // stopPropagation: khi sheet này lồng trong sheet khác (vd phiếu con trong
    // chi tiết phiếu tổng), chạm nền KHÔNG được nổi bọt lên overlay cha → tránh
    // đóng luôn cả 2 lớp.
    <div className="sheet-ov" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grab" />
        <div className="vd-hd">
          <span className="vd-hd-t">THÔNG TIN THU/CHI</span>
          <button className="sheet-x" onClick={onClose} aria-label="Đóng">
            <X size={18} />
          </button>
        </div>

        <div className="vd-sec">
          <span className="vd-sec-t">Thông tin chung</span>
          <div className="vd-acts">
            {showFullEdit && (
              <button
                className="vd-act"
                style={{ background: "#f59e0b" }}
                aria-label="Sửa"
                onClick={() => {
                  onEdit!(v);
                  onClose();
                }}
              >
                <Pencil size={15} />
              </button>
            )}
            {showQuickEdit && (
              <button
                className="vd-act"
                style={{ background: "#f59e0b" }}
                aria-label="Sửa nhanh"
                onClick={() => {
                  onQuickEdit!(v);
                  onClose();
                }}
              >
                <Pencil size={15} />
              </button>
            )}
            {isUnapproved && onApprove && (
              <button
                className="vd-act"
                style={{ background: "#16a34a" }}
                aria-label="Duyệt"
                onClick={() => {
                  onApprove(v);
                  onClose();
                }}
              >
                <CheckCircle2 size={15} />
              </button>
            )}
            {/* V2 §12.3: Thu/Chi phiếu ĐÃ DUYỆT - CHƯA GHI SỔ (CUSTODIAN, không
                cần quyền duyệt); phiếu ĐÃ HOÀN TÁC cũng Thu/Chi LẠI được. */}
            {onPostApproved &&
              !isCancelled &&
              v.approval_status === "APPROVED" &&
              postingStatus !== "POSTED" &&
              postingStatus !== "NOT_APPLICABLE" &&
              canonicalV2 && (
                <button
                  className="vd-act"
                  style={{ background: "#2563eb" }}
                  aria-label={v.type === "INCOME" ? "Thu tiền vào sổ" : "Chi tiền từ sổ"}
                  onClick={() => {
                    onPostApproved(v);
                    onClose();
                  }}
                >
                  <Banknote size={15} />
                </button>
              )}
            {/* Mô hình 2 nút: HOÀN TÁC phiếu ĐÃ GHI SỔ. */}
            {onReversePosting &&
              !isCancelled &&
              postingStatus === "POSTED" &&
              canonicalV2 && (
                <button
                  className="vd-act"
                  style={{ background: "#7c3aed" }}
                  aria-label="Hoàn tác"
                  onClick={() => {
                    onReversePosting(v);
                    onClose();
                  }}
                >
                  <RotateCcw size={15} />
                </button>
              )}
            {!isCancelled && onCancel && (
              <button
                className="vd-act"
                style={{ background: "#f97316" }}
                aria-label="Huỷ"
                onClick={() => {
                  onCancel(v.id);
                  onClose();
                }}
              >
                <Ban size={15} />
              </button>
            )}
            {isCancelled && isSuperAdmin && onRestore && (
              <button
                className="vd-act"
                style={{ background: "#16a34a" }}
                aria-label="Khôi phục"
                onClick={() => {
                  onRestore(v.id);
                  onClose();
                }}
              >
                <RotateCcw size={15} />
              </button>
            )}
            {/* Tạo bản sao: phiếu đã huỷ → form tạo mới prefill toàn bộ */}
            {isCancelled && onCopy && (
              <button
                className="vd-act"
                style={{ background: "#2563eb" }}
                aria-label="Tạo bản sao"
                onClick={() => {
                  onCopy(v);
                  onClose();
                }}
              >
                <CopyPlus size={15} />
              </button>
            )}
            <button
              className="vd-act"
              style={{ background: "#3b82f6" }}
              aria-label="In"
              onClick={() =>
                window.open(
                  `/income-expense/print/${v.id}`,
                  "_blank",
                  "noopener,width=900,height=1000",
                )
              }
            >
              <Printer size={15} />
            </button>
          </div>
        </div>

        <div className="vd-table">
          <div className="vd-row">
            <div className="vd-row-l">Mã phiếu</div>
            <div className="vd-row-v">
              <b>{v.code}</b>
              {isCancelled && (
                <span
                  className="vd-tag"
                  style={{ color: "#b91c1c", background: "#fee2e2" }}
                >
                  Đã huỷ
                </span>
              )}
              {isUnapproved && (
                <span
                  className="vd-tag"
                  style={{ color: "#b45309", background: "#fef3c7" }}
                >
                  Chờ duyệt
                </span>
              )}
            </div>
          </div>
          <Row label="Tên" value={v.name} />
          <div className="vd-row">
            <div className="vd-row-l">Số tiền</div>
            <div className="vd-row-v" style={{ color: accent, fontWeight: 700 }}>
              {v.type === "INCOME" ? "+" : "−"}
              {fmtVND(v.total_amount)}
            </div>
          </div>
          <Row label="Sổ quỹ" value={v.account_name} />
          <Row
            label="Tòa nhà"
            value={
              v.building_name
                ? `${v.building_name}${v.room_name ? " / " + v.room_name : ""}`
                : "—"
            }
          />
          {v.invoice_id && (
            <div className="vd-row">
              <div className="vd-row-l">Hoá đơn liên quan</div>
              <div className="vd-row-v">
                <button
                  className="vd-link"
                  onClick={() => {
                    onClose();
                    navigate(`/invoices/${v.invoice_id}`);
                  }}
                >
                  {relatedInvoice
                    ? relatedInvoice.invoice_number ||
                      (relatedInvoice.billing_month
                        ? `Hoá đơn kỳ ${fmtBillingMonth(relatedInvoice.billing_month)}`
                        : "Xem hoá đơn")
                    : "Xem hoá đơn"}
                  <ChevronRight size={13} />
                </button>
              </div>
            </div>
          )}
          <Row
            label={isExpense ? "Người nhận" : "Người nộp"}
            value={v.payer_name}
          />
          {isExpense && v.receive_bank_account && (
            <Row label="Số TK nhận" value={v.receive_bank_account} mono />
          )}
          {isExpense && v.receive_bank_name && (
            <Row label="Ngân hàng nhận" value={v.receive_bank_name} />
          )}
          <Row
            label="Thời gian"
            value={
              v.voucher_date ? format(new Date(v.voucher_date), "dd-MM-yyyy") : "—"
            }
            mono
          />
          <Row
            label="Ngày tạo"
            value={
              v.created_at
                ? format(new Date(v.created_at), "dd-MM-yyyy HH:mm")
                : "—"
            }
            mono
          />
          <Row label="Người tạo" value={v.creator_name} />
          {v.repeat_cycle && v.repeat_cycle !== "NONE" && (
            <Row
              label="Lặp lại"
              value={
                <span>
                  {REPEAT_LABEL[v.repeat_cycle] || v.repeat_cycle}
                  {v.repeat_infinity
                    ? " · vô hạn"
                    : v.repeat_count
                      ? ` · ${v.repeat_count} lần`
                      : ""}
                  {v.repeat_next_date
                    ? ` · kế tiếp ${format(new Date(v.repeat_next_date), "dd-MM-yyyy")}`
                    : ""}
                </span>
              }
            />
          )}
          <Row label="Hạch toán KQKD" value={kqkdStatusLabel(v)} />
          {v.notes && <Row label="Ghi chú" value={v.notes} />}
        </div>

        {isExpense && !isCancelled && v.receive_bank_account && (
          <button className="vd-pay" onClick={() => setPaySheetOpen(true)}>
            <Banknote size={16} />
            Chi tiền qua app ngân hàng
          </button>
        )}

        {v.items && v.items.length > 0 && (
          <>
            <div className="vd-sec">
              <span className="vd-sec-t">Hạng mục</span>
            </div>
            <div className="vd-table">
              {v.items.map((it) => (
                <div className="vd-irow" key={it.id}>
                  <div className="vd-irow-l">
                    {it.type_name}
                    {it.description ? (
                      <span className="vd-irow-desc"> — {it.description}</span>
                    ) : null}
                    {formatPeriod(it.start_date, it.end_date) ? (
                      <div className="cd-pay-sub" style={{ marginTop: 3 }}>
                        Kỳ: {formatPeriod(it.start_date, it.end_date)}
                      </div>
                    ) : null}
                  </div>
                  <div className="vd-irow-amt">{fmtVND(Number(it.amount))}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {v.attachments && v.attachments.length > 0 && (
          <>
            <div className="vd-sec">
              <span className="vd-sec-t">Đính kèm</span>
            </div>
            <div className="vd-atts">
              {v.attachments.map((url, idx) => (
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
          </>
        )}

        {history.length > 0 && (
          <>
            <div className="vd-sec">
              <span className="vd-sec-t">
                <History size={14} style={{ marginRight: 5, verticalAlign: -2 }} />
                Lịch sử thao tác
              </span>
            </div>
            <div className="vd-table">
              {history.map((h) => {
                const isRestore = h.action === "RESTORED";
                return (
                  <div className="vd-irow" key={h.id}>
                    <div className="vd-irow-l">
                      <span
                        className="vd-tag"
                        style={
                          isRestore
                            ? { color: "#15803d", background: "#dcfce7" }
                            : { color: "#b91c1c", background: "#fee2e2" }
                        }
                      >
                        {isRestore ? "Khôi phục" : "Huỷ phiếu"}
                      </span>
                      <span style={{ marginLeft: 8 }}>{h.actor_name || "—"}</span>
                      {h.note ? (
                        <div className="vd-irow-desc" style={{ marginTop: 3 }}>
                          {h.note}
                        </div>
                      ) : null}
                    </div>
                    <div
                      className="vd-irow-amt"
                      style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 400 }}
                    >
                      {h.created_at
                        ? format(new Date(h.created_at), "dd-MM-yyyy HH:mm")
                        : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <PayViaBankAppSheet
        open={paySheetOpen}
        onOpenChange={setPaySheetOpen}
        voucher={v}
      />

      <AttachmentLightbox
        attachments={v.attachments ?? []}
        index={lightboxIdx}
        onIndexChange={setLightboxIdx}
      />
    </div>
  );
}

export default IncomeExpenseDetailMobile;
