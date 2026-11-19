import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupNghiemThu, BUILDING, OTHER_BUILDING, ROOM, ROOM_A201, OTHER_ROOM } from './task-nghiem-thu-fixture.mjs';
import { migration } from './task-action-fixture.mjs';

// Lượt 16 Công việc (C3k, nghiệm thu C3h CV-H04), trên PGlite (task-nghiem-thu-fixture.mjs + 091500 + 145100 + 20261025003100 +
// 20261026014500, mỗi file hai lượt): task.cancel / task.update chỉ nêu phòng mà phòng trùng nhiều toà ⇒ việc khớp chọn toà. Toà A
// có phòng "201", Toà B có "P201" (cùng khoá phòng 201) ⇒ phòng "201" trùng hai toà.
const NT2_SQL = migration('hermes_task_nghiem_thu_2_v1');
const NT3_SQL = migration('hermes_task_self_assign_guard_v1');
const NT4_SQL = migration('hermes_task_given_per_room_v1');
const NT5_SQL = migration('hermes_task_room_by_job_v1');
const V1_READ = readFileSync('supabase/migrations/20261022153345_hermes_domain_tasks_assignee_v1.sql', 'utf8').replaceAll('\r\n', '\n')
  .match(/CREATE OR REPLACE FUNCTION public\.hermes_domain_read_v1\([\s\S]*?\$fn\$;/)[0];
const slice = (text, head) => { const start = text.indexOf(head); assert.ok(start >= 0, head); return text.slice(start, text.indexOf('END $fn$;', start) + 'END $fn$;'.length); };
const mutate = (text, from, to) => { assert.equal(text.split(from).length, 2, `anchor: ${from.slice(0, 70)}`); return text.replace(from, () => to); };
const CORE = slice(NT5_SQL, 'CREATE OR REPLACE FUNCTION app_private.hermes_task_resolve_core_v1(');

async function setup(t) {
  const f = await setupNghiemThu(t);
  for (const sql of [NT2_SQL, NT3_SQL]) { await f.db.exec(sql); await f.db.exec(sql); }
  await f.db.exec(V1_READ);
  for (const sql of [NT4_SQL, NT5_SQL]) { await f.db.exec(sql); await f.db.exec(sql); }
  // Huỷ cần khoá tasks.delete ở trần công ty + kết nối + quyền CRM (như task-nghiem-thu-2-sql).
  await f.db.query("UPDATE app_private.hermes_org_policies SET action_capabilities=action_capabilities||ARRAY['tasks.delete']");
  await f.db.query("UPDATE app_private.hermes_connections SET action_capabilities=action_capabilities||ARRAY['tasks.delete']");
  await f.db.query("INSERT INTO public.fixture_acl(permission,building_ids) VALUES('tasks.delete',$1) ON CONFLICT(permission) DO UPDATE SET building_ids=excluded.building_ids,allowed=true",
    [[BUILDING, OTHER_BUILDING]]);
  return f;
}
const cancel = (f, n, params) => f.run('task.cancel', 'auto', n, { job: 'sửa khoá cửa', reason: 'khách tự sửa', ...params });

test('migration: installs on the 003100 body, twice; an unknown running body is refused', { timeout: 300000 }, async t => {
  const f = await setup(t);
  await f.db.exec("CREATE OR REPLACE FUNCTION app_private.hermes_task_resolve_core_v1(p_ctx jsonb,p_action text,p_params jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$");
  await assert.rejects(f.db.exec(NT5_SQL), /hermes_task_room_by_job_dependency_invalid/);
});

test('room in two buildings, one open job there ⇒ that job (its building), not a building question; a same-title job in another room is not it', { timeout: 300000 }, async t => {
  const f = await setup(t);
  await f.job('Sửa khoá cửa', BUILDING, ROOM);
  const b = await f.job('Sửa khoá cửa', OTHER_BUILDING, OTHER_ROOM);
  const room = await f.run('task.create', 'auto', 9, { roomName: '201', content: 'x', assigneeName: 'Nathan' });
  assert.deepEqual([room.kind, room.field, room.why], ['needs_input', 'room', 'ambiguous'], 'phòng "201" thật sự trùng hai toà');
  const one = await cancel(f, 1, { roomName: '201' });
  assert.deepEqual([one.kind, one.resolved?.jobId], ['preview', b], JSON.stringify(one));
  // Sửa việc ở toà khác toà người hỏi quản lý ⇒ xem trước (luật cũ); xem trước nêu đúng toà B, ghi vào đúng việc.
  const update = { job: 'sửa khoá cửa', roomName: '201', note: 'đã gọi thợ' };
  const preview = await f.run('task.update', 'auto', 2, update);
  assert.deepEqual([preview.kind, preview.resolved?.jobId, preview.preview?.building], ['preview', b, 'Toà B'], JSON.stringify(preview));
  const updated = await f.run('task.update', 'apply', 2, update, preview);
  assert.equal(updated.kind, 'applied', JSON.stringify(updated));
  const notes = (await f.db.query("SELECT id FROM public.jobs WHERE completion_description LIKE '%đã gọi thợ%'")).rows.map(r => r.id);
  assert.deepEqual(notes, [b]);
});

test('two open jobs in same-key rooms of two buildings ⇒ ask to choose the JOB, each with its building; never picks', { timeout: 300000 }, async t => {
  const f = await setup(t);
  await f.job('Sửa khoá cửa', BUILDING, ROOM_A201);
  await f.job('Sửa khoá cửa', OTHER_BUILDING, OTHER_ROOM);
  const asked = await cancel(f, 1, { roomName: '201' });
  assert.deepEqual([asked.kind, asked.field, asked.why], ['needs_input', 'job', 'ambiguous'], JSON.stringify(asked));
  assert.deepEqual(asked.candidates.map(c => c.buildingName).sort(), ['Toà A', 'Toà B']);
  assert.equal((await f.jobs()).filter(j => j.status === 'DELETED').length, 0);
});

test('no open job matches in any same-key room ⇒ the building question as before; naming the building still narrows', { timeout: 300000 }, async t => {
  const f = await setup(t);
  await f.job('Sửa khoá cửa', BUILDING, ROOM);
  const asked = await cancel(f, 1, { roomName: '201' });
  assert.deepEqual([asked.kind, asked.field, asked.why], ['needs_input', 'room', 'ambiguous'], JSON.stringify(asked));
  const a201 = await f.job('Sửa khoá cửa', BUILDING, ROOM_A201);
  await f.job('Sửa khoá cửa', OTHER_BUILDING, OTHER_ROOM);
  const named = await cancel(f, 2, { roomName: '201', buildingName: 'Toà A' });
  assert.deepEqual([named.kind, named.resolved?.jobId], ['preview', a201], JSON.stringify(named));
});

test('mutation (lượt 16): the job-picks-building branch, the room-key filter and the building-question fallback are each load-bearing', { timeout: 600000 }, async t => {
  const CASES = [
    ['job picks the building', mutate(CORE, "IF v_building IS NULL AND v_res->>'status'='unresolved' AND v_res->>'field'='room'", "IF false AND v_res->>'status'='unresolved' AND v_res->>'field'='room'"),
      async f => { await f.job('Sửa khoá cửa', OTHER_BUILDING, OTHER_ROOM); return (await cancel(f, 1, { roomName: '201' })).kind === 'preview'; }],
    ['room-key filter', mutate(CORE, 'AND (v_rkey IS NULL OR EXISTS(', 'AND (true OR EXISTS('),
      async f => { await f.job('Sửa khoá cửa', BUILDING, ROOM); await f.job('Sửa khoá cửa', OTHER_BUILDING, OTHER_ROOM); return (await cancel(f, 1, { roomName: '201' })).kind === 'preview'; }],
    ['building question when nothing matches', mutate(CORE, 'IF v_roomamb IS NOT NULL THEN RETURN v_roomamb; END IF;', ''),
      async f => (await cancel(f, 1, { roomName: '201' })).field === 'room'],
  ];
  for (const [label, mutant, probe] of CASES) {
    await t.test(label, async () => {
      assert.equal(await probe(await setup(t)), true, 'bản sửa chặn');
      const f = await setup(t);
      await f.db.exec(mutant);
      assert.equal(await probe(f), false, 'đột biến lọt ⇒ test không rỗng');
    });
  }
});
