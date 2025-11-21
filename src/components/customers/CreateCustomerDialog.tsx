import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useState } from "react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { useCreateCustomer } from "@/hooks/useCustomers";

const customerSchema = z.object({
  customer_type: z.enum(["INDIVIDUAL", "ORGANIZATION"]),
  full_name: z.string().min(1, "Họ tên khách là bắt buộc"),
  phone: z.string().min(10, "Số điện thoại là bắt buộc"),
  email: z.string().email("Email không hợp lệ").optional().or(z.literal("")),
  date_of_birth: z.string().optional(),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
  id_type: z.enum(["CCCD", "CMND", "PASSPORT", "OTHER"]).optional(),
  id_number: z.string().optional(),
  id_issue_date: z.string().optional(),
  id_issue_place: z.string().optional(),
  province: z.string().optional(),
  district: z.string().optional(),
  ward: z.string().optional(),
  detailed_address: z.string().optional(),
  current_residence: z.string().optional(),
  permanent_address: z.string().optional(),
  bank_account_number: z.string().optional(),
  bank_name: z.string().optional(),
  occupation: z.string().optional(),
  workplace: z.string().optional(),
  contact_person: z.string().optional(),
  contact_person_phone: z.string().optional(),
  advisor: z.string().optional(),
  advisor_phone: z.string().optional(),
  emergency_contact_name: z.string().optional(),
  emergency_contact_phone: z.string().optional(),
  emergency_contact_relationship: z.string().optional(),
  fingerprint_code: z.string().optional(),
  customer_group: z.string().optional(),
  is_foreign: z.boolean().optional(),
  status: z.enum(["PROSPECT", "ACTIVE", "INACTIVE", "BLACKLIST"]),
  notes: z.string().optional(),
});

type CustomerFormValues = z.infer<typeof customerSchema>;

interface CreateCustomerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateCustomerDialog({ open, onOpenChange }: CreateCustomerDialogProps) {
  const createCustomer = useCreateCustomer();
  const [customerType, setCustomerType] = useState<"INDIVIDUAL" | "ORGANIZATION">("INDIVIDUAL");

  const form = useForm<CustomerFormValues>({
    resolver: zodResolver(customerSchema),
    defaultValues: {
      customer_type: "INDIVIDUAL",
      full_name: "",
      phone: "",
      email: "",
      date_of_birth: "",
      gender: undefined,
      id_type: undefined,
      id_number: "",
      id_issue_date: "",
      id_issue_place: "",
      province: "",
      district: "",
      ward: "",
      detailed_address: "",
      current_residence: "",
      permanent_address: "",
      bank_account_number: "",
      bank_name: "",
      occupation: "",
      workplace: "",
      contact_person: "",
      contact_person_phone: "",
      advisor: "",
      advisor_phone: "",
      emergency_contact_name: "",
      emergency_contact_phone: "",
      emergency_contact_relationship: "",
      fingerprint_code: "",
      customer_group: "",
      is_foreign: false,
      status: "PROSPECT",
      notes: "",
    },
  });

