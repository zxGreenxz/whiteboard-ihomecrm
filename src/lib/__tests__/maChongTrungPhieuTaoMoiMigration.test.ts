import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

// Đợt 10a: mã chống trùng cho đường compat lập phiếu thu chi (hàm bọc mới, ie_compat_insert_v2 giữ nguyên) và cho đề nghị
// đối soát sổ (propose_reconciliation nhận p_request_key DEFAULT NULL). Chạy THẬT thân ie_compat_insert_v2 và
// propose_reconciliation đang sống ngay trước migration (thân trong repo = thân production, md5 prosrc 342adaf7… / 8fc864e0…),
// rồi áp nguyên tệp migration HAI lượt và đo trên cùng dữ liệu. PGlite chỉ có một kết nối: hai lệnh song song cùng mã thử
// trên project TEST (mô tả PR).
const MIG_DIR = 'supabase/migrations';
const MIGRATION_FILE = '20261126130735_ma_chong_trung_phieu_tao_moi.sql';
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
      // Thân bọc bằng thẻ đô-la nào thì kết thúc ở đúng thẻ đó (tệp cũ dùng cả $$, $fn$…).
      const tag = text.slice(start).match(/\bAS\s+(\$[A-Za-z_]*\$)/i);
      if (!tag || tag.index === undefined) break;
      const bodyStart = start + tag.index + tag[0].length;
      // Thẻ đóng có thể đứng riêng một dòng rồi mới tới `;` (hoặc tới LANGUAGE …;): câu lệnh hết ở `;` đầu tiên sau thẻ.
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

const org = '00000000-0000-4000-8000-000000000001';
const otherOrg = '00000000-0000-4000-8000-000000000021';
const staff = '00000000-0000-4000-8000-000000000002';
const staff2 = '00000000-0000-4000-8000-000000000012';
const outsider = '00000000-0000-4000-8000-000000000013';
const building = '00000000-0000-4000-8000-000000000003';
const building2 = '00000000-0000-4000-8000-000000000004';
const ordinaryType = '00000000-0000-4000-8000-000000000008';
const systemType = '00000000-0000-4000-8000-000000000009';
const membership = '00000000-0000-4000-8000-000000000010';
const membership2 = '00000000-0000-4000-8000-000000000011';
const account = '00000000-0000-4000-8000-000000000031';
const canonicalVoucher = '00000000-0000-4000-8000-000000000041';
const plannedId = '00000000-0000-4000-8000-000000000051';

const db = new PGlite();
type Row = Record<string, unknown>;

