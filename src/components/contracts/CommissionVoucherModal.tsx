import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

import {
  useCommissionPrefill,
  useCreateCommissionVoucher,
  useExistingCommissionVouchers,
  type ExistingCommissionVoucher,
} from "@/hooks/useCommissionVoucher";
import { useAccounts } from "@/hooks/useAccounts";
import BankSelect from "@/components/income-expenses/BankSelect";

interface CommissionVoucherModalProps {
  open: boolean;
  contractId: string | null;
  onOpenChange: (open: boolean) => void;
}

function formatVND(n: number): string {
  return new Intl.NumberFormat("vi-VN").format(Math.round(n)) + " đ";
}

function formatDateVN(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getDate()).padStart(2, "0")}-${String(
    d.getMonth() + 1
  ).padStart(2, "0")}-${d.getFullYear()}`;
}

/** Banner "đã chi" — thay form nhập khi HĐ đã có phiếu HH loại tương ứng */
function ExistingVoucherBanner({
  voucher,
  label,
}: {
  voucher: ExistingCommissionVoucher;
  label: string;
}) {
  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
      Đã chi {label} cho HĐ này: phiếu <b>{voucher.code ?? "?"}</b> —{" "}
      <b>{formatVND(Number(voucher.total_amount) || 0)}</b>
      {voucher.approval_status === "UNAPPROVED" ? " (chờ duyệt)" : ""}.
      Mỗi hợp đồng chỉ chi 1 lần; nếu phiếu sai, hãy hủy phiếu đó ở trang Thu
      chi rồi tạo lại.
    </div>
  );
}

export function CommissionVoucherModal({
  open,
  contractId,
  onOpenChange,
}: CommissionVoucherModalProps) {
  const { data: prefill, isLoading } = useCommissionPrefill(
    open ? contractId : null
  );
  const { data: accounts = [] } = useAccounts();
  const createVoucher = useCreateCommissionVoucher();

  // Chống chi lần 2: phiếu HH sống đã có của HĐ này (mỗi HĐ tối đa 1 phiếu/loại)
  const { data: existingVouchers = [] } = useExistingCommissionVouchers(
    open ? contractId : null
  );
  const existingBroker = existingVouchers.find(
    (v) => v.commission_kind === "broker"
  );
  const existingSale = existingVouchers.find(
    (v) => v.commission_kind === "sale"
  );

  // ---- Form state (no react-hook-form — lightweight modal) ----
  const [accountId, setAccountId] = useState<string>("");
  const [voucherDate, setVoucherDate] = useState<string>("");

  // Mục 2 — Đơn vị MG
  const [brokerAmount, setBrokerAmount] = useState<number>(0);
  const [brokerName, setBrokerName] = useState<string>("");
  const [brokerAccountNumber, setBrokerAccountNumber] = useState<string>("");
  const [brokerBank, setBrokerBank] = useState<string>("");
  const [brokerRecipient, setBrokerRecipient] = useState<string>("");

  // Mục 3 — Sale (optional)
  const [saleAmount, setSaleAmount] = useState<number | "">("");
  const [saleName, setSaleName] = useState<string>("");
  const [saleAccountNumber, setSaleAccountNumber] = useState<string>("");
  const [saleBank, setSaleBank] = useState<string>("");
  const [saleRecipient, setSaleRecipient] = useState<string>("");

  // Reset & prefill khi modal mở / dữ liệu sẵn sàng
  useEffect(() => {
    if (!open) return;
    if (!prefill) return;

    setVoucherDate(prefill.signed_date);
    setAccountId(prefill.default_account_id ?? "");

    if (prefill.matched_tier) {
      const amount =
        Math.round((prefill.rent_price * prefill.matched_tier.rate_percent) / 100) || 0;
      setBrokerAmount(amount);
    } else {
      setBrokerAmount(0);
    }

    setBrokerName("");
    setBrokerAccountNumber("");
    setBrokerBank("");
    setBrokerRecipient("");
    setSaleAmount("");
    setSaleName("");
    setSaleAccountNumber("");
    setSaleBank("");
    setSaleRecipient("");
  }, [open, prefill]);

  const tierLabel = useMemo(() => {
    if (!prefill?.matched_tier) return null;
    const t = prefill.matched_tier;
    const exact =
      prefill.months >= Number(t.min_months) &&
      prefill.months <= Number(t.max_months);
    return exact
      ? `${t.rate_percent}% tiền phòng (mốc ${t.min_months}-${t.max_months} tháng)`
      : `${t.rate_percent}% tiền phòng (vượt mốc, áp dụng mốc cao nhất ${t.min_months}-${t.max_months} tháng)`;
  }, [prefill]);

  // % hoa hồng hiển thị (owner decision 23/07): ưu tiên mốc cấu hình khớp;
  // nếu không có mốc thì suy từ số tiền HH đang nhập / giá phòng.
  const commissionPercent =
    prefill?.matched_tier != null
      ? Number(prefill.matched_tier.rate_percent)
      : prefill && prefill.rent_price > 0 && brokerAmount > 0
      ? (brokerAmount / prefill.rent_price) * 100
      : null;

  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!prefill) return;
    if (submitting) return; // chặn double-click trong khi chạy

    const saleAmt = typeof saleAmount === "number" ? saleAmount : 0;
    // Loại đã có phiếu sống → skip (RPC + unique index vẫn chặn nếu lách)
    const willCreateBroker = brokerAmount > 0 && !existingBroker;
    const willCreateSale = saleAmt > 0 && !existingSale;

    if (!willCreateBroker && !willCreateSale) {
      if (existingBroker || existingSale) {
        toast.info(
          "HĐ này đã có phiếu hoa hồng — mỗi hợp đồng chỉ chi 1 lần, không tạo thêm."
        );
      } else {
        toast.info("Không có khoản chi nào — bỏ qua tạo phiếu.");
      }
      onOpenChange(false);
      return;
    }

    setSubmitting(true);
    let created = 0;
    try {
      // Tạo tuần tự để tránh race condition trên trigger
      // auto_generate_voucher_code (đọc MAX(seq) — 2 insert song song có thể
      // sinh trùng code → vi phạm idx_income_expenses_unique_code_per_user).
      if (willCreateBroker) {
        await createVoucher.mutateAsync({
          contract_id: prefill.contract_id,
          contract_number: prefill.contract_number,
          building_id: prefill.building_id,
          room_id: prefill.room_id,
          tenant_id: prefill.tenant_id,
          account_id: accountId || null,
          voucher_date: voucherDate,
          kind: "broker",
          amount: brokerAmount,
          payer_name: brokerName || null,
          recipient_name: brokerRecipient || null,
          recipient_bank: brokerBank || null,
          recipient_account_number: brokerAccountNumber || null,
          item_description: prefill.matched_tier
            ? `Hoa hồng MG (${prefill.matched_tier.rate_percent}% tiền phòng × ${prefill.months} tháng HĐ)`
            : `Hoa hồng MG (HĐ ${prefill.months} tháng — không khớp mốc cấu hình)`,
        });
        created++;
      }

      if (willCreateSale) {
        await createVoucher.mutateAsync({
          contract_id: prefill.contract_id,
          contract_number: prefill.contract_number,
          building_id: prefill.building_id,
          room_id: prefill.room_id,
          tenant_id: prefill.tenant_id,
          account_id: accountId || null,
          voucher_date: voucherDate,
          kind: "sale",
          amount: saleAmt,
          payer_name: saleName || null,
          recipient_name: saleRecipient || null,
          recipient_bank: saleBank || null,
          recipient_account_number: saleAccountNumber || null,
          item_description: `Thưởng nóng Sale HĐ ${prefill.months} tháng`,
        });
        created++;
      }

      toast.success(
        `Đã tạo ${created} phiếu chi hoa hồng (chờ duyệt) cho HĐ ${
          prefill.contract_number ?? ""
        }`
      );
      onOpenChange(false);
    } catch {
      // toast.error đã hiển thị bởi mutation onError
    } finally {
      setSubmitting(false);
    }
  };

  const isPending = submitting || createVoucher.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] p-0">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle className="text-green-700 uppercase">
            Tạo phiếu chi hoa hồng
          </DialogTitle>
          <DialogDescription>
            Hợp đồng đã được tạo. Vui lòng xác nhận thông tin chi hoa hồng cho
            đơn vị môi giới và (nếu có) thưởng nóng Sale.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-180px)] px-6 pb-2">
          {isLoading || !prefill ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Đang tải thông tin hợp đồng...
            </div>
          ) : (
            <div className="space-y-6 pb-2">
              {/* Metadata HĐ (owner decision 2026-07-23): Phòng/Tòa, thời hạn
                  HĐ, giá phòng, % hoa hồng — read-only, không đổi logic tạo. */}
              <div className="rounded-md border bg-muted/40 px-3 py-2.5 text-sm grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Phòng / Tòa</span>
                  <span className="font-medium text-right">
                    {prefill.room_name ?? "—"} / {prefill.building_name || "—"}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">
                    Ngày bắt đầu – kết thúc HĐ
                  </span>
                  <span className="font-medium text-right">
                    {formatDateVN(prefill.start_date)} –{" "}
                    {formatDateVN(prefill.end_date)}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Giá phòng</span>
                  <span className="font-medium text-right">
                    {formatVND(prefill.rent_price)}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">
                    % hoa hồng (tính theo giá phòng)
                  </span>
                  <span className="font-medium text-right">
                    {commissionPercent != null
                      ? `${(
                          Math.round(commissionPercent * 100) / 100
                        ).toLocaleString("vi-VN")}%`
                      : "—"}
                  </span>
                </div>
              </div>

              {/* Mục 1: Thông tin chung */}
              <div className="space-y-3">
                <h3 className="font-medium">1. THÔNG TIN CHUNG</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Tòa nhà</Label>
                    <Input value={prefill.building_name} disabled />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Phòng</Label>
                    <Input value={prefill.room_name ?? ""} disabled />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Mã hợp đồng</Label>
                    <Input value={prefill.contract_number ?? ""} disabled />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Khách hàng</Label>
                    <Input value={prefill.tenant_name ?? ""} disabled />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Số tháng HĐ</Label>
                    <Input
                      value={`${prefill.months} tháng${
                        tierLabel ? ` — ${tierLabel}` : " — không khớp mốc"
                      }`}
                      disabled
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Ngày phiếu</Label>
                    <DateInput
                      value={voucherDate}
                      onChange={setVoucherDate}
                    />
                  </div>
                  <div className="space-y-1 md:col-span-2">
                    <Label className="text-xs">Sổ quỹ</Label>
                    <Select
                      value={accountId}
                      onValueChange={(v) => setAccountId(v)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Chọn sổ quỹ..." />
                      </SelectTrigger>
                      <SelectContent>
                        {accounts.map((a: any) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {prefill.default_account_id && (
                      <p className="text-xs text-muted-foreground">
                        Mặc định: sổ quỹ cùng tên với tòa nhà.
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <Separator />

              {/* Mục 2: Đơn vị MG */}
              <div className="space-y-3">
                <h3 className="font-medium">2. ĐƠN VỊ MÔI GIỚI</h3>
                {existingBroker ? (
                  <ExistingVoucherBanner
                    voucher={existingBroker}
                    label="hoa hồng môi giới"
                  />
                ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Số tiền hoa hồng *</Label>
                    <CurrencyInput
                      value={brokerAmount}
                      onChange={(v) => setBrokerAmount(v || 0)}
                    />
                    {brokerAmount > 0 && (
                      <p className="text-xs text-muted-foreground">
                        ≈ {formatVND(brokerAmount)}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Tên đơn vị MG</Label>
                    <Input
                      value={brokerName}
                      onChange={(e) => setBrokerName(e.target.value)}
                      placeholder="Tên công ty / cá nhân môi giới"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Tên người nhận</Label>
                    <Input
                      value={brokerRecipient}
                      onChange={(e) => setBrokerRecipient(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Số tài khoản</Label>
                    <Input
                      value={brokerAccountNumber}
                      onChange={(e) => setBrokerAccountNumber(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1 md:col-span-2">
                    <Label className="text-xs">Ngân hàng</Label>
                    <BankSelect
                      value={brokerBank}
                      onChange={setBrokerBank}
                      className="h-10"
                    />
                  </div>
                </div>
                )}
              </div>

              <Separator />

              {/* Mục 3: Sale optional */}
              <div className="space-y-3">
                <h3 className="font-medium">
                  3. THƯỞNG NÓNG SALE{" "}
                  <span className="text-xs text-muted-foreground font-normal">
                    (tuỳ chọn — chỉ tạo phiếu khi có số tiền)
                  </span>
                </h3>
                {existingSale ? (
                  <ExistingVoucherBanner
                    voucher={existingSale}
                    label="thưởng nóng Sale"
                  />
                ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Số tiền thưởng</Label>
                    <CurrencyInput
                      value={typeof saleAmount === "number" ? saleAmount : null}
                      onChange={(v) => setSaleAmount(v === 0 ? "" : v)}
                      placeholder="Để trống nếu không có"
                    />
                    {typeof saleAmount === "number" && saleAmount > 0 && (
                      <p className="text-xs text-muted-foreground">
                        ≈ {formatVND(saleAmount)}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Tên Sale</Label>
                    <Input
                      value={saleName}
                      onChange={(e) => setSaleName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Tên người nhận</Label>
                    <Input
                      value={saleRecipient}
                      onChange={(e) => setSaleRecipient(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Số tài khoản</Label>
                    <Input
                      value={saleAccountNumber}
                      onChange={(e) => setSaleAccountNumber(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1 md:col-span-2">
                    <Label className="text-xs">Ngân hàng</Label>
                    <BankSelect
                      value={saleBank}
                      onChange={setSaleBank}
                      className="h-10"
                    />
                  </div>
                </div>
                )}
              </div>
            </div>
          )}
        </ScrollArea>

        <DialogFooter className="px-6 pb-6 pt-2 gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Bỏ qua
          </Button>
          <Button
            type="button"
            className="bg-green-600 hover:bg-green-700"
            onClick={handleSubmit}
            disabled={
              isPending || !prefill || (!!existingBroker && !!existingSale)
            }
          >
            {isPending
              ? "Đang tạo..."
              : existingBroker && existingSale
              ? "Đã chi đủ hoa hồng"
              : "Tạo phiếu chi"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
