import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

// Soát 30/10/2026 "1 hợp đồng chỉ 1 phiếu hoa hồng": ie_compat_insert_v2 nhận nguyên
// commission_kind + commission_legacy_dup do người gọi gửi, nên p_items rỗng + cờ legacy
// lập được phiếu môi giới SỐNG thứ hai (unique index bỏ qua dòng legacy). Test chạy THẬT
// thân hàm ngay trước migration (đối chứng: lỗ phải tái hiện được), rồi áp nguyên file
// migration hai lượt và đo lại trên cùng dữ liệu.
const MIG_DIR = 'supabase/migrations';
const migrationFile = '20261030100148_khoa_cot_hoa_hong_ie_compat.sql';
const migrationSql = readFileSync(`supabase/migrations/${migrationFile}`, 'utf8').replace(/\r\n/g, '\n');

/** Thân ie_compat_insert_v2 mà migration này thay = lần CREATE cuối cùng ở các file TRƯỚC nó. */
function previousCompatWriter(): string {
  const head = 'CREATE OR REPLACE FUNCTION public.ie_compat_insert_v2(';
  let sql = '';
  for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql') && x < migrationFile).sort()) {
    const text = readFileSync(join(MIG_DIR, f), 'utf8').replace(/\r\n/g, '\n');
    const start = text.indexOf(head);
    if (start < 0) continue;
    sql = text.slice(start, text.indexOf('$function$;', start) + '$function$;'.length);
  }
  if (!sql) throw new Error('Không thấy định nghĩa trước của ie_compat_insert_v2');
  return sql;
}

/** Câu tạo unique index gốc (20260709110000) — chép đúng điều kiện WHERE đang chạy. */
function commissionUniqueIndex(): string {
  const text = readFileSync(join(MIG_DIR, '20260709110000_ie_commission_kind_unique.sql'), 'utf8').replace(/\r\n/g, '\n');
  const sql = text.match(/CREATE UNIQUE INDEX IF NOT EXISTS uq_ie_commission_per_contract[\s\S]*?;/)?.[0];
  if (!sql) throw new Error('Không thấy uq_ie_commission_per_contract');
  return sql;
}

const org = '00000000-0000-4000-8000-000000000001';
const staff = '00000000-0000-4000-8000-000000000002';
const building = '00000000-0000-4000-8000-000000000003';
const contract = '00000000-0000-4000-8000-000000000004';
const contractLegacy = '00000000-0000-4000-8000-000000000005';
const contractFree = '00000000-0000-4000-8000-000000000011';
const liveBroker = '00000000-0000-4000-8000-000000000006';
const legacyRow = '00000000-0000-4000-8000-000000000007';
const ordinaryType = '00000000-0000-4000-8000-000000000008';
const systemType = '00000000-0000-4000-8000-000000000009';
const membership = '00000000-0000-4000-8000-000000000010';

const db = new PGlite();
type Row = Record<string, unknown>;

async function one(sql: string, params: unknown[] = []): Promise<Row> {
  return (await db.query<Row>(sql, params)).rows[0];
}

/** Mỗi ca một transaction, luôn ROLLBACK — các ca không dẫm dữ liệu của nhau. */
async function rollback<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN');
  try {
    return await fn();
  } finally {
    await db.exec('ROLLBACK');
  }
}

/** Gọi compat như PostgREST: vai authenticated, auth.uid() = nhân viên. */
async function compatAsStaff(row: Row, items: Row[] = []): Promise<Row> {
  await db.exec(`SET LOCAL ROLE authenticated; SELECT set_config('test.actor','${staff}',true);`);
  const r = await one('SELECT public.ie_compat_insert_v2($1::jsonb, $2::jsonb) AS r', [JSON.stringify(row), JSON.stringify(items)]);
  await db.exec('RESET ROLE');
  const id = (r.r as { id: string }).id;
  return one(
    `SELECT commission_kind, commission_legacy_dup, system_source, approval_status,
            (SELECT count(*)::int FROM income_expense_items i WHERE i.income_expense_id = e.id) AS n_items
       FROM income_expenses e WHERE id = $1`, [id]);
}

const liveBrokerCount = async (c: string) =>
  (await one(`SELECT count(*)::int AS n FROM income_expenses WHERE contract_id = $1 AND commission_kind = 'broker'
                AND deleted_at IS NULL AND approval_status <> 'CANCELLED'`, [c])).n;

