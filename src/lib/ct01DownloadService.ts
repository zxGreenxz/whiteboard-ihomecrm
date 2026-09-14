import { supabase } from '@/integrations/supabase/client';
import { ACTIVE_CONTRACT_STATUSES } from '@/types/contract';
import type { CT01Building } from './ct01Document';

/** Đọc theo session/RLS hiện tại; chỉ lấy tòa của hợp đồng đang ở. */
export async function loadCT01Buildings(customerId: string): Promise<CT01Building[]> {
  const { data, error } = await supabase.from('contract_customers').select(`
    contract:contracts!contract_customers_contract_id_fkey!inner(
      status, deleted_at,
      room:rooms!contracts_room_id_fkey!inner(
        deleted_at,
        building:buildings!rooms_building_id_fkey!inner(id, name, street_address, ward, district, province, deleted_at)
      )
    )
  `).eq('customer_id', customerId)
    .in('contract.status', ACTIVE_CONTRACT_STATUSES)
    .is('contract.deleted_at', null)
    .is('contract.room.deleted_at', null)
    .is('contract.room.building.deleted_at', null);
  if (error) throw error;
  const buildings = new Map<string, CT01Building>();
  for (const link of data ?? []) {
    const contract = link.contract;
    const room = contract?.room;
    const building = room?.building;
    if (contract && ACTIVE_CONTRACT_STATUSES.includes(contract.status) && !contract.deleted_at && room && !room.deleted_at && building && !building.deleted_at) {
      buildings.set(building.id, building);
    }
  }
  return [...buildings.values()].sort((left, right) => left.name.localeCompare(right.name, 'vi'));
}
