import { readSalaryWriteReceipt, salarySettingsErrorMessage } from "@/lib/salarySettingsFeedback";
// Khoản lương định kỳ + số ghi đè từng khoản (migration 20260927081925).
// Đọc gắn vào useManagerSalary (fetchSalaryExtras); ghi qua bốn RPC có cổng
// "super admin hoặc chủ công ty của đúng tổ chức người nhận lương" ở server.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { rpcNullable } from "@/lib/rpcNullable";
import { parseRecurringRows, type RecurringCategory, type RecurringItem, type RecurringKind } from "@/lib/salaryRecurring";
import { parseOverrideRows, type SalLineOverride } from "@/lib/salaryOverrides";

export interface SalaryExtras {
  recurring: RecurringItem[];
  overrides: SalLineOverride[];
  /** false = server chưa có RPC (migration chưa áp) — màn hiện "chưa bật", không phải 0đ. */
  available: boolean;
}

export const EMPTY_SALARY_EXTRAS: SalaryExtras = { recurring: [], overrides: [], available: false };

// Client và migration không lên cùng lúc (Contract §3): thiếu hàm ⇒ coi như chưa bật.
const thieuHam = (e: { code?: string | null } | null | undefined): boolean =>
  e?.code === "PGRST202" || e?.code === "42883";

/**
 * Đọc khoản định kỳ + ghi đè của kỳ cho các tổ chức có cấu hình lương đang xem.
 * Lỗi khác "thiếu hàm" thì NÉM — không được biến thành "không có khoản" vì như
 * vậy lương sẽ thiếu tiền mà không ai biết.
 */
export async function fetchSalaryExtras(orgIds: string[], periodMonth: string): Promise<SalaryExtras> {
  const orgs = [...new Set(orgIds.filter(Boolean))];
  if (!orgs.length) return { recurring: [], overrides: [], available: true };
  const parts = await Promise.all(
    orgs.map(async (org) => {
      const [r, o] = await Promise.all([
        supabase.rpc("salary_recurring_list_v1", { p_organization_id: org, p_period_month: periodMonth }),
        supabase.rpc("salary_line_override_list_v1", { p_organization_id: org, p_period_month: periodMonth }),
      ]);
      if (r.error && !thieuHam(r.error)) throw r.error;
      if (o.error && !thieuHam(o.error)) throw o.error;
      if (thieuHam(r.error) || thieuHam(o.error)) return null;
      return { recurring: parseRecurringRows(r.data), overrides: parseOverrideRows(o.data) };
    }),
  );
  const ok = parts.filter((p): p is { recurring: RecurringItem[]; overrides: SalLineOverride[] } => p !== null);
  if (ok.length < parts.length) return EMPTY_SALARY_EXTRAS;
  return { recurring: ok.flatMap((p) => p.recurring), overrides: ok.flatMap((p) => p.overrides), available: true };
}

/** Người đang đăng nhập có được sửa số tiền lương của tổ chức này không (server quyết). */
export const useSalaryCanEditAmounts = (organizationId: string | null | undefined) =>
  useQuery<boolean>({
    queryKey: ["salary-can-edit-amounts", organizationId],
    enabled: !!organizationId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("salary_can_edit_amounts_v1", { p_organization_id: organizationId as string });
      if (thieuHam(error)) return false;
      if (error) throw error;
      if (typeof data !== "boolean") throw new TypeError("Unconfirmed salary edit permission");
      return data;
    },
  });

/**
 * Khoá idempotency sinh MỘT lần cho mỗi biểu mẫu (lúc mở), không phải mỗi lần bấm:
 * bấm lặp / gửi lại cùng nội dung thì server trả bản đã ghi (lap_lai) thay vì tạo trùng.
 */
export const newSalaryRequestKey = (prefix: "sal-rec" | "sal-recv" | "sal-ovr") => `${prefix}-${crypto.randomUUID()}`;

