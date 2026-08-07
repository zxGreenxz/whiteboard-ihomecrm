-- Bàn giao tiền mặt (bước NGƯỜI NHẬN xác nhận) chết 23505 duplicate key
-- "income_expense_v2_backfill_exceptions_key" — vá cả ba tầng nhân quả.
--
-- TRIỆU CHỨNG (prod, 07/08/2026): BG2608001 (26 phiếu, 87.620.000đ) tạo được
-- (cửa HANDOVER, 20260807140000) nhưng người nhận bấm "Xác nhận đã nhận" là
-- toast 'duplicate key value violates unique constraint
-- "income_expense_v2_backfill_exceptions_key"'. Tái hiện trong transaction
-- rollback bằng JWT người nhận: dup tại bridge a85, khi auto_recalc_total_amount
-- UPDATE total_amount của phiếu CHI chuyển vừa INSERT trong confirm_cash_handover.
--
-- CHUỖI NHÂN QUẢ (đo trực tiếp trên prod):
--   1. NHẦM TENANT — public._chung_building(p_user) nhánh "tenant thật"
--      (20260704210000) chọn tòa ảo non-demo ĐẦU TIÊN THEO created_at TOÀN
--      HỆ THỐNG, không lọc org, không tiebreaker. Thời 04/07 chỉ có MỘT org
--      thật nên đúng; clone_org_sync (20260801060000) trồng vào org Test
--      cccc0000-… một "Kho Văn Phòng Chung" copy NGUYÊN created_at
--      (2026-04-26 07:08:21.091377 — trùng từng micro giây với tòa thật của
--      org aaaa0000-…) ⇒ pick thành nondeterministic và đang vớ tòa org Test.
--      Phiếu chuyển của confirm_cash_handover vì thế sinh ra ở org Test.
--   2. POSTER KHÔNG RESOLVE — giver/receiver không có membership ACTIVE trong
--      org Test ⇒ cả a85b (AFTER INSERT) lẫn a85 (BEFORE UPDATE, khi
--      auto_recalc bắn) đều rơi vào nhánh ghi exception BRIDGE_UNRESOLVED_POSTER.
--   3. EXCEPTION KHÔNG IDEMPOTENT — INSERT exception ở CẢ HAI bridge là chỗ
--      DUY NHẤT ghi bảng này thiếu ON CONFLICT DO NOTHING (unique index sinh
--      ra chính để "recorded once") ⇒ lần ghi thứ hai cùng (org, voucher,
--      reason) nổ 23505 ⇒ rollback cả confirm.
--
-- SỬA: (1) _chung_building lọc tòa theo org mà p_user có membership ACTIVE +
-- tiebreaker b.id; (2)+(3) hai bridge thêm ON CONFLICT DO NOTHING vào INSERT
-- exception. Sửa (1) là gốc (phiếu về đúng org aaaa, poster resolve được,
-- không còn exception nào sinh ra trên đường bàn giao); (2)+(3) là chốt an
-- toàn cho mọi ca unresolved-poster hợp lệ khác. create_opening_adjustment
-- cũng gọi _chung_building nên được chữa cùng. Không có dữ liệu org thật nào
-- đã sinh nhầm (mọi confirm từ 01/08 đều rollback; phiếu trên tòa Test từ
-- 01/08 toàn dữ liệu E2E của user test) — không cần data repair.
--
-- Ba hàm dưới là NGUYÊN VĂN pg_get_functiondef bản đang chạy trên prod
-- (07/08/2026, md5 pin trong preflight) + đúng phần sửa mô tả trên. Md5 lệch
-- là DỪNG — không vá mù (án "thân hàm prod lệch file migration").

BEGIN;

