-- =====================================================================
-- Đợt 1 — CHUYỂN TOÀN BỘ `CURRENT_DATE` SANG `org_today_v1`
--
-- LỖI ĐANG SỬA: server chạy UTC, Việt Nam UTC+7. Trong 17:00–24:00 UTC, tức
-- **00:00–07:00 sáng giờ Việt Nam**, `CURRENT_DATE` trả về NGÀY HÔM QUA.
-- Bảy giờ mỗi ngày, đều đặn. Bug vô hình nếu chỉ thử vào giờ hành chính.
--
-- PHẠM VI: **78 chỗ trong 36 hàm** — toàn bộ, không chừa. Gồm cả những chỗ hậu
-- quả rõ ràng nhất:
--   • `generate_code` / `generate_next_code` / `auto_generate_voucher_code` /
--     `generate_template_code` — MÃ PHIẾU mang tháng. Tạo phiếu lúc 00:30 ngày 1
--     sẽ mang mã của THÁNG TRƯỚC.
--   • `mark_overdue_invoices_v1` — đánh dấu quá hạn sớm/muộn một ngày.
--   • `create_contract_v1`, `renew_contract_impl`, `create_new_contract_extension`,
--     `terminate_contract_*_impl` — mốc ngày hợp đồng.
--   • `cashbook_balance_as_of_v1`, `propose_cashbook_closing_v1`,
--     `cashbook_closing_*` — chốt sổ quỹ theo ngày.
--   • `recompute_invoice_for_id`, `generate_invoices_for_building` — hoá đơn.
--   • `pay_period_fee`, `pay_utility_bill` — phiếu chi phí cố định / điện nước.
--
-- CÁCH THAY: `CURRENT_DATE` → `public.org_today_v1(NULL)`.
--   Vì sao truyền NULL chứ không cố lấy biến org của từng hàm: `org_today_v1(NULL)`
--   tự suy org từ membership ACTIVE DUY NHẤT của người gọi, và rơi về mặc định
--   `Asia/Ho_Chi_Minh` nếu không suy được. TOÀN BỘ dữ liệu hiện tại là Việt Nam nên
--   hai đường cho CÙNG một kết quả — trong khi tự nối biến org ở 36 hàm là 36 cơ hội
--   nối nhầm. Khi nào có tổ chức ở múi giờ khác thì mới cần nối org tường minh, và
--   lúc đó phải rà lại đúng danh sách này.
--
-- Phép thay chạy bằng bộ quét có phân biệt comment / chuỗi / dollar-quote, nên
-- KHÔNG đụng chữ "CURRENT_DATE" nằm trong ghi chú hay chuỗi văn bản.
--
-- KHÔNG ĐỤNG TIỀN: chỉ CREATE OR REPLACE thân hàm. Không DML.
-- =====================================================================
BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.org_today_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu org_today_v1 — chạy 20260731061000 trước. DỪNG.';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname IN ('public','app_private') AND p.prokind='f'
         AND regexp_replace(p.prosrc,'--[^\n]*','','g') ~* 'current_date') = 0 THEN
    RAISE NOTICE 'Không còn hàm nào dùng CURRENT_DATE — đã chạy rồi.';
  END IF;
END
$preflight$;

