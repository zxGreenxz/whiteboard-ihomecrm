import test from 'node:test';
import assert from 'node:assert/strict';
import { setupNghiemThu, ORG, USER, BUILDING, ROOM, MANAGER, STAFF, CO_OWNER, ANH_TU, MINH } from './task-nghiem-thu-fixture.mjs';
import { migration } from './task-action-fixture.mjs';
import { ENABLE_POLICIES } from './task-recurring-fixture.mjs';

// Lượt 13 — chặn ghi sai "tự giao cho mình" ở máy chủ (nghiệm thu lượt cuối trên TEST 24/10: hai việc ghi thẳng cho người gửi lệnh vì bot
// tự điền assigneeName "tôi"), trên PGlite (task-nghiem-thu-fixture.mjs + 20261024091500 + 20261024145100, mỗi file hai lượt):
//  1. Người nhận = CHÍNH người gửi ⇒ task.create LUÔN xem trước (cả khi mọi thứ khác đủ, cả khi chọn chính mình từ danh sách đã hỏi);
//     bản xem trước + cảnh báo nói rõ "CHÍNH anh/chị"; chỉ ghi ở lượt apply có basis. Người khác giữ chính sách cũ. Lô luôn xem trước
//     và nêu các mục tự giao.
//  2. assigneeName là danh xưng trơn ⇒ needs_input hỏi giao cho ai (tạo, mục của lô, sửa việc, sửa việc định kỳ); không thành chính
//     người gửi, không thành người quản lý.
const NT2_SQL = migration('hermes_task_nghiem_thu_2_v1');
const NT3_SQL = migration('hermes_task_self_assign_guard_v1');
const base = { buildingName: 'Toà A', roomName: 'P101', jobType: 'sửa', content: 'thay vòi sen' };

async function setup(t) {
  const f = await setupNghiemThu(t);
  for (const sql of [NT2_SQL, NT3_SQL]) { await f.db.exec(sql); await f.db.exec(sql); }
  return f;
}
const slice = (text, head) => { const start = text.indexOf(head); assert.ok(start >= 0, head); return text.slice(start, text.indexOf('END $fn$;', start) + 'END $fn$;'.length); };
const mutate = (text, from, to, n = 1) => { assert.equal(text.split(from).length, n + 1, `anchor: ${from.slice(0, 70)}`); return text.split(from).join(to); };
const CORE = slice(NT3_SQL, 'CREATE OR REPLACE FUNCTION app_private.hermes_task_resolve_core_v1(');
const PREPARE = slice(NT3_SQL, 'CREATE OR REPLACE FUNCTION app_private.hermes_task_action_prepare_v1(');
const BATCH = slice(NT3_SQL, 'CREATE OR REPLACE FUNCTION app_private.hermes_task_batch_prepare_v1(');
const BARE = "btrim(regexp_replace(v_pfold,'[^a-z0-9]+',' ','g')) ~ '^(anh|chi|em|co|chu|bac|ong|ba|thay|di|cau|ban|a|c|e)( (ay|ta|kia|do))?$'";

test('migration: idempotent on top of 091500; an unknown running body is refused', { timeout: 300000 }, async t => {
  const f = await setup(t);
  await f.db.exec("CREATE OR REPLACE FUNCTION app_private.hermes_task_resolve_core_v1(p_ctx jsonb,p_action text,p_params jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$");
  await assert.rejects(f.db.exec(NT3_SQL), /hermes_task_self_assign_guard_dependency_invalid/);
});

test('self-assignment always previews with "CHÍNH anh/chị" and writes only on apply with the basis; another person keeps the old policy', { timeout: 300000 }, async t => {
  const f = await setup(t);
  // Đủ mọi thứ (toà, phòng, loại đúng tên, nội dung), "tôi" ⇒ trước lượt 13 ghi thẳng; nay xem trước.
  const params = { ...base, assigneeName: 'tôi' };
  const preview = await f.run('task.create', 'auto', 1, params);
  assert.equal(preview.kind, 'preview', JSON.stringify(preview));
  assert.deepEqual([preview.resolved.assigneeId, preview.preview.assigneeSelf], [USER, true]);
  assert.match(preview.preview.text, /— giao CHÍNH anh\/chị —/);
  assert.ok(preview.warnings[0].startsWith('Giao cho CHÍNH anh/chị (người gửi lệnh)'), JSON.stringify(preview.warnings));
  assert.equal((await f.jobs()).length, 0, 'chưa ghi');
  const applied = await f.run('task.create', 'apply', 1, params, preview);
  assert.equal(applied.kind, 'applied', JSON.stringify(applied));
  assert.equal((await f.jobs()).at(-1).assignee_id, USER);
  // Các từ tự xưng khác cũng vậy.
  for (const [n, name] of [[2, 'chính mình'], [3, 'self']])
    assert.equal((await f.run('task.create', 'auto', n, { ...base, roomName: '201', assigneeName: name })).kind, 'preview', name);
  // Người khác chọn từ danh sách Q31 ⇒ vẫn ghi thẳng như lượt 11 (chính sách cũ cho người khác).
  const other = { ...base, roomName: '201', content: 'thay bóng đèn hành lang' };
  assert.equal((await f.run('task.create', 'auto', 4, other)).kind, 'needs_input');
  assert.equal((await f.run('task.create', 'auto', 5, { ...other, assigneeName: 'Nathan' })).kind, 'applied');
});

