import test from 'node:test';
import assert from 'node:assert/strict';
import { setupNghiemThu, ORG, BUILDING, ROOM, MANAGER, STAFF, ROOM_A201, u } from './task-nghiem-thu-fixture.mjs';
import { migration, TYPE_SUA, TYPE_VE_SINH } from './task-action-fixture.mjs';

// Lượt 12 — soát hai lỗi Công việc còn sót sau C1 (nghiệm thu chạy lại trên TEST với connector C1, 24/10), trên PGlite
// (task-nghiem-thu-fixture.mjs + 20261024091500 chạy hai lượt):
//  1. Loại được NÊU rõ không còn là đoán: chuỗi loại trùng tên loại bỏ dấu / hoa thường / khoảng trắng; chuỗi loại hoặc nội dung mở
//     đầu bằng tên loại hay cụm đồng nghĩa trỏ tới loại đó (khi chuỗi loại không trỏ sang loại khác). Chữ giữa câu vẫn là đoán.
//  2. Trả lời câu hỏi chọn của máy chủ = đồng ý: tên người nhận mơ hồ (hỏi kèm danh sách) và đề xuất đúng một người quản lý dùng chung
//     lời mời 15 phút của Q31; sửa / huỷ nhận lại nhãn ứng viên đã đưa. Huỷ vẫn luôn xem trước.
//  3. Lô: mục có nội dung mở đầu bằng tên loại không còn trong cảnh báo "bot chọn theo nội dung".
const NT2_SQL = migration('hermes_task_nghiem_thu_2_v1');
const TYPE_THAY = u(21), TYPE_CHECK = u(22);
const self = { buildingName: 'Toà A', roomName: 'P101', assigneeName: 'tôi' };

async function setup(t, sql = NT2_SQL) {
  const f = await setupNghiemThu(t);
  await f.db.exec(sql); await f.db.exec(sql);
  await f.db.exec(`INSERT INTO public.job_types VALUES('${TYPE_THAY}','${ORG}','thay',true),('${TYPE_CHECK}','${ORG}','check',true);`);
  return f;
}
const slice = (text, head) => { const start = text.indexOf(head); assert.ok(start >= 0, head); return text.slice(start, text.indexOf('END $fn$;', start) + 'END $fn$;'.length); };
const mutate = (text, from, to) => { assert.equal(text.split(from).length, 2, `anchor: ${from.slice(0, 70)}`); return text.replace(from, () => to); };
const CORE = slice(NT2_SQL, 'CREATE OR REPLACE FUNCTION app_private.hermes_task_resolve_core_v1(');
const PREPARE = slice(NT2_SQL, 'CREATE OR REPLACE FUNCTION app_private.hermes_task_action_prepare_v1(');

test('migration: idempotent, offers CHECK now 1–8, bodies pinned', { timeout: 300000 }, async t => {
  const f = await setup(t);
  const { rows } = await f.db.query("SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conname='hermes_task_assignee_offers_candidate_ids_check'");
  assert.match(rows[0].def, />= 1\).*<= 8\)/);
  // Thân lạ (không phải 185116, không phải thân của file này) ⇒ khối requires từ chối.
  await f.db.exec("CREATE OR REPLACE FUNCTION app_private.hermes_task_resolve_core_v1(p_ctx jsonb,p_action text,p_params jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$");
  await assert.rejects(f.db.exec(NT2_SQL), /hermes_task_nghiem_thu_2_dependency_invalid/);
});

