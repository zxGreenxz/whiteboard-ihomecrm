// Lỗ 2 (18/10/2026): list_cashbook_closings_v1 cho mọi thành viên ACTIVE đọc số đếm/chênh lệch
// chốt sổ của MỌI sổ. Một PGlite cho cả file; mỗi ca BEGIN…ROLLBACK. Ca trước chạy thân sống
// 20260730170000 (lộ), ca sau chạy migration vá (chặn), đột biến chứng minh các phép kiểm cắn.
// ie_visible_cashbook_ids_v1 là thân THẬT của 20260924012853; chỉ ba nguồn dữ liệu của nó là giả.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const read = (name) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const FIX = read('20261018052723_chot_so_quy_chi_so_nguoi_goi_nhin_thay.sql');
const OLD = read('20260730170000_cashbook_closing_ritual.sql');
const VISIBLE = read('20260924012853_chu_cong_ty_doc_moi_so_quy.sql');

function fn(sql, name) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  const tag = sql.slice(start).match(/AS (\$[a-z_]*\$)/)?.[1];
  const open = tag ? sql.indexOf(tag, start) : -1;
  const close = open < 0 ? -1 : sql.indexOf(`${tag};`, open + tag.length);
  if (start < 0 || close < 0) throw new Error(`không thấy ${name}`);
  return sql.slice(start, close + tag.length + 1);
}
const LIST = 'public.list_cashbook_closings_v1';

const org = 'a0000000-0000-4000-8000-000000000001';
const viewer = 'c0000000-0000-4000-8000-000000000001';
const keeper = 'c0000000-0000-4000-8000-000000000002';
const peer = 'c0000000-0000-4000-8000-000000000003';
const former = 'c0000000-0000-4000-8000-000000000004'; // một bên của việc chốt, đã rời công ty
const mine = 'b0000000-0000-4000-8000-000000000001'; // sổ viewer làm chủ
const theirs = 'b0000000-0000-4000-8000-000000000002'; // sổ của keeper, viewer không giữ
const id = (n) => `e0000000-0000-4000-8000-00000000000${n}`;

let db;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.accounts(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, name text, deleted_at timestamptz);
    CREATE TABLE public.profiles(id uuid PRIMARY KEY, full_name text);
    CREATE TABLE public.organization_memberships(user_id uuid, organization_id uuid, status text);
    CREATE TABLE app_private.cashbook_closure_requests(id uuid PRIMARY KEY, organization_id uuid, cashbook_id uuid, status text,
      closed_through date, counted_balance numeric, system_balance numeric, note text, created_at timestamptz,
      proposed_by uuid, confirmer_user_id uuid);
    CREATE TABLE app_private.cashbook_closures(id uuid PRIMARY KEY, organization_id uuid, cashbook_id uuid, closed_through date,
      counted_balance numeric, system_balance numeric, basis text, confirmed_at timestamptz, proposed_by uuid, confirmed_by uuid);
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.super', true) = 'true' $$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
      SELECT coalesce(array_agg(organization_id), '{}') FROM public.organization_memberships WHERE user_id = auth.uid() AND status = 'ACTIVE' $$;
    CREATE FUNCTION app_private.my_possessed_cashbook_ids_v1() RETURNS SETOF uuid LANGUAGE sql STABLE AS $$
      SELECT unnest(coalesce(string_to_array(nullif(current_setting('test.possessed', true), ''), ',')::uuid[], '{}')) $$;
    CREATE FUNCTION app_private.my_company_owner_org_ids_v1() RETURNS SETOF uuid LANGUAGE sql STABLE AS $$
      SELECT unnest(coalesce(string_to_array(nullif(current_setting('test.owner_orgs', true), ''), ',')::uuid[], '{}')) $$;
    GRANT USAGE ON SCHEMA public, auth, app_private TO authenticated;
    INSERT INTO accounts VALUES ('${mine}', '${org}', '${viewer}', 'Sổ của tôi', null), ('${theirs}', '${org}', '${keeper}', 'Sổ người khác', null);
    INSERT INTO profiles VALUES ('${viewer}', 'Người xem'), ('${keeper}', 'Thủ quỹ'), ('${peer}', 'Kế toán');
    INSERT INTO organization_memberships VALUES ('${viewer}', '${org}', 'ACTIVE'), ('${keeper}', '${org}', 'ACTIVE'), ('${peer}', '${org}', 'ACTIVE'),
      ('${former}', '${org}', 'REMOVED');
    INSERT INTO app_private.cashbook_closure_requests VALUES
      ('${id(1)}', '${org}', '${mine}', 'PENDING', current_date, 100, 90, null, now(), '${viewer}', '${peer}'),
      ('${id(2)}', '${org}', '${theirs}', 'PENDING', current_date, 500, 450, null, now(), '${keeper}', '${peer}'),
      ('${id(3)}', '${org}', '${theirs}', 'PENDING', current_date, 700, 700, null, now(), '${keeper}', '${viewer}'),
      ('${id(7)}', '${org}', '${theirs}', 'PENDING', current_date, 800, 800, null, now(), '${keeper}', '${former}');
    INSERT INTO app_private.cashbook_closures VALUES
      ('${id(4)}', '${org}', '${mine}', current_date - 3, 100, 100, 'COUNT', now(), '${viewer}', '${peer}'),
      ('${id(5)}', '${org}', '${theirs}', current_date - 2, 500, 480, 'COUNT', now(), '${keeper}', '${peer}'),
      ('${id(6)}', '${org}', '${theirs}', current_date - 1, 700, 700, 'COUNT', now(), '${keeper}', '${viewer}'),
      ('${id(8)}', '${org}', '${theirs}', current_date - 4, 800, 800, 'COUNT', now(), '${keeper}', '${former}');`);
  await db.exec(fn(VISIBLE, 'app_private.ie_visible_cashbook_ids_v1'));
  await db.exec(fn(OLD, LIST));
  await db.exec(`GRANT EXECUTE ON FUNCTION ${LIST}(uuid) TO authenticated`);
});
afterAll(async () => { await db?.close(); });

// Một ca = một giao dịch: danh tính + phạm vi giả, (tuỳ) thay thân hàm, gọi như authenticated, ROLLBACK.
async function probe({ user = viewer, possessed = '', ownerOrgs = '', superAdmin = false, cashbook = null, body = null } = {}) {
  await db.exec('BEGIN');
  try {
    if (body) await db.exec(body);
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true), set_config('test.possessed', $2, true),
      set_config('test.owner_orgs', $3, true), set_config('test.super', $4, true)`, [user, possessed, ownerOrgs, String(superAdmin)]);
    await db.exec('SET LOCAL ROLE authenticated');
    const { rows } = await db.query(`SELECT ${LIST}($1) AS out`, [cashbook]);
    const out = rows[0].out;
    return { pending: out.pending.map((r) => r.request_id).sort(), closures: out.closures.map((c) => c.closure_id).sort(), raw: out };
  } finally { await db.exec('ROLLBACK'); }
}
const all = { pending: [id(1), id(2), id(3), id(7)], closures: [id(4), id(5), id(6), id(8)] };
const scoped = { pending: [id(1), id(3)], closures: [id(4), id(6)] };

