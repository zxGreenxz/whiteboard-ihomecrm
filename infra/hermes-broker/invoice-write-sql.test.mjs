import test from 'node:test';
import assert from 'node:assert/strict';
// external-group-mount nạp broker.mjs ngược lại: nạp trước (như invoice-actions.test.mjs) — ca J06 chạy broker + runtime thật trên SQL fixture.
import './external-group-mount.mjs';
import { createBroker } from './broker.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { createActionRuntime } from './action-runtime.mjs';
import { INVOICE_COLLECT_KEY, invoiceCatalog } from './invoice-actions-contract.mjs';
import { ACTION_REASON_CODES, ACTION_INPUT_REASONS } from './action-reasons.mjs';
import { invoiceSetup, uid, rid, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, CASHBOOK, ORG, USER, INV_A, INV_A9, INV_B, INV_D10, TK1, TK2, TT1, ROUNDING, CONTRACT, STRANGER,
  J06_SQL, COLLECT_BEFORE_J06 } from './invoice-write-fixture.mjs';

// RPC trang Hoá đơn (Đợt 3 Mốc 3, HOA-DON-THAO-TAC-GHI.md mục 2–5, 4.1) trên PGlite với fixture Hermes của thu chi (binding/phiên/chính
// sách thật của các migration Hermes; quyền CRM giả qua fixture_acl). Hai migration của mốc chạy THẬT (mỗi file hai lượt), hàm kế hoạch dùng
// chung thật, invoice_room_invoices_v1 thật (Mốc 2), nợ thực #267 thật. Hàm ghi web record_invoice_collection_v5 ở đây là BẢN PORT (cùng
// chữ ký, cùng câu lỗi đã liệt kê ở mục 5, idempotency theo khoá + băm, khoá lạc quan p_expected_paid_amount) — nó chứng minh logic của
// bước ghi Hermes (chạy thử không để lại dấu vết, lô cả-hoặc-không, basis, lý do, phạm vi), KHÔNG chứng minh v5 thật: phần đó đo ở tầng 2.
const code = expected => error => error.code === expected;
// Lượt 14 (nghiệm thu C3c, "ck vào HKD Tâm" ghi vào sổ mặc định chuyển khoản): chưa nêu sổ mà toà còn sổ nhận khác ⇒ cảnh báo đứng đầu.
const DEFAULT_BOOK_WARNING = 'Chưa nêu sổ nhận nên dùng sổ mặc định «VCB toà A ***» (TK). Toà còn sổ nhận «MB toà A» (TK), «POS toà A» (TT). Người dùng đã nói '
  + 'sổ/tài khoản nhận khác thì gọi lại kèm cashbookName (máy chủ chọn hình thức theo sổ), KHÔNG xác nhận bản này.';

