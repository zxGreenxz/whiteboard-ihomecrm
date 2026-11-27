import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const db = new PGlite();
const org = "10000000-0000-4000-8000-000000000001";
const house = "20000000-0000-4000-8000-000000000001";
const room = "30000000-0000-4000-8000-000000000001";
const contract = "40000000-0000-4000-8000-000000000001";
const invoice = "50000000-0000-4000-8000-000000000001";
const voucher = "60000000-0000-4000-8000-000000000001";
const migration = readFileSync("supabase/migrations/20261127085824_du_kien_doanh_thu_co_dong.sql","utf8");

beforeAll(async () => {
  await db.exec(`
    CREATE SCHEMA app_private;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS 'SELECT ARRAY[]::uuid[]';
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS 'SELECT false';
    CREATE FUNCTION app_private.ie_actor_is_company_owner_v1(uuid,uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false';
    CREATE FUNCTION app_private.profit_viewer_can_v1(uuid,text) RETURNS boolean LANGUAGE sql AS 'SELECT false';
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE buildings(id uuid,organization_id uuid,hidden_fixed_expenses text[],has_elevator boolean);
    CREATE TABLE rooms(id uuid,organization_id uuid,building_id uuid);
    CREATE TABLE contracts(id uuid,rent_price numeric,start_date date,start_billing_date date,end_date date,
      expected_move_out_date date,actual_end_date date,organization_id uuid,room_id uuid,deleted_at date,status text,signed_date date);
    CREATE TABLE invoices(id uuid,contract_id uuid,organization_id uuid,building_id uuid,billing_month text,status text,deleted_at date,
      kind text,remaining_amount numeric,total_amount numeric,paid_amount numeric,subtotal numeric,discount_amount numeric);
    CREATE TABLE invoice_items(invoice_id uuid,accounting_class text,type text,amount numeric,from_date date,to_date date);
    CREATE TABLE income_expenses(id uuid,organization_id uuid,invoice_id uuid,name text);
    CREATE TABLE income_expense_types(id uuid,organization_id uuid,fee_category text,category text,name text);
    CREATE TABLE building_fee_accounts(building_id uuid,organization_id uuid,fee_category text,deleted_at date,default_amount numeric);
    CREATE TABLE app_private.landlord_operations(organization_id uuid,building_id uuid,is_active boolean,effective_from date);
    CREATE TABLE app_private.contract_rent_support_months(agreed_amount numeric,plan_id uuid,organization_id uuid,contract_id uuid,billing_month text);
    CREATE TABLE app_private.contract_rent_support_plans(id uuid,organization_id uuid,state text,contract_id uuid,revision bigint);
    CREATE TABLE app_private.rent_support_invoice_claims(organization_id uuid,contract_id uuid,billing_month text,released_at date);
    CREATE TABLE fixture_lines(month date,voucher_id uuid,approval_status text,side text,amount numeric,type_id uuid);
    CREATE FUNCTION app_private.landlord_kqkd_lines_v2(uuid,date,date) RETURNS SETOF fixture_lines LANGUAGE sql AS 'SELECT * FROM public.fixture_lines WHERE month BETWEEN $2 AND $3';
    CREATE FUNCTION public.fee_type_matches(text,text,text) RETURNS boolean LANGUAGE sql AS 'SELECT $1=$3';
    ALTER TABLE contracts ADD COLUMN discounts jsonb;
    CREATE TABLE app_private.room_transfer_rent_events(organization_id uuid,contract_id uuid,move_date date,old_rent numeric);
    CREATE TABLE contract_transfers(contract_id uuid,transfer_type text,status text,move_in_date date,transfer_date date);
    CREATE FUNCTION app_private.room_transfer_rent_for_period_v1(uuid,uuid,date,date) RETURNS numeric LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('test.split_override',true)='yes' THEN RAISE EXCEPTION 'Kỳ lệch giá thỏa thuận' USING ERRCODE='55000'; END IF;
        RETURN NULL;
      END $$;
    ALTER TABLE rooms ADD COLUMN name text DEFAULT 'P101';
    ALTER TABLE income_expenses ADD COLUMN code text DEFAULT 'PT-TEST', ADD COLUMN voucher_date date,
      ADD COLUMN has_restricted_item boolean DEFAULT false, ADD COLUMN room_id uuid, ADD COLUMN building_id uuid DEFAULT '${house}';
    ALTER TABLE income_expense_types ADD COLUMN is_restricted boolean DEFAULT false;
    ALTER TABLE invoices ADD COLUMN room_id uuid DEFAULT '${room}', ADD COLUMN invoice_number text DEFAULT 'HĐ-TEST';
    CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql AS
      $$ SELECT current_setting('test.invoice_access',true) IS DISTINCT FROM 'denied' $$;
    CREATE FUNCTION app_private.ie_supplement_can_read_v1(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';
    CREATE FUNCTION public.income_voucher_splittable_v1(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';
    CREATE FUNCTION public.invoice_amount_parts_for_v1(uuid,numeric) RETURNS jsonb LANGUAGE sql AS
      $$ SELECT jsonb_build_object('rent',$2) $$;
    INSERT INTO buildings VALUES ('${house}','${org}','{}',false);
    INSERT INTO rooms VALUES ('${room}','${org}','${house}');
  `);
  await db.exec(migration);
},30000);
afterAll(()=>db.close());

