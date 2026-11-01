-- =============================================================================
-- khoa_ky_thang_da_chot_ln — tháng đã chốt LN khoá cả phiếu có KỲ rơi vào tháng đó
-- + đọc khoản "phát sinh sau chốt"
-- Ngày 22/10/2026 · rà 21/10, F06 · chủ chốt 22/10: "chặn hẳn nhưng phần, Báo cáo LN
-- tháng 8 không cộng nhưng nếu có phiếu tạo sau chốt vì lý do nào đó thì báo lên để
-- user biết".
-- =============================================================================
-- VÌ SAO
--   Khoá tháng hiện có (20260925073251: trigger a02_ie_profit_lock_* /
--   a02_ie_items_profit_lock → app_private.assert_profit_month_open_v2) chỉ xét NGÀY
--   PHIẾU. Lợi nhuận lại tính theo KỲ (public.fa_accrual_allocations): phiếu gắn hoá đơn
--   ⇒ tháng hoá đơn; hạng mục có kỳ ⇒ chia theo tháng của kỳ; không kỳ ⇒ tháng ngày phiếu.
--   Chốt T8 xong, ngày 05/09 lập phiếu chi kỳ 01/08–31/08 vẫn lưu được và LN T8 đổi mà
--   không ai thấy. Đo production 22/10 (chỉ đọc): đã có phiếu lập tay sau khi chốt mang kỳ
--   của tháng đã chốt.
--
-- LÀM GÌ
--   1. Luật tháng phân bổ của MỘT dòng (app_private.profit_line_months_v1) chép từ
--      fa_accrual_allocations (nhánh không hoá đơn); test PGlite so từng (phiếu, tháng) với
--      định nghĩa SỐNG của fa_accrual_allocations.
--      app_private.ie_profit_period_locked_month_v1(phiếu, gồm_khoản_đã_chốt): tháng ĐÃ CHỐT
--      sớm nhất mà phiếu ĐÃ DUYỆT (bản cho trước + hạng mục đang có) đóng góp KQKD theo kỳ.
--   2. Trigger phiếu public.income_expenses_check_profit_lock(): DỰNG TỪ THÂN ĐANG CHẠY
--      production (md5 877f88c3…, đúng thân 20260925073251). Ngoài (toà, ngày phiếu) cũ/mới
--      còn xét tháng KQKD theo kỳ của bản cũ / bản mới khi đang tính LN (đã duyệt, chưa xoá).
--      Rơi vào tháng đã chốt ⇒ khoá NHƯ khoá theo ngày phiếu: sửa, xoá, huỷ, DUYỆT, khôi phục
--      đều bị chặn, với MỌI người (kể cả chủ công ty, super admin, job không đăng nhập). Các
--      ngoại lệ không đổi tiền (dời lịch phiếu lặp, bàn giao, đã kiểm, cờ hạn chế, cột vòng
--      đời NULL→giá trị, STOP_RECURRING, LINK_CONTRACT) GIỮ NGUYÊN từng chữ — cùng một khối
--      với khoá ngày phiếu.
--      Phiếu CHỜ DUYỆT không bị cửa đầu phiếu xét (chưa tính LN; lúc duyệt mới xét): sửa phiếu
--      chờ (revise_pending_income_expense_v1 ghi đầu phiếu TRƯỚC rồi mới thay hạng mục) dời kỳ
--      ra tháng mở được, HUỶ / XOÁ được — để gỡ phiếu kẹt. Dòng kỳ khoá của phiếu chờ do cửa
--      hạng mục (mục 3) chặn.
--   3. Trigger MỚI trên hạng mục a02_ie_items_profit_period_lock (AFTER — lớp KQKD và số tiền
--      của dòng mới do set_ie_item_accounting_class / trigger_auto_calc_item_amount, hai
--      trigger BEFORE xếp sau a02 theo tên, điền): thêm / sửa / xoá dòng KQKD có kỳ rơi vào
--      tháng đã chốt ⇒ chặn (dòng cũ: phiếu đang tính LN; dòng mới: phiếu đã duyệt hoặc chờ
--      duyệt). Hạng mục là tiền — không ngoại lệ, như a02_ie_items_profit_lock.
--   Câu lỗi: "[PROFIT_LOCKED] Tháng MM/YYYY của toà X đã chốt lợi nhuận — không ghi được
--   phiếu có kỳ trong tháng này. Muốn ghi: mở khoá tháng ở tab Chốt LN."
--   NGOẠI LỆ "thu mới nợ cũ" GIỮ NGUYÊN: phiếu theo hoá đơn CÙNG TOÀ (invoice_id có tháng
--   hoá đơn hợp lệ — tháng KQKD là tháng hoá đơn) không bị cửa kỳ chặn khi THÊM vào tháng đã
--   chốt: thu tiền hoá đơn tháng đã chốt (kèm tiền thối / hoàn trả gắn hoá đơn) và DUYỆT
--   khoản đó vẫn làm được; đó là khoản "phát sinh sau chốt" phải báo lên, gỡ / sửa lại được.
--   Hai giới hạn (app_private.ie_invoice_locked_month_v1):
--     · hoá đơn của toà KHÁC ⇒ không phải thu nợ cũ của toà này ⇒ khoá như mọi phiếu;
--     · khoản theo hoá đơn ĐÃ NẰM TRONG SỐ CHỐT (lập và duyệt trước lúc chốt — đúng tiêu chí
--       after_lock của RPC mục 4) ⇒ không gỡ / huỷ duyệt / sửa dòng được, kể cả qua nhánh xoá
--       của undo_invoice_payment_compat_v1 và unapprove_voucher (hai hàm không gọi
--       app_private.assert_period_open_for_edit_v1). Nhánh hoàn tác (REVERSED) lập phiếu đảo
--       MỚI sau chốt ⇒ không bị chặn nhưng hiện ở after_lock.
--   4. RPC CHỈ ĐỌC public.profit_post_lock_vouchers_v1(p_from, p_to, p_building_ids): trong
--      các toà×tháng ĐÃ CHỐT (profit_monthly LOCKED, có locked_at), trả
--        · locked     — toà×tháng đã chốt (form phiếu báo lỗi trước khi lưu, tab Chốt LN);
--        · after_lock — phiếu ĐÃ DUYỆT đóng góp dòng KQKD vào tháng đã chốt theo đúng luật kỳ
--                       (đọc thẳng fa_accrual_allocations — nguồn của chốt LN) mà TẠO hoặc
--                       DUYỆT SAU thời điểm chốt ⇒ số chốt không có nó. Kèm toà, mã, ngày
--                       phiếu, kỳ / tháng hoá đơn, thu/chi PHẦN THUỘC tháng, thời điểm chốt.
--      Báo cáo LN không cộng nhóm after_lock vào tháng đã chốt mà hiện riêng; tab Chốt LN gắn
--      nhãn. Quyền: chỉ toà public.can_access_building (như fa_accrual_allocations); anon /
--      chưa đăng nhập ⇒ 42501. Phiếu có hạng mục hạn chế mà người gọi không được xem (đúng
--      luật policy income_expenses_restricted_select) vẫn đếm tiền nhưng che mã và tên.
--   5. Cửa chặn chốt app_private.guard_profit_month_lock_pending_v1 (trigger
--      a10_profit_month_lock_requires_no_pending, DỰNG TỪ THÂN production md5 a388bdb8…): ngoài
--      phiếu chờ duyệt có NGÀY PHIẾU trong tháng đang chốt, đếm cả phiếu chờ duyệt (không theo
--      hoá đơn) có dòng KQKD mà KỲ rơi vào tháng đó — sau chốt phiếu đó không duyệt được nữa.
--      Câu báo giữ nguyên: "duyệt hoặc huỷ trước khi chốt".
--
-- KHÔNG ĐỤNG
--   Không sửa dữ liệu cũ (phiếu đã có kỳ trong tháng đã chốt nằm yên, hiện ở after_lock).
--   Không đổi hàm fa_*, hàm băm / dấu vân tay / hàm chốt LN, khoá theo ngày phiếu
--   (profit_month_locked_v1, assert_profit_month_open_v2, a02_ie_items_profit_lock),
--   assert_period_open_for_edit_v1, phần đếm theo ngày phiếu của cửa chặn chốt.
--   Job sinh phiếu định kỳ (generate_recurring_vouchers, 01:00): phiếu con có kỳ = tháng
--   của ngày kỳ nên đã nằm dưới khoá ngày phiếu; mỗi phiếu con (đầu phiếu + hạng mục) trong
--   khối EXCEPTION riêng ⇒ một phiếu con bị chặn không làm vỡ cả lượt (test PGlite).
--   Trigger phiếu giữ SECURITY INVOKER + ACL như cũ; hàm phụ app_private đóng với mọi vai
--   (đường ghi thật đi qua RPC definer, trigger chạy dưới quyền chủ bảng).
--
-- ĐƯỜNG LÙI
--   CREATE OR REPLACE public.income_expenses_check_profit_lock() (md5 877f88c3…) và
--   app_private.guard_profit_month_lock_pending_v1() (md5 a388bdb8…) bằng thân của migration
--   20260925073251; DROP TRIGGER a02_ie_items_profit_period_lock ON
--   public.income_expense_items; DROP FUNCTION public.profit_post_lock_vouchers_v1(date,date,uuid[]),
--   app_private.guard_ie_item_profit_period_v1(), app_private.raise_profit_period_locked_v1(uuid,date),
--   app_private.ie_profit_period_locked_month_v1(public.income_expenses,boolean),
--   app_private.ie_invoice_locked_month_v1(public.income_expenses,date,boolean),
--   app_private.ie_invoice_month_v1(uuid), app_private.profit_line_locked_month_v1(uuid,date,date,date),
--   app_private.profit_line_months_v1(date,date,date).
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
    'public.fa_accrual_allocations(date,date,uuid[])',
    'app_private.profit_month_locked_v1(uuid,date)',
    'app_private.assert_profit_month_open_v2(uuid,date,text)',
    'public.can_access_building(uuid)',
    'public.can_view_restricted_ie()',
    'public.income_expenses_check_profit_lock()',
    'app_private.guard_profit_month_lock_pending_v1()'
  ] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'Thiếu % — DỪNG.', v_sig USING ERRCODE = '55000';
    END IF;
  END LOOP;
  v_md5 := md5(pg_get_functiondef('public.income_expenses_check_profit_lock()'::regprocedure));
  -- 877f88c3…: thân 20260925073251 đang chạy production (đọc 22/10/2026).
  -- 6e016a8f…: thân của chính file này (lượt hai).
  IF v_md5 <> ALL (ARRAY['877f88c3b7371acb6633ce5f091e85d4', '6e016a8f60e83129cfb6cf2ad2829fb5']) THEN
    RAISE EXCEPTION 'public.income_expenses_check_profit_lock() KHÁC bản đã rà (md5 %) — DỪNG, chụp lại pg_get_functiondef rồi rà lại.',
      v_md5 USING ERRCODE = '55000';
  END IF;
  v_md5 := md5(pg_get_functiondef('app_private.guard_profit_month_lock_pending_v1()'::regprocedure));
  -- a388bdb8…: thân 20260925073251 đang chạy production (đọc 23/10/2026).
  -- c85c82a8…: thân của chính file này (lượt hai).
  IF v_md5 <> ALL (ARRAY['a388bdb80d2ff6a213c4e2866f7e49fa', 'c85c82a8e05b21dacc8a7939dc4fefe7']) THEN
    RAISE EXCEPTION 'app_private.guard_profit_month_lock_pending_v1() KHÁC bản đã rà (md5 %) — DỪNG, chụp lại pg_get_functiondef rồi rà lại.',
      v_md5 USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Luật tháng phân bổ KQKD của MỘT dòng — chép fa_accrual_allocations (nhánh không hoá
--    đơn): đủ kỳ, kỳ xuôi ⇒ mọi tháng của kỳ; kỳ ngược ⇒ tháng bắt đầu; thiếu kỳ ⇒ tháng
--    của ngày phiếu.
CREATE OR REPLACE FUNCTION app_private.profit_line_months_v1(
  p_voucher_date date,
  p_start        date,
  p_end          date
)
RETURNS SETOF date
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  SELECT pg_catalog.date_trunc('month', p_voucher_date)::date
   WHERE (p_start IS NULL OR p_end IS NULL)
     AND p_voucher_date IS NOT NULL
  UNION ALL
  SELECT pg_catalog.date_trunc('month', p_start)::date
   WHERE p_start IS NOT NULL AND p_end IS NOT NULL AND p_end < p_start
  UNION ALL
  SELECT (pg_catalog.date_trunc('month', p_start) + pg_catalog.make_interval(months => s.k))::date
    FROM pg_catalog.generate_series(
           0,
           EXTRACT(year FROM p_end)::int * 12 + EXTRACT(month FROM p_end)::int
           - EXTRACT(year FROM p_start)::int * 12 - EXTRACT(month FROM p_start)::int) AS s(k)
   WHERE p_start IS NOT NULL AND p_end IS NOT NULL AND p_end >= p_start
