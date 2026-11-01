import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTaskActions, binding, BUILDING, OTHER_BUILDING, ORG, USER, MANAGER, STAFF, CO_OWNER, ROOM_A201, TYPE_SUA } from './task-action-fixture.mjs';

// Mốc 4 (CONG-VIEC-THAO-TAC-GHI.md mục 21) trên PGlite: task.create_batch qua cùng vỏ hermes_task_action_v1 (20261022164201).
// Kiểm: mỗi mục theo đúng luật task.create (giá trị chung + riêng), LUÔN xem trước một lần cho cả lô, mục đầu tiên chưa giải được ⇒ hỏi
// lại kèm số mục, buildingsManagedBy trải ra các toà người đó quản lý (luật Q31), cả lô hoặc không gì (một INSERT lỗi ⇒ không việc nào),
// hạn mức cho cả lô (vượt ⇒ từ chối ngay ở bản xem trước), basis lượt 2, phát lại theo requestId, sổ + audit từng việc.
const rid = n => `00000000-0000-4000-8000-${String(700 + n).padStart(12, '0')}`;
const VN = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d);
const inDaysVN = n => { const day = new Date(`${VN(new Date())}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + n); return day.toISOString().slice(0, 10); };

test('Mốc 4: task.create_batch — one preview for the whole batch, all or nothing, item index on the first unresolved item', { timeout: 300000 }, async t => {
  const f = await setupTaskActions(t);
  const { db, call, jobs, receipts, ledger } = f;
  const batch = (phase, requestId, params, extra = {}) => call('SELECT public.hermes_task_action_v1($1::jsonb,$2,$3,$4::uuid,$5::jsonb,$6::jsonb,$7) result',
    [JSON.stringify(binding), 'task.create_batch', phase, requestId, JSON.stringify(params), extra.resolved ? JSON.stringify(extra.resolved) : null, extra.basis ?? null]);
  const count = async () => Number((await db.query('SELECT count(*) n FROM public.jobs')).rows[0].n);
  const deadline = inDaysVN(5);

  await t.test('items: shared values + per-item rooms ⇒ ONE preview (even on auto), nothing written; apply writes every job; replay', async () => {
    const params = { jobType: 'sửa', content: 'kiểm điện', assigneeName: 'Nathan', deadline,
      items: [{ buildingName: 'Toà A', roomName: 'P101' }, { buildingName: 'Toà A', roomName: '201' }, { buildingName: 'Toà B', roomName: 'P201' }] };
    const before = await count();
    const preview = await batch('auto', rid(1), params);
    assert.equal(preview.kind, 'preview', JSON.stringify(preview));
    assert.equal(preview.confirm, 'required');
    assert.equal(await count(), before, 'lượt 1 không ghi gì');
    assert.equal(preview.preview.count, 3);
    assert.deepEqual(preview.preview.items.map(row => [row.stt, row.building, row.room, row.assignee]),
      [[1, 'Toà A', 'P101', 'Nathan Quản Lý'], [2, 'Toà A', '201', 'Nathan Quản Lý'], [3, 'Toà B', 'P201', 'Nathan Quản Lý']]);
    assert.match(preview.preview.text, /^Giao 3 việc 'sửa kiểm điện' cho Nathan Quản Lý, hạn hết .+: Toà A phòng P101, Toà A phòng 201, Toà B phòng P201\.$/);
    assert.ok(preview.warnings.some(w => w.includes('Nathan Quản Lý ở toà Toà B')), 'Nathan không quản lý toà B ⇒ cảnh báo');
    assert.equal(preview.resolved.items.length, 3);
    const applied = await batch('apply', rid(1), params, preview);
    assert.equal(applied.kind, 'applied', JSON.stringify(applied));
    assert.equal(applied.link, '/tasks');
    assert.equal(applied.result.count, 3);
    assert.match(applied.result.text, /^Đã tạo 3 việc: JOB-\d{8}-\d{4} \(Toà A phòng P101\), JOB-\d{8}-\d{4} \(Toà A phòng 201\), JOB-\d{8}-\d{4} \(Toà B phòng P201\)\.$/);
    // Cùng giao dịch ⇒ cùng created_at: thứ tự chèn = thứ tự mã việc (trigger cấp mã tăng dần).
    const made = (await jobs()).slice(-3).sort((x, y) => x.code.localeCompare(y.code));
    assert.deepEqual(made.map(row => [row.assignee_id, row.job_type_id, row.title, row.local_deadline]),
      Array(3).fill([MANAGER, TYPE_SUA, 'sửa kiểm điện', `${deadline} 23:59:59.999`]));
    assert.deepEqual(applied.result.jobs.map(row => row.code), made.map(row => row.code));
    assert.deepEqual((await ledger()).slice(-3).map(row => [row.action, row.actor_id, row.assignee_id]), Array(3).fill(['task.create_batch', USER, MANAGER]));
    const audit = (await db.query("SELECT new_state FROM public.authorization_audit_events WHERE event_type='HERMES_TASK_CREATED' AND new_state->>'action'='task.create_batch' ORDER BY (new_state->>'item')::int")).rows;
    assert.deepEqual(audit.map(row => [row.new_state.item, row.new_state.items]), [[1, 3], [2, 3], [3, 3]]);
    assert.deepEqual((await receipts()).filter(row => row.request_id === rid(1)).map(row => [row.action, row.state]), [['task.create_batch', 'applied']]);
    // Cùng requestId ⇒ phát lại, không tạo thêm.
    assert.deepEqual(await batch('apply', rid(1), params, preview), applied);
    assert.equal(await count(), before + 3);
  });

  await t.test('first unresolved item ⇒ ask with its item number; nothing written; dropping it ⇒ one preview of the rest', async () => {
    const before = await count();
    const asked = await batch('auto', rid(10), { jobType: 'sửa', content: 'kiểm vòi', assigneeName: 'tôi',
      items: [{ buildingName: 'Toà A', roomName: 'P101' }, { buildingName: 'Toà A', roomName: 'P999' }, { buildingName: 'Toà B', roomName: 'P201' }] });
    assert.deepEqual([asked.kind, asked.reason, asked.field, asked.item], ['needs_input', 'name_unresolved', 'room', 2], JSON.stringify(asked));
    assert.equal(await count(), before);
    // Toà chung ở ngoài ("toà A, mỗi phòng một việc"; tầng 2 TEST CV-B04/B05): mục chỉ nêu phòng; mục nêu toà riêng thì đè.
    const shared = await batch('auto', rid(16), { jobType: 'sửa', content: 'kiểm vòi', assigneeName: 'tôi', buildingName: 'Toà A',
      items: [{ roomName: 'P101' }, { roomName: '201' }, { buildingName: 'Toà B', roomName: 'P201' }] });
    assert.equal(shared.kind, 'preview', JSON.stringify(shared));
    assert.deepEqual(shared.preview.items.map(row => [row.building, row.room]), [['Toà A', 'P101'], ['Toà A', '201'], ['Toà B', 'P201']]);
    const sharedMissing = await batch('auto', rid(17), { jobType: 'sửa', content: 'kiểm vòi', assigneeName: 'tôi', buildingName: 'Toà A',
      items: [{ roomName: 'P101' }, { roomName: '999' }] });
    assert.deepEqual([sharedMissing.kind, sharedMissing.field, sharedMissing.item], ['needs_input', 'room', 2], JSON.stringify(sharedMissing));
    assert.equal(await count(), before);
    const missing = await batch('auto', rid(11), { jobType: 'sửa', content: 'kiểm vòi', items: [{ buildingName: 'Toà A' }, { buildingName: 'Toà B', assigneeName: 'tôi' }] });
    assert.deepEqual([missing.kind, missing.field, missing.why, missing.item], ['needs_input', 'person', 'unspecified', 1], 'lô không đề xuất người quản lý');
    const late = await batch('auto', rid(12), { jobType: 'sửa', content: 'kiểm vòi', assigneeName: 'tôi',
      items: [{ buildingName: 'Toà A' }, { buildingName: 'Toà B', deadline: '2020-01-01' }] });
    assert.deepEqual([late.kind, late.reason, late.item], ['needs_input', 'date_out_of_range', 2]);
    const blank = await batch('auto', rid(13), { jobType: 'sửa', assigneeName: 'tôi', items: [{ buildingName: 'Toà A', content: 'có' }, { buildingName: 'Toà B' }] });
    assert.deepEqual([blank.kind, blank.reason, blank.item], ['needs_input', 'invalid_params', 2], 'mục thiếu nội dung');
    for (const params of [{ content: 'x', items: [{ buildingName: 'Toà A' }], buildingsManagedBy: 'Nathan' }, { content: 'x' },
      { content: 'x', buildingsManagedBy: 'Nathan', buildingName: 'Toà A' }])
      assert.deepEqual([(await batch('auto', rid(14), params)).reason], ['invalid_params'], 'đúng một trong items / buildingsManagedBy; toà chung mâu thuẫn buildingsManagedBy');
    const many = await batch('auto', rid(15), { content: 'x', assigneeName: 'tôi', items: Array.from({ length: 21 }, () => ({ buildingName: 'Toà A' })) });
    assert.deepEqual([many.kind, many.reason], ['needs_input', 'batch_too_large']);
    assert.equal(await count(), before);
  });

  await t.test('buildingsManagedBy: every building the person manages in the key scope (Q31 rule), whole building, assignee defaults to that person', async () => {
    const preview = await batch('auto', rid(20), { buildingsManagedBy: 'Nathan', jobType: 'sửa', content: 'kiểm đồng hồ', deadline });
    assert.equal(preview.kind, 'preview', JSON.stringify(preview));
    assert.deepEqual(preview.preview.items.map(row => [row.building, row.wholeBuilding, row.assignee]), [['Toà A', true, 'Nathan Quản Lý']]);
    const applied = await batch('apply', rid(20), { buildingsManagedBy: 'Nathan', jobType: 'sửa', content: 'kiểm đồng hồ', deadline }, preview);
    assert.equal(applied.kind, 'applied');
    const made = (await jobs()).at(-1);
    assert.deepEqual([made.building_id, made.room_id, made.assignee_id], [BUILDING, null, MANAGER]);
    // Huy chỉ xem toà B (không tasks.edit) ⇒ không quản lý toà nào; chủ (OWNER) không bao giờ là "người quản lý".
    for (const name of ['Huy', 'Chủ Hai']) {
      const none = await batch('auto', rid(21), { buildingsManagedBy: name, jobType: 'sửa', content: 'kiểm đồng hồ', assigneeName: 'tôi' });
      assert.deepEqual([none.kind, none.field, none.why], ['needs_input', 'building', 'unspecified'], name);
    }
    void [STAFF, CO_OWNER];
  });

  await t.test('all or nothing: one INSERT failing at write ⇒ no job of the batch, receipt rejected', async () => {
    await db.exec(`CREATE FUNCTION public.fixture_fail_title() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
        IF NEW.title LIKE '%lỗi giữa lô%' THEN RAISE EXCEPTION 'fixture_insert_failed' USING ERRCODE='23514'; END IF; RETURN NEW; END $f$;
      CREATE TRIGGER fixture_fail_title BEFORE INSERT ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.fixture_fail_title();`);
    try {
      const params = { jobType: 'sửa', assigneeName: 'tôi', items: [{ buildingName: 'Toà A', content: 'đầu lô' }, { buildingName: 'Toà B', content: 'lỗi giữa lô' }] };
      const before = await count();
      const preview = await batch('auto', rid(30), params);
      assert.equal(preview.kind, 'preview');
      const failed = await batch('apply', rid(30), params, preview);
      assert.equal(failed.kind, 'rejected', JSON.stringify(failed));
      assert.equal(await count(), before, 'mục đầu đã chèn cũng lùi theo cả khối');
      assert.deepEqual((await receipts()).filter(row => row.request_id === rid(30)).map(row => row.state), ['rejected']);
    } finally {
      await db.exec('DROP TRIGGER fixture_fail_title ON public.jobs; DROP FUNCTION public.fixture_fail_title();');
    }
  });

  await t.test('state change between turns ⇒ state_changed; duplicates and twins are warned per item', async () => {
    const params = { jobType: 'sửa', content: 'thay bóng', assigneeName: 'tôi', items: [{ buildingName: 'Toà A', roomName: 'P101' }, { buildingName: 'Toà A', roomName: 'P101' }] };
    const preview = await batch('auto', rid(40), params);
    assert.ok(preview.warnings.some(w => w.startsWith('Mục #2 trùng chỗ')), JSON.stringify(preview.warnings));
    await f.action('auto', rid(41), { buildingName: 'Toà A', roomName: 'P101', jobType: 'sửa', content: 'việc chen giữa', assigneeName: 'tôi' }).then(out =>
      out.kind === 'preview' ? f.action('apply', rid(41), { buildingName: 'Toà A', roomName: 'P101', jobType: 'sửa', content: 'việc chen giữa', assigneeName: 'tôi' }, out) : out);
    assert.deepEqual([(await batch('apply', rid(40), params, preview)).reason], ['state_changed']);
    const again = await batch('auto', rid(42), params);
    assert.ok(again.warnings.some(w => w.startsWith('Đã có việc cùng loại đang mở ở chỗ của mục #1')), JSON.stringify(again.warnings));
    void ROOM_A201;
  });

  await t.test('quota for the WHOLE batch: over the pair limit ⇒ rejected at preview, no receipt, nothing written', async () => {
    await db.exec("UPDATE app_private.hermes_task_limits SET per_pair_hour=2 WHERE organization_id IS NULL");
    try {
      const before = await count();
      const out = await batch('auto', rid(50), { jobType: 'sửa', content: 'kiểm điện tầng', assigneeName: 'Nathan', deadline,
        items: [{ buildingName: 'Toà A', roomName: 'P101' }, { buildingName: 'Toà A', roomName: '201' }, { buildingName: 'Toà A' }] });
      assert.deepEqual([out.kind, out.reason], ['rejected', 'task_quota_pair'], JSON.stringify(out));
      assert.equal(await count(), before);
      assert.equal((await receipts()).filter(row => row.request_id === rid(50)).length, 0);
    } finally {
      await db.exec('UPDATE app_private.hermes_task_limits SET per_pair_hour=CASE tier WHEN \'owner\' THEN 40 ELSE 10 END WHERE organization_id IS NULL');
    }
  });

  await t.test('apply re-checks the scope: a building leaving the key scope between turns ⇒ not_allowed', async () => {
    const params = { jobType: 'sửa', content: 'kiểm cửa', assigneeName: 'tôi', items: [{ buildingName: 'Toà A' }, { buildingName: 'Toà B' }] };
    const preview = await batch('auto', rid(60), params);
    assert.equal(preview.kind, 'preview');
    await db.query("UPDATE public.fixture_acl SET building_ids=$1 WHERE permission='tasks.create'", [[BUILDING]]);
    try {
      assert.deepEqual([(await batch('apply', rid(60), params, preview)).reason], ['not_allowed']);
    } finally {
      await db.query("UPDATE public.fixture_acl SET building_ids=$1 WHERE permission='tasks.create'", [[BUILDING, OTHER_BUILDING]]);
    }
    void ORG;
  });
});
