// Bộ sinh phiếu định kỳ chống trùng (22/10/2026 — đợt rà F01/F40/F58).
//
// Chạy logic THẬT trên PGlite: thân production của generate_recurring_vouchers (G5,
// 20260926160000) làm "trước", rồi migration vá áp HAI lượt (lane kiểm idempotency) và định
// nghĩa SỐNG lấy từ toàn bộ thư mục migration làm "sau". Cổng bộ máy chi là stub ghi lại đối số
// (luật thật nằm ở ie_spend_decide_v1 — ngoài phạm vi vá); add_cycle là định nghĩa sống thật.
// Mọi số tiền/mã phiếu ở đây là giả.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PATCH = 'supabase/migrations/20261022101837_bo_sinh_dinh_ky_chong_trung.sql';
const G5_SOURCE = 'supabase/migrations/20260926160000_noi_writer_vao_bo_may_chi.sql';
const TRUOC_G5_SOURCE = 'supabase/migrations/20260731070000_current_date_to_org_today.sql';
const PROD_MD5 = '821a8518c4692f3fdbce827804234d28';
const TRUOC_G5_MD5 = 'e8b6f1e9632ed2c6e94666cf09935a88';

const org = '00000000-0000-4000-8000-000000000001';
const owner = '00000000-0000-4000-8000-000000000002';
const building = '00000000-0000-4000-8000-000000000003';
const otherBuilding = '00000000-0000-4000-8000-000000000004';
const account = '00000000-0000-4000-8000-000000000005';
const typeRent = '00000000-0000-4000-8000-000000000011';
const typeRentAlias = '00000000-0000-4000-8000-000000000012';
const typeTrash = '00000000-0000-4000-8000-000000000013';
const typeClean = '00000000-0000-4000-8000-000000000014';

function sliceFunction(path: string, header: string, end: string): string {
  const sql = readFileSync(path, 'utf8');
  const start = sql.indexOf(header);
  if (start < 0) throw new Error(`Không thấy ${header} trong ${path}`);
  return sql.slice(start, sql.indexOf(end, start) + end.length);
}

