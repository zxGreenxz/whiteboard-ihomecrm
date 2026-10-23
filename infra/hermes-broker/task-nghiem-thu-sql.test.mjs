import test from 'node:test';
import assert from 'node:assert/strict';
import { setupRecurring, binding, ORG, USER, BUILDING, OTHER_BUILDING, ROOM, MANAGER, STAFF, TYPE_SUA } from './task-recurring-fixture.mjs';
import { migration, MINH, ROOM_A201, OTHER_ROOM } from './task-action-fixture.mjs';

// Lượt 11 — sửa theo nghiệm thu bot thật trên TEST (23–24/10), trên PGlite: nền fixture Công việc (RLS jobs production, chuỗi tới
// 20261023042436) + 20261023185114 (lõi giải tên dùng chung) + 20261023185116 (lõi + chuẩn bị của vỏ task), mỗi file hai lượt.
//  1. Chọn người nhận từ danh sách Q31 = đồng ý giao (không thêm một lượt xác nhận); mọi lý do xem trước khác giữ nguyên.
//  2. Gợi ý loại việc không có loại trùng tên toà (nhập nhầm) và loại chưa từng dùng mà không có điểm.
//  3. Tìm việc theo tiêu đề kèm "phòng N" / tên toà.
//  4. Người nhận có danh xưng ("anh Huy"); danh xưng đứng một mình vẫn không phải tên.
export const RESOLVE_SQL = migration('hermes_name_resolve_honorific_v1');
export const NGHIEM_THU_SQL = migration('hermes_task_nghiem_thu_v1');
const rid = n => `00000000-0000-4000-8000-${String(8100 + n).padStart(12, '0')}`;
const u = n => `00000000-0000-4000-8000-0000000009${String(n).padStart(2, '0')}`;
const ANH_TU = u(1), TU_LE = u(2), NVK = u(3), TYPE_NVK = u(4), TYPE_ML = u(5);
const inDays = async (db, n) => (await db.query("SELECT to_char((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date+$1::int,'YYYY-MM-DD') d", [n])).rows[0].d;

async function setup(t, { resolve = RESOLVE_SQL, nghiemThu = NGHIEM_THU_SQL } = {}) {
  const f = await setupRecurring(t, { enable: false });
  const { db } = f;
  for (const [label, sql] of [['20261023185114', resolve], ['20261023185116', nghiemThu]]) {
    if (!sql) continue;
    try { await db.exec(sql); await db.exec(sql); } catch (error) { error.message = `${label}: ${error.message}`; throw error; }
  }
  await db.exec(`INSERT INTO auth.users VALUES('${ANH_TU}'),('${TU_LE}') ON CONFLICT DO NOTHING;
    INSERT INTO public.organization_memberships(id,user_id,organization_id,status,member_type) VALUES('${ANH_TU}','${ANH_TU}','${ORG}','ACTIVE','STAFF'),
      ('${TU_LE}','${TU_LE}','${ORG}','ACTIVE','STAFF');
    INSERT INTO public.profiles VALUES('${ANH_TU}','Anh Tú'),('${TU_LE}','Tú Lê') ON CONFLICT (id) DO UPDATE SET full_name=excluded.full_name;
    -- Huy cũng quản lý toà A ⇒ toà A có hai người quản lý (Q31 hỏi chọn).
    INSERT INTO public.fixture_member_acl VALUES('${STAFF}','tasks.edit','{${BUILDING}}') ON CONFLICT (user_id,permission) DO UPDATE SET building_ids=excluded.building_ids;
    UPDATE public.fixture_member_acl SET building_ids='{${BUILDING},${OTHER_BUILDING}}' WHERE user_id='${STAFF}' AND permission='buildings.view';
    -- Dữ liệu nhập nhầm như production: toà "162NVK" và loại việc cùng tên (có một việc dùng); "ml" chưa từng dùng.
    INSERT INTO public.buildings VALUES('${NVK}','${ORG}','162NVK',false,null,null);
    INSERT INTO public.job_types VALUES('${TYPE_NVK}','${ORG}','162nvk',true),('${TYPE_ML}','${ORG}','ml',true);
    -- task.update cần khoá tasks.edit ở trần công ty + kết nối (như test Mốc 3 / 5).
    UPDATE app_private.hermes_org_policies SET action_capabilities=action_capabilities||ARRAY['tasks.edit'];
    UPDATE app_private.hermes_connections SET action_capabilities=action_capabilities||ARRAY['tasks.edit'];`);
  const deadline = `${await inDays(db, 5)} 17:00+07`;
  let n = 0;
  const job = async (title, building, room, type = TYPE_SUA) => (await db.query(`INSERT INTO public.jobs(user_id,code,title,building_id,room_id,job_type_id,priority,
      assignee_id,deadline,status,organization_id,started_at) VALUES($1,$2,$3,$4,$5,$6,'NORMAL',$7,$8::timestamptz,'IN_PROGRESS',$9,clock_timestamp()) RETURNING id`,
    [USER, `JOB-T-${String(++n).padStart(4, '0')}`, title, building, room, type, MANAGER, deadline, ORG])).rows[0].id;
  return { ...f, job };
}
const run = (f, action, phase, n, params, extra) => f.run(action, phase, rid(n), params, extra);

