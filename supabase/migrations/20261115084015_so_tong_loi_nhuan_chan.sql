-- =============================================================================
-- Sổ tổng lợi nhuận cổ đông — CHỐT CHẶN (M2-chặn của "Chi chia lợi nhuận theo sổ tổng").
--
-- VÌ SAO
--   Đường duyệt thật trên production là hai RPC vòng đời V2 (approve_income_expense_v2
--   rồi post_approved_income_expense_v2, hoặc approve_and_post_income_expense_v2). Hai RPC
--   đó KHÔNG kiểm người lập, KHÔNG đọc yêu cầu duyệt và chỉ đòi quyền income_expenses.approve
--   theo toà. Với phiếu chi lợi nhuận, chốt ở bảng là chốt DUY NHẤT: người lập và người nhận
--   tiền không được tự duyệt, người duyệt phải có quyền chi lợi nhuận / trả lương điều hành,
--   và phiếu đã lập thì không ai đổi được số tiền, sổ quỹ hay người nhận. Các nút Huỷ duyệt,
--   Khôi phục, Hoàn tác, Yêu cầu sửa, Tranh chấp, Rút yêu cầu duyệt không được dùng làm
--   đường vòng: muốn bỏ phiếu thì huỷ bằng lệnh huỷ có lý do.
--
-- LÀM GÌ
--   F1 a06_profit_ledger_payout_guard (public.income_expenses, BEFORE UPDATE OR DELETE,
--      WHEN OLD.system_source IN ('profit.ledger_payout','profit.manager_salary')):
--      so theo CỘT; hai bước tiền tách riêng —
--        DUYỆT  (UNAPPROVED → APPROVED): route CANONICAL, chỉ qua RPC vòng đời V2, phiếu còn
--               sống và còn yêu cầu duyệt đang chờ, người duyệt ≠ người lập ≠ người nhận (đăng
--               nhập lúc lập HOẶC hiện tại), có quyền chi; rồi khoá công ty → khoá sổ → tính lại
--               số dư (trừ chính phiếu); cổ đông còn phiếu lương cần xem lại ⇒ chặn; lương điều
--               hành vượt ⇒ chặn; ghi nhật ký PAYOUT_APPROVED.
--        GHI SỔ (APPROVED, UNPOSTED → POSTED): route CANONICAL, chỉ qua RPC vòng đời V2,
--               người ghi sổ ≠ người nhận (trừ người giữ sổ tự ghi phiếu tạm ứng mình lập), đúng
--               sổ quỹ lúc lập; ghi nhật ký PAYOUT_POSTED. Không khoá sổ, không tính lại.
--      Lúc nào cũng cho: đánh dấu đã kiểm, bàn giao tiền mặt, ảnh/ghi chú, cột máy tự tính.
--      Ngữ cảnh LẬP (C6 'CREATE'): cho mọi đổi nhưng phải giữ UNAPPROVED. Ngữ cảnh HUỶ
--      (C6 'CANCEL', chỉ E6 đặt): chỉ sang CANCELLED và các cột đảo. Không xoá được.
--   F1b a85z_profit_ledger_post_guard (public.income_expenses, BEFORE UPDATE, cùng WHEN, tên
--      đứng NGAY SAU cầu a85_finance_v2_auto_posting_bridge): F1 chạy TRƯỚC a85 nên không thấy
--      bút toán cầu a85 tự sinh khi một câu UPDATE không token chạm approval_status / account_id /
--      total_amount / deleted_at (kể cả không đổi giá trị) trên phiếu đã duyệt chưa ghi sổ.
--      Chốt này đứng sau a85: không có token FINANCE_V2_LIFECYCLE của chính phiếu thì mọi đổi
--      posting_status / active_posting_id_v2 / reversed_by_posting_id (cầu tự ghi sổ HOẶC tự đảo)
--      ⇒ chặn.
--   F2 a06_profit_ledger_payout_item_guard (public.income_expense_items): dòng hạng mục của
--      hai loại phiếu trên không thêm/sửa/xoá được, trừ ngữ cảnh LẬP.
--   F5 a06_profit_ledger_request_guard (public.approval_requests, BEFORE UPDATE OF state):
--      yêu cầu duyệt đang chờ của hai loại phiếu trên không rút / đóng được ngoài ngữ cảnh
--      HUỶ; bị từ chối thì ghi nhật ký PAYOUT_REJECTED.
--   E6 public.profit_ledger_payout_cancel_v1(p_voucher_id, p_reason, p_idempotency_key,
--                                            p_expected_state DEFAULT NULL):
--      huỷ có lý do ở MỌI route của cờ; phiếu đã duyệt thì người nhận không tự huỷ; phiếu đã ghi
--      sổ thì người huỷ phải giữ đúng sổ quỹ và bút toán được đảo về sổ đó. p_expected_state là
--      trạng thái người huỷ ĐANG THẤY (PENDING / APPROVED_UNPOSTED / POSTED): trạng thái thật đọc
--      dưới khoá hàng phiếu khác ⇒ PT409 PROFIT_LEDGER_CANCEL_STATE_CHANGED, không huỷ gì (duyệt
--      và huỷ chạy cùng lúc thì lệnh huỷ không còn huỷ luôn phiếu vừa được duyệt / vừa chi). Web
--      LUÔN truyền; NULL chỉ để lời gọi 3 tham số cũ còn chạy.
--
-- KHÔNG LÀM: không sửa hàm/trigger cũ nào, không đổi cờ, không đụng bảng/hàm của M1
--   (chỉ dùng), không lập phiếu (E5/E11 là phần khác).
--
-- AN TOÀN CHẠY LẠI: CREATE OR REPLACE / DROP TRIGGER IF EXISTS / REVOKE-GRANT; E6 bỏ bản 3 tham
--   số cũ (DROP FUNCTION IF EXISTS — TEST từng áp bản đó) rồi mới tạo bản 4 tham số; hậu kiểm
--   đúng ở cả hai lượt và đòi chỉ còn MỘT bản E6.
-- LÙI: DROP TRIGGER IF EXISTS a06_profit_ledger_payout_guard ON public.income_expenses;
--   DROP TRIGGER IF EXISTS a85z_profit_ledger_post_guard ON public.income_expenses;
--   DROP TRIGGER IF EXISTS a06_profit_ledger_payout_item_guard ON public.income_expense_items;
--   DROP TRIGGER IF EXISTS a06_profit_ledger_request_guard ON public.approval_requests;
--   REVOKE EXECUTE ON FUNCTION public.profit_ledger_payout_cancel_v1(uuid, text, text, text) FROM authenticated;
--   (không phá dữ liệu; hàm để nguyên là vô hại).
-- MÃ LỖI: không tự ném 40001 / 40P01 (qua PostgREST hai mã này bị gửi lại liên tục — đã thấy ở
--   M2-tạo); xung đột trạng thái là PT409 (HTTP 409), trạng thái không cho phép là 55000 (qua
--   PostgREST là HTTP 500). Web rẽ nhánh theo error.code + mã máy đầu MESSAGE, không theo HTTP.
-- =============================================================================

BEGIN;

-- 0. Tiền kiểm: nền M1 và các đối tượng production mà chốt chặn dùng phải có, đúng chữ ký.
DO $truoc$
DECLARE
  v_thieu text;
