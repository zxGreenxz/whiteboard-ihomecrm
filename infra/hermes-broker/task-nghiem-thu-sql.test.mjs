import test from 'node:test';
import assert from 'node:assert/strict';
import { setupNghiemThu as setup, RESOLVE_SQL, NGHIEM_THU_SQL, ORG, USER, BUILDING, OTHER_BUILDING, ROOM, MANAGER, STAFF, MINH, CO_OWNER, ROOM_A201,
  OTHER_ROOM, ANH_TU, TU_LE, TYPE_NVK, u } from './task-nghiem-thu-fixture.mjs';

// Lượt 11 — sửa theo nghiệm thu bot thật trên TEST (23–24/10) + 11b (review độc lập), trên PGlite (task-nghiem-thu-fixture.mjs):
//  1. Chọn người nhận từ danh sách Q31 = đồng ý giao (không thêm một lượt xác nhận); mỗi rào của lời mời có ca + đột biến riêng.
//  2. Gợi ý loại việc không có loại trùng tên toà (nhập nhầm) và loại chưa từng dùng mà không có điểm.
//  3. Tìm việc theo tiêu đề kèm "phòng N" / tên toà.
//  4. Người nhận có danh xưng ("anh Huy"): bằng nguyên chuỗi, rồi tên đã bỏ danh xưng (bằng, rồi trọn từ) — không "chứa" chuỗi có
//     danh xưng ("anh huy" ⊂ "thanh huy"); danh xưng đứng một mình vẫn không phải tên.
// Hai lời gọi song song cùng lời mời: task-nghiem-thu-race-pg.test.mjs (PG17 hai kết nối).
const THANH_HUY = u(11), TRAN_HUY = u(12), LE_HOA = u(13), THI_HOA = u(14);

test('assignee with an honorific ("anh Huy", "a Huy", "chị Minh") resolves after dropping it; a bare pronoun is still not a name; a real name starting with "Anh" wins', { timeout: 300000 }, async t => {
  const f = await setup(t);
  const base = { buildingName: 'Toà A', roomName: 'P101', jobType: 'sửa', content: 'thay vòi sen' };
  const assignee = async (n, name) => { const r = await f.run('task.create', 'preview', n, { ...base, assigneeName: name }); return [r.kind, r.resolved?.assigneeId ?? r.field, r.why]; };
  assert.deepEqual(await assignee(1, 'anh Huy'), ['preview', STAFF, undefined]);
  assert.deepEqual(await assignee(2, 'a huy'), ['preview', STAFF, undefined]);
  assert.deepEqual(await assignee(3, 'chị Minh'), ['preview', MINH, undefined], '"Minh" sau danh xưng là tên người (Nguyễn Văn Minh)');
  assert.deepEqual(await assignee(4, 'Anh Tú'), ['preview', ANH_TU, undefined], 'tên thật mở đầu bằng "Anh": bằng nguyên chuỗi trước');
  assert.deepEqual(await assignee(5, 'anh Lê'), ['preview', TU_LE, undefined]);
  // Danh xưng đứng một mình: bẫy cũ của lõi task giữ nguyên — luật cũ (bằng rồi chứa: "Anh Tú" chứa "anh") và luôn cờ mơ hồ ⇒ xem trước
  // kèm câu "hiểu là"; "em" không ai chứa ⇒ hiểu là chính người hỏi, vẫn mơ hồ.
  const alone = await f.run('task.create', 'preview', 6, { ...base, assigneeName: 'anh' });
  assert.deepEqual([alone.resolved.assigneeId, alone.resolved.assigneeAmbiguous], [ANH_TU, true]);
  const em = await f.run('task.create', 'preview', 8, { ...base, assigneeName: 'em' });
  assert.deepEqual([em.resolved.assigneeId, em.resolved.assigneeAmbiguous], [USER, true]);
  const nobody = await f.run('task.create', 'preview', 7, { ...base, assigneeName: 'anh Khoa' });
  assert.deepEqual([nobody.kind, nobody.field, nobody.why, nobody.wanted], ['needs_input', 'person', 'not_visible', 'anh Khoa']);
});