-- ── 1. Preflight: đúng bản đã đối chiếu, hoặc đã vá rồi thì đi tiếp ─────────
DO $preflight$
DECLARE
  v_def text;
  v_fn  text;
  v_md5 text;
  v_expect jsonb := jsonb_build_object(
    'public._chung_building',                          'fb1c730a0cab8d3d1670a8c9ac81c16f',
    'app_private.finance_v2_auto_posting_bridge',      '24531a236d381e8a8c44a56778359670',
    'app_private.finance_v2_auto_posting_bridge_insert','a325ae423805d1186f6a5bb839aa2403');
  v_marker jsonb := jsonb_build_object(
    'public._chung_building',                          'm.organization_id = b.organization_id',
    'app_private.finance_v2_auto_posting_bridge',      'ON CONFLICT DO NOTHING',
    'app_private.finance_v2_auto_posting_bridge_insert','ON CONFLICT DO NOTHING');
BEGIN
  FOR v_fn IN SELECT jsonb_object_keys(v_expect) LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = split_part(v_fn, '.', 1)
       AND p.proname  = split_part(v_fn, '.', 2);
    IF v_def IS NULL THEN
      RAISE EXCEPTION '% không tồn tại — dừng.', v_fn;
    END IF;
    IF position((v_marker ->> v_fn) IN v_def) > 0 THEN
      RAISE NOTICE '% đã có bản vá — replace lại bản y hệt.', v_fn;
      CONTINUE;
    END IF;
    v_md5 := md5(v_def);
    IF v_md5 <> (v_expect ->> v_fn) THEN
      RAISE EXCEPTION '% trên DB này KHÁC bản migration giả định (md5 %) — dừng lại, đối chiếu pg_get_functiondef trước khi replace.', v_fn, v_md5;
    END IF;
  END LOOP;
END
$preflight$;

