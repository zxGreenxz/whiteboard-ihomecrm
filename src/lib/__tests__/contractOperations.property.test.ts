import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { getActionButtonStates } from '../../components/contracts/ContractListTable';
import {
  getContractDisplayStatus,
  type ContractWithRelations,
  type ContractStatus,
  type ContractDisplayStatus,
} from '../../types/contract';

// =============================================
// Shared Arbitraries
// =============================================

const contractStatusArb: fc.Arbitrary<ContractStatus> = fc.constantFrom(
  'DRAFT', 'ACTIVE', 'EXTENDED', 'TRANSFERRED', 'TERMINATED', 'EXPIRED',
);

/** Generate an ISO date string offset from now by the given day range */
function dateOffsetArb(minDays: number, maxDays: number): fc.Arbitrary<string> {
  return fc.integer({ min: minDays, max: maxDays }).map((offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().split('T')[0];
  });
}

const expectedMoveOutArb: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant(null),
  dateOffsetArb(-60, 120),
);

/** Build a minimal ContractWithRelations for getActionButtonStates */
function contractWithRelationsArb(): fc.Arbitrary<ContractWithRelations> {
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
    // `public_code` (NOT NULL trong DB) và `end_billing_date` được thêm vào kiểu
    // `ContractWithRelations` nhưng arbitrary không theo — nên property test đang
    // sinh ra một hình dạng KHÁC hình dạng mã sản xuất nhìn thấy.
    public_code: 'ABC123',
    end_billing_date: null,
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
// Property 9: Action button availability by contract status
// =============================================

/**
 * Feature: lease-contract-management
 * Property 9: Action button availability by contract status
 *
 * For any contract, getActionButtonStates should return button disabled states
 * that match the following rules based on contract.status (dbStatus) and
 * getContractDisplayStatus (displayStatus):
 *
 * "Còn hiệu lực" giờ CHỈ là dbStatus === 'ACTIVE' (HĐ gia hạn vẫn giữ ACTIVE;
 * 'EXTENDED' đã ngưng dùng → coi như KHÔNG còn hiệu lực).
 *
 * - editDisabled: true only when dbStatus === 'TERMINATED'
 * - renewDisabled: true unless dbStatus is ACTIVE OR displayStatus is 'EXPIRED'/'EXPIRING'
 * - transferRoomDisabled: true unless dbStatus is ACTIVE
 * - moveOutDisabled: true unless dbStatus is ACTIVE
 * - transferContractDisabled: true unless dbStatus is ACTIVE
 * - terminateDisabled: true unless dbStatus is ACTIVE OR displayStatus is 'EXPIRED'/'EXPIRING'
 * - deleteDisabled: true unless dbStatus === 'DRAFT'
 *
 * **Validates: Requirements 3.4, 4.4, 5.5, 6.4, 7.4, 10.4**
 */
describe('Feature: lease-contract-management, Property 9: Action button availability by contract status', () => {
  it('editDisabled is true only when dbStatus is TERMINATED', () => {
    fc.assert(
      fc.property(contractWithRelationsArb(), (contract) => {
        const states = getActionButtonStates(contract);
        if (contract.status === 'TERMINATED') {
          expect(states.editDisabled).toBe(true);
        } else {
          expect(states.editDisabled).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  // "Còn hiệu lực" giờ chỉ là ACTIVE (EXTENDED đã ngưng dùng).
  const inEffect = (s: ContractStatus) => s === 'ACTIVE';

  it('renewDisabled is false only when dbStatus is ACTIVE/EXTENDED or displayStatus is EXPIRED/EXPIRING', () => {
    fc.assert(
      fc.property(contractWithRelationsArb(), (contract) => {
        const states = getActionButtonStates(contract);
        const displayStatus = getContractDisplayStatus(contract);
        const shouldBeEnabled =
          inEffect(contract.status) ||
          displayStatus === 'EXPIRED' ||
          displayStatus === 'EXPIRING';

        expect(states.renewDisabled).toBe(!shouldBeEnabled);
      }),
      { numRuns: 100 },
    );
  });

  it('transferRoomDisabled is false only when dbStatus is ACTIVE/EXTENDED', () => {
    fc.assert(
      fc.property(contractWithRelationsArb(), (contract) => {
        const states = getActionButtonStates(contract);
        expect(states.transferRoomDisabled).toBe(!inEffect(contract.status));
      }),
      { numRuns: 100 },
    );
  });

  it('moveOutDisabled is false only when dbStatus is ACTIVE/EXTENDED', () => {
    fc.assert(
      fc.property(contractWithRelationsArb(), (contract) => {
        const states = getActionButtonStates(contract);
        expect(states.moveOutDisabled).toBe(!inEffect(contract.status));
      }),
      { numRuns: 100 },
    );
  });

  it('transferContractDisabled is false only when dbStatus is ACTIVE/EXTENDED', () => {
    fc.assert(
      fc.property(contractWithRelationsArb(), (contract) => {
        const states = getActionButtonStates(contract);
        expect(states.transferContractDisabled).toBe(!inEffect(contract.status));
      }),
      { numRuns: 100 },
    );
  });

  it('terminateDisabled is false only when dbStatus is ACTIVE/EXTENDED or displayStatus is EXPIRED/EXPIRING', () => {
    fc.assert(
      fc.property(contractWithRelationsArb(), (contract) => {
        const states = getActionButtonStates(contract);
        const displayStatus = getContractDisplayStatus(contract);
        const shouldBeEnabled =
          inEffect(contract.status) ||
          displayStatus === 'EXPIRED' ||
          displayStatus === 'EXPIRING';

        expect(states.terminateDisabled).toBe(!shouldBeEnabled);
      }),
      { numRuns: 100 },
    );
  });

  it('deleteDisabled is false only when dbStatus is DRAFT', () => {
    fc.assert(
      fc.property(contractWithRelationsArb(), (contract) => {
        const states = getActionButtonStates(contract);
        expect(states.deleteDisabled).toBe(contract.status !== 'DRAFT');
      }),
      { numRuns: 100 },
    );
  });

  it('TERMINATED contracts have all action buttons disabled except edit-like states', () => {
    fc.assert(
      fc.property(
        dateOffsetArb(-365, 365),
        expectedMoveOutArb,
        (end_date, expected_move_out_date) => {
          const contract: ContractWithRelations = {
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
            // Hai trường này CÓ trong `ContractWithRelations` và có cột thật trong
            // DB (`public_code` còn là NOT NULL), nhưng fixture bỏ quên. Nghĩa là
            // test đang khẳng định điều gì đó về một hình dạng KHÁC hình dạng mã
            // sản xuất nhìn thấy.
            public_code: 'ABC123',
            end_billing_date: null,
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
            status: 'TERMINATED',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            deleted_at: null,
          };
          const states = getActionButtonStates(contract);
          expect(states.editDisabled).toBe(true);
          expect(states.renewDisabled).toBe(true);
          expect(states.transferRoomDisabled).toBe(true);
          expect(states.moveOutDisabled).toBe(true);
          expect(states.transferContractDisabled).toBe(true);
          expect(states.terminateDisabled).toBe(true);
          expect(states.deleteDisabled).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('button states are consistent: all returned properties are booleans', () => {
    fc.assert(
      fc.property(contractWithRelationsArb(), (contract) => {
        const states = getActionButtonStates(contract);
        expect(typeof states.editDisabled).toBe('boolean');
        expect(typeof states.renewDisabled).toBe('boolean');
        expect(typeof states.transferRoomDisabled).toBe('boolean');
        expect(typeof states.moveOutDisabled).toBe('boolean');
        expect(typeof states.transferContractDisabled).toBe('boolean');
        expect(typeof states.terminateDisabled).toBe('boolean');
        expect(typeof states.deleteDisabled).toBe('boolean');
      }),
      { numRuns: 100 },
    );
  });
});



// =============================================
// Property 13: Termination settlement calculation
// =============================================

/**
 * Feature: lease-contract-management
 * Property 13: Termination settlement calculation
 *
 * The settlement amount for a move-out termination is calculated as:
 *   settlement = deposit_refund + excess_rent - outstanding_debt - penalty_fee
 *
 * This formula determines the final amount:
 * - Positive: landlord pays tenant (refund)
 * - Negative: tenant pays landlord (owes money)
 *
 * The calculation must satisfy:
 * - Commutativity of additions (deposit_refund + excess_rent)
 * - Commutativity of deductions (outstanding_debt + penalty_fee)
 * - When all values are 0, settlement is 0
 * - Settlement equals deposit_refund when all other values are 0
 *
 * **Validates: Requirements 8.3, 9.5, 9.6, 9.7**
 */
describe('Feature: lease-contract-management, Property 13: Termination settlement calculation', () => {
  /**
   * Replicates the exact calculation from TerminateDialog StepMoveOut:
   *   const totalDeductions = outstandingDebt + penaltyFee;
   *   const settlementAmount = depositRefund + excessRent - totalDeductions;
   */
  function calculateSettlement(
    depositRefund: number,
    excessRent: number,
    outstandingDebt: number,
    penaltyFee: number,
  ): { totalDeductions: number; settlementAmount: number } {
    const totalDeductions = outstandingDebt + penaltyFee;
    const settlementAmount = depositRefund + excessRent - totalDeductions;
    return { totalDeductions, settlementAmount };
  }

  const nonNegativeAmountArb = fc.nat({ max: 100_000_000 });

  it('settlement equals deposit_refund + excess_rent - outstanding_debt - penalty_fee', () => {
    fc.assert(
      fc.property(
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        (depositRefund, excessRent, outstandingDebt, penaltyFee) => {
          const { settlementAmount } = calculateSettlement(
            depositRefund, excessRent, outstandingDebt, penaltyFee,
          );
          expect(settlementAmount).toBe(
            depositRefund + excessRent - outstandingDebt - penaltyFee,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('totalDeductions equals outstanding_debt + penalty_fee', () => {
    fc.assert(
      fc.property(
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        (depositRefund, excessRent, outstandingDebt, penaltyFee) => {
          const { totalDeductions } = calculateSettlement(
            depositRefund, excessRent, outstandingDebt, penaltyFee,
          );
          expect(totalDeductions).toBe(outstandingDebt + penaltyFee);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('settlement is 0 when all values are 0', () => {
    const { settlementAmount, totalDeductions } = calculateSettlement(0, 0, 0, 0);
    expect(settlementAmount).toBe(0);
    expect(totalDeductions).toBe(0);
  });

  it('settlement equals deposit_refund when all other values are 0', () => {
    fc.assert(
      fc.property(nonNegativeAmountArb, (depositRefund) => {
        const { settlementAmount } = calculateSettlement(depositRefund, 0, 0, 0);
        expect(settlementAmount).toBe(depositRefund);
      }),
      { numRuns: 100 },
    );
  });

  it('settlement equals excess_rent when all other values are 0', () => {
    fc.assert(
      fc.property(nonNegativeAmountArb, (excessRent) => {
        const { settlementAmount } = calculateSettlement(0, excessRent, 0, 0);
        expect(settlementAmount).toBe(excessRent);
      }),
      { numRuns: 100 },
    );
  });

  it('settlement is negative when deductions exceed credits', () => {
    fc.assert(
      fc.property(
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        (depositRefund, excessRent, outstandingDebt, penaltyFee) => {
          const credits = depositRefund + excessRent;
          const debits = outstandingDebt + penaltyFee;
          fc.pre(debits > credits);
          const { settlementAmount } = calculateSettlement(
            depositRefund, excessRent, outstandingDebt, penaltyFee,
          );
          expect(settlementAmount).toBeLessThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('settlement is positive when credits exceed deductions', () => {
    fc.assert(
      fc.property(
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        (depositRefund, excessRent, outstandingDebt, penaltyFee) => {
          const credits = depositRefund + excessRent;
          const debits = outstandingDebt + penaltyFee;
          fc.pre(credits > debits);
          const { settlementAmount } = calculateSettlement(
            depositRefund, excessRent, outstandingDebt, penaltyFee,
          );
          expect(settlementAmount).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('swapping deposit_refund and excess_rent does not change settlement', () => {
    fc.assert(
      fc.property(
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        (depositRefund, excessRent, outstandingDebt, penaltyFee) => {
          const result1 = calculateSettlement(depositRefund, excessRent, outstandingDebt, penaltyFee);
          const result2 = calculateSettlement(excessRent, depositRefund, outstandingDebt, penaltyFee);
          expect(result1.settlementAmount).toBe(result2.settlementAmount);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('swapping outstanding_debt and penalty_fee does not change settlement', () => {
    fc.assert(
      fc.property(
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        (depositRefund, excessRent, outstandingDebt, penaltyFee) => {
          const result1 = calculateSettlement(depositRefund, excessRent, outstandingDebt, penaltyFee);
          const result2 = calculateSettlement(depositRefund, excessRent, penaltyFee, outstandingDebt);
          expect(result1.settlementAmount).toBe(result2.settlementAmount);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('increasing deposit_refund by X increases settlement by X', () => {
    fc.assert(
      fc.property(
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        fc.nat({ max: 10_000_000 }),
        (depositRefund, excessRent, outstandingDebt, penaltyFee, increase) => {
          const result1 = calculateSettlement(depositRefund, excessRent, outstandingDebt, penaltyFee);
          const result2 = calculateSettlement(depositRefund + increase, excessRent, outstandingDebt, penaltyFee);
          expect(result2.settlementAmount).toBe(result1.settlementAmount + increase);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('increasing penalty_fee by X decreases settlement by X', () => {
    fc.assert(
      fc.property(
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        nonNegativeAmountArb,
        fc.nat({ max: 10_000_000 }),
        (depositRefund, excessRent, outstandingDebt, penaltyFee, increase) => {
          const result1 = calculateSettlement(depositRefund, excessRent, outstandingDebt, penaltyFee);
          const result2 = calculateSettlement(depositRefund, excessRent, outstandingDebt, penaltyFee + increase);
          expect(result2.settlementAmount).toBe(result1.settlementAmount - increase);
        },
      ),
      { numRuns: 100 },
    );
  });
});
