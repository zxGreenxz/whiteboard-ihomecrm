import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Dialog,
  DialogContent,
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
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useUpdateService,
  FEE_TYPE_LABELS,
  PRICING_TYPE_LABELS,
  TAX_RATE_OPTIONS,
  UNIT_OPTIONS,
  useServiceQuotas,
  type ServiceWithBuildings,
} from "@/hooks/useServices";
import { useBuildings } from "@/hooks/useBuildings";

const serviceSchema = z.object({
  name: z.string().min(1, "Tên dịch vụ là bắt buộc"),
  fee_type: z.string().min(1, "Loại phí là bắt buộc"),
  pricing_type: z.string().min(1, "Loại đơn giá là bắt buộc"),
  unit_price: z.string().min(1, "Đơn giá là bắt buộc"),
  unit: z.string().optional(),
  quota_id: z.string().optional(),
  tax_rate: z.string().optional(),
  building_ids: z.array(z.string()).min(1, "Chọn ít nhất một tòa nhà"),
  description: z.string().optional(),
});

type ServiceFormValues = z.infer<typeof serviceSchema>;

interface EditServiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: ServiceWithBuildings;
}

export function EditServiceDialog({ open, onOpenChange, service }: EditServiceDialogProps) {
  const updateService = useUpdateService();
  const { data: buildings } = useBuildings();
  const { data: quotas } = useServiceQuotas();

  const form = useForm<ServiceFormValues>({
    resolver: zodResolver(serviceSchema),
    defaultValues: {
      name: service.name,
      fee_type: service.fee_type || "",
      pricing_type: service.pricing_type || "",
      unit_price: service.unit_price.toString(),
      unit: service.unit || "",
      quota_id: service.quota_id || "",
      tax_rate: String(service.tax_rate ?? 0),
      building_ids: service.service_buildings.map((sb) => sb.building_id),
      description: service.description || "",
    },
  });

  useEffect(() => {
    if (service) {
      form.reset({
        name: service.name,
        fee_type: service.fee_type || "",
        pricing_type: service.pricing_type || "",
        unit_price: service.unit_price.toString(),
        unit: service.unit || "",
        quota_id: service.quota_id || "",
        tax_rate: String(service.tax_rate ?? 0),
        building_ids: service.service_buildings.map((sb) => sb.building_id),
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
          fee_type: data.fee_type as any,
          pricing_type: data.pricing_type as any,
          unit_price: parseFloat(data.unit_price),
          unit: data.unit || null,
          quota_id: data.quota_id && data.quota_id !== "none" ? data.quota_id : null,
          tax_rate: data.tax_rate ? parseFloat(data.tax_rate) : 0,
          description: data.description || null,
        },
        building_ids: data.building_ids,
      });
      onOpenChange(false);
    } catch {
      // handled by mutation
    }
  };

  const watchedBuildingIds = form.watch("building_ids");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[550px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Sửa dịch vụ</DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-100px)] pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tên dịch vụ *</FormLabel>
                    <FormControl>
                      <Input placeholder="Nhập tên dịch vụ" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="fee_type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Loại phí *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn loại phí" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(FEE_TYPE_LABELS).map(([key, label]) => (
                          <SelectItem key={key} value={key}>{label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="pricing_type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Loại đơn giá *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn loại đơn giá" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(PRICING_TYPE_LABELS).map(([key, label]) => (
                          <SelectItem key={key} value={key}>{label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="unit_price"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Đơn giá *</FormLabel>
                    <FormControl>
                      <Input type="number" placeholder="0" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="unit"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Đơn vị tính</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || ""}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn đơn vị" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {UNIT_OPTIONS.map((u) => (
                          <SelectItem key={u} value={u}>{u}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="quota_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Chọn định mức</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || ""}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn định mức (tùy chọn)" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">Không chọn</SelectItem>
                        {(quotas || []).map((q) => (
                          <SelectItem key={q.id} value={q.id}>{q.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="tax_rate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Thuế suất</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || "0"}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn thuế suất" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {TAX_RATE_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={String(opt.value)}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="building_ids"
                render={() => (
                  <FormItem>
                    <FormLabel>Tòa nhà sử dụng *</FormLabel>
                    <div className="border rounded-md p-3 space-y-2 max-h-[150px] overflow-y-auto">
                      {(buildings || []).length === 0 ? (
                        <p className="text-sm text-muted-foreground">Chưa có tòa nhà nào</p>
                      ) : (
                        (buildings || []).map((b) => (
                          <div key={b.id} className="flex items-center gap-2">
                            <Checkbox
                              checked={watchedBuildingIds.includes(b.id)}
                              onCheckedChange={(checked) => {
                                const current = form.getValues("building_ids");
                                if (checked) {
                                  form.setValue("building_ids", [...current, b.id], { shouldValidate: true });
                                } else {
                                  form.setValue("building_ids", current.filter((id) => id !== b.id), { shouldValidate: true });
                                }
                              }}
                            />
                            <span className="text-sm">{b.name}</span>
                          </div>
                        ))
                      )}
                    </div>
                    <FormMessage />
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
                      <Textarea placeholder="Nhập mô tả..." {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end gap-3 pt-4">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
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
