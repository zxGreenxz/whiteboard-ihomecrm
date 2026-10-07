import { supabase } from '@/integrations/supabase/client';
import { ACTIVE_CONTRACT_STATUSES, type ContractStatus } from '@/types/contract';
import type { CT01Building } from './ct01Document';

export interface CT01Tenancy {
  roomId: string;
  roomNumber: string;
  /** Hợp đồng đang ở tương ứng — hồ sơ tạm trú gắn ảnh theo hợp đồng này. */
  contractId: string;
  building: CT01Building;
}

/** Đọc theo session/RLS hiện tại; chỉ lấy tòa của hợp đồng đang ở. */
export async function loadCT01Tenancies(customerId: string): Promise<CT01Tenancy[]> {
  const { data, error } = await supabase.from('contract_customers').select(`
    contract:contracts!contract_customers_contract_id_fkey!inner(
      id, status, deleted_at,
      room:rooms!contracts_room_id_fkey!inner(
        id, name, deleted_at,
        building:buildings!rooms_building_id_fkey!inner(id, name, street_address, ward, district, province, organization_id, deleted_at)
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
      tenancies.set(room.id, { roomId: room.id, roomNumber: room.name, contractId: contract.id, building });
    }
  }
  return [...tenancies.values()].sort((left, right) =>
    left.building.name.localeCompare(right.building.name, 'vi') || left.roomNumber.localeCompare(right.roomNumber, 'vi', { numeric: true }));
}

/** Phòng khách từng ở, để lập hồ sơ xoá đăng ký tạm trú. */
export interface CT01XoaTenancy extends CT01Tenancy {
  contractStatus: ContractStatus;
  /** yyyy-mm-dd: ngày thanh lý thực tế, không có thì ngày dự kiến chuyển đi, không có nữa thì null. */
  endDate: string | null;
}

// Nháp chưa từng có người ở nên không có gì để xoá đăng ký.
const XOA_STATUSES: ContractStatus[] = ['ACTIVE', 'EXTENDED', 'TERMINATED', 'EXPIRED', 'TRANSFERRED'];

/**
 * Như loadCT01Tenancies nhưng gồm cả hợp đồng đã thanh lý / hết hạn / chuyển phòng:
 * khách đi rồi mới xoá đăng ký tạm trú. Mỗi phòng giữ hợp đồng gần nhất; phòng có
 * ngày kết thúc mới nhất đứng đầu, phòng còn đang ở (chưa có ngày) xếp sau.
 */
export async function loadCT01XoaTenancies(customerId: string): Promise<CT01XoaTenancy[]> {
  const { data, error } = await supabase.from('contract_customers').select(`
    contract:contracts!contract_customers_contract_id_fkey!inner(
      id, status, start_date, actual_end_date, expected_move_out_date, deleted_at,
      room:rooms!contracts_room_id_fkey!inner(
        id, name, deleted_at,
        building:buildings!rooms_building_id_fkey!inner(id, name, street_address, ward, district, province, organization_id, deleted_at)
      )
    )
  `).eq('customer_id', customerId)
    .in('contract.status', XOA_STATUSES)
    .is('contract.deleted_at', null)
    .is('contract.room.deleted_at', null)
    .is('contract.room.building.deleted_at', null);
  if (error) throw error;
  const theoPhong = new Map<string, { tenancy: CT01XoaTenancy; startDate: string }>();
  for (const link of data ?? []) {
    const contract = link.contract;
    const room = contract?.room;
    const building = room?.building;
    if (!contract || !XOA_STATUSES.includes(contract.status) || contract.deleted_at || !room || room.deleted_at || !building || building.deleted_at) continue;
    const startDate = contract.start_date ?? '';
    const daCo = theoPhong.get(room.id);
    if (daCo && daCo.startDate >= startDate) continue;
    theoPhong.set(room.id, {
      startDate,
      tenancy: {
        roomId: room.id, roomNumber: room.name, contractId: contract.id, building,
        contractStatus: contract.status,
        endDate: contract.actual_end_date ?? contract.expected_move_out_date ?? null,
      },
    });
  }
  return [...theoPhong.values()]
    .sort((a, b) => (b.tenancy.endDate ?? '').localeCompare(a.tenancy.endDate ?? '') || b.startDate.localeCompare(a.startDate))
    .map(x => x.tenancy);
}
