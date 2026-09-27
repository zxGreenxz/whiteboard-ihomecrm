-- =============================================================================
-- hoa_hong_quan_ly_so_ao — Hoa hồng của QUẢN LÝ trả qua lương, giữ ở sổ ảo.
-- Chủ chốt 27/09/2026:
--   · Phiếu hoa hồng mà người nhận là quản lý hưởng lương thì CHỌN quản lý ngay
--     trên phiếu (không đoán theo tên), và phiếu nằm ở SỔ ẢO "Hoa hồng QL chờ trả
--     lương" (1 sổ/công ty). Duyệt phiếu vẫn ghi đủ chi phí toà để chia lợi
--     nhuận, nhưng KHÔNG làm giảm sổ quỹ thật. Tiền chỉ ra MỘT lần, lúc trả lương.
--   · Màn lương hiện MỌI phiếu hoa hồng của quản lý trong tháng (đã duyệt hay
--     chưa). Chốt lương thì mỗi phiếu được đánh dấu thuộc ĐÚNG MỘT kỳ lương.
--   · Phiếu cũ đã duyệt trên sổ thật (TK939/TKHIEP/ATam… — tháng 6–8, đã chốt lợi
--     nhuận): phương án A — lương tính vào thu nhập nhưng KHÔNG cộng vào tiền
--     chuyển (đã chi từ sổ của phiếu). Phần đó xử lý ở client + số chốt.
-- =============================================================================
-- VÌ SAO
--   Đo 27/09/2026 (chỉ đọc):
--   · Lương nối phiếu với quản lý bằng CHỮ ở ô người nhận (payer_name so với
--     alias / chữ cuối họ tên — src/hooks/useManagerSalary.ts:190-227). Gõ sai
--     một chữ là mất hoa hồng.
--   · Tháng chưa chốt, phiếu ĐÃ duyệt bị loại khỏi lương (useManagerSalary.ts
--     :411-413). Chủ phải duyệt hoa hồng để chốt lợi nhuận ⇒ hoa hồng rơi khỏi lương.
--   · Duyệt phiếu trên sổ thật ghi tiền ra ở sổ đó (cầu a85), rồi trả lương lại
--     ghi tiền ra lần nữa ở sổ trả lương.
--   Phiếu nằm ở sổ ảo thì hệ thống KHÔNG ghi tiền (posting NON_CASH, cầu a85 bỏ
--   qua sổ ảo), còn lợi nhuận toà tính theo phiếu đã duyệt bất kể sổ nào
--   (fa_accrual_allocations không join accounts), và phiếu "Chi lương" nằm ngoài
--   kết quả kinh doanh ⇒ chi phí tính một lần, tiền ra một lần.
--
-- LÀM GÌ
--   1. app_private.salary_commission_books: sổ ảo của từng công ty (tự tạo).
--   2. app_private.commission_manager_links: phiếu ↔ quản lý nhận hoa hồng.
--   3. app_private.salary_commission_inclusions: phiếu đã tính vào kỳ lương nào.
--      Khoá chính (phiếu, kỳ): màn lương cộng hoa hồng theo THÁNG của hạng mục
--      (start_date), nên một phiếu có hạng mục ở hai tháng là hai phần của hai kỳ;
--      mỗi phần chỉ thuộc MỘT người (soát chéo 27/09: khoá theo phiếu thì phần
--      tháng sau bị gạch vĩnh viễn dù chưa từng được trả).
--   4. public.assign_commission_manager_v1: gán quản lý + chuyển phiếu CHỜ DUYỆT
--      sang sổ ảo qua đúng cửa REVISE của "sửa phiếu chờ duyệt" (khoá org, khoá
--      phiếu, CAS approval_version, lịch sử sửa, nhật ký phiếu).
--   5. public.commission_manager_options_v1 / salary_commission_meta_v1: đọc.
--   6. public.lock_salary_month_v2 / unlock_salary_month_v2: bọc v1 trong cùng
--      transaction và ghi / gỡ dấu kỳ lương. Trước khi ghi dấu, mỗi phiếu phải là
--      phiếu hoa hồng, cùng công ty, có hạng mục hoa hồng TRONG kỳ, và nếu đã gán ô
--      QL thì đúng người đó.
--   6b. THU quyền gọi lock/unlock_salary_month_v1 của authenticated: gọi thẳng v1
--      là chốt lương KHÔNG ghi dấu ⇒ lọt lưới chống tính hai lần (soát chéo 27/09,
--      BLOCKER). v2 vẫn gọi v1 bên trong (SECURITY DEFINER). Registry Copilot trỏ
--      rollback sang unlock_salary_month_v2.
--   7. Copilot "khoá tháng lương": nhận cả phiếu đã duyệt (trước chỉ UNAPPROVED)
--      và đi qua lock_salary_month_v2.
--   8. ie_revise_scope_delta_guard: trong cửa REVISE cho đổi posting_mode /
--      posting_status CHỈ khi đúng công thức suy từ sổ (như lúc tạo phiếu).
--
-- KHÔNG ĐỤNG
--   salary_payout_v1, cầu ghi sổ a85, hàm tạo phiếu, thân lock/unlock v1 (chỉ bọc
--   và thu quyền gọi thẳng).
--
-- THỨ TỰ PHÁT HÀNH
--   Áp migration rồi promote web NGAY: web đang chạy gọi lock/unlock v1 — trong
--   khoảng giữa hai bước, chốt / mở chốt lương trên web cũ báo thiếu quyền (42501).
--
-- ĐƯỜNG LÙI
--   GRANT EXECUTE lock/unlock v1 lại cho authenticated, REVOKE các RPC mới; client
--   quay về v1. Bảng mới để nguyên.
--   Phiếu đã chuyển sang sổ ảo: sửa phiếu chờ duyệt đổi lại sổ thật như thường.
--
-- Chạy được hai lượt liên tiếp và trên DB rỗng của Restore Drill.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Nền phải có.
DO $truoc$
BEGIN
  IF to_regprocedure('public.lock_salary_month_v1(date,jsonb,text)') IS NULL
     OR to_regprocedure('public.unlock_salary_month_v1(date,uuid[],text)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu lock_salary_month_v1 / unlock_salary_month_v1' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('app_private.begin_ie_flex_write_v1(uuid,text)') IS NULL
     OR to_regprocedure('app_private.end_ie_flex_write_v1(uuid)') IS NULL
     OR to_regprocedure('app_private.ie_revision_snapshot_v1(uuid)') IS NULL
     OR to_regclass('public.income_expense_revisions') IS NULL THEN
    RAISE EXCEPTION 'Thiếu cửa sửa phiếu chờ duyệt (migration 20260925080906)' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('app_private.salary_request_key_v1(text)') IS NULL
     OR to_regprocedure('app_private.salary_staff_org_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu hàm nội bộ lương (migration 20260927081925)' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('app_private.ie_actor_is_company_owner_v1(uuid,uuid)') IS NULL
     OR to_regprocedure('app_private.lock_org_for_decision_v1(uuid)') IS NULL
     OR to_regprocedure('app_private.ie_can_edit_money_axis_v1(uuid,uuid)') IS NULL
     OR to_regprocedure('app_private.assert_no_engine_request_v1(uuid)') IS NULL
     OR to_regprocedure('app_private.assert_period_open_for_edit_v1(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu hàm kiểm quyền / khoá kỳ của thu chi' USING ERRCODE = '55000';
  END IF;
  -- Mục 3 thay trigger function dùng chung của cửa REVISE: chỉ thay khi thân đang
  -- chạy đúng bản đã rà (khuôn của 20260925080906). Hai mã: bản 20260925080906 đo
  -- trên production 27/09 (không có CR) và bản do chính migration này dựng (chạy
  -- lượt hai). So trên thân đã bỏ CR để không vấp CRLF.
  IF md5(replace(pg_get_functiondef('app_private.ie_revise_scope_delta_guard()'::regprocedure), chr(13), ''))
     <> ALL (ARRAY['c50c6353af7bcb9f35e58932bae2115a', 'e76e5c34c40e5a644cd7fa85a02b8863']) THEN
    RAISE EXCEPTION 'app_private.ie_revise_scope_delta_guard() đã đổi so với bản đã rà — chụp lại pg_get_functiondef rồi rà lại'
      USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Bảng.
CREATE TABLE IF NOT EXISTS app_private.salary_commission_books (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE RESTRICT,
  account_id      uuid NOT NULL UNIQUE REFERENCES public.accounts(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS app_private.commission_manager_links (
  voucher_id      uuid PRIMARY KEY REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  manager_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  request_key     text NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by      uuid NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS commission_manager_links_mgr
  ON app_private.commission_manager_links (organization_id, manager_id);

-- Mỗi (phiếu, kỳ) thuộc tối đa MỘT người — khoá chính (voucher_id, period_month).
CREATE TABLE IF NOT EXISTS app_private.salary_commission_inclusions (
  voucher_id      uuid NOT NULL REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  staff_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  period_month    date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (voucher_id, period_month)
);
CREATE INDEX IF NOT EXISTS salary_commission_inclusions_ky
  ON app_private.salary_commission_inclusions (organization_id, period_month, staff_id);

REVOKE ALL ON app_private.salary_commission_books,
              app_private.commission_manager_links,
              app_private.salary_commission_inclusions
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.salary_commission_books IS
  'Sổ ảo "Hoa hồng QL chờ trả lương" của từng công ty. Phiếu hoa hồng của quản lý nằm ở đây: duyệt ghi chi phí toà, không ghi tiền; tiền ra lúc trả lương. Chủ chốt 27/09/2026.';
COMMENT ON TABLE app_private.commission_manager_links IS
  'Phiếu hoa hồng ↔ quản lý hưởng lương nhận hoa hồng đó (chọn trên phiếu, thay cho so tên người nhận).';
COMMENT ON TABLE app_private.salary_commission_inclusions IS
  'Phần hoa hồng (phiếu, kỳ theo tháng hạng mục) đã tính vào lương của ai. Ghi khi chốt lương (lock_salary_month_v2), gỡ khi mở chốt (unlock_salary_month_v2). Mỗi (phiếu, kỳ) thuộc tối đa một người.';

-- ---------------------------------------------------------------------------
-- 2. Sổ ảo của công ty — lấy hoặc tạo. Chủ sổ: người tạo công ty (hoặc người gọi).
CREATE OR REPLACE FUNCTION app_private.salary_commission_book_v1(p_org uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_acc  uuid;
  v_user uuid;
BEGIN
  IF p_org IS NULL THEN
    RAISE EXCEPTION 'Thiếu công ty' USING ERRCODE = '22023';
  END IF;
  SELECT b.account_id INTO v_acc FROM app_private.salary_commission_books b WHERE b.organization_id = p_org;
  IF v_acc IS NOT NULL THEN
    RETURN v_acc;
  END IF;
  SELECT COALESCE(o.created_by, auth.uid()) INTO v_user FROM public.organizations o WHERE o.id = p_org;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Không xác định được chủ sổ cho công ty %', p_org USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.accounts (user_id, name, is_virtual, organization_id, description)
  VALUES (v_user, 'Hoa hồng QL chờ trả lương', true, p_org,
          'Sổ ảo: phiếu hoa hồng của quản lý hưởng lương. Duyệt ghi chi phí toà, không ghi tiền; tiền trả qua lương.')
  RETURNING id INTO v_acc;
  INSERT INTO app_private.salary_commission_books (organization_id, account_id)
  VALUES (p_org, v_acc);
  RETURN v_acc;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.salary_commission_book_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Phiếu có ít nhất một hạng mục loại hoa hồng (cùng tiêu chí màn lương dùng).
CREATE OR REPLACE FUNCTION app_private.ie_has_commission_item_v1(p_voucher uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM public.income_expense_items it
      JOIN public.income_expense_types t ON t.id = it.income_expense_type_id
     WHERE it.income_expense_id = p_voucher
       AND (upper(COALESCE(t.category, '')) = 'HOA HỒNG' OR t.name ~* 'hoa h[ồô]ng|hhmg'));
$fn$;
REVOKE ALL ON FUNCTION app_private.ie_has_commission_item_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Cửa REVISE: cho đổi posting_mode / posting_status khi (và chỉ khi) giá trị
--    mới đúng công thức suy từ sổ quỹ — giống ie_normalize_lifecycle_columns lúc
--    tạo phiếu. Không có dòng này thì phiếu chuyển sang sổ ảo vẫn mang
--    posting_mode CASHBOOK / UNPOSTED dù không bao giờ có bút toán.
CREATE OR REPLACE FUNCTION app_private.ie_revise_scope_delta_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_cho_doi text[];
  v_virtual boolean := false;
BEGIN
  -- Chỉ soi khi CHÍNH transaction này đã mở cửa REVISE cho phiếu này.
  IF NOT EXISTS (
    SELECT 1 FROM app_private.ie_flex_writer_xids w
     WHERE w.income_expense_id = OLD.id
       AND w.transaction_id = pg_current_xact_id()
       AND w.backend_pid = pg_backend_pid()
       AND w.scope = 'REVISE'
  ) THEN
    RETURN NEW;
  END IF;

  IF OLD.approval_status IS DISTINCT FROM 'UNAPPROVED'
     OR NEW.approval_status IS DISTINCT FROM 'UNAPPROVED'
     OR COALESCE(OLD.posting_status, 'UNPOSTED') = 'POSTED'
     OR OLD.active_posting_id_v2 IS NOT NULL
     OR NEW.active_posting_id_v2 IS NOT NULL
     OR OLD.deleted_at IS NOT NULL
     OR NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cửa sửa phiếu chỉ dùng cho phiếu Chờ duyệt chưa ghi sổ (phiếu %)', OLD.id
      USING ERRCODE = '55000';
  END IF;

  v_cho_doi := ARRAY[
    -- nội dung phiếu
    'type', 'name', 'building_id', 'room_id', 'tenant_id', 'contract_id',
    'payer_name', 'receive_bank_account', 'receive_bank_name', 'account_id',
    'attachments', 'notes', 'voucher_date', 'business_result_accounting',
    'repeat_cycle', 'repeat_count', 'repeat_infinity', 'repeat_auto_approve',
    'repeat_remaining', 'repeat_next_date',
    -- cột suy ra do trigger hạng mục
    'total_amount', 'kqkd_amount', 'counts_in_business_result',
    'has_restricted_item', 'commission_kind',
    -- phiên bản
    'approval_version', 'updated_at'];

  -- Đổi Thu ↔ Chi thì mã phải đổi tiền tố theo loại (PT/PC) — chỉ khi đó mới được
  -- đổi mã, và mã mới phải đúng tiền tố (sự cố 25/09: PC2609124 đổi sang Thu vẫn
  -- giữ mã PC làm kẹt dãy mã phiếu chi).
  IF NEW.type IS DISTINCT FROM OLD.type THEN
    IF NEW.code IS NOT DISTINCT FROM OLD.code
       OR NEW.code !~ ('^' || CASE WHEN NEW.type = 'INCOME' THEN 'PT' ELSE 'PC' END || '[0-9]') THEN
      RAISE EXCEPTION 'Đổi Thu/Chi phải cấp mã phiếu mới đúng tiền tố (phiếu %)', OLD.id
        USING ERRCODE = '55000';
    END IF;
    v_cho_doi := v_cho_doi || 'code'::text;
  END IF;

  -- Chế độ ghi sổ đi theo sổ quỹ (27/09/2026): chỉ được đổi đúng về giá trị suy ra.
  IF NEW.posting_mode IS DISTINCT FROM OLD.posting_mode
     OR NEW.posting_status IS DISTINCT FROM OLD.posting_status THEN
    IF NEW.account_id IS NOT NULL THEN
      SELECT COALESCE(a.is_virtual, false) INTO v_virtual FROM public.accounts a WHERE a.id = NEW.account_id;
    END IF;
    IF NEW.posting_mode IS DISTINCT FROM (CASE WHEN v_virtual THEN 'NON_CASH' ELSE 'CASHBOOK' END)
       OR NEW.posting_status IS DISTINCT FROM (CASE WHEN v_virtual THEN 'NOT_APPLICABLE' ELSE 'UNPOSTED' END) THEN
      RAISE EXCEPTION 'Cửa sửa phiếu: chế độ ghi sổ phải khớp sổ quỹ (phiếu %)', OLD.id
        USING ERRCODE = '55000';
    END IF;
    v_cho_doi := v_cho_doi || ARRAY['posting_mode', 'posting_status'];
  END IF;

  IF (to_jsonb(OLD) - v_cho_doi) IS DISTINCT FROM (to_jsonb(NEW) - v_cho_doi) THEN
    RAISE EXCEPTION 'Cửa sửa phiếu chỉ được đổi nội dung phiếu % — phát hiện đổi cột khác', OLD.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION app_private.ie_revise_scope_delta_guard() FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Đọc: danh sách quản lý hưởng lương để chọn trên phiếu.
CREATE OR REPLACE FUNCTION public.commission_manager_options_v1(p_organization_id uuid)
RETURNS TABLE (staff_id uuid, display_name text, alias text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.is_super_admin() OR EXISTS (
            SELECT 1 FROM public.organization_memberships m
             WHERE m.user_id = v_actor AND m.organization_id = p_organization_id AND m.status = 'ACTIVE')) THEN
    RAISE EXCEPTION 'Không thuộc công ty này' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT DISTINCT ON (c.staff_id)
           c.staff_id,
           COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(c.alias), ''), 'Quản lý')::text,
           NULLIF(btrim(c.alias), '')::text
      FROM public.manager_salary_config c
      LEFT JOIN public.profiles p ON p.id = c.staff_id
     WHERE c.organization_id = p_organization_id
       AND c.is_active
     ORDER BY c.staff_id, c.created_at DESC;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Ghi: gán quản lý nhận hoa hồng + chuyển phiếu CHỜ DUYỆT sang sổ ảo.
--    Cùng khuôn revise_pending_income_expense_v1: khoá org → khoá phiếu → CAS
--    phiên bản → kiểm loại phiếu / quyền → cửa REVISE → lịch sử + nhật ký.
CREATE OR REPLACE FUNCTION public.assign_commission_manager_v1(
  p_voucher_id                uuid,
  p_manager_id                uuid,
  p_expected_approval_version bigint,
  p_idempotency_key           text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor      uuid := auth.uid();
  v_is_super   boolean := public.is_super_admin();
  v_key        text;
  v_org        uuid;
  v_row        public.income_expenses%ROWTYPE;
  v_link       app_private.commission_manager_links%ROWTYPE;
  v_book       uuid;
  v_mgr_name   text;
  v_actor_name text;
  v_before     jsonb;
  v_after      jsonb;
  v_rev_no     integer;
  v_reason     text;
  v_version    bigint;
  v_moved      boolean := false;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_voucher_id IS NULL OR p_manager_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu phiếu hoặc quản lý' USING ERRCODE = '22023';
  END IF;
  v_key := app_private.salary_request_key_v1(p_idempotency_key);

  -- Khoá tổ chức rồi khoá phiếu.
  SELECT ie.organization_id INTO v_org FROM public.income_expenses ie WHERE ie.id = p_voucher_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT * INTO v_row FROM public.income_expenses ie WHERE ie.id = p_voucher_id FOR UPDATE;
  IF NOT FOUND OR v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;

  -- Quyền: super admin, chủ công ty, người lập phiếu, hoặc người sửa được thu chi ở toà.
  IF NOT (v_is_super
          OR app_private.ie_actor_is_company_owner_v1(v_org, v_actor)
          OR v_row.user_id = v_actor
          OR app_private.ie_can_edit_money_axis_v1(v_org, v_row.building_id)) THEN
    RAISE EXCEPTION 'Không có quyền sửa phiếu này' USING ERRCODE = '42501';
  END IF;

  -- Gọi lại cùng khoá: trả kết quả cũ (trước CAS vì phiên bản có thể đã tăng).
  SELECT * INTO v_link FROM app_private.commission_manager_links l WHERE l.voucher_id = p_voucher_id;
  IF FOUND AND v_link.request_key = v_key AND v_link.updated_by = v_actor THEN
    IF v_link.manager_id IS DISTINCT FROM p_manager_id THEN
      RAISE EXCEPTION 'Khoá idempotency đã dùng cho một nội dung khác' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('voucher_id', p_voucher_id, 'manager_id', v_link.manager_id,
      'account_id', v_row.account_id, 'approval_version', v_row.approval_version, 'lap_lai', true);
  END IF;

  -- Loại phiếu.
  IF v_row.type IS DISTINCT FROM 'EXPENSE' OR NOT app_private.ie_has_commission_item_v1(p_voucher_id) THEN
    RAISE EXCEPTION 'Chỉ gán quản lý cho phiếu chi có hạng mục hoa hồng' USING ERRCODE = '22023';
  END IF;
  IF v_row.approval_status <> 'UNAPPROVED' THEN
    RAISE EXCEPTION 'Chỉ gán được khi phiếu còn Chờ duyệt — phiếu đã duyệt giữ ở sổ cũ và được tính là đã chi từ sổ đó'
      USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_row.posting_status, 'UNPOSTED') = 'POSTED' OR v_row.active_posting_id_v2 IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu đã ghi sổ — không chuyển sổ được' USING ERRCODE = '55000';
  END IF;
  IF p_expected_approval_version IS NOT NULL
     AND v_row.approval_version IS DISTINCT FROM p_expected_approval_version THEN
    RAISE EXCEPTION 'Phiếu vừa được người khác sửa — tải lại để xem thay đổi.' USING ERRCODE = 'PT409';
  END IF;
  IF v_row.system_source IS NOT NULL AND v_row.system_source <> 'contract.commission' THEN
    RAISE EXCEPTION 'Phiếu do hệ thống sinh (%) — không gán quản lý ở đây', v_row.system_source
      USING ERRCODE = '42501';
  END IF;
  IF v_row.invoice_id IS NOT NULL OR v_row.payment_id IS NOT NULL
     OR v_row.payment_collection_id IS NOT NULL OR v_row.utility_account_id IS NOT NULL
     OR v_row.salary_staff_id IS NOT NULL OR v_row.shareholder_id IS NOT NULL
     OR v_row.profit_manager_id IS NOT NULL
     OR v_row.handover_id IS NOT NULL OR v_row.handover_transfer_id IS NOT NULL
     OR v_row.reversal_of_income_expense_id IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu gắn luồng khác (hoá đơn / lương / chia lợi nhuận / bàn giao / phiếu đảo) — không gán quản lý'
      USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.assert_no_engine_request_v1(p_voucher_id);

  -- Quản lý phải đang hưởng lương ở đúng công ty của phiếu.
  IF NOT EXISTS (SELECT 1 FROM public.manager_salary_config c
                  WHERE c.staff_id = p_manager_id AND c.organization_id = v_org AND c.is_active) THEN
    RAISE EXCEPTION 'Người này không phải quản lý hưởng lương của công ty' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(NULLIF(btrim(p.full_name), ''), 'Quản lý') INTO v_mgr_name
    FROM public.profiles p WHERE p.id = p_manager_id;

  -- Kỳ đã đóng ở vị trí hiện tại (sổ chốt, tháng lợi nhuận…).
  PERFORM app_private.assert_period_open_for_edit_v1(p_voucher_id, 'sửa');

  v_book := app_private.salary_commission_book_v1(v_org);
  v_actor_name := app_private.ie_actor_display_name_v1(v_actor);
  v_version := v_row.approval_version;

  IF v_row.account_id IS DISTINCT FROM v_book THEN
    v_reason := left('Gán quản lý nhận hoa hồng: ' || COALESCE(v_mgr_name, 'Quản lý')
                     || ' — chuyển sang sổ ảo "Hoa hồng QL chờ trả lương" (tiền trả qua lương)', 1000);
    v_before := app_private.ie_revision_snapshot_v1(p_voucher_id);
    PERFORM app_private.begin_ie_flex_write_v1(p_voucher_id, 'REVISE');
    UPDATE public.income_expenses ie
       SET account_id = v_book,
           posting_mode = 'NON_CASH',
           posting_status = 'NOT_APPLICABLE',
           approval_version = ie.approval_version + 1,
           updated_at = now()
     WHERE ie.id = p_voucher_id;
    PERFORM app_private.end_ie_flex_write_v1(p_voucher_id);
    v_after := app_private.ie_revision_snapshot_v1(p_voucher_id);
    v_version := v_version + 1;
    v_moved := true;

    SELECT COALESCE(max(r.revision_no), 0) + 1 INTO v_rev_no
      FROM public.income_expense_revisions r WHERE r.income_expense_id = p_voucher_id;
    INSERT INTO public.income_expense_revisions
      (organization_id, income_expense_id, revision_no, kind, actor_id, actor_name, reason,
       changed_fields, before_snapshot, after_snapshot, idempotency_key)
    VALUES
      (v_org, p_voucher_id, v_rev_no, 'EDIT_PENDING', v_actor, COALESCE(v_actor_name, 'Người dùng'),
       v_reason, ARRAY['account_id']::text[], v_before, v_after, v_key);
  END IF;

  PERFORM app_private.append_income_expense_event_v1(
    v_org, p_voucher_id, 'REVISED', v_actor, v_actor_name, 'UNAPPROVED', 'UNAPPROVED',
    left('Gán quản lý nhận hoa hồng: ' || COALESCE(v_mgr_name, 'Quản lý')
         || CASE WHEN v_moved THEN ' (chuyển sang sổ ảo "Hoa hồng QL chờ trả lương")' ELSE '' END, 1000));

  INSERT INTO app_private.commission_manager_links
    (voucher_id, organization_id, manager_id, request_key, created_by, updated_by)
  VALUES (p_voucher_id, v_org, p_manager_id, v_key, v_actor, v_actor)
  ON CONFLICT (voucher_id) DO UPDATE
     SET manager_id = EXCLUDED.manager_id,
         request_key = EXCLUDED.request_key,
         updated_by = EXCLUDED.updated_by,
         updated_at = clock_timestamp();

  RETURN jsonb_build_object('voucher_id', p_voucher_id, 'manager_id', p_manager_id,
    'account_id', v_book, 'approval_version', v_version, 'moved', v_moved, 'lap_lai', false);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Đọc cho màn lương: quản lý đã gán, sổ của phiếu, và phần của KỲ ĐANG XEM đã
--    tính cho ai. Chỉ trả phiếu thuộc công ty người gọi đang là thành viên (hoặc
--    super admin). Bản một-tham-số (bản nháp trên TEST) bị bỏ.
DROP FUNCTION IF EXISTS public.salary_commission_meta_v1(uuid[]);
CREATE OR REPLACE FUNCTION public.salary_commission_meta_v1(p_voucher_ids uuid[], p_period_month date)
RETURNS TABLE (
  voucher_id       uuid,
  manager_id       uuid,
  account_id       uuid,
  account_name     text,
  on_manager_book  boolean,
  included_staff_id uuid,
  included_period  date)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_super boolean := public.is_super_admin();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_voucher_ids IS NULL OR cardinality(p_voucher_ids) = 0 THEN
    RETURN;
  END IF;
  IF cardinality(p_voucher_ids) > 2000 THEN
    RAISE EXCEPTION 'Tối đa 2000 phiếu mỗi lần' USING ERRCODE = '22023';
  END IF;
  IF p_period_month IS NULL THEN
    RAISE EXCEPTION 'Thiếu kỳ lương' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT ie.id,
           l.manager_id,
           ie.account_id,
           a.name::text,
           (b.account_id IS NOT NULL AND b.account_id = ie.account_id),
           i.staff_id,
           i.period_month
      FROM public.income_expenses ie
      LEFT JOIN public.accounts a ON a.id = ie.account_id
      LEFT JOIN app_private.salary_commission_books b ON b.organization_id = ie.organization_id
      LEFT JOIN app_private.commission_manager_links l ON l.voucher_id = ie.id
      LEFT JOIN app_private.salary_commission_inclusions i
             ON i.voucher_id = ie.id AND i.period_month = date_trunc('month', p_period_month)::date
     WHERE ie.id = ANY (p_voucher_ids)
       AND (v_super OR EXISTS (
             SELECT 1 FROM public.organization_memberships m
              WHERE m.user_id = v_actor AND m.organization_id = ie.organization_id AND m.status = 'ACTIVE'));
END
$fn$;

-- ---------------------------------------------------------------------------
-- 7. Chốt / mở chốt lương có dấu kỳ. Bọc v1 trong CÙNG transaction: v1 lỗi thì
--    không có dấu; dấu lỗi (phiếu đã thuộc kỳ khác) thì cả lần chốt huỷ.
CREATE OR REPLACE FUNCTION public.lock_salary_month_v2(
  p_period_month    date,
  p_managers        jsonb,
  p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_actor  uuid := auth.uid();
  v_ket    jsonb;
  v_thang  date;
  v_org    uuid;
  v_mgr    jsonb;
  v_staff  uuid;
  v_vid    uuid;
  v_cu     app_private.salary_commission_inclusions%ROWTYPE;
  v_ie     record;
  v_gan    uuid;
  v_dem    integer := 0;
BEGIN
  -- v1 kiểm đăng nhập, quyền salary.lock, idempotency, khoá org, số liệu.
  v_ket := public.lock_salary_month_v1(p_period_month, p_managers, p_idempotency_key);
  v_thang := date_trunc('month', p_period_month)::date;
  -- Công ty suy ĐÚNG như v1: từ nhân viên ĐẦU TIÊN (v1 đã buộc mọi người còn lại là
  -- thành viên công ty đó). Suy riêng từng người sẽ lệch v1 với người có cấu hình
  -- lương ở công ty khác (soát chéo 27/09).
  v_org := app_private.salary_staff_org_v1(NULLIF(p_managers -> 0 ->> 'staff_id', '')::uuid);

  FOR v_mgr IN SELECT value FROM jsonb_array_elements(p_managers) LOOP
    v_staff := NULLIF(v_mgr ->> 'staff_id', '')::uuid;
    CONTINUE WHEN v_staff IS NULL;
    FOR v_vid IN
      SELECT DISTINCT e.value::uuid
        FROM jsonb_array_elements_text(COALESCE(v_mgr -> 'commission_voucher_ids', '[]'::jsonb)) AS e(value)
    LOOP
      SELECT ie.id, ie.organization_id, ie.deleted_at, ie.approval_status INTO v_ie
        FROM public.income_expenses ie WHERE ie.id = v_vid;
      IF NOT FOUND OR v_ie.organization_id IS DISTINCT FROM v_org THEN
        RAISE EXCEPTION 'Phiếu hoa hồng % không thuộc công ty của quản lý', v_vid USING ERRCODE = '22023';
      END IF;
      IF v_ie.deleted_at IS NOT NULL OR v_ie.approval_status = 'CANCELLED' THEN
        RAISE EXCEPTION 'Phiếu hoa hồng % đã huỷ / xoá — không tính vào lương', v_vid USING ERRCODE = '22023';
      END IF;
      -- Đúng phiếu hoa hồng, có hạng mục hoa hồng TRONG kỳ (màn lương gom theo tháng
      -- của hạng mục) — chặn một danh sách sai/cũ kéo phiếu tháng khác vào kỳ này.
      IF NOT EXISTS (
        SELECT 1 FROM public.income_expense_items it
          JOIN public.income_expense_types t ON t.id = it.income_expense_type_id
         WHERE it.income_expense_id = v_vid
           AND (upper(COALESCE(t.category, '')) = 'HOA HỒNG' OR t.name ~* 'hoa h[ồô]ng|hhmg')
           AND it.start_date >= v_thang AND it.start_date < (v_thang + interval '1 month')::date) THEN
        RAISE EXCEPTION 'Phiếu % không có hạng mục hoa hồng trong kỳ % — không tính vào lương kỳ này',
          v_vid, to_char(v_thang, 'MM/YYYY') USING ERRCODE = '22023';
      END IF;
      -- Đã gán ô QL thì chỉ đúng người được gán mới nhận.
      SELECT l.manager_id INTO v_gan FROM app_private.commission_manager_links l WHERE l.voucher_id = v_vid;
      IF FOUND AND v_gan IS DISTINCT FROM v_staff THEN
        RAISE EXCEPTION 'Phiếu hoa hồng % đã gán cho quản lý khác — không tính vào lương người này', v_vid
          USING ERRCODE = '22023';
      END IF;
      SELECT * INTO v_cu FROM app_private.salary_commission_inclusions x
       WHERE x.voucher_id = v_vid AND x.period_month = v_thang;
      IF FOUND THEN
        IF v_cu.staff_id IS DISTINCT FROM v_staff THEN
          RAISE EXCEPTION 'Phiếu hoa hồng % đã tính vào lương kỳ % của người khác — không tính lần nữa',
            v_vid, to_char(v_cu.period_month, 'MM/YYYY') USING ERRCODE = '55000';
        END IF;
        CONTINUE;
      END IF;
      INSERT INTO app_private.salary_commission_inclusions
        (voucher_id, organization_id, staff_id, period_month, created_by)
      VALUES (v_vid, v_org, v_staff, v_thang, v_actor);
      v_dem := v_dem + 1;
    END LOOP;
  END LOOP;

  RETURN v_ket || jsonb_build_object('commission_marked', v_dem);
END
$fn$;

CREATE OR REPLACE FUNCTION public.unlock_salary_month_v2(
  p_period_month    date,
  p_staff_ids       uuid[],
  p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_ket  jsonb;
  v_dem  integer;
BEGIN
  v_ket := public.unlock_salary_month_v1(p_period_month, p_staff_ids, p_idempotency_key)::jsonb;
  -- Chỉ gỡ dấu của người mà kỳ đó KHÔNG còn chốt (v1 đã mở hoặc vốn chưa chốt).
  DELETE FROM app_private.salary_commission_inclusions x
   WHERE x.period_month = date_trunc('month', p_period_month)::date
     AND x.staff_id = ANY (p_staff_ids)
     AND NOT EXISTS (SELECT 1 FROM public.salary_monthly sm
                      WHERE sm.staff_id = x.staff_id AND sm.period_month = x.period_month
                        AND sm.status = 'LOCKED');
  GET DIAGNOSTICS v_dem = ROW_COUNT;
  RETURN v_ket || jsonb_build_object('commission_unmarked', v_dem);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 8. Quyền gọi.
REVOKE ALL ON FUNCTION public.commission_manager_options_v1(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.commission_manager_options_v1(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.assign_commission_manager_v1(uuid, uuid, bigint, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assign_commission_manager_v1(uuid, uuid, bigint, text) TO authenticated;
REVOKE ALL ON FUNCTION public.salary_commission_meta_v1(uuid[], date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.salary_commission_meta_v1(uuid[], date) TO authenticated;
REVOKE ALL ON FUNCTION public.lock_salary_month_v2(date, jsonb, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.lock_salary_month_v2(date, jsonb, text) TO authenticated;
REVOKE ALL ON FUNCTION public.unlock_salary_month_v2(date, uuid[], text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.unlock_salary_month_v2(date, uuid[], text) TO authenticated;

-- 6b. Gọi thẳng v1 = chốt / mở chốt KHÔNG dấu kỳ ⇒ thu quyền. v2 (SECURITY DEFINER)
--     vẫn gọi được v1 bên trong. Chủ hàm (postgres) giữ nguyên quyền.
REVOKE EXECUTE ON FUNCTION public.lock_salary_month_v1(date, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.unlock_salary_month_v1(date, uuid[], text) FROM PUBLIC, anon, authenticated;

-- Registry Copilot: đường lùi của "khoá tháng lương" là unlock v2 (v1 không còn gọi
-- thẳng được). Chỉ đổi khi đang trỏ v1; bảng registry vắng (DB khác) thì bỏ qua.
DO $registry$
BEGIN
  IF to_regclass('app_private.copilot_action_registry') IS NOT NULL THEN
    UPDATE app_private.copilot_action_registry
       SET rollback_rpc = 'unlock_salary_month_v2',
           rollback_note = 'Goi public.unlock_salary_month_v2(p_period_month date, p_staff_ids uuid[], p_idempotency_key text) '
             '— mo chot dung chieu (salary_monthly LOCKED ve DRAFT cho ky, staff_ids) VA go dau hoa hong da tinh vao ky do. '
             'Doi quyen salary.unlock (authorize_tenant_action_v3, kiem trong unlock v1 ma v2 goi). '
             'v1 khong con goi thang duoc tu 20260927155251. CHU Y CHU KY LECH: lock nhan p_managers jsonb, unlock nhan p_staff_ids uuid[]. '
             'Copilot KHONG tu dong goi ham nay.'
     WHERE action_id = 'salary.khoa_thang' AND rollback_rpc = 'unlock_salary_month_v1';
  END IF;
END
$registry$;

COMMENT ON FUNCTION public.assign_commission_manager_v1(uuid, uuid, bigint, text) IS
  'Gán quản lý hưởng lương nhận một phiếu hoa hồng CHỜ DUYỆT và chuyển phiếu sang sổ ảo "Hoa hồng QL chờ trả lương" (cửa REVISE, có lịch sử sửa). Chủ chốt 27/09/2026.';
COMMENT ON FUNCTION public.lock_salary_month_v2(date, jsonb, text) IS
  'lock_salary_month_v1 + ghi dấu phần hoa hồng (phiếu, kỳ) đã tính vào lương của ai; mỗi (phiếu, kỳ) tối đa một người.';
COMMENT ON FUNCTION public.unlock_salary_month_v2(date, uuid[], text) IS
  'unlock_salary_month_v1 + gỡ dấu kỳ lương của phiếu hoa hồng những người vừa mở chốt.';

-- ---------------------------------------------------------------------------
-- 9. Copilot "khoá tháng lương": nhận cả phiếu hoa hồng ĐÃ duyệt (phiếu của quản
--    lý ở sổ ảo được duyệt trước khi chốt lợi nhuận) và đi qua lock_salary_month_v2
--    để có dấu kỳ. Nguyên văn 20260903224418 (dòng 191-370 và 395-679), chỉ đổi:
--      · ie.approval_status = 'UNAPPROVED'  →  IN ('UNAPPROVED', 'APPROVED')  (2 chỗ)
--      · lock_salary_month_v1(...)          →  lock_salary_month_v2(...)
--    Quyền gọi giữ nguyên (CREATE OR REPLACE không đổi ACL).
CREATE OR REPLACE FUNCTION public.copilot_preview_salary_khoa_thang_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_salary_khoa_thang$
DECLARE
  v_actor        uuid := auth.uid();
  v_snapshot     jsonb;
  v_period       date;
  v_managers     jsonb;
  v_n            int;
  v_first_staff  uuid;
  v_derived_org  uuid;
  v_mg           jsonb;
  v_staff        uuid;
  v_scope        record;
  -- F2 (review, HIGH) - tong SERVER-SIDE, khong tin so AI/client tu khai.
  v_take_home_mg     numeric;
  v_voucher_ids_that  uuid[];
  v_hoa_hong_mg       numeric;
  v_managers_that     jsonb;
  v_tong_thuc_nhan    numeric;
  v_tong_hoa_hong     numeric;
  v_so_phieu_hoa_hong int;
  v_canonical    jsonb;
  v_nonce        bytea;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('salary.khoa_thang', p_organization_id);

  BEGIN
    v_period   := (p_payload ->> 'period_month')::date;
    v_managers := p_payload -> 'managers';
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_period IS NULL OR jsonb_typeof(COALESCE(v_managers, 'null'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;
  v_n := jsonb_array_length(v_managers);
  IF v_n < 1 THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;
  -- CAP KICH THUOC — an toan bulk, cung tinh than voi cac action bulk khac.
  IF v_n > 50 THEN
    RAISE EXCEPTION 'bulk_too_large: % quan ly, toi da 50', v_n USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_first_staff := NULLIF(v_managers -> 0 ->> 'staff_id', '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  IF v_first_staff IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  v_derived_org := app_private.copilot_salary_org_of_staff_v1(v_first_staff);
  IF v_derived_org IS NULL OR v_derived_org IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Doi chieu SOM: moi quan ly con lai phai co staff_id VA cung to chuc suy ra
  -- tu nhan vien dau tien (RPC goc se tu choi neu lech, nhung chan som cho UX
  -- ro rang hon "Danh sach nhan vien chua nguoi khac to chuc").
  --
  -- F2 (review, HIGH): CUNG mot vong lap nay gio tinh THEM so SERVER-SIDE -
  -- the ke hoach truoc do khong hien mot dong tien nao trong khi RPC goc dong
  -- bang y nguyen so AI/client goi len VA tu duyet phieu hoa hong. Sua:
  --   (a) commission_voucher_ids cua TUNG quan ly bi LOC lai chi con id THAT
  --       ton tai, dung to chuc, con UNAPPROVED (nhung id khac - sai/da huy/
  --       da duyet/khac to chuc - bi loai am tham, dung y RPC goc "continue"
  --       tren id khong hop le).
  --   (b) commission_total cua tung quan ly bi GHI DE bang tong THAT cua cac
  --       phieu vua loc - KHONG con la so AI tu khai.
  --   (c) tong_thuc_nhan/tong_hoa_hong/so_phieu_hoa_hong duoc CONG DON server-
  --       side va dua vao canonical + hien tren the xem truoc.
  v_tong_thuc_nhan    := 0;
  v_tong_hoa_hong     := 0;
  v_so_phieu_hoa_hong := 0;
  v_managers_that     := '[]'::jsonb;
  FOR v_mg IN SELECT value FROM jsonb_array_elements(v_managers) LOOP
    BEGIN
      v_staff        := NULLIF(v_mg ->> 'staff_id', '')::uuid;
      v_take_home_mg := COALESCE(NULLIF(v_mg ->> 'take_home', '')::numeric, 0);
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
    END;
    IF v_staff IS NULL OR v_take_home_mg < 0 THEN
      RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.organization_memberships m
       WHERE m.user_id = v_staff AND m.organization_id = p_organization_id AND m.status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
    END IF;

    BEGIN
      SELECT COALESCE(array_agg(ie.id ORDER BY ie.id), ARRAY[]::uuid[]),
             COALESCE(SUM(ie.total_amount), 0)
        INTO v_voucher_ids_that, v_hoa_hong_mg
        FROM (
          SELECT t.value
            FROM jsonb_array_elements_text(COALESCE(v_mg -> 'commission_voucher_ids', '[]'::jsonb)) AS t(value)
           WHERE t.value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        ) vid
        JOIN public.income_expenses ie
          ON ie.id = vid.value::uuid
         AND ie.organization_id = p_organization_id
         AND ie.deleted_at IS NULL
         AND ie.approval_status IN ('UNAPPROVED', 'APPROVED');
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
    END;

    v_tong_thuc_nhan    := v_tong_thuc_nhan + v_take_home_mg;
    v_tong_hoa_hong     := v_tong_hoa_hong + v_hoa_hong_mg;
    v_so_phieu_hoa_hong := v_so_phieu_hoa_hong + cardinality(v_voucher_ids_that);

    v_managers_that := v_managers_that || jsonb_build_array(
      v_mg || jsonb_build_object(
        'commission_voucher_ids', to_jsonb(v_voucher_ids_that),
        'commission_total',       v_hoa_hong_mg
      )
    );
  END LOOP;

  SELECT s.org_wide, s.building_ids
    INTO v_scope
    FROM app_private.authorized_scope_v3('salary.lock', p_organization_id) s;
  IF NOT COALESCE(v_scope.org_wide, false) AND COALESCE(cardinality(v_scope.building_ids), 0) = 0 THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_canonical := jsonb_build_object(
    'organization_id',    p_organization_id,
    'period_month',        v_period,
    'managers',            v_managers_that,
    'expected_count',      v_n,
    'tong_thuc_nhan',      v_tong_thuc_nhan,
    'so_nhan_vien',        v_n,
    'tong_hoa_hong',       v_tong_hoa_hong,
    'so_phieu_hoa_hong',   v_so_phieu_hoa_hong
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'salary.khoa_thang', app_private.copilot_payload_hash_v1(v_canonical),
     'salary.lock', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'ky_hoa_don',       to_char(v_period, 'MM/YYYY'),
      'so_nhan_vien',     v_n,
      'tong_thuc_nhan',   v_tong_thuc_nhan,
      'phieu_hoa_hong',   format('%s phieu - %s d', v_so_phieu_hoa_hong, v_tong_hoa_hong),
      'canh_bao',         format('Se khoa bang luong cua %s quan ly cho ky nay — khong the sua sau khi khoa', v_n),
      'hau_qua',          format('Se chot LOCKED bang luong cua %s quan ly (tong thuc nhan %s d), duyet kem %s phieu hoa hong (tong %s d)', v_n, v_tong_thuc_nhan, v_so_phieu_hoa_hong, v_tong_hoa_hong)
    )
  );
END
$xem_truoc_salary_khoa_thang$;

CREATE OR REPLACE FUNCTION public.copilot_execute_salary_khoa_thang_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_salary_khoa_thang$
DECLARE
  v_actor        uuid := auth.uid();
  v_hash         bytea;
  v_row          app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot     jsonb;
  v_org          uuid;
  v_period       date;
  v_managers     jsonb;
  v_expected     int;
  v_key          text;
  v_key_goc      text;
  v_prev         public.ai_write_audit%ROWTYPE;
  v_before       jsonb;
  v_after        jsonb;
  v_first_staff  uuid;
  v_derived_org  uuid;
  v_staff_ids    uuid[] := ARRAY[]::uuid[];
  v_mg           jsonb;
  v_staff        uuid;
  v_ket          jsonb;
  v_locked_count int;
  v_check_status text;
  v_check_org    uuid;
  v_first_sm_id  uuid;
  v_audit_id     uuid;
  v_ledger_id    uuid;
  -- F2 (review, HIGH) - doi soat lai vao dung luc thuc thi (TOCTOU) + doc lai
  -- tong da chot o canonical.
  v_tong_thuc_nhan    numeric;
  v_so_nhan_vien      int;
  v_tong_hoa_hong     numeric;
  v_so_phieu_hoa_hong int;
  v_voucher_ids_lai   uuid[];
  v_hoa_hong_lai      numeric;
  v_voucher_approved  int;
  v_all_voucher_ids   uuid[] := ARRAY[]::uuid[];
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_confirmation_nonce IS NULL
     OR p_confirmation_nonce !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'confirmation_required' USING ERRCODE = '42501';
  END IF;

  v_hash := app_private.copilot_payload_hash_v1(p_payload);

  SELECT * INTO v_row
    FROM app_private.copilot_write_confirmations c
   WHERE c.nonce_digest = extensions.digest(
           decode(p_confirmation_nonce, 'hex'), 'sha256')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_row.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_row.tool IS DISTINCT FROM 'salary.khoa_thang'
     OR v_row.permission_key IS DISTINCT FROM 'salary.lock' THEN
    RAISE EXCEPTION 'confirmation_contract_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_row.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;
  IF v_row.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'confirmation_expired' USING ERRCODE = '42501';
  END IF;
  IF v_row.payload_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_org       := (p_payload ->> 'organization_id')::uuid;
    v_period    := (p_payload ->> 'period_month')::date;
    v_managers  := p_payload -> 'managers';
    v_expected  := (p_payload ->> 'expected_count')::int;
    -- F2 (review, HIGH): so SERVER-SIDE da chot o canonical luc xem truoc -
    -- payload_hash da khoa nhung so nay khong doi duoc giua preview/execute.
    v_tong_thuc_nhan    := (p_payload ->> 'tong_thuc_nhan')::numeric;
    v_so_nhan_vien      := (p_payload ->> 'so_nhan_vien')::int;
    v_tong_hoa_hong     := (p_payload ->> 'tong_hoa_hong')::numeric;
    v_so_phieu_hoa_hong := (p_payload ->> 'so_phieu_hoa_hong')::int;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_tong_thuc_nhan IS NULL OR v_so_nhan_vien IS NULL
     OR v_tong_hoa_hong IS NULL OR v_so_phieu_hoa_hong IS NULL THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR v_period IS NULL
     OR jsonb_typeof(COALESCE(v_managers, 'null'::jsonb)) <> 'array'
     OR v_expected IS NULL OR jsonb_array_length(v_managers) <> v_expected
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;
  IF jsonb_array_length(v_managers) > 50 THEN
    RAISE EXCEPTION 'bulk_too_large: % quan ly, toi da 50', jsonb_array_length(v_managers) USING ERRCODE = '22023';
  END IF;

  -- F1 (review G5-C dot 1, fix round 1): guard L5 DATABASE THAT.
  IF NOT app_private.copilot_l5_plan_context_ok_v1('salary.khoa_thang', v_org) THEN
    RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_first_staff := NULLIF(v_managers -> 0 ->> 'staff_id', '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_first_staff IS NULL THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END IF;
  v_derived_org := app_private.copilot_salary_org_of_staff_v1(v_first_staff);
  IF v_derived_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'entity_changed_since_preview' USING ERRCODE = '55000';
  END IF;

  FOR v_mg IN SELECT value FROM jsonb_array_elements(v_managers) LOOP
    v_staff := NULLIF(v_mg ->> 'staff_id', '')::uuid;
    IF v_staff IS NULL THEN
      RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
    END IF;
    v_staff_ids := v_staff_ids || v_staff;

    -- F2 (review, HIGH): doi soat LAI (TOCTOU) - dung THAT giua luc xem truoc
    -- va luc thuc thi co the da doi (mot phieu hoa hong bi huy/duyet o cho
    -- khac). Xay lai CHINH XAC cung truy van da dung o preview; lech VOI so
    -- da chot trong payload (canonical) thi tu choi thay vi khoa mot con so
    -- khong con dung.
    BEGIN
      SELECT COALESCE(array_agg(ie.id ORDER BY ie.id), ARRAY[]::uuid[]),
             COALESCE(SUM(ie.total_amount), 0)
        INTO v_voucher_ids_lai, v_hoa_hong_lai
        FROM (
          SELECT t.value
            FROM jsonb_array_elements_text(COALESCE(v_mg -> 'commission_voucher_ids', '[]'::jsonb)) AS t(value)
           WHERE t.value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        ) vid
        JOIN public.income_expenses ie
          ON ie.id = vid.value::uuid
         AND ie.organization_id = v_org
         AND ie.deleted_at IS NULL
         AND ie.approval_status IN ('UNAPPROVED', 'APPROVED');
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
    END;
    IF v_voucher_ids_lai IS DISTINCT FROM
         ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_mg -> 'commission_voucher_ids', '[]'::jsonb))::uuid
                ORDER BY 1)
       OR v_hoa_hong_lai IS DISTINCT FROM COALESCE((v_mg ->> 'commission_total')::numeric, 0) THEN
      RAISE EXCEPTION 'salary_figures_mismatch' USING ERRCODE = '22023';
    END IF;
    v_all_voucher_ids := v_all_voucher_ids || v_voucher_ids_lai;
  END LOOP;

  v_snapshot := app_private.copilot_action_gate_v1('salary.khoa_thang', v_org);

  v_key := 'copilot_action:salary.khoa_thang:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'salary_monthly',
      'entity_id',    v_prev.entity_id,
      'audit_id',     v_prev.id,
      'ledger_id',    NULL
    );
  END IF;

  UPDATE app_private.copilot_write_confirmations
     SET consumed_at = clock_timestamp()
   WHERE id = v_row.id
     AND consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;

  -- before_digest — anh chup cac dong salary_monthly TRUOC khi khoa (mang co
  -- the rong tung phan tu neu chua ton tai, nhung goi jsonb NGOAI luon khac
  -- NULL).
  SELECT jsonb_agg(to_jsonb(sm) ORDER BY sm.staff_id) INTO v_before
    FROM public.salary_monthly sm
   WHERE sm.staff_id = ANY(v_staff_ids) AND sm.period_month = v_period;
  v_before := jsonb_build_object(
    'period_month', v_period, 'staff_ids', to_jsonb(v_staff_ids),
    'existing_rows', COALESCE(v_before, '[]'::jsonb)
  );

  v_key_goc := 'copilot_action_' || substr(encode(v_hash, 'hex'), 1, 40);

  v_ket := public.lock_salary_month_v2(v_period, v_managers, v_key_goc);
  v_locked_count := NULLIF(v_ket ->> 'locked_count', '')::int;
  IF v_locked_count IS NULL THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  -- READBACK — moi staff_id trong danh sach PHAI co dong salary_monthly
  -- status='LOCKED' dung to chuc (fail-closed, khong tin locked_count suong).
  FOREACH v_staff IN ARRAY v_staff_ids LOOP
    SELECT status, organization_id INTO v_check_status, v_check_org
      FROM public.salary_monthly
     WHERE staff_id = v_staff AND period_month = v_period;
    IF v_check_status IS DISTINCT FROM 'LOCKED'
       OR v_check_org IS DISTINCT FROM v_org THEN
      RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- F2 (review, HIGH): dem lai TOAN BO phieu hoa hong da duoc LOC (server-
  -- verified) va DOI so THAT su chuyen APPROVED phai khop so da chot
  -- so_phieu_hoa_hong (RPC goc duyet moi phieu UNAPPROVED trong danh sach).
  IF cardinality(v_all_voucher_ids) > 0 THEN
    SELECT count(*) INTO v_voucher_approved
      FROM public.income_expenses ie
     WHERE ie.id = ANY(v_all_voucher_ids)
       AND ie.organization_id = v_org
       AND ie.approval_status = 'APPROVED';
    IF v_voucher_approved IS DISTINCT FROM v_so_phieu_hoa_hong THEN
      RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT id INTO v_first_sm_id
    FROM public.salary_monthly
   WHERE staff_id = v_first_staff AND period_month = v_period;
  IF v_first_sm_id IS NULL THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  SELECT jsonb_agg(to_jsonb(sm) ORDER BY sm.staff_id) INTO v_after
    FROM public.salary_monthly sm
   WHERE sm.staff_id = ANY(v_staff_ids) AND sm.period_month = v_period;

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'salary.khoa_thang', v_key, 'salary_monthly',
     v_first_sm_id, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'salary.khoa_thang',
    'permission_key',      'salary.lock',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       encode(extensions.digest(
                             convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'salary_monthly',
    'entity_id',            v_first_sm_id,
    'audit_id',             v_audit_id,
    'amount',               v_tong_thuc_nhan,
    'outcome',              jsonb_build_object('status', 'da_thuc_hien', 'locked_count', v_locked_count, 'commission_approved', v_ket ->> 'commission_approved', 'so_phieu_hoa_hong', v_so_phieu_hoa_hong, 'tong_hoa_hong', v_tong_hoa_hong)
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'salary_monthly',
    'entity_id',    v_first_sm_id,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_salary_khoa_thang$;

-- ---------------------------------------------------------------------------
-- 10. Tự kiểm — hình dạng, không dữ liệu.
DO $kiem$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.prosecdef, p.proconfig,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('commission_manager_options_v1','assign_commission_manager_v1',
                         'salary_commission_meta_v1','lock_salary_month_v2','unlock_salary_month_v2')
  LOOP
    IF NOT r.prosecdef THEN RAISE EXCEPTION '% phải SECURITY DEFINER', r.sig; END IF;
    IF NOT EXISTS (SELECT 1 FROM unnest(r.proconfig) c WHERE c LIKE 'search_path=%') THEN
      RAISE EXCEPTION '% chưa ghim search_path', r.sig;
    END IF;
    IF r.anon_exec THEN RAISE EXCEPTION '% không được cho anon gọi', r.sig; END IF;
    IF NOT r.auth_exec THEN RAISE EXCEPTION '% phải cho authenticated gọi', r.sig; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('commission_manager_options_v1','assign_commission_manager_v1',
                           'salary_commission_meta_v1','lock_salary_month_v2','unlock_salary_month_v2')) <> 5 THEN
    RAISE EXCEPTION 'Thiếu RPC hoặc có bản trùng chữ ký';
  END IF;
  IF has_table_privilege('authenticated', 'app_private.commission_manager_links', 'SELECT')
     OR has_table_privilege('authenticated', 'app_private.salary_commission_inclusions', 'SELECT')
     OR has_table_privilege('authenticated', 'app_private.salary_commission_books', 'SELECT') THEN
    RAISE EXCEPTION 'Bảng hoa hồng quản lý không được mở cho authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'a01_ie_revise_scope_delta'
                  AND t.tgrelid = 'public.income_expenses'::regclass) THEN
    RAISE EXCEPTION 'Thiếu trigger a01_ie_revise_scope_delta';
  END IF;
  IF has_function_privilege('authenticated', 'public.lock_salary_month_v1(date,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.unlock_salary_month_v1(date,uuid[],text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'lock/unlock_salary_month_v1 vẫn gọi thẳng được — chốt lương sẽ lọt dấu kỳ';
  END IF;
  -- Bảng dấu kỳ phải khoá theo (phiếu, kỳ). Bảng cũ khoá theo phiếu (bản nháp) thì
  -- CREATE TABLE IF NOT EXISTS để nguyên — chặn ở đây thay vì chạy sai âm thầm.
  IF (SELECT array_agg(a.attname::text ORDER BY a.attname)
        FROM pg_index ix JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ANY (ix.indkey)
       WHERE ix.indrelid = 'app_private.salary_commission_inclusions'::regclass AND ix.indisprimary)
     IS DISTINCT FROM ARRAY['period_month', 'voucher_id'] THEN
    RAISE EXCEPTION 'salary_commission_inclusions phải có khoá chính (voucher_id, period_month)';
  END IF;
END
$kiem$;

COMMIT;
