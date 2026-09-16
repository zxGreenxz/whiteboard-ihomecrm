// Sổ cho migration 20260915143713 — `get_my_permissions_v2(p_org)`.
//
// LỖ ĐANG VÁ (D1 · D2)
//   `get_my_permissions()` gộp mọi công ty và vứt phạm vi. Nhân viên có quyền
//   duyệt ở một toà thấy nút Duyệt ở mọi toà; chủ nhiều công ty thấy hợp của
//   các tập quyền.
//
// VÌ SAO TEST ĐỌC VĂN BẢN SQL
//   Session con KHÔNG được apply migration lên production (Contract §3), nên
//   không có database để hỏi. Thứ kiểm được ở đây là những TÍNH CHẤT mà đọc
//   nhầm một cái là vá hỏng: fail-closed khi thiếu công ty, giữ sentinel super
//   admin, không đụng v1, ghim search_path, không cấp cho anon, và — quan
//   trọng nhất — bản gộp phải sao y từng mệnh đề của `authorized_scope_v3`.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DUONG_DAN = 'supabase/migrations/20260915143713_get_my_permissions_v2_org_scoped.sql';
const sql = readFileSync(DUONG_DAN, 'utf8').replace(/\r\n/g, '\n');

const KHONG_CHU_THICH = sql
  .split('\n')
  .filter((d) => !/^\s*--/.test(d))
  .join('\n');

describe('chữ ký và nơi ở', () => {
  it('tạo public.get_my_permissions_v2(p_org uuid) trả jsonb', () => {
    expect(KHONG_CHU_THICH).toMatch(
      /create\s+or\s+replace\s+function\s+public\.get_my_permissions_v2\s*\(\s*p_org\s+uuid\s*\)\s*\n?\s*returns\s+jsonb/i,
    );
  });

  it('tạo bản gộp app_private.all_scoped_keys_v3(p_org uuid)', () => {
    expect(KHONG_CHU_THICH).toMatch(
      /create\s+or\s+replace\s+function\s+app_private\.all_scoped_keys_v3\s*\(\s*p_org\s+uuid\s*\)/i,
    );
    expect(KHONG_CHU_THICH).toMatch(
      /returns\s+table\s*\(\s*permission_key\s+text\s*,\s*org_wide\s+boolean\s*,\s*building_ids\s+uuid\[\]\s*,\s*cashbook_ids\s+uuid\[\]\s*\)/i,
    );
  });

  it('KHÔNG đụng get_my_permissions() cũ — v1 sống song song một đợt', () => {
    // Sửa v1 trong cùng migration nghĩa là bản khách đang mở sẵn trong trình
    // duyệt người dùng lúc deploy đổi hành vi dưới chân họ.
    expect(KHONG_CHU_THICH).not.toMatch(/function\s+public\.get_my_permissions\s*\(\s*\)/i);
    expect(KHONG_CHU_THICH).not.toMatch(/drop\s+function[\s\S]{0,60}get_my_permissions\s*\(\s*\)/i);
  });
});

describe('fail-closed', () => {
  it('chưa đăng nhập ⇒ rỗng', () => {
    expect(KHONG_CHU_THICH).toMatch(/if\s+v_actor\s+is\s+null\s+then\s*\n\s*return\s+'\{\}'::jsonb/i);
  });

  it('chưa chốt công ty ⇒ rỗng, KHÔNG đoán bằng cách gộp mọi công ty', () => {
    expect(KHONG_CHU_THICH).toMatch(/if\s+p_org\s+is\s+null\s+then\s*\n\s*return\s+'\{\}'::jsonb/i);
  });

  it('chỉ trả khoá CÒN phạm vi hiệu lực', () => {
    // Để lại khoá org_wide=false + hai mảng rỗng thì mọi bên đọc bằng phép thử
    // "có khoá không" sẽ đọc thành CÓ QUYỀN.
    expect(KHONG_CHU_THICH).toMatch(
      /where\s+k\.org_wide\s*\n\s*or\s+coalesce\(cardinality\(k\.building_ids\)\s*,\s*0\)\s*>\s*0\s*\n\s*or\s+coalesce\(cardinality\(k\.cashbook_ids\)\s*,\s*0\)\s*>\s*0/i,
    );
  });
});

