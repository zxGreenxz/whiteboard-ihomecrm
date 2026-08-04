-- =====================================================================
-- BẢO VỆ BẰNG CHỨNG trên phiếu ĐÃ GHI SỔ
--
-- Header của Đợt 0 (20260730100000) tự đặt ra doctrine: "dán thêm được, gỡ
-- bằng chứng thì không". Đợt 2 lại nới ngược: annotate_income_expense_v1 cho
-- XOÁ ảnh chứng từ (p_remove_attachments) và GHI ĐÈ TRẮNG ghi chú trên phiếu
-- APPROVED + ĐÃ GHI SỔ, kể cả phiếu trong kỳ ĐÃ CHỐT SỔ, cho mọi người có
-- income_expenses.edit trên toà. Prod có 857 phiếu APPROVED đang mang ảnh.
--
-- Nguyên tắc áp dụng ở đây: một khi TIỀN ĐÃ RỜI KÉT (phiếu đã ghi sổ), bằng
-- chứng của nó là thứ đối soát dựa vào — sửa được thì đối soát mất nghĩa.
--   • Phiếu CHƯA ghi sổ  → gỡ ảnh / sửa ghi chú tự do như cũ.
--   • Phiếu ĐÃ ghi sổ    → chỉ NỐI THÊM. Gỡ ảnh và ghi đè ghi chú dành riêng
--                          cho chủ tổ chức / super admin.
-- Quyết định #8 của chủ KHÔNG bị đụng: THÊM ảnh và THÊM ghi chú vào phiếu của
-- kỳ đã chốt vẫn chạy — đó mới là thứ #8 hứa.
-- =====================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. Gỡ ảnh + ghi đè ghi chú trên phiếu ĐÃ GHI SỔ: chỉ chủ tổ chức
-- ─────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_def text;
  v_anchor_rm text :=
    '  -- GỠ bằng chứng là hành vi SỬA, không phải chú thích ⇒ đòi quyền sửa thật.' || chr(10) ||
    '  v_may_remove := v_can_edit;';
  v_anchor_notes text :=
    '    v_next_notes := CASE' || chr(10) ||
    '      WHEN p_note_mode = ''APPEND'' AND COALESCE(v_row.notes, '''') <> ''''' || chr(10) ||
    '        THEN v_row.notes || E''\n'' || p_notes' || chr(10) ||
    '      ELSE p_notes' || chr(10) ||
    '    END;';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'annotate_income_expense_v1';
  IF v_def IS NULL THEN RAISE EXCEPTION 'Không có annotate_income_expense_v1'; END IF;

  IF position('TIỀN ĐÃ RỜI KÉT' IN v_def) > 0 THEN
    RAISE NOTICE 'annotate_income_expense_v1 đã bảo vệ bằng chứng — bỏ qua'; RETURN;
  END IF;
  IF position(v_anchor_rm IN v_def) = 0 OR position(v_anchor_notes IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo trong annotate_income_expense_v1 — DỪNG, không vá mù';
  END IF;

  -- (a) GỠ ẢNH: phiếu đã ghi sổ thì chỉ chủ tổ chức / super admin.
  v_def := replace(v_def, v_anchor_rm,
    '  -- GỠ bằng chứng là hành vi SỬA, không phải chú thích ⇒ đòi quyền sửa thật.' || chr(10) ||
    '  -- Và khi TIỀN ĐÃ RỜI KÉT (phiếu đã ghi sổ) thì ảnh chứng từ là thứ đối' || chr(10) ||
    '  -- soát dựa vào — gỡ được thì đối soát mất nghĩa. Chỉ chủ tổ chức gỡ được,' || chr(10) ||
    '  -- và nhật ký app_private.income_expense_change_log lưu đủ URL trước/sau.' || chr(10) ||
    '  v_may_remove := v_can_edit' || chr(10) ||
    '    AND (COALESCE(v_row.posting_status, ''UNPOSTED'') <> ''POSTED''' || chr(10) ||
    '         OR v_is_super' || chr(10) ||
    '         OR app_private.is_org_owner_v1(v_row.organization_id, v_actor));');

  -- (b) GHI CHÚ: phiếu đã ghi sổ thì chỉ NỐI THÊM, không ghi đè.
  v_def := replace(v_def, v_anchor_notes,
    '    -- Phiếu đã ghi sổ: ép NỐI THÊM. Ghi chú trên phiếu đã chi là nơi ghi' || chr(10) ||
    '    -- "biên lai gốc, người thu, có chữ ký" — ghi đè là mất dấu vết nghiệp' || chr(10) ||
    '    -- vụ. Chủ tổ chức / super admin vẫn ghi đè được.' || chr(10) ||
    '    IF COALESCE(v_row.posting_status, ''UNPOSTED'') = ''POSTED''' || chr(10) ||
    '       AND p_note_mode = ''REPLACE''' || chr(10) ||
    '       AND COALESCE(v_row.notes, '''') <> ''''' || chr(10) ||
    '       AND NOT v_is_super' || chr(10) ||
    '       AND NOT app_private.is_org_owner_v1(v_row.organization_id, v_actor) THEN' || chr(10) ||
    '      p_note_mode := ''APPEND'';' || chr(10) ||
    '    END IF;' || chr(10) ||
    v_anchor_notes);

  -- (c) Trần 5000 ký tự phải tính trên chuỗi KẾT QUẢ, không phải đầu vào:
  --     APPEND lặp làm notes phình vô hạn (đo được 9801 ký tự sau 2 lần gọi).
  v_def := replace(v_def,
    '    PERFORM app_private.assert_notes_markers_unchanged_v1(v_row.notes, v_next_notes);',
    '    IF length(COALESCE(v_next_notes, '''')) > 5000 THEN' || chr(10) ||
    '      RAISE EXCEPTION ''Ghi chú sau khi nối vượt 5000 ký tự — hãy rút gọn.''' || chr(10) ||
    '        USING ERRCODE = ''22023'';' || chr(10) ||
    '    END IF;' || chr(10) ||
    '    PERFORM app_private.assert_notes_markers_unchanged_v1(v_row.notes, v_next_notes);');

  IF position('TIỀN ĐÃ RỜI KÉT' IN v_def) = 0
     OR position('p_note_mode := ''APPEND''' IN v_def) = 0
     OR position('vượt 5000 ký tự' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vá annotate_income_expense_v1 thất bại';
  END IF;

  EXECUTE v_def;
  RAISE NOTICE 'annotate_income_expense_v1: đã bảo vệ bằng chứng trên phiếu đã ghi sổ';
END
$patch$;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Nhánh ANNOTATE của guard chỉ phủ 175/2528 phiếu
--
-- Bản vá Đợt 2 đặt nhánh ANNOTATE trong guard_income_expense_owned_payload,
-- nhưng guard đó có early-return "phiếu KHÔNG flow-owned thì đi thẳng" đứng
-- TRƯỚC. Nên phần tự-kiểm-delta ("annotate scope may only change
-- attachments/notes") chỉ có hiệu lực trên phiếu flow-owned — 175/2528.
-- Đã đo: mở scope ANNOTATE trên phiếu KHÔNG flow-owned rồi UPDATE total_amount
-- → đổi thành 999999.00, không guard nào lên tiếng.
--
-- KHÔNG vá guard đó (nó nằm trong 4 hàm cấm CREATE OR REPLACE, và đã qua 3 lần
-- text-patch). Thay vào đó dựng một guard ĐỘC LẬP, SECURITY INVOKER, chạy sớm
-- (a01_) và tự kiểm delta cho MỌI phiếu khi transaction có mở scope ANNOTATE.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ie_annotate_scope_delta_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  -- Chỉ soi khi CHÍNH transaction này đã mở năng lực ANNOTATE cho phiếu này.
  IF NOT EXISTS (
    SELECT 1 FROM app_private.ie_flex_writer_xids w
     WHERE w.income_expense_id = OLD.id
       AND w.transaction_id = pg_current_xact_id()
       AND w.backend_pid = pg_backend_pid()
       AND w.scope = 'ANNOTATE'
  ) THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(OLD) - ARRAY['attachments','notes','updated_at'])
     IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['attachments','notes','updated_at']) THEN
    RAISE EXCEPTION
      'Năng lực ANNOTATE chỉ được đổi ảnh chứng từ và ghi chú của phiếu % — phát hiện đổi cột khác.',
      OLD.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS a01_ie_annotate_scope_delta ON public.income_expenses;
CREATE TRIGGER a01_ie_annotate_scope_delta
  BEFORE UPDATE ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION public.ie_annotate_scope_delta_guard();

-- ─────────────────────────────────────────────────────────────────────
-- 3. p_idempotency_key là THAM SỐ CHẾT
-- Nó có trong chữ ký nhưng không dòng nào đọc. Caller (và người đọc code)
-- tưởng có khoá chống trùng. Ghi thẳng vào COMMENT để không ai tin nhầm nữa.
-- KHÔNG bỏ tham số: đổi chữ ký sẽ vỡ mọi caller đang truyền nó.
-- Chống nhân đôi thực tế đã có bằng cơ chế khác: ảnh đi qua
-- ie_attachments_union_v1 (dán lại đúng tấm cũ là no-op), và ghi chú REPLACE
-- vốn tự idempotent. Chỉ APPEND là không — nay đã có trần 5000 ký tự chặn phình.
-- ─────────────────────────────────────────────────────────────────────
COMMENT ON FUNCTION public.annotate_income_expense_v1(uuid, jsonb, jsonb, text, text, text) IS
  'Bổ sung ảnh chứng từ / ghi chú. LƯU Ý: p_idempotency_key hiện KHÔNG được đọc '
  '(tham số chết) — chống trùng dựa vào ie_attachments_union_v1 cho ảnh và tính '
  'idempotent sẵn có của note_mode=REPLACE. note_mode=APPEND KHÔNG idempotent: '
  'gọi lại là nối thêm lần nữa. Phiếu ĐÃ GHI SỔ chỉ nối thêm được; gỡ ảnh và ghi '
  'đè ghi chú dành cho chủ tổ chức / super admin.';

COMMIT;

NOTIFY pgrst, 'reload schema';
