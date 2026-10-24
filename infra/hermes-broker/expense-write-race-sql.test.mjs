import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { localCluster } from './crm-shared-read-sql-fixture.mjs';
import { SESSION } from './finance-fixture.mjs';
import { expenseSetup, ROUND1, LOCK_SITES, IMAGE, rid, binding, ORG, USER, BUILDING, ROOM, CATEGORY, CASHBOOK } from './expense-write-fixture.mjs';

// Thu chi Mốc 4b + 5 + lượt 8: thứ tự khoá của bước ghi expense.* trên PostgreSQL thật (hai kết nối; PGlite chỉ có một). Cùng fixture với
// expense-write-sql.test.mjs; bản port hàm web khoá như hàm thật: dòng nghiệp vụ (phiếu, sổ, phòng, yêu cầu duyệt) rồi mới khoá công ty.
// Guard dùng chung của Hermes khoá dòng công ty NGAY ĐẦU giao dịch, nên Hermes và web khoá theo hai thứ tự ngược nhau; bước ghi khoá trước,
// NOWAIT, mọi dòng mà hàm web sẽ khoá nên Hermes không bao giờ chờ web ⇒ không có vòng chờ. Ca đối chứng bỏ NOWAIT chứng minh phép đo bắt
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
const WEB = {
  cancel: "SELECT public.cancel_income_expense_flex_v1($1,'web huỷ song song',NULL,NULL)::text r",
  approve: "SELECT public.approve_income_expense_v2($1,1,'web-duyet-song-song')::text r",
  closeCashbook: 'SELECT public.fixture_close_cashbook($1) r',
  claimRoom: 'SELECT public.fixture_claim_room($1) r',
  roomPolicy: 'SELECT public.fixture_save_room_policy($1) r',
  emergencyApprove: 'SELECT public.fixture_emergency_approve($1) r',
};
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
// Thân bước ghi đang sống sau toàn chuỗi (lượt 14 dựng lại từ thân lượt 13, lượt 13 từ lượt 11, lượt 11 từ lượt 8; câu khoá giữ nguyên) —
// đối chứng bỏ NOWAIT dựng trên thân này.
const STEP = ROUND1.replaceAll('\r\n', '\n').match(/CREATE OR REPLACE FUNCTION app_private\.hermes_expense_write_step_v1\([\s\S]*?END \$fn\$;/)[0];
const dropNowait = anchor => anchor.replace(' NOWAIT;', ';');
const CREATE = { items: [{ buildingName: 'Toà A', amount: 350000, content: 'mua vòi nước', category: 'sửa chữa', cashbook: 'Quỹ VCB 0123456789' }] };
const CREATE_ROOM = { items: [{ ...CREATE.items[0], roomName: 'P101', cashbook: 'Tiền mặt toà A' }] };
// Ca đua: web giữ một dòng nghiệp vụ rồi chờ công ty (Hermes đang giữ) ⇒ Hermes phải nhả ngay bằng 55P03; bỏ câu khoá tương ứng ⇒ 40P01.
const CASES = [
  ['expense.cancel', 'web huỷ giữ phiếu', 'cancel', 'pending', { voucherCode: 'PC2610801', reason: 'lập trùng phiếu' }, 'editCancelVoucher'],
  ['expense.edit', 'web huỷ giữ phiếu', 'cancel', 'pending', { voucherCode: 'PC2610801', content: 'mua bóng đèn LED' }, 'editCancelVoucher'],
  ['expense.note', 'web huỷ giữ phiếu', 'cancel', 'pending', { voucherCode: 'PC2610801', note: 'đã lấy hoá đơn đỏ' }, 'noteVoucher'],
  ['expense.approve', 'web duyệt giữ phiếu', 'approve', 'pending', { voucherCodes: ['PC2610801'] }, 'approveVouchers'],
  ['expense.approve', 'web chốt sổ giữ sổ', 'closeCashbook', 'cashbook', { voucherCodes: ['PC2610803'] }, 'approveCashbooks'],
  ['expense.approve', 'web duyệt khẩn giữ yêu cầu duyệt', 'emergencyApprove', 'request', { voucherCodes: ['PC2610801'] }, 'approveRequests'],
  ['expense.cancel', 'web chốt sổ giữ sổ (phiếu đã vào sổ)', 'closeCashbook', 'cashbook', { voucherCode: 'PC2610802', reason: 'lập trùng phiếu' }, 'editCancelCashbooks'],
  ['expense.cancel', 'web duyệt khẩn giữ yêu cầu duyệt', 'emergencyApprove', 'request', { voucherCode: 'PC2610801', reason: 'lập trùng phiếu' }, 'editCancelRequests'],
  // Sửa đổi phòng chỉ lấy KEY SHARE (khoá ngoại) ⇒ chỉ vòng với hàm web giữ phòng FOR UPDATE (giữ phòng FOR NO KEY UPDATE không xung đột).
  ['expense.edit', 'web lưu chính sách bán phòng giữ phòng', 'roomPolicy', 'room', { voucherCode: 'PC2610801', roomName: 'P101' }, 'editRoom'],
  ['expense.create', 'web chốt sổ giữ sổ', 'closeCashbook', 'cashbook', CREATE, 'createCashbooks'],
  ['expense.create', 'web giữ chỗ phòng', 'claimRoom', 'room', CREATE_ROOM, 'createRooms'],
];
// Đột biến chạy riêng (scratchpad mutants-8.mjs): ONLY_CASE chỉ chạy ca của một vị trí khoá.
const RUN = process.env.ONLY_CASE ? CASES.filter(c => c[5] === process.env.ONLY_CASE) : CASES;

test('PG17 hai kết nối: web khoá dòng nghiệp vụ rồi mới khoá công ty, bước ghi expense.* của Hermes không bao giờ chờ ⇒ không deadlock', { timeout: 600000 }, async t => {
  const { pool, cleanup } = await localCluster(t, { initdbArgs: ['--locale-provider=builtin', '--builtin-locale=C.UTF-8'] });
  const hermes = await pool.connect(), web = await pool.connect(), watch = await pool.connect();
  const db = adapter(hermes);
  t.after(async () => { db.close(); web.release(); watch.release(); await pool.end(); cleanup(); });
  await expenseSetup(t, { database: db });
  for (const [name, anchor] of Object.entries(LOCK_SITES)) assert.equal(STEP.split(anchor).length, 2, `${name}: câu khoá đúng một chỗ`);
  const insert = async (code, extra) => (await hermes.query(`INSERT INTO public.income_expenses(organization_id,user_id,code,type,name,building_id,account_id,voucher_date,
      total_amount,approval_status,posting_status,attachments) VALUES($1,$2,$3,'EXPENSE','mua bóng đèn',$4,$5,current_date,400000,$6,$7,$8) RETURNING id`,
    [ORG, USER, code, BUILDING, CASHBOOK, extra.status ?? 'UNAPPROVED', extra.posting ?? 'UNPOSTED', JSON.stringify(extra.images ?? [])])).rows[0].id;
  const pending = await insert('PC2610801', {});
  const posted = await insert('PC2610802', { status: 'APPROVED', posting: 'POSTED' });
  const withImage = await insert('PC2610803', { images: [IMAGE(1)] });
  for (const id of [pending, posted, withImage])
    await hermes.query(`INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,amount,start_date,end_date)
      VALUES($1,$2,400000,current_date,current_date)`, [id, CATEGORY]);
  const request = (await hermes.query(`INSERT INTO public.approval_requests(organization_id,subject_type,subject_id) VALUES($1,'INCOME_EXPENSE',$2) RETURNING id`,
    [ORG, pending])).rows[0].id;
  const ARGS = { pending, cashbook: CASHBOOK, room: ROOM, request };
  const webPid = (await web.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  // Kết nối web đang chờ khoá; trả các bảng có khoá dòng (tuple) nó đang xếp hàng.
  const blocked = async pid => {
    for (let i = 0; i < 400; i++) {
      if ((await watch.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock')
        return (await watch.query("SELECT DISTINCT relation::regclass::text rel FROM pg_locks WHERE pid=$1 AND locktype='tuple'", [pid])).rows.map(r => r.rel);
      await delay(25);
    }
    assert.fail(`kết nối ${pid} không chờ khoá`);
  };
  const snapshot = async () => (await watch.query(`SELECT (SELECT string_agg(approval_status||'/'||posting_status,',' ORDER BY code) FROM public.income_expenses
    WHERE code LIKE 'PC26108%') vouchers,(SELECT string_agg(state,',') FROM public.approval_requests) requests,(SELECT count(*)::int FROM public.income_expenses) n`)).rows[0];
  const before = await snapshot();
  // Hermes giữ dòng công ty (như guard), web vào hàm khoá dòng nghiệp vụ rồi xếp hàng ở dòng công ty.
  const interleave = async (webSql, arg) => {
    await hermes.query('BEGIN');
    await hermes.query('SELECT app_private.lock_org_for_decision_v1($1)', [ORG]);
    await web.query('BEGIN'); await claims(web); await web.query('SET LOCAL ROLE authenticated');
    const webCall = outcome(web.query(webSql, [arg]));
    assert.deepEqual(await blocked(webPid), ['organizations'], 'web giữ dòng nghiệp vụ, chờ công ty');
    await claims(hermes); await hermes.query('SET LOCAL ROLE authenticated');
    return { webCall }; // trong object: async không được chờ hàm web
  };

  for (const [n, [action, story, webKind, argKind, params, site]] of RUN.entries()) {
    await t.test(`${action} — ${story} ⇒ Hermes KHÔNG chờ (55P03 ⇒ state_changed), web làm xong [${site}]`, async () => {
      const { webCall } = await interleave(WEB[webKind], ARGS[argKind]);
      const started = Date.now();
      const hermesCall = await outcome(hermes.query(RPC, preview(action, rid(10 + n), params)));
      const elapsed = Date.now() - started;
      await hermes.query('ROLLBACK'); await hermes.query('RESET ROLE');
      const webResult = await webCall;
      await web.query('ROLLBACK'); // giữ nguyên dữ liệu cho ca sau
      assert.equal(hermesCall.error?.code, '55P03', hermesCall.error?.message ?? JSON.stringify(hermesCall.value?.rows?.[0]?.result));
      assert.ok(elapsed < 1000, 'không đợi tới deadlock_timeout');
      assert.equal(webResult.error, undefined, webResult.error?.message);
      assert.deepEqual(await snapshot(), before);
    });
  }
  if (process.env.ONLY_CASE) return;

  await t.test('không có web chen: xem trước của mọi thao tác chạy bình thường (khoá NOWAIT không cản đường thường)', async () => {
    await hermes.query('BEGIN'); await claims(hermes); await hermes.query('SET LOCAL ROLE authenticated');
    const results = [];
    for (const [n, [action, , , , params]] of CASES.entries()) {
      await hermes.query('SAVEPOINT s');
      results.push([action, JSON.stringify(params).slice(0, 40), (await hermes.query(RPC, preview(action, rid(40 + n), params))).rows[0].result.kind]);
      await hermes.query('ROLLBACK TO SAVEPOINT s');
    }
    await hermes.query('ROLLBACK'); await hermes.query('RESET ROLE');
    for (const [action, params, kind] of results) assert.equal(kind, 'preview', `${action} ${params}`);
  });

  // Lượt 14 (nghiệm thu 24/10: lượt đồng ý ra action_outcome_unknown khi chờ quá trần lời gọi): bước ghi đặt lock_timeout 3 s cho phần còn lại
  // của giao dịch — chờ khoá (khoá tư vấn của bộ máy chi, dòng hàm web khoá không NOWAIT) quá 3 s ⇒ 55P03 ⇒ state_changed. Khoá tư vấn giữ ở kết
  // nối web ⇒ lời gọi thử lấy cùng khoá từ phiên Hermes sau bước ghi ngã 55P03 sau ~3 s, không treo.
  await t.test('lượt 14: bước ghi đặt lock_timeout 3 s cho cả giao dịch; chờ khoá quá hạn ⇒ 55P03 (không treo)', async () => {
    await web.query('BEGIN'); await web.query('SELECT pg_advisory_xact_lock(4242)');
    await hermes.query('BEGIN'); await claims(hermes); await hermes.query('SET LOCAL ROLE authenticated');
    assert.equal((await hermes.query(RPC, preview('expense.create', rid(95), CREATE))).rows[0].result.kind, 'preview');
    const setting = (await hermes.query("SELECT current_setting('lock_timeout') v")).rows[0].v;
    const started = Date.now();
    const waited = await outcome(hermes.query('SELECT pg_advisory_xact_lock(4242)'));
    const elapsed = Date.now() - started;
    await hermes.query('ROLLBACK'); await hermes.query('RESET ROLE'); await web.query('ROLLBACK');
    assert.equal(setting, '3s');
    assert.equal(waited.error?.code, '55P03');
    assert.ok(elapsed >= 2500 && elapsed < 6000, `chờ ${elapsed} ms`);
  });

  // Đối chứng: đột biến bỏ NOWAIT (chờ dòng khi đang giữ công ty) ⇒ đúng một bên 40P01. Mọi vị trí còn lại đo bằng đột biến ở scratchpad.
  for (const site of ['editCancelVoucher', 'approveVouchers', 'noteVoucher', 'createCashbooks', 'approveRequests']) {
    const [n, [action, , webKind, argKind, params]] = [...CASES.entries()].find(([, c]) => c[5] === site);
    await t.test(`đối chứng [${site}]: bỏ NOWAIT ⇒ 40P01`, async () => {
      const { webCall } = await interleave(WEB[webKind], ARGS[argKind]);
      await hermes.query('RESET ROLE');
      await hermes.query(STEP.replace(LOCK_SITES[site], dropNowait(LOCK_SITES[site]))); // lùi cùng giao dịch
      await hermes.query('SET LOCAL ROLE authenticated');
      const hermesCall = await outcome(hermes.query(RPC, preview(action, rid(70 + n), params)));
      const webResult = await webCall;
      await web.query('ROLLBACK'); await hermes.query('ROLLBACK'); await hermes.query('RESET ROLE');
      assert.equal([webResult, hermesCall].filter(r => r.error?.code === '40P01').length, 1, JSON.stringify([webResult.error?.message, hermesCall.error?.message]));
      assert.deepEqual(await snapshot(), before);
    });
  }
  assert.equal((await watch.query("SELECT md5(replace(prosrc,chr(13),'')) m FROM pg_proc WHERE oid='app_private.hermes_expense_write_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure"))
    .rows[0].m, (await watch.query('SELECT md5($1) m', [STEP.slice(STEP.indexOf('$fn$') + 4, STEP.lastIndexOf('$fn$'))])).rows[0].m, 'đột biến đã lùi');
});
