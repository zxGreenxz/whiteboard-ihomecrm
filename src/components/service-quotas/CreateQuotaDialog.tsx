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
import { useCreateServiceQuota } from "@/hooks/useServices";

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

  const onSubmit = async (data: QuotaFormValues) => {
    try {
      await createMutation.mutateAsync({
        name: data.name,
        description: data.description || null,
        tiers: data.tiers.map((t, i) => ({
          tier_number: i + 1,
          from_value: parseFloat(t.from_value) || 0,
          to_value: t.to_value ? parseFloat(t.to_value) : null,
          unit_price: parseFloat(t.unit_price) || 0,
        })),
      });
      form.reset();
      onOpenChange(false);
    } catch {
      // handled by mutation
    }
  };

  const handleOpenChange = (value: boolean) => {
    if (!value) form.reset();
    onOpenChange(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Thêm định mức dịch vụ</DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-100px)] pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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

              <div className="flex justify-end gap-3 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                >
                  Hủy
                </Button>
                <Button type="submit" disabled={createMutation.isPending}>
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
