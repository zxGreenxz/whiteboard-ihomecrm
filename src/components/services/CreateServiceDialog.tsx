import { useState, useRef } from "react";
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
  ServiceLinksPartialError,
  FEE_TYPE_LABELS,
  PRICING_TYPE_LABELS,
  UNIT_OPTIONS,
  useServiceQuotas,
} from "@/hooks/useServices";
import { useBuildings } from "@/hooks/useBuildings";
import { focusFirstError } from "@/lib/formErrors";
import { recordWriteBlocked, recordWriteMessage } from "@/lib/recordWriteOutcome";

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
  const [failure,setFailure]=useState<unknown>();
  const [blocked,setBlocked]=useState(false);
  const draftKey=useRef<string|null>(null);
  const createService = useCreateService();
  const [partialServiceId, setPartialServiceId] = useState<string | null>(null);
  const buildingsQuery=useBuildings();
  const quotasQuery=useServiceQuotas();
  const {data:buildings}=buildingsQuery;
  const {data:quotas}=quotasQuery;
  const sourceBlocked=[buildingsQuery,quotasQuery].some(query=>query.isError||query.isLoading);

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
    if (blocked || sourceBlocked || partialServiceId) return;
    form.clearErrors('root.server');
    try {
      await createService.mutateAsync({
        name: data.name,
        fee_type: data.fee_type as any,
        pricing_type: data.pricing_type as any,
        unit_price: Number(data.unit_price),
        unit: data.unit || null,
        quota_id: data.quota_id || null,
        type: "FIXED", // backward compat default
        description: data.description || null,
        building_ids: data.building_ids,
      });
      form.reset();
      onOpenChange(false);
    } catch (error) {
      setFailure(error);setBlocked(recordWriteBlocked(error) || error instanceof ServiceLinksPartialError);
      if (error instanceof ServiceLinksPartialError) {
        setPartialServiceId(error.serviceId);
      } else {
        form.setError('root.server', { type: 'server', message: recordWriteMessage(error,'tạo dịch vụ') });
      }
    }
  };

  const watchedBuildingIds = form.watch("building_ids");

  return (
    <Dialog open={open} onOpenChange={value=>{if(!form.formState.isSubmitting)onOpenChange(value);}}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[550px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Thêm dịch vụ</DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-100px)] pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit, errors => { void focusFirstError(errors); })} className="space-y-4">
              {partialServiceId && <div role="alert" className="rounded-md border border-amber-500 p-3 text-sm">
                Dịch vụ đã tạo với ID {partialServiceId}, nhưng chưa gán đủ tòa. Đóng biểu mẫu, mở dịch vụ này trong danh sách để kiểm tra; không tạo lại.
              </div>}
              {form.formState.errors.root?.server?.message && <p role="alert" className="text-sm text-destructive">{form.formState.errors.root.server.message}</p>}
              {/* Tên dịch vụ */}
              {sourceBlocked && <div role="alert" className="rounded border border-destructive p-3 text-sm">Chưa tải đủ tòa hoặc định mức. Tải lại trước khi lưu dịch vụ.<Button type="button" variant="outline" onClick={()=>{void buildingsQuery.refetch();void quotasQuery.refetch();}}>Tải lại dữ liệu</Button></div>}
              <fieldset disabled={blocked || sourceBlocked || form.formState.isSubmitting} className="space-y-4">
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

              </fieldset>
              <div className="flex justify-end gap-3 pt-4">
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Hủy
                </Button>
                <Button type="submit" disabled={blocked || sourceBlocked || form.formState.isSubmitting || createService.isPending || !!partialServiceId}>
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
