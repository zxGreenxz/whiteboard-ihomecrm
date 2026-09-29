-- Creation evidence only; never backfill attempts for historical contracts.
-- Five minutes is the processing grace; reads never mutate or retry a writer.
ALTER TABLE public.contract_commission_events DROP CONSTRAINT IF EXISTS contract_commission_events_action_check;
ALTER TABLE public.contract_commission_events ADD CONSTRAINT contract_commission_events_action_check
  CHECK(action IN ('ATTEMPTED','FAILED','NOT_APPLICABLE','REOPENED','COMPLETED'));
CREATE TABLE IF NOT EXISTS public.contract_commission_requests (
 organization_id uuid NOT NULL REFERENCES public.organizations(id),
 contract_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('broker','sale')), request_id uuid NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'), actor_id uuid NOT NULL REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz, result jsonb,
 PRIMARY KEY(organization_id,contract_id,kind,request_id),
 FOREIGN KEY(organization_id,contract_id) REFERENCES public.contracts(organization_id,id),
 CHECK((completed_at IS NULL)=(result IS NULL))
);
ALTER TABLE public.contract_commission_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contract_commission_requests FROM PUBLIC,anon,authenticated,service_role;
DROP POLICY IF EXISTS contract_commission_requests_hide_sandbox_admin ON public.contract_commission_requests;
CREATE POLICY contract_commission_requests_hide_sandbox_admin ON public.contract_commission_requests AS RESTRICTIVE FOR ALL TO authenticated
 USING(NOT(public.is_super_admin() AND COALESCE(organization_id=ANY(public.sandbox_org_ids()),false)));

CREATE OR REPLACE FUNCTION public.record_contract_commission_event_v1(
  p_organization_id uuid,p_contract_id uuid,p_kind text,p_action text,p_request_id uuid,
  p_amount numeric DEFAULT NULL,p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  v_building uuid;
  v_reason text:=nullif(btrim(p_reason),'');
  v_event public.contract_commission_events;
  v_attempt public.contract_commission_events;
  v_latest public.contract_commission_events;
  v_create boolean; v_edit boolean; v_finance boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501';
  END IF;
  IF p_contract_id IS NULL OR p_request_id IS NULL OR p_kind IS NULL OR p_kind NOT IN ('broker','sale')
    OR p_action IS NULL OR p_action NOT IN ('ATTEMPTED','FAILED','NOT_APPLICABLE','REOPENED')
    OR (p_amount IS NOT NULL AND (p_amount<=0 OR p_amount::text IN ('NaN','Infinity','-Infinity')))
    OR (p_action IN ('FAILED','NOT_APPLICABLE') AND v_reason IS NULL) OR length(v_reason)>2000 THEN
    RAISE EXCEPTION 'Thông tin theo dõi hoa hồng không hợp lệ' USING ERRCODE='22023';
  END IF;
  -- Acquire before reading permissions: a waiter uses the post-revocation snapshot.
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT b.id INTO v_building FROM public.contracts c
    JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id AND r.deleted_at IS NULL
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=c.organization_id AND b.deleted_at IS NULL
    WHERE c.id=p_contract_id AND c.organization_id=p_organization_id AND c.deleted_at IS NULL AND c.status<>'DRAFT';
  IF v_building IS NULL OR NOT app_private.contract_commission_can_manage_v1(p_organization_id,v_building) THEN
    RAISE EXCEPTION 'Không có quyền xử lý hoa hồng hợp đồng' USING ERRCODE='42501';
  END IF;
  -- Real writer authorization owns time/deny semantics and its organization lock.
  SELECT allowed INTO v_create FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'contracts.create',v_building,NULL);
  SELECT allowed INTO v_edit FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'contracts.edit',v_building,NULL);
  SELECT allowed INTO v_finance FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'income_expenses.create',v_building,NULL);
  IF NOT (COALESCE(v_create,false) OR COALESCE(v_edit,false)) OR NOT COALESCE(v_finance,false) THEN
    RAISE EXCEPTION 'Không có quyền ghi theo dõi hoa hồng' USING ERRCODE='42501';
  END IF;
  -- Shared with create_commission_voucher; decisions serialize with direct creates.
  PERFORM pg_advisory_xact_lock(hashtext('commission:'||p_contract_id::text||':'||p_kind));
  SELECT * INTO v_event FROM public.contract_commission_events
    WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND kind=p_kind AND request_id=p_request_id AND action=p_action;
  IF FOUND THEN
    IF v_event.amount IS DISTINCT FROM p_amount OR v_event.reason IS DISTINCT FROM v_reason OR v_event.actor_id<>auth.uid() THEN
      RAISE EXCEPTION 'Yêu cầu đã được dùng với nội dung khác' USING ERRCODE='PT409';
    END IF;
    RETURN to_jsonb(v_event);
  END IF;
  IF p_action='NOT_APPLICABLE' AND EXISTS(
    SELECT 1 FROM app_private.contract_commission_live_voucher_v1(p_organization_id,p_contract_id,p_kind)) THEN
    RAISE EXCEPTION 'Khoản này đã có phiếu; hãy đối chiếu phiếu hiện có' USING ERRCODE='PT409';
  END IF;
  SELECT * INTO v_latest FROM app_private.contract_commission_latest_event_v1(p_organization_id,p_contract_id,p_kind);
  IF p_action='ATTEMPTED' AND v_latest.action='NOT_APPLICABLE' THEN
    RAISE EXCEPTION 'Cần mở lại khoản không phát sinh trước khi tạo phiếu' USING ERRCODE='PT409';
  END IF;
  IF p_action='FAILED' THEN
    SELECT * INTO v_attempt FROM public.contract_commission_events
      WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND kind=p_kind AND request_id=p_request_id AND action='ATTEMPTED';
    IF NOT FOUND OR v_attempt.actor_id<>auth.uid() OR v_attempt.amount IS DISTINCT FROM p_amount THEN
      RAISE EXCEPTION 'Không tìm thấy lần tạo tương ứng' USING ERRCODE='PT409';
    END IF;
  END IF;
  INSERT INTO public.contract_commission_events(organization_id,contract_id,building_id,kind,action,request_id,amount,reason,actor_id,actor_name)
    VALUES(p_organization_id,p_contract_id,v_building,p_kind,p_action,p_request_id,p_amount,v_reason,auth.uid(),
      (SELECT nullif(btrim(p.full_name),'') FROM public.profiles p WHERE p.id=auth.uid())) RETURNING * INTO v_event;
  RETURN to_jsonb(v_event);