test('honorific traps (review 11b): "anh Huy" with Thanh Huy + Trần Văn Huy asks; "e Hoa" with Lê Hoa + Nguyễn Thị Hoa asks; a half word never matches', { timeout: 300000 }, async t => {
  const f = await setup(t);
  await f.person(THANH_HUY, 'Thanh Huy'); await f.person(TRAN_HUY, 'Trần Văn Huy');
  await f.person(LE_HOA, 'Lê Hoa'); await f.person(THI_HOA, 'Nguyễn Thị Hoa');
  const base = { buildingName: 'Toà A', roomName: 'P101', jobType: 'sửa', content: 'thay vòi sen' };
  const ask = async (n, name) => f.run('task.create', 'preview', n, { ...base, assigneeName: name });
  // Bản cũ: "anh huy" là chuỗi con của "thanh huy" ⇒ ra đúng MỘT người (Thanh Huy) dù còn hai người tên Huy khác.
  const huy = await ask(1, 'anh Huy');
  assert.deepEqual([huy.kind, huy.field, huy.why], ['needs_input', 'person', 'ambiguous'], JSON.stringify(huy));
  assert.deepEqual(huy.candidates.map(c => c.name).sort(), ['Huy Nhân Viên', 'Thanh Huy', 'Trần Văn Huy']);
  // Bản cũ: "e hoa" nằm trong "le hoa" ⇒ Lê Hoa, bỏ qua Nguyễn Thị Hoa.
  const hoa = await ask(2, 'e Hoa');
  assert.deepEqual([hoa.kind, hoa.why, hoa.candidates.map(c => c.name).sort()], ['needs_input', 'ambiguous', ['Lê Hoa', 'Nguyễn Thị Hoa']]);
  // Nửa từ không phải tên: bản cũ "anh hu" ⊂ "thanh huy" ⇒ Thanh Huy.
  const half = await ask(3, 'anh Hu');
  assert.deepEqual([half.kind, half.why], ['needs_input', 'not_visible']);
  // Nêu đủ tên sau danh xưng ⇒ đúng một người.
  assert.equal((await ask(4, 'anh Thanh Huy')).resolved.assigneeId, THANH_HUY);
  assert.equal((await ask(5, 'chị Thị Hoa')).resolved.assigneeId, THI_HOA);
});

test('job type suggestions skip building-named junk and never-used unscored types; explicit building-named type is not accepted', { timeout: 300000 }, async t => {
  const f = await setup(t);
  const { db } = f;
  await f.job('việc dùng loại sửa', BUILDING, ROOM);
  await f.job('việc nhập nhầm loại', BUILDING, ROOM, TYPE_NVK);
  assert.deepEqual((await db.query("SELECT public.job_type_building_like_v1($1,'162nvk') a,public.job_type_building_like_v1($1,'162 NVK') b,public.job_type_building_like_v1($1,'sửa') c",
    [ORG])).rows[0], { a: true, b: true, c: false });
  const ask = await f.run('task.create', 'auto', 1, { buildingName: 'Toà A', roomName: 'P101', content: 'xyz qwe', assigneeName: 'tôi' });
  assert.deepEqual([ask.kind, ask.field, ask.why], ['needs_input', 'jobType', 'unspecified']);
  assert.deepEqual(ask.candidates.map(c => c.name), ['sửa'], 'chỉ loại đã từng dùng (hoặc có điểm); không 162nvk, ml, loại chưa dùng');
  assert.equal(ask.more, false);
  const named = await f.run('task.create', 'auto', 2, { buildingName: 'Toà A', roomName: 'P101', jobType: '162nvk', content: 'xyz qwe', assigneeName: 'tôi' });
  assert.deepEqual([named.kind, named.field], ['needs_input', 'jobType']);
  assert.ok(!named.candidates.some(c => c.name === '162nvk'));
  const scored = await f.run('task.create', 'auto', 3, { buildingName: 'Toà A', roomName: 'P101', content: 'qwe vệ ml', assigneeName: 'tôi' });
  assert.equal(scored.kind, 'needs_input', JSON.stringify(scored));
  assert.deepEqual(scored.candidates.map(c => c.name).sort(), ['ml', 'sửa', 'vệ'], '"ml" có điểm (nội dung nhắc tên) ⇒ được gợi ý dù chưa dùng');
});

