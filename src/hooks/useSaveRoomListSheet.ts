import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { requireAccountWriteReceipt } from '@/lib/accountSettingsWriteReceipt';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useSession } from '@/hooks/useAuth';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { useSaleRoomInventory } from '@/hooks/useSaleRoomInventory';
import { canUse } from '@/lib/permissionPages';
import { patchSaleRoom, SaleRoomOperationError, type PatchSaleRoomInput, type SaleRoomPatch, type SaleRoomRpcInvoker } from '@/lib/saleRoomOperations';
import type { RoomChange, RoomField, SheetChanges } from '@/components/sale-phong/roomListSheetDraft';

export const sheetKey = {
  phone: (id: string) => `phone:${id}`,
  policy: (id: string) => `policy:${id}`,
  field: (field: RoomField, id: string) => `${field}:${id}`,
};
const ROOM_COLUMNS = {
  saleNote: { column: 'sale_note', key: sheetKey.policy },
  rentPrice: { column: 'rent_price', key: (id: string) => sheetKey.field('price', id) },
  area: { column: 'area', key: (id: string) => sheetKey.field('type', id) },
  roomType: { column: 'room_type', key: (id: string) => sheetKey.field('type', id) },
  amenities: { column: 'amenities', key: (id: string) => sheetKey.field('amenities', id) },
  saleStatusNote: { column: 'sale_status_note', key: (id: string) => sheetKey.field('status', id) },
  saleStatusKey: { column: 'sale_status_note_key', key: (id: string) => sheetKey.field('status', id) },
} as const;
export function sheetCellKeys(changes: SheetChanges): string[] {
  const keys = new Set(changes.buildings.map(b => sheetKey.phone(b.id)));
  for (const room of changes.rooms) {
    for (const [field, spec] of Object.entries(ROOM_COLUMNS)) {
      if (room[field as keyof RoomChange] !== undefined) keys.add(spec.key(room.id));
    }
  }
  return [...keys];
}
export function sheetRoomPatch(room: RoomChange): SaleRoomPatch {
  return Object.fromEntries(Object.entries(ROOM_COLUMNS).flatMap(([field, spec]) => {
    const value = room[field as keyof RoomChange];
    return value === undefined ? [] : [[spec.column, value]];
  })) as SaleRoomPatch;
}
export interface SheetRoomRequest { input: PatchSaleRoomInput; keys: string[] }
export interface SheetSaveRequest {
  organizationId: string;
  actorId: string;
  buildings: Array<{ id: string; phone: string | null; originalPhone: string | null }>;
  rooms: SheetRoomRequest[];
}
export class RoomListSheetSaveError extends Error {
  constructor(readonly savedKeys: string[], readonly total: number, readonly failure: unknown,
    readonly failedRoomId?: string, readonly failedBuildingId?: string) {
    super(`Mới lưu ${savedKeys.length}/${total} ô của bảng phòng trống.`);
    this.name = 'RoomListSheetSaveError';
  }
}
const invoke: SaleRoomRpcInvoker = (name, args) => {
  const rpc = supabase.rpc as unknown as SaleRoomRpcInvoker;
  return rpc.call(supabase, name, args);
};
/** Rooms use the same CAS writer and durable receipt as QuickBoard/Hermes. */
export function useSaveRoomListSheet() {
  const cache = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  const { data: session } = useSession();
  const permissions = useMyPermissions();
  const inventory = useSaleRoomInventory();
  const context = useRef({ selectedOrganizationId, actor: session?.user.id, permissions, inventory });
  context.current = { selectedOrganizationId, actor: session?.user.id, permissions, inventory };
  return useMutation({
    meta: { handlesFeedback: true }, retry: false,
    mutationFn: async (request: SheetSaveRequest): Promise<string[]> => {
      const saved: string[] = [];
      const total = request.buildings.length + request.rooms.reduce((n, row) => n + row.keys.length, 0);
      let failedRoomId: string | undefined;
      let failedBuildingId: string | undefined;
      const assertContext = () => {
        const current = context.current;
        if (current.selectedOrganizationId !== request.organizationId || current.actor !== request.actorId
          || current.inventory.isError || !current.inventory.data) {
          throw new SaleRoomOperationError('Phạm vi hoặc dữ liệu đã thay đổi. Đọc lại trước khi lưu tiếp; bản nháp vẫn được giữ.', 'rejected', '42501');
        }
        return current;
      };
      try {
        if (request.rooms.length > 50) throw new SaleRoomOperationError('Mỗi lần lưu tối đa 50 phòng.', 'rejected', '22023');
        for (const building of request.buildings) {
          failedBuildingId = building.id;
          const current = assertContext();
          if (current.permissions.isError || !canUse(current.permissions.data, 'sale_phong', 'manage_settings', building.id)
            || !current.inventory.data?.buildings.some(row => row.id === building.id)) {
            throw new SaleRoomOperationError('Không còn quyền sửa liên hệ của tòa này.', 'rejected', '42501');
          }
          // Inventory formats phone text for display. Read the exact stored value so
          // legacy empty strings/spacing do not cause a false CAS conflict.
          const read = await supabase.from('buildings').select('id,public_contact_phone')
            .eq('id', building.id).eq('organization_id', request.organizationId).maybeSingle();
          if (read.error) throw read.error;
          assertContext();
          if (!read.data || read.data.id !== building.id) throw new SaleRoomOperationError('Không đọc được liên hệ của tòa này.', 'rejected', '42501');
          const rawPhone = read.data.public_contact_phone;
          if ((rawPhone?.trim() || null) === building.phone) { saved.push(sheetKey.phone(building.id)); continue; }
          if ((rawPhone?.trim() || null) !== (building.originalPhone?.trim() || null)) throw new SaleRoomOperationError('SĐT của tòa đã đổi. Tải lại để đối chiếu.', 'conflict', 'PT409');
          let query = supabase.from('buildings').update({ public_contact_phone: building.phone })
            .eq('id', building.id).eq('organization_id', request.organizationId);
          query = rawPhone === null ? query.is('public_contact_phone', null)
            : query.eq('public_contact_phone', rawPhone);
          const { data, error } = await query.select('id,public_contact_phone').maybeSingle();
          if (error) throw error;
          if (!data) throw new SaleRoomOperationError('SĐT của tòa đã đổi. Tải lại để đối chiếu.', 'conflict', 'PT409');
          requireAccountWriteReceipt(data, { id: building.id, public_contact_phone: building.phone });
          saved.push(sheetKey.phone(building.id));
        }
        failedBuildingId = undefined;
        for (const row of request.rooms) {
          failedRoomId = row.input.roomId;
          const current = assertContext();
          if (!current.inventory.data?.rooms.find(room => room.room.id === row.input.roomId)?.capabilities.edit) {
            throw new SaleRoomOperationError('Không còn quyền sửa phòng này.', 'rejected', '42501');
          }
          await patchSaleRoom(invoke, request.organizationId, row.input);
          saved.push(...row.keys);
        }
        return saved;
      } catch (error) {
        throw new RoomListSheetSaveError(saved, total, error, failedRoomId, failedBuildingId);
      }
    },
    onSettled: () => Promise.all(['sale-room-inventory', 'my-available-rooms', 'phong-trong', 'buildings', 'rooms']
      .map(key => cache.invalidateQueries({ queryKey: [key] }))),
  });
}
