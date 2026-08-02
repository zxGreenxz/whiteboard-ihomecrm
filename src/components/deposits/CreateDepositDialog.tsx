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
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { tryPlaceRoomHold } from "@/lib/reservationHold";
import { useCreateIncomeExpense } from "@/hooks/useIncomeExpenses";
import { useCreateSaleBonusFromDeposit } from "@/hooks/useSaleBonus";
import { useCreateTenant, useTenantsLegacy } from "@/hooks/useTenants";
import { useRooms } from "@/hooks/useRooms";
import { useAccounts } from "@/hooks/useAccounts";

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

const depositSchema = z.object({
  tenant_id: z.string().optional(),
  create_tenant: z.boolean(),
  tenant_name: z.string().optional(),
  tenant_phone: z.string().optional(),
  room_id: z.string().min(1, "Phải chọn căn hộ"),
  amount: z.number().min(0, "Số tiền phải >= 0"),
  deposit_date: z.string().min(1, "Ngày đặt cọc là bắt buộc"),
  hold_until: z.string().optional(),
  ctv_name: z.string().optional(),
  notes: z.string().optional(),
  // Thưởng nóng Sale — tuỳ chọn, tạo ngay cùng lúc với phiếu cọc.
  sale_bonus_amount: z.coerce.number().min(0).optional(),
  sale_bonus_recipient: z.string().optional(),
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

  const createIE = useCreateIncomeExpense();
  const createSaleBonus = useCreateSaleBonusFromDeposit();
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

  // Sổ thu THẬT của chính user (RLS-safe) cho cọc > 1đ; nếu không có → sổ CỌC ảo.
  const myDefaultAccount = useMemo(() => {
    const mine = accounts.filter((a) => a.user_id === myUserId);
    return mine.find((a) => a.is_default) ?? mine[0] ?? null;
  }, [accounts, myUserId]);

  const form = useForm<DepositFormValues>({
    resolver: zodResolver(depositSchema),
    defaultValues: {
      tenant_id: undefined,
      create_tenant: false,
      tenant_name: "",
      tenant_phone: "",
      room_id: "",
      amount: 0,
      deposit_date: new Date().toISOString().split("T")[0],
      hold_until: "",
      ctv_name: "",
      notes: "",
      sale_bonus_amount: 0,
      sale_bonus_recipient: "",
    },
  });

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

      // Cọc thật (>1đ) → sổ thu default của user; giữ chỗ 1đ / không có sổ → sổ CỌC ảo.
      let accId: string | null =
        data.amount > 1 && myDefaultAccount ? myDefaultAccount.id : null;
      if (!accId) {
        const { data: depAcc, error: accErr } = await rpc(
          "get_or_create_deposit_account",
        );
        if (accErr || !depAcc) {
          throw new Error("Không lấy được sổ quỹ để ghi cọc.");
        }
        accId = depAcc as string;
      }

      const roomLabel = room.code || room.name;
      const buildingName = room.building?.name ?? "";
      const name = `Cọc giữ chỗ phòng ${roomLabel}${
        buildingName ? ` - ${buildingName}` : ""
      }`;
      const extras: string[] = [];
      if (data.hold_until) extras.push(`Giữ phòng đến ${fmtVNDate(data.hold_until)}`);
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
        attachments: [],
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
      if (bonusAmt > 0 && depositId) {
        try {
          const r = await createSaleBonus.mutateAsync({
            depositVoucherId: depositId,
            amount: bonusAmt,
            recipient: data.sale_bonus_recipient || undefined,
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
