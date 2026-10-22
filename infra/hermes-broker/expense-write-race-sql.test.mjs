import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { localCluster } from './crm-shared-read-sql-fixture.mjs';
import { SESSION } from './finance-fixture.mjs';
import { expenseSetup, EDIT, rid, binding, ORG, USER, BUILDING, CATEGORY, CASHBOOK } from './expense-write-fixture.mjs';

// Thu chi Mốc 4b: thứ tự khoá của expense.edit / expense.cancel trên PostgreSQL thật (hai kết nối; PGlite chỉ có một). Cùng fixture với
// expense-write-sql.test.mjs; bản port cancel_income_expense_flex_v1 khoá như hàm thật: dòng phiếu FOR UPDATE → công ty (lock_org).
// Guard dùng chung của Hermes khoá dòng công ty NGAY ĐẦU giao dịch, nên Hermes và web khoá theo hai thứ tự ngược nhau; bước ghi khoá dòng
// phiếu NOWAIT trước khi gọi hàm web nên Hermes không bao giờ chờ web ⇒ không có vòng chờ. Ca đối chứng bỏ NOWAIT chứng minh phép đo bắt
// được 40P01 (cùng lỗi Hoá đơn #279 tìm ra).
const adapter = client => {
  let released = false;
  return { exec: sql => client.query(sql), query: (sql, params) => client.query(sql, params),
    close: () => { if (!released) { released = true; client.release(); } } };
};
const claims = c => c.query("SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true),"
  + "set_config('request.jwt.claim.session',$2,true)", [USER, SESSION]);
