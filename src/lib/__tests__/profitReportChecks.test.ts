import { describe, expect, it } from 'vitest';
import {
  FIXED_FEE_KINDS,
  activeRoomNoteText,
  buildFeeKeyContext,
  endedUnsettledNoteText,
  fixedFeePrefillAmount,
  classifyFixedFee,
  computeFixedFeeChecks,
  computeProfitReportChecks,
  daysBetween,
  findStalePendingVouchers,
  resolveFixedFeeKey,
  summarizeRoomNotes,
  type ProfitCheckBuilding,
  type ProfitCheckRow,
} from '@/lib/profitReportChecks';
import { FIXED_EXPENSE_CATEGORIES } from '@/lib/fixedExpenseCategories';
import { GRID_SERVER_KEYS } from '@/lib/feeCategories';
import type { VacantRoomNote } from '@/hooks/reports/types';

// Số liệu giả, tròn — không phải dữ liệu thật.
const ALL_KEYS = FIXED_FEE_KINDS.map((k) => k.key);
/** Toà chỉ bật đúng các khoản `keep` (còn lại "không áp dụng") để mỗi ca tập trung. */
const building = (id: string, keep: string[], extra: Partial<ProfitCheckBuilding> = {}): ProfitCheckBuilding => ({
  id,
  name: `Toà ${id}`,
  is_virtual: false,
  has_elevator: false,
  hidden_fixed_expenses: ALL_KEYS.filter((k) => !keep.includes(k)),
  status: 'ACTIVE',
  ...extra,
});

let seq = 0;
const row = (p: Partial<ProfitCheckRow> & { buildingId: string | null }): ProfitCheckRow => ({
  voucherId: p.voucherId ?? `v${++seq}`,
  voucherName: p.voucherName ?? 'Phiếu chi',
  buildingName: p.buildingName ?? null,
  voucherDate: p.voucherDate ?? '2026-10-05',
  typeId: p.typeId ?? null,
  typeName: p.typeName ?? 'Không có hạng mục',
  category: p.category ?? null,
  income: p.income ?? 0,
  expense: p.expense ?? 0,
  countsInBusinessResult: p.countsInBusinessResult ?? true,
  approvalStatus: p.approvalStatus ?? 'APPROVED',
  ...p,
});

const TYPES = [
  { id: 't-rent', fee_category: 'tien_nha' },
  { id: 't-elec', fee_category: 'dien' },
  { id: 't-rac', fee_category: null },
  { id: 't-fridge', fee_category: null },
];
const rent = (buildingId: string, expense: number, extra: Partial<ProfitCheckRow> = {}) =>
  row({ buildingId, expense, typeId: 't-rent', typeName: 'Tiền nhà', category: 'Tiền nhà', ...extra });

describe('khoá khoản chi cố định', () => {
  it('cùng khoá và thứ tự với FIXED_EXPENSE_CATEGORIES và GRID_SERVER_KEYS', () => {
    expect(ALL_KEYS).toEqual(FIXED_EXPENSE_CATEGORIES.map((c) => c.key));
    expect(ALL_KEYS).toEqual(GRID_SERVER_KEYS);
  });
});

describe('resolveFixedFeeKey — mirror SQL fee_type_matches + fee_category', () => {
  const ctx = buildFeeKeyContext(TYPES);
  it('hạng mục đã gắn khoá là nguồn đúng, kể cả khi tên nói khác', () => {
    expect(resolveFixedFeeKey({ typeId: 't-rent', typeName: 'Chi khác', category: null, voucherName: '' }, ctx)).toBe('tien_nha');
  });
  it('hạng mục CHƯA gắn khoá không được khớp theo tên cho khoản công ty đã gắn khoá', () => {
    expect(resolveFixedFeeKey({ typeId: 't-fridge', typeName: 'Mua tủ lạnh', category: 'Điện', voucherName: '' }, ctx)).toBeNull();
    expect(resolveFixedFeeKey({ typeId: 't-rac', typeName: 'Tiền nhà cũ', category: 'Tiền nhà', voucherName: '' }, ctx)).toBeNull();
  });
  it('khoản công ty chưa gắn khoá thì khớp theo tên', () => {
    expect(resolveFixedFeeKey({ typeId: 't-rac', typeName: 'Tiền rác', category: 'Rác', voucherName: '' }, ctx)).toBe('rac');
    const noMap = buildFeeKeyContext([]);
    expect(resolveFixedFeeKey({ typeId: 'x', typeName: 'Mua tủ lạnh', category: 'Điện', voucherName: '' }, noMap)).toBe('dien');
  });
  it('phiếu không có hạng mục dò theo tên phiếu (chỉ khoản chưa gắn khoá)', () => {
    const r = { typeId: null, typeName: 'Không có hạng mục', category: null, voucherName: 'Tiền rác (tự động lập)' };
    expect(resolveFixedFeeKey(r, ctx)).toBe('rac');
    expect(resolveFixedFeeKey({ ...r, voucherName: 'Tiền nhà (tự động lập)' }, ctx)).toBeNull();
  });
  it('hạng mục có tên chứa lương không vào Quản lý; hạng mục không liên quan trả null', () => {
    const noMap = buildFeeKeyContext([]);
    expect(resolveFixedFeeKey({ typeId: 'a', typeName: 'Lương quản lý', category: null, voucherName: '' }, noMap)).toBeNull();
    expect(resolveFixedFeeKey({ typeId: 'b', typeName: 'Hoa hồng', category: 'Hoa Hồng', voucherName: '' }, noMap)).toBeNull();
  });
});

