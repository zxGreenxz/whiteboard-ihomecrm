// Số liệu màn cổ đông tự xem theo sổ tổng (E3): thuần, chỉ tiền của chính mình.
import { describe, expect, it } from 'vitest';
import type { MyProfitLedger } from '../ledgerReaders';
import {
  amountsByBuilding, buildingColumns, buildingMatrix, ledgerYears, monthlyAmounts, monthsInScope, ownerSelfAdvanceSubject,
  payoutStatusLabel, salaryNet, selfAdvanceBlockedNote, shareholderOrganizationId,
} from '../selfView';

const ledger = (over: Partial<MyProfitLedger> = {}): MyProfitLedger => ({
  organization_id: 'org-a', route: 'CANONICAL', ready: true, shareholder: { id: 'sh-1', name: 'Cổ đông 1' },
  balance: 86.5, status: 'OWED', allocated: 154.5, paid: 30, paid_pending: 30, paid_via_salary: 12, advance_recovered: 4,
  marker: null,
  months: [
    { period_month: '2026-07-01', amount: 100, excluded_by_marker: false, buildings: [{ building_id: 'b1', building_name: 'Toà Một', amount: 100 }] },
    { period_month: '2026-08-01', amount: 24.5, excluded_by_marker: false, buildings: [
      { building_id: 'b2', building_name: 'Toà Hai', amount: -15.5 }, { building_id: 'b1', building_name: 'Toà Một', amount: 40 },
    ] },
    { period_month: '2025-12-01', amount: 30, excluded_by_marker: true, buildings: [{ building_id: null, building_name: 'Toà cũ', amount: 30 }] },
  ],
  payouts: [],
  salary: [{ period_month: '2026-08-01', investment: 12, advance_offset: 4, excluded_by_marker: false }],
  ...over,
});

describe('selfView — phần lợi nhuận trả qua lương', () => {
  it('qua lương = Y − D (cùng dấu công thức số dư); không có dòng lương ⇒ null (không hiện 0)', () => {
    const l = ledger();
    expect(salaryNet(l)).toBe(8);
    expect(l.allocated - l.paid - l.paid_pending - (salaryNet(l) ?? 0)).toBeCloseTo(l.balance);
    expect(salaryNet(ledger({ salary: [], paid_via_salary: 0, advance_recovered: 0 }))).toBeNull();
  });
});

describe('selfView — tháng / toà', () => {
  it('năm có số liệu + năm hiện tại, mới trước', () => {
    expect(ledgerYears(ledger(), 2027)).toEqual([2027, 2026, 2025]);
  });
  it('12 tháng của năm: tháng chưa chốt là null, không phải 0', () => {
    const v = monthlyAmounts(ledger().months, 2026);
    expect(v).toHaveLength(12);
    expect(v[6]).toBe(100);
    expect(v[7]).toBe(24.5);
    expect(v[0]).toBeNull();
  });
  it('ma trận Nhà × Tháng: cột theo tên, ô trống null, tổng = số tháng của máy chủ; toà thiếu id khoá theo tên', () => {
    const months = monthsInScope(ledger().months, 2026, null);
    const cols = buildingColumns(months);
    expect(cols.map((c) => c.name)).toEqual(['Toà Hai', 'Toà Một']);
    const rows = buildingMatrix(months, cols);
    expect(rows.map((r) => [r.month, r.cells, r.total])).toEqual([[7, [null, 100], 100], [8, [-15.5, 40], 24.5]]);
    const old = buildingMatrix(monthsInScope(ledger().months, 2025, null), buildingColumns(monthsInScope(ledger().months, 2025, null)));
    expect(old[0]).toMatchObject({ excluded: true, cells: [30] });
  });
  it('theo nhà: cộng theo toà, bỏ toà bằng 0, lớn trước; lọc tháng', () => {
    expect(amountsByBuilding(monthsInScope(ledger().months, 2026, null)).map((x) => [x.name, x.value])).toEqual([['Toà Một', 140], ['Toà Hai', -15.5]]);
    expect(amountsByBuilding(monthsInScope(ledger().months, 2026, 7)).map((x) => x.name)).toEqual(['Toà Một']);
  });
});

describe('selfView — phiếu, nút tạm ứng, công ty', () => {
  it('trạng thái phiếu không lộ mã kỹ thuật', () => {
    expect(payoutStatusLabel({ status: 'UNAPPROVED', posting_status: 'UNPOSTED' })).toBe('Chờ duyệt');
    expect(payoutStatusLabel({ status: 'APPROVED', posting_status: 'UNPOSTED' })).toBe('Đã duyệt, chưa chi');
    expect(payoutStatusLabel({ status: 'APPROVED', posting_status: 'POSTED' })).toBe('Đã chi');
    expect(payoutStatusLabel({ status: 'REVERSED', posting_status: null })).toBe('Đang xử lý');
  });
  it('nút "Chi tạm ứng cho tôi" chỉ mở khi sổ tổng chạy thật; route lạ đóng an toàn', () => {
    expect(selfAdvanceBlockedNote('CANONICAL')).toBeNull();
    for (const route of ['LEGACY', 'SHADOW', 'FROZEN', 'CANARY', null]) expect(selfAdvanceBlockedNote(route)).toEqual(expect.any(String));
  });
  it('màn của chủ: "Chi tạm ứng cho tôi" chỉ khi người xem là cổ đông của ĐÚNG công ty đang xem VÀ có quyền tạm ứng', () => {
    const me = { id: 'sh-1', name: 'Cổ đông 1', organization_id: 'org-a' };
    expect(ownerSelfAdvanceSubject(me, true, 'org-a')).toEqual({ shareholderId: 'sh-1', name: 'Cổ đông 1' });
    expect(ownerSelfAdvanceSubject(me, false, 'org-a')).toBeNull(); // không có quyền tạm ứng
    expect(ownerSelfAdvanceSubject(null, true, 'org-a')).toBeNull(); // không phải cổ đông (hoặc hồ sơ chưa tải)
    expect(ownerSelfAdvanceSubject(undefined, true, 'org-a')).toBeNull();
    expect(ownerSelfAdvanceSubject(me, true, 'org-b')).toBeNull(); // cổ đông của công ty khác
    expect(ownerSelfAdvanceSubject({ id: 'sh-1', name: 'Cổ đông 1' }, true, 'org-a')).toBeNull(); // dòng thiếu công ty: không đoán
    expect(ownerSelfAdvanceSubject(me, true, null)).toBeNull();
  });
  it('công ty lấy từ dòng cổ đông; thiếu / rỗng ⇒ null (không đoán)', () => {
    expect(shareholderOrganizationId({ id: 'sh-1', organization_id: 'org-a' })).toBe('org-a');
    expect(shareholderOrganizationId({ id: 'sh-1' })).toBeNull();
    expect(shareholderOrganizationId({ organization_id: '' })).toBeNull();
    expect(shareholderOrganizationId(null)).toBeNull();
  });
});
