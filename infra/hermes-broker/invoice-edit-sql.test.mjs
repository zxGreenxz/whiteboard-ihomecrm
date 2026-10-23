import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { invoiceSetup, rid, uid, ORG, USER, STRANGER, BUILDING, OTHER_BUILDING, INV_A, INV_B, INV_C, INV_D9, INV_D10, INV_E, INV_P, INV_S, INV_X, INV_X2,
  INV_O, ADJ_P, LINE_RENT, LINE_ELEC, LINE_WATER, LINE_PDV, LINE_PARK, ROOM, OTHER_ROOM, WRITER_BODIES } from './invoice-write-fixture.mjs';

// Đợt 3 Hoá đơn Mốc 5 (HOA-DON-THAO-TAC-GHI.md mục 4.3–4.5, 6.3) trên PGlite: hàm dùng chung public.invoice_adjustment_build_v1 và bốn thao
// tác invoice.adjust / invoice.adjustment_check / invoice.cancel / invoice.restore của RPC trang (migration THẬT, mỗi file hai lượt). Thân
// production của review / huỷ / khôi phục / khoá hợp đồng / dựng-làm tròn dòng chạy nguyên văn; adjust_invoice_v2 là bản port cùng câu lỗi.
// Ca dựng dòng chép từ src/lib/__tests__/invoiceAdjustmentEntry.test.ts (luật toAdjustmentItem + adjustmentReconcileBlocker của web).
// Khoá không chờ đo ở invoice-edit-race-sql.test.mjs (PG17 hai kết nối).
const code = expected => error => error.code === expected;
const md5 = text => createHash('md5').update(text.replaceAll('\r', ''), 'utf8').digest('hex');
const reason = 'Khách báo sai tiền phòng, giảm lại';

