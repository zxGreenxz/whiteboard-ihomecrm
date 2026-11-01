import { describe, expect, it } from 'vitest';
import {
  landlordOperatedBuildingIds,
  lockPrecheckSignature,
  resolveLockPrecheck,
} from '@/lib/profitLockPrecheck';
import {
  FIXED_FEE_KINDS,
  computeProfitReportChecks,
  type ProfitCheckBuilding,
  type ProfitCheckRow,
} from '@/lib/profitReportChecks';

// Số liệu giả, tròn — không phải dữ liệu thật.
const ALL_KEYS = FIXED_FEE_KINDS.map((k) => k.key);
const building = (id: string, keep: string[]): ProfitCheckBuilding => ({
  id,
  name: `Toà ${id}`,
  is_virtual: false,
  has_elevator: false,
  hidden_fixed_expenses: ALL_KEYS.filter((k) => !keep.includes(k)),
  status: 'ACTIVE',
});
const rent = (buildingId: string, expense: number, voucherId: string): ProfitCheckRow => ({
  voucherId,
  voucherName: 'Tiền nhà',
  buildingId,
  buildingName: null,
  voucherDate: '2026-09-05',
  typeId: 't-rent',
  typeName: 'Tiền nhà',
  category: 'Tiền nhà',
  income: 0,
  expense,
  countsInBusinessResult: true,
  approvalStatus: 'APPROVED',
});
const TYPES = [{ id: 't-rent', fee_category: 'tien_nha' }];
const RATES = [
  { buildingId: 'b-a', feeCategory: 'tien_nha', defaultAmount: 10_000_000 },
  { buildingId: 'b-b', feeCategory: 'tien_nha', defaultAmount: 10_000_000 },
];
const checksFor = (scope: string[], rows: ProfitCheckRow[], skipRent: string[] = []) =>
  computeProfitReportChecks({
    rows,
    buildings: [building('b-a', ['tien_nha']), building('b-b', ['tien_nha'])],
    feeRates: RATES,
    expenseTypes: TYPES,
    scopeBuildingIds: scope,
    skipRentBuildingIds: skipRent,
    today: '2026-10-22',
  });

describe('resolveLockPrecheck — lưới mềm trước khi chốt', () => {
  it('không có nhà sắp chốt ⇒ idle, không chặn', () => {
    expect(resolveLockPrecheck({ hasTargets: false, isLoading: true, isError: true, checks: null })).toEqual({
      status: 'idle',
      needsAck: false,
      blocksConfirm: false,
      issueCount: 0,
    });
  });

  it('đang dò ⇒ chờ (chặn nút), không đoán là đủ', () => {
    const p = resolveLockPrecheck({ hasTargets: true, isLoading: true, isError: false, checks: null });
    expect(p).toMatchObject({ status: 'loading', blocksConfirm: true, needsAck: false });
    // chưa có kết quả mà cũng không đang tải ⇒ vẫn là chờ
    expect(resolveLockPrecheck({ hasTargets: true, isLoading: false, isError: false, checks: null }).status).toBe('loading');
  });

  it('lỗi dò ⇒ không chặn cứng nhưng phải tick xác nhận', () => {
    expect(resolveLockPrecheck({ hasTargets: true, isLoading: false, isError: true, checks: null })).toMatchObject({
      status: 'error',
      needsAck: true,
      blocksConfirm: false,
    });
  });

  it('nhà sắp chốt thiếu tiền nhà ⇒ issues, phải tick; đủ ⇒ clean', () => {
    const missing = checksFor(['b-a'], []);
    const p = resolveLockPrecheck({ hasTargets: true, isLoading: false, isError: false, checks: missing });
    expect(p).toMatchObject({ status: 'issues', needsAck: true, blocksConfirm: false, issueCount: 1 });

    const ok = checksFor(['b-a'], [rent('b-a', 10_000_000, 'v1')]);
    expect(resolveLockPrecheck({ hasTargets: true, isLoading: false, isError: false, checks: ok })).toMatchObject({
      status: 'clean',
      needsAck: false,
    });
  });

  it('chỉ dò đúng nhà sắp chốt: nhà khác thiếu không làm phiền', () => {
    const c = checksFor(['b-a'], [rent('b-a', 10_000_000, 'v1')]);
    expect(c.fixedFees.checkedBuildingCount).toBe(1);
    expect(c.fixedFees.issues).toHaveLength(0);
  });

  it('có thể trùng (vượt 130% mức) cũng phải tick', () => {
    const dup = checksFor(['b-b'], [rent('b-b', 10_000_000, 'v1'), rent('b-b', 10_000_000, 'v2')]);
    const p = resolveLockPrecheck({ hasTargets: true, isLoading: false, isError: false, checks: dup });
    expect(p.status).toBe('issues');
    expect(dup.fixedFees.duplicateCount).toBe(1);
  });

  it('toà vận hành cho chủ nhà không bị đòi Tiền nhà', () => {
    const c = checksFor(['b-a'], [], ['b-a']);
    expect(c.fixedFees.issues).toHaveLength(0);
  });
});

describe('lockPrecheckSignature — đổi tập cảnh báo thì phải tick lại', () => {
  it('đổi nhà chọn hoặc đổi số ⇒ khác chữ ký; thứ tự chọn không quan trọng', () => {
    const a = checksFor(['b-a', 'b-b'], []);
    const s1 = lockPrecheckSignature(['b-a', 'b-b'], a, 'issues');
    expect(lockPrecheckSignature(['b-b', 'b-a'], a, 'issues')).toBe(s1);
    expect(lockPrecheckSignature(['b-a'], a, 'issues')).not.toBe(s1);
    const b = checksFor(['b-a', 'b-b'], [rent('b-a', 1_000_000, 'v9')]);
    expect(lockPrecheckSignature(['b-a', 'b-b'], b, 'issues')).not.toBe(s1);
    expect(lockPrecheckSignature(['b-a', 'b-b'], null, 'error')).not.toBe(s1);
  });
});

describe('landlordOperatedBuildingIds (F07 nhãn)', () => {
  const ops = [
    { building_id: 'b-a', organization_id: 'org-1', effective_from: '2026-08-01', is_active: true },
    { building_id: 'b-b', organization_id: 'org-1', effective_from: '2026-10-01', is_active: true },
    { building_id: 'b-c', organization_id: 'org-1', effective_from: '2026-01-01', is_active: false },
    { building_id: 'b-d', organization_id: 'org-2', effective_from: '2026-01-01', is_active: true },
  ];
  it('đang bật và bắt đầu từ kỳ đó trở về trước, đúng công ty', () => {
    expect([...landlordOperatedBuildingIds(ops, '2026-09-01', 'org-1')]).toEqual(['b-a']);
    expect([...landlordOperatedBuildingIds(ops, '2026-10-01', 'org-1')].sort()).toEqual(['b-a', 'b-b']);
    expect([...landlordOperatedBuildingIds(ops, '2026-10-01', null)].sort()).toEqual(['b-a', 'b-b', 'b-d']);
  });
  it('không có dữ liệu / kỳ sai dạng ⇒ rỗng (im lặng)', () => {
    expect(landlordOperatedBuildingIds(undefined, '2026-10-01').size).toBe(0);
    expect(landlordOperatedBuildingIds(ops, 'bad').size).toBe(0);
  });
});
