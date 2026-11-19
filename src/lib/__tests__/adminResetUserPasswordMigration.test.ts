import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Đặt lại mật khẩu cho user khác (14/11/2026): bảng nhật ký + vị ngữ quyền + cặp hàm bắt đầu/chốt
// chạy trên khung tối thiểu của các bảng quyền có ở production. Migration chạy HAI lượt (idempotent).
// Quyền mặc định giả lập Supabase (schema public/app_private tự cấp EXECUTE và quyền bảng cho
// anon/authenticated/service_role) để chứng minh các lệnh REVOKE trong migration có tác dụng thật.
const migrationSql = readFileSync('supabase/migrations/20261114094244_admin_reset_user_password_v1.sql', 'utf8');

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const orgA = id(0xa0), orgB = id(0xb0), orgD = id(0xd0);
const roleOwnerA = id(0xa1), roleCongTyA = id(0xa2), roleSaleA = id(0xa3), roleOwnerB = id(0xb1), roleOwnerD = id(0xd1);
const superU = id(1), super2 = id(2), ownerA = id(3), ownerCt = id(4), staffA = id(5), partnerA = id(6);
const suspendedA = id(7), revokedA = id(8), shareA = id(9), multiAB = id(10), staffB = id(11), lonely = id(12);
const staffOwnerRole = id(13), ownerB = id(14), ownerSuspended = id(15), demoOwner = id(16), demoStaff = id(17);
const coOwnerSuspended = id(18), coOwnerClosed = id(19), staffTenant = id(20), ownerNoRole = id(21), ownerExpired = id(22);
const coOwnerRevoked = id(23);
const ghost = id(0xdead);
const ALL_USERS = [superU, super2, ownerA, ownerCt, staffA, partnerA, suspendedA, revokedA, shareA, multiAB, staffB, lonely,
  staffOwnerRole, ownerB, ownerSuspended, demoOwner, demoStaff, coOwnerSuspended, coOwnerClosed, staffTenant, ownerNoRole, ownerExpired,
  coOwnerRevoked];

