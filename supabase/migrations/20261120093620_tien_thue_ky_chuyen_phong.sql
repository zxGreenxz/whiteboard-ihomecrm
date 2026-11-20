-- Nguồn giá cho các kỳ có chuyển phòng. Chỉ writer chuyển phòng đã kiểm quyền,
-- khóa hợp đồng và hai phòng được ghi giá cũ/mới trong cùng giao dịch.
BEGIN;

CREATE TABLE IF NOT EXISTS app_private.room_transfer_rent_events (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  contract_id uuid NOT NULL REFERENCES public.contracts(id),
  move_date date NOT NULL CHECK (isfinite(move_date)),
  old_room_id uuid NOT NULL REFERENCES public.rooms(id),
  new_room_id uuid NOT NULL REFERENCES public.rooms(id),
  old_rent numeric(15,2) NOT NULL CHECK (old_rent >= 0 AND old_rent <> 'NaN'::numeric),
  new_rent numeric(15,2) NOT NULL CHECK (new_rent >= 0 AND new_rent <> 'NaN'::numeric),
  refund_reservation_id uuid UNIQUE REFERENCES app_private.invoice_refund_reservations(id),
  period_start date,
  period_end date,
  billing_month text,
  rent_override numeric(15,2),
  period_rent numeric(15,2),
  invoiced_id uuid,
  prior_refunds numeric(15,2),
  PRIMARY KEY (organization_id, contract_id, move_date),
  CHECK (old_room_id <> new_room_id)
);
REVOKE ALL ON app_private.room_transfer_rent_events FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.record_room_transfer_rent_v1(
  p_org uuid, p_contract uuid, p_move_date date, p_old_room uuid, p_new_room uuid,
  p_old_rate numeric, p_new_rate numeric, p_quote jsonb DEFAULT NULL
) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO app_private.room_transfer_rent_events(
    organization_id, contract_id, move_date, old_room_id, new_room_id, old_rent, new_rent,
    period_start,period_end,billing_month,rent_override,period_rent,invoiced_id,prior_refunds
  ) VALUES (p_org, p_contract, p_move_date, p_old_room, p_new_room, p_old_rate, COALESCE(p_new_rate, p_old_rate),
    (p_quote->>'period_start')::date,(p_quote->>'period_end')::date,p_quote->>'billing_month',(p_quote->>'rent_override')::numeric,
    (p_quote->>'period_rent')::numeric,(p_quote->>'invoice_id')::uuid,(p_quote->>'refund_reserved')::numeric)
  ON CONFLICT (organization_id, contract_id, move_date) DO NOTHING;
  IF NOT FOUND AND NOT EXISTS (
    SELECT 1 FROM app_private.room_transfer_rent_events e WHERE e.organization_id = p_org
      AND e.contract_id = p_contract AND e.move_date = p_move_date AND e.old_room_id = p_old_room
      AND e.new_room_id = p_new_room AND e.old_rent = p_old_rate AND e.new_rent = COALESCE(p_new_rate, p_old_rate)
  ) THEN
    RAISE EXCEPTION 'Lịch sử tiền thuê ngày chuyển đã có dữ kiện khác' USING ERRCODE='23505';
  END IF;
END $$;

-- Tháng ghi sổ của kỳ đầu theo computeFirstBillingMonth: tháng trọn vẹn cuối cùng,
-- hoặc tháng bắt đầu khi không có tháng trọn. Kỳ Excel định kỳ dùng tháng lịch.
CREATE OR REPLACE FUNCTION app_private.room_transfer_first_month_v1(p_from date, p_to date)
RETURNS text LANGUAGE sql STABLE STRICT SET search_path = pg_catalog AS $$
  SELECT to_char(GREATEST(date_trunc('month', p_from::timestamp),
    CASE WHEN p_to = (date_trunc('month', p_to::timestamp) + interval '1 month - 1 day')::date
      THEN date_trunc('month', p_to::timestamp) ELSE date_trunc('month', p_to::timestamp) - interval '1 month' END
  ), 'YYYY-MM')
$$;