test('hàm dựng dòng điều chỉnh dùng chung (web + trợ lý): luật dòng giữ nguyên, khoá dòng, thao tác, chặn nợ cũ/thanh lý', { timeout: 300000 }, async t => {
  const { db, call } = await invoiceSetup(t, { edit: true });
  const build = (invoice, ops = {}) => call('SELECT public.invoice_adjustment_build_v1($1::uuid,$2::jsonb) result', [invoice, JSON.stringify(ops)]);
  const item = (b, id) => b.before.items.find(i => i.id === id);

  await t.test('dòng giữ nguyên = toAdjustmentItem; khoá theo chỉ số, chữ điện/nước (cả chữ hoa), cọc; mong đợi = ba giá trị khoá lạc quan', async () => {
    const b = await build(INV_A);
    assert.deepEqual(b.blockers, []);
    assert.deepEqual(b.before.items.map(i => i.id), [LINE_RENT, LINE_ELEC, LINE_WATER, LINE_PDV, LINE_PARK]);
    // Thành tiền đã lưu lệch đơn giá × SL (gửi xe 100.000 × 1 nhưng lưu 125.000) ⇒ đơn giá = thành tiền, SL 1, hệ số 1 — không thì "giữ nguyên" mất tiền.
    assert.deepEqual([item(b, LINE_PARK).unit_price, item(b, LINE_PARK).quantity, item(b, LINE_PARK).coefficient], [125000, 1, 1]);
    // Dòng không lệch đi nguyên xi (cả chỉ số, hệ số, kỳ, sort_order).
    assert.deepEqual([item(b, LINE_ELEC).unit_price, item(b, LINE_ELEC).quantity, item(b, LINE_ELEC).previous_reading, item(b, LINE_ELEC).current_reading,
      item(b, LINE_ELEC).sort_order], [3500, 50, 1200, 1250, 1]);
    assert.deepEqual(b.before.lines.map(l => l.lock ?? null), [null, 'meter', 'meter', null, null]);
    assert.deepEqual([b.expected.revision, b.expected.paid, b.before.total, b.after.subtotal, b.after.discount], [0, 0, 3650000, 3650000, 0]);
    assert.deepEqual(b.after.items, b.before.items);
    assert.deepEqual(b.changed, []);
  });

  await t.test('thao tác: đặt thành tiền theo id, thêm dòng OTHER/REVENUE cuối danh sách, giảm THÊM; dòng khoá/không có ⇒ blocker; khuôn sai ⇒ 22023', async () => {
    const b = await build(INV_A, { setItems: [{ id: LINE_RENT, amount: 2800000 }], addItems: [{ description: ' Phí sửa khoá ', amount: 200000 }], discountAdd: 50000 });
    assert.deepEqual(b.blockers, []);
    const rent = b.after.items.find(i => i.id === LINE_RENT), added = b.after.items.at(-1);
    assert.deepEqual([rent.unit_price, rent.quantity, rent.coefficient, rent.type, rent.sort_order], [2800000, 1, 1, 'RENT', 0]);
    assert.deepEqual([added.id, added.type, added.accounting_class, added.description, added.unit_price, added.sort_order], [null, 'OTHER', 'REVENUE', 'Phí sửa khoá', 200000, 5]);
    assert.deepEqual([b.after.subtotal, b.after.discount], [3650000, 50000]);
    assert.deepEqual(b.changed.map(c => [c.op, c.description ?? null, c.before ?? null, c.after]),
      [['set', 'Tiền phòng tháng 10/2026', 3000000, 2800000], ['add', 'Phí sửa khoá', null, 200000], ['discount', null, 0, 50000]]);
    assert.deepEqual((await build(INV_A, { setItems: [{ id: LINE_ELEC, amount: 1 }] })).blockers, ['line_locked']);
    assert.deepEqual((await build(INV_A, { setItems: [{ id: LINE_WATER, amount: 1 }] })).blockers, ['line_locked']);
    assert.deepEqual((await build(INV_A, { setItems: [{ id: uid(999), amount: 1 }] })).blockers, ['line_not_found']);
    for (const ops of [{ foo: 1 }, { discountAdd: -1 }, { discountAdd: '5000' }, { addItems: [{ description: 'x', amount: 0 }] }, { addItems: [{ amount: 1 }] },
      { setItems: [{ id: LINE_PDV, amount: 1 }, { id: LINE_PDV, amount: 2 }] }, { setItems: [{ id: 'abc', amount: 1 }] }, { setItems: {} }])
      await assert.rejects(build(INV_A, ops), code('22023'), JSON.stringify(ops));
  });

  await t.test('chặn cả hoá đơn = adjustmentReconcileBlocker của web: nợ cũ lệch/không nguồn, nguồn lạ, thanh lý; chưa phát hành; không thấy', async () => {
    const debt = async (previous, sources, kind = 'MONTHLY', status = 'APPROVED') => {
      await db.query('UPDATE public.invoices SET previous_debt=$2,previous_debt_sources=$3::jsonb,kind=$4,status=$5 WHERE id=$1', [INV_B, previous, JSON.stringify(sources), kind, status]);
      return (await build(INV_B)).blockers;
    };
    assert.deepEqual(await debt(100000, []), ['debt_source_mismatch']);
    assert.deepEqual(await debt(100000, [{ type: 'invoice', id: 'x', amount: 60000, label: 'a' }]), ['debt_source_mismatch']);
    assert.deepEqual(await debt(100000, [{ type: 'invoice', id: 'x', amount: 40000 }, { type: 'deposit', contract_id: 'c', amount: 60000 }]), []);
    assert.deepEqual(await debt(0, []), []);
    // Number(s.amount) của web: null/'' ⇒ 0, chuỗi số ⇒ số; chữ, thiếu, âm hay loại lạ ⇒ không hợp lệ.
    assert.deepEqual(await debt(30000, [{ type: 'invoice', amount: '30000' }, { type: 'deposit', amount: null }, { type: 'deposit', amount: '' }]), []);
    for (const bad of [[{ type: 'invoice', amount: 'abc' }], [{ type: 'invoice' }], [{ type: 'x', amount: 1 }], [{ type: 'invoice', amount: -1 }], ['invoice']])
      assert.deepEqual(await debt(1, bad), ['debt_source_invalid'], JSON.stringify(bad));
    assert.deepEqual(await debt(0, [], 'SETTLEMENT'), ['settlement']);
    assert.deepEqual(await debt(0, [], 'MONTHLY', 'DRAFT'), ['not_issued']);
    assert.deepEqual((await build(INV_E)).blockers, ['debt_source_mismatch']);
    assert.deepEqual((await build(INV_D10)).blockers, []);
    await db.query("UPDATE public.invoices SET deleted_at=now(),kind='MONTHLY',status='APPROVED' WHERE id=$1", [INV_B]);
    assert.deepEqual((await build(INV_B)).blockers, ['not_found']);
    assert.deepEqual(await db.query("SELECT has_function_privilege('anon','public.invoice_adjustment_build_v1(uuid,jsonb)','EXECUTE') anon,"
      + "has_function_privilege('authenticated','public.invoice_adjustment_build_v1(uuid,jsonb)','EXECUTE') auth").then(r => r.rows[0]), { anon: false, auth: true });
  });
});