// Định nghĩa SỐNG = lần CREATE cuối theo timestamp migration (khuôn liveDefinitionOf ở
// salaryCompletionDate.test.ts), cắt từ CREATE tới hết thân dollar-quoted.
let migrationCorpus: string[] | null = null;
function liveFunctionSql(schema: string, fnName: string): string {
  migrationCorpus ??= readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()
    .map((f) => readFileSync(join('supabase/migrations', f), 'utf8').replace(/--[^\n]*/g, ''));
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${schema}\\.${fnName}\\s*\\(`, 'gi');
  let hit: string | null = null;
  for (const sql of migrationCorpus) {
    for (const m of sql.matchAll(re)) hit = sql.slice(m.index);
  }
  if (!hit) throw new Error(`Không tìm thấy định nghĩa nào của ${schema}.${fnName}`);
  const tag = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(hit);
  if (!tag) throw new Error(`Không thấy thân hàm ${schema}.${fnName}`);
  return `${hit.slice(0, hit.indexOf(tag[1], tag.index + tag[0].length) + tag[1].length)};`;
}

const G5_BODY = sliceFunction(G5_SOURCE, 'CREATE OR REPLACE FUNCTION public.generate_recurring_vouchers(', '$function$;');
const TRUOC_G5_BODY = sliceFunction(TRUOC_G5_SOURCE, 'CREATE OR REPLACE FUNCTION public.generate_recurring_vouchers(', '$function$;');

async function buildBase(db: PGlite) {
  await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA app_private; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE TABLE income_expense_types(id uuid PRIMARY KEY, organization_id uuid NOT NULL, name text NOT NULL,
      type text NOT NULL, fee_category text);
    INSERT INTO income_expense_types VALUES
      ('${typeRent}','${org}','Tiền nhà','expense','tien_nha'),
      ('${typeRentAlias}','${org}','Tiền nhà (hạng mục cũ)','expense','tien_nha'),
      ('${typeTrash}','${org}','Tiền rác','expense','rac'),
      ('${typeClean}','${org}','Vệ sinh','expense',NULL);
    CREATE TABLE building_fee_accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), building_id uuid NOT NULL,
      fee_category text NOT NULL, default_amount numeric, not_applicable boolean NOT NULL DEFAULT false,
      deleted_at timestamptz, organization_id uuid);
    CREATE SEQUENCE ie_code_seq;
    CREATE TABLE income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, code text,
      type text NOT NULL, name text NOT NULL, building_id uuid NOT NULL, room_id uuid, tenant_id uuid, contract_id uuid,
      account_id uuid, payer_name text, approval_status text NOT NULL DEFAULT 'APPROVED', approved_at timestamptz,
      approved_by uuid, business_result_accounting boolean, counts_in_business_result boolean NOT NULL DEFAULT true,
      attachments jsonb NOT NULL DEFAULT '[]', notes text, receive_bank_name text, receive_bank_account text,
      creator_name text, voucher_date date NOT NULL, invoice_id uuid, repeat_parent_id uuid,
      repeat_cycle text DEFAULT 'NONE', repeat_infinity boolean NOT NULL DEFAULT false,
      repeat_count integer NOT NULL DEFAULT 0, repeat_remaining integer NOT NULL DEFAULT 0, repeat_next_date date,
      repeat_auto_approve boolean NOT NULL DEFAULT true, organization_id uuid NOT NULL DEFAULT '${org}',
      deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    -- Như production: một phiếu con sống cho mỗi (phiếu cha, ngày kỳ).
    CREATE UNIQUE INDEX uniq_ie_repeat_child_date ON income_expenses(repeat_parent_id, voucher_date)
      WHERE repeat_parent_id IS NOT NULL AND deleted_at IS NULL;
    -- Mã phiếu do trigger BEFORE INSERT cấp (auto_generate_voucher_code, rút gọn).
    CREATE FUNCTION gan_ma_phieu() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.code := COALESCE(NEW.code, 'PC-TU-' || lpad(nextval('ie_code_seq')::text, 3, '0')); RETURN NEW; END $$;
    CREATE TRIGGER trigger_auto_generate_voucher_code BEFORE INSERT ON income_expenses
      FOR EACH ROW EXECUTE FUNCTION gan_ma_phieu();
    CREATE TABLE income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), income_expense_id uuid NOT NULL,
      income_expense_type_id uuid NOT NULL, description text, quantity numeric NOT NULL DEFAULT 1,
      unit_price numeric NOT NULL DEFAULT 0, start_date date, end_date date);
    CREATE FUNCTION public.org_today_v1(p_organization_id uuid DEFAULT NULL::uuid) RETURNS date LANGUAGE sql STABLE
      AS $$ SELECT current_setting('test.today')::date $$;
    -- Cổng bộ máy chi (stub): ghi đối số; quyết định theo vế B1 + RECURRING_PREAPPROVED của
    -- ie_spend_decide_v1 (sổ NULL ⇒ CHỜ). test.enforce = cổng áp; test.gate = ép trạng thái trả về.
    CREATE TABLE app_private.gate_calls(n serial, account uuid, voucher_date date, lines jsonb, context jsonb);
    CREATE FUNCTION app_private.ie_spend_gate_v1(p_org uuid, p_building uuid, p_direction text, p_writer text,
      p_system_source text, p_account uuid, p_voucher_date date, p_lines jsonb, p_exclude_voucher uuid DEFAULT NULL,
      p_context jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO app_private.gate_calls(account, voucher_date, lines, context)
        VALUES (p_account, p_voucher_date, p_lines, p_context);
      RETURN jsonb_build_object(
        'enforce', coalesce(current_setting('test.enforce', true), '') = 'yes',
        'status', COALESCE(NULLIF(current_setting('test.gate', true), ''),
                    CASE WHEN p_account IS NULL THEN 'UNAPPROVED'
                         WHEN COALESCE((p_context->>'recurring_auto_approve')::boolean, false) THEN 'APPROVED'
                         ELSE 'UNAPPROVED' END));
    END $$;`);
  await db.exec(liveFunctionSql('public', 'add_cycle'));
}

