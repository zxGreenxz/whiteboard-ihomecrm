import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { localCluster } from './crm-shared-read-sql-fixture.mjs';
import { SESSION } from './finance-fixture.mjs';
import { invoiceSetup, rid, binding, ORG, USER, INV_A, INV_B, INV_P, INV_X, ADJ_P, CONTRACT, TK1 } from './invoice-write-fixture.mjs';

// Đợt 3 Hoá đơn Mốc 5: thứ tự khoá của invoice.adjust / adjustment_check / cancel / restore trên PostgreSQL thật (PG16+, hai kết nối), một
// ca cho MỖI hàm ghi web mà bước ghi Hermes gọi, cùng hai đường web giữ dòng TRƯỚC khi xin công ty:
//  - adjust_invoice_v2, cancel_invoice_with_credit_v1, restore_invoice_with_credit_v1 (thân thật / bản port cùng thứ tự): công ty → hợp đồng →
//    hoá đơn (invoice_rent_support_lock_v1) — cùng chiều với guard ⇒ Hermes chờ ở dòng công ty, web xong, Hermes thấy dữ liệu đổi (state_changed);
//  - review_invoice_adjustment_v2 (thân thật): hoá đơn → điều chỉnh, không xin công ty ⇒ Hermes không chờ dòng web đang giữ (55P03);
//  - record_invoice_collection_v5 (hoá đơn → công ty) và một đường giữ hợp đồng rồi xin công ty (như hàm ghi hợp đồng): Hermes đã giữ công
//    ty ⇒ phải NOWAIT ở hoá đơn VÀ hợp đồng; đối chứng đột biến bỏ từng NOWAIT ⇒ đúng một bên nhận 40P01.
const adapter = client => {
  let released = false;
  return { exec: sql => client.query(sql), query: (sql, params) => client.query(sql, params),
    close: () => { if (!released) { released = true; client.release(); } } };
};
const claims = c => c.query("SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true),"
  + "set_config('request.jwt.claim.session',$2,true)", [USER, SESSION]);
const RPC = 'SELECT public.hermes_invoice_action_v1($1::jsonb,$2,$3,$4::uuid,$5::jsonb,$6::jsonb,$7) result';
const rpcArgs = (action, phase, requestId, params, preview) => [JSON.stringify(binding), action, phase, requestId, JSON.stringify(params),
  preview ? JSON.stringify(preview.resolved) : null, preview?.basis ?? null];
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
const page = readFileSync(`supabase/migrations/${readdirSync('supabase/migrations').find(n => /^\d{14}_hermes_invoice_edit_v1\.sql$/.test(n))}`, 'utf8')
  .replaceAll('\r\n', '\n');
