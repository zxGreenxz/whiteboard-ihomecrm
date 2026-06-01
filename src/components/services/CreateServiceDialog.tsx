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
import { CurrencyInput } from "@/components/ui/currency-input";
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
  useCreateService,
  FEE_TYPE_LABELS,
  PRICING_TYPE_LABELS,
  UNIT_OPTIONS,
  useServiceQuotas,
} from "@/hooks/useServices";
import { useBuildings } from "@/hooks/useBuildings";

const serviceSchema = z.object({
  name: z.string().min(1, "Tên dịch vụ là bắt buộc"),
  fee_type: z.string().min(1, "Loại phí là bắt buộc"),
  pricing_type: z.string().min(1, "Loại đơn giá là bắt buộc"),
  unit_price: z.string().min(1, "Đơn giá là bắt buộc"),
  unit: z.string().optional(),
  quota_id: z.string().optional(),
  building_ids: z.array(z.string()).min(1, "Chọn ít nhất một tòa nhà"),
  description: z.string().optional(),
});

type ServiceFormValues = z.infer<typeof serviceSchema>;

interface CreateServiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateServiceDialog({ open, onOpenChange }: CreateServiceDialogProps) {
  const createService = useCreateService();
  const { data: buildings } = useBuildings();
  const { data: quotas } = useServiceQuotas();

  const form = useForm<ServiceFormValues>({
    resolver: zodResolver(serviceSchema),
    defaultValues: {
      name: "",
      fee_type: "",
      pricing_type: "",
      unit_price: "",
      unit: "",
      quota_id: "",
      building_ids: [],
      description: "",
    },
  });

  const onSubmit = async (data: ServiceFormValues) => {
    try {
      await createService.mutateAsync({
        name: data.name,
        fee_type: data.fee_type as any,
        pricing_type: data.pricing_type as any,
        unit_price: parseFloat(data.unit_price),
        unit: data.unit || null,
        quota_id: data.quota_id || null,
        type: "FIXED", // backward compat default
        description: data.description || null,
        building_ids: data.building_ids,
      });
      form.reset();
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
          <DialogTitle>Thêm dịch vụ</DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-100px)] pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* Tên dịch vụ */}
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

              {/* Loại phí */}
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

              {/* Loại đơn giá */}
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

              {/* Đơn giá */}
              <FormField
                control={form.control}
                name="unit_price"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Đơn giá *</FormLabel>
                    <FormControl>
                      <CurrencyInput
                        value={field.value ? Number(field.value) : 0}
                        onChange={(v) => field.onChange(v ? String(v) : "")}
                        onBlur={field.onBlur}
                        name={field.name}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Đơn vị tính */}
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

              {/* Chọn định mức */}
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

              {/* Tòa nhà sử dụng */}
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

              {/* Mô tả */}
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
                <Button type="submit" disabled={createService.isPending}>
                  {createService.isPending ? "Đang lưu..." : "Lưu"}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