async function md5Of(db: PGlite): Promise<string> {
  const { rows } = await db.query<{ m: string }>(
    `SELECT md5(replace(pg_get_functiondef('public.generate_recurring_vouchers(uuid)'::regprocedure), chr(13), '')) AS m`,
  );
  return rows[0].m;
}

const before = new PGlite();
const after = new PGlite();
const drill = new PGlite();
const md5TruocVa: { before?: string; after?: string; drill?: string } = {};

beforeAll(async () => {
  await Promise.all([buildBase(before), buildBase(after), buildBase(drill)]);
  await before.exec(G5_BODY);
  await after.exec(G5_BODY);
  await drill.exec(TRUOC_G5_BODY);
  // ACL như production: chỉ chủ hàm + service_role.
  for (const db of [before, after, drill]) {
    await db.exec(`REVOKE ALL ON FUNCTION public.generate_recurring_vouchers(uuid) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.generate_recurring_vouchers(uuid) TO service_role;`);
  }
  md5TruocVa.before = await md5Of(before);
  md5TruocVa.after = await md5Of(after);
  md5TruocVa.drill = await md5Of(drill);
  // Lane kiểm idempotency: áp hai lượt. Rồi định nghĩa SỐNG — mọi khẳng định bên dưới chạy trên bản đó.
  const patch = readFileSync(PATCH, 'utf8');
  await after.exec(patch);
  await after.exec(patch);
  await after.exec(liveFunctionSql('public', 'generate_recurring_vouchers'));
  await drill.exec(patch);
}, 60000);
afterAll(async () => {
  await Promise.all([before.close(), after.close(), drill.close()]);
});