const db = new PGlite();
type Row = Record<string, unknown>;

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA app_private;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA app_private GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA app_private GRANT ALL ON TABLES TO anon,authenticated,service_role;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(nullif(current_setting('test.actor',true),''),'none')::uuid $$;
    CREATE TABLE public.profiles(id uuid PRIMARY KEY,full_name text NOT NULL);
    CREATE TABLE public.organizations(id uuid PRIMARY KEY,is_demo boolean NOT NULL DEFAULT false);
    CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);
    CREATE TABLE public.organization_memberships(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,
      user_id uuid NOT NULL,member_type text NOT NULL,status text NOT NULL DEFAULT 'ACTIVE',
      valid_from timestamptz NOT NULL DEFAULT now()-interval '1 day',valid_to timestamptz);
    CREATE TABLE public.organization_roles(id uuid PRIMARY KEY,organization_id uuid,name text,system_key text,status text);
    CREATE TABLE public.role_bindings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,membership_id uuid,
      role_id uuid,valid_from timestamptz,valid_to timestamptz);
    CREATE TABLE public.authorization_audit_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,
      actor_user_id uuid,event_type text,resource_type text,resource_id uuid,old_state jsonb,new_state jsonb,reason text,
      seq bigserial);
    -- Bản thu nhỏ của hàm ghi nhật ký thật: người ghi lấy từ auth.uid() đúng như bản production.
    CREATE FUNCTION app_private.append_authz_audit_v1(p_organization_id uuid,p_event_type text,p_resource_type text,
      p_resource_id uuid,p_old_state jsonb,p_new_state jsonb,p_reason text) RETURNS uuid LANGUAGE sql AS $$
      INSERT INTO public.authorization_audit_events(organization_id,actor_user_id,event_type,resource_type,resource_id,
        old_state,new_state,reason) VALUES($1,auth.uid(),$2,$3,$4,$5,$6,$7) RETURNING id $$;
    GRANT USAGE ON SCHEMA public,app_private,auth TO anon,authenticated,service_role;
  `);
  await db.query('INSERT INTO auth.users SELECT unnest($1::uuid[])', [ALL_USERS]);
  await db.exec(`
    INSERT INTO public.organizations VALUES('${orgA}',false),('${orgB}',false),('${orgD}',true);
    INSERT INTO public.profiles VALUES('${superU}','Siêu quản trị'),('${super2}','Siêu quản trị 2'),('${ownerA}','Chủ A'),
      ('${ownerCt}','Chủ công ty A'),('${staffA}','Nhân viên A'),('${suspendedA}','Tạm dừng A'),('${revokedA}','Đã thu hồi A'),
      ('${shareA}','Cổ đông A'),('${multiAB}','Hai công ty'),('${staffB}','Nhân viên B'),('${lonely}','Không tổ chức'),
      ('${staffOwnerRole}','Nhân viên mang vai chủ'),('${ownerB}','Chủ B'),('${ownerSuspended}','Chủ tạm dừng');
    INSERT INTO public.super_admins VALUES('${superU}'),('${super2}');
    INSERT INTO public.organization_roles VALUES('${roleOwnerA}','${orgA}','Chủ sở hữu tổ chức','TENANT_OWNER','ACTIVE'),
      ('${roleCongTyA}','${orgA}','Chủ công ty',NULL,'ACTIVE'),('${roleSaleA}','${orgA}','Sale',NULL,'ACTIVE'),
      ('${roleOwnerB}','${orgB}','Chủ công ty','TENANT_OWNER','ACTIVE'),
      ('${roleOwnerD}','${orgD}','Chủ công ty','TENANT_OWNER','ACTIVE');
  `);
  const member = async (user: string, org: string, type: string, status = 'ACTIVE', role: string | null = null, bindingValidTo: string | null = null) => {
    const m = await db.query<{ id: string }>(
      'INSERT INTO public.organization_memberships(organization_id,user_id,member_type,status) VALUES($1,$2,$3,$4) RETURNING id',
      [org, user, type, status]);
    if (role) {
      await db.query('INSERT INTO public.role_bindings(organization_id,membership_id,role_id,valid_from,valid_to) VALUES($1,$2,$3,$4,$5)',
        [org, m.rows[0].id, role, bindingValidTo ? '2026-01-01T00:00:00Z' : null, bindingValidTo]);
    }
  };
  await member(superU, orgA, 'OWNER', 'ACTIVE', roleOwnerA);
  await member(super2, orgA, 'STAFF', 'ACTIVE', roleSaleA);
  await member(ownerA, orgA, 'OWNER', 'ACTIVE', roleOwnerA);
  await member(ownerCt, orgA, 'OWNER', 'ACTIVE', roleCongTyA); // vai chủ chỉ theo TÊN (system_key NULL)
  await member(staffA, orgA, 'STAFF', 'ACTIVE', roleSaleA);
  await member(partnerA, orgA, 'PARTNER');
  await member(suspendedA, orgA, 'STAFF', 'SUSPENDED', roleSaleA);
  await member(revokedA, orgA, 'STAFF', 'REVOKED', roleSaleA);
  await member(shareA, orgA, 'SHAREHOLDER');
  await member(multiAB, orgA, 'STAFF', 'ACTIVE', roleSaleA);
  await member(multiAB, orgB, 'STAFF');
  await member(staffB, orgB, 'STAFF');
  await member(staffOwnerRole, orgA, 'STAFF', 'ACTIVE', roleCongTyA); // vai thường đổi tên thành "Chủ công ty"
  await member(ownerB, orgB, 'OWNER', 'ACTIVE', roleOwnerB);
  await member(ownerSuspended, orgA, 'OWNER', 'SUSPENDED', roleOwnerA);
  await member(demoOwner, orgD, 'OWNER', 'ACTIVE', roleOwnerD);
  await member(demoStaff, orgD, 'STAFF');
  await member(coOwnerSuspended, orgA, 'STAFF', 'SUSPENDED', roleOwnerA); // đồng chủ chỉ theo vai, đang bị tạm dừng
  await member(coOwnerClosed, orgA, 'STAFF', 'ACTIVE', roleOwnerA, '2026-02-01T00:00:00Z'); // vai chủ đã bị đóng hạn
  await member(staffTenant, orgA, 'STAFF', 'ACTIVE', roleOwnerA); // vai chủ còn hạn nhưng loại STAFF
  await member(ownerNoRole, orgA, 'OWNER', 'ACTIVE', roleSaleA); // loại OWNER nhưng không có vai chủ
  await member(ownerExpired, orgA, 'OWNER', 'ACTIVE', roleOwnerA, '2026-02-01T00:00:00Z'); // vai chủ đã hết hạn
  // Đồng chủ có HAI tư cách trong cùng công ty: tư cách mang vai chủ đã bị thu hồi, tư cách kia là nhân viên.
  await member(coOwnerRevoked, orgA, 'STAFF', 'REVOKED', roleOwnerA);
  await member(coOwnerRevoked, orgA, 'STAFF', 'ACTIVE', roleSaleA);
  await db.exec(migrationSql);
  await db.exec(migrationSql);
}, 30000);

beforeEach(async () => {
  await db.exec(`RESET ROLE;SELECT set_config('test.actor','',false);
    DELETE FROM app_private.user_password_resets;DELETE FROM public.authorization_audit_events;`);
});
afterAll(async () => { await db.close(); });

async function as(user: string) { await db.query("SELECT set_config('test.actor',$1,false)", [user]); }
async function decide(actor: string | null, target: string | null): Promise<Row> {
  return (await db.query<{ r: Row }>('SELECT app_private.user_password_reset_decision_v1($1,$2) r', [actor, target])).rows[0].r;
}
/** Gọi đúng như edge: vai authenticated, auth.uid() = người bấm. */
async function asUser<T>(user: string, sql: string, params: unknown[] = []): Promise<T> {
  await as(user);
  await db.exec('SET ROLE authenticated');
  try {
    return (await db.query<{ r: T }>(sql, params)).rows[0].r;
  } finally { await db.exec('RESET ROLE'); }
}
type Begun = { requestId: string; via: string; finishToken: string };
const begin = (user: string, target: string | null) =>
  asUser<Begun>(user, 'SELECT public.user_password_reset_begin_v1($1) r', [target]);
const finish = (user: string, b: Pick<Begun, 'requestId' | 'finishToken'>, outcome: string, errorCode: string | null = null) =>
  asUser<Row>(user, 'SELECT public.user_password_reset_finish_v1($1,$2,$3,$4) r', [b.requestId, b.finishToken, outcome, errorCode]);
async function deny(fn: () => Promise<unknown>, code: string, message?: RegExp) {
  const e = await fn().then(() => null, (err: unknown) => err as { code?: string; message?: string });
  expect(e, 'phải bị từ chối').not.toBeNull();
  expect(e?.code).toBe(code);
  if (message) expect(e?.message).toMatch(message);
}
async function rows(sql: string, params: unknown[] = []) { return (await db.query<Row>(sql, params)).rows; }
const events = () => rows('SELECT organization_id,actor_user_id,event_type,resource_type,resource_id,old_state,new_state,reason FROM public.authorization_audit_events ORDER BY seq');

describe('vị ngữ user_password_reset_decision_v1', () => {
  it('superadmin: mọi user trừ chính mình và tài khoản không tồn tại; kể cả chủ, cổ đông, người hai công ty, demo', async () => {
    for (const t of [staffA, ownerA, shareA, super2, revokedA, coOwnerSuspended]) {
      expect(await decide(superU, t)).toMatchObject({ allowed: true, via: 'SUPER_ADMIN' });
    }
    expect(await decide(superU, multiAB)).toEqual({ allowed: true, via: 'SUPER_ADMIN', organizationIds: [orgA, orgB] });
    expect(await decide(superU, demoStaff)).toEqual({ allowed: true, via: 'SUPER_ADMIN', organizationIds: [orgD] });
    expect(await decide(superU, lonely)).toEqual({ allowed: true, via: 'SUPER_ADMIN', organizationIds: [] });
    expect(await decide(superU, revokedA)).toEqual({ allowed: true, via: 'SUPER_ADMIN', organizationIds: [] });
    expect(await decide(superU, ghost)).toEqual({ allowed: false, reason: 'TARGET_NOT_FOUND' });
    expect(await decide(superU, superU)).toEqual({ allowed: false, reason: 'SELF' });
  });

  it('chủ công ty (loại OWNER + vai hệ thống TENANT_OWNER còn hạn): nhân viên, cộng tác viên, người đang tạm dừng', async () => {
    for (const t of [staffA, partnerA, suspendedA]) {
      expect(await decide(ownerA, t)).toEqual({ allowed: true, via: 'COMPANY_OWNER', organizationIds: [orgA] });
    }
    // Vai TENANT_OWNER mang tên "Chủ công ty" (như công ty demo, công ty B) vẫn là chủ: khớp system_key, không khớp tên.
    expect(await decide(ownerB, staffB)).toEqual({ allowed: true, via: 'COMPANY_OWNER', organizationIds: [orgB] });
  });

  it('chủ chỉ theo TÊN vai hoặc chỉ theo loại thành viên KHÔNG phải chủ ở cửa này', async () => {
    // Vai tên "Chủ công ty" system_key NULL đổi tên được qua upsert_organization_role_v1 ⇒ không tính.
    for (const actor of [ownerCt, staffOwnerRole, staffTenant, ownerNoRole, coOwnerClosed, ownerExpired]) {
      expect(await decide(actor, staffA), actor).toEqual({ allowed: false, reason: 'NOT_ADMIN' });
    }
  });

  it('chủ công ty KHÔNG chạm được: người ngoài công ty, người dính công ty khác, demo, chủ (xét rộng), cổ đông, superadmin', async () => {
    const cases: Array<[string, string, string]> = [
      [ownerA, staffB, 'TARGET_OUTSIDE_ORG'],
      [ownerA, multiAB, 'TARGET_OUTSIDE_ORG'],
      [ownerB, multiAB, 'TARGET_OUTSIDE_ORG'],
      [ownerA, lonely, 'TARGET_OUTSIDE_ORG'],
      [ownerA, revokedA, 'TARGET_OUTSIDE_ORG'],
      [ownerA, ghost, 'TARGET_OUTSIDE_ORG'],
      [ownerA, ownerB, 'TARGET_OUTSIDE_ORG'],
      [ownerA, demoStaff, 'TARGET_OUTSIDE_ORG'],
      // Mật khẩu chủ demo công khai trên trang Sandbox ⇒ chủ demo không đặt lại được cho ai trong demo.
      [demoOwner, demoStaff, 'TARGET_DEMO_ORG'],
      [ownerA, ownerCt, 'TARGET_OWNER'],
      [ownerA, staffOwnerRole, 'TARGET_OWNER'],
      [ownerA, ownerSuspended, 'TARGET_OWNER'],
      // Đồng chủ chỉ theo vai: tạm dừng tư cách hay đóng hạn vai đều không mở được cửa.
      [ownerA, coOwnerSuspended, 'TARGET_OWNER'],
      [ownerA, coOwnerClosed, 'TARGET_OWNER'],
      [ownerA, coOwnerRevoked, 'TARGET_OWNER'],
      [ownerA, staffTenant, 'TARGET_OWNER'],
      [ownerA, ownerNoRole, 'TARGET_OWNER'],
      [ownerA, shareA, 'TARGET_SHAREHOLDER'],
      [ownerA, superU, 'TARGET_SUPER_ADMIN'],
      [ownerA, super2, 'TARGET_SUPER_ADMIN'],
      [ownerA, ownerA, 'SELF'],
    ];
    for (const [actor, target, reason] of cases) {
      expect(await decide(actor, target), `${actor} → ${target}`).toEqual({ allowed: false, reason });
    }
  });

  it('người không phải superadmin/chủ công ty (kể cả chủ đang tạm dừng) không đặt lại được cho ai', async () => {
    for (const actor of [staffA, partnerA, staffB, ownerSuspended, lonely, ghost]) {
      expect(await decide(actor, suspendedA)).toEqual({ allowed: false, reason: 'NOT_ADMIN' });
    }
    expect(await decide(null, staffA)).toEqual({ allowed: false, reason: 'NO_ACTOR' });
    expect(await decide(ownerA, null)).toEqual({ allowed: false, reason: 'NO_TARGET' });
  });
});

describe('ACL', () => {
  it('trình duyệt chỉ gọi được begin/finish; anon và service_role không; bảng và vị ngữ khoá kín dù có quyền mặc định', async () => {
    const acl = await rows(`SELECT r.rolname role,
        has_function_privilege(r.rolname,'public.user_password_reset_begin_v1(uuid)','EXECUTE') b,
        has_function_privilege(r.rolname,'public.user_password_reset_finish_v1(uuid,text,text,text)','EXECUTE') f,
        to_regprocedure('public.user_password_reset_finish_v1(uuid,text,text)') IS NULL khong_con_ban_nhap,
        has_function_privilege(r.rolname,'app_private.user_password_reset_decision_v1(uuid,uuid)','EXECUTE') d,
        has_function_privilege(r.rolname,'app_private.user_password_reset_is_owner_v1(uuid,uuid)','EXECUTE') o,
        has_table_privilege(r.rolname,'app_private.user_password_resets','SELECT') s,
        has_table_privilege(r.rolname,'app_private.user_password_resets','INSERT') i
      FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role') ORDER BY 1`);
    expect(acl).toEqual([
      { role: 'anon', b: false, f: false, khong_con_ban_nhap: true, d: false, o: false, s: false, i: false },
      { role: 'authenticated', b: true, f: true, khong_con_ban_nhap: true, d: false, o: false, s: false, i: false },
      { role: 'service_role', b: false, f: false, khong_con_ban_nhap: true, d: false, o: false, s: false, i: false },
    ]);
    await as(ownerA);
    await db.exec('SET ROLE anon');
    try {
      await deny(() => db.query('SELECT public.user_password_reset_begin_v1($1)', [staffA]), '42501', /permission denied/);
    } finally { await db.exec('RESET ROLE'); }
  });
});

