import test from 'node:test';
import assert from 'node:assert/strict';
import { localCluster } from './crm-shared-read-sql-fixture.mjs';
import { setupTaskActions, binding, USER } from './task-action-fixture.mjs';
import { SESSION } from '../hermes-zalo-router/private-command-fixture.mjs';

// Review Mốc 2 mục 4 (Q36): hai task.create song song, khác requestId, cùng toà + phòng + loại. Lời gọi sau phải chờ lời gọi trước
// COMMIT rồi mới tính việc trùng ⇒ thấy việc vừa tạo và chỉ xem trước, không ghi thẳng lần hai. Cần MVCC thật (PGlite một kết nối)
// nên chạy trên một cụm PostgreSQL cục bộ dùng một lần. Hai lớp khoá, đo riêng từng lớp:
//  1. Đường thật: guard khung chung (hermes_private_command_connection_v1 → lock_org_for_decision_v1) khoá dòng công ty FOR NO KEY
//     UPDATE trước mọi quyết định ⇒ mọi thao tác Hermes trong một công ty đã tuần tự.
//  2. Khoá tư vấn (công ty, toà) lấy TRƯỚC khi tính trùng (031548): giữ đúng tính chất kể cả khi guard thôi khoá công ty — test gỡ
//     khoá công ty rồi đo lại; B phải chờ đúng khoá tư vấn (đột biến "tính trùng trước khoá" / "bỏ khoá" làm ca này đỏ).
const params = content => ({ buildingName: 'Toà A', roomName: 'P101', jobType: 'sửa', content, assigneeName: 'tôi' });

test('Q36 race on PostgreSQL: the second concurrent create waits for the first and then needs a preview', { timeout: 300000 }, async t => {
  const { pool, cleanup } = await localCluster(t);
  // pool.end() chờ mọi kết nối được trả ⇒ trả cả ba rồi mới đóng cụm (một móc after duy nhất).
  const main = await pool.connect(), a = await pool.connect(), b = await pool.connect();
  t.after(async () => { for (const client of [main, a, b]) client.release(); await pool.end(); cleanup(); });
  const database = { exec: sql => main.query(sql), query: (sql, values) => main.query(sql, values), close: async () => {} };
  await setupTaskActions(t, { database });
  const begin = async client => {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.session',$2,true)",
      [USER, SESSION]);
    await client.query('SET LOCAL ROLE authenticated');
  };
  const create = (client, requestId, content) => client.query('SELECT public.hermes_task_action_v1($1::jsonb,$2,$3,$4::uuid,$5::jsonb,NULL,NULL) result',
    [JSON.stringify(binding), 'task.create', 'auto', requestId, JSON.stringify(params(content))]).then(result => result.rows[0].result);
  const pidB = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const race = async (n, content, waits) => {
    await begin(a);
    assert.equal((await create(a, `00000000-0000-4000-8000-${String(800 + n).padStart(12, '0')}`, content)).kind, 'applied', 'A: tự giao đủ thông tin ⇒ ghi thẳng (chưa COMMIT)');
    await begin(b);
    let settled = false;
    const second = create(b, `00000000-0000-4000-8000-${String(900 + n).padStart(12, '0')}`, content).then(value => { settled = true; return value; });
    await new Promise(done => setTimeout(done, 600));
    assert.equal(settled, false, 'B chờ A thay vì tính trùng trên dữ liệu cũ');
    const waiting = (await main.query('SELECT locktype FROM pg_locks WHERE pid=$1 AND NOT granted', [pidB])).rows;
    assert.deepEqual(waiting.map(row => row.locktype), [waits], `B chờ ${waits}`);
    await a.query('COMMIT');
    const outcome = await second;
    assert.equal(outcome.kind, 'preview', `B thấy việc A vừa tạo ⇒ xem trước: ${JSON.stringify(outcome)}`);
    assert.match(outcome.warnings.join(' '), new RegExp(`Đã có việc JOB-\\d{8}-\\d{4} '${content}' đang mở`));
    await b.query('ROLLBACK');
    assert.equal((await main.query('SELECT count(*)::int n FROM public.jobs WHERE title=$1', [content])).rows[0].n, 1, 'đúng một việc');
    await main.query("UPDATE public.jobs SET status='COMPLETED' WHERE title=$1", [content]);
  };

  await t.test('real path: the guard org lock (FOR NO KEY UPDATE) already serializes Hermes calls of one company', async () => {
    // B chờ dòng organizations của A (khoá dòng ⇒ chờ transactionid của A).
    await race(1, 'sửa vòi nước song song', 'transactionid');
  });
  await t.test('without the org lock: the (company, building) advisory lock taken before the duplicate check still holds', async () => {
    await main.query('CREATE OR REPLACE FUNCTION app_private.lock_org_for_decision_v1(o uuid) RETURNS void LANGUAGE plpgsql AS $f$BEGIN END$f$');
    await race(2, 'sửa vòi nước song song lần hai', 'advisory');
  });
});
