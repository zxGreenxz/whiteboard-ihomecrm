-- Trả phòng trước hạn: ba trường hợp (nhờ sale tìm khách sang phòng, tự tìm khách sang phòng, chủ nhà hỗ trợ
-- thanh lý sớm), giữ phòng cho khách nhận, phí môi giới ở quyết toán và phiếu hoa hồng theo trường hợp.
-- Plan "Sang nhượng phòng trong hộp Thanh lý", đợt 2, phần máy chủ (chủ duyệt 24/11/2026).
--
-- Giữ nguyên: confirm_contract_return_v1 (Hermes gọi), bảng contract_transfer_links và các RPC cũ của nó,
-- máy tính quyết toán, giá trị status_public/sale_state. Không thêm cột vào contract_exit_cases.
-- Năm hàm hiện hành chỉ được nối thêm bằng neo (mỗi neo phải xuất hiện đúng một lần, chạy lại thì bỏ qua):
--   finalize_contract_exit_case_v1, app_private.room_sale_workflow_fact_v1, create_commission_voucher,
--   get_my_available_rooms, get_sale_room_inventory_v1, real_estate_renewals_transfers_v1.

DO $requires$
BEGIN
  IF to_regclass('public.contract_exit_cases') IS NULL OR to_regclass('public.contract_commission_events') IS NULL
    OR to_regclass('public.notifications') IS NULL OR to_regclass('public.room_next_claims') IS NULL
    OR to_regprocedure('public.confirm_contract_return_v1(uuid,uuid,timestamp with time zone,text,date,text,text,jsonb,jsonb,text)') IS NULL
    OR to_regprocedure('public.finalize_contract_exit_case_v1(uuid,uuid,bigint,text,text,text,jsonb)') IS NULL
    OR to_regprocedure('app_private.room_sale_workflow_fact_v1(uuid,uuid,text,boolean,integer)') IS NULL
    OR to_regprocedure('public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb)') IS NULL
    OR to_regprocedure('public.get_my_available_rooms()') IS NULL
    OR to_regprocedure('public.get_sale_room_inventory_v1(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('public.real_estate_renewals_transfers_v1(uuid,uuid[],date,date)') IS NULL
    OR to_regprocedure('app_private.assert_contract_exit_writer_v1(uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.require_building_perm_v1(uuid,text,text[])') IS NULL
    OR to_regprocedure('app_private.has_building_perm_v1(uuid,text[])') IS NULL
    OR to_regprocedure('app_private.contract_draft_scope_allowed(uuid,uuid,text)') IS NULL
    OR to_regprocedure('app_private.lock_org_for_decision_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.contract_commission_live_voucher_v1(uuid,uuid,text)') IS NULL
    OR to_regprocedure('app_private.begin_commission_reason_v1(uuid,uuid,text,text,text,jsonb)') IS NULL
    OR to_regprocedure('public.room_has_holding_deposit(uuid)') IS NULL
    OR to_regprocedure('public.org_today_v1(uuid)') IS NULL
    OR to_regprocedure('public.my_org_ids()') IS NULL THEN
    RAISE EXCEPTION 'tra_phong_truoc_han_thieu_phu_thuoc' USING ERRCODE='55000';
  END IF;
END
$requires$;

-- 1. Mốc bật tính năng: hồ sơ trả phòng tạo trước mốc không bị ép chọn trường hợp.
CREATE TABLE IF NOT EXISTS app_private.feature_cutovers (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{2,63}$'),
  at timestamptz NOT NULL
);
ALTER TABLE app_private.feature_cutovers OWNER TO postgres;
ALTER TABLE app_private.feature_cutovers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.feature_cutovers FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO app_private.feature_cutovers(key,at) VALUES('exit_early_terms',clock_timestamp()) ON CONFLICT (key) DO NOTHING;

-- 2. Một dòng cho mỗi hồ sơ trả phòng trước hạn. Ghi chỉ qua RPC; đọc theo toà (contracts.view).
CREATE TABLE IF NOT EXISTS public.contract_exit_early_terms (
  exit_case_id uuid PRIMARY KEY REFERENCES public.contract_exit_cases(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL UNIQUE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  building_id uuid NOT NULL REFERENCES public.buildings(id) ON DELETE RESTRICT,
  room_id uuid NOT NULL,
  early_reason text NOT NULL CHECK (early_reason IN ('SALE_ASSISTED','SELF_FOUND','LANDLORD_AGREEMENT')),
  sale_name text CHECK (sale_name IS NULL OR char_length(btrim(sale_name)) BETWEEN 1 AND 200),
  deposit_base numeric NOT NULL DEFAULT 0 CHECK (deposit_base>=0),
  broker_fee numeric NOT NULL DEFAULT 0 CHECK (broker_fee>=0 AND broker_fee::text NOT IN ('NaN','Infinity')),
  fee_applied_at timestamptz,
  hold_until timestamptz,
  reopened_at timestamptz,
  reopened_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  expiry_notified_at timestamptz,
  new_contract_id uuid UNIQUE,
  linked_at timestamptz,
  support_amount numeric NOT NULL DEFAULT 0 CHECK (support_amount>=0 AND support_amount::text NOT IN ('NaN','Infinity')),
  support_out_voucher_id uuid REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  support_in_voucher_id uuid REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  commission_voucher_id uuid UNIQUE REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id,contract_id) REFERENCES public.contracts(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,new_contract_id) REFERENCES public.contracts(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,room_id) REFERENCES public.rooms(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT contract_exit_early_terms_sale_name CHECK ((early_reason='SALE_ASSISTED')=(sale_name IS NOT NULL)),
  CONSTRAINT contract_exit_early_terms_fee CHECK (early_reason='SALE_ASSISTED' OR broker_fee=0),
  CONSTRAINT contract_exit_early_terms_hold CHECK (early_reason='LANDLORD_AGREEMENT' OR hold_until IS NOT NULL),
  CONSTRAINT contract_exit_early_terms_link CHECK ((new_contract_id IS NULL)=(linked_at IS NULL) AND new_contract_id IS DISTINCT FROM contract_id),
  CONSTRAINT contract_exit_early_terms_landlord_unlinked CHECK (early_reason<>'LANDLORD_AGREEMENT' OR new_contract_id IS NULL),
  CONSTRAINT contract_exit_early_terms_reopen CHECK ((reopened_at IS NULL)=(reopened_by IS NULL)),
  CONSTRAINT contract_exit_early_terms_commission CHECK (commission_voucher_id IS NULL OR early_reason='SALE_ASSISTED')
);
CREATE INDEX IF NOT EXISTS contract_exit_early_terms_pending_room_idx
  ON public.contract_exit_early_terms(organization_id,room_id) WHERE new_contract_id IS NULL AND reopened_at IS NULL;
CREATE INDEX IF NOT EXISTS contract_exit_early_terms_hold_expiry_idx
  ON public.contract_exit_early_terms(hold_until) WHERE new_contract_id IS NULL AND reopened_at IS NULL AND expiry_notified_at IS NULL;

CREATE TABLE IF NOT EXISTS app_private.contract_exit_early_term_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  exit_case_id uuid NOT NULL REFERENCES public.contract_exit_early_terms(exit_case_id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  event text NOT NULL CHECK (event IN ('CREATED','CASE_CHANGED','FEE_CHANGED','HOLD_REOPENED','HOLD_EXTENDED','HOLD_EXPIRED_NOTIFIED',
    'NEW_CONTRACT_LINKED','FEE_APPLIED','COMMISSION_LINKED','SUPPORT_APPLIED','SUPPORT_REVERSED')),
  version bigint NOT NULL CHECK (version>0),
  actor_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000),
  request_id uuid UNIQUE,
  intent_hash text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS contract_exit_early_term_events_case_idx
  ON app_private.contract_exit_early_term_events(exit_case_id,event_order);

-- Hoa hồng môi giới của khách nhận (ca nhờ sale) chỉ đi qua create_contract_exit_commission_v1: giấy phép
-- chỉ sống trong đúng giao dịch và tiến trình đang ghi, như rent_support_payout_authorizations.
CREATE TABLE IF NOT EXISTS app_private.contract_exit_commission_authorizations (
  organization_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind='broker'),
  exit_case_id uuid NOT NULL,
  net numeric NOT NULL CHECK (net>0),
  xid xid8 NOT NULL,
  backend_pid integer NOT NULL,
  PRIMARY KEY (organization_id,contract_id,kind)
);

CREATE OR REPLACE FUNCTION app_private.guard_contract_exit_early_terms_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Hồ sơ trường hợp trả phòng không xoá được' USING ERRCODE='42501';
  END IF;
  IF NEW.exit_case_id<>OLD.exit_case_id OR NEW.contract_id<>OLD.contract_id OR NEW.organization_id<>OLD.organization_id
    OR NEW.building_id<>OLD.building_id OR NEW.room_id<>OLD.room_id OR NEW.created_by<>OLD.created_by
    OR NEW.created_at<>OLD.created_at OR NEW.version<OLD.version
    OR (OLD.commission_voucher_id IS NOT NULL AND NEW.commission_voucher_id IS DISTINCT FROM OLD.commission_voucher_id) THEN
    RAISE EXCEPTION 'Cột định danh của hồ sơ trường hợp trả phòng không đổi được' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS guard_contract_exit_early_terms ON public.contract_exit_early_terms;
CREATE TRIGGER guard_contract_exit_early_terms BEFORE UPDATE OR DELETE ON public.contract_exit_early_terms
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_contract_exit_early_terms_v1();
DROP TRIGGER IF EXISTS guard_contract_exit_early_terms_truncate ON public.contract_exit_early_terms;
CREATE TRIGGER guard_contract_exit_early_terms_truncate BEFORE TRUNCATE ON public.contract_exit_early_terms
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_contract_exit_early_terms_v1();

CREATE OR REPLACE FUNCTION app_private.guard_contract_exit_early_term_events_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
  RAISE EXCEPTION 'Lịch sử trường hợp trả phòng chỉ được ghi thêm' USING ERRCODE='42501';
END
$fn$;
DROP TRIGGER IF EXISTS guard_contract_exit_early_term_events ON app_private.contract_exit_early_term_events;
CREATE TRIGGER guard_contract_exit_early_term_events BEFORE UPDATE OR DELETE ON app_private.contract_exit_early_term_events
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_contract_exit_early_term_events_v1();
DROP TRIGGER IF EXISTS guard_contract_exit_early_term_events_truncate ON app_private.contract_exit_early_term_events;
CREATE TRIGGER guard_contract_exit_early_term_events_truncate BEFORE TRUNCATE ON app_private.contract_exit_early_term_events
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.guard_contract_exit_early_term_events_v1();

ALTER TABLE public.contract_exit_early_terms OWNER TO postgres;
ALTER TABLE app_private.contract_exit_early_term_events OWNER TO postgres;
ALTER TABLE app_private.contract_exit_commission_authorizations OWNER TO postgres;
ALTER TABLE public.contract_exit_early_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.contract_exit_early_term_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.contract_exit_commission_authorizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_exit_early_terms_org_boundary ON public.contract_exit_early_terms;
CREATE POLICY contract_exit_early_terms_org_boundary ON public.contract_exit_early_terms AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_super_admin()) OR organization_id IN (SELECT pg_catalog.unnest(public.my_org_ids())))
  WITH CHECK ((SELECT public.is_super_admin()) OR organization_id IN (SELECT pg_catalog.unnest(public.my_org_ids())));
