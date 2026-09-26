// Thử G5 (5 cửa chi hỏi cổng bộ máy) trên TEST, transaction rồi ROLLBACK.
// SHADOW: hành vi y cũ. ON + công tắc: trong cam kết ⇒ máy duyệt; vượt ⇒ chờ; TỪNG_PHIẾU ⇒ luật cũ.
const fs = require('fs'); const path = require('path'); const pg = require('pg');
const REPO = 'C:/Users/Nguyen Tam/whiteboard-ihomecrm-main';
const MIG = (f) => path.join(REPO, 'supabase/migrations', f);
const FILES = ['20260926082454_bang_cam_ket_chi.sql', '20260926113435_anh_xa_hang_muc_va_khoa_cot_luat.sql',
  '20260926140000_va_guard_cot_luat_chi_canh_ghi_truc_tiep.sql', '20260926150000_bo_may_chi_so_tieu_va_quyet_dinh_bong.sql',
  '20260926160000_noi_writer_vao_bo_may_chi.sql'];
const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const OWNER = '0520169e-0860-4b4e-a603-675c8aa245aa';
pg.types.setTypeParser(1082, (v) => v);
function cred() {
  const t = fs.readFileSync(path.join(REPO, 'CLAUDE.local.md'), 'utf8');
  return { ref: t.match(/TEST_SUPABASE_REF=(\S+)/)[1], pwd: t.match(/TEST_SUPABASE_DB_PASSWORD=(\S+)/)[1],
           host: t.match(/TEST_SUPABASE_POOLER_HOST=(\S+)/)[1] };
}
const strip = (f) => fs.readFileSync(f, 'utf8').replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '');
const jwt = (uid) => JSON.stringify({ sub: uid, role: 'authenticated' });
const KQ = []; const ok = (ten, dat, chiTiet) => { KQ.push({ ten, dat, chiTiet }); console.log((dat ? '  ĐẠT ' : '  HỎNG') + '  ' + ten + (chiTiet ? '  — ' + chiTiet : '')); };

