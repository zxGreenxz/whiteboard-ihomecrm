-- Phần lợi nhuận góp có dấu. Tiền hoàn dùng một phiếu cho cả đợt.
CREATE TABLE IF NOT EXISTS app_private.house_pool_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  building_id uuid NOT NULL REFERENCES public.buildings(id),
  first_shareholder uuid NOT NULL,
  second_shareholder uuid NOT NULL,
  share_percent numeric(5,2) NOT NULL CHECK (share_percent > 0 AND share_percent < 50),
  retained_percent numeric(5,2) NOT NULL CHECK (retained_percent >= 0 AND 2*share_percent+retained_percent <= 100),
  from_month date NOT NULL CHECK (extract(day from from_month) = 1),
  automatic_from date NOT NULL CHECK (automatic_from >= from_month AND extract(day from automatic_from)=1),
  baseline_revision uuid REFERENCES public.profit_close_revisions(id),
  activated_by uuid NOT NULL,
  UNIQUE (organization_id, building_id, from_month),
  CHECK (first_shareholder <> second_shareholder),
  FOREIGN KEY (first_shareholder,organization_id) REFERENCES public.shareholders(id,organization_id),
  FOREIGN KEY (second_shareholder,organization_id) REFERENCES public.shareholders(id,organization_id)
);

ALTER TABLE public.profit_monthly ADD COLUMN IF NOT EXISTS house_pool_amount bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS app_private.house_pool_contributions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id uuid NOT NULL REFERENCES app_private.house_pool_rules(id),
  period_month date NOT NULL,
  revision_id uuid NOT NULL REFERENCES public.profit_close_revisions(id),
  reason text NOT NULL CHECK (reason IN ('IMPORT','CLOSE','RECLOSE','UNLOCK','RESET')),
  amount_each bigint NOT NULL,
  amount_each_after bigint NOT NULL,
  retained_amount numeric NOT NULL,
  original_allocation jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (rule_id,revision_id)
);

CREATE TABLE IF NOT EXISTS app_private.house_pool_openings (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id),
  source_id uuid NOT NULL UNIQUE REFERENCES app_private.shared_fund_entries(id),
  transfer_id uuid NOT NULL UNIQUE REFERENCES app_private.shared_fund_entries(id),
  first_shareholder uuid NOT NULL,
  second_shareholder uuid NOT NULL,
  amount_each bigint NOT NULL CHECK (amount_each>0),
  CHECK (first_shareholder<>second_shareholder),
  FOREIGN KEY (first_shareholder,organization_id) REFERENCES public.shareholders(id,organization_id),
  FOREIGN KEY (second_shareholder,organization_id) REFERENCES public.shareholders(id,organization_id)
);
ALTER TABLE app_private.house_pool_openings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.house_pool_openings FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE IF NOT EXISTS app_private.house_pool_activations (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  actor_id uuid NOT NULL, request_key uuid NOT NULL, payload jsonb NOT NULL, receipt jsonb NOT NULL,
  PRIMARY KEY(organization_id,actor_id,request_key)
);
ALTER TABLE app_private.house_pool_activations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.house_pool_activations FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE IF NOT EXISTS app_private.house_pool_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  actor_id uuid NOT NULL,
  request_key uuid NOT NULL,
  fraction_bps integer NOT NULL CHECK (fraction_bps BETWEEN 1 AND 10000),
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  voucher_date date NOT NULL,
  voucher_id uuid NOT NULL UNIQUE REFERENCES public.income_expenses(id),
  total_amount bigint NOT NULL CHECK (total_amount > 0),
  preview_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,actor_id,request_key),
  UNIQUE (id,organization_id)
);

CREATE TABLE IF NOT EXISTS app_private.house_pool_return_lines (
  batch_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  shareholder_id uuid NOT NULL,
  balance_before bigint NOT NULL CHECK (balance_before > 0),
  amount bigint NOT NULL CHECK (amount > 0 AND amount <= balance_before),
  PRIMARY KEY(batch_id,shareholder_id),
  FOREIGN KEY (batch_id,organization_id) REFERENCES app_private.house_pool_returns(id,organization_id),
  FOREIGN KEY (shareholder_id,organization_id) REFERENCES public.shareholders(id,organization_id)
);

ALTER TABLE app_private.house_pool_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.house_pool_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.house_pool_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.house_pool_return_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.house_pool_rules,app_private.house_pool_contributions,app_private.house_pool_returns,
  app_private.house_pool_return_lines FROM PUBLIC,anon,authenticated,service_role;

DO $protect$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['house_pool_rules','house_pool_contributions','house_pool_returns','house_pool_return_lines','house_pool_openings','house_pool_activations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS house_pool_immutable ON app_private.%I',relation);
    EXECUTE format('CREATE TRIGGER house_pool_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON app_private.%I FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_profit_ledger_append_only_v1()',relation);
  END LOOP;
END
$protect$;

-- Một phép tính dùng cho preview, chốt và đối chiếu lịch sử.
CREATE OR REPLACE FUNCTION app_private.house_pool_split_v1(
  rule app_private.house_pool_rules, allocations jsonb, basis numeric, require_both boolean DEFAULT true
) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path TO pg_catalog AS $fn$
DECLARE
  others jsonb;
  other_percent numeric;
  other_amount numeric;
  amount_each bigint;
  member_count integer;
  locked_each numeric;
BEGIN
  IF allocations IS NULL OR basis IS NULL OR jsonb_typeof(allocations) <> 'array' THEN
    RAISE EXCEPTION 'Thiếu nguồn lợi nhuận cần phân bổ' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(allocations) a(shareholder_id uuid, percent numeric)
              WHERE a.shareholder_id IN (rule.first_shareholder,rule.second_shareholder)
                AND a.percent <> rule.share_percent) THEN
    RAISE EXCEPTION 'Tỷ lệ người góp ở nhà đã đổi, cần đối chiếu lại quy tắc' USING ERRCODE='PT409';
  END IF;
  SELECT count(DISTINCT a.shareholder_id),min(a.amount) INTO member_count,locked_each
    FROM jsonb_to_recordset(allocations) a(shareholder_id uuid,amount numeric,percent numeric)
    WHERE a.shareholder_id IN (rule.first_shareholder,rule.second_shareholder) AND a.percent=rule.share_percent;
  IF member_count < (CASE WHEN require_both THEN 2 ELSE 1 END) THEN
    RAISE EXCEPTION 'Thiếu tỷ lệ của người góp trong kỳ lợi nhuận' USING ERRCODE='PT409';
  END IF;
  SELECT coalesce(jsonb_agg(item ORDER BY item->>'shareholder_id'),'[]'),coalesce(sum((item->>'percent')::numeric),0),
         coalesce(sum((item->>'amount')::numeric),0)
    INTO others,other_percent,other_amount FROM jsonb_array_elements(allocations) item
    WHERE (item->>'shareholder_id')::uuid NOT IN (rule.first_shareholder,rule.second_shareholder);
  IF other_percent + 2*rule.share_percent + rule.retained_percent <> 100 THEN
    RAISE EXCEPTION 'Tỷ lệ cổ đông khác, phần gom và phần giữ riêng chưa đủ 100%%' USING ERRCODE='PT409';
  END IF;
  amount_each := CASE WHEN NOT require_both AND member_count=1 THEN locked_each ELSE round(basis * rule.share_percent / 100) END;
  RETURN jsonb_build_object('shareholder_allocations',others,'shareholder_percent_total',other_percent,
    'shareholder_allocated_amount',other_amount,'house_pool_amount',2*amount_each,'house_pool_each',amount_each,
    'unallocated_profit',basis-other_amount-2*amount_each);