const RPC = 'SELECT public.hermes_expense_write_v1($1::jsonb,$2,$3,$4::uuid,$5::jsonb,$6::jsonb,$7) result';
const preview = (action, requestId, params) => [JSON.stringify(binding), action, 'preview', requestId, JSON.stringify(params), null, null];
const WEB_CANCEL = "SELECT public.cancel_income_expense_flex_v1($1,'web huỷ song song',NULL,NULL) r";
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
const STEP = EDIT.replaceAll('\r\n', '\n').match(/CREATE OR REPLACE FUNCTION app_private\.hermes_expense_write_step_v1\([\s\S]*?END \$fn\$;/)[0];
const NOWAIT = 'AND ie.deleted_at IS NULL\n      FOR UPDATE NOWAIT;';
const CANCEL = { voucherCode: 'PC2610801', reason: 'lập trùng phiếu' };

test('PG17 hai kết nối: web huỷ phiếu (phiếu → công ty) và Hermes sửa/huỷ cùng phiếu không deadlock', { timeout: 300000 }, async t => {
  const { pool, cleanup } = await localCluster(t, { initdbArgs: ['--locale-provider=builtin', '--builtin-locale=C.UTF-8'] });
  const hermes = await pool.connect(), web = await pool.connect(), watch = await pool.connect();
  const db = adapter(hermes);
  t.after(async () => { db.close(); web.release(); watch.release(); await pool.end(); cleanup(); });
  await expenseSetup(t, { database: db });
  assert.equal(STEP.split(NOWAIT).length, 2, 'bước ghi khoá dòng phiếu NOWAIT đúng một chỗ (nhánh sửa/huỷ)');
  const voucher = (await hermes.query(`INSERT INTO public.income_expenses(organization_id,user_id,code,type,name,building_id,account_id,voucher_date,
      total_amount,approval_status,posting_status) VALUES($1,$2,'PC2610801','EXPENSE','mua bóng đèn',$3,$4,current_date,400000,'UNAPPROVED','UNPOSTED')
      RETURNING id`, [ORG, USER, BUILDING, CASHBOOK])).rows[0].id;
  await hermes.query(`INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,amount,start_date,end_date)
    VALUES($1,$2,400000,current_date,current_date)`, [voucher, CATEGORY]);
  const webPid = (await web.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  // Kết nối đang chờ khoá; trả các bảng có khoá dòng (tuple) nó đang xếp hàng.
  const blocked = async pid => {
    for (let i = 0; i < 400; i++) {
      if ((await watch.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock')
        return (await watch.query("SELECT DISTINCT relation::regclass::text rel FROM pg_locks WHERE pid=$1 AND locktype='tuple'", [pid])).rows.map(r => r.rel);
      await delay(25);
    }
    assert.fail(`kết nối ${pid} không chờ khoá`);
  };
  const status = async () => (await watch.query('SELECT approval_status s FROM public.income_expenses WHERE id=$1', [voucher])).rows[0].s;
  // Hermes giữ dòng công ty (như guard), web vào hàm huỷ: giữ dòng phiếu rồi xếp hàng ở dòng công ty.
  const interleave = async () => {
    await hermes.query('BEGIN');
    await hermes.query('SELECT app_private.lock_org_for_decision_v1($1)', [ORG]);
    await web.query('BEGIN'); await claims(web); await web.query('SET LOCAL ROLE authenticated');
    const webCall = outcome(web.query(WEB_CANCEL, [voucher]));
    assert.deepEqual(await blocked(webPid), ['organizations'], 'web giữ phiếu, chờ công ty');
    await claims(hermes); await hermes.query('SET LOCAL ROLE authenticated');
    return { webCall }; // trong object: async không được chờ hàm huỷ của web
  };

  for (const [n, action, params] of [[1, 'expense.cancel', CANCEL], [2, 'expense.edit', { voucherCode: 'PC2610801', content: 'mua bóng đèn LED' }]]) {
    await t.test(`${action}: Hermes giữ công ty, web giữ phiếu chờ công ty ⇒ Hermes KHÔNG chờ phiếu (55P03 ⇒ state_changed), web huỷ xong`, async () => {
      const { webCall } = await interleave();
      const started = Date.now();
      const hermesCall = await outcome(hermes.query(RPC, preview(action, rid(n), params)));
      assert.equal(hermesCall.error?.code, '55P03', hermesCall.error?.message ?? JSON.stringify(hermesCall.value));
      assert.ok(Date.now() - started < 1000, 'không đợi tới deadlock_timeout');
      await hermes.query('ROLLBACK'); await hermes.query('RESET ROLE');
      const { value, error } = await webCall;
      assert.equal(error, undefined, error?.message);
      assert.equal(value.rows[0].r.cancellation_kind, 'CANCELLED_UNPOSTED');
      await web.query('ROLLBACK'); // giữ phiếu chờ duyệt cho ca sau
      assert.equal(await status(), 'UNAPPROVED');
    });
  }

  await t.test('không có web chen: Hermes xem trước huỷ bình thường (khoá NOWAIT không cản đường thường)', async () => {
    await hermes.query('BEGIN'); await claims(hermes); await hermes.query('SET LOCAL ROLE authenticated');
    const result = (await hermes.query(RPC, preview('expense.cancel', rid(3), CANCEL))).rows[0].result;
    await hermes.query('ROLLBACK'); await hermes.query('RESET ROLE');
    assert.equal(result.kind, 'preview', JSON.stringify(result));
  });

  await t.test('đối chứng: bước ghi đột biến bỏ NOWAIT (chờ phiếu khi đang giữ công ty) ⇒ 40P01', async () => {
    const { webCall } = await interleave();
    await hermes.query('RESET ROLE');
    await hermes.query(STEP.replace(NOWAIT, 'AND ie.deleted_at IS NULL;')); // lùi cùng giao dịch
    await hermes.query('SET LOCAL ROLE authenticated');
    const hermesCall = await outcome(hermes.query(RPC, preview('expense.cancel', rid(4), CANCEL)));
    const webResult = await webCall;
    await web.query('ROLLBACK'); await hermes.query('ROLLBACK'); await hermes.query('RESET ROLE');
    assert.equal([webResult, hermesCall].filter(r => r.error?.code === '40P01').length, 1, JSON.stringify([webResult.error?.message, hermesCall.error?.message]));
    assert.equal(await status(), 'UNAPPROVED');
    assert.match((await watch.query("SELECT prosrc FROM pg_proc WHERE oid='app_private.hermes_expense_write_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure"))
      .rows[0].prosrc, /FOR UPDATE NOWAIT/, 'đột biến đã lùi');
  });
});
