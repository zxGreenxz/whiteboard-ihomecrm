import { useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DIALOG_SCROLL_BODY,
  DIALOG_STICKY_FOOTER,
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
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

import { transferRoomFormSchema } from "@/lib/contractValidation";
import type { TransferRoomFormData } from "@/lib/contractValidation";
import type { ContractWithRelations } from "@/types/contract";
import { useTransferRoom } from "@/hooks/useContractOperations";
import { useRooms } from "@/hooks/useRooms";
import { vnTodayISO } from '@/lib/vnDate';
import { useRoomTransferQuote } from "@/hooks/useRoomTransferQuote";
import type { RoomTransferQuote } from "@/lib/contract-lifecycle/roomTransferQuote";
import { isTransferRoomUnavailable, transferRoomFeedback } from "@/lib/contract-lifecycle/transferRoomFeedback";
import { locPhongChuyenDuoc } from "@/lib/contractRoomFilter";
import { isCommissionReasonValid, COMMISSION_REASON_MESSAGE, COMMISSION_REASON_MAX } from '@/lib/commissionAudit';

const dong = (value: number) => `${value.toLocaleString("vi-VN")} đ`;
const ngay = (value: string) => value.split("-").reverse().join("/");

function TransferAmounts({ quote }: { quote: RoomTransferQuote }) {
  const rows = [
    ["Cọc thực giữ", dong(quote.held_deposit)],
    ...(quote.deposit_shortfall > 0 ? [["Cọc cần bổ sung", dong(quote.deposit_shortfall)]]
      : quote.deposit_surplus > 0 ? [["Cọc dư tiếp tục giữ", dong(quote.deposit_surplus)]] : [["Cọc cần bổ sung", dong(0)]]),
    ...(quote.deposit_invoiced_shortfall ? [
      ["Phần cọc thu qua hóa đơn đã lập", dong(quote.deposit_invoiced_shortfall)],
      ["Phần cọc chưa có trên hóa đơn", dong(quote.deposit_unbilled_shortfall ?? 0)],
    ] : []),
    ...(quote.rent_override ? [
      ...(quote.scheduled_rent === undefined ? [] : [["Tiền thuê theo số ngày ở từng phòng", dong(quote.scheduled_rent)]]),
      ["Điều chỉnh đã có trên hóa đơn", `${quote.rent_override > 0 ? "+" : "−"}${dong(Math.abs(quote.rent_override))}`],
    ] : []),
    ["Tiền thuê cả kỳ", dong(quote.period_rent)],
    ["Tiền thuê đã lập hóa đơn", dong(quote.billed_rent)],
    ...(quote.invoice_id ? [[quote.rent_delta === 0 ? "Chênh lệch" : quote.rent_delta < 0 ? "Điều chỉnh giảm" : "Điều chỉnh tăng", dong(Math.abs(quote.rent_delta))]] : []),
    ...(quote.invoice_id && quote.remaining_after !== undefined ? [["Còn phải thu trên hóa đơn", dong(quote.remaining_after)]] : []),
    ...(quote.refund_pending ? [["Tiền thuê hoàn khách chờ duyệt", dong(quote.refund_pending)]] : []),
  ];
  return (
    <section aria-label="Đối chiếu tiền khi chuyển phòng" className="rounded-md border bg-muted/40 p-3 text-sm">
      <h3 className="font-medium">Kỳ chuyển phòng {ngay(quote.period_start)} – {ngay(quote.period_end)}</h3>
      <p className="mt-1 text-muted-foreground">{quote.old_days} ngày trước khi chuyển · {quote.new_days} ngày ở phòng mới</p>
      <dl className="mt-3 space-y-1">
        {rows.map(([label, value]) => <div key={label} className="flex justify-between gap-3"><dt>{label}</dt><dd className="text-right font-medium tabular-nums">{value}</dd></div>)}
      </dl>
      {!quote.invoice_id && <p className="mt-2 text-muted-foreground">Kỳ này chưa có hóa đơn. Tiền thuê trên sẽ dùng khi lập hóa đơn cho kỳ chuyển phòng.</p>}
      {quote.invoice_id && quote.rent_delta < 0 && <p className="mt-2 text-muted-foreground">Tiền thuê giảm sẽ trừ vào phần chưa thu. Phần khách đã trả vượt sẽ được ghi vào khoản hoàn tiền thuê chờ duyệt.</p>}
      {quote.deposit_shortfall > 0 && <p className="mt-2 text-muted-foreground">{quote.deposit_invoiced_shortfall
        ? "Thu phần cọc đã có trên hóa đơn qua chính hóa đơn đó. Khi nhận phần còn thiếu, lập phiếu thu cọc cho hợp đồng."
        : "Khi khách nộp thêm cọc, ghi nhận khoản thực thu trong hợp đồng."}</p>}
    </section>
  );
}

interface TransferRoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: ContractWithRelations;
}

