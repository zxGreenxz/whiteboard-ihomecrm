-- =============================================================================
-- Sổ tổng lợi nhuận — lệnh huỷ phiếu E6 không trả số dư của chủ thể cho người lập hộ.
--
-- VÌ SAO
--   Tạm ứng cổ đông (20261118041911) cho NGƯỜI GIỮ SỔ lập phiếu tạm ứng hộ một cổ đông KHÁC (dòng sổ
--   app_private.profit_ledger_payouts.maker_kind = 'CUSTODIAN_FOR_PAYEE'). Thiết kế: người lập hộ không được thấy
--   số của cổ đông — lệnh lập (shareholder_profit_advance_v1) và xem trước (shareholder_profit_advance_preview_v1)
--   đã che: balance_before null, bỏ cảnh báo mang số, lỗi không kèm DETAIL.
--   Lệnh huỷ E6 public.profit_ledger_payout_cancel_v1 (trước file này chỉ định nghĩa ở 20261115084015) cho
--   NGƯỜI LẬP huỷ phiếu còn chờ duyệt của mình dù không có quyền chi lợi nhuận, và trả balance_after = số dư RÒNG
--   của chủ thể cho MỌI người gọi (nhánh phiếu đã huỷ từ trước lẫn nhánh huỷ thật). Người giữ sổ lập hộ gọi thẳng
--   RPC trên phiếu chờ của mình là đọc được số dư của cổ đông. Giấu ở giao diện không phải hàng rào (RPC gọi thẳng
--   được) — chặn ở máy chủ.
--
-- LÀM GÌ
--   CREATE OR REPLACE đúng chữ ký E6 (uuid, text, text, text DEFAULT NULL). Thân CHÉP NGUYÊN VĂN bản đang chạy
--   production (thân của 20261115084015, md5 6aa54350…), chỉ đổi:
--     - thêm biến v_see_numbers, tính NGAY SAU bước kiểm quyền (3): có quyền chi của đúng loại chủ thể (v_allowed —
--       shareholder_profit.distribute / shareholder_profit.pay_manager) HOẶC người gọi là NGƯỜI NHẬN (đăng nhập hiện
--       tại của cổ đông / người nhận lương điều hành, hoặc payee_user_id lúc lập — cùng cách nhánh phiếu đã duyệt xác
--       định người nhận);
--     - hai chỗ dựng kết quả: 'balance_after', CASE WHEN v_see_numbers THEN <biểu thức cũ> END — null khi không được
--       thấy. Kết quả lưu vào canonical_write_operations.response_payload để phát lại là bản đã che.
--   COMMENT của hàm thêm một câu về balance_after.
--
-- KHÔNG LÀM
--   Không đổi luật quyền (ai huỷ được phiếu nào), thứ tự khoá, mã lỗi, nhật ký profit_ledger_events (vẫn ghi đủ
--   balance_before / balance_after — bảng nội bộ), ACL (CREATE OR REPLACE giữ nguyên; hậu kiểm so với lúc trước),
--   SECURITY DEFINER, search_path, chữ ký / DEFAULT. Không sửa hàm nào khác, không sửa dữ liệu. Kết quả đã lưu để
--   phát lại TRƯỚC migration này giữ nguyên (phát lại trả đúng cái đã trả).
--   Hệ quả của luật che (không phải đổi luật quyền): người lập phiếu đã mất quyền chi của loại chủ thể (thu hồi /
--   chặn khẩn cấp sau khi lập) mà không phải người nhận vẫn huỷ được phiếu chờ của mình, nhưng nhận null.
--
-- AN TOÀN CHẠY LẠI
--   Tiền kiểm chỉ so md5 thân (prosrc, bỏ CR) của E6 đang chạy: phải là thân của 20261115084015 (lượt đầu) hoặc thân
--   của chính file này (lượt chạy lại); khác ⇒ 55000, không ghi gì (chống ghi đè một bản đã đổi ngoài luồng). Không
--   so ACL với một giá trị cố định, không khẳng định dữ liệu (bản dựng lại của diễn tập khôi phục: ACL theo nền dựng
--   lại, bảng rỗng). CREATE OR REPLACE + COMMENT ON chạy lại không đổi gì; hậu kiểm đúng ở cả hai lượt.
--
-- LÙI (migration forward mới): CREATE OR REPLACE public.profit_ledger_payout_cancel_v1 bằng nguyên văn câu tạo hàm
--   của 20261115084015 (thân md5 6aa54350…) kèm COMMENT cũ của file đó. Không phá dữ liệu; ACL không đổi.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 0. Tiền kiểm: E6 đang chạy phải đúng thân đã rà. Chỉ so prosrc; ghi lại ACL / chủ hàm để hậu kiểm so tương đối.
DO $truoc$
DECLARE
  c_e6  constant regprocedure := to_regprocedure('public.profit_ledger_payout_cancel_v1(uuid,text,text,text)');
  v_md5 text;