BEGIN
  SELECT string_agg(f.sig, ', ' ORDER BY f.sig) INTO v_thieu
    FROM (VALUES
      ('app_private.profit_ledger_write_context_v1(uuid)'),
      ('app_private.profit_ledger_voucher_live_v1(uuid)'),
      ('app_private.profit_ledger_balance_v1(uuid,text,uuid,uuid,date)'),
      ('app_private.profit_ledger_lock_v1(uuid,text,uuid)'),
      ('app_private.evaluate_feature_route(text,uuid)'),
      ('app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)'),
      ('app_private.lock_org_for_decision_v1(uuid)'),
      ('app_private.assert_period_open_for_edit_v1(uuid,text)'),
      ('app_private.assert_cashbook_access_v2(uuid,uuid,text,uuid)'),
      ('app_private.append_income_expense_event_v1(uuid,uuid,text,uuid,text,text,text,text)'),
      ('public.org_today_v1(uuid)')
    ) AS f(sig)
   WHERE to_regprocedure(f.sig) IS NULL;
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Thiếu hàm nền: %', v_thieu USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(x.rel || '.' || c.col, ', ' ORDER BY x.rel, c.col) INTO v_thieu
    FROM (VALUES
      ('app_private.profit_ledger_payouts', ARRAY['voucher_id', 'organization_id', 'subject_kind', 'shareholder_id', 'manager_id',
         'account_id', 'amount', 'balance_before', 'within_amount', 'advance_amount', 'maker_user_id', 'maker_kind', 'payee_user_id']),
      ('app_private.profit_ledger_events', ARRAY['organization_id', 'event_kind', 'subject_kind', 'shareholder_id', 'manager_id',
         'voucher_id', 'amount', 'balance_before', 'balance_after', 'actor_id', 'reason', 'payload']),
      ('app_private.profit_ledger_write_contexts', ARRAY['income_expense_id', 'xid', 'purpose']),
      ('app_private.ie_transition_authorization', ARRAY['income_expense_id', 'xid', 'purpose', 'granted_at']),
      ('app_private.income_expense_cancellations', ARRAY['income_expense_id', 'organization_id', 'cancelled_by', 'cancel_reason',
         'cancellation_kind', 'created_at_snap', 'approved_at_snap', 'amount_snap', 'cashbook_snap']),
      ('app_private.canonical_write_operations', ARRAY['organization_id', 'operation', 'subject_scope', 'actor_id', 'idempotency_key',
         'payload_hash', 'subject_id', 'response_payload', 'completed_at', 'actor_membership_id', 'transaction_id', 'outcome_kind']),
      ('public.income_expenses', ARRAY['id', 'organization_id', 'system_source', 'type', 'approval_status', 'review_state',
         'posting_status', 'posting_mode', 'active_posting_id_v2', 'reversed_by_posting_id', 'cancellation_kind', 'approval_version',
         'posting_version', 'account_id', 'total_amount', 'shareholder_id', 'profit_manager_id', 'building_id', 'handover_id',
         'handover_transfer_id', 'deleted_at', 'created_at', 'approved_at', 'updated_at']),
      ('public.income_expense_items', ARRAY['income_expense_id']),
      ('public.approval_requests', ARRAY['id', 'organization_id', 'subject_type', 'subject_id', 'submission_no', 'state']),
      ('public.approval_decisions', ARRAY['request_id', 'reason', 'decided_at']),
      ('public.income_expense_postings', ARRAY['id', 'organization_id', 'voucher_id', 'posting_subject_kind', 'posting_subject_id',
         'direction', 'account_id', 'gross_amount', 'voucher_amount_snapshot', 'amount_basis', 'net_cash_effect', 'posted_on',
         'posted_by_membership_id', 'posted_by_user_id', 'approval_version', 'event_kind', 'idempotency_key', 'source_kind',
         'posting_generation', 'reversal_of_id', 'reversal_reason']),
      ('public.income_expense_posting_lines', ARRAY['organization_id', 'posting_id', 'account_id', 'line_kind', 'signed_amount']),
      ('public.organization_memberships', ARRAY['id', 'user_id', 'organization_id', 'status', 'valid_from', 'valid_to']),
      ('public.shareholders', ARRAY['id', 'organization_id', 'is_active', 'deleted_at']),
      ('public.profit_managers', ARRAY['id', 'organization_id', 'is_active', 'deleted_at'])
    ) AS x(rel, cols)
    CROSS JOIN LATERAL unnest(x.cols) AS c(col)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = to_regclass(x.rel) AND a.attname = c.col AND a.attnum > 0 AND NOT a.attisdropped);
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Thiếu bảng/cột nền: %', v_thieu USING ERRCODE = '55000';
  END IF;

  -- Tên a06_* chỉ dành cho ba trigger của file này (thứ tự chạy: sau a05_*, trước a85_*).
  SELECT string_agg(t.tgrelid::regclass::text || '.' || t.tgname, ', ') INTO v_thieu
    FROM pg_catalog.pg_trigger t
   WHERE NOT t.tgisinternal
     AND t.tgname LIKE 'a06\_%'
     AND t.tgname NOT IN ('a06_profit_ledger_payout_guard', 'a06_profit_ledger_payout_item_guard', 'a06_profit_ledger_request_guard');
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'Đã có trigger a06_* lạ: % — thứ tự chốt chặn sẽ lệch', v_thieu USING ERRCODE = '55000';
  END IF;

  -- F1b đứng ngay sau cầu ghi sổ tự động: cầu đó phải có, là trigger BEFORE UPDATE theo dòng, tên sắp trước
  -- a85z_profit_ledger_post_guard (thứ tự chạy theo tên, byte).
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid = 'public.income_expenses'::regclass AND NOT t.tgisinternal
          AND t.tgfoid = to_regprocedure('app_private.finance_v2_auto_posting_bridge()')
          AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16)
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid = 'public.income_expenses'::regclass AND NOT t.tgisinternal
          AND t.tgfoid = to_regprocedure('app_private.finance_v2_auto_posting_bridge()')
          AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16
          AND t.tgname::text COLLATE "C" >= 'a85z_profit_ledger_post_guard') THEN
    RAISE EXCEPTION 'Thiếu cầu ghi sổ tự động (finance_v2_auto_posting_bridge, BEFORE UPDATE) hoặc tên của nó không sắp trước a85z_profit_ledger_post_guard'
      USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ── 1. Hàm phụ (nội bộ app_private, không cấp EXECUTE cho vai nào) ────────────

-- Danh sách cột đổi giá trị giữa hai bản ghi (jsonb), bỏ qua các cột được phép.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_chan_changed_columns_v1(p_old jsonb, p_new jsonb, p_allowed text[])
RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $fn$
  SELECT COALESCE(array_agg(k.key ORDER BY k.key), ARRAY[]::text[])
    FROM (SELECT jsonb_object_keys(COALESCE(p_old, '{}'::jsonb)) AS key
          UNION
          SELECT jsonb_object_keys(COALESCE(p_new, '{}'::jsonb))) AS k
   WHERE NOT (k.key = ANY (COALESCE(p_allowed, ARRAY[]::text[])))
     AND (p_old -> k.key) IS DISTINCT FROM (p_new -> k.key)
$fn$;

-- Bước tiền (duyệt / ghi sổ) chỉ chạy khi cờ sổ tổng ở CANONICAL. Mã riêng trong MESSAGE
-- (không trùng tín hiệu "fallback" của web): PROFIT_LEDGER_ROUTE_OFF / PROFIT_LEDGER_FROZEN.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_chan_assert_route_v1(p_org uuid, p_action text)
RETURNS text
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_route text := app_private.evaluate_feature_route('shareholder_profit.ledger_payout.v1', p_org);
BEGIN
  IF v_route = 'CANONICAL' THEN
    RETURN v_route;
  END IF;
  IF v_route = 'FROZEN' THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_FROZEN: sổ tổng lợi nhuận đang đóng băng — không % được phiếu chi theo sổ tổng (vẫn huỷ được bằng lệnh huỷ có lý do)', p_action
      USING ERRCODE = '55000', DETAIL = jsonb_build_object('route', v_route)::text;
  END IF;
  RAISE EXCEPTION 'PROFIT_LEDGER_ROUTE_OFF: sổ tổng lợi nhuận chưa bật — chưa % được phiếu chi theo sổ tổng (vẫn huỷ được bằng lệnh huỷ có lý do)', p_action
    USING ERRCODE = '55000', DETAIL = jsonb_build_object('route', COALESCE(v_route, 'LEGACY'))::text;
END
$fn$;

