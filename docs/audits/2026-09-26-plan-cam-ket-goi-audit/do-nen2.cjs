// Vòng 2: bù các câu lỗi vòng 1 + chi tiết cho plan. CHỈ ĐỌC.
const fs = require('fs');
const path = require('path');
const pg = require('pg');
const { Client } = pg;
const REPO = 'C:/Users/Nguyen Tam/whiteboard-ihomecrm-main';
const REF = 'tryymsxyyckgbrmmvozx';
const ORG = 'aaaa0000-0000-4000-8000-000000000001';
pg.types.setTypeParser(1082, (v) => v);

function docPassword() {
  const txt = fs.readFileSync(path.join(REPO, 'CLAUDE.local.md'), 'utf8');
  const m = txt.match(/Persistent database password[^`]*`([^`]+)`/);
  if (!m) throw new Error('khong tim thay password');
  return m[1];
}

const QUERIES = [
  ['tran-dien-nuoc-dong', `select count(*) so_dong from app_private.utility_ceiling_versions`],

  ['cot-accounts-balance', `
    select string_agg(column_name, ', ' order by ordinal_position) cot
      from information_schema.columns
     where table_schema='public' and table_name='accounts_with_balance'`],

  ['cot-co-tuyen', `
    select string_agg(column_name, ', ' order by ordinal_position) cot
      from information_schema.columns
     where table_schema='app_private' and table_name='server_feature_flags'`],

  ['so-quy-am', `
    select count(*) so_so, coalesce(sum(b.current_amount),0)::numeric tong
      from public.accounts_with_balance b
      join public.accounts a on a.id = b.id
     where b.current_amount < 0 and a.organization_id = '${ORG}'`],

  // hạng mục: 9 khoá của trang Thanh toán khớp được mấy dòng income_expense_types?
  ['hang-muc-trung-nang-nhat', `
    select lower(btrim(name)) ten, type, count(*) so_ban_sao
      from public.income_expense_types
     group by 1,2 having count(*) > 1
     order by count(*) desc, 1 limit 12`],

  // phiếu định kỳ tự duyệt 90 ngày
  ['phieu-dinh-ky-90-ngay', `
    select count(*) so_phieu, coalesce(sum(ie.total_amount),0)::numeric tong,
           count(*) filter (where ie.approval_status='APPROVED') da_duyet
      from public.income_expenses ie
     where ie.organization_id='${ORG}' and ie.deleted_at is null
       and ie.repeat_parent_id is not null
       and ie.created_at > now() - interval '90 days'`],

  // các cửa ghi phiếu đang sống: đếm theo nhãn nguồn 90 ngày
  ['nguon-phieu-90-ngay', `
    select coalesce(ie.system_source,'(khong nhan)') nguon,
           count(*) so_phieu,
           count(*) filter (where ie.approval_status='UNAPPROVED') cho_duyet
      from public.income_expenses ie
     where ie.organization_id='${ORG}' and ie.deleted_at is null
       and ie.created_at > now() - interval '90 days'
     group by 1 order by 2 desc limit 15`],
];

(async () => {
  const client = new Client({
    host: 'aws-1-ap-southeast-1.pooler.supabase.com', port: 5432, database: 'postgres',
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
  fs.writeFileSync('do-nen2-ket-qua.json', JSON.stringify(out, null, 1), 'utf8');
  console.log('\nda ghi do-nen2-ket-qua.json');
})().catch((e) => { console.error('THAT BAI:', e.message); process.exit(1); });
