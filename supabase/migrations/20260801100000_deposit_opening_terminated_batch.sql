-- =====================================================================
-- ĐỢT 2 CỦA CỌC CŨ VÀO ATam: nhóm hợp đồng ĐÃ TRẢ PHÒNG — 23/34 phiếu
--
-- Tiếp `20260801050000` (217 phiếu của hợp đồng đang thuê). 34 phiếu của khách
-- đã trả phòng khi đó CỐ Ý để lại vì "khách đi rồi thì cọc hoặc đã hoàn hoặc đã
-- trừ — ghi mỗi chiều NHẬN mà không ghi chiều TRẢ là sổ dư ra đúng phần đã hoàn".
--
-- Chủ yêu cầu 01/08: "xem kỹ flow codebase database logic rồi hãy lên plan làm".
-- Đã soi dòng tiền SAU-KHI-NHẬN của từng hợp đồng. Kết quả chia 34 phiếu làm
-- hai loại rõ rệt:
--
-- ─────────────────────────────────────────────────────────────────────
-- 23 PHIẾU GHI ĐƯỢC — vì chiều tiền sau đó ĐÃ ĐƯỢC GHI ĐẦY ĐỦ hoặc KHÔNG CÓ
--
--   • 7 phiếu (24.440.000đ) — ĐÃ HOÀN THẬT: phiếu hoàn của các hợp đồng này đã
--     POSTED (19.650.200đ ra từ ATam 1,7tr · TK939 6,6tr · TKHIEP 11,3tr).
--     Chiều RA đã trong sổ mà chiều VÀO chưa từng ghi ⇒ sổ đang THIẾU đúng phần
--     cọc nhận. Ghi VÀO là cân lại, không phải cộng khống.
--   • 5 phiếu (24.000.000đ) — ĐÃ TỊCH THU: cặp phiếu forfeit revenue/offset của
--     chúng đo được 10/10 đều `NOT_APPLICABLE` (chỉ ghi nhận sổ ảo) ⇒ tiền tịch
--     thu CHƯA TỪNG được ghi thu vào két nào. Ghi chiều VÀO không trùng đếm.
--   • 11 phiếu (45.900.000đ) — HỒ SƠ BỎ CỌC (FORFEIT), không có phiếu tiền nào:
--     bỏ cọc nghĩa là tiền Ở LẠI két, không có chiều ra. Ghi VÀO là đúng.
--
-- 11 PHIẾU ĐỂ LẠI CHỜ CHỦ — vì chiều sau đó KHÔNG RÕ
--
--   • 2 phiếu (7.700.000đ) hồ sơ thanh lý THƯỜNG nhưng không có phiếu hoàn nào
--     — rất có thể đã hoàn tiền mặt không ghi phiếu; ghi VÀO một mình là sổ dư.
--   • 9 phiếu (31.200.000đ) KHÔNG có hồ sơ thanh lý nào — không dấu vết gì về
--     việc cọc đã hoàn hay đã giữ. (Nhóm 23/56 hợp đồng thiếu hồ sơ đã biết.)
--
-- Cùng quy ước với đợt 1: vào ATam, ngày ghi sổ 01/03/2026, giữ nguyên
-- voucher_date gốc, KHÔNG đụng lãi lỗ (cọc là tiền giữ hộ khách).
-- =====================================================================

BEGIN;