async function inputs(setup: string) {
  return db.transaction(async tx=>{
    await tx.exec("TRUNCATE contracts,invoices,invoice_items,income_expenses,income_expense_types,fixture_lines,building_fee_accounts");
    if (setup) await tx.exec(setup);
    const result = await tx.query<Record<string,string> & {detail_lines: {bucket:string; label:string; amount:number; room?:string}[]}>(
      "SELECT * FROM app_private.forecast_house_report_v1($1,$2,'2025-11-01',true)",[org,house]);
    return result.rows[0];
  });
}
const lease = `INSERT INTO contracts VALUES ('${contract}',3000000,'2025-11-01','2025-11-01','2026-10-31',
  NULL,'2025-11-15','${org}','${room}',NULL,'TERMINATED','2025-10-20');`;

describe("Dự kiến doanh thu của nhà",()=>{
  it("phòng trống cả tháng và chưa có hợp đồng có doanh thu dự kiến bằng 0",async()=>{
    const r=await inputs("");expect(Number(r.unbilled)).toBe(0);expect(Number(r.unpaid)).toBe(0);
  });
  it("chỉ dự kiến các ngày thực sự có hợp đồng, kể cả khách đã trả phòng",async()=>{
    expect(Number((await inputs(lease)).unbilled)).toBe(1500000);
  });
  it("ưu tiên ngày trả thực tế, kể cả khi trả sau ngày dự kiến",async()=>{
    const r=await inputs(lease+"UPDATE contracts SET expected_move_out_date='2025-11-05'");
    expect(Number(r.unbilled)).toBe(1500000);
  });
  it("báo khoản thuê cần đối chiếu khi kỳ chuyển phòng không tách được",async()=>{
    const r=await inputs(lease+"SET LOCAL test.split_override='yes'");
    expect(Number(r.unbilled)).toBe(0);
    expect(r.unknown_fees).toContain("rent_needs_review");
  });
  it("trừ khuyến mãi kiểu cũ còn lượt khi chưa có hóa đơn",async()=>{
    const discounted=lease+`UPDATE contracts SET discounts='{"months":1,"amount_per_month":300000}';`;
    expect(Number((await inputs(discounted)).unbilled)).toBe(1200000);
    const used=discounted+`INSERT INTO invoices VALUES ('${invoice}','${contract}','${org}','${house}','2025-10','PAID',NULL,'FIRST',0,0,0,0,0);`;
    expect(Number((await inputs(used)).unbilled)).toBe(1500000);
  });
  it("hóa đơn trả một phần thay cho tiền dự kiến, loại cọc và nợ mang sang",async()=>{
    const r=await inputs(lease+`
      INSERT INTO invoices VALUES ('${invoice}','${contract}','${org}','${house}','2025-11','PARTIAL_PAID',NULL,'MONTHLY',1700000,2200000,500000,2000000,0);
      INSERT INTO invoice_items VALUES ('${invoice}','REVENUE','RENT',1500000,'2025-11-01','2025-11-15'),('${invoice}','DEPOSIT','OTHER',500000,NULL,NULL);
      INSERT INTO income_expenses VALUES ('${voucher}','${org}','${invoice}','Phiếu thu');
      INSERT INTO fixture_lines VALUES ('2025-11-01','${voucher}','APPROVED','INCOME',500000,NULL);
    `);
    expect(Number(r.booked_income)).toBe(500000);expect(Number(r.unpaid)).toBe(1000000);expect(Number(r.unbilled)).toBe(0);
    expect(r.detail_lines).toEqual(expect.arrayContaining([
      expect.objectContaining({bucket:"booked_income",amount:500000,parts:{rent:500000}}),
      expect.objectContaining({bucket:"unpaid",room:"P101",amount:1000000}),
    ]));
  });
  it("giữ tổng của nhà và ẩn mã, thành phần hóa đơn khi người xem thiếu quyền đọc hóa đơn",async()=>{
    const r=await inputs(`
      SET LOCAL test.invoice_access='denied';
      INSERT INTO invoices VALUES ('${invoice}',NULL,'${org}','${house}','2025-11','PARTIAL_PAID',NULL,'MONTHLY',700000,800000,100000,800000,0);
      INSERT INTO income_expenses VALUES ('${voucher}','${org}','${invoice}','Phiếu thu');
      INSERT INTO fixture_lines VALUES ('2025-11-01','${voucher}','APPROVED','INCOME',100000,NULL);
    `);
    const unpaid=r.detail_lines.find(line=>line.bucket==="unpaid");
    const booked=r.detail_lines.find(line=>line.bucket==="booked_income");
    expect(unpaid).toEqual({bucket:"unpaid",label:"Hóa đơn còn phải thu",amount:700000});
    expect(booked).toMatchObject({amount:100000});
    expect(booked).not.toHaveProperty("parts");
  });
  it("kỳ đã lập hóa đơn tháng trước loại đúng các ngày trùng, phiếu hủy không giữ ngày",async()=>{
    const r=await inputs(lease+`
      INSERT INTO invoices VALUES ('${invoice}','${contract}','${org}','${house}','2025-10','PAID',NULL,'FIRST',0,900000,900000,900000,0);
      INSERT INTO invoice_items VALUES ('${invoice}','REVENUE','RENT',900000,'2025-10-29','2025-11-05');
    `);
    expect(Number(r.unbilled)).toBe(1000000);
    const cancelled=await inputs(lease+`
      INSERT INTO invoices VALUES ('${invoice}','${contract}','${org}','${house}','2025-11','CANCELLED',NULL,'MONTHLY',0,0,0,0,0);
      INSERT INTO invoice_items VALUES ('${invoice}','REVENUE','RENT',1500000,'2025-11-01','2025-11-15');
    `);
    expect(Number(cancelled.unbilled)).toBe(1500000);
  });
  it("phí đã có phiếu chờ duyệt chỉ dự kiến phần thiếu, điện thiếu định mức dùng kỳ trước",async()=>{
    const t='70000000-0000-4000-8000-000000000001';
    const r=await inputs(`
      INSERT INTO building_fee_accounts VALUES ('${house}','${org}','tien_nha',NULL,1000000);
      INSERT INTO income_expense_types VALUES ('${t}','${org}','tien_nha',NULL,'Tiền nhà');
      INSERT INTO income_expenses VALUES ('${voucher}','${org}',NULL,'dien');
      INSERT INTO fixture_lines VALUES ('2025-11-01','${voucher}','UNAPPROVED','EXPENSE',600000,'${t}'),
        ('2025-10-01','${voucher}','APPROVED','EXPENSE',400000,NULL);
    `);
    expect(Number(r.pending_cost)).toBe(600000);expect(Number(r.fixed_cost)).toBe(400000);expect(Number(r.utility_cost)).toBe(400000);
    expect(r.detail_lines).toEqual(expect.arrayContaining([
      {bucket:"fixed_cost",label:"tien_nha",amount:400000},
      {bucket:"utility_cost",label:"dien",amount:400000},
      expect.objectContaining({bucket:"pending_cost",label:"Tiền nhà",amount:600000}),
    ]));
    expect(r.unknown_fees).toContain("nuoc");expect(r.unknown_fees).not.toContain("dien");
  });
});