// Payload lối lách: không hạng mục, tự khai loại hoa hồng + cờ legacy + dấu nguồn hệ thống.
const exploit = (over: Row = {}): Row => ({
  type: 'EXPENSE', name: 'Phiếu chi tay', building_id: building, contract_id: contract,
  commission_kind: 'broker', commission_legacy_dup: true, system_source: 'contract.commission',
  total_amount: 500000, voucher_date: '2026-10-30', ...over,
});

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('test.actor', true), '')::uuid $$;
    CREATE TABLE accounts(id uuid PRIMARY KEY, organization_id uuid);
    CREATE TABLE buildings(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz);
    CREATE TABLE organization_memberships(id uuid PRIMARY KEY, user_id uuid, organization_id uuid, status text);
    CREATE TABLE cashbook_possession_bindings(organization_id uuid, cashbook_id uuid, membership_id uuid,
      valid_to timestamptz, possession_kind text);
    CREATE TABLE income_expense_types(id uuid PRIMARY KEY, organization_id uuid, type text, name text,
      system_only boolean DEFAULT false, is_restricted boolean DEFAULT false);
    CREATE TABLE income_expenses(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, user_id uuid, code text,
      type text NOT NULL, name text, building_id uuid, contract_id uuid, account_id uuid, voucher_date date,
      total_amount numeric NOT NULL DEFAULT 0, approval_status text NOT NULL DEFAULT 'UNAPPROVED',
      review_state text, approved_by uuid, approved_at timestamptz, posting_mode text, posting_status text,
      maker_user_id uuid, maker_membership_id uuid, deleted_at timestamptz, notes text,
      repeat_cycle text NOT NULL DEFAULT 'NONE', system_source text,
      commission_kind text CHECK (commission_kind IN ('broker', 'sale')),
      commission_legacy_dup boolean NOT NULL DEFAULT false);
    CREATE TABLE income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), income_expense_id uuid NOT NULL,
      income_expense_type_id uuid, organization_id uuid, description text, quantity numeric NOT NULL DEFAULT 1,
      unit_price numeric, amount numeric, accounting_class text);
    CREATE TABLE app_private.finance_v2_semantic_event_log(organization_id uuid, event_kind text, source_table text,
      source_id uuid, source_kind text, actor uuid, txid xid8);
    CREATE FUNCTION app_private.ie_compat_actor_v2(p_org uuid) RETURNS TABLE(membership_id uuid) LANGUAGE sql STABLE AS
      $$ SELECT m.id FROM public.organization_memberships m
          WHERE m.organization_id = p_org AND m.user_id = auth.uid() AND m.status = 'ACTIVE' $$;
    INSERT INTO buildings VALUES ('${building}', '${org}', NULL);
    INSERT INTO organization_memberships VALUES ('${membership}', '${staff}', '${org}', 'ACTIVE');
    INSERT INTO income_expense_types VALUES
      ('${ordinaryType}', '${org}', 'EXPENSE', 'Sửa chữa', false, false),
      ('${systemType}', '${org}', 'EXPENSE', 'Hoa hồng môi giới', true, false);
  `);
  await db.exec(commissionUniqueIndex());
  // Phiếu môi giới đang sống của HĐ, và một phiếu legacy có sẵn (dựng TRƯỚC khi có trigger,
  // như đợt backfill 09/07) ở HĐ khác mà phiếu gốc đã huỷ.
  await db.exec(`
    INSERT INTO income_expenses(id, organization_id, type, name, building_id, contract_id, total_amount,
      approval_status, commission_kind, system_source)
    VALUES ('${liveBroker}', '${org}', 'EXPENSE', 'Hoa hồng môi giới', '${building}', '${contract}', 500000,
      'APPROVED', 'broker', 'contract.commission');
    INSERT INTO income_expenses(id, organization_id, type, name, building_id, contract_id, total_amount,
      approval_status, commission_kind, commission_legacy_dup)
    VALUES ('${legacyRow}', '${org}', 'EXPENSE', 'Hoa hồng môi giới', '${building}', '${contractLegacy}', 500000,
      'APPROVED', 'broker', true);
  `);
  await db.exec(previousCompatWriter());
  await db.exec('GRANT EXECUTE ON FUNCTION public.ie_compat_insert_v2(jsonb, jsonb) TO authenticated;');
});

describe('khoá cột hoa hồng ở ie_compat_insert_v2 + cấm cờ "phiếu trùng cũ"', () => {
  it('đối chứng: thân trước migration để lọt cột hoa hồng ⇒ HĐ có 2 phiếu môi giới sống', async () => {
    await rollback(async () => {
      const row = await compatAsStaff(exploit());
      expect(row).toMatchObject({ commission_kind: 'broker', commission_legacy_dup: true, system_source: 'contract.commission', n_items: 0 });
      expect(await liveBrokerCount(contract)).toBe(2);
    });
  });

  it('migration chạy hai lượt liên tiếp; ACL và trigger đúng khuôn', async () => {
    await db.exec(migrationSql);
    await db.exec(migrationSql);
    const acl = await one(`SELECT has_function_privilege('authenticated', 'public.ie_compat_insert_v2(jsonb,jsonb)', 'EXECUTE') AS auth_ok,
                                  has_function_privilege('anon', 'public.ie_compat_insert_v2(jsonb,jsonb)', 'EXECUTE') AS anon_ok`);
    expect(acl).toEqual({ auth_ok: true, anon_ok: false });
    const trg = await one(`SELECT tgtype, tgenabled, pg_get_triggerdef(oid) AS def FROM pg_trigger
                            WHERE tgrelid = 'public.income_expenses'::regclass AND tgname = 'z97_commission_legacy_dup_guard'`);
    expect(trg).toMatchObject({ tgtype: 23, tgenabled: 'O' });
    expect(trg.def).toMatch(/WHEN \(new\.commission_legacy_dup\)/i);
  });

  it('lối lách cũ chỉ còn ra phiếu chi thường: không loại hoa hồng, không cờ, không dấu nguồn', async () => {
    for (const over of [{}, { commission_legacy_dup: false }, { commission_kind: 'sale' }]) {
      await rollback(async () => {
        const row = await compatAsStaff(exploit(over));
        expect(row).toMatchObject({ commission_kind: null, commission_legacy_dup: false, system_source: null, approval_status: 'UNAPPROVED' });
        expect(await liveBrokerCount(contract)).toBe(1);
      });
    }
  });

  it('phiếu chi thường qua compat vẫn lập được; hạng mục chỉ-hệ-thống vẫn bị chặn', async () => {
    await rollback(async () => {
      const row = await compatAsStaff(
        { type: 'EXPENSE', name: 'Sửa ống nước', building_id: building, voucher_date: '2026-10-30' },
        [{ income_expense_type_id: ordinaryType, quantity: 1, unit_price: 200000, amount: 200000 }]);
      expect(row).toMatchObject({ commission_kind: null, commission_legacy_dup: false, n_items: 1 });
    });
    await rollback(async () => {
      await expect(compatAsStaff(exploit({ commission_legacy_dup: false }),
        [{ income_expense_type_id: systemType, quantity: 1, unit_price: 500000, amount: 500000 }]))
        .rejects.toMatchObject({ code: '42501' });
    });
  });

  it('vai anon không gọi được compat', async () => {
    await rollback(async () => {
      await db.exec('SET LOCAL ROLE anon');
      await expect(db.query('SELECT public.ie_compat_insert_v2($1::jsonb)', [JSON.stringify(exploit())]))
        .rejects.toMatchObject({ code: '42501' });
    });
  });

  it('mọi đường ghi (kể cả chủ hàm) không đặt cờ legacy cho phiếu mới', async () => {
    await rollback(async () => {
      await expect(db.query(
        `INSERT INTO income_expenses(organization_id, type, name, building_id, contract_id, total_amount, commission_kind, commission_legacy_dup)
         VALUES ($1, 'EXPENSE', 'x', $2, $3, 500000, 'broker', true)`, [org, building, contract]))
        .rejects.toMatchObject({ code: '23514', message: expect.stringContaining('phiếu hoa hồng trùng cũ') });
    });
  });

  it('writer nghiệp vụ (INSERT có commission_kind, không gửi cờ) vẫn ghi được; phiếu thứ hai vẫn vấp unique index', async () => {
    // Khuôn của app_private.rent_support_legacy_commission_v1 (thân create_commission_voucher):
    // INSERT thẳng commission_kind, để cờ legacy theo mặc định.
    const insertBroker = () => db.query<Row>(
      `INSERT INTO income_expenses(organization_id, type, name, building_id, contract_id, total_amount, commission_kind, system_source)
       VALUES ($1, 'EXPENSE', 'Hoa hồng môi giới', $2, $3, 500000, 'broker', 'contract.commission')
       RETURNING commission_kind, commission_legacy_dup`, [org, building, contractFree]);
    await rollback(async () => {
      const first = (await insertBroker()).rows[0];
      expect(first).toEqual({ commission_kind: 'broker', commission_legacy_dup: false });
      expect(await liveBrokerCount(contractFree)).toBe(1);
      await expect(insertBroker()).rejects.toMatchObject({ code: '23505' });
    });
  });

  it('không bật cờ legacy lên phiếu đang sống (sẽ làm trống ô khoá của HĐ)', async () => {
    await rollback(async () => {
      await expect(db.query('UPDATE income_expenses SET commission_legacy_dup = true WHERE id = $1', [liveBroker]))
        .rejects.toMatchObject({ code: '23514' });
    });
  });

  it('phiếu legacy có sẵn vẫn sửa được cột khác, gỡ được cờ, nhưng không bật lại được', async () => {
    await rollback(async () => {
      const edited = await one(`UPDATE income_expenses SET notes = 'đã rà' WHERE id = $1 RETURNING commission_legacy_dup`, [legacyRow]);
      expect(edited.commission_legacy_dup).toBe(true);
      const cleared = await one('UPDATE income_expenses SET commission_legacy_dup = false WHERE id = $1 RETURNING commission_legacy_dup', [legacyRow]);
      expect(cleared.commission_legacy_dup).toBe(false);
      await expect(db.query('UPDATE income_expenses SET commission_legacy_dup = true WHERE id = $1', [legacyRow]))
        .rejects.toMatchObject({ code: '23514' });
    });
  });
});
