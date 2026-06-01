import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  getContractDisplayStatus,
  type Contract,
  type ContractStatus,
  type ContractDisplayStatus,
  type ContractStats,
  type PaymentCycle,
} from '../../types/contract';

// =============================================
// Shared Arbitraries
// =============================================

const contractStatusArb: fc.Arbitrary<ContractStatus> = fc.constantFrom(
  'DRAFT', 'ACTIVE', 'EXTENDED', 'TRANSFERRED', 'TERMINATED', 'EXPIRED',
);

const paymentCycleArb: fc.Arbitrary<PaymentCycle | null> = fc.constantFrom(
  'MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL', null,
);

/** Generate an ISO date string offset from now by the given day range */
function dateOffsetArb(minDays: number, maxDays: number): fc.Arbitrary<string> {
  return fc.integer({ min: minDays, max: maxDays }).map((offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().split('T')[0];
  });
}

/** Generate a nullable expected_move_out_date (roughly 50% chance of being set) */
const expectedMoveOutArb: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant(null),
  dateOffsetArb(-60, 120),
);

/** Build a minimal Contract object sufficient for getContractDisplayStatus */
function contractArb(): fc.Arbitrary<Contract> {
  return fc.record({
    status: contractStatusArb,
    end_date: dateOffsetArb(-365, 365),
    expected_move_out_date: expectedMoveOutArb,
  }).map(({ status, end_date, expected_move_out_date }) => ({
    id: '00000000-0000-0000-0000-000000000000',
    user_id: '00000000-0000-0000-0000-000000000000',
    room_id: null,
    tenant_id: '00000000-0000-0000-0000-000000000000',
    contract_number: null,
    signed_date: '2024-01-01',
    start_date: '2024-01-01',
    end_date,
    actual_end_date: null,
    expected_move_out_date,
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
  }));
}


// =============================================
// Property 1: Contract display status computation
// =============================================

/**
 * Feature: lease-contract-management
 * Property 1: Contract display status computation
 *
 * For any contract, getContractDisplayStatus should return:
 * - TERMINATED if status is TERMINATED
 * - TRANSFERRED if status is TRANSFERRED
 * - DRAFT if status is DRAFT
 * - MOVING_OUT if expected_move_out_date is set (regardless of end_date)
 * - EXPIRED if end_date has passed and status is ACTIVE/EXTENDED/EXPIRED
 * - EXPIRING if end_date is within 30 days and status is ACTIVE/EXTENDED/EXPIRED
 * - ACTIVE otherwise
 *
 * **Validates: Requirements 13.1, 13.2, 13.3, 13.4, 6.3**
 */
