-- Chỉ đọc. Tổng theo kỳ dùng nguồn KQKD chung của quyết toán và lương theo nhóm của Profit Close.
CREATE OR REPLACE FUNCTION app_private.forecast_rent_span_v1(p_org uuid,p_contract uuid,p_from date,p_to date,p_rate numeric)
RETURNS numeric LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $body$
DECLARE rent numeric; next_old_rate numeric;
BEGIN
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

CREATE OR REPLACE FUNCTION app_private.forecast_house_report_v1(p_org uuid, p_house uuid, p_month date, p_detail boolean)
RETURNS TABLE(booked_income numeric, booked_cost numeric, pending_income numeric, pending_cost numeric,
  unpaid numeric, unbilled numeric, fixed_cost numeric, utility_cost numeric, unknown_fees text[], detail_lines jsonb)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $body$
WITH bounds AS (
  SELECT p_month AS start_day, (p_month + interval '1 month')::date AS next_day, to_char(p_month,'YYYY-MM') AS ym
), fee_history AS MATERIALIZED (
  SELECT l.*, v.invoice_id, v.name AS voucher_name FROM app_private.landlord_kqkd_lines_v2(p_house,(p_month-interval '1 month')::date,p_month) l
  JOIN public.income_expenses v ON v.id=l.voucher_id AND v.organization_id=p_org
), lines AS MATERIALIZED (
  SELECT * FROM fee_history WHERE month=p_month
), actual AS (
  SELECT coalesce(sum(amount) FILTER (WHERE side='INCOME' AND approval_status='APPROVED'),0) AS income,
    coalesce(sum(amount) FILTER (WHERE side='EXPENSE' AND approval_status='APPROVED'),0) AS cost,
    coalesce(sum(amount) FILTER (WHERE side='INCOME' AND approval_status='UNAPPROVED'),0) AS pending_in,
    coalesce(sum(amount) FILTER (WHERE side='EXPENSE' AND approval_status='UNAPPROVED'),0) AS pending_out
  FROM lines
), invoices AS MATERIALIZED (
  SELECT i.* FROM public.invoices i, bounds w WHERE i.organization_id=p_org AND i.building_id=p_house
    AND i.billing_month=w.ym AND i.deleted_at IS NULL AND i.status<>'CANCELLED'
), billed_items AS MATERIALIZED (
  -- subtotal là nghĩa vụ mới của tháng, loại cọc, NON_PNL, giảm giá và nợ chuyển từ tháng cũ.
  -- Chặn bởi số còn phải thu và phần doanh thu chưa ghi phiếu, kể cả phiếu đang chờ duyệt.
  SELECT i.room_id,i.invoice_number AS code,greatest(0,least(coalesce(i.remaining_amount,i.total_amount-i.paid_amount),
    i.subtotal-i.discount_amount-coalesce(items.non_pnl,0)-coalesce(booked.amount,0))) AS amount
  FROM invoices i
  LEFT JOIN LATERAL (SELECT sum(ii.amount) AS non_pnl FROM public.invoice_items ii
    WHERE ii.invoice_id=i.id AND ii.accounting_class IN ('DEPOSIT','NON_PNL')) items ON true
  LEFT JOIN LATERAL (SELECT sum(l.amount) AS amount FROM lines l WHERE l.invoice_id=i.id AND l.side='INCOME') booked ON true
  WHERE i.status<>'PAID'
), leases AS (
  SELECT c.id,c.rent_price,greatest(w.start_day,c.start_date,coalesce(c.start_billing_date,c.start_date)) AS first_day,
    least(w.next_day-1,coalesce(c.actual_end_date,least(c.expected_move_out_date,c.end_date))) AS last_day
  FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id, bounds w
  WHERE c.organization_id=p_org AND r.building_id=p_house AND c.deleted_at IS NULL
    AND c.status<>'DRAFT' AND c.signed_date <= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
    AND (c.status NOT IN ('TERMINATED','TRANSFERRED') OR c.actual_end_date IS NOT NULL)
), spans AS (
  SELECT c.*, daterange(c.first_day,c.last_day+1,'[)') AS days FROM leases c WHERE c.first_day<=c.last_day
), uncovered AS (
  -- Trừ đúng các ngày tiền phòng đã có hóa đơn, kể cả kỳ đầu vắt sang tháng sau.
  SELECT c.id,c.rent_price, part FROM spans c CROSS JOIN bounds w
  CROSS JOIN LATERAL (
    SELECT range_agg(CASE WHEN it.from_date IS NOT NULL AND it.to_date>=it.from_date THEN daterange(it.from_date,it.to_date+1,'[)')
      ELSE daterange(w.start_day,w.next_day,'[)') END) AS occupied
    FROM public.invoices i JOIN public.invoice_items it ON it.invoice_id=i.id AND it.type='RENT'
    WHERE i.organization_id=p_org AND i.contract_id=c.id AND i.deleted_at IS NULL AND i.status<>'CANCELLED'
      AND ((it.from_date IS NOT NULL AND it.to_date>=it.from_date AND it.from_date<=c.last_day AND it.to_date>=c.first_day)
        OR ((it.from_date IS NULL OR it.to_date IS NULL) AND i.billing_month=w.ym))
  ) taken
  CROSS JOIN LATERAL unnest(datemultirange(c.days)-coalesce(taken.occupied,'{}'::datemultirange)) part
  WHERE NOT EXISTS (SELECT FROM invoices i WHERE i.contract_id=c.id AND i.kind IN ('MONTHLY','FIRST')
    AND NOT EXISTS (SELECT FROM public.invoice_items ri WHERE ri.invoice_id=i.id AND ri.type='RENT'))
), rent_spans AS MATERIALIZED (
  SELECT u.id,app_private.forecast_rent_span_v1(p_org,u.id,lower(u.part),upper(u.part)-1,u.rent_price) AS amount
  FROM uncovered u
), rent_by_lease AS (
  SELECT id,sum(amount) AS rent,bool_or(amount IS NULL) AS needs_review FROM rent_spans GROUP BY id
), rent_items AS MATERIALIZED (
  SELECT c.room_id,r.needs_review OR coalesce(plan.state='NEEDS_REVIEW',false) AS needs_review,
    greatest(0,r.rent-CASE WHEN plan.id IS NOT NULL THEN coalesce(support.amount,0)
      WHEN jsonb_typeof(c.discounts->'months')='number' AND jsonb_typeof(c.discounts->'amount_per_month')='number'
        THEN CASE WHEN (SELECT count(*) FROM public.invoices i WHERE i.organization_id=p_org AND i.contract_id=c.id
          AND i.deleted_at IS NULL AND i.status<>'CANCELLED') < floor((c.discounts->>'months')::numeric)
          THEN greatest(0,(c.discounts->>'amount_per_month')::numeric) ELSE 0 END ELSE 0 END) AS amount
  FROM rent_by_lease r JOIN public.contracts c ON c.id=r.id AND c.organization_id=p_org CROSS JOIN bounds w
  LEFT JOIN LATERAL (SELECT p.id,p.state FROM app_private.contract_rent_support_plans p
    WHERE p.organization_id=p_org AND p.contract_id=c.id ORDER BY (p.state='ACTIVE') DESC,p.revision DESC LIMIT 1) plan ON true
  LEFT JOIN LATERAL (SELECT sum(m.agreed_amount) AS amount FROM app_private.contract_rent_support_months m
    WHERE m.organization_id=p_org AND m.contract_id=r.id AND m.billing_month=w.ym AND m.plan_id=plan.id AND plan.state='ACTIVE'
      AND NOT EXISTS (SELECT FROM app_private.rent_support_invoice_claims claim WHERE claim.organization_id=p_org
        AND claim.contract_id=r.id AND claim.billing_month=w.ym AND claim.released_at IS NULL)) support ON true
), fee_keys(key) AS (
  VALUES ('tien_nha'),('dien'),('nuoc'),('internet'),('quan_ly'),('ve_sinh'),('cong_an'),('rac'),('thang_may')
), costs AS (
  SELECT k.key,coalesce(nullif(f.default_amount,0),CASE WHEN k.key IN ('dien','nuoc') THEN matched.last_month END) AS default_amount,
    coalesce(matched.amount,0) AS actual
  FROM public.buildings b CROSS JOIN fee_keys k
  LEFT JOIN public.building_fee_accounts f ON f.building_id=b.id AND f.organization_id=p_org AND f.fee_category=k.key AND f.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT sum(l.amount) FILTER (WHERE l.month=p_month) AS amount,
      sum(l.amount) FILTER (WHERE l.month<p_month AND l.approval_status='APPROVED') AS last_month
    FROM fee_history l LEFT JOIN public.income_expense_types t ON t.id=l.type_id
    WHERE l.side='EXPENSE' AND (t.fee_category=k.key OR (t.fee_category IS NULL
      AND NOT EXISTS (SELECT FROM public.income_expense_types org_type WHERE org_type.organization_id=p_org AND org_type.fee_category=k.key)
      AND public.fee_type_matches(k.key,t.category,coalesce(t.name,l.voucher_name))))
  ) matched ON true
  WHERE b.id=p_house AND b.organization_id=p_org AND NOT(k.key=ANY(coalesce(b.hidden_fixed_expenses,'{}')))
    AND (k.key<>'thang_may' OR b.has_elevator)
    AND (k.key<>'tien_nha' OR NOT EXISTS (SELECT FROM app_private.landlord_operations op
      WHERE op.organization_id=p_org AND op.building_id=b.id AND op.is_active AND op.effective_from<=p_month))
), fee_items AS MATERIALIZED (
  SELECT key,default_amount,actual, CASE WHEN key IN ('dien','nuoc') THEN
    CASE WHEN actual=0 AND default_amount>0 THEN default_amount ELSE 0 END
    ELSE greatest(0,default_amount-actual) END AS amount FROM costs
), fees AS (
  SELECT coalesce(sum(amount) FILTER (WHERE key NOT IN ('dien','nuoc')),0) AS fixed,
    coalesce(sum(amount) FILTER (WHERE key IN ('dien','nuoc')),0) AS utilities,
    coalesce(array_agg(key ORDER BY key) FILTER (WHERE actual=0 AND coalesce(default_amount,0)<=0),'{}') AS missing
  FROM fee_items
), invoice_access AS MATERIALIZED (
  SELECT public.can_do_on_building('invoices','view',p_house) AS readable WHERE p_detail
), doc_access AS MATERIALIZED (
  SELECT d.voucher_id,app_private.ie_supplement_can_read_v1(d.voucher_id) AS readable
  FROM (SELECT DISTINCT voucher_id FROM lines WHERE p_detail) d
), voucher_rows AS MATERIALIZED (
  SELECT CASE WHEN l.side='INCOME' THEN
      CASE WHEN l.approval_status='APPROVED' THEN 'booked_income' ELSE 'pending_income' END
    ELSE CASE WHEN l.approval_status='APPROVED' THEN 'booked_cost' ELSE 'pending_cost' END END AS bucket,
    CASE WHEN coalesce(v.has_restricted_item,false) OR coalesce(t.is_restricted,false) THEN 'Hạng mục hạn chế'
         ELSE coalesce(nullif(t.name,''),'Khoản khác') END AS label,
    CASE WHEN access.readable THEN room.name END AS room,
    CASE WHEN access.readable THEN v.code END AS code,
    CASE WHEN access.readable THEN v.voucher_date END AS day,
    CASE WHEN access.readable AND NOT coalesce(v.has_restricted_item,false) AND NOT coalesce(t.is_restricted,false)
      AND l.side='EXPENSE' THEN nullif(v.name,'') END AS description,
    CASE WHEN l.side='INCOME' AND access.readable AND NOT coalesce(t.is_restricted,false) AND i.id IS NOT NULL
      AND (SELECT readable FROM invoice_access) AND public.income_voucher_splittable_v1(v.id) THEN i.id END AS split_invoice,
    l.amount
  FROM lines l JOIN public.income_expenses v ON v.id=l.voucher_id AND v.organization_id=p_org AND v.building_id=p_house
  JOIN doc_access access ON access.voucher_id=v.id
  LEFT JOIN public.income_expense_types t ON t.id=l.type_id AND t.organization_id=p_org
  LEFT JOIN public.invoices i ON i.id=l.invoice_id AND i.organization_id=p_org AND i.building_id=p_house AND i.deleted_at IS NULL
  LEFT JOIN public.rooms room ON room.id=coalesce(v.room_id,i.room_id) AND room.organization_id=p_org AND room.building_id=p_house
  WHERE p_detail
), documents AS (
  SELECT bucket,label,room,code,day,description,split_invoice,sum(amount) AS amount
  FROM voucher_rows GROUP BY bucket,label,room,code,day,description,split_invoice
), entries AS (
  SELECT bucket,label,room,code,day,description,amount,CASE WHEN split_invoice IS NOT NULL
    THEN public.invoice_amount_parts_for_v1(split_invoice,amount) END AS parts FROM documents
  UNION ALL
  SELECT 'unpaid','Hóa đơn còn phải thu',r.name,CASE WHEN (SELECT readable FROM invoice_access) THEN i.code END,NULL,NULL,sum(i.amount),NULL FROM billed_items i
    LEFT JOIN public.rooms r ON (SELECT readable FROM invoice_access) AND r.id=i.room_id AND r.organization_id=p_org AND r.building_id=p_house
    WHERE p_detail GROUP BY 3,4
  UNION ALL
  SELECT 'unbilled','Tiền phòng chưa lập hóa đơn',r.name,NULL,NULL,NULL,sum(i.amount),NULL FROM rent_items i
    LEFT JOIN public.rooms r ON (SELECT public.can_do_on_building('contracts','view',p_house))
      AND r.id=i.room_id AND r.organization_id=p_org AND r.building_id=p_house WHERE p_detail GROUP BY r.name
  UNION ALL
  SELECT CASE WHEN key IN ('dien','nuoc') THEN 'utility_cost' ELSE 'fixed_cost' END,key,NULL,NULL,NULL,NULL,amount,NULL
    FROM fee_items WHERE p_detail
)
SELECT a.income,a.cost,a.pending_in,a.pending_out,(SELECT coalesce(sum(amount),0) FROM billed_items),
  (SELECT coalesce(sum(amount),0) FROM rent_items),f.fixed,f.utilities,
  CASE WHEN EXISTS (SELECT FROM rent_items WHERE needs_review) THEN array_append(f.missing,'rent_needs_review') ELSE f.missing END,
  (SELECT coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(e)) ORDER BY e.bucket,e.room,e.day,e.code,e.label),'[]')
    FROM entries e WHERE e.amount<>0)
