-- Số dư tạm ứng đầu kỳ là số đã đối chiếu ngoài sổ, không sinh phiếu tiền.
-- Phân phối quỹ làm tăng quyền lợi bằng số được chia. Phần đã cấn làm giảm tạm ứng,
-- phần còn phải trả đi vào tháng phân phối để chi bằng W2, qua quy trình duyệt/ghi sổ hiện hành.
BEGIN;

CREATE TABLE IF NOT EXISTS app_private.shareholder_profit_openings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  shareholder_id uuid NOT NULL,
  through_month date NOT NULL CHECK (isfinite(through_month) AND extract(day FROM through_month) = 1),
  as_of_date date NOT NULL CHECK (isfinite(as_of_date) AND as_of_date >= (through_month + interval '1 month - 1 day')::date),
  advance_amount numeric(13,0) NOT NULL CHECK (advance_amount >= 0 AND advance_amount <> 'NaN'::numeric),
  evidence text NOT NULL CHECK (length(btrim(evidence)) BETWEEN 8 AND 1000),
  request_key text NOT NULL,
  expected_unpaid numeric NOT NULL,
  reconciled_approved numeric NOT NULL CHECK (reconciled_approved >= 0),
  reconciled_vouchers jsonb NOT NULL CHECK (jsonb_typeof(reconciled_vouchers) = 'array'),
  marker_id uuid NOT NULL UNIQUE REFERENCES app_private.profit_ledger_markers(id),
  ledger_seq bigint NOT NULL UNIQUE DEFAULT nextval('app_private.profit_ledger_seq'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL,
  UNIQUE (organization_id, shareholder_id),
  UNIQUE (organization_id, created_by, request_key),
  FOREIGN KEY (shareholder_id, organization_id) REFERENCES public.shareholders(id, organization_id)
);
ALTER TABLE app_private.shareholder_profit_openings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.shareholder_profit_openings FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS shareholder_profit_opening_immutable ON app_private.shareholder_profit_openings;
CREATE TRIGGER shareholder_profit_opening_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.shareholder_profit_openings
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_profit_ledger_append_only_v1();

-- Phiếu đã được thay thế bằng số dư đầu kỳ phải giữ nguyên căn cứ đã đối soát.
-- E6 và lệnh đảo đều cập nhật phiếu gốc trong cùng giao dịch với các bút toán đảo.
CREATE OR REPLACE FUNCTION app_private.guard_shareholder_opening_voucher_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.organization_id, NEW.shareholder_id, NEW.type, NEW.voucher_date,
      NEW.total_amount, NEW.approval_status, NEW.posting_status, NEW.deleted_at, NEW.active_posting_id_v2,
      NEW.reversed_by_posting_id, NEW.posting_mode) IS NOT DISTINCT FROM ROW(OLD.organization_id,
      OLD.shareholder_id, OLD.type, OLD.voucher_date, OLD.total_amount, OLD.approval_status, OLD.posting_status,
      OLD.deleted_at, OLD.active_posting_id_v2, OLD.reversed_by_posting_id, OLD.posting_mode) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM app_private.shareholder_profit_openings o
             WHERE o.organization_id = OLD.organization_id AND o.shareholder_id = OLD.shareholder_id
               AND o.reconciled_vouchers @> jsonb_build_array(jsonb_build_object('voucher_id', OLD.id))) THEN
    RAISE EXCEPTION 'SHARED_FUND_OPENING_VOUCHER_LOCKED: phiếu đã dùng làm căn cứ chuyển số dư ứng đầu kỳ'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.guard_shareholder_opening_voucher_v1() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS a01_shareholder_opening_voucher ON public.income_expenses;
CREATE TRIGGER a01_shareholder_opening_voucher
  BEFORE UPDATE OF organization_id, shareholder_id, type, voucher_date, total_amount, approval_status, posting_status,
    deleted_at, active_posting_id_v2, reversed_by_posting_id, posting_mode OR DELETE ON public.income_expenses
  FOR EACH ROW WHEN (OLD.shareholder_id IS NOT NULL) EXECUTE FUNCTION app_private.guard_shareholder_opening_voucher_v1();

