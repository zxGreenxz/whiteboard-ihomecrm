import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  createVoucherPayload,
  canEditVoucher,
  canDeleteVoucher,
  applyApproval,
  applyUnapproval,
  filterNonDeleted,
  applyVoucherUpdate,
  generateVoucherCode,
  isValidVoucherCode,
  type VoucherBase,
} from '../useIncomeExpensesHelpers';

/**
 * Feature: thu-chi-reimplementation
 * Property 1: Phiếu mới luôn có trạng thái UNAPPROVED và mã phiếu hợp lệ
 * **Validates: Yêu cầu 1.6, 2.2**
 *
 * Với bất kỳ phiếu thu/chi nào vừa được tạo, trường approval_status phải là 'UNAPPROVED',
 * và trường code phải khớp với regex ^PT\d{7}$ (cho INCOME) hoặc ^PC\d{7}$ (cho EXPENSE).
 */
describe('Property 1: Phiếu mới luôn có trạng thái UNAPPROVED và mã phiếu hợp lệ', () => {
  it('should always create a payload with approval_status UNAPPROVED', () => {
    fc.assert(
      fc.property(
        fc.record({
          userId: fc.uuid(),
          type: fc.constantFrom('INCOME' as const, 'EXPENSE' as const),
          name: fc.string({ minLength: 1, maxLength: 50 }),
          buildingId: fc.uuid(),
          roomId: fc.option(fc.uuid(), { nil: undefined }),
          bedId: fc.option(fc.uuid(), { nil: undefined }),
          tenantId: fc.option(fc.uuid(), { nil: undefined }),
          voucherDate: fc.integer({ min: 2020, max: 2030 }).chain(y =>
            fc.integer({ min: 1, max: 12 }).chain(m =>
              fc.integer({ min: 1, max: 28 }).map(
                d => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
              ),
            ),
          ),
          notes: fc.option(fc.string({ minLength: 0, maxLength: 200 }), { nil: undefined }),
        }),
        (input) => {
          const payload = createVoucherPayload(input);

          expect(payload.approval_status).toBe('UNAPPROVED');
          expect(payload.user_id).toBe(input.userId);
          expect(payload.type).toBe(input.type);
          expect(payload.name).toBe(input.name);
          expect(payload.building_id).toBe(input.buildingId);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('generateVoucherCode always produces codes matching the expected format', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('INCOME' as const, 'EXPENSE' as const),
        fc.integer({ min: 2020, max: 2030 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 999 }),
        (type, year, month, sequence) => {
          const yearMonth = `${year}-${String(month).padStart(2, '0')}`;
          const code = generateVoucherCode(type, yearMonth, sequence);

          expect(isValidVoucherCode(code)).toBe(true);

          if (type === 'INCOME') {
            expect(code).toMatch(/^PT\d{7}$/);
          } else {
            expect(code).toMatch(/^PC\d{7}$/);
          }

          // Total length: prefix (2) + YYMM (4) + seq (3) = 9
          expect(code.length).toBe(9);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('YYMM portion matches the input year and month', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('INCOME' as const, 'EXPENSE' as const),
        fc.integer({ min: 2020, max: 2030 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 999 }),
        (type, year, month, sequence) => {
          const yearMonth = `${year}-${String(month).padStart(2, '0')}`;
          const code = generateVoucherCode(type, yearMonth, sequence);

          const yymm = code.slice(2, 6);
          const expectedYY = String(year).slice(2);
          const expectedMM = String(month).padStart(2, '0');

          expect(yymm).toBe(`${expectedYY}${expectedMM}`);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: thu-chi-reimplementation
 * Property 5: Soft-delete ẩn khỏi danh sách
 * **Validates: Yêu cầu 3.4, 6.4**
 *
 * Với bất kỳ phiếu thu/chi nào đã bị soft-delete (deleted_at != null),
 * phiếu đó không được xuất hiện trong kết quả query danh sách.
 */
describe('Property 5: Soft-delete ẩn khỏi danh sách', () => {
  const voucherWithDeletedArb = fc.record({
    id: fc.uuid(),
    deleted_at: fc.option(fc.date().map(d => d.toISOString()), { nil: null }),
  });

  it('filterNonDeleted should exclude all items with non-null deleted_at', () => {
    fc.assert(
      fc.property(
        fc.array(voucherWithDeletedArb, { minLength: 0, maxLength: 50 }),
        (vouchers) => {
          const result = filterNonDeleted(vouchers);

          // All results must have deleted_at === null
          for (const v of result) {
            expect(v.deleted_at).toBeNull();
          }

          // Count must match
          const expectedCount = vouchers.filter(v => v.deleted_at === null).length;
          expect(result.length).toBe(expectedCount);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('all non-deleted items should be preserved', () => {
    fc.assert(
      fc.property(
        fc.array(voucherWithDeletedArb, { minLength: 0, maxLength: 50 }),
        (vouchers) => {
          const result = filterNonDeleted(vouchers);
          const nonDeletedIds = new Set(vouchers.filter(v => v.deleted_at === null).map(v => v.id));
          const resultIds = new Set(result.map(v => v.id));

          expect(resultIds).toEqual(nonDeletedIds);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: thu-chi-reimplementation
 * Property 6: Cập nhật phiếu round-trip
 * **Validates: Yêu cầu 3.6, 11.6**
 *
 * Với bất kỳ phiếu thu/chi UNAPPROVED nào và bất kỳ bộ giá trị cập nhật hợp lệ nào,
 * sau khi cập nhật và đọc lại, các trường đã cập nhật phải phản ánh giá trị mới,
 * và updated_at phải mới hơn trước khi cập nhật.
 */
describe('Property 6: Cập nhật phiếu round-trip', () => {
  const voucherArb: fc.Arbitrary<VoucherBase> = fc.record({
    id: fc.uuid(),
    type: fc.constantFrom('INCOME' as const, 'EXPENSE' as const),
    name: fc.string({ minLength: 1, maxLength: 50 }),
    building_id: fc.uuid(),
    room_id: fc.option(fc.uuid(), { nil: null }),
    bed_id: fc.option(fc.uuid(), { nil: null }),
    tenant_id: fc.option(fc.uuid(), { nil: null }),
    voucher_date: fc.constant('2025-01-15'),
    notes: fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: null }),
    approval_status: fc.constant('UNAPPROVED' as const),
    updated_at: fc.constant('2025-01-01T00:00:00Z'),
  });

  const updatesArb = fc.record({
    name: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
    building_id: fc.option(fc.uuid(), { nil: undefined }),
    voucher_date: fc.option(fc.constant('2025-06-15'), { nil: undefined }),
    notes: fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: undefined }),
  });

  it('updated fields should reflect new values and updated_at should change', () => {
    fc.assert(
      fc.property(voucherArb, updatesArb, (voucher, updates) => {
        const newUpdatedAt = '2025-07-01T12:00:00Z';
        const result = applyVoucherUpdate(voucher, updates, newUpdatedAt);

        // updated_at must be the new timestamp
        expect(result.updated_at).toBe(newUpdatedAt);

        // Each defined update must be reflected
        if (updates.name !== undefined) expect(result.name).toBe(updates.name);
        if (updates.building_id !== undefined) expect(result.building_id).toBe(updates.building_id);
        if (updates.voucher_date !== undefined) expect(result.voucher_date).toBe(updates.voucher_date);
        if (updates.notes !== undefined) expect(result.notes).toBe(updates.notes);

        // Unchanged fields must remain the same
        expect(result.id).toBe(voucher.id);
        expect(result.type).toBe(voucher.type);
        expect(result.approval_status).toBe(voucher.approval_status);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: thu-chi-reimplementation
 * Property 7: Duyệt rồi bỏ duyệt là round-trip
 * **Validates: Yêu cầu 4.2, 4.3**
 *
 * Với bất kỳ phiếu thu/chi UNAPPROVED nào, sau khi duyệt (approve) thì approval_status
 * phải là 'APPROVED' và approved_by, approved_at phải được ghi nhận. Sau khi bỏ duyệt
 * (unapprove), trạng thái phải trở về 'UNAPPROVED' và approved_by, approved_at phải là null.
 */
describe('Property 7: Duyệt rồi bỏ duyệt là round-trip', () => {
  it('approve then unapprove should return to original UNAPPROVED state', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.integer({ min: 2020, max: 2030 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        (approverId, year, month, day, hour, minute) => {
          const approvedAt = new Date(year, month - 1, day, hour, minute).toISOString();
          const original = {
            status: 'UNAPPROVED' as const,
            approved_by: null as string | null,
            approved_at: null as string | null,
          };

          // Step 1: Approve
          const approved = applyApproval(original, approverId, approvedAt);
          expect(approved.status).toBe('APPROVED');
          expect(approved.approved_by).toBe(approverId);
          expect(approved.approved_at).toBe(approvedAt);

          // Step 2: Unapprove
          const unapproved = applyUnapproval(approved);
          expect(unapproved.status).toBe('UNAPPROVED');
          expect(unapproved.approved_by).toBeNull();
          expect(unapproved.approved_at).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('canEditVoucher and canDeleteVoucher should agree for any status', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('UNAPPROVED' as const, 'APPROVED' as const),
        (status) => {
          const canEdit = canEditVoucher(status);
          const canDelete = canDeleteVoucher(status);

          expect(canEdit).toBe(canDelete);
          expect(canEdit).toBe(status === 'UNAPPROVED');
        },
      ),
      { numRuns: 100 },
    );
  });
});

import {
  validateImportRows,
} from '../useIncomeExpensesHelpers';

/**
 * Feature: thu-chi-reimplementation
 * Property 8: Import Excel - số bản ghi tạo + số lỗi = tổng dòng
 * **Validates: Yêu cầu 5.4, 5.6**
 *
 * Với bất kỳ file import nào, tổng (success_count + failed_count) phải bằng tổng số dòng
 * dữ liệu trong file, và mỗi dòng lỗi phải có thông báo lỗi chi tiết.
 */
describe('Property 8: Import Excel - số bản ghi tạo + số lỗi = tổng dòng', () => {
  const validRowArb = fc.record({
    type: fc.constantFrom('INCOME' as const, 'EXPENSE' as const),
    building_name: fc.string({ minLength: 1, maxLength: 20 }),
    room_name: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
    name: fc.string({ minLength: 1, maxLength: 50 }),
    voucher_date: fc.integer({ min: 2020, max: 2030 }).chain(y =>
      fc.integer({ min: 1, max: 12 }).chain(m =>
        fc.integer({ min: 1, max: 28 }).map(
          d => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        ),
      ),
    ),
    item_name: fc.string({ minLength: 1, maxLength: 30 }),
    amount: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
  });

  const invalidRowArb = fc.oneof(
    // Missing building_name
    fc.record({
      type: fc.constantFrom('INCOME' as const, 'EXPENSE' as const),
      building_name: fc.constant(''),
      name: fc.string({ minLength: 1, maxLength: 20 }),
      voucher_date: fc.constant('2025-01-01'),
      item_name: fc.string({ minLength: 1, maxLength: 20 }),
      amount: fc.double({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
    }),
    // Missing name
    fc.record({
      type: fc.constantFrom('INCOME' as const, 'EXPENSE' as const),
      building_name: fc.string({ minLength: 1, maxLength: 20 }),
      name: fc.constant(''),
      voucher_date: fc.constant('2025-01-01'),
      item_name: fc.string({ minLength: 1, maxLength: 20 }),
      amount: fc.double({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }),
    }),
    // Negative amount
    fc.record({
      type: fc.constantFrom('INCOME' as const, 'EXPENSE' as const),
      building_name: fc.string({ minLength: 1, maxLength: 20 }),
      name: fc.string({ minLength: 1, maxLength: 20 }),
      voucher_date: fc.constant('2025-01-01'),
      item_name: fc.string({ minLength: 1, maxLength: 20 }),
      amount: fc.double({ min: -1_000_000, max: -0.01, noNaN: true, noDefaultInfinity: true }),
    }),
    // Completely empty object
    fc.constant({}),
    // null
    fc.constant(null),
  );

  const mixedRowsArb = fc.array(
    fc.oneof(
      validRowArb.map(r => r as unknown),
      invalidRowArb.map(r => r as unknown),
    ),
    { minLength: 0, maxLength: 50 },
  );

  it('validRows.length + errors.length must equal total input rows', () => {
    fc.assert(
      fc.property(mixedRowsArb, (rows) => {
        const { validRows, errors } = validateImportRows(rows);
        expect(validRows.length + errors.length).toBe(rows.length);
      }),
      { numRuns: 100 },
    );
  });

  it('every error must have a rowIndex and a non-empty message', () => {
    fc.assert(
      fc.property(mixedRowsArb, (rows) => {
        const { errors } = validateImportRows(rows);
        for (const err of errors) {
          expect(typeof err.rowIndex).toBe('number');
          expect(err.rowIndex).toBeGreaterThanOrEqual(0);
          expect(err.rowIndex).toBeLessThan(rows.length);
          expect(typeof err.message).toBe('string');
          expect(err.message.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('all-valid input should produce zero errors', () => {
    fc.assert(
      fc.property(
        fc.array(validRowArb, { minLength: 1, maxLength: 30 }),
        (rows) => {
          const { validRows, errors } = validateImportRows(rows);
          expect(errors.length).toBe(0);
          expect(validRows.length).toBe(rows.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('all-invalid input should produce zero valid rows', () => {
    fc.assert(
      fc.property(
        fc.array(invalidRowArb, { minLength: 1, maxLength: 30 }),
        (rows) => {
          const { validRows, errors } = validateImportRows(rows);
          expect(validRows.length).toBe(0);
          expect(errors.length).toBe(rows.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

import {
  applyVoucherFilters,
  paginateList,
  type VoucherFilterParams,
  type VoucherFilterable,
} from '../useIncomeExpensesHelpers';

// --- Shared types for Property 9/10/11 ---

const TYPES = ['INCOME', 'EXPENSE'] as const;
const STATUSES = ['UNAPPROVED', 'APPROVED'] as const;

interface TestVoucher extends VoucherFilterable {
  id: string;
  total_amount: number;
  deleted_at: string | null;
}

const testVoucherArb: fc.Arbitrary<TestVoucher> = fc.record({
  id: fc.uuid(),
  building_id: fc.uuid(),
  room_id: fc.option(fc.uuid(), { nil: null }),
  type: fc.constantFrom(...TYPES),
  voucher_date: fc.integer({ min: 2020, max: 2030 }).chain(y =>
    fc.integer({ min: 1, max: 12 }).chain(m =>
      fc.integer({ min: 1, max: 28 }).map(
        d => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      ),
    ),
  ),
  approval_status: fc.constantFrom(...STATUSES),
  name: fc.string({ minLength: 1, maxLength: 30 }),
  code: fc.string({ minLength: 5, maxLength: 15 }),
  tenant_name: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: null }),
  total_amount: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
  deleted_at: fc.constant(null as string | null),
});

/**
 * Feature: thu-chi-reimplementation
 * Property 9: Bộ lọc và tìm kiếm chỉ trả về kết quả phù hợp
 * **Validates: Yêu cầu 7.2, 7.3**
 *
 * Với bất kỳ danh sách phiếu thu/chi và bất kỳ tổ hợp bộ lọc nào,
 * tất cả phiếu trong kết quả phải thỏa mãn mọi điều kiện lọc đã chọn.
 */
describe('Property 9: Bộ lọc và tìm kiếm chỉ trả về kết quả phù hợp', () => {
  const filtersFromVouchers = (vouchers: TestVoucher[]) => {
    const roomIds = vouchers.filter(v => v.room_id !== null).map(v => v.room_id!);
    return fc.record({
      building_id: vouchers.length > 0
        ? fc.option(fc.constantFrom(...vouchers.map(v => v.building_id)), { nil: undefined })
        : fc.constant(undefined),
      room_id: roomIds.length > 0
        ? fc.option(fc.constantFrom(...roomIds), { nil: undefined })
        : fc.constant(undefined),
      type: fc.option(fc.constantFrom(...TYPES), { nil: undefined }),
      approval_status: fc.option(fc.constantFrom(...STATUSES), { nil: undefined }),
    }) as fc.Arbitrary<VoucherFilterParams>;
  };

  it('all vouchers in filtered results must satisfy every applied filter condition', () => {
    fc.assert(
      fc.property(
        fc.array(testVoucherArb, { minLength: 0, maxLength: 30 }).chain(vouchers =>
          filtersFromVouchers(vouchers).map(filters => ({ vouchers, filters })),
        ),
        ({ vouchers, filters }) => {
          const result = applyVoucherFilters(vouchers, filters);

          for (const v of result) {
            if (filters.building_id) expect(v.building_id).toBe(filters.building_id);
            if (filters.room_id) expect(v.room_id).toBe(filters.room_id);
            if (filters.type) expect(v.type).toBe(filters.type);
            if (filters.approval_status) expect(v.approval_status).toBe(filters.approval_status);
          }

          expect(result.length).toBeLessThanOrEqual(vouchers.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('no matching voucher should be excluded from results', () => {
    fc.assert(
      fc.property(
        fc.array(testVoucherArb, { minLength: 0, maxLength: 30 }),
        fc.record({
          type: fc.option(fc.constantFrom(...TYPES), { nil: undefined }),
          approval_status: fc.option(fc.constantFrom(...STATUSES), { nil: undefined }),
        }),
        (vouchers, filters) => {
          const result = applyVoucherFilters(vouchers, filters as VoucherFilterParams);

          const expectedCount = vouchers.filter(v => {
            if (filters.type && v.type !== filters.type) return false;
            if (filters.approval_status && v.approval_status !== filters.approval_status) return false;
            return true;
          }).length;

          expect(result.length).toBe(expectedCount);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: thu-chi-reimplementation
 * Property 10: Phân trang đúng
 * **Validates: Yêu cầu 6.2**
 *
 * Với bất kỳ danh sách phiếu thu/chi và kích thước trang (pageSize) nào,
 * mỗi trang phải chứa tối đa pageSize bản ghi, và tổng số bản ghi qua tất cả
 * các trang phải bằng tổng số bản ghi gốc.
 */
describe('Property 10: Phân trang đúng', () => {
  it('each page has at most pageSize items and total across all pages equals original count', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uuid(), { minLength: 0, maxLength: 50 }),
        fc.integer({ min: 1, max: 25 }),
        (items, pageSize) => {
          const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
          let totalCollected = 0;

          for (let page = 1; page <= totalPages; page++) {
            const { data, totalCount } = paginateList(items, page, pageSize);

            expect(data.length).toBeLessThanOrEqual(pageSize);
            expect(totalCount).toBe(items.length);

            totalCollected += data.length;
          }

          expect(totalCollected).toBe(items.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('pages beyond the last page should return empty data', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uuid(), { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 1, max: 20 }),
        (items, pageSize) => {
          const totalPages = Math.ceil(items.length / pageSize);
          const beyondPage = totalPages + 1;

          const { data, totalCount } = paginateList(items, beyondPage, pageSize);

          expect(data.length).toBe(0);
          expect(totalCount).toBe(items.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

import { computeIncomeExpenseStats, type VoucherForStats } from '../useIncomeExpensesHelpers';

/**
 * Feature: thu-chi-reimplementation
 * Property 11: Thống kê đúng
 * **Validates: Yêu cầu 8.1, 8.2**
 *
 * Với bất kỳ tập hợp phiếu thu/chi nào, totalIncome phải bằng tổng total_amount
 * của tất cả phiếu INCOME, totalExpense phải bằng tổng total_amount của tất cả
 * phiếu EXPENSE, difference phải bằng totalIncome - totalExpense,
 * và totalTransactions phải bằng tổng số phiếu.
 */
describe('Property 11: Thống kê đúng', () => {
  const voucherForStatsArb: fc.Arbitrary<VoucherForStats> = fc.record({
    type: fc.constantFrom(...TYPES),
    total_amount: fc.double({ min: 0, max: 10_000, noNaN: true, noDefaultInfinity: true }),
  });

  it('totalIncome must equal sum of total_amount for INCOME vouchers', () => {
    fc.assert(
      fc.property(
        fc.array(voucherForStatsArb, { minLength: 0, maxLength: 50 }),
        (vouchers) => {
          const stats = computeIncomeExpenseStats(vouchers);

          const expectedIncome = vouchers
            .filter(v => v.type === 'INCOME')
            .reduce((sum, v) => sum + v.total_amount, 0);

          expect(stats.totalIncome).toBeCloseTo(expectedIncome, 5);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('totalExpense must equal sum of total_amount for EXPENSE vouchers', () => {
    fc.assert(
      fc.property(
        fc.array(voucherForStatsArb, { minLength: 0, maxLength: 50 }),
        (vouchers) => {
          const stats = computeIncomeExpenseStats(vouchers);

          const expectedExpense = vouchers
            .filter(v => v.type === 'EXPENSE')
            .reduce((sum, v) => sum + v.total_amount, 0);

          expect(stats.totalExpense).toBeCloseTo(expectedExpense, 5);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('difference must equal totalIncome - totalExpense', () => {
    fc.assert(
      fc.property(
        fc.array(voucherForStatsArb, { minLength: 0, maxLength: 50 }),
        (vouchers) => {
          const stats = computeIncomeExpenseStats(vouchers);
          expect(stats.difference).toBeCloseTo(stats.totalIncome - stats.totalExpense, 5);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('totalTransactions must equal total number of vouchers', () => {
    fc.assert(
      fc.property(
        fc.array(voucherForStatsArb, { minLength: 0, maxLength: 50 }),
        (vouchers) => {
          const stats = computeIncomeExpenseStats(vouchers);
          expect(stats.totalTransactions).toBe(vouchers.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

import {
  filterRoomsByBuilding,
  filterBedsByRoom,
  filterTenantsByRoomOrBed,
} from '../useIncomeExpensesHelpers';

/**
 * Feature: thu-chi-reimplementation
 * Property 12: Cascade dropdown Building → Room → Bed đúng
 * **Validates: Yêu cầu 13.1, 13.2**
 *
 * Với bất kỳ building_id nào được chọn, tất cả rooms trong dropdown phải có building_id khớp.
 * Tương tự, với bất kỳ room_id nào được chọn, tất cả beds trong dropdown phải có room_id khớp.
 */
describe('Property 12: Cascade dropdown Building → Room → Bed đúng', () => {
  const buildingIdPool = ['bld-A', 'bld-B', 'bld-C'] as const;
  const roomIdPool = ['room-1', 'room-2', 'room-3', 'room-4'] as const;

  const roomArb = fc.record({
    id: fc.constantFrom(...roomIdPool),
    building_id: fc.constantFrom(...buildingIdPool),
  });

  const bedArb = fc.record({
    id: fc.uuid(),
    room_id: fc.constantFrom(...roomIdPool),
  });

  it('all rooms returned by filterRoomsByBuilding must have matching building_id', () => {
    fc.assert(
      fc.property(
        fc.array(roomArb, { minLength: 0, maxLength: 20 }),
        fc.constantFrom(...buildingIdPool),
        (rooms, buildingId) => {
          const result = filterRoomsByBuilding(rooms, buildingId);

          for (const room of result) {
            expect(room.building_id).toBe(buildingId);
          }

          const expectedCount = rooms.filter(r => r.building_id === buildingId).length;
          expect(result.length).toBe(expectedCount);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('all beds returned by filterBedsByRoom must have matching room_id', () => {
    fc.assert(
      fc.property(
        fc.array(bedArb, { minLength: 0, maxLength: 20 }),
        fc.constantFrom(...roomIdPool),
        (beds, roomId) => {
          const result = filterBedsByRoom(beds, roomId);

          for (const bed of result) {
            expect(bed.room_id).toBe(roomId);
          }

          const expectedCount = beds.filter(b => b.room_id === roomId).length;
          expect(result.length).toBe(expectedCount);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: thu-chi-reimplementation
 * Property 13: Gợi ý khách hàng theo phòng/giường đúng
 * **Validates: Yêu cầu 13.3**
 *
 * Với bất kỳ room_id hoặc bed_id nào được chọn, danh sách khách hàng gợi ý phải chỉ
 * bao gồm những khách hàng có liên kết tại phòng/giường đó.
 */
describe('Property 13: Gợi ý khách hàng theo phòng/giường đúng', () => {
  const roomIdPool = ['room-1', 'room-2', 'room-3'] as const;
  const bedIdPool = ['bed-A', 'bed-B', 'bed-C'] as const;

  const tenantArb = fc.record({
    id: fc.uuid(),
    room_id: fc.option(fc.constantFrom(...roomIdPool), { nil: null }),
    bed_id: fc.option(fc.constantFrom(...bedIdPool), { nil: null }),
  });

  it('tenants filtered by roomId must all have matching room_id', () => {
    fc.assert(
      fc.property(
        fc.array(tenantArb, { minLength: 0, maxLength: 20 }),
        fc.constantFrom(...roomIdPool),
        (tenants, roomId) => {
          const result = filterTenantsByRoomOrBed(tenants, roomId, undefined);

          for (const t of result) {
            expect(t.room_id).toBe(roomId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('tenants filtered by bedId must all have matching bed_id', () => {
    fc.assert(
      fc.property(
        fc.array(tenantArb, { minLength: 0, maxLength: 20 }),
        fc.constantFrom(...bedIdPool),
        (tenants, bedId) => {
          const result = filterTenantsByRoomOrBed(tenants, undefined, bedId);

          for (const t of result) {
            expect(t.bed_id).toBe(bedId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('tenants filtered by both roomId and bedId should match bed_id first', () => {
    fc.assert(
      fc.property(
        fc.array(tenantArb, { minLength: 0, maxLength: 20 }),
        fc.constantFrom(...roomIdPool),
        fc.constantFrom(...bedIdPool),
        (tenants, roomId, bedId) => {
          const result = filterTenantsByRoomOrBed(tenants, roomId, bedId);

          for (const t of result) {
            // Must match either bed_id or room_id
            const matchesBed = t.bed_id === bedId;
            const matchesRoom = t.room_id === roomId;
            expect(matchesBed || matchesRoom).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

import {
  calculateTotalFromItems,
  countItemsForVoucher,
} from '../useIncomeExpensesHelpers';

/**
 * Feature: thu-chi-reimplementation
 * Property 17: Phiếu thu/chi nhiều hạng mục
 * **Validates: Yêu cầu 2.3**
 *
 * Với bất kỳ phiếu thu/chi nào có N hạng mục (N >= 1), khi query phiếu kèm items,
 * số lượng items trả về phải bằng N, và mỗi item phải có income_expense_id khớp với phiếu.
 */
describe('Property 17: Phiếu thu/chi nhiều hạng mục', () => {
  it('calculateTotalFromItems should equal sum of quantity * unit_price', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            income_expense_type_id: fc.uuid(),
            quantity: fc.integer({ min: 1, max: 100 }),
            unit_price: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (items) => {
          const total = calculateTotalFromItems(items);
          const expected = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
          expect(total).toBeCloseTo(expected, 5);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('countItemsForVoucher should return exact count of items matching voucherId', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.array(
          fc.record({
            income_expense_id: fc.oneof(fc.uuid(), fc.constant('target-voucher-id')),
          }),
          { minLength: 0, maxLength: 30 },
        ),
        (_, items) => {
          const voucherId = 'target-voucher-id';
          const count = countItemsForVoucher(items, voucherId);
          const expected = items.filter(i => i.income_expense_id === voucherId).length;
          expect(count).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('total should be 0 for empty items array', () => {
    expect(calculateTotalFromItems([])).toBe(0);
  });

  it('total should be non-negative when all unit_prices are non-negative', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            income_expense_type_id: fc.uuid(),
            quantity: fc.integer({ min: 1, max: 100 }),
            unit_price: fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
          }),
          { minLength: 0, maxLength: 20 },
        ),
        (items) => {
          const total = calculateTotalFromItems(items);
          expect(total).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