-- ── 2. _chung_building: tòa chung hệ thống PHẢI nằm trong org của user ──────
CREATE OR REPLACE FUNCTION public._chung_building(p_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  -- Tenant thật: toà chung hệ thống = toà ảo không thuộc demo (hiện là
  -- "Kho Văn Phòng Chung") TRONG ĐÚNG ORG p_user có membership ACTIVE.
  -- Không lọc org từng đúng khi cả hệ chỉ có một org thật (20260704210000);
  -- clone_org_sync (20260801060000) nhân bản tòa ảo sang org Test và COPY
  -- NGUYÊN created_at ⇒ ORDER BY created_at không tiebreaker thành
  -- nondeterministic và vớ tòa org Test ⇒ phiếu bàn giao/điều chỉnh số dư
  -- sinh nhầm tenant, bridge V2 không resolve được poster. Thêm b.id làm
  -- tiebreaker cho ổn định.
  IF NOT (p_user_id = ANY (public.demo_user_ids())) THEN
    SELECT b.id INTO v_id FROM buildings b
     WHERE b.is_virtual = true AND b.deleted_at IS NULL
       AND NOT (b.user_id = ANY (public.demo_user_ids()))
       AND EXISTS (
         SELECT 1 FROM organization_memberships m
          WHERE m.user_id = p_user_id
            AND m.status = 'ACTIVE'
            AND m.organization_id = b.organization_id)
     ORDER BY b.created_at, b.id LIMIT 1;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;

  -- Fallback (demo, hoặc tenant chưa có toà chung): hành vi cũ
  SELECT id INTO v_id FROM buildings
   WHERE user_id = p_user_id AND is_virtual = true AND name = 'Chung'
     AND deleted_at IS NULL
   ORDER BY created_at LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO buildings (user_id, name, type, status, province, district, ward, is_virtual)
  VALUES (p_user_id, 'Chung', 'APARTMENT'::building_type, 'ACTIVE'::building_status, '—', '—', '—', true)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

-- ── 3. Bridge a85 (BEFORE UPDATE): exception ghi-một-lần đúng nghĩa ─────────
CREATE OR REPLACE FUNCTION app_private.finance_v2_auto_posting_bridge()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_acc public.accounts%ROWTYPE;
  v_active public.income_expense_postings%ROWTYPE;
  v_should boolean := false;
  v_poster uuid;
  v_membership uuid;
  v_gen bigint;
  v_new uuid;
  v_main numeric(18,2);
BEGIN
  -- Lifecycle V2 tự quản posting: approve-only giữ UNPOSTED, post RPC tự tạo event.
  IF EXISTS (SELECT 1 FROM app_private.ie_transition_authorization t
             WHERE t.income_expense_id = NEW.id AND t.xid = pg_current_xact_id()
               AND t.purpose = 'FINANCE_V2_LIFECYCLE') THEN
    RETURN NEW;
  END IF;
  -- Chỉ chạy khi posting route CANONICAL (trước đó legacy semantics giữ nguyên).
  IF app_private.evaluate_feature_route('income_expense.posting.v2', NEW.organization_id) <> 'CANONICAL' THEN
    RETURN NEW;
  END IF;

  -- V2 writer đã tự quản posting trong cùng lệnh (pointer đã set) → bridge không đụng.
  SELECT p.* INTO v_active FROM public.income_expense_postings p WHERE p.id = NEW.active_posting_id_v2;

  -- Voucher này CÓ NÊN có cash posting không (đúng công thức backfill/replay)?
  IF NEW.deleted_at IS NULL AND NEW.approval_status = 'APPROVED' AND NEW.account_id IS NOT NULL
     AND COALESCE(NEW.total_amount, 0) > 0 THEN
    SELECT * INTO v_acc FROM public.accounts WHERE id = NEW.account_id;
    IF FOUND AND COALESCE(v_acc.is_virtual, false) = false AND v_acc.deleted_at IS NULL THEN
      v_should := true;
    END IF;
  END IF;

  -- (a) Active posting nhưng không còn nên có (unapprove/cancel/delete/đổi sổ) → REVERSAL.
  IF v_active.id IS NOT NULL AND (NOT v_should OR v_active.account_id IS DISTINCT FROM NEW.account_id
      OR v_active.gross_amount IS DISTINCT FROM NEW.total_amount) THEN
    INSERT INTO public.income_expense_postings
      (organization_id, voucher_id, posting_subject_kind, posting_subject_id, direction,
       account_id, gross_amount, voucher_amount_snapshot, amount_basis, net_cash_effect,
       posted_on, posted_by_membership_id, posted_by_user_id, approval_version,
       event_kind, idempotency_key, source_kind, posting_generation, reversal_of_id, reversal_reason)
    VALUES
      (v_active.organization_id, v_active.voucher_id, 'VOUCHER', v_active.posting_subject_id,
       v_active.direction, v_active.account_id, v_active.gross_amount,
       v_active.voucher_amount_snapshot, v_active.amount_basis, -v_active.net_cash_effect,
       public.org_today_v1(NULL), v_active.posted_by_membership_id, v_active.posted_by_user_id,
       COALESCE(NEW.approval_version, 1), 'REVERSAL',
       'bridge:rev:' || v_active.id::text, 'LEGACY_BRIDGE', v_active.posting_generation,
       v_active.id, 'auto-bridge: legacy writer changed cash projection')
    ON CONFLICT (organization_id, idempotency_key) DO NOTHING;
    INSERT INTO public.income_expense_posting_lines (organization_id, posting_id, account_id, line_kind, signed_amount)
    SELECT l.organization_id,
           (SELECT id FROM public.income_expense_postings
             WHERE organization_id = v_active.organization_id AND idempotency_key = 'bridge:rev:' || v_active.id::text),
           l.account_id, 'REVERSAL', -l.signed_amount
    FROM public.income_expense_posting_lines l
    WHERE l.posting_id = v_active.id
      AND NOT EXISTS (SELECT 1 FROM public.income_expense_posting_lines x
        WHERE x.posting_id = (SELECT id FROM public.income_expense_postings
          WHERE organization_id = v_active.organization_id AND idempotency_key = 'bridge:rev:' || v_active.id::text));
    NEW.active_posting_id_v2 := NULL;
    NEW.posting_status := CASE WHEN v_should THEN 'REVERSED' ELSE
      CASE WHEN NEW.approval_status = 'APPROVED' THEN 'REVERSED' ELSE 'UNPOSTED' END END;
    v_active := NULL;
  END IF;

  -- (b) Nên có mà chưa có → POSTING generation mới.
  IF TG_OP = 'UPDATE' AND v_should AND v_active.id IS NULL AND NEW.active_posting_id_v2 IS NULL THEN
    v_poster := COALESCE(NEW.approved_by, NEW.user_id, auth.uid());
    SELECT m.id INTO v_membership FROM public.organization_memberships m
    WHERE m.user_id = v_poster AND m.organization_id = NEW.organization_id AND m.status = 'ACTIVE' LIMIT 1;
    IF v_membership IS NULL THEN
      SELECT m.id, m.user_id INTO v_membership, v_poster FROM public.organization_memberships m
      WHERE m.user_id = auth.uid() AND m.organization_id = NEW.organization_id AND m.status = 'ACTIVE' LIMIT 1;
    END IF;
    IF v_membership IS NULL THEN
      -- Không chặn nghiệp vụ legacy: ghi exception, parity monitor sẽ bắt.
      -- Unique index của bảng là "deterministic identity … recorded once" —
      -- cùng (org, voucher, reason) gặp lại trong đời (a85b đã ghi lúc INSERT,
      -- a85 gặp lại lúc auto_recalc UPDATE) phải là no-op, không phải 23505
      -- kéo sập cả transaction nghiệp vụ (án lệ BG2608001 07/08/2026).
      INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
      VALUES (NEW.organization_id, NEW.id, 'BRIDGE_UNRESOLVED_POSTER',
              jsonb_build_object('approved_by', NEW.approved_by, 'user_id', NEW.user_id))
      ON CONFLICT DO NOTHING;
      RETURN NEW;
    END IF;

    SELECT COALESCE(max(posting_generation), 0) + 1 INTO v_gen
    FROM public.income_expense_postings
    WHERE organization_id = NEW.organization_id AND posting_subject_kind = 'VOUCHER'
      AND posting_subject_id = NEW.id AND event_kind = 'POSTING';
    v_main := CASE WHEN NEW.type = 'INCOME' THEN NEW.total_amount ELSE -NEW.total_amount END;

    INSERT INTO public.income_expense_postings
      (organization_id, voucher_id, posting_subject_kind, posting_subject_id, direction,
       account_id, gross_amount, voucher_amount_snapshot, amount_basis, net_cash_effect,
       posted_on, posted_by_membership_id, posted_by_user_id, approval_version,
       event_kind, idempotency_key, source_kind, posting_generation)
    VALUES
      (NEW.organization_id, NEW.id, 'VOUCHER', NEW.id, NEW.type, NEW.account_id,
       NEW.total_amount, NEW.total_amount, 'VOUCHER_TOTAL',
       v_main + COALESCE(NEW.change_amount, 0) + COALESCE(NEW.rounding_amount, 0),
       COALESCE(NEW.voucher_date, public.org_today_v1(NULL)), v_membership, v_poster,
       COALESCE(NEW.approval_version, 1), 'POSTING',
       'bridge:gen:' || NEW.id::text || ':' || v_gen::text, 'LEGACY_BRIDGE', v_gen)
    ON CONFLICT (organization_id, idempotency_key) DO NOTHING
    RETURNING id INTO v_new;
    IF v_new IS NULL THEN
      SELECT id INTO v_new FROM public.income_expense_postings
      WHERE organization_id = NEW.organization_id
        AND idempotency_key = 'bridge:gen:' || NEW.id::text || ':' || v_gen::text;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.income_expense_posting_lines WHERE posting_id = v_new) THEN
      INSERT INTO public.income_expense_posting_lines (organization_id, posting_id, account_id, line_kind, signed_amount)
      VALUES (NEW.organization_id, v_new, NEW.account_id, 'MAIN', v_main);
      IF COALESCE(NEW.change_amount, 0) <> 0 AND NEW.change_account_id IS NOT NULL THEN
        INSERT INTO public.income_expense_posting_lines (organization_id, posting_id, account_id, line_kind, signed_amount)
        VALUES (NEW.organization_id, v_new, NEW.change_account_id, 'CHANGE', NEW.change_amount);
      END IF;
      IF COALESCE(NEW.rounding_amount, 0) <> 0 AND NEW.rounding_account_id IS NOT NULL THEN
        INSERT INTO public.income_expense_posting_lines (organization_id, posting_id, account_id, line_kind, signed_amount)
        VALUES (NEW.organization_id, v_new, NEW.rounding_account_id, 'ROUNDING', NEW.rounding_amount);
      END IF;
    END IF;
    NEW.active_posting_id_v2 := v_new;
    NEW.posting_mode := COALESCE(NEW.posting_mode, 'CASHBOOK');
    NEW.posting_status := 'POSTED';
  END IF;

  RETURN NEW;
