import {runFinancialPending} from '@/lib/financialPendingAction';
import {useOrganization} from '@/contexts/OrganizationContext';
import {VoucherPartialError} from '@/lib/voucherFeedback';
import {QueryRegion} from '@/components/errors/QueryRegion';
import { focusFirstError } from "@/lib/formErrors";
import { reservationErrorMessage } from "@/lib/reservationIdentityRpc";
import { voucherFailureMessage, voucherOutcomeUnknown } from "@/lib/voucherFeedback";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertTriangle } from "lucide-react";
import AttachmentUpload from "@/components/income-expenses/AttachmentUpload";
import { getSessionUser } from "@/lib/authSession";
import { useCreateRoomReservation } from "@/hooks/useRoomReservations";
import { CustomerSelectionDialog, type CustomerBasic } from "@/components/contracts/CustomerSelectionDialog";
import type { CreateRoomReservationInput } from "@/lib/reservationIdentityRpc";
import { useCreateSaleBonusFromDeposit } from "@/hooks/useSaleBonus";
import { useSetReservationHoldTerms } from "@/hooks/useReservationHoldDeadlines";
import { useRooms } from "@/hooks/useRooms";
import { useAccounts } from "@/hooks/useAccounts";
import { todayISO } from '@/lib/collect';
import { diffDaysISO } from "@/lib/vnDate";
import { formatCurrency } from "@/lib/utils";

/**
 * Dialog "Tạo đặt cọc" — tạo CỌC GIỮ CHỖ thật, ghi vào income_expenses (phiếu
 * thu cọc), KHÔNG ghi vào bảng `deposits` (đã bỏ). Cùng cơ chế với
 * QuickDepositModal ở trang Phòng trống để đồng nhất 1 nguồn dữ liệu:
 * type=INCOME, contract_id=NULL, item hạng mục "Tiền Cọc" (is_deposit=TRUE).
 * Trigger recompute_room_reservation tự set rooms.status='RESERVED'.
 */

/** "2026-06-08" -> "08/06/2026". */
function fmtVNDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/**
 * Nhãn "Giá thoả thuận" ghi vào description của item cọc.
 *
 * VÌ SAO LÀ GHI CHÚ CÓ CẤU TRÚC CHỨ KHÔNG PHẢI CỘT (quyết định của chủ
 * 21/08/2026): giá phòng lúc đặt cọc chưa phải giá hợp đồng — hợp đồng mới là
 * nơi chốt giá, và nó có cột riêng cho việc đó. Ở phiếu cọc, con số này chỉ để
 * người thu cọc và người ký hợp đồng sau đó nhìn thấy điều đã hứa với khách.
 * Vì thế chỉ ghi khi người dùng SỬA khác giá niêm yết: giá bằng đúng niêm yết
 * thì viết ra là lặp lại thứ đã có ở hồ sơ phòng.
 */
const AGREED_PRICE_PREFIX = "Giá thoả thuận: ";

