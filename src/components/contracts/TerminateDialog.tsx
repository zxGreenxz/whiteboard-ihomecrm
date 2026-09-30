import { useState, useEffect, useMemo, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
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
import { Loader2, ArrowLeft, ReceiptText, Undo2 } from "lucide-react";
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
import { useConfirmContractReturn, useFinalizeContractExitCase } from '@/hooks/useContractExitCases';
import type { ContractExitCase, ExitKind, ExitSettlementInput } from '@/lib/contractExitCases';
import { ContractReturnStep } from './ContractReturnStep';
import { ContractMeterBoundaryFields } from './ContractMeterBoundaryFields';
import type { MeterBoundaryInput } from '@/lib/contractMeterBoundaries';
import { useUnpaidInvoices } from "@/hooks/useContracts";
import { useExcessAmount } from "@/hooks/useInvoices";
import { useAccounts } from "@/hooks/useAccounts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TerminationExtraCharges } from "./TerminationExtraCharges";
import { TerminationRefundItems } from "./TerminationRefundItems";
import type { ExtraChargeItem, RefundItem } from "@/lib/contractValidation";
import { computeTerminationSettlement } from "@/lib/terminationSettlement";
import { todayISO } from '@/lib/collect';
import { useContractTransferLinks, useFinalizeContractTransferExit } from '@/hooks/contracts/useContractTransferLinks';
import { transferBrokerFeeLine, withTransferBrokerFee } from '@/lib/contract-lifecycle/transfers';

interface TerminateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: ContractWithRelations;
  exitCase?: ContractExitCase;
}

// Format number as VND
function formatVND(value: number): string {
  return new Intl.NumberFormat("vi-VN").format(value);
}