-- Các dòng quỹ có thứ tự sổ như phiếu/mốc; tháng dòng phân phối là tháng được hưởng, độc lập với kỳ hình thành quỹ.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_shared_fund_components_v1(
  p_org uuid, p_shareholder uuid, p_through_month date
) RETURNS TABLE (kind text, entry_id uuid, period_month date, ledger_seq bigint, created_at timestamptz,
                 distributed numeric, advance_offset numeric, opening_advance numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT 'SHARED_FUND'::text, l.id, d.period_month, l.ledger_seq, d.created_at,
         l.amount, l.advance_offset_amount, 0::numeric
    FROM app_private.shared_fund_distribution_lines l
    JOIN app_private.shared_fund_distributions d ON d.id = l.distribution_id AND d.organization_id = l.organization_id
   WHERE l.organization_id = p_org AND l.shareholder_id = p_shareholder AND d.status = 'POSTED'
     AND (p_through_month IS NULL OR d.period_month <= p_through_month)
  UNION ALL
  SELECT 'OPENING_ADVANCE'::text, o.id, o.through_month, o.ledger_seq, o.created_at,
         0::numeric, 0::numeric, o.advance_amount
    FROM app_private.shareholder_profit_openings o
   WHERE o.organization_id = p_org AND o.shareholder_id = p_shareholder
     AND (p_through_month IS NULL OR o.through_month <= p_through_month)
$fn$;
REVOKE ALL ON FUNCTION app_private.profit_ledger_shared_fund_components_v1(uuid,uuid,date) FROM PUBLIC, anon, authenticated, service_role;

-- Sau mở sổ, hạ hoặc gỡ mốc dưới kỳ đã đối chiếu sẽ phục hồi lợi nhuận cũ lần hai.
-- Khi mốc đặt sau một phân phối, nó phải bao phủ tháng hưởng của phân phối đó.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_check_shared_fund_marker_v1(p_org uuid, p_shareholder uuid, p_month date)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_cutoff date;
BEGIN
  SELECT o.through_month INTO v_cutoff FROM app_private.shareholder_profit_openings o
   WHERE o.organization_id = p_org AND o.shareholder_id = p_shareholder;
  IF v_cutoff IS NOT NULL AND (p_month IS NULL OR p_month < v_cutoff) THEN
    RAISE EXCEPTION 'SHARED_FUND_OPENING_CUTOFF: cần giữ mốc từ tháng đã đối chiếu đầu kỳ % trở đi', to_char(v_cutoff, 'MM/YYYY')
      USING ERRCODE = '22023';
  END IF;
  IF p_month IS NOT NULL AND EXISTS (
    SELECT 1 FROM app_private.profit_ledger_shared_fund_components_v1(p_org, p_shareholder, NULL) f
     WHERE f.kind = 'SHARED_FUND' AND f.period_month > p_month
  ) THEN
    RAISE EXCEPTION 'SHARED_FUND_MARKER_BEFORE_DISTRIBUTION: mốc phải từ tháng đã phân phối quỹ trở đi' USING ERRCODE = '22023';
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.profit_ledger_check_shared_fund_marker_v1(uuid,uuid,date) FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION app_private.guard_shared_fund_profit_marker_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF NEW.subject_kind = 'SHAREHOLDER' THEN
    PERFORM app_private.profit_ledger_check_shared_fund_marker_v1(NEW.organization_id, NEW.shareholder_id, NEW.settled_through_month);
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.guard_shared_fund_profit_marker_v1() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS a11_shared_fund_marker_guard ON app_private.profit_ledger_markers;
CREATE TRIGGER a11_shared_fund_marker_guard BEFORE INSERT ON app_private.profit_ledger_markers
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_shared_fund_profit_marker_v1();

CREATE OR REPLACE FUNCTION app_private.profit_ledger_balance_core_v1(
  p_org uuid,
  p_kind text,
  p_subject uuid,
  p_marker_month date,
  p_marker_seq bigint,
  p_marker_created_at timestamptz,
  p_exclude_voucher uuid DEFAULT NULL,
  p_exclude_salary_period date DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_has_marker   boolean := p_marker_month IS NOT NULL;
  v_shareholder  uuid;
  v_manager      uuid;
  v_alloc        numeric := 0;
  v_ex_alloc     numeric := 0;
  v_pay_approved numeric := 0;
  v_pay_pending  numeric := 0;
  v_ex_pay       numeric := 0;
  v_sal_invest   numeric := 0;
  v_sal_offset   numeric := 0;
  v_ex_sal       numeric := 0;
  v_fund_amount  numeric := 0;
  v_fund_offset  numeric := 0;
  v_opening      numeric := 0;
  v_nr_count     bigint := 0;
  v_nr_suggested numeric := 0;
BEGIN
  IF p_org IS NULL OR p_subject IS NULL OR p_kind IS NULL OR p_kind NOT IN ('SHAREHOLDER', 'MANAGER') THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_SUBJECT: thiếu công ty/chủ thể hoặc loại chủ thể không hợp lệ'
      USING ERRCODE = '22023';
  END IF;
  IF p_exclude_salary_period IS NOT NULL AND EXTRACT(DAY FROM p_exclude_salary_period) <> 1 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_PERIOD: kỳ lương loại trừ phải là ngày đầu tháng' USING ERRCODE = '22023';
  END IF;
  -- Có tháng mốc thì phải có đủ thứ tự sổ và giờ: thiếu một trong hai thì phép so trả NULL và
  -- phiếu biến mất khỏi cả phần tính lẫn phần bị loại — số dư sai mà không báo.
  IF v_has_marker AND (EXTRACT(DAY FROM p_marker_month) IS DISTINCT FROM 1 OR p_marker_seq IS NULL OR p_marker_created_at IS NULL) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_BAD_MARKER: mốc phải là ngày đầu tháng và có đủ ledger_seq, created_at'
      USING ERRCODE = '22023';
  END IF;

  -- Chủ thể phải thuộc đúng công ty: cặp (công ty, chủ thể) lệch nhau không được trả "số dư 0".
  IF p_kind = 'SHAREHOLDER' THEN
    PERFORM 1 FROM public.shareholders s WHERE s.id = p_subject AND s.organization_id = p_org;
    v_shareholder := p_subject;
  ELSE
    PERFORM 1 FROM public.profit_managers m WHERE m.id = p_subject AND m.organization_id = p_org;
    v_manager := p_subject;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SUBJECT_NOT_FOUND: chủ thể không thuộc công ty này' USING ERRCODE = 'P0002';
  END IF;

  -- 1) Phân bổ của các tháng ĐÃ CHỐT. Lọc công ty bằng profit_monthly.organization_id
  --    (cột organization_id của hai bảng phân bổ cho phép NULL).
  IF p_kind = 'SHAREHOLDER' THEN
    SELECT COALESCE(sum(a.amount) FILTER (WHERE NOT v_has_marker OR pm.period_month > p_marker_month), 0),
           COALESCE(sum(a.amount) FILTER (WHERE v_has_marker AND pm.period_month <= p_marker_month), 0)
      INTO v_alloc, v_ex_alloc
      FROM public.profit_allocations a
      JOIN public.profit_monthly pm ON pm.id = a.profit_monthly_id
     WHERE a.shareholder_id = v_shareholder
       AND pm.organization_id = p_org
       AND pm.status = 'LOCKED';
  ELSE
    SELECT COALESCE(sum(a.amount) FILTER (WHERE NOT v_has_marker OR pm.period_month > p_marker_month), 0),
           COALESCE(sum(a.amount) FILTER (WHERE v_has_marker AND pm.period_month <= p_marker_month), 0)
      INTO v_alloc, v_ex_alloc
      FROM public.profit_manager_allocations a
      JOIN public.profit_monthly pm ON pm.id = a.profit_monthly_id
     WHERE a.manager_id = v_manager
       AND pm.organization_id = p_org
       AND pm.status = 'LOCKED';
  END IF;

  -- 2) Phiếu chi còn sống của chủ thể. Có mốc: chỉ tính phiếu vào sổ SAU mốc
  --    (so ledger_seq; phiếu cũ không có dòng profit_ledger_payouts thì so giờ tạo).
  SELECT COALESCE(sum(x.total_amount) FILTER (WHERE x.counted AND x.approval_status = 'APPROVED'), 0),
         COALESCE(sum(x.total_amount) FILTER (WHERE x.counted AND x.approval_status <> 'APPROVED'), 0),
         COALESCE(sum(x.total_amount) FILTER (WHERE NOT x.counted), 0)
    INTO v_pay_approved, v_pay_pending, v_ex_pay
    FROM (
      SELECT ie.total_amount, ie.approval_status,
             (NOT v_has_marker
              OR (c2.voucher_id IS NOT NULL AND c2.ledger_seq > p_marker_seq)
              OR (c2.voucher_id IS NULL AND ie.created_at >= p_marker_created_at)) AS counted
        FROM public.income_expenses ie
        LEFT JOIN app_private.profit_ledger_payouts c2 ON c2.voucher_id = ie.id
       WHERE ie.organization_id = p_org
         AND (ie.shareholder_id = v_shareholder OR ie.profit_manager_id = v_manager)
         AND ie.id IS DISTINCT FROM p_exclude_voucher
         AND app_private.profit_ledger_voucher_live_v1(ie.id)
    ) x;

  -- 3) Phần lợi nhuận đã trả qua lương (chỉ cổ đông).
  IF p_kind = 'SHAREHOLDER' THEN
    SELECT COALESCE(sum(x.investment_amount) FILTER (WHERE x.counted), 0),
           COALESCE(sum(x.advance_offset_amount) FILTER (WHERE x.counted), 0),
           COALESCE(sum(x.investment_amount - x.advance_offset_amount) FILTER (WHERE NOT x.counted), 0)
      INTO v_sal_invest, v_sal_offset, v_ex_sal
      FROM (
        SELECT l.investment_amount, l.advance_offset_amount,
               (NOT v_has_marker OR l.period_month > p_marker_month) AS counted
          FROM app_private.profit_ledger_salary_settlement_vouchers l
         WHERE l.organization_id = p_org
           AND l.shareholder_id = v_shareholder
           AND l.state = 'LINKED'
           AND l.period_month IS DISTINCT FROM p_exclude_salary_period
           AND app_private.profit_ledger_voucher_live_v1(l.salary_voucher_id)
      ) x;

    -- Dòng quỹ và số dư chuyển sang là chuyển quyền hưởng tiền, không phải giao dịch sổ quỹ.
    SELECT COALESCE(sum(f.distributed), 0), COALESCE(sum(f.advance_offset), 0), COALESCE(sum(f.opening_advance), 0)
      INTO v_fund_amount, v_fund_offset, v_opening
      FROM app_private.profit_ledger_shared_fund_components_v1(p_org, p_subject, NULL) f
     WHERE NOT v_has_marker OR f.ledger_seq > p_marker_seq;

    -- Phiếu lương máy chưa đủ dữ kiện: không trừ vào số dư, chỉ báo ra (mọi kỳ, không xét mốc).
    SELECT count(*), COALESCE(sum(l.suggested_investment), 0)
      INTO v_nr_count, v_nr_suggested
      FROM app_private.profit_ledger_salary_settlement_vouchers l
     WHERE l.organization_id = p_org
       AND l.shareholder_id = v_shareholder
       AND l.state = 'NEEDS_REVIEW'
       AND app_private.profit_ledger_voucher_live_v1(l.salary_voucher_id);
  END IF;

  RETURN jsonb_build_object(
    'allocated', v_alloc,
    'payouts_approved', v_pay_approved,
    'payouts_pending', v_pay_pending,
    'salary_investment', v_sal_invest,
    'salary_advance_offset', v_sal_offset,
    'shared_fund_distributed', v_fund_amount,
    'shared_fund_offset', v_fund_offset,
    'opening_advance', v_opening,
    'balance', v_alloc - v_pay_approved - v_pay_pending - (v_sal_invest - v_sal_offset) + v_fund_amount - v_opening,
    -- Mốc ĐÃ ÁP cho phép tính này (id luôn null: lõi không biết dòng mốc nào). balance_v1 thay bằng dòng mốc hiệu lực.
    'marker', CASE WHEN v_has_marker THEN jsonb_build_object(
                'id', NULL::uuid,
                'settled_through_month', p_marker_month,
                'ledger_seq', p_marker_seq,
                'created_at', p_marker_created_at) END,
    'excluded_before_marker', jsonb_build_object('allocated', v_ex_alloc, 'payouts', v_ex_pay, 'salary', v_ex_sal),
    'needs_review', jsonb_build_object('count', v_nr_count, 'suggested', v_nr_suggested));
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.profit_ledger_position_v1(p_org uuid, p_shareholder uuid)
RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_bal          jsonb;
  v_marker_month date;
  v_marker_seq   bigint;
  v_alloc        numeric;
  v_sal_invest   numeric;
  v_sal_offset   numeric;
  v_pay_approved numeric;
  v_pay_pending  numeric;
  v_balance      numeric;
  v_fund_offset  numeric;
  v_fund_payable numeric;
  v_opening      numeric;
  v_sx           numeric;
  v_sk           numeric;
  v_cash_ok      numeric;
  v_cash_wait    numeric;
  v_last         date;
  v_unpaid       numeric;
  v_adv          numeric;
  v_adv_pending  numeric;
  v_fold         numeric;
