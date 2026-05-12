import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
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
import { useCreateDeposit } from "@/hooks/useDeposits";
import { useCreateTenant, useTenantsLegacy } from "@/hooks/useTenants";
import { useRooms } from "@/hooks/useRooms";
import { useBeds } from "@/hooks/useBeds";
import { ScrollArea } from "@/components/ui/scroll-area";

const depositSchema = z.object({
  tenant_id: z.string().optional(),
  create_tenant: z.boolean(),
  tenant_name: z.string().optional(),
  tenant_phone: z.string().optional(),
  room_id: z.string().min(1, "Phải chọn căn hộ"),
  bed_id: z.string().optional(),
  amount: z.number().min(0, "Số tiền phải >= 0"),
  deposit_date: z.string().min(1, "Ngày đặt cọc là bắt buộc"),
  hold_until_date: z.string().min(1, "Ngày giữ căn hộ là bắt buộc"),
  status: z.enum(["PENDING", "CONFIRMED", "CONVERTED", "REFUNDED", "FORFEITED"]),
  ctv_name: z.string().optional(),
  notes: z.string().optional(),
});

type DepositFormValues = z.infer<typeof depositSchema>;

interface CreateDepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateDepositDialog({ open, onOpenChange }: CreateDepositDialogProps) {
  const [createNewTenant, setCreateNewTenant] = useState(false);
  const createDeposit = useCreateDeposit();
  const createTenant = useCreateTenant();
  const { data: tenants = [] } = useTenantsLegacy();
  const { data: rooms = [] } = useRooms();
  const { data: beds = [] } = useBeds();

  const form = useForm<DepositFormValues>({
    resolver: zodResolver(depositSchema),
    defaultValues: {
      tenant_id: undefined,
      create_tenant: false,
      tenant_name: "",
      tenant_phone: "",
      room_id: "",
      bed_id: undefined,
      amount: 0,
      deposit_date: new Date().toISOString().split('T')[0],
      hold_until_date: "",
      status: "PENDING",
      ctv_name: "",
      notes: "",
    },
  });

  const onSubmit = async (data: DepositFormValues) => {
    try {
      let tenantId = data.tenant_id;

      // Create new tenant if needed
      if (createNewTenant && data.tenant_name && data.tenant_phone) {
        const newTenant = await createTenant.mutateAsync({
          full_name: data.tenant_name,
          phone: data.tenant_phone,
          status: "DEPOSITED",
        });
        tenantId = newTenant.id;
      }

      if (!tenantId) {
        throw new Error("Phải chọn hoặc tạo khách hàng");
      }

      // Create deposit
      await createDeposit.mutateAsync({
        tenant_id: tenantId,
        room_id: data.room_id || null,
        bed_id: data.bed_id || null,
        amount: data.amount,
        deposit_date: data.deposit_date,
        hold_until_date: data.hold_until_date,
        status: data.status,
        ctv_name: data.ctv_name || null,
        notes: data.notes || null,
      } as any);

      form.reset();
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to create deposit:", error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Tạo phiếu đặt cọc</DialogTitle>
          <DialogDescription>
            Tạo phiếu đặt cọc mới cho khách hàng
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
                          <FormLabel>Tên khách hàng *</FormLabel>
                          <FormControl>
                            <Input {...field} />
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
                          <FormLabel>Số điện thoại *</FormLabel>
                          <FormControl>
                            <Input {...field} />
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
                        <FormLabel>Chọn khách hàng *</FormLabel>
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

              {/* Room/Bed Selection */}
              <div className="grid grid-cols-2 gap-4">
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
                              {room.name} {room.code && `(${room.code})`}
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
                  name="bed_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Giường (nếu có)</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn giường" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {beds.map((bed) => (
                            <SelectItem key={bed.id} value={bed.id}>
                              {bed.name} {bed.code && `(${bed.code})`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

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
                          value={field.value || ''}
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
                  name="hold_until_date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Giữ căn hộ đến *</FormLabel>
                      <FormControl>
                        <DateInput
                          value={field.value || ''}
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
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Trạng thái *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn trạng thái" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="PENDING">Chờ xác nhận</SelectItem>
                        <SelectItem value="CONFIRMED">Đã xác nhận</SelectItem>
                        <SelectItem value="CONVERTED">Đã chuyển HĐ</SelectItem>
                        <SelectItem value="REFUNDED">Đã hoàn trả</SelectItem>
                        <SelectItem value="FORFEITED">Mất cọc</SelectItem>
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
                      <Textarea {...field} className="min-h-[60px]" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end gap-3 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Hủy
                </Button>
                <Button
                  type="submit"
                  disabled={createDeposit.isPending}
                >
                  {createDeposit.isPending ? "Đang tạo..." : "Tạo đặt cọc"}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