test('assignee with an honorific ("anh Huy", "a Huy", "chị Minh") resolves after dropping it; a bare pronoun is still not a name; a real name starting with "Anh" wins', { timeout: 300000 }, async t => {
  const f = await setup(t);
  const base = { buildingName: 'Toà A', roomName: 'P101', jobType: 'sửa', content: 'thay vòi sen' };
  const assignee = async (n, name) => { const r = await run(f, 'task.create', 'preview', n, { ...base, assigneeName: name }); return [r.kind, r.resolved?.assigneeId ?? r.field, r.why]; };
  assert.deepEqual(await assignee(1, 'anh Huy'), ['preview', STAFF, undefined]);
  assert.deepEqual(await assignee(2, 'a huy'), ['preview', STAFF, undefined]);
  assert.deepEqual(await assignee(3, 'chị Minh'), ['preview', MINH, undefined], '"Minh" sau danh xưng là tên người (Nguyễn Văn Minh)');
  assert.deepEqual(await assignee(4, 'Anh Tú'), ['preview', ANH_TU, undefined], 'tên thật mở đầu bằng "Anh": khớp nguyên chuỗi trước');
  assert.deepEqual(await assignee(5, 'anh Lê'), ['preview', TU_LE, undefined]);
  // Danh xưng đứng một mình: bẫy cũ của lõi task giữ nguyên — không bỏ gì (không có tên sau nó); khớp như cũ (ở đây "Anh Tú" chứa
  // "anh") và luôn cờ mơ hồ ⇒ xem trước kèm câu "hiểu là"; "em" không ai chứa ⇒ hiểu là chính người hỏi, vẫn mơ hồ.
  const alone = await run(f, 'task.create', 'preview', 6, { ...base, assigneeName: 'anh' });
  assert.deepEqual([alone.resolved.assigneeId, alone.resolved.assigneeAmbiguous], [ANH_TU, true]);
  const em = await run(f, 'task.create', 'preview', 8, { ...base, assigneeName: 'em' });
  assert.deepEqual([em.resolved.assigneeId, em.resolved.assigneeAmbiguous], [USER, true]);
  // Không ai tên như vậy kể cả sau khi bỏ danh xưng ⇒ hỏi lại, không đoán.
  const nobody = await run(f, 'task.create', 'preview', 7, { ...base, assigneeName: 'anh Khoa' });
  assert.deepEqual([nobody.kind, nobody.field, nobody.why, nobody.wanted], ['needs_input', 'person', 'not_visible', 'anh Khoa']);
});

test('job type suggestions skip building-named junk and never-used unscored types; explicit building-named type is not accepted', { timeout: 300000 }, async t => {
  const f = await setup(t);
  const { db } = f;
  await f.job('việc dùng loại sửa', BUILDING, ROOM);
  await f.job('việc nhập nhầm loại', BUILDING, ROOM, TYPE_NVK);
  assert.equal((await db.query("SELECT public.job_type_building_like_v1($1,'162nvk') a,public.job_type_building_like_v1($1,'162 NVK') b,public.job_type_building_like_v1($1,'sửa') c", [ORG])).rows[0].a, true);
  const ask = await run(f, 'task.create', 'auto', 1, { buildingName: 'Toà A', roomName: 'P101', content: 'xyz qwe', assigneeName: 'tôi' });
  assert.deepEqual([ask.kind, ask.field, ask.why], ['needs_input', 'jobType', 'unspecified']);
  assert.deepEqual(ask.candidates.map(c => c.name), ['sửa'], 'chỉ loại đã từng dùng (hoặc có điểm); không 162nvk, ml, loại chưa dùng');
  assert.equal(ask.more, false);
  // Mô hình nêu thẳng loại trùng tên toà: không nhận như loại việc (đoán theo nội dung như mọi loại không khớp).
  const named = await run(f, 'task.create', 'auto', 2, { buildingName: 'Toà A', roomName: 'P101', jobType: '162nvk', content: 'xyz qwe', assigneeName: 'tôi' });
  assert.deepEqual([named.kind, named.field], ['needs_input', 'jobType']);
  assert.ok(!named.candidates.some(c => c.name === '162nvk'));
  // Có điểm thì vẫn gợi ý dù chưa dùng (nội dung nhắc tên loại, hoà điểm ⇒ hỏi lại).
  const scored = await run(f, 'task.create', 'auto', 3, { buildingName: 'Toà A', roomName: 'P101', content: 'qwe vệ ml', assigneeName: 'tôi' });
  assert.equal(scored.kind, 'needs_input', JSON.stringify(scored));
  assert.deepEqual(scored.candidates.map(c => c.name).sort(), ['ml', 'sửa', 'vệ'], '"ml" có điểm (nội dung nhắc tên) ⇒ được gợi ý dù chưa dùng');
});

