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
import { Loader2, ArrowLeft, Ban, LogOut } from "lucide-react";

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

  // Query unpaid invoices for move-out flow
  const { data: unpaidInvoices } = useUnpaidInvoices(
    terminationType === "MOVE_OUT" ? contract.id : undefined
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
      <div className="grid grid-cols-2 gap-4">
        <Button
          variant="outline"
          className="h-24 flex flex-col items-center gap-2 hover:border-red-300 hover:bg-red-50"
          onClick={() => onSelect("FORFEIT")}
        >
          <Ban className="h-6 w-6 text-red-500" />
          <span className="font-medium">Khách bỏ cọc</span>
        </Button>
        <Button
          variant="outline"
          className="h-24 flex flex-col items-center gap-2 hover:border-orange-300 hover:bg-orange-50"
          onClick={() => onSelect("MOVE_OUT")}
        >
          <LogOut className="h-6 w-6 text-orange-500" />
          <span className="font-medium">Khách rời phòng</span>
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
  onBack,
  onClose,
  isPending,
  terminateForfeit,
}: {
  contract: ContractWithRelations;
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

  const onSubmit = (data: TerminateForfeitFormData) => {
    terminateForfeit.mutate(
      {
        contractId: contract.id,
        forfeitDate: data.forfeit_date,
      },
      {
        onSuccess: () => {
          onClose();
        },
      }
    );
  };

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
                <Input type="date" {...field} />
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
            Lập hoá đơn & thanh lý
          </Button>
        </DialogFooter>
      </form>
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
  onBack,
  onClose,
  isPending,
  terminateMoveOut,
}: {
  contract: ContractWithRelations;
  customerName: string;
  locationDisplay: string;
  unpaidInvoices: any[];
  onBack: () => void;
  onClose: () => void;
  isPending: boolean;
  terminateMoveOut: ReturnType<typeof useTerminateMoveOut>;
}) {
  const form = useForm<TerminateMoveOutFormData>({
    resolver: zodResolver(terminateMoveOutFormSchema),
    defaultValues: {
      move_out_date: contract.expected_move_out_date
        ? contract.expected_move_out_date.split("T")[0]
        : new Date().toISOString().split("T")[0],
      deposit_refund: contract.total_deposit || 0,
      penalty_fee: 0,
      excess_rent: 0,
      notes: "",
    },
  });

  // Watch values for real-time settlement calculation
  const depositRefund = form.watch("deposit_refund") || 0;
  const penaltyFee = form.watch("penalty_fee") || 0;
  const excessRent = form.watch("excess_rent") || 0;

  // Calculate outstanding debt from unpaid invoices
  const outstandingDebt = useMemo(() => {
    return unpaidInvoices.reduce((sum: number, inv: any) => {
      const total = Number(inv.total_amount) || 0;
      const paid = Number(inv.paid_amount) || 0;
      return sum + (total - paid);
    }, 0);
  }, [unpaidInvoices]);

  // Settlement formula: deposit_refund + excess_rent - outstanding_debt - penalty_fee
  const totalDeductions = outstandingDebt + penaltyFee;
  const settlementAmount = depositRefund + excessRent - totalDeductions;

  const onSubmit = (data: TerminateMoveOutFormData) => {
    terminateMoveOut.mutate(
      {
        contractId: contract.id,
        moveOutDate: data.move_out_date,
        depositRefund: data.deposit_refund,
        penaltyFee: data.penalty_fee,
        excessRent: data.excess_rent,
        outstandingDebt,
        notes: data.notes,
      },
      {
        onSuccess: () => {
          onClose();
        },
      }
    );
  };

  const formatDate = (dateStr: string | null) =>
    dateStr ? new Date(dateStr).toLocaleDateString("vi-VN") : "—";

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
                    <Input type="date" className="h-8 text-sm" {...field} />
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
          <div className="grid grid-cols-3 gap-3">
            <FormField
              control={form.control}
              name="deposit_refund"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Tiền cọc hoàn trả</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      className="h-8 text-sm"
                      {...field}
                      value={field.value ?? ""}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value === ""
                            ? 0
                            : Number(e.target.value)
                        )
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="penalty_fee"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Phí phạt</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      className="h-8 text-sm"
                      {...field}
                      value={field.value ?? ""}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value === ""
                            ? 0
                            : Number(e.target.value)
                        )
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="excess_rent"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Tiền phòng thừa</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      className="h-8 text-sm"
                      {...field}
                      value={field.value ?? ""}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value === ""
                            ? 0
                            : Number(e.target.value)
                        )
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* Section 4: Tổng hợp (auto-calculated realtime) */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Tổng hợp
          </h3>
          <div className="bg-muted/50 rounded-lg p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Tổng công nợ:</span>
              <span className="font-medium text-red-600">
                {formatVND(outstandingDebt)} đ
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Tiền cọc hoàn trả:</span>
              <span className="font-medium text-green-600">
                {formatVND(depositRefund)} đ
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Tiền phòng thừa:</span>
              <span className="font-medium text-green-600">
                {formatVND(excessRent)} đ
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                Tổng khấu trừ (công nợ + phí phạt):
              </span>
              <span className="font-medium text-red-600">
                {formatVND(totalDeductions)} đ
              </span>
            </div>
            <div className="border-t pt-2 flex justify-between">
              <span className="font-semibold">Số tiền quyết toán:</span>
              <span
                className={`font-bold text-lg ${
                  settlementAmount >= 0 ? "text-green-700" : "text-red-700"
                }`}
              >
                {settlementAmount >= 0 ? "+" : ""}
                {formatVND(settlementAmount)} đ
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {settlementAmount >= 0
                ? "Chủ nhà trả lại khách"
                : "Khách phải trả thêm"}
            </p>
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
    </Form>
  );
}
