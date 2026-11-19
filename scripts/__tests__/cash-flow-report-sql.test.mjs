// Dòng tiền năm và cột "Trong đó: chi chia lợi nhuận": thực thi định nghĩa SQL CUỐI của
// TỪNG hàm trong repo trên PGlite dùng một lần. Scope/membership/RLS và quyền lợi nhuận là
// fixture tổng hợp có cùng chữ ký, KHÔNG chứng minh JWT, PostgREST hay policy production.
// Mọi ID/số tiền bên dưới là dữ liệu tổng hợp.
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const migrationDir = new URL('../../supabase/migrations/', import.meta.url);
const REPORT = 'public.cashbook_cash_flow_v1';
const ROWS = 'public.cash_flow_external_rows_v1';
const VOUCHER_ROWS = 'app_private.cash_flow_external_voucher_rows_v1';
const PAYOUT = 'public.cashbook_cash_flow_profit_payout_v1';
const SIGNATURE = {
  [REPORT]: `${REPORT}(uuid,integer,uuid[])`, [ROWS]: `${ROWS}(uuid,date,date,uuid[])`,
  [VOUCHER_ROWS]: `${VOUCHER_ROWS}(uuid,date,date,uuid[])`, [PAYOUT]: `${PAYOUT}(uuid,integer,uuid[])`,
};
function definitionOf(source, name) {
  const starts = [...source.matchAll(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${name.replaceAll('.', '\\.')}\\(`, 'g'))];
  if (!starts.length) throw new Error(`missing ${name}`);
  const start = starts.at(-1).index;
  const open = /AS\s+(\$[A-Za-z_]*\$)/.exec(source.slice(start));
  if (!open) throw new Error(`missing body ${name}`);
  const close = source.indexOf(open[1], start + open.index + open[0].length);
  return source.slice(start, source.indexOf(';', close + open[1].length) + 1);
}
// Đọc + bóc chú thích MỌI migration đúng một lần. Định nghĩa SỐNG của một hàm = lần CREATE cuối
// theo thứ tự timestamp trên TOÀN thư mục (khuôn liveDefinitionOf, src/lib/__tests__/salaryCompletionDate.test.ts):
// hàm có thể được thay ở file khác file định nghĩa hàm gọi nó.
const corpus = readdirSync(migrationDir).filter(name => name.endsWith('.sql')).sort().map(name => {
  const sql = readFileSync(new URL(name, migrationDir), 'utf8');
  return { name, sql, code: sql.replace(/--[^\n]*/g, '') };
});
const defines = (file, fn) => new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${fn.replaceAll('.', '\\.')}\\s*\\(`, 'i').test(file.code);
function liveDefinitionOf(fn, before = '￿') {
  const hit = corpus.filter(file => file.name < before && defines(file, fn)).at(-1);
  if (!hit) throw new Error(`Không thấy định nghĩa ${fn}`);
  return hit;
}
const live = Object.fromEntries([REPORT, ROWS, VOUCHER_ROWS, PAYOUT].map(fn => [fn, liveDefinitionOf(fn)]));
const reportSql = definitionOf(live[REPORT].sql, REPORT);
const rowsSql = definitionOf(live[ROWS].sql, ROWS);
const voucherRowsSql = definitionOf(live[VOUCHER_ROWS].sql, VOUCHER_ROWS);
const payoutSql = definitionOf(live[PAYOUT].sql, PAYOUT);
// M5 = file đầu tiên tạo hàm có loại phiếu; thân hàm dòng TRƯỚC khi thành vỏ = định nghĩa cuối trước M5.
const m5 = corpus.find(file => defines(file, VOUCHER_ROWS));
const oldRowsSql = definitionOf(liveDefinitionOf(ROWS, m5.name).sql, ROWS);
const m5Body = m5.sql.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
const previousReport = liveDefinitionOf(REPORT, live[REPORT].name);
// Mọi file mang định nghĩa sống, theo thứ tự áp; mỗi file chạy HAI lượt liền (idempotent).
const liveFiles = [...new Set(Object.values(live))].sort((a, b) => a.name.localeCompare(b.name));
const bodyOf = sql => sql.match(/AS\s+\$fn\$([\s\S]*)\$fn\$;/)?.[1];

const uid = n => `cf000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = uid(1), OTHER_ORG = uid(2), DEMO_ORG = uid(3), USER = uid(4), DEMO_USER = uid(5);
const A = uid(10), B = uid(11), FOREIGN_BUILDING = uid(12), DELETED_BUILDING = uid(13), DEMO_BUILDING = uid(14);
const BOOK = uid(20), HIDDEN_BOOK = uid(21), VIRTUAL_BOOK = uid(22), DEMO_BOOK = uid(23), OTHER_BOOK = uid(24), DEMO_ORG_BOOK = uid(25);
const NULL_VIRTUAL_BOOK = uid(26), DEMO_OWNED_BOOK = uid(27);
const RENT = uid(30), DEPOSIT = uid(31), TRANSFER = uid(32), LEGACY_TRANSFER = uid(33), DIVIDEND = uid(34);
const PROFIT_TYPE = uid(35), MANAGER_TYPE = uid(36), MERGED_PROFIT = uid(37), MERGED_MANAGER = uid(38);
const RENAMED_INTERNAL = uid(39), MERGED_TRANSFER = uid(40), SHAREHOLDER = uid(50), MANAGER = uid(51);
const PROFIT_KEYS = ['shareholder_profit.distribute', 'shareholder_profit.lock', 'shareholder_profit.view_building_totals'];
let db;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TABLE public.organizations(id uuid PRIMARY KEY,is_demo boolean NOT NULL DEFAULT false,status text DEFAULT 'ACTIVE');
    CREATE TABLE public.accounts(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,code text,is_virtual boolean DEFAULT false,deleted_at timestamptz);
    CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,deleted_at timestamptz,is_virtual boolean DEFAULT false);
    CREATE TABLE public.income_expenses(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,user_id uuid,type text,account_id uuid,
      code text,voucher_date date,total_amount numeric,approval_status text DEFAULT 'APPROVED',posting_status text DEFAULT 'POSTED',
      deleted_at timestamptz,system_source text,handover_transfer_id uuid,handover_id uuid,reversal_of_income_expense_id uuid,
      reversed_by_posting_id uuid,has_restricted_item boolean DEFAULT false,posting_mode text DEFAULT 'CASHBOOK',
      shareholder_id uuid,profit_manager_id uuid);
    CREATE TABLE public.income_expense_types(id uuid PRIMARY KEY,organization_id uuid,name text,rule_key text,category text,merged_into_id uuid,is_restricted boolean DEFAULT false);
    CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,income_expense_id uuid,income_expense_type_id uuid,
      amount numeric,quantity numeric DEFAULT 1,unit_price numeric,accounting_class text);
    CREATE TABLE public.income_expense_postings(id uuid PRIMARY KEY,organization_id uuid,voucher_id uuid,event_kind text,posted_on date,reversal_of_id uuid,
      account_id uuid,posting_subject_kind text DEFAULT 'VOUCHER',posting_subject_id uuid,source_kind text DEFAULT 'CANONICAL',net_cash_effect numeric,voucher_amount_snapshot numeric);
    CREATE TABLE public.income_expense_posting_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,posting_id uuid,account_id uuid,signed_amount numeric,line_kind text DEFAULT 'MAIN');
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
      SELECT CASE WHEN auth.uid()='${USER}' THEN ARRAY['${ORG}'::uuid,'${OTHER_ORG}'::uuid,'${DEMO_ORG}'::uuid] ELSE '{}'::uuid[] END $$;
    CREATE FUNCTION public.finance_my_scope_v1(uuid,text) RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT jsonb_build_object('allowed',current_setting('test.allowed',true)='true','orgWide',current_setting('test.org_wide',true)='true',
        'buildingIds',string_to_array(current_setting('test.buildings',true),',')::uuid[],'cashbookIds','[]'::jsonb) $$;
    CREATE FUNCTION app_private.ie_visible_cashbook_ids_v1() RETURNS TABLE(cashbook_id uuid) LANGUAGE sql STABLE AS $$
      SELECT unnest(string_to_array(current_setting('test.books',true),',')::uuid[]) $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT $1=ANY(string_to_array(current_setting('test.buildings',true),',')::uuid[]) $$;
    CREATE FUNCTION public.can_view_restricted_ie() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.restricted',true)='true' $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.super',true)='true' $$;
    CREATE FUNCTION public.demo_user_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['${DEMO_USER}'::uuid] $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
      SELECT coalesce(string_to_array(nullif(current_setting('test.sandbox_orgs',true),''),',')::uuid[],'{}'::uuid[]) $$;
    CREATE FUNCTION app_private.finance_v2_can_read_posting_v1(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT $1=ANY(public.my_org_ids()) AND $2 IN (SELECT cashbook_id FROM app_private.ie_visible_cashbook_ids_v1()) $$;
    -- Cùng chữ ký helper thật (20261115024231): quyền TOÀN CÔNG TY theo khoá; fixture đọc danh sách khoá từ setting.
    CREATE FUNCTION app_private.profit_viewer_can_v1(p_organization_id uuid,p_permission_key text) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT auth.uid() IS NOT NULL AND p_organization_id IS NOT NULL
        AND p_permission_key=ANY(string_to_array(current_setting('test.profit_keys',true),',')) $$;
    -- Như production (đo 15/11/2026): authenticated KHÔNG có USAGE trên app_private.
    GRANT USAGE ON SCHEMA public,auth TO authenticated;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
    INSERT INTO public.organizations VALUES('${ORG}',false,'ACTIVE'),('${OTHER_ORG}',false,'ACTIVE'),('${DEMO_ORG}',true,'ACTIVE');
    INSERT INTO public.accounts(id,organization_id,user_id,code,is_virtual) VALUES
      ('${BOOK}','${ORG}',null,'CASH',false),('${HIDDEN_BOOK}','${ORG}',null,'HIDDEN',false),('${VIRTUAL_BOOK}','${ORG}',null,'CHANGE',true),
      ('${DEMO_BOOK}','${ORG}',null,'DEMO-CASH',false),('${OTHER_BOOK}','${OTHER_ORG}',null,'OTHER',false),('${DEMO_ORG_BOOK}','${DEMO_ORG}',null,'CASH',false),
      ('${NULL_VIRTUAL_BOOK}','${ORG}',null,'OLD',null),('${DEMO_OWNED_BOOK}','${ORG}','${DEMO_USER}','SAMPLE',false);
    INSERT INTO public.buildings(id,organization_id,user_id,deleted_at) VALUES('${A}','${ORG}',null,null),('${B}','${ORG}',null,null),
      ('${FOREIGN_BUILDING}','${OTHER_ORG}',null,null),('${DELETED_BUILDING}','${ORG}',null,'2026-10-01'),('${DEMO_BUILDING}','${ORG}','${DEMO_USER}',null);
    INSERT INTO public.income_expense_types(id,organization_id,name,rule_key,category,merged_into_id) VALUES
      ('${RENT}','${ORG}','Tiền thuê','rent','REVENUE',null),('${DEPOSIT}','${ORG}','Tiền cọc','deposit','DEPOSIT',null),
      ('${TRANSFER}','${ORG}','Bàn giao','noi_bo','INTERNAL',null),('${LEGACY_TRANSFER}','${ORG}','Bàn giao tiền mặt',null,'INTERNAL',null),
      ('${DIVIDEND}','${ORG}','Chi lợi nhuận','profit_distribution','INTERNAL',null),
      ('${PROFIT_TYPE}','${ORG}','Chia lợi nhuận cổ đông','chia_loi_nhuan','EXPENSE',null),
      ('${MANAGER_TYPE}','${ORG}','Lương điều hành','luong_dieu_hanh','EXPENSE',null),
      ('${MERGED_PROFIT}','${ORG}','Chia lợi nhuận cũ',null,'EXPENSE','${PROFIT_TYPE}'),
      ('${MERGED_MANAGER}','${ORG}','Lương điều hành cũ',null,'EXPENSE','${MANAGER_TYPE}'),
      ('${RENAMED_INTERNAL}','${ORG}','NHẬN TIỀN NỘI BỘ',null,'INTERNAL',null),
      ('${MERGED_TRANSFER}','${ORG}','Loại đã gộp',null,'INTERNAL','${TRANSFER}');
    ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_accounts ON public.accounts FOR SELECT TO authenticated USING(id IN (SELECT cashbook_id FROM app_private.ie_visible_cashbook_ids_v1()));
    ALTER TABLE public.income_expenses ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_vouchers ON public.income_expenses FOR SELECT TO authenticated USING(public.can_access_building(building_id) AND NOT has_restricted_item);
    ALTER TABLE public.income_expense_postings ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_postings ON public.income_expense_postings FOR SELECT TO authenticated USING(app_private.finance_v2_can_read_posting_v1(organization_id,account_id));
    ALTER TABLE public.income_expense_posting_lines ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_lines ON public.income_expense_posting_lines FOR SELECT TO authenticated USING(app_private.finance_v2_can_read_posting_v1(organization_id,account_id));`);
  await db.exec(definitionOf(readFileSync(new URL('20260708130100_nrm_vn_resolve_fixed_expense_type.sql', migrationDir), 'utf8'), 'public.nrm_vn'));
  // Bản trước của báo cáo ⇒ chứng minh file sống CREATE OR REPLACE được đè lên trạng thái production cũ.
  await db.exec(definitionOf(previousReport.sql, REPORT));
  for (const file of liveFiles) { await db.exec(file.sql); await db.exec(file.sql); }
}, 60000);
afterAll(async () => { await db?.close(); });

