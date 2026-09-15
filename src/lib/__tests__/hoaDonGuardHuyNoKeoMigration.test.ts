/**
 * Rà soát 15/09/2026 — plan con H1 (hoá đơn).
 *
 * Bài này chạy THẬT migration `hoa_don_guard_huy_no_keo_subtotal_ngay` trên
 * PGlite rồi gọi đúng các RPC đã vá, thay vì chỉ so chuỗi. Lý do: bảy lỗ H1
 * đều là lỗ HÀNH VI (guard thiếu, thứ tự nhánh, predicate thiếu), so chuỗi
 * không phân biệt được "có viết" với "có tác dụng".
 *
 * Hai hàm khổng lồ `record_invoice_collection_v5` (934 dòng) và
 * `reverse_invoice_collection_v5` (420 dòng) kéo theo vài chục bảng phụ nên chỉ
 * được kiểm bằng khẳng định trên thân hàm — ghi rõ ở tên bài để không ai tưởng
 * chúng đã được chạy thử.
 */
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260915074716_hoa_don_guard_huy_no_keo_subtotal_ngay.sql';
const sql = readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');

/**
 * Thân hàm trong ĐỊNH NGHĨA CUỐI CÙNG của toàn bộ thư mục migration, không phải
 * trong một file đóng băng — khuôn bắt buộc của gate:migration-test-liveness.
 */
