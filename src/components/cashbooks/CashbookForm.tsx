import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { useStaffUsers } from "@/hooks/useStaffUsers";
import { useBuildings } from "@/hooks/useBuildings";
import { useAuth } from "@/hooks/useAuth";
import {
  useAccountSharedUsers,
  useSyncAccountSharedUsers,
} from "@/hooks/useAccountSharedUsers";
import { supabase } from "@/integrations/supabase/client";
import { useFinanceV2Routes, isCanonicalAccess } from "@/lib/financeV2Route";

const NO_BUILDING = "__none__";

// =============================================================================
// Finance V2 — phân quyền sổ quỹ CUSTODIAN/KNOWER (route-aware, plan §12).
//
// CHỈ hoạt động khi route `access` của org sổ quỹ là CANONICAL
// (isCanonicalAccess). Khi đó section "Người được phép sử dụng" legacy được
// thay bằng 2 list "Người giữ sổ (CUSTODIAN)" / "Người biết sổ (KNOWER)",
// đọc qua get_cashbook_access_admin_v2 và ghi qua set_cashbook_access_v2
// (CAS revision + idempotency key). KHÔNG có fallback DML legacy — RPC lỗi
// = fail hiển thị lỗi. Org chưa CANONICAL: UI legacy giữ NGUYÊN.
// =============================================================================

export interface CashbookAccessMemberV2 {
  membership_id: string;
  user_id: string;
}

export interface CashbookAccessAdminV2 {
  cashbook_id: string;
  cashbook_name: string | null;
  revision: number;
  custodians: CashbookAccessMemberV2[];
  knowers: CashbookAccessMemberV2[];
  eligible_memberships: CashbookAccessMemberV2[];
}

// RPC v2 chưa có trong generated types cho tới lần regen sau forward-apply.
type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };
const rpcV2 = (fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult> =>
  (supabase.rpc as unknown as (f: string, a?: Record<string, unknown>) => PromiseLike<RpcResult>)(fn, args);

/** organization_id của sổ quỹ — view accounts_with_balance KHÔNG có cột này
 *  nên khi record truyền vào thiếu, đọc trực tiếp từ bảng accounts (read-only). */
export function useCashbookOrgId(
  cashbookId: string | null | undefined,
  knownOrgId?: string | null
) {
  return useQuery({
    queryKey: ["cashbook-org-id", cashbookId],
    enabled: !!cashbookId && !knownOrgId,
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await (supabase
        .from("accounts" as any)
        .select("organization_id") as any)
        .eq("id", cashbookId)
        .maybeSingle();
      if (error) return null;
      return (data as { organization_id?: string | null } | null)?.organization_id ?? null;
    },
  });
}

/** GET phân quyền sổ (admin view). Cần quyền cashbooks.share — lỗi hiển thị,
 *  KHÔNG fallback đọc account_shared_users. */
export function useCashbookAccessAdminV2(
  cashbookId: string | null | undefined,
  enabled: boolean
) {
  return useQuery({
    queryKey: ["cashbook-access-admin-v2", cashbookId],
    enabled: enabled && !!cashbookId,
    retry: false,
    queryFn: async (): Promise<CashbookAccessAdminV2> => {
      const { data, error } = await rpcV2("get_cashbook_access_admin_v2", {
        p_cashbook_id: cashbookId,
      });
      if (error) throw new Error(error.message || "Không tải được phân quyền sổ quỹ");
      return data as CashbookAccessAdminV2;
    },
  });
}

/** Nhãn hiển thị user (full_name ▸ email ▸ id cụt) — 1 query profiles .in('id', …). */
export function useProfileLabels(userIds: string[]) {
  const sorted = Array.from(new Set(userIds)).sort();
  return useQuery({
    queryKey: ["profile-labels", sorted.join(",")],
    enabled: sorted.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, string>> => {
      const { data } = await (supabase
        .from("profiles")
        .select("id, full_name, email" as any) as any)
        .in("id", sorted);
      const map = new Map<string, string>();
      for (const p of ((data as { id: string; full_name?: string | null; email?: string | null }[]) ?? [])) {
        map.set(p.id, p.full_name || p.email || p.id.slice(0, 8));
      }
      return map;
    },
  });
}

