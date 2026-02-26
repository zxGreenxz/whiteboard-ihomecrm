import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type {
  ContractWithRelations,
  ContractCustomer,
  ContractStatus,
} from '../../types/contract';

// =============================================
// Pure filter functions extracted from ContractsPage
// =============================================

/**
 * Filter contracts by all criteria simultaneously.
 * Replicates the exact logic from ContractsPage.tsx.
 */
export function filterContracts(
  contracts: ContractWithRelations[],
  filters: {
    search?: string;
    areaFilter?: string;
    buildingFilter?: string;
    roomFilter?: string;
    bedFilter?: string;
    rentalTypeFilter?: string;
    monthFilter?: string;
  },
): ContractWithRelations[] {
  return contracts.filter((contract) => {
    // Search filter: case-insensitive match on contract_number, customer name, phone, room name
    if (filters.search) {
      const term = filters.search.toLowerCase();
      const contractNumber = contract.contract_number?.toLowerCase() || '';
      const roomName = contract.room?.name?.toLowerCase() || '';
      const customerName =
        contract.contract_customers
          ?.find((cc) => cc.is_representative)
          ?.customer?.full_name?.toLowerCase() || '';
      const customerPhone =
        contract.contract_customers
          ?.find((cc) => cc.is_representative)
          ?.customer?.phone || '';

      const matchesSearch =
        contractNumber.includes(term) ||
        roomName.includes(term) ||
        customerName.includes(term) ||
        customerPhone.includes(term);

      if (!matchesSearch) return false;
    }

    // Area filter
    if (filters.areaFilter && filters.areaFilter !== 'all') {
      if (contract.room?.building?.area_id !== filters.areaFilter) return false;
    }

    // Building filter
    if (filters.buildingFilter && filters.buildingFilter !== 'all') {
      if (contract.room?.building_id !== filters.buildingFilter) return false;
    }

    // Room filter
    if (filters.roomFilter && filters.roomFilter !== 'all') {
      if (contract.room_id !== filters.roomFilter) return false;
    }

    // Bed filter
    if (filters.bedFilter && filters.bedFilter !== 'all') {
      if (contract.bed_id !== filters.bedFilter) return false;
    }

    // Rental type filter
    if (filters.rentalTypeFilter && filters.rentalTypeFilter !== 'all') {
      if (contract.room?.building?.type !== filters.rentalTypeFilter) return false;
    }

    // Month filter: contract's active period overlaps with selected month
    if (filters.monthFilter) {
      const [year, month] = filters.monthFilter.split('-').map(Number);
      const monthStart = new Date(year, month - 1, 1);
      const monthEnd = new Date(year, month, 0, 23, 59, 59);
      const contractStart = new Date(contract.start_date);
      const contractEnd = new Date(contract.end_date);
      if (contractStart > monthEnd || contractEnd < monthStart) return false;
    }

    return true;
  });
}

/**
 * Cascading dropdown filter logic.
 * Given a parent selection, returns the filtered child items.
 */
export function filterBuildingsByArea(
  buildings: { id: string; area_id: string | null }[],
  areaFilter: string,
): { id: string; area_id: string | null }[] {
  if (areaFilter === 'all') return buildings;
  return buildings.filter((b) => b.area_id === areaFilter);
}

export function filterRoomsByBuilding(
  rooms: { id: string; building_id: string }[],
  buildingFilter: string,
): { id: string; building_id: string }[] {
  if (buildingFilter === 'all') return rooms;
  return rooms.filter((r) => r.building_id === buildingFilter);
}

export function filterBedsByRoom(
  beds: { id: string; room_id: string }[],
  roomFilter: string,
): { id: string; room_id: string }[] {
  if (roomFilter === 'all') return beds;
  return beds.filter((b) => b.room_id === roomFilter);
}

// =============================================
// Shared Arbitraries
// =============================================

const uuidArb = fc.uuid();

const buildingTypeArb = fc.constantFrom(
  'Chung cư mini', 'Nhà trọ', 'Căn hộ dịch vụ', 'Ký túc xá', 'Homestay',
);

const contractStatusArb: fc.Arbitrary<ContractStatus> = fc.constantFrom(
  'DRAFT', 'ACTIVE', 'EXTENDED', 'TRANSFERRED', 'TERMINATED', 'EXPIRED',
);

