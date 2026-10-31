// 20261031120230_nguoi_giu_tien_thay_phieu_han_che: người GIỮ TIỀN (possession CUSTODIAN còn hiệu lực)
// thấy mọi phiếu trong sổ mình, kể cả phiếu có hạng mục hạn chế; mọi vai khác, cách ly công ty và mọi
// policy ghi giữ nguyên.
//
// PGlite tối thiểu: bốn policy RESTRICTIVE hạn chế, ie_item_restricted_visible, policy org_boundary và
// my_org_ids chép NGUYÊN VĂN bản sống trước migration (20260613000000 + bọc InitPlan 20261018044046); một
// policy PERMISSIVE mở hết cho mỗi lệnh để cô lập lớp RESTRICTIVE — cửa toà/sổ/lương ở prod không thuộc phạm
// vi đổi. can_view_restricted_ie() giữ đúng hình (super admin HOẶC có quyền xem hạn chế), phần quyền đọc từ
// một bảng thay cho has_any_scope_v3. Đường đọc chi tiết phiếu mô phỏng read_income_expense_details_v1: hàm
// SECURITY DEFINER do role thành viên authenticated sở hữu, row_security on.
// Mỗi ca BEGIN…ROLLBACK; đột biến migration phải làm lệch ma trận ai-thấy-gì.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Checkout Windows có thể là CRLF; đột biến bên dưới so chuỗi theo LF.
const MIGRATION = readFileSync('supabase/migrations/20261031120230_nguoi_giu_tien_thay_phieu_han_che.sql', 'utf8')
  .replace(/\r\n/g, '\n');

const ORG = '00000000-0000-4000-8000-000000000001';
const ORG2 = '00000000-0000-4000-8000-000000000002';
const SO_A = '00000000-0000-4000-8000-0000000000a1';
const SO_B = '00000000-0000-4000-8000-0000000000b1';
const SO_C = '00000000-0000-4000-8000-0000000000c1';
const U = {
  SUPER: '00000000-0000-4000-8000-000000000101',
  XEM_HAN_CHE: '00000000-0000-4000-8000-000000000102',
  GIU_A: '00000000-0000-4000-8000-000000000103',
  BIET_A: '00000000-0000-4000-8000-000000000104',
  VAN_HANH_A: '00000000-0000-4000-8000-000000000105',
  GIU_B: '00000000-0000-4000-8000-000000000106',
  NGUOI_LAP: '00000000-0000-4000-8000-000000000107',
  HET_HAN_A: '00000000-0000-4000-8000-000000000108',
  CHUA_HIEU_LUC_A: '00000000-0000-4000-8000-000000000109',
  TREO_A: '00000000-0000-4000-8000-000000000110',
  GIU_C_CONG_TY_2: '00000000-0000-4000-8000-000000000111',
} as const;
type Ai = keyof typeof U | 'KHACH';
const AI: Ai[] = [...(Object.keys(U) as (keyof typeof U)[]), 'KHACH'];

