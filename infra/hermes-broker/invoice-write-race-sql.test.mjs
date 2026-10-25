import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { localCluster } from './crm-shared-read-sql-fixture.mjs';
import { SESSION } from './finance-fixture.mjs';
import { invoiceSetup, rid, binding, ORG, USER, INV_B, TK1 } from './invoice-write-fixture.mjs';

// Đợt 3 Hoá đơn Mốc 3b: thứ tự khoá của RPC trang trên PostgreSQL thật (PG16+, hai kết nối; PGlite chỉ có một). Cùng fixture với
// invoice-write-sql.test.mjs; bản port record_invoice_collection_v5 khoá như v5 thật: hoá đơn FOR UPDATE → công ty FOR SHARE → lock_org.
// Guard dùng chung của Hermes khoá dòng công ty NGAY ĐẦU giao dịch (hermes_private_command_connection_v1), nên Hermes và web khoá theo hai
// thứ tự ngược nhau; bước ghi khoá dòng hoá đơn NOWAIT nên Hermes không bao giờ chờ web ⇒ không có vòng chờ. Ca đối chứng đột biến bỏ NOWAIT
// để chứng minh phép đo bắt được 40P01 (đúng lỗi Mốc 3 cũ: chờ hoá đơn trong khi giữ công ty). Lượt 8: vỏ chuyển thu tiền sang tầng v2
// (hermes_invoice_collect_v2) — đo đúng bước ghi đang chạy.
const adapter = client => {
  let released = false;
  return { exec: sql => client.query(sql), query: (sql, params) => client.query(sql, params),
    close: () => { if (!released) { released = true; client.release(); } } };
};
const claims = c => c.query("SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true),"
  + "set_config('request.jwt.claim.session',$2,true)", [USER, SESSION]);
const RPC = 'SELECT public.hermes_invoice_action_v1($1::jsonb,$2,$3,$4::uuid,$5::jsonb,$6::jsonb,$7) result';
const rpcArgs = (phase, requestId, params, preview) => [JSON.stringify(binding), 'invoice.collect', phase, requestId, JSON.stringify(params),
  preview ? JSON.stringify(preview.resolved) : null, preview?.basis ?? null];
const V5 = "SELECT public.record_invoice_collection_v5($1,'2026-10-22',$2::jsonb,'REJECT',false,null,null,$3,$4) r";
const tender = amount => JSON.stringify([{ payment_method: 'TK', gross_amount: amount, account_id: TK1 }]);
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
const page = readFileSync(`supabase/migrations/${readdirSync('supabase/migrations').find(n => /^\d{14}_hermes_invoice_period_closed_reason_order_v1\.sql$/.test(n))}`, 'utf8')
  .replaceAll('\r\n', '\n');
