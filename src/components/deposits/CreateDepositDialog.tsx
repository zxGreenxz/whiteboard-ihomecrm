import { useEffect, useMemo, useState } from "react";
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
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { tryPlaceRoomHold } from "@/lib/reservationHold";
import { useCreateIncomeExpense } from "@/hooks/useIncomeExpenses";
import { useCreateSaleBonusFromDeposit } from "@/hooks/useSaleBonus";
import { useSetReservationHoldDeadline } from "@/hooks/useReservationHoldDeadlines";
import { useCreateTenant, useTenantsLegacy } from "@/hooks/useTenants";
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
  tenant_id: z.string().optional(),
  create_tenant: z.boolean(),
  tenant_name: z.string().optional(),
  tenant_phone: z.string().optional(),
  room_id: z.string().min(1, "Phải chọn căn hộ"),
  /** Giá phòng/tháng — mặc định lấy giá niêm yết của căn hộ, sửa được. */
  room_price: z.number().min(0, "Giá phòng phải >= 0").optional(),
  amount: z.number().min(0, "Số tiền phải >= 0"),
  deposit_date: z.string().min(1, "Ngày đặt cọc là bắt buộc"),
  hold_until: z.string().optional(),
  ctv_name: z.string().optional(),
  notes: z.string().optional(),
  // Sổ quỹ ghi cọc — BẮT BUỘC chọn (quyết định chủ 20/08/2026). Trước đây dialog
  // tự chọn ngầm: cọc > 1đ lấy sổ mặc định của người tạo, còn lại lấy sổ CỌC ảo.
  // Chọn ngầm nghĩa là tiền vào sổ nào không ai để ý cho tới lúc đối chiếu.
  account_id: z.string().min(1, "Phải chọn sổ quỹ ghi cọc"),
  // Thưởng nóng Sale — tuỳ chọn, tạo ngay cùng lúc với phiếu cọc.
  sale_bonus_amount: z.coerce.number().min(0).optional(),
  sale_bonus_recipient: z.string().optional(),
  sale_bonus_account_id: z.string().optional(),
  sale_bonus_account_number: z.string().optional(),
  sale_bonus_bank: z.string().optional(),
});

type DepositFormValues = z.infer<typeof depositSchema>;

interface CreateDepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateDepositDialog({ open, onOpenChange }: CreateDepositDialogProps) {
  const queryClient = useQueryClient();
  const [createNewTenant, setCreateNewTenant] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  // Ảnh chứng từ giữ ngoài react-hook-form: AttachmentUpload đã tự quản lý
  // upload/xoá trên storage và chỉ trả về mảng URL — cùng khuôn CommissionVoucherModal.
  const [depositAttachments, setDepositAttachments] = useState<string[]>([]);
  const [bonusAttachments, setBonusAttachments] = useState<string[]>([]);

