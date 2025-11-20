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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useConvertLeadToDeposit, type LeadWithRelations } from "@/hooks/useLeads";
import { useCreateDeposit } from "@/hooks/useDeposits";
import { useCreateTenant } from "@/hooks/useTenants";
import { useTenants } from "@/hooks/useTenants";
import { useRooms } from "@/hooks/useRooms";
import { useBeds } from "@/hooks/useBeds";

const convertSchema = z.object({
  tenant_id: z.string().optional(),
  create_tenant: z.boolean(),
  tenant_name: z.string().optional(),
  tenant_phone: z.string().optional(),
  room_id: z.string().min(1, "Phải chọn phòng"),
  bed_id: z.string().optional(),
  amount: z.number().min(0, "Số tiền phải >= 0"),
  deposit_date: z.string().min(1, "Ngày đặt cọc là bắt buộc"),
  hold_until_date: z.string().min(1, "Ngày giữ phòng là bắt buộc"),
  notes: z.string().optional(),
});

type ConvertFormValues = z.infer<typeof convertSchema>;

interface ConvertLeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead: LeadWithRelations;
}

export function ConvertLeadDialog({ open, onOpenChange, lead }: ConvertLeadDialogProps) {
  const [createNewTenant, setCreateNewTenant] = useState(false);
  const convertLead = useConvertLeadToDeposit();
  const createDeposit = useCreateDeposit();
  const createTenant = useCreateTenant();
  const { data: tenants = [] } = useTenants();
  const { data: rooms = [] } = useRooms();
  const { data: beds = [] } = useBeds();

  const form = useForm<ConvertFormValues>({
    resolver: zodResolver(convertSchema),
    defaultValues: {
      tenant_id: undefined,
      create_tenant: false,
      tenant_name: lead.customer_name || "",
      tenant_phone: lead.phone || "",
      room_id: lead.room_id || "",
      bed_id: lead.bed_id || undefined,
      amount: 0,
      deposit_date: new Date().toISOString().split('T')[0],
      hold_until_date: "",
      notes: lead.notes || "",
    },
  });

  const onSubmit = async (data: ConvertFormValues) => {
    try {
      let tenantId = data.tenant_id;

      // Create new tenant if needed
      if (createNewTenant && data.tenant_name && data.tenant_phone) {
        const newTenant = await createTenant.mutateAsync({
          full_name: data.tenant_name,
          phone: data.tenant_phone,
          email: lead.email,
          status: "DEPOSITED",
        });
        tenantId = newTenant.id;
      }

      if (!tenantId) {
        throw new Error("Phải chọn hoặc tạo khách thuê");
      }

      // Create deposit
      await createDeposit.mutateAsync({
        tenant_id: tenantId,
        room_id: data.room_id || null,
        bed_id: data.bed_id || null,
        amount: data.amount,
        deposit_date: data.deposit_date,
        hold_until_date: data.hold_until_date,
        status: "PENDING",
        notes: data.notes || null,
      });

      // Mark lead as converted
      await convertLead.mutateAsync(lead.id);

      onOpenChange(false);
    } catch (error) {
      console.error("Failed to convert lead:", error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Chuyển sang Đặt cọc</DialogTitle>
          <DialogDescription>
            Tạo phiếu đặt cọc từ khách hẹn: {lead.customer_name}
          </DialogDescription>
        </DialogHeader>

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
                  Tạo khách thuê mới
                </label>
              </div>

              {createNewTenant ? (
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="tenant_name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tên khách thuê *</FormLabel>
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
                      <FormLabel>Chọn khách thuê *</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn khách thuê" />
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
                    <FormLabel>Phòng *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn phòng" />
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
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)}
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
                      <Input type="date" {...field} />
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
                    <FormLabel>Giữ phòng đến *</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

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
                disabled={createDeposit.isPending || convertLead.isPending}
              >
                {createDeposit.isPending ? "Đang tạo..." : "Tạo đặt cọc"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
