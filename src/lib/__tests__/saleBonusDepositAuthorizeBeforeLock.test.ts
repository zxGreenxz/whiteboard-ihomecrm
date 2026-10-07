// create_sale_bonus_from_deposit_v1 phải kiểm quyền TRƯỚC khi khoá tổ chức/hợp đồng
// (migration 20261007003604 [1]). Chạy trên PGlite với migration thật của luồng hỗ trợ
// tiền thuê.
//
// Cách đo thứ tự: một lỗi làm cả transaction ROLLBACK, nên ghi sổ "đã khoá" vào bảng
// sẽ mất theo và cho kết quả xanh rỗng. Thay vào đó khoá giả NÉM LK001 khi chế độ
// 'raise' bật: thấy LK001 là hàm đã TỚI bước khoá, thấy 42501 là bị chặn trước đó.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPayoutDb, org, actor, building, room, uuid } from './fixtures/rentSupportPayoutDb';

const upfront = 'supabase/migrations/20260930101338_rent_support_upfront_payouts.sql';
const orderSql = readFileSync('supabase/migrations/20261007003604_authorize_before_org_lock.sql', 'utf8');
const patch = orderSql.slice(orderSql.indexOf('-- [1]'), orderSql.indexOf('-- [2]'));
const ownDeposit = uuid(700), foreignDeposit = uuid(701), foreignOrg = uuid(702), foreignBuilding = uuid(703), foreignContract = uuid(704);
const planDeposit = uuid(705), planContract = uuid(706);

async function database(withPatch: boolean) {
  const db = new PGlite();
  await setupPayoutDb(db, upfront);
  await db.exec(`
    ALTER TABLE public.income_expenses ADD COLUMN building_id uuid;
    CREATE TABLE public.lock_log(org uuid);
    CREATE OR REPLACE FUNCTION app_private.lock_org_for_decision_v1(p uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('test.lock_oracle',true)='raise' THEN RAISE EXCEPTION 'lock reached' USING ERRCODE='LK001'; END IF;
      INSERT INTO public.lock_log VALUES(p); END $$;
    INSERT INTO public.organizations VALUES('${foreignOrg}','ACTIVE');
    INSERT INTO public.buildings VALUES('${foreignBuilding}','${foreignOrg}',NULL,'ACTIVE',false);
    INSERT INTO public.contracts(id,organization_id,status) VALUES('${foreignContract}','${foreignOrg}','ACTIVE');
    INSERT INTO public.contracts(id,organization_id,room_id,status) VALUES('${planContract}','${org}','${room}','ACTIVE');
    INSERT INTO app_private.contract_rent_support_plans(organization_id,contract_id,revision,payload,committed_total,payer,deduction_policy,state,customer_hash,created_by)
      VALUES('${org}','${planContract}',1,'{}',0,'BUILDING','COMMISSION_ONLY','ACTIVE','h','${actor}');
    INSERT INTO public.income_expenses(id,organization_id,building_id,type,approval_status) VALUES('${ownDeposit}','${org}','${building}','INCOME','APPROVED');
    INSERT INTO public.income_expenses(id,organization_id,building_id,contract_id,type,approval_status)
      VALUES('${foreignDeposit}','${foreignOrg}','${foreignBuilding}','${foreignContract}','INCOME','APPROVED'),
            ('${planDeposit}','${org}','${building}','${planContract}','INCOME','APPROVED');
  `);
  if (withPatch) await db.exec(patch);
  return db;
}
const call = (db: PGlite, deposit: string) => db.query('SELECT public.create_sale_bonus_from_deposit_v1($1,100000) AS r', [deposit]);
const oracle = (db: PGlite, mode: 'raise' | 'log') => db.exec(`SELECT set_config('test.lock_oracle','${mode}',false)`);

describe('create_sale_bonus_from_deposit_v1 sau bản vá', () => {
  let db: PGlite;
  beforeAll(async () => { db = await database(true); }, 60_000);
  afterAll(async () => db.close());

  it('phiếu cọc của toà ngoài phạm vi bị từ chối 42501 TRƯỚC bước khoá tổ chức', async () => {
    await oracle(db, 'raise');
    await expect(call(db, foreignDeposit)).rejects.toMatchObject({ code: '42501' });
  });

  it('phiếu cọc không tồn tại vẫn báo P0002 như trước, không tới bước khoá', async () => {
    await oracle(db, 'raise');
    await expect(call(db, uuid(799))).rejects.toMatchObject({ code: 'P0002' });
  });

  it('người có quyền trên toà qua bước kiểm và đi tiếp như cũ tới bản canonical', async () => {
    await oracle(db, 'raise');
    await expect(call(db, ownDeposit)).rejects.toMatchObject({ code: 'LK001' });
    await oracle(db, 'log');
    await db.exec('TRUNCATE public.lock_log');
    expect((await call(db, ownDeposit)).rows).toEqual([{ r: {} }]);
    expect((await db.query<{ n: number }>('SELECT count(*)::int n FROM public.lock_log')).rows[0]?.n).toBe(1);
  });

  it('quản trị nền tảng vẫn được qua như điều kiện của bản canonical', async () => {
    await oracle(db, 'raise');
    await db.exec('CREATE OR REPLACE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;');
    try {
      await expect(call(db, foreignDeposit)).rejects.toMatchObject({ code: 'LK001' });
    } finally {
      await db.exec('CREATE OR REPLACE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;');
    }
  });

  it('nhánh hợp đồng có gói hỗ trợ giữ nguyên: kiểm hoa hồng rồi PT409', async () => {
    await oracle(db, 'log');
    await expect(call(db, planDeposit)).rejects.toMatchObject({ code: 'PT409' });
  });
});

describe('đột biến: bản 30/09 chưa vá', () => {
  it('TỚI bước khoá tổ chức với phiếu cọc của công ty khác — đúng lỗi bản vá sửa', async () => {
    const db = await database(false);
    try {
      await oracle(db, 'raise');
      await expect(call(db, foreignDeposit)).rejects.toMatchObject({ code: 'LK001' });
    } finally {
      await db.close();
    }
  }, 60_000);
});
