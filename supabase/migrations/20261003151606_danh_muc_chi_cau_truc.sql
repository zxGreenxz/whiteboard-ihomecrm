-- ============================================================
-- Danh mục chi chuẩn — phần CẤU TRÚC (chủ duyệt 03/10/2026).
--
-- Bối cảnh (đo production 02/10/2026): 92 hạng mục chi do quản lý tự gõ,
-- 26 mục gần như không dùng, 112 dòng chi nằm sai chỗ; hoa hồng / thưởng sale
-- vẫn lập tay được ở trang Thu chi. Migration dữ liệu đi kèm
-- (…_danh_muc_chi_du_lieu.sql) dựng danh mục mới trên các cột ở đây.
--
-- 1. Cột mới trên income_expense_types:
--      archived_at        hạng mục cũ đã gộp/thôi dùng — ẩn khỏi mọi ô chọn;
--      merged_into_id     báo cáo cộng mục cũ vào mục này (KHÔNG chuyển dòng
--                         phiếu cũ — khoá sổ lợi nhuận, khoá phiếu hệ thống và
--                         sổ cam kết chi đều neo theo hạng mục của dòng);
--      keywords           cụm từ hay nói — lớp luật + gợi ý AI + cụm từ ưu tiên
--                         giọng nói của Báo chi nhanh;
--      sort_order         thứ tự trong ô chọn;
--      rule_key           mã ổn định cho luật Báo chi nhanh (duy nhất trong org);
--      manual_hidden      ẩn khỏi ô chọn lập tay (mục hệ thống tự lập, mục chỉ
--                         công cụ riêng dùng như phí bảo trì máy lạnh/máy giặt);
--      quick_entry_hidden ẩn riêng khỏi Báo chi nhanh;
--      internal_transfer  tiền nội bộ — dòng phiếu luôn INTERNAL, không tính KQKD.
-- 2. Chỉ SUPERADMIN và CHỦ CÔNG TY được thêm / sửa / xoá hạng mục: policy
--    RESTRICTIVE dùng public.ie_type_rule_editor_ok_v1(org) (= superadmin hoặc
--    chủ công ty của org đó; app_private.ie_actor_is_company_owner_v1 không gọi
--    được từ RLS). Hàm SECURITY DEFINER của hệ thống không bị ảnh hưởng.
-- 3. Trigger set_ie_item_accounting_class: hạng mục internal_transfer ⇒ dòng
--    INTERNAL kể cả khi trang gửi PNL (đường dự phòng lưu nguyên nhãn client).
--    Chỉ áp cho dòng MỚI hoặc dòng đổi hạng mục — không sửa phiếu cũ.
-- 4. ie_compat_insert_v2 từ chối hạng mục CHI system_only ở nhánh thường (trước
--    đây chỉ nhánh Copilot kiểm): trang Thu chi bị create_income_expense_v1 từ
--    chối 0A000 rồi tự rơi sang đây và lập tay được hoa hồng / thưởng sale.
--    Các luồng hoa hồng hiện có (popup sau ký hợp đồng, "Tạo phiếu hoa hồng",
--    "Tạo lại" ở Cần rà soát, ô thưởng ở form cọc, hỗ trợ tiền thuê, chuyển
--    nhượng môi giới) ghi thẳng, không qua hàm này ⇒ giữ nguyên.
-- 5. REVOKE create_income_expense_v2 khỏi anon/authenticated: không trang nào
--    gọi, mà hàm nhận hạng mục bất kỳ + nhãn KQKD bất kỳ (cùng lỗ với mục 4).
-- 6. public.ie_type_report_root_v1(type_id): hạng mục gốc cho báo cáo cộng gộp;
--    trigger a02_ie_type_merge_one_level giữ việc gộp đúng một bậc.
-- 7. guard_reservation_deposit_type_v1 cho phép đổi các cột hiển thị/quản lý
--    mới (và nhóm `category`) trên hạng mục cọc giữ chỗ đã dùng; cột
--    internal_transfer vẫn bị chặn như mọi cột "bản chất".
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS
-- rồi CREATE. Khối kiểm cuối chỉ đọc catalog nên chạy được trên DB rỗng.
-- ============================================================

