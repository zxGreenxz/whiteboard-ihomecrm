// Hàm chuẩn bị bảng con Network Center (28/10/2026): thân 20260729020000 chạy ALTER TABLE … ENABLE ROW LEVEL
// SECURITY và REVOKE ALL vô điều kiện mỗi lượt, nên lấy AccessExclusiveLock và ghi lại pg_class kể cả khi bảng con
// đã đủ điều kiện. Một PGlite cho cả file; mỗi ca dò BEGIN…ROLLBACK. Ca trước chạy thân cũ (khoá + ghi), ca sau
// chạy migration vá (không khoá, không ghi), đột biến chứng minh các phép kiểm cắn.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const read = (name) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const FIX = read('20261028153038_network_center_ensure_partitions_bo_qua_alter_lap.sql');
const OLD = read('20260729020000_network_center_current_telemetry.sql');
const ENSURE = 'app_private.network_center_ensure_raw_partitions_v1';

function fn(sql, name) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  const open = sql.indexOf('$fn$', start);
  const close = sql.indexOf('$fn$;', open + 4);
  if (start < 0 || open < 0 || close < 0) throw new Error(`không thấy ${name}`);
  return sql.slice(start, close + 5);
}
const bodyOf = (sql) => { const create = fn(sql, ENSURE); return create.slice(create.indexOf('$fn$') + 4, create.length - 5); };
const md5 = (text) => createHash('md5').update(text.replaceAll('\r', ''), 'utf8').digest('hex');

