import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';
import { useOrganization } from '@/contexts/OrganizationContext';
import {
  listRoomSaleLocks, lockRoomForSale, releaseRoomSaleLock,
  type LockRoomInput, type SaleLockRpcInvoker,
} from '@/lib/roomSaleLockRpc';

type Functions = Database['public']['Functions'];
const invoke: SaleLockRpcInvoker = (name, args) => {
  switch (name) {
    case 'lock_room_for_sale_v1': return supabase.rpc('lock_room_for_sale_v1', args as Functions['lock_room_for_sale_v1']['Args']);
    case 'release_room_sale_lock_v1': return supabase.rpc('release_room_sale_lock_v1', args as Functions['release_room_sale_lock_v1']['Args']);
    case 'list_room_sale_locks_v1': return supabase.rpc('list_room_sale_locks_v1', args as Functions['list_room_sale_locks_v1']['Args']);
  }
};

/** Lock tạm còn hạn trong tổ chức (Quản lý cọc). Hết hạn tự rơi khỏi danh sách ở lần tải sau. */
export function useRoomSaleLocks(enabled = true) {
  const { selectedOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ['room-sale-locks', selectedOrganizationId],
    queryFn: () => listRoomSaleLocks(invoke, selectedOrganizationId!),
    enabled: enabled && !!selectedOrganizationId,
    retry: false,
    refetchInterval: 60_000,
  });
}

/** Lock/gỡ đổi ngay danh sách phòng trống (trong app và link công khai) và khối lock ở Quản lý cọc. */
const AFFECTED_KEYS = ['room-sale-locks', 'my-available-rooms', 'phong-trong'];
function useSaleLockMutation<Input>(fn: (org: string, input: Input) => ReturnType<typeof lockRoomForSale>) {
  const { selectedOrganizationId } = useOrganization();
  const cache = useQueryClient();
  return useMutation({
    meta: { handlesFeedback: true },
    retry: false,
    mutationFn: (input: Input) => {
      if (!selectedOrganizationId) throw { code: '42501', message: 'Chưa chọn tổ chức' };
      return fn(selectedOrganizationId, input);
    },
    onSettled: () => Promise.all(AFFECTED_KEYS.map((queryKey) => cache.invalidateQueries({ queryKey: [queryKey] }))),
  });
}
export function useLockRoomForSale() {
  return useSaleLockMutation((org: string, input: LockRoomInput) => lockRoomForSale(invoke, org, input));
}
export function useReleaseRoomSaleLock() {
  return useSaleLockMutation((org: string, lockId: string) => releaseRoomSaleLock(invoke, org, lockId));
}
