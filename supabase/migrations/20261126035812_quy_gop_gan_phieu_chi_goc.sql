-- Quy nguồn cho khoản đã chi. Không tạo giao dịch tiền hoặc sửa phiếu gốc.
CREATE TABLE IF NOT EXISTS app_private.house_pool_expenses (
  voucher_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  posting_id uuid NOT NULL REFERENCES public.income_expense_postings(id),
  batch_id uuid NOT NULL,
  first_holder uuid NOT NULL,
  second_holder uuid NOT NULL CHECK (first_holder<>second_holder),
  amount bigint NOT NULL CHECK (amount>0),
  first_amount bigint NOT NULL CHECK(first_amount BETWEEN 0 AND amount),
  effective_date date NOT NULL,
  created_by uuid NOT NULL,
  FOREIGN KEY (voucher_id,organization_id) REFERENCES public.income_expenses(id,organization_id),
  FOREIGN KEY (first_holder,organization_id) REFERENCES public.shareholders(id,organization_id),
  FOREIGN KEY (second_holder,organization_id) REFERENCES public.shareholders(id,organization_id)
);
CREATE INDEX IF NOT EXISTS house_pool_expenses_org_idx ON app_private.house_pool_expenses(organization_id,batch_id);
ALTER TABLE app_private.house_pool_expenses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.house_pool_expenses FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE VIEW app_private.house_pool_expense_status WITH(security_invoker=true) AS
  SELECT x.*,v.code,v.voucher_date,(v.approval_status='APPROVED' AND v.posting_status='POSTED'
    AND v.active_posting_id_v2=x.posting_id AND v.deleted_at IS NULL AND v.total_amount=x.amount) IS TRUE AS live
    FROM app_private.house_pool_expenses x JOIN public.income_expenses v ON v.id=x.voucher_id AND v.organization_id=x.organization_id;
REVOKE ALL ON app_private.house_pool_expense_status FROM PUBLIC,anon,authenticated,service_role;

-- Dùng một số khả dụng cho cả báo cáo, đối chiếu cá nhân và hoàn đồng loạt.
DO $wrap$ BEGIN
  IF to_regprocedure('app_private.house_pool_positions_before_expenses_v1(uuid)') IS NULL THEN
    ALTER FUNCTION app_private.house_pool_positions_v1(uuid) RENAME TO house_pool_positions_before_expenses_v1;
  END IF;
END $wrap$;
CREATE OR REPLACE FUNCTION app_private.house_pool_positions_v1(p_org uuid)
RETURNS TABLE(shareholder_id uuid,contributed bigint,reserved bigint,paid bigint,available bigint)
LANGUAGE sql STABLE SET search_path TO pg_catalog AS $f$
 WITH debits AS (
   SELECT d.holder,sum(d.amount)::bigint AS spent FROM app_private.house_pool_expense_status x
   CROSS JOIN LATERAL (VALUES(x.first_holder,x.first_amount),(x.second_holder,x.amount-x.first_amount)) d(holder,amount)
   WHERE x.organization_id=p_org AND x.live GROUP BY d.holder
 )
 SELECT p.shareholder_id,p.contributed,p.reserved,p.paid,p.available-coalesce(d.spent,0)
 FROM app_private.house_pool_positions_before_expenses_v1(p_org) p LEFT JOIN debits d ON d.holder=p.shareholder_id
$f$;
REVOKE ALL ON FUNCTION app_private.house_pool_positions_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;

DO $guard$ DECLARE
  body text:=pg_get_functiondef('app_private.house_pool_capture_revision_v1()'::regprocedure);
  old_guard text:='p.reserved+p.paid>0';
  new_guard text:='p.contributed>p.available';
BEGIN
  IF strpos(body,old_guard)>0 THEN EXECUTE replace(body,old_guard,new_guard);
  ELSIF strpos(body,new_guard)=0 THEN RAISE EXCEPTION 'Cần đối chiếu điều kiện sửa kỳ đã sử dụng quỹ'; END IF;
END $guard$;

DO $date$ BEGIN
  IF to_regprocedure('app_private.house_pool_min_date_before_expenses_v1(uuid)') IS NULL THEN
    ALTER FUNCTION app_private.house_pool_min_date_v1(uuid) RENAME TO house_pool_min_date_before_expenses_v1;
  END IF;
END $date$;
CREATE OR REPLACE FUNCTION app_private.house_pool_min_date_v1(p_org uuid) RETURNS date
LANGUAGE sql STABLE SET search_path TO pg_catalog AS $f$
 SELECT greatest(app_private.house_pool_min_date_before_expenses_v1(p_org),
   (SELECT max(effective_date) FROM app_private.house_pool_expense_status WHERE organization_id=p_org AND live))
