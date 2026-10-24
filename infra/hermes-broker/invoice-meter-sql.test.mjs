import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_REASON_CODES, ACTION_INPUT_REASONS } from './action-reasons.mjs';
import { invoiceSetup, rid, uid, BUILDING, OTHER_BUILDING, ORG, USER, M1, M2, M3, M4B, M5, M6, M7, STRANGER } from './invoice-write-fixture.mjs';

// Đợt 3 Hoá đơn Mốc 4 (HOA-DON-THAO-TAC-GHI.md mục 4.2, 6.2) trên PGlite: hàm dùng chung public.meter_readings_plan_v1 +
// public.record_meter_readings_v2 (migration THẬT, mỗi file hai lượt) với năm trigger BEFORE INSERT của production chạy nguyên văn; và nhánh
// invoice.meter_record của RPC trang (bước ghi Hermes). Bẫy đã biết được ghi thành ca: chỉ số đầu của dòng = luật trigger (có
// initial_reading), chỉ số đầu của HOÁ ĐƠN = dòng APPROVED mới nhất (không initial_reading); chỉ số chốt trả phòng TLY… cùng kỳ không phải
// trùng; ghi lùi ngày trước một chỉ số sau thì chặn. Khoá không chờ ở lượt 2 đo ở invoice-meter-race-sql.test.mjs (PG17 hai kết nối).
const code = expected => error => error.code === expected;