BEGIN
  v_bal := app_private.profit_ledger_balance_v1(p_org, 'SHAREHOLDER', p_shareholder);
  -- "Có mốc" = dòng mốc hiệu lực có tháng. Dòng gỡ mốc (tháng null) ⇒ như chưa có mốc: không lọc gì, như lõi số dư.
  v_marker_month := (v_bal -> 'marker' ->> 'settled_through_month')::date;
  IF v_marker_month IS NOT NULL THEN
    v_marker_seq := (v_bal -> 'marker' ->> 'ledger_seq')::bigint;
  END IF;
  v_alloc        := (v_bal ->> 'allocated')::numeric;
  v_sal_invest   := (v_bal ->> 'salary_investment')::numeric;
  v_sal_offset   := (v_bal ->> 'salary_advance_offset')::numeric;
  v_pay_approved := (v_bal ->> 'payouts_approved')::numeric;
  v_pay_pending  := (v_bal ->> 'payouts_pending')::numeric;
  v_balance      := (v_bal ->> 'balance')::numeric;

  SELECT COALESCE(sum(s.recognized_amount), 0),
         COALESCE(sum(s.advance_offset_amount), 0),
         COALESCE(sum(s.cash_amount) FILTER (WHERE s.cash_voucher_id IS NOT NULL AND ie.approval_status = 'APPROVED'), 0),
         COALESCE(sum(s.cash_amount) FILTER (WHERE s.cash_voucher_id IS NOT NULL AND ie.approval_status IS DISTINCT FROM 'APPROVED'), 0),
         max(s.through_month)
    INTO v_sx, v_sk, v_cash_ok, v_cash_wait, v_last
    FROM app_private.profit_ledger_payout_settlements s
    LEFT JOIN public.income_expenses ie ON ie.id = s.cash_voucher_id
   WHERE s.organization_id = p_org
     AND s.shareholder_id = p_shareholder
     AND app_private.profit_ledger_settlement_live_v1(s.id)
     AND (v_marker_seq IS NULL OR s.ledger_seq > v_marker_seq);

  v_fund_offset  := (v_bal ->> 'shared_fund_offset')::numeric;
  v_fund_payable := (v_bal ->> 'shared_fund_distributed')::numeric - v_fund_offset;
  v_opening      := (v_bal ->> 'opening_advance')::numeric;
  v_unpaid       := v_alloc - v_sal_invest - v_sx + v_fund_payable;
  v_adv          := (v_pay_approved - v_cash_ok) - v_sal_offset - v_sk + v_opening - v_fund_offset;
  v_adv_pending := v_pay_pending - v_cash_wait;

  IF (v_unpaid - v_adv - v_adv_pending) IS DISTINCT FROM v_balance
     OR v_cash_ok > v_pay_approved
     OR v_cash_wait > v_pay_pending THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_POSITION_DRIFT: lợi nhuận chưa chi và tạm ứng không cộng ra đúng số dư sổ tổng — báo bộ phận kỹ thuật'
      USING ERRCODE = 'XX000',
            DETAIL = jsonb_build_object(
              'balance', v_balance, 'unpaid_profit', v_unpaid, 'advance_outstanding', v_adv,
              'advance_pending', v_adv_pending, 'payouts_approved', v_pay_approved, 'payouts_pending', v_pay_pending,
              'cash_approved', v_cash_ok, 'cash_pending', v_cash_wait, 'recognized', v_sx, 'offset', v_sk)::text;
  END IF;

  -- Tạm ứng không bao giờ âm: phần âm là lợi nhuận công ty còn nợ, gấp vào "lợi nhuận chưa chi" (một chiều).
  v_fold := GREATEST(-v_adv, 0);

  RETURN jsonb_build_object(
    'unpaid_profit', v_unpaid + v_fold,
    'advance_outstanding', v_adv + v_fold,
    'advance_pending', v_adv_pending,
    'settlement_cash_pending', v_cash_wait,
    'settled', jsonb_build_object('recognized', v_sx, 'offset', v_sk, 'cash', v_cash_ok + v_cash_wait),
    'last_settled_through_month', v_last,
    'balance', v_balance,
    'marker_month', v_marker_month,
    'needs_review', v_bal -> 'needs_review',
    -- Các phần của số dư ròng mà hai con số trên dựng từ đó (cùng một lần đọc), hai số thô và phần đã gấp (chẩn đoán).
    'components', jsonb_build_object(
      'shared_fund_payable', v_fund_payable, 'shared_fund_offset', v_fund_offset,
      'opening_advance', v_opening, 'marker_seq', v_marker_seq,
      'allocated', v_alloc, 'salary_investment', v_sal_invest, 'salary_advance_offset', v_sal_offset,
      'payouts_approved', v_pay_approved, 'payouts_pending', v_pay_pending,
      'unpaid_profit_raw', v_unpaid, 'advance_outstanding_raw', v_adv, 'advance_overoffset', v_fold));
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.profit_ledger_unpaid_through_v1(p_org uuid, p_shareholder uuid, p_through_month date)
RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_pos    jsonb;
  v_marker date;
  v_after  jsonb;
  v_payable numeric;
  v_offset_through numeric;
  v_advance_without_fund numeric;
  v_marker_seq bigint;