function thanHamHienHanh(ten: string): string {
  const dau = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${ten}(`);
  expect(dau, ten).toBeGreaterThanOrEqual(0);
  const moThan = sql.indexOf('AS $function$', dau);
  const dongThan = sql.indexOf('$function$', moThan + 13);
  expect(dongThan, ten).toBeGreaterThan(moThan);
  return sql.slice(dau, dongThan + 10);
}

const org = 'dddd0000-0000-4000-8000-000000000001';
const orgKhac = 'dddd0000-0000-4000-8000-0000000000ff';
const actor = '00000000-0000-4000-8000-000000000002';
const toa = '00000000-0000-4000-8000-000000000003';
const toaKhac = '00000000-0000-4000-8000-0000000000f3';
const hopDong = '00000000-0000-4000-8000-000000000005';
const hopDongKhac = '00000000-0000-4000-8000-0000000000f5';
const hd = '00000000-0000-4000-8000-000000000001';

const db = new PGlite();

const nen = `
  CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
  CREATE SCHEMA auth; CREATE SCHEMA app_private;
  CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users VALUES ('${actor}');
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT '${actor}'::uuid $f$;

  CREATE TYPE public.payment_method AS ENUM ('TM','TK','TT');
  CREATE TYPE public.invoice_status AS ENUM ('DRAFT','PENDING_APPROVAL','APPROVED','PARTIAL_PAID','PAID','OVERDUE','CANCELLED');
  CREATE TYPE public.invoice_item_type AS ENUM ('RENT','SERVICE','PENALTY','DISCOUNT','OTHER');

  CREATE TABLE public.organizations(id uuid PRIMARY KEY, status text DEFAULT 'ACTIVE');
  INSERT INTO public.organizations VALUES ('${org}'), ('${orgKhac}');
  CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz);
  INSERT INTO public.buildings VALUES ('${toa}','${org}',NULL), ('${toaKhac}','${orgKhac}',NULL);
  CREATE TABLE public.rooms(id uuid PRIMARY KEY, organization_id uuid, building_id uuid, deleted_at timestamptz);
  CREATE TABLE public.contracts(id uuid PRIMARY KEY, organization_id uuid, deleted_at timestamptz);
  INSERT INTO public.contracts VALUES ('${hopDong}','${org}',NULL), ('${hopDongKhac}','${org}',NULL);

  CREATE TABLE public.invoices(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, organization_id uuid,
    contract_id uuid, building_id uuid, room_id uuid, invoice_number text,
    billing_month text DEFAULT '2026-09', kind text DEFAULT 'MONTHLY',
    issue_date date DEFAULT '2026-09-01', due_date date DEFAULT '2026-09-10',
    status public.invoice_status DEFAULT 'APPROVED', deleted_at timestamptz,
    created_at timestamptz DEFAULT '2026-09-01', updated_at timestamptz DEFAULT '2026-09-01',
    subtotal numeric(15,2) DEFAULT 0, discount_amount numeric(15,2) DEFAULT 0, discount_notes text,
    electricity_prev_overridden boolean DEFAULT false,
    total_amount numeric(15,2) DEFAULT 0, prepaid_amount numeric(15,2) DEFAULT 0,
    paid_amount numeric(15,2) DEFAULT 0, paid_date date,
    previous_debt numeric(15,2) DEFAULT 0, previous_debt_sources jsonb DEFAULT '[]',
    notes text, template_id uuid, creator_name text, approved_by uuid, approved_at timestamptz,
    adjustment_revision int DEFAULT 0);
  CREATE TABLE public.invoice_items(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid, organization_id uuid,
    service_id uuid, type public.invoice_item_type DEFAULT 'OTHER', description text,
    unit_price numeric, quantity numeric, coefficient numeric, amount numeric,
    previous_reading numeric, current_reading numeric, from_date date, to_date date,
    sort_order int, accounting_class text DEFAULT 'REVENUE');
  CREATE TABLE public.payments(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid, collection_id uuid,
    amount numeric, payment_date date, rounding_amount numeric DEFAULT 0, reversed_at timestamptz);
  CREATE TABLE public.income_expense_types(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
  CREATE TABLE public.income_expenses(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid, type text DEFAULT 'INCOME',
    approval_status text DEFAULT 'APPROVED', deleted_at timestamptz, payment_collection_id uuid,
    total_amount numeric DEFAULT 0, rounding_amount numeric DEFAULT 0, notes text);
  CREATE TABLE public.income_expense_items(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), income_expense_id uuid,
    income_expense_type_id uuid, amount numeric, unit_price numeric, quantity numeric);
  CREATE TABLE public.invoice_payment_collections(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, invoice_id uuid,
    status text DEFAULT 'ACTIVE', collection_date date, expected_paid_amount numeric,
    applied_amount numeric);
  CREATE TABLE public.customer_credit_applications(invoice_id uuid, reversed_at timestamptz);
  -- Chỉ để %ROWTYPE trong DECLARE của hai RPC thu/hoàn tác biên dịch được;
  -- không bài nào gọi tới chúng (xem nhóm "khẳng định trên thân hàm").
  CREATE TABLE public.invoice_payment_tenders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid);
  CREATE TABLE public.customer_credit_lots(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_collection_id uuid, amount numeric, remaining_amount numeric);
  CREATE TABLE public.excess_amounts(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, organization_id uuid,
    contract_id uuid, amount numeric, description text, source_invoice_id uuid, source_payment_id uuid);
  CREATE TABLE public.settings(user_id uuid, key text, value jsonb);
  CREATE TABLE public.organization_invoice_settings(organization_id uuid PRIMARY KEY, auto_approve_invoice boolean);
  INSERT INTO public.organization_invoice_settings VALUES ('${org}', true), ('${orgKhac}', true);
  CREATE TABLE app_private.canonical_write_operations(
    id uuid DEFAULT gen_random_uuid(), organization_id uuid, operation text, subject_scope text,
    subject_id uuid, actor_id uuid, idempotency_key text, payload_hash text,
    response_payload jsonb, completed_at timestamptz,
    UNIQUE(organization_id, operation, subject_scope, actor_id, idempotency_key));

  -- "Hôm nay" điều khiển được để đo nhánh quá hạn và năm của số hoá đơn.
  CREATE FUNCTION public.org_today_v1(p_organization_id uuid DEFAULT NULL) RETURNS date
    LANGUAGE sql STABLE AS $f$
      SELECT COALESCE(NULLIF(current_setting('test.hom_nay', true), ''), '2026-09-15')::date $f$;
  CREATE FUNCTION app_private.round_invoice_total_v1(p_total numeric) RETURNS numeric
    LANGUAGE sql IMMUTABLE AS $f$
      SELECT CASE WHEN p_total IS NULL OR p_total <= 0 THEN p_total
                  WHEN mod(p_total,1000) = 0 THEN p_total
                  WHEN mod(p_total,1000) >= 900 THEN ceil(p_total/1000.0)*1000
                  ELSE floor(p_total/1000.0)*1000 END $f$;
  CREATE FUNCTION app_private.can_edit_invoice_building_v1(uuid) RETURNS boolean
    LANGUAGE sql STABLE AS $f$ SELECT COALESCE(current_setting('test.cam', true),'') <> 'true' $f$;
  CREATE FUNCTION app_private.assert_invoice_credit_cancellable_v1(uuid) RETURNS void
    LANGUAGE sql AS $f$ SELECT NULL::void $f$;
  CREATE FUNCTION app_private.reverse_invoice_customer_credit_v1(uuid, uuid, text, text) RETURNS jsonb
    LANGUAGE sql AS $f$ SELECT '{"reversed":true}'::jsonb $f$;
  CREATE FUNCTION app_private.begin_accounting_chain_write_v1() RETURNS void
    LANGUAGE sql AS $f$ SELECT NULL::void $f$;
  CREATE FUNCTION app_private.end_accounting_chain_write_v1() RETURNS void
    LANGUAGE sql AS $f$ SELECT NULL::void $f$;
  CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void
    LANGUAGE sql AS $f$ SELECT NULL::void $f$;
  CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid, uuid, text, uuid, uuid)
    RETURNS TABLE(allowed boolean) LANGUAGE sql STABLE AS $f$ SELECT true $f$;
  CREATE FUNCTION app_private.evaluate_feature_route(text, uuid) RETURNS text
    LANGUAGE sql STABLE AS $f$ SELECT 'CANONICAL'::text $f$;