test('job search by title with "phòng N" / building name: room and building are split off and used as filters; the old whole-string rule still works', { timeout: 300000 }, async t => {
  const f = await setup(t);
  const a201 = await f.job('Sửa vòi nước', BUILDING, ROOM_A201);
  const b201 = await f.job('Sửa vòi nước', OTHER_BUILDING, OTHER_ROOM);
  const a101 = await f.job('Sửa vòi nước', BUILDING, ROOM);
  const whole = await f.job('Kiểm điện phòng 305', BUILDING, null);
  const find = async (n, job) => f.run('task.update', 'preview', n, { job, note: 'đã gọi thợ' });
  const pick = r => r.kind === 'preview' ? r.resolved.jobId : r;
  const all = await find(1, 'vòi nước');
  assert.deepEqual([all.kind, all.why, all.candidates.length], ['needs_input', 'ambiguous', 3]);
  const two = await find(2, 'việc sửa vòi nước phòng 201');
  assert.deepEqual([two.kind, two.field, two.why, two.candidates.map(c => c.buildingName).sort()], ['needs_input', 'job', 'ambiguous', ['Toà A', 'Toà B']]);
  assert.equal(pick(await find(3, 'việc sửa vòi nước phòng 201 toà A')), a201);
  assert.equal(pick(await find(4, 'sửa vòi nước ở phòng 101')), a101);
  assert.equal(pick(await find(5, 'sửa vòi nước P.201, toà B')), b201);
  assert.equal(pick(await find(6, 'việc phòng 201 toà B')), b201, 'chỉ nêu chỗ (một toà) ⇒ việc đang mở ở đúng chỗ đó');
  assert.equal(pick(await find(7, 'Kiểm điện phòng 305')), whole, 'việc cả toà ghi phòng trong tiêu đề: luật cũ (cả chuỗi) vẫn tìm được');
  assert.equal(pick(await f.run('task.update', 'preview', 8, { job: 'sửa vòi nước phòng 201', buildingName: 'Toà B', note: 'x' })), b201);
  const none = await find(9, 'sửa vòi nước phòng 999');
  assert.deepEqual([none.kind, none.why], ['needs_input', 'not_visible']);
});

test('Q31: choosing the assignee from the listed managers is the consent — the next call with the same command writes at once; other preview reasons stay', { timeout: 300000 }, async t => {
  const f = await setup(t);
  const { db, jobs } = f;
  const base = { buildingName: 'Toà A', roomName: 'P101', jobType: 'sửa', content: 'thay bóng đèn hành lang' };
  const asked = await f.run('task.create', 'auto', 1, base);
  assert.deepEqual([asked.kind, asked.field, asked.why, asked.candidates.map(c => c.name).sort()],
    ['needs_input', 'person', 'unspecified', ['Huy Nhân Viên', 'Nathan Quản Lý']]);
  assert.equal(await f.offers(), 1);
  assert.equal((await db.query("SELECT has_table_privilege('authenticated','app_private.hermes_task_assignee_offers','SELECT') ok")).rows[0].ok, false);
  const chosen = await f.run('task.create', 'auto', 2, { ...base, assigneeName: 'Nathan' });
  assert.equal(chosen.kind, 'applied', JSON.stringify(chosen));
  assert.equal((await jobs()).at(-1).assignee_id, MANAGER);
  assert.equal(await f.offers(), 0, 'lời mời đã dùng bị xoá cùng lượt ghi');
  // Lý do xem trước khác vẫn giữ: chọn xong nhưng đã có việc trùng đang mở ở chỗ đó ⇒ xem trước có cảnh báo trùng.
  assert.equal((await f.run('task.create', 'auto', 3, base)).kind, 'needs_input');
  const dup = await f.run('task.create', 'auto', 4, { ...base, assigneeName: 'Huy' });
  assert.equal(dup.kind, 'preview', JSON.stringify(dup));
  assert.ok(dup.warnings.some(w => /Đã có việc/.test(w)));
});

