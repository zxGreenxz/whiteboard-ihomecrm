import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

// Đợt 10c: «Đã kiểm» phiếu thu chi thành ĐẶT GIÁ TRỊ — verify_income_expense_v1 nhận p_verified DEFAULT NULL. Chạy THẬT
// thân verify_income_expense_v1 và verify_income_expense đang sống ngay trước migration (thân trong repo = thân production,
// md5 prosrc 96dee08a… / 39fd5648…) trên một ma trận lời gọi kiểu cũ, rồi áp nguyên tệp migration HAI lượt và chạy lại
// đúng ma trận đó: từng nhánh phải cho cùng kết quả, cùng dòng ghi, cùng nhật ký. PGlite chỉ có một kết nối: hai phiên
// song song cùng phiếu thử trên project TEST (mô tả PR).
const MIG_DIR = 'supabase/migrations';
const MIGRATION_FILE = '20261126202634_da_kiem_dat_gia_tri.sql';
const migrationSql = readFileSync(`supabase/migrations/${MIGRATION_FILE}`, 'utf8').replace(/\r\n/g, '\n');

/** Lần CREATE cuối cùng của một hàm ở các tệp migration TRƯỚC tệp này (định nghĩa đang chạy khi tệp này áp). */
function liveBefore(name: string): string {
  const head = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${name.replace('.', '\\.')}\\s*\\(`, 'i');
  let sql = '';
  for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql') && x < MIGRATION_FILE).sort()) {
    const text = readFileSync(join(MIG_DIR, f), 'utf8').replace(/\r\n/g, '\n');
    let from = 0;
    for (;;) {
      const m = text.slice(from).match(head);
      if (!m || m.index === undefined) break;
      const start = from + m.index;
      const tag = text.slice(start).match(/\bAS\s+(\$[A-Za-z_]*\$)/i);
      if (!tag || tag.index === undefined) break;
      const bodyStart = start + tag.index + tag[0].length;
      const end = text.indexOf(tag[1], bodyStart);
      const stop = end < 0 ? -1 : text.indexOf(';', end + tag[1].length);
      if (stop < 0) break;
      sql = text.slice(start, stop + 1);
      from = stop + 1;
    }
  }
  if (!sql) throw new Error(`Không thấy định nghĩa trước của ${name}`);
  return sql;
}

// Thân production (đọc 26/11/2026 bằng pg_get_functiondef) của hai hàm mà verify_income_expense_v1 gọi, không có ở tệp
// migration nào (dựng trước mốc cắt): ghi nhật ký chuỗi băm (md5 prosrc b99ed83a…) và tên người thao tác (e99a33a8…).
const APPEND_EVENT = String.raw`CREATE OR REPLACE FUNCTION app_private.append_income_expense_event_v1(p_organization_id uuid, p_income_expense_id uuid, p_action text, p_actor_id uuid, p_actor_name text, p_old_status text, p_new_status text, p_note text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
declare
  v_head app_private.income_expense_audit_chain_heads;
  v_seq bigint;
  v_canonical text;
  v_hash text;
  v_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_organization_id is null or p_income_expense_id is null
     or p_action is null or p_actor_id is null then
    raise exception 'append_income_expense_event_v1: required argument NULL'
      using errcode = '22004';
  end if;

  -- F5: bootstrap + lock. Head is the last lock taken before the INSERT.
  insert into app_private.income_expense_audit_chain_heads (organization_id)
  values (p_organization_id)
  on conflict (organization_id) do nothing;

  select * into v_head
    from app_private.income_expense_audit_chain_heads
   where organization_id = p_organization_id
   for update;

  v_seq := v_head.last_sequence_no + 1;

  -- F2/F3 canonical serialization (byte-level pinned):
  --   fields joined by \x1f, timestamps rendered UTC ISO-8601 fixed format,
  --   NULLs rendered as empty string, preimage prefixed with org + seq +
  --   prev hash. No jsonb round-trip → no numeric/TZ instability.
  v_canonical := concat_ws(chr(31),
    'PG_SHA256_CANONICAL_V1',
    p_organization_id::text,
    v_seq::text,
    v_head.last_event_hash,
    p_income_expense_id::text,
    p_action,
    p_actor_id::text,
    coalesce(p_actor_name, ''),
    coalesce(p_old_status, ''),
    coalesce(p_new_status, ''),
    coalesce(p_note, ''),
    to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));

  v_hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  insert into public.income_expense_audit_log (
    income_expense_id, action, actor_id, actor_name,
    old_status, new_status, note, organization_id,
    sequence_no, prev_event_hash, event_hash, hash_scheme, created_at)
  values (
    p_income_expense_id, p_action, p_actor_id, p_actor_name,
    p_old_status, p_new_status, p_note, p_organization_id,
    v_seq, v_head.last_event_hash, v_hash, 'PG_SHA256_CANONICAL_V1', v_now)
  returning id into v_id;

  update app_private.income_expense_audit_chain_heads
     set last_sequence_no = v_seq,
         last_event_hash = v_hash,
         updated_at = v_now
   where organization_id = p_organization_id;

  return v_id;
end;
$function$;`;
const ACTOR_NAME = `CREATE OR REPLACE FUNCTION app_private.ie_actor_display_name_v1(p_actor uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
  select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), ''),
                  u.email, 'Người dùng')
    from auth.users u
    left join public.profiles p on p.id = u.id
   where u.id = p_actor;
