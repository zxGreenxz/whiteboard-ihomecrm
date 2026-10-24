import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  confirmReceiptSchema, noteUpdateReceiptSchema,
  ihomeProfitOf, invoicePartsOfSettlement, landlordIhomeProfitSchema, landlordOperationOptionsSchema,
  landlordOperationsListSchema, settlementMonthSchema, settlementOverviewSchema, settlementPublicSchema,
  settlementVoucherName, shareLinksSchema, upsertReceiptSchema, type SettlementVoucher,
} from "@/lib/landlordSettlement";
import { getInvoiceTitle, invoiceTitlePartsOf } from "@/lib/invoiceUtils";
import { settlementRoomNoteRows } from "@/lib/settlementRoomNotes";
import type { InvoiceWithRelations } from "@/types/invoice";

/**
 * Migration 20261021083438 — quyết toán toà VẬN HÀNH CHO CHỦ NHÀ (chủ chốt 21/10/2026).
 * Chạy THẬT trên PostgreSQL nhúng: migration HAI lượt, rồi gọi RPC bằng vai
 * authenticated / anon như PostgREST. Kiểm công thức (ai giữ tiền, % quản lý, lỗ thì 0),
 * chặn quyền, chốt có CAS + phát hiện phiếu đổi sau chốt, thanh toán chống bấm trùng,
 * link công khai không lộ id/tên sổ, điều khoản theo tháng, đối chiếu KQKD, và gói RPC
 * thật parse được bằng đúng schema zod mà web dùng.
 *
 * Dữ liệu đặt ở 2025 (tháng đã qua) để phép "chỉ chốt tháng đã qua" không phụ thuộc ngày chạy.
 */
const FILE = "supabase/migrations/20261021083438_quyet_toan_van_hanh_chu_nha.sql";
const MIG_DIR = join(process.cwd(), "supabase", "migrations");
/**
 * Định nghĩa SỐNG của một hàm public: câu CREATE cuối cùng trong toàn bộ thư mục migration (theo thứ
 * tự tên file), bỏ qua dòng chú thích. Không ghim file cũ — hàm thật đổi thì test chạy theo bản mới.
 */
function liveDefinitionOf(fnName: string): string {
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fnName}\\s*\\(`, "gi");
  let hit: { sql: string; start: number } | null = null;
  for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIG_DIR, f), "utf8");
    for (const m of sql.matchAll(re)) {
      const lineStart = sql.lastIndexOf("\n", m.index) + 1;
      if (!sql.slice(lineStart, m.index).includes("--")) hit = { sql, start: m.index };
    }
  }
  if (!hit) throw new Error(`không tìm thấy định nghĩa public.${fnName}`);
  const rest = hit.sql.slice(hit.start);
  const open = /\bAS\s+(\$[A-Za-z_]*\$)/i.exec(rest);
  if (!open) throw new Error(`public.${fnName}: không thấy thân hàm`);
  const close = rest.indexOf(open[1], open.index + open[0].length);
  return rest.slice(0, rest.indexOf(";", close + open[1].length) + 1);
}
/** Các hàm sống mà quyết toán gọi tới: nguồn KQKD / Chốt LN, bỏ dấu tiếng Việt, khớp hạng mục phí. */
const LIVE_FNS = ["nrm_vn", "fee_type_matches", "fa_accrual_allocations"].map(liveDefinitionOf);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ORG_A, ORG_B, CHU_A, NHAN_VIEN_A, CHU_B, SUPER] = [1, 2, 3, 4, 5, 6].map(id);
const [TOA_A, TOA_B, TOA_AO, TOA_C] = [11, 12, 13, 14].map(id);
const [SO_CHU_NHA, SO_QUAN_LY, SO_AO, SO_CONG_TY_B, SO_CHU_NHA_C] = [21, 22, 23, 24, 25].map(id);
const [LOAI_THU, LOAI_DIEN, LOAI_TU_LANH] = [31, 32, 33].map(id);
const db = new PGlite();

type Json = Record<string, unknown>;

async function asUser(user: string | null) {
  await db.exec("RESET ROLE");
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [user ?? ""]);
  await db.exec(user ? "SET LOCAL ROLE authenticated" : "SET LOCAL ROLE anon");
}
async function asPostgres() {
  await db.exec("RESET ROLE");
}
async function trongGiaoDich<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try { return await fn(); } finally { await db.exec("ROLLBACK"); }
}
async function rpc<T = Json>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<{ r: T }>(`SELECT ${sql} AS r`, params);
  return r.rows[0].r;
}
const so = (v: unknown) => Number(v);
/** db.exec cho khối SQL dài: lỗi thì kèm đoạn quanh vị trí lỗi để biết câu nào hỏng. */
async function chay(sql: string) {
  try { await db.exec(sql); } catch (e) {
    const pos = Number((e as { position?: string }).position ?? 0);
    throw new Error(`${(e as Error).message} — gần: ${sql.slice(Math.max(0, pos - 160), pos + 40)}`);
  }
}
/** Câu mong lỗi chạy trong SAVEPOINT để transaction của ca test còn dùng tiếp được. */
async function expectLoi(sql: string, params: unknown[], code: string) {
  await db.exec("SAVEPOINT thu_loi");
  let err: unknown = null;
  try { await db.query(sql, params); } catch (e) { err = e; }
  await db.exec(err ? "ROLLBACK TO SAVEPOINT thu_loi" : "RELEASE SAVEPOINT thu_loi");
  expect(err).toMatchObject({ code });
}

let n = 100;
async function phieu(p: {
  toa?: string; loai: "INCOME" | "EXPENSE"; so: string | null; thang: string; trangThai?: string;
  kqkd?: boolean | null; xoa?: boolean; dong?: { lop: string; tien: number; tu?: string; den?: string }[]; tong?: number; nguon?: string;
  butToan?: string; lamTron?: { so: string; tien: number }; thoi?: { so: string; tien: number };
  ten?: string; hoaDon?: string; hanChe?: boolean; loaiHangMuc?: string; phong?: string;
}) {
  const pid = id(n++);
  await db.query(
    `INSERT INTO public.income_expenses(id, organization_id, building_id, code, name, type, voucher_date, account_id,
       approval_status, business_result_accounting, total_amount, deleted_at, system_source, posting_status,
       rounding_account_id, rounding_amount, change_account_id, change_amount, invoice_id, has_restricted_item, room_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [pid, ORG_A, p.toa ?? TOA_A, `P${n}`, p.ten ?? `Phiếu ${n}`, p.loai, p.thang, p.so, p.trangThai ?? "APPROVED",
      p.kqkd ?? null, p.tong ?? (p.dong ?? []).reduce((s, d) => s + d.tien, 0), p.xoa ? new Date().toISOString() : null,
      p.nguon ?? null, p.butToan ?? "POSTED", p.lamTron?.so ?? null, p.lamTron?.tien ?? 0,
      p.thoi?.so ?? null, p.thoi?.tien ?? 0, p.hoaDon ?? null, p.hanChe ?? false, p.phong ?? null],
  );
  for (const d of p.dong ?? []) {
    await db.query(
      "INSERT INTO public.income_expense_items(income_expense_id, amount, accounting_class, income_expense_type_id, start_date, end_date) VALUES ($1,$2,$3,$4,$5,$6)",
      [pid, d.tien, d.lop, p.loaiHangMuc ?? LOAI_THU, d.tu ?? null, d.den ?? null],
    );
  }
  return pid;
}

let PHIEU_LO_CHI = "";
let PHIEU_HAN_CHE_MA = "";

/**
 * Migration 20261023113626 — quản lý nhận TIỀN CỐ ĐỊNH (đ/tháng) và/hoặc % (chủ chốt 23/10/2026).
 * Đường dẫn đổi được qua env để kiểm đột biến trên bản sao (không sửa file thật).
 */
const FILE_CO_DINH = process.env.QTCD_MIGRATION_FILE
  ?? "supabase/migrations/20261023113626_quan_ly_nhan_tien_co_dinh.sql";
const UPSERT_CU = "public.landlord_operation_upsert_v1(uuid,text,numeric,date,uuid[],text,boolean,numeric,boolean,date,numeric,timestamptz)";
/** md5(pg_get_functiondef) thân đang chạy production, đọc chỉ đọc 23/10/2026 (không có CR). */
const PROD_MD5: Record<string, string> = {
  "app_private.landlord_settlement_compute_v1(uuid,date)": "4483be0be8948c7b97e0e2fb211c817c",
  "app_private.landlord_settlement_overview_payload_v1(uuid,boolean)": "1281400ce7f5a31776d517e2bd0d406a",
  "app_private.landlord_operation_state_v1(uuid)": "9452c2a2b43081989b25dd56bad3bce8",
  "public.landlord_operations_list_v1()": "f30a66cda55e61b50109b817940ebda1",
  "public.landlord_operation_options_v1(uuid)": "88eef03f7956f40f7a76e8c718f0311c",
  "public.landlord_ihome_profit_v1(date,date)": "c00e7d21798664b8439a4d2a46273aae",
  "app_private.landlord_strip_public_v1(jsonb)": "2e819cd3bc7d0201114207e689bd8b0b",
  [UPSERT_CU]: "8437e4e3d83990937ba3be94adb233d7",
};
const UPSERT_MOI = "public.landlord_operation_upsert_v1(uuid,text,numeric,date,uuid[],text,boolean,numeric,boolean,date,numeric,timestamptz,numeric)";
/** Hàm file thay thân (lượt hai phải nhận md5 của chính file). */
const HAM_THAY = Object.keys(PROD_MD5).filter((k) => k !== UPSERT_CU && k !== "public.landlord_ihome_profit_v1(date,date)");
/** Mọi hàm file ghim (gồm hai hàm chỉ đọc không thay). */
const HAM_GHIM = Object.keys(PROD_MD5).filter((k) => k !== UPSERT_CU);
let md5Goc: Record<string, string> = {};
let md5LuotMot: Record<string, string> = {};
let hashTruoc: string[] = [];
let hashSau: string[] = [];
async function md5Cua(sigs: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const s of sigs) {
    const r = await db.query<{ m: string }>("SELECT md5(pg_get_functiondef($1::regprocedure)) AS m", [s]);
    out[s] = r.rows[0].m;
  }
  return out;
}
/**
 * Migration 20261023142407 — v3: người giữ cọc theo toà, hạng mục thu/chi, ghi chú bàn giao sửa sau chốt, chủ nhà
 * xác nhận trên link (chủ chốt 23/10/2026). Đường dẫn đổi được qua env để kiểm đột biến trên bản sao.
 */
const FILE_V3 = process.env.QTV3_MIGRATION_FILE
  ?? "supabase/migrations/20261023142407_quyet_toan_v3_ban_giao_giu_coc.sql";
/** md5(pg_get_functiondef) production (= TEST), đọc chỉ đọc 23/10/2026 tối, sau khi áp 20261023113626. */
const PROD_MD5_V3: Record<string, string> = {
  "app_private.landlord_settlement_compute_v1(uuid,date)": "1af9d2b8c6d10ca32dc177cf0d6a6d2a",
  "app_private.landlord_strip_public_v1(jsonb)": "2377f91bcdab86e42a8371c0b6cb6ef2",
  "app_private.landlord_settlement_month_payload_v1(uuid,date,boolean)": "2f18d20bea0b4e607b7cbf43e3bbe9be",
  "app_private.landlord_settlement_overview_payload_v1(uuid,boolean)": "0884667fb4d68f576e158af7056f801a",
  "app_private.landlord_pre_start_deposits_v1(uuid)": "54eeb7489079dd992ee672da3cd4be41",
  "public.landlord_operation_options_v1(uuid)": "fb58fc832aed0dffb93997a5f81aa991",
  "app_private.landlord_operation_state_v1(uuid)": "fb8fecf22a102dc96e9d2937d4247b49",
  "app_private.landlord_opening_check_v1(uuid)": "b78e2d79a8d528179bf3bb65a30229bc",
  "app_private.landlord_kqkd_lines_v1(uuid,date,date)": "d7f64c98db3dd4598051377bb15b28d0",
  "app_private.landlord_close_blockers_v1(uuid,date,jsonb)": "852a5bda931276ac220153774abaa766",
  "public.landlord_settlement_close_v1(uuid,date,text,text)": "838f1727dfca7a29b84066e87528c08c",
  "public.landlord_settlement_reopen_v1(uuid,date,text)": "60439d3c966dc0be852cdd84ff621d77",
  "public.landlord_settlement_public_v1(text,date)": "1c3a19568446c14b0ab694e75e235c76",
  "public.landlord_ihome_profit_v1(date,date)": "c00e7d21798664b8439a4d2a46273aae",
};
const UPSERT_V3 = "public.landlord_operation_upsert_v1(uuid,text,numeric,date,uuid[],text,boolean,numeric,boolean,date,numeric,timestamptz,numeric,text)";
const KHONG_THAY_V3 = new Set([
  "app_private.landlord_operation_state_v1(uuid)", "app_private.landlord_opening_check_v1(uuid)",
  "app_private.landlord_kqkd_lines_v1(uuid,date,date)", "app_private.landlord_close_blockers_v1(uuid,date,jsonb)",
  "public.landlord_settlement_close_v1(uuid,date,text,text)", "public.landlord_settlement_reopen_v1(uuid,date,text)",
  "public.landlord_settlement_public_v1(text,date)", "public.landlord_ihome_profit_v1(date,date)",
]);
const HAM_GHIM_V3 = Object.keys(PROD_MD5_V3);
const HAM_THAY_V3 = HAM_GHIM_V3.filter((k) => !KHONG_THAY_V3.has(k));
let md5GocV3: Record<string, string> = {};
let md5LuotMotV3: Record<string, string> = {};
let hashSauV3: string[] = [];
/**
 * Migration 20261024035114 — gói tháng thêm dữ liệu phòng thô cho ghi chú "chưa đóng / trống" ở thẻ Khoản thu
 * (chủ nhắn 24/10/2026). Đường dẫn đổi được qua env để kiểm đột biến trên bản sao.
 */
const FILE_PHONG = process.env.QTPHONG_MIGRATION_FILE
  ?? "supabase/migrations/20261024035114_quyet_toan_du_lieu_phong_chua_dong.sql";
const GOI_THANG = "app_private.landlord_settlement_month_payload_v1(uuid,date,boolean)";
const DU_LIEU_PHONG = "app_private.landlord_room_data_v1(uuid,date,boolean)";
/** md5(pg_get_functiondef) production sau khi áp 20261023142407 (đọc chỉ đọc 24/10/2026). */
const PROD_MD5_PHONG: Record<string, string> = {
  [GOI_THANG]: "c172acff6a3488ae6d26c1b71d9f8693",
  "public.landlord_settlement_public_v1(text,date)": "1c3a19568446c14b0ab694e75e235c76",
  "public.landlord_settlement_month_v1(uuid,date)": "94ff223a4cf13641bb1427b17b6a8bed",
};
let md5GocPhong: Record<string, string> = {};
let md5LuotMotPhong: Record<string, string> = {};
let hashSauPhong: string[] = [];
/** source_hash của các tháng có dữ liệu (đọc thẳng công thức, vai postgres). */
async function hashCacThang(): Promise<string[]> {
  const r = await db.query<{ h: string }>(
    `SELECT app_private.landlord_settlement_compute_v1($1, m::date)->>'source_hash' AS h
       FROM unnest(ARRAY['2025-01-01','2025-02-01','2025-03-01']) AS m ORDER BY m`, [TOA_A]);
  return r.rows.map((x) => x.h);
}

