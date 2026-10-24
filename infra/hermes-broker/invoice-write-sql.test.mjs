import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_REASON_CODES, ACTION_INPUT_REASONS } from './action-reasons.mjs';
import { invoiceSetup, uid, rid, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, CASHBOOK, ORG, INV_A, INV_A9, INV_B, INV_D10, TK1, TK2, TT1, ROUNDING, CONTRACT, STRANGER }
  from './invoice-write-fixture.mjs';

// RPC trang Hoá đơn (Đợt 3 Mốc 3, HOA-DON-THAO-TAC-GHI.md mục 2–5, 4.1) trên PGlite với fixture Hermes của thu chi (binding/phiên/chính
// sách thật của các migration Hermes; quyền CRM giả qua fixture_acl). Hai migration của mốc chạy THẬT (mỗi file hai lượt), hàm kế hoạch dùng
// chung thật, invoice_room_invoices_v1 thật (Mốc 2), nợ thực #267 thật. Hàm ghi web record_invoice_collection_v5 ở đây là BẢN PORT (cùng
// chữ ký, cùng câu lỗi đã liệt kê ở mục 5, idempotency theo khoá + băm, khoá lạc quan p_expected_paid_amount) — nó chứng minh logic của
// bước ghi Hermes (chạy thử không để lại dấu vết, lô cả-hoặc-không, basis, lý do, phạm vi), KHÔNG chứng minh v5 thật: phần đó đo ở tầng 2.
const code = expected => error => error.code === expected;

test('hermes_invoice_action_v1 (invoice.collect): tiền mặt chặn, chạy thử không để lại dấu vết, lô cả-hoặc-không, basis, lý do, phạm vi', { timeout: 300000 }, async t => {
  const f = await invoiceSetup(t, { l8: true });
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
    assert.match(preview.preview.summary, /^Sẽ ghi THU 3\.650\.000đ bằng chuyển khoản ngày 22\/10\/2026 \(thứ Năm, hôm nay\) vào sổ «VCB toà A \*\*\*» cho hoá đơn INV-A-10\.$/);
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
      assert.match(preview.preview.summary, /^Sẽ ghi THU 4\.500\.000đ bằng thanh toán \(TT\/POS\) ngày .* vào sổ «POS toà A» cho 2 hoá đơn\.$/);
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
      assert.match(keep.preview.summary, /^Sẽ ghi THU 2\.600\.000đ bằng thanh toán \(TT\/POS\) ngày .* vào sổ «POS toà A» cho hoá đơn INV-D-10\.$/);
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
      assert.deepEqual(preview.warnings, ['Ngày thu lùi 12 ngày so với hôm nay.', 'Phòng P102: số tiền không tròn nghìn — kiểm lại đơn vị.']);
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
    assert.match(named.preview.summary, /vào sổ «MB toà A»/);
    const wrongBook = await run('preview', rid(21), one({ roomName: 'P102', amount: 100000, cashbookName: 'quỹ lạ' }));
    assert.deepEqual([wrongBook.kind, wrongBook.field, wrongBook.why, wrongBook.candidates.map(c => c.name)],
      ['needs_input', 'cashbook', 'not_visible', ['VCB toà A ***', 'MB toà A']]);
    for (const bad of [{ buildingName: 'Toà A', method: 'TK' }, { ...one(), items: [{ roomName: 'P102' }] },
      { buildingName: 'Toà A', method: 'TK', amount: 1000, items: [{ roomName: 'P102' }] }, { buildingName: 'Toà A', method: 'TK', items: [{ roomName: 'P102' }, { roomName: 'p102' }] },
      { buildingName: 'Toà A', method: 'TK', invoiceNumber: 'INV-B-10', items: [{ roomName: 'P102' }] }])
      assert.deepEqual(await run('preview', rid(22), bad), { kind: 'rejected', reason: 'invalid_params' }, JSON.stringify(bad));
    assert.deepEqual(await run('preview', rid(23), one({ date: '2026-10-23' })), { kind: 'rejected', reason: 'date_out_of_range' });
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
    // Tầng v1 (vỏ cũ) còn nguyên quyền nhưng vỏ không còn gọi (lượt 8: thu tiền đi tầng v2).
    assert.deepEqual(acl.map(r => [r.fn.replace(/\(.*/, ''), r.prosecdef, r.standard, r.auth, r.anon]), [
      ['app_private.hermes_invoice_action_step_v1', true, false, true, false], ['app_private.hermes_invoice_action_step_v2', true, false, true, false],
      ['app_private.hermes_invoice_lookup_core_v1', false, false, true, false], ['app_private.hermes_invoice_lookup_core_v2', false, false, true, false],
      ['app_private.hermes_invoice_reason_v1', false, false, false, false],
      ['hermes_invoice_action_v1', false, true, true, false], ['invoice_collection_plan_core_v1', false, false, true, false],
      ['invoice_collection_plan_v1', false, false, true, false]]);
  });
});
