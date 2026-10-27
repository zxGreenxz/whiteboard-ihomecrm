import test from 'node:test';
import assert from 'node:assert/strict';
import { expenseSetup, RULES, EDIT, APPROVE, FIXES, FLOW, ROUND1, INCOME15, BUILDING16, CASHBOOK19, WATER, IMAGE, VIRTUAL, rid, uid, code, PCCC, SYSTEM, CB2, STRANGER, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, CASHBOOK, FOREIGN_CASHBOOK, CATEGORY, ORG, USER } from './expense-write-fixture.mjs';
import { ACTION_REASON_CODES } from './action-reasons.mjs';

// RPC trang Thu chi (Đợt 2 Mốc 2, THU-CHI-THAO-TAC-GHI.md mục 3) trên PGlite với fixture Hermes của thu chi (binding/phiên/chính
// sách thật của các migration Hermes; quyền CRM giả qua fixture_acl). Hàm ghi web ở đây là BẢN PORT (cùng chữ ký, cùng câu lỗi,
// có dòng hạng mục, bộ đếm mã, quyết định bộ máy chi, thông báo, cam kết) — nó chứng minh logic của bước ghi Hermes (chạy thử
// không để lại dấu vết, lô cả-hoặc-không, basis, lý do, phạm vi), KHÔNG chứng minh hàm ghi thật: phần đó đo ở tầng 2 trên TEST.

