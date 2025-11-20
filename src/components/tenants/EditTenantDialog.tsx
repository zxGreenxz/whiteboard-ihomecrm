import { useEffect } from "react";
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
  FormDescription,
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { useUpdateTenant } from "@/hooks/useTenants";
import type { Database } from "@/integrations/supabase/types";

type Tenant = Database["public"]["Tables"]["tenants"]["Row"];

const tenantSchema = z.object({
  full_name: z.string().min(1, "Họ tên là bắt buộc"),
  phone: z.string().optional(),
  email: z.string().email("Email không hợp lệ").optional().or(z.literal("")),
  id_number: z.string().optional(),
  id_type: z.enum(["CCCD", "CMND", "PASSPORT", "OTHER"]).optional(),
  date_of_birth: z.string().optional(),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
  permanent_address: z.string().optional(),
  emergency_contact_name: z.string().optional(),
  emergency_contact_phone: z.string().optional(),
  emergency_contact_relationship: z.string().optional(),
  status: z.enum(["PROSPECT", "DEPOSITED", "ACTIVE", "INACTIVE", "BLACKLIST"]),
  notes: z.string().optional(),
});

type TenantFormValues = z.infer<typeof tenantSchema>;

interface EditTenantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: Tenant;
}

export function EditTenantDialog({
  open,
  onOpenChange,
  tenant,
}: EditTenantDialogProps) {
  const updateTenant = useUpdateTenant();

  const form = useForm<TenantFormValues>({
    resolver: zodResolver(tenantSchema),
    defaultValues: {
      full_name: tenant.full_name,
      phone: tenant.phone || "",
      email: tenant.email || "",
      id_number: tenant.id_number || "",
      id_type: tenant.id_type as any,
      date_of_birth: tenant.date_of_birth || "",
      gender: tenant.gender as any,
      permanent_address: tenant.permanent_address || "",
      emergency_contact_name: tenant.emergency_contact_name || "",
      emergency_contact_phone: tenant.emergency_contact_phone || "",
      emergency_contact_relationship: tenant.emergency_contact_relationship || "",
      status: tenant.status as any,
      notes: tenant.notes || "",
    },
  });

  // Update form when tenant changes
  useEffect(() => {
    if (tenant) {
      form.reset({
        full_name: tenant.full_name,
        phone: tenant.phone || "",
        email: tenant.email || "",
        id_number: tenant.id_number || "",
        id_type: tenant.id_type as any,
        date_of_birth: tenant.date_of_birth || "",
        gender: tenant.gender as any,
        permanent_address: tenant.permanent_address || "",
        emergency_contact_name: tenant.emergency_contact_name || "",
        emergency_contact_phone: tenant.emergency_contact_phone || "",
        emergency_contact_relationship: tenant.emergency_contact_relationship || "",
        status: tenant.status as any,
        notes: tenant.notes || "",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant]);

  const onSubmit = async (data: TenantFormValues) => {
    try {
      await updateTenant.mutateAsync({
        id: tenant.id,
        updates: {
          full_name: data.full_name,
          phone: data.phone || null,
          email: data.email || null,
          id_number: data.id_number || null,
          id_type: data.id_type || null,
          date_of_birth: data.date_of_birth || null,
          gender: data.gender || null,
          permanent_address: data.permanent_address || null,
          emergency_contact_name: data.emergency_contact_name || null,
          emergency_contact_phone: data.emergency_contact_phone || null,
          emergency_contact_relationship: data.emergency_contact_relationship || null,
          status: data.status,
          notes: data.notes || null,
        },
      });
      onOpenChange(false);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Chỉnh sửa Khách thuê</DialogTitle>
          <DialogDescription>
            Cập nhật thông tin khách thuê
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* Basic Info */}
              <div className="space-y-4">
                <h3 className="font-semibold text-sm">Thông tin cơ bản</h3>
                
                <FormField
                  control={form.control}
                  name="full_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Họ và tên *</FormLabel>
                      <FormControl>
                        <Input placeholder="Nguyễn Văn A" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Số điện thoại</FormLabel>
                        <FormControl>
                          <Input placeholder="0123456789" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input placeholder="example@email.com" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="gender"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Giới tính</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="MALE">Nam</SelectItem>
                            <SelectItem value="FEMALE">Nữ</SelectItem>
                            <SelectItem value="OTHER">Khác</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="date_of_birth"
                    render={({ field }) => (
                      <FormItem className="col-span-2">
                        <FormLabel>Ngày sinh</FormLabel>
                        <FormControl>
                          <Input type="date" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {/* ID Information */}
              <div className="space-y-4 pt-4 border-t">
                <h3 className="font-semibold text-sm">Giấy tờ tùy thân</h3>
                
                <div className="grid grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="id_type"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Loại giấy tờ</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="CCCD">CCCD</SelectItem>
                            <SelectItem value="CMND">CMND</SelectItem>
                            <SelectItem value="PASSPORT">Hộ chiếu</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="id_number"
                    render={({ field }) => (
                      <FormItem className="col-span-2">
                        <FormLabel>Số CCCD/CMND/Hộ chiếu</FormLabel>
                        <FormControl>
                          <Input placeholder="001234567890" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="permanent_address"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Địa chỉ thường trú</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Số nhà, đường, phường/xã, quận/huyện, tỉnh/thành phố"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Emergency Contact */}
              <div className="space-y-4 pt-4 border-t">
                <h3 className="font-semibold text-sm">Liên hệ khẩn cấp</h3>
                
                <FormField
                  control={form.control}
                  name="emergency_contact_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tên người liên hệ</FormLabel>
                      <FormControl>
                        <Input placeholder="Nguyễn Văn B" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="emergency_contact_phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Số điện thoại</FormLabel>
                        <FormControl>
                          <Input placeholder="0987654321" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="emergency_contact_relationship"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Mối quan hệ</FormLabel>
                        <FormControl>
                          <Input placeholder="Bố/Mẹ/Anh/Chị/Em..." {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {/* Status and Notes */}
              <div className="space-y-4 pt-4 border-t">
                <h3 className="font-semibold text-sm">Trạng thái & Ghi chú</h3>
                
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
                          <SelectItem value="PROSPECT">Tiềm năng</SelectItem>
                          <SelectItem value="DEPOSITED">Đã đặt cọc</SelectItem>
                          <SelectItem value="ACTIVE">Đang thuê</SelectItem>
                          <SelectItem value="MOVED_OUT">Đã chuyển đi</SelectItem>
                          <SelectItem value="BLACKLISTED">Danh sách đen</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Trạng thái hiện tại của khách thuê
                      </FormDescription>
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
                        <Textarea
                          placeholder="Ghi chú thêm về khách thuê..."
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="flex justify-end gap-3 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Hủy
                </Button>
                <Button type="submit" disabled={updateTenant.isPending}>
                  {updateTenant.isPending ? "Đang cập nhật..." : "Cập nhật"}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
