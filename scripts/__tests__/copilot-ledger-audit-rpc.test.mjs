import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { doiChieuSo } from '../copilot-ledger-audit.mjs';
const migration = new URL('../../supabase/migrations/20260906144028_copilot_ledger_audit_read_v1.sql', import.meta.url);
const forwardMigration = new URL('../../supabase/migrations/20260906170939_copilot_ledger_legacy_identity_v1.sql', import.meta.url);
const deployedSql = () => readFileSync(migration, 'utf8') + '\n' + readFileSync(forwardMigration, 'utf8');
const org = 'dddd0000-0000-4000-8000-000000000001';
const other = 'cccc0000-0000-4000-8000-000000000001';
const actor = 'dddd2000-0000-4000-8000-000000000001';
async function setup() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$SELECT current_setting('test.super',true)='yes'$$;
    CREATE TABLE app_private.copilot_action_registry(action_id text, executor_kind text, risk text, grantable boolean, pin_always boolean, produces_entity_table text,
      version int DEFAULT 1, permission_key text, consent_required text, preview_rpc text, execute_rpc text, verify_kind text);
    CREATE TABLE app_private.copilot_plans(id uuid, user_id uuid, organization_id uuid, consent_kind text, step_up_confirmation_id uuid, standing_grant_ids uuid[]);
    CREATE TABLE app_private.copilot_plan_steps(plan_id uuid, step_no int, action_id text, status text, executed_at timestamptz, ledger_id uuid);
    CREATE TABLE app_private.copilot_action_ledger(id uuid, created_at timestamptz, organization_id uuid, user_id uuid, event text, action_id text, plan_id uuid, step_no int, consent_kind text, step_up_id uuid, entity_table text, entity_id uuid, audit_id uuid, outcome jsonb, after_digest bytea);
    CREATE TABLE app_private.copilot_write_confirmations(id uuid, user_id uuid, organization_id uuid, tool text, permission_key text, consumed_at timestamptz, expires_at timestamptz);
    CREATE TABLE app_private.copilot_standing_grants(id uuid, organization_id uuid, granter_user_id uuid, action_id text, created_at timestamptz, expires_at timestamptz, revoked_at timestamptz);
    CREATE TABLE public.ai_write_audit(id uuid, created_at timestamptz, organization_id uuid, user_id uuid, tool text, entity_table text, entity_id uuid, idempotency_key text, payload jsonb);
    CREATE TABLE public.customers(id uuid, organization_id uuid);
    INSERT INTO app_private.copilot_action_registry(action_id,executor_kind,risk,grantable,pin_always,produces_entity_table) VALUES ('future.new_action','direct_l5_v1','L5',false,false,'customers');
    SELECT set_config('request.jwt.claim.sub','${actor}',false); SELECT set_config('test.super','yes',false);`);
  try { await db.exec(deployedSql()); }
  catch (e) { await db.close(); throw e; }
  return db;
}
async function page(db, stream = 'ledger', after = null) {
  return (await db.query(`SELECT public.copilot_ledger_audit_page_v1($1::uuid,'2026-09-01','2026-09-06',$2,$3::timestamptz,$4::uuid,200) AS data`, [org, stream, after?.created_at ?? null, after?.id ?? null])).rows[0].data;
}
test('RPC rejects anonymous and authenticated non-admin callers using actual roles', async () => {
  const db = await setup();
  try {
    await db.exec(deployedSql()); // Idempotent re-application in this disposable catalog.
    const acl = (await db.query(`SELECT has_function_privilege('service_role','public.copilot_ledger_audit_page_v1(uuid,timestamptz,timestamptz,text,timestamptz,uuid,integer)','EXECUTE') allowed`)).rows[0];
    assert.equal(acl.allowed,false);
    for (const role of ['anon','authenticated','service_role']) {
      const r=(await db.query(`SELECT has_function_privilege($1,'app_private.copilot_audit_action_identity_v1(text,text,uuid)','EXECUTE') allowed`,[role])).rows[0];
      assert.equal(r.allowed,false,`private resolver inaccessible to ${role}`);
    }
    for (const [name,tag,definer] of [['copilot_ledger_audit_page_v1','function',true],['copilot_audit_action_identity_v1','identity',false]]) {
      const r=(await db.query(`SELECT prosrc,provolatile,prosecdef,proconfig FROM pg_proc WHERE proname=$1`,[name])).rows[0];
      const body=readFileSync(forwardMigration,'utf8').split(`$${tag}$`)[1];
      assert.equal(r.prosrc,body,'catalog must contain exact final forward definition');
      assert.equal(r.provolatile,'s'); assert.equal(r.prosecdef,definer);
      assert.ok(r.proconfig.some(x=>x.startsWith('search_path=pg_catalog,')));
    }
    await db.exec('SET ROLE anon'); await assert.rejects(page(db), /permission denied/);
    await db.exec("RESET ROLE; SELECT set_config('test.super','no',false); SET ROLE authenticated");
    await assert.rejects(page(db), /superadmin_required/);
    await db.exec("RESET ROLE; SELECT set_config('test.super','yes',false); SELECT set_config('request.jwt.claim.sub','',false); SET ROLE authenticated");
    await assert.rejects(page(db), /superadmin_required/);
  } finally { await db.close(); }
});
test('SQL and JS together accept a consented write, reject missing reverse coverage, and keep bounds exact', async () => {
  const db = await setup();
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const client = { async rpc(jwt, name, a) {
    try { return { status: 200, body: (await db.query(`SELECT public.copilot_ledger_audit_page_v1($1::uuid,$2::timestamptz,$3::timestamptz,$4,$5::timestamptz,$6::uuid,$7::integer) data`, [a.p_organization_id,a.p_since,a.p_until,a.p_stream,a.p_after_at,a.p_after_id,a.p_limit])).rows[0].data }; }
    catch (e) { throw e; }
  } };
  const bounds = {org, since:'2026-09-01T00:00:00Z',until:'2026-09-06T00:00:00Z'};
  try {
    await db.exec(`INSERT INTO public.customers VALUES ('${id(1)}','${org}');
      INSERT INTO app_private.copilot_plans(id,user_id,organization_id,consent_kind,step_up_confirmation_id) VALUES ('${id(2)}','${actor}','${org}','step_up','${id(3)}');
      INSERT INTO app_private.copilot_write_confirmations VALUES ('${id(3)}','${actor}','${org}','step_up','copilot.step_up','2026-09-02','2026-09-04');
      INSERT INTO public.ai_write_audit VALUES ('${id(4)}','2026-09-03','${org}','${actor}','future.new_action','customers','${id(1)}','opaque-digest-key','{"payload":"secret"}');
      INSERT INTO app_private.copilot_action_ledger(id,created_at,organization_id,user_id,event,action_id,plan_id,step_no,consent_kind,step_up_id,entity_table,entity_id,audit_id,outcome,after_digest) VALUES
      ('${id(5)}','2026-09-03','${org}','${actor}','action_executed','future.new_action',null,null,'click',null,'customers','${id(1)}','${id(4)}','{"status":"da_thuc_hien"}',decode('aa','hex')),
      ('${id(6)}','2026-09-03 00:00:00.000001+00','${org}','${actor}','step_done','future.new_action','${id(2)}',1,'step_up','${id(3)}','customers','${id(1)}','${id(4)}','{"idempotent":false}',decode('aa','hex'));
      INSERT INTO app_private.copilot_plan_steps VALUES ('${id(2)}',1,'future.new_action','DONE','2026-09-03','${id(6)}');
      SET ROLE authenticated;`);
    const r = await doiChieuSo(client,'jwt',bounds);
    assert.equal(r.status,'clean',JSON.stringify(r)); assert.equal(r.ledgerRowsInWindow,2); assert.equal(r.auditRowsInWindow,1);
    assert.equal(JSON.stringify(await page(db,'audit')).includes('opaque-digest-key'),false);
    await db.exec(`RESET ROLE; INSERT INTO app_private.copilot_plan_steps VALUES ('${id(2)}',2,'future.new_action','DONE','2026-09-03',null); SET ROLE authenticated;`);
    assert.equal((await doiChieuSo(client,'jwt',bounds)).status,'incomplete');
    const empty = await doiChieuSo(client,'jwt',{org,since:'2026-09-04T00:00:00Z',until:'2026-09-05T00:00:00Z'});
    assert.equal(empty.ledgerRowsInWindow,0); assert.equal(empty.auditRowsInWindow,0);
  } finally { await db.close(); }
});
test('RPC keyset reads all equal timestamp rows, excludes global and unrelated sandbox rows, no secrets', async () => {
  const db = await setup();
  try {
    await db.exec(`INSERT INTO app_private.copilot_action_ledger(id,created_at,organization_id,user_id,event,action_id,after_digest,outcome)
      SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'2026-09-03 00:00:00.123456+00','${org}','${actor}','plan_created',null,decode('abcdef','hex'),'{"secret":"hidden"}' FROM generate_series(1,451) i;
      INSERT INTO app_private.copilot_action_ledger(id,created_at,organization_id,event) VALUES (gen_random_uuid(),'2026-09-03',null,'policy_changed'),(gen_random_uuid(),'2026-09-03','${other}','plan_created');
      SET ROLE authenticated; BEGIN READ ONLY;`);
    let cursor, ids = [];
    while (true) { const p = await page(db, 'ledger', cursor); assert.equal(p.total,451); ids.push(...p.rows.map(r=>r.id)); if(p.rows.length<200)break; cursor=p.rows.at(-1); }
    assert.equal(ids.length,451); assert.equal(new Set(ids).size,451);
    const p = await page(db); const text=JSON.stringify(p);
    assert.equal(text.includes('abcdef'),false); assert.equal(text.includes('hidden'),false); assert.equal(text.includes(other),false);
    assert.equal(p.rows[0].created_at.includes('123456'),true);
    await db.exec('ROLLBACK');
  } finally { await db.close(); }
});
test('RPC reports plan actor/org and authoritative entity mismatches without exposing other org IDs', async () => {
  const db = await setup();
  try {
    await db.exec(`INSERT INTO public.customers VALUES ('00000000-0000-4000-8000-000000000002','${other}');
      INSERT INTO app_private.copilot_plans(id,user_id,organization_id,consent_kind) VALUES ('00000000-0000-4000-8000-000000000003','${other}','${other}','click');
      INSERT INTO app_private.copilot_action_ledger(id,created_at,organization_id,user_id,event,action_id,plan_id,entity_table,entity_id,consent_kind)
      VALUES ('00000000-0000-4000-8000-000000000001','2026-09-03','${org}','${actor}','step_done','future.new_action','00000000-0000-4000-8000-000000000003','customers','00000000-0000-4000-8000-000000000002','step_up'); SET ROLE authenticated;`);
    const p=await page(db), r=p.rows[0];
    assert.equal(r.plan_actor_matches,false); assert.equal(r.plan_org_matches,false); assert.equal(r.entity_evidence,'mismatch');
    assert.equal(JSON.stringify(p).includes(other),false);
  } finally { await db.close(); }
});
test('both streams include lower bound and exclude upper bound', async () => {
  const db=await setup();
  try {
    await db.exec(`INSERT INTO public.ai_write_audit(id,created_at,organization_id,tool,idempotency_key) VALUES
      (gen_random_uuid(),'2026-09-01','${org}','future.new_action','key-one'),
      (gen_random_uuid(),'2026-09-06','${org}','future.new_action','key-two');
      INSERT INTO app_private.copilot_action_ledger(id,created_at,organization_id,event)
      SELECT id,created_at,organization_id,'plan_created' FROM public.ai_write_audit; SET ROLE authenticated;`);
    assert.equal((await page(db,'ledger')).total,1);
    assert.equal((await page(db,'audit')).total,1);
    assert.equal((await page(db,'audit')).rows.length,1);
    await assert.rejects(db.query(`SELECT public.copilot_ledger_audit_page_v1($1::uuid,'2026-09-06','2026-09-01')`,[org]), /invalid_audit_window_or_cursor/);
  } finally {await db.close();}
});
test('actual external queue/reconciliation shapes inspect consent, origin evidence and pending status', async () => {
  const db=await setup();
  const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const client={async rpc(jwt,name,a){return {status:200,body:(await db.query(`SELECT public.copilot_ledger_audit_page_v1($1::uuid,$2::timestamptz,$3::timestamptz,$4,$5::timestamptz,$6::uuid,$7::integer) data`,[a.p_organization_id,a.p_since,a.p_until,a.p_stream,a.p_after_at,a.p_after_id,a.p_limit])).rows[0].data};}};
  const run=()=>doiChieuSo(client,'jwt',{org,since:'2026-09-01T00:00:00Z',until:'2026-09-06T00:00:00Z'});
  try {
    await db.exec(`CREATE TABLE public.zalo_send_queue(id uuid,organization_id uuid,status text);
      UPDATE app_private.copilot_action_registry SET action_id='zalo.phat_song',produces_entity_table='zalo_send_queue';
      INSERT INTO public.zalo_send_queue VALUES ('${id(1)}','${org}','pending');
      INSERT INTO app_private.copilot_plans(id,user_id,organization_id,consent_kind,step_up_confirmation_id) VALUES ('${id(2)}','${actor}','${org}','step_up','${id(3)}');
      INSERT INTO app_private.copilot_write_confirmations VALUES ('${id(3)}','${actor}','${org}','step_up','copilot.step_up','2026-09-02','2026-09-04');
      INSERT INTO public.ai_write_audit VALUES ('${id(4)}','2026-09-03','${org}','${actor}','zalo.phat_song','zalo_send_queue','${id(1)}','queue-key','{}');
      INSERT INTO app_private.copilot_action_ledger(id,created_at,organization_id,user_id,event,action_id,plan_id,step_no,consent_kind,step_up_id,entity_table,entity_id,audit_id,outcome,after_digest) VALUES
      ('${id(5)}','2026-09-03','${org}','${actor}','action_executed','zalo.phat_song',null,null,'click',null,'zalo_send_queue','${id(1)}','${id(4)}','{"status":"da_thuc_hien"}',decode('aa','hex')),
      ('${id(6)}','2026-09-03 00:00:00.000001+00','${org}','${actor}','step_unknown_effect','zalo.phat_song','${id(2)}',1,'step_up','${id(3)}','zalo_send_queue','${id(1)}','${id(4)}','{"idempotent":false,"step_status":"UNKNOWN_EFFECT"}',decode('aa','hex'));
      INSERT INTO app_private.copilot_plan_steps VALUES ('${id(2)}',1,'zalo.phat_song','UNKNOWN_EFFECT','2026-09-03','${id(6)}'); SET ROLE authenticated;`);
    const pending=await run(); assert.equal(pending.status,'incomplete'); assert.equal(pending.externalEffects.pending,1,'pending effect must remain visible');
    await db.exec(`RESET ROLE; UPDATE public.zalo_send_queue SET status='sent';
      INSERT INTO app_private.copilot_action_ledger(id,created_at,organization_id,user_id,event,action_id,plan_id,step_no,consent_kind,step_up_id,outcome) VALUES
      ('${id(7)}','2026-09-04','${org}','${actor}','step_reconciled','zalo.phat_song','${id(2)}',1,'step_up','${id(3)}','{"reconciled_status":"DONE","entity_table":"zalo_send_queue","entity_id":"${id(1)}"}');
      UPDATE app_private.copilot_plan_steps SET status='DONE',ledger_id='${id(7)}'; SET ROLE authenticated;`);
    const valid=await run(); assert.equal(valid.status,'clean',`valid reconciliation chain must be clean: ${JSON.stringify(valid)}`); assert.equal(valid.externalEffects.reconciledDone,1);
    await db.exec(`RESET ROLE; UPDATE app_private.copilot_action_ledger SET consent_kind='click' WHERE event='step_unknown_effect'; SET ROLE authenticated;`);
    assert.ok((await run()).counts.unintendedWrite>0,'external origin consent must be checked');
    await db.exec(`RESET ROLE; UPDATE app_private.copilot_action_ledger SET consent_kind='step_up',audit_id=null,after_digest=null WHERE event='step_unknown_effect'; SET ROLE authenticated;`);
    assert.equal((await run()).status,'incomplete','missing origin evidence must not green');
    await db.exec(`RESET ROLE; DELETE FROM app_private.copilot_action_ledger WHERE event='step_unknown_effect'; SET ROLE authenticated;`);
    assert.equal((await run()).status,'incomplete','reconciliation without origin must not green');
  } finally {await db.close();}
});

const legacy = 'tao_phieu_thu_chi_nhap';
const canonical = 'income_expense.create_draft';
const legacyId = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function seedLegacy(db) {
  await db.exec(`CREATE TABLE public.income_expenses(id uuid, organization_id uuid);
    INSERT INTO app_private.copilot_action_registry VALUES ('${canonical}','nonce_abi_v1','L4',false,false,'income_expenses',1,'income_expenses.create','click','copilot_preview_income_expense_v1','copilot_execute_income_expense_v1','ie_draft');
    INSERT INTO public.income_expenses VALUES ('${legacyId(1)}','${org}');
    INSERT INTO public.ai_write_audit VALUES ('${legacyId(2)}','2026-09-03','${org}','${actor}','${legacy}','income_expenses','${legacyId(1)}','private-key','{"private":"payload"}');
    INSERT INTO app_private.copilot_action_ledger(id,created_at,organization_id,user_id,event,action_id,entity_table,entity_id,audit_id,consent_kind,after_digest) VALUES
    ('${legacyId(3)}','2026-09-03','${org}','${actor}','action_executed','${canonical}','income_expenses','${legacyId(1)}','${legacyId(2)}','click',decode('abcd','hex'));
    SET ROLE authenticated;`);
}
const auditClient = db => ({async rpc(jwt,name,a) {return {status:200,body:(await db.query(`SELECT public.copilot_ledger_audit_page_v1($1::uuid,$2::timestamptz,$3::timestamptz,$4,$5::timestamptz,$6::uuid,$7::integer) data`,[a.p_organization_id,a.p_since,a.p_until,a.p_stream,a.p_after_at,a.p_after_id,a.p_limit])).rows[0].data};}});
const legacyReport = db => doiChieuSo(auditClient(db),'jwt',{org,since:'2026-09-01T00:00:00Z',until:'2026-09-06T00:00:00Z'});

test('legacy identity maps strictly in both directions and preserves raw evidence', async () => {
  const db=await setup();
  try {
    await seedLegacy(db);
    const a=await page(db,'audit'), l=await page(db);
    assert.equal(a.total,1); assert.equal(l.total,1);
    assert.equal(a.rows[0].action_id,canonical,'valid legacy identity must resolve');
    assert.equal(a.rows[0].audit_tool,legacy); assert.equal(a.rows[0].identity_mapping,'legacy_income_expense_draft_v1');
    assert.equal(a.rows[0].action_executions,1,'reverse legacy link must match');
    assert.equal(l.rows[0].audit_matches,true,'forward legacy link must match');
    assert.equal(l.rows[0].audit_tool,legacy); assert.equal(l.rows[0].identity_mapping,a.rows[0].identity_mapping);
    const report=await legacyReport(db);
    assert.equal(report.status,'clean',JSON.stringify(report)); assert.equal(report.knownLegacyL4.auditRows,1);
    assert.equal(report.directL5Actions.includes(canonical),false); assert.equal(report.canaryDurationVerified,false);
    assert.equal(JSON.stringify(a).includes('private-key'),false); assert.equal(JSON.stringify(a).includes('payload'),false);
  } finally {await db.close();}
});

test('legacy identity unresolved contracts never turn into known coverage', async () => {
  const db=await setup();
  try {
    await seedLegacy(db);
    for (const [column,value] of [['executor_kind','maker_submit_v1'],['risk','L5'],['version','2'],['permission_key','other.permission'],['consent_required','step_up'],['preview_rpc','other_preview'],['execute_rpc','other_execute'],['verify_kind','readback'],['produces_entity_table','customers']]) {
      await db.exec(`RESET ROLE; BEGIN; UPDATE app_private.copilot_action_registry SET ${column}='${value}' WHERE action_id='${canonical}'; SET ROLE authenticated;`);
      assert.equal((await page(db,'audit')).rows[0].action_id,legacy,`incompatible ${column} must remain unresolved`);
      assert.equal((await page(db)).rows[0].audit_matches,false,`incompatible ${column} cannot link`);
      assert.equal((await legacyReport(db)).status,'incomplete');
      await db.exec('ROLLBACK; SET ROLE authenticated');
    }
    for (const change of [`DELETE FROM app_private.copilot_action_registry WHERE action_id='${canonical}'`, `UPDATE public.ai_write_audit SET tool='unknown.tool'`, `UPDATE public.ai_write_audit SET entity_table='customers'`, `UPDATE public.ai_write_audit SET entity_id=NULL`]) {
      await db.exec(`RESET ROLE; BEGIN; ${change}; SET ROLE authenticated;`);
      const a=(await page(db,'audit')).rows[0];
      assert.notEqual(a.action_id,canonical); assert.equal(a.identity_mapping,null); assert.equal(a.action_executions,0);
      assert.equal((await legacyReport(db)).status,'incomplete');
      await db.exec('ROLLBACK; SET ROLE authenticated');
    }
  } finally {await db.close();}
});

test('legacy exact actor org entity and audit id remain mandatory for both directions', async () => {
  const db=await setup();
  try {
    await seedLegacy(db);
    for (const [column,value] of [['user_id',other],['organization_id',other],['entity_table','customers'],['entity_id',legacyId(99)],['audit_id',legacyId(99)]]) {
      await db.exec(`RESET ROLE; BEGIN; UPDATE app_private.copilot_action_ledger SET ${column}='${value}'; SET ROLE authenticated;`);
      const a=await page(db,'audit'), l=await page(db);
      assert.equal(a.rows[0].action_executions,0,`reverse ${column} mismatch must not link`);
      if(l.rows.length) assert.equal(l.rows[0].audit_matches,false,`forward ${column} mismatch must not link`);
      assert.notEqual((await legacyReport(db)).status,'clean');
      assert.equal(JSON.stringify(a).includes(other),false);
      await db.exec('ROLLBACK; SET ROLE authenticated');
    }
  } finally {await db.close();}
});

test('legacy duplicate execution is detected across history while replay needs no new execution', async () => {
  const db=await setup();
  try {
    await seedLegacy(db);
    await db.exec(`RESET ROLE; UPDATE app_private.copilot_action_ledger SET created_at='2026-08-31';
      INSERT INTO app_private.copilot_action_ledger(id,created_at,organization_id,user_id,event,action_id,entity_table,entity_id,audit_id,outcome) VALUES
      ('${legacyId(4)}','2026-09-04','${org}','${actor}','step_done','${canonical}','income_expenses','${legacyId(1)}','${legacyId(2)}','{"idempotent":true}'); SET ROLE authenticated;`);
    assert.equal((await page(db,'audit')).rows[0].action_executions,1);
    assert.equal((await legacyReport(db)).counts.duplicate,0,'replay requires no extra execution');
    await db.exec(`RESET ROLE; INSERT INTO app_private.copilot_action_ledger SELECT '${legacyId(5)}'::uuid,created_at,organization_id,user_id,event,action_id,plan_id,step_no,consent_kind,step_up_id,entity_table,entity_id,audit_id,outcome,after_digest FROM app_private.copilot_action_ledger WHERE id='${legacyId(3)}'; SET ROLE authenticated;`);
    assert.equal((await page(db,'audit')).rows[0].action_executions,2,'history duplicate must count');
    assert.equal((await page(db)).rows[0].duplicate_executions,true);
    assert.equal((await legacyReport(db)).counts.duplicate,1,'same audit violation deduplicated across streams');
  } finally {await db.close();}
});

test('pre-wrapper legacy evidence gap is retained without inventing a deployment cutoff', async () => {
  const db=await setup();
  try {
    await seedLegacy(db);
    await db.exec('RESET ROLE; DELETE FROM app_private.copilot_action_ledger; SET ROLE authenticated');
    const r=await legacyReport(db);
    assert.equal(r.auditRowsInWindow,1); assert.equal(r.ledgerRowsInWindow,0);
    assert.equal(r.status,'incomplete','historical legacy gap must not green');
    assert.ok(r.incomplete.some(x=>x.reason==='legacy_ledger_evidence_gap_historical_boundary'));
    assert.equal(r.knownLegacyL4.auditRows,1); assert.equal(r.knownLegacyL4.auditRowsWithoutExecution,1);
    assert.equal(r.counts.unintendedWrite,0); assert.equal(r.canaryDurationVerified,false);
  } finally {await db.close();}
});

for (const hasOriginalExecution of [false, true]) test(`legacy replay with audit outside window requires original execution: ${hasOriginalExecution}`, async () => {
  const db=await setup();
  try {
    await seedLegacy(db);
    await db.exec(`RESET ROLE;
      UPDATE public.ai_write_audit SET created_at='2026-08-31';
      UPDATE app_private.copilot_action_ledger SET created_at='2026-08-31';
      INSERT INTO app_private.copilot_plans(id,user_id,organization_id,consent_kind) VALUES ('${legacyId(10)}','${actor}','${org}','click');
      INSERT INTO app_private.copilot_action_ledger(id,created_at,organization_id,user_id,event,action_id,plan_id,step_no,entity_table,entity_id,audit_id,outcome,consent_kind) VALUES
      ('${legacyId(4)}','2026-09-04','${org}','${actor}','step_done','${canonical}','${legacyId(10)}',1,'income_expenses','${legacyId(1)}','${legacyId(2)}','{"idempotent":true}','click');
      INSERT INTO app_private.copilot_plan_steps VALUES ('${legacyId(10)}',1,'${canonical}','DONE','2026-09-04','${legacyId(4)}');`);
    if (!hasOriginalExecution) await db.exec(`DELETE FROM app_private.copilot_action_ledger WHERE id='${legacyId(3)}'`);
    await db.exec('SET ROLE authenticated');
    const l=await page(db), a=await page(db,'audit'), r=await legacyReport(db);
    assert.equal(a.total,0); assert.equal(l.total,1); assert.equal(r.auditRowsInWindow,0); assert.equal(r.ledgerRowsInWindow,1);
    assert.equal(l.rows[0].audit_matches,true); assert.equal(l.rows[0].identity_mapping,'legacy_income_expense_draft_v1');
    assert.equal(l.rows[0].action_executions,Number(hasOriginalExecution));
    assert.equal(r.status,hasOriginalExecution ? 'clean' : 'incomplete','out-of-window audit replay must require original execution evidence');
    assert.equal(r.evidenceComplete,hasOriginalExecution); assert.equal(r.counts.duplicate,0); assert.equal(r.canaryDurationVerified,false);
    if (!hasOriginalExecution) assert.ok(r.incomplete.some(x=>x.id===legacyId(4) && x.reason==='legacy_ledger_evidence_gap_historical_boundary'));
    else {
      // An unrelated historical wrapper is not evidence for this replay.
      for (const [column,value] of [['user_id',other],['organization_id',other],['entity_id',legacyId(99)],['audit_id',legacyId(99)],['action_id','unknown.tool']]) {
        await db.exec(`RESET ROLE; BEGIN; UPDATE app_private.copilot_action_ledger SET ${column}='${value}' WHERE id='${legacyId(3)}'; SET ROLE authenticated;`);
        assert.equal((await page(db)).rows[0].action_executions,0);
        assert.equal((await legacyReport(db)).status,'incomplete',`wrong historical ${column} must not prove a replay`);
        await db.exec('ROLLBACK; SET ROLE authenticated');
      }
    }
  } finally {await db.close();}
});