test('choosing oneself from a list the server asked is not consent: still a preview, the offer is not consumed', { timeout: 300000 }, async t => {
  const f = await setup(t);
  // "Thử" mơ hồ: Chủ Thử (người gửi) + Hai Thử ⇒ hỏi kèm danh sách, ghi lời mời có cả người gửi. ("Chủ" trơn là danh xưng "chú" ⇒ hỏi.)
  await f.db.query('UPDATE public.profiles SET full_name=$1 WHERE id=$2', ['Hai Thử', CO_OWNER]);
  const asked = await f.run('task.create', 'auto', 1, { ...base, assigneeName: 'Thử' });
  assert.deepEqual([asked.kind, asked.field, asked.why, asked.candidates.map(c => c.name).sort()], ['needs_input', 'person', 'ambiguous', ['Chủ Thử', 'Hai Thử']], JSON.stringify(asked));
  assert.equal(await f.offers(), 1);
  const self = await f.run('task.create', 'auto', 2, { ...base, assigneeName: 'Chủ Thử' });
  assert.deepEqual([self.kind, self.resolved.assigneeId], ['preview', USER], JSON.stringify(self));
  assert.ok(self.warnings.some(w => w.startsWith('Giao cho CHÍNH anh/chị')));
  assert.equal(await f.offers(), 1, 'lời mời không bị tiêu');
  assert.equal((await f.jobs()).length, 0);
  // Người còn lại trong danh sách ⇒ đồng ý như lượt 12.
  assert.equal((await f.run('task.create', 'auto', 3, { ...base, assigneeName: 'Hai Thử' })).kind, 'applied');
  assert.equal((await f.jobs()).at(-1).assignee_id, CO_OWNER);
});

test('a bare honorific as the assignee asks who it is — never the sender, never a manager; honorific + name still resolves', { timeout: 300000 }, async t => {
  const f = await setup(t);
  const ask = async (n, name, action = 'task.create', params = base) => f.run(action, 'auto', n, { ...params, assigneeName: name });
  let n = 0;
  for (const name of ['anh', 'Chị', 'em', 'a', 'c', 'e', 'ảnh', 'chỉ', 'ổng', 'bả', 'anh ấy', 'Anh.', 'bạn']) {
    const r = await ask(++n, name);
    assert.deepEqual([r.kind, r.reason, r.field, r.why, r.wanted, r.candidates], ['needs_input', 'name_unresolved', 'person', 'unspecified', '', []], `${name}: ${JSON.stringify(r)}`);
  }
  assert.equal(await f.offers(), 0, 'không ghi lời mời');
  assert.equal((await f.jobs()).length, 0);
  // Danh xưng + tên vẫn giải như lượt 11; "mình" vẫn là luật cũ (có người tên Minh ⇒ người đó, cờ mơ hồ ⇒ xem trước).
  assert.equal((await f.run('task.create', 'preview', ++n, { ...base, assigneeName: 'anh Huy' })).resolved.assigneeId, STAFF);
  assert.equal((await f.run('task.create', 'preview', ++n, { ...base, assigneeName: 'Anh Tú' })).resolved.assigneeId, ANH_TU);
  const minh = await f.run('task.create', 'preview', ++n, { ...base, assigneeName: 'mình' });
  assert.deepEqual([minh.resolved.assigneeId, minh.resolved.assigneeAmbiguous], [MINH, true]);
  // Mục của lô.
  const batch = await f.run('task.create_batch', 'auto', ++n, { buildingName: 'Toà A', items: [{ roomName: 'P101', content: 'sửa vòi', assigneeName: 'tôi' },
    { roomName: '201', content: 'sửa vòi', assigneeName: 'anh' }] });
  assert.deepEqual([batch.kind, batch.field, batch.why, batch.item], ['needs_input', 'person', 'unspecified', 2], JSON.stringify(batch));
  // Sửa việc.
  await f.job('Sửa vòi nước', BUILDING, ROOM);
  const edit = await f.run('task.update', 'auto', ++n, { job: 'sửa vòi nước', assigneeName: 'chị' });
  assert.deepEqual([edit.kind, edit.field, edit.why], ['needs_input', 'person', 'unspecified'], JSON.stringify(edit));
});