const STEP = page.match(/CREATE OR REPLACE FUNCTION app_private\.hermes_invoice_edit_step_v1\([\s\S]*?\$fn\$;/)[0];
const INVOICE_NOWAIT = 'SELECT * INTO inv FROM public.invoices i WHERE i.id=v_invoice FOR UPDATE NOWAIT;';
const CONTRACT_NOWAIT = '(SELECT i.contract_id FROM public.invoices i WHERE i.id=v_invoice)\n    FOR UPDATE NOWAIT;';
const room = (roomName, extra = {}) => ({ buildingName: 'toa a', roomName, reason: 'Khách báo sai tiền, sửa lại cho đúng', ...extra });

test('PG17 hai kết nối: bốn hàm ghi web và Hermes trên cùng hoá đơn không deadlock; Hermes không chờ dòng web giữ trước khi xin công ty', { timeout: 300000 }, async t => {
  const { pool, cleanup } = await localCluster(t);
  const hermes = await pool.connect(), web = await pool.connect(), watch = await pool.connect();
  const db = adapter(hermes);
  t.after(async () => { db.close(); web.release(); watch.release(); await pool.end(); cleanup(); });
  const { editRun, editApply } = await invoiceSetup(t, { database: db, edit: true });
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
  const asWeb = async () => { await web.query('BEGIN'); await claims(web); await web.query('SET LOCAL ROLE authenticated'); };
  const one = async (sql, params) => (await watch.query(sql, params)).rows[0];
  // Web gọi hàm ghi trong giao dịch chưa chốt (giữ khoá), Hermes lượt 2 cùng hoá đơn: chờ ở dòng công ty của guard, web chốt, Hermes xem dữ liệu mới.
  const serialized = async (action, requestId, params, webSql, webArgs) => {
    const preview = await editRun(action, 'preview', requestId, params);
    assert.equal(preview.kind, 'preview', JSON.stringify(preview));
    await asWeb();
    await web.query(webSql, webArgs);
    const hermesCall = outcome(editApply(action, requestId, params, preview));
    assert.deepEqual(await blocked(hermesPid), ['organizations'], 'Hermes chờ ở dòng công ty (guard), không chờ hoá đơn');
    await web.query('COMMIT');
    const { value, error } = await hermesCall;
    assert.equal(error, undefined, error?.message);
    return value;
  };

  await t.test('adjust_invoice_v2 (web) giữ công ty → hợp đồng → hoá đơn: Hermes chờ công ty rồi thấy hoá đơn đã đổi ⇒ state_changed, đúng một điều chỉnh', async () => {
    const value = await serialized('invoice.adjust', rid(200), room('p101', { discount: 100000 }),
      `SELECT public.adjust_invoice_v2($1,(public.invoice_adjustment_build_v1($1,'{"discountAdd":5000}'::jsonb))#>'{after,items}',5000,null,null,'web giảm 5 nghìn',0,0,
        (SELECT updated_at FROM public.invoices WHERE id=$1),'web-adj-race-0001')`, [INV_A]);
    assert.deepEqual([value.kind, value.reason], ['rejected', 'state_changed']);
    assert.deepEqual(await one('SELECT count(*)::int n,max(idempotency_key) k FROM public.invoice_adjustments WHERE invoice_id=$1', [INV_A]), { n: 1, k: 'web-adj-race-0001' });
  });

  await t.test('cancel_invoice_with_credit_v1 (web, thân thật) giữ công ty → hợp đồng → hoá đơn: Hermes chờ rồi ⇒ state_changed; huỷ đúng một lần', async () => {
    const value = await serialized('invoice.cancel', rid(201), room('p101'), 'SELECT public.cancel_invoice_with_credit_v1($1,$2)', [INV_A, 'web-cancel-race-0001']);
    assert.deepEqual([value.kind, value.reason], ['rejected', 'state_changed']);
    assert.equal((await one('SELECT status FROM public.invoices WHERE id=$1', [INV_A])).status, 'CANCELLED');
  });

  await t.test('hoá đơn KHÔNG gắn hợp đồng: hàm huỷ web không xin công ty (invoice_rent_support_lock_v1 bỏ qua), chỉ giữ hoá đơn ⇒ Hermes 55P03 ngay', async () => {
    await asWeb();
    await web.query('SELECT public.cancel_invoice_with_credit_v1($1,$2)', [INV_B, 'web-cancel-race-0002']);
    await hermes.query('BEGIN'); await claims(hermes); await hermes.query('SET LOCAL ROLE authenticated');
    const started = Date.now();
    const call = await outcome(hermes.query(RPC, rpcArgs('invoice.cancel', 'preview', rid(207), room('p102'))));
    assert.equal(call.error?.code, '55P03', call.error?.message ?? JSON.stringify(call.value));
    assert.ok(Date.now() - started < 1000, 'không đợi');
    await hermes.query('ROLLBACK'); await hermes.query('RESET ROLE');
    await web.query('ROLLBACK');
    assert.equal((await one('SELECT status FROM public.invoices WHERE id=$1', [INV_B])).status, 'APPROVED');
  });

  await t.test('restore_invoice_with_credit_v1 (web, thân thật) giữ công ty → hợp đồng → hoá đơn: Hermes chờ rồi ⇒ state_changed; tiền dư cấn lại một lần', async () => {
    const value = await serialized('invoice.restore', rid(202), room('p109'), 'SELECT public.restore_invoice_with_credit_v1($1,$2)', [INV_X, 'web-restore-race-0001']);
    assert.deepEqual([value.kind, value.reason], ['rejected', 'state_changed']);
    assert.deepEqual(await one(`SELECT (SELECT status FROM public.invoices WHERE id=$1) s,
      (SELECT count(*)::int FROM public.customer_credit_applications WHERE invoice_id=$1 AND reversed_at IS NULL) active`, [INV_X]), { s: 'APPROVED', active: 1 });
  });

  await t.test('review_invoice_adjustment_v2 (web, thân thật) giữ hoá đơn → điều chỉnh, không xin công ty: Hermes KHÔNG chờ (55P03), web xong', async () => {
    await asWeb();
    await web.query('SELECT public.review_invoice_adjustment_v2($1,1)', [ADJ_P]);
    await hermes.query('BEGIN'); await claims(hermes); await hermes.query('SET LOCAL ROLE authenticated');
    const started = Date.now();
    const call = await outcome(hermes.query(RPC, rpcArgs('invoice.adjustment_check', 'preview', rid(203), { buildingName: 'toa a', roomName: 'p107' })));
    assert.equal(call.error?.code, '55P03', call.error?.message ?? JSON.stringify(call.value));
    assert.ok(Date.now() - started < 1000, 'không đợi');
    await hermes.query('ROLLBACK'); await hermes.query('RESET ROLE');
    await web.query('COMMIT');
    const again = await editRun('invoice.adjustment_check', 'preview', rid(203), { buildingName: 'toa a', roomName: 'p107' });
    assert.deepEqual([again.kind, again.reason], ['rejected', 'nothing_to_check']);
    assert.equal((await one('SELECT review_status s FROM public.invoice_adjustments WHERE id=$1', [ADJ_P])).s, 'CHECKED');
  });

  // Hermes giữ công ty (như guard); web giữ một dòng rồi xếp hàng ở dòng công ty. Trả lời gọi web để chờ sau (bọc object: async không chờ nó).
  const interleave = async (webHold, webArgs) => {
    await hermes.query('BEGIN');
    await hermes.query('SELECT app_private.lock_org_for_decision_v1($1)', [ORG]);
    await web.query('BEGIN'); await claims(web);
    const webCall = outcome(web.query(webHold, webArgs));
    assert.deepEqual(await blocked(webPid), ['organizations'], 'web giữ dòng của mình, chờ công ty');
    await claims(hermes); await hermes.query('SET LOCAL ROLE authenticated');
    return { webCall };
  };
  const V5 = `SELECT public.record_invoice_collection_v5($1,'2026-10-22',$2::jsonb,'REJECT',false,null,null,0,'web-race-inv-0001') r`;
  const tender = JSON.stringify([{ payment_method: 'TK', gross_amount: 300000, account_id: TK1 }]);
  // Đường ghi hợp đồng của web (khuôn #270): khoá dòng hợp đồng rồi mới xin công ty.
  const CONTRACT_FIRST = 'SELECT (SELECT 1 FROM public.contracts WHERE id=$1 FOR UPDATE),app_private.lock_org_for_decision_v1($2)';

  await t.test('web v5 giữ hoá đơn chờ công ty: Hermes điều chỉnh KHÔNG chờ hoá đơn (55P03); đối chứng bỏ NOWAIT ⇒ 40P01', async () => {
    await db.query("UPDATE public.invoices SET status='APPROVED',paid_amount=0 WHERE id=$1", [INV_B]);
    await db.query("UPDATE public.fixture_collect_acl SET user_id=user_id"); // v5 port: quyền thu đã có
    for (const mutate of [false, true]) {
      const { webCall } = await interleave(V5, [INV_B, tender]);
      if (mutate) { await hermes.query('RESET ROLE'); await hermes.query(STEP.replace(INVOICE_NOWAIT, INVOICE_NOWAIT.replace(' NOWAIT', ''))); await hermes.query('SET LOCAL ROLE authenticated'); }
      const started = Date.now();
      const call = await outcome(hermes.query(RPC, rpcArgs('invoice.adjust', 'preview', rid(204), room('p102', { discount: 1000 }))));
      const webResult = mutate ? await webCall : null;
      await hermes.query('ROLLBACK'); await hermes.query('RESET ROLE');
      if (mutate) {
        await web.query('ROLLBACK');
        assert.equal([webResult, call].filter(r => r.error?.code === '40P01').length, 1, JSON.stringify([webResult.error?.message, call.error?.message]));
      } else {
        assert.equal(call.error?.code, '55P03', call.error?.message ?? JSON.stringify(call.value));
        assert.ok(Date.now() - started < 1000);
        assert.equal((await webCall).error, undefined);
        await web.query('ROLLBACK');
      }
    }
  });

  await t.test('web giữ hợp đồng chờ công ty: Hermes huỷ KHÔNG chờ hợp đồng (55P03); đối chứng bỏ NOWAIT ở hợp đồng ⇒ 40P01', async () => {
    for (const mutate of [false, true]) {
      const { webCall } = await interleave(CONTRACT_FIRST, [CONTRACT, ORG]);
      if (mutate) { await hermes.query('RESET ROLE'); await hermes.query(STEP.replace(CONTRACT_NOWAIT, CONTRACT_NOWAIT.replace(' NOWAIT', ''))); await hermes.query('SET LOCAL ROLE authenticated'); }
      const started = Date.now();
      const call = await outcome(hermes.query(RPC, rpcArgs('invoice.cancel', 'preview', rid(205), room('p101'))));
      const webResult = mutate ? await webCall : null;
      await hermes.query('ROLLBACK'); await hermes.query('RESET ROLE');
      if (mutate) {
        await web.query('ROLLBACK');
        assert.equal([webResult, call].filter(r => r.error?.code === '40P01').length, 1, JSON.stringify([webResult.error?.message, call.error?.message]));
      } else {
        assert.equal(call.error?.code, '55P03', call.error?.message ?? JSON.stringify(call.value));
        assert.ok(Date.now() - started < 1000);
        assert.equal((await webCall).error, undefined);
        await web.query('ROLLBACK');
      }
    }
    assert.match((await one("SELECT prosrc FROM pg_proc WHERE oid='app_private.hermes_invoice_edit_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure")).prosrc,
      /FOR UPDATE NOWAIT;\n  SELECT \* INTO inv/, 'đột biến đã lùi');
  });

  await t.test('cùng requestId ở hai kết nối: lượt hai chờ ở công ty rồi phát lại đúng kết quả lượt đầu, một điều chỉnh', async () => {
    const params = room('p107', { discount: 10000 });
    const preview = await editRun('invoice.adjust', 'preview', rid(206), params);
    assert.equal(preview.kind, 'preview', JSON.stringify(preview));
    await asWeb();
    const first = (await web.query(RPC, rpcArgs('invoice.adjust', 'apply', rid(206), params, preview))).rows[0].result;
    assert.equal(first.kind, 'applied', JSON.stringify(first));
    const second = outcome(editApply('invoice.adjust', rid(206), params, preview));
    assert.deepEqual(await blocked(hermesPid), ['organizations']);
    await web.query('COMMIT');
    const { value, error } = await second;
    assert.equal(error, undefined, error?.message);
    assert.deepEqual(value, first);
    assert.equal((await one('SELECT count(*)::int n FROM public.invoice_adjustments WHERE idempotency_key=$1', [`hermes-adj:${rid(206)}`])).n, 1);
    assert.equal((await one('SELECT adjustment_revision::int r FROM public.invoices WHERE id=$1', [INV_P])).r, 2);
  });
});