$fn$;

-- Tháng ĐÃ CHỐT sớm nhất mà một dòng rơi vào ở toà này (NULL: không tháng nào).
CREATE OR REPLACE FUNCTION app_private.profit_line_locked_month_v1(
  p_building     uuid,
  p_voucher_date date,
  p_start        date,
  p_end          date
)
RETURNS date
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  SELECT pg_catalog.min(m.m)
    FROM app_private.profit_line_months_v1(p_voucher_date, p_start, p_end) AS m(m)
   WHERE app_private.profit_month_locked_v1(p_building, m.m)
$fn$;

-- Tháng hoá đơn hợp lệ của phiếu (NULL: phiếu không theo hoá đơn) — cùng điều kiện
-- inv_month của fa_accrual_allocations.
CREATE OR REPLACE FUNCTION app_private.ie_invoice_month_v1(p_invoice_id uuid)
RETURNS date
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  SELECT pg_catalog.to_date(inv.billing_month, 'YYYY-MM')
    FROM public.invoices inv
   WHERE inv.id = p_invoice_id
     AND inv.deleted_at IS NULL
     AND inv.billing_month ~ '^\d{4}-\d{2}$'
$fn$;

-- Phiếu theo hoá đơn (tháng KQKD = tháng hoá đơn p_inv_month): trả tháng hoá đơn khi tháng đó
-- ĐÃ CHỐT ở toà của phiếu và
--   · hoá đơn thuộc toà KHÁC (không phải thu nợ cũ của toà này) ⇒ khoá như mọi phiếu; hoặc
--   · p_gom_da_chot và phiếu đã duyệt nằm trong số chốt (lập và duyệt trước lúc chốt — phủ định
--     đúng tiêu chí after_lock của profit_post_lock_vouchers_v1) ⇒ không gỡ / đổi được.
-- Còn lại (thu tiền hoá đơn cùng toà sau chốt) ⇒ NULL: ngoại lệ "thu mới nợ cũ".
CREATE OR REPLACE FUNCTION app_private.ie_invoice_locked_month_v1(
  p_row         public.income_expenses,
  p_inv_month   date,
  p_gom_da_chot boolean
)
RETURNS date
LANGUAGE sql
STABLE
SET search_path TO ''
AS $fn$
  SELECT p_inv_month
    FROM public.profit_monthly pm
   WHERE pm.building_id = p_row.building_id
     AND pm.period_month = p_inv_month
     AND pm.locked_at IS NOT NULL
     AND (NOT EXISTS (SELECT 1 FROM public.invoices inv
                       WHERE inv.id = p_row.invoice_id
                         AND inv.building_id = p_row.building_id)
          OR (p_gom_da_chot IS TRUE
              AND p_row.approval_status = 'APPROVED'
              AND p_row.deleted_at IS NULL
              AND NOT COALESCE(p_row.created_at > pm.locked_at OR p_row.approved_at > pm.locked_at, false)))
