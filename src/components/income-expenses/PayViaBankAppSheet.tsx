import { useEffect, useMemo, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { IncomeExpenseWithRelations } from "@/hooks/useIncomeExpenses";
import {
  VIETQR_BANK_APPS,
  RECIPIENT_BANKS,
  matchRecipientBankCode,
  buildVietQRDeeplink,
  extractRecipientFromNotes,
} from "@/lib/vietqrDeeplink";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  voucher: IncomeExpenseWithRelations;
}

const formatVND = (n: number) => `${n.toLocaleString("vi-VN")} đ`;

/**
 * Bottom sheet "Chi tiền qua app ngân hàng" (mobile):
 * tóm tắt người nhận + grid app ngân hàng. Bấm app → mở VietQR deeplink
 * (dl.vietqr.io) → app bank mở màn hình chuyển tiền điền sẵn STK/số tiền/nội dung.
 */
export function PayViaBankAppSheet({ open, onOpenChange, voucher }: Props) {
  const detectedBankCode = useMemo(
    () => matchRecipientBankCode(voucher.receive_bank_name),
    [voucher.receive_bank_name]
  );
  const [bankCode, setBankCode] = useState<string | null>(detectedBankCode);

  // Reset về bank auto-detect mỗi lần mở lại / đổi phiếu
  useEffect(() => {
    if (open) setBankCode(detectedBankCode);
  }, [open, detectedBankCode]);

  const recipientName =
    extractRecipientFromNotes(voucher.notes) || voucher.payer_name || null;
  const accountNumber = voucher.receive_bank_account ?? "";

  const bankOptions = useMemo(
    () =>
      RECIPIENT_BANKS.map((b) => ({
        value: b.code,
        label: b.shortName,
        keywords: b.aliases,
      })),
    []
  );

  const selectedBank = RECIPIENT_BANKS.find((b) => b.code === bankCode);

  const openBankApp = (appId: string) => {
    if (!bankCode) return;
    const url = buildVietQRDeeplink({
      appId,
      bankCode,
      accountNumber,
      amount: voucher.total_amount,
      note: `${voucher.code} ${voucher.name}`,
      recipientName,
    });
    // Điều hướng cùng tab: dl.vietqr.io redirect sang URL scheme của app bank.
    window.location.href = url;
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl max-h-[88vh] overflow-y-auto pb-8"
      >
        <div className="absolute top-2 left-1/2 -translate-x-1/2 w-10 h-1 bg-zinc-300 rounded-full" />
        <SheetHeader className="pt-2">
          <SheetTitle className="text-primary uppercase tracking-wide text-left">
            Chi tiền qua app ngân hàng
          </SheetTitle>
        </SheetHeader>

        {/* Tóm tắt thông tin chuyển khoản */}
        <div className="mt-3 rounded-md border border-zinc-200 divide-y divide-zinc-200 text-sm">
          <div className="flex justify-between px-3 py-2">
            <span className="text-muted-foreground">Người nhận</span>
            <span className="font-medium text-right">
              {recipientName || "—"}
            </span>
          </div>
          <div className="flex justify-between px-3 py-2">
            <span className="text-muted-foreground">Số TK</span>
            <span className="font-medium">{accountNumber || "—"}</span>
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="text-muted-foreground shrink-0">Ngân hàng</span>
            {selectedBank ? (
              <span className="font-medium text-right">
                {selectedBank.shortName}
                {voucher.receive_bank_name &&
                  detectedBankCode === bankCode && (
                    <span className="block text-xs text-muted-foreground font-normal">
                      từ "{voucher.receive_bank_name}"
                    </span>
                  )}
              </span>
            ) : (
              <SearchableSelect
                value={bankCode ?? undefined}
                onValueChange={(v) => setBankCode(v)}
                options={bankOptions}
                placeholder="Chọn ngân hàng nhận"
                searchPlaceholder="Gõ tên ngân hàng..."
                emptyText="Không tìm thấy ngân hàng"
                className="h-9 w-[210px]"
                aria-label="Ngân hàng nhận"
              />
            )}
          </div>
          <div className="flex justify-between px-3 py-2">
            <span className="text-muted-foreground">Số tiền</span>
            <span className="font-semibold text-red-600">
              {formatVND(voucher.total_amount)}
            </span>
          </div>
        </div>

        {!bankCode && (
          <p className="mt-2 text-xs text-amber-600">
            Không nhận diện được ngân hàng từ "
            {voucher.receive_bank_name || "—"}" — vui lòng chọn ngân hàng nhận
            ở trên trước.
          </p>
        )}

        <p className="mt-4 mb-2 text-sm font-medium">
          Chọn app ngân hàng của bạn để mở:
        </p>
        <div className="grid grid-cols-3 gap-2">
          {VIETQR_BANK_APPS.map((app) => (
            <button
              key={app.appId}
              type="button"
              disabled={!bankCode}
              onClick={() => openBankApp(app.appId)}
              className="rounded-md border border-zinc-200 bg-white px-2 py-2.5 text-xs font-medium text-center leading-tight hover:border-primary hover:bg-primary/5 active:scale-95 transition disabled:opacity-40 disabled:pointer-events-none"
            >
              {app.label}
            </button>
          ))}
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          App sẽ mở màn hình chuyển tiền với thông tin điền sẵn. Kiểm tra lại
          STK và số tiền trước khi xác nhận. Sau khi chuyển xong, quay lại đây
          bấm <span className="font-medium">Duyệt phiếu</span> để ghi nhận.
        </p>
      </SheetContent>
    </Sheet>
  );
}

export default PayViaBankAppSheet;
