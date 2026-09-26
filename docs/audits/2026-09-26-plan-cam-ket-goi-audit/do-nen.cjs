// Đo nền cho plan 26/09 — CHỈ ĐỌC, BEGIN READ ONLY … ROLLBACK, mỗi câu một SAVEPOINT
// nên một câu hỏng không làm chết các câu sau.
// Mật khẩu script tự đọc từ CLAUDE.local.md, không bao giờ nằm trên dòng lệnh.
const fs = require('fs');
const path = require('path');
const pg = require('pg');
const { Client } = pg;

const REPO = 'C:/Users/Nguyen Tam/whiteboard-ihomecrm-main';
const REF = 'tryymsxyyckgbrmmvozx';
const ORG = 'aaaa0000-0000-4000-8000-000000000001';

pg.types.setTypeParser(1082, (v) => v); // DATE giữ nguyên chuỗi

function docPassword() {
  const txt = fs.readFileSync(path.join(REPO, 'CLAUDE.local.md'), 'utf8');
  const m = txt.match(/Persistent database password[^`]*`([^`]+)`/);
  if (!m) throw new Error('khong tim thay password trong CLAUDE.local.md');
  return m[1];
}

const QUERIES = [
  ['ket-noi', `select current_database() db, current_user usr,
                      to_char(now() at time zone 'Asia/Ho_Chi_Minh','YYYY-MM-DD HH24:MI') gio_vn`],

  // ── dò cấu trúc các bảng luật trước khi đếm ──
  ['cot-cac-bang-luat', `
    select table_schema||'.'||table_name t, string_agg(column_name, ', ' order by ordinal_position) cot
      from information_schema.columns
     where (table_schema, table_name) in (
             ('app_private','special_fee_price_versions'),
             ('app_private','utility_ceilings'),
             ('app_private','utility_ceiling_versions'),
             ('app_private','special_fee_claims'),
             ('app_private','self_approve_limits'))
     group by 1 order by 1`],

  ['bang-gia-so-dong', `
    select count(*) so_dong from app_private.special_fee_price_versions`],

  ['tran-dien-nuoc-so-dong', `
    select (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
             where n.nspname='app_private' and c.relname like 'utility_ceiling%') so_bang_tran`],

  ['han-muc-tu-duyet', `
    select count(*) so_dong from app_private.self_approve_limits`],

  ['hang-muc', `
    select count(*) tong_dong,
           count(*) filter (where force_approval) co_bat_buoc_duyet,
           count(distinct user_id) so_chu_so_huu,
           (select count(*) from (
              select lower(btrim(name)) n, type
                from public.income_expense_types
               group by 1,2 having count(*) > 1) t) so_nhom_trung_ten
      from public.income_expense_types`],

  ['phieu-cho-duyet', `
    select count(*) so_phieu,
           coalesce(sum(total_amount),0)::numeric tong_tien,
           count(*) filter (where created_at < now() - interval '30 days') treo_qua_30_ngay
      from public.income_expenses
     where approval_status = 'UNAPPROVED' and deleted_at is null
       and organization_id = '${ORG}'`],

  ['so-quy-am', `
    select count(*) so_so, coalesce(sum(current_amount),0)::numeric tong
      from public.accounts_with_balance
     where current_amount < 0 and organization_id = '${ORG}'`],

  ['khe-trung-tien-nha', `
    select count(*) so_khe from (
      select ie.building_id, date_trunc('month', it.start_date) ky
        from public.income_expenses ie
        join public.income_expense_items it on it.income_expense_id = ie.id
        join public.income_expense_types t on t.id = it.income_expense_type_id
       where ie.deleted_at is null and ie.approval_status <> 'CANCELLED'
         and ie.organization_id = '${ORG}'
         and lower(btrim(t.name)) like 'tiền nhà%'
         and it.start_date is not null
       group by 1,2 having count(*) > 1) x`],

  ['ai-doc-force-approval', `
    select p.pronamespace::regnamespace::text sch, p.proname
      from pg_proc p
     where p.prosrc like '%force_approval%'
       and p.pronamespace::regnamespace::text in ('public','app_private')
     order by 1,2`],

  ['phieu-phi-co-dinh-90-ngay', `
    select coalesce(system_source,'(khong nhan)') nguon, count(*) so_phieu,
           coalesce(sum(total_amount),0)::numeric tong
      from public.income_expenses
     where organization_id = '${ORG}' and deleted_at is null
       and created_at > now() - interval '90 days'
       and system_source in ('fixed_fee','utility.bill')
     group by 1 order by 1`],

  ['md5-ham-plan-nhac', `
    select p.pronamespace::regnamespace::text || '.' || p.proname fn,
           md5(pg_get_functiondef(p.oid)) md5,
           length(pg_get_functiondef(p.oid)) do_dai
      from pg_proc p
     where (p.pronamespace::regnamespace::text, p.proname) in (
             ('public','pay_period_fee'), ('public','pay_utility_bill'),
             ('public','create_income_expense_v1'), ('public','ie_compat_insert_v2'),
             ('public','approve_income_expense_v1'), ('public','approve_voucher'),
             ('app_private','special_fee_rule_check_v1'),
             ('app_private','special_fee_approve_and_post_v1'),
             ('app_private','utility_ceiling_check_v1'),
             ('public','generate_special_fees_v1'),
             ('public','update_cashbook_metadata_v1'),
             ('public','record_invoice_collection_v5'),
             ('public','revise_pending_income_expense_v1'),
             ('public','cancel_period_fee'), ('public','cancel_utility_bill'),
             ('public','update_period_fee'))
     order by 1`],

  ['co-tuyen-finance', `
    select flag_key, mode, force_freeze
      from app_private.server_feature_flags
     where flag_key like 'income_expense%' or flag_key like 'invoice.collection%'
     order by 1`],
];

(async () => {
  const client = new Client({
    host: 'aws-1-ap-southeast-1.pooler.supabase.com',
    port: 5432, database: 'postgres',
    user: 'postgres.' + REF, password: docPassword(),
    ssl: { rejectUnauthorized: false }, statement_timeout: 60000,
  });
  await client.connect();
  await client.query('BEGIN READ ONLY');
  const out = { do_luc: new Date().toISOString(), ket_qua: {} };
  for (const [name, sql] of QUERIES) {
    await client.query('SAVEPOINT s');
    try {
      const r = await client.query(sql);
      out.ket_qua[name] = r.rows;
      await client.query('RELEASE SAVEPOINT s');
      console.log('OK   ' + name.padEnd(26) + r.rows.length + ' dong');
    } catch (e) {
      out.ket_qua[name] = { loi: e.message.split('\n')[0] };
      await client.query('ROLLBACK TO SAVEPOINT s');
      console.log('LOI  ' + name.padEnd(26) + e.message.split('\n')[0]);
    }
  }
  await client.query('ROLLBACK');
  await client.end();
  fs.writeFileSync('do-nen-ket-qua.json', JSON.stringify(out, null, 1), 'utf8');
  console.log('\nda ghi do-nen-ket-qua.json');
})().catch((e) => { console.error('THAT BAI:', e.message); process.exit(1); });
