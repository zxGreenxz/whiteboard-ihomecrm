-- VÁ CỜ GHI SỔ + BỊT ĐƯỜNG GHI SỔ TRÙNG
--
-- Backfill 23/07 (`source_kind = LEGACY_BACKFILL`) tạo bút toán POSTING cho một
-- số phiếu nhưng KHÔNG đóng dấu `posting_status` / `active_posting_id_v2` trên
-- header. Tiền đã nằm trong sổ, nhưng cờ nói "chưa ghi sổ" nên phiếu vẫn hiện ở
-- hàng chờ ghi sổ. Org THẬT: 5 phiếu APPROVED (34.270.744đ — trong đó 2 phiếu
-- "Lương Tháng 5/2026" 34.206.744đ vào sổ ATam); org TEST y hệt vì là bản sao.
--
-- Vì sao nguy hiểm: bấm "Ghi sổ" trên các phiếu đó ĐI LỌT tới cùng —
--   * `post_approved_income_expense_v2` chỉ chặn bằng
--     `posting_status NOT IN ('UNPOSTED','REVERSED')`; với `NULL` thì biểu thức
--     ra NULL (không phải TRUE) nên KHÔNG raise → cả nhánh NULL cũng lọt.
--   * `finance_v2_post_manual_voucher` lấy `generation = MAX(gen) + 1`, mà
--     unique index `ux_ie_postings_subject_generation` chỉ chống trùng TRONG
--     CÙNG generation → bút toán thứ hai sinh ra hợp lệ.
-- ⇒ Tiền vào sổ LẦN HAI mà không có gì cản.
--
-- Migration làm hai việc:
--   A. Đóng dấu lại cờ cho phiếu APPROVED đã có bút toán chưa bị đảo.
--      THUẦN METADATA — không thêm/bớt/sửa một dòng bút toán nào, số dư mọi sổ
--      KHÔNG đổi một đồng.
--   B. Thêm chốt chặn trong `post_approved_income_expense_v2`: đã có bút toán
--      POSTING chưa bị đảo thì từ chối bằng 55000 kèm thông điệp rõ, thay vì âm
--      thầm sinh thế hệ mới.
--
-- CỐ Ý KHÔNG đụng phiếu CANCELLED còn treo bút toán chưa đảo (org THẬT: "chi
-- nháp test app 2", −200.000đ ở sổ ATam). Đảo bút toán đó LÀM ĐỔI SỐ DƯ SỔ THẬT
-- nên phải để chủ sở hữu quyết, không gộp vào bản vá kỹ thuật này.
--
-- ⚠ KHÔNG bọc BEGIN/COMMIT trong file này. Áp qua Management API kèm BEGIN…COMMIT
-- thì hàm KHÔNG đổi dù HTTP 200 — đúng án lệ "object biến mất sau khi apply".
-- Luôn kiểm lại catalog (pg_get_functiondef) sau khi apply, đừng tin mã trạng thái.

-- ── A. Đóng dấu cờ cho phiếu APPROVED đã thực sự có bút toán ──────────────────
--
-- Phải cấp token `ie_transition_authorization` TRƯỚC mỗi UPDATE: trigger
-- `a00_ie_owned_payload_freeze` đóng băng phiếu flow-owned (3/5 phiếu org THẬT
-- rơi vào diện này). Đây là cửa CHÍNH THỨC — cùng khuôn `approve_income_expense_v1`
-- dùng — và allowlist của guard đã bao đúng các cột lifecycle ta cần sửa.
-- Gói trong DO block để token và UPDATE nằm CÙNG một transaction
-- (`pg_current_xact_id()` phải khớp); PK của bảng token là income_expense_id nên
-- ON CONFLICT cập nhật lại xid.
--
-- Các trigger khác đã soát, không cái nào phản ứng:
--   * a85 auto-posting bridge — chỉ nghe approval_status/account_id/total_amount/
--     deleted_at; ta không đụng cột nào trong đó ⇒ KHÔNG sinh bút toán mới.
--   * a70 salary accrual — chỉ chạy khi approval_status ĐỔI; ta giữ nguyên APPROVED.
--   * a87 close-request sync — 6 phiếu không có approval_request PENDING nào.
DO $repair$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (p.voucher_id)
           p.voucher_id, p.id AS posting_id, p.created_at
    FROM public.income_expense_postings p
    JOIN public.income_expenses ie ON ie.id = p.voucher_id
    WHERE p.event_kind = 'POSTING'
      AND NOT EXISTS (
        SELECT 1 FROM public.income_expense_postings x
        WHERE x.reversal_of_id = p.id)
      AND ie.deleted_at IS NULL
      AND ie.approval_status = 'APPROVED'
      AND COALESCE(ie.posting_status, 'X') NOT IN ('POSTED', 'NOT_APPLICABLE')
    ORDER BY p.voucher_id, p.posting_generation DESC, p.created_at DESC
  LOOP
    INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
    VALUES (r.voucher_id, pg_current_xact_id(), 'POSTING_FLAG_REPAIR')
    ON CONFLICT (income_expense_id)
      DO UPDATE SET xid = EXCLUDED.xid, purpose = EXCLUDED.purpose,
                    granted_at = clock_timestamp();

    UPDATE public.income_expenses ie
       SET posting_status       = 'POSTED',
           active_posting_id_v2 = r.posting_id,
           posting_id           = COALESCE(ie.posting_id, r.posting_id),
           posted_at_v2         = COALESCE(ie.posted_at_v2, r.created_at),
           posting_mode         = COALESCE(ie.posting_mode, 'CASHBOOK'),
           updated_at           = now()
     WHERE ie.id = r.voucher_id;
  END LOOP;
END
$repair$;

-- ── B. Chốt chặn ghi sổ trùng ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.post_approved_income_expense_v2(input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_uid uuid;
  v_mid uuid;
  v_ie public.income_expenses;
  v_voucher uuid := (input->>'subjectId')::uuid;
  v_cashbook uuid := (input->>'cashbookId')::uuid;
  v_posted_on date := (input->>'postedOn')::date;
  v_idem text := input->>'idempotencyKey';
  v_exp_appr bigint := (input->>'expectedApprovalVersion')::bigint;
  v_exp_post bigint := (input->>'expectedPostingVersion')::bigint;
  v_evidence uuid[] := ARRAY(SELECT jsonb_array_elements_text(COALESCE(input->'evidenceIds','[]'::jsonb))::uuid);
  v_hash text := md5(input::text);
  v_op app_private.canonical_write_operations;
  v_posting_id uuid;
  v_new_post bigint;
  v_resp jsonb;
  v_live_posting uuid;
BEGIN
  IF COALESCE(input->>'subjectKind','VOUCHER') <> 'VOUCHER' THEN
    RAISE EXCEPTION 'post_approved_income_expense_v2: only VOUCHER subjects are supported here' USING ERRCODE = '22023';
  END IF;
  IF v_voucher IS NULL OR v_cashbook IS NULL OR v_posted_on IS NULL OR v_idem IS NULL THEN
    RAISE EXCEPTION 'post_approved_income_expense_v2: subjectId, cashbookId, postedOn, idempotencyKey are required' USING ERRCODE = '22023';
  END IF;

  -- Fixed lock order: voucher, then cashbook account.
  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = v_voucher FOR UPDATE;
  IF NOT FOUND OR v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'post_approved_income_expense_v2: voucher % not found', v_voucher USING ERRCODE = 'P0002';
  END IF;

  SELECT r.user_id, r.membership_id INTO v_uid, v_mid
  FROM app_private.resolve_finance_actor_v2(v_ie.organization_id) r;

  v_op := app_private.finance_v2_begin_canonical_op(
    v_ie.organization_id, 'income_expense.post.v2', v_voucher::text, v_uid, v_mid,
    v_idem, v_hash, v_voucher);
  IF v_op.completed_at IS NOT NULL THEN
    RETURN COALESCE(v_op.response_payload, '{}'::jsonb);
  END IF;

  PERFORM app_private.assert_income_expense_flow_owner_v2(v_voucher, 'CANONICAL_INCOME_EXPENSE');

  PERFORM 1 FROM public.accounts a WHERE a.id = v_cashbook AND a.organization_id = v_ie.organization_id
    AND a.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post_approved_income_expense_v2: cashbook % not found', v_cashbook USING ERRCODE = '42501';
  END IF;

  -- CUSTODIAN of the exact cashbook; no approve capability needed.
  PERFORM app_private.assert_cashbook_access_v2(v_ie.organization_id, v_cashbook, 'CUSTODIAN', v_mid);

  IF v_ie.posting_mode IS DISTINCT FROM 'CASHBOOK' THEN
    RAISE EXCEPTION 'post_approved_income_expense_v2: only CASHBOOK vouchers can be posted' USING ERRCODE = '55000';
  END IF;

  -- CHỐT CHẶN GHI SỔ TRÙNG (bổ sung 02/08/2026).
  -- Cờ header từng bị backfill 23/07 bỏ quên (POSTING có thật nhưng
  -- posting_status = UNPOSTED/NULL), nên chỉ tin cờ là chưa đủ: hỏi thẳng SỰ
  -- THẬT ở bảng bút toán. Còn bút toán POSTING nào chưa bị đảo ⇒ tiền đã nằm
  -- trong sổ, ghi tiếp là nhân đôi.
  SELECT p.id INTO v_live_posting
  FROM public.income_expense_postings p
  WHERE p.voucher_id = v_voucher
    AND p.event_kind = 'POSTING'
    AND NOT EXISTS (
      SELECT 1 FROM public.income_expense_postings r
      WHERE r.reversal_of_id = p.id)
  LIMIT 1;
  IF v_live_posting IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu này đã có bút toán ghi sổ (%) chưa bị đảo — tiền đã nằm trong sổ, không ghi sổ lần nữa. Muốn ghi lại thì đảo bút toán cũ trước.',
      v_live_posting USING ERRCODE = '55000';
  END IF;

  -- COALESCE để nhánh NULL không lọt: `NULL NOT IN (...)` ra NULL, không phải TRUE.
  IF v_ie.approval_status <> 'APPROVED'
     OR COALESCE(v_ie.posting_status, 'X') NOT IN ('UNPOSTED', 'REVERSED') THEN
    RAISE EXCEPTION 'post_approved_income_expense_v2: voucher must be APPROVED + UNPOSTED/REVERSED (%, %)',
      v_ie.approval_status, COALESCE(v_ie.posting_status, '(null)') USING ERRCODE = '55000';
  END IF;
  IF v_ie.approval_version <> v_exp_appr OR v_ie.posting_version <> v_exp_post THEN
    RAISE EXCEPTION 'post_approved_income_expense_v2: version mismatch' USING ERRCODE = '55000';
  END IF;
  IF NOT app_private.finance_v2_is_cashbook_period_open(v_ie.organization_id, v_cashbook, v_posted_on) THEN
    RAISE EXCEPTION 'post_approved_income_expense_v2: posted_on % is inside a locked cashbook period', v_posted_on USING ERRCODE = '55000';
  END IF;

  v_posting_id := app_private.finance_v2_post_manual_voucher(
    v_ie, v_uid, v_mid, v_cashbook, v_posted_on, v_evidence, v_idem);

  v_new_post := v_ie.posting_version + 1;
  UPDATE public.income_expenses ie
     SET active_posting_id_v2 = v_posting_id, posting_status = 'POSTED',
         -- 7ah: stamp so quy TIEN THAT SU DI QUA len header (het "-" va het so sai)
         account_id = v_cashbook,
         reversed_by_posting_id = NULL,
         posting_id = v_posting_id, posted_at_v2 = now(),
         posting_version = v_new_post, updated_at = now()
   WHERE ie.id = v_voucher;

  v_resp := jsonb_build_object('voucherId', v_voucher, 'postingId', v_posting_id,
                               'postingStatus', 'POSTED', 'postingVersion', v_new_post);
  PERFORM app_private.finance_v2_finish_canonical_op(
    v_ie.organization_id, 'income_expense.post.v2', v_voucher::text, v_uid, v_idem, v_voucher,
    v_resp, 'POSTED', v_ie.review_version, v_ie.approval_version, v_new_post);
  PERFORM app_private.finance_v2_log_event(v_ie.organization_id, 'income_expense.post.v2', v_voucher, v_uid, v_idem);
  RETURN v_resp;
END
$function$;
