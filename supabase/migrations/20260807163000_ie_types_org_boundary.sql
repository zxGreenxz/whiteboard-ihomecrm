-- =============================================================================
-- income_expense_types — RESTRICTIVE org boundary (chỗ Sprint 3b bỏ sót)
--
-- ÁN LỆ 07/08/2026 (phiên của Nathan, org "iHome CRM"): tạo Phiếu chi với hạng
-- mục "Vệ Sinh Phòng" chết 403 / ERRCODE 42501
--   "Loại hạng mục 1 không thuộc tổ chức hoặc sai chiều thu/chi"
-- Phiếu KHÔNG được tạo. Lỗi CHẬP CHỜN — cùng thao tác lúc được lúc không.
--
-- CHUỖI NGUYÊN NHÂN (đo trên prod, chỉ SELECT):
--   1. Hai tổ chức được seed cùng lúc 14/07 nên có hạng mục TRÙNG TÊN, trùng cả
--      created_at: "Vệ Sinh Phòng" tồn tại ở cả aaaa… và cccc….
--   2. Bảng này KHÔNG có lớp *_org_boundary. Policy SELECT duy nhất áp cho
--      authenticated là income_expense_types_select_rbac, USING chỉ hỏi
--      public.can_access_org_entity('categories','view') — mà hàm đó là
--      `is_super_admin() OR has_any_scope_v3('categories.view')`: capability
--      TOÀN CỤC, không hề so organization_id của row. ⇒ ai cũng đọc được hạng
--      mục của MỌI tổ chức.
--   3. Dropdown dedup theo tên, tie-break bằng created_at — hai row giống hệt
--      nên thứ tự do DB quyết định; phiên nào bốc phải id của org kia thì gãy.
--   4. create_income_expense_v1 (20260802210000, dòng ~1819) đòi type phải có
--      organization_id = org của caller ⇒ NOT FOUND ⇒ RAISE 42501. Server từ
--      chối ĐÚNG; cái sai nằm ở chỗ client nhìn thấy row lẽ ra không được thấy.
--
-- TẠI SAO SỬA Ở ĐÂY: 20260713121000_sprint3b_org_autofill_and_boundary.sql gắn
-- trigger trg_autofill_org + policy <t>_org_boundary cho 28 bảng tenant. Bảng
-- income_expense_types về sau ĐƯỢC gắn trigger (27/07, để hạng mục tạo tay có
-- organization_id) nhưng KHÔNG được gắn policy — nửa vời từ đó tới nay. File
-- này chỉ trả nốt nửa còn thiếu, dùng NGUYÊN công thức của Sprint 3b.
--
-- AN TOÀN:
--   • RESTRICTIVE = AND với policy sẵn có ⇒ CHỈ siết, không nới thêm cho ai.
--   • Không DROP/ALTER bất kỳ policy cũ nào (rbac, restricted, shareholder,
--     ie_canonical_writer_read) — chúng vẫn phải qua như trước.
--   • Escape organization_id IS NULL giữ đúng parity với 28 bảng kia (hiện đo
--     được 0/233 row NULL, nên cửa này không mở cho ai).
--   • Super admin bypass giữ nguyên như Sprint 3b.
--   • Role ie_canonical_writer KHÔNG nằm trong `TO authenticated` nên writer
--     server-side (create_income_expense_v1) không bị lớp này chạm vào.
--   • 6/6 cổ đông đang hoạt động đều là ACTIVE member của org họ ⇒ policy
--     income_expense_types_select_shareholder không bị lớp mới khoá chết.
--   • Idempotent (DROP IF EXISTS trước CREATE).
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- PREFLIGHT — không được khoá nhầm dữ liệu đang dùng.
-- Nếu có hạng mục đang được phiếu của MỘT org khác tham chiếu thì lớp boundary
-- sẽ làm phiếu đó mất hạng mục khi đọc; phải biết TRƯỚC chứ không phát hiện
-- bằng cách người dùng mở báo cáo thấy trống.
-- ─────────────────────────────────────────────────────────────────────
DO $preflight$
DECLARE
  v_cross bigint;
BEGIN
  SELECT count(*)
    INTO v_cross
    FROM public.income_expense_items i
    JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
   WHERE i.organization_id IS NOT NULL
     AND t.organization_id IS NOT NULL
     AND i.organization_id <> t.organization_id;

  IF v_cross > 0 THEN
    RAISE EXCEPTION
      'Có % dòng phiếu đang trỏ sang hạng mục của tổ chức khác — vá dữ liệu trước, đừng dựng tường lên trên. DỪNG.',
      v_cross;
  END IF;

  IF to_regclass('public.income_expense_types') IS NULL THEN
    RAISE EXCEPTION 'Không thấy bảng public.income_expense_types. DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- LỚP BOUNDARY — nguyên văn công thức Sprint 3b.
-- ─────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS income_expense_types_org_boundary ON public.income_expense_types;
CREATE POLICY income_expense_types_org_boundary ON public.income_expense_types
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK (organization_id IS NULL OR (SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));

COMMENT ON POLICY income_expense_types_org_boundary ON public.income_expense_types IS
  'Chốt tổ chức cho hạng mục thu/chi. Thiếu lớp này thì income_expense_types_select_rbac '
  '(chỉ hỏi capability toàn cục) cho đọc hạng mục của mọi org, dropdown bốc nhầm id và '
  'create_income_expense_v1 ném 42501 "Loại hạng mục % không thuộc tổ chức". Án lệ 07/08/2026.';

-- ─────────────────────────────────────────────────────────────────────
-- VERIFY — tường phải đúng loại tường, và không được ăn mất policy cũ.
-- ─────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_permissive boolean;
  v_cmd "char";
  v_missing text;
BEGIN
  SELECT polpermissive, polcmd
    INTO v_permissive, v_cmd
    FROM pg_policy
   WHERE polrelid = 'public.income_expense_types'::regclass
     AND polname = 'income_expense_types_org_boundary';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'income_expense_types_org_boundary không được tạo. DỪNG.';
  END IF;

  IF v_permissive THEN
    RAISE EXCEPTION 'Policy boundary ra PERMISSIVE — như vậy là NỚI quyền chứ không siết. DỪNG.';
  END IF;

  IF v_cmd <> '*' THEN
    RAISE EXCEPTION 'Policy boundary phải phủ FOR ALL, đang là %. DỪNG.', v_cmd;
  END IF;

  -- Bốn policy cũ phải còn nguyên; lớp mới là THÊM, không phải THAY.
  SELECT string_agg(want, ', ')
    INTO v_missing
    FROM unnest(ARRAY[
      'income_expense_types_select_rbac',
      'income_expense_types_restricted_select',
      'income_expense_types_select_shareholder',
      'ie_canonical_writer_read'
    ]) AS want
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policy
      WHERE polrelid = 'public.income_expense_types'::regclass
        AND polname = want
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Mất policy cũ: % — đã thay nhầm thay vì thêm. DỪNG.', v_missing;
  END IF;
END
$verify$;

COMMIT;

-- =============================================================================
-- ROLLBACK:
--   DROP POLICY IF EXISTS income_expense_types_org_boundary ON public.income_expense_types;
-- Bỏ lớp này = quay lại trạng thái rò cross-org của trước 07/08/2026.
-- =============================================================================
