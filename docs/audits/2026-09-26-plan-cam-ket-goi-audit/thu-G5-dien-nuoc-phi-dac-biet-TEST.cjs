// Thử G5 cho 2 cửa còn lại trên TEST (transaction rồi ROLLBACK): pay_utility_bill (kiểu TRẦN) và
// generate_special_fees_v1 (sinh phí hàng loạt). SHADOW: y cũ + đúng hạng mục ánh xạ. ON: dưới trần duyệt, vượt chờ.
const fs = require('fs'); const path = require('path'); const pg = require('pg');
const REPO = 'C:/Users/Nguyen Tam/whiteboard-ihomecrm-main';
const MIG = (f) => path.join(REPO, 'supabase/migrations', f);
const FILES = ['20260926082454_bang_cam_ket_chi.sql', '20260926113435_anh_xa_hang_muc_va_khoa_cot_luat.sql',
  '20260926140000_va_guard_cot_luat_chi_canh_ghi_truc_tiep.sql', '20260926150000_bo_may_chi_so_tieu_va_quyet_dinh_bong.sql',
  '20260926160000_noi_writer_vao_bo_may_chi.sql'];
const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const OWNER = '0520169e-0860-4b4e-a603-675c8aa245aa';
pg.types.setTypeParser(1082, (v) => v);
const t = fs.readFileSync(path.join(REPO, 'CLAUDE.local.md'), 'utf8');
const strip = (f) => fs.readFileSync(f, 'utf8').replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '');
const jwt = (uid) => JSON.stringify({ sub: uid, role: 'authenticated' });
const KQ = []; const ok = (ten, dat, chiTiet) => { KQ.push({ ten, dat, chiTiet }); console.log((dat ? '  ĐẠT ' : '  HỎNG') + '  ' + ten + (chiTiet ? '  — ' + chiTiet : '')); };

