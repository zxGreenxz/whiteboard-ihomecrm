import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/contexts/OrganizationContext';
import { SaleRoomOperationError } from '@/lib/saleRoomOperations';
import {
  saveSaleRoomPolicy, cancelSaleRoomPolicy, type SalePolicyRpcInvoker,
  type SaveSalePolicyInput, type CancelSalePolicyInput,
} from '@/lib/saleRoomWorkflow';

const invoke: SalePolicyRpcInvoker = (name, args) => {
  const rpc = supabase.rpc as unknown as SalePolicyRpcInvoker;
  return rpc.call(supabase, name, args);
};

export function useSaleRoomPolicy({ refreshAfterWrite = true }: { refreshAfterWrite?: boolean } = {}) {
  const { selectedOrganizationId } = useOrganization();
  const cache = useQueryClient();
  const organizationId = () => {
    if (!selectedOrganizationId) throw new SaleRoomOperationError('Chọn tổ chức trước khi cập nhật.', 'rejected', '42501');
    return selectedOrganizationId;
  };
  const invalidate = () => Promise.all(['sale-room-inventory', 'rooms', 'my-available-rooms', 'phong-trong']
    .map(key => cache.invalidateQueries({ queryKey: [key] })));
  const save = useMutation({ meta: { handlesFeedback: true }, retry: false,
    mutationFn: (input: SaveSalePolicyInput) => saveSaleRoomPolicy(invoke, organizationId(), input), onSettled: refreshAfterWrite ? invalidate : undefined });
  const cancel = useMutation({ meta: { handlesFeedback: true }, retry: false,
    mutationFn: (input: CancelSalePolicyInput) => cancelSaleRoomPolicy(invoke, organizationId(), input), onSettled: refreshAfterWrite ? invalidate : undefined });
  return { save, cancel, refresh: invalidate };
}
