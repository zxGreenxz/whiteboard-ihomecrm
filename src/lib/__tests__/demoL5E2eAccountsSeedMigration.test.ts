import { describe, expect, it } from 'vitest';

import { boCommentSql, docSql } from './helpers/sqlTestUtils';

// Bổ sung G5-C2 (theo yêu cầu điều phối viên, sau khi G5-DE E2E phát hiện
// thiếu tài khoản) — DML thuần seed hai tài khoản E2E cho MỘT MÌNH org DEMO:
// super admin nguyentamca165@gmail.com trở thành thành viên ACTIVE mang vai
// của demo.chunha, và demo.ketoan được cấp ngoại lệ income_expenses.approve.
// Ghim: đúng org/uid hằng số, không CREATE/DROP object, DB rỗng thì bỏ qua,
// đi ĐÚNG bốn bảng mà update_member_authorization_v1 tự ghi (không tự bịa cơ
// chế phân quyền riêng). MỌI assertion chạy trên bản ĐÃ LỘT BÌNH LUẬN.
const migrationPath = 'supabase/migrations/20260903220254_demo_l5_e2e_accounts_seed_v1.sql';
const migration = boCommentSql(docSql(migrationPath));

const DEMO_ORG = 'dddd0000-0000-4000-8000-000000000001';
const SUPER_ADMIN_UID = '90450d5f-29b6-4897-bdef-cdb5fb53f339';

describe('demo_l5_e2e_accounts_seed_v1 — khung', () => {
  it('tồn tại, một cặp BEGIN/COMMIT, có lock_timeout', () => {
    expect(migration).not.toBe('');
    expect(migration.match(/^BEGIN;$/gm)?.length ?? 0).toBe(1);
    expect(migration.match(/^COMMIT;$/gm)?.length ?? 0).toBe(1);
    expect(migration).toMatch(/SET LOCAL lock_timeout = '15s';/);
  });

  it('không CREATE/DROP/ALTER object nào — thuần DML', () => {
    expect(migration).not.toMatch(/CREATE TABLE|CREATE FUNCTION|DROP TABLE|DROP FUNCTION|ALTER TABLE/);
  });
});

describe('Org đúng, và ĐÚNG MỘT org — DEMO; đúng uid super admin', () => {
  it('mọi câu lệnh khoá theo hằng số ORG = DEMO', () => {
    expect(migration).toContain(`ORG constant uuid := '${DEMO_ORG}';`);
  });

  it('SUPER_ADMIN là hằng số đúng uid nguyentamca165@gmail.com, có đối chiếu email trước khi ghi bất cứ gì', () => {
    expect(migration).toContain(`SUPER_ADMIN constant uuid := '${SUPER_ADMIN_UID}';`);
    expect(migration).toMatch(
      /v_super_email IS DISTINCT FROM 'nguyentamca165@gmail\.com'/,
    );
  });

  it('không đụng thẳng bảng của một org khác — mọi WHERE lọc organization_id đều so với ORG', () => {
    expect(migration).not.toMatch(/organization_id\s*=\s*'(?!dddd0000-0000-4000-8000-000000000001)[0-9a-f-]{36}'/i);
  });
});