test('invoice.adjust: chạy thử adjust_invoice_v2, ghi, phát lại, khớp dòng theo mô tả, dòng khoá, lý do lỗi của hàm ghi', { timeout: 300000 }, async t => {
  const { db, editRun, editApply } = await invoiceSetup(t, { edit: true });
  const adjust = (extra = {}) => ({ buildingName: 'toa a', roomName: 'p101', reason, ...extra });
  const run = (phase, requestId, params, extra) => editRun('invoice.adjust', phase, requestId, params, extra);
  const state = async (invoice = INV_A) => (await db.query(`SELECT i.total_amount::bigint::text total,i.discount_amount::bigint::text discount,i.adjustment_revision::int rev,
    i.adjustment_review_status review,i.status,(SELECT count(*)::int FROM public.invoice_adjustments a WHERE a.invoice_id=i.id) adjustments,
    (SELECT string_agg(it.description||'='||it.amount::bigint,'|' ORDER BY it.sort_order) FROM public.invoice_items it WHERE it.invoice_id=i.id) items,
    (SELECT count(*)::int FROM app_private.hermes_action_receipts) receipts FROM public.invoices i WHERE i.id=$1`, [invoice])).rows[0];
  const reject = async (params, expected, extra) => { const r = await run('preview', rid(199), params, extra); assert.deepEqual([r.kind, r.reason], ['rejected', expected], JSON.stringify(r)); };

  await t.test('xem trước = chạy thử hàm ghi rồi lùi (0 dấu vết); ghi đúng khoá hermes-adj:, chờ kiểm; phát lại; requestId đã dùng ⇒ request_conflict', async () => {
    const before = await state();
    const preview = await run('preview', rid(100), adjust({ discount: 100000 }));
    assert.equal(preview.kind, 'preview', JSON.stringify(preview));
    assert.equal(preview.preview.summary, 'Sẽ ĐIỀU CHỈNH hoá đơn INV-A-10 (Toà A/P101, kỳ 10/2026): tổng 3.650.000đ → 3.550.000đ (−100.000đ). Lý do: «'
      + `${reason}». Đã thu 0đ; trạng thái sau: chưa thu. Điều chỉnh sẽ chờ người có quyền xác nhận đã kiểm tra.`);
    assert.deepEqual(preview.preview.items, [{ text: 'Giảm trừ: 0đ → 100.000đ' }]);
    assert.deepEqual([preview.preview.totalBefore, preview.preview.totalAfter, preview.confirm], ['3650000', '3550000', 'required']);
    assert.deepEqual(await state(), before, 'chạy thử không để lại điều chỉnh, dòng, tiền hay biên nhận');
    const applied = await editApply('invoice.adjust', rid(100), adjust({ discount: 100000 }), preview);
    assert.equal(applied.kind, 'applied', JSON.stringify(applied));
    assert.deepEqual([applied.result.revision, applied.result.reviewStatus, applied.result.totalAfter, applied.result.delta, applied.link],
      [1, 'PENDING', '3550000', '-100000', `/invoices/${INV_A}`]);
    assert.match(applied.result.text, /^Đã điều chỉnh hoá đơn INV-A-10 \(Toà A\/P101, kỳ 10\/2026\): tổng 3\.650\.000đ → 3\.550\.000đ\. Điều chỉnh lần 1 chờ/);
    const after = await state();
    assert.deepEqual([after.total, after.discount, after.rev, after.review, after.adjustments, after.receipts], ['3550000', '100000', 1, 'PENDING', 1, before.receipts + 1]);
    assert.equal(after.items, before.items, 'dòng giữ nguyên (gửi xe vẫn 125.000)');
    const row = (await db.query('SELECT idempotency_key k,reason,adjusted_by FROM public.invoice_adjustments WHERE invoice_id=$1', [INV_A])).rows[0];
    assert.deepEqual(row, { k: `hermes-adj:${rid(100)}`, reason, adjusted_by: USER });
    assert.deepEqual(await editApply('invoice.adjust', rid(100), adjust({ discount: 100000 }), preview), applied, 'phát lại đúng kết quả đã chốt');
    const conflict = await editApply('invoice.adjust', rid(100), adjust({ discount: 200000 }), preview);
    assert.deepEqual([conflict.kind, conflict.reason], ['rejected', 'request_conflict']);
    assert.equal((await state()).adjustments, 1);
  });

  await t.test('đặt thành tiền theo mô tả (bỏ dấu, khớp một phần) + thêm khoản; cảnh báo đang chờ kiểm; basis lệch ⇒ state_changed, không ghi', async () => {
    const params = adjust({ setItems: [{ match: 'tien phong', amount: 2800000 }], addItems: [{ description: 'Phí sửa khoá', amount: 200000 }] });
    const preview = await run('preview', rid(101), params);
    assert.equal(preview.kind, 'preview', JSON.stringify(preview));
    assert.deepEqual(preview.resolved.setItemIds, [LINE_RENT]);
    assert.deepEqual(preview.preview.items.map(i => i.text), ['«Tiền phòng tháng 10/2026»: 3.000.000đ → 2.800.000đ', 'Thêm «Phí sửa khoá»: 200.000đ']);
    assert.match(preview.preview.summary, /tổng 3\.550\.000đ → 3\.550\.000đ \(không đổi tổng\)/);
    assert.deepEqual(preview.warnings, ['Hoá đơn đang có một điều chỉnh chờ xác nhận kiểm tra; điều chỉnh mới thay chỗ, người kiểm sẽ xem bản mới.']);
    await db.query("UPDATE public.invoices SET notes='web vừa sửa',updated_at=clock_timestamp() WHERE id=$1", [INV_A]);
    const stale = await editApply('invoice.adjust', rid(101), params, preview);
    assert.deepEqual([stale.kind, stale.reason], ['rejected', 'state_changed']);
    assert.equal((await state()).adjustments, 1);
    const again = await run('preview', rid(102), params);
    const applied = await editApply('invoice.adjust', rid(102), params, again);
    assert.equal(applied.kind, 'applied', JSON.stringify(applied));
    assert.deepEqual([(await state()).rev, (await state()).items],
      [2, 'Tiền phòng tháng 10/2026=2800000|Tiền điện (1.200 → 1.250)=175000|Tiền Nước (2 người)=200000|Phí dịch vụ=150000|Phí gửi xe máy=125000|Phí sửa khoá=200000']);
  });

  await t.test('dòng mơ hồ/không có ⇒ hỏi lại (ứng viên = mô tả + tiền); dòng điện/nước có chỉ số ⇒ adjust_meter_line_web_only; tham số ⇒ invalid/reason', async () => {
    const vague = await run('preview', rid(103), adjust({ setItems: [{ match: 'phí', amount: 1000 }] }));
    assert.deepEqual([vague.kind, vague.reason, vague.field, vague.why], ['needs_input', 'name_unresolved', 'invoice', 'ambiguous']);
    assert.deepEqual(vague.candidates.map(c => c.name), ['Phí dịch vụ (150.000đ)', 'Phí gửi xe máy (125.000đ)', 'Phí sửa khoá (200.000đ)']);
    const none = await run('preview', rid(104), adjust({ setItems: [{ match: 'internet', amount: 1000 }] }));
    assert.deepEqual([none.kind, none.why, none.candidates.length], ['needs_input', 'not_visible', 6]);
    await reject(adjust({ setItems: [{ match: 'tiền điện', amount: 1000 }] }), 'adjust_meter_line_web_only');
    await reject(adjust({ setItems: [{ match: 'nuoc', amount: 1000 }] }), 'adjust_meter_line_web_only');
    await reject(adjust(), 'invalid_params');
    await reject(adjust({ reason: 'ngắn', discount: 1000 }), 'reason_required');
    await reject(adjust({ setItems: [{ match: 'dịch vụ', amount: 1 }, { match: 'phí dịch vụ', amount: 2 }] }), 'invalid_params');
  });

  await t.test('hàm ghi web là trọng tài: cấn trừ, nợ đã kéo sang kỳ sau, thấp hơn đã thu, thanh lý/nợ cũ lệch, hỗ trợ tiền phòng, kỳ chốt, không đổi', async () => {
    await reject(adjust({ roomName: 'P104', month: '2026-10', discount: 10000 }), 'adjust_has_rounding_or_credit');
    await reject(adjust({ roomName: 'P104', month: '2026-09', discount: 10000 }), 'adjust_debt_carried');
    await reject(adjust({ roomName: 'P103', discount: 100000 }), 'adjust_below_collected');
    await reject(adjust({ roomName: 'P105', discount: 1000 }), 'web_only');
    await db.query("UPDATE public.invoices SET kind='SETTLEMENT' WHERE id=$1", [INV_B]);
    await reject(adjust({ roomName: 'P102', discount: 1000 }), 'web_only');
    await db.query("UPDATE public.invoices SET kind='MONTHLY' WHERE id=$1", [INV_B]);
    for (const [message, state, expected] of [['REVENUE_CAP_REVIEW', 'PT409', 'web_only'], ['[PROFIT_LOCKED] Tháng 10 của toà A đã chốt lợi nhuận', 'P0001', 'period_locked'],
      ['Không có thay đổi nội dung hóa đơn', '22023', 'adjust_no_change'], ['Cơ cấu hóa đơn chưa đối soát; cần kiểm tra kế toán trước khi điều chỉnh', '55000', 'reconciliation_required']]) {
      await db.query('UPDATE public.fixture_edit SET rejected_message=$1,reject_state=$2,reject_action=null', [message, state]);
      await reject(adjust({ roomName: 'P102', discount: 1000 }), expected);
    }
    await db.query('UPDATE public.fixture_edit SET rejected_message=null,reject_state=null');
    // PT409 khác (hoá đơn vừa đổi) không phải lý do: ném lại để connector trả state_changed.
    await db.query("UPDATE public.fixture_edit SET rejected_message='Hóa đơn vừa thay đổi hoặc vừa thu tiền; vui lòng tải lại',reject_state='PT409'");
    await assert.rejects(run('preview', rid(105), adjust({ roomName: 'P102', discount: 1000 })), code('PT409'));
    await db.query('UPDATE public.fixture_edit SET rejected_message=null,reject_state=null');
  });

  await t.test('quyền = biểu thức của hàm ghi ngay ở bản xem trước (guard cho, hàm ghi không): not_allowed; ngoài phạm vi guard / phòng sai ⇒ hỏi lại', async () => {
    const outside = await run('preview', rid(107), { buildingName: 'toa b', roomName: 'p201', reason, discount: 1000 });
    assert.deepEqual([outside.kind, outside.field, outside.why], ['needs_input', 'building', 'outside_scope']);
    await db.query("DELETE FROM public.fixture_invoice_acl WHERE permission='invoices.edit'");
    await reject(adjust({ discount: 1000 }), 'not_allowed');
    const lost = await run('preview', rid(106), adjust({ roomName: 'P999', discount: 1000 }));
    assert.deepEqual([lost.kind, lost.reason], ['needs_input', 'name_unresolved']);
  });
});

