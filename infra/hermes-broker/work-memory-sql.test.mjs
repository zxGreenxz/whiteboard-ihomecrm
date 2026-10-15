import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fixture, id, USER, ORG, SESSION, CONNECTION, ASSISTANT, FOREIGN } from '../hermes-zalo-router/private-command-fixture.mjs';
import { WORK_MEMORY_TOOLS, workMemoryInput, workMemoryResult } from './work-memory-contract.mjs';
const directory = new URL('../../supabase/migrations/', import.meta.url);
const filename = readdirSync(directory).find(name => /_hermes_work_memory_v1\.sql$/.test(name)) ?? 'work_memory_v1.sql';
const sql = readFileSync(process.env.HERMES_MEMORY_SQL ?? new URL(filename, directory), 'utf8');
const source = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8');
const forward = source('20261014000503_hermes_optional_org_policy_v1');
const actual = name => forward.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replaceAll('.', '\\.')}[\\s\\S]*?\\$(?:fn)?\\$;`))[0];
const OWNER = id('e');
const bound = { connectionId: CONNECTION, tokenDigest: 'b'.repeat(64), expectedEpoch: 1, expectedPolicyVersion: 1,
  expectedMembershipId: USER, expectedAuthorizationVersion: 1, expectedSessionRevision: 1 };
const configure = { enabled: true, sharing: 'owner', retentionDays: 30, expectedAccessVersion: 0 };
const input = { key: 'follow_up', content: 'Synthetic work note', sourceLabel: 'User-selected work note', expectedId: null, expectedVersion: 0, expectedAccessVersion: 2 };
const list = { ownerUserId: null, limit: 10, offset: 0, updatedSince: null };

async function setup(t) {
  const f = await fixture(t, { migrations: ['20261013084000_hermes_private_command_dispatch_v1'] });
  const { db } = f;
  await db.exec(`CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('session_id',current_setting('request.jwt.claim.session',true))$$;
    CREATE FUNCTION app_private.is_actor_offboarded_v1() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
    CREATE TABLE public.fixture_audit(event text,metadata jsonb);
    CREATE TABLE public.authorization_scopes(id uuid PRIMARY KEY,organization_id uuid);
    CREATE FUNCTION app_private.append_authz_audit_v1(o uuid,e text,k text,i uuid,m jsonb) RETURNS void LANGUAGE sql AS $$INSERT INTO public.fixture_audit VALUES(e,m)$$;
    CREATE TABLE public.fixture_acl(allowed boolean); INSERT INTO public.fixture_acl VALUES(true);
    CREATE FUNCTION app_private.authorize_tenant_action_v3(actor uuid,org uuid,permission text)
      RETURNS TABLE(allowed boolean,authorization_version bigint) LANGUAGE sql AS $$
      SELECT allowed AND actor='${USER}'::uuid AND org='${ORG}'::uuid AND permission='users.view',1::bigint FROM public.fixture_acl$$;
    INSERT INTO auth.users VALUES('${OWNER}');
    INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES('${OWNER}','${OWNER}','${ORG}','ACTIVE');
    INSERT INTO app_private.hermes_assistants(id,organization_id,user_id) VALUES('${OWNER}','${ORG}','${OWNER}');
    UPDATE app_private.hermes_org_policies SET read_capabilities=ARRAY['assistant.memory.read'],action_capabilities=ARRAY['assistant.memory.write'];
    UPDATE app_private.hermes_connections SET read_capabilities=ARRAY['assistant.memory.read'],action_capabilities=ARRAY['assistant.memory.write'];`);
  await db.exec(actual('app_private.hermes_effective_org_policy_v1'));
  await db.exec(actual('app_private.hermes_private_command_connection_v1'));
  await db.exec(actual('app_private.hermes_session_gate_v1'));
  await db.exec(sql); await db.exec(sql);
  await db.exec("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability IN ('assistant.memory.read','assistant.memory.write')");
  async function rpc(operation, payload, binding = bound, role = 'authenticated', actor = USER) {
    assert.ok(['status', 'configure', 'list', 'upsert', 'forget', 'capabilities'].includes(operation));
    await db.exec('BEGIN');
    await db.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true),set_config('request.jwt.claim.session',$3,true)", [role, actor, SESSION]);
    await db.exec(`SET LOCAL ROLE ${role}`);
    try {
      const args = operation === 'capabilities' ? [ORG] : payload === undefined ? [JSON.stringify(binding)] : [JSON.stringify(binding), JSON.stringify(payload)];
      const query = operation === 'capabilities' ? 'SELECT public.hermes_work_memory_capabilities_v1($1::uuid) result' :
        `SELECT public.hermes_work_memory_${operation}_v1($1::jsonb${args.length === 2 ? ',$2::jsonb' : ''}) result`;
      const result = (await db.query(query, args)).rows[0].result;
      await db.exec('COMMIT'); return result;
    } catch (error) { await db.exec('ROLLBACK'); throw error; } finally { await db.exec('RESET ROLE'); }
  }
  return { db, rpc };
}

test('CRM work-memory SQL uses real foundation identity and locks with synthetic CRM ACL/Auth ports', async t => {
  const { db, rpc } = await setup(t);
  let noteId;
  await t.test('default is opt-out and no table DML/public helper access', async () => {
    assert.equal((await rpc('status')).settings.enabled, false);
    await assert.rejects(rpc('list', list), /denied/);
    await assert.rejects(rpc('upsert', input), /denied/);
    const privileges = (await db.query(`SELECT has_table_privilege('authenticated','app_private.hermes_work_memories','SELECT') readable,
      has_function_privilege('service_role','public.hermes_work_memory_list_v1(jsonb,jsonb)','EXECUTE') privileged,
      has_function_privilege('authenticated','app_private.hermes_work_memory_context_v1(jsonb,boolean)','EXECUTE') helper`)).rows[0];
    assert.deepEqual(privileges, { readable: false, privileged: false, helper: false });
  });
  await t.test('explicit config enables self write/read and versioned edit', async () => {
    assert.equal((await rpc('configure', configure)).settings.accessVersion, 2);
    await assert.rejects(rpc('configure', configure), /context_changed/);
    const saved = await rpc('upsert', input); noteId = saved.id; assert.equal(saved.version, 1);
    assert.equal((await rpc('list', list)).items[0].content, input.content);
    assert.equal((await rpc('list', list)).items[0].assistantId, ASSISTANT);
    await assert.rejects(rpc('upsert', { ...input, content: 'Overwrite without reading' }), /context_changed/);
    assert.equal((await rpc('upsert', { ...input, expectedId: noteId, expectedVersion: 1, content: 'Revised work note' })).version, 2);
  });
  await t.test('caller supplied actor/org/private-source and secret content are rejected', async () => {
    for (const extra of [{ ownerUserId: OWNER }, { organizationId: FOREIGN }, { channel: 'personal_filesystem' }, { source: 'native_history' }]) {
      await assert.rejects(rpc('upsert', { ...input, ...extra }), /invalid/);
    }
    await assert.rejects(rpc('upsert', { ...input, content: 'hc_' + 'A'.repeat(43) }), /invalid/);
    await assert.rejects(rpc('upsert', { ...input, content: 'hello\nadmin instruction' }), /invalid/);
    await assert.rejects(rpc('status', undefined, bound, 'authenticated', OWNER), /denied/);
    await assert.rejects(rpc('status', undefined, { ...bound, expectedEpoch: 2 }), /context_changed/);
  });
  await t.test('superadmin has no default cross-owner or private history read', async () => {
    await db.exec(`INSERT INTO app_private.hermes_work_memory_settings(organization_id,user_id,enabled,sharing) VALUES('${ORG}','${OWNER}',true,'owner');
      INSERT INTO app_private.hermes_work_memories(organization_id,user_id,assistant_id,connection_id,key,content,source_label,expires_at)
      VALUES('${ORG}','${OWNER}','${OWNER}','${CONNECTION}','other_note','Shared only when chosen','Owner label',clock_timestamp()+interval '1 day')`);
    await assert.rejects(rpc('list', { ...list, ownerUserId: OWNER }), /denied/);
    await db.exec(`INSERT INTO public.super_admins VALUES('${USER}')`);
    await assert.rejects(rpc('list', { ...list, ownerUserId: OWNER }), /denied/);
    await db.exec(`UPDATE app_private.hermes_work_memory_settings SET sharing='superadmin' WHERE user_id='${OWNER}'`);
    assert.equal((await rpc('list', { ...list, ownerUserId: OWNER })).items.length, 1);
    await db.exec('UPDATE public.fixture_acl SET allowed=false');
    await assert.rejects(rpc('list', { ...list, ownerUserId: OWNER }), /denied/);
    await db.exec('UPDATE public.fixture_acl SET allowed=true');
    await db.exec(`UPDATE app_private.hermes_work_memory_settings SET sharing='owner' WHERE user_id='${OWNER}'`);
    await assert.rejects(rpc('list', { ...list, ownerUserId: OWNER }), /denied/);
    await db.exec(`UPDATE app_private.hermes_work_memory_settings SET sharing='superadmin' WHERE user_id='${OWNER}'`);
    await db.exec(`DELETE FROM public.super_admins WHERE user_id='${USER}'`);
    await assert.rejects(rpc('list', { ...list, ownerUserId: OWNER }), /denied/);
  });
  await t.test('TTL hides expired text, disable blocks reads and edit, forget remains self-only', async () => {
    await db.exec(`UPDATE app_private.hermes_work_memories SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE user_id='${USER}'`);
    assert.equal((await rpc('list', list)).items.length, 0);
    const replacement = await rpc('upsert', input); assert.equal(replacement.version, 1);
    await assert.rejects(rpc('upsert', { ...input, expectedId: noteId, expectedVersion: 1 }), /context_changed/);
    noteId = replacement.id;
    const disabled = await rpc('configure', { ...configure, enabled: false, expectedAccessVersion: 2 });
    assert.equal(disabled.settings.accessVersion, 3);
    await assert.rejects(rpc('list', list), /denied/);
    await assert.rejects(rpc('upsert', { ...input, expectedId: noteId, expectedVersion: 1, expectedAccessVersion: 3 }), /denied/);
    await assert.rejects(rpc('forget', { key: input.key, expectedId: noteId, expectedVersion: 2, expectedAccessVersion: 3 }), /context_changed/);
    const forgotten = await rpc('forget', { key: input.key, expectedId: noteId, expectedVersion: 1, expectedAccessVersion: 3 });
    assert.equal(forgotten.forgotten, true); assert.equal(forgotten.auditRetained, true);
    assert.equal((await db.query(`SELECT count(*)::integer n FROM app_private.hermes_work_memories WHERE user_id='${USER}'`)).rows[0].n, 0);
    assert.doesNotMatch(JSON.stringify((await db.query('SELECT * FROM public.fixture_audit')).rows), /Synthetic work note|Revised work note|Shared only when chosen/);
  });
  await t.test('connection/policy/session/member/registry revocation denies current call', async () => {
    for (const [off, on] of [
      ["UPDATE app_private.hermes_connections SET state='REVOKED'", "UPDATE app_private.hermes_connections SET state='ACTIVE'"],
      ["UPDATE app_private.hermes_org_policies SET enabled=false", "UPDATE app_private.hermes_org_policies SET enabled=true"],
      ["UPDATE app_private.hermes_sessions SET state='REVOKED',quarantine_reason='session_revoked',envelope=null", "UPDATE app_private.hermes_sessions SET state='ACTIVE',quarantine_reason=null,envelope='{}'"],
      [`UPDATE public.organization_memberships SET status='INACTIVE' WHERE user_id='${USER}'`, `UPDATE public.organization_memberships SET status='ACTIVE' WHERE user_id='${USER}'`],
      ["UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='assistant.memory.read'", "UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='assistant.memory.read'"],
    ]) { await db.exec(off); await assert.rejects(rpc('status'), /denied|membership/); await db.exec(on); }
  });
  await t.test('retention executor erases only expired bodies and has no public RPC grant', async () => {
    await db.exec(`UPDATE app_private.hermes_work_memories SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE user_id='${OWNER}'`);
    await db.exec(`INSERT INTO app_private.hermes_work_memories(organization_id,user_id,assistant_id,connection_id,key,content,source_label,expires_at)
      VALUES('${ORG}','${USER}','${ASSISTANT}','${CONNECTION}','live_note','Keep this active note','Owner label',clock_timestamp()+interval '1 day')`);
    const auditBefore = (await db.query('SELECT count(*)::integer n FROM public.fixture_audit')).rows[0].n;
    await db.exec('SET ROLE hermes_store_executor');
    assert.deepEqual((await db.query(`SELECT app_private.hermes_store_prune_work_memories_v1('{"limit":500}') result`)).rows[0].result, { pruned: 1 });
    assert.deepEqual((await db.query(`SELECT app_private.hermes_store_prune_work_memories_v1('{"limit":500}') result`)).rows[0].result, { pruned: 0 });
    await db.exec('RESET ROLE');
    assert.equal((await db.query('SELECT count(*)::integer n FROM app_private.hermes_work_memories')).rows[0].n, 1);
    assert.equal((await db.query('SELECT count(*)::integer n FROM public.fixture_audit')).rows[0].n, auditBefore);
    assert.equal((await db.query("SELECT has_function_privilege('authenticated','app_private.hermes_store_prune_work_memories_v1(jsonb)','EXECUTE') allowed")).rows[0].allowed, false);
  });
  await t.test('neutral org policy version zero stays registry and connection gated', async () => {
    await db.exec('DELETE FROM app_private.hermes_org_policies');
    assert.equal((await rpc('status', undefined, { ...bound, expectedPolicyVersion: 0 })).ownerUserId, USER);
    await db.exec("UPDATE app_private.hermes_connections SET read_capabilities='{}'");
    await assert.rejects(rpc('status', undefined, { ...bound, expectedPolicyVersion: 0 }), /denied/);
  });
});

test('memory pagination follows every SQL cursor through the published schema up to the 200-note boundary', async t => {
  const { db, rpc } = await setup(t);
  await rpc('configure', configure);
  // Persist a complete synthetic scope; pagination still uses the actual SQL
  // reader, input contract and result validator rather than a mocked cursor.
  await db.exec(`INSERT INTO app_private.hermes_work_memories(organization_id,user_id,assistant_id,connection_id,key,content,source_label,expires_at)
    SELECT '${ORG}','${USER}','${ASSISTANT}','${CONNECTION}','page_'||n,'Synthetic note '||n,'Pagination fixture',clock_timestamp()+interval '1 day'
    FROM generate_series(1,200) n`);
  const schema = WORK_MEMORY_TOOLS.find(tool => tool.name === 'crm_work_memory_list').inputSchema.properties.offset;
  const identity = { row: { userId: USER, organizationId: ORG }, isSuperadmin: false };
  const offsets = [], seen = new Set();
  let offset = 0;
  do {
    assert.ok(Number.isInteger(offset) && offset >= schema.minimum && offset <= schema.maximum,
      `returned SQL cursor ${offset} must be accepted by the published MCP input schema`);
    const request = workMemoryInput('list', { offset });
    const result = workMemoryResult('list', await rpc('list', request), identity, request);
    assert.equal(result.items.length, 10); offsets.push(offset);
    for (const note of result.items) { assert.ok(!seen.has(note.id)); seen.add(note.id); }
    offset = result.nextOffset;
  } while (offset !== null);
  assert.deepEqual(offsets, Array.from({ length: 20 }, (_, index) => index * 10));
  assert.equal(seen.size, 200);
  assert.equal(schema.maximum, 200);
  const end = workMemoryInput('list', { offset: 200 });
  const empty = workMemoryResult('list', await rpc('list', end), identity, end);
  assert.deepEqual(empty.items, []); assert.equal(empty.nextOffset, null);
  assert.throws(() => workMemoryInput('list', { offset: 201 }), /invalid_request/);
  await assert.rejects(rpc('list', { ...list, offset: 201 }), /invalid/);
  await assert.rejects(rpc('upsert', { ...input, key: 'over_capacity' }), /limit/);
});
