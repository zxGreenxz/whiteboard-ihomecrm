-- =============================================================================
-- Sổ tổng lợi nhuận — dọn dẹp sau "tạm ứng cổ đông + chốt chi lợi nhuận theo tháng" (phần MÁY CHỦ).
--
-- VÌ SAO
--   Web mới của 20261118041911 (tạm ứng ở Thu chi, chủ chốt chi lợi nhuận theo tháng) và 20261118143113 (E6 che số dư) đã
--   lên production và KHÔNG còn gọi hai lệnh cũ của cổ đông. Review hai migration đó để lại ba việc:
--   (1) E5 public.shareholder_profit_ledger_payout_v1 (lập phiếu chi lợi nhuận cổ đông theo SỐ TIỀN NHẬP TAY) và E4
--       public.shareholder_profit_payout_preview_v1 (xem trước của nó) vẫn cấp EXECUTE cho authenticated. Chi lợi nhuận
--       nay đi qua điểm chốt theo tháng (không nhập tay số tiền); để mở thì gọi thẳng RPC vẫn lập được phiếu theo số nhập
--       tay. 20261118041911 hẹn thu quyền lệnh cũ ở "migration sau, khi web mới đã lên production" — là file này.
--   (2) E6 public.profit_ledger_payout_cancel_v1 trả balance_after = số dư HIỆN TẠI của chủ thể cho cả đăng nhập LÚC LẬP
--       của người nhận (app_private.profit_ledger_payouts.payee_user_id). Cổ đông được gắn sang tài khoản khác mà tài
--       khoản cũ vẫn là thành viên công ty: tài khoản cũ gọi lại E6 trên phiếu đã huỷ bằng khoá mới là đọc được số dư hiện
--       tại của cổ đông dù không còn là cổ đông đó.
--   (3) R4 public.shareholder_profit_advance_preview_v1 (mọi thành viên ACTIVE của công ty gọi được) gọi
--       app_private.profit_ledger_position_v1 cho mọi người gọi. Bất biến số dư lệch thì hàm đó ném XX000
--       PROFIT_LEDGER_POSITION_DRIFT kèm DETAIL đủ các con số của cổ đông, và PostgREST trả DETAIL cho cả người không được
--       thấy số (người giữ sổ lập hộ, thành viên không giữ sổ): R4 che position nhưng không che lỗi.
--
-- LÀM GÌ
--   1. REVOKE EXECUTE trên E4, E5 FROM authenticated. Không DROP, không đổi thân; mục ACL của mọi vai khác giữ nguyên
--      (production đo 18/11/2026: cả hai chỉ có postgres=X và authenticated=X). Không hàm SQL nào gọi E4 / E5 (đo
--      production: prosrc, pg_depend); hàm DEFINER nào gọi về sau chạy bằng quyền chủ hàm, không bị revoke này chặn.
--   2. E6: CREATE OR REPLACE đúng chữ ký (uuid, text, text, text DEFAULT NULL). Thân CHÉP NGUYÊN VĂN 20261118143113
--      (md5 7b3e96d1…, bằng production), chỉ đổi phép gán v_see_numbers cùng khối chú thích ngay trên nó: bỏ vế "người gọi
--      = payee_user_id lúc lập". Còn: quyền chi của đúng loại chủ thể (v_allowed) HOẶC người gọi là đăng nhập HIỆN TẠI của
--      cổ đông / người nhận lương điều hành. Nhánh phiếu đã duyệt vẫn dùng CẢ hai đăng nhập để CHẶN người nhận tự huỷ
--      (không đổi). COMMENT: câu về balance_after nói rõ "đăng nhập hiện tại".
--   3. R4: CREATE OR REPLACE đúng chữ ký. Thân CHÉP NGUYÊN VĂN 20261118041911 (md5 d1c1212f…, bằng production), chỉ bọc
--      lời gọi profit_ledger_position_v1: lỗi XX000 PROFIT_LEDGER_POSITION_DRIFT khi người gọi KHÔNG được thấy số
--      (v_see_numbers R4 đang tính, không đổi) ⇒ ném lại cùng mã + cùng câu, KHÔNG DETAIL; người được thấy số và mọi lỗi
--      khác ⇒ ném nguyên. COMMENT thêm một câu.
--   Các RPC public khác chạm profit_ledger_position_v1 / profit_ledger_chot_months_v1 (rà production 18/11/2026):
--   R1 shareholder_profit_positions_v1 (distribute | lock | unlock | manage_shareholders — người qua cửa được xem đủ vị
--   thế mọi cổ đông), R2 shareholder_profit_my_position_v1 (chính cổ đông, số của mình), R5 / W2 (kiểm distribute TRƯỚC
--   khi đọc vị thế). DETAIL của DRIFT ở đó không cho người gọi thấy gì ngoài số họ đã được xem ⇒ không sửa.
--
-- KHÔNG LÀM
--   Không sửa profit_ledger_position_v1 hay hàm nào khác; không đổi luật quyền, thứ tự khoá, mã lỗi khác, nhật ký; không đổi
--   ACL / chủ hàm / SECURITY DEFINER / search_path / chữ ký / DEFAULT của E6, R4 (CREATE OR REPLACE giữ nguyên; hậu kiểm so
--   với lúc trước). Không thu quyền của chủ hàm / vai khác trên E4, E5. Không sửa dữ liệu. Kết quả E6 đã lưu để phát lại
--   TRƯỚC migration này giữ nguyên (gửi lại đúng khoá cũ trả đúng cái đã trả).
--
-- AN TOÀN CHẠY LẠI
--   Tiền kiểm: E4, E5, E6, R4 phải có (đúng chữ ký); md5 thân (prosrc, bỏ CR) của E6 và R4 đang chạy phải là bản production
--   (lượt đầu) hoặc thân của chính file này (lượt chạy lại); khác ⇒ 55000, không ghi gì (chống ghi đè một bản đã đổi ngoài
--   luồng). Không khẳng định dữ liệu; không so ACL với giá trị cố định (bản dựng lại của diễn tập khôi phục có ACL theo nền
--   dựng lại) — chụp ACL + chủ hàm lúc trước rồi hậu kiểm so tương đối. REVOKE / CREATE OR REPLACE / COMMENT ON chạy lại
--   không đổi gì; hậu kiểm đúng ở cả hai lượt.
--
-- LÙI (migration forward mới, không phá dữ liệu): GRANT EXECUTE trên E4, E5 TO authenticated (chỉ khi web cũ quay lại);
--   CREATE OR REPLACE E6 bằng nguyên văn câu tạo hàm của 20261118143113 (md5 7b3e96d1…) kèm COMMENT của file đó;
--   CREATE OR REPLACE R4 bằng nguyên văn câu tạo hàm của 20261118041911 (md5 d1c1212f…) kèm COMMENT của file đó. ACL của
--   E6 / R4 không đổi.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 0. Tiền kiểm: bốn hàm phải có; thân E6 / R4 phải đúng bản đã rà. Chụp ACL / chủ hàm lúc trước để hậu kiểm so tương đối.
DO $truoc$
DECLARE
  c_e4  constant regprocedure := to_regprocedure('public.shareholder_profit_payout_preview_v1(uuid,numeric,uuid)');
  c_e5  constant regprocedure := to_regprocedure('public.shareholder_profit_ledger_payout_v1(uuid,numeric,uuid,date,text,boolean,text)');
  c_e6  constant regprocedure := to_regprocedure('public.profit_ledger_payout_cancel_v1(uuid,text,text,text)');
  c_r4  constant regprocedure := to_regprocedure('public.shareholder_profit_advance_preview_v1(uuid,numeric,uuid)');
  v_md5 text;
