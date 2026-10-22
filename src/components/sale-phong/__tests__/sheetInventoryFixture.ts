import type { Building } from '@/pages/phong-trong/sampleData';
import type { SaleRoomInventory } from '@/lib/saleRoomOperations';
import { ownPhone } from '../roomListSheetDraft';

export function sheetInventoryFixture(buildings: Building[]): SaleRoomInventory {
  return {
    buildings: buildings.map(building => ({ ...building, contactPhone: ownPhone(building) })),
    serverNow: '2026-10-21T01:00:00Z', nextPolicyBoundaryAt: null, settingsOwnerId: 'actor-a', canManageAccountSettings: true,
    rooms: buildings.flatMap(building => building.rooms.map(room => ({
      room, buildingId: building.id, buildingName: building.name, name: room.code, code: room.code,
      revision: 'a'.repeat(32), updatedAt: '2026-10-21T01:00:00Z', updatedByName: null,
      rentPrice: room.price * 1_000_000, area: room.area, roomType: room.type,
      amenities: room.amenities, saleNote: room.saleNote ?? null, saleBonusNote: null,
      description: room.description ?? null, images: room.images ?? [], activePolicyText: null,
      capabilities: { edit: true, images: true, pass: true, deposit: false, lock: true, releaseLock: false },
    }))),
  };
}
