import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Nháp bước quyết toán (20261030104546). Các rào quyền dùng ĐÚNG thân hàm production (cắt từ migration đã áp), chỉ giả
// lập lớp dưới cùng (auth.uid, tổ chức, quyền theo toà) bằng bảng perm để thử từng thiếu quyền riêng.
const path = 'supabase/migrations/20261030104546_contract_exit_settlement_draft_v1.sql';
const exitPath = 'supabase/migrations/20260928015559_contract_exit_case_workflow.sql';
const guardPath = 'supabase/migrations/20261021180057_contract_lifecycle_permission_guard_v1.sql';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = id(1), actor = id(2), other = id(3), building = id(4), building2 = id(5), otherOrg = id(6), otherBuilding = id(7);
const caseA = id(10), caseB = id(11), caseFinal = id(12), caseOther = id(13);
const db = new PGlite();

function fnSource(file: string, signature: string) {
  const sql = readFileSync(file, 'utf8');
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${signature}`);
  if (start < 0) throw new Error(`missing ${signature}`);
  const end = sql.indexOf('$fn$;', sql.indexOf('AS $fn$', start) + 7) + 5;
  return sql.slice(start, end);
}

async function bootstrap(target: PGlite) {
  await target.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
    CREATE TABLE public.profiles(id uuid PRIMARY KEY,full_name text); INSERT INTO public.profiles VALUES('${actor}','Người A'),('${other}','Người B');
    CREATE TABLE public.org_members(user_id uuid,organization_id uuid);
    INSERT INTO public.org_members VALUES('${actor}','${org}'),('${other}','${org}'),('${other}','${otherOrg}');
    CREATE TABLE public.perm(user_id uuid,building_id uuid,module text,action text);
    CREATE TABLE public.contract_exit_cases(id uuid PRIMARY KEY,organization_id uuid NOT NULL,building_id uuid NOT NULL,
      state text NOT NULL DEFAULT 'PENDING',version bigint NOT NULL DEFAULT 1);
    INSERT INTO public.contract_exit_cases(id,organization_id,building_id,state) VALUES
      ('${caseA}','${org}','${building}','PENDING'),('${caseB}','${org}','${building2}','PENDING'),
      ('${caseFinal}','${org}','${building}','FINALIZED'),('${caseOther}','${otherOrg}','${otherBuilding}','PENDING');
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT coalesce(array_agg(organization_id),'{}') FROM public.org_members WHERE user_id=auth.uid() $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT EXISTS(SELECT 1 FROM public.perm WHERE user_id=auth.uid() AND building_id=$1) $$;
    CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT EXISTS(SELECT 1 FROM public.perm WHERE user_id=auth.uid() AND building_id=$3 AND module=$1 AND action=$2) $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY[]::uuid[] $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$
      SELECT $1=auth.uid() AND $2=ANY(public.my_org_ids()) AND public.can_do_on_building(split_part($3,'.',1),split_part($3,'.',2),$4) $$;`);
  await target.exec(fnSource(exitPath, 'app_private.assert_contract_exit_scope_v1('));
  await target.exec(fnSource(exitPath, 'app_private.assert_contract_exit_writer_v1('));
  await target.exec(fnSource(guardPath, 'app_private.require_building_perm_v1('));
}
beforeAll(async () => {
  await bootstrap(db);
  const sql = readFileSync(path, 'utf8');
  await db.exec(sql);
  await db.exec(sql);
}, 30000);
afterAll(async () => { await db.close(); });

async function as(user: string | null, perms: [string, string, string][], fn: () => Promise<void>) {
  await db.exec('BEGIN');
  try {
    await db.query(`SELECT set_config('test.actor',$1,true)`, [user ?? '']);
    for (const [b, module, action] of perms) await db.query('INSERT INTO public.perm VALUES($1,$2,$3,$4)', [user, b, module, action]);
    await fn();
  } finally { await db.exec('ROLLBACK'); }
}
const full = (b = building): [string, string, string][] => [[b, 'contracts', 'view'], [b, 'contracts', 'edit'], [b, 'contracts', 'terminate']];
type Draft = { case_id: string; version: number; payload: Record<string, unknown>; updated_by_name: string | null; case_version: number } | null;
const save = async (caseId: string, version: number | null, payload: unknown, organization = org) =>
  (await db.query<{ r: Draft }>('SELECT public.save_contract_exit_settlement_draft_v1($1,$2,$3,$4::jsonb) AS r', [organization, caseId, version, JSON.stringify(payload)])).rows[0].r;
const get = async (caseId: string, organization = org) =>
  (await db.query<{ r: Draft }>('SELECT public.get_contract_exit_settlement_draft_v1($1,$2) AS r', [organization, caseId])).rows[0].r;