beforeAll(async () => {
  await chay(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private; CREATE SCHEMA extensions;
    GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION extensions.gen_random_bytes(integer) RETURNS bytea LANGUAGE sql VOLATILE
      AS $$ SELECT substring(decode(md5(random()::text) || md5(random()::text), 'hex') from 1 for $1) $$;
    CREATE TABLE public.organizations(id uuid PRIMARY KEY, name text);
    CREATE TABLE public.memberships(user_id uuid, organization_id uuid, is_owner boolean);
    CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM public.super_admins WHERE user_id = auth.uid()) $$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT COALESCE(array_agg(organization_id), '{}') FROM public.memberships WHERE user_id = auth.uid() $$;
    CREATE FUNCTION app_private.ie_actor_is_company_owner_v1(p_org uuid, p_actor uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM public.memberships WHERE user_id = p_actor AND organization_id = p_org AND is_owner) $$;
    CREATE TABLE public.buildings(id uuid PRIMARY KEY, organization_id uuid, name text, name_sort text,
      is_virtual boolean DEFAULT false, deleted_at timestamptz);
    CREATE FUNCTION public.can_access_building(_building_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT public.is_super_admin() OR EXISTS (SELECT 1 FROM public.buildings b JOIN public.memberships m
             ON m.organization_id = b.organization_id WHERE b.id = _building_id AND m.user_id = auth.uid()) $$;
    CREATE TABLE public.accounts(id uuid PRIMARY KEY, organization_id uuid, name text, code text,
      is_virtual boolean DEFAULT false, deleted_at timestamptz);
    CREATE TABLE public.income_expenses(id uuid PRIMARY KEY, organization_id uuid, building_id uuid, code text, name text,
      notes text, type text, voucher_date date, account_id uuid, approval_status text, business_result_accounting boolean,
      total_amount numeric, deleted_at timestamptz, system_source text, posting_status text,
      change_account_id uuid, change_amount numeric DEFAULT 0, rounding_account_id uuid, rounding_amount numeric DEFAULT 0,
      invoice_id uuid, has_restricted_item boolean DEFAULT false, room_id uuid);
    CREATE TABLE public.income_expense_types(id uuid PRIMARY KEY, organization_id uuid, name text, category text,
      fee_category text, type text, is_restricted boolean NOT NULL DEFAULT false);
    CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), income_expense_id uuid,
      amount numeric, unit_price numeric, quantity numeric, accounting_class text, income_expense_type_id uuid,
      start_date date, end_date date);
    CREATE TABLE public.invoices(id uuid PRIMARY KEY, billing_month text, deleted_at timestamptz,
      kind text, issue_date date, notes text, contract_id uuid, room_id uuid);
    CREATE TABLE public.invoice_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid, type text, from_date date);
    CREATE TABLE public.contracts(id uuid PRIMARY KEY, start_billing_date date);
    CREATE TABLE public.rooms(id uuid PRIMARY KEY, name text);
    CREATE TABLE public.building_fee_accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), building_id uuid,
      fee_category text, not_applicable boolean DEFAULT false, deleted_at timestamptz);
    CREATE TABLE public.profiles(id uuid PRIMARY KEY, full_name text, email text);

    INSERT INTO public.organizations VALUES ('${ORG_A}','A'),('${ORG_B}','B');
    INSERT INTO public.memberships VALUES ('${CHU_A}','${ORG_A}',true),('${NHAN_VIEN_A}','${ORG_A}',false),('${CHU_B}','${ORG_B}',true);
    INSERT INTO public.super_admins VALUES ('${SUPER}');
    INSERT INTO public.profiles VALUES ('${CHU_A}','Chủ A',null);
    INSERT INTO public.buildings(id, organization_id, name, name_sort, is_virtual) VALUES
      ('${TOA_A}','${ORG_A}','44TA','toa a',false),('${TOA_B}','${ORG_B}','55TB','toa b',false),
      ('${TOA_AO}','${ORG_A}','Kho chung','kho chung',true),('${TOA_C}','${ORG_A}','Hẻm 66 Thành Công','toa c',false);
    INSERT INTO public.accounts(id, organization_id, name, code, is_virtual) VALUES
      ('${SO_CHU_NHA}','${ORG_A}','Sổ chủ nhà','TK1',false),('${SO_QUAN_LY}','${ORG_A}','Sổ quản lý','TK2',false),
      ('${SO_AO}','${ORG_A}','Cấn trừ thanh lý','TK3',true),('${SO_CONG_TY_B}','${ORG_B}','Sổ B','TK9',false),
      ('${SO_CHU_NHA_C}','${ORG_A}','Sổ chủ nhà C','TK5',false);
    INSERT INTO public.income_expense_types(id, organization_id, name, category, fee_category, type) VALUES
      ('${LOAI_THU}','${ORG_A}','Tiền phòng','Phòng',null,'income'),
      ('${LOAI_DIEN}','${ORG_A}','Đóng tiền điện','Điện','dien','expense'),
      ('${LOAI_TU_LANH}','${ORG_A}','Mua tủ lạnh','Điện',null,'expense');
    -- toà A đã khai điện (chưa có phiếu nào) và tiền nhà "không áp dụng"
    INSERT INTO public.building_fee_accounts(building_id, fee_category, not_applicable) VALUES
      ('${TOA_A}','dien',false),('${TOA_A}','tien_nha',true);
  `);
  // nrm_vn, fee_type_matches, fa_accrual_allocations: chạy đúng ĐỊNH NGHĨA SỐNG (CREATE cuối cùng trong
  // thư mục migration) để cảnh báo thiếu chi và khối đối chiếu KQKD đo trên hàm thật.
  for (const fn of LIVE_FNS) await chay(fn);

  // Tháng 01/2025 — đủ mọi loại dòng.
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-01-05", dong: [{ lop: "PNL", tien: 10_000_000 }] });
  await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-01-06", dong: [{ lop: "PNL", tien: 1_000_000 }] });
  PHIEU_HAN_CHE_MA = `P${n + 1}`; // phieu() tăng n trước khi đặt mã
  await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-01-07", hanChe: true, ten: "Lương nhân viên",
    dong: [{ lop: "PNL", tien: 2_000_000 }] });
  await phieu({ loai: "EXPENSE", so: SO_CHU_NHA, thang: "2025-01-08", dong: [{ lop: "PNL", tien: 500_000 }] });
  await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-01-09", dong: [{ lop: "DEPOSIT", tien: 3_000_000 }] });
  // thanh lý: cấn 400k cọc vào khoản khách phải trả (sổ ảo cấn trừ) ⇒ doanh thu bên quản lý
  await phieu({ loai: "EXPENSE", so: SO_AO, thang: "2025-01-10", nguon: "termination.offset", dong: [{ lop: "DEPOSIT", tien: 400_000 }] });
  await phieu({ loai: "INCOME", so: SO_AO, thang: "2025-01-10", nguon: "termination.revenue", dong: [{ lop: "PNL", tien: 400_000 }] });
  // thanh lý: trả thêm cho khách 150k ngoài cọc (PNL) + hoàn 850k cọc (DEPOSIT), một phiếu, sổ quản lý
  await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-01-10", nguon: "termination.refund",
    dong: [{ lop: "PNL", tien: 150_000 }, { lop: "DEPOSIT", tien: 850_000 }] });
  // khách chuyển cọc + trả thừa vào SỔ CHỦ NHÀ: chủ nhà giữ hộ tiền quản lý phải hoàn
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-01-19", dong: [{ lop: "DEPOSIT", tien: 800_000 }] });
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-01-19", dong: [{ lop: "CUSTOMER_CREDIT", tien: 5_000 }] });
  // dòng nội bộ: không tính, nhưng phải hiện ở nhóm "không tính"
  await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-01-20", dong: [{ lop: "INTERNAL", tien: 20_000 }] });
  await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-01-11", trangThai: "UNAPPROVED", dong: [{ lop: "PNL", tien: 700_000 }] });
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-01-11", trangThai: "UNAPPROVED", dong: [{ lop: "PNL", tien: 600_000 }] });
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-01-12", trangThai: "CANCELLED", dong: [{ lop: "PNL", tien: 9_999 }] });
  await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-01-13", kqkd: false, dong: [{ lop: "PNL", tien: 5_000 }] });
  await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-01-14", tong: 100_000 });
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-01-15", xoa: true, dong: [{ lop: "PNL", tien: 77 }] });
  await phieu({ toa: TOA_B, loai: "INCOME", so: SO_CONG_TY_B, thang: "2025-01-16", dong: [{ lop: "PNL", tien: 1_234 }] });
  await phieu({ loai: "INCOME", so: null, thang: "2025-01-17", dong: [{ lop: "PNL", tien: 50_000 }] });
  await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-01-18", kqkd: true, dong: [{ lop: "DEPOSIT", tien: 30_000 }] });
  // Tháng 02/2025 — lỗ.
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-02-03", dong: [{ lop: "PNL", tien: 1_000_000 }] });
  PHIEU_LO_CHI = await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-04", dong: [{ lop: "PNL", tien: 3_000_000 }] });
  // Tháng 03/2025 — phiếu đã duyệt nhưng bút toán bị đảo; tiền thối (tính) và làm tròn (KHÔNG tính) rơi vào sổ chủ nhà.
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-03-03", butToan: "REVERSED", dong: [{ lop: "PNL", tien: 100_000 }] });
  await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-03-04", lamTron: { so: SO_CHU_NHA, tien: 1_000 },
    thoi: { so: SO_CHU_NHA, tien: 2_000 }, dong: [{ lop: "PNL", tien: 50_000 }] });
  // Trước ngày áp dụng: khách chuyển cọc 700k vào sổ chủ nhà (gợi ý số dư đầu kỳ).
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2024-12-20", dong: [{ lop: "DEPOSIT", tien: 700_000 }] });

  const sql = readFileSync(FILE, "utf8");
  await chay(sql);
  await chay(sql);

  // Cấu hình toà A (ghi thẳng như dữ liệu có sẵn; đường RPC thêm/sửa có ca riêng). Số dư đầu kỳ đã xác nhận.
  await chay(`
    INSERT INTO app_private.landlord_operations
      (building_id, organization_id, landlord_name, effective_from, opening_confirmed_at, opening_confirmed_by,
       opening_confirmed_from, opening_confirmed_pre_start, created_by, updated_by)
    VALUES ('${TOA_A}','${ORG_A}','Chủ nhà A','2025-01-01',now(),'${CHU_A}','2025-01-01',700000,'${CHU_A}','${CHU_A}');
    INSERT INTO app_private.landlord_operation_terms (building_id, valid_from, manager_percent, landlord_account_ids, created_by)
    VALUES ('${TOA_A}','2025-01-01',30,ARRAY['${SO_CHU_NHA}']::uuid[],'${CHU_A}');
  `);

  // 20261023113626 (tiền quản lý cố định): áp SAU khi đã có cấu hình như production (dòng điều khoản cũ
  // nhận 0), trên đúng thân production (md5 phải tái lập), HAI lượt.
  md5Goc = await md5Cua([...HAM_GHIM, UPSERT_CU]);
  hashTruoc = await hashCacThang();
  const sqlCoDinh = readFileSync(FILE_CO_DINH, "utf8");
  await chay(sqlCoDinh);
  md5LuotMot = await md5Cua([...HAM_THAY, UPSERT_MOI]);
  await chay(sqlCoDinh);
  hashSau = await hashCacThang();

  // 20261023142407 (v3: người giữ cọc, hạng mục, bàn giao, xác nhận): áp sau 113626 như production, HAI lượt.
  md5GocV3 = await md5Cua([...HAM_GHIM_V3, UPSERT_MOI]);
  const sqlV3 = readFileSync(FILE_V3, "utf8");
  await chay(sqlV3);
  md5LuotMotV3 = await md5Cua([...HAM_THAY_V3, UPSERT_V3]);
  await chay(sqlV3);
  hashSauV3 = await hashCacThang();

  // 20261024035114 (dữ liệu phòng): bảng giả thêm đủ cột production mà hàm mới đọc, rồi áp HAI lượt.
  await chay(`
    ALTER TABLE public.rooms ADD COLUMN building_id uuid, ADD COLUMN status text, ADD COLUMN deleted_at timestamptz;
    ALTER TABLE public.contracts ADD COLUMN room_id uuid, ADD COLUMN status text, ADD COLUMN start_date date,
      ADD COLUMN end_date date, ADD COLUMN actual_end_date date, ADD COLUMN contract_number text,
      ADD COLUMN deleted_at timestamptz;
    ALTER TABLE public.invoices ADD COLUMN status text, ADD COLUMN total_amount numeric, ADD COLUMN paid_amount numeric,
      ADD COLUMN remaining_amount numeric, ADD COLUMN due_date date;
    -- như production: is_overdue là cột suy PostgREST (hàm nhận dòng hoá đơn), không phải cột
    CREATE FUNCTION public.is_overdue(public.invoices) RETURNS boolean LANGUAGE sql STABLE
      AS $$ SELECT $1.due_date IS NOT NULL AND $1.deleted_at IS NULL AND $1.status NOT IN ('PAID', 'CANCELLED')
              AND COALESCE($1.paid_amount, 0) < COALESCE($1.total_amount, 0) AND $1.due_date < current_date $$;
    CREATE TABLE public.contract_terminations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid,
      termination_type text, termination_date date, actual_move_out_date date, status text);
    CREATE TABLE public.contract_transfers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), old_room_id uuid,
      transfer_type text, transfer_date date, status text);
  `);
  md5GocPhong = await md5Cua(Object.keys(PROD_MD5_PHONG));
  const sqlPhong = readFileSync(FILE_PHONG, "utf8");
  await chay(sqlPhong);
  md5LuotMotPhong = await md5Cua([GOI_THANG, DU_LIEU_PHONG]);
  await chay(sqlPhong);
  hashSauPhong = await hashCacThang();
}, 60000);
afterAll(() => db.close());

describe("công thức quyết toán tháng", () => {
  it("tách đúng ai giữ tiền, % quản lý, phần chủ nhà và số chủ nhà phải trả", async () => {
    const thang = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      return rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2025-01-01"]);
    });
    const st = thang.statement as Json;
    const t = st.totals as Json;
    expect(thang.status).toBe("OPEN");
    expect(so(t.landlord_collected)).toBe(10_000_000);
    // quản lý thu = sổ quản lý 1tr + cấn cọc (sổ ảo) 400k + phiếu không dòng 100k + phiếu không sổ 50k
    expect(so(t.manager_collected)).toBe(1_550_000);
    expect(so(t.landlord_paid)).toBe(500_000);
    // quản lý chi = 2tr + DEPOSIT bị ép tính KQKD 30k + trả thêm cho khách ngoài cọc khi thanh lý 150k
    expect(so(t.manager_paid)).toBe(2_180_000);
    expect(so(t.revenue)).toBe(11_550_000);
    expect(so(t.expense)).toBe(2_680_000);
    expect(so(t.profit)).toBe(8_870_000);
    expect(so(t.manager_share)).toBe(2_661_000);
    expect(so(t.landlord_share)).toBe(6_209_000);
    // cọc 800k + trả thừa 5k khách chuyển vào sổ chủ nhà
    expect(so(t.landlord_held_deposits)).toBe(805_000);
    expect(so(t.landlord_owes_manager)).toBe(4_096_000);
    // bảo toàn: chủ nhà đang giữ (thu − chi + cọc giữ hộ) − phần chủ nhà được hưởng = số chủ nhà phải trả
    expect(so(t.landlord_collected) - so(t.landlord_paid) + so(t.landlord_held_deposits) - so(t.landlord_share))
      .toBe(so(t.landlord_owes_manager));
    // v3 (20261023142407) thêm phần cọc ở sổ quản lý: 3tr thu; hoàn 850k + cấn 400k (sổ ảo cấn trừ)
    expect(st.deposits).toEqual({
      received: 3_805_000, paid_out: 1_250_000, landlord_received: 805_000, landlord_paid_out: 0,
      manager_received: 3_000_000, manager_paid_out: 1_250_000,
    });
    expect(st.termination).toEqual({
      revenue_from_deposit: 400_000, forfeit_revenue: 0, extra_receipt: 0, refund_beyond_deposit: 150_000,
      deposit_refunded: 850_000, deposit_offset: 400_000, pending_refund: 0,
    });
    expect(st.pending).toMatchObject({ voucher_count: 2, income: 600_000, expense: 700_000 });
    // không khoản nào biến mất: dòng tắt KQKD (5k) và dòng nội bộ (20k) vẫn hiện ở nhóm "không tính"
    expect(st.excluded).toEqual({ voucher_count: 2, income: 25_000, expense: 0 });
    const ex = (st.vouchers as Json[]).filter((v) => v.group === "EXCLUDED").map((v) => v.excluded_reason).sort();
    expect(ex).toEqual(["INTERNAL", "NOT_KQKD"]);
    const nguon = (st.vouchers as Json[]).map((v) => v.source).filter(Boolean).sort();
    expect(nguon).toEqual(["DEPOSIT_OFFSET", "TERMINATION_REFUND", "TERMINATION_REFUND", "TERMINATION_REVENUE"]);
    expect(thang.can_close).toBe(false);
    expect(thang.close_blockers).toEqual(["PENDING_VOUCHERS"]);
    expect(st.terms_from).toBe("2025-01-01");
    expect(st.foreign_account_voucher_count).toBe(0);
  });

  it("tháng lỗ: phần quản lý 0đ, chủ nhà vẫn hoàn khoản quản lý chi hộ", async () => {
    const t = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const m = await rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2025-02-01"]);
      return (m.statement as Json).totals as Json;
    });
    expect(so(t.profit)).toBe(-2_000_000);
    expect(so(t.manager_share)).toBe(0);
    expect(so(t.landlord_share)).toBe(-2_000_000);
    expect(so(t.landlord_owes_manager)).toBe(3_000_000);
  });

  it("tháng trước ngày áp dụng là NOT_APPLICABLE", async () => {
    const m = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      return rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2024-12-01"]);
    });
    expect(m.status).toBe("NOT_APPLICABLE");
    expect(m.statement).toBeNull();
  });

  it("phiếu duyệt mà bút toán đã đảo: vẫn tính KQKD nhưng chặn chốt; tiền thối vào sổ chủ nhà được bù trừ, làm tròn thì không", async () => {
    const m = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      return rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2025-03-01"]);
    });
    const st = m.statement as Json;
    const t = st.totals as Json;
    expect(st.reversed_voucher_count).toBe(1);
    expect(m.can_close).toBe(false);
    expect(m.close_blockers).toEqual(["REVERSED_POSTINGS"]);
    expect(so(t.profit)).toBe(150_000);
    expect(so(t.manager_share)).toBe(45_000);
    // chỉ tiền thối 2k; làm tròn 1k là khoản khách trả thiếu được bỏ qua, không phải tiền mặt
    expect(so(t.landlord_extra_cash)).toBe(2_000);
    // 45k + 0 − 50k + 0 + 2k
    expect(so(t.landlord_owes_manager)).toBe(-3_000);
    expect((st.vouchers as Json[]).filter((v) => v.cash_reversed).length).toBe(1);
  });
});

describe("quyền", () => {
  it.each([
    ["nhân viên cùng công ty", NHAN_VIEN_A],
    ["chủ công ty khác", CHU_B],
  ])("%s không xem được (42501)", async (_ten, user) => {
    await trongGiaoDich(async () => {
      await asUser(user);
      await expectLoi("SELECT public.landlord_settlement_month_v1($1, '2025-01-01'::date)", [TOA_A], "42501");
    });
  });

  it("super admin xem được", async () => {
    const m = await trongGiaoDich(async () => {
      await asUser(SUPER);
      return rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2025-01-01"]);
    });
    expect(m.status).toBe("OPEN");
  });

  it("anon không gọi được RPC quản trị", async () => {
    await trongGiaoDich(async () => {
      await asUser(null);
      await expectLoi("SELECT public.landlord_settlement_month_v1($1, '2025-01-01'::date)", [TOA_A], "42501");
    });
  });

  it("danh sách toà: nhân viên không quản được, chủ công ty A thấy toà A", async () => {
    const [nv, chu] = await trongGiaoDich(async () => {
      await asUser(NHAN_VIEN_A);
      const a = await rpc<Json>("public.landlord_operations_list_v1()");
      await asUser(CHU_A);
      const b = await rpc<Json>("public.landlord_operations_list_v1()");
      return [a, b];
    });
    expect(nv.can_manage).toBe(false);
    expect(nv.operations).toEqual([]);
    expect(chu.can_manage).toBe(true);
    expect((chu.operations as Json[]).map((o) => o.building_id)).toEqual([TOA_A]);
    expect(so((chu.operations as Json[])[0].manager_percent)).toBe(30);
    // toà ảo không phải ứng viên
    expect((chu.candidate_buildings as Json[]).map((o) => o.building_id)).toEqual([TOA_A, TOA_C]);
  });
});

describe("cài đặt toà", () => {
  it.each([
    ["tỷ lệ > 100", 120, [SO_CHU_NHA]],
    ["sổ của công ty khác", 30, [SO_CONG_TY_B]],
    ["không chọn sổ nào", 30, []],
    ["sổ ảo (cấn trừ / làm tròn / tiền thối)", 30, [SO_AO]],
  ])("%s ⇒ 22023", async (_ten, pct, accounts) => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await expectLoi("SELECT public.landlord_operation_upsert_v1($1, 'Chủ nhà A', $2, '2025-01-01'::date, $3::uuid[], null, true)",
        [TOA_A, pct, accounts], "22023");
    });
  });

  it("sửa cấu hình ghi sổ thay đổi và chuẩn hoá tháng áp dụng về ngày 1", async () => {
    const [kq, opts] = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const a = await rpc<Json>(
        "public.landlord_operation_upsert_v1($1, 'Chủ nhà A', 25, '2025-01-15'::date, $2::uuid[], 'thoả thuận mới', true)",
        [TOA_A, [SO_CHU_NHA]],
      );
      const b = await rpc<Json>("public.landlord_operation_options_v1($1)", [TOA_A]);
      return [a, b];
    });
    expect(kq).toEqual({ building_id: TOA_A, created: false, terms_from: "2025-01-01", opening_needs_reconfirm: false,
      opening_needs_confirm: true });
    expect((opts.current as Json).effective_from).toBe("2025-01-01");
    expect(so((opts.current as Json).manager_percent)).toBe(25);
    expect((opts.history as Json[]).length).toBe(1);
  });

  it("lưu lại y nguyên không sinh lịch sử; số dư đầu kỳ vào tổng quyết toán; gợi ý cọc ở sổ chủ nhà trước ngày áp dụng", async () => {
    const [h1, h2, opts, ov] = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const sql = "public.landlord_operation_upsert_v1($1, 'Chủ nhà A', 30, '2025-01-01'::date, $2::uuid[], null, true, 300000)";
      await rpc(sql, [TOA_A, [SO_CHU_NHA]]);
      const a = ((await rpc<Json>("public.landlord_operation_options_v1($1)", [TOA_A])).history as Json[]).length;
      await rpc(sql, [TOA_A, [SO_CHU_NHA]]);
      const o = await rpc<Json>("public.landlord_operation_options_v1($1)", [TOA_A]);
      const b = (o.history as Json[]).length;
      const v = await rpc<Json>("public.landlord_settlement_overview_v1($1)", [TOA_A]);
      return [a, b, o, v];
    });
    expect(h1).toBe(1);
    expect(h2).toBe(1);
    expect(so((opts.current as Json).opening_balance)).toBe(300_000);
    expect(so((opts.current as Json).pre_start_landlord_deposits)).toBe(700_000);
    const t = ov.totals as Json;
    expect(so(t.opening_balance)).toBe(300_000);
    expect(so(t.balance_closed)).toBe(300_000);
  });

  it("số dư đầu kỳ lẻ đồng ⇒ 22023", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await expectLoi("SELECT public.landlord_operation_upsert_v1($1, 'Chủ nhà A', 30, '2025-01-01'::date, $2::uuid[], null, true, 10.5)",
        [TOA_A, [SO_CHU_NHA]], "22023");
    });
  });
});

describe("chốt tháng", () => {
  it("không chốt được khi còn phiếu chờ duyệt hoặc tháng chưa hết", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const m = await rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2025-01-01"]);
      await expectLoi("SELECT public.landlord_settlement_close_v1($1, '2025-01-01'::date, $2, null)", [TOA_A, m.live_hash], "55000");
    });
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await expectLoi("SELECT public.landlord_settlement_close_v1($1, date_trunc('month', now())::date, 'x', null)", [TOA_A], "55000");
    });
  });

  it("chốt có CAS, chụp số, báo phiếu đổi sau chốt, mở chốt có lý do rồi chốt lại", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const m = await rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2025-02-01"]);
      expect(m.can_close).toBe(true);
      const h1 = String(m.live_hash);
      expect(await rpc<Json>("public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, h1]))
        .toEqual({ status: "CLOSED", revision: 1 });
      expect(await rpc<Json>("public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, h1]))
        .toEqual({ status: "ALREADY_CLOSED", revision: 1 });

      // phiếu của tháng đã chốt bị sửa
      await asPostgres();
      await db.query("UPDATE public.income_expense_items SET amount = 2500000 WHERE income_expense_id = $1", [PHIEU_LO_CHI]);
      await asUser(CHU_A);
      const sauSua = await rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2025-02-01"]);
      expect(sauSua.status).toBe("CLOSED");
      expect(sauSua.is_stale).toBe(true);
      // vẫn hiện số LÚC CHỐT
      expect(so(((sauSua.statement as Json).totals as Json).landlord_owes_manager)).toBe(3_000_000);
      await expectLoi("SELECT public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, sauSua.live_hash], "55000");

      await expectLoi("SELECT public.landlord_settlement_reopen_v1($1, '2025-02-01'::date, 'ngắn')", [TOA_A], "22023");
      expect(await rpc<Json>("public.landlord_settlement_reopen_v1($1, '2025-02-01'::date, 'sửa phiếu chi tháng 2')", [TOA_A]))
        .toEqual({ status: "REOPENED", revision: 2 });
      await expectLoi("SELECT public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, h1], "40001");
      expect(await rpc<Json>("public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, 'chốt lại')", [TOA_A, sauSua.live_hash]))
        .toEqual({ status: "CLOSED", revision: 3 });
      const daChot = await rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2025-02-01"]);
      expect(daChot.is_stale).toBe(false);
      expect(so(((daChot.statement as Json).totals as Json).landlord_owes_manager)).toBe(2_500_000);
      expect((daChot.closed as Json).closed_by_name).toBe("Chủ A");
    });
  });
});

describe("thanh toán và số còn lại", () => {
  it("ghi, chống bấm trùng, huỷ có lý do; còn lại = tháng đã chốt − đã trả", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const m = await rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [TOA_A, "2025-02-01"]);
      await rpc("public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, m.live_hash]);

      const p1 = await rpc<Json>(
        "public.landlord_settlement_add_payment_v1($1, '2025-03-05'::date, 'LANDLORD_TO_MANAGER', 1000000, 'chuyển khoản', 'khoa-thu-0001')", [TOA_A]);
      expect(p1.status).toBe("CREATED");
      expect(await rpc<Json>(
        "public.landlord_settlement_add_payment_v1($1, '2025-03-05'::date, 'LANDLORD_TO_MANAGER', 1000000, 'chuyển khoản', 'khoa-thu-0001')", [TOA_A]))
        .toEqual({ id: p1.id, status: "REPLAYED" });
      await expectLoi("SELECT public.landlord_settlement_add_payment_v1($1, '2025-03-05'::date, 'LANDLORD_TO_MANAGER', 2000000, 'chuyển khoản', 'khoa-thu-0001')", [TOA_A], "23505");
      await expectLoi("SELECT public.landlord_settlement_add_payment_v1($1, '2025-03-05'::date, 'LANDLORD_TO_MANAGER', 1000.5, null, 'khoa-thu-0002')", [TOA_A], "22023");
      const p2 = await rpc<Json>(
        "public.landlord_settlement_add_payment_v1($1, '2025-03-06'::date, 'MANAGER_TO_LANDLORD', 200000, null, 'khoa-thu-0003')", [TOA_A]);

      const ov = await rpc<Json>("public.landlord_settlement_overview_v1($1)", [TOA_A]);
      const t = ov.totals as Json;
      expect(so(t.closed_net)).toBe(3_000_000);
      expect(so(t.paid_by_landlord)).toBe(1_000_000);
      expect(so(t.paid_by_manager)).toBe(200_000);
      expect(so(t.balance_closed)).toBe(2_200_000);
      // tháng 01 (4.096.000) và 03 (−3.000) còn mở: cộng vào số "gồm cả tạm tính"
      expect(so(t.balance_with_open)).toBe(2_200_000 + 4_096_000 - 3_000);
      expect(t.closed_month_count).toBe(1);

      expect(await rpc<Json>("public.landlord_settlement_void_payment_v1($1, 'ghi nhầm chiều tiền')", [p2.id]))
        .toEqual({ id: p2.id, status: "VOIDED" });
      const sauHuy = await rpc<Json>("public.landlord_settlement_overview_v1($1)", [TOA_A]);
      expect(so((sauHuy.totals as Json).balance_closed)).toBe(2_000_000);
      expect((sauHuy.payments as Json[]).find((p) => p.id === p2.id)?.voided).toBe(true);
    });
  });
});

describe("link công khai cho chủ nhà", () => {
  it("anon đọc được qua token, không lộ id; token thu hồi/sai trả NULL", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const { token } = await rpc<{ token: string }>("public.landlord_share_link_create_v1($1, 'Zalo')", [TOA_A]);
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);

      await asUser(null);
      const pub = await rpc<Json>("public.landlord_settlement_public_v1($1, '2025-01-01'::date)", [token]);
      const month = pub.month as Json;
      const st = month.statement as Json;
      expect(so((st.totals as Json).landlord_owes_manager)).toBe(4_096_000);
      expect((st.vouchers as Json[]).length).toBeGreaterThan(0);
      expect((st.vouchers as Json[]).every((v) => !("id" in v))).toBe(true);
      // không lộ tên sổ của nhân viên: chỉ nói tiền ở bên nào
      expect(new Set((st.vouchers as Json[]).map((v) => v.account_name)))
        .toEqual(new Set(["Sổ chủ nhà", "Sổ quản lý", "Cấn trừ cọc (nội bộ)"]));
      expect((st.vouchers as Json[]).find((v) => v.code === PHIEU_HAN_CHE_MA)?.name).toBe("Khoản hạn chế (ẩn chi tiết)");
      expect(month.warnings).toBeNull();
      expect(month.kqkd_bridge).toBeNull();
      expect(month.close_blockers).toEqual([]);
      expect("building_id" in st).toBe(false);
      expect(month.live_hash).toBeNull();
      expect(month.can_close).toBe(false);
      expect(((pub.overview as Json).payments as Json[]).every((p) => !("id" in p))).toBe(true);
      expect(await rpc("public.landlord_settlement_public_v1('khong-phai-token', null)")).toBeNull();

      await asUser(CHU_A);
      expect(await rpc<Json>("public.landlord_share_link_revoke_v1($1)", [token])).toEqual({ status: "REVOKED" });
      await asUser(null);
      expect(await rpc("public.landlord_settlement_public_v1($1, null)", [token])).toBeNull();
    });
  });

  it("toà ngừng áp dụng thì link trả NULL", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const { token } = await rpc<{ token: string }>("public.landlord_share_link_create_v1($1, null)", [TOA_A]);
      await rpc("public.landlord_operation_upsert_v1($1, 'Chủ nhà A', 30, '2025-01-01'::date, $2::uuid[], null, false)", [TOA_A, [SO_CHU_NHA]]);
      await asUser(null);
      expect(await rpc("public.landlord_settlement_public_v1($1, null)", [token])).toBeNull();
    });
  });

  it("huỷ thanh toán / thu hồi link: người ngoài không phân biệt được id/token có tồn tại hay không", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const p = await rpc<Json>(
        "public.landlord_settlement_add_payment_v1($1, '2025-03-05'::date, 'LANDLORD_TO_MANAGER', 1000, null, 'khoa-do-0001')", [TOA_A]);
      const { token } = await rpc<{ token: string }>("public.landlord_share_link_create_v1($1, null)", [TOA_A]);
      await asUser(CHU_B);
      await expectLoi("SELECT public.landlord_settlement_void_payment_v1($1, 'thử huỷ của người khác')", [p.id], "42501");
      await expectLoi("SELECT public.landlord_settlement_void_payment_v1($1, 'thử huỷ của người khác')", [id(999)], "42501");
      await expectLoi("SELECT public.landlord_share_link_revoke_v1($1)", [token], "42501");
      await expectLoi("SELECT public.landlord_share_link_revoke_v1($1)", ["khong-co-token-nay-0123456789abcdef"], "42501");
    });
  });
});

const thang = (toa: string, m: string) => rpc<Json>("public.landlord_settlement_month_v1($1, $2::date)", [toa, m]);
const UPSERT_A = "public.landlord_operation_upsert_v1($1, 'Chủ nhà A', $2, $3::date, $4::uuid[], null, true, $5, $6, $7::date, $8)";
/** Cài toà A qua RPC: % · tháng áp dụng · số dư đầu kỳ · đã xác nhận · áp % từ tháng. */
const caiToaA = (pct: number, tu: string, soDu = 0, xacNhan = true, apTu: string | null = null, daThay: number | null = 700_000) =>
  rpc<Json>(UPSERT_A, [TOA_A, pct, tu, [SO_CHU_NHA], soDu, xacNhan, apTu, daThay]);
async function chot(m: string) {
  const x = await thang(TOA_A, m);
  return rpc<Json>("public.landlord_settlement_close_v1($1, $2::date, $3, null)", [TOA_A, m, x.live_hash]);
}

describe("điều khoản theo tháng, tháng áp dụng, số dư đầu kỳ", () => {
  it("đổi % sau khi chốt: tháng đã chốt giữ % cũ, % mới áp từ tháng sau tháng chốt; không đổi được từ tháng đã chốt", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      expect((await chot("2025-02-01")).status).toBe("CLOSED");
      const kq = await caiToaA(40, "2025-01-01");
      expect(upsertReceiptSchema.parse(kq).terms_from).toBe("2025-03-01");

      const feb = await thang(TOA_A, "2025-02-01");
      expect(feb.is_stale).toBe(false);
      expect(so((feb.statement as Json).manager_percent)).toBe(30);
      const jan = await thang(TOA_A, "2025-01-01");
      expect(so((jan.statement as Json).manager_percent)).toBe(30);
      const mar = (await thang(TOA_A, "2025-03-01")).statement as Json;
      expect(so(mar.manager_percent)).toBe(40);
      expect(mar.terms_from).toBe("2025-03-01");
      expect(so((mar.totals as Json).manager_share)).toBe(60_000); // 150k × 40%

      await expectLoi(`SELECT ${UPSERT_A}`, [TOA_A, 50, "2025-01-01", [SO_CHU_NHA], 0, true, "2025-02-01", 700_000], "55000");
      await expectLoi(`SELECT ${UPSERT_A}`, [TOA_A, 50, "2025-01-01", [SO_CHU_NHA], 0, true, "2025-01-01", 700_000], "55000");
      // từ một tháng chưa chốt về sau thì được; trùng điều khoản ngay trước thì gộp
      expect((await caiToaA(30, "2025-01-01", 0, true, "2025-04-01")).terms_from).toBe("2025-04-01");

      const ov = settlementOverviewSchema.parse(await rpc("public.landlord_settlement_overview_v1($1)", [TOA_A]));
      expect(ov.months.slice(0, 4).map((x) => x.manager_percent)).toEqual([30, 30, 40, 30]);
      expect(ov.manager_percent).toBe(30);
      const opts = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(opts.current?.terms.map((x) => [x.valid_from, x.manager_percent]))
        .toEqual([["2025-01-01", 30], ["2025-03-01", 40], ["2025-04-01", 30]]);
      expect(opts.current?.last_closed_month).toBe("2025-02-01");
      expect(opts.current?.next_terms_month).toBe("2025-03-01");
      // lịch sử ghi đủ điều khoản trước/sau
      const h = opts.history[0];
      expect(Array.isArray(h.after.terms)).toBe(true);
    });
  });

  it("dời tháng bắt đầu ra sau tháng đã chốt bị chặn; dời về trước thì mở thêm tháng và điều khoản đầu tiên theo về", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await chot("2025-02-01");
      await expectLoi(`SELECT ${UPSERT_A}`, [TOA_A, 30, "2025-03-01", [SO_CHU_NHA], 0, true, null, 700_000], "55000");
      // 01 → 02: tháng 02 đã chốt vẫn trong thời gian áp dụng
      await caiToaA(30, "2025-02-01");
      expect((await thang(TOA_A, "2025-01-01")).status).toBe("NOT_APPLICABLE");
      const feb = await thang(TOA_A, "2025-02-01");
      expect([feb.status, feb.is_stale]).toEqual(["CLOSED", false]);
      // về 12/2024: tháng 12 mở ra; cọc 700k khách chuyển vào sổ chủ nhà nay nằm TRONG kỳ
      await caiToaA(30, "2024-12-01");
      const dec = await thang(TOA_A, "2024-12-01");
      expect(dec.status).toBe("OPEN");
      expect(so(((dec.statement as Json).totals as Json).landlord_held_deposits)).toBe(700_000);
      const opts = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(opts.current?.terms.map((x) => x.valid_from)).toEqual(["2024-12-01"]);
      expect(opts.current?.pre_start_landlord_deposits).toBe(0);
      expect((await thang(TOA_A, "2025-02-01")).is_stale).toBe(false);
    });
  });

  it("số dư đầu kỳ chưa xác nhận chặn chốt; xác nhận rồi mới chốt; đổi số thì phải xác nhận lại", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await caiToaA(30, "2025-01-01", 300_000, false);
      const feb = await thang(TOA_A, "2025-02-01");
      expect(feb.close_blockers).toEqual(["OPENING_UNCONFIRMED"]);
      expect(feb.can_close).toBe(false);
      await expectLoi("SELECT public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, feb.live_hash], "55000");

      await caiToaA(30, "2025-01-01", 300_000, true);
      const daXacNhan = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(daXacNhan.current?.opening_confirmed_at).not.toBeNull();
      expect((await thang(TOA_A, "2025-02-01")).can_close).toBe(true);
      expect((await chot("2025-02-01")).status).toBe("CLOSED");

      // lưu lại cùng số, vẫn tick: giữ nguyên dấu xác nhận cũ
      await caiToaA(30, "2025-01-01", 300_000, true);
      const giuNguyen = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(giuNguyen.current?.opening_confirmed_at).toBe(daXacNhan.current?.opening_confirmed_at);

      // đổi số mà vẫn tick: là một lần xác nhận MỚI (dấu thời gian mới), không mượn dấu cũ
      await caiToaA(30, "2025-01-01", 350_000, true);
      const xacNhanLai = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(xacNhanLai.current?.opening_confirmed_at).not.toBeNull();
      expect(xacNhanLai.current?.opening_confirmed_at).not.toBe(daXacNhan.current?.opening_confirmed_at);

      await caiToaA(30, "2025-01-01", 400_000, false);
      const ov = settlementOverviewSchema.parse(await rpc("public.landlord_settlement_overview_v1($1)", [TOA_A]));
      expect(ov.opening_confirmed).toBe(false);
      expect(ov.totals.opening_balance).toBe(400_000);
    });
  });

  it("phiếu chờ duyệt ghi ngày trước tháng áp dụng chặn chốt tháng đầu tiên (chỉ tháng đầu)", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2024-12-15", trangThai: "UNAPPROVED", dong: [{ lop: "PNL", tien: 90_000 }] });
      await asUser(CHU_A);
      const jan = settlementMonthSchema.parse(await thang(TOA_A, "2025-01-01"));
      expect(jan.close_blockers).toContain("PRE_START_PENDING");
      expect(jan.warnings?.pre_start_pending).toMatchObject({ voucher_count: 1, income: 0, expense: 90_000 });
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb.close_blockers).toEqual([]);
      expect(feb.warnings?.pre_start_pending).toBeNull();
    });
  });
});

describe("cảnh báo và đối chiếu", () => {
  it("phiếu dùng sổ chủ nhà của toà vận hành khác: đánh dấu, chặn chốt", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await rpc("public.landlord_operation_upsert_v1($1, 'Chủ nhà C', 20, '2025-06-01'::date, $2::uuid[], null, true)",
        [TOA_C, [SO_CHU_NHA_C]]);
      await asPostgres();
      await phieu({ loai: "EXPENSE", so: SO_CHU_NHA_C, thang: "2025-02-10", dong: [{ lop: "PNL", tien: 100_000 }] });
      await asUser(CHU_A);
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb.statement?.foreign_account_voucher_count).toBe(1);
      expect(feb.statement?.vouchers.filter((v) => v.foreign_landlord_account).map((v) => v.amount)).toEqual([100_000]);
      expect(feb.close_blockers).toEqual(["FOREIGN_LANDLORD_ACCOUNT"]);
      await expectLoi("SELECT public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, feb.live_hash], "55000");
    });
  });

  it("khoản chi cố định chưa có phiếu; phiếu ở toà khác có nhắc mã toà", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      // toà A khai điện (chưa có phiếu), tiền nhà "không áp dụng"; nước chưa khai vẫn phải có
      expect((await thang(TOA_A, "2025-01-01") as { warnings: Json }).warnings.missing_fixed_expenses).toEqual(["dien", "nuoc"]);
      await asPostgres();
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-01-21", trangThai: "UNAPPROVED", loaiHangMuc: LOAI_TU_LANH,
        ten: "Mua tủ lạnh", dong: [{ lop: "PNL", tien: 3_900_000 }] });
      await asUser(CHU_A);
      expect((await thang(TOA_A, "2025-01-01") as { warnings: Json }).warnings.missing_fixed_expenses).toEqual(["dien", "nuoc"]);
      await asPostgres();
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-05", loaiHangMuc: LOAI_DIEN, dong: [{ lop: "PNL", tien: 400_000 }] });
      await phieu({ toa: TOA_AO, loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-06", ten: "in decal 44 TA cho khách",
        dong: [{ lop: "PNL", tien: 50_000 }] });
      await phieu({ toa: TOA_AO, loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-07", ten: "đồ cho nhà 144TA",
        dong: [{ lop: "PNL", tien: 60_000 }] });
      // bàn giao tiền mặt (tắt KQKD) nhắc tên toà: không làm sai lợi nhuận ⇒ không báo
      await phieu({ toa: TOA_AO, loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-08", kqkd: false, ten: "Bàn giao tiền 44TA",
        dong: [{ lop: "PNL", tien: 70_000 }] });
      await asUser(CHU_A);
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb.warnings?.missing_fixed_expenses).toEqual(["nuoc"]);
      expect(feb.warnings?.related_elsewhere.voucher_count).toBe(1);
      expect(feb.warnings?.related_elsewhere.vouchers[0]).toMatchObject({ building_name: "Kho chung", amount: 50_000 });
      // đánh dấu nước "không áp dụng" ⇒ không đòi nữa
      await asPostgres();
      await db.query("INSERT INTO public.building_fee_accounts(building_id, fee_category, not_applicable) VALUES ($1, 'nuoc', true)", [TOA_A]);
      await asUser(CHU_A);
      expect(settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01")).warnings?.missing_fixed_expenses).toEqual([]);
    });
  });

  it("theo kỳ: tiền phòng hoá đơn tháng 02 thu sớm ngày 28/01 vào ĐÚNG tháng 02 (như Báo cáo LN); đối chiếu khớp từng đồng", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const jan0 = settlementMonthSchema.parse(await thang(TOA_A, "2025-01-01"));
      expect(jan0.kqkd_bridge).toEqual({ kqkd_profit: 8_870_000, settlement_profit: 8_870_000, rows: [] });

      await asPostgres();
      await db.query("INSERT INTO public.invoices(id, billing_month) VALUES ($1, '2025-02')", [id(901)]);
      await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-01-28", hoaDon: id(901), ten: "Tiền phòng T2 thu sớm",
        dong: [{ lop: "PNL", tien: 500_000 }] });
      await asUser(CHU_A);
      const jan = settlementMonthSchema.parse(await thang(TOA_A, "2025-01-01"));
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      // tháng 01 không đổi; tháng 02 có thêm 500k chủ nhà thu (lập ngày 28/01)
      expect(jan.statement!.totals.profit).toBe(8_870_000);
      expect(jan.statement!.vouchers.some((v) => v.name === "Tiền phòng T2 thu sớm")).toBe(false);
      expect(feb.statement!.totals.landlord_collected).toBe(1_500_000);
      expect(feb.statement!.totals.profit).toBe(-1_500_000);
      expect(feb.statement!.vouchers.find((v) => v.name === "Tiền phòng T2 thu sớm"))
        .toMatchObject({ voucher_date: "2025-01-28", side: "LANDLORD", group: "PNL", amount: 500_000 });
      for (const m of [jan, feb]) {
        expect(m.kqkd_bridge?.rows).toEqual([]);
        expect(m.kqkd_bridge?.settlement_profit).toBe(m.statement!.totals.profit);
        expect(m.kqkd_bridge?.kqkd_profit).toBe(m.statement!.totals.profit);
      }
    });
  });

  it("theo kỳ: kỳ dịch vụ 2 tháng chia đều 2 tháng; phiếu sửa sau khi chốt ⇒ 'đổi sau khi chốt'", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      // trả trong tháng 01 cho kỳ dịch vụ 01/02–31/03 (2 tháng)
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-01-25", ten: "Dịch vụ quý",
        dong: [{ lop: "PNL", tien: 120_000, tu: "2025-02-01", den: "2025-03-31" }] });
      await asUser(CHU_A);
      const [jan, feb, mar] = await Promise.all(["2025-01-01", "2025-02-01", "2025-03-01"]
        .map(async (m) => settlementMonthSchema.parse(await thang(TOA_A, m))));
      expect(jan.statement!.vouchers.some((v) => v.name === "Dịch vụ quý")).toBe(false);
      expect(feb.statement!.vouchers.find((v) => v.name === "Dịch vụ quý")?.amount).toBe(60_000);
      expect(mar.statement!.vouchers.find((v) => v.name === "Dịch vụ quý")?.amount).toBe(60_000);
      expect(feb.statement!.totals.manager_paid).toBe(3_060_000);
      for (const m of [jan, feb, mar]) expect(m.kqkd_bridge?.rows).toEqual([]);
      // tháng 02 đã chốt, sau đó phiếu chi của tháng bị sửa ⇒ "đổi sau khi chốt"
      await chot("2025-02-01");
      await asPostgres();
      await db.query("UPDATE public.income_expense_items SET amount = 2500000 WHERE income_expense_id = $1", [PHIEU_LO_CHI]);
      await asUser(CHU_A);
      const feb2 = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb2.is_stale).toBe(true);
      expect(feb2.kqkd_bridge?.rows.map((r) => [r.reason, r.settlement_amount, r.kqkd_amount]))
        .toEqual([["CHANGED_AFTER_CLOSE", -3_000_000, -2_500_000]]);
    });
  });

  it("bản chép luật kỳ (landlord_kqkd_lines_v1) khớp TỪNG ĐỒNG với định nghĩa sống của fa_accrual_allocations", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      // đủ mọi nhánh xếp tháng: hoá đơn, hoá đơn không dòng, kỳ chia lẻ nhiều tháng, kỳ ngược, không kỳ,
      // phiếu không dòng, ép KQKD, hạng mục không tồn tại, phiếu chờ duyệt (chỉ bản chép có)
      await db.query("INSERT INTO public.invoices(id, billing_month) VALUES ($1, '2025-03'), ($2, '2025-04')", [id(911), id(912)]);
      await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-02-27", hoaDon: id(911), dong: [{ lop: "PNL", tien: 333_333 }, { lop: "DEPOSIT", tien: 1_000 }] });
      await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-03-02", hoaDon: id(912), tong: 70_000 });
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-01-03", dong: [{ lop: "PNL", tien: 100_001, tu: "2025-01-15", den: "2025-04-02" }] });
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-03", dong: [{ lop: "PNL", tien: 40_000, tu: "2025-03-20", den: "2025-03-01" }] });
      await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-03-09", kqkd: true, dong: [{ lop: "DEPOSIT", tien: 9_000, tu: "2025-03-01" }] });
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-03-10", loaiHangMuc: id(399), dong: [{ lop: "PNL", tien: 7_000 }] });
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-03-11", trangThai: "UNAPPROVED", dong: [{ lop: "PNL", tien: 8_000, tu: "2025-03-01", den: "2025-04-30" }] });
      await db.query("INSERT INTO public.super_admins VALUES ($1) ON CONFLICT DO NOTHING", [SUPER]);
      await asUser(SUPER);
      const canon = await db.query<{ k: string; s: string }>(
        `SELECT a.month || '|' || a.voucher_id || '|' || upper(a.side) AS k, sum(a.amount)::text AS s
           FROM public.fa_accrual_allocations('2024-12-01'::date, '2025-05-01'::date, ARRAY[$1]::uuid[]) a
          GROUP BY 1 ORDER BY 1`, [TOA_A]);
      await asPostgres();
      const ban = await db.query<{ k: string; s: string }>(
        `SELECT l.month || '|' || l.voucher_id || '|' || upper(l.side) AS k, sum(l.amount)::text AS s
           FROM app_private.landlord_kqkd_lines_v1($1, '2024-12-01'::date, '2025-05-01'::date) l
          WHERE l.approval_status = 'APPROVED'
          GROUP BY 1 ORDER BY 1`, [TOA_A]);
      expect(canon.rows.length).toBeGreaterThan(20);
      expect(ban.rows.map((r) => [r.k, Number(r.s)])).toEqual(canon.rows.map((r) => [r.k, Number(r.s)]));
      // phiếu chờ duyệt chỉ có ở bản chép, chia 2 tháng 4k + 4k
      const cho = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM app_private.landlord_kqkd_lines_v1($1, '2025-03-01'::date, '2025-04-01'::date) l
          WHERE l.approval_status = 'UNAPPROVED' AND l.amount = 4000`, [TOA_A]);
      expect(Number(cho.rows[0].n)).toBe(2);
    });
  });

  it("khoản lãi lỗ có kỳ trước tháng áp dụng (phiếu lập sau): cảnh báo ở tháng đầu, không tính, không chặn chốt", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await phieu({ loai: "EXPENSE", so: SO_CHU_NHA, thang: "2025-01-04", ten: "Điện tháng 12 trả muộn",
        dong: [{ lop: "PNL", tien: 450_000, tu: "2024-12-01", den: "2024-12-31" }] });
      await asUser(CHU_A);
      const jan = settlementMonthSchema.parse(await thang(TOA_A, "2025-01-01"));
      expect(jan.statement!.totals.profit).toBe(8_870_000);
      expect(jan.warnings?.pre_start_period).toMatchObject({ voucher_count: 1, expense: 450_000 });
      expect(jan.warnings?.pre_start_period?.vouchers[0]).toMatchObject({ name: "Điện tháng 12 trả muộn", amount: 450_000 });
      expect(jan.close_blockers).not.toContain("PRE_START_PENDING");
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb.warnings?.pre_start_period).toBeNull();
    });
  });

  it("phần chủ nhà cho Báo cáo LN: đúng số từng tháng (chốt lấy số đã chốt), chỉ toà người gọi xem được", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await chot("2025-02-01");
      // sau khi chốt, phiếu tháng 02 bị sửa: phần chủ nhà vẫn lấy SỐ ĐÃ CHỐT, không lấy số sống
      await asPostgres();
      await db.query("UPDATE public.income_expense_items SET amount = 2500000 WHERE income_expense_id = $1", [PHIEU_LO_CHI]);
      await asUser(CHU_A);
      const rows = await rpc<Json[]>("public.landlord_ihome_profit_v1($1::date, $2::date)", ["2024-11-01", "2025-03-01"]);
      // trước tháng áp dụng (01/2025) không có dòng: cả lợi nhuận là của iHome
      expect(rows.map((r) => [r.period_month, r.status])).toEqual([
        ["2025-01-01", "OPEN"], ["2025-02-01", "CLOSED"], ["2025-03-01", "OPEN"]]);
      expect(rows.every((r) => r.building_id === TOA_A)).toBe(true);
      expect([so(rows[0].profit), so(rows[0].manager_share), so(rows[0].landlord_share)]).toEqual([8_870_000, 2_661_000, 6_209_000]);
      expect([so(rows[1].profit), so(rows[1].manager_share), so(rows[1].landlord_share)]).toEqual([-2_000_000, 0, -2_000_000]);
      for (const r of rows) {
        const m = settlementMonthSchema.parse(await thang(TOA_A, String(r.period_month)));
        expect([r.status, so(r.profit), so(r.manager_share), so(r.landlord_share)]).toEqual(
          [m.status, m.statement!.totals.profit, m.statement!.totals.manager_share, m.statement!.totals.landlord_share]);
      }
      // công ty khác: không thấy toà nào; anon: không có quyền gọi
      await asUser(CHU_B);
      expect(await rpc<Json[]>("public.landlord_ihome_profit_v1($1::date, $2::date)", ["2025-01-01", "2025-03-01"])).toEqual([]);
      await asUser(null);
      await expectLoi("SELECT public.landlord_ihome_profit_v1('2025-01-01'::date, '2025-03-01'::date)", [], "42501");
    });
  });

  it("phiếu đã duyệt nhưng chưa ghi sổ quỹ (UNPOSTED): đánh dấu và chặn chốt", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-15", butToan: "UNPOSTED", dong: [{ lop: "PNL", tien: 300_000 }] });
      await asUser(CHU_A);
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb.statement?.unposted_voucher_count).toBe(1);
      expect(feb.statement?.vouchers.filter((v) => v.cash_unposted).map((v) => v.amount)).toEqual([300_000]);
      expect(feb.close_blockers).toEqual(["UNPOSTED_POSTINGS"]);
      await expectLoi("SELECT public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, feb.live_hash], "55000");
    });
  });

  it("duyệt cọc giữ chỗ ở sổ QUẢN LÝ sau khi chốt không làm tháng 'đã đổi'; cọc ở sổ chủ nhà chờ duyệt thì chặn chốt", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      const cocQl = await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-02-12", trangThai: "UNAPPROVED",
        dong: [{ lop: "DEPOSIT", tien: 2_000_000 }] });
      await asUser(CHU_A);
      expect((await chot("2025-02-01")).status).toBe("CLOSED");
      await asPostgres();
      await db.query("UPDATE public.income_expenses SET approval_status = 'APPROVED' WHERE id = $1", [cocQl]);
      await asUser(CHU_A);
      expect((await thang(TOA_A, "2025-02-01")).is_stale).toBe(false);
      await rpc("public.landlord_settlement_reopen_v1($1, '2025-02-01'::date, 'thử cọc sổ chủ nhà')", [TOA_A]);
      await asPostgres();
      await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-02-13", trangThai: "UNAPPROVED", dong: [{ lop: "DEPOSIT", tien: 900_000 }] });
      await asUser(CHU_A);
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb.close_blockers).toEqual(["PENDING_VOUCHERS"]);
      expect(feb.statement?.pending).toMatchObject({ voucher_count: 1, income: 0, expense: 0, landlord_deposit: 900_000 });
    });
  });

  it("phiếu toà khác ghi vào sổ chủ nhà của toà này: chặn chốt; trừ toà vận hành khác cũng khai sổ đó", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      // toà C (cùng chủ nhà) khai chung sổ chủ nhà với toà A
      await rpc("public.landlord_operation_upsert_v1($1, 'Chủ nhà C', 20, '2025-01-01'::date, $2::uuid[], null, true)",
        [TOA_C, [SO_CHU_NHA]]);
      await asPostgres();
      await phieu({ toa: TOA_C, loai: "INCOME", so: SO_CHU_NHA, thang: "2025-02-09", dong: [{ lop: "PNL", tien: 800_000 }] });
      await asUser(CHU_A);
      expect(settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01")).close_blockers).toEqual([]);
      await asPostgres();
      await phieu({ toa: TOA_AO, loai: "EXPENSE", so: SO_CHU_NHA, thang: "2025-02-11", ten: "Mua đồ kho", dong: [{ lop: "PNL", tien: 2_000_000 }] });
      await asUser(CHU_A);
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb.close_blockers).toEqual(["LANDLORD_ACCOUNT_ELSEWHERE"]);
      expect(feb.warnings?.landlord_account_elsewhere.vouchers.map((v) => [v.building_name, v.amount]))
        .toEqual([["Kho chung", 2_000_000]]);
      await expectLoi("SELECT public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, feb.live_hash], "55000");
      // gợi ý sổ: sổ đang có phiếu của toà khác được đếm (sổ dùng chung)
      const opts = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(opts.accounts.find((a) => a.id === SO_CHU_NHA)?.other_building_count_120d).toBeGreaterThanOrEqual(0);
    });
  });

  it("phiếu ở toà khác nhắc tên toà có dấu (bỏ dấu, chịu khoảng trắng/gạch nối)", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await rpc("public.landlord_operation_upsert_v1($1, 'Chủ nhà C', 20, '2025-01-01'::date, $2::uuid[], null, true)",
        [TOA_C, [SO_CHU_NHA_C]]);
      await asPostgres();
      await phieu({ toa: TOA_AO, loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-06", ten: "sửa điện nhà hem 66-thanh cong",
        dong: [{ lop: "PNL", tien: 450_000 }] });
      await phieu({ toa: TOA_AO, loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-07", ten: "Sơn cửa Hẻm 66 Thành Công",
        dong: [{ lop: "PNL", tien: 550_000 }] });
      await asUser(CHU_A);
      const feb = settlementMonthSchema.parse(await thang(TOA_C, "2025-02-01"));
      expect(feb.warnings?.related_elsewhere.vouchers.map((v) => v.amount).sort()).toEqual([450_000, 550_000]);
    });
  });
});