$fn$;

-- Tháng ĐÃ CHỐT sớm nhất mà PHIẾU ĐÃ DUYỆT (bản cho trước + các hạng mục đang có trong bảng)
-- đóng góp KQKD theo kỳ. NULL khi: không có bản (OLD của INSERT), đã xoá, chưa duyệt / đã huỷ,
-- thiếu toà, tắt KQKD, toà chưa chốt tháng nào, phiếu không có dòng KQKD. Phiếu theo hoá đơn:
-- xem ie_invoice_locked_month_v1 (p_gom_da_chot: true cho bản CŨ — gỡ khoản đã chốt bị chặn;
-- false cho bản MỚI — thu nợ cũ cùng toà vẫn thêm được).
CREATE OR REPLACE FUNCTION app_private.ie_profit_period_locked_month_v1(
  p_row         public.income_expenses,
  p_gom_da_chot boolean
)
RETURNS date
LANGUAGE plpgsql
STABLE
SET search_path TO ''
AS $fn$
DECLARE
  v_m  date;
  v_hd date;
BEGIN
  IF p_row.id IS NULL
     OR p_row.deleted_at IS NOT NULL
     OR p_row.building_id IS NULL
     OR p_row.business_result_accounting IS FALSE
     OR p_row.approval_status IS DISTINCT FROM 'APPROVED' THEN
    RETURN NULL;
  END IF;
  -- Đường nhanh: toà chưa chốt tháng nào.
  IF NOT EXISTS (
    SELECT 1 FROM public.profit_monthly pm
     WHERE pm.building_id = p_row.building_id
       AND pm.locked_at IS NOT NULL
  ) THEN
    RETURN NULL;
  END IF;
  v_hd := app_private.ie_invoice_month_v1(p_row.invoice_id);
  IF v_hd IS NOT NULL THEN
    -- như invoice_items / invoice_no_item của fa_accrual_allocations: có dòng KQKD hoặc không dòng
    IF EXISTS (SELECT 1 FROM public.income_expense_items i WHERE i.income_expense_id = p_row.id)
       AND NOT EXISTS (
         SELECT 1
           FROM public.income_expense_items i
           JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
          WHERE i.income_expense_id = p_row.id
            AND (p_row.business_result_accounting IS TRUE OR i.accounting_class = 'PNL')) THEN
      RETURN NULL;
    END IF;
    RETURN app_private.ie_invoice_locked_month_v1(p_row, v_hd, p_gom_da_chot);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.income_expense_items i WHERE i.income_expense_id = p_row.id) THEN
    -- phiếu không dòng: cả tổng vào tháng của ngày phiếu
    RETURN CASE WHEN app_private.profit_month_locked_v1(p_row.building_id, p_row.voucher_date)
                THEN pg_catalog.date_trunc('month', p_row.voucher_date)::date END;
  END IF;
  SELECT pg_catalog.min(app_private.profit_line_locked_month_v1(
           p_row.building_id, p_row.voucher_date, i.start_date, i.end_date))
    INTO v_m
    FROM public.income_expense_items i
    JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
   WHERE i.income_expense_id = p_row.id
     AND (p_row.business_result_accounting IS TRUE OR i.accounting_class = 'PNL');
  RETURN v_m;
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.raise_profit_period_locked_v1(p_building uuid, p_month date)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path TO ''
AS $fn$
DECLARE
  v_name text;