FROM actual a CROSS JOIN fees f;
$body$;
REVOKE ALL ON FUNCTION app_private.forecast_house_report_v1(uuid,uuid,date,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.can_manage_shareholder_forecast_v1(p_organization_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $body$
  SELECT auth.uid() IS NOT NULL AND coalesce(p_organization_id=ANY(public.my_org_ids()),false)
    AND (public.is_super_admin() OR app_private.ie_actor_is_company_owner_v1(p_organization_id,auth.uid()))
    AND app_private.profit_viewer_can_v1(p_organization_id,'shareholder_profit.manage_shareholders');
$body$;
REVOKE ALL ON FUNCTION public.can_manage_shareholder_forecast_v1(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.can_manage_shareholder_forecast_v1(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.shareholder_month_forecast_v1(p_organization_id uuid,p_month date,p_shareholder_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $body$
DECLARE me uuid; own_id uuid; viewer_name text; report jsonb; manager boolean; choices jsonb := '[]';
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(p_organization_id=ANY(public.my_org_ids()),false)
    OR NOT app_private.profit_viewer_can_v1(p_organization_id,'reports_finance.profit_distribution')
    OR NOT app_private.profit_viewer_can_v1(p_organization_id,'shareholder_profit.view_building_totals') THEN
    RAISE EXCEPTION 'Không có quyền xem báo cáo cổ đông' USING ERRCODE='42501';
  END IF;
  manager := public.can_manage_shareholder_forecast_v1(p_organization_id);
  SELECT s.id INTO own_id FROM public.shareholders s WHERE s.organization_id=p_organization_id AND s.auth_user_id=auth.uid()
    AND s.deleted_at IS NULL AND s.is_active;
  me := coalesce(p_shareholder_id,own_id);
  IF manager THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name) ORDER BY s.name,s.id),'[]') INTO choices
    FROM public.shareholders s WHERE s.organization_id=p_organization_id AND s.deleted_at IS NULL AND s.is_active;
    me := coalesce(me,(choices->0->>'id')::uuid);
  ELSIF me IS DISTINCT FROM own_id OR own_id IS NULL THEN
    RAISE EXCEPTION 'Không có quyền xem báo cáo cổ đông' USING ERRCODE='42501';
  END IF;
  SELECT name INTO viewer_name FROM public.shareholders s WHERE s.id=me AND s.organization_id=p_organization_id AND s.deleted_at IS NULL AND s.is_active;
  IF viewer_name IS NULL THEN RAISE EXCEPTION 'Không có hồ sơ cổ đông trong phạm vi xem' USING ERRCODE='42501'; END IF;
  IF p_month IS NULL OR NOT isfinite(p_month) OR p_month<>date_trunc('month',p_month)::date
    OR p_month>date_trunc('month',now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN
    RAISE EXCEPTION 'Chọn tháng hiện tại hoặc một tháng trước đó' USING ERRCODE='22023';
  END IF;
  WITH buildings AS MATERIALIZED (
    SELECT b.id,b.name,rooms.total_rooms,rooms.occupied_rooms,pm.id AS snapshot,pm.source_revenue,pm.source_expense,pm.adjusted_profit,pm.adjustment_amount,
      pm.management_salary,pm.house_pool_amount,rule.first_shareholder,rule.second_shareholder,
      rule.share_percent AS pool_percent,bs.percent AS my_percent,a.amount AS locked_share,
      CASE WHEN pm.id IS NOT NULL THEN a.id IS NOT NULL OR (me IN(rule.first_shareholder,rule.second_shareholder)
        AND EXISTS (SELECT FROM app_private.house_pool_contributions e WHERE e.rule_id=rule.id AND e.period_month=p_month))
        ELSE bs.percent>0 END AS visible
    FROM public.buildings b
    CROSS JOIN LATERAL (SELECT count(*) AS total_rooms,count(*) FILTER (WHERE r.status='OCCUPIED') AS occupied_rooms
      FROM public.rooms r WHERE r.organization_id=b.organization_id AND r.building_id=b.id AND r.deleted_at IS NULL) rooms
    LEFT JOIN public.profit_monthly pm ON pm.organization_id=b.organization_id AND pm.building_id=b.id AND pm.period_month=p_month AND pm.status='LOCKED'
    LEFT JOIN public.profit_allocations a ON a.profit_monthly_id=pm.id AND a.shareholder_id=me
    LEFT JOIN public.building_shareholders bs ON bs.organization_id=b.organization_id AND bs.building_id=b.id AND bs.shareholder_id=me
    LEFT JOIN LATERAL (SELECT r.* FROM app_private.house_pool_rules r WHERE r.organization_id=b.organization_id AND r.building_id=b.id
      AND r.from_month<=p_month ORDER BY r.from_month DESC LIMIT 1) rule ON true
    WHERE b.organization_id=p_organization_id AND NOT b.is_virtual AND b.deleted_at IS NULL
  ), salary_scope AS (
    -- Tính đủ nhóm lương điều hành trước khi lọc nhà được trả về người xem.
    SELECT DISTINCT other.building_id FROM public.profit_manager_salary_buildings own
    JOIN buildings b ON b.id=own.building_id AND b.visible AND b.snapshot IS NULL
    JOIN public.profit_manager_salaries s ON s.id=own.salary_id AND s.organization_id=p_organization_id AND s.basis='TOTAL_GROUP' AND s.is_active
    JOIN public.profit_manager_salary_buildings other ON other.salary_id=s.id AND other.organization_id=p_organization_id
    WHERE own.organization_id=p_organization_id
  ), inputs AS MATERIALIZED (
    SELECT b.id,x.* FROM buildings b
    CROSS JOIN LATERAL app_private.forecast_house_report_v1(p_organization_id,b.id,p_month,b.visible) x
    WHERE b.snapshot IS NULL AND (b.visible OR b.id IN (SELECT building_id FROM salary_scope))
  ), base AS MATERIALIZED (
    SELECT b.*,x.booked_income,x.booked_cost,x.pending_income,x.pending_cost,x.unpaid,x.unbilled,x.fixed_cost,x.utility_cost,x.unknown_fees,x.detail_lines,
      CASE WHEN b.snapshot IS NOT NULL THEN b.source_revenue ELSE x.booked_income+x.pending_income+x.unpaid+x.unbilled END AS revenue,
      CASE WHEN b.snapshot IS NOT NULL THEN b.source_expense ELSE x.booked_cost+x.pending_cost+x.fixed_cost+x.utility_cost END AS expense
    FROM buildings b LEFT JOIN inputs x ON x.id=b.id WHERE b.visible OR b.id IN (SELECT building_id FROM salary_scope)
  ), pnl AS MATERIALIZED (
    SELECT b.*,CASE WHEN snapshot IS NOT NULL THEN adjusted_profit ELSE revenue-expense END AS profit FROM base b
  ), salaries AS (
    SELECT a.building_id,sum(a.amount) AS salary FROM jsonb_to_recordset(public._profit_management_allocations_v2(
      p_organization_id,coalesce((SELECT jsonb_agg(jsonb_build_object('building_id',id,'base',profit)) FROM pnl),'[]')))
      AS a(building_id uuid,amount numeric) GROUP BY a.building_id
  ), sums AS MATERIALIZED (
    SELECT p.*,CASE WHEN snapshot IS NOT NULL THEN management_salary ELSE coalesce(s.salary,0) END AS salary
    FROM pnl p LEFT JOIN salaries s ON s.building_id=p.id WHERE p.visible
  ), raw AS (
    SELECT b.id,bs.shareholder_id,(b.profit-b.salary)*bs.percent/100 AS part
    FROM sums b JOIN public.building_shareholders bs ON bs.organization_id=p_organization_id AND bs.building_id=b.id
    JOIN public.shareholders sh ON sh.id=bs.shareholder_id AND sh.organization_id=p_organization_id AND sh.is_active AND sh.deleted_at IS NULL
    WHERE b.snapshot IS NULL
  ), ranked AS (
    -- Cùng luật chia phần dư đến từng đồng như Profit Close, cả khi lỗ.
    SELECT r.*,round(sum(part) OVER w)-sum(trunc(part)) OVER w AS remainder,
      row_number() OVER (PARTITION BY id ORDER BY abs(part-trunc(part)) DESC,shareholder_id) AS rank
    FROM raw r WINDOW w AS (PARTITION BY id)
  )
  SELECT jsonb_build_object('organization_id',p_organization_id,'shareholder_id',me,'name',viewer_name,'own',coalesce(me=own_id,false),
    'choices',choices,'month',p_month,'as_of',statement_timestamp(),
    'houses',coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'locked',s.snapshot IS NOT NULL,
      'total_rooms',s.total_rooms,'occupied_rooms',s.occupied_rooms,
      'revenue',s.revenue,'expense',s.expense,'profit',s.profit,'salary',s.salary,'adjustment',coalesce(s.adjustment_amount,0),
      'booked_income',CASE WHEN s.snapshot IS NOT NULL THEN s.source_revenue ELSE s.booked_income END,
      'booked_cost',CASE WHEN s.snapshot IS NOT NULL THEN s.source_expense ELSE s.booked_cost END,
      'pending_income',coalesce(s.pending_income,0),'pending_cost',coalesce(s.pending_cost,0),
      'unpaid',coalesce(s.unpaid,0),'unbilled',coalesce(s.unbilled,0),'fixed_cost',coalesce(s.fixed_cost,0),'utility_cost',coalesce(s.utility_cost,0),
      'detail_lines',CASE WHEN s.snapshot IS NULL THEN s.detail_lines ELSE hist.lines END,
      'unknown_fees',array_remove(coalesce(s.unknown_fees,'{}'),'rent_needs_review'),
      'rent_needs_review',coalesce('rent_needs_review'=ANY(s.unknown_fees),false),'share',
      CASE WHEN s.snapshot IS NOT NULL THEN coalesce(s.locked_share,0) WHEN me IN (s.first_shareholder,s.second_shareholder) THEN 0
           ELSE trunc(r.part)+CASE WHEN r.rank<=abs(r.remainder) THEN sign(r.remainder) ELSE 0 END END,
      'pool',CASE WHEN me IN(s.first_shareholder,s.second_shareholder) THEN CASE WHEN s.snapshot IS NOT NULL THEN s.house_pool_amount/2
             ELSE round((s.profit-s.salary)*s.pool_percent/100) END ELSE 0 END
    ) ORDER BY s.name,s.id),'[]'::jsonb)) INTO report
  FROM sums s LEFT JOIN ranked r ON r.id=s.id AND r.shareholder_id=me
  LEFT JOIN LATERAL (
    -- Chỉ hiển thị số theo hạng mục từ đúng lần chốt. Một số kỳ cũ chỉ lưu tổng.
    SELECT jsonb_agg(to_jsonb(z) ORDER BY z.bucket,z.label) AS lines
    FROM (
      SELECT CASE l.side WHEN 'INCOME' THEN 'booked_income' ELSE 'booked_cost' END AS bucket,
        CASE WHEN t.is_restricted OR v.has_restricted_item OR (l.type_id IS NOT NULL AND t.id IS NULL) THEN 'Hạng mục hạn chế'
          ELSE coalesce(nullif(l.type_name,''),'Khoản khác') END AS label,sum(l.amount) AS amount
      FROM public.profit_close_revisions rev JOIN public.profit_close_runs run ON run.id=rev.run_id
        AND run.organization_id=rev.organization_id AND run.period_month=rev.period_month
      CROSS JOIN LATERAL jsonb_to_recordset(CASE WHEN jsonb_typeof(run.source_snapshot->'accrual_lines')='array'
        THEN run.source_snapshot->'accrual_lines' ELSE '[]' END)
        AS l(building_id uuid,side text,type_id uuid,type_name text,amount numeric,voucher_id uuid)
      LEFT JOIN public.income_expense_types t ON t.id=l.type_id AND t.organization_id=p_organization_id
      LEFT JOIN public.income_expenses v ON v.id=l.voucher_id AND v.organization_id=p_organization_id
      WHERE rev.profit_monthly_id=s.snapshot AND rev.organization_id=p_organization_id AND rev.building_id=s.id
        AND rev.period_month=p_month AND rev.revision_number=(SELECT pm.revision_number FROM public.profit_monthly pm WHERE pm.id=s.snapshot)
        AND rev.operation IN ('CLOSE','RECLOSE') AND l.building_id=s.id AND l.side IN ('INCOME','EXPENSE')
      GROUP BY 1,2
    ) z
    HAVING coalesce(sum(z.amount) FILTER (WHERE z.bucket='booked_cost'),0)=s.source_expense
       AND coalesce(sum(z.amount) FILTER (WHERE z.bucket='booked_income'),0)=s.source_revenue
  ) hist ON s.snapshot IS NOT NULL;
  RETURN report;
END
$body$;
REVOKE ALL ON FUNCTION public.shareholder_month_forecast_v1(uuid,date,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.shareholder_month_forecast_v1(uuid,date,uuid) TO authenticated;
