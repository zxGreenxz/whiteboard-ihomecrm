// Dòng tiền năm: thực thi định nghĩa SQL cuối trong repo trên PGlite dùng một lần.
// Scope/membership/RLS là fixture tổng hợp có cùng chữ ký, KHÔNG chứng minh JWT,
// PostgREST hay policy production. Mọi ID/số tiền bên dưới là dữ liệu tổng hợp.
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const migrationDir = new URL('../../supabase/migrations/', import.meta.url);
const REPORT = 'public.cashbook_cash_flow_v1';
const ROWS = 'public.cash_flow_external_rows_v1';
function definitionOf(source, name) {
  const starts = [...source.matchAll(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${name.replaceAll('.', '\\.')}\\(`, 'g'))];
  if (!starts.length) throw new Error(`missing ${name}`);
  const start = starts.at(-1).index;
  const open = /AS\s+(\$[A-Za-z_]*\$)/.exec(source.slice(start));
  if (!open) throw new Error(`missing body ${name}`);
  const close = source.indexOf(open[1], start + open.index + open[0].length);
  return source.slice(start, source.indexOf(';', close + open[1].length) + 1);
}
const definitions = readdirSync(migrationDir).filter(name => name.endsWith('.sql')).sort().flatMap(name => {
  const sql = readFileSync(new URL(name, migrationDir), 'utf8');
  return sql.includes(`FUNCTION ${REPORT}(`) ? [{ name, sql }] : [];
});
const candidate = definitions.at(-1);
const previous = definitions.at(-2);
const reportSql = definitionOf(candidate.sql, REPORT);
const rowsSql = definitionOf(candidate.sql, ROWS);
const uid = n => `cf000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = uid(1), OTHER_ORG = uid(2), DEMO_ORG = uid(3), USER = uid(4), DEMO_USER = uid(5);
const A = uid(10), B = uid(11), FOREIGN_BUILDING = uid(12);
const BOOK = uid(20), HIDDEN_BOOK = uid(21), VIRTUAL_BOOK = uid(22), DEMO_BOOK = uid(23), OTHER_BOOK = uid(24), DEMO_ORG_BOOK = uid(25);
const RENT = uid(30), DEPOSIT = uid(31), TRANSFER = uid(32), LEGACY_TRANSFER = uid(33), DIVIDEND = uid(34);
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
      reversed_by_posting_id uuid,has_restricted_item boolean DEFAULT false,posting_mode text DEFAULT 'CASHBOOK');
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
    CREATE FUNCTION public.can_view_restricted_ie() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.super',true)='true' $$;
    CREATE FUNCTION public.demo_user_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['${DEMO_USER}'::uuid] $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
      SELECT coalesce(string_to_array(nullif(current_setting('test.sandbox_orgs',true),''),',')::uuid[],'{}'::uuid[]) $$;
    CREATE FUNCTION app_private.finance_v2_can_read_posting_v1(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT $1=ANY(public.my_org_ids()) AND $2 IN (SELECT cashbook_id FROM app_private.ie_visible_cashbook_ids_v1()) $$;
    GRANT USAGE ON SCHEMA public,auth TO authenticated;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
    INSERT INTO public.organizations VALUES('${ORG}',false,'ACTIVE'),('${OTHER_ORG}',false,'ACTIVE'),('${DEMO_ORG}',true,'ACTIVE');
    INSERT INTO public.accounts(id,organization_id,code,is_virtual) VALUES
      ('${BOOK}','${ORG}','CASH',false),('${HIDDEN_BOOK}','${ORG}','HIDDEN',false),('${VIRTUAL_BOOK}','${ORG}','CHANGE',true),
      ('${DEMO_BOOK}','${ORG}','DEMO-CASH',false),('${OTHER_BOOK}','${OTHER_ORG}','OTHER',false),('${DEMO_ORG_BOOK}','${DEMO_ORG}','CASH',false);
    INSERT INTO public.buildings(id,organization_id) VALUES('${A}','${ORG}'),('${B}','${ORG}'),('${FOREIGN_BUILDING}','${OTHER_ORG}');
    INSERT INTO public.income_expense_types(id,organization_id,name,rule_key,category) VALUES
      ('${RENT}','${ORG}','Tiền thuê','rent','REVENUE'),('${DEPOSIT}','${ORG}','Tiền cọc','deposit','DEPOSIT'),
      ('${TRANSFER}','${ORG}','Bàn giao','noi_bo','INTERNAL'),('${LEGACY_TRANSFER}','${ORG}','Bàn giao tiền mặt',null,'INTERNAL'),
      ('${DIVIDEND}','${ORG}','Chi lợi nhuận','profit_distribution','INTERNAL');
    ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_accounts ON public.accounts FOR SELECT TO authenticated USING(id IN (SELECT cashbook_id FROM app_private.ie_visible_cashbook_ids_v1()));
    ALTER TABLE public.income_expenses ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_vouchers ON public.income_expenses FOR SELECT TO authenticated USING(public.can_access_building(building_id) AND NOT has_restricted_item);
    ALTER TABLE public.income_expense_postings ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_postings ON public.income_expense_postings FOR SELECT TO authenticated USING(app_private.finance_v2_can_read_posting_v1(organization_id,account_id));
    ALTER TABLE public.income_expense_posting_lines ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_lines ON public.income_expense_posting_lines FOR SELECT TO authenticated USING(app_private.finance_v2_can_read_posting_v1(organization_id,account_id));`);
  await db.exec(definitionOf(readFileSync(new URL('20260708130100_nrm_vn_resolve_fixed_expense_type.sql', migrationDir), 'utf8'), 'public.nrm_vn'));
  await db.exec(definitionOf(previous.sql, REPORT));
  await db.exec(candidate.sql);
  await db.exec(candidate.sql);
}, 30000);
afterAll(async () => { await db?.close(); });

async function inCase(work, options = {}) {
  await db.exec('BEGIN');
  try {
    const settings = { 'request.jwt.claim.sub': USER, 'test.allowed': 'true', 'test.org_wide': 'true', 'test.super':'false', 'test.sandbox_orgs':'',
      'test.buildings': [A,B,FOREIGN_BUILDING].join(','), 'test.books': [BOOK,VIRTUAL_BOOK,DEMO_BOOK,OTHER_BOOK,DEMO_ORG_BOOK].join(','), ...options };
    for (const [name,value] of Object.entries(settings)) await db.query('SELECT set_config($1,$2,true)', [name,value]);
    return await work();
  } finally { await db.exec('ROLLBACK'); }
}
async function post(n, amount, on = '2026-08-12', options = {}) {
  const { org = ORG, book = BOOK, building = A, category = RENT, source = null, transfer = null,
    reversal = null, kind = 'POSTING', counter = null, status = 'APPROVED', restricted = false, noVoucher = false, actor = USER } = options;
  const posting = uid(1000+n), voucher = noVoucher ? null : uid(2000+n);
  if (voucher) {
    await db.query(`INSERT INTO income_expenses(id,organization_id,building_id,user_id,type,account_id,code,voucher_date,total_amount,system_source,
      handover_transfer_id,reversal_of_income_expense_id,approval_status,has_restricted_item) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [voucher,org,building,actor,amount>0?'INCOME':'EXPENSE',book,`FIXTURE-${n}`,on,Math.abs(amount),source,transfer,counter,status,restricted]);
    await db.query('INSERT INTO income_expense_items(income_expense_id,income_expense_type_id,amount,unit_price,organization_id) VALUES($1,$2,$3,$3,$4)',[voucher,category,Math.abs(amount),org]);
  }
  await db.query(`INSERT INTO income_expense_postings(id,organization_id,voucher_id,event_kind,posted_on,reversal_of_id,account_id,posting_subject_id,net_cash_effect,voucher_amount_snapshot,posting_subject_kind)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[posting,org,voucher,kind,on,reversal,book,voucher??posting,amount,Math.abs(amount),noVoucher?'SALARY_TRANCHE':'VOUCHER']);
  await db.query('INSERT INTO income_expense_posting_lines(organization_id,posting_id,account_id,signed_amount) VALUES($1,$2,$3,$4)',[org,posting,book,amount]);
  return { posting, voucher };
}
async function report(year = 2026, org = ORG, buildings = null, role = 'authenticated') {
  await db.exec('SAVEPOINT report_call');
  await db.exec(`SET LOCAL ROLE ${role}`);
  try {
    const { rows } = await db.query(`SELECT * FROM ${REPORT}($1,$2,$3)`,[org,year,buildings]);
    await db.exec('RESET ROLE; RELEASE SAVEPOINT report_call');
    return rows.map(row => ({ ...row, income: Number(row.income), expense: Number(row.expense), net: Number(row.net) }));
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT report_call; RELEASE SAVEPOINT report_call');
    throw error;
  }
}
const amounts = (rows, period = '2026-08') => {
  const row = rows.find(row => row.period === period);
  return row ? [row.income,row.expense,row.net] : null;
};

test('SQL cuối chạy idempotent, INVOKER ngoài và helper DEFINER không mở anon/service', () => inCase(async () => {
  const { rows } = await db.query(`SELECT n.nspname||'.'||p.proname name,p.prosecdef definer,p.provolatile volatility,
    has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('service_role',p.oid,'EXECUTE') service
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname=ANY($1)`,[[REPORT,ROWS]]);
  expect(rows).toHaveLength(2);
  for (const row of rows) expect(row).toMatchObject({ definer: row.name===ROWS, volatility:'s', anon:false, service:false });
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

// Đột biến thay thân SQL thật trong giao dịch rồi ROLLBACK; không sửa file nguồn.
// Cùng lời gọi/hàng fixture phải xanh với bản sống và sai tiền với mỗi bản đột biến.
function replaceOnce(source, from, to) {
  expect(source.split(from).length - 1, `mutation target: ${from}`).toBe(1);
  return source.replace(from,to);
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
    await db.exec(replaceOnce(rowsSql,from,to));
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
    await db.exec(replaceOnce(rowsSql,from,to));
    expect(await direct()).toHaveLength(1);
  },settings);
});

test('sau đột biến: catalog đã khôi phục đúng thân SQL cuối', async () => {
  for (const [name,sql] of [[REPORT,reportSql],[ROWS,rowsSql]]) {
    const expected = sql.match(/AS\s+\$fn\$([\s\S]*)\$fn\$;/)?.[1];
    expect(expected).toBeTruthy();
    const { rows } = await db.query(`SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname=$1`,[name]);
    expect(rows[0].prosrc).toBe(expected);
  }
});