-- ---------- 1. Cột mới ----------
ALTER TABLE public.income_expense_types
  ADD COLUMN IF NOT EXISTS archived_at        timestamptz,
  ADD COLUMN IF NOT EXISTS merged_into_id     uuid,
  ADD COLUMN IF NOT EXISTS keywords           text[]  NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS sort_order         integer,
  ADD COLUMN IF NOT EXISTS rule_key           text,
  ADD COLUMN IF NOT EXISTS manual_hidden      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS quick_entry_hidden boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS internal_transfer  boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.income_expense_types.archived_at IS
  'Hạng mục cũ đã gộp hoặc thôi dùng: ẩn khỏi mọi ô chọn; phiếu cũ giữ nguyên hạng mục này.';
COMMENT ON COLUMN public.income_expense_types.merged_into_id IS
  'Báo cáo cộng hạng mục này vào hạng mục đích (cùng org). Không chuyển dòng phiếu.';
COMMENT ON COLUMN public.income_expense_types.keywords IS
  'Cụm từ hay nói — lớp luật, gợi ý AI và cụm từ ưu tiên giọng nói của Báo chi nhanh.';
COMMENT ON COLUMN public.income_expense_types.rule_key IS
  'Mã ổn định cho luật chọn hạng mục của Báo chi nhanh (duy nhất trong org).';
COMMENT ON COLUMN public.income_expense_types.manual_hidden IS
  'Ẩn khỏi ô chọn lập tay (Thu chi, Báo chi nhanh) — hạng mục hệ thống tự lập hoặc chỉ công cụ riêng dùng.';
COMMENT ON COLUMN public.income_expense_types.quick_entry_hidden IS
  'Ẩn riêng khỏi trang Báo chi nhanh.';
COMMENT ON COLUMN public.income_expense_types.internal_transfer IS
  'Tiền nội bộ: dòng phiếu MỚI luôn mang nhãn INTERNAL (không tính KQKD).';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'income_expense_types_merged_into_fkey'
                    AND conrelid = 'public.income_expense_types'::regclass) THEN
    -- Cùng org: FK tới UNIQUE (id, organization_id) có sẵn.
    ALTER TABLE public.income_expense_types
      ADD CONSTRAINT income_expense_types_merged_into_fkey
      FOREIGN KEY (merged_into_id, organization_id)
      REFERENCES public.income_expense_types (id, organization_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'income_expense_types_merged_into_self_check'
                    AND conrelid = 'public.income_expense_types'::regclass) THEN
    ALTER TABLE public.income_expense_types
      ADD CONSTRAINT income_expense_types_merged_into_self_check
      CHECK (merged_into_id IS NULL OR merged_into_id <> id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'income_expense_types_internal_not_deposit_check'
                    AND conrelid = 'public.income_expense_types'::regclass) THEN
    ALTER TABLE public.income_expense_types
      ADD CONSTRAINT income_expense_types_internal_not_deposit_check
      CHECK (NOT (internal_transfer AND coalesce(is_deposit, false)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'income_expense_types_rule_key_check'
                    AND conrelid = 'public.income_expense_types'::regclass) THEN
    ALTER TABLE public.income_expense_types
      ADD CONSTRAINT income_expense_types_rule_key_check
      CHECK (rule_key IS NULL OR rule_key ~ '^[a-z0-9_]{2,40}$');
  END IF;
END $$;

-- Gộp đúng MỘT bậc: đích gộp không được tự gộp tiếp, và hạng mục đang là đích
-- của mục khác không được gộp đi. Nhờ vậy báo cáo chỉ cần
-- COALESCE(merged_into_id, id) — không phải dò dây chuyền trên từng dòng phiếu.
CREATE OR REPLACE FUNCTION app_private.ie_type_merge_one_level_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NEW.merged_into_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.income_expense_types t
                WHERE t.id = NEW.merged_into_id AND t.merged_into_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Không gộp vào hạng mục đã được gộp vào mục khác' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.income_expense_types t WHERE t.merged_into_id = NEW.id) THEN
      RAISE EXCEPTION 'Hạng mục đang là đích gộp của mục khác, không gộp đi được' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS a02_ie_type_merge_one_level ON public.income_expense_types;
CREATE TRIGGER a02_ie_type_merge_one_level
  BEFORE INSERT OR UPDATE OF merged_into_id ON public.income_expense_types
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_type_merge_one_level_guard();

CREATE UNIQUE INDEX IF NOT EXISTS income_expense_types_org_rule_key_uq
  ON public.income_expense_types (organization_id, rule_key)
  WHERE rule_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS income_expense_types_merged_into_idx
  ON public.income_expense_types (merged_into_id)
  WHERE merged_into_id IS NOT NULL;

-- ---------- 2. Chỉ superadmin + chủ công ty được thêm / sửa / xoá ----------
-- Policy RESTRICTIVE: AND với các policy *_rbac sẵn có (categories.*). Vai
-- "Quản Lý Tòa" vẫn giữ quyền xem (categories.view) nhưng hết ghi.
DROP POLICY IF EXISTS income_expense_types_editor_insert ON public.income_expense_types;
CREATE POLICY income_expense_types_editor_insert ON public.income_expense_types
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.ie_type_rule_editor_ok_v1(organization_id));