test('chỉ số tháng: hàm dùng chung (web) + invoice.meter_record (Hermes)', { timeout: 300000 }, async t => {
  const f = await invoiceSetup(t, { meter: true, l14: true });
  const { db, call, meterRun, meterApply } = f;
  const writer = (rows, { date = '2026-10-22', replace = false, key = null, building = BUILDING, actor = USER } = {}) => call(
    'SELECT public.record_meter_readings_v2($1::uuid,$2::date,$3::jsonb,$4,$5) result', [building, date, JSON.stringify(rows), replace, key], { actor });
  const plan = (rows, { date = '2026-10-22', replace = false } = {}) => call(
    'SELECT public.meter_readings_plan_v1($1::uuid,$2::date,$3::jsonb,$4) result', [BUILDING, date, JSON.stringify(rows), replace]);
  const readings = async meter => (await db.query(`SELECT reading_code,reading_date::text d,previous_reading::float p,current_reading::float c,status,
    approved_by,recorded_by,user_id,settlement_month m,notes,meter_image_url img FROM public.meter_readings WHERE meter_id=$1 AND deleted_at IS NULL ORDER BY reading_date,created_at`, [meter])).rows;
  const ops = async () => (await db.query("SELECT count(*)::int n FROM app_private.canonical_write_operations WHERE operation='meter.readings.v2'")).rows[0].n;
  const batch = (extra = {}) => ({ buildingName: 'toa a', readings: [{ roomName: 'p101', value: 1234 }, { roomName: 'P102', value: 1100 },
    { roomName: 'P103', value: 360 }, { roomName: 'P104', value: 10 }, { roomName: 'P105', value: 2000 }], ...extra });

  await t.test('kế hoạch (INVOKER): số đầu theo trigger, số đầu hoá đơn, trùng tháng bỏ TLY, ghi lùi ngày, nhiều công tơ, cảnh báo', async () => {
    const p = await plan([{ meterId: M1, value: 1234 }, { meterId: M2, value: 1100 }, { meterId: M3, value: 360 }, { roomId: uid(813), value: 10 },
      { meterId: M5, value: 2000 }, { meterId: M5, value: 2300 }, { meterId: M7, value: 170 }, { roomId: uid(813), meterCode: 'dh-104b', value: 10 }]);
    // P103: chỉ số tháng 10 đã lên hoá đơn INV_C ⇒ nói ngay used_by_invoice (lượt 8; trước đây duplicate_month gợi ý "nói sửa").
    assert.deepEqual(p.rows.map(r => [r.n, r.status]), [[1, 'ok'], [2, 'ok'], [3, 'used_by_invoice'], [4, 'meter_ambiguous'], [5, 'lower_than_previous'],
      [6, 'duplicate_in_batch'], [7, 'ok'], [8, 'ok']]);
    assert.deepEqual([p.ok, p.settlementMonth, p.counts], [false, '2026-10', { ok: 4, replace: 0, blocked: 4 }]);
    assert.deepEqual([p.rows[0].previous, p.rows[0].approvedStart, p.rows[0].consumption, p.rows[0].roomName], [1200, 1200, 34, 'P101']);
    assert.deepEqual(p.rows[1].warnings, [{ code: 'high_consumption', avg3: 100, ratio: 4 }]);
    assert.deepEqual([p.rows[2].existing.value, p.rows[2].existing.count], [350, 1]);
    assert.deepEqual(p.rows[3].candidates, ['DH-104A', 'DH-104B']);
    // Công tơ chưa có chỉ số nào: trigger lấy initial_reading 2.210 làm số đầu (CHECK so với số này), hoá đơn tháng lại tính từ 0.
    assert.deepEqual([p.rows[4].previous, p.rows[4].approvedStart], [2210, undefined]);
    // TLY… cùng kỳ là chỉ số chốt trả phòng, không phải trùng tháng; số đầu của dòng mới = chỉ số TLY (trigger lấy dòng mới nhất).
    assert.deepEqual([p.rows[6].previous, p.rows[6].existing], [150, undefined]);
    const first = await plan([{ meterId: M5, value: 2300 }]);
    assert.deepEqual(first.rows[0].warnings, [{ code: 'no_approved_start', previous: 2210, initialReading: 2210 }]);
    // Ghi lùi ngày trước chỉ số đã có ⇒ chặn (trigger sẽ lấy chỉ số sau làm số đầu).
    assert.deepEqual((await plan([{ meterId: M7, value: 120 }], { date: '2026-09-30' })).rows.map(r => [r.status, r.laterReadingDate]), [['has_later_reading', '2026-10-05']]);
    assert.deepEqual((await plan([{ roomId: uid(810 + 999), value: 1 }])).rows[0].status, 'meter_not_found');
  });

  await t.test('hàm ghi (đường web): lô cả-hoặc-không, trigger điền số đầu/mã/kỳ, idempotency theo khoá + băm, trùng tháng bị từ chối có DETAIL', async () => {
    await f.rollbackCase(async () => {
      const before = await readings(M1);
      await assert.rejects(writer([{ meterId: M1, value: 1234 }, { meterId: M3, value: 360 }], { key: 'web-00000001' }), error => {
        assert.equal(error.code, '22023'); assert.equal(error.message, 'meter_readings_rejected'); assert.equal(error.hint, 'used_by_invoice');
        assert.deepEqual(JSON.parse(error.detail), [{ n: 2, status: 'used_by_invoice', roomName: 'P103', meterCode: 'DH-103', previous: 350, existingValue: 350 }]);
        return true;
      });
      assert.deepEqual(await readings(M1), before, 'cả lô lùi');
      const rows = [{ meterId: M1, value: 1234, notes: 'đọc tay', imageUrl: 'u/1.jpg' }, { meterId: M2, value: 1100 }];
      const done = await writer(rows, { key: 'web-00000002' });
      assert.deepEqual([done.count, done.settlementMonth, done.created.map(r => [r.n, r.previous, r.value, r.consumption])], [2, '2026-10', [[1, 1200, 1234, 34], [2, 700, 1100, 400]]]);
      assert.match(done.created[0].code, /^CSS2610\d{5}$/);
      const m1 = (await readings(M1)).at(-1);
      assert.deepEqual([m1.d, m1.p, m1.c, m1.status, m1.approved_by, m1.recorded_by, m1.user_id, m1.m, m1.notes, m1.img],
        ['2026-10-22', 1200, 1234, 'APPROVED', USER, USER, USER, '2026-10', 'đọc tay', 'u/1.jpg']);
      assert.deepEqual(await writer(rows, { key: 'web-00000002' }), done, 'phát lại cùng khoá');
      await assert.rejects(writer([{ meterId: M1, value: 1240 }], { key: 'web-00000002' }), code('23505'));
      assert.equal(await ops(), 1);
      // Đã có chỉ số tháng 10 ⇒ form web nhận "đã có chỉ số tháng này" thay vì ghi dòng thứ hai.
      await assert.rejects(writer([{ meterId: M1, value: 1240 }], { key: 'web-00000003' }), error => error.code === '22023' && error.hint === 'duplicate_month');
      assert.equal((await readings(M1)).length, 2);
    });
  });

  await t.test('hàm ghi: quyền đúng policy (tạo / sửa), tổ chức, người chưa đăng nhập; kế hoạch chỉ cho authenticated/postgres', async () => {
    await f.rollbackCase(async () => {
      await db.query("DELETE FROM public.fixture_meter_acl WHERE permission='meter_readings.create' AND building_id=$1", [OTHER_BUILDING]);
      await assert.rejects(writer([{ meterId: M6, value: 5 }], { building: OTHER_BUILDING }), code('42501'));
      await assert.rejects(writer([{ meterId: M1, value: 1234 }], { actor: STRANGER }), code('42501'), 'không thuộc tổ chức');
      await assert.rejects(call('SELECT public.record_meter_readings_v2($1,$2,$3::jsonb) result', [BUILDING, '2026-10-22', JSON.stringify([{ meterId: M1, value: 1 }])], { actor: '' }), code('42501'));
      // "Sửa" cần thêm meter_readings.edit.
      await db.query("DELETE FROM public.fixture_meter_acl WHERE permission='meter_readings.edit'");
      await db.query("UPDATE public.meter_readings SET current_reading=350 WHERE meter_id=$1", [M3]); // giữ nguyên
      await db.query("DELETE FROM public.invoice_items WHERE current_reading=350");
      await assert.rejects(writer([{ meterId: M3, value: 360 }], { replace: true }), code('42501'));
      await assert.rejects(call('SELECT public.meter_readings_plan_v1($1,$2,$3::jsonb) result', [BUILDING, '2026-10-22', JSON.stringify([{ meterId: M1, value: 1 }])], { role: 'anon' }), code('42501'));
    });
  });

  await t.test('hàm ghi: "sửa" thay số dòng tháng cũ khi chưa lên hoá đơn; đã lên hoá đơn / có chỉ số sau ⇒ từ chối', async () => {
    await f.rollbackCase(async () => {
      await assert.rejects(writer([{ meterId: M3, value: 360 }], { replace: true }), error => error.hint === 'used_by_invoice');
      await db.query("DELETE FROM public.invoice_items WHERE current_reading=350");
      const done = await writer([{ meterId: M3, value: 360 }], { replace: true, key: 'web-00000004' });
      assert.deepEqual([done.count, done.created, done.replaced.map(r => [r.previous, r.value])], [1, [], [[300, 360]]]);
      assert.deepEqual((await readings(M3)).map(r => [r.d, r.p, r.c, r.status]), [['2026-10-22', 300, 360, 'APPROVED']]);
      await db.query("INSERT INTO public.meter_readings(meter_id,reading_date,current_reading,status,organization_id) VALUES($1,'2026-10-31',380,'APPROVED',$2)", [M3, ORG]);
      await assert.rejects(writer([{ meterId: M3, value: 365 }], { replace: true }), error => error.hint === 'duplicate_month', 'hai dòng tháng ⇒ không biết thay dòng nào');
    });
  });

  await t.test('lượt 8 — chỉ số chốt kỳ trước ghi trước ngày (lập hoá đơn Excel: tạo 29/09, ngày 31/10, kỳ 10) không phải trùng tháng / ngày sau', async () => {
    await f.rollbackCase(async () => {
      // P101: số cuối kỳ 10 đã lên hoá đơn INV-A-10 (dòng điện 1.200 → 1.250); P105: số cuối kỳ 10 chưa lên hoá đơn nào.
      const closing = (meter, value) => db.query(`INSERT INTO public.meter_readings(meter_id,reading_date,current_reading,status,organization_id,created_at)
        VALUES($1,'2026-10-31',$2,'APPROVED',$3,'2026-09-29 03:00:00+00')`, [meter, value, ORG]);
      await closing(M1, 1250); await closing(M5, 2300);
      const p = await plan([{ meterId: M1, value: 1290 }, { meterId: M5, value: 2350 }]);
      assert.deepEqual(p.rows.map(r => [r.status, r.previous, r.approvedStart, r.consumption, r.existing]),
        [['ok', 1250, 1250, 40, undefined], ['ok', 2300, 2300, 50, undefined]], 'số đầu = chỉ số chốt kỳ trước (đúng trigger)');
      // "Sửa" khi tháng chỉ còn chỉ số chốt đã lên hoá đơn = sửa số trên hoá đơn ⇒ điều chỉnh hoá đơn trên web; chưa lên hoá đơn ⇒ ghi mới.
      assert.deepEqual((await plan([{ meterId: M1, value: 1290 }, { meterId: M5, value: 2350 }], { replace: true })).rows.map(r => r.status), ['used_by_invoice', 'ok']);
      assert.deepEqual(await meterRun('preview', rid(84), { buildingName: 'Toà A', readings: [{ roomName: 'P101', value: 1290 }], replace: true }),
        { kind: 'rejected', reason: 'meter_used_by_invoice' });
      // Ngày chốt = chính ngày của chỉ số chốt: dòng mới sẽ thành "APPROVED mới nhất" (số đầu hoá đơn kỳ sau) ⇒ vẫn chặn như cũ.
      assert.deepEqual((await plan([{ meterId: M1, value: 1290 }], { date: '2026-10-31' })).rows.map(r => r.status), ['used_by_invoice']);
      // Chỉ số đọc THẬT sau ngày chốt mới vẫn chặn: số chốt P105 đọc 29/09 > 20/09.
      assert.deepEqual((await plan([{ meterId: M5, value: 2250 }], { date: '2026-09-20' })).rows.map(r => [r.status, r.laterReadingDate]),
        [['has_later_reading', '2026-09-29']]);
      // Bot ghi chỉ số tháng này (ca nghiệm thu 24/10): xem trước, ghi, trigger điền số đầu đúng kế hoạch.
      const params = { buildingName: 'Toà A', readings: [{ roomName: 'P101', value: 1290 }] };
      const preview = await meterRun('preview', rid(85), params);
      assert.equal(preview.kind, 'preview', JSON.stringify(preview));
      assert.deepEqual(preview.preview.items.map(i => i.text), ['P101: 1.250 → 1.290 (40 kWh)']);
      const applied = await meterApply(rid(85), params, preview);
      assert.equal(applied.kind, 'applied', JSON.stringify(applied));
      assert.deepEqual((await readings(M1)).map(r => [r.d, r.p, r.c, r.m]),
        [['2026-09-30', 1000, 1200, '2026-09'], ['2026-10-22', 1250, 1290, '2026-10'], ['2026-10-31', 1200, 1250, '2026-10']]);
      // Đã có chỉ số tháng thật (chưa lên hoá đơn) ⇒ trùng tháng; "sửa" thay đúng dòng đó, giữ số đầu đã lưu.
      assert.deepEqual(await meterRun('preview', rid(86), { ...params, readings: [{ roomName: 'P101', value: 1300 }] }), { kind: 'rejected', reason: 'meter_duplicate_month' });
      const fix = await meterRun('preview', rid(87), { ...params, readings: [{ roomName: 'P101', value: 1300 }], replace: true });
      assert.deepEqual(fix.preview.items.map(i => i.text), ['P101: THAY số cũ 1.290; 1.250 → 1.300 (50 kWh)']);
      // Đường web (cùng hàm ghi): P105 ghi được ngay.
      const web = await writer([{ meterId: M5, value: 2350 }], { key: 'web-00000009' });
      assert.deepEqual(web.created.map(r => [r.previous, r.value]), [[2300, 2350]]);
    });
  });

  await t.test('Hermes: lô xem trước nêu dòng sẽ ghi, dòng bị loại, cảnh báo; lượt 2 ghi đúng tập đã xem; phát lại; khác nội dung', async () => {
    await f.rollbackCase(async () => {
      const preview = await meterRun('preview', rid(70), batch());
      assert.equal(preview.kind, 'preview', JSON.stringify(preview));
      assert.equal(preview.preview.summary, 'Sẽ ghi 2 chỉ số ĐIỆN toà Toà A, ngày chốt 22/10/2026 (thứ Năm, hôm nay), tháng 10/2026.');
      assert.deepEqual(preview.preview.items.map(i => i.text), ['P101: 1.200 → 1.234 (34 kWh)', 'P102: 700 → 1.100 (400 kWh)']);
      assert.deepEqual(preview.preview.excluded, [
        'P103: chỉ số tháng này đã lên hoá đơn; sửa bằng điều chỉnh hoá đơn trên web — không ghi',
        'P104: phòng có nhiều công tơ điện (DH-104A, DH-104B); nêu mã công tơ — không ghi',
        'P105: chỉ số 2.000 nhỏ hơn số đầu 2.210 — không ghi']);
      assert.deepEqual(preview.warnings, ['P102: tiêu thụ 400 kWh, gấp 4,0 lần trung bình 3 kỳ (100 kWh) — đọc lại số cho người dùng.']);
      assert.equal((await readings(M1)).length, 1, 'xem trước không ghi');
      const applied = await meterApply(rid(70), batch(), preview);
      assert.equal(applied.kind, 'applied', JSON.stringify(applied));
      assert.equal(applied.link, '/meter-readings');
      assert.match(applied.result.text, /^Đã ghi 2 chỉ số ĐIỆN toà Toà A, ngày chốt 22\/10\/2026 \(tháng 10\/2026\)\.$/);
      assert.deepEqual(applied.result.readings.map(r => [r.room, r.previous, r.value]), [['P101', '1200', '1234'], ['P102', '700', '1100']]);
      assert.deepEqual(applied.result.excluded.length, 3);
      assert.deepEqual((await db.query("SELECT idempotency_key k FROM app_private.canonical_write_operations WHERE operation='meter.readings.v2'")).rows, [{ k: `hermes-meter:${rid(70)}` }]);
      assert.deepEqual(await meterApply(rid(70), batch(), preview), applied, 'phát lại');
      const other = await meterRun('preview', rid(71), batch({ readings: [{ roomName: 'P105', value: 2300 }] }));
      assert.deepEqual(await meterApply(rid(70), batch({ readings: [{ roomName: 'P105', value: 2300 }] }), other), { kind: 'rejected', reason: 'request_conflict' });
    });
  });

  await t.test('Hermes: không còn dòng ghi được ⇒ lý do của dòng đầu; sửa; ngày chốt Q16; loại công tơ; chỉ số đầu hoá đơn; TLY', async () => {
    await f.rollbackCase(async () => {
      const only = readings => ({ buildingName: 'Toà A', readings });
      // P102 có chỉ số tháng 10 thật (đọc 15/10, chưa lên hoá đơn) ⇒ trùng tháng, "sửa" mới thay.
      await db.query("INSERT INTO public.meter_readings(meter_id,reading_date,current_reading,status,organization_id) VALUES($1,'2026-10-15',750,'APPROVED',$2)", [M2, ORG]);
      for (const [rows, reason] of [[[{ roomName: 'P102', value: 800 }], 'meter_duplicate_month'], [[{ roomName: 'P104', value: 1 }], 'meter_ambiguous'],
        [[{ roomName: 'P105', value: 2000 }], 'meter_lower_than_previous']]) {
        assert.deepEqual(await meterRun('preview', rid(72), only(rows)), { kind: 'rejected', reason }, reason);
        assert.ok(ACTION_INPUT_REASONS.includes(reason), reason);
      }
      assert.deepEqual(await meterRun('preview', rid(72), { ...only([{ roomName: 'P101', value: 5 }]), meterType: 'nuoc' }), { kind: 'rejected', reason: 'meter_not_found' });
      for (const replace of [false, true])
        assert.deepEqual(await meterRun('preview', rid(72), { ...only([{ roomName: 'P103', value: 360 }]), replace }), { kind: 'rejected', reason: 'meter_used_by_invoice' });
      assert.ok(ACTION_REASON_CODES.includes('meter_used_by_invoice') && !ACTION_INPUT_REASONS.includes('meter_used_by_invoice'));
      assert.deepEqual(await meterRun('preview', rid(72), { ...only([{ roomName: 'P106', value: 120 }]), month: '2026-09' }), { kind: 'rejected', reason: 'meter_has_later_reading' });
      assert.deepEqual(await meterRun('preview', rid(72), { ...only([{ roomName: 'P101', value: 1300 }]), month: '2026-11' }), { kind: 'rejected', reason: 'date_out_of_range' });
      const sept = await meterRun('preview', rid(73), { ...only([{ roomName: 'P105', value: 2300 }]), month: '2026-09' });
      assert.match(sept.preview.summary, /ngày chốt 30\/09\/2026 \(thứ Tư\), tháng 09\/2026\.$/);
      assert.deepEqual(sept.warnings, ['P105: công tơ chưa có chỉ số đã duyệt; hoá đơn tháng tính chỉ số đầu = 0 (không lấy chỉ số ban đầu 2.210 của công tơ). Nhập chỉ số đầu trên web trước khi lập hoá đơn.']);
      const tly = await meterRun('preview', rid(74), only([{ roomName: 'P106', value: 170 }, { roomName: 'P104', meterCode: 'dh-104b', value: 7 }]));
      assert.deepEqual(tly.preview.items.map(i => i.text), ['P106: 150 → 170 (20 kWh)', 'P104 (DH-104B): 0 → 7 (7 kWh)']);
      // Sửa dòng tháng chưa lên hoá đơn: cần meter_readings.edit; bản xem trước nêu số cũ.
      await db.query("DELETE FROM public.invoice_items WHERE current_reading=350");
      const fix = await meterRun('preview', rid(75), { ...only([{ roomName: 'P103', value: 360 }]), replace: true });
      assert.equal(fix.preview.summary, 'Sẽ ghi 1 chỉ số ĐIỆN toà Toà A, ngày chốt 22/10/2026 (thứ Năm, hôm nay), tháng 10/2026 (1 dòng THAY số cũ).');
      assert.deepEqual(fix.preview.items.map(i => i.text), ['P103: THAY số cũ 350; 300 → 360 (60 kWh)']);
      const done = await meterApply(rid(75), { ...only([{ roomName: 'P103', value: 360 }]), replace: true }, fix);
      assert.match(done.result.text, /; thay 1 dòng cũ\.$/);
      await db.query("DELETE FROM public.fixture_meter_acl WHERE permission='meter_readings.edit'");
      assert.deepEqual(await meterRun('preview', rid(76), { ...only([{ roomName: 'P101', value: 1300 }]), replace: true }), { kind: 'rejected', reason: 'not_allowed' });
    });
  });

  await t.test('Hermes: phạm vi = guard ∩ quyền ghi của hàm web (ngay ở bản xem trước); bản đã giải giả; basis lệch; hàm ghi từ chối lô', async () => {
    await f.rollbackCase(async () => {
      await db.query("UPDATE public.authorization_scopes SET scope_type='ORGANIZATION',building_id=NULL WHERE organization_id=$1 AND scope_type='BUILDING'", [ORG]);
      const b = await meterRun('preview', rid(77), { buildingName: 'Toà B', readings: [{ roomName: 'P201', value: 5 }] });
      assert.equal(b.kind, 'preview', JSON.stringify(b));
      await db.query("DELETE FROM public.fixture_meter_acl WHERE permission='meter_readings.create' AND building_id=$1", [OTHER_BUILDING]);
      assert.deepEqual(await meterRun('preview', rid(78), { buildingName: 'Toà B', readings: [{ roomName: 'P201', value: 5 }] }), { kind: 'rejected', reason: 'not_allowed' });
      const a = await meterRun('preview', rid(79), { buildingName: 'Toà A', readings: [{ roomName: 'P101', value: 1234 }] });
      for (const forged of [{ ...a.resolved, buildingId: OTHER_BUILDING }, { ...a.resolved, rows: [{ ...a.resolved.rows[0], roomId: uid(840) }] },
        { ...a.resolved, meterType: 'WATER' }, { ...a.resolved, rows: [] }])
        assert.deepEqual(await meterRun('apply', rid(79), { buildingName: 'Toà A', readings: [{ roomName: 'P101', value: 1234 }] }, { resolved: forged, basis: a.basis }),
          { kind: 'rejected', reason: 'not_allowed' }, JSON.stringify(forged));
      // Người khác vừa ghi chỉ số cho công tơ đó giữa hai lượt ⇒ basis lệch ⇒ state_changed, không ghi gì.
      await db.query("INSERT INTO public.meter_readings(meter_id,reading_date,current_reading,status,organization_id) VALUES($1,'2026-10-20',1210,'APPROVED',$2)", [M1, ORG]);
      assert.deepEqual(await meterApply(rid(79), { buildingName: 'Toà A', readings: [{ roomName: 'P101', value: 1234 }] }, a), { kind: 'rejected', reason: 'state_changed' });
      assert.equal(await ops(), 0);
    });
  });

  await t.test('rào: sàn money, khoá tắt, catalog và quyền thực thi; số kiểu Việt', async () => {
    await assert.rejects(db.query("UPDATE app_private.hermes_action_policies SET confirm='never' WHERE action='invoice.meter_record'"), code('23514'));
    await f.rollbackCase(async () => {
      await db.query("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='meter_readings.create'");
      await assert.rejects(meterRun('preview', rid(80), { buildingName: 'Toà A', readings: [{ roomName: 'P101', value: 1 }] }), code('42501'));
    });
    const acl = (await db.query(`SELECT p.oid::regprocedure::text fn,p.prosecdef,has_function_privilege('authenticated',p.oid,'EXECUTE') auth,
      has_function_privilege('anon',p.oid,'EXECUTE') anon FROM pg_proc p WHERE p.proname IN ('hermes_invoice_reading_text_v1','hermes_invoice_meter_lookup_v1',
      'hermes_invoice_meter_step_v1','meter_readings_plan_v1','record_meter_readings_v2') ORDER BY 1`)).rows;
    assert.deepEqual(acl.map(r => [r.fn.replace(/\(.*/, ''), r.prosecdef, r.auth, r.anon]), [
      ['app_private.hermes_invoice_meter_lookup_v1', false, true, false], ['app_private.hermes_invoice_meter_step_v1', true, true, false],
      ['app_private.hermes_invoice_reading_text_v1', false, false, false], ['meter_readings_plan_v1', false, true, false], ['record_meter_readings_v2', true, true, false]]);
    assert.deepEqual((await db.query("SELECT app_private.hermes_invoice_reading_text_v1(x) t FROM unnest('{0,7,1234,1234567.5,12.25}'::numeric[]) x")).rows.map(r => r.t),
      ['0', '7', '1.234', '1.234.567,5', '12,25']);
  });
});
