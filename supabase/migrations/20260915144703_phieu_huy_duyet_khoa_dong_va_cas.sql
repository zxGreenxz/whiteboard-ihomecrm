-- =============================================================================
-- H3.2 — `unapprove_voucher`: KHOÁ DÒNG + CAS `approval_version`
--
-- VÌ SAO (đo 15/09/2026 trên supabase/baseline/schema.sql — dump prod 06/08;
--         không migration nào sau 20260806 định nghĩa lại hàm này)
--   Bản đang chạy (baseline:94201) lùi trạng thái phiếu bằng MỘT câu UPDATE
--   trần: không `FOR UPDATE`, không so phiên bản nào. Hai lượt huỷ duyệt chạy
--   song song — bấm hai lần, mở hai tab, hoặc một người bấm Duyệt trong lúc
--   người kia bấm Huỷ duyệt — đều thấy `ROW_COUNT = 1` và đều báo thành công.
--   Hệ quả đo được: `review_version` cộng hai lần cho một hành vi, và phiếu có
--   thể tụt về Chờ duyệt NGAY SAU khi vừa được người khác duyệt, không để lại
--   dấu vết nào cho biết đã có va chạm.
--
--   Chiều NGƯỢC LẠI của cùng trạng thái ấy đã làm đúng từ lâu:
--   `approve_income_expense_v2` (baseline:45826-45829) so `approval_version`
--   và ném 55000 khi lệch. Lát này chỉ là đặt cùng một ổ khoá lên cửa còn lại.
--
-- ĐỔI CHỮ KÝ ⇒ DROP RỒI CREATE
--   Thêm `p_expected_approval_version` bằng `CREATE OR REPLACE` sẽ đẻ thêm một
--   overload và PostgREST có thể chọn bản cũ (án lệ đã ghi). Vì DROP làm rơi
--   sạch ACL, phần REVOKE/GRANT ở cuối file là BẮT BUỘC chứ không phải viết
--   cho đủ lệ — nó khôi phục đúng ACL do
--   20260713091000_sprint0_revoke_internal_definer.sql:47-48 đặt ra.
--
--   Tham số mới có DEFAULT NULL nên mọi lời gọi cũ `unapprove_voucher(uuid)`
--   vẫn phân giải được; NULL = không CAS, giữ nguyên hành vi. Client gửi số
--   thật (statusMutations.ts) nên đường người dùng đi được CAS bảo vệ.
--
-- LÁT NÀY KHÔNG ĐỤNG QUYỀN DUYỆT
--   Vế "người tạo tự duyệt phiếu của mình" (H3.2 phần đầu) CỐ Ý giữ nguyên ở
--   đây. Lý do đã đo, ghi trong báo cáo H3: bỏ vế đó khỏi `approve_voucher`
--   KHÔNG đóng được lỗ (vì `approve_income_expense_v1` mang đúng vế ấy ở
--   baseline:45732 và FE gọi nó TRƯỚC — statusMutations.ts:149), đồng thời
--   làm đổi hành vi của hai đường tiền nội bộ đang dựa vào chính vế đó:
--   `pay_draft_fee_voucher` (20260831161000:96) và `lock_salary_month_v1`
--   (baseline:69829). Đó là một quyết định về AI ĐƯỢC DUYỆT trên production,
--   phải do chủ chốt, không phải việc kèm theo của một lát CAS.
--
-- Phần thân dưới đây chép NGUYÊN từ định nghĩa đang chạy (baseline:94201-94241);
-- chỗ đổi đúng là: đọc-khoá dòng, phép so phiên bản, và `approval_version + 1`.
-- IDEMPOTENT: DROP chữ ký CŨ (1 tham số) + CREATE OR REPLACE chữ ký MỚI.
--   Bản đầu viết `CREATE FUNCTION` trần và KHÔNG idempotent: lượt hai, DROP chỉ
--   xoá được chữ ký (uuid) — chữ ký (uuid, bigint) vừa tạo vẫn còn — nên CREATE
--   ngã 42723. Lane apply kiểm hai lượt trong ROLLBACK và bắt đúng chỗ này
--   (16/09/2026). `CREATE OR REPLACE` ở đây KHÔNG đẻ overload như án lệ
--   "thêm tham số RPC": chữ ký cũ đã bị DROP ngay trên, chỉ còn đúng một bản.
--
-- TƯƠNG THÍCH NGƯỢC: tham số thứ hai có DEFAULT NULL nên client CŨ đang chạy
--   production (gửi mỗi `voucher_id`) vẫn gọi được sau khi apply — vì thế file
--   này apply TRƯỚC khi đẩy web, còn org_autofill_strict thì ngược lại.
-- =============================================================================

