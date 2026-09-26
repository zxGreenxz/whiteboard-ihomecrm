// Thử G3 trên TEST trong transaction rồi ROLLBACK, kèm thử hành vi guard cột luật.
const fs = require('fs'); const path = require('path'); const pg = require('pg');
const REPO = 'C:/Users/Nguyen Tam/whiteboard-ihomecrm-main';
const FILE = path.join(REPO, 'supabase/migrations/20260926113435_anh_xa_hang_muc_va_khoa_cot_luat.sql');
const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const OWNER = '0520169e-0860-4b4e-a603-675c8aa245aa'; // nguyentam — chủ công ty
pg.types.setTypeParser(1082, (v) => v);

function cred() {
  const t = fs.readFileSync(path.join(REPO, 'CLAUDE.local.md'), 'utf8');
  return { ref: t.match(/TEST_SUPABASE_REF=(\S+)/)[1], pwd: t.match(/TEST_SUPABASE_DB_PASSWORD=(\S+)/)[1],
           host: t.match(/TEST_SUPABASE_POOLER_HOST=(\S+)/)[1] };
}
const jwt = (uid) => JSON.stringify({ sub: uid, role: 'authenticated' });

(async () => {
  const { ref, pwd, host } = cred();
  const strip = (f) => fs.readFileSync(f, 'utf8').replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '');
  const G1 = path.join(REPO, 'supabase/migrations/20260926082454_bang_cam_ket_chi.sql');
  let sql = strip(FILE);
  const c = new pg.Client({ host, port: 5432, database: 'postgres', user: 'postgres.' + ref, password: pwd,
    ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
  await c.connect(); console.log('da noi TEST ' + ref);
  const notices = []; c.on('notice', (n) => notices.push(n.message));
  await c.query('BEGIN');
  let ketQua = { chay: false, idem: false, guard_chu: 'chua thu', guard_thuong: 'chua thu' };
  try {
    await c.query(strip(G1));   // TEST chua co G1 — chay truoc trong cung transaction
    await c.query(sql);
    ketQua.chay = true;
    console.log('\n>>> G3 CHAY QUA <<<'); notices.forEach(n => console.log('   NOTICE: ' + n));

    const m = await c.query(`select o.name org, t.fee_category, t.name, t.spend_mode
      from public.income_expense_types t join public.organizations o on o.id=t.organization_id
      where t.fee_category is not null order by o.name, t.fee_category`);
    console.log('\n   anh xa:'); m.rows.forEach(r => console.log('     ' + r.org.padEnd(18) + r.fee_category.padEnd(11) + r.spend_mode.padEnd(11) + r.name));

    const tr = await c.query(`select count(*) n from pg_trigger where tgname='a05_ie_type_rule_columns_guard'`);
    console.log('\n   trigger a05 ton tai: ' + (tr.rows[0].n === '1' ? 'CO' : 'KHONG'));

    // luot hai
    const n1 = (await c.query(`select count(*) n from public.income_expense_types where fee_category is not null`)).rows[0].n;
    await c.query(sql);
    const n2 = (await c.query(`select count(*) n from public.income_expense_types where fee_category is not null`)).rows[0].n;
    ketQua.idem = n1 === n2; console.log('   luot hai: ' + n1 + ' -> ' + n2 + '  idempotent=' + (ketQua.idem ? 'DAT' : 'HONG'));

    // ---- thu guard: CHU sua spend_mode -> phai duoc ----
    const tienNha = (await c.query(`select id from public.income_expense_types where organization_id=$1 and fee_category='tien_nha'`, [ORG])).rows[0];
    await c.query('SAVEPOINT g1');
    try {
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [jwt(OWNER)]);
      await c.query('SET LOCAL ROLE authenticated');
      const u = await c.query(`update public.income_expense_types set spend_mode='TUNG_PHIEU' where id=$1`, [tienNha.id]);
      await c.query('RESET ROLE');
      ketQua.guard_chu = u.rowCount === 1 ? 'DUOC (dung)' : 'RLS an dong (' + u.rowCount + ' dong) - khong ket luan';
    } catch (e) { ketQua.guard_chu = 'BI CHAN ' + e.code + ' ' + e.message.slice(0, 80) + '  <-- SAI, chu phai duoc'; }
    await c.query('ROLLBACK TO SAVEPOINT g1');

    // ---- thu guard: thanh vien THUONG (khong owner, khong super) -> phai bi 42501 ----
    const th = (await c.query(`
      select m.user_id from public.organization_memberships m
      where m.organization_id=$1 and m.status='ACTIVE' and m.user_id<>$2
        and not exists (select 1 from public.super_admins s where s.user_id=m.user_id)
        and not app_private.ie_actor_is_company_owner_v1($1, m.user_id)
      limit 1`, [ORG, OWNER])).rows[0];
    if (!th) { ketQua.guard_thuong = 'khong tim thay thanh vien thuong de thu'; }
    else {
      await c.query('SAVEPOINT g2');
      try {
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [jwt(th.user_id)]);
        await c.query('SET LOCAL ROLE authenticated');
        const u = await c.query(`update public.income_expense_types set spend_mode='TUNG_PHIEU' where id=$1`, [tienNha.id]);
        await c.query('RESET ROLE');
        ketQua.guard_thuong = u.rowCount === 0 ? 'RLS an dong (0 dong) - khong ket luan duoc guard' : 'LOT QUA (' + u.rowCount + ' dong)  <-- SAI';
      } catch (e) { ketQua.guard_thuong = (e.code === '42501' ? 'BI CHAN 42501 (dung)' : 'loi khac ' + e.code) + ' — ' + e.message.slice(0, 90); }
      await c.query('ROLLBACK TO SAVEPOINT g2');
    }
  } catch (e) {
    console.error('\n>>> LOI <<<\n' + e.message + (e.position ? '  @' + e.position : ''));
  } finally {
    await c.query('ROLLBACK'); await c.end();
  }
  console.log('\n   guard — chu cong ty sua spend_mode : ' + ketQua.guard_chu);
  console.log('   guard — thanh vien thuong sua      : ' + ketQua.guard_thuong);
  console.log('\nda ROLLBACK — TEST khong con dau vet.');
  process.exit(ketQua.chay && ketQua.idem ? 0 : 1);
})().catch((e) => { console.error('THAT BAI:', e.message); process.exit(1); });