function useSalaryWrite<I>(run: (input: I) => Promise<{id:string;replayed:boolean}>, ok: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    // Chờ bảng lương tải lại xong rồi mới báo xong: nút giữ "Đang lưu…" và hộp đóng
    // khi số trên màn đã là số mới (không để người dùng thấy số cũ sau khi bấm lưu).
    onSuccess: async (receipt) => {
      await qc.invalidateQueries({ queryKey: ["manager-salary"] });
      toast[receipt.replayed ? "info" : "success"](receipt.replayed ? "Yêu cầu đã được lưu trước đó. Không tạo thêm thay đổi." : ok);
    },
    // Chỉ giữ thông điệp nghiệp vụ đã đối chiếu RPC; lỗi lạ dùng ngữ cảnh an toàn.
    onError: (error: unknown) => toast.error(salarySettingsErrorMessage(error,"lưu thay đổi khoản lương")),
  });
}

export interface CreateRecurringInput {
  staffId: string;
  label: string;
  category: RecurringCategory;
  buildingId: string | null;
  amount: number;
  effectiveMonth: string;
  reason: string;
  note?: string | null;
  requestKey: string;
}

export const useCreateRecurring = () =>
  useSalaryWrite<CreateRecurringInput>(async (i) => {
    const { data, error } = await supabase.rpc("salary_recurring_create_v1", {
      p_staff_id: i.staffId,
      p_label: i.label,
      p_category: i.category,
      p_building_id: rpcNullable(i.buildingId),
      p_amount: i.amount,
      p_effective_month: i.effectiveMonth,
      p_reason: i.reason,
      p_note: rpcNullable(i.note ?? null),
      p_idempotency_key: i.requestKey,
    });
    if (error) throw error;
    return readSalaryWriteReceipt(data,"item_id");
  }, "Đã tạo khoản định kỳ");

export interface AddRecurringVersionInput {
  itemId: string;
  kind: RecurringKind;
  effectiveMonth: string;
  amount: number | null;
  reason: string;
  requestKey: string;
}

export const useAddRecurringVersion = () =>
  useSalaryWrite<AddRecurringVersionInput>(async (i) => {
    const { data, error } = await supabase.rpc("salary_recurring_version_add_v1", {
      p_item_id: i.itemId,
      p_kind: i.kind,
      p_effective_month: i.effectiveMonth,
      p_amount: rpcNullable(i.amount),
      p_reason: i.reason,
      p_idempotency_key: i.requestKey,
    });
    if (error) throw error;
    return readSalaryWriteReceipt(data,"version_id");
  }, "Đã lưu phiên bản mới");

export const useDeleteRecurring = () =>
  useSalaryWrite<{ itemId: string; reason: string }>(async (i) => {
    const { data, error } = await supabase.rpc("salary_recurring_delete_v1", { p_item_id: i.itemId, p_reason: i.reason });
    if (error) throw error;
    return readSalaryWriteReceipt(data,"item_id");
  }, "Đã xoá khoản định kỳ");

export interface SetLineOverrideInput {
  staffId: string;
  periodMonth: string;
  lineKey: string;
  lineLabel: string;
  computed: number;
  /** null = bỏ ghi đè, về lại số máy tính. */
  amount: number | null;
  reason: string;
  requestKey: string;
}

export const useSetLineOverride = () =>
  useSalaryWrite<SetLineOverrideInput>(async (i) => {
    const { data, error } = await supabase.rpc("salary_line_override_set_v1", {
      p_staff_id: i.staffId,
      p_period_month: i.periodMonth,
      p_line_key: i.lineKey,
      p_line_label: i.lineLabel,
      p_computed_amount: i.computed,
      p_amount: rpcNullable(i.amount),
      p_reason: i.reason,
      p_idempotency_key: i.requestKey,
    });
    if (error) throw error;
    return readSalaryWriteReceipt(data,"override_id");
  }, "Đã lưu số tiền mới");