-- ── 2. F1: chốt chặn phiếu chi theo sổ tổng trên public.income_expenses ──────
CREATE OR REPLACE FUNCTION app_private.guard_profit_ledger_payout_v1()
RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  -- Cột được đổi BẤT KỲ LÚC NÀO: đánh dấu đã kiểm, bàn giao tiền mặt, ảnh / ghi chú, cột máy tự tính.
  c_luc_nao constant text[] := ARRAY['verified_at', 'verified_by', 'verified_by_name', 'verified_note', 'handover_id',
                                     'attachments', 'notes', 'has_restricted_item', 'kqkd_amount',
                                     'counts_in_business_result', 'updated_at'];
  -- Bước DUYỆT (approve_income_expense_v2 / câu đầu của approve_and_post_income_expense_v2).
  c_duyet   constant text[] := ARRAY['approval_status', 'approved_by', 'approved_at', 'review_state', 'approval_version',
                                     'posting_id', 'posted_at_v2'];
  -- Bước GHI SỔ (post_approved_income_expense_v2 / câu sau của approve_and_post_income_expense_v2).
  -- account_id được có mặt trong SET nhưng phải giữ giá trị (kiểm riêng ở trên).
  c_ghi_so  constant text[] := ARRAY['active_posting_id_v2', 'posting_status', 'posting_id', 'posted_at_v2',
                                     'posting_version', 'posting_mode'];
  -- Ngữ cảnh HUỶ của E6: sang CANCELLED và các cột đảo bút toán.
  c_huy     constant text[] := ARRAY['approval_status', 'review_state', 'posting_status', 'cancellation_kind',
                                     'active_posting_id_v2', 'reversed_by_posting_id', 'approval_version', 'posting_version'];
  v_ctx     text;
  v_buoc    text;
  v_lech    text[];
  v_token   boolean;
  v_uid     uuid;
  v_p       app_private.profit_ledger_payouts%ROWTYPE;
  v_subject uuid;
  v_key     text;
  v_allowed boolean;
  v_req     record;
  v_bal     jsonb;
  v_before  numeric(15,2);
  v_within  numeric(15,2);
  v_advance numeric(15,2);
  v_payee_now uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_NO_DELETE: phiếu chi theo sổ tổng không xoá được — muốn bỏ phiếu thì dùng lệnh huỷ có lý do'
      USING ERRCODE = '55000';
  END IF;

  v_ctx := app_private.profit_ledger_write_context_v1(OLD.id);

  -- Ngữ cảnh LẬP phiếu (E5/E11): cho mọi đổi, trừ việc rời trạng thái chờ duyệt (phủ luật AUTO_POST).
  IF v_ctx = 'CREATE' THEN
    IF NEW.approval_status IS DISTINCT FROM 'UNAPPROVED' THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_CONTEXT: trong lúc lập, phiếu chi theo sổ tổng phải giữ trạng thái chờ duyệt'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  -- Ngữ cảnh HUỶ (chỉ E6 đặt): chỉ sang CANCELLED, chỉ đổi cột huỷ / đảo bút toán.
  IF v_ctx = 'CANCEL' THEN
    IF OLD.approval_status = 'CANCELLED' OR NEW.approval_status IS DISTINCT FROM 'CANCELLED' THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_CONTEXT: lệnh huỷ chỉ được chuyển phiếu chi theo sổ tổng sang Đã huỷ'
        USING ERRCODE = '55000';
    END IF;
    v_lech := app_private.profit_ledger_chan_changed_columns_v1(to_jsonb(OLD), to_jsonb(NEW), c_huy || c_luc_nao);
    IF cardinality(v_lech) > 0 THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_LOCKED: lệnh huỷ không được đổi các cột khác của phiếu chi theo sổ tổng'
        USING ERRCODE = '55000', DETAIL = jsonb_build_object('columns', v_lech)::text;
    END IF;
    RETURN NEW;
  END IF;

  -- Ngoài ngữ cảnh. Sổ quỹ chốt lúc lập: được có mặt trong SET (bước ghi sổ V2) nhưng không đổi.
  IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_ACCOUNT_LOCKED: phiếu chi theo sổ tổng chỉ chi từ đúng sổ quỹ đã chọn lúc lập — không đổi sổ quỹ được, kể cả lúc ghi sổ'
      USING ERRCODE = '55000';
  END IF;

  -- Đường vòng bị cấm tường minh: Huỷ duyệt, Khôi phục, Hoàn tác, xoá mềm, Yêu cầu sửa / Tranh chấp /
  -- Gửi lại, và mọi đường huỷ khác E6.
  IF (OLD.approval_status = 'APPROVED' AND NEW.approval_status = 'UNAPPROVED')
     OR (OLD.approval_status = 'CANCELLED' AND NEW.approval_status IS DISTINCT FROM 'CANCELLED')
     OR (NEW.approval_status = 'CANCELLED' AND OLD.approval_status IS DISTINCT FROM 'CANCELLED')
     OR (NEW.posting_status = 'REVERSED' AND OLD.posting_status IS DISTINCT FROM 'REVERSED')
     OR NEW.reversed_by_posting_id IS DISTINCT FROM OLD.reversed_by_posting_id
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     OR (NEW.review_state IN ('CHANGES_REQUESTED', 'DISPUTED', 'PENDING')
         AND NEW.review_state IS DISTINCT FROM OLD.review_state) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_CANCEL_ONLY: phiếu chi theo sổ tổng không huỷ duyệt / khôi phục / hoàn tác / yêu cầu sửa / tranh chấp / huỷ theo đường thường được — muốn bỏ phiếu thì dùng lệnh huỷ có lý do'
      USING ERRCODE = '55000';
  END IF;

  v_buoc := CASE
    WHEN OLD.approval_status = 'UNAPPROVED' AND NEW.approval_status = 'APPROVED' THEN 'DUYET'
    WHEN OLD.approval_status = 'APPROVED' AND NEW.approval_status = 'APPROVED'
         AND NEW.posting_status = 'POSTED' AND OLD.posting_status IS DISTINCT FROM 'POSTED' THEN 'GHI_SO'
  END;

  v_lech := app_private.profit_ledger_chan_changed_columns_v1(to_jsonb(OLD), to_jsonb(NEW),
              c_luc_nao || CASE v_buoc WHEN 'DUYET' THEN c_duyet WHEN 'GHI_SO' THEN c_ghi_so ELSE ARRAY[]::text[] END);
  IF cardinality(v_lech) > 0
     OR (v_buoc = 'DUYET' AND NEW.review_state IS DISTINCT FROM OLD.review_state AND NEW.review_state IS DISTINCT FROM 'RESOLVED') THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_LOCKED: phiếu chi theo sổ tổng đã khoá — chỉ được duyệt, ghi sổ, gắn ảnh / ghi chú, đánh dấu đã kiểm hoặc bàn giao tiền mặt'
      USING ERRCODE = '55000', DETAIL = jsonb_build_object('columns', v_lech, 'step', v_buoc)::text;
  END IF;

  IF v_buoc IS NULL THEN
    RETURN NEW;
  END IF;

  -- Hai bước tiền: cờ phải CANONICAL; chỉ qua RPC vòng đời V2 — token FINANCE_V2_LIFECYCLE của chính giao
  -- dịch, cũng là điều làm cầu a85 đứng ngoài, nên không có bút toán nào sinh ra sau lưng chốt chặn này.
  PERFORM app_private.profit_ledger_chan_assert_route_v1(OLD.organization_id,
            CASE v_buoc WHEN 'DUYET' THEN 'duyệt' ELSE 'ghi sổ' END);
  v_token := EXISTS (
    SELECT 1 FROM app_private.ie_transition_authorization t
     WHERE t.income_expense_id = OLD.id
       AND t.xid = pg_current_xact_id()
       AND t.purpose = 'FINANCE_V2_LIFECYCLE');

  SELECT * INTO v_p FROM app_private.profit_ledger_payouts p WHERE p.voucher_id = OLD.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_NO_PAYOUT_ROW: phiếu mang nguồn sổ tổng nhưng thiếu dòng sổ — không duyệt / ghi sổ được, báo quản trị'
      USING ERRCODE = '55000';
  END IF;
  IF v_p.organization_id IS DISTINCT FROM OLD.organization_id
     OR v_p.shareholder_id IS DISTINCT FROM OLD.shareholder_id
     OR v_p.manager_id IS DISTINCT FROM OLD.profit_manager_id
     OR v_p.amount IS DISTINCT FROM OLD.total_amount
     OR v_p.account_id IS DISTINCT FROM OLD.account_id
     OR OLD.type IS DISTINCT FROM 'EXPENSE' THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_VOUCHER_MISMATCH: phiếu không còn khớp dòng sổ lúc lập (người nhận, số tiền, sổ quỹ) — không duyệt / ghi sổ được, báo quản trị'
      USING ERRCODE = '55000';
  END IF;
  v_subject := COALESCE(v_p.shareholder_id, v_p.manager_id);

  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_ACTOR_REQUIRED: phải đăng nhập để duyệt / ghi sổ phiếu chi theo sổ tổng'
      USING ERRCODE = '42501';
  END IF;
  -- Người nhận = đăng nhập lúc lập (C2.payee_user_id) HOẶC đăng nhập HIỆN TẠI của cổ đông / người nhận lương điều hành
  -- (người được gắn đăng nhập sau khi lập vẫn là người nhận).
  v_payee_now := CASE v_p.subject_kind
    WHEN 'SHAREHOLDER' THEN (SELECT s.auth_user_id FROM public.shareholders s WHERE s.id = v_subject)
    ELSE (SELECT m.auth_user_id FROM public.profit_managers m WHERE m.id = v_subject) END;

  IF v_buoc = 'GHI_SO' THEN
    IF COALESCE(OLD.posting_status, 'UNPOSTED') <> 'UNPOSTED' THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_REPOST: phiếu chi theo sổ tổng đã đảo bút toán thì không ghi sổ lại được — lập phiếu mới'
        USING ERRCODE = '55000';
    END IF;
    IF NOT v_token THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_V2_ONLY: phiếu chi theo sổ tổng chỉ duyệt / ghi sổ ở màn Chờ duyệt (Duyệt, Duyệt và Chi, Ghi sổ)'
        USING ERRCODE = '55000';
    END IF;
    -- Người giữ sổ tự ghi sổ phiếu tạm ứng của chính mình (người lập) sau khi chủ đã duyệt là đường đúng.
    IF (v_uid = v_p.payee_user_id OR v_uid = v_payee_now)
       AND NOT (v_p.maker_kind = 'CUSTODIAN_ADVANCE' AND v_uid = v_p.maker_user_id) THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_PAYEE_SELF_POST: người nhận tiền không tự ghi sổ (chi) phiếu chi lợi nhuận cho mình — cần người giữ sổ khác'
        USING ERRCODE = '42501';
    END IF;
    INSERT INTO app_private.profit_ledger_events (organization_id, event_kind, subject_kind, shareholder_id, manager_id,
      voucher_id, amount, actor_id, payload)
    VALUES (OLD.organization_id, 'PAYOUT_POSTED', v_p.subject_kind, v_p.shareholder_id, v_p.manager_id,
      OLD.id, OLD.total_amount, v_uid,
      jsonb_build_object('posting_id', NEW.active_posting_id_v2, 'account_id', OLD.account_id,
                         'maker_kind', v_p.maker_kind, 'posting_status_before', OLD.posting_status));
    RETURN NEW;
  END IF;

  -- Bước DUYỆT.
  IF NOT app_private.profit_ledger_voucher_live_v1(OLD.id) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_VOUCHER_DEAD: phiếu đã bị từ chối / rút / đóng yêu cầu duyệt — không duyệt lại được; muốn bỏ phiếu thì dùng lệnh huỷ có lý do'
      USING ERRCODE = '55000';
  END IF;
  SELECT ar.id, ar.state INTO v_req
    FROM public.approval_requests ar
   WHERE ar.organization_id = OLD.organization_id
     AND ar.subject_type = 'FINANCIAL_VOUCHER'
     AND ar.subject_id = OLD.id
   ORDER BY ar.submission_no DESC
   LIMIT 1;
  IF v_req.id IS NULL OR v_req.state IS DISTINCT FROM 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_NO_PENDING_REQUEST: phiếu chi theo sổ tổng không còn yêu cầu duyệt đang chờ — không duyệt được'
      USING ERRCODE = '55000';
  END IF;
  IF NOT v_token THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_V2_ONLY: phiếu chi theo sổ tổng chỉ duyệt / ghi sổ ở màn Chờ duyệt (Duyệt, Duyệt và Chi, Ghi sổ)'
      USING ERRCODE = '55000';
  END IF;
  IF v_uid = v_p.maker_user_id THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_MAKER_SELF_APPROVE: người lập phiếu không tự duyệt phiếu chi lợi nhuận của mình — cần một chủ khác duyệt'
      USING ERRCODE = '42501';
  END IF;
  IF v_uid = v_p.payee_user_id OR v_uid = v_payee_now THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_PAYEE_SELF_APPROVE: người nhận tiền không tự duyệt phiếu chi lợi nhuận cho mình — cần một chủ khác duyệt'
      USING ERRCODE = '42501';
  END IF;
  v_key := CASE v_p.subject_kind WHEN 'SHAREHOLDER' THEN 'shareholder_profit.distribute' ELSE 'shareholder_profit.pay_manager' END;
  SELECT a.allowed INTO v_allowed
    FROM app_private.authorize_tenant_action_v3(v_uid, OLD.organization_id, v_key, OLD.building_id, OLD.account_id) a;
  IF NOT COALESCE(v_allowed, false) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_APPROVE_FORBIDDEN: cần quyền % để duyệt phiếu chi theo sổ tổng', v_key
      USING ERRCODE = '42501', DETAIL = jsonb_build_object('permission', v_key)::text;
  END IF;
  IF (v_p.subject_kind = 'SHAREHOLDER' AND NOT EXISTS (
        SELECT 1 FROM public.shareholders s
         WHERE s.id = v_subject AND s.organization_id = OLD.organization_id AND s.deleted_at IS NULL AND s.is_active))
     OR (v_p.subject_kind = 'MANAGER' AND NOT EXISTS (
        SELECT 1 FROM public.profit_managers m
         WHERE m.id = v_subject AND m.organization_id = OLD.organization_id AND m.deleted_at IS NULL AND m.is_active)) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SUBJECT_GONE: người nhận đã bị xoá hoặc ngưng — không duyệt được, chỉ còn huỷ'
      USING ERRCODE = '55000';
  END IF;

  -- Thứ tự khoá v2: (đã giữ hàng phiếu) → khoá công ty → khoá sổ → đọc số dư → ghi.
  PERFORM app_private.lock_org_for_decision_v1(OLD.organization_id);
  PERFORM app_private.profit_ledger_lock_v1(OLD.organization_id, v_p.subject_kind, v_subject);
  v_bal := app_private.profit_ledger_balance_v1(OLD.organization_id, v_p.subject_kind, v_subject, OLD.id);
  v_before := (v_bal ->> 'balance')::numeric;
  v_within := LEAST(OLD.total_amount, GREATEST(v_before, 0));
  v_advance := OLD.total_amount - v_within;
  -- Cổ đông còn phiếu lương "cần chủ xem lại" (C4 NEEDS_REVIEW, phiếu lương còn sống): số dư chưa chắc ⇒ không duyệt
  -- (cùng luật với lệnh lập E5).
  IF v_p.subject_kind = 'SHAREHOLDER' AND COALESCE((v_bal -> 'needs_review' ->> 'count')::int, 0) > 0 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SALARY_REVIEW_PENDING: cổ đông còn phiếu lương cần chủ xác nhận phần lợi nhuận — xử lý xong rồi mới duyệt chi lợi nhuận'
      USING ERRCODE = '55000', DETAIL = (v_bal -> 'needs_review')::text;
  END IF;
  IF v_p.subject_kind = 'MANAGER' AND v_advance > 0 THEN
    RAISE EXCEPTION 'PROFIT_MANAGER_LEDGER_OVERDRAW: lương điều hành vượt số còn lại của sổ — không duyệt được'
      USING ERRCODE = '22023',
            DETAIL = jsonb_build_object('balance', v_before, 'amount', OLD.total_amount, 'over', v_advance)::text;
  END IF;

  INSERT INTO app_private.profit_ledger_events (organization_id, event_kind, subject_kind, shareholder_id, manager_id,
    voucher_id, amount, balance_before, balance_after, actor_id, payload)
  VALUES (OLD.organization_id, 'PAYOUT_APPROVED', v_p.subject_kind, v_p.shareholder_id, v_p.manager_id,
    OLD.id, OLD.total_amount, v_before, v_before - OLD.total_amount, v_uid,
    jsonb_build_object('within_amount', v_within, 'advance_amount', v_advance, 'request_id', v_req.id,
                       'at_create', jsonb_build_object('balance_before', v_p.balance_before,
                                                       'within_amount', v_p.within_amount,
                                                       'advance_amount', v_p.advance_amount)));
  RETURN NEW;