const PARENTS = ['network_device_samples', 'network_interface_samples'];
const partitions = (days) => days.flatMap((day) => PARENTS.map((parent) => `${parent}_${day.replaceAll('-', '')}`));
const EXISTING = partitions(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
const FRESH = partitions(['2026-11-05', '2026-11-06']);

let db;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA app_private;
    CREATE TABLE public.network_device_samples(organization_id uuid NOT NULL, observed_at timestamptz NOT NULL, note text)
      PARTITION BY RANGE (observed_at);
    CREATE TABLE public.network_interface_samples(organization_id uuid NOT NULL, observed_at timestamptz NOT NULL, note text)
      PARTITION BY RANGE (observed_at);
    -- Như Supabase: bảng mới trong public tự cấp quyền cho ba vai API, nên bảng con mới phải đi qua REVOKE.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;`);
  await db.exec(fn(OLD, ENSURE));
  await db.exec(`REVOKE ALL ON FUNCTION ${ENSURE}(date, date) FROM PUBLIC, anon, authenticated, service_role`);
  // Bảng con có sẵn như production: đã bật RLS, ACL chỉ còn chủ.
  await db.exec(`SELECT ${ENSURE}('2026-11-01', '2026-11-04')`);
});
afterAll(async () => { await db?.close(); });

const STATE = `SELECT c.relname, c.relrowsecurity AS rls, c.xmin::text AS xmin,
    ARRAY(SELECT DISTINCT CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END
            FROM (SELECT (aclexplode(c.relacl)).grantee
                  UNION ALL
                  SELECT (aclexplode(a.attacl)).grantee FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL) g
           WHERE g.grantee = 0 OR pg_get_userbyid(g.grantee) IN ('anon', 'authenticated', 'service_role')
           ORDER BY 1) AS api_grants
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[])`;

// Một ca = một giao dịch: (tuỳ) thay thân hàm, (tuỳ) làm hỏng bảng con, chụp xmin, gọi hàm, đo, ROLLBACK.
async function probe({ from = '2026-11-01', through = '2026-11-04', body = null, setup = null, watch = EXISTING } = {}) {
  await db.exec('BEGIN');
  try {
    if (body) await db.exec(body);
    if (setup) await db.exec(setup);
    const before = Object.fromEntries((await db.query(STATE, [watch])).rows.map((r) => [r.relname, r.xmin]));
    await db.query(`SELECT ${ENSURE}($1::date, $2::date)`, [from, through]);
    const after = (await db.query(STATE, [watch])).rows;
    const { rows: locks } = await db.query(`SELECT c.relname FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
       WHERE l.pid = pg_backend_pid() AND l.mode = 'AccessExclusiveLock' AND c.relname = ANY ($1::text[])`, [watch]);
    return {
      locked: locks.map((r) => r.relname).sort(),
      rewritten: after.filter((r) => before[r.relname] !== undefined && before[r.relname] !== r.xmin).map((r) => r.relname).sort(),
      state: Object.fromEntries(after.map((r) => [r.relname, { rls: r.rls, grants: r.api_grants }])),
    };
  } finally { await db.exec('ROLLBACK'); }
}
const ok = (state, names) => names.every((name) => state[name]?.rls === true && state[name].grants.length === 0);

test('md5 trong chốt khớp thân 20260729020000 (= production) và thân mới', () => {
  expect(md5(bodyOf(OLD))).toBe('cad87e767538761a3b8623abae0d35be');
  expect(FIX).toContain(`'cad87e767538761a3b8623abae0d35be'`);
  expect(FIX.split(`'${md5(bodyOf(FIX))}'`).length - 1).toBe(2); // chốt đầu + nghiệm thu
});

test('TRƯỚC vá: bảng con đã đủ điều kiện vẫn bị ALTER — lấy AccessExclusiveLock và ghi lại pg_class', async () => {
  const r = await probe();
  expect(ok(r.state, EXISTING)).toBe(true);
  expect(r.locked).toEqual([...EXISTING].sort());
  expect(r.rewritten).toEqual([...EXISTING].sort());
});

test('chốt đầu từ chối thân lạ (không phải 20260729020000 hay bản vá)', async () => {
  const chot = FIX.slice(FIX.indexOf('DO $chot$'), FIX.indexOf('$chot$;') + 7);
  await db.exec('BEGIN');
  try {
    await db.exec(fn(OLD, ENSURE).replace('v_day := p_from;', 'v_day := p_from; -- ai đó sửa tay'));
    await expect(db.exec(chot)).rejects.toThrow(/khong con la ban 20260729020000/);
  } finally { await db.exec('ROLLBACK'); }
});

test('migration chạy hai lượt (idempotent), giữ definer/volatile/config và không mở EXECUTE', async () => {
  await db.exec(FIX);
  await db.exec(FIX);
  const { rows } = await db.query(`SELECT md5(replace(p.prosrc, chr(13), '')) AS md5, p.prosecdef, p.provolatile, p.proconfig,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
      has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
    FROM pg_proc p WHERE p.oid = to_regprocedure('${ENSURE}(date,date)')`);
  expect(rows[0]).toEqual({
    md5: md5(bodyOf(FIX)), prosecdef: true, provolatile: 'v',
    proconfig: ['search_path=pg_catalog, app_private, public', 'TimeZone=UTC'],
    anon: false, auth: false, service: false,
  });
});

// Mỗi vị từ đo một lời hứa của bản vá; `body` thay thân hàm trong giao dịch dò (đột biến).
const skipsReady = async (body) => {
  const r = await probe({ body });
  return r.locked.length === 0 && r.rewritten.length === 0 && ok(r.state, EXISTING);
};
const createsFresh = async (body) => {
  const r = await probe({ body, from: '2026-11-04', through: '2026-11-06', watch: FRESH });
  // Bảng con mới thật sự được tạo trong lượt dò này (có khoá tạo bảng), không phải có sẵn từ ca khác.
  return ok(r.state, FRESH) && Object.keys(r.state).length === FRESH.length && r.locked.length === FRESH.length;
};
const healsRls = async (body) => {
  const r = await probe({ body, setup: 'ALTER TABLE public.network_device_samples_20261101 DISABLE ROW LEVEL SECURITY' });
  return ok(r.state, EXISTING);
};
// Đủ bốn bên nhận mà REVOKE cũ thu (service_role có BYPASSRLS nên sót nó là lộ), mỗi bên một bảng con.
const GRANTEES = ['PUBLIC', 'anon', 'authenticated', 'service_role'];
const healsTableGrant = async (body) => {
  const setup = GRANTEES.map((grantee, i) => `GRANT SELECT ON public.${EXISTING[i]} TO ${grantee}`).join(';\n');
  const r = await probe({ body, setup });
  return ok(r.state, EXISTING);
};
const healsColumnGrant = async (body) => {
  const setup = GRANTEES.map((grantee, i) => `GRANT SELECT (note) ON public.${EXISTING[i + 4]} TO ${grantee}`).join(';\n');
  const r = await probe({ body, setup });
  return ok(r.state, EXISTING);
};

test('SAU vá: bảng con đã đủ điều kiện ⇒ không lấy khoá, không ghi lại pg_class', async () => {
  expect(await skipsReady()).toBe(true);
});

test('SAU vá: bảng con mới vẫn được tạo, bật RLS và thu quyền mặc định của vai API', async () => {
  expect(await createsFresh()).toBe(true);
});

test('SAU vá: tự vá khi RLS bị tắt, quyền bảng hoặc quyền cột bị cấp lại', async () => {
  expect(await healsRls()).toBe(true);
  expect(await healsTableGrant()).toBe(true);
  expect(await healsColumnGrant()).toBe(true);
});

test('SAU vá: lỗi khoảng ngày giữ nguyên thông báo và mã 22023', async () => {
  const call = (from, through) => db.query(`SELECT ${ENSURE}($1::date, $2::date)`, [from, through]);
  await expect(call(null, '2026-11-01')).rejects.toMatchObject({ code: '22023', message: 'Invalid Network Center partition range' });
  await expect(call('2026-11-02', '2026-11-01')).rejects.toMatchObject({ code: '22023', message: 'Invalid Network Center partition range' });
  await expect(call('2026-11-01', '2027-01-03')).rejects.toMatchObject({ code: '22023', message: 'Network Center partition range exceeds 63 days' });
  // Biên 63 ngày vẫn chạy; ROLLBACK để không để lại bảng con cho các ca sau.
  await db.exec('BEGIN');
  try {
    await expect(call('2026-11-01', '2027-01-02')).resolves.toBeDefined();
  } finally { await db.exec('ROLLBACK'); }
});

test('đột biến: bỏ từng vế của phép kiểm thì vị từ tương ứng phải đỏ', async () => {
  const create = fn(FIX, ENSURE);
  const cut = (from, to) => {
    const start = create.indexOf(from);
    const end = create.indexOf(to, start) + to.length;
    if (start < 0 || end < to.length) throw new Error(`không thấy đoạn đột biến ${from}`);
    return create.slice(0, start) + create.slice(end);
  };
  const mutate = (from, to) => { if (!create.includes(from)) throw new Error(`không thấy ${from}`); return create.replace(from, to); };
  // Đột biến trong đúng một vế: lần xuất hiện đầu tiên của `from` sau mốc `anchor`.
  const mutateIn = (anchor, from, to) => {
    const at = create.indexOf(from, create.indexOf(anchor));
    if (create.indexOf(anchor) < 0 || at < 0) throw new Error(`không thấy ${from} sau ${anchor}`);
    return create.slice(0, at) + to + create.slice(at + from.length);
  };
  const TABLE = 'FROM aclexplode(c.relacl)';
  const COLUMN = 'FROM pg_attribute att';
  const mutants = [
    ['bảng: sót PUBLIC', mutateIn(TABLE, 'acl.grantee = 0\n                 OR ', ''), healsTableGrant],
    ['bảng: sót anon', mutateIn(TABLE, "'anon', ", ''), healsTableGrant],
    ['bảng: sót authenticated', mutateIn(TABLE, "'authenticated', ", ''), healsTableGrant],
    ['bảng: sót service_role', mutateIn(TABLE, ", 'service_role'", ''), healsTableGrant],
    ['cột: sót PUBLIC', mutateIn(COLUMN, 'acl.grantee = 0\n                     OR ', ''), healsColumnGrant],
    ['cột: sót anon', mutateIn(COLUMN, "'anon', ", ''), healsColumnGrant],
    ['cột: sót authenticated', mutateIn(COLUMN, "'authenticated', ", ''), healsColumnGrant],
    ['cột: sót service_role', mutateIn(COLUMN, ", 'service_role'", ''), healsColumnGrant],
    ['luôn chạy ba lệnh như cũ', mutate('IF NOT EXISTS (', 'IF true OR NOT EXISTS ('), skipsReady],
    ['bỏ vế RLS', mutate('AND c.relrowsecurity', ''), healsRls],
    ['bỏ vế quyền bảng', cut('AND NOT EXISTS (\n             SELECT 1\n               FROM aclexplode(c.relacl)', "'service_role'))\n           )"), healsTableGrant],
    ['bỏ vế quyền cột', cut('AND NOT EXISTS (\n             SELECT 1\n               FROM pg_attribute att', "'service_role')))\n           )"), healsColumnGrant],
    ['bỏ REVOKE', mutate("EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', v_name);", ''), createsFresh],
  ];
  for (const [name, body, predicate] of mutants) {
    expect(body, name).not.toBe(create);
    expect(await predicate(body), name).toBe(false);
  }
  // Thân thật vẫn đạt mọi vị từ (chạy lại qua cùng đường thay thân, loại trừ đỏ do chính đường dò).
  for (const predicate of [skipsReady, createsFresh, healsRls, healsTableGrant, healsColumnGrant]) {
    expect(await predicate(create)).toBe(true);
  }
});
