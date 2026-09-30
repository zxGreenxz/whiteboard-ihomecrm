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
import { friendlyError } from "@/lib/friendlyError";

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
      const { data, error } = await supabase.rpc(
        "list_ie_accounting_standard_v1",
      );
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được Chuẩn kế toán của tổ chức. Tải lại trước khi thay đổi cấu hình.');
      return data as OrgAccountingStandard[];
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
      const { data, error } = await supabase.rpc(
        "set_ie_accounting_standard_v1",
        {
          p_organization_id: input.organizationId,
          p_strict: input.strict,
          p_reason: input.reason ?? undefined,
        },
      );
      if (error) throw error;
      if (!data || typeof data !== 'object' || !('organization_id' in data) || !('strict_mode' in data) || !('changed' in data) ||
          data.organization_id !== input.organizationId || typeof data.strict_mode !== 'boolean' || typeof data.changed !== 'boolean') {
        throw new Error('Chưa xác nhận được kết quả đổi Chuẩn kế toán. Tải lại trạng thái tổ chức trước khi thao tác tiếp.');
      }
      return data as { organization_id: string; strict_mode: boolean; changed: boolean };
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ACCOUNTING_STANDARD_QUERY_KEY });
      // Cờ chế độ đi chung kênh với route Finance V2 — phải làm mới cả hai,
      // nếu không giao diện thu chi vẫn hiển thị theo chế độ cũ tới 60 giây.
      qc.invalidateQueries({ queryKey: ["finance-v2-routes"] });
      if (!result.changed) {
        toast.info("Chuẩn kế toán không thay đổi");
        return;
      }
      toast.success(
        result.strict_mode
            ? "Đã bật chế độ Chuẩn kế toán."
            : "Đã tắt chế độ Chuẩn kế toán.",
      );
    },
    onError: (error: unknown) => {
      const feedback = friendlyError(error, "Chưa đổi được Chuẩn kế toán", { operation: "đổi Chuẩn kế toán", financial: true });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};
