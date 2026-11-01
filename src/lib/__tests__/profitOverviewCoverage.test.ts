import { describe, expect, it } from 'vitest';
import {
  COVERAGE_TOLERANCE,
  DELETED_BUILDING_NAME,
  buildProfitCoverage,
  coverageCellKey,
  coverageCellTitle,
  coverageMonths,
  coverageSummaryLines,
  lockedSplitTitle,
  retainedKpiSub,
  retiredManagerBalances,
  signedAmount,
  splitLockedProfit,
  splitOpenNetByMonthEnd,
  yearMonthOf,
  type CoverageAccrualRow,
  type CoverageSnapshotRow,
  type LockedSplitRow,
} from '@/lib/profitOverviewCoverage';

// Số liệu giả, tròn — không phải dữ liệu thật.
const B = [
  { id: 'b-a', name: 'Toà A' },
  { id: 'b-b', name: 'Toà B' },
  { id: 'b-c', name: 'Toà C' },
];
const acc = (month: number, building_id: string, net: number, extra: Partial<CoverageAccrualRow> = {}): CoverageAccrualRow => ({
  month: `2026-${String(month).padStart(2, '0')}-01`,
  building_id,
  building_name: B.find((b) => b.id === building_id)?.name ?? 'Toà lạ',
  is_virtual: false,
  revenue: net > 0 ? net : 0,
  expense: net < 0 ? -net : 0,
  net,
  ...extra,
});
const snap = (month: number, building_id: string, computed: number, extra: Partial<CoverageSnapshotRow> = {}): CoverageSnapshotRow => ({
  building_id,
  period_month: `2026-${String(month).padStart(2, '0')}-01`,
  status: 'LOCKED',
  computed_profit: computed,
  adjusted_profit: computed,
  ...extra,
});
const fmt = (n: number) => `${n}`;