BEGIN
  SELECT b.name INTO v_name FROM public.buildings b WHERE b.id = p_building;
  RAISE EXCEPTION
    '[PROFIT_LOCKED] Tháng % của toà % đã chốt lợi nhuận — không ghi được phiếu có kỳ trong tháng này. Muốn ghi: mở khoá tháng ở tab Chốt LN.',
    pg_catalog.to_char(p_month, 'MM/YYYY'), COALESCE(v_name, '(không rõ tên)')
    USING ERRCODE = 'P0001';
END
$fn$;

-- ---------------------------------------------------------------------------
-- 2. Trigger phiếu: thân production (20260925073251) + tháng KQKD theo kỳ.
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
-- 3. Trigger hạng mục theo KỲ (AFTER: lớp KQKD + số tiền của dòng mới đã được điền).
CREATE OR REPLACE FUNCTION app_private.guard_ie_item_profit_period_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $fn$
DECLARE
  v_p  public.income_expenses%ROWTYPE;
  v_m  date;
  v_hd date;
BEGIN
  -- Dòng CŨ của phiếu đang tính LN (đã duyệt, chưa xoá) — sửa / xoá phần của tháng đã chốt.
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT * INTO v_p FROM public.income_expenses ie WHERE ie.id = OLD.income_expense_id;
    IF FOUND
       AND v_p.deleted_at IS NULL
       AND v_p.approval_status = 'APPROVED'
       AND v_p.business_result_accounting IS DISTINCT FROM false
       AND (v_p.business_result_accounting IS TRUE OR OLD.accounting_class = 'PNL')
       AND EXISTS (SELECT 1 FROM public.income_expense_types t WHERE t.id = OLD.income_expense_type_id) THEN
      v_hd := app_private.ie_invoice_month_v1(v_p.invoice_id);
      v_m := CASE WHEN v_hd IS NOT NULL
                  THEN app_private.ie_invoice_locked_month_v1(v_p, v_hd, true)
                  ELSE app_private.profit_line_locked_month_v1(v_p.building_id, v_p.voucher_date, OLD.start_date, OLD.end_date)
             END;
      IF v_m IS NOT NULL THEN
        PERFORM app_private.raise_profit_period_locked_v1(v_p.building_id, v_m);
      END IF;
    END IF;
  END IF;

  -- Dòng MỚI của phiếu đã duyệt hoặc chờ duyệt rơi vào tháng đã chốt. Phiếu theo hoá đơn cùng
  -- toà: chỉ chặn khi phiếu đã nằm trong số chốt (thêm / đổi dòng là đổi số chốt).
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT * INTO v_p FROM public.income_expenses ie WHERE ie.id = NEW.income_expense_id;
    IF FOUND
       AND v_p.deleted_at IS NULL
       AND v_p.approval_status IN ('APPROVED', 'UNAPPROVED')
       AND v_p.business_result_accounting IS DISTINCT FROM false
       AND (v_p.business_result_accounting IS TRUE OR NEW.accounting_class = 'PNL')
       AND EXISTS (SELECT 1 FROM public.income_expense_types t WHERE t.id = NEW.income_expense_type_id) THEN
      v_hd := app_private.ie_invoice_month_v1(v_p.invoice_id);
      v_m := CASE WHEN v_hd IS NOT NULL
                  THEN app_private.ie_invoice_locked_month_v1(v_p, v_hd, true)
                  ELSE app_private.profit_line_locked_month_v1(v_p.building_id, v_p.voucher_date, NEW.start_date, NEW.end_date)
             END;
      IF v_m IS NOT NULL THEN
        PERFORM app_private.raise_profit_period_locked_v1(v_p.building_id, v_m);
      END IF;
    END IF;
  END IF;

  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS a02_ie_items_profit_period_lock ON public.income_expense_items;