const SCHEMA = `
CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
CREATE ROLE ie_detail_reader; GRANT authenticated TO ie_detail_reader;
CREATE SCHEMA auth; CREATE SCHEMA app_private;
GRANT USAGE ON SCHEMA auth TO authenticated;
-- Đúng định nghĩa auth.uid() của Supabase: đọc sub từ claim JWT của request.
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);
CREATE TABLE public.nguoi_xem_han_che(user_id uuid PRIMARY KEY);
CREATE TABLE public.organization_memberships(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  user_id uuid NOT NULL, status text NOT NULL);
CREATE TABLE public.cashbook_possession_bindings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
  cashbook_id uuid NOT NULL, membership_id uuid NOT NULL, possession_kind text NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now() - interval '1 day', valid_to timestamptz);
CREATE TABLE public.income_expenses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tag text NOT NULL UNIQUE, organization_id uuid,
  user_id uuid, has_restricted_item boolean NOT NULL DEFAULT false, account_id uuid, change_account_id uuid,
  rounding_account_id uuid, deleted_at timestamptz, note text);
CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tag text NOT NULL UNIQUE,
  income_expense_id uuid NOT NULL, organization_id uuid, note text);

CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  RETURN (SELECT EXISTS (SELECT 1 FROM public.super_admins WHERE user_id = auth.uid()));
END $$;
CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'public' AS $$
BEGIN
  RETURN (
    SELECT COALESCE(array_agg(organization_id), '{}'::uuid[])
    FROM public.organization_memberships
    WHERE user_id = auth.uid() AND status = 'ACTIVE'
  );
END $$;
CREATE FUNCTION public.can_view_restricted_ie() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'public', 'app_private' AS $$
BEGIN
  RETURN public.is_super_admin() OR EXISTS (SELECT 1 FROM public.nguoi_xem_han_che WHERE user_id = auth.uid());
END $$;
-- Nguyên văn bản sống (20260613000000).
CREATE FUNCTION public.ie_item_restricted_visible(_ie_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public', 'auth' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = _ie_id
      AND (
        ie.has_restricted_item = false
        OR ie.user_id = auth.uid()
        OR public.can_view_restricted_ie()
      )
  );
$$;

ALTER TABLE public.income_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.income_expense_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE, DELETE ON public.income_expenses, public.income_expense_items TO authenticated;
CREATE POLICY mo_select ON public.income_expenses FOR SELECT TO authenticated USING (true);
CREATE POLICY mo_update ON public.income_expenses FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY mo_delete ON public.income_expenses FOR DELETE TO authenticated USING (true);
CREATE POLICY mo_select ON public.income_expense_items FOR SELECT TO authenticated USING (true);
CREATE POLICY mo_update ON public.income_expense_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY mo_delete ON public.income_expense_items FOR DELETE TO authenticated USING (true);

-- Cách ly công ty: nguyên văn bản sống.
CREATE POLICY income_expenses_org_boundary ON public.income_expenses AS RESTRICTIVE FOR ALL TO authenticated
  USING ((organization_id IS NULL) OR (SELECT public.is_super_admin()) OR (organization_id IN (SELECT unnest(public.my_org_ids()))))
  WITH CHECK ((organization_id IS NULL) OR (SELECT public.is_super_admin()) OR (organization_id IN (SELECT unnest(public.my_org_ids()))));
CREATE POLICY income_expense_items_org_boundary ON public.income_expense_items AS RESTRICTIVE FOR ALL TO authenticated
  USING ((organization_id IS NULL) OR (SELECT public.is_super_admin()) OR (organization_id IN (SELECT unnest(public.my_org_ids()))))
  WITH CHECK ((organization_id IS NULL) OR (SELECT public.is_super_admin()) OR (organization_id IN (SELECT unnest(public.my_org_ids()))));

-- Bốn policy RESTRICTIVE hạn chế: nguyên văn bản sống (select đã bọc InitPlan ở 20261018044046).
CREATE POLICY income_expenses_restricted_select ON public.income_expenses AS RESTRICTIVE FOR SELECT TO authenticated
  USING (has_restricted_item = false OR user_id = (SELECT auth.uid()) OR (SELECT public.can_view_restricted_ie()));
CREATE POLICY income_expenses_restricted_update ON public.income_expenses AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (has_restricted_item = false OR user_id = auth.uid() OR public.can_view_restricted_ie());
CREATE POLICY income_expenses_restricted_delete ON public.income_expenses AS RESTRICTIVE FOR DELETE TO authenticated
  USING (has_restricted_item = false OR user_id = auth.uid() OR public.can_view_restricted_ie());
CREATE POLICY income_expense_items_restricted_select ON public.income_expense_items AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.ie_item_restricted_visible(income_expense_id));
CREATE POLICY income_expense_items_restricted_update ON public.income_expense_items AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.ie_item_restricted_visible(income_expense_id));
CREATE POLICY income_expense_items_restricted_delete ON public.income_expense_items AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.ie_item_restricted_visible(income_expense_id));

-- Mô phỏng read_income_expense_details_v1: DEFINER, owner là role thành viên authenticated, row_security on.
CREATE FUNCTION public.doc_chi_tiet_thu() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'public', 'app_private' SET row_security TO 'on' AS $$
BEGIN
  RETURN jsonb_build_object(
    'phieu', (SELECT coalesce(jsonb_agg(v.tag), '[]'::jsonb) FROM public.income_expenses v),
    'dong', (SELECT coalesce(jsonb_agg(i.tag), '[]'::jsonb) FROM public.income_expense_items i));
END $$;
ALTER FUNCTION public.doc_chi_tiet_thu() OWNER TO ie_detail_reader;
GRANT EXECUTE ON FUNCTION public.doc_chi_tiet_thu() TO authenticated;

INSERT INTO public.super_admins VALUES ('${U.SUPER}');
INSERT INTO public.nguoi_xem_han_che VALUES ('${U.XEM_HAN_CHE}');
INSERT INTO public.organization_memberships(organization_id, user_id, status)
  SELECT CASE WHEN u = '${U.GIU_C_CONG_TY_2}'::uuid THEN '${ORG2}'::uuid ELSE '${ORG}'::uuid END, u,
         CASE WHEN u = '${U.TREO_A}'::uuid THEN 'SUSPENDED' ELSE 'ACTIVE' END
    FROM unnest(ARRAY[${Object.values(U).map((v) => `'${v}'`).join(', ')}]::uuid[]) u;
INSERT INTO public.cashbook_possession_bindings(organization_id, cashbook_id, membership_id, possession_kind, valid_from, valid_to)
  SELECT m.organization_id, s.cashbook, m.id, s.kind, now() + s.from_offset, now() + s.to_offset
    FROM (VALUES
      ('${U.GIU_A}'::uuid,           '${SO_A}'::uuid, 'CUSTODIAN', interval '-1 day', NULL::interval),
      ('${U.BIET_A}'::uuid,          '${SO_A}'::uuid, 'KNOWER',    interval '-1 day', NULL),
      ('${U.VAN_HANH_A}'::uuid,      '${SO_A}'::uuid, 'OPERATOR',  interval '-1 day', NULL),
      ('${U.GIU_B}'::uuid,           '${SO_B}'::uuid, 'CUSTODIAN', interval '-1 day', NULL),
      ('${U.HET_HAN_A}'::uuid,       '${SO_A}'::uuid, 'CUSTODIAN', interval '-3 days', interval '-1 day'),
      ('${U.CHUA_HIEU_LUC_A}'::uuid, '${SO_A}'::uuid, 'CUSTODIAN', interval '1 day', NULL),
      ('${U.TREO_A}'::uuid,          '${SO_A}'::uuid, 'CUSTODIAN', interval '-1 day', NULL),
      ('${U.GIU_C_CONG_TY_2}'::uuid, '${SO_C}'::uuid, 'CUSTODIAN', interval '-1 day', NULL)
    ) AS s(user_id, cashbook, kind, from_offset, to_offset)
    JOIN public.organization_memberships m ON m.user_id = s.user_id;
-- Phiếu: H = có hạng mục hạn chế, T = thường. Hai phiếu cuối thuộc công ty 2, một phiếu trỏ nhầm sổ A.
INSERT INTO public.income_expenses(tag, organization_id, user_id, has_restricted_item, account_id, change_account_id, rounding_account_id) VALUES
  ('H_so_A',            '${ORG}',  '${U.NGUOI_LAP}', true,  '${SO_A}', NULL,      NULL),
  ('H_thoi_vao_A',      '${ORG}',  '${U.NGUOI_LAP}', true,  '${SO_B}', '${SO_A}', NULL),
  ('H_lam_tron_A',      '${ORG}',  '${U.NGUOI_LAP}', true,  '${SO_B}', NULL,      '${SO_A}'),
  ('H_so_B',            '${ORG}',  '${U.NGUOI_LAP}', true,  '${SO_B}', NULL,      NULL),
  ('H_khong_so',        '${ORG}',  '${U.NGUOI_LAP}', true,  NULL,      NULL,      NULL),
  ('H_so_B_biet_A_lap', '${ORG}',  '${U.BIET_A}',    true,  '${SO_B}', NULL,      NULL),
  ('T_so_A',            '${ORG}',  '${U.NGUOI_LAP}', false, '${SO_A}', NULL,      NULL),
  ('T_so_B',            '${ORG}',  '${U.NGUOI_LAP}', false, '${SO_B}', NULL,      NULL),
  ('H_cty2_so_C',       '${ORG2}', '${U.NGUOI_LAP}', true,  '${SO_C}', NULL,      NULL),
  ('H_cty2_tro_so_A',   '${ORG2}', '${U.NGUOI_LAP}', true,  '${SO_A}', NULL,      NULL),
  ('T_cty2_so_C',       '${ORG2}', '${U.NGUOI_LAP}', false, '${SO_C}', NULL,      NULL);
INSERT INTO public.income_expense_items(tag, income_expense_id, organization_id)
  SELECT 'dong_' || tag, id, organization_id FROM public.income_expenses;
`;

