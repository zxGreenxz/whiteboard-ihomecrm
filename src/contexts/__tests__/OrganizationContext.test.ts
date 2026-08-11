import { describe, expect, it } from 'vitest';

import { parseOrganizations } from '../OrganizationContext';

// GĐ9 — khái niệm "tổ chức hiện tại" ở frontend.
//
// Dữ liệu tới từ RPC get_my_organizations() (SECURITY DEFINER, dựng ở
// 20260809030000), chứ KHÔNG đọc thẳng bảng: đo bằng vai người dùng thường trên
// production thấy `SELECT count(*) FROM organizations` trả 0 vì RLS. Gọi thẳng
// sẽ hiện "không thuộc tổ chức nào" cho MỌI người mà không có lỗi nào nổ ra.
describe('parseOrganizations', () => {
  it('đọc đúng danh sách tổ chức từ payload RPC', () => {
    expect(parseOrganizations({
      user_id: 'u1',
      organizations: [
        { id: 'o1', name: 'Công ty A', slug: 'cty-a', member_type: 'OWNER' },
        { id: 'o2', name: 'Công ty B', slug: null, member_type: null },
      ],
    })).toEqual([
      { id: 'o1', name: 'Công ty A', slug: 'cty-a', memberType: 'OWNER' },
      { id: 'o2', name: 'Công ty B', slug: null, memberType: null },
    ]);
  });

  it('bỏ qua dòng thiếu id hoặc name thay vì render undefined lên giao diện', () => {
    expect(parseOrganizations({
      organizations: [
        { id: 'o1', name: 'Hợp lệ' },
        { id: 'o2' },              // thiếu name
        { name: 'Không có id' },   // thiếu id
        null,
        'chuỗi lạc',
      ],
    })).toEqual([{ id: 'o1', name: 'Hợp lệ', slug: null, memberType: null }]);
  });

  it('payload méo mó hay rỗng thì trả mảng rỗng, không nổ', () => {
    expect(parseOrganizations(null)).toEqual([]);
    expect(parseOrganizations(undefined)).toEqual([]);
    expect(parseOrganizations({})).toEqual([]);
    expect(parseOrganizations({ organizations: null })).toEqual([]);
    expect(parseOrganizations({ organizations: 'không phải mảng' })).toEqual([]);
    expect(parseOrganizations('rác')).toEqual([]);
  });

  it('slug và member_type sai kiểu thì hạ về null chứ không giữ nguyên', () => {
    expect(parseOrganizations({
      organizations: [{ id: 'o1', name: 'A', slug: 123, member_type: { x: 1 } }],
    })).toEqual([{ id: 'o1', name: 'A', slug: null, memberType: null }]);
  });
});