END
$fn$;

-- ── 2b. F1b: chốt SAU cầu a85 — không bút toán nào sinh ra ngoài RPC vòng đời V2 ──
-- F1 (a06) chạy trước a85 nên chỉ thấy cột do câu UPDATE đặt. Một câu UPDATE không token chạm cột kích a85
-- (approval_status / account_id / total_amount / deleted_at — kể cả không đổi giá trị) sẽ qua F1 rồi để a85 tự
-- sinh bút toán và đặt POSTED (phiếu đã duyệt chưa ghi sổ), hoặc tự ĐẢO bút toán và đặt REVERSED (phiếu đã ghi sổ
-- mà sổ quỹ bị xoá mềm / thành sổ ảo). Chốt này đứng ngay sau a85 nên thấy đúng NEW đó: không có token của chính
-- phiếu thì không cột ghi sổ nào được đổi (POSTED, REVERSED, con trỏ bút toán, con trỏ đảo).
CREATE OR REPLACE FUNCTION app_private.guard_profit_ledger_post_v1()
RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF (NEW.posting_status IS DISTINCT FROM OLD.posting_status
      OR NEW.active_posting_id_v2 IS DISTINCT FROM OLD.active_posting_id_v2
      OR NEW.reversed_by_posting_id IS DISTINCT FROM OLD.reversed_by_posting_id)
     AND NOT EXISTS (
       SELECT 1 FROM app_private.ie_transition_authorization tk
        WHERE tk.income_expense_id = OLD.id
          AND tk.xid = pg_current_xact_id()
          AND tk.purpose = 'FINANCE_V2_LIFECYCLE') THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_V2_ONLY: phiếu chi theo sổ tổng chỉ ghi sổ ở màn Chờ duyệt (Ghi sổ, Duyệt và Chi) và chỉ đảo bút toán bằng lệnh huỷ có lý do — không ghi / đảo tự động theo đường cũ'
      USING ERRCODE = '55000',
            DETAIL = jsonb_build_object('posting_status', NEW.posting_status, 'posting_status_before', OLD.posting_status,
                                       'active_posting_id_v2', NEW.active_posting_id_v2)::text;
  END IF;
  RETURN NEW;
END
$fn$;

-- ── 3. F2: dòng hạng mục của phiếu chi theo sổ tổng ──────────────────────────
CREATE OR REPLACE FUNCTION app_private.guard_profit_ledger_payout_item_v1()
RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_id  uuid;
  v_src text;
