-- =============================================================================
-- M1 — Chương trình "Thống nhất tài chính toàn web" (plan 04/07, chủ đã duyệt)
--
-- Thêm cờ phân loại SỔ ẢO/THỰC cho accounts — chấm dứt nhận diện sổ kỹ thuật
-- bằng so TÊN chuỗi rải rác ở 6+ chỗ (dễ vỡ khi đổi tên).
--   is_virtual = true  → sổ kỹ thuật/bút toán (không có két thật): KHÔNG vào
--                        tổng quỹ tiền thật, không bàn giao, không đối soát két.
--   is_virtual = false → sổ giữ tiền thật (mặc định cho sổ mới).
--
-- NGUYÊN TẮC: chỉ THÊM nhãn — không đổi bất kỳ con số quá khứ nào.
-- View accounts_with_balance recreate với công thức GIỮ NGUYÊN TỪNG KÝ TỰ
-- (đối chiếu trước/sau phải IDENTICAL), chỉ thêm cột is_virtual.
-- cashbook_settlement_report: GIỮ heuristic phạm vi hoạt động (đổi hẳn sang
-- NOT is_virtual sẽ kéo thêm các sổ thực ít hoạt động vào báo cáo → đổi output,
-- vi phạm ràng buộc bất biến) — chỉ THÊM guard "NOT a.is_virtual" chặn cứng
-- sổ ảo lọt vào nếu sau này có sổ ảo tên đuôi "Thu".
-- =============================================================================

-- 1. Cột + backfill
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS is_virtual boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.accounts.is_virtual IS
  'Sổ ảo/kỹ thuật (CỌC giữ hộ, Cấn trừ nội bộ, Làm tròn, Thối...): chỉ chứa bút toán, không có két tiền thật. Mọi thống kê TIỀN THẬT phải lọc is_virtual = false.';

UPDATE public.accounts
   SET is_virtual = true
 WHERE name IN ('CỌC (giữ hộ khách)', 'Cấn trừ thanh lý (nội bộ)', 'Làm tròn tiền thiếu')
    OR name LIKE '%Thối';

-- 2. Recreate view accounts_with_balance: THÊM cột is_virtual, công thức giữ nguyên
--    (khớp định nghĩa live pg_get_viewdef ngày 04/07; ACL replicate bên dưới).
DROP VIEW IF EXISTS public.accounts_with_balance;
CREATE VIEW public.accounts_with_balance AS
 SELECT id,
    user_id,
    name,
    bank_name,
    account_number,
    is_default,
    created_at,
    updated_at,
    deleted_at,
    code,
    description,
    bank_account_holder,
    initial_amount,
    initial_date,
    lock_date,
    branch,
    is_virtual,
    COALESCE(initial_amount, 0::numeric) + COALESCE(( SELECT sum(ie.total_amount) AS sum
           FROM income_expenses ie
          WHERE ie.account_id = a.id AND ie.type = 'INCOME'::text AND ie.approval_status = 'APPROVED'::text AND ie.deleted_at IS NULL), 0::numeric) - COALESCE(( SELECT sum(ie.total_amount) AS sum
           FROM income_expenses ie
          WHERE ie.account_id = a.id AND ie.type = 'EXPENSE'::text AND ie.approval_status = 'APPROVED'::text AND ie.deleted_at IS NULL), 0::numeric) + COALESCE(( SELECT sum(ie.change_amount) AS sum
           FROM income_expenses ie
          WHERE ie.change_account_id = a.id AND ie.approval_status = 'APPROVED'::text AND ie.deleted_at IS NULL), 0::numeric) + COALESCE(( SELECT sum(ie.rounding_amount) AS sum
           FROM income_expenses ie
          WHERE ie.rounding_account_id = a.id AND ie.approval_status = 'APPROVED'::text AND ie.deleted_at IS NULL), 0::numeric) AS current_amount
   FROM accounts a
  WHERE deleted_at IS NULL;

GRANT ALL ON public.accounts_with_balance TO anon;
GRANT ALL ON public.accounts_with_balance TO authenticated;
GRANT ALL ON public.accounts_with_balance TO service_role;

