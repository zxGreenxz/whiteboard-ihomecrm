import {financialReadRows} from '@/lib/financialReadValidation';
import { voucherFailureMessage } from "@/lib/voucherFeedback";
import { z } from 'zod';
import { readSalarySourceParts } from '@/lib/rentSupportSalary';
// Hoa hồng của quản lý đi sổ ảo, trả qua lương (migration 20260927155251).
// Ô "QL" ở phiếu hoa hồng chọn quản lý nhận → assign_commission_manager_v1 chuyển phiếu
// (còn Chờ duyệt) sang sổ ảo "Hoa hồng QL chờ trả lương": duyệt sau đó vẫn tính chi phí
// toà nhưng KHÔNG ra tiền sổ thật; tiền trả qua lương của quản lý.
import { useContext } from "react";
import { QueryClientContext, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { rpcNullable } from "@/lib/rpcNullable";

export interface CommissionManagerOption {
  staffId: string;
  displayName: string;
  alias: string;
}

/**
 * Công ty của một toà — danh sách QL phải lấy theo công ty CỦA PHIẾU (suy từ toà),
 * không theo công ty đang chọn ở thanh chuyển: chủ nhiều công ty có thể đang đứng ở
 * công ty B mà lập phiếu cho toà của công ty A.
 */
export const useOrganizationOfBuilding = (buildingId: string | null | undefined) =>
  useQuery({
    queryKey: ["building-organization", buildingId],
    enabled: !!buildingId,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase
        .from("buildings")
        .select("organization_id")
        .eq("id", buildingId as string)
        .maybeSingle();
      if (error) throw error;
      return data?.organization_id ?? null;
    },
  });

/**
 * Sau MỌI lần gán (kể cả gọi thẳng trong luồng tạo phiếu): làm mới màn lương. Cache
 * dùng staleTime 60s, không tự tải lại khi quay về tab — không làm mới thì bấm Chốt
 * ngay sau khi gán sẽ chốt trên số cũ, sót phiếu vừa gán.
 */
export async function invalidateAfterCommissionAssign(qc: QueryClient | undefined): Promise<void> {
  if (!qc) return;
  await Promise.all([
    qc.invalidateQueries({ queryKey: ["manager-salary"] }),
    qc.invalidateQueries({ queryKey: ['commission-support'] }),
    qc.invalidateQueries({ queryKey: ["income-expenses"] }),
    qc.invalidateQueries({ queryKey: ["accounts-with-balance"] }),
  ]);
}

/**
 * QueryClient của cây hiện tại, hoặc undefined khi không có provider — form/modal tạo
 * phiếu được test render trần (không QueryClientProvider), useQueryClient() sẽ ném.
 * Trong app luôn có provider nên luôn làm mới được.
 */
export function useOptionalQueryClient(): QueryClient | undefined {
  return useContext(QueryClientContext);
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
      if (error) throw error;
      return financialReadRows(data).map((r) => ({ staffId: r.staff_id, displayName: r.display_name, alias: r.alias }));
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
  if (error) throw error;
  const parsed=z.object({voucher_id:z.string().uuid(),manager_id:z.string().uuid(),account_id:z.string().uuid(),approval_version:z.number().finite(),moved:z.boolean().optional(),lap_lai:z.boolean()}).passthrough().refine(row=>row.lap_lai||row.moved!==undefined).parse(data);
  if(parsed.voucher_id!==input.voucherId||parsed.manager_id!==input.managerId)throw new TypeError("Chưa xác nhận được quản lý nhận hoa hồng của phiếu");
  return {voucher_id:parsed.voucher_id,manager_id:parsed.manager_id,account_id:parsed.account_id,approval_version:parsed.approval_version,moved:parsed.moved??false,lap_lai:parsed.lap_lai};
}

export const useAssignCommissionManager = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: assignCommissionManager,
    onSuccess: async (r) => {
      await invalidateAfterCommissionAssign(qc);
      toast.success(r.moved ? "Đã gán quản lý — phiếu chuyển sang sổ ảo, tiền trả qua lương" : "Đã gán quản lý nhận hoa hồng");
    },
    onError: (e: unknown) => toast.error(voucherFailureMessage(e, "gán quản lý nhận hoa hồng")),
  });
};

export const useCommissionSupport = (voucherId:string,enabled:boolean) => useQuery({
 queryKey:['commission-support',voucherId],enabled,
 queryFn:async()=> (await readSalarySourceParts([voucherId])).get(voucherId) ?? null,
});