BEGIN
  IF c_e4 IS NULL OR c_e5 IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.shareholder_profit_payout_preview_v1(uuid, numeric, uuid) hoặc public.shareholder_profit_ledger_payout_v1(uuid, numeric, uuid, date, text, boolean, text) — 20261115084108 phải áp trước'
      USING ERRCODE = '55000';
  END IF;
  IF c_e6 IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.profit_ledger_payout_cancel_v1(uuid, text, text, text) — 20261118143113 phải áp trước'
      USING ERRCODE = '55000';
  END IF;
  IF c_r4 IS NULL OR to_regprocedure('app_private.profit_ledger_position_v1(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.shareholder_profit_advance_preview_v1(uuid, numeric, uuid) hoặc app_private.profit_ledger_position_v1(uuid, uuid) — 20261118041911 phải áp trước'
      USING ERRCODE = '55000';
  END IF;

  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = c_e6;
  -- 7b3e96d1…: thân của 20261118143113 — bản đang chạy production (đo 18/11/2026). a990969e…: thân của chính file này.
  IF v_md5 IS NULL OR v_md5 NOT IN ('7b3e96d1d8cfec6d91d1c65ca7c810b1', 'a990969e40681a12aacd70acf4bb78f1') THEN
    RAISE EXCEPTION 'public.profit_ledger_payout_cancel_v1 KHÁC thân đã rà (md5 %) — DỪNG, đối chiếu thân đang chạy rồi rà lại', v_md5
      USING ERRCODE = '55000';
  END IF;
  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = c_r4;
  -- d1c1212f…: thân của 20261118041911 — bản đang chạy production (đo 18/11/2026). 8eaf415b…: thân của chính file này.
  IF v_md5 IS NULL OR v_md5 NOT IN ('d1c1212f15b45b896187b601a28155b3', '8eaf415b8a13c4cd215c93857599a695') THEN
    RAISE EXCEPTION 'public.shareholder_profit_advance_preview_v1 KHÁC thân đã rà (md5 %) — DỪNG, đối chiếu thân đang chạy rồi rà lại', v_md5
      USING ERRCODE = '55000';
  END IF;

  -- E4 / E5: mọi mục ACL (proacl NULL ⇒ ACL mặc định) TRỪ mục của authenticated, chủ hàm, md5 thân.
  -- E6 / R4: nguyên ACL và chủ hàm.
  PERFORM set_config('ihomecrm.don_dep_tam_ung.' || x.k,
    (SELECT CASE WHEN x.k IN ('e4', 'e5') THEN
              (SELECT COALESCE(string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || '=' || a.privilege_type
                                            || CASE WHEN a.is_grantable THEN '*' ELSE '' END || '/' || a.grantor::regrole::text,
                                          ',' ORDER BY a.grantee, a.privilege_type, a.grantor), '<rỗng>')
                 FROM aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                WHERE a.grantee IS DISTINCT FROM 'authenticated'::regrole)
              || ' | ' || p.proowner::regrole::text || ' | ' || md5(replace(p.prosrc, chr(13), ''))
            ELSE COALESCE(p.proacl::text, '<mặc định>') || ' | ' || p.proowner::regrole::text END
       FROM pg_catalog.pg_proc p WHERE p.oid = x.oid),
    true)
    FROM (VALUES ('e4', c_e4::oid), ('e5', c_e5::oid), ('e6', c_e6::oid), ('r4', c_r4::oid)) AS x(k, oid);
