-- =====================================================================
-- ĐƯA CỌC ĐÃ NHẬN CÁC KỲ TRƯỚC VÀO SỔ QUỸ ATam
--
-- Quyết định của chủ 01/08/2026, nguyên văn:
--   "hay đơn giản là thêm phiếu cọc thật cho toàn bộ HĐ đó vào sổ quỹ ATam vì
--    thực sự là toàn bộ phần cọc đó trước đây tôi đã nhận"
--   • Vào sổ: ATam (tất cả)
--   • Ngày ghi sổ: 01/03/2026
--   • Phạm vi: chỉ nhóm hợp đồng ĐANG THUÊ; nhóm khách đã trả phòng để lại rà sau
--   • Trừ phòng 103 toà 102LVT — phòng này không có cọc
--
-- ─────────────────────────────────────────────────────────────────────
-- VÌ SAO VIỆC NÀY LÀ ĐÚNG, KHÔNG PHẢI "CHẾ SỐ CHO ĐẸP SỔ"
--
-- Đợt backfill 28/07/2026 đưa cọc đầu kỳ lên sổ sách nhưng CỐ Ý không đụng sổ
-- quỹ, nên 251 phiếu cọc (1.073.940.000đ, ngày 01/11/2020 → 26/04/2026) nằm ở
-- trạng thái "đã ghi nhận, chưa vào sổ quỹ nào". Từ 05/2026 trở đi cọc mới đã
-- vào sổ thật bình thường — nên đây đúng là phần cũ bị treo.
--
-- Bằng chứng độc lập cho lời chủ nói: **sổ ATam đang âm 1.518.777.504đ**. Một
-- sổ quỹ không thể âm 1,5 tỉ thật — trừ khi nó đã chi ra rất nhiều (trả tiền
-- nhà cho chủ toà) mà phần thu vào tương ứng chưa hề được ghi. Ghi 940.700.000đ
-- cọc này vào, ATam còn âm ~578 triệu: vẫn âm, tức VẪN CÒN khoản thu khác chưa
-- ghi, nhưng gần sự thật hơn hẳn.
--
-- ─────────────────────────────────────────────────────────────────────
-- BA ĐIỀU ĐÃ KIỂM TRƯỚC KHI LÀM
--
-- 1. **Không đụng báo cáo lợi nhuận.** Cả 217 phiếu đều có
--    `business_result_accounting IS NULL` ⇒ tiền cọc là khoản GIỮ HỘ khách, không
--    phải doanh thu. Ghi vào sổ quỹ chỉ đổi số dư tiền, không đổi lãi lỗ.
-- 2. **Không vướng chốt kỳ.** `cashbook_closures` = 0 dòng (sổ quỹ chưa từng
--    chốt). Chốt lợi nhuận chỉ có 18 toà tháng 05/2026, mà mọi phiếu ở đây đều
--    có ngày trước đó.
-- 3. **Chỉ nhóm hợp đồng ĐANG THUÊ.** 34 phiếu của khách đã trả phòng
--    (133.240.000đ) CỐ Ý để ngoài: khách đi rồi thì cọc hoặc đã hoàn hoặc đã trừ
--    hết, ghi mỗi lúc NHẬN mà không ghi lúc TRẢ là sổ dư ra đúng phần đã hoàn.
--    Sẽ rà riêng.
--
-- ─────────────────────────────────────────────────────────────────────
-- NGÀY: phân biệt hai loại ngày, đừng nhầm
--   • `voucher_date` (ngày nhận cọc thật, 2020–2026) — GIỮ NGUYÊN, đó là lịch sử.
--   • ngày ghi sổ quỹ (`posted_on`) — đặt 01/03/2026 theo ý chủ, để khoản này đọc
--     như số dư đầu kỳ chứ không xáo trộn số liệu từng tháng cũ.
--
-- CHẠY LẠI ĐƯỢC: lõi ghi sổ chống trùng theo (external_source_kind,
-- external_source_id) nên áp lần hai không đẻ thêm bút toán nào.
-- =====================================================================

BEGIN;

