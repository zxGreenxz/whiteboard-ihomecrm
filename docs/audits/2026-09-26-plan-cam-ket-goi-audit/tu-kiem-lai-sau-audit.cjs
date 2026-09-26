// Tự kiểm lại các phát hiện chặn của audit 26/09. CHỈ ĐỌC.
const fs = require('fs'); const path = require('path'); const pg = require('pg');
const REPO = 'C:/Users/Nguyen Tam/whiteboard-ihomecrm-main';
const REF = 'tryymsxyyckgbrmmvozx';
pg.types.setTypeParser(1082, (v) => v);
function docPassword() {
  const t = fs.readFileSync(path.join(REPO, 'CLAUDE.local.md'), 'utf8');
  const m = t.match(/Persistent database password[^`]*`([^`]+)`/);
  if (!m) throw new Error('khong tim thay password'); return m[1];
}

const Q = [
  // ── C1: nhóm trùng theo TỪNG org, không gộp ──
  ['C1-theo-org', `
    select coalesce(o.name,'(khong org)') org, count(*) so_dong,
           count(*) filter (where t.force_approval) co_co,
           count(distinct t.user_id) so_user
      from public.income_expense_types t
      left join public.organizations o on o.id = t.organization_id
     group by 1 order by 2 desc`],

  ['C1-trung-trong-org', `
    select count(*) so_nhom_trung_trong_org from (
      select organization_id, lower(btrim(name)) n, type
        from public.income_expense_types
       group by 1,2,3 having count(*) > 1) x`],

  ['C1-unique-index', `
    select indexname, indexdef from pg_indexes
     where schemaname='public' and tablename='income_expense_types'
       and indexdef ilike '%unique%'`],

  // ── P1: policy trên bảng hạng mục ──
  ['P1-policy', `
    select policyname, permissive, cmd, roles::text
      from pg_policies
     where schemaname='public' and tablename='income_expense_types'
     order by permissive, policyname`],

  ['P1-policy-cu-con-khong', `
    select count(*) con_policy_mo
      from pg_policies
     where schemaname='public' and tablename='income_expense_types'
       and policyname = 'income_expense_types_authenticated_all'`],

  // ── P9: record_invoice_payment_v4 da bi REVOKE chua ──
  ['P9-acl-v4', `
    select p.proname, p.proacl::text acl
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='record_invoice_payment_v4'`],

  // ── P8: approve_voucher co nhanh nguoi lap tu duyet khong ──
  ['P8-approve-voucher', `
    select (pg_get_functiondef(p.oid) ilike '%user_id = v_actor%'
            or pg_get_functiondef(p.oid) ilike '%user_id = auth.uid()%') co_nhanh_tu_duyet
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='approve_voucher'`],

  ['P8-pay-draft-goi-gi', `
    select (pg_get_functiondef(p.oid) ilike '%approve_voucher%') goi_approve_voucher,
           (pg_get_functiondef(p.oid) ilike '%approve_income_expense_v1%') goi_v1
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='pay_draft_fee_voucher'`],

  // ── C3: rule so SANH BANG hay <= ? ──
  ['C3-rule-so-sanh', `
    select (pg_get_functiondef(p.oid) ilike '%= round(v_expected%') so_sanh_bang
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='app_private' and p.proname='special_fee_rule_check_v1'`],

  // ── P7: THU khong nhan, sổ ảo / thiếu sổ 90 ngày ──
  ['P7-thu-khong-so', `
    select count(*) thu_approved,
           count(*) filter (where ie.account_id is null) thieu_so,
           count(*) filter (where a.is_virtual) so_ao
      from public.income_expenses ie
      left join public.accounts a on a.id = ie.account_id
     where ie.organization_id='aaaa0000-0000-4000-8000-000000000001'
       and ie.deleted_at is null and ie.type='INCOME'
       and ie.approval_status='APPROVED' and ie.system_source is null
       and ie.created_at > now() - interval '90 days'`],
];

(async () => {
  const c = new pg.Client({ host: 'aws-1-ap-southeast-1.pooler.supabase.com', port: 5432,
    database: 'postgres', user: 'postgres.' + REF, password: docPassword(),
    ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });
  await c.connect(); await c.query('BEGIN READ ONLY');
  const out = {};
  for (const [n, sql] of Q) {
    await c.query('SAVEPOINT s');
    try { const r = await c.query(sql); out[n] = r.rows; await c.query('RELEASE SAVEPOINT s');
      console.log('OK   ' + n.padEnd(24) + r.rows.length + ' dong'); }
    catch (e) { out[n] = { loi: e.message.split('\n')[0] }; await c.query('ROLLBACK TO SAVEPOINT s');
      console.log('LOI  ' + n.padEnd(24) + e.message.split('\n')[0]); }
  }
  await c.query('ROLLBACK'); await c.end();
  fs.writeFileSync('kiem-lai-ket-qua.json', JSON.stringify(out, null, 1), 'utf8');
  console.log('\nda ghi kiem-lai-ket-qua.json');
})().catch((e) => { console.error('THAT BAI:', e.message); process.exit(1); });
