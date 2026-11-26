import { useEffect, useState } from "react";
import { useForm, useFieldArray } from "react-hook-form";
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
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, X } from "lucide-react";
import { ServiceQuotaPartialError, useCreateServiceQuota } from "@/hooks/useServices";
import { focusFirstError } from "@/lib/formErrors";
import { recordWriteMessage } from "@/lib/recordWriteOutcome";

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

interface CreateQuotaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateQuotaDialog({ open, onOpenChange }: CreateQuotaDialogProps) {
  const createMutation = useCreateServiceQuota();
  // Đợt 9 (luật 5): tạo định mức không còn khoá form. Kết quả chưa rõ chỉ báo. Định mức đã tạo mà chưa ghi xong bậc giá: hộp
  // giữ mã định mức đó, khoá tên / mô tả (bậc vẫn sửa được) và gửi kèm mã ở lần Lưu sau để hook ghi lại đúng bộ bậc cho đúng
  // định mức đó (đọc lại trước: đã xoá thì tạo mới). Đóng hộp là bỏ qua: quên mã, xoá nội dung (định mức vẫn nằm trong danh sách).
  const [partial, setPartial] = useState<{ id: string; message: string } | null>(null);

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
  useEffect(() => { if (!open && partial) { setPartial(null); form.reset(); } }, [open, partial, form]);

  const onSubmit = async (data: QuotaFormValues) => {
    if (createMutation.isPending) return;
    form.clearErrors('root.server');
    try {
      await createMutation.mutateAsync({
        name: data.name,
        description: data.description || null,
        tiers: data.tiers.map((t, i) => ({
          tier_number: i + 1,
          from_value: Number(t.from_value),
          to_value: t.to_value ? Number(t.to_value) : null,
          unit_price: Number(t.unit_price),
        })),
        ...(partial ? { continueId: partial.id } : {}),
      });
      setPartial(null);
      form.reset();
      onOpenChange(false);
    } catch (error) {
      if (error instanceof ServiceQuotaPartialError) setPartial({ id: error.quotaId, message: error.message });
      else form.setError('root.server', { type: 'server', message: recordWriteMessage(error,'tạo định mức') });
    }
  };

  const handleOpenChange = (value: boolean) => {
    if(form.formState.isSubmitting || createMutation.isPending)return;
    onOpenChange(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[600px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Thêm định mức dịch vụ</DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-100px)] pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit, errors => { void focusFirstError(errors); })} className="space-y-4">
              {partial && <div role="alert" className="rounded-md border border-amber-500 p-3 text-sm">{partial.message} Tên và mô tả định mức đã khoá cho tới khi ghi xong bậc giá; đóng hộp để bỏ qua (định mức đã tạo vẫn nằm trong danh sách).</div>}
              {form.formState.errors.root?.server?.message && <p role="alert" className="text-sm text-destructive">{form.formState.errors.root.server.message}</p>}
              <fieldset disabled={form.formState.isSubmitting} className="space-y-4">
              <fieldset disabled={!!partial} className="space-y-4">
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
              </fieldset>

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
                  onClick={() => handleOpenChange(false)}
                >
                  Hủy
                </Button>
                <Button type="submit" disabled={form.formState.isSubmitting || createMutation.isPending}>
                  {createMutation.isPending ? "Đang lưu..." : "Lưu"}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