$f$;
REVOKE ALL ON FUNCTION app_private.house_pool_min_date_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.house_pool_link_expenses_v1(p_org uuid,p_items jsonb,p_expected_before bigint,p_apply boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO pg_catalog AS $f$
DECLARE
  req record; v public.income_expenses; prior app_private.house_pool_expenses;
  before_sum bigint; amount_sum bigint:=0; members uuid[]; balances bigint[]; gross bigint[];
  links integer:=0; batch uuid:=gen_random_uuid(); previous_batch uuid; item_count integer;
  day date:=public.org_today_v1(p_org); receipt jsonb;
BEGIN
  IF app_private.shared_fund_owner_v1(p_org) IS NULL THEN RAISE EXCEPTION 'Chỉ chủ công ty được liên kết phiếu' USING ERRCODE='42501'; END IF;

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR p_expected_before IS NULL OR p_apply IS NULL THEN RAISE EXCEPTION 'Thiếu danh sách hoặc số dư đối chiếu' USING ERRCODE='22023'; END IF;
  item_count:=jsonb_array_length(p_items);
  IF item_count NOT BETWEEN 1 AND 500 OR (SELECT count(DISTINCT id) FROM jsonb_to_recordset(p_items) x(id uuid))<>item_count THEN
    RAISE EXCEPTION 'Cần từ 1 đến 500 ID phiếu khác nhau' USING ERRCODE='22023'; END IF;
  -- Cùng thứ tự với đường đảo phiếu: phiếu gốc trước, rồi mới khoá công ty.
  PERFORM vch.id FROM public.income_expenses vch JOIN jsonb_to_recordset(p_items) x(id uuid) ON x.id=vch.id
    WHERE vch.organization_id=p_org ORDER BY vch.id FOR UPDATE OF vch;
  PERFORM app_private.lock_org_for_decision_v1(p_org);
  IF app_private.shared_fund_owner_v1(p_org) IS NULL THEN RAISE EXCEPTION 'Quyền quản lý quỹ đã thay đổi' USING ERRCODE='42501'; END IF;
  PERFORM app_private.profit_ledger_tao_assert_route_v1(p_org,ARRAY['CANONICAL']);
  SELECT array_agg(shareholder_id ORDER BY shareholder_id),array_agg(available ORDER BY shareholder_id),
         array_agg(contributed ORDER BY shareholder_id),sum(available)
    INTO members,balances,gross,before_sum FROM app_private.house_pool_positions_v1(p_org);
  IF cardinality(members) IS DISTINCT FROM 2 OR gross[1]<>gross[2] THEN
    RAISE EXCEPTION 'Cần quỹ có hai phần góp bằng nhau' USING ERRCODE='PT409'; END IF;
  FOR req IN SELECT * FROM jsonb_to_recordset(p_items) x(id uuid,amount numeric,code text,day date) ORDER BY id LOOP
    SELECT * INTO v FROM public.income_expenses WHERE id=req.id AND organization_id=p_org FOR UPDATE;
    IF NOT FOUND OR NOT coalesce((SELECT allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_org,'shareholder_profit.distribute',v.building_id,v.account_id)),false) THEN
      RAISE EXCEPTION 'Có phiếu ngoài phạm vi quản lý quỹ' USING ERRCODE='42501'; END IF;
    IF v.type IS DISTINCT FROM 'EXPENSE' OR v.approval_status IS DISTINCT FROM 'APPROVED' OR v.posting_status IS DISTINCT FROM 'POSTED'
      OR v.active_posting_id_v2 IS NULL OR v.deleted_at IS NOT NULL OR v.reversal_of_income_expense_id IS NOT NULL
      OR v.total_amount IS DISTINCT FROM req.amount OR v.voucher_date IS DISTINCT FROM req.day OR v.code IS DISTINCT FROM req.code
      OR v.voucher_date>day OR v.total_amount<=0 OR trunc(v.total_amount)<>v.total_amount
      OR (v.kqkd_amount<>0 AND EXISTS(SELECT 1 FROM app_private.house_pool_rules rr WHERE rr.organization_id=p_org AND rr.building_id=v.building_id))
      OR NOT EXISTS(SELECT 1 FROM public.income_expense_postings p WHERE p.id=v.active_posting_id_v2
          AND p.organization_id=p_org AND p.voucher_id=v.id AND p.account_id=v.account_id AND p.direction='EXPENSE'
          AND p.event_kind='POSTING' AND p.net_cash_effect=-v.total_amount AND p.amount_basis='VOUCHER_TOTAL'
          AND NOT EXISTS(SELECT 1 FROM public.income_expense_postings rev WHERE rev.organization_id=p_org AND rev.reversal_of_id=p.id))
      OR EXISTS(SELECT 1 FROM app_private.house_pool_returns WHERE voucher_id=v.id) THEN
      RAISE EXCEPTION 'Phiếu đã thay đổi, chưa ghi sổ hoặc không phải khoản chi hợp lệ' USING ERRCODE='PT409'; END IF;
    SELECT * INTO prior FROM app_private.house_pool_expenses WHERE voucher_id=v.id;
    IF FOUND THEN
      IF prior.posting_id<>v.active_posting_id_v2 OR prior.amount<>v.total_amount OR (previous_batch IS NOT NULL AND previous_batch<>prior.batch_id)
        THEN RAISE EXCEPTION 'Phiếu đã liên kết với đợt khác hoặc đã đảo sổ' USING ERRCODE='PT409'; END IF;
      previous_batch:=prior.batch_id; links:=links+1;
    END IF;
    amount_sum:=amount_sum+v.total_amount;
  END LOOP;
  IF links>0 THEN
    IF links<>item_count OR (SELECT count(*) FROM app_private.house_pool_expenses WHERE organization_id=p_org AND batch_id=previous_batch)<>item_count THEN
      RAISE EXCEPTION 'Danh sách chồng lên đợt đã ghi' USING ERRCODE='PT409'; END IF;
    RETURN jsonb_build_object('linked',true,'count',links,'amount',amount_sum,'after',before_sum,'batch',previous_batch);
  END IF;
  IF before_sum<>p_expected_before OR balances[1]<amount_sum/2 OR balances[2]<amount_sum-amount_sum/2 THEN
    RAISE EXCEPTION 'Số quỹ đã đổi hoặc không đủ để quy nguồn' USING ERRCODE='PT409'; END IF;
  receipt:=jsonb_build_object('linked',p_apply,'count',item_count,'amount',amount_sum,'after',before_sum-amount_sum);
  IF NOT p_apply THEN RETURN receipt; END IF;
  -- Chia phần lẻ đồng theo tổng luỹ kế trong đợt. Mỗi phiếu vẫn có hai phần cộng đúng số gốc.
  INSERT INTO app_private.house_pool_expenses(voucher_id,organization_id,posting_id,batch_id,first_holder,second_holder,
    amount,first_amount,effective_date,created_by)
  SELECT id,p_org,active_posting_id_v2,batch,members[1],members[2],amt,acc/2-(acc-amt)/2,day,auth.uid()
  FROM (SELECT vch.id,vch.active_posting_id_v2,vch.total_amount::bigint amt,sum(vch.total_amount) OVER(ORDER BY vch.id)::bigint acc
    FROM public.income_expenses vch JOIN jsonb_to_recordset(p_items) x(id uuid) ON x.id=vch.id WHERE vch.organization_id=p_org) ordered;
  RETURN receipt||jsonb_build_object('batch',batch);