describe("vòng 2: xác nhận số dư, sổ đã xoá, áp % từ tháng, link toà đã xoá", () => {
  it("cọc trước kỳ đổi (phiếu nhập muộn) ⇒ xác nhận số dư cũ hết hiệu lực; tick lại thì hết chặn; dời tháng mà bỏ tick thì chặn", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await caiToaA(30, "2025-01-01", 700_000, true);
      let o = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect([o.current?.opening_confirmation_stale, o.current?.opening_confirmed_pre_start]).toEqual([false, 700_000]);
      expect((await thang(TOA_A, "2025-02-01")).close_blockers).toEqual([]);

      await asPostgres();
      await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2024-12-28", dong: [{ lop: "DEPOSIT", tien: 200_000 }] });
      await asUser(CHU_A);
      o = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect([o.current?.opening_confirmation_stale, o.current?.pre_start_landlord_deposits]).toEqual([true, 900_000]);
      expect((await thang(TOA_A, "2025-02-01")).close_blockers).toEqual(["OPENING_UNCONFIRMED"]);
      expect(settlementOverviewSchema.parse(await rpc("public.landlord_settlement_overview_v1($1)", [TOA_A])).opening_confirmed).toBe(false);

      await caiToaA(30, "2025-01-01", 900_000, true, null, 900_000);
      o = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(o.current?.opening_confirmation_stale).toBe(false);
      expect((await thang(TOA_A, "2025-02-01")).close_blockers).toEqual([]);

      await caiToaA(30, "2024-12-01", 900_000, false);
      expect((await thang(TOA_A, "2024-12-01")).close_blockers).toContain("OPENING_UNCONFIRMED");
    });
  });

  it("sổ chủ nhà đang dùng mà bị xoá mềm vẫn lưu được cài đặt; THÊM sổ đã xoá thì không", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await db.query("UPDATE public.accounts SET deleted_at = now() WHERE id IN ($1, $2)", [SO_CHU_NHA, SO_QUAN_LY]);
      await asUser(CHU_A);
      expect((await caiToaA(30, "2025-01-01")).building_id).toBe(TOA_A);
      await expectLoi(`SELECT ${UPSERT_A}`, [TOA_A, 30, "2025-01-01", [SO_CHU_NHA, SO_QUAN_LY], 0, true, null, 700_000], "22023");
      const opts = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(opts.accounts.find((a) => a.id === SO_CHU_NHA)?.is_deleted).toBe(true);
    });
  });

  it("áp % từ một tháng cụ thể so với điều khoản đang áp ở tháng đó (kể cả khi trùng bản mới nhất)", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      expect((await caiToaA(40, "2025-01-01", 0, true, "2025-05-01")).terms_from).toBe("2025-05-01");
      // muốn 40% sớm từ 03: trùng bản mới nhất nhưng khác điều khoản đang áp ở 03 ⇒ phải đổi
      expect((await caiToaA(40, "2025-01-01", 0, true, "2025-03-01")).terms_from).toBe("2025-03-01");
      const o = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(o.current?.terms.map((t) => [t.valid_from, t.manager_percent])).toEqual([["2025-01-01", 30], ["2025-03-01", 40]]);
      // lặp lại y nguyên ⇒ không đổi gì
      expect((await caiToaA(40, "2025-01-01", 0, true, "2025-03-01")).terms_from).toBeNull();
    });
  });

  it("toà bị xoá mềm hoặc thành toà ảo: link chủ nhà trả NULL", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const { token } = await rpc<{ token: string }>("public.landlord_share_link_create_v1($1, null)", [TOA_A]);
      await asPostgres();
      await db.query("UPDATE public.buildings SET deleted_at = now() WHERE id = $1", [TOA_A]);
      await asUser(null);
      expect(await rpc("public.landlord_settlement_public_v1($1, null)", [token])).toBeNull();
    });
  });
});

