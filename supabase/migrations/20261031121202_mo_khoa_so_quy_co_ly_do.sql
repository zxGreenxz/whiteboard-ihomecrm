-- Chủ tổ chức được mở lại sổ có lý do. Biên bản chốt cũ luôn được giữ nguyên.
-- Mỗi lần mở vô hiệu hóa đúng các biên bản đã tồn tại dưới khóa accounts;
-- biên bản chốt lại (kể cả cùng ngày) có id mới và tiếp tục khóa bình thường.
-- Không mở khóa lợi nhuận, bàn giao hoặc cấp quyền sửa phiếu cho người mở sổ.
-- Lane sở hữu transaction. Chạy lại được, không sửa dữ liệu lịch sử.

-- Cùng tập whitespace với String.trim ở giao diện; btrim mặc định chỉ bỏ dấu
-- cách nên tab/newline hoặc NBSP có thể giả thành lý do đủ dài.
CREATE OR REPLACE FUNCTION app_private.normalize_cashbook_reopening_reason_v1(p_reason text)
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path TO 'pg_catalog'
AS $fn$
  SELECT btrim(COALESCE(p_reason, ''), U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
$fn$;
REVOKE ALL ON FUNCTION app_private.normalize_cashbook_reopening_reason_v1(text) FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS app_private.cashbook_reopenings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  -- Audit giữ UUID kể cả khi fixture DEMO xóa/tạo lại sổ; không tạo thêm FK
  -- chặn reset. RPC khóa và xác minh tài khoản trước khi ghi sự kiện.
  cashbook_id uuid NOT NULL,
  reopened_by uuid NOT NULL,
  reopened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason text NOT NULL CHECK (
    char_length(app_private.normalize_cashbook_reopening_reason_v1(reason)) BETWEEN 10 AND 1000
    AND reason = app_private.normalize_cashbook_reopening_reason_v1(reason)),
  previous_lock_date date NOT NULL,
  previous_account_lock_date date,
  previous_revision text NOT NULL,
  last_closure_id bigint NOT NULL CHECK (last_closure_id >= 0),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS cashbook_reopenings_book_idx
  ON app_private.cashbook_reopenings(cashbook_id, last_closure_id);
REVOKE ALL ON app_private.cashbook_reopenings FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.guard_cashbook_reopenings_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  RAISE EXCEPTION '[REOPEN_HISTORY_IMMUTABLE] Không sửa hoặc xóa lịch sử mở sổ.' USING ERRCODE = '55000';
END
$fn$;
REVOKE ALL ON FUNCTION app_private.guard_cashbook_reopenings_append_only() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS cashbook_reopenings_append_only ON app_private.cashbook_reopenings;
CREATE TRIGGER cashbook_reopenings_append_only BEFORE UPDATE OR DELETE ON app_private.cashbook_reopenings
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_cashbook_reopenings_append_only();
DROP TRIGGER IF EXISTS cashbook_reopenings_no_truncate ON app_private.cashbook_reopenings;
CREATE TRIGGER cashbook_reopenings_no_truncate BEFORE TRUNCATE ON app_private.cashbook_reopenings
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_cashbook_reopenings_append_only();

-- Năng lực ghi chỉ sống trong đoạn UPDATE của RPC; không tin GUC do client đặt,
-- không cho dùng lại biên nhận bền vững để mở thêm một lần trong cùng transaction.
CREATE TABLE IF NOT EXISTS app_private.cashbook_reopen_write_context (
  cashbook_id uuid NOT NULL,
  reopening_id uuid NOT NULL REFERENCES app_private.cashbook_reopenings(id),
  transaction_id xid8 NOT NULL,
  backend_pid integer NOT NULL,
  PRIMARY KEY (cashbook_id, transaction_id, backend_pid)
);
REVOKE ALL ON app_private.cashbook_reopen_write_context FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.cashbook_closed_through_v1(p_cashbook uuid)
RETURNS date LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT CASE
    WHEN COALESCE(current_setting('app_private.demo_reset', true), '') = 'on' THEN NULL
    ELSE GREATEST(
      (SELECT max(c.closed_through) FROM app_private.cashbook_closures c
        WHERE c.cashbook_id = p_cashbook
          AND c.id > COALESCE((SELECT max(r.last_closure_id)
            FROM app_private.cashbook_reopenings r WHERE r.cashbook_id = p_cashbook), 0)),
      (SELECT a.lock_date FROM public.accounts a WHERE a.id = p_cashbook)
    )
  END;
$fn$;
REVOKE ALL ON FUNCTION app_private.cashbook_closed_through_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.cashbook_reopening_revision_v1(p_cashbook uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT md5(jsonb_build_object(
    'cashbook_id', p_cashbook,
    'lock_date', app_private.cashbook_closed_through_v1(p_cashbook),
    'last_closure_id', (SELECT COALESCE(max(c.id), 0) FROM app_private.cashbook_closures c WHERE c.cashbook_id = p_cashbook),
    'reopening_count', (SELECT count(*) FROM app_private.cashbook_reopenings r WHERE r.cashbook_id = p_cashbook)
  )::text);
$fn$;
REVOKE ALL ON FUNCTION app_private.cashbook_reopening_revision_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.accounts_closed_book_guard()
RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE v_closed date; v_reopening boolean;
BEGIN
  v_closed := app_private.cashbook_closed_through_v1(OLD.id);
  IF v_closed IS NULL THEN RETURN NEW; END IF;

  IF NEW.lock_date IS DISTINCT FROM OLD.lock_date
     AND (NEW.lock_date IS NULL OR NEW.lock_date < OLD.lock_date) THEN
    SELECT EXISTS (
      SELECT 1 FROM app_private.cashbook_reopen_write_context w
      JOIN app_private.cashbook_reopenings r ON r.id = w.reopening_id
      WHERE w.cashbook_id = OLD.id
        AND w.transaction_id = pg_current_xact_id()
        AND w.backend_pid = pg_backend_pid()
        AND r.cashbook_id = OLD.id AND r.organization_id = OLD.organization_id
        AND r.reopened_by = auth.uid()
        AND r.previous_account_lock_date IS NOT DISTINCT FROM OLD.lock_date
        AND NEW.lock_date IS NULL
        AND (to_jsonb(OLD) - ARRAY['lock_date', 'updated_at'])
          IS NOT DISTINCT FROM (to_jsonb(NEW) - ARRAY['lock_date', 'updated_at'])
    ) INTO v_reopening;
    IF NOT v_reopening THEN
      RAISE EXCEPTION '[CASHBOOK_CLOSED] Chỉ chủ tổ chức được mở sổ qua thao tác Mở khóa có lý do.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.initial_amount IS DISTINCT FROM OLD.initial_amount
     OR NEW.initial_date IS DISTINCT FROM OLD.initial_date
     OR NEW.is_virtual IS DISTINCT FROM OLD.is_virtual
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION '[CASHBOOK_CLOSED] Sổ quỹ đã chốt tới % — không đổi số dư đầu, ngày đầu, loại sổ, tổ chức hay người phụ trách.',
      v_closed USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.accounts_closed_book_guard() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cashbook_reopening_state_v1(p_cashbook uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE v_actor uuid := auth.uid(); v_org uuid; v_lock date; v_can boolean; v_history jsonb; v_pending boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION '[REOPEN_FORBIDDEN] Chưa đăng nhập.' USING ERRCODE = '42501'; END IF;
  SELECT a.organization_id INTO v_org FROM public.accounts a
    WHERE a.id = p_cashbook AND a.deleted_at IS NULL;
  IF v_org IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organizations o WHERE o.id = v_org AND o.status = 'ACTIVE'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
    WHERE m.organization_id = v_org AND m.user_id = v_actor AND m.status = 'ACTIVE'
      AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= now()
      AND (m.valid_to IS NULL OR m.valid_to > now())
  ) OR NOT EXISTS (
    SELECT 1 FROM app_private.ie_visible_cashbook_ids_v1() v WHERE v.cashbook_id = p_cashbook
  ) THEN
    RAISE EXCEPTION '[REOPEN_FORBIDDEN] Không có quyền xem trạng thái của sổ này.' USING ERRCODE = '42501';
  END IF;
  v_lock := app_private.cashbook_closed_through_v1(p_cashbook);
  v_can := COALESCE(app_private.ie_actor_is_company_owner_v1(v_org, v_actor), false) AND v_lock IS NOT NULL;
  v_pending := EXISTS (SELECT 1 FROM app_private.cashbook_closure_requests q
    WHERE q.cashbook_id = p_cashbook AND q.status = 'PENDING');
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'reopened_at', r.reopened_at,
    'reopened_by_name', p.full_name, 'reason', r.reason,
    'previous_lock_date', r.previous_lock_date,
    'idempotency_key', r.idempotency_key, 'previous_revision', r.previous_revision,
    'last_closure_id', r.last_closure_id
  ) ORDER BY r.reopened_at DESC, r.id DESC), '[]'::jsonb) INTO v_history
  FROM app_private.cashbook_reopenings r LEFT JOIN public.profiles p ON p.id = r.reopened_by
  WHERE r.cashbook_id = p_cashbook AND r.organization_id = v_org;
  RETURN jsonb_build_object('cashbook_id', p_cashbook, 'can_reopen', COALESCE(v_can, false),
    'blocked_reason', CASE WHEN v_pending THEN 'PENDING_CLOSURE' END,
    'lock_date', v_lock, 'revision', app_private.cashbook_reopening_revision_v1(p_cashbook), 'history', v_history);