test('job type: naming a type is not a guess (accents / case / spaces, type string or content starting with the name); synonyms stay a guess', { timeout: 300000 }, async t => {
  const f = await setup(t);
  const create = async (n, params, phase = 'auto') => f.run('task.create', phase, n, { ...self, ...params });
  // Loại giải ra + cờ đoán ở pha preview (pha preview luôn chỉ xem trước; tránh lý do "việc trùng" giữa các ca cùng phòng).
  const typed = async (n, params) => { const r = await create(n, params, 'preview'); assert.equal(r.kind, 'preview', JSON.stringify(r));
    return [r.resolved.jobTypeId, r.resolved.jobTypeGuessed]; };
  // Bot không truyền jobType, nội dung mở đầu bằng tên loại (như cú pháp "<loại> <mô tả>" của ô gõ nhanh web) ⇒ ghi thẳng.
  const direct = await create(1, { content: 'Sửa vòi nước' });
  assert.equal(direct.kind, 'applied', JSON.stringify(direct));
  assert.equal((await f.jobs()).at(-1).job_type_id, TYPE_SUA);
  assert.deepEqual(await typed(2, { content: 'Thay bóng đèn hành lang' }), [TYPE_THAY, false]);
  // "Vệ sinh …": "vệ" và "vệ sinh" cùng mở đầu nội dung ⇒ tên dài hơn (đúng hai từ đầu) thắng, không phải đoán.
  assert.deepEqual(await typed(3, { content: 'Vệ sinh hành lang tầng 2' }), [TYPE_VE_SINH, false]);
  // Chuỗi loại trùng tên loại khi bỏ dấu / hoa thường / dấu câu / khoảng trắng ("VỆ-SINH", "vesinh" = "vệ sinh").
  assert.deepEqual(await typed(4, { jobType: 'VỆ-SINH', content: 'dọn sân thượng' }), [TYPE_VE_SINH, false]);
  assert.deepEqual(await typed(5, { jobType: 'vesinh', content: 'dọn sân thượng' }), [TYPE_VE_SINH, false]);
  // Chuỗi loại mở đầu bằng tên loại (bot hay gửi cả cụm: "sửa vòi nước"), nội dung không nhắc tên loại.
  assert.deepEqual(await typed(6, { jobType: 'sửa vòi nước', content: 'vòi phòng tắm rỉ nước' }), [TYPE_SUA, false]);
  // Cụm đồng nghĩa ĐỨNG ĐẦU chuỗi loại / nội dung ("kiểm tra" → check) là nêu rõ loại; đứng giữa vẫn là đoán ⇒ xem trước, nói rõ
  // đã tự chọn loại nào.
  assert.deepEqual(await typed(7, { jobType: 'kiểm tra điện', content: 'điện chập chờn' }), [TYPE_CHECK, false]);
  assert.deepEqual(await typed(8, { content: 'Kiểm tra điện phòng tắm' }), [TYPE_CHECK, false]);
  const syn = await create(12, { roomName: '201', jobType: 'điện cần kiểm tra', content: 'điện chập chờn' });
  assert.deepEqual([syn.kind, syn.resolved.jobTypeId, syn.resolved.jobTypeGuessed], ['preview', TYPE_CHECK, true], JSON.stringify(syn));
  assert.ok(syn.warnings.some(w => /tự chọn loại 'check'/.test(w)));
  assert.deepEqual(await typed(13, { content: 'Đèn hành lang cần kiểm tra lại' }), [TYPE_CHECK, true]);
  // Chuỗi loại nhắc cả loại có tên nằm lọt trong tên loại đứng đầu ("vệ" trong "vệ sinh") không phải mâu thuẫn.
  assert.deepEqual(await typed(14, { jobType: 'dọn vệ sinh', content: 'Dọn vệ sinh phòng' }), [TYPE_VE_SINH, false]);
  // Chuỗi loại trỏ sang loại khác (kiểm tra → check) mà nội dung mở đầu bằng "Sửa" ⇒ mâu thuẫn ⇒ vẫn là đoán.
  assert.deepEqual(await typed(9, { jobType: 'kiểm tra', content: 'Sửa vòi nước tầng 3' }), [TYPE_SUA, true]);
  // Chưa nêu loại, nội dung không gợi được loại nào ⇒ hỏi chọn; chọn đúng một gợi ý ⇒ ghi thẳng (không thêm lượt xác nhận).
  const ask = await create(10, { roomName: '201', content: 'xyz qwe' });
  assert.deepEqual([ask.kind, ask.field], ['needs_input', 'jobType']);
  assert.ok(ask.candidates.some(c => c.name === 'sửa'));
  assert.equal((await create(11, { roomName: '201', content: 'xyz qwe', jobType: 'sửa' })).kind, 'applied');
});