DO $preflight$
DECLARE v_acc uuid; v_virtual boolean; v_n int; v_sum numeric;
BEGIN
  IF to_regprocedure('app_private.finance_v2_post_voucher_with_source_v1(uuid,uuid,text,text,uuid,uuid,date,text,bigint)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu lõi ghi sổ dùng chung. DỪNG.';
  END IF;

  SELECT a.id, a.is_virtual INTO v_acc, v_virtual
    FROM public.accounts a
   WHERE a.organization_id = 'aaaa0000-0000-4000-8000-000000000001'
     AND a.name = 'ATam' AND a.deleted_at IS NULL;
  IF v_acc IS NULL THEN RAISE EXCEPTION 'Không tìm thấy sổ quỹ ATam. DỪNG.'; END IF;
  IF COALESCE(v_virtual,false) THEN RAISE EXCEPTION 'ATam đang là SỔ ẢO — sai sổ. DỪNG.'; END IF;

  -- Chốt phạm vi: đúng 217 phiếu / 940.700.000đ như đã trình chủ. Lệch thì DỪNG,
  -- vì "lệch" nghĩa là dữ liệu đã đổi kể từ lúc chủ duyệt con số.
  SELECT count(*), COALESCE(sum(ie.total_amount),0) INTO v_n, v_sum
    FROM public.income_expenses ie
    JOIN public.income_expense_items it ON it.income_expense_id = ie.id
    JOIN public.contracts c ON c.id = ie.contract_id
   WHERE ie.organization_id = 'aaaa0000-0000-4000-8000-000000000001'
     AND ie.deleted_at IS NULL AND ie.approval_status = 'APPROVED'
     AND ie.type = 'INCOME' AND it.accounting_class = 'DEPOSIT'
     AND ie.posting_status = 'NOT_APPLICABLE'
     AND c.status::text = 'ACTIVE';

  IF v_n = 0 THEN
    RAISE NOTICE 'Không còn phiếu nào cần đưa vào sổ — có vẻ đã chạy rồi.';
  ELSIF v_n <> 217 OR round(v_sum) <> 940700000 THEN
    RAISE EXCEPTION
      'Phạm vi đã đổi: đo được % phiếu / %đ, trong khi chủ duyệt 217 phiếu / 940.700.000đ. DỪNG, trình lại chủ.',
      v_n, round(v_sum);
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- GHI VÀO SỔ
--
-- Thứ tự trong vòng lặp là bản thân tính đúng đắn:
--   (1) token FINANCE_V2_LIFECYCLE — TẮT cầu a85. Thiếu bước này thì lệnh đổi
--       `account_id` ở (2) làm cầu tự đúc một bút toán LEGACY_BRIDGE với ngày
--       của chính phiếu (2020–2026), rồi lõi ở (3) đúc thêm cái nữa ⇒ tiền vào
--       sổ HAI LẦN và sai cả ngày.
--   (2) trỏ phiếu sang ATam.
--   (3) lõi dùng chung ghi bút toán, ngày 01/03/2026, có khoá chống chạy lại.
--   (4) đóng dấu con trỏ posting lên phiếu.
--   (5) trả token.
-- ─────────────────────────────────────────────────────────────────────
DO $backfill$
DECLARE
  c_org  uuid := 'aaaa0000-0000-4000-8000-000000000001';
  c_date date := DATE '2026-03-01';
  v_acc  uuid;
  r      record;
  v_post uuid;
  v_n    int := 0;
  v_sum  numeric := 0;
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
       AND c.status::text = 'ACTIVE'
     ORDER BY ie.id
  LOOP
    -- (1) tắt cầu a85 cho phiếu này, trong đúng transaction này
    INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
    VALUES (r.id, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
    ON CONFLICT (income_expense_id) DO UPDATE
      SET xid = EXCLUDED.xid, purpose = EXCLUDED.purpose, granted_at = now();

    -- (2) trỏ sang sổ thật
    UPDATE public.income_expenses SET account_id = v_acc WHERE id = r.id;

    -- (3) ghi bút toán, ngày theo ý chủ
    v_post := app_private.finance_v2_post_voucher_with_source_v1(
      p_org              => c_org,
      p_voucher_id       => r.id,
      p_source_kind      => 'DEPOSIT_OPENING_ATAM',
      p_external_kind    => 'DEPOSIT_OPENING_2026_03',
      p_external_id      => r.id,
      p_external_line_id => NULL,
      p_posted_on        => c_date,
      p_amount_basis     => 'VOUCHER_TOTAL',
      p_generation       => 1
    );

    -- (4) con trỏ posting
    UPDATE public.income_expenses
       SET active_posting_id_v2 = v_post,
           posting_id           = v_post,
           posting_status       = 'POSTED',
           posting_mode         = COALESCE(posting_mode, 'CASHBOOK'),
           posted_at_v2         = now(),
           updated_at           = now()
     WHERE id = r.id;

    -- (5) trả token
    DELETE FROM app_private.ie_transition_authorization
     WHERE income_expense_id = r.id AND xid = pg_current_xact_id();

    v_n := v_n + 1;
    v_sum := v_sum + r.total_amount;
  END LOOP;

  RAISE NOTICE 'Đã đưa % phiếu cọc (tổng %đ) vào sổ ATam, ngày ghi sổ %',
    v_n, round(v_sum), c_date;
END
$backfill$;

-- ─────────────────────────────────────────────────────────────────────
-- TỰ KIỂM — tiền phải vào ĐÚNG một lần, ĐÚNG sổ, ĐÚNG số
-- ─────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  c_org uuid := 'aaaa0000-0000-4000-8000-000000000001';
  v_acc uuid; v_n int; v_sum numeric; v_lines int; v_conlai int;
BEGIN
  SELECT a.id INTO v_acc FROM public.accounts a
   WHERE a.organization_id = c_org AND a.name = 'ATam' AND a.deleted_at IS NULL;

  -- Đúng một bút toán cho mỗi phiếu, không trùng.
  SELECT count(*), COALESCE(sum(p.gross_amount),0) INTO v_n, v_sum
    FROM public.income_expense_postings p
   WHERE p.organization_id = c_org
     AND p.external_source_kind = 'DEPOSIT_OPENING_2026_03'
     AND p.event_kind = 'POSTING';

  SELECT count(*) INTO v_lines
    FROM public.income_expense_posting_lines l
    JOIN public.income_expense_postings p ON p.id = l.posting_id
   WHERE p.external_source_kind = 'DEPOSIT_OPENING_2026_03';

  IF v_n <> 217 THEN
    RAISE EXCEPTION 'Sinh % bút toán, phải đúng 217. DỪNG.', v_n;
  END IF;
  IF round(v_sum) <> 940700000 THEN
    RAISE EXCEPTION 'Tổng bút toán %đ, phải đúng 940.700.000đ. DỪNG.', round(v_sum);
  END IF;
  IF v_lines <> 217 THEN
    RAISE EXCEPTION 'Có % dòng bút toán, phiếu không tiền thối/làm tròn phải đúng 217. DỪNG.', v_lines;
  END IF;

  -- Mọi dòng phải nằm ở ATam, và mang dấu DƯƠNG (tiền vào).
  IF EXISTS (
    SELECT 1 FROM public.income_expense_posting_lines l
      JOIN public.income_expense_postings p ON p.id = l.posting_id
     WHERE p.external_source_kind = 'DEPOSIT_OPENING_2026_03'
       AND (l.account_id IS DISTINCT FROM v_acc OR l.signed_amount <= 0)
  ) THEN
    RAISE EXCEPTION 'Có dòng bút toán không nằm ở ATam hoặc mang dấu âm. DỪNG.';
  END IF;

  -- Ngày ghi sổ đúng như chủ chốt.
  IF EXISTS (
    SELECT 1 FROM public.income_expense_postings p
     WHERE p.external_source_kind = 'DEPOSIT_OPENING_2026_03'
       AND p.posted_on <> DATE '2026-03-01'
  ) THEN
    RAISE EXCEPTION 'Có bút toán không mang ngày 01/03/2026. DỪNG.';
  END IF;

  -- Không được đụng nhóm khách đã trả phòng.
  SELECT count(*) INTO v_conlai
    FROM public.income_expenses ie
    JOIN public.income_expense_items it ON it.income_expense_id = ie.id
    JOIN public.contracts c ON c.id = ie.contract_id
   WHERE ie.organization_id = c_org AND ie.deleted_at IS NULL
     AND ie.approval_status <> 'CANCELLED'
     AND ie.type = 'INCOME' AND it.accounting_class = 'DEPOSIT'
     AND ie.posting_status = 'NOT_APPLICABLE'
     AND c.status::text = 'TERMINATED';
  IF v_conlai <> 34 THEN
    RAISE EXCEPTION
      'Nhóm khách đã trả phòng còn % phiếu, phải còn nguyên 34 — bản vá đã đụng nhầm. DỪNG.', v_conlai;
  END IF;

  RAISE NOTICE 'ĐÃ KIỂM: 217 bút toán / 940.700.000đ vào ATam ngày 01/03/2026; nhóm đã trả phòng còn nguyên 34 phiếu.';
END
$verify$;

COMMIT;