BEGIN
  IF p_through_month IS NULL OR NOT isfinite(p_through_month) OR EXTRACT(DAY FROM p_through_month) <> 1 THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SETTLE_MONTH: tháng chốt phải là ngày đầu tháng' USING ERRCODE = '22023';
  END IF;
  v_pos := app_private.profit_ledger_position_v1(p_org, p_shareholder);
  v_marker := (v_pos ->> 'marker_month')::date;
  IF v_marker IS NOT NULL AND p_through_month <= v_marker THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_SETTLE_MONTH: tháng chốt phải sau tháng của mốc "đã trả đủ"'
      USING ERRCODE = '22023',
            DETAIL = jsonb_build_object('through_month', p_through_month, 'marker_month', v_marker)::text;
  END IF;
  v_after := app_private.profit_ledger_balance_core_v1(p_org, 'SHAREHOLDER', p_shareholder,
               p_through_month, 9223372036854775807, 'infinity');
  v_marker_seq := (v_pos -> 'components' ->> 'marker_seq')::bigint;
  SELECT COALESCE(sum(f.distributed - f.advance_offset), 0), COALESCE(sum(f.advance_offset), 0)
    INTO v_payable, v_offset_through
    FROM app_private.profit_ledger_shared_fund_components_v1(p_org, p_shareholder, p_through_month) f
   WHERE v_marker_seq IS NULL OR f.ledger_seq > v_marker_seq;
  -- Nếu một phiếu ứng sau đó bị hủy, phần đã cấn vượt số ứng trở lại phải trả.
  -- Chỉ các khoản cấn đã tới tháng mới được tính, để không hiện quyền lợi đó ở tháng sớm hơn.
  v_advance_without_fund := (v_pos -> 'components' ->> 'advance_outstanding_raw')::numeric
                          + (v_pos -> 'components' ->> 'shared_fund_offset')::numeric;
  RETURN v_payable + ((v_pos -> 'components' ->> 'allocated')::numeric - (v_after ->> 'allocated')::numeric)
       - ((v_pos -> 'components' ->> 'salary_investment')::numeric - (v_after ->> 'salary_investment')::numeric)
       - (v_pos -> 'settled' ->> 'recognized')::numeric
       + greatest(v_offset_through - v_advance_without_fund, 0);
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.profit_ledger_chot_months_v1(p_org uuid, p_shareholder uuid)
RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_pos      jsonb;
  v_marker   date;
  v_last     date;
  v_rows     jsonb := '[]'::jsonb;
  v_sum      numeric := 0;
  v_x        numeric;
  v_eligible boolean;
  v_min      date;
  v_max      date;
  v_min_sel  date;
  v_max_sel  date;
  r          record;