END
$truoc$;

-- ── 1. E4 / E5: web không còn gọi — thu quyền gọi của authenticated, không đổi gì khác ─────────────────────────
REVOKE EXECUTE ON FUNCTION public.shareholder_profit_payout_preview_v1(uuid, numeric, uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.shareholder_profit_ledger_payout_v1(uuid, numeric, uuid, date, text, boolean, text) FROM authenticated;

-- ── 2. E6: thân 20261118143113 nguyên văn, trừ phép gán v_see_numbers (bỏ vế "đăng nhập lúc lập") ─────────────
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
  -- Số dư của chủ thể (balance_after) chỉ trả cho người có quyền chi của đúng loại chủ thể, hoặc cho chính người nhận
  -- theo đăng nhập HIỆN TẠI của cổ đông / người nhận lương điều hành. Đăng nhập lúc lập (C2 payee_user_id) KHÔNG tính:
  -- tài khoản cũ của cổ đông (cổ đông đã gắn sang tài khoản khác) không đọc được số dư hiện tại. Nhánh phiếu đã duyệt ở
  -- dưới vẫn xét CẢ hai đăng nhập — để CHẶN người nhận tự huỷ. Người lập không có quyền chi (người giữ sổ lập hộ
  -- CUSTODIAN_FOR_PAYEE) huỷ được phiếu chờ của mình nhưng nhận null; kết quả lưu để phát lại cũng là bản đã che. Nhật ký
  -- profit_ledger_events vẫn ghi đủ số.
  v_see_numbers := COALESCE(v_allowed, false)
    OR COALESCE(v_actor = CASE v_kind
                            WHEN 'SHAREHOLDER' THEN (SELECT s.auth_user_id FROM public.shareholders s WHERE s.id = v_subject)
                            ELSE (SELECT m.auth_user_id FROM public.profit_managers m WHERE m.id = v_subject) END, false);

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
  'E6: huỷ phiếu chi theo sổ tổng (cổ đông: shareholder_profit.distribute; lương điều hành: shareholder_profit.pay_manager; người lập huỷ được phiếu chờ duyệt của mình; phiếu đã duyệt thì người nhận không tự huỷ; phiếu đã ghi sổ thì người huỷ phải giữ đúng sổ quỹ). Lý do 8..1000 ký tự. p_expected_state (PENDING / APPROVED_UNPOSTED / POSTED, web luôn truyền) khác trạng thái thật dưới khoá hàng ⇒ PT409 PROFIT_LEDGER_CANCEL_STATE_CHANGED {expected, actual}, không huỷ. Chạy ở mọi route của cờ; vẫn bị chặn khi sổ quỹ đã chốt, phiếu nằm trong bàn giao, tháng lợi nhuận đã chốt. Đã ghi sổ ⇒ bút toán đảo về sổ quỹ. Trả {voucher_id, changed, cancellation_kind, reversal_posting_id, balance_after}. balance_after chỉ trả cho người có quyền chi của loại chủ thể hoặc chính người nhận theo đăng nhập hiện tại (đăng nhập lúc lập không tính); người lập hộ nhận null.';

-- ── 3. R4: thân 20261118041911 nguyên văn, trừ phần bọc lời gọi profit_ledger_position_v1 ──────────────────────
CREATE OR REPLACE FUNCTION public.shareholder_profit_advance_preview_v1(
  p_shareholder_id uuid,
  p_amount numeric,
  p_account_id uuid
) RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_actor       uuid := auth.uid();
  v_sh          record;
  v_membership  uuid;
  v_route       text;
  v_self        boolean;
  v_holds       boolean;
  v_right       boolean := false;
  v_see_numbers boolean := false;
  v_blocked     text;
  v_pos         jsonb;
  v_balance     numeric;
  v_warnings    jsonb := '[]'::jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NOT NULL
     AND (p_amount::text IN ('NaN', 'Infinity', '-Infinity') OR p_amount <= 0
          OR round(p_amount, 2) <> p_amount OR p_amount >= 10000000000000) THEN
    RAISE EXCEPTION 'Số tiền tạm ứng không hợp lệ' USING ERRCODE = '22023';
  END IF;

  SELECT s.organization_id, s.auth_user_id, s.is_active, s.deleted_at
    INTO v_sh
    FROM public.shareholders s
   WHERE s.id = p_shareholder_id;
  IF NOT FOUND OR v_sh.organization_id IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy cổ đông trong tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;
  SELECT m.id INTO v_membership
    FROM public.organization_memberships m
   WHERE m.user_id = v_actor
     AND m.organization_id = v_sh.organization_id
     AND m.status = 'ACTIVE'
     AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= clock_timestamp()
     AND (m.valid_to IS NULL OR m.valid_to > clock_timestamp())
   ORDER BY m.id
   LIMIT 1;
  IF v_membership IS NULL OR v_sh.deleted_at IS NOT NULL OR NOT v_sh.is_active THEN
    RAISE EXCEPTION 'Không tìm thấy cổ đông trong tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;
  IF p_account_id IS NOT NULL THEN
    PERFORM 1
      FROM public.accounts a
     WHERE a.id = p_account_id
       AND a.organization_id = v_sh.organization_id
       AND a.deleted_at IS NULL
       AND NOT a.is_virtual;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ quỹ tiền thật không hợp lệ hoặc không thuộc tổ chức' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_route := app_private.evaluate_feature_route('shareholder_profit.ledger_payout.v1', v_sh.organization_id);
  v_self := COALESCE(v_sh.auth_user_id = v_actor, false);

  -- Người gọi phải giữ sổ: sổ đã chọn, hoặc (chưa chọn sổ) ít nhất một sổ quỹ thật của công ty.
  IF p_account_id IS NOT NULL THEN
    v_holds := app_private.profit_ledger_chot_holds_cashbook_v1(v_sh.organization_id, p_account_id, v_membership);
  ELSE
    v_holds := EXISTS (
      SELECT 1 FROM public.accounts a
       WHERE a.organization_id = v_sh.organization_id AND a.deleted_at IS NULL AND NOT a.is_virtual
         AND app_private.profit_ledger_chot_holds_cashbook_v1(v_sh.organization_id, a.id, v_membership));
  END IF;
  -- Quyền của người nhận chỉ xét (và chỉ lộ ra) khi người gọi giữ sổ, là chính người nhận, hoặc có quyền chi lợi nhuận.
  v_see_numbers := app_private.profit_viewer_can_v1(v_sh.organization_id, 'shareholder_profit.distribute');
  IF v_holds OR v_self OR v_see_numbers THEN
    v_right := app_private.profit_ledger_chot_advance_right_v1(v_sh.organization_id, v_sh.auth_user_id);
  END IF;
  v_see_numbers := v_see_numbers OR (v_self AND v_right);

  -- Bất biến số dư lệch ⇒ profit_ledger_position_v1 ném XX000 PROFIT_LEDGER_POSITION_DRIFT, DETAIL là các con số của cổ
  -- đông. Người KHÔNG được thấy số (v_see_numbers ở trên) chỉ nhận lại cùng mã + cùng câu, KHÔNG DETAIL; người được thấy
  -- số, và mọi lỗi khác: ném nguyên.
  BEGIN
    v_pos := app_private.profit_ledger_position_v1(v_sh.organization_id, p_shareholder_id);
  EXCEPTION WHEN internal_error THEN
    IF v_see_numbers OR NOT starts_with(SQLERRM, 'PROFIT_LEDGER_POSITION_DRIFT:') THEN
      RAISE;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'XX000', MESSAGE = SQLERRM;
  END;
  v_balance := (v_pos ->> 'balance')::numeric;

  v_blocked := CASE
    WHEN v_route IS DISTINCT FROM 'CANONICAL' THEN 'ROUTE'
    WHEN NOT v_holds THEN 'NOT_CUSTODIAN'
    WHEN NOT v_right THEN 'PAYEE_NO_RIGHT'
    WHEN COALESCE((v_pos -> 'needs_review' ->> 'count')::integer, 0) > 0 THEN 'SALARY_REVIEW_PENDING' END;

  IF p_amount IS NOT NULL THEN
    v_warnings := app_private.profit_ledger_tao_warnings_v1(p_amount, GREATEST(p_amount - v_balance, 0),
                    app_private.profit_ledger_open_estimate_v1(v_sh.organization_id, p_shareholder_id));
    IF NOT v_see_numbers THEN
      -- Cảnh báo "vượt ước tính" mang số dư và ước tính của cổ đông: không trả cho người lập hộ.
      SELECT COALESCE(jsonb_agg(w.value ORDER BY w.ordinality), '[]'::jsonb) INTO v_warnings
        FROM jsonb_array_elements(v_warnings) WITH ORDINALITY AS w(value, ordinality)
       WHERE w.value ->> 'code' IS DISTINCT FROM 'ADVANCE_EXCEEDS_ESTIMATE';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'route', v_route,
    'shareholder_id', p_shareholder_id,
    'maker_kind', CASE WHEN v_self THEN 'CUSTODIAN_ADVANCE' ELSE 'CUSTODIAN_FOR_PAYEE' END,
    'payee_is_maker', v_self,
    'can_submit', v_blocked IS NULL AND p_amount IS NOT NULL AND p_account_id IS NOT NULL,
    'blocked_reason', v_blocked,
    'warnings', v_warnings,
    'position', CASE WHEN v_see_numbers THEN
      v_pos || jsonb_build_object('after_advance', CASE WHEN p_amount IS NOT NULL THEN jsonb_build_object(
        'advance_pending', (v_pos ->> 'advance_pending')::numeric + p_amount,
        'balance', v_balance - p_amount) END) END);
