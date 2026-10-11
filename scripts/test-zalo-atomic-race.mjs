// Live concurrency proof on the marked TEST project only. Apply the pending
// migration with test-env:thu-sql --ghi first. Uses a fresh synthetic org/user,
// commits race outcomes, then deletes exactly those fixture IDs under the lease.
// No provider calls, Zalo session credentials, or production connection is used.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { credential, ketNoi, kiemCongCu, lit, psql, psqlJson, PhienPsql } from './test-env/lib.mjs';
import { assertTestLease, markTestCleanupRequired, withTestCleanup, withTestLock } from './test-env/lock.mjs';

const org = randomUUID(), user = randomUUID(), account = randomUUID();
const conversations = Array.from({ length: 4 }, () => randomUUID());
const marker = `zalo-race-${org}`;
const migration = new URL('../supabase/migrations/20261011052259_zalo_rpc_only_scope_va_atomic_queue.sql', import.meta.url);
const evidence = { schemaVersion: 1, migrationSha256: createHash('sha256').update(readFileSync(migration)).digest('hex'), checks: [], cleanup: false };
const pass = check => { evidence.checks.push(check); console.log(`PASS ${check}`); };
const uuid = value => `${lit(value)}::uuid`;

async function main() {
  kiemCongCu();
  const cred = credential();
  const { test } = await ketNoi(cred);
  await withTestLock({ cred, test }, async lease => {
    await assertTestLease(lease, test);
    assert(psqlJson(test, "SELECT to_regprocedure('public.zalo_enqueue_auto_reply_v1(uuid,text,text,jsonb)') IS NOT NULL AS ready")[0].ready, 'Apply reviewed migration to TEST first.');
    const sessions = [new PhienPsql(test), new PhienPsql(test)], blocker = new PhienPsql(test);
    markTestCleanupRequired(lease, test);
    try {
      psql(test, `BEGIN;
        INSERT INTO public.organizations(id,slug,name) VALUES(${uuid(org)},${lit(marker)},${lit(marker)});
        INSERT INTO auth.users(id,email,aud,role) VALUES(${uuid(user)},${lit(`${marker}@example.invalid`)},'authenticated','authenticated');
        INSERT INTO public.organization_memberships(organization_id,user_id,member_type,status) VALUES(${uuid(org)},${uuid(user)},'SERVICE','ACTIVE');
        INSERT INTO public.zalo_accounts(id,user_id,organization_id,name,status,kind) VALUES(${uuid(account)},${uuid(user)},${uuid(org)},'Synthetic SQL race','connected','personal');
        ${conversations.map((id, index) => `INSERT INTO public.zalo_conversations(id,user_id,organization_id,account_id,thread_id,peer_name,is_sale_partner) VALUES(${uuid(id)},${uuid(user)},${uuid(org)},${uuid(account)},'synthetic-${index}','Synthetic',true);`).join('\n')}
        ${conversations.flatMap((id, index) => [1, 2].map(number => `INSERT INTO public.zalo_messages(user_id,organization_id,account_id,conversation_id,direction,msg_type,body,status,zalo_msg_id) VALUES(${uuid(user)},${uuid(org)},${uuid(account)},${uuid(id)},'in','text','phòng','sent','source-${index}-${number}');`)).join('\n')}
        INSERT INTO public.zalo_automations(user_id,organization_id,kind,enabled,config) VALUES(${uuid(user)},${uuid(org)},'auto_reply',true,'{"keywords":["phòng"],"dailyCap":1,"cooldownMinutes":30}');
        INSERT INTO public.zalo_automations(user_id,organization_id,kind,enabled,config) VALUES(${uuid(user)},${uuid(org)},'broadcast_vacant',true,jsonb_build_object('recipients',jsonb_build_array(${uuid(conversations[0])}),'antiSpam',jsonb_build_object('dailyCap',10,'allowedHours',jsonb_build_object('from','00:00','to','23:59'))));
        COMMIT;`);
      for (let i = 0; i < sessions.length; i++) {
        await sessions[i].chay(`SET application_name=${lit(`${marker}-${i}`)}; SET statement_timeout='15s'; SET ROLE service_role;`);
      }
      await blocker.chay("SET statement_timeout='15s';");
      async function race(sqlA, sqlB) {
        await assertTestLease(lease, test);
        // Hold the same org lock so both actual database backends must wait.
        await blocker.chay(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('zalo_automation:'||${lit(org)},0));`);
        const pending = sessions.map((session, i) => session.json(`SELECT ${i === 0 ? sqlA : sqlB} AS result`));
        const settledPromise = Promise.allSettled(pending);
        let waiting = 0;
        try {
          for (let n = 0; n < 20; n++) {
            waiting = psqlJson(test, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name IN (${lit(`${marker}-0`)},${lit(`${marker}-1`)}) AND wait_event_type='Lock' AND state='active'`)[0].n;
            if (waiting === 2) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        } finally { await blocker.chay('COMMIT;'); }
        const settled = await settledPromise;
        assert.equal(waiting, 2, 'Both independent PostgreSQL sessions must visibly wait for the org lock.');
        assert(settled.every(result => result.status === 'fulfilled'), 'Both committed RPC requests must complete before cleanup.');
        return settled.map(result => result.value[0].result);
      }
      const auto = (index, source) => `public.zalo_enqueue_auto_reply_v1(${uuid(conversations[index])},'Synthetic reply',${lit(source)})`;
      let results = await race(auto(0, 'source-0-1'), auto(1, 'source-1-1'));
      assert.deepEqual(results.map(result => result.status).sort(), ['queued', 'skipped']);
      assert.match(results.find(result => result.status === 'skipped').reason, /trần/);
      assert.equal(psqlJson(test, `SELECT count(*)::int AS n FROM public.zalo_automation_runs WHERE organization_id=${uuid(org)} AND mode='reply'`)[0].n, 1);
      pass('two concurrent conversations reserve exactly one daily quota slot');
      psql(test, `UPDATE public.zalo_automations SET config=jsonb_set(config,'{dailyCap}','100') WHERE organization_id=${uuid(org)} AND kind='auto_reply';`);
      results = await race(auto(2, 'source-2-1'), auto(2, 'source-2-2'));
      assert.deepEqual(results.map(result => result.status).sort(), ['queued', 'skipped']);
      assert.match(results.find(result => result.status === 'skipped').reason, /chống lặp/);
      pass('two concurrent sources in one conversation obey cooldown');
      results = await race(auto(3, 'source-3-1'), auto(3, 'source-3-1'));
      assert(results.every(result => result.status === 'queued'));
      assert.equal(results[0].job_id, results[1].job_id);
      assert.deepEqual(results.map(result => result.reused).sort(), [false, true]);
      pass('concurrent replay of the same inbound source creates one message-job-run');
      const broadcast = `public.zalo_enqueue_broadcast_v1(${uuid(conversations[0])},'Synthetic broadcast',clock_timestamp(),'synthetic-same-request')`;
      results = await race(broadcast, broadcast);
      assert(results.every(result => result.status === 'queued'));
      assert.equal(results[0].job_id, results[1].job_id);
      assert.deepEqual(results.map(result => result.reused).sort(), [false, true]);
      assert.equal(psqlJson(test, `SELECT count(*)::int AS n FROM public.zalo_send_queue WHERE organization_id=${uuid(org)}`)[0].n, 4);
      pass('concurrent broadcast request retry creates exactly one queued job');
    } finally {
      // Settle/close both provider-free SQL sessions before deleting fixture rows.
      await Promise.allSettled([...sessions, blocker].map(session => session.dong()));
      await withTestCleanup(lease, test, async cleanupLease => {
        await assertTestLease(cleanupLease, test);
        const rows = psqlJson(test, `SELECT name FROM public.organizations WHERE id=${uuid(org)}`);
        assert(rows.every(row => row.name === marker), 'Only this fresh synthetic org may be cleaned.');
        psql(test, `BEGIN;
          DELETE FROM public.zalo_automation_runs WHERE organization_id=${uuid(org)};
          DELETE FROM public.zalo_send_queue WHERE organization_id=${uuid(org)};
          DELETE FROM public.zalo_messages WHERE organization_id=${uuid(org)};
          DELETE FROM public.zalo_conversations WHERE organization_id=${uuid(org)};
          DELETE FROM public.zalo_automations WHERE organization_id=${uuid(org)};
          DELETE FROM public.zalo_accounts WHERE organization_id=${uuid(org)};
          DELETE FROM public.organization_memberships WHERE organization_id=${uuid(org)} AND user_id=${uuid(user)};
          DELETE FROM public.organizations WHERE id=${uuid(org)} AND name=${lit(marker)};
          DELETE FROM public.profiles WHERE id=${uuid(user)};
          DELETE FROM auth.users WHERE id=${uuid(user)} AND email=${lit(`${marker}@example.invalid`)};
          COMMIT;`);
        assert.equal(psqlJson(test, `SELECT (SELECT count(*) FROM public.organizations WHERE id=${uuid(org)})+(SELECT count(*) FROM auth.users WHERE id=${uuid(user)}) AS n`)[0].n, 0);
        evidence.cleanup = true;
      });
    }
  });
}

main().then(() => {
  const path = process.argv.find(arg => arg.startsWith('--evidence='))?.slice('--evidence='.length);
  if (path) writeFileSync(path, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
}, error => {
  console.error(JSON.stringify({ ...evidence, status: 'FAILED', error: String(error?.message || error).slice(0, 1500) }));
  process.exitCode = 1;
});