test('invoice.adjustment_check: xác nhận điều chỉnh do người khác làm, không tự kiểm (HDN6), không có gì để kiểm', { timeout: 300000 }, async t => {
  const { db, editRun, editApply } = await invoiceSetup(t, { edit: true });
  const run = (phase, requestId, params, extra) => editRun('invoice.adjustment_check', phase, requestId, params, extra);
  const check = (room = 'p107', extra = {}) => ({ buildingName: 'toa a', roomName: room, ...extra });
  const row = async (id = ADJ_P) => (await db.query('SELECT review_status s,checked_by,(SELECT adjustment_review_status FROM public.invoices WHERE id=a.invoice_id) inv FROM public.invoice_adjustments a WHERE id=$1', [id])).rows[0];

  await t.test('xem trước: lần, người làm, giờ, tổng, lý do, dòng đổi; chạy thử không đổi gì; ghi ⇒ CHECKED; phát lại; lần sau ⇒ nothing_to_check', async () => {
    const preview = await run('preview', rid(110), check());
    assert.equal(preview.kind, 'preview', JSON.stringify(preview));
    assert.match(preview.preview.summary, /^Sẽ XÁC NHẬN ĐÃ KIỂM TRA điều chỉnh lần 1 của hoá đơn INV-P-10 \(Toà A\/P107, kỳ 10\/2026\), do Quản lý B làm lúc 15:20 20\/10\/2026 .*: tổng 2\.000\.000đ → 1\.900\.000đ \(−100\.000đ\); lý do «Giảm tiền phòng do sửa chữa»\. Đã thu 0đ\. Xác nhận rồi không bỏ được\.$/);
    assert.deepEqual(preview.preview.items, [{ text: '«Tiền phòng»: 2.000.000đ → 1.900.000đ' }]);
    assert.deepEqual([preview.resolved.adjustmentId, preview.resolved.adjusterName], [ADJ_P, 'Quản lý B']);
    assert.deepEqual(await row(), { s: 'PENDING', checked_by: null, inv: 'PENDING' });
    const applied = await editApply('invoice.adjustment_check', rid(110), check(), preview);
    assert.equal(applied.kind, 'applied', JSON.stringify(applied));
    assert.equal(applied.result.text, 'Đã xác nhận ĐÃ KIỂM TRA điều chỉnh lần 1 của hoá đơn INV-P-10 (Toà A/P107, kỳ 10/2026).');
    assert.deepEqual(await row(), { s: 'CHECKED', checked_by: USER, inv: 'CHECKED' });
    assert.deepEqual(await editApply('invoice.adjustment_check', rid(110), check(), preview), applied);
    const again = await run('preview', rid(111), check());
    assert.deepEqual([again.kind, again.reason], ['rejected', 'nothing_to_check']);
  });

  await t.test('điều chỉnh do chính người hỏi làm ⇒ adjustment_self_check_web_only; phòng không có điều chỉnh chờ ⇒ nothing_to_check; thiếu quyền ⇒ not_allowed', async () => {
    const self = await run('preview', rid(112), check('p108'));
    assert.deepEqual([self.kind, self.reason], ['rejected', 'adjustment_self_check_web_only']);
    const none = await run('preview', rid(113), check('p101'));
    assert.deepEqual([none.kind, none.reason], ['rejected', 'nothing_to_check']);
    // Điều chỉnh vừa đổi phiên bản sau bản xem trước ⇒ state_changed.
    await db.query("UPDATE public.invoice_adjustments SET adjusted_by=$1 WHERE invoice_id=$2", [STRANGER, INV_S]);
    const preview = await run('preview', rid(114), check('p108'));
    assert.equal(preview.kind, 'preview', JSON.stringify(preview));
    await db.query("UPDATE public.invoices SET adjustment_revision=2 WHERE id=$1", [INV_S]);
    const stale = await editApply('invoice.adjustment_check', rid(114), check('p108'), preview);
    assert.deepEqual([stale.kind, stale.reason], ['rejected', 'state_changed']);
    await db.query("UPDATE public.invoices SET adjustment_revision=1 WHERE id=$1", [INV_S]);
    await db.query("DELETE FROM public.fixture_invoice_acl WHERE permission='invoices.approve'");
    const denied = await run('preview', rid(115), check('p108'));
    assert.deepEqual([denied.kind, denied.reason], ['rejected', 'not_allowed']);
  });
});