test('job search by title with "phòng N" / building name: room and building are split off and used as filters; the old whole-string rule still works', { timeout: 300000 }, async t => {
  const f = await setup(t);
  const a201 = await f.job('Sửa vòi nước', BUILDING, ROOM_A201);
  const b201 = await f.job('Sửa vòi nước', OTHER_BUILDING, OTHER_ROOM);
  const a101 = await f.job('Sửa vòi nước', BUILDING, ROOM);
  const whole = await f.job('Kiểm điện phòng 305', BUILDING, null);
  const find = async (n, job) => run(f, 'task.update', 'preview', n, { job, note: 'đã gọi thợ' });
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
  // Nêu riêng toà qua tham số vẫn được, phòng tách từ chuỗi lọc thêm.
  assert.equal(pick(await run(f, 'task.update', 'preview', 8, { job: 'sửa vòi nước phòng 201', buildingName: 'Toà B', note: 'x' })), b201);
  const none = await find(9, 'sửa vòi nước phòng 999');
  assert.deepEqual([none.kind, none.why], ['needs_input', 'not_visible']);
});

test('Q31: choosing the assignee from the listed managers is the consent — the next call with the same command writes at once; other preview reasons stay', { timeout: 300000 }, async t => {
  const f = await setup(t);
  const { db, jobs } = f;
  const base = { buildingName: 'Toà A', roomName: 'P101', jobType: 'sửa', content: 'thay bóng đèn hành lang' };
  const offers = async () => (await db.query('SELECT count(*)::int n FROM app_private.hermes_task_assignee_offers')).rows[0].n;
  const asked = await run(f, 'task.create', 'auto', 1, base);
  assert.deepEqual([asked.kind, asked.field, asked.why, asked.candidates.map(c => c.name).sort()],
    ['needs_input', 'person', 'unspecified', ['Huy Nhân Viên', 'Nathan Quản Lý']]);
  assert.equal(await offers(), 1);
  assert.equal((await db.query("SELECT has_table_privilege('authenticated','app_private.hermes_task_assignee_offers','SELECT') ok")).rows[0].ok, false);
  const chosen = await run(f, 'task.create', 'auto', 2, { ...base, assigneeName: 'Nathan' });
  assert.equal(chosen.kind, 'applied', JSON.stringify(chosen));
  assert.equal((await jobs()).at(-1).assignee_id, MANAGER);
  assert.equal(await offers(), 0, 'lời mời đã dùng bị xoá cùng lượt ghi');
  // Người ngoài danh sách ⇒ vẫn xem trước (Q32). Phòng khác: việc vừa tạo ở P101 cùng loại sẽ thành "việc trùng" (lý do xem trước riêng).
  const other = { ...base, roomName: '201', content: 'thay ổ khoá tủ' };
  assert.equal((await run(f, 'task.create', 'auto', 3, other)).kind, 'needs_input');
  assert.equal((await run(f, 'task.create', 'auto', 4, { ...other, assigneeName: 'Minh' })).kind, 'preview');
  // Đổi nội dung lệnh ⇒ không còn là câu trả lời cho câu hỏi đó ⇒ xem trước.
  assert.equal((await run(f, 'task.create', 'auto', 5, { ...other, content: 'thay ổ khoá tủ bếp', assigneeName: 'Huy' })).kind, 'preview');
  // Quá 15 phút ⇒ xem trước.
  await db.query("UPDATE app_private.hermes_task_assignee_offers SET offered_at=clock_timestamp()-interval '16 minutes'");
  assert.equal((await run(f, 'task.create', 'auto', 6, { ...other, assigneeName: 'Huy' })).kind, 'preview');
  // Còn hạn, đúng nội dung, đúng người ⇒ ghi.
  assert.equal((await run(f, 'task.create', 'auto', 7, other)).kind, 'needs_input');
  assert.equal((await run(f, 'task.create', 'auto', 8, { ...other, assigneeName: 'huy' })).kind, 'applied');
  // Lý do xem trước khác vẫn giữ: chọn xong nhưng đã có việc trùng đang mở ở chỗ đó ⇒ xem trước có cảnh báo trùng.
  assert.equal((await run(f, 'task.create', 'auto', 9, base)).kind, 'needs_input');
  const dup = await run(f, 'task.create', 'auto', 10, { ...base, assigneeName: 'Huy' });
  assert.equal(dup.kind, 'preview', JSON.stringify(dup));
  assert.ok(dup.warnings.some(w => /Đã có việc/.test(w)));
  // Phiên của người khác không dùng được lời mời của người hỏi (khoá theo người hỏi): binding khác ⇒ không áp dụng — đo qua bảng.
  assert.deepEqual((await db.query('SELECT DISTINCT user_id FROM app_private.hermes_task_assignee_offers')).rows.map(r => r.user_id), [USER]);
  assert.ok(binding.connectionId);
});

