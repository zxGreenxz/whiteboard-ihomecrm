import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { setupFollow, ASSIGNEE, USER, ORG, TYPE, u } from './task-follow-fixture.mjs';

// Q35 (CV-M2, 20261022031600) và Q64 (CV-M2b, bản nháp chờ chủ ở docs/plans/hermes-crm/cho-chu/) trên PGlite, nền fixture theo dõi việc (bảng jobs + RLS + thân
// hermes_task_follow_read_v1 thật). Người được giao thấy việc của chính mình ở toà ngoài phạm vi buildings.view — qua RLS web và
// qua danh sách "giao cho tôi" của Hermes (cùng một hàm); người khác vẫn không thấy. Q64 (migration riêng): người nhận ghi tiến
// độ / hoàn thành việc của mình, không đổi được cột khác, không mở lại việc đã xong; người có tasks.edit đi như cũ.
const migration = slug => { const found = readdirSync('supabase/migrations').filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name));
  assert.equal(found.length, 1, slug); return readFileSync(`supabase/migrations/${found[0]}`, 'utf8').replaceAll('\r\n', '\n'); };
// Q64 chưa được chủ trả lời ⇒ bản nháp nằm NGOÀI supabase/migrations (review Mốc 2 mục 2); test vẫn chạy nó trên cùng fixture.
const VISIBLE = migration('jobs_assignee_visible_v1');
const PROGRESS = readFileSync('docs/plans/hermes-crm/cho-chu/q64_jobs_assignee_progress_complete.sql', 'utf8').replaceAll('\r\n', '\n');
const FAR = u(901), OTHER = u(104);

test('Q35 view + Q64 progress/complete for the assignee of a job outside their buildings', { timeout: 300000 }, async t => {
  const f = await setupFollow(t);
  const { db, read } = f;
  await db.query('INSERT INTO public.buildings(id,organization_id) VALUES($1,$2)', [FAR, ORG]);
  // Việc ở toà FAR (không ai có buildings.view / tasks.* ở đó trong fixture) giao cho ASSIGNEE.
  const farJob = u(902);
  await db.query(`INSERT INTO public.jobs(id,user_id,code,title,building_id,job_type_id,priority,assignee_id,status,organization_id,started_at)
    VALUES($1,$2,'JOB-FAR-1','Sửa ở toà xa',$3,$4,'NORMAL',$5,'IN_PROGRESS',$6,clock_timestamp())`, [farJob, USER, FAR, TYPE, ASSIGNEE, ORG]);
  const nearJob = await f.job({ title: 'Việc toà gần' });
  const visibleTo = async (actor, session) => {
    await db.exec('BEGIN');
    await db.query("SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.session',$2,true)", [actor, session ?? actor]);
    await db.exec('SET LOCAL ROLE authenticated');
    try { return (await db.query('SELECT id FROM public.jobs ORDER BY id')).rows.map(r => r.id); } finally { await db.exec('ROLLBACK'); }
  };
  const asUser = async (actor, sql, params = []) => {
    await db.exec('BEGIN');
    await db.query("SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true)", [actor]);
    await db.exec('SET LOCAL ROLE authenticated');
    try { const result = await db.query(sql, params); await db.exec('COMMIT'); return result.affectedRows ?? result.rows.length; }
    catch (error) { await db.exec('ROLLBACK'); throw error; } finally { await db.exec('RESET ROLE'); }
  };
  const mine = async () => (await read({ organizationId: ORG, role: 'assigned_to_me', assigneeUserId: null, status: 'open', limit: 50, offset: 0 }, 'assignee')).items.map(i => i.id);

  await t.test('before: the assignee sees neither the far job (RLS) nor in the Hermes list', async () => {
    assert.deepEqual((await visibleTo(ASSIGNEE)).includes(farJob), false);
    assert.deepEqual(await mine(), [nearJob]);
  });

  await t.test('after Q35: assignee sees the far job on the web (RLS) and in "assigned to me"; others still do not', async () => {
    await db.exec(VISIBLE); await db.exec(VISIBLE);
    assert.equal((await visibleTo(ASSIGNEE)).includes(farJob), true);
    assert.equal((await visibleTo(OTHER)).includes(farJob), false, 'người không phải người nhận');
    assert.equal((await visibleTo(USER)).includes(farJob), false, 'người tạo không có toà đó cũng không thấy (luật chỉ cho người nhận)');
    assert.deepEqual((await mine()).sort(), [farJob, nearJob].sort());
    const team = await read({ organizationId: ORG, role: 'team', assigneeUserId: null, status: 'open', limit: 50, offset: 0 }, 'assignee');
    assert.equal(team.items.some(i => i.id === farJob), false, 'role team vẫn theo phạm vi toà');
    // Chưa áp Q64: thấy nhưng không sửa được (RLS UPDATE đòi tasks.edit ở toà).
    assert.equal(await asUser(ASSIGNEE, "UPDATE public.jobs SET completion_description='đã mua vòi' WHERE id=$1", [farJob]), 0);
  });

  await t.test('Q64: assignee writes progress and completes own job; other columns, reopening and non-assignees are refused', async () => {
    await db.exec(PROGRESS); await db.exec(PROGRESS);
    assert.equal(await asUser(ASSIGNEE, "UPDATE public.jobs SET completion_description='đã mua vòi, chiều lắp' WHERE id=$1", [farJob]), 1);
    for (const [sql, label] of [["UPDATE public.jobs SET title='đổi tiêu đề' WHERE id=$1", 'tiêu đề'],
      ['UPDATE public.jobs SET building_id=NULL WHERE id=$1', 'toà'], ['UPDATE public.jobs SET assignee_id=NULL WHERE id=$1', 'người nhận'],
      ["UPDATE public.jobs SET deadline=now()+interval '9 days' WHERE id=$1", 'hạn']])
      await assert.rejects(asUser(ASSIGNEE, sql, [farJob]), error => error.code === '42501', label);
    assert.equal(await asUser(ASSIGNEE, "UPDATE public.jobs SET status='COMPLETED' WHERE id=$1", [farJob]), 1);
    await assert.rejects(asUser(ASSIGNEE, "UPDATE public.jobs SET status='IN_PROGRESS' WHERE id=$1", [farJob]), error => error.code === '42501', 'không mở lại');
    assert.equal(await asUser(OTHER, "UPDATE public.jobs SET completion_description='x' WHERE id=$1", [farJob]), 0, 'người khác: RLS chặn');
    assert.deepEqual((await db.query('SELECT status,completion_description,title FROM public.jobs WHERE id=$1', [farJob])).rows,
      [{ status: 'COMPLETED', completion_description: 'đã mua vòi, chiều lắp', title: 'Sửa ở toà xa' }]);
    // Người có tasks.edit ở toà (ASSIGNEE ở toà gần) vẫn sửa đủ cột như web.
    assert.equal(await asUser(ASSIGNEE, "UPDATE public.jobs SET title='Việc toà gần (sửa)' WHERE id=$1", [nearJob]), 1);
    // Hàm hệ thống (vai postgres) không bị guard chạm.
    await db.query("UPDATE public.jobs SET title='hệ thống đổi' WHERE id=$1", [farJob]);
  });
});
