-- Chứng từ giải trình một mốc đã đối chiếu. Không đi vào bảng phiếu tiền hoặc phép tính số dư.
BEGIN;

CREATE TABLE IF NOT EXISTS app_private.shareholder_opening_advance_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opening_id uuid NOT NULL REFERENCES app_private.shareholder_profit_openings(id),
  period_month date NOT NULL CHECK (isfinite(period_month) AND extract(day FROM period_month) = 1),
  amount numeric NOT NULL CHECK (amount BETWEEN 1 AND 9999999999999 AND amount = trunc(amount)),
  external_profit numeric CHECK (external_profit BETWEEN -9999999999999 AND 9999999999999 AND external_profit = trunc(external_profit)),
  evidence text NOT NULL CHECK (length(btrim(evidence)) BETWEEN 8 AND 1000),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (opening_id, period_month)
);
ALTER TABLE app_private.shareholder_opening_advance_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.shareholder_opening_advance_receipts FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS opening_advance_receipts_immutable ON app_private.shareholder_opening_advance_receipts;
CREATE TRIGGER opening_advance_receipts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON app_private.shareholder_opening_advance_receipts FOR EACH STATEMENT
  EXECUTE FUNCTION app_private.guard_profit_ledger_append_only_v1();

-- Liên kết phiếu tiền đã ghi sổ với kỳ ứng. Giữ số và ngày thực của chứng từ nguồn.
CREATE TABLE IF NOT EXISTS app_private.shareholder_advance_receipt_sources (
  voucher_id uuid PRIMARY KEY REFERENCES public.income_expenses(id),
  receipt_id uuid NOT NULL REFERENCES app_private.shareholder_opening_advance_receipts(id),
  posting_id uuid NOT NULL,
  code text NOT NULL,
  voucher_date date NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0)
);
ALTER TABLE app_private.shareholder_advance_receipt_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.shareholder_advance_receipt_sources FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS receipt_sources_immutable ON app_private.shareholder_advance_receipt_sources;
CREATE TRIGGER receipt_sources_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON app_private.shareholder_advance_receipt_sources FOR EACH STATEMENT
  EXECUTE FUNCTION app_private.guard_profit_ledger_append_only_v1();

