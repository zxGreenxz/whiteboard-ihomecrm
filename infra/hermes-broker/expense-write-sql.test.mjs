import test from 'node:test';
import assert from 'node:assert/strict';
import { expenseSetup, RULES, EDIT, VIRTUAL, rid, code, PCCC, SYSTEM, CB2, STRANGER, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, CASHBOOK, FOREIGN_CASHBOOK, CATEGORY, ORG, USER } from './expense-write-fixture.mjs';
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
    const vague = await run('expense.create', 'preview', rid(9), { items: [item({ category: undefined, content: 'đồ lặt vặt' })] });
    assert.deepEqual([vague.kind, vague.field, vague.why], ['needs_input', 'category', 'ambiguous']);
    assert.ok(vague.candidates.length > 0 && !vague.candidates.some(c => c.name === 'Hoa hồng môi giới'), 'không đề xuất hạng mục hệ thống');
    assert.deepEqual(await run('expense.create', 'preview', rid(10), { items: [item({ category: 'hoa hồng' })] }),
      { kind: 'needs_input', reason: 'name_unresolved', field: 'category', wanted: 'hoa hồng', why: 'not_visible', candidates: [], more: false });
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
        approval_status,posting_status,payer_name,system_source,salary_staff_id,repeat_parent_id,repeat_cycle)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`, [ORG, v.user, code, v.type, v.name, v.building ?? BUILDING, v.room ?? null,
      v.account, v.date, v.amount, v.status, v.posting, v.payee ?? null, v.system ?? null, v.salary ?? null, v.parent ?? null, v.cycle ?? 'NONE'])).rows[0].id;
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
      // Phiếu đã duyệt ⇒ hàm web từ chối khi chạy thử ⇒ not_pending; phiếu nhiều dòng hạng mục ⇒ đổi tiền làm trên web, đổi nội dung vẫn được.
      await voucher('PC2610503', { status: 'APPROVED', posting: 'POSTED' });
      assert.deepEqual(await run('expense.edit', 'preview', rid(69), { voucherCode: 'PC2610503', content: 'x y z' }), { kind: 'rejected', reason: 'not_pending' });
      await voucher('PC2610504', { amount: 500000, lines: [300000, 200000] });
      assert.deepEqual(await run('expense.edit', 'preview', rid(70), { voucherCode: 'PC2610504', amount: 450000, reason: 'ghi nhầm số tiền' }), { kind: 'rejected', reason: 'web_only' });
      assert.equal((await run('expense.edit', 'preview', rid(71), { voucherCode: 'PC2610504', content: 'hai món' })).kind, 'preview');
      // Lượt 2 đưa bản đã giải giả (toà ngoài phạm vi, phòng toà khác, hạng mục hệ thống, sổ người khác) ⇒ từ chối trước biên nhận.
      const p = await run('expense.edit', 'preview', rid(72), { voucherCode: 'PC2610504', content: 'hai món' });
      const elsewhere = await voucher('PC2610505', { building: OTHER_BUILDING });
      const frozen = await trace4();
      for (const [forged, reason] of [[{ voucherId: elsewhere }, 'not_allowed'], [{ newBuildingId: OTHER_BUILDING, newBuildingName: 'Toà B' }, 'not_allowed'], [{ roomId: OTHER_ROOM }, 'not_allowed'],
        [{ typeId: SYSTEM, typeName: 'x' }, 'not_allowed'], [{ cashbookId: FOREIGN_CASHBOOK, cashbookName: 'x' }, 'cashbook_not_held']])
        assert.deepEqual(await run('expense.edit', 'apply', rid(72), { voucherCode: 'PC2610504', content: 'hai món' }, { resolved: { ...p.resolved, ...forged }, basis: p.basis }),
          { kind: 'rejected', reason }, JSON.stringify(forged));
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
      assert.deepEqual(await run('expense.cancel', 'preview', rid(76), params), { kind: 'rejected', reason: 'not_pending' }, 'đã huỷ');
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
      // "tiền phòng 5 ngày": luật khoá cứng vào "Trả lại tiền thừa cho khách" (dòng tiền) ⇒ hỏi lại, gợi ý đứng đầu; nêu tên thì nhận.
      const suggested = (await db.query("SELECT public.ie_category_suggest_v1($1,'[{\"text\":\"tiền phòng 5 ngày\"}]'::jsonb,'expense',false)->0 s", [ORG])).rows[0].s;
      assert.deepEqual([suggested.typeId, suggested.reason], [MONEY_FLOW, 'rule'], 'luật web khoá cứng');
      const asked = await run('expense.create', 'preview', rid(93), { items: [item({ category: undefined, content: 'tiền phòng 5 ngày' })] });
      assert.deepEqual([asked.kind, asked.field, asked.candidates[0]?.name], ['needs_input', 'category', 'Trả lại tiền thừa cho khách']);
      const named = await run('expense.create', 'preview', rid(94), { items: [item({ category: 'trả lại tiền thừa', content: 'tiền phòng 5 ngày' })] });
      assert.equal(named.preview.items[0].category, 'Trả lại tiền thừa cho khách');
    });
    // Danh sách dòng tiền của Hermes = c_money_flow của ie_category_suggest_v1 (hai file khác nhau, test khoá bằng nhau).
    const list = sql => /c_money_flow CONSTANT text\[\]:=ARRAY\[([^\]]+)\]/.exec(sql)?.[1];
    assert.ok(list(RULES) && list(RULES) === list(EDIT), `${list(RULES)} ≠ ${list(EDIT)}`);
  });

  await t.test('rào: sàn money không nới được; action/phase NULL; catalog và quyền thực thi', async () => {
    await assert.rejects(db.query("UPDATE app_private.hermes_action_policies SET confirm='never' WHERE action='expense.create'"), code('23514'));
    for (const phase of [null, 'write']) await assert.rejects(run('expense.create', phase, rid(30), { items: [item()] }), code('22023'));
    await assert.rejects(run(null, 'preview', rid(31), { items: [item()] }), code('42501'));
    await assert.rejects(run('expense.approve', 'preview', rid(32), { voucherCodes: ['PC2610001'] }), code('42501'), 'chưa có dòng chính sách ⇒ không tồn tại');
    await assert.rejects(db.query("UPDATE app_private.hermes_action_policies SET confirm='never' WHERE action IN ('expense.edit','expense.cancel')"), code('23514'));
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
      ['app_private.hermes_expense_write_step_v1', true, false, true, false], ['hermes_expense_write_v1', false, true, true, false]]);
  });
});