-- app_private.cancel_collection_voucher_in_place_v1  (1 chỗ)
CREATE OR REPLACE FUNCTION app_private.cancel_collection_voucher_in_place_v1(p_voucher uuid, p_reason text, p_actor uuid, p_membership uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v public.income_expenses%ROWTYPE;
  v_active public.income_expense_postings%ROWTYPE;
  v_rev uuid;
  v_lines integer;
  v_sum numeric;
BEGIN
  SELECT * INTO v FROM public.income_expenses
   WHERE id = p_voucher AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu thu gốc % không tồn tại', p_voucher USING ERRCODE = 'P0002';
  END IF;
  IF v.approval_status = 'CANCELLED' THEN
    RETURN NULL;   -- đã huỷ ở vòng trước của cùng transaction
  END IF;

  -- Token: vừa qua được trigger đóng băng, vừa TẮT cầu a85 để nó không đảo
  -- chồng lên bút toán mà hàm này sắp tự viết.
  INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  VALUES (p_voucher, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
  ON CONFLICT (income_expense_id) DO UPDATE
    SET xid = excluded.xid, purpose = excluded.purpose, granted_at = now();

  IF COALESCE(v.posting_status, 'UNPOSTED') <> 'POSTED' THEN
    RAISE EXCEPTION
      'Phiếu thu % chưa ghi sổ (posting_status=%) — không huỷ tại chỗ được, báo quản trị.',
      p_voucher, COALESCE(v.posting_status, 'UNPOSTED') USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_active FROM public.income_expense_postings p
   WHERE p.id = v.active_posting_id_v2 FOR UPDATE;
  IF v_active.id IS NULL THEN
    -- Phiếu POSTED mà con trỏ rỗng là ca thật: nhánh BRIDGE_UNRESOLVED_POSTER
    -- của cầu a85 ghi dòng ngoại lệ rồi trả về mà không tạo posting.
    RAISE EXCEPTION
      'Phiếu thu % đã ghi sổ nhưng không tìm thấy bút toán gốc — báo quản trị trước khi huỷ.',
      p_voucher USING ERRCODE = '55000';
  END IF;
  IF v_active.event_kind <> 'POSTING' THEN
    RAISE EXCEPTION 'Bút toán đang trỏ tới không phải bút toán gốc' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.income_expense_postings
    (organization_id, voucher_id, posting_subject_kind, posting_subject_id, direction,
     account_id, gross_amount, voucher_amount_snapshot, amount_basis, net_cash_effect,
     posted_on, posted_by_membership_id, posted_by_user_id, approval_version,
     event_kind, idempotency_key, source_kind, posting_generation, reversal_of_id, reversal_reason)
  VALUES
    (v_active.organization_id, v_active.voucher_id, v_active.posting_subject_kind,
     v_active.posting_subject_id, v_active.direction, v_active.account_id,
     v_active.gross_amount, v_active.voucher_amount_snapshot, v_active.amount_basis,
     -v_active.net_cash_effect, public.org_today_v1(NULL),
     COALESCE(p_membership, v_active.posted_by_membership_id), p_actor,
     COALESCE(v.approval_version, 1), 'REVERSAL',
     'collinplace:' || v_active.id::text, 'MANUAL', v_active.posting_generation,
     v_active.id, p_reason)
  RETURNING id INTO v_rev;

  -- Soi gương TỪNG DÒNG. Phiếu thu có tiền thối mang hai dòng nằm ở HAI SỔ
  -- khác nhau (MAIN ở sổ thu, CHANGE ở sổ ảo "Thối"); dựng lại từ total_amount
  -- sẽ để sổ Thối lệch vĩnh viễn.
  INSERT INTO public.income_expense_posting_lines
    (organization_id, posting_id, account_id, line_kind, signed_amount)
  SELECT l.organization_id, v_rev, l.account_id, 'REVERSAL', -l.signed_amount
  FROM public.income_expense_posting_lines l
  WHERE l.posting_id = v_active.id;

  GET DIAGNOSTICS v_lines = ROW_COUNT;
  IF v_lines = 0 THEN
    RAISE EXCEPTION 'Bút toán gốc của phiếu % không có dòng nào — dừng lại', p_voucher
      USING ERRCODE = '55000';
  END IF;

  -- Hậu điều kiện: mọi bút toán của phiếu này phải triệt tiêu về 0.
  SELECT COALESCE(sum(l.signed_amount), 0) INTO v_sum
  FROM public.income_expense_posting_lines l
  JOIN public.income_expense_postings p ON p.id = l.posting_id
  WHERE p.posting_subject_kind = 'VOUCHER' AND p.posting_subject_id = p_voucher;
  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'Huỷ phiếu thu % nhưng bút toán không triệt tiêu (còn lệch %) — dừng lại',
      p_voucher, v_sum USING ERRCODE = '55000';
  END IF;

  -- CHỈ các cột nằm trong allowlist của guard đóng băng. Đụng cột ngoài
  -- allowlist là 55000 "authorized transition may only change lifecycle columns".
  UPDATE public.income_expenses SET
    approval_status        = 'CANCELLED',
    review_state           = 'RESOLVED',
    posting_status         = 'REVERSED',
    cancellation_kind      = 'CANCELLED_AFTER_POSTING',
    active_posting_id_v2   = NULL,
    reversed_by_posting_id = v_rev,
    approval_version       = COALESCE(approval_version, 1) + 1,
    posting_version        = COALESCE(posting_version, 1) + 1
  WHERE id = p_voucher;

  DELETE FROM app_private.ie_transition_authorization WHERE income_expense_id = p_voucher;

  INSERT INTO app_private.income_expense_cancellations
    (income_expense_id, organization_id, cancelled_by, cancel_reason, cancellation_kind,
     created_at_snap, approved_at_snap, amount_snap, cashbook_snap)
  VALUES
    (p_voucher, v.organization_id, p_actor, p_reason, 'CANCELLED_AFTER_POSTING',
     v.created_at, v.approved_at, v.total_amount, v.account_id)
  ON CONFLICT (income_expense_id) DO NOTHING;

  PERFORM app_private.append_income_expense_event_v1(
    v.organization_id, p_voucher, 'CANCELLED', p_actor, NULL,
    v.approval_status, 'CANCELLED', p_reason);

  RETURN v_rev;
END
$function$;

-- app_private.finance_v2_auto_posting_bridge  (2 chỗ)
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
      INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
      VALUES (NEW.organization_id, NEW.id, 'BRIDGE_UNRESOLVED_POSTER',
              jsonb_build_object('approved_by', NEW.approved_by, 'user_id', NEW.user_id));
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

-- app_private.finance_v2_auto_posting_bridge_insert  (1 chỗ)
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
    INSERT INTO app_private.income_expense_v2_backfill_exceptions (organization_id, voucher_id, reason_code, detail)
    VALUES (NEW.organization_id, NEW.id, 'BRIDGE_UNRESOLVED_POSTER',
            jsonb_build_object('approved_by', NEW.approved_by, 'user_id', NEW.user_id));
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

-- app_private.notify_closing_nudge_v1  (1 chỗ)
CREATE OR REPLACE FUNCTION app_private.notify_closing_nudge_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_book   record;
  v_ct     date;
  v_recv   text := 'người nhận';
  v_amount text;
  v_in_app boolean;
  v_push   boolean;
BEGIN
  -- SUY ORG, ĐỪNG TIN CỘT: cash_handovers.organization_id nullable, bảng KHÔNG
  -- có trg_autofill_org và create_cash_handover không gán (20260729161000:532-534).
  v_org := coalesce(NEW.organization_id,
                    (select a.organization_id from public.accounts a where a.id = NEW.from_account_id));
  IF v_org IS NULL OR NEW.giver_id IS NULL OR NEW.from_account_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT a.id, a.name, a.is_virtual, a.deleted_at
    INTO v_book
    FROM public.accounts a
   WHERE a.id = NEW.from_account_id;

  -- Sổ ảo (Thối/Làm tròn) không có két ⇒ propose_cashbook_closing_v1 từ chối
  -- thẳng (blocker VIRTUAL_CASHBOOK). Nhắc là dẫn người dùng vào tường.
  IF v_book.id IS NULL OR v_book.deleted_at IS NOT NULL OR COALESCE(v_book.is_virtual,false) THEN
    RETURN NULL;
  END IF;

  -- Đã chốt tới hôm nay rồi thì im. Chống ồn khi một ngày có nhiều phiên.
  v_ct := app_private.cashbook_closed_through_v1(NEW.from_account_id);
  IF v_ct IS NOT NULL AND v_ct >= public.org_today_v1(NULL) THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_recv := coalesce(nullif(NEW.receiver_name,''),
                       app_private.notif_actor_label_v1(NEW.receiver_id), 'người nhận');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify E6a: notif_actor_label_v1 lỗi (handover=%): % %', NEW.id, sqlstate, sqlerrm;
    v_recv := coalesce(nullif(NEW.receiver_name,''), 'người nhận');
  END;
  v_amount := replace(to_char(coalesce(NEW.total_amount,0),'FM999,999,999,999'), ',', '.');

  BEGIN
    SELECT g.g_in_app, g.g_push INTO v_in_app, v_push
      FROM app_private.notify_gate_v1(NEW.giver_id, v_org, 'E6a', NEW.total_amount) g;

    IF coalesce(v_in_app, true) THEN
      INSERT INTO public.notifications
        (user_id, organization_id, type, channel, status, subject, content, metadata, push_state)
      VALUES (NEW.giver_id, v_org, 'ACTION_REQUIRED', 'IN_APP', 'PENDING',
              'Đã bàn giao xong — chốt sổ ' || v_book.name || '?',
              v_recv || ' đã nhận ' || v_amount || ' đ (' || coalesce(NEW.code,'—')
                || '). Đếm số còn lại trong két và chốt sổ ' || v_book.name
                || ' để khoá kỳ, kẻo cuối tháng phải dò lại.',
              jsonb_build_object(
                'event','E6a',
                'handover_id', NEW.id::text,
                'cashbook_id', NEW.from_account_id::text,
                'amount', NEW.total_amount,
                'url','/finance/cashbooks?close=' || NEW.from_account_id::text,
                'actor_id', v_actor),
              case when coalesce(v_push,true) then 'QUEUED' else 'SKIPPED' end)
      ON CONFLICT (user_id, (metadata->>'handover_id'))
        WHERE (metadata->>'event') = 'E6a' and status is distinct from 'READ'
      DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify E6a: bỏ qua người nhận % (handover=%): % %',
      NEW.giver_id, NEW.id, sqlstate, sqlerrm;
  END;

  RETURN NULL;
END
$function$;

-- app_private.reserve_invoice_refund_obligation_v2  (2 chỗ)
CREATE OR REPLACE FUNCTION app_private.reserve_invoice_refund_obligation_v2(p_org uuid, p_invoice_id uuid, p_building_id uuid, p_amount numeric, p_refund_class text, p_system_source text, p_actor_user uuid, p_actor_membership uuid, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_inv public.invoices;
  v_refundable numeric(18,2);
  v_live numeric(18,2);
  v_voucher uuid := gen_random_uuid();
  v_birth_op uuid := gen_random_uuid();
  v_hash text := md5(jsonb_build_object('i', p_invoice_id, 'a', p_amount, 'c', p_refund_class, 'k', p_idempotency_key)::text);
  v_counts boolean;
  v_kqkd numeric(18,2);
  v_existing app_private.invoice_refund_reservations;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'reserve_invoice_refund_obligation_v2: amount must be positive' USING ERRCODE = '22023';
  END IF;
  IF p_refund_class NOT IN ('DEPOSIT','CUSTOMER_CREDIT','REFUND_CONTRA_REVENUE') THEN
    RAISE EXCEPTION 'reserve_invoice_refund_obligation_v2: invalid refund_class %', p_refund_class USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'reserve_invoice_refund_obligation_v2: idempotency key required' USING ERRCODE = '22023';
  END IF;

  -- Idempotent replay.
  SELECT * INTO v_existing FROM app_private.invoice_refund_reservations r
   WHERE r.organization_id = p_org AND r.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object('reservationId', v_existing.id, 'refundVoucherId', v_existing.refund_voucher_id,
                              'reservationState', v_existing.reservation_state, 'stateVersion', v_existing.state_version,
                              'replayed', true);
  END IF;

  -- Lock the invoice + refundable cap (paid_amount less already-live reservations).
  SELECT * INTO v_inv FROM public.invoices i WHERE i.id = p_invoice_id AND i.organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reserve_invoice_refund_obligation_v2: invoice % not found', p_invoice_id USING ERRCODE = 'P0002';
  END IF;
  v_refundable := COALESCE(v_inv.paid_amount, 0);

  SELECT COALESCE(sum(r.amount), 0) INTO v_live
  FROM app_private.invoice_refund_reservations r
  WHERE r.organization_id = p_org AND r.invoice_id = p_invoice_id
    AND r.reservation_state IN ('HELD','CONSUMED');

  IF v_live + p_amount > v_refundable THEN
    RAISE EXCEPTION 'reserve_invoice_refund_obligation_v2: refund % exceeds refundable due (live % + new % > paid %)',
      p_amount, v_live, p_amount, v_refundable USING ERRCODE = '55000';
  END IF;

  -- Classification: DEPOSIT/CUSTOMER_CREDIT = no P&L; contra-revenue = negative P&L (blocks close while pending).
  IF p_refund_class = 'REFUND_CONTRA_REVENUE' THEN
    v_counts := true;  v_kqkd := -p_amount;
  ELSE
    v_counts := false; v_kqkd := 0;
  END IF;

  -- Birth ONE pending obligation voucher (UNAPPROVED + UNPOSTED, no cashbook/posting/evidence at source).
  INSERT INTO public.income_expenses (
    id, user_id, type, name, building_id, invoice_id, voucher_date, total_amount,
    approval_status, organization_id, account_id, system_source,
    posting_mode, posting_status, review_state, review_version, approval_version, posting_version,
    maker_user_id, maker_membership_id, birth_operation_id, birth_txid, source_payload_hash,
    counts_in_business_result, kqkd_amount, recognition_date, recognition_source_mode, business_result_accounting
  ) VALUES (
    v_voucher, p_actor_user, 'EXPENSE', 'Hoàn tiền hóa đơn', p_building_id, p_invoice_id, public.org_today_v1(NULL), p_amount,
    'UNAPPROVED', p_org, NULL, COALESCE(p_system_source, 'invoice.refund'),
    'CASHBOOK', 'UNPOSTED', 'PENDING', 1, 1, 1,
    p_actor_user, p_actor_membership, v_birth_op, pg_current_xact_id(), v_hash,
    v_counts, v_kqkd, public.org_today_v1(NULL), 'BASE', v_counts
  );

  INSERT INTO app_private.income_expense_flow_ownership (
    income_expense_id, organization_id, flow_kind, flow_version, lifecycle_owner, lifecycle_state,
    writer_operation, payload_hash_scheme, payload_hash_value, maker_user_id, claimed_by_user_id, correlation_id
  ) VALUES (
    v_voucher, p_org, CASE WHEN COALESCE(p_system_source,'invoice.refund') = 'termination.refund'
                           THEN 'TERMINATION_REFUND' ELSE 'INVOICE_REFUND' END, 2,
    'INVOICE_REFUND', 'UNAPPROVED', 'invoice.refund.reserve.v2', 'PG_MD5_JSONB_TEXT_V1', v_hash, p_actor_user, p_actor_user,
    NULL /* 7ab: correlation uuid + hash scheme — idempotency TEXT đã unique ở invoice_refund_reservations (nhét vào cột uuid gây 42804); scheme 'md5' vi phạm CHECK chỉ nhận PG_MD5_JSONB_TEXT_V1 (23514) */
  );

  INSERT INTO app_private.invoice_refund_reservations (
    id, organization_id, invoice_id, refund_voucher_id, amount, refund_class, reservation_state,
    state_version, idempotency_key, source_payload_hash, created_by_user_id, created_at
  ) VALUES (
    gen_random_uuid(), p_org, p_invoice_id, v_voucher, p_amount, p_refund_class, 'HELD',
    1, p_idempotency_key, v_hash, p_actor_user, now()
  )
  RETURNING id INTO v_existing.id;

  RETURN jsonb_build_object('reservationId', v_existing.id, 'refundVoucherId', v_voucher,
                            'reservationState', 'HELD', 'stateVersion', 1, 'countsInBusinessResult', v_counts, 'replayed', false);
END
$function$;

-- public._ensure_initial_deposit_voucher  (1 chỗ)
CREATE OR REPLACE FUNCTION public._ensure_initial_deposit_voucher(p_contract_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_c RECORD; v_building uuid; v_account uuid; v_type uuid;
  v_amount numeric(15,2); v_date date; v_existing_acc uuid;
BEGIN
  SELECT * INTO v_c FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Đã có phiếu thu cọc? → dùng đúng sổ đang chứa cọc.
  SELECT ie.account_id INTO v_existing_acc
    FROM income_expenses ie
   WHERE ie.contract_id = p_contract_id AND ie.type = 'INCOME'
     AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
     AND public.ie_has_deposit_item(ie.id)
   ORDER BY ie.voucher_date LIMIT 1;
  IF v_existing_acc IS NOT NULL THEN RETURN v_existing_acc; END IF;

  v_amount := COALESCE(v_c.deposit_paid, 0);
  v_account := public._deposit_account(v_c.user_id);   -- sổ CỌC
  IF v_amount <= 0 OR v_c.room_id IS NULL THEN RETURN v_account; END IF;

  SELECT building_id INTO v_building FROM rooms WHERE id = v_c.room_id;
  IF v_building IS NULL THEN RETURN v_account; END IF;

  v_date := COALESCE(v_c.signed_date, v_c.start_date, public.org_today_v1(NULL));
  v_type := public._termination_ensure_type(v_c.user_id, 'income', 'Tiền cọc');
  UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type AND is_deposit IS DISTINCT FROM TRUE;

  INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes)
  VALUES (v_c.user_id, 'INCOME', 'Cọc giữ phòng (ghi nhận ban đầu) — HĐ ' || COALESCE(v_c.contract_number, p_contract_id::text),
          v_building, v_c.room_id, p_contract_id, v_account, v_date, v_amount, 'APPROVED',
          '[BACKFILL_INITIAL_DEPOSIT] Ghi nhận cọc ban đầu (giả định đã thu đủ) vào sổ CỌC.');
  -- item
  INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  SELECT ie.id, v_type, 'Tiền cọc giữ phòng (ghi nhận ban đầu)', 1, v_amount, v_date, v_date
    FROM income_expenses ie WHERE ie.contract_id = p_contract_id AND ie.account_id = v_account
      AND ie.notes LIKE '[BACKFILL_INITIAL_DEPOSIT]%' AND ie.deleted_at IS NULL
    ORDER BY ie.created_at DESC LIMIT 1;

  RETURN v_account;
END $function$;

-- public.approve_contract_termination_v1  (3 chỗ)
CREATE OR REPLACE FUNCTION public.approve_contract_termination_v1(p_termination_id uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_term public.contract_terminations%rowtype;
  v_contract public.contracts%rowtype;
  v_building uuid;
  v_refund numeric;
  v_type_id uuid;
  v_voucher_id uuid;
  v_voucher_kind text;
  v_type_names text[];
  v_desc text;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;

  select * into v_term from public.contract_terminations
   where id = p_termination_id for update;
  if not found then
    raise exception 'Không tìm thấy yêu cầu thanh lý hoặc bạn không có quyền' using errcode = '42501';
  end if;

  select * into v_contract from public.contracts
   where id = v_term.contract_id for update;
  if not found then
    raise exception 'Hợp đồng của yêu cầu thanh lý không còn tồn tại';
  end if;

  -- contracts KHÔNG có cột building_id — toà suy qua phòng (helper chuẩn RLS).
  v_building := public.building_of_contract(v_contract.id);
  if not (public.is_super_admin()
          or public.can_do_on_building('contracts', 'edit', v_building)) then
    raise exception 'Không có quyền duyệt thanh lý hợp đồng này' using errcode = '42501';
  end if;

  if v_term.status = 'COMPLETED' then
    return jsonb_build_object('termination_id', v_term.id, 'status', 'COMPLETED',
                              'voucher_id', null, 'noop', true);
  end if;

  select coalesce(nullif(btrim(full_name), ''), nullif(btrim(email), ''), 'Người dùng')
    into v_actor_name from public.profiles where id = v_actor;

  -- 1-3: chuỗi trạng thái (giữ nguyên thứ tự legacy, nay atomic trong 1 tx)
  update public.contract_terminations
     set status = 'APPROVED', approved_by = v_actor, approved_at = now()
   where id = v_term.id;

  update public.contracts
     set status = 'TERMINATED', updated_at = now()
   where id = v_contract.id;

  update public.contract_terminations
     set status = 'COMPLETED', refund_date = now()
   where id = v_term.id;

  -- 4: bút toán tiền (thay cash_book đã chết) — phiếu NHÁP chờ kế toán
  v_refund := coalesce(v_term.refund_amount, 0);
  if v_refund <> 0 then
    if v_refund > 0 then
      v_voucher_kind := 'EXPENSE';
      v_type_names := array['Hoàn cọc / tiền thừa khi thanh lý',
                            'Hoàn trả thanh lý',
                            'Hoàn cọc thanh lý',
                            'Hoàn tiền thừa thanh lý'];
      v_desc := 'Hoàn cọc thanh lý hợp đồng';
    else
      v_voucher_kind := 'INCOME';
      v_type_names := array['Thu thanh lý (khách trả thêm)',
                            'Doanh thu thanh lý'];
      v_desc := 'Thu thêm từ thanh lý hợp đồng';
    end if;

    -- Resolve hạng mục trong org theo thứ tự ưu tiên; trùng tên → bản cũ nhất.
    select t.id into v_type_id
      from public.income_expense_types t
     where t.organization_id = v_term.organization_id
       and lower(t.type) = lower(v_voucher_kind)
       and t.name = any (v_type_names)
     order by array_position(v_type_names, t.name), t.created_at
     limit 1;
    if v_type_id is null then
      raise exception 'Org chưa có hạng mục "%" cho bút toán thanh lý — tạo hạng mục rồi duyệt lại',
        v_type_names[1];
    end if;

    insert into public.income_expenses (
      user_id, creator_name, type, name,
      building_id, room_id, contract_id, account_id,
      payer_name, approval_status, voucher_date, attachments,
      notes, organization_id
    ) values (
      v_actor, coalesce(v_actor_name, 'Người dùng'), v_voucher_kind,
      v_desc || ' ' || coalesce(v_contract.contract_number, left(v_contract.id::text, 8)),
      v_building, v_contract.room_id, v_contract.id, null,
      null, 'UNAPPROVED', public.org_today_v1(NULL), '[]'::jsonb,
      nullif(btrim(coalesce(p_note, '')), ''), v_term.organization_id
    ) returning id into v_voucher_id;

    insert into public.income_expense_items (
      income_expense_id, income_expense_type_id, description,
      quantity, unit_price, start_date, end_date
    ) values (
      v_voucher_id, v_type_id,
      v_desc || ' (yêu cầu ' || left(v_term.id::text, 8) || ')',
      1, abs(v_refund), public.org_today_v1(NULL), public.org_today_v1(NULL)
    );
  end if;

  -- 5: trả phòng
  if v_contract.room_id is not null then
    update public.rooms set status = 'AVAILABLE' where id = v_contract.room_id;
  end if;

  return jsonb_build_object('termination_id', v_term.id, 'status', 'COMPLETED',
                            'voucher_id', v_voucher_id, 'room_id', v_contract.room_id);
end;
$function$;

-- public.auto_generate_voucher_code  (1 chỗ)
CREATE OR REPLACE FUNCTION public.auto_generate_voucher_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prefix TEXT;
  v_month TEXT;
  v_sequence INTEGER;
BEGIN
  IF NEW.code IS NOT NULL AND NEW.code != '' THEN
    RETURN NEW;
  END IF;

  IF NEW.type = 'INCOME' THEN
    v_prefix := 'PT';
  ELSE
    v_prefix := 'PC';
  END IF;

  v_month := TO_CHAR(public.org_today_v1(NULL), 'YYMM');

  PERFORM pg_advisory_xact_lock(hashtext(v_prefix || v_month || COALESCE(NEW.user_id::text, '')));

  SELECT COALESCE(MAX(
    CASE
      WHEN code ~ ('^' || v_prefix || '\d{4}\d+$')
        AND SUBSTRING(code FROM 3 FOR 4) = v_month
      THEN CAST(SUBSTRING(code FROM 7) AS INTEGER)
      ELSE 0
    END
  ), 0) + 1
  INTO v_sequence
  FROM income_expenses
  WHERE user_id = NEW.user_id
    AND type = NEW.type
    AND code LIKE v_prefix || v_month || '%';

  NEW.code := v_prefix || v_month || LPAD(v_sequence::TEXT, 3, '0');
  RETURN NEW;
END;
$function$;

-- public.calculate_lead_score  (2 chỗ)
CREATE OR REPLACE FUNCTION public.calculate_lead_score(lead_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  score INTEGER := 0;
  lead_record RECORD;
BEGIN
  SELECT * INTO lead_record FROM leads WHERE id = lead_id;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- Budget score (0-30 points)
  IF lead_record.budget_max IS NOT NULL THEN
    score := score + 30;
  ELSIF lead_record.budget_min IS NOT NULL THEN
    score := score + 15;
  END IF;

  -- Appointment date (0-25 points)
  IF lead_record.appointment_date IS NOT NULL THEN
    IF lead_record.appointment_date >= public.org_today_v1(NULL) THEN
      score := score + 25;
    ELSE
      score := score + 10;
    END IF;
  END IF;

  -- Source quality (0-20 points)
  CASE lead_record.source::text
    WHEN 'REFERRAL' THEN score := score + 20;
    WHEN 'WALK_IN' THEN score := score + 18;
    WHEN 'WEBSITE' THEN score := score + 15;
    WHEN 'FACEBOOK' THEN score := score + 12;
    WHEN 'ZALO' THEN score := score + 12;
    WHEN 'PHONE' THEN score := score + 10;
    ELSE score := score + 5;
  END CASE;

  -- Status progression (0-20 points)
  -- Using actual lead_status enum values: B1_LEAD, B2_APPOINTMENT, B3_CONSULTATION, CONVERTED, FAILED
  CASE lead_record.status::text
    WHEN 'CONVERTED' THEN score := score + 20;
    WHEN 'B3_CONSULTATION' THEN score := score + 15;
    WHEN 'B2_APPOINTMENT' THEN score := score + 10;
    WHEN 'B1_LEAD' THEN score := score + 5;
    WHEN 'FAILED' THEN score := score + 0;
    ELSE score := score + 0;
  END CASE;

  -- Email provided (0-5 points)
  IF lead_record.email IS NOT NULL THEN
    score := score + 5;
  END IF;

  -- Move-in date soon (0-5 points)
  IF lead_record.move_in_date IS NOT NULL AND lead_record.move_in_date <= public.org_today_v1(NULL) + INTERVAL '30 days' THEN
    score := score + 5;
  END IF;

  RETURN score;
END;
$function$;

-- public.cancel_income_expense_flex_v1  (1 chỗ)
CREATE OR REPLACE FUNCTION public.cancel_income_expense_flex_v1(p_voucher uuid, p_reason text, p_expected_approval_version bigint DEFAULT NULL::bigint, p_expected_posting_version bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v public.income_expenses%ROWTYPE;
  v_actor uuid := auth.uid();
  v_membership uuid;
  v_is_super boolean;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_active public.income_expense_postings%ROWTYPE;
  v_rev uuid;
  v_sum numeric;
  v_kind text;
  v_next_posting text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  IF char_length(v_reason) < 8 THEN
    RAISE EXCEPTION 'Phải ghi lý do huỷ (ít nhất 8 ký tự) để còn đối soát về sau.'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v FROM public.income_expenses WHERE id = p_voucher AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002'; END IF;

  -- Kiểm THÀNH VIÊN ngay sau khi tìm thấy phiếu: mọi thông điệp phía dưới
  -- (đã huỷ chưa, system_source gì, tên sổ quỹ, ngày chốt) đều là thông tin
  -- của tổ chức sở hữu phiếu — người ngoài không được nghe.
  IF NOT public.is_super_admin() AND NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m0
     WHERE m0.user_id = v_actor AND m0.organization_id = v.organization_id
       AND m0.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
  END IF;

  IF v.approval_status = 'CANCELLED' THEN
    RETURN jsonb_build_object('id', p_voucher, 'changed', false, 'reason', 'đã huỷ trước đó');
  END IF;

  IF NOT app_private.ie_flex_mode_enabled_v1(v.organization_id) THEN
    RAISE EXCEPTION '[STRICT_MODE] Tổ chức đang bật Chuẩn kế toán — dùng đường Hoàn tác rồi Huỷ như cũ.'
      USING ERRCODE = '55000';
  END IF;

  PERFORM app_private.assert_manual_voucher_v1(p_voucher, 'huỷ');
  PERFORM app_private.assert_period_open_for_edit_v1(p_voucher, 'huỷ');

  v_is_super := public.is_super_admin();
  SELECT m.id INTO v_membership FROM public.organization_memberships m
   WHERE m.user_id = v_actor AND m.organization_id = v.organization_id AND m.status = 'ACTIVE' LIMIT 1;
  IF v_membership IS NULL AND NOT v_is_super THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
  END IF;

  -- Quyền: huỷ thu chi trên toà + đang GIỮ đúng sổ. Chủ tổ chức / super admin
  -- được vào thẳng (quyết định #4). Chế độ linh hoạt nới TRẠNG THÁI, không nới
  -- quyền: income_expenses.cancel vẫn là điều kiện như đường cũ.
  -- Người TẠO phiếu được huỷ phiếu của chính mình (yêu cầu của chủ 29/07).
  IF NOT v_is_super AND NOT app_private.is_org_owner_v1(v.organization_id, v_actor)
     AND v.user_id IS DISTINCT FROM v_actor THEN
    DECLARE v_allowed boolean;
    BEGIN
      SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(
        v_actor, v.organization_id, 'income_expenses.cancel', v.building_id, v.account_id);
      IF NOT COALESCE(v_allowed, false) THEN
        RAISE EXCEPTION 'Không có quyền huỷ phiếu thu chi trên toà này' USING ERRCODE = '42501';
      END IF;
      IF v.account_id IS NOT NULL THEN
        PERFORM app_private.assert_cashbook_access_v2(
          v.organization_id, v.account_id, 'CUSTODIAN', v_membership);
      END IF;
    END;
  END IF;

  IF COALESCE(v.has_restricted_item, false)
     AND v.user_id IS DISTINCT FROM v_actor
     AND NOT public.can_view_restricted_ie() AND NOT v_is_super THEN
    RAISE EXCEPTION 'Phiếu chứa hạng mục hạn chế — không có quyền huỷ' USING ERRCODE = '42501';
  END IF;

  IF p_expected_approval_version IS NOT NULL
     AND COALESCE(v.approval_version, 1) <> p_expected_approval_version THEN
    RAISE EXCEPTION 'Phiếu vừa được người khác thay đổi — hãy tải lại' USING ERRCODE = '40001';
  END IF;
  IF p_expected_posting_version IS NOT NULL
     AND COALESCE(v.posting_version, 1) <> p_expected_posting_version THEN
    RAISE EXCEPTION 'Phiếu vừa được người khác ghi sổ — hãy tải lại' USING ERRCODE = '40001';
  END IF;

  -- Token: vừa qua được trigger đóng băng, vừa TẮT cầu a85 để nó không đảo
  -- chồng lên bút toán mà hàm này sắp tự viết.
  INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  VALUES (p_voucher, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
  ON CONFLICT (income_expense_id) DO UPDATE
    SET xid = excluded.xid, purpose = excluded.purpose, granted_at = now();

  v_kind := 'CANCELLED_UNPOSTED';
  v_next_posting := CASE WHEN v.posting_mode = 'NON_CASH' THEN 'NOT_APPLICABLE' ELSE 'UNPOSTED' END;

  IF COALESCE(v.posting_status, 'UNPOSTED') = 'POSTED' THEN
    SELECT * INTO v_active FROM public.income_expense_postings p
     WHERE p.id = v.active_posting_id_v2 FOR UPDATE;

    IF v_active.id IS NULL THEN
      -- Phiếu POSTED mà con trỏ rỗng là ca thật: nhánh BRIDGE_UNRESOLVED_POSTER
      -- của cầu a85 ghi dòng ngoại lệ rồi trả về mà không tạo posting.
      RAISE EXCEPTION 'Phiếu ghi nhận đã ghi sổ nhưng không tìm thấy bút toán gốc — báo quản trị trước khi huỷ.'
        USING ERRCODE = '55000';
    END IF;
    IF v_active.event_kind <> 'POSTING' THEN
      RAISE EXCEPTION 'Bút toán đang trỏ tới không phải bút toán gốc' USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.income_expense_postings
      (organization_id, voucher_id, posting_subject_kind, posting_subject_id, direction,
       account_id, gross_amount, voucher_amount_snapshot, amount_basis, net_cash_effect,
       posted_on, posted_by_membership_id, posted_by_user_id, approval_version,
       event_kind, idempotency_key, source_kind, posting_generation, reversal_of_id, reversal_reason)
    VALUES
      (v_active.organization_id, v_active.voucher_id, v_active.posting_subject_kind,
       v_active.posting_subject_id, v_active.direction, v_active.account_id,
       v_active.gross_amount, v_active.voucher_amount_snapshot, v_active.amount_basis,
       -v_active.net_cash_effect, public.org_today_v1(NULL),
       COALESCE(v_membership, v_active.posted_by_membership_id), v_actor,
       COALESCE(v.approval_version, 1), 'REVERSAL',
       'flexcancel:' || v_active.id::text, 'MANUAL', v_active.posting_generation,
       v_active.id, v_reason)
    RETURNING id INTO v_rev;

    INSERT INTO public.income_expense_posting_lines
      (organization_id, posting_id, account_id, line_kind, signed_amount)
    SELECT l.organization_id, v_rev, l.account_id, 'REVERSAL', -l.signed_amount
    FROM public.income_expense_posting_lines l
    WHERE l.posting_id = v_active.id;

    -- Hậu điều kiện: mọi bút toán của phiếu này phải triệt tiêu về 0.
    SELECT COALESCE(sum(l.signed_amount), 0) INTO v_sum
    FROM public.income_expense_posting_lines l
    JOIN public.income_expense_postings p ON p.id = l.posting_id
    WHERE p.posting_subject_kind = 'VOUCHER' AND p.posting_subject_id = p_voucher;
    IF v_sum <> 0 THEN
      RAISE EXCEPTION 'Huỷ phiếu nhưng bút toán không triệt tiêu (còn lệch %) — dừng lại', v_sum
        USING ERRCODE = '55000';
    END IF;

    v_kind := 'CANCELLED_AFTER_POSTING';
    v_next_posting := 'REVERSED';
  END IF;

  UPDATE public.income_expenses SET
    approval_status = 'CANCELLED',
    review_state = 'RESOLVED',
    posting_status = v_next_posting,
    cancellation_kind = v_kind,
    active_posting_id_v2 = CASE WHEN v_rev IS NOT NULL THEN NULL ELSE active_posting_id_v2 END,
    reversed_by_posting_id = COALESCE(v_rev, reversed_by_posting_id),
    approval_version = COALESCE(approval_version, 1) + 1,
    posting_version = COALESCE(posting_version, 1) + CASE WHEN v_rev IS NOT NULL THEN 1 ELSE 0 END
  WHERE id = p_voucher;

  DELETE FROM app_private.ie_transition_authorization WHERE income_expense_id = p_voucher;

  INSERT INTO app_private.income_expense_cancellations
    (income_expense_id, organization_id, cancelled_by, cancel_reason, cancellation_kind,
     created_at_snap, approved_at_snap, amount_snap, cashbook_snap)
  VALUES
    (p_voucher, v.organization_id, v_actor, v_reason, v_kind,
     v.created_at, v.approved_at, v.total_amount, v.account_id)
  ON CONFLICT (income_expense_id) DO NOTHING;

  PERFORM app_private.append_income_expense_event_v1(
    v.organization_id, p_voucher, 'CANCELLED', v_actor, NULL,
    v.approval_status, 'CANCELLED', v_reason);

  RETURN jsonb_build_object(
    'id', p_voucher, 'changed', true,
    'cancellation_kind', v_kind,
    'reversal_posting_id', v_rev
  );
END
$function$;

-- public.cashbook_balance_as_of_v1  (2 chỗ)
CREATE OR REPLACE FUNCTION public.cashbook_balance_as_of_v1(p_cashbook uuid, p_as_of date DEFAULT NULL::date)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_org uuid;
  v_membership uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT a.organization_id INTO v_org FROM public.accounts a WHERE a.id = p_cashbook;
  IF v_org IS NULL THEN RETURN NULL; END IF;

  IF public.is_super_admin() THEN
    RETURN app_private.cashbook_balance_as_of_v1(p_cashbook, COALESCE(p_as_of, public.org_today_v1(NULL)));
  END IF;

  SELECT m.id INTO v_membership FROM public.organization_memberships m
   WHERE m.user_id = auth.uid() AND m.organization_id = v_org AND m.status = 'ACTIVE'
   LIMIT 1;
  IF v_membership IS NULL THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của sổ quỹ' USING ERRCODE = '42501';
  END IF;

  -- Doctrine lỗ hổng C (Đợt 0): hàm tổng hợp SECURITY DEFINER phải tự giới hạn
  -- phạm vi nhìn. Dùng ĐÚNG helper mà Đợt 0 đã lập cho việc này —
  -- assert_cashbook_access_v2(...,'KNOWER',...) KHÔNG dùng được ở đây vì nó so
  -- possession_kind CHÍNH XÁC, nên người đang GIỮ sổ (CUSTODIAN) lại trượt.
  IF NOT EXISTS (SELECT 1 FROM app_private.ie_visible_cashbook_ids_v1() v
                  WHERE v.cashbook_id = p_cashbook) THEN
    RAISE EXCEPTION 'Không có quyền xem sổ quỹ này' USING ERRCODE = '42501';
  END IF;
  RETURN app_private.cashbook_balance_as_of_v1(p_cashbook, COALESCE(p_as_of, public.org_today_v1(NULL)));
END
$function$;

-- public.cashbook_closing_blockers_v1  (1 chỗ)
CREATE OR REPLACE FUNCTION public.cashbook_closing_blockers_v1(p_cashbook uuid)
 RETURNS TABLE(code text, blocking boolean, detail text, count_n integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_org uuid;
  v_is_virtual boolean;
  v_closed date;
  v_n integer;
  v_today date := public.org_today_v1(NULL);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;

  SELECT a.organization_id, COALESCE(a.is_virtual, false)
    INTO v_org, v_is_virtual
  FROM public.accounts a WHERE a.id = p_cashbook AND a.deleted_at IS NULL;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy sổ quỹ' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_super_admin() AND NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
     WHERE m.user_id = auth.uid() AND m.organization_id = v_org AND m.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của sổ quỹ' USING ERRCODE = '42501';
  END IF;

  IF v_is_virtual THEN
    code := 'VIRTUAL_CASHBOOK'; blocking := true; count_n := 0;
    detail := 'Sổ ảo (Thối / Làm tròn) không đếm tiền mặt được nên không chốt riêng. Nó đóng theo sổ mẹ.';
    RETURN NEXT;
  END IF;

  v_closed := app_private.cashbook_closed_through_v1(p_cashbook);
  IF v_closed IS NOT NULL AND v_closed >= v_today THEN
    code := 'ALREADY_CLOSED'; blocking := true; count_n := 0;
    detail := format('Sổ đã chốt tới %s — không chốt lại cùng ngày.', to_char(v_closed, 'DD/MM/YYYY'));
    RETURN NEXT;
  END IF;

  IF EXISTS (SELECT 1 FROM app_private.cashbook_closure_requests r
              WHERE r.cashbook_id = p_cashbook AND r.status = 'PENDING') THEN
    code := 'CLOSURE_PENDING'; blocking := true; count_n := 1;
    detail := 'Sổ này đã có một đề nghị chốt đang chờ xác nhận. Huỷ đề nghị cũ trước.';
    RETURN NEXT;
  END IF;

  -- Phiếu chờ duyệt: duyệt sau khi đã chốt số là đẻ posting NẰM TRONG kỳ vừa
  -- đóng băng ⇒ số đã ký sai. Phải dọn trước.
  SELECT count(*) INTO v_n FROM public.income_expenses ie
   WHERE ie.account_id = p_cashbook AND ie.deleted_at IS NULL
     AND ie.approval_status = 'UNAPPROVED' AND ie.voucher_date <= v_today;
  IF v_n > 0 THEN
    code := 'PENDING_APPROVAL'; blocking := true; count_n := v_n;
    detail := format('%s phiếu còn Chờ duyệt trong kỳ. Duyệt hoặc huỷ hết trước khi chốt.', v_n);
    RETURN NEXT;
  END IF;

  SELECT count(*) INTO v_n FROM public.income_expenses ie
   WHERE ie.account_id = p_cashbook AND ie.deleted_at IS NULL
     AND ie.approval_status = 'APPROVED'
     AND COALESCE(ie.posting_status, 'UNPOSTED') = 'UNPOSTED'
     AND ie.voucher_date <= v_today;
  IF v_n > 0 THEN
    code := 'APPROVED_NOT_POSTED'; blocking := true; count_n := v_n;
    detail := format('%s phiếu đã duyệt nhưng chưa ghi sổ. Ghi sổ hết thì số dư mới đúng.', v_n);
    RETURN NEXT;
  END IF;

  -- Phiên bàn giao tiền mặt PENDING: confirm_cash_handover chèn phiếu vào sổ,
  -- chốt trước là phiên đó kẹt.
  SELECT count(*) INTO v_n FROM public.cash_handovers h
   WHERE (h.from_account_id = p_cashbook OR h.to_account_id = p_cashbook)
     AND h.status = 'PENDING';
  IF v_n > 0 THEN
    code := 'HANDOVER_PENDING'; blocking := true; count_n := v_n;
    detail := format('%s phiên bàn giao tiền mặt đang chờ. Xác nhận hoặc huỷ hết trước khi chốt, nếu không chúng sẽ kẹt.', v_n);
    RETURN NEXT;
  END IF;

  -- CẢNH BÁO, không chặn: phiên CONFIRMED có phiếu gốc trong kỳ sắp khoá sẽ
  -- không huỷ được nữa (confirm_cancel_handover gỡ handover_id trên phiếu gốc,
  -- mà phiếu đó rơi vào kỳ đã đóng).
  SELECT count(DISTINCT h.id) INTO v_n
  FROM public.cash_handovers h
  JOIN public.income_expenses ie ON ie.handover_id = h.id
  WHERE h.status = 'CONFIRMED'
    AND (h.from_account_id = p_cashbook OR h.to_account_id = p_cashbook)
    AND ie.voucher_date <= v_today;
  IF v_n > 0 THEN
    code := 'HANDOVER_BECOMES_FINAL'; blocking := false; count_n := v_n;
    detail := format('%s phiên bàn giao đã xác nhận sẽ KHÔNG huỷ được nữa sau khi chốt.', v_n);
    RETURN NEXT;
  END IF;

  -- CẢNH BÁO: phiếu chưa có ảnh chứng từ. Sau khi chốt vẫn bổ sung ảnh được
  -- (quyết định #8) nên chỉ nhắc.
  SELECT count(*) INTO v_n FROM public.income_expenses ie
   WHERE ie.account_id = p_cashbook AND ie.deleted_at IS NULL
     AND ie.approval_status = 'APPROVED' AND ie.voucher_date <= v_today
     AND (ie.attachments IS NULL OR jsonb_array_length(COALESCE(ie.attachments, '[]'::jsonb)) = 0);
  IF v_n > 0 THEN
    code := 'MISSING_ATTACHMENTS'; blocking := false; count_n := v_n;
    detail := format('%s phiếu chưa có ảnh chứng từ. Sau khi chốt vẫn bổ sung được, nhưng nên chụp trước.', v_n);
    RETURN NEXT;
  END IF;

  -- Không ai đủ quyền xác nhận thì đề nghị sẽ treo vĩnh viễn — nói trước.
  SELECT count(*) INTO v_n
  FROM public.organization_memberships m
  WHERE m.organization_id = v_org AND m.status = 'ACTIVE' AND m.user_id <> auth.uid()
    AND COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
          m.user_id, v_org, 'cashbooks.close_confirm', NULL, p_cashbook)), false);
  IF v_n = 0 THEN
    code := 'NO_CONFIRMER'; blocking := true; count_n := 0;
    detail := 'Chưa có ai khác đủ quyền XÁC NHẬN nhận bàn giao sổ này. Nhờ quản trị cấp quyền "Xác nhận nhận bàn giao" cho người nhận trước.';
    RETURN NEXT;
  END IF;
END
$function$;

-- public.cashbook_closing_monthly_status_v1  (1 chỗ)
CREATE OR REPLACE FUNCTION public.cashbook_closing_monthly_status_v1(p_organization_id uuid, p_month date)
 RETURNS TABLE(cashbook_id uuid, cashbook_name text, bank_name text, is_bank boolean, closed_through date, covered boolean, has_pending_request boolean, activity_count bigint, balance_at_month_end numeric, needs_closing boolean, can_be_closed boolean, confirmer_count integer, i_can_propose boolean, i_can_confirm boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_month     date;
  v_month_end date;
BEGIN
  IF v_uid IS NULL OR p_organization_id IS NULL THEN
    RETURN;
  END IF;

  -- my_org_ids() suy từ MEMBERSHIP, không đọc profiles.organization_id
  -- (6/10 profile trên prod trỏ SAI org).
  IF NOT (p_organization_id = ANY (public.my_org_ids())) THEN
    RETURN;
  END IF;

  v_month     := date_trunc('month', COALESCE(p_month, public.org_today_v1(NULL)))::date;
  v_month_end := (v_month + interval '1 month' - interval '1 day')::date;

  RETURN QUERY
  WITH visible AS (
    SELECT v.cashbook_id AS id FROM app_private.ie_visible_cashbook_ids_v1() v
  ), books AS (
    SELECT a.id, a.name, a.bank_name
    FROM public.accounts a
    JOIN visible vi ON vi.id = a.id
    WHERE a.organization_id = p_organization_id
      AND a.deleted_at IS NULL
      AND NOT COALESCE(a.is_virtual, false)   -- sổ ảo (Thối/Làm tròn) không có két
  ), grid AS (
    -- Một lượt quét (sổ × thành viên ACTIVE), hỏi cả hai khoá. Dùng lại cho cả
    -- phép đếm của hệ thống lẫn phép hỏi của người đang xem.
    SELECT
      b.id AS book_id,
      m.user_id,
      COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
        m.user_id, p_organization_id, 'cashbooks.close', NULL, b.id)), false) AS p_ok,
      COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
        m.user_id, p_organization_id, 'cashbooks.close_confirm', NULL, b.id)), false) AS c_ok
    FROM books b
    CROSS JOIN public.organization_memberships m
    WHERE m.organization_id = p_organization_id AND m.status = 'ACTIVE'
  ), two_party AS (
    SELECT
      g.book_id,
      count(*) FILTER (WHERE g.p_ok)                                  AS n_prop,
      count(*) FILTER (WHERE g.c_ok)                                  AS n_conf,
      count(*) FILTER (WHERE g.p_ok AND g.c_ok)                       AS n_both,
      -- có người KHÁC TÔI ký được / đề nghị được
      bool_or(g.c_ok AND g.user_id IS DISTINCT FROM v_uid)            AS other_conf,
      bool_or(g.p_ok AND g.user_id IS DISTINCT FROM v_uid)            AS other_prop,
      bool_or(g.p_ok AND g.user_id = v_uid)                           AS me_prop,
      bool_or(g.c_ok AND g.user_id = v_uid)                           AS me_conf
    FROM grid g
    GROUP BY g.book_id
  ), custody AS (
    -- Đang giữ sổ = điều kiện propose_cashbook_closing_v1 kiểm bằng
    -- assert_cashbook_access_v2(..., 'CUSTODIAN', ...). Hàm đó RAISE nên không
    -- gọi trực tiếp trong truy vấn được; soi thẳng binding (đủ cho gợi ý UI).
    SELECT DISTINCT pb.cashbook_id AS book_id
    FROM public.cashbook_possession_bindings pb
    JOIN public.organization_memberships m
      ON m.id = pb.membership_id AND m.status = 'ACTIVE' AND m.user_id = v_uid
    WHERE pb.organization_id = p_organization_id
      AND pb.possession_kind = 'CUSTODIAN'
      AND pb.valid_from <= now()
      AND (pb.valid_to IS NULL OR pb.valid_to > now())
  ), enriched AS (
    SELECT
      b.id, b.name, b.bank_name,
      app_private.cashbook_closed_through_v1(b.id) AS ct,
      EXISTS (
        SELECT 1 FROM app_private.cashbook_closure_requests r
        WHERE r.cashbook_id = b.id AND r.status = 'PENDING'
      ) AS pending,
      -- Phát sinh trong tháng: đếm theo DÒNG bút toán, không theo phiếu — tồn
      -- quỹ cộng theo account của DÒNG, mà dòng Thối/Làm tròn rơi vào sổ khác.
      (
        SELECT count(*)
        FROM public.income_expense_posting_lines l
        JOIN public.income_expense_postings p ON p.id = l.posting_id
        WHERE l.account_id = b.id
          AND l.organization_id = p_organization_id
          AND p.event_kind IN ('POSTING', 'REVERSAL')
          AND p.posted_on BETWEEN v_month AND v_month_end
      ) AS act,
      app_private.cashbook_balance_as_of_v1(b.id, v_month_end) AS bal,
      COALESCE(tp.n_prop, 0)      AS n_prop,
      COALESCE(tp.n_conf, 0)      AS n_conf,
      COALESCE(tp.n_both, 0)      AS n_both,
      COALESCE(tp.me_prop, false) AS me_prop,
      COALESCE(tp.me_conf, false) AS me_conf,
      COALESCE(tp.other_prop, false) AS other_prop,
      COALESCE(tp.other_conf, false) AS other_conf,
      EXISTS (SELECT 1 FROM custody c WHERE c.book_id = b.id) AS mine_to_hold
    FROM books b
    LEFT JOIN two_party tp ON tp.book_id = b.id
  )
  SELECT
    e.id,
    e.name,
    e.bank_name,
    (e.bank_name IS NOT NULL)                        AS is_bank,
    e.ct,
    (e.ct IS NOT NULL AND e.ct >= v_month_end)       AS covered,
    e.pending,
    e.act,
    e.bal,
    -- Sổ "phải chốt" tháng này: có phát sinh HOẶC còn dư cuối tháng. Sổ chết
    -- (0 phát sinh, dư 0) thì nhắc là ồn vô ích.
    (e.act > 0 OR COALESCE(e.bal, 0) <> 0)           AS needs_closing,
    -- Câu hỏi của HỆ THỐNG: có tồn tại cặp hai người khác nhau?
    (e.n_prop >= 1 AND e.n_conf >= 1
       AND NOT (e.n_prop = 1 AND e.n_conf = 1 AND e.n_both = 1)) AS can_be_closed,
    e.n_conf::int                                    AS confirmer_count,
    -- Câu hỏi của TÔI: tôi giữ sổ, tôi đề nghị được, và có người KHÁC ký được.
    (e.mine_to_hold AND e.me_prop AND e.other_conf)  AS i_can_propose,
    (e.me_conf AND e.other_prop)                     AS i_can_confirm
  FROM enriched e
  ORDER BY (e.ct IS NOT NULL AND e.ct >= v_month_end), e.name;
END
$function$;

-- public.confirm_cash_handover  (2 chỗ)
CREATE OR REPLACE FUNCTION public.confirm_cash_handover(p_handover_id uuid, p_to_account_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_h         cash_handovers%ROWTYPE;
  v_to        uuid;
  v_net       numeric;
  v_cnt       int;
  v_type_exp  uuid;
  v_type_inc  uuid;
  v_bld_giver uuid;
  v_bld_recv  uuid;
  v_caller    text;
  v_recv      text;
  v_giver     text;
  v_exp       uuid;
  v_inc       uuid;
  v_lines_in  text;
  v_lines_ex  text;
  v_lines     text;
  v_item_desc text;
  v_handover_date date;   -- Đợt 6: ngày MỞ đầu tiên chung cho cả hai chân
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_h FROM cash_handovers WHERE id = p_handover_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiên bàn giao'; END IF;
  IF v_h.receiver_id <> auth.uid() THEN
    RAISE EXCEPTION 'Chỉ người nhận mới được xác nhận đã nhận tiền';
  END IF;
  IF v_h.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Phiên % không ở trạng thái chờ nhận', v_h.code;
  END IF;
  IF v_h.cancel_requested_by IS NOT NULL THEN
    RAISE EXCEPTION 'Phiên % đang có yêu cầu hủy — xử lý yêu cầu hủy trước', v_h.code;
  END IF;

  -- Sổ đích: truyền vào (phải của receiver) hoặc fallback sổ "…Thu" của receiver
  IF p_to_account_id IS NOT NULL THEN
    SELECT id INTO v_to FROM accounts
     WHERE id = p_to_account_id AND user_id = auth.uid() AND deleted_at IS NULL;
    IF v_to IS NULL THEN
      RAISE EXCEPTION 'Sổ nhận không hợp lệ (phải là sổ quỹ do bạn sở hữu)';
    END IF;
  ELSE
    SELECT id INTO v_to FROM accounts
     WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'
     ORDER BY is_default DESC NULLS LAST, name LIMIT 1;
    IF v_to IS NULL THEN
      RAISE EXCEPTION 'Bạn chưa có sổ quỹ nhận — hãy chọn sổ khi xác nhận';
    END IF;
  END IF;

  -- Re-validate: danh sách phiếu còn nguyên, NET (Σthu − Σchi) khớp snapshot
  SELECT COALESCE(sum(CASE WHEN ie.type = 'INCOME' THEN ie.total_amount
                           ELSE -ie.total_amount END), 0),
         count(*)
    INTO v_net, v_cnt
    FROM cash_handover_items it
    JOIN income_expenses ie ON ie.id = it.voucher_id
   WHERE it.handover_id = p_handover_id
     AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
     AND ie.handover_id = p_handover_id
     AND ie.account_id = v_h.from_account_id;
  IF v_cnt <> v_h.voucher_count OR v_net <> v_h.total_amount THEN
    RAISE EXCEPTION 'Danh sách phiếu của phiên % đã thay đổi — hãy hủy phiên và tạo lại', v_h.code;
  END IF;

  -- Loại thu/chi "bàn giao" (ngoài KQKD) + tòa ảo Chung
  v_type_exp := public._termination_ensure_type(v_h.giver_id, 'expense', 'Bàn giao tiền mặt');
  UPDATE income_expense_types SET is_deposit = FALSE
   WHERE id = v_type_exp AND is_deposit IS DISTINCT FROM FALSE;
  v_type_inc := public._termination_ensure_type(v_h.receiver_id, 'income', 'Nhận bàn giao tiền mặt');
  UPDATE income_expense_types SET is_deposit = FALSE
   WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;
  v_bld_giver := public._chung_building(v_h.giver_id);
  v_bld_recv  := public._chung_building(v_h.receiver_id);

  SELECT COALESCE(full_name, '') INTO v_caller FROM profiles WHERE id = auth.uid();
  v_recv  := COALESCE(v_h.receiver_name, '');
  v_giver := COALESCE(v_h.giver_name, '');

  -- ── Nhóm THU: phòng · tòa · tiền · kỳ · HĐ ──
  SELECT string_agg(
           '• ' || COALESCE(NULLIF(btrim(it.room_name), ''), '?')
                || ' · ' || COALESCE(NULLIF(btrim(it.building_name), ''), '?')
                || ' · ' || replace(to_char(it.amount::bigint, 'FM999,999,999'), ',', '.') || 'đ'
                || COALESCE(' · kỳ ' || to_char(to_date(inv.billing_month, 'YYYY-MM'), 'MM/YYYY'), '')
                || COALESCE(' · HĐ ' || NULLIF(btrim(inv.invoice_number), ''), ''),
           E'\n' ORDER BY it.building_name, it.room_name)
    INTO v_lines_in
    FROM cash_handover_items it
    LEFT JOIN income_expenses ie ON ie.id = it.voucher_id
    LEFT JOIN invoices inv ON inv.id = ie.invoice_id
   WHERE it.handover_id = p_handover_id AND it.voucher_type = 'INCOME';

  -- ── Nhóm CHI: tên khoản · tiền ──
  SELECT string_agg(
           '• ' || COALESCE(NULLIF(btrim(ie.name), ''), 'Khoản chi')
                || ' · ' || replace(to_char(it.amount::bigint, 'FM999,999,999'), ',', '.') || 'đ',
           E'\n' ORDER BY it.amount DESC)
    INTO v_lines_ex
    FROM cash_handover_items it
    LEFT JOIN income_expenses ie ON ie.id = it.voucher_id
   WHERE it.handover_id = p_handover_id AND it.voucher_type = 'EXPENSE';

  v_lines := 'Đã thu (' || replace(to_char(v_h.gross_amount::bigint, 'FM999,999,999'), ',', '.') || 'đ):'
             || E'\n' || COALESCE(v_lines_in, '—')
             || CASE WHEN v_h.expense_amount > 0
                  THEN E'\n' || 'Đã chi (' || replace(to_char(v_h.expense_amount::bigint, 'FM999,999,999'), ',', '.') || 'đ):'
                       || E'\n' || COALESCE(v_lines_ex, '—')
                  ELSE '' END;

  v_item_desc := 'Bàn giao số dư: thu '
                 || replace(to_char(v_h.gross_amount::bigint, 'FM999,999,999'), ',', '.') || 'đ'
                 || CASE WHEN v_h.expense_amount > 0
                      THEN ' − chi ' || replace(to_char(v_h.expense_amount::bigint, 'FM999,999,999'), ',', '.') || 'đ'
                      ELSE '' END;

  -- Đợt 6: kỳ đã chốt thì cặp phiếu bàn giao rơi vào ngày MỞ đầu tiên.
  -- MỘT ngày chung cho cả hai chân, nếu không sẽ có cửa sổ "tiền trên đường".
  v_handover_date := GREATEST(
    public.org_today_v1(NULL),
    app_private.cashbook_closed_through_v1(v_h.from_account_id) + 1,
    app_private.cashbook_closed_through_v1(v_to) + 1);
  IF v_handover_date > public.org_today_v1(NULL) + 31 THEN
    RAISE EXCEPTION '[CASHBOOK_CLOSED] Sổ quỹ đã chốt tới % — phiên bàn giao này phải xử lý tay, hệ thống không lập phiếu ở ngày quá xa.',
      v_handover_date - 1 USING ERRCODE = 'P0001';
  END IF;

  -- ── 1 phiếu CHI tổng (sổ người giao) = NET ──
  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name)
  VALUES
    (v_h.giver_id, 'EXPENSE',
     'Bàn giao tiền mặt → ' || v_recv || ' — ' || v_h.code,
     v_bld_giver, v_h.from_account_id, v_handover_date,
     v_h.total_amount, 'APPROVED', FALSE,
     '[BÀN GIAO] Nộp tiền sang sổ ' || v_recv || ' (phiên ' || v_h.code || '):' || E'\n' || v_lines,
     v_caller)
  RETURNING id INTO v_exp;

  -- ── 1 phiếu THU tổng (sổ người nhận) = NET ──
  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name)
  VALUES
    (v_h.receiver_id, 'INCOME',
     'Nhận bàn giao tiền mặt ← ' || v_giver || ' — ' || v_h.code,
     v_bld_recv, v_to, v_handover_date,
     v_h.total_amount, 'APPROVED', FALSE,
     '[BÀN GIAO] Nhận tiền từ ' || v_giver || ' (phiên ' || v_h.code || '):' || E'\n' || v_lines,
     v_caller)
  RETURNING id INTO v_inc;

  -- ── 1 hạng mục GỘP = net trên mỗi phiếu (auto_recalc giữ total = net) ──
  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES (v_exp, v_type_exp, v_item_desc, 1, v_h.total_amount, NULL, NULL);
  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES (v_inc, v_type_inc, v_item_desc, 1, v_h.total_amount, NULL, NULL);

  -- Khoá cặp phiếu chuyển bằng handover_transfer_id (SAU khi nạp hạng mục)
  UPDATE income_expenses
     SET handover_transfer_id = p_handover_id
   WHERE id IN (v_exp, v_inc);

  UPDATE cash_handovers
     SET status = 'CONFIRMED', to_account_id = v_to, confirmed_at = now()
   WHERE id = p_handover_id;

  RETURN jsonb_build_object('id', p_handover_id, 'code', v_h.code,
                            'total_amount', v_h.total_amount, 'to_account_id', v_to,
                            'voucher_count', v_h.voucher_count);
END;
$function$;

-- public.create_cash_handover  (1 chỗ)
CREATE OR REPLACE FUNCTION public.create_cash_handover(p_receiver_id uuid, p_voucher_ids uuid[], p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ids         uuid[];
  v_cnt         int;
  v_from_acc    uuid;
  v_acc_owner   uuid;
  v_gross       numeric;
  v_expense     numeric;
  v_net         numeric;
  v_recv_name   text;
  v_recv_active boolean;
  v_giver_name  text;
  v_month       text;
  v_seq         int;
  v_code        text;
  v_id          uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_receiver_id IS NULL OR p_receiver_id = auth.uid() THEN
    RAISE EXCEPTION 'Người nhận không hợp lệ (không thể tự bàn giao cho chính mình)';
  END IF;

  SELECT full_name, is_active INTO v_recv_name, v_recv_active
    FROM profiles WHERE id = p_receiver_id;
  IF NOT FOUND OR v_recv_active IS FALSE THEN
    RAISE EXCEPTION 'Người nhận không tồn tại hoặc đã bị khoá';
  END IF;

  -- Cho bàn giao trong đội HOẶC nộp cho CHỦ (super admin) — quản lý nộp cho chủ
  -- dù không cùng đội.
  IF NOT (public.is_super_admin()
          OR public.same_team(p_receiver_id)
          OR EXISTS (SELECT 1 FROM public.super_admins sa WHERE sa.user_id = p_receiver_id)) THEN
    RAISE EXCEPTION 'Người nhận không cùng đội với bạn';
  END IF;

  v_ids := ARRAY(SELECT DISTINCT unnest(p_voucher_ids));
  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Chưa chọn phiếu nào để bàn giao';
  END IF;

  -- Khoá các phiếu chống race 2 phiên cùng lúc
  PERFORM 1 FROM income_expenses WHERE id = ANY(v_ids) FOR UPDATE;

  -- Hợp lệ: phiếu THU hoặc CHI đã duyệt, chưa bàn giao, có sổ.
  -- Loại phiếu CHI chuyển (handover_transfer_id IS NOT NULL, type=EXPENSE) — đó
  -- là phiếu "Bàn giao tiền mặt →" do confirm sinh ra, KHÔNG được quét lại (sẽ
  -- trừ trùng). Phiếu THU chuyển ("Nhận bàn giao") VẪN cho quét để bàn giao tiếp.
  SELECT count(*) INTO v_cnt
    FROM income_expenses
   WHERE id = ANY(v_ids)
     AND type IN ('INCOME', 'EXPENSE') AND approval_status = 'APPROVED'
     AND deleted_at IS NULL AND handover_id IS NULL AND account_id IS NOT NULL
     AND (handover_transfer_id IS NULL OR type = 'INCOME');
  IF v_cnt <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'Có phiếu không hợp lệ (đã xoá / đã nằm trong phiên bàn giao khác / chưa duyệt)';
  END IF;

  SELECT count(DISTINCT account_id) INTO v_cnt FROM income_expenses WHERE id = ANY(v_ids);
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Các phiếu bàn giao phải cùng MỘT sổ quỹ';
  END IF;

  SELECT account_id,
         COALESCE(sum(total_amount) FILTER (WHERE type = 'INCOME'), 0),
         COALESCE(sum(total_amount) FILTER (WHERE type = 'EXPENSE'), 0)
    INTO v_from_acc, v_gross, v_expense
    FROM income_expenses WHERE id = ANY(v_ids) GROUP BY account_id;
  v_net := v_gross - v_expense;
  IF v_net < 0 THEN
    RAISE EXCEPTION 'Phần đã chi lớn hơn phần đã thu — không thể bàn giao số âm. Thêm phiếu thu hoặc bớt phiếu chi.';
  END IF;

  SELECT user_id INTO v_acc_owner FROM accounts
   WHERE id = v_from_acc AND deleted_at IS NULL;
  IF v_acc_owner IS NULL OR v_acc_owner <> auth.uid() THEN
    RAISE EXCEPTION 'Chỉ bàn giao được phiếu nằm trong sổ quỹ do chính bạn sở hữu';
  END IF;

  SELECT COALESCE(full_name, '') INTO v_giver_name FROM profiles WHERE id = auth.uid();

  -- Mã BG{YYMM}{seq3} — advisory lock chống trùng khi 2 phiên tạo song song
  PERFORM pg_advisory_xact_lock(hashtext('cash_handover_code'));
  v_month := to_char(public.org_today_v1(NULL), 'YYMM');
  SELECT COALESCE(MAX(
           CASE WHEN code ~ ('^BG' || v_month || '\d+$')
                THEN substring(code FROM 7)::int ELSE 0 END
         ), 0) + 1
    INTO v_seq
    FROM cash_handovers WHERE code LIKE 'BG' || v_month || '%';
  v_code := 'BG' || v_month || lpad(v_seq::text, 3, '0');

  INSERT INTO cash_handovers
    (code, giver_id, receiver_id, giver_name, receiver_name, from_account_id,
     total_amount, gross_amount, expense_amount, voucher_count, note)
  VALUES
    (v_code, auth.uid(), p_receiver_id, v_giver_name, v_recv_name, v_from_acc,
     v_net, v_gross, v_expense, array_length(v_ids, 1), NULLIF(btrim(p_note), ''))
  RETURNING id INTO v_id;

  INSERT INTO cash_handover_items
    (handover_id, voucher_id, amount, voucher_code, voucher_date, room_name, building_name, voucher_type)
  SELECT v_id, ie.id, ie.total_amount, ie.code, ie.voucher_date, r.name, b.name, ie.type
    FROM income_expenses ie
    LEFT JOIN rooms r     ON r.id = ie.room_id
    LEFT JOIN buildings b ON b.id = ie.building_id
   WHERE ie.id = ANY(v_ids);

  UPDATE income_expenses SET handover_id = v_id WHERE id = ANY(v_ids);

  RETURN jsonb_build_object(
    'id', v_id, 'code', v_code, 'total_amount', v_net,
    'gross_amount', v_gross, 'expense_amount', v_expense,
    'voucher_count', array_length(v_ids, 1));
END;
$function$;

-- public.create_contract_v1  (2 chỗ)
CREATE OR REPLACE FUNCTION public.create_contract_v1(p_room_id uuid, p_customer_ids uuid[], p_signed_date date, p_start_date date, p_end_date date, p_rent_price numeric, p_total_deposit numeric, p_services jsonb, p_first_invoice jsonb, p_idempotency_key text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid; v_building uuid;
  v_authz boolean; v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype; v_route text;
  v_contract uuid; v_cust uuid; v_svc jsonb; v_inv json := null;
  v_resp json;
  c_op constant text := 'contract.create.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  v_key := btrim(coalesce(p_idempotency_key,''));
  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_start_date is null or p_end_date is null or p_start_date > p_end_date then
    raise exception 'Ngày hợp đồng không hợp lệ'; end if;
  if p_rent_price is null or p_rent_price < 0 then raise exception 'Giá thuê không hợp lệ'; end if;
  if p_customer_ids is null or array_length(p_customer_ids,1) is null then
    raise exception 'Cần ít nhất một khách hàng'; end if;

  -- room → building → org; room locked FOR NO KEY UPDATE.
  select r.building_id into v_building from public.rooms r
   where r.id=p_room_id and r.deleted_at is null for no key update;
  if not found then raise exception 'Không tìm thấy phòng' using errcode='42501'; end if;
  select b.organization_id into v_org from public.buildings b
    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where b.id=v_building and b.deleted_at is null for share of o,b;
  if v_org is null then raise exception 'Toà nhà không thuộc tổ chức đang hoạt động' using errcode='42501'; end if;

  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'contracts.create', v_building, null);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền tạo hợp đồng (contracts.create)' using errcode='42501'; end if;

  -- validate customers same-org.
  foreach v_cust in array p_customer_ids loop
    perform 1 from public.customers cu where cu.id=v_cust
      and (cu.organization_id is null or cu.organization_id=v_org) for share;
    if not found then raise exception 'Khách hàng không thuộc tổ chức' using errcode='42501'; end if;
  end loop;

  v_hash := md5(jsonb_build_object('room',p_room_id,'org',v_org,'start',p_start_date,
    'rent',p_rent_price)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_room_id::text || '|' || p_start_date::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op
     and o.subject_scope=p_room_id::text || '|' || p_start_date::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  -- idempotency replay BEFORE the business guard, so a legitimate retry returns
  -- the original contract instead of tripping "room already has a contract".
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  -- guard: room must not already be OCCUPIED by an ACTIVE contract (a NEW claim).
  if exists (select 1 from public.contracts c
             where c.room_id=p_room_id and c.deleted_at is null and c.status='ACTIVE') then
    raise exception 'Phòng đã có hợp đồng đang hiệu lực' using errcode='55000'; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer hợp đồng chưa bật' using errcode='55000'; end if;

  -- create the contract (org auto-fills via trigger; public_code auto).
  insert into public.contracts
    (user_id, organization_id, room_id, signed_date, start_date, end_date,
     rent_price, total_deposit, status)
  values (v_actor, v_org, p_room_id, coalesce(p_signed_date,p_start_date),
          p_start_date, p_end_date, p_rent_price, coalesce(p_total_deposit,0), 'ACTIVE')
  returning id into v_contract;

  foreach v_cust in array p_customer_ids loop
    insert into public.contract_customers (contract_id, customer_id)
    values (v_contract, v_cust) on conflict do nothing;
  end loop;

  if p_services is not null and jsonb_typeof(p_services)='array' then
    for v_svc in select value from jsonb_array_elements(p_services) loop
      insert into public.contract_services (contract_id, service_id, unit_price)
      values (v_contract, (v_svc->>'service_id')::uuid, coalesce((v_svc->>'unit_price')::numeric,0));
    end loop;
  end if;

  -- optional first invoice via the canonical invoice writer (reuse t5_02).
  if p_first_invoice is not null then
    v_inv := public.create_invoice_v1(
      v_contract, v_building, p_room_id,
      p_first_invoice->>'billing_month',
      coalesce(nullif(p_first_invoice->>'issue_date','')::date, public.org_today_v1(NULL)),
      coalesce(nullif(p_first_invoice->>'due_date','')::date, public.org_today_v1(NULL) + 15),
      'MONTHLY',
      coalesce((p_first_invoice->>'subtotal')::numeric,0), 0,
      coalesce((p_first_invoice->>'total_amount')::numeric,0), 0,
      coalesce(p_first_invoice->'items','[]'::jsonb),
      v_key || '-inv');
  end if;

  -- consume any live 24h hold on the room (link it to the contract).
  update public.room_reservation_holds
     set status='APPROVED', contract_id=v_contract
   where room_id=p_room_id and status='PENDING_APPROVAL';

  -- room OCCUPIED as the LAST mutation (dominates recompute_room_reservation).
  update public.rooms set status='OCCUPIED' where id=p_room_id;

  v_resp := json_build_object('contract_id', v_contract, 'first_invoice', v_inv);
  update app_private.canonical_write_operations
     set subject_id=v_contract, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op
     and subject_scope=p_room_id::text || '|' || p_start_date::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$function$;

-- public.create_new_contract_extension  (1 chỗ)
CREATE OR REPLACE FUNCTION public.create_new_contract_extension(p_contract_id uuid, p_extension_months integer, p_new_rent_price numeric DEFAULT NULL::numeric, p_new_deposit numeric DEFAULT NULL::numeric, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_old_contract public.contracts%ROWTYPE;
  v_new_contract_id uuid;
  v_extension_id uuid;
  v_new_end_date date;
  v_new_start_date date;
  v_building_id uuid;
  v_authz boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_extension_months IS NULL OR p_extension_months <= 0 THEN
    RAISE EXCEPTION 'extension_months must be positive' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_new_rent_price::text, '') IN ('NaN', 'Infinity', '-Infinity')
     OR COALESCE(p_new_deposit::text, '') IN ('NaN', 'Infinity', '-Infinity')
     OR COALESCE(p_new_rent_price, 0) < 0
     OR COALESCE(p_new_deposit, 0) < 0 THEN
    RAISE EXCEPTION 'New rent/deposit is not a finite non-negative amount'
      USING ERRCODE = '22023';
  END IF;

  SELECT contract_row.*
    INTO v_old_contract
  FROM public.contracts contract_row
  JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  JOIN public.organizations org_row
    ON org_row.id = contract_row.organization_id AND org_row.status = 'ACTIVE'
  WHERE contract_row.id = p_contract_id
    AND contract_row.status = 'ACTIVE'
    AND contract_row.deleted_at IS NULL
  FOR UPDATE OF contract_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract not found or not active' USING ERRCODE = '42501';
  END IF;

  SELECT room_row.building_id INTO v_building_id
  FROM public.rooms room_row
  WHERE room_row.id = v_old_contract.room_id
    AND room_row.deleted_at IS NULL
  FOR SHARE;
  IF v_building_id IS NULL THEN
    RAISE EXCEPTION 'Contract room is unavailable' USING ERRCODE = '42501';
  END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_old_contract.organization_id);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    v_actor, v_old_contract.organization_id, 'contracts.renew', v_building_id, NULL
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Not authorized to renew this contract' USING ERRCODE = '42501';
  END IF;

  v_new_start_date := v_old_contract.end_date + 1;
  v_new_end_date := (
    v_new_start_date + (p_extension_months || ' months')::interval - interval '1 day'
  )::date;

  UPDATE public.contracts
     SET status = 'EXPIRED', updated_at = now()
   WHERE id = p_contract_id;

  INSERT INTO public.contracts (
    user_id, organization_id, tenant_id, room_id, contract_number, status,
    signed_date, start_date, end_date, rent_price, payment_cycle,
    total_deposit, deposit_paid, parent_contract_id, notes,
    start_billing_date, end_billing_date, contract_template_id, invoice_template_id
  ) VALUES (
    v_old_contract.user_id, v_old_contract.organization_id, v_old_contract.tenant_id,
    v_old_contract.room_id, NULL, 'ACTIVE', public.org_today_v1(NULL),
    v_new_start_date, v_new_end_date,
    COALESCE(p_new_rent_price, v_old_contract.rent_price),
    v_old_contract.payment_cycle,
    COALESCE(p_new_deposit, v_old_contract.total_deposit),
    LEAST(
      v_old_contract.deposit_paid,
      COALESCE(p_new_deposit, v_old_contract.total_deposit)
    ),
    p_contract_id,
    COALESCE(p_notes, 'Gia hạn từ HĐ: ' || COALESCE(v_old_contract.contract_number, p_contract_id::text)),
    v_new_start_date, v_new_end_date,
    v_old_contract.contract_template_id, v_old_contract.invoice_template_id
  ) RETURNING id INTO v_new_contract_id;

  INSERT INTO public.contract_customers (
    organization_id, contract_id, customer_id, is_representative, notes
  )
  SELECT organization_id, v_new_contract_id, customer_id, is_representative, notes
  FROM public.contract_customers
  WHERE contract_id = p_contract_id;

  INSERT INTO public.contract_services (
    organization_id, contract_id, service_id, unit_price, initial_reading
  )
  SELECT organization_id, v_new_contract_id, service_id, unit_price, initial_reading
  FROM public.contract_services
  WHERE contract_id = p_contract_id;

  INSERT INTO public.contract_extensions (
    user_id, contract_id, extension_type, old_end_date, extension_months,
    new_end_date, new_rent_price, rent_price_changed, new_deposit,
    deposit_changed, new_contract_id, notes, status
  ) VALUES (
    v_actor, p_contract_id, 'CREATE_NEW', v_old_contract.end_date,
    p_extension_months, v_new_end_date, p_new_rent_price,
    p_new_rent_price IS NOT NULL AND p_new_rent_price <> v_old_contract.rent_price,
    p_new_deposit,
    p_new_deposit IS NOT NULL AND p_new_deposit <> v_old_contract.total_deposit,
    v_new_contract_id, p_notes, 'COMPLETED'
  ) RETURNING id INTO v_extension_id;

  RETURN v_new_contract_id;
END;
$function$;

-- public.create_opening_adjustment  (2 chỗ)
CREATE OR REPLACE FUNCTION public.create_opening_adjustment(p_account_id uuid, p_counted_balance numeric, p_as_of date DEFAULT public.org_today_v1(NULL))
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_acc        accounts%ROWTYPE;
  v_system     numeric;
  v_diff       numeric;
  v_type_id    uuid;
  v_voucher_id uuid;
  v_kind       text;
BEGIN
  SELECT * INTO v_acc FROM accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy sổ quỹ';
  END IF;
  IF v_acc.user_id <> auth.uid() AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Bạn không có quyền chốt sổ này';
  END IF;
  IF COALESCE(v_acc.is_virtual, FALSE) THEN
    RAISE EXCEPTION 'Sổ theo dõi (ảo) không kiểm kê tiền thật — không cần điều chỉnh';
  END IF;
  IF p_as_of > public.org_today_v1(NULL) THEN
    RAISE EXCEPTION 'Ngày chốt không được ở tương lai';
  END IF;
  IF v_acc.lock_date IS NOT NULL AND v_acc.lock_date > p_as_of THEN
    RAISE EXCEPTION 'Sổ đã khoá tới % — không thể chốt lùi về %',
      v_acc.lock_date, p_as_of;
  END IF;

  SELECT current_amount INTO v_system
  FROM accounts_with_balance WHERE id = p_account_id;
  v_diff := COALESCE(p_counted_balance, 0) - COALESCE(v_system, 0);

  IF abs(v_diff) >= 1 THEN
    -- Trigger khoá sổ chặn phiếu có ngày ≤ lock_date — phiếu điều chỉnh ngày D
    -- chính là ngày khoá, nên TẠM GỠ lock trong transaction (row đã FOR UPDATE)
    -- rồi khoá lại ở cuối. Chốt lại lần 2 cùng ngày cũng đi đường này.
    IF v_acc.lock_date IS NOT NULL THEN
      UPDATE accounts SET lock_date = NULL WHERE id = p_account_id;
    END IF;
    v_kind := CASE WHEN v_diff > 0 THEN 'income' ELSE 'expense' END;
    -- Hạng mục "Điều chỉnh số dư" (get-or-create) — ẩn khỏi báo cáo P&L.
    v_type_id := public._termination_ensure_type(
      v_acc.user_id, v_kind, 'Điều chỉnh số dư');
    UPDATE income_expense_types
       SET hide_in_report = TRUE
     WHERE id = v_type_id AND hide_in_report IS DISTINCT FROM TRUE;

    INSERT INTO income_expenses (
      user_id, type, name, building_id, account_id, voucher_date,
      total_amount, approval_status, business_result_accounting,
      system_source, notes
    ) VALUES (
      v_acc.user_id,
      CASE WHEN v_diff > 0 THEN 'INCOME' ELSE 'EXPENSE' END,
      'Điều chỉnh số dư đầu kỳ — ' || v_acc.name || ' (kiểm kê ' ||
        to_char(p_as_of, 'DD/MM/YYYY') || ')',
      public._chung_building(v_acc.user_id),
      p_account_id,
      p_as_of,
      abs(v_diff),
      'APPROVED',
      FALSE,  -- ép ngoài-KQKD: kqkd_amount = 0, không lọt Phân bổ LN
      'adjustment.opening_balance',
      '[ĐIỀU CHỈNH SỐ DƯ ĐẦU KỲ] Đếm thực tế ' || p_counted_balance ||
        ' − hệ thống ' || COALESCE(v_system, 0) || ' = ' || v_diff ||
        '. Kiểm kê ngày ' || to_char(p_as_of, 'DD/MM/YYYY') ||
        ' theo quy trình chuẩn hoá két (không tính vào lợi nhuận).'
    ) RETURNING id INTO v_voucher_id;

    INSERT INTO income_expense_items (
      income_expense_id, income_expense_type_id, description,
      quantity, unit_price
    ) VALUES (
      v_voucher_id, v_type_id,
      'Chênh lệch kiểm kê ' || to_char(p_as_of, 'DD/MM/YYYY'),
      1, abs(v_diff)
    );
  END IF;

  UPDATE accounts SET lock_date = p_as_of WHERE id = p_account_id;

  RETURN jsonb_build_object(
    'account_id', p_account_id,
    'system_balance', COALESCE(v_system, 0),
    'counted_balance', COALESCE(p_counted_balance, 0),
    'diff', v_diff,
    'voucher_id', v_voucher_id,
    'locked_to', p_as_of
  );
END;
$function$;

-- public.fa_snapshot_kpis  (5 chỗ)
CREATE OR REPLACE FUNCTION public.fa_snapshot_kpis(p_building_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(building_id uuid, building_name text, total_rooms integer, rooms_available integer, rooms_occupied integer, rooms_reserved integer, rooms_maintenance integer, rooms_unavailable integer, vacancy_loss_month numeric, active_contracts bigint, avg_rent numeric, deposit_held numeric, receivable_total numeric, aging_not_due numeric, aging_1_30 numeric, aging_31_60 numeric, aging_61_90 numeric, aging_over_90 numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH allowed AS (
    SELECT b.id, b.name
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
      AND b.is_virtual = false
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
  ),
  room_stats AS (
    SELECT r.building_id AS bid,
           COUNT(*)::int                                          AS total_r,
           COUNT(*) FILTER (WHERE r.status = 'AVAILABLE')::int    AS avail,
           COUNT(*) FILTER (WHERE r.status = 'OCCUPIED')::int     AS occ,
           COUNT(*) FILTER (WHERE r.status = 'RESERVED')::int     AS resv,
           COUNT(*) FILTER (WHERE r.status = 'MAINTENANCE')::int  AS maint,
           COUNT(*) FILTER (WHERE r.status = 'UNAVAILABLE')::int  AS unavail,
           COALESCE(SUM(r.rent_price) FILTER (WHERE r.status = 'AVAILABLE'), 0)::numeric AS vacancy_loss
    FROM public.rooms r
    JOIN allowed a ON a.id = r.building_id
    WHERE r.deleted_at IS NULL
    GROUP BY r.building_id
  ),
  contract_stats AS (
    SELECT r.building_id AS bid,
           COUNT(*)                                  AS actives,
           AVG(c.rent_price)::numeric                AS avg_rent_b,
           COALESCE(SUM(c.deposit_paid), 0)::numeric AS dep_held
    FROM public.contracts c
    JOIN public.rooms r ON r.id = c.room_id
    JOIN allowed a ON a.id = r.building_id
    WHERE c.deleted_at IS NULL
      AND c.status = 'ACTIVE'
    GROUP BY r.building_id
  ),
  receivables AS (
    SELECT i.building_id AS bid,
           COALESCE(SUM(i.remaining_amount), 0)::numeric AS total_recv,
           COALESCE(SUM(i.remaining_amount) FILTER (
             WHERE i.due_date IS NULL OR i.due_date >= public.org_today_v1(NULL)), 0)::numeric AS not_due,
           COALESCE(SUM(i.remaining_amount) FILTER (
             WHERE public.org_today_v1(NULL) - i.due_date BETWEEN 1  AND 30), 0)::numeric AS d1_30,
           COALESCE(SUM(i.remaining_amount) FILTER (
             WHERE public.org_today_v1(NULL) - i.due_date BETWEEN 31 AND 60), 0)::numeric AS d31_60,
           COALESCE(SUM(i.remaining_amount) FILTER (
             WHERE public.org_today_v1(NULL) - i.due_date BETWEEN 61 AND 90), 0)::numeric AS d61_90,
           COALESCE(SUM(i.remaining_amount) FILTER (
             WHERE public.org_today_v1(NULL) - i.due_date > 90), 0)::numeric AS d90p
    FROM public.invoices i
    JOIN allowed a ON a.id = i.building_id
    WHERE i.deleted_at IS NULL
      AND i.status IN ('APPROVED', 'PARTIAL_PAID', 'OVERDUE')
      AND i.remaining_amount > 0
    GROUP BY i.building_id
  )
  SELECT
    a.id, a.name,
    COALESCE(rs.total_r, 0), COALESCE(rs.avail, 0), COALESCE(rs.occ, 0),
    COALESCE(rs.resv, 0), COALESCE(rs.maint, 0), COALESCE(rs.unavail, 0),
    COALESCE(rs.vacancy_loss, 0),
    COALESCE(cs.actives, 0),
    COALESCE(cs.avg_rent_b, 0),
    COALESCE(cs.dep_held, 0),
    COALESCE(rc.total_recv, 0),
    COALESCE(rc.not_due, 0), COALESCE(rc.d1_30, 0), COALESCE(rc.d31_60, 0),
    COALESCE(rc.d61_90, 0), COALESCE(rc.d90p, 0)
  FROM allowed a
  LEFT JOIN room_stats     rs ON rs.bid = a.id
  LEFT JOIN contract_stats cs ON cs.bid = a.id
  LEFT JOIN receivables    rc ON rc.bid = a.id
  ORDER BY a.name;
$function$;

-- public.generate_code  (5 chỗ)
CREATE OR REPLACE FUNCTION public.generate_code(p_user_id uuid, p_object_type text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_config RECORD;
  v_next_seq INTEGER;
  v_code TEXT;
  v_date_part TEXT;
  v_need_reset BOOLEAN := false;
BEGIN
  -- Get config
  SELECT * INTO v_config
  FROM code_sequences
  WHERE user_id = p_user_id AND object_type = p_object_type;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Code configuration not found for %', p_object_type;
  END IF;

  -- Check if need reset
  IF v_config.reset_period = 'DAILY' AND
     v_config.last_reset_at < public.org_today_v1(NULL) THEN
    v_need_reset := true;
  ELSIF v_config.reset_period = 'MONTHLY' AND
        DATE_TRUNC('month', v_config.last_reset_at) < DATE_TRUNC('month', public.org_today_v1(NULL)) THEN
    v_need_reset := true;
  ELSIF v_config.reset_period = 'YEARLY' AND
        DATE_TRUNC('year', v_config.last_reset_at) < DATE_TRUNC('year', public.org_today_v1(NULL)) THEN
    v_need_reset := true;
  END IF;

  -- Reset or increment
  IF v_need_reset THEN
    v_next_seq := 1;
  ELSE
    v_next_seq := v_config.current_sequence + 1;
  END IF;

  -- Generate date part
  IF v_config.date_format IS NOT NULL THEN
    v_date_part := TO_CHAR(public.org_today_v1(NULL), v_config.date_format);
  END IF;

  -- Build code
  v_code := v_config.prefix;

  IF v_date_part IS NOT NULL THEN
    v_code := v_code || v_config.separator || v_date_part;
  END IF;

  v_code := v_code || v_config.separator ||
            LPAD(v_next_seq::TEXT, v_config.sequence_length, '0');

  -- Update sequence
  UPDATE code_sequences
  SET current_sequence = v_next_seq,
      last_reset_at = CASE WHEN v_need_reset THEN public.org_today_v1(NULL) ELSE last_reset_at END,
      updated_at = NOW()
  WHERE user_id = p_user_id AND object_type = p_object_type;

  RETURN v_code;
END;
$function$;

-- public.generate_invoices_for_building  (2 chỗ)
CREATE OR REPLACE FUNCTION public.generate_invoices_for_building(p_user_id uuid, p_building_id uuid, p_billing_month text, p_invoice_type text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_contract RECORD;
  v_service RECORD;
  v_invoice_id UUID;
  v_created_count INT := 0;
  v_skipped_contracts JSON[] := ARRAY[]::JSON[];
  v_subtotal DECIMAL(15, 2);
  v_item_amount DECIMAL(15, 2);
  v_sort_order INT;
BEGIN
  IF p_invoice_type NOT IN ('rent_only', 'service_only', 'both') THEN
    RAISE EXCEPTION 'Invalid invoice_type: %. Must be rent_only, service_only, or both', p_invoice_type;
  END IF;

  IF p_billing_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Invalid billing_month format: %. Must be YYYY-MM', p_billing_month;
  END IF;

  FOR v_contract IN
    SELECT c.id AS contract_id, c.user_id, c.room_id, c.rent_price, r.building_id
    FROM contracts c
    JOIN rooms r ON r.id = c.room_id
    WHERE c.user_id = p_user_id
      AND r.building_id = p_building_id
      AND c.status = 'ACTIVE'
      AND c.deleted_at IS NULL
  LOOP
    IF EXISTS (
      SELECT 1 FROM invoices
      WHERE contract_id = v_contract.contract_id
        AND billing_month = p_billing_month
        AND deleted_at IS NULL
        AND kind = 'MONTHLY'
    ) THEN
      v_skipped_contracts := array_append(
        v_skipped_contracts,
        json_build_object('contract_id', v_contract.contract_id, 'reason', 'Invoice already exists')
      );
      CONTINUE;
    END IF;

    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id,
      billing_month, issue_date, due_date,
      status, approved_at, approved_by,
      subtotal, total_amount
    ) VALUES (
      p_user_id, v_contract.contract_id, v_contract.building_id,
      v_contract.room_id,
      p_billing_month, public.org_today_v1(NULL), public.org_today_v1(NULL) + INTERVAL '5 days',
      'APPROVED', NOW(), p_user_id,
      0, 0
    )
    RETURNING id INTO v_invoice_id;

    v_subtotal := 0;
    v_sort_order := 0;

    IF p_invoice_type IN ('rent_only', 'both') THEN
      v_item_amount := v_contract.rent_price;
      v_sort_order := v_sort_order + 1;

      INSERT INTO invoice_items (
        invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order
      ) VALUES (
        v_invoice_id, 'RENT', 'Tiền thuê phòng',
        v_contract.rent_price, 1, 1, v_item_amount, v_sort_order
      );

      v_subtotal := v_subtotal + v_item_amount;
    END IF;

    IF p_invoice_type IN ('service_only', 'both') THEN
      FOR v_service IN
        SELECT cs.service_id, cs.unit_price, s.name AS service_name, s.type AS service_type
        FROM contract_services cs
        JOIN services s ON s.id = cs.service_id
        WHERE cs.contract_id = v_contract.contract_id
      LOOP
        v_sort_order := v_sort_order + 1;
        v_item_amount := v_service.unit_price;

        INSERT INTO invoice_items (
          invoice_id, service_id, type, description,
          unit_price, quantity, coefficient, amount, sort_order
        ) VALUES (
          v_invoice_id, v_service.service_id, 'SERVICE', v_service.service_name,
          v_service.unit_price, 1, 1, v_item_amount, v_sort_order
        );

        v_subtotal := v_subtotal + v_item_amount;
      END LOOP;
    END IF;

    UPDATE invoices
    SET subtotal = v_subtotal, total_amount = v_subtotal
    WHERE id = v_invoice_id;

    v_created_count := v_created_count + 1;
  END LOOP;

  RETURN json_build_object(
    'created_count', v_created_count,
    'skipped_contracts', to_json(v_skipped_contracts)
  );
END;
$function$;

-- public.generate_next_code  (2 chỗ)
CREATE OR REPLACE FUNCTION public.generate_next_code(p_user_id uuid, p_object_type character varying)
 RETURNS character varying
 LANGUAGE plpgsql
AS $function$
DECLARE
  seq_record RECORD;
  next_seq INTEGER;
  current_period VARCHAR;
  new_code VARCHAR;
BEGIN
  -- Lock and get sequence record
  SELECT * INTO seq_record
  FROM code_sequences
  WHERE user_id = p_user_id AND object_type = p_object_type
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Create default sequence if not exists
    INSERT INTO code_sequences (user_id, object_type, prefix, date_format, separator, sequence_length, reset_period, current_sequence)
    VALUES (p_user_id, p_object_type, SUBSTRING(p_object_type FROM 1 FOR 2), 'YYMM', '-', 4, 'MONTHLY', 1)
    RETURNING * INTO seq_record;
  END IF;

  -- Get current period
  current_period := TO_CHAR(public.org_today_v1(NULL), seq_record.date_format);

  -- Check if we need to reset sequence
  IF seq_record.reset_period = 'MONTHLY' AND
     (seq_record.last_reset_at IS NULL OR
      TO_CHAR(seq_record.last_reset_at, 'YYMM') != current_period) THEN
    next_seq := 1;
    UPDATE code_sequences
    SET current_sequence = 2, last_reset_at = CURRENT_TIMESTAMP
    WHERE id = seq_record.id;
  ELSIF seq_record.reset_period = 'YEARLY' AND
        (seq_record.last_reset_at IS NULL OR
         TO_CHAR(seq_record.last_reset_at, 'YY') != TO_CHAR(public.org_today_v1(NULL), 'YY')) THEN
    next_seq := 1;
    UPDATE code_sequences
    SET current_sequence = 2, last_reset_at = CURRENT_TIMESTAMP
    WHERE id = seq_record.id;
  ELSE
    next_seq := COALESCE(seq_record.current_sequence, 1);
    UPDATE code_sequences
    SET current_sequence = next_seq + 1
    WHERE id = seq_record.id;
  END IF;

  -- Build code
  new_code := seq_record.prefix || seq_record.separator || current_period || seq_record.separator ||
              LPAD(next_seq::TEXT, seq_record.sequence_length, '0');

  RETURN new_code;
END;
$function$;

-- public.generate_recurring_vouchers  (1 chỗ)
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
            CASE WHEN parent.repeat_auto_approve THEN 'APPROVED' ELSE 'UNAPPROVED' END,
            CASE WHEN parent.repeat_auto_approve THEN now() ELSE NULL END,
            CASE WHEN parent.repeat_auto_approve THEN parent.user_id ELSE NULL END,
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

-- public.generate_template_code  (1 chỗ)
CREATE OR REPLACE FUNCTION public.generate_template_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_month TEXT;
  v_sequence INTEGER;
BEGIN
  IF NEW.code IS NOT NULL AND NEW.code != '' THEN
    RETURN NEW;
  END IF;

  v_month := TO_CHAR(public.org_today_v1(NULL), 'YYMM');

  PERFORM pg_advisory_xact_lock(hashtext('MT' || v_month || COALESCE(NEW.user_id::text, '')));

  SELECT COALESCE(MAX(
    CASE
      WHEN code ~ ('^MT\d{4}\d+$')
        AND SUBSTRING(code FROM 3 FOR 4) = v_month
      THEN CAST(SUBSTRING(code FROM 7) AS INTEGER)
      ELSE 0
    END
  ), 0) + 1
  INTO v_sequence
  FROM income_expense_templates
  WHERE user_id = NEW.user_id
    AND code LIKE 'MT' || v_month || '%';

  NEW.code := 'MT' || v_month || LPAD(v_sequence::TEXT, 3, '0');
  RETURN NEW;
END;
$function$;

-- public.get_my_available_rooms  (10 chỗ)
CREATE OR REPLACE FUNCTION public.get_my_available_rooms()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller  uuid := auth.uid();
  v_owner   uuid;
  v_soon    int;
  v_hotline uuid;
  v_result  jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT sa.user_id INTO v_owner
  FROM public.staff_assignments sa
  WHERE sa.staff_id = v_caller AND sa.user_id <> v_caller
  LIMIT 1;
  IF v_owner IS NULL THEN
    v_owner := v_caller;
  END IF;

  SELECT soon_days, hotline_id INTO v_soon, v_hotline
  FROM public.public_room_settings
  WHERE owner_id = v_owner;
  IF v_soon IS NULL THEN v_soon := 30; END IF;

  WITH rms AS (
    SELECT
      rm.id,
      rm.building_id,
      rm.floor,
      rm.name,
      rm.code,
      rm.area,
      rm.rent_price,
      rm.deposit_amount,
      rm.max_occupants,
      COALESCE(rm.amenities, '[]'::jsonb) AS amenities,
      COALESCE(rm.images,    '[]'::jsonb) AS images,
      rm.description,
      rm.sale_note,
      rm.sale_bonus_note,
      rm.room_type,
      -- Phòng khách nhờ sale (overlay). Khi contact_manager → che SĐT/tên khách.
      CASE WHEN pl.contact_manager THEN NULL ELSE pl.contact_name  END AS pass_contact_name,
      CASE WHEN pl.contact_manager THEN NULL ELSE pl.contact_phone END AS pass_contact_phone,
      pl.sale_policy   AS pass_sale_policy,
      pl.pass_price    AS pass_price,
      pl.avail_date    AS pass_avail_date,
      COALESCE(pl.contact_manager, false) AS pass_contact_manager,
      CASE
        WHEN pl.id IS NOT NULL THEN 'pass'
        -- Đã có cọc giữ chỗ chưa gắn HĐ → phòng bị KHOÁ (xem RPC public ở trên).
        WHEN public.room_has_holding_deposit(rm.id) THEN 'rented'
        WHEN EXISTS (
          SELECT 1 FROM public.contracts c
          WHERE c.room_id = rm.id
            AND c.deleted_at IS NULL
            AND c.status IN ('ACTIVE','EXTENDED')
            AND (
              (c.expected_move_out_date IS NOT NULL
                AND c.expected_move_out_date BETWEEN public.org_today_v1(NULL) AND public.org_today_v1(NULL) + v_soon)
              OR COALESCE(c.actual_end_date, c.end_date)
                   BETWEEN public.org_today_v1(NULL) AND public.org_today_v1(NULL) + v_soon
            )
        ) THEN 'soon'
        WHEN EXISTS (
          SELECT 1 FROM public.contracts c
          WHERE c.room_id = rm.id
            AND c.deleted_at IS NULL
            AND c.status IN ('ACTIVE','EXTENDED')
        ) THEN 'rented'
        WHEN rm.status = 'AVAILABLE' THEN 'free'
        ELSE 'rented'
      END AS status_public,
      (
        SELECT MIN(
          CASE
            WHEN c.expected_move_out_date IS NOT NULL
              AND c.expected_move_out_date BETWEEN public.org_today_v1(NULL) AND public.org_today_v1(NULL) + v_soon
              THEN c.expected_move_out_date
            ELSE COALESCE(c.actual_end_date, c.end_date)
          END
        )
        FROM public.contracts c
        WHERE c.room_id = rm.id
          AND c.deleted_at IS NULL
          AND c.status IN ('ACTIVE','EXTENDED')
          AND (
            (c.expected_move_out_date IS NOT NULL
              AND c.expected_move_out_date BETWEEN public.org_today_v1(NULL) AND public.org_today_v1(NULL) + v_soon)
            OR COALESCE(c.actual_end_date, c.end_date)
                 BETWEEN public.org_today_v1(NULL) AND public.org_today_v1(NULL) + v_soon
          )
      ) AS avail_date
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = rm.id AND pl.user_id = v_owner AND pl.active = true
    WHERE b.user_id = v_owner
      AND b.is_virtual = false
      AND b.deleted_at IS NULL
      AND rm.deleted_at IS NULL
  ),
  bld_ids AS (
    SELECT DISTINCT building_id FROM rms WHERE status_public IN ('free','soon','pass')
  ),
  rooms_j AS (
    SELECT jsonb_agg(to_jsonb(rms) ORDER BY rms.floor DESC, rms.name) AS j
    FROM rms
    WHERE rms.building_id IN (SELECT building_id FROM bld_ids)
  ),
  blds_j AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id',           b.id,
      'name',         b.name,
      'code',         b.code,
      'area_ids',     COALESCE((
                        SELECT jsonb_agg(ab.area_id)
                        FROM public.area_buildings ab
                        JOIN public.areas a ON a.id = ab.area_id
                        WHERE ab.building_id = b.id AND a.deleted_at IS NULL
                      ), '[]'::jsonb),
      'district',     b.district,
      'ward',         b.ward,
      'address',      CASE
                        WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%'
                          THEN b.street_address
                        ELSE concat_ws(', ',
                               NULLIF(b.street_address, ''),
                               NULLIF(b.ward, ''),
                               NULLIF(b.district, ''),
                               NULLIF(b.province, ''))
                      END,
      'total_floors', b.total_floors,
      'floor_layouts', b.floor_layouts,
      'images',        COALESCE(b.images, '[]'::jsonb),
      'public_contact_name',  b.public_contact_name,
      'public_contact_phone', b.public_contact_phone,
      'public_map_url',       b.public_map_url,
      'public_lift_type',     b.public_lift_type,
      'elec_rate', (
        SELECT COALESCE(bs.unit_price_override, s.unit_price)
        FROM public.building_services bs
        JOIN public.services s ON s.id = bs.service_id
        WHERE bs.building_id = b.id
          AND bs.is_active = true
          AND s.deleted_at IS NULL
          AND s.unit ILIKE 'kwh'
        ORDER BY (s.type = 'FIXED') DESC, s.unit_price
        LIMIT 1
      )
    ) ORDER BY b.name) AS j
    FROM public.buildings b
    WHERE b.id IN (SELECT building_id FROM bld_ids)
  ),
  areas_j AS (
    SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.name) AS j
    FROM public.areas a
    WHERE a.user_id = v_owner AND a.deleted_at IS NULL
  ),
  contact_j AS (
    SELECT jsonb_build_object('name', h.name, 'phone', h.phone_number) AS j
    FROM public.hotlines h
    WHERE h.user_id = v_owner
      AND COALESCE(h.is_active, true) = true
      AND (v_hotline IS NULL OR h.id = v_hotline)
    ORDER BY (h.id = v_hotline) DESC NULLS LAST, h.created_at
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'areas',     COALESCE((SELECT j FROM areas_j), '[]'::jsonb),
    'buildings', COALESCE((SELECT j FROM blds_j), '[]'::jsonb),
    'rooms',     COALESCE((SELECT j FROM rooms_j), '[]'::jsonb),
    'contact',   (SELECT j FROM contact_j)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

-- public.get_public_available_rooms  (10 chỗ)
CREATE OR REPLACE FUNCTION public.get_public_available_rooms(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner   uuid;
  v_soon    int;
  v_hotline uuid;
  v_result  jsonb;
BEGIN
  IF p_token IS NULL OR p_token = '' THEN
    RETURN NULL;
  END IF;

  SELECT owner_id INTO v_owner
  FROM public.public_room_share_tokens
  WHERE token = p_token AND revoked = false;

  IF v_owner IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT soon_days, hotline_id INTO v_soon, v_hotline
  FROM public.public_room_settings
  WHERE owner_id = v_owner;
  IF v_soon IS NULL THEN v_soon := 30; END IF;

  WITH rms AS (
    SELECT
      rm.id,
      rm.building_id,
      rm.floor,
      rm.name,
      rm.code,
      rm.area,
      rm.rent_price,
      rm.deposit_amount,
      rm.max_occupants,
      COALESCE(rm.amenities, '[]'::jsonb) AS amenities,
      COALESCE(rm.images,    '[]'::jsonb) AS images,
      rm.description,
      rm.sale_note,
      rm.sale_bonus_note,
      rm.room_type,
      -- Phòng khách nhờ sale (overlay). Khi contact_manager → che SĐT/tên khách.
      CASE WHEN pl.contact_manager THEN NULL ELSE pl.contact_name  END AS pass_contact_name,
      CASE WHEN pl.contact_manager THEN NULL ELSE pl.contact_phone END AS pass_contact_phone,
      pl.sale_policy   AS pass_sale_policy,
      pl.pass_price    AS pass_price,
      pl.avail_date    AS pass_avail_date,
      COALESCE(pl.contact_manager, false) AS pass_contact_manager,
      CASE
        WHEN pl.id IS NOT NULL THEN 'pass'
        -- Đã có cọc giữ chỗ chưa gắn HĐ → phòng bị KHOÁ, không chào khách nữa.
        -- Đặt TRƯỚC nhánh 'soon' vì phòng sắp trống vẫn còn HĐ hiệu lực nên
        -- rooms.status không thể là RESERVED (reconcile bỏ qua phòng có HĐ).
        WHEN public.room_has_holding_deposit(rm.id) THEN 'rented'
        WHEN EXISTS (
          SELECT 1 FROM public.contracts c
          WHERE c.room_id = rm.id
            AND c.deleted_at IS NULL
            AND c.status IN ('ACTIVE','EXTENDED')
            AND (
              (c.expected_move_out_date IS NOT NULL
                AND c.expected_move_out_date BETWEEN public.org_today_v1(NULL) AND public.org_today_v1(NULL) + v_soon)
              OR COALESCE(c.actual_end_date, c.end_date)
                   BETWEEN public.org_today_v1(NULL) AND public.org_today_v1(NULL) + v_soon
            )
        ) THEN 'soon'
        WHEN EXISTS (
          SELECT 1 FROM public.contracts c
          WHERE c.room_id = rm.id
            AND c.deleted_at IS NULL
            AND c.status IN ('ACTIVE','EXTENDED')
        ) THEN 'rented'
        WHEN rm.status = 'AVAILABLE' THEN 'free'
        ELSE 'rented'
      END AS status_public,
      (
        SELECT MIN(
          CASE
            WHEN c.expected_move_out_date IS NOT NULL
              AND c.expected_move_out_date BETWEEN public.org_today_v1(NULL) AND public.org_today_v1(NULL) + v_soon
              THEN c.expected_move_out_date
            ELSE COALESCE(c.actual_end_date, c.end_date)
          END
        )
        FROM public.contracts c
        WHERE c.room_id = rm.id
          AND c.deleted_at IS NULL
          AND c.status IN ('ACTIVE','EXTENDED')
          AND (
            (c.expected_move_out_date IS NOT NULL
              AND c.expected_move_out_date BETWEEN public.org_today_v1(NULL) AND public.org_today_v1(NULL) + v_soon)
            OR COALESCE(c.actual_end_date, c.end_date)
                 BETWEEN public.org_today_v1(NULL) AND public.org_today_v1(NULL) + v_soon
          )
      ) AS avail_date
    FROM public.rooms rm
    JOIN public.buildings b ON b.id = rm.building_id
    LEFT JOIN public.room_pass_listings pl
      ON pl.room_id = rm.id AND pl.user_id = v_owner AND pl.active = true
    WHERE b.user_id = v_owner
      AND b.is_virtual = false
      AND b.deleted_at IS NULL
      AND rm.deleted_at IS NULL
  ),
  bld_ids AS (
    SELECT DISTINCT building_id FROM rms WHERE status_public IN ('free','soon','pass')
  ),
  rooms_j AS (
    SELECT jsonb_agg(to_jsonb(rms) ORDER BY rms.floor DESC, rms.name) AS j
    FROM rms
    WHERE rms.building_id IN (SELECT building_id FROM bld_ids)
  ),
  blds_j AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id',           b.id,
      'name',         b.name,
      'code',         b.code,
      'area_ids',     COALESCE((
                        SELECT jsonb_agg(ab.area_id)
                        FROM public.area_buildings ab
                        JOIN public.areas a ON a.id = ab.area_id
                        WHERE ab.building_id = b.id AND a.deleted_at IS NULL
                      ), '[]'::jsonb),
      'district',     b.district,
      'ward',         b.ward,
      'address',      CASE
                        WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%'
                          THEN b.street_address
                        ELSE concat_ws(', ',
                               NULLIF(b.street_address, ''),
                               NULLIF(b.ward, ''),
                               NULLIF(b.district, ''),
                               NULLIF(b.province, ''))
                      END,
      'total_floors', b.total_floors,
      'floor_layouts', b.floor_layouts,
      'images',        COALESCE(b.images, '[]'::jsonb),
      'public_contact_name',  b.public_contact_name,
      'public_contact_phone', b.public_contact_phone,
      'public_map_url',       b.public_map_url,
      'public_lift_type',     b.public_lift_type,
      'elec_rate', (
        SELECT COALESCE(bs.unit_price_override, s.unit_price)
        FROM public.building_services bs
        JOIN public.services s ON s.id = bs.service_id
        WHERE bs.building_id = b.id
          AND bs.is_active = true
          AND s.deleted_at IS NULL
          AND s.unit ILIKE 'kwh'
        ORDER BY (s.type = 'FIXED') DESC, s.unit_price
        LIMIT 1
      )
    ) ORDER BY b.name) AS j
    FROM public.buildings b
    WHERE b.id IN (SELECT building_id FROM bld_ids)
  ),
  areas_j AS (
    SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.name) AS j
    FROM public.areas a
    WHERE a.user_id = v_owner AND a.deleted_at IS NULL
  ),
  contact_j AS (
    SELECT jsonb_build_object('name', h.name, 'phone', h.phone_number) AS j
    FROM public.hotlines h
    WHERE h.user_id = v_owner
      AND COALESCE(h.is_active, true) = true
      AND (v_hotline IS NULL OR h.id = v_hotline)
    ORDER BY (h.id = v_hotline) DESC NULLS LAST, h.created_at
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'areas',     COALESCE((SELECT j FROM areas_j), '[]'::jsonb),
    'buildings', COALESCE((SELECT j FROM blds_j), '[]'::jsonb),
    'rooms',     COALESCE((SELECT j FROM rooms_j), '[]'::jsonb),
    'contact',   (SELECT j FROM contact_j)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

-- public.manager_collection_cycle_report  (2 chỗ)
CREATE OR REPLACE FUNCTION public.manager_collection_cycle_report(p_manager_id uuid DEFAULT NULL::uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mgr        uuid;
  v_mgr_name   text;
  v_full       boolean;
  v_bids       uuid[];
  v_billed     numeric;
  v_outstanding numeric;
  v_collected_all numeric;
  v_collected_period numeric;
  v_handed     numeric;
  v_buildings  jsonb;
  v_timeline   jsonb := '[]'::jsonb;
  v_prev       date;
  v_this       date;
  v_seg        numeric;
  v_ar         numeric;
  rec          record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  v_mgr := COALESCE(p_manager_id, auth.uid());
  IF v_mgr <> auth.uid() AND NOT (public.is_super_admin() OR public.is_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền xem báo cáo của người khác';
  END IF;
  p_from := COALESCE(p_from, date_trunc('month', public.org_today_v1(NULL))::date);
  p_to   := COALESCE(p_to, public.org_today_v1(NULL));

  SELECT COALESCE(full_name, '') INTO v_mgr_name FROM profiles WHERE id = v_mgr;

  -- ── Phạm vi tòa của quản lý ──
  v_full := EXISTS (SELECT 1 FROM staff_assignments sa
                     WHERE sa.staff_id = v_mgr AND sa.building_id IS NULL AND sa.area_id IS NULL)
            OR EXISTS (SELECT 1 FROM super_admins s WHERE s.user_id = v_mgr);
  IF v_full THEN
    v_bids := ARRAY(SELECT id FROM buildings WHERE deleted_at IS NULL);
  ELSE
    v_bids := ARRAY(
      SELECT DISTINCT bid FROM (
        SELECT sa.building_id AS bid FROM staff_assignments sa
         WHERE sa.staff_id = v_mgr AND sa.building_id IS NOT NULL
        UNION
        SELECT ab.building_id FROM staff_assignments sa
          JOIN area_buildings ab ON ab.area_id = sa.area_id
         WHERE sa.staff_id = v_mgr AND sa.area_id IS NOT NULL
      ) x WHERE bid IS NOT NULL
    );
  END IF;
  -- Chỉ giữ tòa THẬT còn tồn tại (bỏ assignment trỏ tòa đã xóa/mồ côi + tòa ảo "Chung").
  v_bids := ARRAY(SELECT b.id FROM buildings b
                   WHERE b.id = ANY(v_bids) AND b.deleted_at IS NULL
                     AND NOT COALESCE(b.is_virtual, false));
  IF v_bids IS NULL THEN v_bids := ARRAY[]::uuid[]; END IF;

  -- ── Tổng hiện tại (chỉ HĐ đã chốt: bỏ DRAFT/PENDING/CANCELLED) ──
  SELECT COALESCE(sum(total_amount), 0), COALESCE(sum(remaining_amount), 0), COALESCE(sum(paid_amount), 0)
    INTO v_billed, v_outstanding, v_collected_all
    FROM invoices
   WHERE building_id = ANY(v_bids) AND deleted_at IS NULL
     AND status NOT IN ('DRAFT','PENDING_APPROVAL','CANCELLED');

  -- ── Đã thu trong kỳ (public.active_payments của tòa) ──
  SELECT COALESCE(sum(p.collected_amount), 0) INTO v_collected_period
    FROM (
      SELECT * FROM public.payment_receipt_events
      WHERE payment_method <> 'CT'
    ) p JOIN invoices i ON i.id = p.invoice_id
   WHERE i.building_id = ANY(v_bids) AND i.deleted_at IS NULL
     AND p.payment_date BETWEEN p_from AND p_to;

  -- ── Đã bàn giao trong kỳ (net, giver = quản lý) ──
  SELECT COALESCE(sum(total_amount), 0) INTO v_handed
    FROM cash_handovers
   WHERE giver_id = v_mgr AND status = 'CONFIRMED'
     AND confirmed_at::date BETWEEN p_from AND p_to;

  -- ── Theo từng tòa (hiện tại) ──
  SELECT jsonb_agg(jsonb_build_object(
           'building_id', b.id, 'name', b.name,
           'total_billed', bs.billed, 'collected', bs.paid,
           'outstanding', bs.remaining, 'unpaid_count', bs.unpaid
         ) ORDER BY bs.remaining DESC NULLS LAST, b.name)
    INTO v_buildings
    FROM buildings b
    JOIN LATERAL (
      SELECT COALESCE(sum(i.total_amount), 0) AS billed,
             COALESCE(sum(i.paid_amount), 0) AS paid,
             COALESCE(sum(i.remaining_amount), 0) AS remaining,
             count(*) FILTER (WHERE i.remaining_amount > 0) AS unpaid
        FROM invoices i
       WHERE i.building_id = b.id AND i.deleted_at IS NULL
         AND i.status NOT IN ('DRAFT','PENDING_APPROVAL','CANCELLED')
    ) bs ON true
   WHERE b.id = ANY(v_bids) AND b.deleted_at IS NULL;

  -- ── Timeline: từng mốc bàn giao (tăng dần) + chốt CHƯA THU point-in-time ──
  v_prev := p_from - 1;   -- để đoạn đầu = [p_from, mốc1]
  FOR rec IN
    SELECT ch.code, ch.confirmed_at, ch.total_amount AS net, fa.name AS from_account
      FROM cash_handovers ch
      LEFT JOIN accounts fa ON fa.id = ch.from_account_id
     WHERE ch.giver_id = v_mgr AND ch.status = 'CONFIRMED'
       AND ch.confirmed_at::date BETWEEN p_from AND p_to
     ORDER BY ch.confirmed_at ASC
  LOOP
    v_this := rec.confirmed_at::date;
    SELECT COALESCE(sum(p.collected_amount), 0) INTO v_seg
      FROM (
        SELECT * FROM public.payment_receipt_events
        WHERE payment_method <> 'CT'
      ) p JOIN invoices i ON i.id = p.invoice_id
     WHERE i.building_id = ANY(v_bids) AND i.deleted_at IS NULL
       AND p.payment_date > v_prev AND p.payment_date <= v_this;
    -- Chưa thu TẠI NGÀY v_this: HĐ tồn tại (issue_date ≤ v_this), trừ public.active_payments ≤ v_this.
    -- Cộng RÒNG (không floor 0) để đồng quy ước với remaining_amount ("chưa thu hiện tại"):
    -- HĐ trả dư cấn trừ HĐ nợ khác, khớp cách app tính công nợ.
    SELECT COALESCE(sum(i.total_amount - COALESCE(pp.paid, 0)), 0) INTO v_ar
      FROM invoices i
      LEFT JOIN LATERAL (
        SELECT sum(p.applied_amount) AS paid
        FROM public.payment_receipt_events p
         WHERE p.invoice_id = i.id AND p.payment_date <= v_this
      ) pp ON true
     WHERE i.building_id = ANY(v_bids) AND i.deleted_at IS NULL
       AND i.status NOT IN ('DRAFT','PENDING_APPROVAL','CANCELLED')
       AND i.issue_date <= v_this;
    v_timeline := v_timeline || jsonb_build_object(
      'type', 'HANDOVER', 'code', rec.code, 'confirmed_at', rec.confirmed_at,
      'net', rec.net, 'from_account', rec.from_account,
      'collected_in_segment', v_seg, 'outstanding_as_of', v_ar);
    v_prev := v_this;
  END LOOP;

  -- ── Đoạn hiện tại (từ mốc cuối → p_to) ──
  SELECT COALESCE(sum(p.collected_amount), 0) INTO v_seg
      FROM (
        SELECT * FROM public.payment_receipt_events
        WHERE payment_method <> 'CT'
      ) p JOIN invoices i ON i.id = p.invoice_id
   WHERE i.building_id = ANY(v_bids) AND i.deleted_at IS NULL
     AND p.payment_date > v_prev AND p.payment_date <= p_to;
  v_timeline := v_timeline || jsonb_build_object(
    'type', 'CURRENT', 'confirmed_at', NULL, 'code', NULL, 'net', NULL, 'from_account', NULL,
    'collected_in_segment', v_seg, 'outstanding_as_of', v_outstanding);

  RETURN jsonb_build_object(
    'manager', jsonb_build_object('id', v_mgr, 'name', v_mgr_name),
    'from', p_from, 'to', p_to,
    'building_count', COALESCE(array_length(v_bids, 1), 0),
    'summary', jsonb_build_object(
      'collected_period', v_collected_period,
      'handed_over_period', v_handed,
      'outstanding_current', v_outstanding,
      'total_billed_current', v_billed,
      'collected_all', v_collected_all),
    'buildings', COALESCE(v_buildings, '[]'::jsonb),
    'timeline', v_timeline);
END;
$function$;

-- public.mark_overdue_invoices_v1  (1 chỗ)
CREATE OR REPLACE FUNCTION public.mark_overdue_invoices_v1()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_count integer;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  update public.invoices i
     set status = 'OVERDUE'
   where i.deleted_at is null
     and i.status in ('APPROVED', 'PARTIAL_PAID')
     and i.due_date < public.org_today_v1(NULL)
     and app_private.can_edit_invoice_building_v1(i.building_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

-- public.pay_period_fee  (1 chỗ)
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

  -- ── CHỐNG ĐÓNG TRÙNG: đã có phiếu APPROVED cùng hạng mục giao kỳ? ──
  -- Slice −1: phép ĐO chạy luôn, kể cả khi p_force — sổ vết phải ghi được
  -- "ghi đè lên mấy phiếu, tổng bao nhiêu". Trước đây cả khối này nằm trong
  -- IF NOT p_force nên "Đóng thêm" đi qua trong bóng tối.
  -- (Chưa mở rộng sang UNAPPROVED ở slice này — xem ghi chú đầu file.)
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
                               AND ie.approval_status = 'APPROVED'
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
    SELECT id INTO v_acc FROM accounts
     WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'
     ORDER BY is_default DESC NULLS LAST, name LIMIT 1;
    IF v_acc IS NULL THEN
      RAISE EXCEPTION 'Bạn chưa có sổ quỹ "…Thu" để chi tiền';
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
     p_amount, 'APPROVED', TRUE,
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
     round(p_amount / GREATEST(v_months, 1)), v_acc, v_owner)
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

  SELECT code, total_amount INTO v_code, v_total FROM income_expenses WHERE id = v_voucher;

  RETURN jsonb_build_object(
    'voucher_id', v_voucher, 'code', v_code,
    'total_amount', v_total, 'account_id', v_acc);
END;
$function$;

-- public.pay_utility_bill  (1 chỗ)
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
  v_kind_vn text;        -- Slice −1: "điện"/"nước" cho câu lỗi
  v_dup_code   text;     -- Slice −1 B1: phiếu đã có của đúng slot này
  v_dup_amount numeric;
  v_dup_status text;
  v_meter_code text;     -- Slice −1 B1: mã khách hàng của công tơ ĐANG chọn
  v_meter_cnt  int;      -- Slice −1 B1: số công tơ cùng loại của toà (>1 thì gợi ý chọn lại)
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
  SELECT c.threshold INTO v_threshold
    FROM app_private.ie_auto_approve_config c WHERE c.organization_id = v_org;
  IF v_threshold IS NOT NULL AND p_amount >= v_threshold THEN
    v_status := 'UNAPPROVED'; v_appr_by := NULL; v_appr_at := NULL;
  ELSE
    v_status := 'APPROVED'; v_appr_by := auth.uid(); v_appr_at := now();
  END IF;

  v_type_nm := CASE WHEN p_utility_type = 'ELECTRIC' THEN 'Đóng tiền điện' ELSE 'Đóng tiền nước' END;
  v_type := public._termination_ensure_type(v_owner, 'expense', v_type_nm);
  UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type AND is_deposit IS DISTINCT FROM FALSE;

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

  SELECT code, total_amount INTO v_code, v_total FROM income_expenses WHERE id = v_voucher;
  RETURN jsonb_build_object('voucher_id', v_voucher, 'code', v_code,
    'total_amount', v_total, 'account_id', v_acc, 'utility_account_id', v_meter);
END;
$function$;

-- public.propose_cashbook_closing_v1  (1 chỗ)
CREATE OR REPLACE FUNCTION public.propose_cashbook_closing_v1(p_cashbook uuid, p_counted_balance numeric, p_confirmer uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_membership uuid;
  v_today date := public.org_today_v1(NULL);
  v_system numeric;
  v_blockers text;
  v_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  IF p_counted_balance = 'NaN'::numeric THEN
    RAISE EXCEPTION 'Số tiền đếm không hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF p_counted_balance IS NULL THEN
    RAISE EXCEPTION 'Phải nhập số tiền thực đếm' USING ERRCODE = '22023';
  END IF;
  IF p_confirmer IS NULL OR p_confirmer = v_actor THEN
    RAISE EXCEPTION 'Phải chọn NGƯỜI KHÁC để xác nhận nhận bàn giao — chốt sổ cần cả hai bên.'
      USING ERRCODE = '22023';
  END IF;

  -- FOR UPDATE trên sổ: đua với trigger khoá của Đợt 3 (nó giữ FOR KEY SHARE
  -- khi ghi phiếu), nên phiếu đang chèn dở sẽ đụng độ thật thay vì lọt vào kỳ
  -- vừa bị đóng băng.
  SELECT a.organization_id INTO v_org
  FROM public.accounts a WHERE a.id = p_cashbook AND a.deleted_at IS NULL FOR UPDATE;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Không tìm thấy sổ quỹ' USING ERRCODE = '42501'; END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_org);

  SELECT m.id INTO v_membership FROM public.organization_memberships m
   WHERE m.user_id = v_actor AND m.organization_id = v_org AND m.status = 'ACTIVE' LIMIT 1;

  IF NOT public.is_super_admin() THEN
    IF NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
         v_actor, v_org, 'cashbooks.close', NULL, p_cashbook)), false) THEN
      RAISE EXCEPTION 'Không có quyền đề nghị chốt sổ quỹ này' USING ERRCODE = '42501';
    END IF;
    -- Người ĐANG GIỮ sổ mới đếm được tiền trong két.
    PERFORM app_private.assert_cashbook_access_v2(v_org, p_cashbook, 'CUSTODIAN', v_membership);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
     WHERE m.user_id = p_confirmer AND m.organization_id = v_org AND m.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Người xác nhận không thuộc tổ chức này' USING ERRCODE = '22023';
  END IF;
  IF NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
       p_confirmer, v_org, 'cashbooks.close_confirm', NULL, p_cashbook)), false) THEN
    RAISE EXCEPTION 'Người được chọn không có quyền xác nhận nhận bàn giao sổ này'
      USING ERRCODE = '42501';
  END IF;

  SELECT string_agg(b.detail, ' | ') INTO v_blockers
  FROM public.cashbook_closing_blockers_v1(p_cashbook) b WHERE b.blocking;
  IF v_blockers IS NOT NULL THEN
    RAISE EXCEPTION 'Chưa chốt được: %', v_blockers USING ERRCODE = '55000';
  END IF;

  -- closed_through ÉP = HÔM NAY. Đếm tiền là đếm BÂY GIỜ; đem so với số dư một
  -- ngày quá khứ thì phần chênh chính là giao dịch ở giữa, và hệ thống sẽ ghi
  -- nhầm thành thừa/thiếu quỹ rồi khoá vĩnh viễn con số sai đó.
  v_system := app_private.cashbook_balance_as_of_v1(p_cashbook, v_today);

  INSERT INTO app_private.cashbook_closure_requests
    (organization_id, cashbook_id, closed_through, counted_balance, system_balance,
     note, proposed_by, proposed_by_membership, confirmer_user_id)
  VALUES
    (v_org, p_cashbook, v_today, round(p_counted_balance, 2), round(v_system, 2),
     nullif(btrim(COALESCE(p_note, '')), ''), v_actor, v_membership, p_confirmer)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'request_id', v_id,
    'cashbook_id', p_cashbook,
    'closed_through', v_today,
    'counted_balance', round(p_counted_balance, 2),
    'system_balance', round(v_system, 2),
    'difference', round(p_counted_balance - v_system, 2),
    'basis', 'POSTING_TRUTH_BY_POSTED_ON',
    'status', 'PENDING'
  );
