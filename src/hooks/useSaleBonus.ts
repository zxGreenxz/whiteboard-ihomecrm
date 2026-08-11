import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { rpcNullable } from "@/lib/rpcNullable";
import { supabase } from '@/integrations/supabase/client';

/**
 * THƯỞNG NÓNG SALE — trạng thái theo hợp đồng, và đường tạo từ PHIẾU CỌC.
 *
 * Vì sao cần hook riêng thay vì dùng `useExistingCommissionVouchers`: hook cũ chỉ
 * tìm phiếu thưởng ĐÃ GẮN hợp đồng. Từ 31/07/2026 thưởng Sale tạo được ngay ở
 * phiếu cọc — lúc đó hợp đồng CHƯA tồn tại nên phiếu thưởng `contract_id` rỗng và
 * hook cũ không thấy nó. Nếu giao diện ký hợp đồng tin hook cũ thì nó sẽ mời người
 * dùng thưởng lần hai cho cùng một thương vụ.
 *
 * `sale_bonus_status_v1` trả lời qua CẢ HAI đường: phiếu gắn thẳng hợp đồng, và
 * phiếu gắn phiếu cọc mà phiếu cọc đó nay đã thuộc hợp đồng.
 */
export interface SaleBonusStatus {
  contractId: string;
  /** true ⇒ ô nhập thưởng phải TÔ XÁM. */
  alreadyPaid: boolean;
  voucherId: string | null;
  code: string | null;
  amount: number | null;
  voucherDate: string | null;
  createdAt: string | null;
  status: string | null;
  /** 'CONTRACT' = thưởng kèm hợp đồng · 'DEPOSIT' = thưởng từ phiếu cọc. */
  via: 'CONTRACT' | 'DEPOSIT' | null;
  /** null = chủ chưa công bố trần ⇒ không chặn số tiền. */
  capAmount: number | null;
  /** Câu tiếng Việt sẵn dùng để hiện cho người dùng. */
  note: string;
}

export const useSaleBonusStatus = (contractId?: string | null, enabled = true) =>
  useQuery({
    queryKey: ['sale-bonus-status', contractId],
    enabled: !!contractId && enabled,
    queryFn: async (): Promise<SaleBonusStatus> => {
      const { data, error } = await supabase.rpc('sale_bonus_status_v1', {
        p_contract_id: rpcNullable(contractId),
      });
      if (error) throw new Error(error.message);
      const d = (data ?? {}) as any;
      return {
        contractId: d.contractId,
        alreadyPaid: !!d.alreadyPaid,
        voucherId: d.voucherId ?? null,
        code: d.code ?? null,
        amount: d.amount == null ? null : Number(d.amount),
        voucherDate: d.voucherDate ?? null,
        createdAt: d.createdAt ?? null,
        status: d.status ?? null,
        via: d.via ?? null,
        capAmount: d.capAmount == null ? null : Number(d.capAmount),
        note: d.note ?? '',
      };
    },
  });

export interface CreateSaleBonusFromDepositArgs {
  depositVoucherId: string;
  amount: number;
  recipient?: string;
  accountNumber?: string;
  bank?: string;
}

/**
 * Tạo phiếu thưởng Sale ngay từ phiếu cọc, lúc hợp đồng chưa tồn tại.
 * Phiếu ra CHỜ DUYỆT — giống hệt đường thưởng kèm hợp đồng.
 */
export const useCreateSaleBonusFromDeposit = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: CreateSaleBonusFromDepositArgs) => {
      const { data, error } = await supabase.rpc('create_sale_bonus_from_deposit_v1', {
        p_deposit_voucher_id: a.depositVoucherId,
        p_amount: a.amount,
        p_recipient: a.recipient ?? undefined,
        p_account_number: a.accountNumber ?? undefined,
        p_bank: a.bank ?? undefined,
        p_voucher_date: undefined,
      });
      if (error) throw new Error(error.message);
      return data as { voucherId: string; code: string; amount: number; note: string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sale-bonus-status'] });
      qc.invalidateQueries({ queryKey: ['income-expenses'] });
      qc.invalidateQueries({ queryKey: ['deposits'] });
    },
  });
};
