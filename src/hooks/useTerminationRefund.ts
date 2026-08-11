import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { rpcNullable } from "@/lib/rpcNullable";
import { supabase } from '@/integrations/supabase/client';

export type ObligationStatus = 'OK' | 'VUOT_COC_THAT' | 'CHUA_TUNG_VAO_KET';

export interface RefundPreview {
  terminationId: string;
  contractId: string;
  requestedAmount: number;
  realHeld: number;
  recognizedOnly: number;
  basisStatus: string;
  basisFingerprint: string;
  obligationStatus: ObligationStatus;
  warning: string | null;
}

export const OBLIGATION_LABEL: Record<ObligationStatus, string> = {
  OK: 'Khớp cọc thật',
  VUOT_COC_THAT: 'Hoàn vượt cọc thật',
  CHUA_TUNG_VAO_KET: 'Cọc chưa từng vào két',
};

/**
 * Xem trước nghĩa vụ hoàn cọc của một hồ sơ thanh lý.
 *
 * Đối chiếu số trên hồ sơ với cọc THẬT đã thu, thay vì tin con số nhập tay. Trên
 * production 30/07/2026 có 9/38 hồ sơ mà số hoàn vượt cọc thật (tổng 13.292.000đ)
 * — đây là thứ chỉ ra chúng.
 */
export const useRefundPreview = (terminationId: string | null) =>
  useQuery({
    queryKey: ['termination-refund-preview', terminationId],
    enabled: !!terminationId,
    staleTime: 15_000,
    queryFn: async (): Promise<RefundPreview> => {
      const { data, error } = await supabase.rpc('preview_termination_refund_v1', {
        p_termination_id: rpcNullable(terminationId),
      });
      if (error) throw new Error(error.message);
      const d = data as any;
      return {
        terminationId: d.terminationId,
        contractId: d.contractId,
        requestedAmount: Number(d.requestedAmount ?? 0),
        realHeld: Number(d.realHeld ?? 0),
        recognizedOnly: Number(d.recognizedOnly ?? 0),
        basisStatus: d.basisStatus,
        basisFingerprint: d.basisFingerprint,
        obligationStatus: d.obligationStatus,
        warning: d.warning ?? null,
      };
    },
  });

/** Chốt nghĩa vụ thành một dòng BẤT BIẾN (sửa thì tăng version, không đè dòng cũ). */
export const useRecordObligation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (terminationId: string) => {
      const { data, error } = await supabase.rpc('record_termination_refund_obligation_v1', { p_termination_id: terminationId });
      if (error) throw new Error(error.message);
      return data as { obligationId: string; version: number; obligationStatus: ObligationStatus };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['termination-refund-preview'] }),
  });
};

/**
 * Sinh phiếu hoàn từ nghĩa vụ. Phiếu ra CHỜ DUYỆT.
 *
 * `force` chỉ dùng khi nghĩa vụ đang cảnh báo, và server đòi CHỦ TỔ CHỨC + lý do
 * ≥8 ký tự — lý do được ghi vào ghi chú phiếu làm dấu vết.
 */
export const useCreateRefundVoucher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: {
      obligationId: string; accountId?: string | null;
      force?: boolean; forceReason?: string;
    }) => {
      const { data, error } = await supabase.rpc('create_termination_refund_voucher_v1', {
          p_obligation_id: a.obligationId,
          p_account_id: a.accountId ?? undefined,
          p_force: a.force ?? false,
          p_force_reason: a.forceReason ?? undefined,
        });
      if (error) throw new Error(error.message);
      return data as { voucherId: string; code: string; amount: number; alreadyCreated?: boolean };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['termination-refund-preview'] });
      qc.invalidateQueries({ queryKey: ['income-expenses'] });
    },
  });
};