test('hermes_invoice_action_v1 (invoice.collect): tiền mặt chặn, chạy thử không để lại dấu vết, lô cả-hoặc-không, basis, lý do, phạm vi', { timeout: 300000 }, async t => {
  const f = await invoiceSetup(t, { l14: true });
  const { db, run, applyWith, trace, one } = f;

  await t.test('tiền mặt ⇒ cash_collection_web_only trước mọi tra cứu, cả lượt 2', async () => {
    assert.deepEqual(await run('preview', rid(1), one({ method: 'TM', buildingName: 'không có toà này' })), { kind: 'rejected', reason: 'cash_collection_web_only' });
    assert.deepEqual(await run('apply', rid(1), one({ method: 'TM' }), { resolved: { buildingId: BUILDING }, basis: 'x' }), { kind: 'rejected', reason: 'cash_collection_web_only' });
  });

  await t.test('một phòng, kỳ trống = hoá đơn còn nợ DUY NHẤT; chạy thử v5 rồi lùi; lượt 2 ghi đúng bản đã xem; phát lại', async () => {
    const before = await trace();
    const preview = await run('preview', rid(2), one());
    assert.equal(preview.kind, 'preview', JSON.stringify(preview)); assert.equal(preview.confirm, 'required');
    assert.equal(preview.resolved.items[0].invoiceId, INV_A, 'kỳ 09 đã thu đủ ⇒ chọn kỳ 10');
    assert.match(preview.preview.summary, /^Sổ nhận: «VCB toà A \*\*\*» — chuyển khoản, sổ mặc định của toà \(người dùng chưa nêu sổ\)\. Sẽ ghi THU 3\.650\.000đ ngày 22\/10\/2026 \(thứ Năm, hôm nay\) cho hoá đơn INV-A-10\.$/);
    assert.deepEqual([preview.preview.receivingBook, preview.preview.method], ['VCB toà A ***', 'TK']);
    assert.deepEqual([preview.preview.items[0].amount, preview.preview.items[0].remainingBefore, preview.preview.items[0].remainingAfter, preview.preview.items[0].statusAfter],
      ['3650000', '3650000', '0', 'PAID']);
    assert.match(preview.preview.items[0].text, /Phòng P101 toà Toà A, kỳ 10\/2026 \(INV-A-10\): thu 3\.650\.000đ; còn nợ 3\.650\.000đ → 0đ: ĐÃ THANH TOÁN ĐỦ\./);
    assert.deepEqual(await trace(), before, 'chạy thử không để lại lần thu, khoá idempotency, biên nhận hay tiền');
    const applied = await applyWith(rid(2), one(), preview);
    assert.equal(applied.kind, 'applied', JSON.stringify(applied));
    assert.equal(applied.link, `/invoices/${INV_A}`);
    assert.deepEqual([applied.result.invoices[0].applied, applied.result.invoices[0].statusAfter, applied.result.applied], ['3650000', 'PAID', '3650000']);
    assert.match(applied.result.invoices[0].text, /^Đã ghi thu 3\.650\.000đ bằng chuyển khoản cho hoá đơn INV-A-10 \(Toà A\/P101, kỳ 10\/2026\)\. Hết nợ — ĐÃ THANH TOÁN ĐỦ\.$/);
    const row =(await db.query('SELECT idempotency_key,tenders FROM public.invoice_payment_collections WHERE invoice_id=$1', [INV_A])).rows[0];
    assert.equal(row.idempotency_key, `hermes-inv:${rid(2)}`);
    assert.deepEqual(row.tenders, [{ payment_method: 'TK', gross_amount: 3650000, account_id: TK1 }]);
    assert.deepEqual(await applyWith(rid(2), one(), preview), applied, 'phát lại y nguyên');
    const after = await trace();
    assert.deepEqual([after.collections - before.collections, after.receipts - before.receipts], [1, 1]);
    // Hoá đơn hết nợ ⇒ hỏi lại (needs_input), không phải lỗi.
    assert.deepEqual(await run('preview', rid(3), one({ month: '2026-10' })), { kind: 'rejected', reason: 'nothing_to_collect' });
    assert.ok(ACTION_INPUT_REASONS.includes('nothing_to_collect'));
  });

  await t.test('nợ đã kéo sang kỳ sau (#267): kỳ trống chọn hoá đơn gánh; nêu kỳ cũ ⇒ debt_carried', async () => {
    const preview = await run('preview', rid(4), one({ roomName: 'P104' }));
    assert.equal(preview.resolved.items[0].invoiceId, INV_D10, 'không bao giờ chọn kỳ 09 có nợ đã nằm trong kỳ 10');
    assert.equal(preview.preview.items[0].amount, '2500000');
    assert.deepEqual(await run('preview', rid(5), one({ roomName: 'P104', month: '2026-09' })), { kind: 'rejected', reason: 'debt_carried' });
  });

  // Lượt 14 (nghiệm thu C3c: thu tiền điện tháng cũ, ngày thu 31/08, tháng 08 của toà đã chốt LN ⇒ máy chủ hỏi "kỳ sau" rồi kẹt): ngày thu thuộc
  // tháng đã chốt ⇒ period_closed + facts.month NGAY sau phạm vi — trước nợ đã kéo (debt_carried), sổ nhận, khoá, kế hoạch; cả lượt 2, cả lô.
  // Cùng hàm khoá tháng của trigger phiếu web (thân thật 20260925073251); toà khác / tháng chưa khoá không bị chặn.
  await t.test('lượt 14: ngày thu ở tháng đã chốt lợi nhuận ⇒ period_closed trước debt_carried / sổ / kế hoạch; lượt 2 và lô cũng vậy', async () => {
    await f.rollbackCase(async () => {
      const before = await trace();
      await db.query("INSERT INTO public.profit_monthly(building_id,period_month,locked_at) VALUES($1,'2026-08-01',now()),($2,'2026-10-01',now())", [BUILDING, OTHER_BUILDING]);
      const closed = { kind: 'rejected', reason: 'period_closed', facts: { month: '2026-08' } };
      assert.deepEqual(await run('preview', rid(40), one({ roomName: 'P104', month: '2026-09', date: '2026-08-31' })), closed, 'trước debt_carried');
      assert.deepEqual(await run('preview', rid(41), one({ date: '2026-08-01', cashbookName: 'không có sổ này' })), { kind: 'needs_input', reason: 'name_unresolved',
        field: 'cashbook', wanted: 'không có sổ này', why: 'not_visible', candidates: [{ name: 'VCB toà A *** — chuyển khoản (TK)' }, { name: 'MB toà A — chuyển khoản (TK)' },
          { name: 'POS toà A — thanh toán (TT)' }], more: false },
        'sổ người dùng nêu là tra cứu (trước bước ghi)');
      assert.deepEqual(await run('preview', rid(42), { buildingName: 'toa a', method: 'TT', items: [{ roomName: 'p101' }, { roomName: 'p104' }], date: '2026-08-15' }), closed);
      assert.deepEqual(await run('preview', rid(43), one({ roomName: 'P104', month: '2026-09', date: '2026-09-01' })), { kind: 'rejected', reason: 'debt_carried' },
        'tháng 09 chưa chốt');
      assert.deepEqual(await run('preview', rid(44), one({ date: '2026-10-23' })), { kind: 'rejected', reason: 'date_out_of_range' }, 'ngày tương lai vẫn trước');
      const preview = await run('preview', rid(45), one({ roomName: 'P104', date: '2026-10-20' }));
      assert.equal(preview.kind, 'preview', 'toà A tháng 10 chưa chốt (khoá tháng 10 là của toà B)');
      await db.query("INSERT INTO public.profit_monthly(building_id,period_month,locked_at) VALUES($1,'2026-10-01',now())", [BUILDING]);
      assert.deepEqual(await applyWith(rid(45), one({ roomName: 'P104', date: '2026-10-20' }), preview), { kind: 'rejected', reason: 'period_closed', facts: { month: '2026-10' } },
        'chốt giữa hai lượt ⇒ lượt 2 từ chối, không ghi');
      await db.query("UPDATE public.profit_monthly SET locked_at=NULL WHERE building_id=$1 AND period_month='2026-10-01'", [BUILDING]);
      assert.equal((await run('preview', rid(46), one({ roomName: 'P104', date: '2026-10-20' }))).kind, 'preview', 'mở khoá (locked_at NULL) ⇒ thu được');
      assert.deepEqual(await trace(), before, 'không lần thu, biên nhận hay tiền nào');
    });
  });

  await t.test('khách trả dư: chưa chọn ⇒ bản xem trước HỎI (choiceRequired), lượt 2 không ghi; keep / return', async () => {
    await f.rollbackCase(async () => {
      const params = one({ roomName: 'P104', amount: 2600000 });
      const ask = await run('preview', rid(6), params);
      assert.deepEqual([ask.kind, ask.preview.choiceRequired], ['preview', 'overpay']);
      assert.match(ask.preview.summary, /^Khách trả 2\.600\.000đ, còn nợ 2\.500\.000đ, dư 100\.000đ\. CHƯA chọn: giữ lại cho kỳ sau \(overpay=keep\) hay trả lại khách \(overpay=return\)\?/);
      const before = await trace();
      assert.deepEqual(await applyWith(rid(6), params, ask), { kind: 'rejected', reason: 'overpay_needs_choice' });
      assert.deepEqual(await trace(), before);
      const keep = await run('preview', rid(7), { ...params, overpay: 'keep' });
      assert.match(keep.preview.items[0].text, /dư 100\.000đ giữ lại cho kỳ sau/);
      const applied = await applyWith(rid(7), { ...params, overpay: 'keep' }, keep);
      assert.deepEqual([applied.result.invoices[0].applied, applied.result.invoices[0].credit], ['2500000', '100000']);
      assert.match(applied.result.invoices[0].text, /\. Hết nợ — ĐÃ THANH TOÁN ĐỦ\. Dư 100\.000đ giữ lại cho kỳ sau \(tiền dư của khách\)\.$/);
      // Không gắn hợp đồng ⇒ chỉ trả lại khách được; return ⇒ chỉ ghi đúng số còn nợ.
      const noContract = await run('preview', rid(8), one({ roomName: 'P102', amount: 2100000 }));
      assert.match(noContract.preview.summary, /chỉ trả lại khách được \(overpay=return\)/);
      assert.deepEqual(await run('preview', rid(9), one({ roomName: 'P102', amount: 2100000, overpay: 'keep' })), { kind: 'rejected', reason: 'credit_requires_contract' });
      const ret = await run('preview', rid(10), one({ roomName: 'P102', amount: 2100000, overpay: 'return' }));
      assert.match(ret.preview.items[0].text, /phần dư 100\.000đ KHÔNG ghi vào CRM, anh\/chị tự chuyển trả khách/);
      assert.equal(ret.preview.items[0].amount, '2000000');
    });
  });

  await t.test('thiếu < 10.000đ làm tròn như web; v5 chặn làm tròn (NON_PNL) ⇒ xem trước lại KHÔNG làm tròn, nói rõ', async () => {
    await f.rollbackCase(async () => {
      // Lượt 8: làm tròn ⇒ hoá đơn ĐÃ THANH TOÁN nhưng cột còn nợ (tổng − đã thu) vẫn 5.000đ — không bao giờ nói "ĐỦ" (nghiệm thu 24/10).
      const round = await run('preview', rid(11), one({ roomName: 'P102', amount: 1995000 }));
      assert.equal(round.preview.items[0].text, 'Phòng P102 toà Toà A, kỳ 10/2026 (INV-B-10): thu 1.995.000đ; còn nợ 2.000.000đ → 5.000đ: ĐÃ THANH TOÁN nhờ làm tròn'
        + ' như web — 5.000đ số lẻ KHÔNG thu, ghi vào sổ «Làm tròn tiền thiếu»; cột còn nợ của hoá đơn vẫn hiện 5.000đ.');
      assert.deepEqual([round.preview.items[0].remainingAfter, round.preview.items[0].statusAfter, round.preview.items[0].rounding], ['5000', 'PAID', '5000']);
      const applied = await applyWith(rid(11), one({ roomName: 'P102', amount: 1995000 }), round);
      assert.deepEqual([applied.result.invoices[0].rounding, applied.result.invoices[0].statusAfter, applied.result.invoices[0].remainingAfter], ['5000', 'PAID', '5000']);
      assert.match(applied.result.invoices[0].text, /\. ĐÃ THANH TOÁN nhờ làm tròn: 5\.000đ số lẻ không thu, ghi vào sổ «Làm tròn tiền thiếu»; cột còn nợ của hoá đơn vẫn hiện 5\.000đ\.$/);
      assert.doesNotMatch(applied.result.invoices[0].text, /ĐỦ/);
      assert.deepEqual((await db.query('SELECT tenders FROM public.invoice_payment_collections WHERE invoice_id=$1', [INV_B])).rows[0].tenders,
        [{ payment_method: 'TK', gross_amount: 1995000, account_id: TK1, rounding_account_id: ROUNDING }]);
      const blocked = await run('preview', rid(12), one({ roomName: 'P105', amount: 1000000 }));
      assert.equal(blocked.kind, 'preview', JSON.stringify(blocked));
      assert.equal(blocked.resolved.noRounding, true);
      assert.ok(blocked.warnings.some(w => /không làm tròn được phần thiếu 5\.000đ \(phần thiếu là tiền cọc\)/.test(w)), blocked.warnings.join('\n'));
      const done = await applyWith(rid(12), one({ roomName: 'P105', amount: 1000000 }), blocked);
      assert.deepEqual([done.kind, done.result.invoices[0].statusAfter, done.result.invoices[0].remainingAfter], ['applied', 'PARTIAL_PAID', '5000']);
      assert.match(done.result.invoices[0].text, /\. Còn nợ 5\.000đ\.$/);
      assert.equal(blocked.preview.items[0].rounding, undefined);
    });
  });

  await t.test('lượt 8 — sổ nhận: toà đã cài sổ mà người hỏi không giữ/biết ⇒ receiving_book_not_held; toà chưa cài ⇒ receiving_book_missing', async () => {
    await f.rollbackCase(async () => {
      await db.query('DELETE FROM public.fixture_possession WHERE account_id=ANY($1)', [[TK1, TK2]]);
      assert.deepEqual(await run('preview', rid(52), one({ roomName: 'P102', amount: 100000 })), { kind: 'rejected', reason: 'receiving_book_not_held' });
      assert.equal((await run('preview', rid(53), one({ roomName: 'P102', amount: 100000, method: 'TT' }))).kind, 'preview', 'sổ POS vẫn giữ');
      await db.query("DELETE FROM public.fixture_receiving WHERE building_id=$1 AND method='TK'", [BUILDING]);
      assert.deepEqual(await run('preview', rid(54), one({ roomName: 'P102', amount: 100000 })), { kind: 'rejected', reason: 'receiving_book_missing' });
      for (const reason of ['receiving_book_not_held', 'receiving_book_missing'])
        assert.ok(ACTION_REASON_CODES.includes(reason) && !ACTION_INPUT_REASONS.includes(reason), reason);
    });
  });

  await t.test('lượt 8 — hoá đơn thanh lý (SETTLEMENT, HĐ đã kết thúc) thu như hoá đơn tháng; dòng xem trước / câu đã ghi nói rõ', async () => {
    await f.rollbackCase(async () => {
      await db.query("UPDATE public.invoices SET kind='SETTLEMENT' WHERE id=$1", [INV_B]);
      const preview = await run('preview', rid(55), one({ roomName: 'P102', amount: 2000000 }));
      assert.equal(preview.preview.items[0].text, 'Phòng P102 toà Toà A, kỳ 10/2026 (INV-B-10) — hoá đơn thanh lý: thu 2.000.000đ; còn nợ 2.000.000đ → 0đ: ĐÃ THANH TOÁN ĐỦ.');
      const applied = await applyWith(rid(55), one({ roomName: 'P102', amount: 2000000 }), preview);
      assert.match(applied.result.invoices[0].text, /^Đã ghi thu 2\.000\.000đ bằng chuyển khoản cho hoá đơn INV-B-10 \(thanh lý\) \(Toà A\/P102, kỳ 10\/2026\)\. Hết nợ — ĐÃ THANH TOÁN ĐỦ\.$/);
    });
  });

  await t.test('lô cùng toà: mục đã thu đủ bị loại và nêu ở bản xem trước (HDN2); lượt 2 cả tập hoặc không gì', async () => {
    await f.rollbackCase(async () => {
      const params = { buildingName: 'Toà A', method: 'TT', items: [{ roomName: 'P102' }, { roomName: 'P103' }, { roomName: 'P104' }] };
      const preview = await run('preview', rid(13), params);
      assert.equal(preview.kind, 'preview', JSON.stringify(preview));
      assert.deepEqual(preview.preview.items.map(i => [i.room, i.amount]), [['P102', '2000000'], ['P104', '2500000']]);
      assert.deepEqual(preview.preview.excluded, ['P103: hoá đơn không còn số phải thu — bỏ khỏi lần ghi này']);
      assert.match(preview.preview.summary, /^Sổ nhận: «POS toà A» — thanh toán \(TT\/POS\), sổ mặc định của toà \(người dùng chưa nêu sổ\)\. Sẽ ghi THU 4\.500\.000đ ngày .* cho 2 hoá đơn\.$/);
      const before = await trace();
      // Một hoá đơn bị v5 từ chối ở lượt 2 (sau khi lượt 1 chạy thử qua) ⇒ không hoá đơn nào được ghi, biên nhận lùi theo.
      await db.query('UPDATE public.fixture_v5 SET rejected_message=$1,reject_state=$2,reject_invoice=$3', ['[PROFIT_LOCKED] tháng đã chốt', 'P0001', INV_D10]);
      assert.deepEqual(await applyWith(rid(13), params, preview), { kind: 'rejected', reason: 'state_changed' });
      assert.deepEqual(await trace(), before);
      assert.deepEqual(await run('preview', rid(14), params), { kind: 'rejected', reason: 'period_locked' }, 'xem trước lại bắt sớm');
      await db.query('UPDATE public.fixture_v5 SET rejected_message=NULL,reject_state=NULL,reject_invoice=NULL');
      const fresh = await run('preview', rid(15), params);
      const applied = await applyWith(rid(15), params, fresh);
      assert.deepEqual([applied.link, applied.result.invoices.length, applied.result.applied], ['/invoices', 2, '4500000']);
      assert.deepEqual((await db.query("SELECT idempotency_key FROM public.invoice_payment_collections WHERE idempotency_key LIKE $1 ORDER BY 1", [`hermes-inv:${rid(15)}:%`])).rows
        .map(r => r.idempotency_key), [`hermes-inv:${rid(15)}:1`, `hermes-inv:${rid(15)}:3`]);
      // Cả lô đều không thu được ⇒ lý do của mục đầu.
      assert.deepEqual(await run('preview', rid(16), { buildingName: 'Toà A', method: 'TT', items: [{ roomName: 'P103' }, { roomName: 'P101', month: '2026-09' }] }),
        { kind: 'rejected', reason: 'nothing_to_collect' });
    });
  });

  await t.test('basis: người khác vừa thu giữa hai lượt ⇒ state_changed, không mở biên nhận', async () => {
    await f.rollbackCase(async () => {
      const preview = await run('preview', rid(17), one({ roomName: 'P102', amount: 500000 }));
      await db.query('UPDATE public.invoices SET paid_amount=100000,status=$2 WHERE id=$1', [INV_B, 'PARTIAL_PAID']);
      const before = await trace();
      assert.deepEqual(await applyWith(rid(17), one({ roomName: 'P102', amount: 500000 }), preview), { kind: 'rejected', reason: 'state_changed' });
      assert.deepEqual(await trace(), before);
    });
  });

  await t.test('cùng requestId, khác nội dung ⇒ request_conflict (không ghi lần hai); phát lại đúng nội dung vẫn y nguyên', async () => {
    await f.rollbackCase(async () => {
      const params = one({ roomName: 'P102', amount: 100000 });
      const preview = await run('preview', rid(44), params);
      const applied = await applyWith(rid(44), params, preview);
      assert.equal(applied.kind, 'applied', JSON.stringify(applied));
      const before = await trace();
      const other = await run('preview', rid(45), one({ roomName: 'P102', amount: 200000 }));
      assert.deepEqual(await applyWith(rid(44), one({ roomName: 'P102', amount: 200000 }), other), { kind: 'rejected', reason: 'request_conflict' });
      assert.deepEqual(await applyWith(rid(44), params, preview), applied);
      assert.deepEqual(await trace(), before);
    });
  });

  await t.test('thu trùng: lần thu cùng số trong 30 phút ⇒ cảnh báo possible_duplicate có tên người thu (qua RPC trang)', async () => {
    await f.rollbackCase(async () => {
      await db.query("INSERT INTO public.invoice_payment_collections(organization_id,invoice_id,gross_amount,applied_amount,credit_amount,rounding_amount,actor_id,idempotency_key,tenders,created_at) VALUES($1,$2,100000,100000,0,0,$3,'web-1234567890','[]',now()-interval '5 minutes')",
        [ORG, INV_B, STRANGER]);
      const preview = await run('preview', rid(46), one({ roomName: 'P102', amount: 100000 }));
      assert.equal(preview.kind, 'preview', JSON.stringify(preview));
      assert.ok(preview.warnings.some(w => /^Phòng P102: hoá đơn này vừa được thu 100\.000đ lúc \d\d:\d\d bởi Quản lý B — có thể THU TRÙNG; hỏi lại người dùng\.$/.test(w)),
        preview.warnings.join('\n'));
      const other = await run('preview', rid(47), one({ roomName: 'P102', amount: 150000 }));
      assert.ok(!other.warnings.some(w => /THU TRÙNG/.test(w)), 'khác số tiền ⇒ không cảnh báo');
    });
  });

  await t.test('TT (POS) trả dư: hỏi giữ lại / trả lại như TK; keep ghi credit vào sổ POS; return chỉ ghi số còn nợ', async () => {
    await f.rollbackCase(async () => {
      const params = one({ roomName: 'P104', method: 'TT', amount: 2600000 });
      const ask = await run('preview', rid(48), params);
      assert.deepEqual([ask.kind, ask.preview.choiceRequired], ['preview', 'overpay']);
      const keep = await run('preview', rid(49), { ...params, overpay: 'keep' });
      assert.match(keep.preview.summary, /^Sổ nhận: «POS toà A» — thanh toán \(TT\/POS\), sổ mặc định của toà \(người dùng chưa nêu sổ\)\. Sẽ ghi THU 2\.600\.000đ ngày .* cho hoá đơn INV-D-10\.$/);
      const applied = await applyWith(rid(49), { ...params, overpay: 'keep' }, keep);
      assert.deepEqual([applied.result.invoices[0].applied, applied.result.invoices[0].credit, applied.result.invoices[0].statusAfter], ['2500000', '100000', 'PAID']);
      assert.match(applied.result.invoices[0].text, /^Đã ghi thu 2\.600\.000đ bằng thanh toán \(TT\/POS\) cho hoá đơn INV-D-10/);
      assert.deepEqual((await db.query('SELECT tenders FROM public.invoice_payment_collections WHERE invoice_id=$1', [INV_D10])).rows[0].tenders,
        [{ payment_method: 'TT', gross_amount: 2600000, account_id: TT1 }]);
      const ret = await run('preview', rid(50), one({ roomName: 'P102', method: 'TT', amount: 2100000, overpay: 'return' }));
      assert.deepEqual([ret.preview.items[0].amount, ret.preview.items[0].statusAfter], ['2000000', 'PAID']);
    });
  });

  await t.test('cảnh báo: mã lạ của hàm kế hoạch bị bỏ qua, không làm mất các cảnh báo khác (jsonb || NULL)', async () => {
    await f.rollbackCase(async () => {
      // Hàm kế hoạch "đời sau" thêm một mã trang chưa biết, đặt TRƯỚC các mã đã biết.
      await db.exec(`ALTER FUNCTION public.invoice_collection_plan_v1(uuid,jsonb,jsonb) RENAME TO invoice_collection_plan_real_v1;
        CREATE FUNCTION public.invoice_collection_plan_v1(p_invoice_id uuid,p_lines jsonb,p_options jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql STABLE AS $f$
          SELECT p||jsonb_build_object('warnings',jsonb_build_array(jsonb_build_object('code','future_code'))||COALESCE(p->'warnings','[]'::jsonb))
            FROM public.invoice_collection_plan_real_v1(p_invoice_id,p_lines,p_options) p $f$;
        GRANT EXECUTE ON FUNCTION public.invoice_collection_plan_v1(uuid,jsonb,jsonb) TO authenticated;`);
      const preview = await run('preview', rid(51), one({ roomName: 'P102', amount: 100500, date: '2026-10-10' }));
      assert.equal(preview.kind, 'preview', JSON.stringify(preview));
      assert.ok(preview.warnings.every(w => typeof w === 'string'), JSON.stringify(preview.warnings));
      assert.deepEqual(preview.warnings, [DEFAULT_BOOK_WARNING, 'Ngày thu lùi 12 ngày so với hôm nay.', 'Phòng P102: số tiền không tròn nghìn — kiểm lại đơn vị.']);
    });
  });

  await t.test('giải tên: kỳ mơ hồ ⇒ hỏi lại, ứng viên có số hoá đơn; hai hoá đơn cùng kỳ chọn bằng invoiceNumber; sổ theo tên; tham số chéo sai ⇒ invalid_params', async () => {
    await f.rollbackCase(async () => {
      await db.query("UPDATE public.invoices SET status='APPROVED',paid_amount=0 WHERE id=ANY($1)", [[INV_A9, INV_A]]);
      const vague = await run('preview', rid(18), one());
      assert.deepEqual([vague.kind, vague.field, vague.why, vague.candidates.map(c => c.name)],
        ['needs_input', 'invoice', 'ambiguous', ['kỳ 10/2026 · INV-A-10 (còn 3.650.000đ)', 'kỳ 09/2026 · INV-A-09 (còn 1.200.000đ)']]);
      assert.equal((await run('preview', rid(19), one({ month: '2026-09' }))).resolved.items[0].invoiceId, INV_A9);
      // Hai hoá đơn còn nợ CÙNG kỳ: kỳ không phân biệt được, số hoá đơn thì được (không phân biệt hoa thường).
      await db.query("INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,paid_amount,contract_id,kind) VALUES($1,$2,'INV-A-10B','APPROVED',$3,$4,'2026-10','2026-10-30',500000,0,$5,'EXTRA')",
        [uid(829), ORG, BUILDING, ROOM, CONTRACT]);
      const same = await run('preview', rid(40), one({ month: '2026-10' }));
      assert.deepEqual([same.kind, same.why, same.candidates.map(c => c.name)],
        ['needs_input', 'ambiguous', ['kỳ 10/2026 · INV-A-10 (còn 3.650.000đ)', 'kỳ 10/2026 · INV-A-10B (còn 500.000đ, extra)']]);
      // Lượt 8: hoá đơn thanh lý (khách cũ, HĐ đã kết thúc) cùng phòng/kỳ với hoá đơn tháng của khách mới — ứng viên gọi đúng tên như web.
      await db.query("UPDATE public.invoices SET kind='SETTLEMENT' WHERE id=$1", [uid(829)]);
      assert.deepEqual((await run('preview', rid(39), one({ month: '2026-10' }))).candidates.map(c => c.name),
        ['kỳ 10/2026 · INV-A-10 (còn 3.650.000đ)', 'kỳ 10/2026 · INV-A-10B (còn 500.000đ, hoá đơn thanh lý)']);
      const picked = await run('preview', rid(41), one({ month: '2026-10', invoiceNumber: 'inv-a-10b ' }));
      assert.deepEqual([picked.kind, picked.resolved.items[0].invoiceId, picked.preview.items[0].amount], ['preview', uid(829), '500000']);
      assert.match(picked.preview.summary, /cho hoá đơn INV-A-10B\.$/);
      const batch = await run('preview', rid(42), { buildingName: 'Toà A', method: 'TK', items: [{ roomName: 'P101', invoiceNumber: 'INV-A-09' }, { roomName: 'P102' }] });
      assert.deepEqual(batch.resolved.items.map(i => i.invoiceId), [INV_A9, INV_B]);
      const unknown = await run('preview', rid(43), one({ invoiceNumber: 'INV-X-99' }));
      assert.deepEqual([unknown.kind, unknown.field, unknown.wanted, unknown.why, unknown.candidates.length], ['needs_input', 'invoice', 'P101 INV-X-99', 'not_visible', 3]);
    });
    const named = await run('preview', rid(20), one({ roomName: 'P102', amount: 100000, cashbookName: 'mb' }));
    assert.equal(named.resolved.accountId, TK2);
    assert.match(named.preview.summary, /^Sổ nhận: «MB toà A» — chuyển khoản, theo sổ người dùng nêu\. Sẽ ghi THU 100\.000đ /);
    assert.deepEqual(named.warnings, [], 'đã nêu sổ ⇒ không cảnh báo sổ mặc định');
    const wrongBook = await run('preview', rid(21), one({ roomName: 'P102', amount: 100000, cashbookName: 'quỹ lạ' }));
    assert.deepEqual([wrongBook.kind, wrongBook.field, wrongBook.why, wrongBook.candidates.map(c => c.name)],
      ['needs_input', 'cashbook', 'not_visible', ['VCB toà A *** — chuyển khoản (TK)', 'MB toà A — chuyển khoản (TK)', 'POS toà A — thanh toán (TT)']]);
    for (const bad of [{ buildingName: 'Toà A', method: 'TK' }, { ...one(), items: [{ roomName: 'P102' }] },
      { buildingName: 'Toà A', method: 'TK', amount: 1000, items: [{ roomName: 'P102' }] }, { buildingName: 'Toà A', method: 'TK', items: [{ roomName: 'P102' }, { roomName: 'p102' }] },
      { buildingName: 'Toà A', method: 'TK', invoiceNumber: 'INV-B-10', items: [{ roomName: 'P102' }] }])
      assert.deepEqual(await run('preview', rid(22), bad), { kind: 'rejected', reason: 'invalid_params' }, JSON.stringify(bad));
    assert.deepEqual(await run('preview', rid(23), one({ date: '2026-10-23' })), { kind: 'rejected', reason: 'date_out_of_range' });
  });

  // Lượt 14 (nghiệm thu C3c, GHI SAI: "ck vào HKD Tâm" ⇒ bot để tên sổ ở note, máy chủ ghi TK vào sổ mặc định; đúng là TT vào HKDTAM): sổ người
  // dùng nêu tìm ở CẢ hai danh sách sổ nhận TK + TT của toà, bỏ dấu / hoa thường / khoảng trắng; sổ chỉ thuộc một hình thức ⇒ ghi theo hình thức
  // của sổ (câu đầu nói rõ); không khớp / nhiều sổ ⇒ hỏi lại sổ, không rơi về sổ mặc định; chưa nêu sổ ⇒ cảnh báo kèm ghi chú giống tên sổ.
  await t.test('lượt 14: sổ nhận theo tên ở cả TK + TT ⇒ hình thức theo sổ (TK nói "POS toà A" ⇒ TT); mơ hồ / không thấy ⇒ hỏi; ghi chú giống tên sổ ⇒ cảnh báo', async () => {
    await f.rollbackCase(async () => {
      const params = one({ roomName: 'P102', amount: 350000, cashbookName: 'Pos Toa-A' });
      const preview = await run('preview', rid(60), params);
      assert.equal(preview.kind, 'preview', JSON.stringify(preview));
      assert.deepEqual([preview.resolved.method, preview.resolved.methodFromBook, preview.resolved.accountId], ['TT', true, TT1]);
      assert.equal(preview.preview.summary, 'Sổ nhận: «POS toà A» — thanh toán (TT/POS), theo sổ người dùng nêu (sổ này nhận thanh toán (TT/POS), không nhận chuyển khoản ở '
        + 'toà này). Sẽ ghi THU 350.000đ ngày 22/10/2026 (thứ Năm, hôm nay) cho hoá đơn INV-B-10.');
      assert.deepEqual([preview.preview.receivingBook, preview.preview.method, preview.warnings], ['POS toà A', 'TT', []]);
      const applied = await applyWith(rid(60), params, preview);
      assert.equal(applied.kind, 'applied', JSON.stringify(applied));
      assert.match(applied.result.invoices[0].text, /^Đã ghi thu 350\.000đ bằng thanh toán \(TT\/POS\) cho hoá đơn INV-B-10/);
      assert.deepEqual((await db.query('SELECT tenders FROM public.invoice_payment_collections WHERE idempotency_key=$1', [`hermes-inv:${rid(60)}`])).rows[0].tenders,
        [{ payment_method: 'TT', gross_amount: 350000, account_id: TT1 }], 'ghi THẬT là TT vào sổ người dùng nêu');
      // Chiều ngược: nói TT mà sổ chỉ nhận chuyển khoản ⇒ TK; sổ thuộc đúng hình thức đã nói ⇒ giữ, không methodFromBook.
      const back = await run('preview', rid(61), one({ roomName: 'P104', method: 'TT', amount: 100000, cashbookName: 'mb' }));
      assert.deepEqual([back.resolved.method, back.resolved.methodFromBook, back.resolved.accountId], ['TK', true, TK2]);
      const same = await run('preview', rid(62), one({ roomName: 'P104', amount: 100000, cashbookName: 'MB toà A' }));
      assert.deepEqual([same.resolved.method, same.resolved.methodFromBook, same.resolved.accountId], ['TK', undefined, TK2]);
      // Tên bỏ khoảng trắng / dấu câu khớp ĐÚNG trước khi xét "chứa": thêm sổ «POS-toà A 2» thì "Pos Toa-A" vẫn là «POS toà A», không mơ hồ.
      await db.query("INSERT INTO public.accounts(id,organization_id,user_id,name,account_number,is_virtual) VALUES($1,$2,$3,'POS-toà A 2',null,false)", [uid(870), ORG, USER]);
      await db.query("INSERT INTO public.fixture_receiving VALUES($1,'TT',$2,1)", [BUILDING, uid(870)]);
      await db.query('INSERT INTO public.fixture_possession VALUES($1,$2)', [USER, uid(870)]);
      assert.equal((await run('preview', rid(69), params)).resolved.accountId, TT1);
      // Nhiều sổ khớp ⇒ hỏi lại sổ (ứng viên kèm hình thức), KHÔNG dùng sổ mặc định.
      const vague = await run('preview', rid(63), one({ roomName: 'P104', amount: 100000, cashbookName: 'toà a' }));
      assert.deepEqual([vague.kind, vague.field, vague.why, vague.candidates.map(c => c.name)], ['needs_input', 'cashbook', 'ambiguous',
        ['VCB toà A *** — chuyển khoản (TK)', 'MB toà A — chuyển khoản (TK)', 'POS toà A — thanh toán (TT)', 'POS-toà A 2 — thanh toán (TT)']]);
      // Lượt 2 mang bản đã giải hình thức theo sổ: chỉ hợp lệ khi sổ còn trong danh sách của hình thức đó.
      await db.query('DELETE FROM public.fixture_receiving WHERE account_id=$1', [TT1]);
      assert.deepEqual(await applyWith(rid(64), params, preview), { kind: 'rejected', reason: 'state_changed' });
    });
    await f.rollbackCase(async () => {
      // Chưa nêu sổ, tên sổ nằm trong ghi chú ⇒ vẫn sổ mặc định nhưng cảnh báo đầu nêu ghi chú giống tên sổ khác.
      const noted = await run('preview', rid(65), one({ roomName: 'P104', amount: 100000, note: 'POS' }));
      assert.equal(noted.warnings[0], DEFAULT_BOOK_WARNING + ' Ghi chú «POS» giống tên sổ «POS toà A».');
      assert.match(noted.preview.summary, /^Sổ nhận: «VCB toà A \*\*\*» — chuyển khoản, sổ mặc định của toà \(người dùng chưa nêu sổ\)\./);
    });
  });

  // Lượt 14: toà KHÔNG nêu ⇒ một phòng giải trong cả phạm vi (phòng duy nhất quyết định toà); không thấy phòng ⇒ hỏi toà; lô không nêu toà ⇒ hỏi toà.
  await t.test('lượt 14: không nêu toà — phòng duy nhất trong phạm vi quyết định toà; không thấy ⇒ hỏi toà (unspecified); lô cần toà', async () => {
    const solo = await run('preview', rid(66), { roomName: 'p104', method: 'TK', amount: 100000 });
    assert.equal(solo.kind, 'preview', JSON.stringify(solo));
    assert.deepEqual([solo.resolved.buildingId, solo.resolved.buildingName, solo.resolved.items[0].roomName], [BUILDING, 'Toà A', 'P104']);
    const unspecified = { kind: 'needs_input', reason: 'name_unresolved', field: 'building', wanted: '', why: 'unspecified', candidates: [], more: false };
    assert.deepEqual(await run('preview', rid(67), { roomName: 'Paris 2', method: 'TK', amount: 100000 }), unspecified);
    assert.deepEqual(await run('preview', rid(68), { method: 'TK', items: [{ roomName: 'P104' }] }), unspecified);
  });

  await t.test('phạm vi = guard ∩ quyền thu của v5 (kiểm SAU khoá hoá đơn → công ty, thứ tự v5): toà guard cho mà v5 không cho ⇒ not_allowed ngay ở bản xem trước; bản đã giải giả ⇒ not_allowed', async () => {
    await f.rollbackCase(async () => {
      await db.query("INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,paid_amount,contract_id) VALUES($1,$2,'INV-OB-10','APPROVED',$3,$4,'2026-10','2026-10-30',900000,0,$5)",
        [uid(828), ORG, OTHER_BUILDING, OTHER_ROOM, CONTRACT]);
      await db.query("UPDATE public.authorization_scopes SET scope_type='ORGANIZATION',building_id=NULL WHERE organization_id=$1 AND scope_type='BUILDING'", [ORG]);
      // P201 còn hoá đơn INV-O-10 của fixture Mốc 5 ⇒ chọn đích danh.
      const b = { buildingName: 'Toà B', roomName: 'P201', method: 'TK', invoiceNumber: 'INV-OB-10' };
      const ok = await run('preview', rid(24), b);
      assert.equal(ok.kind, 'preview', 'toà B: cả guard lẫn v5 cho');
      await db.query('DELETE FROM public.fixture_collect_acl WHERE building_id=$1', [OTHER_BUILDING]);
      assert.deepEqual(await run('preview', rid(25), b), { kind: 'rejected', reason: 'not_allowed' });
      // Lượt 2 đưa bản đã giải sang toà B ⇒ not_allowed TRƯỚC biên nhận.
      const before = await trace();
      assert.deepEqual(await run('apply', rid(24), b, { resolved: ok.resolved, basis: ok.basis }), { kind: 'rejected', reason: 'not_allowed' });
      const a = await run('preview', rid(26), one({ roomName: 'P102', amount: 1000 }));
      for (const forged of [{ ...a.resolved, items: [{ ...a.resolved.items[0], roomId: ROOM }] }, { ...a.resolved, items: [{ ...a.resolved.items[0], invoiceId: uid(828) }] },
        { ...a.resolved, method: 'TT' }])
        assert.deepEqual(await run('apply', rid(26), one({ roomName: 'P102', amount: 1000 }), { resolved: forged, basis: a.basis }), { kind: 'rejected', reason: 'not_allowed' }, JSON.stringify(forged));
      // Sổ của bản đã giải không còn trong danh sách sổ nhận ở lượt 2 ⇒ dữ liệu đổi sau bản xem trước (lượt 8; xem trước lại nói đúng lý do).
      assert.deepEqual(await run('apply', rid(26), one({ roomName: 'P102', amount: 1000 }), { resolved: { ...a.resolved, accountId: CASHBOOK }, basis: a.basis }),
        { kind: 'rejected', reason: 'state_changed' });
      assert.deepEqual(await trace(), before);
    });
  });

  await t.test('lỗi v5 ở lượt 1 ⇒ lý do đóng của trang; lỗi tạm không bị nuốt; bảng câu lỗi', async () => {
    await f.rollbackCase(async () => {
      for (const [message, state, reason] of [['Bạn không được giao sổ quỹ này (cần là Người giữ sổ hoặc Người biết sổ). Chọn sổ khác.', '42501', 'cashbook_not_held'],
        ['Số đã thu không khớp bút toán semantic; cần đối soát trước', '55000', 'reconciliation_required'], ['Writer invoice.collection.v5 đang bị đóng băng', '55000', 'web_only'],
        ['Không có quyền thu tiền hóa đơn', '42501', 'not_allowed'], ['lỗi lạ', 'XX000', 'crm_refused']]) {
        await db.query('UPDATE public.fixture_v5 SET rejected_message=$1,reject_state=$2', [message, state]);
        assert.deepEqual(await run('preview', rid(27), one({ roomName: 'P102', amount: 1000 })), { kind: 'rejected', reason }, message);
        assert.ok(ACTION_REASON_CODES.includes(reason));
      }
      // Lỗi tạm và PT409 (khoá lạc quan của v5) bị ném lại nguyên mã cả hai lượt, không thành lý do đóng; lượt 2 lùi cả biên nhận.
      for (const [message, state] of [['canceling statement due to lock timeout', '55P03'], ['Số đã thu vừa thay đổi; vui lòng tải lại hóa đơn', 'PT409']]) {
        await db.query('UPDATE public.fixture_v5 SET rejected_message=NULL,reject_state=NULL');
        const preview = await run('preview', rid(28), one({ roomName: 'P102', amount: 1000 }));
        await db.query('UPDATE public.fixture_v5 SET rejected_message=$1,reject_state=$2', [message, state]);
        await assert.rejects(run('preview', rid(28), one({ roomName: 'P102', amount: 1000 })), code(state));
        const before = await trace();
        await assert.rejects(applyWith(rid(29), one({ roomName: 'P102', amount: 1000 }), preview), code(state));
        assert.deepEqual(await trace(), before);
      }
    });
    const mapped = async (sqlstate, message) => (await db.query('SELECT app_private.hermes_invoice_reason_v1($1,$2) r', [sqlstate, message])).rows[0].r;
    for (const [sqlstate, message, expected] of [['55000', 'Hóa đơn không còn số tiền có thể thu', 'nothing_to_collect'],
      ['55000', 'Trạng thái hóa đơn không cho phép thu tiền: CANCELLED', 'invoice_not_collectible'],
      ['22023', 'Số thu vượt còn phải thu; chọn thối lại hoặc giữ credit', 'overpay_needs_choice'],
      ['22023', 'Không thể giữ credit cho hóa đơn không có hợp đồng', 'credit_requires_contract'],
      ['42501', 'Toà A chưa cài sổ nhận tiền cho hình thức Chuyển khoản.', 'receiving_book_missing'],
      ['42501', 'Sổ "x" không nằm trong danh sách sổ nhận tiền Thanh toán của toà A.', 'receiving_book_missing'],
      ['55000', 'Dữ liệu cọc/NON_PNL vượt tổng phải thu; cần review kế toán', 'reconciliation_required'],
      ['22023', 'Ngày thu không được ở tương lai (hôm nay là 22/10/2026)', 'date_out_of_range'], ['P0001', '[CASHBOOK_CLOSED] sổ đã chốt', 'period_locked'],
      ['23505', 'idempotency_key đã dùng với nội dung khác', 'crm_refused']])
      assert.equal(await mapped(sqlstate, message), expected, message);
  });

  await t.test('rào: sàn money; action/phase NULL; khoá tắt; catalog và quyền thực thi; không seed thu_tien.collect', async () => {
    await assert.rejects(db.query("UPDATE app_private.hermes_action_policies SET confirm='never' WHERE action='invoice.collect'"), code('23514'));
    for (const phase of [null, 'write']) await assert.rejects(run(phase, rid(30), one()), code('22023'));
    await assert.rejects(run('preview', rid(31), one(), { action: 'invoice.refund' }), code('42501'), 'chưa có dòng chính sách ⇒ không tồn tại');
    await f.rollbackCase(async () => {
      await db.query("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='thu_tien.collect_transfer'");
      await assert.rejects(run('preview', rid(32), one()), code('42501'));
    });
    assert.equal((await db.query("SELECT count(*)::int n FROM app_private.hermes_capabilities WHERE capability='thu_tien.collect'")).rows[0].n, 0);
    const acl = (await db.query(`SELECT p.oid::regprocedure::text fn,p.prosecdef,p.prosqlbody IS NOT NULL standard,has_function_privilege('authenticated',p.oid,'EXECUTE') auth,
      has_function_privilege('anon',p.oid,'EXECUTE') anon FROM pg_proc p WHERE (p.proname LIKE 'hermes_invoice_%' AND p.proname !~ '(meter|edit|reading)')
      OR p.proname LIKE 'invoice_collection_plan%' ORDER BY 1`)).rows;
    // Tầng v1/v2 (vỏ cũ) còn nguyên quyền nhưng vỏ không còn gọi (lượt 8: thu tiền đi tầng v2; lượt 14: bước ghi v3).
    assert.deepEqual(acl.map(r => [r.fn.replace(/\(.*/, ''), r.prosecdef, r.standard, r.auth, r.anon]), [
      ['app_private.hermes_invoice_action_step_v1', true, false, true, false], ['app_private.hermes_invoice_action_step_v2', true, false, true, false],
      ['app_private.hermes_invoice_action_step_v3', true, false, true, false],
      ['app_private.hermes_invoice_lookup_core_v1', false, false, true, false], ['app_private.hermes_invoice_lookup_core_v2', false, false, true, false],
      ['app_private.hermes_invoice_lookup_core_v3', false, false, true, false],
      ['app_private.hermes_invoice_reason_v1', false, false, false, false],
      ['hermes_invoice_action_v1', false, true, true, false], ['invoice_collection_plan_core_v1', false, false, true, false],
      ['invoice_collection_plan_v1', false, false, true, false]]);
  });
});

// C07 (nghiệm thu TEST 26/10 và 27/10, 3/3 lần): chuyển khoản MỘT PHẦN hoá đơn kỳ 08 của phòng còn 4 hoá đơn mở (07 số kiểu cũ, 08, 09 quá
// hạn; 10 có 4 điều chỉnh PENDING) — số liệu dưới là số dựng. Bản xem trước đúng; lượt xác nhận ⇒ connector action_outcome_unknown (finalize
// 3,3–3,8 s, resultBytes 0, không hết giờ), crm_action_status ⇒ not_found. Bước ghi bắt MỌI lỗi của hàm ghi web trong khối con, nên
// lỗi tới được PostgREST chỉ có thể nổ SAU khi hàm đã trả applied: kiểm hoãn (constraint trigger DEFERRED) của các bảng v5 ghi chạy LÚC
// COMMIT, ngoài mọi khối EXCEPTION ⇒ PostgREST trả lỗi mã lạ (55000 ⇒ HTTP 500, 23514 / P0001 ⇒ 400) ⇒ connector giữ cờ "chưa rõ"; giao dịch
// lùi cả biên nhận. Chạy thử của bản xem trước lùi khối con nên sự kiện hoãn bị bỏ — không bao giờ thấy. Ở đây fixture_commit_reject đóng vai
// kiểm hoãn đó (lỗi theo DỮ LIỆU của hoá đơn: kỳ 10 cùng phòng vẫn ghi được). Sửa: bước ghi ép kiểm hoãn NGAY trong khối con (SET CONSTRAINTS
// ALL IMMEDIATE) ở chạy thử và ở lượt ghi (sau khi chốt biên nhận) ⇒ bản xem trước nói đúng lý do, lượt ghi lùi thành state_changed.
test('C07: kiểm hoãn lúc COMMIT của hàm ghi web chạy trong khối con — bản xem trước nói lý do, lượt ghi không nổ lúc COMMIT', { timeout: 300000 }, async t => {
  const f = await invoiceSetup(t, { l14: true });
  const { db, run, applyWith, trace } = f;
  const ROOM_C07 = uid(880), [I07, I08, I09, I10] = [881, 882, 883, 884].map(uid);
  await db.query("INSERT INTO public.rooms VALUES($1,$2,$3,'P301','OCCUPIED',null)", [ROOM_C07, ORG, BUILDING]);
  await db.query(`INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,paid_amount,contract_id,
      created_at,adjustment_revision) VALUES
    ($1,$5,'INV-202606-000001','OVERDUE',$6,$7,'2026-07','2026-07-31',1800000,0,$8,'2026-07-01',0),
    ($2,$5,'INV-2026-C0708','OVERDUE',$6,$7,'2026-08','2026-08-31',2000000,0,$8,'2026-08-01',0),
    ($3,$5,'INV-2026-C0709','OVERDUE',$6,$7,'2026-09','2026-09-30',1900000,0,$8,'2026-09-01',0),
    ($4,$5,'INV-2026-C0710','APPROVED',$6,$7,'2026-10','2026-10-30',1700000,0,$8,'2026-10-01',4)`, [I07, I08, I09, I10, ORG, BUILDING, ROOM_C07, CONTRACT]);
  for (let revision = 1; revision <= 4; revision++)
    await db.query(`INSERT INTO public.invoice_adjustments(organization_id,invoice_id,revision,idempotency_key,reason,before_snapshot,after_snapshot,before_total,after_total,
      delta,adjusted_by) VALUES($1,$2,$3,$4,'Điều chỉnh chờ kiểm','{}','{}',1700000,1700000,0,$5)`, [ORG, I10, revision, `c07-adjustment-${revision}`, USER]);
  const params = { buildingName: 'toa a', roomName: 'p301', month: '2026-08', method: 'TK', amount: 1500000 };
  const clean = await run('preview', rid(80), params);
  assert.equal(clean.kind, 'preview', JSON.stringify(clean));
  assert.deepEqual([clean.resolved.items[0].invoiceId, clean.preview.items[0].remainingBefore, clean.preview.items[0].remainingAfter, clean.preview.items[0].statusAfter],
    [I08, '2000000', '500000', 'PARTIAL_PAID'], 'kỳ 08 dù kỳ 07 cũ hơn chưa trả; thu một phần');
  await db.query('INSERT INTO public.fixture_commit_reject(invoice_id,message) VALUES($1,$2)', [I08, 'Phân bổ thành phần không đủ; cần đối soát các lần thu trước']);
  const before = await trace();

  await t.test('bản xem trước: chạy thử ép kiểm hoãn trong khối con ⇒ lý do đóng, không phải bản xem trước "ghi được"; không để lại dấu vết', async () => {
    assert.deepEqual(await run('preview', rid(81), params), { kind: 'rejected', reason: 'reconciliation_required' });
    assert.deepEqual(await run('preview', rid(82), { ...params, amount: 2000000 }), { kind: 'rejected', reason: 'reconciliation_required' },
      'thu đủ kỳ 08 cũng vậy: lỗi theo dữ liệu hoá đơn, không theo "một phần"');
    const october = await run('preview', rid(83), { ...params, month: '2026-10' });
    assert.deepEqual([october.kind, october.resolved?.items[0].invoiceId], ['preview', I10], 'kỳ 10 cùng phòng (điều chỉnh PENDING) không vướng');
    assert.deepEqual(await trace(), before);
  });

  await t.test('lượt xác nhận với bản xem trước đã cấp: kết cục ĐÃ BIẾT (state_changed), không nổ lúc COMMIT; không lần thu, không biên nhận', async () => {
    // Trước bản sửa: applied trong hàm rồi 55000 lúc COMMIT ⇒ HTTP 500 mã lạ ⇒ action_outcome_unknown, status not_found.
    assert.deepEqual(await applyWith(rid(80), params, clean), { kind: 'rejected', reason: 'state_changed' });
    assert.deepEqual(await trace(), before, 'không lần thu, khoá idempotency, biên nhận (crm_action_status ⇒ not_found) hay tiền');
  });

  await t.test('hết lỗi hoãn: cùng requestId ghi thật, COMMIT qua (ép kiểm sau khi chốt biên nhận nên rào biên nhận chưa chốt không vướng); phát lại', async () => {
    await db.query('DELETE FROM public.fixture_commit_reject');
    const applied = await applyWith(rid(80), params, clean);
    assert.equal(applied.kind, 'applied', JSON.stringify(applied));
    assert.deepEqual([applied.result.invoices[0].invoiceNumber, applied.result.invoices[0].remainingAfter, applied.result.invoices[0].statusAfter],
      ['INV-2026-C0708', '500000', 'PARTIAL_PAID']);
    const after = await trace();
    assert.deepEqual([after.collections - before.collections, after.receipts - before.receipts, after.ops - before.ops], [1, 1, 1]);
    assert.deepEqual(await applyWith(rid(80), params, clean), applied, 'phát lại y nguyên');
  });
});

// J06 (nghiệm thu HĐn TC-J06 trên TEST 30/10, trượt 3/3 vòng — số liệu dưới là số dựng): phòng còn hai hoá đơn mở (kỳ 10 và một kỳ cũ). Người
// dùng nhắn "ck <đúng số còn nợ kỳ 10> rồi nha", rồi "ok ghi đi". Trước bản sửa: bản xem trước không month / invoiceNumber ⇒ name_unresolved
// (hoá đơn mơ hồ) ⇒ bot hỏi lại kỳ, lượt "ok" mới ra bản xem trước ⇒ hai lượt không ghi. Sửa (hermes_invoice_collect_amount_pick_v1): số tiền
// khớp ĐÚNG số còn nợ của MỘT hoá đơn mở, không hoá đơn mở nào khác khớp ⇒ tra cứu tự chọn, bản xem trước nói rõ; lượt ghi dùng đúng resolved
// của bản xem trước (connector giữ theo confirmToken), basis băm invoiceId. Không khớp / khớp hai / đã nêu kỳ hay số hoá đơn ⇒ y như thân trước.
test('J06: số tiền khớp đúng số còn nợ của MỘT hoá đơn mở ⇒ tự chọn, token gắn đúng hoá đơn; khớp hai / không khớp / có kỳ ⇒ như cũ', { timeout: 300000 }, async t => {
  const f = await invoiceSetup(t, { l14: true });
  const { db, run, applyWith, trace } = f;
  const ROOM_J = uid(890), [J10, J06, J11, J08, J10B] = [891, 892, 893, 894, 895].map(uid);
  await db.query("INSERT INTO public.rooms VALUES($1,$2,$3,'P302','OCCUPIED',null)", [ROOM_J, ORG, BUILDING]);
  const addInvoice = (id, number, status, month, due, total, kind = 'MONTHLY') => db.query(`INSERT INTO public.invoices(id,organization_id,invoice_number,status,
      building_id,room_id,billing_month,due_date,total_amount,paid_amount,contract_id,created_at,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12)`,
    [id, ORG, number, status, BUILDING, ROOM_J, month, due, total, CONTRACT, `${month}-01`, kind]);
  await addInvoice(J10, 'INV-2026-J10', 'APPROVED', '2026-10', '2026-10-30', 1150000);
  await addInvoice(J06, 'INV-2026-J06', 'OVERDUE', '2026-06', '2026-06-30', 640500);
  // Kỳ 11 NHÁP cùng số tiền kỳ 10: không thu được ⇒ không phải ứng viên của câu hỏi lại, không tính là "khớp".
  await addInvoice(J11, 'INV-2026-J11', 'DRAFT', '2026-11', '2026-11-30', 1150000);
  const params = { buildingName: 'toa a', roomName: 'p302', method: 'TK', amount: 1150000 };
  const paid = async () => Object.fromEntries((await db.query('SELECT invoice_number n,paid_amount::bigint::text p FROM public.invoices WHERE room_id=$1 ORDER BY 1',
    [ROOM_J])).rows.map(r => [r.n, r.p]));
  const AUTO_J10 = 'Phòng P302: người dùng chưa nêu kỳ nên TỰ CHỌN hoá đơn kỳ 10/2026 (INV-2026-J10) vì số tiền 1.150.000đ khớp đúng số còn nợ. Nếu người dùng nói '
    + 'kỳ / hoá đơn khác: gọi lại kèm month hoặc invoiceNumber để xem trước lại. Phòng còn hoá đơn chưa trả: kỳ 06/2026 · INV-2026-J06 (còn 640.500đ).';
  const before = await trace();

  await t.test('khớp đúng một (kỳ 10; kỳ 11 nháp cùng số không tính): bản xem trước tự chọn, nói rõ vì sao và hoá đơn mở còn lại; chạy thử không để lại dấu vết', async () => {
    const preview = await run('preview', rid(90), params);
    assert.equal(preview.kind, 'preview', JSON.stringify(preview));
    assert.deepEqual(preview.resolved.items, [{ invoiceId: J10, roomId: ROOM_J, roomName: 'P302', invoiceNumber: 'INV-2026-J10', billingMonth: '2026-10',
      pickedBy: 'amount', otherOpen: 'kỳ 06/2026 · INV-2026-J06 (còn 640.500đ)' }]);
    assert.match(preview.preview.summary, / cho hoá đơn INV-2026-J10\. Tự chọn hoá đơn kỳ 10\/2026 vì số tiền khớp đúng số còn nợ\.$/);
    const [item] = preview.preview.items;
    assert.deepEqual([item.pickedBy, item.month, item.amount, item.remainingBefore, item.remainingAfter, item.statusAfter],
      ['amount', '10/2026', '1150000', '1150000', '0', 'PAID']);
    assert.equal(item.text, 'Phòng P302 toà Toà A, kỳ 10/2026 (INV-2026-J10) — tự chọn vì số tiền khớp đúng số còn nợ: thu 1.150.000đ; còn nợ 1.150.000đ → 0đ: '
      + 'ĐÃ THANH TOÁN ĐỦ.');
    assert.deepEqual(preview.warnings, [DEFAULT_BOOK_WARNING, AUTO_J10]);
    assert.deepEqual(await trace(), before, 'chạy thử không để lại lần thu, khoá idempotency, biên nhận hay tiền');
  });

  await t.test('token gắn đúng hoá đơn: tự chọn kỳ 06 (số lẻ); lượt ghi với resolved đổi sang kỳ 10 mà giữ basis của bản xem trước ⇒ state_changed, không ghi gì', async () => {
    const odd = { ...params, amount: 640500 };
    const preview = await run('preview', rid(91), odd);
    assert.equal(preview.kind, 'preview', JSON.stringify(preview));
    assert.deepEqual([preview.resolved.items[0].invoiceId, preview.resolved.items[0].pickedBy, preview.resolved.items[0].otherOpen],
      [J06, 'amount', 'kỳ 10/2026 · INV-2026-J10 (còn 1.150.000đ)']);
    assert.match(preview.preview.summary, / cho hoá đơn INV-2026-J06\. Tự chọn hoá đơn kỳ 06\/2026 vì số tiền khớp đúng số còn nợ\.$/);
    const swapped = { ...preview.resolved, items: [{ ...preview.resolved.items[0], invoiceId: J10, invoiceNumber: 'INV-2026-J10', billingMonth: '2026-10' }] };
    assert.deepEqual(await run('apply', rid(91), odd, { resolved: swapped, basis: preview.basis }), { kind: 'rejected', reason: 'state_changed' });
    assert.deepEqual(await trace(), before, 'không lần thu, không biên nhận');
    assert.deepEqual(await paid(), { 'INV-2026-J06': '0', 'INV-2026-J10': '0', 'INV-2026-J11': '0' });
  });

  await t.test('khớp HAI hoá đơn mở ⇒ vẫn hỏi lại, ứng viên đủ các hoá đơn mở; không tự chọn', async () => {
    await f.rollbackCase(async () => {
      await addInvoice(J08, 'INV-2026-J08', 'OVERDUE', '2026-08', '2026-08-31', 1150000);
      const two = await run('preview', rid(92), params);
      assert.deepEqual([two.kind, two.field, two.why, two.candidates.map(c => c.name)], ['needs_input', 'invoice', 'ambiguous',
        ['kỳ 10/2026 · INV-2026-J10 (còn 1.150.000đ)', 'kỳ 08/2026 · INV-2026-J08 (còn 1.150.000đ)', 'kỳ 06/2026 · INV-2026-J06 (còn 640.500đ)']]);
    });
  });

  // "Không đổi" đo bằng ĐỐI CHIẾU: cùng lời gọi, cùng dữ liệu, thân TRƯỚC J06 (tra cứu 181440 + bước ghi C07) và thân J06 phải trả y hệt. Gọi trong
  // rollbackCase: thân cũ nạp lại trong giao dịch rồi lùi cùng ca.
  const sameAsBefore = async cases => {
    const outputs = async () => { const out = []; for (const [i, [, input]] of cases.entries()) out.push(await run('preview', rid(100 + i), input)); return out; };
    const now = await outputs();
    for (const sql of COLLECT_BEFORE_J06) await db.exec(sql);
    const old = await outputs();
    for (const [i, [label]] of cases.entries()) assert.deepEqual(now[i], old[i], label);
    return now;
  };
  await t.test('không khớp / không số tiền / đã nêu kỳ / đã nêu số hoá đơn / phòng một hoá đơn mở / lô có kỳ ⇒ y hệt thân trước J06', async () => {
    await f.rollbackCase(async () => {
      const now = await sameAsBefore([
        ['không khớp', { ...params, amount: 1000000 }],
        ['không số tiền', { buildingName: 'toa a', roomName: 'p302', method: 'TK' }],
        ['đã nêu kỳ', { ...params, month: '2026-10' }],
        ['đã nêu kỳ khác (trả dư)', { ...params, month: '2026-06' }],
        ['đã nêu số hoá đơn', { ...params, amount: 640500, invoiceNumber: 'INV-2026-J10' }],
        ['phòng một hoá đơn mở, số tiền đúng số còn nợ', { buildingName: 'toa a', roomName: 'p102', method: 'TK', amount: 2000000 }],
        ['lô có kỳ', { buildingName: 'toa a', method: 'TK', items: [{ roomName: 'P302', month: '2026-10', amount: 1150000 }, { roomName: 'P102', amount: 100000 }] }]]);
      assert.deepEqual(now.map(o => o.kind), ['needs_input', 'needs_input', 'preview', 'preview', 'preview', 'preview', 'preview']);
      assert.deepEqual([now[0].why, now[1].why], ['ambiguous', 'ambiguous'], 'không khớp / không số tiền ⇒ hỏi lại như cũ');
      assert.ok(now.every(o => !/tự chọn|TỰ CHỌN|pickedBy/.test(JSON.stringify(o))), 'không câu "tự chọn"');
    });
  });
  await t.test('đã nêu kỳ mà kỳ đó còn HAI hoá đơn mở, số tiền khớp đúng một ⇒ vẫn hỏi lại, y hệt thân trước J06', async () => {
    await f.rollbackCase(async () => {
      await addInvoice(J10B, 'INV-2026-J10B', 'APPROVED', '2026-10', '2026-10-30', 300000, 'EXTRA');
      const [same] = await sameAsBefore([['cùng kỳ hai hoá đơn', { ...params, month: '2026-10' }]]);
      assert.deepEqual([same.kind, same.why, same.candidates.map(c => c.name)], ['needs_input', 'ambiguous',
        ['kỳ 10/2026 · INV-2026-J10 (còn 1.150.000đ)', 'kỳ 10/2026 · INV-2026-J10B (còn 300.000đ, extra)']]);
    });
  });

  await t.test('lô: mục không nêu kỳ, số tiền khớp đúng một ⇒ tự chọn theo mục; tóm tắt nêu phòng + kỳ; mục khác như cũ', async () => {
    const batch = await run('preview', rid(93), { buildingName: 'toa a', method: 'TK', items: [{ roomName: 'P302', amount: 1150000 }, { roomName: 'P102', amount: 100000 }] });
    assert.equal(batch.kind, 'preview', JSON.stringify(batch));
    assert.deepEqual(batch.resolved.items.map(i => [i.invoiceId, i.pickedBy ?? null]), [[J10, 'amount'], [INV_B, null]]);
    assert.deepEqual(batch.preview.items.map(i => i.pickedBy ?? null), ['amount', null]);
    assert.match(batch.preview.summary, / cho 2 hoá đơn\. Tự chọn hoá đơn theo số tiền khớp đúng số còn nợ: phòng P302 kỳ 10\/2026\.$/);
    assert.deepEqual(batch.warnings, [DEFAULT_BOOK_WARNING, AUTO_J10]);
    assert.deepEqual(await trace(), before);
  });

  await t.test('đối chứng đột biến: bỏ điều kiện "đúng một" (khớp từ một ⇒ lấy hoá đơn đầu) ⇒ khớp hai cũng tự chọn — ca "khớp HAI" ở trên bắt được', async () => {
    const lookup = J06_SQL.match(/CREATE OR REPLACE FUNCTION app_private\.hermes_invoice_lookup_core_v3\([\s\S]*?\$fn\$;/)[0];
    const exactlyOne = "IF jsonb_array_length(COALESCE(v_match,'[]'::jsonb))=1 THEN";
    assert.equal(lookup.split(exactlyOne).length, 2, 'điều kiện "đúng một" nằm đúng một chỗ');
    await f.rollbackCase(async () => {
      await addInvoice(J08, 'INV-2026-J08', 'OVERDUE', '2026-08', '2026-08-31', 1150000);
      await db.exec(lookup.replace(exactlyOne, () => "IF jsonb_array_length(COALESCE(v_match,'[]'::jsonb))>=1 THEN"));
      const mutant = await run('preview', rid(94), params);
      assert.deepEqual([mutant.kind, mutant.resolved?.items[0].invoiceId, mutant.resolved?.items[0].pickedBy], ['preview', J10, 'amount'],
        'đột biến tự chọn dù hai hoá đơn cùng khớp ⇒ khẳng định "vẫn hỏi lại" của ca khớp HAI đỏ');
    });
    const live = (await db.query("SELECT prosrc FROM pg_proc WHERE oid='app_private.hermes_invoice_lookup_core_v3(uuid,uuid[],text,jsonb)'::regprocedure")).rows[0].prosrc;
    assert.ok(live.includes(exactlyOne), 'đột biến đã lùi: thân sống giữ điều kiện "đúng một"');
  });

  // TC-J06 qua connector: broker + runtime THẬT, cổng dịch vụ gọi đúng RPC trang trên fixture (thay adapter PostgREST). confirmToken gắn [kết nối,
  // thao tác, params chuẩn hoá, requestId]; bản ghi chờ của token giữ resolved + basis của bản xem trước (mô hình không thấy, không gửi lại được).
  await t.test('vòng đời qua connector: "ck … rồi nha" ⇒ xem trước tự chọn kỳ 10; "ok ghi đi" kèm confirmToken ⇒ ghi ĐÚNG hoá đơn đó; xác nhận lệch params ⇒ không ghi', async st => {
    const scope = createDependencyScope(); st.after(() => scope.close());
    const NOW = Date.parse('2026-10-22T03:00:00.000Z'), TOKEN = `hc_${'A'.repeat(43)}`;
    const requests = [], previews = [], applies = [];
    const service = {
      async prepareAction(_token, request) { requests.push(structuredClone(request)); return Object.freeze({}); },
      async finalizeAction() {
        const request = requests.at(-1);
        if (request.phase === 'apply') {
          const out = await run('apply', request.requestId, request.params, { resolved: request.resolved, basis: request.basis });
          applies.push(out); return out;
        }
        const out = await run(request.phase, request.requestId, request.params);
        previews.push(out); return out;
      },
    };
    const identity = () => ({ row: { id: uid(960), assistantId: uid(961), userId: USER, organizationId: ORG, expiresAt: NOW + 86_400_000, epoch: 1, state: 'active',
      restrictions: { read: [], action: [INVOICE_COLLECT_KEY] } }, effective: { read: [], action: [INVOICE_COLLECT_KEY] }, isSuperadmin: false,
    policyEpoch: 'a'.repeat(64), contextVersion: 'b'.repeat(64), assistantScopeIds: [uid(962)],
    scopesByPermission: { [INVOICE_COLLECT_KEY]: { buildingIds: [BUILDING], cashbookIds: [] } } });
    let next = 0;
    const runtime = createActionRuntime({ catalog: invoiceCatalog(), service, clock: () => NOW, mintRequestId: () => rid(120 + ++next) });
    const broker = createBroker({ authority: { identifyConnection: async () => ({ connectionId: uid(960) }), resolve: async () => identity(), checkUnchanged: async () => {} },
      dependencyScope: scope, audit: async () => {}, clock: () => NOW, actions: runtime });
    const call = async args => {
      const result = await broker.callTool(TOKEN, 'crm_action_run', args); assert.equal(result.isError, false); return JSON.parse(result.content[0].text);
    };

    // Mô hình đổi kỳ ở lượt xác nhận (params khác bản đã xem) ⇒ token không khớp; không lệnh ghi nào xuống SQL.
    const drafted = await call({ action: 'invoice.collect', params });
    assert.equal(drafted.outcome, 'confirmation_required');
    await assert.rejects(broker.callTool(TOKEN, 'crm_action_run', { action: 'invoice.collect', params: { ...params, month: '2026-06' }, requestId: drafted.requestId,
      confirmToken: drafted.confirmToken }), error => error.code === 'confirmation_invalid');
    assert.deepEqual(requests.map(r => r.phase), ['preview']);

    // Đúng hai lượt của TC-J06.
    const first = await call({ action: 'invoice.collect', params });
    assert.deepEqual([first.outcome, first.applied], ['confirmation_required', false]);
    assert.match(first.preview.summary, /Tự chọn hoá đơn kỳ 10\/2026 vì số tiền khớp đúng số còn nợ\.$/);
    assert.deepEqual(first.warnings, [DEFAULT_BOOK_WARNING, AUTO_J10]);
    const applied = await call({ action: 'invoice.collect', params, requestId: first.requestId, confirmToken: first.confirmToken });
    assert.equal(applied.outcome, 'applied', JSON.stringify(applied));
    assert.deepEqual([applied.result.invoices[0].invoiceNumber, applied.result.invoices[0].month, applied.result.invoices[0].applied,
      applied.result.invoices[0].statusAfter, applied.link], ['INV-2026-J10', '10/2026', '1150000', 'PAID', `/invoices/${J10}`]);
    const write = requests.at(-1);
    assert.deepEqual([write.phase, write.requestId, write.params], ['apply', first.requestId, params]);
    assert.deepEqual([write.resolved, write.basis], [previews.at(-1).resolved, previews.at(-1).basis], 'lượt ghi mang đúng resolved + basis của bản xem trước đã đồng ý');
    assert.equal(write.resolved.items[0].invoiceId, J10);
    assert.deepEqual(await paid(), { 'INV-2026-J06': '0', 'INV-2026-J10': '1150000', 'INV-2026-J11': '0' });
    const after = await trace();
    assert.deepEqual([after.collections - before.collections, after.receipts - before.receipts], [1, 1]);
    assert.deepEqual(await applyWith(first.requestId, params, previews.at(-1)), applies.at(-1), 'phát lại y nguyên');
  });
});
