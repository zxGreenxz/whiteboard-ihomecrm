import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Copy, Zap } from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { IncomeExpenseWithRelations } from "@/hooks/useIncomeExpenses";
import {
  VIETQR_BANK_APPS,
  RECIPIENT_BANKS,
  matchRecipientBankCode,
  buildVietQRDeeplink,
  buildVietQRSchemeLink,
  buildVietQRImageUrl,
  extractRecipientFromNotes,
} from "@/lib/vietqrDeeplink";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  voucher: IncomeExpenseWithRelations;
}

const formatVND = (n: number) => `${n.toLocaleString("vi-VN")} đ`;

/**
 * Bottom sheet "Chi tiền qua app ngân hàng" (mobile).
 *
 * Luồng chính = ẢNH VietQR: lưu ảnh QR → mở app bank → quét QR từ thư viện
 * → app tự điền đủ bank/STK/số tiền/nội dung (mọi app bank VN đều hỗ trợ).
 * Deeplink dl.vietqr.io chỉ MỞ app (đa số app chưa nhận payload tự điền)
 * nên grid app đặt sau bước lưu QR.
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
  const transferNote = `${voucher.code} ${voucher.name}`;

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

  const qrUrl = selectedBank
    ? buildVietQRImageUrl({
        bin: selectedBank.bin,
        accountNumber,
        amount: voucher.total_amount,
        note: transferNote,
        accountName: recipientName,
      })
    : null;

  const downloadQR = async () => {
    if (!qrUrl) return;
    try {
      const res = await fetch(qrUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `VietQR-${voucher.code}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Đã lưu ảnh QR — mở app ngân hàng, quét QR từ thư viện ảnh");
    } catch {
      // CORS chặn fetch → mở tab mới để user nhấn giữ lưu ảnh
      window.open(qrUrl, "_blank", "noopener");
      toast.info("Nhấn giữ ảnh QR để lưu về máy");
    }
  };

  const copyAccount = async () => {
    try {
      await navigator.clipboard.writeText(
        accountNumber.replace(/[^0-9a-zA-Z]/g, "")
      );
      toast.success("Đã copy số tài khoản");
    } catch {
      toast.error("Không copy được — chép tay giúp nhé");
    }
  };

  const openBankApp = (appId: string) => {
    if (!bankCode) return;
    const url = buildVietQRDeeplink({
      appId,
      bankCode,
      accountNumber,
      amount: voucher.total_amount,
      note: transferNote,
      recipientName,
    });
    window.location.href = url;
  };

  // Thử scheme vietqr:// (đặc tả kỳ vọng của VietQR — app hỗ trợ sẽ mở
  // màn hình CK điền sẵn). Nếu sau 2s trang vẫn visible = không app nào
  // bắt scheme → hướng user sang quét QR.
  const schemeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onHide = () => {
      if (schemeTimerRef.current) {
        clearTimeout(schemeTimerRef.current);
        schemeTimerRef.current = null;
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      onHide();
    };
  }, []);

  const quickPay = () => {
    if (!bankCode) return;
    const link = buildVietQRSchemeLink({
      bankCode,
      accountNumber,
      amount: voucher.total_amount,
      note: transferNote,
      recipientName,
    });
    if (schemeTimerRef.current) clearTimeout(schemeTimerRef.current);
    schemeTimerRef.current = setTimeout(() => {
      schemeTimerRef.current = null;
      if (document.visibilityState === "visible") {
        toast.info(
          "Chưa có app ngân hàng nào trên máy hỗ trợ tự điền qua vietqr:// — dùng Cách 1 (lưu ảnh QR rồi quét từ thư viện) nhé."
        );
      }
    }, 2000);
    window.location.href = link;
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
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <span className="text-muted-foreground shrink-0">Số TK</span>
            <span className="flex items-center gap-1.5 font-medium">
              {accountNumber || "—"}
              {accountNumber && (
                <button
                  type="button"
                  onClick={copyAccount}
                  className="p-1 rounded hover:bg-zinc-100 text-muted-foreground"
                  title="Copy số tài khoản"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              )}
            </span>
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

        {/* Cách 1: QR — app nào quét cũng tự điền đủ thông tin */}
        {qrUrl && (
          <div className="mt-4">
            <p className="text-sm font-medium mb-2">
              Cách 1 (khuyến nghị): Quét mã VietQR
            </p>
            <div className="flex flex-col items-center gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <img
                src={qrUrl}
                alt={`VietQR chuyển tiền phiếu ${voucher.code}`}
                className="w-56 max-w-full rounded-md bg-white"
              />
              <Button
                type="button"
                onClick={downloadQR}
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                <Download className="h-4 w-4 mr-2" />
                Lưu ảnh QR
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                Lưu ảnh → mở app ngân hàng → bấm <b>Quét QR</b> → chọn ảnh từ{" "}
                <b>thư viện</b>. App tự điền đủ STK, số tiền, nội dung.
              </p>
            </div>
          </div>
        )}

        {/* Cách 2: mở app (deeplink chỉ mở app — tuỳ app mới tự điền) */}
        <p className="mt-4 mb-2 text-sm font-medium">
          {qrUrl ? "Cách 2: Mở app ngân hàng" : "Mở app ngân hàng"}
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={!bankCode}
          onClick={quickPay}
          className="w-full mb-2 border-emerald-600 text-emerald-700 hover:bg-emerald-50"
        >
          <Zap className="h-4 w-4 mr-2" />
          Chuyển khoản nhanh (app hỗ trợ sẽ tự điền)
        </Button>
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
        <p className="mt-2 text-xs text-muted-foreground">
          Đa số app chỉ mở lên chứ chưa tự điền thông tin — hãy lưu ảnh QR ở
          Cách 1 rồi quét từ thư viện. Chuyển xong, quay lại bấm{" "}
          <span className="font-medium">Duyệt phiếu</span> để ghi nhận.
        </p>
      </SheetContent>
    </Sheet>
  );
}

export default PayViaBankAppSheet;