const depositSchema = z.object({
  customer_id: z.string().min(1, "Phải chọn khách hàng cụ thể"),
  room_id: z.string().min(1, "Chọn phòng giữ chỗ"),
  /** Giá phòng/tháng — mặc định lấy giá niêm yết của căn hộ, sửa được. */
  room_price: z.number().min(0, "Giá phòng phải >= 0").optional(),
  amount: z.number().min(0, "Số tiền phải >= 0"),
  deposit_date: z.string().min(1, "Ngày đặt cọc là bắt buộc"),
  hold_until: z.string().optional(),
  intended_move_in_on: z.string().optional(),
  /**
   * Cọc PHẢI ĐỦ, và hạn khách phải bổ sung cho đủ.
   *
   * Ca chủ nêu 22/08/2026: phòng 5tr, thu 2tr ngày 22/08, phải đủ 5tr trước
   * 25/08, nhận phòng 29/08 — quá 25/08 chưa đủ thì huỷ phiếu và mất cọc.
   * Đây là mốc KHÁC `hold_until`: lỡ nó là khách mất TIỀN, lỡ `hold_until` là
   * chủ mất PHÒNG.
   */
  deposit_target: z.number().min(0).optional(),
  topup_due_date: z.string().optional(),
  ctv_name: z.string().optional(),
  notes: z.string().optional(),
  // Sổ quỹ ghi cọc — BẮT BUỘC chọn (quyết định chủ 20/08/2026). Trước đây dialog
  // tự chọn ngầm: cọc > 1đ lấy sổ mặc định của người tạo, còn lại lấy sổ CỌC ảo.
  // Chọn ngầm nghĩa là tiền vào sổ nào không ai để ý cho tới lúc đối chiếu.
  account_id: z.string(),
  // Thưởng nóng Sale — tuỳ chọn, tạo ngay cùng lúc với phiếu cọc.
  sale_bonus_amount: z.coerce.number().min(0).optional(),
  sale_bonus_recipient: z.string().optional(),
  sale_bonus_account_id: z.string().optional(),
  sale_bonus_account_number: z.string().optional(),
  sale_bonus_bank: z.string().optional(),
}).superRefine((value,ctx)=>{
  if(value.amount===0&&!value.hold_until)ctx.addIssue({code:'custom',path:['hold_until'],message:'Giữ chỗ chưa nhận tiền phải chọn hạn giữ chỗ'});
  if(value.amount>0&&!value.account_id)ctx.addIssue({code:'custom',path:['account_id'],message:'Phải chọn sổ quỹ ghi cọc'});
  if(value.amount===0&&(value.sale_bonus_amount??0)>0)ctx.addIssue({code:'custom',path:['sale_bonus_amount'],message:'Giữ chỗ 0 đồng chưa có phiếu cọc để thưởng Sale'});
});

type DepositFormValues = z.infer<typeof depositSchema>;

interface CreateDepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateDepositDialog({ open, onOpenChange }: CreateDepositDialogProps) {
  const queryClient = useQueryClient();
  const {selectedOrganizationId}=useOrganization();
  const [customer, setCustomer] = useState<CustomerBasic | null>(null);
  const [customerPicker, setCustomerPicker] = useState(false);
  const intent = useRef<{fingerprint:string;key:string}|null>(null);
  const formRoot = useRef<HTMLFormElement>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<{reservationId:string;voucherIds:string[]}|null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  // Ảnh chứng từ giữ ngoài react-hook-form: AttachmentUpload đã tự quản lý
  // upload/xoá trên storage và chỉ trả về mảng URL — cùng khuôn CommissionVoucherModal.
  const [depositAttachments, setDepositAttachments] = useState<string[]>([]);
  const [bonusAttachments, setBonusAttachments] = useState<string[]>([]);

  const createReservation = useCreateRoomReservation({silent:true});
  const createSaleBonus = useCreateSaleBonusFromDeposit();
  const setHoldTerms = useSetReservationHoldTerms({silent:true});
  const roomsQuery=useRooms(undefined, { enabled: open });
  const {data:rooms=[]}=roomsQuery;
  const accountsQuery=useAccounts({ enabled: open });
  const {data:accounts=[]}=accountsQuery;

  useEffect(() => {
    let active = true;
    getSessionUser().then((u) => {
      if (active) setMyUserId(u?.id ?? null);
    });
    return () => {
      active = false;
    };
  }, []);

  // Sổ quỹ xếp sổ của chính mình lên trước — người thu cọc hầu như luôn ghi vào
  // sổ mình giữ, nhưng vẫn thấy đủ sổ khác (kể cả sổ CỌC ảo) để chọn tay.
  const sortedAccounts = useMemo(() => {
    const mine = accounts.filter((a) => a.user_id === myUserId);
    const others = accounts.filter((a) => a.user_id !== myUserId);
    return [...mine, ...others];
  }, [accounts, myUserId]);

  const form = useForm<DepositFormValues>({
    shouldFocusError: false,
    resolver: zodResolver(depositSchema),
    defaultValues: {
      customer_id: "",
      room_id: "",
      room_price: 0,
      amount: 0,
      deposit_date: todayISO(),
      hold_until: "",
      intended_move_in_on: "",
      deposit_target: 0,
      topup_due_date: "",
      ctv_name: "",
      notes: "",
      account_id: "",
      sale_bonus_amount: 0,
      sale_bonus_recipient: "",
      sale_bonus_account_id: "",
      sale_bonus_account_number: "",
      sale_bonus_bank: "",
    },
  });