END
$fn$;

COMMENT ON FUNCTION public.shareholder_profit_advance_preview_v1(uuid, numeric, uuid) IS
  'Xem trước một phiếu tạm ứng cổ đông: cách lập, có lập được không, lý do chặn. Số của cổ đông (position, cảnh báo vượt ước tính) chỉ trả cho chính người nhận hoặc người có quyền chi lợi nhuận. Chỉ đọc; VOLATILE (gọi bằng POST). Bất biến số dư lệch (XX000 PROFIT_LEDGER_POSITION_DRIFT): người không được thấy số chỉ nhận mã + câu, không DETAIL.';

-- Z. Hậu kiểm. Đúng ở cả lượt một lẫn lượt chạy lại.
DO $sau$
DECLARE
  c_e4  constant regprocedure := to_regprocedure('public.shareholder_profit_payout_preview_v1(uuid,numeric,uuid)');
  c_e5  constant regprocedure := to_regprocedure('public.shareholder_profit_ledger_payout_v1(uuid,numeric,uuid,date,text,boolean,text)');
  c_e6  constant regprocedure := to_regprocedure('public.profit_ledger_payout_cancel_v1(uuid,text,text,text)');
  c_r4  constant regprocedure := to_regprocedure('public.shareholder_profit_advance_preview_v1(uuid,numeric,uuid)');
  v_xau text;