describe('classifyFixedFee — ngưỡng 70% / 130%', () => {
  const v = (voucherId: string, amount: number) => ({ voucherId, amount });
  it('thiếu hẳn', () => {
    expect(classifyFixedFee(0, 1_000_000, [])).toEqual({ status: 'MISSING', gap: 1_000_000 });
    expect(classifyFixedFee(0, null, [])).toEqual({ status: 'MISSING', gap: 0 });
  });
  it('thiếu số dưới 70%; đúng 70% là đủ', () => {
    expect(classifyFixedFee(690_000, 1_000_000, [v('a', 690_000)])).toEqual({ status: 'SHORT', gap: 310_000 });
    expect(classifyFixedFee(700_000, 1_000_000, [v('a', 700_000)]).status).toBe('OK');
  });
  it('trên 130% là có thể trùng; đúng 130% là đủ', () => {
    expect(classifyFixedFee(1_310_000, 1_000_000, [v('a', 1_310_000)])).toEqual({
      status: 'POSSIBLE_DUPLICATE',
      gap: 310_000,
      duplicateReason: 'OVER_RATE',
    });
    expect(classifyFixedFee(1_300_000, 1_000_000, [v('a', 1_300_000)]).status).toBe('OK');
  });
  it('chưa khai mức: hai phiếu khác nhau cùng số tiền là nghi trùng, một phiếu là đủ', () => {
    expect(classifyFixedFee(600_000, null, [v('a', 300_000), v('b', 300_000)])).toEqual({
      status: 'POSSIBLE_DUPLICATE',
      gap: 0,
      duplicateReason: 'SAME_AMOUNT',
    });
    expect(classifyFixedFee(600_000, null, [v('a', 200_000), v('b', 400_000)]).status).toBe('OK');
    expect(classifyFixedFee(0.5, null, [v('a', 0.5)]).status).toBe('OK');
  });
  it('ngưỡng truyền vào được tôn trọng', () => {
    expect(classifyFixedFee(800_000, 1_000_000, [], { shortRatio: 0.9 }).status).toBe('SHORT');
    expect(classifyFixedFee(1_100_000, 1_000_000, [], { overRatio: 1.05 }).status).toBe('POSSIBLE_DUPLICATE');
  });
});

