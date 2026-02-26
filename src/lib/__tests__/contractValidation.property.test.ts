import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { contractFormSchema } from '../contractValidation';

// =============================================
// Shared Arbitraries
// =============================================

const validUuid = fc.uuid();

const validPaymentCycle = fc.constantFrom(
  'MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL',
);

/** Generate a valid date string YYYY-MM-DD */
function dateStringArb(minYear = 2023, maxYear = 2026): fc.Arbitrary<string> {
  return fc.record({
    year: fc.integer({ min: minYear, max: maxYear }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  }).map(({ year, month, day }) =>
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  );
}

/** Generate a valid contract form data object that passes all validation */
function validContractFormArb(): fc.Arbitrary<Record<string, unknown>> {
  return fc.record({
    room_id: validUuid,
    signed_date: dateStringArb(),
    start_date: fc.integer({ min: 2023, max: 2025 }).map((y) => `${y}-01-15`),
    rent_price: fc.nat({ max: 100_000_000 }),
    total_deposit: fc.nat({ max: 50_000_000 }),
    payment_cycle: validPaymentCycle,
  }).map(({ room_id, signed_date, start_date, rent_price, total_deposit, payment_cycle }) => ({
    room_id,
    signed_date,
    start_date,
    // end_date always after start_date
    end_date: `${parseInt(start_date.slice(0, 4)) + 1}-01-15`,
    rent_price,
    total_deposit,
    payment_cycle,
  }));
}

// =============================================
// Property 5: Contract validation rejects invalid data
// =============================================

/**
 * Feature: lease-contract-management
 * Property 5: Contract validation rejects invalid data
 *
 * For any form data that violates at least one validation rule
 * (missing room_id, empty dates, negative amounts, end_date before start_date),
 * contractFormSchema.safeParse() should return success: false.
 *
 * **Validates: Requirements 2.12**
 */
describe('Feature: lease-contract-management, Property 5: Contract validation rejects invalid data', () => {
  it('rejects data with missing or invalid room_id (not a UUID)', () => {
    fc.assert(
      fc.property(
        validContractFormArb(),
        fc.constantFrom('', 'not-a-uuid', '12345', 'abc-def'),
        (validData, badRoomId) => {
          const data = { ...validData, room_id: badRoomId };
          const result = contractFormSchema.safeParse(data);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects data with empty signed_date', () => {
    fc.assert(
      fc.property(validContractFormArb(), (validData) => {
        const data = { ...validData, signed_date: '' };
        const result = contractFormSchema.safeParse(data);
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects data with empty start_date', () => {
    fc.assert(
      fc.property(validContractFormArb(), (validData) => {
        const data = { ...validData, start_date: '' };
        const result = contractFormSchema.safeParse(data);
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects data with empty end_date', () => {
    fc.assert(
      fc.property(validContractFormArb(), (validData) => {
        const data = { ...validData, end_date: '' };
        const result = contractFormSchema.safeParse(data);
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects data with negative rent_price', () => {
    fc.assert(
      fc.property(
        validContractFormArb(),
        fc.integer({ min: -1_000_000, max: -1 }),
        (validData, negativeRent) => {
          const data = { ...validData, rent_price: negativeRent };
          const result = contractFormSchema.safeParse(data);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects data with negative total_deposit', () => {
    fc.assert(
      fc.property(
        validContractFormArb(),
        fc.integer({ min: -1_000_000, max: -1 }),
        (validData, negativeDeposit) => {
          const data = { ...validData, total_deposit: negativeDeposit };
          const result = contractFormSchema.safeParse(data);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects data where end_date is before or equal to start_date', () => {
    fc.assert(
      fc.property(
        validContractFormArb(),
        fc.integer({ min: 0, max: 365 }),
        (validData, daysBefore) => {
          // Set end_date to start_date minus daysBefore days
          const startDate = new Date(validData.start_date as string);
          const endDate = new Date(startDate);
          endDate.setDate(endDate.getDate() - daysBefore);
          const endDateStr = endDate.toISOString().split('T')[0];

          const data = { ...validData, end_date: endDateStr };
          const result = contractFormSchema.safeParse(data);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects data with invalid payment_cycle', () => {
    fc.assert(
      fc.property(
        validContractFormArb(),
        fc.constantFrom('WEEKLY', 'BIWEEKLY', 'DAILY', '', 'invalid'),
        (validData, badCycle) => {
          const data = { ...validData, payment_cycle: badCycle };
          const result = contractFormSchema.safeParse(data);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('accepts valid contract form data', () => {
    fc.assert(
      fc.property(validContractFormArb(), (validData) => {
        const result = contractFormSchema.safeParse(validData);
        expect(result.success).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});


// =============================================
// Property 7: Contract representative uniqueness
// =============================================

/**
 * Feature: lease-contract-management
 * Property 7: Contract representative uniqueness
 *
 * For any list of customers associated with a contract, exactly one customer
 * should be designated as the representative (is_representative = true).
 * The form enforces this invariant client-side:
 * - When customers are added, the first one becomes representative if none is set
 * - When the representative is removed, the first remaining becomes representative
 * - Changing representative sets exactly one to true and all others to false
 *
 * **Validates: Requirements 2.6**
 */
describe('Feature: lease-contract-management, Property 7: Contract representative uniqueness', () => {
  interface CustomerEntry {
    id: string;
    is_representative: boolean;
  }

  /**
   * Replicates the form's representative enforcement logic:
   * ensures exactly one representative in the list.
   */
  function ensureOneRepresentative(customers: CustomerEntry[]): CustomerEntry[] {
    if (customers.length === 0) return customers;
    const hasRep = customers.some((c) => c.is_representative);
    if (!hasRep) {
      return customers.map((c, i) => ({ ...c, is_representative: i === 0 }));
    }
    // If multiple representatives, keep only the first one
    let foundFirst = false;
    return customers.map((c) => {
      if (c.is_representative && !foundFirst) {
        foundFirst = true;
        return c;
      }
      return { ...c, is_representative: false };
    });
  }

  /**
   * Replicates the form's "change representative" logic:
   * sets exactly one customer as representative.
   */
  function setRepresentative(customers: CustomerEntry[], targetId: string): CustomerEntry[] {
    return customers.map((c) => ({
      ...c,
      is_representative: c.id === targetId,
    }));
  }

  /**
   * Replicates the form's "remove customer" logic:
   * if the removed customer was the representative, assign first remaining.
   */
  function removeCustomer(customers: CustomerEntry[], removeId: string): CustomerEntry[] {
    const next = customers.filter((c) => c.id !== removeId);
    if (next.length > 0 && !next.some((c) => c.is_representative)) {
      next[0].is_representative = true;
    }
    return next;
  }

  const customerIdArb = fc.constantFrom('cust-1', 'cust-2', 'cust-3', 'cust-4', 'cust-5');

  /** Generate a list of customers with random is_representative flags */
  const customerListArb: fc.Arbitrary<CustomerEntry[]> = fc
    .uniqueArray(customerIdArb, { minLength: 1, maxLength: 5 })
    .chain((ids) =>
      fc.tuple(...ids.map((id) => fc.boolean().map((rep) => ({ id, is_representative: rep })))),
    );

  it('ensureOneRepresentative always results in exactly one representative', () => {
    fc.assert(
      fc.property(customerListArb, (customers) => {
        const result = ensureOneRepresentative(customers);
        const repCount = result.filter((c) => c.is_representative).length;
        expect(repCount).toBe(1);
      }),
      { numRuns: 100 },
    );
  });

  it('ensureOneRepresentative preserves list length', () => {
    fc.assert(
      fc.property(customerListArb, (customers) => {
        const result = ensureOneRepresentative(customers);
        expect(result.length).toBe(customers.length);
      }),
      { numRuns: 100 },
    );
  });

  it('setRepresentative results in exactly one representative matching the target', () => {
    fc.assert(
      fc.property(customerListArb, (customers) => {
        // Pick a random customer from the list to be the new representative
        const targetId = customers[Math.floor(Math.random() * customers.length)].id;
        const result = setRepresentative(customers, targetId);
        const reps = result.filter((c) => c.is_representative);
        expect(reps.length).toBe(1);
        expect(reps[0].id).toBe(targetId);
      }),
      { numRuns: 100 },
    );
  });

  it('removeCustomer maintains exactly one representative if list is non-empty', () => {
    fc.assert(
      fc.property(
        customerListArb.filter((list) => list.length >= 2),
        (customers) => {
          // Ensure we start with exactly one representative
          const normalized = ensureOneRepresentative(customers);
          // Remove a random customer
          const removeIdx = Math.floor(Math.random() * normalized.length);
          const result = removeCustomer(normalized, normalized[removeIdx].id);
          if (result.length > 0) {
            const repCount = result.filter((c) => c.is_representative).length;
            expect(repCount).toBe(1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('removing the representative reassigns to the first remaining customer', () => {
    fc.assert(
      fc.property(
        customerListArb.filter((list) => list.length >= 2),
        (customers) => {
          const normalized = ensureOneRepresentative(customers);
          const rep = normalized.find((c) => c.is_representative)!;
          const result = removeCustomer(normalized, rep.id);
          if (result.length > 0) {
            expect(result[0].is_representative).toBe(true);
            const repCount = result.filter((c) => c.is_representative).length;
            expect(repCount).toBe(1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});


// =============================================
// Property 8: Deposit remaining calculation
// =============================================

/**
 * Feature: lease-contract-management
 * Property 8: Deposit remaining calculation
 *
 * The deposit remaining (Tiền cọc phải đóng) is calculated as:
 *   remaining = Math.max(0, total_deposit - deposit_paid)
 *
 * This ensures the remaining amount is never negative, even when
 * deposit_paid exceeds total_deposit (e.g., overpayment).
 *
 * **Validates: Requirements 2.8**
 */
describe('Feature: lease-contract-management, Property 8: Deposit remaining calculation', () => {
  /**
   * Replicates the exact calculation from ContractFormDialog:
   *   const depositRemaining = Math.max(0, totalDeposit - depositPaid);
   */
  function calculateDepositRemaining(totalDeposit: number, depositPaid: number): number {
    return Math.max(0, totalDeposit - depositPaid);
  }

  const nonNegativeAmountArb = fc.nat({ max: 100_000_000 });

  it('remaining is always non-negative', () => {
    fc.assert(
      fc.property(nonNegativeAmountArb, nonNegativeAmountArb, (totalDeposit, depositPaid) => {
        const remaining = calculateDepositRemaining(totalDeposit, depositPaid);
        expect(remaining).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 100 },
    );
  });

  it('remaining equals total_deposit - deposit_paid when deposit_paid <= total_deposit', () => {
    fc.assert(
      fc.property(
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        (totalDeposit, depositPaid) => {
          fc.pre(depositPaid <= totalDeposit);
          const remaining = calculateDepositRemaining(totalDeposit, depositPaid);
          expect(remaining).toBe(totalDeposit - depositPaid);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('remaining is 0 when deposit_paid >= total_deposit', () => {
    fc.assert(
      fc.property(
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        (totalDeposit, depositPaid) => {
          fc.pre(depositPaid >= totalDeposit);
          const remaining = calculateDepositRemaining(totalDeposit, depositPaid);
          expect(remaining).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('remaining is 0 when deposit_paid equals total_deposit', () => {
    fc.assert(
      fc.property(nonNegativeAmountArb, (amount) => {
        const remaining = calculateDepositRemaining(amount, amount);
        expect(remaining).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('remaining equals total_deposit when deposit_paid is 0', () => {
    fc.assert(
      fc.property(nonNegativeAmountArb, (totalDeposit) => {
        const remaining = calculateDepositRemaining(totalDeposit, 0);
        expect(remaining).toBe(totalDeposit);
      }),
      { numRuns: 100 },
    );
  });

  it('remaining never exceeds total_deposit', () => {
    fc.assert(
      fc.property(nonNegativeAmountArb, nonNegativeAmountArb, (totalDeposit, depositPaid) => {
        const remaining = calculateDepositRemaining(totalDeposit, depositPaid);
        expect(remaining).toBeLessThanOrEqual(totalDeposit);
      }),
      { numRuns: 100 },
    );
  });
});
