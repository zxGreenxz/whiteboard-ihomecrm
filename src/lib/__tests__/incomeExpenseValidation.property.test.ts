import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { incomeExpenseFormSchema } from '../incomeExpenseValidation';

/**
 * Feature: thu-chi-reimplementation, Property 6: Zod validation round-trip
 * Validates: Requirements 12.10
 */

const voucherTypeArb = fc.constantFrom('INCOME' as const, 'EXPENSE' as const);
const voucherDateArb = fc
  .date({ min: new Date(2020, 0, 1), max: new Date(2030, 11, 31) })
  .map((d) => d.toISOString().split('T')[0]);

const validItemArb = fc.record({
  income_expense_type_id: fc.uuid(),
  description: fc.option(fc.string({ maxLength: 200 }), { nil: null }),
  quantity: fc.integer({ min: 1, max: 10000 }),
  unit_price: fc.float({ min: 0, max: 1_000_000_000, noNaN: true }),
});

const validFormValuesArb = fc.record({
  type: voucherTypeArb,
  name: fc.string({ minLength: 1, maxLength: 100 }),
  building_id: fc.uuid(),
  room_id: fc.option(fc.uuid(), { nil: null }),
  bed_id: fc.option(fc.uuid(), { nil: null }),
  tenant_id: fc.option(fc.uuid(), { nil: null }),
  voucher_date: voucherDateArb,
  notes: fc.option(fc.string({ maxLength: 500 }), { nil: null }),
  items: fc.array(validItemArb, { minLength: 1, maxLength: 10 }),
});

describe('Property 6: Zod validation round-trip', () => {
  it('should successfully parse any valid IncomeExpenseFormValues and return an equivalent object', () => {
    fc.assert(
      fc.property(validFormValuesArb, (formValues) => {
        const result = incomeExpenseFormSchema.safeParse(formValues);

        // Parsing must succeed
        expect(result.success).toBe(true);

        if (result.success) {
          // Parsed data must be equivalent to input
          expect(result.data.type).toBe(formValues.type);
          expect(result.data.name).toBe(formValues.name);
          expect(result.data.building_id).toBe(formValues.building_id);
          expect(result.data.room_id).toBe(formValues.room_id);
          expect(result.data.bed_id).toBe(formValues.bed_id);
          expect(result.data.tenant_id).toBe(formValues.tenant_id);
          expect(result.data.voucher_date).toBe(formValues.voucher_date);
          expect(result.data.notes).toBe(formValues.notes);
          expect(result.data.items).toHaveLength(formValues.items.length);

          for (let i = 0; i < formValues.items.length; i++) {
            expect(result.data.items[i].income_expense_type_id).toBe(
              formValues.items[i].income_expense_type_id,
            );
            expect(result.data.items[i].description).toBe(formValues.items[i].description);
            expect(result.data.items[i].quantity).toBe(formValues.items[i].quantity);
            expect(result.data.items[i].unit_price).toBe(formValues.items[i].unit_price);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: thu-chi-reimplementation, Property 7: Zod validation rejects invalid input
 * Validates: Requirements 2.11, 2.12, 3.5, 12.1–12.8, 12.11
 */

/** Helper: build a valid base form object for mutation */
function makeValidBase() {
  return {
    type: 'INCOME' as const,
    name: 'Test voucher',
    building_id: '00000000-0000-0000-0000-000000000001',
    room_id: null,
    bed_id: null,
    tenant_id: null,
    voucher_date: '2024-01-15',
    notes: null,
    items: [
      {
        income_expense_type_id: '00000000-0000-0000-0000-000000000002',
        description: null,
        quantity: 1,
        unit_price: 100,
      },
    ],
  };
}

describe('Property 7: Zod validation rejects invalid input', () => {
  const requiredFieldArb = fc.constantFrom(
    'type' as const,
    'name' as const,
    'building_id' as const,
    'voucher_date' as const,
  );

  it('missing a required field → safeParse fails', () => {
    fc.assert(
      fc.property(requiredFieldArb, (field) => {
        const input = { ...makeValidBase() };
        delete (input as Record<string, unknown>)[field];

        const result = incomeExpenseFormSchema.safeParse(input);
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('empty items array → safeParse fails', () => {
    fc.assert(
      fc.property(
        fc.constant(null),
        () => {
          const input = { ...makeValidBase(), items: [] };
          const result = incomeExpenseFormSchema.safeParse(input);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('items with quantity < 1 → safeParse fails', () => {
    const badQuantityArb = fc.integer({ min: -10000, max: 0 });

    fc.assert(
      fc.property(badQuantityArb, (qty) => {
        const input = {
          ...makeValidBase(),
          items: [
            {
              income_expense_type_id: '00000000-0000-0000-0000-000000000002',
              description: null,
              quantity: qty,
              unit_price: 100,
            },
          ],
        };
        const result = incomeExpenseFormSchema.safeParse(input);
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('items with unit_price < 0 → safeParse fails', () => {
    const badPriceArb = fc.float({ min: Math.fround(-1_000_000), max: Math.fround(-0.01), noNaN: true });

    fc.assert(
      fc.property(badPriceArb, (price) => {
        const input = {
          ...makeValidBase(),
          items: [
            {
              income_expense_type_id: '00000000-0000-0000-0000-000000000002',
              description: null,
              quantity: 1,
              unit_price: price,
            },
          ],
        };
        const result = incomeExpenseFormSchema.safeParse(input);
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('items with empty income_expense_type_id → safeParse fails', () => {
    fc.assert(
      fc.property(
        fc.constant(null),
        () => {
          const input = {
            ...makeValidBase(),
            items: [
              {
                income_expense_type_id: '',
                description: null,
                quantity: 1,
                unit_price: 100,
              },
            ],
          };
          const result = incomeExpenseFormSchema.safeParse(input);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