BEGIN
  IF c_e6 IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.profit_ledger_payout_cancel_v1(uuid, text, text, text) — 20261115084015 phải áp trước'
      USING ERRCODE = '55000';
  END IF;
  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = c_e6;
  -- 6aa54350…: thân của 20261115084015 — bản đang chạy production (đo 18/11/2026).
  -- 7b3e96d1…: thân của chính file này (lượt chạy lại).
  IF v_md5 IS NULL OR v_md5 NOT IN ('6aa543506cb425c33c9963789aa0365a', '7b3e96d1d8cfec6d91d1c65ca7c810b1') THEN
    RAISE EXCEPTION 'public.profit_ledger_payout_cancel_v1 KHÁC thân đã rà (md5 %) — DỪNG, đối chiếu thân đang chạy rồi rà lại', v_md5
      USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('ihomecrm.e6_che_so_du.acl_truoc',
    (SELECT COALESCE(p.proacl::text, '<mặc định>') || ' | ' || p.proowner::regrole::text FROM pg_catalog.pg_proc p WHERE p.oid = c_e6),
    true);
END
$truoc$;

-- ── 1. E6: thân 20261115084015 nguyên văn + che balance_after cho người không được thấy số ──────
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
  v_see_numbers boolean;
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
  -- Số dư của chủ thể (balance_after) chỉ trả cho người có quyền chi của đúng loại chủ thể, hoặc cho chính người nhận:
  -- đăng nhập HIỆN TẠI của cổ đông / người nhận lương điều hành, hoặc đăng nhập lúc lập (C2) — như nhánh phiếu đã duyệt
  -- ở dưới xác định người nhận. Người lập không có quyền chi (người giữ sổ lập hộ CUSTODIAN_FOR_PAYEE) huỷ được phiếu
  -- chờ của mình nhưng nhận null; kết quả lưu để phát lại cũng là bản đã che. Nhật ký profit_ledger_events vẫn ghi đủ số.
  v_see_numbers := COALESCE(v_allowed, false)
    OR COALESCE(v_actor = CASE v_kind
                            WHEN 'SHAREHOLDER' THEN (SELECT s.auth_user_id FROM public.shareholders s WHERE s.id = v_subject)
                            ELSE (SELECT m.auth_user_id FROM public.profit_managers m WHERE m.id = v_subject) END, false)
    OR COALESCE(v_has_p AND v_actor = v_p.payee_user_id, false);

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
      'balance_after', CASE WHEN v_see_numbers THEN
        (app_private.profit_ledger_balance_v1(v.organization_id, v_kind, v_subject) ->> 'balance')::numeric END);
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
                               'reversal_posting_id', v_rev, 'balance_after', CASE WHEN v_see_numbers THEN v_bal_after END);
  UPDATE app_private.canonical_write_operations o
     SET subject_id = v.id, response_payload = v_resp, completed_at = now(), outcome_kind = v_cancel
   WHERE o.organization_id = v.organization_id AND o.operation = 'shareholder_profit.ledger_cancel.v1'
     AND o.subject_scope = p_voucher_id::text AND o.actor_id = v_actor AND o.idempotency_key = p_idempotency_key;
  RETURN v_resp;
END
$fn$;