CREATE TRIGGER a02_ie_items_profit_period_lock
  AFTER INSERT OR UPDATE OR DELETE ON public.income_expense_items
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_ie_item_profit_period_v1();

REVOKE ALL ON FUNCTION app_private.profit_line_months_v1(date, date, date)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_line_locked_month_v1(uuid, date, date, date)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.ie_invoice_month_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.ie_invoice_locked_month_v1(public.income_expenses, date, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.ie_profit_period_locked_month_v1(public.income_expenses, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.raise_profit_period_locked_v1(uuid, date)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_ie_item_profit_period_v1()
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3b. Cửa chặn chốt: thân production (20260925073251) + phiếu chờ duyệt có KỲ trong tháng đang
--     chốt (sau chốt phiếu đó không duyệt được nữa — phải duyệt hoặc huỷ trước).
CREATE OR REPLACE FUNCTION app_private.guard_profit_month_lock_pending_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_n integer;
  v_list text;
  v_name text;
BEGIN
  -- Chỉ xét lúc CHỐT: locked_at nhận giá trị mới. Mở khoá (về NULL) và các lần
  -- ghi không đổi locked_at đi qua.
  IF NEW.locked_at IS NULL
     OR (TG_OP = 'UPDATE' AND OLD.locked_at IS NOT DISTINCT FROM NEW.locked_at) THEN
    RETURN NEW;
  END IF;

  SELECT count(*),
         string_agg(x.nhan, ', ' ORDER BY x.voucher_date, x.nhan) FILTER (WHERE x.rn <= 10)
    INTO v_n, v_list
    FROM (
      SELECT COALESCE(NULLIF(ie.code, ''), 'phiếu chưa có mã') AS nhan,
             ie.voucher_date,
             row_number() OVER (ORDER BY ie.voucher_date, ie.code) AS rn
        FROM public.income_expenses ie
       WHERE ie.building_id = NEW.building_id
         AND ((ie.voucher_date >= date_trunc('month', NEW.period_month)::date
               AND ie.voucher_date < (date_trunc('month', NEW.period_month) + interval '1 month')::date)
              -- 23/10/2026 (F06): dòng KQKD có KỲ rơi vào tháng đang chốt (luật fa_accrual_allocations,
              -- phiếu không theo hoá đơn).
              OR (ie.business_result_accounting IS DISTINCT FROM false
                  AND app_private.ie_invoice_month_v1(ie.invoice_id) IS NULL
                  AND EXISTS (
                    SELECT 1
                      FROM public.income_expense_items i
                      JOIN public.income_expense_types t ON t.id = i.income_expense_type_id
                      CROSS JOIN LATERAL app_private.profit_line_months_v1(ie.voucher_date, i.start_date, i.end_date) AS m(m)
                     WHERE i.income_expense_id = ie.id
                       AND (ie.business_result_accounting IS TRUE OR i.accounting_class = 'PNL')
                       AND m.m = date_trunc('month', NEW.period_month)::date)))
         AND ie.approval_status = 'UNAPPROVED'
         AND ie.deleted_at IS NULL
    ) x;

  IF v_n > 0 THEN
    SELECT b.name INTO v_name FROM public.buildings b WHERE b.id = NEW.building_id;
    RAISE EXCEPTION
      'Còn % phiếu chờ duyệt trong tháng % của toà %: % — duyệt hoặc huỷ trước khi chốt.',
      v_n, to_char(NEW.period_month, 'MM/YYYY'), COALESCE(v_name, '(không rõ tên)'),
      v_list || CASE WHEN v_n > 10 THEN ', …' ELSE '' END
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION app_private.guard_profit_month_lock_pending_v1()
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. RPC đọc "phát sinh sau chốt".
CREATE OR REPLACE FUNCTION public.profit_post_lock_vouchers_v1(
  p_from         date,
  p_to           date,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  v_from    date := pg_catalog.date_trunc('month', p_from)::date;
  v_to      date := pg_catalog.date_trunc('month', p_to)::date;
  v_ids     uuid[];
  v_xem_han boolean;
  v_kq      jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Cần đăng nhập để xem phiếu phát sinh sau chốt' USING ERRCODE = '42501';
  END IF;
  IF v_from IS NULL OR v_to IS NULL OR v_from > v_to THEN
    RAISE EXCEPTION 'Khoảng tháng không hợp lệ' USING ERRCODE = '22023';
  END IF;
  -- tối đa 36 tháng mỗi lần gọi (Báo cáo LN / Chốt LN xem 1 tháng; form phiếu xem kỳ của phiếu)
  IF v_to > (v_from + interval '35 months')::date THEN
    RAISE EXCEPTION 'Khoảng tháng quá dài (tối đa 36 tháng)' USING ERRCODE = '22023';
  END IF;

  -- Toà người gọi xem được và có ít nhất một tháng ĐÃ CHỐT trong khoảng.
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT pm.building_id), '{}'::uuid[])
    INTO v_ids
    FROM public.profit_monthly pm
    JOIN public.buildings b ON b.id = pm.building_id AND b.deleted_at IS NULL
   WHERE pm.period_month BETWEEN v_from AND v_to
     AND pm.status = 'LOCKED'
     AND pm.locked_at IS NOT NULL
     AND (p_building_ids IS NULL OR pm.building_id = ANY (p_building_ids))
     AND public.can_access_building(pm.building_id);

  -- Cùng luật policy income_expenses_restricted_select: không được xem phiếu hạn chế
  -- thì vẫn đếm tiền nhưng che mã + tên.
  v_xem_han := COALESCE(public.can_view_restricted_ie(), false);

  WITH locked AS (
    SELECT pm.building_id, b.name AS building_name, pm.period_month AS month, pm.locked_at
      FROM public.profit_monthly pm
      JOIN public.buildings b ON b.id = pm.building_id
     WHERE pm.building_id = ANY (v_ids)
       AND pm.period_month BETWEEN v_from AND v_to
       AND pm.status = 'LOCKED'
       AND pm.locked_at IS NOT NULL
  ),
  -- Phiếu đã duyệt: đúng nguồn của chốt LN.
  lines AS (
    SELECT a.month, a.voucher_id, a.building_id,
           COALESCE(SUM(a.amount) FILTER (WHERE a.side = 'INCOME'), 0)::numeric AS income,
           COALESCE(SUM(a.amount) FILTER (WHERE a.side = 'EXPENSE'), 0)::numeric AS expense
      FROM public.fa_accrual_allocations(v_from, v_to, v_ids) a
     GROUP BY a.month, a.voucher_id, a.building_id
  ),
  hit AS (
    SELECT ln.month, ln.voucher_id, ln.building_id, ln.income, ln.expense,
           lk.building_name, lk.locked_at,
           v.code, v.name, v.voucher_date, v.type::text AS type, v.created_at, v.approved_at,
           (v.has_restricted_item IS TRUE
              AND v.user_id IS DISTINCT FROM auth.uid()
              AND NOT v_xem_han) AS restricted,
           CASE WHEN inv.billing_month ~ '^\d{4}-\d{2}$' THEN inv.billing_month END AS invoice_month,
           ky.ky_tu, ky.ky_den
      FROM lines ln
      JOIN locked lk ON lk.building_id = ln.building_id AND lk.month = ln.month
      JOIN public.income_expenses v ON v.id = ln.voucher_id
      LEFT JOIN public.invoices inv ON inv.id = v.invoice_id AND inv.deleted_at IS NULL
      LEFT JOIN LATERAL (
        SELECT pg_catalog.min(i.start_date) AS ky_tu, pg_catalog.max(i.end_date) AS ky_den
          FROM public.income_expense_items i
         WHERE i.income_expense_id = v.id
           AND i.start_date IS NOT NULL
           AND i.end_date IS NOT NULL
      ) ky ON true
     WHERE (ln.income <> 0 OR ln.expense <> 0)
       AND (v.created_at > lk.locked_at OR v.approved_at > lk.locked_at)
  )
  SELECT pg_catalog.jsonb_build_object(
           'from', v_from,
           'to', v_to,
           'locked', COALESCE((
             SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'building_id', lk.building_id,
                      'building_name', lk.building_name,
                      'month', lk.month,
                      'locked_at', lk.locked_at)
                    ORDER BY lk.building_name, lk.building_id, lk.month)
               FROM locked lk), '[]'::jsonb),
           'after_lock', COALESCE((
             SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'voucher_id', h.voucher_id,
                      'building_id', h.building_id,
                      'building_name', h.building_name,
                      'month', h.month,
                      'locked_at', h.locked_at,
                      'code', CASE WHEN h.restricted THEN NULL ELSE h.code END,
                      'name', CASE WHEN h.restricted THEN NULL ELSE h.name END,
                      'restricted', h.restricted,
                      'voucher_date', h.voucher_date,
                      'type', h.type,
                      'invoice_month', h.invoice_month,
                      'period_from', h.ky_tu,
                      'period_to', h.ky_den,
                      'income', h.income,
                      'expense', h.expense,
                      'created_at', h.created_at,
                      'approved_at', h.approved_at)
                    ORDER BY h.building_name, h.month, h.voucher_date, h.code, h.voucher_id)
               FROM hit h), '[]'::jsonb))
    INTO v_kq;

  RETURN v_kq;