describe('giữ nguyên hợp đồng cũ với giao diện', () => {
  it('super admin vẫn nhận sentinel __superadmin', () => {
    expect(KHONG_CHU_THICH).toMatch(/'\{"__superadmin":\s*true\}'::jsonb/);
    expect(KHONG_CHU_THICH).toMatch(/from\s+public\.super_admins\s+s\s+where\s+s\.user_id\s*=\s*v_actor/i);
  });

  it('hình dạng trả về: {resource: {action: {org_wide, building_ids, cashbook_ids}}}', () => {
    expect(KHONG_CHU_THICH).toMatch(/jsonb_object_agg\(\s*g\.resource\s*,\s*g\.actions\s*\)/i);
    expect(KHONG_CHU_THICH).toMatch(/jsonb_object_agg\(\s*pd\.action\s*,\s*jsonb_build_object\(/i);
    for (const khoa of ['org_wide', 'building_ids', 'cashbook_ids']) {
      expect(KHONG_CHU_THICH, `thiếu khoá ${khoa}`).toContain(`'${khoa}'`);
    }
  });
});

describe('bản gộp sao y ngữ nghĩa authorized_scope_v3', () => {
  const than = KHONG_CHU_THICH.slice(
    KHONG_CHU_THICH.indexOf('all_scoped_keys_v3'),
    KHONG_CHU_THICH.indexOf('get_my_permissions_v2'),
  );

  it('DENY có phạm vi vẫn hạ org_wide (bản vá 08/09/2026)', () => {
    // Đây là thứ dễ mất nhất khi viết lại bản gộp: một cạnh DENY ở MỘT toà mà
    // vẫn để org_wide = true thì người bị cấm đúng chỗ lại được phép mọi chỗ.
    expect(than).toMatch(/when\s+coalesce\(cardinality\(r\.d_b\)\s*,\s*0\)\s*>\s*0\s+then\s+false/i);
    expect(than).toMatch(/when\s+coalesce\(cardinality\(r\.d_c\)\s*,\s*0\)\s*>\s*0\s+then\s+false/i);
    expect(than).toMatch(/when\s+r\.d_org\s+then\s+false/i);
  });

  it('quyền đòi ĐANG GIỮ SỔ chỉ tính sổ thực sự đang giữ', () => {
    expect(than).toMatch(/when\s+r\.needs_possession\s+then\s+array\(select\s+x\s+from\s+unnest\(r\.a_c\)/i);
    expect(than).toMatch(/cashbook_possession_bindings/i);
    expect(than).toMatch(/accepted_possession_kinds/i);
  });

  it('phạm vi AREA nở ra thành từng toà', () => {
    expect(than).toMatch(/area_buildings/i);
    expect(than).toMatch(/e\.scope_type\s*=\s*'AREA'/i);
  });

  it('org_wide nở ra TẤT CẢ toà đang sống của công ty', () => {
    expect(than).toMatch(/case\s+when\s+r\.a_org\s+then\s+r\.all_b\s+else\s+r\.a_b\s+end/i);
    expect(than).toMatch(/from\s+public\.buildings\s+b\s*\n\s*where\s+b\.organization_id\s*=\s*p_org\s+and\s+b\.deleted_at\s+is\s+null/i);
  });

  it('cấm khẩn cấp: dòng permission_key null cấm toàn bộ công ty', () => {
    expect(than).toMatch(/tenant_emergency_denies/i);
    expect(than).toMatch(/exists\s*\(select\s+1\s+from\s+emergency\s+where\s+permission_key\s+is\s+null\)/i);
  });

  it('chỉ đếm membership ACTIVE, chưa thu hồi, còn hiệu lực', () => {
    expect(than).toMatch(/m\.status\s*=\s*'ACTIVE'/i);
    expect(than).toMatch(/m\.revoked_at\s+is\s+null/i);
    expect(than).toMatch(/m\.valid_to\s+is\s+null\s+or\s+m\.valid_to\s*>\s*at\.ts/i);
  });

  it('mọi cạnh đều bị chặn trong ĐÚNG công ty được hỏi', () => {
    // Thiếu một mệnh đề organization_id là mở lại đúng lỗ D2.
    const soChot = (than.match(/organization_id\s*=\s*p_org/gi) ?? []).length;
    expect(soChot).toBeGreaterThanOrEqual(5);
  });
});

describe('ACL và search_path', () => {
  it('cả hai hàm ghim search_path', () => {
    const soGhim = (KHONG_CHU_THICH.match(/set\s+search_path\s+to\s+/gi) ?? []).length;
    expect(soGhim).toBe(2);
  });

  it('thu hồi khỏi public, anon VÀ authenticated trước khi cấp lại', () => {
    // Án lệ: REVOKE FROM PUBLIC không cắt anon trên Supabase, nên phải gọi tên
    // từng role; không làm thế thì check-definer-acl đỏ.
    for (const ham of ['app_private.all_scoped_keys_v3(uuid)', 'public.get_my_permissions_v2(uuid)']) {
      const esc = ham.replace(/[().]/g, '\\$&');
      expect(KHONG_CHU_THICH).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${esc}\\s+from\\s+public,\\s*anon,\\s*authenticated;`, 'i'),
      );
      expect(KHONG_CHU_THICH).toMatch(
        new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${esc}\\s+to\\s+authenticated;`, 'i'),
      );
    }
  });

  it('KHÔNG cấp cho anon ở bất cứ đâu', () => {
    expect(KHONG_CHU_THICH).not.toMatch(/grant[\s\S]{0,120}\bto\b[^;\n]*\banon\b/i);
  });

  it('cả hai hàm là STABLE SECURITY DEFINER', () => {
    expect((KHONG_CHU_THICH.match(/\bsecurity\s+definer\b/gi) ?? []).length).toBe(2);
    expect((KHONG_CHU_THICH.match(/^\s*stable\s*$/gim) ?? []).length).toBe(2);
  });
});

describe('chạy lại được lần hai', () => {
  it('chỉ dùng create or replace, không DROP, có begin/commit và lock_timeout', () => {
    expect(KHONG_CHU_THICH).not.toMatch(/\bdrop\s+function\b/i);
    expect(KHONG_CHU_THICH.trim().startsWith('begin;')).toBe(true);
    expect(KHONG_CHU_THICH.trim().endsWith('commit;')).toBe(true);
    expect(KHONG_CHU_THICH).toMatch(/set\s+local\s+lock_timeout\s*=\s*'15s'/i);
  });
});
