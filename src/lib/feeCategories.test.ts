import { describe, it, expect } from 'vitest';
import { FEE_CATEGORIES, FEE_GROUPS, feeTypeMatches, feeCategoryOf } from './feeCategories';
import { FIXED_EXPENSE_CATEGORIES, nrm } from './fixedExpenseCategories';

describe('FEE_CATEGORIES registry', () => {
  it('đủ 10 hạng mục + 3 nhóm', () => {
    expect(FEE_CATEGORIES).toHaveLength(10);
    expect(FEE_GROUPS).toEqual(['Phí theo tòa', 'Hoa hồng', 'Bảo trì']);
    expect(FEE_CATEGORIES.every((c) => FEE_GROUPS.includes(c.group))).toBe(true);
  });

  it('đúng ĐÚNG 4 hạng mục multiPeriod (Internet/Công An/Rác/Thang máy)', () => {
    expect(FEE_CATEGORIES.filter((c) => c.multiPeriod).map((c) => c.key).sort()).toEqual(
      ['cong_an', 'internet', 'rac', 'thang_may'],
    );
  });

  it('quan_ly là hạng mục hạn chế DUY NHẤT; thang_may là elevatorGated DUY NHẤT', () => {
    expect(FEE_CATEGORIES.filter((c) => c.restricted).map((c) => c.key)).toEqual(['quan_ly']);
    expect(FEE_CATEGORIES.filter((c) => c.elevatorGated).map((c) => c.key)).toEqual(['thang_may']);
  });

  it('families đúng: dien_nuoc=EN, hoa_hong=COMMISSION, bao_tri=MAINTENANCE_BATCH', () => {
    expect(feeCategoryOf('dien_nuoc')?.family).toBe('EN');
    expect(feeCategoryOf('hoa_hong')?.family).toBe('COMMISSION');
    expect(feeCategoryOf('bao_tri')?.family).toBe('MAINTENANCE_BATCH');
    expect(feeCategoryOf('bao_tri')?.subtypes?.map((s) => s.key)).toEqual(['ml', 'mg']);
  });
});

// PARITY: feeTypeMatches PHẢI khớp match() của FIXED_EXPENSE_CATEGORIES (cùng key)
// cho mọi cặp (category, name) — đảm bảo trang đóng tiền & Báo cáo Lợi Nhuận nhận
// diện hạng mục y hệt nhau (§3.3 CAVEAT bảo trì đồng bộ).
describe('feeTypeMatches ↔ FIXED_EXPENSE_CATEGORIES parity', () => {
  const SHARED = ['tien_nha', 'dien', 'nuoc', 'internet', 'quan_ly', 've_sinh', 'cong_an', 'rac', 'thang_may'];
  const SAMPLES: Array<[string, string]> = [
    ['Tiền nhà', 'Tiền nhà (tự động lập)'],
    ['Điện', 'Đóng tiền điện'],
    ['Nước', 'Đóng tiền nước'],
    ['Internet', 'Internet FPT'],
    ['Quản Lý', 'Phí quản lý tòa'],
    ['Vệ sinh', 'Vệ sinh tòa nhà định kỳ'],
    ['CA', 'Công an phường'],
    ['Rác', 'Tiền rác'],
    ['Bảo Trì Thang Máy', 'Bảo trì thang máy'],
    ['Bảo Trì', 'Vệ sinh máy lạnh'],   // KHÔNG được lọt nhóm ve_sinh
    ['Bảo Trì', 'Bảo trì máy giặt'],
    ['—', 'điện lạnh sửa chữa'],        // KHÔNG lọt nhóm dien
    [null as any, 'Mua bóng đèn led'],
    ['Vệ sinh', 'Tiền rác'],            // Rác thắng, ve_sinh loại
  ];

  for (const key of SHARED) {
    const fixed = FIXED_EXPENSE_CATEGORIES.find((c) => c.key === key)!;
    it(`key '${key}' khớp y hệt FIXED trên mọi mẫu`, () => {
      expect(fixed).toBeTruthy();
      for (const [cat, name] of SAMPLES) {
        const mine = feeTypeMatches(key, cat, name);
        const theirs = fixed.match(nrm(cat), nrm(name));
        expect({ key, cat, name, mine }).toEqual({ key, cat, name, mine: theirs });
      }
    });
  }
});