BEGIN
  v_pos := app_private.profit_ledger_position_v1(p_org, p_shareholder);
  v_marker := (v_pos ->> 'marker_month')::date;
  v_last := (v_pos ->> 'last_settled_through_month')::date;

  FOR r IN
    SELECT x.thang, sum(x.amount) AS phan_bo
      FROM (
        SELECT pm.period_month AS thang, a.amount
          FROM public.profit_allocations a
          JOIN public.profit_monthly pm ON pm.id = a.profit_monthly_id
         WHERE a.shareholder_id = p_shareholder AND pm.organization_id = p_org
           AND pm.status = 'LOCKED' AND (v_marker IS NULL OR pm.period_month > v_marker)
        UNION ALL
        SELECT f.period_month, f.distributed - f.advance_offset
          FROM app_private.profit_ledger_shared_fund_components_v1(p_org, p_shareholder, NULL) f
         WHERE f.kind = 'SHARED_FUND' AND (f.distributed > f.advance_offset
               OR (v_pos -> 'components' ->> 'advance_overoffset')::numeric > 0)
           AND (v_marker IS NULL OR f.ledger_seq > (v_pos -> 'components' ->> 'marker_seq')::bigint)
      ) x
     GROUP BY x.thang ORDER BY x.thang
  LOOP
    v_sum := v_sum + r.phan_bo;
    v_x := app_private.profit_ledger_unpaid_through_v1(p_org, p_shareholder, r.thang);
    v_eligible := v_last IS NULL OR r.thang >= v_last;
    v_rows := v_rows || jsonb_build_object(
      'month', r.thang, 'allocated', r.phan_bo, 'unpaid_through', v_x,
      'eligible', v_eligible, 'selectable', v_eligible AND v_x > 0);
    IF v_eligible THEN
      v_min := COALESCE(v_min, r.thang);
      v_max := r.thang;
      IF v_x > 0 THEN
        v_min_sel := COALESCE(v_min_sel, r.thang);
        v_max_sel := r.thang;
      END IF;
    END IF;
  END LOOP;

  IF v_sum IS DISTINCT FROM ((v_pos -> 'components' ->> 'allocated')::numeric
                             + (v_pos -> 'components' ->> 'shared_fund_payable')::numeric) THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_POSITION_DRIFT: các tháng liệt kê không cộng ra đúng phần phân bổ của sổ tổng — báo bộ phận kỹ thuật'
      USING ERRCODE = 'XX000',
            DETAIL = jsonb_build_object('listed', v_sum, 'allocated', v_pos -> 'components' -> 'allocated')::text;
  END IF;

  RETURN jsonb_build_object(
    'months', v_rows,
    'min_eligible', v_min, 'max_eligible', v_max,
    'min_selectable', v_min_sel, 'max_selectable', v_max_sel,
    'position', v_pos);
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.profit_ledger_doc_shareholder_v1(p_org uuid, p_shareholder uuid)
RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_uid        uuid := auth.uid();
  v_bal        jsonb;
  v_mk         record;
  v_has_marker boolean := false;
  v_mk_month   date;
  v_mk_seq     bigint;
  v_mk_at      timestamptz;
  v_t          record;