describe('DB rỗng / dữ liệu thiếu — bỏ qua, không lỗi', () => {
  it('khối seed kiểm organizations rồi RAISE NOTICE + RETURN khi không thấy org DEMO', () => {
    const seed = migration.slice(migration.indexOf('DO $seed$'), migration.indexOf('$seed$;'));
    expect(seed).toMatch(/IF NOT v_org_ton_tai THEN/);
    expect(seed).toMatch(/RAISE NOTICE[\s\S]{0,200}RETURN;/);
  });

  it('super admin không khớp email hoặc không còn trong super_admins → RAISE NOTICE + RETURN, không RAISE EXCEPTION', () => {
    const seed = migration.slice(migration.indexOf('DO $seed$'), migration.indexOf('$seed$;'));
    expect(seed).toMatch(/v_super_email IS DISTINCT FROM 'nguyentamca165@gmail\.com' THEN\s*\n\s*RAISE NOTICE[\s\S]{0,220}RETURN;/);
    expect(seed).toMatch(/NOT EXISTS \(SELECT 1 FROM public\.super_admins sa WHERE sa\.user_id = SUPER_ADMIN\) THEN\s*\n\s*RAISE NOTICE[\s\S]{0,150}RETURN;/);
  });

  it('demo.chunha thiếu vai trò hiệu lực → RAISE NOTICE + RETURN (không tự bịa role/scope)', () => {
    const seed = migration.slice(migration.indexOf('DO $seed$'), migration.indexOf('$seed$;'));
    expect(seed).toMatch(/v_chunha_role_id IS NULL THEN\s*\n\s*RAISE NOTICE[\s\S]{0,150}RETURN;/);
  });

  it('demo.ketoan thiếu/không ACTIVE → chỉ NOTICE, KHÔNG return (phần 1, super admin, vẫn phải chạy)', () => {
    const seed = migration.slice(migration.indexOf('DO $seed$'), migration.indexOf('$seed$;'));
    const iKetoanNotice = seed.search(/v_ketoan_membership IS NULL THEN\s*\n\s*RAISE NOTICE/);
    expect(iKetoanNotice).toBeGreaterThan(-1);
    // Đoạn NOTICE của ketoan KHÔNG có RETURN ngay sau (khác ba guard trên).
    const doan = seed.slice(iKetoanNotice, iKetoanNotice + 260);
    expect(doan).not.toMatch(/RETURN;/);
  });

  it('khối nghiệm thu cũng bỏ qua khi org DEMO hoặc super admin không còn hợp lệ', () => {
    const nghiemThu = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(nghiemThu).toMatch(/IF NOT EXISTS \(SELECT 1 FROM public\.organizations WHERE id = ORG\) THEN\s*\n\s*RAISE NOTICE[\s\S]{0,150}RETURN;/);
    expect(nghiemThu).toMatch(/IF NOT EXISTS \(SELECT 1 FROM public\.super_admins WHERE user_id = SUPER_ADMIN\) THEN\s*\n\s*RAISE NOTICE[\s\S]{0,150}RETURN;/);
  });
});

describe('Đi đúng bốn bảng mà update_member_authorization_v1 tự ghi — không tự bịa cơ chế phân quyền', () => {
  it('vai trò ghi vào role_bindings + role_binding_scopes, KHÔNG có bảng "roles"/"permissions" tự chế nào khác', () => {
    expect(migration).toMatch(/INSERT INTO public\.role_bindings/);
    expect(migration).toMatch(/INSERT INTO public\.role_binding_scopes/);
  });

  it('ngoại lệ quyền ghi vào member_permission_overrides + member_override_scopes, scope_mode=ORGANIZATION', () => {
    expect(migration).toMatch(/INSERT INTO public\.member_permission_overrides/);
    expect(migration).toMatch(/INSERT INTO public\.member_override_scopes/);
    expect(migration).toContain("'ORGANIZATION');");
  });

  it("permission_key đúng income_expenses.approve, effect ALLOW", () => {
    expect(migration).toContain("'income_expenses.approve', 'ALLOW',");
  });

  it('sau khi ghi, bump organizations.authorization_version — giống hệt update_member_authorization_v1/set_membership_status_v1', () => {
    expect(migration).toMatch(
      /UPDATE public\.organizations SET authorization_version = authorization_version \+ 1 WHERE id = ORG;/,
    );
  });
});