DROP POLICY IF EXISTS income_expense_types_editor_update ON public.income_expense_types;
CREATE POLICY income_expense_types_editor_update ON public.income_expense_types
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.ie_type_rule_editor_ok_v1(organization_id))
  WITH CHECK (public.ie_type_rule_editor_ok_v1(organization_id));

DROP POLICY IF EXISTS income_expense_types_editor_delete ON public.income_expense_types;
CREATE POLICY income_expense_types_editor_delete ON public.income_expense_types
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.ie_type_rule_editor_ok_v1(organization_id));

-- Cột luật tiền (internal_transfer, merged_into_id) vào nhóm cột chỉ chủ /
-- superadmin đổi ở trigger guard — lớp thứ hai, phòng khi policy bị nới.
CREATE OR REPLACE FUNCTION app_private.ie_type_rule_columns_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_doi boolean;
BEGIN
  -- Ghi từ bên trong hàm SECURITY DEFINER của hệ thống (current_user = chủ hàm),
  -- từ service_role, hay từ lane migration: mã server — để nguyên như trước G3.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_doi := NEW.spend_mode <> 'TUNG_PHIEU'
          OR NEW.fee_category IS NOT NULL
          OR COALESCE(NEW.force_approval, false)
          OR COALESCE(NEW.is_deposit, false)
          OR COALESCE(NEW.internal_transfer, false)
          OR NEW.merged_into_id IS NOT NULL;
  ELSE
    v_doi := NEW.spend_mode        IS DISTINCT FROM OLD.spend_mode
          OR NEW.fee_category      IS DISTINCT FROM OLD.fee_category
          OR NEW.force_approval    IS DISTINCT FROM OLD.force_approval
          OR NEW.is_deposit        IS DISTINCT FROM OLD.is_deposit
          OR NEW.organization_id   IS DISTINCT FROM OLD.organization_id
          OR NEW.internal_transfer IS DISTINCT FROM OLD.internal_transfer
          OR NEW.merged_into_id    IS DISTINCT FROM OLD.merged_into_id;
  END IF;

  IF NOT v_doi THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    -- chuyển hạng mục sang org khác: chỉ super admin
    IF public.ie_type_rule_editor_ok_v1(NULL) THEN
      RETURN NEW;
    END IF;
  ELSIF public.ie_type_rule_editor_ok_v1(NEW.organization_id) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được đổi luật chi của hạng mục (kiểu chi, khoá phí, bắt buộc duyệt, cọc, nội bộ, gộp, tổ chức)'
    USING ERRCODE = '42501';
END
$function$;

-- ---------- 3. Nhãn INTERNAL theo hạng mục ----------
CREATE OR REPLACE FUNCTION public.set_ie_item_accounting_class()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_deposit boolean;
  v_internal   boolean;
  v_old_internal boolean := false;
  v_type_changed boolean := TG_OP = 'UPDATE'
    AND NEW.income_expense_type_id IS DISTINCT FROM OLD.income_expense_type_id;
