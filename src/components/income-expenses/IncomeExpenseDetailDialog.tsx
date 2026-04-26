import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Ban, Printer, FileText, X } from "lucide-react";
import type { IncomeExpenseWithRelations } from "@/hooks/useIncomeExpenses";
import { format } from "date-fns";
import { useIsMobile } from "@/hooks/use-mobile";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  voucher: IncomeExpenseWithRelations | null;
  onCancel?: (id: string) => void;
}

const formatVND = (n: number) => `${n.toLocaleString("vi-VN")} đ`;
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
}: Props) {
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const isMobile = useIsMobile();

  if (!voucher) return null;

  const isCancelled = voucher.approval_status === "CANCELLED";
  const isExpense = voucher.type === "EXPENSE";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={
            isMobile
              ? "max-w-full w-full h-[95vh] !top-auto !bottom-0 !left-0 !translate-x-0 !translate-y-0 rounded-t-2xl rounded-b-none p-4 overflow-y-auto data-[state=open]:!slide-in-from-bottom data-[state=closed]:!slide-out-to-bottom"
              : "sm:max-w-[680px] max-h-[90vh] overflow-y-auto"
          }
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

          {/* Section header với 2 action button bên phải */}
          <div className="flex items-center justify-between mt-1">
            <SectionTitle>Thông tin chung</SectionTitle>
            <div className="flex items-center gap-1.5">
              {!isCancelled && onCancel && (
                <Button
                  size="icon"
                  variant="default"
                  className="h-8 w-8 bg-orange-500 hover:bg-orange-600"
                  title="Huỷ phiếu"
                  onClick={() => {
                    onCancel(voucher.id);
                    onOpenChange(false);
                  }}
                >
                  <Ban className="h-4 w-4 text-white" />
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
            <Row label="Tài khoản" value={voucher.account_name} />
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
            <Row
              label="Hạch toán kết quả kinh doanh"
              value={
                voucher.business_result_accounting
                  ? "Có hạch toán"
                  : "Không hạch toán"
              }
            />
            {voucher.notes && <Row label="Ghi chú" value={voucher.notes} />}
          </div>

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
                {voucher.attachments.map((url) => (
                  <button
                    type="button"
                    key={url}
                    onClick={() => setLightboxUrl(url)}
                    className="group relative w-24 h-24 rounded-md border border-zinc-200 overflow-hidden bg-zinc-50 hover:border-primary hover:shadow-md transition-all cursor-zoom-in"
                    title="Click để xem lớn"
                  >
                    {isPdf(url) ? (
                      <div className="flex items-center justify-center w-full h-full">
                        <FileText className="h-10 w-10 text-muted-foreground" />
                      </div>
                    ) : (
                      <img
                        src={url}
                        alt="Đính kèm"
                        className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-110"
                      />
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[60] bg-black/85 flex items-center justify-center p-6"
          onClick={() => setLightboxUrl(null)}
        >
          <button
            type="button"
            className="absolute top-4 right-4 text-white bg-white/10 hover:bg-white/20 rounded-full p-2"
            onClick={(e) => {
              e.stopPropagation();
              setLightboxUrl(null);
            }}
          >
            <X className="h-5 w-5" />
          </button>
          {isPdf(lightboxUrl) ? (
            <iframe
              src={lightboxUrl}
              className="w-full h-full max-w-5xl max-h-[90vh] bg-white rounded-md"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <img
              src={lightboxUrl}
              alt="Đính kèm phóng lớn"
              className="max-w-[95vw] max-h-[90vh] object-contain rounded-md shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      )}
    </>
  );
}

export default IncomeExpenseDetailDialog;