  // ── Giá phòng: mặc định hệ thống, sửa tay thì đánh dấu ────────────────────
  const selectedRoomId = form.watch("room_id");
  const depositDate = form.watch("deposit_date");
  const holdUntil = form.watch("hold_until");
  const roomPrice = form.watch("room_price") ?? 0;

  const listedPrice = useMemo(() => {
    const room = rooms.find((r) => r.id === selectedRoomId);
    return Number((room as { rent_price?: number } | undefined)?.rent_price) || 0;
  }, [rooms, selectedRoomId]);

  // Đổi phòng thì kéo lại giá niêm yết của phòng MỚI. Giữ nguyên số cũ ở đây sẽ
  // im lặng gán giá phòng này cho phòng khác — đúng loại lỗi không ai phát hiện
  // cho tới lúc ký hợp đồng.
  useEffect(() => {
    if (!selectedRoomId) return;
    form.setValue("room_price", listedPrice, { shouldDirty: false });
  }, [selectedRoomId, listedPrice, form]);

  const priceEdited = listedPrice > 0 && Math.round(roomPrice) !== Math.round(listedPrice);

  // ── Hạn phải làm hợp đồng suy ra từ "giữ phòng đến" ───────────────────────
  const holdDays = diffDaysISO(holdUntil || null, depositDate || null);

  // ── Cọc cần đủ + hạn bổ sung ───────────────────────────────────────────────
  const depositTarget = form.watch("deposit_target") ?? 0;
  const topupDue = form.watch("topup_due_date");
  const amountNow = form.watch("amount") ?? 0;

  // Mặc định "cọc cần đủ" = giá phòng (lệ cọc một tháng), sửa được. Đổi phòng
  // thì kéo lại theo phòng MỚI, cùng lý do với ô giá phòng.
  useEffect(() => {
    if (!selectedRoomId) return;
    form.setValue("deposit_target", listedPrice, { shouldDirty: false });
  }, [selectedRoomId, listedPrice, form]);

  const conThieu = Math.max(0, Math.round(depositTarget) - Math.round(amountNow));
  const topupDays = diffDaysISO(topupDue || null, depositDate || null);
  // Bổ sung sau khi phòng đã nhả khoá là vô nghĩa — writer cũng chặn, nhưng nói
  // ngay tại form thì người nhập sửa được trước khi bấm lưu.
  const topupSauHold =
    !!topupDue && !!holdUntil && (diffDaysISO(topupDue, holdUntil) ?? 0) > 0;

