-- =============================================================================
-- chi_phieu_da_duyet_qua_khoa_thang_ln — phiếu ĐÃ DUYỆT của tháng đã chốt lợi nhuận vẫn
-- CHI / THU (ghi sổ) được
-- Ngày 16/11/2026 · chủ chốt 16/11/2026: "Cho phép Chi qua khoá: phiếu đã duyệt của tháng
-- đã chốt vẫn chi được, vì chi không đổi lợi nhuận tháng đó."
-- =============================================================================
-- VÌ SAO
--   Khoá tháng (20260925073251 + 20261022172918: trigger a02_ie_profit_lock_* →
--   public.income_expenses_check_profit_lock) chặn MỌI lần đổi phiếu có ngày / kỳ trong tháng
--   đã chốt. Cửa chặn chốt (a10_profit_month_lock_requires_no_pending) chỉ đòi tháng hết
--   phiếu CHỜ DUYỆT; phiếu ĐÃ DUYỆT CHƯA CHI vẫn chốt được. Sau chốt, bấm "Chi" các phiếu đó
--   hỏng ở cả hai bước của hộp Chi:
--     1. ghi ảnh chứng từ lên phiếu (annotate_income_expense_v1, scope ANNOTATE — đổi cột
--        attachments);
--     2. ghi sổ (post_approved_income_expense_v2 — đóng dấu posting_status, bút toán, sổ quỹ
--        lên đầu phiếu).
--   Cả hai trả "[PROFIT_LOCKED] … không sửa phiếu được", muốn chi phải mở khoá tháng rồi chốt
--   lại. Gặp thật 16/11/2026 với một phiếu hoa hồng ngày tháng 09/2026.
--   Ghi sổ không đổi lợi nhuận tháng: public.fa_accrual_allocations (nguồn của Chốt LN và dấu
--   vân tay chốt) chỉ đọc phiếu đã duyệt, số tiền, kỳ, hạng mục — không đọc cột ghi sổ hay
--   sổ quỹ. Tiền vào sổ quỹ ở ngày chi do người chi chọn. Khoá SỔ QUỸ không đổi và vẫn áp
--   riêng: bút toán theo ngày chi (a01_ie_posting_lines_check_lock), đầu phiếu theo NGÀY PHIẾU
--   (trg_ie_check_lock_*: sổ đã chốt & bàn giao qua ngày phiếu thì ghi sổ vẫn bị
--   [CASHBOOK_CLOSED]).
--
-- LÀM GÌ
--   Chỉ thay public.income_expenses_check_profit_lock(): DỰNG TỪ THÂN ĐANG CHẠY production
--   (md5 6e016a8f…, đúng thân 20261022172918), giữ nguyên từng chữ, thêm HAI ngoại lệ vào
--   cùng khối ngoại lệ UPDATE (sau LINK_CONTRACT). Trigger tự kiểm delta, không tin writer:
--     A. GHI SỔ phiếu đã duyệt: OLD đã duyệt, chưa xoá, posting_status UNPOSTED / REVERSED →
--        NEW POSTED; chỉ đổi các cột dấu ghi sổ {posting_status, active_posting_id_v2,
--        posting_id, reversed_by_posting_id, posted_at_v2, posting_version, account_id};
--        có token FINANCE_V2_LIFECYCLE của chính phiếu trong chính transaction; bút toán được
--        trỏ tới là bút toán POSTING thật của phiếu, chưa bị đảo, đúng sổ quỹ ghi lên đầu phiếu.
--        Token do finance_v2_begin_canonical_op cấp cho mọi RPC vòng đời V2, và một số writer
--        definer khác cũng tự cấp (phí cố định, cọc giữ chỗ, huỷ…). Vì vậy ngoại lệ mở cho MỌI
--        đường definer ghi sổ một phiếu đã duyệt chờ ghi sổ, không riêng nút Chi; rào thật là
--        phép so delta + bút toán thật, không phải token.
--     B. THÊM ảnh chứng từ khi phiếu đã duyệt còn chờ ghi sổ: scope ANNOTATE, chỉ cột
--        attachments đổi và bản mới chứa đủ mọi ảnh cũ (chỉ thêm, không gỡ).
--
-- VẪN KHOÁ NHƯ CŨ (với mọi người, kể cả chủ công ty)
--   Lập, sửa, xoá, huỷ, DUYỆT, huỷ duyệt, khôi phục, hoàn tác ghi sổ (đảo bút toán), đổi số
--   tiền / ngày / toà / hạng mục, gỡ ảnh, sửa ghi chú, thêm ảnh lên phiếu đã ghi sổ hoặc chưa
--   duyệt. "Duyệt và Chi" một phiếu chờ duyệt của tháng đã chốt vẫn bị chặn ở bước duyệt.
--   Ghi sổ không có token vòng đời V2 (sửa tay, cầu a85 đường cũ) không được miễn.
--
-- KHÔNG ĐỤNG
--   Không sửa dữ liệu. Không đổi hàm ghi sổ, hàm bổ sung ảnh, khoá sổ quỹ, cửa chặn chốt,
--   trigger hạng mục, hàm fa_* / chốt LN / dấu vân tay. Trigger giữ SECURITY INVOKER + ACL.
--
-- ĐƯỜNG LÙI
--   CREATE OR REPLACE public.income_expenses_check_profit_lock() bằng thân của migration
--   20261022172918 (md5 6e016a8f60e83129cfb6cf2ad2829fb5).
--
-- Chạy được hai lượt liên tiếp và trên DB rỗng của Restore Drill.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. Nền phải có + thân trigger phiếu đang chạy phải đúng bản đã rà (hoặc đã là bản này).
DO $truoc$
DECLARE
  v_sig text;
  v_md5 text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.income_expenses_check_profit_lock()',
    'app_private.profit_month_locked_v1(uuid,date)',
    'app_private.assert_profit_month_open_v2(uuid,date,text)',
    'app_private.ie_profit_period_locked_month_v1(public.income_expenses,boolean)',
    'app_private.raise_profit_period_locked_v1(uuid,date)'
  ] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'Thiếu % — DỪNG.', v_sig USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF to_regclass('app_private.ie_transition_authorization') IS NULL
     OR to_regclass('app_private.ie_flex_writer_xids') IS NULL
     OR to_regclass('public.income_expense_postings') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng token vòng đời / scope writer / bút toán — DỪNG.' USING ERRCODE = '55000';
  END IF;
  -- Các cột mà hai ngoại lệ đọc phải có đủ: thiếu cột thì phép so delta sai lặng lẽ.
  IF (SELECT count(*) FROM pg_attribute a
       WHERE a.attrelid = 'public.income_expenses'::regclass AND NOT a.attisdropped
         AND a.attname IN ('approval_status', 'deleted_at', 'posting_status', 'active_posting_id_v2', 'posting_id',
                           'reversed_by_posting_id', 'posted_at_v2', 'posting_version', 'account_id',
                           'attachments')) <> 10
     OR (SELECT count(*) FROM pg_attribute a
          WHERE a.attrelid = 'public.income_expense_postings'::regclass AND NOT a.attisdropped
            AND a.attname IN ('id', 'voucher_id', 'event_kind', 'account_id', 'reversal_of_id')) <> 5
     OR (SELECT count(*) FROM pg_attribute a
          WHERE a.attrelid = 'app_private.ie_transition_authorization'::regclass AND NOT a.attisdropped
            AND a.attname IN ('income_expense_id', 'xid', 'purpose')) <> 3 THEN
    RAISE EXCEPTION 'Thiếu cột mà ngoại lệ ghi sổ / thêm ảnh đọc — DỪNG.' USING ERRCODE = '55000';
  END IF;
  v_md5 := md5(pg_get_functiondef('public.income_expenses_check_profit_lock()'::regprocedure));
  -- 6e016a8f…: thân 20261022172918 đang chạy production.
  -- 7b53d80e…: thân của chính file này (lượt hai).
  IF v_md5 <> ALL (ARRAY['6e016a8f60e83129cfb6cf2ad2829fb5', '7b53d80e714d95f125199d55201d928f']) THEN
    RAISE EXCEPTION 'public.income_expenses_check_profit_lock() KHÁC bản đã rà (md5 %) — DỪNG, chụp lại pg_get_functiondef rồi rà lại.',
      v_md5 USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Trigger phiếu: thân production (20261022172918) + hai ngoại lệ của nút Chi / Thu.
