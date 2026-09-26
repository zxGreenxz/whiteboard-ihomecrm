// TEST, ROLLBACK: áp G1..G2G4 rồi thử câu ghi kiểu PostgREST (CTE) + nhiều CTE cùng bảng lên income_expense_items.
const fs = require('fs'); const path = require('path'); const pg = require('pg');
const REPO = 'C:/Users/Nguyen Tam/whiteboard-ihomecrm-main';
const t = fs.readFileSync(path.join(REPO, 'CLAUDE.local.md'), 'utf8');
const ref = t.match(/TEST_SUPABASE_REF=(\S+)/)[1], pwd = t.match(/TEST_SUPABASE_DB_PASSWORD=(\S+)/)[1], host = t.match(/TEST_SUPABASE_POOLER_HOST=(\S+)/)[1];
const strip = (f) => fs.readFileSync(path.join(REPO, 'supabase/migrations', f), 'utf8').replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '');
(async () => {
  const c = new pg.Client({ host, port: 5432, database: 'postgres', user: 'postgres.' + ref, password: pwd, ssl: { rejectUnauthorized: false } });
  await c.connect(); await c.query('BEGIN');
  try {
    for (const f of ['20260926082454_bang_cam_ket_chi.sql', '20260926113435_anh_xa_hang_muc_va_khoa_cot_luat.sql',
      '20260926140000_va_guard_cot_luat_chi_canh_ghi_truc_tiep.sql', '20260926150000_bo_may_chi_so_tieu_va_quyet_dinh_bong.sql']) await c.query(strip(f));
    // một dòng hạng mục CHI của phiếu CHỜ DUYỆT (sửa được) có hạng mục CAM_KET, và một dòng bất kỳ
    const it = (await c.query(`select i.id, i.income_expense_id from public.income_expense_items i join public.income_expenses e on e.id=i.income_expense_id
        where e.type='EXPENSE' and e.approval_status='UNAPPROVED' and e.deleted_at is null order by e.created_at desc limit 1`)).rows[0];
    const tests = [
      ['CTE UPDATE (kiểu PostgREST PATCH)', `with pgrst_source as (update public.income_expense_items set description = coalesce(description,'') where id = '${it.id}' returning 1) select count(*) from pgrst_source`],
      ['CTE INSERT (kiểu PostgREST POST)', `with pgrst_source as (insert into public.income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price)
          select income_expense_id, income_expense_type_id, 'thu cte', 1, 1000 from public.income_expense_items where id='${it.id}' returning 1) select count(*) from pgrst_source`],
      ['hai CTE ghi cùng bảng', `with a as (update public.income_expense_items set description = coalesce(description,'') where id = '${it.id}' returning income_expense_id),
          b as (update public.income_expense_items set notes = notes where income_expense_id in (select income_expense_id from a) returning 1) select count(*) from b`],
      ['CTE DELETE (kiểu PostgREST DELETE)', `with pgrst_source as (delete from public.income_expense_items where description='thu cte' and income_expense_id='${it.income_expense_id}' returning 1) select count(*) from pgrst_source`],
    ];
    for (const [ten, sql] of tests) {
      await c.query('SAVEPOINT s');
      try { const r = await c.query(sql); await c.query('RELEASE SAVEPOINT s'); console.log('  ĐẠT  ' + ten + ' → ' + JSON.stringify(r.rows[0])); }
      catch (e) { await c.query('ROLLBACK TO SAVEPOINT s'); console.log('  LỖI  ' + ten + ' → ' + e.code + ' ' + e.message.slice(0, 160)); }
    }
    const er = (await c.query(`select context, sqlstate, message from app_private.spend_engine_errors`)).rows;
    console.log('loi may ghi lai: ' + JSON.stringify(er));
  } finally { await c.query('ROLLBACK'); await c.end(); }
})().catch((e) => { console.error('THAT BAI:', e.message); process.exit(1); });
