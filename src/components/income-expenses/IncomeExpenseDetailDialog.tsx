import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Ban,
  Printer,
  FileText,
  Pencil,
  CheckCircle2,
  ExternalLink,
  Banknote,
  Undo2,
  RotateCcw,
  History,
  CopyPlus,
} from "lucide-react";
import { PayViaBankAppSheet } from "@/components/income-expenses/PayViaBankAppSheet";
import { supabase } from "@/integrations/supabase/client";
import type { IncomeExpenseWithRelations } from "@/hooks/useIncomeExpenses";
import { kqkdStatusLabel } from "@/lib/kqkd";
import { useIncomeExpenseHistory } from "@/hooks/useIncomeExpenses";
import { useIsAdmin, useIsSuperAdmin } from "@/hooks/useIsAdmin";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { canShowAnnotateAction } from "@/lib/voucherAnnotate";
import { useAuth } from "@/hooks/useAuth";
import { StorageImage } from "@/components/ui/storage-image";
import { AttachmentLightbox } from "@/components/ui/attachment-lightbox";
import { format } from "date-fns";
import { formatPeriod } from "@/lib/monthPeriod";
import { useIsMobile } from "@/hooks/use-mobile";
import { formatVND } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  voucher: IncomeExpenseWithRelations | null;
  onCancel?: (id: string, type?: string | null) => void;
  onEdit?: (voucher: IncomeExpenseWithRelations) => void;
  /** Sửa nhanh 3 field (sổ quỹ + đính kèm + ghi chú) — cho creator của
   *  phiếu đã ghi nhận/đã huỷ, không cần super admin. */
  onQuickEdit?: (voucher: IncomeExpenseWithRelations) => void;
  onApprove?: (voucher: IncomeExpenseWithRelations) => void;
  /** Huỷ duyệt: đưa phiếu đã ghi nhận về Nháp (chỉ super admin). */
  onUnapprove?: (id: string) => void;
  /** Khôi phục phiếu đã huỷ (chỉ super admin). */
  onRestore?: (id: string) => void;
  /** Tạo bản sao từ phiếu đã HUỶ: mở form tạo mới prefill toàn bộ (kể cả ảnh). */
  onCopy?: (voucher: IncomeExpenseWithRelations) => void;
}

// "2026-05" → "05/2026" (nhãn kỳ hoá đơn)
const fmtBillingMonth = (m: string | null | undefined) => {
  const match = /^(\d{4})-(\d{2})$/.exec(m ?? "");
  return match ? `${match[2]}/${match[1]}` : m ?? "";
};
const isPdf = (url: string) =>
  url.toLowerCase().endsWith(".pdf") || url.includes(".pdf");

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="grid grid-cols-[180px_1fr] border-b border-zinc-200 last:border-b-0">
    <div className="px-4 py-2.5 bg-zinc-50 text-sm text-muted-foreground border-r border-zinc-200">
      {label}
    </div>
    <div className="px-4 py-2.5 text-sm">{value || "—"}</div>
  </div>
);

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <h3 className="text-sm font-semibold text-foreground mb-2 mt-4 first:mt-0">
    {children}
  </h3>
);