(async () => {
  const { ref, pwd, host } = cred();
  const c = new pg.Client({ host, port: 5432, database: 'postgres', user: 'postgres.' + ref, password: pwd,
    ssl: { rejectUnauthorized: false }, statement_timeout: 300000 });
  await c.connect(); console.log('da noi TEST ' + ref);
  const q = (sql, p) => c.query(sql, p);
  const asUser = async (uid, fn) => {
    await q('SAVEPOINT u');
    try {
      await q(`select set_config('request.jwt.claims', $1, true)`, [jwt(uid)]);
      await q('SET LOCAL ROLE authenticated');
      const r = await fn(); await q('RESET ROLE'); await q('RELEASE SAVEPOINT u'); return r;
    } catch (e) { await q('ROLLBACK TO SAVEPOINT u'); throw e; }
  };
  const flush = async () => { await q('SET CONSTRAINTS zz_spend_shadow_birth IMMEDIATE'); await q('SET CONSTRAINTS zz_spend_shadow_birth DEFERRED'); };
  const dec = async (vid) => (await q(`select writer, birth_status, engine_status, engine_reason, match, enforced from app_private.spend_decisions where income_expense_id=$1`, [vid])).rows[0];
  const status = async (vid) => (await q(`select approval_status from public.income_expenses where id=$1`, [vid])).rows[0].approval_status;

  await q('BEGIN');
  let chayQua = false;
  try {
    for (const f of FILES) await q(strip(MIG(f)));
    await q(strip(MIG(FILES[4])));   // lượt hai G5
    chayQua = true; console.log('ap G1..G5 + luot hai G5: qua');

    const SA = (await q(`select s.user_id from public.super_admins s join public.organization_memberships m on m.user_id=s.user_id
                          where m.organization_id=$1 and m.status='ACTIVE' order by 1 limit 1`, [ORG])).rows[0].user_id;
    const types = Object.fromEntries((await q(`select fee_category, id from public.income_expense_types where organization_id=$1 and fee_category is not null`, [ORG])).rows.map(r => [r.fee_category, r.id]));
    const tp = (await q(`select id from public.income_expense_types where organization_id=$1 and type='expense' and fee_category is null
                          and not force_approval and not is_deposit and not coalesce(system_only,false) and not coalesce(is_restricted,false) order by created_at limit 1`, [ORG])).rows[0].id;
    const bld = (await q(`select c.building_id, b.name, c.amount::numeric amount from app_private.spend_commitments c join public.buildings b on b.id=c.building_id
       where c.organization_id=$1 and c.fee_category='tien_nha' and c.period_month='2027-03-01' and c.status='PUBLISHED'
       order by c.amount desc limit 1`, [ORG])).rows[0];
    const acc = (await q(`select a.id from public.income_expenses e join public.accounts a on a.id=e.account_id
       where e.building_id=$1 and e.type='EXPENSE' and e.deleted_at is null and a.deleted_at is null and not coalesce(a.is_virtual,false)
       group by a.id order by count(*) desc limit 1`, [bld.building_id])).rows[0].id;
    // quản lý lập được, không duyệt được ở toà này
    let QL = null;
    for (const r of (await q(`select m.user_id from public.organization_memberships m where m.organization_id=$1 and m.status='ACTIVE'
        and not exists (select 1 from public.super_admins s where s.user_id=m.user_id) and not app_private.ie_actor_is_company_owner_v1($1, m.user_id)
        order by 1`, [ORG])).rows) {
      await q(`select set_config('request.jwt.claims', $1, true)`, [jwt(r.user_id)]);
      const x = (await q(`select app_private.ie_maker_can_approve_v1($1) d, app_private.authorize_income_expense_on_building($2,$3,'create',$1) t`, [bld.building_id, r.user_id, ORG])).rows[0];
      if (x.t && !x.d) { QL = r.user_id; break; }
    }
    // sổ của quản lý: sổ họ giữ theo luật CHI (chủ sổ / CUSTODIAN / OPERATOR)
    const accQL = (await q(`select a.id from public.accounts a where a.organization_id=$1 and a.deleted_at is null and not coalesce(a.is_virtual,false)
        and (a.user_id=$2 or exists (select 1 from public.cashbook_possession_bindings b join public.organization_memberships m on m.id=b.membership_id
          where b.cashbook_id=a.id and m.user_id=$2 and m.status='ACTIVE' and b.valid_to is null and b.possession_kind in ('CUSTODIAN','OPERATOR')))
        order by a.name limit 1`, [ORG, QL])).rows[0];
    console.log('   toa ' + bld.name + ' · cam ket tien nha T3/2027 ' + bld.amount + ' · quan ly ' + QL + ' · so quan ly ' + (accQL ? accQL.id : 'KHONG'));
    const soCua = (uid) => (uid === QL ? (accQL ? accQL.id : null) : acc);

    const tay = (uid, lines, ten) => asUser(uid, async () => (await q(`
      select (public.create_income_expense_v1('EXPENSE', $1::text, $2::uuid, null, null, null, null, null, null, $3::uuid, '[]'::jsonb, true, null, '2027-03-05'::date,
        $4::jsonb, $5::text)).*`, [ten, bld.building_id, soCua(uid), JSON.stringify(lines), 'g5-' + Math.random().toString(36).slice(2)])).rows[0]);
    const dong = (type, soTien, tu = '2027-03-01', den = '2027-03-31') => ({ income_expense_type_id: type, description: 'g5', quantity: 1, unit_price: soTien, start_date: tu, end_date: den });
    const phi = (uid, key, soTien, ky) => asUser(uid, async () => (await q(`select public.pay_period_fee($1::uuid, $2::text, $3::numeric, $4::text, $4::text, '2027-03-05'::date, null, null, $5::uuid, null, false) r`,
      [bld.building_id, key, soTien, ky, soCua(uid)])).rows[0].r);

    // ================= SHADOW: y như cũ =================
    console.log('-- SHADOW (co spend.engine.v1 = SHADOW, 0 cong tac)');
    const s1 = await tay(QL, [dong(types.tien_nha, 700000)], 'G5 S1 quản lý tiền nhà trên ngưỡng');
    ok('S1: quan ly tien nha 700k → CHO nhu cu (nguong 600k)', s1.approval_status === 'UNAPPROVED', s1.approval_status);
    const s2 = await tay(SA, [dong(types.tien_nha, 1000000)], 'G5 S2 người có quyền duyệt');
    ok('S2: nguoi co quyen duyet → DUYET nhu cu', s2.approval_status === 'APPROVED', s2.approval_status);
    // tháng 2/2027: tháng 3 đã có phiếu tiền nhà của S2 ⇒ trang Thanh toán tự chặn đóng trùng (đúng luật chống trùng)
    const s3 = await phi(SA, 'tien_nha', 1000000, '2027-02');
    if (!s3 || !s3.voucher_id) throw new Error('pay_period_fee khong tao phieu: ' + JSON.stringify(s3));
    const s3t = (await q(`select i.income_expense_type_id t from public.income_expense_items i where i.income_expense_id=$1`, [s3.voucher_id])).rows[0].t;
    ok('S3: pay_period_fee tien nha → dung hang muc DA ANH XA (Tien nha)', s3t === types.tien_nha, s3t);
    ok('S3: pay_period_fee → tu duyet nhu cu (CONFIG_REQUIRED)', s3.auto_approved === true && s3.spend_decision && s3.spend_decision.enforce === false, JSON.stringify({ auto: s3.auto_approved, note: s3.status_note, sd: s3.spend_decision && { enforce: s3.spend_decision.enforce, status: s3.spend_decision.status, reason: s3.spend_decision.reason } }));
    await flush();
    const d1 = await dec(s1.id), d3 = await dec(s3.voucher_id);
    ok('S: so bong ghi dung writer (create_income_expense_v1, pay_period_fee)', d1 && d1.writer === 'create_income_expense_v1' && d3 && d3.writer === 'pay_period_fee', JSON.stringify({ d1, d3 }));
    ok('S: bong chi ra doi chinh sach — quan ly trong cam ket, may noi DUYET', d1 && d1.engine_status === 'APPROVED' && d1.match === false && d1.enforced === false, JSON.stringify(d1));
    // cron định kỳ chạy qua, trạng thái con = repeat_auto_approve của cha
    const rv = (await q(`select g.child_id, e.approval_status, p.repeat_auto_approve from public.generate_recurring_vouchers(null) g
        join public.income_expenses e on e.id=g.child_id join public.income_expenses p on p.id=g.parent_id`)).rows;
    ok('S4: cron dinh ky chay qua, trang thai con = repeat_auto_approve cua cha', rv.every(x => (x.approval_status === 'APPROVED') === x.repeat_auto_approve), 'sinh ' + rv.length + ' phieu con');

    // ================= ON + công tắc tiền nhà cho toà thử =================
    console.log('-- ON (co spend.engine.v1 = ON, cong tac tien_nha toa ' + bld.name + ' tu 10/2026)');
    await q(`update app_private.server_feature_flags set mode='ON', commit_sha='test', migration_sha256='test', maintenance_window_id='test', approval_reference='test' where feature_key='spend.engine.v1'`);
    await asUser(OWNER, () => q(`select public.set_spend_policy_switch_v1($1, 'tien_nha', '2026-10-01', null, $2, true, 'thử G5')`, [ORG, bld.building_id]));
    const conLai = Number((await q(`select app_private.commitment_remaining_v1(c.id) r from app_private.spend_commitments c
        where c.building_id=$1 and c.fee_category='tien_nha' and c.period_month='2027-03-01' and c.status='PUBLISHED'`, [bld.building_id])).rows[0].r);
    console.log('   con lai T3/2027: ' + conLai);
    const o1 = await tay(QL, [dong(types.tien_nha, 700000)], 'G5 O1 quản lý trong cam kết');
    ok('O1: quan ly trong cam ket (tren nguong) → MAY DUYET', o1.approval_status === 'APPROVED', o1.approval_status);
    const o2 = await tay(SA, [dong(types.tien_nha, conLai + 1000000)], 'G5 O2 người có quyền duyệt vượt');
    ok('O2: nguoi co quyen duyet VUOT cam ket → CHO (cau 10)', o2.approval_status === 'UNAPPROVED', o2.approval_status);
    const o10 = await tay(QL, [dong(types.tien_nha, 100000)], 'G5 O10 sau phiếu chờ vượt');
    ok('O10: phieu CHO vuot cam ket dang giu cho ca thang → phieu nho sau do cung CHO (cau 09)', o10.approval_status === 'UNAPPROVED', o10.approval_status);
    const o3 = await tay(QL, [dong(tp, 700000)], 'G5 O3 từng phiếu');
    ok('O3: hang muc TUNG_PHIEU → luat cu (quan ly tren nguong → CHO)', o3.approval_status === 'UNAPPROVED', o3.approval_status);
    // tháng 7/2027: tháng 3 đã bị phiếu chờ O2 giữ chỗ (câu 09) — O10 kiểm riêng ca đó
    const o4 = await tay(QL, [dong(types.tien_nha, 100000, '2027-07-01', '2027-07-31'), dong(tp, 50000, '2027-07-01', '2027-07-31')], 'G5 O4 phiếu trộn nhỏ');
    await flush();
    const d4 = (await q(`select engine_status, engine_reason, enforced, decision->'lines' dl, facts->'total' tong, facts->'threshold' nguong,
        facts->'actor_can_approve' duyet, facts->'account_real' so, (select jsonb_agg(jsonb_build_object('mode', l->>'spend_mode', 'force', l->'force_approval', 'amt', l->'amount'))
          from jsonb_array_elements(facts->'lines') l) dong from app_private.spend_decisions where income_expense_id=$1`, [o4.id])).rows[0];
    ok('O4: phieu tron (tien nha trong cam ket + tung phieu, tong 150k duoi nguong) → DUYET', o4.approval_status === 'APPROVED', o4.approval_status + ' ' + JSON.stringify(d4));
    const o5 = await tay(QL, [dong(types.tien_nha, 100000, '2027-08-01', '2027-08-31'), dong(tp, 600000, '2027-08-01', '2027-08-31')], 'G5 O5 phiếu trộn lớn');
    ok('O5: phieu tron tong 700k → dong tung phieu keo ca phieu ve CHO (nguong)', o5.approval_status === 'UNAPPROVED', o5.approval_status);
    const o6 = await tay(QL, [dong(types.tien_nha, 100000, '2027-10-01', '2027-10-31')], 'G5 O6 tháng chưa ký');
    ok('O6: thang chua ky cam ket (bucket bat nhung khong cam ket) → CHO', o6.approval_status === 'UNAPPROVED', o6.approval_status);
    // pay_period_fee chỉ cho dùng sổ người bấm đứng tên hoặc admin (khoảng trống G6 sẽ chuẩn hoá) ⇒ thử bằng tài khoản hệ thống
    const o7 = await phi(SA, 'tien_nha', 500000, '2027-04');
    if (!o7 || !o7.voucher_id) throw new Error('pay_period_fee O7 khong tao phieu: ' + JSON.stringify(o7));
    ok('O7: pay_period_fee trong cam ket → MAY DUYET + ghi chu bo may', o7.auto_approved === true && /Bộ máy chi/.test(o7.status_note || ''), JSON.stringify({ auto: o7.auto_approved, note: o7.status_note }));
    const o8 = await phi(SA, 'tien_nha', 999000000, '2027-05');
    if (!o8 || !o8.voucher_id) throw new Error('pay_period_fee O8 khong tao phieu: ' + JSON.stringify(o8));
    ok('O8: pay_period_fee vuot cam ket → CHO (ke ca nguoi co quyen duyet)', o8.auto_approved === false && (await status(o8.voucher_id)) === 'UNAPPROVED', JSON.stringify({ auto: o8.auto_approved, note: o8.status_note }));
    await flush();
    const e1 = await dec(o1.id), e2 = await dec(o2.id), e3 = await dec(o3.id);
    ok('O: so bong ghi enforced=true cho phieu ap, false cho tung phieu', e1 && e1.enforced && e1.match && e2 && e2.enforced && e2.match && e3 && !e3.enforced, JSON.stringify({ e1, e2, e3 }));
    // tắt công tắc ⇒ về luật cũ ngay
    await asUser(OWNER, () => q(`select public.set_spend_policy_switch_v1($1, 'tien_nha', '2026-10-01', null, $2, false, null)`, [ORG, bld.building_id]));
    const o9 = await tay(QL, [dong(types.tien_nha, 700000, '2027-06-01', '2027-06-30')], 'G5 O9 sau khi tắt công tắc');
    ok('O9: tat cong tac → quan ly tren nguong lai CHO (luat cu)', o9.approval_status === 'UNAPPROVED', o9.approval_status);

    const au = (await q(`select app_private.spend_ledger_audit_v1(null) a`)).rows[0].a;
    ok('Z: audit so tieu 0 lech', au.lech_thieu === 0 && au.lech_thua === 0, JSON.stringify(au));
    const er = (await q(`select context, sqlstate, message from app_private.spend_engine_errors`)).rows;
    ok('Z: 0 loi may', er.length === 0, JSON.stringify(er).slice(0, 300));
  } catch (e) {
    console.error('\n>>> LOI <<<\n' + e.message + (e.where ? '\n' + e.where : ''));
    ok('chay tron', false, e.message.slice(0, 200));
  } finally { await q('ROLLBACK'); await c.end(); }
  const hong = KQ.filter(x => !x.dat).length;
  console.log('\n' + (KQ.length - hong) + '/' + KQ.length + ' ca DAT · da ROLLBACK — TEST khong con dau vet.');
  fs.writeFileSync(path.join(__dirname, 'thu-G5-tren-TEST.json'), JSON.stringify({ chay_luc: new Date().toISOString(), migration_qua: chayQua, ket_qua: KQ }, null, 1), 'utf8');
  process.exit(chayQua && hong === 0 ? 0 : 1);
})().catch((e) => { console.error('THAT BAI:', e.message); process.exit(1); });