-- Một resolver cho preview và writer: kỳ RENT đã ghi ngày thắng tháng kế toán.
CREATE OR REPLACE FUNCTION app_private.room_transfer_billing_period_v1(
  p_org uuid, p_contract uuid, p_month text, p_item_from date, p_item_to date
) RETURNS TABLE(period_start date, period_end date)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  c record;
  month_start date;
  month_end date;
  first_month text;
BEGIN
  SELECT start_date, start_billing_date, end_billing_date INTO STRICT c FROM public.contracts
    WHERE id = p_contract AND organization_id = p_org AND deleted_at IS NULL;
  IF p_month IS NULL OR p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'Thiếu tháng hóa đơn hợp lệ để tính tiền thuê chuyển phòng' USING ERRCODE='22023';
  END IF;
  month_start := (p_month || '-01')::date;
  month_end := (month_start + interval '1 month - 1 day')::date;
  IF p_item_from IS NOT NULL OR p_item_to IS NOT NULL THEN
    period_start := p_item_from;
    period_end := p_item_to;
  ELSE
    SELECT e.period_start,e.period_end INTO period_start,period_end
      FROM app_private.room_transfer_rent_events e
      WHERE e.organization_id=p_org AND e.contract_id=p_contract AND e.billing_month=p_month
      ORDER BY e.move_date DESC LIMIT 1;
    IF NOT FOUND THEN
      first_month := app_private.room_transfer_first_month_v1(COALESCE(c.start_billing_date, c.start_date), c.end_billing_date);
      IF first_month = p_month THEN
        period_start := COALESCE(c.start_billing_date, c.start_date);
        period_end := c.end_billing_date;
      ELSE
        period_start := GREATEST(month_start, COALESCE(c.start_billing_date, c.start_date));
        period_end := month_end;
        IF first_month < p_month THEN
          period_start := GREATEST(period_start, c.end_billing_date + 1);
        END IF;
      END IF;
    END IF;
  END IF;
  IF period_start IS NULL OR period_end IS NULL OR NOT isfinite(period_start) OR NOT isfinite(period_end)
    OR period_end < period_start THEN
    RAISE EXCEPTION 'Kỳ tiền thuê không đủ hai mốc ngày hợp lệ' USING ERRCODE='22023';
  END IF;
  RETURN NEXT;
END $$;

