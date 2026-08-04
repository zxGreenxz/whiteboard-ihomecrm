-- =====================================================================
-- CẢNH BÁO TRÙNG Ô cho form tạo phiếu chung (§12.6 của
-- docs/superpowers/plans/2026-07-30-danh-gia-2-plan-thu-tien-v2.md)
--
-- ĐÍNH CHÍNH PHẠM VI so với §12.6 (đo lại trên prod 30/07/2026 — đề xuất trong
-- plan đã LỖI THỜI vì hai đường đã bị bịt bởi việc khác trong cùng ngày):
--
--   (1) "Bấm đôi" KHÔNG còn tái diễn được. `create_income_expense_v1` và
--       `create_income_expense_v2` đều BẮT BUỘC idempotency key (v1 kiểm định
--       dạng 8–200 ký tự ASCII rồi claim vào app_private.canonical_write_operations
--       bằng ON CONFLICT — chính nó gọi đó là "linearization point"; v2 ném 22023
--       nếu thiếu `idempotencyKey`). Hai lần bấm cùng payload ⇒ lần sau trả lại
--       kết quả cũ, không sinh phiếu thứ hai.
--
--   (2) Đường POST THẲNG /rest/v1/income_expenses — thứ ĐÃ sinh ra cặp 66.000.000đ
--       ở 102LVT cách nhau 460 ms (idempotency_key NULL, system_source NULL,
--       tạo 07/06/2026) — nay ĐÃ BỊ REVOKE: `authenticated` KHÔNG còn
--       INSERT/UPDATE/DELETE trên `income_expenses` lẫn `income_expense_items`
--       (20260730102000_money_tables_revoke_dml.sql, 30/07 10:20).
--       ⇒ KHÔNG cần `CREATE UNIQUE INDEX` trên income_expenses.idempotency_key
--         như plan đề xuất: cột đó chỉ là bản sao phi chuẩn hoá (45/45 key phân
--         biệt), còn chốt thật nằm ở sổ canonical_write_operations và mạnh hơn.
--
--   (3) PHẦN CÒN HỞ THẬT — và là lý do duy nhất của file này: 3 trong 4 ô "cùng
--       số tiền" KHÔNG phải bấm đôi mà là HAI NGƯỜI cùng trả một tháng, cách
--       nhau NHIỀU NGÀY:
--            32PVC  07/2026  26.000.000 × 2  — cách ~13,9 giờ, 2 người
--            405PVB 07/2026  52.500.000 × 2  — cách ~8,4 ngày,  2 người
--            15KV   07/2026  20.000.000 × 2  — cách ~9,4 ngày,  2 người
--       Idempotency TUYỆT ĐỐI không cứu được: khác người, khác phiên, khác key,
--       cách nhau nhiều ngày — mỗi phiếu tự nó hợp lệ. Đây là lỗi PHỐI HỢP:
--       không ai biết đồng nghiệp đã trả rồi. Thuốc đúng là CHO NGƯỜI TA THẤY,
--       không phải chặn.
--
-- VÌ SAO KHÔNG CHẶN CỨNG: 20/24 ô trùng có SỐ TIỀN KHÁC NHAU và đều HỢP LỆ
-- (405PVB công an 07/2026 = 1.000.000đ + 7.000đ; 15KV rác 06/2026 = 300.000đ +
-- 120.000đ). Khoá cứng theo ô sẽ chặn oan 20/24 trường hợp. Nên file này CHỈ
-- THÊM MỘT HÀM ĐỌC — không trigger, không index, không đổi hàm ghi nào.
--
-- KHÔNG ĐỤNG TIỀN: file này chỉ CREATE một hàm SELECT. Không một câu
-- INSERT/UPDATE/DELETE nào.
-- =====================================================================
BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.income_expenses') IS NULL
     OR to_regclass('public.income_expense_items') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng phiếu thu chi. DỪNG.';
  END IF;
  -- Nếu ngày nào đó authenticated được cấp lại INSERT thẳng bảng thì cảnh báo
  -- mềm này KHÔNG còn đủ (đường bấm đôi mở lại) — bắt phải biết mà xử.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema='public' AND table_name='income_expenses'
       AND grantee='authenticated' AND privilege_type='INSERT'
  ) THEN
    RAISE EXCEPTION
      'authenticated lại INSERT được thẳng income_expenses — cảnh báo mềm KHÔNG đủ, '
      'đường bấm đôi đã mở lại. Xem lại 20260730102000_money_tables_revoke_dml.sql. DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- get_voucher_slot_warning_v1 — "ô này đã có phiếu nào chưa?"