END
$fn$;
REVOKE ALL ON FUNCTION app_private.house_pool_split_v1(app_private.house_pool_rules,jsonb,numeric,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- Wrapper V3 trước đây áp lại snapshot cũ kể cả khi writer trả biên nhận của lần chốt trước.
DO $replay$
DECLARE definition text := pg_get_functiondef('public._profit_write_close_v2(text,uuid,date,text,text,text,uuid[],jsonb)'::regprocedure);
        anchor text := '  v_run_id := NULLIF(v_result->>''run_id'', '''')::uuid;';
        guard text := '  IF (v_result->>''idempotent_replay'')::boolean THEN RETURN public._profit_enrich_unallocated_v3(v_result,p_adjustments); END IF;';
BEGIN
  IF strpos(definition,guard)=0 THEN
    IF strpos(definition,anchor)=0 THEN RAISE EXCEPTION 'Thân hàm chốt kỳ đã thay đổi, cần đối chiếu trước khi áp dụng'; END IF;
    EXECUTE replace(definition,anchor,guard||chr(10)||anchor);
  END IF;
END
$replay$;

-- Giữ một bản nguyên của lõi đang triển khai khi chạy forward lane lại.
DO $wrap$
BEGIN
  IF to_regprocedure('app_private.profit_preview_before_house_pool_v1(uuid,date,uuid[],jsonb,text,boolean)') IS NULL THEN
    ALTER FUNCTION public._profit_close_preview_core_v2(uuid,date,uuid[],jsonb,text,boolean) SET SCHEMA app_private;
    ALTER FUNCTION app_private._profit_close_preview_core_v2(uuid,date,uuid[],jsonb,text,boolean) RENAME TO profit_preview_before_house_pool_v1;
  END IF;
END
$wrap$;
REVOKE ALL ON FUNCTION app_private.profit_preview_before_house_pool_v1(uuid,date,uuid[],jsonb,text,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public._profit_close_preview_core_v2(p_organization_id uuid,p_period_month date,
  p_building_ids uuid[],p_adjustments jsonb,p_permission_key text,p_lock_sources boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
DECLARE
  doc jsonb;
  rows jsonb := '[]';
  row_data jsonb;
  rule app_private.house_pool_rules;
  split jsonb;
  rules_used jsonb := '[]';
BEGIN
  IF p_lock_sources THEN
    PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  END IF;
  doc := app_private.profit_preview_before_house_pool_v1(p_organization_id,p_period_month,p_building_ids,p_adjustments,p_permission_key,p_lock_sources);
  FOR row_data IN SELECT value FROM jsonb_array_elements(doc->'buildings') LOOP
    SELECT * INTO rule FROM app_private.house_pool_rules
      WHERE organization_id=p_organization_id AND building_id=(row_data->>'building_id')::uuid AND from_month<=p_period_month ORDER BY from_month DESC LIMIT 1;
    IF FOUND THEN
      IF rule.from_month=p_period_month AND rule.baseline_revision IS NOT NULL THEN
        SELECT jsonb_build_object('shareholder_allocations',coalesce((SELECT jsonb_agg(jsonb_build_object(
            'shareholder_id',a.shareholder_id,'shareholder_name',s.name,'amount',a.amount,'percent',a.percent) ORDER BY a.shareholder_id)
            FROM public.profit_allocations a JOIN public.shareholders s ON s.id=a.shareholder_id
            WHERE a.profit_monthly_id=pm.id AND a.shareholder_id NOT IN(rule.first_shareholder,rule.second_shareholder)),'[]'),
          'shareholder_percent_total',pm.shareholder_percent_total,'shareholder_allocated_amount',pm.shareholder_allocated_amount,
          'house_pool_amount',pm.house_pool_amount,'house_pool_each',pm.house_pool_amount/2,'unallocated_profit',pm.unallocated_profit,
          'distributable_profit',pm.adjusted_profit-pm.management_salary,'computed_profit',pm.computed_profit,'management_salary',pm.management_salary,
          'adjusted_profit',pm.adjusted_profit)
          INTO STRICT split FROM public.profit_monthly pm WHERE pm.organization_id=p_organization_id AND pm.building_id=rule.building_id AND pm.period_month=p_period_month;
      ELSE
        split := app_private.house_pool_split_v1(rule,row_data->'shareholder_allocations',(row_data->>'distributable_profit')::numeric);
      END IF;
      row_data := row_data || split;
      IF jsonb_typeof(row_data->'current_snapshot')='object' THEN
        row_data := jsonb_set(row_data,'{current_snapshot,house_pool_amount}',coalesce(
          (SELECT to_jsonb(pm.house_pool_amount) FROM public.profit_monthly pm WHERE pm.id=(row_data->'current_snapshot'->>'id')::uuid AND pm.organization_id=p_organization_id),'0'));
      END IF;
      rules_used := rules_used || jsonb_build_array(rule.id);
    END IF;
    rows := rows || jsonb_build_array(row_data);
  END LOOP;
  IF rules_used='[]'::jsonb THEN RETURN doc; END IF;
  doc := jsonb_set(doc,'{buildings}',rows);
  doc := jsonb_set(doc,'{totals}',(doc->'totals') || (SELECT jsonb_build_object(
     'shareholder_allocated_amount',sum((b->>'shareholder_allocated_amount')::numeric),
     'unallocated_profit',sum((b->>'unallocated_profit')::numeric),'house_pool_amount',coalesce(sum((b->>'house_pool_amount')::numeric),0))
     FROM jsonb_array_elements(rows) b));
  RETURN jsonb_set(doc,'{source_hash}',to_jsonb(md5((doc->>'source_hash')||rules_used::text)));
END
$fn$;
REVOKE ALL ON FUNCTION public._profit_close_preview_core_v2(uuid,date,uuid[],jsonb,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public._profit_close_preview_core_v2(uuid,date,uuid[],jsonb,text,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public._profit_enrich_state_v3(p_document jsonb)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
  SELECT jsonb_set(coalesce(p_document,'{}'),'{rows}',coalesce((
    SELECT jsonb_agg(row_data || jsonb_build_object(
      'shareholder_percent_total',pm.shareholder_percent_total,'shareholder_allocated_amount',pm.shareholder_allocated_amount,
      'unallocated_profit',pm.unallocated_profit,'unallocated_disposition',pm.unallocated_disposition,
      'unallocated_disposition_reason',pm.unallocated_disposition_reason,'house_pool_amount',pm.house_pool_amount
    ) ORDER BY ord) FROM jsonb_array_elements(p_document->'rows') WITH ORDINALITY x(row_data,ord)
    LEFT JOIN public.profit_monthly pm ON pm.id=(row_data->>'id')::uuid
  ),'[]'))
$fn$;
REVOKE ALL ON FUNCTION public._profit_enrich_state_v3(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public._profit_enrich_state_v3(jsonb) TO service_role;

CREATE OR REPLACE VIEW app_private.house_pool_batch_status WITH (security_invoker=true) AS
 SELECT b.*, CASE
    WHEN v.posting_status='POSTED' AND v.active_posting_id_v2 IS NOT NULL THEN 'PAID'
    WHEN v.posting_status='REVERSED' OR NOT app_private.profit_ledger_voucher_live_v1(v.id) THEN 'RELEASED'
    ELSE 'RESERVED' END AS state
 FROM app_private.house_pool_returns b JOIN public.income_expenses v ON v.id=b.voucher_id AND v.organization_id=b.organization_id;

CREATE OR REPLACE FUNCTION app_private.house_pool_positions_v1(p_org uuid)
RETURNS TABLE(shareholder_id uuid,contributed bigint,reserved bigint,paid bigint,available bigint)
LANGUAGE sql STABLE SET search_path TO pg_catalog AS $fn$
 WITH entries AS (
   SELECT member.id,coalesce(sum(e.amount_each),0)::bigint AS amount
     FROM app_private.house_pool_rules r CROSS JOIN LATERAL (VALUES(r.first_shareholder),(r.second_shareholder)) member(id)
     JOIN app_private.house_pool_contributions e ON e.rule_id=r.id
    WHERE r.organization_id=p_org GROUP BY member.id
   UNION ALL
   SELECT member.id,o.amount_each FROM app_private.house_pool_openings o
   CROSS JOIN LATERAL (VALUES(o.first_shareholder),(o.second_shareholder)) member(id)
   WHERE o.organization_id=p_org
 ), contributions AS (SELECT id,sum(amount)::bigint AS amount FROM entries GROUP BY id), returns AS (
   SELECT l.shareholder_id, coalesce(sum(l.amount) FILTER (WHERE b.state='RESERVED'),0)::bigint AS reserved,
     coalesce(sum(l.amount) FILTER (WHERE b.state='PAID'),0)::bigint AS paid
     FROM app_private.house_pool_return_lines l JOIN app_private.house_pool_batch_status b ON b.id=l.batch_id AND b.organization_id=l.organization_id
     WHERE l.organization_id=p_org GROUP BY l.shareholder_id
 )
 SELECT c.id,c.amount,coalesce(r.reserved,0),coalesce(r.paid,0),c.amount-coalesce(r.reserved,0)-coalesce(r.paid,0)
   FROM contributions c LEFT JOIN returns r ON r.shareholder_id=c.id ORDER BY c.id
$fn$;
REVOKE ALL ON app_private.house_pool_batch_status FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION app_private.house_pool_positions_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- R2 giữ nguyên kiểm quyền và danh tính cổ đông của RPC cũ.
DO $self$
BEGIN
  IF to_regprocedure('app_private.profit_my_position_before_house_pool_v1(uuid)') IS NULL THEN
    ALTER FUNCTION public.shareholder_profit_my_position_v1(uuid) SET SCHEMA app_private;
    ALTER FUNCTION app_private.shareholder_profit_my_position_v1(uuid) RENAME TO profit_my_position_before_house_pool_v1;
  END IF;
END
$self$;
REVOKE ALL ON FUNCTION app_private.profit_my_position_before_house_pool_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.shareholder_profit_my_position_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
DECLARE doc jsonb; own_position jsonb;
BEGIN
  doc := app_private.profit_my_position_before_house_pool_v1(p_organization_id);
  SELECT to_jsonb(p)-'shareholder_id' INTO own_position FROM app_private.house_pool_positions_v1(p_organization_id) p
   WHERE p.shareholder_id=(doc->'shareholder'->>'id')::uuid;
  RETURN doc||jsonb_build_object('house_pool',own_position);
END
$fn$;
REVOKE ALL ON FUNCTION public.shareholder_profit_my_position_v1(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.shareholder_profit_my_position_v1(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION app_private.house_pool_capture_revision_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
DECLARE
  rule app_private.house_pool_rules;
  pm public.profit_monthly;
  previous_each bigint;
  next_each bigint := 0;
  retained numeric := 0;
BEGIN
  SELECT * INTO rule FROM app_private.house_pool_rules
   WHERE organization_id=NEW.organization_id AND building_id=NEW.building_id AND from_month<=NEW.period_month ORDER BY from_month DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF rule.from_month=NEW.period_month AND rule.baseline_revision IS NOT NULL THEN
    RAISE EXCEPTION 'Kỳ lịch sử đã gom theo bản chốt gốc. Không thể thay thế bản chốt đó' USING ERRCODE='PT409';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(rule.organization_id);
  SELECT coalesce(sum(amount_each),0)::bigint INTO previous_each FROM app_private.house_pool_contributions
   WHERE rule_id=rule.id AND period_month=NEW.period_month;
  IF NEW.operation IN ('CLOSE','RECLOSE') THEN
    SELECT * INTO STRICT pm FROM public.profit_monthly WHERE id=NEW.profit_monthly_id AND organization_id=rule.organization_id AND status='LOCKED';
    next_each := round((pm.adjusted_profit-pm.management_salary)*rule.share_percent/100);
    retained := pm.adjusted_profit-pm.management_salary-2*next_each-
      (SELECT coalesce(sum(a.amount),0) FROM public.profit_allocations a WHERE a.profit_monthly_id=pm.id);
  ELSIF NEW.operation NOT IN ('UNLOCK','RESET') THEN
    RAISE EXCEPTION 'Thao tác kỳ lợi nhuận chưa được hỗ trợ cho nhà gom quỹ' USING ERRCODE='22023';
  END IF;
  UPDATE public.profit_monthly SET house_pool_amount=2*next_each WHERE id=NEW.profit_monthly_id AND organization_id=rule.organization_id
    AND house_pool_amount<>2*next_each;
  IF NEW.operation<>'CLOSE' AND next_each<previous_each AND EXISTS(
     SELECT 1 FROM app_private.house_pool_positions_v1(rule.organization_id) p
      WHERE p.shareholder_id IN (rule.first_shareholder,rule.second_shareholder)
      AND p.reserved+p.paid>0 AND p.available+next_each-previous_each<0) THEN
    RAISE EXCEPTION 'Nguồn kỳ này đã dùng để hoàn quỹ. Đối chiếu hoặc đảo phiếu trước khi sửa kỳ' USING ERRCODE='PT409';
  END IF;
  INSERT INTO app_private.house_pool_contributions(rule_id,period_month,revision_id,reason,amount_each,amount_each_after,retained_amount)
   VALUES(rule.id,NEW.period_month,NEW.id,NEW.operation,next_each-previous_each,next_each,retained);
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.house_pool_capture_revision_v1() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS house_pool_capture_revision ON public.profit_close_revisions;
CREATE TRIGGER house_pool_capture_revision AFTER INSERT ON public.profit_close_revisions
 FOR EACH ROW EXECUTE FUNCTION app_private.house_pool_capture_revision_v1();

CREATE OR REPLACE FUNCTION public.house_pool_activate_v1(p_organization_id uuid,p_partner uuid,p_rules jsonb,
  p_history_from date,p_automatic_from date,p_opening_id uuid DEFAULT NULL,p_request_key uuid DEFAULT gen_random_uuid())
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
DECLARE
  actor uuid := auth.uid();
  owner_holder uuid;
  item record;
  rule app_private.house_pool_rules;
  month_row public.profit_monthly;
  original jsonb;
  split jsonb;
  revision public.profit_close_revisions;
  import_rule app_private.house_pool_rules;
  opening app_private.shared_fund_entries;
  transfer jsonb;
  activation app_private.house_pool_activations;
  payload jsonb := jsonb_build_array(p_partner,p_rules,p_history_from,p_automatic_from,p_opening_id);
  receipt jsonb;
  imported integer := 0;
  removed numeric;
  member uuid;
  pos jsonb;
BEGIN
  IF app_private.shared_fund_owner_v1(p_organization_id) IS NULL THEN RAISE EXCEPTION 'Chỉ chủ công ty được kích hoạt gom quỹ' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  IF app_private.shared_fund_owner_v1(p_organization_id) IS NULL THEN RAISE EXCEPTION 'Quyền chủ công ty đã thay đổi' USING ERRCODE='42501'; END IF;
  PERFORM app_private.profit_ledger_tao_assert_route_v1(p_organization_id,ARRAY['CANONICAL']);
  IF p_rules IS NULL OR jsonb_typeof(p_rules)<>'array' OR jsonb_array_length(p_rules) NOT BETWEEN 1 AND 100
    OR p_history_from IS NULL OR p_automatic_from IS NULL OR extract(day from p_history_from)<>1
    OR extract(day from p_automatic_from)<>1 OR p_automatic_from<p_history_from OR p_history_from < p_automatic_from-interval '5 years' THEN
    RAISE EXCEPTION 'Kiểm tra danh sách nhà và kỳ bắt đầu gom quỹ' USING ERRCODE='22023';
  END IF;
  IF p_request_key IS NULL THEN RAISE EXCEPTION 'Thiếu mã yêu cầu kích hoạt' USING ERRCODE='22023'; END IF;
  SELECT * INTO activation FROM app_private.house_pool_activations WHERE organization_id=p_organization_id AND actor_id=actor AND request_key=p_request_key;
  IF FOUND THEN
    IF activation.payload<>payload THEN RAISE EXCEPTION 'Mã kích hoạt đã dùng cho cấu hình khác' USING ERRCODE='PT409'; END IF;
    RETURN activation.receipt;
  END IF;
  SELECT s.id INTO owner_holder FROM public.shareholders s WHERE s.organization_id=p_organization_id AND s.auth_user_id=actor AND s.is_active AND s.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cần liên kết hồ sơ cổ đông của chủ công ty trong đúng công ty trước khi gom quỹ' USING ERRCODE='PT409';
  END IF;
  IF p_partner IS NULL OR p_partner=owner_holder OR NOT EXISTS(
     SELECT 1 FROM public.shareholders s WHERE s.id=p_partner AND s.organization_id=p_organization_id AND s.auth_user_id IS NOT NULL AND s.is_active AND s.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Người cùng góp phải là cổ đông đã liên kết trong công ty' USING ERRCODE='22023';
  END IF;
  -- Cùng thứ tự khoá khi hoàn và khi ghi nguồn.
  FOR member IN SELECT unnest(ARRAY[owner_holder,p_partner]) ORDER BY 1 LOOP
    PERFORM app_private.profit_ledger_lock_v1(p_organization_id,'SHAREHOLDER',member);
  END LOOP;
  IF (SELECT count(DISTINCT x.building_id) FROM jsonb_to_recordset(p_rules) x(building_id uuid))<>jsonb_array_length(p_rules) THEN
    RAISE EXCEPTION 'Mỗi nhà phải xuất hiện đúng một lần' USING ERRCODE='22023';
  END IF;
  FOR item IN SELECT * FROM jsonb_to_recordset(p_rules) AS r(building_id uuid,share_percent numeric,retained_percent numeric,baseline_revision uuid) ORDER BY building_id LOOP
    IF NOT EXISTS(SELECT 1 FROM public.buildings WHERE id=item.building_id AND organization_id=p_organization_id AND deleted_at IS NULL AND NOT is_virtual)
       OR NOT coalesce((SELECT allowed FROM app_private.authorize_tenant_action_v3(actor,p_organization_id,'shareholder_profit.lock',item.building_id,NULL)),false) THEN
      RAISE EXCEPTION 'Nhà ngoài phạm vi chốt lợi nhuận' USING ERRCODE='42501';
    END IF;
    IF item.share_percent IS NULL OR item.share_percent<>round(item.share_percent,2) OR item.retained_percent IS NULL OR item.retained_percent<>round(item.retained_percent,2) THEN
      RAISE EXCEPTION 'Tỷ lệ phải có nhiều nhất hai chữ số thập phân' USING ERRCODE='22023';
    END IF;
    SELECT * INTO rule FROM app_private.house_pool_rules WHERE organization_id=p_organization_id AND building_id=item.building_id AND from_month=p_history_from;
    IF FOUND THEN
      IF (rule.first_shareholder,rule.second_shareholder,rule.share_percent,rule.retained_percent,rule.from_month,rule.automatic_from,rule.baseline_revision)
          IS DISTINCT FROM (owner_holder,p_partner,item.share_percent,item.retained_percent,p_history_from,p_automatic_from,item.baseline_revision) THEN
        RAISE EXCEPTION 'Quy tắc đã lưu khác nội dung yêu cầu' USING ERRCODE='PT409';
      END IF;
      CONTINUE;
    END IF;
    IF EXISTS(SELECT 1 FROM app_private.house_pool_rules r WHERE r.organization_id=p_organization_id AND r.building_id=item.building_id)
       AND (p_history_from<>p_automatic_from OR item.baseline_revision IS NOT NULL OR p_opening_id IS NOT NULL
            OR EXISTS(SELECT 1 FROM app_private.house_pool_rules r WHERE r.organization_id=p_organization_id AND r.building_id=item.building_id AND r.from_month>=p_history_from)
            OR EXISTS(SELECT 1 FROM public.profit_monthly pm WHERE pm.organization_id=p_organization_id AND pm.building_id=item.building_id AND pm.period_month>=p_history_from AND pm.status='LOCKED')) THEN
      RAISE EXCEPTION 'Phiên bản tỷ lệ mới chỉ bắt đầu từ kỳ chưa chốt sau phiên bản trước' USING ERRCODE='PT409';
    END IF;
    IF item.baseline_revision IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM public.profit_close_revisions v WHERE v.id=item.baseline_revision AND v.organization_id=p_organization_id
       AND v.building_id=item.building_id AND v.period_month=p_history_from AND v.operation='BASELINE' AND p_history_from<p_automatic_from
    ) THEN RAISE EXCEPTION 'Bản chốt lịch sử của nhà không khớp' USING ERRCODE='PT409'; END IF;
    INSERT INTO app_private.house_pool_rules(organization_id,building_id,first_shareholder,second_shareholder,share_percent,retained_percent,from_month,automatic_from,baseline_revision,activated_by)
     VALUES(p_organization_id,item.building_id,owner_holder,p_partner,item.share_percent,item.retained_percent,p_history_from,p_automatic_from,item.baseline_revision,actor) RETURNING * INTO rule;
    IF EXISTS(SELECT 1 FROM generate_series(p_history_from,p_automatic_from-interval '1 month',interval '1 month') g(month)
      WHERE NOT EXISTS(SELECT 1 FROM public.profit_monthly pm WHERE pm.organization_id=p_organization_id AND pm.building_id=rule.building_id
                       AND pm.period_month=g.month::date AND pm.status='LOCKED')) THEN
      RAISE EXCEPTION 'Có kỳ lịch sử chưa chốt. Đối chiếu lại trước khi gom' USING ERRCODE='PT409';
    END IF;
    FOR month_row IN SELECT * FROM public.profit_monthly WHERE organization_id=p_organization_id AND building_id=rule.building_id
       AND period_month>=p_history_from AND status='LOCKED' ORDER BY period_month FOR UPDATE LOOP
      SELECT * INTO STRICT revision FROM public.profit_close_revisions WHERE organization_id=p_organization_id AND building_id=rule.building_id AND
        period_month=month_row.period_month AND profit_monthly_id=month_row.id ORDER BY revision_number DESC,created_at DESC,id DESC LIMIT 1;
      IF (month_row.is_stale AND revision.id IS DISTINCT FROM rule.baseline_revision)
        OR (month_row.period_month=p_history_from AND rule.baseline_revision IS NOT NULL AND revision.id<>rule.baseline_revision) OR EXISTS(
        SELECT 1 FROM public.profit_payout_reservations pr JOIN public.profit_allocations a ON a.id=pr.profit_allocation_id
        WHERE a.profit_monthly_id=month_row.id AND a.shareholder_id IN(owner_holder,p_partner) AND pr.reservation_state NOT IN ('RELEASED','REVERSED')) THEN
        RAISE EXCEPTION 'Kỳ % có số liệu cần chốt lại hoặc đã gắn khoản chi',month_row.period_month USING ERRCODE='PT409';
      END IF;
      SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'shareholder_id',shareholder_id,'amount',amount,'percent',percent) ORDER BY shareholder_id),'[]') INTO original
        FROM public.profit_allocations WHERE profit_monthly_id=month_row.id;
      import_rule := rule;
      IF revision.id=rule.baseline_revision THEN
        IF (revision.current_snapshot->>'adjusted_profit')::numeric IS DISTINCT FROM month_row.adjusted_profit
          OR (revision.current_snapshot->>'management_salary')::numeric IS DISTINCT FROM month_row.management_salary
          OR original IS DISTINCT FROM (SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'shareholder_id',a.shareholder_id,'amount',a.amount,'percent',a.percent)
                ORDER BY a.shareholder_id),'[]') FROM jsonb_to_recordset(revision.shareholder_allocations) a(id uuid,shareholder_id uuid,amount numeric,percent numeric)) THEN
          RAISE EXCEPTION 'Số liệu lưu ở bản chốt cũ khác sổ phân bổ hiện tại' USING ERRCODE='PT409';
        END IF;
        import_rule.retained_percent := 0;
      END IF;
      split := app_private.house_pool_split_v1(import_rule,original,month_row.adjusted_profit-month_row.management_salary,month_row.period_month>=rule.automatic_from);
      FOR member IN SELECT unnest(ARRAY[owner_holder,p_partner]) LOOP
        SELECT coalesce(sum(amount),0) INTO removed FROM public.profit_allocations WHERE profit_monthly_id=month_row.id AND shareholder_id=member;
        IF removed<>0 THEN
          pos := app_private.profit_ledger_position_v1(p_organization_id,member);
          IF EXISTS(SELECT 1 FROM app_private.profit_ledger_markers WHERE organization_id=p_organization_id AND shareholder_id=member AND settled_through_month>=month_row.period_month)
           OR EXISTS(SELECT 1 FROM app_private.profit_ledger_payout_settlements WHERE organization_id=p_organization_id AND shareholder_id=member AND through_month>=month_row.period_month AND state='ACTIVE'
                     AND (cash_voucher_id IS NULL OR app_private.profit_ledger_voucher_live_v1(cash_voucher_id)))
           OR EXISTS(SELECT 1 FROM app_private.profit_ledger_salary_settlement_vouchers WHERE organization_id=p_organization_id AND shareholder_id=member AND period_month=month_row.period_month AND state IN ('LINKED','NEEDS_REVIEW'))
           OR (removed>0 AND (pos->>'unpaid_profit')::numeric<removed) THEN
            RAISE EXCEPTION 'Kỳ % có quyền lợi đã quyết toán hoặc thiếu số chưa chi để chuyển',month_row.period_month USING ERRCODE='PT409';
          END IF;
        END IF;
      END LOOP;

      INSERT INTO app_private.house_pool_contributions(rule_id,period_month,revision_id,reason,amount_each,amount_each_after,retained_amount,original_allocation)
       VALUES(rule.id,month_row.period_month,revision.id,'IMPORT',(split->>'house_pool_each')::bigint,(split->>'house_pool_each')::bigint,(split->>'unallocated_profit')::numeric,original);
      UPDATE public.profit_allocations SET amount=0,percent=0 WHERE profit_monthly_id=month_row.id AND shareholder_id IN(owner_holder,p_partner);
      UPDATE public.profit_monthly SET house_pool_amount=(split->>'house_pool_amount')::bigint,shareholder_percent_total=(split->>'shareholder_percent_total')::numeric,
        shareholder_allocated_amount=(split->>'shareholder_allocated_amount')::numeric,unallocated_profit=(split->>'unallocated_profit')::numeric WHERE id=month_row.id;
      imported := imported+1;
    END LOOP;
  END LOOP;
  IF p_opening_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_private.house_pool_openings
       WHERE organization_id=p_organization_id AND source_id=p_opening_id AND first_shareholder=owner_holder AND second_shareholder=p_partner) THEN
    SELECT * INTO opening FROM app_private.shared_fund_entries WHERE organization_id=p_organization_id AND id=p_opening_id AND kind='OPENING';
    IF NOT FOUND OR opening.amount<=0 OR opening.amount%2<>0 OR opening.effective_date<>p_history_from-1
      OR EXISTS (SELECT 1 FROM app_private.shared_fund_entries WHERE organization_id=p_organization_id AND entry_seq>opening.entry_seq) THEN
      RAISE EXCEPTION 'Số mở sổ đã dùng, không chia đều được hoặc sai mốc trước kỳ gom' USING ERRCODE='PT409';
    END IF;
    transfer := app_private.shared_fund_write_v1(p_organization_id,'DEBIT',opening.effective_date,opening.amount,
      'GOM-'||opening.id,'Chuyển toàn bộ số mở sổ '||opening.reference||' sang phần góp bằng nhau của hai cổ đông.',
      NULL,opening.amount,'house-pool-opening-'||opening.id);
    INSERT INTO app_private.house_pool_openings(organization_id,source_id,transfer_id,first_shareholder,second_shareholder,amount_each)
      VALUES(p_organization_id,opening.id,(transfer->>'id')::uuid,owner_holder,p_partner,opening.amount/2);
  END IF;
  receipt := jsonb_build_object('imported',imported,'shareholders',jsonb_build_array(owner_holder,p_partner));
  INSERT INTO app_private.house_pool_activations(organization_id,actor_id,request_key,payload,receipt)
    VALUES(p_organization_id,actor,p_request_key,payload,receipt);
  RETURN receipt;
END
$fn$;
REVOKE ALL ON FUNCTION public.house_pool_activate_v1(uuid,uuid,jsonb,date,date,uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.house_pool_activate_v1(uuid,uuid,jsonb,date,date,uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.house_pool_receipt_v1(p_organization_id uuid,p_request_key uuid,p_kind text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
BEGIN
  IF app_private.shared_fund_owner_v1(p_organization_id) IS NULL THEN RAISE EXCEPTION 'Không có quyền đọc biên nhận' USING ERRCODE='42501'; END IF;
  IF p_kind='return' THEN RETURN (SELECT jsonb_build_object('voucher',r.voucher_id,'imported',NULL) FROM app_private.house_pool_returns r
    WHERE r.organization_id=p_organization_id AND r.actor_id=auth.uid() AND r.request_key=p_request_key);
  ELSIF p_kind='activate' THEN RETURN (SELECT jsonb_build_object('voucher',NULL,'imported',a.receipt->'imported') FROM app_private.house_pool_activations a
    WHERE a.organization_id=p_organization_id AND a.actor_id=auth.uid() AND a.request_key=p_request_key);
  ELSE RAISE EXCEPTION 'Sai loại biên nhận' USING ERRCODE='22023'; END IF;
END
$fn$;
REVOKE ALL ON FUNCTION public.house_pool_receipt_v1(uuid,uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.house_pool_receipt_v1(uuid,uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION app_private.house_pool_quote_v1(p_org uuid,p_rate integer)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO pg_catalog AS $fn$
 WITH rows AS (
  SELECT p.shareholder_id,s.name,p.contributed,p.paid,p.reserved,p.available,
      floor(p.available::numeric*p_rate/10000)::bigint AS amount
  FROM app_private.house_pool_positions_v1(p_org) p JOIN public.shareholders s ON s.id=p.shareholder_id AND s.organization_id=p_org
 ), doc AS (
  SELECT coalesce(jsonb_agg(to_jsonb(rows) ORDER BY shareholder_id),'[]') AS lines,coalesce(sum(amount),0) AS total,
    count(*)>=2 AND bool_and(amount>0 AND amount<=available) AND p_rate BETWEEN 1 AND 10000 AS eligible FROM rows
 )
 SELECT jsonb_build_object('lines',lines,'total',total,'eligible',coalesce(eligible,false),'hash',md5(lines::text||p_rate::text)) FROM doc
$fn$;
REVOKE ALL ON FUNCTION app_private.house_pool_quote_v1(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.house_pool_min_date_v1(p_org uuid)
RETURNS date LANGUAGE sql STABLE SET search_path TO pg_catalog AS $fn$
  SELECT greatest(
    (SELECT max(CASE WHEN e.reason='IMPORT' THEN (e.period_month+interval '1 month'-interval '1 day')::date
      ELSE (v.created_at AT TIME ZONE app_private.org_timezone_v1(p_org))::date END)
      FROM app_private.house_pool_contributions e JOIN app_private.house_pool_rules r ON r.id=e.rule_id
      JOIN public.profit_close_revisions v ON v.id=e.revision_id WHERE r.organization_id=p_org),
    (SELECT e.effective_date FROM app_private.house_pool_openings o JOIN app_private.shared_fund_entries e ON e.id=o.source_id WHERE o.organization_id=p_org),
    (SELECT max(b.voucher_date) FROM app_private.house_pool_batch_status b WHERE b.organization_id=p_org AND b.state<>'RELEASED')
  )
$fn$;
REVOKE ALL ON FUNCTION app_private.house_pool_min_date_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.house_pool_state_v1(p_organization_id uuid,p_rate integer DEFAULT 10000)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
BEGIN
  IF app_private.shared_fund_owner_v1(p_organization_id) IS NULL THEN RAISE EXCEPTION 'Chỉ chủ công ty được quản lý quỹ góp' USING ERRCODE='42501'; END IF;
  IF p_rate IS NULL OR p_rate NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Tỷ lệ hoàn phải từ 0,01%% đến 100%%' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('quote',app_private.house_pool_quote_v1(p_organization_id,p_rate),'min_date',app_private.house_pool_min_date_v1(p_organization_id),
    'opening',(SELECT jsonb_build_object('id',e.id,'date',e.effective_date,'reference',e.reference,'amount',e.amount,'linked',o.source_id IS NOT NULL)
      FROM app_private.shared_fund_entries e LEFT JOIN app_private.house_pool_openings o ON o.source_id=e.id
      WHERE e.organization_id=p_organization_id AND e.kind='OPENING'),
    'baselines',(SELECT coalesce(jsonb_agg(jsonb_build_object('building_id',v.building_id,'id',v.id)),'[]')
      FROM public.profit_close_revisions v JOIN public.profit_monthly pm ON pm.id=v.profit_monthly_id AND pm.revision_number=v.revision_number
      WHERE v.organization_id=p_organization_id AND v.period_month=date '2026-05-01' AND v.operation='BASELINE' AND pm.status='LOCKED'),
    'rules',(SELECT coalesce(jsonb_agg(jsonb_build_object('building_id',b.id,'name',b.name,'share_percent',r.share_percent,'retained_percent',r.retained_percent,'from_month',r.from_month) ORDER BY b.name),'[]')
      FROM app_private.house_pool_rules r JOIN public.buildings b ON b.id=r.building_id WHERE r.organization_id=p_organization_id
        AND r.from_month=(SELECT max(v.from_month) FROM app_private.house_pool_rules v WHERE v.organization_id=r.organization_id AND v.building_id=r.building_id AND v.from_month<=public.org_today_v1(p_organization_id))),
    'history',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'building',b.name,'month',e.period_month,'each',e.amount_each,'retained',e.retained_amount,'reason',e.reason) ORDER BY e.period_month DESC,e.id DESC),'[]')
      FROM app_private.house_pool_contributions e JOIN app_private.house_pool_rules r ON r.id=e.rule_id JOIN public.buildings b ON b.id=r.building_id WHERE r.organization_id=p_organization_id),
    'batches',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',b.id,'rate',b.fraction_bps,'state',b.state,'date',b.voucher_date,'total',b.total_amount,'voucher_id',b.voucher_id,'code',v.code,
        'lines',(SELECT jsonb_agg(jsonb_build_object('name',s.name,'amount',l.amount) ORDER BY l.shareholder_id) FROM app_private.house_pool_return_lines l JOIN public.shareholders s ON s.id=l.shareholder_id WHERE l.batch_id=b.id)) ORDER BY b.created_at DESC),'[]')
      FROM app_private.house_pool_batch_status b JOIN public.income_expenses v ON v.id=b.voucher_id WHERE b.organization_id=p_organization_id));
END
$fn$;
REVOKE ALL ON FUNCTION public.house_pool_state_v1(uuid,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.house_pool_state_v1(uuid,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.house_pool_return_v1(p_organization_id uuid,p_rate integer,p_account uuid,
 p_voucher_date date,p_expected_hash text,p_request_key uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog, public, pg_temp AS $fn$
DECLARE
  actor uuid := auth.uid();
  batch app_private.house_pool_returns;
  quote jsonb;
  virtual_building public.buildings;
  item_type uuid;
  membership uuid;
  request_id uuid;
  voucher_id uuid := gen_random_uuid();
  voucher public.income_expenses;
BEGIN
  IF app_private.shared_fund_owner_v1(p_organization_id) IS NULL THEN RAISE EXCEPTION 'Chỉ chủ công ty được lập đợt hoàn' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  IF app_private.shared_fund_owner_v1(p_organization_id) IS NULL THEN RAISE EXCEPTION 'Quyền quản lý quỹ đã thay đổi' USING ERRCODE='42501'; END IF;
  PERFORM app_private.profit_ledger_tao_assert_route_v1(p_organization_id,ARRAY['CANONICAL']);
  IF p_request_key IS NULL OR p_rate IS NULL OR p_rate NOT BETWEEN 1 AND 10000 OR p_voucher_date IS NULL OR p_voucher_date>public.org_today_v1(p_organization_id) THEN
    RAISE EXCEPTION 'Kiểm tra ngày chi, tỷ lệ và mã đợt hoàn' USING ERRCODE='22023';
  END IF;
  SELECT * INTO batch FROM app_private.house_pool_returns WHERE organization_id=p_organization_id AND actor_id=actor AND request_key=p_request_key;
  IF FOUND THEN
    IF (batch.fraction_bps,batch.account_id,batch.voucher_date,batch.preview_hash) IS DISTINCT FROM (p_rate,p_account,p_voucher_date,p_expected_hash) THEN
      RAISE EXCEPTION 'Mã đợt hoàn đã dùng với nội dung khác' USING ERRCODE='PT409';
    END IF;
    RETURN jsonb_build_object('id',batch.id,'voucher_id',batch.voucher_id,'total',batch.total_amount);
  END IF;
  IF p_voucher_date<app_private.house_pool_min_date_v1(p_organization_id) THEN
    RAISE EXCEPTION 'Ngày hoàn sớm hơn kỳ góp hoặc đợt hoàn gần nhất' USING ERRCODE='22023';
  END IF;
  SELECT * INTO STRICT virtual_building FROM public.buildings WHERE organization_id=p_organization_id AND is_virtual AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1;
  IF NOT EXISTS(SELECT 1 FROM public.accounts WHERE id=p_account AND organization_id=p_organization_id AND deleted_at IS NULL AND NOT is_virtual)
     OR NOT coalesce((SELECT allowed FROM app_private.authorize_tenant_action_v3(actor,p_organization_id,'shareholder_profit.distribute',virtual_building.id,p_account)),false) THEN
    RAISE EXCEPTION 'Không có quyền lập đợt hoàn ở sổ đã chọn' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.profit_ledger_chot_assert_ngay_v1(virtual_building.id,p_account,p_voucher_date);
  quote := app_private.house_pool_quote_v1(p_organization_id,p_rate);
  IF NOT (quote->>'eligible')::boolean OR quote->>'hash' IS DISTINCT FROM p_expected_hash THEN
    RAISE EXCEPTION 'Số góp đã đổi hoặc tiền hoàn chưa đủ một đồng cho mỗi người. Xem lại toàn đợt' USING ERRCODE='PT409';
  END IF;
  item_type := app_private.profit_ledger_chot_hang_muc_v1(p_organization_id,virtual_building.user_id,'chia_loi_nhuan');
  membership := app_private.shared_fund_owner_v1(p_organization_id);
  PERFORM app_private.claim_feature_operation_v1('shareholder_profit.ledger_payout.v1',p_organization_id,
    'house_pool.return.v1',actor,p_request_key::text,(quote->>'total')::numeric);
  PERFORM app_private.begin_accounting_chain_write_v1();
  INSERT INTO public.income_expenses(id,user_id,organization_id,creator_name,type,name,building_id,account_id,total_amount,
      business_result_accounting,approval_status,voucher_date,system_source,idempotency_key,maker_user_id,maker_membership_id,source_payload_hash)
    VALUES(voucher_id,virtual_building.user_id,p_organization_id,(SELECT full_name FROM public.profiles WHERE id=actor),
      'EXPENSE','Hoàn quỹ chung cho toàn bộ người góp',virtual_building.id,p_account,(quote->>'total')::bigint,
      false,'UNAPPROVED',p_voucher_date,'profit.house_pool_return','house-pool-'||p_request_key,actor,membership,p_expected_hash);
  INSERT INTO public.income_expense_items(income_expense_id,organization_id,income_expense_type_id,accounting_class,
      description,quantity,unit_price,amount,start_date,end_date)
    SELECT voucher_id,p_organization_id,item_type,'INTERNAL',l.name,1,l.amount,l.amount,p_voucher_date,p_voucher_date
    FROM jsonb_to_recordset(quote->'lines') l(shareholder_id uuid,name text,amount bigint) ORDER BY l.shareholder_id;
  request_id := app_private.submit_financial_request_v1(voucher_id,membership,actor,'house-pool-'||p_request_key||'-submit');
  IF NOT EXISTS(SELECT 1 FROM public.approval_requests WHERE id=request_id AND organization_id=p_organization_id AND state='PENDING_APPROVAL') THEN
    RAISE EXCEPTION 'Đợt hoàn chưa vào được luồng duyệt phiếu chi' USING ERRCODE='55000';
  END IF;
  PERFORM app_private.end_accounting_chain_write_v1();
  SELECT * INTO STRICT voucher FROM public.income_expenses WHERE id=voucher_id AND organization_id=p_organization_id;
  IF voucher.account_id IS DISTINCT FROM p_account OR voucher.total_amount IS DISTINCT FROM (quote->>'total')::numeric
     OR voucher.counts_in_business_result IS DISTINCT FROM false OR coalesce(voucher.kqkd_amount,0)<>0 THEN
    RAISE EXCEPTION 'Phiếu hoàn không khớp quỹ hoặc ảnh hưởng kết quả kinh doanh' USING ERRCODE='55000';
  END IF;
  INSERT INTO app_private.house_pool_returns(organization_id,actor_id,request_key,fraction_bps,account_id,voucher_date,voucher_id,total_amount,preview_hash)
   VALUES(p_organization_id,actor,p_request_key,p_rate,p_account,p_voucher_date,voucher.id,voucher.total_amount,p_expected_hash) RETURNING * INTO batch;
  INSERT INTO app_private.house_pool_return_lines(batch_id,organization_id,shareholder_id,balance_before,amount)
   SELECT batch.id,p_organization_id,l.shareholder_id,l.available,l.amount FROM jsonb_to_recordset(quote->'lines') l(shareholder_id uuid,available bigint,amount bigint);
  RETURN jsonb_build_object('id',batch.id,'voucher_id',voucher.id,'total',batch.total_amount);
END
$fn$;
REVOKE ALL ON FUNCTION public.house_pool_return_v1(uuid,integer,uuid,date,text,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.house_pool_return_v1(uuid,integer,uuid,date,text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION app_private.house_pool_guard_voucher_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
BEGIN
  IF (NEW.approval_status='APPROVED' AND OLD.approval_status IS DISTINCT FROM NEW.approval_status)
    OR (NEW.posting_status='POSTED' AND OLD.posting_status IS DISTINCT FROM NEW.posting_status) THEN
    IF auth.uid() IS NULL OR app_private.evaluate_feature_route('shareholder_profit.ledger_payout.v1',OLD.organization_id) IS DISTINCT FROM 'CANONICAL'
      OR NOT EXISTS(SELECT 1 FROM app_private.ie_transition_authorization t WHERE t.income_expense_id=OLD.id AND t.xid=pg_current_xact_id() AND t.purpose='FINANCE_V2_LIFECYCLE')
      OR NOT EXISTS(SELECT 1 FROM app_private.house_pool_returns b WHERE b.voucher_id=OLD.id AND b.total_amount=NEW.total_amount AND b.account_id=NEW.account_id)
      OR NOT EXISTS(SELECT 1 FROM app_private.authorized_scope_v3('shareholder_profit.distribute',OLD.organization_id) s WHERE s.org_wide)
    THEN RAISE EXCEPTION 'Duyệt hoặc ghi sổ đợt hoàn cần quyền chia lợi nhuận công ty và luồng thu chi đang hoạt động' USING ERRCODE='42501'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM app_private.house_pool_returns WHERE voucher_id=OLD.id) AND (
      (NEW.organization_id,NEW.id,NEW.type,NEW.building_id,NEW.account_id,NEW.total_amount,NEW.voucher_date,NEW.shareholder_id,
       NEW.business_result_accounting,NEW.system_source,NEW.counts_in_business_result,NEW.kqkd_amount)
      IS DISTINCT FROM
      (OLD.organization_id,OLD.id,OLD.type,OLD.building_id,OLD.account_id,OLD.total_amount,OLD.voucher_date,OLD.shareholder_id,
       OLD.business_result_accounting,OLD.system_source,OLD.counts_in_business_result,OLD.kqkd_amount)
      OR ((OLD.posting_status='REVERSED' OR OLD.approval_status IN ('CANCELLED','REJECTED') OR OLD.deleted_at IS NOT NULL
            OR (OLD.posting_status IS DISTINCT FROM 'POSTED' AND NOT app_private.profit_ledger_voucher_live_v1(OLD.id)))
          AND (NEW.posting_status='POSTED' OR NEW.approval_status IS DISTINCT FROM OLD.approval_status OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at))) THEN
    RAISE EXCEPTION 'Phiếu hoàn ghi chung cả đợt. Lập đợt mới nếu cần thay đổi người, tiền hoặc sổ' USING ERRCODE='PT409';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.house_pool_guard_voucher_v1() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS house_pool_guard_voucher ON public.income_expenses;
CREATE TRIGGER house_pool_guard_voucher BEFORE UPDATE ON public.income_expenses FOR EACH ROW
 WHEN (OLD.system_source='profit.house_pool_return') EXECUTE FUNCTION app_private.house_pool_guard_voucher_v1();

CREATE OR REPLACE FUNCTION app_private.house_pool_guard_request_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
BEGIN
  IF EXISTS(SELECT 1 FROM app_private.house_pool_returns b WHERE b.voucher_id=NEW.subject_id AND b.organization_id=NEW.organization_id)
    AND (TG_OP='INSERT' OR (OLD.state IN ('DENIED','REJECTED','CANCELLED','WITHDRAWN','REVERSED') AND NEW.state IS DISTINCT FROM OLD.state)) THEN
    RAISE EXCEPTION 'Đợt hoàn đã có yêu cầu duyệt. Hãy lập đợt mới sau khi huỷ.' USING ERRCODE='PT409';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.house_pool_guard_request_v1() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS house_pool_guard_request ON public.approval_requests;
CREATE TRIGGER house_pool_guard_request BEFORE INSERT OR UPDATE OF state ON public.approval_requests
 FOR EACH ROW WHEN (NEW.subject_type='FINANCIAL_VOUCHER') EXECUTE FUNCTION app_private.house_pool_guard_request_v1();

CREATE OR REPLACE FUNCTION app_private.house_pool_guard_item_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog AS $fn$
BEGIN
  IF EXISTS(SELECT 1 FROM app_private.house_pool_returns
         WHERE (TG_OP<>'INSERT' AND voucher_id=OLD.income_expense_id) OR (TG_OP<>'DELETE' AND voucher_id=NEW.income_expense_id)) THEN
    RAISE EXCEPTION 'Các dòng người nhận của đợt hoàn đã được ghi theo tỷ lệ chung' USING ERRCODE='PT409';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION app_private.house_pool_guard_item_v1() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS house_pool_guard_item ON public.income_expense_items;
CREATE TRIGGER house_pool_guard_item BEFORE INSERT OR DELETE OR UPDATE ON public.income_expense_items FOR EACH ROW EXECUTE FUNCTION app_private.house_pool_guard_item_v1();