BEGIN
  IF TG_OP = 'INSERT' OR v_type_changed OR NEW.accounting_class IS NULL THEN
    SELECT t.is_deposit, coalesce(t.internal_transfer, false)
      INTO v_is_deposit, v_internal
      FROM public.income_expense_types t
     WHERE t.id = NEW.income_expense_type_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown income_expense_type_id %', NEW.income_expense_type_id
        USING ERRCODE = '23503';
    END IF;

    -- Danh mục chi chuẩn 03/10/2026: hạng mục tiền nội bộ (Chuyển tiền nội bộ,
    -- Chia lợi nhuận cổ đông) luôn INTERNAL ở dòng mới / dòng đổi hạng mục,
    -- kể cả khi client gửi PNL — không tính KQKD.
    IF v_internal AND (TG_OP = 'INSERT' OR v_type_changed) THEN
      NEW.accounting_class := 'INTERNAL';
      RETURN NEW;
    END IF;

    IF v_type_changed AND OLD.accounting_class = 'INTERNAL' THEN
      SELECT coalesce(t.internal_transfer, false) INTO v_old_internal
        FROM public.income_expense_types t WHERE t.id = OLD.income_expense_type_id;
    END IF;
  END IF;

  IF NEW.accounting_class IS NULL
     OR (
       v_type_changed
       AND NEW.accounting_class IS NOT DISTINCT FROM OLD.accounting_class
       AND (OLD.accounting_class IN ('PNL', 'DEPOSIT')
            -- rời hạng mục nội bộ sang hạng mục thường: suy lại như dòng mới
            OR (OLD.accounting_class = 'INTERNAL' AND v_old_internal))
     ) THEN
    NEW.accounting_class := CASE WHEN v_is_deposit THEN 'DEPOSIT' ELSE 'PNL' END;
  END IF;

  RETURN NEW;
END;
$function$;