END
$function$;

-- public.recompute_invoice_for_id  (4 chỗ)
CREATE OR REPLACE FUNCTION public.recompute_invoice_for_id(p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total numeric(15,2);
  v_paid numeric(15,2);
  v_rounding numeric(15,2);
  v_legacy_rounding numeric(15,2);
  v_legacy_refunded numeric(15,2);
  v_settlement_refunded numeric(15,2);
  v_has_v5_payment boolean;
  v_existing_status public.invoice_status;
  v_status public.invoice_status;
  v_paid_date date;
  v_due_date date;
  v_carried_raw numeric(15,2);
  v_carried numeric(15,2);
BEGIN
  IF p_invoice_id IS NULL THEN
    RETURN;
  END IF;

  SELECT total_amount, status, due_date
    INTO v_total, v_existing_status, v_due_date
  FROM public.invoices
  WHERE id = p_invoice_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COALESCE(sum(amount), 0), max(payment_date),
         COALESCE(sum(rounding_amount), 0),
         COALESCE(bool_or(collection_id IS NOT NULL), false)
    INTO v_paid, v_paid_date, v_rounding, v_has_v5_payment
  FROM public.payments
  WHERE invoice_id = p_invoice_id
    AND reversed_at IS NULL;

  -- Legacy writers stored cash change as a separate expense while keeping the
  -- gross amount in payments. V5 payments already store only the applied
  -- amount, so subtract change only from pre-collection vouchers.
  SELECT COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)), 0)
    INTO v_legacy_refunded
  FROM public.income_expenses voucher
  JOIN public.income_expense_items item
    ON item.income_expense_id = voucher.id
  JOIN public.income_expense_types type_row
    ON type_row.id = item.income_expense_type_id
  WHERE voucher.invoice_id = p_invoice_id
    AND voucher.payment_collection_id IS NULL
    AND voucher.type = 'EXPENSE'
    AND voucher.approval_status = 'APPROVED'
    AND voucher.deleted_at IS NULL
    AND lower(btrim(type_row.name)) = 'tiền thối';

  v_paid := v_paid - v_legacy_refunded;

  SELECT COALESCE(sum(voucher.rounding_amount), 0)
    INTO v_legacy_rounding
  FROM public.income_expenses voucher
  WHERE voucher.invoice_id = p_invoice_id
    AND voucher.payment_collection_id IS NULL
    AND voucher.type = 'INCOME'
    AND voucher.approval_status = 'APPROVED'
    AND voucher.deleted_at IS NULL;

  SELECT COALESCE(sum(voucher.total_amount), 0)
    INTO v_settlement_refunded
  FROM public.income_expenses voucher
  WHERE voucher.invoice_id = p_invoice_id
    AND voucher.type = 'EXPENSE'
    AND voucher.approval_status = 'APPROVED'
    AND voucher.deleted_at IS NULL
    AND voucher.notes LIKE '[Hoàn trả thanh lý]%';

  v_paid := v_paid - v_settlement_refunded;
  v_rounding := v_rounding + v_legacy_rounding;

  IF v_existing_status = 'CANCELLED' THEN
    UPDATE public.invoices
       SET paid_amount = v_paid
     WHERE id = p_invoice_id;
    RETURN;
  END IF;
  -- [B1] Phan cong no da duoc hoa don SAU ganh ho (previous_debt_sources).
  -- Truoc day settle_previous_debt_sources ghi THANG paid_amount/status len hoa
  -- don nguon ma khong tao dong payments; ham nay lai DAN XUAT paid_amount tu
  -- payments, nen moi lan recompute chay lai la khoan no da tra SONG DAY.
  -- Nay suy ra tai cho: nguon su that duy nhat van la ham nay.
  --
  -- Dat SAU nhanh CANCELLED: hoa don da huy khong phai cong no; cong vao do se
  -- day paid_amount vuot total va de ra khoan "thu thua" ao.
  SELECT COALESCE(sum((src->>'amount')::numeric), 0)
    INTO v_carried_raw
  FROM public.invoices carrier
  CROSS JOIN LATERAL jsonb_array_elements(carrier.previous_debt_sources) AS src
  WHERE carrier.deleted_at IS NULL
    AND carrier.status = 'PAID'
    AND carrier.id <> p_invoice_id
    AND jsonb_typeof(carrier.previous_debt_sources) = 'array'
    AND src->>'type' = 'invoice'
    AND NULLIF(src->>'id', '') IS NOT NULL
    AND (src->>'id')::uuid = p_invoice_id;

  -- CHAN TREN bat buoc: so trong previous_debt_sources[].amount la ANH CHUP du
  -- no luc phat hanh hoa don ganh. Neu sau do khach tra them truc tiep vao hoa
  -- don nguon, cong thang se vuot total va tao hoan tien ao. Phan suy ra chi
  -- duoc LAP DAY khoang thieu, khong bao gio vuot.
  -- COALESCE la load-bearing: LEAST(NULL, gap) trong Postgres tra ve gap.
  v_carried := LEAST(COALESCE(v_carried_raw, 0), GREATEST(v_total - v_paid, 0));
  v_paid := v_paid + v_carried;

  IF v_total > 0 THEN
    IF v_paid >= v_total OR v_paid + v_rounding >= v_total
       OR (
         NOT v_has_v5_payment
         AND v_paid > 0
         AND v_total - v_paid > 0
         AND v_total - v_paid < 10000
       ) THEN
      v_status := 'PAID';
    ELSIF v_paid > 0 AND v_due_date < public.org_today_v1(NULL) THEN
      v_status := 'OVERDUE';
      v_paid_date := NULL;
    ELSIF v_paid > 0 THEN
      v_status := 'PARTIAL_PAID';
      v_paid_date := NULL;
    ELSIF v_due_date < public.org_today_v1(NULL) THEN
      v_status := 'OVERDUE';
      v_paid_date := NULL;
    ELSE
      v_status := 'APPROVED';
      v_paid_date := NULL;
    END IF;
  ELSIF v_total < 0 THEN
    IF v_paid <= v_total THEN
      v_status := 'PAID';
    ELSIF v_paid < 0 AND v_due_date < public.org_today_v1(NULL) THEN
      v_status := 'OVERDUE';
      v_paid_date := NULL;
    ELSIF v_paid < 0 THEN
      v_status := 'PARTIAL_PAID';
      v_paid_date := NULL;
    ELSIF v_due_date < public.org_today_v1(NULL) THEN
      v_status := 'OVERDUE';
      v_paid_date := NULL;
    ELSE
      v_status := 'APPROVED';
      v_paid_date := NULL;
    END IF;
  ELSE
    v_status := CASE
      WHEN v_paid <> 0 THEN 'PAID'::public.invoice_status
      ELSE 'APPROVED'::public.invoice_status
    END;
    IF v_paid = 0 THEN
      v_paid_date := NULL;
    END IF;
  END IF;

  UPDATE public.invoices
     SET paid_amount = v_paid,
         status = v_status,
         paid_date = v_paid_date,
         updated_at = now()
   WHERE id = p_invoice_id;
