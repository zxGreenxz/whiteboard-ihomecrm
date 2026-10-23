import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTaskActions, ORG, USER, MINH, TYPE_SUA } from './task-action-fixture.mjs';

// Mốc 2c (CONG-VIEC-THAO-TAC-GHI.md mục 18) trên PGlite: bot thật trên TEST 22/10 trượt 5/11 ca vì mô hình tự đặt jobType không có
// trong danh mục ("kiểm tra điện", "Bảo trì", "Dọn vệ sinh", "Sửa chữa") ⇒ needs_input kèm gợi ý theo chữ cái. Danh mục ở đây là
// danh mục loại THẬT của công ty trên production/TEST (15 loại, cùng tên). jobType không khớp ⇒ coi như chưa nêu, tự suy theo nội
// dung + chính chuỗi đó, luôn xem trước; không suy được ⇒ hỏi lại kèm ≤ 5 gợi ý xếp theo độ gần. Kèm: hạn chỉ ngày = hết ngày đó
// giờ VN; "cho mình" vẫn đi nhánh mơ hồ ⇒ xem trước.
const rid = n => `00000000-0000-4000-8000-${String(600 + n).padStart(12, '0')}`;
const id = n => `00000000-0000-4000-8000-${String(950 + n).padStart(12, '0')}`;
const REAL = ['checkin', 'OT', 'check', 'làm', 'thay', 'decor', 'mua', 'vesinh', 'giặt', 'vệ', '950nk', 'thông', '162nvk', 'ml'];
const base = { buildingName: 'Toà A', roomName: 'P101', assigneeName: 'tôi' };
const daysFromTodayVN = n => { const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
  const day = new Date(`${today}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + n); return day.toISOString().slice(0, 10); };

test('Mốc 2c: unmatched jobType is inferred from content and the string itself (real catalogue), always previewed', { timeout: 300000 }, async t => {
  const f = await setupTaskActions(t);
  const { db, action, jobs } = f;
  // Danh mục thật: tắt các loại của fixture, giữ 'sửa' (TYPE_SUA), thêm 14 loại còn lại.
  await db.query('UPDATE public.job_types SET is_active=(id=$1) WHERE organization_id=$2', [TYPE_SUA, ORG]);
  for (const [i, name] of REAL.entries()) await db.query('INSERT INTO public.job_types VALUES($1,$2,$3,true)', [id(i), ORG, name]);
  const preview = async (n, params) => action('preview', rid(n), { ...base, ...params });
  const typeOf = outcome => [outcome.kind, outcome.preview?.jobType, outcome.preview?.jobTypeGuessed];

  await t.test('the five strings the model invented on TEST resolve to a real type, with a warning naming the replaced string', async () => {
    for (const [n, jobType, content, expected] of [[1, 'kiểm tra điện', 'Kiểm tra điện phòng 201', 'check'], [2, 'Bảo trì', 'Bảo trì máy bơm', 'sửa'],
      [3, 'Dọn vệ sinh', 'Dọn vệ sinh phòng 201', 'vesinh'], [4, 'Sửa chữa', 'Sửa vòi nước', 'sửa'], [5, 'sửa chữa', 'Sửa khoá cửa', 'sửa'],
      // Chỉ chuỗi loại mang tên loại (nội dung không có): mức 'chuỗi loại chứa tên loại'.
      [6, 'Giặt rèm', 'Rèm phòng 201 bị bẩn', 'giặt']]) {
      const outcome = await preview(n, { jobType, content });
      assert.deepEqual(typeOf(outcome), ['preview', expected, true], `${jobType}: ${JSON.stringify(outcome)}`);
      assert.match(outcome.preview.text, new RegExp(`\\(loại ${expected}, tự chọn theo nội dung\\)`));
      assert.ok(outcome.warnings.includes(`Không khớp loại việc '${jobType}'; tự chọn loại '${expected}' theo nội dung — hỏi lại nếu sai.`), JSON.stringify(outcome.warnings));
    }
  });

  await t.test('auto with a guessed type never writes at once; the second turn writes the shown type', async () => {
    const params = { ...base, jobType: 'kiểm tra điện', content: 'Kiểm tra điện phòng 201' };
    const first = await action('auto', rid(10), params);
    assert.equal(first.kind, 'preview', 'tự giao đủ thông tin nhưng loại do máy chủ đoán ⇒ vẫn xem trước');
    assert.equal((await jobs()).length, 0);
    const applied = await action('apply', rid(10), params, { resolved: first.resolved, basis: first.basis });
    assert.equal(applied.kind, 'applied', JSON.stringify(applied));
    const [job] = await jobs();
    assert.equal(job.job_type_id, id(REAL.indexOf('check')));
    assert.equal(job.title, 'check Kiểm tra điện phòng 201', 'tiêu đề như web: "<loại> <nội dung>"');
  });

  await t.test('no jobType: content anywhere and common synonyms count, not only its first word', async () => {
    for (const [n, content, expected] of [[20, 'Kiểm tra điện phòng 201', 'check'], [21, 'Vệ sinh máy lạnh', 'vesinh'], [22, 'Check in làm hợp đồng khách mới', 'checkin'],
      [23, 'Bồn cầu bị tắc nghẽn', 'thông'], [24, 'Trang trí phòng ban công', 'decor'], [25, 'thay bóng đèn, hành lang', 'thay'], [26, 'Phòng 302 cần decor.', 'decor']]) {
      const outcome = await preview(n, { content });
      assert.deepEqual(typeOf(outcome), ['preview', expected, true], `${content}: ${JSON.stringify(outcome)}`);
      assert.ok(outcome.warnings.includes(`Loại việc '${expected}' do bot chọn theo nội dung.`));
    }
  });

  await t.test('an exact type name is used as is (no guess); self-assign writes at once', async () => {
    const applied = await action('auto', rid(30), { ...base, roomName: 'cả toà', jobType: 'Sửa', content: 'sửa cửa cuốn' });
    assert.equal(applied.kind, 'applied', JSON.stringify(applied));
  });

  await t.test('nothing inferable or a tie ⇒ ask, with at most 5 suggestions ranked by closeness (not alphabetical)', async () => {
    const none = await preview(40, { jobType: 'Phụ kiện', content: 'Mũ bảo hiểm cho khách' });
    assert.equal(none.kind, 'needs_input', JSON.stringify(none));
    assert.deepEqual([none.field, none.why, none.wanted, none.more], ['jobType', 'unspecified', '', true]);
    // Tiền tố chung với một từ: "cho" ~ check/checkin, "mũ" ~ mua; rồi các loại còn lại theo tên.
    assert.deepEqual(none.candidates.map(c => c.name), ['check', 'checkin', 'mua', '162nvk', '950nk']);
    const tie = await preview(41, { content: 'khách cần check và decor phòng' });
    assert.equal(tie.kind, 'needs_input', 'hai loại cùng điểm ⇒ không chọn bừa');
    assert.deepEqual(tie.candidates.slice(0, 2).map(c => c.name), ['check', 'decor']);
  });

  await t.test('date-only deadline = end of that day in Vietnam time (item 2)', async () => {
    const day = daysFromTodayVN(3);
    const applied = await action('auto', rid(50), { ...base, roomName: 'cả toà', jobType: 'giặt', content: 'giặt rèm tầng thượng', deadline: day });
    assert.equal(applied.kind, 'applied', JSON.stringify(applied));
    const job = (await jobs()).find(row => row.title === 'giặt rèm tầng thượng');
    assert.equal(job.local_deadline, `${day} 23:59:59.999`);
    const instant = (await db.query("SELECT to_char(deadline AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS') u FROM public.jobs WHERE id=$1", [job.id])).rows[0].u;
    assert.equal(instant, `${day}T16:59:59.999`, 'đúng thời điểm UTC của 23:59:59.999 +07');
    assert.equal(applied.result.deadlineDefaulted, false);
    const [y, m, d] = day.split('-');
    assert.match(applied.result.text, new RegExp(`hết (thứ \\S+|Chủ nhật) ${d}/${m}/${y} \\(còn 3 ngày\\)`));
  });

  await t.test('CVDM1 "giao … cho mình" with an invented jobType: type inferred AND the ambiguous assignee branch ⇒ preview (item 3)', async () => {
    const withMinh = await preview(60, { jobType: 'sửa chữa', content: 'Sửa khoá cửa', assigneeName: 'mình' });
    assert.deepEqual(typeOf(withMinh), ['preview', 'sửa', true]);
    assert.ok(withMinh.warnings.some(w => w.startsWith("Hiểu 'mình' là người nhận Nguyễn Văn Minh")), JSON.stringify(withMinh.warnings));
    await db.query("UPDATE public.organization_memberships SET status='SUSPENDED' WHERE user_id=$1", [MINH]);
    const self = await action('auto', rid(61), { ...base, jobType: 'sửa chữa', content: 'Sửa khoá cửa', assigneeName: 'mình' });
    assert.equal(self.kind, 'preview', 'không ai tên Minh ⇒ hiểu là chính mình nhưng vẫn xem trước');
    assert.equal(self.preview.assigneeSelf, true);
    assert.ok(self.warnings.includes("Hiểu 'mình' là chính anh/chị; nếu là người khác, nêu đủ tên người đó."));
    await db.query("UPDATE public.organization_memberships SET status='ACTIVE' WHERE user_id=$1", [MINH]);
  });

  await t.test('a single visible type that the content does not mention is still asked about, never picked by elimination', async () => {
    await db.query('UPDATE public.job_types SET is_active=(id=$1) WHERE organization_id=$2', [TYPE_SUA, ORG]);
    const only = await preview(65, { content: 'Mũ bảo hiểm cho khách' });
    assert.deepEqual([only.kind, only.why, only.candidates.map(c => c.name)], ['needs_input', 'unspecified', ['sửa']], JSON.stringify(only));
  });

  await t.test('no visible type at all: keep the name resolver outcome (no suggestions); the asker is unchanged', async () => {
    await db.query('UPDATE public.job_types SET is_active=false WHERE organization_id=$1', [ORG]);
    const named = await preview(70, { jobType: 'Bảo trì', content: 'Bảo trì máy bơm' });
    assert.equal(named.kind, 'needs_input');
    assert.deepEqual([named.field, named.wanted, named.candidates ?? []], ['jobType', 'Bảo trì', []], JSON.stringify(named));
    const unnamed = await preview(71, { content: 'Bảo trì máy bơm' });
    assert.deepEqual([unnamed.kind, unnamed.why, unnamed.candidates], ['needs_input', 'unspecified', []]);
    assert.equal((await db.query('SELECT count(*)::int n FROM public.jobs WHERE user_id=$1', [USER])).rows[0].n, 3);
  });
});