  const onSubmit = async (data: CustomerFormValues) => {
    try {
      await createCustomer.mutateAsync({
        customer_type: data.customer_type || null,
        full_name: data.full_name,
        phone: data.phone,
        email: data.email || null,
        date_of_birth: data.date_of_birth || null,
        gender: data.gender || null,
        id_type: data.id_type || null,
        id_number: data.id_number || null,
        id_issue_date: data.id_issue_date || null,
        id_issue_place: data.id_issue_place || null,
        province: data.province || null,
        district: data.district || null,
        ward: data.ward || null,
        detailed_address: data.detailed_address || null,
        current_residence: data.current_residence || null,
        permanent_address: data.permanent_address || null,
        bank_account_number: data.bank_account_number || null,
        bank_name: data.bank_name || null,
        occupation: data.occupation || null,
        workplace: data.workplace || null,
        contact_person: data.contact_person || null,
        contact_person_phone: data.contact_person_phone || null,
        advisor: data.advisor || null,
        advisor_phone: data.advisor_phone || null,
        emergency_contact_name: data.emergency_contact_name || null,
        emergency_contact_phone: data.emergency_contact_phone || null,
        emergency_contact_relationship: data.emergency_contact_relationship || null,
        fingerprint_code: data.fingerprint_code || null,
        customer_group: data.customer_group || null,
        is_foreign: data.is_foreign || false,
        status: data.status,
        notes: data.notes || null,
      });
      form.reset();
      onOpenChange(false);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[800px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>KHÁCH HÀNG</DialogTitle>
          <DialogDescription>
            Nhập thông tin khách hàng cho hệ thống quản lý
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* Customer Type Tabs */}
              <Tabs
                defaultValue="INDIVIDUAL"
                onValueChange={(value) => {
                  setCustomerType(value as "INDIVIDUAL" | "ORGANIZATION");
                  form.setValue("customer_type", value as "INDIVIDUAL" | "ORGANIZATION");
                }}
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="INDIVIDUAL">Cá nhân</TabsTrigger>
                  <TabsTrigger value="ORGANIZATION">Tổ chức</TabsTrigger>
                </TabsList>
              </Tabs>

              {/* Image Upload Section */}
              <div className="grid grid-cols-4 gap-4">
                <div className="border-2 border-dashed rounded-lg p-4 text-center">
                  <div className="text-sm text-muted-foreground">Ảnh đại diện</div>
                </div>
                <div className="border-2 border-dashed rounded-lg p-4 text-center">
                  <div className="text-sm text-muted-foreground">CCCD mặt trước</div>
                </div>
                <div className="border-2 border-dashed rounded-lg p-4 text-center">
                  <div className="text-sm text-muted-foreground">CCCD mặt sau</div>
                </div>
                <div className="border-2 border-dashed rounded-lg p-4 text-center">
                  <div className="text-sm text-muted-foreground">Hộ chiếu</div>
                </div>
              </div>

              {/* 1. THÔNG TIN CHUNG */}
              <div className="space-y-4 pt-4 border-t">
                <h3 className="font-semibold text-sm text-green-600">1. THÔNG TIN CHUNG</h3>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="full_name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Họ tên khách *</FormLabel>
                        <FormControl>
                          <Input placeholder="Nguyễn Văn A" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Số điện thoại *</FormLabel>
                        <FormControl>
                          <Input placeholder="0868987355" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input placeholder="nguyenvana@example.com" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="date_of_birth"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Ngày sinh</FormLabel>
                        <FormControl>
                          <Input type="date" {...field} />
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
                              <SelectValue placeholder="Chọn giới tính" />
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
                    name="id_number"
                    render={({ field }) => (
                      <FormItem className="col-span-2">
                        <FormLabel>CMND/CCCD</FormLabel>
                        <FormControl>
                          <Input placeholder="173850033" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="id_issue_date"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Ngày cấp</FormLabel>
                        <FormControl>
                          <Input type="date" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="id_issue_place"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Nơi cấp</FormLabel>
                        <FormControl>
                          <Input placeholder="Cục cảnh sát" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="province"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tỉnh/Thành Phố</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn Tỉnh/Thành phố" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="HN">Hà Nội</SelectItem>
                            <SelectItem value="HCM">TP. Hồ Chí Minh</SelectItem>
                            <SelectItem value="DN">Đà Nẵng</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="district"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Quận/Huyện</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn quận/huyện" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="district1">Quận 1</SelectItem>
                            <SelectItem value="district2">Quận 2</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="ward"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Xã/Phường</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn phường/xã" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="ward1">Phường 1</SelectItem>
                            <SelectItem value="ward2">Phường 2</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="detailed_address"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Địa chỉ chi tiết</FormLabel>
                        <FormControl>
                          <Input placeholder="91 Nguyễn Chí Thanh" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="current_residence"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Chỗ ở hiện tại</FormLabel>
                        <FormControl>
                          <Input placeholder="91 Nguyễn Chí Thanh" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="permanent_address"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Địa chỉ thường trú</FormLabel>
                        <FormControl>
                          <Input placeholder="91 Nguyễn Chí Thanh" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="bank_account_number"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Số tài khoản</FormLabel>
                        <FormControl>
                          <Input placeholder="1234567890" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="bank_name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Ngân hàng</FormLabel>
                        <FormControl>
                          <Input placeholder="Vietcombank" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="occupation"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Nghề Nghiệp</FormLabel>
                        <FormControl>
                          <Input placeholder="Sinh viên" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="workplace"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Nơi làm việc</FormLabel>
                        <FormControl>
                          <Input placeholder="Đại học Bách Khoa" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="contact_person"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Người liên lạc</FormLabel>
                        <FormControl>
                          <Input placeholder="Nguyễn Văn A" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="contact_person_phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>SĐT người liên lạc</FormLabel>
                        <FormControl>
                          <Input placeholder="0868123456" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="advisor"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Người tư vấn</FormLabel>
                        <FormControl>
                          <Input placeholder="Nguyễn Văn A" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="advisor_phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>SĐT người tư vấn</FormLabel>
                        <FormControl>
                          <Input placeholder="0868123456" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="fingerprint_code"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Mã vãn tay của ra vào</FormLabel>
                        <FormControl>
                          <Input placeholder="68" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="customer_group"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Nhóm khách hàng</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Nhóm khách hàng" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="vip">VIP</SelectItem>
                            <SelectItem value="regular">Thường</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="is_foreign"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                      <div className="space-y-0.5">
                        <FormLabel>Khách nước ngoài</FormLabel>
                      </div>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
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
                          placeholder="Ghi chú"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* 2. THÔNG TIN XE */}
              <div className="space-y-4 pt-4 border-t">
                <h3 className="font-semibold text-sm text-green-600">2. THÔNG TIN XE</h3>
                <Button type="button" variant="outline" size="sm">
                  + Thêm xe
                </Button>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Hủy
                </Button>
                <Button type="submit" disabled={createCustomer.isPending} className="bg-green-600 hover:bg-green-700">
                  {createCustomer.isPending ? "Đang tạo..." : "Lưu"}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
