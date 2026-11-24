import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';
import {
  createExitCommission, exitEarlyTermsErrorMessage, extendExitHold, readExitEarlyTerms, reopenExitHold, setExitEarlyTerms,
  updateExitBrokerFee,
  type ContractExitEarlyTerms, type CreateExitCommissionInput, type EarlyTermsFilter, type ExitEarlyTermsInvoker,
  type ExitEarlyTermsRpcError, type HoldActionInput, type SetEarlyTermsInput, type UpdateBrokerFeeInput,
} from '@/lib/contractExitEarlyTerms';

/**
 * Ranh giới kiểu TẠM cho RPC chưa có trong `types.ts` sinh tự động — migration
 * 20261124075933_tra_phong_truoc_han_ba_truong_hop chưa lên production nên generator chưa thấy các hàm này.
 * Cùng khuôn `goiRpcCongTuDuyet` (selfApproveGate) / `goiRpcQuyetToan` (useLandlordSettlement): ép
 * `supabase.rpc` chứ không ép `supabase`, tên RPC vẫn viết thẳng tại nơi gọi.
 * Khi migration đã áp production và `npm run gen:types` chạy lại: đổi từng nhánh switch bên dưới sang
 * `supabase.rpc('<tên>', args as Functions['<tên>']['Args'])` có kiểu (như useContractExitCases), XOÁ hàm bọc này
 * và chạy `node scripts/check-raw-rpc-callers.mjs --write` nếu gate yêu cầu.
 */
const goiRpcTruongHopTraPhong = (
  tenHam: string,
  args: Record<string, unknown>,
): PromiseLike<{ data: unknown; error: ExitEarlyTermsRpcError | null }> =>
  (supabase.rpc as unknown as (
    name: string,
    params: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: ExitEarlyTermsRpcError | null }>)(tenHam, args);

const invoke: ExitEarlyTermsInvoker = (name, args) => {
  switch (name) {
    case 'read_contract_exit_early_terms_v1': return goiRpcTruongHopTraPhong('read_contract_exit_early_terms_v1', args);
    case 'set_contract_exit_early_terms_v1': return goiRpcTruongHopTraPhong('set_contract_exit_early_terms_v1', args);
    case 'update_contract_exit_broker_fee_v1': return goiRpcTruongHopTraPhong('update_contract_exit_broker_fee_v1', args);
    case 'reopen_contract_exit_hold_v1': return goiRpcTruongHopTraPhong('reopen_contract_exit_hold_v1', args);
    case 'extend_contract_exit_hold_v1': return goiRpcTruongHopTraPhong('extend_contract_exit_hold_v1', args);
    case 'create_contract_exit_commission_v1': return goiRpcTruongHopTraPhong('create_contract_exit_commission_v1', args);
  }
};

export const EXIT_EARLY_TERMS_KEY = 'contract-exit-early-terms';
/** Mọi màn đọc trạng thái phòng, hồ sơ trả phòng và hoa hồng đổi theo trường hợp trả phòng trước hạn. */
const AFFECTED_KEYS = [EXIT_EARLY_TERMS_KEY, 'contract-exit-cases', 'contract-exit-case', 'sale-room-inventory', 'my-available-rooms',
  'phong-trong', 'room-sale-locks', 'rooms', 'contracts', 'contract', 'income-expenses', 'contract-commission-followups'];

function filterKey(filter: EarlyTermsFilter | null) {
  if (!filter) return null;
  if ('contractId' in filter) return ['contract', filter.contractId];
  if ('exitCaseId' in filter) return ['case', filter.exitCaseId];
  return ['room', filter.roomId];
}

/** Đọc trường hợp theo hợp đồng (cũ hoặc mới), theo hồ sơ, hoặc theo phòng (chỉ hồ sơ còn chờ nối). */
export function useContractExitEarlyTerms(filter: EarlyTermsFilter | null, enabled = true) {
  const { selectedOrganizationId } = useOrganization();
  return useQuery({
    queryKey: [EXIT_EARLY_TERMS_KEY, selectedOrganizationId, filterKey(filter)],
    enabled: enabled && !!filter && !!selectedOrganizationId,
    retry: false,
    queryFn: () => {
      if (!selectedOrganizationId || !filter) throw { code: '42501', message: 'Chưa chọn tổ chức' };
      return readExitEarlyTerms(invoke, filter, selectedOrganizationId);
    },
  });
}

/** Đọc một lần ngoài React Query (vd ngay sau khi tạo hợp đồng để biết hợp đồng vừa nối với hồ sơ cũ chưa). */
export function fetchContractExitEarlyTerms(filter: EarlyTermsFilter, organizationId: string): Promise<ContractExitEarlyTerms[]> {
  return readExitEarlyTerms(invoke, filter, organizationId);
}

function useEarlyTermsMutation<Input>(run: (input: Input, organizationId: string) => Promise<ContractExitEarlyTerms>, success: string) {
  const { selectedOrganizationId } = useOrganization();
  const cache = useQueryClient();
  return useMutation({
    meta: { handlesFeedback: true },
    retry: false,
    mutationFn: (input: Input) => {
      if (!selectedOrganizationId) throw { code: '42501', message: 'Chưa chọn tổ chức' };
      return run(input, selectedOrganizationId);
    },
    onSuccess: () => { toast.success(success); },
    onError: error => { toast.error(exitEarlyTermsErrorMessage(error)); },
    onSettled: () => Promise.all(AFFECTED_KEYS.map(key => cache.invalidateQueries({ queryKey: [key] }))),
  });
}

export function useSetContractExitEarlyTerms() {
  return useEarlyTermsMutation((input: SetEarlyTermsInput, org) => setExitEarlyTerms(invoke, input, org), 'Đã lưu trường hợp trả phòng trước hạn');
}
export function useUpdateContractExitBrokerFee() {
  return useEarlyTermsMutation((input: UpdateBrokerFeeInput, org) => updateExitBrokerFee(invoke, input, org), 'Đã sửa phí môi giới');
}
export function useReopenContractExitHold() {
  return useEarlyTermsMutation((input: HoldActionInput, org) => reopenExitHold(invoke, input, org), 'Đã mở bán lại phòng');
}
export function useExtendContractExitHold() {
  return useEarlyTermsMutation((input: HoldActionInput, org) => extendExitHold(invoke, input, org), 'Đã giữ tiếp phòng cho khách sang nhượng');
}
export function useCreateContractExitCommission() {
  return useEarlyTermsMutation((input: CreateExitCommissionInput, org) => createExitCommission(invoke, input, org), 'Đã lập phiếu hoa hồng môi giới');
}