describe('user_password_reset_begin_v1', () => {
  it('chủ công ty bắt đầu: dòng PENDING + sự kiện nhật ký phân quyền NGAY trong cùng transaction', async () => {
    const r = await begin(ownerA, staffA);
    expect(r).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), via: 'COMPANY_OWNER', finishToken: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await rows('SELECT actor_user_id,target_user_id,target_name,via,organization_ids,status,error_code,finished_at FROM app_private.user_password_resets'))
      .toEqual([{ actor_user_id: ownerA, target_user_id: staffA, target_name: 'Nhân viên A', via: 'COMPANY_OWNER',
        organization_ids: [orgA], status: 'PENDING', error_code: null, finished_at: null }]);
    // Bảng chỉ giữ SHA-256 của mã chốt, không giữ mã; nhật ký phân quyền không chứa mã.
    expect(await rows("SELECT finish_token_hash = sha256(convert_to($1,'UTF8')) khop, encode(finish_token_hash,'hex') <> $1 khac FROM app_private.user_password_resets", [r.finishToken]))
      .toEqual([{ khop: true, khac: true }]);
    expect(JSON.stringify(await events())).not.toContain(r.finishToken);
    expect(await events()).toEqual([{ organization_id: orgA, actor_user_id: ownerA, event_type: 'USER_PASSWORD_RESET',
      resource_type: 'USER', resource_id: staffA, old_state: null, reason: null,
      new_state: { via: 'COMPANY_OWNER', targetName: 'Nhân viên A', requestId: r.requestId } }]);
    // Không có hồ sơ ⇒ tên "Không tên", không lỗi NOT NULL.
    await begin(ownerA, partnerA);
    expect(await rows(`SELECT target_name FROM app_private.user_password_resets WHERE target_user_id='${partnerA}'`))
      .toEqual([{ target_name: 'Không tên' }]);
  });

  it('superadmin đổi người hai công ty ⇒ mỗi công ty một sự kiện; người không tổ chức ⇒ chỉ dòng nhật ký riêng', async () => {
    await begin(superU, multiAB);
    expect((await events()).map((e) => [e.organization_id, e.actor_user_id])).toEqual([[orgA, superU], [orgB, superU]]);
    await db.exec('DELETE FROM public.authorization_audit_events');
    await begin(superU, lonely);
    expect(await events()).toEqual([]);
  });

  it('từ chối: không quyền 42501; tự đổi 22023; thiếu phiên 42501; tài khoản lạ chỉ superadmin thấy 22023; không ghi gì', async () => {
    await deny(() => begin(staffA, partnerA), '42501', /không có quyền/);
    await deny(() => begin(ownerCt, staffA), '42501', /không có quyền/);
    await deny(() => begin(ownerA, multiAB), '42501', /không có quyền/);
    await deny(() => begin(ownerA, shareA), '42501', /không có quyền/);
    await deny(() => begin(ownerA, superU), '42501', /không có quyền/);
    await deny(() => begin(ownerA, coOwnerSuspended), '42501', /không có quyền/);
    await deny(() => begin(demoOwner, demoStaff), '42501', /không có quyền/);
    await deny(() => begin(ownerA, ownerA), '22023', /trang Hồ sơ/);
    await deny(() => begin(ownerA, null as unknown as string), '22023');
    await deny(() => begin('none', staffA), '42501', /Phiên đăng nhập/);
    await deny(() => begin(ownerA, ghost), '42501', /không có quyền/);
    await deny(() => begin(superU, ghost), '22023', /Không tìm thấy/);
    expect(await rows('SELECT 1 FROM app_private.user_password_resets')).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it('giới hạn: 5 lần/10 phút mỗi người bị đổi (chỉ với chủ công ty), 10 lần/10 phút mỗi người bấm; lần cũ hơn 10 phút không tính', async () => {
    await db.exec(`INSERT INTO app_private.user_password_resets(actor_user_id,target_user_id,target_name,via,requested_at,status,finished_at)
      SELECT '${superU}','${staffA}','x','SUPER_ADMIN',now()-interval '1 minute','SUCCEEDED',now() FROM generate_series(1,4);
      INSERT INTO app_private.user_password_resets(actor_user_id,target_user_id,target_name,via,requested_at,status,finished_at)
      SELECT '${superU}','${staffA}','x','SUPER_ADMIN',now()-interval '11 minutes','SUCCEEDED',now() FROM generate_series(1,20);`);
    await begin(ownerA, staffA);
    await deny(() => begin(ownerA, staffA), '54000', /quá nhiều lần/);
    await begin(ownerA, partnerA);
    // Hạn mức của người bị đổi đã cạn vẫn không chặn superadmin cứu tài khoản đó.
    await begin(superU, staffA);

    await db.exec(`DELETE FROM app_private.user_password_resets;
      INSERT INTO app_private.user_password_resets(actor_user_id,target_user_id,target_name,via,requested_at)
      SELECT '${ownerA}',t,'x','COMPANY_OWNER',now()-interval '2 minutes'
        FROM unnest(ARRAY['${staffA}','${partnerA}','${suspendedA}']::uuid[]) t, generate_series(1,3);`);
    await begin(ownerA, staffA);
    await deny(() => begin(ownerA, partnerA), '54000', /quá nhiều lần/);
    await begin(superU, partnerA);
  });
});

