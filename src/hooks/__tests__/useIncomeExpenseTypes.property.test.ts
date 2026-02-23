import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  applyTypeUpdate,
  type IncomeExpenseTypeBase,
} from '../useIncomeExpensesHelpers';

/**
 * Feature: thu-chi-reimplementation
 * Property 14: Loại thu chi CRUD round-trip
 * **Validates: Yêu cầu 9.3**
 *
 * Với bất kỳ loại thu chi hợp lệ nào, sau khi tạo và đọc lại, tất cả các trường phải
 * khớp với giá trị đã nhập. Sau khi cập nhật và đọc lại, các trường đã cập nhật phải
 * phản ánh giá trị mới.
 */
describe('Property 14: Loại thu chi CRUD round-trip', () => {
  const typeArb: fc.Arbitrary<IncomeExpenseTypeBase> = fc.record({
    id: fc.uuid(),
    name: fc.string({ minLength: 1, maxLength: 50 }),
    type: fc.constantFrom('income' as const, 'expense' as const),
    description: fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: null }),
    is_default: fc.boolean(),
    updated_at: fc.constant('2025-01-01T00:00:00Z'),
  });

  const updatesArb = fc.record({
    name: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
    type: fc.option(fc.constantFrom('income' as const, 'expense' as const), { nil: undefined }),
    description: fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: undefined }),
    is_default: fc.option(fc.boolean(), { nil: undefined }),
  });

  it('updated fields should reflect new values and updated_at should change', () => {
    fc.assert(
      fc.property(typeArb, updatesArb, (typeObj, updates) => {
        const newUpdatedAt = '2025-07-01T12:00:00Z';
        const result = applyTypeUpdate(typeObj, updates, newUpdatedAt);

        // updated_at must be the new timestamp
        expect(result.updated_at).toBe(newUpdatedAt);

        // Each defined update must be reflected
        if (updates.name !== undefined) expect(result.name).toBe(updates.name);
        if (updates.type !== undefined) expect(result.type).toBe(updates.type);
        if (updates.description !== undefined) expect(result.description).toBe(updates.description);
        if (updates.is_default !== undefined) expect(result.is_default).toBe(updates.is_default);

        // Unchanged fields must remain the same
        expect(result.id).toBe(typeObj.id);
      }),
      { numRuns: 100 },
    );
  });

  it('applying empty updates should only change updated_at', () => {
    fc.assert(
      fc.property(typeArb, (typeObj) => {
        const newUpdatedAt = '2025-07-01T12:00:00Z';
        const result = applyTypeUpdate(typeObj, {}, newUpdatedAt);

        expect(result.updated_at).toBe(newUpdatedAt);
        expect(result.name).toBe(typeObj.name);
        expect(result.type).toBe(typeObj.type);
        expect(result.description).toBe(typeObj.description);
        expect(result.is_default).toBe(typeObj.is_default);
        expect(result.id).toBe(typeObj.id);
      }),
      { numRuns: 100 },
    );
  });
});