test('task.create_batch: items naming their type (name or leading synonym) are not listed as "chosen by the bot"; a mid-sentence synonym still is', { timeout: 300000 }, async t => {
  const f = await setup(t);
  const batch = await f.run('task.create_batch', 'preview', 1, { buildingName: 'Toà A', assigneeName: 'tôi', items: [
    { roomName: 'P101', content: 'Sửa vòi nước' }, { roomName: '201', content: 'Thay bóng đèn' }, { roomName: 'P101', content: 'Kiểm tra điện' }, { roomName: '201', content: 'Đèn hành lang cần kiểm tra lại' }] });
  assert.equal(batch.kind, 'preview', JSON.stringify(batch));
  assert.deepEqual(batch.preview.items.map(i => i.jobType), ['sửa', 'thay', 'check', 'check']);
  const guessed = batch.warnings.filter(w => /bot chọn theo nội dung/.test(w));
  assert.deepEqual(guessed, ['Loại việc do bot chọn theo nội dung: #4 check — hỏi lại nếu sai.']);
  const clear = await f.run('task.create_batch', 'preview', 2, { buildingName: 'Toà A', assigneeName: 'tôi', items: [
    { roomName: 'P101', content: 'Sửa vòi nước' }, { roomName: '201', content: 'Thay bóng đèn' }] });
  assert.ok(!clear.warnings.some(w => /bot chọn theo nội dung/.test(w)), JSON.stringify(clear.warnings));
});

test('ambiguous assignee name: picking one of the listed people is the consent (same 15-minute offer as Q31); others / other command still preview', { timeout: 300000 }, async t => {
  const f = await setup(t);
  // Hai người quản lý toà A cùng tên "Huy" (đều có quyền công việc ở toà) ⇒ chỉ còn lý do "giao người khác".
  await f.db.exec(`UPDATE public.profiles SET full_name='Trần Huy' WHERE id='${MANAGER}'; UPDATE public.profiles SET full_name='Lê Huy' WHERE id='${STAFF}';`);
  const base = { buildingName: 'Toà A', roomName: 'P101', jobType: 'sửa', content: 'thay vòi sen' };
  const asked = await f.run('task.create', 'auto', 1, { ...base, assigneeName: 'Huy' });
  assert.deepEqual([asked.kind, asked.field, asked.why, asked.candidates.map(c => c.name).sort()], ['needs_input', 'person', 'ambiguous', ['Lê Huy', 'Trần Huy']]);
  assert.ok(!('offer' in asked), 'id ứng viên không ra khỏi bước chuẩn bị');
  assert.equal(await f.offers(), 1);
  // Chọn người ngoài danh sách (chủ thứ hai, có quyền ở toà) ⇒ vẫn xem trước; đổi nội dung ⇒ vẫn xem trước.
  assert.equal((await f.run('task.create', 'auto', 2, { ...base, assigneeName: 'Chủ Hai' })).kind, 'preview');
  assert.equal((await f.run('task.create', 'auto', 3, { ...base, content: 'việc khác', assigneeName: 'Trần Huy' })).kind, 'preview');
  const chosen = await f.run('task.create', 'auto', 4, { ...base, assigneeName: 'Trần Huy' });
  assert.equal(chosen.kind, 'applied', JSON.stringify(chosen));
  assert.equal((await f.jobs()).at(-1).assignee_id, MANAGER);
  assert.equal(await f.offers(), 0);
});