const sap = (xs: string[]) => [...xs].sort();
const THUONG = ['T_so_A', 'T_so_B'];
const HAN_CHE_NGUOI_LAP = ['H_khong_so', 'H_lam_tron_A', 'H_so_A', 'H_so_B', 'H_thoi_vao_A'];
const CONG_TY_1 = sap([...HAN_CHE_NGUOI_LAP, 'H_so_B_biet_A_lap', ...THUONG]);
const CONG_TY_2 = ['H_cty2_so_C', 'H_cty2_tro_so_A', 'T_cty2_so_C'];

/** Ai thấy phiếu nào TRƯỚC migration: chỉ super admin, người có quyền xem hạn chế và người lập, trong công ty mình. */
const TRUOC: Record<Ai, string[]> = {
  SUPER: sap([...CONG_TY_1, ...CONG_TY_2]),
  XEM_HAN_CHE: CONG_TY_1,
  GIU_A: sap(THUONG),
  BIET_A: sap([...THUONG, 'H_so_B_biet_A_lap']),
  VAN_HANH_A: sap(THUONG),
  GIU_B: sap(THUONG),
  NGUOI_LAP: sap([...THUONG, ...HAN_CHE_NGUOI_LAP]),
  HET_HAN_A: sap(THUONG),
  CHUA_HIEU_LUC_A: sap(THUONG),
  TREO_A: [],
  GIU_C_CONG_TY_2: ['T_cty2_so_C'],
  KHACH: [],
};
/** SAU migration: chỉ người giữ tiền còn hiệu lực thấy thêm phiếu hạn chế có sổ chính/thối/làm tròn là sổ mình,
 *  và chỉ trong công ty mình (phiếu công ty 2 trỏ nhầm sổ A vẫn không lọt sang người giữ sổ A). */