describe('computeFixedFeeChecks — quét MỌI toà', () => {
  const rates = [
    { buildingId: 'A', feeCategory: 'tien_nha', defaultAmount: 30_000_000 },
    { buildingId: 'B', feeCategory: 'tien_nha', defaultAmount: 20_000_000 },
    { buildingId: 'C', feeCategory: 'tien_nha', defaultAmount: 10_000_000 },
    { buildingId: 'D', feeCategory: 'tien_nha', defaultAmount: 15_000_000 },
    { buildingId: 'A', feeCategory: 'dien', defaultAmount: null },
  ];
  const buildings = [
    building('A', ['tien_nha', 'dien']),
    building('B', ['tien_nha']),
    building('C', ['tien_nha']),
    building('D', ['tien_nha']),
    building('V', ['tien_nha'], { is_virtual: true }),
    building('I', ['tien_nha'], { status: 'INACTIVE' }),
  ];
  const rows: ProfitCheckRow[] = [
    rent('A', 30_000_000, { buildingName: 'Toà A' }),
    rent('B', 20_000_000, { voucherId: 'auto', voucherName: 'Tiền nhà (tự động lập)', approvalStatus: 'UNAPPROVED' }),
    rent('B', 20_000_000, { voucherId: 'tay', voucherName: 'Tiền nhà tháng 10' }),
    rent('C', 5_000_000),
    // Không được tính: dòng thu, dòng ngoài KQKD, dòng không có toà.
    rent('C', 9_000_000, { countsInBusinessResult: false }),
    row({ buildingId: 'C', income: 9_000_000, typeId: 't-rent', typeName: 'Tiền nhà' }),
    rent(null as unknown as string, 9_000_000, { buildingId: null }),
  ];
  const run = (over: Partial<Parameters<typeof computeFixedFeeChecks>[0]> = {}) =>
    computeFixedFeeChecks({ rows, buildings, feeRates: rates, expenseTypes: TYPES, ...over });
  const status = (res: ReturnType<typeof run>, b: string, k: string) =>
    res.cells.find((c) => c.buildingId === b && c.key === k)?.status;

  it('đủ / thiếu hẳn / thiếu số / có thể trùng', () => {
    const res = run();
    expect(status(res, 'A', 'tien_nha')).toBe('OK');
    expect(status(res, 'A', 'dien')).toBe('MISSING');
    expect(status(res, 'B', 'tien_nha')).toBe('POSSIBLE_DUPLICATE');
    expect(status(res, 'C', 'tien_nha')).toBe('SHORT');
    expect(status(res, 'D', 'tien_nha')).toBe('MISSING');
    const b = res.cells.find((c) => c.buildingId === 'B')!;
    expect(b).toMatchObject({ actual: 40_000_000, pendingAmount: 20_000_000, gap: 20_000_000, ratio: 2 });
    expect(b.vouchers.map((v) => [v.voucherId, v.pending])).toEqual([['auto', true], ['tay', false]]);
    const c = res.cells.find((x) => x.buildingId === 'C')!;
    expect(c).toMatchObject({ actual: 5_000_000, gap: 5_000_000 });
    // Dòng thu / dòng ngoài KQKD không lọt vào danh sách phiếu của khoản chi.
    expect(c.vouchers.map((v) => v.amount)).toEqual([5_000_000]);
  });

  it('tổng hợp: số toà, số khoản, số tiền thiếu/vượt', () => {
    const res = run();
    expect(res).toMatchObject({
      checkedBuildingCount: 4,
      missingBuildingCount: 3, // A (điện), C (thiếu số), D
      duplicateBuildingCount: 1,
      missingCount: 2,
      shortCount: 1,
      duplicateCount: 1,
      unpricedMissingCount: 1, // điện A chưa khai mức
      missingAmount: 5_000_000 + 15_000_000,
      excessAmount: 20_000_000,
    });
    expect(res.issues.every((c) => c.status !== 'OK')).toBe(true);
    expect(res.issues.map((c) => `${c.buildingId}:${c.key}`)).toEqual(['A:dien', 'B:tien_nha', 'C:tien_nha', 'D:tien_nha']);
  });

  it('bỏ qua toà ảo và toà ngừng hoạt động', () => {
    const res = run();
    expect(res.cells.some((c) => c.buildingId === 'V' || c.buildingId === 'I')).toBe(false);
  });

  it('khoản "không áp dụng" (hidden_fixed_expenses hoặc notApplicable) không bị đòi', () => {
    const res = run();
    expect(res.cells.some((c) => c.buildingId === 'B' && c.key === 'dien')).toBe(false);
    const na = run({ feeRates: [...rates, { buildingId: 'D', feeCategory: 'tien_nha', defaultAmount: 1, notApplicable: true }] });
    expect(na.cells.some((c) => c.buildingId === 'D' && c.key === 'tien_nha')).toBe(false);
  });

  it('toà vận hành cho chủ nhà (skipRentBuildingIds) không bị báo thiếu tiền nhà', () => {
    const res = run({ skipRentBuildingIds: ['D'] });
    expect(res.cells.some((c) => c.buildingId === 'D')).toBe(false);
    expect(res.missingBuildingCount).toBe(2);
    // Khoản khác của toà đó vẫn bị kiểm.
    const other = run({ skipRentBuildingIds: new Set(['A']) });
    expect(status(other, 'A', 'tien_nha')).toBeUndefined();
    expect(status(other, 'A', 'dien')).toBe('MISSING');
  });

  it('thang máy chỉ đòi khi toà bật has_elevator', () => {
    const off = computeFixedFeeChecks({ rows: [], buildings: [building('E', ['thang_may'])] });
    expect(off.cells).toEqual([]);
    const on = computeFixedFeeChecks({ rows: [], buildings: [building('E', ['thang_may'], { has_elevator: true })] });
    expect(on.cells.map((c) => [c.key, c.status])).toEqual([['thang_may', 'MISSING']]);
  });

  it('phạm vi toà đang lọc', () => {
    const res = run({ scopeBuildingIds: ['C'] });
    expect(res.checkedBuildingCount).toBe(1);
    expect(res.cells.map((c) => c.buildingId)).toEqual(['C']);
    expect(run({ scopeBuildingIds: [] }).checkedBuildingCount).toBe(4);
  });

  it('toà không có cấu hình phí: chỉ kiểm có/không, tên toà lấy từ dòng phiếu', () => {
    const res = computeFixedFeeChecks({
      rows: [rent('Z', 1_000, { buildingName: 'Toà từ phiếu' })],
      buildings: [{ id: 'Z', hidden_fixed_expenses: ALL_KEYS.filter((k) => k !== 'tien_nha') }],
      expenseTypes: TYPES,
    });
    expect(res.cells).toEqual([expect.objectContaining({ buildingName: 'Toà từ phiếu', status: 'OK', expected: null, ratio: null })]);
  });
});