END;
$function$;

-- public.renew_contract_impl  (1 chỗ)
CREATE OR REPLACE FUNCTION public.renew_contract_impl(p_contract_id uuid, p_new_end_date date, p_new_rent_price numeric DEFAULT NULL::numeric, p_new_deposit numeric DEFAULT NULL::numeric, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract RECORD;
  v_months   int;
BEGIN
  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;

  IF v_contract.status NOT IN ('ACTIVE', 'EXTENDED') THEN
    RAISE EXCEPTION 'Chỉ gia hạn được hợp đồng đang hiệu lực (status hiện tại: %)', v_contract.status;
  END IF;

  IF p_new_end_date IS NULL OR p_new_end_date <= v_contract.end_date THEN
    RAISE EXCEPTION 'Ngày kết thúc mới phải sau ngày kết thúc hiện tại (%)', v_contract.end_date;
  END IF;

  -- Gia hạn = CẬP NHẬT tại chỗ; GIỮ status='ACTIVE' (không đổi EXTENDED).
  UPDATE contracts
     SET end_date     = p_new_end_date,
         rent_price   = COALESCE(p_new_rent_price, rent_price),
         total_deposit= COALESCE(p_new_deposit,    total_deposit),
         notes        = CASE
                          WHEN p_notes IS NULL OR length(btrim(p_notes)) = 0 THEN notes
                          WHEN notes  IS NULL OR length(btrim(notes))  = 0 THEN p_notes
                          ELSE notes || E'\n[Gia hạn] ' || p_notes
                        END,
         updated_at   = NOW()
   WHERE id = p_contract_id;

  -- Số tháng gia hạn (cột extension_months NOT NULL), tối thiểu 1.
  v_months := GREATEST(1, (EXTRACT(YEAR  FROM age(p_new_end_date, v_contract.end_date)) * 12
                         + EXTRACT(MONTH FROM age(p_new_end_date, v_contract.end_date)))::int);

  -- Bản ghi gia hạn = NGUỒN SỰ THẬT của "đã gia hạn" (KHÔNG nuốt lỗi).
  INSERT INTO contract_extensions (
    user_id, contract_id, extension_type, extension_date,
    old_end_date, new_end_date, extension_months,
    new_rent_price, rent_price_changed,
    new_deposit,    deposit_changed,
    notes, status
  ) VALUES (
    v_contract.user_id, p_contract_id, 'UPDATE_EXISTING', public.org_today_v1(NULL),
    v_contract.end_date, p_new_end_date, v_months,
    p_new_rent_price, (p_new_rent_price IS NOT NULL AND p_new_rent_price <> v_contract.rent_price),
    p_new_deposit,    (p_new_deposit    IS NOT NULL AND p_new_deposit    <> v_contract.total_deposit),
    p_notes, 'COMPLETED'
  );

  RETURN p_contract_id;
END;
$function$;

-- public.terminate_contract_forfeit_impl  (1 chỗ)
CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit_impl(p_contract_id uuid, p_forfeit_date date, p_extra_charges jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract       RECORD;
  v_building_id    uuid;
  v_invoice_id     uuid;
  v_extra_inv      uuid;
  v_extra          numeric(15,2) := 0;
  v_deposit        numeric(15,2);
  v_billing        text;
  v_cnumber        text;
  v_marker         text;
  v_acc_int        uuid;
  v_type_off       uuid;
  v_type_inc       uuid;
  v_chi_id         uuid;
  v_thu_id         uuid;
  v_kept_paid      numeric(15,2);
  v_paid_cnt       integer;
  v_unpaid_cnt     integer;
  v_cancelled_cnt  integer;
BEGIN
  SELECT * INTO v_contract
    FROM contracts
   WHERE id = p_contract_id
     AND deleted_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;
  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN
    RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn';
  END IF;
  IF v_contract.room_id IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý';
  END IF;
  IF p_forfeit_date < v_contract.start_date THEN
    RAISE EXCEPTION 'Ngày bỏ cọc (%) không được trước ngày bắt đầu hợp đồng (%)',
      to_char(p_forfeit_date,'DD/MM/YYYY'), to_char(v_contract.start_date,'DD/MM/YYYY');
  END IF;
  SELECT building_id INTO v_building_id FROM rooms WHERE id = v_contract.room_id;
  IF v_building_id IS NULL THEN
    RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng';
  END IF;

  -- Cọc forfeit = cọc THỰC đã thu (nguồn sự thật: contracts.deposit_paid).
  -- [A9] Cọc đã thu > cọc theo hợp đồng ⇒ DỪNG, không đoán.
  -- Công thức LEAST() bên dưới lấy số NHỎ hơn, nên khi ô "Tiền cọc" trên hợp
  -- đồng khai 0 mà thực đã thu (vd HĐT-062953: 0 / 4.000.000) thì v_deposit = 0
  -- và TOÀN BỘ khối doanh thu bị bỏ qua trong im lặng: không hoá đơn, không
  -- phiếu, 0đ doanh thu trên tiền đang giữ trong két.
  --
  -- KHÔNG sửa thành COALESCE(deposit_paid,0): đo được 3/4 hợp đồng dôi ra là do
  -- phiếu "[Accounting repair] Contract deposit" ĐẾM TRÙNG với phiếu thu cọc
  -- tường minh (2.000.000 + 1.500.000 + 300.000 = 3.800.000đ). Lấy thẳng
  -- deposit_paid sẽ ghi KHỐNG đúng số đó vào KQKD rồi chảy sang chia lợi nhuận.
  IF COALESCE(v_contract.deposit_paid, 0) > COALESCE(v_contract.total_deposit, 0) THEN
    RAISE EXCEPTION 'Không thanh lý được: cọc ĐÃ THU (% đ) lớn hơn cọc THEO HỢP ĐỒNG (% đ), dôi % đ. Hệ thống không tự đoán số nào đúng. Hãy kiểm tra sổ cọc của hợp đồng: nếu có phiếu cọc bị ĐẾM TRÙNG thì huỷ/điều chỉnh phiếu đó; nếu ô "Tiền cọc" trên hợp đồng khai thiếu thì sửa lại cho khớp số THỰC NHẬN. Đừng nâng "Tiền cọc" chỉ để chạy được lệnh — làm vậy sẽ ghi khống phần dôi thành doanh thu.',
      round(COALESCE(v_contract.deposit_paid, 0))::bigint,
      round(COALESCE(v_contract.total_deposit, 0))::bigint,
      round(COALESCE(v_contract.deposit_paid,0) - COALESCE(v_contract.total_deposit,0))::bigint
      USING ERRCODE = '55000';
  END IF;
  v_deposit := LEAST(COALESCE(v_contract.total_deposit, 0), COALESCE(v_contract.deposit_paid, 0));
  v_billing := to_char(COALESCE(p_forfeit_date, public.org_today_v1(NULL)), 'YYYY-MM');
  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_marker  := '[CẤN CỌC BỎ CỌC ' || p_contract_id::text || ']';

  v_acc_int := public._internal_settlement_account(v_contract.user_id);

  SELECT COALESCE(SUM(paid_amount), 0)
    INTO v_kept_paid
    FROM invoices
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN ('APPROVED','OVERDUE','PARTIAL_PAID')
     AND COALESCE(paid_amount, 0) > 0;

  UPDATE invoices
     SET status       = 'CANCELLED',
         total_amount = COALESCE(paid_amount, 0),
         notes        = CASE
                        WHEN notes IS NULL OR length(btrim(notes)) = 0
                          THEN '[Huỷ — thanh lý bỏ cọc ngày '
                               || to_char(p_forfeit_date,'DD/MM/YYYY')
                               || '; giữ lại ' || round(COALESCE(paid_amount,0))::bigint
                               || 'đ đã thu làm doanh thu, huỷ phần nợ '
                               || round(COALESCE(remaining_amount,0))::bigint || 'đ]'
                        ELSE notes
                             || E'\n[Huỷ — thanh lý bỏ cọc ngày '
                             || to_char(p_forfeit_date,'DD/MM/YYYY')
                             || '; giữ lại ' || round(COALESCE(paid_amount,0))::bigint
                             || 'đ đã thu làm doanh thu, huỷ phần nợ '
                             || round(COALESCE(remaining_amount,0))::bigint || 'đ]'
                      END,
         updated_at = NOW()
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN ('APPROVED','OVERDUE','PARTIAL_PAID')
     AND COALESCE(paid_amount, 0) > 0;
  GET DIAGNOSTICS v_paid_cnt = ROW_COUNT;

  UPDATE invoices
     SET status       = 'CANCELLED',
         total_amount = 0,
         notes        = CASE
                        WHEN notes IS NULL OR length(btrim(notes)) = 0
                          THEN '[Huỷ tự động — thanh lý bỏ cọc ngày '
                               || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                        ELSE notes
                             || E'\n[Huỷ tự động — thanh lý bỏ cọc ngày '
                             || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                      END,
         updated_at   = NOW()
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN ('APPROVED','OVERDUE','PARTIAL_PAID')
     AND COALESCE(paid_amount, 0) = 0;
  GET DIAGNOSTICS v_unpaid_cnt = ROW_COUNT;

  v_cancelled_cnt := COALESCE(v_paid_cnt, 0) + COALESCE(v_unpaid_cnt, 0);

  IF v_deposit > 0 THEN
    -- v4: hoá đơn bù cọc mang ĐÚNG kỳ tháng bỏ cọc (kind='SETTLEMENT' —
    -- partial unique không còn chặn; thôi mượn slot tháng trống).
    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id,
      kind, billing_month, issue_date, due_date,
      status, subtotal, discount_amount, total_amount,
      notes
    ) VALUES (
      v_contract.user_id, p_contract_id,
      v_building_id, v_contract.room_id,
      'SETTLEMENT', v_billing, p_forfeit_date, p_forfeit_date,
      'APPROVED'::invoice_status, v_deposit, 0, v_deposit,
      'Hoá đơn thanh lý — khách bỏ cọc ngày ' || to_char(p_forfeit_date,'DD/MM/YYYY')
        || CASE WHEN v_cancelled_cnt > 0
                  THEN E'\n(Đã huỷ ' || v_cancelled_cnt || ' hoá đơn còn nợ'
                       || CASE WHEN v_kept_paid > 0
                                 THEN '; giữ lại ' || round(v_kept_paid)::bigint
                                      || 'đ đã thu làm doanh thu'
                                 ELSE '' END
                       || ')'
                  ELSE '' END
    )
    RETURNING id INTO v_invoice_id;

    INSERT INTO invoice_items (
      invoice_id, type, description,
      unit_price, quantity, coefficient, amount, sort_order
    ) VALUES (
      v_invoice_id, 'PENALTY',
      'Phí phạt khách bỏ cọc (giữ tiền cọc đã thu)',
      v_deposit, 1, 1, v_deposit, 1
    );

    -- Cặp bút toán nội bộ TỰ DUYỆT — CẢ 2 CHÂN trên sổ nội bộ (net 0).
    v_type_off := public._termination_ensure_type(v_contract.user_id, 'expense', 'Cấn cọc chuyển doanh thu');
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu bỏ cọc');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', 'Cấn cọc bỏ cọc → chuyển doanh thu — HĐ ' || v_cnumber,
            v_building_id, v_contract.room_id, p_contract_id, v_acc_int, p_forfeit_date, v_deposit, 'UNAPPROVED',
            v_marker || ' Bút toán nội bộ: cọc khách bỏ chuyển thành doanh thu (tự duyệt; không phải tiền thật — không vào sổ quỹ).',
            'termination.forfeit_offset')
    RETURNING id INTO v_chi_id;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_chi_id, v_type_off, 'Cấn cọc bỏ cọc chuyển doanh thu', 1, v_deposit, p_forfeit_date, p_forfeit_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'INCOME', 'Doanh thu bỏ cọc — HĐ ' || v_cnumber,
            v_building_id, v_contract.room_id, p_contract_id, v_acc_int, v_invoice_id, p_forfeit_date, v_deposit, 'UNAPPROVED',
            v_marker || ' Bút toán nội bộ: doanh thu bỏ cọc (tự duyệt → tất toán hoá đơn thanh lý; KQKD đếm theo hạng mục).',
            'termination.forfeit_revenue')
    RETURNING id INTO v_thu_id;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_thu_id, v_type_inc, 'Doanh thu bỏ cọc (cọc khách bỏ)', 1, v_deposit, p_forfeit_date, p_forfeit_date);

    -- 7af: cặp bút toán nội bộ TỰ DUYỆT ngay trong writer (hướng A).
    -- Đóng dấu bản chất trước — Finance V2 hết coi đây là phiếu tiền thật.
    -- 7b1: review_state đi CÙNG cú duyệt, KHÔNG đi trước. Ở nhịp này cả 2
    -- chân còn UNAPPROVED, mà ie_unapproved_review_state_ck cấm cặp
    -- (UNAPPROVED, RESOLVED) — đặt ở đây là 23514, chặn cứng thanh lý.
    UPDATE public.income_expenses
       SET posting_mode   = 'NON_CASH',
           posting_status = 'NOT_APPLICABLE'
     WHERE id IN (v_chi_id, v_thu_id);

    -- Token cho CẢ HAI chân: chân doanh thu do lệnh dưới đổi, chân đối ứng do
    -- cascade trg_forfeit_settle_on_approve đổi — guard a05 đòi token từng phiếu.
    INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
    VALUES (v_thu_id, pg_current_xact_id(), 'APPROVED'),
           (v_chi_id, pg_current_xact_id(), 'APPROVED');

    -- Duyệt chân doanh thu → cascade duyệt chân đối ứng + tất toán hoá đơn.
    UPDATE public.income_expenses
       SET approval_status = 'APPROVED',
           approved_by     = COALESCE(auth.uid(), v_contract.user_id),
           approved_at     = now(),
           review_state    = 'RESOLVED',
           review_version  = income_expenses.review_version + 1
     WHERE id = v_thu_id;

    DELETE FROM app_private.ie_transition_authorization
     WHERE income_expense_id IN (v_thu_id, v_chi_id)
       AND xid = pg_current_xact_id();
  END IF;

  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(SUM((j->>'amount')::numeric), 0) INTO v_extra
      FROM jsonb_array_elements(p_extra_charges) AS t(j)
     WHERE (j->>'amount') IS NOT NULL AND (j->>'amount') <> ''
       AND (j->>'amount')::numeric > 0;
  END IF;

  IF v_extra > 0 THEN
    -- v4: hoá đơn thu thêm cũng mang ĐÚNG kỳ tháng bỏ cọc, kind='SETTLEMENT'.
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, kind, billing_month, issue_date, due_date, status, subtotal, discount_amount, total_amount, notes)
    VALUES (v_contract.user_id, p_contract_id, v_building_id, v_contract.room_id, 'SETTLEMENT', v_billing, p_forfeit_date, p_forfeit_date,
            'APPROVED'::invoice_status, 0, 0, 0,
            'Hoá đơn thu thêm khi thanh lý — khách bỏ cọc ngày ' || to_char(p_forfeit_date,'DD/MM/YYYY')
              || ' (thu riêng — không liên quan hoá đơn bù cọc).')
    RETURNING id INTO v_extra_inv;
    PERFORM public._termination_apply_extra_charges(v_extra_inv, p_extra_charges, p_forfeit_date, v_contract.user_id, p_contract_id);
    PERFORM public.recompute_invoice_for_id(v_extra_inv);
  END IF;

  UPDATE contracts
     SET status          = 'TERMINATED',
         actual_end_date = p_forfeit_date,
         notes           = CASE
                             WHEN notes IS NULL OR length(btrim(notes)) = 0
                               THEN '[Thanh lý — khách bỏ cọc ' || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                             ELSE notes || E'\n[Thanh lý — khách bỏ cọc ' || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                           END,
         updated_at      = NOW()
   WHERE id = p_contract_id;

  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date,
      termination_type,
      outstanding_debt, early_termination_fee, prorated_rent, prorated_days, prorated_services,
      total_deposit, status, approved_by, approved_at, notes
    ) VALUES (
      v_contract.user_id, p_contract_id, p_forfeit_date, p_forfeit_date,
      'FORFEIT',
      0, v_deposit, 0, 0, 0,
      v_deposit, 'COMPLETED', auth.uid(), NOW(),
      'Khách bỏ cọc — đã tạo phiếu thu "Doanh thu bỏ cọc" (chờ duyệt) cho phần cọc thực thu ' || round(v_deposit)::bigint || 'đ.'
        || CASE WHEN v_kept_paid > 0
                  THEN ' Đã giữ lại ' || round(v_kept_paid)::bigint
                       || 'đ đã thu làm doanh thu.'
                  ELSE '' END
        || CASE WHEN v_extra > 0
                  THEN ' Hoá đơn thu thêm riêng ' || round(v_extra)::bigint || 'đ (chờ thu).'
                  ELSE '' END
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'terminate_contract_forfeit_impl: audit insert failed for %: %', p_contract_id, SQLERRM;
  END;

  RETURN jsonb_build_object(
    'contract_id',                p_contract_id,
    'invoice_id',                 v_invoice_id,
    'settlement_invoice_id',      v_invoice_id,
    'extra_invoice_id',           v_extra_inv,
    'extra_charges_total',        v_extra,
    'forfeit_amount',             v_deposit,
    'cancelled_invoices',         v_cancelled_cnt,
    'kept_paid_amount',           v_kept_paid,
    'pending_income_voucher_id',  v_thu_id,
    'pending_expense_voucher_id', v_chi_id,
    'acc_internal',               v_acc_int
  );
END;
$function$;

-- public.terminate_contract_move_out_impl  (1 chỗ)
CREATE OR REPLACE FUNCTION public.terminate_contract_move_out_impl(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric DEFAULT 0, p_penalty_fee numeric DEFAULT 0, p_excess_rent numeric DEFAULT 0, p_outstanding_debt numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_extra_charges jsonb DEFAULT '[]'::jsonb, p_shortfall_mode text DEFAULT 'PAID'::text, p_receipt_account_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract  RECORD;
  v_building  uuid;
  v_acc_op    uuid;   -- sổ vận hành (fallback nhận tiền thật)
  v_acc_int   uuid;   -- sổ bút toán nội bộ (cả 2 chân cấn cọc)
  v_acc_rcpt  uuid;   -- sổ NHẬN "khách trả thêm" (tiền thật)
  v_billing   text;
  v_cnumber   text;
  v_deposit   numeric(15,2);
  v_penalty   numeric(15,2) := COALESCE(p_penalty_fee,    0);
  v_excess    numeric(15,2) := COALESCE(p_excess_rent,    0);
  v_debt      numeric(15,2) := COALESCE(p_outstanding_debt, 0);
  v_extra     numeric(15,2) := 0;
  v_charges   numeric(15,2);
  v_pool      numeric(15,2);
  v_applied   numeric(15,2);
  v_applied_dep numeric(15,2);
  v_refund_dep  numeric(15,2);
  v_refund_exc  numeric(15,2);
  v_S         numeric(15,2);
  v_budget    numeric(15,2);
  v_pay       numeric(15,2);
  v_settle_inv uuid;
  v_next_sort integer;
  v_type_inc  uuid;
  v_type_off  uuid;
  v_type_dep  uuid;
  v_type_excr uuid;
  v_voucher   uuid;
  v_refund_voucher uuid;
  v_breakdown text;
  rec         RECORD;
BEGIN
  IF p_shortfall_mode NOT IN ('PAID', 'DEBT') THEN
    RAISE EXCEPTION 'p_shortfall_mode phải là PAID hoặc DEBT';
  END IF;

  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hợp đồng không tồn tại'; END IF;
  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn'; END IF;
  IF v_contract.room_id IS NULL THEN RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý'; END IF;
  IF p_move_out_date < v_contract.start_date THEN
    RAISE EXCEPTION 'Ngày chuyển đi (%) không được trước ngày bắt đầu hợp đồng (%)',
      to_char(p_move_out_date,'DD/MM/YYYY'), to_char(v_contract.start_date,'DD/MM/YYYY');
  END IF;
  SELECT building_id INTO v_building FROM rooms WHERE id = v_contract.room_id;
  IF v_building IS NULL THEN RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng'; END IF;

  v_billing := to_char(COALESCE(p_move_out_date, public.org_today_v1(NULL)), 'YYYY-MM');
  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_acc_op  := public._termination_pick_account(v_contract.user_id, v_building);
  v_acc_int := public._internal_settlement_account(v_contract.user_id);

  -- Sổ NHẬN "khách trả thêm" (tiền thật): form chọn > sổ %Thu của người bấm > sổ vận hành toà.
  v_acc_rcpt := COALESCE(p_receipt_account_id, public._collector_thu_account(auth.uid()), v_acc_op);
  IF p_receipt_account_id IS NOT NULL THEN
    PERFORM 1 FROM accounts a WHERE a.id = p_receipt_account_id AND a.deleted_at IS NULL AND a.is_virtual = false;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ nhận tiền không hợp lệ (không tồn tại hoặc là sổ ảo)';
    END IF;
  END IF;

  -- A1: hoàn/cấn cọc tối đa bằng cọc THỰC THU (deposit_paid).
  v_deposit := LEAST(GREATEST(COALESCE(p_deposit_refund, 0), 0), COALESCE(v_contract.deposit_paid, 0));

  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(SUM((j->>'amount')::numeric), 0) INTO v_extra
      FROM jsonb_array_elements(p_extra_charges) AS t(j)
     WHERE (j->>'amount') IS NOT NULL AND (j->>'amount') <> ''
       AND (j->>'amount')::numeric > 0;
  END IF;

  v_charges     := v_debt + v_penalty + v_extra;
  v_pool        := v_deposit + v_excess;
  v_applied     := LEAST(v_pool, v_charges);
  v_applied_dep := LEAST(v_deposit, v_charges);
  v_refund_dep  := v_deposit - v_applied_dep;
  v_refund_exc  := v_excess - LEAST(v_excess, GREATEST(v_charges - v_deposit, 0));
  v_S           := v_pool - v_charges;

  v_breakdown :=
       'QUYẾT TOÁN THANH LÝ ' || to_char(p_move_out_date,'DD/MM/YYYY') || ' — HĐ ' || v_cnumber
    || E'\n• Cọc đã thu: ' || to_char(v_deposit, 'FM999G999G999G990') || 'đ'
    || E'\n• Khấu trừ: công nợ ' || to_char(v_debt, 'FM999G999G999G990') || 'đ'
    || CASE WHEN v_penalty > 0 THEN ' + phí phạt ' || to_char(v_penalty, 'FM999G999G999G990') || 'đ' ELSE '' END
    || CASE WHEN v_extra   > 0 THEN ' + thu thêm ' || to_char(v_extra, 'FM999G999G999G990') || 'đ' ELSE '' END
    || ' = ' || to_char(v_charges, 'FM999G999G999G990') || 'đ'
    || E'\n• Cọc cấn vào khấu trừ: ' || to_char(v_applied_dep, 'FM999G999G999G990') || 'đ (bút toán nội bộ, không đụng sổ tiền thật)'
    || CASE WHEN v_excess > 0 THEN E'\n• Tiền thừa (credit) áp dụng: ' || to_char(v_excess, 'FM999G999G999G990') || 'đ (cấn ' || to_char(v_excess - v_refund_exc, 'FM999G999G999G990') || 'đ, hoàn ' || to_char(v_refund_exc, 'FM999G999G999G990') || 'đ)' ELSE '' END
    || E'\n• Hoàn cọc lại khách: ' || to_char(v_refund_dep, 'FM999G999G999G990') || 'đ'
    || CASE WHEN v_S < 0 THEN E'\n• Khách còn phải trả: ' || to_char(-v_S, 'FM999G999G999G990') || 'đ ('
         || CASE WHEN p_shortfall_mode = 'PAID' THEN 'đã thu ngay khi thanh lý' ELSE 'GHI NỢ — chờ thu' END || ')'
       ELSE '' END
    || CASE WHEN v_refund_dep + v_refund_exc > 0 THEN E'\n• Tổng chi hoàn khách: ' || to_char(v_refund_dep + v_refund_exc, 'FM999G999G999G990') || 'đ (phiếu chi chờ duyệt — chọn sổ quỹ khi duyệt)' ELSE '' END;

  -- 1. HOÁ ĐƠN THANH LÝ RIÊNG (kind='SETTLEMENT', ĐÚNG kỳ tháng trả phòng).
  --    v4: KHÔNG đụng hoá đơn tháng nữa — dù nó chưa/đã PAID. Công nợ của nó
  --    vẫn được gạch ở bước 2 bằng payments 'CT' (không sửa nội dung hoá đơn).
  IF v_penalty > 0 OR v_extra > 0 THEN
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, kind, billing_month, issue_date, due_date, status, subtotal, total_amount, notes)
    VALUES (v_contract.user_id, p_contract_id, v_building, v_contract.room_id, 'SETTLEMENT',
      v_billing, p_move_out_date, p_move_out_date, 'APPROVED'::invoice_status, 0, 0,
      'Hoá đơn thanh lý — khách rời phòng ngày ' || to_char(p_move_out_date,'DD/MM/YYYY') || COALESCE(E'\n' || p_notes, ''))
    RETURNING id INTO v_settle_inv;
  END IF;

  IF v_penalty > 0 THEN
    SELECT COALESCE(MAX(sort_order),0)+1 INTO v_next_sort FROM invoice_items WHERE invoice_id = v_settle_inv;
    INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
    VALUES (v_settle_inv, 'PENALTY', 'Phí phạt thanh lý', v_penalty, 1, 1, v_penalty, v_next_sort);
    UPDATE invoices SET subtotal = COALESCE(subtotal,0)+v_penalty, total_amount = COALESCE(total_amount,0)+v_penalty, updated_at = NOW() WHERE id = v_settle_inv;
  END IF;

  IF v_extra > 0 THEN
    PERFORM public._termination_apply_extra_charges(v_settle_inv, p_extra_charges, p_move_out_date, v_contract.user_id, p_contract_id);
  END IF;

  IF v_settle_inv IS NOT NULL THEN
    UPDATE invoices
       SET notes = COALESCE(notes || E'\n\n', '') || v_breakdown,
           updated_at = NOW()
     WHERE id = v_settle_inv;
  END IF;

  -- 2. Quyết toán hoá đơn còn nợ bằng CẤN TRỪ 'CT' (PAID: gạch hết; DEBT: trong pool).
  v_budget := CASE WHEN p_shortfall_mode = 'DEBT' THEN v_applied ELSE NULL END;
  FOR rec IN
    SELECT id, (total_amount - paid_amount) AS remaining FROM invoices
     WHERE contract_id = p_contract_id AND deleted_at IS NULL AND status <> 'CANCELLED'
       AND (total_amount - paid_amount) > 0
     ORDER BY billing_month, created_at
  LOOP
    v_pay := rec.remaining;
    IF v_budget IS NOT NULL THEN
      EXIT WHEN v_budget <= 0;
      v_pay := LEAST(v_pay, v_budget);
      v_budget := v_budget - v_pay;
    END IF;
    IF v_pay > 0 THEN
      INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes)
      VALUES (v_contract.user_id, rec.id, v_pay, 'CT'::payment_method, p_move_out_date,
              'Quyết toán khi thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY'));
    END IF;
  END LOOP;

  -- 3. CẶP BÚT TOÁN NỘI BỘ (cấn cọc → doanh thu) — CẢ 2 CHÂN trên sổ nội bộ,
  --    net 0/thương vụ; KHÔNG đụng sổ tiền thật (mô hình chốt 04/07).
  IF v_applied_dep > 0 THEN
    v_type_off := public._termination_ensure_type(v_contract.user_id, 'expense', 'Cấn cọc chuyển doanh thu');
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu thanh lý');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', 'Cấn cọc → chuyển doanh thu — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, p_move_out_date, v_applied_dep, 'APPROVED',
      '[CHUYỂN KHOẢN] Bút toán nội bộ: cọc cấn công nợ/phạt (không phải tiền thật).' || E'\n\n' || v_breakdown,
      'termination.offset')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_off, 'Cấn cọc chuyển doanh thu', 1, v_applied_dep, p_move_out_date, p_move_out_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'INCOME', 'Doanh thu thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, v_settle_inv, p_move_out_date, v_applied_dep, 'APPROVED',
      '[CHUYỂN KHOẢN] Bút toán nội bộ: ghi nhận doanh thu thanh lý từ cọc cấn nợ/phạt (KQKD đếm theo hạng mục).',
      'termination.revenue')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Doanh thu thanh lý (cấn cọc)', 1, v_applied_dep, p_move_out_date, p_move_out_date);
  END IF;

  -- 4. HOÀN KHÁCH = TIỀN THẬT: 1 phiếu chi NHÁP, SỔ TRỐNG (chọn khi duyệt).
  IF v_refund_dep > 0 OR v_refund_exc > 0 THEN
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', 'Trả khách thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, NULL, p_move_out_date, v_refund_dep + v_refund_exc, 'UNAPPROVED',
      '[HOÀN KHÁCH THANH LÝ] Phiếu chi hoàn khách (tiền thật). CHỌN SỔ QUỸ chi tiền (Sửa phiếu) rồi mới duyệt được.' || E'\n\n' || v_breakdown || COALESCE(E'\n' || p_notes, ''),
      'termination.refund')
    RETURNING id INTO v_refund_voucher;

    IF v_refund_dep > 0 THEN
      v_type_dep := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn cọc thanh lý');
      UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type_dep AND is_deposit IS DISTINCT FROM TRUE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_dep, 'Trả lại khách (cọc sau khấu trừ)', 1, v_refund_dep, p_move_out_date, p_move_out_date);
    END IF;

    IF v_refund_exc > 0 THEN
      v_type_excr := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn tiền thừa thanh lý');
      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_excr AND is_deposit IS DISTINCT FROM FALSE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_excr, 'Hoàn tiền thừa khi thanh lý', 1, v_refund_exc, p_move_out_date, p_move_out_date);
    END IF;
  END IF;

  -- 4c. Khách trả thêm (TIỀN THẬT) — chế độ PAID: vào SỔ NHẬN đã chọn.
  IF v_S < 0 AND p_shortfall_mode = 'PAID' THEN
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Thu thanh lý (khách trả thêm)');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'INCOME', 'Khách trả thêm khi thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_rcpt, v_settle_inv, p_move_out_date, -v_S, 'APPROVED',
      'Khách trả thêm phần công nợ vượt tiền cọc khi thanh lý (tiền thật vào sổ nhận).' || COALESCE(E'\n' || p_notes, ''),
      'termination.extra_receipt')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Khách trả thêm khi thanh lý', 1, -v_S, p_move_out_date, p_move_out_date);
  END IF;

  -- 5. Recompute hoá đơn quyết toán.
  IF v_settle_inv IS NOT NULL THEN PERFORM public.recompute_invoice_for_id(v_settle_inv); END IF;

  -- 6. Thanh lý hợp đồng (ghi chú kèm bản quyết toán đầy đủ).
  UPDATE contracts
     SET status = 'TERMINATED', actual_end_date = p_move_out_date,
         notes = CASE WHEN notes IS NULL OR length(btrim(notes)) = 0
                        THEN '[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']' || COALESCE(E'\n' || p_notes, '') || E'\n' || v_breakdown
                        ELSE notes || E'\n[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']' || COALESCE(E'\n' || p_notes, '') || E'\n' || v_breakdown END,
         updated_at = NOW()
   WHERE id = p_contract_id;

  -- 7. Audit.
  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date, termination_type,
      outstanding_debt, early_termination_fee, prorated_rent, prorated_days, prorated_services,
      total_deposit, refund_method, status, approved_by, approved_at, notes)
    VALUES (
      v_contract.user_id, p_contract_id, p_move_out_date, p_move_out_date, 'NORMAL',
      v_debt, v_penalty + v_extra, 0, 0, 0,
      v_deposit,
      CASE WHEN v_refund_dep > 0 OR v_refund_exc > 0 THEN 'TM'::payment_method ELSE NULL END,
      'COMPLETED', auth.uid(), NOW(),
      COALESCE(p_notes || E'\n', '') || v_breakdown);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'terminate_contract_move_out_impl: audit insert failed for %: %', p_contract_id, SQLERRM;
  END;

  RETURN jsonb_build_object(
    'contract_id', p_contract_id, 'settlement_invoice_id', v_settle_inv,
    'charges', v_charges, 'extra_charges_total', v_extra,
    'applied', v_applied, 'applied_deposit', v_applied_dep,
    'refund_deposit', v_refund_dep, 'refund_excess', v_refund_exc,
    'refund_voucher_id', v_refund_voucher,
    'net_settlement', v_S, 'shortfall_mode', p_shortfall_mode,
    'receipt_account_id', CASE WHEN v_S < 0 AND p_shortfall_mode = 'PAID' THEN v_acc_rcpt END,
    'acc_op', v_acc_op, 'acc_internal', v_acc_int
  );