test('invoice.cancel / invoice.restore: luật hàm ghi web, tiền dư đã cấn, nợ cũ đang gánh, trùng kỳ khi khôi phục', { timeout: 300000 }, async t => {
  const { db, editRun, editApply } = await invoiceSetup(t, { edit: true });
  const cancel = (room, extra = {}) => ({ buildingName: 'toa a', roomName: room, reason: 'Lập nhầm hoá đơn, sẽ lập lại', ...extra });
  const status = async id => (await db.query('SELECT status FROM public.invoices WHERE id=$1', [id])).rows[0].status;
  const reject = async (action, params, expected) => { const r = await editRun(action, 'preview', rid(299), params);
    assert.deepEqual([r.kind, r.reason], ['rejected', expected], JSON.stringify(r)); };

  await t.test('huỷ hoá đơn chưa thu: xem trước (chạy thử lùi), ghi khoá hermes-cancel:, phát lại; huỷ lại ⇒ invoice_already_cancelled', async () => {
    const preview = await editRun('invoice.cancel', 'preview', rid(120), cancel('p102'));
    assert.equal(preview.kind, 'preview', JSON.stringify(preview));
    assert.equal(preview.preview.summary, 'Sẽ HUỶ hoá đơn INV-B-10 (Toà A/P102, kỳ 10/2026), tổng 2.000.000đ, chưa thu đồng nào. Lý do: «Lập nhầm hoá đơn, sẽ lập lại».');
    assert.equal(await status(INV_B), 'APPROVED');
    const applied = await editApply('invoice.cancel', rid(120), cancel('p102'), preview);
    assert.equal(applied.kind, 'applied', JSON.stringify(applied));
    assert.deepEqual([applied.result.status, applied.result.text], ['CANCELLED', 'Đã huỷ hoá đơn INV-B-10 (Toà A/P102, kỳ 10/2026) (tổng 2.000.000đ).']);
    assert.equal(await status(INV_B), 'CANCELLED');
    assert.deepEqual(await editApply('invoice.cancel', rid(120), cancel('p102'), preview), applied);
    await reject('invoice.cancel', cancel('p102', { month: '2026-10' }), 'invoice_already_cancelled');
    // Lý do huỷ chỉ ở biên nhận Hermes (HDN8), không ghi đè ghi chú hoá đơn.
    const receipt = (await db.query("SELECT input->'params'->>'reason' r FROM app_private.hermes_action_receipts WHERE request_id=$1", [rid(120)])).rows[0];
    assert.equal(receipt?.r, 'Lập nhầm hoá đơn, sẽ lập lại');
    assert.equal((await db.query('SELECT notes FROM public.invoices WHERE id=$1', [INV_B])).rows[0].notes, null);
  });

  await t.test('huỷ hoá đơn gánh nợ cũ + có tiền dư đã cấn: cảnh báo nợ cũ tính lại ở kỳ nguồn, tiền dư hoàn khách; đã thu / quá hạn / nguồn credit ⇒ từ chối', async () => {
    const preview = await editRun('invoice.cancel', 'preview', rid(121), cancel('p104', { month: '2026-10' }));
    assert.equal(preview.kind, 'preview', JSON.stringify(preview));
    assert.match(preview.preview.summary, /Tiền dư 50\.000đ của khách đã cấn vào hoá đơn sẽ hoàn lại cho khách/);
    assert.deepEqual(preview.warnings, ['Hoá đơn này đang gánh nợ cũ 1.000.000đ của kỳ 09/2026 (INV-D-09): huỷ thì khoản nợ đó tính lại ở hoá đơn kỳ 09/2026.']);
    const applied = await editApply('invoice.cancel', rid(121), cancel('p104', { month: '2026-10' }), preview);
    assert.deepEqual([applied.kind, applied.result.creditReturned], ['applied', '50000'], JSON.stringify(applied));
    assert.equal((await db.query('SELECT count(*)::int n FROM public.customer_credit_applications WHERE invoice_id=$1 AND reversed_at IS NOT NULL', [INV_D10])).rows[0].n, 1);
    await reject('invoice.cancel', cancel('p104', { month: '2026-09' }), 'cancel_overdue_web_only');
    await reject('invoice.cancel', cancel('p103'), 'cancel_has_payment');
    await db.query("UPDATE public.fixture_edit SET reject_action='cancel_source'");
    await reject('invoice.cancel', cancel('p101'), 'cancel_has_payment');
    await db.query('UPDATE public.fixture_edit SET reject_action=null');
    await reject('invoice.cancel', cancel('p101', { reason: 'ngắn' }), 'reason_required');
  });

  await t.test('khôi phục: hạn đã qua ⇒ cảnh báo, tiền dư cấn lại; trùng kỳ cùng HĐ ⇒ restore_conflict; đang hiệu lực ⇒ invoice_not_cancelled; thiếu quyền', async () => {
    const preview = await editRun('invoice.restore', 'preview', rid(130), cancel('p109', { reason: 'Huỷ nhầm, khách vẫn ở' }));
    assert.equal(preview.kind, 'preview', JSON.stringify(preview));
    assert.equal(preview.preview.summary, 'Sẽ KHÔI PHỤC hoá đơn INV-X-10 (Toà A/P109, kỳ 10/2026) (đang huỷ), tổng 1.200.000đ; hoá đơn trở lại chờ thu. Lý do: «Huỷ nhầm, khách vẫn ở». Tiền dư 50.000đ của khách sẽ cấn lại vào hoá đơn.');
    assert.deepEqual(preview.warnings, ['Hạn thanh toán 15/10/2026 đã qua: khôi phục xong hoá đơn sẽ hiện quá hạn.']);
    assert.equal(await status(INV_X), 'CANCELLED');
    const applied = await editApply('invoice.restore', rid(130), cancel('p109', { reason: 'Huỷ nhầm, khách vẫn ở' }), preview);
    assert.deepEqual([applied.kind, applied.result.status, applied.result.creditReapplied], ['applied', 'APPROVED', '50000'], JSON.stringify(applied));
    assert.equal((await db.query('SELECT count(*)::int n FROM public.customer_credit_applications WHERE invoice_id=$1 AND restored_at IS NOT NULL', [INV_X])).rows[0].n, 1);
    await reject('invoice.restore', cancel('p107'), 'restore_conflict');
    await reject('invoice.restore', cancel('p101'), 'invoice_not_cancelled');
    await db.query("DELETE FROM public.fixture_invoice_acl WHERE permission='invoices.cancel'");
    await reject('invoice.restore', cancel('p107'), 'not_allowed');
    await reject('invoice.cancel', cancel('p101'), 'not_allowed');
  });
});