export function IncomeExpenseDetailDialog({
  open,
  onOpenChange,
  voucher,
  onCancel,
  onEdit,
  onQuickEdit,
  onApprove,
  onUnapprove,
  onRestore,
  onCopy,
}: Props) {
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [paySheetOpen, setPaySheetOpen] = useState(false);
  const isMobile = useIsMobile();
  const { data: isAdmin = false } = useIsAdmin();
  const { data: perms } = useMyPermissions();
  const { data: isSuperAdmin = false } = useIsSuperAdmin();
  const { data: authUser } = useAuth();
  const currentUserId = authUser?.id ?? null;

  // Nhật ký thao tác (huỷ / khôi phục) — chỉ tải khi mở dialog.
  const { data: history = [] } = useIncomeExpenseHistory(
    voucher?.id ?? null,
    open
  );

  // Deep-link sang hoá đơn liên quan (phiếu thu sinh từ thanh toán hoá đơn).
  // Query nhỏ chỉ chạy khi mở dialog và phiếu có invoice_id.
  const invoiceId = voucher?.invoice_id ?? null;
  const { data: relatedInvoice } = useQuery({
    queryKey: ["ie-related-invoice", invoiceId],
    enabled: open && !!invoiceId,
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

  const attachments = voucher?.attachments ?? [];
  const isLightboxOpen = lightboxIdx !== null;

  useEffect(() => {
    if (!open) setLightboxIdx(null);
  }, [open]);

  if (!voucher) return null;

  const isCancelled = voucher.approval_status === "CANCELLED";
  const isUnapproved = voucher.approval_status === "UNAPPROVED";
  const isExpense = voucher.type === "EXPENSE";
  const isCreator =
    !!currentUserId && voucher.user_id === currentUserId;
  const showFullEdit = !!onEdit && (isUnapproved || isAdmin);
  const showQuickEdit = canShowAnnotateAction({
    hasHandler: !!onQuickEdit,
    isUnapproved,
    isAdmin,
    isCreator,
    canEdit: canUse(perms, "income_expenses", "edit"),
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={
            isMobile
              ? "max-w-full w-full h-[95vh] !top-auto !bottom-0 !left-0 !translate-x-0 !translate-y-0 rounded-t-2xl rounded-b-none p-4 overflow-y-auto data-[state=open]:!slide-in-from-bottom data-[state=closed]:!slide-out-to-bottom"
              : "sm:max-w-[680px] max-h-[90vh] overflow-y-auto"
          }
          onPointerDownOutside={(e) => {
            if (isLightboxOpen) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (isLightboxOpen) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (isLightboxOpen) e.preventDefault();
          }}
        >
          {isMobile && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 w-10 h-1 bg-zinc-300 rounded-full" />
          )}
          <DialogHeader
            className={`flex flex-row items-center justify-between border-b pb-3 ${
              isMobile ? "pt-3" : ""
            }`}
          >
            <DialogTitle className="text-primary uppercase tracking-wide">
              Thông tin thu/chi
            </DialogTitle>
          </DialogHeader>

          {/* Section header với action buttons bên phải */}
          <div className="flex items-center justify-between mt-1">
            <SectionTitle>Thông tin chung</SectionTitle>
            <div className="flex items-center gap-1.5">
              {showFullEdit && (
                <Button
                  size="icon"
                  variant="default"
                  className="h-8 w-8 bg-amber-500 hover:bg-amber-600"
                  title={isUnapproved ? 'Sửa phiếu chờ duyệt' : 'Sửa phiếu (Super Admin)'}
                  onClick={() => {
                    onEdit!(voucher);
                    onOpenChange(false);
                  }}
                >
                  <Pencil className="h-4 w-4 text-white" />
                </Button>
              )}
              {showQuickEdit && (
                <Button
                  size="icon"
                  variant="default"
                  className="h-8 w-8 bg-amber-500 hover:bg-amber-600"
                  // ĐỢT C: sổ quỹ chỉ sửa được ở phiếu THU.
                  title={
                    voucher.type === "INCOME"
                      ? "Sửa sổ quỹ / hình ảnh / ghi chú"
                      : "Sửa hình ảnh / ghi chú"
                  }
                  onClick={() => {
                    onQuickEdit!(voucher);
                    onOpenChange(false);
                  }}
                >
                  <Pencil className="h-4 w-4 text-white" />
                </Button>
              )}
              {isUnapproved && onApprove && (
                <Button
                  size="icon"
                  variant="default"
                  className="h-8 w-8 bg-green-600 hover:bg-green-700"
                  title="Duyệt phiếu (đã thanh toán)"
                  onClick={() => {
                    onApprove(voucher);
                    onOpenChange(false);
                  }}
                >
                  <CheckCircle2 className="h-4 w-4 text-white" />
                </Button>
              )}
              {isAdmin && !isUnapproved && !isCancelled && onUnapprove && (
                <Button
                  size="icon"
                  variant="default"
                  className="h-8 w-8 bg-amber-500 hover:bg-amber-600"
                  title="Huỷ duyệt (chuyển về Chờ duyệt) — Super Admin"
                  onClick={() => {
                    onUnapprove(voucher.id);
                    onOpenChange(false);
                  }}
                >
                  <Undo2 className="h-4 w-4 text-white" />
                </Button>
              )}
              {!isCancelled && onCancel && (
                <Button
                  size="icon"
                  variant="default"
                  className="h-8 w-8 bg-orange-500 hover:bg-orange-600"
                  title="Huỷ phiếu"
                  onClick={() => {
                    onCancel(voucher.id, voucher.type);
                    onOpenChange(false);
                  }}
                >
                  <Ban className="h-4 w-4 text-white" />
                </Button>
              )}
              {isCancelled && isSuperAdmin && onRestore && (
                <Button
                  size="icon"
                  variant="default"
                  className="h-8 w-8 bg-green-600 hover:bg-green-700"
                  title="Khôi phục phiếu (Super Admin)"
                  onClick={() => {
                    onRestore(voucher.id);
                    onOpenChange(false);
                  }}
                >
                  <RotateCcw className="h-4 w-4 text-white" />
                </Button>
              )}
              {/* Tạo bản sao: phiếu đã huỷ → form tạo mới prefill toàn bộ */}
              {isCancelled && onCopy && (
                <Button
                  size="icon"
                  variant="default"
                  className="h-8 w-8 bg-blue-600 hover:bg-blue-700"
                  title="Tạo bản sao (phiếu mới với thông tin phiếu này)"
                  onClick={() => {
                    onCopy(voucher);
                    onOpenChange(false);
                  }}
                >
                  <CopyPlus className="h-4 w-4 text-white" />
                </Button>
              )}
              <Button
                size="icon"
                variant="default"
                className="h-8 w-8 bg-blue-500 hover:bg-blue-600"
                title="In phiếu"
                onClick={() =>
                  window.open(
                    `/income-expense/print/${voucher.id}`,
                    "_blank",
                    "noopener,width=900,height=1000"
                  )
                }
              >
                <Printer className="h-4 w-4 text-white" />
              </Button>
            </div>
          </div>

          {/* Bảng key-value */}
          <div className="rounded-md border border-zinc-200 overflow-hidden">
            <Row
              label="Mã phiếu"
              value={
                <div className="flex items-center gap-2">
                  <span className="font-medium">{voucher.code}</span>
                  {isCancelled && (
                    <span className="px-2 py-0.5 text-xs rounded bg-red-100 text-red-700">
                      Đã huỷ
                    </span>
                  )}
                  {isUnapproved && (
                    <span className="px-2 py-0.5 text-xs rounded bg-amber-100 text-amber-700">
                      Chờ duyệt
                    </span>
                  )}
                </div>
              }
            />
            <Row label="Tên" value={voucher.name} />
            <Row
              label="Số tiền"
              value={
                <span
                  className={
                    voucher.type === "INCOME"
                      ? "text-green-600 font-medium"
                      : "text-red-600 font-medium"
                  }
                >
                  {voucher.type === "INCOME" ? "+" : "-"}
                  {formatVND(voucher.total_amount)}
                </span>
              }
            />
            <Row label="Sổ quỹ" value={voucher.account_name} />
            <Row
              label="Tòa nhà"
              value={
                voucher.building_name
                  ? `${voucher.building_name}${
                      voucher.room_name ? " / " + voucher.room_name : ""
                    }`
                  : "—"
              }
            />
            {voucher.invoice_id && (
              <Row
                label="Hoá đơn liên quan"
                value={
                  <Link
                    to={`/invoices/${voucher.invoice_id}`}
                    onClick={() => onOpenChange(false)}
                    className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 hover:underline font-medium"
                    title="Mở trang chi tiết hoá đơn"
                  >
                    {relatedInvoice
                      ? relatedInvoice.invoice_number ||
                        (relatedInvoice.billing_month
                          ? `Hoá đơn kỳ ${fmtBillingMonth(relatedInvoice.billing_month)}`
                          : "Xem hoá đơn")
                      : "Xem hoá đơn"}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                }
              />
            )}
            <Row
              label={isExpense ? "Người nhận" : "Người nộp"}
              value={voucher.payer_name}
            />
            {isExpense && voucher.receive_bank_account && (
              <Row label="Số TK nhận" value={voucher.receive_bank_account} />
            )}
            {isExpense && voucher.receive_bank_name && (
              <Row label="Ngân hàng nhận" value={voucher.receive_bank_name} />
            )}
            <Row
              label="Thời gian"
              value={
                voucher.voucher_date
                  ? format(new Date(voucher.voucher_date), "dd-MM-yyyy")
                  : "—"
              }
            />
            <Row
              label="Ngày tạo"
              value={
                voucher.created_at
                  ? format(new Date(voucher.created_at), "dd-MM-yyyy HH:mm")
                  : "—"
              }
            />
            <Row label="Người tạo" value={voucher.creator_name} />
            {voucher.repeat_cycle && voucher.repeat_cycle !== "NONE" && (
              <Row
                label="Lặp lại"
                value={
                  <span>
                    {{
                      WEEK: "Hàng tuần",
                      MONTH: "Hàng tháng",
                      QUARTER: "Hàng quý",
                      YEAR: "Hàng năm",
                    }[voucher.repeat_cycle as string] || voucher.repeat_cycle}
                    {voucher.repeat_infinity
                      ? " · vô hạn"
                      : voucher.repeat_count
                      ? ` · ${voucher.repeat_count} lần`
                      : ""}
                    {voucher.repeat_next_date
                      ? ` · kế tiếp ${format(
                          new Date(voucher.repeat_next_date),
                          "dd-MM-yyyy"
                        )}`
                      : ""}
                  </span>
                }
              />
            )}
            {voucher.repeat_parent_id && (
              <Row
                label="Phiếu gốc"
                value={
                  <span className="text-xs text-muted-foreground">
                    Tự động lập từ phiếu cha
                  </span>
                }
              />
            )}
            <Row
              label="Hạch toán kết quả kinh doanh"
              value={kqkdStatusLabel(voucher)}
            />
            {voucher.notes && <Row label="Ghi chú" value={voucher.notes} />}
          </div>

          {/* Chi tiền qua app ngân hàng — mobile, phiếu chi có STK người nhận */}
          {isMobile && isExpense && !isCancelled && voucher.receive_bank_account && (
            <Button
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={() => setPaySheetOpen(true)}
            >
              <Banknote className="h-4 w-4 mr-2" />
              Chi tiền qua app ngân hàng
            </Button>
          )}

          {/* Hạng mục */}
          {voucher.items && voucher.items.length > 0 && (
            <>
              <SectionTitle>Hạng mục</SectionTitle>
              <div className="rounded-md border border-zinc-200 overflow-hidden">
                {voucher.items.map((item, idx) => (
                  <div
                    key={item.id}
                    className={`grid grid-cols-[1fr_180px] ${
                      idx > 0 ? "border-t border-zinc-200" : ""
                    }`}
                  >
                    <div className="px-4 py-2.5 text-sm border-r border-zinc-200">
                      {item.type_name}
                      {item.description ? (
                        <span className="text-muted-foreground ml-1">
                          — {item.description}
                        </span>
                      ) : null}
                      {formatPeriod(item.start_date, item.end_date) ? (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          Kỳ: {formatPeriod(item.start_date, item.end_date)}
                        </div>
                      ) : null}
                    </div>
                    <div className="px-4 py-2.5 text-sm text-right">
                      {formatVND(Number(item.amount))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Đính kèm */}
          {voucher.attachments && voucher.attachments.length > 0 && (
            <>
              <SectionTitle>Đính kèm</SectionTitle>
              <div className="flex flex-wrap gap-3">
                {voucher.attachments.map((url, idx) => (
                  <button
                    type="button"
                    key={url}
                    onClick={() => setLightboxIdx(idx)}
                    className="group relative w-24 h-24 rounded-md border border-zinc-200 overflow-hidden bg-zinc-50 hover:border-primary hover:shadow-md transition-all cursor-zoom-in"
                    title="Click để xem lớn"
                  >
                    {isPdf(url) ? (
                      <div className="flex items-center justify-center w-full h-full">
                        <FileText className="h-10 w-10 text-muted-foreground" />
                      </div>
                    ) : (
                      <StorageImage
                        value={url}
                        alt="Đính kèm"
                        className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-110"
                      />
                    )}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Nhật ký thao tác (huỷ / khôi phục) */}
          {history.length > 0 && (
            <>
              <SectionTitle>
                <span className="inline-flex items-center gap-1.5">
                  <History className="h-4 w-4" />
                  Lịch sử thao tác
                </span>
              </SectionTitle>
              <div className="rounded-md border border-zinc-200 overflow-hidden divide-y divide-zinc-200">
                {history.map((h) => {
                  const isRestore = h.action === "RESTORED";
                  return (
                    <div key={h.id} className="flex items-start gap-2 px-4 py-2.5">
                      <span
                        className={`shrink-0 mt-0.5 px-2 py-0.5 text-xs rounded ${
                          isRestore
                            ? "bg-green-100 text-green-700"
                            : "bg-red-100 text-red-700"
                        }`}
                      >
                        {isRestore ? "Khôi phục" : "Huỷ phiếu"}
                      </span>
                      <div className="text-sm min-w-0">
                        <div className="text-foreground">
                          {h.actor_name || "—"}
                          <span className="text-muted-foreground">
                            {" · "}
                            {h.created_at
                              ? format(
                                  new Date(h.created_at),
                                  "dd-MM-yyyy HH:mm"
                                )
                              : ""}
                          </span>
                        </div>
                        {h.note && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {h.note}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Sheet chọn app ngân hàng để chi tiền */}
      <PayViaBankAppSheet
        open={paySheetOpen}
        onOpenChange={setPaySheetOpen}
        voucher={voucher}
      />

      {/* Lightbox xem ảnh/PDF — overlay tại chỗ, không mở tab mới */}
      <AttachmentLightbox
        attachments={attachments}
        index={lightboxIdx}
        onIndexChange={setLightboxIdx}
      />
    </>
  );
}

export default IncomeExpenseDetailDialog;