COMMENT ON FUNCTION public.profit_ledger_payout_cancel_v1(uuid, text, text, text) IS
  'E6: huỷ phiếu chi theo sổ tổng (cổ đông: shareholder_profit.distribute; lương điều hành: shareholder_profit.pay_manager; người lập huỷ được phiếu chờ duyệt của mình; phiếu đã duyệt thì người nhận không tự huỷ; phiếu đã ghi sổ thì người huỷ phải giữ đúng sổ quỹ). Lý do 8..1000 ký tự. p_expected_state (PENDING / APPROVED_UNPOSTED / POSTED, web luôn truyền) khác trạng thái thật dưới khoá hàng ⇒ PT409 PROFIT_LEDGER_CANCEL_STATE_CHANGED {expected, actual}, không huỷ. Chạy ở mọi route của cờ; vẫn bị chặn khi sổ quỹ đã chốt, phiếu nằm trong bàn giao, tháng lợi nhuận đã chốt. Đã ghi sổ ⇒ bút toán đảo về sổ quỹ. Trả {voucher_id, changed, cancellation_kind, reversal_posting_id, balance_after}. balance_after chỉ trả cho người có quyền chi của loại chủ thể hoặc chính người nhận; người lập hộ nhận null.';

-- Z. Hậu kiểm. Đúng ở cả lượt một lẫn lượt chạy lại.
DO $sau$
DECLARE
  c_e6  constant regprocedure := to_regprocedure('public.profit_ledger_payout_cancel_v1(uuid,text,text,text)');
  v_md5 text;
BEGIN
  -- Đúng MỘT bản E6, hình dạng như cũ: 4 tham số đúng tên, tham số cuối có DEFAULT, trả jsonb, VOLATILE, DEFINER,
  -- search_path như cũ.
  IF (SELECT count(*) FROM pg_catalog.pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'profit_ledger_payout_cancel_v1') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid = c_e6
          AND p.provolatile = 'v' AND p.prosecdef
          AND p.prorettype = 'jsonb'::regtype
          AND p.pronargdefaults = 1
          AND p.proargnames = ARRAY['p_voucher_id', 'p_reason', 'p_idempotency_key', 'p_expected_state']::text[]
          AND p.proconfig = ARRAY['search_path=pg_catalog, app_private, public']::text[]) THEN
    RAISE EXCEPTION 'Hậu kiểm: public.profit_ledger_payout_cancel_v1 phải còn đúng một bản (uuid, text, text, text DEFAULT), jsonb, VOLATILE, DEFINER, search_path như cũ'
      USING ERRCODE = '55000';
  END IF;

  -- Thân đúng bản của file này (nguyên văn 20261115084015 + biến v_see_numbers + hai chỗ che balance_after).
  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = c_e6;
  IF v_md5 IS DISTINCT FROM '7b3e96d1d8cfec6d91d1c65ca7c810b1' THEN
    RAISE EXCEPTION 'Hậu kiểm: thân public.profit_ledger_payout_cancel_v1 không phải bản của file này (md5 %)', v_md5
      USING ERRCODE = '55000';
  END IF;

  -- ACL và chủ hàm như lúc trước khi chạy (CREATE OR REPLACE không đổi quyền gọi); authenticated gọi được, anon / PUBLIC
  -- thì không.
  IF (SELECT COALESCE(p.proacl::text, '<mặc định>') || ' | ' || p.proowner::regrole::text FROM pg_catalog.pg_proc p WHERE p.oid = c_e6)
       IS DISTINCT FROM current_setting('ihomecrm.e6_che_so_du.acl_truoc', true)
     OR NOT has_function_privilege('authenticated', c_e6, 'EXECUTE')
     OR has_function_privilege('anon', c_e6, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(p.proacl) a WHERE p.oid = c_e6 AND a.grantee = 0) THEN
    RAISE EXCEPTION 'Hậu kiểm: quyền gọi public.profit_ledger_payout_cancel_v1 đổi so với trước khi chạy, hoặc sai (authenticated phải gọi được; anon / PUBLIC thì không)'
      USING ERRCODE = '55000';
  END IF;

  IF position('người lập hộ nhận null' IN COALESCE(obj_description(c_e6, 'pg_proc'), '')) = 0 THEN
    RAISE EXCEPTION 'Hậu kiểm: COMMENT của public.profit_ledger_payout_cancel_v1 chưa nêu cách che balance_after'
      USING ERRCODE = '55000';
  END IF;
END
$sau$;

COMMIT;