test('one suggested manager: naming that person answers the suggestion (no second confirmation); Q31 with two managers unchanged', { timeout: 300000 }, async t => {
  const f = await setup(t);
  const base = { buildingName: 'Toà A', roomName: 'P101', jobType: 'sửa', content: 'thay bóng đèn hành lang' };
  // Q31 (hai người quản lý) như lượt 11.
  assert.equal((await f.run('task.create', 'auto', 1, base)).kind, 'needs_input');
  assert.equal((await f.run('task.create', 'auto', 2, { ...base, assigneeName: 'Nathan' })).kind, 'applied');
  // Toà chỉ còn một người quản lý ⇒ bản xem trước đề xuất người đó; nêu đúng người đó ⇒ ghi thẳng.
  await f.db.exec(`DELETE FROM public.fixture_member_acl WHERE user_id='${STAFF}' AND permission='tasks.edit';`);
  const other = { ...base, roomName: '201', content: 'sơn lại tường hành lang' };
  const suggested = await f.run('task.create', 'auto', 3, other);
  assert.deepEqual([suggested.kind, suggested.resolved.assigneeId, suggested.resolved.assigneeSuggested], ['preview', MANAGER, true], JSON.stringify(suggested));
  assert.deepEqual((await f.db.query('SELECT cardinality(candidate_ids) n FROM app_private.hermes_task_assignee_offers')).rows, [{ n: 1 }]);
  assert.equal((await f.run('task.create', 'auto', 4, { ...other, assigneeName: 'Chủ Hai' })).kind, 'preview', 'người khác với người được đề xuất');
  const named = await f.run('task.create', 'auto', 5, { ...other, assigneeName: 'Nathan' });
  assert.equal(named.kind, 'applied', JSON.stringify(named));
  assert.equal(await f.offers(), 0);
});

test('task.update / task.cancel accept the candidate label the server listed ("<code> · …"); cancel still always previews', { timeout: 300000 }, async t => {
  const f = await setup(t);
  const a = await f.job('Sửa vòi nước', BUILDING, ROOM);
  const b = await f.job('Sửa vòi nước', BUILDING, ROOM_A201);
  const asked = await f.run('task.update', 'auto', 1, { job: 'sửa vòi nước', note: 'đã gọi thợ' });
  assert.deepEqual([asked.kind, asked.why, asked.candidates.length], ['needs_input', 'ambiguous', 2]);
  const label = asked.candidates.find(c => c.name.includes('(201,')).name;
  const updated = await f.run('task.update', 'auto', 2, { job: label, note: 'đã gọi thợ' });
  assert.equal(updated.kind, 'applied', JSON.stringify(updated));
  const notes = (await f.db.query('SELECT id,completion_description d FROM public.jobs WHERE id IN ($1,$2)', [a, b])).rows;
  assert.deepEqual(notes.filter(row => /đã gọi thợ/.test(row.d ?? '')).map(row => row.id), [b], 'ghi chú vào đúng việc của nhãn đã chọn');
  // Huỷ cần khoá tasks.delete ở trần công ty + kết nối + quyền CRM (như task-edit-sql).
  await f.db.query("UPDATE app_private.hermes_org_policies SET action_capabilities=action_capabilities||ARRAY['tasks.delete']");
  await f.db.query("UPDATE app_private.hermes_connections SET action_capabilities=action_capabilities||ARRAY['tasks.delete']");
  await f.db.query("INSERT INTO public.fixture_acl(permission,building_ids) VALUES('tasks.delete',$1) ON CONFLICT(permission) DO UPDATE SET building_ids=excluded.building_ids,allowed=true", [[BUILDING]]);
  const cancel = await f.run('task.cancel', 'auto', 3, { job: asked.candidates.find(c => !c.name.includes('(201,')).name, reason: 'trùng' });
  assert.deepEqual([cancel.kind, cancel.resolved.jobId], ['preview', a]);
});

