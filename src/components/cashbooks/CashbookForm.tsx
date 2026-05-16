import { useEffect, useMemo, useState } from "react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useCreateAccount,
  useUpdateAccount,
  type AccountFormValues,
  type AccountWithBalance,
} from "@/hooks/useAccounts";
import { Checkbox } from "@/components/ui/checkbox";
import { useIsMobile } from "@/hooks/use-mobile";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { useStaffUsers } from "@/hooks/useStaffUsers";
import { useAuth } from "@/hooks/useAuth";
import {
  useAccountSharedUsers,
  useSyncAccountSharedUsers,
} from "@/hooks/useAccountSharedUsers";

const schema = z.object({
  name: z.string().min(1, "Tên sổ quỹ bắt buộc").max(120),
  initial_amount: z.coerce.number().min(0, "Số dư đầu kỳ không âm"),
  initial_date: z.string().min(1, "Ngày chốt đầu kỳ bắt buộc"),
  description: z.string().nullable().optional(),
  user_id: z.string().min(1, "Người phụ trách bắt buộc"),
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
  const syncSharedMut = useSyncAccountSharedUsers();
  const isMobile = useIsMobile();
  const { data: isAdmin } = useIsAdmin();
  const { data: currentUser } = useAuth();
  const { data: staffUsers } = useStaffUsers();
  const { data: existingShared } = useAccountSharedUsers(account?.id);

  // Người phụ trách hiện tại của form (theo dõi để loại trừ khỏi list shared).
  const ownerId = account?.user_id ?? currentUser?.id ?? "";

  // Chỉ owner của sổ hoặc admin được sửa danh sách shared.
  const canEditShared = !!isAdmin || (!!currentUser?.id && ownerId === currentUser.id);

  // Local state cho list shared users (multi-select).
  const [sharedIds, setSharedIds] = useState<string[]>([]);

  const defaults = useMemo<FormValues>(
    () => ({
      name: account?.name ?? "",
      initial_amount: Number(account?.initial_amount ?? 0),
      initial_date: account?.initial_date?.slice(0, 10) ?? todayISO(),
      description: account?.description ?? "",
      user_id: account?.user_id ?? currentUser?.id ?? "",
    }),
    [account, currentUser?.id]
  );

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: defaults,
  });

  // Người phụ trách user_id đang chọn (sync với form để loại khỏi list shared).
  const selectedOwnerId = form.watch("user_id") || ownerId;

  useEffect(() => {
    if (open) {
      form.reset(defaults);
      setSharedIds((existingShared ?? []).map((s) => s.user_id));
    }
  }, [open, defaults, form, existingShared]);

  const onSubmit = async (values: FormValues) => {
    const payload: AccountFormValues = {
      name: values.name,
      initial_amount: values.initial_amount,
      initial_date: values.initial_date,
      description: values.description || null,
      // Chỉ admin mới được set/đổi người phụ trách. Non-admin gửi cũng vô hại
      // vì RLS chặn đổi user_id sang user khác (admin_all bypass cho admin).
      user_id: isAdmin ? values.user_id : undefined,
    };

    let accountId: string;
    if (isEditing && account) {
      await updateMut.mutateAsync({ id: account.id, values: payload });
      accountId = account.id;
    } else {
      const created = (await createMut.mutateAsync(payload)) as any;
      accountId = created?.id;
    }

    // Sync shared users (loại owner ra cho chắc — không share với chính mình).
    if (canEditShared && accountId) {
      const cleaned = sharedIds.filter((id) => id && id !== values.user_id);
      await syncSharedMut.mutateAsync({ accountId, userIds: cleaned });
    }

    onOpenChange(false);
  };

  const isPending =
    createMut.isPending || updateMut.isPending || syncSharedMut.isPending;

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

            {isAdmin && (
              <FormField
                control={form.control}
                name="user_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Người phụ trách <span className="text-red-500">*</span>
                    </FormLabel>
                    <Select
                      value={field.value || undefined}
                      onValueChange={field.onChange}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn người phụ trách" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(staffUsers ?? []).map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.full_name || u.email || u.id.slice(0, 8)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

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

            {canEditShared && (
              <div className="space-y-2">
                <div className="text-sm font-medium">
                  Người được phép sử dụng
                </div>
                <p className="text-xs text-muted-foreground">
                  Chọn các user khác cùng được xem &amp; tạo phiếu thu/chi
                  cho sổ quỹ này. Không bao gồm người phụ trách.
                </p>
                {(() => {
                  const candidates = (staffUsers ?? []).filter(
                    (u) => u.id !== selectedOwnerId
                  );
                  if (candidates.length === 0) {
                    return (
                      <p className="text-xs text-muted-foreground italic px-1">
                        Không có user khác để chọn.
                      </p>
                    );
                  }
                  return (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-44 overflow-y-auto border rounded-md p-2">
                      {candidates.map((u) => {
                        const checked = sharedIds.includes(u.id);
                        return (
                          <label
                            key={u.id}
                            className="flex items-start gap-2 text-sm cursor-pointer"
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(v) => {
                                setSharedIds((prev) =>
                                  v
                                    ? [...prev, u.id]
                                    : prev.filter((x) => x !== u.id)
                                );
                              }}
                              className="mt-0.5"
                            />
                            <span className="leading-tight">
                              {u.full_name || u.email || u.id.slice(0, 8)}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            )}

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