describe('findStalePendingVouchers — phiếu chờ duyệt quá 30 ngày', () => {
  const today = '2026-10-22';
  it('daysBetween theo lịch, sai dạng trả null', () => {
    expect(daysBetween('2026-09-22', today)).toBe(30);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysBetween('', today)).toBeNull();
    expect(daysBetween('2026-09-22', null)).toBeNull();
  });
  it('chỉ phiếu CHỜ DUYỆT có ngày phiếu cũ hơn 30 ngày; gộp theo phiếu; cũ nhất trước', () => {
    const rows = [
      row({ buildingId: 'A', voucherId: 'p1', voucherDate: '2026-09-21', expense: 1_000_000, approvalStatus: 'UNAPPROVED' }),
      row({ buildingId: 'A', voucherId: 'p1', voucherDate: '2026-09-21', expense: 500_000, approvalStatus: 'UNAPPROVED' }),
      row({ buildingId: 'B', voucherId: 'p0', voucherDate: '2026-08-01', income: 2_000_000, approvalStatus: 'UNAPPROVED' }),
      row({ buildingId: 'A', voucherId: 'p2', voucherDate: '2026-09-22', expense: 9_000_000, approvalStatus: 'UNAPPROVED' }),
      row({ buildingId: 'A', voucherId: 'ok', voucherDate: '2026-07-01', expense: 9_000_000, approvalStatus: 'APPROVED' }),
      row({ buildingId: 'A', voucherId: 'nodate', voucherDate: null, expense: 9_000_000, approvalStatus: 'UNAPPROVED' }),
    ];
    const res = findStalePendingVouchers(rows, today);
    expect(res.vouchers.map((v) => [v.voucherId, v.ageDays])).toEqual([['p0', 82], ['p1', 31]]);
    expect(res).toMatchObject({ thresholdDays: 30, count: 2, income: 2_000_000, expense: 1_500_000 });
    expect(findStalePendingVouchers(rows, today, 90).count).toBe(0);
  });
});

describe('computeProfitReportChecks', () => {
  it('hasWarnings chỉ false khi không còn cảnh báo nào', () => {
    const clean = computeProfitReportChecks({
      rows: [rent('A', 30_000_000)],
      buildings: [building('A', ['tien_nha'])],
      feeRates: [{ buildingId: 'A', feeCategory: 'tien_nha', defaultAmount: 30_000_000 }],
      expenseTypes: TYPES,
      today: '2026-10-22',
    });
    expect(clean.hasWarnings).toBe(false);
    const stale = computeProfitReportChecks({
      rows: [rent('A', 30_000_000, { approvalStatus: 'UNAPPROVED', voucherDate: '2026-08-01' })],
      buildings: [building('A', ['tien_nha'])],
      feeRates: [{ buildingId: 'A', feeCategory: 'tien_nha', defaultAmount: 30_000_000 }],
      expenseTypes: TYPES,
      today: '2026-10-22',
    });
    expect(stale.fixedFees.issues).toEqual([]);
    expect(stale.stalePending.count).toBe(1);
    expect(stale.hasWarnings).toBe(true);
  });
});

