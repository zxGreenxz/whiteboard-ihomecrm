import {runFinancialPending} from '@/lib/financialPendingAction';
import {useOrganization} from '@/contexts/OrganizationContext';
import {getSessionUser} from '@/lib/authSession';
import {financialReadNumber,financialReadRows} from '@/lib/financialReadValidation';
import { parseGeneratedFeeReceipt } from "@/lib/feeFeedback";
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface SpecialFeePreviewRow {
  buildingId: string;
  buildingName: string;
  feeCategory: string;
  amount: number | null;
  providerCode: string | null;
  status: 'SẼ_SINH' | 'ĐÃ_SINH' | 'ĐÃ_CÓ_PHIẾU' | 'KHÔNG_ÁP_DỤNG' | 'THIẾU_GIÁ';
  reason: string | null;
  existingCode: string | null;
}

export const FEE_LABEL: Record<string, string> = {
  tien_nha: 'Tiền nhà', dien: 'Tiền điện', nuoc: 'Tiền nước',
  internet: 'Internet', quan_ly: 'Quản lý', ve_sinh: 'Vệ sinh',
  cong_an: 'Công an', rac: 'Rác', thang_may: 'Thang máy',
};

/**
 * Xem trước lượt sinh phiếu phí cố định của một kỳ.
 *
 * CHỈ ĐỌC — chạy được cả khi cờ `special_fee.generate.v1` chưa bật, để chủ soi
 * trước rồi mới quyết. `staleTime` ngắn vì trạng thái đổi ngay sau khi sinh.
 */
export const useSpecialFeePreview = (period: string, buildingIds?: string[], enabled = true) => {
  const key = buildingIds && buildingIds.length ? [...buildingIds].sort() : null;
  return useQuery({
    queryKey: ['special-fee-preview', period, key],
    enabled: enabled && !!period,
    staleTime: 10_000,
    queryFn: async (): Promise<SpecialFeePreviewRow[]> => {
      const { data, error } = await supabase.rpc('preview_special_fees_v1', {
        p_period: period,
        // `p_building_ids uuid[] DEFAULT NULL` → bỏ hẳn khoá thay vì truyền null.
        p_building_ids: key ?? undefined,
      });
      if (error) throw error;
      return financialReadRows(data).map((r: any) => ({
        buildingId: r.building_id,
        buildingName: r.building_name,
        feeCategory: r.fee_category,
        amount: r.amount == null ? null : financialReadNumber(r.amount),
        providerCode: r.provider_code ?? null,
        status: r.status,
        reason: r.reason ?? null,
        existingCode: r.existing_code ?? null,
      }));
    },
  });
};

export interface GenerateResult {
  period: string;
  created: number;
  /** Bao nhiêu phiếu đã TỰ DUYỆT + vào sổ (chỉ khác 0 khi có chọn sổ quỹ). */
  posted: number;
  totalAmount: number;
  voucherIds: string[];
  note: string;
}

/**
 * Sinh hàng loạt. Server có ba lớp chống trùng (sổ claim + loại ô đã có phiếu
 * duyệt + khoá theo kỳ) nên bấm hai lần không đẻ hai lượt.
 *
 * `accountId` quyết định phiếu ra ở trạng thái nào:
 *   • KHÔNG chọn sổ ⇒ phiếu ra CHỜ DUYỆT, y như trước.
 *   • CÓ chọn sổ ⇒ ô nào đóng đúng giá chủ đã công bố thì phiếu tự duyệt và vào
 *     sổ luôn; ô lệch giá vẫn nằm chờ duyệt. Sổ phải là sổ THẬT (không phải sổ ảo)
 *     vì đây là tiền ra khỏi két.
 */
export const useGenerateSpecialFees = () => {
  const qc = useQueryClient();
  const {selectedOrganizationId}=useOrganization();
  return useMutation({
    meta: {handlesFeedback: true},
    mutationFn: async (
      a: { period: string; buildingIds: string[]; accountId?: string | null },
    ): Promise<GenerateResult> => {
      const user=await getSessionUser();
      return runFinancialPending({namespace:'special-fee-generate',userId:user?.id??'',organizationId:selectedOrganizationId??'',businessKey:[a.period,...[...a.buildingIds].sort()].join(':')},async progress=>{
      const { data, error } = await supabase.rpc('generate_special_fees_v1', {
        p_period: a.period,
        p_building_ids: a.buildingIds,
        p_idempotency_key: progress.requestKey,
        p_account_id: a.accountId ?? undefined,
      });
      if (error) throw error;
      const receipt=parseGeneratedFeeReceipt(data);
      if(receipt.period!==a.period)throw new TypeError("Kỳ của biên nhận chưa khớp yêu cầu");
      progress.recordCompleted(receipt.voucherIds);
      return receipt;
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['special-fee-preview'] });
      qc.invalidateQueries({ queryKey: ['period-fee-status'] });
      qc.invalidateQueries({ queryKey: ['income-expenses'] });
    },
  });
};
