import test from 'node:test';
import assert from 'node:assert/strict';
import { localCluster } from './crm-shared-read-sql-fixture.mjs';
import { setupReminders, ORG, USER, INSTANCE } from './task-reminder-fixture.mjs';

// Công việc Mốc 6 (CONG-VIEC-THAO-TAC-GHI.md mục 6, 23): hàng đợi nhắc việc chạy song song cần MVCC thật (PGlite một kết nối) ⇒ cụm
// PostgreSQL cục bộ dùng một lần.
//  1. Hai lượt bộ sinh cùng lúc: lượt sau gặp khoá tư vấn của công ty ⇒ bỏ qua (busy), không chờ; sau khi lượt trước COMMIT, chạy lại
//     không thêm dòng (UNIQUE người, loại, ngày). Đúng hai tin.
//  2. Hai worker claim cùng lúc: SKIP LOCKED ⇒ hai tập rời nhau, không ai đứng chờ.
//  3. Bộ sinh dọn lease trong lúc worker đang begin một tin: SKIP LOCKED ⇒ không chờ, không cướp tin đang gửi.
// Phần worker chạy theo GIỜ THẬT (tin được đưa về "hôm nay") ⇒ hạn việc cũng phải là hôm nay theo giờ Việt Nam.
// Ghim cứng 23/10/2026 làm ca begin đỏ từ 00:00 24/10 (việc hết là "hạn hôm nay" ⇒ jobs_closed).
const vnNgay = (luiNgay = 0) => new Date(Date.now() + 7 * 3600e3 - luiNgay * 86400e3).toISOString().slice(0, 10);
const AT = `${vnNgay()} 08:05:00+07`;
const DUE = `${vnNgay()} 23:59:59.999+07`, OVER2 = `${vnNgay(2)} 23:59:59.999+07`;

test('PostgreSQL: concurrent enqueue is busy-skipped and deduplicated; concurrent claims are disjoint; reaping never waits on a live send', { timeout: 300000 }, async t => {
  const { pool, cleanup } = await localCluster(t);
  const main = await pool.connect(), a = await pool.connect(), b = await pool.connect();
  t.after(async () => { for (const client of [main, a, b]) client.release(); await pool.end(); cleanup(); });
  const database = { exec: sql => main.query(sql), query: (sql, values) => main.query(sql, values), close: async () => {} };
  const f = await setupReminders(t, { database });
  await f.enable();
  await f.job('JOB-A', USER, DUE);
  await f.job('JOB-C', USER, OVER2);
  const enqueue = client => client.query('SELECT app_private.task_reminder_enqueue_v1($1::timestamptz) r', [AT]).then(result => result.rows[0].r);
  const count = async () => (await main.query('SELECT count(*)::int n FROM app_private.task_reminder_outbox')).rows[0].n;

  await t.test('two concurrent enqueue runs: the second is busy instead of waiting; rerun adds nothing', async () => {
    await a.query('BEGIN');
    assert.equal((await enqueue(a)).queued, 2);
    await b.query('BEGIN');
    const started = Date.now();
    const second = await enqueue(b);
    assert.deepEqual([second.busy, second.queued], [1, 0], 'B gặp khoá tư vấn của công ty');
    assert.ok(Date.now() - started < 2000, 'B không đứng chờ A');
    await b.query('COMMIT');
    await a.query('COMMIT');
    assert.equal((await enqueue(main)).queued, 0);
    assert.equal(await count(), 2);
  });

  await t.test('two concurrent claims take disjoint messages (SKIP LOCKED)', async () => {
    // Worker test chạy theo giờ thật: đưa hai tin về hôm nay, đến giờ, không giờ yên.
    await main.query("UPDATE app_private.task_reminder_outbox SET reminder_date=(clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,not_before=clock_timestamp()-interval '1 second'");
    await main.query('INSERT INTO app_private.notification_org_config(organization_id,quiet_start,quiet_end) VALUES($1,0,0) ON CONFLICT(organization_id) DO UPDATE SET quiet_start=0,quiet_end=0', [ORG]);
    const claim = async client => { await client.query('SET LOCAL ROLE service_role');
      return (await client.query('SELECT public.zalo_worker_claim_task_reminders_v1($1,1) r', [INSTANCE])).rows[0].r; };
    await a.query('BEGIN'); await b.query('BEGIN');
    const first = await claim(a);
    const started = Date.now();
    const second = await claim(b);
    assert.ok(Date.now() - started < 2000, 'không đứng chờ');
    assert.deepEqual([first.items.length, second.items.length], [1, 1]);
    assert.notEqual(first.items[0].id, second.items[0].id);
    await a.query('COMMIT'); await b.query('COMMIT');
    const states = (await main.query("SELECT state,count(*)::int n FROM app_private.task_reminder_outbox GROUP BY state")).rows;
    assert.deepEqual(states, [{ state: 'claimed', n: 2 }]);
  });

  await t.test('reaping expired leases skips a message a worker is beginning right now', async () => {
    const [row] = (await main.query("SELECT id FROM app_private.task_reminder_outbox ORDER BY kind LIMIT 1")).rows;
    await main.query("UPDATE app_private.task_reminder_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id<>$1", [row.id]);
    await a.query('BEGIN'); await a.query('SET LOCAL ROLE service_role');
    const began = (await a.query('SELECT public.zalo_worker_begin_task_reminder_v1($1,$2) r', [row.id, INSTANCE])).rows[0].r;
    assert.equal(began.ok, true, JSON.stringify(began));
    const started = Date.now();
    const result = await enqueue(b);
    assert.ok(Date.now() - started < 2000, 'bộ sinh không đứng chờ dòng worker đang giữ');
    assert.equal(result.reaped, 1, 'chỉ tin kia (claimed quá hạn) được dọn');
    await a.query('COMMIT');
    const rows = (await main.query('SELECT id,state FROM app_private.task_reminder_outbox ORDER BY kind')).rows;
    assert.deepEqual(rows.map(r => [r.id === row.id, r.state]).sort(), [[false, 'queued'], [true, 'sending']].sort());
  });
});
