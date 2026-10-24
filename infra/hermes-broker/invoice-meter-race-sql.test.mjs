import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { localCluster } from './crm-shared-read-sql-fixture.mjs';
import { SESSION } from './finance-fixture.mjs';
import { invoiceSetup, rid, binding, BUILDING, ORG, USER, M1, M2 } from './invoice-write-fixture.mjs';

// Đợt 3 Hoá đơn Mốc 4: thứ tự khoá của invoice.meter_record trên PostgreSQL thật (PG16+, hai kết nối). Guard dùng chung của Hermes đã giữ
// dòng công ty; hai đường ghi chỉ số của web KHÔNG lấy khoá công ty:
//  - form Ghi chỉ số (đường mới): public.record_meter_readings_v2, khoá tư vấn THEO TOÀ suốt giao dịch;
//  - lập hoá đơn tháng (excelInvoiceRows / GenerateInvoiceDialog): INSERT thẳng meter_readings, trigger auto_generate_reading_code lấy
//    khoá tư vấn theo tiền tố mã CSSyymm.
// Hermes lấy khoá toà KHÔNG CHỜ (55P03 ⇒ state_changed); khoá mã CSS thì chờ được vì bên giữ không bao giờ chờ dòng công ty.
const adapter = client => {
  let released = false;
  return { exec: sql => client.query(sql), query: (sql, params) => client.query(sql, params),
    close: () => { if (!released) { released = true; client.release(); } } };
};
const claims = c => c.query("SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true),"
  + "set_config('request.jwt.claim.session',$2,true)", [USER, SESSION]);
const RPC = 'SELECT public.hermes_invoice_action_v1($1::jsonb,$2,$3,$4::uuid,$5::jsonb,$6::jsonb,$7) result';
const rpcArgs = (phase, requestId, params, preview) => [JSON.stringify(binding), 'invoice.meter_record', phase, requestId, JSON.stringify(params),
  preview ? JSON.stringify(preview.resolved) : null, preview?.basis ?? null];
const WRITER = 'SELECT public.record_meter_readings_v2($1::uuid,$2::date,$3::jsonb,false,$4) r';
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
const P101 = { buildingName: 'Toà A', readings: [{ roomName: 'P101', value: 1234 }] };

test('PG17 hai kết nối: chỉ số Hermes không chờ khoá toà của form web, chờ được khoá mã của luồng hoá đơn, không 40P01; cùng requestId ⇒ phát lại', { timeout: 300000 }, async t => {
  const { pool, cleanup } = await localCluster(t);
  const hermes = await pool.connect(), web = await pool.connect(), watch = await pool.connect();
  const db = adapter(hermes);
  t.after(async () => { db.close(); web.release(); watch.release(); await pool.end(); cleanup(); });
  const { meterRun, meterApply } = await invoiceSetup(t, { database: db, meter: true, l8: true });
  const [hermesPid] = await Promise.all([hermes].map(async c => (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid));
  const blocked = async pid => {
    for (let i = 0; i < 400; i++) {
      const row = (await watch.query('SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
      if (row?.wait_event_type === 'Lock') return row.wait_event;
      await delay(25);
    }
    assert.fail(`kết nối ${pid} không chờ khoá`);
  };
  const rows = async meter => (await watch.query('SELECT reading_date::text d,previous_reading::float p,current_reading::float c FROM public.meter_readings WHERE meter_id=$1 AND deleted_at IS NULL ORDER BY reading_date,created_at', [meter])).rows;

  await t.test('form web đang ghi cùng toà (giữ khoá toà): Hermes lượt 2 nhận 55P03 ngay, không ghi; web ghi xong; xem trước lại thấy trùng tháng', async () => {
    const preview = await meterRun('preview', rid(90), P101);
    assert.equal(preview.kind, 'preview', JSON.stringify(preview));
    await web.query('BEGIN'); await claims(web); await web.query('SET LOCAL ROLE authenticated');
    const webRow = (await web.query(WRITER, [BUILDING, '2026-10-22', JSON.stringify([{ meterId: M1, value: 1230 }]), 'web-race-00000101'])).rows[0].r;
    assert.equal(webRow.count, 1);
    const started = Date.now();
    const hermesCall = await outcome(meterApply(rid(90), P101, preview));
    assert.equal(hermesCall.error?.code, '55P03', hermesCall.error?.message ?? JSON.stringify(hermesCall.value));
    assert.ok(Date.now() - started < 1000, 'không đợi');
    await web.query('COMMIT');
    assert.deepEqual((await rows(M1)).map(r => [r.d, r.c]), [['2026-09-30', 1200], ['2026-10-22', 1230]], 'chỉ dòng của web');
    assert.deepEqual(await meterRun('preview', rid(91), P101), { kind: 'rejected', reason: 'meter_duplicate_month' });
  });

  await t.test('luồng lập hoá đơn INSERT thẳng (giữ khoá mã CSS2610): Hermes chờ ở khoá mã rồi ghi xong — không vòng chờ', async () => {
    const params = { buildingName: 'Toà A', readings: [{ roomName: 'P102', value: 800 }] };
    const preview = await meterRun('preview', rid(92), params);
    assert.equal(preview.kind, 'preview', JSON.stringify(preview));
    // Công tơ khác (M1 của phòng khác) để chỉ đo khoá: lập hoá đơn ghi chỉ số cuối kỳ như excelInvoiceRows (ngày cuối kỳ).
    await web.query('BEGIN'); await claims(web);
    await web.query("INSERT INTO public.meter_readings(meter_id,reading_date,current_reading,status,organization_id) VALUES($1,'2026-10-31',1240,'APPROVED',$2)", [M1, ORG]);
    const hermesCall = outcome(meterApply(rid(92), params, preview));
    assert.equal(await blocked(hermesPid), 'advisory', 'Hermes chờ khoá tư vấn mã CSS của trigger');
    await web.query('COMMIT');
    const { value, error } = await hermesCall;
    assert.equal(error, undefined, error?.message);
    assert.equal(value.kind, 'applied', JSON.stringify(value));
    assert.deepEqual((await rows(M2)).at(-1), { d: '2026-10-22', p: 700, c: 800 });
  });

  await t.test('cùng requestId ở hai kết nối: lượt hai chờ ở khoá công ty của guard rồi phát lại, chỉ một dòng', async () => {
    const params = { buildingName: 'Toà A', readings: [{ roomName: 'P105', value: 2300 }] };
    const preview = await meterRun('preview', rid(93), params);
    await web.query('BEGIN'); await claims(web); await web.query('SET LOCAL ROLE authenticated');
    const first = (await web.query(RPC, rpcArgs('apply', rid(93), params, preview))).rows[0].result;
    assert.equal(first.kind, 'applied', JSON.stringify(first));
    const second = outcome(meterApply(rid(93), params, preview));
    await blocked(hermesPid);
    await web.query('COMMIT');
    const { value, error } = await second;
    assert.equal(error, undefined, error?.message);
    assert.deepEqual(value, first);
    assert.equal((await watch.query("SELECT count(*)::int n FROM public.meter_readings WHERE meter_id=(SELECT id FROM public.meters WHERE code='DH-105')")).rows[0].n, 1);
  });
});
