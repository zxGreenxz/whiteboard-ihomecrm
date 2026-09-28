import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';
import { classifyDbError } from '@/lib/contracts/errors';
import {
  buildMoveOutNoticeArgs, invokeMoveOutNotice, moveOutNoticeErrorMessage, parseMoveOutNoticeSnapshot,
  type MoveOutNoticeInput,
} from '@/lib/contractMoveOutNotice';

export function useContractMoveOutNoticeSnapshot(contractId?: string) {
  const { selectedOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ['contracts', 'notice-snapshot', selectedOrganizationId, contractId],
    enabled: !!selectedOrganizationId && !!contractId,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!selectedOrganizationId || !contractId) throw new Error('Chưa chọn hợp đồng');
      const { data, error } = await supabase.rpc('get_contract_move_out_notice_v1', {
        p_organization_id: selectedOrganizationId, p_contract_id: contractId,
      });
      if (error) throw error;
      const snapshot = parseMoveOutNoticeSnapshot(data);
      if (snapshot.contract_id !== contractId || snapshot.organization_id !== selectedOrganizationId) throw new Error('Báo trả không khớp hợp đồng');
      return snapshot;
    },
  });
}

export function useReadContractMoveOutNotice() {
  const { selectedOrganizationId } = useOrganization();
  const mutation = useMutation({
    retry: false,
    mutationFn: async (contractId: string) => {
      if (!selectedOrganizationId) throw new Error('Chưa chọn tổ chức');
      const { data, error } = await supabase.rpc('get_contract_move_out_notice_v1', {
        p_organization_id: selectedOrganizationId, p_contract_id: contractId,
      });
      if (error) throw error;
      const snapshot = parseMoveOutNoticeSnapshot(data);
      if (snapshot.contract_id !== contractId || snapshot.organization_id !== selectedOrganizationId) {
        throw new Error('Báo trả phòng không khớp hợp đồng');
      }
      return snapshot;
    },
  });
  return { ...mutation, selectedOrganizationId };
}

export function useSaveContractMoveOutNotice() {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  const invalidate = (contractId: string) => {
    for (const key of [
      ['contracts'], ['rooms'], ['contract-history', contractId],
      ['my-available-rooms'],
    ]) void queryClient.invalidateQueries({ queryKey: key });
  };
  return useMutation({
    retry: false,
    mutationFn: async (input: Omit<MoveOutNoticeInput, 'organizationId'>) => {
      if (!selectedOrganizationId) throw new Error('Chưa chọn tổ chức');
      const args = buildMoveOutNoticeArgs({ ...input, organizationId: selectedOrganizationId });
      return invokeMoveOutNotice((_name, payload) => supabase.rpc('set_contract_move_out_notice_v1', {
        ...payload,
        // DEFAULT NULL encodes cancellation; generated optional RPC args omit nullable values.
        p_expected_move_out_date: payload.p_expected_move_out_date ?? undefined,
        p_reason: payload.p_reason ?? undefined,
      }), args);
    },
    onSuccess: (snapshot) => {
      invalidate(snapshot.contract_id);
      toast.success(snapshot.expected_move_out_date ? 'Đã lưu ngày dự kiến trả phòng' : 'Đã hủy báo trả phòng — khách ở tiếp');
    },
    onError: (error, input) => {
      if (classifyDbError(error) === 'conflict') invalidate(input.contractId);
      toast.error(moveOutNoticeErrorMessage(error));
    },
  });
}