DROP POLICY IF EXISTS contract_exit_early_terms_hide_sandbox_admin ON public.contract_exit_early_terms;
CREATE POLICY contract_exit_early_terms_hide_sandbox_admin ON public.contract_exit_early_terms AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT COALESCE(public.is_super_admin() AND organization_id=ANY(public.sandbox_org_ids()),false))
  WITH CHECK (NOT COALESCE(public.is_super_admin() AND organization_id=ANY(public.sandbox_org_ids()),false));
DROP POLICY IF EXISTS contract_exit_early_terms_read ON public.contract_exit_early_terms;
CREATE POLICY contract_exit_early_terms_read ON public.contract_exit_early_terms FOR SELECT TO authenticated
  USING (app_private.contract_draft_scope_allowed(organization_id,building_id,'contracts.view'));
REVOKE ALL ON public.contract_exit_early_terms FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.contract_exit_early_terms TO authenticated;
REVOKE ALL ON app_private.contract_exit_early_term_events,app_private.contract_exit_commission_authorizations
  FROM PUBLIC,anon,authenticated,service_role;

-- 3. Hàm nội bộ.
CREATE OR REPLACE FUNCTION app_private.contract_exit_early_terms_response_v1(p_case uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT jsonb_build_object(
      'exit_case_id',t.exit_case_id,'contract_id',t.contract_id,'organization_id',t.organization_id,
      'building_id',t.building_id,'room_id',t.room_id,'early_reason',t.early_reason,'sale_name',t.sale_name,
      'deposit_base',t.deposit_base,'broker_fee',t.broker_fee,'fee_applied_at',t.fee_applied_at,
      'hold_until',t.hold_until,'reopened_at',t.reopened_at,'reopened_by',t.reopened_by,
      'reopened_by_name',rp.full_name,'expiry_notified_at',t.expiry_notified_at,
      'new_contract_id',t.new_contract_id,'new_contract_number',nc.contract_number,'linked_at',t.linked_at,
      'new_contract_deposit_paid',nc.deposit_paid,'new_contract_total_deposit',nc.total_deposit,
      'support_amount',t.support_amount,'support_out_voucher_id',t.support_out_voucher_id,
      'support_in_voucher_id',t.support_in_voucher_id,'commission_voucher_id',t.commission_voucher_id,
      'commission_code',v.code,'commission_approval_status',v.approval_status)
    || jsonb_build_object(
      'version',t.version,'created_by',t.created_by,'created_by_name',cp.full_name,
      'created_at',t.created_at,'updated_at',t.updated_at,
      'old_contract_number',e.contract_number,'old_customer_name',e.customer_name,
      'building_name',e.building_name,'room_name',e.room_name,'actual_move_out_on',e.actual_move_out_on,
      'exit_state',e.state,'exit_version',e.version,'current_kind',e.current_kind,
      'old_contract_deposit_paid',oc.deposit_paid,
      'pending_link',(t.early_reason IN ('SALE_ASSISTED','SELF_FOUND') AND t.new_contract_id IS NULL
        AND t.reopened_at IS NULL AND e.state='PENDING'),
      'hold_open',(t.early_reason IN ('SALE_ASSISTED','SELF_FOUND') AND t.new_contract_id IS NULL
        AND t.reopened_at IS NULL AND e.state='PENDING' AND t.hold_until>now()),
      'history',COALESCE((SELECT jsonb_agg(jsonb_build_object('event',h.event,'version',h.version,'reason',h.reason,
          'actor_id',h.actor_id,'actor_name',ap.full_name,'payload',h.payload,'created_at',h.created_at) ORDER BY h.event_order)
        FROM app_private.contract_exit_early_term_events h LEFT JOIN public.profiles ap ON ap.id=h.actor_id
        WHERE h.exit_case_id=t.exit_case_id),'[]'::jsonb))
  FROM public.contract_exit_early_terms t
  JOIN public.contract_exit_cases e ON e.id=t.exit_case_id
  LEFT JOIN public.contracts oc ON oc.id=t.contract_id
  LEFT JOIN public.contracts nc ON nc.id=t.new_contract_id
  LEFT JOIN public.income_expenses v ON v.id=t.commission_voucher_id
  LEFT JOIN public.profiles cp ON cp.id=t.created_by
  LEFT JOIN public.profiles rp ON rp.id=t.reopened_by
  WHERE t.exit_case_id=p_case
$fn$;

CREATE OR REPLACE FUNCTION app_private.contract_exit_early_term_event_v1(p_case uuid,p_event text,p_reason text,
  p_request uuid DEFAULT NULL,p_hash text DEFAULT NULL,p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  INSERT INTO app_private.contract_exit_early_term_events(exit_case_id,organization_id,event,version,actor_id,reason,request_id,intent_hash,payload)
  SELECT t.exit_case_id,t.organization_id,p_event,t.version,auth.uid(),btrim(p_reason),p_request,p_hash,COALESCE(p_payload,'{}'::jsonb)
  FROM public.contract_exit_early_terms t WHERE t.exit_case_id=p_case;
END
$fn$;

-- Ca tự tìm: hợp đồng khách nhận không có hoa hồng môi giới hay thưởng sale. Ghi theo đúng sổ theo dõi
-- hoa hồng (contract_commission_events) để list_contract_commission_followups_v2 không nhắc nữa.
CREATE OR REPLACE FUNCTION app_private.contract_exit_early_terms_mark_commission_v1(p_case uuid,p_action text,p_strict boolean)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE t public.contract_exit_early_terms%ROWTYPE; k text; v_actor uuid; v_name text;
BEGIN
  SELECT * INTO t FROM public.contract_exit_early_terms WHERE exit_case_id=p_case;
  IF NOT FOUND OR t.new_contract_id IS NULL OR p_action NOT IN ('NOT_APPLICABLE','REOPENED') THEN RETURN; END IF;
  v_actor:=COALESCE(auth.uid(),t.created_by);
  SELECT NULLIF(btrim(p.full_name),'') INTO v_name FROM public.profiles p WHERE p.id=v_actor;
  FOREACH k IN ARRAY ARRAY['broker','sale'] LOOP
    IF p_action='NOT_APPLICABLE' AND EXISTS(SELECT 1 FROM app_private.contract_commission_live_voucher_v1(t.organization_id,t.new_contract_id,k)) THEN
      IF p_strict THEN
        RAISE EXCEPTION 'Hợp đồng khách nhận đã có phiếu hoa hồng hoặc thưởng sale; huỷ phiếu trước khi chọn tự tìm khách sang phòng' USING ERRCODE='55000';
      END IF;
      CONTINUE;
    END IF;
    INSERT INTO public.contract_commission_events(organization_id,contract_id,building_id,kind,action,request_id,amount,reason,actor_id,actor_name)
    VALUES(t.organization_id,t.new_contract_id,t.building_id,k,p_action,
      md5('exit-early-terms:'||p_action||':'||t.exit_case_id::text||':'||t.new_contract_id::text||':'||k||':'||t.version::text)::uuid,NULL,
      CASE WHEN p_action='NOT_APPLICABLE'
        THEN 'Khách tự tìm sang phòng (hồ sơ trả phòng HĐ '||COALESCE((SELECT e.contract_number FROM public.contract_exit_cases e WHERE e.id=t.exit_case_id),'')||'): không hoa hồng môi giới, không thưởng sale'
        ELSE 'Đổi trường hợp trả phòng trước hạn: mở lại theo dõi hoa hồng' END,
      v_actor,v_name)
    ON CONFLICT (organization_id,contract_id,kind,request_id,action) DO NOTHING;
  END LOOP;
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.contract_exit_early_terms_link_v1(p_case uuid,p_contract uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE t public.contract_exit_early_terms%ROWTYPE;
BEGIN
  UPDATE public.contract_exit_early_terms SET new_contract_id=p_contract,linked_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
    WHERE exit_case_id=p_case AND new_contract_id IS NULL AND early_reason IN ('SALE_ASSISTED','SELF_FOUND') RETURNING * INTO t;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM app_private.contract_exit_early_term_event_v1(t.exit_case_id,'NEW_CONTRACT_LINKED',
    'Hợp đồng mới đầu tiên của phòng tự nối với hồ sơ trả phòng',NULL,NULL,
    jsonb_build_object('new_contract_id',p_contract,'contract_number',(SELECT c.contract_number FROM public.contracts c WHERE c.id=p_contract)));
  IF t.early_reason='SELF_FOUND' THEN
    PERFORM app_private.contract_exit_early_terms_mark_commission_v1(t.exit_case_id,'NOT_APPLICABLE',false);
  END IF;
END
$fn$;

-- Phân loại sau (Hermes ghi bằng v1) hoặc đổi lại trường hợp: nối hợp đồng mới đầu tiên đã có của phòng.
CREATE OR REPLACE FUNCTION app_private.contract_exit_early_terms_link_existing_v1(p_case uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE t public.contract_exit_early_terms%ROWTYPE; e public.contract_exit_cases%ROWTYPE; v_contract uuid;
BEGIN
  SELECT * INTO t FROM public.contract_exit_early_terms WHERE exit_case_id=p_case;
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=p_case;
  IF t.exit_case_id IS NULL OR e.id IS NULL OR t.early_reason NOT IN ('SALE_ASSISTED','SELF_FOUND') OR t.new_contract_id IS NOT NULL
    OR t.reopened_at IS NOT NULL OR e.state<>'PENDING' THEN RETURN; END IF;
  SELECT c.id INTO v_contract FROM public.contracts c
  WHERE c.organization_id=t.organization_id AND c.room_id=t.room_id AND c.id<>t.contract_id AND c.deleted_at IS NULL
    AND c.status IN ('ACTIVE','EXTENDED') AND c.start_date>=e.actual_move_out_on AND c.created_at>=e.created_at
    AND NOT EXISTS (SELECT 1 FROM public.contract_exit_early_terms x WHERE x.new_contract_id=c.id)
  ORDER BY c.created_at,c.id LIMIT 1;
  IF v_contract IS NOT NULL THEN PERFORM app_private.contract_exit_early_terms_link_v1(p_case,v_contract); END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.contract_exit_early_terms_create_v1(p_case uuid,p_early_reason text,p_sale_name text,
  p_reason text,p_request uuid,p_hash text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE e public.contract_exit_cases%ROWTYPE; c public.contracts%ROWTYPE; t public.contract_exit_early_terms%ROWTYPE; v_base numeric; v_fee numeric;
BEGIN
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=p_case;
  SELECT * INTO c FROM public.contracts WHERE id=e.contract_id AND organization_id=e.organization_id;
  IF e.id IS NULL OR c.id IS NULL THEN RAISE EXCEPTION 'Không tìm thấy hồ sơ trả phòng' USING ERRCODE='42501'; END IF;
  v_base:=GREATEST(COALESCE(c.total_deposit,0),0);
  -- Phí mặc định 50% cọc theo hợp đồng cũ, không vượt cọc đã thu.
  v_fee:=CASE WHEN p_early_reason='SALE_ASSISTED' THEN LEAST(round(v_base*0.5),GREATEST(COALESCE(c.deposit_paid,0),0)) ELSE 0 END;
  INSERT INTO public.contract_exit_early_terms(exit_case_id,contract_id,organization_id,building_id,room_id,early_reason,sale_name,
    deposit_base,broker_fee,fee_applied_at,hold_until,created_by)
  VALUES(e.id,e.contract_id,e.organization_id,e.building_id,e.room_at_handover_id,p_early_reason,
    CASE WHEN p_early_reason='SALE_ASSISTED' THEN p_sale_name END,v_base,v_fee,
    CASE WHEN e.state='FINALIZED' THEN clock_timestamp() END,
    CASE WHEN p_early_reason IN ('SALE_ASSISTED','SELF_FOUND') THEN clock_timestamp()+interval '3 days' END,auth.uid())
  RETURNING * INTO t;
  PERFORM app_private.contract_exit_early_term_event_v1(t.exit_case_id,'CREATED',p_reason,p_request,p_hash,
    jsonb_build_object('early_reason',t.early_reason,'sale_name',t.sale_name,'deposit_base',t.deposit_base,
      'broker_fee',t.broker_fee,'hold_until',t.hold_until));
  PERFORM app_private.contract_exit_early_terms_link_existing_v1(t.exit_case_id);
END
$fn$;

-- Phòng đang giữ cho khách nhận: trường hợp 1 hoặc 2, chưa nối hợp đồng mới, chưa "Mở bán lại", còn hạn.
CREATE OR REPLACE FUNCTION app_private.room_exit_hold_open_v1(p_organization_id uuid,p_room_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT t.exit_case_id FROM public.contract_exit_early_terms t
  JOIN public.contract_exit_cases e ON e.id=t.exit_case_id
  WHERE t.organization_id=p_organization_id AND t.room_id=p_room_id AND t.early_reason IN ('SALE_ASSISTED','SELF_FOUND')
    AND t.new_contract_id IS NULL AND t.reopened_at IS NULL AND t.hold_until>now() AND e.state='PENDING'
  ORDER BY t.created_at DESC,t.exit_case_id LIMIT 1
$fn$;

-- Object exit_hold cho hai màn nội bộ: còn chờ khách nhận (kể cả đã quá hạn, khi đó active=false).
CREATE OR REPLACE FUNCTION app_private.room_exit_hold_json_v1(p_organization_id uuid,p_room_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT jsonb_build_object('exit_case_id',t.exit_case_id,'version',t.version,'early_reason',t.early_reason,
    'sale_name',t.sale_name,'old_customer_name',e.customer_name,'old_contract_number',e.contract_number,
    'actual_move_out_on',e.actual_move_out_on,'recorded_by_name',COALESCE(NULLIF(btrim(p.full_name),''),'Người dùng'),
    'recorded_by_me',t.created_by=auth.uid(),'hold_until',t.hold_until,'active',t.hold_until>now(),
    'can_manage',COALESCE(app_private.has_building_perm_v1(t.building_id,'contracts.terminate'),false))
  FROM public.contract_exit_early_terms t
  JOIN public.contract_exit_cases e ON e.id=t.exit_case_id
  LEFT JOIN public.profiles p ON p.id=t.created_by
  WHERE t.organization_id=p_organization_id AND t.room_id=p_room_id AND t.early_reason IN ('SALE_ASSISTED','SELF_FOUND')
    AND t.new_contract_id IS NULL AND t.reopened_at IS NULL AND e.state='PENDING'
  ORDER BY t.created_at DESC,t.exit_case_id LIMIT 1
$fn$;

-- Tự nối: hợp đồng mới đầu tiên của phòng (mọi đường tạo) nối với hồ sơ cũ còn chờ.
CREATE OR REPLACE FUNCTION app_private.contract_exit_early_terms_on_contract_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_case uuid;
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.room_id IS NULL OR NEW.organization_id IS NULL
    OR NEW.status::text NOT IN ('ACTIVE','EXTENDED') THEN RETURN NULL; END IF;
  SELECT t.exit_case_id INTO v_case FROM public.contract_exit_early_terms t
  JOIN public.contract_exit_cases e ON e.id=t.exit_case_id
  WHERE t.organization_id=NEW.organization_id AND t.room_id=NEW.room_id AND t.early_reason IN ('SALE_ASSISTED','SELF_FOUND')
    AND t.new_contract_id IS NULL AND t.reopened_at IS NULL AND e.state='PENDING'
    AND t.contract_id<>NEW.id AND NEW.start_date>=e.actual_move_out_on
  ORDER BY t.created_at,t.exit_case_id LIMIT 1
  FOR UPDATE OF t;
  IF v_case IS NOT NULL THEN PERFORM app_private.contract_exit_early_terms_link_v1(v_case,NEW.id); END IF;
  RETURN NULL;
END
$fn$;
DROP TRIGGER IF EXISTS z50_contract_exit_early_terms_link ON public.contracts;
CREATE TRIGGER z50_contract_exit_early_terms_link AFTER INSERT ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION app_private.contract_exit_early_terms_on_contract_v1();

-- Kiểm quyết toán: gọi từ finalize_contract_exit_case_v1, ngay sau kiểm liên kết nhượng cũ.
CREATE OR REPLACE FUNCTION app_private.assert_exit_early_terms_settlement_v1(p_case_id uuid,p_kind text,p_settlement jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE e public.contract_exit_cases%ROWTYPE; t public.contract_exit_early_terms%ROWTYPE; v_cutover timestamptz;
  v_count integer:=0; v_amount numeric; v_paid numeric;
BEGIN
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=p_case_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF jsonb_typeof(p_settlement->'extra_charges')='array' THEN
    SELECT count(*) INTO v_count FROM jsonb_array_elements(p_settlement->'extra_charges') j WHERE j->>'kind'='BROKER_FEE';
  END IF;
  SELECT * INTO t FROM public.contract_exit_early_terms WHERE exit_case_id=p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    SELECT f.at INTO v_cutover FROM app_private.feature_cutovers f WHERE f.key='exit_early_terms';
    IF p_kind='EARLY_RETURN' AND (v_cutover IS NULL OR e.created_at>=v_cutover) THEN
      RAISE EXCEPTION 'Hồ sơ trả phòng trước hạn chưa chọn trường hợp (nhờ sale, tự tìm khách, chủ nhà hỗ trợ); chọn trường hợp trước khi quyết toán'
        USING ERRCODE='55000';
    END IF;
    IF v_count>0 THEN
      RAISE EXCEPTION 'Dòng phí môi giới chỉ dùng cho trường hợp nhờ sale tìm khách sang phòng' USING ERRCODE='22023';
    END IF;
    RETURN;
  END IF;
  IF t.early_reason IN ('SALE_ASSISTED','SELF_FOUND') THEN
    IF p_kind IS DISTINCT FROM 'EARLY_RETURN' THEN
      RAISE EXCEPTION 'Hồ sơ sang nhượng phòng chỉ quyết toán theo Trả phòng trước hạn; khách nhận đã huỷ thì đổi sang trường hợp chủ nhà hỗ trợ trước'
        USING ERRCODE='55000';
    END IF;
    IF t.new_contract_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.contracts c
        WHERE c.id=t.new_contract_id AND c.organization_id=t.organization_id AND c.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'Chưa có hợp đồng của khách nhận phòng; chỉ quyết toán sau khi tạo hợp đồng khách mới' USING ERRCODE='55000';
    END IF;
  END IF;
  IF t.early_reason='SALE_ASSISTED' AND t.broker_fee>0 THEN
    IF v_count=1 THEN
      BEGIN
        SELECT (j->>'amount')::numeric INTO v_amount FROM jsonb_array_elements(p_settlement->'extra_charges') j WHERE j->>'kind'='BROKER_FEE';
      EXCEPTION WHEN invalid_text_representation THEN v_amount:=NULL;
      END;
    END IF;
    IF v_count<>1 OR v_amount IS DISTINCT FROM t.broker_fee THEN
      RAISE EXCEPTION 'Quyết toán cần đúng một dòng phí môi giới bằng phí đã ghi ở hồ sơ trả phòng' USING ERRCODE='22023';
    END IF;
    SELECT c.deposit_paid INTO v_paid FROM public.contracts c WHERE c.id=t.contract_id;
    IF t.broker_fee>COALESCE(v_paid,0) THEN
      RAISE EXCEPTION 'Phí môi giới lớn hơn cọc đã thu của hợp đồng cũ; sửa phí trước khi quyết toán' USING ERRCODE='PT409';
    END IF;
  ELSIF v_count>0 THEN
    RAISE EXCEPTION 'Dòng phí môi giới chỉ dùng cho trường hợp nhờ sale tìm khách sang phòng, đúng phí đã ghi' USING ERRCODE='22023';
  END IF;
  UPDATE public.contract_exit_early_terms SET fee_applied_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
    WHERE exit_case_id=t.exit_case_id RETURNING * INTO t;
  PERFORM app_private.contract_exit_early_term_event_v1(t.exit_case_id,'FEE_APPLIED',
    CASE WHEN t.broker_fee>0 THEN 'Phí môi giới vào quyết toán hồ sơ trả phòng' ELSE 'Quyết toán không có phí môi giới' END,
    NULL,NULL,jsonb_build_object('broker_fee',t.broker_fee,'kind',p_kind));
END
$fn$;

-- Kiểm ở vỏ bọc create_commission_voucher: khách nhận của ca tự tìm không có hoa hồng; ca nhờ sale chỉ lập
-- hoa hồng môi giới qua create_contract_exit_commission_v1.
CREATE OR REPLACE FUNCTION app_private.assert_exit_early_commission_v1(p_org uuid,p_contract uuid,p_kind text,p_amount numeric)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE t public.contract_exit_early_terms%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.contract_exit_early_terms WHERE new_contract_id=p_contract AND organization_id=p_org;
  IF NOT FOUND THEN RETURN; END IF;
  IF t.early_reason='SELF_FOUND' THEN
    RAISE EXCEPTION 'Khách tự tìm sang phòng: hợp đồng này không có hoa hồng môi giới hay thưởng sale' USING ERRCODE='55000';
  END IF;
  IF t.early_reason='SALE_ASSISTED' AND p_kind='broker' AND NOT EXISTS (SELECT 1 FROM app_private.contract_exit_commission_authorizations a
      WHERE a.organization_id=p_org AND a.contract_id=p_contract AND a.kind='broker' AND a.exit_case_id=t.exit_case_id
        AND a.net=p_amount AND a.xid=pg_current_xact_id() AND a.backend_pid=pg_backend_pid()) THEN
    RAISE EXCEPTION 'Hoa hồng môi giới của khách nhận sang phòng chỉ lập từ hồ sơ trả phòng cũ, bằng đúng phí đã quyết toán' USING ERRCODE='55000';
  END IF;
END
$fn$;

-- 4. RPC.
CREATE OR REPLACE FUNCTION public.confirm_contract_return_v2(p_organization_id uuid,p_contract_id uuid,p_expected_contract_updated_at timestamptz,
  p_idempotency_key text,p_actual_move_out_on date,p_initial_kind text,p_settlement_mode text,p_settlement jsonb DEFAULT NULL,
  p_meter_boundary jsonb DEFAULT NULL,p_return_note text DEFAULT NULL,p_early_terms jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_reason text; v_sale text; v_result jsonb; e public.contract_exit_cases%ROWTYPE; t public.contract_exit_early_terms%ROWTYPE;
  h app_private.contract_exit_early_term_events%ROWTYPE; v_hash text; v_request uuid;
BEGIN
  IF p_initial_kind='EARLY_RETURN' THEN
    IF jsonb_typeof(p_early_terms) IS DISTINCT FROM 'object'
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_early_terms) k WHERE k NOT IN ('early_reason','sale_name'))
      OR jsonb_typeof(p_early_terms->'early_reason') IS DISTINCT FROM 'string'
      OR COALESCE(jsonb_typeof(p_early_terms->'sale_name'),'null') NOT IN ('string','null') THEN
      RAISE EXCEPTION 'Trả phòng trước hạn cần chọn một trong ba trường hợp' USING ERRCODE='22023';
    END IF;
    v_reason:=p_early_terms->>'early_reason';
    v_sale:=NULLIF(btrim(p_early_terms->>'sale_name'),'');
    IF v_reason NOT IN ('SALE_ASSISTED','SELF_FOUND','LANDLORD_AGREEMENT') THEN
      RAISE EXCEPTION 'Trả phòng trước hạn cần chọn một trong ba trường hợp' USING ERRCODE='22023';
    END IF;
    IF v_reason='SALE_ASSISTED' AND (v_sale IS NULL OR char_length(v_sale)>200) THEN
      RAISE EXCEPTION 'Nhờ sale tìm khách sang phòng cần ghi tên sale' USING ERRCODE='22023';
    END IF;
    IF v_reason<>'SALE_ASSISTED' AND v_sale IS NOT NULL THEN
      RAISE EXCEPTION 'Chỉ trường hợp nhờ sale mới ghi tên sale' USING ERRCODE='22023';
    END IF;
    IF v_reason IN ('SALE_ASSISTED','SELF_FOUND') AND p_settlement_mode IS DISTINCT FROM 'DEFERRED' THEN
      RAISE EXCEPTION 'Khách sang nhượng phòng: chỉ ghi trả phòng, quyết toán sau khi có hợp đồng khách mới' USING ERRCODE='22023';
    END IF;
  ELSIF p_early_terms IS NOT NULL THEN
    RAISE EXCEPTION 'Chỉ trả phòng trước hạn mới có trường hợp sang nhượng' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p_settlement->'extra_charges')='array'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_settlement->'extra_charges') j WHERE j->>'kind'='BROKER_FEE') THEN
    RAISE EXCEPTION 'Dòng phí môi giới chỉ có ở quyết toán trường hợp nhờ sale, sau khi có hợp đồng khách mới' USING ERRCODE='22023';
  END IF;
  v_result:=public.confirm_contract_return_v1(p_organization_id,p_contract_id,p_expected_contract_updated_at,p_idempotency_key,
    p_actual_move_out_on,p_initial_kind,p_settlement_mode,p_settlement,p_meter_boundary,p_return_note);
  IF p_initial_kind IS DISTINCT FROM 'EARLY_RETURN' THEN
    RETURN v_result||jsonb_build_object('early_terms',NULL);
  END IF;
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=(v_result->>'id')::uuid AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy hồ sơ trả phòng' USING ERRCODE='42501'; END IF;
  v_hash:=md5(jsonb_build_object('early_reason',v_reason,'sale_name',v_sale)::text);
  v_request:=md5('exit-early-terms:confirm:'||e.id::text)::uuid;
  SELECT * INTO t FROM public.contract_exit_early_terms WHERE exit_case_id=e.id FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO h FROM app_private.contract_exit_early_term_events WHERE request_id=v_request;
    IF NOT FOUND OR h.exit_case_id<>e.id OR h.actor_id IS DISTINCT FROM auth.uid() OR h.intent_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'Request key reused with different return intent' USING ERRCODE='23505';
    END IF;
  ELSE
    PERFORM app_private.contract_exit_early_terms_create_v1(e.id,v_reason,v_sale,'Chọn trường hợp khi xác nhận trả phòng',v_request,v_hash);
  END IF;
  RETURN v_result||jsonb_build_object('early_terms',app_private.contract_exit_early_terms_response_v1(e.id));
END
$fn$;

CREATE OR REPLACE FUNCTION public.set_contract_exit_early_terms_v1(p_organization_id uuid,p_exit_case_id uuid,p_expected_version bigint,
  p_request_id uuid,p_early_reason text,p_sale_name text,p_reason text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE e public.contract_exit_cases%ROWTYPE; t public.contract_exit_early_terms%ROWTYPE; h app_private.contract_exit_early_term_events%ROWTYPE;
  v_sale text:=NULLIF(btrim(p_sale_name),''); v_reason text:=NULLIF(btrim(p_reason),''); v_hash text; v_alive boolean:=false;
  v_restart boolean; v_unlink boolean; v_before jsonb; v_base numeric; v_fee numeric; v_old_contract uuid; c public.contracts%ROWTYPE;
BEGIN
  IF p_request_id IS NULL OR p_expected_version IS NULL OR p_expected_version<0 OR p_early_reason IS NULL
    OR p_early_reason NOT IN ('SALE_ASSISTED','SELF_FOUND','LANDLORD_AGREEMENT') OR v_reason IS NULL OR char_length(v_reason)>2000
    OR char_length(v_sale)>200 OR (p_early_reason='SALE_ASSISTED' AND v_sale IS NULL)
    OR (p_early_reason<>'SALE_ASSISTED' AND v_sale IS NOT NULL) THEN
    RAISE EXCEPTION 'Trường hợp trả phòng trước hạn không hợp lệ: nhờ sale cần tên sale, mọi lần chọn hoặc đổi cần lý do' USING ERRCODE='22023';
  END IF;
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=p_exit_case_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy hồ sơ trả phòng' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(e.organization_id,e.building_id);
  PERFORM app_private.require_building_perm_v1(e.building_id,'đổi trường hợp trả phòng trước hạn','contracts.terminate');
  v_hash:=md5(jsonb_build_object('case',e.id,'version',p_expected_version,'early_reason',p_early_reason,'sale_name',v_sale,'reason',v_reason)::text);
  SELECT * INTO h FROM app_private.contract_exit_early_term_events WHERE request_id=p_request_id;
  IF FOUND THEN
    IF h.exit_case_id<>e.id OR h.actor_id IS DISTINCT FROM auth.uid() OR h.event NOT IN ('CREATED','CASE_CHANGED') OR h.intent_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'Mã yêu cầu đã dùng cho thao tác khác' USING ERRCODE='23505';
    END IF;
    RETURN app_private.contract_exit_early_terms_response_v1(e.id);
  END IF;
  IF e.state<>'PENDING' THEN RAISE EXCEPTION 'Hồ sơ trả phòng đã quyết toán; không đổi trường hợp được' USING ERRCODE='55000'; END IF;
  IF e.current_kind<>'EARLY_RETURN' THEN
    RAISE EXCEPTION 'Chỉ hồ sơ trả phòng trước hạn mới chọn trường hợp sang nhượng' USING ERRCODE='55000';
  END IF;
  SELECT * INTO t FROM public.contract_exit_early_terms WHERE exit_case_id=e.id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_version<>0 THEN RAISE EXCEPTION 'Hồ sơ trường hợp trả phòng đã thay đổi; tải lại' USING ERRCODE='PT409'; END IF;
    PERFORM app_private.contract_exit_early_terms_create_v1(e.id,p_early_reason,v_sale,v_reason,p_request_id,v_hash);
    RETURN app_private.contract_exit_early_terms_response_v1(e.id);
  END IF;
  IF t.version<>p_expected_version THEN RAISE EXCEPTION 'Hồ sơ trường hợp trả phòng đã thay đổi; tải lại' USING ERRCODE='PT409'; END IF;
  IF t.support_amount<>0 OR t.fee_applied_at IS NOT NULL OR t.commission_voucher_id IS NOT NULL THEN
    RAISE EXCEPTION 'Hồ sơ đã ghi tiền hỗ trợ, phí hoặc hoa hồng; không đổi trường hợp được' USING ERRCODE='55000';
  END IF;
  IF t.new_contract_id IS NOT NULL THEN
    v_alive:=EXISTS (SELECT 1 FROM public.contracts x WHERE x.id=t.new_contract_id AND x.organization_id=t.organization_id AND x.deleted_at IS NULL);
  END IF;
  -- Vào lại trường hợp 1/2 từ chủ nhà hỗ trợ, hoặc hợp đồng đã nối bị xoá: giữ phòng lại từ đầu và tìm khách nhận.
  v_restart:=p_early_reason IN ('SALE_ASSISTED','SELF_FOUND') AND (t.early_reason='LANDLORD_AGREEMENT' OR (t.new_contract_id IS NOT NULL AND NOT v_alive));
  v_unlink:=t.new_contract_id IS NOT NULL AND (p_early_reason='LANDLORD_AGREEMENT' OR NOT v_alive);
  IF t.early_reason=p_early_reason AND t.sale_name IS NOT DISTINCT FROM v_sale AND NOT v_restart THEN
    RAISE EXCEPTION 'Trường hợp không đổi' USING ERRCODE='22023';
  END IF;
  v_before:=jsonb_build_object('early_reason',t.early_reason,'sale_name',t.sale_name,'broker_fee',t.broker_fee,
    'hold_until',t.hold_until,'new_contract_id',t.new_contract_id,'reopened_at',t.reopened_at);
  -- Rời ca tự tìm khi hợp đồng khách nhận còn sống: mở lại theo dõi hoa hồng trước khi gỡ nối.
  IF v_alive AND t.early_reason='SELF_FOUND' AND (v_unlink OR p_early_reason<>'SELF_FOUND') THEN
    PERFORM app_private.contract_exit_early_terms_mark_commission_v1(t.exit_case_id,'REOPENED',false);
  END IF;
  SELECT * INTO c FROM public.contracts WHERE id=t.contract_id;
  v_base:=CASE WHEN p_early_reason='SALE_ASSISTED' AND t.early_reason<>'SALE_ASSISTED' THEN GREATEST(COALESCE(c.total_deposit,0),0) ELSE t.deposit_base END;
  v_fee:=CASE WHEN p_early_reason<>'SALE_ASSISTED' THEN 0
    WHEN t.early_reason<>'SALE_ASSISTED' THEN LEAST(round(v_base*0.5),GREATEST(COALESCE(c.deposit_paid,0),0))
    ELSE t.broker_fee END;
  v_old_contract:=CASE WHEN v_unlink THEN t.new_contract_id END;
  UPDATE public.contract_exit_early_terms SET early_reason=p_early_reason,sale_name=v_sale,deposit_base=v_base,broker_fee=v_fee,
    hold_until=CASE WHEN v_restart THEN clock_timestamp()+interval '3 days' ELSE t.hold_until END,
    reopened_at=CASE WHEN v_restart OR p_early_reason='LANDLORD_AGREEMENT' THEN NULL ELSE t.reopened_at END,
    reopened_by=CASE WHEN v_restart OR p_early_reason='LANDLORD_AGREEMENT' THEN NULL ELSE t.reopened_by END,
    expiry_notified_at=CASE WHEN v_restart THEN NULL ELSE t.expiry_notified_at END,
    new_contract_id=CASE WHEN v_unlink THEN NULL ELSE t.new_contract_id END,
    linked_at=CASE WHEN v_unlink THEN NULL ELSE t.linked_at END,
    version=version+1,updated_at=clock_timestamp()
  WHERE exit_case_id=t.exit_case_id RETURNING * INTO t;
  -- Vào ca tự tìm khi đã có hợp đồng khách nhận: chặn cả hai loại hoa hồng; đã có phiếu thì dừng.
  IF t.new_contract_id IS NOT NULL AND t.early_reason='SELF_FOUND' AND v_before->>'early_reason'<>'SELF_FOUND' THEN
    PERFORM app_private.contract_exit_early_terms_mark_commission_v1(t.exit_case_id,'NOT_APPLICABLE',true);
  END IF;
  PERFORM app_private.contract_exit_early_term_event_v1(t.exit_case_id,'CASE_CHANGED',v_reason,p_request_id,v_hash,
    jsonb_build_object('before',v_before,'after',jsonb_build_object('early_reason',t.early_reason,'sale_name',t.sale_name,
      'broker_fee',t.broker_fee,'hold_until',t.hold_until,'new_contract_id',t.new_contract_id),'unlinked_contract_id',v_old_contract));
  PERFORM app_private.contract_exit_early_terms_link_existing_v1(t.exit_case_id);
  RETURN app_private.contract_exit_early_terms_response_v1(e.id);
END
$fn$;

CREATE OR REPLACE FUNCTION public.update_contract_exit_broker_fee_v1(p_organization_id uuid,p_exit_case_id uuid,p_expected_version bigint,
  p_request_id uuid,p_broker_fee numeric,p_reason text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE e public.contract_exit_cases%ROWTYPE; t public.contract_exit_early_terms%ROWTYPE; h app_private.contract_exit_early_term_events%ROWTYPE;
  v_reason text:=NULLIF(btrim(p_reason),''); v_hash text; v_paid numeric; v_before numeric;
BEGIN
  IF p_request_id IS NULL OR p_expected_version IS NULL OR p_broker_fee IS NULL OR p_broker_fee<0
    OR p_broker_fee::text IN ('NaN','Infinity','-Infinity') OR round(p_broker_fee,2)<>p_broker_fee
    OR v_reason IS NULL OR char_length(v_reason)>2000 THEN
    RAISE EXCEPTION 'Phí môi giới không hợp lệ; sửa phí cần số tiền không âm và lý do' USING ERRCODE='22023';
  END IF;
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=p_exit_case_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy hồ sơ trả phòng' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(e.organization_id,e.building_id);
  PERFORM app_private.require_building_perm_v1(e.building_id,'sửa phí môi giới khi trả phòng','contracts.terminate');
  v_hash:=md5(jsonb_build_object('case',e.id,'version',p_expected_version,'broker_fee',p_broker_fee,'reason',v_reason)::text);
  SELECT * INTO h FROM app_private.contract_exit_early_term_events WHERE request_id=p_request_id;
  IF FOUND THEN
    IF h.exit_case_id<>e.id OR h.actor_id IS DISTINCT FROM auth.uid() OR h.event<>'FEE_CHANGED' OR h.intent_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'Mã yêu cầu đã dùng cho thao tác khác' USING ERRCODE='23505';
    END IF;
    RETURN app_private.contract_exit_early_terms_response_v1(e.id);
  END IF;
  IF e.state<>'PENDING' THEN RAISE EXCEPTION 'Hồ sơ trả phòng đã quyết toán; không sửa phí được' USING ERRCODE='55000'; END IF;
  SELECT * INTO t FROM public.contract_exit_early_terms WHERE exit_case_id=e.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hồ sơ chưa chọn trường hợp trả phòng trước hạn' USING ERRCODE='55000'; END IF;
  IF t.version<>p_expected_version THEN RAISE EXCEPTION 'Hồ sơ trường hợp trả phòng đã thay đổi; tải lại' USING ERRCODE='PT409'; END IF;
  IF t.early_reason<>'SALE_ASSISTED' OR t.fee_applied_at IS NOT NULL THEN
    RAISE EXCEPTION 'Chỉ sửa được phí môi giới của trường hợp nhờ sale trước khi quyết toán' USING ERRCODE='55000';
  END IF;
  SELECT c.deposit_paid INTO v_paid FROM public.contracts c WHERE c.id=t.contract_id;
  IF p_broker_fee>GREATEST(COALESCE(v_paid,0),0) THEN
    RAISE EXCEPTION 'Phí môi giới không được vượt cọc đã thu của hợp đồng cũ' USING ERRCODE='22023';
  END IF;
  IF p_broker_fee=t.broker_fee THEN RAISE EXCEPTION 'Phí môi giới không đổi' USING ERRCODE='22023'; END IF;
  v_before:=t.broker_fee;
  UPDATE public.contract_exit_early_terms SET broker_fee=p_broker_fee,version=version+1,updated_at=clock_timestamp()
    WHERE exit_case_id=t.exit_case_id RETURNING * INTO t;
  PERFORM app_private.contract_exit_early_term_event_v1(t.exit_case_id,'FEE_CHANGED',v_reason,p_request_id,v_hash,
    jsonb_build_object('before',v_before,'after',t.broker_fee));
  RETURN app_private.contract_exit_early_terms_response_v1(e.id);
END
$fn$;

CREATE OR REPLACE FUNCTION public.reopen_contract_exit_hold_v1(p_organization_id uuid,p_exit_case_id uuid,p_expected_version bigint,
  p_request_id uuid,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE e public.contract_exit_cases%ROWTYPE; t public.contract_exit_early_terms%ROWTYPE; h app_private.contract_exit_early_term_events%ROWTYPE;
  v_reason text:=COALESCE(NULLIF(btrim(p_reason),''),'Mở bán lại: khách nhận phòng không còn giữ chỗ'); v_hash text;
BEGIN
  IF p_request_id IS NULL OR p_expected_version IS NULL OR char_length(v_reason)>2000 THEN
    RAISE EXCEPTION 'Yêu cầu mở bán lại không hợp lệ' USING ERRCODE='22023';
  END IF;
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=p_exit_case_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy hồ sơ trả phòng' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(e.organization_id,e.building_id);
  PERFORM app_private.require_building_perm_v1(e.building_id,'mở bán lại phòng chờ khách sang nhượng','contracts.terminate');
  v_hash:=md5(jsonb_build_object('case',e.id,'version',p_expected_version,'reason',v_reason)::text);
  SELECT * INTO h FROM app_private.contract_exit_early_term_events WHERE request_id=p_request_id;
  IF FOUND THEN
    IF h.exit_case_id<>e.id OR h.actor_id IS DISTINCT FROM auth.uid() OR h.event<>'HOLD_REOPENED' OR h.intent_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'Mã yêu cầu đã dùng cho thao tác khác' USING ERRCODE='23505';
    END IF;
    RETURN app_private.contract_exit_early_terms_response_v1(e.id);
  END IF;
  SELECT * INTO t FROM public.contract_exit_early_terms WHERE exit_case_id=e.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hồ sơ chưa chọn trường hợp trả phòng trước hạn' USING ERRCODE='55000'; END IF;
  IF t.version<>p_expected_version THEN RAISE EXCEPTION 'Hồ sơ trường hợp trả phòng đã thay đổi; tải lại' USING ERRCODE='PT409'; END IF;
  IF e.state<>'PENDING' OR t.early_reason NOT IN ('SALE_ASSISTED','SELF_FOUND') OR t.new_contract_id IS NOT NULL OR t.reopened_at IS NOT NULL THEN
    RAISE EXCEPTION 'Chỉ mở bán lại phòng đang chờ khách sang nhượng chưa có hợp đồng' USING ERRCODE='55000';
  END IF;
  UPDATE public.contract_exit_early_terms SET reopened_at=clock_timestamp(),reopened_by=auth.uid(),version=version+1,updated_at=clock_timestamp()
    WHERE exit_case_id=t.exit_case_id RETURNING * INTO t;
  PERFORM app_private.contract_exit_early_term_event_v1(t.exit_case_id,'HOLD_REOPENED',v_reason,p_request_id,v_hash,
    jsonb_build_object('hold_until',t.hold_until));
  RETURN app_private.contract_exit_early_terms_response_v1(e.id);
END
$fn$;

CREATE OR REPLACE FUNCTION public.extend_contract_exit_hold_v1(p_organization_id uuid,p_exit_case_id uuid,p_expected_version bigint,
  p_request_id uuid,p_days integer DEFAULT 3,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE e public.contract_exit_cases%ROWTYPE; t public.contract_exit_early_terms%ROWTYPE; h app_private.contract_exit_early_term_events%ROWTYPE;
  v_reason text:=COALESCE(NULLIF(btrim(p_reason),''),'Giữ tiếp phòng chờ khách sang nhượng'); v_hash text; v_before jsonb;
BEGIN
  IF p_request_id IS NULL OR p_expected_version IS NULL OR p_days IS NULL OR p_days NOT BETWEEN 1 AND 30 OR char_length(v_reason)>2000 THEN
    RAISE EXCEPTION 'Giữ tiếp cần số ngày từ 1 đến 30' USING ERRCODE='22023';
  END IF;
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=p_exit_case_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy hồ sơ trả phòng' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(e.organization_id,e.building_id);
  PERFORM app_private.require_building_perm_v1(e.building_id,'giữ tiếp phòng chờ khách sang nhượng','contracts.terminate');
  v_hash:=md5(jsonb_build_object('case',e.id,'version',p_expected_version,'days',p_days,'reason',v_reason)::text);
  SELECT * INTO h FROM app_private.contract_exit_early_term_events WHERE request_id=p_request_id;
  IF FOUND THEN
    IF h.exit_case_id<>e.id OR h.actor_id IS DISTINCT FROM auth.uid() OR h.event<>'HOLD_EXTENDED' OR h.intent_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'Mã yêu cầu đã dùng cho thao tác khác' USING ERRCODE='23505';
    END IF;
    RETURN app_private.contract_exit_early_terms_response_v1(e.id);
  END IF;
  SELECT * INTO t FROM public.contract_exit_early_terms WHERE exit_case_id=e.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hồ sơ chưa chọn trường hợp trả phòng trước hạn' USING ERRCODE='55000'; END IF;
  IF t.version<>p_expected_version THEN RAISE EXCEPTION 'Hồ sơ trường hợp trả phòng đã thay đổi; tải lại' USING ERRCODE='PT409'; END IF;
  IF e.state<>'PENDING' OR t.early_reason NOT IN ('SALE_ASSISTED','SELF_FOUND') OR t.new_contract_id IS NOT NULL THEN
    RAISE EXCEPTION 'Chỉ giữ tiếp phòng đang chờ khách sang nhượng chưa có hợp đồng' USING ERRCODE='55000';
  END IF;
  v_before:=jsonb_build_object('hold_until',t.hold_until,'reopened_at',t.reopened_at);
  UPDATE public.contract_exit_early_terms SET hold_until=clock_timestamp()+make_interval(days=>p_days),reopened_at=NULL,reopened_by=NULL,
    expiry_notified_at=NULL,version=version+1,updated_at=clock_timestamp()
    WHERE exit_case_id=t.exit_case_id RETURNING * INTO t;
  PERFORM app_private.contract_exit_early_term_event_v1(t.exit_case_id,'HOLD_EXTENDED',v_reason,p_request_id,v_hash,
    jsonb_build_object('before',v_before,'hold_until',t.hold_until,'days',p_days));
  RETURN app_private.contract_exit_early_terms_response_v1(e.id);
END
$fn$;

CREATE OR REPLACE FUNCTION public.read_contract_exit_early_terms_v1(p_organization_id uuid,p_contract_id uuid DEFAULT NULL,
  p_exit_case_id uuid DEFAULT NULL,p_room_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_building uuid; v_result jsonb;
BEGIN
  IF num_nonnulls(p_contract_id,p_exit_case_id,p_room_id)<>1 THEN
    RAISE EXCEPTION 'Cần chọn đúng một hợp đồng, hồ sơ hoặc phòng' USING ERRCODE='22023';
  END IF;
  IF p_contract_id IS NOT NULL THEN
    SELECT r.building_id INTO v_building FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id
      WHERE c.id=p_contract_id AND c.organization_id=p_organization_id AND c.deleted_at IS NULL;
  ELSIF p_exit_case_id IS NOT NULL THEN
    SELECT building_id INTO v_building FROM public.contract_exit_cases WHERE id=p_exit_case_id AND organization_id=p_organization_id;
  ELSE
    SELECT building_id INTO v_building FROM public.rooms WHERE id=p_room_id AND organization_id=p_organization_id AND deleted_at IS NULL;
  END IF;
  IF v_building IS NULL OR NOT (app_private.contract_draft_scope_allowed(p_organization_id,v_building,'contracts.view')
      OR (p_room_id IS NOT NULL AND app_private.contract_draft_scope_allowed(p_organization_id,v_building,'contracts.create'))) THEN
    RAISE EXCEPTION 'Không có quyền đọc hồ sơ trả phòng' USING ERRCODE='42501';
  END IF;
  SELECT COALESCE(jsonb_agg(app_private.contract_exit_early_terms_response_v1(t.exit_case_id) ORDER BY t.created_at,t.exit_case_id),'[]'::jsonb)
    INTO v_result
  FROM public.contract_exit_early_terms t JOIN public.contract_exit_cases e ON e.id=t.exit_case_id
  WHERE t.organization_id=p_organization_id
    AND (p_contract_id IN (t.contract_id,t.new_contract_id) OR t.exit_case_id=p_exit_case_id
      OR (t.room_id=p_room_id AND t.early_reason IN ('SALE_ASSISTED','SELF_FOUND') AND t.new_contract_id IS NULL
        AND t.reopened_at IS NULL AND e.state='PENDING'));
  RETURN v_result;
END
$fn$;

CREATE OR REPLACE FUNCTION public.create_contract_exit_commission_v1(p_organization_id uuid,p_exit_case_id uuid,p_expected_version bigint,
  p_request_id uuid,p_account_id uuid DEFAULT NULL,p_recipient_bank text DEFAULT NULL,p_recipient_account text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE t public.contract_exit_early_terms%ROWTYPE; h app_private.contract_exit_early_term_events%ROWTYPE; v public.income_expenses%ROWTYPE;
  nc public.contracts%ROWTYPE; v_hash text; v_result jsonb; v_old_number text;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN
    RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501';
  END IF;
  IF p_request_id IS NULL OR p_expected_version IS NULL OR length(p_recipient_bank)>200 OR length(p_recipient_account)>200 THEN
    RAISE EXCEPTION 'Dữ kiện phiếu hoa hồng không hợp lệ' USING ERRCODE='22023';
  END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO t FROM public.contract_exit_early_terms WHERE exit_case_id=p_exit_case_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không có quyền hồ sơ trả phòng' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(t.organization_id,t.building_id);
  v_hash:=md5(jsonb_build_object('case',t.exit_case_id,'version',p_expected_version,'account',p_account_id,
    'bank',p_recipient_bank,'number',p_recipient_account)::text);
  SELECT * INTO h FROM app_private.contract_exit_early_term_events WHERE request_id=p_request_id;
  IF FOUND THEN
    IF h.exit_case_id<>t.exit_case_id OR h.actor_id IS DISTINCT FROM auth.uid() OR h.event<>'COMMISSION_LINKED' OR h.intent_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'Mã yêu cầu đã dùng cho phiếu khác' USING ERRCODE='23505';
    END IF;
    RETURN app_private.contract_exit_early_terms_response_v1(t.exit_case_id);
  END IF;
  IF t.version<>p_expected_version THEN RAISE EXCEPTION 'Hồ sơ trường hợp trả phòng đã thay đổi; tải lại' USING ERRCODE='PT409'; END IF;
  IF t.early_reason<>'SALE_ASSISTED' OR t.fee_applied_at IS NULL OR t.new_contract_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.contract_exit_cases e WHERE e.id=t.exit_case_id AND e.state='FINALIZED') THEN
    RAISE EXCEPTION 'Chỉ lập hoa hồng môi giới cho trường hợp nhờ sale, sau khi có hợp đồng khách mới và đã quyết toán phí' USING ERRCODE='55000';
  END IF;
  IF t.commission_voucher_id IS NOT NULL OR t.broker_fee=0 THEN RETURN app_private.contract_exit_early_terms_response_v1(t.exit_case_id); END IF;
  SELECT * INTO nc FROM public.contracts WHERE id=t.new_contract_id AND organization_id=t.organization_id AND deleted_at IS NULL;
  IF nc.id IS NULL OR COALESCE(nc.deposit_paid,0)<COALESCE(nc.total_deposit,0) THEN
    RAISE EXCEPTION 'Khách nhận phòng chưa nộp đủ cọc; lập phiếu hoa hồng sau khi thu đủ cọc' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v FROM public.income_expenses WHERE organization_id=t.organization_id AND contract_id=t.new_contract_id
    AND commission_kind='broker' AND deleted_at IS NULL AND approval_status IS DISTINCT FROM 'CANCELLED' FOR UPDATE;
  IF FOUND THEN
    -- Writer hoa hồng ghi người nhận vào ghi chú ("Người nhận: <tên>"); income_expenses không có cột người nhận.
    IF v.type::text<>'EXPENSE' OR v.total_amount<>t.broker_fee OR strpos(COALESCE(v.notes,''),'Người nhận: '||t.sale_name)=0 THEN
      RAISE EXCEPTION 'Hợp đồng khách nhận đã có phiếu môi giới khác số tiền hoặc người nhận; không tạo trùng hay đổi phiếu hiện hành' USING ERRCODE='55000';
    END IF;
    v_result:=jsonb_build_object('id',v.id);
  ELSE
    SELECT e.contract_number INTO v_old_number FROM public.contract_exit_cases e WHERE e.id=t.exit_case_id;
    PERFORM app_private.begin_commission_reason_v1(NULL,t.new_contract_id,'broker','CREATE_TRANSFER',
      'Hoa hồng môi giới sang nhượng phòng bằng phí đã quyết toán ở hồ sơ trả phòng cũ',
      jsonb_build_object('source','EXIT_EARLY_TERMS','organization_id',t.organization_id,'contract_id',t.new_contract_id,
        'building_id',t.building_id,'kind','broker','default_amount',t.broker_fee,'submitted_amount',t.broker_fee,
        'deposit_base',t.deposit_base,'exit_case_id',t.exit_case_id,'requires_reason',false));
    INSERT INTO app_private.contract_exit_commission_authorizations(organization_id,contract_id,kind,exit_case_id,net,xid,backend_pid)
      VALUES(t.organization_id,t.new_contract_id,'broker',t.exit_case_id,t.broker_fee,pg_current_xact_id(),pg_backend_pid());
    v_result:=public.create_commission_voucher(t.new_contract_id,'broker',t.broker_fee,public.org_today_v1(t.organization_id),p_account_id,NULL,
      t.sale_name,p_recipient_bank,p_recipient_account,'Hoa hồng môi giới sang nhượng phòng (HĐ cũ '||COALESCE(v_old_number,'')||')','[]'::jsonb);
    DELETE FROM app_private.contract_exit_commission_authorizations WHERE organization_id=t.organization_id AND contract_id=t.new_contract_id
      AND kind='broker' AND xid=pg_current_xact_id() AND backend_pid=pg_backend_pid();
    IF v_result->>'id' IS NULL THEN RAISE EXCEPTION 'Phiếu hoa hồng không trả mã phiếu' USING ERRCODE='55000'; END IF;
  END IF;
  UPDATE public.contract_exit_early_terms SET commission_voucher_id=(v_result->>'id')::uuid,version=version+1,updated_at=clock_timestamp()
    WHERE exit_case_id=t.exit_case_id RETURNING * INTO t;
  PERFORM app_private.contract_exit_early_term_event_v1(t.exit_case_id,'COMMISSION_LINKED',
    'Nối phiếu hoa hồng môi giới qua writer hiện hành; trạng thái duyệt và ghi sổ giữ nguyên',p_request_id,v_hash,
    jsonb_build_object('commission_voucher_id',t.commission_voucher_id,'amount',t.broker_fee));
  RETURN app_private.contract_exit_early_terms_response_v1(t.exit_case_id);
END
$fn$;

-- 5. Nhắc khi hết hạn giữ mà phòng chưa có cọc. Chạy dưới pg_cron (không JWT): không gọi helper kiểm quyền người hỏi.
CREATE OR REPLACE FUNCTION app_private.exit_hold_expiry_tick_v1(p_now timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_now timestamptz:=COALESCE(p_now,clock_timestamp()); r record; v_notified integer:=0; v_skipped integer:=0; v_failed integer:=0;
BEGIN
  FOR r IN SELECT t.exit_case_id,t.organization_id,t.building_id,t.room_id,t.contract_id,t.created_by,t.version,t.hold_until,
      e.contract_number,e.building_name,e.room_name
    FROM public.contract_exit_early_terms t JOIN public.contract_exit_cases e ON e.id=t.exit_case_id
    WHERE t.early_reason IN ('SALE_ASSISTED','SELF_FOUND') AND t.new_contract_id IS NULL AND t.reopened_at IS NULL
      AND t.expiry_notified_at IS NULL AND t.hold_until<=v_now AND e.state='PENDING'
    ORDER BY t.hold_until,t.exit_case_id
    FOR UPDATE OF t SKIP LOCKED
  LOOP
    BEGIN
      IF public.room_has_holding_deposit(r.room_id)
        OR EXISTS (SELECT 1 FROM public.rooms x WHERE x.id=r.room_id AND x.status::text='RESERVED')
        OR EXISTS (SELECT 1 FROM public.room_next_claims c WHERE c.organization_id=r.organization_id AND c.room_id=r.room_id AND c.status='LIVE') THEN
        v_skipped:=v_skipped+1;
        CONTINUE;
      END IF;
      INSERT INTO public.notifications(user_id,organization_id,type,channel,status,subject,content,contract_id,metadata)
      VALUES(r.created_by,r.organization_id,'ACTION_REQUIRED','IN_APP','PENDING','Hết hạn giữ phòng chờ khách sang nhượng',
        COALESCE(NULLIF(concat_ws(' · ',NULLIF(r.building_name,''),NULLIF(r.room_name,'')),''),'Phòng')
          ||': hết hạn giữ, phòng đã tự mở bán lại. Mở hồ sơ trả phòng HĐ '||COALESCE(r.contract_number,'')
          ||' để Giữ tiếp, hoặc đổi trường hợp nếu khách nhận đã huỷ.',
        r.contract_id,
        jsonb_build_object('kind','exit_hold_expired','event','EXIT_HOLD_EXPIRED','exit_case_id',r.exit_case_id,
          'room_id',r.room_id,'building_id',r.building_id,'hold_until',r.hold_until,'url','/contracts/'||r.contract_id::text));
      UPDATE public.contract_exit_early_terms SET expiry_notified_at=v_now WHERE exit_case_id=r.exit_case_id;
      INSERT INTO app_private.contract_exit_early_term_events(exit_case_id,organization_id,event,version,actor_id,reason,payload)
        VALUES(r.exit_case_id,r.organization_id,'HOLD_EXPIRED_NOTIFIED',r.version,NULL,'Hết hạn giữ phòng; đã nhắc người ghi',
          jsonb_build_object('hold_until',r.hold_until,'notified_user_id',r.created_by));
      v_notified:=v_notified+1;
    EXCEPTION WHEN OTHERS THEN
      v_failed:=v_failed+1;
      RAISE WARNING 'exit_hold_expiry_tick_v1: hồ sơ % lỗi (%)',r.exit_case_id,SQLSTATE;
    END;
  END LOOP;
  RETURN jsonb_build_object('notified',v_notified,'skipped',v_skipped,'failed',v_failed);
END
$fn$;

-- 6. Nối vào năm hàm hiện hành bằng neo. Neo phải xuất hiện đúng một lần; đã nối thì bỏ qua.
DO $patch$
DECLARE r record; v_body text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    (1,'public.finalize_contract_exit_case_v1(uuid,uuid,bigint,text,text,text,jsonb)',
      '  PERFORM app_private.assert_contract_transfer_exit_terms_v1(e.id,p_current_kind,p_settlement);',
      '  PERFORM app_private.assert_contract_transfer_exit_terms_v1(e.id,p_current_kind,p_settlement);'||chr(10)
        ||'  PERFORM app_private.assert_exit_early_terms_settlement_v1(e.id,p_current_kind,p_settlement);',
      'assert_exit_early_terms_settlement_v1('),
    (2,'app_private.room_sale_workflow_fact_v1(uuid,uuid,text,boolean,integer)',
      '  IF status_public IN (''free'',''soon'') AND app_private.room_sale_lock_open_id_v1(p_organization_id,p_room_id) IS NOT NULL THEN',
      '  IF status_public IN (''free'',''soon'') AND (app_private.room_sale_lock_open_id_v1(p_organization_id,p_room_id) IS NOT NULL'||chr(10)
        ||'    OR app_private.room_exit_hold_open_v1(p_organization_id,p_room_id) IS NOT NULL) THEN',
      'room_exit_hold_open_v1('),
    (3,'public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb)',
      ' PERFORM app_private.rent_support_payout_lock_v1(org,p_contract_id);',
      ' PERFORM app_private.rent_support_payout_lock_v1(org,p_contract_id);'||chr(10)
        ||' PERFORM app_private.assert_exit_early_commission_v1(org,p_contract_id,p_kind,p_amount);',
      'assert_exit_early_commission_v1('),
    (4,'public.get_my_available_rooms()',
      'lk.sale_lock',
      'lk.sale_lock,'||chr(10)||'      app_private.room_exit_hold_json_v1(rm.organization_id,rm.id) AS exit_hold',
      'room_exit_hold_json_v1('),
    (5,'public.get_my_available_rooms()',
      'OR sale_lock IS NOT NULL',
      'OR sale_lock IS NOT NULL OR exit_hold IS NOT NULL',
      'OR exit_hold IS NOT NULL'),
    (6,'public.get_sale_room_inventory_v1(uuid,uuid,uuid)',
      '''locked_by_me'',lk.locked_by=auth.uid()) END AS sale_lock,',
      '''locked_by_me'',lk.locked_by=auth.uid()) END AS sale_lock,'||chr(10)
        ||'      app_private.room_exit_hold_json_v1(r.organization_id,r.id) AS exit_hold,',
      'room_exit_hold_json_v1('),
    (7,'public.real_estate_renewals_transfers_v1(uuid,uuid[],date,date)',
      '  ), legacy AS MATERIALIZED (',
      '  ), early AS MATERIALIZED ('||chr(10)
        ||'    SELECT t.exit_case_id,t.new_contract_id,t.room_id,nc.start_date AS received_on'||chr(10)
        ||'    FROM public.contract_exit_early_terms t'||chr(10)
        ||'    JOIN public.contracts nc ON nc.id=t.new_contract_id AND nc.organization_id=p_organization_id AND nc.deleted_at IS NULL'||chr(10)
        ||'    WHERE t.organization_id=p_organization_id AND t.building_id=ANY(v_buildings)'||chr(10)
        ||'      AND t.early_reason IN (''SALE_ASSISTED'',''SELF_FOUND'')'||chr(10)
        ||'      AND NOT EXISTS (SELECT 1 FROM signed s WHERE s.new_contract_id=t.new_contract_id)'||chr(10)
        ||'  ), legacy AS MATERIALIZED (',
      'public.contract_exit_early_terms t'),
    (8,'public.real_estate_renewals_transfers_v1(uuid,uuid[],date,date)',
      '    SELECT ''TRANSFER'',s.link_id,s.new_contract_id,s.received_on,s.room_id,s.signed_rent,s.representative_id,true FROM signed s',
      '    SELECT ''TRANSFER'',s.link_id,s.new_contract_id,s.received_on,s.room_id,s.signed_rent,s.representative_id,true FROM signed s'||chr(10)
        ||'    UNION ALL'||chr(10)
        ||'    SELECT ''TRANSFER'',x.exit_case_id,x.new_contract_id,x.received_on,x.room_id,NULL::numeric,NULL::text,false FROM early x',
      'FROM early x')
  ) AS edits(ord,signature,anchor,replacement,marker) ORDER BY ord LOOP
    v_body:=pg_get_functiondef(r.signature::regprocedure);
    IF strpos(v_body,r.marker)=0 THEN
      IF (length(v_body)-length(replace(v_body,r.anchor,'')))<>length(r.anchor) THEN
        RAISE EXCEPTION 'tra_phong_truoc_han_neo_lech %',r.ord USING ERRCODE='55000';
      END IF;
      EXECUTE replace(v_body,r.anchor,r.replacement);
    ELSIF (length(v_body)-length(replace(v_body,r.marker,'')))<>length(r.marker)
      OR (length(v_body)-length(replace(v_body,r.replacement,'')))<>length(r.replacement) THEN
      RAISE EXCEPTION 'tra_phong_truoc_han_noi_sai_cho %',r.ord USING ERRCODE='55000';
    END IF;
  END LOOP;
END
$patch$;

-- 7. Lịch nhắc 15 phút. DB diễn tập không có cron thì bỏ qua; cron.schedule theo tên là ghi đè.
DO $cronblock$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'Không có schema cron — bỏ qua đăng ký lịch nhắc hết hạn giữ phòng.';
    RETURN;
  END IF;
  PERFORM cron.schedule('exit-hold-expiry-15m','*/15 * * * *','SELECT app_private.exit_hold_expiry_tick_v1();');
END
$cronblock$;

-- 8. Quyền gọi.
DO $acl$
DECLARE v_signature text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'app_private.guard_contract_exit_early_terms_v1()','app_private.guard_contract_exit_early_term_events_v1()',
    'app_private.contract_exit_early_terms_response_v1(uuid)',
    'app_private.contract_exit_early_term_event_v1(uuid,text,text,uuid,text,jsonb)',
    'app_private.contract_exit_early_terms_mark_commission_v1(uuid,text,boolean)',
    'app_private.contract_exit_early_terms_link_v1(uuid,uuid)','app_private.contract_exit_early_terms_link_existing_v1(uuid)',
    'app_private.contract_exit_early_terms_create_v1(uuid,text,text,text,uuid,text)',
    'app_private.room_exit_hold_open_v1(uuid,uuid)','app_private.room_exit_hold_json_v1(uuid,uuid)',
    'app_private.contract_exit_early_terms_on_contract_v1()',
    'app_private.assert_exit_early_terms_settlement_v1(uuid,text,jsonb)',
    'app_private.assert_exit_early_commission_v1(uuid,uuid,text,numeric)',
    'app_private.exit_hold_expiry_tick_v1(timestamp with time zone)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',v_signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_signature);
  END LOOP;
  FOREACH v_signature IN ARRAY ARRAY[
    'public.confirm_contract_return_v2(uuid,uuid,timestamp with time zone,text,date,text,text,jsonb,jsonb,text,jsonb)',
    'public.set_contract_exit_early_terms_v1(uuid,uuid,bigint,uuid,text,text,text)',
    'public.update_contract_exit_broker_fee_v1(uuid,uuid,bigint,uuid,numeric,text)',
    'public.reopen_contract_exit_hold_v1(uuid,uuid,bigint,uuid,text)',
    'public.extend_contract_exit_hold_v1(uuid,uuid,bigint,uuid,integer,text)',
    'public.read_contract_exit_early_terms_v1(uuid,uuid,uuid,uuid)',
    'public.create_contract_exit_commission_v1(uuid,uuid,bigint,uuid,uuid,text,text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',v_signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',v_signature);
  END LOOP;
END
$acl$;

-- 9. Nghiệm thu: mỗi điểm nối đúng một lần, hàm đọc vẫn STABLE, ghi vẫn VOLATILE, không ai ngoài chủ hàm gọi helper.
DO $check$
DECLARE r record; v_def text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.finalize_contract_exit_case_v1(uuid,uuid,bigint,text,text,text,jsonb)','assert_exit_early_terms_settlement_v1(','v'),
    ('app_private.room_sale_workflow_fact_v1(uuid,uuid,text,boolean,integer)','room_exit_hold_open_v1(','s'),
    ('public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb)','assert_exit_early_commission_v1(','v'),
    ('public.get_my_available_rooms()','room_exit_hold_json_v1(','s'),
    ('public.get_my_available_rooms()','OR exit_hold IS NOT NULL','s'),
    ('public.get_sale_room_inventory_v1(uuid,uuid,uuid)','room_exit_hold_json_v1(','s'),
    ('public.real_estate_renewals_transfers_v1(uuid,uuid[],date,date)','public.contract_exit_early_terms t','s'),
    ('public.real_estate_renewals_transfers_v1(uuid,uuid[],date,date)','FROM early x','s')
  ) AS t(sig,marker,vol) LOOP
    v_def:=pg_get_functiondef(r.sig::regprocedure);
    IF (length(v_def)-length(replace(v_def,r.marker,'')))<>length(r.marker)
      OR (SELECT p.provolatile::text FROM pg_proc p WHERE p.oid=r.sig::regprocedure)<>r.vol THEN
      RAISE EXCEPTION 'tra_phong_truoc_han_nghiem_thu_lech' USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.contracts'::regclass AND tgname='z50_contract_exit_early_terms_link' AND NOT tgisinternal)<>1
    OR NOT EXISTS (SELECT 1 FROM app_private.feature_cutovers WHERE key='exit_early_terms')
    OR has_function_privilege('authenticated','app_private.assert_exit_early_commission_v1(uuid,uuid,text,numeric)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.exit_hold_expiry_tick_v1(timestamp with time zone)','EXECUTE')
    OR has_table_privilege('authenticated','public.contract_exit_early_terms','INSERT')
    OR has_table_privilege('authenticated','public.contract_exit_early_terms','UPDATE')
    OR NOT has_table_privilege('authenticated','public.contract_exit_early_terms','SELECT') THEN
    RAISE EXCEPTION 'tra_phong_truoc_han_nghiem_thu_lech' USING ERRCODE='55000';
  END IF;
END
$check$;