test('hermes_expense_write_v1: chạy thử không để lại dấu vết, lô cả-hoặc-không, basis, lý do, phạm vi, ghi chú', { timeout: 240000 }, async t => {
  const f = await expenseSetup(t);
  const { db, run } = f;
  const trace = async () => (await db.query(`SELECT (SELECT count(*)::int FROM public.income_expenses) vouchers,(SELECT count(*)::int FROM public.income_expense_items) items,
    (SELECT count(*)::int FROM app_private.spend_decisions) decisions,(SELECT count(*)::int FROM public.notifications) notifications,
    (SELECT COALESCE(max(last_value),0)::int FROM public.fixture_code_counter) counter,(SELECT count(*)::int FROM app_private.hermes_action_receipts) receipts,
    (SELECT count(*)::int FROM public.fixture_canonical_ops) ops`)).rows[0];
  const item = (extra = {}) => ({ buildingName: 'toa a', roomName: 'P101', amount: 350000, content: 'mua vòi nước', category: 'sửa chữa', payee: 'anh thợ', ...extra });
  const applyWith = (requestId, params, preview) => run('expense.create', 'apply', requestId, params, { resolved: preview.resolved, basis: preview.basis });

  await t.test('xem trước = chạy thử hàm ghi rồi lùi: nói đúng "vào sổ ngay", không để lại phiếu, dòng, quyết định, thông báo, mã, biên nhận', async () => {
    const before = await trace();
    const preview = await run('expense.create', 'preview', rid(1), { items: [item()] });
    assert.equal(preview.kind, 'preview'); assert.equal(preview.confirm, 'required');
    assert.match(preview.preview.items[0].willBe, /^VÀO SỔ NGAY khi ghi \(dưới ngưỡng tự duyệt 600\.000đ\) — trừ sổ /);
    assert.deepEqual([preview.preview.items[0].building, preview.preview.items[0].room, preview.preview.items[0].category, preview.preview.items[0].amount],
      ['Toà A', 'P101', 'Sửa chữa', '350.000đ']);
    assert.equal(preview.preview.summary, 'Ghi 1 phiếu chi, tổng 350.000đ.');
    assert.deepEqual(preview.resolved.items[0].buildingId, BUILDING);
    assert.deepEqual(await trace(), before, 'chạy thử không để lại gì, kể cả bộ đếm mã phiếu');
    // Lượt 2: ghi đúng bản đã xem; phát lại cùng requestId.
    const applied = await applyWith(rid(1), { items: [item()] }, preview);
    assert.equal(applied.kind, 'applied');
    const voucher = applied.result.vouchers[0];
    assert.deepEqual([voucher.code, voucher.approvalStatus, voucher.postingStatus, voucher.amountText], ['PC2610001', 'APPROVED', 'POSTED', '350.000đ']);
    assert.match(applied.link, /^\/income-expense\/voucher\/[0-9a-f-]{36}$/);
    const after = await trace();
    assert.deepEqual([after.vouchers - before.vouchers, after.receipts - before.receipts, after.counter], [1, 1, 1], 'mã đầu tiên là 001: lần chạy thử không làm nhảy số');
    assert.deepEqual(await applyWith(rid(1), { items: [item()] }, preview), applied, 'phát lại y nguyên');
    assert.equal((await trace()).vouchers, after.vouchers);
  });

  await t.test('lô 2 khoản: một lần đồng ý; khoản vượt ngưỡng nói "chờ duyệt vì …"; trùng trong lô và trùng phiếu đã có được cảnh báo', async () => {
    const params = { items: [item({ amount: 1200000, content: 'sửa máy lạnh' }), item({ amount: 350000 })] };
    const preview = await run('expense.create', 'preview', rid(2), params);
    assert.match(preview.preview.items[0].willBe, /^CHỜ DUYỆT: từ ngưỡng tự duyệt 600\.000đ trở lên/);
    assert.match(preview.preview.items[1].willBe, /^VÀO SỔ NGAY/);
    assert.ok(preview.warnings.some(w => /^Khoản 2: đã có phiếu PC2610001 ngày .* — CÙNG SỐ TIỀN, có thể ghi trùng$/.test(w)), preview.warnings.join('\n'));
    assert.ok(preview.warnings.some(w => /^Khoản 2: trùng toà, hạng mục, kỳ với một khoản khác trong lần ghi này$/.test(w)), preview.warnings.join('\n'));
    const before = await trace();
    const applied = await applyWith(rid(2), params, preview);
    assert.deepEqual(applied.result.vouchers.map(v => [v.code, v.approvalStatus]), [['PC2610002', 'UNAPPROVED'], ['PC2610003', 'APPROVED']]);
    assert.equal(applied.link, '/income-expense');
    assert.equal((await trace()).notifications - before.notifications, 1, 'thông báo người duyệt cho phiếu chờ');
  });

  await t.test('TC3: lệch bản đã xem hay một khoản lỗi ở lượt 2 ⇒ lùi cả lô và biên nhận, state_changed', async () => {
    const params = { items: [item({ content: 'khoản một' }), item({ content: 'khoản hai', amount: 450000 })] };
    const preview = await run('expense.create', 'preview', rid(3), params);
    // Ngưỡng đổi giữa hai lượt ⇒ khoản hai thành chờ duyệt ⇒ basis lệch.
    await db.query("UPDATE app_private.ie_auto_approve_config SET threshold=400000");
    const before = await trace();
    assert.deepEqual(await applyWith(rid(3), params, preview), { kind: 'rejected', reason: 'state_changed' });
    assert.deepEqual(await trace(), before, 'không phiếu, không biên nhận, không nhảy mã');
    await db.query("UPDATE app_private.ie_auto_approve_config SET threshold=600000");
    // Hàm ghi từ chối khoản hai ở lượt 2 (sau khi lượt 1 chạy thử qua) ⇒ khoản một cũng không được ghi.
    const fresh = await run('expense.create', 'preview', rid(4), params);
    await db.query("UPDATE public.fixture_writer SET rejected_message='[PROFIT_LOCKED] tháng đã chốt',reject_name='khoản hai'");
    assert.deepEqual(await applyWith(rid(4), params, fresh), { kind: 'rejected', reason: 'state_changed' });
    assert.deepEqual(await trace(), before);
    // Xem trước lại thấy đúng lý do từ chối (chạy thử bắt sớm) — và khoản số mấy (Mốc 4, review).
    assert.deepEqual(await run('expense.create', 'preview', rid(5), params), { kind: 'rejected', reason: 'period_locked', item: 2 });
    await db.query("UPDATE public.fixture_writer SET rejected_message=NULL,reject_name=NULL,reject_state=NULL");
  });

  await t.test('lỗi hàm ghi ở lượt 1 ⇒ lý do đóng của trang; lỗi tạm không bị nuốt', async () => {
    for (const [message, state, reason] of [['[NOT_MANUAL] Phiếu do hệ thống sinh (x) — xử lý ở luồng nguồn.', '42501', 'system_voucher'],
      ['Hạng mục "X" chỉ được sinh từ hệ thống (hợp đồng/cọc/thanh lý/hoa hồng), không tạo tay từ màn Thu/Chi', '0A000', 'system_voucher'],
      ['Sổ quỹ đã khoá tại ngày phiếu', 'P0001', 'period_locked'], ['Quyền sử dụng sổ quỹ đã bị thu hồi', '42501', 'cashbook_not_held'],
      ['Không có quyền tạo phiếu thu/chi cho toà này', '42501', 'not_allowed'], ['lỗi lạ', 'XX000', 'crm_refused']]) {
      await db.query('UPDATE public.fixture_writer SET rejected_message=$1,reject_state=$2', [message, state]);
      const got = await run('expense.create', 'preview', rid(6), { items: [item()] });
      assert.deepEqual(got, { kind: 'rejected', reason }, message);
      assert.ok(ACTION_REASON_CODES.includes(reason));
    }
    await db.query("UPDATE public.fixture_writer SET rejected_message='canceling statement due to lock timeout',reject_state='55P03'");
    await assert.rejects(run('expense.create', 'preview', rid(7), { items: [item()] }), code('55P03'));
    await db.query("UPDATE public.fixture_writer SET rejected_message=NULL,reject_state=NULL");
    const mapped = async (sqlstate, message) => (await db.query('SELECT app_private.hermes_expense_reason_v1($1,$2) r', [sqlstate, message])).rows[0].r;
    for (const [sqlstate, message, expected] of [['55000', 'finance_v2_post_manual_voucher: at least one FINALIZED evidence is required', 'evidence_required'],
      ['42501', 'approve_and_post_income_expense_v2: no CUSTODIAN possession of cashbook x', 'cashbook_not_held'],
      ['55000', 'approve_income_expense_v2: voucher not in an approvable state (APPROVED, x)', 'not_pending'], ['P0002', 'Phiếu không tồn tại', 'not_found'],
      ['P0001', 'Ngày phiếu phải nằm trong khoảng 2000-01-01 đến 2100-12-31', 'date_out_of_range'], ['55000', '[STRICT_MODE] chặn', 'strict_mode'],
      ['P0001', '[HANDOVER_LOCKED] Phiếu nằm trong phiên bàn giao', 'period_locked'], ['22023', 'Phải ghi lý do huỷ (ít nhất 8 ký tự)', 'reason_required'],
      ['54000', 'Số tiền vượt cap canary cho một phiếu', 'amount_out_of_range'], ['55000', 'Đã hết số lượt canary', 'quota_exceeded']])
      assert.equal(await mapped(sqlstate, message), expected, message);
  });

  await t.test('giải tên: hạng mục tự chọn khi khoá cứng; mơ hồ/không chắc ⇒ needs_input có ứng viên; sổ; phạm vi toà', async () => {
    const auto = await run('expense.create', 'preview', rid(8), { items: [item({ category: undefined, content: 'in phương án pccc' })] });
    assert.deepEqual([auto.preview.items[0].category, auto.preview.items[0].categoryAuto], ['PCCC', 'tự chọn theo nội dung — sửa nếu sai']);
    // Gợi ý KHÔNG khoá cứng (trùng chữ tên "sửa") ⇒ không tự nhận; hỏi lại, gợi ý đứng đầu ứng viên.
    const weak = await run('expense.create', 'preview', rid(17), { items: [item({ category: undefined, content: 'sửa vòi' })] });
    assert.deepEqual([weak.kind, weak.field, weak.candidates[0]?.name], ['needs_input', 'category', 'Sửa chữa']);
    // Lượt 11 (nghiệm thu): chưa nêu hạng mục mà nội dung không trùng hạng mục nào ⇒ why unspecified, KHÔNG nêu ứng viên (trước đây nêu 8 hạng
    // mục đầu bảng — tiền nhà, điện, nước… — không liên quan).
    const vague = await run('expense.create', 'preview', rid(9), { items: [item({ category: undefined, content: 'đồ lặt vặt' })] });
    assert.deepEqual([vague.kind, vague.field, vague.why, vague.wanted, vague.candidates], ['needs_input', 'category', 'unspecified', '', []]);
    // Lượt 13 (nghiệm thu): hoa hồng là luồng hệ thống ⇒ web_only + link màn gốc (trước đây hỏi lại not_visible). Tên không có ⇒ vẫn hỏi lại.
    assert.deepEqual(await run('expense.create', 'preview', rid(10), { items: [item({ category: 'hoa hồng' })] }),
      { kind: 'rejected', reason: 'web_only', link: '/contracts' });
    assert.deepEqual(await run('expense.create', 'preview', rid(19), { items: [item({ category: 'zzz' })] }),
      { kind: 'needs_input', reason: 'name_unresolved', field: 'category', wanted: 'zzz', why: 'not_visible', candidates: [], more: false });
    assert.deepEqual(await run('expense.create', 'preview', rid(11), { items: [item({ buildingName: 'Toà B' })] }),
      { kind: 'needs_input', reason: 'name_unresolved', field: 'building', wanted: 'Toà B', why: 'outside_scope', candidates: [], more: false });
    assert.deepEqual(await run('expense.create', 'preview', rid(12), { items: [item({ cashbook: 'quỹ người khác' })] }), { kind: 'rejected', reason: 'cashbook_not_held' });
    const named = await run('expense.create', 'preview', rid(13), { items: [item({ cashbook: 'tiền mặt' })] });
    assert.equal(named.preview.items[0].cashbook, 'Tiền mặt toà A');
    const defaulted = await run('expense.create', 'preview', rid(14), { items: [item()] });
    assert.equal(defaulted.resolved.items[0].cashbookId, CB2, 'sổ gắn toà thắng sổ dùng lần trước');
    // Kỳ của khoản cam kết + hạng mục bắt buộc duyệt (Q12).
    await db.query("INSERT INTO public.fixture_commitments VALUES($1,'nuoc','2026-10-01',3000000)", [BUILDING]);
    const water = await run('expense.create', 'preview', rid(15), { items: [item({ category: 'đóng tiền nước', content: 'tiền nước tháng 10', amount: 3200000, period: '2026-10', roomName: undefined })] });
    assert.match(water.preview.items[0].willBe, /^CHỜ DUYỆT: vượt cam kết chi còn lại của kỳ/);
    assert.ok(water.warnings.some(w => w === 'Khoản 1: cam kết "Đóng tiền nước" tháng 10/2026 là 3.000.000đ, còn 3.000.000đ trước khoản này — khoản này VƯỢT phần còn lại'), water.warnings.join('\n'));
    assert.equal(water.preview.items[0].period, 'tháng 10/2026');
    // Lượt 11 (Q12, nghiệm thu): câu cam kết NGAY trong khoản và trong tóm tắt — cam kết, đã chi/giữ, còn, vượt bao nhiêu.
    const commitment = 'Cam kết "Đóng tiền nước" tháng 10/2026: 3.000.000đ; đã chi/giữ 0đ; còn 3.000.000đ trước khoản này — khoản này VƯỢT phần còn lại 200.000đ';
    assert.equal(water.preview.items[0].commitment, commitment);
    assert.equal(water.preview.summary, `Ghi 1 phiếu chi, tổng 3.200.000đ. Khoản 1: ${commitment}.`);
    // Không có cam kết của kỳ ⇒ vẫn nói rõ, không im lặng.
    const none = await run('expense.create', 'preview', rid(18), { items: [item({ category: 'đóng tiền nước', content: 'tiền nước tháng 9', amount: 300000, period: '2026-09', roomName: undefined })] });
    assert.equal(none.preview.items[0].commitment, 'Chưa có cam kết chi "Đóng tiền nước" tháng 09/2026 ở toà này');
    assert.equal(defaulted.preview.items[0].commitment, undefined, 'hạng mục không gắn phí cam kết ⇒ không có câu cam kết');
  });

  await t.test('lượt 2 đưa bản đã giải ngoài phạm vi ⇒ not_allowed, không mở biên nhận', async () => {
    const preview = await run('expense.create', 'preview', rid(16), { items: [item()] });
    const before = await trace();
    const strip = ({ roomId, roomName, ...rest }) => rest; // eslint-disable-line no-unused-vars
    for (const forged of [strip({ ...preview.resolved.items[0], buildingId: OTHER_BUILDING }), { ...preview.resolved.items[0], roomId: OTHER_ROOM },
      { ...preview.resolved.items[0], typeId: SYSTEM }])
      assert.deepEqual(await run('expense.create', 'apply', rid(16), { items: [item()] }, { resolved: { items: [forged] }, basis: preview.basis }),
        { kind: 'rejected', reason: 'not_allowed' }, JSON.stringify(forged));
    assert.deepEqual(await run('expense.create', 'apply', rid(16), { items: [item()] }, { resolved: { items: [{ ...preview.resolved.items[0], cashbookId: FOREIGN_CASHBOOK }] }, basis: preview.basis }),
      { kind: 'rejected', reason: 'cashbook_not_held' });
    assert.deepEqual(await trace(), before);
    await assert.rejects(run('expense.create', 'apply', rid(16), { items: [item()] }, { resolved: preview.resolved, basis: null }), code('22023'));
  });

  await t.test('expense.note: ghi thẳng (chính sách never), phát lại, lỗi cuối được chốt; mã phiếu ngoài phạm vi / không thấy ⇒ hỏi lại', async () => {
    const noted = await run('expense.note', 'auto', rid(20), { voucherCode: 'pc2610001', note: 'đã lấy hoá đơn đỏ' });
    assert.deepEqual([noted.kind, noted.result], ['applied', { code: 'PC2610001', noted: true }]);
    assert.deepEqual(await run('expense.note', 'auto', rid(20), { voucherCode: 'pc2610001', note: 'đã lấy hoá đơn đỏ' }), noted);
    assert.equal((await db.query("SELECT count(*)::int n FROM public.fixture_supplements")).rows[0].n, 1);
    assert.deepEqual(await run('expense.note', 'auto', rid(21), { voucherCode: 'PC9999999', note: 'x' }),
      { kind: 'needs_input', reason: 'name_unresolved', field: 'voucher', wanted: 'PC9999999', why: 'not_visible', candidates: [], more: false });
    await db.query("INSERT INTO public.income_expenses(organization_id,user_id,code,type,name,building_id,voucher_date) VALUES($1,$2,'PC2610999','EXPENSE','toà B',$3,'2026-10-01')", [ORG, USER, OTHER_BUILDING]);
    assert.equal((await run('expense.note', 'auto', rid(22), { voucherCode: 'PC2610999', note: 'x' })).why, 'outside_scope');
    // Phiếu của người khác: hàm bổ sung từ chối 42501 ⇒ lý do cuối, chốt và phát lại.
    await db.query("UPDATE public.income_expenses SET user_id=$1 WHERE code='PC2610003'", [STRANGER]);
    assert.deepEqual(await run('expense.note', 'auto', rid(23), { voucherCode: 'PC2610003', note: 'x' }), { kind: 'rejected', reason: 'not_allowed' });
    assert.deepEqual((await db.query('SELECT state,sqlstate FROM app_private.hermes_action_receipts WHERE request_id=$1', [rid(23)])).rows, [{ state: 'rejected', sqlstate: '42501' }]);
    // Chính sách siết thành always ⇒ ghi chú cũng xem trước.
    await db.query("UPDATE app_private.hermes_action_policies SET confirm='always' WHERE action='expense.note'");
    const strict = await run('expense.note', 'auto', rid(24), { voucherCode: 'PC2610001', note: 'ghi thêm' });
    assert.deepEqual([strict.kind, strict.confirm, strict.preview.summary], ['preview', 'required', 'Ghi chú vào phiếu PC2610001: "ghi thêm"']);
    await db.query("UPDATE app_private.hermes_action_policies SET confirm='never' WHERE action='expense.note'");
  });

  await t.test('Mốc 3: phạm vi = guard ∩ hàm kiểm quyền của hàm ghi web — không bao giờ xem trước "được" rồi ghi "không được"; toà ảo; ghi chú chạy thử', async () => {
    // Overlay của kết nối thành Toàn tổ chức ⇒ guard (v3: fixture_acl toà A + B) cho cả toà B; hàm ghi web (staff_assignments) chỉ toà A.
    await f.rollbackCase(async () => {
      await db.query("UPDATE public.authorization_scopes SET scope_type='ORGANIZATION',building_id=NULL WHERE organization_id=$1 AND scope_type='BUILDING'", [ORG]);
      const before = await trace();
      // Trước Mốc 3: tên giải được, chạy thử 42501 ⇒ rejected not_allowed ở bản xem trước. Nay: toà B ngoài phạm vi ngay khi giải tên.
      assert.deepEqual(await run('expense.create', 'preview', rid(40), { items: [item({ buildingName: 'Toà B', roomName: undefined })] }),
        { kind: 'needs_input', reason: 'name_unresolved', field: 'building', wanted: 'Toà B', why: 'outside_scope', candidates: [], more: false });
      const ok = await run('expense.create', 'preview', rid(41), { items: [item()] });
      assert.equal(ok.kind, 'preview', 'toà A: cả guard lẫn hàm ghi cho');
      // Lượt 2 đưa bản đã giải sang toà B (guard cho, hàm ghi không) ⇒ not_allowed TRƯỚC biên nhận, không chạy hàm ghi.
      const { roomId, roomName, ...toB } = ok.resolved.items[0]; // eslint-disable-line no-unused-vars
      assert.deepEqual(await run('expense.create', 'apply', rid(41), { items: [item()] }, { resolved: { items: [{ ...toB, buildingId: OTHER_BUILDING }] }, basis: ok.basis }),
        { kind: 'rejected', reason: 'not_allowed' });
      // Ngược lại: hàm ghi cho toà B (phân công) nhưng v3 của khoá không có ⇒ ngoài phạm vi ở CẢ hai lượt (cùng một tập toà).
      await db.query("INSERT INTO public.fixture_staff_assignments VALUES($1,$2)", [USER, OTHER_BUILDING]);
      await db.query("UPDATE public.fixture_acl SET building_ids=$1 WHERE permission='income_expenses.create'", [[BUILDING]]);
      assert.equal((await run('expense.create', 'preview', rid(42), { items: [item({ buildingName: 'Toà B', roomName: undefined })] })).why, 'outside_scope');
      assert.deepEqual(await trace(), before, 'không phiếu, không biên nhận');
    });
    // Chủ có role_bindings nhưng KHÔNG có staff_assignments (tài khoản TEST 068a3985…, 22/10): hàm ghi web từ chối mọi toà ⇒ mọi toà ngoài
    // phạm vi ngay ở bản xem trước, không bao giờ "xem trước được".
    await f.rollbackCase(async () => {
      await db.query('DELETE FROM public.fixture_staff_assignments WHERE user_id=$1', [USER]);
      assert.equal((await run('expense.create', 'preview', rid(43), { items: [item()] })).why, 'outside_scope');
      assert.deepEqual(await run('expense.create', 'preview', rid(44), { items: [item({ buildingName: 'nhà không có' })] }),
        { kind: 'needs_input', reason: 'name_unresolved', field: 'building', wanted: 'nhà không có', why: 'not_visible', candidates: [], more: false });
    });
    // Toà ảo (chi phí chung): web Thu chi ghi được ⇒ Hermes giải được tên và lập được phiếu ở đó.
    await f.rollbackCase(async () => {
      await db.query("INSERT INTO public.buildings VALUES($1,$2,'Kho Văn Phòng Chung',true,null)", [VIRTUAL, ORG]);
      await db.query("INSERT INTO public.fixture_building_access VALUES($1)", [VIRTUAL]);
      await db.query("INSERT INTO public.fixture_staff_assignments VALUES($1,$2)", [USER, VIRTUAL]);
      for (const permission of ['income_expenses.create', 'buildings.view'])
        await db.query("UPDATE public.fixture_acl SET building_ids=building_ids||$1::uuid WHERE permission=$2", [VIRTUAL, permission]);
      await db.query("UPDATE public.authorization_scopes SET scope_type='ORGANIZATION',building_id=NULL WHERE organization_id=$1 AND scope_type='BUILDING'", [ORG]);
      const params = { items: [item({ buildingName: 'kho van phong chung', roomName: undefined, content: 'văn phòng phẩm' })] };
      const preview = await run('expense.create', 'preview', rid(45), params);
      assert.deepEqual([preview.kind, preview.resolved.items[0].buildingId, preview.preview.items[0].building], ['preview', VIRTUAL, 'Kho Văn Phòng Chung']);
      const applied = await applyWith(rid(45), params, preview);
      assert.deepEqual([applied.kind, applied.result.vouchers[0].building], ['applied', 'Kho Văn Phòng Chung']);
    });
    // Ghi chú khi phải xem trước (chính sách always): CHẠY THỬ hàm bổ sung — phiếu người khác ⇒ từ chối ngay ở bản xem trước (trước Mốc 3:
    // xem trước "được" rồi ghi 42501); phiếu của mình ⇒ xem trước, không để lại dòng bổ sung nào.
    await f.rollbackCase(async () => {
      await db.query("UPDATE app_private.hermes_action_policies SET confirm='always' WHERE action='expense.note'");
      assert.deepEqual(await run('expense.note', 'preview', rid(46), { voucherCode: 'PC2610003', note: 'x' }), { kind: 'rejected', reason: 'not_allowed' });
      const supplements = async () => (await db.query('SELECT count(*)::int n FROM public.fixture_supplements')).rows[0].n;
      const count = await supplements();
      assert.equal((await run('expense.note', 'preview', rid(47), { voucherCode: 'PC2610001', note: 'thêm' })).kind, 'preview');
      assert.equal(await supplements(), count, 'chạy thử không để lại dòng bổ sung');
    });
  });

  await t.test('Mốc 3b (review): phát lại TRƯỚC kiểm phạm vi/hạng mục/sổ — ghi xong rồi mất quyền sổ và phân công, cùng requestId vẫn ra đúng kết quả đã chốt', async () => {
    const params = { items: [item({ content: 'phát lại sau thu hồi' })] };
    const preview = await run('expense.create', 'preview', rid(50), params);
    const applied = await applyWith(rid(50), params, preview);
    assert.equal(applied.kind, 'applied');
    await f.rollbackCase(async () => {
      await db.query('UPDATE public.accounts SET user_id=$1 WHERE id=$2', [STRANGER, preview.resolved.items[0].cashbookId]);
      await db.query('DELETE FROM public.fixture_staff_assignments WHERE user_id=$1', [USER]);
      assert.deepEqual(await applyWith(rid(50), params, preview), applied, 'phát lại = kết quả đã chốt, không phải cashbook_not_held / not_allowed');
      const before = await trace();
      assert.deepEqual(await applyWith(rid(51), params, preview), { kind: 'rejected', reason: 'not_allowed' }, 'requestId mới vẫn qua đủ kiểm');
      assert.deepEqual(await trace(), before, 'requestId mới bị chặn không mở biên nhận');
      assert.deepEqual(await applyWith(rid(50), { items: [item({ content: 'nội dung khác' })] }, preview), { kind: 'rejected', reason: 'request_conflict' });
    });
  });

  // ---- Mốc 4: sửa / huỷ phiếu CHI lập tay, cờ TC5, khoản số mấy, hạng mục dòng tiền. Mỗi ca chạy trong BEGIN … ROLLBACK.
  const TODAY = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10), vn = iso => iso.split('-').reverse().join('/');
  const MONEY_FLOW = '00000000-0000-4000-8000-000000000605';
  const voucher = async (code, extra = {}) => {
    const v = { type: 'EXPENSE', name: 'mua bóng đèn', amount: 400000, status: 'UNAPPROVED', posting: 'UNPOSTED', account: CASHBOOK, user: USER, date: TODAY, ...extra };
    const id = (await db.query(`INSERT INTO public.income_expenses(organization_id,user_id,code,type,name,building_id,room_id,account_id,voucher_date,total_amount,
        approval_status,posting_status,payer_name,system_source,salary_staff_id,repeat_parent_id,repeat_cycle,attachments,posting_mode,creator_name)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`, [ORG, v.user, code, v.type, v.name, v.building ?? BUILDING, v.room ?? null,
      v.account, v.date, v.amount, v.status, v.posting, v.payee ?? null, v.system ?? null, v.salary ?? null, v.parent ?? null, v.cycle ?? 'NONE',
      JSON.stringify(v.images ?? []), v.mode ?? 'CASHBOOK', v.maker ?? null])).rows[0].id;
    for (const amount of v.lines ?? [v.amount])
      await db.query('INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,amount,start_date,end_date) VALUES($1,$2,$3,$4,$4)', [id, v.typeId ?? CATEGORY, amount, v.date]);
    return id;
  };
  const row = async id => (await db.query(`SELECT ie.name,ie.payer_name,ie.voucher_date::text,ie.account_id,ie.room_id,ie.total_amount::bigint::text total,ie.approval_status,
    ie.posting_status,ie.approval_version::int,(SELECT jsonb_agg(jsonb_build_array(it.income_expense_type_id,it.unit_price::bigint::text,it.start_date::text) ORDER BY it.created_at)
      FROM public.income_expense_items it WHERE it.income_expense_id=ie.id) items FROM public.income_expenses ie WHERE ie.id=$1`, [id])).rows[0];
  const trace4 = async () => (await db.query(`SELECT (SELECT count(*)::int FROM public.fixture_revisions) revisions,(SELECT count(*)::int FROM public.fixture_postings) postings,
    (SELECT count(*)::int FROM public.fixture_cancellations) cancellations,(SELECT count(*)::int FROM app_private.hermes_action_receipts) receipts,
    (SELECT count(*)::int FROM public.income_expense_items) items,(SELECT md5(string_agg(ie::text,'|' ORDER BY ie.id)) FROM public.income_expenses ie) vouchers`)).rows[0];
  const step = (action, requestId, params, preview) => run(action, 'apply', requestId, params, { resolved: preview.resolved, basis: preview.basis });

  await t.test('Mốc 4 expense.edit: chạy thử revise rồi lùi; đổi tiền phải có lý do; trước → sau; lượt 2 ghi + phát lại; lệch phiên bản ⇒ state_changed', async () => {
    await f.rollbackCase(async () => {
      const id = await voucher('PC2610501', { amount: 1200000 });
      const before = await trace4();
      assert.deepEqual(await run('expense.edit', 'preview', rid(60), { voucherCode: 'pc2610501', amount: 1150000 }), { kind: 'rejected', reason: 'reason_required' });
      const params = { voucherCode: 'pc2610501', amount: 1150000, payee: 'cửa hàng điện', reason: 'ghi nhầm số tiền' };
      const preview = await run('expense.edit', 'preview', rid(61), params);
      assert.deepEqual([preview.kind, preview.confirm, preview.preview.summary, preview.preview.willBe], ['preview', 'required',
        'Sửa phiếu PC2610501 (chờ duyệt): số tiền 1.200.000đ → 1.150.000đ; người nhận (trống) → cửa hàng điện. Lý do: ghi nhầm số tiền.',
        'Sau khi sửa phiếu vẫn CHỜ DUYỆT; lần sửa ghi vào lịch sử phiếu']);
      assert.ok(!JSON.stringify(preview.preview).match(/[0-9a-f]{8}-[0-9a-f]{4}-/), 'bản xem trước không có UUID');
      assert.deepEqual(await trace4(), before, 'chạy thử không để lại lần sửa, không đổi phiếu, không biên nhận');
      const applied = await step('expense.edit', rid(61), params, preview);
      assert.deepEqual([applied.kind, applied.result.code, applied.result.statusText, applied.link], ['applied', 'PC2610501', 'Đã sửa; phiếu vẫn chờ duyệt', `/income-expense/voucher/${id}`]);
      const after = await row(id);
      assert.deepEqual([after.total, after.payer_name, after.approval_status, after.approval_version, after.items[0][1]], ['1150000', 'cửa hàng điện', 'UNAPPROVED', 2, '1150000']);
      assert.deepEqual((await db.query('SELECT reason,changed FROM public.fixture_revisions WHERE voucher_id=$1', [id])).rows, [{ reason: 'ghi nhầm số tiền', changed: ['payer_name', 'items'] }]);
      assert.deepEqual(await step('expense.edit', rid(61), params, preview), applied, 'phát lại y nguyên');
      assert.equal((await trace4()).revisions, before.revisions + 1);
      // Phiếu bị sửa sau bản xem trước (phiên bản tăng) ⇒ state_changed: không biên nhận, không sửa.
      const next = { voucherCode: 'PC2610501', content: 'mua bóng đèn LED' };
      const stale = await run('expense.edit', 'preview', rid(62), next);
      await db.query('UPDATE public.income_expenses SET approval_version=approval_version+1 WHERE id=$1', [id]);
      const frozen = await trace4();
      assert.deepEqual(await step('expense.edit', rid(62), next, stale), { kind: 'rejected', reason: 'state_changed' });
      assert.deepEqual(await trace4(), frozen);
      // Mốc 4b (review): hàm web từ chối ở lượt 2 vì lý do KHÁC dữ liệu đổi ⇒ chốt rejected với lý do thật + SQLSTATE trong biên nhận (có
      // dấu vết, phát lại y nguyên); không sửa gì. Chỉ CAS phiên bản (PT409/40001) mới là state_changed không chốt.
      const receipt = async requestId => (await db.query('SELECT state,sqlstate FROM app_private.hermes_action_receipts WHERE request_id=$1', [requestId])).rows;
      for (const [n, message, state, reason] of [[63, '[PROFIT_LOCKED] tháng đã chốt', 'P0001', 'period_locked'],
        [64, 'column "x" does not exist', '42703', 'crm_refused']]) {
        const fresh = await run('expense.edit', 'preview', rid(n), next);
        await db.query("UPDATE public.fixture_writer SET rejected_message=$1,reject_state=$2,reject_name='revise'", [message, state]);
        const final = await step('expense.edit', rid(n), next, fresh);
        assert.deepEqual(final, { kind: 'rejected', reason }, message);
        assert.deepEqual(await receipt(rid(n)), [{ state: 'rejected', sqlstate: state }]);
        assert.deepEqual(await step('expense.edit', rid(n), next, fresh), final, 'phát lại y nguyên');
        await db.query('UPDATE public.fixture_writer SET rejected_message=NULL,reject_state=NULL,reject_name=NULL');
      }
      assert.equal((await row(id)).name, 'mua bóng đèn', 'không sửa gì');
      // CAS của hàm web (PT409) ở lượt 2 ⇒ state_changed, không chốt biên nhận.
      const cas = await run('expense.edit', 'preview', rid(65), next);
      await db.query("UPDATE public.fixture_writer SET rejected_message='Phiếu vừa được người khác sửa — tải lại để xem thay đổi.',reject_state='PT409',reject_name='revise'");
      assert.deepEqual(await step('expense.edit', rid(65), next, cas), { kind: 'rejected', reason: 'state_changed' });
      assert.deepEqual(await receipt(rid(65)), []);
      await db.query('UPDATE public.fixture_writer SET rejected_message=NULL,reject_state=NULL,reject_name=NULL');
      // Mất quyền sau bản xem trước (phiếu thành của người khác, không có quyền sửa) ⇒ not_allowed, chốt 42501.
      const lost = await run('expense.edit', 'preview', rid(66), next);
      await db.query('UPDATE public.income_expenses SET user_id=$1 WHERE id=$2', [STRANGER, id]);
      assert.deepEqual(await step('expense.edit', rid(66), next, lost), { kind: 'rejected', reason: 'not_allowed' });
      assert.deepEqual(await receipt(rid(66)), [{ state: 'rejected', sqlstate: '42501' }]);
    });
  });

  await t.test('Mốc 4 expense.edit: hạng mục, sổ, ngày (kỳ một ngày đi theo), phòng; không đổi gì ⇒ hỏi lại; đã duyệt ⇒ not_pending; nhiều dòng ⇒ web; bản đã giải giả ⇒ not_allowed', async () => {
    await f.rollbackCase(async () => {
      const id = await voucher('PC2610502', { date: '2026-10-20' });
      const params = { voucherCode: 'PC2610502', category: 'pccc', cashbook: 'tiền mặt', voucherDate: TODAY, roomName: 'p101', reason: 'đổi hạng mục và sổ' };
      const preview = await run('expense.edit', 'preview', rid(65), params);
      assert.deepEqual(preview.preview.changes, [{ field: 'hạng mục', before: 'Sửa chữa', after: 'PCCC' },
        { field: 'ngày phiếu', before: '20/10/2026', after: vn(TODAY) }, { field: 'sổ quỹ', before: 'Quỹ VCB 0123456789', after: 'Tiền mặt toà A' },
        { field: 'phòng', before: '(không)', after: 'P101' }]);
      const applied = await step('expense.edit', rid(65), params, preview);
      assert.equal(applied.kind, 'applied');
      const after = await row(id);
      assert.deepEqual([after.voucher_date, after.account_id, after.room_id, after.items], [TODAY, CB2, ROOM, [[PCCC, '400000', TODAY]]],
        'kỳ một ngày trùng ngày phiếu cũ đi theo ngày mới');
      // Không có trường đổi / giá trị như cũ ⇒ hỏi lại (invalid_params); toà ngoài phạm vi khoá ⇒ hỏi lại.
      assert.deepEqual(await run('expense.edit', 'preview', rid(66), { voucherCode: 'PC2610502', reason: 'không đổi gì cả' }), { kind: 'rejected', reason: 'invalid_params' });
      assert.deepEqual(await run('expense.edit', 'preview', rid(67), { voucherCode: 'PC2610502', content: 'mua bóng đèn' }), { kind: 'rejected', reason: 'invalid_params' });
      assert.equal((await run('expense.edit', 'preview', rid(68), { voucherCode: 'PC2610502', buildingName: 'Toà B', reason: 'nhầm toà rồi' })).why, 'outside_scope');
      // Phiếu đã duyệt ⇒ not_pending kèm link trang phiếu (lượt 11: trước khi khoá / chạy thử); phiếu nhiều dòng hạng mục ⇒ đổi tiền làm trên
      // web, đổi nội dung vẫn được.
      const approved = await voucher('PC2610503', { status: 'APPROVED', posting: 'POSTED' });
      assert.deepEqual(await run('expense.edit', 'preview', rid(69), { voucherCode: 'PC2610503', content: 'x y z' }),
        { kind: 'rejected', reason: 'not_pending', link: `/income-expense/voucher/${approved}` });
      const multi = await voucher('PC2610504', { amount: 500000, lines: [300000, 200000] });
      assert.deepEqual(await run('expense.edit', 'preview', rid(70), { voucherCode: 'PC2610504', amount: 450000, reason: 'ghi nhầm số tiền' }), { kind: 'rejected', reason: 'web_only' });
      assert.equal((await run('expense.edit', 'preview', rid(71), { voucherCode: 'PC2610504', content: 'hai món' })).kind, 'preview');
      // Lượt 2 đưa bản đã giải giả (toà ngoài phạm vi, phòng toà khác, hạng mục không dùng được, sổ người khác) ⇒ từ chối trước biên nhận.
      // Lượt 13: hạng mục hệ thống "Hoa hồng môi giới" là luồng hệ thống ⇒ web_only + link trang phiếu (vẫn trước biên nhận).
      const p = await run('expense.edit', 'preview', rid(72), { voucherCode: 'PC2610504', content: 'hai món' });
      const elsewhere = await voucher('PC2610505', { building: OTHER_BUILDING });
      const frozen = await trace4();
      for (const [forged, expected] of [[{ voucherId: elsewhere }, 'not_allowed'], [{ newBuildingId: OTHER_BUILDING, newBuildingName: 'Toà B' }, 'not_allowed'], [{ roomId: OTHER_ROOM }, 'not_allowed'],
        [{ typeId: uid(699), typeName: 'x' }, 'not_allowed'],
        [{ typeId: SYSTEM, typeName: 'x' }, { kind: 'rejected', reason: 'web_only', link: `/income-expense/voucher/${multi}` }],
        [{ cashbookId: FOREIGN_CASHBOOK, cashbookName: 'x' }, 'cashbook_not_held']])
        assert.deepEqual(await run('expense.edit', 'apply', rid(72), { voucherCode: 'PC2610504', content: 'hai món' }, { resolved: { ...p.resolved, ...forged }, basis: p.basis }),
          typeof expected === 'string' ? { kind: 'rejected', reason: expected } : expected, JSON.stringify(forged));
      assert.deepEqual(await trace4(), frozen);
      // Mốc 4b (review): nêu đúng toà hiện tại (không nêu phòng) ⇒ không đổi toà, GIỮ phòng.
      const same = { voucherCode: 'PC2610502', buildingName: 'toà a', payee: 'thợ điện' };
      const kept = await run('expense.edit', 'preview', rid(73), same);
      assert.deepEqual([kept.preview.changes, kept.warnings], [[{ field: 'người nhận', before: '(trống)', after: 'thợ điện' }], []]);
      assert.equal((await step('expense.edit', rid(73), same, kept)).kind, 'applied');
      assert.equal((await row(id)).room_id, ROOM, 'phòng giữ nguyên');
      // Đổi toà thật (toà B trong phạm vi khoá sửa) mà không nêu phòng ⇒ bỏ phòng, bản xem trước cảnh báo rõ.
      await db.query("UPDATE public.authorization_scopes SET scope_type='ORGANIZATION',building_id=NULL WHERE organization_id=$1 AND scope_type='BUILDING'", [ORG]);
      const moved = await run('expense.edit', 'preview', rid(74), { voucherCode: 'PC2610502', buildingName: 'Toà B', reason: 'ghi nhầm toà' });
      assert.deepEqual(moved.preview.changes, [{ field: 'toà', before: 'Toà A', after: 'Toà B' }, { field: 'phòng', before: 'P101', after: '(không)' }]);
      assert.deepEqual(moved.warnings, ['Đổi toà: phiếu BỎ phòng P101 (phòng của toà cũ); cần phòng ở toà mới thì nêu roomName']);
    });
  });

  await t.test('Mốc 4 expense.cancel: đã vào sổ ⇒ "bút toán đảo, KHÔNG khôi phục được"; chưa vào sổ; lượt 2 + phát lại; đã huỷ ⇒ not_pending; người khác cần quyền huỷ; lệch ⇒ state_changed', async () => {
    await f.rollbackCase(async () => {
      const posted = await voucher('PC2610511', { amount: 350000, status: 'APPROVED', posting: 'POSTED', account: CB2 });
      const before = await trace4();
      const params = { voucherCode: 'PC2610511', reason: 'lập trùng phiếu' };
      const preview = await run('expense.cancel', 'preview', rid(75), params);
      assert.deepEqual([preview.kind, preview.confirm, preview.preview.summary, preview.preview.willBe], ['preview', 'required',
        `Huỷ phiếu PC2610511 — 350.000đ, Sửa chữa, Toà A, ngày ${vn(TODAY)}.`,
        'ĐÃ VÀO SỔ Tiền mặt toà A ⇒ huỷ sẽ tạo bút toán đảo (cộng lại 350.000đ vào sổ), KHÔNG khôi phục được']);
      assert.deepEqual(await trace4(), before, 'chạy thử không để lại bút toán, dòng huỷ, biên nhận');
      const applied = await step('expense.cancel', rid(75), params, preview);
      assert.deepEqual([applied.kind, applied.result.cancellationKind, applied.result.statusText, applied.result.amountText],
        ['applied', 'CANCELLED_AFTER_POSTING', 'Đã huỷ; đã tạo bút toán đảo vào sổ Tiền mặt toà A', '350.000đ']);
      assert.deepEqual((await row(posted)).approval_status, 'CANCELLED');
      assert.deepEqual((await db.query('SELECT kind,amount::bigint::text amount FROM public.fixture_postings WHERE voucher_id=$1', [posted])).rows, [{ kind: 'REVERSAL', amount: '350000' }]);
      assert.deepEqual(await step('expense.cancel', rid(75), params, preview), applied, 'phát lại y nguyên');
      assert.deepEqual(await run('expense.cancel', 'preview', rid(76), params), { kind: 'rejected', reason: 'not_pending', link: `/income-expense/voucher/${posted}` }, 'đã huỷ');
      // Chưa vào sổ ⇒ câu khác; phiếu cha lặp lại ⇒ cảnh báo các kỳ sau không tự lập.
      await voucher('PC2610512', { cycle: 'MONTH' });
      const unposted = await run('expense.cancel', 'preview', rid(77), { voucherCode: 'PC2610512', reason: 'không mua nữa' });
      assert.deepEqual([unposted.preview.willBe, unposted.warnings], ['CHƯA VÀO SỔ ⇒ phiếu chuyển sang Đã huỷ, sổ quỹ không đổi',
        ['Phiếu lặp lại theo chu kỳ: huỷ thì các kỳ sau KHÔNG tự lập nữa']]);
      // Phiếu của người khác: hàm web đòi quyền huỷ ở toà ⇒ not_allowed ngay bản xem trước; có quyền ⇒ xem trước được.
      await voucher('PC2610513', { user: STRANGER });
      assert.deepEqual(await run('expense.cancel', 'preview', rid(78), { voucherCode: 'PC2610513', reason: 'lập trùng phiếu' }), { kind: 'rejected', reason: 'not_allowed' });
      await db.query("INSERT INTO public.fixture_acl(permission,building_ids) VALUES('income_expenses.cancel',$1)", [[BUILDING]]);
      const others = { voucherCode: 'PC2610513', reason: 'lập trùng phiếu' };
      const allowed = await run('expense.cancel', 'preview', rid(79), others);
      assert.equal(allowed.kind, 'preview');
      // Mốc 4b (review): mất quyền huỷ sau bản xem trước ⇒ lượt 2 chốt not_allowed (SQLSTATE 42501 trong biên nhận), không phải state_changed.
      await db.query("DELETE FROM public.fixture_acl WHERE permission='income_expenses.cancel'");
      assert.deepEqual(await step('expense.cancel', rid(79), others, allowed), { kind: 'rejected', reason: 'not_allowed' });
      assert.deepEqual((await db.query('SELECT state,sqlstate FROM app_private.hermes_action_receipts WHERE request_id=$1', [rid(79)])).rows,
        [{ state: 'rejected', sqlstate: '42501' }]);
      // "Đã vào sổ" theo kết cục THẬT của lần chạy thử (hàm web viết bút toán đảo), không theo cột trạng thái của phiếu.
      await voucher('PC2610514');
      await db.query("UPDATE public.fixture_writer SET reject_name='cancel-posted'");
      assert.match((await run('expense.cancel', 'preview', rid(81), { voucherCode: 'PC2610514', reason: 'lập trùng phiếu' })).preview.willBe, /^ĐÃ VÀO SỔ /);
      await db.query('UPDATE public.fixture_writer SET reject_name=NULL');
      // Ghi sổ xen giữa hai lượt (phiên bản sổ tăng) ⇒ state_changed, không huỷ.
      const p = await run('expense.cancel', 'preview', rid(80), { voucherCode: 'PC2610512', reason: 'không mua nữa' });
      await db.query("UPDATE public.income_expenses SET posting_version=posting_version+1 WHERE code='PC2610512'");
      const frozen = await trace4();
      assert.deepEqual(await step('expense.cancel', rid(80), { voucherCode: 'PC2610512', reason: 'không mua nữa' }, p), { kind: 'rejected', reason: 'state_changed' });
      assert.deepEqual(await trace4(), frozen);
    });
  });

  await t.test('Mốc 4: chỉ phiếu CHI lập tay — THU ⇒ web_only, phiếu hệ thống (kể cả hoa hồng web cho sửa) ⇒ system_voucher, phiếu con định kỳ theo cờ TC5', async () => {
    await f.rollbackCase(async () => {
      await voucher('PT2610001', { type: 'INCOME' });
      await voucher('PC2610521', { system: 'contract.commission' });
      await voucher('PC2610522', { salary: STRANGER });
      const parent = await voucher('PC2610523', { status: 'APPROVED', posting: 'POSTED', cycle: 'MONTH' });
      await voucher('PC2610524', { parent });
      for (const [code, reason] of [['PT2610001', 'web_only'], ['PC2610521', 'system_voucher'], ['PC2610522', 'system_voucher'], ['PC2610524', 'system_voucher']]) {
        assert.deepEqual(await run('expense.edit', 'preview', rid(85), { voucherCode: code, content: 'đổi nội dung' }), { kind: 'rejected', reason }, `edit ${code}`);
        assert.deepEqual(await run('expense.cancel', 'preview', rid(86), { voucherCode: code, reason: 'lập trùng phiếu' }), { kind: 'rejected', reason }, `cancel ${code}`);
      }
      // TC5 / câu 55: đổi cờ bằng dữ liệu (không sửa mã) ⇒ phiếu con định kỳ thành phiếu lập tay cho bot.
      assert.deepEqual((await db.query("SELECT enabled FROM app_private.hermes_action_flags WHERE flag='expense.recurring_child_manual'")).rows, [{ enabled: false }]);
      await db.query("UPDATE app_private.hermes_action_flags SET enabled=true WHERE flag='expense.recurring_child_manual'");
      const child = await run('expense.edit', 'preview', rid(87), { voucherCode: 'PC2610524', content: 'đổi nội dung' });
      assert.equal(child.kind, 'preview');
      await db.query("UPDATE app_private.hermes_action_flags SET enabled=false WHERE flag='expense.recurring_child_manual'");
      // Lượt 2 với bản xem trước cũ sau khi cờ tắt lại ⇒ bước ghi kiểm lại, từ chối trước biên nhận.
      const frozen = await trace4();
      assert.deepEqual(await step('expense.edit', rid(87), { voucherCode: 'PC2610524', content: 'đổi nội dung' }, child), { kind: 'rejected', reason: 'system_voucher' });
      assert.deepEqual(await trace4(), frozen);
    });
  });

  await t.test('Mốc 4 (review): lô nói khoản số mấy; gợi ý hạng mục khoá cứng vào hạng mục dòng tiền không tự nhận', async () => {
    await f.rollbackCase(async () => {
      const two = { items: [item({ content: 'khoản một' }), item({ content: 'khoản hai' })] };
      await db.query("UPDATE public.fixture_writer SET rejected_message='Sổ quỹ đã khoá tại ngày phiếu',reject_name='khoản hai'");
      assert.deepEqual(await run('expense.create', 'preview', rid(90), two), { kind: 'rejected', reason: 'period_locked', item: 2 });
      await db.query("UPDATE public.fixture_writer SET reject_name='khoản một'");
      assert.deepEqual(await run('expense.create', 'preview', rid(91), { items: [item({ content: 'khoản một' })] }), { kind: 'rejected', reason: 'period_locked' }, 'một khoản: không cần số');
      await db.query("UPDATE public.fixture_writer SET rejected_message=NULL,reject_name=NULL");
      assert.deepEqual(await run('expense.create', 'preview', rid(92), { items: [item(), item({ cashbook: 'quỹ người khác' })] }), { kind: 'rejected', reason: 'cashbook_not_held', item: 2 });
      // "tiền phòng 5 ngày": luật web khoá cứng vào "Trả lại tiền thừa cho khách" (dòng tiền). Lượt 13 (nghiệm thu): đó là luồng thanh lý /
      // trả tiền thừa cho khách ⇒ web_only + link, kể cả khi nêu tên hạng mục đó hay một hạng mục khác (trước đây hỏi lại / nhận ⇒ phiếu chi tay).
      const suggested = (await db.query("SELECT public.ie_category_suggest_v1($1,'[{\"text\":\"tiền phòng 5 ngày\"}]'::jsonb,'expense',false)->0 s", [ORG])).rows[0].s;
      assert.deepEqual([suggested.typeId, suggested.reason], [MONEY_FLOW, 'rule'], 'luật web khoá cứng');
      const flow = { kind: 'rejected', reason: 'web_only', link: '/contracts' };
      assert.deepEqual(await run('expense.create', 'preview', rid(93), { items: [item({ category: undefined, content: 'tiền phòng 5 ngày' })] }), flow);
      assert.deepEqual(await run('expense.create', 'preview', rid(94), { items: [item({ category: 'trả lại tiền thừa', content: 'tiền phòng 5 ngày' })] }), flow);
      assert.deepEqual(await run('expense.create', 'preview', rid(95), { items: [item({ category: 'sửa chữa', content: 'tiền phòng 5 ngày' })] }), flow);
    });
    // Danh sách dòng tiền của Hermes = c_money_flow của ie_category_suggest_v1 (hai file khác nhau, test khoá bằng nhau).
    const list = sql => /c_money_flow CONSTANT text\[\]:=ARRAY\[([^\]]+)\]/.exec(sql)?.[1];
    assert.ok(list(RULES) && list(RULES) === list(EDIT), `${list(RULES)} ≠ ${list(EDIT)}`);
  });

  // ---- Mốc 5: duyệt / duyệt + chi ≤ 10 phiếu. Phiếu do nhân viên (STRANGER) lập, người duyệt là USER (giữ sổ CASHBOOK, CB2).
  const trace5 = async () => ({ ...(await trace4()), ...(await db.query(`SELECT (SELECT count(*)::int FROM public.fixture_approvals) approvals,
    (SELECT count(*)::int FROM public.fixture_evidence) evidence,(SELECT string_agg(state,',' ORDER BY object_name) FROM public.fixture_evidence) evidence_states`)).rows[0] });
  const staff = (extra = {}) => ({ user: STRANGER, maker: 'Nhân viên A', ...extra });
  const receiptOf = async requestId => (await db.query('SELECT state,sqlstate FROM app_private.hermes_action_receipts WHERE request_id=$1', [requestId])).rows;
  const states = async ids => (await db.query('SELECT approval_status||\'/\'||posting_status s FROM public.income_expenses WHERE id=ANY($1) ORDER BY code', [ids])).rows.map(r => r.s);
  const hook = (name, message, state) => db.query('UPDATE public.fixture_writer SET rejected_message=$1,reject_state=$2,reject_name=$3', [message, state, name]);

  await t.test('Mốc 5 expense.approve: lô hỗn hợp duyệt + chi / chỉ duyệt (chưa ảnh) / không làm; chạy thử không để lại dấu vết; lượt 2 + phát lại', async () => {
    await f.rollbackCase(async () => {
      const a = await voucher('PC2610601', staff({ amount: 700000, images: [IMAGE(1)] }));
      const b = await voucher('PC2610602', staff({ amount: 300000 }));
      const c = await voucher('PC2610603', staff({ status: 'APPROVED', posting: 'POSTED' }));
      const params = { voucherCodes: ['pc2610601', 'PC2610602', 'PC2610603'] };
      const before = await trace5();
      const preview = await run('expense.approve', 'preview', rid(100), params);
      assert.deepEqual([preview.kind, preview.confirm, preview.preview.summary, preview.warnings], ['preview', 'required',
        'Duyệt 2 phiếu: duyệt + CHI 1 phiếu, tổng 700.000đ; chỉ duyệt 1 phiếu (chưa chi); không làm 1 phiếu.', ['1 phiếu không làm được — xem cột plan của từng phiếu']]);
      assert.deepEqual(preview.preview.items[0], { stt: 1, code: 'PC2610601', content: 'mua bóng đèn', building: 'Toà A', category: 'Sửa chữa', amount: '700.000đ',
        maker: 'Nhân viên A', ageDays: 0, attachments: 1, cashbook: 'Quỹ VCB 0123456789', plan: 'duyệt + CHI 700.000đ khỏi sổ Quỹ VCB 0123456789' });
      assert.deepEqual(preview.preview.items.slice(1).map(item => item.plan), ['chỉ duyệt (chưa có ảnh — thêm ảnh ở trang phiếu rồi chi)', 'không làm: phiếu không còn chờ duyệt']);
      assert.ok(!JSON.stringify(preview.preview).match(/[0-9a-f]{8}-[0-9a-f]{4}-/), 'bản xem trước không có UUID');
      assert.deepEqual(preview.resolved.vouchers.map(v => [v.voucherId, v.plan, v.note ?? null, v.skip ?? null]),
        [[a, 'approve_post', null, null], [b, 'approve', 'no_attachment', null], [c, 'skip', null, 'not_pending']]);
      assert.deepEqual(await trace5(), before, 'chạy thử không để lại duyệt, bút toán, chứng từ, biên nhận');
      const applied = await step('expense.approve', rid(100), params, preview);
      assert.deepEqual(applied, { kind: 'applied', link: '/income-expense', result: { totalPosted: 700000, totalPostedText: '700.000đ', items: [
        { code: 'PC2610601', outcome: 'approved_posted', statusText: 'Đã duyệt và CHI khỏi sổ Quỹ VCB 0123456789' },
        { code: 'PC2610602', outcome: 'approved', statusText: 'Đã duyệt (chưa chi)' },
        { code: 'PC2610603', outcome: 'rejected', reason: 'not_pending', statusText: 'Không làm: phiếu không còn chờ duyệt' }] } });
      assert.deepEqual(await states([a, b, c]), ['APPROVED/POSTED', 'APPROVED/UNPOSTED', 'APPROVED/POSTED']);
      assert.deepEqual((await db.query('SELECT kind,amount::bigint::text amount FROM public.fixture_postings WHERE voucher_id=$1', [a])).rows, [{ kind: 'POSTING', amount: '700000' }]);
      const after = await trace5();
      assert.deepEqual([after.approvals - before.approvals, after.evidence_states, after.receipts - before.receipts], [2, 'ATTACHED', 1], 'ảnh phiếu thành chứng từ đã gắn');
      assert.deepEqual(await step('expense.approve', rid(100), params, preview), applied, 'phát lại y nguyên');
      assert.deepEqual(await trace5(), after);
      assert.deepEqual(await run('expense.approve', 'preview', rid(101), { voucherCodes: ['PC2610601'] }), { kind: 'rejected', reason: 'not_pending' }, 'đã duyệt');
    });
  });

  await t.test('Mốc 5: hạ "chỉ duyệt" và nói rõ — post=false, không giữ sổ, ảnh không dùng được, chưa chọn sổ, không chi qua sổ, hàm web đòi chứng từ; kỳ chốt ⇒ không làm', async () => {
    await f.rollbackCase(async () => {
      const d = await voucher('PC2610611', staff({ images: [IMAGE(11)] }));
      await voucher('PC2610612', staff({ images: [IMAGE(12)], account: FOREIGN_CASHBOOK }));
      await voucher('PC2610613', staff({ images: ['https://fixture.invalid/khac/anh.jpg'] }));
      await voucher('PC2610614', staff({ images: [IMAGE(14)], account: null }));
      await voucher('PC2610615', staff({ images: [IMAGE(15)], mode: 'NON_CASH' }));
      await voucher('PC2610616', staff({ images: [IMAGE(16)] }));
      await db.query("INSERT INTO public.fixture_evidence(organization_id,object_name,state) VALUES($1,'fixture/16.jpg','QUARANTINED')", [ORG]);
      const before = await trace5();
      const mixed = await run('expense.approve', 'preview', rid(110), { voucherCodes: ['PC2610612', 'PC2610613', 'PC2610614', 'PC2610615', 'PC2610616'] });
      assert.deepEqual([mixed.preview.summary, mixed.warnings], ['Duyệt 5 phiếu: chỉ duyệt 5 phiếu (chưa chi).', []]);
      assert.deepEqual(mixed.preview.items.map(item => item.plan), ['chỉ duyệt (anh/chị không giữ sổ Quỹ người khác)',
        'chỉ duyệt (ảnh trên phiếu chưa dùng làm chứng từ được)', 'chỉ duyệt (phiếu chưa chọn sổ quỹ)', 'chỉ duyệt (phiếu không chi qua sổ quỹ)',
        'chỉ duyệt (ảnh trên phiếu chưa dùng làm chứng từ được)']);
      assert.deepEqual(mixed.resolved.vouchers.map(v => v.note), ['not_custodian', 'evidence_unusable', 'no_cashbook', 'non_cash', 'evidence_unusable']);
      assert.equal(mixed.preview.items[2].cashbook, undefined);
      // Hàm duyệt + chi của web đòi chứng từ (lỗi thật, không phải do adopt rỗng) ⇒ cũng hạ; kỳ sổ đã chốt ⇒ không làm.
      await hook('approve-post', 'finance_v2_post_manual_voucher: at least one FINALIZED evidence is required', '55000');
      assert.equal((await run('expense.approve', 'preview', rid(111), { voucherCodes: ['PC2610611'] })).preview.items[0].plan, 'chỉ duyệt (ảnh trên phiếu chưa dùng làm chứng từ được)');
      await hook('approve-post', 'approve_and_post_income_expense_v2: posted_on 2026-10-23 is inside a locked cashbook period', '55000');
      assert.deepEqual(await run('expense.approve', 'preview', rid(112), { voucherCodes: ['PC2610611'] }), { kind: 'rejected', reason: 'period_locked' });
      await hook('approve', 'approve_income_expense_v2: income_expenses.approve required in scope', '42501');
      assert.deepEqual(await run('expense.approve', 'preview', rid(114), { voucherCodes: ['PC2610613'] }), { kind: 'rejected', reason: 'not_allowed' }, 'chạy thử duyệt bị hàm web từ chối');
      await hook(null, null, null);
      assert.deepEqual(await trace5(), before);
      // post=false ⇒ chỉ duyệt theo yêu cầu dù đủ điều kiện chi; một phiếu ⇒ link trang phiếu.
      const only = await run('expense.approve', 'preview', rid(113), { voucherCodes: ['PC2610611'], post: false });
      assert.deepEqual([only.preview.summary, only.preview.items[0].plan], ['Duyệt 1 phiếu: chỉ duyệt 1 phiếu (chưa chi).', 'chỉ duyệt (theo yêu cầu, chưa chi)']);
      const applied = await step('expense.approve', rid(113), { voucherCodes: ['PC2610611'], post: false }, only);
      assert.deepEqual([applied.link, applied.result.items, applied.result.totalPosted], [`/income-expense/voucher/${d}`,
        [{ code: 'PC2610611', outcome: 'approved', statusText: 'Đã duyệt (chưa chi)' }], 0]);
      assert.deepEqual(await states([d]), ['APPROVED/UNPOSTED']);
    });
  });

  await t.test('Mốc 5 lượt 2: từng phiếu một — lệch phiên bản ⇒ phiếu đó state_changed, phiếu khác vẫn chạy; tất cả lệch ⇒ không biên nhận; lỗi cuối ⇒ chốt rejected + SQLSTATE', async () => {
    await f.rollbackCase(async () => {
      const [p1, p2] = [await voucher('PC2610621', staff({ images: [IMAGE(21)] })), await voucher('PC2610622', staff())];
      const two = { voucherCodes: ['PC2610621', 'PC2610622'] };
      const preview = await run('expense.approve', 'preview', rid(120), two);
      await db.query('UPDATE public.income_expenses SET approval_version=approval_version+1 WHERE id=$1', [p1]);
      const mixed = await step('expense.approve', rid(120), two, preview);
      assert.deepEqual([mixed.kind, mixed.result.items, mixed.result.totalPosted], ['applied', [
        { code: 'PC2610621', outcome: 'state_changed', statusText: 'Phiếu vừa đổi sau bản xem trước — xem trước lại' },
        { code: 'PC2610622', outcome: 'approved', statusText: 'Đã duyệt (chưa chi)' }], 0]);
      assert.deepEqual(await states([p1, p2]), ['UNAPPROVED/UNPOSTED', 'APPROVED/UNPOSTED']);
      assert.deepEqual(await receiptOf(rid(120)), [{ state: 'applied', sqlstate: null }]);
      // Tất cả lệch (ghi sổ xen giữa) ⇒ state_changed, không chốt biên nhận, không đổi gì.
      const p3 = await voucher('PC2610623', staff());
      const one = { voucherCodes: ['PC2610623'] };
      const stale = await run('expense.approve', 'preview', rid(121), one);
      await db.query('UPDATE public.income_expenses SET posting_version=posting_version+1 WHERE id=$1', [p3]);
      let frozen = await trace5();
      assert.deepEqual(await step('expense.approve', rid(121), one, stale), { kind: 'rejected', reason: 'state_changed' });
      assert.deepEqual([await trace5(), await receiptOf(rid(121))], [frozen, []]);
      // Basis lệch / kế hoạch bị sửa (chỉ duyệt → duyệt + chi) mà giữ basis ⇒ state_changed trước biên nhận.
      const fresh = await run('expense.approve', 'preview', rid(122), one);
      assert.deepEqual(await run('expense.approve', 'apply', rid(122), one, { resolved: fresh.resolved, basis: 'f'.repeat(32) }), { kind: 'rejected', reason: 'state_changed' });
      const upgraded = { vouchers: fresh.resolved.vouchers.map(v => ({ ...v, plan: 'approve_post', note: undefined })) };
      assert.deepEqual(await run('expense.approve', 'apply', rid(122), one, { resolved: upgraded, basis: fresh.basis }), { kind: 'rejected', reason: 'state_changed' });
      // Ảnh bị gỡ giữa hai lượt ⇒ không còn chứng từ ⇒ state_changed (không tự hạ xuống chỉ duyệt khi chưa hỏi lại).
      const p4 = await voucher('PC2610624', staff({ images: [IMAGE(24)] }));
      const withImage = await run('expense.approve', 'preview', rid(123), { voucherCodes: ['PC2610624'] });
      assert.equal(withImage.resolved.vouchers[0].plan, 'approve_post');
      await db.query("UPDATE public.income_expenses SET attachments='[]' WHERE id=$1", [p4]);
      frozen = await trace5();
      assert.deepEqual(await step('expense.approve', rid(123), { voucherCodes: ['PC2610624'] }, withImage), { kind: 'rejected', reason: 'state_changed' });
      assert.deepEqual(await trace5(), frozen);
      await voucher('PC2610627', staff());
      // Lỗi cuối của hàm web ⇒ chốt rejected với lý do thật + SQLSTATE, phát lại y nguyên; lô 2 phiếu nói phiếu số mấy.
      for (const [n, codes, message, state, expected] of [
        [124, ['PC2610623'], '[PROFIT_LOCKED] tháng đã chốt', 'P0001', { kind: 'rejected', reason: 'period_locked' }],
        [125, ['PC2610623', 'PC2610627'], 'approve_income_expense_v2: income_expenses.approve required in scope', '42501', { kind: 'rejected', reason: 'not_allowed', item: 1 }]]) {
        const p = await run('expense.approve', 'preview', rid(n), { voucherCodes: codes });
        await hook('approve', message, state);
        const final = await step('expense.approve', rid(n), { voucherCodes: codes }, p);
        assert.deepEqual(final, expected, message);
        assert.deepEqual(await receiptOf(rid(n)), [{ state: 'rejected', sqlstate: state }]);
        assert.deepEqual(await step('expense.approve', rid(n), { voucherCodes: codes }, p), final, 'phát lại y nguyên');
        await hook(null, null, null);
      }
      // Một phiếu xong, phiếu kia gặp kỳ sổ chốt khi chi ⇒ applied, phiếu kia rejected kèm lý do.
      const p9 = await voucher('PC2610629', staff({ images: [IMAGE(29)] }));
      const pair = { voucherCodes: ['PC2610623', 'PC2610629'] };
      const p = await run('expense.approve', 'preview', rid(126), pair);
      await hook('approve-post', '[CASHBOOK_CLOSED] sổ đã khoá', 'P0001');
      const partial = await step('expense.approve', rid(126), pair, p);
      await hook(null, null, null);
      assert.deepEqual(partial.result.items, [{ code: 'PC2610623', outcome: 'approved', statusText: 'Đã duyệt (chưa chi)' },
        { code: 'PC2610629', outcome: 'rejected', reason: 'period_locked', statusText: 'Không làm: kỳ đã chốt' }]);
      assert.deepEqual(await states([p3, p9]), ['APPROVED/UNPOSTED', 'UNAPPROVED/UNPOSTED']);
    });
  });

  await t.test('Mốc 5: chỉ phiếu CHI lập tay chờ duyệt (THU / hệ thống / định kỳ theo cờ TC5), Q25 #263, giải mã (mơ hồ, ngoài phạm vi, lặp), bản đã giải giả ⇒ not_allowed', async () => {
    await f.rollbackCase(async () => {
      await voucher('PT2610631', staff({ type: 'INCOME' }));
      await voucher('PC2610632', staff({ system: 'contract.commission' }));
      await voucher('PC2610633', staff({ status: 'APPROVED', posting: 'POSTED' }));
      for (const [codes, expected] of [[['PT2610631'], { kind: 'rejected', reason: 'web_only' }], [['PC2610632'], { kind: 'rejected', reason: 'system_voucher' }],
        [['PC2610633', 'PT2610631'], { kind: 'rejected', reason: 'not_pending', item: 1 }]])
        assert.deepEqual(await run('expense.approve', 'preview', rid(130), { voucherCodes: codes }), expected, codes.join());
      // TC5: phiếu con định kỳ ⇒ system_voucher khi cờ tắt; bật cờ ⇒ duyệt được; tắt lại trước lượt 2 ⇒ lý do cuối, chốt rejected.
      const parent = await voucher('PC2610634', staff({ status: 'APPROVED', posting: 'POSTED', cycle: 'MONTH' }));
      await voucher('PC2610635', staff({ parent }));
      assert.deepEqual(await run('expense.approve', 'preview', rid(131), { voucherCodes: ['PC2610635'] }), { kind: 'rejected', reason: 'system_voucher' });
      await db.query("UPDATE app_private.hermes_action_flags SET enabled=true WHERE flag='expense.recurring_child_manual'");
      const child = await run('expense.approve', 'preview', rid(132), { voucherCodes: ['PC2610635'] });
      assert.equal(child.kind, 'preview');
      await db.query("UPDATE app_private.hermes_action_flags SET enabled=false WHERE flag='expense.recurring_child_manual'");
      assert.deepEqual(await step('expense.approve', rid(132), { voucherCodes: ['PC2610635'] }, child), { kind: 'rejected', reason: 'system_voucher' });
      assert.deepEqual(await receiptOf(rid(132)), [{ state: 'rejected', sqlstate: null }]);
      // Q25 (#263): phiếu CHI chính người duyệt lập, từ ngưỡng 600.000đ, không có quyền duyệt kiểu cũ ở toà ⇒ not_allowed; dưới ngưỡng ⇒ được.
      await voucher('PC2610636', { amount: 700000 });
      await voucher('PC2610637', { amount: 300000 });
      assert.deepEqual(await run('expense.approve', 'preview', rid(133), { voucherCodes: ['PC2610636'] }), { kind: 'rejected', reason: 'not_allowed' });
      assert.equal((await run('expense.approve', 'preview', rid(134), { voucherCodes: ['PC2610637'] })).kind, 'preview');
      await db.query('INSERT INTO public.fixture_legacy_approvers VALUES($1,$2)', [USER, BUILDING]);
      const own = await run('expense.approve', 'preview', rid(135), { voucherCodes: ['PC2610636'] });
      assert.equal(own.kind, 'preview');
      await db.query('DELETE FROM public.fixture_legacy_approvers');
      assert.deepEqual(await step('expense.approve', rid(135), { voucherCodes: ['PC2610636'] }, own), { kind: 'rejected', reason: 'not_allowed' }, 'rào #263 kiểm lại ở lượt 2');
      // Giải mã: không thấy / ngoài phạm vi khoá / mơ hồ ⇒ hỏi lại đúng như mã phiếu của note; hai mã cùng phiếu ⇒ invalid_params.
      const elsewhere = await voucher('PC2610638', staff({ building: OTHER_BUILDING }));
      await voucher('PC2609001', staff({ date: '2026-09-03' }));
      await voucher('PC2609001', staff({ date: '2026-09-12', amount: 1200000 }));
      const unresolved = (wanted, why, extra = {}) => ({ kind: 'needs_input', reason: 'name_unresolved', field: 'voucher', wanted, why, candidates: [], more: false, ...extra });
      assert.deepEqual(await run('expense.approve', 'preview', rid(136), { voucherCodes: ['PC2610637', 'PC0000000'] }), unresolved('PC0000000', 'not_visible'));
      assert.deepEqual(await run('expense.approve', 'preview', rid(136), { voucherCodes: ['PC2610638'] }), unresolved('PC2610638', 'outside_scope'));
      assert.deepEqual(await run('expense.approve', 'preview', rid(136), { voucherCodes: ['pc2609001'] }), unresolved('pc2609001', 'ambiguous',
        { candidates: [{ name: 'PC2609001 · 12/09/2026 · Toà A · 1.200.000đ' }, { name: 'PC2609001 · 03/09/2026 · Toà A · 400.000đ' }] }));
      assert.deepEqual(await run('expense.approve', 'preview', rid(136), { voucherCodes: ['PC2610637', ' pc2610637'] }), { kind: 'rejected', reason: 'invalid_params' });
      // Lượt 2 đưa bản đã giải giả ⇒ not_allowed trước biên nhận.
      const p = await run('expense.approve', 'preview', rid(137), { voucherCodes: ['PC2610637'] });
      const v0 = p.resolved.vouchers[0];
      const frozen = await trace5();
      for (const [forged, codes] of [[[{ ...v0, voucherId: elsewhere }], ['PC2610637']], [[v0, v0], ['PC2610637', 'PC2610637']], [[], ['PC2610637']],
        [[v0], ['PC2610637', 'PC2610636']], [[{ ...v0, voucherId: rid(999) }], ['PC2610637']]])
        assert.deepEqual(await run('expense.approve', 'apply', rid(137), { voucherCodes: codes }, { resolved: { vouchers: forged }, basis: p.basis }),
          { kind: 'rejected', reason: 'not_allowed' }, JSON.stringify(forged).slice(0, 80));
      assert.deepEqual(await trace5(), frozen);
    });
  });

  // ---- Lượt 11 (nghiệm thu bot thật trên TEST, 24/10): hạng mục suy từ nội dung, mã phiếu dùng lại giữa các toà, mở lại phiếu.
  let n11 = 400;
  const preview11 = params => run('expense.create', 'preview', rid(n11++), params);
  await t.test('Lượt 11 hạng mục: món điện nước / sửa chữa / vệ sinh / văn phòng phẩm ra đúng hạng mục; mơ hồ ⇒ ít ứng viên đúng nghĩa; tên nhóm; lô nói khoản số mấy', async () => {
    await f.rollbackCase(async () => {
      // Danh mục chuẩn (rút gọn): 4 khoản cố định đứng ĐẦU BẢNG như production — trước đây chính chúng bị đưa ra làm "ứng viên".
      const catalog = [['Tiền nhà', 'Cố định hằng tháng', 'tien_nha', ['tiền nhà', 'thuê nhà'], 'tien_nha'], ['Đóng tiền điện', 'Cố định hằng tháng', 'dien', ['tiền điện'], 'dien'],
        ['Đóng tiền internet', 'Cố định hằng tháng', 'internet', ['tiền mạng'], 'internet'], ['Tiền rác', 'Cố định hằng tháng', 'rac', ['tiền rác'], 'rac'],
        ['Sửa điện', 'Sửa chữa – bảo trì', 'sua_dien', ['sửa điện', 'thợ điện'], null], ['Sửa nước, máy bơm', 'Sửa chữa – bảo trì', 'sua_nuoc_may_bom', ['sửa máy bơm', 'thông cống'], null],
        ['Mua đồ điện nước', 'Mua sắm', 'vat_tu_dien_nuoc', ['bóng đèn', 'ổ điện'], null], ['Dọn vệ sinh theo lượt', 'Vệ sinh phát sinh', 'don_ve_sinh', ['dọn phòng', 'lau hành lang'], null],
        ['Văn phòng, phần mềm', 'Hành chính – pháp lý', 'van_phong', ['văn phòng', 'phần mềm'], null]];
      for (const [j, [name, group, key, keywords, fee]] of catalog.entries())
        await db.query(`INSERT INTO public.income_expense_types(id,organization_id,type,name,category,rule_key,keywords,fee_category,sort_order) VALUES($1,$2,'expense',$3,$4,$5,$6,$7,$8)`,
          [uid(620 + j), ORG, name, group, key, keywords, fee, j - 10]);
      const chosen = async (content, category) => {
        const out = await preview11({ items: [item({ content, category })] });
        return out.kind === 'preview' ? [out.preview.items[0].category, out.preview.items[0].categoryAuto ?? null] : out;
      };
      const AUTO = 'tự chọn theo nội dung — sửa nếu sai';
      for (const [content, expected] of [['mua vòi nước', 'Mua đồ điện nước'], ['mua ốc vít', 'Mua đồ điện nước'], ['thay ổ cắm phòng 101', 'Mua đồ điện nước'],
        ['mua dây điện', 'Mua đồ điện nước'], ['thợ sửa ổ cắm', 'Sửa điện'], ['thông cống phòng 101', 'Sửa nước, máy bơm'], ['sửa bồn cầu', 'Sửa nước, máy bơm'],
        ['dọn vệ sinh hành lang', 'Dọn vệ sinh theo lượt'], ['mua giấy in', 'Văn phòng, phần mềm'], ['tiền nhà tháng 10', 'Tiền nhà']])
        assert.deepEqual(await chosen(content, undefined), [expected, AUTO], content);
      // Gợi ý không khoá cứng ⇒ hỏi lại (unspecified) với ứng viên đúng nghĩa, gợi ý đứng đầu — không bao giờ các khoản cố định đầu bảng.
      const vague = await chosen('sửa chữa linh tinh', undefined);
      assert.deepEqual([vague.kind, vague.field, vague.why, vague.wanted], ['needs_input', 'category', 'unspecified', '']);
      assert.deepEqual(vague.candidates.map(c => c.name), ['Sửa chữa', 'Sửa điện', 'Sửa nước, máy bơm']);
      for (const content of ['mua vòi nước', 'đồ lặt vặt', 'sửa chữa linh tinh', 'mua chổi lau nhà'])
        for (const out of [await chosen(content, undefined)])
          if (out.kind) assert.ok(!out.candidates.some(c => ['Tiền nhà', 'Đóng tiền điện', 'Đóng tiền internet', 'Tiền rác'].includes(c.name)), content);
      assert.deepEqual((await chosen('mua chổi lau nhà', undefined)).candidates.map(c => c.name), ['Dọn vệ sinh theo lượt'], 'trùng từ "lau" với cụm hay nói');
      // Nêu tên nhóm ("Sửa chữa/bảo trì" — nghiệm thu từng báo "không thấy … trong phạm vi quyền"): đủ từ trong tên + nhóm ⇒ cả nhóm; nội dung
      // chỉ đúng một hạng mục trong nhóm ⇒ nhận nó; không thì hỏi lại đúng các hạng mục của nhóm.
      assert.deepEqual(await chosen('sửa máy bơm', 'Sửa chữa/bảo trì'), ['Sửa nước, máy bơm', AUTO]);
      const group = await chosen('việc linh tinh', 'Sửa chữa/bảo trì');
      assert.deepEqual([group.why, group.wanted, group.candidates.map(c => c.name)], ['ambiguous', 'Sửa chữa/bảo trì', ['Sửa điện', 'Sửa nước, máy bơm']]);
      assert.deepEqual(await chosen('việc linh tinh', 'đồ điện nước'), ['Mua đồ điện nước', null], 'tên chứa chuỗi đã nêu');
      assert.deepEqual(await chosen('mua vòi nước', 'điện'), ['Mua đồ điện nước', AUTO], '"điện" khớp ba hạng mục; nội dung chọn đúng một');
      assert.deepEqual((await chosen('mua vòi nước', 'bảo hiểm lạ')), { kind: 'needs_input', reason: 'name_unresolved', field: 'category', wanted: 'bảo hiểm lạ',
        why: 'not_visible', candidates: [], more: false });
      // Lô: khoản cần hỏi lại mang số khoản.
      const batch = await preview11({ items: [item(), item({ category: undefined, content: 'đồ lặt vặt' })] });
      assert.deepEqual([batch.kind, batch.field, batch.why, batch.item], ['needs_input', 'category', 'unspecified', 2]);
      const room = await preview11({ items: [item(), item({ roomName: 'P999' })] });
      assert.deepEqual([room.kind, room.field, room.item], ['needs_input', 'room', 2]);
      // Hàm chọn hạng mục: INVOKER dưới RLS người hỏi; đầu vào sai ⇒ 22023.
      await assert.rejects(f.call('SELECT public.hermes_expense_category_pick_v1($1,NULL,NULL) r', [ORG]), code('22023'));
      const list = sql => /c_money_flow CONSTANT text\[\]:=ARRAY\[([^\]]+)\]/.exec(sql)?.[1];
      assert.equal(list(FIXES), list(RULES), 'danh sách dòng tiền của hàm chọn hạng mục = của gợi ý dùng chung');
    });
  });

  await t.test('Lượt 11 mã phiếu: khớp đúng mã đầy đủ trước; mã dùng lại giữa các toà ⇒ hỏi lại kèm ngày/toà; gợi ý ngày/toà chọn đúng phiếu; mã ngắn chỉ là ứng viên; mở lại phiếu ⇒ web', async () => {
    await f.rollbackCase(async () => {
      await db.query("INSERT INTO public.buildings VALUES($1,$2,'Kho Văn Phòng Chung',true,null)", [VIRTUAL, ORG]);
      await db.query("INSERT INTO public.fixture_building_access VALUES($1)", [VIRTUAL]);
      await db.query("INSERT INTO public.fixture_staff_assignments VALUES($1,$2)", [USER, VIRTUAL]);
      for (const permission of ['income_expenses.create', 'buildings.view'])
        await db.query("UPDATE public.fixture_acl SET building_ids=building_ids||$1::uuid WHERE permission=$2", [VIRTUAL, permission]);
      await db.query("UPDATE public.authorization_scopes SET scope_type='ORGANIZATION',building_id=NULL WHERE organization_id=$1 AND scope_type='BUILDING'", [ORG]);
      // Cùng mã ở ba phiếu: hai ngày khác nhau ở Toà A, một phiếu ở toà ảo cùng ngày 12/10 (đo production 24/10: 1 788 phiếu chi, 1 059 mã).
      const early = await voucher('PC2610777', { date: '2026-10-05' });
      const late = await voucher('PC2610777', { date: '2026-10-12' });
      await voucher('PC2610777', { date: '2026-10-12', building: VIRTUAL, amount: 150000 });
      const note = (voucherCode, n) => run('expense.note', 'auto', rid(n), { voucherCode, note: 'đã lấy hoá đơn' });
      const noted = async n => (await db.query('SELECT voucher_id FROM public.fixture_supplements WHERE idempotency_key=$1', ['hermes-note:' + rid(n)])).rows[0]?.voucher_id;
      const all = await note('PC2610777', 430);
      assert.deepEqual([all.kind, all.field, all.why, all.candidates.map(c => c.name)], ['needs_input', 'voucher', 'ambiguous',
        ['PC2610777 · 12/10/2026 · Kho Văn Phòng Chung · 150.000đ', 'PC2610777 · 12/10/2026 · Toà A · 400.000đ', 'PC2610777 · 05/10/2026 · Toà A · 400.000đ']]);
      assert.deepEqual((await note('pc2610777 ngày 12/10', 431)).candidates.length, 2, 'ngày còn hai phiếu ⇒ vẫn hỏi lại');
      const byDate = await note('PC2610777 05/10', 432);
      assert.deepEqual([byDate.kind, await noted(432)], ['applied', early], 'ngày chọn đúng một phiếu');
      const byBuilding = await note('PC2610777 12/10/2026 toà a', 433);
      assert.deepEqual([byBuilding.kind, await noted(433)], ['applied', late], 'ngày + toà chọn đúng một phiếu');
      const byLabel = await note(all.candidates[0].name, 434);
      assert.equal(byLabel.kind, 'applied', 'chép lại nhãn ứng viên là đủ');
      assert.deepEqual((await note('PC2610777 30/01', 435)).candidates.length, 3, 'gợi ý không khớp phiếu nào ⇒ bỏ qua, hỏi lại đủ ứng viên');
      // Mã ngắn / thiếu: chỉ là ứng viên (ghi chú ghi thẳng ⇒ không bao giờ tự chọn), kể cả khi chỉ một phiếu khớp.
      await voucher('PC2610888');
      const short = await note('PC888', 436);
      assert.deepEqual([short.kind, short.why, short.candidates.map(c => c.name.split(' · ')[0])], ['needs_input', 'ambiguous', ['PC2610888']]);
      assert.equal((await note('PC2610999999', 437)).why, 'not_visible');
      // Duyệt: mỗi mã giải như trên.
      const approve = await run('expense.approve', 'preview', rid(438), { voucherCodes: ['PC2610777 05/10', 'PC2610888'] });
      assert.equal(approve.kind, 'preview');
      assert.deepEqual(approve.resolved.vouchers.map(v => v.voucherCode), ['PC2610777', 'PC2610888']);
      // "Mở lại phiếu" (hoàn tác huỷ) không phải thao tác của bot: sửa phiếu đã huỷ ⇒ web_only kèm link trang phiếu, không chạy thử hàm web.
      const cancelled = await voucher('PC2610889', { status: 'CANCELLED' });
      const before = await trace4();
      assert.deepEqual(await run('expense.edit', 'preview', rid(439), { voucherCode: 'PC2610889', cashbook: 'tiền mặt' }),
        { kind: 'rejected', reason: 'web_only', link: `/income-expense/voucher/${cancelled}` });
      assert.deepEqual(await trace4(), before);
    });
  });

  let n13 = 520;
  await t.test('Lượt 13 luồng hệ thống: hoa hồng / thanh lý, trả tiền thừa / cọc / lương / chia lợi nhuận / chuyển nội bộ ⇒ web_only + link; không bao giờ là ứng viên; hai lượt; sửa phiếu', async () => {
    const flowOf = async (text, ruleKey = null) => (await db.query('SELECT public.hermes_expense_system_flow_v1($1,$2) f', [text, ruleKey])).rows[0].f;
    const LINK = { commission: '/contracts', liquidation: '/contracts', deposit: '/deposits', salary: '/finance/salary', profit_share: '/finance/shareholder-profit', internal: '/finance/cashbooks' };
    for (const [text, flow] of [['hoàn cọc phòng 101', 'deposit'], ['bỏ cọc', 'deposit'], ['trả cọc khách', 'deposit'], ['hoan coc p101', 'deposit'], ['cọc giữ chỗ phòng 202', 'deposit'],
      ['giữ chỗ P101', 'deposit'], ['bổ sung hoàn cọc', 'deposit'], ['thanh lý hợp đồng P101', 'liquidation'], ['trả lại tiền thừa cho khách', 'liquidation'], ['thối tiền khách', 'liquidation'],
      ['khách đóng dư 200k', 'liquidation'], ['hoàn tiền cho khách thuê', 'liquidation'], ['trả khách 200k', 'liquidation'], ['tra lai tien thua', 'liquidation'],
      ['chi hoa hồng môi giới', 'commission'], ['HHMG tháng 10', 'commission'], ['thưởng nóng sale', 'commission'], ['phí môi giới', 'commission'],
      ['tiền lương tháng 10', 'salary'], ['ứng lương quản lý', 'salary'], ['trả lương nhân viên', 'salary'], ['tien luong t10', 'salary'],
      ['chia lợi nhuận cổ đông', 'profit_share'], ['chuyển tiền nội bộ', 'internal'], ['bàn giao tiền mặt', 'internal']])
      assert.deepEqual(await flowOf(text), { flow, link: LINK[flow] }, text);
    for (const [key, flow] of [['tra_tien_thua_khach', 'liquidation'], ['bo_sung_hoan_coc', 'deposit'], ['hoa_hong_moi_gioi', 'commission'], ['hhmg', 'commission'],
      ['thuong_nong_sale', 'commission'], ['luong_quan_ly', 'salary'], ['ung_luong', 'salary'], ['luong_dieu_hanh', 'salary'], ['chia_loi_nhuan', 'profit_share'], ['noi_bo', 'internal']])
      assert.equal((await flowOf('tên đã đổi', key))?.flow, flow, key);
    // rule_key xét trước chữ: nhóm "Trả lại khách" của "Bổ sung hoàn cọc" khớp cụm thanh lý, nhưng hạng mục là luồng cọc (TEST 24/10).
    assert.deepEqual(await flowOf('Bổ sung hoàn cọc Trả lại khách', 'bo_sung_hoan_coc'), { flow: 'deposit', link: '/deposits' });
    // Khoản chi thật có chữ trùng (bỏ dấu): cốc / chất lượng / số lượng / đặt cọc thợ / khách sạn / hoàn tạm ứng / quà cho khách / họp nội bộ.
    for (const text of ['mua vòi nước', 'mua cốc nhựa', 'kiểm tra chất lượng nước', 'số lượng bóng đèn 10', 'đặt cọc thợ sửa máy lạnh', 'trả tiền khách sạn đoàn',
      'hoàn tiền tạm ứng cho anh A', 'mua quà cho khách', 'họp nội bộ ăn trưa', 'tiền phòng 5 ngày', 'sửa ống nước cho anh Lương', '', null])
      assert.equal(await flowOf(text), null, String(text));

    await f.rollbackCase(async () => {
      // Hạng mục web vẫn cho lập tay nhưng là luồng hệ thống (rule_key / tên), và một hạng mục tự đặt tên có chữ "hoàn cọc".
      for (const [j, [name, group, key]] of [['Bổ sung hoàn cọc', 'Trả lại khách', 'bo_sung_hoan_coc'], ['Hoàn cọc khách', null, null], ['Chuyển tiền nội bộ', 'Tiền nội bộ', 'noi_bo'],
        ['Bổ sung vật tư', 'Mua sắm', null]].entries())
        await db.query(`INSERT INTO public.income_expense_types(id,organization_id,type,name,category,rule_key,sort_order) VALUES($1,$2,'expense',$3,$4,$5,$6)`, [uid(640 + j), ORG, name, group, key, 60 + j]);
      const before = await trace4();
      const create = items => run('expense.create', 'preview', rid(n13++), { items });
      const web = link => ({ kind: 'rejected', reason: 'web_only', link });
      // Nội dung / hạng mục nêu thuộc luồng hệ thống ⇒ web_only + link màn gốc; trước cả khi hỏi lại toà (toà không có trong phạm vi).
      assert.deepEqual(await create([item({ category: undefined, content: 'hoàn cọc khách P101' })]), web('/deposits'));
      assert.deepEqual(await create([item({ content: 'trả lại tiền thừa cho khách P101' })]), web('/contracts'), 'nêu hạng mục thường vẫn chặn');
      assert.deepEqual(await create([item({ category: 'Bổ sung hoàn cọc', content: 'khách P101' })]), web('/deposits'));
      assert.deepEqual(await create([item({ category: 'chuyển tiền nội bộ', content: 'chuyển quỹ' })]), web('/finance/cashbooks'));
      assert.deepEqual(await create([item({ buildingName: 'Toà Z', content: 'trả lương tháng 10' })]), web('/finance/salary'), 'trước khi hỏi lại toà');
      assert.deepEqual(await create([item(), item({ content: 'chi hoa hồng môi giới P101' })]), { ...web('/contracts'), item: 2 }, 'lô nói khoản số mấy');
      // Không bao giờ là ứng viên: nêu "bổ sung" / "hoàn" chỉ ra hạng mục thường (hoặc không có), không ra "Bổ sung hoàn cọc" / "Hoàn cọc khách".
      const partial = await create([item({ category: 'bổ sung', content: 'khoản lẻ' })]);
      assert.equal(partial.kind, 'preview', JSON.stringify(partial));
      assert.equal(partial.preview.items[0].category, 'Bổ sung vật tư');
      const hoan = await create([item({ category: 'hoàn', content: 'khoản lẻ' })]);
      assert.deepEqual([hoan.kind, hoan.why, hoan.candidates], ['needs_input', 'not_visible', []]);
      assert.deepEqual(await trace4(), before, 'không phiếu, không biên nhận');

      // Lượt 2 kiểm lại: nội dung luồng hệ thống ở lệnh ghi ⇒ web_only; bản đã giải giả trỏ hạng mục luồng hệ thống ⇒ not_allowed.
      const p = await create([item()]);
      assert.equal(p.kind, 'preview');
      assert.deepEqual(await run('expense.create', 'apply', rid(n13++), { items: [item({ content: 'trả lương tháng 10' })] }, { resolved: p.resolved, basis: p.basis }),
        web('/finance/salary'));
      assert.deepEqual(await run('expense.create', 'apply', rid(n13++), { items: [item()] },
        { resolved: { items: [{ ...p.resolved.items[0], typeId: MONEY_FLOW }] }, basis: p.basis }), { kind: 'rejected', reason: 'not_allowed' });
      assert.deepEqual(await trace4(), before, 'lượt 2 bị chặn không ghi');

      // Sửa: phiếu đang mang hạng mục luồng hệ thống (lập trên web) ⇒ web_only + link trang phiếu; đổi sang hạng mục / nội dung luồng hệ thống ⇒ chặn.
      const refund = await voucher('PC2610951', { typeId: MONEY_FLOW, name: 'trả khách P101' });
      assert.deepEqual(await run('expense.edit', 'preview', rid(n13++), { voucherCode: 'PC2610951', amount: 250000, reason: 'ghi nhầm số tiền' }),
        web(`/income-expense/voucher/${refund}`));
      assert.deepEqual(await run('expense.edit', 'preview', rid(n13++), { voucherCode: 'PC2610951', payee: 'khách P101' }), web(`/income-expense/voucher/${refund}`));
      await voucher('PC2610952');
      assert.deepEqual(await run('expense.edit', 'preview', rid(n13++), { voucherCode: 'PC2610952', content: 'hoàn cọc khách P101' }), web('/deposits'));
      assert.deepEqual(await run('expense.edit', 'preview', rid(n13++), { voucherCode: 'PC2610952', category: 'Bổ sung hoàn cọc', reason: 'đổi hạng mục cho đúng' }),
        web('/deposits'));
      assert.equal((await run('expense.edit', 'preview', rid(n13++), { voucherCode: 'PC2610952', content: 'mua bóng đèn hành lang' })).kind, 'preview', 'sửa thường vẫn chạy');
    });
    // Gợi ý dùng chung với web Báo chi nhanh không đổi (không gợi ý hạng mục system_only); danh sách dòng tiền giữ bằng nhau.
    const shared = (await db.query("SELECT public.ie_category_suggest_v1($1,'[{\"text\":\"chi hoa hồng môi giới\"}]'::jsonb,'expense',false)->0 s", [ORG])).rows[0].s;
    assert.notEqual(shared?.typeId, SYSTEM);
    const list = sql => /c_money_flow CONSTANT text\[\]:=ARRAY\[([^\]]+)\]/.exec(sql)?.[1];
    assert.equal(list(FLOW), list(RULES), 'danh sách dòng tiền của hàm chọn hạng mục (lượt 13) = của gợi ý dùng chung');
    assert.equal(list(ROUND1), list(RULES), 'danh sách dòng tiền của hàm chọn hạng mục (lượt 14) = của gợi ý dùng chung');
  });

  let n15 = 680;
  await t.test('Lượt 15: khoản THU qua expense.create ("thu 200k giữ xe") ⇒ web_only + link /income-expense; khoản chi có chữ "thu" (bỏ dấu) không dính; đột biến bị bắt', async () => {
    const flowOf = async text => (await db.query('SELECT public.hermes_expense_system_flow_v1($1) f', [text])).rows[0].f;
    const INCOME = ['Thu 200k giữ xe', 'thu 200k giu xe', 'thu 200.000 giữ xe tháng 10', 'tiền thu giữ xe phòng 201', 'Khoản thu điện nước tháng 10', 'Phiếu thu tiền internet',
      'thu tiền rác tháng 10', 'thu phí giữ xe', 'thu nợ phòng 101', 'thu 2tr tiền phòng', 'thu 1,5tr tiền điện', 'đã thu 150k giữ xe của khách P201', 'Thu tiền phòng 101'];
    // Âm: phiếu CHI lập tay thật của production có chữ "thu" (bỏ dấu trùng thứ / thử / thủ / thư / thù), và cụm cấm của đề.
    const EXPENSE = ['chi thu gom rác', 'phí thu hộ tiền điện', 'tiền thuê nhà tháng 10', 'mua thuốc diệt côn trùng', 'mua thùng rác', 'thu âm quảng cáo', 'tiền thù lao CTV',
      'tiền thủ tục tạm trú', 'thứ 7 mua nước uống', 'thử máy bơm nước', 'thu chi điện lạnh - vệ sinh máy lạnh', 'Hoàn tác thu tiền',
      'anh A lấy lại tiền mặt 7 phòng thu hộ', 'Thưởng deal chương trình - deal thứ 3', 'thu gom rác tháng 10', 'thu mua phế liệu', 'Kết sổ quỹ chị Thu T5 + T6',
      'nộp tiền điện nước đã thu của khách cho EVN', 'chi thu gom rác phòng của khách', 'mua vòi nước', 'thu hộ tiền điện cho chủ nhà'];
    const check = async label => {
      const miss = [], hit = [];
      for (const text of INCOME) if (JSON.stringify(await flowOf(text)) !== JSON.stringify({ flow: 'income', link: '/income-expense' })) miss.push(text);
      for (const text of EXPENSE) if (await flowOf(text) !== null) hit.push(text);
      return { label, miss, hit, deposit: [(await flowOf('thu tiền cọc phòng 101'))?.flow, (await flowOf('thu cọc khách P202'))?.flow] };
    };
    assert.deepEqual(await check('sau file'), { label: 'sau file', miss: [], hit: [], deposit: ['deposit', 'deposit'] });

    await f.rollbackCase(async () => {
      await voucher('PC2610961');
      const before = await trace4();
      const create = items => run('expense.create', 'preview', rid(n15++), { items });
      const web = { kind: 'rejected', reason: 'web_only', link: '/income-expense' };
      assert.deepEqual(await create([item({ category: undefined, content: 'Thu 200k giữ xe' })]), web, 'nghiệm thu: trước cả khi hỏi hạng mục');
      assert.deepEqual(await create([item({ content: 'tiền thu giữ xe phòng 201' })]), web, 'nêu hạng mục chi vẫn chặn');
      assert.deepEqual(await create([item({ category: 'Thu tiền giữ xe', content: 'tháng 10' })]), web, 'hạng mục nêu là khoản thu');
      assert.deepEqual(await create([item({ buildingName: 'Toà Z', content: 'thu 200k giữ xe' })]), web, 'trước khi hỏi lại toà');
      assert.deepEqual(await create([item(), item({ content: 'thu 150k giữ xe' })]), { ...web, item: 2 }, 'lô nói khoản số mấy');
      assert.equal((await create([item({ content: 'chi thu gom rác tháng 10' })])).kind, 'preview', 'khoản chi có chữ "thu" vẫn lập được');
      // Lượt 2 kiểm lại cùng luật; sửa phiếu sang nội dung khoản thu ⇒ chặn.
      const p = await create([item()]);
      assert.equal(p.kind, 'preview');
      assert.deepEqual(await run('expense.create', 'apply', rid(n15++), { items: [item({ content: 'thu 200k giữ xe' })] }, { resolved: p.resolved, basis: p.basis }), web);
      assert.deepEqual(await run('expense.edit', 'preview', rid(n15++), { voucherCode: 'PC2610961', content: 'thu 200k giữ xe' }), web);
      assert.deepEqual(await trace4(), before, 'không phiếu, không biên nhận');
    });

    // Đột biến (mỗi cái trong giao dịch ROLLBACK): thân lượt 13 (trước file) ⇒ khoản thu lọt; bỏ từng nhánh / rào ⇒ đúng ca tương ứng đỏ.
    const statement = sql => { const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.hermes_expense_system_flow_v1(');
      return sql.slice(start, sql.indexOf('\n$fn$;', start) + '\n$fn$;'.length); };
    const live = statement(INCOME15);
    const MUTANTS = [
      ['thân lượt 13', statement(FLOW), r => r.miss.length === INCOME.length],
      ['bỏ nhánh "thu <số tiền>"', live.replace(" OR s.f ~ '^ thu ([0-9]{3,}|[0-9]+ ?(k|tr|trieu|nghin|ngan|d|dong|vnd)|[0-9]+ [0-9]+ ?(k|tr|trieu)) '", ''),
        r => r.miss.includes('Thu 200k giữ xe') && r.miss.includes('thu 2tr tiền phòng')],
      ['bỏ loại trừ sau "tiền / khoản / phiếu thu"', live.replace('(?!(tuc|cong|lao|quy|kho|ky|vien|y|nghiem|am|mua|gom|ho|thuat|tuong|cung|moi|tu|dong|ong|chi)( |$))', ''),
        r => r.hit.includes('tiền thủ tục tạm trú') && r.hit.includes('tiền thù lao CTV')],
      ['bỏ rào "chi / phí thu"', live.replace("\n          AND s.f !~ ' (chi|phi) thu | thu (gom|ho|mua|am|lao|chi) '", ''), r => r.hit.includes('chi thu gom rác phòng của khách')],
      ['"thu" + số không đòi đơn vị', live.replace('([0-9]{3,}|[0-9]+ ?(k|tr|trieu|nghin|ngan|d|dong|vnd)|', '([0-9]+|'), r => r.hit.includes('thứ 7 mua nước uống')],
      ['link khác', live.replace("WHEN 'income' THEN '/income-expense'", "WHEN 'income' THEN '/finance/cashbooks'"), r => r.miss.length === INCOME.length],
    ];
    for (const [label, sql, caught] of MUTANTS) {
      assert.notEqual(sql, live, `${label}: đột biến đổi được thân`);
      let seen;
      await f.rollbackCase(async () => { await db.exec(sql); seen = await check(label); });
      assert(caught(seen), `${label}: bị bắt ${JSON.stringify(seen)}`);
    }
    assert.deepEqual(await check('sau đột biến'), { label: 'sau đột biến', miss: [], hit: [], deposit: ['deposit', 'deposit'] }, 'ROLLBACK trả thân của file');
    // Ghim chéo: không file nào ghim thân bộ phân luồng — chạy lại 120211 ngã ở ghim LÕI GIẢI (do 20261024210500 lượt 16), không phải ở bộ phân
    // luồng; 094809 ngã đúng câu đã có từ 120211 (bộ chọn).
    await f.rollbackCase(async () => {
      await assert.rejects(db.exec(ROUND1), error => error.message === 'hermes_expense_round1_body_drift: app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb)');
    });
    await f.rollbackCase(async () => {
      await assert.rejects(db.exec(FLOW), error => error.message === 'hermes_expense_system_flow_body_drift: public.hermes_expense_category_pick_v1(uuid,text,text)');
    });
    assert.deepEqual(await check('sau chạy lại'), { label: 'sau chạy lại', miss: [], hit: [], deposit: ['deposit', 'deposit'] });
  });

  let n14 = 600;
  await t.test('Lượt 14: "Chi khác" không bao giờ là ứng viên / gợi ý, chỉ nhận khi người dùng nêu (cảnh báo nếu nội dung giống hạng mục khác); nội thất tự nhận', async () => {
    await f.rollbackCase(async () => {
      for (const [j, [name, group, key]] of [['Chi khác (ghi rõ)', 'Khác', 'chi_khac'], ['Nội thất, decor', 'Mua sắm', 'noi_that_decor']].entries())
        await db.query(`INSERT INTO public.income_expense_types(id,organization_id,type,name,category,rule_key,sort_order) VALUES($1,$2,'expense',$3,$4,$5,$6)`,
          [uid(660 + j), ORG, name, group, key, 70 + j]);
      const create = items => run('expense.create', 'preview', rid(n14++), { items });
      // Nghiệm thu: "mua nệm cho phòng 202" từng vào "Chi khác" (ứng viên duy nhất là "Bỏ rác phát sinh"); nay gợi ý dùng chung v3 khoá cứng.
      const bed = await create([item({ category: undefined, content: 'mua nệm cho phòng 202' })]);
      assert.deepEqual([bed.kind, bed.preview?.items[0].category, bed.preview?.items[0].categoryAuto], ['preview', 'Nội thất, decor', 'tự chọn theo nội dung — sửa nếu sai'],
        JSON.stringify(bed));
      for (const content of ['đồ lặt vặt', 'khoản khác', 'chi phí khác']) {
        const out = await create([item({ category: undefined, content })]);
        assert.equal(out.kind, 'needs_input', content);
        assert.ok(!out.candidates.some(c => /khác/i.test(c.name)), `${content}: ${JSON.stringify(out.candidates)}`);
      }
      // Người dùng nêu tên có chữ "khác" ⇒ nhận; nội dung khớp cứng hạng mục khác ⇒ cảnh báo (không chặn).
      const other = await create([item({ category: 'chi khác', content: 'mua nệm cho phòng 202' })]);
      assert.equal(other.preview.items[0].category, 'Chi khác (ghi rõ)');
      assert.ok(other.warnings.includes('Khoản 1: nội dung giống hạng mục "Nội thất, decor" — "Chi khác (ghi rõ)" chỉ dùng khi không mục nào hợp; đổi hạng mục nếu đúng'),
        other.warnings.join('\n'));
      const plain = await create([item({ category: 'Chi khác (ghi rõ)', content: 'khoản linh tinh' })]);
      assert.equal(plain.preview.items[0].category, 'Chi khác (ghi rõ)');
      assert.ok(!plain.warnings.some(w => w.includes('nội dung giống')), 'không khớp cứng ⇒ không cảnh báo');
      assert.equal((await create([item({ category: 'khác', content: 'khoản linh tinh' })])).preview.items[0].category, 'Chi khác (ghi rõ)');
      const chi = await create([item({ category: 'chi', content: 'khoản linh tinh' })]);
      assert.ok(chi.kind !== 'preview' || chi.preview.items[0].category !== 'Chi khác (ghi rõ)', 'không có chữ "khác" ⇒ không ra "Chi khác"');
    });
  });

  await t.test('Lượt 14: voucherCode(s) nhận voucherId (UUID) của báo cáo — đúng phiếu dù mã trùng; ngoài phạm vi ⇒ outside_scope; không có ⇒ not_visible', async () => {
    await f.rollbackCase(async () => {
      const mine = await voucher('PC2610971'), elsewhere = await voucher('PC2610971', { building: OTHER_BUILDING });
      const byId = await run('expense.approve', 'preview', rid(n14++), { voucherCodes: [mine] });
      assert.equal(byId.kind, 'preview', JSON.stringify(byId));
      assert.deepEqual(byId.resolved.vouchers.map(v => v.voucherId), [mine]);
      const outside = await run('expense.approve', 'preview', rid(n14++), { voucherCodes: [elsewhere] });
      assert.deepEqual([outside.kind, outside.field, outside.why], ['needs_input', 'voucher', 'outside_scope']);
      const missing = await run('expense.approve', 'preview', rid(n14++), { voucherCodes: [uid(699)] });
      assert.deepEqual([missing.kind, missing.field, missing.why], ['needs_input', 'voucher', 'not_visible']);
      assert.equal((await run('expense.edit', 'preview', rid(n14++), { voucherCode: mine, content: 'mua bóng đèn LED' })).kind, 'preview', 'sửa theo voucherId');
    });
  });

  let n16 = 760;
  await t.test('Lượt 16: mã trùng giữa các toà + buildingName ⇒ đúng phiếu của toà đó (approve / note / edit / cancel); không khớp ⇒ hỏi như cũ; đột biến bị bắt', async () => {
    await f.rollbackCase(async () => {
      // Hai toà trong phạm vi (như ca lượt 11): Toà A và toà ảo "Kho Văn Phòng Chung"; mã PC2610555 / PC2610556 ở cả hai (TEST: PC2609115 ở 1392QT và 950NK).
      await db.query("INSERT INTO public.buildings VALUES($1,$2,'Kho Văn Phòng Chung',true,null)", [VIRTUAL, ORG]);
      await db.query("INSERT INTO public.fixture_building_access VALUES($1)", [VIRTUAL]);
      await db.query("INSERT INTO public.fixture_staff_assignments VALUES($1,$2)", [USER, VIRTUAL]);
      await db.query("UPDATE public.fixture_acl SET building_ids=building_ids||$1::uuid WHERE NOT ($1::uuid=ANY(building_ids))", [VIRTUAL]);
      await db.query("UPDATE public.authorization_scopes SET scope_type='ORGANIZATION',building_id=NULL WHERE organization_id=$1 AND scope_type='BUILDING'", [ORG]);
      const a5 = await voucher('PC2610555'), v5 = await voucher('PC2610555', { building: VIRTUAL, amount: 150000 });
      const a6 = await voucher('PC2610556'), v6 = await voucher('PC2610556', { building: VIRTUAL, amount: 160000 });
      const only = await voucher('PC2610557');
      const note = (voucherCode, buildingName, n) => run('expense.note', 'auto', rid(n), { voucherCode, note: 'đã lấy hoá đơn', ...(buildingName === undefined ? {} : { buildingName }) });
      const noted = async n => (await db.query('SELECT voucher_id FROM public.fixture_supplements WHERE idempotency_key=$1', ['hermes-note:' + rid(n)])).rows[0]?.voucher_id;
      const ask = await note('PC2610555', undefined, n16);
      assert.deepEqual([ask.kind, ask.why, ask.candidates.length], ['needs_input', 'ambiguous', 2], 'không nêu toà ⇒ hỏi như cũ');
      for (const [label, building, expected] of [['đúng tên', 'Toà A', a5], ['bỏ dấu, có chữ toà', 'toa a', a5], ['chứa ≥ 3 ký tự', 'kho văn phòng', v5],
        ['toà nhà + tên', 'toà nhà Kho Văn Phòng Chung', v5]]) {
        const n = ++n16;
        const done = await note('PC2610555', building, n);
        assert.deepEqual([done.kind, await noted(n)], ['applied', expected], label);
      }
      const unknown = await note('PC2610555', 'Toà Z', ++n16);
      assert.deepEqual([unknown.kind, unknown.why, unknown.candidates.length], ['needs_input', 'ambiguous', 2], 'toà không khớp phiếu nào ⇒ bỏ qua, hỏi lại đủ');
      const short = await note('PC2610555', 'a', ++n16);
      assert.equal(short.kind, 'applied', 'tên toà ngắn chỉ khớp đúng tên (Toà A)');
      const n = ++n16;
      assert.deepEqual([(await note('PC2610557', 'Kho Văn Phòng Chung', n)).kind, await noted(n)], ['applied', only], 'mã chỉ một phiếu ⇒ không đổi gì');
      // Duyệt cả lô của một toà (câu nghiệm thu): một buildingName cho mọi mã.
      const lot = await run('expense.approve', 'preview', rid(++n16), { voucherCodes: ['PC2610555', 'PC2610556'], buildingName: 'Kho Văn Phòng Chung' });
      assert.equal(lot.kind, 'preview', JSON.stringify(lot));
      assert.deepEqual(lot.resolved.vouchers.map(v => v.voucherId), [v5, v6], JSON.stringify({ lot: lot.resolved, a5, v5, a6, v6, only }));
      const lotAsk = await run('expense.approve', 'preview', rid(++n16), { voucherCodes: ['PC2610555', 'PC2610556'] });
      assert.deepEqual([lotAsk.kind, lotAsk.why], ['needs_input', 'ambiguous']);
      // Huỷ / sửa: đúng phiếu; sửa nêu đúng toà của phiếu ⇒ không chuyển toà.
      const cancel = await run('expense.cancel', 'preview', rid(++n16), { voucherCode: 'PC2610556', reason: 'lập trùng phiếu', buildingName: 'Toà A' });
      assert.equal(cancel.kind, 'preview', JSON.stringify(cancel));
      assert.equal(cancel.resolved.voucherId, a6);
      const edit = await run('expense.edit', 'preview', rid(++n16), { voucherCode: 'PC2610556', buildingName: 'Kho Văn Phòng Chung', content: 'mua bóng đèn LED' });
      assert.equal(edit.kind, 'preview', JSON.stringify(edit));
      assert.equal(edit.resolved.voucherId, v6);
      assert.equal(JSON.stringify(edit.preview).includes('"toà"'), false, 'không đổi toà');
      // Toà nêu chỉ có phiếu NGOÀI phạm vi khoá duyệt ⇒ outside_scope (trước đây lặng lẽ chọn phiếu cùng mã ở Toà A); không nêu toà ⇒ như cũ.
      await db.query("UPDATE public.fixture_acl SET building_ids=array_remove(building_ids,$1::uuid) WHERE permission='income_expenses.approve'", [VIRTUAL]);
      const outside = await run('expense.approve', 'preview', rid(++n16), { voucherCodes: ['PC2610555'], buildingName: 'Kho Văn Phòng Chung' });
      assert.deepEqual([outside.kind, outside.field, outside.why], ['needs_input', 'voucher', 'outside_scope'], JSON.stringify(outside));
      const plain = await run('expense.approve', 'preview', rid(++n16), { voucherCodes: ['PC2610555'] });
      assert.deepEqual([plain.kind, plain.resolved?.vouchers.map(v => v.voucherId)], ['preview', [a5]], 'không nêu toà ⇒ hành vi cũ');
      const inScope = await run('expense.approve', 'preview', rid(++n16), { voucherCodes: ['PC2610555'], buildingName: 'Toà A' });
      assert.deepEqual(inScope.resolved?.vouchers.map(v => v.voucherId), [a5]);
      // Đột biến: thân lõi giải của lượt 14 (trước file) ⇒ nêu toà vẫn hỏi chọn phiếu (ca nghiệm thu đỏ).
      const core = sql => { const start = sql.indexOf('CREATE OR REPLACE FUNCTION app_private.hermes_expense_resolve_core_v1(');
        return sql.slice(start, sql.indexOf('\nEND $fn$;', start) + '\nEND $fn$;'.length); };
      await db.exec(core(ROUND1));
      const before = await note('PC2610556', 'Kho Văn Phòng Chung', ++n16);
      assert.deepEqual([before.kind, before.why], ['needs_input', 'ambiguous'], 'đột biến: thân 120211 bỏ qua buildingName');
      const silent = await run('expense.approve', 'preview', rid(++n16), { voucherCodes: ['PC2610555'], buildingName: 'Kho Văn Phòng Chung' });
      assert.deepEqual(silent.resolved?.vouchers.map(v => v.voucherId), [a5], 'đột biến: thân 120211 lặng lẽ chọn phiếu Toà A dù nêu toà khác');
      await db.exec(core(BUILDING16));
      // Ghim chéo: chạy lại 120211 sau file ngã đúng khối $requires$ (ngoại lệ pinned sau áp; 120211 nằm trong diff của C3).
      await db.exec('SAVEPOINT rerun');
      await assert.rejects(db.exec(ROUND1), error => error.message === 'hermes_expense_round1_body_drift: app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb)');
      await db.exec('ROLLBACK TO SAVEPOINT rerun');
    });
  });

  let n19 = 860;
  await t.test('Lượt 19 (J06): sổ người dùng nêu giải TRƯỚC câu hỏi hạng mục — không giữ ⇒ cashbook_not_held, không thấy / mơ hồ ⇒ hỏi sổ; không nêu sổ ⇒ như cũ; luồng hệ thống vẫn thắng; đột biến bị bắt', async () => {
    await f.rollbackCase(async () => {
      // Ca nghiệm thu: quản lý toà chỉ "biết sổ" Chung (thấy, không giữ) và giữ sổ TK939.
      await db.query(`INSERT INTO public.accounts VALUES('${uid(691)}',$1,$2,'Chung','',false,null,null,false),('${uid(692)}',$1,$3,'TK939','939',false,null,null,false)`, [ORG, STRANGER, USER]);
      const create = items => run('expense.create', 'preview', rid(n19++), { items });
      const ask = { category: undefined, content: 'sửa khoá cửa' };
      const plain = await create([item(ask)]);
      assert.deepEqual([plain.kind, plain.field], ['needs_input', 'category'], `không nêu sổ ⇒ hỏi hạng mục như cũ ${JSON.stringify(plain)}`);
      const notHeld = { kind: 'rejected', reason: 'cashbook_not_held' };
      assert.deepEqual(await create([item({ ...ask, cashbook: 'Chung' })]), notHeld, 'nghiệm thu: báo không giữ sổ ngay lượt đầu, trước câu hỏi hạng mục');
      assert.deepEqual(await create([item({ ...ask, cashbook: 'chung' })]), notHeld, 'chữ thường');
      // Lượt sau của kịch bản ("vậy lấy sổ TK939"): sổ giữ ⇒ mới hỏi hạng mục; nêu cả hạng mục ⇒ xem trước trừ đúng sổ đó.
      const held = await create([item({ ...ask, cashbook: 'TK939' })]);
      assert.deepEqual([held.kind, held.field], ['needs_input', 'category'], JSON.stringify(held));
      const done = await create([item({ ...ask, category: 'sửa chữa', cashbook: 'TK939' })]);
      assert.deepEqual([done.kind, done.preview?.items[0].cashbook, done.resolved?.items[0].cashbookId], ['preview', 'TK939', uid(692)], JSON.stringify(done));
      // Sổ không thấy / mơ hồ ⇒ hỏi sổ trước hạng mục (ứng viên = sổ đang giữ khớp tên, như cũ).
      assert.deepEqual(await create([item({ ...ask, cashbook: 'sổ zzz' })]),
        { kind: 'needs_input', reason: 'name_unresolved', field: 'cashbook', wanted: 'sổ zzz', why: 'not_visible', candidates: [], more: false });
      assert.deepEqual(await create([item({ ...ask, cashbook: 'quỹ' })]),
        { kind: 'needs_input', reason: 'name_unresolved', field: 'cashbook', wanted: 'quỹ', why: 'ambiguous', candidates: [{ name: 'Quỹ VCB 0123456789' }], more: false },
        'hai sổ khớp, chỉ sổ đang giữ là ứng viên');
      // Lô: khoản nói số mấy; khoản trước còn thiếu hạng mục (không nêu sổ) ⇒ vẫn hỏi khoản đó trước (thứ tự khoản không đổi).
      assert.deepEqual(await create([item(), item({ ...ask, cashbook: 'Chung' })]), { ...notHeld, item: 2 });
      const first = await create([item(ask), item({ cashbook: 'Chung' })]);
      assert.deepEqual([first.kind, first.field, first.item], ['needs_input', 'category', 1], JSON.stringify(first));
      // Luồng hệ thống / khoản THU vẫn thắng sổ không giữ (không làm qua bot dù sổ nào): theo chữ (bước ghi chặn trước lõi giải) và theo
      // rule_key của hạng mục nêu tên (chỉ bộ chọn hạng mục thấy — rào web_only đứng trước sổ trong lõi giải).
      assert.deepEqual(await create([item({ category: 'hoa hồng', cashbook: 'Chung' })]), { kind: 'rejected', reason: 'web_only', link: '/contracts' });
      assert.deepEqual(await create([item({ category: undefined, content: 'Thu 200k giữ xe', cashbook: 'Chung' })]), { kind: 'rejected', reason: 'web_only', link: '/income-expense' });
      await db.query("INSERT INTO public.income_expense_types(id,organization_id,type,name,rule_key,sort_order) VALUES($1,$2,'expense','Đối tác giới thiệu','hhmg',90)", [uid(693), ORG]);
      assert.equal((await db.query("SELECT public.hermes_expense_system_flow_v1('Đối tác giới thiệu') f")).rows[0].f, null, 'chữ không phải luồng — chỉ rule_key');
      assert.deepEqual(await create([item({ category: 'đối tác giới thiệu', content: 'khoản tháng 10', cashbook: 'Chung' })]),
        { kind: 'rejected', reason: 'web_only', link: '/contracts' });
      // Không nêu sổ và không giữ sổ nào: thiếu hạng mục ⇒ vẫn hỏi hạng mục trước; đủ hạng mục ⇒ cashbook_not_held (như cũ).
      await db.query('UPDATE public.accounts SET deleted_at=now() WHERE user_id=$1', [USER]);
      const none = await create([item(ask)]);
      assert.deepEqual([none.kind, none.field], ['needs_input', 'category'], JSON.stringify(none));
      assert.deepEqual(await create([item()]), notHeld);
      await db.query('UPDATE public.accounts SET deleted_at=NULL WHERE user_id=$1', [USER]);

      // Đột biến: thân lõi giải của lượt 16 (trước file) ⇒ hỏi hạng mục, không nói gì về sổ (ca nghiệm thu đỏ).
      const core = sql => { const start = sql.indexOf('CREATE OR REPLACE FUNCTION app_private.hermes_expense_resolve_core_v1(');
        return sql.slice(start, sql.indexOf('\nEND $fn$;', start) + '\nEND $fn$;'.length); };
      await db.exec(core(BUILDING16));
      const before = await create([item({ ...ask, cashbook: 'Chung' })]);
      assert.deepEqual([before.kind, before.field], ['needs_input', 'category'], 'đột biến: thân 210500 hỏi hạng mục trước sổ');
      await db.exec(core(CASHBOOK19));
      assert.deepEqual(await create([item({ ...ask, cashbook: 'Chung' })]), notHeld);
      // Ghim chéo: chạy lại 210500 sau file ngã đúng khối $requires$ (ngoại lệ pinned sau áp; 210500 ngoài diff). Thân lạ ⇒ file từ chối.
      await db.exec('SAVEPOINT rerun');
      await assert.rejects(db.exec(BUILDING16), error => error.message === 'hermes_expense_voucher_building_body_drift: app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb)');
      await db.exec('ROLLBACK TO SAVEPOINT rerun');
      await db.exec(core(ROUND1));
      await assert.rejects(db.exec(CASHBOOK19), error => error.message === 'hermes_expense_cashbook_first_body_drift: app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb)');
      await db.exec('ROLLBACK TO SAVEPOINT rerun');
    });
  });

  await t.test('Lượt 14: hạng mục chi theo trần (TRAN) ⇒ bản xem trước nêu trần một phiếu, trong / VƯỢT trần, không nói "cam kết còn lại"', async () => {
    await f.rollbackCase(async () => {
      await db.query("UPDATE public.income_expense_types SET spend_mode='TRAN' WHERE id=$1", [WATER]);
      await db.query("INSERT INTO public.fixture_commitments VALUES($1,'nuoc','2026-10-01',1200000)", [BUILDING]);
      const water = amount => run('expense.create', 'preview', rid(n14++), { items: [item({ category: 'đóng tiền nước', content: 'tiền nước tháng 10', amount, period: '2026-10', roomName: undefined })] });
      const none = await water(1200000);
      assert.equal(none.preview.items[0].commitment, 'Hạng mục "Đóng tiền nước" chi theo trần, không trừ cam kết: chủ chưa công bố trần cho hạng mục này');
      await db.query(`INSERT INTO app_private.utility_ceiling_versions(organization_id,building_id,utility_type,ceiling_amount,effective_from_month) VALUES
        ($1,NULL,'WATER',900000,'2026-01-01'),($1,$2,'WATER',1500000,'2026-09-01'),($1,$2,'WATER',2000000,'2026-11-01'),($1,$2,'ELECTRIC',100,'2026-09-01')`, [ORG, BUILDING]);
      const within = await water(1200000);
      assert.equal(within.preview.items[0].commitment, 'Hạng mục "Đóng tiền nước" chi theo trần, không trừ cam kết: trần 1.500.000đ một phiếu — khoản này trong trần',
        'trần theo toà thắng trần cả công ty; bản tháng sau chưa hiệu lực');
      assert.ok(!within.warnings.some(w => w.includes('cam kết')), within.warnings.join('\n'));
      const over = await water(1800000);
      assert.equal(over.preview.items[0].commitment, 'Hạng mục "Đóng tiền nước" chi theo trần, không trừ cam kết: trần 1.500.000đ một phiếu — khoản này VƯỢT trần 300.000đ');
      assert.ok(over.warnings.includes('Khoản 1: vượt trần chi "Đóng tiền nước" 1.500.000đ một phiếu'), over.warnings.join('\n'));
    });
  });

  await t.test('rào: sàn money không nới được; action/phase NULL; catalog và quyền thực thi', async () => {
    await assert.rejects(db.query("UPDATE app_private.hermes_action_policies SET confirm='never' WHERE action='expense.create'"), code('23514'));
    for (const phase of [null, 'write']) await assert.rejects(run('expense.create', phase, rid(30), { items: [item()] }), code('22023'));
    await assert.rejects(run(null, 'preview', rid(31), { items: [item()] }), code('42501'));
    await assert.rejects(run('expense.reject', 'preview', rid(32), { voucherCodes: ['PC2610001'] }), code('42501'), 'chưa có dòng chính sách ⇒ không tồn tại');
    await assert.rejects(db.query("UPDATE app_private.hermes_action_policies SET confirm='never' WHERE action IN ('expense.edit','expense.cancel','expense.approve')"), code('23514'));
    // Mốc 5: khoá Hermes riêng (seed TẮT ở 20261021134531; migration không bật), quyền CRM giao vào = income_expenses.approve (Q25).
    assert.deepEqual((await db.query("SELECT capability,crm_permission,action_class,confirm FROM app_private.hermes_action_policies WHERE action='expense.approve'")).rows,
      [{ capability: 'income_expenses.approve_vouchers', crm_permission: 'income_expenses.approve', action_class: 'money', confirm: 'always' }]);
    assert.doesNotMatch(APPROVE, /hermes_capabilities\s+SET|action_capabilities\s*=/i, 'migration Mốc 5 không bật khoá nào');
    await f.rollbackCase(async () => {
      await db.query("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='income_expenses.approve_vouchers'");
      await assert.rejects(run('expense.approve', 'preview', rid(34), { voucherCodes: ['PC2610001'] }), code('42501'), 'khoá tắt ⇒ guard từ chối');
    });
    // Khoá tắt (trạng thái production, Q4) ⇒ guard từ chối trước khi giải tên.
    await f.rollbackCase(async () => {
      await db.query("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='income_expenses.create'");
      await assert.rejects(run('expense.create', 'preview', rid(33), { items: [item()] }), code('42501'));
    });
    const acl = (await db.query(`SELECT p.oid::regprocedure::text fn,p.prosecdef,p.prosqlbody IS NOT NULL standard,has_function_privilege('authenticated',p.oid,'EXECUTE') auth,
      has_function_privilege('anon',p.oid,'EXECUTE') anon FROM pg_proc p WHERE p.proname LIKE 'hermes_expense_%' AND p.proname NOT IN ('hermes_expense_action_v1','hermes_expense_capabilities_v1',
      'hermes_expense_category_ok_v1','hermes_expense_cashbook_ok_v1') ORDER BY 1`)).rows;
    assert.deepEqual(acl.map(r => [r.fn.replace(/\(.*/, ''), r.prosecdef, r.standard, r.auth, r.anon]), [
      ['app_private.hermes_expense_create_run_v1', true, false, false, false], ['app_private.hermes_expense_manual_v1', true, false, false, false],
      ['app_private.hermes_expense_reason_v1', false, false, false, false],
      ['app_private.hermes_expense_resolve_core_v1', false, false, true, false], ['app_private.hermes_expense_scope_v1', true, false, true, false],
      ['app_private.hermes_expense_write_step_v1', true, false, true, false], ['hermes_expense_category_pick_v1', false, false, true, false],
      ['hermes_expense_system_flow_v1', false, false, true, false], ['hermes_expense_write_v1', false, true, true, false]]);
  });
});
