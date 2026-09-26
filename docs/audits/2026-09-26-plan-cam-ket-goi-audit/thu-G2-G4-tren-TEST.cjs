// Thử G2 + G4 (bộ máy quyết định + sổ tiêu + bóng lúc sinh) trên TEST, trong transaction rồi ROLLBACK.
// Chạy G1 → G3 → vá guard → G2G4 (hai lượt) rồi thử hành vi thật qua RPC với JWT người dùng.
const fs = require('fs'); const path = require('path'); const pg = require('pg');
const REPO = 'C:/Users/Nguyen Tam/whiteboard-ihomecrm-main';
const MIG = (f) => path.join(REPO, 'supabase/migrations', f);
const FILES = ['20260926082454_bang_cam_ket_chi.sql', '20260926113435_anh_xa_hang_muc_va_khoa_cot_luat.sql',
  '20260926140000_va_guard_cot_luat_chi_canh_ghi_truc_tiep.sql', '20260926150000_bo_may_chi_so_tieu_va_quyet_dinh_bong.sql'];
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
  const notices = []; c.on('notice', (n) => notices.push(n.message));
  const q = (sql, p) => c.query(sql, p);
  // mỗi lần đóng vai người dùng bọc trong SAVEPOINT: lỗi thì lùi về (trả cả vai lẫn GUC), lỗi gốc không bị che
  const asUser = async (uid, fn) => {
    await q('SAVEPOINT u');
    try {
      await q(`select set_config('request.jwt.claims', $1, true)`, [jwt(uid)]);
      await q('SET LOCAL ROLE authenticated');
      const r = await fn();
      await q('RESET ROLE');
      await q('RELEASE SAVEPOINT u');
      return r;
    } catch (e) {
      await q('ROLLBACK TO SAVEPOINT u');
      throw e;
    }
  };
  const draws = async (vid) => (await q(`select d.kind, d.amount::numeric amount, d.over_commitment, c.period_month, c.fee_category
      from app_private.spend_commitment_draws d join app_private.spend_commitments c on c.id=d.commitment_id
     where d.income_expense_id=$1 order by c.period_month`, [vid])).rows;
  const flushShadow = async () => { await q('SET CONSTRAINTS zz_spend_shadow_birth IMMEDIATE'); await q('SET CONSTRAINTS zz_spend_shadow_birth DEFERRED'); };
  const decision = async (vid) => (await q(`select writer, route, birth_status, engine_status, engine_reason, match, enforced from app_private.spend_decisions where income_expense_id=$1`, [vid])).rows[0];

  await q('BEGIN');
  let chayQua = false;
  try {
    // ---------------- áp migration ----------------
    for (const f of FILES) { await q(strip(MIG(f))); console.log('ap ' + f); }
    const t0 = Date.now(); await q(strip(MIG(FILES[3]))); console.log('ap lan hai G2G4 (' + (Date.now() - t0) + 'ms)');
    notices.filter(n => /Sổ tiêu/.test(n)).forEach(n => console.log('   NOTICE: ' + n));
    chayQua = true;

    const flag = (await q(`select feature_key, mode from app_private.server_feature_flags where feature_key like 'spend.%' order by 1`)).rows;
    ok('co tuyen moi o SHADOW', flag.length === 2 && flag.every(x => x.mode === 'SHADOW'), JSON.stringify(flag));
    const bf = (await q(`select kind, count(*)::int n, sum(amount)::numeric s from app_private.spend_commitment_draws group by 1 order by 1`)).rows;
    console.log('   so tieu khoi tao: ' + JSON.stringify(bf));
    const au0 = (await q(`select app_private.spend_ledger_audit_v1(null) a`)).rows[0].a;
    ok('audit sau khoi tao = 0 lech', au0.lech_thieu === 0 && au0.lech_thua === 0, JSON.stringify(au0));

    // ---------------- dữ liệu thử ----------------
    const tienNha = (await q(`select id from public.income_expense_types where organization_id=$1 and fee_category='tien_nha'`, [ORG])).rows[0].id;
    // Trên TEST, tài khoản chủ công ty duyệt được nhưng KHÔNG lập được phiếu (phân quyền sẵn có) ⇒ ca "người có
    // quyền duyệt tự lập" dùng tài khoản hệ thống (super admin, lập + duyệt được); RPC của chủ vẫn thử bằng OWNER.
    const SA = (await q(`select s.user_id from public.super_admins s join public.organization_memberships m on m.user_id=s.user_id
                          where m.organization_id=$1 and m.status='ACTIVE' order by 1 limit 1`, [ORG])).rows[0].user_id;
    const bld = (await q(`
      select c.building_id, b.name, c.amount::numeric amount
        from app_private.spend_commitments c join public.buildings b on b.id=c.building_id
       where c.organization_id=$1 and c.fee_category='tien_nha' and c.period_month='2026-10-01' and c.status='PUBLISHED'
         and exists (select 1 from app_private.spend_commitments c2 where c2.building_id=c.building_id and c2.fee_category='tien_nha' and c2.period_month='2026-12-01')
         and not exists (select 1 from app_private.spend_commitment_draws d where d.commitment_id=c.id)
       order by c.amount desc limit 1`, [ORG])).rows[0];
    console.log('   toa thu: ' + bld.name + ' — cam ket tien nha T10 ' + bld.amount);
    // sổ: ưu tiên sổ chủ giữ theo luật CHI; không có thì sổ thật mà phiếu chi của toà này hay dùng
    let acc = (await q(`
      select a.id, a.name from public.accounts a
       where a.organization_id=$1 and a.deleted_at is null and not coalesce(a.is_virtual,false)
         and (a.user_id=$2 or exists (select 1 from public.cashbook_possession_bindings b join public.organization_memberships m on m.id=b.membership_id
               where b.cashbook_id=a.id and m.user_id=$2 and m.status='ACTIVE' and b.valid_to is null and b.possession_kind in ('CUSTODIAN','OPERATOR')))
       order by a.name limit 1`, [ORG, SA])).rows[0];
    if (!acc) acc = (await q(`
      select a.id, a.name from public.income_expenses e join public.accounts a on a.id=e.account_id
       where e.building_id=$1 and e.type='EXPENSE' and e.deleted_at is null and a.deleted_at is null and not coalesce(a.is_virtual,false)
       group by a.id, a.name order by count(*) desc limit 1`, [bld.building_id])).rows[0];
    console.log('   so quy chu: ' + (acc ? acc.name : 'KHONG CO'));

    const taoPhieu = async (uid, soTien, tu, den, ten) => asUser(uid, async () => (await q(`
      select (public.create_income_expense_v1('EXPENSE', $1::text, $2::uuid, null, null, null, null, null, null, $3::uuid, '[]'::jsonb, true, null, $4::date,
        jsonb_build_array(jsonb_build_object('income_expense_type_id', $5::text, 'description', $1::text, 'quantity', 1, 'unit_price', $6::numeric,
          'start_date', $7::text, 'end_date', $8::text)), $9::text)).*`,
      [ten, bld.building_id, acc.id, tu, tienNha, soTien, tu, den, 'thu-may-chi-' + Math.random().toString(36).slice(2)])).rows[0]);

    // A. chủ lập phiếu tiền nhà T10 trong cam kết → DRAW; bóng khớp
    const a = await taoPhieu(SA, 1000000, '2026-10-01', '2026-10-31', 'Thử máy chi A');
    const da = await draws(a.id);
    ok('A: chu lap tien nha T10 → 1 dong DRAW', a.approval_status === 'APPROVED' && da.length === 1 && da[0].kind === 'DRAW' && !da[0].over_commitment, a.approval_status + ' ' + JSON.stringify(da));
    await flushShadow();
    const sa = await decision(a.id);
    ok('A: bong luc sinh — WITHIN_COMMITMENT, khop', sa && sa.engine_reason === 'WITHIN_COMMITMENT' && sa.match === true && sa.writer === 'manual', JSON.stringify(sa));

    // B. vượt cam kết (chủ): cũ vẫn tự duyệt → DRAW over=true; bóng lệch OVER_COMMITMENT
    const b = await taoPhieu(SA, Number(bld.amount), '2026-10-01', '2026-10-31', 'Thử máy chi B');
    const db = await draws(b.id);
    ok('B: vuot cam ket → DRAW over_commitment=true', db.length === 1 && db[0].kind === 'DRAW' && db[0].over_commitment === true, JSON.stringify(db));
    await flushShadow();
    const sb = await decision(b.id);
    ok('B: bong — may noi CHO (OVER_COMMITMENT), that la DA DUYET ⇒ lech duoc ghi', sb && sb.engine_status === 'UNAPPROVED' && sb.engine_reason === 'OVER_COMMITMENT' && sb.match === false, JSON.stringify(sb));

    // C. chia nhiều tháng: 3.000.000 cho T10–T12 → 3 dòng 1.000.000
    const cc = await taoPhieu(SA, 3000000, '2026-10-01', '2026-12-31', 'Thử máy chi C');
    const dc = await draws(cc.id);
    ok('C: dong trai 3 thang → 3 dong tieu deu nhau', dc.length === 3 && dc.every(x => Number(x.amount) === 1000000), JSON.stringify(dc.map(x => x.period_month + ':' + x.amount)));

    // D. huỷ phiếu A → RELEASE (tìm RPC huỷ thật)
    const huy = (await q(`select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname in ('cancel_income_expense_v1','cancel_income_expense','cancel_voucher') order by 1`)).rows.map(r => r.f);
    console.log('   ham huy co: ' + JSON.stringify(huy));
    let daHuy = false;
    for (const f of huy) {
      const nArgs = (f.match(/,/g) || []).length + 1;
      await q('SAVEPOINT huy');
      try {
        await asUser(SA, () => nArgs === 1 ? q(`select public.${f.split('(')[0].replace('public.', '')}($1)`, [a.id])
                                               : q(`select public.${f.split('(')[0].replace('public.', '')}($1, $2)`, [a.id, 'Thử máy chi — huỷ']));
        await q('RELEASE SAVEPOINT huy'); daHuy = true; console.log('   huy bang ' + f); break;
      } catch (e) { await q('ROLLBACK TO SAVEPOINT huy'); console.log('   ' + f + ' loi: ' + e.message.slice(0, 120)); }
    }
    if (!daHuy) { // đường lùi: đổi trạng thái trực tiếp bằng postgres (thử cơ chế trigger, không phải quyền)
      await q(`update public.income_expenses set approval_status='CANCELLED' where id=$1`, [a.id]).catch(e => console.log('   update truc tiep loi: ' + e.message.slice(0, 120)));
    }
    const dd = await draws(a.id);
    ok('D: huy phieu A → RELEASE', dd.length === 1 && dd[0].kind === 'RELEASE', JSON.stringify(dd));

    // E. quản lý không có quyền duyệt, trong cam kết, trên ngưỡng 600k → cũ CHỜ (HOLD); máy nói DUYỆT
    const mgr = (await q(`
      select m.user_id from public.organization_memberships m
       where m.organization_id=$1 and m.status='ACTIVE' and m.user_id<>$2
         and not exists (select 1 from public.super_admins s where s.user_id=m.user_id)
         and not app_private.ie_actor_is_company_owner_v1($1, m.user_id)
       order by m.user_id`, [ORG, OWNER])).rows.map(r => r.user_id);
    let quanLy = null;
    for (const u of mgr) {
      // đo quyền bằng postgres + JWT của người đó (authenticated không có USAGE app_private)
      await q(`select set_config('request.jwt.claims', $1, true)`, [jwt(u)]);
      const r = (await q(`select app_private.ie_maker_can_approve_v1($1) duyet,
             app_private.authorize_income_expense_on_building($2, $3, 'create', $1) tao`, [bld.building_id, u, ORG])).rows[0];
      if (r && r.tao && !r.duyet) { quanLy = u; break; }
    }
    console.log('   quan ly thu: ' + quanLy);
    if (!quanLy) { ok('E: tim quan ly lap duoc nhung khong duyet duoc', false, 'khong tim thay'); }
    else {
      await q('SAVEPOINT e');
      try {
        const accM = (await q(`select a.id from public.accounts a where a.organization_id=$1 and a.deleted_at is null and not coalesce(a.is_virtual,false)
            and (a.user_id=$2 or exists (select 1 from public.cashbook_possession_bindings b join public.organization_memberships m on m.id=b.membership_id
              where b.cashbook_id=a.id and m.user_id=$2 and m.status='ACTIVE' and b.valid_to is null and b.possession_kind in ('CUSTODIAN','OPERATOR'))) limit 1`, [ORG, quanLy])).rows[0];
        const e = await asUser(quanLy, async () => (await q(`
          select (public.create_income_expense_v1('EXPENSE', 'Thử máy chi E', $1, null, null, null, null, null, null, $2, '[]'::jsonb, true, null, '2026-10-06'::date,
            jsonb_build_array(jsonb_build_object('income_expense_type_id', $3::text, 'description', 'E', 'quantity', 1, 'unit_price', 700000,
              'start_date', '2026-11-01', 'end_date', '2026-11-30')), $4)).*`,
          [bld.building_id, accM ? accM.id : null, tienNha, 'thu-may-chi-e-' + Math.random().toString(36).slice(2)])).rows[0]);
        const de = await draws(e.id);
        ok('E: quan ly tren nguong → cu CHO, so tieu HOLD', e.approval_status === 'UNAPPROVED' && de.length === 1 && de[0].kind === 'HOLD', e.approval_status + ' ' + JSON.stringify(de));
        await flushShadow();
        const se = await decision(e.id);
        ok('E: bong — may noi DUYET (WITHIN_COMMITMENT) ⇒ day la doi chinh sach chu muon', se && se.engine_status === 'APPROVED' && se.engine_reason === 'WITHIN_COMMITMENT' && se.match === false, JSON.stringify(se));
        // chủ duyệt → HOLD → DRAW
        await asUser(OWNER, () => q(`select public.approve_income_expense_v1($1)`, [e.id]));
        const de2 = await draws(e.id);
        ok('E: chu duyet → HOLD thanh DRAW', de2.length === 1 && de2[0].kind === 'DRAW', JSON.stringify(de2));
        await q('RELEASE SAVEPOINT e');
      } catch (err) { await q('ROLLBACK TO SAVEPOINT e'); ok('E: quan ly lap phieu', false, err.message.slice(0, 200)); }
    }

    // F. sửa cam kết tháng đã có tiêu → 55000; tháng trống → được, và kéo phiếu có sẵn vào
    await q('SAVEPOINT f');
    try {
      await asUser(OWNER, () => q(`select public.set_spend_commitment_v1($1, 'tien_nha', '2026-10-01', 1, null)`, [bld.building_id]));
      ok('F: sua cam ket thang da tieu phai bi chan', false, 'lot qua');
    } catch (e) { ok('F: sua cam ket thang da tieu → 55000', e.code === '55000', e.code + ' ' + e.message.slice(0, 80)); }
    await q('ROLLBACK TO SAVEPOINT f');
    const thang2027 = '2027-10-01';   // ngoài 12 tháng khởi tạo ⇒ chưa có cam kết
    const g = await taoPhieu(SA, 500000, thang2027, thang2027, 'Thử máy chi G (lập trước khi ký)');
    const dg0 = await draws(g.id);
    const kg = await asUser(OWNER, async () => (await q(`select public.set_spend_commitment_v1($1, 'tien_nha', $2::date, 2000000, 'thử') r`, [bld.building_id, thang2027])).rows[0].r);
    const dg1 = await draws(g.id);
    ok('F: ky cam ket thang moi → phieu lap truoc duoc keo vao so tieu', dg0.length === 0 && dg1.length === 1 && Number(kg.con_lai) === 1500000, JSON.stringify({ truoc: dg0.length, sau: dg1, kg }));

    // G. đổi luật hạng mục → sổ tiêu nhả / kéo lại
    await asUser(OWNER, () => q(`select public.set_income_expense_type_spend_rule_v1($1, 'TUNG_PHIEU', null)`, [tienNha]));
    const nTp = (await q(`select count(*)::int n from app_private.spend_commitment_draws d join public.income_expense_items i on i.id=d.income_expense_item_id
                           where i.income_expense_type_id=$1 and d.kind<>'RELEASE'`, [tienNha])).rows[0].n;
    await asUser(OWNER, () => q(`select public.set_income_expense_type_spend_rule_v1($1, 'CAM_KET', null)`, [tienNha]));
    const nCk = (await q(`select count(*)::int n from app_private.spend_commitment_draws d join public.income_expense_items i on i.id=d.income_expense_item_id
                           where i.income_expense_type_id=$1 and d.kind<>'RELEASE'`, [tienNha])).rows[0].n;
    ok('G: TUNG_PHIEU → nha het; CAM_KET lai → keo lai', nTp === 0 && nCk > 0, 'TUNG_PHIEU con ' + nTp + ', CAM_KET lai ' + nCk);
    await q('SAVEPOINT g2');
    try { await asUser(mgr[0], () => q(`select public.set_income_expense_type_spend_rule_v1($1, 'TUNG_PHIEU', null)`, [tienNha])); ok('G: thanh vien doi luat phai bi chan', false, 'lot'); }
    catch (e) { ok('G: thanh vien doi luat qua RPC → 42501', e.code === '42501', e.message.slice(0, 80)); }
    await q('ROLLBACK TO SAVEPOINT g2');

    // H. cổng: SHADOW ⇒ không áp; ON + công tắc ⇒ áp; công tắc TRAN thiếu trần ⇒ chặn
    const gate = async (uid, soTien) => asUser(uid, async () => (await q(`select app_private.ie_spend_gate_v1($1,$2,'EXPENSE','create_income_expense_v1',null,$3,'2026-12-05'::date,
        jsonb_build_array(jsonb_build_object('type_id',$4::text,'amount',$5::numeric,'start_date','2026-12-01','end_date','2026-12-31'))) g`,
      [ORG, bld.building_id, acc.id, tienNha, soTien])).rows[0].g).catch(async (e) => {
        // authenticated không gọi được app_private — cổng chỉ để writer definer gọi; thử bằng postgres
        await q('RESET ROLE');
        await q(`select set_config('request.jwt.claims', $1, true)`, [jwt(uid)]);
        return (await q(`select app_private.ie_spend_gate_v1($1,$2,'EXPENSE','create_income_expense_v1',null,$3,'2026-12-05'::date,
          jsonb_build_array(jsonb_build_object('type_id',$4::text,'amount',$5::numeric,'start_date','2026-12-01','end_date','2026-12-31'))) g`,
          [ORG, bld.building_id, acc.id, tienNha, soTien])).rows[0].g;
      });
    const g1 = await gate(OWNER, 1000);
    ok('H: SHADOW — cong khong ap', g1.enforce === false && g1.route === 'SHADOW', JSON.stringify({ enforce: g1.enforce, route: g1.route, status: g1.status, reason: g1.reason }));
    await q('SAVEPOINT h');
    await q(`update app_private.server_feature_flags set mode='ON', commit_sha='test', migration_sha256='test', maintenance_window_id='test', approval_reference='test' where feature_key='spend.engine.v1'`);
    const sw = await asUser(OWNER, async () => (await q(`select public.set_spend_policy_switch_v1($1, 'tien_nha', '2026-10-01', null, $2, true, 'thử') r`, [ORG, bld.building_id])).rows[0].r);
    const g2 = await gate(OWNER, 1000);
    ok('H: ON + cong tac → cong AP, trong cam ket → DUYET', g2.enforce === true && g2.status === 'APPROVED', JSON.stringify({ enforce: g2.enforce, status: g2.status, reason: g2.reason, sw }));
    const g3 = await gate(OWNER, 999999999);
    ok('H: ON + vuot → cong AP, CHO (ke ca chu co quyen duyet)', g3.enforce === true && g3.status === 'UNAPPROVED' && g3.reason === 'OVER_COMMITMENT', JSON.stringify({ enforce: g3.enforce, status: g3.status, reason: g3.reason }));
    try { await asUser(OWNER, () => q(`select public.set_spend_policy_switch_v1($1, 'nuoc', '2026-10-01', null, null, true, null)`, [ORG])); ok('H: bat TRAN nuoc thieu tran phai bi chan', false, 'lot'); }
    catch (e) { ok('H: bat TRAN nuoc khi con toa thieu tran → 55000 (cau 03)', e.code === '55000', e.message.slice(0, 140)); }
    await q('ROLLBACK TO SAVEPOINT h');

    // I. RPC chủ: báo cáo bóng + dấu vết tự duyệt; anon/thành viên bị chặn
    await flushShadow();
    const rp = await asUser(OWNER, async () => (await q(`select count(*)::int n, count(*) filter (where not match)::int lech from public.spend_shadow_report_v1($1, null, null)`, [ORG])).rows[0]);
    ok('I: bao cao bong cho chu doc duoc (A, B, C, G + E neu co)', rp.n >= 4, JSON.stringify(rp));
    const sa2 = await asUser(OWNER, async () => (await q(`select count(*)::int n from public.list_self_approved_vouchers_v1($1, '2026-01-01', '2027-12-31')`, [ORG])).rows[0]);
    ok('I: dau vet tu duyet loc duoc', sa2.n >= 1, JSON.stringify(sa2));
    await q('SAVEPOINT i');
    try { await asUser(mgr[0], () => q(`select * from public.spend_shadow_report_v1($1, null, null)`, [ORG])); ok('I: thanh vien doc bao cao bong phai bi chan', false, 'lot'); }
    catch (e) { ok('I: thanh vien doc bao cao bong → 42501', e.code === '42501', ''); }
    await q('ROLLBACK TO SAVEPOINT i');

    // J. kết thúc: audit 0 lệch, không lỗi máy
    const au1 = (await q(`select app_private.spend_ledger_audit_v1(null) a`)).rows[0].a;
    ok('J: audit cuoi = 0 lech', au1.lech_thieu === 0 && au1.lech_thua === 0, JSON.stringify(au1));
    const er = (await q(`select context, sqlstate, message from app_private.spend_engine_errors order by id`)).rows;
    ok('J: khong co loi may', er.length === 0, JSON.stringify(er).slice(0, 400));
  } catch (e) {
    console.error('\n>>> LOI <<<\n' + e.message + (e.position ? ' @' + e.position : '') + (e.where ? '\n' + e.where : ''));
    ok('chay tron', false, e.message.slice(0, 200));
  } finally { await q('ROLLBACK'); await c.end(); }
  const hong = KQ.filter(x => !x.dat).length;
  console.log('\n' + (KQ.length - hong) + '/' + KQ.length + ' ca DAT · da ROLLBACK — TEST khong con dau vet.');
  fs.writeFileSync(path.join(__dirname, 'thu-G2-G4-tren-TEST.json'), JSON.stringify({ chay_luc: new Date().toISOString(), migration_qua: chayQua, ket_qua: KQ }, null, 1), 'utf8');
  process.exit(chayQua && hong === 0 ? 0 : 1);
})().catch((e) => { console.error('THAT BAI:', e.message); process.exit(1); });