test('phạm vi bản đã giải, basis, ACL và nguồn thân production của fixture', { timeout: 300000 }, async t => {
  const { db, editRun } = await invoiceSetup(t, { edit: true });
  const params = { buildingName: 'toa a', roomName: 'p101', reason, discount: 1000 };
  const preview = await editRun('invoice.adjust', 'preview', rid(140), params);
  assert.equal(preview.kind, 'preview', JSON.stringify(preview));
  for (const resolved of [{ ...preview.resolved, invoiceId: INV_O }, { ...preview.resolved, buildingId: OTHER_BUILDING }, { ...preview.resolved, roomId: OTHER_ROOM },
    { ...preview.resolved, invoiceId: INV_B }]) {
    const forged = await editRun('invoice.adjust', 'apply', rid(141), params, { resolved, basis: preview.basis });
    assert.deepEqual([forged.kind, forged.reason], ['rejected', 'not_allowed'], JSON.stringify(resolved));
  }
  const wrong = await editRun('invoice.adjust', 'apply', rid(142), params, { resolved: preview.resolved, basis: 'x'.repeat(32) });
  assert.deepEqual([wrong.kind, wrong.reason], ['rejected', 'state_changed']);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.invoice_adjustments WHERE invoice_id=$1', [INV_A])).rows[0].n, 0);
  const acl = (await db.query(`SELECT has_function_privilege('authenticated','app_private.hermes_invoice_edit_reason_v1(text,text,text)','EXECUTE') reason,
    has_function_privilege('authenticated','app_private.hermes_invoice_edit_lookup_v1(uuid,uuid[],text,jsonb)','EXECUTE') lookup,
    has_function_privilege('authenticated','app_private.hermes_invoice_edit_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)','EXECUTE') step,
    has_function_privilege('anon','public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)','EXECUTE') anon`)).rows[0];
  assert.deepEqual(acl, { reason: false, lookup: true, step: true, anon: false });
  // Thân nguyên văn đọc từ production 23/10 (CHỈ ĐỌC): md5 bỏ CR = giá trị đã ghi ở mục 15 của thiết kế; fixture chạy đúng thân đó.
  const expected = { 'public.review_invoice_adjustment_v2': '8503d65ef784942feb3e22a59447489f', 'public.cancel_invoice_with_credit_v1': 'e88972e512dabdfe3afdcf9d0d001cee',
    'public.restore_invoice_with_credit_v1': '871759af885eef3d2608f71423ed938a', 'app_private.invoice_rent_support_lock_v1': 'cb3c691939bd74255569ea39148784b4',
    'app_private.normalize_invoice_adjustment_items_v2': '02b6785468ac4fe866d7bacc84a90703', 'app_private.round_invoice_total_v1': '39274a5375e76130fccc81486bffd449' };
  for (const [name, digest] of Object.entries(expected)) {
    assert.equal(md5(WRITER_BODIES[name].body), digest, name);
    const live = (await db.query("SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname=$1", [name])).rows;
    assert.deepEqual(live.map(r => md5(r.prosrc)), [digest], name);
  }
  assert.ok(ORG && BUILDING && ROOM && INV_C && INV_D9 && INV_E && INV_P && INV_X2 && LINE_PARK);
});