const SAU: Record<Ai, string[]> = {
  ...TRUOC,
  GIU_A: sap([...THUONG, 'H_so_A', 'H_thoi_vao_A', 'H_lam_tron_A']),
  // Sổ chính là B: cả phiếu thối/làm tròn vào A vì sổ chính của chúng là B.
  GIU_B: sap([...THUONG, 'H_so_B', 'H_thoi_vao_A', 'H_lam_tron_A', 'H_so_B_biet_A_lap']),
  GIU_C_CONG_TY_2: sap(['T_cty2_so_C', 'H_cty2_so_C']),
};
/** Tập sổ đang giữ tiền theo app_private.my_custodian_cashbook_ids_v1(). */
const SO_GIU: Record<Ai, string[]> = {
  ...(Object.fromEntries(AI.map((ai) => [ai, []])) as unknown as Record<Ai, string[]>),
  GIU_A: [SO_A],
  GIU_B: [SO_B],
  GIU_C_CONG_TY_2: [SO_C],
};

const db = new PGlite();

async function asUser<T>(ai: Ai, run: () => Promise<T>, { role = true } = {}): Promise<T> {
  if (role) await db.exec('SET LOCAL ROLE authenticated');
  const claims = ai === 'KHACH' ? '' : JSON.stringify({ sub: U[ai], role: 'authenticated' });
  await db.query("SELECT set_config('request.jwt.claims', $1, true)", [claims]);
  try {
    return await run();
  } finally {
    if (role) await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claims', '', true)");
  }
}

type Goc = { phieu: string[]; dong: string[] };
type O = { truc_tiep: Goc; chi_tiet: Goc; so_giu?: string[] };
type MaTran = Record<Ai, O>;