END $f$;
REVOKE ALL ON FUNCTION public.house_pool_link_expenses_v1(uuid,jsonb,bigint,boolean) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.house_pool_link_expenses_v1(uuid,jsonb,bigint,boolean) TO authenticated;
DO $state$ BEGIN
  IF to_regprocedure('app_private.house_pool_state_before_expenses_v1(uuid,integer)') IS NULL THEN
    ALTER FUNCTION public.house_pool_state_v1(uuid,integer) SET SCHEMA app_private;
    ALTER FUNCTION app_private.house_pool_state_v1(uuid,integer) RENAME TO house_pool_state_before_expenses_v1;
  END IF;
END $state$;
REVOKE ALL ON FUNCTION app_private.house_pool_state_before_expenses_v1(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.house_pool_state_v1(p_organization_id uuid,p_rate integer DEFAULT 10000)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO pg_catalog AS $f$
DECLARE doc jsonb;
BEGIN
  doc:=app_private.house_pool_state_before_expenses_v1(p_organization_id,p_rate);
  RETURN doc||jsonb_build_object('expenses',(SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',e.voucher_id,'code',e.code,'date',e.voucher_date,'amount',e.amount,'live',e.live)
    ORDER BY e.voucher_date DESC,e.voucher_id),'[]') FROM app_private.house_pool_expense_status e WHERE e.organization_id=p_organization_id));
END $f$;
REVOKE ALL ON FUNCTION public.house_pool_state_v1(uuid,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.house_pool_state_v1(uuid,integer) TO authenticated;
