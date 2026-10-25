import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupNghiemThu, ORG, OTHER_BUILDING, ROOM, ROOM_A201, MANAGER } from './task-nghiem-thu-fixture.mjs';
import { migration } from './task-action-fixture.mjs';

// Lượt 14 Công việc (nghiệm thu C3f), phía SQL của task.create_batch perRoom trên PGlite (task-nghiem-thu-fixture.mjs + 091500 +
// 145100 + 20261025003100, mỗi file hai lượt): "toà X, mỗi phòng một việc" ⇒ mỗi phòng chưa xoá của toà một mục, xem trước như lô;
// > 20 phòng ⇒ needs_input batch_too_large kèm số phòng thật. Bộ đọc miền v1 (cùng file) đo ở domain-composition.test.mjs; ở đây chỉ
// cài thân 20261022153345 của nó (không gọi) để file migration chạy nguyên vẹn.
const NT2_SQL = migration('hermes_task_nghiem_thu_2_v1');
const NT3_SQL = migration('hermes_task_self_assign_guard_v1');
const NT4_SQL = migration('hermes_task_given_per_room_v1');
const V1_READ = readFileSync('supabase/migrations/20261022153345_hermes_domain_tasks_assignee_v1.sql', 'utf8').replaceAll('\r\n', '\n')
  .match(/CREATE OR REPLACE FUNCTION public\.hermes_domain_read_v1\([\s\S]*?\$fn\$;/)[0];
const slice = (text, head) => { const start = text.indexOf(head); assert.ok(start >= 0, head); return text.slice(start, text.indexOf('END $fn$;', start) + 'END $fn$;'.length); };
const mutate = (text, from, to) => { assert.equal(text.split(from).length, 2, `anchor: ${from.slice(0, 70)}`); return text.replace(from, () => to); };
const CORE = slice(NT4_SQL, 'CREATE OR REPLACE FUNCTION app_private.hermes_task_resolve_core_v1(');
const BATCH = slice(NT4_SQL, 'CREATE OR REPLACE FUNCTION app_private.hermes_task_batch_prepare_v1(');
const room = n => `00000000-0000-4000-8000-0000000097${String(n).padStart(2, '0')}`;

async function setup(t) {
  const f = await setupNghiemThu(t);
  for (const sql of [NT2_SQL, NT3_SQL]) { await f.db.exec(sql); await f.db.exec(sql); }
  await f.db.exec(V1_READ);
  await f.db.exec(NT4_SQL); await f.db.exec(NT4_SQL);
  return f;
}
const perRoom = { buildingName: 'Toà A', perRoom: true, jobType: 'sửa', content: 'kiểm tra ổ điện', assigneeName: 'Nathan' };
// Toà B thêm 25 phòng (tổng 26) để vượt trần 20.
const crowd = f => f.db.exec(`INSERT INTO public.rooms(id,organization_id,building_id,name,status,deleted_at) VALUES
  ${Array.from({ length: 25 }, (_, n) => `('${room(n + 1)}','${ORG}','${OTHER_BUILDING}','B${String(n + 1).padStart(2, '0')}','AVAILABLE',null)`).join(',')}`);

test('migration: installs on the 153345 reader + 145100 task bodies, twice; an unknown running body is refused', { timeout: 300000 }, async t => {
  const f = await setup(t);
  await f.db.exec("CREATE OR REPLACE FUNCTION app_private.hermes_task_batch_prepare_v1(p_binding jsonb,p_phase text,p_request_id uuid,p_params jsonb,p_resolved jsonb,p_expected_basis text,p_resolution jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$ SELECT '{}'::jsonb $$");
  await assert.rejects(f.db.exec(NT4_SQL), /hermes_task_given_per_room_dependency_invalid/);
});

test('perRoom: one item per live room of the building (by room name), one preview for the batch, written on apply', { timeout: 300000 }, async t => {
  const f = await setup(t);
  // Một phòng đã xoá không được tính.
  await f.db.exec(`INSERT INTO public.rooms(id,organization_id,building_id,name,status,deleted_at) VALUES('${room(90)}','${ORG}','${OTHER_BUILDING}','Đã xoá','AVAILABLE',now())`);
  const preview = await f.run('task.create_batch', 'auto', 1, perRoom);
  assert.equal(preview.kind, 'preview', JSON.stringify(preview));
  assert.deepEqual(preview.preview.items.map(i => [i.room, i.assignee]), [['201', 'Nathan Quản Lý'], ['P101', 'Nathan Quản Lý']]);
  assert.equal(preview.preview.count, 2);
  const applied = await f.run('task.create_batch', 'apply', 1, perRoom, preview);
  assert.equal(applied.kind, 'applied', JSON.stringify(applied));
  assert.deepEqual((await f.jobs()).map(j => [j.room_id, j.assignee_id]).sort(), [[ROOM, MANAGER], [ROOM_A201, MANAGER]].sort());
  const b = await f.run('task.create_batch', 'auto', 2, { ...perRoom, buildingName: 'Toà B' });
  assert.deepEqual(b.preview.items.map(i => i.room), ['P201'], 'phòng đã xoá không có mục');
});

test('perRoom over 20 rooms ⇒ needs_input batch_too_large with the real room count; misuse ⇒ invalid_params', { timeout: 300000 }, async t => {
  const f = await setup(t);
  await crowd(f);
  const big = await f.run('task.create_batch', 'auto', 1, { ...perRoom, buildingName: 'Toà B' });
  assert.deepEqual(big, { kind: 'needs_input', reason: 'batch_too_large', rooms: 26 });
  assert.equal((await f.jobs()).length, 0);
  for (const [n, params] of [[2, { ...perRoom, items: [{ roomName: 'P101', content: 'x' }] }], [3, { perRoom: true, content: 'x', assigneeName: 'Nathan' }],
    [4, { ...perRoom, buildingName: undefined, buildingsManagedBy: 'Nathan' }]]) {
    const r = await f.run('task.create_batch', 'auto', n, params);
    assert.deepEqual([r.kind, r.reason], ['needs_input', 'invalid_params'], JSON.stringify(r));
  }
  // Lô items > 20 (không perRoom) vẫn là batch_too_large KHÔNG kèm số phòng.
  const items = Array.from({ length: 21 }, () => ({ roomName: 'P101', content: 'x' }));
  assert.deepEqual(await f.run('task.create_batch', 'auto', 5, { buildingName: 'Toà A', assigneeName: 'Nathan', items }), { kind: 'needs_input', reason: 'batch_too_large' });
});

test('mutation (lượt 14): the perRoom branch, the 20-room ceiling, the deleted-room filter and the room count in the reason are each load-bearing', { timeout: 600000 }, async t => {
  const CASES = [
    ['perRoom branch', mutate(CORE, "IF p_params->'perRoom'='true'::jsonb THEN", 'IF false THEN'),
      async f => (await f.run('task.create_batch', 'auto', 1, perRoom)).kind === 'preview'],
    ['20-room ceiling', mutate(CORE, "IF v_rooms>20 THEN RETURN", 'IF false THEN RETURN'),
      async f => { await crowd(f); return (await f.run('task.create_batch', 'auto', 1, { ...perRoom, buildingName: 'Toà B' }).catch(() => ({}))).rooms === 26; }],
    ['deleted rooms excluded', mutate(CORE, 'AND r.deleted_at IS NULL AND btrim', 'AND btrim'),
      async f => { await f.db.exec(`INSERT INTO public.rooms(id,organization_id,building_id,name,status,deleted_at) VALUES('${room(90)}','${ORG}','${OTHER_BUILDING}','Đã xoá','AVAILABLE',now())`);
        return (await f.run('task.create_batch', 'auto', 1, { ...perRoom, buildingName: 'Toà B' })).preview?.items.length === 1; }],
    ['room count carried by the reason', mutate(BATCH, "\n      'rooms',CASE WHEN", "\n      'roomsX',CASE WHEN"),
      async f => { await crowd(f); return (await f.run('task.create_batch', 'auto', 1, { ...perRoom, buildingName: 'Toà B' }).catch(() => ({}))).rooms === 26; }],
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