BEGIN
  -- Số dư theo công thức duy nhất của sổ (chủ thể không thuộc công ty ⇒ hàm lõi ném P0002).
  v_bal := app_private.profit_ledger_balance_v1(p_org, 'SHAREHOLDER', p_shareholder);

  SELECT mk.settled_through_month, mk.ledger_seq, mk.created_at INTO v_mk
    FROM app_private.profit_ledger_active_marker_v1(p_org, 'SHAREHOLDER', p_shareholder) mk;
  IF FOUND AND v_mk.settled_through_month IS NOT NULL THEN
    v_has_marker := true;
    v_mk_month := v_mk.settled_through_month;
    v_mk_seq := v_mk.ledger_seq;
    v_mk_at := v_mk.created_at;
  END IF;

  WITH e AS (
    SELECT 'ALLOCATION'::text AS kind, 1 AS kind_order, a.id AS line_id, pm.period_month,
           pm.building_id, b.name AS building_name, a.amount::numeric AS amount, NULL::numeric AS suggested,
           NULL::uuid AS voucher_id, NULL::text AS voucher_code, NULL::date AS voucher_date,
           NULL::text AS voucher_status, NULL::text AS posting_status, NULL::text AS account_name,
           NULL::uuid AS maker_user_id, false AS is_advance,
           COALESCE(pm.locked_at, a.created_at) AS at,
           (v_has_marker AND pm.period_month <= v_mk_month) AS excluded,
           a.id AS ord_id
      FROM public.profit_allocations a
      JOIN public.profit_monthly pm ON pm.id = a.profit_monthly_id
      LEFT JOIN public.buildings b ON b.id = pm.building_id
     WHERE a.shareholder_id = p_shareholder
       AND pm.organization_id = p_org
       AND pm.status = 'LOCKED'
    UNION ALL
    SELECT 'PAYOUT', 2, NULL, NULL,
           ie.building_id, b.name, -ie.total_amount, NULL,
           ie.id, ie.code, ie.voucher_date,
           ie.approval_status, ie.posting_status, acc.name,
           c2.maker_user_id, COALESCE(c2.advance_amount > 0, false),
           COALESCE(c2.created_at, ie.created_at),
           (v_has_marker AND NOT ((c2.voucher_id IS NOT NULL AND c2.ledger_seq > v_mk_seq)
                                  OR (c2.voucher_id IS NULL AND ie.created_at >= v_mk_at))),
           ie.id
      FROM public.income_expenses ie
      LEFT JOIN app_private.profit_ledger_payouts c2 ON c2.voucher_id = ie.id
      LEFT JOIN public.buildings b ON b.id = ie.building_id
      LEFT JOIN public.accounts acc ON acc.id = ie.account_id
     WHERE ie.organization_id = p_org
       AND ie.shareholder_id = p_shareholder
       AND app_private.profit_ledger_voucher_live_v1(ie.id)
    UNION ALL
    SELECT 'SALARY', 3, l.id, l.period_month,
           NULL, NULL, -l.investment_amount, NULL,
           l.salary_voucher_id, sv.code, sv.voucher_date,
           sv.approval_status, NULL, NULL,
           NULL, false,
           COALESCE(l.linked_at, l.created_at),
           (v_has_marker AND l.period_month <= v_mk_month),
           l.id
      FROM app_private.profit_ledger_salary_settlement_vouchers l
      LEFT JOIN public.income_expenses sv ON sv.id = l.salary_voucher_id
     WHERE l.organization_id = p_org
       AND l.shareholder_id = p_shareholder
       AND l.state = 'LINKED'
       AND app_private.profit_ledger_voucher_live_v1(l.salary_voucher_id)
    UNION ALL
    SELECT 'SALARY_OFFSET', 4, l.id, l.period_month,
           NULL, NULL, l.advance_offset_amount, NULL,
           l.salary_voucher_id, sv.code, sv.voucher_date,
           sv.approval_status, NULL, NULL,
           NULL, false,
           COALESCE(l.linked_at, l.created_at),
           (v_has_marker AND l.period_month <= v_mk_month),
           l.id
      FROM app_private.profit_ledger_salary_settlement_vouchers l
      LEFT JOIN public.income_expenses sv ON sv.id = l.salary_voucher_id
     WHERE l.organization_id = p_org
       AND l.shareholder_id = p_shareholder
       AND l.state = 'LINKED'
       AND l.advance_offset_amount <> 0
       AND app_private.profit_ledger_voucher_live_v1(l.salary_voucher_id)
    UNION ALL
    -- Phiếu lương máy chưa đủ dữ kiện: không vào số dư (0), mọi kỳ, không xét mốc — như needs_review của số dư.
    SELECT 'SALARY_REVIEW', 5, l.id, l.period_month,
           NULL, NULL, 0::numeric, l.suggested_investment,
           l.salary_voucher_id, sv.code, sv.voucher_date,
           sv.approval_status, NULL, NULL,
           NULL, false,
           l.created_at,
           false,
           l.id
      FROM app_private.profit_ledger_salary_settlement_vouchers l
      LEFT JOIN public.income_expenses sv ON sv.id = l.salary_voucher_id
     WHERE l.organization_id = p_org
       AND l.shareholder_id = p_shareholder
       AND l.state = 'NEEDS_REVIEW'
       AND app_private.profit_ledger_voucher_live_v1(l.salary_voucher_id)
    UNION ALL
    SELECT f.kind, 6, f.entry_id, f.period_month,
           NULL, NULL, f.distributed - f.opening_advance, NULL,
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, f.created_at,
           v_has_marker AND f.ledger_seq <= v_mk_seq, f.entry_id
      FROM app_private.profit_ledger_shared_fund_components_v1(p_org, p_shareholder, NULL) f
  ), x AS (
    SELECT e.*,
           sum(CASE WHEN e.excluded THEN 0 ELSE e.amount END)
             OVER (ORDER BY e.at, e.kind_order, e.period_month, e.building_name, e.ord_id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance
      FROM e
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'kind', x.kind,
           'line_id', x.line_id,
           'period_month', x.period_month,
           'building_id', x.building_id,
           'building_name', x.building_name,
           'amount', x.amount,
           'suggested', x.suggested,
           'voucher_id', x.voucher_id,
           'voucher_code', x.voucher_code,
           'voucher_date', x.voucher_date,
           'voucher_status', x.voucher_status,
           'posting_status', x.posting_status,
           'account_name', x.account_name,
           'maker_user_id', x.maker_user_id,
           'is_mine', COALESCE(x.maker_user_id = v_uid, false),
           'is_advance', x.is_advance,
           'created_at', x.at,
           'excluded_by_marker', x.excluded,
           'running_balance', x.running_balance)
           ORDER BY x.at, x.kind_order, x.period_month, x.building_name, x.ord_id), '[]'::jsonb) AS entries,
         COALESCE(sum(x.amount) FILTER (WHERE x.kind = 'ALLOCATION' AND NOT x.excluded), 0) AS alloc_in,
         COALESCE(sum(x.amount) FILTER (WHERE x.kind = 'ALLOCATION' AND x.excluded), 0) AS alloc_ex,
         COALESCE(sum(-x.amount) FILTER (WHERE x.kind = 'PAYOUT' AND NOT x.excluded AND x.voucher_status = 'APPROVED'), 0) AS pay_ok,
         COALESCE(sum(-x.amount) FILTER (WHERE x.kind = 'PAYOUT' AND NOT x.excluded AND x.voucher_status IS DISTINCT FROM 'APPROVED'), 0) AS pay_pend,
         COALESCE(sum(-x.amount) FILTER (WHERE x.kind = 'PAYOUT' AND x.excluded), 0) AS pay_ex,
         COALESCE(sum(-x.amount) FILTER (WHERE x.kind = 'SALARY' AND NOT x.excluded), 0) AS sal_inv,
         COALESCE(sum(x.amount) FILTER (WHERE x.kind = 'SALARY_OFFSET' AND NOT x.excluded), 0) AS sal_off,
         COALESCE(sum(-x.amount) FILTER (WHERE x.kind IN ('SALARY', 'SALARY_OFFSET') AND x.excluded), 0) AS sal_ex,
         count(*) FILTER (WHERE x.kind = 'SALARY_REVIEW') AS nr_count,
         COALESCE(sum(x.suggested) FILTER (WHERE x.kind = 'SALARY_REVIEW'), 0) AS nr_sugg,
         COALESCE(sum(x.amount) FILTER (WHERE NOT x.excluded), 0) AS total_in
    INTO v_t
    FROM x;

  IF v_t.alloc_in IS DISTINCT FROM (v_bal ->> 'allocated')::numeric
     OR v_t.alloc_ex IS DISTINCT FROM (v_bal -> 'excluded_before_marker' ->> 'allocated')::numeric
     OR v_t.pay_ok IS DISTINCT FROM (v_bal ->> 'payouts_approved')::numeric
     OR v_t.pay_pend IS DISTINCT FROM (v_bal ->> 'payouts_pending')::numeric
     OR v_t.pay_ex IS DISTINCT FROM (v_bal -> 'excluded_before_marker' ->> 'payouts')::numeric
     OR v_t.sal_inv IS DISTINCT FROM (v_bal ->> 'salary_investment')::numeric
     OR v_t.sal_off IS DISTINCT FROM (v_bal ->> 'salary_advance_offset')::numeric
     OR v_t.sal_ex IS DISTINCT FROM (v_bal -> 'excluded_before_marker' ->> 'salary')::numeric
     OR v_t.nr_count IS DISTINCT FROM (v_bal -> 'needs_review' ->> 'count')::bigint
     OR v_t.nr_sugg IS DISTINCT FROM (v_bal -> 'needs_review' ->> 'suggested')::numeric
     OR v_t.total_in IS DISTINCT FROM (v_bal ->> 'balance')::numeric THEN
    RAISE EXCEPTION 'PROFIT_LEDGER_ENTRIES_DRIFT: các dòng sổ chi tiết không cộng ra đúng số dư sổ tổng — báo bộ phận kỹ thuật'
      USING ERRCODE = 'XX000',
            DETAIL = jsonb_build_object(
              'balance', v_bal - 'marker',
              'entries', jsonb_build_object(
                'allocated', v_t.alloc_in, 'excluded_allocated', v_t.alloc_ex,
                'payouts_approved', v_t.pay_ok, 'payouts_pending', v_t.pay_pend, 'excluded_payouts', v_t.pay_ex,
                'salary_investment', v_t.sal_inv, 'salary_advance_offset', v_t.sal_off, 'excluded_salary', v_t.sal_ex,
                'needs_review_count', v_t.nr_count, 'needs_review_suggested', v_t.nr_sugg,
                'balance', v_t.total_in))::text;
  END IF;

  RETURN jsonb_build_object('balance', v_bal, 'entries', v_t.entries);
END
$fn$;