END
$fn$;
REVOKE ALL ON FUNCTION public.cashbook_reopening_state_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cashbook_reopening_state_v1(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reopen_cashbook_v1(
  p_cashbook uuid, p_reason text, p_expected_lock_date date, p_idempotency_key uuid, p_expected_revision text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_actor uuid := auth.uid(); v_account public.accounts%ROWTYPE;
  v_reason text := app_private.normalize_cashbook_reopening_reason_v1(p_reason); v_lock date; v_revision text;
  v_hash text; v_existing app_private.cashbook_reopenings%ROWTYPE;
  v_id uuid := gen_random_uuid(); v_last_closure bigint;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION '[REOPEN_FORBIDDEN] Chưa đăng nhập.' USING ERRCODE = '42501'; END IF;
  IF char_length(v_reason) NOT BETWEEN 10 AND 1000 THEN
    RAISE EXCEPTION '[REOPEN_REASON_REQUIRED] Lý do mở sổ phải có từ 10 đến 1000 ký tự.' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL OR p_expected_revision IS NULL OR p_expected_revision !~ '^[0-9a-f]{32}$'
     OR p_expected_lock_date IS NULL THEN
    RAISE EXCEPTION '[REOPEN_STALE] Tải lại trạng thái sổ trước khi mở khóa.' USING ERRCODE = '40001';
  END IF;

  -- Cùng khóa với chốt sổ và writer phiếu. Không khóa request sau accounts:
  -- confirm khóa request trước accounts; đọc pending rồi từ chối tránh đảo thứ tự.
  SELECT * INTO v_account FROM public.accounts a WHERE a.id = p_cashbook AND a.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR v_account.organization_id IS NULL THEN
    RAISE EXCEPTION '[REOPEN_FORBIDDEN] Không có quyền mở sổ này.' USING ERRCODE = '42501';
  END IF;
  IF app_private.lock_org_for_decision_v1(v_account.organization_id) IS NULL THEN
    RAISE EXCEPTION '[REOPEN_FORBIDDEN] Tổ chức của sổ không còn hoạt động.' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(app_private.ie_actor_is_company_owner_v1(v_account.organization_id, v_actor), false) THEN
    RAISE EXCEPTION '[REOPEN_FORBIDDEN] Chỉ chủ tổ chức của sổ được mở khóa.' USING ERRCODE = '42501';
  END IF;

  v_hash := md5(jsonb_build_object('cashbook_id', p_cashbook, 'actor', v_actor, 'reason', v_reason,
    'lock_date', p_expected_lock_date, 'revision', p_expected_revision)::text);
  -- Khóa key xuyên sổ trong cùng org, rồi kiểm payload trước kiểm trạng thái mới.
  PERFORM pg_advisory_xact_lock(hashtext(v_account.organization_id::text), hashtext('cashbook-reopen:' || p_idempotency_key::text));
  SELECT * INTO v_existing FROM app_private.cashbook_reopenings r
    WHERE r.organization_id = v_account.organization_id AND r.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_hash <> v_hash THEN
      RAISE EXCEPTION '[REOPEN_KEY_REUSED] Mã thao tác đã dùng với yêu cầu khác.' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('cashbook_id', p_cashbook, 'reopening_id', v_existing.id,
      'status', 'REOPENED', 'lock_date', NULL, 'idempotency_key', p_idempotency_key,
      'previous_revision', v_existing.previous_revision, 'idempotent_replay', true);
  END IF;

  v_lock := app_private.cashbook_closed_through_v1(p_cashbook);
  IF v_lock IS NULL THEN RAISE EXCEPTION '[REOPEN_NOT_LOCKED] Sổ đang mở.' USING ERRCODE = '55000'; END IF;
  v_revision := app_private.cashbook_reopening_revision_v1(p_cashbook);
  IF v_lock IS DISTINCT FROM p_expected_lock_date OR v_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION '[REOPEN_STALE] Trạng thái sổ đã thay đổi. Tải lại và kiểm tra trước khi mở.' USING ERRCODE = '40001';
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.cashbook_closure_requests q WHERE q.cashbook_id = p_cashbook AND q.status = 'PENDING') THEN
    RAISE EXCEPTION '[REOPEN_PENDING_CLOSURE] Hủy đề nghị chốt đang chờ trước khi mở khóa.' USING ERRCODE = '55000';
  END IF;
  SELECT COALESCE(max(c.id), 0) INTO v_last_closure FROM app_private.cashbook_closures c WHERE c.cashbook_id = p_cashbook;
  INSERT INTO app_private.cashbook_reopenings (id, organization_id, cashbook_id, reopened_by, reason,
    previous_lock_date, previous_account_lock_date, previous_revision, last_closure_id, idempotency_key, request_hash)
  VALUES (v_id, v_account.organization_id, p_cashbook, v_actor, v_reason, v_lock,
    v_account.lock_date, v_revision, v_last_closure, p_idempotency_key, v_hash);
  INSERT INTO app_private.cashbook_reopen_write_context(cashbook_id, reopening_id, transaction_id, backend_pid)
  VALUES (p_cashbook, v_id, pg_current_xact_id(), pg_backend_pid());
  UPDATE public.accounts SET lock_date = NULL WHERE id = p_cashbook;
  DELETE FROM app_private.cashbook_reopen_write_context
    WHERE cashbook_id = p_cashbook AND transaction_id = pg_current_xact_id() AND backend_pid = pg_backend_pid();
  IF app_private.cashbook_closed_through_v1(p_cashbook) IS NOT NULL THEN
    RAISE EXCEPTION '[REOPEN_STALE] Chưa xác nhận được sổ đã mở; thao tác đã được hoàn tác.' USING ERRCODE = '40001';
  END IF;
  RETURN jsonb_build_object('cashbook_id', p_cashbook, 'reopening_id', v_id, 'status', 'REOPENED',
    'lock_date', NULL, 'idempotency_key', p_idempotency_key, 'previous_revision', v_revision, 'idempotent_replay', false);
END
$fn$;
REVOKE ALL ON FUNCTION public.reopen_cashbook_v1(uuid, text, date, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reopen_cashbook_v1(uuid, text, date, uuid, text) TO authenticated;

-- Các cửa mở cũ tiếp tục bị thu quyền; chỉ API mới có lý do và biên nhận được dùng.
REVOKE ALL ON FUNCTION public.lock_cashbook_period_v1(uuid, date, boolean) FROM PUBLIC, anon, authenticated, service_role;

DO $verify$
DECLARE v_fn regprocedure;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.cashbook_reopening_state_v1(uuid)'::regprocedure,
    'public.reopen_cashbook_v1(uuid,text,date,uuid,text)'::regprocedure
  ] LOOP
    IF NOT (SELECT p.prosecdef AND p.provolatile = 'v'
      AND p.proconfig = ARRAY['search_path=pg_catalog, app_private, public'] FROM pg_proc p WHERE p.oid = v_fn)
      OR has_function_privilege('anon', v_fn, 'EXECUTE')
      OR has_function_privilege('service_role', v_fn, 'EXECUTE')
      OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'cashbook reopening: sai ACL/volatility/search_path của %', v_fn;
    END IF;
  END LOOP;
END
$verify$;
NOTIFY pgrst, 'reload schema';