  const createIE = useCreateIncomeExpense();
  const createSaleBonus = useCreateSaleBonusFromDeposit();
  const setHoldDeadline = useSetReservationHoldDeadline();
  const createTenant = useCreateTenant();
  const { data: tenants = [] } = useTenantsLegacy();
  const { data: rooms = [] } = useRooms();
  const { data: accounts = [] } = useAccounts();

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
    resolver: zodResolver(depositSchema),
    defaultValues: {
      tenant_id: undefined,
      create_tenant: false,
      tenant_name: "",
      tenant_phone: "",
      room_id: "",
      room_price: 0,
      amount: 0,
      deposit_date: todayISO(),
      hold_until: "",
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

  const onSubmit = async (data: DepositFormValues) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const room = rooms.find((r) => r.id === data.room_id);
      if (!room) throw new Error("Không tìm thấy căn hộ");
      const buildingId = (room as any).building_id ?? room.building?.id;
      if (!buildingId) throw new Error("Căn hộ chưa gắn toà nhà");

      // Khoá giữ-phòng 24h (canonical deposit.hold.v1): chặn 2 nhân viên thu
      // cọc đè cùng phòng; throw nếu người khác đang giữ, cho qua nếu writer tắt.
      await tryPlaceRoomHold(data.room_id, data.amount);

      // Khách hàng (tuỳ chọn): tạo mới hoặc chọn sẵn → payer_name + tenant_id.
      let tenantId: string | null = data.tenant_id || null;
      let payerName: string | null = null;
      if (createNewTenant && data.tenant_name) {
        const newTenant = await createTenant.mutateAsync({
          full_name: data.tenant_name,
          phone: data.tenant_phone || "",
          status: "DEPOSITED",
        });
        tenantId = newTenant.id;
        payerName = data.tenant_name;
      } else if (tenantId) {
        payerName = tenants.find((t) => t.id === tenantId)?.full_name ?? null;
      }

      // Hạng mục "Tiền Cọc" (is_deposit=TRUE) + sổ quỹ ghi cọc.
      const rpc = (
        supabase as unknown as {
          rpc: (
            fn: string,
            args?: Record<string, unknown>,
          ) => Promise<{ data: unknown; error: unknown }>;
        }
      ).rpc.bind(supabase);

      const { data: typeId, error: typeErr } = await rpc("ensure_room_deposit_type");
      if (typeErr || !typeId) {
        throw new Error('Không lấy được hạng mục "Tiền cọc".');
      }

      // Sổ quỹ do người tạo CHỌN (quyết định chủ 20/08/2026) — không còn đường
      // tự lấy sổ mặc định / sổ CỌC ảo ngầm. Zod đã chặn rỗng, đây là chốt cuối.
      const accId: string = data.account_id;
      if (!accId) {
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

      const createdDeposit: any = await createIE.mutateAsync({
        type: "INCOME",
        name,
        building_id: buildingId,
        room_id: data.room_id,
        tenant_id: tenantId,
        contract_id: null, // cọc giữ chỗ — chưa có hợp đồng
        payer_name: payerName,
        account_id: accId as string,
        voucher_date: data.deposit_date,
        business_result_accounting: null, // hạng mục cọc tự loại khỏi KQKD
        repeat_cycle: "NONE",
        repeat_infinity: false,
        repeat_count: 0,
        attachments: depositAttachments,
        items: [
          {
            income_expense_type_id: typeId as string,
            description: itemDesc,
            quantity: 1,
            unit_price: data.amount,
            start_date: data.deposit_date,
            end_date: data.deposit_date,
          },
        ],
      });

      // Thưởng nóng Sale ngay tại đây (tuỳ chọn). Cố ý tạo SAU khi phiếu cọc đã
      // có id: phiếu thưởng neo vào phiếu cọc, và chính cái neo đó là thứ giúp
      // màn hình ký hợp đồng sau này biết là "đã thưởng rồi" mà tô xám ô nhập.
      // Thưởng hỏng thì KHÔNG kéo đổ phiếu cọc — cọc là việc chính.
      const bonusAmt = Number(data.sale_bonus_amount) || 0;
      const depositId = createdDeposit?.id ?? createdDeposit?.voucher_id ?? null;

      // HẠN PHẢI LÀM HỢP ĐỒNG — ghi vào bảng chuyên trách
      // (`reservation_hold_deadlines`, migration 20260822010000). Đây mới là
      // NGUỒN SỰ THẬT mà bàn xử lý /deposits đọc để xếp nhóm "quá hạn làm HĐ";
      // chuỗi "Giữ phòng đến …" trong ghi chú phiếu vẫn giữ để người đọc phiếu
      // thấy, nhưng KHÔNG ai suy luận từ nó nữa.
      //
      // Hỏng ở đây KHÔNG được kéo đổ phiếu cọc: tiền đã thu, phiếu đã tạo. Báo
      // rõ để người dùng đặt lại hạn thay vì im lặng nuốt.
      if (data.hold_until && depositId) {
        try {
          await setHoldDeadline.mutateAsync({
            incomeExpenseId: depositId,
            holdUntil: data.hold_until,
          });
        } catch {
          toast.error(
            "Phiếu cọc đã tạo, nhưng CHƯA ghi được hạn làm hợp đồng — " +
              "vào thẻ phiếu trên trang Quản lý Cọc để đặt lại.",
          );
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
          toast.success(`Đã tạo phiếu thưởng Sale ${r?.code ?? ""} — đang chờ duyệt.`);
        } catch (e) {
          toast.error(
            "Phiếu cọc đã tạo, nhưng chưa tạo được phiếu thưởng Sale: " +
              ((e as Error)?.message ?? "lỗi không rõ")
          );
        }
      }

      // Phòng vừa bị khoá (RESERVED) → refetch các nguồn liên quan.
      queryClient.invalidateQueries({ queryKey: ["reservation-deposits"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      queryClient.invalidateQueries({ queryKey: ["phong-trong"] });
      queryClient.invalidateQueries({ queryKey: ["orphan-deposit-vouchers"] });

      form.reset();
      setDepositAttachments([]);
      setBonusAttachments([]);
      setCreateNewTenant(false);
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to create reservation deposit:", error);
      toast.error((error as Error)?.message || "Không thể tạo phiếu cọc giữ chỗ");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Tạo phiếu cọc giữ chỗ</DialogTitle>
          <DialogDescription>
            Ghi nhận cọc giữ chỗ trước hợp đồng (tạo phiếu thu cọc, tự khoá phòng).
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* Tenant Selection */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="create_tenant"
                    checked={createNewTenant}
                    onChange={(e) => setCreateNewTenant(e.target.checked)}
                    className="rounded"
                  />
                  <label htmlFor="create_tenant" className="text-sm">
                    Tạo khách hàng mới
                  </label>
                </div>

                {createNewTenant ? (
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="tenant_name"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Tên khách hàng</FormLabel>
                          <FormControl>
                            <Input {...field} value={field.value ?? ""} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="tenant_phone"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Số điện thoại</FormLabel>
                          <FormControl>
                            <Input {...field} value={field.value ?? ""} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                ) : (
                  <FormField
                    control={form.control}
                    name="tenant_id"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Khách hàng (tuỳ chọn)</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn khách hàng" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {tenants.map((tenant) => (
                              <SelectItem key={tenant.id} value={tenant.id}>
                                {tenant.full_name} - {tenant.phone}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </div>

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

              {/* Ngày giữ phòng SINH RA hạn phải làm hợp đồng. Nói thẳng hệ quả
                  ở đây thay vì để người dùng tự suy: quá ngày này phòng bị đánh
                  dấu "quá hạn làm HĐ" và nhả khoá giữ phòng. */}
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
                      <strong>{fmtVNDate(holdUntil!)}</strong>. Quá ngày này phòng bị đánh dấu
                      "quá hạn làm HĐ" và nhả khoá giữ phòng.
                    </span>
                  )}
                </div>
              )}

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
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Đang tạo..." : "Tạo đặt cọc"}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
