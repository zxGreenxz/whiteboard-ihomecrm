-- EX01: two linked contracts. Existing exit, signing and commission writers remain authoritative.
-- No deposit voucher reassignment, new refund/offset engine, occupancy change or money permission change.
CREATE TABLE IF NOT EXISTS public.contract_transfer_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES public.organizations(id),
  building_id uuid NOT NULL REFERENCES public.buildings(id),room_id uuid NOT NULL REFERENCES public.rooms(id),
  old_contract_id uuid NOT NULL REFERENCES public.contracts(id),old_exit_case_id uuid NOT NULL REFERENCES public.contract_exit_cases(id),
  new_draft_id uuid NOT NULL REFERENCES public.contract_drafts(id),new_draft_revision integer NOT NULL CHECK(new_draft_revision>0),
  new_contract_id uuid UNIQUE REFERENCES public.contracts(id),old_party_snapshot jsonb NOT NULL,new_party_snapshot jsonb NOT NULL,
  old_contract_number text,old_customer_name text,new_customer_name text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('SELF_FOUND','BROKER')),deposit_mode text NOT NULL CHECK(deposit_mode IN ('NEW_PAYMENT','OLD_DEPOSIT_OFFSET')),
  term_mode text NOT NULL CHECK(term_mode IN ('KEEP_OLD_END_DATE','NEW_TERM')),starts_on date NOT NULL,ends_on date NOT NULL CHECK(ends_on>=starts_on),
  new_deposit_required numeric NOT NULL CHECK(new_deposit_required>=0),broker_name text,
  deposit_base numeric NOT NULL CHECK(deposit_base>=0),broker_fee numeric NOT NULL CHECK(broker_fee>=0),
  fee_state text NOT NULL CHECK(fee_state IN ('NOT_REQUIRED','PENDING','APPLIED')),
  commission_voucher_id uuid UNIQUE REFERENCES public.income_expenses(id),state text NOT NULL DEFAULT 'LINKED' CHECK(state IN ('LINKED','CANCELLED')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),policy_version text NOT NULL DEFAULT 'EX01-N1-2026-09-28',
  reason text NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_id uuid NOT NULL UNIQUE,intent_hash text NOT NULL,
  CHECK(mode<>'BROKER' OR (deposit_mode='NEW_PAYMENT' AND NULLIF(btrim(broker_name),'') IS NOT NULL)),CHECK(old_contract_id IS DISTINCT FROM new_contract_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS contract_transfer_live_exit ON public.contract_transfer_links(old_exit_case_id) WHERE state='LINKED';
CREATE UNIQUE INDEX IF NOT EXISTS contract_transfer_live_draft ON public.contract_transfer_links(new_draft_id) WHERE state='LINKED';
CREATE TABLE IF NOT EXISTS app_private.contract_transfer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),link_id uuid NOT NULL REFERENCES public.contract_transfer_links(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),event text NOT NULL CHECK(event IN ('CREATED','CANCELLED','NEW_SIGNED','FEE_APPLIED','COMMISSION_LINKED')),
  version bigint NOT NULL,actor_id uuid NOT NULL,reason text NOT NULL,request_id uuid UNIQUE,intent_hash text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(link_id,version)
);
ALTER TABLE public.contract_transfer_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_transfer_links_read ON public.contract_transfer_links;
CREATE POLICY contract_transfer_links_read ON public.contract_transfer_links FOR SELECT TO authenticated
  USING(app_private.contract_draft_scope_allowed(organization_id,building_id,'contracts.view'));
DROP POLICY IF EXISTS contract_transfer_links_hide_sandbox_admin ON public.contract_transfer_links;
CREATE POLICY contract_transfer_links_hide_sandbox_admin ON public.contract_transfer_links AS RESTRICTIVE FOR ALL TO authenticated
  USING(NOT COALESCE(public.is_super_admin() AND organization_id=ANY(public.sandbox_org_ids()),false))
  WITH CHECK(NOT COALESCE(public.is_super_admin() AND organization_id=ANY(public.sandbox_org_ids()),false));