CREATE OR REPLACE FUNCTION app_private.shareholder_receipt_sources_v1(p_receipt uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO pg_catalog AS $sources$
  SELECT coalesce(jsonb_agg(jsonb_build_object('code',s.code,'date',s.voucher_date,'amount',s.amount,
    'live',(v.active_posting_id_v2=s.posting_id AND v.approval_status='APPROVED' AND v.posting_status='POSTED'
      AND v.deleted_at IS NULL AND v.total_amount=s.amount AND v.voucher_date=s.voucher_date) IS TRUE)
    ORDER BY s.voucher_date,s.code),'[]'::jsonb)
  FROM app_private.shareholder_advance_receipt_sources s JOIN public.income_expenses v ON v.id=s.voucher_id
  WHERE s.receipt_id=p_receipt
$sources$;
REVOKE ALL ON FUNCTION app_private.shareholder_receipt_sources_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.shareholder_record_opening_receipts_v1(
  p_organization_id uuid, p_shareholder_id uuid, p_opening_id uuid, p_receipts jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
DECLARE
  opening app_private.shareholder_profit_openings;
  submitted jsonb;
  saved jsonb;
  gross numeric;
  external_total numeric;
  locked_profit numeric;
  invalid boolean;
  wanted integer;
  inserted integer;
BEGIN
  IF auth.uid() IS NULL OR app_private.shared_fund_owner_v1(p_organization_id) IS NULL THEN
    RAISE EXCEPTION 'Chỉ chủ công ty có quyền phân phối lợi nhuận được ghi chứng từ đối chiếu' USING ERRCODE='42501';
  END IF;
  IF app_private.lock_org_for_decision_v1(p_organization_id) IS NULL
     OR app_private.shared_fund_owner_v1(p_organization_id) IS NULL THEN
    RAISE EXCEPTION 'Quyền hoặc trạng thái công ty đã đổi' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.profit_ledger_tao_assert_route_v1(p_organization_id, ARRAY['CANONICAL']);
  PERFORM app_private.profit_ledger_lock_v1(p_organization_id, 'SHAREHOLDER', p_shareholder_id);
  SELECT * INTO STRICT opening FROM app_private.shareholder_profit_openings
    WHERE id=p_opening_id AND organization_id=p_organization_id AND shareholder_id=p_shareholder_id FOR SHARE;
  IF jsonb_typeof(p_receipts) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Cần danh sách phiếu ứng lịch sử' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_receipts) NOT BETWEEN 1 AND 240 THEN
    RAISE EXCEPTION 'Kiểm tra số kỳ cần đối chiếu' USING ERRCODE='22023';
  END IF;
  SELECT jsonb_agg(to_jsonb(r) || jsonb_build_object('source_codes',ARRAY(
      SELECT code FROM unnest(r.source_codes) AS code ORDER BY code)) ORDER BY r.period_month), sum(r.amount), coalesce(sum(r.external_profit),0),
    count(*) <> count(DISTINCT r.period_month)
    OR bool_or(r.period_month IS NULL OR NOT isfinite(r.period_month) OR r.period_month > opening.through_month
      OR extract(day FROM r.period_month)<>1 OR r.amount IS NULL OR r.amount NOT BETWEEN 1 AND 9999999999999
      OR cardinality(r.source_codes)>100 OR r.amount<>trunc(r.amount) OR r.evidence IS NULL OR length(btrim(r.evidence)) NOT BETWEEN 8 AND 1000
      OR (r.external_profit IS NOT NULL AND (r.external_profit<>trunc(r.external_profit)
        OR r.external_profit NOT BETWEEN -9999999999999 AND 9999999999999)))
    INTO submitted,gross,external_total,invalid
    FROM jsonb_to_recordset(p_receipts) r(period_month date,amount numeric,external_profit numeric,evidence text,source_codes text[]);
  IF invalid THEN RAISE EXCEPTION 'Kỳ, số tiền hoặc căn cứ đối chiếu không hợp lệ' USING ERRCODE='22023'; END IF;

  SELECT jsonb_agg(jsonb_build_object('period_month',r.period_month,'amount',r.amount,
    'external_profit',r.external_profit,'evidence',r.evidence,'source_codes',ARRAY(
      SELECT s.code FROM app_private.shareholder_advance_receipt_sources s WHERE s.receipt_id=r.id ORDER BY s.code))
    ORDER BY r.period_month)
    INTO saved FROM app_private.shareholder_opening_advance_receipts r WHERE r.opening_id=p_opening_id;
  IF saved IS NOT NULL AND saved<>submitted THEN
    RAISE EXCEPTION 'Mốc đã có bộ chứng từ khác' USING ERRCODE='PT409';
  END IF;
  IF saved IS NULL THEN
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(submitted) r(period_month date)
      JOIN jsonb_to_recordset(opening.reconciled_vouchers) v(voucher_date date)
        ON r.period_month=(date_trunc('month',v.voucher_date)-interval '1 month')::date) THEN
      RAISE EXCEPTION 'Kỳ đã có phiếu CRM trong mốc, cần đối chiếu lại' USING ERRCODE='22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(submitted) r(period_month date,external_profit numeric)
      WHERE (r.external_profit IS NOT NULL) = EXISTS (
        SELECT 1 FROM public.profit_monthly m JOIN public.profit_allocations a ON a.profit_monthly_id=m.id
        WHERE m.organization_id=p_organization_id AND m.status='LOCKED' AND a.shareholder_id=p_shareholder_id
          AND m.period_month=r.period_month)) THEN
      RAISE EXCEPTION 'Dùng lợi nhuận đã chốt trong CRM, chỉ nhập lợi nhuận ngoài sổ cho kỳ thiếu phân bổ' USING ERRCODE='22023';
    END IF;
    SELECT coalesce(sum(a.amount),0) INTO locked_profit FROM public.profit_monthly m
      JOIN public.profit_allocations a ON a.profit_monthly_id=m.id
      WHERE m.organization_id=p_organization_id AND a.shareholder_id=p_shareholder_id
        AND m.period_month<=opening.through_month AND m.status='LOCKED';
    IF gross+opening.reconciled_approved-external_total-locked_profit<>opening.advance_amount THEN
      RAISE EXCEPTION 'Tổng phiếu ứng trừ lợi nhuận chưa khớp số dư chuyển kỳ' USING ERRCODE='22023';
    END IF;
    INSERT INTO app_private.shareholder_opening_advance_receipts(opening_id,period_month,amount,external_profit,evidence,recorded_by)
      SELECT p_opening_id,r.period_month,r.amount,r.external_profit,r.evidence,auth.uid()
      FROM jsonb_to_recordset(submitted) r(period_month date,amount numeric,external_profit numeric,evidence text);
    SELECT coalesce(sum(cardinality(r.source_codes)),0) INTO wanted
      FROM jsonb_to_recordset(submitted) r(source_codes text[]);
    -- Khoá phiếu đang có hiệu lực đến hết giao dịch. Phiếu thuộc kỳ sau, của đúng công ty,
    -- chưa nằm trong sổ cổ đông và chỉ giải trình được một kỳ ứng.
    WITH candidates AS MATERIALIZED (
      SELECT receipt.id AS receipt_id,v.id,v.active_posting_id_v2,v.code,v.voucher_date,v.total_amount
      FROM jsonb_to_recordset(submitted) r(period_month date,source_codes text[])
      JOIN app_private.shareholder_opening_advance_receipts receipt
        ON receipt.opening_id=p_opening_id AND receipt.period_month=r.period_month
      CROSS JOIN LATERAL unnest(r.source_codes) c(code)
      JOIN public.income_expenses v ON v.organization_id=p_organization_id AND v.code=c.code
      WHERE v.type='EXPENSE' AND v.approval_status='APPROVED' AND v.posting_status='POSTED'
        AND v.active_posting_id_v2 IS NOT NULL AND v.deleted_at IS NULL AND v.shareholder_id IS NULL
        AND v.voucher_date >= r.period_month + interval '1 month'
        AND v.voucher_date < r.period_month + interval '2 months'
      ORDER BY v.id FOR SHARE OF v
    )
    INSERT INTO app_private.shareholder_advance_receipt_sources(receipt_id,voucher_id,posting_id,code,voucher_date,amount)
      SELECT receipt_id,id,active_posting_id_v2,code,voucher_date,total_amount FROM candidates;
    GET DIAGNOSTICS inserted = ROW_COUNT;
    IF inserted <> wanted THEN
      RAISE EXCEPTION 'Có phiếu nguồn sai kỳ, sai công ty hoặc chưa ghi chi' USING ERRCODE='22023';
    END IF;
  END IF;
  RETURN jsonb_build_object('opening_id',p_opening_id,'count',jsonb_array_length(submitted),'amount',gross);