describe('coverageMonths', () => {
  const today = { year: 2026, month: 10 };
  it('năm hiện tại chỉ tới tháng hiện tại; năm trước đủ 12; năm sau rỗng', () => {
    expect(coverageMonths(2026, null, today)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(coverageMonths(2025, null, today)).toHaveLength(12);
    expect(coverageMonths(2027, null, today)).toEqual([]);
  });
  it('lọc một tháng: trong khoảng thì giữ, tháng tương lai thì rỗng', () => {
    expect(coverageMonths(2026, 7, today)).toEqual([7]);
    expect(coverageMonths(2026, 11, today)).toEqual([]);
    expect(coverageMonths(2025, 12, today)).toEqual([12]);
  });
  it('yearMonthOf đọc YYYY-MM, sai dạng ⇒ null', () => {
    expect(yearMonthOf('2026-07-01')).toEqual({ year: 2026, month: 7 });
    expect(yearMonthOf('2026-13-01')).toBeNull();
    expect(yearMonthOf('x')).toBeNull();
  });
});

describe('buildProfitCoverage — trạng thái ô', () => {
  const base = {
    year: 2026,
    months: [7, 8],
    buildings: B,
  };

  it('đã chốt khớp nguồn / chốt nhưng nguồn đổi / chưa chốt / không phát sinh', () => {
    const c = buildProfitCoverage({
      ...base,
      snapshots: [snap(7, 'b-a', 1_000_000), snap(7, 'b-b', 2_000_000)],
      accrual: [acc(7, 'b-a', 1_000_000), acc(7, 'b-b', 2_500_000), acc(7, 'b-c', 300_000), acc(8, 'b-a', 400_000)],
    });
    expect(c.cells[coverageCellKey(7, 'b-a')]?.status).toBe('LOCKED');
    const changed = c.cells[coverageCellKey(7, 'b-b')];
    expect(changed?.status).toBe('LOCKED_CHANGED');
    expect(changed?.delta).toBe(500_000);
    expect(c.cells[coverageCellKey(7, 'b-c')]?.status).toBe('OPEN');
    expect(c.cells[coverageCellKey(8, 'b-a')]?.status).toBe('OPEN');
    expect(c.cells[coverageCellKey(8, 'b-b')]?.status).toBe('EMPTY');

    expect(c.lockedCount).toBe(2);
    expect(c.changedCount).toBe(1);
    expect(c.openCount).toBe(2);
    expect(c.lockedBuildingCount).toBe(2);
    expect(c.lockedSource).toBe(3_000_000);
    expect(c.lockedCurrent).toBe(3_500_000);
    expect(c.lockedDelta).toBe(500_000);
    expect(c.openNet).toBe(700_000);
    const t7 = c.byMonth.find((m) => m.month === 7);
    expect(t7).toMatchObject({ locked: 2, changed: 1, open: 1, empty: 0, openNet: 300_000 });
  });

  it('chênh dưới 1 đồng vẫn là khớp; đúng 1 đồng là đổi nguồn (ngưỡng nghiêm ngặt)', () => {
    const c = buildProfitCoverage({
      ...base,
      months: [7],
      snapshots: [snap(7, 'b-a', 1_000_000), snap(7, 'b-b', 1_000_000)],
      accrual: [acc(7, 'b-a', 1_000_000.4), acc(7, 'b-b', 1_000_000 + COVERAGE_TOLERANCE)],
    });
    expect(c.cells[coverageCellKey(7, 'b-a')]?.status).toBe('LOCKED');
    expect(c.cells[coverageCellKey(7, 'b-b')]?.status).toBe('LOCKED_CHANGED');
  });

  it('đã chốt mà tháng đó toà không còn phát sinh ⇒ LN hiện tại 0, là nguồn đổi', () => {
    const c = buildProfitCoverage({ ...base, months: [7], snapshots: [snap(7, 'b-a', 800_000)], accrual: [] });
    const cell = c.cells[coverageCellKey(7, 'b-a')];
    expect(cell).toMatchObject({ status: 'LOCKED_CHANGED', currentNet: 0, delta: -800_000 });
  });

  it('cột is_stale bật ⇒ nguồn đổi dù số khớp', () => {
    const c = buildProfitCoverage({
      ...base,
      months: [7],
      snapshots: [snap(7, 'b-a', 500_000, { is_stale: true })],
      accrual: [acc(7, 'b-a', 500_000)],
    });
    expect(c.cells[coverageCellKey(7, 'b-a')]).toMatchObject({ status: 'LOCKED_CHANGED', staleFlag: true, delta: 0 });
  });

  it('dòng DRAFT (đã mở khoá) là chưa chốt, kể cả không còn phát sinh', () => {
    const c = buildProfitCoverage({
      ...base,
      months: [7],
      snapshots: [snap(7, 'b-a', 900_000, { status: 'DRAFT' })],
      accrual: [],
    });
    expect(c.cells[coverageCellKey(7, 'b-a')]?.status).toBe('OPEN');
    expect(c.lockedCount).toBe(0);
  });

  it('LN chốt so bằng computed_profit; điều chỉnh tay báo riêng, không vào lệch', () => {
    const c = buildProfitCoverage({
      ...base,
      months: [7],
      snapshots: [snap(7, 'b-a', 1_000_000, { adjusted_profit: 900_000 })],
      accrual: [acc(7, 'b-a', 1_000_000)],
    });
    expect(c.lockedDelta).toBe(0);
    expect(c.lockedAdjusted).toBe(900_000);
    expect(c.adjustmentTotal).toBe(-100_000);
    expect(c.cells[coverageCellKey(7, 'b-a')]?.status).toBe('LOCKED');
  });

  it('toà ảo không vào ô nào, chỉ vào chi phí chung', () => {
    const c = buildProfitCoverage({
      ...base,
      months: [7],
      snapshots: [],
      accrual: [acc(7, 'b-a', 100_000), acc(7, 'v-kho', -60_000, { is_virtual: true, building_name: 'Kho' })],
    });
    expect(c.buildings.map((b) => b.id)).not.toContain('v-kho');
    expect(c.virtualNet).toBe(-60_000);
    expect(c.hasVirtual).toBe(true);
    expect(c.openNet).toBe(100_000);
  });

  it('bỏ dòng ngoài năm / ngoài tháng đang xét', () => {
    const c = buildProfitCoverage({
      ...base,
      months: [7],
      snapshots: [snap(8, 'b-a', 1), { ...snap(7, 'b-a', 5), period_month: '2025-07-01' }],
      accrual: [acc(8, 'b-a', 999), { ...acc(7, 'b-a', 999), month: '2025-07-01' }],
    });
    expect(c.lockedCount).toBe(0);
    expect(c.openCount).toBe(0);
    expect(c.byMonth).toHaveLength(1);
  });

  it('dòng chốt của toà không còn trong danh sách ⇒ thêm cột "Toà đã xoá"', () => {
    const c = buildProfitCoverage({ ...base, months: [7], snapshots: [snap(7, 'b-gone', 10)], accrual: [] });
    expect(c.buildings.find((b) => b.id === 'b-gone')?.name).toBe(DELETED_BUILDING_NAME);
    expect(c.lockedCount).toBe(1);
  });

  it('trùng dòng cùng toà × kỳ thì ưu tiên LOCKED', () => {
    const c = buildProfitCoverage({
      ...base,
      months: [7],
      snapshots: [snap(7, 'b-a', 10, { status: 'DRAFT' }), snap(7, 'b-a', 10)],
      accrual: [acc(7, 'b-a', 10)],
    });
    expect(c.cells[coverageCellKey(7, 'b-a')]?.status).toBe('LOCKED');
  });
});

describe('LN chưa chốt: tháng đã hết vs tháng đang chạy', () => {
  it('tháng hiện tại tách riêng, không cộng vào tiêu đề', () => {
    const c = buildProfitCoverage({
      year: 2026,
      months: [9, 10],
      buildings: B,
      snapshots: [],
      accrual: [acc(9, 'b-a', 600_000), acc(10, 'b-a', 200_000)],
    });
    expect(splitOpenNetByMonthEnd(c, 2026, { year: 2026, month: 10 })).toEqual({
      ended: 600_000,
      endedOpen: 1,
      running: 200_000,
      runningMonth: 10,
    });
    // năm cũ: không có tháng đang chạy
    expect(splitOpenNetByMonthEnd(c, 2025, { year: 2026, month: 10 }).runningMonth).toBeNull();
  });
});

describe('chữ hiển thị', () => {
  const c = buildProfitCoverage({
    year: 2026,
    months: [7],
    buildings: B,
    snapshots: [snap(7, 'b-a', 100, { adjusted_profit: 90 })],
    accrual: [acc(7, 'b-a', 150), acc(7, 'b-b', 40), acc(7, 'v', -5, { is_virtual: true })],
  });

  it('băng đối chiếu ghi rõ LN chốt · hiện tại · lệch và các phần phụ', () => {
    const lines = coverageSummaryLines(c, { year: 2026, today: { year: 2026, month: 10 }, singleMonth: true }, fmt);
    expect(lines.reconcile).toBe('Đã chốt 1/3 toà: LN chốt 100 · LN hiện tại 150 · lệch +50');
    expect(lines.reconcileSub).toContain('chưa gồm điều chỉnh tay');
    expect(lines.reconcileSub).toContain('điều chỉnh tay khi chốt −10');
    expect(lines.reconcileSub).toContain('1 toà·tháng nguồn đã đổi');
    expect(lines.open).toBe('LN chưa chốt (ước tính, trước chia): 40 · 1 toà·tháng');
    expect(lines.virtual).toContain('Chi phí chung ở toà ảo — không vào chia LN: −5');
  });

  it('cả năm ghi toà·tháng; chưa chốt gì thì nói rõ', () => {
    const lines = coverageSummaryLines(c, { year: 2026, today: { year: 2026, month: 10 }, singleMonth: false }, fmt);
    expect(lines.reconcile.startsWith('Đã chốt 1 toà·tháng (1 toà)')).toBe(true);
    const none = buildProfitCoverage({ year: 2026, months: [7], buildings: B, snapshots: [], accrual: [] });
    expect(coverageSummaryLines(none, { year: 2026, today: { year: 2026, month: 10 }, singleMonth: false }, fmt).reconcile).toBe(
      'Chưa có toà nào đã chốt trong phạm vi đang xem.',
    );
  });

  it('tooltip ô theo trạng thái', () => {
    const cell = c.cells[coverageCellKey(7, 'b-a')];
    expect(cell && coverageCellTitle(cell, 'Toà A', fmt)).toBe(
      'Toà A · T7: đã chốt nhưng nguồn đã đổi · LN chốt 100 → hiện tại 150 (lệch +50)',
    );
    const open = c.cells[coverageCellKey(7, 'b-b')];
    expect(open && coverageCellTitle(open, 'Toà B', fmt)).toBe('Toà B · T7: chưa chốt · LN hiện tại ≈ 40');
    expect(signedAmount(0, fmt)).toBe('0');
  });
});

describe('splitLockedProfit (F21)', () => {
  const rows: LockedSplitRow[] = [
    { status: 'LOCKED', adjusted_profit: 1000, management_salary: 100, shareholder_allocated_amount: 500, unallocated_profit: 400, unallocated_disposition: 'RETAINED_EARNINGS' },
    { status: 'LOCKED', adjusted_profit: 300, management_salary: 0, shareholder_allocated_amount: 100, unallocated_profit: 200, unallocated_disposition: 'LEGACY_RETAINED_UNALLOCATED' },
    { status: 'LOCKED', adjusted_profit: 50, management_salary: 0, shareholder_allocated_amount: 0, unallocated_profit: 50, unallocated_disposition: 'CARRY_FORWARD' },
    { status: 'LOCKED', adjusted_profit: 20, management_salary: 0, shareholder_allocated_amount: 0, unallocated_profit: 20, unallocated_disposition: null },
    { status: 'DRAFT', adjusted_profit: 9999, management_salary: 9, shareholder_allocated_amount: 9, unallocated_profit: 9, unallocated_disposition: 'RETAINED_EARNINGS' },
  ];

  it('tách theo disposition, bỏ DRAFT, phần dư giải thích = 0', () => {
    const s = splitLockedProfit(rows);
    expect(s).toMatchObject({
      lockedCount: 4,
      adjusted: 1370,
      managementSalary: 100,
      shareholderAllocated: 600,
      retained: 400,
      legacyRetained: 200,
      carryForward: 50,
      undecided: 20,
      unexplained: 0,
    });
    expect(retainedKpiSub(s, fmt)).toBe('gồm 200 chốt kiểu cũ · chuyển kỳ sau 50 · chưa chọn 20');
    expect(lockedSplitTitle(s, fmt)).toBe(
      'LN đã chốt 1370 = lương điều hành 100 + phần cổ đông lúc chốt 600 + giữ lại công ty 600 + chuyển kỳ sau 50 + chưa chọn cách xử lý 20',
    );
  });

  it('snapshot không cộng đủ thì tooltip nói còn lệch', () => {
    const s = splitLockedProfit([{ status: 'LOCKED', adjusted_profit: 100, management_salary: 10, shareholder_allocated_amount: 50 }]);
    expect(s.unexplained).toBe(40);
    expect(lockedSplitTitle(s, fmt)).toContain('còn lệch +40 chưa giải thích');
    expect(retainedKpiSub(s, fmt)).toBe('phần LN đã chốt không chia cổ đông');
  });
});

describe('retiredManagerBalances (F21)', () => {
  it('chỉ quản lý KHÔNG còn hoạt động, gộp phân bổ và phiếu chi, bỏ người số 0', () => {
    const out = retiredManagerBalances(
      new Set(['m-active']),
      [
        { manager_id: 'm-active', amount: 999 },
        { manager_id: 'm-gone', amount: 300 },
        { manager_id: 'm-gone', amount: 200 },
        { manager_id: 'm-zero', amount: 0 },
      ],
      [
        { manager_id: 'm-gone', total_amount: 100 },
        { manager_id: 'm-active', total_amount: 5 },
        { manager_id: 'm-paid-only', total_amount: 50 },
      ],
    );
    expect(out).toEqual([
      { managerId: 'm-gone', accrued: 500, paid: 100, remaining: 400 },
      { managerId: 'm-paid-only', accrued: 0, paid: 50, remaining: -50 },
    ]);
  });
});