describe('user_password_reset_finish_v1', () => {
  it('SUCCEEDED: chốt dòng, không ghi thêm sự kiện (đã ghi lúc bắt đầu); gọi lại cùng kết quả trả nguyên; khác kết quả 55000', async () => {
    const b = await begin(ownerA, staffA);
    const { requestId } = b;
    expect(await finish(ownerA, b, 'SUCCEEDED')).toEqual({ requestId, status: 'SUCCEEDED', auditEvents: 0 });
    expect(await rows('SELECT status,error_code,finished_at IS NOT NULL done FROM app_private.user_password_resets'))
      .toEqual([{ status: 'SUCCEEDED', error_code: null, done: true }]);
    expect((await events()).map((e) => e.event_type)).toEqual(['USER_PASSWORD_RESET']);
    expect(await finish(ownerA, b, 'SUCCEEDED')).toEqual({ requestId, status: 'SUCCEEDED', auditEvents: 0 });
    await deny(() => finish(ownerA, b, 'FAILED'), '55000', /đã chốt/);
    expect(await events()).toHaveLength(1);
  });

  it('người bấm đọc requestId trong nhật ký rồi tự chốt FAILED trước edge ⇒ không được (thiếu/sai mã chốt)', async () => {
    const b = await begin(ownerA, staffA);
    const tuNhatKy = (await events())[0].new_state as { requestId: string };
    expect(tuNhatKy.requestId).toBe(b.requestId);
    const khac = await begin(ownerA, partnerA);
    for (const token of ['', 'a'.repeat(64), b.finishToken.toUpperCase(), khac.finishToken]) {
      await deny(() => finish(ownerA, { requestId: tuNhatKy.requestId, finishToken: token }, 'FAILED', 'weak_password'), '42501', /Không tìm thấy yêu cầu/);
    }
    await deny(() => asUser(ownerA, 'SELECT public.user_password_reset_finish_v1($1,NULL,$2) r', [b.requestId, 'FAILED']), '42501', /Không tìm thấy yêu cầu/);
    expect(await rows(`SELECT status FROM app_private.user_password_resets WHERE id='${b.requestId}'`)).toEqual([{ status: 'PENDING' }]);
    expect((await events()).map((e) => e.event_type)).toEqual(['USER_PASSWORD_RESET', 'USER_PASSWORD_RESET']);
    // Edge (cầm đúng mã) vẫn chốt được.
    expect(await finish(ownerA, b, 'SUCCEEDED')).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('FAILED ghi thêm dòng đính chính kèm mã lỗi; UNKNOWN để nguyên dòng đã có', async () => {
    const a = await begin(ownerA, staffA);
    expect(await finish(ownerA, a, 'FAILED', 'weak_password')).toMatchObject({ status: 'FAILED', auditEvents: 1 });
    expect(await rows('SELECT status,error_code FROM app_private.user_password_resets')).toEqual([{ status: 'FAILED', error_code: 'weak_password' }]);
    expect((await events()).map((e) => [e.event_type, e.actor_user_id, e.new_state])).toEqual([
      ['USER_PASSWORD_RESET', ownerA, { via: 'COMPANY_OWNER', targetName: 'Nhân viên A', requestId: a.requestId }],
      ['USER_PASSWORD_RESET_FAILED', ownerA, { via: 'COMPANY_OWNER', targetName: 'Nhân viên A', requestId: a.requestId, errorCode: 'weak_password' }],
    ]);
    await db.exec('DELETE FROM public.authorization_audit_events');
    const b = await begin(ownerA, partnerA);
    expect(await finish(ownerA, b, 'UNKNOWN', 'auth_timeout')).toMatchObject({ status: 'UNKNOWN', auditEvents: 0 });
    expect((await events()).map((e) => e.event_type)).toEqual(['USER_PASSWORD_RESET']);
  });

  it('không chốt hộ người khác (kể cả cầm đúng mã), không nhận kết quả hay mã lỗi lạ, không chạy khi thiếu phiên', async () => {
    const b = await begin(ownerA, staffA);
    await deny(() => finish(staffA, b, 'SUCCEEDED'), '42501', /Không tìm thấy yêu cầu/);
    await deny(() => finish(superU, b, 'SUCCEEDED'), '42501', /Không tìm thấy yêu cầu/);
    await deny(() => finish(ownerA, b, 'DONE'), '22023');
    await deny(() => finish(ownerA, b, 'FAILED', 'Bad Code'), '22023');
    await deny(() => finish('none', b, 'SUCCEEDED'), '42501', /Phiên đăng nhập/);
    expect(await rows('SELECT status FROM app_private.user_password_resets')).toEqual([{ status: 'PENDING' }]);
  });
});