-- E8 xem trước và E9 ghi mốc dùng chung số ứng có thể bị loại. Sau khi ghi quỹ,
-- số dư ròng có thể dương dù vẫn còn tạm ứng riêng: phải xác nhận cả số ứng thực đang mở.
CREATE OR REPLACE FUNCTION app_private.profit_ledger_tao_advance_erased_v1(
  p_org uuid, p_kind text, p_subject uuid, p_settled_through_month date, p_balance_now numeric
) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF p_kind = 'SHAREHOLDER' THEN
    PERFORM app_private.profit_ledger_check_shared_fund_marker_v1(p_org, p_subject, p_settled_through_month);
  END IF;
  RETURN greatest(
    abs(least(coalesce(p_balance_now, 0), 0)),
    CASE WHEN p_settled_through_month IS NULL THEN 0::numeric
    WHEN p_kind = 'SHAREHOLDER' AND EXISTS (
      SELECT 1 FROM app_private.profit_ledger_shared_fund_components_v1(p_org, p_subject, NULL)
    ) THEN (
      -- Phiếu ứng cũ đã nhập vào số mở sổ, kể cả W1, không còn là số ứng xóa ở mốc mới.
      SELECT (pos->>'advance_outstanding')::numeric + (pos->>'advance_pending')::numeric
        FROM app_private.profit_ledger_position_v1(p_org, p_subject) pos
    )
    ELSE coalesce((
      SELECT sum(c.advance_amount) FROM app_private.profit_ledger_payouts c
       WHERE c.organization_id = p_org AND c.subject_kind = p_kind
         AND coalesce(c.shareholder_id, c.manager_id) = p_subject
         AND app_private.profit_ledger_voucher_live_v1(c.voucher_id)), 0) END
  );
END
$fn$;