describe("vòng 3: xác nhận đúng số đã thấy, đổi điều khoản từng trường, hash, nhãn đối chiếu", () => {
  it("chỉ ghi xác nhận khi cơ sở không đổi trong lần lưu VÀ đúng số cọc trước kỳ người dùng đã thấy", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      // thấy sai số (vd màn cũ) ⇒ không xác nhận, báo phải đối chiếu lại
      const sai = upsertReceiptSchema.parse(await caiToaA(30, "2025-01-01", 700_000, true, null, 123));
      expect(sai.opening_needs_reconfirm).toBe(true);
      let o = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(o.current?.opening_confirmed_at).toBeNull();
      // đúng số đã thấy ⇒ xác nhận
      expect(upsertReceiptSchema.parse(await caiToaA(30, "2025-01-01", 700_000, true, null, 700_000)).opening_needs_reconfirm).toBe(false);
      o = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(o.current?.opening_confirmed_at).not.toBeNull();
      // chưa có xác nhận; đổi sổ của điều khoản ĐẦU mà tick ngay (cọc trước kỳ tình cờ không đổi) ⇒ không nhận
      // trong lần lưu đó (có xác nhận cũ còn khớp số thì được giữ — cơ sở không đổi giá trị)
      await caiToaA(30, "2025-01-01", 700_000, false);
      const doiSo = upsertReceiptSchema.parse(
        await rpc(UPSERT_A, [TOA_A, 30, "2025-01-01", [SO_CHU_NHA, SO_QUAN_LY], 700_000, true, "2025-01-01", 700_000]));
      expect(doiSo.opening_needs_reconfirm).toBe(true);
      await caiToaA(30, "2025-01-01", 700_000, true, "2025-01-01", 700_000);
      // dời tháng áp dụng mà vẫn tick, kể cả gửi đúng số cọc trước kỳ của tháng MỚI ⇒ không nhận
      const doi = upsertReceiptSchema.parse(await caiToaA(30, "2025-02-01", 700_000, true, null, 1_505_000));
      expect(doi.opening_needs_reconfirm).toBe(true);
      expect((await thang(TOA_A, "2025-02-01")).close_blockers).toContain("OPENING_UNCONFIRMED");
      const lui = upsertReceiptSchema.parse(await caiToaA(30, "2024-12-01", 700_000, true, null, 700_000));
      expect(lui.opening_needs_reconfirm).toBe(true);
      expect((await thang(TOA_A, "2024-12-01")).close_blockers).toContain("OPENING_UNCONFIRMED");
    });
  });

  it("đổi % từ tháng X chỉ đổi %, giữ sổ của từng mốc sau X (không kéo sổ của mốc mới nhất về X)", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      // từ 04: chủ nhà nhận thêm sổ quản lý cũ làm sổ chủ nhà
      await rpc(UPSERT_A, [TOA_A, 30, "2025-01-01", [SO_CHU_NHA, SO_QUAN_LY], 0, true, "2025-04-01", 700_000]);
      // tăng % từ 03, gửi đúng sổ của điều khoản đang áp ở 03
      expect((await rpc<Json>(UPSERT_A, [TOA_A, 35, "2025-01-01", [SO_CHU_NHA], 0, true, "2025-03-01", 700_000])).terms_from)
        .toBe("2025-03-01");
      const o = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(o.current?.terms.map((t) => [t.valid_from, t.manager_percent, t.landlord_account_ids.length]))
        .toEqual([["2025-01-01", 30, 1], ["2025-03-01", 35, 1], ["2025-04-01", 35, 2]]);
      // tháng 03: tiền khách vào sổ quản lý vẫn là quản lý thu
      const mar = settlementMonthSchema.parse(await thang(TOA_A, "2025-03-01"));
      expect(mar.statement?.totals.manager_collected).toBe(50_000);
      expect(mar.statement?.manager_percent).toBe(35);
    });
  });

  it("phiếu toà khác ghi vào sổ chủ nhà, nhập sau khi chốt, làm tháng 'đã đổi'", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await chot("2025-02-01");
      await asPostgres();
      await phieu({ toa: TOA_AO, loai: "EXPENSE", so: SO_CHU_NHA, thang: "2025-02-20", dong: [{ lop: "PNL", tien: 3_000_000 }] });
      await asUser(CHU_A);
      expect((await thang(TOA_A, "2025-02-01")).is_stale).toBe(true);
      const ov = settlementOverviewSchema.parse(await rpc("public.landlord_settlement_overview_v1($1)", [TOA_A]));
      expect(ov.months.find((m) => m.period_month === "2025-02-01")?.is_stale).toBe(true);
    });
  });

  it("đối chiếu KQKD: phiếu bị dời ngày sang tháng khác sau khi chốt ⇒ 'đổi sau khi chốt'", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await chot("2025-02-01");
      await asPostgres();
      await db.query("UPDATE public.income_expenses SET voucher_date = '2025-03-02' WHERE id = $1", [PHIEU_LO_CHI]);
      await asUser(CHU_A);
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb.kqkd_bridge?.rows.find((r) => r.settlement_amount === -3_000_000)?.reason).toBe("CHANGED_AFTER_CLOSE");
    });
  });

  it("sổ chủ nhà của toà vận hành đang NGỪNG áp dụng vẫn là tiền chủ nhà kia ⇒ vẫn chặn; tên toà có ' - ' vẫn nhận ra", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await rpc("public.landlord_operation_upsert_v1($1, 'Chủ nhà C', 20, '2025-01-01'::date, $2::uuid[], null, false)",
        [TOA_C, [SO_CHU_NHA_C]]);
      await asPostgres();
      await phieu({ loai: "EXPENSE", so: SO_CHU_NHA_C, thang: "2025-02-10", dong: [{ lop: "PNL", tien: 100_000 }] });
      await phieu({ toa: TOA_AO, loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-02-06", ten: "sửa ống nước 44 - TA",
        dong: [{ lop: "PNL", tien: 75_000 }] });
      await asUser(CHU_A);
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect(feb.statement?.foreign_account_voucher_count).toBe(1);
      expect(feb.close_blockers).toContain("FOREIGN_LANDLORD_ACCOUNT");
      expect(feb.warnings?.related_elsewhere.vouchers.map((v) => v.amount)).toEqual([75_000]);
      // toà kia bị XOÁ mềm thì không còn chặn (không ai sửa được điều khoản của nó nữa)
      await asPostgres();
      await db.query("UPDATE public.buildings SET deleted_at = now() WHERE id = $1", [TOA_C]);
      await asUser(CHU_A);
      expect(settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01")).statement?.foreign_account_voucher_count).toBe(0);
    });
  });
});