DROP FUNCTION IF EXISTS public.unapprove_voucher(uuid);

CREATE OR REPLACE FUNCTION public.unapprove_voucher(
  voucher_id uuid,
  p_expected_approval_version bigint DEFAULT NULL
) RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public', 'app_private'
    AS $$
DECLARE
  v_row public.income_expenses%ROWTYPE;
BEGIN
  -- Khoá dòng TRƯỚC mọi quyết định. Bản cũ đọc và ghi trong cùng một câu UPDATE
  -- nên hai phiên song song không nhìn thấy nhau.
  SELECT * INTO v_row
  FROM public.income_expenses ie
  WHERE ie.id = voucher_id AND ie.deleted_at IS NULL
  FOR UPDATE;

  -- MỘT thông báo cho cả "không tồn tại" lẫn "không có quyền" — giữ nguyên
  -- cách nói của bản cũ để hàm không thành máy dò trạng thái xuyên tổ chức.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không thể huỷ duyệt phiếu: phiếu không tồn tại hoặc bạn không có quyền'
      USING ERRCODE = '42501';
  END IF;

  -- t5_26: phiếu thuộc engine → không lùi trạng thái ngoài engine.
  PERFORM app_private.assert_no_engine_request_v1(voucher_id);

  IF NOT (
    v_row.user_id = auth.uid()
    OR public.is_super_admin()
    OR (
      v_row.building_id IS NOT NULL
      AND public.can_do_on_building('income_expenses', 'approve', v_row.building_id)
    )
  ) THEN
    RAISE EXCEPTION 'Không thể huỷ duyệt phiếu: phiếu không tồn tại hoặc bạn không có quyền'
      USING ERRCODE = '42501';
  END IF;

  -- CAS. NULL = người gọi cũ không biết tới phiên bản → giữ hành vi cũ.
  IF p_expected_approval_version IS NOT NULL
     AND v_row.approval_version IS DISTINCT FROM p_expected_approval_version THEN
    RAISE EXCEPTION 'unapprove_voucher: approval_version mismatch (expected %, found %)',
      p_expected_approval_version, v_row.approval_version USING ERRCODE = '55000';
  END IF;

  UPDATE public.income_expenses ie
  SET
    approval_status = 'UNAPPROVED',
    approved_by = NULL,
    approved_at = NULL,
    -- Trả phiếu về ĐÚNG đầu quy trình duyệt. Thiếu ba dòng này thì phiếu
    -- kẹt ở (UNAPPROVED, RESOLVED) và approve_income_expense_v2 từ chối
    -- vĩnh viễn — không đường nào cứu được từ giao diện.
    review_state = 'PENDING',
    review_version = v_row.review_version + 1,
    review_reason = NULL,
    -- Cộng phiên bản DUYỆT: không cộng thì một `p_expected_approval_version`
    -- đọc trước lần huỷ duyệt vẫn khớp sau đó, và CAS thành trang trí.
    approval_version = v_row.approval_version + 1,
    updated_at = now()
  WHERE ie.id = voucher_id;
END;
$$;

-- DROP làm rơi ACL — khôi phục đúng bộ của 20260713091000:47-48.
REVOKE ALL ON FUNCTION public.unapprove_voucher(uuid, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unapprove_voucher(uuid, bigint) TO authenticated;

COMMENT ON FUNCTION public.unapprove_voucher(uuid, bigint) IS
  'Lùi phiếu thu/chi về Chờ duyệt. 15/09/2026: khoá dòng (FOR UPDATE) + CAS '
  'p_expected_approval_version (NULL = bỏ qua, cho người gọi cũ) + cộng '
  'approval_version. Quyền duyệt GIỮ NGUYÊN — xem báo cáo H3 về vế người-tạo-tự-duyệt.';