describe('Idempotent theo Ý NGHĨA, không theo id cứng', () => {
  it('membership của super admin dùng WHERE NOT EXISTS theo (organization_id, user_id)', () => {
    const idx = migration.indexOf('INSERT INTO public.organization_memberships');
    const doan = migration.slice(idx, idx + 400);
    expect(doan).toMatch(/WHERE NOT EXISTS \(/);
    expect(doan).toMatch(/organization_id = ORG AND user_id = SUPER_ADMIN/);
  });

  it('role_binding của super admin kiểm ĐÚNG role_id + scope_id + valid_to IS NULL trước khi chèn — không phải ON CONFLICT trần', () => {
    const idx = migration.indexOf('IF NOT EXISTS (\n    SELECT 1 FROM public.role_bindings rb');
    expect(idx).toBeGreaterThan(-1);
    const doan = migration.slice(idx, idx + 400);
    expect(doan).toMatch(/rb\.role_id = v_chunha_role_id/);
    expect(doan).toMatch(/rbs\.scope_id = v_chunha_scope_id/);
    expect(doan).toMatch(/rb\.valid_to IS NULL/);
  });

  it('override của ketoan kiểm ĐÚNG permission_key + effect + revoked_at IS NULL + scope_id trước khi chèn', () => {
    const idx = migration.indexOf('SELECT 1 FROM public.member_permission_overrides o');
    expect(idx).toBeGreaterThan(-1);
    const doan = migration.slice(idx, idx + 400);
    expect(doan).toMatch(/o\.permission_key = 'income_expenses\.approve'/);
    expect(doan).toMatch(/o\.effect = 'ALLOW'/);
    expect(doan).toMatch(/o\.revoked_at IS NULL/);
  });
});


// ---------------------------------------------------------------------------
// Fix round 1 (review) — F3 (MED-LOW): nghiệm thu phải mirror safe-skip của
// body, và KHÔNG hardcode tên vai trò.
// ---------------------------------------------------------------------------
describe('Fix round 1 — F3: member_type đọc ĐỘNG từ hàng chunha (không còn literal OWNER lệch với comment)', () => {
  it('SELECT vai trò của chunha lấy luôn m.member_type vào v_chunha_member_type', () => {
    const seed = migration.slice(migration.indexOf('DO $seed$'), migration.indexOf('$seed$;'));
    expect(seed).toMatch(/SELECT rb\.role_id, rbs\.scope_id, m\.member_type/);
    expect(seed).toContain('INTO v_chunha_role_id, v_chunha_scope_id, v_chunha_member_type');
  });

  it("INSERT organization_memberships dùng v_chunha_member_type — KHÔNG còn literal 'OWNER' tĩnh", () => {
    const seed = migration.slice(migration.indexOf('DO $seed$'), migration.indexOf('$seed$;'));
    expect(seed).toMatch(/SELECT ORG, SUPER_ADMIN, v_chunha_member_type, 'ACTIVE',/);
    expect(seed).not.toMatch(/SELECT ORG, SUPER_ADMIN, 'OWNER', 'ACTIVE',/);
  });
});

describe('Fix round 1 — F3: nghiệm thu mirror ĐỦ BA điều kiện bỏ-qua-an-toàn của body (org / super admin / vai trò chunha)', () => {
  const nghiemThu = migration.slice(migration.indexOf('DO $nghiem_thu$'));

  it('kiểm org tồn tại, RỒI email super admin khớp, RỒI super admin còn hợp lệ, RỒI demo.chunha còn vai trò — mỗi bước NOTICE+RETURN riêng, không RAISE EXCEPTION sớm', () => {
    const iOrg = nghiemThu.search(/organizations WHERE id = ORG\) THEN\s*\n\s*RAISE NOTICE/);
    const iEmail = nghiemThu.search(/v_super_email IS DISTINCT FROM 'nguyentamca165@gmail\.com' THEN/);
    const iSuper = nghiemThu.search(/NOT EXISTS \(SELECT 1 FROM public\.super_admins WHERE user_id = SUPER_ADMIN\) THEN/);
    const iChunha = nghiemThu.search(/v_chunha_role_id IS NULL THEN\s*\n\s*RAISE NOTICE/);
    expect(iOrg).toBeGreaterThan(-1);
    expect(iEmail).toBeGreaterThan(iOrg);
    expect(iSuper).toBeGreaterThan(iEmail);
    expect(iChunha).toBeGreaterThan(iSuper);
  });

  it('tra lại role_id/scope_id của demo.chunha ĐỘNG, giống hệt khối $seed$ (không hardcode tên vai trò)', () => {
    expect(nghiemThu).toMatch(/u\.email = 'demo\.chunha@username\.ihomecrm\.local'/);
    expect(nghiemThu).not.toContain("r.name = 'Chủ công ty'");
    expect(nghiemThu).not.toMatch(/JOIN public\.organization_roles r ON r\.id = rb\.role_id/);
  });

  it('assertion cuối so khớp role_id + scope_id ĐỘNG (rb.role_id = v_chunha_role_id AND rbs.scope_id = v_chunha_scope_id), không so tên', () => {
    expect(nghiemThu).toMatch(/rb\.role_id = v_chunha_role_id/);
    expect(nghiemThu).toMatch(/rbs\.scope_id = v_chunha_scope_id/);
  });
});