  const onSubmit = async (data: DepositFormValues) => {
    if (submitting || completed || uncertain || roomsQuery.isError || roomsQuery.isLoading || accountsQuery.isError || accountsQuery.isLoading) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const room = rooms.find((r) => r.id === data.room_id);
      if (!room) throw new Error("Không tìm thấy căn hộ");
      const buildingId = room.building_id ?? room.building?.id;
      if (!buildingId) throw new Error("Căn hộ chưa gắn toà nhà");

      // Sổ quỹ do người tạo CHỌN (quyết định chủ 20/08/2026) — không còn đường
      // tự lấy sổ mặc định / sổ CỌC ảo ngầm. Giữ chỗ 0 đồng không cần sổ.
      const accId: string = data.account_id;
      if (data.amount>0&&!accId) {
        throw new Error("Chưa chọn sổ quỹ ghi cọc.");
      }

      const roomLabel = room.code || room.name;
      const buildingName = room.building?.name ?? "";
      const name = `Cọc giữ chỗ phòng ${roomLabel}${
        buildingName ? ` - ${buildingName}` : ""
      }`;
      const extras: string[] = [];
      if (data.hold_until) extras.push(`Giữ phòng đến ${fmtVNDate(data.hold_until)}`);
      // Chỉ ghi khi KHÁC giá niêm yết — xem chú thích AGREED_PRICE_PREFIX.
      const listed = Number((room as { rent_price?: number }).rent_price) || 0;
      const agreed = Number(data.room_price) || 0;
      if (agreed > 0 && Math.round(agreed) !== Math.round(listed)) {
        extras.push(
          `${AGREED_PRICE_PREFIX}${Math.round(agreed).toLocaleString("vi-VN")}đ/tháng` +
            (listed > 0 ? ` (niêm yết ${Math.round(listed).toLocaleString("vi-VN")}đ)` : ""),
        );
      }
      if (data.ctv_name) extras.push(`CTV: ${data.ctv_name}`);
      if (data.notes) extras.push(data.notes);
      const itemDesc = extras.length ? extras.join(" · ") : null;

      const input:Omit<CreateRoomReservationInput,'idempotencyKey'>={
        roomId:data.room_id,customerId:data.customer_id,holdUntil:data.hold_until||null,
        intendedMoveInOn:data.intended_move_in_on||null,topupDueOn:data.topup_due_date||null,depositTarget:data.deposit_target??null,notes:data.notes||null,
        ...(data.amount>0?{receipt:{amount:data.amount,accountId:accId,voucherDate:data.deposit_date,name,description:itemDesc,attachments:depositAttachments}}:{}),
      };
      const fingerprint=JSON.stringify(input);
      if(intent.current?.fingerprint!==fingerprint)intent.current={fingerprint,key:`room-reservation-${crypto.randomUUID()}`};
      await runFinancialPending({namespace:"deposit-create",userId:myUserId??"",organizationId:selectedOrganizationId??"",businessKey:data.room_id},async progress=>{
      const createdReservation=await createReservation.mutateAsync({...input,idempotencyKey:progress.requestKey});
      progress.recordCompleted([createdReservation.id,...createdReservation.receipts.map(r=>r.source_voucher_id)]);
      const completedReceipt = {reservationId:createdReservation.id,voucherIds:createdReservation.receipts.map(r=>r.source_voucher_id)};
      setCompleted(completedReceipt);
      const partialMessages: string[] = [];

      // Thưởng nóng Sale ngay tại đây (tuỳ chọn). Cố ý tạo SAU khi phiếu cọc đã
      // có id: phiếu thưởng neo vào phiếu cọc, và chính cái neo đó là thứ giúp
      // màn hình ký hợp đồng sau này biết là "đã thưởng rồi" mà tô xám ô nhập.
      // Thưởng hỏng thì KHÔNG kéo đổ phiếu cọc — cọc là việc chính.
      const bonusAmt = Number(data.sale_bonus_amount) || 0;
      const depositId = createdReservation.receipts[0]?.source_voucher_id ?? null;

      // HẠN PHẢI LÀM HỢP ĐỒNG — ghi vào bảng chuyên trách
      // (`reservation_hold_deadlines`, migration 20260822010000). Đây mới là
      // NGUỒN SỰ THẬT mà bàn xử lý /deposits đọc để xếp nhóm "quá hạn làm HĐ";
      // chuỗi "Giữ phòng đến …" trong ghi chú phiếu vẫn giữ để người đọc phiếu
      // thấy, nhưng KHÔNG ai suy luận từ nó nữa.
      //
      // Hỏng ở đây KHÔNG được kéo đổ phiếu cọc: tiền đã thu, phiếu đã tạo. Báo
      // rõ để người dùng đặt lại hạn thay vì im lặng nuốt.
      // Chỉ ghi "cọc cần đủ" khi nó THỰC SỰ lớn hơn số vừa thu. Bằng nhau nghĩa
      // là đã đủ ngay từ đầu — ghi vào chỉ tạo ra một mốc không bao giờ dùng tới.
      const targetToSave =
        Number(data.deposit_target) > Number(data.amount)
          ? Number(data.deposit_target)
          : null;
      const topupToSave = targetToSave !== null ? data.topup_due_date || null : null;

      if ((data.hold_until || topupToSave || targetToSave !== null) && depositId) {
        try {
          await setHoldTerms.mutateAsync({
            incomeExpenseId: depositId,
            holdUntil: data.hold_until || null,
            topupDueDate: topupToSave,
            depositTarget: targetToSave,
          });
        } catch (error) {
          partialMessages.push("Đã tạo hồ sơ cọc nhưng chưa xác nhận được kỳ hạn. Mở hồ sơ đã tạo để kiểm tra hạn làm hợp đồng và hạn bổ sung cọc; không tạo lại cọc.");
          console.error("Deposit hold terms", error);
        }
      }
      if (bonusAmt > 0 && depositId) {
        try {
          const r = await createSaleBonus.mutateAsync({
            depositVoucherId: depositId,
            amount: bonusAmt,
            recipient: data.sale_bonus_recipient || undefined,
            accountNumber: data.sale_bonus_account_number || undefined,
            bank: data.sale_bonus_bank || undefined,
            accountId: data.sale_bonus_account_id || null,
            attachments: bonusAttachments,
          });
          if (!r?.voucherId) throw new TypeError("Chưa nhận được mã phiếu thưởng Sale");
          completedReceipt.voucherIds.push(r.voucherId);
          progress.recordCompleted([r.voucherId]);
          setCompleted({...completedReceipt});
        } catch (e) {
          partialMessages.push("Đã tạo hồ sơ cọc nhưng bước tạo thưởng Sale chưa hoàn tất. " + voucherFailureMessage(e, "tạo phiếu thưởng Sale") + " Kiểm tra các phiếu thưởng gắn với cọc này trước khi tạo bổ sung.");
        }
      }

      // Phòng vừa bị khoá (RESERVED) → refetch các nguồn liên quan.
      queryClient.invalidateQueries({ queryKey: ["reservation-deposits"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      queryClient.invalidateQueries({ queryKey: ["phong-trong"] });
      queryClient.invalidateQueries({ queryKey: ["orphan-deposit-vouchers"] });

      if (partialMessages.length) {
        const message = partialMessages.join(" "); throw new VoucherPartialError(message,[completedReceipt.reservationId,...completedReceipt.voucherIds]);
      }
      const received = createdReservation.receipts.some(r => r.received);
      toast.success(received ? "Đã lưu giữ chỗ và xác nhận khoản cọc đã thu. Mở phiếu nguồn để xem số tiền và sổ quỹ." : createdReservation.receipts.length ? "Đã lưu giữ chỗ và tạo phiếu cọc. Chưa xác nhận tiền vào quỹ; xem trạng thái phiếu nguồn." : "Đã giữ chỗ. Chưa thu tiền cọc.");
      });
      setCompleted(null);
      form.reset();
      setDepositAttachments([]);
      setBonusAttachments([]);
      setCustomer(null);
      intent.current=null;
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to create reservation deposit:", error);
      const message = error instanceof VoucherPartialError ? error.message : reservationErrorMessage(error); setSubmitError(message); toast.error(message); if (voucherOutcomeUnknown(error)) setUncertain(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Giữ chỗ / Tạo phiếu cọc</DialogTitle>
          <DialogDescription>
            Chọn khách cụ thể. Số tiền 0 chỉ giữ chỗ; cọc dương tạo phiếu nguồn theo luồng hiện tại. Quá hạn nhắc xử lý, không tự nhả phòng.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
          <Form {...form}>
            <form ref={formRoot} onSubmit={form.handleSubmit(onSubmit, errors => void focusFirstError(errors, {root:formRoot.current,order:["customer_id","room_id","room_price","amount","deposit_date","hold_until","account_id","sale_bonus_amount"]}))} className="space-y-4">
              {submitError && <div role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{submitError}</div>}
              {completed && <div className="rounded-md border p-3 text-sm"><p>Hồ sơ đã tạo. Kiểm tra trước khi bổ sung bước còn thiếu.</p><a className="underline" href="/deposits">Mở Quản lý cọc</a>{completed.voucherIds.map(id=><a key={id} className="block underline" href={`/income-expense/voucher/${id}`}>Mở phiếu {id}</a>)}</div>}
              <FormField control={form.control} name="customer_id" render={()=> (
                <FormItem><FormLabel>Khách hàng *</FormLabel><FormControl>
                  <Button type="button" variant="outline" onClick={()=>setCustomerPicker(true)} disabled={submitting}>
                    {customer?`${customer.full_name} · ${customer.phone}`:'Chọn khách hàng'}
                  </Button>
                </FormControl><FormMessage/></FormItem>
              )}/>

              <QueryRegion label="phòng và sổ quỹ nhận cọc" queries={[roomsQuery,accountsQuery]}>{null}</QueryRegion>
              {/* Room Selection */}
              <FormField
                control={form.control}
                name="room_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Căn hộ *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn căn hộ" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {rooms.map((room) => (
                          <SelectItem key={room.id} value={room.id}>
                            {room.building?.name ? `${room.building.name} · ` : ""}
                            {room.name} {room.code && `(${room.code})`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Giá phòng / tháng — lấy mặc định từ giá niêm yết của căn hộ.
                  Sửa tay thì đánh dấu "giá thoả thuận" và ghi vào ghi chú phiếu
                  (xem AGREED_PRICE_PREFIX): người ký hợp đồng sau đó phải nhìn
                  thấy con số đã hứa với khách, không phải nghe kể lại. */}
              <FormField
                control={form.control}
                name="room_price"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex flex-wrap items-center gap-2">
                      <FormLabel>Giá phòng / tháng</FormLabel>
                      {selectedRoomId && listedPrice > 0 && (
                        priceEdited ? (
                          <button
                            type="button"
                            onClick={() => field.onChange(listedPrice)}
                            className="rounded-md bg-orange-50 px-1.5 py-0.5 text-[10.5px] font-bold text-orange-600 hover:bg-orange-100"
                          >
                            giá thoả thuận · về mặc định ✕
                          </button>
                        ) : (
                          <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10.5px] font-bold text-emerald-700">
                            mặc định hệ thống
                          </span>
                        )
                      )}
                    </div>
                    <FormControl>
                      <CurrencyInput
                        value={field.value ?? 0}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                      />
                    </FormControl>
                    <p className="text-[11px] text-muted-foreground">
                      {!selectedRoomId
                        ? "Chọn căn hộ để lấy giá niêm yết."
                        : listedPrice > 0
                          ? `Không sửa thì lấy giá niêm yết của căn hộ (${formatCurrency(listedPrice)}).`
                          : "Căn hộ này chưa có giá niêm yết — nhập tay."}
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Deposit Info */}
              <div className="grid grid-cols-3 gap-4">
                <FormField
                  control={form.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Số tiền cọc *</FormLabel>
                      <FormControl>
                        <CurrencyInput
                          value={field.value}
                          onChange={field.onChange}
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
                  name="deposit_date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ngày đặt cọc *</FormLabel>
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

                <FormField
                  control={form.control}
                  name="hold_until"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Giữ phòng đến</FormLabel>
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
              </div>
              <FormField control={form.control} name="intended_move_in_on" render={({field})=>(
                <FormItem><FormLabel>Ngày dự kiến vào (bắt buộc nếu phòng sắp trống)</FormLabel>
                  <FormControl><DateInput value={field.value||''} onChange={field.onChange} onBlur={field.onBlur} name={field.name}/></FormControl><FormMessage/>
                </FormItem>
              )}/>
              {/* Hạn là lời nhắc. Giữ chỗ vẫn LIVE đến khi xử lý rõ ràng. */}
              {holdDays !== null && (
                <div
                  className={
                    "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[12.5px] " +
                    (holdDays < 0
                      ? "border-red-200 bg-red-50 text-red-700"
                      : "border-amber-200 bg-amber-50 text-amber-800")
                  }
                >
                  <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
                  {holdDays < 0 ? (
                    <span>
                      "Giữ phòng đến" đang <strong>trước</strong> ngày đặt cọc — kiểm tra lại hai ngày này.
                    </span>
                  ) : (
                    <span>
                      Giữ <strong>{holdDays} ngày</strong> — phải ký hợp đồng trước{" "}
                      <strong>{fmtVNDate(holdUntil!)}</strong>. Quá ngày này hồ sơ được nhắc
                      xử lý, phòng vẫn giữ cho khách đến khi hủy hoặc ký hợp đồng.
                    </span>
                  )}
                </div>
              )}

              {/* ── CỌC CẦN ĐỦ + HẠN BỔ SUNG ────────────────────────────────
                  Mốc thứ hai, KHÁC "giữ phòng đến". Ca chủ nêu 22/08/2026:
                  phòng 5tr, thu 2tr ngày 22/08, phải đủ 5tr trước 25/08, nhận
                  phòng 29/08. Lỡ mốc này là khách MẤT CỌC — nên nó phải có chỗ
                  riêng, không nhét chung vào ghi chú. */}
              <div className="rounded-lg border p-3 space-y-3">
                <div className="text-sm font-medium">
                  Cọc cần đủ &amp; hạn bổ sung{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    (để trống nếu khách đã cọc đủ ngay)
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="deposit_target"
                    render={({ field }) => (
                      <FormItem>
                        <div className="flex flex-wrap items-center gap-2">
                          <FormLabel className="text-xs">Cọc cần đủ</FormLabel>
                          {selectedRoomId && listedPrice > 0 && (
                            <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10.5px] font-bold text-emerald-700">
                              mặc định = giá phòng
                            </span>
                          )}
                        </div>
                        <FormControl>
                          <CurrencyInput
                            value={field.value ?? 0}
                            onChange={field.onChange}
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
                    name="topup_due_date"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Hạn bổ sung cho đủ</FormLabel>
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
                </div>

                {conThieu > 0 && (
                  <div
                    className={
                      "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[12.5px] " +
                      (topupSauHold || (topupDays !== null && topupDays < 0)
                        ? "border-red-200 bg-red-50 text-red-700"
                        : "border-amber-200 bg-amber-50 text-amber-800")
                    }
                  >
                    <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
                    {topupSauHold ? (
                      <span>
                        Hạn bổ sung <strong>sau</strong> ngày hết hạn giữ phòng — tới lúc đó
                        phòng đã nhả khoá. Đặt hạn bổ sung trước{" "}
                        <strong>{fmtVNDate(holdUntil!)}</strong>.
                      </span>
                    ) : topupDays !== null && topupDays < 0 ? (
                      <span>
                        Hạn bổ sung đang <strong>trước</strong> ngày đặt cọc — kiểm tra lại.
                      </span>
                    ) : (
                      <span>
                        Còn thiếu <strong>{formatCurrency(conThieu)}</strong>
                        {topupDue ? (
                          <>
                            {" "}— khách phải bổ sung cho đủ{" "}
                            <strong>{formatCurrency(depositTarget)}</strong> trước{" "}
                            <strong>{fmtVNDate(topupDue)}</strong>. Quá ngày này phiếu vào
                            nhóm "quá hạn bổ sung cọc" trên bàn xử lý (hệ thống KHÔNG tự
                            huỷ, không tự tịch thu).
                          </>
                        ) : (
                          <> — chưa đặt hạn bổ sung, sẽ không ai được nhắc.</>
                        )}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Sổ quỹ ghi cọc — bắt buộc. Tiền cọc vào sổ nào phải do người thu
                  nói rõ, không để hệ thống đoán. */}
              <FormField
                control={form.control}
                name="account_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Sổ quỹ ghi cọc *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value ?? ""}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn sổ quỹ nhận tiền cọc" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {sortedAccounts.map((acc) => (
                          <SelectItem key={acc.id} value={acc.id}>
                            {acc.name}
                            {acc.code ? ` (${acc.code})` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="ctv_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>CTV (cộng tác viên)</FormLabel>
                    <FormControl>
                      <Input placeholder="Tên cộng tác viên" {...field} value={field.value ?? ""} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ghi chú</FormLabel>
                    <FormControl>
                      <Textarea {...field} value={field.value ?? ""} className="min-h-[60px]" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Ảnh chứng từ của PHIẾU CỌC (uỷ nhiệm chi, ảnh chuyển khoản…). */}
              <div className="space-y-2">
                <div className="text-sm font-medium">
                  Ảnh chứng từ{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    (tuỳ chọn — JPG/PNG/PDF, tối đa 5MB)
                  </span>
                </div>
                <AttachmentUpload
                  attachments={depositAttachments}
                  onChange={setDepositAttachments}
                  userId={myUserId ?? ""}
                  disabled={submitting || !myUserId}
                />
              </div>

              {/* Thưởng nóng Sale — tạo ngay cùng phiếu cọc.
                  Để trống thì không tạo gì. Phiếu thưởng ra ở trạng thái CHỜ DUYỆT,
                  và khi hợp đồng của phiếu cọc này được ký thì màn hình ký sẽ tự
                  biết là đã thưởng rồi. */}
              <div className="rounded-md border p-3 space-y-3">
                <div className="text-sm font-medium">
                  Thưởng nóng Sale{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    (tuỳ chọn — để trống nếu chưa thưởng)
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="sale_bonus_amount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Số tiền thưởng</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            inputMode="numeric"
                            placeholder="0"
                            {...field}
                            value={field.value ?? 0}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="sale_bonus_recipient"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Người nhận</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value ?? ""} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* STK + ngân hàng người nhận — ghi vào đúng cột của phiếu chi,
                    không chỉ nằm trong ghi chú. */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="sale_bonus_account_number"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">STK người nhận</FormLabel>
                        <FormControl>
                          <Input
                            inputMode="numeric"
                            placeholder="Số tài khoản nhận thưởng"
                            {...field}
                            value={field.value ?? ""}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="sale_bonus_bank"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Ngân hàng</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="VD: Vietcombank"
                            {...field}
                            value={field.value ?? ""}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Sổ quỹ chi thưởng — để trống được: chi thưởng có thể ra từ quỹ
                    khác quỹ nhận cọc, và người duyệt mới là người biết quỹ nào. */}
                <FormField
                  control={form.control}
                  name="sale_bonus_account_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">
                        Sổ quỹ chi thưởng{" "}
                        <span className="font-normal text-muted-foreground">
                          (tuỳ chọn)
                        </span>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ?? ""}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chưa chọn — điền sau khi duyệt" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {sortedAccounts.map((acc) => (
                            <SelectItem key={acc.id} value={acc.id}>
                              {acc.name}
                              {acc.code ? ` (${acc.code})` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="space-y-2">
                  <div className="text-xs font-medium">
                    Ảnh chứng từ thưởng{" "}
                    <span className="font-normal text-muted-foreground">
                      (tuỳ chọn)
                    </span>
                  </div>
                  <AttachmentUpload
                    attachments={bonusAttachments}
                    onChange={setBonusAttachments}
                    userId={myUserId ?? ""}
                    disabled={submitting || !myUserId}
                  />
                </div>

                <p className="text-[11px] text-muted-foreground">
                  Phiếu thưởng tạo ra ở trạng thái <strong>chờ duyệt</strong>. Mỗi phiếu cọc
                  chỉ thưởng một lần — khi ký hợp đồng, ô thưởng bên đó sẽ tự tô xám.
                </p>
              </div>

              <div className="flex justify-end gap-3 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={submitting}
                >
                  Hủy
                </Button>
                <Button type="submit" disabled={submitting || !!completed || uncertain || roomsQuery.isError || roomsQuery.isLoading || accountsQuery.isError || accountsQuery.isLoading}>
                  {submitting ? "Đang tạo..." : amountNow>0 ? "Tạo cọc & giữ chỗ" : "Giữ chỗ 0 đồng"}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
        <CustomerSelectionDialog open={customerPicker} onOpenChange={setCustomerPicker}
          selectedCustomerIds={customer?[customer.id]:[]} onSelect={values=>{
            if(values.length!==1){toast.error('Phải chọn đúng một khách hàng.');return;}
            setCustomer(values[0]);form.setValue('customer_id',values[0].id,{shouldValidate:true});setCustomerPicker(false);
          }}/>
      </DialogContent>
    </Dialog>
  );
}