-- Cộng chính xác các đoạn giá theo tháng dương lịch như calculateProratedRent
-- (kỳ đầu có thể qua nhiều tháng); làm tròn một lần đến đồng. Ngày chuyển
-- thuộc phòng mới. SQL vẫn xử lý cả trường hợp chuyển nhiều lần trong cùng kỳ.
CREATE OR REPLACE FUNCTION app_private.room_transfer_rent_amount_v1(
  p_org uuid, p_contract uuid, p_from date, p_to date,
  p_move_date date, p_old_rate numeric, p_new_rate numeric
) RETURNS numeric LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  e record;
  first_rate numeric;
  active_rate numeric;
  amount numeric;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_to < p_from THEN
    RAISE EXCEPTION 'Kỳ tiền thuê không hợp lệ' USING ERRCODE='22023';
  END IF;

  -- Khách có thể đổi phòng trong các ngày miễn tiền đầu kỳ. Nếu kỳ đầu
  -- chưa chứa lần chuyển có tính tiền nào, dùng giá của phòng lúc bắt đầu thu.
  IF p_move_date IS NULL AND NOT EXISTS (
    SELECT 1 FROM app_private.room_transfer_rent_events h WHERE h.organization_id=p_org
      AND h.contract_id=p_contract AND h.move_date BETWEEN p_from AND p_to
  ) THEN
    SELECT h.new_rent INTO first_rate FROM app_private.room_transfer_rent_events h
      JOIN public.contracts c ON c.organization_id=h.organization_id AND c.id=h.contract_id
      WHERE h.organization_id=p_org AND h.contract_id=p_contract AND p_from=c.start_billing_date
        AND h.move_date BETWEEN c.start_date AND c.start_billing_date-1
      ORDER BY h.move_date DESC LIMIT 1;
  END IF;

  -- Dữ liệu cũ thiếu ảnh giá: không thể coi giá phòng hiện tại là giá khách
  -- đã thỏa thuận khi ở phòng cũ. Dừng trước khi tạo bất kỳ khoản tiền nào.
  FOR e IN
    SELECT h.move_date, h.old_rent, h.new_rent FROM app_private.room_transfer_rent_events h
     WHERE h.organization_id = p_org AND h.contract_id = p_contract AND h.move_date BETWEEN p_from AND p_to
    UNION ALL SELECT p_move_date, p_old_rate, p_new_rate WHERE p_move_date BETWEEN p_from AND p_to
    ORDER BY 1
  LOOP
    IF active_rate IS NOT NULL AND active_rate <> e.old_rent THEN
      RAISE EXCEPTION 'Giá thuê đổi giữa hai lần chuyển, cần đối chiếu kỳ hóa đơn' USING ERRCODE='55000';
    END IF;
    first_rate := COALESCE(first_rate, e.old_rent);
    active_rate := e.new_rent;
  END LOOP;
  IF first_rate IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1 FROM public.contract_transfers t
    WHERE t.contract_id = p_contract AND t.transfer_type IN ('ROOM_CHANGE','BOTH_CHANGE')
      AND t.status IN ('APPROVED','COMPLETED') AND COALESCE(t.move_in_date,t.transfer_date) BETWEEN p_from AND p_to
      AND NOT EXISTS (SELECT 1 FROM app_private.room_transfer_rent_events h
        WHERE h.organization_id = p_org AND h.contract_id = t.contract_id AND h.move_date = COALESCE(t.move_in_date,t.transfer_date)
          AND h.old_room_id = t.old_room_id AND h.new_room_id = t.new_room_id)
  ) THEN
    RAISE EXCEPTION 'Thiếu giá thuê lịch sử của lần chuyển phòng trong kỳ, cần đối chiếu hóa đơn' USING ERRCODE='55000';
  END IF;

  WITH changes AS (
    SELECT h.move_date AS d, h.new_rent AS rate FROM app_private.room_transfer_rent_events h
     WHERE h.organization_id = p_org AND h.contract_id = p_contract AND h.move_date BETWEEN p_from AND p_to
    UNION ALL SELECT p_move_date, p_new_rate WHERE p_move_date BETWEEN p_from AND p_to
  ), starts AS (
    SELECT p_from AS d, first_rate AS rate WHERE NOT EXISTS (SELECT 1 FROM changes WHERE d = p_from)
    UNION ALL SELECT d, rate FROM changes
  ), segments AS (
    SELECT d, lead(d, 1, p_to+1) OVER (ORDER BY d) AS until, rate FROM starts
  ), months AS (
    SELECT m::date AS d, (m+interval '1 month')::date AS until
    FROM generate_series(date_trunc('month',p_from::timestamp),p_to::timestamp,interval '1 month') m
  ), pieces AS (
    SELECT m.d, m.until-m.d AS days_in_month,
      sum(s.rate * (LEAST(m.until,s.until)-GREATEST(m.d,s.d))) AS rent_days
    FROM segments s JOIN months m ON s.d < m.until AND m.d < s.until GROUP BY m.d,m.until
  )
  SELECT round(sum(rent_days/days_in_month)) INTO amount FROM pieces;
  RETURN amount;
END $$;

CREATE OR REPLACE FUNCTION app_private.room_transfer_rent_for_period_v1(p_org uuid,p_contract uuid,p_from date,p_to date)
RETURNS numeric LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE scheduled numeric; adjustment numeric;
BEGIN
  scheduled := app_private.room_transfer_rent_amount_v1(p_org,p_contract,p_from,p_to,NULL,NULL,NULL);
  IF EXISTS (SELECT 1 FROM app_private.room_transfer_rent_events e WHERE e.organization_id=p_org AND e.contract_id=p_contract
      AND e.rent_override<>0 AND e.period_start<=p_to AND p_from<=e.period_end
      AND (e.period_start,e.period_end)<>(p_from,p_to)) THEN
    RAISE EXCEPTION 'Kỳ lập lại lệch kỳ có giá thuê thỏa thuận, cần đối chiếu' USING ERRCODE='55000';
  END IF;
  IF scheduled IS NULL THEN RETURN NULL; END IF;
  SELECT e.rent_override INTO adjustment FROM app_private.room_transfer_rent_events e
    WHERE e.organization_id=p_org AND e.contract_id=p_contract AND e.period_start=p_from AND e.period_end=p_to
    ORDER BY e.move_date DESC LIMIT 1;
  RETURN GREATEST(0,scheduled+COALESCE(adjustment,0));
