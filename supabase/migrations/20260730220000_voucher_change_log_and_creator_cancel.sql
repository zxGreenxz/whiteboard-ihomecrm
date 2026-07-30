-- =====================================================================
-- Theo yêu cầu của chủ 29/07/2026 (phiếu thu):
--   a) "phiếu thu của user nào tạo thì user đó được huỷ"
--      → THÊM cửa cho người tạo, GIỮ nguyên hai cửa cũ (người giữ sổ, chủ tổ chức).
--   b) "ghi nhận lại toàn bộ thao tác huỷ / chỉnh sửa của phiếu đó để đối soát
--      sau này"
--      → nhật ký GIÁ TRỊ TRƯỚC/SAU, thứ hiện KHÔNG có.
--
-- GIỮ NGUYÊN quyết định #2: vẫn chỉ sửa được ảnh + ghi chú. Không mở sửa tiền.
-- Sai tiền vẫn là Huỷ + Tạo bản sao. (Xác nhận lại 29/07.)
-- =====================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. NHẬT KÝ GIÁ TRỊ TRƯỚC/SAU
--
-- public.income_expense_audit_log hiện chỉ có action / old_status / new_status
-- / note — biết "đã sửa ghi chú" nhưng KHÔNG biết sửa từ gì thành gì, và gỡ ảnh
-- thì không lưu URL nào bị gỡ. Không đối soát được.
-- Bảng đó lại có chuỗi hash chống sửa (sequence_no + prev_event_hash +
-- event_hash), nên thêm cột vào là đụng chính cơ chế toàn vẹn của nó.
-- ⇒ Dựng bảng RIÊNG, append-only, và bắt bằng TRIGGER thay vì vá từng writer:
--   trigger tóm được MỌI đường ghi (annotate, quick edit, compat, huỷ linh hoạt,
--   cầu a85, cả psql tay), không đường nào lọt.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_private.income_expense_change_log (
  id                bigserial PRIMARY KEY,
  income_expense_id uuid NOT NULL,
  organization_id   uuid,
  changed_at        timestamptz NOT NULL DEFAULT now(),
  actor_id          uuid,
  db_role           text,
  scope             text NOT NULL,   -- VOUCHER | ITEM
  op                text NOT NULL,   -- UPDATE | DELETE | INSERT
  changed_cols      text[],
  before            jsonb,
  after             jsonb
);

CREATE INDEX IF NOT EXISTS idx_ie_change_log_voucher
  ON app_private.income_expense_change_log (income_expense_id, changed_at DESC);

REVOKE ALL ON app_private.income_expense_change_log
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE app_private.income_expense_change_log_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.guard_ie_change_log_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'income_expense_change_log là append-only (thao tác %)', TG_OP
    USING ERRCODE = '55000';
END
$fn$;

DROP TRIGGER IF EXISTS a00_ie_change_log_append_only ON app_private.income_expense_change_log;
CREATE TRIGGER a00_ie_change_log_append_only
  BEFORE UPDATE OR DELETE ON app_private.income_expense_change_log
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_ie_change_log_append_only();

DROP TRIGGER IF EXISTS a00_ie_change_log_no_truncate ON app_private.income_expense_change_log;
CREATE TRIGGER a00_ie_change_log_no_truncate
  BEFORE TRUNCATE ON app_private.income_expense_change_log
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_ie_change_log_append_only();

-- Chỉ ghi những cột CÓ NGHĨA để đối soát. Bỏ nhiễu (updated_at, con trỏ nội bộ,
-- số version) — nếu không mỗi lần ghi sổ lại đẻ một dòng nhật ký rỗng nghĩa.
CREATE OR REPLACE FUNCTION app_private.log_income_expense_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_noise text[] := ARRAY[
    'updated_at', 'created_at', 'approval_version', 'posting_version',
    'source_payload_hash', 'birth_txid', 'birth_operation_id',
    'active_posting_id_v2', 'posting_id', 'posted_at_v2', 'reversed_by_posting_id',
    'sequence_no', 'prev_event_hash', 'event_hash'
  ];
  v_before jsonb;
  v_after  jsonb;
  v_cols   text[];
  v_id     uuid;
  v_org    uuid;
BEGIN
  IF TG_TABLE_NAME = 'income_expenses' THEN
    v_id  := COALESCE(NEW.id, OLD.id);
    v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  ELSE
    v_id  := COALESCE(NEW.income_expense_id, OLD.income_expense_id);
    v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT COALESCE(array_agg(key ORDER BY key), '{}')
      INTO v_cols
    FROM jsonb_each(to_jsonb(NEW)) n
    WHERE NOT (key = ANY (v_noise))
      AND n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key);
    IF cardinality(v_cols) = 0 THEN
      RETURN NULL;   -- chỉ nhiễu, không ghi
    END IF;
    SELECT jsonb_object_agg(k, to_jsonb(OLD) -> k) INTO v_before FROM unnest(v_cols) k;
    SELECT jsonb_object_agg(k, to_jsonb(NEW) -> k) INTO v_after  FROM unnest(v_cols) k;
  ELSIF TG_OP = 'DELETE' THEN
    v_before := to_jsonb(OLD);
    v_after  := NULL;
    v_cols   := ARRAY['*deleted*'];
  ELSE
    v_before := NULL;
    v_after  := to_jsonb(NEW);
    v_cols   := ARRAY['*created*'];
  END IF;

  INSERT INTO app_private.income_expense_change_log
    (income_expense_id, organization_id, actor_id, db_role, scope, op,
     changed_cols, before, after)
  VALUES
    (v_id, v_org, auth.uid(), current_user,
     CASE WHEN TG_TABLE_NAME = 'income_expenses' THEN 'VOUCHER' ELSE 'ITEM' END,
     TG_OP, v_cols, v_before, v_after);

  RETURN NULL;   -- AFTER trigger
