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

// §−1.3 (kiểm toán 30/07/2026): `fee_type_matches('quan_ly', …)` cũ chỉ dò
// '%quan ly%' nên khớp luôn tên loại tiền LƯƠNG ⇒ 34.206.744đ (org thật) nằm
// trong ô phí "Quản Lý" của trang đóng tiền, và `resolve_fixed_expense_type`
// còn có thể GHI một khoản chi Quản Lý vào loại tiền lương.
//
// 4 loại đang khớp '%quan ly%' trên production (đo 30/07/2026):
//   'Quản Lý'          · category 'Vận Hành' ← phí THẬT, phải khớp
//   'Lương quản lý'    · category NULL       ← lương, phải KHÔNG khớp
//   'Lương quản lý'    · category 'Lương'    ← lương, phải KHÔNG khớp
//   'Ứng lương quản lý'· category 'Lương'    ← lương, phải KHÔNG khớp
// Vì có ca category NULL nên chỉ loại theo category là KHÔNG đủ — phải loại
// theo tên. Đây là mirror của nhánh SQL đã sửa (xem comment trong feeCategories.ts).
//
// HAI MẪU CUỐI LÀ MẪU PIN PARITY SQL↔TS (thêm sau rà vòng 2, 30/07): tên KHÔNG
// mang chữ "lương" nhưng CATEGORY thì có, và category KHÁC hẳn 'Lương'. Đây đúng
// chỗ hai bản từng lệch — migration bản nháp dùng `nrm_vn(p_cat) <> 'luong'` nên
// SQL vẫn nhận, còn TS (`!c.includes('luong')`) thì loại. Cả hai giờ đều dùng
// NOT LIKE '%luong%'. Nếu ai đổi một trong hai về so-bằng, mẫu này ĐỎ.
describe('quan_ly KHÔNG được nuốt tiền lương (§−1.3)', () => {
  const SALARY: Array<[string | null, string]> = [
    [null, 'Lương quản lý'],
    ['Lương', 'Lương quản lý'],
    ['Lương', 'Ứng lương quản lý'],
    ['Lương thưởng', 'Phí quản lý'],
    ['Lương nhân viên', 'Chi phí quản lý'],
  ];

  it('không mẫu tiền lương nào lọt vào slot quan_ly', () => {
    for (const [cat, name] of SALARY) {
      expect({ cat, name, m: feeTypeMatches('quan_ly', cat, name) })
        .toEqual({ cat, name, m: false });
    }
  });

  it('hạng mục "Quản Lý" THẬT (category Vận Hành) vẫn khớp', () => {
    expect(feeTypeMatches('quan_ly', 'Vận Hành', 'Quản Lý')).toBe(true);
    expect(feeTypeMatches('quan_ly', 'Quản Lý', 'Phí quản lý tòa')).toBe(true);
    expect(feeTypeMatches('quan_ly', null, 'Quản lý vận hành')).toBe(true);
  });

  it('tiền lương cũng không lọt vào 8 slot phí cố định còn lại', () => {
    const OTHER = ['tien_nha', 'dien', 'nuoc', 'internet', 've_sinh', 'cong_an', 'rac', 'thang_may'];
    for (const key of OTHER) {
      for (const [cat, name] of SALARY) {
        expect({ key, name, m: feeTypeMatches(key, cat, name) })
          .toEqual({ key, name, m: false });
      }
    }
  });

  // TRIPWIRE có chủ ý: nơi thứ 2 của bộ ba đồng bộ (fixedExpenseCategories.ts →
  // Báo cáo Lợi Nhuận) CHƯA được sửa cùng lúc vì thuộc bề mặt khác. Test này ghi
  // nhận đúng mức lệch hiện tại; khi ai đó đồng bộ nốt nơi thứ 2, test sẽ ĐỎ —
  // lúc đó XOÁ cả khối này và thêm 3 mẫu lương vào SAMPLES của khối parity dưới.
  it('ghi nhận lệch parity với FIXED_EXPENSE_CATEGORIES (nơi thứ 2 chưa đồng bộ)', () => {
    const fixed = FIXED_EXPENSE_CATEGORIES.find((c) => c.key === 'quan_ly')!;
    const stillMatchedByFixed = SALARY.filter(([c, n]) => fixed.match(nrm(c), nrm(n))).length;
    // `SALARY.length` chứ không phải hằng số: nơi thứ 2 chỉ dò `n.includes('quan ly')`
    // nên nó khớp TẤT CẢ mẫu ở đây (mọi tên đều chứa "quản lý"). Khi ai đồng bộ nốt
    // nơi thứ 2, con số tụt xuống và test ĐỎ — đúng ý tripwire, và thêm mẫu mới vào
    // SALARY không phải sửa lại số.
    expect(
      stillMatchedByFixed,
      'fixedExpenseCategories.ts đã đồng bộ? Xoá khối tripwire này và gộp mẫu lương vào SAMPLES parity.',
    ).toBe(SALARY.length);
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