BEGIN
  -- UPDATE không đổi giá trị nào (bảo trì hàng loạt) không phải là sửa dòng.
  IF TG_OP = 'UPDATE' AND to_jsonb(OLD) IS NOT DISTINCT FROM to_jsonb(NEW) THEN
    RETURN NEW;
  END IF;
  FOREACH v_id IN ARRAY CASE TG_OP
      WHEN 'INSERT' THEN ARRAY[NEW.income_expense_id]
      WHEN 'DELETE' THEN ARRAY[OLD.income_expense_id]
      ELSE ARRAY[OLD.income_expense_id, NEW.income_expense_id] END LOOP
    CONTINUE WHEN v_id IS NULL;
    SELECT ie.system_source INTO v_src FROM public.income_expenses ie WHERE ie.id = v_id;
    IF v_src IN ('profit.ledger_payout', 'profit.manager_salary')
       AND COALESCE(app_private.profit_ledger_write_context_v1(v_id) <> 'CREATE', true) THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_ITEMS_LOCKED: dòng hạng mục của phiếu chi theo sổ tổng không thêm / sửa / xoá được (kể cả gộp hạng mục)'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;

-- ── 4. F5: yêu cầu duyệt đang chờ của phiếu chi theo sổ tổng ─────────────────
CREATE OR REPLACE FUNCTION app_private.guard_profit_ledger_request_v1()
RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_ie     record;
  v_p      app_private.profit_ledger_payouts%ROWTYPE;
  v_kind   text;
  v_reason text;
BEGIN
  SELECT ie.id, ie.organization_id, ie.system_source, ie.shareholder_id, ie.profit_manager_id, ie.total_amount
    INTO v_ie
    FROM public.income_expenses ie
   WHERE ie.id = OLD.subject_id;
  IF NOT FOUND OR v_ie.system_source IS NULL
     OR v_ie.system_source NOT IN ('profit.ledger_payout', 'profit.manager_salary') THEN
    RETURN NEW;
  END IF;

  IF NEW.state IN ('CANCELLED', 'WITHDRAWN') THEN
    IF COALESCE(app_private.profit_ledger_write_context_v1(v_ie.id) = 'CANCEL', false) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'PROFIT_LEDGER_CANCEL_ONLY: không rút / đóng được yêu cầu duyệt của phiếu chi theo sổ tổng — muốn bỏ phiếu thì dùng lệnh huỷ có lý do'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.state IN ('REJECTED', 'DENIED') THEN
    SELECT * INTO v_p FROM app_private.profit_ledger_payouts p WHERE p.voucher_id = v_ie.id;
    IF FOUND THEN
      v_kind := v_p.subject_kind;
    ELSE
      v_kind := CASE WHEN v_ie.shareholder_id IS NOT NULL THEN 'SHAREHOLDER'
                     WHEN v_ie.profit_manager_id IS NOT NULL THEN 'MANAGER' END;
      v_p.shareholder_id := v_ie.shareholder_id;
      v_p.manager_id := v_ie.profit_manager_id;
    END IF;
    -- Từ chối luôn phải chạy được (đó là hướng an toàn): thiếu chủ thể thì chỉ không ghi nhật ký.
    IF v_kind IS NOT NULL THEN
      SELECT d.reason INTO v_reason
        FROM public.approval_decisions d
       WHERE d.request_id = OLD.id
       ORDER BY d.decided_at DESC
       LIMIT 1;
      INSERT INTO app_private.profit_ledger_events (organization_id, event_kind, subject_kind, shareholder_id, manager_id,
        voucher_id, amount, actor_id, reason, payload)
      VALUES (v_ie.organization_id, 'PAYOUT_REJECTED', v_kind,
        CASE WHEN v_kind = 'SHAREHOLDER' THEN v_p.shareholder_id END,
        CASE WHEN v_kind = 'MANAGER' THEN v_p.manager_id END,
        v_ie.id, v_ie.total_amount, auth.uid(), v_reason,
        jsonb_build_object('request_id', OLD.id, 'state', NEW.state, 'submission_no', OLD.submission_no));
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS a06_profit_ledger_payout_guard ON public.income_expenses;
CREATE TRIGGER a06_profit_ledger_payout_guard
  BEFORE UPDATE OR DELETE ON public.income_expenses
  FOR EACH ROW
  WHEN (OLD.system_source IN ('profit.ledger_payout', 'profit.manager_salary'))
  EXECUTE FUNCTION app_private.guard_profit_ledger_payout_v1();

-- Tên "a85z_…" sắp ngay sau "a85_finance_v2_auto_posting_bridge" (và "a85b_…" là AFTER INSERT), trước "a86_…".
DROP TRIGGER IF EXISTS a85z_profit_ledger_post_guard ON public.income_expenses;
CREATE TRIGGER a85z_profit_ledger_post_guard
  BEFORE UPDATE ON public.income_expenses
  FOR EACH ROW
  WHEN (OLD.system_source IN ('profit.ledger_payout', 'profit.manager_salary'))
  EXECUTE FUNCTION app_private.guard_profit_ledger_post_v1();

DROP TRIGGER IF EXISTS a06_profit_ledger_payout_item_guard ON public.income_expense_items;
CREATE TRIGGER a06_profit_ledger_payout_item_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.income_expense_items
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_ledger_payout_item_v1();

DROP TRIGGER IF EXISTS a06_profit_ledger_request_guard ON public.approval_requests;
CREATE TRIGGER a06_profit_ledger_request_guard
  BEFORE UPDATE OF state ON public.approval_requests
  FOR EACH ROW
  WHEN (OLD.state = 'PENDING_APPROVAL' AND NEW.state IS DISTINCT FROM OLD.state AND OLD.subject_type = 'FINANCIAL_VOUCHER')
  EXECUTE FUNCTION app_private.guard_profit_ledger_request_v1();

-- ── 5. E6: huỷ phiếu chi theo sổ tổng, bắt buộc lý do, chạy ở mọi route của cờ ─
-- Chữ ký đổi (thêm p_expected_state): bỏ bản 3 tham số trước. Để nguyên thì bản cũ và bản mới (tham số cuối có DEFAULT)
-- cùng khớp lời gọi 3 tham số ⇒ "function … is not unique", và bản cũ không so trạng thái.
DROP FUNCTION IF EXISTS public.profit_ledger_payout_cancel_v1(uuid, text, text);
CREATE OR REPLACE FUNCTION public.profit_ledger_payout_cancel_v1(p_voucher_id uuid, p_reason text, p_idempotency_key text,
                                                                 p_expected_state text DEFAULT NULL)
RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_actor      uuid := auth.uid();
  v_reason     text := btrim(COALESCE(p_reason, ''));
  v_org        uuid;
  v_membership uuid;
  v            public.income_expenses%ROWTYPE;
  v_p          app_private.profit_ledger_payouts%ROWTYPE;
  v_has_p      boolean;
  v_kind       text;
  v_subject    uuid;
  v_key        text;
  v_allowed    boolean;
  v_hash       text;
  v_op         app_private.canonical_write_operations%ROWTYPE;
  v_active     public.income_expense_postings%ROWTYPE;
  v_rev        uuid;
  v_sum        numeric;
  v_cancel     text;
  v_next_post  text;
  v_bal_before numeric(15,2);
  v_bal_after  numeric(15,2);
  v_resp       jsonb;
  v_payee_now  uuid;
  v_state      text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_ACTOR_REQUIRED: chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_voucher_id IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_INPUT: thiếu phiếu cần huỷ' USING ERRCODE = '22023';
  END IF;
  IF p_expected_state IS NOT NULL AND p_expected_state NOT IN ('PENDING', 'APPROVED_UNPOSTED', 'POSTED') THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_INPUT: trạng thái kỳ vọng của phiếu phải là PENDING, APPROVED_UNPOSTED hoặc POSTED'
      USING ERRCODE = '22023', DETAIL = jsonb_build_object('expected_state', p_expected_state)::text;
  END IF;
  IF char_length(v_reason) < 8 OR char_length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_CANCEL_REASON: phải ghi lý do huỷ từ 8 đến 1000 ký tự để còn đối soát về sau'
      USING ERRCODE = '22023', DETAIL = jsonb_build_object('length', char_length(v_reason))::text;
  END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_IDEMPOTENCY_KEY: khoá chống gửi trùng không hợp lệ (8–200 ký tự chữ, số, . _ : -)'
      USING ERRCODE = '22023';
  END IF;

  -- Đọc KHÔNG khoá để biết công ty, rồi kiểm thành viên trước mọi tiết lộ về phiếu.
  SELECT ie.organization_id INTO v_org FROM public.income_expenses ie WHERE ie.id = p_voucher_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_VOUCHER_NOT_FOUND: phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;
  SELECT m.id INTO v_membership
    FROM public.organization_memberships m
   WHERE m.user_id = v_actor
     AND m.organization_id = v_org
     AND m.status = 'ACTIVE'
     AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= now()
     AND (m.valid_to IS NULL OR m.valid_to > now())
   ORDER BY m.valid_from DESC NULLS LAST
   LIMIT 1;
  IF v_membership IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_NOT_MEMBER: không thuộc công ty của phiếu' USING ERRCODE = '42501';
  END IF;

  -- (1) Khoá hàng phiếu.
  SELECT * INTO v FROM public.income_expenses ie WHERE ie.id = p_voucher_id FOR UPDATE;
  IF NOT FOUND OR v.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_VOUCHER_NOT_FOUND: phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;
  IF v.system_source IS NULL OR v.system_source NOT IN ('profit.ledger_payout', 'profit.manager_salary') THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_NOT_LEDGER_VOUCHER: phiếu này không phải phiếu chi theo sổ tổng — dùng lệnh huỷ thường'
      USING ERRCODE = '22023';
  END IF;
  v_kind := CASE WHEN v.shareholder_id IS NOT NULL THEN 'SHAREHOLDER'
                 WHEN v.profit_manager_id IS NOT NULL THEN 'MANAGER' END;
  v_subject := COALESCE(v.shareholder_id, v.profit_manager_id);
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SUBJECT_GONE: phiếu không còn người nhận — báo quản trị' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_p FROM app_private.profit_ledger_payouts p WHERE p.voucher_id = v.id;
  v_has_p := FOUND;
  IF v_has_p AND (v_p.subject_kind IS DISTINCT FROM v_kind
                  OR v_p.shareholder_id IS DISTINCT FROM v.shareholder_id
                  OR v_p.manager_id IS DISTINCT FROM v.profit_manager_id) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_VOUCHER_MISMATCH: phiếu không còn khớp dòng sổ lúc lập — báo quản trị' USING ERRCODE = '55000';
  END IF;

  -- (2) Khoá yêu cầu duyệt của phiếu (trigger a75 sẽ đóng yêu cầu đang chờ khi phiếu sang CANCELLED).
  PERFORM 1
    FROM public.approval_requests ar
   WHERE ar.organization_id = v.organization_id
     AND ar.subject_type = 'FINANCIAL_VOUCHER'
     AND ar.subject_id = v.id
   ORDER BY ar.id
     FOR UPDATE;

  -- (3) Khoá công ty, rồi mới kiểm quyền (authorize_tenant_action_v3 chụp quyền sau khi đã chờ khoá).
  PERFORM app_private.lock_org_for_decision_v1(v.organization_id);
  v_key := CASE v_kind WHEN 'SHAREHOLDER' THEN 'shareholder_profit.distribute' ELSE 'shareholder_profit.pay_manager' END;
  SELECT a.allowed INTO v_allowed
    FROM app_private.authorize_tenant_action_v3(v_actor, v.organization_id, v_key, v.building_id, v.account_id) a;
  -- Người lập (không có quyền chi) chỉ huỷ được phiếu CHỜ DUYỆT của chính mình.
  IF NOT COALESCE(v_allowed, false)
     AND NOT (v_has_p AND v_p.maker_user_id = v_actor AND v.approval_status IN ('UNAPPROVED', 'CANCELLED')) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_CANCEL_FORBIDDEN: cần quyền % để huỷ phiếu này (người lập chỉ huỷ được phiếu chờ duyệt của mình)', v_key
      USING ERRCODE = '42501', DETAIL = jsonb_build_object('permission', v_key)::text;
  END IF;

  -- (4) Chống gửi trùng. Trạng thái kỳ vọng thuộc nội dung lệnh: cùng khoá mà khác kỳ vọng ⇒ 23505. Bỏ khoá rỗng để lời
  -- gọi 3 tham số (kỳ vọng NULL) băm y như bản cũ.
  v_hash := md5(jsonb_strip_nulls(jsonb_build_object('voucher_id', p_voucher_id, 'reason', v_reason,
                                                     'expected_state', p_expected_state))::text);
  INSERT INTO app_private.canonical_write_operations (organization_id, operation, subject_scope, actor_id, idempotency_key,
    payload_hash, actor_membership_id, transaction_id)
  VALUES (v.organization_id, 'shareholder_profit.ledger_cancel.v1', p_voucher_id::text, v_actor, p_idempotency_key,
    v_hash, v_membership, pg_current_xact_id())
  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key) DO NOTHING;
  SELECT * INTO v_op
    FROM app_private.canonical_write_operations o
   WHERE o.organization_id = v.organization_id
     AND o.operation = 'shareholder_profit.ledger_cancel.v1'
     AND o.subject_scope = p_voucher_id::text
     AND o.actor_id = v_actor
     AND o.idempotency_key = p_idempotency_key
     FOR UPDATE;
  IF v_op.payload_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_IDEMPOTENCY_REUSED: khoá chống gửi trùng đã dùng cho lệnh huỷ khác nội dung'
      USING ERRCODE = '23505';
  END IF;
  IF v_op.completed_at IS NOT NULL THEN
    RETURN v_op.response_payload;
  END IF;

  -- (4b) So trạng thái người huỷ đã thấy với trạng thái thật. v đọc dưới khoá hàng ở (1) và khoá giữ tới hết giao dịch: lệnh
  -- duyệt / ghi sổ chạy cùng lúc mà xong trước thì ở đây đã thấy kết quả của nó. Đặt SAU bước phát lại để gửi lại cùng khoá
  -- sau khi đã huỷ vẫn nhận đúng kết quả cũ. Lệch ⇒ PT409 (PostgREST trả HTTP 409, không tự gửi lại như 40001 / 40P01);
  -- mọi ghi của lệnh này (kể cả dòng chống gửi trùng) cuộn lại cùng lỗi.
  v_state := CASE
    WHEN v.approval_status = 'UNAPPROVED' THEN 'PENDING'
    WHEN v.approval_status = 'APPROVED' AND v.posting_status = 'POSTED' THEN 'POSTED'
    WHEN v.approval_status = 'APPROVED' AND COALESCE(v.posting_status, 'UNPOSTED') IN ('UNPOSTED', 'NOT_APPLICABLE') THEN 'APPROVED_UNPOSTED'
    WHEN v.approval_status = 'CANCELLED' THEN 'CANCELLED'
    ELSE v.approval_status || '/' || COALESCE(v.posting_status, '-') END;
  IF p_expected_state IS NOT NULL AND v_state IS DISTINCT FROM p_expected_state THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_CANCEL_STATE_CHANGED: phiếu vừa đổi trạng thái (lúc mở: %, bây giờ: %) — tải lại phiếu rồi mới quyết định huỷ',
      p_expected_state, v_state
      USING ERRCODE = 'PT409', DETAIL = jsonb_build_object('expected', p_expected_state, 'actual', v_state)::text;
  END IF;

  -- (5) Khoá sổ của chủ thể.
  PERFORM app_private.profit_ledger_lock_v1(v.organization_id, v_kind, v_subject);

  IF v.approval_status = 'CANCELLED' THEN
    v_resp := jsonb_build_object(
      'voucher_id', v.id, 'changed', false, 'cancellation_kind', v.cancellation_kind,
      'reversal_posting_id', v.reversed_by_posting_id,
      'balance_after', (app_private.profit_ledger_balance_v1(v.organization_id, v_kind, v_subject) ->> 'balance')::numeric);
    UPDATE app_private.canonical_write_operations o
       SET subject_id = v.id, response_payload = v_resp, completed_at = now(), outcome_kind = 'ALREADY_CANCELLED'
     WHERE o.organization_id = v.organization_id AND o.operation = 'shareholder_profit.ledger_cancel.v1'
       AND o.subject_scope = p_voucher_id::text AND o.actor_id = v_actor AND o.idempotency_key = p_idempotency_key;
    RETURN v_resp;
  END IF;

  -- Phiếu đã duyệt (chưa hoặc đã ghi sổ): người nhận không tự huỷ — so cả đăng nhập lúc lập (C2) lẫn đăng nhập HIỆN TẠI
  -- của cổ đông / người nhận lương điều hành. Phiếu ĐÃ GHI SỔ: huỷ là ghi tiền về sổ quỹ, nên người huỷ phải đang giữ
  -- (CUSTODIAN) đúng sổ đó, như reverse_posted_income_expense_v2. Hệ quả (fail-closed): phiếu tạm ứng chi từ sổ của chính
  -- người nhận mà sổ đó không có người giữ nào khác thì không huỷ được sau khi đã ghi sổ.
  IF v.approval_status = 'APPROVED' THEN
    v_payee_now := CASE v_kind
      WHEN 'SHAREHOLDER' THEN (SELECT s.auth_user_id FROM public.shareholders s WHERE s.id = v_subject)
      ELSE (SELECT m.auth_user_id FROM public.profit_managers m WHERE m.id = v_subject) END;
    IF v_actor = v_payee_now OR (v_has_p AND v_actor = v_p.payee_user_id) THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_CANCEL_PAYEE: người nhận tiền không tự huỷ phiếu đã duyệt / đã chi cho mình — cần một chủ khác huỷ'
        USING ERRCODE = '42501';
    END IF;
    IF v.posting_status = 'POSTED' THEN
      BEGIN
        PERFORM app_private.assert_cashbook_access_v2(v.organization_id, v.account_id, 'CUSTODIAN', v_membership);
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE EXCEPTION 'PROFIT_LEDGER_CANCEL_CUSTODIAN: huỷ phiếu đã chi phải do người đang giữ đúng sổ quỹ của phiếu (tiền đảo về sổ đó)'
          USING ERRCODE = '42501', DETAIL = jsonb_build_object('account_id', v.account_id)::text;
      END;
    END IF;
  END IF;

  -- Kiểm trước các khoá kỳ / bàn giao để báo lỗi dễ hiểu (trigger cũ vẫn là chốt cuối).
  IF v.handover_id IS NOT NULL OR v.handover_transfer_id IS NOT NULL THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_IN_HANDOVER: phiếu đang nằm trong phiên bàn giao tiền mặt — huỷ phiên bàn giao (hai bên xác nhận) trước rồi mới huỷ phiếu'
      USING ERRCODE = '55000';
  END IF;
  -- Sổ quỹ đã chốt / phiên bàn giao còn sống / tháng lợi nhuận của toà ảo đã chốt ⇒ P0001 [CASHBOOK_CLOSED] / [HANDOVER_LOCKED] / [PROFIT_LOCKED].
  PERFORM app_private.assert_period_open_for_edit_v1(v.id, 'huỷ');

  v_bal_before := (app_private.profit_ledger_balance_v1(v.organization_id, v_kind, v_subject) ->> 'balance')::numeric;

  -- Token vòng đời: tắt cầu a85 (không đảo chồng lên bút toán hàm này tự viết). Ngữ cảnh HUỶ cho F1/F5.
  INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  VALUES (v.id, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
  ON CONFLICT (income_expense_id) DO UPDATE
    SET xid = EXCLUDED.xid, purpose = EXCLUDED.purpose, granted_at = clock_timestamp();
  INSERT INTO app_private.profit_ledger_write_contexts (income_expense_id, purpose) VALUES (v.id, 'CANCEL');

  v_cancel := 'CANCELLED_UNPOSTED';
  v_next_post := COALESCE(v.posting_status, CASE WHEN v.posting_mode = 'NON_CASH' THEN 'NOT_APPLICABLE' ELSE 'UNPOSTED' END);
  IF v.posting_status = 'POSTED' THEN
    SELECT * INTO v_active FROM public.income_expense_postings p WHERE p.id = v.active_posting_id_v2 FOR UPDATE;
    IF v_active.id IS NULL OR v_active.event_kind IS DISTINCT FROM 'POSTING'
       OR v_active.posting_subject_kind IS DISTINCT FROM 'VOUCHER' OR v_active.posting_subject_id IS DISTINCT FROM v.id THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_POSTING_MISSING: phiếu đã ghi sổ nhưng không tìm thấy bút toán gốc — báo quản trị trước khi huỷ'
        USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.income_expense_postings
      (organization_id, voucher_id, posting_subject_kind, posting_subject_id, direction,
       account_id, gross_amount, voucher_amount_snapshot, amount_basis, net_cash_effect,
       posted_on, posted_by_membership_id, posted_by_user_id, approval_version,
       event_kind, idempotency_key, source_kind, posting_generation, reversal_of_id, reversal_reason)
    VALUES
      (v_active.organization_id, v_active.voucher_id, v_active.posting_subject_kind, v_active.posting_subject_id,
       v_active.direction, v_active.account_id, v_active.gross_amount, v_active.voucher_amount_snapshot,
       v_active.amount_basis, -v_active.net_cash_effect, public.org_today_v1(v.organization_id),
       v_membership, v_actor, COALESCE(v.approval_version, 1),
       'REVERSAL', 'ledgercancel:' || v_active.id::text, 'MANUAL', v_active.posting_generation, v_active.id, v_reason)
    RETURNING id INTO v_rev;

    INSERT INTO public.income_expense_posting_lines (organization_id, posting_id, account_id, line_kind, signed_amount)
    SELECT l.organization_id, v_rev, l.account_id, 'REVERSAL', -l.signed_amount
      FROM public.income_expense_posting_lines l
     WHERE l.posting_id = v_active.id;

    -- Hậu kiểm: mọi bút toán của phiếu phải triệt tiêu về 0.
    SELECT COALESCE(sum(l.signed_amount), 0) INTO v_sum
      FROM public.income_expense_posting_lines l
      JOIN public.income_expense_postings p ON p.id = l.posting_id
     WHERE p.posting_subject_kind = 'VOUCHER' AND p.posting_subject_id = v.id;
    IF v_sum <> 0 THEN
      RAISE EXCEPTION 'PROFIT_LEDGER_REVERSAL_UNBALANCED: huỷ phiếu nhưng bút toán không triệt tiêu — dừng lại, báo quản trị'
        USING ERRCODE = '55000', DETAIL = jsonb_build_object('remaining', v_sum)::text;
    END IF;
    v_cancel := 'CANCELLED_AFTER_POSTING';
    v_next_post := 'REVERSED';
  END IF;

  -- Không nêu account_id / shareholder_id / profit_manager_id / system_source / organization_id trong SET.
  UPDATE public.income_expenses SET
    approval_status = 'CANCELLED',
    review_state = 'RESOLVED',
    posting_status = v_next_post,
    cancellation_kind = v_cancel,
    active_posting_id_v2 = CASE WHEN v_rev IS NOT NULL THEN NULL ELSE active_posting_id_v2 END,
    reversed_by_posting_id = COALESCE(v_rev, reversed_by_posting_id),
    approval_version = COALESCE(approval_version, 1) + 1,
    posting_version = COALESCE(posting_version, 1) + CASE WHEN v_rev IS NOT NULL THEN 1 ELSE 0 END,
    updated_at = now()
  WHERE id = v.id;

  DELETE FROM app_private.profit_ledger_write_contexts c WHERE c.income_expense_id = v.id AND c.xid = pg_current_xact_id();
  DELETE FROM app_private.ie_transition_authorization t WHERE t.income_expense_id = v.id AND t.xid = pg_current_xact_id();

  INSERT INTO app_private.income_expense_cancellations
    (income_expense_id, organization_id, cancelled_by, cancel_reason, cancellation_kind,
     created_at_snap, approved_at_snap, amount_snap, cashbook_snap)
  VALUES (v.id, v.organization_id, v_actor, v_reason, v_cancel, v.created_at, v.approved_at, v.total_amount, v.account_id)
  ON CONFLICT (income_expense_id) DO NOTHING;

  PERFORM app_private.append_income_expense_event_v1(
    v.organization_id, v.id, 'CANCELLED', v_actor, NULL, v.approval_status, 'CANCELLED', v_reason);

  v_bal_after := (app_private.profit_ledger_balance_v1(v.organization_id, v_kind, v_subject) ->> 'balance')::numeric;
  INSERT INTO app_private.profit_ledger_events (organization_id, event_kind, subject_kind, shareholder_id, manager_id,
    voucher_id, amount, balance_before, balance_after, actor_id, reason, payload)
  VALUES (v.organization_id, 'PAYOUT_CANCELLED', v_kind, v.shareholder_id, v.profit_manager_id,
    v.id, v.total_amount, v_bal_before, v_bal_after, v_actor, v_reason,
    jsonb_build_object('cancellation_kind', v_cancel, 'reversal_posting_id', v_rev,
                       'approval_status_before', v.approval_status, 'posting_status_before', v.posting_status));

  v_resp := jsonb_build_object('voucher_id', v.id, 'changed', true, 'cancellation_kind', v_cancel,
                               'reversal_posting_id', v_rev, 'balance_after', v_bal_after);
  UPDATE app_private.canonical_write_operations o
     SET subject_id = v.id, response_payload = v_resp, completed_at = now(), outcome_kind = v_cancel
   WHERE o.organization_id = v.organization_id AND o.operation = 'shareholder_profit.ledger_cancel.v1'
     AND o.subject_scope = p_voucher_id::text AND o.actor_id = v_actor AND o.idempotency_key = p_idempotency_key;
  RETURN v_resp;
END
$fn$;

-- ── 6. ACL ───────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION app_private.profit_ledger_chan_changed_columns_v1(jsonb, jsonb, text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_ledger_chan_assert_route_v1(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_profit_ledger_payout_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_profit_ledger_post_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_profit_ledger_payout_item_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_profit_ledger_request_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.profit_ledger_payout_cancel_v1(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.profit_ledger_payout_cancel_v1(uuid, text, text, text) TO authenticated;

COMMENT ON FUNCTION app_private.guard_profit_ledger_payout_v1() IS
  'F1 (trigger a06_profit_ledger_payout_guard): phiếu chi theo sổ tổng chỉ được DUYỆT (route CANONICAL, qua RPC vòng đời V2, phiếu còn sống, người duyệt khác người lập và người nhận, có quyền chi; khoá công ty → khoá sổ → tính lại, ghi PAYOUT_APPROVED) và GHI SỔ (CANONICAL, V2, đúng sổ quỹ lúc lập, người ghi khác người nhận trừ tạm ứng của người giữ sổ; ghi PAYOUT_POSTED); lúc nào cũng cho đã kiểm / bàn giao / ảnh-ghi chú / cột máy tính; ngữ cảnh lập giữ chờ duyệt; ngữ cảnh huỷ chỉ sang CANCELLED; không xoá.';
COMMENT ON FUNCTION app_private.guard_profit_ledger_post_v1() IS
  'F1b (trigger a85z_profit_ledger_post_guard, ngay sau cầu a85): phiếu chi theo sổ tổng đổi posting_status / active_posting_id_v2 / reversed_by_posting_id mà giao dịch không có token FINANCE_V2_LIFECYCLE của chính phiếu ⇒ 55000 PROFIT_LEDGER_V2_ONLY (chặn bút toán cầu a85 tự sinh hoặc tự đảo sau lưng F1).';
COMMENT ON FUNCTION app_private.guard_profit_ledger_payout_item_v1() IS
  'F2 (trigger a06_profit_ledger_payout_item_guard): dòng hạng mục của phiếu chi theo sổ tổng không thêm / sửa / xoá được, trừ ngữ cảnh lập.';
COMMENT ON FUNCTION app_private.guard_profit_ledger_request_v1() IS
  'F5 (trigger a06_profit_ledger_request_guard): yêu cầu duyệt đang chờ của phiếu chi theo sổ tổng không rút / đóng được ngoài ngữ cảnh huỷ; bị từ chối thì ghi PAYOUT_REJECTED.';
COMMENT ON FUNCTION public.profit_ledger_payout_cancel_v1(uuid, text, text, text) IS
  'E6: huỷ phiếu chi theo sổ tổng (cổ đông: shareholder_profit.distribute; lương điều hành: shareholder_profit.pay_manager; người lập huỷ được phiếu chờ duyệt của mình; phiếu đã duyệt thì người nhận không tự huỷ; phiếu đã ghi sổ thì người huỷ phải giữ đúng sổ quỹ). Lý do 8..1000 ký tự. p_expected_state (PENDING / APPROVED_UNPOSTED / POSTED, web luôn truyền) khác trạng thái thật dưới khoá hàng ⇒ PT409 PROFIT_LEDGER_CANCEL_STATE_CHANGED {expected, actual}, không huỷ. Chạy ở mọi route của cờ; vẫn bị chặn khi sổ quỹ đã chốt, phiếu nằm trong bàn giao, tháng lợi nhuận đã chốt. Đã ghi sổ ⇒ bút toán đảo về sổ quỹ. Trả {voucher_id, changed, cancellation_kind, reversal_posting_id, balance_after}.';

-- Z. Hậu kiểm. Đúng ở cả lượt một lẫn lượt chạy lại.
DO $assert$
DECLARE
  v_xau text;
BEGIN
  -- Bốn trigger đúng bảng, đúng thời điểm, đúng sự kiện, đang bật, có điều kiện WHEN đúng chỗ.
  SELECT string_agg(x.ten, ', ') INTO v_xau
    FROM (VALUES
      -- pg_get_triggerdef in sự kiện theo thứ tự INSERT, DELETE, UPDATE.
      ('a06_profit_ledger_payout_guard', 'public.income_expenses', 'app_private.guard_profit_ledger_payout_v1()', true,
         'BEFORE DELETE OR UPDATE', 'system_source'),
      ('a85z_profit_ledger_post_guard', 'public.income_expenses', 'app_private.guard_profit_ledger_post_v1()', true,
         'BEFORE UPDATE ON public.income_expenses', 'system_source'),
      ('a06_profit_ledger_payout_item_guard', 'public.income_expense_items', 'app_private.guard_profit_ledger_payout_item_v1()', false,
         'BEFORE INSERT OR DELETE OR UPDATE', NULL),
      ('a06_profit_ledger_request_guard', 'public.approval_requests', 'app_private.guard_profit_ledger_request_v1()', true,
         'BEFORE UPDATE OF state', 'PENDING_APPROVAL')
    ) AS x(ten, bang, ham, co_when, su_kien, tu_when)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgname = x.ten
        AND t.tgrelid = to_regclass(x.bang)
        AND t.tgfoid = to_regprocedure(x.ham)
        AND t.tgenabled = 'O'
        AND NOT t.tgisinternal
        AND (t.tgtype & 1) = 1                                   -- FOR EACH ROW
        AND (t.tgqual IS NOT NULL) = x.co_when
        AND position(x.su_kien IN pg_get_triggerdef(t.oid)) > 0
        AND (x.tu_when IS NULL OR position(x.tu_when IN pg_get_triggerdef(t.oid)) > 0));
  IF v_xau IS NOT NULL THEN
    RAISE EXCEPTION 'Hậu kiểm: trigger thiếu hoặc sai hình dạng: %', v_xau USING ERRCODE = '55000';
  END IF;

  -- F1b chạy NGAY SAU cầu a85 trong chuỗi BEFORE UPDATE: trigger BEFORE UPDATE theo dòng liền trước nó (theo tên,
  -- byte) phải là cầu finance_v2_auto_posting_bridge.
  IF (SELECT x.truoc_do
        FROM (SELECT t.tgname, t.tgfoid,
                     lag(t.tgfoid) OVER (ORDER BY t.tgname::text COLLATE "C") AS truoc_do
                FROM pg_catalog.pg_trigger t
               WHERE t.tgrelid = 'public.income_expenses'::regclass AND NOT t.tgisinternal
                 AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16) x
       WHERE x.tgname = 'a85z_profit_ledger_post_guard')
     IS DISTINCT FROM to_regprocedure('app_private.finance_v2_auto_posting_bridge()')::oid THEN
    RAISE EXCEPTION 'Hậu kiểm: a85z_profit_ledger_post_guard không đứng ngay sau cầu finance_v2_auto_posting_bridge'
      USING ERRCODE = '55000';
  END IF;

  -- Hàm nội bộ: ghim search_path, không ai ngoài chủ hàm có EXECUTE (kể cả PUBLIC).
  SELECT string_agg(f.ten, ', ') INTO v_xau
    FROM unnest(ARRAY[
      'app_private.profit_ledger_chan_changed_columns_v1(jsonb,jsonb,text[])',
      'app_private.profit_ledger_chan_assert_route_v1(uuid,text)',
      'app_private.guard_profit_ledger_payout_v1()',
      'app_private.guard_profit_ledger_post_v1()',
      'app_private.guard_profit_ledger_payout_item_v1()',
      'app_private.guard_profit_ledger_request_v1()']) AS f(ten)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(f.ten)
   WHERE p.oid IS NULL
      OR p.proacl IS NULL
      OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner)
      OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%');
  IF v_xau IS NOT NULL THEN
    RAISE EXCEPTION 'Hậu kiểm: hàm nội bộ thiếu, chưa ghim search_path hoặc còn EXECUTE cho vai khác: %', v_xau
      USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p
       WHERE p.oid IN (to_regprocedure('app_private.guard_profit_ledger_payout_v1()'),
                       to_regprocedure('app_private.guard_profit_ledger_post_v1()'),
                       to_regprocedure('app_private.guard_profit_ledger_payout_item_v1()'),
                       to_regprocedure('app_private.guard_profit_ledger_request_v1()'))
         AND p.prosecdef) <> 4 THEN
    RAISE EXCEPTION 'Hậu kiểm: hàm trigger chốt chặn phải SECURITY DEFINER' USING ERRCODE = '55000';
  END IF;

  -- E6: đúng MỘT bản — 4 tham số đúng tên (PostgREST gọi theo tên), tham số cuối có DEFAULT (lời gọi 3 tham số cũ vẫn chạy,
  -- không mơ hồ); VOLATILE, DEFINER, ghim search_path; authenticated gọi được; anon / PUBLIC thì không.
  IF (SELECT count(*) FROM pg_catalog.pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'profit_ledger_payout_cancel_v1') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid = to_regprocedure('public.profit_ledger_payout_cancel_v1(uuid,text,text,text)')
          AND p.provolatile = 'v' AND p.prosecdef
          AND p.prorettype = 'jsonb'::regtype
          AND p.pronargdefaults = 1
          AND p.proargnames = ARRAY['p_voucher_id', 'p_reason', 'p_idempotency_key', 'p_expected_state']::text[]
          AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%'))
     OR NOT has_function_privilege('authenticated', 'public.profit_ledger_payout_cancel_v1(uuid,text,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.profit_ledger_payout_cancel_v1(uuid,text,text,text)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid = to_regprocedure('public.profit_ledger_payout_cancel_v1(uuid,text,text,text)') AND a.grantee = 0) THEN
    RAISE EXCEPTION 'Hậu kiểm: public.profit_ledger_payout_cancel_v1 phải còn đúng một bản (uuid, text, text, text DEFAULT), VOLATILE, DEFINER, ghim search_path, đúng ACL'
      USING ERRCODE = '55000';
  END IF;
END
$assert$;

COMMIT;
