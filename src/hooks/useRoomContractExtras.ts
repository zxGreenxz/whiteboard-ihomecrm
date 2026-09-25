// =============================================================================
// useRoomContractExtras — đọc PHỤ cho panel "Vòng đời hợp đồng" (Báo cáo LN).
//
// Chỉ lấy những thứ `get_room_cash_lifecycle_v1` không trả: sang nhượng
// (TENANT_CHANGE đổi khách NGAY TRÊN hợp đồng cũ nên không để lại đoạn cư trú
// nào), phòng đích của chuyển phòng, gia hạn, tên + SĐT khách đại diện.
//
// KHÔNG có số tiền nào ở đây. Mọi nguồn đi qua RLS; một nguồn hỏng thì chỉ mất
// các mốc của nó (trả rỗng + `partial`), không làm sập panel — tiền và thứ tự
// cư trú đã có nguồn riêng, fail-closed.
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllRows } from '@/lib/supabaseFetchAll';
import type { RoomContractExtras } from '@/lib/roomContractYear';

interface TransferRow {
  contract_id: string;
  transfer_type: string;
  transfer_date: string | null;
  old_room_id: string | null;
  new_room_id: string | null;
}
interface ExtensionRow {
  contract_id: string;
  extension_date: string | null;
  old_end_date: string | null;
  new_end_date: string | null;
  status: string | null;
}
interface CustomerLinkRow {
  contract_id: string;
  is_representative: boolean;
  customers: { full_name: string | null; phone: string | null } | null;
}

const EXTENSION_BO = new Set(['REJECTED', 'CANCELLED']);

export function useRoomContractExtras(contractIds: string[]) {
  const ids = [...new Set(contractIds)].sort();
  return useQuery({
    queryKey: ['profit-report', 'room-contract-extras', ids],
    enabled: ids.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<RoomContractExtras & { partial: boolean }> => {
      const [transfers, extensions, links] = await Promise.all([
        fetchAllRows<TransferRow>(
          (f, t) => supabase
            .from('contract_transfers')
            .select('id, contract_id, transfer_type, transfer_date, old_room_id, new_room_id')
            .in('contract_id', ids)
            .in('status', ['APPROVED', 'COMPLETED'])
            .order('id', { ascending: true })
            .range(f, t),
          { label: 'room-contract-extras.transfers' },
        ),
        fetchAllRows<ExtensionRow>(
          (f, t) => supabase
            .from('contract_extensions')
            .select('id, contract_id, extension_date, old_end_date, new_end_date, status')
            .in('contract_id', ids)
            .order('id', { ascending: true })
            .range(f, t),
          { label: 'room-contract-extras.extensions' },
        ),
        fetchAllRows<CustomerLinkRow>(
          (f, t) => supabase
            .from('contract_customers')
            .select('id, contract_id, is_representative, customers ( full_name, phone )')
            .in('contract_id', ids)
            .order('id', { ascending: true })
            .range(f, t),
          { label: 'room-contract-extras.customers' },
        ),
      ]);

      // Tên phòng đích của chuyển phòng — chỉ để ghi "Chuyển sang phòng 402".
      const roomIds = [...new Set((transfers ?? []).map((x) => x.new_room_id).filter((x): x is string => !!x))];
      const rooms = roomIds.length
        ? await fetchAllRows<{ id: string; name: string | null }>(
            (f, t) => supabase.from('rooms').select('id, name').in('id', roomIds).order('id', { ascending: true }).range(f, t),
            { label: 'room-contract-extras.rooms' },
          )
        : [];
      const roomName = new Map((rooms ?? []).map((r) => [r.id, r.name]));

      const customers = new Map<string, { name: string | null; phone: string | null }>();
      // Đại diện thắng; không có đại diện thì lấy khách đầu tiên có tên.
      for (const l of [...(links ?? [])].sort((a, b) => Number(b.is_representative) - Number(a.is_representative))) {
        if (customers.has(l.contract_id) || !l.customers?.full_name) continue;
        customers.set(l.contract_id, { name: l.customers.full_name, phone: l.customers.phone });
      }

      return {
        transfers: (transfers ?? []).map((x) => ({
          contractId: x.contract_id,
          type: x.transfer_type,
          date: x.transfer_date,
          oldRoomId: x.old_room_id,
          newRoomId: x.new_room_id,
          newRoomName: x.new_room_id ? roomName.get(x.new_room_id) ?? null : null,
        })),
        extensions: (extensions ?? [])
          .filter((x) => !EXTENSION_BO.has((x.status ?? '').toUpperCase()))
          .map((x) => ({
            contractId: x.contract_id,
            date: x.extension_date,
            oldEndDate: x.old_end_date,
            newEndDate: x.new_end_date,
          })),
        customers,
        partial: transfers === null || extensions === null || links === null || rooms === null,
      };
    },
  });
}