const list = async (ids: string[], organization = org) =>
  (await db.query<{ r: { case_id: string; version: number }[] } >('SELECT public.list_contract_exit_settlement_drafts_v1($1,$2::uuid[]) AS r', [organization, `{${ids.join(',')}}`])).rows[0].r;
const discard = async (caseId: string, version: number | null) =>
  (await db.query<{ r: unknown }>('SELECT public.discard_contract_exit_settlement_draft_v1($1,$2,$3) AS r', [org, caseId, version])).rows[0].r;
async function rejected(fn: () => Promise<unknown>, code: string) {
  await db.exec('SAVEPOINT expected_failure');
  try { await expect(fn()).rejects.toMatchObject({ code }); }
  finally { await db.exec('ROLLBACK TO SAVEPOINT expected_failure; RELEASE SAVEPOINT expected_failure'); }
}
const rows = async () => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM app_private.contract_exit_settlement_drafts')).rows[0].n;

describe('nháp bước quyết toán', () => {
  it('lưu, đọc lại đúng nội dung và ghi đè theo version; hồ sơ không đổi', () => as(actor, full(), async () => {
    const created = await save(caseA, null, { schema: 1, kind: 'FORFEIT', note: 'a' });
    expect(created).toMatchObject({ case_id: caseA, case_version: 1, updated_by_name: 'Người A', payload: { schema: 1, kind: 'FORFEIT', note: 'a' } });
    expect(await get(caseA)).toEqual(created);
    const updated = await save(caseA, created!.version, { schema: 1, kind: 'EARLY_RETURN' });
    expect(updated).toMatchObject({ payload: { schema: 1, kind: 'EARLY_RETURN' } });
    expect(updated!.version).toBeGreaterThan(created!.version);
    expect((await db.query('SELECT state,version FROM public.contract_exit_cases WHERE id=$1', [caseA])).rows[0]).toEqual({ state: 'PENDING', version: 1 });
  }));

  it('hai người cùng sửa: tạo trùng hoặc version cũ đều PT409, nháp giữ bản đã lưu', () => as(actor, full(), async () => {
    const first = await save(caseA, null, { schema: 1, n: 1 });
    await rejected(() => save(caseA, null, { schema: 1, n: 2 }), 'PT409');
    const second = await save(caseA, first!.version, { schema: 1, n: 3 });
    await rejected(() => save(caseA, first!.version, { schema: 1, n: 4 }), 'PT409');
    expect(await get(caseA)).toMatchObject({ version: second!.version, payload: { schema: 1, n: 3 } });
  }));

  it('bỏ nháp rồi tạo lại không bao giờ ra version cũ: người mở bản cũ không ghi đè / bỏ nhầm bản mới (ABA)', () => as(actor, full(), async () => {
    const seenByA = await save(caseA, null, { schema: 1, by: 'A' });
    await discard(caseA, seenByA!.version);
    const byB = await save(caseA, null, { schema: 1, by: 'B' });
    expect(byB!.version).not.toBe(seenByA!.version);
    await rejected(() => save(caseA, seenByA!.version, { schema: 1, by: 'A cũ' }), 'PT409');
    await rejected(() => discard(caseA, seenByA!.version), 'PT409');
    expect((await get(caseA))?.payload).toEqual({ schema: 1, by: 'B' });
  }));

  it('đọc/danh sách chạy được trong giao dịch READ ONLY như PostgREST gọi hàm STABLE; ghi thì không', () => as(actor, full(), async () => {
    const created = await save(caseA, null, { schema: 1 });
    await db.exec('SET TRANSACTION READ ONLY');
    expect((await get(caseA))?.version).toBe(created!.version);
    expect((await list([caseA])).map(d => d.case_id)).toEqual([caseA]);
    await rejected(() => save(caseA, created!.version, { schema: 1, n: 2 }), '25006');
  }));

  it('không lưu vào hồ sơ đã quyết toán; hồ sơ đã quyết toán đọc ra NULL', () => as(actor, full(), async () => {
    await rejected(() => save(caseFinal, null, { schema: 1 }), 'PT409');
    expect(await get(caseFinal)).toBeNull();
    expect(await rows()).toBe(0);
  }));

  it('quyết toán xong thì nháp tự xoá trong cùng giao dịch', () => as(actor, full(), async () => {
    await save(caseA, null, { schema: 1 });
    await db.query(`UPDATE public.contract_exit_cases SET state='FINALIZED',version=version+1 WHERE id=$1`, [caseA]);
    expect((await db.query('SELECT case_id FROM app_private.contract_exit_settlement_drafts')).rows).toEqual([]);
    expect(await get(caseA)).toBeNull();
    await rejected(() => save(caseA, 1, { schema: 1 }), 'PT409');
  }));

  it('đổi loại thanh lý (version hồ sơ tăng, vẫn PENDING) không xoá nháp', () => as(actor, full(), async () => {
    const created = await save(caseA, null, { schema: 1 });
    await db.query('UPDATE public.contract_exit_cases SET version=version+1 WHERE id=$1', [caseA]);
    expect(await get(caseA)).toMatchObject({ version: created!.version, case_version: 2 });
  }));

  it('thiếu contracts.terminate ở toà của hồ sơ: không đọc, không lưu, không bỏ', () => as(actor, [[building, 'contracts', 'view'], [building, 'contracts', 'edit']], async () => {
    await rejected(() => save(caseA, null, { schema: 1 }), '42501');
    await rejected(() => get(caseA), '42501');
    await rejected(() => discard(caseA, 1), '42501');
    expect(await rows()).toBe(0);
  }));

  it('có terminate nhưng thiếu contracts.edit (rào người ghi hồ sơ): không lưu', () => as(actor, [[building, 'contracts', 'view'], [building, 'contracts', 'terminate']], async () => {
    await rejected(() => save(caseA, null, { schema: 1 }), '42501');
    expect(await rows()).toBe(0);
  }));

  it('quyền ở toà khác không mở được hồ sơ toà này; hồ sơ tổ chức khác coi như không có', () => as(actor, full(building2), async () => {
    await rejected(() => save(caseA, null, { schema: 1 }), '42501');
    await rejected(() => get(caseA), '42501');
    await rejected(() => save(caseOther, null, { schema: 1 }), '42501');
    await rejected(() => save(caseOther, null, { schema: 1 }, otherOrg), '42501');
  }));

  it('chưa đăng nhập bị chặn', () => as(null, [], async () => {
    await rejected(() => save(caseA, null, { schema: 1 }), '42501');
    await rejected(() => list([caseA]), '42501');
  }));

  it('payload phải là object và không quá 32 KB; version phải dương', () => as(actor, full(), async () => {
    for (const bad of [[], 'x', 1, null]) await rejected(() => save(caseA, null, bad), '22023');
    await rejected(() => save(caseA, null, { schema: 1, note: 'x'.repeat(33_000) }), '22023');
    await rejected(() => save(caseA, 0, { schema: 1 }), '22023');
    await rejected(() => discard(caseA, null), '22023');
    expect(await rows()).toBe(0);
  }));

  it('bỏ nháp đúng version; version cũ PT409; nháp đã không còn coi như xong', () => as(actor, full(), async () => {
    const first = await save(caseA, null, { schema: 1 });
    const second = await save(caseA, first!.version, { schema: 1, n: 2 });
    await rejected(() => discard(caseA, first!.version), 'PT409');
    expect(await discard(caseA, second!.version)).toEqual({ case_id: caseA, discarded: true });
    expect(await get(caseA)).toBeNull();
    expect(await discard(caseA, second!.version)).toEqual({ case_id: caseA, discarded: true });
  }));

  it('danh sách chỉ nêu hồ sơ PENDING người gọi quyết toán được, không kèm nội dung', () => as(actor, [...full(), [building2, 'contracts', 'view'], [building2, 'contracts', 'edit'], [building2, 'contracts', 'terminate']], async () => {
    await save(caseA, null, { schema: 1, secret: 'a' });
    await save(caseB, null, { schema: 1 });
    await db.query(`DELETE FROM public.perm WHERE building_id=$1 AND action='terminate'`, [building2]);
    const result = await list([caseA, caseB, caseFinal, caseOther]);
    expect(result).toEqual([{ case_id: caseA, version: expect.any(Number), updated_at: expect.any(String), updated_by: actor, updated_by_name: 'Người A' }]);
    expect(await list([])).toEqual([]);
    await rejected(() => list(Array.from({ length: 101 }, (_, i) => id(100 + i))), '22023');
    await rejected(() => list([caseA], otherOrg), '42501');
  }));

  it('người có quyền ở hai tổ chức: danh sách chỉ nêu nháp của đúng tổ chức đang hỏi; nháp sót trên hồ sơ đã quyết toán không hiện', () => as(other, [...full(), ...full(otherBuilding)], async () => {
    await save(caseA, null, { schema: 1 });
    await save(caseOther, null, { schema: 1 }, otherOrg);
    // Nháp sót (trước khi có trigger, hoặc ghi ngoài RPC): đọc và danh sách vẫn phải bỏ qua vì hồ sơ đã FINALIZED.
    await db.query(`INSERT INTO app_private.contract_exit_settlement_drafts(case_id,payload,version,created_by,updated_by)
      VALUES($1,'{"schema":1}',nextval('app_private.contract_exit_settlement_draft_version_seq'),$2,$2)`, [caseFinal, other]);
    expect((await list([caseA, caseOther, caseFinal])).map(d => d.case_id)).toEqual([caseA]);
    expect((await list([caseA, caseOther, caseFinal], otherOrg)).map(d => d.case_id)).toEqual([caseOther]);
    expect(await get(caseFinal)).toBeNull();
    await rejected(() => get(caseOther), '42501');
    expect((await get(caseOther, otherOrg))?.case_id).toBe(caseOther);
  }));

  it('TEST đã áp bản đầu (DEFAULT 1, version đếm theo nháp, còn nháp v2): áp bản này thì không cấp lại số đang có người giữ', async () => {
    const legacy = new PGlite();
    try {
      await bootstrap(legacy);
      // Bảng của bản đầu (đã áp TEST 30/10/2026): version DEFAULT 1, tăng +1 theo từng nháp.
      await legacy.exec(`CREATE TABLE app_private.contract_exit_settlement_drafts (
        case_id uuid PRIMARY KEY REFERENCES public.contract_exit_cases(id) ON DELETE CASCADE,
        payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=32768),
        version bigint NOT NULL DEFAULT 1 CHECK (version>0), created_by uuid NOT NULL, updated_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
        INSERT INTO app_private.contract_exit_settlement_drafts(case_id,payload,version,created_by,updated_by)
          VALUES('${caseA}','{"schema":1,"by":"X"}',2,'${actor}','${actor}');`);
      const sql = readFileSync(path, 'utf8');
      await legacy.exec(sql);
      await legacy.exec(sql);
      await legacy.exec('BEGIN');
      await legacy.query(`SELECT set_config('test.actor',$1,true)`, [actor]);
      for (const [b, module, action] of [...full(), ...full(building2)]) await legacy.query('INSERT INTO public.perm VALUES($1,$2,$3,$4)', [actor, b, module, action]);
      const call = async (caseId: string, version: number | null, payload: unknown) =>
        (await legacy.query<{ r: { version: number } }>('SELECT public.save_contract_exit_settlement_draft_v1($1,$2,$3,$4::jsonb) AS r',
          [org, caseId, version, JSON.stringify(payload)])).rows[0].r;
      expect((await call(caseB, null, { schema: 1 })).version).toBeGreaterThan(2);
      const byB = await call(caseA, 2, { schema: 1, by: 'B' });
      expect(byB.version).toBeGreaterThan(2);
      await legacy.exec('SAVEPOINT stale');
      await expect(call(caseA, 2, { schema: 1, by: 'A cũ' })).rejects.toMatchObject({ code: 'PT409' });
      await legacy.exec('ROLLBACK TO SAVEPOINT stale');
      expect((await legacy.query(`SELECT column_default FROM information_schema.columns
        WHERE table_schema='app_private' AND table_name='contract_exit_settlement_drafts' AND column_name='version'`)).rows).toEqual([{ column_default: null }]);
      await legacy.exec('ROLLBACK');
    } finally { await legacy.close(); }
  }, 30000);

  it('quyền: authenticated gọi được 4 RPC, anon không; bảng và hàm nội bộ đóng với client', async () => {
    const fns = ['public.get_contract_exit_settlement_draft_v1(uuid,uuid)', 'public.list_contract_exit_settlement_drafts_v1(uuid,uuid[])',
      'public.save_contract_exit_settlement_draft_v1(uuid,uuid,bigint,jsonb)', 'public.discard_contract_exit_settlement_draft_v1(uuid,uuid,bigint)'];
    for (const fn of fns) {
      const r = (await db.query<{ a: boolean; n: boolean; s: boolean }>(`SELECT has_function_privilege('authenticated',$1,'EXECUTE') a,
        has_function_privilege('anon',$1,'EXECUTE') n,has_function_privilege('service_role',$1,'EXECUTE') s`, [fn])).rows[0];
      expect(r).toEqual({ a: true, n: false, s: false });
    }
    for (const fn of ['app_private.contract_exit_settlement_draft_response_v1(uuid)', 'app_private.clear_contract_exit_settlement_draft_v1()']) {
      expect((await db.query<{ a: boolean }>(`SELECT has_function_privilege('authenticated',$1,'EXECUTE') a`, [fn])).rows[0].a).toBe(false);
    }
    expect((await db.query<{ a: boolean }>(`SELECT has_table_privilege('authenticated','app_private.contract_exit_settlement_drafts','SELECT') a`)).rows[0].a).toBe(false);
    expect((await db.query<{ a: boolean }>(`SELECT has_sequence_privilege('authenticated','app_private.contract_exit_settlement_draft_version_seq','USAGE') a`)).rows[0].a).toBe(false);
  });
});
