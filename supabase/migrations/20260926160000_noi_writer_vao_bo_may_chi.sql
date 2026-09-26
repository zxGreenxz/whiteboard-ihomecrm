-- =============================================================================
-- noi_writer_vao_bo_may_chi — G5 của plan "cỗ máy chi theo cam kết" (26/09/2026)
-- =============================================================================
-- VÌ SAO
--   Mỗi cửa chi đang tự quyết phiếu sinh ra đã duyệt hay chờ theo luật chép riêng. G2 đã có
--   MỘT bộ máy (app_private.ie_spend_decide_v1) + cổng (ie_spend_gate_v1). Bước này cho 5 cửa
--   chi HỎI cổng ở đúng chỗ chúng ra quyết định:
--     create_income_expense_v1   (phiếu tay ở trang Thu chi)
--     pay_period_fee             (trang Thanh toán — phí cố định)
--     pay_utility_bill           (trang Thanh toán — điện nước)
--     generate_special_fees_v1   (sinh phí cố định hàng loạt)
--     generate_recurring_vouchers(cron phiếu định kỳ 01:00)
--   Không nối: create_income_expense_v2 và ie_compat_insert_v2 — luôn sinh CHỜ DUYỆT, không
--   tự duyệt nên không có gì để áp; sổ tiêu + bóng vẫn phủ chúng qua trigger (G4).
--
-- LUẬT ÁP
--   Cổng trả enforce=true CHỈ khi cờ spend.engine.v1 = ON và MỌI bucket (toà × hạng mục × tháng)
--   của phiếu đã bật trong spend_policy_switches. Hôm nay cờ SHADOW, 0 công tắc ⇒ enforce luôn
--   false ⇒ 5 cửa đi y như trước. Cổng vẫn khoá bucket và ghi writer cho sổ bóng.
--
-- HẠNG MỤC CHO KHOÁ PHÍ (plan §5 mục 3)
--   pay_period_fee (qua resolve_fixed_expense_type) và generate_special_fees_v1 dùng hạng mục
--   ĐÃ ÁNH XẠ (G3) trước, khớp tên chỉ còn là đường lùi — để luật chi đọc đúng hạng mục. Đo
--   26/09: cả 9 hạng mục ánh xạ đều được fee_type_matches nhận ⇒ lưới Thanh toán không đổi.
--
-- KHÔNG ĐỤNG
--   Chữ ký hàm, quyền, idempotency, kiểm trùng kỳ, khối INSERT mẫu neo của pay_utility_bill,
--   luật huỷ phí (Đ5), phiếu THU.
--
-- ĐƯỜNG LÙI
--   Không cần gỡ: để cờ spend.engine.v1 khác ON (hoặc tắt công tắc) là 5 cửa đi luật cũ.
--   Gỡ hẳn: khôi phục thân hàm từ bản backup trước áp.
--
-- Sinh tự động bởi docs/audits/2026-09-26-plan-cam-ket-goi-audit/sinh-G5.cjs từ thân hàm sống
-- (md5 ghim bên dưới). Chạy được hai lượt và trên DB rỗng của Restore Drill.
-- =============================================================================

BEGIN;

-- 0. Nền + ghim md5 thân hàm sẽ thay (lượt hai: thân đã mang dấu G5 ⇒ cho qua).
DO $truoc$
DECLARE
  v_ham record;
  v_def text;