END
$fn$;

REVOKE ALL ON FUNCTION app_private.log_income_expense_change()
  FROM PUBLIC, anon, authenticated, service_role;

-- z99_: chạy SAU mọi trigger nghiệp vụ để chụp đúng trạng thái cuối cùng.
DROP TRIGGER IF EXISTS z99_ie_change_log ON public.income_expenses;
CREATE TRIGGER z99_ie_change_log
  AFTER UPDATE OR DELETE ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION app_private.log_income_expense_change();

DROP TRIGGER IF EXISTS z99_ie_items_change_log ON public.income_expense_items;
CREATE TRIGGER z99_ie_items_change_log
  AFTER INSERT OR UPDATE OR DELETE ON public.income_expense_items
  FOR EACH ROW EXECUTE FUNCTION app_private.log_income_expense_change();

-- Đọc cho giao diện đối soát. Giới hạn theo tổ chức của phiếu.
CREATE OR REPLACE FUNCTION public.get_voucher_change_log_v1(p_voucher uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE v_org uuid; v_out jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT ie.organization_id INTO v_org FROM public.income_expenses ie WHERE ie.id = p_voucher;
  IF v_org IS NULL THEN RETURN '[]'::jsonb; END IF;
  IF NOT public.is_super_admin() AND NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
     WHERE m.user_id = auth.uid() AND m.organization_id = v_org AND m.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'at', l.changed_at, 'actor_id', l.actor_id, 'actor_name', p.full_name,
           'scope', l.scope, 'op', l.op, 'cols', l.changed_cols,
           'before', l.before, 'after', l.after
         ) ORDER BY l.changed_at DESC, l.id DESC), '[]'::jsonb)
    INTO v_out
  FROM app_private.income_expense_change_log l
  LEFT JOIN public.profiles p ON p.id = l.actor_id
  WHERE l.income_expense_id = p_voucher;

  RETURN v_out;
END
$fn$;

REVOKE ALL ON FUNCTION public.get_voucher_change_log_v1(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_voucher_change_log_v1(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 2. NGƯỜI TẠO PHIẾU ĐƯỢC HUỶ PHIẾU CỦA CHÍNH MÌNH
--
-- Trước: chỉ người GIỮ SỔ (+ chủ tổ chức / super admin). Người tạo phiếu không
-- có cửa nào — đã đo: một người tự tạo phiếu rồi tự huỷ vẫn bị chặn.
-- Nay THÊM cửa người tạo, GIỮ nguyên hai cửa cũ, nên người giữ sổ vẫn dọn được
-- phiếu rác của nhân viên đã nghỉ.
--
-- Vẫn bị chặn bởi: assert_manual_voucher_v1 (phiếu luồng khác) và
-- assert_period_open_for_edit_v1 (kỳ đã chốt / đang bàn giao / lợi nhuận đã
-- chốt) — tức là "tới khi chốt kỳ thì không đụng nữa" giữ nguyên.
-- ─────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_def text;
  v_anchor text :=
    '  IF NOT v_is_super AND NOT app_private.is_org_owner_v1(v.organization_id, v_actor) THEN';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'cancel_income_expense_flex_v1';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Không có cancel_income_expense_flex_v1'; END IF;
  IF position('v.user_id IS DISTINCT FROM v_actor THEN' IN v_def) > 0 THEN
    RAISE NOTICE 'cancel_income_expense_flex_v1 đã có cửa người tạo — bỏ qua'; RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo cổng quyền trong cancel_income_expense_flex_v1 — DỪNG';
  END IF;
  v_def := replace(v_def, v_anchor,
    '  -- Người TẠO phiếu được huỷ phiếu của chính mình (yêu cầu của chủ 29/07).' || chr(10) ||
    '  IF NOT v_is_super AND NOT app_private.is_org_owner_v1(v.organization_id, v_actor)' || chr(10) ||
    '     AND v.user_id IS DISTINCT FROM v_actor THEN');
  EXECUTE v_def;
  RAISE NOTICE 'cancel_income_expense_flex_v1: người tạo phiếu huỷ được phiếu của mình';
END
$patch$;

DO $patch$
DECLARE
  v_def text;
  v_anchor text :=
    '    IF NOT v_super AND NOT app_private.is_org_owner_v1(v.organization_id, auth.uid()) THEN';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'can_flex_cancel_v1';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Không có can_flex_cancel_v1'; END IF;
  IF position('v.user_id IS DISTINCT FROM auth.uid() THEN' IN v_def) > 0 THEN
    RAISE NOTICE 'can_flex_cancel_v1 đã có cửa người tạo — bỏ qua'; RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo cổng quyền trong can_flex_cancel_v1 — DỪNG';
  END IF;
  -- Reader phải nói CÙNG câu chuyện với writer, nếu không nút lại nói dối.
  v_def := replace(v_def, v_anchor,
    '    IF NOT v_super AND NOT app_private.is_org_owner_v1(v.organization_id, auth.uid())' || chr(10) ||
    '       AND v.user_id IS DISTINCT FROM auth.uid() THEN');
  EXECUTE v_def;
  RAISE NOTICE 'can_flex_cancel_v1: đã khớp cửa người tạo';
END
$patch$;

COMMIT;

NOTIFY pgrst, 'reload schema';