describe("vòng 4: sổ đã xoá ở phiên bản cũ, kẹp tháng áp tỷ lệ", () => {
  it("sổ đã xoá còn ở một phiên bản điều khoản cũ vẫn lưu được và vẫn hiện để bỏ chọn", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      // 01: [chủ nhà, quản lý cũ]; từ 04 bỏ sổ quản lý cũ
      await rpc(UPSERT_A, [TOA_A, 30, "2025-01-01", [SO_CHU_NHA, SO_QUAN_LY], 0, true, "2025-01-01", 700_000]);
      await rpc(UPSERT_A, [TOA_A, 30, "2025-01-01", [SO_CHU_NHA], 0, true, "2025-04-01", 700_000]);
      await asPostgres();
      await db.query("UPDATE public.accounts SET deleted_at = now() WHERE id = $1", [SO_QUAN_LY]);
      await asUser(CHU_A);
      // chỉ tăng % từ 02, gửi đúng sổ đang áp ở 02 (có sổ đã xoá)
      const r = upsertReceiptSchema.parse(
        await rpc(UPSERT_A, [TOA_A, 35, "2025-01-01", [SO_CHU_NHA, SO_QUAN_LY], 0, true, "2025-02-01", 700_000]));
      expect(r.terms_from).toBe("2025-02-01");
      const o = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(o.accounts.find((a) => a.id === SO_QUAN_LY)?.is_deleted).toBe(true);
      expect(o.current?.terms.map((t) => [t.valid_from, t.manager_percent, t.landlord_account_ids.length]))
        .toEqual([["2025-01-01", 30, 2], ["2025-02-01", 35, 2], ["2025-04-01", 35, 1]]);
    });
  });

  it("tháng áp tỷ lệ sớm hơn tháng bắt đầu mới: không đổi gì thì không lỗi; có đổi thì kẹp về tháng bắt đầu", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      expect(upsertReceiptSchema.parse(await caiToaA(30, "2025-03-01", 0, true, "2025-01-01")).terms_from).toBeNull();
      expect(upsertReceiptSchema.parse(await caiToaA(45, "2025-03-01", 0, true, "2025-01-01")).terms_from).toBe("2025-03-01");
    });
  });
});

describe("vòng 6 (review chéo trước phát hành): chống ghi đè cài đặt, toà tạm ngừng", () => {
  const UPSERT_CAS = "public.landlord_operation_upsert_v1($1, 'Chủ nhà A', 30, '2025-01-01'::date, $2::uuid[], 'chỉ sửa ghi chú', true, 100000, true, null, 700000, $3::timestamptz)";
  const caiDat = async () =>
    landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A])).current!;

  it("lưu kèm updated_at đã cũ ⇒ 40001, không ghi đè số người khác vừa lưu; đọc lại rồi lưu thì được; null ⇒ không kiểm", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const daThay = (await caiDat()).updated_at;
      // người khác lưu số dư đầu kỳ 200.000 trong lúc hộp này đang mở
      await caiToaA(30, "2025-01-01", 200_000, true);
      await expectLoi(`SELECT ${UPSERT_CAS}`, [TOA_A, [SO_CHU_NHA], daThay], "40001");
      const sau = await caiDat();
      expect(sau.opening_balance).toBe(200_000);
      expect(sau.note ?? null).not.toBe("chỉ sửa ghi chú");
      // mở lại hộp (đọc updated_at mới) ⇒ lưu được
      await rpc(UPSERT_CAS, [TOA_A, [SO_CHU_NHA], sau.updated_at]);
      expect((await caiDat()).opening_balance).toBe(100_000);
      // gọi không kèm updated_at (ngoài màn) ⇒ không kiểm như cũ
      await rpc(UPSERT_CAS, [TOA_A, [SO_CHU_NHA], null]);
    });
  });

  it("toà tạm ngừng: phần chủ nhà cho Báo cáo LN chỉ còn tháng đã chốt, tháng mở không tính tạm", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await chot("2025-02-01");
      await rpc("public.landlord_operation_upsert_v1($1, 'Chủ nhà A', 30, '2025-01-01'::date, $2::uuid[], null, false)", [TOA_A, [SO_CHU_NHA]]);
      const rows = await rpc<Json[]>("public.landlord_ihome_profit_v1($1::date, $2::date)", ["2025-01-01", "2025-03-01"]);
      expect(rows.map((r) => [r.period_month, r.status])).toEqual([["2025-02-01", "CLOSED"]]);
      // bật lại ⇒ các tháng mở tính tạm trở lại
      await rpc("public.landlord_operation_upsert_v1($1, 'Chủ nhà A', 30, '2025-01-01'::date, $2::uuid[], null, true)", [TOA_A, [SO_CHU_NHA]]);
      const lai = await rpc<Json[]>("public.landlord_ihome_profit_v1($1::date, $2::date)", ["2025-01-01", "2025-03-01"]);
      expect(lai.map((r) => r.status)).toEqual(["OPEN", "CLOSED", "OPEN"]);
    });
  });
});

describe("gói RPC thật và schema zod", () => {
  it("gói RPC thật parse được bằng đúng schema zod mà web dùng", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      for (const m of ["2024-12-01", "2025-01-01", "2025-02-01", "2025-03-01"]) {
        settlementMonthSchema.parse(await thang(TOA_A, m));
      }
      settlementOverviewSchema.parse(await rpc("public.landlord_settlement_overview_v1($1)", [TOA_A]));
      landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      landlordOperationsListSchema.parse(await rpc("public.landlord_operations_list_v1()"));
      const { token } = await rpc<{ token: string }>("public.landlord_share_link_create_v1($1, 'Zalo')", [TOA_A]);
      shareLinksSchema.parse(await rpc("public.landlord_share_links_v1($1)", [TOA_A]));
      await asUser(null);
      settlementPublicSchema.parse(await rpc("public.landlord_settlement_public_v1($1, '2025-01-01'::date)", [token]));
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 20261023113626 — quản lý nhận TIỀN CỐ ĐỊNH (đ/tháng) và/hoặc % (chủ chốt 23/10/2026)
// ─────────────────────────────────────────────────────────────────────────────
const UPSERT_CD = "public.landlord_operation_upsert_v1($1, 'Chủ nhà A', $2, '2025-01-01'::date, $3::uuid[], null, true, 0, true, $4::date, 700000, $5::timestamptz, $6)";
/** Cài toà A qua RPC 13 tham số: % · tiền cố định · áp từ tháng · updated_at đã thấy. */
const caiCoDinh = (pct: number, coDinh: number | null, apTu: string | null = null, daThay: string | null = null) =>
  rpc<Json>(UPSERT_CD, [TOA_A, pct, [SO_CHU_NHA], apTu, daThay, coDinh]);
const tongThang = async (m: string) => ((await thang(TOA_A, m)).statement as Json).totals as Json;
const dieuKhoan = async (toa = TOA_A) =>
  landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [toa])).current!;
/** Câu mong lỗi, trả về lỗi để soi thêm câu báo. */
async function loiCua(sql: string, params: unknown[]): Promise<{ code?: string; message?: string } | null> {
  await db.exec("SAVEPOINT thu_loi_cd");
  let err: { code?: string; message?: string } | null = null;
  try { await db.query(sql, params); } catch (e) { err = e as { code?: string; message?: string }; }
  await db.exec(err ? "ROLLBACK TO SAVEPOINT thu_loi_cd" : "RELEASE SAVEPOINT thu_loi_cd");
  return err;
}

describe("tiền cố định: migration", () => {
  it("thân production tái lập đúng md5 trước khi áp", () => {
    expect(md5Goc).toEqual(PROD_MD5);
  });

  it("md5 lượt hai được tiền kiểm nhận đúng bằng thân của chính file", () => {
    const sql = readFileSync(FILE_CO_DINH, "utf8");
    for (const s of HAM_THAY) {
      expect(md5LuotMot[s]).toMatch(/^[0-9a-f]{32}$/);
      expect(sql).toContain(`'${PROD_MD5[s]}', '${md5LuotMot[s]}'`);
    }
    expect(sql).toContain(`IF v_md5 <> '${md5LuotMot[UPSERT_MOI]}' THEN`);
  });

  it.each([
    ["hàm thay thân (công thức)", "CREATE OR REPLACE FUNCTION app_private.landlord_settlement_compute_v1(p_building_id uuid, p_month date) RETURNS jsonb LANGUAGE sql STABLE AS $x$ SELECT '{}'::jsonb $x$"],
    ["hàm chỉ đọc (phần chủ nhà cho Báo cáo LN)", "CREATE OR REPLACE FUNCTION public.landlord_ihome_profit_v1(p_from date, p_to date) RETURNS jsonb LANGUAGE sql STABLE AS $x$ SELECT '[]'::jsonb $x$"],
  ])("thân lạ ở %s ⇒ dừng 55000", async (_ten, gia) => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await chay(gia);
      const block = readFileSync(FILE_CO_DINH, "utf8").replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
      await expect(db.exec(block)).rejects.toMatchObject({ code: "55000" });
    });
  });

  it("đúng MỘT chữ ký hàm ghi; dòng điều khoản có sẵn nhận 0; tiền cố định 0 băm y như trước (tháng đã chốt không 'đổi')", async () => {
    const r = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'landlord_operation_upsert_v1'");
    expect(r.rows[0].n).toBe(1);
    const t = await db.query<{ f: string }>(
      "SELECT manager_fixed_amount::text AS f FROM app_private.landlord_operation_terms WHERE building_id = $1", [TOA_A]);
    expect(t.rows.map((x) => Number(x.f))).toEqual([0]);
    expect(hashTruoc.every((h) => /^[0-9a-f]{32}$/.test(h))).toBe(true);
    expect(hashSau).toEqual(hashTruoc);
  });

  it("CHECK cột: âm hoặc lẻ đồng bị từ chối ngay ở bảng", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await expectLoi("UPDATE app_private.landlord_operation_terms SET manager_fixed_amount = -1 WHERE building_id = $1", [TOA_A], "23514");
      await expectLoi("UPDATE app_private.landlord_operation_terms SET manager_fixed_amount = 10.5 WHERE building_id = $1", [TOA_A], "23514");
    });
  });
});

describe("tiền cố định: công thức", () => {
  it("chỉ %: phần cố định 0, phần % như cũ", async () => {
    const st = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      return (await thang(TOA_A, "2025-01-01")).statement as Json;
    });
    const t = st.totals as Json;
    expect(so(st.manager_fixed_amount)).toBe(0);
    expect([so(t.manager_fixed_share), so(t.manager_percent_share), so(t.manager_share)]).toEqual([0, 2_661_000, 2_661_000]);
  });

  it("chỉ cố định (0% + 5tr): quản lý nhận đủ 5tr, chủ nhà phần còn lại; bảo toàn tiền", async () => {
    const st = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await caiCoDinh(0, 5_000_000);
      return (await thang(TOA_A, "2025-01-01")).statement as Json;
    });
    const t = st.totals as Json;
    expect([so(st.manager_percent), so(st.manager_fixed_amount)]).toEqual([0, 5_000_000]);
    expect([so(t.manager_fixed_share), so(t.manager_percent_share), so(t.manager_share)]).toEqual([5_000_000, 0, 5_000_000]);
    expect(so(t.landlord_share)).toBe(3_870_000);
    expect(so(t.landlord_owes_manager)).toBe(6_435_000);
    expect(so(t.landlord_collected) - so(t.landlord_paid) + so(t.landlord_held_deposits) - so(t.landlord_share))
      .toBe(so(t.landlord_owes_manager));
  });

  it("cả hai: ví dụ của chủ — LN 50tr, cố định 5tr, 30% ⇒ quản lý 20tr", async () => {
    const [jan, mar] = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await caiCoDinh(30, 5_000_000);
      await asPostgres();
      // tháng 03 có LN 150k ⇒ thêm 49.850.000 chủ nhà thu ⇒ LN đúng 50tr
      await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-03-05", dong: [{ lop: "PNL", tien: 49_850_000 }] });
      await asUser(CHU_A);
      return [await tongThang("2025-01-01"), await tongThang("2025-03-01")];
    });
    expect([so(jan.manager_fixed_share), so(jan.manager_percent_share), so(jan.manager_share), so(jan.landlord_share)])
      .toEqual([5_000_000, 2_661_000, 7_661_000, 1_209_000]);
    expect(so(jan.landlord_owes_manager)).toBe(9_096_000);
    expect(so(mar.profit)).toBe(50_000_000);
    expect([so(mar.manager_fixed_share), so(mar.manager_percent_share), so(mar.manager_share), so(mar.landlord_share)])
      .toEqual([5_000_000, 15_000_000, 20_000_000, 30_000_000]);
  });

  it("tháng lỗ / LN thấp: phần % về 0 (luật cũ), phần cố định VẪN ĐỦ ⇒ phần chủ nhà âm (chủ nhà bù)", async () => {
    const [feb, mar] = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await caiCoDinh(30, 5_000_000);
      return [await tongThang("2025-02-01"), await tongThang("2025-03-01")];
    });
    expect(so(feb.profit)).toBe(-2_000_000);
    expect([so(feb.manager_fixed_share), so(feb.manager_percent_share), so(feb.manager_share)]).toEqual([5_000_000, 0, 5_000_000]);
    expect(so(feb.landlord_share)).toBe(-7_000_000);
    expect(so(feb.landlord_owes_manager)).toBe(8_000_000);
    expect(so(feb.landlord_collected) - so(feb.landlord_paid) + so(feb.landlord_held_deposits) - so(feb.landlord_share))
      .toBe(so(feb.landlord_owes_manager));
    // LN 150k: 30% = 45k + 5tr cố định
    expect([so(mar.manager_share), so(mar.landlord_share), so(mar.landlord_owes_manager)]).toEqual([5_045_000, -4_895_000, 4_997_000]);
  });

  it("toà chỉ cố định, chưa có phiếu nào: quản lý vẫn nhận đủ, chủ nhà trả đúng tiền cố định", async () => {
    const [kq, st] = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const a = await rpc<Json>(
        "public.landlord_operation_upsert_v1($1, 'Chủ nhà C', 0, '2025-01-01'::date, $2::uuid[], null, true, 0, false, null, null, null, 3000000)",
        [TOA_C, [SO_CHU_NHA_C]]);
      return [a, settlementMonthSchema.parse(await thang(TOA_C, "2025-01-01")).statement!] as const;
    });
    expect(kq.created).toBe(true);
    expect(st.manager_fixed_amount).toBe(3_000_000);
    expect([st.totals.profit, st.totals.manager_share, st.totals.landlord_share, st.totals.landlord_owes_manager])
      .toEqual([0, 3_000_000, -3_000_000, 3_000_000]);
  });
});

describe("tiền cố định: cài đặt", () => {
  it("cả % lẫn tiền cố định bằng 0 ⇒ 22023 (toà mới, toà đang có, gửi NULL giữ 0đ); tiền âm / lẻ đồng ⇒ 22023", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const e = await loiCua(`SELECT ${UPSERT_CD}`, [TOA_A, 0, [SO_CHU_NHA], null, null, 0]);
      expect(e?.code).toBe("22023");
      expect(e?.message).toContain("không để cả hai bằng 0");
      // lời gọi 12 tham số (NULL = giữ tiền cố định đang áp, đang 0đ)
      await expectLoi(`SELECT ${UPSERT_A}`, [TOA_A, 0, "2025-01-01", [SO_CHU_NHA], 0, true, null, 700_000], "22023");
      await expectLoi("SELECT public.landlord_operation_upsert_v1($1, 'Chủ nhà C', 0, '2025-01-01'::date, $2::uuid[], null, true)",
        [TOA_C, [SO_CHU_NHA_C]], "22023");
      await expectLoi(`SELECT ${UPSERT_CD}`, [TOA_A, 30, [SO_CHU_NHA], null, null, -1], "22023");
      await expectLoi(`SELECT ${UPSERT_CD}`, [TOA_A, 30, [SO_CHU_NHA], null, null, 10.5], "22023");
      // không ghi gì
      expect((await dieuKhoan()).terms.map((t) => [t.manager_percent, t.manager_fixed_amount])).toEqual([[30, 0]]);
    });
  });

  it("đổi một trường làm mốc sau thành 0% + 0đ ⇒ 22023 nêu tháng đó", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await caiCoDinh(30, 5_000_000);
      await caiCoDinh(30, 0, "2025-03-01");
      // từ 02: chỉ đổi % về 0 (giữ 5tr) ⇒ mốc 03 (đang 30% + 0đ) nhận 0% ⇒ 0/0
      const e = await loiCua(`SELECT ${UPSERT_CD}`, [TOA_A, 0, [SO_CHU_NHA], "2025-02-01", null, 5_000_000]);
      expect(e?.code).toBe("22023");
      expect(e?.message).toContain("03/2025");
      expect((await dieuKhoan()).terms.map((t) => [t.valid_from, t.manager_percent, t.manager_fixed_amount]))
        .toEqual([["2025-01-01", 30, 5_000_000], ["2025-03-01", 30, 0]]);
    });
  });

  it("đổi tiền cố định từ tháng chưa chốt: tháng đã chốt giữ nguyên, không 'đổi sau khi chốt'; từ tháng đã chốt ⇒ 55000; đổi từng trường", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      expect((await chot("2025-02-01")).status).toBe("CLOSED");
      const r = upsertReceiptSchema.parse(await caiCoDinh(30, 1_000_000));
      expect(r.terms_from).toBe("2025-03-01");
      const feb = settlementMonthSchema.parse(await thang(TOA_A, "2025-02-01"));
      expect([feb.status, feb.is_stale, feb.statement?.manager_fixed_amount, feb.statement?.totals.manager_share])
        .toEqual(["CLOSED", false, 0, 0]);
      expect(settlementMonthSchema.parse(await thang(TOA_A, "2025-01-01")).statement?.manager_fixed_amount).toBe(0);
      const mar = settlementMonthSchema.parse(await thang(TOA_A, "2025-03-01")).statement!;
      expect([mar.manager_fixed_amount, mar.totals.manager_fixed_share, mar.totals.manager_share]).toEqual([1_000_000, 1_000_000, 1_045_000]);

      for (const tu of ["2025-02-01", "2025-01-01"]) {
        const e = await loiCua(`SELECT ${UPSERT_CD}`, [TOA_A, 30, [SO_CHU_NHA], tu, null, 2_000_000]);
        expect(e?.code).toBe("55000");
        expect(e?.message).toContain("tiền cố định");
      }
      // đổi % từ 04: giữ tiền cố định của mốc 03; rồi đổi tiền cố định từ 03: mốc 04 giữ 40%
      await caiCoDinh(40, 1_000_000, "2025-04-01");
      await caiCoDinh(30, 2_000_000, "2025-03-01");
      expect((await dieuKhoan()).terms.map((t) => [t.valid_from, t.manager_percent, t.manager_fixed_amount]))
        .toEqual([["2025-01-01", 30, 0], ["2025-03-01", 30, 2_000_000], ["2025-04-01", 40, 2_000_000]]);
      // lời gọi 12 tham số (bản web cũ): NULL giữ tiền cố định; mốc 04 trùng 03 thì gộp
      await caiToaA(35, "2025-01-01", 0, true, "2025-03-01");
      const dk = await dieuKhoan();
      expect(dk.terms.map((t) => [t.valid_from, t.manager_percent, t.manager_fixed_amount]))
        .toEqual([["2025-01-01", 30, 0], ["2025-03-01", 35, 2_000_000]]);
      expect([dk.manager_percent, dk.manager_fixed_amount]).toEqual([35, 2_000_000]);
      // sổ thay đổi ghi tiền cố định trước/sau
      const h = (await rpc<Json>("public.landlord_operation_options_v1($1)", [TOA_A])).history as Json[];
      expect(((h[0].after as Json).terms as Json[]).map((t) => so(t.manager_fixed_amount))).toEqual([0, 2_000_000]);
      expect(((h[0].before as Json).terms as Json[]).map((t) => so(t.manager_fixed_amount))).toEqual([0, 2_000_000, 2_000_000]);
      // tháng đã chốt vẫn y nguyên
      expect((await thang(TOA_A, "2025-02-01")).is_stale).toBe(false);
    });
  });

  it("source_hash đổi khi đổi tiền cố định của tháng mở; về lại 0đ thì về lại đúng chuỗi cũ", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const h0 = String((await thang(TOA_A, "2025-01-01")).live_hash);
      await caiCoDinh(30, 5_000_000);
      const h1 = String((await thang(TOA_A, "2025-01-01")).live_hash);
      await caiCoDinh(30, 6_000_000);
      const h2 = String((await thang(TOA_A, "2025-01-01")).live_hash);
      await caiCoDinh(30, 0);
      const h3 = String((await thang(TOA_A, "2025-01-01")).live_hash);
      expect(new Set([h0, h1, h2]).size).toBe(3);
      expect(h3).toBe(h0);
    });
  });

  it("chống ghi đè (CAS) cũng giữ tiền cố định của người lưu trước", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const daThay = (await dieuKhoan()).updated_at;
      await caiCoDinh(30, 1_000_000);
      await expectLoi(`SELECT ${UPSERT_CD}`, [TOA_A, 30, [SO_CHU_NHA], null, daThay, 2_000_000], "40001");
      expect((await dieuKhoan()).manager_fixed_amount).toBe(1_000_000);
      await caiCoDinh(30, 2_000_000, null, (await dieuKhoan()).updated_at);
      expect((await dieuKhoan()).manager_fixed_amount).toBe(2_000_000);
    });
  });

  it("danh sách / tổng quyết toán / hộp cài đặt kèm tiền cố định (parse bằng zod của web)", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await caiCoDinh(30, 5_000_000);
      const ds = landlordOperationsListSchema.parse(await rpc("public.landlord_operations_list_v1()"));
      expect(ds.operations.map((o) => [o.manager_percent, o.manager_fixed_amount])).toEqual([[30, 5_000_000]]);
      const ov = settlementOverviewSchema.parse(await rpc("public.landlord_settlement_overview_v1($1)", [TOA_A]));
      expect(ov.manager_fixed_amount).toBe(5_000_000);
      expect(ov.months.slice(0, 3).map((m) => [m.manager_fixed_amount, m.manager_share])).toEqual([
        [5_000_000, 7_661_000], [5_000_000, 5_000_000], [5_000_000, 5_045_000]]);
      expect((await dieuKhoan()).terms.map((t) => t.manager_fixed_amount)).toEqual([5_000_000]);
    });
  });
});

