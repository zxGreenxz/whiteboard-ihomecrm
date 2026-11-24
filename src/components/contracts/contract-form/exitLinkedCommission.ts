// Hợp đồng khách nhận của ca trả phòng trước hạn (nhờ sale / tự tìm khách sang phòng): máy chủ tự nối hợp đồng mới
// đầu tiên của phòng với hồ sơ cũ (trigger z50_contract_exit_early_terms_link). Ca nhờ sale: hoa hồng môi giới chỉ lập
// từ hồ sơ trả phòng sau quyết toán; ca tự tìm: không hoa hồng môi giới, không thưởng sale. Máy chủ chặn đúng luật;
// ở đây chỉ đọc kết quả nối để giao diện không mời người dùng lập phiếu sai đường.
import { toast } from 'sonner';
import { fetchContractExitEarlyTerms } from '@/hooks/contracts/useContractExitEarlyTerms';
import { contractNumberLabel, isTransferReason, type ContractExitEarlyTerms } from '@/lib/contractExitEarlyTerms';

export type ReceivingExitTerms = ContractExitEarlyTerms & { early_reason: 'SALE_ASSISTED' | 'SELF_FOUND' };

/** Hồ sơ trả phòng (nhờ sale / tự tìm) mà hợp đồng này là hợp đồng khách nhận đã tự nối. */
export function receivingExitTerms(
  rows: readonly ContractExitEarlyTerms[] | null | undefined,
  contractId: string | null | undefined,
): ReceivingExitTerms | undefined {
  if (!contractId) return undefined;
  return rows?.find((row): row is ReceivingExitTerms => row.new_contract_id === contractId && isTransferReason(row.early_reason));
}

const oldContractLabel = (terms: Pick<ContractExitEarlyTerms, 'old_contract_number'>) =>
  terms.old_contract_number?.trim() ? contractNumberLabel(terms.old_contract_number) : 'HĐ cũ';

export const SELF_FOUND_COMMISSION_NOTICE = 'Hợp đồng nhận sang phòng từ khách tự tìm: không có hoa hồng môi giới hay thưởng sale.';

export function saleAssistedBrokerNotice(terms: Pick<ContractExitEarlyTerms, 'old_contract_number'>) {
  return `Hoa hồng môi giới của khách nhận lập từ hồ sơ trả phòng ${oldContractLabel(terms)} sau khi quyết toán.`;
}

export function exitLinkedCommissionToast(terms: ReceivingExitTerms) {
  return terms.early_reason === 'SALE_ASSISTED'
    ? `Hợp đồng đã tự nối với hồ sơ trả phòng ${oldContractLabel(terms)} (nhờ sale). Phiếu hoa hồng môi giới lập sau khi quyết toán khách cũ.`
    : `Hợp đồng đã tự nối với hồ sơ trả phòng ${oldContractLabel(terms)} (khách tự tìm): không có hoa hồng môi giới hay thưởng sale.`;
}

interface OpenCommissionInput {
  contractId: string;
  organizationId: string | null | undefined;
  openCommission: (contractId: string) => void;
}

/**
 * Sau khi tạo hoặc ký hợp đồng: hợp đồng đã tự nối làm khách nhận của ca nhờ sale / tự tìm thì không mở hộp hoa hồng
 * chung mà báo đường lập đúng. Đọc lỗi thì vẫn mở hộp như cũ (máy chủ vẫn chặn đúng trường hợp) và ghi cảnh báo.
 */
export async function openCommissionUnlessExitLinked({ contractId, organizationId, openCommission }: OpenCommissionInput) {
  try {
    if (!organizationId) throw new Error('Chưa chọn tổ chức');
    const linked = receivingExitTerms(await fetchContractExitEarlyTerms({ contractId }, organizationId), contractId);
    if (linked) {
      toast.info(exitLinkedCommissionToast(linked));
      return;
    }
  } catch (error) {
    console.warn('[hop-dong] Chưa đọc được hồ sơ trả phòng trước hạn của hợp đồng vừa tạo; mở hộp hoa hồng như cũ.', error);
  }
  openCommission(contractId);
}
