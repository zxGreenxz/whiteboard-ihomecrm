import { describe, it, expect } from 'vitest';
import { settlementTypeMatches } from '@/lib/settlementTypes';

// =============================================================================
// Luật nhận phiếu theo HẠNG MỤC KẾ TOÁN.
//
// Mọi cặp (category, name) dưới đây là DỮ LIỆU THẬT đã đo trên org THẬT ngày
// 21/09/2026 — không phải ví dụ bịa. Chúng là các phiếu tạo tay ở Thu chi mà bộ
// lọc chỉ-theo-dấu-nguồn của bản plan v1 bỏ sót (13 phiếu, 3 đang chờ duyệt).
//
// SQL đã dùng để lấy danh sách này nằm ở
// docs/audits/2026-09-21-hop-dong-quyet-toan-plan-audit/category-coverage.sql
// =============================================================================

describe('settlementTypeMatches — hạng mục thật đang chạy trên production', () => {
  it('"Hoàn cọc thanh lý" (category NULL) là hoàn khách', () => {
    expect(settlementTypeMatches(null, 'Hoàn cọc thanh lý')).toBe('refund');
  });

  it('"Bổ sung hoàn cọc" trong hạng mục XỬ LÝ HĐ là hoàn khách', () => {
    expect(settlementTypeMatches('XỬ LÝ HĐ', 'Bổ sung hoàn cọc')).toBe('refund');
  });

  it('"Hoàn cọc / tiền thừa khi thanh lý" là hoàn khách', () => {
    expect(settlementTypeMatches('XỬ LÝ HĐ', 'Hoàn cọc / tiền thừa khi thanh lý')).toBe('refund');
  });

  it('"HHMG" trong hạng mục HOA HỒNG là hoa hồng', () => {
    expect(settlementTypeMatches('HOA HỒNG', 'HHMG')).toBe('commission');
  });

  it('"Hoa hồng môi giới" là hoa hồng', () => {
    expect(settlementTypeMatches('Hoa hồng', 'Hoa hồng môi giới')).toBe('commission');
  });

  it('"Hoàn tiền cọc" là hoàn khách', () => {
    expect(settlementTypeMatches('Hoàn cọc', 'Hoàn tiền cọc')).toBe('refund');
  });

  it('"Hoàn cọc giữ chỗ" (category NULL) là hoàn khách', () => {
    expect(settlementTypeMatches(null, 'Hoàn cọc giữ chỗ')).toBe('refund');
  });
});

// Bảy loại dưới đây là TOÀN BỘ loại khớp ở org THẬT, lấy bằng SQL ngày 21/09.
// Giữ nguyên danh sách này: nó vừa là test, vừa là ảnh chụp để lần sau so.
describe('settlementTypeMatches — bảy loại thật ở org THẬT', () => {
  const THAT: [string | null, string, 'refund' | 'commission' | 'bonus'][] = [
    [null, 'Hoàn cọc giữ chỗ', 'refund'],
    [null, 'Hoàn cọc thanh lý', 'refund'],
    ['HOA HỒNG', 'HHMG', 'commission'],
    ['HOA HỒNG', 'Hoa hồng môi giới', 'commission'],
    ['HOA HỒNG', 'Thưởng nóng Sale', 'bonus'],
    ['XỬ LÝ HĐ', 'Bổ sung hoàn cọc', 'refund'],
    ['XỬ LÝ HĐ', 'Hoàn cọc / tiền thừa khi thanh lý', 'refund'],
  ];

  it.each(THAT)('category=%s name=%s ⇒ %s', (category, name, mong) => {
    expect(settlementTypeMatches(category, name)).toBe(mong);
  });
});

describe('settlementTypeMatches — thứ tự ưu tiên', () => {
  // "Thưởng nóng Sale" mang category "Hoa hồng" trên production (xem
  // feeCategories.ts: canonicalCategory của thuong_sale). Nếu xét hoa hồng
  // trước thì nó bị nuốt thành 'commission' — sai loại, sai căn cứ đối chiếu.
  it('"Thưởng nóng Sale" ra bonus dù category là Hoa hồng', () => {
    expect(settlementTypeMatches('Hoa hồng', 'Thưởng nóng Sale')).toBe('bonus');
  });

  it('"Thưởng Sale" cũng ra bonus', () => {
    expect(settlementTypeMatches(null, 'Thưởng Sale')).toBe('bonus');
  });
});

describe('settlementTypeMatches — loại trừ', () => {
  it('phiếu THU cọc không phải khoản chi hoàn khách', () => {
    expect(settlementTypeMatches('Cọc', 'Thu cọc')).toBeNull();
    expect(settlementTypeMatches('Cọc', 'Nhận cọc giữ chỗ')).toBeNull();
  });

  it('hoa hồng nhân viên không thuộc khu này', () => {
    expect(settlementTypeMatches('Hoa hồng', 'Hoa hồng nhân viên')).toBeNull();
  });

  it('hạng mục không liên quan trả null', () => {
    expect(settlementTypeMatches('Điện', 'Đóng tiền điện')).toBeNull();
    expect(settlementTypeMatches('Tiền nhà', 'Tiền nhà')).toBeNull();
    expect(settlementTypeMatches('Lương', 'Lương quản lý')).toBeNull();
  });

  it('rỗng / null không nổ và trả null', () => {
    expect(settlementTypeMatches(null, null)).toBeNull();
    expect(settlementTypeMatches(undefined, undefined)).toBeNull();
    expect(settlementTypeMatches('', '')).toBeNull();
  });
});

describe('settlementTypeMatches — không phụ thuộc dấu và hoa thường', () => {
  it('khớp bất kể gõ hoa thường hay có dấu', () => {
    expect(settlementTypeMatches(null, 'HOÀN CỌC THANH LÝ')).toBe('refund');
    expect(settlementTypeMatches(null, 'hoan coc thanh ly')).toBe('refund');
    expect(settlementTypeMatches('hoa hong', 'hhmg')).toBe('commission');
  });

  it('thuần: cùng đầu vào cho cùng kết quả', () => {
    const a = settlementTypeMatches('XỬ LÝ HĐ', 'Bổ sung hoàn cọc');
    const b = settlementTypeMatches('XỬ LÝ HĐ', 'Bổ sung hoàn cọc');
    expect(a).toBe(b);
  });
});
