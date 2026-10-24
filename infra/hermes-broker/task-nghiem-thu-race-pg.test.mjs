import test from 'node:test';
import assert from 'node:assert/strict';
import { localCluster } from './crm-shared-read-sql-fixture.mjs';
import { setupNghiemThu, binding, USER, rid } from './task-nghiem-thu-fixture.mjs';
import { SESSION } from '../hermes-zalo-router/private-command-fixture.mjs';

// Lượt 11b (review): hai lời gọi SONG SONG cùng dùng một lời mời chọn người nhận (Q31) ⇒ chỉ ghi MỘT việc. Cần MVCC thật (PGlite một
// kết nối) ⇒ cụm PostgreSQL cục bộ dùng một lần. Lượt A ghi (giữ khoá tư vấn (công ty, toà) của bước chuẩn bị, chưa COMMIT); lượt B
// đứng chờ ở khoá đó; A COMMIT ⇒ B thấy việc vừa tạo (trùng) và lời mời đã xoá ⇒ xem trước, không ghi.
test('PostgreSQL: two concurrent calls answering the same Q31 offer write exactly one job; the second previews after the first commits', { timeout: 300000 }, async t => {
  const { pool, cleanup } = await localCluster(t);
  const main = await pool.connect(), a = await pool.connect(), b = await pool.connect();
  t.after(async () => { for (const client of [main, a, b]) client.release(); await pool.end(); cleanup(); });
  const database = { exec: sql => main.query(sql), query: (sql, values) => main.query(sql, values), close: async () => {} };
  const f = await setupNghiemThu(t, { database });
  const base = { buildingName: 'Toà A', roomName: 'P101', jobType: 'sửa', content: 'thay bóng đèn hành lang' };
  assert.equal((await f.run('task.create', 'auto', 1, base)).kind, 'needs_input');
  const call = async (client, n) => {
    await client.query("SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.session',$2,true)",
      [USER, SESSION]);
    await client.query('SET LOCAL ROLE authenticated');
    return (await client.query('SELECT public.hermes_task_action_v1($1::jsonb,$2,$3,$4::uuid,$5::jsonb,NULL,NULL) result',
      [JSON.stringify(binding), 'task.create', 'auto', rid(n), JSON.stringify({ ...base, assigneeName: 'Nathan' })])).rows[0].result;
  };
  await a.query('BEGIN');
  const first = await call(a, 2);
  assert.equal(first.kind, 'applied', JSON.stringify(first));
  await b.query('BEGIN');
  let settled = false;
  const second = call(b, 3).then(value => { settled = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(settled, false, 'B đứng chờ khoá (công ty, toà) của A');
  await a.query('COMMIT');
  const late = await second;
  await b.query('COMMIT');
  assert.equal(late.kind, 'preview', JSON.stringify(late));
  assert.ok(late.warnings.some(w => /Đã có việc/.test(w)), 'lượt sau thấy việc vừa tạo');
  assert.equal((await main.query('SELECT count(*)::int n FROM public.jobs')).rows[0].n, 1, 'đúng một việc');
  assert.equal((await main.query('SELECT count(*)::int n FROM app_private.hermes_task_assignee_offers')).rows[0].n, 0, 'lời mời đã dùng');
});