-- Readers redact operational money snapshots; no raw SELECT bypass.
REVOKE ALL ON public.contract_transfer_links,app_private.contract_transfer_events FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.contract_transfer_response_v1(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  SELECT (to_jsonb(l)-ARRAY['old_party_snapshot','new_party_snapshot','intent_hash','request_id','new_deposit_required'])
    ||jsonb_build_object('deposit_base',CASE WHEN app_private.contract_draft_scope_allowed(l.organization_id,l.building_id,'contracts.edit') THEN l.deposit_base END,
      'broker_fee',CASE WHEN app_private.contract_draft_scope_allowed(l.organization_id,l.building_id,'contracts.edit') THEN l.broker_fee END,
      'new_contract_number',c.contract_number,'commission_code',v.code,'commission_approval_status',v.approval_status,
      'money_state',CASE WHEN l.deposit_mode='OLD_DEPOSIT_OFFSET' THEN 'NEEDS_REVIEW'
        WHEN l.mode='SELF_FOUND' THEN 'INDEPENDENT' WHEN l.fee_state='PENDING' THEN 'FEE_PENDING'
        WHEN l.commission_voucher_id IS NULL THEN 'COMMISSION_PENDING' ELSE 'COMMISSION_LINKED' END,
      'history',COALESCE((SELECT jsonb_agg(jsonb_build_object('event',h.event,'version',h.version,'reason',h.reason,'actor_id',h.actor_id,
        'actor_name',p.full_name,'created_at',h.created_at) ORDER BY h.version) FROM app_private.contract_transfer_events h LEFT JOIN public.profiles p ON p.id=h.actor_id WHERE h.link_id=l.id),'[]'::jsonb))
  FROM public.contract_transfer_links l LEFT JOIN public.contracts c ON c.id=l.new_contract_id LEFT JOIN public.income_expenses v ON v.id=l.commission_voucher_id WHERE l.id=p_id
$fn$;

CREATE OR REPLACE FUNCTION public.read_contract_transfer_links_v1(p_organization_id uuid,p_contract_id uuid DEFAULT NULL,p_draft_id uuid DEFAULT NULL,p_exit_case_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_building uuid;v_result jsonb;
BEGIN
  IF num_nonnulls(p_contract_id,p_draft_id,p_exit_case_id)<>1 THEN RAISE EXCEPTION 'Cần chọn đúng một hồ sơ nguồn' USING ERRCODE='22023'; END IF;
  IF p_contract_id IS NOT NULL THEN SELECT r.building_id INTO v_building FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id WHERE c.id=p_contract_id AND c.organization_id=p_organization_id AND c.deleted_at IS NULL;
  ELSIF p_draft_id IS NOT NULL THEN SELECT building_id INTO v_building FROM public.contract_drafts WHERE id=p_draft_id AND organization_id=p_organization_id;
  ELSE SELECT building_id INTO v_building FROM public.contract_exit_cases WHERE id=p_exit_case_id AND organization_id=p_organization_id; END IF;
  IF v_building IS NULL OR NOT app_private.contract_draft_scope_allowed(p_organization_id,v_building,'contracts.view') THEN RAISE EXCEPTION 'Không có quyền đọc hồ sơ nhượng' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(jsonb_agg(app_private.contract_transfer_response_v1(l.id) ORDER BY l.created_at,l.id),'[]'::jsonb) INTO v_result FROM public.contract_transfer_links l
    WHERE l.organization_id=p_organization_id AND (p_contract_id IN (l.old_contract_id,l.new_contract_id) OR l.new_draft_id=p_draft_id OR l.old_exit_case_id=p_exit_case_id);
  RETURN v_result;
END $fn$;

CREATE OR REPLACE FUNCTION public.create_contract_transfer_link_v1(p_organization_id uuid,p_old_exit_case_id uuid,p_new_draft_id uuid,p_expected_exit_version bigint,
  p_expected_draft_revision integer,p_mode text,p_deposit_mode text,p_term_mode text,p_broker_name text,p_reason text,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE e public.contract_exit_cases%ROWTYPE;d public.contract_drafts%ROWTYPE;c public.contracts%ROWTYPE;l public.contract_transfer_links%ROWTYPE;
  v_hash text;v_start date;v_end date;v_new_rep jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('SELF_FOUND','BROKER') OR p_deposit_mode IS NULL OR p_deposit_mode NOT IN ('NEW_PAYMENT','OLD_DEPOSIT_OFFSET')
    OR p_term_mode IS NULL OR p_term_mode NOT IN ('KEEP_OLD_END_DATE','NEW_TERM') OR p_request_id IS NULL OR NULLIF(btrim(p_reason),'') IS NULL OR length(p_reason)>2000
    OR (p_mode='BROKER' AND (p_deposit_mode<>'NEW_PAYMENT' OR NULLIF(btrim(p_broker_name),'') IS NULL)) OR length(p_broker_name)>200 THEN
    RAISE EXCEPTION 'Lựa chọn nhượng không hợp lệ' USING ERRCODE='22023'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO e FROM public.contract_exit_cases WHERE id=p_old_exit_case_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy hồ sơ trả phòng' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(e.organization_id,e.building_id);
  SELECT * INTO d FROM public.contract_drafts WHERE id=p_new_draft_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND OR NOT app_private.contract_draft_scope_allowed(p_organization_id,d.building_id,'contracts.edit') THEN RAISE EXCEPTION 'Không có quyền bản nháp mới' USING ERRCODE='42501'; END IF;
  v_hash:=md5(jsonb_build_object('exit',e.id,'draft',d.id,'exit_version',p_expected_exit_version,'draft_revision',p_expected_draft_revision,
    'mode',p_mode,'deposit',p_deposit_mode,'term',p_term_mode,'broker',NULLIF(btrim(p_broker_name),''),'reason',btrim(p_reason))::text);
  SELECT * INTO l FROM public.contract_transfer_links WHERE request_id=p_request_id;
  IF FOUND THEN
    IF l.created_by<>auth.uid() OR l.organization_id<>p_organization_id OR l.intent_hash<>v_hash THEN RAISE EXCEPTION 'Mã yêu cầu đã dùng cho dữ kiện khác' USING ERRCODE='23505'; END IF;
    RETURN app_private.contract_transfer_response_v1(l.id);
  END IF;
  IF e.state<>'PENDING' OR p_expected_exit_version IS NULL OR e.version<>p_expected_exit_version OR d.status<>'EDITABLE'
    OR p_expected_draft_revision IS NULL OR d.revision<>p_expected_draft_revision THEN RAISE EXCEPTION 'Hồ sơ trả phòng hoặc bản nháp đã thay đổi' USING ERRCODE='PT409'; END IF;
  SELECT * INTO c FROM public.contracts WHERE id=e.contract_id AND organization_id=p_organization_id AND deleted_at IS NULL FOR UPDATE;
  IF c.id IS NULL OR c.room_id IS DISTINCT FROM e.room_at_handover_id OR d.room_id IS DISTINCT FROM e.room_at_handover_id OR d.building_id<>e.building_id THEN
    RAISE EXCEPTION 'Nhượng cần cùng tổ chức, tòa và phòng nguồn' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(d.payload->'customers') IS DISTINCT FROM 'array' OR (SELECT count(*) FROM jsonb_array_elements(d.payload->'customers') j WHERE (j->>'is_representative')::boolean)<>1
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.payload->'customers') j WHERE NOT EXISTS(SELECT 1 FROM public.customers cu WHERE cu.id=(j->>'id')::uuid AND cu.organization_id=p_organization_id AND cu.deleted_at IS NULL)) THEN
    RAISE EXCEPTION 'Khách mới cần một đại diện và đúng tổ chức' USING ERRCODE='22023'; END IF;
  SELECT j INTO v_new_rep FROM jsonb_array_elements(d.payload->'customers') j WHERE (j->>'is_representative')::boolean;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(e.party_snapshot->'customers','[]')) j WHERE j->>'customer_id'=v_new_rep->>'id' AND (j->>'is_representative')::boolean) THEN
    RAISE EXCEPTION 'Nhượng cần đại diện mới, không đổi tên trên hợp đồng cũ' USING ERRCODE='22023'; END IF;
  BEGIN v_start:=(d.payload->'form'->>'start_date')::date;v_end:=(d.payload->'form'->>'end_date')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'Ngày nhận hoặc hạn mới không hợp lệ' USING ERRCODE='22023'; END;
  IF v_start IS NULL OR v_end IS NULL OR v_end<v_start OR (p_term_mode='KEEP_OLD_END_DATE' AND v_end IS DISTINCT FROM c.end_date) THEN RAISE EXCEPTION 'Nháp cần đúng ngày nhận và lựa chọn hạn hợp đồng' USING ERRCODE='22023'; END IF;
  INSERT INTO public.contract_transfer_links(organization_id,building_id,room_id,old_contract_id,old_exit_case_id,new_draft_id,new_draft_revision,
    old_party_snapshot,new_party_snapshot,old_contract_number,old_customer_name,new_customer_name,mode,deposit_mode,term_mode,starts_on,ends_on,new_deposit_required,broker_name,
    deposit_base,broker_fee,fee_state,reason,created_by,request_id,intent_hash)
  VALUES(p_organization_id,e.building_id,e.room_at_handover_id,c.id,e.id,d.id,d.revision,e.party_snapshot,d.payload->'customers',c.contract_number,e.customer_name,v_new_rep->>'full_name',
    p_mode,p_deposit_mode,p_term_mode,v_start,v_end,(d.payload->'form'->>'total_deposit')::numeric,NULLIF(btrim(p_broker_name),''),COALESCE(c.total_deposit,0),
    CASE WHEN p_mode='BROKER' THEN round(COALESCE(c.total_deposit,0)*0.5,2) ELSE 0 END,
    CASE WHEN p_mode='BROKER' THEN 'PENDING' ELSE 'NOT_REQUIRED' END,btrim(p_reason),auth.uid(),p_request_id,v_hash) RETURNING * INTO l;
  INSERT INTO app_private.contract_transfer_events(link_id,organization_id,event,version,actor_id,reason,request_id,intent_hash) VALUES(l.id,l.organization_id,'CREATED',l.version,auth.uid(),l.reason,p_request_id,v_hash);
  RETURN app_private.contract_transfer_response_v1(l.id);