END
$$;

-- Một kỳ tiền phòng có thể phủ ngày của tháng ghi sổ bên cạnh. Hóa đơn
-- tháng bên cạnh chỉ được thu các ngày còn lại sau khi trừ kỳ đã dành đó.
CREATE OR REPLACE FUNCTION app_private.room_transfer_sibling_rent_v1(
  p_org uuid,p_contract uuid,p_month text,p_from date DEFAULT NULL,p_to date DEFAULT NULL
) RETURNS numeric LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  c record;
  first_day date;
  month_start date;
  month_end date;
  covered datemultirange;
  remaining datemultirange;
  part daterange;
  amount numeric;
  rate numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_private.room_transfer_rent_events e
    WHERE e.organization_id=p_org AND e.contract_id=p_contract) THEN RETURN NULL; END IF;
  IF p_month IS NULL OR p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    OR (p_from IS NULL)<>(p_to IS NULL) OR p_to<p_from THEN
    RAISE EXCEPTION 'Kỳ tiền thuê không hợp lệ' USING ERRCODE='22023';
  END IF;
  SELECT start_date,start_billing_date,end_billing_date INTO STRICT c FROM public.contracts
    WHERE id=p_contract AND organization_id=p_org AND deleted_at IS NULL;
  first_day:=COALESCE(c.start_billing_date,c.start_date);
  month_start:=(p_month||'-01')::date;
  month_end:=(month_start+interval '1 month')::date;
  SELECT range_agg(daterange(s,e,'[]')) INTO covered FROM (
    SELECT h.period_start AS s,h.period_end AS e FROM app_private.room_transfer_rent_events h
      WHERE h.organization_id=p_org AND h.contract_id=p_contract AND h.billing_month<>p_month
        AND h.period_start IS NOT NULL AND h.period_end IS NOT NULL
    UNION ALL SELECT first_day,c.end_billing_date
      WHERE app_private.room_transfer_first_month_v1(first_day,c.end_billing_date)<>p_month
        AND EXISTS (SELECT 1 FROM app_private.room_transfer_rent_events h
          WHERE h.organization_id=p_org AND h.contract_id=p_contract
            AND h.move_date BETWEEN c.start_date AND c.end_billing_date)
        AND NOT EXISTS (SELECT 1 FROM app_private.room_transfer_rent_events h
          WHERE h.organization_id=p_org AND h.contract_id=p_contract
            AND h.period_start=first_day AND h.period_end=c.end_billing_date)
  ) claimed WHERE daterange(s,e,'[]') && daterange(month_start,month_end,'[)')
    OR (p_from IS NOT NULL AND daterange(s,e,'[]') && daterange(p_from,p_to,'[]'));
  IF covered IS NULL THEN RETURN NULL; END IF;
  IF GREATEST(month_start,first_day,p_from)>=LEAST(month_end,COALESCE(p_to+1,month_end)) THEN RETURN 0; END IF;
  remaining:=datemultirange(daterange(GREATEST(month_start,first_day,p_from),LEAST(month_end,p_to+1),'[)')) - covered;
  IF isempty(remaining) THEN RETURN 0; END IF;
  -- Hai khoảng rời nhau trên một dòng thuê không thể đối chiếu bằng from_date/to_date.
  IF (SELECT count(*) FROM unnest(remaining))<>1 THEN
    RAISE EXCEPTION 'Kỳ hóa đơn có nhiều khoảng tiền thuê rời nhau, cần đối chiếu' USING ERRCODE='55000';
  END IF;
  SELECT r INTO part FROM unnest(remaining) r;
  amount:=app_private.room_transfer_rent_for_period_v1(p_org,p_contract,lower(part),upper(part)-1);
  IF amount IS NOT NULL THEN RETURN amount; END IF;
  SELECT COALESCE(
    (SELECT h.new_rent FROM app_private.room_transfer_rent_events h WHERE h.organization_id=p_org AND h.contract_id=p_contract
      AND h.move_date<lower(part) ORDER BY h.move_date DESC LIMIT 1),
    (SELECT h.old_rent FROM app_private.room_transfer_rent_events h WHERE h.organization_id=p_org AND h.contract_id=p_contract
      AND h.move_date>=upper(part) ORDER BY h.move_date LIMIT 1)) INTO rate;
  RETURN app_private.room_transfer_rent_amount_v1(p_org,p_contract,lower(part),upper(part)-1,lower(part),rate,rate);