END
$fn$;


-- Both prepare and execute use the existing decision engine BEFORE commission locks.
CREATE OR REPLACE FUNCTION app_private.authorize_commission_request_v1(p_org uuid,p_contract uuid)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE b uuid; c boolean; e boolean; f boolean;
BEGIN
 IF auth.uid() IS NULL OR NOT COALESCE(p_org=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501'; END IF;
 PERFORM app_private.lock_org_for_decision_v1(p_org);
 SELECT r.building_id INTO b FROM public.contracts ct JOIN public.rooms r ON r.id=ct.room_id AND r.organization_id=ct.organization_id AND r.deleted_at IS NULL
 JOIN public.buildings bl ON bl.id=r.building_id AND bl.organization_id=ct.organization_id AND bl.deleted_at IS NULL
 WHERE ct.id=p_contract AND ct.organization_id=p_org AND ct.deleted_at IS NULL AND ct.status<>'DRAFT';
 IF b IS NULL OR NOT app_private.contract_commission_can_manage_v1(p_org,b) THEN RAISE EXCEPTION 'Không có quyền xử lý hoa hồng hợp đồng' USING ERRCODE='42501'; END IF;
 SELECT allowed INTO c FROM app_private.authorize_tenant_action_v3(auth.uid(),p_org,'contracts.create',b,NULL);
 SELECT allowed INTO e FROM app_private.authorize_tenant_action_v3(auth.uid(),p_org,'contracts.edit',b,NULL);
 SELECT allowed INTO f FROM app_private.authorize_tenant_action_v3(auth.uid(),p_org,'income_expenses.create',b,NULL);
 IF NOT(COALESCE(c,false) OR COALESCE(e,false)) OR NOT COALESCE(f,false) THEN RAISE EXCEPTION 'Không có quyền tạo phiếu' USING ERRCODE='42501'; END IF;
 RETURN b;
END $fn$;

CREATE OR REPLACE FUNCTION public.prepare_commission_requests_v1(p_organization_id uuid,p_intents jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE i jsonb; p jsonb; c uuid; k text; r uuid; a numeric; b uuid; live record; existing public.contract_commission_requests; receipts jsonb:='[]';
BEGIN
 IF jsonb_typeof(p_intents) IS DISTINCT FROM 'array' OR jsonb_array_length(p_intents)<1 OR jsonb_array_length(p_intents)>100 THEN RAISE EXCEPTION 'Danh sách yêu cầu không hợp lệ' USING ERRCODE='22023'; END IF;
 -- Stable lock order also covers a batch spanning contracts.
 FOR i IN SELECT value FROM jsonb_array_elements(p_intents) ORDER BY value->>'contract_id',value->>'kind' LOOP
  BEGIN
   c:=(i->>'contract_id')::uuid; k:=i->>'kind'; r:=(i->>'request_id')::uuid; a:=(i->>'amount')::numeric;
   IF c IS NULL OR r IS NULL OR k IS NULL OR k NOT IN ('broker','sale') OR a IS NULL OR a<=0 OR a::text IN ('NaN','Infinity','-Infinity')
    OR (i->>'voucher_date')::date IS NULL OR jsonb_typeof(COALESCE(i->'attachments','[]'))<>'array'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(i) key WHERE key<>ALL(ARRAY['contract_id','kind','request_id','amount','voucher_date','account_id','payer_name','recipient_name','recipient_bank','recipient_account','item_description','attachments'])) THEN
    RAISE EXCEPTION 'Yêu cầu tạo phiếu không hợp lệ' USING ERRCODE='22023';
   END IF;
   PERFORM (i->>'account_id')::uuid;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
   RAISE EXCEPTION 'Yêu cầu tạo phiếu không hợp lệ' USING ERRCODE='22023';
  END;
  b:=app_private.authorize_commission_request_v1(p_organization_id,c);
  PERFORM pg_advisory_xact_lock(hashtext('commission:'||c::text||':'||k));
  p:=i-'request_id';
  SELECT * INTO existing FROM public.contract_commission_requests WHERE organization_id=p_organization_id AND contract_id=c AND kind=k AND request_id=r;
  IF FOUND THEN
   IF existing.payload IS DISTINCT FROM p OR existing.actor_id<>auth.uid() THEN RAISE EXCEPTION 'Yêu cầu đã được dùng với nội dung khác' USING ERRCODE='PT409'; END IF;
  ELSE
   PERFORM public.record_contract_commission_event_v1(p_organization_id,c,k,'ATTEMPTED',r,a,NULL);
   INSERT INTO public.contract_commission_requests(organization_id,contract_id,kind,request_id,payload,actor_id) VALUES(p_organization_id,c,k,r,p,auth.uid());
   -- Intent prepared while a voucher is live belongs to that completed lifecycle.
   -- Capture now, so delaying execute until after cancellation cannot replace it.
   SELECT * INTO live FROM app_private.contract_commission_live_voucher_v1(p_organization_id,c,k);
   IF FOUND THEN
    UPDATE public.contract_commission_requests SET completed_at=clock_timestamp(),result=jsonb_build_object('status','ALREADY_EXISTS','id',live.id,'code',live.code)
      WHERE organization_id=p_organization_id AND contract_id=c AND kind=k AND request_id=r;
    INSERT INTO public.contract_commission_events(organization_id,contract_id,building_id,kind,action,request_id,amount,actor_id,actor_name)
      VALUES(p_organization_id,c,b,k,'COMPLETED',r,a,auth.uid(),(SELECT full_name FROM public.profiles WHERE id=auth.uid())) ON CONFLICT DO NOTHING;
   END IF;
  END IF;
  receipts:=receipts||jsonb_build_array(jsonb_build_object('contract_id',c,'kind',k,'request_id',r));
 END LOOP;
 RETURN receipts;
END $fn$;

CREATE OR REPLACE FUNCTION public.execute_commission_request_v1(p_organization_id uuid,p_contract_id uuid,p_kind text,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE b uuid; req public.contract_commission_requests; p jsonb; v record; receipt jsonb; failure text;
BEGIN
 b:=app_private.authorize_commission_request_v1(p_organization_id,p_contract_id);
 IF p_kind IS NULL OR p_kind NOT IN ('broker','sale') OR p_request_id IS NULL THEN RAISE EXCEPTION 'Yêu cầu không hợp lệ' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('commission:'||p_contract_id::text||':'||p_kind));
 SELECT * INTO req FROM public.contract_commission_requests WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND kind=p_kind AND request_id=p_request_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy yêu cầu đã ghi nhận' USING ERRCODE='PT409'; END IF;
 p:=req.payload; receipt:=req.result;
 -- Completion time, not prepare order: every intent present at success belongs
 -- to that lifecycle. Both timestamps use clock_timestamp() while holding the
 -- same commission lock (transaction now() would collapse distinct intents).
 -- Returning a prior receipt must not advance its completion timestamp.
 IF receipt IS NULL THEN
  SELECT result||jsonb_build_object('status','ALREADY_EXISTS') INTO receipt FROM public.contract_commission_requests WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND kind=p_kind
    AND completed_at IS NOT NULL AND completed_at>=req.created_at ORDER BY completed_at DESC LIMIT 1;
 END IF;
 IF receipt IS NULL THEN
  SELECT * INTO v FROM app_private.contract_commission_live_voucher_v1(p_organization_id,p_contract_id,p_kind);
  IF FOUND THEN receipt:=jsonb_build_object('status','ALREADY_EXISTS','id',v.id,'code',v.code);
  ELSE
   -- Financial creation rolls back as a unit on error; evidence commits outside it.
   BEGIN
    receipt:=public.create_commission_voucher(p_contract_id,p_kind,(p->>'amount')::numeric,(p->>'voucher_date')::date,
      (p->>'account_id')::uuid,p->>'payer_name',p->>'recipient_name',p->>'recipient_bank',p->>'recipient_account',p->>'item_description',COALESCE(p->'attachments','[]'));
    IF receipt->>'id' IS NULL THEN RAISE EXCEPTION 'Không nhận được định danh phiếu'; END IF;
    receipt:=receipt||jsonb_build_object('status','COMPLETED');
   EXCEPTION WHEN OTHERS THEN
    failure:=left(SQLERRM,1500); receipt:=NULL;
   END;
  END IF;
  IF receipt IS NOT NULL THEN
   UPDATE public.contract_commission_requests SET completed_at=clock_timestamp(),result=receipt WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND kind=p_kind AND request_id=p_request_id;
   INSERT INTO public.contract_commission_events(organization_id,contract_id,building_id,kind,action,request_id,amount,actor_id,actor_name)
   VALUES(p_organization_id,p_contract_id,b,p_kind,'COMPLETED',p_request_id,(p->>'amount')::numeric,auth.uid(),(SELECT full_name FROM public.profiles WHERE id=auth.uid())) ON CONFLICT DO NOTHING;
  ELSE
   INSERT INTO public.contract_commission_events(organization_id,contract_id,building_id,kind,action,request_id,amount,reason,actor_id,actor_name)
   VALUES(p_organization_id,p_contract_id,b,p_kind,'FAILED',p_request_id,(p->>'amount')::numeric,failure,auth.uid(),(SELECT full_name FROM public.profiles WHERE id=auth.uid())) ON CONFLICT DO NOTHING;
   RETURN jsonb_build_object('status','FAILED','id',NULL,'code',NULL);
  END IF;
 END IF;
 IF NOT app_private.contract_commission_scope_v1(p_organization_id,b,'income_expenses.view') OR NOT COALESCE(app_private.ie_supplement_can_read_v1((receipt->>'id')::uuid),false) THEN
  receipt:=receipt||jsonb_build_object('id',NULL,'code',NULL);
 END IF;
 RETURN receipt;
END $fn$;

CREATE OR REPLACE FUNCTION public.list_contract_commission_followups_v2(
  p_organization_id uuid,p_contract_ids uuid[] DEFAULT NULL,p_building_ids uuid[] DEFAULT NULL,
  p_offset integer DEFAULT 0,p_limit integer DEFAULT 50,p_unresolved_only boolean DEFAULT false,
  p_kind text DEFAULT NULL,p_search text DEFAULT NULL,p_period_from date DEFAULT NULL,p_period_to date DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501';
  END IF;
  IF (p_kind IS NOT NULL AND p_kind NOT IN ('broker','sale')) OR length(p_search)>200
    OR (p_period_from IS NOT NULL AND p_period_to IS NOT NULL AND p_period_from>p_period_to) OR p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_unresolved_only IS NULL
    OR cardinality(p_contract_ids)>200 OR cardinality(p_building_ids)>200
    OR array_position(p_contract_ids,NULL) IS NOT NULL OR array_position(p_building_ids,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Bộ lọc hoặc phân trang không hợp lệ' USING ERRCODE='22023';
  END IF;
  -- Resolve each permission once and general access once per building. Calling
  -- the authorization engine for every contract/kind exceeds the API timeout.
  WITH permission_scopes AS MATERIALIZED (
    SELECT key.permission_key,a.org_wide,a.building_ids
    FROM (VALUES('contracts.view'),('contracts.create'),('contracts.edit'),('income_expenses.view'),('income_expenses.create')) key(permission_key)
    CROSS JOIN LATERAL app_private.authorized_scope_v3(key.permission_key,p_organization_id) a
  ), readable_buildings AS MATERIALIZED (
    SELECT b.id,b.name,
      EXISTS(SELECT 1 FROM permission_scopes a WHERE a.permission_key='income_expenses.view'
        AND (a.org_wide OR b.id=ANY(a.building_ids))) can_read_finance,
      EXISTS(SELECT 1 FROM permission_scopes a WHERE a.permission_key='income_expenses.view' AND a.org_wide) can_read_org_finance,
      EXISTS(SELECT 1 FROM permission_scopes a WHERE a.permission_key IN ('contracts.create','contracts.edit')
        AND (a.org_wide OR b.id=ANY(a.building_ids)))
        AND EXISTS(SELECT 1 FROM permission_scopes a WHERE a.permission_key='income_expenses.create'
          AND (a.org_wide OR b.id=ANY(a.building_ids))) can_manage
    FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL
      AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND COALESCE(public.can_access_building(b.id),false)
      AND NOT COALESCE(public.is_super_admin() AND p_organization_id=ANY(public.sandbox_org_ids()),false)
      AND EXISTS(SELECT 1 FROM permission_scopes a WHERE a.permission_key='contracts.view'
        AND (a.org_wide OR b.id=ANY(a.building_ids)))
  ), eligible AS MATERIALIZED (
    SELECT c.id contract_id,c.contract_number,b.id building_id,COALESCE(b.name,'') building_name,COALESCE(r.name,'') room_name,k.kind,
      b.can_read_finance,b.can_read_org_finance,b.can_manage
    FROM public.contracts c
    JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id AND r.deleted_at IS NULL
    JOIN readable_buildings b ON b.id=r.building_id
    CROSS JOIN (VALUES('broker'::text),('sale'::text)) k(kind)
    WHERE c.organization_id=p_organization_id AND c.deleted_at IS NULL AND c.status<>'DRAFT'
      AND (p_contract_ids IS NULL OR c.id=ANY(p_contract_ids))
  ), live_vouchers AS MATERIALIZED (
    -- Set-based across eligible subjects: avoid rescanning the financial tables
    -- through a SECURITY DEFINER helper once for every contract/kind pair.
    SELECT DISTINCT ON (v.contract_id,v.kind) v.contract_id,v.kind,v.id,v.code,v.approval_status
    FROM (
      SELECT e.contract_id,e.kind,ie.id,ie.code,ie.approval_status::text,ie.created_at
      FROM eligible e JOIN public.income_expenses ie
        ON ie.contract_id=e.contract_id AND ie.commission_kind=e.kind AND ie.organization_id=p_organization_id
      WHERE ie.deleted_at IS NULL AND ie.approval_status IS DISTINCT FROM 'CANCELLED'
      UNION ALL
      SELECT e.contract_id,e.kind,bon.id,bon.code,bon.approval_status::text,bon.created_at
      FROM eligible e
      JOIN public.income_expenses dep ON dep.contract_id=e.contract_id AND dep.organization_id=p_organization_id
      JOIN app_private.sale_bonus_claims claim ON claim.deposit_voucher_id=dep.id AND claim.organization_id=p_organization_id
      JOIN public.income_expenses bon ON bon.id=claim.bonus_voucher_id AND bon.organization_id=p_organization_id
      WHERE e.kind='sale' AND bon.deleted_at IS NULL AND bon.approval_status IS DISTINCT FROM 'CANCELLED'
    ) v ORDER BY v.contract_id,v.kind,v.created_at DESC,v.id
  ), states AS MATERIALIZED (
    SELECT e.*,v.id live_voucher_id,v.code live_voucher_code,v.approval_status live_voucher_status,
      CASE WHEN v.id IS NOT NULL THEN 'VOUCHER_CREATED' WHEN last.action='NOT_APPLICABLE' THEN 'NOT_APPLICABLE'
        WHEN last.action='COMPLETED' THEN 'PENDING'
        WHEN last.action='FAILED' THEN 'FAILED'
        WHEN last.action='ATTEMPTED' AND last.created_at > now()-interval '5 minutes' THEN 'PROCESSING'
        WHEN last.action='ATTEMPTED' THEN 'UNKNOWN' ELSE 'PENDING' END state,
      last.request_id,attempt.created_at attempted_at,
      last.reason last_reason,last.created_at last_at,last.actor_name last_actor,last.actor_id last_actor_id,last.amount attempted_amount
    FROM eligible e
    LEFT JOIN live_vouchers v ON v.contract_id=e.contract_id AND v.kind=e.kind
    LEFT JOIN LATERAL app_private.contract_commission_latest_event_v1(p_organization_id,e.contract_id,e.kind) last ON true
    LEFT JOIN public.contract_commission_events attempt ON attempt.organization_id=p_organization_id
      AND attempt.contract_id=e.contract_id AND attempt.kind=e.kind AND attempt.request_id=last.request_id AND attempt.action='ATTEMPTED'
  ), filtered AS MATERIALIZED (
    SELECT * FROM states WHERE (NOT p_unresolved_only OR (state IN ('FAILED','UNKNOWN') AND attempted_at IS NOT NULL))
      AND (p_kind IS NULL OR kind=p_kind)
      AND (nullif(btrim(p_search),'') IS NULL OR strpos(lower(concat_ws(' ',contract_number,building_name,room_name)),lower(btrim(p_search)))>0)
      AND (p_period_from IS NULL OR (attempted_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date>=p_period_from)
      AND (p_period_to IS NULL OR (attempted_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date<=p_period_to)
  ), page AS (
    SELECT * FROM filtered
    ORDER BY CASE WHEN state IN ('FAILED','UNKNOWN') THEN 0 ELSE 1 END,last_at DESC NULLS LAST,contract_id,kind
    LIMIT p_limit OFFSET p_offset
  ), projected AS (
    SELECT p.contract_id,p.contract_number,p.building_id,p.building_name,p.room_name,p.kind,p.state,p.request_id,p.attempted_at,
      EXISTS(SELECT 1 FROM public.contract_commission_requests req WHERE req.organization_id=p_organization_id AND req.contract_id=p.contract_id AND req.kind=p.kind AND req.request_id=p.request_id) AND p.can_manage AND p.state IN ('FAILED','UNKNOWN') can_retry,
      CASE WHEN last_visible.ok THEN p.last_reason END last_reason,p.last_at,p.last_actor,p.can_manage,
      CASE WHEN last_visible.ok THEN p.attempted_amount END attempted_amount,
      CASE WHEN visible.ok THEN p.live_voucher_id END voucher_id,
      CASE WHEN visible.ok THEN p.live_voucher_code END voucher_code,
      CASE WHEN visible.ok THEN p.live_voucher_status END voucher_status,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('action',h.action,'reason',CASE WHEN h.read_financial THEN h.reason END,
        'amount',CASE WHEN h.read_financial THEN h.amount END,'actor_name',h.actor_name,'created_at',h.created_at) ORDER BY h.event_order)
        FROM (SELECT ev.*,visible.ok OR (p.live_voucher_id IS NULL AND p.can_read_finance
            AND (p.can_read_org_finance OR ev.actor_id=auth.uid())) read_financial
          FROM public.contract_commission_events ev
          WHERE ev.organization_id=p_organization_id AND ev.contract_id=p.contract_id AND ev.kind=p.kind) h),'[]'::jsonb) events
    FROM page p
    CROSS JOIN LATERAL (SELECT p.can_read_finance AND p.live_voucher_id IS NOT NULL
      AND app_private.ie_supplement_can_read_v1(p.live_voucher_id) AS ok) visible
    -- A hidden live voucher also hides financial history (including free text).
    -- Before a voucher exists, only its author or an org-wide finance reader can
    -- read these fields, and both still need scoped financial read permission.
    CROSS JOIN LATERAL (SELECT visible.ok OR (p.live_voucher_id IS NULL AND p.can_read_finance
      AND (p.can_read_org_finance OR p.last_actor_id=auth.uid())) AS ok) last_visible
  )
  SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(to_jsonb(projected)
      ORDER BY CASE WHEN state IN ('FAILED','UNKNOWN') THEN 0 ELSE 1 END,last_at DESC NULLS LAST,contract_id,kind) FROM projected),'[]'::jsonb),
    'total',(SELECT count(*) FROM filtered)) INTO result;
  RETURN result;