DO $preflight$
DECLARE v_n int; v_sum numeric; v_acc uuid;
BEGIN
  IF to_regprocedure('app_private.finance_v2_post_voucher_with_source_v1(uuid,uuid,text,text,uuid,uuid,date,text,bigint)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu lõi ghi sổ dùng chung. DỪNG.';
  END IF;
  SELECT a.id INTO v_acc FROM public.accounts a
   WHERE a.organization_id = 'aaaa0000-0000-4000-8000-000000000001'
     AND a.name = 'ATam' AND a.deleted_at IS NULL AND NOT COALESCE(a.is_virtual,false);
  IF v_acc IS NULL THEN RAISE EXCEPTION 'Không thấy sổ ATam thật. DỪNG.'; END IF;

  -- Chốt cứng phạm vi đã trình chủ: đúng 23 phiếu / 94.340.000đ. Lệch = dữ liệu
  -- đã đổi kể từ lúc phân tích ⇒ DỪNG, phân tích lại.
  WITH coc AS (
    SELECT DISTINCT ie.id, ie.contract_id, ie.total_amount
      FROM public.income_expenses ie
      JOIN public.income_expense_items it ON it.income_expense_id = ie.id
      JOIN public.contracts c ON c.id = ie.contract_id
     WHERE ie.organization_id = 'aaaa0000-0000-4000-8000-000000000001'
       AND ie.deleted_at IS NULL AND ie.approval_status = 'APPROVED'
       AND ie.type = 'INCOME' AND it.accounting_class = 'DEPOSIT'
       AND ie.posting_status = 'NOT_APPLICABLE'
       AND c.status::text = 'TERMINATED'
  )
  SELECT count(*), COALESCE(sum(total_amount),0) INTO v_n, v_sum
    FROM coc
   WHERE
     -- (a) đã hoàn thật (phiếu hoàn POSTED trên hợp đồng)
     EXISTS (SELECT 1 FROM public.income_expenses rf
              WHERE rf.contract_id = coc.contract_id
                AND rf.system_source LIKE 'termination.refund%'
                AND rf.deleted_at IS NULL AND rf.approval_status <> 'CANCELLED'
                AND rf.posting_status = 'POSTED')
     -- (b) hoặc có phiếu tịch thu (mọi trạng thái — đo được toàn bộ là sổ ảo)
     OR EXISTS (SELECT 1 FROM public.income_expenses fv
                 WHERE fv.contract_id = coc.contract_id
                   AND fv.system_source IN ('termination.forfeit_revenue','termination.forfeit_offset')
                   AND fv.deleted_at IS NULL AND fv.approval_status <> 'CANCELLED')
     -- (c) hoặc hồ sơ thanh lý loại BỎ CỌC
     OR EXISTS (SELECT 1 FROM public.contract_terminations t
                 WHERE t.contract_id = coc.contract_id
                   AND t.termination_type::text = 'FORFEIT');

  IF v_n = 0 THEN
    RAISE NOTICE 'Không còn phiếu nào thuộc nhóm ghi được — có vẻ đã chạy rồi.';
  ELSIF v_n <> 23 OR round(v_sum) <> 94340000 THEN
    RAISE EXCEPTION
      'Phạm vi đổi: đo được % phiếu / %đ, phân tích trình chủ là 23 / 94.340.000đ. DỪNG.',
      v_n, round(v_sum);
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- GHI VÀO SỔ — đúng khuôn đợt 1: token TẮT cầu a85 TRƯỚC khi đổi account_id,
-- lõi dùng chung chống chạy lại theo external_source, trả token cuối vòng.
-- ─────────────────────────────────────────────────────────────────────
DO $backfill$
DECLARE
  c_org  uuid := 'aaaa0000-0000-4000-8000-000000000001';
  c_date date := DATE '2026-03-01';
  v_acc  uuid; r record; v_post uuid; v_n int := 0; v_sum numeric := 0;
BEGIN
  SELECT a.id INTO v_acc FROM public.accounts a
   WHERE a.organization_id = c_org AND a.name = 'ATam' AND a.deleted_at IS NULL;

  FOR r IN
    SELECT DISTINCT ie.id, ie.total_amount
      FROM public.income_expenses ie
      JOIN public.income_expense_items it ON it.income_expense_id = ie.id
      JOIN public.contracts c ON c.id = ie.contract_id
     WHERE ie.organization_id = c_org
       AND ie.deleted_at IS NULL AND ie.approval_status = 'APPROVED'
       AND ie.type = 'INCOME' AND it.accounting_class = 'DEPOSIT'
       AND ie.posting_status = 'NOT_APPLICABLE'
       AND c.status::text = 'TERMINATED'
       AND (
         EXISTS (SELECT 1 FROM public.income_expenses rf
                  WHERE rf.contract_id = ie.contract_id
                    AND rf.system_source LIKE 'termination.refund%'
                    AND rf.deleted_at IS NULL AND rf.approval_status <> 'CANCELLED'
                    AND rf.posting_status = 'POSTED')
         OR EXISTS (SELECT 1 FROM public.income_expenses fv
                     WHERE fv.contract_id = ie.contract_id
                       AND fv.system_source IN ('termination.forfeit_revenue','termination.forfeit_offset')
                       AND fv.deleted_at IS NULL AND fv.approval_status <> 'CANCELLED')
         OR EXISTS (SELECT 1 FROM public.contract_terminations t
                     WHERE t.contract_id = ie.contract_id
                       AND t.termination_type::text = 'FORFEIT')
       )
     ORDER BY ie.id
  LOOP
    INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
    VALUES (r.id, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
    ON CONFLICT (income_expense_id) DO UPDATE
      SET xid = EXCLUDED.xid, purpose = EXCLUDED.purpose, granted_at = now();

    UPDATE public.income_expenses SET account_id = v_acc WHERE id = r.id;

    v_post := app_private.finance_v2_post_voucher_with_source_v1(
      p_org => c_org, p_voucher_id => r.id,
      p_source_kind => 'DEPOSIT_OPENING_ATAM',
      p_external_kind => 'DEPOSIT_OPENING_2026_03_T2',
      p_external_id => r.id, p_external_line_id => NULL,
      p_posted_on => c_date, p_amount_basis => 'VOUCHER_TOTAL', p_generation => 1);

    UPDATE public.income_expenses
       SET active_posting_id_v2 = v_post, posting_id = v_post,
           posting_status = 'POSTED', posting_mode = COALESCE(posting_mode,'CASHBOOK'),
           posted_at_v2 = now(), updated_at = now()
     WHERE id = r.id;

    DELETE FROM app_private.ie_transition_authorization
     WHERE income_expense_id = r.id AND xid = pg_current_xact_id();

    v_n := v_n + 1; v_sum := v_sum + r.total_amount;
  END LOOP;

  RAISE NOTICE 'Đợt 2: đã ghi % phiếu (%đ) vào ATam ngày %', v_n, round(v_sum), c_date;
END
$backfill$;

-- ─────────────────────────────────────────────────────────────────────
-- TỰ KIỂM
-- ─────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE c_org uuid := 'aaaa0000-0000-4000-8000-000000000001';
        v_n int; v_sum numeric; v_conlai int; v_sum_conlai numeric;
BEGIN
  SELECT count(*), COALESCE(sum(p.gross_amount),0) INTO v_n, v_sum
    FROM public.income_expense_postings p
   WHERE p.organization_id = c_org
     AND p.external_source_kind = 'DEPOSIT_OPENING_2026_03_T2'
     AND p.event_kind = 'POSTING';
  IF v_n <> 23 OR round(v_sum) <> 94340000 THEN
    RAISE EXCEPTION 'Đợt 2 sinh % bút toán / %đ — phải đúng 23 / 94.340.000đ. DỪNG.', v_n, round(v_sum);
  END IF;

  -- 11 phiếu mơ hồ phải CÒN NGUYÊN, không được ghi ké.
  SELECT count(*), COALESCE(sum(ie.total_amount),0) INTO v_conlai, v_sum_conlai
    FROM public.income_expenses ie
    JOIN public.income_expense_items it ON it.income_expense_id = ie.id
    JOIN public.contracts c ON c.id = ie.contract_id
   WHERE ie.organization_id = c_org AND ie.deleted_at IS NULL
     AND ie.approval_status <> 'CANCELLED' AND ie.type = 'INCOME'
     AND it.accounting_class = 'DEPOSIT' AND ie.posting_status = 'NOT_APPLICABLE'
     AND c.status::text = 'TERMINATED';
  IF v_conlai <> 11 OR round(v_sum_conlai) <> 38900000 THEN
    RAISE EXCEPTION 'Nhóm chờ chủ còn % phiếu / %đ — phải đúng 11 / 38.900.000đ. DỪNG.', v_conlai, round(v_sum_conlai);
  END IF;

  RAISE NOTICE 'ĐÃ KIỂM: 23 bút toán / 94.340.000đ; nhóm chờ chủ còn nguyên 11 phiếu / 38.900.000đ.';
END
$verify$;

COMMIT;
