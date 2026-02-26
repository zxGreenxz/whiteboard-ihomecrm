import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// =============================================
// Pure function: Available rooms filter for transfer
// Replicates the exact logic from TransferRoomDialog.tsx
// =============================================

/**
 * Filter rooms for transfer: only AVAILABLE rooms, exclude current room,
 * optionally filter by building.
 */
export function getAvailableRoomsForTransfer(
  rooms: { id: string; status: string; building_id: string }[],
  currentRoomId: string,
  buildingId?: string,
): { id: string; status: string; building_id: string }[] {
  return rooms.filter(
    (r) =>
      r.status === 'AVAILABLE' &&
      r.id !== currentRoomId &&
      (!buildingId || r.building_id === buildingId),
  );
}

// =============================================
// Arbitraries
// =============================================

const roomStatusArb = fc.constantFrom(
  'AVAILABLE',
  'OCCUPIED',
  'MAINTENANCE',
  'RESERVED',
  'UNAVAILABLE',
);

const roomIdPoolArb = fc.constantFrom(
  'room-1', 'room-2', 'room-3', 'room-4', 'room-5',
  'room-6', 'room-7', 'room-8', 'room-9', 'room-10',
);

const buildingIdPoolArb = fc.constantFrom('bld-1', 'bld-2', 'bld-3');

const roomArb = fc.record({
  id: roomIdPoolArb,
  status: roomStatusArb,
  building_id: buildingIdPoolArb,
});

const roomListArb = fc.array(roomArb, { minLength: 0, maxLength: 30 });

// =============================================
// Property 16: Available rooms filter for transfer
// =============================================

/**
 * Feature: lease-contract-management
 * Property 16: Available rooms filter for transfer
 *
 * For any list of rooms shown in the Transfer_Room_Dialog, all rooms should
 * have status AVAILABLE. No room with status OCCUPIED, RESERVED, MAINTENANCE,
 * or UNAVAILABLE should appear. The current room is always excluded.
 *
 * **Validates: Requirements 5.4**
 */
describe('Feature: lease-contract-management, Property 16: Available rooms filter for transfer', () => {
  it('all returned rooms have status AVAILABLE', () => {
    fc.assert(
      fc.property(roomListArb, roomIdPoolArb, (rooms, currentRoomId) => {
        const result = getAvailableRoomsForTransfer(rooms, currentRoomId);

        for (const r of result) {
          expect(r.status).toBe('AVAILABLE');
        }
      }),
      { numRuns: 100 },
    );
  });

  it('current room is never in the result', () => {
    fc.assert(
      fc.property(roomListArb, roomIdPoolArb, (rooms, currentRoomId) => {
        const result = getAvailableRoomsForTransfer(rooms, currentRoomId);

        for (const r of result) {
          expect(r.id).not.toBe(currentRoomId);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('when buildingId is specified, all returned rooms belong to that building', () => {
    fc.assert(
      fc.property(
        roomListArb,
        roomIdPoolArb,
        buildingIdPoolArb,
        (rooms, currentRoomId, buildingId) => {
          const result = getAvailableRoomsForTransfer(rooms, currentRoomId, buildingId);

          for (const r of result) {
            expect(r.building_id).toBe(buildingId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('all AVAILABLE rooms (except current) are included — completeness', () => {
    fc.assert(
      fc.property(roomListArb, roomIdPoolArb, (rooms, currentRoomId) => {
        const result = getAvailableRoomsForTransfer(rooms, currentRoomId);
        const resultIds = new Set(result.map((r) => r.id));

        // Every AVAILABLE room that is not the current room must be in the result
        const expectedAvailable = rooms.filter(
          (r) => r.status === 'AVAILABLE' && r.id !== currentRoomId,
        );

        for (const r of expectedAvailable) {
          expect(resultIds.has(r.id)).toBe(true);
        }

        // Result size matches expected
        expect(result.length).toBe(expectedAvailable.length);
      }),
      { numRuns: 100 },
    );
  });

  it('completeness with buildingId filter — all matching AVAILABLE rooms included', () => {
    fc.assert(
      fc.property(
        roomListArb,
        roomIdPoolArb,
        buildingIdPoolArb,
        (rooms, currentRoomId, buildingId) => {
          const result = getAvailableRoomsForTransfer(rooms, currentRoomId, buildingId);
          const resultIds = new Set(result.map((r) => r.id));

          const expectedAvailable = rooms.filter(
            (r) =>
              r.status === 'AVAILABLE' &&
              r.id !== currentRoomId &&
              r.building_id === buildingId,
          );

          for (const r of expectedAvailable) {
            expect(resultIds.has(r.id)).toBe(true);
          }

          expect(result.length).toBe(expectedAvailable.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});