`;

beforeAll(async () => {
  await db.exec(nen);
  await db.exec(sql);
  await db.exec(`
    CREATE TRIGGER trg_so_hoa_don BEFORE INSERT ON public.invoices
      FOR EACH ROW EXECUTE FUNCTION public.generate_invoice_number_v2();
  `);
}, 60000);
afterAll(async () => {
  await db.close();
});

/** Mỗi kịch bản chạy trong một giao dịch rồi cuộn lại. */
async function canh(fn: () => Promise<void>) {
  await db.exec('BEGIN');
  try {
    await fn();
  } finally {
    await db.exec('ROLLBACK');
  }
}

/**
 * Một lỗi SQL làm HỎNG cả giao dịch, nên mọi câu sau đó trả "current transaction
 * is aborted" — tức bài test sau sẽ đỏ vì lý do sai. Bọc savepoint để phép thử
 * "phải ném" không kéo đổ phần còn lại của kịch bản.
 */
let demSavepoint = 0;
async function phaiNem(chay: () => Promise<unknown>) {
  const sp = `sp_${(demSavepoint += 1)}`;
  await db.exec(`SAVEPOINT ${sp}`);
  await expect(chay()).rejects.toThrow();
  await db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
}

async function taoHoaDon(fields: Record<string, string | number | null> = {}) {
  const base: Record<string, string | number | null> = {
    id: `'${hd}'`,
    organization_id: `'${org}'`,
    building_id: `'${toa}'`,
    contract_id: `'${hopDong}'`,
    user_id: `'${actor}'`,
    invoice_number: `'INV-2026-00001'`,
    total_amount: 100000,
    subtotal: 100000,
    paid_amount: 0,
    status: `'APPROVED'`,
    due_date: `'2026-09-10'`,
    ...fields,
  };
  await db.exec(
    `INSERT INTO public.invoices(${Object.keys(base).join(',')}) VALUES (${Object.values(base).join(',')})`,
  );
}

const trangThai = async (id = hd) =>
  (
    await db.query<{ status: string; paid_amount: string }>(
      `SELECT status, paid_amount FROM public.invoices WHERE id='${id}'`,
    )
  ).rows[0];

describe('H1 — hoá đơn: guard huỷ, nợ kéo, subtotal, ngày (chạy thật trên PGlite)', () => {
  describe('H1.1 hàng rào huỷ nằm ở DB, không chỉ ở client', () => {
    it.each(['PAID', 'PARTIAL_PAID', 'OVERDUE'] as const)(
      'từ chối huỷ hoá đơn %s',
      (status) =>
        canh(async () => {
          await taoHoaDon({ status: `'${status}'`, paid_amount: 100000 });
          await phaiNem(() => db.query(`SELECT public.cancel_invoice_v1('${hd}')`));
        }),
    );

    it('từ chối huỷ hoá đơn APPROVED đã thu một phần tiền qua CẢ HAI đường', () =>
      canh(async () => {
        await taoHoaDon({ paid_amount: 1 });
        await phaiNem(() => db.query(`SELECT public.cancel_invoice_v1('${hd}')`));
        await phaiNem(() =>
          db.query(
            `SELECT public.cancel_invoice_with_credit_v1('${hd}','key-huy-0001')`,
          ),
        );
        expect((await trangThai()).status).toBe('APPROVED');
      }));

    it('vẫn cho huỷ DRAFT/APPROVED chưa thu tiền qua cả hai đường', () =>
      canh(async () => {
        await taoHoaDon({ status: `'DRAFT'` });
        await db.query(`SELECT public.cancel_invoice_v1('${hd}')`);
        expect((await trangThai()).status).toBe('CANCELLED');

        await db.exec(`UPDATE public.invoices SET status='APPROVED' WHERE id='${hd}'`);
        await db.query(
          `SELECT public.cancel_invoice_with_credit_v1('${hd}','key-huy-0002')`,
        );
        expect((await trangThai()).status).toBe('CANCELLED');
      }));

    it('huỷ lại hoá đơn đã huỷ vẫn là noop, không báo lỗi', () =>
      canh(async () => {
        await taoHoaDon({ status: `'CANCELLED'`, paid_amount: 100000 });
        await db.query(`SELECT public.cancel_invoice_v1('${hd}')`);
        const r = await db.query<{ noop: boolean }>(
          `SELECT (public.cancel_invoice_with_credit_v1('${hd}','key-huy-0003')->>'noop')::boolean AS noop`,
        );
        expect(r.rows[0].noop).toBe(true);
      }));
  });

  describe('H1.2 nợ kéo chỉ được cộng trong cùng tổ chức', () => {
    it('hoá đơn gánh ở tổ chức KHÁC không đẩy hoá đơn nạn nhân thành PAID', () =>
      canh(async () => {
        await taoHoaDon({ paid_amount: 0 });
        await db.exec(
          `INSERT INTO public.invoices(organization_id,building_id,contract_id,status,total_amount,previous_debt_sources)
           VALUES ('${orgKhac}','${toaKhac}',NULL,'PAID',100000,
                   '[{"type":"invoice","id":"${hd}","amount":100000}]'::jsonb)`,
        );
        await db.query(`SELECT public.recompute_invoice_for_id('${hd}')`);
        expect(await trangThai()).toMatchObject({ status: 'OVERDUE', paid_amount: '0.00' });
      }));

    it('hoá đơn gánh CÙNG tổ chức vẫn cộng như cũ', () =>
      canh(async () => {
        await taoHoaDon({ paid_amount: 0 });
        await db.exec(
          `INSERT INTO public.invoices(organization_id,building_id,contract_id,status,total_amount,previous_debt_sources)
           VALUES ('${org}','${toa}','${hopDong}','PAID',100000,
                   '[{"type":"invoice","id":"${hd}","amount":100000}]'::jsonb)`,
        );
        await db.query(`SELECT public.recompute_invoice_for_id('${hd}')`);
        expect(await trangThai()).toMatchObject({ status: 'PAID', paid_amount: '100000.00' });
      }));

    it.each([
      ['khác tổ chức', orgKhac, hopDong],
      ['khác hợp đồng', org, hopDongKhac],
    ])('create_invoice_v1 từ chối nguồn nợ cũ %s', (_ten, nguonOrg, nguonHopDong) =>
      canh(async () => {
        const nguon = '00000000-0000-4000-8000-0000000000aa';
        await db.exec(
          `INSERT INTO public.invoices(id,organization_id,building_id,contract_id,status,total_amount,paid_amount)
           VALUES ('${nguon}','${nguonOrg}','${nguonOrg === org ? toa : toaKhac}','${nguonHopDong}','APPROVED',50000,0)`,
        );
        await phaiNem(() =>
          taoQuaRpc({
            sources: `[{"type":"invoice","id":"${nguon}","amount":50000}]`,
            previousDebt: 50000,
          }),
        );
      }),
    );

    it('create_invoice_v1 từ chối nguồn nợ cũ vượt nợ còn lại lúc phát hành', () =>
      canh(async () => {
        const nguon = '00000000-0000-4000-8000-0000000000ab';
        await db.exec(
          `INSERT INTO public.invoices(id,organization_id,building_id,contract_id,status,total_amount,paid_amount)
           VALUES ('${nguon}','${org}','${toa}','${hopDong}','PARTIAL_PAID',50000,40000)`,
        );
        await phaiNem(() =>
          taoQuaRpc({
            sources: `[{"type":"invoice","id":"${nguon}","amount":50000}]`,
            previousDebt: 50000,
          }),
        );
        await taoQuaRpc({
          sources: `[{"type":"invoice","id":"${nguon}","amount":10000}]`,
          previousDebt: 10000,
          key: 'key-tao-0009',
        });
      }));
  });

  describe('H1.3 subtotal do SERVER cộng lại từ p_items', () => {
    it('create_invoice_v1 từ chối subtotal client không khớp tổng hạng mục', () =>
      canh(async () => {
        await phaiNem(() => taoQuaRpc({ subtotal: 1000 }));
      }));

    it('create_invoice_v1 từ chối subtotal > 0 mà không gửi hạng mục nào', () =>
      canh(async () => {
        await phaiNem(() => taoQuaRpc({ items: '[]' }));
      }));

    it('create_invoice_v1 nhận đúng bộ client đang gửi (amount = đơn giá × SL × hệ số)', () =>
      canh(async () => {
        await taoQuaRpc({});
        const r = await db.query<{ subtotal: string; total_amount: string }>(
          `SELECT subtotal, total_amount FROM public.invoices WHERE contract_id='${hopDong}'`,
        );
        expect(r.rows[0]).toMatchObject({ subtotal: '100000.00', total_amount: '100000.00' });
      }));

    it('update_invoice_v1 từ chối subtotal client không khớp tổng hạng mục', () =>
      canh(async () => {
        await taoHoaDon({ status: `'DRAFT'` });
        await phaiNem(() =>
          db.query(
            `SELECT public.update_invoice_v1('${hd}','${hopDong}','${toa}',NULL,'2026-09','2026-09-01','2026-09-10',
              1000, 0, 1000, 0, '[{"type":"RENT","unit_price":100000,"quantity":1,"coefficient":1,"amount":100000}]'::jsonb)`,
          ),
        );
      }));
  });

  describe('H1.5 PARTIAL_PAID phải tới được cả khi quá hạn', () => {
    it('đã thu một phần + quá hạn → PARTIAL_PAID (không phải OVERDUE)', () =>
      canh(async () => {
        await taoHoaDon();
        await db.exec(
          `INSERT INTO public.payments(invoice_id,amount,payment_date) VALUES ('${hd}',30000,'2026-09-05')`,
        );
        await db.query(`SELECT public.recompute_invoice_for_id('${hd}')`);
        expect(await trangThai()).toMatchObject({ status: 'PARTIAL_PAID', paid_amount: '30000.00' });
      }));

    it('chưa thu đồng nào + quá hạn → vẫn OVERDUE', () =>
      canh(async () => {
        await taoHoaDon();
        await db.query(`SELECT public.recompute_invoice_for_id('${hd}')`);
        expect((await trangThai()).status).toBe('OVERDUE');
      }));

    it('cột suy is_overdue vẫn báo quá hạn cho hoá đơn PARTIAL_PAID', () =>
      canh(async () => {
        await taoHoaDon({ status: `'PARTIAL_PAID'`, paid_amount: 30000 });
        const r = await db.query<{ is_overdue: boolean }>(
          `SELECT public.is_overdue(i) AS is_overdue FROM public.invoices i WHERE i.id='${hd}'`,
        );
        expect(r.rows[0].is_overdue).toBe(true);
      }));

    it('cột suy is_overdue tắt khi đã trả đủ hoặc đã huỷ', () =>
      canh(async () => {
        await taoHoaDon({ status: `'PAID'`, paid_amount: 100000 });
        const r = await db.query<{ is_overdue: boolean }>(
          `SELECT public.is_overdue(i) AS is_overdue FROM public.invoices i WHERE i.id='${hd}'`,
        );
        expect(r.rows[0].is_overdue).toBe(false);
      }));
  });

  describe('H1.7 các khoản P2', () => {
    it('nhánh xoá nợ lẻ <10.000đ chỉ còn áp cho hoá đơn TRƯỚC mốc V5', () =>
      canh(async () => {
        await taoHoaDon({ created_at: `'2026-07-01'` });
        await db.exec(
          `INSERT INTO public.payments(invoice_id,amount,payment_date) VALUES ('${hd}',95000,'2026-07-05')`,
        );
        await db.query(`SELECT public.recompute_invoice_for_id('${hd}')`);
        expect((await trangThai()).status).toBe('PAID');
      }));

    it('hoá đơn phát hành SAU mốc V5 không được xoá nợ lẻ âm thầm', () =>
      canh(async () => {
        await taoHoaDon({ created_at: `'2026-09-01'` });
        await db.exec(
          `INSERT INTO public.payments(invoice_id,amount,payment_date) VALUES ('${hd}',95000,'2026-09-05')`,
        );
        await db.query(`SELECT public.recompute_invoice_for_id('${hd}')`);
        expect((await trangThai()).status).toBe('PARTIAL_PAID');
      }));

    it('số hoá đơn lấy NĂM theo ngày của tổ chức, không theo NOW() giờ UTC', () =>
      canh(async () => {
        await db.exec("SELECT set_config('test.hom_nay','2027-01-01',true)");
        await db.exec(
          `INSERT INTO public.invoices(organization_id,building_id,contract_id,user_id,total_amount)
           VALUES ('${org}','${toa}','${hopDong}','${actor}',1000)`,
        );
        const r = await db.query<{ invoice_number: string }>(
          `SELECT invoice_number FROM public.invoices WHERE contract_id='${hopDong}' AND id<>'${hd}'`,
        );
        expect(r.rows[0].invoice_number).toMatch(/^INV-2027-\d{5}$/);
      }));

    it('tiền thối legacy vẫn bị trừ khỏi số đã thu (bộ dẫn xuất không đổi hành vi)', () =>
      canh(async () => {
        const loai = '00000000-0000-4000-8000-0000000000c1';
        const phieu = '00000000-0000-4000-8000-0000000000c2';
        await taoHoaDon();
        await db.exec(`
          INSERT INTO public.income_expense_types(id,name) VALUES ('${loai}','Tiền thối');
          INSERT INTO public.payments(invoice_id,amount,payment_date) VALUES ('${hd}',60000,'2026-09-05');
          INSERT INTO public.income_expenses(id,invoice_id,type) VALUES ('${phieu}','${hd}','EXPENSE');
          INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,amount)
            VALUES ('${phieu}','${loai}',10000);
        `);
        await db.query(`SELECT public.recompute_invoice_for_id('${hd}')`);
        expect(await trangThai()).toMatchObject({ paid_amount: '50000.00' });
      }));
  });

  describe('khẳng định trên thân hàm (hai RPC quá nặng để dựng fixture)', () => {
    it('H1.4 record_invoice_collection_v5 chặn ngày thu ở tương lai theo ngày của org', () => {
      const than = thanHamHienHanh('record_invoice_collection_v5');
      expect(than).toMatch(/p_collection_date\s*>\s*public\.org_today_v1\(v_org\)/);
      expect(than).toMatch(/Ngày thu không được ở tương lai/);
    });

    it('H1.6 LIFO của reverse_invoice_collection_v5 bỏ phần nợ kéo suy ra', () => {
      const than = thanHamHienHanh('reverse_invoice_collection_v5');
      expect(than).toContain('app_private.invoice_carried_debt_v1');
      expect(than).toMatch(/thứ tự LIFO/);
    });

    it('H1.7 thu hồi quyền authenticated của hai writer thu tiền đã ngừng dùng', () => {
      const khoi = sql.slice(
        sql.indexOf('DO $revoke_legacy_payment_writers$'),
        sql.indexOf('$revoke_legacy_payment_writers$;'),
      );
      expect(khoi).toContain('public.record_invoice_payment_v2(');
      expect(khoi).toContain('public.record_invoice_payment_v3(');
      expect(khoi).toContain('FROM PUBLIC, anon, authenticated, service_role');
    });
  });

  it('chạy migration lần hai không đổi kết quả (idempotent)', async () => {
    await db.exec(sql);
    await canh(async () => {
      await taoHoaDon({ status: `'PAID'`, paid_amount: 100000 });
      await phaiNem(() => db.query(`SELECT public.cancel_invoice_v1('${hd}')`));
    });
  }, 60000);
});

/** Gọi create_invoice_v1 bằng đúng bộ tham số client đang gửi. */
function taoQuaRpc(opts: {
  subtotal?: number;
  items?: string;
  sources?: string;
  previousDebt?: number;
  key?: string;
}) {
  const items =
    opts.items ??
    '[{"type":"RENT","description":"Tiền phòng","unit_price":100000,"quantity":1,"coefficient":1,"amount":100000,"sort_order":1}]';
  const subtotal = opts.subtotal ?? (opts.items === '[]' ? 100000 : 100000);
  const debt = opts.previousDebt ?? 0;
  return db.query(
    `SELECT public.create_invoice_v1(
       '${hopDong}','${toa}',NULL,'2026-09','2026-09-01','2026-09-10','MONTHLY',
       ${subtotal}, 0, app_private.round_invoice_total_v1(${subtotal} + ${debt}), ${debt},
       '${items}'::jsonb, '${opts.key ?? 'key-tao-0001'}', 0, NULL, false,
       '${opts.sources ?? '[]'}'::jsonb, NULL, NULL, 0, 'Tester')`,
  );
}