END $fn$;

CREATE OR REPLACE FUNCTION public.cancel_contract_transfer_link_v1(p_organization_id uuid,p_link_id uuid,p_expected_version bigint,p_reason text,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE l public.contract_transfer_links%ROWTYPE;h app_private.contract_transfer_events%ROWTYPE;v_hash text;
BEGIN
  IF p_request_id IS NULL OR NULLIF(btrim(p_reason),'') IS NULL OR length(p_reason)>2000 THEN RAISE EXCEPTION 'Cần lý do và mã yêu cầu' USING ERRCODE='22023'; END IF;
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO l FROM public.contract_transfer_links WHERE id=p_link_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không có quyền hồ sơ nhượng' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(l.organization_id,l.building_id);
  v_hash:=md5(jsonb_build_object('link',l.id,'version',p_expected_version,'reason',btrim(p_reason))::text);
  SELECT * INTO h FROM app_private.contract_transfer_events WHERE request_id=p_request_id;
  IF FOUND THEN
    IF h.link_id<>l.id OR h.actor_id<>auth.uid() OR h.event<>'CANCELLED' OR h.intent_hash<>v_hash THEN RAISE EXCEPTION 'Mã yêu cầu đã dùng' USING ERRCODE='23505'; END IF;
    RETURN app_private.contract_transfer_response_v1(l.id);
  END IF;
  IF p_expected_version IS NULL OR l.version<>p_expected_version OR l.state<>'LINKED' OR l.new_contract_id IS NOT NULL OR l.fee_state='APPLIED' THEN RAISE EXCEPTION 'Nhượng đã thay đổi, ký hoặc ghi phí; không hủy liên kết' USING ERRCODE='PT409'; END IF;
  UPDATE public.contract_transfer_links SET state='CANCELLED',version=version+1,updated_at=clock_timestamp() WHERE id=l.id RETURNING * INTO l;
  INSERT INTO app_private.contract_transfer_events(link_id,organization_id,event,version,actor_id,reason,request_id,intent_hash) VALUES(l.id,l.organization_id,'CANCELLED',l.version,auth.uid(),btrim(p_reason),p_request_id,v_hash);
  RETURN app_private.contract_transfer_response_v1(l.id);
END $fn$;

CREATE OR REPLACE FUNCTION app_private.assert_contract_transfer_draft_v1(p_draft_id uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE l public.contract_transfer_links%ROWTYPE;d public.contract_drafts%ROWTYPE;
BEGIN
  SELECT * INTO l FROM public.contract_transfer_links WHERE new_draft_id=p_draft_id AND state='LINKED' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT app_private.contract_draft_scope_allowed(l.organization_id,l.building_id,'contracts.create') THEN RAISE EXCEPTION 'Không có quyền ký nhượng' USING ERRCODE='42501'; END IF;
  IF l.deposit_mode='OLD_DEPOSIT_OFFSET' THEN RAISE EXCEPTION 'Chưa hỗ trợ chuyển cọc giữa hai hợp đồng; lựa chọn đã lưu để đối soát. Hủy liên kết nếu muốn xử lý cọc riêng theo nghiệp vụ hiện hành.' USING ERRCODE='55000'; END IF;
  SELECT * INTO d FROM public.contract_drafts WHERE id=p_draft_id;
  IF d.organization_id<>l.organization_id OR d.room_id IS DISTINCT FROM l.room_id OR d.building_id<>l.building_id OR d.revision<>l.new_draft_revision
    OR d.payload->'customers' IS DISTINCT FROM l.new_party_snapshot OR (d.payload->'form'->>'start_date')::date IS DISTINCT FROM l.starts_on
    OR (d.payload->'form'->>'end_date')::date IS DISTINCT FROM l.ends_on OR (d.payload->'form'->>'total_deposit')::numeric IS DISTINCT FROM l.new_deposit_required THEN
    RAISE EXCEPTION 'Nháp đã đổi sau khi liên kết nhượng; hủy và lập lại liên kết trước khi ký' USING ERRCODE='PT409'; END IF;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.complete_contract_transfer_signing_v1(p_draft_id uuid,p_contract_id uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE l public.contract_transfer_links%ROWTYPE;c public.contracts%ROWTYPE;
BEGIN
  SELECT * INTO l FROM public.contract_transfer_links WHERE new_draft_id=p_draft_id AND state='LINKED' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF l.new_contract_id=p_contract_id THEN RETURN; END IF;
  PERFORM app_private.assert_contract_transfer_draft_v1(p_draft_id);
  SELECT * INTO c FROM public.contracts WHERE id=p_contract_id AND organization_id=l.organization_id AND deleted_at IS NULL;
  IF c.id IS NULL OR c.id=l.old_contract_id OR c.room_id<>l.room_id THEN RAISE EXCEPTION 'Hợp đồng mới không đúng nguồn nhượng' USING ERRCODE='55000'; END IF;
  IF l.mode='BROKER' THEN
    IF COALESCE(c.deposit_paid,0)<l.new_deposit_required THEN RAISE EXCEPTION 'Nhượng qua môi giới cần khách mới nộp đủ cọc mới theo số cọc đã thu hiện hành; không dùng cọc cũ hoặc ghi thiếu cọc' USING ERRCODE='55000'; END IF;
  END IF;
  UPDATE public.contract_transfer_links SET new_contract_id=c.id,version=version+1,updated_at=clock_timestamp() WHERE id=l.id RETURNING * INTO l;
  INSERT INTO app_private.contract_transfer_events(link_id,organization_id,event,version,actor_id,reason) VALUES(l.id,l.organization_id,'NEW_SIGNED',l.version,auth.uid(),'Đã ký hợp đồng mới từ đúng nháp và điều khoản nhượng');
END $fn$;

CREATE OR REPLACE FUNCTION app_private.assert_contract_transfer_exit_terms_v1(p_case_id uuid,p_kind text,p_settlement jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE l public.contract_transfer_links%ROWTYPE;c public.contracts%ROWTYPE;v_fee jsonb;v_count integer;
BEGIN
  SELECT * INTO l FROM public.contract_transfer_links WHERE old_exit_case_id=p_case_id AND state='LINKED' FOR UPDATE;
  IF NOT FOUND OR l.mode<>'BROKER' THEN RETURN; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(l.organization_id,l.building_id);
  IF p_kind='FORFEIT' THEN RAISE EXCEPTION 'Bỏ cọc hiện hành giữ toàn bộ cọc, trong khi nhượng qua môi giới khấu trừ 50%% và hoàn phần còn lại. Cần kiểm tra lại lựa chọn quyết toán trước khi tiếp tục.' USING ERRCODE='55000'; END IF;
  IF jsonb_typeof(p_settlement->'extra_charges') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Quyết toán cần phí nhượng đã xem trước' USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_count FROM jsonb_array_elements(p_settlement->'extra_charges') j WHERE j->>'description' LIKE 'TRANSFER_BROKER_FEE:%';
  SELECT j INTO v_fee FROM jsonb_array_elements(p_settlement->'extra_charges') j WHERE j->>'description'='TRANSFER_BROKER_FEE:'||l.id::text;
  IF v_count<>1 OR v_fee IS NULL OR v_fee->>'kind' IS DISTINCT FROM 'CUSTOM' OR (v_fee->>'amount')::numeric IS DISTINCT FROM l.broker_fee THEN RAISE EXCEPTION 'Thiếu, sai hoặc trùng phí nhượng bắt buộc 50%% cọc cũ' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM public.contracts WHERE id=l.old_contract_id AND organization_id=l.organization_id AND deleted_at IS NULL FOR UPDATE;
  IF c.id IS NULL OR c.room_id IS DISTINCT FROM l.room_id OR COALESCE(c.total_deposit,0)<>l.deposit_base THEN RAISE EXCEPTION 'Cọc hợp đồng hoặc nguồn liên kết nhượng đã thay đổi; cần tải lại và đối soát' USING ERRCODE='PT409'; END IF;
  IF l.fee_state='PENDING' THEN
    UPDATE public.contract_transfer_links SET fee_state='APPLIED',version=version+1,updated_at=clock_timestamp() WHERE id=l.id RETURNING * INTO l;
    INSERT INTO app_private.contract_transfer_events(link_id,organization_id,event,version,actor_id,reason) VALUES(l.id,l.organization_id,'FEE_APPLIED',l.version,auth.uid(),'Phí 50% cọc cũ chuyển vào quyết toán hiện hành; cùng transaction với hồ sơ trả phòng');
  END IF;
END $fn$;

CREATE OR REPLACE FUNCTION public.finalize_contract_transfer_exit_v1(p_organization_id uuid,p_case_id uuid,p_expected_version bigint,p_idempotency_key text,
  p_current_kind text,p_reason text,p_settlement jsonb,p_link_id uuid,p_expected_link_version bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE l public.contract_transfer_links%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO l FROM public.contract_transfer_links WHERE id=p_link_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không có quyền hồ sơ nhượng' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(l.organization_id,l.building_id);
  IF l.old_exit_case_id<>p_case_id OR l.state<>'LINKED' OR (l.fee_state<>'APPLIED' AND (p_expected_link_version IS NULL OR l.version<>p_expected_link_version)) THEN RAISE EXCEPTION 'Liên kết nhượng đã thay đổi' USING ERRCODE='PT409'; END IF;
  RETURN public.finalize_contract_exit_case_v1(p_organization_id,p_case_id,p_expected_version,p_idempotency_key,p_current_kind,p_reason,p_settlement);
END $fn$;

CREATE OR REPLACE FUNCTION public.create_contract_transfer_commission_v1(p_organization_id uuid,p_link_id uuid,p_expected_version bigint,p_request_id uuid,
  p_account_id uuid DEFAULT NULL,p_recipient_bank text DEFAULT NULL,p_recipient_account text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE l public.contract_transfer_links%ROWTYPE;h app_private.contract_transfer_events%ROWTYPE;v public.income_expenses%ROWTYPE;v_hash text;v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501'; END IF;
  IF p_request_id IS NULL OR length(p_recipient_bank)>200 OR length(p_recipient_account)>200 THEN RAISE EXCEPTION 'Dữ kiện phiếu hoa hồng không hợp lệ' USING ERRCODE='22023'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO l FROM public.contract_transfer_links WHERE id=p_link_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không có quyền hồ sơ nhượng' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_contract_exit_writer_v1(l.organization_id,l.building_id);
  v_hash:=md5(jsonb_build_object('link',l.id,'version',p_expected_version,'account',p_account_id,'bank',p_recipient_bank,'number',p_recipient_account)::text);
  SELECT * INTO h FROM app_private.contract_transfer_events WHERE request_id=p_request_id;
  IF FOUND THEN
    IF h.link_id<>l.id OR h.actor_id<>auth.uid() OR h.event<>'COMMISSION_LINKED' OR h.intent_hash<>v_hash THEN RAISE EXCEPTION 'Mã yêu cầu đã dùng cho phiếu khác' USING ERRCODE='23505'; END IF;
    RETURN app_private.contract_transfer_response_v1(l.id);
  END IF;
  IF p_expected_version IS NULL OR l.version<>p_expected_version OR l.state<>'LINKED' THEN RAISE EXCEPTION 'Hồ sơ nhượng đã thay đổi' USING ERRCODE='PT409'; END IF;
  IF l.mode<>'BROKER' OR l.fee_state<>'APPLIED' OR l.new_contract_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.contract_exit_cases e WHERE e.id=l.old_exit_case_id AND e.state='FINALIZED') THEN
    RAISE EXCEPTION 'Chỉ lập/nối hoa hồng sau khi hợp đồng mới đã ký và phí cũ đã quyết toán; không ghi đã chi trước' USING ERRCODE='55000'; END IF;
  IF l.commission_voucher_id IS NOT NULL THEN RETURN app_private.contract_transfer_response_v1(l.id); END IF;
  SELECT * INTO v FROM public.income_expenses WHERE organization_id=l.organization_id AND contract_id=l.new_contract_id AND commission_kind='broker' AND deleted_at IS NULL AND approval_status<>'CANCELLED' FOR UPDATE;
  IF FOUND THEN
    IF v.type<>'EXPENSE' OR v.total_amount<>l.broker_fee OR v.recipient_name IS DISTINCT FROM l.broker_name THEN RAISE EXCEPTION 'Cần xử lý tiền nhượng: hợp đồng mới đã có phiếu môi giới khác số tiền/người nhận; không tạo trùng hoặc đổi phiếu hiện hành' USING ERRCODE='55000'; END IF;
    v_result:=jsonb_build_object('id',v.id);
  ELSE
    v_result:=public.create_commission_voucher(l.new_contract_id,'broker',l.broker_fee,public.org_today_v1(l.organization_id),p_account_id,NULL,l.broker_name,p_recipient_bank,p_recipient_account,'TRANSFER_BROKER_FEE:'||l.id::text,'[]'::jsonb);
  END IF;
  UPDATE public.contract_transfer_links SET commission_voucher_id=(v_result->>'id')::uuid,version=version+1,updated_at=clock_timestamp() WHERE id=l.id RETURNING * INTO l;
  INSERT INTO app_private.contract_transfer_events(link_id,organization_id,event,version,actor_id,reason,request_id,intent_hash) VALUES(l.id,l.organization_id,'COMMISSION_LINKED',l.version,auth.uid(),'Nối phiếu hoa hồng qua writer hiện hành; trạng thái duyệt/ghi sổ giữ nguyên',p_request_id,v_hash);
  RETURN app_private.contract_transfer_response_v1(l.id);
END $fn$;

-- Explicit additive seams. Refuse drift; never patch the shared money engine or install triggers.
DO $patch$
DECLARE v_def text;v_sig text;v_anchor text;v_replacement text;
BEGIN
  v_sig:='public.finalize_contract_exit_case_v1(uuid,uuid,bigint,text,text,text,jsonb)';
  SELECT pg_get_functiondef(v_sig::regprocedure) INTO v_def;
  IF position('PERFORM app_private.assert_contract_transfer_exit_terms_v1(e.id,p_current_kind,p_settlement);' IN v_def)=0 THEN
    v_anchor:='v_result:=app_private.run_contract_exit_settlement_v1(e.id,p_current_kind,p_settlement,v_key,true);';
    IF length(v_def)-length(replace(v_def,v_anchor,''))<>length(v_anchor) THEN RAISE EXCEPTION 'EX01 exit finalizer anchor drift'; END IF;
    EXECUTE replace(v_def,v_anchor,'PERFORM app_private.assert_contract_transfer_exit_terms_v1(e.id,p_current_kind,p_settlement);'||chr(10)||'  '||v_anchor);
  END IF;
  v_sig:='public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])';
  SELECT pg_get_functiondef(v_sig::regprocedure) INTO v_def;
  IF position('PERFORM app_private.assert_contract_transfer_draft_v1(d.id);' IN v_def)=0 THEN
    v_anchor:='v_result:=public.create_contract_v2(v_payload,''draft-sign:''||d.id::text);';
    IF length(v_def)-length(replace(v_def,v_anchor,''))<>length(v_anchor) THEN RAISE EXCEPTION 'EX01 signing validation anchor drift'; END IF;
    v_def:=replace(v_def,v_anchor,'PERFORM app_private.assert_contract_transfer_draft_v1(d.id);'||chr(10)||'  '||v_anchor);
  END IF;
  IF position('PERFORM app_private.complete_contract_transfer_signing_v1(d.id,c.id);' IN v_def)=0 THEN
    v_anchor:='UPDATE public.contract_drafts SET status=''SIGNED'',converted_contract_id=c.id WHERE id=d.id;';
    IF length(v_def)-length(replace(v_def,v_anchor,''))<>length(v_anchor) THEN RAISE EXCEPTION 'EX01 signing completion anchor drift'; END IF;
    v_def:=replace(v_def,v_anchor,v_anchor||chr(10)||'  PERFORM app_private.complete_contract_transfer_signing_v1(d.id,c.id);');
  END IF;
  EXECUTE v_def;
END $patch$;
DO $acl$
DECLARE v_signature text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'app_private.contract_transfer_response_v1(uuid)','app_private.assert_contract_transfer_draft_v1(uuid)','app_private.complete_contract_transfer_signing_v1(uuid,uuid)',
    'app_private.assert_contract_transfer_exit_terms_v1(uuid,text,jsonb)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_signature);
  END LOOP;
  FOREACH v_signature IN ARRAY ARRAY[
    'public.read_contract_transfer_links_v1(uuid,uuid,uuid,uuid)','public.create_contract_transfer_link_v1(uuid,uuid,uuid,bigint,integer,text,text,text,text,text,uuid)',
    'public.cancel_contract_transfer_link_v1(uuid,uuid,bigint,text,uuid)','public.finalize_contract_transfer_exit_v1(uuid,uuid,bigint,text,text,text,jsonb,uuid,bigint)',
    'public.create_contract_transfer_commission_v1(uuid,uuid,bigint,uuid,uuid,text,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',v_signature);
  END LOOP;
END $acl$;