END $fn$;
REVOKE ALL ON FUNCTION public.shareholder_record_opening_receipts_v1(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.shareholder_record_opening_receipts_v1(uuid,uuid,uuid,jsonb) TO authenticated;

-- Mở rộng kết quả sau khi E3 đã kiểm quyền và tìm cổ đông của chính người gọi.
DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.shareholder_profit_my_ledger_v1(uuid)'::regprocedure);
  anchor constant text := '  RETURN v_out;';
  addition constant text := $fragment$
  SELECT v_out || jsonb_build_object('historical_advances',coalesce(jsonb_agg(jsonb_build_object(
    'id',r.id,'period_month',r.period_month,'amount',r.amount,'external_profit',r.external_profit,
    'evidence',r.evidence,'sources',app_private.shareholder_receipt_sources_v1(r.id),'code','TU-LS-' || to_char(r.period_month,'YYYYMM') || '-' || left(r.id::text,8)
  ) ORDER BY r.period_month), '[]'::jsonb)) INTO v_out
  FROM app_private.shareholder_opening_advance_receipts r
  JOIN app_private.shareholder_profit_openings o ON o.id=r.opening_id
  WHERE o.organization_id=p_organization_id AND o.shareholder_id=v_sh.id;
$fragment$;
BEGIN
  IF strpos(definition,addition)=0 THEN
    IF regexp_count(definition,anchor)<>1 THEN RAISE EXCEPTION 'Định nghĩa hàm đọc sổ cá nhân đã đổi'; END IF;
    EXECUTE replace(definition,anchor,addition || anchor);
  END IF;
END $migration$;
DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.shared_fund_state_v1(uuid)'::regprocedure);
  anchor constant text := '''reconciled_count'', jsonb_array_length(o.reconciled_vouchers),';
  addition constant text := $fragment$'historical_count', (SELECT count(*) FROM app_private.shareholder_opening_advance_receipts r WHERE r.opening_id=o.id), $fragment$;
BEGIN
  IF strpos(definition,addition)=0 THEN
    IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'Định nghĩa hàm đọc mốc ứng đã đổi'; END IF;
    EXECUTE replace(definition,anchor,addition || anchor);
  END IF;
END $migration$;
COMMIT;
