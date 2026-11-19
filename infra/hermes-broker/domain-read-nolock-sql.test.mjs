import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localCluster, setup, applyWebBuildingScope, applyEffectiveOutstanding, jwt, id, ORG, FOREIGN, USER, MEMBER, BUILDING, OTHER_BUILDING, ROLE,
  RECEIVABLES_OUTSTANDING_PATH } from './crm-shared-read-sql-fixture.mjs';
import { domainInput, domainResult } from './domain-contract.mjs';

// Lượt 15 Thu chi (24/10/2026; nghiệm thu lượt cuối C3d trên TEST): crm_read_income_expenses {status:UNAPPROVED, limit:50} không lọc toà ⇒
// backend_unavailable hai lần; journal connector: finalizeMs 8457/8562 = trần statement_timeout 8 s ⇒ câu SQL hết giờ. Tái hiện tầng 2 (TEST,
// ROLLBACK): cùng lời gọi 154–899 ms ⇒ câu không chậm, nó CHỜ: bộ đọc miền v2 lấy kết nối qua hàm lệnh — khoá dòng công ty FOR NO KEY UPDATE
// và FOR SHARE phiên / kết nối / token / trợ lý / chính sách — nên xếp hàng sau mọi giao dịch ghi của cùng công ty tới hết trần.
// 20261024193001 trên PostgreSQL 16+/17 thật: (1) dữ liệu toàn công ty (ba toà + toà công ty khác + phiếu hạn chế / huỷ / xoá) đọc không
// lọc toà qua đủ các trang, khớp tập web, qua rào khuôn của connector; (2) một giao dịch khác giữ khoá dòng công ty (giao thức người ghi) hoặc
// khoá dòng phiên / kết nối ⇒ lượt đọc vẫn trả ngay — thân 20261021185540 (trước file) chờ tới hết trần (đỏ ở đó); (3) bản đọc kết nối từ
// chối y như hàm lệnh ở mọi trạng thái hỏng (kết nối thu hồi / không ACTIVE, token thu hồi / hết hạn / quá 30 ngày, phiên không ACTIVE /
// cách ly / hết hạn, trợ lý tắt, chính sách tắt, digest lạ / sai khuôn); (4) đột biến (thân cũ, thêm lại một khoá, bỏ một điều kiện kiểm)
// đều bị bắt; (5) $requires$ từ chối thân v2 lạ và thân hàm lệnh lạ; file chạy hai lần (idempotent). Dữ liệu tổng hợp.
const NOLOCK_PATH = 'supabase/migrations/20261024193001_hermes_domain_read_nolock_v1.sql';
const nolockSql = () => readFileSync(NOLOCK_PATH, 'utf8');
const between = (text, from, to) => { const start = text.indexOf(from); assert(start >= 0, from); return text.slice(start, text.indexOf(to, start) + to.length); };
const OLD_V2 = between(readFileSync(RECEIVABLES_OUTSTANDING_PATH, 'utf8').replace(/\r\n/g, '\n'), 'CREATE OR REPLACE FUNCTION public.hermes_domain_read_v2(', '\nEND $fn$;');
const NEW_HELPER = () => between(nolockSql().replace(/\r\n/g, '\n'), 'CREATE OR REPLACE FUNCTION app_private.hermes_read_connection_v1(', '\nEND $$;');
const NEW_V2 = () => between(nolockSql().replace(/\r\n/g, '\n'), 'CREATE OR REPLACE FUNCTION public.hermes_domain_read_v2(', '\nEND $fn$;');
const [B2, B3, ROOM2, ROOM3, FUND] = [500, 501, 502, 503, 504].map(id);
const voucher = n => id(1000 + n);
const sorted = values => [...values].sort();
async function apply(pool, sql) {
  const client = await pool.connect();
  try { await client.query(sql); } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
}
// Lượt đọc như connector (vai authenticated, claims sub + session_id), có trần riêng để đo việc chờ.
async function readOnce(pool, binding, input, { statementMs = 4000 } = {}) {
  const client = await pool.connect();
  const started = Date.now();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout='${statementMs}ms'`);
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claims',$2,true)",
      [USER, JSON.stringify({ sub: USER, role: 'authenticated', session_id: id(32) })]);
    await client.query('SET LOCAL ROLE authenticated');
    const value = (await client.query('SELECT public.hermes_domain_read_v2($1::jsonb,$2,$3::jsonb) value', [JSON.stringify(binding), 'income_expenses',
      JSON.stringify({ query: '', limit: 50, cursor: null, buildingId: null, status: null, fromDate: null, toDate: null, ...input })])).rows[0].value;
    await client.query('COMMIT');
    return { value, ms: Date.now() - started };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); error.ms = Date.now() - started; throw error; } finally { client.release(); }
}
// Giữ một khoá trong giao dịch riêng (như người ghi của công ty) trong lúc chạy work; luôn ROLLBACK.
async function holding(pool, lockSql, work) {
  const holder = await pool.connect();
  try { await holder.query('BEGIN'); await holder.query(lockSql); return await work(); } finally { await holder.query('ROLLBACK').catch(() => {}); holder.release(); }
}
// Kết quả của một hàm kết nối trên digest (chủ postgres, như bộ đọc DEFINER gọi): id kết nối hoặc mã lỗi + câu.
async function outcome(client, fn, digest) {
  await client.query('SAVEPOINT probe');
  try { const row = (await client.query(`SELECT (app_private.${fn}($1)).id::text v`, [digest])).rows[0].v; await client.query('RELEASE SAVEPOINT probe'); return `ok:${row}`; }
  catch (error) { await client.query('ROLLBACK TO SAVEPOINT probe'); return `${error.code}:${error.message}`; }
}

test('20261024193001: đọc thu chi toàn công ty không xếp hàng sau người ghi; bản đọc kết nối kiểm y như hàm lệnh; đột biến bị bắt', { timeout: 300000 }, async t => {
  const { pool, cleanup } = await localCluster(t); t.after(async () => { await pool.end(); cleanup(); });
  await setup(pool);
  await applyWebBuildingScope(pool);
  await applyEffectiveOutstanding(pool);
  const md5 = async sig => (await pool.query("SELECT md5(replace(prosrc,chr(13),'')) m FROM pg_proc WHERE oid=to_regprocedure($1)", [sig])).rows[0]?.m ?? null;
  assert.equal(await md5('public.hermes_domain_read_v2(jsonb,text,jsonb)'), 'cf03a9fc85f7e4fb4b5b0b8636ee0ef9', 'đúng thân production 24/10 (20261021185540)');
  assert.equal(await md5('app_private.hermes_private_command_connection_v1(text)'), '0a2c941da4c710154bb6d1830b9cfa70', 'đúng thân hàm lệnh production 24/10');

  // Ba toà của công ty (vai có buildings.view + income_expenses.view phạm vi ORGANIZATION), toà công ty khác; phiếu chờ duyệt rải ba toà,
  // phiếu đã duyệt / huỷ, phiếu hạn chế / lương / xoá (không thuộc miền), phiếu công ty khác.
  await pool.query(`INSERT INTO public.permission_definitions(key) VALUES('income_expenses.view') ON CONFLICT DO NOTHING;
  INSERT INTO app_private.hermes_capabilities VALUES('income_expenses.view','read',true) ON CONFLICT DO NOTHING;
  INSERT INTO public.role_permissions VALUES('${ORG}','${ROLE}','income_expenses.view','ALLOW');
  INSERT INTO public.buildings(id,organization_id,user_id,name,name_sort,code) VALUES('${B2}','${ORG}','${USER}','Toà hai','toa hai','T2'),('${B3}','${ORG}','${USER}','Toà ba','toa ba','T3');
  INSERT INTO public.rooms VALUES('${ROOM2}','${ORG}','${B2}','P201','p201',null),('${ROOM3}','${ORG}','${B3}','P301','p301',null);
  ALTER TABLE public.accounts ADD COLUMN user_id uuid;
  INSERT INTO public.accounts(id,organization_id) VALUES('${FUND}','${ORG}');
  CREATE TABLE public.income_expenses(id uuid PRIMARY KEY,organization_id uuid NOT NULL,user_id uuid,code text,
   type text NOT NULL CHECK(type IN('INCOME','EXPENSE')),name text NOT NULL,building_id uuid NOT NULL,room_id uuid,voucher_date date NOT NULL,
   total_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK(total_amount>=0),approval_status text NOT NULL DEFAULT 'APPROVED',
   has_restricted_item boolean NOT NULL DEFAULT false,salary_staff_id uuid,shareholder_id uuid,profit_manager_id uuid,
   account_id uuid,change_account_id uuid,rounding_account_id uuid,deleted_at timestamptz);
  INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,room_id,voucher_date,total_amount,approval_status,account_id)
   SELECT ('00000000-0000-4000-8000-'||lpad((1000+n)::text,12,'0'))::uuid,'${ORG}','${USER}',
     CASE WHEN n%7=0 THEN 'PC2610001' ELSE 'PC26'||lpad(n::text,5,'0') END,CASE WHEN n%5=0 THEN 'INCOME' ELSE 'EXPENSE' END,
     'Phiếu '||n||CASE WHEN n%9=0 THEN E'\\ndòng hai' ELSE '' END,(ARRAY['${BUILDING}','${B2}','${B3}']::uuid[])[1+n%3],
     CASE n%3 WHEN 1 THEN '${ROOM2}'::uuid WHEN 2 THEN '${ROOM3}'::uuid END,date '2026-01-01'+n,1000*n,
     CASE WHEN n<=57 THEN 'UNAPPROVED' WHEN n<=70 THEN 'APPROVED' ELSE 'CANCELLED' END,'${FUND}'
   FROM generate_series(1,75) n;
  INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,voucher_date,total_amount,approval_status,has_restricted_item,salary_staff_id,deleted_at) VALUES
   ('${voucher(90)}','${ORG}','${USER}','PC9','EXPENSE','Hạn chế','${B2}','2026-03-01',5,'UNAPPROVED',true,null,null),
   ('${voucher(91)}','${ORG}','${USER}','PC9','EXPENSE','Lương','${B2}','2026-03-01',5,'UNAPPROVED',false,'${USER}',null),
   ('${voucher(92)}','${ORG}','${USER}','PC9','EXPENSE','Đã xoá','${B3}','2026-03-01',5,'UNAPPROVED',false,null,now()),
   ('${voucher(93)}','${FOREIGN}','${USER}','PC9','EXPENSE','Công ty khác','${OTHER_BUILDING}','2026-03-01',5,'UNAPPROVED',false,null,null);
  ALTER TABLE public.income_expenses ENABLE ROW LEVEL SECURITY;
  CREATE POLICY income_expenses_select_rbac ON public.income_expenses FOR SELECT TO authenticated USING ((SELECT public.is_super_admin()) OR (SELECT public.is_admin())
   OR ((building_id IS NOT NULL) AND ((SELECT public.has_full_building_scope()) OR (building_id IN (SELECT public.accessible_building_ids())))));
  GRANT SELECT ON public.income_expenses TO authenticated;`);
  const prepared = await jwt(pool, async c => (await c.query("SELECT public.hermes_prepare_connection_v2($1,'{}','{}','unrestricted','{}') value", [ORG])).rows[0].value);
  const tokenDigest = 'd'.repeat(64);
  await pool.query('SELECT app_private.hermes_store_activate_v1($1::jsonb)', [JSON.stringify({ connectionId: prepared.id, expectedEpoch: 1, operationId: id(510),
    intentSecret: prepared.intentSecret, userId: USER, providerSessionId: id(32), credentialRef: id(511), tokenDigest, tokenExpiresAt: Date.now() + 600000,
    sessionExpiresAt: Date.now() + 3600000, sessionEnvelope: { v: 1, algorithm: 'A256GCM', keyVersion: 'fixture', nonce: 'a'.repeat(16), tag: 'a'.repeat(22), ciphertext: 'abcd' } })]);
  const bind7 = { connectionId: prepared.id, tokenDigest, expectedEpoch: 2, expectedSessionRevision: 1, expectedPolicyVersion: 0, expectedMembershipId: MEMBER, expectedAuthorizationVersion: 1 };
  const identity = { row: { id: prepared.id, userId: USER, organizationId: ORG }, scopesByPermission: { 'income_expenses.view': { buildingIds: sorted([BUILDING, B2, B3]), cashbookIds: [] } } };
  // Đọc hết các trang như connector (mỗi trang qua rào khuôn của connector).
  const allPages = async input => {
    const pages = []; let cursor = null;
    for (;;) {
      const { value, ms } = await readOnce(pool, bind7, { ...input, cursor });
      assert.doesNotThrow(() => domainResult('income_expenses', value, identity, domainInput('income_expenses', { limit: 50, ...input, ...(cursor ? { cursor } : {}) })),
        'rào khuôn của connector nhận trang');
      pages.push({ value, ms }); cursor = value.nextCursor; if (cursor === null) return pages;
    }
  };
  const UNAPPROVED = Array.from({ length: 57 }, (_, i) => voucher(i + 1));
  const webUnapproved = async () => jwt(pool, async c => (await c.query(`SELECT id FROM public.income_expenses WHERE organization_id=$1 AND deleted_at IS NULL
    AND approval_status='UNAPPROVED' AND NOT has_restricted_item AND salary_staff_id IS NULL AND shareholder_id IS NULL AND profit_manager_id IS NULL`, [ORG])).rows.map(r => r.id));
  const checkWholeCompany = async label => {
    const pages = await allPages({ status: 'UNAPPROVED' });
    assert.deepEqual(pages.map(p => p.value.items.length), [50, 7], `${label}: 57 phiếu chờ duyệt = trang 50 + trang 7`);
    assert.deepEqual(sorted(pages.flatMap(p => p.value.items.map(r => r.id))), sorted(UNAPPROVED), `${label}: đúng tập phiếu chờ duyệt của công ty`);
    assert.deepEqual(sorted(UNAPPROVED), sorted(await webUnapproved()), `${label}: khớp tập web (RLS)`);
    assert.equal(pages[0].value.summary.count, 57, `${label}: summary.count cả tập`);
    assert.deepEqual(sorted(new Set(pages.flatMap(p => p.value.items.map(r => r.buildingId)))), sorted([BUILDING, B2, B3]), `${label}: ba toà`);
    assert(pages.every(p => p.value.items.every(r => r.buildingName !== '' && !/[\n\r]/.test(r.name))), `${label}: tên toà có, tên phiếu sạch ký tự điều khiển`);
    const one = await allPages({ status: 'UNAPPROVED', buildingId: B2 });
    assert.deepEqual(sorted(one.flatMap(p => p.value.items.map(r => r.id))), sorted(UNAPPROVED.filter((_, i) => (i + 1) % 3 === 1)), `${label}: lọc một toà`);
  };

  // Các miền khác của bộ đọc v2 (công nợ — nguồn chép của lane nhanh, web-parity receivables-fast-read; chỉ số; lãi lỗ): cùng kết quả trước / sau.
  const otherDomains = async () => {
    const out = {};
    for (const [domain, input] of [['receivables', {}], ['receivables', { status: 'APPROVED' }], ['meter_readings', {}]]) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claims',$2,true)",
          [USER, JSON.stringify({ sub: USER, role: 'authenticated', session_id: id(32) })]);
        await client.query('SET LOCAL ROLE authenticated');
        const value = await client.query('SELECT public.hermes_domain_read_v2($1::jsonb,$2,$3::jsonb) value', [JSON.stringify(bind7), domain,
          JSON.stringify({ query: '', limit: 20, cursor: null, buildingId: null, status: null, fromDate: null, toDate: null, ...input })])
          .then(r => ({ ...r.rows[0].value, fetchedAt: null }), error => ({ error: error.code ?? error.message }));
        out[`${domain}:${JSON.stringify(input)}`] = value;
      } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
    }
    return out;
  };
  const otherBefore = await otherDomains();
  assert(otherBefore['receivables:{}'].items?.length >= 1, 'đối chứng: công nợ có dòng');

  // (1) Thân production (trước file): đọc toàn công ty đúng khi không ai giữ khoá …
  await checkWholeCompany('trước file');
  // … nhưng một người ghi của công ty đang giữ khoá dòng công ty (hoặc dòng phiên) ⇒ lượt đọc CHỜ tới hết trần (đỏ ở đây — sự cố TEST).
  const lockOrg = `SELECT app_private.lock_org_for_decision_v1('${ORG}')`;
  const lockSession = `SELECT 1 FROM app_private.hermes_sessions WHERE id='${id(511)}' FOR UPDATE`;
  const lockConnection = `SELECT 1 FROM app_private.hermes_connections WHERE id='${prepared.id}' FOR NO KEY UPDATE`;
  for (const [label, lock] of [['khoá công ty', lockOrg], ['khoá phiên', lockSession], ['khoá kết nối', lockConnection]]) {
    const error = await holding(pool, lock, () => readOnce(pool, bind7, { status: 'UNAPPROVED' }, { statementMs: 1500 }).then(() => null, e => e));
    assert.equal(error?.code, '57014', `trước file, ${label}: lượt đọc chờ tới hết trần (57014)`);
    assert(error.ms >= 1400, `trước file, ${label}: thật sự chờ (${error.ms} ms)`);
  }

  // (2) File, hai lần (idempotent): cùng kết quả, và không còn chờ người ghi.
  await apply(pool, nolockSql()); await apply(pool, nolockSql());
  assert.notEqual(await md5('public.hermes_domain_read_v2(jsonb,text,jsonb)'), 'cf03a9fc85f7e4fb4b5b0b8636ee0ef9');
  assert.equal(await md5('app_private.hermes_private_command_connection_v1(text)'), '0a2c941da4c710154bb6d1830b9cfa70', 'hàm lệnh không đổi (các thao tác ghi giữ giao thức người ghi)');
  await checkWholeCompany('sau file');
  assert.deepEqual(await otherDomains(), otherBefore, 'công nợ / chỉ số: cùng dòng, summary, cursor, lỗi như thân 185540 (nhánh byte-identical)');
  const noWait = async label => {
    for (const [what, lock] of [['khoá công ty', lockOrg], ['khoá phiên', lockSession], ['khoá kết nối', lockConnection]]) {
      const { value, ms } = await holding(pool, lock, () => readOnce(pool, bind7, { status: 'UNAPPROVED' }, { statementMs: 1500 }));
      assert.equal(value.items.length, 50, `${label}, ${what}: vẫn đọc được`);
      assert(ms < 1400, `${label}, ${what}: không chờ (${ms} ms)`);
    }
  };
  await noWait('sau file');
  // Ghim chéo: 20261021185540 ghim thân v2 ⇒ chạy lại sau file ngã đúng khối $requires$ (ngoại lệ pinned sau áp, câu kèm md5 thân mới).
  const v2Now = await md5('public.hermes_domain_read_v2(jsonb,text,jsonb)');
  assert.equal(v2Now, 'af47eb16c1227abfb46c7f16ba6476f5', 'md5 thân v2 của file (câu ngoại lệ pinned)');
  await assert.rejects(apply(pool, readFileSync(RECEIVABLES_OUTSTANDING_PATH, 'utf8')),
    error => error.message === `hermes_receivables_effective_requires_reviewed_v2: ${v2Now}`);

  // (3) Bản đọc kết nối từ chối y như hàm lệnh (cùng mã + câu) ở mọi trạng thái hỏng; trạng thái đúng ⇒ cùng kết nối.
  const STATES = [
    ['đúng', ''],
    ['kết nối thu hồi', `UPDATE app_private.hermes_connections SET revoked_at=now() WHERE id='${prepared.id}'`],
    ['kết nối không ACTIVE', `UPDATE app_private.hermes_connections SET state='REVOKED' WHERE id='${prepared.id}'`],
    ['token thu hồi', `UPDATE app_private.hermes_connection_tokens SET revoked_at=now() WHERE token_digest='${tokenDigest}'`],
    ['token hết hạn', `UPDATE app_private.hermes_connection_tokens SET expires_at=now()-interval '1 second' WHERE token_digest='${tokenDigest}'`],
    ['token quá 30 ngày', `UPDATE app_private.hermes_connection_tokens SET created_at=now()-interval '31 days' WHERE token_digest='${tokenDigest}'`],
    ['phiên cần kết nối lại', `UPDATE app_private.hermes_sessions SET state='RECONNECT_REQUIRED',quarantine_reason='refresh_uncertain',envelope=NULL,
      staged_envelope=NULL,staged_expires_at=NULL WHERE id='${id(511)}'`],
    ['phiên thu hồi (cách ly)', `UPDATE app_private.hermes_sessions SET state='REVOKED',quarantine_reason='session_revoked',envelope=NULL,staged_envelope=NULL,
      staged_expires_at=NULL WHERE id='${id(511)}'`],
    ['phiên hết hạn', `UPDATE app_private.hermes_sessions SET expires_at=now()-interval '1 second' WHERE id='${id(511)}'`],
    ['trợ lý tắt', `UPDATE app_private.hermes_assistants SET state='DISABLED' WHERE id=(SELECT assistant_id FROM app_private.hermes_connections WHERE id='${prepared.id}')`],
    // Công ty chưa có dòng chính sách (version 0 = mặc định bật): dòng tắt do chủ ghi.
    ['chính sách tắt', `INSERT INTO app_private.hermes_org_policies(organization_id,enabled,updated_by) VALUES('${ORG}',false,'${USER}')
      ON CONFLICT (organization_id) DO UPDATE SET enabled=false`],
  ];
  const compare = async (states, digests) => {
    const client = await pool.connect(); const rows = [];
    try {
      for (const [label, change] of states) {
        await client.query('BEGIN');
        try {
          if (change) {
            await client.query('SAVEPOINT change');
            try { const done = await client.query(change); await client.query('RELEASE SAVEPOINT change'); if (done.rowCount !== 1) { rows.push([label, 'bỏ qua']); continue; } }
            catch { await client.query('ROLLBACK TO SAVEPOINT change'); rows.push([label, 'bỏ qua']); continue; }
          }
          for (const digest of digests) rows.push([label, digest.slice(0, 4), await outcome(client, 'hermes_private_command_connection_v1', digest), await outcome(client, 'hermes_read_connection_v1', digest)]);
        } finally { await client.query('ROLLBACK'); }
      }
    } finally { client.release(); }
    return rows;
  };
  const digests = [tokenDigest, 'e'.repeat(64), 'KHONG-PHAI-DIGEST'];
  const rows = await compare(STATES, digests);
  assert.deepEqual(rows.filter(r => r[1] === 'bỏ qua'), [], 'mọi trạng thái hỏng dựng được trên fixture');
  for (const [label, digest, command, read] of rows) assert.equal(read, command, `${label} / ${digest}: bản đọc = hàm lệnh`);
  assert.equal(rows.find(r => r[0] === 'đúng' && r[1] === 'dddd')[3], `ok:${prepared.id}`);
  assert.equal(new Set(rows.filter(r => r[0] !== 'đúng' && r[1] === 'dddd').map(r => r[3].split(':')[0])).size, 1, 'mọi trạng thái hỏng ⇒ 42501');
  assert(rows.filter(r => r[0] !== 'đúng' && r[1] === 'dddd').every(r => r[3].startsWith('42501:hermes_command_denied')));

  // (4) Đột biến: (a) thân v2 cũ ⇒ lại chờ; (b) bản đọc thêm lại một khoá ⇒ lại chờ; (c) bản đọc bỏ một điều kiện ⇒ lệch hàm lệnh.
  await apply(pool, OLD_V2);
  const regained = await holding(pool, lockOrg, () => readOnce(pool, bind7, { status: 'UNAPPROVED' }, { statementMs: 1500 }).then(() => null, e => e));
  assert.equal(regained?.code, '57014', 'đột biến thân v2 cũ: lượt đọc lại chờ khoá công ty');
  await apply(pool, NEW_V2());
  const helper = NEW_HELPER();
  const locked = helper.replace("  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref;\n",
    () => "  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref FOR SHARE;\n");
  assert.notEqual(locked, helper);
  await apply(pool, locked.replace('LANGUAGE plpgsql STABLE', 'LANGUAGE plpgsql VOLATILE'));
  const relocked = await holding(pool, lockSession, () => readOnce(pool, bind7, { status: 'UNAPPROVED' }, { statementMs: 1500 }).then(() => null, e => e));
  assert.equal(relocked?.code, '57014', 'đột biến thêm FOR SHARE vào bản đọc: lượt đọc lại chờ khoá phiên');
  const weaker = helper.replace(' OR c.revoked_at IS NOT NULL', () => '');
  assert.notEqual(weaker, helper);
  await apply(pool, weaker);
  const drift = (await compare(STATES, [tokenDigest])).filter(([, , command, read]) => read !== command).map(r => r[0]);
  assert.deepEqual(drift, ['kết nối thu hồi'], 'đột biến bỏ kiểm revoked_at: bản đọc lệch hàm lệnh đúng ở trạng thái đó');
  await apply(pool, helper);
  assert.deepEqual((await compare(STATES, [tokenDigest])).filter(([, , command, read]) => read !== command), [], 'khôi phục: khớp lại');

  // (5) $requires$: thân v2 lạ, thân hàm lệnh lạ, bản đọc lạ ⇒ dừng, không đổi gì; thân của file ⇒ chạy lại được.
  const foreignV2 = OLD_V2.replace("permission:=CASE p_domain", () => "permission:=NULL; permission:=CASE p_domain");
  await apply(pool, foreignV2);
  await assert.rejects(apply(pool, nolockSql()), /hermes_domain_read_nolock_requires_reviewed_v2/);
  await apply(pool, NEW_V2());
  await apply(pool, weaker);
  await assert.rejects(apply(pool, nolockSql()), /hermes_domain_read_nolock_read_connection_drift/);
  await apply(pool, helper);
  const command = (await pool.query("SELECT pg_get_functiondef('app_private.hermes_private_command_connection_v1(text)'::regprocedure) d")).rows[0].d;
  await apply(pool, command.replace("THEN RAISE EXCEPTION 'hermes_command_denied' USING ERRCODE='42501'; END IF;\n  RETURN c;", () => "THEN RAISE EXCEPTION 'hermes_command_denied' USING ERRCODE='42501'; END IF;\n  RETURN c; -- lạ"));
  await assert.rejects(apply(pool, nolockSql()), /hermes_domain_read_nolock_requires_reviewed_command_connection/);
  await apply(pool, command);
  await apply(pool, nolockSql());
  await noWait('sau khi chạy lại');

  // ACL: bản đọc không có quyền gọi trực tiếp; v2 giữ đúng ACL cũ.
  const acl = (await pool.query(`SELECT has_function_privilege('authenticated','app_private.hermes_read_connection_v1(text)','EXECUTE') a,
    has_function_privilege('anon','app_private.hermes_read_connection_v1(text)','EXECUTE') b,
    has_function_privilege('authenticated','public.hermes_domain_read_v2(jsonb,text,jsonb)','EXECUTE') c,
    has_function_privilege('anon','public.hermes_domain_read_v2(jsonb,text,jsonb)','EXECUTE') d`)).rows[0];
  assert.deepEqual(acl, { a: false, b: false, c: true, d: false });
});