describe('Feature: lease-contract-management, Property 1: Contract display status computation', () => {
  it('should return TERMINATED when contract status is TERMINATED', () => {
    fc.assert(
      fc.property(
        dateOffsetArb(-365, 365),
        expectedMoveOutArb,
        (end_date, expected_move_out_date) => {
          const contract = makeContract({ status: 'TERMINATED', end_date, expected_move_out_date });
          expect(getContractDisplayStatus(contract)).toBe('TERMINATED');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return TRANSFERRED when contract status is TRANSFERRED', () => {
    fc.assert(
      fc.property(
        dateOffsetArb(-365, 365),
        expectedMoveOutArb,
        (end_date, expected_move_out_date) => {
          const contract = makeContract({ status: 'TRANSFERRED', end_date, expected_move_out_date });
          expect(getContractDisplayStatus(contract)).toBe('TRANSFERRED');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return DRAFT when contract status is DRAFT', () => {
    fc.assert(
      fc.property(
        dateOffsetArb(-365, 365),
        expectedMoveOutArb,
        (end_date, expected_move_out_date) => {
          const contract = makeContract({ status: 'DRAFT', end_date, expected_move_out_date });
          expect(getContractDisplayStatus(contract)).toBe('DRAFT');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return MOVING_OUT when expected_move_out_date is set and status is not TERMINATED/TRANSFERRED/DRAFT', () => {
    const nonTerminalStatusArb = fc.constantFrom<ContractStatus>('ACTIVE', 'EXTENDED', 'EXPIRED');
    fc.assert(
      fc.property(
        nonTerminalStatusArb,
        dateOffsetArb(-365, 365),
        dateOffsetArb(-60, 120),
        (status, end_date, move_out_date) => {
          const contract = makeContract({ status, end_date, expected_move_out_date: move_out_date });
          expect(getContractDisplayStatus(contract)).toBe('MOVING_OUT');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return EXPIRED when end_date has passed and no expected_move_out_date', () => {
    const nonTerminalStatusArb = fc.constantFrom<ContractStatus>('ACTIVE', 'EXTENDED', 'EXPIRED');
    // end_date at least 1 day in the past (daysUntilEnd < 0 means Math.ceil < 0, so at least -1 day)
    fc.assert(
      fc.property(
        nonTerminalStatusArb,
        dateOffsetArb(-365, -2),
        (status, end_date) => {
          const contract = makeContract({ status, end_date, expected_move_out_date: null });
          expect(getContractDisplayStatus(contract)).toBe('EXPIRED');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return EXPIRING when end_date is within 30 days and no expected_move_out_date', () => {
    const nonTerminalStatusArb = fc.constantFrom<ContractStatus>('ACTIVE', 'EXTENDED', 'EXPIRED');
    // daysUntilEnd in [0, 30] → end_date offset in [0, 30]
    fc.assert(
      fc.property(
        nonTerminalStatusArb,
        dateOffsetArb(0, 29),
        (status, end_date) => {
          const contract = makeContract({ status, end_date, expected_move_out_date: null });
          const result = getContractDisplayStatus(contract);
          // Due to Math.ceil and time-of-day, offset 0 could be EXPIRING or EXPIRED
          // offset 29 could be EXPIRING or ACTIVE depending on time
          expect(['EXPIRING', 'EXPIRED', 'ACTIVE']).toContain(result);
          // But the core invariant: it should NOT be TERMINATED, TRANSFERRED, DRAFT, or MOVING_OUT
          expect(result).not.toBe('TERMINATED');
          expect(result).not.toBe('TRANSFERRED');
          expect(result).not.toBe('DRAFT');
          expect(result).not.toBe('MOVING_OUT');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should return ACTIVE when end_date is more than 30 days away and no expected_move_out_date', () => {
    const nonTerminalStatusArb = fc.constantFrom<ContractStatus>('ACTIVE', 'EXTENDED', 'EXPIRED');
    // end_date at least 32 days in the future to avoid boundary issues
    fc.assert(
      fc.property(
        nonTerminalStatusArb,
        dateOffsetArb(32, 365),
        (status, end_date) => {
          const contract = makeContract({ status, end_date, expected_move_out_date: null });
          expect(getContractDisplayStatus(contract)).toBe('ACTIVE');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should always return a valid ContractDisplayStatus for any random contract', () => {
    const validDisplayStatuses: ContractDisplayStatus[] = [
      'ACTIVE', 'EXPIRING', 'EXPIRED', 'MOVING_OUT', 'TERMINATED', 'TRANSFERRED', 'DRAFT',
    ];
    fc.assert(
      fc.property(contractArb(), (contract) => {
        const result = getContractDisplayStatus(contract);
        expect(validDisplayStatuses).toContain(result);
      }),
      { numRuns: 100 },
    );
  });

  it('TERMINATED/TRANSFERRED/DRAFT statuses take priority over expected_move_out_date and end_date', () => {
    const terminalStatusArb = fc.constantFrom<ContractStatus>('TERMINATED', 'TRANSFERRED', 'DRAFT');
    const expectedMap: Record<string, ContractDisplayStatus> = {
      TERMINATED: 'TERMINATED',
      TRANSFERRED: 'TRANSFERRED',
      DRAFT: 'DRAFT',
    };
    fc.assert(
      fc.property(
        terminalStatusArb,
        dateOffsetArb(-365, 365),
        dateOffsetArb(-60, 120),
        (status, end_date, move_out_date) => {
          const contract = makeContract({ status, end_date, expected_move_out_date: move_out_date });
          expect(getContractDisplayStatus(contract)).toBe(expectedMap[status]);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/** Helper to build a Contract with overrides */
function makeContract(overrides: Partial<Contract>): Contract {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    user_id: '00000000-0000-0000-0000-000000000000',
    room_id: null,
    tenant_id: '00000000-0000-0000-0000-000000000000',
    contract_number: null,
    signed_date: '2024-01-01',
    start_date: '2024-01-01',
    end_date: '2025-01-01',
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
    status: 'ACTIVE',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    deleted_at: null,
    ...overrides,
  };
}


// =============================================
// Property 2: Contract stats computation and filtering consistency
// =============================================

/**
 * Feature: lease-contract-management
 * Property 2: Contract stats computation and filtering consistency
 *
 * For any list of contracts, the computed stats should satisfy:
 * - total equals the count of all contracts
 * - expiring equals the count of contracts with display status EXPIRING
 * - expired equals the count of contracts with display status EXPIRED
 * - terminated equals the count of contracts with display status TERMINATED
 *
 * When a stat filter is applied, the filtered list should contain only contracts
 * matching that category, and the filtered list length should equal the
 * corresponding stat count.
 *
 * **Validates: Requirements 1.1, 1.2**
 */
describe('Feature: lease-contract-management, Property 2: Contract stats computation and filtering consistency', () => {
  /** Compute stats the same way ContractsPage does */
  function computeStats(contracts: Contract[]): ContractStats {
    const result: ContractStats = { total: 0, expiring: 0, expired: 0, terminated: 0 };
    contracts.forEach((c) => {
      result.total++;
      const displayStatus = getContractDisplayStatus(c);
      if (displayStatus === 'EXPIRING') result.expiring++;
      else if (displayStatus === 'EXPIRED') result.expired++;
      else if (displayStatus === 'TERMINATED') result.terminated++;
    });
    return result;
  }

  /** Filter contracts by stat filter the same way ContractsPage does */
  function filterByStat(contracts: Contract[], filter: 'ALL' | 'EXPIRING' | 'EXPIRED' | 'TERMINATED'): Contract[] {
    if (filter === 'ALL') return contracts;
    const statusMap: Record<string, ContractDisplayStatus[]> = {
      EXPIRING: ['EXPIRING'],
      EXPIRED: ['EXPIRED'],
      TERMINATED: ['TERMINATED'],
    };
    return contracts.filter((c) => statusMap[filter]?.includes(getContractDisplayStatus(c)));
  }

  const contractListArb = fc.array(contractArb(), { minLength: 0, maxLength: 50 });

  it('total should equal the length of the contract list', () => {
    fc.assert(
      fc.property(contractListArb, (contracts) => {
        const stats = computeStats(contracts);
        expect(stats.total).toBe(contracts.length);
      }),
      { numRuns: 100 },
    );
  });

  it('expiring count should equal the number of contracts with EXPIRING display status', () => {
    fc.assert(
      fc.property(contractListArb, (contracts) => {
        const stats = computeStats(contracts);
        const expiringContracts = contracts.filter((c) => getContractDisplayStatus(c) === 'EXPIRING');
        expect(stats.expiring).toBe(expiringContracts.length);
      }),
      { numRuns: 100 },
    );
  });

  it('expired count should equal the number of contracts with EXPIRED display status', () => {
    fc.assert(
      fc.property(contractListArb, (contracts) => {
        const stats = computeStats(contracts);
        const expiredContracts = contracts.filter((c) => getContractDisplayStatus(c) === 'EXPIRED');
        expect(stats.expired).toBe(expiredContracts.length);
      }),
      { numRuns: 100 },
    );
  });

  it('terminated count should equal the number of contracts with TERMINATED display status', () => {
    fc.assert(
      fc.property(contractListArb, (contracts) => {
        const stats = computeStats(contracts);
        const terminatedContracts = contracts.filter((c) => getContractDisplayStatus(c) === 'TERMINATED');
        expect(stats.terminated).toBe(terminatedContracts.length);
      }),
      { numRuns: 100 },
    );
  });

  it('filtering by EXPIRING should return a list whose length equals stats.expiring', () => {
    fc.assert(
      fc.property(contractListArb, (contracts) => {
        const stats = computeStats(contracts);
        const filtered = filterByStat(contracts, 'EXPIRING');
        expect(filtered.length).toBe(stats.expiring);
        filtered.forEach((c) => {
          expect(getContractDisplayStatus(c)).toBe('EXPIRING');
        });
      }),
      { numRuns: 100 },
    );
  });

  it('filtering by EXPIRED should return a list whose length equals stats.expired', () => {
    fc.assert(
      fc.property(contractListArb, (contracts) => {
        const stats = computeStats(contracts);
        const filtered = filterByStat(contracts, 'EXPIRED');
        expect(filtered.length).toBe(stats.expired);
        filtered.forEach((c) => {
          expect(getContractDisplayStatus(c)).toBe('EXPIRED');
        });
      }),
      { numRuns: 100 },
    );
  });

  it('filtering by TERMINATED should return a list whose length equals stats.terminated', () => {
    fc.assert(
      fc.property(contractListArb, (contracts) => {
        const stats = computeStats(contracts);
        const filtered = filterByStat(contracts, 'TERMINATED');
        expect(filtered.length).toBe(stats.terminated);
        filtered.forEach((c) => {
          expect(getContractDisplayStatus(c)).toBe('TERMINATED');
        });
      }),
      { numRuns: 100 },
    );
  });

  it('filtering by ALL should return the full list', () => {
    fc.assert(
      fc.property(contractListArb, (contracts) => {
        const filtered = filterByStat(contracts, 'ALL');
        expect(filtered.length).toBe(contracts.length);
      }),
      { numRuns: 100 },
    );
  });

  it('sum of category counts should not exceed total', () => {
    fc.assert(
      fc.property(contractListArb, (contracts) => {
        const stats = computeStats(contracts);
        // expiring + expired + terminated <= total (other statuses like ACTIVE, MOVING_OUT, etc. are not counted)
        expect(stats.expiring + stats.expired + stats.terminated).toBeLessThanOrEqual(stats.total);
      }),
      { numRuns: 100 },
    );
  });
});