-- ---------- 4. Chặn lập tay hạng mục chi chỉ-hệ-thống ----------
CREATE OR REPLACE FUNCTION public.ie_compat_insert_v2(p_row jsonb, p_items jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_org              uuid;
  v_colrec           record;
  v_defj             jsonb;
  v_actor            record;
  v_id               uuid;
  v_clean            jsonb;
  v_item             jsonb;
  v_items            jsonb := coalesce(p_items, '[]'::jsonb);
  v_draft_marker     text := nullif(btrim(coalesce(p_row ->> 'copilot_draft_marker', '')), '');
  v_copilot_draft    boolean := false;
  v_input_item       jsonb;
  v_item_type_id     uuid;
  v_item_quantity    numeric;
  v_item_unit_price  numeric;
  v_item_amount      numeric;
BEGIN
  -- A browser can send a marker-shaped field, but only the execute RPC can
  -- create a matching private row in this transaction.  Delete the row here
  -- so the capability is single-use even if the writer is called twice.
  IF v_draft_marker IS NOT NULL THEN
    DELETE FROM app_private.copilot_ie_writer_context_v1 c
     WHERE c.transaction_id = pg_current_xact_id()::text
       AND c.actor_id = auth.uid()
       AND c.context_name = 'copilot_execute_income_expense_v1'
       AND c.marker_digest = extensions.digest(
             convert_to(v_draft_marker, 'UTF8'), 'sha256')
       AND c.created_at > clock_timestamp() - interval '10 minutes'
       AND EXISTS (
         SELECT 1
           FROM app_private.copilot_ie_writer_capabilities_v1 cap
          WHERE cap.capability_key = 'income_expense_draft_v1'
            AND cap.enabled
       )
    RETURNING c.organization_id INTO v_org;
    v_copilot_draft := FOUND;
  END IF;

  IF v_copilot_draft THEN
    -- The private context owns organization identity.  A mismatching payload
    -- is an invariant failure, not a chance to fall back to another org.
    BEGIN
      IF (p_row ->> 'organization_id') IS NOT NULL
         AND (p_row ->> 'organization_id')::uuid IS DISTINCT FROM v_org THEN
        RAISE EXCEPTION 'copilot organization mismatch' USING ERRCODE = '42501';
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'copilot organization mismatch' USING ERRCODE = '42501';
    END;
  ELSE
    -- Preserve the established resolution behavior for ordinary callers.
    v_org := COALESCE(
      (SELECT a.organization_id
         FROM public.accounts a
        WHERE a.id = (p_row ->> 'account_id')::uuid),
      (SELECT b.organization_id
         FROM public.buildings b
        WHERE b.id = (p_row ->> 'building_id')::uuid),
      (p_row ->> 'organization_id')::uuid);
    IF v_org IS NULL THEN
      SELECT m.organization_id INTO v_org
        FROM public.organization_memberships m
       WHERE m.user_id = auth.uid()
         AND m.status = 'ACTIVE'
       LIMIT 1;
    END IF;
  END IF;

  SELECT * INTO v_actor FROM app_private.ie_compat_actor_v2(v_org);
  IF v_actor.membership_id IS NULL THEN
    RAISE EXCEPTION 'active organization membership required' USING ERRCODE = '42501';
  END IF;

  -- Preserve the existing possession guard for callers that select a book.
  -- The Copilot path always strips account_id before the insert.
  IF (p_row ->> 'account_id') IS NOT NULL AND NOT v_copilot_draft THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.cashbook_possession_bindings b
       WHERE b.organization_id = v_org
         AND b.cashbook_id = (p_row ->> 'account_id')::uuid
         AND b.membership_id = v_actor.membership_id
         AND b.valid_to IS NULL
         AND (b.possession_kind = 'CUSTODIAN'
              OR (b.possession_kind = 'KNOWER'
                  AND COALESCE(p_row ->> 'type', '') = 'INCOME'))
    ) THEN
      RAISE EXCEPTION 'cashbook possession is not permitted' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_copilot_draft THEN
    -- Re-resolve the building and item type inside the writer.  The execute
    -- RPC checks these too, but this is the final server-side boundary before
    -- a shared writer and its triggers observe any values.
    IF upper(coalesce(p_row ->> 'type', '')) NOT IN ('INCOME', 'EXPENSE') THEN
      RAISE EXCEPTION 'copilot type is invalid' USING ERRCODE = '22023';
    END IF;
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM public.buildings b
         WHERE b.id = (p_row ->> 'building_id')::uuid
           AND b.organization_id = v_org
           AND b.deleted_at IS NULL
      ) THEN
        RAISE EXCEPTION 'copilot building is not in organization' USING ERRCODE = '42501';
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'copilot building is invalid' USING ERRCODE = '22023';
    END;

    IF jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) <> 1 THEN
      RAISE EXCEPTION 'copilot requires exactly one item' USING ERRCODE = '22023';
    END IF;
    v_input_item := v_items -> 0;
    IF jsonb_typeof(v_input_item) <> 'object' THEN
      RAISE EXCEPTION 'copilot item must be an object' USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_item_type_id := NULLIF(v_input_item ->> 'income_expense_type_id', '')::uuid;
      v_item_quantity := COALESCE(NULLIF(v_input_item ->> 'quantity', '')::numeric, 1);
      v_item_unit_price := NULLIF(v_input_item ->> 'unit_price', '')::numeric;
      v_item_amount := NULLIF(v_input_item ->> 'amount', '')::numeric;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'copilot item amount or type is invalid' USING ERRCODE = '22023';
    END;
    IF v_item_type_id IS NULL OR v_item_quantity IS NULL
       OR v_item_quantity <> 1 THEN
      RAISE EXCEPTION 'copilot item quantity or type is invalid' USING ERRCODE = '22023';
    END IF;
    IF v_item_unit_price IS NULL THEN
      v_item_unit_price := v_item_amount;
    END IF;
    IF v_item_amount IS NULL THEN
      v_item_amount := v_item_quantity * v_item_unit_price;
    END IF;
    IF v_item_unit_price IS NULL OR v_item_amount IS NULL
       OR v_item_unit_price::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_item_amount::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_item_unit_price <= 0
       OR v_item_amount <= 0
       OR v_item_amount IS DISTINCT FROM v_item_quantity * v_item_unit_price THEN
      RAISE EXCEPTION 'copilot item amount is invalid' USING ERRCODE = '22023';
    END IF;

    PERFORM 1
      FROM public.income_expense_types t
     WHERE t.id = v_item_type_id
       AND t.organization_id = v_org
       AND lower(t.type) = lower(p_row ->> 'type')
       AND NOT coalesce(t.system_only, false)
       AND (
         NOT coalesce(t.is_restricted, false)
         OR public.can_create_restricted_ie()
       )
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'copilot income/expense type is not permitted' USING ERRCODE = '42501';
    END IF;

    -- Rebuild the line from the allowlist.  Client-supplied organization,
    -- accounting class, lifecycle, and arbitrary columns never reach INSERT.
    v_items := jsonb_build_array(
      jsonb_build_object(
        'income_expense_type_id', v_item_type_id,
        'organization_id',        v_org,
        'description',            COALESCE(
          NULLIF(btrim(v_input_item ->> 'description'), ''),
          p_row ->> 'name'),
        'quantity',               1,
        'unit_price',             v_item_unit_price,
        'amount',                 v_item_amount
      )
    );
  END IF;

  -- Strip server-owned fields before applying the mode-specific values.
  v_clean := p_row - ARRAY[
    'approval_status', 'approved_by', 'approved_at', 'posting_id',
    'posted_at_v2', 'posting_mode', 'posting_status', 'active_posting_id_v2',
    'reversed_by_posting_id', 'deleted_at', 'maker_user_id',
    'maker_membership_id', 'birth_operation_id', 'birth_txid', 'review_state',
    'organization_id', 'user_id', 'copilot_draft_marker', 'copilot_draft_only'
  ]::text[];

  v_clean := v_clean || jsonb_build_object(
    'organization_id', v_org,
    'user_id', auth.uid(),
    'approval_status', CASE
      WHEN v_copilot_draft THEN 'UNAPPROVED'
      WHEN COALESCE(p_row ->> 'type', '') = 'INCOME'
           AND COALESCE(p_row ->> 'repeat_cycle', 'NONE') = 'NONE'
        THEN 'APPROVED'
      ELSE 'UNAPPROVED'
    END,
    'review_state', CASE
      WHEN v_copilot_draft THEN 'PENDING'
      WHEN COALESCE(p_row ->> 'type', '') = 'INCOME'
           AND COALESCE(p_row ->> 'repeat_cycle', 'NONE') = 'NONE'
        THEN 'RESOLVED'
      ELSE 'PENDING'
    END,
    'approved_by', CASE
      WHEN v_copilot_draft THEN NULL::uuid
      WHEN COALESCE(p_row ->> 'type', '') = 'INCOME'
           AND COALESCE(p_row ->> 'repeat_cycle', 'NONE') = 'NONE'
        THEN auth.uid()
      ELSE NULL::uuid
    END,
    'approved_at', CASE
      WHEN v_copilot_draft THEN NULL::timestamptz
      WHEN COALESCE(p_row ->> 'type', '') = 'INCOME'
           AND COALESCE(p_row ->> 'repeat_cycle', 'NONE') = 'NONE'
        THEN now()
      ELSE NULL::timestamptz
    END,
    'posting_mode', 'CASHBOOK',
    'posting_status', 'UNPOSTED',
    'maker_user_id', auth.uid(),
    'maker_membership_id', v_actor.membership_id
  );

  -- Ordinary callers retain the established user override; the Copilot
  -- branch above always keeps the authenticated actor as the owner.
  IF NOT v_copilot_draft THEN
    v_clean := v_clean || jsonb_build_object(
      'user_id', COALESCE((p_row ->> 'user_id')::uuid, auth.uid())
    );
  END IF;

  IF p_row ? 'id' AND NOT v_copilot_draft THEN
    v_clean := v_clean || jsonb_build_object('id', (p_row ->> 'id')::uuid);
  END IF;

  IF v_copilot_draft THEN
    -- Draft mode has no cashbook, posting, approval, recurrence, or source
    -- linkage.  Derived accounting fields are left to their server triggers.
    v_clean := (v_clean - ARRAY[
      'id', 'code', 'account_id', 'contract_id', 'invoice_id', 'payment_id',
      'payment_collection_id', 'handover_id', 'handover_transfer_id',
      'room_id', 'bed_id', 'tenant_id', 'shareholder_id', 'utility_account_id',
      'approval_request_id', 'approval_version', 'posting_version',
      'review_version', 'review_reason', 'review_deadline',
      'review_owner_membership_id', 'verified_at', 'verified_by',
      'verified_by_name', 'verified_note', 'cancellation_kind',
      'source_payload_hash', 'recognition_source_mode', 'recognition_date',
      'system_source', 'idempotency_key', 'business_result_accounting',
      'counts_in_business_result', 'has_restricted_item', 'kqkd_amount',
      'repeat_cycle', 'repeat_infinity', 'repeat_count', 'repeat_auto_approve',
      'repeat_next_date', 'repeat_parent_id', 'repeat_remaining',
      'active_posting_id_v2', 'posting_id', 'posted_at_v2',
      'reversed_by_posting_id', 'approved_by', 'approved_at', 'review_state',
      'posting_mode', 'posting_status', 'total_amount'
    ]::text[]) || jsonb_build_object(
      'account_id', NULL::uuid,
      'contract_id', NULL::uuid,
      'invoice_id', NULL::uuid,
      'payment_id', NULL::uuid,
      'room_id', NULL::uuid,
      'bed_id', NULL::uuid,
      'tenant_id', NULL::uuid,
      'approval_status', 'UNAPPROVED',
      'review_state', 'PENDING',
      'approved_by', NULL::uuid,
      'approved_at', NULL::timestamptz,
      'posting_mode', 'CASHBOOK',
      'posting_status', 'UNPOSTED',
      'repeat_cycle', 'NONE',
      'repeat_infinity', false,
      'repeat_count', 0,
      'repeat_auto_approve', false,
      'repeat_next_date', NULL::date,
      'repeat_parent_id', NULL::uuid,
      'repeat_remaining', 0,
      'total_amount', v_item_amount
    );
  END IF;

  -- jsonb_populate_record makes absent columns explicit NULLs, so preserve
  -- the established generic default-fill behavior for NOT NULL columns.
  IF (v_clean ->> 'total_amount') IS NULL THEN
    v_clean := v_clean || jsonb_build_object('total_amount', COALESCE((
      SELECT SUM(COALESCE((i ->> 'amount')::numeric,
                          COALESCE((i ->> 'quantity')::numeric, 1)
                          * COALESCE((i ->> 'unit_price')::numeric, 0)))
        FROM jsonb_array_elements(v_items) i), 0));
  END IF;

  FOR v_colrec IN
    SELECT c.column_name, c.column_default
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name = 'income_expenses'
       AND c.is_nullable = 'NO'
       AND c.column_default IS NOT NULL
  LOOP
    IF (v_clean ->> v_colrec.column_name) IS NULL THEN
      EXECUTE format('SELECT to_jsonb(%s)', v_colrec.column_default) INTO v_defj;
      v_clean := v_clean || jsonb_build_object(v_colrec.column_name, v_defj);
    END IF;
  END LOOP;

  -- Danh mục chi chuẩn (03/10/2026): hạng mục CHI chỉ-hệ-thống (hoa hồng môi
  -- giới, thưởng nóng sale, các mục cọc/thanh lý) chỉ sinh từ luồng nghiệp vụ của
  -- chúng — các luồng đó ghi thẳng, không đi qua hàm này. Trang Thu chi bị
  -- create_income_expense_v1 từ chối (0A000) rồi tự rơi sang đây và lập tay được.
  -- Chặn trước mọi lệnh ghi. Nhánh Copilot đã kiểm riêng ở trên.
  IF NOT v_copilot_draft AND EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_items) e
      JOIN public.income_expense_types t
        ON t.id = nullif(e ->> 'income_expense_type_id', '')::uuid
     WHERE coalesce(t.system_only, false)
       AND lower(btrim(t.type)) = 'expense'
  ) THEN
    RAISE EXCEPTION 'Hạng mục này chỉ được tạo từ luồng nghiệp vụ (hợp đồng, phiếu cọc, thanh lý), không lập tay ở Thu chi'
      USING ERRCODE = '42501', HINT = 'ie_system_only_manual_blocked';
  END IF;

  INSERT INTO public.income_expenses
  SELECT * FROM jsonb_populate_record(NULL::public.income_expenses, v_clean)
  RETURNING id INTO v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_item := (v_item - 'income_expense_id')
              || jsonb_build_object('income_expense_id', v_id);
    FOR v_colrec IN
      SELECT c.column_name, c.column_default
        FROM information_schema.columns c
       WHERE c.table_schema = 'public'
         AND c.table_name = 'income_expense_items'
         AND c.is_nullable = 'NO'
         AND c.column_default IS NOT NULL
    LOOP
      IF (v_item ->> v_colrec.column_name) IS NULL THEN
        EXECUTE format('SELECT to_jsonb(%s)', v_colrec.column_default) INTO v_defj;
        v_item := v_item || jsonb_build_object(v_colrec.column_name, v_defj);
      END IF;
    END LOOP;
    INSERT INTO public.income_expense_items
    SELECT * FROM jsonb_populate_record(NULL::public.income_expense_items, v_item);
  END LOOP;

  INSERT INTO app_private.finance_v2_semantic_event_log
    (organization_id, event_kind, source_table, source_id, source_kind, actor, txid)
  VALUES
    (v_org, 'COMPAT_INSERT', 'income_expenses', v_id, 'V2_WRITE', auth.uid(), pg_current_xact_id());

  RETURN jsonb_build_object(
    'id', v_id,
    'approval_status', (SELECT approval_status
                          FROM public.income_expenses
                         WHERE id = v_id)
  );
