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
} from "@/hooks/useCommissionVoucher";
import { useAccounts } from "@/hooks/useAccounts";

interface CommissionVoucherModalProps {
  open: boolean;
  contractId: string | null;
  onOpenChange: (open: boolean) => void;
}

function formatVND(n: number): string {
  return new Intl.NumberFormat("vi-VN").format(Math.round(n)) + " đ";
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
    return `${t.rate_percent}% tiền phòng (mốc ${t.min_months}-${t.max_months} tháng)`;
  }, [prefill]);

  const handleSubmit = async () => {
    if (!prefill) return;

    const tasks: Promise<any>[] = [];

    if (brokerAmount > 0) {
      tasks.push(
        createVoucher.mutateAsync({
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
        })
      );
    }

    const saleAmt = typeof saleAmount === "number" ? saleAmount : 0;
    if (saleAmt > 0) {
      tasks.push(
        createVoucher.mutateAsync({
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
        })
      );
    }

    if (tasks.length === 0) {
      toast.info("Không có khoản chi nào — bỏ qua tạo phiếu.");
      onOpenChange(false);
      return;
    }

    try {
      const results = await Promise.all(tasks);
      toast.success(
        `Đã tạo ${results.length} phiếu chi hoa hồng cho HĐ ${
          prefill.contract_number ?? ""
        }`
      );
      onOpenChange(false);
    } catch {
      // toast.error đã hiển thị bởi mutation onError
    }
  };

  const isPending = createVoucher.isPending;

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
                    <Input
                      type="date"
                      value={voucherDate}
                      onChange={(e) => setVoucherDate(e.target.value)}
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
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Số tiền hoa hồng *</Label>
                    <Input
                      type="number"
                      min={0}
                      value={brokerAmount}
                      onChange={(e) => setBrokerAmount(Number(e.target.value) || 0)}
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
                    <Input
                      value={brokerBank}
                      onChange={(e) => setBrokerBank(e.target.value)}
                    />
                  </div>
                </div>
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
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Số tiền thưởng</Label>
                    <Input
                      type="number"
                      min={0}
                      value={saleAmount}
                      onChange={(e) =>
                        setSaleAmount(
                          e.target.value === "" ? "" : Number(e.target.value) || 0
                        )
                      }
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
                    <Input
                      value={saleBank}
                      onChange={(e) => setSaleBank(e.target.value)}
                    />
                  </div>
                </div>
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
            disabled={isPending || !prefill}
          >
            {isPending ? "Đang tạo..." : "Tạo phiếu chi"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
