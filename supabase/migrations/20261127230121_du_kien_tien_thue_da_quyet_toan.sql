CREATE OR REPLACE FUNCTION app_private.forecast_rent_span_v1(p_org uuid,p_contract uuid,p_from date,p_to date,p_rate numeric)
RETURNS numeric LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $body$
DECLARE rent numeric; next_old_rate numeric;
BEGIN
  -- Trong kỳ trả phòng, biên bản đã duyệt chốt tiền thuê và dư nợ bằng 0.
  -- Hóa đơn còn phải thu vẫn đi theo nhánh billed_items riêng.
  IF EXISTS (
    SELECT FROM public.contracts c
    JOIN public.contract_terminations t ON t.contract_id=c.id AND t.organization_id=c.organization_id
      AND t.actual_move_out_date=c.actual_end_date
    WHERE c.id=p_contract AND c.organization_id=p_org AND c.status='TERMINATED'
      AND c.actual_end_date>=p_to AND c.actual_end_date<(date_trunc('month',p_from)+interval '1 month')::date
      AND t.status='COMPLETED' AND t.approved_at IS NOT NULL
      AND t.prorated_rent=0 AND t.outstanding_debt=0
  ) THEN RETURN 0; END IF;

  rent := app_private.room_transfer_rent_for_period_v1(p_org,p_contract,p_from,p_to);
  IF rent IS NOT NULL THEN RETURN rent; END IF;
  -- Không suy giá hiện tại cho một lần chuyển cũ chưa có ảnh giá.
  IF EXISTS (SELECT FROM public.contract_transfers t WHERE t.contract_id=p_contract
    AND t.transfer_type IN ('ROOM_CHANGE','BOTH_CHANGE') AND t.status IN ('APPROVED','COMPLETED')
    AND coalesce(t.move_in_date,t.transfer_date) BETWEEN p_from AND p_to) THEN RETURN NULL; END IF;
  SELECT e.old_rent INTO next_old_rate FROM app_private.room_transfer_rent_events e
    WHERE e.organization_id=p_org AND e.contract_id=p_contract AND e.move_date>p_to ORDER BY e.move_date LIMIT 1;
  RETURN round(coalesce(next_old_rate,p_rate)*(p_to-p_from+1) /
    ((date_trunc('month',p_from)+interval '1 month')::date-date_trunc('month',p_from)::date));
EXCEPTION WHEN SQLSTATE '55000' THEN
  -- Helper hóa đơn yêu cầu đối chiếu thủ công, ví dụ giá thỏa thuận không tách được theo ngày.
  RETURN NULL;
END
$body$;
REVOKE ALL ON FUNCTION app_private.forecast_rent_span_v1(uuid,uuid,date,date,numeric) FROM PUBLIC,anon,authenticated,service_role;