test('Q31 offer barriers: other building, outside the list, expired, another user, preview phase, second use — each falls back to the normal preview', { timeout: 300000 }, async t => {
  const f = await setup(t);
  const { db, jobs } = f;
  const cmd = n => ({ buildingName: 'Toà A', roomName: '201', jobType: 'sửa', content: `thay ổ khoá tủ ${n}` });
  const ask = async (n, params) => assert.equal((await f.run('task.create', 'auto', n, params)).kind, 'needs_input');
  const choose = (n, params, name, phase = 'auto') => f.run('task.create', phase, n, { ...params, assigneeName: name });
  // Lời mời mang toà khác (toà giải ra lúc này khác toà đã hỏi) ⇒ không phải câu trả lời cho câu hỏi đó.
  await ask(1, cmd(1));
  await db.query('UPDATE app_private.hermes_task_assignee_offers SET building_id=$1', [OTHER_BUILDING]);
  assert.equal((await choose(2, cmd(1), 'Nathan')).kind, 'preview', 'toà khác');
  // Người ngoài danh sách dù có quyền ở toà (chủ thứ hai, OWNER: Q31 không đề xuất chủ) ⇒ xem trước.
  await ask(3, cmd(2));
  const outside = await choose(4, cmd(2), 'Chủ Hai');
  assert.deepEqual([outside.kind, outside.resolved.assigneeId, outside.preview.assigneeManagesBuilding], ['preview', CO_OWNER, true], 'ngoài danh sách');
  // Quá 15 phút ⇒ xem trước.
  await ask(5, cmd(3));
  await db.query("UPDATE app_private.hermes_task_assignee_offers SET offered_at=clock_timestamp()-interval '16 minutes'");
  assert.equal((await choose(6, cmd(3), 'Nathan')).kind, 'preview', 'quá hạn');
  // Lời mời của NGƯỜI KHÁC (cùng nội dung lệnh) không dùng được: người hỏi này chưa được hỏi.
  await ask(7, cmd(4));
  await db.query('UPDATE app_private.hermes_task_assignee_offers SET user_id=$1', [CO_OWNER]);
  assert.equal((await choose(8, cmd(4), 'Nathan')).kind, 'preview', 'lời mời của người khác');
  // Pha preview: luôn chỉ xem trước, không ghi, kể cả có lời mời hợp lệ.
  const before = (await jobs()).length;
  await ask(9, cmd(5));
  assert.equal((await choose(10, cmd(5), 'Nathan', 'preview')).kind, 'preview', 'pha preview');
  assert.equal((await jobs()).length, before, 'pha preview không ghi');
  // Dùng một lần: ghi xong, việc vừa tạo bị huỷ (không còn "việc trùng"), chọn lại đúng lệnh đó ⇒ lời mời đã hết ⇒ xem trước.
  assert.equal((await choose(11, cmd(5), 'Nathan')).kind, 'applied', 'lời mời hợp lệ còn hạn ⇒ ghi');
  await db.query('DELETE FROM public.jobs WHERE id=(SELECT id FROM public.jobs ORDER BY created_at DESC,id LIMIT 1)');
  assert.equal((await choose(12, cmd(5), 'Nathan')).kind, 'preview', 'lời mời chỉ dùng một lần');
});