BEGIN
  -- 1. E4 / E5: authenticated KHÔNG còn EXECUTE (kể cả qua PUBLIC / vai cha) và không còn mục ACL nào; anon vẫn không gọi
  --    được; mục ACL của các vai khác, chủ hàm và thân như lúc trước.
  IF has_function_privilege('authenticated', c_e4, 'EXECUTE') OR has_function_privilege('authenticated', c_e5, 'EXECUTE')
     OR has_function_privilege('anon', c_e4, 'EXECUTE') OR has_function_privilege('anon', c_e5, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid IN (c_e4, c_e5) AND a.grantee = 'authenticated'::regrole) THEN
    RAISE EXCEPTION 'Hậu kiểm: authenticated (hoặc anon) vẫn gọi được public.shareholder_profit_payout_preview_v1 / public.shareholder_profit_ledger_payout_v1'
      USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(x.k, ', ' ORDER BY x.k) INTO v_xau
    FROM (VALUES ('e4', c_e4::oid), ('e5', c_e5::oid)) AS x(k, oid)
    JOIN pg_catalog.pg_proc p ON p.oid = x.oid
   WHERE (SELECT COALESCE(string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || '=' || a.privilege_type
                                       || CASE WHEN a.is_grantable THEN '*' ELSE '' END || '/' || a.grantor::regrole::text,
                                     ',' ORDER BY a.grantee, a.privilege_type, a.grantor), '<rỗng>')
            FROM aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
           WHERE a.grantee IS DISTINCT FROM 'authenticated'::regrole)
         || ' | ' || p.proowner::regrole::text || ' | ' || md5(replace(p.prosrc, chr(13), ''))
         IS DISTINCT FROM current_setting('ihomecrm.don_dep_tam_ung.' || x.k, true);
  IF v_xau IS NOT NULL THEN
    RAISE EXCEPTION 'Hậu kiểm: ACL của vai khác, chủ hàm hoặc thân đổi so với trước khi chạy: %', v_xau USING ERRCODE = '55000';
  END IF;

  -- 2. E6: đúng MỘT bản, hình dạng như cũ (4 tham số đúng tên, tham số cuối có DEFAULT, jsonb, VOLATILE, DEFINER,
  --    search_path); thân đúng bản của file này; ACL + chủ hàm như trước; authenticated gọi được, anon / PUBLIC thì không.
  IF (SELECT count(*) FROM pg_catalog.pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'profit_ledger_payout_cancel_v1') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid = c_e6
          AND p.provolatile = 'v' AND p.prosecdef AND NOT p.proretset
          AND p.prorettype = 'jsonb'::regtype
          AND p.pronargdefaults = 1
          AND p.proargnames = ARRAY['p_voucher_id', 'p_reason', 'p_idempotency_key', 'p_expected_state']::text[]
          AND p.proconfig = ARRAY['search_path=pg_catalog, app_private, public']::text[]) THEN
    RAISE EXCEPTION 'Hậu kiểm: public.profit_ledger_payout_cancel_v1 phải còn đúng một bản (uuid, text, text, text DEFAULT), jsonb, VOLATILE, DEFINER, search_path như cũ'
      USING ERRCODE = '55000';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_catalog.pg_proc p WHERE p.oid = c_e6) IS DISTINCT FROM 'a990969e40681a12aacd70acf4bb78f1' THEN
    RAISE EXCEPTION 'Hậu kiểm: thân public.profit_ledger_payout_cancel_v1 không phải bản của file này' USING ERRCODE = '55000';
  END IF;
  IF (SELECT COALESCE(p.proacl::text, '<mặc định>') || ' | ' || p.proowner::regrole::text FROM pg_catalog.pg_proc p WHERE p.oid = c_e6)
       IS DISTINCT FROM current_setting('ihomecrm.don_dep_tam_ung.e6', true)
     OR NOT has_function_privilege('authenticated', c_e6, 'EXECUTE')
     OR has_function_privilege('anon', c_e6, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(p.proacl) a WHERE p.oid = c_e6 AND a.grantee = 0) THEN
    RAISE EXCEPTION 'Hậu kiểm: quyền gọi public.profit_ledger_payout_cancel_v1 đổi so với trước khi chạy, hoặc sai (authenticated phải gọi được; anon / PUBLIC thì không)'
      USING ERRCODE = '55000';
  END IF;
  IF position('đăng nhập lúc lập không tính' IN COALESCE(obj_description(c_e6, 'pg_proc'), '')) = 0 THEN
    RAISE EXCEPTION 'Hậu kiểm: COMMENT của public.profit_ledger_payout_cancel_v1 chưa nêu luật balance_after mới' USING ERRCODE = '55000';
  END IF;

  -- 3. R4: như E6 — đúng một bản (3 tham số đúng tên, không DEFAULT), jsonb, VOLATILE, DEFINER, search_path; thân của file
  --    này; ACL + chủ hàm như trước; authenticated gọi được, anon / PUBLIC thì không.
  IF (SELECT count(*) FROM pg_catalog.pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'shareholder_profit_advance_preview_v1') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid = c_r4
          AND p.provolatile = 'v' AND p.prosecdef AND NOT p.proretset
          AND p.prorettype = 'jsonb'::regtype
          AND p.pronargdefaults = 0
          AND p.proargnames = ARRAY['p_shareholder_id', 'p_amount', 'p_account_id']::text[]
          AND p.proconfig = ARRAY['search_path=pg_catalog, app_private, public']::text[]) THEN
    RAISE EXCEPTION 'Hậu kiểm: public.shareholder_profit_advance_preview_v1 phải còn đúng một bản (uuid, numeric, uuid), jsonb, VOLATILE, DEFINER, search_path như cũ'
      USING ERRCODE = '55000';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_catalog.pg_proc p WHERE p.oid = c_r4) IS DISTINCT FROM '8eaf415b8a13c4cd215c93857599a695' THEN
    RAISE EXCEPTION 'Hậu kiểm: thân public.shareholder_profit_advance_preview_v1 không phải bản của file này' USING ERRCODE = '55000';
  END IF;
  IF (SELECT COALESCE(p.proacl::text, '<mặc định>') || ' | ' || p.proowner::regrole::text FROM pg_catalog.pg_proc p WHERE p.oid = c_r4)
       IS DISTINCT FROM current_setting('ihomecrm.don_dep_tam_ung.r4', true)
     OR NOT has_function_privilege('authenticated', c_r4, 'EXECUTE')
     OR has_function_privilege('anon', c_r4, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(p.proacl) a WHERE p.oid = c_r4 AND a.grantee = 0) THEN
    RAISE EXCEPTION 'Hậu kiểm: quyền gọi public.shareholder_profit_advance_preview_v1 đổi so với trước khi chạy, hoặc sai (authenticated phải gọi được; anon / PUBLIC thì không)'
      USING ERRCODE = '55000';
  END IF;
  IF position('không DETAIL' IN COALESCE(obj_description(c_r4, 'pg_proc'), '')) = 0 THEN
    RAISE EXCEPTION 'Hậu kiểm: COMMENT của public.shareholder_profit_advance_preview_v1 chưa nêu cách che lỗi DRIFT' USING ERRCODE = '55000';
  END IF;
END
$sau$;

COMMIT;

NOTIFY pgrst, 'reload schema';