BEGIN
  IF to_regprocedure('app_private.ie_spend_gate_v1(uuid,uuid,text,text,text,uuid,date,jsonb,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.ie_spend_gate_v1 — chạy bo_may_chi_so_tieu_va_quyet_dinh_bong trước'
      USING ERRCODE = '55000';
  END IF;
  FOR v_ham IN
    SELECT * FROM (VALUES
    ('public.create_income_expense_v1(text,text,uuid,uuid,uuid,uuid,text,text,text,uuid,jsonb,boolean,text,date,jsonb,text)', '7cc6fa873d8e063187ddb82a66702259', 'ie_spend_gate_v1'),
    ('public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)', '6545b554ba8732eb4362b95fbcd040e4', 'ie_spend_gate_v1'),
    ('public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid)', 'b6a36737c5fc1aeadf759f89aee552ee', 'ie_spend_gate_v1'),
    ('public.generate_special_fees_v1(text,uuid[],text,uuid)', '6238a35926d7a960d03291557d30f8e9', 'ie_spend_gate_v1'),
    ('public.generate_recurring_vouchers(uuid)', 'e8b6f1e9632ed2c6e94666cf09935a88', 'ie_spend_gate_v1'),
    ('public.resolve_fixed_expense_type(uuid,text)', 'e6c68ad3c2c98bfe93c4ff0b357ea16e', 'fee_category = p_category_key')
    ) AS t(chu_ky, md5_hop_le, dau_g5)
  LOOP
    v_def := pg_get_functiondef(to_regprocedure(v_ham.chu_ky));
    IF v_def IS NOT NULL AND md5(v_def) <> v_ham.md5_hop_le
       AND position(v_ham.dau_g5 in v_def) = 0 THEN
      RAISE EXCEPTION '% đã đổi so với bản đã rà — chụp lại pg_get_functiondef rồi rà lại', v_ham.chu_ky
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$truoc$;

-- 1. Lý do của bộ máy, tiếng Việt, cho ghi chú trả về người bấm.
CREATE OR REPLACE FUNCTION app_private.spend_reason_vi_v1(p_reason text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $fn$
  SELECT CASE p_reason
    WHEN 'WITHIN_COMMITMENT'     THEN 'trong cam kết đã ký của tháng'
    WHEN 'OVER_COMMITMENT'       THEN 'vượt phần cam kết còn lại của tháng'
    WHEN 'NO_COMMITMENT'         THEN 'tháng này chưa ký cam kết cho hạng mục'
    WHEN 'UNDER_CEILING'         THEN 'dưới trần đã công bố'
    WHEN 'OVER_CEILING'          THEN 'vượt trần đã công bố'
    WHEN 'NO_CEILING'            THEN 'chưa khai trần cho hạng mục'
    WHEN 'NO_CASHBOOK'           THEN 'phiếu chi chưa gắn sổ quỹ thật'
    WHEN 'NO_CASHBOOK_RIGHT'     THEN 'người lập không giữ sổ này để chi'
    WHEN 'SELF_APPROVER'         THEN 'tự duyệt — người lập có quyền duyệt'
    WHEN 'FORCE_APPROVAL'        THEN 'hạng mục bắt buộc duyệt'
    WHEN 'OVER_THRESHOLD'        THEN 'từ ngưỡng tự duyệt trở lên'
    WHEN 'UNDER_THRESHOLD'       THEN 'dưới ngưỡng tự duyệt'
    WHEN 'RECURRING_PREAPPROVED' THEN 'phiếu định kỳ chủ đã cho tự duyệt'
    WHEN 'SYSTEM_BALANCED'       THEN 'nguồn hệ thống tự cân đối'
    WHEN 'INCOME_POLICY'         THEN 'phiếu thu'
    WHEN 'ENGINE_ERROR'          THEN 'bộ máy chi gặp lỗi — chờ duyệt cho an toàn'
    ELSE COALESCE(p_reason, 'không rõ') END;
$fn$;
REVOKE ALL ON FUNCTION app_private.spend_reason_vi_v1(text) FROM PUBLIC, anon, authenticated, service_role;

-- 2. Sổ bóng phải ghi ĐÚNG quyết định cổng đưa ra lúc sinh (thử TEST 26/09 bắt được: tính lại lúc
--    COMMIT thì phiếu sinh sau trong cùng transaction — cron định kỳ, sinh phí hàng loạt — làm
--    phiếu sinh trước bị chấm "vượt" oan, và tên writer bị writer gọi sau đè).
--    Cổng G2 đổi tên thành lõi; hàm bọc cùng chữ ký chốt kết quả cho từng phiếu:
--      cổng gọi SAU khi chèn phiếu (p_exclude_voucher)  ⇒ gắn thẳng vào phiếu đó;
--      cổng gọi TRƯỚC khi chèn                          ⇒ trigger z59 gắn vào phiếu chèn ngay sau.
DO $doi_ten$
BEGIN
  IF to_regprocedure('app_private.ie_spend_gate_core_v1(uuid,uuid,text,text,text,uuid,date,jsonb,uuid,jsonb)') IS NULL THEN
    IF md5(pg_get_functiondef(to_regprocedure(
         'app_private.ie_spend_gate_v1(uuid,uuid,text,text,text,uuid,date,jsonb,uuid,jsonb)')))
       <> 'c0fc31df0a3cf7a83fe56594000426f5' THEN
      RAISE EXCEPTION 'ie_spend_gate_v1 đã đổi so với bản G2 đã rà — chụp lại rồi rà lại' USING ERRCODE = '55000';
    END IF;
    ALTER FUNCTION app_private.ie_spend_gate_v1(uuid,uuid,text,text,text,uuid,date,jsonb,uuid,jsonb)
      RENAME TO ie_spend_gate_core_v1;
  END IF;
END
$doi_ten$;

CREATE OR REPLACE FUNCTION app_private.ie_spend_gate_v1(
  p_org             uuid,
  p_building        uuid,
  p_direction       text,
  p_writer          text,
  p_system_source   text,
  p_account         uuid,
  p_voucher_date    date,
  p_lines           jsonb,
  p_exclude_voucher uuid  DEFAULT NULL,
  p_context         jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_kq jsonb;
BEGIN
  v_kq := app_private.ie_spend_gate_core_v1(p_org, p_building, p_direction, p_writer, p_system_source,
            p_account, p_voucher_date, p_lines, p_exclude_voucher, p_context);
  BEGIN
    IF p_exclude_voucher IS NOT NULL THEN
      PERFORM set_config('app.spend_gate_of_' || replace(p_exclude_voucher::text, '-', ''),
                         (v_kq || jsonb_build_object('writer', p_writer))::text, true);
    ELSE
      PERFORM set_config('app.spend_gate_last',
                         (v_kq || jsonb_build_object('writer', p_writer))::text, true);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;   -- chốt vết cho sổ bóng không bao giờ được làm hỏng writer
  END;
  RETURN v_kq;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.ie_spend_gate_v1(uuid,uuid,text,text,text,uuid,date,jsonb,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.ie_spend_gate_core_v1(uuid,uuid,text,text,text,uuid,date,jsonb,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.spend_capture_gate_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_last text;
BEGIN
  v_last := NULLIF(current_setting('app.spend_gate_last', true), '');
  IF v_last IS NOT NULL THEN
    PERFORM set_config('app.spend_gate_of_' || replace(NEW.id::text, '-', ''), v_last, true);
    PERFORM set_config('app.spend_gate_last', '', true);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.spend_capture_gate_trg() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS z59_spend_capture_gate ON public.income_expenses;
CREATE TRIGGER z59_spend_capture_gate
  AFTER INSERT ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION app_private.spend_capture_gate_trg();

DO $ghim_bong$
DECLARE
  v_def text := pg_get_functiondef('app_private.spend_shadow_birth_trg()'::regprocedure);
BEGIN
  IF md5(v_def) <> '93188ef659cb9ebcd3e31b0e816f0134' AND position('spend_gate_of_' in v_def) = 0 THEN
    RAISE EXCEPTION 'spend_shadow_birth_trg đã đổi so với bản G2 đã rà — chụp lại rồi rà lại' USING ERRCODE = '55000';
  END IF;
END
$ghim_bong$;

CREATE OR REPLACE FUNCTION app_private.spend_shadow_birth_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_ie       record;
  v_route    text;
  v_writer   text;
  v_parent   boolean;
  v_facts    jsonb;
  v_dec      jsonb;
  v_enforced boolean;
  v_cap      jsonb;
BEGIN
  BEGIN
    SELECT e.* INTO v_ie FROM public.income_expenses e WHERE e.id = NEW.id;
    IF NOT FOUND OR v_ie.organization_id IS NULL THEN
      RETURN NULL;
    END IF;
    v_route := app_private.spend_route_v1(v_ie.organization_id);
    IF v_route = 'LEGACY' THEN
      RETURN NULL;
    END IF;

    -- kết quả cổng đã chốt cho phiếu này lúc sinh (writer đã nối)
    v_cap := NULLIF(current_setting('app.spend_gate_of_' || replace(v_ie.id::text, '-', ''), true), '')::jsonb;
    IF v_cap IS NOT NULL AND v_cap->>'status' IS NOT NULL AND jsonb_typeof(v_cap->'facts') = 'object' THEN
      v_writer   := app_private.spend_writer_of_v1(v_ie.system_source, v_ie.repeat_parent_id, v_cap->>'writer');
      v_facts    := v_cap->'facts';
      v_dec      := v_cap - 'facts' - 'enforce' - 'route' - 'writer';
      v_enforced := COALESCE((v_cap->>'enforce')::boolean, false);
      v_route    := COALESCE(v_cap->>'route', v_route);
    ELSE
      -- phiếu không qua cổng (compat, v2, writer hệ thống): tính tại COMMIT
      v_writer := app_private.spend_writer_of_v1(v_ie.system_source, v_ie.repeat_parent_id, v_cap->>'writer');
      IF v_ie.repeat_parent_id IS NOT NULL THEN
        SELECT p.repeat_auto_approve INTO v_parent
          FROM public.income_expenses p WHERE p.id = v_ie.repeat_parent_id;
      END IF;
      v_facts := app_private.ie_spend_facts_v1(
                   v_ie.organization_id, v_ie.building_id, v_ie.type, v_writer,
                   v_ie.system_source, v_ie.account_id, v_ie.voucher_date,
                   app_private.spend_lines_of_voucher_v1(v_ie.id), v_ie.id, false,
                   jsonb_build_object('recurring_auto_approve', COALESCE(v_parent, false)));
      v_dec := app_private.ie_spend_decide_v1(v_facts);
      v_enforced := false;
    END IF;

    INSERT INTO app_private.spend_decisions
      (organization_id, income_expense_id, building_id, direction, writer, route, enforced,
       birth_status, engine_status, engine_reason, match, amount, facts, decision, actor_id)
    VALUES
      (v_ie.organization_id, v_ie.id, v_ie.building_id, v_ie.type, v_writer, v_route, v_enforced,
       v_ie.approval_status, v_dec->>'status', v_dec->>'reason',
       v_ie.approval_status = v_dec->>'status', v_ie.total_amount, v_facts, v_dec, auth.uid())
    ON CONFLICT (income_expense_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO app_private.spend_engine_errors
      (context, organization_id, income_expense_id, sqlstate, message)
    VALUES ('shadow_birth', NEW.organization_id, NEW.id, SQLSTATE, SQLERRM);
  END;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.spend_shadow_birth_trg() FROM PUBLIC, anon, authenticated, service_role;

-- 3. resolve_fixed_expense_type — hạng mục đã ánh xạ trước.
CREATE OR REPLACE FUNCTION public.resolve_fixed_expense_type(p_owner uuid, p_category_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_type uuid;
  v_name text;
  v_category text;
  v_organization_id uuid;
BEGIN
  IF p_category_key NOT IN (
    'tien_nha', 'dien', 'nuoc', 'internet', 'quan_ly',
    've_sinh', 'cong_an', 'rac', 'thang_may'
  ) THEN
    RAISE EXCEPTION 'Hạng mục phí không hợp lệ: %', p_category_key
      USING ERRCODE = '23514';
  END IF;

  v_organization_id := app_private.resolve_ie_type_org_for_user_v1(p_owner);

  -- G5 (26/09/2026): hạng mục đã ánh xạ (G3, duy nhất theo org) là nguồn đúng cho khoá phí —
  -- luật chi đọc trên chính hạng mục đó. Khớp theo tên bên dưới chỉ còn là đường lùi.
  SELECT type_row.id
    INTO v_type
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_organization_id
    AND type_row.fee_category = p_category_key
    AND lower(btrim(type_row.type)) = 'expense';
  IF v_type IS NOT NULL THEN
    RETURN v_type;
  END IF;

  SELECT type_row.id
    INTO v_type
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_organization_id
    AND lower(btrim(type_row.type)) = 'expense'
    AND public.fee_type_matches(
      p_category_key,
      type_row.category,
      type_row.name
    )
  ORDER BY
    COALESCE(type_row.is_default, false) DESC,
    type_row.created_at,
    type_row.id
  LIMIT 1;

  IF v_type IS NOT NULL THEN
    RETURN v_type;
  END IF;

  v_name := CASE p_category_key
    WHEN 'tien_nha'  THEN 'Tiền nhà'
    WHEN 'dien'      THEN 'Đóng tiền điện'
    WHEN 'nuoc'      THEN 'Đóng tiền nước'
    WHEN 'internet'  THEN 'Internet'
    WHEN 'quan_ly'   THEN 'Quản Lý'
    WHEN 've_sinh'   THEN 'Vệ sinh tòa nhà định kỳ'
    WHEN 'cong_an'   THEN 'Công an'
    WHEN 'rac'       THEN 'Tiền rác'
    WHEN 'thang_may' THEN 'Bảo trì thang máy'
  END;
  v_category := CASE p_category_key
    WHEN 'tien_nha'  THEN 'Tiền nhà'
    WHEN 'dien'      THEN 'Điện'
    WHEN 'nuoc'      THEN 'Nước'
    WHEN 'internet'  THEN 'Internet'
    WHEN 'quan_ly'   THEN 'Quản Lý'
    WHEN 've_sinh'   THEN 'Vệ sinh'
    WHEN 'cong_an'   THEN 'Công an'
    WHEN 'rac'       THEN 'Rác'
    WHEN 'thang_may' THEN 'Bảo Trì Thang Máy'
  END;

  RETURN app_private.ensure_income_expense_type_v1(
    p_organization_id => v_organization_id,
    p_user_id => p_owner,
    p_name => v_name,
    p_type => 'expense',
    p_category => v_category,
    p_is_restricted => (p_category_key = 'quan_ly')
  );
END
$function$;

-- 4. create_income_expense_v1 — phiếu tay trang Thu chi.
CREATE OR REPLACE FUNCTION public.create_income_expense_v1(p_type text, p_name text, p_building_id uuid, p_room_id uuid, p_tenant_id uuid, p_contract_id uuid, p_payer_name text, p_receive_bank_account text, p_receive_bank_name text, p_account_id uuid, p_attachments jsonb, p_business_result_accounting boolean, p_notes text, p_voucher_date date, p_items jsonb, p_idempotency_key text)
 RETURNS income_expenses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$



DECLARE

  -- t5_23/24: trạng thái sinh theo phương án org (cờ hạng mục + ngưỡng chi)
  v_birth_status text;
  v_birth_by uuid;
  v_birth_at timestamptz;
  v_force_cat boolean;
  v_auto_threshold numeric;
  v_maker_can_approve boolean := false;
  v_spend_gate jsonb;  -- G5 26/09/2026: cổng bộ máy chi




  v_actor uuid := app_private.current_uid_v1();



  v_claim_cap text;



  v_actor_name text;



  v_name text;



  v_org uuid;



  v_membership_id uuid;



  v_room_id uuid := p_room_id;



  v_tenant_id uuid := p_tenant_id;



  v_contract_room_id uuid;



  v_contract_tenant_id uuid;



  v_contract_deposit_paid_before public.contracts.deposit_paid%TYPE;



  v_contract_updated_at_before public.contracts.updated_at%TYPE;



  v_room_status_before public.rooms.status%TYPE;



  v_room_updated_at_before public.rooms.updated_at%TYPE;



  v_account_owner_id uuid;



  v_account_lock_date date;



  v_account_is_shared boolean := false;



  v_can_create_on_building boolean := false;



  v_can_create_restricted boolean := false;



  v_requires_restricted boolean := false;



  v_row public.income_expenses;



  v_operation app_private.canonical_write_operations%ROWTYPE;



  v_feature app_private.server_feature_flags%ROWTYPE;



  v_feature_route text;



  v_feature_operation_key text;



  v_feature_evaluated_at timestamptz;



  v_item jsonb;



  v_item_count integer;



  v_accrual_bucket_count integer := 0;



  v_index integer := 0;



  v_type_id uuid;



  v_type_is_restricted boolean;



  v_type_is_deposit boolean;



  v_type_normalized_name text;
  v_type_system_only boolean;



  v_quantity numeric;



  v_unit_price_raw numeric;



  v_unit_price numeric;



  v_start_date date;



  v_end_date date;



  v_description text;



  v_expected_type text;



  v_canonical_items jsonb := '[]'::jsonb;



  v_canonical_payload jsonb;



  v_payload_hash text;



  v_idempotency_key text;



  v_total_amount numeric := 0;



  v_feature_operation_count bigint;



  v_feature_total_amount numeric;



  v_stored_item_count bigint;



  v_stored_total_amount numeric;



  v_stored_has_restricted boolean;



  v_stored_counts_in_business_result boolean;



  v_stored_kqkd_amount numeric;
  v_stored_pnl_sum numeric;
  v_stored_has_deposit_item boolean;
  v_room_status_after public.rooms.status%TYPE;
  v_room_updated_at_after public.rooms.updated_at%TYPE;
  v_contract_deposit_paid_after public.contracts.deposit_paid%TYPE;
  v_contract_updated_at_after public.contracts.updated_at%TYPE;



  v_attachments jsonb := COALESCE(p_attachments, '[]'::jsonb);



  c_max_money constant numeric := 9999999999999.99;



  c_max_attachments constant integer := 20;



  c_max_attachment_length constant integer := 2048;



  c_max_name_length constant integer := 500;



  c_max_short_text_length constant integer := 255;



  c_max_notes_length constant integer := 5000;



  c_max_item_description_length constant integer := 1000;



  c_max_item_period_days constant integer := 3660;



  c_max_accrual_buckets constant integer := 2400;



  c_extra_whitespace constant text :=



    chr(160) || chr(173) || chr(5760)



    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196)



    || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201)



    || chr(8202) || chr(8203) || chr(8232) || chr(8233) || chr(8239)



    || chr(8287) || chr(8288) || chr(12288) || chr(65279);



BEGIN



  IF v_actor IS NULL THEN



    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';



  END IF;







  -- A.9 smallest-shape: actor display name via postgres-owned DEFINER delegate



  -- (auth.users/profiles RLS is not part of the writer role's capability set).



  v_actor_name := app_private.ie_actor_display_name_v1(v_actor);



  IF v_actor_name IS NULL THEN



    RAISE EXCEPTION 'Không tìm thấy người dùng hiện tại' USING ERRCODE = '42501';



  END IF;







  -- Platform administration is not tenant business authority. A platform actor



  -- must also hold an active tenant membership and normalized tenant permission;



  -- emergency platform operations belong to a separate, audited endpoint.



  IF p_type NOT IN ('INCOME', 'EXPENSE') THEN



    RAISE EXCEPTION 'Loại phiếu không hợp lệ';



  END IF;



  v_name := btrim(p_name, E' \t\n\r\f\v' || c_extra_whitespace);



  IF p_name IS NULL OR v_name = '' THEN



    RAISE EXCEPTION 'Tên phiếu không được trống';



  END IF;



  IF char_length(v_name) > c_max_name_length THEN



    RAISE EXCEPTION 'Tên phiếu vượt quá % ký tự', c_max_name_length;



  END IF;



  IF p_building_id IS NULL THEN



    RAISE EXCEPTION 'Thiếu building_id';



  END IF;



  IF p_voucher_date IS NULL



     OR NOT isfinite(p_voucher_date)



     OR p_voucher_date < DATE '2000-01-01'



     OR p_voucher_date > DATE '2100-12-31' THEN



    RAISE EXCEPTION 'Ngày phiếu phải nằm trong khoảng 2000-01-01 đến 2100-12-31';



  END IF;



  v_idempotency_key := btrim(p_idempotency_key);



  IF v_idempotency_key IS NULL



     OR char_length(v_idempotency_key) < 8



     OR char_length(v_idempotency_key) > 200



     OR v_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN



    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII và chỉ chứa A-Z, a-z, 0-9, ., _, :, -';



  END IF;



  IF p_payer_name IS NOT NULL



     AND char_length(btrim(p_payer_name)) > c_max_short_text_length THEN



    RAISE EXCEPTION 'Tên người nộp/nhận vượt quá % ký tự', c_max_short_text_length;



  END IF;



  IF p_receive_bank_account IS NOT NULL



     AND char_length(btrim(p_receive_bank_account)) > c_max_short_text_length THEN



    RAISE EXCEPTION 'Số tài khoản nhận vượt quá % ký tự', c_max_short_text_length;



  END IF;



  IF p_receive_bank_name IS NOT NULL



     AND char_length(btrim(p_receive_bank_name)) > c_max_short_text_length THEN



    RAISE EXCEPTION 'Tên ngân hàng nhận vượt quá % ký tự', c_max_short_text_length;



  END IF;



  IF p_notes IS NOT NULL AND char_length(p_notes) > c_max_notes_length THEN



    RAISE EXCEPTION 'Ghi chú vượt quá % ký tự', c_max_notes_length;



  END IF;



  IF jsonb_typeof(v_attachments) <> 'array'



     OR jsonb_array_length(v_attachments) > c_max_attachments



     OR EXISTS (



       SELECT 1



         FROM jsonb_array_elements(v_attachments) x(value)



        WHERE jsonb_typeof(value) <> 'string'



           OR char_length(value #>> '{}') < 1



           OR char_length(value #>> '{}') > c_max_attachment_length



           OR value #>> '{}' ~ '[[:cntrl:]]'



           OR value #>> '{}' !~



                '^https://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?(?:[/?#][^[:space:]\\]*)?$'



     ) THEN



    RAISE EXCEPTION 'attachments phải là mảng tối đa % HTTPS URL an toàn, mỗi URL dài 1-% ký tự',



      c_max_attachments, c_max_attachment_length;



  END IF;



  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN



    RAISE EXCEPTION 'items phải là mảng';



  END IF;



  v_item_count := jsonb_array_length(p_items);



  IF v_item_count < 1 OR v_item_count > 200 THEN



    RAISE EXCEPTION 'Phiếu phải có từ 1 đến 200 hạng mục';



  END IF;







  -- Lock order: organization/building → membership → staff/role scope → room →



  -- tenant → contract/contract_tenant → account/share → item types → feature row.



  SELECT b.organization_id



    INTO v_org



    FROM public.buildings b



    JOIN public.organizations o



      ON o.id = b.organization_id



     AND o.status = 'ACTIVE'



   WHERE b.id = p_building_id



     AND b.deleted_at IS NULL



   FOR SHARE OF o, b;



  IF NOT FOUND OR v_org IS NULL THEN



    RAISE EXCEPTION 'Không tìm thấy toà nhà trong tổ chức đang hoạt động'



      USING ERRCODE = '42501';



  END IF;







  SELECT m.id



    INTO v_membership_id



    FROM public.organization_memberships m



   WHERE m.user_id = v_actor



     AND m.organization_id = v_org



     AND m.status = 'ACTIVE'



     AND m.valid_from <= clock_timestamp()



     AND (m.valid_to IS NULL OR clock_timestamp() < m.valid_to)



   ORDER BY m.id



   LIMIT 1



   FOR SHARE;



  IF NOT FOUND THEN



    RAISE EXCEPTION 'Không còn là thành viên đang hoạt động của tổ chức'



      USING ERRCODE = '42501';



  END IF;







  v_can_create_on_building :=



    app_private.authorize_income_expense_on_building(



      v_actor, v_org, 'create', p_building_id



    );







  v_can_create_restricted :=



    app_private.authorize_income_expense_on_building(



      v_actor, v_org, 'restricted_create', p_building_id



    );







  IF p_room_id IS NOT NULL THEN



    PERFORM 1



      FROM public.rooms r



     WHERE r.id = p_room_id



       AND r.deleted_at IS NULL



       AND r.building_id = p_building_id



       AND r.organization_id = v_org



     FOR SHARE;



    IF NOT FOUND THEN



      RAISE EXCEPTION 'Phòng không thuộc toà/tổ chức của phiếu'



        USING ERRCODE = '42501';



    END IF;



  END IF;







  IF p_tenant_id IS NOT NULL THEN



    PERFORM 1



      FROM public.tenants t



     WHERE t.id = p_tenant_id



       AND t.deleted_at IS NULL



       AND t.organization_id = v_org



     FOR SHARE;



    IF NOT FOUND THEN



      RAISE EXCEPTION 'Khách thuê không thuộc tổ chức của phiếu'



        USING ERRCODE = '42501';



    END IF;



  END IF;







  IF p_contract_id IS NOT NULL THEN



    SELECT c.room_id, c.tenant_id, c.deposit_paid, c.updated_at



      INTO v_contract_room_id, v_contract_tenant_id,



           v_contract_deposit_paid_before, v_contract_updated_at_before



      FROM public.contracts c



      JOIN public.rooms r



        ON r.id = c.room_id



       AND r.deleted_at IS NULL



       AND r.building_id = p_building_id



       AND r.organization_id = v_org



     WHERE c.id = p_contract_id



       AND c.deleted_at IS NULL



       AND c.organization_id = v_org



     FOR SHARE OF c, r;



    IF NOT FOUND THEN



      RAISE EXCEPTION 'Hợp đồng không thuộc toà/tổ chức của phiếu'



        USING ERRCODE = '42501';



    END IF;



    IF p_room_id IS NOT NULL AND p_room_id IS DISTINCT FROM v_contract_room_id THEN



      RAISE EXCEPTION 'Hợp đồng không khớp phòng của phiếu'



        USING ERRCODE = '42501';



    END IF;







    IF v_contract_tenant_id IS NOT NULL THEN



      PERFORM 1



        FROM public.tenants t



       WHERE t.id = v_contract_tenant_id



         AND t.deleted_at IS NULL



         AND t.organization_id = v_org



       FOR SHARE;



      IF NOT FOUND THEN



        RAISE EXCEPTION 'Khách thuê đại diện của hợp đồng không còn hợp lệ'



          USING ERRCODE = '42501';



      END IF;



      IF p_tenant_id IS NOT NULL



         AND p_tenant_id IS DISTINCT FROM v_contract_tenant_id THEN



        RAISE EXCEPTION 'Hợp đồng không khớp khách thuê của phiếu'



          USING ERRCODE = '42501';



      END IF;



      v_tenant_id := v_contract_tenant_id;



    ELSIF p_tenant_id IS NOT NULL THEN



      -- contracts.tenant_id is a nullable legacy representative. Only the legacy



      -- contract_tenants relation can prove a supplied tenants.id; contract_customers



      -- references public.customers and must never be used as a tenant bridge.



      PERFORM 1



        FROM public.contract_tenants ct



       WHERE ct.contract_id = p_contract_id



         AND ct.tenant_id = p_tenant_id



         AND (ct.organization_id IS NULL OR ct.organization_id = v_org)



       FOR SHARE;



      IF NOT FOUND THEN



        RAISE EXCEPTION 'Khách thuê không thuộc hợp đồng'



          USING ERRCODE = '42501';



      END IF;



      v_tenant_id := p_tenant_id;



    ELSE



      v_tenant_id := NULL;



    END IF;







    v_room_id := v_contract_room_id;



  END IF;







  IF NOT v_can_create_on_building THEN



    RAISE EXCEPTION 'Không có quyền tạo phiếu thu/chi cho toà này'



      USING ERRCODE = '42501';



  END IF;







  IF v_room_id IS NOT NULL THEN



    SELECT r.status, r.updated_at



      INTO v_room_status_before, v_room_updated_at_before



      FROM public.rooms r



     WHERE r.id = v_room_id



       AND r.deleted_at IS NULL



       AND r.building_id = p_building_id



       AND r.organization_id = v_org



     FOR SHARE;



    IF NOT FOUND THEN



      RAISE EXCEPTION 'Phòng hiệu lực không thuộc toà/tổ chức của phiếu'



        USING ERRCODE = '42501';



    END IF;



  END IF;







  IF p_account_id IS NOT NULL THEN



    SELECT a.user_id, a.lock_date



      INTO v_account_owner_id, v_account_lock_date



      FROM public.accounts a



     WHERE a.id = p_account_id



       AND a.deleted_at IS NULL



       AND a.organization_id = v_org



     FOR SHARE;



    IF NOT FOUND THEN



      RAISE EXCEPTION 'Sổ quỹ không thuộc tổ chức của phiếu'



        USING ERRCODE = '42501';



    END IF;







    -- Possession thay cho account_shared_users (cutover 02/08/2026). KHÔNG khoá
    -- dòng binding: hệ possession bất biến theo thời gian (thu hồi = đóng valid_to,
    -- không xoá dòng), nên hậu kiểm dưới đây đã đủ chặn revoke chạy song song.
    -- §9.2: CUSTODIAN/OPERATOR làm mọi loại phiếu, KNOWER chỉ Phiếu thu.
    SELECT EXISTS (
      SELECT 1
        FROM public.cashbook_possession_bindings b
        JOIN public.organization_memberships m ON m.id = b.membership_id
       WHERE b.cashbook_id = p_account_id
         AND b.organization_id = v_org
         AND m.user_id = v_actor
         AND m.status = 'ACTIVE'
         AND b.valid_to IS NULL
         AND (b.possession_kind IN ('CUSTODIAN','OPERATOR')
              OR (b.possession_kind = 'KNOWER' AND p_type = 'INCOME'))
    ) INTO v_account_is_shared;







    -- Cashbook ownership/sharing remains semantically authoritative until the



    -- normalized cashbooks.post resolver is complete. Building permission never



    -- implies use of an arbitrary same-organization cashbook, while account



    -- ownership/sharing never implies permission to create on the building.



    IF NOT (



      v_account_owner_id = v_actor



      OR v_account_is_shared



    ) THEN



      RAISE EXCEPTION 'Không có quyền sử dụng sổ quỹ này'



        USING ERRCODE = '42501';



    END IF;







  END IF;







  v_expected_type := CASE p_type WHEN 'INCOME' THEN 'income' ELSE 'expense' END;







  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)



  LOOP



    v_index := v_index + 1;



    IF jsonb_typeof(v_item) <> 'object' THEN



      RAISE EXCEPTION 'Hạng mục % phải là object', v_index;



    END IF;



    IF (v_item - ARRAY[



      'income_expense_type_id', 'description', 'quantity', 'unit_price', 'start_date', 'end_date'



    ]) <> '{}'::jsonb THEN



      RAISE EXCEPTION 'Hạng mục % chứa trường không được phép', v_index;



    END IF;



    IF NOT (v_item ? 'income_expense_type_id')



       OR jsonb_typeof(v_item->'income_expense_type_id') <> 'string' THEN



      RAISE EXCEPTION 'Loại thu/chi hạng mục % phải là UUID dạng chuỗi', v_index;



    END IF;



    IF NOT (v_item ? 'quantity')



       OR jsonb_typeof(v_item->'quantity') <> 'number' THEN



      RAISE EXCEPTION 'Số lượng hạng mục % phải là JSON number', v_index;



    END IF;



    IF NOT (v_item ? 'unit_price')



       OR jsonb_typeof(v_item->'unit_price') <> 'number' THEN



      RAISE EXCEPTION 'Đơn giá hạng mục % phải là JSON number', v_index;



    END IF;



    IF NOT (v_item ? 'start_date')



       OR jsonb_typeof(v_item->'start_date') <> 'string'



       OR v_item->>'start_date' !~ '^\d{4}-\d{2}-\d{2}$' THEN



      RAISE EXCEPTION 'Ngày bắt đầu hạng mục % phải là YYYY-MM-DD', v_index;



    END IF;



    IF NOT (v_item ? 'end_date')



       OR jsonb_typeof(v_item->'end_date') <> 'string'



       OR v_item->>'end_date' !~ '^\d{4}-\d{2}-\d{2}$' THEN



      RAISE EXCEPTION 'Ngày kết thúc hạng mục % phải là YYYY-MM-DD', v_index;



    END IF;



    IF v_item ? 'description'



       AND jsonb_typeof(v_item->'description') NOT IN ('string', 'null') THEN



      RAISE EXCEPTION 'Mô tả hạng mục % phải là chuỗi', v_index;



    END IF;







    BEGIN



      v_type_id := NULLIF(v_item->>'income_expense_type_id', '')::uuid;



      v_quantity := (v_item->>'quantity')::numeric;



      v_unit_price_raw := (v_item->>'unit_price')::numeric;



      v_unit_price := round(v_unit_price_raw, 2);



      v_start_date := (v_item->>'start_date')::date;



      v_end_date := (v_item->>'end_date')::date;



      v_description := NULLIF(btrim(v_item->>'description'), '');



    EXCEPTION



      WHEN invalid_text_representation



        OR invalid_datetime_format



        OR numeric_value_out_of_range



        OR datetime_field_overflow THEN



        RAISE EXCEPTION 'Hạng mục % có dữ liệu không hợp lệ', v_index;



    END;







    IF v_type_id IS NULL THEN



      RAISE EXCEPTION 'Hạng mục % thiếu loại thu/chi', v_index;



    END IF;



    IF v_description IS NOT NULL



       AND char_length(v_description) > c_max_item_description_length THEN



      RAISE EXCEPTION 'Mô tả hạng mục % vượt quá % ký tự',



        v_index, c_max_item_description_length;



    END IF;



    IF v_quantity IS NULL



       OR v_quantity::text IN ('NaN', 'Infinity', '-Infinity')



       OR v_quantity < 1



       OR v_quantity > 2147483647



       OR v_quantity <> trunc(v_quantity) THEN



      RAISE EXCEPTION 'Số lượng hạng mục % phải là số nguyên hợp lệ >= 1', v_index;



    END IF;



    -- Quantity is stored as integer; normalize numeric spelling before hashing.



    v_quantity := trunc(v_quantity);



    IF v_unit_price_raw IS NULL



       OR v_unit_price_raw::text IN ('NaN', 'Infinity', '-Infinity')



       OR v_unit_price_raw < 0



       OR v_unit_price < 0



       OR v_unit_price > c_max_money THEN



      RAISE EXCEPTION 'Đơn giá hạng mục % không hợp lệ', v_index;



    END IF;



    IF v_quantity * v_unit_price > c_max_money THEN



      RAISE EXCEPTION 'Thành tiền hạng mục % vượt giới hạn', v_index;



    END IF;



    IF v_start_date IS NULL



       OR v_end_date IS NULL



       OR NOT isfinite(v_start_date)



       OR NOT isfinite(v_end_date)



       OR v_start_date < DATE '2000-01-01'



       OR v_end_date > DATE '2100-12-31'



       OR v_start_date > v_end_date



       OR v_end_date - v_start_date > c_max_item_period_days THEN



      RAISE EXCEPTION 'Kỳ áp dụng hạng mục % phải nằm trong 2000-01-01..2100-12-31 và không quá % ngày',



        v_index, c_max_item_period_days;



    END IF;



    v_accrual_bucket_count := v_accrual_bucket_count



      + (



          extract(year FROM v_end_date)::integer * 12



          + extract(month FROM v_end_date)::integer



          - extract(year FROM v_start_date)::integer * 12



          - extract(month FROM v_start_date)::integer



          + 1



        );



    IF v_accrual_bucket_count > c_max_accrual_buckets THEN



      RAISE EXCEPTION 'Tổng số bucket dồn tích vượt giới hạn %', c_max_accrual_buckets



        USING ERRCODE = '54000';



    END IF;







    SELECT t.is_restricted, t.is_deposit, public.nrm_vn(t.name), t.system_only
      INTO v_type_is_restricted, v_type_is_deposit, v_type_normalized_name, v_type_system_only



      FROM public.income_expense_types t



     WHERE t.id = v_type_id



       AND lower(t.type) = v_expected_type



       AND t.organization_id = v_org



     FOR SHARE;



    IF NOT FOUND THEN



      RAISE EXCEPTION 'Loại hạng mục % không thuộc tổ chức hoặc sai chiều thu/chi', v_index



        USING ERRCODE = '42501';



    END IF;



    -- Chốt chặn tạo tay: đọc CỜ `system_only` trên hạng mục thay vì so khớp TÊN.
    -- Cờ đã được bật cho đúng 36 dòng bằng chính hai vị từ cũ (is_deposit +
    -- tên hoa hồng/thưởng), nên hành vi KHÔNG đổi — chỉ hết mong manh khi đổi tên.
    -- Chủ sở hữu bật/tắt được từng hạng mục ở Cài đặt mà không cần sửa hàm.
    IF coalesce(v_type_system_only, false) THEN
      RAISE EXCEPTION 'Hạng mục "%" chỉ được sinh từ hệ thống (hợp đồng/cọc/thanh lý/hoa hồng), không tạo tay từ màn Thu/Chi',
        (SELECT name FROM public.income_expense_types WHERE id = v_type_id)
        USING ERRCODE = '0A000';
    END IF;



    



    IF v_type_is_restricted THEN



      v_requires_restricted := true;



      IF NOT v_can_create_restricted THEN



        RAISE EXCEPTION 'Không có quyền tạo hạng mục thu/chi hạn chế'



          USING ERRCODE = '42501';



      END IF;



    END IF;







    v_total_amount := v_total_amount + (v_quantity * v_unit_price);



    IF v_total_amount > c_max_money THEN



      RAISE EXCEPTION 'Tổng tiền phiếu vượt giới hạn';



    END IF;







    -- Build the equality token from typed values, not caller UUID/date spelling.



    v_canonical_items := v_canonical_items || jsonb_build_array(



      jsonb_strip_nulls(jsonb_build_object(



        'income_expense_type_id', v_type_id,



        'description', v_description,



        'quantity', v_quantity,



        'unit_price', v_unit_price,



        'start_date', v_start_date,



        'end_date', v_end_date



      ))



    );



  END LOOP;







  v_canonical_payload := jsonb_strip_nulls(jsonb_build_object(



    'type', p_type,



    'name', v_name,



    'building_id', p_building_id,



    'room_id', v_room_id,



    'tenant_id', v_tenant_id,



    'contract_id', p_contract_id,



    'payer_name', NULLIF(btrim(p_payer_name), ''),



    'receive_bank_account', NULLIF(btrim(p_receive_bank_account), ''),



    'receive_bank_name', NULLIF(btrim(p_receive_bank_name), ''),



    'account_id', p_account_id,



    'attachments', v_attachments,



    'business_result_accounting', p_business_result_accounting,



    'notes', NULLIF(p_notes, ''),



    'voucher_date', p_voucher_date,



    'items', v_canonical_items



  ));



  -- md5(jsonb::text) is deterministic for PostgreSQL jsonb canonical key ordering;



  -- payload_hash is an equality token, not a password/signature.



  v_payload_hash := md5(v_canonical_payload::text);







  -- The unconditional unique claim is the linearization point. ON CONFLICT waits



  -- for an in-flight claimant: if it aborts this transaction becomes the claimant;



  -- if it commits the locked reread observes its immutable completion. Rollout state



  -- is deliberately not consulted until after that outcome is known.



  INSERT INTO app_private.canonical_write_operations (



    organization_id, operation, subject_scope, actor_id,



    idempotency_key, payload_hash



  ) VALUES (



    v_org, 'income_expense.create_draft.v1', p_building_id::text, v_actor,



    v_idempotency_key, v_payload_hash



  )



  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)



  DO NOTHING;







  SELECT *



    INTO v_operation



    FROM app_private.canonical_write_operations o



   WHERE o.organization_id = v_org



     AND o.operation = 'income_expense.create_draft.v1'



     AND o.subject_scope = p_building_id::text



     AND o.actor_id = v_actor



     AND o.idempotency_key = v_idempotency_key



   FOR UPDATE;



  IF NOT FOUND THEN



    RAISE EXCEPTION 'Không thể nhận diện operation idempotency đã claim'



      USING ERRCODE = '55000';



  END IF;



  IF v_operation.payload_hash <> v_payload_hash THEN



    RAISE EXCEPTION 'idempotency_key đã được dùng với payload khác'



      USING ERRCODE = '23505';



  END IF;







  -- Completed replay still requires current tenant authority, but it must not depend



  -- on mutable rollout admission, canary enrollment/caps, or the cashbook lock date.



  -- Platform-super status is intentionally irrelevant to tenant business authority.



  IF NOT EXISTS (



    SELECT 1



      FROM public.organization_memberships m



     WHERE m.id = v_membership_id



       AND m.organization_id = v_org



       AND m.user_id = v_actor



       AND m.status = 'ACTIVE'



       AND m.valid_from <= clock_timestamp()



       AND (m.valid_to IS NULL OR clock_timestamp() < m.valid_to)



  ) THEN



    RAISE EXCEPTION 'Tư cách thành viên đã hết hiệu lực'



      USING ERRCODE = '42501';



  END IF;



  IF NOT app_private.authorize_income_expense_on_building(



    v_actor, v_org, 'create', p_building_id



  ) THEN



    RAISE EXCEPTION 'Quyền tạo phiếu trên toà đã bị thu hồi'



      USING ERRCODE = '42501';



  END IF;



  IF v_requires_restricted



     AND NOT app_private.authorize_income_expense_on_building(



       v_actor, v_org, 'restricted_create', p_building_id



     ) THEN



    RAISE EXCEPTION 'Quyền tạo hạng mục hạn chế đã bị thu hồi'



      USING ERRCODE = '42501';



  END IF;



  IF p_account_id IS NOT NULL



     AND v_account_owner_id IS DISTINCT FROM v_actor



     AND NOT EXISTS (
         SELECT 1
           FROM public.cashbook_possession_bindings b
           JOIN public.organization_memberships m ON m.id = b.membership_id
          WHERE b.cashbook_id = p_account_id
            AND b.organization_id = v_org
            AND m.user_id = v_actor
            AND m.status = 'ACTIVE'
            AND b.valid_to IS NULL
            AND (b.possession_kind IN ('CUSTODIAN','OPERATOR')
                 OR (b.possession_kind = 'KNOWER' AND p_type = 'INCOME'))
       ) THEN



    RAISE EXCEPTION 'Quyền sử dụng sổ quỹ đã bị thu hồi'



      USING ERRCODE = '42501';



  END IF;







  IF v_operation.completed_at IS NOT NULL THEN



    SELECT *



      INTO v_row



      FROM jsonb_populate_record(



        NULL::public.income_expenses,



        v_operation.response_payload



      );



    IF v_row.id IS NULL OR v_row.id IS DISTINCT FROM v_operation.subject_id THEN



      RAISE EXCEPTION 'Kết quả idempotency không còn nhất quán';



    END IF;



    RETURN v_row;



  END IF;







  -- Only a new/pending claimant enters rollout admission. A completed operation above



  -- can therefore replay after OFF/freeze, enrollment removal, or window closure.



  SELECT *



    INTO v_feature



    FROM app_private.server_feature_flags f



   WHERE f.feature_key = 'income_expense.create_draft.v1'



   FOR SHARE;



  IF NOT FOUND THEN



    RAISE EXCEPTION 'Canonical writer chưa được cấu hình' USING ERRCODE = '55000';



  END IF;







  -- A CANARY enrollment used for admission must survive through commit. The shared



  -- feature lock freezes the release identity/configuration for this transaction.



  IF v_feature.mode = 'CANARY' THEN



    PERFORM 1



      FROM app_private.server_feature_flag_canary_orgs c



     WHERE c.feature_key = v_feature.feature_key



       AND c.organization_id = v_org



     FOR SHARE;



    IF NOT FOUND THEN



      RAISE EXCEPTION 'Tổ chức không còn trong canary'



        USING ERRCODE = '55000';



    END IF;



  END IF;







  v_feature_route := app_private.evaluate_feature_route(



    v_feature.feature_key, v_org



  );



  IF v_feature_route <> 'CANONICAL' THEN



    RAISE EXCEPTION 'Canonical writer chưa được bật hoặc đang đóng băng cho tổ chức này'



      USING ERRCODE = '55000';



  END IF;







  IF v_feature.mode = 'CANARY' THEN



    -- Serialize only one feature/config cap bucket; do not upgrade the shared row



    -- lock, which would deadlock concurrent readers and globally serialize ON mode.



    PERFORM pg_catalog.pg_advisory_xact_lock(



      pg_catalog.hashtextextended(



        v_feature.feature_key || ':' || v_feature.config_version::text,



        0



      )



    );



    v_feature_evaluated_at := clock_timestamp();



    IF v_feature.starts_at IS NULL



       OR v_feature.ends_at IS NULL



       OR NOT isfinite(v_feature.starts_at)



       OR NOT isfinite(v_feature.ends_at)



       OR v_feature.starts_at >= v_feature.ends_at



       OR v_feature_evaluated_at < v_feature.starts_at



       OR v_feature_evaluated_at >= v_feature.ends_at THEN



      RAISE EXCEPTION 'Cửa sổ canary không còn hiệu lực'



        USING ERRCODE = '55000';



    END IF;



    IF v_feature.max_single_amount_vnd::text IN ('NaN', 'Infinity', '-Infinity')



       OR v_feature.max_total_amount_vnd::text IN ('NaN', 'Infinity', '-Infinity')



       OR v_feature.max_operation_count <= 0



       OR v_feature.max_single_amount_vnd <= 0



       OR v_feature.max_total_amount_vnd <= 0 THEN



      RAISE EXCEPTION 'Hạn mức canary không hợp lệ'



        USING ERRCODE = '55000';



    END IF;



    IF v_total_amount > v_feature.max_single_amount_vnd THEN



      RAISE EXCEPTION 'Số tiền vượt cap canary cho một phiếu'



        USING ERRCODE = '54000';



    END IF;







    SELECT count(*), COALESCE(sum(o.amount_vnd), 0)



      INTO v_feature_operation_count, v_feature_total_amount



      FROM app_private.server_feature_flag_operations o



     WHERE o.feature_key = v_feature.feature_key



       AND o.config_version = v_feature.config_version;



    IF v_feature_operation_count >= v_feature.max_operation_count THEN



      RAISE EXCEPTION 'Đã hết số lượt canary' USING ERRCODE = '54000';



    END IF;



    IF v_feature_total_amount + v_total_amount > v_feature.max_total_amount_vnd THEN



      RAISE EXCEPTION 'Đã hết tổng hạn mức tiền canary' USING ERRCODE = '54000';



    END IF;



  END IF;







  -- Recheck expiring tenant authority after every idempotency, rollout, enrollment,



  -- and advisory-lock wait. Account lock_date is an effect-only rule: it is applied



  -- here for a new effect but was intentionally skipped by completed replay above.



  IF NOT EXISTS (



    SELECT 1



      FROM public.organization_memberships m



     WHERE m.id = v_membership_id



       AND m.organization_id = v_org



       AND m.user_id = v_actor



       AND m.status = 'ACTIVE'



       AND m.valid_from <= clock_timestamp()



       AND (m.valid_to IS NULL OR clock_timestamp() < m.valid_to)



  ) THEN



    RAISE EXCEPTION 'Tư cách thành viên đã hết hiệu lực'



      USING ERRCODE = '42501';



  END IF;



  IF NOT app_private.authorize_income_expense_on_building(



    v_actor, v_org, 'create', p_building_id



  ) THEN



    RAISE EXCEPTION 'Quyền tạo phiếu trên toà đã bị thu hồi'



      USING ERRCODE = '42501';



  END IF;



  IF v_requires_restricted



     AND NOT app_private.authorize_income_expense_on_building(



       v_actor, v_org, 'restricted_create', p_building_id



     ) THEN



    RAISE EXCEPTION 'Quyền tạo hạng mục hạn chế đã bị thu hồi'



      USING ERRCODE = '42501';



  END IF;



  IF p_account_id IS NOT NULL THEN



    IF v_account_owner_id IS DISTINCT FROM v_actor



       AND NOT EXISTS (
         SELECT 1
           FROM public.cashbook_possession_bindings b
           JOIN public.organization_memberships m ON m.id = b.membership_id
          WHERE b.cashbook_id = p_account_id
            AND b.organization_id = v_org
            AND m.user_id = v_actor
            AND m.status = 'ACTIVE'
            AND b.valid_to IS NULL
            AND (b.possession_kind IN ('CUSTODIAN','OPERATOR')
                 OR (b.possession_kind = 'KNOWER' AND p_type = 'INCOME'))
       ) THEN



      RAISE EXCEPTION 'Quyền sử dụng sổ quỹ đã bị thu hồi'



        USING ERRCODE = '42501';



    END IF;



    IF v_account_lock_date IS NOT NULL AND p_voucher_date <= v_account_lock_date THEN



      RAISE EXCEPTION 'Sổ quỹ đã khoá tại ngày phiếu';



    END IF;



  END IF;







  IF v_feature.mode = 'CANARY' THEN



    v_feature_operation_key := md5(concat_ws(



      '|',



      'income_expense.create_draft.v1',



      v_org::text,



      p_building_id::text,



      v_actor::text,



      v_idempotency_key



    ));



    INSERT INTO app_private.server_feature_flag_operations (



      feature_key, config_version, operation_key, organization_id, amount_vnd



    ) VALUES (



      v_feature.feature_key, v_feature.config_version, v_feature_operation_key,



      v_org, v_total_amount



    );



  END IF;







  -- Deliberately unresolved: the final T3 containment contract must supply a



  -- server-owned canonical-flow marker that exists at draft creation time. Neither



  -- approval_request_id (NULL before submit) nor the private idempotency ledger is an



  -- acceptable provenance marker. Keep this function revoked until the replacement



  -- source writes that marker atomically with the header and legacy transition guards



  -- reject marked rows.



    -- t5_23/24: chọn trạng thái sinh — auto-duyệt TRỪ hạng mục đặc biệt (cờ
  -- force_approval, gồm hoàn cọc/thanh lý/lương/LN/HH/thưởng...) và TRỪ phiếu
  -- CHI từ ngưỡng cài đặt trở lên (app_private.ie_auto_approve_config; chưa
  -- đặt ngưỡng = tự duyệt như cũ). Phiếu không tự duyệt sinh ở NHÁP chờ duyệt tay.
  SELECT bool_or(coalesce(t.force_approval, false))
    INTO v_force_cat
    FROM jsonb_array_elements(p_items) AS it
    JOIN public.income_expense_types t
      ON t.id = (it->>'income_expense_type_id')::uuid;
  SELECT c.threshold INTO v_auto_threshold
    FROM app_private.ie_auto_approve_config c
   WHERE c.organization_id = v_org;
  -- Chủ sở hữu chốt 2026-07-25: NGƯỜI LẬP PHIẾU MÀ CÓ QUYỀN DUYỆT thì phiếu
  -- tự duyệt ngay lúc tạo, không qua Nháp và không chờ ai. Kiểm bằng mô hình
  -- quyền canonical (app_private.can_v3) — không đọc JSONB legacy.
  -- income_expenses.approve khai required_dimensions=['BUILDING'] nên phiếu không
  -- gắn toà phải hỏi dạng "có quyền ở bất kỳ đâu".
  v_maker_can_approve := CASE
    WHEN p_building_id IS NOT NULL
      THEN app_private.can_v3('income_expenses.approve', p_building_id)
    ELSE app_private.has_any_scope_v3('income_expenses.approve')
  END;

  IF coalesce(v_maker_can_approve, false) THEN
    v_birth_status := 'APPROVED';
  ELSIF p_type = 'INCOME' THEN
    -- Chủ sở hữu chốt 2026-07-27: MỌI phiếu THU tự duyệt + ghi sổ ngay khi
    -- tạo, kể cả hạng mục Tiền Cọc bên thu. Cờ force_approval và ngưỡng
    -- chi chỉ còn áp cho phiếu CHI (hoàn cọc, thanh lý, hoa hồng, lương…).
    v_birth_status := 'APPROVED';
  ELSIF coalesce(v_force_cat, false) THEN
    v_birth_status := 'UNAPPROVED';
  ELSIF p_type = 'EXPENSE' AND v_auto_threshold IS NOT NULL
        AND v_total_amount >= v_auto_threshold THEN
    v_birth_status := 'UNAPPROVED';
  ELSE
    v_birth_status := 'APPROVED';
  END IF;
  -- G5 (26/09/2026): hỏi bộ máy chi — một luật cho mọi cửa chi, đọc luật khai trên hạng mục.
  -- Chỉ ÁP khi cờ spend.engine.v1 = ON và mọi bucket của phiếu đã bật; còn lại giữ thang trên.
  IF p_type = 'EXPENSE' THEN
    v_spend_gate := app_private.ie_spend_gate_v1(
      v_org, p_building_id, 'EXPENSE', 'create_income_expense_v1', NULL, p_account_id,
      p_voucher_date,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'type_id', it->>'income_expense_type_id',
                'amount', COALESCE(NULLIF(it->>'quantity', '')::numeric, 0)
                          * COALESCE(NULLIF(it->>'unit_price', '')::numeric, 0),
                'start_date', it->>'start_date',
                'end_date', it->>'end_date')), '[]'::jsonb)
         FROM jsonb_array_elements(v_canonical_items) AS it));
    IF COALESCE((v_spend_gate->>'enforce')::boolean, false) THEN
      v_birth_status := v_spend_gate->>'status';
    END IF;
  END IF;

  IF v_birth_status = 'APPROVED' THEN
    v_birth_by := v_actor; v_birth_at := now();
  ELSE
    v_birth_by := NULL; v_birth_at := NULL;
  END IF;

  INSERT INTO public.income_expenses (



    user_id, creator_name, organization_id,



    type, name, building_id, room_id, tenant_id, contract_id,



    payer_name, receive_bank_account, receive_bank_name, account_id,



    attachments, business_result_accounting, notes,



    repeat_cycle, repeat_infinity, repeat_count, repeat_auto_approve,



    repeat_remaining, repeat_next_date,



    voucher_date, approval_status, approved_by, approved_at,



    source_payload_hash, system_source



  ) VALUES (



    v_actor, v_actor_name, v_org,



    p_type, v_name, p_building_id, v_room_id, v_tenant_id, NULL,



    NULLIF(btrim(p_payer_name), ''), NULLIF(btrim(p_receive_bank_account), ''),



    NULLIF(btrim(p_receive_bank_name), ''), p_account_id,



    v_attachments, p_business_result_accounting, NULLIF(p_notes, ''),



    'NONE', false, 0, false,



    0, NULL,



    p_voucher_date, v_birth_status, v_birth_by, v_birth_at,



    v_payload_hash, NULL



  )



  RETURNING * INTO v_row;







  INSERT INTO public.income_expense_items (



    income_expense_id, income_expense_type_id, description,



    quantity, unit_price, start_date, end_date, organization_id



  )



  SELECT



    v_row.id,



    (item->>'income_expense_type_id')::uuid,



    item->>'description',



    (item->>'quantity')::integer,



    (item->>'unit_price')::numeric,



    (item->>'start_date')::date,



    (item->>'end_date')::date,



    v_org



  FROM jsonb_array_elements(v_canonical_items) AS x(item);







  -- Keep the parent detached while non-deposit/non-commission items are inserted.



  -- The legacy item trigger otherwise recomputes any historical approved deposit on



  -- the contract and churns contracts.updated_at even though this draft has no deposit.



  -- Commission flows are excluded above and retain their specialized writer because



  -- their invariants require contract_id on the header before item insertion.



  IF p_contract_id IS NOT NULL THEN



    UPDATE public.income_expenses



       SET contract_id = p_contract_id



     WHERE id = v_row.id



       AND contract_id IS NULL;



    IF NOT FOUND THEN



      RAISE EXCEPTION 'Không thể gắn hợp đồng đã xác thực vào phiếu nháp'



        USING ERRCODE = '23514';



    END IF;



  END IF;







  SELECT * INTO v_row FROM public.income_expenses WHERE id = v_row.id;







  SELECT count(*), COALESCE(sum(it.amount), 0),
         COALESCE(bool_or(t.is_restricted), false),
         COALESCE(sum(COALESCE(it.amount, it.unit_price * it.quantity))
           FILTER (WHERE it.accounting_class = 'PNL'), 0),
         COALESCE(bool_or(t.is_deposit), false)
    INTO v_stored_item_count, v_stored_total_amount, v_stored_has_restricted,
         v_stored_pnl_sum, v_stored_has_deposit_item



    FROM public.income_expense_items it



    JOIN public.income_expense_types t ON t.id = it.income_expense_type_id



   WHERE it.income_expense_id = v_row.id;



  -- Kỳ vọng phải MIRROR public.recompute_ie_business_result: khi caller không
  -- ép business_result_accounting, KQKD suy từ hạng mục (item accounting_class),
  -- KHÔNG mặc định là toàn bộ số tiền. Công thức cũ giả định NULL => (true, total)
  -- nên MỌI phiếu có hạng mục cọc (accounting_class='DEPOSIT') đều văng 23514 —
  -- đó là lý do phiếu thu tiền cọc chưa bao giờ đi qua được writer canonical.
  v_stored_kqkd_amount := CASE
    WHEN p_business_result_accounting IS TRUE THEN v_total_amount
    WHEN p_business_result_accounting IS FALSE THEN 0
    WHEN v_item_count = 0 THEN v_total_amount
    ELSE GREATEST(LEAST(v_stored_pnl_sum, v_total_amount), 0)
  END;
  v_stored_counts_in_business_result := (v_stored_kqkd_amount > 0);



  IF v_stored_item_count <> v_item_count



     OR v_stored_total_amount IS DISTINCT FROM v_total_amount



     OR v_row.total_amount IS DISTINCT FROM v_total_amount



     OR v_row.has_restricted_item IS DISTINCT FROM v_stored_has_restricted



     OR v_row.counts_in_business_result IS DISTINCT FROM v_stored_counts_in_business_result



     OR v_row.kqkd_amount IS DISTINCT FROM v_stored_kqkd_amount THEN



    RAISE EXCEPTION 'Trigger thu/chi không tạo đúng các trường tài chính suy diễn'



      USING ERRCODE = '23514';



  END IF;







  -- Generic non-deposit drafts must not reconcile pre-existing deposit or room



  -- reservation state. The earlier row locks make any difference attributable to



  -- this statement; aborting here rolls back the complete writer transaction.



  IF p_contract_id IS NOT NULL THEN
    SELECT c.deposit_paid, c.updated_at
      INTO v_contract_deposit_paid_after, v_contract_updated_at_after
      FROM public.contracts c
     WHERE c.id = p_contract_id;

    -- NỚI ĐÚNG MỘT KHE (án 29/07/2026): phiếu MANG item hạng mục cọc thì
    -- recompute_contract_deposit_paid CHẠY LÀ ĐÚNG THIẾT KẾ — cấm nó tức là cấm
    -- luôn lớp phiếu mà 20260727120000 vừa mở cửa cho writer canonical. Vẫn bắt
    -- writer chứng minh: giá trị sau cùng phải bằng SỐ DẪN XUẤT chuẩn, không
    -- phải số tuỳ ý. Phiếu KHÔNG có item cọc vẫn cấm tuyệt đối như cũ.
    IF (
      v_contract_deposit_paid_after IS DISTINCT FROM v_contract_deposit_paid_before
      OR v_contract_updated_at_after IS DISTINCT FROM v_contract_updated_at_before
    ) AND NOT (
      v_stored_has_deposit_item
      AND v_contract_deposit_paid_after
            IS NOT DISTINCT FROM public.contract_deposit_paid_derived(p_contract_id)
    ) THEN
      RAISE EXCEPTION 'Writer phiếu nháp tổng quát đã tác động trạng thái tiền cọc hợp đồng'
        USING ERRCODE = '23514';
    END IF;
  END IF;



  IF v_room_id IS NOT NULL THEN
    SELECT r.status, r.updated_at
      INTO v_room_status_after, v_room_updated_at_after
      FROM public.rooms r
     WHERE r.id = v_room_id;

    -- Cùng một án với hậu kiểm hợp đồng ở trên: phiếu THU cọc GIỮ CHỖ (có item
    -- hạng mục cọc, CHƯA gắn HĐ) có NHIỆM VỤ khoá phòng — recompute_room_reservation
    -- lật AVAILABLE -> RESERVED. Nới đúng khe đó, và vẫn bắt writer chứng minh
    -- trạng thái mới khớp predicate chuẩn room_has_holding_deposit. Mọi chuyển
    -- dịch khác (RESERVED -> AVAILABLE, đụng OCCUPIED/MAINTENANCE, hay chỉ bump
    -- updated_at) vẫn là writer đụng nhầm state có sẵn => abort như cũ.
    IF (
      v_room_status_after IS DISTINCT FROM v_room_status_before
      OR v_room_updated_at_after IS DISTINCT FROM v_room_updated_at_before
    ) AND NOT (
      v_stored_has_deposit_item
      AND v_row.type = 'INCOME'
      AND v_row.contract_id IS NULL
      AND v_room_status_before = 'AVAILABLE'
      AND v_room_status_after = 'RESERVED'
      AND public.room_has_holding_deposit(v_room_id)
    ) THEN
      RAISE EXCEPTION 'Writer phiếu nháp tổng quát đã tác động trạng thái giữ phòng'
        USING ERRCODE = '23514';
    END IF;
  END IF;







  -- The shared feature-row lock and, for CANARY, shared enrollment lock keep the



  -- admitted rollout identity stable. Re-evaluate only the time boundary here:



  -- counting the reservation we just inserted as a new admission would reject the



  -- exact final permitted count slot (count = max) after its effects were built.



  IF v_feature.mode = 'CANARY' AND (



    clock_timestamp() < v_feature.starts_at



    OR clock_timestamp() >= v_feature.ends_at



  ) THEN



    RAISE EXCEPTION 'Cửa sổ canary đã đóng trước khi hoàn tất'



      USING ERRCODE = '55000';



  END IF;







  -- =========================================================================



  -- T3 CLAIM (A.2 integration point): after construction + invariants +



  -- canary time recheck; before audit append and operation completion.



  -- A.9 smallest-shape: this wrapper is SECURITY DEFINER owned by postgres (so



  -- auth access + INVOKER triggers resolve on Supabase). Capability is proven by



  -- a transaction-local token stamped by a postgres-owned DEFINER setter that no



  -- app role can call, then echoed to the claim. (Replaces the unreachable



  -- current_user='ie_canonical_writer' gate — see t3_12.)



  -- =========================================================================



  v_claim_cap := app_private.grant_ie_claim_capability_v1();



  PERFORM app_private.claim_canonical_income_expense_draft_v1(



    v_row.id, v_idempotency_key, v_claim_cap);



  SELECT * INTO v_row FROM public.income_expenses WHERE id = v_row.id;







  -- A.5: canonical audit goes through the single hash-chain primitive; the



  -- audit-log writer-monopoly guard rejects any direct unchained INSERT.



  PERFORM app_private.append_income_expense_event_v1(



    v_org, v_row.id, 'CREATED_DRAFT', v_actor, v_actor_name,



    NULL, v_birth_status,
    CASE WHEN v_birth_status = 'APPROVED'
         THEN 'Tạo phiếu TỰ DUYỆT (ngoài hạng mục đặc biệt, dưới ngưỡng)'
         ELSE 'Tạo phiếu NHÁP chờ duyệt (hạng mục đặc biệt hoặc chi vượt ngưỡng)' END);







  UPDATE app_private.canonical_write_operations



     SET subject_id = v_row.id,



         response_payload = to_jsonb(v_row),



         completed_at = now()



   WHERE organization_id = v_org



     AND operation = 'income_expense.create_draft.v1'



     AND subject_scope = p_building_id::text



     AND actor_id = v_actor



     AND idempotency_key = v_idempotency_key;







  RETURN v_row;



END;



$function$;

-- 5. pay_period_fee — trang Thanh toán, phí cố định.
CREATE OR REPLACE FUNCTION public.pay_period_fee(p_building_id uuid, p_category_key text, p_amount numeric, p_period_start text, p_period_end text, p_voucher_date date DEFAULT NULL::date, p_provider_code text DEFAULT NULL::text, p_account_holder text DEFAULT NULL::text, p_account_id uuid DEFAULT NULL::uuid, p_attachments jsonb DEFAULT NULL::jsonb, p_force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner    uuid;
  v_acc      uuid;
  v_type     uuid;
  v_caller   text;
  v_label    text;
  v_vdate    date;
  v_p_start  date;
  v_p_end    date;
  v_months   int;
  v_period   text;
  v_voucher  uuid;
  v_code     text;
  v_total    numeric;
  v_dup_amt  numeric;
  v_dup_cnt  int;
  v_org      uuid;      -- Slice −1 B3
  v_is_super boolean := false;
  v_is_owner boolean := false;
  -- SPECIAL_FEE_AUTOPOST_V1
  v_rule     jsonb;
  v_verdict  text;
  v_posting  uuid;
  v_spend_gate jsonb;  -- G5 26/09/2026: cổng bộ máy chi
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Số tiền phải lớn hơn 0';
  END IF;
  IF p_period_start !~ '^\d{4}-\d{2}$' OR p_period_end !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Kỳ không hợp lệ (cần YYYY-MM)';
  END IF;
  IF p_period_start > p_period_end THEN
    RAISE EXCEPTION 'Kỳ bắt đầu phải trước hoặc bằng kỳ kết thúc';
  END IF;
  IF p_category_key NOT IN ('tien_nha','dien','nuoc','internet','quan_ly','ve_sinh','cong_an','rac','thang_may') THEN
    RAISE EXCEPTION 'Hạng mục phí không hợp lệ: %', p_category_key;
  END IF;

  SELECT b.user_id, b.organization_id INTO v_owner, v_org FROM buildings b
   WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà'; END IF;
  IF NOT (public.can_access_building(p_building_id)
          OR public.ie_all_buildings_scope(p_building_id)
          OR v_owner = auth.uid()
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên toà này' USING ERRCODE = '42501';
  END IF;

  IF p_category_key = 'quan_ly' AND NOT public.can_create_restricted_ie() THEN
    RAISE EXCEPTION 'Bạn không có quyền tạo phiếu hạng mục hạn chế' USING ERRCODE = '42501';
  END IF;

  v_p_start := to_date(p_period_start || '-01', 'YYYY-MM-DD');
  v_p_end   := (date_trunc('month', to_date(p_period_end || '-01', 'YYYY-MM-DD')) + interval '1 month - 1 day')::date;
  v_months  := (extract(YEAR FROM age(date_trunc('month', v_p_end), date_trunc('month', v_p_start))) * 12
               + extract(MONTH FROM age(date_trunc('month', v_p_end), date_trunc('month', v_p_start))))::int + 1;

  -- 31/08 (audit P3-04): kẹp trần KHỚP CLIENT (setN 1–36). Trước đây v_months
  -- tính ra rồi không dùng — caller gọi RPC trực tiếp ghi được accrual trải
  -- hàng trăm tháng mà không lớp nào chặn.
  IF v_months > 36 THEN
    RAISE EXCEPTION 'Khoảng kỳ tối đa 36 tháng (đang chọn % tháng) — chia nhỏ đợt đóng.', v_months;
  END IF;

  -- ══ Slice −1 B3: KHOÁ SLOT TRƯỚC KHI ĐO ═══════════════════════════
  -- Phép đo dưới đây là SELECT-rồi-INSERT trần: hai cú bấm song song (hai bề
  -- mặt của /thanh-toan, hai tab, double-click) cùng đọc v_dup_cnt = 0 rồi cùng
  -- ghi ⇒ chốt chống trùng vô hiệu đúng ở khe đua. pay_utility_bill đã lấy khoá
  -- tư vấn cho đúng lý do này (mục 1); pay_period_fee thì chưa, nên bổ sung
  -- cùng khuôn. Khoá cấp transaction ⇒ tự nhả khi commit/rollback, và chỉ xếp
  -- hàng ĐÚNG một slot (org × toà × hạng mục × tháng bắt đầu), không serialize
  -- cả bảng. COALESCE quanh v_org là bắt buộc: pg_advisory_xact_lock STRICT,
  -- truyền NULL là KHÔNG lấy khoá nào mà vẫn trả về êm.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'fixed_fee:' || COALESCE(v_org::text, '-') || ':' || p_building_id::text || ':'
        || p_category_key || ':' || to_char(v_p_start, 'YYYY-MM'),
      0
    )
  );

  -- ══ Slice −1 B3: ĐO ĐẶC QUYỀN "Đóng thêm" NGAY, KỂ CẢ KHI KHÔNG p_force ═══
  -- Hai cờ này phải tính TRƯỚC nhánh trùng, vì payload cảnh báo trùng còn phải
  -- trả `can_force` cho giao diện. Nếu để trong `IF p_force` thì client phải TỰ
  -- đoán mình có quyền hay không — và đó chính là gốc lỗi đang vá: giao diện đoán
  -- bằng is_admin() (nay chỉ còn = is_super_admin()) nên CHỦ TỔ CHỨC THẬT bị nhắc
  -- "phải nhờ chủ tổ chức". Server là nơi DUY NHẤT biết câu trả lời, nên server
  -- nói ra. Cả hai hàm đều STABLE/không lấy khoá dòng ⇒ gọi thêm ở đây không tạo
  -- đường 25006 nào (pay_period_fee vẫn VOLATILE).
  v_is_super := public.is_super_admin();
  v_is_owner := app_private.is_org_owner_v1(v_org, auth.uid());

  -- ── CHỐNG ĐÓNG TRÙNG: đã có phiếu cùng hạng mục giao kỳ? ──
  -- 31/08 (audit P3-04, chỉ SỬA LỜI cho khớp code — hành vi giữ nguyên): phép
  -- đếm lấy approval_status <> 'CANCELLED', tức GỒM CẢ phiếu UNAPPROVED chờ
  -- duyệt — phiếu chờ duyệt là phiếu người khác KHÔNG thấy trên các bảng lọc
  -- APPROVED, chính là nguyên nhân người thứ hai tạo lại (cùng lý do
  -- get_voucher_slot_warning_v1 đếm cả UNAPPROVED). Comment cũ nói "phiếu
  -- APPROVED" và "(Chưa mở rộng sang UNAPPROVED)" là tả một bản đã không còn.
  -- Slice −1: phép ĐO chạy luôn, kể cả khi p_force — sổ vết phải ghi được
  -- "ghi đè lên mấy phiếu, tổng bao nhiêu". Trước đây cả khối này nằm trong
  -- IF NOT p_force nên "Đóng thêm" đi qua trong bóng tối.
  SELECT COALESCE(SUM(d.total_amount), 0), COUNT(*)
    INTO v_dup_amt, v_dup_cnt
    FROM (
      SELECT DISTINCT ie.id, ie.total_amount
        FROM income_expense_items it
        JOIN income_expense_types t ON t.id = it.income_expense_type_id
                                   AND t.type = 'expense'
                                   AND public.fee_type_matches(p_category_key, t.category, t.name)
        JOIN income_expenses ie ON ie.id = it.income_expense_id
                               AND ie.building_id = p_building_id
                               AND ie.type = 'EXPENSE'
                               AND ie.approval_status <> 'CANCELLED'
                               AND ie.deleted_at IS NULL
       WHERE it.start_date <= v_p_end AND it.end_date >= v_p_start
    ) d;

  IF p_force THEN
    -- ══ Slice −1 B3: "Đóng thêm" là quyền của CHỦ ═══════════════════
    -- ⚠ ĐÍNH CHÍNH ATTRIBUTION (đo lại 30/07, đừng để bản nháp cũ dẫn sai):
    -- 24 slot phí cố định trùng / 49 lượt phiếu / 620.496.725đ trên production
    -- KHÔNG có slot nào do hàm này sinh ra. Phân rã theo system_source:
    --     21 slot  → system_source NULL   (đường tạo phiếu CHUNG bên Thu chi)
    --      3 slot  → 'utility.bill'       (đã bịt bằng khoá + chốt ở mục 1; và
    --                                      xem ĐÍNH CHÍNH ở đầu file — 2 trong 3
    --                                      là hai công tơ thật bị gán chung)
    --      0 slot  → 'fixed_fee'          (hàm này đóng dấu 'fixed_fee' vô điều
    --                                      kiện, và cả DB chỉ có ĐÚNG 2 phiếu
    --                                      'fixed_fee': PC2607111 300.000đ và
    --                                      PC2607117 900.000đ, khác toà, khác
    --                                      tiền — không phải một cặp trùng)
    -- Cặp 66.000.000đ 'tiền nhà' 102LVT cách nhau 460ms (created_at
    -- 2026-06-07T05:15:09.361412Z / …821586Z) mang system_source = NULL,
    -- idempotency_key NULL ⇒ KHÔNG do pay_period_fee, cũng KHÔNG do lưới phí cố
    -- định của /thanh-toan. Vậy B3 + khoá slot ở trên là chống trùng CHO LẦN GHI
    -- MỚI của chính hàm này (và bịt khe đua chưa từng có ai bịt), TUYỆT ĐỐI
    -- KHÔNG được ghi nhận là "đã bịt lỗ 24 slot/49 lượt phiếu" — writer tạo phiếu
    -- chung (system_source NULL) vẫn chưa có bất kỳ chốt slot nào và không thuộc
    -- phạm vi slice này.
    -- ĐÃ PHÂN LOẠI 24 ô đó theo "số tiền có bằng nhau không" (30/07) để slice sau
    -- thiết kế đúng, KHÔNG chặn oan:
    --   • 4 ô SỐ TIỀN BẰNG NHAU, tất cả 'tien_nha', tất cả system_source NULL:
    --       102LVT 06/2026 66.000.000×2 — cách 460 ms, MỘT người  ⇒ bấm đôi
    --       32PVC  07/2026 26.000.000×2 — cách ~13,9 giờ, HAI người
    --       405PVB 07/2026 52.500.000×2 — cách ~8,4 ngày,  HAI người
    --       15KV   07/2026 20.000.000×2 — cách ~9,4 ngày,  HAI người
    --     Tổng 164.500.000đ. HAI BỆNH KHÁC NHAU: 1 ca bấm đôi (chữa bằng chống
    --     phát lại / idempotency_key) và 3 ca hai người cùng trả một tháng tiền
    --     nhà (chữa bằng CẢNH BÁO mức ô, không phải khoá thời gian).
    --   • 20 ô SỐ TIỀN KHÁC NHAU ⇒ HỢP LỆ, TUYỆT ĐỐI KHÔNG ĐƯỢC CHẶN. Ví dụ
    --     405PVB công an 07/2026 = 1.000.000đ + 7.000đ; 15KV rác 06/2026 =
    --     300.000đ + 120.000đ. Khoá cứng theo ô sẽ chặn oan 20/24 trường hợp.
    --   Công cụ đã có sẵn nhưng chưa dùng: cột income_expenses.idempotency_key
    --   tồn tại, 42 phiếu có key và cả 42 key phân biệt ⇒ tạo được partial UNIQUE
    --   INDEX ngay với 0 xung đột — NHƯNG hiện KHÔNG có unique index nào trên cột
    --   đó (key chỉ là trang trí) và writer thủ công chỉ gửi key ở 28/1.239 phiếu
    --   (2,3 %). Đó là hạng mục của slice sau, không phải của Slice −1.
    -- (v_is_super / v_is_owner đã tính ở trên — chúng còn phải đi vào payload
    -- cảnh báo trùng dưới dạng `can_force`.)
    IF NOT (v_is_super OR v_is_owner) THEN
      RAISE EXCEPTION
        '[FIXED_FEE_FORCE_DENIED] "Đóng thêm" (ghi đè chốt chống trùng) chỉ dành cho chủ tổ chức hoặc super admin. Kỳ này đang có % phiếu đã duyệt, tổng %đ. Hãy duyệt/huỷ phiếu cũ, hoặc nhờ chủ tổ chức bấm. Nếu kỳ này thực sự chưa có phiếu nào thì bấm "Đóng" bình thường.',
        v_dup_cnt::text,
        round(COALESCE(v_dup_amt, 0))::bigint::text
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_dup_cnt > 0 THEN
    -- `can_force`: MỘT định nghĩa duy nhất của "được đóng thêm", do server phát
    -- ngôn. Giao diện chỉ dùng nó để quyết định mở hộp thoại "Đóng thêm" hay chỉ
    -- báo lỗi — nó KHÔNG phải hàng rào (hàng rào là nhánh `IF p_force` ở trên,
    -- siết theo ĐÚNG org của toà). Client cũ không đọc khoá này vẫn chạy nguyên.
    RETURN jsonb_build_object(
      'warning', 'duplicate',
      'existing_count', v_dup_cnt,
      'existing_amount', v_dup_amt,
      'can_force', (v_is_super OR v_is_owner));
  END IF;

  -- Sổ ghi chi
  IF p_account_id IS NOT NULL THEN
    SELECT id INTO v_acc FROM accounts
     WHERE id = p_account_id AND deleted_at IS NULL
       AND (user_id = auth.uid() OR public.is_admin() OR public.is_super_admin());
    IF v_acc IS NULL THEN
      RAISE EXCEPTION 'Sổ quỹ không hợp lệ hoặc bạn không có quyền ghi chi vào sổ này' USING ERRCODE = '42501';
    END IF;
  ELSE
    -- 31/08 (audit P2-07): ưu tiên SỔ MẶC ĐỊNH toà×hạng mục chủ đã cấu hình
    -- (building_fee_accounts.default_account_id — chính hàm này học first-write-
    -- wins ở INSERT bên dưới) TRƯỚC heuristic tên '%Thu'. Trang CHI tiền nhảy
    -- vào sổ tên "Thu" là nghịch nghĩa; sổ mặc định vẫn phải qua đúng vị ngữ
    -- quyền dùng sổ như nhánh p_account_id (không mượn sổ user khác trừ admin).
    SELECT a.id INTO v_acc
      FROM building_fee_accounts fa
      JOIN accounts a ON a.id = fa.default_account_id AND a.deleted_at IS NULL
     WHERE fa.building_id = p_building_id AND fa.fee_category = p_category_key
       AND fa.deleted_at IS NULL
       AND (a.user_id = auth.uid() OR public.is_admin() OR public.is_super_admin());
    IF v_acc IS NULL THEN
      SELECT id INTO v_acc FROM accounts
       WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'
       ORDER BY is_default DESC NULLS LAST, name LIMIT 1;
    END IF;
    IF v_acc IS NULL THEN
      RAISE EXCEPTION 'Chọn sổ quỹ trước khi đóng — bạn chưa có sổ mặc định cho ô này (chọn sổ ngay trên dòng, hoặc cấu hình sổ mặc định của toà ở Cài đặt phí).';
    END IF;
  END IF;

  v_type := public.resolve_fixed_expense_type(v_owner, p_category_key);
  UPDATE income_expense_types SET is_deposit = FALSE
   WHERE id = v_type AND is_deposit IS DISTINCT FROM FALSE;

  v_vdate  := COALESCE(p_voucher_date, public.org_today_v1(NULL));
  v_period := CASE WHEN p_period_start = p_period_end
                   THEN to_char(v_p_start, 'MM/YYYY')
                   ELSE to_char(v_p_start, 'MM/YYYY') || '–' || to_char(v_p_end, 'MM/YYYY') END;

  v_label := CASE p_category_key
    WHEN 'tien_nha'  THEN 'Tiền nhà'
    WHEN 'dien'      THEN 'Điện'
    WHEN 'nuoc'      THEN 'Nước'
    WHEN 'internet'  THEN 'Internet'
    WHEN 'quan_ly'   THEN 'Quản lý'
    WHEN 've_sinh'   THEN 'Vệ sinh tòa nhà'
    WHEN 'cong_an'   THEN 'Công an'
    WHEN 'rac'       THEN 'Rác'
    WHEN 'thang_may' THEN 'Bảo trì thang máy'
  END;

  SELECT COALESCE(full_name, '') INTO v_caller FROM profiles WHERE id = auth.uid();

  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name,
     attachments, system_source)
  VALUES
    (auth.uid(), 'EXPENSE',
     v_label || ' — kỳ ' || v_period,
     p_building_id, v_acc, v_vdate,
     p_amount, 'UNAPPROVED', TRUE,
     'Đóng ' || lower(v_label) || ' — kỳ ' || v_period
       || COALESCE(' — mã ' || NULLIF(btrim(p_provider_code), ''), '')
       || COALESCE(' — ' || NULLIF(btrim(p_account_holder), ''), ''),
     v_caller,
     COALESCE(p_attachments, '[]'::jsonb), 'fixed_fee')
  RETURNING id INTO v_voucher;

  -- p_amount = TỔNG cả khoảng (đã chốt); accrual chia đều theo start/end.
  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES
    (v_voucher, v_type, v_label || ' kỳ ' || v_period, 1, p_amount, v_p_start, v_p_end);

  -- Học cấu hình: default_amount PER-KỲ + sổ mặc định (first-write-wins cho sổ)
  INSERT INTO building_fee_accounts
    (building_id, fee_category, provider_code, account_holder, default_amount, default_account_id, user_id)
  VALUES
    (p_building_id, p_category_key,
     NULLIF(btrim(p_provider_code), ''), NULLIF(btrim(p_account_holder), ''),
     NULL, v_acc, v_owner)
  ON CONFLICT (building_id, fee_category) WHERE deleted_at IS NULL
  DO UPDATE SET
    provider_code      = COALESCE(NULLIF(btrim(EXCLUDED.provider_code), ''),  building_fee_accounts.provider_code),
    account_holder     = COALESCE(NULLIF(btrim(EXCLUDED.account_holder), ''), building_fee_accounts.account_holder),
    default_amount     = COALESCE(EXCLUDED.default_amount, building_fee_accounts.default_amount),
    default_account_id = COALESCE(building_fee_accounts.default_account_id, EXCLUDED.default_account_id),
    updated_at = now();

  -- Slice −1 B3: mọi lần "Đóng thêm" đều để lại vết, kể cả khi đo ra 0 phiếu.
  IF p_force THEN
    INSERT INTO app_private.period_fee_force_events
      (organization_id, building_id, category_key, period_start, period_end,
       amount, existing_count, existing_amount, voucher_id,
       actor_user_id, actor_is_super_admin, actor_is_org_owner)
    VALUES
      (v_org, p_building_id, p_category_key, p_period_start, p_period_end,
       p_amount, COALESCE(v_dup_cnt, 0), COALESCE(v_dup_amt, 0), v_voucher,
       auth.uid(), v_is_super, v_is_owner);
  END IF;

  -- SPECIAL_FEE_AUTOPOST_V1: đúng luật thì máy duyệt hộ và ghi sổ luôn.
  --   VALID           = số tiền khớp giá chủ đã công bố cho đúng các tháng của kỳ.
  --   CONFIG_REQUIRED = chủ chưa công bố giá ô này ⇒ GIỮ NGUYÊN HÀNH VI CŨ (vẫn
  --                     tự duyệt). Cố ý không chặn: hôm nay còn rất nhiều ô chưa
  --                     khai giá, chặn cứng là cả hệ hết đóng tiền được.
  --   AMOUNT_MISMATCH = đã công bố giá mà số đang chi lệch ⇒ để phiếu CHỜ DUYỆT.
  v_rule := app_private.special_fee_rule_check_v1(
              v_org, p_building_id, p_category_key, v_p_start, v_p_end, p_amount);
  v_verdict := v_rule->>'verdict';

  -- G5 (26/09/2026): hỏi bộ máy chi; phiếu đã có nên loại chính nó khỏi phần đã tiêu.
  -- Cổng chưa áp (cờ chưa ON / bucket chưa bật) ⇒ giữ nguyên luật SPECIAL_FEE_AUTOPOST_V1.
  v_spend_gate := app_private.ie_spend_gate_v1(
    v_org, p_building_id, 'EXPENSE', 'pay_period_fee', 'fixed_fee', v_acc, v_vdate,
    jsonb_build_array(jsonb_build_object('type_id', v_type, 'amount', p_amount,
                                         'start_date', v_p_start, 'end_date', v_p_end)),
    v_voucher);
  IF COALESCE((v_spend_gate->>'enforce')::boolean, false) THEN
    IF v_spend_gate->>'status' = 'APPROVED' THEN
      v_posting := app_private.special_fee_approve_and_post_v1(v_voucher, 'SPECIAL_PAGE_FEE');
    END IF;
  ELSIF v_verdict IN ('VALID', 'CONFIG_REQUIRED') THEN
    v_posting := app_private.special_fee_approve_and_post_v1(v_voucher, 'SPECIAL_PAGE_FEE');
  END IF;

  SELECT code, total_amount INTO v_code, v_total FROM income_expenses WHERE id = v_voucher;

  RETURN jsonb_build_object(
    'voucher_id', v_voucher, 'code', v_code,
    'total_amount', v_total, 'account_id', v_acc,
    'rule', v_rule,
    'spend_decision', v_spend_gate - 'facts',
    'auto_approved', (v_posting IS NOT NULL),
    'posting_id', v_posting,
    'status_note', CASE
      WHEN COALESCE((v_spend_gate->>'enforce')::boolean, false)
        THEN 'Bộ máy chi: ' || app_private.spend_reason_vi_v1(v_spend_gate->>'reason')
             || CASE WHEN v_posting IS NOT NULL THEN ' — phiếu đã duyệt và vào sổ.'
                     ELSE ' — phiếu đã tạo và đang CHỜ DUYỆT.' END
      WHEN v_posting IS NOT NULL AND v_verdict = 'VALID'
        THEN 'Đúng giá đã công bố — phiếu đã duyệt và vào sổ.'
      WHEN v_posting IS NOT NULL
        THEN 'Toà này chưa công bố giá cho hạng mục — phiếu vẫn được duyệt và vào sổ như trước.'
      ELSE COALESCE(v_rule->>'reason', 'Phiếu đang chờ duyệt.')
           || ' Phiếu đã tạo và đang CHỜ DUYỆT.'
    END);
END;
$function$;

-- 6. pay_utility_bill — trang Thanh toán, điện nước.
CREATE OR REPLACE FUNCTION public.pay_utility_bill(p_building_id uuid, p_utility_type text, p_amount numeric, p_period_month text, p_voucher_date date DEFAULT NULL::date, p_provider_code text DEFAULT NULL::text, p_account_holder text DEFAULT NULL::text, p_account_id uuid DEFAULT NULL::uuid, p_attachments jsonb DEFAULT NULL::jsonb, p_utility_account_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private'
AS $function$
DECLARE
  v_owner   uuid;
  v_acc     uuid;
  v_meter   uuid;
  v_type    uuid;
  v_caller  text;
  v_type_nm text;
  v_vdate   date;
  v_p_start date;
  v_p_end   date;
  v_voucher uuid;
  v_code    text;
  v_total   numeric;
  v_org     uuid;        -- t5_28: org của toà để đọc ngưỡng
  v_threshold numeric;   -- ngưỡng tự duyệt phiếu chi (nếu có)
  v_status  text;        -- trạng thái sinh theo ngưỡng
  v_appr_by uuid;
  v_appr_at timestamptz;
  v_spend_gate jsonb;   -- G5 26/09/2026: cổng bộ máy chi
  v_kind_vn text;        -- Slice −1: "điện"/"nước" cho câu lỗi
  v_dup_code   text;     -- Slice −1 B1: phiếu đã có của đúng slot này
  v_dup_amount numeric;
  v_dup_status text;
  v_meter_code text;     -- Slice −1 B1: mã khách hàng của công tơ ĐANG chọn
  v_meter_cnt  int;      -- Slice −1 B1: số công tơ cùng loại của toà (>1 thì gợi ý chọn lại)
  v_ceiling jsonb;       -- 28/08: verdict trần điện/nước (utility_ceiling_check_v1)
  v_ceiling_verdict text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  IF p_utility_type NOT IN ('ELECTRIC','WATER') THEN RAISE EXCEPTION 'Loại tiện ích không hợp lệ'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Số tiền phải lớn hơn 0'; END IF;
  IF p_period_month !~ '^\d{4}-\d{2}$' THEN RAISE EXCEPTION 'Kỳ không hợp lệ (cần YYYY-MM)'; END IF;

  v_kind_vn := CASE WHEN p_utility_type = 'ELECTRIC' THEN 'điện' ELSE 'nước' END;

  SELECT b.user_id, b.organization_id INTO v_owner, v_org
    FROM buildings b WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà'; END IF;
  IF NOT (public.can_access_building(p_building_id) OR public.ie_all_buildings_scope(p_building_id)
          OR v_owner = auth.uid() OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên toà này' USING ERRCODE = '42501';
  END IF;

  -- ══ Slice −1 B2: KHÔNG tự tạo công tơ nữa ══════════════════════════
  -- Nhánh ELSE cũ INSERT một dòng building_utility_accounts mới mỗi lần
  -- p_utility_account_id NULL. Giao diện gửi NULL cho MỌI toà/loại chưa khai
  -- công tơ (dòng tổng hợp accountId=null), nên một cú bấm check bình thường
  -- là sinh công tơ trong im lặng; và vì map "đã đóng" khoá theo id công tơ,
  -- dòng vừa sinh không bao giờ hiện "đã đóng" ⇒ mời người dùng bấm lại.
  -- Chặn ở đây là chặn cả hai hệ quả bằng một câu.
  IF p_utility_account_id IS NULL THEN
    RAISE EXCEPTION
      '[UTILITY_METER_REQUIRED] Toà này chưa khai công tơ % — hãy khai công tơ (mã khách hàng / chủ hộ) rồi đóng tiền cho đúng công tơ. Trước đây hệ thống tự tạo công tơ mới mỗi lần bấm, nên dòng đó không bao giờ hiện "đã đóng" và tiền đóng hai lần không ai thấy.',
      v_kind_vn
      USING ERRCODE = '22023';
  END IF;

  SELECT id, NULLIF(btrim(COALESCE(provider_code, '')), '')
    INTO v_meter, v_meter_code
    FROM building_utility_accounts
   WHERE id = p_utility_account_id AND building_id = p_building_id
     AND utility_type = p_utility_type AND deleted_at IS NULL;
  IF v_meter IS NULL THEN RAISE EXCEPTION 'Không tìm thấy đồng hồ điện/nước'; END IF;

  -- Slice −1 B1: toà có MẤY công tơ cùng loại? Cần cho câu lỗi chống trùng.
  -- Ca thật 1392QT: HAI hợp đồng điện riêng (PE13000241972 và PE13000241924,
  -- cùng chủ hộ Hoàng Công Hiệp), mỗi tháng là một hoá đơn lớn + một hoá đơn nhỏ.
  -- Không nói rõ công tơ nào thì người dùng đọc "kỳ này đã có phiếu" sẽ tưởng
  -- mình bấm trùng, trong khi thực tế họ đang trả hoá đơn của công tơ CÒN LẠI.
  SELECT count(*) INTO v_meter_cnt
    FROM building_utility_accounts
   WHERE building_id = p_building_id AND utility_type = p_utility_type
     AND deleted_at IS NULL;

  v_p_start := to_date(p_period_month || '-01', 'YYYY-MM-DD');
  v_p_end   := (date_trunc('month', v_p_start) + interval '1 month - 1 day')::date;

  -- ══ Slice −1 B1: MỘT PHIẾU / MỘT CÔNG TƠ / MỘT KỲ ═════════════════
  -- Khoá tư vấn theo đúng slot TRƯỚC khi đọc: SELECT-rồi-INSERT trần bị đua
  -- (hai tab, hai lần bấm, hai transaction cùng thấy "chưa có" rồi cùng ghi).
  -- Khoá cấp transaction nên tự nhả khi commit/rollback, và chỉ xếp hàng đúng
  -- một slot — không serialize cả bảng.
  -- COALESCE quanh v_org là bắt buộc: pg_advisory_xact_lock STRICT, truyền NULL
  -- thì nó trả NULL và KHÔNG lấy khoá nào — mất chống-đua trong im lặng.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'utility.bill:' || COALESCE(v_org::text, '-') || ':' || v_meter::text || ':'
        || p_utility_type || ':' || to_char(v_p_start, 'YYYY-MM'),
      0
    )
  );

  -- Khoá nghiệp vụ = (org, công tơ, loại tiện ích, tháng tính tiền). Không cần
  -- viết org và loại vào WHERE: id công tơ QUYẾT ĐỊNH cả hai (công tơ thuộc
  -- đúng một toà, và ở trên đã kiểm building_id + utility_type khớp) — thêm
  -- `organization_id = v_org` vào đây chỉ tạo nguy cơ BỎ SÓT nếu có phiếu cũ
  -- org NULL, tức tự vô hiệu hoá chính chốt này.
  -- Tháng lấy từ ITEM (income_expenses không có cột kỳ); date_trunc để chịu
  -- được 19 phiếu lịch sử có start_date không nằm ngày 1.
  -- CỐ Ý ĐẾM CẢ 'UNAPPROVED': phiếu chờ duyệt là phiếu VÔ HÌNH trên bảng
  -- điện/nước (reader lọc APPROVED) — đó chính là lý do người dùng bấm lại.
  -- KHÔNG đếm phiếu đã huỷ: huỷ mềm (cancel_utility_bill đặt deleted_at) hoặc
  -- huỷ linh hoạt Đợt 4 (approval_status='CANCELLED') ⇒ đóng lại được.
  SELECT ie.code, ie.total_amount, ie.approval_status
    INTO v_dup_code, v_dup_amount, v_dup_status
    FROM income_expenses ie
   WHERE ie.system_source = 'utility.bill'
     AND ie.utility_account_id = v_meter
     AND ie.deleted_at IS NULL
     AND ie.approval_status <> 'CANCELLED'
     AND EXISTS (
       SELECT 1 FROM income_expense_items it
        WHERE it.income_expense_id = ie.id
          AND it.start_date IS NOT NULL
          AND date_trunc('month', it.start_date)::date = v_p_start
     )
   ORDER BY ie.created_at, ie.id
   LIMIT 1;

  IF v_dup_code IS NOT NULL THEN
    RAISE EXCEPTION
      '[UTILITY_BILL_DUPLICATE] Kỳ % của công tơ % ĐÃ CÓ phiếu chi % — %đ (%). Không tạo phiếu thứ hai. Nếu phiếu cũ đang chờ duyệt thì DUYỆT nó; nếu phiếu cũ sai thì HUỶ nó rồi đóng lại.%',
      to_char(v_p_start, 'MM/YYYY'),
      COALESCE(v_meter_code, 'này'),
      v_dup_code,
      round(COALESCE(v_dup_amount, 0))::bigint::text,
      CASE v_dup_status WHEN 'UNAPPROVED' THEN 'đang chờ duyệt' ELSE 'đã duyệt' END,
      -- Gợi ý chỉ hiện khi toà THẬT SỰ có nhiều công tơ cùng loại — nếu không thì
      -- thêm câu này chỉ làm người dùng đi tìm một công tơ không tồn tại.
      CASE WHEN COALESCE(v_meter_cnt, 1) > 1
           THEN format(' Lưu ý: toà này có %s công tơ %s. Nếu hoá đơn bạn đang trả thuộc công tơ khác thì hãy chọn đúng công tơ đó rồi đóng lại.',
                       v_meter_cnt, v_kind_vn)
           ELSE '' END
      USING ERRCODE = '55000';
  END IF;

  -- Sổ ghi chi (mặc định "…Thu" caller)
  IF p_account_id IS NOT NULL THEN
    SELECT id INTO v_acc FROM accounts
     WHERE id = p_account_id AND deleted_at IS NULL
       AND (user_id = auth.uid() OR public.is_admin() OR public.is_super_admin());
    IF v_acc IS NULL THEN RAISE EXCEPTION 'Sổ quỹ không hợp lệ hoặc bạn không có quyền ghi chi vào sổ này' USING ERRCODE = '42501'; END IF;
  ELSE
    SELECT id INTO v_acc FROM accounts
     WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'
     ORDER BY is_default DESC NULLS LAST, name LIMIT 1;
    IF v_acc IS NULL THEN RAISE EXCEPTION 'Bạn chưa có sổ quỹ "…Thu" để chi tiền'; END IF;
  END IF;

  -- Học siêu dữ liệu công tơ — dời xuống SAU chốt chống trùng để một lần bấm
  -- bị từ chối không để lại thay đổi nào.
  UPDATE building_utility_accounts SET
    provider_code  = COALESCE(NULLIF(btrim(p_provider_code), ''), provider_code),
    account_holder = COALESCE(NULLIF(btrim(p_account_holder), ''), account_holder),
    updated_at = now()
  WHERE id = v_meter;

  -- t5_28: hoá đơn điện/nước là phiếu CHI → tôn trọng NGƯỠNG tự duyệt của org.
  -- Dưới ngưỡng (hoặc chưa đặt ngưỡng) → tự duyệt như cũ; từ ngưỡng trở lên →
  -- sinh NHÁP chờ duyệt tay (khớp phương án owner + create_income_expense_v1).
  --
  -- 26/08/2026: NGƯỜI LẬP PHIẾU MÀ CÓ QUYỀN DUYỆT đi thẳng, không qua ngưỡng.
  -- Đây đúng là luật chủ đã chốt 25/07/2026 cho create_income_expense_v1 (biến
  -- v_maker_can_approve), nhưng nó chưa bao giờ được áp cho hai RPC của trang
  -- Thanh toán. Hệ quả đo được: cùng một số tiền, nhập tay ở form Thu chi thì
  -- tự duyệt, còn bấm nút đóng tiền ở /thanh-toan lại sinh phiếu CHỜ DUYỆT rồi
  -- bắt chính người có quyền duyệt sang màn hình khác bấm lần hai.
  --
  -- Ngưỡng KHÔNG bị nới: nó giữ nguyên cho người không có quyền duyệt — đó mới
  -- là đối tượng nó sinh ra để soát.
  SELECT c.threshold INTO v_threshold
    FROM app_private.ie_auto_approve_config c WHERE c.organization_id = v_org;
  IF COALESCE(app_private.ie_maker_can_approve_v1(p_building_id), false) THEN
    v_status := 'APPROVED'; v_appr_by := auth.uid(); v_appr_at := now();
  ELSIF v_threshold IS NOT NULL AND p_amount >= v_threshold THEN
    v_status := 'UNAPPROVED'; v_appr_by := NULL; v_appr_at := NULL;
  ELSE
    v_status := 'APPROVED'; v_appr_by := auth.uid(); v_appr_at := now();
  END IF;

  -- ══ 28/08 — TRẦN ĐIỆN/NƯỚC (nối động cơ 20260801040000 vào writer) ═════
  -- Động cơ utility_ceiling_check_v1 tồn tại từ 01/08 nhưng KHÔNG writer nào
  -- gọi — trần chủ công bố là hình vẽ. Từ nay: phiếu VƯỢT TRẦN thì hạ về CHỜ
  -- DUYỆT, kể cả người-có-quyền-duyệt (họ duyệt được ngay sau đó, nhưng phải
  -- NHÌN cảnh báo một lần — trần sinh ra để bắt người nhìn số bất thường, và
  -- người bấm nhanh nhất chính là người có quyền). Không có trần (NO_RULE) ⇒
  -- hành vi y như cũ. KHÔNG chặn cứng: sai trần thì tệ nhất là chờ duyệt.
  v_ceiling := app_private.utility_ceiling_check_v1(
                 v_org, p_building_id, p_utility_type, v_p_start, p_amount);
  v_ceiling_verdict := COALESCE(v_ceiling->>'verdict', 'NO_RULE');
  IF v_ceiling_verdict IN ('OVER_CEILING', 'OVER_RATIO') THEN
    v_status := 'UNAPPROVED'; v_appr_by := NULL; v_appr_at := NULL;
  END IF;

  v_type_nm := CASE WHEN p_utility_type = 'ELECTRIC' THEN 'Đóng tiền điện' ELSE 'Đóng tiền nước' END;
  v_type := public._termination_ensure_type(v_owner, 'expense', v_type_nm);
  UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type AND is_deposit IS DISTINCT FROM FALSE;
  -- G5 (26/09/2026): hỏi bộ máy chi (kiểu TRẦN của hạng mục điện/nước). Cổng chưa áp ⇒ giữ
  -- nguyên thang ngưỡng + trần ở trên. Không đụng khối INSERT mẫu neo bên dưới.
  v_spend_gate := app_private.ie_spend_gate_v1(
    v_org, p_building_id, 'EXPENSE', 'pay_utility_bill', 'utility.bill', v_acc,
    COALESCE(p_voucher_date, public.org_today_v1(NULL)),
    jsonb_build_array(jsonb_build_object('type_id', v_type, 'amount', p_amount,
                                         'start_date', v_p_start, 'end_date', v_p_end)));
  IF COALESCE((v_spend_gate->>'enforce')::boolean, false) THEN
    IF v_spend_gate->>'status' = 'APPROVED' THEN
      v_status := 'APPROVED'; v_appr_by := auth.uid(); v_appr_at := now();
    ELSE
      v_status := 'UNAPPROVED'; v_appr_by := NULL; v_appr_at := NULL;
    END IF;
  END IF;

  v_vdate   := COALESCE(p_voucher_date, public.org_today_v1(NULL));
  SELECT COALESCE(full_name, '') INTO v_caller FROM profiles WHERE id = auth.uid();

  -- ⚠ HAI DÒNG DƯỚI LÀ MẪU NEO của 20260724120000 — giữ VERBATIM (mục 5 tự kiểm).
  INSERT INTO income_expenses
    (user_id, organization_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, approved_by, approved_at,
     business_result_accounting, notes, creator_name,
     attachments, system_source, utility_account_id)
  VALUES
    (auth.uid(), v_org, 'EXPENSE',
     'Đóng ' || lower(v_type_nm) || ' (NCC) — kỳ ' || to_char(v_p_start, 'MM/YYYY'),
     p_building_id, v_acc, v_vdate,
     p_amount, v_status, v_appr_by, v_appr_at, TRUE,
     'Chủ nhà đóng ' || lower(v_type_nm) || ' cho cả toà — kỳ ' || to_char(v_p_start, 'MM/YYYY')
       || COALESCE(' — mã ' || NULLIF(btrim(p_provider_code), ''), '')
       || COALESCE(' — chủ hộ ' || NULLIF(btrim(p_account_holder), ''), ''),
     v_caller,
     COALESCE(p_attachments, '[]'::jsonb), 'utility.bill', v_meter)
  RETURNING id INTO v_voucher;

  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES
    (v_voucher, v_type, 'Đóng ' || lower(v_type_nm) || ' kỳ ' || to_char(v_p_start, 'MM/YYYY'),
     1, p_amount, v_p_start, v_p_end);

  -- Vượt trần: nối lý do vào ghi chú SAU insert — khối INSERT là MẪU NEO của
  -- 20260724120000, không được sửa một ký tự nào trong đó.
  IF v_ceiling_verdict IN ('OVER_CEILING', 'OVER_RATIO') THEN
    UPDATE income_expenses
       SET notes = notes || ' — [VƯỢT TRẦN ' || v_kind_vn || '] '
                 || COALESCE(v_ceiling->>'reason', 'vượt trần đã công bố')
                 || ' — phiếu chuyển CHỜ DUYỆT.'
     WHERE id = v_voucher;
  END IF;

  SELECT code, total_amount INTO v_code, v_total FROM income_expenses WHERE id = v_voucher;
  RETURN jsonb_build_object('voucher_id', v_voucher, 'code', v_code,
    'total_amount', v_total, 'account_id', v_acc, 'utility_account_id', v_meter,
    'ceilingVerdict', v_ceiling_verdict,
    'spendDecision', v_spend_gate - 'facts');
END;
$function$;

-- 7. generate_special_fees_v1 — sinh phí cố định hàng loạt.
CREATE OR REPLACE FUNCTION public.generate_special_fees_v1(p_period text, p_building_ids uuid[], p_idempotency_key text, p_account_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_m0    date;
  v_m1    date;
  v_route text;
  v_key   text := btrim(COALESCE(p_idempotency_key,''));
  r       record;
  v_type  uuid;
  v_ie    uuid;
  v_code  text;
  v_n     int := 0;
  v_sum   numeric := 0;
  v_ids   uuid[] := '{}';
  v_label text;
  -- SPECIAL_FEE_AUTOPOST_V1
  v_acc      uuid;
  v_posted   int := 0;
  v_rule     jsonb;
  v_spend_gate jsonb;  -- G5 26/09/2026: cổng bộ máy chi
BEGIN
  -- Sổ quỹ (tuỳ chọn): có thì máy duyệt hộ + ghi sổ; không có thì y như cũ.
  IF p_account_id IS NOT NULL THEN
    SELECT a.id INTO v_acc FROM public.accounts a
     WHERE a.id = p_account_id AND a.deleted_at IS NULL
       AND NOT COALESCE(a.is_virtual, false);
    IF v_acc IS NULL THEN
      RAISE EXCEPTION 'Sổ quỹ không hợp lệ hoặc là SỔ ẢO — phí cố định là tiền thật ra khỏi két'
        USING ERRCODE = '22023';
    END IF;
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_period !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Kỳ không hợp lệ (cần YYYY-MM)' USING ERRCODE='22023';
  END IF;
  IF char_length(v_key) < 8 OR char_length(v_key) > 200
     OR v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII an toàn' USING ERRCODE='22023';
  END IF;
  IF p_building_ids IS NULL OR array_length(p_building_ids,1) IS NULL THEN
    RAISE EXCEPTION 'Phải chọn ít nhất một toà' USING ERRCODE='22023';
  END IF;

  v_m0 := to_date(p_period || '-01','YYYY-MM-DD');
  v_m1 := (date_trunc('month', v_m0) + interval '1 month - 1 day')::date;

  SELECT b.organization_id INTO v_org FROM buildings b
   WHERE b.id = p_building_ids[1] AND b.deleted_at IS NULL;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà' USING ERRCODE='22023'; END IF;

  -- Mọi toà phải cùng org — không cho một lượt sinh chéo tổ chức.
  IF EXISTS (SELECT 1 FROM buildings b
              WHERE b.id = ANY(p_building_ids)
                AND (b.deleted_at IS NOT NULL OR b.organization_id IS DISTINCT FROM v_org)) THEN
    RAISE EXCEPTION 'Danh sách toà có toà đã xoá hoặc thuộc tổ chức khác' USING ERRCODE='42501';
  END IF;

  -- ROUTE OFF: cỗ máy này tự đẻ phiếu hàng loạt nên phải có công tắc riêng.
  v_route := app_private.evaluate_feature_route('special_fee.generate.v1', v_org);
  IF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION
      'Tính năng sinh phiếu phí cố định hàng loạt chưa được bật cho tổ chức này (route %). Bật cờ special_fee.generate.v1 rồi thử lại.',
      v_route USING ERRCODE = '55000';
  END IF;

  -- Khoá theo (org, kỳ): hai người bấm cùng lúc thì xếp hàng, không đẻ hai lượt.
  PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended('special_fee:'||v_org::text||':'||p_period, 0));

  FOR r IN
    SELECT * FROM public.preview_special_fees_v1(p_period, p_building_ids)
     WHERE status = 'SẼ_SINH'
  LOOP
    -- Quyền theo từng toà — preview đã lọc, nhưng writer không tin preview.
    IF NOT (public.can_access_building(r.building_id)
         OR public.ie_all_buildings_scope(r.building_id)
         OR public.is_admin() OR public.is_super_admin()) THEN
      CONTINUE;
    END IF;
    IF r.fee_category = 'quan_ly' AND NOT public.can_create_restricted_ie() THEN
      CONTINUE;   -- hạng mục hạn chế: bỏ qua thay vì làm hỏng cả lượt
    END IF;

    v_label := CASE r.fee_category
                 WHEN 'tien_nha' THEN 'Tiền nhà'   WHEN 'dien' THEN 'Tiền điện'
                 WHEN 'nuoc' THEN 'Tiền nước'      WHEN 'internet' THEN 'Internet'
                 WHEN 'quan_ly' THEN 'Quản Lý'     WHEN 've_sinh' THEN 'Vệ sinh định kỳ'
                 WHEN 'cong_an' THEN 'Công An'     WHEN 'rac' THEN 'Rác'
                 ELSE 'Thang máy' END;

    -- G5 (26/09/2026): dùng hạng mục đã ánh xạ (G3) cho khoá phí — luật chi đọc trên chính
    -- hạng mục đó; khoá chưa ánh xạ mới rơi về tìm/tạo theo tên như cũ.
    SELECT t.id INTO v_type FROM public.income_expense_types t
     WHERE t.organization_id = v_org AND t.fee_category = r.fee_category;
    IF v_type IS NULL THEN
      v_type := app_private.ensure_income_expense_type_v1(
                  v_org, v_actor, v_label, 'expense', NULL, NULL, false, false,
                  (r.fee_category = 'quan_ly'), false, false, false);
    END IF;

    INSERT INTO income_expenses
      (user_id, organization_id, type, name, building_id, voucher_date,
       total_amount, approval_status, system_source, notes)
    VALUES
      (v_actor, v_org, 'EXPENSE',
       v_label || ' ' || r.building_name || ' kỳ ' || p_period,
       r.building_id, public.org_today_v1(v_org),
       r.amount, 'UNAPPROVED', 'special_fee.v1',
       'Sinh tự động cho kỳ ' || p_period)
    RETURNING id, code INTO v_ie, v_code;

    INSERT INTO income_expense_items
      (income_expense_id, income_expense_type_id, accounting_class,
       description, quantity, unit_price, amount, start_date, end_date)
    VALUES
      (v_ie, v_type, 'PNL', 'Kỳ ' || p_period, 1, r.amount, r.amount, v_m0, v_m1);

    INSERT INTO special_fee_claims
      (organization_id, building_id, fee_category, period_month, amount,
       voucher_id, generated_by, batch_key)
    VALUES (v_org, r.building_id, r.fee_category, v_m0, r.amount, v_ie, v_actor, v_key);

    IF v_acc IS NOT NULL THEN
      UPDATE income_expenses SET account_id = v_acc WHERE id = v_ie;
      v_rule := app_private.special_fee_rule_check_v1(
                  v_org, r.building_id, r.fee_category, v_m0, v_m1, r.amount);
      -- G5 (26/09/2026): hỏi bộ máy chi; cổng chưa áp ⇒ giữ luật SPECIAL_FEE_AUTOPOST_V1.
      v_spend_gate := app_private.ie_spend_gate_v1(
        v_org, r.building_id, 'EXPENSE', 'generate_special_fees_v1', 'special_fee.v1', v_acc,
        public.org_today_v1(v_org),
        jsonb_build_array(jsonb_build_object('type_id', v_type, 'amount', r.amount,
                                             'start_date', v_m0, 'end_date', v_m1)),
        v_ie);
      IF COALESCE((v_spend_gate->>'enforce')::boolean, false) THEN
        IF v_spend_gate->>'status' = 'APPROVED' THEN
          PERFORM app_private.special_fee_approve_and_post_v1(v_ie, 'SPECIAL_PAGE_FEE');
          v_posted := v_posted + 1;
        END IF;
      ELSIF (v_rule->>'verdict') IN ('VALID', 'CONFIG_REQUIRED') THEN
        PERFORM app_private.special_fee_approve_and_post_v1(v_ie, 'SPECIAL_PAGE_FEE');
        v_posted := v_posted + 1;
      END IF;
    END IF;

    v_n := v_n + 1; v_sum := v_sum + r.amount; v_ids := v_ids || v_ie;
  END LOOP;

  RETURN jsonb_build_object(
    'period', p_period, 'organizationId', v_org, 'batchKey', v_key,
    'created', v_n, 'totalAmount', v_sum, 'voucherIds', to_jsonb(v_ids),
    'posted', v_posted,
    'note', CASE WHEN v_acc IS NULL
      THEN 'Phiếu sinh ra ở trạng thái CHỜ DUYỆT — máy đề xuất, người duyệt.'
      ELSE v_posted || '/' || v_n || ' phiếu đã tự duyệt và vào sổ; phần còn lại chờ duyệt vì lệch giá đã công bố.'
    END);
END;
$function$;

-- 8. generate_recurring_vouchers — cron phiếu định kỳ.
CREATE OR REPLACE FUNCTION public.generate_recurring_vouchers(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(parent_id uuid, child_id uuid, voucher_date date)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  parent   RECORD;
  v_child  uuid;
  v_target date;
  k        int;
  v_total  int;
  v_status text;   -- G5 26/09/2026
  v_gate   jsonb;  -- G5 26/09/2026: cổng bộ máy chi
BEGIN
  FOR parent IN
    SELECT *
    FROM income_expenses ie
    WHERE ie.repeat_cycle <> 'NONE'
      AND ie.deleted_at IS NULL
      AND ie.repeat_parent_id IS NULL
      AND ie.approval_status = 'APPROVED'
      AND (p_user_id IS NULL OR ie.user_id = p_user_id)
      AND (ie.repeat_infinity OR ie.repeat_count > 0)
  LOOP
    k := 1;
    LOOP
      v_target := public.add_cycle(parent.voucher_date, parent.repeat_cycle, k);

      EXIT WHEN v_target > public.org_today_v1(NULL);
      EXIT WHEN (NOT parent.repeat_infinity) AND k > parent.repeat_count;
      EXIT WHEN k > 240;

      IF NOT EXISTS (
        SELECT 1 FROM income_expenses c
        WHERE c.repeat_parent_id = parent.id
          AND c.voucher_date = v_target
          AND c.deleted_at IS NULL
      ) THEN
        BEGIN
          -- G5 (26/09/2026): phiếu con định kỳ cũng hỏi bộ máy chi. Cổng chưa áp ⇒ y như cũ
          -- (theo repeat_auto_approve của phiếu cha).
          v_status := CASE WHEN parent.repeat_auto_approve THEN 'APPROVED' ELSE 'UNAPPROVED' END;
          IF parent.type = 'EXPENSE' AND parent.organization_id IS NOT NULL THEN
            v_gate := app_private.ie_spend_gate_v1(
              parent.organization_id, parent.building_id, 'EXPENSE', 'generate_recurring_vouchers', NULL,
              CASE WHEN parent.repeat_auto_approve THEN parent.account_id ELSE NULL END,
              v_target,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'type_id', ii.income_expense_type_id,
                        'amount', ii.quantity * ii.unit_price,
                        'start_date', v_target, 'end_date', v_target)), '[]'::jsonb)
                 FROM income_expense_items ii WHERE ii.income_expense_id = parent.id),
              NULL,
              jsonb_build_object('recurring_auto_approve', parent.repeat_auto_approve));
            IF COALESCE((v_gate->>'enforce')::boolean, false) THEN
              v_status := v_gate->>'status';
            END IF;
          END IF;
          INSERT INTO income_expenses (
            user_id, type, name, building_id, room_id, tenant_id,
            contract_id, account_id, payer_name,
            approval_status, approved_at, approved_by,
            business_result_accounting, counts_in_business_result,
            attachments, notes,
            receive_bank_name, receive_bank_account,
            creator_name,
            voucher_date, invoice_id, repeat_parent_id,
            repeat_cycle, repeat_infinity, repeat_count, repeat_remaining
          ) VALUES (
            parent.user_id, parent.type,
            parent.name || ' (tự động lập)',
            parent.building_id, parent.room_id, parent.tenant_id,
            NULL,
            -- DRAFT MODE: sổ trống + NHÁP, điền sổ/ảnh khi thanh toán thật
            CASE WHEN parent.repeat_auto_approve THEN parent.account_id ELSE NULL END,
            parent.payer_name,
            v_status,
            CASE WHEN v_status = 'APPROVED' THEN now() ELSE NULL END,
            CASE WHEN v_status = 'APPROVED' THEN parent.user_id ELSE NULL END,
            parent.business_result_accounting, parent.counts_in_business_result,
            parent.attachments, parent.notes,
            parent.receive_bank_name, parent.receive_bank_account,
            parent.creator_name,
            v_target, NULL, parent.id,
            'NONE', false, 0, 0
          ) RETURNING id INTO v_child;

          INSERT INTO income_expense_items (
            income_expense_id, income_expense_type_id,
            description, quantity, unit_price, start_date, end_date
          )
          SELECT v_child, ii.income_expense_type_id,
                 ii.description, ii.quantity, ii.unit_price, v_target, v_target
          FROM income_expense_items ii
          WHERE ii.income_expense_id = parent.id;

          RETURN QUERY SELECT parent.id, v_child, v_target;
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'recurring child skipped parent=% date=%: %', parent.id, v_target, SQLERRM;
        END;
      END IF;

      k := k + 1;
    END LOOP;

    SELECT count(*) INTO v_total
    FROM income_expenses c
    WHERE c.repeat_parent_id = parent.id AND c.deleted_at IS NULL;

    BEGIN
      UPDATE income_expenses
      SET repeat_remaining = CASE
            WHEN parent.repeat_infinity THEN 0
            ELSE GREATEST(0, parent.repeat_count - v_total)
          END,
          repeat_next_date = CASE
            WHEN parent.repeat_infinity OR v_total < parent.repeat_count
              THEN public.add_cycle(parent.voucher_date, parent.repeat_cycle, v_total + 1)
            ELSE NULL
          END
      WHERE id = parent.id;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'recurring bookkeeping skipped parent=%: %', parent.id, SQLERRM;
    END;
  END LOOP;