--
-- Khoá ô = (toà, LOẠI phiếu, kỳ chồng lấn). Cố ý theo `income_expense_type_id`
-- chứ KHÔNG theo 9 hạng mục phí cố định: lỗi phối hợp xảy ra được với bất kỳ
-- khoản định kỳ nào, và form tạo phiếu chung không hề biết tới khái niệm
-- "hạng mục phí cố định".
--
-- ĐẾM CẢ 'UNAPPROVED': phiếu chờ duyệt là phiếu người khác KHÔNG THẤY trên các
-- bảng lọc APPROVED — đó chính là lý do người thứ hai tạo lại. Loại phiếu đã
-- huỷ (deleted_at, hoặc approval_status='CANCELLED') vì huỷ rồi thì tạo lại là đúng.
--
-- VOLATILE: thân hàm gọi can_access_building/ie_all_buildings_scope, mà nhánh
-- phân quyền trong repo này có thể lấy khoá dòng (FOR SHARE) ⇒ khai STABLE là ăn
-- 25006 khi gọi qua PostgREST. Án lệ đã cắn 5 lần, xem CLAUDE.md.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_voucher_slot_warning_v1(
  p_building_id uuid,
  p_type_ids    uuid[],
  p_start       date,
  p_end         date,
  p_type        text DEFAULT 'EXPENSE',
  p_exclude_id  uuid DEFAULT NULL          -- khi SỬA phiếu thì đừng tự cảnh báo chính nó
)
 RETURNS TABLE (
   voucher_id     uuid,
   code           text,
   voucher_name   text,
   total_amount   numeric,
   matched_amount numeric,
   voucher_date   date,
   approval_status text,
   created_at     timestamptz,
   creator_name   text,
   type_names     text,
   same_amount    boolean
 )
 LANGUAGE sql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH guard AS (
    -- Không có quyền trên toà ⇒ không trả gì. Cảnh báo là tiện ích, KHÔNG được
    -- thành kênh soi phiếu của toà mình không được xem.
    SELECT 1
      FROM buildings b
     WHERE b.id = p_building_id
       AND b.deleted_at IS NULL
       AND (public.can_access_building(b.id)
         OR public.ie_all_buildings_scope(b.id)
         OR b.user_id = auth.uid()
         OR public.is_admin() OR public.is_super_admin())
  ),
  hit AS (
    SELECT ie.id,
           ie.code,
           ie.name,
           ie.total_amount,
           SUM(it.amount)                          AS matched_amount,
           ie.voucher_date,
           ie.approval_status,
           ie.created_at,
           ie.user_id,
           string_agg(DISTINCT t.name, ', ' )      AS type_names
      FROM income_expense_items it
      JOIN income_expense_types t ON t.id = it.income_expense_type_id
      JOIN income_expenses ie ON ie.id = it.income_expense_id
     WHERE EXISTS (SELECT 1 FROM guard)
       AND ie.building_id = p_building_id
       AND ie.type = p_type
       AND ie.deleted_at IS NULL
       AND ie.approval_status <> 'CANCELLED'
       AND (p_exclude_id IS NULL OR ie.id <> p_exclude_id)
       AND it.income_expense_type_id = ANY(p_type_ids)
       -- Kỳ chồng lấn, chịu được item có start_date không phải ngày 1.
       AND it.start_date IS NOT NULL AND it.end_date IS NOT NULL
       AND it.start_date <= p_end AND it.end_date >= p_start
     GROUP BY ie.id, ie.code, ie.name, ie.total_amount, ie.voucher_date,
              ie.approval_status, ie.created_at, ie.user_id
  )
  SELECT h.id, h.code, h.name, h.total_amount, h.matched_amount, h.voucher_date,
         h.approval_status, h.created_at,
         COALESCE(NULLIF(btrim(p.full_name), ''), p.email, '(không rõ)'),
         h.type_names,
         false                                     -- FE tự so với số đang gõ
    FROM hit h
    LEFT JOIN profiles p ON p.id = h.user_id
   ORDER BY h.created_at DESC;
$function$;

REVOKE ALL ON FUNCTION public.get_voucher_slot_warning_v1(uuid,uuid[],date,date,text,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_voucher_slot_warning_v1(uuid,uuid[],date,date,text,uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_voucher_slot_warning_v1(uuid,uuid[],date,date,text,uuid) IS
  'Trả phiếu ĐÃ CÓ cùng (toà, loại phiếu, kỳ chồng lấn) để form tạo phiếu cảnh '
  'báo TRƯỚC khi người thứ hai tạo trùng. Đếm cả UNAPPROVED (phiếu chờ duyệt là '
  'phiếu người khác không thấy — chính là nguyên nhân tạo lại); loại phiếu đã '
  'huỷ. CHỈ CẢNH BÁO, không chặn: 20/24 ô trùng trên production có số tiền khác '
  'nhau và đều hợp lệ, chặn cứng là chặn oan 20/24. Lọc theo quyền toà nên không '
  'thành kênh soi phiếu toà khác. VOLATILE vì nhánh authz có thể lấy khoá dòng.';

DO $selfcheck$
BEGIN
  IF NOT has_function_privilege('authenticated',
        'public.get_voucher_slot_warning_v1(uuid,uuid[],date,date,text,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'authenticated không chạy được get_voucher_slot_warning_v1. DỪNG.';
  END IF;
  IF has_function_privilege('anon',
        'public.get_voucher_slot_warning_v1(uuid,uuid[],date,date,text,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'anon chạy được get_voucher_slot_warning_v1 — REVOKE. DỪNG.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='get_voucher_slot_warning_v1'
       AND p.provolatile <> 'v'
  ) THEN
    RAISE EXCEPTION 'get_voucher_slot_warning_v1 phải VOLATILE (án lệ 25006). DỪNG.';
  END IF;
END
$selfcheck$;

COMMIT;
