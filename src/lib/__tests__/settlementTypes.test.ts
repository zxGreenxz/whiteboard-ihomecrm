import { describe, it, expect } from 'vitest';
import { resolveSettlementKind, settlementTypeMatches } from '@/lib/settlementTypes';

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

// =============================================================================
// resolveSettlementKind — MỘT PHIẾU ra MỘT loại (plan §3.6).
//
// Đây là chỗ bản cũ sai: `useContractSettlement.kindOf` kết thúc bằng
// `return 'refund'` trần, nên phiếu hạng mục HHMG mà thiếu `commission_kind`
// rơi vào Hoàn khách và không bao giờ được tra căn cứ hoa hồng.
//
// Thứ tự ưu tiên CỐ ĐỊNH: `commission_kind` → `system_source` → hạng mục kế
// toán. Không suy từ tên/mã phiếu. Không ghi ngược loại suy ra vào DB.
// =============================================================================

describe('resolveSettlementKind — HHMG thủ công (ca PC2606169 / PC2608091)', () => {
  // Hai phiếu thật: hạng mục HHMG, KHÔNG có commission_kind, KHÔNG có dấu nguồn.
  // Ở đây chỉ mô phỏng HÌNH DẠNG; định danh thật là (UUID, organization_id) và
  // được ghim ở test read model, không phải ở hàm thuần này.
  it('thiếu metadata mà hạng mục là HHMG ⇒ Hoa hồng, KHÔNG phải Hoàn khách', () => {
    const r = resolveSettlementKind({
      commissionKind: null, systemSource: null, itemKinds: ['commission'],
    });
    expect(r.kind).toBe('commission');
    expect(r.signal).toBe('accounting_item');
    expect(r.conflict).toBe(false);
  });

  it('thiếu metadata mà hạng mục là thưởng sale ⇒ Thưởng sale', () => {
    const r = resolveSettlementKind({
      commissionKind: null, systemSource: null, itemKinds: ['bonus'],
    });
    expect(r.kind).toBe('bonus');
    expect(r.signal).toBe('accounting_item');
  });

  it('hoàn cọc thủ công vẫn là Hoàn khách — nhưng vì HẠNG MỤC, không vì mặc định', () => {
    const r = resolveSettlementKind({
      commissionKind: null, systemSource: null, itemKinds: ['refund'],
    });
    expect(r.kind).toBe('refund');
    expect(r.signal).toBe('accounting_item');
  });

  it('không dấu nào và không hạng mục nào ⇒ CHƯA XÁC ĐỊNH, không mặc định refund', () => {
    const r = resolveSettlementKind({
      commissionKind: null, systemSource: null, itemKinds: [],
    });
    expect(r.kind).toBeNull();
    expect(r.signal).toBe('none');
    expect(r.conflict).toBe(false);
  });
});

describe('resolveSettlementKind — metadata rõ thì metadata quyết định', () => {
  it('commission_kind broker ⇒ Hoa hồng', () => {
    const r = resolveSettlementKind({ commissionKind: 'broker', systemSource: null, itemKinds: [] });
    expect(r.kind).toBe('commission');
    expect(r.signal).toBe('commission_kind');
  });

  it('commission_kind sale ⇒ Thưởng sale', () => {
    const r = resolveSettlementKind({ commissionKind: 'sale', systemSource: null, itemKinds: [] });
    expect(r.kind).toBe('bonus');
    expect(r.signal).toBe('commission_kind');
  });

  it('system_source termination.refund ⇒ Hoàn khách', () => {
    const r = resolveSettlementKind({
      commissionKind: null, systemSource: 'termination.refund.v1', itemKinds: [],
    });
    expect(r.kind).toBe('refund');
    expect(r.signal).toBe('system_source');
  });

  it('system_source reservation.refund ⇒ Hoàn khách', () => {
    const r = resolveSettlementKind({
      commissionKind: null, systemSource: 'reservation.refund', itemKinds: [],
    });
    expect(r.kind).toBe('refund');
    expect(r.signal).toBe('system_source');
  });

  it('commission_kind xét TRƯỚC system_source', () => {
    const r = resolveSettlementKind({
      commissionKind: 'broker', systemSource: 'termination.refund.v1', itemKinds: [],
    });
    expect(r.kind).toBe('commission');
    expect(r.signal).toBe('commission_kind');
  });

  it('metadata rõ thì hạng mục KHÔNG lật ngược loại', () => {
    const r = resolveSettlementKind({
      commissionKind: 'broker', systemSource: null, itemKinds: ['refund'],
    });
    expect(r.kind).toBe('commission');
    expect(r.signal).toBe('commission_kind');
  });

  it('giá trị commission_kind lạ không được coi là dấu rõ', () => {
    const r = resolveSettlementKind({
      commissionKind: 'staff', systemSource: null, itemKinds: ['refund'],
    });
    expect(r.kind).toBe('refund');
    expect(r.signal).toBe('accounting_item');
  });
});

describe('resolveSettlementKind — xung đột và trùng lặp', () => {
  it('metadata mâu thuẫn hạng mục ⇒ vẫn theo metadata NHƯNG đánh dấu xung đột', () => {
    const r = resolveSettlementKind({
      commissionKind: 'broker', systemSource: null, itemKinds: ['refund'],
    });
    expect(r.kind).toBe('commission');
    expect(r.conflict).toBe(true);
  });

  it('nhiều loại hạng mục mà không có dấu rõ ⇒ CHƯA XÁC ĐỊNH + xung đột', () => {
    const r = resolveSettlementKind({
      commissionKind: null, systemSource: null, itemKinds: ['refund', 'commission'],
    });
    expect(r.kind).toBeNull();
    expect(r.conflict).toBe(true);
    // KHÔNG tự chọn item đầu tiên.
    expect(r.signal).toBe('none');
  });

  it('hai dấu metadata chỏi nhau cũng là xung đột', () => {
    const r = resolveSettlementKind({
      commissionKind: 'broker', systemSource: 'termination.refund.v1', itemKinds: [],
    });
    expect(r.conflict).toBe(true);
  });

  it('nhiều item CÙNG loại vẫn là một loại, không xung đột', () => {
    const r = resolveSettlementKind({
      commissionKind: null, systemSource: null,
      itemKinds: ['commission', 'commission', 'commission'],
    });
    expect(r.kind).toBe('commission');
    expect(r.conflict).toBe(false);
    expect(r.itemKinds).toEqual(['commission']);
  });

  it('item ngoài nhóm (null/undefined) bị bỏ qua, không đổi loại', () => {
    const r = resolveSettlementKind({
      commissionKind: null, systemSource: null,
      itemKinds: ['commission', null, undefined],
    });
    expect(r.kind).toBe('commission');
    expect(r.conflict).toBe(false);
    expect(r.itemKinds).toEqual(['commission']);
  });
});

describe('resolveSettlementKind — thuần', () => {
  it('cùng đầu vào cho cùng kết quả và không sửa mảng đầu vào', () => {
    const vao = ['commission', 'refund'] as const;
    const goc = [...vao];
    const a = resolveSettlementKind({ commissionKind: null, systemSource: null, itemKinds: vao });
    const b = resolveSettlementKind({ commissionKind: null, systemSource: null, itemKinds: vao });
    expect(a).toEqual(b);
    expect([...vao]).toEqual(goc);
  });

  it('chuỗi rỗng / undefined không nổ', () => {
    const r = resolveSettlementKind({
      commissionKind: '', systemSource: '', itemKinds: undefined,
    });
    expect(r.kind).toBeNull();
    expect(r.itemKinds).toEqual([]);
  });
});
