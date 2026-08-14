// Bất biến của danh bạ tổ chức cho Copilot — đo trên CHÍNH văn bản migration.
//
// Test tĩnh không thay được nghiệm thu chạy thật (khối DO trong migration làm
// việc đó bằng vai người dùng thật). Nó canh những thứ mà một lần sửa vô tình
// làm hỏng mà không có gì đỏ lên: mất `REVOKE ... anon`, quên lọc lifecycle,
// hoặc để org sandbox lọt vào danh sách super admin.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20260814032500_copilot_superadmin_organization_directory.sql',
  'utf8',
).replace(/\r\n/g, '\n');

describe('list_my_copilot_organizations_v1 — bề mặt', () => {
  it('KHÔNG nhận tham số nào', () => {
    // Hàm SECURITY DEFINER bỏ qua RLS, nên mọi tham số nhận từ client là một
    // đường để hỏi thay người khác. Cùng lý do đã ghi ở get_my_organizations.
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.list_my_copilot_organizations_v1\(\)/);
  });

  it('REVOKE khỏi PUBLIC/anon và chỉ GRANT cho authenticated', () => {
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.list_my_copilot_organizations_v1\(\) FROM PUBLIC, anon;/,
    );
    expect(sql).toMatch(
      /GRANT\s+EXECUTE ON FUNCTION public\.list_my_copilot_organizations_v1\(\) TO authenticated;/,
    );
    expect(sql).not.toMatch(/GRANT[^\n]*list_my_copilot_organizations_v1[^\n]*anon/);
  });

  it('SECURITY DEFINER kèm search_path cố định', () => {
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = pg_catalog, public');
  });

  it('chỉ ĐỌC — không có DML nào trên bảng tổ chức', () => {
    expect(sql).toContain('LANGUAGE sql');
    expect(sql).toContain('STABLE');
    for (const dml of ['INSERT INTO public.organizations', 'UPDATE public.organizations', 'DELETE FROM public.organizations']) {
      expect(sql, `migration không được ${dml}`).not.toContain(dml);
    }
  });
});

describe('phạm vi danh bạ', () => {
  it('người dùng thường: membership ACTIVE trên org ACTIVE — cả hai điều kiện', () => {
    // Thiếu `o.status = 'ACTIVE'` thì một membership cũ trên công ty đã đóng vẫn
    // chọn được, và người dùng đọc sổ của một công ty không còn hoạt động.
    expect(sql).toMatch(/m\.user_id = \(SELECT auth\.uid\(\)\)/);
    expect(sql).toMatch(/m\.status\s+= 'ACTIVE'/);
    expect(sql).toMatch(/o\.status\s+= 'ACTIVE'/);
  });

  it('super admin: mọi org ACTIVE, TRỪ org sandbox', () => {
    // 20260801020000 giấu org sandbox khỏi super admin bằng ~110 policy
    // RESTRICTIVE. Cho chọn một công ty mà lớp policy đã quyết không cho thấy
    // dữ liệu sẽ tạo ra màn hình rỗng khó hiểu — hai lớp nói hai điều khác nhau.
    expect(sql).toContain('public.is_super_admin()');
    expect(sql).toMatch(/NOT \(o\.id = ANY \(public\.sandbox_org_ids\(\)\)\)/);
  });

  it('cờ is_super lấy từ SERVER, không nhận từ client', () => {
    expect(sql).toMatch(/'is_super',\s+public\.is_super_admin\(\)/);
  });

  it('trả jsonb có mảng rỗng khi không thuộc công ty nào', () => {
    // Mảng rỗng phải phân biệt được với lỗi mạng — coalesce về '[]' chứ không NULL.
    expect(sql).toMatch(/coalesce\(\([\s\S]*?\), '\[\]'::jsonb\)/);
  });
});

describe('nghiệm thu ngay trong migration', () => {
  it('có khối DO đo bằng vai thật, không suy từ thân hàm', () => {
    expect(sql).toContain('SET LOCAL ROLE authenticated');
    expect(sql).toContain("set_config('request.jwt.claims'");
  });

  it('chặn anon, chặn người dùng thường thấy công ty người khác, chặn sandbox lọt danh bạ', () => {
    expect(sql).toMatch(/has_function_privilege\('anon'/);
    expect(sql).toMatch(/thấy công ty KHÔNG phải của mình/);
    expect(sql).toMatch(/Org sandbox lọt vào danh bạ super admin/);
  });

  it('kiểm cả người MỒ CÔI phải thấy 0, không phải lỗi', () => {
    expect(sql).toMatch(/Người không membership vẫn thấy/);
  });

  it('mọi phép nghiệm thu đều RAISE EXCEPTION, không chỉ NOTICE', () => {
    // Một phép kiểm chỉ NOTICE thì migration vẫn COMMIT khi nó sai — tức là
    // nghiệm thu trang trí. Đếm để chắc chắn có nhiều hơn một lối chặn thật.
    const soChan = (sql.match(/RAISE EXCEPTION/g) ?? []).length;
    expect(soChan).toBeGreaterThanOrEqual(8);
  });
});

describe('an toàn giao dịch', () => {
  it('có BEGIN/COMMIT và lock_timeout', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain("SET LOCAL lock_timeout = '15s'");
  });

  it('ghi rõ đường lùi', () => {
    expect(sql).toMatch(/ROLLBACK: DROP FUNCTION public\.list_my_copilot_organizations_v1\(\);/);
  });

  it('KHÔNG đụng vào get_my_organizations cũ', () => {
    // Nới rộng một hàm đang chạy là đổi hành vi của những nơi chưa ai rà lại.
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_my_organizations/);
    expect(sql).not.toMatch(/DROP FUNCTION[^\n]*get_my_organizations/);
  });
});

describe('không trùng công ty trong danh bạ', () => {
  it('dùng LEFT JOIN một truy vấn, KHÔNG dùng UNION hai nhánh', () => {
    // UNION sai với người vừa là super admin vừa có membership: hai nhánh trả
    // cùng một công ty với member_type khác nhau nên không gộp được, và ô chọn
    // hiện công ty đó hai lần.
    expect(sql).toMatch(/LEFT JOIN public\.organization_memberships/);
    expect(sql).not.toMatch(/\n\s*UNION\s*\n/);
  });

  it('nghiệm thu đếm trùng ngay trong migration', () => {
    expect(sql).toMatch(/count\(DISTINCT e ->> 'id'\)/);
    expect(sql).toMatch(/Danh bạ super admin có công ty trùng/);
  });
});