test('mutation: Q31 consent, its command digest, the building-name filter, the used-type filter, honorific fallback and the place split are each load-bearing', { timeout: 300000 }, async t => {
  const slice = (text, head) => { const start = text.indexOf(head); assert.ok(start >= 0, head); return text.slice(start, text.indexOf('END $fn$;', start) + 'END $fn$;'.length); };
  const mutate = (text, from, to) => { assert.equal(text.split(from).length, 2, `anchor: ${from.slice(0, 60)}`); return text.replace(from, () => to); };
  const core = slice(NGHIEM_THU_SQL, 'CREATE OR REPLACE FUNCTION app_private.hermes_task_resolve_core_v1(');
  const prepare = slice(NGHIEM_THU_SQL, 'CREATE OR REPLACE FUNCTION app_private.hermes_task_action_prepare_v1(');
  const resolver = slice(RESOLVE_SQL, 'CREATE OR REPLACE FUNCTION app_private.hermes_write_name_resolve_core_v1(');
  const base = { buildingName: 'Toà A', roomName: 'P101', jobType: 'sửa', content: 'thay bóng đèn hành lang' };
  const probes = [
    ['choice counts as consent', mutate(prepare, 'OR (v_assignee<>v_actor AND NOT v_chosen)', 'OR v_assignee<>v_actor'),
      async f => { await run(f, 'task.create', 'auto', 1, base); return (await run(f, 'task.create', 'auto', 2, { ...base, assigneeName: 'Nathan' })).kind === 'applied'; }],
    ['consent only for the same command', mutate(prepare, 'AND o.params_digest=v_offer ', ''),
      async f => { await run(f, 'task.create', 'auto', 1, base);
        return (await run(f, 'task.create', 'auto', 2, { ...base, content: 'việc khác hẳn', assigneeName: 'Nathan' })).kind === 'preview'; }],
    ['building-named types are not suggested', mutate(core, '            AND NOT public.job_type_building_like_v1(v_org,j.name)),', '),'),
      async f => { await f.job('nhập nhầm', BUILDING, ROOM, TYPE_NVK);
        const r = await run(f, 'task.create', 'auto', 1, { buildingName: 'Toà A', roomName: 'P101', content: 'xyz qwe', assigneeName: 'tôi' });
        return !r.candidates.some(c => c.name === '162nvk'); }],
    ['never-used unscored types are not suggested', mutate(core, "WHERE y.e->'used'='true'::jsonb OR (y.e->>'score')::int>0) f WHERE f.n<=5)", 'WHERE true) f WHERE f.n<=5)'),
      async f => { const r = await run(f, 'task.create', 'auto', 1, { buildingName: 'Toà A', roomName: 'P101', content: 'xyz qwe', assigneeName: 'tôi' });
        return !r.candidates.some(c => c.name === 'ml'); }],
    ['honorific is dropped when nobody matches the whole string', mutate(resolver, "    IF v_needles[1] ~ '^(anh|chi|em|co|chu|bac|ong|ba|thay|di|cau|a|c|e) +[a-z0-9]' THEN", '    IF false THEN'),
      async f => (await run(f, 'task.create', 'preview', 1, { ...base, assigneeName: 'anh Huy' })).resolved?.assigneeId === STAFF],
    ['room / building split off the title search', mutate(core, '        WHEN (v_jroomkey<>\'\' OR cardinality(v_jbids)>0) AND c.at_place AND char_length(v_jtext)>=3\n', '        WHEN false AND char_length(v_jtext)>=3\n'),
      async f => { const id = await f.job('Sửa vòi nước', BUILDING, ROOM_A201);
        const r = await run(f, 'task.update', 'preview', 1, { job: 'việc sửa vòi nước phòng 201', note: 'x' });
        return r.kind === 'preview' && r.resolved.jobId === id; }],
  ];
  for (const [label, mutant, probe] of probes) {
    await t.test(label, async () => {
      assert.equal(await probe(await setup(t)), true, 'bản sửa chặn');
      const f = await setup(t);
      await f.db.exec(mutant);
      assert.equal(await probe(f), false, 'đột biến lọt ⇒ test không rỗng');
    });
  }
});