export function TransferRoomDialog({
  open,
  onOpenChange,
  contract,
}: TransferRoomDialogProps) {
  const transferRoom = useTransferRoom();
  return (
    <Dialog open={open} onOpenChange={next => { if (!transferRoom.isPending) onOpenChange(next); }}>
      <DialogContent className={`sm:max-w-lg ${DIALOG_SCROLL_BODY}`} hideClose={transferRoom.isPending}>
        <DialogHeader>
          <DialogTitle>Chuyển phòng</DialogTitle>
          <DialogDescription>
            Chọn phòng trống trong cùng tòa nhà. Nếu khách đổi tòa, hãy thanh lý hợp đồng hiện tại rồi lập hợp đồng mới.
          </DialogDescription>
        </DialogHeader>
        {open && <TransferRoomForm key={contract.id} open={open} contract={contract} transferRoom={transferRoom} onOpenChange={onOpenChange} />}
      </DialogContent>
    </Dialog>
  );
}

function TransferRoomForm({
  open, onOpenChange, contract, transferRoom,
}: TransferRoomDialogProps & { transferRoom: ReturnType<typeof useTransferRoom> }) {
  const buildingId = contract.room?.building_id ?? contract.room?.building?.id;
  const rooms = useRooms(buildingId, { enabled: open && !!buildingId });
  const [unavailableRooms, setUnavailableRooms] = useState<string[]>([]);
  const availableRooms = useMemo(
    () => locPhongChuyenDuoc(rooms.data ?? [], buildingId, contract.room_id).filter(room => !unavailableRooms.includes(room.id)),
    [rooms.data, buildingId, contract.room_id, unavailableRooms],
  );
  const [expectedUpdatedAt] = useState(contract.updated_at);
  const contractChanged = expectedUpdatedAt !== contract.updated_at;
  const noticeRequest = useRef<{ intent: string; id: string } | null>(null);
  const form = useForm<TransferRoomFormData>({
    resolver: zodResolver(transferRoomFormSchema),
    defaultValues: { new_room_id: "", new_required_deposit: contract.total_deposit, transfer_date: vnTodayISO(), notes: "" },
  });

  const selectedRoom = form.watch("new_room_id");
  const selectedRoomAvailable = availableRooms.some(room => room.id === selectedRoom);
  const canChooseRoom = !!buildingId && !rooms.isError && !rooms.isLoading && availableRooms.length > 0;
  const [rent, deposit, date] = form.watch(["new_rent_price", "new_required_deposit", "transfer_date"]);
  const quoteInput = useMemo(() => canChooseRoom && selectedRoomAvailable && !contractChanged && date
    && Number.isSafeInteger(deposit) && deposit >= 0 && (rent === undefined || (Number.isSafeInteger(rent) && rent >= 0))
    ? {contractId: contract.id, newRoomId: selectedRoom, transferDate: date, newRentPrice: rent, newDeposit: deposit}
    : null, [canChooseRoom, selectedRoomAvailable, contractChanged, date, deposit, rent, contract.id, selectedRoom]);
  const quote = useRoomTransferQuote(quoteInput);
  const transferOutcome = transferRoom.isError && transferRoom.variables?.contractId === contract.id
    ? transferRoomFeedback(transferRoom.error).outcome : undefined;
  const pendingResult = transferOutcome === "partial" || transferOutcome === "unknown";
  const previewError = quote.isError ? transferRoomFeedback(quote.error) : null;
  // Đợt 7: kết quả chưa rõ không khoá nút. Lần bấm sau tự đối chiếu theo mã yêu cầu của lần trước (đã chuyển thì báo kết
  // quả, chưa thì gửi lại đúng mã đó; máy chủ khoá hợp đồng rồi mới tra mã nên không chuyển hai lần).
  const canSubmit = !!quoteInput && !!quote.data && !transferRoom.isPending;

  const onSubmit = (data: TransferRoomFormData) => {
    if (!canSubmit || !quote.data) return;
    if (!isCommissionReasonValid(data.notes)) {
      form.setError("notes", { message: COMMISSION_REASON_MESSAGE }, { shouldFocus: true });
      return;
    }
    const params = {
      contractId: contract.id,
      expectedUpdatedAt,
      newRoomId: data.new_room_id,
      newRentPrice: data.new_rent_price,
      newDeposit: data.new_required_deposit,
      quoteKey: quote.data.quote_key,
      transferDate: data.transfer_date,
      notes: data.notes,
      noticeReason: data.notes?.trim(),
    };
    const intent = JSON.stringify(params);
    if (noticeRequest.current?.intent !== intent) noticeRequest.current = { intent, id: crypto.randomUUID() };
    transferRoom.mutate(
      { ...params, requestId: noticeRequest.current.id },
      {
        onSuccess: () => onOpenChange(false),
        onError: error => {
          if (isTransferRoomUnavailable(error)) {
            setUnavailableRooms(previous => [...previous, data.new_room_id]);
          }
        },
      },
    );
  };

  // Current contract info for display
  const currentBuilding = contract.room?.building?.name || "—";
  const currentRoom = contract.room?.name || "—";
  const representativeCustomer = contract.contract_customers?.find(
    (cc) => cc.is_representative
  );
  const currentCustomer = representativeCustomer?.customer?.full_name || "—";

  return (
    <>
      {/* Current contract info */}
      <div className="rounded-md border p-3 bg-muted/50 space-y-1 text-sm">
        <p>
          <span className="font-medium">Khách hàng:</span> {currentCustomer}
        </p>
        <p>
          <span className="font-medium">Toà nhà:</span> {currentBuilding}
        </p>
        <p>
          <span className="font-medium">Phòng:</span> {currentRoom}
        </p>
        <p>
          <span className="font-medium">Giá thuê hiện tại:</span>{" "}
          {contract.rent_price?.toLocaleString("vi-VN")} đ
        </p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            control={form.control}
            name="new_room_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Phòng mới <span className="text-red-500">*</span></FormLabel>
                <FormControl>
                  <select
                    {...field}
                    onChange={event => {
                      const room = availableRooms.find(candidate => candidate.id === event.target.value);
                      field.onChange(event);
                      form.setValue("new_required_deposit", room?.deposit_amount ?? contract.total_deposit);
                    }}
                    value={selectedRoomAvailable ? field.value : ""}
                    disabled={!canChooseRoom || contractChanged || transferRoom.isPending}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
                  >
                    <option value="">Chọn phòng</option>
                    {availableRooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}
                  </select>
                </FormControl>
                {!buildingId ? <p role="alert">Chưa xác định được tòa nhà của hợp đồng. Hãy tải lại hợp đồng.</p>
                  : rooms.isError ? <div role="alert" className="text-sm">Không tải được danh sách phòng.
                    <Button type="button" variant="link" onClick={() => void rooms.refetch()}>Thử lại</Button></div>
                  : rooms.isLoading ? <p role="status" className="text-sm">Đang tải danh sách phòng…</p>
                  : selectedRoom && !selectedRoomAvailable ? <p role="alert" className="text-sm">Phòng đã chọn không còn trống. Vui lòng chọn phòng khác.</p>
                  : !availableRooms.length && <p className="text-sm">Tòa nhà này hiện không có phòng trống để chuyển đến.</p>}
                <FormMessage />
              </FormItem>
            )}
          />

          {/* New rent price */}
          <FormField
            control={form.control}
            name="new_rent_price"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Giá thuê mới</FormLabel>
                <FormControl>
                  <CurrencyInput
                    placeholder="Giữ nguyên nếu không thay đổi"
                    value={field.value}
                    onChange={field.onChange}
                    onClear={() => field.onChange(undefined)}
                    onBlur={field.onBlur}
                    name={field.name}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="new_required_deposit"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Tiền cọc yêu cầu ở phòng mới</FormLabel>
                <FormControl>
                  <CurrencyInput
                    {...field}
                    showZero
                    onClear={() => field.onChange(undefined)}
                    disabled={!selectedRoomAvailable || transferRoom.isPending}
                    placeholder="Nhập số tiền cọc"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Transfer date */}
          <FormField
            control={form.control}
            name="transfer_date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Ngày chuyển <span className="text-red-500">*</span>
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

          {quoteInput && (quote.isError ? <div role="alert" className="text-sm text-destructive">
            {isTransferRoomUnavailable(quote.error) ? "Phòng đã chọn không còn trống. Vui lòng chọn phòng khác." : "Chưa xem trước được cọc và tiền thuê."}
            {previewError?.code && !isTransferRoomUnavailable(quote.error) && <p>{previewError.description}</p>}
            <Button type="button" variant="link" onClick={() => void quote.refetch()}>Tải lại số liệu</Button>
          </div> : quote.data ? <TransferAmounts quote={quote.data} />
            : <p role="status" className="text-sm text-muted-foreground">Đang tính cọc và tiền thuê kỳ chuyển phòng…</p>)}

          {/* Notes */}
          <FormField
            control={form.control}
            name="notes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Lý do chuyển phòng / thay đổi căn cứ hoa hồng *</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="Ghi chú chuyển phòng..."
                    maxLength={COMMISSION_REASON_MAX}
                    rows={3}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {contract.expected_move_out_date&&<p className="rounded border p-3 text-sm">Báo dọn ngày {contract.expected_move_out_date.split('-').reverse().join('/')} của phòng cũ sẽ được hủy khi chuyển phòng thành công. Phòng mới chưa có ngày báo dọn; bạn có thể ghi nhận riêng sau khi chuyển.</p>}
          {contractChanged && <p role="alert" className="text-sm text-destructive">Hợp đồng đã thay đổi. Hãy đóng biểu mẫu và mở lại để kiểm tra thông tin mới.</p>}
          {pendingResult && <div role="alert" className="rounded-md border p-3 text-sm">
            <p>Chưa xác nhận được kết quả lần chuyển trước. Bấm «Chuyển phòng» để hệ thống đối chiếu yêu cầu đã gửi: đã chuyển thì báo kết quả, chưa thì gửi lại đúng yêu cầu đó, không chuyển hai lần.</p>
          </div>}
          <DialogFooter className={DIALOG_STICKY_FOOTER}>
            <Button
              type="button"
              variant="outline"
              className="flex-1 sm:flex-none"
              disabled={transferRoom.isPending}
              onClick={() => onOpenChange(false)}
            >
              Hủy
            </Button>
            <Button type="submit" className="flex-1 sm:flex-none" disabled={!canSubmit}>
              {transferRoom.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Chuyển phòng
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </>
  );
}