-- 3. cashbook_settlement_report: thêm guard NOT is_virtual (output hiện tại KHÔNG đổi —
--    heuristic phạm vi giữ nguyên; body dưới đây PATCH TỰ ĐỘNG từ pg_get_functiondef live 04/07,
--    khác biệt DUY NHẤT là dòng "AND NOT a.is_virtual").
CREATE OR REPLACE FUNCTION public.cashbook_settlement_report(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_accounts jsonb;
  v_sessions jsonb;
  v_recons   jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;

  WITH scope AS (
    SELECT a.id, a.name, a.user_id, a.bank_name,
           p.full_name AS owner_name,
           awb.current_amount
    FROM accounts a
    LEFT JOIN profiles p ON p.id = a.user_id
    LEFT JOIN accounts_with_balance awb ON awb.id = a.id
    WHERE a.deleted_at IS NULL
      AND NOT a.is_virtual          -- guard cờ ảo (M1): sổ bút toán không bao giờ vào đối soát két
      AND (public.is_super_admin() OR a.user_id = auth.uid() OR public.same_team(a.user_id))
      AND (
        btrim(a.name) LIKE '%Thu'
        OR a.name ILIKE 'tk%'
        OR a.bank_name IS NOT NULL
        OR EXISTS (SELECT 1 FROM cash_handovers ch WHERE ch.from_account_id = a.id)
      )
  )
  SELECT jsonb_agg(jsonb_build_object(
           'account_id', s.id,
           'name', s.name,
           'owner_name', s.owner_name,
           'is_bank', (s.name ILIKE 'tk%' OR s.bank_name IS NOT NULL),
           'current_balance', COALESCE(s.current_amount, 0),
           'period_collected', COALESCE((
              SELECT sum(ie.total_amount) FROM income_expenses ie
               WHERE ie.account_id = s.id AND ie.type='INCOME'
                 AND ie.approval_status='APPROVED' AND ie.deleted_at IS NULL
                 AND ie.handover_transfer_id IS NULL
                 AND ie.voucher_date BETWEEN p_from AND p_to), 0),
           'period_spent', COALESCE((
              SELECT sum(ie.total_amount) FROM income_expenses ie
               WHERE ie.account_id = s.id AND ie.type='EXPENSE'
                 AND ie.approval_status='APPROVED' AND ie.deleted_at IS NULL
                 AND ie.handover_transfer_id IS NULL
                 AND ie.voucher_date BETWEEN p_from AND p_to), 0),
           'period_handed_over', COALESCE((
              SELECT sum(ch.total_amount) FROM cash_handovers ch
               WHERE ch.from_account_id = s.id AND ch.status='CONFIRMED'
                 AND ch.confirmed_at::date BETWEEN p_from AND p_to), 0),
           'last_reconciliation', (
              SELECT jsonb_build_object('as_of_date', r.as_of_date, 'system_balance', r.system_balance,
                       'counted_balance', r.counted_balance, 'diff', r.diff, 'status', r.status,
                       'confirmed_at', r.confirmed_at)
                FROM cashbook_reconciliations r
               WHERE r.account_id = s.id AND r.status='CONFIRMED'
               ORDER BY r.as_of_date DESC, r.confirmed_at DESC LIMIT 1)
         ) ORDER BY (s.name ILIKE 'tk%' OR s.bank_name IS NOT NULL), s.name)
    INTO v_accounts FROM scope s;

  -- Phiên bàn giao trong kỳ mà tôi tham gia (RLS cash_handovers đã lọc; super admin thấy hết)
  SELECT jsonb_agg(jsonb_build_object(
           'code', ch.code, 'giver_name', ch.giver_name, 'receiver_name', ch.receiver_name,
           'gross', ch.gross_amount, 'expense', ch.expense_amount, 'net', ch.total_amount,
           'voucher_count', ch.voucher_count, 'status', ch.status,
           'confirmed_at', ch.confirmed_at, 'created_at', ch.created_at,
           'from_account', fa.name
         ) ORDER BY ch.confirmed_at DESC NULLS LAST, ch.created_at DESC)
    INTO v_sessions
    FROM cash_handovers ch
    LEFT JOIN accounts fa ON fa.id = ch.from_account_id
   WHERE ch.status = 'CONFIRMED'
     AND ch.confirmed_at::date BETWEEN p_from AND p_to
     AND (public.is_super_admin() OR ch.receiver_id = auth.uid() OR ch.giver_id = auth.uid());

  -- Lần chốt đối soát trong kỳ
  SELECT jsonb_agg(jsonb_build_object(
           'account_name', a.name, 'as_of_date', r.as_of_date,
           'system_balance', r.system_balance, 'counted_balance', r.counted_balance,
           'diff', r.diff, 'status', r.status, 'note', r.note, 'confirmed_at', r.confirmed_at
         ) ORDER BY r.as_of_date DESC)
    INTO v_recons
    FROM cashbook_reconciliations r
    JOIN accounts a ON a.id = r.account_id
   WHERE r.status = 'CONFIRMED'
     AND r.as_of_date BETWEEN p_from AND p_to
     AND (public.is_super_admin() OR a.user_id = auth.uid() OR public.same_team(a.user_id)
          OR r.proposed_by = auth.uid() OR r.counterparty_id = auth.uid());

  RETURN jsonb_build_object(
    'from', p_from, 'to', p_to,
    'accounts', COALESCE(v_accounts, '[]'::jsonb),
    'sessions', COALESCE(v_sessions, '[]'::jsonb),
    'reconciliations', COALESCE(v_recons, '[]'::jsonb));
END;
$function$
;