-- Mở số dư sau đối soát thủ công. Người có quyền xác nhận mọi phân bổ đến hết kỳ đã xử lý;
-- phân bổ ở các tháng sau vẫn ở sổ. Tạm ứng mang sang chỉ có bằng chứng ở đây, không sinh phiếu chi.
CREATE OR REPLACE FUNCTION public.shareholder_profit_opening_advance_v1(
  p_organization_id uuid, p_shareholder_id uuid, p_through_month date, p_as_of_date date,
  p_advance_amount numeric, p_expected_unpaid numeric, p_evidence text, p_idempotency_key text,
  p_expected_approved numeric DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_evidence text := btrim(coalesce(p_evidence, ''));
  v_today date;
  v_open app_private.shareholder_profit_openings%ROWTYPE;
  v_marker jsonb;
  v_position jsonb;
  v_vouchers jsonb;
  v_approved numeric;
  v_unsafe boolean;
BEGIN
  IF v_actor IS NULL OR p_organization_id IS NULL OR app_private.shared_fund_owner_v1(p_organization_id) IS NULL THEN
    RAISE EXCEPTION 'Không có quyền ghi số dư đầu kỳ' USING ERRCODE = '42501';
  END IF;
  IF app_private.lock_org_for_decision_v1(p_organization_id) IS NULL THEN
    RAISE EXCEPTION 'Công ty không còn hoạt động' USING ERRCODE = '42501';
  END IF;
  IF app_private.shared_fund_owner_v1(p_organization_id) IS NULL THEN
    RAISE EXCEPTION 'Chỉ chủ công ty có quyền phân phối lợi nhuận mới được ghi số dư đầu kỳ' USING ERRCODE = '42501';
  END IF;
  PERFORM app_private.profit_ledger_tao_assert_route_v1(p_organization_id, ARRAY['CANONICAL']);
  v_today := public.org_today_v1(p_organization_id);
  IF p_shareholder_id IS NULL OR p_through_month IS NULL OR NOT isfinite(p_through_month)
     OR p_as_of_date IS NULL OR NOT isfinite(p_as_of_date)
     OR p_as_of_date < (p_through_month + interval '1 month - 1 day')::date OR p_as_of_date > v_today
     OR p_advance_amount IS NULL OR p_advance_amount NOT BETWEEN 0 AND 9999999999999
     OR p_advance_amount <> trunc(p_advance_amount)
     OR p_expected_unpaid IS NULL OR p_expected_unpaid::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_expected_approved IS NULL OR p_expected_approved < 0 OR p_expected_approved::text IN ('NaN', 'Infinity', '-Infinity')
     OR length(v_evidence) NOT BETWEEN 8 AND 1000 OR v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'SHARED_FUND_OPENING_INPUT: kiểm tra cổ đông, kỳ đã đối soát, ngày đối soát, số dư, căn cứ và khóa yêu cầu'
      USING ERRCODE = '22023';
  END IF;
  PERFORM app_private.profit_ledger_tao_check_month_v1(p_organization_id, p_through_month);
  IF EXISTS (SELECT 1 FROM app_private.shareholder_profit_openings o
              WHERE o.organization_id = p_organization_id AND o.created_by = v_actor
                AND o.request_key = v_key AND o.shareholder_id <> p_shareholder_id) THEN
    RAISE EXCEPTION 'SHARED_FUND_OPENING_KEY_USED: mã yêu cầu đã dùng để mở số dư cổ đông khác' USING ERRCODE = 'PT409';
  END IF;
  PERFORM app_private.profit_ledger_lock_v1(p_organization_id, 'SHAREHOLDER', p_shareholder_id);
  SELECT * INTO v_open FROM app_private.shareholder_profit_openings o
   WHERE o.organization_id = p_organization_id AND o.shareholder_id = p_shareholder_id;
  IF FOUND THEN
    IF v_open.request_key <> v_key OR v_open.created_by <> v_actor OR v_open.through_month <> p_through_month
       OR v_open.as_of_date <> p_as_of_date OR v_open.advance_amount <> p_advance_amount
       OR v_open.evidence <> v_evidence OR v_open.expected_unpaid <> p_expected_unpaid
       OR v_open.reconciled_approved <> p_expected_approved THEN
      RAISE EXCEPTION 'SHARED_FUND_OPENING_EXISTS: cổ đông này đã có đối soát đầu kỳ' USING ERRCODE = 'PT409';
    END IF;
  ELSE
    PERFORM 1 FROM public.shareholders s
     WHERE s.organization_id = p_organization_id AND s.id = p_shareholder_id AND s.is_active AND s.deleted_at IS NULL
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SHARED_FUND_OPENING_SHAREHOLDER: không tìm thấy cổ đông đang hoạt động của công ty'
        USING ERRCODE = '22023';
    END IF;
    -- Mốc của sổ cũ loại phiếu theo thứ tự ghi, lương theo tháng. Cho phép phiếu đã chi thực
    -- có ngày chứng từ trong phạm vi đối soát; lưu từng căn cứ và yêu cầu khớp số chủ đã xem.
    -- Phân bổ mới sau kỳ vẫn còn, các khoản mới/chờ chi và nghiệp vụ lương/chốt đã vào sổ phải được giữ.
    BEGIN
      -- Một số lệnh hủy giữ khóa phiếu trước khóa công ty. NOWAIT trả xung đột cho người dùng
      -- nếu đang hủy/chỉnh phiếu, không chờ vòng khi nhập số mở sổ.
      SELECT coalesce(jsonb_agg(jsonb_build_object('voucher_id', ie.id, 'code', ie.code, 'voucher_date', ie.voucher_date,
                      'posting_id', p.id, 'posted_on', p.posted_on, 'amount', ie.total_amount)
                      ORDER BY ie.voucher_date, ie.id), '[]'::jsonb),
             coalesce(sum(ie.total_amount), 0),
             coalesce(bool_or(ie.approval_status IS DISTINCT FROM 'APPROVED' OR ie.posting_status IS DISTINCT FROM 'POSTED'
                      OR ie.posting_mode IS NOT DISTINCT FROM 'NON_CASH' OR p.posted_on IS NULL OR p.posted_on > p_as_of_date
                      OR ie.voucher_date IS NULL OR ie.voucher_date > p_as_of_date), false)
        INTO v_vouchers, v_approved, v_unsafe
        FROM (SELECT v.* FROM public.income_expenses v
               WHERE v.organization_id = p_organization_id AND v.shareholder_id = p_shareholder_id
                 AND app_private.profit_ledger_voucher_live_v1(v.id) FOR SHARE OF v NOWAIT) ie
        LEFT JOIN public.income_expense_postings p ON p.id = ie.active_posting_id_v2
         AND p.organization_id = p_organization_id AND p.posting_subject_kind = 'VOUCHER'
         AND p.posting_subject_id = ie.id AND p.event_kind = 'POSTING' AND p.direction = 'EXPENSE';
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'SHARED_FUND_OPENING_STALE: đang xử lý phiếu cổ đông, cần đối soát lại' USING ERRCODE = 'PT409';
    END;
    IF v_unsafe THEN
      RAISE EXCEPTION 'SHARED_FUND_OPENING_LEDGER_USED: còn phiếu đang chờ, thiếu bút toán chi hoặc ngày phiếu/ngày chi sau đối soát'
        USING ERRCODE = 'PT409';
    END IF;
    IF EXISTS (SELECT 1 FROM app_private.profit_ledger_markers m
                WHERE m.organization_id = p_organization_id AND m.shareholder_id = p_shareholder_id)
       OR EXISTS (SELECT 1 FROM app_private.profit_ledger_payout_settlements s
                   WHERE s.organization_id = p_organization_id AND s.shareholder_id = p_shareholder_id
                     AND app_private.profit_ledger_settlement_live_v1(s.id))
       OR EXISTS (SELECT 1 FROM app_private.profit_ledger_salary_settlements s
                   WHERE s.organization_id = p_organization_id AND s.shareholder_id = p_shareholder_id AND s.state = 'FROZEN')
       OR EXISTS (SELECT 1 FROM app_private.profit_ledger_salary_settlement_vouchers l
                   WHERE l.organization_id = p_organization_id AND l.shareholder_id = p_shareholder_id
                     AND (l.state = 'QUOTED' OR (l.state IN ('LINKED','NEEDS_REVIEW')
                                              AND app_private.profit_ledger_voucher_live_v1(l.salary_voucher_id))))
       OR EXISTS (SELECT 1 FROM app_private.shared_fund_distribution_lines l
                   WHERE l.organization_id = p_organization_id AND l.shareholder_id = p_shareholder_id) THEN
      RAISE EXCEPTION 'SHARED_FUND_OPENING_LEDGER_USED: sổ cổ đông đã có mốc, lương, chốt chi hoặc phân phối quỹ'
        USING ERRCODE = 'PT409';
    END IF;
    v_position := app_private.profit_ledger_position_v1(p_organization_id, p_shareholder_id);
    IF (v_position ->> 'unpaid_profit')::numeric IS DISTINCT FROM p_expected_unpaid
       OR v_approved <> p_expected_approved OR (v_position ->> 'advance_outstanding')::numeric IS DISTINCT FROM v_approved THEN
      RAISE EXCEPTION 'SHARED_FUND_OPENING_STALE: lợi nhuận hoặc số chi trước đối soát đã thay đổi, cần tải lại'
        USING ERRCODE = 'PT409';
    END IF;
    v_marker := app_private.profit_ledger_tao_set_marker_v1(p_organization_id, 'SHAREHOLDER', p_shareholder_id,
      p_through_month, v_evidence, NULL, true, 'opening:' || md5(v_key), v_actor);
    INSERT INTO app_private.shareholder_profit_openings
      (organization_id, shareholder_id, through_month, as_of_date, advance_amount, evidence, request_key,
       expected_unpaid, reconciled_approved, reconciled_vouchers, marker_id, created_by)
    VALUES (p_organization_id, p_shareholder_id, p_through_month, p_as_of_date, p_advance_amount,
            v_evidence, v_key, p_expected_unpaid, v_approved, v_vouchers, (v_marker ->> 'marker_id')::uuid, v_actor)
    RETURNING * INTO v_open;
    v_position := app_private.profit_ledger_position_v1(p_organization_id, p_shareholder_id);
    IF (v_position ->> 'advance_outstanding')::numeric IS DISTINCT FROM p_advance_amount
       OR (v_position ->> 'advance_pending')::numeric IS DISTINCT FROM 0::numeric THEN
      RAISE EXCEPTION 'SHARED_FUND_OPENING_STALE: không thể thay thế đúng các phiếu đã đối soát' USING ERRCODE = 'PT409';
    END IF;
  END IF;
  RETURN jsonb_build_object('opening_id', v_open.id, 'marker_id', v_open.marker_id,
           'shareholder_id', v_open.shareholder_id, 'through_month', v_open.through_month,
           'as_of_date', v_open.as_of_date, 'advance_amount', v_open.advance_amount, 'evidence', v_open.evidence,
           'reconciled_approved', v_open.reconciled_approved, 'reconciled_count', jsonb_array_length(v_open.reconciled_vouchers));
END
$fn$;
REVOKE ALL ON FUNCTION public.shareholder_profit_opening_advance_v1(uuid,uuid,date,date,numeric,numeric,text,text,numeric)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shareholder_profit_opening_advance_v1(uuid,uuid,date,date,numeric,numeric,text,text,numeric) TO authenticated;
COMMENT ON FUNCTION public.shareholder_profit_opening_advance_v1(uuid,uuid,date,date,numeric,numeric,text,text,numeric) IS
  'Mở sổ cổ đông một lần. Giữ phân bổ sau kỳ và thay tổng ứng đã chi trong phạm vi đối soát bằng dư ứng thực còn lại (bao gồm phiếu cũ). Lưu danh sách phiếu làm chứng từ đối chiếu. Không tạo chứng từ tiền.';
COMMIT;
