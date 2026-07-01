-- =====================================================================
-- Đối soát/chốt số sổ quỹ (reconciliation) + RPC báo cáo bàn giao.
--
-- 1) cashbook_reconciliations: "chốt số" 1 sổ tại 1 thời điểm — chụp số dư hệ
--    thống, ghi số đếm/đối chiếu thực, lệch = đếm − hệ thống. Dùng cho sổ
--    CHUYỂN KHOẢN tkHiep (do CHỦ sở hữu, tiền đã ở sổ chủ → "chốt số" =
--    đối soát, KHÔNG dịch tiền). Có thể chốt 1 mình (chủ) hoặc 2 phía
--    (người phụ trách đề xuất → chủ xác nhận).
--
-- 2) cashbook_settlement_report(p_from, p_to): báo cáo theo TỪNG SỔ —
--    thu thực / chi thực trong kỳ (loại phiếu chuyển) · đã bàn giao cho chủ ·
--    số dư hiện tại (= còn phải nộp) + danh sách phiên + lần chốt gần nhất.
-- =====================================================================

BEGIN;

-- ── 1. Bảng đối soát ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cashbook_reconciliations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  as_of_date       date NOT NULL,
  system_balance   numeric(15,2) NOT NULL,   -- snapshot accounts_with_balance.current_amount
  counted_balance  numeric(15,2) NOT NULL,   -- số đếm/đối chiếu thực tế
  diff             numeric(15,2) NOT NULL,    -- counted − system
  status           text NOT NULL DEFAULT 'CONFIRMED'
                   CHECK (status IN ('PENDING','CONFIRMED','CANCELLED')),
  note             text,
  proposed_by      uuid NOT NULL REFERENCES auth.users(id),
  counterparty_id  uuid REFERENCES auth.users(id),   -- người cần xác nhận (NULL = chủ tự chốt)
  confirmed_by     uuid REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  confirmed_at     timestamptz,
  cancelled_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_cbk_recon_account ON public.cashbook_reconciliations(account_id);
CREATE INDEX IF NOT EXISTS idx_cbk_recon_status  ON public.cashbook_reconciliations(status) WHERE status <> 'CANCELLED';

ALTER TABLE public.cashbook_reconciliations ENABLE ROW LEVEL SECURITY;

-- SELECT: chủ sổ + người đề xuất + người đối ứng + đồng đội chủ sổ + admin
DROP POLICY IF EXISTS cbk_recon_select ON public.cashbook_reconciliations;
CREATE POLICY cbk_recon_select ON public.cashbook_reconciliations
  FOR SELECT TO authenticated
  USING (
    proposed_by = auth.uid()
    OR counterparty_id = auth.uid()
    OR public.is_admin() OR public.is_super_admin()
    OR EXISTS (SELECT 1 FROM public.accounts a
                WHERE a.id = account_id
                  AND (a.user_id = auth.uid() OR public.same_team(a.user_id)))
  );
-- Ghi CHỈ qua RPC SECURITY DEFINER.
GRANT SELECT ON public.cashbook_reconciliations TO authenticated, service_role;
REVOKE ALL ON public.cashbook_reconciliations FROM anon;