END
$function$;

-- ---------- 5. Đóng create_income_expense_v2 với người dùng ----------
REVOKE EXECUTE ON FUNCTION public.create_income_expense_v2(jsonb) FROM PUBLIC, anon, authenticated;

-- ---------- 6. Gốc cộng gộp cho báo cáo ----------
CREATE OR REPLACE FUNCTION public.ie_type_report_root_v1(p_type_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  -- Gộp chỉ một bậc (trigger a02_ie_type_merge_one_level) nên một bước là đủ.
  SELECT coalesce((SELECT t.merged_into_id FROM public.income_expense_types t WHERE t.id = p_type_id), p_type_id);
$function$;

COMMENT ON FUNCTION public.ie_type_report_root_v1(uuid) IS
  'Hạng mục gốc mà báo cáo cộng vào (theo merged_into_id). Hạng mục chưa gộp trả về chính nó.';
REVOKE ALL ON FUNCTION public.ie_type_report_root_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ie_type_report_root_v1(uuid) TO authenticated, service_role;

-- ---------- 7. Hạng mục cọc giữ chỗ: cho đổi cột hiển thị/quản lý ----------
CREATE OR REPLACE FUNCTION app_private.guard_reservation_deposit_type_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  -- Cột hiển thị / quản lý danh mục — không đổi bản chất tiền của hạng mục.
  -- internal_transfer KHÔNG nằm đây: vẫn bị chặn như mọi cột "bản chất".
  v_tu_do constant text[] := ARRAY['name','description','updated_at','sort_order','category',
    'archived_at','merged_into_id','keywords','rule_key','manual_hidden','quick_entry_hidden'];
BEGIN
  IF (to_jsonb(NEW) - v_tu_do) IS DISTINCT FROM (to_jsonb(OLD) - v_tu_do)
    AND EXISTS(SELECT 1 FROM public.income_expense_items i WHERE i.income_expense_type_id=OLD.id
      AND (app_private.reservation_deposit_is_settled_v1(i.income_expense_id)
        OR EXISTS(SELECT 1 FROM public.reservation_settlement_vouchers l WHERE l.voucher_id=i.income_expense_id))) THEN
    RAISE EXCEPTION 'Không đổi bản chất hạng mục đã dùng trong xử lý bỏ cọc' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $function$;

-- ---------- Kiểm (chỉ đọc catalog) ----------
DO $$
DECLARE
  v_def text;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='income_expense_types'
         AND column_name IN ('archived_at','merged_into_id','keywords','sort_order','rule_key',
                             'manual_hidden','quick_entry_hidden','internal_transfer')) <> 8 THEN
    RAISE EXCEPTION 'danh_muc_chi_cau_truc: thiếu cột mới trên income_expense_types';
  END IF;
  IF (SELECT count(*) FROM pg_policy
       WHERE polrelid='public.income_expense_types'::regclass AND NOT polpermissive
         AND polname IN ('income_expense_types_editor_insert','income_expense_types_editor_update',
                         'income_expense_types_editor_delete')) <> 3 THEN
    RAISE EXCEPTION 'danh_muc_chi_cau_truc: thiếu policy RESTRICTIVE ghi hạng mục';
  END IF;
  v_def := pg_get_functiondef('public.ie_compat_insert_v2(jsonb,jsonb)'::regprocedure);
  IF position('ie_system_only_manual_blocked' in v_def) = 0 THEN
    RAISE EXCEPTION 'danh_muc_chi_cau_truc: ie_compat_insert_v2 chưa có chặn hạng mục hệ thống';
  END IF;
  IF has_function_privilege('authenticated', 'public.create_income_expense_v2(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'danh_muc_chi_cau_truc: authenticated vẫn gọi được create_income_expense_v2';
  END IF;
  IF position('internal_transfer' in pg_get_functiondef('public.set_ie_item_accounting_class()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'danh_muc_chi_cau_truc: trigger nhãn chưa đọc internal_transfer';
  END IF;
END $$;