describe('summarizeRoomNotes', () => {
  it('đếm phòng trống theo ghi chú vacant và tách chưa có / chưa thu hoá đơn', () => {
    const base = { roomName: 'P', buildingId: 'A', buildingName: 'Toà A' };
    const notes = new Map<string, VacantRoomNote>([
      ['r1', { ...base, roomId: 'r1', kind: 'vacant', reason: 'Thanh lý HĐ' }],
      ['r2', { ...base, roomId: 'r2', kind: 'vacant' }],
      ['r3', { ...base, roomId: 'r3', kind: 'active', invoiceState: 'none' }],
      ['r4', { ...base, roomId: 'r4', kind: 'active', invoiceState: 'unpaid', invoiceRemaining: 3_000_000, invoiceOverdue: true }],
      ['r5', { ...base, roomId: 'r5', kind: 'active', invoiceState: 'unpaid', invoiceRemaining: 2_000_000 }],
      ['r6', { ...base, roomId: 'r6', kind: 'active', invoiceState: 'paid' }],
      ['ended:c1', { ...base, roomId: 'r6', kind: 'ended_unsettled', finalInvoiceRemaining: 1_000_000 }],
    ]);
    expect(summarizeRoomNotes(notes)).toEqual({
      vacantRooms: 2,
      missingInvoiceRooms: 1,
      unpaidInvoiceRooms: 2,
      unpaidInvoiceAmount: 5_000_000,
      overdueInvoiceRooms: 1,
      endedUnsettled: 1,
      endedUnsettledRemaining: 1_000_000,
    });
    expect(summarizeRoomNotes(undefined).vacantRooms).toBe(0);
  });
});

describe('số điền sẵn khi "Lập phiếu" từ ô chi cố định', () => {
  it('thiếu hẳn ⇒ nguyên mức; thiếu số ⇒ phần còn thiếu (không cộng trùng phần đã có); chưa khai mức ⇒ 0', () => {
    expect(fixedFeePrefillAmount({ status: 'MISSING', expected: 5_000_000, gap: 5_000_000 })).toBe(5_000_000);
    expect(fixedFeePrefillAmount({ status: 'SHORT', expected: 132_000_000, gap: 62_000_000 })).toBe(62_000_000);
    expect(fixedFeePrefillAmount({ status: 'MISSING', expected: null, gap: 0 })).toBe(0);
  });
});

describe('chữ ghi chú phòng (desktop + mobile dùng chung)', () => {
  const base = { roomName: 'P', buildingId: 'A', buildingName: 'Toà A', roomId: 'r1' } as const;
  it('còn HĐ: chưa có hoá đơn / có hoá đơn chưa thu (kèm quá hạn)', () => {
    expect(activeRoomNoteText({ ...base, kind: 'active', invoiceState: 'none' } as VacantRoomNote)).toBe('Chưa có hoá đơn tháng này');
    const t = activeRoomNoteText({ ...base, kind: 'active', invoiceState: 'unpaid', invoiceRemaining: 3_000_000, invoiceOverdue: true } as VacantRoomNote);
    expect(t).toMatch(/^Có hoá đơn, chưa thu 3[.,]000[.,]000 đ — quá hạn$/);
    expect(activeRoomNoteText({ ...base, kind: 'active', invoiceState: 'unpaid', invoiceTotal: 500_000 } as VacantRoomNote)).not.toMatch(/quá hạn/);
  });
  it('HĐ kết thúc chưa thanh lý: ngày kết thúc, lý do, số còn phải thu', () => {
    expect(endedUnsettledNoteText({ ...base, kind: 'ended_unsettled', contractNumber: 'HD01', endedOn: '2026-10-15', missingTermination: true } as VacantRoomNote))
      .toBe('HĐ HD01 kết thúc 15/10 — chưa thanh lý');
    expect(endedUnsettledNoteText({ ...base, kind: 'ended_unsettled', endedOn: '2026-10-20', missingTermination: false, finalInvoiceRemaining: 1_000_000 } as VacantRoomNote))
      .toMatch(/^HĐ kết thúc 20\/10 — thanh lý chưa xong, chưa có hoá đơn cuối · còn phải thu 1[.,]000[.,]000 đ$/);
  });
});