END $$;

CREATE OR REPLACE FUNCTION app_private.quote_room_transfer_rent_v1(
  p_org uuid, p_contract uuid, p_transfer_date date, p_new_rent_price numeric
) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  c record;
  match record;
  from_day date;
  to_day date;
  selected_month text;
  new_rate numeric;
  target numeric;
  scheduled numeric;
  prior_schedule numeric;
  adjustment numeric;
  previous record;
  matched_invoice uuid;
  rent_item_id uuid;
  invoice_status text;
  invoice_paid numeric;
  invoice_revision bigint;
  invoice_updated_at timestamptz;
  invoice_subtotal numeric;
  invoice_total numeric;
  item_amount numeric := 0;
  refunds numeric := 0;
  billable_move date;
BEGIN
  SELECT rent_price,start_date,start_billing_date,end_billing_date INTO STRICT c FROM public.contracts
    WHERE id = p_contract AND organization_id = p_org AND deleted_at IS NULL;
  new_rate := COALESCE(p_new_rent_price,c.rent_price);
  IF p_transfer_date IS NULL OR NOT isfinite(p_transfer_date) OR c.rent_price IS NULL
    OR new_rate IS NULL OR new_rate < 0 OR new_rate::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Ngày chuyển và giá thuê phải hợp lệ' USING ERRCODE='22023';
  END IF;
  billable_move := GREATEST(p_transfer_date,COALESCE(c.start_billing_date,c.start_date));
  selected_month := to_char(billable_move,'YYYY-MM');
  IF billable_move BETWEEN COALESCE(c.start_billing_date,c.start_date) AND c.end_billing_date THEN
    selected_month := app_private.room_transfer_first_month_v1(COALESCE(c.start_billing_date,c.start_date),c.end_billing_date);
  END IF;
  SELECT COALESCE((SELECT e.billing_month FROM app_private.room_transfer_rent_events e
    WHERE e.organization_id=p_org AND e.contract_id=p_contract AND billable_move BETWEEN e.period_start AND e.period_end
    ORDER BY e.move_date DESC LIMIT 1),selected_month) INTO selected_month;

  -- Dòng có cặp ngày tường minh có thể nằm trên hóa đơn mang tháng ghi sổ khác.
  -- Truy vấn toàn bộ các kỳ của chính hợp đồng, bỏ phiếu đã hủy/xóa và quyết toán.
  FOR match IN
    SELECT i.id, i.billing_month, i.status, i.paid_amount, i.adjustment_revision, i.updated_at, i.subtotal, i.total_amount,
           it.id AS item_id,it.amount,it.from_date,it.to_date
    FROM public.invoices i
    LEFT JOIN public.invoice_items it ON it.invoice_id=i.id AND it.type='RENT' AND COALESCE(it.accounting_class,'REVENUE')='REVENUE'
    WHERE i.organization_id=p_org AND i.contract_id=p_contract AND i.deleted_at IS NULL
      AND i.kind='MONTHLY' AND i.status<>'CANCELLED'
      AND (billable_move BETWEEN it.from_date AND it.to_date OR i.billing_month=selected_month)
    ORDER BY i.id, it.id
  LOOP
    IF match.billing_month<>selected_month
      AND billable_move BETWEEN COALESCE(c.start_billing_date,c.start_date) AND c.end_billing_date
      AND (match.from_date,match.to_date) IS DISTINCT FROM (COALESCE(c.start_billing_date,c.start_date),c.end_billing_date) THEN
      IF match.amount=0 OR match.amount=app_private.room_transfer_sibling_rent_v1(
        p_org,p_contract,match.billing_month,match.from_date,match.to_date) THEN CONTINUE; END IF;
      RAISE EXCEPTION 'Tiền phòng trên hóa đơn tháng khác chồng lên kỳ chuyển, cần đối chiếu' USING ERRCODE='55000';
    END IF;
    IF (match.from_date IS NULL) <> (match.to_date IS NULL) THEN
      RAISE EXCEPTION 'Dòng tiền phòng thiếu mốc ngày, cần đối chiếu' USING ERRCODE='55000';
    END IF;
    IF match.from_date IS NOT NULL AND NOT (billable_move BETWEEN match.from_date AND match.to_date) THEN
      RAISE EXCEPTION 'Kỳ tiền phòng trên hóa đơn không bao phủ ngày chuyển, cần đối chiếu' USING ERRCODE='55000';
    END IF;
    IF matched_invoice IS NOT NULL THEN
      RAISE EXCEPTION 'Nhiều dòng tiền phòng cho kỳ chuyển, cần đối chiếu trước khi tính chênh lệch' USING ERRCODE='55000';
    END IF;
    matched_invoice := match.id;
    rent_item_id := match.item_id;
    invoice_status := match.status;
    invoice_paid := match.paid_amount;
    invoice_revision := match.adjustment_revision;
    invoice_updated_at := match.updated_at;
    invoice_subtotal := match.subtotal;
    invoice_total := match.total_amount;
    item_amount := COALESCE(match.amount,0);
    SELECT p.period_start,p.period_end INTO from_day,to_day
      FROM app_private.room_transfer_billing_period_v1(p_org,p_contract,match.billing_month,match.from_date,match.to_date) p;
    selected_month := match.billing_month;
  END LOOP;
  IF matched_invoice IS NULL THEN
    SELECT p.period_start,p.period_end INTO from_day,to_day
      FROM app_private.room_transfer_billing_period_v1(p_org,p_contract,selected_month,NULL,NULL) p;
  ELSE
    SELECT COALESCE(sum(r.amount),0) INTO refunds FROM app_private.invoice_refund_reservations r
      JOIN app_private.room_transfer_rent_events e ON e.refund_reservation_id=r.id AND e.organization_id=r.organization_id
      WHERE e.contract_id=p_contract AND r.organization_id=p_org AND r.invoice_id=matched_invoice
        AND r.reservation_state IN ('HELD','CONSUMED');
  END IF;
  IF billable_move NOT BETWEEN from_day AND to_day THEN
    RAISE EXCEPTION 'Ngày chuyển nằm ngoài kỳ tiền thuê, cần đối chiếu trước khi lập hóa đơn' USING ERRCODE='55000';
  END IF;
  -- Phiếu lập trước khi có lịch sử chuyển có thể đã thu những ngày trùng kỳ dù
  -- dòng thuê không phủ chính ngày chuyển. Không tự điều chỉnh hai chứng từ.
  IF EXISTS (SELECT 1 FROM public.invoices i JOIN public.invoice_items it ON it.invoice_id=i.id
    WHERE i.organization_id=p_org AND i.contract_id=p_contract AND i.kind='MONTHLY'
      AND i.deleted_at IS NULL AND i.status<>'CANCELLED' AND i.id IS DISTINCT FROM matched_invoice
      AND i.billing_month<>selected_month AND it.type='RENT' AND COALESCE(it.accounting_class,'REVENUE')='REVENUE'
      AND it.amount<>0 AND (
        (it.from_date<=to_day AND it.to_date>=from_day) OR ((it.from_date IS NULL OR it.to_date IS NULL)
          AND i.billing_month BETWEEN to_char(from_day,'YYYY-MM') AND to_char(to_day,'YYYY-MM')))
      AND it.amount IS DISTINCT FROM app_private.room_transfer_sibling_rent_v1(p_org,p_contract,i.billing_month,it.from_date,it.to_date)
  ) THEN
    RAISE EXCEPTION 'Tiền phòng trên hóa đơn tháng khác chồng lên kỳ chuyển, cần đối chiếu' USING ERRCODE='55000';
  END IF;
  IF new_rate<>c.rent_price AND EXISTS (SELECT 1 FROM public.invoices i JOIN public.invoice_items it ON it.invoice_id=i.id
    WHERE i.organization_id=p_org AND i.contract_id=p_contract AND i.kind='MONTHLY'
      AND i.deleted_at IS NULL AND i.status<>'CANCELLED' AND i.id IS DISTINCT FROM matched_invoice
      AND i.billing_month>selected_month AND i.billing_month<=to_char(to_day,'YYYY-MM')
      AND it.type='RENT' AND COALESCE(it.accounting_class,'REVENUE')='REVENUE' AND it.amount>0
      AND (it.to_date IS NULL OR it.to_date>to_day)
  ) THEN
    RAISE EXCEPTION 'Tháng bên cạnh đã lập tiền phòng cho các ngày sau kỳ chuyển, cần đối chiếu giá mới' USING ERRCODE='55000';
  END IF;
  scheduled := app_private.room_transfer_rent_amount_v1(p_org,p_contract,from_day,to_day,billable_move,c.rent_price,new_rate);
  prior_schedule := app_private.room_transfer_rent_amount_v1(p_org,p_contract,from_day,to_day,billable_move,c.rent_price,c.rent_price);
  SELECT e.invoiced_id,e.rent_override,e.period_rent,e.prior_refunds,COALESCE(r.amount,0) AS new_refund
    INTO previous FROM app_private.room_transfer_rent_events e
    LEFT JOIN app_private.invoice_refund_reservations r ON r.id=e.refund_reservation_id AND r.organization_id=e.organization_id
    WHERE e.organization_id=p_org AND e.contract_id=p_contract AND e.period_start=from_day AND e.period_end=to_day
    ORDER BY e.move_date DESC LIMIT 1;
  adjustment := COALESCE(previous.rent_override,0);
  IF rent_item_id IS NOT NULL THEN
    IF matched_invoice=previous.invoiced_id THEN
      -- Giá trên dòng lần trước gồm tiền thuê ròng và các khoản hoàn khi đó.
      -- Giữ phần sửa tay phát sinh sau lần chuyển; việc hủy/chi phiếu hoàn
      -- thay đổi số đã tính cho khách nhưng không đổi đơn giá đã thỏa thuận.
      adjustment := adjustment + item_amount - (previous.period_rent + previous.prior_refunds + previous.new_refund);
    ELSE
      adjustment := item_amount-refunds-prior_schedule;
    END IF;
  END IF;
  target := GREATEST(0,scheduled+adjustment);
  IF rent_item_id IS NOT NULL AND c.rent_price=new_rate THEN target:=item_amount-refunds; END IF;
  RETURN jsonb_build_object(
    'period_start',from_day,'period_end',to_day,'billing_month',selected_month,
    'old_days',billable_move-from_day,'new_days',to_day-billable_move+1,'old_rent',c.rent_price,'new_rent',new_rate,
    'period_rent',target,'scheduled_rent',scheduled,'rent_override',adjustment,
    'rent_item_amount',item_amount,'refund_reserved',refunds,'billed_rent',item_amount-refunds,
    'rent_delta',target-(item_amount-refunds),'invoice_id',matched_invoice,'rent_item_id',rent_item_id,'invoice_status',invoice_status,
    'invoice_paid',invoice_paid,'invoice_revision',invoice_revision,'invoice_updated_at',invoice_updated_at,
    'invoice_total',invoice_total,'invoice_subtotal',invoice_subtotal
  );
END $$;

REVOKE ALL ON FUNCTION
  app_private.record_room_transfer_rent_v1(uuid,uuid,date,uuid,uuid,numeric,numeric,jsonb),
  app_private.room_transfer_first_month_v1(date,date),
  app_private.room_transfer_billing_period_v1(uuid,uuid,text,date,date),
  app_private.room_transfer_rent_amount_v1(uuid,uuid,date,date,date,numeric,numeric),
  app_private.room_transfer_rent_for_period_v1(uuid,uuid,date,date),
  app_private.room_transfer_sibling_rent_v1(uuid,uuid,text,date,date),
  app_private.quote_room_transfer_rent_v1(uuid,uuid,date,numeric)
FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
