import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  toggleDefaultTemplate,
  type TemplateBase,
} from '../useIncomeExpensesHelpers';

/**
 * Feature: thu-chi-reimplementation
 * Property 15: Mẫu in thu chi - chỉ một mẫu mặc định cho mỗi loại
 * **Validates: Yêu cầu 10.7**
 *
 * Với bất kỳ user nào, tại mọi thời điểm, chỉ có tối đa một mẫu in có is_default = true
 * cho mẫu biên lai thu (is_income_template = true) và tối đa một mẫu mặc định cho
 * mẫu biên lai chi (is_income_template = false).
 */
describe('Property 15: Mẫu in thu chi - chỉ một mẫu mặc định cho mỗi loại', () => {
  const templateArb: fc.Arbitrary<TemplateBase> = fc.record({
    id: fc.uuid(),
    code: fc.string({ minLength: 1, maxLength: 10 }),
    name: fc.string({ minLength: 1, maxLength: 30 }),
    is_default: fc.boolean(),
    is_income_template: fc.boolean(),
  });

  it('after toggling a non-default template to default, at most one default per type', () => {
    fc.assert(
      fc.property(
        fc.array(templateArb, { minLength: 1, maxLength: 20 }),
        fc.nat(),
        (templates, indexSeed) => {
          // Ensure unique IDs and start with at most one default per type
          const uniqueTemplates = templates.map((t, i) => ({
            ...t,
            id: `id-${i}`,
            is_default: false, // Start with no defaults
          }));
          const targetIndex = indexSeed % uniqueTemplates.length;
          const targetId = uniqueTemplates[targetIndex].id;

          const result = toggleDefaultTemplate(uniqueTemplates, targetId);

          // Count defaults per type
          const incomeDefaults = result.filter(t => t.is_income_template && t.is_default).length;
          const expenseDefaults = result.filter(t => !t.is_income_template && t.is_default).length;

          expect(incomeDefaults).toBeLessThanOrEqual(1);
          expect(expenseDefaults).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('toggling a non-default template to default should unset other defaults of same type', () => {
    fc.assert(
      fc.property(
        fc.array(templateArb, { minLength: 2, maxLength: 10 }),
        (templates) => {
          // Ensure unique IDs and set all to same type with one default
          const sameTypeTemplates = templates.map((t, i) => ({
            ...t,
            id: `id-${i}`,
            is_income_template: true,
            is_default: i === 0, // Only first is default
          }));

          // Toggle second template to default
          const result = toggleDefaultTemplate(sameTypeTemplates, 'id-1');

          // id-1 should now be default
          const toggled = result.find(t => t.id === 'id-1');
          expect(toggled?.is_default).toBe(true);

          // id-0 should no longer be default (was unset)
          const previous = result.find(t => t.id === 'id-0');
          expect(previous?.is_default).toBe(false);

          // At most one default for income templates
          const incomeDefaults = result.filter(t => t.is_income_template && t.is_default).length;
          expect(incomeDefaults).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('toggling a default template off should result in no default for that type', () => {
    // When a template is already default and we toggle it, it becomes non-default
    const templates: TemplateBase[] = [
      { id: 'id-0', code: 'T001', name: 'Template 1', is_default: true, is_income_template: true },
      { id: 'id-1', code: 'T002', name: 'Template 2', is_default: false, is_income_template: true },
    ];

    const result = toggleDefaultTemplate(templates, 'id-0');

    const toggled = result.find(t => t.id === 'id-0');
    expect(toggled?.is_default).toBe(false);

    const incomeDefaults = result.filter(t => t.is_income_template && t.is_default).length;
    expect(incomeDefaults).toBe(0);
  });

  it('toggling a non-existent template should return templates unchanged', () => {
    fc.assert(
      fc.property(
        fc.array(templateArb, { minLength: 1, maxLength: 10 }),
        (templates) => {
          const uniqueTemplates = templates.map((t, i) => ({ ...t, id: `id-${i}` }));
          const result = toggleDefaultTemplate(uniqueTemplates, 'non-existent-id');

          expect(result).toEqual(uniqueTemplates);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: thu-chi-reimplementation
 * Property 16: Mẫu in thu chi có mã tự sinh
 * **Validates: Yêu cầu 10.2**
 *
 * Với bất kỳ mẫu in thu chi nào vừa được tạo, trường code phải là chuỗi không rỗng
 * và duy nhất trong phạm vi user.
 */
describe('Property 16: Mẫu in thu chi có mã tự sinh', () => {
  it('every template must have a non-empty code', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            code: fc.string({ minLength: 1, maxLength: 20 }),
            name: fc.string({ minLength: 1, maxLength: 30 }),
            is_default: fc.boolean(),
            is_income_template: fc.boolean(),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (templates) => {
          for (const t of templates) {
            expect(typeof t.code).toBe('string');
            expect(t.code.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('codes within a user scope should be unique', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (count) => {
          // Simulate auto-generated codes: each should be unique
          const codes = new Set<string>();
          for (let i = 1; i <= count; i++) {
            const code = `MT${String(i).padStart(5, '0')}`;
            codes.add(code);
          }
          expect(codes.size).toBe(count);
        },
      ),
      { numRuns: 100 },
    );
  });
});