export function TerminateDialog({
  open,
  onOpenChange,
  contract,
  exitCase,
}: TerminateDialogProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [kind, setKind] = useState<ExitKind | null>(null);
  const [actualDate, setActualDate] = useState('');
  const [changeReason, setChangeReason] = useState('');
  const [returnNote, setReturnNote] = useState('');
  const [meterBoundary, setMeterBoundary] = useState<MeterBoundaryInput | null>({ state: 'MISSING', reason: 'Chưa đủ chỉ số khi nhận bàn giao, bổ sung sau' });
  const requestKeys = useRef(new Map<string, string>());
  const confirmReturn = useConfirmContractReturn();
  const finalizeExit = useFinalizeContractExitCase();
  const transferQuery = useContractTransferLinks({ exitCaseId: exitCase?.id }, open && !!exitCase);
  const finalizeTransfer = useFinalizeContractTransferExit();
  const transfer = transferQuery.data?.find(link => link.state === 'LINKED');
  const brokerFee = useMemo(() => transfer?.mode === 'BROKER' && transfer.broker_fee !== null && transfer.broker_fee > 0
    ? transferBrokerFeeLine(transfer) : null, [transfer]);
  const brokerFeeUnavailable = transfer?.mode === 'BROKER' && !brokerFee;
  const transferUnavailable = !!exitCase && (transferQuery.isPending || transferQuery.isError || brokerFeeUnavailable);

  // Query unpaid invoices — dùng cho cả move-out (tính công nợ) lẫn forfeit
  // (liệt kê các hoá đơn sẽ bị huỷ khi bỏ cọc).
  const invoiceQuery = useUnpaidInvoices(
    step === 2 ? contract.id : undefined
  );
  // Tiền nợ khách (credit) còn dư của contract — pre-fill vào "Tiền phòng thừa"
  // ở move-out, hiển thị info ở forfeit.
  const creditQuery = useExcessAmount(
    step === 2 ? contract.id : undefined
  );
  const financeUnavailable = step === 2 && (
    invoiceQuery.isPending || invoiceQuery.isError || creditQuery.isPending || creditQuery.isError ||
    invoiceQuery.data === undefined || creditQuery.data === undefined
  );
  const unpaidInvoices = invoiceQuery.data;
  const creditBalance = creditQuery.data;

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setStep(1);
      setKind(exitCase?.current_kind ?? null);
      setActualDate(exitCase?.actual_move_out_on ?? todayISO());
      setChangeReason('');
      setReturnNote(exitCase?.return_note ?? '');
      setMeterBoundary({ state: 'MISSING', reason: 'Chưa đủ chỉ số khi nhận bàn giao, bổ sung sau' });
      requestKeys.current.clear();
    }
  }, [open, contract.id, exitCase?.id]);

  const handleBack = () => {
    setStep(1);
  };

  const isPending = confirmReturn.isPending || finalizeExit.isPending || finalizeTransfer.isPending;
  const requestKey = (intent: unknown) => {
    const value = JSON.stringify(intent);
    let key = requestKeys.current.get(value);
    if (!key) { key = crypto.randomUUID(); requestKeys.current.set(value, key); }
    return key;
  };
  const deferSettlement = async () => {
    if (!kind || !actualDate || exitCase || !meterBoundary || !returnNote.trim()) return;
    const intent = { contractId: contract.id, expectedContractUpdatedAt: contract.updated_at,
      actualMoveOutOn: actualDate, initialKind: kind, returnNote: returnNote.trim(), settlementMode: 'DEFERRED' as const, meterBoundary };
    try {
      await confirmReturn.mutateAsync({ ...intent, idempotencyKey: requestKey(intent) });
      onOpenChange(false);
    } catch { /* The mutation displays the error and preserves this form for retry. */ }
  };
  const settle = async (settlement: ExitSettlementInput) => {
    if (!kind) throw new Error('Chọn loại thanh lý trước khi quyết toán');
    if (financeUnavailable) throw new Error('Chưa tải được công nợ và số dư khách hàng để quyết toán');
    if (exitCase) {
      if (transferUnavailable) throw new Error('Chưa tải được liên kết nhượng, vui lòng thử lại');
      const intent = { caseId: exitCase.id, expectedVersion: exitCase.version,
        currentKind: kind, reason: changeReason.trim() || undefined, settlement };
      if (transfer) {
        const linkedIntent = { ...intent, linkId: transfer.id, expectedLinkVersion: transfer.version };
        await finalizeTransfer.mutateAsync({ ...linkedIntent, idempotencyKey: requestKey(linkedIntent) });
      } else {
        await finalizeExit.mutateAsync({ ...intent, idempotencyKey: requestKey(intent) });
      }
    } else {
      if (!returnNote.trim()) throw new Error('Vui lòng ghi nội dung thanh lý để đối chiếu');
      if (!meterBoundary) throw new Error('Kiểm tra chỉ số bàn giao hoặc chọn bổ sung sau');
      const intent = { contractId: contract.id, expectedContractUpdatedAt: contract.updated_at,
        actualMoveOutOn: actualDate, initialKind: kind, returnNote: returnNote.trim(), settlementMode: 'IMMEDIATE' as const, settlement, meterBoundary };
      await confirmReturn.mutateAsync({ ...intent, idempotencyKey: requestKey(intent) });
    }
  };

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
    <Dialog open={open} onOpenChange={value => { if (!isPending) onOpenChange(value); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 1
              ? (exitCase ? "Quyết toán hồ sơ đã trả phòng" : "Thanh lý hợp đồng")
              : kind === "FORFEIT"
                ? "Quyết toán — Khách bỏ cọc"
                : "Quyết toán — Khách rời phòng"}
          </DialogTitle>
          <DialogDescription className="sr-only">Ghi nhận ngày trả phòng và loại thanh lý; chọn quyết toán ngay hoặc xử lý hồ sơ sau.</DialogDescription>
        </DialogHeader>

        {transferUnavailable && <p role="status" className="text-sm">{brokerFeeUnavailable ? 'Chưa xác định được phí nhượng hợp lệ. Kiểm tra liên kết nhượng trước khi quyết toán.' : transferQuery.isError ? 'Không tải được liên kết nhượng. Đóng và mở lại hồ sơ để thử lại.' : 'Đang kiểm tra liên kết nhượng…'}</p>}
        {financeUnavailable && <p role="alert" className="text-sm text-destructive">{invoiceQuery.isError || creditQuery.isError ? 'Không tải được công nợ và số dư khách hàng. Vui lòng tải lại trước khi quyết toán.' : 'Đang tải công nợ và số dư khách hàng…'}</p>}

        {step === 1 && (
          <ContractReturnStep actualDate={actualDate} onDateChange={setActualDate}
            kind={kind} onKindChange={setKind} exitCase={exitCase}
            changeReason={changeReason} onReasonChange={setChangeReason}
            returnNote={returnNote} onReturnNoteChange={setReturnNote}
            pending={isPending || transferUnavailable} physicalReady={!!exitCase || (!!contract.room_id && !!meterBoundary)}
            onDefer={() => void deferSettlement()} onContinue={() => setStep(2)}>
            {!exitCase && !!contract.room_id && <ContractMeterBoundaryFields key={contract.room_id} roomId={contract.room_id}
              allowMissing disabled={isPending} initialValue={meterBoundary} onChange={setMeterBoundary} />}
          </ContractReturnStep>
        )}

        {step === 2 && !financeUnavailable && kind === "FORFEIT" && (
          <StepForfeit
            contract={contract}
            creditBalance={creditBalance!}
            unpaidInvoices={unpaidInvoices!}
            onBack={handleBack}
            onClose={() => onOpenChange(false)}
            isPending={isPending || transferUnavailable}
            actualDate={actualDate}
            onSettle={settle}
          />
        )}

        {step === 2 && !financeUnavailable && kind && kind !== "FORFEIT" && (
          <StepMoveOut
            key={transfer?.id ?? 'ordinary'}
            contract={contract}
            customerName={customerName}
            locationDisplay={locationDisplay}
            unpaidInvoices={unpaidInvoices!}
            creditBalance={creditBalance!}
            onBack={handleBack}
            onClose={() => onOpenChange(false)}
            isPending={isPending || transferUnavailable}
            actualDate={actualDate}
            onSettle={settle}
            brokerFee={brokerFee}
            brokerDepositBase={transfer?.mode === 'BROKER' ? transfer.deposit_base : null}
          />
        )}
      </DialogContent>
    </Dialog>
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
  actualDate,
  onSettle,
}: {
  contract: ContractWithRelations;
  creditBalance: number;
  unpaidInvoices: any[];
  onBack: () => void;
  onClose: () => void;
  isPending: boolean;
  actualDate: string;
  onSettle: (settlement: ExitSettlementInput) => Promise<void>;
}) {
  const form = useForm<TerminateForfeitFormData>({
    resolver: zodResolver(terminateForfeitFormSchema),
    defaultValues: {
      forfeit_date: actualDate,
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

  const doTerminate = async () => {
    if (!pendingData) return;
    setConfirmOpen(false);
    try {
      await onSettle({ extraCharges });
      onClose();
    } catch { /* Mutation reports the error; keep settlement inputs. */ }
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
                Ngày trả phòng đã xác nhận
              </FormLabel>
              <FormControl>
                <DateInput
                  value={field.value || ""}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  name={field.name}
                  disabled
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
          <span>Tiền cọc chuyển thành doanh thu (tự duyệt):</span>
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
          ghi nhận thành <strong>phí phạt</strong>: hệ thống tạo{" "}
          <strong>phiếu thu "Doanh thu bỏ cọc" và tự duyệt ngay</strong> (rút từ
          sổ CỌC, không đụng sổ quỹ tiền thật) — cọc vào doanh thu (KQKD) và hoá
          đơn thanh lý tất toán ngay, <strong>không cần bấm Duyệt</strong>.
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
                  <span>Cọc chuyển thành doanh thu (tự duyệt)</span>
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
                  Thao tác này <b>không thể hoàn tác</b>. Phiếu "Doanh thu bỏ
                  cọc" được <b>tự duyệt</b> ngay — không phải làm thêm bước nào.
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
  actualDate,
  onSettle,
  brokerFee,
  brokerDepositBase,
}: {
  contract: ContractWithRelations;
  customerName: string;
  locationDisplay: string;
  unpaidInvoices: any[];
  creditBalance: number;
  onBack: () => void;
  onClose: () => void;
  isPending: boolean;
  actualDate: string;
  onSettle: (settlement: ExitSettlementInput) => Promise<void>;
  brokerFee: ExtraChargeItem | null;
  brokerDepositBase: number | null;
}) {
  // A1 (audit 03/07): mặc định hoàn cọc theo cọc THỰC THU (deposit_paid), không
  // phải cọc theo HĐ — server cũng kẹp LEAST(refund, deposit_paid) để không thể
  // hoàn quá số khách đã đóng.
  const totalDeposit = Number(contract.total_deposit || 0);
  const depositPaid = Number(contract.deposit_paid ?? contract.total_deposit ?? 0);

  const form = useForm<TerminateMoveOutFormData>({
    resolver: zodResolver(terminateMoveOutFormSchema),
    defaultValues: {
      move_out_date: actualDate,
      deposit_refund: brokerDepositBase ?? Math.min(totalDeposit, depositPaid),
      excess_rent: 0,
      notes: "",
    },
  });

  const [editableCharges, setExtraCharges] = useState<ExtraChargeItem[]>([]);
  const extraCharges = useMemo(() => withTransferBrokerFee(editableCharges, brokerFee), [editableCharges, brokerFee]);
  const extraTotal = extraCharges.reduce((s, it) => s + (it.amount || 0), 0);

  // Khoản MÌNH trả lại khách (tiền phòng ngày không ở…) — thêm 22/08/2026.
  // Trước đó không có ô nào nhập được: hoàn cọc kẹp ở cọc thực thu, credit kẹp ở
  // lot đang có, còn "Thu thêm" chỉ nhận số dương.
  const [refundItems, setRefundItems] = useState<RefundItem[]>([]);
  const refundTotal = refundItems.reduce((s, it) => s + (it.amount || 0), 0);

  // A5 (audit 03/07): khi quyết toán âm (khách còn phải trả), cho chọn
  // "đã trả ngay" (ghi thu) hay "ghi nợ" (giữ công nợ thật chờ thu).
  const [shortfallMode, setShortfallMode] = useState<"PAID" | "DEBT">("PAID");

  // B3 (04/07): sổ THỰC nhận tiền "khách trả thêm" — mặc định để trống,
  // server tự chọn sổ "%Thu" của người bấm. Chỉ hiện sổ tiền thật.
  const [receiptAccountId, setReceiptAccountId] = useState<string>("");
  const { data: allAccounts = [] } = useAccounts();
  const realAccounts = allAccounts.filter((a) => !a.is_virtual);

  // B4: xác nhận hệ quả trước khi chạy.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingData, setPendingData] =
    useState<TerminateMoveOutFormData | null>(null);

  // [A2] KHÔNG auto-fill credit vào "Tiền phòng thừa" nữa.
  //
  // Trước đây ô này tự điền = credit của khách, nên MỌI hợp đồng có credit đều
  // gửi excess_rent > 0 lên server mà người dùng không hề gõ. Server lại từ chối
  // vì tính năng áp credit (customer.credit.apply.v1) đang ở chế độ SHADOW —
  // đo được: 30 hợp đồng ACTIVE / 6.695.284đ credit KHÔNG thanh lý được theo
  // luồng mặc định, và khi lỗi xảy ra hệ thống không để lại dấu vết nào.
  //
  // Để mặc định 0 thì thanh lý chạy bình thường, khoản dư giữ nguyên trên sổ
  // credit và xử lý riêng. Người dùng vẫn gõ tay được nếu tính năng được bật.

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

  // Phép quyết toán nằm ở lib/terminationSettlement — MỘT nguồn sự thật, có
  // property test, và soi gương đúng phần toán trong
  // public.terminate_contract_move_out_impl. Màn xác nhận nói con số nào thì
  // server phải ghi đúng con số đó, vì thao tác này không hoàn tác được.
  const totalDeductions = outstandingDebt + extraTotal;
  const settlement = useMemo(
    () =>
      computeTerminationSettlement({
        depositPaid,
        depositRefundRequested: depositRefund,
        excessRent,
        outstandingDebt,
        extraChargesTotal: extraTotal,
        customerRefundTotal: refundTotal,
      }),
    [depositPaid, depositRefund, excessRent, outstandingDebt, extraTotal, refundTotal],
  );
  const settlementAmount = settlement.net;

  const onSubmit = (data: TerminateMoveOutFormData) => {
    setPendingData(data);
    setConfirmOpen(true);
  };

  const doTerminate = async () => {
    if (!pendingData) return;
    setConfirmOpen(false);
    try {
      await onSettle({
        depositRefund: pendingData.deposit_refund,
        excessRent: pendingData.excess_rent,
        outstandingDebt,
        notes: pendingData.notes,
        extraCharges,
        refundItems,
        shortfallMode,
        receiptAccountId: receiptAccountId || null,
      });
      onClose();
    } catch { /* Mutation reports the error; keep settlement inputs. */ }
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
                    Ngày trả phòng đã xác nhận
                  </FormLabel>
                  <FormControl>
                    <DateInput
                      value={field.value || ""}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      name={field.name}
                      className="h-8 text-sm"
                      disabled
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
                      disabled={!!brokerFee}
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
                  {/* Dòng chữ cũ nói tính năng "chưa được kích hoạt" đã SAI từ
                      28/07/2026: migration 20260728150000 đặt
                      customer.credit.apply.v1 sang mode=ON và route CANONICAL cho
                      cả hai org. Nó đang bảo người dùng rằng một ô chạy được là
                      vô dụng. */}
                  {creditBalance > 0 ? (
                    <p className="text-[11px] text-blue-700">
                      Khách đang có <b>{formatVND(creditBalance)}đ</b> credit (tiền
                      trả dư). Nhập tối đa bằng số đó để cấn vào quyết toán; phần
                      không nhập vẫn treo trên hợp đồng sau khi thanh lý.
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      Hợp đồng này không có tiền trả dư — để trống. Muốn trả lại
                      tiền phòng những ngày khách không ở thì dùng mục{" "}
                      <b>Hoàn lại khách</b> bên dưới.
                    </p>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* Section 3b: Thu thêm — vào HOÁ ĐƠN THANH LÝ RIÊNG (kind SETTLEMENT,
            đúng kỳ tháng trả phòng), KHÔNG đụng hoá đơn tiền phòng của tháng. */}
        <div className="border-t pt-4">
          {brokerFee && <div className="mb-3 rounded border p-3 text-sm">
            <p>Phí nhượng qua môi giới · 50% cọc cũ: <strong>{formatVND(brokerFee.amount)} đ</strong></p>
            <p className="text-xs text-muted-foreground">Đã cộng một lần vào khoản thu khi thanh lý. Các khoản khác xử lý như hiện tại.</p>
          </div>}
          <TerminationExtraCharges
            contract={contract}
            chargeDate={form.watch("move_out_date")}
            onChange={setExtraCharges}
          />
          {extraTotal > 0 && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              <ReceiptText className="h-4 w-4 mt-0.5 shrink-0" />
              <p>
                Các khoản này vào <strong>hoá đơn thanh lý riêng</strong> (kỳ tháng
                trả phòng) và được khấu trừ vào cọc — <strong>không</strong> sửa hoá
                đơn tiền phòng hằng tháng.
              </p>
            </div>
          )}
        </div>

        {/* Section 3c: Hoàn lại khách — vế ngược của "Thu thêm". Chỉ có ở nhánh
            rời phòng; nhánh bỏ cọc không có mục này (bút toán bỏ cọc bị
            guard_termination_forfeit_voucher_v1 khoá cứng). */}
        <div className="border-t pt-4">
          <TerminationRefundItems
            contract={contract}
            moveOutDate={form.watch("move_out_date")}
            onChange={setRefundItems}
          />
          {refundTotal > 0 && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
              <Undo2 className="h-4 w-4 mt-0.5 shrink-0" />
              <p>
                {settlement.owedApplied > 0 ? (
                  <>
                    <strong>{formatVND(settlement.owedApplied)} đ</strong> được{" "}
                    <strong>cấn thẳng vào công nợ</strong> (không ra tiền mặt)
                    {settlement.refundOwed > 0 ? (
                      <>
                        , còn <strong>{formatVND(settlement.refundOwed)} đ</strong>{" "}
                        chi trả khách trên phiếu hoàn.
                      </>
                    ) : (
                      "."
                    )}
                  </>
                ) : (
                  <>
                    <strong>{formatVND(refundTotal)} đ</strong> cộng vào phiếu chi
                    hoàn khách. Khoản này <strong>giảm lợi nhuận</strong> — khác
                    hoàn cọc (tiền giữ hộ, ngoài KQKD).
                  </>
                )}
              </p>
            </div>
          )}
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
                <span className="text-muted-foreground">Hoàn lại khách</span>
                <span className="font-medium tabular-nums text-emerald-600">
                  {formatVND(refundTotal)} đ
                </span>
              </div>
              {refundItems
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
                  <span className="flex-1">
                    <b>Khách đã trả đủ {formatVND(Math.abs(settlementAmount))}đ</b>{" "}
                    khi rời phòng — ghi nhận thu ngay.
                    {shortfallMode === "PAID" && (
                      <span className="mt-2 block" onClick={(e) => e.preventDefault()}>
                        <span className="text-xs text-muted-foreground block mb-1">
                          Sổ nhận tiền (tiền thật vào két nào)
                        </span>
                        <Select
                          value={receiptAccountId || "auto"}
                          onValueChange={(v) =>
                            setReceiptAccountId(v === "auto" ? "" : v)
                          }
                        >
                          <SelectTrigger className="h-8 text-sm bg-white">
                            <SelectValue placeholder="Tự chọn sổ Thu của bạn" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">
                              Tự chọn (sổ Thu của bạn)
                            </SelectItem>
                            {realAccounts.map((a) => (
                              <SelectItem key={a.id} value={a.id}>
                                {a.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </span>
                    )}
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
                {refundTotal > 0 && (
                  <>
                    <div className="flex justify-between">
                      <span>Hoàn lại khách</span>
                      <b className="tabular-nums">{formatVND(refundTotal)} đ</b>
                    </div>
                    {settlement.owedApplied > 0 && (
                      <div className="flex justify-between pl-4 text-xs text-muted-foreground">
                        <span>· cấn vào công nợ (không ra tiền mặt)</span>
                        <span className="tabular-nums">
                          {formatVND(settlement.owedApplied)} đ
                        </span>
                      </div>
                    )}
                    {settlement.refundOwed > 0 && (
                      <div className="flex justify-between pl-4 text-xs text-muted-foreground">
                        <span>· chi trả khách (giảm lợi nhuận)</span>
                        <span className="tabular-nums">
                          {formatVND(settlement.refundOwed)} đ
                        </span>
                      </div>
                    )}
                  </>
                )}
                {/* [A2] Sau khi bỏ auto-fill, excessRent mặc định = 0 nên màn
                    hình xác nhận cuối cùng sẽ KHÔNG nhắc gì tới credit của
                    khách. Với thao tác không hoàn tác được, phải nói rõ khoản
                    đó không nằm trong quyết toán này. */}
                {creditBalance > excessRent && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900">
                    Khách còn{" "}
                    <b>{formatVND(creditBalance - excessRent)} đ</b> tiền trả dư
                    (credit) KHÔNG nằm trong quyết toán này. Sau khi thanh lý,
                    khoản đó vẫn treo trên hợp đồng và phải hoàn hoặc cấn trừ
                    thủ công.
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