$function$;`;

const org = '00000000-0000-4000-8000-000000000001';
const staff = '00000000-0000-4000-8000-000000000002';
const staff2 = '00000000-0000-4000-8000-000000000003';
const outsider = '00000000-0000-4000-8000-000000000004';
const boss = '00000000-0000-4000-8000-000000000005';
const building = '00000000-0000-4000-8000-000000000011';
const building2 = '00000000-0000-4000-8000-000000000012';
const account = '00000000-0000-4000-8000-000000000021';
const missing = '00000000-0000-4000-8000-0000000000ff';
// Phiếu: canonical chưa kiểm / đã kiểm bởi staff / đã kiểm bởi staff2 / ngoài toà nhưng staff giữ sổ; đường cũ (không
// flow-owned) chưa kiểm / đã kiểm bởi staff / đã kiểm bởi staff2; canonical ở toà staff không vào được.
const V = {
  open: '00000000-0000-4000-8000-000000000101',
  mine: '00000000-0000-4000-8000-000000000102',
  theirs: '00000000-0000-4000-8000-000000000103',
  possessed: '00000000-0000-4000-8000-000000000104',
  legacyOpen: '00000000-0000-4000-8000-000000000201',
  legacyMine: '00000000-0000-4000-8000-000000000202',
  legacyTheirs: '00000000-0000-4000-8000-000000000203',
  hidden: '00000000-0000-4000-8000-000000000301',
} as const;

const db = new PGlite();
type Row = Record<string, unknown>;

async function one(sql: string, params: unknown[] = []): Promise<Row> {
  return (await db.query<Row>(sql, params)).rows[0];
}
async function all(sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(sql, params)).rows;
}

/** Mỗi ca một transaction, luôn ROLLBACK — các ca không dẫm dữ liệu của nhau. */
async function rollback<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN');
  try {
    return await fn();
  } finally {
    await db.exec('ROLLBACK');
  }
}

/** Gọi như PostgREST: vai authenticated, auth.uid() = người gọi (null = chưa đăng nhập). Lỗi trả về {code, message}. */
async function asUser(actor: string | null, sql: string, params: unknown[] = []): Promise<Row> {
  await db.exec('SAVEPOINT goi');
  await db.exec(`SET LOCAL ROLE authenticated; SELECT set_config('test.actor','${actor ?? ''}',true);`);
  try {
    const r = await one(sql, params);
    await db.exec('RESET ROLE; RELEASE SAVEPOINT goi');
    return r;
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT goi; RESET ROLE; RELEASE SAVEPOINT goi');
    const e = error as { code?: string; message?: string };
    return { error: { code: e.code, message: e.message } };
  }
}

/** Lời gọi kiểu cũ (bundle trình duyệt trước đợt 10c): chỉ p_id, p_note — hoặc chỉ p_id khi bỏ ghi chú. */
const oldCall = (actor: string | null, id: string, note?: string | null) =>
  note === undefined
    ? asUser(actor, 'SELECT public.verify_income_expense_v1(p_id => $1::uuid) AS r', [id])
    : asUser(actor, 'SELECT public.verify_income_expense_v1(p_id => $1::uuid, p_note => $2) AS r', [id, note]);
/** Lời gọi của trình duyệt mới: giá trị muốn đặt. */
const setCall = async (actor: string | null, id: string, verified: boolean, note: string | null = null) => {
  const r = await asUser(actor, 'SELECT public.verify_income_expense_v1(p_id => $1::uuid, p_note => $2, p_verified => $3) AS r', [id, note, verified]);
  return ('error' in r ? r : r.r) as Row;
};

/** Trạng thái quan sát được của một phiếu: cột đã kiểm, nhật ký chuỗi băm, số lần UPDATE thật, quyền tạm còn sót. */
async function observe(id: string) {
  const row = await one(`SELECT verified_at IS NOT NULL AS verified, verified_by, verified_by_name, verified_note
    FROM public.income_expenses WHERE id = $1`, [id]);
  const events = await all(`SELECT action, actor_id, actor_name, old_status, new_status, note, sequence_no
    FROM public.income_expense_audit_log WHERE income_expense_id = $1 ORDER BY sequence_no`, [id]);
  const updates = Number((await one('SELECT count(*)::int AS n FROM test_updates WHERE id = $1', [id])).n);
  const leftover = Number((await one('SELECT count(*)::int AS n FROM app_private.ie_transition_authorization')).n);
  return { row: row ?? null, events, updates, leftover };
}
/** Kết quả trả về của hàm cũ (void) và của hàm mới khi gọi kiểu cũ (NULL) đều là «không có giá trị». */
const normalize = (r: Row) => ('error' in r ? { error: r.error } : { r: r.r === '' || r.r === undefined ? null : r.r });

/** Ma trận lời gọi kiểu cũ, mỗi ca trên dữ liệu gốc (ROLLBACK). Chạy trước và sau migration, phải ra y hệt. */
const OLD_MATRIX: [string, () => Promise<Row>, string][] = [
  ['canonical chưa kiểm: staff đánh dấu kèm ghi chú', () => oldCall(staff, V.open, '  đã đối chiếu sao kê  '), V.open],
  ['canonical chưa kiểm: bỏ ghi chú (chỉ p_id)', () => oldCall(staff, V.open), V.open],
  ['canonical staff tự kiểm: staff bấm lần nữa ⇒ bỏ kiểm', () => oldCall(staff, V.mine, null), V.mine],
  ['canonical người khác kiểm: staff bấm ⇒ từ chối', () => oldCall(staff, V.theirs, null), V.theirs],
  ['canonical người khác kiểm: super admin bấm ⇒ bỏ kiểm', () => oldCall(boss, V.theirs, null), V.theirs],
  ['phiếu đường cũ ⇒ 55000 «dùng đường legacy»', () => oldCall(staff, V.legacyOpen, null), V.legacyOpen],
  ['người không xem được phiếu ⇒ 42501', () => oldCall(outsider, V.open, null), V.open],
  ['toà không vào được, không giữ sổ ⇒ 42501', () => oldCall(staff, V.hidden, null), V.hidden],
  ['ngoài toà nhưng giữ sổ của phiếu ⇒ đánh dấu được', () => oldCall(staff, V.possessed, 'giữ sổ'), V.possessed],
  ['chưa đăng nhập ⇒ 42501', () => oldCall(null, V.open, null), V.open],
  ['không có phiếu', () => oldCall(staff, missing, null), missing],
];
async function runOldMatrix() {
  const out: Record<string, unknown> = {};
  for (const [label, call, id] of OLD_MATRIX) {
    out[label] = await rollback(async () => ({ result: normalize(await call()), after: await observe(id) }));
  }
  // Bấm hai lần liền kiểu cũ: đảo hai lần (đúng hành vi nút bật/tắt cũ).
  out['bấm hai lần kiểu cũ'] = await rollback(async () => {
    const first = normalize(await oldCall(staff, V.open, 'lần một'));
    const second = normalize(await oldCall(staff, V.open, 'lần hai'));
    return { first, second, after: await observe(V.open) };
  });
  return out;
}

const md5Of = async (fn: string) =>
  (await one(`SELECT md5(replace(prosrc, chr(13), '')) AS m FROM pg_proc WHERE oid = to_regprocedure('${fn}')`))?.m as string | null;

let oldMatrix: Record<string, unknown>;
const liveMd5: Record<string, string | null> = {};
let firstApply: unknown;
let secondApply: unknown;

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    GRANT USAGE ON SCHEMA auth TO anon, service_role, authenticated; GRANT USAGE ON SCHEMA app_private TO anon, service_role, authenticated;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('test.actor', true), '')::uuid $$;
    CREATE TABLE auth.users(id uuid, email text, PRIMARY KEY (id));
    CREATE TABLE public.profiles(id uuid, full_name text, email text, PRIMARY KEY (id));
    CREATE TABLE public.income_expenses(
      id uuid, organization_id uuid, code text, building_id uuid, account_id uuid,
      approval_status text NOT NULL DEFAULT 'APPROVED', verified_at timestamptz, verified_by uuid,
      verified_by_name text, verified_note text, PRIMARY KEY (id));
    CREATE TABLE app_private.income_expense_flow_ownership(income_expense_id uuid, organization_id uuid, PRIMARY KEY (income_expense_id));
    CREATE TABLE app_private.ie_flex_writer_xids(income_expense_id uuid, scope text, transaction_id xid8, backend_pid integer);
    CREATE TABLE app_private.ie_transition_authorization(income_expense_id uuid, xid xid8, purpose text, granted_at timestamptz DEFAULT now());
    CREATE TABLE app_private.income_expense_audit_chain_heads(organization_id uuid PRIMARY KEY,
      last_sequence_no bigint NOT NULL DEFAULT 0, last_event_hash text, updated_at timestamptz);
    CREATE TABLE public.income_expense_audit_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), income_expense_id uuid,
      action text, actor_id uuid, actor_name text, old_status text, new_status text, note text, created_at timestamptz,
      organization_id uuid, sequence_no bigint, prev_event_hash text, event_hash text, hash_scheme text);
    -- Hàm quyền: thân thật đọc vai trò / toà / sổ được giữ — ngoài phạm vi; hàm kiểm chỉ gọi chúng nên dựng từ bảng thử.
    CREATE TABLE test_super(user_id uuid); CREATE TABLE test_building_access(user_id uuid, building_id uuid);
    CREATE TABLE test_possession(user_id uuid, account_id uuid);
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT EXISTS (SELECT 1 FROM public.test_super WHERE user_id = auth.uid()) $$;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.can_access_building(_building_id uuid) RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT EXISTS (SELECT 1 FROM public.test_building_access WHERE user_id = auth.uid() AND building_id = _building_id) $$;
    CREATE FUNCTION app_private.my_possessed_cashbook_ids_v1() RETURNS SETOF uuid LANGUAGE sql STABLE AS
      $$ SELECT account_id FROM public.test_possession WHERE user_id = auth.uid() $$;
    -- Rút gọn trigger canh phiếu canonical của production (guard_income_expense_owned_payload, md5 prosrc 358fbf1f…):
    -- phiếu flow-owned chỉ được UPDATE khi chính giao dịch này đang giữ quyền chuyển trạng thái; phiếu đường cũ đi qua.
    CREATE FUNCTION public.test_guard() RETURNS trigger LANGUAGE plpgsql AS $g$
    BEGIN
      IF app_private.is_income_expense_flow_owned(OLD.id) AND NOT EXISTS (
        SELECT 1 FROM app_private.ie_transition_authorization t WHERE t.income_expense_id = OLD.id AND t.xid = pg_current_xact_id()) THEN
        RAISE EXCEPTION 'canonical income expense % is frozen (update rejected)', OLD.id USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END $g$;
    CREATE TRIGGER a00_guard BEFORE UPDATE ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION public.test_guard();
    -- Đếm mọi UPDATE thật vào phiếu: «không đổi» phải là 0 lần ghi.
    CREATE TABLE public.test_updates(id uuid);
    CREATE FUNCTION public.test_count_update() RETURNS trigger LANGUAGE plpgsql AS $c$
    BEGIN INSERT INTO public.test_updates VALUES (NEW.id); RETURN NEW; END $c$;
    CREATE TRIGGER z99_count AFTER UPDATE ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION public.test_count_update();

    INSERT INTO auth.users VALUES ('${staff}', 'staff@demo.test'), ('${staff2}', 'staff2@demo.test'),
      ('${outsider}', 'outsider@demo.test'), ('${boss}', 'boss@demo.test');
    INSERT INTO public.profiles VALUES ('${staff}', 'Nhân viên A', NULL), ('${staff2}', 'Nhân viên B', NULL),
      ('${outsider}', NULL, 'outsider@demo.test'), ('${boss}', 'Quản trị', NULL);
    INSERT INTO public.test_super VALUES ('${boss}');
    INSERT INTO public.test_building_access VALUES ('${staff}', '${building}'), ('${staff2}', '${building}');
    INSERT INTO public.test_possession VALUES ('${staff}', '${account}');
    INSERT INTO public.income_expenses(id, organization_id, code, building_id, account_id, verified_at, verified_by, verified_by_name, verified_note) VALUES
      ('${V.open}', '${org}', 'PC01', '${building}', NULL, NULL, NULL, NULL, NULL),
      ('${V.mine}', '${org}', 'PC02', '${building}', NULL, '2026-11-20T03:00:00Z', '${staff}', 'Nhân viên A', 'cũ'),
      ('${V.theirs}', '${org}', 'PC03', '${building}', NULL, '2026-11-20T03:00:00Z', '${staff2}', 'Nhân viên B', 'cũ'),
      ('${V.possessed}', '${org}', 'PC04', '${building2}', '${account}', NULL, NULL, NULL, NULL),
      ('${V.legacyOpen}', '${org}', 'PT01', '${building}', NULL, NULL, NULL, NULL, NULL),
      ('${V.legacyMine}', '${org}', 'PT02', '${building}', NULL, '2026-11-20T03:00:00Z', '${staff}', 'Nhân viên A', 'cũ'),
      ('${V.legacyTheirs}', '${org}', 'PT03', '${building}', NULL, '2026-11-20T03:00:00Z', '${staff2}', 'Nhân viên B', 'cũ'),
      ('${V.hidden}', '${org}', 'PC05', '${building2}', NULL, NULL, NULL, NULL, NULL);
    INSERT INTO app_private.income_expense_flow_ownership VALUES
      ('${V.open}', '${org}'), ('${V.mine}', '${org}'), ('${V.theirs}', '${org}'), ('${V.possessed}', '${org}'), ('${V.hidden}', '${org}');
  `);
  // Thân đang sống (md5 = production) của các hàm bị thay / được dựa vào.
  await db.exec(liveBefore('app_private.is_income_expense_flow_owned'));
  await db.exec(liveBefore('public.verify_income_expense'));
  await db.exec(liveBefore('public.verify_income_expense_v1'));
  await db.exec(APPEND_EVENT);
  await db.exec(ACTOR_NAME);
  for (const fn of ['public.verify_income_expense_v1(uuid,text)', 'public.verify_income_expense(uuid,text)',
    'app_private.is_income_expense_flow_owned(uuid)', 'app_private.append_income_expense_event_v1(uuid,uuid,text,uuid,text,text,text,text)',
    'app_private.ie_actor_display_name_v1(uuid)']) liveMd5[fn] = await md5Of(fn);
  oldMatrix = await runOldMatrix();
  // Quyền mặc định của schema public trên Supabase (đo production pg_default_acl 26/11/2026): hàm postgres tạo tự cấp
  // EXECUTE cho anon, service_role và authenticated. Migration phải tự thu của anon (và PUBLIC) — test ACL dưới đây chỉ
  // có nghĩa khi quyền mặc định này có mặt.
  await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, service_role, authenticated');
  // Áp nguyên tệp HAI lượt (lượt hai đi nhánh «đã ở bản của tệp này» của $requires$).
  firstApply = await db.exec(migrationSql).then(() => 'ok', (e: Error) => e.message);
  secondApply = await db.exec(migrationSql).then(() => 'ok', (e: Error) => e.message);
});