-- ── 2. RPC: đề xuất/chốt đối soát ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.propose_reconciliation(
  p_account_id      uuid,
  p_as_of           date,
  p_counted_balance numeric,
  p_counterparty_id uuid DEFAULT NULL,
  p_note            text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_owner  uuid;
  v_sys    numeric;
  v_status text;
  v_id     uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;

  SELECT user_id INTO v_owner FROM accounts WHERE id = p_account_id AND deleted_at IS NULL;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Không tìm thấy sổ quỹ'; END IF;

  -- Quyền chốt: chủ sổ / super admin / đồng đội của chủ sổ (vd Hiệp đối soát tkHiep của chủ)
  IF NOT (v_owner = auth.uid() OR public.is_super_admin() OR public.same_team(v_owner)) THEN
    RAISE EXCEPTION 'Bạn không có quyền đối soát sổ này';
  END IF;

  SELECT current_amount INTO v_sys FROM accounts_with_balance WHERE id = p_account_id;
  v_sys := COALESCE(v_sys, 0);

  -- Không counterparty → chốt luôn (1 mình); có counterparty → chờ xác nhận.
  IF p_counterparty_id IS NULL OR p_counterparty_id = auth.uid() THEN
    v_status := 'CONFIRMED';
  ELSE
    v_status := 'PENDING';
  END IF;

  INSERT INTO cashbook_reconciliations
    (account_id, as_of_date, system_balance, counted_balance, diff, status, note,
     proposed_by, counterparty_id,
     confirmed_by, confirmed_at)
  VALUES
    (p_account_id, p_as_of, v_sys, COALESCE(p_counted_balance, v_sys),
     COALESCE(p_counted_balance, v_sys) - v_sys, v_status, NULLIF(btrim(p_note), ''),
     auth.uid(), CASE WHEN p_counterparty_id = auth.uid() THEN NULL ELSE p_counterparty_id END,
     CASE WHEN v_status = 'CONFIRMED' THEN auth.uid() END,
     CASE WHEN v_status = 'CONFIRMED' THEN now() END)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'status', v_status,
                            'system_balance', v_sys,
                            'diff', COALESCE(p_counted_balance, v_sys) - v_sys);
END;
$function$;
REVOKE ALL ON FUNCTION public.propose_reconciliation(uuid,date,numeric,uuid,text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.propose_reconciliation(uuid,date,numeric,uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.confirm_reconciliation(p_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_r cashbook_reconciliations%ROWTYPE; v_owner uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_r FROM cashbook_reconciliations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy bản đối soát'; END IF;
  IF v_r.status <> 'PENDING' THEN RAISE EXCEPTION 'Bản đối soát không ở trạng thái chờ'; END IF;
  SELECT user_id INTO v_owner FROM accounts WHERE id = v_r.account_id;
  IF NOT (auth.uid() = v_r.counterparty_id OR auth.uid() = v_owner OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Chỉ người đối ứng hoặc chủ sổ mới xác nhận được';
  END IF;
  UPDATE cashbook_reconciliations
     SET status='CONFIRMED', confirmed_by=auth.uid(), confirmed_at=now()
   WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'status', 'CONFIRMED');
END;
$function$;
REVOKE ALL ON FUNCTION public.confirm_reconciliation(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.confirm_reconciliation(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_reconciliation(p_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_r cashbook_reconciliations%ROWTYPE; v_owner uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_r FROM cashbook_reconciliations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy bản đối soát'; END IF;
  IF v_r.status = 'CANCELLED' THEN RAISE EXCEPTION 'Bản đối soát đã hủy'; END IF;
  SELECT user_id INTO v_owner FROM accounts WHERE id = v_r.account_id;
  IF NOT (auth.uid() = v_r.proposed_by OR auth.uid() = v_owner OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Chỉ người tạo hoặc chủ sổ mới hủy được';
  END IF;
  UPDATE cashbook_reconciliations SET status='CANCELLED', cancelled_at=now() WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'status', 'CANCELLED');
END;
$function$;
REVOKE ALL ON FUNCTION public.cancel_reconciliation(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cancel_reconciliation(uuid) TO authenticated;

-- ── 3. RPC báo cáo bàn giao theo sổ ──────────────────────────────────
-- Phạm vi sổ: super admin → mọi sổ; còn lại → sổ của mình HOẶC của đồng đội.
-- Chỉ sổ thu/ngân hàng (tên kết thúc "Thu" / bắt đầu "TK" / có bank_name /
-- có phát sinh bàn giao) — bỏ sổ audit (Thối, Chung, Làm tròn, Cấn trừ, CỌC).
CREATE OR REPLACE FUNCTION public.cashbook_settlement_report(
  p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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
$function$;
REVOKE ALL ON FUNCTION public.cashbook_settlement_report(date,date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cashbook_settlement_report(date,date) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
