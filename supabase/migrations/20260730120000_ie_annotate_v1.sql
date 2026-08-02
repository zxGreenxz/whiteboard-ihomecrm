-- =====================================================================
-- Đợt 2 — annotate_income_expense_v1: ẢNH + GHI CHÚ trên MỌI phiếu
--
-- Đây là toàn bộ phần "sửa phiếu đã chi" của giai đoạn đầu (quyết định #2
-- của chủ: đợt đầu chỉ ảnh + ghi chú; sai tiền thì Huỷ + Tạo bản sao).
--
-- Ba thứ đang chặn việc dán một tấm ảnh chứng từ lên phiếu đã ghi sổ:
--   1. `update_income_expense_quick` chỉ cho NGƯỜI TẠO (user_id = auth.uid()),
--      nên kế toán/quản lý không đính hộ được, và nó KHÔNG ghi nhật ký.
--   2. Trigger a00_ie_owned_payload_freeze chặn mọi UPDATE lên 172 phiếu
--      flow-owned trừ khi có token; mà `attachments` KHÔNG nằm trong allowlist
--      của token ⇒ kể cả có token vẫn 55000.
--   3. Client hết DML trực tiếp.
--
-- CƠ CHẾ NĂNG LỰC — vì sao KHÔNG dùng cột `purpose` của
-- app_private.ie_transition_authorization:
--   PK bảng đó chỉ là (income_expense_id) và mọi writer canon đều UPSERT
--   purpose về 'FINANCE_V2_LIFECYCLE'. Mượn cột đó làm năng lực thì (a) bị ghi
--   đè giữa transaction, (b) purpose 'FINANCE_V2_LIFECYCLE' làm CẦU a85 TỰ TẮT
--   (early RETURN NEW). Nên dùng bảng xid riêng, sao y mẫu đã chạy thật
--   app_private.accounting_chain_writer_xids (20260721100000:497-537).
--
-- Cầu a85 KHÔNG bị đụng: nó chỉ nghe UPDATE OF approval_status / account_id /
-- total_amount / deleted_at — annotate không chạm cột nào trong đó.
-- =====================================================================

BEGIN;

-- ── 1. Năng lực ghi phạm vi hẹp ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_private.ie_flex_writer_xids (
  transaction_id     xid8 NOT NULL,
  backend_pid        integer NOT NULL,
  income_expense_id  uuid NOT NULL,
  scope              text NOT NULL,
  opened_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transaction_id, backend_pid, income_expense_id),
  CONSTRAINT ie_flex_writer_xids_scope_chk CHECK (scope IN ('ANNOTATE', 'FLEX_EDIT'))
);

REVOKE ALL ON app_private.ie_flex_writer_xids
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.ie_flex_writer_xids IS
  'Năng lực ghi phạm vi hẹp trong ĐÚNG transaction hiện tại. Chỉ writer SECURITY DEFINER mở được (hàm begin/end đã REVOKE khỏi mọi role client). Transaction rollback thì dòng cũng biến mất theo.';

