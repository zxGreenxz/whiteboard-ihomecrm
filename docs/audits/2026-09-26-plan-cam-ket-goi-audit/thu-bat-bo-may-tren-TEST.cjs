// Thử migration BẬT bộ máy chi (20260926172614) trên TEST, transaction rồi ROLLBACK.
const fs = require('fs'); const path = require('path'); const pg = require('pg');
const REPO = 'C:/Users/Nguyen Tam/whiteboard-ihomecrm-main';
const WT = path.resolve(__dirname, '../../..');
const MIG = (f) => path.join(WT, 'supabase/migrations', f);
const FILES = ['20260926082454_bang_cam_ket_chi.sql', '20260926113435_anh_xa_hang_muc_va_khoa_cot_luat.sql',
  '20260926140000_va_guard_cot_luat_chi_canh_ghi_truc_tiep.sql', '20260926150000_bo_may_chi_so_tieu_va_quyet_dinh_bong.sql',
  '20260926160000_noi_writer_vao_bo_may_chi.sql', '20260926170000_bo_may_chi_trang_thai_va_canh_bao_so.sql',
  '20260926170100_bao_cao_bong_v2_tra_v1_ve_kieu_goc.sql', '20260926172614_bat_bo_may_chi_ap_dung_sua_cong_an.sql'];
const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const T405 = 'e823da47-9ec3-4c31-aa63-5cabc58b80b9';
pg.types.setTypeParser(1082, (v) => v);
const t = fs.readFileSync(path.join(REPO, 'CLAUDE.local.md'), 'utf8');
const strip = (f) => fs.readFileSync(f, 'utf8').replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '');
const jwt = (uid) => JSON.stringify({ sub: uid, role: 'authenticated' });
const KQ = []; const ok = (ten, dat, ct) => { KQ.push({ ten, dat, ct }); console.log((dat ? '  ĐẠT ' : '  HỎNG') + '  ' + ten + (ct ? '  — ' + ct : '')); };