END
$fn$;


CREATE OR REPLACE FUNCTION public.list_contract_commission_followups_v1(p_organization_id uuid,p_contract_ids uuid[] DEFAULT NULL,p_building_ids uuid[] DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 50,p_unresolved_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
 WITH result AS (SELECT public.list_contract_commission_followups_v2(p_organization_id,p_contract_ids,p_building_ids,p_offset,p_limit,p_unresolved_only) value)
 SELECT jsonb_build_object('total',value->'total','rows',COALESCE((
  SELECT jsonb_agg((row-'events')||jsonb_build_object(
   'state',CASE WHEN row->>'state'='PROCESSING' THEN 'PENDING' ELSE row->>'state' END,
   'events',COALESCE((SELECT jsonb_agg(event) FROM jsonb_array_elements(row->'events') event WHERE event->>'action'<>'COMPLETED'),'[]'::jsonb)))
  FROM jsonb_array_elements(value->'rows') row),'[]'::jsonb)) FROM result;
$fn$;
ALTER FUNCTION app_private.authorize_commission_request_v1(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.authorize_commission_request_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION public.prepare_commission_requests_v1(uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prepare_commission_requests_v1(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.prepare_commission_requests_v1(uuid,jsonb) TO authenticated;
ALTER FUNCTION public.execute_commission_request_v1(uuid,uuid,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.execute_commission_request_v1(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.execute_commission_request_v1(uuid,uuid,text,uuid) TO authenticated;
ALTER FUNCTION public.list_contract_commission_followups_v2(uuid,uuid[],uuid[],integer,integer,boolean,text,text,date,date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_contract_commission_followups_v2(uuid,uuid[],uuid[],integer,integer,boolean,text,text,date,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.list_contract_commission_followups_v2(uuid,uuid[],uuid[],integer,integer,boolean,text,text,date,date) TO authenticated;
NOTIFY pgrst, 'reload schema';

-- Legacy open tabs still call the canonical writer directly. Record completion
-- in that SAME transaction after items/approval/postings have all succeeded.
ALTER TABLE public.contract_commission_events ADD COLUMN IF NOT EXISTS voucher_id uuid;
CREATE OR REPLACE FUNCTION app_private.complete_commission_attempt_v1(p_org uuid,p_contract uuid,p_kind text,p_amount numeric,p_voucher uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE latest public.contract_commission_events;
BEGIN
 SELECT * INTO latest FROM app_private.contract_commission_latest_event_v1(p_org,p_contract,p_kind);
 IF latest.action IN ('ATTEMPTED','FAILED') AND latest.actor_id=auth.uid() AND latest.amount=p_amount
  AND NOT EXISTS(SELECT 1 FROM public.contract_commission_requests r WHERE r.organization_id=p_org AND r.contract_id=p_contract AND r.kind=p_kind AND r.request_id=latest.request_id)
  AND EXISTS(SELECT 1 FROM public.income_expenses v WHERE v.id=p_voucher AND v.organization_id=p_org AND v.contract_id=p_contract AND v.commission_kind=p_kind) THEN
  INSERT INTO public.contract_commission_events(organization_id,contract_id,building_id,kind,action,request_id,amount,actor_id,actor_name,voucher_id)
  VALUES(p_org,p_contract,latest.building_id,p_kind,'COMPLETED',latest.request_id,p_amount,auth.uid(),latest.actor_name,p_voucher)
  ON CONFLICT DO NOTHING;
 END IF;
END $fn$;
ALTER FUNCTION app_private.complete_commission_attempt_v1(uuid,uuid,text,numeric,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.complete_commission_attempt_v1(uuid,uuid,text,numeric,uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $patch$
DECLARE body text; anchor constant text:='RETURN jsonb_build_object(''id'', v_id, ''code'', v_code);';
 bridge constant text:='PERFORM app_private.complete_commission_attempt_v1(v_contract.organization_id,p_contract_id,p_kind,p_amount,v_id);';
BEGIN
 SELECT pg_get_functiondef('public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb)'::regprocedure) INTO body;
 IF strpos(body,bridge)=0 THEN
  IF (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Canonical commission writer anchor differs; review installed body before applying'; END IF;
  EXECUTE replace(body,anchor,bridge||chr(10)||'  '||anchor);
 END IF;
END $patch$;
NOTIFY pgrst, 'reload schema';