describe("tiền cố định: Báo cáo LN và link chủ nhà", () => {
  it("dòng iHome: phần chủ nhà âm tháng lỗ ⇒ của iHome = tổng − phần chủ nhà = đúng tiền cố định", async () => {
    const [rows, months] = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await caiCoDinh(30, 5_000_000);
      const r = landlordIhomeProfitSchema.parse(
        await rpc("public.landlord_ihome_profit_v1($1::date, $2::date)", ["2025-01-01", "2025-03-01"]));
      const m = [];
      for (const x of r) m.push(settlementMonthSchema.parse(await thang(TOA_A, x.period_month)));
      return [r, m] as const;
    });
    expect(rows.map((r) => [r.period_month, r.manager_share, r.landlord_share])).toEqual([
      ["2025-01-01", 7_661_000, 1_209_000], ["2025-02-01", 5_000_000, -7_000_000], ["2025-03-01", 5_045_000, -4_895_000]]);
    rows.forEach((r, i) => {
      expect([r.profit, r.manager_share, r.landlord_share]).toEqual(
        [months[i].statement!.totals.profit, months[i].statement!.totals.manager_share, months[i].statement!.totals.landlord_share]);
    });
    // Báo cáo LN tháng 02 chỉ có toà A (tổng −2tr): của iHome = −2tr − (−7tr) = 5tr
    expect(ihomeProfitOf(-2_000_000, rows, { months: ["2025-02"], buildingIds: [TOA_A] }))
      .toMatchObject({ profit: 5_000_000, landlordShare: -7_000_000 });
  });

  it("toà ngừng áp dụng: tháng mở vẫn liệt kê (chốt được) nhưng không cộng tạm tính — phí cố định không tự dồn", async () => {
    const [dang, ngung] = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await caiCoDinh(30, 5_000_000);
      await chot("2025-02-01");
      const truoc = settlementOverviewSchema.parse(await rpc("public.landlord_settlement_overview_v1($1)", [TOA_A]));
      await rpc("public.landlord_operation_upsert_v1($1, 'Chủ nhà A', 30, '2025-01-01'::date, $2::uuid[], null, false)", [TOA_A, [SO_CHU_NHA]]);
      const sau = settlementOverviewSchema.parse(await rpc("public.landlord_settlement_overview_v1($1)", [TOA_A]));
      return [truoc, sau] as const;
    });
    const mo = dang.months.filter((m) => m.status === "OPEN");
    expect(mo.length).toBeGreaterThan(1);
    expect(dang.totals.open_net).toBe(mo.reduce((s, m) => s + m.landlord_owes_manager, 0));
    expect(dang.totals.open_net).not.toBe(0);
    expect(ngung.is_active).toBe(false);
    expect(ngung.months.map((m) => [m.period_month, m.status])).toEqual(dang.months.map((m) => [m.period_month, m.status]));
    expect([ngung.totals.open_net, ngung.totals.closed_net]).toEqual([0, dang.totals.closed_net]);
    expect(ngung.totals.balance_with_open).toBe(ngung.totals.balance_closed);
  });

  it("link công khai: chủ nhà thấy tiền cố định và phần % tách riêng, không lộ id", async () => {
    const pub = await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await caiCoDinh(30, 5_000_000);
      const { token } = await rpc<{ token: string }>("public.landlord_share_link_create_v1($1, null)", [TOA_A]);
      await asUser(null);
      return settlementPublicSchema.parse(await rpc("public.landlord_settlement_public_v1($1, '2025-02-01'::date)", [token]));
    });
    const st = pub.month.statement!;
    expect(st.manager_fixed_amount).toBe(5_000_000);
    expect([st.totals.manager_fixed_share, st.totals.manager_percent_share, st.totals.landlord_share, st.totals.landlord_owes_manager])
      .toEqual([5_000_000, 0, -7_000_000, 8_000_000]);
    expect(st.vouchers.every((v) => v.id === undefined)).toBe(true);
    expect(pub.overview.manager_fixed_amount).toBe(5_000_000);
    expect(pub.overview.months.find((m) => m.period_month === "2025-02-01")?.manager_fixed_amount).toBe(5_000_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tên hiển thị phiếu trong "Phiếu trong tháng" (chủ nhắn 23/10/2026): server trả phần dựng tên, web dựng
// bằng src/lib/voucherDisplayName.ts — cùng đường với Thu chi / Báo cáo LN. Mã / tên giả.
// ─────────────────────────────────────────────────────────────────────────────
const [PHONG_1, PHONG_2, HOP_DONG_1] = [41, 42, 51].map(id);
async function phongVaHopDong() {
  await db.query("INSERT INTO public.rooms VALUES ($1, '203'), ($2, 'Phòng 305')", [PHONG_1, PHONG_2]);
  await db.query("INSERT INTO public.contracts VALUES ($1, '2025-01-01')", [HOP_DONG_1]);
}
let soHoaDon = 700;
/** Hoá đơn tháng 01/2025 của phòng 203 + phiếu thu "Thu tiền theo HĐ …" gắn hoá đơn đó. */
async function hoaDonVaPhieu(h: {
  kind?: string | null; notes?: string | null; issue?: string; hopDong?: string | null;
  dong?: { type: string; tu?: string | null }[]; tenPhieu?: string; hanChe?: boolean;
}) {
  const hid = id(soHoaDon++);
  await db.query(
    `INSERT INTO public.invoices(id, billing_month, kind, issue_date, notes, contract_id, room_id)
     VALUES ($1, '2025-01', $2, $3, $4, $5, $6)`,
    [hid, h.kind ?? null, h.issue ?? "2025-01-02", h.notes ?? null, h.hopDong === undefined ? HOP_DONG_1 : h.hopDong, PHONG_1]);
  for (const d of h.dong ?? []) {
    await db.query("INSERT INTO public.invoice_items(invoice_id, type, from_date) VALUES ($1, $2, $3)", [hid, d.type, d.tu ?? null]);
  }
  const ma = `P${n + 1}`;
  await phieu({ loai: "INCOME", so: SO_CHU_NHA, thang: "2025-01-03", hoaDon: hid, phong: PHONG_1, hanChe: h.hanChe,
    ten: h.tenPhieu ?? `Thu tiền theo HĐ INV-2025-${soHoaDon}`, dong: [{ lop: "PNL", tien: 1_000 }] });
  return { hid, ma };
}
const phieuThang = async (m = "2025-01-01") =>
  settlementMonthSchema.parse(await thang(TOA_A, m)).statement!.vouchers;

describe("tên hiển thị phiếu (quyết toán + link chủ nhà)", () => {
  it("'Thu tiền theo HĐ <mã>' ⇒ tên hoá đơn có phòng; '… — HĐ <mã HĐ>' ⇒ '… — phòng <phòng>'; tên tự gõ giữ nguyên", async () => {
    const ten = await trongGiaoDich(async () => {
      await asPostgres();
      await phongVaHopDong();
      const dau = await hoaDonVaPhieu({ kind: "MONTHLY", dong: [{ type: "RENT", tu: "2025-01-01" }, { type: "SERVICE" }] });
      const tl = await hoaDonVaPhieu({ kind: "SETTLEMENT", issue: "2025-01-20", notes: "Thanh lý hợp đồng",
        tenPhieu: "Doanh thu bỏ cọc — HĐ HD-2025-0001" });
      const tuGo = await hoaDonVaPhieu({ kind: "MONTHLY", dong: [{ type: "RENT", tu: "2025-01-05" }], tenPhieu: "Tiền phòng anh Ba (chuyển khoản)" });
      const maPhong2 = `P${n + 1}`;
      await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-01-21", phong: PHONG_2, nguon: "termination.extra_receipt",
        ten: "Khách trả thêm khi thanh lý — HĐ HĐT-0002/2025", dong: [{ lop: "PNL", tien: 2_000 }] });
      const khongHoaDon = `P${n + 1}`;
      await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-01-22", ten: "Thu tiền theo HĐ INV-9999", dong: [{ lop: "PNL", tien: 3_000 }] });
      await asUser(CHU_A);
      const ds = await phieuThang();
      const theoMa = (ma: string) => settlementVoucherName(ds.find((v) => v.code === ma)!, "admin");
      return [theoMa(dau.ma), theoMa(tl.ma), theoMa(tuGo.ma), theoMa(maPhong2), theoMa(khongHoaDon)];
    });
    expect(ten).toEqual([
      "TIỀN PHÒNG THÁNG ĐẦU TIÊN - 203 - 01/2025",
      "Doanh thu bỏ cọc — phòng 203",
      "Tiền phòng anh Ba (chuyển khoản)",
      "Khách trả thêm khi thanh lý — Phòng 305",
      // không gắn hoá đơn ⇒ không có gì để dựng ⇒ giữ tên gốc
      "Thu tiền theo HĐ INV-9999",
    ]);
  });

  it("cờ dựng tên của server CHÉP ĐÚNG luật TS (invoiceTitlePartsOf / isFirstMonthInvoice) — từng biến thể ghi chú, loại, dòng", async () => {
    const MAU: Parameters<typeof hoaDonVaPhieu>[0][] = [
      { kind: "MONTHLY", dong: [{ type: "RENT", tu: "2025-01-01" }, { type: "SERVICE" }] },
      { kind: "MONTHLY", dong: [{ type: "RENT", tu: "2025-01-05" }, { type: "SERVICE" }] },
      { kind: "MONTHLY", notes: "HĐ THÁNG ĐẦU của hợp đồng", hopDong: null, dong: [{ type: "RENT", tu: "2025-01-05" }] },
      { kind: "MONTHLY", notes: "Tiền phòng đầu tiên", hopDong: null, dong: [{ type: "RENT" }] },
      { kind: "MONTHLY", notes: "ghi tháng_đầu", hopDong: null, dong: [{ type: "RENT" }] },
      { kind: "SETTLEMENT", notes: "  HOÁ ĐƠN THU THÊM khi khách bỏ cọc", issue: "2025-01-25" },
      { kind: "SETTLEMENT", notes: "Hoá đơn thu thêm", dong: [{ type: "PENALTY" }] },
      { kind: "MONTHLY", notes: "Hoá đơn tháng 1 + thu thêm 200.000đ", dong: [{ type: "SERVICE" }] },
      { kind: null, notes: "THANH LÝ hợp đồng sớm" },
      { kind: "SETTLEMENT", notes: null, dong: [{ type: "PENALTY" }] },
      { kind: "MONTHLY", notes: "abc", dong: [] },
      { kind: "MONTHLY", dong: [{ type: "RENT", tu: null }] },
      { kind: "MONTHLY", dong: [{ type: "PENALTY" }, { type: "RENT", tu: "2025-01-01" }, { type: "RENT", tu: "2024-12-01" }] },
    ];
    const [ketQua, nguon] = await trongGiaoDich(async () => {
      await asPostgres();
      await phongVaHopDong();
      const ma: string[] = [];
      for (const h of MAU) ma.push((await hoaDonVaPhieu(h)).ma);
      await asUser(CHU_A);
      const ds = await phieuThang();
      return [ma.map((m) => ds.find((v) => v.code === m)!), ma] as const;
    });
    expect(ketQua.length).toBe(MAU.length);
    ketQua.forEach((v: SettlementVoucher, i) => {
      const h = MAU[i]!;
      const banGhi = {
        kind: h.kind ?? null, notes: h.notes ?? null, billing_month: "2025-01", issue_date: h.issue ?? "2025-01-02",
        invoice_items: (h.dong ?? []).map((d) => ({ type: d.type, from_date: d.tu ?? null })),
        contract: h.hopDong === null ? null : { start_billing_date: "2025-01-01" },
      };
      expect(v.code).toBe(nguon[i]);
      expect(v.room_name).toBe("203");
      // từng cờ server tính trùng hàm TS trên cùng bản ghi
      expect({ i, ...invoicePartsOfSettlement(v.invoice!) }).toEqual({ i, ...invoiceTitlePartsOf(banGhi) });
      // và tên cuối cùng trùng tên trang Hoá đơn (getInvoiceTitle) với phòng, không toà
      expect(settlementVoucherName(v, "admin"))
        .toBe(getInvoiceTitle({ ...banGhi, room: { name: "203" } } as unknown as InvoiceWithRelations));
    });
    // đủ các nhánh tên
    expect(new Set(ketQua.map((v) => settlementVoucherName(v, "admin").split(" - ")[0]))).toEqual(new Set([
      "TIỀN PHÒNG THÁNG ĐẦU TIÊN", "TIỀN PHÒNG", "Hóa đơn thu thêm (thanh lý)", "Hóa đơn dịch vụ", "Hóa đơn thanh lý",
      "Hóa đơn", "Hóa đơn tiền nhà",
    ]));
  });

  it("link chủ nhà: có tên phòng + phần hoá đơn; phiếu HẠN CHẾ bỏ cả hai, tên vẫn bị che", async () => {
    const pub = await trongGiaoDich(async () => {
      await asPostgres();
      await phongVaHopDong();
      await hoaDonVaPhieu({ kind: "MONTHLY", dong: [{ type: "RENT", tu: "2025-01-05" }, { type: "SERVICE" }] });
      await hoaDonVaPhieu({ kind: "MONTHLY", dong: [{ type: "RENT", tu: "2025-01-05" }], hanChe: true });
      await asUser(CHU_A);
      const { token } = await rpc<{ token: string }>("public.landlord_share_link_create_v1($1, null)", [TOA_A]);
      await asUser(null);
      return rpc<Json>("public.landlord_settlement_public_v1($1, '2025-01-01'::date)", [token]);
    });
    const raw = ((pub.month as Json).statement as Json).vouchers as Json[];
    const coTen = raw.filter((v) => v.invoice);
    expect(coTen.length).toBe(1);
    expect(raw.filter((v) => v.restricted === true && ("invoice" in v || "room_name" in v))).toEqual([]);
    const ds = settlementPublicSchema.parse(pub).month.statement!.vouchers;
    expect(ds.map((v) => settlementVoucherName(v, "public"))).toContain("TIỀN PHÒNG - 203 - 01/2025");
    expect(ds.filter((v) => v.restricted).map((v) => settlementVoucherName(v, "public")))
      .toEqual(["Khoản hạn chế (ẩn chi tiết)", "Khoản hạn chế (ẩn chi tiết)"]);
  });

  it("phần dựng tên không vào source_hash: đổi tên phòng không làm tháng 'đổi sau khi chốt'", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await phongVaHopDong();
      await hoaDonVaPhieu({ kind: "MONTHLY", dong: [{ type: "RENT", tu: "2025-01-05" }, { type: "SERVICE" }] });
      await asUser(CHU_A);
      const h1 = String((await thang(TOA_A, "2025-01-01")).live_hash);
      await asPostgres();
      await db.query("UPDATE public.rooms SET name = '203A' WHERE id = $1", [PHONG_1]);
      await asUser(CHU_A);
      const sau = settlementMonthSchema.parse(await thang(TOA_A, "2025-01-01"));
      expect(sau.live_hash).toBe(h1);
      expect(sau.statement!.vouchers.map((v) => settlementVoucherName(v, "admin"))).toContain("TIỀN PHÒNG - 203A - 01/2025");
    });
  });
});

// ─────────────── 20261023142407 — v3: người giữ cọc, hạng mục, bàn giao, xác nhận của chủ nhà ───────────────

const UPSERT_GIU_COC = `public.landlord_operation_upsert_v1(p_building_id => $1, p_landlord_name => 'Chủ nhà A',
  p_manager_percent => 30, p_effective_from => '2025-01-01'::date, p_landlord_account_ids => $2::uuid[],
  p_opening_confirmed => true, p_terms_from => $3::date, p_opening_seen_pre_start => 700000,
  p_deposit_holder => $4::text)`;
/** Đổi người giữ cọc của toà A (giữ nguyên %, sổ, số dư đầu kỳ đã xác nhận) từ tháng `tu` (null = mặc định). */
const giuCoc = (holder: string | null, tu: string | null = null) => rpc<Json>(UPSERT_GIU_COC, [TOA_A, [SO_CHU_NHA], tu, holder]);
const tongCua = (m: Json) => (m.statement as Json).totals as Json;
async function chotCoGhiChu(m: string, ghiChu: string | null) {
  const x = await thang(TOA_A, m);
  return rpc<Json>("public.landlord_settlement_close_v1($1, $2::date, $3, $4)", [TOA_A, m, x.live_hash, ghiChu]);
}
const BAN_GIAO = "public.landlord_settlement_note_update_v1($1, $2::date, $3, $4)";
const XAC_NHAN = "public.landlord_settlement_confirm_v1($1, $2::date, $3, $4)";

