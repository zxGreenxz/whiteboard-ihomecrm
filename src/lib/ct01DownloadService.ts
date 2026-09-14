import { supabase } from '@/integrations/supabase/client';
import { ACTIVE_CONTRACT_STATUSES } from '@/types/contract';
import type { CT01Building } from './ct01Document';

export interface CT01Tenancy {
  roomId: string;
  roomNumber: string;
  building: CT01Building;
}

/** Đọc theo session/RLS hiện tại; chỉ lấy tòa của hợp đồng đang ở. */
export async function loadCT01Tenancies(customerId: string): Promise<CT01Tenancy[]> {
  const { data, error } = await supabase.from('contract_customers').select(`
    contract:contracts!contract_customers_contract_id_fkey!inner(
      status, deleted_at,
      room:rooms!contracts_room_id_fkey!inner(
        id, name, deleted_at,
        building:buildings!rooms_building_id_fkey!inner(id, name, street_address, ward, district, province, deleted_at)
      )
    )
  `).eq('customer_id', customerId)
    .in('contract.status', ACTIVE_CONTRACT_STATUSES)
    .is('contract.deleted_at', null)
    .is('contract.room.deleted_at', null)
    .is('contract.room.building.deleted_at', null);
  if (error) throw error;
  const tenancies = new Map<string, CT01Tenancy>();
  for (const link of data ?? []) {
    const contract = link.contract;
    const room = contract?.room;
    const building = room?.building;
    if (contract && ACTIVE_CONTRACT_STATUSES.includes(contract.status) && !contract.deleted_at && room && !room.deleted_at && building && !building.deleted_at) {
      tenancies.set(room.id, { roomId: room.id, roomNumber: room.name, building });
    }
  }
  return [...tenancies.values()].sort((left, right) =>
    left.building.name.localeCompare(right.building.name, 'vi') || left.roomNumber.localeCompare(right.roomNumber, 'vi', { numeric: true }));
}