(async () => {
  const c = new pg.Client({ host: t.match(/TEST_SUPABASE_POOLER_HOST=(\S+)/)[1], port: 5432, database: 'postgres',
    user: 'postgres.' + t.match(/TEST_SUPABASE_REF=(\S+)/)[1], password: t.match(/TEST_SUPABASE_DB_PASSWORD=(\S+)/)[1],
    ssl: { rejectUnauthorized: false }, statement_timeout: 300000 });
  await c.connect();
  const q = (sql, p) => c.query(sql, p);
  const asUser = async (uid, fn) => {
    await q('SAVEPOINT u');
    try {
      await q(`select set_config('request.jwt.claims', $1, true)`, [jwt(uid)]); await q('SET LOCAL ROLE authenticated');
      const r = await fn(); await q('RESET ROLE'); await q('RELEASE SAVEPOINT u'); return r;
    } catch (e) { await q('ROLLBACK TO SAVEPOINT u'); throw e; }
  };
  await q('BEGIN');
  try {
    for (const f of FILES) await q(strip(MIG(f)));
    const SA = (await q(`select s.user_id from public.super_admins s join public.organization_memberships m on m.user_id=s.user_id
                          where m.organization_id=$1 and m.status='ACTIVE' order by 1 limit 1`, [ORG])).rows[0].user_id;
    const typeDien = (await q(`select id from public.income_expense_types where organization_id=$1 and fee_category='dien'`, [ORG])).rows[0].id;
    // toà có trần ĐIỆN và có công tơ điện khai trong building_utility_accounts
    const b = (await q(`
      select b.id, b.name, u.id meter
        from public.buildings b
        join public.building_utility_accounts u on u.building_id=b.id and u.utility_type='ELECTRIC' and u.deleted_at is null
       where b.organization_id=$1 and b.deleted_at is null
         and (app_private.utility_ceiling_check_v1($1, b.id, 'ELECTRIC', date '2027-03-01', 0)->>'verdict') <> 'NO_RULE'
       order by b.name, u.created_at limit 1`, [ORG])).rows[0];
    const tran = Number((await q(`select ceiling_amount from app_private.utility_ceiling_versions where organization_id=$1 and utility_type='ELECTRIC'
        and status='PUBLISHED' and (building_id=$2 or building_id is null) order by (building_id is not null) desc, effective_from_month desc limit 1`, [ORG, b.id])).rows[0].ceiling_amount);
    const acc = (await q(`select a.id from public.income_expenses e join public.accounts a on a.id=e.account_id
       where e.building_id=$1 and e.type='EXPENSE' and e.deleted_at is null and a.deleted_at is null and not coalesce(a.is_virtual,false)
       group by a.id order by count(*) desc limit 1`, [b.id])).rows[0].id;
    console.log('toa ' + b.name + ' · tran dien ' + tran);
    const dien = (soTien, ky) => asUser(SA, async () => (await q(`select public.pay_utility_bill($1::uuid, 'ELECTRIC', $2::numeric, $3::text, '2027-03-10'::date, null, null, $4::uuid, null, $5::uuid) r`,
      [b.id, soTien, ky, acc, b.meter])).rows[0].r);

    // SHADOW
    const u1 = await dien(Math.min(500000, tran - 1), '2027-03');
    const u1s = (await q(`select e.approval_status, i.income_expense_type_id t from public.income_expenses e join public.income_expense_items i on i.income_expense_id=e.id where e.id=$1`, [u1.voucher_id])).rows[0];
    ok('D1 SHADOW: dong dien duoi tran → dung hang muc da anh xa (dien), luat cu', u1s.t === typeDien && u1.spendDecision && u1.spendDecision.enforce === false,
      JSON.stringify({ st: u1s.approval_status, ceiling: u1.ceilingVerdict, sd: u1.spendDecision && { enforce: u1.spendDecision.enforce, status: u1.spendDecision.status, reason: u1.spendDecision.reason } }));
    // ON + công tắc điện cho toà này
    await q(`update app_private.server_feature_flags set mode='ON', commit_sha='test', migration_sha256='test', maintenance_window_id='test', approval_reference='test' where feature_key='spend.engine.v1'`);
    await asUser(OWNER, () => q(`select public.set_spend_policy_switch_v1($1, 'dien', '2026-10-01', null, $2, true, 'thử')`, [ORG, b.id]));
    const u2 = await dien(Math.max(1000, Math.floor(tran / 2)), '2027-04');
    const u2s = (await q(`select approval_status from public.income_expenses where id=$1`, [u2.voucher_id])).rows[0].approval_status;
    ok('D2 ON: duoi tran → MAY DUYET (UNDER_CEILING)', u2s === 'APPROVED' && u2.spendDecision.enforce === true && u2.spendDecision.reason === 'UNDER_CEILING', JSON.stringify({ u2s, sd: { e: u2.spendDecision.enforce, r: u2.spendDecision.reason } }));
    const u3 = await dien(tran + 100000, '2027-05');
    const u3s = (await q(`select approval_status, notes from public.income_expenses where id=$1`, [u3.voucher_id])).rows[0];
    ok('D3 ON: vuot tran → CHO (OVER_CEILING) + ghi chu [VUOT TRAN] giu nguyen', u3s.approval_status === 'UNAPPROVED' && u3.spendDecision.reason === 'OVER_CEILING' && /VƯỢT TRẦN/.test(u3s.notes), JSON.stringify({ st: u3s.approval_status, r: u3.spendDecision.reason }));

    // generate_special_fees_v1: kỳ 2027-03 cho toà có phí cố định
    const r = await asUser(SA, async () => (await q(`select public.generate_special_fees_v1('2027-03', array[$1::uuid], $2, $3::uuid) r`,
      [b.id, 'thu-g5-special-' + Math.random().toString(36).slice(2, 10), acc])).rows[0].r).catch(e => ({ loi: e.message }));
    if (r.loi) ok('S1: generate_special_fees_v1 chay', false, r.loi.slice(0, 200));
    else {
      const ids = r.voucherIds || [];
      const lech = ids.length ? (await q(`select count(*)::int n from public.income_expense_items i join public.income_expenses e on e.id=i.income_expense_id
          join app_private.spend_decisions d on false where true`)).rows[0].n : 0;
      const types = ids.length ? (await q(`select t.fee_category, t.name from public.income_expense_items i join public.income_expense_types t on t.id=i.income_expense_type_id
          where i.income_expense_id = any($1::uuid[])`, [ids])).rows : [];
      ok('S1: generate_special_fees_v1 chay, dung hang muc da anh xa', types.every(x => x.fee_category !== null), JSON.stringify({ created: r.created, posted: r.posted, types }));
    }
    const au = (await q(`select app_private.spend_ledger_audit_v1(null) a`)).rows[0].a;
    ok('Z: audit so tieu 0 lech', au.lech_thieu === 0 && au.lech_thua === 0, JSON.stringify(au));
    const er = (await q(`select context, sqlstate, message from app_private.spend_engine_errors`)).rows;
    ok('Z: 0 loi may', er.length === 0, JSON.stringify(er).slice(0, 300));
  } catch (e) {
    console.error('LOI: ' + e.message + (e.where ? '\n' + e.where : '')); ok('chay tron', false, e.message.slice(0, 200));
  } finally { await q('ROLLBACK'); await c.end(); }
  const hong = KQ.filter(x => !x.dat).length;
  console.log((KQ.length - hong) + '/' + KQ.length + ' ca DAT · da ROLLBACK.');
  fs.writeFileSync(path.join(__dirname, 'thu-G5-dien-nuoc-phi-dac-biet-TEST.json'), JSON.stringify({ chay_luc: new Date().toISOString(), ket_qua: KQ }, null, 1), 'utf8');
  process.exit(hong === 0 ? 0 : 1);
})().catch((e) => { console.error('THAT BAI:', e.message); process.exit(1); });
