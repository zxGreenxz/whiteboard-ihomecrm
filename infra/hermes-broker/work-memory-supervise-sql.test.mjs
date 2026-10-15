import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, id, USER, ORG, SESSION, CONNECTION, FOREIGN } from '../hermes-zalo-router/private-command-fixture.mjs';

const source = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8');
const base = source('20261014081343_hermes_work_memory_v1');
const supervisePath = 'supabase/migrations/20261015110100_hermes_work_memory_supervise_v1.sql';
const original = readFileSync(process.env.HERMES_MEMORY_SUPERVISE_SQL ?? supervisePath, 'utf8');
const forward = source('20261014000503_hermes_optional_org_policy_v1');
const actual = name => forward.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replaceAll('.', '\\.')}[\\s\\S]*?\\$(?:fn)?\\$;`))[0];
const OWNER = id('e');
const bound = { connectionId: CONNECTION, tokenDigest: 'b'.repeat(64), expectedEpoch: 1, expectedPolicyVersion: 1,
  expectedMembershipId: USER, expectedAuthorizationVersion: 1, expectedSessionRevision: 1 };
const search = (extra = {}) => ({ organizationId: ORG, ownerUserId: null, query: '', limit: 20, offset: 0, ...extra });

async function setup(t, sql = original) {
  const { db } = await fixture(t, { migrations: ['20261013084000_hermes_private_command_dispatch_v1'] });
  await db.exec(`CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('session_id',current_setting('request.jwt.claim.session',true))$$;
    CREATE FUNCTION app_private.is_actor_offboarded_v1() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
    CREATE TABLE public.fixture_audit(event text,metadata jsonb);
    CREATE TABLE public.authorization_scopes(id uuid PRIMARY KEY,organization_id uuid);
    CREATE TABLE public.profiles(id uuid PRIMARY KEY,full_name text);
    CREATE FUNCTION app_private.append_authz_audit_v1(o uuid,e text,k text,i uuid,m jsonb) RETURNS void LANGUAGE sql AS $$INSERT INTO public.fixture_audit VALUES(e,m)$$;
    CREATE TABLE public.fixture_acl(allowed boolean); INSERT INTO public.fixture_acl VALUES(true);
    CREATE FUNCTION app_private.authorize_tenant_action_v3(actor uuid,org uuid,permission text)
      RETURNS TABLE(allowed boolean,authorization_version bigint) LANGUAGE sql AS $$
      SELECT allowed AND actor='${USER}'::uuid AND org='${ORG}'::uuid AND permission='users.view',1::bigint FROM public.fixture_acl$$;
    INSERT INTO auth.users VALUES('${OWNER}');
    INSERT INTO public.profiles VALUES('${OWNER}','Owner\nInjected'),('${USER}','Supervisor');
    INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES('${OWNER}','${OWNER}','${ORG}','ACTIVE');
    INSERT INTO app_private.hermes_assistants(id,organization_id,user_id) VALUES('${OWNER}','${ORG}','${OWNER}');
    UPDATE app_private.hermes_org_policies SET read_capabilities=ARRAY['assistant.memory.read'],action_capabilities=ARRAY['assistant.memory.write'];
    UPDATE app_private.hermes_connections SET read_capabilities=ARRAY['assistant.memory.read'],action_capabilities=ARRAY['assistant.memory.write'];`);
  for (const name of ['app_private.hermes_effective_org_policy_v1', 'app_private.hermes_private_command_connection_v1', 'app_private.hermes_session_gate_v1']) await db.exec(actual(name));
  await db.exec(base); await db.exec(base);
  await db.exec(sql); await db.exec(sql);
  assert.equal((await db.query("SELECT enabled FROM app_private.hermes_capabilities WHERE capability='assistant.memory.supervise'")).rows[0].enabled, false);
  await db.exec("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability IN ('assistant.memory.read','assistant.memory.write')");
  await db.exec(`INSERT INTO app_private.hermes_work_memory_settings(organization_id,user_id,enabled,sharing) VALUES('${ORG}','${OWNER}',true,'managers');
    INSERT INTO app_private.hermes_work_memories(organization_id,user_id,assistant_id,connection_id,key,content,source_label,expires_at)
    VALUES('${ORG}','${OWNER}','${OWNER}','${CONNECTION}','gas_meter','Đồng hồ ga tòa A cần kiểm định','Ghi chú của chủ',clock_timestamp()+interval '1 day'),
      ('${ORG}','${OWNER}','${OWNER}','${CONNECTION}','tenant_pref','Khách phòng 101 thích liên hệ buổi sáng','Ghi chú của chủ',clock_timestamp()+interval '1 day')`);
  async function call(query, args, actor = USER, role = 'authenticated') {
    await db.exec('BEGIN');
    await db.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.session',$3,true)", [role, actor, SESSION]);
    await db.exec(`SET LOCAL ROLE ${role}`);
    try { const result = (await db.query(query, args)).rows[0].result; await db.exec('COMMIT'); return result; }
    catch (error) { await db.exec('ROLLBACK'); throw error; } finally { await db.exec('RESET ROLE'); }
  }
  const rpc = (name, input) => call(`SELECT public.${name}($1::jsonb,$2::jsonb) result`, [JSON.stringify(bound), JSON.stringify(input)]);
  const web = (name, input, actor = USER, role = 'authenticated') => call(`SELECT public.${name}($1::uuid,$2::jsonb) result`, [ORG, JSON.stringify(input)], actor, role);
  const grant = async () => db.exec(`UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='assistant.memory.supervise';
    UPDATE app_private.hermes_org_policies SET read_capabilities=ARRAY['assistant.memory.read','assistant.memory.supervise'];
    UPDATE app_private.hermes_connections SET read_capabilities=ARRAY['assistant.memory.read','assistant.memory.supervise']`);
  return { db, call, rpc, web, grant };
}

test('Hermes tổng: shared CRM work memory only, under supervision grant ∩ users.view and owner sharing', { timeout: 60000 }, async t => {
  const { db, rpc, grant } = await setup(t);
  await t.test('memory.read alone does not unlock other owners', async () => {
    await assert.rejects(rpc('hermes_work_memory_search_v1', search()), /denied/);
    await assert.rejects(rpc('hermes_work_memory_list_v1', { ownerUserId: OWNER, limit: 10, offset: 0, updatedSince: null }), /denied/);
  });
  await grant();
  await t.test('manager (users.view, not superadmin) reads notes shared with managers, with provenance', async () => {
    const result = await rpc('hermes_work_memory_search_v1', search());
    assert.equal(result.items.length, 2);
    assert.equal(result.personalMemory, 'not_accessible'); assert.equal(result.authority, 'reference_only');
    assert.equal(result.items[0].ownerUserId, OWNER); assert.equal(result.items[0].ownerName, 'Owner Injected');
    assert.equal(result.items[0].source.channel, 'external_mcp');
    assert.equal((await rpc('hermes_work_memory_search_v1', search({ query: 'ĐỒNG HỒ' }))).items.length, 1);
    assert.equal((await rpc('hermes_work_memory_list_v1', { ownerUserId: OWNER, limit: 10, offset: 0, updatedSince: null })).items.length, 2);
  });
  await t.test('sharing scope is the owner\'s explicit choice', async () => {
    await db.exec(`UPDATE app_private.hermes_work_memory_settings SET sharing='superadmin' WHERE user_id='${OWNER}'`);
    assert.equal((await rpc('hermes_work_memory_search_v1', search())).items.length, 0);
    await db.exec(`INSERT INTO public.super_admins VALUES('${USER}')`);
    assert.equal((await rpc('hermes_work_memory_search_v1', search())).items.length, 2);
    await db.exec(`UPDATE app_private.hermes_work_memory_settings SET sharing='owner' WHERE user_id='${OWNER}'`);
    assert.equal((await rpc('hermes_work_memory_search_v1', search())).items.length, 0);
    await assert.rejects(rpc('hermes_work_memory_list_v1', { ownerUserId: OWNER, limit: 10, offset: 0, updatedSince: null }), /denied/);
    await db.exec(`UPDATE app_private.hermes_work_memory_settings SET sharing='managers',enabled=false WHERE user_id='${OWNER}'`);
    assert.equal((await rpc('hermes_work_memory_search_v1', search())).items.length, 0, 'disabled storage is not retrievable');
    await db.exec(`UPDATE app_private.hermes_work_memory_settings SET enabled=true WHERE user_id='${OWNER}'`);
    await db.exec(`DELETE FROM public.super_admins`);
  });
  await t.test('live CRM users.view, explicit company and no self/other-org targets', async () => {
    await assert.rejects(rpc('hermes_work_memory_search_v1', search({ organizationId: FOREIGN })), /denied/);
    await assert.rejects(rpc('hermes_work_memory_search_v1', search({ ownerUserId: USER })), /denied/);
    await assert.rejects(rpc('hermes_work_memory_search_v1', { ...search(), personalHistory: true }), /invalid/);
    await db.exec('UPDATE public.fixture_acl SET allowed=false');
    await assert.rejects(rpc('hermes_work_memory_search_v1', search()), /denied/);
    await db.exec('UPDATE public.fixture_acl SET allowed=true');
    await db.exec(`UPDATE public.organization_memberships SET status='SUSPENDED' WHERE user_id='${OWNER}'`);
    assert.equal((await rpc('hermes_work_memory_search_v1', search())).items.length, 0, 'departed owner notes are not served');
    await db.exec(`UPDATE public.organization_memberships SET status='ACTIVE' WHERE user_id='${OWNER}'`);
  });
  await t.test('audit keeps identifiers and counts only', async () => {
    const rows = (await db.query(`SELECT metadata FROM public.fixture_audit WHERE event='HERMES_MEMORY_SUPERVISED_READ'`)).rows;
    assert.ok(rows.length >= 3);
    assert.doesNotMatch(JSON.stringify(rows), /Đồng hồ|ĐỒNG HỒ|Khách phòng/);
  });
  await t.test('configure accepts managers sharing', async () => {
    await db.exec("UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['assistant.memory.write']");
    await db.exec("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='assistant.memory.write'");
    const configured = await rpc('hermes_work_memory_configure_v1', { enabled: true, sharing: 'managers', retentionDays: 30, expectedAccessVersion: 0 });
    assert.equal(configured.settings.sharing, 'managers');
    await assert.rejects(rpc('hermes_work_memory_configure_v1', { enabled: true, sharing: 'everyone', retentionDays: 30, expectedAccessVersion: 2 }), /invalid/);
  });
});

test('CRM web: owner views, edits, forgets and sets retention without a Hermes connection', { timeout: 60000 }, async t => {
  const { db, web, call } = await setup(t);
  const status = () => call('SELECT public.hermes_my_work_memory_v1($1::uuid,0) result', [ORG]);
  assert.deepEqual((await status()).settings, { enabled: false, sharing: 'owner', retentionDays: 30, accessVersion: 0 });
  assert.equal((await status()).personalMemory, 'outside_crm');
  await assert.rejects(call('SELECT public.hermes_my_work_memory_v1($1::uuid,0) result', [ORG], USER, 'anon'), /denied|permission/);
  const configured = await web('hermes_my_work_memory_configure_v1', { enabled: true, sharing: 'managers', retentionDays: 7, expectedAccessVersion: 0 });
  assert.equal(configured.settings.accessVersion, 2);
  await assert.rejects(web('hermes_my_work_memory_configure_v1', { enabled: true, sharing: 'owner', retentionDays: 7, expectedAccessVersion: 0 }), /context_changed/);
  await db.exec(`INSERT INTO app_private.hermes_work_memories(organization_id,user_id,assistant_id,connection_id,key,content,source_label,expires_at)
    SELECT '${ORG}','${USER}',a.id,'${CONNECTION}','my_note','Ghi chú của tôi','Tôi ghi',clock_timestamp()+interval '1 day' FROM app_private.hermes_assistants a WHERE a.user_id='${USER}'`);
  const listed = await status();
  assert.equal(listed.items.length, 1); assert.equal(listed.total, 1);
  const note = listed.items[0];
  await assert.rejects(web('hermes_my_work_memory_edit_v1', { id: note.id, expectedVersion: 2, content: 'Sửa' }), /context_changed/);
  await assert.rejects(web('hermes_my_work_memory_edit_v1', { id: note.id, expectedVersion: 1, content: 'hc_' + 'A'.repeat(43) }), /invalid/);
  await assert.rejects(web('hermes_my_work_memory_edit_v1', { id: note.id, expectedVersion: 1, content: 'Của người khác' }, OWNER), /denied/);
  const edited = await web('hermes_my_work_memory_edit_v1', { id: note.id, expectedVersion: 1, content: 'Ghi chú đã sửa' });
  assert.equal(edited.version, 2);
  await assert.rejects(web('hermes_my_work_memory_forget_v1', { id: note.id, expectedVersion: 2 }, OWNER), /context_changed/);
  const forgotten = await web('hermes_my_work_memory_forget_v1', { id: note.id, expectedVersion: 2 });
  assert.equal(forgotten.forgotten, true); assert.equal(forgotten.remoteCopies, 'not_revocable');
  assert.equal((await status()).items.length, 0);
  assert.doesNotMatch(JSON.stringify((await db.query('SELECT * FROM public.fixture_audit')).rows), /Ghi chú/);
});

const probes = [
  { name: 'supervision overlay', from: "OR NOT('assistant.memory.supervise'=ANY(c.read_capabilities))", to: '',
    prepare: db => db.exec(`UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='assistant.memory.supervise';
      UPDATE app_private.hermes_org_policies SET read_capabilities=ARRAY['assistant.memory.read','assistant.memory.supervise']`),
    expect: result => result.items.length > 0 },
  { name: 'owner sharing choice', from: "SELECT p_sharing='managers' OR", to: 'SELECT true OR',
    prepare: (db, grant) => grant().then(() => db.exec(`UPDATE app_private.hermes_work_memory_settings SET sharing='owner' WHERE user_id='${OWNER}'`)),
    expect: result => result.items.length > 0, originalItems: 0 },
];
for (const probe of probes) {
  test(`mutation: ${probe.name}`, { timeout: 60000 }, async t => {
    const mutant = original.replace(probe.from, probe.to);
    assert.notEqual(mutant, original);
    const clean = await setup(t); await probe.prepare(clean.db, clean.grant);
    if (probe.originalItems === 0) assert.equal((await clean.rpc('hermes_work_memory_search_v1', search())).items.length, 0);
    else await assert.rejects(clean.rpc('hermes_work_memory_search_v1', search()), /denied/);
    const broken = await setup(t, mutant); await probe.prepare(broken.db, broken.grant);
    assert.ok(probe.expect(await broken.rpc('hermes_work_memory_search_v1', search())), 'mutant must expose memory');
  });
}