/** Generate a date string in YYYY-MM-DD format */
function dateStringArb(minYear = 2023, maxYear = 2026): fc.Arbitrary<string> {
  return fc.record({
    year: fc.integer({ min: minYear, max: maxYear }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  }).map(({ year, month, day }) => {
    const m = String(month).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    return `${year}-${m}-${d}`;
  });
}

/** Generate a small pool of area IDs to increase filter hit rate */
const areaIdPoolArb = fc.constantFrom('area-1', 'area-2', 'area-3', null);
const buildingIdPoolArb = fc.constantFrom('bld-1', 'bld-2', 'bld-3');
const roomIdPoolArb = fc.constantFrom('room-1', 'room-2', 'room-3');
const bedIdPoolArb = fc.constantFrom('bed-1', 'bed-2', 'bed-3', null);

/** Generate a ContractCustomer with representative flag */
function contractCustomerArb(isRep: boolean): fc.Arbitrary<ContractCustomer> {
  return fc.record({
    id: uuidArb,
    contract_id: uuidArb,
    customer_id: uuidArb,
    full_name: fc.constantFrom('Nguyen Van A', 'Tran Thi B', 'Le Van C', 'Pham Thi D', 'Hoang Van E'),
    phone: fc.constantFrom('0901234567', '0912345678', '0923456789', '0934567890', '0945678901'),
  }).map(({ id, contract_id, customer_id, full_name, phone }) => ({
    id,
    contract_id,
    customer_id,
    is_representative: isRep,
    customer: { id: customer_id, full_name, phone, id_number: null },
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }));
}

/** Generate a ContractWithRelations with small-pool IDs for filter testing */
function contractWithRelationsArb(): fc.Arbitrary<ContractWithRelations> {
  return fc.record({
    id: uuidArb,
    status: contractStatusArb,
    contract_number: fc.option(fc.constantFrom('HD-001', 'HD-002', 'HD-003', 'HD-100', 'HD-200', null), { nil: null }),
    room_id: roomIdPoolArb,
    bed_id: bedIdPoolArb,
    building_id: buildingIdPoolArb,
    area_id: areaIdPoolArb,
    building_type: buildingTypeArb,
    room_name: fc.constantFrom('P101', 'P102', 'P201', 'P202', 'P301'),
    start_date: dateStringArb(),
    end_date: dateStringArb(),
    repCustomer: contractCustomerArb(true),
  }).map(({ id, status, contract_number, room_id, bed_id, building_id, area_id, building_type, room_name, start_date, end_date, repCustomer }) => ({
    id,
    user_id: '00000000-0000-0000-0000-000000000000',
    room_id,
    bed_id,
    tenant_id: '00000000-0000-0000-0000-000000000000',
    contract_number,
    signed_date: start_date,
    start_date,
    end_date,
    actual_end_date: null,
    expected_move_out_date: null,
    rent_price: 0,
    total_deposit: 0,
    deposit_paid: null,
    deposit_remaining: null,
    payment_cycle: null,
    start_billing_date: null,
    contract_template_id: null,
    invoice_template_id: null,
    contract_file_url: null,
    parent_contract_id: null,
    initial_electricity_reading: null,
    initial_water_reading: null,
    discounts: null,
    notes: null,
    status,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    deleted_at: null,
    room: {
      id: room_id,
      name: room_name,
      building_id,
      building: {
        id: building_id,
        name: `Building ${building_id}`,
        type: building_type,
        area_id,
      },
    },
    bed: bed_id ? { id: bed_id, name: `Bed ${bed_id}` } : null,
    contract_customers: [repCustomer],
  }));
}

/** Generate a filter combination from the same small pool */
function filtersArb(): fc.Arbitrary<{
  search?: string;
  areaFilter?: string;
  buildingFilter?: string;
  roomFilter?: string;
  bedFilter?: string;
  rentalTypeFilter?: string;
  monthFilter?: string;
}> {
  return fc.record({
    search: fc.option(
      fc.constantFrom('P101', 'P202', 'HD', 'abc', '0123456789', ''),
      { nil: undefined },
    ),
    areaFilter: fc.option(
      fc.constantFrom('all', 'area-1', 'area-2', 'area-3'),
      { nil: undefined },
    ),
    buildingFilter: fc.option(
      fc.constantFrom('all', 'bld-1', 'bld-2', 'bld-3'),
      { nil: undefined },
    ),
    roomFilter: fc.option(
      fc.constantFrom('all', 'room-1', 'room-2', 'room-3'),
      { nil: undefined },
    ),
    bedFilter: fc.option(
      fc.constantFrom('all', 'bed-1', 'bed-2', 'bed-3'),
      { nil: undefined },
    ),
    rentalTypeFilter: fc.option(
      fc.constantFrom('all', 'Chung cư mini', 'Nhà trọ', 'Ký túc xá'),
      { nil: undefined },
    ),
    monthFilter: fc.option(
      fc.constantFrom('2023-06', '2024-01', '2024-06', '2025-01', '2025-06', ''),
      { nil: undefined },
    ),
  });
}

// =============================================
// Property 3: Contract filter correctness
// =============================================

/**
 * Feature: lease-contract-management
 * Property 3: Contract filter correctness
 *
 * For any list of contracts and any combination of filters, the filtered list
 * should contain only contracts that match ALL applied filters simultaneously.
 *
 * **Validates: Requirements 1.4, 1.7, 15.2, 15.3, 15.4**
 */
describe('Feature: lease-contract-management, Property 3: Contract filter correctness', () => {
  const contractListArb = fc.array(contractWithRelationsArb(), { minLength: 0, maxLength: 30 });

  it('every contract in filtered result matches ALL active filters', () => {
    fc.assert(
      fc.property(contractListArb, filtersArb(), (contracts, filters) => {
        const result = filterContracts(contracts, filters);

        for (const c of result) {
          // Search filter check
          if (filters.search) {
            const term = filters.search.toLowerCase();
            const contractNumber = c.contract_number?.toLowerCase() || '';
            const roomName = c.room?.name?.toLowerCase() || '';
            const customerName =
              c.contract_customers?.find((cc) => cc.is_representative)?.customer?.full_name?.toLowerCase() || '';
            const customerPhone =
              c.contract_customers?.find((cc) => cc.is_representative)?.customer?.phone || '';
            const matches =
              contractNumber.includes(term) ||
              roomName.includes(term) ||
              customerName.includes(term) ||
              customerPhone.includes(term);
            expect(matches).toBe(true);
          }

          // Area filter check
          if (filters.areaFilter && filters.areaFilter !== 'all') {
            expect(c.room?.building?.area_id).toBe(filters.areaFilter);
          }

          // Building filter check
          if (filters.buildingFilter && filters.buildingFilter !== 'all') {
            expect(c.room?.building_id).toBe(filters.buildingFilter);
          }

          // Room filter check
          if (filters.roomFilter && filters.roomFilter !== 'all') {
            expect(c.room_id).toBe(filters.roomFilter);
          }

          // Bed filter check
          if (filters.bedFilter && filters.bedFilter !== 'all') {
            expect(c.bed_id).toBe(filters.bedFilter);
          }

          // Rental type filter check
          if (filters.rentalTypeFilter && filters.rentalTypeFilter !== 'all') {
            expect(c.room?.building?.type).toBe(filters.rentalTypeFilter);
          }

          // Month filter check
          if (filters.monthFilter) {
            const [year, month] = filters.monthFilter.split('-').map(Number);
            const monthStart = new Date(year, month - 1, 1);
            const monthEnd = new Date(year, month, 0, 23, 59, 59);
            const contractStart = new Date(c.start_date);
            const contractEnd = new Date(c.end_date);
            expect(contractStart <= monthEnd && contractEnd >= monthStart).toBe(true);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('no contract excluded from result should match all filters', () => {
    fc.assert(
      fc.property(contractListArb, filtersArb(), (contracts, filters) => {
        const result = filterContracts(contracts, filters);
        const resultIds = new Set(result.map((c) => c.id));
        const excluded = contracts.filter((c) => !resultIds.has(c.id));

        for (const c of excluded) {
          // At least one filter must fail for excluded contracts
          let allMatch = true;

          if (filters.search) {
            const term = filters.search.toLowerCase();
            const contractNumber = c.contract_number?.toLowerCase() || '';
            const roomName = c.room?.name?.toLowerCase() || '';
            const customerName =
              c.contract_customers?.find((cc) => cc.is_representative)?.customer?.full_name?.toLowerCase() || '';
            const customerPhone =
              c.contract_customers?.find((cc) => cc.is_representative)?.customer?.phone || '';
            if (
              !contractNumber.includes(term) &&
              !roomName.includes(term) &&
              !customerName.includes(term) &&
              !customerPhone.includes(term)
            ) {
              allMatch = false;
            }
          }

          if (allMatch && filters.areaFilter && filters.areaFilter !== 'all') {
            if (c.room?.building?.area_id !== filters.areaFilter) allMatch = false;
          }

          if (allMatch && filters.buildingFilter && filters.buildingFilter !== 'all') {
            if (c.room?.building_id !== filters.buildingFilter) allMatch = false;
          }

          if (allMatch && filters.roomFilter && filters.roomFilter !== 'all') {
            if (c.room_id !== filters.roomFilter) allMatch = false;
          }

          if (allMatch && filters.bedFilter && filters.bedFilter !== 'all') {
            if (c.bed_id !== filters.bedFilter) allMatch = false;
          }

          if (allMatch && filters.rentalTypeFilter && filters.rentalTypeFilter !== 'all') {
            if (c.room?.building?.type !== filters.rentalTypeFilter) allMatch = false;
          }

          if (allMatch && filters.monthFilter) {
            const [year, month] = filters.monthFilter.split('-').map(Number);
            const monthStart = new Date(year, month - 1, 1);
            const monthEnd = new Date(year, month, 0, 23, 59, 59);
            const contractStart = new Date(c.start_date);
            const contractEnd = new Date(c.end_date);
            if (contractStart > monthEnd || contractEnd < monthStart) allMatch = false;
          }

          expect(allMatch).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('clearing all filters returns the full list', () => {
    fc.assert(
      fc.property(contractListArb, (contracts) => {
        const result = filterContracts(contracts, {});
        expect(result.length).toBe(contracts.length);
      }),
      { numRuns: 100 },
    );
  });

  it('filtered result is always a subset of the original list', () => {
    fc.assert(
      fc.property(contractListArb, filtersArb(), (contracts, filters) => {
        const result = filterContracts(contracts, filters);
        expect(result.length).toBeLessThanOrEqual(contracts.length);
        const originalIds = new Set(contracts.map((c) => c.id));
        for (const c of result) {
          expect(originalIds.has(c.id)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('adding more filters never increases result size', () => {
    fc.assert(
      fc.property(contractListArb, filtersArb(), (contracts, filters) => {
        // Filter with just search
        const withSearch = filterContracts(contracts, { search: filters.search });
        // Filter with search + area
        const withSearchAndArea = filterContracts(contracts, {
          search: filters.search,
          areaFilter: filters.areaFilter,
        });
        // Filter with all
        const withAll = filterContracts(contracts, filters);

        expect(withSearchAndArea.length).toBeLessThanOrEqual(withSearch.length);
        expect(withAll.length).toBeLessThanOrEqual(withSearchAndArea.length);
      }),
      { numRuns: 100 },
    );
  });
});


// =============================================
// Property 4: Cascading dropdown filtering
// =============================================

/**
 * Feature: lease-contract-management
 * Property 4: Cascading dropdown filtering
 *
 * For any building selection, the rooms dropdown should only contain rooms
 * belonging to that building. For any room selection, the beds dropdown should
 * only contain beds belonging to that room.
 *
 * **Validates: Requirements 1.5, 1.6, 2.3**
 */
describe('Feature: lease-contract-management, Property 4: Cascading dropdown filtering', () => {
  /** Generate a hierarchy of buildings, rooms, and beds */
  const buildingArb = fc.record({
    id: buildingIdPoolArb,
    area_id: areaIdPoolArb,
  });

  const roomArb = fc.record({
    id: roomIdPoolArb,
    building_id: buildingIdPoolArb,
  });

  const bedArb = fc.record({
    id: fc.constantFrom('bed-1', 'bed-2', 'bed-3', 'bed-4', 'bed-5'),
    room_id: roomIdPoolArb,
  });

  const buildingListArb = fc.array(buildingArb, { minLength: 1, maxLength: 10 });
  const roomListArb = fc.array(roomArb, { minLength: 1, maxLength: 15 });
  const bedListArb = fc.array(bedArb, { minLength: 1, maxLength: 20 });

  it('filtering buildings by area returns only buildings with matching area_id', () => {
    fc.assert(
      fc.property(
        buildingListArb,
        fc.constantFrom('all', 'area-1', 'area-2', 'area-3'),
        (buildings, areaFilter) => {
          const result = filterBuildingsByArea(buildings, areaFilter);

          if (areaFilter === 'all') {
            expect(result.length).toBe(buildings.length);
          } else {
            for (const b of result) {
              expect(b.area_id).toBe(areaFilter);
            }
            // All matching buildings are included
            const expected = buildings.filter((b) => b.area_id === areaFilter);
            expect(result.length).toBe(expected.length);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('filtering rooms by building returns only rooms with matching building_id', () => {
    fc.assert(
      fc.property(
        roomListArb,
        fc.constantFrom('all', 'bld-1', 'bld-2', 'bld-3'),
        (rooms, buildingFilter) => {
          const result = filterRoomsByBuilding(rooms, buildingFilter);

          if (buildingFilter === 'all') {
            expect(result.length).toBe(rooms.length);
          } else {
            for (const r of result) {
              expect(r.building_id).toBe(buildingFilter);
            }
            const expected = rooms.filter((r) => r.building_id === buildingFilter);
            expect(result.length).toBe(expected.length);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('filtering beds by room returns only beds with matching room_id', () => {
    fc.assert(
      fc.property(
        bedListArb,
        fc.constantFrom('all', 'room-1', 'room-2', 'room-3'),
        (beds, roomFilter) => {
          const result = filterBedsByRoom(beds, roomFilter);

          if (roomFilter === 'all') {
            expect(result.length).toBe(beds.length);
          } else {
            for (const b of result) {
              expect(b.room_id).toBe(roomFilter);
            }
            const expected = beds.filter((b) => b.room_id === roomFilter);
            expect(result.length).toBe(expected.length);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('cascading: rooms from filtered buildings are a subset of all rooms for those buildings', () => {
    fc.assert(
      fc.property(
        buildingListArb,
        roomListArb,
        fc.constantFrom('all', 'area-1', 'area-2', 'area-3'),
        (buildings, rooms, areaFilter) => {
          const filteredBuildings = filterBuildingsByArea(buildings, areaFilter);
          const filteredBuildingIds = new Set(filteredBuildings.map((b) => b.id));

          // Rooms that belong to filtered buildings
          const cascadedRooms = rooms.filter((r) => filteredBuildingIds.has(r.building_id));

          // Every cascaded room must belong to a filtered building
          for (const r of cascadedRooms) {
            expect(filteredBuildingIds.has(r.building_id)).toBe(true);
          }

          // Cascaded rooms should be a subset of all rooms
          expect(cascadedRooms.length).toBeLessThanOrEqual(rooms.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('cascading: beds from filtered rooms are a subset of all beds for those rooms', () => {
    fc.assert(
      fc.property(
        roomListArb,
        bedListArb,
        fc.constantFrom('all', 'bld-1', 'bld-2', 'bld-3'),
        (rooms, beds, buildingFilter) => {
          const filteredRooms = filterRoomsByBuilding(rooms, buildingFilter);
          const filteredRoomIds = new Set(filteredRooms.map((r) => r.id));

          // Beds that belong to filtered rooms
          const cascadedBeds = beds.filter((b) => filteredRoomIds.has(b.room_id));

          // Every cascaded bed must belong to a filtered room
          for (const b of cascadedBeds) {
            expect(filteredRoomIds.has(b.room_id)).toBe(true);
          }

          expect(cascadedBeds.length).toBeLessThanOrEqual(beds.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('full cascade: area → building → room → bed produces correct subsets', () => {
    fc.assert(
      fc.property(
        buildingListArb,
        roomListArb,
        bedListArb,
        fc.constantFrom('all', 'area-1', 'area-2'),
        (buildings, rooms, beds, areaFilter) => {
          // Step 1: Filter buildings by area
          const filteredBuildings = filterBuildingsByArea(buildings, areaFilter);
          const filteredBuildingIds = new Set(filteredBuildings.map((b) => b.id));

          // Step 2: Pick a building from filtered list (or 'all')
          const buildingFilter = filteredBuildings.length > 0
            ? filteredBuildings[0].id
            : 'all';
          const filteredRooms = filterRoomsByBuilding(rooms, buildingFilter);
          const filteredRoomIds = new Set(filteredRooms.map((r) => r.id));

          // Step 3: Pick a room from filtered list (or 'all')
          const roomFilter = filteredRooms.length > 0
            ? filteredRooms[0].id
            : 'all';
          const filteredBeds = filterBedsByRoom(beds, roomFilter);

          // Verify: all filtered rooms belong to the selected building
          if (buildingFilter !== 'all') {
            for (const r of filteredRooms) {
              expect(r.building_id).toBe(buildingFilter);
            }
          }

          // Verify: all filtered beds belong to the selected room
          if (roomFilter !== 'all') {
            for (const b of filteredBeds) {
              expect(b.room_id).toBe(roomFilter);
            }
          }

          // Verify: cascade monotonicity
          expect(filteredBuildings.length).toBeLessThanOrEqual(buildings.length);
          expect(filteredRooms.length).toBeLessThanOrEqual(rooms.length);
          expect(filteredBeds.length).toBeLessThanOrEqual(beds.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('selecting "all" at any level returns the full list for that level', () => {
    fc.assert(
      fc.property(buildingListArb, roomListArb, bedListArb, (buildings, rooms, beds) => {
        expect(filterBuildingsByArea(buildings, 'all').length).toBe(buildings.length);
        expect(filterRoomsByBuilding(rooms, 'all').length).toBe(rooms.length);
        expect(filterBedsByRoom(beds, 'all').length).toBe(beds.length);
      }),
      { numRuns: 100 },
    );
  });
});
