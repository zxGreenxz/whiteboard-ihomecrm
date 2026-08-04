-- =====================================================================
-- Đợt 3 — SIẾT KHOÁ SỔ (lớp thực thi cho "chốt & bàn giao")
--
-- Ship TRƯỚC mọi thao tác linh hoạt và TRƯỚC nghi thức chốt sổ. Rủi ro hồi quy
-- bằng KHÔNG: đã đo, 0/27 sổ quỹ đang có lock_date, nên hôm nay không phiếu
-- nào rơi vào kỳ khoá.
--
-- Yêu cầu #7 của chủ là "chốt xong thì khoá vĩnh viễn, không ai mở". Cơ chế
-- hiện tại KHÔNG đủ để nói câu đó — đã đo được ba lỗ:
--   1. `income_expenses_check_lock` khi UPDATE chỉ đọc NEW.account_id và
--      NEW.voucher_date. Đổi sổ sang quyển chưa khoá, hoặc đẩy ngày phiếu ra
--      sau ngày khoá, là THOÁT. Lại có WHEN (OLD.deleted_at IS NULL) nên
--      soft-delete → sửa → restore cũng thoát.
--   2. Tồn quỹ cộng theo account của TỪNG DÒNG posting, mà dòng CHANGE/ROUNDING
--      rơi vào sổ KHÁC (sổ Thối / Làm tròn). Một phiếu trên sổ đang mở, ngày ≤ X,
--      với change_account_id trỏ vào sổ đã chốt, sẽ làm đổi số dư của sổ đã chốt.
--      Trigger cũ không hề nhìn hai cột đó.
--   3. Không có trigger khoá nào trên income_expense_items.
--
-- Ngoại lệ CÓ CHỦ Ý (quyết định #8 của chủ): sau khi chốt vẫn ĐƯỢC bổ sung ảnh
-- chứng từ và ghi chú. Cửa này đi qua năng lực ANNOTATE của Đợt 2 và guard vẫn
-- tự kiểm delta đúng ba cột — không phải "tin lời" writer.
-- =====================================================================

BEGIN;

-- ── 1. Sổ ghi nhận CHỐT (nguồn sự thật của kỳ khoá) ─────────────────
CREATE TABLE IF NOT EXISTS app_private.cashbook_closures (
  id                 bigserial PRIMARY KEY,
  organization_id    uuid NOT NULL,
  cashbook_id        uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  closed_through     date NOT NULL,
  counted_balance    numeric(15,2),
  system_balance     numeric(15,2),
  basis              text NOT NULL DEFAULT 'POSTING_TRUTH_BY_POSTED_ON',
  reconciliation_id  uuid,
  proposed_by        uuid,
  confirmed_by       uuid,
  confirmed_at       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cashbook_closures_lookup
  ON app_private.cashbook_closures (cashbook_id, closed_through DESC);

REVOKE ALL ON app_private.cashbook_closures FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE app_private.cashbook_closures_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.guard_cashbook_closures_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '[CASHBOOK_CLOSED] Biên bản chốt sổ là append-only (thao tác %)', TG_OP
    USING ERRCODE = '55000';
END
$fn$;

DROP TRIGGER IF EXISTS a00_cashbook_closures_append_only ON app_private.cashbook_closures;
CREATE TRIGGER a00_cashbook_closures_append_only
  BEFORE UPDATE OR DELETE ON app_private.cashbook_closures
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_cashbook_closures_append_only();

DROP TRIGGER IF EXISTS a00_cashbook_closures_no_truncate ON app_private.cashbook_closures;
CREATE TRIGGER a00_cashbook_closures_no_truncate
  BEFORE TRUNCATE ON app_private.cashbook_closures
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_cashbook_closures_append_only();

-- Ngày khoá hiệu lực = muộn nhất giữa biên bản chốt và lock_date lịch sử.
-- GREATEST bỏ qua NULL nên sổ chưa chốt & chưa khoá trả NULL.
--
-- NGOẠI LỆ DUY NHẤT: cờ transaction-local `app_private.demo_reset`. Chỉ
-- public.demo_reset() bật cờ này (xem bản vá bên dưới) vì nó phải xoá sạch dữ
-- liệu demo, mà DELETE phiếu trong kỳ đã chốt thì bị chính guard này chặn.
--
-- CỐ Ý KHÔNG miễn trừ theo "sổ thuộc người dùng demo": làm vậy thì TOÀN BỘ org
-- DEMO — nơi chạy mọi kiểm thử và E2E — nằm ngoài vòng khoá, tức là thứ được
-- kiểm thử không phải là thứ chạy thật. Cờ theo transaction giữ cho khoá có
-- hiệu lực đầy đủ trên demo, chỉ nhả đúng lúc reset.
CREATE OR REPLACE FUNCTION app_private.cashbook_closed_through_v1(p_cashbook uuid)
RETURNS date
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT CASE
    WHEN COALESCE(current_setting('app_private.demo_reset', true), '') = 'on' THEN NULL
    ELSE GREATEST(
      (SELECT max(c.closed_through) FROM app_private.cashbook_closures c
        WHERE c.cashbook_id = p_cashbook),
      (SELECT a.lock_date FROM public.accounts a WHERE a.id = p_cashbook)
    )
  END;
$fn$;

REVOKE ALL ON FUNCTION app_private.cashbook_closed_through_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 2. Trigger khoá trên phiếu — đọc CẢ OLD LẪN NEW, cả ba sổ ───────
CREATE OR REPLACE FUNCTION public.income_expenses_check_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_pairs record;
  v_lock date;
  v_name text;
BEGIN
  -- Ngoại lệ ANNOTATE (quyết định #8): sau khi chốt vẫn bổ sung được ảnh
  -- chứng từ / ghi chú. Guard TỰ KIỂM delta chứ không tin lời writer — phiếu
  -- không flow-owned không có lớp kiểm cột nào khác.
  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM app_private.ie_flex_writer_xids w
     WHERE w.income_expense_id = OLD.id
       AND w.transaction_id = pg_current_xact_id()
       AND w.backend_pid = pg_backend_pid()
       AND w.scope = 'ANNOTATE'
  ) AND (to_jsonb(OLD) - ARRAY['attachments','notes','updated_at'])
        IS NOT DISTINCT FROM
        (to_jsonb(NEW) - ARRAY['attachments','notes','updated_at']) THEN
    RETURN NEW;
  END IF;

  -- Mọi cặp (sổ, ngày) mà thao tác này CHẠM tới — cả phía cũ lẫn phía mới, và
  -- cả sổ Thối / sổ Làm tròn, vì tồn quỹ cộng theo account của từng DÒNG posting.
  FOR v_pairs IN
    SELECT acct, vdate FROM (
      SELECT CASE WHEN TG_OP <> 'INSERT' THEN OLD.account_id END          AS acct,
             CASE WHEN TG_OP <> 'INSERT' THEN OLD.voucher_date END        AS vdate
      UNION ALL
      SELECT CASE WHEN TG_OP <> 'INSERT' THEN OLD.change_account_id END,
             CASE WHEN TG_OP <> 'INSERT' THEN OLD.voucher_date END
      UNION ALL
      SELECT CASE WHEN TG_OP <> 'INSERT' THEN OLD.rounding_account_id END,
             CASE WHEN TG_OP <> 'INSERT' THEN OLD.voucher_date END
      UNION ALL
      SELECT CASE WHEN TG_OP <> 'DELETE' THEN NEW.account_id END,
             CASE WHEN TG_OP <> 'DELETE' THEN NEW.voucher_date END
      UNION ALL
      SELECT CASE WHEN TG_OP <> 'DELETE' THEN NEW.change_account_id END,
             CASE WHEN TG_OP <> 'DELETE' THEN NEW.voucher_date END
      UNION ALL
      SELECT CASE WHEN TG_OP <> 'DELETE' THEN NEW.rounding_account_id END,
             CASE WHEN TG_OP <> 'DELETE' THEN NEW.voucher_date END
    ) s
    WHERE acct IS NOT NULL AND vdate IS NOT NULL
  LOOP
    -- FOR KEY SHARE: giao dịch ghi phiếu giữ khoá dòng trên `accounts`, nên
    -- giao dịch đang CHỐT SỔ (FOR UPDATE) phải chờ. Không có nó thì trigger
    -- đọc lock_date bằng SELECT trần và hai bên không bao giờ đụng nhau —
    -- một phiếu vẫn lọt vào kỳ vừa bị đóng băng vĩnh viễn.
    PERFORM 1 FROM public.accounts a WHERE a.id = v_pairs.acct FOR KEY SHARE;

    v_lock := app_private.cashbook_closed_through_v1(v_pairs.acct);
    IF v_lock IS NOT NULL AND v_pairs.vdate <= v_lock THEN
      SELECT a.name INTO v_name FROM public.accounts a WHERE a.id = v_pairs.acct;
      RAISE EXCEPTION
        '[CASHBOOK_CLOSED] Sổ quỹ "%" đã chốt & bàn giao tới ngày % — phiếu có ngày phát sinh ≤ ngày này không sửa/huỷ/xoá được nữa.',
        COALESCE(v_name, v_pairs.acct::text), v_lock
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$fn$;

-- Bỏ WHEN (OLD.deleted_at IS NULL): soft-delete → sửa → restore từng là đường
-- thoát khỏi kỳ khoá.
DROP TRIGGER IF EXISTS trg_ie_check_lock_upd ON public.income_expenses;
CREATE TRIGGER trg_ie_check_lock_upd
  BEFORE UPDATE ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION public.income_expenses_check_lock();

-- ── 3. Khoá cả hạng mục phiếu ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.income_expense_items_check_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_parent uuid;
  v_row record;
  v_lock date;
  v_name text;
BEGIN
  FOREACH v_parent IN ARRAY ARRAY[
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.income_expense_id END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.income_expense_id END
  ] LOOP
    CONTINUE WHEN v_parent IS NULL;
    FOR v_row IN
      SELECT unnest(ARRAY[ie.account_id, ie.change_account_id, ie.rounding_account_id]) AS acct,
             ie.voucher_date AS vdate
      FROM public.income_expenses ie WHERE ie.id = v_parent
    LOOP
      CONTINUE WHEN v_row.acct IS NULL OR v_row.vdate IS NULL;
      v_lock := app_private.cashbook_closed_through_v1(v_row.acct);
      IF v_lock IS NOT NULL AND v_row.vdate <= v_lock THEN
        SELECT a.name INTO v_name FROM public.accounts a WHERE a.id = v_row.acct;
        RAISE EXCEPTION
          '[CASHBOOK_CLOSED] Sổ quỹ "%" đã chốt tới ngày % — không sửa được hạng mục của phiếu trong kỳ đã chốt.',
          COALESCE(v_name, v_row.acct::text), v_lock
          USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END;
$fn$;

DROP TRIGGER IF EXISTS a01_ie_items_check_lock ON public.income_expense_items;
CREATE TRIGGER a01_ie_items_check_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.income_expense_items
  FOR EACH ROW EXECUTE FUNCTION public.income_expense_items_check_lock();

-- ── 4. Khoá ở tầng SỔ CÁI (dòng posting) ────────────────────────────
-- Bắt buộc phải canh theo account của DÒNG: accounts_with_balance cộng
-- `l.account_id`, mà dòng CHANGE/ROUNDING mang account khác với header.
CREATE OR REPLACE FUNCTION public.income_expense_posting_lines_check_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_acct uuid;
  v_posting uuid;
  v_kind text;
  v_on date;
  v_lock date;
  v_name text;
BEGIN
  v_acct   := COALESCE(NEW.account_id, OLD.account_id);
  v_posting := COALESCE(NEW.posting_id, OLD.posting_id);
  IF v_acct IS NULL OR v_posting IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT p.event_kind,
         CASE
           -- Bút toán ĐẢO luôn mang ngày hôm nay. Nếu xét theo ngày của chính
           -- nó thì chốt sổ tới HÔM NAY sẽ khoá luôn cả ngày hôm đó và không
           -- ai đảo được gì nữa. Kỳ bị đụng thật sự là kỳ của bút toán GỐC.
           WHEN p.event_kind = 'REVERSAL' AND p.reversal_of_id IS NOT NULL
             THEN (SELECT o.posted_on FROM public.income_expense_postings o WHERE o.id = p.reversal_of_id)
           ELSE p.posted_on
         END
    INTO v_kind, v_on
  FROM public.income_expense_postings p WHERE p.id = v_posting;

  IF v_on IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  v_lock := app_private.cashbook_closed_through_v1(v_acct);
  IF v_lock IS NOT NULL AND v_on <= v_lock THEN
    SELECT a.name INTO v_name FROM public.accounts a WHERE a.id = v_acct;
    RAISE EXCEPTION
      '[CASHBOOK_CLOSED] Sổ quỹ "%" đã chốt tới ngày % — không ghi thêm bút toán vào kỳ đã chốt.',
      COALESCE(v_name, v_acct::text), v_lock
      USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$fn$;

DROP TRIGGER IF EXISTS a01_ie_posting_lines_check_lock ON public.income_expense_posting_lines;
CREATE TRIGGER a01_ie_posting_lines_check_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.income_expense_posting_lines
  FOR EACH ROW EXECUTE FUNCTION public.income_expense_posting_lines_check_lock();

-- ── 5. Khoá chính bản thân SỔ QUỸ ───────────────────────────────────
-- Chỉ khoá lock_date là chưa đủ: accounts_with_balance = initial_amount + Σ
-- dòng posting, nên đổi `initial_amount` là ĐỔI CHÍNH CON SỐ người nhận đã
-- đếm và ký, mà không sinh một phiếu hay bút toán nào.
--
-- SECURITY INVOKER (mặc định) là BẮT BUỘC: trong hàm SECURITY DEFINER owner
-- postgres thì current_user luôn là postgres — guard kiểm current_user sẽ
-- không chặn được ai (án lệ đã ghi nhận trong repo).
CREATE OR REPLACE FUNCTION public.accounts_closed_book_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_closed date;
BEGIN
  v_closed := app_private.cashbook_closed_through_v1(OLD.id);
  IF v_closed IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.lock_date IS DISTINCT FROM OLD.lock_date
     AND (NEW.lock_date IS NULL OR NEW.lock_date < OLD.lock_date) THEN
    RAISE EXCEPTION
      '[CASHBOOK_CLOSED] Sổ quỹ đã chốt tới % — không lùi hoặc gỡ ngày khoá. Sai sót phát hiện sau chốt phải xử lý bằng phiếu điều chỉnh ở kỳ hiện tại.',
      v_closed USING ERRCODE = 'P0001';
  END IF;

  IF NEW.initial_amount IS DISTINCT FROM OLD.initial_amount
     OR NEW.initial_date IS DISTINCT FROM OLD.initial_date
     OR NEW.is_virtual   IS DISTINCT FROM OLD.is_virtual
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION
      '[CASHBOOK_CLOSED] Sổ quỹ đã chốt tới % — không đổi số dư đầu, ngày đầu, loại sổ, tổ chức hay người phụ trách.',
      v_closed USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS a00_accounts_closed_book_guard ON public.accounts;
CREATE TRIGGER a00_accounts_closed_book_guard
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.accounts_closed_book_guard();

-- ── 6. Bịt đường mở khoá ────────────────────────────────────────────
-- Viết lại từ ĐỊNH NGHĨA ĐANG CHẠY (đã dump), chỉ đổi nhánh p_unlock.
CREATE OR REPLACE FUNCTION public.lock_cashbook_period_v1(
  p_cashbook_id uuid,
  p_lock_date date,
  p_unlock boolean DEFAULT false
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
declare
  v_actor uuid := auth.uid();
  v_acct record; v_org uuid; v_authz boolean; v_route text; v_new date;
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;

  -- Đợt 3: MỞ KHOÁ KHÔNG CÒN LÀ MỘT KHÁI NIỆM (quyết định #7 của chủ).
  if p_unlock then
    raise exception
      '[CASHBOOK_CLOSED] Không mở khoá kỳ đã chốt. Sai sót phát hiện sau khi bàn giao phải xử lý bằng phiếu điều chỉnh ở kỳ hiện tại.'
      using errcode='55000';
  end if;

  select a.id, a.organization_id, a.lock_date into v_acct
    from public.accounts a where a.id=p_cashbook_id and a.deleted_at is null for update;
  if not found then raise exception 'Không tìm thấy sổ quỹ' using errcode='42501'; end if;
  v_org := v_acct.organization_id;
  if v_org is null then raise exception 'Sổ quỹ chưa gắn tổ chức' using errcode='23514'; end if;

  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'cashbooks.edit', null, p_cashbook_id);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền khoá sổ (cashbooks.edit)' using errcode='42501'; end if;

  v_route := app_private.evaluate_feature_route('cashbook.lock_period.v1', v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer khoá sổ chưa bật' using errcode='55000'; end if;

  if p_lock_date is null then raise exception 'Ngày khoá trống'; end if;
  if v_acct.lock_date is not null and p_lock_date < v_acct.lock_date then
    raise exception 'Không thể lùi ngày khoá sổ' using errcode='55000'; end if;
  v_new := p_lock_date;

  update public.accounts set lock_date = v_new where id = p_cashbook_id;
  return json_build_object('cashbook_id', p_cashbook_id, 'lock_date', v_new);
end;
$fn$;

-- create_opening_adjustment gỡ lock_date NULL giữa transaction rồi khoá lại —
-- mẫu bypass không được phép tồn tại song song với khoá vĩnh viễn.
REVOKE EXECUTE ON FUNCTION public.create_opening_adjustment(uuid, numeric, date)
  FROM authenticated, service_role;

-- ── 7. Cho demo_reset() một cửa hợp pháp ────────────────────────────
-- demo_reset xoá sạch dữ liệu demo; DELETE phiếu trong kỳ đã chốt sẽ bị guard
-- mới chặn và reset chết giữa chừng. Bật cờ transaction-local ngay trước bước
-- gỡ khoá sẵn có của nó. VÁ TẠI CHỖ để không viết đè một hàm dài đã tiến hoá
-- qua nhiều đợt.
DO $patch$
DECLARE
  v_def text;
  v_anchor text := '  -- 5b (04/07): GỠ KHOÁ SỔ demo trước khi xoá';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'demo_reset';

  IF v_def IS NULL THEN
    RAISE NOTICE 'Không có public.demo_reset — bỏ qua';
    RETURN;
  END IF;
  IF position('app_private.demo_reset' IN v_def) > 0 THEN
    RAISE NOTICE 'demo_reset đã bật cờ — bỏ qua';
    RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo trong demo_reset — DỪNG, không vá mù';
  END IF;

  v_def := replace(
    v_def,
    v_anchor,
    '  -- Đợt 3: nhả khoá kỳ đã chốt CHỈ trong transaction reset này.'
    || chr(10) || '  PERFORM set_config(''app_private.demo_reset'', ''on'', true);'
    || chr(10) || v_anchor
  );

  IF position('app_private.demo_reset' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vá demo_reset thất bại';
  END IF;
  EXECUTE v_def;
END
$patch$;

COMMIT;

NOTIFY pgrst, 'reload schema';