(async () => {
  const c = new pg.Client({ host: t.match(/TEST_SUPABASE_POOLER_HOST=(\S+)/)[1], port: 5432, database: 'postgres',
    user: 'postgres.' + t.match(/TEST_SUPABASE_REF=(\S+)/)[1], password: t.match(/TEST_SUPABASE_DB_PASSWORD=(\S+)/)[1],
    ssl: { rejectUnauthorized: false }, statement_timeout: 300000 });
  await c.connect();
  const notices = []; c.on('notice', (n) => notices.push(n.message));
  const q = (s, p) => c.query(s, p);
  const asUser = async (uid, fn) => {
    await q('SAVEPOINT u');
    try { await q(`select set_config('request.jwt.claims', $1, true)`, [jwt(uid)]); await q('SET LOCAL ROLE authenticated');
      const r = await fn(); await q('RESET ROLE'); await q('RELEASE SAVEPOINT u'); return r; }
    catch (e) { await q('ROLLBACK TO SAVEPOINT u'); throw e; }
  };
  await q('BEGIN');
  let qua = false;
  try {
    for (const f of FILES) await q(strip(MIG(f)));
    await q(strip(MIG(FILES[7])));   // lượt hai của migration bật
    qua = true; console.log('ap du chuoi + luot hai migration bat: qua');
    notices.filter(n => /405PVB|Sổ tiêu/.test(n)).forEach(n => console.log('   NOTICE: ' + n));

    const f1 = (await q(`select public.fee_type_matches('cong_an','CA','Làm tạm trú') tam_tru, public.fee_type_matches('cong_an','CA','Tiền công an') cong_an`)).rows[0];
    ok('fee_type_matches: tam tru KHONG, tien cong an CO', f1.tam_tru === false && f1.cong_an === true, JSON.stringify(f1));
    const ca = (await q(`select count(*) filter (where amount=500000)::int n500, count(*) filter (where amount=7000)::int n7k
        from app_private.spend_commitments where building_id=$1 and fee_category='cong_an' and status='PUBLISHED'`, [T405])).rows[0];
    const gy = (await q(`select default_amount::numeric g from public.building_fee_accounts where building_id=$1 and fee_category='cong_an' and deleted_at is null`, [T405])).rows[0];
    ok('405PVB cong an: 12 thang 500.000d, het 7.000d, goi y 500.000d', ca.n500 === 12 && ca.n7k === 0 && Number(gy.g) === 500000, JSON.stringify({ ca, gy }));
    const ql = (await q(`select count(distinct building_id)::int toa, count(*)::int dong from app_private.spend_commitments
        where organization_id=$1 and fee_category='quan_ly' and status='PUBLISHED'`, [ORG])).rows[0];
    ok('quan ly: cam ket tu phieu dinh ky (>= 1 toa)', ql.toa >= 1, JSON.stringify(ql));
    const tran = (await q(`select b.name, v.utility_type, v.ceiling_amount::numeric tran from app_private.utility_ceiling_versions v
        join public.buildings b on b.id=v.building_id where v.note like 'Câu 03%' order by 1,2`)).rows;
    console.log('   tran moi: ' + JSON.stringify(tran));
    const sw = (await q(`select count(*) filter (where building_id is null)::int cam_ket, count(*) filter (where building_id is not null)::int tran
        from app_private.spend_policy_switches where organization_id=$1 and retired_at is null`, [ORG])).rows[0];
    ok('cong tac: 7 hang muc cam ket + dien nuoc theo toa', sw.cam_ket === 7 && sw.tran > 0, JSON.stringify(sw));
    const rt = (await q(`select app_private.spend_route_v1($1) r1, app_private.evaluate_feature_route('spend.cashbook_chi.v1',$1) r2,
        app_private.spend_route_v1('dddd0000-0000-4000-8000-000000000001') demo`, [ORG])).rows[0];
    ok('co: ca hai CANONICAL', rt.r1 === 'CANONICAL' && rt.r2 === 'CANONICAL', JSON.stringify(rt));

    // hành vi thật
    const SA = (await q(`select s.user_id from public.super_admins s join public.organization_memberships m on m.user_id=s.user_id
                          where m.organization_id=$1 and m.status='ACTIVE' order by 1 limit 1`, [ORG])).rows[0].user_id;
    const types = Object.fromEntries((await q(`select fee_category, id from public.income_expense_types where organization_id=$1 and fee_category is not null`, [ORG])).rows.map(r => [r.fee_category, r.id]));
    const bld = (await q(`select c.building_id, c.amount::numeric amount from app_private.spend_commitments c join public.buildings b on b.id=c.building_id
        where c.organization_id=$1 and c.fee_category='tien_nha' and c.period_month='2026-11-01' and c.status='PUBLISHED'
          and exists (select 1 from app_private.spend_commitments q where q.building_id=c.building_id and q.fee_category='quan_ly' and q.status='PUBLISHED')
        order by c.amount desc limit 1`, [ORG])).rows[0];
    let QL = null;
    for (const r of (await q(`select m.user_id from public.organization_memberships m where m.organization_id=$1 and m.status='ACTIVE'
        and not exists (select 1 from public.super_admins s where s.user_id=m.user_id) and not app_private.ie_actor_is_company_owner_v1($1, m.user_id) order by 1`, [ORG])).rows) {
      await q(`select set_config('request.jwt.claims', $1, true)`, [jwt(r.user_id)]);
      const x = (await q(`select app_private.ie_maker_can_approve_v1($1) d, app_private.authorize_income_expense_on_building($2,$3,'create',$1) t`, [bld.building_id, r.user_id, ORG])).rows[0];
      if (x.t && !x.d) { QL = r.user_id; break; }
    }
    const soQL = (await q(`select a.id from public.accounts a where a.organization_id=$1 and a.deleted_at is null and not coalesce(a.is_virtual,false)
        and (a.user_id=$2 or exists (select 1 from public.cashbook_possession_bindings b join public.organization_memberships m on m.id=b.membership_id
          where b.cashbook_id=a.id and m.user_id=$2 and m.status='ACTIVE' and b.valid_to is null and b.possession_kind in ('CUSTODIAN','OPERATOR'))) limit 1`, [ORG, QL])).rows[0].id;
    const soSA = (await q(`select a.id from public.income_expenses e join public.accounts a on a.id=e.account_id
        where e.building_id=$1 and e.type='EXPENSE' and e.deleted_at is null and a.deleted_at is null and not coalesce(a.is_virtual,false)
        group by a.id order by count(*) desc limit 1`, [bld.building_id])).rows[0].id;
    const tay = (uid, so, type, soTien, thang, ten) => asUser(uid, async () => (await q(`
      select (public.create_income_expense_v1('EXPENSE', $1::text, $2::uuid, null, null, null, null, null, null, $3::uuid, '[]'::jsonb, true, null, $4::date,
        jsonb_build_array(jsonb_build_object('income_expense_type_id', $5::text, 'description', 'bat', 'quantity', 1, 'unit_price', $6::numeric,
          'start_date', $4::text, 'end_date', (($4::date + interval '1 month') - interval '1 day')::date::text)), $7::text)).*`,
      [ten, bld.building_id, so, thang, type, soTien, 'bat-' + Math.random().toString(36).slice(2)])).rows[0]);
    const a = await tay(QL, soQL, types.tien_nha, 700000, '2026-11-01', 'Bật A tiền nhà trong cam kết');
    ok('A: quan ly tien nha T11 trong cam ket, tren nguong → MAY DUYET', a.approval_status === 'APPROVED', a.approval_status);
    const b = await tay(SA, soSA, types.tien_nha, Number(bld.amount) + 1000000, '2026-12-01', 'Bật B vượt');
    ok('B: nguoi co quyen duyet vuot cam ket → CHO', b.approval_status === 'UNAPPROVED', b.approval_status);
    const cqm = (await q(`select amount::numeric a from app_private.spend_commitments where building_id=$1 and fee_category='quan_ly' and period_month='2027-01-01' and status='PUBLISHED'`, [bld.building_id])).rows[0];
    // Quản Lý là hạng mục HẠN CHẾ (quản lý thường không lập được — phân quyền sẵn có) ⇒ thử bằng tài khoản có quyền
    const cql = await tay(SA, soSA, types.quan_ly, Number(cqm.a), '2027-01-01', 'Bật C quản lý đúng cam kết');
    ok('C: khoan quan ly dung cam ket (tu phieu dinh ky) → DUYET', cql.approval_status === 'APPROVED', cql.approval_status + ' cam ket ' + cqm.a);
    const cql2 = await tay(SA, soSA, types.quan_ly, 100000, '2027-01-01', 'Bật C2 quản lý thêm cùng tháng');
    ok('C2: them khoan quan ly cung thang (cam ket da het) → CHO, ke ca nguoi co quyen duyet', cql2.approval_status === 'UNAPPROVED', cql2.approval_status);
    const d = await tay(QL, soQL, types.tien_nha, 700000, '2026-09-01', 'Bật D tháng 9 chưa có cam kết');
    ok('D: tien nha thang 9 (chua bat, chua cam ket) → luat cu (quan ly tren nguong → CHO)', d.approval_status === 'UNAPPROVED', d.approval_status);

    const au = (await q(`select app_private.spend_ledger_audit_v1(null) a`)).rows[0].a;
    ok('audit so tieu 0 lech', au.lech_thieu === 0 && au.lech_thua === 0, JSON.stringify(au));
    const er = (await q(`select count(*)::int n from app_private.spend_engine_errors`)).rows[0].n;
    ok('0 loi may', er === 0, String(er));
  } catch (e) {
    console.error('LOI: ' + e.message + (e.where ? '\n' + e.where : '')); ok('chay tron', false, e.message.slice(0, 200));
  } finally { await q('ROLLBACK'); await c.end(); }
  const hong = KQ.filter(x => !x.dat).length;
  console.log('\n' + (KQ.length - hong) + '/' + KQ.length + ' ca DAT · da ROLLBACK — TEST khong con dau vet.');
  fs.writeFileSync(path.join(__dirname, 'thu-bat-bo-may-tren-TEST.json'), JSON.stringify({ chay_luc: new Date().toISOString(), migration_qua: qua, ket_qua: KQ }, null, 1), 'utf8');
  process.exit(qua && hong === 0 ? 0 : 1);
})().catch((e) => { console.error('THAT BAI:', e.message); process.exit(1); });