describe('migration đợt 10c: «Đã kiểm» đặt giá trị', () => {
  it('thân trước migration đúng thân production (md5 prosrc)', () => {
    expect(liveMd5).toEqual({
      'public.verify_income_expense_v1(uuid,text)': '96dee08afc9c585680f15553350b4a04',
      'public.verify_income_expense(uuid,text)': '39fd56487277e0729900b861152d2c67',
      'app_private.is_income_expense_flow_owned(uuid)': '34e0496590c0c7a1d13ec67b1fe1611c',
      'app_private.append_income_expense_event_v1(uuid,uuid,text,uuid,text,text,text,text)': 'b99ed83a837e417272b05b4dff0faf3f',
      'app_private.ie_actor_display_name_v1(uuid)': 'e99a33a800ddd71d5c786e3a2445f960',
    });
  });

  it('áp hai lượt đều đạt; còn đúng một bản ba tham số, DEFINER, VOLATILE, search_path ghim, trả jsonb, ACL như cũ', async () => {
    expect(firstApply).toBe('ok');
    expect(secondApply).toBe('ok');
    const fns = await all(`SELECT pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef, p.provolatile,
        pg_get_function_result(p.oid) AS result, array_to_string(p.proconfig, ',') AS cfg
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'verify_income_expense_v1'`);
    expect(fns).toEqual([{ args: 'p_id uuid, p_note text, p_verified boolean', prosecdef: true, provolatile: 'v', result: 'jsonb',
      cfg: 'search_path=pg_catalog, public, app_private' }]);
    const fn = 'public.verify_income_expense_v1(uuid,text,boolean)';
    const acl = await one(`SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE') AS auth_ok,
      has_function_privilege('service_role', '${fn}', 'EXECUTE') AS service_ok,
      has_function_privilege('anon', '${fn}', 'EXECUTE') AS anon_ok`);
    expect(acl).toEqual({ auth_ok: true, service_ok: true, anon_ok: false });
    // Hàm bật/tắt đường cũ không bị thay.
    expect(await md5Of('public.verify_income_expense(uuid,text)')).toBe('39fd56487277e0729900b861152d2c67');
  });

  it('lời gọi kiểu cũ (không p_verified): từng nhánh cho cùng kết quả, cùng dòng ghi, cùng nhật ký như thân cũ', async () => {
    const after = await runOldMatrix();
    expect(Object.keys(after)).toEqual(Object.keys(oldMatrix));
    for (const label of Object.keys(oldMatrix)) expect({ label, ...(after[label] as object) }).toEqual({ label, ...(oldMatrix[label] as object) });
    // Ma trận không xanh rỗng: các nhánh thật sự khác nhau.
    const m = oldMatrix as Record<string, { result: Row; after: { row: Row; events: Row[] } }>;
    expect(m['canonical chưa kiểm: staff đánh dấu kèm ghi chú'].after.row).toMatchObject({ verified: true, verified_by: staff, verified_by_name: 'Nhân viên A', verified_note: 'đã đối chiếu sao kê' });
    expect(m['canonical chưa kiểm: staff đánh dấu kèm ghi chú'].after.events).toMatchObject([{ action: 'VERIFIED', actor_id: staff, note: 'đã đối chiếu sao kê' }]);
    expect(m['canonical staff tự kiểm: staff bấm lần nữa ⇒ bỏ kiểm'].after).toMatchObject({ row: { verified: false }, events: [{ action: 'UNVERIFIED' }] });
    expect(m['canonical người khác kiểm: staff bấm ⇒ từ chối'].result).toMatchObject({ error: { code: 'P0001', message: expect.stringContaining('Nhân viên B') } });
    expect(m['canonical người khác kiểm: super admin bấm ⇒ bỏ kiểm'].after.row).toMatchObject({ verified: false });
    expect(m['phiếu đường cũ ⇒ 55000 «dùng đường legacy»'].result).toMatchObject({ error: { code: '55000' } });
    expect(m['người không xem được phiếu ⇒ 42501'].result).toMatchObject({ error: { code: '42501' } });
    expect(m['ngoài toà nhưng giữ sổ của phiếu ⇒ đánh dấu được'].after.row).toMatchObject({ verified: true });
    expect(m['chưa đăng nhập ⇒ 42501'].result).toMatchObject({ error: { code: '42501', message: 'Phải đăng nhập' } });
    expect(m['không có phiếu'].result).toMatchObject({ error: { message: 'Không tìm thấy phiếu' } });
    expect(m['bấm hai lần kiểu cũ']).toMatchObject({ first: { r: null }, second: { r: null }, after: { row: { verified: false }, events: [{ action: 'VERIFIED' }, { action: 'UNVERIFIED' }] } });
  });

  it('đặt «đã kiểm» hai lần liền: lần hai «không đổi», không UPDATE, không thêm nhật ký', async () => {
    await rollback(async () => {
      const first = await setCall(staff, V.open, true, ' ghi chú ');
      expect(first).toMatchObject({ id: V.open, changed: true, verified: true, verified_by_name: 'Nhân viên A' });
      expect(typeof first.verified_at).toBe('string');
      const before = await observe(V.open);
      const second = await setCall(staff, V.open, true, ' ghi chú ');
      expect(second).toEqual({ id: V.open, changed: false, verified: true, verified_at: expect.any(String), verified_by_name: 'Nhân viên A' });
      const after = await observe(V.open);
      expect(after).toEqual(before);
      expect(after).toMatchObject({ updates: 1, leftover: 0, row: { verified: true, verified_note: 'ghi chú' }, events: [{ action: 'VERIFIED', note: 'ghi chú' }] });
    });
  });

  it('đặt, bỏ, đặt lại: ba lần đổi đúng giá trị, ba dòng nhật ký', async () => {
    await rollback(async () => {
      expect(await setCall(staff, V.open, true)).toMatchObject({ changed: true, verified: true });
      expect(await setCall(staff, V.open, false)).toEqual({ id: V.open, changed: true, verified: false, verified_at: null, verified_by_name: null });
      expect(await setCall(staff, V.open, true)).toMatchObject({ changed: true, verified: true });
      expect(await observe(V.open)).toMatchObject({ updates: 3, leftover: 0, row: { verified: true },
        events: [{ action: 'VERIFIED' }, { action: 'UNVERIFIED' }, { action: 'VERIFIED' }] });
    });
  });

  it('bỏ kiểm phiếu chưa kiểm: «không đổi», không ghi gì (kiểu cũ thì sẽ đánh dấu)', async () => {
    await rollback(async () => {
      expect(await setCall(staff, V.open, false)).toEqual({ id: V.open, changed: false, verified: false, verified_at: null, verified_by_name: null });
      expect(await observe(V.open)).toMatchObject({ updates: 0, events: [], row: { verified: false } });
    });
  });

  it('phiếu người khác đã kiểm: đặt «đã kiểm» là «không đổi» (giữ người kiểm); bỏ kiểm bị từ chối như cũ; super admin bỏ được', async () => {
    await rollback(async () => {
      expect(await setCall(staff, V.theirs, true)).toMatchObject({ changed: false, verified: true, verified_by_name: 'Nhân viên B' });
      expect(await setCall(staff, V.theirs, false)).toMatchObject({ error: { code: 'P0001', message: expect.stringContaining('chỉ super admin hoặc người kiểm') } });
      expect(await observe(V.theirs)).toMatchObject({ updates: 0, events: [], row: { verified: true, verified_by: staff2 } });
      expect(await setCall(boss, V.theirs, false)).toMatchObject({ changed: true, verified: false });
      expect(await observe(V.theirs)).toMatchObject({ updates: 1, events: [{ action: 'UNVERIFIED', actor_id: boss }] });
    });
  });

  it('quyền kiểm TRƯỚC khi so: người không xem được phiếu bị từ chối cả khi phiếu đã đúng giá trị (không lộ trạng thái)', async () => {
    await rollback(async () => {
      expect(await setCall(outsider, V.open, false)).toMatchObject({ error: { code: '42501', message: 'Không có quyền xem phiếu này' } });
      expect(await setCall(outsider, V.mine, true)).toMatchObject({ error: { code: '42501' } });
      expect(await setCall(staff, V.hidden, false)).toMatchObject({ error: { code: '42501' } });
      expect(await setCall(null, V.open, false)).toMatchObject({ error: { code: '42501', message: 'Phải đăng nhập' } });
      expect(await setCall(staff, missing, true)).toMatchObject({ error: { message: 'Không tìm thấy phiếu' } });
      for (const id of [V.open, V.mine, V.hidden]) expect(await observe(id)).toMatchObject({ updates: 0, events: [] });
    });
  });

  it('phiếu đường cũ: đặt giá trị đi nguyên thân verify_income_expense dưới khoá, không nhật ký chuỗi băm như đường cũ', async () => {
    await rollback(async () => {
      expect(await setCall(staff, V.legacyOpen, true, '  cũ  ')).toMatchObject({ id: V.legacyOpen, changed: true, verified: true, verified_by_name: 'Nhân viên A' });
      expect(await setCall(staff, V.legacyOpen, true)).toMatchObject({ changed: false, verified: true });
      expect(await observe(V.legacyOpen)).toMatchObject({ updates: 1, events: [], row: { verified: true, verified_note: 'cũ' } });
      expect(await setCall(staff, V.legacyOpen, false)).toMatchObject({ changed: true, verified: false });
      expect(await setCall(staff, V.legacyOpen, false)).toMatchObject({ changed: false, verified: false });
      expect(await observe(V.legacyOpen)).toMatchObject({ updates: 2, events: [], row: { verified: false } });
      expect(await setCall(staff, V.legacyMine, true)).toMatchObject({ changed: false });
      expect(await setCall(staff, V.legacyTheirs, false)).toMatchObject({ error: { code: 'P0001', message: expect.stringContaining('chỉ super admin hoặc người kiểm') } });
      expect(await observe(V.legacyTheirs)).toMatchObject({ updates: 0, row: { verified: true, verified_by: staff2 } });
      expect(await setCall(outsider, V.legacyOpen, true)).toMatchObject({ error: { code: '42501' } });
    });
  });

  it('khoá phiếu FOR UPDATE đứng TRƯỚC phép so giá trị trong thân mới', async () => {
    const body = (await one(`SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.verify_income_expense_v1(uuid,text,boolean)')`)).prosrc as string;
    const lock = body.indexOf('for update');
    const compare = body.indexOf('(v_row.verified_at is not null) = p_verified');
    const perm = body.indexOf("raise exception 'Không có quyền xem phiếu này'");
    expect(lock).toBeGreaterThan(0);
    expect(perm).toBeGreaterThan(lock);
    expect(compare).toBeGreaterThan(perm);
    expect(body.indexOf('perform public.verify_income_expense(p_id, p_note)')).toBeGreaterThan(compare);
  });

  it('$requires$: thân hàm cũ lệch bản đã rà, hay có cả hai bản, thì migration dừng, không ghi đè', async () => {
    await rollback(async () => {
      await db.exec(`DROP FUNCTION public.verify_income_expense_v1(uuid, text, boolean)`);
      await db.exec(liveBefore('public.verify_income_expense_v1').replace("raise exception 'Không tìm thấy phiếu';", "raise exception 'Không tìm thấy phiếu!';"));
      await expect(db.exec(migrationSql)).rejects.toThrow(/hai tham số\) KHÁC thân đã rà/);
    });
    await rollback(async () => {
      await db.exec(liveBefore('public.verify_income_expense_v1'));
      await expect(db.exec(migrationSql)).rejects.toThrow(/cả bản hai lẫn ba tham số/);
    });
    await rollback(async () => {
      await db.exec(liveBefore('public.verify_income_expense').replace('RAISE EXCEPTION \'Không tìm thấy phiếu\';', 'RAISE EXCEPTION \'Không tìm thấy phiếu!\';'));
      await expect(db.exec(migrationSql)).rejects.toThrow(/verify_income_expense\(uuid,text\) KHÁC thân đã rà/);
    });
    await rollback(async () => {
      await db.exec(`CREATE OR REPLACE FUNCTION public.verify_income_expense_v1(p_id uuid, p_note text DEFAULT NULL, p_verified boolean DEFAULT NULL)
        RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'app_private' AS $x$ SELECT NULL::jsonb $x$`);
      await expect(db.exec(migrationSql)).rejects.toThrow(/không ở bản hai tham số đã rà, cũng không ở bản của tệp này/);
    });
    // Các lần dừng không để lại gì: hàm vẫn đúng thân của tệp.
    expect(await md5Of('public.verify_income_expense_v1(uuid,text,boolean)')).toBe(migrationSql.match(/IS DISTINCT FROM '([0-9a-f]{32})' THEN\n {6}RAISE EXCEPTION 'verify_income_expense_v1 không ở bản/)?.[1]);
  });
});