describe("v3: migration", () => {
  it("thân production tái lập đúng md5 trước khi áp (cả hàm chỉ đọc được ghim)", () => {
    expect(md5GocV3).toEqual({ ...PROD_MD5_V3, [UPSERT_MOI]: "23c71a9ac1b280f436a092f0b4a36325" });
  });

  it("md5 lượt hai được tiền kiểm nhận đúng bằng thân của chính file", () => {
    const sql = readFileSync(FILE_V3, "utf8");
    for (const s of HAM_THAY_V3) {
      expect(md5LuotMotV3[s]).toMatch(/^[0-9a-f]{32}$/);
      expect(sql).toContain(`'${PROD_MD5_V3[s]}', '${md5LuotMotV3[s]}'`);
    }
    expect(sql).toContain(`IF v_md5 <> '${md5LuotMotV3[UPSERT_V3]}' THEN`);
  });

  it.each([
    ["hàm thay thân (công thức)", "CREATE OR REPLACE FUNCTION app_private.landlord_settlement_compute_v1(p_building_id uuid, p_month date) RETURNS jsonb LANGUAGE sql STABLE AS $x$ SELECT '{}'::jsonb $x$"],
    ["hàm chỉ đọc (chốt tháng)", "CREATE OR REPLACE FUNCTION public.landlord_settlement_close_v1(p_building_id uuid, p_month date, p_expected_hash text, p_note text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $x$ SELECT '{}'::jsonb $x$"],
  ])("thân lạ ở %s ⇒ dừng 55000", async (_ten, gia) => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await chay(gia);
      const block = readFileSync(FILE_V3, "utf8").replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
      await expect(db.exec(block)).rejects.toMatchObject({ code: "55000" });
    });
  });

  it("đúng MỘT chữ ký hàm ghi; toà có sẵn nhận MANAGER; quản lý giữ cọc băm y như trước (tháng đã chốt không 'đổi')", async () => {
    const r = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'landlord_operation_upsert_v1'");
    expect(r.rows[0].n).toBe(1);
    expect((await db.query("SELECT to_regprocedure($1) IS NOT NULL AS c", [UPSERT_V3])).rows[0]).toEqual({ c: true });
    const t = await db.query<{ h: string }>(
      "SELECT deposit_holder AS h FROM app_private.landlord_operations WHERE building_id = $1", [TOA_A]);
    expect(t.rows.map((x) => x.h)).toEqual(["MANAGER"]);
    // người giữ cọc là cài đặt của toà, không theo điều khoản tháng
    const cot = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid = 'app_private.landlord_operation_terms'::regclass
        AND attname = 'deposit_holder' AND NOT attisdropped`);
    expect(cot.rows[0].n).toBe(0);
    expect(hashSauV3).toEqual(hashTruoc);
  });

  it("CHECK cột người giữ cọc", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await expectLoi("UPDATE app_private.landlord_operations SET deposit_holder = 'KHACH' WHERE building_id = $1", [TOA_A], "23514");
    });
  });

  it("landlord_kqkd_lines_v2 = v1 TỪNG DÒNG (chỉ thêm hạng mục)", async () => {
    const q = (v: string) => db.query<{ k: string }>(
      `SELECT concat_ws('|', month, voucher_id, approval_status, side, amount) AS k
         FROM app_private.landlord_kqkd_lines_${v}($1, '2024-12-01'::date, '2025-03-01'::date) ORDER BY 1`, [TOA_A]);
    const [v1, v2] = [await q("v1"), await q("v2")];
    expect(v1.rows.length).toBeGreaterThan(10);
    expect(v2.rows).toEqual(v1.rows);
    const coHangMuc = await db.query<{ n: number }>(
      "SELECT count(*) FILTER (WHERE type_id IS NOT NULL)::int AS n FROM app_private.landlord_kqkd_lines_v2($1, '2025-01-01'::date, '2025-01-01'::date)", [TOA_A]);
    expect(coHangMuc.rows[0].n).toBeGreaterThan(0);
  });
});

describe("v3: người giữ cọc", () => {
  it("mặc định quản lý giữ cọc: phần cọc = cọc ở sổ chủ nhà, số bàn giao y như cũ", async () => {
    const m = await trongGiaoDich(async () => { await asUser(CHU_A); return thang(TOA_A, "2025-01-01"); });
    const st = m.statement as Json;
    const t = st.totals as Json;
    expect(st.deposit_holder).toBe("MANAGER");
    expect(so(t.manager_held_deposits)).toBe(1_750_000);
    expect(so(t.deposit_adjustment)).toBe(805_000);
    expect(so(t.landlord_owes_manager)).toBe(4_096_000);
    // mỗi sổ đang giữ từ thu chi lãi lỗ: chủ nhà 10tr − 500k; quản lý 1,55tr − 2,18tr (âm = ứng tiền chi hộ)
    expect([so(t.landlord_net_held), so(t.manager_net_held)]).toEqual([9_500_000, -630_000]);
    expect(so((st.pending as Json).deposit)).toBe(so((st.pending as Json).landlord_deposit));
  });

  it("chủ nhà giữ cọc: TRỪ cọc ở sổ quản lý; bảo toàn tiền; chuỗi băm đổi; tổng quyết toán và hộp cài đặt theo", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const h1 = String((await thang(TOA_A, "2025-01-01")).live_hash);
      const hFeb = String((await thang(TOA_A, "2025-02-01")).live_hash);
      // người giữ cọc là cài đặt của toà ⇒ không sinh mốc điều khoản mới
      expect((await giuCoc("LANDLORD")).terms_from).toBeNull();
      const m = await thang(TOA_A, "2025-01-01");
      const t = tongCua(m);
      expect((m.statement as Json).deposit_holder).toBe("LANDLORD");
      // tháng 02 không có dòng cọc nào: chuỗi băm vẫn phải đổi theo điều khoản (người giữ cọc)
      expect((await thang(TOA_A, "2025-02-01")).live_hash).not.toBe(hFeb);
      // cọc ở sổ quản lý: thu 3tr − hoàn 850k − cấn 400k = 1,75tr ⇒ quản lý bàn giao cho chủ nhà
      expect(so(t.deposit_adjustment)).toBe(-1_750_000);
      expect(so(t.landlord_owes_manager)).toBe(2_661_000 + 2_180_000 - 1_550_000 - 1_750_000);
      // bảo toàn: phần quản lý − (quản lý đang giữ: thu − chi + cọc) + tiền thối ở sổ chủ nhà = số chủ nhà trả
      expect(so(t.manager_share) - (so(t.manager_collected) - so(t.manager_paid) + so(t.manager_held_deposits))
        + so(t.landlord_extra_cash)).toBe(so(t.landlord_owes_manager));
      expect(m.live_hash).not.toBe(h1);
      // lãi lỗ không đổi theo người giữ cọc
      expect([so(t.profit), so(t.manager_share), so(t.landlord_share)]).toEqual([8_870_000, 2_661_000, 6_209_000]);

      const ov = await rpc<Json>("public.landlord_settlement_overview_v1($1)", [TOA_A]);
      expect(ov.deposit_holder).toBe("LANDLORD");
      const jan = (ov.months as Json[])[0];
      expect([jan.deposit_holder, so(jan.deposit_adjustment), so(jan.landlord_owes_manager)])
        .toEqual(["LANDLORD", -1_750_000, 1_541_000]);
      expect([so(jan.manager_paid), so(jan.manager_collected), so(jan.extra_cash)]).toEqual([2_180_000, 1_550_000, 0]);
      const opt = await rpc<Json>("public.landlord_operation_options_v1($1)", [TOA_A]);
      expect((opt.current as Json).deposit_holder).toBe("LANDLORD");
      expect(((opt.current as Json).terms as Json[]).every((x) => !("deposit_holder" in x))).toBe(true);
      // sổ thay đổi ghi được việc đổi người giữ cọc (ảnh = to_jsonb(dòng toà))
      const ls = (opt.history as Json[])[0];
      expect([(ls.before as Json).deposit_holder, (ls.after as Json).deposit_holder]).toEqual(["MANAGER", "LANDLORD"]);
      // về lại quản lý giữ cọc ⇒ đúng chuỗi băm cũ
      await giuCoc("MANAGER");
      expect((await thang(TOA_A, "2025-01-01")).live_hash).toBe(h1);
    });
  });

  it("cài đặt của TOÀ: chưa chốt tháng nào ⇒ đổi được, áp MỌI tháng; đã chốt một tháng ⇒ 55000 (đổi giữa chừng cọc đang giữ không tự bàn giao); NULL giữ nguyên; giá trị lạ ⇒ 22023", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      // chưa chốt: đổi từ "tháng 03" cũng áp cho mọi tháng — không có mốc giữa chừng
      expect((await giuCoc("LANDLORD", "2025-03-01")).terms_from).toBeNull();
      for (const m of ["2025-01-01", "2025-02-01", "2025-03-01"]) {
        expect((await thang(TOA_A, m)).statement).toMatchObject({ deposit_holder: "LANDLORD" });
      }
      expect((await giuCoc("MANAGER")).terms_from).toBeNull();
      // đổi người giữ cọc ⇒ phải đối chiếu lại số dư đầu kỳ: lưu lại (không đổi gì) với đúng gợi ý đã thấy
      expect((await giuCoc("MANAGER")).opening_needs_confirm).toBe(false);
      expect((await chot("2025-02-01")).status).toBe("CLOSED");
      // đã chốt một tháng: cả hai chiều, từ tháng nào cũng bị chặn; tháng đã chốt giữ nguyên số
      await expectLoi(`SELECT ${UPSERT_GIU_COC}`, [TOA_A, [SO_CHU_NHA], null, "LANDLORD"], "55000");
      await expectLoi(`SELECT ${UPSERT_GIU_COC}`, [TOA_A, [SO_CHU_NHA], "2025-03-01", "LANDLORD"], "55000");
      const feb = await thang(TOA_A, "2025-02-01");
      expect([feb.status, feb.is_stale, (feb.statement as Json).deposit_holder]).toEqual(["CLOSED", false, "MANAGER"]);
      // gửi lại đúng người giữ cọc đang có hoặc NULL thì vẫn lưu được các trường khác
      expect((await giuCoc("MANAGER")).terms_from).toBeNull();
      expect((await giuCoc(null)).terms_from).toBeNull();
      await expectLoi(`SELECT ${UPSERT_GIU_COC}`, [TOA_A, [SO_CHU_NHA], null, "KHACH"], "22023");
      // mở chốt hết thì đổi lại được
      await rpc("public.landlord_settlement_reopen_v1($1, '2025-02-01'::date, 'đổi người giữ cọc của toà')", [TOA_A]);
      await giuCoc("LANDLORD");
      expect((await thang(TOA_A, "2025-02-01")).statement).toMatchObject({ deposit_holder: "LANDLORD" });
    });
  });

  it("gợi ý số dư đầu kỳ theo người giữ cọc: quản lý giữ ⇒ + cọc trước kỳ ở sổ chủ nhà; chủ nhà giữ ⇒ − cọc trước kỳ ở sổ quản lý; đổi thì xác nhận cũ hết hiệu lực", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      // trước tháng áp dụng: khách nộp cọc 300k vào sổ quản lý (ngoài 700k ở sổ chủ nhà của fixture)
      await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2024-12-22", dong: [{ lop: "DEPOSIT", tien: 300_000 }] });
      await asUser(CHU_A);
      const truoc = (await rpc<Json>("public.landlord_operation_options_v1($1)", [TOA_A])).current as Json;
      expect([so(truoc.pre_start_landlord_deposits), truoc.opening_confirmation_stale]).toEqual([700_000, false]);
      // đổi sang chủ nhà giữ cọc (gửi kèm số cũ 700k đã thấy ⇒ server KHÔNG nhận xác nhận cho số chưa từng thấy)
      expect((await giuCoc("LANDLORD")).opening_needs_reconfirm).toBe(true);
      const sau = (await rpc<Json>("public.landlord_operation_options_v1($1)", [TOA_A])).current as Json;
      expect([so(sau.pre_start_landlord_deposits), sau.opening_confirmed_at]).toEqual([-300_000, null]);
      expect((await thang(TOA_A, "2025-02-01")).close_blockers).toContain("OPENING_UNCONFIRMED");
      // đối chiếu đúng số mới (−300k) thì xác nhận lại được, hết chặn
      const xn = await rpc<Json>(
        `public.landlord_operation_upsert_v1(p_building_id => $1, p_landlord_name => 'Chủ nhà A', p_manager_percent => 30,
          p_effective_from => '2025-01-01'::date, p_landlord_account_ids => $2::uuid[], p_opening_balance => -300000,
          p_opening_confirmed => true, p_opening_seen_pre_start => -300000)`, [TOA_A, [SO_CHU_NHA]]);
      expect([xn.opening_needs_reconfirm, xn.opening_needs_confirm]).toEqual([false, false]);
      expect((await thang(TOA_A, "2025-02-01")).close_blockers).not.toContain("OPENING_UNCONFIRMED");
    });
  });

  it("đổi người giữ cọc luôn bỏ xác nhận số dư đầu kỳ — kể cả khi gợi ý ở hai chế độ trùng số (cả hai 0), gọi RPC thẳng", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      // bỏ cọc trước kỳ 700k ở sổ chủ nhà ⇒ gợi ý = 0 ở CẢ hai chế độ
      await db.query("UPDATE public.income_expenses SET deleted_at = now() WHERE building_id = $1 AND voucher_date < '2025-01-01'", [TOA_A]);
      await asUser(CHU_A);
      const UPSERT_SO_DU = `public.landlord_operation_upsert_v1(p_building_id => $1, p_landlord_name => 'Chủ nhà A', p_manager_percent => 30,
        p_effective_from => '2025-01-01'::date, p_landlord_account_ids => $2::uuid[], p_opening_balance => 500000,
        p_opening_confirmed => true, p_opening_seen_pre_start => 0, p_deposit_holder => $3::text)`;
      // xác nhận số dư 500k ở chế độ quản lý giữ cọc
      expect((await rpc<Json>(UPSERT_SO_DU, [TOA_A, [SO_CHU_NHA], "MANAGER"])).opening_needs_confirm).toBe(false);
      // đổi người giữ cọc, vẫn gửi "đã đối chiếu" + đúng gợi ý 0 ⇒ server KHÔNG giữ / cấp xác nhận
      const doi = await rpc<Json>(UPSERT_SO_DU, [TOA_A, [SO_CHU_NHA], "LANDLORD"]);
      expect([doi.opening_needs_reconfirm, doi.opening_needs_confirm]).toEqual([true, true]);
      expect(((await rpc<Json>("public.landlord_operation_options_v1($1)", [TOA_A])).current as Json).opening_confirmed_at).toBeNull();
      // đối chiếu lại (không đổi gì nữa) thì nhận
      expect((await rpc<Json>(UPSERT_SO_DU, [TOA_A, [SO_CHU_NHA], "LANDLORD"])).opening_needs_confirm).toBe(false);
    });
  });

  it("cọc CHỜ DUYỆT chặn chốt theo bên sổ có tính: quản lý giữ ⇒ sổ chủ nhà; chủ nhà giữ ⇒ sổ quản lý", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await phieu({ loai: "INCOME", so: SO_QUAN_LY, thang: "2025-02-10", trangThai: "UNAPPROVED", dong: [{ lop: "DEPOSIT", tien: 500_000 }] });
      await asUser(CHU_A);
      const quanLy = await thang(TOA_A, "2025-02-01");
      expect((quanLy.statement as Json).pending).toMatchObject({ voucher_count: 0, deposit: 0 });
      expect(quanLy.can_close).toBe(true);
      await giuCoc("LANDLORD");
      const chuNha = await thang(TOA_A, "2025-02-01");
      expect((chuNha.statement as Json).pending).toMatchObject({ voucher_count: 1, deposit: 500_000, landlord_deposit: 0 });
      expect(chuNha.close_blockers).toContain("PENDING_VOUCHERS");
      await expectLoi("SELECT public.landlord_settlement_close_v1($1, '2025-02-01'::date, $2, null)", [TOA_A, chuNha.live_hash], "55000");
    });
  });
});

describe("v3: hạng mục thu chi", () => {
  it("cộng đúng doanh thu / chi phí và phần từng sổ; chi tiết từng phiếu cộng đúng số tiền phiếu", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      const hai = await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-01-21", dong: [{ lop: "PNL", tien: 300_000 }] });
      await db.query(
        "INSERT INTO public.income_expense_items(income_expense_id, amount, accounting_class, income_expense_type_id) VALUES ($1, 50000, 'PNL', $2)",
        [hai, LOAI_DIEN]);
      await db.query("UPDATE public.income_expense_items SET income_expense_type_id = $2 WHERE income_expense_id = $1 AND amount = 300000", [hai, LOAI_TU_LANH]);
      await db.query("UPDATE public.income_expenses SET total_amount = 350000 WHERE id = $1", [hai]);
      await asUser(CHU_A);
      const st = (await thang(TOA_A, "2025-01-01")).statement as Json;
      const t = st.totals as Json;
      const hm = st.categories as { income: Json[]; expense: Json[] };
      const cong = (xs: Json[], k: string) => xs.reduce((s, x) => s + so(x[k]), 0);
      expect(cong(hm.income, "amount")).toBe(so(t.revenue));
      expect(cong(hm.income, "landlord_amount")).toBe(so(t.landlord_collected));
      expect(cong(hm.income, "manager_amount")).toBe(so(t.manager_collected));
      expect(cong(hm.expense, "amount")).toBe(so(t.expense));
      expect(cong(hm.expense, "landlord_amount")).toBe(so(t.landlord_paid));
      expect(cong(hm.expense, "manager_amount")).toBe(so(t.manager_paid));
      // phiếu không có dòng hạng mục ⇒ "Khác"; xếp số tiền giảm dần
      expect(hm.income.map((x) => x.name)).toEqual(["Tiền phòng", "Khác"]);
      expect(hm.expense.find((x) => x.name === "Mua tủ lạnh")).toMatchObject({ amount: 300_000, manager_amount: 300_000, landlord_amount: 0, restricted: false });
      const v = (st.vouchers as Json[]).find((x) => x.id === hai)!;
      expect(v.lines).toEqual([{ category: "Mua tủ lạnh", amount: 300_000 }, { category: "Đóng tiền điện", amount: 50_000 }]);
      for (const x of (st.vouchers as Json[]).filter((y) => y.group === "PNL")) {
        expect(cong(x.lines as Json[], "amount")).toBe(so(x.amount));
      }
      expect((st.vouchers as Json[]).filter((y) => y.group !== "PNL").every((y) => y.lines === null)).toBe(true);
    });
  });

  it("link chủ nhà: hạng mục HẠN CHẾ gộp 'Khoản hạn chế', phiếu hạn chế không có chi tiết; ảnh chốt cũ (chưa có trường v3) vẫn đọc được", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await db.query("UPDATE public.income_expense_types SET is_restricted = true WHERE id = $1", [LOAI_TU_LANH]);
      await phieu({ loai: "EXPENSE", so: SO_QUAN_LY, thang: "2025-01-22", hanChe: true, loaiHangMuc: LOAI_TU_LANH, ten: "Thưởng riêng",
        dong: [{ lop: "PNL", tien: 400_000 }] });
      await asUser(CHU_A);
      const admin = (await thang(TOA_A, "2025-01-01")).statement as Json;
      expect(((admin.categories as Json).expense as Json[]).find((x) => x.name === "Mua tủ lạnh")).toMatchObject({ restricted: true, amount: 400_000 });
      const { token } = await rpc<{ token: string }>("public.landlord_share_link_create_v1($1, null)", [TOA_A]);
      expect((await chot("2025-02-01")).status).toBe("CLOSED");
      await asPostgres();
      // ảnh chốt trước v3: không có hạng mục, người giữ cọc, phần cọc
      await db.query(
        `UPDATE app_private.landlord_settlement_closes
            SET snapshot = (snapshot - 'categories' - 'deposit_holder') #- '{totals,deposit_adjustment}' #- '{totals,manager_held_deposits}'
          WHERE building_id = $1 AND period_month = '2025-02-01'`, [TOA_A]);
      await asUser(null);
      const pub = (await rpc<Json>("public.landlord_settlement_public_v1($1, '2025-01-01'::date)", [token])).month as Json;
      const st = pub.statement as Json;
      const chi = (st.categories as Json).expense as Json[];
      expect(chi.map((x) => x.name)).not.toContain("Mua tủ lạnh");
      expect(chi.find((x) => x.name === "Khoản hạn chế")).toEqual({ name: "Khoản hạn chế", amount: 400_000, landlord_amount: 0, manager_amount: 400_000 });
      expect([...chi, ...((st.categories as Json).income as Json[])].every((x) => !("restricted" in x))).toBe(true);
      const hanChe = (st.vouchers as Json[]).filter((v) => v.restricted);
      expect(hanChe.length).toBeGreaterThan(0);
      expect(hanChe.every((v) => !("lines" in v))).toBe(true);
      const cu = await rpc<Json>("public.landlord_settlement_public_v1($1, '2025-02-01'::date)", [token]);
      expect("categories" in ((cu.month as Json).statement as Json)).toBe(false);
      const feb = ((cu.overview as Json).months as Json[]).find((x) => String(x.period_month).startsWith("2025-02"))!;
      expect([feb.deposit_holder, so(feb.deposit_adjustment), so(feb.manager_fixed_share), so(feb.manager_percent_share)])
        .toEqual(["MANAGER", 0, 0, so(feb.manager_share)]);
    });
  });
});

describe("v3: ghi chú bàn giao", () => {
  it("tháng mở ⇒ 55000; đã chốt: sửa được, y nguyên ⇒ UNCHANGED, hiện ở gói tháng và link chủ nhà; lần chốt cũ ⇒ 40001; quyền", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await expectLoi(`SELECT ${BAN_GIAO}`, [TOA_A, "2025-01-01", 1, "x"], "55000");
      expect(await chotCoGhiChu("2025-02-01", "ghi chú lúc chốt")).toEqual({ status: "CLOSED", revision: 1 });
      expect((await thang(TOA_A, "2025-02-01")).closed).toMatchObject({ note: "ghi chú lúc chốt", note_updated_at: null });
      const sua = await rpc<Json>(BAN_GIAO, [TOA_A, "2025-02-01", 1, "  P.103 chuyển khoản vào TK quản lý  "]);
      expect([sua.status, sua.revision]).toEqual(["UPDATED", 1]);
      const sau = (await thang(TOA_A, "2025-02-01")).closed as Json;
      expect(sau.note).toBe("P.103 chuyển khoản vào TK quản lý");
      expect(sau.note_updated_at).not.toBeNull();
      expect((await rpc<Json>(BAN_GIAO, [TOA_A, "2025-02-01", 1, "P.103 chuyển khoản vào TK quản lý"])).status).toBe("UNCHANGED");
      const { token } = await rpc<{ token: string }>("public.landlord_share_link_create_v1($1, null)", [TOA_A]);
      await expectLoi(`SELECT ${BAN_GIAO}`, [TOA_A, "2025-02-01", 1, "x".repeat(1001)], "22023");
      await asUser(NHAN_VIEN_A);
      await expectLoi(`SELECT ${BAN_GIAO}`, [TOA_A, "2025-02-01", 1, "nhân viên sửa"], "42501");
      await asUser(null);
      await expectLoi(`SELECT ${BAN_GIAO}`, [TOA_A, "2025-02-01", 1, "người ngoài sửa"], "42501");
      const pub = await rpc<Json>("public.landlord_settlement_public_v1($1, '2025-02-01'::date)", [token]);
      expect((pub.month as Json).closed).toMatchObject({ note: "P.103 chuyển khoản vào TK quản lý", closed_by_name: null });

      await asUser(CHU_A);
      expect((await rpc<Json>(BAN_GIAO, [TOA_A, "2025-02-01", 1, "   "])).status).toBe("UPDATED");
      expect(((await thang(TOA_A, "2025-02-01")).closed as Json).note).toBeNull();
      await rpc("public.landlord_settlement_reopen_v1($1, '2025-02-01'::date, 'sửa phiếu chi tháng 2')", [TOA_A]);
      await expectLoi(`SELECT ${BAN_GIAO}`, [TOA_A, "2025-02-01", 1, "lần chốt cũ"], "40001");
      await expectLoi(`SELECT ${BAN_GIAO}`, [TOA_A, "2025-02-01", 2, "đang mở"], "55000");
      expect((await chotCoGhiChu("2025-02-01", "chốt lại")).revision).toBe(3);
      // lần chốt mới bắt đầu từ ghi chú lúc chốt lại, không mang bản sửa của lần trước
      expect((await thang(TOA_A, "2025-02-01")).closed).toMatchObject({ revision: 3, note: "chốt lại", note_updated_at: null });
    });
  });
});

describe("v3: chủ nhà xác nhận đã xem số liệu", () => {
  it("anon qua token, đúng lần chốt; bấm lại ⇒ ALREADY_CONFIRMED; mở chốt / chốt lại ⇒ phải xác nhận lại; link thu hồi ⇒ P0002", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      const { token } = await rpc<{ token: string }>("public.landlord_share_link_create_v1($1, 'Zalo')", [TOA_A]);
      expect((await chot("2025-02-01")).revision).toBe(1);

      await asUser(null);
      await expectLoi(`SELECT ${XAC_NHAN}`, [token, "2025-01-01", 1, null], "55000");
      await expectLoi(`SELECT ${XAC_NHAN}`, [token, "2025-02-01", 2, null], "40001");
      await expectLoi(`SELECT ${XAC_NHAN}`, ["khong-phai-token-0123456789abcdefgh", "2025-02-01", 1, null], "P0002");
      await expectLoi(`SELECT ${XAC_NHAN}`, ["sai", "2025-02-01", 1, null], "P0002");
      await expectLoi(`SELECT ${XAC_NHAN}`, [token, "2025-02-01", 1, "x".repeat(501)], "22023");
      const x1 = await rpc<Json>(XAC_NHAN, [token, "2025-02-01", 1, "  Số liệu khớp sổ của tôi  "]);
      expect(x1.status).toBe("CONFIRMED");
      const x2 = await rpc<Json>(XAC_NHAN, [token, "2025-02-01", 1, "bấm lần hai"]);
      expect(x2).toEqual({ status: "ALREADY_CONFIRMED", confirmed_at: x1.confirmed_at });
      // anon không đọc/ghi thẳng bảng
      await expectLoi("SELECT * FROM app_private.landlord_settlement_confirmations", [], "42501");
      const pub = await rpc<Json>("public.landlord_settlement_public_v1($1, '2025-02-01'::date)", [token]);
      expect((pub.month as Json).confirmation).toEqual({ confirmed_at: x1.confirmed_at, note: "Số liệu khớp sổ của tôi" });
      const febPub = ((pub.overview as Json).months as Json[]).find((m) => String(m.period_month).startsWith("2025-02"))!;
      expect([febPub.close_revision, febPub.confirmed_at]).toEqual([1, x1.confirmed_at]);

      await asUser(CHU_A);
      expect((await thang(TOA_A, "2025-02-01")).confirmation).toMatchObject({ note: "Số liệu khớp sổ của tôi" });
      expect((await thang(TOA_A, "2025-01-01")).confirmation).toBeNull();
      await rpc("public.landlord_settlement_reopen_v1($1, '2025-02-01'::date, 'chủ nhà báo sai một phiếu')", [TOA_A]);
      const mo = await thang(TOA_A, "2025-02-01");
      expect([mo.status, mo.confirmation]).toEqual(["OPEN", null]);
      const ov = await rpc<Json>("public.landlord_settlement_overview_v1($1)", [TOA_A]);
      const febMo = (ov.months as Json[]).find((m) => String(m.period_month).startsWith("2025-02"))!;
      expect([febMo.close_revision, febMo.confirmed_at]).toEqual([null, null]);
      await asUser(null);
      await expectLoi(`SELECT ${XAC_NHAN}`, [token, "2025-02-01", 1, null], "40001");
      await expectLoi(`SELECT ${XAC_NHAN}`, [token, "2025-02-01", 2, null], "55000");

      await asUser(CHU_A);
      expect((await chot("2025-02-01")).revision).toBe(3);
      expect((await thang(TOA_A, "2025-02-01")).confirmation).toBeNull();
      await asUser(null);
      expect((await rpc<Json>(XAC_NHAN, [token, "2025-02-01", 3, null])).status).toBe("CONFIRMED");
      await asUser(CHU_A);
      expect((await thang(TOA_A, "2025-02-01")).confirmation).toMatchObject({ note: null });
      await rpc("public.landlord_share_link_revoke_v1($1)", [token]);
      await asUser(null);
      await expectLoi(`SELECT ${XAC_NHAN}`, [token, "2025-02-01", 3, null], "P0002");
    });
  });
});

describe("v3: gói RPC thật parse được bằng schema zod của web", () => {
  it("tháng (admin + link chủ nhà), tổng quyết toán, hộp cài đặt, biên nhận ghi chú / xác nhận — chủ nhà giữ cọc", async () => {
    await trongGiaoDich(async () => {
      await asUser(CHU_A);
      await giuCoc("LANDLORD", "2025-03-01");
      const { token } = await rpc<{ token: string }>("public.landlord_share_link_create_v1($1, null)", [TOA_A]);
      await chotCoGhiChu("2025-02-01", "ghi chú lúc chốt");
      const ghiChu = noteUpdateReceiptSchema.parse(await rpc(BAN_GIAO, [TOA_A, "2025-02-01", 1, "bàn giao tháng 2"]));
      expect(ghiChu.status).toBe("UPDATED");
      await asUser(null);
      const xn = confirmReceiptSchema.parse(await rpc(XAC_NHAN, [token, "2025-02-01", 1, "đã xem"]));
      expect(xn.status).toBe("CONFIRMED");
      const pub = settlementPublicSchema.parse(await rpc("public.landlord_settlement_public_v1($1, '2025-02-01'::date)", [token]));
      expect(pub.month.confirmation?.note).toBe("đã xem");
      expect(pub.month.closed?.note).toBe("bàn giao tháng 2");
      expect(pub.month.statement?.categories?.income.length).toBeGreaterThan(0);
      expect(pub.overview.months.find((m) => m.period_month.startsWith("2025-02"))?.confirmed_at).toBe(xn.confirmed_at);

      await asUser(CHU_A);
      const mar = settlementMonthSchema.parse(await thang(TOA_A, "2025-03-01"));
      expect(mar.statement?.deposit_holder).toBe("LANDLORD");
      expect(mar.statement?.totals.landlord_net_held).not.toBeNull();
      const jan = settlementMonthSchema.parse(await thang(TOA_A, "2025-01-01"));
      expect(jan.statement?.vouchers.filter((v) => v.group === "PNL").every((v) => (v.lines?.length ?? 0) > 0)).toBe(true);
      const ov = settlementOverviewSchema.parse(await rpc("public.landlord_settlement_overview_v1($1)", [TOA_A]));
      expect(ov.deposit_holder).toBe("LANDLORD");
      const opt = landlordOperationOptionsSchema.parse(await rpc("public.landlord_operation_options_v1($1)", [TOA_A]));
      expect(opt.current?.deposit_holder).toBe("LANDLORD");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 20261024035114 — thẻ Khoản thu hiện đủ phòng như Báo cáo LN (chủ nhắn 24/10/2026: "paris 2 chưa đóng tiền mà
// không thấy hiện"). Phòng / HĐ / hoá đơn giả, toà A tháng 01/2025.
// ─────────────────────────────────────────────────────────────────────────────
const [P_NO, P_DU, P_CHUA_HD, P_TRONG, P_BAO_TRI, P_XOA, P_CHUYEN, P_TOA_B] = [61, 62, 63, 64, 65, 66, 67, 68].map(id);
const [H_NO, H_DU, H_CHUA_HD, H_TRONG, H_XOA, H_CHUYEN, H_TOA_B] = [71, 72, 73, 74, 75, 76, 77].map(id);
const FIXTURE_IDS = [P_NO, P_DU, P_CHUA_HD, P_TRONG, P_BAO_TRI, P_XOA, P_CHUYEN, P_TOA_B,
  H_NO, H_DU, H_CHUA_HD, H_TRONG, H_XOA, H_CHUYEN, H_TOA_B];

/** Toà A: PARIS 2 nợ (quá hạn), 101 đã đóng, G1 chưa có hoá đơn, MB trống (thanh lý), 205 bảo trì, 999 đã xoá,
 *  L2 trống (chuyển phòng) + một phòng của toà B. Kèm các dòng PHẢI bị lọc (huỷ, xoá, kỳ khác, chưa duyệt). */
async function phongThangMot() {
  await db.query(`INSERT INTO public.rooms(id, name, building_id, status, deleted_at) VALUES
    ($1,'PARIS 2',$9,'OCCUPIED',null), ($2,'101',$9,'OCCUPIED',null), ($3,'G1',$9,'OCCUPIED',null),
    ($4,'MB',$9,'AVAILABLE',null), ($5,'205',$9,'MAINTENANCE',null), ($6,'999',$9,'AVAILABLE',now()),
    ($7,'L2',$9,'AVAILABLE',null), ($8,'B-1',$10,'OCCUPIED',null)`,
    [P_NO, P_DU, P_CHUA_HD, P_TRONG, P_BAO_TRI, P_XOA, P_CHUYEN, P_TOA_B, TOA_A, TOA_B]);
  await db.query(`INSERT INTO public.contracts(id, room_id, status, start_date, start_billing_date, end_date,
      actual_end_date, contract_number, deleted_at) VALUES
    ($1,$8,'ACTIVE','2024-06-01','2024-06-01','2025-06-01',null,'HD-GIA-1',null),
    ($2,$9,'ACTIVE','2024-06-01',null,'2025-06-01',null,'HD-GIA-2',null),
    ($3,$10,'ACTIVE','2024-09-01',null,null,null,'HD-GIA-3',null),
    ($4,$11,'TERMINATED','2024-03-01',null,'2025-03-01','2024-12-15','HD-GIA-4',null),
    ($5,$11,'ACTIVE','2024-01-01',null,null,null,'HD-GIA-XOA',now()),
    ($6,$12,'TERMINATED','2024-03-01',null,'2025-03-01','2024-12-20','HD-GIA-6',null),
    ($7,$13,'ACTIVE','2024-03-01',null,null,null,'HD-GIA-B',null)`,
    [H_NO, H_DU, H_CHUA_HD, H_TRONG, H_XOA, H_CHUYEN, H_TOA_B, P_NO, P_DU, P_CHUA_HD, P_TRONG, P_CHUYEN, P_TOA_B]);
  await db.query(`INSERT INTO public.invoices(id, contract_id, billing_month, kind, status, total_amount, paid_amount,
      remaining_amount, due_date, deleted_at) VALUES
    ($1,$7,'2025-01','MONTHLY','OVERDUE',3500000,0,3500000,'2025-01-10',null),
    ($2,$8,'2025-01','MONTHLY','PAID',3000000,3000000,0,'2025-01-10',null),
    ($3,$9,'2025-01','MONTHLY','CANCELLED',2000000,2000000,0,null,null),
    ($4,$9,'2025-01','MONTHLY','PAID',2000000,2000000,0,null,now()),
    ($5,$9,'2025-02','MONTHLY','PAID',2000000,2000000,0,null,null),
    ($6,$10,'2025-01','MONTHLY','PAID',4000000,4000000,0,null,null)`,
    [id(81), id(82), id(83), id(84), id(85), id(86), H_NO, H_DU, H_CHUA_HD, H_TOA_B]);
  await db.query(`INSERT INTO public.contract_terminations(contract_id, termination_type, termination_date,
      actual_move_out_date, status) VALUES
    ($1,'EARLY','2024-12-15','2024-12-15','COMPLETED'), ($2,'EARLY','2024-12-01','2024-12-01','COMPLETED')`,
    [H_TRONG, H_TOA_B]);
  await db.query(`INSERT INTO public.contract_transfers(old_room_id, transfer_type, transfer_date, status) VALUES
    ($1,'ROOM_CHANGE','2024-12-20','COMPLETED'), ($1,'ROOM_CHANGE','2025-01-05','PENDING'),
    ($2,'ROOM_CHANGE','2024-12-20','COMPLETED')`, [P_CHUYEN, P_TOA_B]);
}

describe("dữ liệu phòng (20261024035114): migration", () => {
  it("thân production tái lập đúng md5 trước khi áp", () => {
    expect(md5GocPhong).toEqual(PROD_MD5_PHONG);
  });

  it("md5 lượt hai được tiền kiểm nhận đúng bằng thân của chính file", () => {
    const sql = readFileSync(FILE_PHONG, "utf8");
    expect(md5LuotMotPhong[GOI_THANG]).toMatch(/^[0-9a-f]{32}$/);
    expect(sql).toContain(`'${PROD_MD5_PHONG[GOI_THANG]}', '${md5LuotMotPhong[GOI_THANG]}'`);
    expect(sql).toContain(`IF v_md5 <> '${md5LuotMotPhong[DU_LIEU_PHONG]}' THEN`);
  });

  it.each([
    ["gói tháng", "CREATE OR REPLACE FUNCTION app_private.landlord_settlement_month_payload_v1(p_building_id uuid, p_month date, p_public boolean) RETURNS jsonb LANGUAGE sql STABLE AS $x$ SELECT '{}'::jsonb $x$"],
    ["hàm chỉ đọc (tháng admin)", "CREATE OR REPLACE FUNCTION public.landlord_settlement_month_v1(p_building_id uuid, p_month date) RETURNS jsonb LANGUAGE sql STABLE AS $x$ SELECT '{}'::jsonb $x$"],
    ["hàm dữ liệu phòng (lượt hai)", "CREATE OR REPLACE FUNCTION app_private.landlord_room_data_v1(p_building_id uuid, p_month date, p_public boolean) RETURNS jsonb LANGUAGE sql STABLE AS $x$ SELECT '{}'::jsonb $x$"],
  ])("thân lạ ở %s ⇒ dừng 55000", async (_ten, gia) => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await chay(gia);
      const block = readFileSync(FILE_PHONG, "utf8").replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
      await expect(db.exec(block)).rejects.toMatchObject({ code: "55000" });
    });
  });

  it("không đổi số (source_hash y như trước); hàm dữ liệu phòng không vai nào gọi thẳng được", async () => {
    expect(hashSauPhong).toEqual(hashTruoc);
    for (const vai of ["anon", "authenticated", "service_role"]) {
      const r = await db.query<{ c: boolean }>("SELECT has_function_privilege($1, $2, 'EXECUTE') AS c", [vai, DU_LIEU_PHONG]);
      expect(r.rows[0].c, vai).toBe(false);
    }
  });
});

describe("dữ liệu phòng (20261024035114): gói tháng", () => {
  it("chép bộ lọc của Báo cáo LN: phòng chưa xoá của toà, HĐ chưa xoá, hoá đơn kỳ chưa huỷ/xoá, chuyển phòng đã duyệt", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await phongThangMot();
      await asUser(CHU_A);
      const m = settlementMonthSchema.parse(await thang(TOA_A, "2025-01-01"));
      const d = m.room_data!;
      expect(d.rooms.map((r) => r.name).sort()).toEqual(["101", "205", "G1", "L2", "MB", "PARIS 2"]);
      expect(d.contracts.map((c) => c.contract_number).sort()).toEqual(["HD-GIA-1", "HD-GIA-2", "HD-GIA-3", "HD-GIA-4", "HD-GIA-6"]);
      expect(d.invoices.map((i) => [i.status, Number(i.total_amount)]).sort()).toEqual([["OVERDUE", 3_500_000], ["PAID", 3_000_000]]);
      expect(d.terminations).toHaveLength(1);
      expect(d.transfers.map((t) => t.status)).toEqual(["COMPLETED"]);
      // mã tạm khớp được phòng ↔ HĐ ↔ hoá đơn, không lộ id thật
      const roomIds = new Set(d.rooms.map((r) => r.id));
      expect(d.contracts.every((c) => c.room_id !== null && roomIds.has(c.room_id))).toBe(true);
      const contractIds = new Set(d.contracts.map((c) => c.id));
      expect(d.invoices.every((i) => contractIds.has(i.contract_id))).toBe(true);
      const json = JSON.stringify(d);
      for (const x of FIXTURE_IDS) expect(json).not.toContain(x);
      expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    });
  });

  it("link chủ nhà: cùng dữ liệu nhưng không có số HĐ; tháng chưa áp dụng ⇒ null", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await phongThangMot();
      await asUser(CHU_A);
      const { token } = await rpc<{ token: string }>("public.landlord_share_link_create_v1($1, null)", [TOA_A]);
      await asUser(null);
      const pub = settlementPublicSchema.parse(await rpc("public.landlord_settlement_public_v1($1, '2025-01-01'::date)", [token]));
      expect(pub.month.room_data?.rooms).toHaveLength(6);
      expect(pub.month.room_data?.contracts.every((c) => c.contract_number === null)).toBe(true);
      await asUser(CHU_A);
      const truoc = settlementMonthSchema.parse(await thang(TOA_A, "2024-12-01"));
      expect(truoc.status).toBe("NOT_APPLICABLE");
      expect(truoc.room_data).toBeNull();
    });
  });

  it("web dựng ghi chú như Báo cáo LN: PARIS 2 'Chưa đóng' (quá hạn), G1 chưa có hoá đơn, MB/L2 trống; 101 đã đóng và 205 bảo trì không ghi", async () => {
    await trongGiaoDich(async () => {
      await asPostgres();
      await phongThangMot();
      await asUser(CHU_A);
      const m = settlementMonthSchema.parse(await thang(TOA_A, "2025-01-01"));
      const thu = m.statement!.vouchers.filter((v) => v.type === "INCOME" && v.group === "PNL" && v.status === "APPROVED");
      const rows = settlementRoomNoteRows(m.room_data, m.period_month, thu, "2026-10-24");
      expect(Object.fromEntries(rows.map((r) => [r.roomName, r.label]))).toEqual({
        "PARIS 2": "Chưa đóng", G1: "Chưa đóng", MB: "Phòng trống", L2: "Phòng trống",
      });
      expect(rows.find((r) => r.roomName === "PARIS 2")?.text).toMatch(/^Có hoá đơn, chưa thu .* — quá hạn$/);
      expect(rows.find((r) => r.roomName === "G1")?.text).toBe("Chưa có hoá đơn tháng này");
      expect(rows.find((r) => r.roomName === "MB")?.text).toMatch(/^Trống \d+ ngày từ 15\/12\/2024/);
    });
  });
});
