import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Source and mutation guards, not PL/pgSQL compilation or MVCC evidence.
const sql = readFileSync(new URL('../../supabase/migrations/20261012165523_hermes_zalo_binding_v1.sql', import.meta.url), 'utf8');
const body = (text, name) => {
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert(start >= 0, `missing ${name}`);
  const end = text.indexOf('END $$;', start);
  assert(end > start, `unterminated ${name}`);
  return text.slice(start, end);
};

function privacyContract(text) {
  const guard = body(text, 'app_private.hermes_zalo_shared_inbox_guard_v1');
  assert.match(guard, /SELECT \* INTO a FROM public\.zalo_accounts WHERE id=v_account FOR SHARE/);
  assert.match(guard, /v_private:=EXISTS\(SELECT 1 FROM app_private\.hermes_zalo_bots WHERE account_id IN \(a\.id,NEW\.account_id\)\)/);
  assert.doesNotMatch(guard, /\benabled\b|state='ACTIVE'/, 'disabled/revoked bots must remain private');
  assert.match(guard, /SELECT \* INTO c FROM public\.zalo_conversations WHERE id=NEW\.conversation_id FOR KEY SHARE;/,
    'parent protection must remain compatible with the legacy non-key preview UPDATE');
  assert.doesNotMatch(guard, /FROM public\.zalo_conversations[^;]*FOR (?:SHARE|UPDATE|NO KEY UPDATE)/);
  assert.match(guard, /v_account:=c\.account_id/);
  assert.match(guard, /NEW\.account_id IS DISTINCT FROM a\.id/);
  assert.match(guard, /account_id=v_old_account/);
  assert.match(guard, /OLD\.account_id IS DISTINCT FROM NEW\.account_id/);
  const conversationGuard = guard.slice(guard.indexOf("IF TG_TABLE_NAME='zalo_conversations' THEN"));
  assert.match(conversationGuard, /IF TG_OP='UPDATE' AND\s+\(NEW\.thread_type IS DISTINCT FROM OLD\.thread_type OR NEW\.thread_id IS DISTINCT FROM OLD\.thread_id\)\s+THEN RAISE EXCEPTION 'hermes_private_channel' USING ERRCODE='42501'; END IF;/,
    'all retained bot conversations, including groups, must keep their thread identity');
  assert(conversationGuard.indexOf("THEN RAISE EXCEPTION 'hermes_private_channel'") < conversationGuard.indexOf("IF NEW.thread_type='group' THEN RETURN NEW"),
    'freeze identity before allowing group preview updates');
  const afterAccountLock = guard.slice(guard.indexOf('FROM public.zalo_accounts WHERE id=v_account FOR SHARE;'));
  assert.match(afterAccountLock, /IF TG_TABLE_NAME='zalo_messages' THEN\s+(?:--[^\n]*\n\s*)*SELECT \* INTO c FROM public\.zalo_conversations WHERE id=NEW\.conversation_id FOR KEY SHARE;/,
    'refresh parent classification after waiting for account privacy enable');
  assert.match(guard, /NEW\.organization_id IS DISTINCT FROM a\.organization_id/);
  assert.match(guard, /NEW\.last_message_text:='\[Hermes private - hidden\]'/);
  assert.match(guard, /NEW\.unread_count:=0/);
  assert.match(guard, /NEW\.body IS DISTINCT FROM '\[Hermes link - hidden\]'/);
  assert.match(guard, /NEW\.zalo_raw:=jsonb_build_object/);
  for (const field of ['media_url','media_label','media_meta','media_tone','reply_to','reaction_emoji']) assert.match(guard, new RegExp(`NEW\\.${field}:=NULL`));
  assert.match(guard, /NEW\.reactions:='\{\}'::jsonb/);
  for (const table of ['conversations','messages']) assert.match(text,
    new RegExp(`BEFORE INSERT OR UPDATE ON public\\.zalo_${table}\\s+FOR EACH ROW EXECUTE FUNCTION app_private\\.hermes_zalo_shared_inbox_guard_v1\\(\\)`));
  assert.match(text, /REVOKE ALL ON FUNCTION app_private\.hermes_zalo_shared_inbox_guard_v1\(\) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor/);
  assert.doesNotMatch(text, /GRANT[^;]*hermes_zalo_shared_inbox_guard_v1/);
  const browser = body(text, 'public.hermes_zalo_binding_v1');
  assert.match(browser, /FROM public\.zalo_accounts WHERE id=v_account AND organization_id=o AND kind='personal' FOR UPDATE/);
  const ingress = body(text, 'public.hermes_zalo_ingress_v1');
  const normalized = ingress.replaceAll('\r\n','\n');
  const privacyStart = normalized.indexOf("IF op='privacy' THEN\n");
  assert(privacyStart >= 0, 'explicit private-channel operation');
  const fragment = normalized.slice(privacyStart);
  assert.match(fragment, /a\.user_id IS DISTINCT FROM app_private\.hermes_uuid_v1\(p->'accountOwnerId'\)/);
  assert.match(fragment, /a\.zalo_uid IS DISTINCT FROM p->>'ownUid'/);
  assert.match(fragment, /a\.login_requested_at IS DISTINCT FROM \(p->>'loginRequestedAt'\)::timestamptz/);
  assert.match(fragment, /CASE WHEN EXISTS\(SELECT 1 FROM app_private\.hermes_zalo_bots WHERE account_id=a\.id\)\s+THEN 'private' ELSE 'shared' END,'accountId',a\.id,'organizationId',a\.organization_id/);
  assert(ingress.indexOf("IF op='privacy' THEN") < ingress.indexOf('AND enabled FOR SHARE'), 'privacy decision must precede enabled-only registration');
  assert.match(ingress, /heartbeat_at>clock_timestamp\(\)-interval '30 seconds' FOR UPDATE/);
}