const STEP = page.match(/CREATE OR REPLACE FUNCTION app_private\.hermes_invoice_action_step_v3\([\s\S]*?\$fn\$;/)[0];

test('PG17 hai kết nối: web v5 và Hermes cùng thu một hoá đơn không deadlock; cùng requestId ở hai kết nối ⇒ phát lại', { timeout: 300000 }, async t => {
  const { pool, cleanup } = await localCluster(t);
  // pg-pool resolves end() before client sockets close; stopping the cluster then can emit a late 57P01
  // (same fix as trackPoolDrain in stable-binding-postgres.test.mjs).
  const clientEnds = [];
  pool.on('connect', client => { clientEnds.push(new Promise(resolve => client.once('end', resolve))); });
  const hermes = await pool.connect(), web = await pool.connect(), watch = await pool.connect();
  const db = adapter(hermes);
  t.after(async () => { db.close(); web.release(); watch.release(); await pool.end(); await Promise.all(clientEnds); cleanup(); });
  const { run, applyWith, one } = await invoiceSetup(t, { database: db, l14: true });
  const [hermesPid, webPid] = await Promise.all([hermes, web].map(async c => (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid));
  // Kết nối đang chờ khoá; trả các bảng có khoá dòng (tuple) nó đang xếp hàng.
  const blocked = async pid => {
    for (let i = 0; i < 400; i++) {
      if ((await watch.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock')
        return (await watch.query("SELECT DISTINCT relation::regclass::text rel FROM pg_locks WHERE pid=$1 AND locktype='tuple'", [pid])).rows.map(r => r.rel);
      await delay(25);
    }
    assert.fail(`kết nối ${pid} không chờ khoá`);
  };
  const paid = async () => (await watch.query('SELECT paid_amount::bigint::text p FROM public.invoices WHERE id=$1', [INV_B])).rows[0].p;
  // Hermes giữ dòng công ty (như guard), web vào v5: giữ dòng hoá đơn rồi xếp hàng ở dòng công ty.
  const interleave = async (key, expectedPaid) => {
    await hermes.query('BEGIN');
    await hermes.query('SELECT app_private.lock_org_for_decision_v1($1)', [ORG]);
    await web.query('BEGIN'); await claims(web); await web.query('SET LOCAL ROLE authenticated');
    const webCall = outcome(web.query(V5, [INV_B, tender(300000), expectedPaid, key]));
    assert.deepEqual(await blocked(webPid), ['organizations'], 'web giữ hoá đơn, chờ công ty');
    await claims(hermes); await hermes.query('SET LOCAL ROLE authenticated');
    return { webCall }; // trong object: async không được chờ v5 của web
  };

  await t.test('Hermes giữ công ty, web giữ hoá đơn chờ công ty: Hermes KHÔNG chờ hoá đơn (55P03 ⇒ state_changed), web ghi xong', async () => {
    const { webCall } = await interleave('web-race-00000001', 0);
    const started = Date.now();
    const hermesCall = await outcome(hermes.query(RPC, rpcArgs('preview', rid(60), one({ roomName: 'P102', amount: 500000 }))));
    assert.equal(hermesCall.error?.code, '55P03', hermesCall.error?.message ?? JSON.stringify(hermesCall.value));
    assert.ok(Date.now() - started < 1000, 'không đợi tới deadlock_timeout');
    await hermes.query('ROLLBACK'); await hermes.query('RESET ROLE');
    const { value, error } = await webCall;
    assert.equal(error, undefined, error?.message);
    assert.equal(value.rows[0].r.invoice.status, 'PARTIAL_PAID');
    await web.query('COMMIT');
    assert.equal(await paid(), '300000');
    // Xem trước lại sau khi web xong: đọc số mới.
    const again = await run('preview', rid(60), one({ roomName: 'P102', amount: 500000 }));
    assert.deepEqual([again.kind, again.preview.items[0].remainingBefore], ['preview', '1700000']);
  });

  await t.test('đối chứng: bước ghi đột biến bỏ NOWAIT (chờ hoá đơn khi đang giữ công ty, như Mốc 3 cũ) ⇒ 40P01', async () => {
    const { webCall } = await interleave('web-race-00000002', 300000);
    await hermes.query('RESET ROLE');
    await hermes.query(STEP.replace('ORDER BY i.id FOR UPDATE NOWAIT;', 'ORDER BY i.id FOR UPDATE;')); // lùi cùng giao dịch
    await hermes.query('SET LOCAL ROLE authenticated');
    const hermesCall = await outcome(hermes.query(RPC, rpcArgs('preview', rid(62), one({ roomName: 'P102', amount: 100000 }))));
    const webResult = await webCall;
    await web.query('ROLLBACK'); await hermes.query('ROLLBACK'); await hermes.query('RESET ROLE');
    assert.equal([webResult, hermesCall].filter(r => r.error?.code === '40P01').length, 1, JSON.stringify([webResult.error?.message, hermesCall.error?.message]));
    assert.equal(await paid(), '300000');
    assert.match((await watch.query("SELECT prosrc FROM pg_proc WHERE oid='app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure")).rows[0].prosrc,
      /FOR UPDATE NOWAIT/, 'đột biến đã lùi');
  });

  await t.test('cùng requestId ở hai kết nối: lượt hai chờ ở khoá công ty của guard rồi phát lại đúng kết quả lượt đầu, chỉ một lần thu', async () => {
    const params = one({ roomName: 'P102', amount: 200000 });
    const preview = await run('preview', rid(61), params);
    assert.equal(preview.kind, 'preview', JSON.stringify(preview));
    // Kết nối thứ hai (cùng binding, cùng requestId) ghi trước nhưng chưa commit: giữ công ty, hoá đơn và biên nhận.
    await web.query('BEGIN'); await claims(web); await web.query('SET LOCAL ROLE authenticated');
    const first = (await web.query(RPC, rpcArgs('apply', rid(61), params, preview))).rows[0].result;
    assert.equal(first.kind, 'applied', JSON.stringify(first));
    const second = outcome(applyWith(rid(61), params, preview));
    assert.deepEqual(await blocked(hermesPid), ['organizations']);
    await web.query('COMMIT');
    const { value, error } = await second;
    assert.equal(error, undefined, error?.message);
    assert.deepEqual(value, first, 'phát lại, không tính lại kế hoạch trên hoá đơn đã đổi');
    assert.equal(await paid(), '500000');
    assert.equal((await watch.query('SELECT count(*)::int n FROM public.invoice_payment_collections WHERE idempotency_key=$1', [`hermes-inv:${rid(61)}`])).rows[0].n, 1);
  });
});