/** Checkbox group chọn membership cho 1 vai trò (CUSTODIAN/KNOWER). */
function MembershipChecklist({
  title,
  hint,
  eligible,
  selected,
  onToggle,
  lockedId,
  labels,
}: {
  title: string;
  hint: string;
  eligible: CashbookAccessMemberV2[];
  selected: string[];
  onToggle: (membershipId: string, on: boolean) => void;
  /** Membership của chính actor — server cấm tự đổi vai trò của mình (§2.5). */
  lockedId: string | null;
  labels: Map<string, string> | undefined;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium">{title}</div>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {eligible.length === 0 ? (
        <p className="text-xs text-muted-foreground italic px-1">
          Không có thành viên nào trong tổ chức.
        </p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-44 overflow-y-auto border rounded-md p-2">
          {eligible.map((m) => {
            const checked = selected.includes(m.membership_id);
            const locked = lockedId === m.membership_id;
            return (
              <label
                key={m.membership_id}
                className={
                  "flex items-start gap-2 text-sm " +
                  (locked ? "opacity-60 cursor-not-allowed" : "cursor-pointer")
                }
                title={
                  locked
                    ? "Không thể tự đổi vai trò của chính mình qua form này"
                    : undefined
                }
              >
                <Checkbox
                  checked={checked}
                  disabled={locked}
                  onCheckedChange={(v) => onToggle(m.membership_id, v === true)}
                  className="mt-0.5"
                />
                <span className="leading-tight">
                  {labels?.get(m.user_id) ?? m.user_id.slice(0, 8)}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

const schema = z.object({
  name: z.string().min(1, "Tên sổ quỹ bắt buộc").max(120),
  initial_amount: z.coerce.number().min(0, "Số dư đầu kỳ không âm"),
  initial_date: z.string().min(1, "Ngày chốt đầu kỳ bắt buộc"),
  description: z.string().nullable().optional(),
  quick_default_building_id: z.string().nullable().optional(),
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
  const { data: myPerms } = useMyPermissions();
  const { data: staffUsers } = useStaffUsers();
  const { data: buildings = [] } = useBuildings({ includeVirtual: true });
  const { data: existingShared } = useAccountSharedUsers(account?.id);

  // Người phụ trách hiện tại của form (theo dõi để loại trừ khỏi list shared).
  const ownerId = account?.user_id ?? currentUser?.id ?? "";

  // Chỉ owner của sổ hoặc admin được sửa danh sách shared, VÀ phải có quyền
  // chi tiết cashbooks.share (fallback legacy: cashbooks.edit).
  const canEditShared =
    (!!isAdmin || (!!currentUser?.id && ownerId === currentUser.id)) &&
    canUse(myPerms, "cashbooks", "share");

  // Local state cho list shared users (multi-select) — legacy mode.
  const [sharedIds, setSharedIds] = useState<string[]>([]);

  // ── Finance V2 (route-aware): CUSTODIAN/KNOWER thay list shared khi org
  //    của sổ có access route CANONICAL. Sổ MỚI chưa có org/id → luôn legacy.
  const qc = useQueryClient();
  const v2Routes = useFinanceV2Routes();
  const orgFromAccount = account?.organization_id ?? null;
  const orgIdQuery = useCashbookOrgId(
    open && isEditing ? account?.id : null,
    orgFromAccount
  );
  const cashbookOrgId = orgFromAccount ?? orgIdQuery.data ?? null;
  const v2AccessMode =
    isEditing && isCanonicalAccess(v2Routes.getOrg(cashbookOrgId));

  const accessQuery = useCashbookAccessAdminV2(
    account?.id ?? null,
    open && v2AccessMode && canEditShared
  );
  const access = accessQuery.data ?? null;

  const [custodianIds, setCustodianIds] = useState<string[]>([]);
  const [knowerIds, setKnowerIds] = useState<string[]>([]);
  useEffect(() => {
    if (open && access) {
      setCustodianIds(access.custodians.map((c) => c.membership_id));
      setKnowerIds(access.knowers.map((k) => k.membership_id));
    }
  }, [open, access]);

  const accessUserIds = access
    ? [
        ...access.eligible_memberships,
        ...access.custodians,
        ...access.knowers,
      ].map((m) => m.user_id)
    : [];
  const { data: profileLabels } = useProfileLabels(accessUserIds);

  // Membership của chính actor — server cấm tự đổi vai trò mình (42501).
  const myMembershipId =
    access?.eligible_memberships.find((m) => m.user_id === currentUser?.id)
      ?.membership_id ?? null;

  const setAccessMut = useMutation({
    mutationFn: async (args: {
      cashbookId: string;
      custodians: string[];
      knowers: string[];
      expectedRevision: number;
    }) => {
      const { data, error } = await rpcV2("set_cashbook_access_v2", {
        p_cashbook_id: args.cashbookId,
        p_custodians: args.custodians,
        p_knowers: args.knowers,
        p_expected_revision: args.expectedRevision,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) {
        if (error.code === "55000") {
          throw new Error("Danh sách quyền vừa được người khác sửa — tải lại");
        }
        throw new Error(error.message || "Không thể cập nhật phân quyền sổ quỹ");
      }
      return data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({
        queryKey: ["cashbook-access-admin-v2", vars.cashbookId],
      });
    },
    onError: (e: Error, vars) => {
      toast.error(e.message);
      // Refetch để lấy revision/danh sách mới nhất (nhất là khi stale 55000).
      qc.invalidateQueries({
        queryKey: ["cashbook-access-admin-v2", vars.cashbookId],
      });
    },
  });

  const defaults = useMemo<FormValues>(
    () => ({
      name: account?.name ?? "",
      initial_amount: Number(account?.initial_amount ?? 0),
      initial_date: account?.initial_date?.slice(0, 10) ?? todayISO(),
      description: account?.description ?? "",
      quick_default_building_id: account?.quick_default_building_id ?? null,
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
      quick_default_building_id: values.quick_default_building_id || null,
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

    if (canEditShared && accountId) {
      if (v2AccessMode) {
        // Finance V2 CANONICAL: ghi phân quyền qua set_cashbook_access_v2
        // (CAS revision + idempotency). KHÔNG fallback DML account_shared_users.
        if (access) {
          const sameSet = (a: string[], b: string[]) =>
            a.length === b.length &&
            [...a].sort().join("|") === [...b].sort().join("|");
          const origCustodians = access.custodians.map((c) => c.membership_id);
          const origKnowers = access.knowers.map((k) => k.membership_id);
          if (
            !sameSet(custodianIds, origCustodians) ||
            !sameSet(knowerIds, origKnowers)
          ) {
            await setAccessMut.mutateAsync({
              cashbookId: accountId,
              custodians: custodianIds,
              knowers: knowerIds,
              expectedRevision: access.revision,
            });
          }
        }
      } else {
        // Legacy: sync shared users (loại owner ra cho chắc — không share với chính mình).
        const cleaned = sharedIds.filter((id) => id && id !== values.user_id);
        await syncSharedMut.mutateAsync({ accountId, userIds: cleaned });
      }
    }

    onOpenChange(false);
  };

  const isPending =
    createMut.isPending ||
    updateMut.isPending ||
    syncSharedMut.isPending ||
    setAccessMut.isPending;

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

            <FormField
              control={form.control}
              name="quick_default_building_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tòa nhà mặc định khi tạo phiếu nhanh</FormLabel>
                  <Select
                    value={field.value ?? NO_BUILDING}
                    onValueChange={(v) =>
                      field.onChange(v === NO_BUILDING ? null : v)
                    }
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="— Không gán —" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NO_BUILDING}>— Không gán —</SelectItem>
                      {buildings.map((b: any) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.name}
                          {b.code ? ` (${b.code})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Khi tạo phiếu nhanh và chọn tòa nhà này, sổ quỹ sẽ được tự
                    chọn (vẫn đổi lại được).
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />

            {canEditShared && v2AccessMode && (
              <div className="space-y-3">
                {accessQuery.isLoading ? (
                  <p className="text-xs text-muted-foreground italic px-1">
                    Đang tải phân quyền sổ quỹ...
                  </p>
                ) : accessQuery.isError || !access ? (
                  <p className="text-xs text-red-600 px-1">
                    {(accessQuery.error as Error | null)?.message ||
                      "Không tải được phân quyền sổ quỹ"}
                  </p>
                ) : (
                  <>
                    <MembershipChecklist
                      title="Người giữ sổ (CUSTODIAN)"
                      hint="Trực tiếp giữ tiền — được Thu/Chi (ghi sổ) trên sổ quỹ này."
                      eligible={access.eligible_memberships}
                      selected={custodianIds}
                      lockedId={myMembershipId}
                      labels={profileLabels}
                      onToggle={(mid, on) =>
                        setCustodianIds((prev) =>
                          on
                            ? prev.includes(mid)
                              ? prev
                              : [...prev, mid]
                            : prev.filter((x) => x !== mid)
                        )
                      }
                    />
                    <MembershipChecklist
                      title="Người biết sổ (KNOWER)"
                      hint="Được xem sổ quỹ và số dư — không được Thu/Chi."
                      eligible={access.eligible_memberships}
                      selected={knowerIds}
                      lockedId={myMembershipId}
                      labels={profileLabels}
                      onToggle={(mid, on) =>
                        setKnowerIds((prev) =>
                          on
                            ? prev.includes(mid)
                              ? prev
                              : [...prev, mid]
                            : prev.filter((x) => x !== mid)
                        )
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Vai trò của chính bạn bị khóa — tự đổi vai trò phải qua
                      quy trình riêng.
                    </p>
                  </>
                )}
              </div>
            )}

            {canEditShared && !v2AccessMode && (
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
