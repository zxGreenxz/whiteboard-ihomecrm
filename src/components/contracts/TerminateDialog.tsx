import { useState, useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, ArrowLeft, Ban, LogOut, ReceiptText } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

import {
  terminateForfeitFormSchema,
  terminateMoveOutFormSchema,
} from "@/lib/contractValidation";
import type {
  TerminateForfeitFormData,
  TerminateMoveOutFormData,
} from "@/lib/contractValidation";
import type { ContractWithRelations } from "@/types/contract";
import {
  useTerminateForfeit,
  useTerminateMoveOut,
} from "@/hooks/useContractOperations";
import { useUnpaidInvoices } from "@/hooks/useContracts";
import { useExcessAmount } from "@/hooks/useInvoices";
import { TerminationExtraCharges } from "./TerminationExtraCharges";
import type { ExtraChargeItem } from "@/lib/contractValidation";

type TerminationType = "FORFEIT" | "MOVE_OUT";

interface TerminateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: ContractWithRelations;
}

// Format number as VND
function formatVND(value: number): string {
  return new Intl.NumberFormat("vi-VN").format(value);
}

export function TerminateDialog({
  open,
  onOpenChange,
  contract,
}: TerminateDialogProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [terminationType, setTerminationType] =
    useState<TerminationType | null>(null);

  const terminateForfeit = useTerminateForfeit();
  const terminateMoveOut = useTerminateMoveOut();

  // Query unpaid invoices — dùng cho cả move-out (tính công nợ) lẫn forfeit
  // (liệt kê các hoá đơn sẽ bị huỷ khi bỏ cọc).
  const { data: unpaidInvoices } = useUnpaidInvoices(
    terminationType ? contract.id : undefined
  );
  // Tiền nợ khách (credit) còn dư của contract — pre-fill vào "Tiền phòng thừa"
  // ở move-out, hiển thị info ở forfeit.
  const { data: creditBalance = 0 } = useExcessAmount(
    terminationType ? contract.id : undefined
  );

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setStep(1);
      setTerminationType(null);
    }
  }, [open]);

  const handleSelectType = (type: TerminationType) => {
    setTerminationType(type);
    setStep(2);
  };

  const handleBack = () => {
    setStep(1);
    setTerminationType(null);
  };

  const isPending = terminateForfeit.isPending || terminateMoveOut.isPending;

  // Get representative customer name
  const representativeCustomer = contract.contract_customers?.find(
    (cc) => cc.is_representative
  );
  const customerName =
    representativeCustomer?.customer?.full_name || "—";

  // Room/building info
  const roomName = contract.room?.name || "—";
  const buildingName = contract.room?.building?.name || "";
  const locationDisplay = buildingName
    ? `${buildingName} - ${roomName}`
    : roomName;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 1
              ? "Thanh lý hợp đồng"
              : terminationType === "FORFEIT"
                ? "Thanh lý — Khách bỏ cọc"
                : "Thanh lý — Khách rời phòng"}
          </DialogTitle>
        </DialogHeader>

        {step === 1 && (
          <StepSelectType onSelect={handleSelectType} />
        )}

        {step === 2 && terminationType === "FORFEIT" && (
          <StepForfeit
            contract={contract}
            creditBalance={creditBalance}
            unpaidInvoices={unpaidInvoices || []}
            onBack={handleBack}
            onClose={() => onOpenChange(false)}
            isPending={isPending}
            terminateForfeit={terminateForfeit}
          />
        )}

        {step === 2 && terminationType === "MOVE_OUT" && (
          <StepMoveOut
            contract={contract}
            customerName={customerName}
            locationDisplay={locationDisplay}
            unpaidInvoices={unpaidInvoices || []}
            creditBalance={creditBalance}
            onBack={handleBack}
            onClose={() => onOpenChange(false)}
            isPending={isPending}
            terminateMoveOut={terminateMoveOut}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// =============================================
// Step 1: Select termination type
// =============================================

function StepSelectType({
  onSelect,
}: {
  onSelect: (type: TerminationType) => void;
}) {
  return (
    <div className="space-y-4 py-4">
      <p className="text-sm text-muted-foreground">
        Chọn hình thức thanh lý hợp đồng:
      </p>
      {/* B3 (audit 03/07): nêu rõ hệ quả rất khác nhau của 2 hình thức ngay tại
          bước chọn — cả 2 đều gần như không thể hoàn tác. */}
      <div className="grid grid-cols-2 gap-4">
        <Button
          variant="outline"
          className="h-auto min-h-28 flex flex-col items-center gap-1.5 py-3 whitespace-normal hover:border-red-300 hover:bg-red-50"
          onClick={() => onSelect("FORFEIT")}
        >
          <Ban className="h-6 w-6 text-red-500" />
          <span className="font-medium">Khách bỏ cọc</span>
          <span className="text-[11px] font-normal text-muted-foreground leading-snug text-center">
            Huỷ mọi hoá đơn còn nợ, giữ cọc làm doanh thu (cần Duyệt phiếu sau)
          </span>
        </Button>
        <Button
          variant="outline"
          className="h-auto min-h-28 flex flex-col items-center gap-1.5 py-3 whitespace-normal hover:border-orange-300 hover:bg-orange-50"
          onClick={() => onSelect("MOVE_OUT")}
        >
          <LogOut className="h-6 w-6 text-orange-500" />
          <span className="font-medium">Khách rời phòng</span>
          <span className="text-[11px] font-normal text-muted-foreground leading-snug text-center">
            Hoàn cọc sau khi trừ công nợ/thu thêm — quyết toán ngay
          </span>
        </Button>
      </div>
    </div>
  );
}

// =============================================
// Step 2a: Forfeit deposit form
// =============================================

function StepForfeit({
  contract,
  creditBalance,
  unpaidInvoices,
  onBack,
  onClose,
  isPending,
  terminateForfeit,
}: {
  contract: ContractWithRelations;
  creditBalance: number;
  unpaidInvoices: any[];
  onBack: () => void;
  onClose: () => void;
  isPending: boolean;
  terminateForfeit: ReturnType<typeof useTerminateForfeit>;
}) {
  const form = useForm<TerminateForfeitFormData>({
    resolver: zodResolver(terminateForfeitFormSchema),
    defaultValues: {
      forfeit_date: new Date().toISOString().split("T")[0],
    },
  });

  const [extraCharges, setExtraCharges] = useState<ExtraChargeItem[]>([]);
  const extraTotal = extraCharges.reduce((s, it) => s + (it.amount || 0), 0);

  // B4 (audit 03/07): số cọc THỰC sẽ chuyển thành doanh thu = LEAST(cọc theo HĐ,
  // cọc đã thu) — khớp công thức server; hiển thị rõ trước khi chốt.
  const forfeitAmount = Math.min(
    Number(contract.total_deposit || 0),
    Number(contract.deposit_paid ?? contract.total_deposit ?? 0)
  );
  const depositShort =
    Number(contract.deposit_paid ?? contract.total_deposit ?? 0) <
    Number(contract.total_deposit || 0);

  // B4: xác nhận hệ quả trước khi chạy — thao tác không thể hoàn tác.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingData, setPendingData] =
    useState<TerminateForfeitFormData | null>(null);

  const onSubmit = (data: TerminateForfeitFormData) => {
    setPendingData(data);
    setConfirmOpen(true);
  };

  const doTerminate = () => {
    if (!pendingData) return;
    setConfirmOpen(false);
    terminateForfeit.mutate(
      {
        contractId: contract.id,
        forfeitDate: pendingData.forfeit_date,
        extraCharges,
      },
      {
        onSuccess: () => {
          onClose();
        },
      }
    );
  };

  const forfeitInfo = creditBalance > 0;

  // Tổng "còn nợ" của các hoá đơn sẽ bị huỷ.
  const totalRemaining = useMemo(
    () =>
      unpaidInvoices.reduce((sum: number, inv: any) => {
        const total = Number(inv.total_amount) || 0;
        const paid = Number(inv.paid_amount) || 0;
        return sum + (total - paid);
      }, 0),
    [unpaidInvoices]
  );

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="forfeit_date"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Ngày bỏ cọc <span className="text-red-500">*</span>
              </FormLabel>
              <FormControl>
                <DateInput
                  value={field.value || ""}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  name={field.name}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Các hoá đơn còn nợ sẽ bị huỷ khi bỏ cọc */}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Hoá đơn sẽ bị huỷ
          </h3>
          {unpaidInvoices.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              Không có hoá đơn còn nợ
            </p>
          ) : (
            <div className="border rounded-md overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Mã HĐ</TableHead>
                    <TableHead className="text-xs">Kỳ</TableHead>
                    <TableHead className="text-xs text-right">Tổng tiền</TableHead>
                    <TableHead className="text-xs text-right">Đã TT</TableHead>
                    <TableHead className="text-xs text-right">Còn nợ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unpaidInvoices.map((inv: any) => {
                    const total = Number(inv.total_amount) || 0;
                    const paid = Number(inv.paid_amount) || 0;
                    const remaining = total - paid;
                    return (
                      <TableRow key={inv.id}>
                        <TableCell className="text-xs">
                          {inv.invoice_number || inv.id?.slice(0, 8)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {inv.billing_month || inv.billing_period || "—"}
                        </TableCell>
                        <TableCell className="text-xs text-right">
                          {formatVND(total)}
                        </TableCell>
                        <TableCell className="text-xs text-right">
                          {formatVND(paid)}
                        </TableCell>
                        <TableCell className="text-xs text-right font-medium text-red-600">
                          {formatVND(remaining)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          {totalRemaining > 0 && (
            <p className="text-xs text-muted-foreground text-right">
              Tổng còn nợ sẽ huỷ:{" "}
              <span className="font-medium text-red-600">
                {formatVND(totalRemaining)} đ
              </span>
            </p>
          )}
        </div>

        {forfeitInfo && (
          <div className="rounded-md border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
            Hợp đồng đang có {formatVND(creditBalance)} đ tiền nợ khách (credit).
            Khi bỏ cọc, toàn bộ credit sẽ bị xoá.
          </div>
        )}

        {/* B4: hiện rõ CON SỐ cọc sẽ chuyển doanh thu trước khi chốt */}
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 flex items-center justify-between gap-2">
          <span>Tiền cọc chuyển thành doanh thu (chờ duyệt):</span>
          <strong className="tabular-nums whitespace-nowrap">
            {formatVND(forfeitAmount)} đ
          </strong>
        </div>
        {depositShort && (
          <p className="text-xs text-amber-700 -mt-2">
            Cọc theo HĐ {formatVND(Number(contract.total_deposit || 0))}đ nhưng
            mới thu {formatVND(forfeitAmount)}đ — chỉ giữ được phần đã thu.
          </p>
        )}

        <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
          Khi thanh lý bỏ cọc:{" "}
          <strong>tất cả hoá đơn còn nợ ở trên sẽ bị huỷ</strong> (phần đã thu —
          nếu có — được giữ lại làm doanh thu, chỉ huỷ phần nợ). Tiền cọc được
          ghi nhận thành <strong>phí phạt</strong>: hệ thống tạo sẵn một{" "}
          <strong>phiếu thu "Doanh thu bỏ cọc" (chờ duyệt)</strong> rút từ sổ
          CỌC. Vào sổ thu chi bấm <strong>Duyệt</strong> thì cọc mới vào doanh
          thu (KQKD) và hoá đơn thanh lý mới tất toán.
        </div>

        {/* Thu thêm — tạo hoá đơn thu tiền khách RIÊNG với hoá đơn bù cọc */}
        <div className="border-t pt-4">
          <TerminationExtraCharges
            contract={contract}
            chargeDate={form.watch("forfeit_date")}
            onChange={setExtraCharges}
          />
          {extraTotal > 0 && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              <ReceiptText className="h-4 w-4 mt-0.5 shrink-0" />
              <p>
                Sẽ tạo <strong>hoá đơn thu tiền khách riêng</strong> tổng{" "}
                <strong>{formatVND(extraTotal)} đ</strong>, tách biệt với hoá đơn
                thanh lý bù cọc vào doanh thu.
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Quay lại
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            Hủy
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={isPending}
          >
            {isPending && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            Lập hoá đơn & thanh lý
          </Button>
        </DialogFooter>
      </form>

      {/* B4: xác nhận hệ quả — không thể hoàn tác */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận thanh lý — khách bỏ cọc</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span>Cọc chuyển thành doanh thu (chờ duyệt)</span>
                  <b className="tabular-nums">{formatVND(forfeitAmount)} đ</b>
                </div>
                <div className="flex justify-between">
                  <span>Hoá đơn còn nợ sẽ bị huỷ</span>
                  <b className="tabular-nums">
                    {unpaidInvoices.length} hoá đơn ({formatVND(totalRemaining)} đ)
                  </b>
                </div>
                {extraTotal > 0 && (
                  <div className="flex justify-between">
                    <span>Thu thêm (hoá đơn công nợ riêng)</span>
                    <b className="tabular-nums">{formatVND(extraTotal)} đ</b>
                  </div>
                )}
                <p className="pt-2 text-muted-foreground">
                  Thao tác này <b>không thể hoàn tác</b>. Sau khi chạy, vào Thu
                  chi bấm <b>Duyệt</b> phiếu "Doanh thu bỏ cọc" để hoàn tất.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Xem lại</AlertDialogCancel>
            <AlertDialogAction onClick={doTerminate}>
              Xác nhận thanh lý
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Form>
  );
}

// =============================================
// Step 2b: Move-out form with 4 sections
// =============================================

function StepMoveOut({
  contract,
  customerName,
  locationDisplay,
  unpaidInvoices,
  creditBalance,
  onBack,
  onClose,
  isPending,
  terminateMoveOut,
}: {
  contract: ContractWithRelations;
  customerName: string;
  locationDisplay: string;
  unpaidInvoices: any[];
  creditBalance: number;
  onBack: () => void;
  onClose: () => void;
  isPending: boolean;
  terminateMoveOut: ReturnType<typeof useTerminateMoveOut>;
}) {
  // A1 (audit 03/07): mặc định hoàn cọc theo cọc THỰC THU (deposit_paid), không
  // phải cọc theo HĐ — server cũng kẹp LEAST(refund, deposit_paid) để không thể
  // hoàn quá số khách đã đóng.
  const totalDeposit = Number(contract.total_deposit || 0);
  const depositPaid = Number(contract.deposit_paid ?? contract.total_deposit ?? 0);

  const form = useForm<TerminateMoveOutFormData>({
    resolver: zodResolver(terminateMoveOutFormSchema),
    defaultValues: {
      move_out_date: contract.expected_move_out_date
        ? contract.expected_move_out_date.split("T")[0]
        : new Date().toISOString().split("T")[0],
      deposit_refund: Math.min(totalDeposit, depositPaid),
      excess_rent: 0,
      notes: "",
    },
  });

  const [extraCharges, setExtraCharges] = useState<ExtraChargeItem[]>([]);
  const extraTotal = extraCharges.reduce((s, it) => s + (it.amount || 0), 0);

  // A5 (audit 03/07): khi quyết toán âm (khách còn phải trả), cho chọn
  // "đã trả ngay" (ghi thu) hay "ghi nợ" (giữ công nợ thật chờ thu).
  const [shortfallMode, setShortfallMode] = useState<"PAID" | "DEBT">("PAID");

  // B4: xác nhận hệ quả trước khi chạy.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingData, setPendingData] =
    useState<TerminateMoveOutFormData | null>(null);

  // Auto fill credit (excess_amounts) vào "Tiền phòng thừa" lần đầu khi user
  // chưa chỉnh tay. Chỉ thực hiện khi credit > 0 và excess_rent chưa được
  // user gõ (sau khi user gõ "dirty" thì giữ nguyên).
  const excessDirty = !!form.formState.dirtyFields.excess_rent;
  useEffect(() => {
    if (creditBalance > 0 && !excessDirty) {
      form.setValue("excess_rent", creditBalance);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creditBalance]);

  // Watch values for real-time settlement calculation
  const depositRefund = form.watch("deposit_refund") || 0;
  const excessRent = form.watch("excess_rent") || 0;

  // Calculate outstanding debt from unpaid invoices
  const outstandingDebt = useMemo(() => {
    return unpaidInvoices.reduce((sum: number, inv: any) => {
      const total = Number(inv.total_amount) || 0;
      const paid = Number(inv.paid_amount) || 0;
      return sum + (total - paid);
    }, 0);
  }, [unpaidInvoices]);

  // Settlement formula: deposit_refund + excess_rent - outstanding_debt - thu thêm
  const totalDeductions = outstandingDebt + extraTotal;
  const settlementAmount = depositRefund + excessRent - totalDeductions;

  const onSubmit = (data: TerminateMoveOutFormData) => {
    setPendingData(data);
    setConfirmOpen(true);
  };

  const doTerminate = () => {
    if (!pendingData) return;
    setConfirmOpen(false);
    terminateMoveOut.mutate(
      {
        contractId: contract.id,
        moveOutDate: pendingData.move_out_date,
        depositRefund: pendingData.deposit_refund,
        excessRent: pendingData.excess_rent,
        outstandingDebt,
        notes: pendingData.notes,
        extraCharges,
        shortfallMode,
      },
      {
        onSuccess: () => {
          onClose();
        },
      }
    );
  };

  const formatDate = (dateStr: string | null) =>
    dateStr ? new Date(dateStr).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {/* Section 1: Thông tin hợp đồng (readonly) */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Thông tin hợp đồng
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Mã HĐ</label>
              <Input
                value={contract.contract_number || "—"}
                readOnly
                disabled
                className="bg-muted h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                Khách hàng
              </label>
              <Input
                value={customerName}
                readOnly
                disabled
                className="bg-muted h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Phòng</label>
              <Input
                value={locationDisplay}
                readOnly
                disabled
                className="bg-muted h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Ngày BĐ</label>
              <Input
                value={formatDate(contract.start_date)}
                readOnly
                disabled
                className="bg-muted h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Ngày KT</label>
              <Input
                value={formatDate(contract.end_date)}
                readOnly
                disabled
                className="bg-muted h-8 text-sm"
              />
            </div>
            <FormField
              control={form.control}
              name="move_out_date"
              render={({ field }) => (
                <FormItem className="space-y-1">
                  <FormLabel className="text-xs text-muted-foreground">
                    Ngày chuyển đi <span className="text-red-500">*</span>
                  </FormLabel>
                  <FormControl>
                    <DateInput
                      value={field.value || ""}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      name={field.name}
                      className="h-8 text-sm"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* Section 2: Công nợ khách hàng */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Công nợ khách hàng
          </h3>
          {unpaidInvoices.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              Không có hoá đơn chưa thanh toán
            </p>
          ) : (
            <div className="border rounded-md overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Mã HĐ</TableHead>
                    <TableHead className="text-xs">Kỳ</TableHead>
                    <TableHead className="text-xs text-right">
                      Tổng tiền
                    </TableHead>
                    <TableHead className="text-xs text-right">
                      Đã TT
                    </TableHead>
                    <TableHead className="text-xs text-right">
                      Còn lại
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unpaidInvoices.map((inv: any) => {
                    const total = Number(inv.total_amount) || 0;
                    const paid = Number(inv.paid_amount) || 0;
                    const remaining = total - paid;
                    return (
                      <TableRow key={inv.id}>
                        <TableCell className="text-xs">
                          {inv.invoice_number || inv.id?.slice(0, 8)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {inv.billing_period || "—"}
                        </TableCell>
                        <TableCell className="text-xs text-right">
                          {formatVND(total)}
                        </TableCell>
                        <TableCell className="text-xs text-right">
                          {formatVND(paid)}
                        </TableCell>
                        <TableCell className="text-xs text-right font-medium text-red-600">
                          {formatVND(remaining)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {/* Section 3: Hoàn cọc và tiền thừa */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Hoàn cọc và tiền thừa
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <FormField
              control={form.control}
              name="deposit_refund"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Tiền cọc hoàn trả</FormLabel>
                  <FormControl>
                    <CurrencyInput
                      className="h-9 text-sm text-right"
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      name={field.name}
                    />
                  </FormControl>
                  <p className="text-[11px] text-muted-foreground">
                    Cọc theo HĐ: {formatVND(totalDeposit)}đ · Đã thu:{" "}
                    {formatVND(depositPaid)}đ
                  </p>
                  {Number(field.value || 0) > depositPaid && (
                    <p className="text-[11px] text-amber-700">
                      Vượt cọc đã thu — hệ thống chỉ hoàn tối đa{" "}
                      {formatVND(depositPaid)}đ.
                    </p>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="excess_rent"
              render={({ field }) => (
                <FormItem>
                  {/* B2 (audit 03/07): nhãn nói đúng bản chất (credit khách trả dư);
                      chỉ phần NHẬP ở đây được áp vào quyết toán & tiêu khỏi credit. */}
                  <FormLabel className="text-xs">
                    Tiền thừa của khách (credit) áp vào quyết toán
                  </FormLabel>
                  <FormControl>
                    <CurrencyInput
                      className="h-9 text-sm text-right"
                      value={field.value}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      name={field.name}
                    />
                  </FormControl>
                  {creditBalance > 0 && (
                    <p className="text-[11px] text-blue-700">
                      Khách đang có {formatVND(creditBalance)}đ credit (tiền trả
                      dư). Chỉ phần nhập ở đây được áp vào quyết toán và trừ
                      khỏi credit; phần còn lại giữ nguyên.
                    </p>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* Section 3b: Thu thêm — gộp chung vào hoá đơn thanh lý, khấu trừ cọc */}
        <div className="border-t pt-4">
          <TerminationExtraCharges
            contract={contract}
            chargeDate={form.watch("move_out_date")}
            onChange={setExtraCharges}
          />
        </div>

        {/* Section 4: Tổng hợp (auto-calculated realtime) */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Tổng hợp
          </h3>
          <div className="rounded-xl border bg-muted/30 p-4 text-sm">
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tổng công nợ</span>
                <span className="font-medium tabular-nums text-red-600">
                  {formatVND(outstandingDebt)} đ
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tiền cọc hoàn trả</span>
                <span className="font-medium tabular-nums text-emerald-600">
                  {formatVND(depositRefund)} đ
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tiền phòng thừa</span>
                <span className="font-medium tabular-nums text-emerald-600">
                  {formatVND(excessRent)} đ
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tổng thu thêm</span>
                <span className="font-medium tabular-nums text-red-600">
                  {formatVND(extraTotal)} đ
                </span>
              </div>
              {/* A3 (chủ ý nghiệp vụ giữ mặc định vệ sinh 200k — chỉ liệt kê rõ
                  từng khoản để người duyệt nhìn thấy ngay, không gộp mờ). */}
              {extraCharges
                .filter((it) => (it.amount || 0) > 0)
                .map((it, i) => (
                  <div
                    key={i}
                    className="flex justify-between text-xs text-muted-foreground pl-4"
                  >
                    <span>· {it.description || it.kind}</span>
                    <span className="tabular-nums">
                      {formatVND(it.amount || 0)} đ
                    </span>
                  </div>
                ))}
              <div className="flex justify-between border-t border-dashed pt-1.5">
                <span className="text-muted-foreground">
                  Tổng khấu trừ <span className="text-xs">(công nợ + thu thêm)</span>
                </span>
                <span className="font-medium tabular-nums text-red-600">
                  −{formatVND(totalDeductions)} đ
                </span>
              </div>
            </div>

            <div
              className={`mt-3 flex items-center justify-between rounded-lg border px-3.5 py-3 ${
                settlementAmount >= 0
                  ? "border-emerald-200 bg-emerald-50"
                  : "border-red-200 bg-red-50"
              }`}
            >
              <div className="flex flex-col">
                <span className="font-semibold">
                  {settlementAmount >= 0
                    ? "Chủ nhà trả lại khách"
                    : "Khách còn phải trả"}
                </span>
                <span className="text-xs text-muted-foreground">
                  Số tiền quyết toán
                </span>
              </div>
              {/* A5: bỏ dấu "−" gây nhiễu cho số tiền khách NỢ — hướng đã nói ở nhãn */}
              <span
                className={`text-xl font-bold tabular-nums ${
                  settlementAmount >= 0 ? "text-emerald-700" : "text-red-700"
                }`}
              >
                {formatVND(Math.abs(settlementAmount))} đ
              </span>
            </div>

            {/* A5 (audit 03/07): quyết toán âm — hỏi rõ tiền phần thiếu đã thu chưa,
                tránh ghi doanh thu ảo khi khách chưa trả. */}
            {settlementAmount < 0 && (
              <RadioGroup
                value={shortfallMode}
                onValueChange={(v) => setShortfallMode(v as "PAID" | "DEBT")}
                className="mt-3 gap-2"
              >
                <label className="flex items-start gap-2 rounded-md border p-2.5 text-sm cursor-pointer has-[[data-state=checked]]:border-emerald-400 has-[[data-state=checked]]:bg-emerald-50">
                  <RadioGroupItem value="PAID" className="mt-0.5" />
                  <span>
                    <b>Khách đã trả đủ {formatVND(Math.abs(settlementAmount))}đ</b>{" "}
                    khi rời phòng — ghi nhận thu ngay.
                  </span>
                </label>
                <label className="flex items-start gap-2 rounded-md border p-2.5 text-sm cursor-pointer has-[[data-state=checked]]:border-amber-400 has-[[data-state=checked]]:bg-amber-50">
                  <RadioGroupItem value="DEBT" className="mt-0.5" />
                  <span>
                    <b>Ghi nợ</b> — hoá đơn giữ công nợ{" "}
                    {formatVND(Math.abs(settlementAmount))}đ chờ thu sau; không
                    ghi doanh thu khi chưa thu được tiền.
                  </span>
                </label>
              </RadioGroup>
            )}
          </div>
        </div>

        {/* Notes */}
        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">Ghi chú</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Ghi chú thanh lý..."
                  rows={2}
                  className="text-sm"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Quay lại
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            Hủy
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={isPending}
          >
            {isPending && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            Lập hoá đơn & Thanh lý
          </Button>
        </DialogFooter>
      </form>

      {/* B4: xác nhận hệ quả — không thể hoàn tác */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận thanh lý — khách rời phòng</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span>Cọc hoàn/cấn (kẹp theo đã thu)</span>
                  <b className="tabular-nums">
                    {formatVND(Math.min(depositRefund, depositPaid))} đ
                  </b>
                </div>
                <div className="flex justify-between">
                  <span>Công nợ được quyết toán</span>
                  <b className="tabular-nums">{formatVND(outstandingDebt)} đ</b>
                </div>
                {extraTotal > 0 && (
                  <div className="flex justify-between">
                    <span>Thu thêm</span>
                    <b className="tabular-nums">{formatVND(extraTotal)} đ</b>
                  </div>
                )}
                {excessRent > 0 && (
                  <div className="flex justify-between">
                    <span>Tiền thừa (credit) áp vào quyết toán</span>
                    <b className="tabular-nums">{formatVND(excessRent)} đ</b>
                  </div>
                )}
                <div className="flex justify-between border-t pt-1.5">
                  <span>
                    {settlementAmount >= 0
                      ? "Trả lại khách"
                      : shortfallMode === "PAID"
                        ? "Khách trả thêm (ghi thu ngay)"
                        : "Khách còn nợ (ghi nợ chờ thu)"}
                  </span>
                  <b className="tabular-nums">
                    {formatVND(Math.abs(settlementAmount))} đ
                  </b>
                </div>
                <p className="pt-2 text-muted-foreground">
                  Thao tác này <b>không thể hoàn tác</b>: hợp đồng chuyển "Đã
                  thanh lý", phòng được giải phóng, phiếu thu/chi được tạo.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Xem lại</AlertDialogCancel>
            <AlertDialogAction onClick={doTerminate}>
              Xác nhận thanh lý
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Form>
  );
}
