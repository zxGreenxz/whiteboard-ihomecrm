// create_sale_bonus_from_deposit_v1 phải kiểm quyền TRƯỚC khi khoá tổ chức/hợp đồng
// (migration 20261007000825). Chạy trên PGlite với migration thật của luồng hỗ trợ
// tiền thuê; khoá tổ chức được ghi sổ để đo nó có bị lấy hay không.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPayoutDb, org, building, uuid } from './fixtures/rentSupportPayoutDb';

const upfront = 'supabase/migrations/20260930101338_rent_support_upfront_payouts.sql';
const patch = 'supabase/migrations/20261007000825_sale_bonus_deposit_authorize_before_lock.sql';
const ownDeposit = uuid(700), foreignDeposit = uuid(701), foreignOrg = uuid(702), foreignBuilding = uuid(703), foreignContract = uuid(704);

async function database(withPatch: boolean) {
  const db = new PGlite();
  await setupPayoutDb(db, upfront);
  await db.exec(`
    ALTER TABLE public.income_expenses ADD COLUMN building_id uuid;
    CREATE TABLE public.lock_log(org uuid);
    CREATE OR REPLACE FUNCTION app_private.lock_org_for_decision_v1(p uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.lock_log VALUES(p); END $$;
    INSERT INTO public.organizations VALUES('${foreignOrg}','ACTIVE');
    INSERT INTO public.buildings VALUES('${foreignBuilding}','${foreignOrg}',NULL,'ACTIVE',false);
    INSERT INTO public.contracts(id,organization_id,status) VALUES('${foreignContract}','${foreignOrg}','ACTIVE');
    INSERT INTO public.income_expenses(id,organization_id,building_id,type,approval_status) VALUES('${ownDeposit}','${org}','${building}','INCOME','APPROVED');
    INSERT INTO public.income_expenses(id,organization_id,building_id,contract_id,type,approval_status)
      VALUES('${foreignDeposit}','${foreignOrg}','${foreignBuilding}','${foreignContract}','INCOME','APPROVED');
  `);
  if (withPatch) await db.exec(readFileSync(patch, 'utf8'));
  return db;
}
const call = (db: PGlite, deposit: string) => db.query('SELECT public.create_sale_bonus_from_deposit_v1($1,100000) AS r', [deposit]);
const locks = async (db: PGlite) => (await db.query<{ n: number }>('SELECT count(*)::int n FROM public.lock_log')).rows[0]?.n;

describe('create_sale_bonus_from_deposit_v1 sau bản vá', () => {
  let db: PGlite;
  beforeAll(async () => { db = await database(true); }, 60_000);
  afterAll(async () => db.close());

  it('phiếu cọc của toà ngoài phạm vi bị từ chối 42501 mà không lấy khoá tổ chức nào', async () => {
    await db.exec('TRUNCATE public.lock_log');
    await expect(call(db, foreignDeposit)).rejects.toMatchObject({ code: '42501' });
    expect(await locks(db)).toBe(0);
  });

  it('phiếu cọc không tồn tại vẫn báo P0002 như trước, không khoá', async () => {
    await db.exec('TRUNCATE public.lock_log');
    await expect(call(db, uuid(799))).rejects.toMatchObject({ code: 'P0002' });
    expect(await locks(db)).toBe(0);
  });

  it('người có quyền trên toà đi tiếp như cũ: khoá tổ chức rồi tới bản canonical', async () => {
    await db.exec('TRUNCATE public.lock_log');
    expect((await call(db, ownDeposit)).rows).toEqual([{ r: {} }]);
    expect(await locks(db)).toBe(1);
  });

  it('quản trị nền tảng vẫn được qua như điều kiện của bản canonical', async () => {
    await db.exec(`TRUNCATE public.lock_log;
      CREATE OR REPLACE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;`);
    try {
      // Qua bước kiểm quyền; dừng ở bước hợp đồng như bản 30/09 vì fixture không có phòng/toà của hợp đồng ngoài.
      await call(db, foreignDeposit).catch(() => undefined);
      expect(await locks(db)).toBe(1);
    } finally {
      await db.exec('CREATE OR REPLACE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;');
    }
  });

  it('gate tĩnh nhận ra bản vá có chốt phạm vi', () => {
    const sql = readFileSync(patch, 'utf8');
    const body = sql.slice(sql.indexOf('AS $$'));
    expect(body.indexOf('public.can_access_building(d.building_id)')).toBeLessThan(body.indexOf('lock_org_for_decision_v1'));
    expect(body.indexOf('auth.uid()')).toBeLessThan(body.indexOf('FOR UPDATE'));
  });
});

describe('đột biến: bản 30/09 chưa vá', () => {
  it('khoá tổ chức của công ty khác TRƯỚC khi bị từ chối — đúng lỗi bản vá sửa', async () => {
    const db = await database(false);
    try {
      await call(db, foreignDeposit).catch(() => undefined);
      expect(await locks(db)).toBe(1);
    } finally {
      await db.close();
    }
  }, 60_000);
});
