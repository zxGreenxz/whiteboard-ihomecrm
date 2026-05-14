import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
import { DateInput } from "@/components/ui/date-input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  useCreateAccount,
  useUpdateAccount,
  type AccountFormValues,
  type AccountWithBalance,
} from "@/hooks/useAccounts";
import { useIsMobile } from "@/hooks/use-mobile";

const schema = z.object({
  name: z.string().min(1, "Tên sổ quỹ bắt buộc").max(120),
  initial_amount: z.coerce.number().min(0, "Số dư đầu kỳ không âm"),
  initial_date: z.string().min(1, "Ngày chốt đầu kỳ bắt buộc"),
  description: z.string().nullable().optional(),
});

type FormValues = z.infer<typeof schema>;

interface CashbookFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: AccountWithBalance | null; // null = thêm
}

const todayISO = () => new Date().toISOString().slice(0, 10);

const CashbookForm = ({ open, onOpenChange, account }: CashbookFormProps) => {
  const isEditing = !!account;
  const createMut = useCreateAccount();
  const updateMut = useUpdateAccount();
  const isMobile = useIsMobile();

  const defaults = useMemo<FormValues>(
    () => ({
      name: account?.name ?? "",
      initial_amount: Number(account?.initial_amount ?? 0),
      initial_date: account?.initial_date?.slice(0, 10) ?? todayISO(),
      description: account?.description ?? "",
    }),
    [account]
  );

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: defaults,
  });

  useEffect(() => {
    if (open) form.reset(defaults);
  }, [open, defaults, form]);

  const onSubmit = async (values: FormValues) => {
    const payload: AccountFormValues = {
      name: values.name,
      initial_amount: values.initial_amount,
      initial_date: values.initial_date,
      description: values.description || null,
    };

    if (isEditing && account) {
      await updateMut.mutateAsync({ id: account.id, values: payload });
    } else {
      await createMut.mutateAsync(payload);
    }
    onOpenChange(false);
  };

  const isPending = createMut.isPending || updateMut.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={
          isMobile
            ? "max-w-full w-full h-[100vh] !top-0 !left-0 !translate-x-0 !translate-y-0 rounded-none p-4 overflow-y-auto"
            : "max-w-xl"
        }
      >
        <DialogHeader>
          <DialogTitle className="uppercase tracking-wide">
            {isEditing ? "Cập nhật sổ quỹ" : "Thêm sổ quỹ"}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Tên sổ quỹ <span className="text-red-500">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="initial_amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Số dư đầu kỳ</FormLabel>
                    <FormControl>
                      <CurrencyInput
                        value={field.value}
                        onChange={field.onChange}
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
                name="initial_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ngày chốt số dư đầu kỳ</FormLabel>
                    <FormControl>
                      <DateInput
                        value={field.value || ''}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mô tả</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={3}
                      placeholder="Ghi chú thêm về sổ quỹ (tuỳ chọn)"
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                Huỷ bỏ
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? "Đang lưu..." : "Lưu"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default CashbookForm;