async function inCase(work, options = {}) {
  await db.exec('BEGIN');
  try {
    const settings = { 'request.jwt.claim.sub': USER, 'test.allowed': 'true', 'test.org_wide': 'true', 'test.super':'false', 'test.sandbox_orgs':'',
      'test.restricted': 'false', 'test.profit_keys': PROFIT_KEYS[0],
      'test.buildings': [A,B,FOREIGN_BUILDING].join(','), 'test.books': [BOOK,VIRTUAL_BOOK,DEMO_BOOK,OTHER_BOOK,DEMO_ORG_BOOK].join(','), ...options };
    for (const [name,value] of Object.entries(settings)) await db.query('SELECT set_config($1,$2,true)', [name,value]);
    return await work();
  } finally { await db.exec('ROLLBACK'); }
}
async function post(n, amount, on = '2026-08-12', options = {}) {
  const { org = ORG, book = BOOK, building = A, category = RENT, source = null, transfer = null, shareholder = null, manager = null,
    reversal = null, kind = 'POSTING', counter = null, status = 'APPROVED', restricted = false, noVoucher = false, actor = USER } = options;
  const posting = uid(1000+n), voucher = noVoucher ? null : uid(2000+n);
  if (voucher) {
    await db.query(`INSERT INTO income_expenses(id,organization_id,building_id,user_id,type,account_id,code,voucher_date,total_amount,system_source,
      handover_transfer_id,reversal_of_income_expense_id,approval_status,has_restricted_item,shareholder_id,profit_manager_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [voucher,org,building,actor,amount>0?'INCOME':'EXPENSE',book,`FIXTURE-${n}`,on,Math.abs(amount),source,transfer,counter,status,restricted,shareholder,manager]);
    await db.query('INSERT INTO income_expense_items(income_expense_id,income_expense_type_id,amount,unit_price,organization_id) VALUES($1,$2,$3,$3,$4)',[voucher,category,Math.abs(amount),org]);
  }
  await db.query(`INSERT INTO income_expense_postings(id,organization_id,voucher_id,event_kind,posted_on,reversal_of_id,account_id,posting_subject_id,net_cash_effect,voucher_amount_snapshot,posting_subject_kind)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[posting,org,voucher,kind,on,reversal,book,voucher??posting,amount,Math.abs(amount),noVoucher?'SALARY_TRANCHE':'VOUCHER']);
  await db.query('INSERT INTO income_expense_posting_lines(organization_id,posting_id,account_id,signed_amount) VALUES($1,$2,$3,$4)',[org,posting,book,amount]);
  return { posting, voucher };
}
// Gọi như người dùng (vai authenticated, jwt sub = setting); lỗi thì trả lại vai và ném tiếp.
async function callAs(sql, params, role = 'authenticated') {
  await db.exec('SAVEPOINT call_as');
  await db.exec(`SET LOCAL ROLE ${role}`);
  try {
    const { rows } = await db.query(sql, params);
    await db.exec('RESET ROLE; RELEASE SAVEPOINT call_as');
    return rows;
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT call_as; RELEASE SAVEPOINT call_as');
    throw error;
  }
}
async function report(year = 2026, org = ORG, buildings = null, role = 'authenticated') {
  const rows = await callAs(`SELECT * FROM ${REPORT}($1,$2,$3)`, [org,year,buildings], role);
  return rows.map(row => ({ ...row, income: Number(row.income), expense: Number(row.expense), net: Number(row.net) }));
}
async function payout(year = 2026, org = ORG, buildings = null, role = 'authenticated') {
  const rows = await callAs(`SELECT * FROM ${PAYOUT}($1,$2,$3)`, [org,year,buildings], role);
  return rows.map(row => ({ ...row, shareholder_payout: Number(row.shareholder_payout), manager_payout: Number(row.manager_payout) }));
}
const amounts = (rows, period = '2026-08') => {
  const row = rows.find(row => row.period === period);
  return row ? [row.income,row.expense,row.net] : null;
};
const paid = (rows, period) => {
  const row = rows.find(row => row.period === period);
  return row ? [row.shareholder_payout,row.manager_payout] : null;
};
const failure = promise => promise.then(() => 'ok', error => `${error.code} ${error.message}`);
const prosrcOf = async signature => (await db.query('SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows[0]?.prosrc;

test('SQL cuối chạy idempotent; báo cáo INVOKER, ba hàm DEFINER ghim search_path; hàm có loại phiếu không cấp cho vai nào', () => inCase(async () => {
  expect(liveFiles.map(file => file.name)).toContain(m5.name);
  expect(bodyOf(oldRowsSql)).not.toBe(bodyOf(rowsSql));
  const { rows } = await db.query(`SELECT n.nspname||'.'||p.proname name,p.prosecdef definer,p.provolatile volatility,p.proconfig config,
    has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('service_role',p.oid,'EXECUTE') service,
    has_function_privilege('authenticated',p.oid,'EXECUTE') auth
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname=ANY($1)`,[[REPORT,ROWS,VOUCHER_ROWS,PAYOUT]]);
  expect(rows).toHaveLength(4);
  const pinned = ['search_path=pg_catalog, public, app_private'];
  const expected = {
    [REPORT]: { definer:false, auth:true }, [ROWS]: { definer:true, auth:true, config:pinned },
    [VOUCHER_ROWS]: { definer:true, auth:false, config:pinned }, [PAYOUT]: { definer:true, auth:true, config:pinned },
  };
  for (const row of rows) expect(row, row.name).toMatchObject({ volatility:'s', anon:false, service:false, ...expected[row.name] });
}));

test('12 tháng và 4 quý: giữ tiền cọc, hoàn tiền thật và chi cùng số tiền không có quan hệ hoàn tác', () => inCase(async () => {
  await post(1,100,'2026-01-15');
  await post(2,120,'2026-07-01');
  await post(3,40,'2026-07-03',{category:DEPOSIT});
  await post(4,-25,'2026-07-10',{category:DEPOSIT,source:'termination.refund'});
  await post(5,-30,'2026-07-11');
  await post(6,200); await post(7,300,'2026-09-01'); await post(8,-70,'2026-09-02');
  await post(9,33,'2026-09-03'); await post(10,-33,'2026-09-03');
  await post(11,-15,'2026-09-04',{category:DIVIDEND,source:'profit.distribution'});
  const rows = await report();
  expect(rows).toHaveLength(16);
  expect(rows.every(row => row.organization_id===ORG && row.building_id===null)).toBe(true);
  expect(amounts(rows,'2026-07')).toEqual([160,55,105]);
  expect(amounts(rows,'2026-08')).toEqual([200,0,200]);
  expect(amounts(rows,'2026-09')).toEqual([333,118,215]);
  expect(amounts(rows,'2026-Q1')).toEqual([100,0,100]);
  expect(amounts(rows,'2026-Q2')).toEqual([0,0,0]);
  expect(amounts(rows,'2026-Q3')).toEqual([693,173,520]);
  expect(amounts(rows,'2026-Q4')).toEqual([0,0,0]);
}));

test('loại sổ ảo, org khác/demo và ba dấu vết bàn giao; mã sổ giống DEMO không tự biến tiền thật thành dữ liệu thử', () => inCase(async () => {
  await post(1,100);
  await post(2,900,undefined,{book:VIRTUAL_BOOK});
  await post(3,800,undefined,{book:DEMO_BOOK});
  await post(4,700,undefined,{org:OTHER_ORG,book:OTHER_BOOK,building:FOREIGN_BUILDING});
  await post(5,600,undefined,{org:DEMO_ORG,book:DEMO_ORG_BOOK});
  await post(6,55,undefined,{source:'handover.transfer'});
  await post(7,-55,undefined,{source:'handover.transfer'});
  await post(8,66,undefined,{transfer:uid(9000)});
  await post(9,-66,undefined,{transfer:uid(9000)});
  await post(10,77,undefined,{category:TRANSFER});
  await post(11,-77,undefined,{category:LEGACY_TRANSFER});
  expect(amounts(await report())).toEqual([900,0,900]);
  expect((await report(2026,DEMO_ORG)).every(row => row.income===0 && row.expense===0)).toBe(true);
}));

test('hoàn tác liên kết: cùng tháng, khác tháng, khác năm và counter voucher đều không đội thu chi', () => inCase(async () => {
  await post(1,50);
  for (const [n,on,reverseOn] of [[10,'2026-08-01','2026-08-02'],[20,'2026-07-01','2026-08-02'],
    [30,'2025-12-01','2026-01-02'],[40,'2026-09-01','2027-01-02']]) {
    const original = await post(n,n,on);
    await post(n+1,-n,reverseOn,{kind:'REVERSAL',reversal:original.posting});
  }
  const source = await post(50,110);
  await post(51,-110,undefined,{counter:source.voucher,source:'invoice.collection.reverse.v5'});
  await post(60,-99,undefined,{kind:'REVERSAL',reversal:uid(99999)});
  const rows = await report();
  expect(amounts(rows)).toEqual([50,0,50]);
  expect(amounts(rows,'2026-Q3')).toEqual([50,0,50]);
  expect(amounts(await report(2025),'2025-Q4')).toEqual([0,0,0]);
  expect(amounts(await report(2027),'2027-Q1')).toEqual([0,0,0]);
}));

test('phạm vi sổ/toà vẫn kín khi chỉ một phía hoàn tác nhìn thấy; reversal khác org không xoá thu hợp lệ', () => inCase(async () => {
  await post(1,100);
  await post(2,900,undefined,{book:HIDDEN_BOOK});
  await post(3,300,undefined,{building:B});
  const visible = await post(10,80);
  await post(11,-8000,undefined,{kind:'REVERSAL',reversal:visible.posting,book:HIDDEN_BOOK,building:B});
  const hidden = await post(20,90,undefined,{book:HIDDEN_BOOK,building:B});
  await post(21,-90,undefined,{kind:'REVERSAL',reversal:hidden.posting});
  const kept = await post(30,70);
  await post(31,-70,undefined,{kind:'REVERSAL',reversal:kept.posting,org:OTHER_ORG,book:OTHER_BOOK,building:FOREIGN_BUILDING});
  expect(amounts(await report(2026,ORG,[A]))).toEqual([170,0,170]);
  expect(amounts(await report())).toEqual([470,0,470]);
  expect(await report(2026,ORG,[])).toEqual([]);
}));

test('scope chỉ toà A không mở rộng bởi tham số B; thiếu khoá/khách/chưa đăng nhập bị từ chối', async () => {
  await inCase(async () => {
    await post(1,100); await post(2,700,undefined,{building:B});
    expect(amounts(await report())).toEqual([100,0,100]);
    expect(await report(2026,ORG,[B])).toEqual([]);
  },{'test.org_wide':'false','test.buildings':A});
  for (const settings of [{'test.allowed':'false'},{'request.jwt.claim.sub':''},{'request.jwt.claim.sub':uid(999)}]) {
    await inCase(async () => { await expect(report()).rejects.toThrow(); },settings);
  }
  await inCase(async () => { await expect(report(2026,ORG,null,'anon')).rejects.toThrow(/permission denied/); });
  await inCase(async () => { await expect(report(1999)).rejects.toThrow(/cash_flow_invalid/); });
});

test('lịch sử toà đã soft-delete vẫn được giữ ở toàn công ty; scope hẹp không mở thêm toà cũ', async () => {
  async function seedDeletedBuilding() {
    await post(1,100); await post(2,700,undefined,{building:B});
    await db.query('UPDATE buildings SET deleted_at=$1 WHERE id=$2',['2026-10-01',B]);
  }
  await inCase(async () => {
    await seedDeletedBuilding();
    const rows=await report();
    expect(amounts(rows)).toEqual([800,0,800]);
    expect(amounts(rows,'2026-Q3')).toEqual([800,0,800]);
  });
  await inCase(async () => {
    await seedDeletedBuilding();
    const rows=await report(2026,ORG,[A,B]);
    expect(rows).toHaveLength(16);
    expect(rows.every(row => row.building_id===A)).toBe(true);
    expect(amounts(rows)).toEqual([100,0,100]);
    expect(await report(2026,ORG,[B])).toEqual([]);
  },{'test.org_wide':'false','test.buildings':A});
});

test('owner DEMO chính thức trên sổ, phiếu hoặc toà đều bị loại trong org thật, với người thường và admin', async () => {
  for (const superAdmin of ['false','true']) for (const marker of ['account','voucher','building']) await inCase(async () => {
    const demo=await post(1,900);
    await post(2,100,undefined,{book:DEMO_BOOK,building:B});
    if (marker==='account') await db.query('UPDATE accounts SET user_id=$1 WHERE id=$2',[DEMO_USER,BOOK]);
    if (marker==='voucher') await db.query('UPDATE income_expenses SET user_id=$1 WHERE id=$2',[DEMO_USER,demo.voucher]);
    if (marker==='building') await db.query('UPDATE buildings SET user_id=$1 WHERE id=$2',[DEMO_USER,A]);
    expect(amounts(await report()),`${marker}, admin=${superAdmin}`).toEqual([100,0,100]);
  },{'test.super':superAdmin});
});

test('org được helper chính thức đánh dấu sandbox bị loại kể cả is_demo=false', async () => {
  for (const superAdmin of ['false','true']) await inCase(async () => {
    await post(1,900);
    expect(amounts(await report())).toEqual([0,0,0]);
  },{'test.super':superAdmin,'test.sandbox_orgs':ORG});
});

test('NULL owner/voucher/toà của posting lương hợp lệ không bị coi là DEMO; voucher ID mồ côi không mở scope', () => inCase(async () => {
  await post(1,-100,undefined,{noVoucher:true});
  const missing=await post(2,900);
  await db.query('UPDATE income_expense_postings SET voucher_id=$1 WHERE id=$2',[uid(99999),missing.posting]);
  expect(amounts(await report())).toEqual([0,100,-100]);
  expect(amounts(await report(2026,ORG,[A]))).toEqual([0,0,0]);
}));

test('phiếu gốc trong phiên bàn giao vẫn là thu thật; giữ quy tắc phiếu hạn chế của chính người gọi', () => inCase(async () => {
  const receipt = await post(1,100);
  await db.query('UPDATE income_expenses SET handover_id=$1 WHERE id=$2',[uid(9000),receipt.voucher]);
  await post(2,30,undefined,{restricted:true});
  await post(3,900,undefined,{restricted:true,actor:uid(999)});
  expect(amounts(await report())).toEqual([130,0,130]);
}));

test('dữ liệu cũ: is_virtual NULL vẫn là sổ thật; tên nhận tiền nội bộ loại đúng sau chuẩn hoá', () => inCase(async () => {
  await db.query('UPDATE accounts SET is_virtual=null WHERE id=$1',[BOOK]);
  await post(1,100);
  await db.query('UPDATE income_expense_types SET name=$1 WHERE id=$2',['NHẬN TIỀN NỘI BỘ',LEGACY_TRANSFER]);
  await post(2,900,undefined,{category:LEGACY_TRANSFER});
  expect(amounts(await report())).toEqual([100,0,100]);
}));

test('phiếu đối ứng chưa vào sổ hoặc đã hoàn tác không huỷ khoản thu gốc', () => inCase(async () => {
  const original = await post(1,100);
  const draft = await post(2,-100,undefined,{counter:original.voucher});
  await db.query('DELETE FROM income_expense_posting_lines WHERE posting_id=$1',[draft.posting]);
  await db.query('DELETE FROM income_expense_postings WHERE id=$1',[draft.posting]);
  const second = await post(3,80);
  const counter = await post(4,-80,undefined,{counter:second.voucher});
  await post(5,80,undefined,{kind:'REVERSAL',reversal:counter.posting});
  expect(amounts(await report())).toEqual([180,0,180]);
}));

test('phiếu trộn: trừ đúng phần bàn giao, nhận loại đã gộp và không im lặng đoán khi nhiều dòng posting', () => inCase(async () => {
  const mixed = await post(1,150);
  await db.query('UPDATE income_expense_items SET amount=100,unit_price=100 WHERE income_expense_id=$1',[mixed.voucher]);
  await db.query('INSERT INTO income_expense_items(income_expense_id,income_expense_type_id,amount,organization_id) VALUES($1,$2,50,$3)',[mixed.voucher,TRANSFER,ORG]);
  expect(amounts(await report())).toEqual([100,0,100]);
  await db.query('UPDATE income_expense_types SET rule_key=null,name=$1,merged_into_id=$2 WHERE id=$3',['Loại đã gộp',TRANSFER,LEGACY_TRANSFER]);
  await post(2,80,undefined,{category:LEGACY_TRANSFER});
  expect(amounts(await report())).toEqual([100,0,100]);
  await db.query('INSERT INTO income_expense_posting_lines(organization_id,posting_id,account_id,signed_amount,line_kind) VALUES($1,$2,$3,5,$4)',[ORG,mixed.posting,VIRTUAL_BOOK,'CHANGE']);
  await expect(report()).rejects.toThrow(/cash_flow_mixed_transfer_items/);
}));

// ===== Cột "Trong đó: chi chia lợi nhuận" (M5) =====
// Mỗi nhánh của luật profit_kind một tháng; tháng 8 là phiếu lợi nhuận mà dòng tiền đã loại.
// Kỳ vọng toàn công ty 2026 (cổ đông, lương điều hành): T2 3000/100 · T3 4000/200 · T4 8990/300 ·
// T5 16000/400 · T6 32000/500 · T8 0/0 · T9 100/0 · T10 60/0.
async function seedProfit() {
  await post(101,-1000,'2026-02-10',{source:'profit.ledger_payout'});
  await post(102,-2000,'2026-02-11',{source:'profit.distribution'});
  await post(103,-100,'2026-02-12',{source:'profit.manager_salary'});
  await post(104,64000,'2026-02-13',{shareholder:SHAREHOLDER});                 // phiếu THU có cổ đông: chỉ vào "Thu vào"
  await post(105,-7,'2026-02-14');                                              // chi thường
  await post(106,32,'2026-02-15',{manager:MANAGER});                            // phiếu THU gắn người lương điều hành
  await post(107,-4000,'2026-03-05',{shareholder:SHAREHOLDER});
  await post(108,-200,'2026-03-06',{source:'salary.manager'});
  await post(109,-8000,'2026-04-05',{category:PROFIT_TYPE});
  await post(110,-300,'2026-04-06',{manager:MANAGER});
  await post(111,-990,'2026-04-07',{category:PROFIT_TYPE,building:B});
  await post(112,-16000,'2026-05-05',{category:MERGED_PROFIT});
  await post(113,-400,'2026-05-06',{category:MANAGER_TYPE});
  await post(114,-500,'2026-06-06',{category:MERGED_MANAGER});
  await post(115,-32000,'2026-06-07',{shareholder:SHAREHOLDER,source:'salary.manager'}); // hai dấu hiệu: cổ đông thắng
  const reversed = await post(120,-900,'2026-08-03',{shareholder:SHAREHOLDER});
  await post(121,900,'2026-08-04',{kind:'REVERSAL',reversal:reversed.posting});
  const countered = await post(122,-910,'2026-08-05',{source:'profit.ledger_payout'});
  await post(123,910,'2026-08-05',{counter:countered.voucher});
  await post(124,-920,'2026-08-06',{shareholder:SHAREHOLDER,book:VIRTUAL_BOOK});
  await post(125,-930,'2026-08-07',{shareholder:SHAREHOLDER,book:HIDDEN_BOOK});
  await post(126,-940,'2026-08-08',{shareholder:SHAREHOLDER,org:OTHER_ORG,book:OTHER_BOOK,building:FOREIGN_BUILDING});
  await post(127,-950,'2026-08-09',{shareholder:SHAREHOLDER,org:DEMO_ORG,book:DEMO_ORG_BOOK});
  await post(128,-960,'2026-08-10',{shareholder:SHAREHOLDER,transfer:uid(9002)});
  await post(129,-970,'2026-08-11',{shareholder:SHAREHOLDER,actor:DEMO_USER});
  await post(130,-980,'2026-08-12',{shareholder:SHAREHOLDER,restricted:true,actor:uid(999)});
  await post(131,-1100,'2026-08-13',{noVoucher:true});                          // posting lương không phiếu: vào "Chi ra", không vào cột
  await post(132,-990,'2026-08-14',{manager:MANAGER,kind:'REVERSAL',reversal:uid(99999)});
  // Phiếu trộn hạng mục lợi nhuận + bàn giao nội bộ: chỉ phần chi ra ngoài (100) vào cột.
  const mixed = await post(140,-150,'2026-09-05',{category:PROFIT_TYPE});
  await db.query('UPDATE income_expense_items SET amount=100,unit_price=100 WHERE income_expense_id=$1',[mixed.voucher]);
  await db.query('INSERT INTO income_expense_items(income_expense_id,income_expense_type_id,amount,organization_id) VALUES($1,$2,50,$3)',[mixed.voucher,TRANSFER,ORG]);
  // Hạng mục lợi nhuận lẫn hạng mục thường trong MỘT phiếu: cờ theo phiếu (giới hạn đã ghi ở M5).
  const both = await post(141,-60,'2026-10-05',{category:PROFIT_TYPE});
  await db.query('UPDATE income_expense_items SET amount=40,unit_price=40 WHERE income_expense_id=$1',[both.voucher]);
  await db.query('INSERT INTO income_expense_items(income_expense_id,income_expense_type_id,amount,organization_id) VALUES($1,$2,20,$3)',[both.voucher,RENT,ORG]);
}
const EXPECTED_PAID = {
  '2026-01':[0,0], '2026-02':[3000,100], '2026-03':[4000,200], '2026-04':[8990,300], '2026-05':[16000,400], '2026-06':[32000,500],
  '2026-07':[0,0], '2026-08':[0,0], '2026-09':[100,0], '2026-10':[60,0], '2026-11':[0,0], '2026-12':[0,0],
  '2026-Q1':[7000,300], '2026-Q2':[56990,1200], '2026-Q3':[100,0], '2026-Q4':[60,0],
};
const byPeriod = rows => Object.fromEntries(rows.map(row => [row.period, [row.shareholder_payout,row.manager_payout]]));

test('phân loại: mỗi nhánh của luật vào đúng cột; phiếu thường, phiếu THU, phiếu đã loại khỏi dòng tiền không vào', () => inCase(async () => {
  await seedProfit();
  const rows = await payout();
  expect(rows).toHaveLength(16);
  expect(rows.every(row => row.organization_id===ORG && row.building_id===null)).toBe(true);
  expect(byPeriod(rows)).toEqual(EXPECTED_PAID);
  // Các phiếu tháng 8 đều có trong dữ liệu nhưng dòng tiền đã loại; posting lương không phiếu vẫn là "Chi ra".
  const rep = await report();
  expect(amounts(rep,'2026-02')).toEqual([64032,3107,60925]);
  expect(amounts(rep,'2026-08')).toEqual([0,1100,-1100]);
  // Phiếu công ty khác chỉ vào cột của chính công ty đó; công ty DEMO không bao giờ.
  expect(paid(await payout(2026,OTHER_ORG),'2026-08')).toEqual([940,0]);
  expect((await payout(2026,DEMO_ORG)).every(row => row.shareholder_payout===0 && row.manager_payout===0)).toBe(true);
}));

test('cột lợi nhuận luôn nằm trong "Chi ra" cùng kỳ; quý = tổng ba tháng; cùng dãy kỳ và toà với báo cáo', async () => {
  for (const [settings, calls] of [
    [{}, [[2026,ORG,null],[2026,ORG,[A,B]],[2026,ORG,[B]],[2026,ORG,[]],[2026,OTHER_ORG,null],[2025,ORG,null]]],
    [{'test.org_wide':'false','test.buildings':A}, [[2026,ORG,null],[2026,ORG,[A]],[2026,ORG,[B]],[2026,ORG,[A,B]]]],
    [{'test.org_wide':'false','test.buildings':[A,B].join(',')}, [[2026,ORG,null],[2026,ORG,[B]]]],
  ]) await inCase(async () => {
    await seedProfit();
    for (const args of calls) {
      const rep = await report(...args), rows = await payout(...args), label = `${JSON.stringify(settings)} ${JSON.stringify(args)}`;
      expect(rows.map(row => [row.organization_id,row.building_id,row.period]), label).toEqual(rep.map(row => [row.organization_id,row.building_id,row.period]));
      rows.forEach((row, index) => expect(row.shareholder_payout + row.manager_payout, `${label} ${row.period}`).toBeLessThanOrEqual(rep[index].expense));
      for (const series of new Set(rows.map(row => row.building_id))) for (const quarter of [1,2,3,4]) {
        const months = rows.filter(row => row.building_id===series && /^\d{4}-\d{2}$/.test(row.period) && Math.ceil(Number(row.period.slice(5))/3)===quarter);
        const total = rows.find(row => row.building_id===series && row.period.endsWith(`-Q${quarter}`));
        expect(months, label).toHaveLength(3);
        expect([total.shareholder_payout,total.manager_payout], `${label} Q${quarter}`)
          .toEqual([months.reduce((s,row) => s+row.shareholder_payout,0), months.reduce((s,row) => s+row.manager_payout,0)]);
      }
    }
  }, settings);
});

test('phạm vi: theo toà trả từng toà như báo cáo; tham số toà không mở rộng phạm vi', async () => {
  await inCase(async () => {
    await seedProfit();
    const rows = await payout();
    expect(paid(rows,'2026-04')).toEqual([8000,300]);
    expect(paid(rows,'2026-Q2')).toEqual([56000,1200]);
    expect(rows.every(row => row.building_id===A)).toBe(true);
    expect(await payout(2026,ORG,[B])).toEqual([]);
  },{'test.org_wide':'false','test.buildings':A});
  await inCase(async () => {
    await seedProfit();
    const rows = await payout();
    expect(rows.map(row => row.building_id)).toEqual([...Array(16).fill(A), ...Array(16).fill(B)]);
    expect(paid(rows.filter(row => row.building_id===B),'2026-04')).toEqual([990,0]);
  },{'test.org_wide':'false','test.buildings':[A,B].join(',')});
  await inCase(async () => {
    await seedProfit();
    const rows = await payout(2026,ORG,[B]);
    expect(rows.every(row => row.building_id===B)).toBe(true);
    expect(paid(rows,'2026-04')).toEqual([990,0]);
    expect(paid(rows,'2026-02')).toEqual([0,0]);
  });
});

test('quyền: thiếu cash_flow, thiếu cả ba khoá lợi nhuận, chưa đăng nhập, không thuộc công ty ⇒ 42501; MỖI khoá trong ba khoá đều đủ', async () => {
  for (const key of PROFIT_KEYS) await inCase(async () => {
    await seedProfit();
    expect(paid(await payout(),'2026-02'), key).toEqual([3000,100]);
  },{'test.profit_keys':key});
  for (const [label, settings, expected] of [
    ['thiếu reports_finance.cash_flow', {'test.allowed':'false'}, '42501 cash_flow_denied'],
    ['thiếu cash_flow lẫn khoá lợi nhuận: kiểm cash_flow trước', {'test.allowed':'false','test.profit_keys':''}, '42501 cash_flow_denied'],
    ['thiếu cả ba khoá', {'test.profit_keys':''}, '42501 cash_flow_profit_denied'],
    ['chỉ khoá xem/mở chốt/% (không phải ba khoá)', {'test.profit_keys':'shareholder_profit.view,shareholder_profit.unlock,shareholder_profit.view_percent'}, '42501 cash_flow_profit_denied'],
    ['chưa đăng nhập', {'request.jwt.claim.sub':''}, '42501 cash_flow_denied'],
    ['không thuộc công ty', {'request.jwt.claim.sub':uid(999)}, '42501 cash_flow_denied'],
    ['không thuộc công ty, không khoá: kiểm công ty trước', {'request.jwt.claim.sub':uid(999),'test.profit_keys':''}, '42501 cash_flow_denied'],
  ]) await inCase(async () => {
    await seedProfit();
    expect(await failure(payout()), label).toBe(expected);
  }, settings);
  await inCase(async () => { expect(await failure(payout(1999))).toBe('22023 cash_flow_invalid'); });
  await inCase(async () => { expect(await failure(payout(2026,null))).toBe('42501 cash_flow_denied'); });
  for (const role of ['anon','service_role']) await inCase(async () => {
    expect(await failure(payout(2026,ORG,null,role)), role).toMatch(/^42501 permission denied for function cashbook_cash_flow_profit_payout_v1/);
  });
});

test('vai authenticated không gọi thẳng được hàm có loại phiếu, kể cả khi có USAGE schema; vỏ public chỉ trả ba cột', () => inCase(async () => {
  await seedProfit();
  const direct = () => failure(callAs(`SELECT * FROM ${VOUCHER_ROWS}($1,'2026-01-01','2026-12-31',null)`,[ORG]));
  expect(await direct()).toMatch(/^42501 permission denied for schema app_private/);
  await db.exec('GRANT USAGE ON SCHEMA app_private TO authenticated');
  expect(await direct()).toMatch(/^42501 permission denied for function cash_flow_external_voucher_rows_v1/);
  const viaShell = await callAs(`SELECT * FROM ${ROWS}($1,'2026-01-01','2026-12-31',null)`,[ORG]);
  expect(viaShell.length).toBeGreaterThan(0);
  expect(Object.keys(viaShell[0]).sort()).toEqual(['building_id','day','signed_amount']);
}));

// ===== TRƯỚC/SAU: cashbook_cash_flow_v1 (web + Hermes) không đổi một con số =====
// Mọi kịch bản của các ca trên trong MỘT bộ dữ liệu, thêm phiếu lợi nhuận.
const RICH = { 'test.buildings': [A,B,FOREIGN_BUILDING,DELETED_BUILDING,DEMO_BUILDING].join(','),
  'test.books': [BOOK,VIRTUAL_BOOK,DEMO_BOOK,OTHER_BOOK,DEMO_ORG_BOOK,NULL_VIRTUAL_BOOK,DEMO_OWNED_BOOK].join(',') };
async function seedRich() {
  await post(1,100,'2026-01-15'); await post(2,120,'2026-07-01'); await post(3,40,'2026-07-03',{category:DEPOSIT});
  await post(4,-25,'2026-07-10',{category:DEPOSIT,source:'termination.refund'}); await post(5,-30,'2026-07-11');
  await post(6,200); await post(7,300,'2026-09-01'); await post(8,-70,'2026-09-02'); await post(9,33,'2026-09-03'); await post(10,-33,'2026-09-03');
  await post(11,900,undefined,{book:VIRTUAL_BOOK}); await post(12,800,undefined,{book:DEMO_BOOK}); await post(13,900,undefined,{book:HIDDEN_BOOK});
  await post(14,700,undefined,{org:OTHER_ORG,book:OTHER_BOOK,building:FOREIGN_BUILDING}); await post(15,600,undefined,{org:DEMO_ORG,book:DEMO_ORG_BOOK});
  await post(16,55,undefined,{source:'handover.transfer'}); await post(17,-55,undefined,{source:'handover.transfer'});
  await post(18,66,undefined,{transfer:uid(9000)}); await post(19,-66,undefined,{transfer:uid(9000)});
  await post(20,77,undefined,{category:TRANSFER}); await post(21,-77,undefined,{category:LEGACY_TRANSFER});
  await post(22,300,undefined,{building:B}); await post(23,-45,'2026-10-05',{building:B}); await post(24,70,'2026-11-02',{building:DELETED_BUILDING});
  for (const [n,on,reverseOn] of [[30,'2026-08-01','2026-08-02'],[32,'2026-07-01','2026-08-02'],[34,'2025-12-01','2026-01-02'],[36,'2026-09-01','2027-01-02']]) {
    const original = await post(n,n,on);
    await post(n+1,-n,reverseOn,{kind:'REVERSAL',reversal:original.posting});
  }
  const source = await post(40,110); await post(41,-110,undefined,{counter:source.voucher,source:'invoice.collection.reverse.v5'});
  await post(42,-99,undefined,{kind:'REVERSAL',reversal:uid(99999)});
  const visible = await post(43,80); await post(44,-8000,undefined,{kind:'REVERSAL',reversal:visible.posting,book:HIDDEN_BOOK,building:B});
  const hidden = await post(45,90,undefined,{book:HIDDEN_BOOK,building:B}); await post(46,-90,undefined,{kind:'REVERSAL',reversal:hidden.posting});
  const kept = await post(47,70); await post(48,-70,undefined,{kind:'REVERSAL',reversal:kept.posting,org:OTHER_ORG,book:OTHER_BOOK,building:FOREIGN_BUILDING});
  await post(50,500,undefined,{book:DEMO_OWNED_BOOK}); await post(51,510,undefined,{actor:DEMO_USER}); await post(52,520,undefined,{building:DEMO_BUILDING});
  await post(53,-100,'2026-03-03',{noVoucher:true});
  const missing = await post(54,900); await db.query('UPDATE income_expense_postings SET voucher_id=$1 WHERE id=$2',[uid(99998),missing.posting]);
  const receipt = await post(55,130); await db.query('UPDATE income_expenses SET handover_id=$1 WHERE id=$2',[uid(9001),receipt.voucher]);
  await post(56,30,undefined,{restricted:true}); await post(57,900,undefined,{restricted:true,actor:uid(999)});
  await post(58,140,undefined,{book:NULL_VIRTUAL_BOOK}); await post(59,950,undefined,{category:RENAMED_INTERNAL});
  const original = await post(60,100); const draft = await post(61,-100,undefined,{counter:original.voucher});
  await db.query('DELETE FROM income_expense_posting_lines WHERE posting_id=$1',[draft.posting]);
  await db.query('DELETE FROM income_expense_postings WHERE id=$1',[draft.posting]);
  const second = await post(62,80); const counter = await post(63,-80,undefined,{counter:second.voucher});
  await post(64,80,undefined,{kind:'REVERSAL',reversal:counter.posting});
  const mixed = await post(65,150,'2026-12-01');
  await db.query('UPDATE income_expense_items SET amount=100,unit_price=100 WHERE income_expense_id=$1',[mixed.voucher]);
  await db.query('INSERT INTO income_expense_items(income_expense_id,income_expense_type_id,amount,organization_id) VALUES($1,$2,50,$3)',[mixed.voucher,TRANSFER,ORG]);
  await post(66,80,undefined,{category:MERGED_TRANSFER});
  await seedProfit();
}
const rawRows = (...args) => callAs(`SELECT day::text AS day,building_id,signed_amount::text AS amount FROM ${ROWS}($1,$2,$3,$4) ORDER BY 1,2,3`, args);
const PARITY = [
  ['toàn công ty', {}, [[2026,ORG,null],[2026,ORG,[A]],[2026,ORG,[A,B]],[2026,ORG,[B]],[2026,ORG,[DELETED_BUILDING]],[2026,ORG,[]],
    [2025,ORG,null],[2027,ORG,null],[2026,OTHER_ORG,null],[2026,DEMO_ORG,null]]],
  ['chỉ toà A', {'test.org_wide':'false','test.buildings':A}, [[2026,ORG,null],[2026,ORG,[A]],[2026,ORG,[B]],[2026,ORG,[A,B]]]],
  ['toà A và B', {'test.org_wide':'false','test.buildings':[A,B].join(',')}, [[2026,ORG,null],[2026,ORG,[B]],[2025,ORG,null]]],
  ['xem được phiếu hạn chế', {'test.restricted':'true'}, [[2026,ORG,null],[2026,ORG,[A]]]],
  ['công ty khác là sandbox', {'test.sandbox_orgs':OTHER_ORG}, [[2026,ORG,null],[2026,OTHER_ORG,null]]],
  ['chính công ty là sandbox', {'test.sandbox_orgs':ORG}, [[2026,ORG,null]]],
];
for (const [name, settings, calls] of PARITY) {
  test(`TRƯỚC/SAU (${name}): cashbook_cash_flow_v1 và hàm dòng trả y hệt với thân 20261023150607 và vỏ mới`, () => inCase(async () => {
    await seedRich();
    // Tuần tự: mỗi lời gọi dùng SAVEPOINT + SET LOCAL ROLE trên cùng một kết nối.
    const measure = async () => {
      const reports = [], raw = [];
      for (const args of calls) reports.push(await report(...args).catch(error => `${error.code} ${error.message}`));
      for (const args of [[ORG,'2026-01-01','2026-12-31',null],[ORG,'2026-01-01','2026-12-31',[A]],[OTHER_ORG,'2026-01-01','2026-12-31',null]]) {
        raw.push(await rawRows(...args).catch(error => `${error.code} ${error.message}`));
      }
      return { reports, raw };
    };
    expect(await prosrcOf(SIGNATURE[ROWS])).toBe(bodyOf(rowsSql));
    const after = await measure();
    await db.exec(oldRowsSql);
    expect(await prosrcOf(SIGNATURE[ROWS])).toBe(bodyOf(oldRowsSql));
    const before = await measure();
    expect(after).toEqual(before);
    expect([...after.reports, ...after.raw].every(Array.isArray), 'không lời gọi nào lỗi').toBe(true);
    if (name === 'toàn công ty') {
      const year = after.reports[0];
      expect(year.filter(row => row.income !== 0).length).toBeGreaterThan(4);
      expect(year.filter(row => row.expense !== 0).length).toBeGreaterThan(4);
      expect(after.raw[0].length).toBeGreaterThan(30);
    }
  }, { ...RICH, ...settings }));
}

test('TRƯỚC/SAU: phiếu trộn nhiều dòng posting vẫn bị từ chối y như cũ', () => inCase(async () => {
  await seedRich();
  await db.query('INSERT INTO income_expense_posting_lines(organization_id,posting_id,account_id,signed_amount,line_kind) VALUES($1,$2,$3,5,$4)',[ORG,uid(1065),VIRTUAL_BOOK,'CHANGE']);
  const after = await failure(report());
  await db.exec(oldRowsSql);
  expect(await failure(report())).toBe(after);
  expect(after).toMatch(/^22023 cash_flow_mixed_transfer_items/);
}, RICH));

// Đột biến thay thân SQL thật trong giao dịch rồi ROLLBACK; không sửa file nguồn.
// Cùng lời gọi/hàng fixture phải xanh với bản sống và sai tiền với mỗi bản đột biến.
// Các dòng kiểm của hàm dòng cũ nay nằm ở thân hàm có loại phiếu (vỏ chỉ gọi nó).
function replaceOnce(source, from, to) {
  expect(source.split(from).length - 1, `mutation target: ${from}`).toBe(1);
  return source.replace(from,() => to);
}
const mutations = [
  ['sổ ảo', 'AND a.deleted_at IS NULL AND NOT COALESCE(a.is_virtual, false)', 'AND a.deleted_at IS NULL', async () => { await post(1,900,undefined,{book:VIRTUAL_BOOK}); }, [0,0,0]],
  ['org hiện tại', 'WHERE p.organization_id = p_organization_id', 'WHERE true', async () => { await post(1,900,undefined,{org:OTHER_ORG,book:OTHER_BOOK,building:FOREIGN_BUILDING}); }, [0,0,0]],
  ['org DEMO', 'org.id = p.organization_id AND NOT org.is_demo', 'org.id = p.organization_id', async () => {
    await post(1,900); await db.query('UPDATE organizations SET is_demo=true WHERE id=$1',[ORG]);
  }, [0,0,0]],
  ['sổ nhìn thấy', 'AND pl.account_id IN (SELECT visible.cashbook_id FROM app_private.ie_visible_cashbook_ids_v1() visible)', '',
    async () => { await post(1,900,undefined,{book:HIDDEN_BOOK}); }, [0,0,0]],
  ['event REVERSAL', "AND p.event_kind = 'POSTING'", "AND p.event_kind IN ('POSTING','REVERSAL')",
    async () => { await post(1,-900,undefined,{kind:'REVERSAL',reversal:uid(99999)}); }, [0,0,0]],
  ['posting đã hoàn tác', "AND reversal.reversal_of_id = p.id AND reversal.event_kind = 'REVERSAL'", "AND false",
    async () => { const original=await post(1,900); await post(2,-900,'2027-01-01',{kind:'REVERSAL',reversal:original.posting}); }, [0,0,0]],
  ['phiếu bàn giao theo nguồn', "AND COALESCE(ie.system_source, '') <> 'handover.transfer'", '',
    async () => { await post(1,900,undefined,{source:'handover.transfer'}); }, [0,0,0]],
  ['phiếu bàn giao theo phiên', 'AND ie.handover_transfer_id IS NULL', '',
    async () => { await post(1,900,undefined,{transfer:uid(9000)}); }, [0,0,0]],
  ['loại hạng mục bàn giao', 'IF r.internal_amount > 0 THEN', 'IF false THEN',
    async () => { await post(1,900,undefined,{category:TRANSFER}); }, [0,0,0]],
  ['phiếu chi hoàn tác đối ứng', 'AND ie.reversal_of_income_expense_id IS NULL', '',
    async () => { const original=await post(1,900); await post(2,-900,undefined,{counter:original.voucher}); }, [0,0,0]],
  ['phiếu gốc có đối ứng', 'counter.organization_id = p.organization_id AND counter.reversal_of_income_expense_id = ie.id', 'false',
    async () => { const original=await post(1,900); await post(2,-900,undefined,{counter:original.voucher}); }, [0,0,0]],
  ['phiếu hạn chế', 'AND (NOT COALESCE(ie.has_restricted_item, false) OR ie.user_id = auth.uid() OR v_can_restricted)', '',
    async () => { await post(1,900,undefined,{restricted:true,actor:uid(999)}); }, [0,0,0]],
  ['không làm mất lịch sử toà soft-delete', 'LEFT JOIN public.buildings b ON b.id = ie.building_id AND b.organization_id = p.organization_id',
    'LEFT JOIN public.buildings b ON b.id = ie.building_id AND b.organization_id = p.organization_id AND b.deleted_at IS NULL',
    async () => { await post(1,900); await db.query('UPDATE buildings SET deleted_at=$1 WHERE id=$2',['2026-10-01',A]); }, [900,0,900]],
  ['owner DEMO của sổ', 'AND NOT COALESCE(a.user_id = ANY(v_demo_users), false)', '',
    async () => { await post(1,900); await db.query('UPDATE accounts SET user_id=$1 WHERE id=$2',[DEMO_USER,BOOK]); }, [0,0,0]],
  ['owner DEMO của phiếu', 'AND NOT COALESCE(ie.user_id = ANY(v_demo_users), false)', '',
    async () => { await post(1,900,undefined,{actor:DEMO_USER}); }, [0,0,0]],
  ['owner DEMO của toà', 'AND NOT COALESCE(b.user_id = ANY(v_demo_users), false)', '',
    async () => { await post(1,900); await db.query('UPDATE buildings SET user_id=$1 WHERE id=$2',[DEMO_USER,A]); }, [0,0,0]],
  ['org sandbox chính thức', 'AND NOT COALESCE(p.organization_id = ANY(public.sandbox_org_ids()), false)', '',
    async () => { await post(1,900); await db.query("SELECT set_config('test.sandbox_orgs',$1,true)",[ORG]); }, [0,0,0]],
  ['NULL voucher không mất posting lương', 'AND NOT COALESCE(ie.user_id = ANY(v_demo_users), false)', 'AND NOT (ie.user_id = ANY(v_demo_users))',
    async () => { await post(1,-100,undefined,{noVoucher:true}); }, [0,100,-100]],
];
for (const [name,from,to,setup,expected] of mutations) {
  test(`đột biến bị bắt: ${name}`, () => inCase(async () => {
    await setup();
    expect(amounts(await report())).toEqual(expected);
    await db.exec(replaceOnce(voucherRowsSql,from,to));
    expect(amounts(await report())).not.toEqual(expected);
  }));
}

test('helper public không bỏ qua quyền khi gọi trực tiếp; đột biến membership và scope đều bị bắt', async () => {
  async function direct() {
    await db.exec('SAVEPOINT direct_call; SET LOCAL ROLE authenticated');
    try {
      const value=await db.query(`SELECT * FROM ${ROWS}($1,'2026-01-01','2026-12-31',null)`,[ORG]);
      await db.exec('RESET ROLE; RELEASE SAVEPOINT direct_call');
      return value.rows;
    } catch(error) { await db.exec('ROLLBACK TO SAVEPOINT direct_call; RELEASE SAVEPOINT direct_call'); throw error; }
  }
  for (const [settings,from,to] of [
    [{'request.jwt.claim.sub':uid(999)}, 'OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false)', ''],
    [{'test.allowed':'false'}, "IF v_scope->'allowed' IS DISTINCT FROM 'true'::jsonb THEN", 'IF false THEN'],
  ]) await inCase(async () => {
    await post(1,100);
    await expect(direct()).rejects.toThrow(/cash_flow_denied/);
    await db.exec(replaceOnce(voucherRowsSql,from,to));
    expect(await direct()).toHaveLength(1);
  },settings);
});

// Đột biến trên phần MỚI (luật profit_kind ở hàm có loại phiếu, cột/quyền ở hàm báo cáo lợi nhuận).
const SHAREHOLDER_CASE = `        WHEN ie.system_source IN ('profit.ledger_payout', 'profit.distribution')
          OR ie.shareholder_id IS NOT NULL OR items.shareholder_item THEN 'SHAREHOLDER'
`;
const MANAGER_CASE = `        WHEN ie.system_source IN ('profit.manager_salary', 'salary.manager')
          OR ie.profit_manager_id IS NOT NULL OR items.manager_item THEN 'MANAGER'
`;
const paidAt = (period, ...args) => async () => paid(await payout(...args), period);
const outcome = (...args) => () => failure(payout(...args));
const payoutMutations = [
  ['chỉ cộng dòng âm vào cột cổ đông', PAYOUT, "f.signed_amount < 0 AND f.profit_kind = 'SHAREHOLDER'", "f.profit_kind = 'SHAREHOLDER'", paidAt('2026-02'), [3000,100]],
  ['chỉ cộng dòng âm vào cột lương điều hành', PAYOUT, "f.signed_amount < 0 AND f.profit_kind = 'MANAGER'", "f.profit_kind = 'MANAGER'", paidAt('2026-02'), [3000,100]],
  ['cột cổ đông không đọc loại lương điều hành', PAYOUT, "f.profit_kind = 'SHAREHOLDER'), 0) AS sh", "f.profit_kind = 'MANAGER'), 0) AS sh", paidAt('2026-02'), [3000,100]],
  ['dòng vào đúng tháng', PAYOUT, 'extract(month FROM f.day) = m.n', 'true', paidAt('2026-02'), [3000,100]],
  ['quý gom đúng ba tháng', PAYOUT, '(months.n - 1) / 3 + 1 = q.n', 'months.n / 3 + 1 = q.n', paidAt('2026-Q1'), [7000,300]],
  ['nhãn SHAREHOLDER', VOUCHER_ROWS, "OR items.shareholder_item THEN 'SHAREHOLDER'", "OR items.shareholder_item THEN 'MANAGER'", paidAt('2026-02'), [3000,100]],
  ['cổ đông được xét trước lương điều hành', VOUCHER_ROWS, SHAREHOLDER_CASE + MANAGER_CASE, MANAGER_CASE + SHAREHOLDER_CASE, paidAt('2026-06'), [32000,500]],
  ['nguồn profit.ledger_payout', VOUCHER_ROWS, "IN ('profit.ledger_payout', 'profit.distribution')", "IN ('profit.distribution')", paidAt('2026-02'), [3000,100]],
  ['nguồn profit.distribution', VOUCHER_ROWS, "IN ('profit.ledger_payout', 'profit.distribution')", "IN ('profit.ledger_payout')", paidAt('2026-02'), [3000,100]],
  ['phiếu có shareholder_id', VOUCHER_ROWS, 'OR ie.shareholder_id IS NOT NULL OR items.shareholder_item', 'OR items.shareholder_item', paidAt('2026-03'), [4000,200]],
  ['hạng mục chia_loi_nhuan', VOUCHER_ROWS, 'OR items.shareholder_item THEN', 'THEN', paidAt('2026-04'), [8990,300]],
  ['hạng mục đã gộp vào chia_loi_nhuan', VOUCHER_ROWS, "COALESCE(t.rule_key = 'chia_loi_nhuan' OR canonical.rule_key = 'chia_loi_nhuan', false)",
    "COALESCE(t.rule_key = 'chia_loi_nhuan', false)", paidAt('2026-05'), [16000,400]],
  ['nguồn profit.manager_salary', VOUCHER_ROWS, "IN ('profit.manager_salary', 'salary.manager')", "IN ('salary.manager')", paidAt('2026-02'), [3000,100]],
  ['nguồn salary.manager', VOUCHER_ROWS, "IN ('profit.manager_salary', 'salary.manager')", "IN ('profit.manager_salary')", paidAt('2026-03'), [4000,200]],
  ['phiếu có profit_manager_id', VOUCHER_ROWS, 'OR ie.profit_manager_id IS NOT NULL OR items.manager_item', 'OR items.manager_item', paidAt('2026-04'), [8990,300]],
  ['hạng mục luong_dieu_hanh', VOUCHER_ROWS, 'OR items.manager_item THEN', 'THEN', paidAt('2026-05'), [16000,400]],
  ['hạng mục đã gộp vào luong_dieu_hanh', VOUCHER_ROWS, "COALESCE(t.rule_key = 'luong_dieu_hanh' OR canonical.rule_key = 'luong_dieu_hanh', false)",
    "COALESCE(t.rule_key = 'luong_dieu_hanh', false)", paidAt('2026-06'), [32000,500]],
  ['gán profit_kind cho từng dòng', VOUCHER_ROWS, '    profit_kind := r.ie_profit_kind;\n', '', paidAt('2026-02'), [3000,100]],
  ['kiểm khoá lợi nhuận', PAYOUT, 'IF NOT (app_private.profit_viewer_can_v1(', 'IF false AND NOT (app_private.profit_viewer_can_v1(',
    outcome(), '42501 cash_flow_profit_denied', {'test.profit_keys':''}],
  ['khoá shareholder_profit.distribute', PAYOUT, "app_private.profit_viewer_can_v1(p_organization_id, 'shareholder_profit.distribute')\n      OR ", '',
    outcome(), 'ok', {'test.profit_keys':PROFIT_KEYS[0]}],
  ['khoá shareholder_profit.lock', PAYOUT, "\n      OR app_private.profit_viewer_can_v1(p_organization_id, 'shareholder_profit.lock')", '',
    outcome(), 'ok', {'test.profit_keys':PROFIT_KEYS[1]}],
  ['khoá shareholder_profit.view_building_totals', PAYOUT, "\n      OR app_private.profit_viewer_can_v1(p_organization_id, 'shareholder_profit.view_building_totals')", '',
    outcome(), 'ok', {'test.profit_keys':PROFIT_KEYS[2]}],
  ['kiểm reports_finance.cash_flow trước khoá lợi nhuận', PAYOUT, "IF v_scope->'allowed' IS DISTINCT FROM 'true'::jsonb THEN", 'IF false THEN',
    outcome(), '42501 cash_flow_denied', {'test.allowed':'false','test.profit_keys':''}],
  ['kiểm thành viên công ty trước khoá lợi nhuận', PAYOUT, '\n    OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false) THEN', ' THEN',
    outcome(), '42501 cash_flow_denied', {'request.jwt.claim.sub':uid(999),'test.profit_keys':''}],
  ['toà theo tham số giao với phạm vi', PAYOUT, "    WHERE v_scope->'buildingIds' ? x::text;", '    ;',
    async () => (await payout(2026,ORG,[B])).length, 0, {'test.org_wide':'false','test.buildings':A}],
];
for (const [name, fn, from, to, measure, expected, settings = {}] of payoutMutations) {
  test(`đột biến cột lợi nhuận bị bắt: ${name}`, () => inCase(async () => {
    await seedProfit();
    expect(await measure()).toEqual(expected);
    await db.exec(replaceOnce(fn === PAYOUT ? payoutSql : voucherRowsSql, from, to));
    expect(await measure()).not.toEqual(expected);
  }, settings));
}

// Khối ghim của M5 ($truoc$/$sau$): chạy lại trên thân đã rà thì qua; lệch thì dừng 55000.
// Dựng đúng trạng thái "trước M5" và "sau M5" trong giao dịch (không phụ thuộc migration sau M5).
async function runM5(sql = m5Body) {
  await db.exec('SAVEPOINT m5_run');
  try { await db.exec(sql); await db.exec('RELEASE SAVEPOINT m5_run'); return 'ok'; }
  catch (error) { await db.exec('ROLLBACK TO SAVEPOINT m5_run; RELEASE SAVEPOINT m5_run'); return `${error.code} ${error.message}`; }
}
async function stateBeforeM5() {
  await db.exec(definitionOf(liveDefinitionOf(REPORT, m5.name).sql, REPORT));
  await db.exec(oldRowsSql);
  await db.exec(`DROP FUNCTION IF EXISTS ${SIGNATURE[VOUCHER_ROWS]}; DROP FUNCTION IF EXISTS ${SIGNATURE[PAYOUT]};`);
}
const withComment = sql => replaceOnce(sql, '\nEND\n$fn$;', '\n-- thân lạ\nEND\n$fn$;');
test('khối ghim M5: hai lượt từ trạng thái production đều qua; thân lạ, thiếu nền, sai kiểu hàm hay ACL đều dừng 55000', () => inCase(async () => {
  await stateBeforeM5();
  expect(await runM5()).toBe('ok');
  expect(await runM5()).toBe('ok');
  for (const [label, prepare, sql, pattern] of [
    ['vỏ mang thân lạ', () => db.exec(withComment(oldRowsSql)), m5Body, /^55000 public\.cash_flow_external_rows_v1\(uuid,date,date,uuid\[\]\) đã đổi/],
    ['báo cáo mang thân lạ', () => db.exec(withComment(reportSql)), m5Body, /^55000 public\.cashbook_cash_flow_v1\(uuid,integer,uuid\[\]\) đã đổi/],
    ['hàm có loại phiếu mang thân lạ', () => db.exec(withComment(voucherRowsSql)), m5Body, /^55000 app_private\.cash_flow_external_voucher_rows_v1\(uuid,date,date,uuid\[\]\) đã đổi/],
    ['hàm báo cáo lợi nhuận mang thân lạ', () => db.exec(withComment(payoutSql)), m5Body, /^55000 public\.cashbook_cash_flow_profit_payout_v1\(uuid,integer,uuid\[\]\) đã đổi/],
    ['thiếu helper quyền lợi nhuận', () => db.exec('DROP FUNCTION app_private.profit_viewer_can_v1(uuid,text)'), m5Body, /^55000 Thiếu hàm nền của dòng tiền: app_private\.profit_viewer_can_v1/],
    ['thiếu cột profit_manager_id', () => db.exec('ALTER TABLE public.income_expenses DROP COLUMN profit_manager_id'), m5Body, /^55000 Thiếu cột nền: public\.income_expenses\.profit_manager_id/],
    ['ACL: hàm có loại phiếu lỡ cấp cho authenticated', async () => {}, m5Body.replace(`COMMENT ON FUNCTION ${SIGNATURE[VOUCHER_ROWS]} IS`,
      `GRANT EXECUTE ON FUNCTION ${SIGNATURE[VOUCHER_ROWS]} TO authenticated;\nCOMMENT ON FUNCTION ${SIGNATURE[VOUCHER_ROWS]} IS`), /^55000 Hậu kiểm: ACL của app_private\.cash_flow_external_voucher_rows_v1/],
    ['kiểu hàm: hàm có loại phiếu thành INVOKER', async () => {}, replaceOnce(m5Body, 'profit_kind text)\nLANGUAGE plpgsql STABLE SECURITY DEFINER', 'profit_kind text)\nLANGUAGE plpgsql STABLE SECURITY INVOKER'),
      /^55000 Hậu kiểm: app_private\.cash_flow_external_voucher_rows_v1\(uuid,date,date,uuid\[\]\) phải tồn tại, SECURITY DEFINER/],
    ['thân vỏ khác bản đã ghim', async () => {}, replaceOnce(m5Body, '  RETURN QUERY SELECT r.day, r.building_id, r.signed_amount\n', '  RETURN QUERY SELECT r.day, r.building_id, r.signed_amount \n'),
      /^55000 Hậu kiểm: public\.cash_flow_external_rows_v1 không mang thân vỏ/],
  ]) {
    await db.exec('SAVEPOINT guard_case');
    await prepare();
    expect(await runM5(sql), label).toMatch(pattern);
    await db.exec('ROLLBACK TO SAVEPOINT guard_case; RELEASE SAVEPOINT guard_case');
  }
  // Từ trạng thái production: quên GRANT cho authenticated thì hậu kiểm chặn.
  await stateBeforeM5();
  expect(await runM5(replaceOnce(m5Body, `GRANT EXECUTE ON FUNCTION ${SIGNATURE[PAYOUT]} TO authenticated;\n`, '')))
    .toMatch(/^55000 Hậu kiểm: ACL của public\.cashbook_cash_flow_profit_payout_v1/);
}));

test('sau đột biến: catalog đã khôi phục đúng thân SQL cuối của cả bốn hàm', async () => {
  for (const [name,sql] of [[REPORT,reportSql],[ROWS,rowsSql],[VOUCHER_ROWS,voucherRowsSql],[PAYOUT,payoutSql]]) {
    const expected = bodyOf(sql);
    expect(expected, name).toBeTruthy();
    const { rows } = await db.query(`SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname=$1`,[name]);
    expect(rows, name).toHaveLength(1);
    expect(rows[0].prosrc, name).toBe(expected);
  }
});