async function maTran({ coHam }: { coHam: boolean }): Promise<MaTran> {
  const out = {} as MaTran;
  for (const ai of AI) {
    const truc_tiep = await asUser(ai, async () => ({
      phieu: sap((await db.query<{ tag: string }>('SELECT tag FROM public.income_expenses')).rows.map((r) => r.tag)),
      dong: sap((await db.query<{ tag: string }>('SELECT tag FROM public.income_expense_items')).rows.map((r) => r.tag)),
    }));
    const chi_tiet = await asUser(ai, async () => {
      const r = (await db.query<{ v: { phieu: string[]; dong: string[] } }>('SELECT public.doc_chi_tiet_thu() AS v')).rows[0].v;
      return { phieu: sap(r.phieu), dong: sap(r.dong) };
    });
    const o: O = { truc_tiep, chi_tiet };
    if (coHam) {
      // Hàm DEFINER chỉ đọc auth.uid() từ claim: gọi bằng role hiện tại với claim của người đó.
      o.so_giu = await asUser(ai, async () => sap(
        (await db.query<{ id: string }>('SELECT x::text AS id FROM app_private.my_custodian_cashbook_ids_v1() x')).rows.map((r) => r.id),
      ), { role: false });
    }
    out[ai] = o;
  }
  return out;
}

function mongDoi(bang: Record<Ai, string[]>, soGiu?: Record<Ai, string[]>): MaTran {
  return Object.fromEntries(AI.map((ai) => {
    const goc = { phieu: bang[ai], dong: bang[ai].map((t) => `dong_${t}`).sort() };
    const o: O = { truc_tiep: goc, chi_tiet: goc };
    if (soGiu) o.so_giu = sap(soGiu[ai]);
    return [ai, o];
  })) as MaTran;
}

async function trongGiaoDich<T>(run: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN');
  try {
    return await run();
  } finally {
    await db.exec('ROLLBACK');
  }
}

/** Thân migration bỏ khối nghiệm thu: để đột biến đi tới ma trận thay vì dừng ở kiểm chữ. */
function boNghiemThu(sql: string): string {
  const start = sql.indexOf('DO $nghiem_thu$');
  const end = sql.indexOf('$nghiem_thu$;', start);
  expect(start).toBeGreaterThan(0);
  return sql.slice(0, start) + sql.slice(end + '$nghiem_thu$;'.length);
}

beforeAll(async () => {
  await db.exec(SCHEMA);
}, 120_000);

afterAll(() => db.close());

