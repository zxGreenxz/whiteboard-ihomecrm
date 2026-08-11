import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  incomeExpenseFormSchema,
  type IncomeExpenseFormValues,
} from '../incomeExpenseValidation';

/**
 * Feature: thu-chi-reimplementation, Property 6: Zod validation round-trip
 * Validates: Requirements 12.10
 */

const voucherTypeArb = fc.constantFrom('INCOME' as const, 'EXPENSE' as const);
const voucherDateArb = fc
  .integer({ min: 0, max: 3650 })
  .map((offset) => {
    const base = new Date(2020, 0, 1);
    const d = new Date(base.getTime() + offset * 86400000);
    return d.toISOString().split('T')[0];
  });

const validDatePairArb = fc
  .tuple(
    fc.integer({ min: 0, max: 3650 }), // offset from 2020-01-01 for start
    fc.integer({ min: 0, max: 365 }),   // additional offset for end (ensures end >= start)
  )
  .map(([startOffset, endOffset]) => {
    const base = new Date(2020, 0, 1);
    const startDate = new Date(base.getTime() + startOffset * 86400000);
    const endDate = new Date(startDate.getTime() + endOffset * 86400000);
    return {
      start_date: startDate.toISOString().split('T')[0],
      end_date: endDate.toISOString().split('T')[0],
    };
  });

const validItemArb = fc.record({
  income_expense_type_id: fc.uuid(),
  description: fc.option(fc.string({ maxLength: 200 }), { nil: null }),
  quantity: fc.integer({ min: 1, max: 10000 }),
  unit_price: fc.float({ min: 0, max: 1_000_000_000, noNaN: true }),
}).chain((item) =>
  validDatePairArb.map((dates) => ({ ...item, ...dates }))
);

const validFormValuesArb = fc.record({
  type: voucherTypeArb,
  name: fc.string({ minLength: 1, maxLength: 100 }),
  building_id: fc.uuid(),
  room_id: fc.option(fc.uuid(), { nil: null }),
  tenant_id: fc.option(fc.uuid(), { nil: null }),
  contract_id: fc.option(fc.uuid(), { nil: null }),
  payer_name: fc.string({ minLength: 1, maxLength: 100 }),
  account_id: fc.string({ minLength: 1, maxLength: 100 }),
  voucher_date: voucherDateArb,
  notes: fc.option(fc.string({ maxLength: 500 }), { nil: null }),
  // null = tự động (theo hạng mục cọc); true/false = override tay.
  business_result_accounting: fc.option(fc.boolean(), { nil: null }),
  attachments: fc.array(fc.string({ minLength: 1 }), { maxLength: 5 }),
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
          expect(result.data.tenant_id).toBe(formValues.tenant_id);
          expect(result.data.voucher_date).toBe(formValues.voucher_date);
          // Cờ KQKD: null = auto, true/false = override — phải round-trip đúng.
          expect(result.data.business_result_accounting).toBe(
            formValues.business_result_accounting,
          );
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
function makeValidBase(): IncomeExpenseFormValues {
  return {
    type: 'INCOME' as const,
    name: 'Test voucher',
    building_id: '00000000-0000-0000-0000-000000000001',
    room_id: null,
    tenant_id: null,
    contract_id: null,
    payer_name: 'Nguyen Van A',
    account_id: '00000000-0000-0000-0000-000000000003',
    voucher_date: '2024-01-15',
    // `notes` KHÔNG tồn tại trong `incomeExpenseFormSchema` (chỉ có ở
    // `incomeExpenseBatchFormSchema`) — fixture cũ dựng một trường mà mã sản
    // xuất không hề nhìn thấy, zod lặng lẽ vứt đi.
    business_result_accounting: false,
    attachments: [],
    items: [
      {
        income_expense_type_id: '00000000-0000-0000-0000-000000000002',
        description: null,
        quantity: 1,
        unit_price: 100,
        start_date: '2024-01-15',
        end_date: '2024-01-15',
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
          const input: IncomeExpenseFormValues = { ...makeValidBase(), items: [] };
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
        const input: IncomeExpenseFormValues = {
          ...makeValidBase(),
          items: [
            {
              income_expense_type_id: '00000000-0000-0000-0000-000000000002',
              description: null,
              quantity: qty,
              unit_price: 100,
              // `start_date`/`end_date` là trường BẮT BUỘC của `itemSchema`; thiếu
              // chúng thì phiếu hỏng vì lý do khác, không phải vì `quantity` — test
              // sẽ xanh mà không hề chứng minh điều nó tuyên bố.
              start_date: '2024-01-15',
              end_date: '2024-01-15',
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
        const input: IncomeExpenseFormValues = {
          ...makeValidBase(),
          items: [
            {
              income_expense_type_id: '00000000-0000-0000-0000-000000000002',
              description: null,
              quantity: 1,
              unit_price: price,
              // Xem ghi chú ở test `quantity < 1`: thiếu ngày thì phiếu hỏng vì
              // ngày, không phải vì `unit_price`.
              start_date: '2024-01-15',
              end_date: '2024-01-15',
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
          const input: IncomeExpenseFormValues = {
            ...makeValidBase(),
            items: [
              {
                income_expense_type_id: '',
                description: null,
                quantity: 1,
                unit_price: 100,
                // Xem ghi chú ở test `quantity < 1`: thiếu ngày thì phiếu hỏng vì
                // ngày, không phải vì `income_expense_type_id` rỗng.
                start_date: '2024-01-15',
                end_date: '2024-01-15',
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
