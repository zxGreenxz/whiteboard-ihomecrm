import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';
import type { Database } from '@/integrations/supabase/types';
import {
  createExitCommission, exitEarlyTermsErrorMessage, extendExitHold, readExitEarlyTerms, reopenExitHold, reverseExitSupport, setExitEarlyTerms,
  updateExitBrokerFee,
  type ContractExitEarlyTerms, type CreateExitCommissionInput, type EarlyTermsFilter, type ExitEarlyTermsInvoker, type HoldActionInput, type ReverseExitSupportInput, type SetEarlyTermsInput, type UpdateBrokerFeeInput,
} from '@/lib/contractExitEarlyTerms';

type Functions = Database['public']['Functions'];
// Tên RPC viết thẳng tại nơi gọi để giữ ranh giới kiểu sinh tự động (như useContractExitCases).
const invoke: ExitEarlyTermsInvoker = (name, args) => {
  switch (name) {
    case 'read_contract_exit_early_terms_v1': return supabase.rpc('read_contract_exit_early_terms_v1', args as Functions['read_contract_exit_early_terms_v1']['Args']);
    case 'set_contract_exit_early_terms_v1': return supabase.rpc('set_contract_exit_early_terms_v1', args as Functions['set_contract_exit_early_terms_v1']['Args']);
    case 'update_contract_exit_broker_fee_v1': return supabase.rpc('update_contract_exit_broker_fee_v1', args as Functions['update_contract_exit_broker_fee_v1']['Args']);
    case 'reopen_contract_exit_hold_v1': return supabase.rpc('reopen_contract_exit_hold_v1', args as Functions['reopen_contract_exit_hold_v1']['Args']);
    case 'extend_contract_exit_hold_v1': return supabase.rpc('extend_contract_exit_hold_v1', args as Functions['extend_contract_exit_hold_v1']['Args']);
    case 'create_contract_exit_commission_v1': return supabase.rpc('create_contract_exit_commission_v1', args as Functions['create_contract_exit_commission_v1']['Args']);
    case 'reverse_contract_exit_support_v1': return supabase.rpc('reverse_contract_exit_support_v1', args as Functions['reverse_contract_exit_support_v1']['Args']);
  }
};

export const EXIT_EARLY_TERMS_KEY = 'contract-exit-early-terms';
/** Mọi màn đọc trạng thái phòng, hồ sơ trả phòng và hoa hồng đổi theo trường hợp trả phòng trước hạn. */
const AFFECTED_KEYS = [EXIT_EARLY_TERMS_KEY, 'contract-exit-cases', 'contract-exit-case', 'sale-room-inventory', 'my-available-rooms',
  'phong-trong', 'room-sale-locks', 'rooms', 'contracts', 'contract', 'income-expenses', 'contract-commission-followups', 'deposits'];

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
export function useReverseContractExitSupport() {
  return useEarlyTermsMutation((input: ReverseExitSupportInput, org) => reverseExitSupport(invoke, input, org), 'Đã đảo số tiền khách cũ hỗ trợ khách mới');
}
