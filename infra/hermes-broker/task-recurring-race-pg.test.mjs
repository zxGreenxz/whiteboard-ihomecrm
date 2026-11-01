import test from 'node:test';
import assert from 'node:assert/strict';
import { localCluster } from './crm-shared-read-sql-fixture.mjs';
import { setupRecurring, binding, ORG, USER, BUILDING, MANAGER, TYPE_SUA } from './task-recurring-fixture.mjs';
import { SESSION } from '../hermes-zalo-router/private-command-fixture.mjs';

// Công việc Mốc 5 (CONG-VIEC-THAO-TAC-GHI.md mục 5.2, 22): bộ sinh việc định kỳ chạy song song cần MVCC thật (PGlite một kết nối) ⇒ cụm
// PostgreSQL cục bộ dùng một lần.
//  1. Hai lượt sinh cùng lúc: lượt sau gặp dòng quy tắc đang bị lượt trước giữ (FOR NO KEY UPDATE SKIP LOCKED) ⇒ bỏ qua, không chờ, không
//     sinh; sau khi lượt trước COMMIT, chạy lại cũng không sinh thêm (khoá (quy tắc, ngày)). Đúng MỘT việc.
//  2. Hermes tạm dừng quy tắc trong lúc bộ sinh giữ dòng: bước chuẩn bị khoá dòng NOWAIT ⇒ 55P03 ngay (connector ⇒ state_changed),
//     không đứng chờ; bộ sinh không khoá dòng công ty nên không có vòng với guard.
const VN = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d);
const today = VN(new Date());

test('PostgreSQL: concurrent generator runs make exactly one job per (rule, day); Hermes pause during a run fails fast with 55P03', { timeout: 300000 }, async t => {
  const { pool, cleanup } = await localCluster(t);
  // pg-pool resolves end() before client sockets close; stopping the cluster then can emit a late 57P01
  // (same fix as invoice-write-race-sql.test.mjs / trackPoolDrain in stable-binding-postgres.test.mjs).
  const clientEnds = [];
  pool.on('connect', client => { clientEnds.push(new Promise(resolve => client.once('end', resolve))); });
  const main = await pool.connect(), a = await pool.connect(), b = await pool.connect();
  t.after(async () => { for (const client of [main, a, b]) client.release(); await pool.end(); await Promise.all(clientEnds); cleanup(); });
  const database = { exec: sql => main.query(sql), query: (sql, values) => main.query(sql, values), close: async () => {} };
  const f = await setupRecurring(t, { database });
  await main.query("UPDATE app_private.hermes_org_policies SET action_capabilities=action_capabilities||ARRAY['tasks.edit']");
  await main.query("UPDATE app_private.hermes_connections SET action_capabilities=action_capabilities||ARRAY['tasks.edit']");
  const rule = await f.call(`SELECT to_jsonb(x) result FROM public.job_recurrence_create_v1($1,$2,NULL,$3,'kiểm máy bơm',NULL,$4,NULL,'daily',1,NULL,NULL,$5::date,NULL,0) x`,
    [ORG, BUILDING, TYPE_SUA, MANAGER, today]);
  const generate = client => client.query('SELECT app_private.hermes_task_recurrence_generate_v1($1::date) r', [today]).then(result => result.rows[0].r);
  const jobs = async () => (await main.query('SELECT count(*)::int n FROM public.job_recurrence_occurrences o JOIN public.jobs j ON j.id=o.job_id')).rows[0].n;

  await t.test('two concurrent runs: the second skips the locked rule instead of waiting; still one job after both commit and a rerun', async () => {
    await a.query('BEGIN');
    assert.deepEqual(await generate(a), { checked: 1, generated: 1, paused: 0, failed: 0, busy: 0 });
    await b.query('BEGIN');
    const started = Date.now();
    assert.deepEqual(await generate(b), { checked: 0, generated: 0, paused: 0, failed: 0, busy: 1 }, 'B bỏ qua dòng đang bị A giữ');
    assert.ok(Date.now() - started < 2000, 'B không đứng chờ A');
    await b.query('COMMIT');
    await a.query('COMMIT');
    assert.equal((await generate(main)).generated, 0, 'chạy lại sau khi A COMMIT: khoá (quy tắc, ngày) đã có');
    assert.equal(await jobs(), 1);
  });

  await t.test('Hermes pause while a run holds the rule row: NOWAIT ⇒ 55P03 at once; after the run it previews normally', async () => {
    await main.query('UPDATE public.job_recurrence_rules SET last_generated_date=$1::date-1 WHERE id=$2', [today, rule.id]);
    await main.query('DELETE FROM public.job_recurrence_occurrences WHERE rule_id=$1', [rule.id]);
    await a.query('BEGIN');
    await generate(a);
    await b.query('BEGIN');
    await b.query("SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.session',$2,true)",
      [USER, SESSION]);
    await b.query('SET LOCAL ROLE authenticated');
    const started = Date.now();
    await assert.rejects(b.query('SELECT public.hermes_task_action_v1($1::jsonb,$2,$3,$4::uuid,$5::jsonb,NULL,NULL) result',
      [JSON.stringify(binding), 'task.recurring_pause', 'auto', '00000000-0000-4000-8000-000000008801', JSON.stringify({ rule: 'DK-0001' })]),
      error => error.code === '55P03');
    assert.ok(Date.now() - started < 2000, 'không đứng chờ bộ sinh');
    await b.query('ROLLBACK');
    await a.query('COMMIT');
    const preview = await f.run('task.recurring_pause', 'auto', '00000000-0000-4000-8000-000000008802', { rule: 'DK-0001' });
    assert.equal(preview.kind, 'preview', JSON.stringify(preview));
  });
});
