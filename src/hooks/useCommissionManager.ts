// Hoa hồng của quản lý đi sổ ảo, trả qua lương (migration 20260927155251).
// Ô "QL" ở phiếu hoa hồng chọn quản lý nhận → assign_commission_manager_v1 chuyển phiếu
// (còn Chờ duyệt) sang sổ ảo "Hoa hồng QL chờ trả lương": duyệt sau đó vẫn tính chi phí
// toà nhưng KHÔNG ra tiền sổ thật; tiền trả qua lương của quản lý.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { rpcNullable } from "@/lib/rpcNullable";

export interface CommissionManagerOption {
  staffId: string;
  displayName: string;
  alias: string;
}

/** Quản lý đang hưởng lương của công ty — danh sách chọn cho ô QL. */
export const useCommissionManagerOptions = (organizationId: string | null | undefined) =>
  useQuery({
    queryKey: ["commission-manager-options", organizationId],
    enabled: !!organizationId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<CommissionManagerOption[]> => {
      const { data, error } = await supabase.rpc("commission_manager_options_v1", {
        p_organization_id: organizationId as string,
      });
      if (error) throw new Error(error.message);
      return (data || []).map((r) => ({ staffId: r.staff_id, displayName: r.display_name, alias: r.alias }));
    },
  });

export interface AssignCommissionManagerInput {
  voucherId: string;
  managerId: string;
  /** approval_version đang thấy; null = không đòi khớp (vd ngay sau khi vừa tạo phiếu). */
  expectedVersion?: number | null;
}

export interface AssignCommissionManagerResult {
  voucher_id: string;
  manager_id: string;
  account_id: string;
  approval_version: number;
  moved: boolean;
  lap_lai: boolean;
}

/** Gán phiếu gọi thẳng RPC — dùng được cả trong luồng tạo phiếu (không toast riêng). */
export async function assignCommissionManager(input: AssignCommissionManagerInput): Promise<AssignCommissionManagerResult> {
  const { data, error } = await supabase.rpc("assign_commission_manager_v1", {
    p_voucher_id: input.voucherId,
    p_manager_id: input.managerId,
    p_expected_approval_version: rpcNullable(input.expectedVersion ?? null),
    // Một lần bấm = một khoá: bấm lại sau lỗi mạng là lượt mới, server tự phát lại nếu
    // nội dung trùng liên kết đã có.
    p_idempotency_key: `hhql-${input.voucherId.slice(0, 8)}-${crypto.randomUUID()}`,
  });
  if (error) throw new Error(error.message);
  return data as unknown as AssignCommissionManagerResult;
}

export const useAssignCommissionManager = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: assignCommissionManager,
    onSuccess: async (r) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["manager-salary"] }),
        qc.invalidateQueries({ queryKey: ["income-expenses"] }),
        qc.invalidateQueries({ queryKey: ["accounts-with-balance"] }),
      ]);
      toast.success(r.moved ? "Đã gán quản lý — phiếu chuyển sang sổ ảo, tiền trả qua lương" : "Đã gán quản lý nhận hoa hồng");
    },
    onError: (e: unknown) => toast.error((e as { message?: string } | null)?.message || "Không gán được quản lý"),
  });
};