END $function$;

-- public.update_lead_score  (2 chỗ)
CREATE OR REPLACE FUNCTION public.update_lead_score()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  score INTEGER := 0;
BEGIN
  -- Budget score (0-30 points)
  IF NEW.budget_max IS NOT NULL THEN
    score := score + 30;
  ELSIF NEW.budget_min IS NOT NULL THEN
    score := score + 15;
  END IF;

  -- Appointment date (0-25 points)
  IF NEW.appointment_date IS NOT NULL THEN
    IF NEW.appointment_date >= public.org_today_v1(NULL) THEN
      score := score + 25;
    ELSE
      score := score + 10;
    END IF;
  END IF;

  -- Source quality (0-20 points)
  CASE NEW.source::text
    WHEN 'REFERRAL' THEN score := score + 20;
    WHEN 'WALK_IN' THEN score := score + 18;
    WHEN 'WEBSITE' THEN score := score + 15;
    WHEN 'FACEBOOK' THEN score := score + 12;
    WHEN 'ZALO' THEN score := score + 12;
    WHEN 'PHONE' THEN score := score + 10;
    ELSE score := score + 5;
  END CASE;

  -- Status progression (0-20 points)
  CASE NEW.status::text
    WHEN 'CONVERTED' THEN score := score + 20;
    WHEN 'B3_CONSULTATION' THEN score := score + 15;
    WHEN 'B2_APPOINTMENT' THEN score := score + 10;
    WHEN 'B1_LEAD' THEN score := score + 5;
    WHEN 'FAILED' THEN score := score + 0;
    ELSE score := score + 0;
  END CASE;

  -- Email provided (0-5 points)
  IF NEW.email IS NOT NULL THEN
    score := score + 5;
  END IF;

  -- Move-in date soon (0-5 points)
  IF NEW.move_in_date IS NOT NULL AND NEW.move_in_date <= public.org_today_v1(NULL) + INTERVAL '30 days' THEN
    score := score + 5;
  END IF;

  NEW.lead_score := score;
  RETURN NEW;
END;
$function$;
DO $selfcheck$
DECLARE v_left int; v_names text;
BEGIN
  SELECT count(*), string_agg(n.nspname||'.'||p.proname, ', ')
    INTO v_left, v_names
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname IN ('public','app_private') AND p.prokind='f'
     AND regexp_replace(p.prosrc,'--[^\n]*','','g') ~* 'current_date';
  IF v_left > 0 THEN
    RAISE EXCEPTION 'Còn % hàm dùng CURRENT_DATE: %. DỪNG.', v_left, v_names;
  END IF;
  -- org_today_v1 phải thật sự trả đúng ngày giờ VN.
  IF public.org_today_v1(NULL) IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN
    RAISE EXCEPTION 'org_today_v1 không khớp ngày ở VN. DỪNG.';
  END IF;
END
$selfcheck$;

COMMIT;