END
$fn$;

COMMENT ON FUNCTION public.profit_post_lock_vouchers_v1(date, date, uuid[]) IS
  'Phát sinh sau chốt LN (F06, 22/10/2026): toà×tháng đã chốt trong khoảng + phiếu đã duyệt đóng góp KQKD (fa_accrual_allocations) vào tháng đã chốt mà tạo/duyệt sau thời điểm chốt. Chỉ đọc.';

REVOKE ALL ON FUNCTION public.profit_post_lock_vouchers_v1(date, date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.profit_post_lock_vouchers_v1(date, date, uuid[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Nghiệm thu.
DO $sau$
DECLARE
  v_oid oid := to_regprocedure('public.profit_post_lock_vouchers_v1(date,date,uuid[])');
  v_p   record;
  v_def text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'Chưa tạo được public.profit_post_lock_vouchers_v1' USING ERRCODE = '55000';
  END IF;
  SELECT p.prosecdef, p.provolatile, p.proconfig INTO v_p FROM pg_proc p WHERE p.oid = v_oid;
  IF NOT v_p.prosecdef OR v_p.provolatile <> 's'
     OR v_p.proconfig IS DISTINCT FROM ARRAY['search_path=""'] THEN
    RAISE EXCEPTION 'profit_post_lock_vouchers_v1 sai DEFINER/STABLE/search_path: %', v_p.proconfig
      USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon gọi được profit_post_lock_vouchers_v1' USING ERRCODE = '55000';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated chưa gọi được profit_post_lock_vouchers_v1' USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'profit_post_lock_vouchers_v1') <> 1 THEN
    RAISE EXCEPTION 'Sai số overload của profit_post_lock_vouchers_v1' USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('authenticated', 'app_private.ie_profit_period_locked_month_v1(public.income_expenses,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.ie_invoice_locked_month_v1(public.income_expenses,date,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.guard_ie_item_profit_period_v1()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.guard_profit_month_lock_pending_v1()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.raise_profit_period_locked_v1(uuid,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Hàm khoá kỳ nội bộ đang mở cho authenticated' USING ERRCODE = '55000';
  END IF;

  v_def := regexp_replace(
    pg_get_functiondef('app_private.guard_profit_month_lock_pending_v1()'::regprocedure), '--[^\n]*', '', 'g');
  IF position('app_private.profit_line_months_v1(ie.voucher_date, i.start_date, i.end_date)' IN v_def) = 0
     OR position('duyệt hoặc huỷ trước khi chốt' IN v_def) = 0 THEN
    RAISE EXCEPTION 'guard_profit_month_lock_pending_v1 thiếu phần đếm phiếu chờ duyệt theo kỳ' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.profit_monthly'::regclass
       AND t.tgname = 'a10_profit_month_lock_requires_no_pending'
       AND t.tgenabled = 'O'
       AND t.tgfoid = 'app_private.guard_profit_month_lock_pending_v1()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'Cửa chặn chốt a10_profit_month_lock_requires_no_pending không còn' USING ERRCODE = '55000';
  END IF;

  v_def := regexp_replace(
    pg_get_functiondef('public.income_expenses_check_profit_lock()'::regprocedure), '--[^\n]*', '', 'g');
  IF position('app_private.ie_profit_period_locked_month_v1(OLD, true)' IN v_def) = 0
     OR position('app_private.ie_profit_period_locked_month_v1(NEW, false)' IN v_def) = 0
     OR position('app_private.raise_profit_period_locked_v1(' IN v_def) = 0
     OR position('app_private.assert_profit_month_open_v2(' IN v_def) = 0
     OR position('LINK_CONTRACT' IN v_def) = 0
     OR position('STOP_RECURRING' IN v_def) = 0
     OR v_def ~ '(is_org_owner_v1|is_super_admin|business_result_accounting|auth\.uid)' THEN
    RAISE EXCEPTION 'income_expenses_check_profit_lock mất cửa kỳ, khoá ngày phiếu cũ hoặc có cửa vượt' USING ERRCODE = '55000';
  END IF;
  SELECT p.prosecdef INTO v_p FROM pg_proc p
   WHERE p.oid = 'public.income_expenses_check_profit_lock()'::regprocedure;
  IF v_p.prosecdef THEN
    RAISE EXCEPTION 'income_expenses_check_profit_lock không được thành SECURITY DEFINER' USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.income_expense_items'::regclass
       AND t.tgname = 'a02_ie_items_profit_period_lock'
       AND t.tgenabled = 'O'
       AND NOT t.tgisinternal
       AND t.tgfoid = 'app_private.guard_ie_item_profit_period_v1()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'Thiếu trigger a02_ie_items_profit_period_lock' USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'public.income_expenses'::regclass
         AND t.tgname IN ('a02_ie_profit_lock_ins', 'a02_ie_profit_lock_upd', 'a02_ie_profit_lock_del')
         AND t.tgenabled = 'O'
         AND t.tgfoid = 'public.income_expenses_check_profit_lock()'::regprocedure) <> 3 THEN
    RAISE EXCEPTION 'Ba trigger a02_ie_profit_lock_* không còn gắn hàm khoá tháng' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.income_expense_items'::regclass
       AND t.tgname = 'a02_ie_items_profit_lock'
       AND t.tgenabled = 'O'
       AND t.tgfoid = 'public.income_expense_items_check_profit_lock()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'Khoá ngày phiếu ở hạng mục (a02_ie_items_profit_lock) không còn' USING ERRCODE = '55000';
  END IF;
END
$sau$;

COMMIT;
NOTIFY pgrst, 'reload schema';
