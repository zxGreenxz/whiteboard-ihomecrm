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
    /** Lọc theo nhiều toà nhà. [] / undefined = tất cả (không lọc). */
    buildingIds?: string[];
    roomFilter?: string;
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

    // Building filter (nhiều toà; [] = tất cả)
    if (filters.buildingIds && filters.buildingIds.length > 0) {
      if (!filters.buildingIds.includes(contract.room?.building_id ?? '')) return false;
    }

    // Room filter
    if (filters.roomFilter && filters.roomFilter !== 'all') {
      if (contract.room_id !== filters.roomFilter) return false;
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
 * Dropdown phòng chỉ hiện phòng thuộc các toà đang chọn ([] = mọi toà).
 * Replicates the `filteredRooms` memo from ContractsPage.tsx.
 */
export function filterRoomsByBuildings(
  rooms: { id: string; building_id: string }[],
  buildingIds: string[],
): { id: string; building_id: string }[] {
  if (buildingIds.length === 0) return rooms;
  return rooms.filter((r) => buildingIds.includes(r.building_id));
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
    building_id: buildingIdPoolArb,
    area_id: areaIdPoolArb,
    building_type: buildingTypeArb,
    room_name: fc.constantFrom('P101', 'P102', 'P201', 'P202', 'P301'),
    start_date: dateStringArb(),
    end_date: dateStringArb(),
    repCustomer: contractCustomerArb(true),
  }).map(({ id, status, contract_number, room_id, building_id, area_id, building_type, room_name, start_date, end_date, repCustomer }) => ({
    id,
    user_id: '00000000-0000-0000-0000-000000000000',
    room_id,
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
    contract_customers: [repCustomer],
  }));
}

/** Generate a filter combination from the same small pool */
function filtersArb(): fc.Arbitrary<{
  search?: string;
  buildingIds?: string[];
  roomFilter?: string;
  rentalTypeFilter?: string;
  monthFilter?: string;
}> {
  return fc.record({
    search: fc.option(
      fc.constantFrom('P101', 'P202', 'HD', 'abc', '0123456789', ''),
      { nil: undefined },
    ),
    buildingIds: fc.option(
      fc.subarray(['bld-1', 'bld-2', 'bld-3']),
      { nil: undefined },
    ),
    roomFilter: fc.option(
      fc.constantFrom('all', 'room-1', 'room-2', 'room-3'),
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

          // Building filter check (nhiều toà; [] = tất cả)
          if (filters.buildingIds && filters.buildingIds.length > 0) {
            expect(filters.buildingIds).toContain(c.room?.building_id);
          }

          // Room filter check
          if (filters.roomFilter && filters.roomFilter !== 'all') {
            expect(c.room_id).toBe(filters.roomFilter);
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

          if (allMatch && filters.buildingIds && filters.buildingIds.length > 0) {
            if (!filters.buildingIds.includes(c.room?.building_id ?? '')) allMatch = false;
          }

          if (allMatch && filters.roomFilter && filters.roomFilter !== 'all') {
            if (c.room_id !== filters.roomFilter) allMatch = false;
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
        // Filter with search + buildings
        const withSearchAndBuildings = filterContracts(contracts, {
          search: filters.search,
          buildingIds: filters.buildingIds,
        });
        // Filter with all
        const withAll = filterContracts(contracts, filters);

        expect(withSearchAndBuildings.length).toBeLessThanOrEqual(withSearch.length);
        expect(withAll.length).toBeLessThanOrEqual(withSearchAndBuildings.length);
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
 * For any multi-building selection, the rooms dropdown should only contain
 * rooms belonging to the selected buildings ([] = no filter, all rooms).
 *
 * **Validates: Requirements 1.5, 1.6, 2.3**
 */
describe('Feature: lease-contract-management, Property 4: Cascading dropdown filtering', () => {
  const roomArb = fc.record({
    id: roomIdPoolArb,
    building_id: buildingIdPoolArb,
  });

  const roomListArb = fc.array(roomArb, { minLength: 1, maxLength: 15 });
  const buildingIdsArb = fc.subarray(['bld-1', 'bld-2', 'bld-3']);

  it('filtering rooms by buildings returns exactly the rooms with matching building_id', () => {
    fc.assert(
      fc.property(roomListArb, buildingIdsArb, (rooms, buildingIds) => {
        const result = filterRoomsByBuildings(rooms, buildingIds);

        if (buildingIds.length === 0) {
          expect(result.length).toBe(rooms.length);
        } else {
          for (const r of result) {
            expect(buildingIds).toContain(r.building_id);
          }
          // All matching rooms are included
          const expected = rooms.filter((r) => buildingIds.includes(r.building_id));
          expect(result.length).toBe(expected.length);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('empty selection ([] = all) returns the full room list', () => {
    fc.assert(
      fc.property(roomListArb, (rooms) => {
        expect(filterRoomsByBuildings(rooms, []).length).toBe(rooms.length);
      }),
      { numRuns: 100 },
    );
  });

  it('selecting more buildings never shrinks the room list (monotonic in selection)', () => {
    fc.assert(
      fc.property(roomListArb, buildingIdsArb, buildingIdsArb, (rooms, idsA, idsB) => {
        // Bỏ qua case [] vì [] = "tất cả" (không phải tập con của selection khác)
        fc.pre(idsA.length > 0);
        const union = [...new Set([...idsA, ...idsB])];
        const subsetResult = filterRoomsByBuildings(rooms, idsA);
        const unionResult = filterRoomsByBuildings(rooms, union);

        expect(subsetResult.length).toBeLessThanOrEqual(unionResult.length);
        const unionIds = new Set(unionResult.map((r) => r.id));
        for (const r of subsetResult) {
          expect(unionIds.has(r.id)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('filtered rooms are always a subset of the original list', () => {
    fc.assert(
      fc.property(roomListArb, buildingIdsArb, (rooms, buildingIds) => {
        const result = filterRoomsByBuildings(rooms, buildingIds);
        expect(result.length).toBeLessThanOrEqual(rooms.length);
        const originalIds = new Set<string>(rooms.map((r) => r.id));
        for (const r of result) {
          expect(originalIds.has(r.id)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});