async function one(sql: string, params: unknown[] = []): Promise<Row> {
  return (await db.query<Row>(sql, params)).rows[0];
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

/** Gọi như PostgREST: vai authenticated, auth.uid() = người gọi. Lỗi trả về {code, message, detail, hint}. */
async function asUser(actor: string, sql: string, params: unknown[] = []): Promise<Row> {
  await db.exec('SAVEPOINT goi');
  await db.exec(`SET LOCAL ROLE authenticated; SELECT set_config('test.actor','${actor}',true);`);
  try {
    const r = await one(sql, params);
    await db.exec('RESET ROLE; RELEASE SAVEPOINT goi');
    return r;
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT goi; RESET ROLE; RELEASE SAVEPOINT goi');
    const e = error as { code?: string; message?: string; detail?: string; hint?: string };
    return { error: { code: e.code, message: e.message, detail: e.detail, hint: e.hint } };
  }
}

const keyed = (actor: string, row: Row, items: Row[], key: string | null) =>
  asUser(actor, 'SELECT public.ie_compat_insert_keyed_v1($1::jsonb, $2::jsonb, $3) AS r', [JSON.stringify(row), JSON.stringify(items), key]);
/** Mã phiếu theo mã yêu cầu như trình duyệt đọc (một hàng mỗi mã đã xong), gom lại thành {mã yêu cầu: mã phiếu}. */
const lookup = async (actor: string, organization: string, keys: string[]) => {
  const r = await asUser(actor, `SELECT coalesce(jsonb_object_agg(x.request_key, x.voucher_id), '{}'::jsonb) AS r
    FROM public.get_own_income_expense_requests_v1($1::uuid, $2::text[]) x`, [organization, keys]);
  return r.r as Record<string, string>;
};
const propose = (actor: string, args: { counted: number; note?: string | null; ma?: string | null; counterparty?: string | null }) =>
  args.ma === undefined
    ? asUser(actor, 'SELECT public.propose_reconciliation(p_account_id => $1::uuid, p_as_of => $2::date, p_counted_balance => $3::numeric, p_counterparty_id => $4::uuid, p_note => $5) AS r',
      [account, '2026-11-20', args.counted, args.counterparty ?? null, args.note ?? null])
    : asUser(actor, 'SELECT public.propose_reconciliation(p_account_id => $1::uuid, p_as_of => $2::date, p_counted_balance => $3::numeric, p_counterparty_id => $4::uuid, p_note => $5, p_request_key => $6) AS r',
      [account, '2026-11-20', args.counted, args.counterparty ?? null, args.note ?? null, args.ma]);

const row = (over: Row = {}): Row => ({ type: 'EXPENSE', name: 'Sửa ống nước', building_id: building, voucher_date: '2026-11-20', ...over });
const items = (amount = 150000, type = ordinaryType): Row[] => [{ income_expense_type_id: type, quantity: 1, unit_price: amount, description: 'Vật tư' }];
const count = async (table: string, where = 'true') => Number((await one(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).n);
const claims = (op: string) => count('app_private.canonical_write_operations', `operation = '${op}'`);
const md5Of = async (fn: string) =>
  (await one(`SELECT md5(replace(prosrc, chr(13), '')) AS m FROM pg_proc WHERE oid = to_regprocedure('${fn}')`)).m as string | null;

// Thân production của trigger chặn sửa/xoá sổ giữ mã (đọc 26/11/2026, md5 prosrc c0d0fb8b…): không có ở tệp migration nào.
const GUARD = `
CREATE FUNCTION app_private.guard_canonical_write_operation() RETURNS trigger LANGUAGE plpgsql AS $g$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN RAISE EXCEPTION 'Canonical operation ledger is append-only' USING ERRCODE = '55000'; END IF;
  IF OLD.subject_id IS NOT NULL OR OLD.response_payload IS NOT NULL OR OLD.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Completed canonical operation is immutable' USING ERRCODE = '55000'; END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.subject_scope IS DISTINCT FROM OLD.subject_scope OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Canonical operation identity is immutable' USING ERRCODE = '55000'; END IF;
  IF NEW.subject_id IS NULL OR NEW.response_payload IS NULL OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'Canonical operation can only transition once to completed' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $g$;`;

let oldReconciliation: Row;

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    GRANT USAGE ON SCHEMA auth TO anon, service_role, authenticated; GRANT USAGE ON SCHEMA app_private TO anon, service_role, authenticated;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('test.actor', true), '')::uuid $$;
    CREATE TABLE organizations(id uuid PRIMARY KEY);
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE accounts(id uuid, organization_id uuid, user_id uuid, initial_amount numeric, deleted_at timestamptz, PRIMARY KEY (id));
    CREATE TABLE buildings(id uuid, organization_id uuid, deleted_at timestamptz, PRIMARY KEY (id));
    CREATE TABLE organization_memberships(id uuid, user_id uuid, organization_id uuid, status text, PRIMARY KEY (id));
    CREATE TABLE cashbook_possession_bindings(organization_id uuid, cashbook_id uuid, membership_id uuid,
      valid_to timestamptz, possession_kind text);
    CREATE TABLE income_expense_types(id uuid, organization_id uuid, type text, name text,
      system_only boolean DEFAULT false, is_restricted boolean DEFAULT false, PRIMARY KEY (id));
    CREATE TABLE income_expenses(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, user_id uuid, code text,
      type text NOT NULL, name text, building_id uuid, contract_id uuid, account_id uuid, voucher_date date,
      total_amount numeric NOT NULL DEFAULT 0, approval_status text NOT NULL DEFAULT 'UNAPPROVED',
      review_state text, approved_by uuid, approved_at timestamptz, posting_mode text, posting_status text,
      maker_user_id uuid, maker_membership_id uuid, deleted_at timestamptz, notes text,
      repeat_cycle text NOT NULL DEFAULT 'NONE', system_source text,
      change_amount numeric, change_account_id uuid, rounding_amount numeric, rounding_account_id uuid);
    CREATE TABLE income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), income_expense_id uuid NOT NULL,
      income_expense_type_id uuid, organization_id uuid, description text, quantity numeric NOT NULL DEFAULT 1,
      unit_price numeric, amount numeric, accounting_class text);
    CREATE TABLE cashbook_reconciliations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL,
      as_of_date date NOT NULL, system_balance numeric NOT NULL, counted_balance numeric NOT NULL, diff numeric NOT NULL,
      status text NOT NULL DEFAULT 'CONFIRMED', note text, proposed_by uuid NOT NULL, counterparty_id uuid,
      confirmed_by uuid, created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz, cancelled_at timestamptz,
      organization_id uuid);
    CREATE TABLE app_private.finance_v2_semantic_event_log(organization_id uuid, event_kind text, source_table text,
      source_id uuid, source_kind text, actor uuid, txid xid8);
    CREATE TABLE app_private.canonical_write_operations(
      organization_id uuid NOT NULL REFERENCES organizations(id), operation text NOT NULL, subject_scope text NOT NULL,
      actor_id uuid NOT NULL REFERENCES auth.users(id), idempotency_key text NOT NULL,
      payload_hash text NOT NULL CHECK (char_length(payload_hash) = 32), subject_id uuid, response_payload jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, actor_membership_id uuid, transaction_id xid8,
      expected_review_version bigint, expected_approval_version bigint, expected_posting_version bigint,
      resulting_review_version bigint, resulting_approval_version bigint, resulting_posting_version bigint, outcome_kind text,
      PRIMARY KEY (organization_id, operation, subject_scope, actor_id, idempotency_key),
      CHECK (((completed_at IS NULL) = (response_payload IS NULL)) AND ((completed_at IS NULL) = (subject_id IS NULL))),
      CHECK (char_length(idempotency_key) BETWEEN 8 AND 200 AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'));
    ${GUARD}
    CREATE TRIGGER canonical_write_operations_immutable BEFORE DELETE OR UPDATE ON app_private.canonical_write_operations
      FOR EACH ROW EXECUTE FUNCTION app_private.guard_canonical_write_operation();
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS
      $$ SELECT coalesce(array_agg(m.organization_id), '{}') FROM public.organization_memberships m
          WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE' $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT '{}'::uuid[] $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.same_team(p_user uuid) RETURNS boolean LANGUAGE sql STABLE AS
      $$ SELECT EXISTS (SELECT 1 FROM public.organization_memberships a JOIN public.organization_memberships b
          ON b.organization_id = a.organization_id WHERE a.user_id = auth.uid() AND b.user_id = p_user) $$;
    INSERT INTO organizations VALUES ('${org}'), ('${otherOrg}');
    INSERT INTO auth.users VALUES ('${staff}'), ('${staff2}'), ('${outsider}');
    INSERT INTO buildings VALUES ('${building}', '${org}', NULL), ('${building2}', '${org}', NULL);
    INSERT INTO organization_memberships VALUES ('${membership}', '${staff}', '${org}', 'ACTIVE'),
      ('${membership2}', '${staff2}', '${org}', 'ACTIVE');
    INSERT INTO accounts VALUES ('${account}', '${org}', '${staff}', 1000000, NULL);
    INSERT INTO income_expense_types VALUES
      ('${ordinaryType}', '${org}', 'EXPENSE', 'Sửa chữa', false, false),
      ('${systemType}', '${org}', 'EXPENSE', 'Hoa hồng môi giới', true, false);
    INSERT INTO income_expenses(organization_id, type, name, account_id, voucher_date, total_amount, approval_status)
      VALUES ('${org}', 'INCOME', 'Thu tiền phòng', '${account}', '2026-11-10', 250000, 'APPROVED');
  `);
  // Thân đang sống (md5 = production) của các hàm bị thay / được dựa vào. create_income_expense_v1 chỉ cần có mặt đúng
  // thân cho khối ghim md5 (test không gọi nó; claim của nó được dựng tay): tạo không kiểm thân vì PGlite thiếu bảng nó đọc.
  await db.exec(liveBefore('app_private.ie_compat_actor_v2'));
  await db.exec(liveBefore('public.ie_compat_insert_v2'));
  await db.exec(liveBefore('public.propose_reconciliation'));
  await db.exec(`SET check_function_bodies = off; ${liveBefore('public.create_income_expense_v1')} RESET check_function_bodies;`);
  await db.exec(`
    REVOKE ALL ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb) TO authenticated;
    REVOKE ALL ON FUNCTION public.propose_reconciliation(uuid, date, numeric, uuid, text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.propose_reconciliation(uuid, date, numeric, uuid, text) TO service_role, authenticated;
  `);
  // Đối chứng trên thân CŨ: kết quả và dòng ghi của một đề nghị, để so với bản mới khi không truyền mã.
  oldReconciliation = await rollback(async () => {
    const r = await propose(staff2, { counted: 1200000, note: '  đếm tay  ' });
    const saved = await one(`SELECT account_id, as_of_date::text, system_balance, counted_balance, diff, status, note, proposed_by,
      counterparty_id, confirmed_by IS NOT NULL AS confirmed FROM cashbook_reconciliations`);
    return { r: r.r, saved };
  });
  expect(await md5Of('public.ie_compat_insert_v2(jsonb,jsonb)')).toBe('342adaf725191f931739db5ef8c54620');
  expect(await md5Of('public.propose_reconciliation(uuid,date,numeric,uuid,text)')).toBe('8fc864e0c24e2809cb5ef9fa3b67de66');
  expect(await md5Of('public.create_income_expense_v1(text,text,uuid,uuid,uuid,uuid,text,text,text,uuid,jsonb,boolean,text,date,jsonb,text)')).toBe('2a410d8a20e58251ec8fa5974078c00e');
  expect(await md5Of('app_private.ie_compat_actor_v2(uuid)')).toBe('541d14304ddcb274c30eeb74a873504d');
  await db.exec(migrationSql);
  await db.exec(migrationSql);
}, 60000);

describe('migration 10a: chạy lại và hình dạng', () => {
  it('áp hai lượt liền không lỗi; ie_compat_insert_v2 giữ nguyên thân, chữ ký, ACL', async () => {
    expect(await md5Of('public.ie_compat_insert_v2(jsonb,jsonb)')).toBe('342adaf725191f931739db5ef8c54620');
    const acl = await one(`SELECT has_function_privilege('authenticated', 'public.ie_compat_insert_v2(jsonb,jsonb)', 'EXECUTE') AS a,
      has_function_privilege('anon', 'public.ie_compat_insert_v2(jsonb,jsonb)', 'EXECUTE') AS n`);
    expect(acl).toEqual({ a: true, n: false });
  });

  it('propose_reconciliation còn đúng một bản (6 tham số, tham số mới có DEFAULT), DEFINER, search_path cũ, ACL cũ', async () => {
    const r = await one(`SELECT count(*)::int AS n, max(pronargs)::int AS args, max(pronargdefaults)::int AS defaults,
      bool_and(prosecdef) AS definer, max(array_to_string(proconfig, ',')) AS cfg FROM pg_proc WHERE proname = 'propose_reconciliation'`);
    expect(r).toEqual({ n: 1, args: 6, defaults: 3, definer: true, cfg: 'search_path=public' });
    const fn = 'public.propose_reconciliation(uuid,date,numeric,uuid,text,text)';
    const acl = await one(`SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE') AS a,
      has_function_privilege('service_role', '${fn}', 'EXECUTE') AS s, has_function_privilege('anon', '${fn}', 'EXECUTE') AS n`);
    expect(acl).toEqual({ a: true, s: true, n: false });
  });

  it('hai hàm mới: DEFINER, search_path ghim, chỉ authenticated gọi được', async () => {
    for (const fn of ['public.ie_compat_insert_keyed_v1(jsonb,jsonb,text)', 'public.get_own_income_expense_requests_v1(uuid,text[])']) {
      const r = await one(`SELECT prosecdef AS definer, proconfig IS NOT NULL AS pinned,
        has_function_privilege('authenticated', '${fn}', 'EXECUTE') AS a, has_function_privilege('anon', '${fn}', 'EXECUTE') AS n,
        has_function_privilege('service_role', '${fn}', 'EXECUTE') AS s FROM pg_proc WHERE oid = to_regprocedure('${fn}')`);
      expect(r).toEqual({ definer: true, pinned: true, a: true, n: false, s: false });
    }
    expect((await one(`SELECT provolatile AS v FROM pg_proc WHERE oid = 'public.ie_compat_insert_keyed_v1(jsonb,jsonb,text)'::regprocedure`)).v).toBe('v');
  });

  it('hàm bọc KHOÁ trước khi đọc / giữ mã, và chỉ gọi ie_compat_insert_v2 sau khi xét xong mã', async () => {
    const src = (await one(`SELECT prosrc FROM pg_proc WHERE oid = 'public.ie_compat_insert_keyed_v1(jsonb,jsonb,text)'::regprocedure`)).prosrc as string;
    const lock = src.indexOf('pg_advisory_xact_lock');
    const claim = src.indexOf('INSERT INTO app_private.canonical_write_operations');
    const firstRead = src.indexOf('FROM app_private.canonical_write_operations');
    const write = src.indexOf('public.ie_compat_insert_v2(');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(claim);
    expect(lock).toBeLessThan(firstRead);
    expect(write).toBeGreaterThan(src.lastIndexOf('ie_request_key_used_by_canonical'));
  });

  it('đường chính create_income_expense_v1 đang sống vẫn giữ mã ở income_expense.create_draft.v1, phạm vi = toà (hàm bọc dựa vào đó)', () => {
    const live = liveBefore('public.create_income_expense_v1');
    expect(live).toMatch(/v_org, 'income_expense\.create_draft\.v1', p_building_id::text, v_actor,\s*v_idempotency_key, v_payload_hash/);
    expect(live).toContain("subject_id = v_row.id");
  });
});

describe('ie_compat_insert_keyed_v1 — gửi lại cùng mã', () => {
  it('cùng mã cùng nội dung: lần hai trả lại đúng phiếu cũ (replayed), chỉ một phiếu, một claim đã xong', () => rollback(async () => {
    const first = await keyed(staff, row(), items(), 'excel-run-1:7');
    const id = (first.r as Row).id as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const second = await keyed(staff, row(), items(), 'excel-run-1:7');
    expect(second.r).toMatchObject({ id, replayed: true, approval_status: 'UNAPPROVED' });
    expect(await count('income_expenses', `name = 'Sửa ống nước'`)).toBe(1);
    expect(await count('income_expense_items', `income_expense_id = '${id}'`)).toBe(1);
    const claim = await one(`SELECT subject_id, completed_at IS NOT NULL AS done, actor_membership_id FROM app_private.canonical_write_operations
      WHERE operation = 'income_expense.compat_insert.v1'`);
    expect(claim).toEqual({ subject_id: id, done: true, actor_membership_id: membership });
  }));

  it('mã phiếu do trình duyệt sinh (p_row.id) vẫn được giữ như ie_compat_insert_v2', () => rollback(async () => {
    const r = await keyed(staff, row({ id: plannedId }), items(), 'ie-create-abcdef12');
    expect((r.r as Row).id).toBe(plannedId);
  }));

  it('cùng mã KHÁC nội dung (số tiền, hạng mục, tên): 23505 kèm mã phiếu đã có, không phiếu thứ hai', () => rollback(async () => {
    const first = await keyed(staff, row(), items(), 'batch-key-1:0');
    const id = (first.r as Row).id;
    for (const [r2, i2] of [[row(), items(200000)], [row({ name: 'Sửa điện' }), items()], [row(), []]] as const) {
      const again = await keyed(staff, r2, i2 as Row[], 'batch-key-1:0');
      expect(again.error).toMatchObject({ code: '23505', detail: id, hint: 'ie_request_key_payload_mismatch' });
    }
    expect(await count('income_expenses', `building_id = '${building}' AND type = 'EXPENSE'`)).toBe(1);
  }));

  it('mã đã được đường chính ghi xong (cùng người, cùng toà): 23505 kèm mã phiếu của đường chính, không lập phiếu compat', () => rollback(async () => {
    await db.exec(`INSERT INTO app_private.canonical_write_operations(organization_id, operation, subject_scope, actor_id, idempotency_key,
      payload_hash, subject_id, response_payload, completed_at) VALUES ('${org}', 'income_expense.create_draft.v1', '${building}', '${staff}',
      'ie-create-11112222', md5('x'), '${canonicalVoucher}', '{"id":"${canonicalVoucher}"}', now())`);
    const r = await keyed(staff, row({ id: '00000000-0000-4000-8000-000000000061' }), items(), 'ie-create-11112222');
    expect(r.error).toMatchObject({ code: '23505', detail: canonicalVoucher, hint: 'ie_request_key_used_by_canonical' });
    expect(await count('income_expenses', `type = 'EXPENSE'`)).toBe(0);
    expect(await claims('income_expense.compat_insert.v1')).toBe(0);
    // Claim đường chính của người khác hoặc toà khác không liên quan: lập bình thường.
    expect((await keyed(staff2, row(), items(), 'ie-create-11112222')).r).toMatchObject({ approval_status: 'UNAPPROVED' });
    expect((await keyed(staff, row({ building_id: building2 }), items(), 'ie-create-11112222')).r).toMatchObject({ approval_status: 'UNAPPROVED' });
  }));

  it('claim đường chính CHƯA xong (không có completed_at) không chặn — chỉ claim đã commit cùng phiếu mới là «đã ghi»', () => rollback(async () => {
    await db.exec(`INSERT INTO app_private.canonical_write_operations(organization_id, operation, subject_scope, actor_id, idempotency_key,
      payload_hash) VALUES ('${org}', 'income_expense.create_draft.v1', '${building}', '${staff}', 'ie-create-33334444', md5('x'))`);
    expect((await keyed(staff, row(), items(), 'ie-create-33334444')).r).toMatchObject({ approval_status: 'UNAPPROVED' });
  }));

  it('mã theo từng người: người khác cùng mã là lượt khác', () => rollback(async () => {
    const a = await keyed(staff, row(), items(), 'shared-key-01');
    const b = await keyed(staff2, row(), items(), 'shared-key-01');
    expect((a.r as Row).id).not.toBe((b.r as Row).id);
    expect(await count('income_expenses', `type = 'EXPENSE'`)).toBe(2);
  }));

  it('ie_compat_insert_v2 từ chối (hạng mục chi hệ thống): không để lại claim; sửa nội dung rồi gửi lại cùng mã thì lập được', () => rollback(async () => {
    const bad = await keyed(staff, row(), items(150000, systemType), 'retry-key-01');
    expect(bad.error).toMatchObject({ code: '42501', hint: 'ie_system_only_manual_blocked' });
    expect(await claims('income_expense.compat_insert.v1')).toBe(0);
    expect((await keyed(staff, row(), items(), 'retry-key-01')).r).toMatchObject({ approval_status: 'UNAPPROVED' });
  }));

  it('mã sai dạng / thiếu: 22023, không ghi gì', () => rollback(async () => {
    for (const key of [null, '', 'short', 'có dấu-12345', '-leading-dash', 'x'.repeat(201)]) {
      expect((await keyed(staff, row(), items(), key)).error).toMatchObject({ code: '22023' });
    }
    expect(await count('income_expenses', `type = 'EXPENSE'`)).toBe(0);
  }));

  it('dấu bản nháp của trợ lý không đi qua hàm bọc', () => rollback(async () => {
    expect((await keyed(staff, row({ copilot_draft_marker: 'm-1' }), items(), 'copilot-key-1')).error).toMatchObject({ code: '22023' });
    expect(await count('income_expenses', `type = 'EXPENSE'`)).toBe(0);
  }));

  it('không phải thành viên công ty của toà: 42501, không claim', () => rollback(async () => {
    expect((await keyed(outsider, row(), items(), 'outsider-key-1')).error).toMatchObject({ code: '42501' });
    expect(await claims('income_expense.compat_insert.v1')).toBe(0);
  }));

  it('chưa đăng nhập: 42501', () => rollback(async () => {
    await db.exec(`SET LOCAL ROLE authenticated; SELECT set_config('test.actor','',true);`);
    await expect(db.query('SELECT public.ie_compat_insert_keyed_v1($1::jsonb, $2::jsonb, $3)', [JSON.stringify(row()), JSON.stringify(items()), 'anon-key-01']))
      .rejects.toMatchObject({ code: '42501' });
  }));

  it('đường cũ không truyền mã giữ nguyên: mỗi lần gọi một phiếu, không claim', () => rollback(async () => {
    for (let i = 0; i < 2; i++) await asUser(staff, 'SELECT public.ie_compat_insert_v2($1::jsonb, $2::jsonb) AS r', [JSON.stringify(row()), JSON.stringify(items())]);
    expect(await count('income_expenses', `type = 'EXPENSE'`)).toBe(2);
    expect(await count('app_private.canonical_write_operations')).toBe(0);
  }));
});

describe('get_own_income_expense_requests_v1 — tra phiếu của chính mình theo mã', () => {
  it('trả mã phiếu cho đúng người, đúng công ty, đúng mã; mã chưa xong / của người khác / công ty khác không có', () => rollback(async () => {
    const id = ((await keyed(staff, row(), items(), 'lk-00001')).r as Row).id as string;
    const id2 = ((await keyed(staff, row({ name: 'Dòng 2' }), items(), 'lk-00003')).r as Row).id as string;
    expect(await lookup(staff, org, ['lk-00001', 'lk-00002', 'lk-00003'])).toEqual({ 'lk-00001': id, 'lk-00003': id2 });
    expect(await lookup(staff2, org, ['lk-00001'])).toEqual({});
    expect(await lookup(staff, otherOrg, ['lk-00001'])).toEqual({});
    expect(await lookup(outsider, org, ['lk-00001'])).toEqual({});
    expect(await lookup(staff, org, [])).toEqual({});
  }));

  it('thấy cả phiếu đường chính đã ghi xong với mã đó (phạm vi = toà), kèm đường ghi; claim CHƯA xong hay của thao tác khác thì không', () => rollback(async () => {
    await db.exec(`INSERT INTO app_private.canonical_write_operations(organization_id, operation, subject_scope, actor_id, idempotency_key,
      payload_hash, subject_id, response_payload, completed_at) VALUES ('${org}', 'income_expense.create_draft.v1', '${building}', '${staff}',
      'ie-create-55556666', md5('x'), '${canonicalVoucher}', '{}', now());
      INSERT INTO app_private.canonical_write_operations(organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
      VALUES ('${org}', 'income_expense.create_draft.v1', '${building}', '${staff}', 'ie-create-77778888', md5('x'));
      INSERT INTO app_private.canonical_write_operations(organization_id, operation, subject_scope, actor_id, idempotency_key,
      payload_hash, subject_id, response_payload, completed_at) VALUES ('${org}', 'cashbook.reconciliation.propose.v1', '${account}', '${staff}',
      'rc-99990000', md5('x'), '${canonicalVoucher}', '{}', now())`);
    expect(await lookup(staff, org, ['ie-create-55556666', 'ie-create-77778888', 'rc-99990000'])).toEqual({ 'ie-create-55556666': canonicalVoucher });
    expect(await lookup(staff2, org, ['ie-create-55556666'])).toEqual({});
    const path = await asUser(staff, `SELECT x.write_path AS r FROM public.get_own_income_expense_requests_v1($1::uuid, ARRAY['ie-create-55556666']) x`, [org]);
    expect(path.r).toBe('canonical');
    await keyed(staff, row(), items(), 'lk-00009');
    expect((await asUser(staff, `SELECT x.write_path AS r FROM public.get_own_income_expense_requests_v1($1::uuid, ARRAY['lk-00009']) x`, [org])).r).toBe('compat');
  }));
});

describe('propose_reconciliation — mã yêu cầu tuỳ chọn', () => {
  it('không truyền mã: kết quả và dòng ghi y như thân cũ, mỗi lần gọi một dòng, không claim', () => rollback(async () => {
    const r = await propose(staff2, { counted: 1200000, note: '  đếm tay  ' });
    const saved = await one(`SELECT account_id, as_of_date::text, system_balance, counted_balance, diff, status, note, proposed_by,
      counterparty_id, confirmed_by IS NOT NULL AS confirmed FROM cashbook_reconciliations`);
    const { id: _a, ...newShape } = r.r as Row;
    const { id: _b, ...oldShape } = oldReconciliation.r as Row;
    expect(newShape).toEqual(oldShape);
    expect(saved).toEqual(oldReconciliation.saved);
    await propose(staff2, { counted: 1200000, note: '  đếm tay  ' });
    expect(await count('cashbook_reconciliations')).toBe(2);
    expect(await count('app_private.canonical_write_operations')).toBe(0);
  }));

  it('cùng mã cùng nội dung: lần hai trả lại đúng dòng cũ (replayed), chỉ một dòng', () => rollback(async () => {
    const first = await propose(staff, { counted: 1250000, ma: 'rc-00001' });
    const id = (first.r as Row).id;
    expect(first.r).toMatchObject({ status: 'CONFIRMED', system_balance: 1250000, diff: 0 });
    const second = await propose(staff, { counted: 1250000, ma: 'rc-00001' });
    expect(second.r).toEqual({ ...(first.r as Row), replayed: true });
    expect(await count('cashbook_reconciliations')).toBe(1);
    expect(await one(`SELECT subject_id, completed_at IS NOT NULL AS done FROM app_private.canonical_write_operations`)).toEqual({ subject_id: id, done: true });
  }));

  it('cùng mã KHÁC nội dung (số đếm, ghi chú, người xác nhận): 23505 kèm mã dòng đã có', () => rollback(async () => {
    const id = ((await propose(staff, { counted: 1250000, ma: 'rc-00002' })).r as Row).id;
    for (const args of [{ counted: 1300000 }, { counted: 1250000, note: 'khác' }, { counted: 1250000, counterparty: staff2 }]) {
      expect((await propose(staff, { ...args, ma: 'rc-00002' })).error).toMatchObject({ code: '23505', detail: id });
    }
    expect(await count('cashbook_reconciliations')).toBe(1);
  }));

  it('kiểm quyền đứng TRƯỚC giữ mã: người ngoài bị từ chối, không để lại claim', () => rollback(async () => {
    expect((await propose(outsider, { counted: 1, ma: 'rc-00003' })).error).toMatchObject({ message: 'Bạn không có quyền đối soát sổ này' });
    expect(await count('app_private.canonical_write_operations')).toBe(0);
  }));

  it('mã sai dạng: 22023; mã rỗng = không truyền mã', () => rollback(async () => {
    expect((await propose(staff, { counted: 1, ma: 'bad ma!' })).error).toMatchObject({ code: '22023' });
    expect((await propose(staff, { counted: 1, ma: '   ' })).r).toMatchObject({ status: 'CONFIRMED' });
    expect(await count('app_private.canonical_write_operations')).toBe(0);
  }));
});
