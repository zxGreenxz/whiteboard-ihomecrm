// Công tắc "Chuẩn kế toán" theo TỔ CHỨC (Đợt 1).
//
// Nguồn sự thật: app_private.org_accounting_mode (sổ append-only) đọc qua RPC.
// Thiếu dòng = CHẶT (fail-closed) — org mới không tự nhiên được nới lỏng.
//
// GOTCHA án lệ: mẫu cũ `set_ie_auto_approve_threshold_v1` suy ra tổ chức bằng
// `min(organization_id::text)` nên chủ có 2 org bấm ở đâu cũng ghi vào ORG THẬT
// (`aaaa0000-…` < `dddd0000-…`). Ở đây tổ chức là THAM SỐ BẮT BUỘC và hook luôn
// truyền id tường minh từ dòng người dùng bấm.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface OrgAccountingStandard {
  organization_id: string;
  organization_name: string;
  /** true = cơ chế chặt hiện tại; false = thu chi linh hoạt. */
  strict_mode: boolean;
  /** Chỉ Chủ sở hữu tổ chức (hoặc super admin) mới đổi được. */
  can_manage: boolean;
}

export const ACCOUNTING_STANDARD_QUERY_KEY = ["ie-accounting-standard"] as const;

export const useAccountingStandard = () =>
  useQuery({
    queryKey: ACCOUNTING_STANDARD_QUERY_KEY,
    queryFn: async (): Promise<OrgAccountingStandard[]> => {
      const { data, error } = await (supabase.rpc as any)(
        "list_ie_accounting_standard_v1",
      );
      if (error) throw new Error(error.message);
      return (data ?? []) as OrgAccountingStandard[];
    },
  });

export const useSetAccountingStandard = () => {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      organizationId: string;
      strict: boolean;
      reason?: string | null;
    }) => {
      const { data, error } = await (supabase.rpc as any)(
        "set_ie_accounting_standard_v1",
        {
          p_organization_id: input.organizationId,
          p_strict: input.strict,
          p_reason: input.reason ?? null,
        },
      );
      if (error) throw new Error(error.message);
      return data as { organization_id: string; strict_mode: boolean; changed: boolean };
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ACCOUNTING_STANDARD_QUERY_KEY });
      // Cờ chế độ đi chung kênh với route Finance V2 — phải làm mới cả hai,
      // nếu không giao diện thu chi vẫn hiển thị theo chế độ cũ tới 60 giây.
      qc.invalidateQueries({ queryKey: ["finance-v2-routes"] });
      toast.success(
        result?.changed === false
          ? "Chế độ không đổi"
          : result?.strict_mode
            ? "Đã bật Chuẩn kế toán — thu chi quay lại cơ chế chặt"
            : "Đã tắt Chuẩn kế toán — thu chi chuyển sang cơ chế linh hoạt",
      );
    },
    onError: (error: Error) => {
      toast.error(error.message || "Không đổi được chế độ");
    },
  });
};