test('TRƯỚC vá: thành viên thường thấy chênh lệch chốt của sổ mình không giữ', async () => {
  const seen = await probe();
  expect({ pending: seen.pending, closures: seen.closures }).toEqual(all);
  expect(seen.raw.pending.find((r) => r.request_id === id(2))).toMatchObject({ cashbook_name: 'Sổ người khác', difference: 50 });
});

test('migration vá chạy hai lượt (idempotent), ACL chỉ authenticated', async () => {
  await db.exec(FIX);
  await db.exec(FIX);
  const { rows } = await db.query(`SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth, p.prosecdef
    FROM pg_proc p WHERE p.oid = to_regprocedure('${LIST}(uuid)')`);
  expect(rows[0]).toEqual({ anon: false, service: false, auth: true, prosecdef: true });
});

// Kỳ vọng sau vá, gom lại để đột biến dùng chung.
async function fixedHolds(body) {
  const same = (a, b) => JSON.stringify({ pending: a.pending, closures: a.closures }) === JSON.stringify(b);
  const plain = await probe({ body });
  const keeperView = await probe({ user: keeper, body });
  const possessor = await probe({ possessed: theirs, body });
  const owner = await probe({ ownerOrgs: org, body });
  const admin = await probe({ superAdmin: true, body });
  const filtered = await probe({ cashbook: theirs, body });
  const outsider = await probe({ user: 'c0000000-0000-4000-8000-0000000000ff', body });
  const formerParty = await probe({ user: former, body });
  return same(plain, scoped)
    // Thủ quỹ là chủ sổ "theirs" nên thấy sổ ấy; sổ "mine" chỉ vì không phải bên nào ⇒ ẩn.
    && same(keeperView, { pending: [id(2), id(3), id(7)], closures: [id(5), id(6), id(8)] })
    // Đã rời công ty thì ngoại lệ "một bên của việc chốt" không còn mở gì.
    && same(formerParty, { pending: [], closures: [] })
    && same(possessor, all) && same(owner, all) && same(admin, all)
    && same(filtered, { pending: [id(3)], closures: [id(6)] })
    && same(outsider, { pending: [], closures: [] });
}

test('SAU vá: chỉ sổ trong ie_visible_cashbook_ids_v1, cộng đúng hai bên của việc chốt', async () => {
  expect(await fixedHolds()).toBe(true);
});

test('chưa đăng nhập bị chặn 42501', async () => {
  await db.exec('BEGIN');
  try {
    await db.exec('SET LOCAL ROLE authenticated');
    await expect(db.query(`SELECT ${LIST}(null)`)).rejects.toThrow(/Chưa đăng nhập/);
  } finally { await db.exec('ROLLBACK'); }
});

test('đột biến: bỏ từng vế của cửa thì phép kiểm phải đỏ', async () => {
  const body = fn(FIX, LIST);
  const visible = 'r.cashbook_id IN (SELECT v.cashbook_id FROM app_private.ie_visible_cashbook_ids_v1() v)';
  const mutants = {
    'bỏ lọc sổ ở yêu cầu chờ': body.replace(visible, 'true'),
    'bỏ lọc sổ ở biên bản': body.replace('c.cashbook_id IN (SELECT v.cashbook_id FROM app_private.ie_visible_cashbook_ids_v1() v)', 'true'),
    'mở rộng ngoại lệ hai bên': body.replace('v_actor IN (r.proposed_by, r.confirmer_user_id)', 'true'),
    'bỏ ngoại lệ người xác nhận': body.replace('v_actor IN (r.proposed_by, r.confirmer_user_id)', 'v_actor = r.proposed_by'),
    'bỏ điều kiện thành viên': body.replace(/EXISTS \(\s+SELECT 1 FROM public\.organization_memberships m[\s\S]*?AND m\.status = 'ACTIVE'\)/g, 'true'),
    'thành viên OR bỏ lọc sổ': body.replaceAll("AND m.status = 'ACTIVE')", "AND m.status = 'ACTIVE') OR true"),
  };
  for (const [label, mutant] of Object.entries(mutants)) {
    expect(mutant, label).not.toBe(body);
    expect(await fixedHolds(mutant), label).toBe(false);
  }
});