CREATE OR REPLACE FUNCTION app_private.begin_ie_flex_write_v1(p_voucher uuid, p_scope text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF p_voucher IS NULL OR p_scope IS NULL THEN
    RAISE EXCEPTION 'begin_ie_flex_write_v1: thiếu tham số' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app_private.ie_flex_writer_xids
    (transaction_id, backend_pid, income_expense_id, scope)
  VALUES
    (pg_current_xact_id(), pg_backend_pid(), p_voucher, p_scope)
  ON CONFLICT (transaction_id, backend_pid, income_expense_id)
  DO UPDATE SET scope = excluded.scope, opened_at = now();
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.end_ie_flex_write_v1(p_voucher uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  DELETE FROM app_private.ie_flex_writer_xids w
   WHERE w.transaction_id = pg_current_xact_id()
     AND w.backend_pid = pg_backend_pid()
     AND (p_voucher IS NULL OR w.income_expense_id = p_voucher);
END
$fn$;

REVOKE ALL ON FUNCTION app_private.begin_ie_flex_write_v1(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.end_ie_flex_write_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 2. Mở cửa ANNOTATE trong guard đóng băng ────────────────────────
-- VÁ TẠI CHỖ, không CREATE OR REPLACE: thân hàm đang chạy đã qua hai lần vá
-- (7t/7u) và bản trong scripts/authz-prepared/prod-snapshot ĐÃ LẠC HẬU — viết
-- đè từ đó sẽ nuốt mất review_state/posting_status/notes… khỏi allowlist và
-- làm hỏng mọi writer V2.
DO $patch$
DECLARE
  v_def text;
  v_anchor text := '    -- canonical row: check for a live transition token in THIS transaction';
  v_branch text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app_private' AND p.proname = 'guard_income_expense_owned_payload';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy app_private.guard_income_expense_owned_payload';
  END IF;

  -- Idempotent: đã vá rồi thì thôi.
  IF position('ie_flex_writer_xids' IN v_def) > 0 THEN
    RAISE NOTICE 'guard_income_expense_owned_payload đã có cửa ANNOTATE — bỏ qua';
    RETURN;
  END IF;

  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo trong guard — DỪNG, không vá mù';
  END IF;

  v_branch := $branch$    -- Đợt 2: cửa ANNOTATE — ảnh chứng từ + ghi chú, cho MỌI flow_kind.
    -- Năng lực nằm ở app_private.ie_flex_writer_xids (chỉ writer definer mở
    -- được), KHÔNG mượn cột purpose của ie_transition_authorization vì cột đó
    -- bị các writer canon ghi đè và purpose FINANCE_V2_LIFECYCLE làm tắt cầu a85.
    if exists (
      select 1 from app_private.ie_flex_writer_xids w
       where w.income_expense_id = old.id
         and w.transaction_id = pg_current_xact_id()
         and w.backend_pid = pg_backend_pid()
         and w.scope = 'ANNOTATE'
    ) then
      if (to_jsonb(old) - array['attachments','notes','updated_at'])
         is distinct from
         (to_jsonb(new) - array['attachments','notes','updated_at']) then
        raise exception 'annotate scope may only change attachments/notes of %', old.id
          using errcode = '55000';
      end if;
      return new;
    end if;

$branch$ || v_anchor;

  v_def := replace(v_def, v_anchor, v_branch);

  IF position('ie_flex_writer_xids' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vá guard thất bại — không thấy dấu sau khi replace';
  END IF;

  EXECUTE v_def;
END
$patch$;

-- ── 3. Hợp nhất ảnh + gỡ ảnh (server-side, chống dán song song đè nhau) ──
CREATE OR REPLACE FUNCTION app_private.ie_attachments_remove_v1(p_old jsonb, p_remove jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT COALESCE(
    (SELECT jsonb_agg(e.value ORDER BY e.ordinality)
       FROM jsonb_array_elements(COALESCE(p_old, '[]'::jsonb)) WITH ORDINALITY AS e(value, ordinality)
      WHERE NOT COALESCE(p_remove, '[]'::jsonb) @> jsonb_build_array(e.value)),
    '[]'::jsonb);
$fn$;

-- ── 4. RPC ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.annotate_income_expense_v1(
  p_voucher uuid,
  p_add_attachments jsonb DEFAULT NULL,
  p_remove_attachments jsonb DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_note_mode text DEFAULT 'REPLACE',
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_row public.income_expenses%ROWTYPE;
  v_actor uuid := auth.uid();
  v_membership uuid;
  v_is_super boolean;
  v_can_edit boolean;
  v_may_remove boolean;
  v_next_att jsonb;
  v_next_notes text;
  v_url text;
  v_added int := 0;
  v_removed int := 0;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_note_mode NOT IN ('REPLACE', 'APPEND') THEN
    RAISE EXCEPTION 'p_note_mode phải là REPLACE hoặc APPEND' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.income_expenses
   WHERE id = p_voucher AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;

  v_is_super := public.is_super_admin();

  SELECT m.id INTO v_membership
  FROM public.organization_memberships m
  WHERE m.user_id = v_actor AND m.organization_id = v_row.organization_id
    AND m.status = 'ACTIVE'
  LIMIT 1;

  IF v_membership IS NULL AND NOT v_is_super THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
  END IF;

  -- Quyền sửa "thật" trên toà (quyết định #4: thêm Chủ tổ chức / Super Admin).
  v_can_edit := v_is_super
             OR app_private.is_org_owner_v1(v_row.organization_id, v_actor)
             OR app_private.ie_can_edit_money_axis_v1(v_row.organization_id, v_row.building_id);

  -- Ai được đính ảnh/ghi chú: quyền sửa, HOẶC đang giữ/biết sổ, HOẶC là người
  -- lập phiếu (giữ nguyên tầm với của luồng dán ảnh hiện tại).
  IF NOT (
       v_can_edit
    OR v_row.user_id = v_actor
    OR app_private.ie_has_cashbook_possession_v1(
         v_row.organization_id, v_row.account_id, v_membership)
  ) THEN
    RAISE EXCEPTION 'Không có quyền bổ sung ảnh/ghi chú cho phiếu này'
      USING ERRCODE = '42501';
  END IF;

  -- RPC là SECURITY DEFINER nên không hưởng policy RESTRICTIVE hạng mục hạn chế.
  IF COALESCE(v_row.has_restricted_item, false)
     AND v_row.user_id IS DISTINCT FROM v_actor
     AND NOT public.can_view_restricted_ie()
     AND NOT v_is_super THEN
    RAISE EXCEPTION 'Phiếu chứa hạng mục hạn chế — không có quyền' USING ERRCODE = '42501';
  END IF;

  -- GỠ bằng chứng là hành vi SỬA, không phải chú thích ⇒ đòi quyền sửa thật.
  v_may_remove := v_can_edit;
  IF p_remove_attachments IS NOT NULL
     AND jsonb_array_length(p_remove_attachments) > 0
     AND NOT v_may_remove THEN
    RAISE EXCEPTION 'Chỉ người có quyền sửa thu chi mới gỡ được ảnh chứng từ'
      USING ERRCODE = '42501';
  END IF;

  -- Kiểm URL (cùng luật với create_income_expense_v1).
  IF p_add_attachments IS NOT NULL THEN
    FOR v_url IN SELECT jsonb_array_elements_text(p_add_attachments) LOOP
      IF v_url !~ '^https://' OR length(v_url) > 2048 OR v_url ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'Đường dẫn ảnh không hợp lệ' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  v_next_att := COALESCE(v_row.attachments, '[]'::jsonb);
  IF p_remove_attachments IS NOT NULL THEN
    v_next_att := app_private.ie_attachments_remove_v1(v_next_att, p_remove_attachments);
  END IF;
  IF p_add_attachments IS NOT NULL THEN
    -- Hợp nhất phía server: hai người cùng dán ảnh không đè mất của nhau, và
    -- dán lại đúng tấm cũ là no-op (nên không cần sổ idempotency riêng).
    v_next_att := app_private.ie_attachments_union_v1(v_next_att, p_add_attachments);
  END IF;

  IF jsonb_array_length(v_next_att) > 20 THEN
    RAISE EXCEPTION 'Tối đa 20 ảnh chứng từ trên một phiếu' USING ERRCODE = '22023';
  END IF;

  v_next_notes := v_row.notes;
  IF p_notes IS NOT NULL THEN
    IF length(p_notes) > 5000 THEN
      RAISE EXCEPTION 'Ghi chú tối đa 5000 ký tự' USING ERRCODE = '22023';
    END IF;
    v_next_notes := CASE
      WHEN p_note_mode = 'APPEND' AND COALESCE(v_row.notes, '') <> ''
        THEN v_row.notes || E'\n' || p_notes
      ELSE p_notes
    END;
    -- Dấu hiệu tiền trong ghi chú là LOGIC TIỀN (xem Đợt 0) — cấm thêm/gỡ.
    PERFORM app_private.assert_notes_markers_unchanged_v1(v_row.notes, v_next_notes);
  END IF;

  SELECT count(*) INTO v_added
    FROM jsonb_array_elements(v_next_att) e
   WHERE NOT COALESCE(v_row.attachments, '[]'::jsonb) @> jsonb_build_array(e.value);
  SELECT count(*) INTO v_removed
    FROM jsonb_array_elements(COALESCE(v_row.attachments, '[]'::jsonb)) e
   WHERE NOT v_next_att @> jsonb_build_array(e.value);

  IF v_next_att IS NOT DISTINCT FROM COALESCE(v_row.attachments, '[]'::jsonb)
     AND v_next_notes IS NOT DISTINCT FROM v_row.notes THEN
    RETURN jsonb_build_object('id', p_voucher, 'changed', false);
  END IF;

  PERFORM app_private.begin_ie_flex_write_v1(p_voucher, 'ANNOTATE');
  UPDATE public.income_expenses
     SET attachments = v_next_att,
         notes = v_next_notes
   WHERE id = p_voucher;
  PERFORM app_private.end_ie_flex_write_v1(p_voucher);

  PERFORM app_private.append_income_expense_event_v1(
    v_row.organization_id,
    p_voucher,
    'MANUAL_LOG',
    v_actor,
    NULL,
    v_row.approval_status,
    v_row.approval_status,
    CASE
      WHEN v_added > 0 AND v_removed > 0 THEN 'Bổ sung/gỡ ảnh chứng từ'
      WHEN v_added > 0 THEN 'Bổ sung ảnh chứng từ'
      WHEN v_removed > 0 THEN 'Gỡ ảnh chứng từ'
      ELSE 'Sửa ghi chú'
    END
  );

  RETURN jsonb_build_object(
    'id', p_voucher,
    'changed', true,
    'attachments', v_next_att,
    'added', v_added,
    'removed', v_removed
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.annotate_income_expense_v1(uuid, jsonb, jsonb, text, text, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.annotate_income_expense_v1(uuid, jsonb, jsonb, text, text, text)
  TO authenticated;

COMMENT ON FUNCTION public.annotate_income_expense_v1(uuid, jsonb, jsonb, text, text, text) IS
  'Bổ sung ảnh chứng từ / ghi chú cho phiếu thu chi ở BẤT KỲ trạng thái nào, kể cả phiếu canonical đã ghi sổ. Chỉ đụng attachments + notes; có ghi nhật ký; cấm thêm/gỡ dấu hiệu tiền trong ghi chú.';

COMMIT;

NOTIFY pgrst, 'reload schema';