test('mutation (lượt 12): explicit-type tiers, the clash rule, every new offer path and the label code are each load-bearing', { timeout: 600000 }, async t => {
  const base = { buildingName: 'Toà A', roomName: 'P101', jobType: 'sửa', content: 'thay vòi sen' };
  const CASES = [
    ['content starting with a type name is not a guess', mutate(CORE, 'v_guessed:=NOT (v_best>=9500', 'v_guessed:=true OR NOT (v_best>=9500'),
      async f => (await f.run('task.create', 'auto', 1, { ...self, content: 'Sửa vòi nước' })).kind === 'applied'],
    ['a leading synonym names the type', mutate(CORE, " OR v_found->0->'lead'='true'::jsonb", ''),
      async f => (await f.run('task.create', 'auto', 1, { ...self, content: 'Kiểm tra điện phòng tắm' })).kind === 'applied'],
    ['tier 92: type string starting with a type name', mutate(CORE, ") THEN 92\n", ") AND false THEN 92\n"),
      async f => (await f.run('task.create', 'auto', 1, { ...self, jobType: 'sửa vòi nước', content: 'vòi phòng tắm rỉ nước' })).kind === 'applied'],
    ['tier 90 is explicit only without a clashing type string', mutate(CORE, 'WHERE y.ord>1 AND (y.e->>\'score\')::int BETWEEN 7000 AND 8999', 'WHERE false'),
      async f => (await f.run('task.create', 'auto', 1, { ...self, jobType: 'kiểm tra', content: 'Sửa vòi nước tầng 3' })).kind === 'preview'],
    ['a nested type name is not a clash', mutate(CORE, "\n              AND strpos(v_found->0->>'kc',y.e->>'kc')=0", ''),
      async f => (await f.run('task.create', 'auto', 1, { ...self, jobType: 'dọn vệ sinh', content: 'Dọn vệ sinh phòng' })).kind === 'applied'],
    ['ambiguous name carries candidate ids', mutate(CORE, "IF NOT v_batch AND p_action='task.create' AND v_who->>'why'='ambiguous' THEN", 'IF false THEN'),
      async f => { await f.db.exec(`UPDATE public.profiles SET full_name='Trần Huy' WHERE id='${MANAGER}'; UPDATE public.profiles SET full_name='Lê Huy' WHERE id='${STAFF}';`);
        await f.run('task.create', 'auto', 1, { ...base, assigneeName: 'Huy' });
        return (await f.run('task.create', 'auto', 2, { ...base, assigneeName: 'Trần Huy' })).kind === 'applied'; }],
    ['ambiguous offer is written', mutate(PREPARE, "AND p_resolution->>'why'='ambiguous'\n", "AND false\n"),
      async f => { await f.db.exec(`UPDATE public.profiles SET full_name='Trần Huy' WHERE id='${MANAGER}'; UPDATE public.profiles SET full_name='Lê Huy' WHERE id='${STAFF}';`);
        await f.run('task.create', 'auto', 1, { ...base, assigneeName: 'Huy' });
        return (await f.run('task.create', 'auto', 2, { ...base, assigneeName: 'Trần Huy' })).kind === 'applied'; }],
    ['single suggested manager gets an offer', mutate(PREPARE, 'AND jsonb_array_length(p_managers)>=1 THEN', 'AND jsonb_array_length(p_managers)>1 THEN'),
      async f => { await f.db.exec(`DELETE FROM public.fixture_member_acl WHERE user_id='${STAFF}' AND permission='tasks.edit';`);
        const other = { ...base, content: 'sơn lại tường hành lang', assigneeName: undefined };
        await f.run('task.create', 'auto', 1, other);
        return (await f.run('task.create', 'auto', 2, { ...other, assigneeName: 'Nathan' })).kind === 'applied'; }],
    ['the candidate label resolves by its code', mutate(CORE, "COALESCE(substring(v_jq from '^([^ ·]+) · '),v_jq)", 'v_jq'),
      async f => { await f.job('Sửa vòi nước', BUILDING, ROOM); await f.job('Sửa vòi nước', BUILDING, ROOM_A201);
        const asked = await f.run('task.update', 'auto', 1, { job: 'sửa vòi nước', note: 'x' });
        return (await f.run('task.update', 'auto', 2, { job: asked.candidates[0].name, note: 'x' })).kind === 'applied'; }],
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
