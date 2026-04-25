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
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Banknote, Wallet, Smartphone } from "lucide-react";
import {
  useCreateAccount,
  useUpdateAccount,
  type AccountFormValues,
  type AccountType,
  type AccountWithBalance,
} from "@/hooks/useAccounts";

const schema = z
  .object({
    type: z.enum(["cash", "bank", "ewallet"]),
    name: z.string().min(1, "Tên tài khoản bắt buộc").max(120),
    initial_amount: z.coerce.number().min(0, "Số dư đầu kỳ không âm"),
    initial_date: z.string().min(1, "Ngày chốt đầu kỳ bắt buộc"),
    description: z.string().nullable().optional(),
    bank_name: z.string().nullable().optional(),
    account_number: z.string().nullable().optional(),
    bank_account_holder: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === "bank") {
      if (!data.bank_name?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "Vui lòng chọn ngân hàng",
          path: ["bank_name"],
        });
      }
      if (!data.account_number?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "Số tài khoản bắt buộc",
          path: ["account_number"],
        });
      }
      if (!data.bank_account_holder?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "Tên chủ tài khoản bắt buộc",
          path: ["bank_account_holder"],
        });
      }
    } else if (data.type === "ewallet") {
      if (!data.account_number?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "Số tài khoản bắt buộc",
          path: ["account_number"],
        });
      }
      if (!data.bank_account_holder?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "Tên chủ tài khoản bắt buộc",
          path: ["bank_account_holder"],
        });
      }
    }
  });

type FormValues = z.infer<typeof schema>;

interface CashbookFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: AccountWithBalance | null; // null = thêm
}

const TYPE_OPTIONS: {
  value: AccountType;
  label: string;
  icon: typeof Wallet;
}[] = [
  { value: "cash", label: "Tiền mặt", icon: Wallet },
  { value: "bank", label: "Ngân hàng", icon: Banknote },
  { value: "ewallet", label: "Ví điện tử", icon: Smartphone },
];

const todayISO = () => new Date().toISOString().slice(0, 10);

const CashbookForm = ({ open, onOpenChange, account }: CashbookFormProps) => {
  const isEditing = !!account;
  const createMut = useCreateAccount();
  const updateMut = useUpdateAccount();

  const defaults = useMemo<FormValues>(
    () => ({
      type: account?.type ?? "cash",
      name: account?.name ?? "",
      initial_amount: Number(account?.initial_amount ?? 0),
      initial_date: account?.initial_date?.slice(0, 10) ?? todayISO(),
      description: account?.description ?? "",
      bank_name: account?.bank_name ?? "",
      account_number: account?.account_number ?? "",
      bank_account_holder: account?.bank_account_holder ?? "",
      branch: account?.branch ?? "",
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

  const type = form.watch("type");
  const showBankFields = type === "bank" || type === "ewallet";

  const onSubmit = async (values: FormValues) => {
    const payload: AccountFormValues = {
      name: values.name,
      type: values.type,
      initial_amount: values.initial_amount,
      initial_date: values.initial_date,
      description: values.description || null,
      bank_name: showBankFields ? values.bank_name || null : null,
      account_number: showBankFields ? values.account_number || null : null,
      bank_account_holder: showBankFields
        ? values.bank_account_holder || null
        : null,
      branch: values.type === "bank" ? values.branch || null : null,
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
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="uppercase tracking-wide">
            {isEditing
              ? "Cập nhật tài khoản"
              : "Thêm tài khoản ngân hàng/tiền mặt"}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Loại tài khoản <span className="text-red-500">*</span>
                  </FormLabel>
                  <div className="grid grid-cols-3 gap-2">
                    {TYPE_OPTIONS.map((opt) => {
                      const Icon = opt.icon;
                      const active = field.value === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => field.onChange(opt.value)}
                          className={`relative flex flex-col items-center justify-center gap-2 p-4 rounded-lg border-2 transition-all ${
                            active
                              ? "border-primary bg-primary/5"
                              : "border-border bg-background hover:border-mono/50 hover:bg-accent/50"
                          }`}
                        >
                          <Icon className="h-5 w-5" />
                          <span className="text-sm font-medium">
                            {opt.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Tên tài khoản <span className="text-red-500">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="VD: Quỹ tiền mặt 102" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {type === "bank" && (
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="bank_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Ngân hàng <span className="text-red-500">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder="VD: Vietcombank"
                          {...field}
                          value={field.value ?? ""}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="account_number"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Số tài khoản <span className="text-red-500">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ""} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="bank_account_holder"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Tên chủ tài khoản{" "}
                        <span className="text-red-500">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ""} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="branch"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Chi nhánh</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="VD: CN Hà Nội"
                          {...field}
                          value={field.value ?? ""}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            {type === "ewallet" && (
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="account_number"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Số tài khoản <span className="text-red-500">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ""} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="bank_account_holder"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Tên chủ tài khoản{" "}
                        <span className="text-red-500">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ""} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="initial_amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Số dư đầu kỳ</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        step="1000"
                        {...field}
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
                      <Input type="date" {...field} />
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
                      placeholder="Ghi chú thêm về tài khoản (tuỳ chọn)"
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
