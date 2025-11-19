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
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useUpdateService } from "@/hooks/useServices";
import type { Database } from "@/integrations/supabase/types";

type Service = Database["public"]["Tables"]["services"]["Row"];

const serviceSchema = z.object({
  name: z.string().min(1, "Tên dịch vụ là bắt buộc"),
  code: z.string().optional(),
  type: z.enum(["FIXED", "PER_PERSON", "PER_ROOM", "METER_READING"]),
  unit_price: z.string().min(0, "Đơn giá không hợp lệ"),
  unit: z.string().optional(),
  is_default: z.boolean(),
  is_mandatory: z.boolean(),
  description: z.string().optional(),
});

type ServiceFormValues = z.infer<typeof serviceSchema>;

interface EditServiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: Service;
}

export function EditServiceDialog({
  open,
  onOpenChange,
  service,
}: EditServiceDialogProps) {
  const updateService = useUpdateService();

  const form = useForm<ServiceFormValues>({
    resolver: zodResolver(serviceSchema),
    defaultValues: {
      name: service.name,
      code: service.code || "",
      type: service.type,
      unit_price: service.unit_price.toString(),
      unit: service.unit || "",
      is_default: service.is_default || false,
      is_mandatory: service.is_mandatory || false,
      description: service.description || "",
    },
  });

  const selectedType = form.watch("type");

  // Update form when service changes
  useEffect(() => {
    if (service) {
      form.reset({
        name: service.name,
        code: service.code || "",
        type: service.type,
        unit_price: service.unit_price.toString(),
        unit: service.unit || "",
        is_default: service.is_default || false,
        is_mandatory: service.is_mandatory || false,
        description: service.description || "",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service]);

  const onSubmit = async (data: ServiceFormValues) => {
    try {
      await updateService.mutateAsync({
        id: service.id,
        updates: {
          name: data.name,
          code: data.code || null,
          type: data.type,
          unit_price: parseFloat(data.unit_price),
          unit: data.unit || null,
          is_default: data.is_default,
          is_mandatory: data.is_mandatory,
          description: data.description || null,
        },
      });
      onOpenChange(false);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Chỉnh sửa Dịch vụ</DialogTitle>
          <DialogDescription>
            Cập nhật thông tin dịch vụ
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
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tên dịch vụ *</FormLabel>
                      <FormControl>
                        <Input placeholder="Ví dụ: Điện, Nước, Wifi" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="code"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Mã dịch vụ</FormLabel>
                        <FormControl>
                          <Input placeholder="DV-01" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="type"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Loại dịch vụ *</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn loại" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="FIXED">Cố định</SelectItem>
                            <SelectItem value="PER_PERSON">Theo người</SelectItem>
                            <SelectItem value="PER_ROOM">Theo phòng</SelectItem>
                            <SelectItem value="METER_READING">Theo chỉ số</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {/* Pricing */}
              <div className="space-y-4 pt-4 border-t">
                <h3 className="font-semibold text-sm">Giá cả</h3>
                
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="unit_price"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Đơn giá (VNĐ) *</FormLabel>
                        <FormControl>
                          <Input type="number" placeholder="50000" {...field} />
                        </FormControl>
                        <FormDescription>
                          {selectedType === "METER_READING" && "Giá mỗi đơn vị (kWh, m³)"}
                          {selectedType === "PER_PERSON" && "Giá mỗi người"}
                          {selectedType === "PER_ROOM" && "Giá mỗi phòng"}
                          {selectedType === "FIXED" && "Giá cố định"}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="unit"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Đơn vị {selectedType === "METER_READING" && "*"}
                        </FormLabel>
                        <FormControl>
                          <Input 
                            placeholder={selectedType === "METER_READING" ? "kWh, m³" : "tháng, người, phòng"} 
                            {...field} 
                          />
                        </FormControl>
                        <FormDescription>
                          {selectedType === "METER_READING" 
                            ? "Bắt buộc cho dịch vụ theo chỉ số" 
                            : "Tùy chọn"}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {/* Options */}
              <div className="space-y-4 pt-4 border-t">
                <h3 className="font-semibold text-sm">Tùy chọn</h3>
                
                <FormField
                  control={form.control}
                  name="is_default"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel>
                          Dịch vụ mặc định
                        </FormLabel>
                        <FormDescription>
                          Tự động chọn khi tạo hợp đồng mới
                        </FormDescription>
                      </div>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="is_mandatory"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel>
                          Dịch vụ bắt buộc
                        </FormLabel>
                        <FormDescription>
                          Không thể bỏ chọn khi tạo hợp đồng
                        </FormDescription>
                      </div>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Mô tả</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Mô tả chi tiết về dịch vụ..."
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
                <Button type="submit" disabled={updateService.isPending}>
                  {updateService.isPending ? "Đang cập nhật..." : "Cập nhật"}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