CREATE OR REPLACE FUNCTION public.income_expenses_check_profit_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_mien text[];
  v_scope text;
  v_ky_cu date;
  v_ky_moi date;
BEGIN
  -- 22/10/2026 (F06): ngoài NGÀY PHIẾU còn xét tháng KQKD theo KỲ (luật fa_accrual_allocations)
  -- của bản cũ / bản mới khi đang tính LN (đã duyệt). Phiếu theo hoá đơn cùng toà (thu mới nợ
  -- cũ) thêm vào tháng đã chốt được; khoản đã nằm trong số chốt thì không gỡ được.
  IF TG_OP <> 'INSERT' THEN
    v_ky_cu := app_private.ie_profit_period_locked_month_v1(OLD, true);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_ky_moi := app_private.ie_profit_period_locked_month_v1(NEW, false);
  END IF;

  -- Đường nhanh: cả vị trí cũ lẫn mới đều ở tháng đang mở.
  IF NOT (
    (TG_OP <> 'INSERT' AND app_private.profit_month_locked_v1(OLD.building_id, OLD.voucher_date))
    OR (TG_OP <> 'DELETE' AND app_private.profit_month_locked_v1(NEW.building_id, NEW.voucher_date))
    OR v_ky_cu IS NOT NULL
    OR v_ky_moi IS NOT NULL
  ) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Cột KHÔNG đổi tiền: máy dời lịch phiếu lặp, gắn/nhả phiên bàn giao tiền
    -- mặt, đánh dấu đã kiểm, cờ hạng mục hạn chế (suy từ loại thu chi).
    v_mien := ARRAY['repeat_remaining', 'repeat_next_date', 'handover_id',
                    'verified_at', 'verified_by', 'verified_by_name', 'verified_note',
                    'has_restricted_item', 'updated_at'];
    -- Ba cột vòng đời được điền khi còn NULL: chỉ miễn đúng chiều NULL -> giá trị.
    IF OLD.posting_mode IS NULL THEN v_mien := v_mien || 'posting_mode'::text; END IF;
    IF OLD.posting_status IS NULL THEN v_mien := v_mien || 'posting_status'::text; END IF;
    IF OLD.review_state IS NULL THEN v_mien := v_mien || 'review_state'::text; END IF;

    IF (to_jsonb(OLD) - v_mien) IS NOT DISTINCT FROM (to_jsonb(NEW) - v_mien) THEN
      RETURN NEW;
    END IF;

    SELECT w.scope INTO v_scope
      FROM app_private.ie_flex_writer_xids w
     WHERE w.income_expense_id = OLD.id
       AND w.transaction_id = pg_current_xact_id()
       AND w.backend_pid = pg_backend_pid();

    -- Dừng lặp lại: chỉ tắt việc sinh phiếu tương lai, không đụng số nào của kỳ.
    IF v_scope = 'STOP_RECURRING'
       AND COALESCE(NEW.repeat_cycle, 'NONE') = 'NONE'
       AND (to_jsonb(OLD) - v_mien - ARRAY['repeat_cycle', 'repeat_infinity', 'repeat_count'])
           IS NOT DISTINCT FROM
           (to_jsonb(NEW) - v_mien - ARRAY['repeat_cycle', 'repeat_infinity', 'repeat_count']) THEN
      RETURN NEW;
    END IF;

    -- Tạo hợp đồng gắn phiếu cọc giữ chỗ: chỉ contract_id đi từ NULL.
    IF v_scope = 'LINK_CONTRACT'
       AND OLD.contract_id IS NULL
       AND NEW.contract_id IS NOT NULL
       AND (to_jsonb(OLD) - v_mien - 'contract_id'::text)
           IS NOT DISTINCT FROM
           (to_jsonb(NEW) - v_mien - 'contract_id'::text) THEN
      RETURN NEW;
    END IF;

    -- 16/11/2026 (chủ chốt: "phiếu đã duyệt của tháng đã chốt vẫn chi được, vì chi không đổi
    -- lợi nhuận tháng đó"): GHI SỔ (Chi / Thu) phiếu ĐÃ DUYỆT còn chờ ghi sổ. Ghi sổ chỉ đưa
    -- tiền vào sổ quỹ ở ngày chi; lợi nhuận tháng tính theo phiếu đã duyệt
    -- (fa_accrual_allocations không đọc cột ghi sổ / sổ quỹ) nên số chốt không đổi. Trigger tự
    -- kiểm, không tin lời writer:
    --   · phiếu đã duyệt, chưa xoá, đang chờ ghi sổ (UNPOSTED / REVERSED) sang POSTED;
    --   · chỉ các cột dấu ghi sổ đổi (duyệt, số tiền, ngày, toà, hạng mục… giữ nguyên);
    --   · token vòng đời V2 của CHÍNH phiếu trong CHÍNH transaction (chỉ hàm definer cấp được,
    --     người dùng không tự đặt; không riêng hàm của nút Chi — nên các vế còn lại mới là rào);
    --   · bút toán được trỏ tới là bút toán POSTING thật của phiếu, chưa bị đảo, đúng sổ quỹ
    --     vừa ghi lên đầu phiếu.
    IF OLD.approval_status = 'APPROVED'
       AND OLD.deleted_at IS NULL
       AND OLD.posting_status IN ('UNPOSTED', 'REVERSED')
       AND NEW.posting_status = 'POSTED'
       AND (to_jsonb(OLD) - v_mien - ARRAY['posting_status', 'active_posting_id_v2', 'posting_id',
                                           'reversed_by_posting_id', 'posted_at_v2', 'posting_version',
                                           'account_id'])
           IS NOT DISTINCT FROM
           (to_jsonb(NEW) - v_mien - ARRAY['posting_status', 'active_posting_id_v2', 'posting_id',
                                           'reversed_by_posting_id', 'posted_at_v2', 'posting_version',
                                           'account_id']) THEN
      IF EXISTS (
           SELECT 1 FROM app_private.ie_transition_authorization tk
            WHERE tk.income_expense_id = OLD.id
              AND tk.xid = pg_current_xact_id()
              AND tk.purpose = 'FINANCE_V2_LIFECYCLE')
         AND EXISTS (
           SELECT 1 FROM public.income_expense_postings p
            WHERE p.id = NEW.active_posting_id_v2
              AND p.voucher_id = NEW.id
              AND p.event_kind = 'POSTING'
              AND p.account_id = NEW.account_id
              AND NOT EXISTS (
                SELECT 1 FROM public.income_expense_postings dao
                 WHERE dao.reversal_of_id = p.id)) THEN
        RETURN NEW;
      END IF;
    END IF;

    -- Ảnh chứng từ của lần chi đó: hộp Chi ghi ảnh lên phiếu TRƯỚC lệnh ghi sổ (chứng từ lập
    -- từ ảnh đang nằm trên phiếu). Chỉ THÊM ảnh, chỉ khi phiếu đã duyệt còn chờ ghi sổ. Gỡ ảnh,
    -- sửa ghi chú và phiếu đã ghi sổ vẫn bị khoá (dùng Bổ sung).
    IF v_scope = 'ANNOTATE'
       AND OLD.approval_status = 'APPROVED'
       AND OLD.deleted_at IS NULL
       AND OLD.posting_status IN ('UNPOSTED', 'REVERSED')
       AND jsonb_typeof(NEW.attachments) = 'array'
       AND NEW.attachments @> COALESCE(OLD.attachments, '[]'::jsonb)
       AND (to_jsonb(OLD) - v_mien - 'attachments'::text)
           IS NOT DISTINCT FROM
           (to_jsonb(NEW) - v_mien - 'attachments'::text) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    PERFORM app_private.assert_profit_month_open_v2(
      OLD.building_id, OLD.voucher_date,
      CASE WHEN TG_OP = 'DELETE' THEN 'xoá phiếu' ELSE 'sửa phiếu' END);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM app_private.assert_profit_month_open_v2(
      NEW.building_id, NEW.voucher_date,
      CASE WHEN TG_OP = 'INSERT' THEN 'lập phiếu' ELSE 'sửa phiếu' END);
  END IF;

  -- 22/10/2026 (F06): ngày phiếu ở tháng mở nhưng kỳ rơi vào tháng đã chốt.
  IF v_ky_cu IS NOT NULL THEN
    PERFORM app_private.raise_profit_period_locked_v1(OLD.building_id, v_ky_cu);
  END IF;
  IF v_ky_moi IS NOT NULL THEN
    PERFORM app_private.raise_profit_period_locked_v1(NEW.building_id, v_ky_moi);
  END IF;

  RETURN COALESCE(NEW, OLD);
END
$function$;

-- ---------------------------------------------------------------------------
-- 2. Nghiệm thu.
DO $sau$
DECLARE
  v_def text;
BEGIN
  v_def := regexp_replace(
    pg_get_functiondef('public.income_expenses_check_profit_lock()'::regprocedure), '--[^\n]*', '', 'g');
  IF position('app_private.ie_profit_period_locked_month_v1(OLD, true)' IN v_def) = 0
     OR position('app_private.ie_profit_period_locked_month_v1(NEW, false)' IN v_def) = 0
     OR position('app_private.raise_profit_period_locked_v1(' IN v_def) = 0
     OR position('app_private.assert_profit_month_open_v2(' IN v_def) = 0
     OR position('LINK_CONTRACT' IN v_def) = 0
     OR position('STOP_RECURRING' IN v_def) = 0
     OR position('FINANCE_V2_LIFECYCLE' IN v_def) = 0
     OR position('p.event_kind = ''POSTING''' IN v_def) = 0
     OR position('NEW.attachments @> COALESCE(OLD.attachments' IN v_def) = 0
     OR v_def ~ '(is_org_owner_v1|is_super_admin|business_result_accounting|auth\.uid)' THEN
    RAISE EXCEPTION 'income_expenses_check_profit_lock mất khoá cũ, thiếu ngoại lệ ghi sổ / thêm ảnh hoặc có cửa vượt' USING ERRCODE = '55000';
  END IF;
  IF (SELECT p.prosecdef FROM pg_proc p
       WHERE p.oid = 'public.income_expenses_check_profit_lock()'::regprocedure) THEN
    RAISE EXCEPTION 'income_expenses_check_profit_lock không được thành SECURITY DEFINER' USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'public.income_expenses'::regclass
         AND t.tgname IN ('a02_ie_profit_lock_ins', 'a02_ie_profit_lock_upd', 'a02_ie_profit_lock_del')
         AND t.tgenabled = 'O'
         AND t.tgfoid = 'public.income_expenses_check_profit_lock()'::regprocedure) <> 3 THEN
    RAISE EXCEPTION 'Ba trigger a02_ie_profit_lock_* không còn gắn hàm khoá tháng' USING ERRCODE = '55000';
  END IF;
END
$sau$;

COMMIT;