describe('tiền kiểm + idempotency của migration', () => {
  it('PGlite tái lập đúng md5 thân production (G5) và thân trước G5 mà tiền kiểm ghim', () => {
    expect(md5TruocVa).toEqual({ before: PROD_MD5, after: PROD_MD5, drill: TRUOC_G5_MD5 });
  });

  it('áp hai lượt lên thân production; định nghĩa sống mang chống trùng; ACL không nới', async () => {
    const { rows } = await after.query<{ def: string; anon: boolean; auth: boolean; svc: boolean; cfg: string[] }>(
      `SELECT pg_get_functiondef(p.oid) AS def, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc, p.proconfig AS cfg
         FROM pg_proc p WHERE p.oid = 'public.generate_recurring_vouchers(uuid)'::regprocedure`,
    );
    expect(rows[0].def).toContain('v_nghi_trung');
    expect(rows[0].def).toContain('app_private.ie_spend_gate_v1(');
    expect(rows[0]).toMatchObject({ anon: false, auth: false, svc: true, cfg: ['search_path=public'] });
  });

  it('bản dựng lại (Restore Drill còn thân trước G5) cũng áp được', async () => {
    const { rows } = await drill.query(`SELECT 1 FROM pg_proc WHERE prosrc LIKE '%v_nghi_trung%'`);
    expect(rows).toHaveLength(1);
  });

  it('thân lạ ⇒ DỪNG 55000, không replace', async () => {
    const db = new PGlite();
    try {
      await buildBase(db);
      await db.exec(G5_BODY.replace("' (tự động lập)'", "' (tự lập)'"));
      await expect(db.exec(readFileSync(PATCH, 'utf8'))).rejects.toThrow(/KHÁC bản đã đối chiếu/);
      await db.exec('ROLLBACK');
      expect(await md5Of(db)).not.toBe(PROD_MD5);
      const { rows } = await db.query(`SELECT 1 FROM pg_proc WHERE prosrc LIKE '%v_nghi_trung%'`);
      expect(rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });
});

type Child = {
  id: string; code: string; voucher_date: string; approval_status: string; account_id: string | null;
  notes: string | null; start_date: string; end_date: string; deleted: boolean;
};

interface ParentOpts {
  id: string; type?: string; amount?: number; date?: string; cycle?: string; auto?: boolean; notes?: string | null;
  created?: string; buildingId?: string;
}

/** Phiếu cha mặc định lập kỳ 09/2026 ⇒ phiếu con 01/10, 01/11… */
async function addParent(db: PGlite, o: ParentOpts) {
  const date = o.date ?? '2026-09-01';
  await db.query(
    `INSERT INTO income_expenses(id, user_id, code, type, name, building_id, account_id, approval_status, voucher_date,
       repeat_cycle, repeat_infinity, repeat_auto_approve, notes, created_at)
     VALUES ($1, $2, $3, 'EXPENSE', 'Phiếu mẫu', $4, $5, 'APPROVED', $6, $7, true, $8, $9, $10)`,
    [o.id, owner, `PC-CHA-${o.id.slice(-3)}`, o.buildingId ?? building, account, date, o.cycle ?? 'MONTH',
      o.auto ?? true, o.notes === undefined ? 'Ghi chú mẫu' : o.notes, o.created ?? '2026-06-01'],
  );
  await db.query(
    `INSERT INTO income_expense_items(income_expense_id, income_expense_type_id, quantity, unit_price, start_date, end_date)
     VALUES ($1, $2, 1, $3, date_trunc('month', $4::date)::date,
             (date_trunc('month', $4::date) + interval '1 month - 1 day')::date)`,
    [o.id, o.type ?? typeRent, o.amount ?? 5_000_000, date],
  );
}

interface VoucherOpts {
  code: string; type?: string; amount?: number; from: string; to: string; status?: string; deleted?: boolean;
  buildingId?: string; parentId?: string; voucherDate?: string;
}

async function addVoucher(db: PGlite, o: VoucherOpts) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO income_expenses(user_id, code, type, name, building_id, approval_status, voucher_date, repeat_parent_id, deleted_at)
     VALUES ($1, $2, 'EXPENSE', 'Phiếu lập tay', $3, $4, $5, $6, CASE WHEN $7 THEN now() END) RETURNING id`,
    [owner, o.code, o.buildingId ?? building, o.status ?? 'APPROVED', o.voucherDate ?? o.from, o.parentId ?? null,
      o.deleted ?? false],
  );
  await db.query(
    `INSERT INTO income_expense_items(income_expense_id, income_expense_type_id, quantity, unit_price, start_date, end_date)
     VALUES ($1, $2, 1, $3, $4, $5)`,
    [rows[0].id, o.type ?? typeRent, o.amount ?? 5_000_000, o.from, o.to],
  );
  return rows[0].id;
}

async function run(db: PGlite, today = '2026-11-01') {
  await db.query(`SELECT set_config('test.today', $1, true)`, [today]);
  return (await db.query<{ parent_id: string; child_id: string; voucher_date: string }>(
    `SELECT parent_id, child_id, voucher_date::text FROM public.generate_recurring_vouchers(NULL)`,
  )).rows;
}

async function children(db: PGlite, parentId: string): Promise<Child[]> {
  return (await db.query<Child>(
    `SELECT c.id, c.code, c.voucher_date::text, c.approval_status, c.account_id, c.notes,
            i.start_date::text, i.end_date::text, c.deleted_at IS NOT NULL AS deleted
       FROM income_expenses c JOIN income_expense_items i ON i.income_expense_id = c.id
      WHERE c.repeat_parent_id = $1 ORDER BY c.voucher_date, c.deleted_at NULLS FIRST`, [parentId],
  )).rows;
}

async function lastGate(db: PGlite) {
  return (await db.query<{ account: string | null; context: { recurring_auto_approve: boolean };
    lines: { start_date: string; end_date: string }[] }>(
    `SELECT account, context, lines FROM app_private.gate_calls ORDER BY n DESC LIMIT 1`,
  )).rows[0];
}

/** Mỗi ca chạy trong transaction riêng rồi ROLLBACK; phiếu cha có sẵn phiếu con tháng 10. */
async function scenario(db: PGlite, fn: () => Promise<void>) {
  await db.exec('BEGIN');
  try {
    await fn();
  } finally {
    await db.exec('ROLLBACK');
  }
}

const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const P3 = '00000000-0000-4000-8000-0000000000a3';

async function parentWithOctoberChild(db: PGlite, o: ParentOpts) {
  await addParent(db, o);
  await run(db, '2026-10-31'); // sinh phiếu con tháng 10 (chưa có phiếu khác ⇒ như cũ)
}

describe('F01 — đã có phiếu khác cùng toà × hạng mục × tháng', () => {
  it('sau vá: VẪN sinh phiếu con tháng 11 nhưng CHỜ DUYỆT, sổ trống, ghi chú mã phiếu kia', async () => {
    await scenario(after, async () => {
      await parentWithOctoberChild(after, { id: P1 });
      await addVoucher(after, { code: 'PC-TAY-01', from: '2026-11-01', to: '2026-11-30' });
      const out = await run(after);
      expect(out).toHaveLength(1);
      const nov = (await children(after, P1)).find((c) => c.voucher_date === '2026-11-01')!;
      expect(nov).toMatchObject({ approval_status: 'UNAPPROVED', account_id: null,
        start_date: '2026-11-01', end_date: '2026-11-30' });
      expect(nov.notes).toBe(
        '[Cần rà trước khi duyệt] Có thể trùng PC-TAY-01 (cùng toà, cùng hạng mục, kỳ 11/2026).'
        + ' Máy không tự duyệt, chưa ghi sổ quỹ.\nGhi chú mẫu',
      );
      // Cổng nhận đúng như phiếu cha không tự duyệt ⇒ bộ máy quyết CHỜ, sổ bóng khớp.
      expect(await lastGate(after)).toMatchObject({ account: null, context: { recurring_auto_approve: false },
        lines: [{ start_date: '2026-11-01', end_date: '2026-11-30' }] });
    });
  });

  it('trước vá (thân production): cùng dữ liệu ⇒ phiếu con TỰ DUYỆT, gắn sổ — đúng lỗi F01', async () => {
    await scenario(before, async () => {
      await parentWithOctoberChild(before, { id: P1 });
      await addVoucher(before, { code: 'PC-TAY-01', from: '2026-11-01', to: '2026-11-30' });
      await run(before);
      const nov = (await children(before, P1)).find((c) => c.voucher_date === '2026-11-01')!;
      expect(nov).toMatchObject({ approval_status: 'APPROVED', account_id: account, notes: 'Ghi chú mẫu',
        start_date: '2026-11-01', end_date: '2026-11-01' });
    });
  });

  it('cổng áp và trả ĐÃ DUYỆT vẫn không mở được phiếu cần rà', async () => {
    await scenario(after, async () => {
      await parentWithOctoberChild(after, { id: P1 });
      await addVoucher(after, { code: 'PC-TAY-01', from: '2026-11-01', to: '2026-11-30' });
      await after.exec(`SET LOCAL test.enforce = 'yes'; SET LOCAL test.gate = 'APPROVED'`);
      await run(after);
      const nov = (await children(after, P1)).find((c) => c.voucher_date === '2026-11-01')!;
      expect(nov.approval_status).toBe('UNAPPROVED');
    });
  });

  it.each([
    ['cùng fee_category, khác hạng mục', { type: typeRentAlias, from: '2026-11-01', to: '2026-11-30' }],
    ['phiếu trả trước nhiều tháng phủ tháng 11', { from: '2026-07-01', to: '2026-12-31', voucherDate: '2026-07-05' }],
    ['phiếu tay chờ duyệt', { status: 'UNAPPROVED', from: '2026-11-01', to: '2026-11-30' }],
  ])('bắt: %s', async (_ten, extra) => {
    await scenario(after, async () => {
      await parentWithOctoberChild(after, { id: P1 });
      await addVoucher(after, { code: 'PC-TAY-02', ...extra });
      await run(after);
      const nov = (await children(after, P1)).find((c) => c.voucher_date === '2026-11-01')!;
      expect(nov.approval_status).toBe('UNAPPROVED');
      expect(nov.notes).toContain('Có thể trùng PC-TAY-02');
    });
  });

  it.each([
    ['phiếu đã huỷ', { status: 'CANCELLED', from: '2026-11-01', to: '2026-11-30' }],
    ['phiếu đã xoá', { deleted: true, from: '2026-11-01', to: '2026-11-30' }],
    ['toà khác', { buildingId: otherBuilding, from: '2026-11-01', to: '2026-11-30' }],
    ['hạng mục khác', { type: typeTrash, from: '2026-11-01', to: '2026-11-30' }],
    ['kỳ tháng 10', { from: '2026-10-01', to: '2026-10-31' }],
  ])('không bắt: %s ⇒ hành vi cũ (tự duyệt, gắn sổ phiếu cha)', async (_ten, extra) => {
    await scenario(after, async () => {
      await parentWithOctoberChild(after, { id: P1 });
      await addVoucher(after, { code: 'PC-TAY-03', ...extra });
      await run(after);
      const nov = (await children(after, P1)).find((c) => c.voucher_date === '2026-11-01')!;
      expect(nov).toMatchObject({ approval_status: 'APPROVED', account_id: account, notes: 'Ghi chú mẫu',
        start_date: '2026-11-01', end_date: '2026-11-30' });
      expect(await lastGate(after)).toMatchObject({ account, context: { recurring_auto_approve: true } });
    });
  });

  it('hai phiếu cha cùng toà × hạng mục trong một lượt: phiếu cha lập SAU bị giữ, ghi mã phiếu con kia', async () => {
    await scenario(after, async () => {
      // Chèn P2 trước nhưng created_at muộn hơn ⇒ thứ tự duyệt theo created_at, không theo vị trí dòng.
      await addParent(after, { id: P2, created: '2026-08-01', date: '2026-10-01' });
      await addParent(after, { id: P1, created: '2026-06-01', date: '2026-10-01', amount: 3_000_000 });
      await run(after);
      const [c1] = (await children(after, P1)).filter((c) => c.voucher_date === '2026-11-01');
      const [c2] = (await children(after, P2)).filter((c) => c.voucher_date === '2026-11-01');
      expect(c1).toMatchObject({ approval_status: 'APPROVED', account_id: account });
      expect(c2.approval_status).toBe('UNAPPROVED');
      expect(c2.notes).toContain(`Có thể trùng ${c1.code}`);
    });
  });

  it('phí theo tuần: các kỳ khác của CHÍNH phiếu cha không bị coi là trùng; kỳ một ngày như cũ', async () => {
    await scenario(after, async () => {
      await addParent(after, { id: P3, cycle: 'WEEK', date: '2026-10-29', type: typeClean, amount: 180_000 });
      await run(after, '2026-11-20');
      const nov = (await children(after, P3)).filter((c) => c.voucher_date.startsWith('2026-11'));
      expect(nov.map((c) => c.voucher_date)).toEqual(['2026-11-05', '2026-11-12', '2026-11-19']);
      for (const c of nov) {
        expect(c).toMatchObject({ approval_status: 'APPROVED', start_date: c.voucher_date, end_date: c.voucher_date });
      }
    });
  });
});

describe('F40 — số tiền khác mức mặc định ở building_fee_accounts', () => {
  it('lệch ⇒ CHỜ DUYỆT kèm số tiền và mức mặc định', async () => {
    await scenario(after, async () => {
      await after.exec(`INSERT INTO building_fee_accounts(building_id, fee_category, default_amount)
        VALUES ('${building}', 'rac', 150000)`);
      await addParent(after, { id: P1, type: typeTrash, amount: 350_000 });
      await run(after);
      const nov = (await children(after, P1)).find((c) => c.voucher_date === '2026-11-01')!;
      expect(nov).toMatchObject({ approval_status: 'UNAPPROVED', account_id: null });
      expect(nov.notes).toBe(
        '[Cần rà trước khi duyệt] Số tiền lệch: Tiền rác 350.000đ khác mức mặc định 150.000đ.'
        + ' Máy không tự duyệt, chưa ghi sổ quỹ.\nGhi chú mẫu',
      );
    });
  });

  it('nghi trùng + lệch mức ⇒ một ghi chú nêu cả hai; phiếu cha không ghi chú vẫn đủ ý', async () => {
    await scenario(after, async () => {
      await after.exec(`INSERT INTO building_fee_accounts(building_id, fee_category, default_amount)
        VALUES ('${building}', 'tien_nha', 4500000)`);
      await addParent(after, { id: P1, notes: null });
      await addVoucher(after, { code: 'PC-TAY-04', from: '2026-11-01', to: '2026-11-30', amount: 4_500_000 });
      await run(after);
      const nov = (await children(after, P1)).find((c) => c.voucher_date === '2026-11-01')!;
      expect(nov.notes).toBe(
        '[Cần rà trước khi duyệt] Có thể trùng PC-TAY-04 (cùng toà, cùng hạng mục, kỳ 11/2026).'
        + ' Số tiền lệch: Tiền nhà 5.000.000đ khác mức mặc định 4.500.000đ. Máy không tự duyệt, chưa ghi sổ quỹ.',
      );
    });
  });

  it.each([
    ['bằng mức mặc định', `('${building}', 'tien_nha', 5000000, false, NULL)`],
    ['khoản phí "không áp dụng"', `('${building}', 'tien_nha', 1000, true, NULL)`],
    ['dòng cấu hình đã xoá', `('${building}', 'tien_nha', 1000, false, now())`],
    ['chưa khai mức', `('${building}', 'tien_nha', NULL, false, NULL)`],
    ['mức của toà khác', `('${otherBuilding}', 'tien_nha', 1000, false, NULL)`],
  ])('không giữ: %s', async (_ten, values) => {
    await scenario(after, async () => {
      await after.exec(`INSERT INTO building_fee_accounts(building_id, fee_category, default_amount, not_applicable, deleted_at)
        VALUES ${values}`);
      await addParent(after, { id: P1 });
      await run(after);
      const nov = (await children(after, P1)).find((c) => c.voucher_date === '2026-11-01')!;
      expect(nov).toMatchObject({ approval_status: 'APPROVED', account_id: account, notes: 'Ghi chú mẫu' });
    });
  });

  it('phiếu cha không tự duyệt: vẫn CHỜ như cũ, thêm ghi chú để người duyệt thấy', async () => {
    await scenario(after, async () => {
      await after.exec(`INSERT INTO building_fee_accounts(building_id, fee_category, default_amount)
        VALUES ('${building}', 'tien_nha', 4000000)`);
      await addParent(after, { id: P1, auto: false });
      await run(after);
      const nov = (await children(after, P1)).find((c) => c.voucher_date === '2026-11-01')!;
      expect(nov).toMatchObject({ approval_status: 'UNAPPROVED', account_id: null });
      expect(nov.notes).toContain('khác mức mặc định 4.000.000đ');
    });
  });
});

describe('G5 — cổng bộ máy chi giữ nguyên cho phiếu không cần rà', () => {
  it('cổng áp và quyết CHỜ (vd vượt cam kết) ⇒ phiếu con CHỜ, sổ phiếu cha giữ nguyên như trước vá', async () => {
    for (const db of [before, after]) {
      await scenario(db, async () => {
        await addParent(db, { id: P1 });
        await db.exec(`SET LOCAL test.enforce = 'yes'; SET LOCAL test.gate = 'UNAPPROVED'`);
        await run(db);
        const nov = (await children(db, P1)).find((c) => c.voucher_date === '2026-11-01')!;
        expect(nov).toMatchObject({ approval_status: 'UNAPPROVED', account_id: account, notes: 'Ghi chú mẫu' });
      });
    }
  });

  it('phiếu cha không tự duyệt: cổng nhận sổ NULL + recurring_auto_approve=false như trước vá', async () => {
    await scenario(after, async () => {
      await addParent(after, { id: P1, auto: false });
      await run(after);
      expect(await lastGate(after)).toMatchObject({ account: null, context: { recurring_auto_approve: false } });
      const nov = (await children(after, P1)).find((c) => c.voucher_date === '2026-11-01')!;
      expect(nov).toMatchObject({ approval_status: 'UNAPPROVED', account_id: null, notes: 'Ghi chú mẫu' });
    });
  });
});

describe('F58 — phiếu con đã xoá mềm và kỳ cả tháng', () => {
  it('sau vá: phiếu con kỳ 11 đã xoá mềm ⇒ KHÔNG sinh lại; kỳ kế tiếp tính cả kỳ đã xoá', async () => {
    await scenario(after, async () => {
      await parentWithOctoberChild(after, { id: P1 });
      await run(after);
      await after.exec(`UPDATE income_expenses SET deleted_at = now()
        WHERE repeat_parent_id = '${P1}' AND voucher_date = '2026-11-01'`);
      expect(await run(after, '2026-11-02')).toHaveLength(0);
      const rows = await children(after, P1);
      expect(rows.map((c) => [c.voucher_date, c.deleted])).toEqual([['2026-10-01', false], ['2026-11-01', true]]);
      const { rows: p } = await after.query<{ d: string }>(
        `SELECT repeat_next_date::text AS d FROM income_expenses WHERE id = $1`, [P1]);
      expect(p[0].d).toBe('2026-12-01');
    });
  });

  it('trước vá: cùng thao tác ⇒ phiếu con bị sinh LẠI và tự duyệt', async () => {
    await scenario(before, async () => {
      await parentWithOctoberChild(before, { id: P1 });
      await run(before);
      await before.exec(`UPDATE income_expenses SET deleted_at = now()
        WHERE repeat_parent_id = '${P1}' AND voucher_date = '2026-11-01'`);
      expect(await run(before, '2026-11-02')).toHaveLength(1);
      const live = (await children(before, P1)).filter((c) => c.voucher_date === '2026-11-01' && !c.deleted);
      expect(live).toMatchObject([{ approval_status: 'APPROVED' }]);
    });
  });

  it('phí tháng neo ngày giữa tháng vẫn mang kỳ cả tháng chứa ngày kỳ', async () => {
    await scenario(after, async () => {
      await addParent(after, { id: P1, date: '2026-09-10' });
      await run(after, '2026-11-15');
      const rows = (await children(after, P1)).map((c) => [c.voucher_date, c.start_date, c.end_date]);
      expect(rows).toEqual([
        ['2026-10-10', '2026-10-01', '2026-10-31'],
        ['2026-11-10', '2026-11-01', '2026-11-30'],
      ]);
    });
  });
});

describe('idempotent', () => {
  it('chạy hai lần ⇒ lượt hai không sinh thêm, phiếu giữ chờ vẫn giữ', async () => {
    await scenario(after, async () => {
      await parentWithOctoberChild(after, { id: P1 });
      await addVoucher(after, { code: 'PC-TAY-05', from: '2026-11-01', to: '2026-11-30' });
      expect(await run(after)).toHaveLength(1);
      expect(await run(after)).toHaveLength(0);
      const rows = await children(after, P1);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ voucher_date: '2026-11-01', approval_status: 'UNAPPROVED' });
      const { rows: p } = await after.query<{ d: string }>(
        `SELECT repeat_next_date::text AS d FROM income_expenses WHERE id = $1`, [P1]);
      expect(p[0].d).toBe('2026-12-01');
    });
  });
});
