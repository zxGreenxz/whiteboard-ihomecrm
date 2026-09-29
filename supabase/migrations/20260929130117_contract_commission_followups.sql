-- Durable operational follow-up only. A live voucher is evidence of creation,
-- never payment; absent history remains PENDING, including older contracts.
CREATE TABLE IF NOT EXISTS public.contract_commission_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL,
  building_id uuid NOT NULL REFERENCES public.buildings(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('broker','sale')),
  action text NOT NULL CHECK (action IN ('ATTEMPTED','FAILED','NOT_APPLICABLE','REOPENED')),
  request_id uuid NOT NULL,
  amount numeric CHECK (amount > 0 AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
  reason text CHECK (length(reason)<=2000),
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_name text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id,contract_id) REFERENCES public.contracts(organization_id,id) ON DELETE RESTRICT,
  UNIQUE(organization_id,contract_id,kind,request_id,action),
  CHECK (action NOT IN ('FAILED','NOT_APPLICABLE') OR length(btrim(reason))>0 AND reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS contract_commission_events_subject_idx
  ON public.contract_commission_events(organization_id,contract_id,kind,event_order DESC);

CREATE OR REPLACE FUNCTION app_private.guard_contract_commission_events_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN RAISE EXCEPTION 'Commission history is append-only' USING ERRCODE='42501'; END
$fn$;
DROP TRIGGER IF EXISTS guard_contract_commission_events ON public.contract_commission_events;
CREATE TRIGGER guard_contract_commission_events BEFORE UPDATE OR DELETE ON public.contract_commission_events
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_contract_commission_events_v1();
DROP TRIGGER IF EXISTS guard_contract_commission_events_truncate ON public.contract_commission_events;
CREATE TRIGGER guard_contract_commission_events_truncate BEFORE TRUNCATE ON public.contract_commission_events
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_contract_commission_events_v1();

-- One scoped read predicate for RPCs and direct event RLS. No administrator bypass.
CREATE OR REPLACE FUNCTION app_private.contract_commission_scope_v1(p_org uuid,p_building uuid,p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT auth.uid() IS NOT NULL AND COALESCE(p_org=ANY(public.my_org_ids()),false)
    AND COALESCE(public.can_access_building(p_building),false)
    AND NOT COALESCE(public.is_super_admin() AND p_org=ANY(public.sandbox_org_ids()),false)
    AND EXISTS(SELECT 1 FROM app_private.authorized_scope_v3(p_permission,p_org) a
      WHERE a.org_wide OR p_building=ANY(a.building_ids));
$fn$;

CREATE OR REPLACE FUNCTION app_private.contract_commission_can_manage_v1(p_org uuid,p_building uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT app_private.contract_commission_scope_v1(p_org,p_building,'contracts.view')
    AND (app_private.contract_commission_scope_v1(p_org,p_building,'contracts.create')
      OR app_private.contract_commission_scope_v1(p_org,p_building,'contracts.edit'))
    AND app_private.contract_commission_scope_v1(p_org,p_building,'income_expenses.create');
$fn$;

CREATE OR REPLACE FUNCTION app_private.contract_commission_event_readable_v1(p_org uuid,p_contract uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT auth.uid() IS NOT NULL AND EXISTS(
    SELECT 1 FROM public.contracts c
    JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id AND r.deleted_at IS NULL
    JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=c.organization_id AND b.deleted_at IS NULL
    WHERE c.organization_id=p_org AND c.id=p_contract AND c.deleted_at IS NULL
      AND app_private.contract_commission_scope_v1(p_org,b.id,'contracts.view')
      AND app_private.contract_commission_scope_v1(p_org,b.id,'income_expenses.view'));
$fn$;

REVOKE ALL ON public.contract_commission_events FROM PUBLIC,anon,authenticated,service_role;
-- Clients read only the redacted RPC projection; raw amount/reason are private.
ALTER TABLE public.contract_commission_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_commission_events_scope_select ON public.contract_commission_events;
CREATE POLICY contract_commission_events_scope_select ON public.contract_commission_events FOR SELECT TO authenticated
  USING (app_private.contract_commission_event_readable_v1(organization_id,contract_id));
DROP POLICY IF EXISTS contract_commission_events_hide_sandbox_admin ON public.contract_commission_events;
CREATE POLICY contract_commission_events_hide_sandbox_admin ON public.contract_commission_events AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT (public.is_super_admin() AND COALESCE(organization_id=ANY(public.sandbox_org_ids()),false)));

-- Includes Sale created before signing, when the bonus has no contract_id and
-- the deposit subsequently points at the signed contract. Every edge stays in org.
CREATE OR REPLACE FUNCTION app_private.contract_commission_live_voucher_v1(p_org uuid,p_contract uuid,p_kind text)
RETURNS TABLE(id uuid,code text,approval_status text) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT v.id,v.code,v.approval_status::text
  FROM public.income_expenses v
  WHERE v.organization_id=p_org AND v.deleted_at IS NULL AND v.approval_status IS DISTINCT FROM 'CANCELLED'
    AND ((v.contract_id=p_contract AND v.commission_kind=p_kind)
      OR (p_kind='sale' AND EXISTS(
        SELECT 1 FROM app_private.sale_bonus_claims claim
        JOIN public.income_expenses dep ON dep.id=claim.deposit_voucher_id AND dep.organization_id=claim.organization_id
        WHERE claim.organization_id=p_org AND claim.bonus_voucher_id=v.id AND dep.contract_id=p_contract)))
  ORDER BY v.created_at DESC,v.id LIMIT 1;
$fn$;

-- A late FAILED belongs to its own ATTEMPTED. It must not supersede a more recent
-- attempt/decision/reopen. Audit still returns that late event without mutation.
CREATE OR REPLACE FUNCTION app_private.contract_commission_latest_event_v1(p_org uuid,p_contract uuid,p_kind text)
RETURNS SETOF public.contract_commission_events LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT e.* FROM public.contract_commission_events e
  WHERE e.organization_id=p_org AND e.contract_id=p_contract AND e.kind=p_kind
    AND (e.action<>'FAILED' OR EXISTS(
      SELECT 1 FROM public.contract_commission_events attempt
      WHERE attempt.organization_id=e.organization_id AND attempt.contract_id=e.contract_id AND attempt.kind=e.kind
        AND attempt.request_id=e.request_id AND attempt.action='ATTEMPTED'
        AND NOT EXISTS(SELECT 1 FROM public.contract_commission_events later
          WHERE later.organization_id=e.organization_id AND later.contract_id=e.contract_id AND later.kind=e.kind
            AND later.action<>'FAILED' AND later.event_order>attempt.event_order)))
  ORDER BY e.event_order DESC LIMIT 1;
$fn$;

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
  IF p_action IN ('ATTEMPTED','NOT_APPLICABLE') AND EXISTS(
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

CREATE OR REPLACE FUNCTION public.list_contract_commission_followups_v1(
  p_organization_id uuid,p_contract_ids uuid[] DEFAULT NULL,p_building_ids uuid[] DEFAULT NULL,
  p_offset integer DEFAULT 0,p_limit integer DEFAULT 50,p_unresolved_only boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501';
  END IF;
  IF p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_unresolved_only IS NULL
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
        WHEN last.action='FAILED' THEN 'FAILED' WHEN last.action='ATTEMPTED' THEN 'UNKNOWN' ELSE 'PENDING' END state,
      last.reason last_reason,last.created_at last_at,last.actor_name last_actor,last.actor_id last_actor_id,last.amount attempted_amount
    FROM eligible e
    LEFT JOIN live_vouchers v ON v.contract_id=e.contract_id AND v.kind=e.kind
    LEFT JOIN LATERAL app_private.contract_commission_latest_event_v1(p_organization_id,e.contract_id,e.kind) last ON true
  ), filtered AS MATERIALIZED (
    SELECT * FROM states WHERE NOT p_unresolved_only OR state NOT IN ('VOUCHER_CREATED','NOT_APPLICABLE')
  ), page AS (
    SELECT * FROM filtered
    ORDER BY CASE WHEN state IN ('FAILED','UNKNOWN') THEN 0 ELSE 1 END,last_at DESC NULLS LAST,contract_id,kind
    LIMIT p_limit OFFSET p_offset
  ), projected AS (
    SELECT p.contract_id,p.contract_number,p.building_id,p.building_name,p.room_name,p.kind,p.state,
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

ALTER FUNCTION app_private.guard_contract_commission_events_v1() OWNER TO postgres;
ALTER FUNCTION app_private.contract_commission_scope_v1(uuid,uuid,text) OWNER TO postgres;
ALTER FUNCTION app_private.contract_commission_can_manage_v1(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION app_private.contract_commission_event_readable_v1(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION app_private.contract_commission_live_voucher_v1(uuid,uuid,text) OWNER TO postgres;
ALTER FUNCTION app_private.contract_commission_latest_event_v1(uuid,uuid,text) OWNER TO postgres;
ALTER FUNCTION public.record_contract_commission_event_v1(uuid,uuid,text,text,uuid,numeric,text) OWNER TO postgres;
ALTER FUNCTION public.list_contract_commission_followups_v1(uuid,uuid[],uuid[],integer,integer,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.guard_contract_commission_events_v1() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION app_private.contract_commission_scope_v1(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION app_private.contract_commission_can_manage_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION app_private.contract_commission_event_readable_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION app_private.contract_commission_live_voucher_v1(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION app_private.contract_commission_latest_event_v1(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.record_contract_commission_event_v1(uuid,uuid,text,text,uuid,numeric,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.list_contract_commission_followups_v1(uuid,uuid[],uuid[],integer,integer,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_contract_commission_event_v1(uuid,uuid,text,text,uuid,numeric,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_contract_commission_followups_v1(uuid,uuid[],uuid[],integer,integer,boolean) TO authenticated;