END;
$function$;

-- 9. Tự kiểm: 5 cửa đều gọi cổng; mẫu neo pay_utility_bill còn nguyên; ACL không nới.
DO $sau$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.create_income_expense_v1(text,text,uuid,uuid,uuid,uuid,text,text,text,uuid,jsonb,boolean,text,date,jsonb,text)',
    'public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)',
    'public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid)',
    'public.generate_special_fees_v1(text,uuid[],text,uuid)',
    'public.generate_recurring_vouchers(uuid)'] LOOP
    IF position('app_private.ie_spend_gate_v1(' in pg_get_functiondef(to_regprocedure(v_sig))) = 0 THEN
      RAISE EXCEPTION '% chưa gọi cổng bộ máy chi', v_sig USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF position('fee_category = p_category_key' in pg_get_functiondef(to_regprocedure('public.resolve_fixed_expense_type(uuid,text)'))) = 0 THEN
    RAISE EXCEPTION 'resolve_fixed_expense_type chưa ưu tiên hạng mục đã ánh xạ' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'z59_spend_capture_gate' AND NOT tgisinternal)
     OR to_regprocedure('app_private.ie_spend_gate_core_v1(uuid,uuid,text,text,text,uuid,date,jsonb,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu trigger z59_spend_capture_gate hoặc hàm lõi cổng' USING ERRCODE = '55000';
  END IF;
  IF position('HAI DÒNG DƯỚI LÀ MẪU NEO' in pg_get_functiondef(to_regprocedure('public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid)'))) = 0 THEN
    RAISE EXCEPTION 'pay_utility_bill mất mẫu neo 20260724120000' USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('anon', 'public.create_income_expense_v1(text,text,uuid,uuid,uuid,uuid,text,text,text,uuid,jsonb,boolean,text,date,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.generate_special_fees_v1(text,uuid[],text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.generate_recurring_vouchers(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ACL writer bị nới sau khi thay thân hàm' USING ERRCODE = '55000';
  END IF;
END
$sau$;

COMMIT;
