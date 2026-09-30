import { useEffect, useState, useRef } from "react";
import { useForm, useFieldArray } from "react-hook-form";
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
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, X } from "lucide-react";
import { ServiceQuotaPartialError, useUpdateServiceQuota } from "@/hooks/useServices";
import { focusFirstError } from "@/lib/formErrors";
import { recordWriteBlocked, recordWriteMessage } from "@/lib/recordWriteOutcome";
import type { ServiceQuotaWithTiers } from "@/hooks/useServices";

const tierSchema = z.object({
  from_value: z.string().min(1, "Bắt buộc"),
  to_value: z.string(),
  unit_price: z.string().min(1, "Bắt buộc"),
});

const quotaSchema = z.object({
  name: z.string().min(1, "Tên định mức là bắt buộc"),
  description: z.string().optional(),
  tiers: z.array(tierSchema).min(1, "Cần ít nhất 1 bậc định mức"),
});

type QuotaFormValues = z.infer<typeof quotaSchema>;

interface EditQuotaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quota: ServiceQuotaWithTiers;
}

export function EditQuotaDialog({ open, onOpenChange, quota }: EditQuotaDialogProps) {
  const [failure,setFailure]=useState<unknown>();
  const [blocked,setBlocked]=useState(false);
  const draftKey=useRef<string|null>(null);
  const updateMutation = useUpdateServiceQuota();
  const [partialMessage, setPartialMessage] = useState<string | null>(null);

  const form = useForm<QuotaFormValues>({
    resolver: zodResolver(quotaSchema),
    defaultValues: {
      name: "",
      description: "",
      tiers: [{ from_value: "0", to_value: "", unit_price: "" }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "tiers",
  });

  // Populate form when quota changes
  useEffect(() => {
    if (quota && open) {
      if(draftKey.current===quota.id && (failure || partialMessage || form.formState.isDirty))return;
      draftKey.current=quota.id;setFailure(undefined);setBlocked(false);setPartialMessage(null);
      const sortedTiers = [...(quota.service_quota_tiers || [])].sort(
        (a, b) => a.tier_number - b.tier_number
      );
      form.reset({
        name: quota.name,
        description: quota.description || "",
        tiers:
          sortedTiers.length > 0
            ? sortedTiers.map((t) => ({
                from_value: String(t.from_value),
                to_value: t.to_value != null ? String(t.to_value) : "",
                unit_price: String(t.unit_price),
              }))
            : [{ from_value: "0", to_value: "", unit_price: "" }],
      });
    }
  }, [quota, open, form]);

  const onSubmit = async (data: QuotaFormValues) => {
    // The core quota may already have changed. A second click must not replay
    // the whole update while the tier result is still unresolved.
    if (blocked || partialMessage) return;
    form.clearErrors('root.server');
    try {
      await updateMutation.mutateAsync({
        id: quota.id,
        name: data.name,
        description: data.description || null,
        tiers: data.tiers.map((t, i) => ({
          tier_number: i + 1,
          from_value: Number(t.from_value),
          to_value: t.to_value ? Number(t.to_value) : null,
          unit_price: Number(t.unit_price),
        })),
      });
      onOpenChange(false);
    } catch (error) {
      setFailure(error);setBlocked(recordWriteBlocked(error) || error instanceof ServiceQuotaPartialError);
      if (error instanceof ServiceQuotaPartialError) setPartialMessage(error.message);
      else form.setError('root.server', { type: 'server', message: recordWriteMessage(error,'cập nhật định mức') });
    }
  };

  return (
    <Dialog open={open} onOpenChange={value=>{if(!form.formState.isSubmitting)onOpenChange(value);}}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Cập nhật định mức dịch vụ</DialogTitle>
          <DialogDescription className="sr-only">Sửa thông tin định mức và các bậc giá.</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-100px)] pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit, errors => { void focusFirstError(errors); })} className="space-y-4">
              {partialMessage && <p role="alert" className="rounded-md border border-amber-500 p-3 text-sm">{partialMessage}</p>}
              {form.formState.errors.root?.server?.message && <p role="alert" className="text-sm text-destructive">{form.formState.errors.root.server.message}</p>}
              <fieldset disabled={blocked || form.formState.isSubmitting} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tên định mức *</FormLabel>
                    <FormControl>
                      <Input placeholder="Nhập tên định mức" {...field} />
                    </FormControl>
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

              {/* Tier rows */}
              <div className="space-y-3">
                <FormLabel>Bậc định mức</FormLabel>
                {fields.map((tierField, index) => (
                  <div
                    key={tierField.id}
                    className="border rounded-md p-3 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">
                        Định mức {index + 1}
                      </span>
                      {fields.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-red-600 hover:text-red-700"
                          onClick={() => remove(index)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <FormField
                        control={form.control}
                        name={`tiers.${index}.from_value`}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Từ</FormLabel>
                            <FormControl>
                              <NumberInput
                                allowDecimal
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
                      <FormField
                        control={form.control}
                        name={`tiers.${index}.to_value`}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Đến</FormLabel>
                            <FormControl>
                              <NumberInput
                                allowDecimal
                                placeholder="∞"
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
                      <FormField
                        control={form.control}
                        name={`tiers.${index}.unit_price`}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Đơn giá</FormLabel>
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
                    </div>
                  </div>
                ))}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    append({ from_value: "", to_value: "", unit_price: "" })
                  }
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Thêm định mức
                </Button>
              </div>

              </fieldset>
              <div className="flex justify-end gap-3 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Hủy
                </Button>
                <Button type="submit" disabled={blocked || form.formState.isSubmitting || updateMutation.isPending || !!partialMessage}>
                  {updateMutation.isPending ? "Đang cập nhật..." : "Cập nhật"}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