END
$function$;

-- ── 4. Bridge a85b (AFTER INSERT): cùng một chốt ────────────────────────────
CREATE OR REPLACE FUNCTION app_private.finance_v2_auto_posting_bridge_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_acc public.accounts%ROWTYPE;
  v_poster uuid;
  v_membership uuid;
  v_gen bigint;
  v_main numeric(18,2);
  v_new uuid;
BEGIN
  -- Lifecycle V2 tự quản posting trong cùng txn → không đụng.
  IF EXISTS (SELECT 1 FROM app_private.ie_transition_authorization t
             WHERE t.income_expense_id = NEW.id AND t.xid = pg_current_xact_id()
               AND t.purpose = 'FINANCE_V2_LIFECYCLE') THEN
    RETURN NULL;
  END IF;
  IF app_private.evaluate_feature_route('income_expense.posting.v2', NEW.organization_id) <> 'CANONICAL' THEN
    RETURN NULL;
  END IF;
  IF NEW.deleted_at IS NOT NULL OR NEW.approval_status <> 'APPROVED'
     OR NEW.account_id IS NULL OR COALESCE(NEW.total_amount, 0) <= 0
     OR NEW.active_posting_id_v2 IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_acc FROM public.accounts WHERE id = NEW.account_id;
  IF NOT FOUND OR COALESCE(v_acc.is_virtual, false) OR v_acc.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  v_poster := COALESCE(NEW.approved_by, NEW.user_id, auth.uid());
  SELECT m.id INTO v_membership FROM public.organization_memberships m
  WHERE m.user_id = v_poster AND m.organization_id = NEW.organization_id AND m.status = 'ACTIVE' LIMIT 1;
  IF v_membership IS NULL THEN
    SELECT m.id, m.user_id INTO v_membership, v_poster FROM public.organization_memberships m
    WHERE m.user_id = auth.uid() AND m.organization_id = NEW.organization_id AND m.status = 'ACTIVE' LIMIT 1;
  END IF;
  IF v_membership IS NULL THEN
    -- Ghi-một-lần: xem chú thích cùng chỗ ở bridge a85 (án lệ BG2608001).
    INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
    VALUES (NEW.organization_id, NEW.id, 'BRIDGE_UNRESOLVED_POSTER',
            jsonb_build_object('approved_by', NEW.approved_by, 'user_id', NEW.user_id))
    ON CONFLICT DO NOTHING;
    RETURN NULL;
  END IF;

  SELECT COALESCE(max(posting_generation), 0) + 1 INTO v_gen
  FROM public.income_expense_postings
  WHERE organization_id = NEW.organization_id AND posting_subject_kind = 'VOUCHER'
    AND posting_subject_id = NEW.id AND event_kind = 'POSTING';
  v_main := CASE WHEN NEW.type = 'INCOME' THEN NEW.total_amount ELSE -NEW.total_amount END;

  INSERT INTO public.income_expense_postings
    (organization_id, voucher_id, posting_subject_kind, posting_subject_id, direction,
     account_id, gross_amount, voucher_amount_snapshot, amount_basis, net_cash_effect,
     posted_on, posted_by_membership_id, posted_by_user_id, approval_version,
     event_kind, idempotency_key, source_kind, posting_generation)
  VALUES
    (NEW.organization_id, NEW.id, 'VOUCHER', NEW.id, NEW.type, NEW.account_id,
     NEW.total_amount, NEW.total_amount, 'VOUCHER_TOTAL',
     v_main + COALESCE(NEW.change_amount, 0) + COALESCE(NEW.rounding_amount, 0),
     COALESCE(NEW.voucher_date, public.org_today_v1(NULL)), v_membership, v_poster,
     COALESCE(NEW.approval_version, 1), 'POSTING',
     'bridge:gen:' || NEW.id::text || ':' || v_gen::text, 'LEGACY_BRIDGE', v_gen)
  ON CONFLICT (organization_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_new;
  IF v_new IS NULL THEN
    RETURN NULL; -- idempotent replay
  END IF;
  INSERT INTO public.income_expense_posting_lines
    (organization_id, posting_id, account_id, line_kind, signed_amount)
  VALUES (NEW.organization_id, v_new, NEW.account_id, 'MAIN', v_main);
  IF COALESCE(NEW.change_amount, 0) <> 0 AND NEW.change_account_id IS NOT NULL THEN
    INSERT INTO public.income_expense_posting_lines
      (organization_id, posting_id, account_id, line_kind, signed_amount)
    VALUES (NEW.organization_id, v_new, NEW.change_account_id, 'CHANGE', NEW.change_amount);
  END IF;
  IF COALESCE(NEW.rounding_amount, 0) <> 0 AND NEW.rounding_account_id IS NOT NULL THEN
    INSERT INTO public.income_expense_posting_lines
      (organization_id, posting_id, account_id, line_kind, signed_amount)
    VALUES (NEW.organization_id, v_new, NEW.rounding_account_id, 'ROUNDING', NEW.rounding_amount);
  END IF;

  -- Token per-xid để (a) qua freeze-guard phiếu flow-owned, (b) a85 BEFORE
  -- UPDATE thấy token cùng xid → skip (không double-posting).
  INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  VALUES (NEW.id, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE');

  UPDATE public.income_expenses
     SET active_posting_id_v2 = v_new, posting_status = 'POSTED',
         posting_id = v_new, posted_at_v2 = now(), updated_at = now()
   WHERE id = NEW.id;
  RETURN NULL;
END
$function$;

-- ── 5. Verify: bản vá đủ, không nuốt logic nào ──────────────────────────────
DO $verify$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.proname = '_chung_building' AND p.pronamespace = 'public'::regnamespace;
  IF v_def NOT LIKE '%m.organization_id = b.organization_id%'
     OR v_def NOT LIKE '%ORDER BY b.created_at, b.id LIMIT 1%'
     OR v_def NOT LIKE '%demo_user_ids%'
     OR v_def NOT LIKE '%INSERT INTO buildings%' THEN
    RAISE EXCEPTION '_chung_building sau replace thiếu lọc org/tiebreaker/fallback — kiểm tra lại migration';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.proname = 'finance_v2_auto_posting_bridge' AND p.pronamespace = 'app_private'::regnamespace;
  IF v_def NOT LIKE '%ON CONFLICT DO NOTHING%'
     OR v_def NOT LIKE '%bridge:gen:%'
     OR v_def NOT LIKE '%TG_OP = ''UPDATE'' AND v_should%' THEN
    RAISE EXCEPTION 'bridge a85 sau replace thiếu chốt exception/idempotency — kiểm tra lại migration';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.proname = 'finance_v2_auto_posting_bridge_insert' AND p.pronamespace = 'app_private'::regnamespace;
  IF v_def NOT LIKE '%ON CONFLICT DO NOTHING%'
     OR v_def NOT LIKE '%bridge:gen:%'
     OR v_def NOT LIKE '%FINANCE_V2_LIFECYCLE%' THEN
    RAISE EXCEPTION 'bridge a85b sau replace thiếu chốt exception/idempotency — kiểm tra lại migration';
  END IF;
END
$verify$;

COMMIT;