test('private DM storage boundary retains existing worker ownership and separates groups (source only)', () => privacyContract(sql));

function providerLoggingContract(text, count) {
  const constructors = [...text.matchAll(/new Zalo\(\{([^}]+)\}\)/g)];
  assert.equal(constructors.length, count, 'all known provider session constructors are covered');
  for (const [, options] of constructors) assert.match(options, /\blogging:\s*false\b/, 'provider parse errors must not log private raw content');
}
for (const [file, count] of [['login', 2], ['watchdog', 1]]) {
  const source = readFileSync(new URL(`../../worker/lib/${file}.js`, import.meta.url), 'utf8');
  test(`${file} suppresses provider raw-error logging (source only)`, () => providerLoggingContract(source, count));
  test(`${file} logging regression mutation is caught`, () => {
    assert(source.includes('logging: false'));
    assert.throws(() => providerLoggingContract(source.replace('logging: false', 'logging: true'), count), assert.AssertionError);
  });
}
for (const [name, from, to] of [
  ['revoked bot fallback', 'WHERE account_id IN (a.id,NEW.account_id)', 'WHERE enabled AND account_id IN (a.id,NEW.account_id)'],
  ['account serialization removed', "kind='personal' FOR UPDATE;", "kind='personal' FOR SHARE;"],
  ['account write fence weakened', 'WHERE id=v_account FOR SHARE;', 'WHERE id=v_account FOR KEY SHARE;'],
  ['preview lock conflict restored', 'WHERE id=NEW.conversation_id FOR KEY SHARE;', 'WHERE id=NEW.conversation_id FOR SHARE;'],
  ['retained group identity exemption', '(NEW.thread_type IS DISTINCT FROM OLD.thread_type OR NEW.thread_id IS DISTINCT FROM OLD.thread_id)',
    "(OLD.thread_type<>'group' AND (NEW.thread_type IS DISTINCT FROM OLD.thread_type OR NEW.thread_id IS DISTINCT FROM OLD.thread_id))"],
  ['nullable account bypass', 'v_account:=c.account_id;', 'v_account:=NEW.account_id;'],
  ['message fence removed', 'BEFORE INSERT OR UPDATE ON public.zalo_messages', 'BEFORE INSERT ON public.zalo_messages'],
  ['preview leaked', "NEW.last_message_text:='[Hermes private - hidden]';", 'NULL;'],
  ['raw metadata leaked', 'NEW.zalo_raw:=jsonb_build_object', 'NEW.zalo_raw:=jsonb_strip_nulls'],
  ['login snapshot bypass', "a.login_requested_at IS DISTINCT FROM (p->>'loginRequestedAt')::timestamptz", 'false'],
]) test(`privacy source mutation is caught: ${name}`, () => {
  assert(sql.includes(from), `mutation witness ${name}`);
  const mutated = name === 'login snapshot bypass' ? sql.replaceAll(from, to) : sql.replace(from, to);
  assert.throws(() => privacyContract(mutated), assert.AssertionError);
});