test('a bare honorific on task.recurring_update asks too', { timeout: 300000 }, async t => {
  const f = await setup(t);
  await f.db.exec(ENABLE_POLICIES);
  const params = { buildingName: 'Toà A', jobType: 'sửa', content: 'kiểm máy bơm', assigneeName: 'Nathan', frequency: 'weekly', weekdays: ['MON', 'THU'], dueDays: 1 };
  const preview = await f.run('task.recurring_create', 'auto', 1, params);
  assert.equal((await f.run('task.recurring_create', 'apply', 1, params, preview)).kind, 'applied');
  const r = await f.run('task.recurring_update', 'auto', 2, { rule: 'DK-0001', assigneeName: 'ổng' });
  assert.deepEqual([r.kind, r.field, r.why], ['needs_input', 'person', 'unspecified'], JSON.stringify(r));
});

test('task.create_batch: always a preview; items for the sender are named "CHÍNH anh/chị" in rows and a warning', { timeout: 300000 }, async t => {
  const f = await setup(t);
  const params = { buildingName: 'Toà A', items: [{ roomName: 'P101', content: 'sửa vòi', assigneeName: 'tôi' },
    { roomName: '201', content: 'sửa đèn', assigneeName: 'Nathan' }, { roomName: '201', content: 'sửa khoá', assigneeName: 'tôi' }] };
  const batch = await f.run('task.create_batch', 'auto', 1, params);
  assert.equal(batch.kind, 'preview', JSON.stringify(batch));
  assert.deepEqual(batch.preview.items.map(i => i.assignee), ['CHÍNH anh/chị', 'Nathan Quản Lý', 'CHÍNH anh/chị']);
  assert.ok(batch.warnings.includes('Giao cho CHÍNH anh/chị (người gửi lệnh) ở mục #1, #3: chỉ ghi khi anh/chị đồng ý; muốn giao người khác thì nêu tên người đó.'),
    JSON.stringify(batch.warnings));
  assert.equal((await f.jobs()).length, 0);
  assert.equal((await f.run('task.create_batch', 'apply', 1, params, batch)).kind, 'applied');
  assert.equal((await f.jobs()).length, 3);
});

test('mutation (lượt 13): the self-assignment preview, every bare-honorific barrier and the batch preview are each load-bearing', { timeout: 600000 }, async t => {
  const CASES = [
    ['self-assignment always previews', mutate(PREPARE, '\n      OR v_assignee=v_actor\n', '\n'),
      async f => (await f.run('task.create', 'auto', 1, { ...base, assigneeName: 'tôi' })).kind === 'preview'],
    ['bare honorific on create asks', mutate(CORE, `        ELSIF ${BARE} THEN\n          v_one:=`, '        ELSIF false THEN\n          v_one:='),
      async f => (await f.run('task.create', 'auto', 1, { ...base, assigneeName: 'anh' })).why === 'unspecified'],
    ['bare honorific on edit asks', mutate(CORE, `      ELSIF ${BARE} THEN\n        RETURN`, '      ELSIF false THEN\n        RETURN', 2),
      async f => { await f.job('Sửa vòi nước', BUILDING, ROOM);
        return (await f.run('task.update', 'auto', 1, { job: 'sửa vòi nước', assigneeName: 'chị' })).why === 'unspecified'; }],
    ['batch never writes without the apply phase', mutate(BATCH, "  IF p_phase<>'apply' THEN\n    IF (SELECT count(DISTINCT", "  IF p_phase='preview' THEN\n    IF (SELECT count(DISTINCT"),
      async f => (await f.run('task.create_batch', 'auto', 1, { buildingName: 'Toà A', items: [{ roomName: 'P101', content: 'sửa vòi', assigneeName: 'tôi' }] })).kind === 'preview'],
  ];
  for (const [label, mutant, probe] of CASES) {
    await t.test(label, async () => {
      assert.equal(await probe(await setup(t)), true, 'bản sửa chặn');
      const f = await setup(t);
      await f.db.exec(mutant);
      assert.equal(await probe(f), false, 'đột biến lọt ⇒ test không rỗng');
    });
  }
  void ORG; void MANAGER;
});