describe('người giữ tiền thấy phiếu hạn chế trong sổ mình', () => {
  it('TRƯỚC migration: ma trận đúng bản sống, đọc thẳng = đọc qua hàm chi tiết, không rỗng', async () => {
    const truoc = await trongGiaoDich(() => maTran({ coHam: false }));
    expect(truoc).toEqual(mongDoi(TRUOC));
    expect(truoc.SUPER.truc_tiep.phieu).toHaveLength(11);
    expect(truoc.GIU_A.truc_tiep.phieu).not.toContain('H_so_A');
  }, 30_000);

  it('SAU migration: chỉ người giữ tiền còn hiệu lực thấy thêm, cả phiếu, dòng phiếu và đường chi tiết', async () => {
    const sau = await trongGiaoDich(async () => {
      await db.exec(MIGRATION);
      return maTran({ coHam: true });
    });
    expect(sau).toEqual(mongDoi(SAU, SO_GIU));
  }, 30_000);

  it('cách ly công ty: phiếu công ty khác trỏ nhầm sổ mình giữ vẫn không lọt', async () => {
    const sau = await trongGiaoDich(async () => {
      await db.exec(MIGRATION);
      return maTran({ coHam: true });
    });
    for (const ai of AI.filter((x) => x !== 'SUPER')) {
      expect(sau[ai].truc_tiep.phieu).not.toContain('H_cty2_tro_so_A');
    }
    expect(sau.GIU_A.so_giu).toEqual([SO_A]);
  }, 30_000);

  it('chạy lại hai lượt trong cùng giao dịch vẫn đạt và cho cùng ma trận', async () => {
    const sau = await trongGiaoDich(async () => {
      await db.exec(MIGRATION);
      await db.exec(MIGRATION);
      return maTran({ coHam: true });
    });
    expect(sau).toEqual(mongDoi(SAU, SO_GIU));
  }, 30_000);

  it('policy ghi giữ nguyên: người giữ tiền vẫn không sửa/xoá được phiếu và dòng phiếu hạn chế', async () => {
    const ket = await trongGiaoDich(async () => {
      await db.exec(MIGRATION);
      return asUser('GIU_A', async () => ({
        suaHanChe: (await db.query(`UPDATE public.income_expenses SET note = 'x' WHERE tag = 'H_so_A' RETURNING id`)).rows.length,
        xoaHanChe: (await db.query(`DELETE FROM public.income_expenses WHERE tag = 'H_thoi_vao_A' RETURNING id`)).rows.length,
        suaDong: (await db.query(`UPDATE public.income_expense_items SET note = 'x' WHERE tag = 'dong_H_so_A' RETURNING id`)).rows.length,
        xoaDong: (await db.query(`DELETE FROM public.income_expense_items WHERE tag = 'dong_H_lam_tron_A' RETURNING id`)).rows.length,
        // Đối chứng: đường ghi của bộ dựng này hoạt động với phiếu thường.
        suaThuong: (await db.query(`UPDATE public.income_expenses SET note = 'x' WHERE tag = 'T_so_A' RETURNING id`)).rows.length,
      }));
    });
    expect(ket).toEqual({ suaHanChe: 0, xoaHanChe: 0, suaDong: 0, xoaDong: 0, suaThuong: 1 });
  }, 30_000);

  it('policy sống lệch bản đã review thì migration dừng, không ghi đè', async () => {
    await trongGiaoDich(async () => {
      await db.exec('ALTER POLICY income_expenses_restricted_select ON public.income_expenses USING (has_restricted_item = false)');
      await expect(db.exec(MIGRATION)).rejects.toThrow(/lech ban da review/);
    });
    await trongGiaoDich(async () => {
      await db.exec('ALTER POLICY income_expense_items_restricted_select ON public.income_expense_items USING (true)');
      await expect(db.exec(MIGRATION)).rejects.toThrow(/lech ban da review/);
    });
  }, 30_000);

  it('nghiệm thu bắt policy ghi hạn chế bị đổi cùng đợt', async () => {
    const dot = MIGRATION.replace(
      'ALTER POLICY income_expense_items_restricted_select',
      `ALTER POLICY income_expenses_restricted_update ON public.income_expenses USING (true);\nALTER POLICY income_expense_items_restricted_select`,
    );
    expect(dot).not.toBe(MIGRATION);
    await trongGiaoDich(async () => {
      await expect(db.exec(dot)).rejects.toThrow(/policy ghi han che bi doi/);
    });
  }, 30_000);

  const DOT_BIEN: [string, string, string][] = [
    ['nhận mọi loại possession', "       AND b.possession_kind = 'CUSTODIAN'\n", ''],
    ['nhầm KNOWER thành người giữ tiền', "b.possession_kind = 'CUSTODIAN'", "b.possession_kind = 'KNOWER'"],
    ['bỏ hạn hết hiệu lực', '       AND (b.valid_to IS NULL OR b.valid_to > now());\n', ';\n'],
    ['bỏ ngày bắt đầu hiệu lực', '       AND b.valid_from <= now()\n', ''],
    ['bỏ trạng thái membership', "       AND m.status = 'ACTIVE'\n", ''],
    ['bỏ điều kiện người gọi', "     WHERE m.user_id = auth.uid()\n       AND m.status = 'ACTIVE'\n", "     WHERE m.status = 'ACTIVE'\n"],
    ['bỏ nhánh sổ chính của phiếu', '    OR account_id IN (SELECT app_private.my_custodian_cashbook_ids_v1())\n', ''],
    ['bỏ nhánh sổ thối của phiếu', '    OR change_account_id IN (SELECT app_private.my_custodian_cashbook_ids_v1())\n', ''],
    ['bỏ nhánh sổ làm tròn của phiếu', '    OR rounding_account_id IN (SELECT app_private.my_custodian_cashbook_ids_v1())\n', ''],
    ['bỏ nhánh người giữ tiền của dòng phiếu', '\n    OR app_private.ie_in_my_custodian_cashbook_v1(income_expense_id)\n', '\n'],
    ['hàm dòng phiếu bỏ cột sổ thối', '\n            OR ie.change_account_id IN (SELECT app_private.my_custodian_cashbook_ids_v1())', ''],
  ];
  for (const [ten, tu, thanh] of DOT_BIEN) {
    it(`đột biến "${ten}" làm lệch ma trận`, async () => {
      const goc = boNghiemThu(MIGRATION);
      const dot = goc.replace(tu, thanh);
      expect(dot).not.toBe(goc);
      const ket = await trongGiaoDich(async () => {
        await db.exec(dot);
        return maTran({ coHam: true });
      });
      expect(ket).not.toEqual(mongDoi(SAU, SO_GIU));
    }, 30_000);
  }
});