test('mutation (11b): every Q31 offer barrier, the building-name filter, the used-type filter, the honorific order and the place split are each load-bearing', { timeout: 600000 }, async t => {
  const slice = (text, head) => { const start = text.indexOf(head); assert.ok(start >= 0, head); return text.slice(start, text.indexOf('END $fn$;', start) + 'END $fn$;'.length); };
  const mutate = (text, from, to) => { assert.equal(text.split(from).length, 2, `anchor: ${from.slice(0, 60)}`); return text.replace(from, () => to); };
  const core = slice(NGHIEM_THU_SQL, 'CREATE OR REPLACE FUNCTION app_private.hermes_task_resolve_core_v1(');
  const prepare = slice(NGHIEM_THU_SQL, 'CREATE OR REPLACE FUNCTION app_private.hermes_task_action_prepare_v1(');
  const resolver = slice(RESOLVE_SQL, 'CREATE OR REPLACE FUNCTION app_private.hermes_write_name_resolve_core_v1(');
  const base = { buildingName: 'Toà A', roomName: 'P101', jobType: 'sửa', content: 'thay bóng đèn hành lang' };
  const ask = f => f.run('task.create', 'auto', 1, base);
  const choose = (f, n = 2, name = 'Nathan', extra = {}, phase = 'auto') => f.run('task.create', phase, n, { ...base, ...extra, assigneeName: name });
  const PREPARE = [
    ['choice counts as consent', 'OR (v_assignee<>v_actor AND NOT v_chosen)', 'OR v_assignee<>v_actor',
      async f => { await ask(f); return (await choose(f)).kind === 'applied'; }],
    ['consent only for the same command', 'AND o.params_digest=v_offer ', '',
      async f => { await ask(f); return (await choose(f, 2, 'Nathan', { content: 'việc khác hẳn' })).kind === 'preview'; }],
    ['offer building must be the resolved building', 'AND o.building_id=v_building ', '',
      async f => { await ask(f); await f.db.query('UPDATE app_private.hermes_task_assignee_offers SET building_id=$1', [OTHER_BUILDING]);
        return (await choose(f)).kind === 'preview'; }],
    ['chosen person must be in the offered list', 'AND v_assignee=ANY(o.candidate_ids)', '',
      async f => { await ask(f); return (await choose(f, 2, 'Chủ Hai')).kind === 'preview'; }],
    ['offer expires after 15 minutes', "\n      AND o.offered_at>clock_timestamp()-interval '15 minutes'", '',
      async f => { await ask(f); await f.db.query("UPDATE app_private.hermes_task_assignee_offers SET offered_at=clock_timestamp()-interval '16 minutes'");
        return (await choose(f)).kind === 'preview'; }],
    ['offer belongs to the asker only', 'WHERE o.organization_id=v_org AND o.user_id=v_actor\n      AND o.params_digest=v_offer', 'WHERE o.organization_id=v_org\n      AND o.params_digest=v_offer',
      async f => { await ask(f); await f.db.query('UPDATE app_private.hermes_task_assignee_offers SET user_id=$1', [CO_OWNER]);
        return (await choose(f)).kind === 'preview'; }],
    ['preview phase never writes, even with a valid offer', "v_confirm:=p_phase='preview' OR ", 'v_confirm:=',
      async f => { await ask(f); const before = (await f.jobs()).length;
        return (await choose(f, 2, 'Nathan', {}, 'preview')).kind === 'preview' && (await f.jobs()).length === before; }],
    ['offer is consumed by the write', '  IF v_chosen THEN\n    DELETE FROM app_private.hermes_task_assignee_offers', '  IF false THEN\n    DELETE FROM app_private.hermes_task_assignee_offers',
      async f => { await ask(f); if ((await choose(f)).kind !== 'applied') return false;
        await f.db.query('DELETE FROM public.jobs'); return (await choose(f, 3)).kind === 'preview'; }],
  ].map(([label, from, to, probe]) => [label, mutate(prepare, from, to), probe]);
  const OTHERS = [
    ['building-named types are not suggested', mutate(core, '            AND NOT public.job_type_building_like_v1(v_org,j.name)),', '),'),
      async f => { await f.job('nhập nhầm', BUILDING, ROOM, TYPE_NVK);
        const r = await f.run('task.create', 'auto', 1, { buildingName: 'Toà A', roomName: 'P101', content: 'xyz qwe', assigneeName: 'tôi' });
        return !r.candidates.some(c => c.name === '162nvk'); }],
    ['never-used unscored types are not suggested', mutate(core, "WHERE y.e->'used'='true'::jsonb OR (y.e->>'score')::int>0) f WHERE f.n<=5)", 'WHERE true) f WHERE f.n<=5)'),
      async f => { const r = await f.run('task.create', 'auto', 1, { buildingName: 'Toà A', roomName: 'P101', content: 'xyz qwe', assigneeName: 'tôi' });
        return !r.candidates.some(c => c.name === 'ml'); }],
    ['honorific is recognised and dropped', mutate(resolver, "v_honor:=v_needles[1] ~ '^(anh|chi|em|co|chu|bac|ong|ba|thay|di|cau|a|c|e) +[a-z0-9]';", 'v_honor:=false;'),
      async f => (await f.run('task.create', 'preview', 1, { ...base, assigneeName: 'anh Huy' })).resolved?.assigneeId === STAFF],
    ['honorific string is never matched as a substring (old order)', mutate(resolver, 'WHEN NOT v_honor THEN strpos(', 'WHEN true THEN strpos('),
      async f => { await f.person(THANH_HUY, 'Thanh Huy'); await f.person(TRAN_HUY, 'Trần Văn Huy');
        const r = await f.run('task.create', 'preview', 1, { ...base, assigneeName: 'anh Huy' }); return r.kind === 'needs_input' && r.why === 'ambiguous'; }],
    ['room / building split off the title search', mutate(core, '        WHEN (v_jroomkey<>\'\' OR cardinality(v_jbids)>0) AND c.at_place AND char_length(v_jtext)>=3\n', '        WHEN false AND char_length(v_jtext)>=3\n'),
      async f => { const id = await f.job('Sửa vòi nước', BUILDING, ROOM_A201);
        const r = await f.run('task.update', 'preview', 1, { job: 'việc sửa vòi nước phòng 201', note: 'x' });
        return r.kind === 'preview' && r.resolved.jobId === id; }],
  ];
  for (const [label, mutant, probe] of [...PREPARE, ...OTHERS]) {
    await t.test(label, async () => {
      assert.equal(await probe(await setup(t)), true, 'bản sửa chặn');
      const f = await setup(t);
      await f.db.exec(mutant);
      assert.equal(await probe(f), false, 'đột biến lọt ⇒ test không rỗng');
    });
  }
});
