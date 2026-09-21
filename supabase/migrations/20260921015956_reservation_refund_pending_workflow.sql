-- T6R: source-owned pending REFUND birth; no generic reservation leg permission.
BEGIN;
DO $preflight$
DECLARE r record; p record;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ie_action_snapshot_reader' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND rolinherit)
  OR pg_has_role('authenticated','ie_action_snapshot_reader','SET') OR has_schema_privilege('ie_action_snapshot_reader','public','CREATE') OR has_schema_privilege('ie_action_snapshot_reader','app_private','CREATE') THEN RAISE EXCEPTION 'Reservation workflow reader role drift'; END IF;
 FOR r IN SELECT * FROM (VALUES
  ('request_income_expense_changes_v2(uuid,bigint,text,jsonb,text)','a7b885abecda8b1b8a5a6545f3c76975','a7b885abecda8b1b8a5a6545f3c76975','postgres',ARRAY['authenticated','postgres']::text[],true),
  ('resubmit_income_expense_v2(uuid,bigint,jsonb,text)','d3a9226f0b75940c354e5c81497097b4','d3a9226f0b75940c354e5c81497097b4','postgres',ARRAY['authenticated','postgres']::text[],true),
  ('app_private.authorize_income_expense_review_v1(income_expenses,text)','251d09422281d3c1febfee1a209164b7','513ac209277c5b6ffb3b13a8c25217c2','postgres',ARRAY['postgres']::text[],true),
  ('app_private.finance_v2_route_pure_v1(text,uuid)','a9065c83fc736836b440f4118bd5a05d','a9065c83fc736836b440f4118bd5a05d','postgres',ARRAY['authenticated','postgres']::text[],true),
  ('app_private.assert_cashbook_access_v2(uuid,uuid,text,uuid)','7c4b1df92d33caf68b2b41947e812ca4','7c4b1df92d33caf68b2b41947e812ca4','postgres',ARRAY['postgres']::text[],true),
  ('app_private.assert_income_expense_flow_owner_v2(uuid,text)','24b19401c868aed0a266760dd675f268','24b19401c868aed0a266760dd675f268','postgres',ARRAY['postgres']::text[],true),
  ('app_private.lock_org_for_decision_v1(uuid)','6130719b1956a291878bed6c58800e5a','6130719b1956a291878bed6c58800e5a','postgres',ARRAY['postgres']::text[],true),
  ('app_private.income_expense_action_scope_v1(uuid)','38d6b30b15990db2c3ab043eb2161865','38d6b30b15990db2c3ab043eb2161865','postgres',ARRAY['ie_action_snapshot_reader','postgres']::text[],true),
  ('app_private.income_expense_action_capabilities_v1(uuid,uuid)','f46a0e9c31bf3dde66348dd048ad1d7f','f9990586ef08a9a83fa225b186c60699','postgres',ARRAY['ie_action_snapshot_reader','postgres']::text[],true),
  ('app_private.resolve_finance_actor_v2()','b95ceecadba70fe6c24304ce8e5a7e4f','b95ceecadba70fe6c24304ce8e5a7e4f','postgres',ARRAY['postgres']::text[],true),
  ('app_private.resolve_finance_actor_v2(uuid)','840896c6babad119cd41462d8804f4a8','840896c6babad119cd41462d8804f4a8','postgres',ARRAY['postgres']::text[],true),
  ('approve_and_post_income_expense_v2(jsonb)','a6f22730d4c8eb574c62ab2d5abadb67','a6f22730d4c8eb574c62ab2d5abadb67','postgres',ARRAY['authenticated','postgres','service_role']::text[],true),
  ('approve_income_expense_v2(uuid,bigint,text)','6837c1c821c0782242974abe7887f2db','6837c1c821c0782242974abe7887f2db','postgres',ARRAY['authenticated','postgres','service_role']::text[],true),
  ('post_approved_income_expense_v2(jsonb)','e52de7af90d025785411d7f094d7d7c4','e52de7af90d025785411d7f094d7d7c4','postgres',ARRAY['authenticated','postgres','service_role']::text[],true),
  ('app_private.guard_income_expense_owned_payload()','18b3e1c11f3e698f1daf2cd082313448','18b3e1c11f3e698f1daf2cd082313448','postgres',ARRAY['postgres']::text[],true),
  ('app_private.reservation_refund_lock_v1(uuid,uuid,uuid)','2bb353755f22d8c7e08702fec2c6ace0','2bb353755f22d8c7e08702fec2c6ace0','postgres',ARRAY['postgres']::text[],false),
  ('create_reservation_refund_pending_v1(jsonb)','278d496fba8a08d1d1e72e2bf1312e83','278d496fba8a08d1d1e72e2bf1312e83','postgres',ARRAY['authenticated','postgres']::text[],false),
  ('app_private.reservation_refund_visible_v1(uuid,uuid,uuid)','a7ef392fa48e097862d27feda83ee31f','a7ef392fa48e097862d27feda83ee31f','ie_action_snapshot_reader',ARRAY['ie_action_snapshot_reader','postgres']::text[],false),
  ('execute_reservation_refund_action_v1(jsonb)','11b01d7f0d76e2055b30d141665d1575','11b01d7f0d76e2055b30d141665d1575','postgres',ARRAY['authenticated','postgres']::text[],false),
  ('app_private.reservation_refund_dispatch_authorized_v1(uuid,uuid,text)','f6d529ada90335ca5c0c8d613ec0cf3f','f6d529ada90335ca5c0c8d613ec0cf3f','postgres',ARRAY['postgres']::text[],false),
  ('app_private.reservation_create_refund_pending_leg_v1(uuid,uuid,date,numeric,text,text,text)','e59fb268a4f22bb6b08ad71feb8ece16','e59fb268a4f22bb6b08ad71feb8ece16','postgres',ARRAY['postgres']::text[],false),
  ('app_private.reservation_pay_refund_v1(uuid,uuid,date)','94b846b86cf718a8b7a43e7bb2fbe0b9','3e2484a389ff3ed00532f62f61afd6ee','postgres',ARRAY['postgres']::text[],true),
  ('app_private.finance_v2_post_manual_voucher(income_expenses,uuid,uuid,uuid,date,uuid[],text)','c2d88ccaae0d8c8a0d425ac4d6cd7f7f','528e457cc02ddcec3c0cd2c67044ae09','postgres',ARRAY['postgres']::text[],true),
  ('app_private.reservation_refund_facts_v1(uuid,uuid)','0d77ad2123f48f4253d7df4babedf0c1','0d77ad2123f48f4253d7df4babedf0c1','postgres',ARRAY['ie_action_snapshot_reader','postgres']::text[],false),
  ('read_reservation_refund_workflow_v1(uuid,uuid,uuid)','44bf80a2acb361d41d18a3956d86eb06','44bf80a2acb361d41d18a3956d86eb06','ie_action_snapshot_reader',ARRAY['authenticated','ie_action_snapshot_reader']::text[],false),
  ('app_private.reservation_refund_capability_v1(uuid,uuid)','7ea652670f4bc4a5e59387257113d40d','7ea652670f4bc4a5e59387257113d40d','postgres',ARRAY['postgres']::text[],false),
  ('app_private.reservation_settlement_refunded_v1(uuid)','02d1075cb9dfe5c818df4df1e337b844','02d1075cb9dfe5c818df4df1e337b844','postgres',ARRAY['postgres']::text[],true),
  ('reverse_posted_income_expense_v2(uuid,uuid,date,text,text)','9fcc9d100dd7fd3a858038a10dc6e701','50cd5cb62b41700f0d2130ccdad44419','postgres',ARRAY['authenticated','postgres','service_role']::text[],true),
  ('app_private.guard_reservation_settlement_record_v1()','ff65f4132becbb3a8f539ef6ccc93aba','ff65f4132becbb3a8f539ef6ccc93aba','postgres',ARRAY['postgres']::text[],true),
  ('app_private.guard_reservation_voucher_v1()','a8553c7d23a1d692a516770d4c9a6e89','a8553c7d23a1d692a516770d4c9a6e89','postgres',ARRAY['postgres']::text[],true),
  ('app_private.reservation_settlement_assert_v1(uuid)','08e07be756a8191c656e2de10f3e8cb8','08e07be756a8191c656e2de10f3e8cb8','postgres',ARRAY['postgres']::text[],true),
  ('app_private.reservation_settlement_authorize_v1(uuid)','c97eca94179cfb17f311451862702e2e','c97eca94179cfb17f311451862702e2e','postgres',ARRAY['postgres']::text[],true),
  ('app_private.reservation_settlement_basis_v1(uuid)','219467570be24a534be637d9356c70d1','219467570be24a534be637d9356c70d1','postgres',ARRAY['postgres']::text[],true),
  ('app_private.reservation_settlement_can_read_v1(uuid,uuid)','8a6c5a166fd34072c1e31e78c1cc3920','8a6c5a166fd34072c1e31e78c1cc3920','postgres',ARRAY['authenticated','postgres']::text[],true),
  ('settle_reservation_deposit_v1(jsonb)','160d8a7b616dfd9919b12ac1cbeb5445','160d8a7b616dfd9919b12ac1cbeb5445','postgres',ARRAY['authenticated','postgres','service_role']::text[],true),
  ('pay_reservation_refund_v1(jsonb)','c0ea7d7c05bf1e69ee53b1315e30bf57','c0ea7d7c05bf1e69ee53b1315e30bf57','postgres',ARRAY['authenticated','postgres','service_role']::text[],true),
  ('app_private.reservation_create_leg_v1(uuid,text,uuid,uuid,date,numeric)','61e14ad271c7b79e5931f09ab6d0bed2','b12a257d0820acdf10a625ae68126648','postgres',ARRAY['postgres']::text[],true)
 ) f(signature,before_hash,after_hash,owner_name,roles,required) LOOP
  IF to_regprocedure(r.signature) IS NULL THEN
   IF r.required THEN RAISE EXCEPTION 'Reservation workflow missing dependency: %',r.signature; END IF;
   CONTINUE;
  END IF;
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(r.signature);
  IF md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM r.before_hash AND md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM r.after_hash THEN RAISE EXCEPTION 'Reservation workflow definition drift: %',r.signature; END IF;
  IF p.proowner IS DISTINCT FROM r.owner_name::regrole::oid OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>ALL(ARRAY(SELECT CASE WHEN role_name='PUBLIC' THEN 0::oid ELSE role_name::regrole::oid END FROM unnest(r.roles) role_name)) OR a.is_grantable OR a.privilege_type<>'EXECUTE')
   OR EXISTS(SELECT 1 FROM unnest(r.roles) role_name WHERE NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=CASE WHEN role_name='PUBLIC' THEN 0::oid ELSE role_name::regrole::oid END AND a.privilege_type='EXECUTE')) THEN RAISE EXCEPTION 'Reservation workflow owner/ACL drift: %',r.signature; END IF;
 END LOOP;
 FOR r IN SELECT * FROM (VALUES ('public.contract_deposit_links','a01_reservation_contract_link_guard','94eaa571587bb066bc4eb579a3ea87fb'),
  ('public.income_expense_items','a01_reservation_item_guard','5dd4b6c8868d08e8018bd4d83e8cdade'),
  ('public.income_expense_postings','a01_reservation_posting_guard','8e98e33c5fd32a77d7614966917fbb42'),
  ('public.income_expenses','a01_reservation_voucher_guard','1e183a793d94198a2e4e41041ef6983f'),
  ('public.reservation_deposit_settlements','reservation_settlement_record_guard','42ae678ffee7a1455a334267d63fe3bf'),
  ('public.reservation_settlement_vouchers','reservation_settlement_voucher_record_guard','3f4139554de3bf28a9d988857c1be01f')) x(relation,trigger_name,expected_hash) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=r.relation::regclass AND t.tgname=r.trigger_name AND t.tgenabled='O' AND md5(pg_get_triggerdef(t.oid))=r.expected_hash) THEN RAISE EXCEPTION 'Reservation workflow trigger drift: %',r.trigger_name; END IF;
 END LOOP;
 IF has_table_privilege('authenticated','app_private.reservation_settlement_write_tokens','INSERT,UPDATE,DELETE') OR has_table_privilege('ie_action_snapshot_reader','app_private.reservation_settlement_write_tokens','INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'Reservation workflow token ACL drift'; END IF;
END $preflight$;
CREATE OR REPLACE FUNCTION app_private.reservation_refund_visible_v1(p_org uuid,p_settlement uuid,p_voucher uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private SET row_security=on AS $fn$
BEGIN
 PERFORM app_private.income_expense_action_scope_v1(p_org);
 RETURN EXISTS(SELECT 1 FROM public.reservation_deposit_settlements s JOIN public.income_expenses src ON src.id=s.source_voucher_id AND src.organization_id=s.organization_id
  WHERE s.id=p_settlement AND s.organization_id=p_org AND src.deleted_at IS NULL
   AND (p_voucher IS NULL OR EXISTS(SELECT 1 FROM public.reservation_settlement_vouchers l JOIN public.income_expenses v ON v.id=l.voucher_id AND v.organization_id=l.organization_id
    WHERE l.settlement_id=s.id AND l.organization_id=s.organization_id AND l.kind='REFUND' AND v.id=p_voucher AND v.deleted_at IS NULL)));
END $fn$;
GRANT CREATE ON SCHEMA app_private TO ie_action_snapshot_reader;
ALTER FUNCTION app_private.reservation_refund_visible_v1(uuid,uuid,uuid) OWNER TO ie_action_snapshot_reader;
REVOKE CREATE ON SCHEMA app_private FROM ie_action_snapshot_reader;
REVOKE ALL ON FUNCTION app_private.reservation_refund_visible_v1(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app_private.reservation_refund_visible_v1(uuid,uuid,uuid) TO postgres;

CREATE OR REPLACE FUNCTION app_private.reservation_refund_lock_v1(p_org uuid,p_settlement uuid,p_source uuid)
RETURNS public.reservation_deposit_settlements LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s public.reservation_deposit_settlements; src public.income_expenses; basis jsonb;
BEGIN
 IF NOT app_private.reservation_refund_visible_v1(p_org,p_settlement,NULL) THEN RAISE EXCEPTION 'Không có quyền xử lý nguồn hoàn cọc này' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM public.reservation_deposit_settlements WHERE id=p_settlement AND organization_id=p_org AND source_voucher_id=p_source;
 IF NOT FOUND THEN RAISE EXCEPTION 'Nguồn hoàn cọc không khớp' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.rooms WHERE id=s.room_id FOR NO KEY UPDATE;
 PERFORM app_private.lock_org_for_decision_v1(s.organization_id);
 SELECT * INTO src FROM public.income_expenses WHERE id=s.source_voucher_id AND organization_id=s.organization_id FOR UPDATE;
 SELECT * INTO s FROM public.reservation_deposit_settlements WHERE id=s.id AND organization_id=p_org AND source_voucher_id=p_source FOR UPDATE;
 PERFORM app_private.resolve_finance_actor_v2(s.organization_id);
 IF NOT app_private.reservation_refund_visible_v1(p_org,s.id,NULL) OR NOT app_private.reservation_settlement_can_read_v1(s.organization_id,s.building_id) THEN RAISE EXCEPTION 'Không có quyền xử lý nguồn hoàn cọc này' USING ERRCODE='42501'; END IF;
 basis:=app_private.reservation_settlement_basis_v1(src.id);
 IF NOT COALESCE((basis->>'received')::boolean,false) OR COALESCE((basis->>'mismatch')::boolean,true)
  OR basis->>'fingerprint' IS DISTINCT FROM s.basis_fingerprint OR (basis->>'amount')::numeric IS DISTINCT FROM s.deposit_amount
  OR s.deposit_amount IS DISTINCT FROM s.refund_amount+s.retained_amount
  OR src.contract_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.contract_deposit_links WHERE income_expense_id=src.id) THEN
   RAISE EXCEPTION 'Căn cứ tiền cọc đã thay đổi; cần đối chiếu nguồn hoàn' USING ERRCODE='55000';
 END IF;
 RETURN s;
END $fn$;
REVOKE ALL ON FUNCTION app_private.reservation_refund_lock_v1(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.reservation_create_refund_pending_leg_v1(p_settlement uuid,p_voucher uuid,p_day date,p_amount numeric,p_recipient text,p_bank text,p_account_number text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s public.reservation_deposit_settlements;src public.income_expenses;tid uuid;mid uuid;actor_name text;
BEGIN
 SELECT * INTO s FROM public.reservation_deposit_settlements WHERE id=p_settlement;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM app_private.reservation_settlement_write_tokens WHERE settlement_id=s.id AND xid=pg_current_xact_id()) THEN RAISE EXCEPTION 'Thiếu quyền ghi hồ sơ hoàn cọc' USING ERRCODE='42501'; END IF;
 IF p_amount IS NULL OR p_amount<=0 OR p_amount::text IN ('NaN','Infinity','-Infinity') OR p_amount<>trunc(p_amount) OR p_amount>9007199254740991
  OR p_amount IS DISTINCT FROM s.refund_amount-app_private.reservation_settlement_refunded_v1(s.id) THEN RAISE EXCEPTION 'Phải lập phiếu cho toàn bộ khoản còn phải hoàn' USING ERRCODE='22023'; END IF;
 IF p_day IS NULL OR p_day<s.settlement_date OR p_day>public.org_today_v1(s.organization_id) THEN RAISE EXCEPTION 'Ngày hoàn tiền không hợp lệ' USING ERRCODE='22023'; END IF;
 SELECT * INTO src FROM public.income_expenses WHERE id=s.source_voucher_id;
 SELECT membership_id INTO mid FROM app_private.resolve_finance_actor_v2(s.organization_id);
 SELECT COALESCE(NULLIF(btrim(full_name),''),NULLIF(btrim(email),'')) INTO actor_name FROM public.profiles WHERE id=auth.uid();
 tid:=app_private.ensure_income_expense_type_v1(s.organization_id,auth.uid(),'Hoàn cọc giữ chỗ','expense',NULL,NULL,false,true,false,false,false,true);
 INSERT INTO public.reservation_settlement_vouchers(voucher_id,settlement_id,organization_id,kind) VALUES(p_voucher,s.id,s.organization_id,'REFUND');
 INSERT INTO public.income_expenses(id,organization_id,user_id,type,name,building_id,room_id,account_id,voucher_date,total_amount,
  approval_status,review_state,posting_mode,posting_status,system_source,payer_name,receive_bank_name,receive_bank_account,notes,maker_membership_id,maker_user_id,creator_name)
 VALUES(p_voucher,s.organization_id,auth.uid(),'EXPENSE','Hoàn cọc giữ chỗ',s.building_id,s.room_id,NULL,p_day,p_amount,
  'UNAPPROVED','PENDING','CASHBOOK','UNPOSTED','reservation.refund',COALESCE(NULLIF(btrim(p_recipient),''),src.payer_name),NULLIF(btrim(p_bank),''),NULLIF(btrim(p_account_number),''),
  'Xử lý phiếu cọc '||COALESCE(src.code,src.id::text)||'. '||s.reason_text,mid,auth.uid(),actor_name);
 INSERT INTO public.income_expense_items(organization_id,income_expense_id,income_expense_type_id,description,quantity,unit_price,amount,accounting_class,start_date,end_date)
 VALUES(s.organization_id,p_voucher,tid,'Hoàn cọc giữ chỗ',1,p_amount,p_amount,'DEPOSIT',p_day,p_day);
END $fn$;
REVOKE ALL ON FUNCTION app_private.reservation_create_refund_pending_leg_v1(uuid,uuid,date,numeric,text,text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.create_reservation_refund_pending_v1(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s public.reservation_deposit_settlements; v public.income_expenses; vid uuid; uid uuid; mid uuid; remaining numeric; op app_private.canonical_write_operations; key text; response jsonb; existing boolean;
BEGIN
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('organizationId','sourceVoucherId','settlementId','basisFingerprint','expectedRemaining','idempotencyKey','recipientName','bank','accountNumber')) THEN RAISE EXCEPTION 'Thông tin lập phiếu không hợp lệ' USING ERRCODE='22023'; END IF;
 key:=btrim(p_input->>'idempotencyKey');
 IF key IS NULL OR length(key) NOT BETWEEN 8 AND 200 OR length(COALESCE(p_input->>'recipientName',''))>500 OR length(COALESCE(p_input->>'bank',''))>200 OR length(COALESCE(p_input->>'accountNumber',''))>200 THEN RAISE EXCEPTION 'Thông tin người nhận hoặc mã yêu cầu không hợp lệ' USING ERRCODE='22023'; END IF;
 s:=app_private.reservation_refund_lock_v1((p_input->>'organizationId')::uuid,(p_input->>'settlementId')::uuid,(p_input->>'sourceVoucherId')::uuid);
 SELECT user_id,membership_id INTO uid,mid FROM app_private.resolve_finance_actor_v2(s.organization_id);
 IF NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(uid,s.organization_id,'deposits.refund',s.building_id,NULL)),false) THEN RAISE EXCEPTION 'Cần quyền xử lý hoàn cọc tại tòa nhà' USING ERRCODE='42501'; END IF;
 IF app_private.finance_v2_route_pure_v1('income_expense.workflow.v2',s.organization_id) IS DISTINCT FROM 'CANONICAL' THEN RAISE EXCEPTION 'Quy trình chờ duyệt chưa sẵn sàng' USING ERRCODE='55000'; END IF;
 vid:=s.refund_voucher_id;existing:=vid IS NOT NULL;
 IF existing AND NOT app_private.reservation_refund_visible_v1(s.organization_id,s.id,vid) THEN RAISE EXCEPTION 'Khoản hoàn đã có phiếu cần người có quyền đối chiếu' USING ERRCODE='42501'; END IF;
 vid:=COALESCE(vid,gen_random_uuid());
 op:=app_private.finance_v2_begin_canonical_op(s.organization_id,'reservation.refund.pending.v1',s.id::text,uid,mid,key,md5(p_input::text),vid);
 IF op.completed_at IS NOT NULL THEN
  IF NOT app_private.reservation_refund_visible_v1(s.organization_id,s.id,op.subject_id) THEN RAISE EXCEPTION 'Khoản hoàn đã có phiếu cần người có quyền đối chiếu' USING ERRCODE='42501'; END IF;
  RETURN op.response_payload;
 END IF;
 remaining:=s.refund_amount-app_private.reservation_settlement_refunded_v1(s.id);
 IF p_input->>'basisFingerprint' IS DISTINCT FROM s.basis_fingerprint OR (p_input->>'expectedRemaining')::numeric IS DISTINCT FROM remaining THEN RAISE EXCEPTION 'Căn cứ hoặc số còn phải hoàn đã thay đổi; tải lại nguồn' USING ERRCODE='55000'; END IF;
 IF existing THEN
  SELECT * INTO v FROM public.income_expenses WHERE id=vid AND organization_id=s.organization_id FOR UPDATE;
  IF v.system_source IS DISTINCT FROM 'reservation.refund' OR v.deleted_at IS NOT NULL OR v.approval_status='CANCELLED' THEN RAISE EXCEPTION 'Phiếu hoàn hiện tại cần đối chiếu' USING ERRCODE='55000'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.reservation_settlement_vouchers WHERE settlement_id=s.id AND kind='REFUND') THEN RAISE EXCEPTION 'Liên kết phiếu hoàn cần đối chiếu' USING ERRCODE='55000'; END IF;
  INSERT INTO app_private.reservation_settlement_write_tokens(settlement_id,xid) VALUES(s.id,pg_current_xact_id());
  PERFORM app_private.reservation_create_refund_pending_leg_v1(s.id,vid,public.org_today_v1(s.organization_id),remaining,p_input->>'recipientName',p_input->>'bank',p_input->>'accountNumber');
  UPDATE public.reservation_deposit_settlements SET refund_voucher_id=vid WHERE id=s.id;
  DELETE FROM app_private.reservation_settlement_write_tokens WHERE settlement_id=s.id AND xid=pg_current_xact_id();
 END IF;
 response:=jsonb_build_object('voucherId',vid,'settlementId',s.id,'sourceVoucherId',s.source_voucher_id,'outcome',CASE WHEN existing THEN 'existing' ELSE 'created' END);
 PERFORM app_private.finance_v2_finish_canonical_op(s.organization_id,'reservation.refund.pending.v1',s.id::text,uid,key,vid,response,'PENDING',NULL,NULL,NULL);
 PERFORM app_private.finance_v2_log_event(s.organization_id,'reservation.refund.pending.v1',vid,uid,key);
 RETURN response;
END $fn$;
REVOKE ALL ON FUNCTION public.create_reservation_refund_pending_v1(jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.create_reservation_refund_pending_v1(jsonb) TO authenticated;
CREATE OR REPLACE FUNCTION app_private.reservation_create_leg_v1(p_settlement uuid, p_kind text, p_voucher uuid, p_account uuid, p_day date, p_amount numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE s public.reservation_deposit_settlements; src public.income_expenses; tid uuid; mid uuid;
  actor_name text; title text; side text; source text; is_dep boolean; posting uuid;
BEGIN
  SELECT * INTO s FROM public.reservation_deposit_settlements WHERE id=p_settlement;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM app_private.reservation_settlement_write_tokens
    WHERE settlement_id=s.id AND xid=pg_current_xact_id()) THEN
    RAISE EXCEPTION 'Thiếu quyền ghi hồ sơ bỏ cọc' USING ERRCODE='42501';
  END IF;
  SELECT * INTO src FROM public.income_expenses WHERE id=s.source_voucher_id;
  SELECT membership_id INTO mid FROM app_private.resolve_finance_actor_v2(s.organization_id);
  SELECT COALESCE(NULLIF(btrim(full_name),''),NULLIF(btrim(email),'')) INTO actor_name FROM public.profiles WHERE id=auth.uid();
  IF p_kind='REVENUE' THEN
    title:='Doanh thu bỏ cọc giữ chỗ'; side:='INCOME'; source:='reservation.forfeit_revenue'; is_dep:=false;
  ELSIF p_kind='OFFSET' THEN
    title:='Cấn cọc giữ chỗ chuyển doanh thu'; side:='EXPENSE'; source:='reservation.forfeit_offset'; is_dep:=true;
  ELSIF p_kind='REFUND' THEN
    title:='Hoàn cọc giữ chỗ'; side:='EXPENSE'; source:='reservation.refund'; is_dep:=true;
  ELSE RAISE EXCEPTION 'Loại bút toán bỏ cọc không hợp lệ' USING ERRCODE='22023'; END IF;
  IF p_kind='REFUND' THEN
    PERFORM app_private.reservation_create_refund_pending_leg_v1(s.id,p_voucher,p_day,p_amount,NULL,NULL,NULL);
    UPDATE public.income_expenses SET account_id=p_account WHERE id=p_voucher;
  ELSE
  tid:=app_private.ensure_income_expense_type_v1(s.organization_id,auth.uid(),title,lower(side),NULL,NULL,false,is_dep,false,false,false,true);
  INSERT INTO public.reservation_settlement_vouchers(voucher_id,settlement_id,organization_id,kind)
    VALUES(p_voucher,s.id,s.organization_id,p_kind);
  INSERT INTO public.income_expenses(id,organization_id,user_id,type,name,building_id,room_id,account_id,
    voucher_date,total_amount,approval_status,posting_mode,posting_status,system_source,payer_name,notes,maker_membership_id,creator_name)
  VALUES(p_voucher,s.organization_id,auth.uid(),side,title,s.building_id,s.room_id,p_account,
    p_day,p_amount,'UNAPPROVED',CASE WHEN p_kind='REFUND' THEN 'CASHBOOK' ELSE 'NON_CASH' END,
    CASE WHEN p_kind='REFUND' THEN 'UNPOSTED' ELSE 'NOT_APPLICABLE' END,source,src.payer_name,
    'Xử lý phiếu cọc '||COALESCE(src.code,src.id::text)||'. '||s.reason_text,mid,actor_name);
  INSERT INTO public.income_expense_items(organization_id,income_expense_id,income_expense_type_id,
    description,quantity,unit_price,amount,accounting_class,start_date,end_date)
  VALUES(s.organization_id,p_voucher,tid,title,1,p_amount,p_amount,CASE WHEN is_dep THEN 'DEPOSIT' ELSE 'PNL' END,p_day,p_day);
  END IF;
  -- Specialized authorized decision, retaining the canonical manual birth boundary.
  -- Token suppresses both legacy posting bridges; shared core owns cash calculations.
  INSERT INTO app_private.ie_transition_authorization(income_expense_id,xid,purpose)
    VALUES(p_voucher,pg_current_xact_id(),'FINANCE_V2_LIFECYCLE')
    ON CONFLICT(income_expense_id) DO UPDATE SET xid=EXCLUDED.xid,purpose=EXCLUDED.purpose,granted_at=now();
  UPDATE public.income_expenses SET approval_status='APPROVED',approved_by=auth.uid(),approved_at=now(),
    review_state='RESOLVED',approval_version=approval_version+1,updated_at=now() WHERE id=p_voucher;
  IF p_kind='REFUND' THEN
    posting:=app_private.finance_v2_post_voucher_with_source_v1(
      p_org=>s.organization_id,p_voucher_id=>p_voucher,p_source_kind=>'RESERVATION_REFUND',
      p_external_kind=>'RESERVATION_REFUND_VOUCHER',p_external_id=>p_voucher,p_external_line_id=>NULL,
      p_posted_on=>p_day,p_amount_basis=>'VOUCHER_TOTAL',p_generation=>1);
    UPDATE public.income_expenses SET active_posting_id_v2=posting,posting_id=posting,posting_status='POSTED',
      posted_at_v2=now(),posting_version=posting_version+1,updated_at=now() WHERE id=p_voucher;
  END IF;
  DELETE FROM app_private.ie_transition_authorization WHERE income_expense_id=p_voucher AND xid=pg_current_xact_id();
END $function$
;
CREATE OR REPLACE FUNCTION app_private.reservation_pay_refund_v1(p_settlement uuid, p_account uuid, p_day date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE s public.reservation_deposit_settlements; a public.accounts; mid uuid; remaining numeric; vid uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO s FROM public.reservation_deposit_settlements WHERE id=p_settlement FOR UPDATE;
  PERFORM app_private.reservation_settlement_authorize_v1(s.source_voucher_id);
  SELECT membership_id INTO mid FROM app_private.resolve_finance_actor_v2(s.organization_id);
  SELECT * INTO a FROM public.accounts WHERE id=p_account FOR UPDATE;
  IF NOT FOUND OR a.organization_id IS DISTINCT FROM s.organization_id OR a.deleted_at IS NOT NULL OR a.is_virtual THEN
    RAISE EXCEPTION 'Chọn sổ quỹ thực đang hoạt động trong tổ chức này để hoàn tiền' USING ERRCODE='42501';
  END IF;
  PERFORM app_private.assert_cashbook_access_v2(s.organization_id,a.id,'CUSTODIAN',mid);
  IF p_day IS NULL OR p_day<s.settlement_date OR p_day>public.org_today_v1(s.organization_id) THEN
    RAISE EXCEPTION 'Ngày hoàn tiền không hợp lệ' USING ERRCODE='22023';
  END IF;
  remaining:=s.refund_amount-app_private.reservation_settlement_refunded_v1(s.id);
  IF remaining<=0 THEN RAISE EXCEPTION 'Khoản cọc này không còn tiền chờ hoàn' USING ERRCODE='55000'; END IF;
  -- A pending workflow already owns this obligation. Never create a second leg.
  IF EXISTS(SELECT 1 FROM public.reservation_settlement_vouchers l JOIN public.income_expenses v ON v.id=l.voucher_id
    WHERE l.settlement_id=s.id AND l.kind='REFUND' AND v.deleted_at IS NULL
      AND (v.approval_status='UNAPPROVED' OR (v.approval_status='APPROVED' AND v.posting_status='UNPOSTED'))) THEN
    RAISE EXCEPTION 'Khoản hoàn đã có phiếu chờ xử lý; tiếp tục duyệt hoặc chi phiếu hiện có' USING ERRCODE='55000';
  END IF;
  PERFORM app_private.reservation_create_leg_v1(s.id,'REFUND',vid,p_account,p_day,remaining);
  UPDATE public.reservation_deposit_settlements SET refund_voucher_id=vid WHERE id=s.id;
  IF app_private.reservation_settlement_refunded_v1(s.id)<>s.refund_amount THEN
    RAISE EXCEPTION 'Số tiền hoàn đã ghi sổ không khớp' USING ERRCODE='23514';
  END IF;
  RETURN vid;
END $function$
;

CREATE OR REPLACE FUNCTION app_private.reservation_refund_dispatch_authorized_v1(p_org uuid,p_voucher uuid,p_action text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
 SELECT EXISTS(SELECT 1 FROM public.reservation_settlement_vouchers l
  JOIN public.reservation_deposit_settlements s ON s.id=l.settlement_id AND s.organization_id=l.organization_id
  JOIN public.income_expenses v ON v.id=l.voucher_id AND v.organization_id=l.organization_id
  JOIN app_private.reservation_settlement_write_tokens t ON t.settlement_id=s.id AND t.xid=pg_current_xact_id()
  JOIN app_private.canonical_write_operations o ON o.organization_id=s.organization_id AND o.subject_scope=v.id::text
   AND o.actor_id=auth.uid() AND o.transaction_id=pg_current_xact_id() AND o.completed_at IS NULL
  WHERE l.organization_id=p_org AND l.voucher_id=p_voucher AND l.kind='REFUND' AND v.system_source='reservation.refund' AND v.type='EXPENSE'
   AND ((p_action IS NOT NULL AND o.operation='reservation.refund.'||p_action||'.v1')
    OR (p_action IS NULL AND o.operation IN ('reservation.refund.post.v1','reservation.refund.approve_and_post.v1'))))
$fn$;
REVOKE ALL ON FUNCTION app_private.reservation_refund_dispatch_authorized_v1(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.execute_reservation_refund_action_v1(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s public.reservation_deposit_settlements;v public.income_expenses;uid uuid;mid uuid;key text;action text;operation text;permission text;
 op app_private.canonical_write_operations;remaining numeric;paid numeric;response jsonb;posting_input jsonb;aid uuid;day date;
BEGIN
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('organizationId','sourceVoucherId','settlementId','basisFingerprint','expectedRemaining','voucherId','expectedApprovalVersion','expectedPostingVersion','expectedReviewVersion','action','idempotencyKey','reason','cashbookId','postedOn','evidenceIds')) THEN RAISE EXCEPTION 'Thông tin xử lý phiếu không hợp lệ' USING ERRCODE='22023'; END IF;
 action:=p_input->>'action';key:=btrim(p_input->>'idempotencyKey');
 IF action IS NULL OR action NOT IN ('approve','approve_and_post','post','request_changes','resubmit','reverse') OR key IS NULL OR length(key) NOT BETWEEN 8 AND 200 THEN RAISE EXCEPTION 'Lệnh hoặc mã yêu cầu không hợp lệ' USING ERRCODE='22023'; END IF;
 s:=app_private.reservation_refund_lock_v1((p_input->>'organizationId')::uuid,(p_input->>'settlementId')::uuid,(p_input->>'sourceVoucherId')::uuid);
 IF NOT app_private.reservation_refund_visible_v1(s.organization_id,s.id,(p_input->>'voucherId')::uuid) THEN RAISE EXCEPTION 'Không có quyền xử lý phiếu hoàn này' USING ERRCODE='42501'; END IF;
 SELECT * INTO v FROM public.income_expenses WHERE id=(p_input->>'voucherId')::uuid AND organization_id=s.organization_id FOR UPDATE;
 IF v.id IS NULL OR v.id IS DISTINCT FROM s.refund_voucher_id OR v.system_source IS DISTINCT FROM 'reservation.refund' OR v.type IS DISTINCT FROM 'EXPENSE'
   OR NOT EXISTS(SELECT 1 FROM public.reservation_settlement_vouchers WHERE voucher_id=v.id AND settlement_id=s.id AND organization_id=s.organization_id AND kind='REFUND') THEN RAISE EXCEPTION 'Phiếu không phải khoản hoàn hiện tại của nguồn' USING ERRCODE='55000'; END IF;
 PERFORM app_private.assert_income_expense_flow_owner_v2(v.id,'CANONICAL_INCOME_EXPENSE');
 SELECT user_id,membership_id INTO uid,mid FROM app_private.resolve_finance_actor_v2(s.organization_id);
 permission:=CASE WHEN action IN ('approve','approve_and_post','request_changes') THEN 'income_expenses.approve' WHEN action='reverse' THEN 'income_expenses.reverse' WHEN action='resubmit' AND v.maker_user_id IS NULL THEN 'income_expenses.edit' END;
 IF action='resubmit' AND v.maker_user_id IS NOT NULL AND v.maker_user_id IS DISTINCT FROM uid THEN RAISE EXCEPTION 'Chỉ người lập phiếu được gửi duyệt lại' USING ERRCODE='42501'; END IF;
 IF permission IS NOT NULL AND NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(uid,s.organization_id,permission,s.building_id,NULL)),false) THEN RAISE EXCEPTION 'Thiếu quyền xử lý phiếu trong tòa nhà' USING ERRCODE='42501'; END IF;
 IF app_private.finance_v2_route_pure_v1('income_expense.workflow.v2',s.organization_id) IS DISTINCT FROM 'CANONICAL' OR (action IN ('post','approve_and_post','reverse') AND app_private.finance_v2_route_pure_v1('income_expense.posting.v2',s.organization_id) IS DISTINCT FROM 'CANONICAL') THEN RAISE EXCEPTION 'Quy trình xử lý phiếu chưa sẵn sàng' USING ERRCODE='55000'; END IF;
 IF action IN ('post','approve_and_post','reverse') THEN
  aid:=(p_input->>'cashbookId')::uuid;day:=(p_input->>'postedOn')::date;
  PERFORM 1 FROM public.accounts WHERE id=aid AND organization_id=s.organization_id AND deleted_at IS NULL AND NOT is_virtual FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Chọn sổ quỹ thực đang hoạt động trong tổ chức' USING ERRCODE='42501'; END IF;
  PERFORM app_private.assert_cashbook_access_v2(s.organization_id,aid,'CUSTODIAN',mid);
  IF day IS NULL OR day<s.settlement_date OR day>public.org_today_v1(s.organization_id) THEN RAISE EXCEPTION 'Ngày chi hoặc hoàn tác không hợp lệ' USING ERRCODE='22023'; END IF;
  IF action='reverse' AND v.account_id IS DISTINCT FROM aid THEN RAISE EXCEPTION 'Phải hoàn tác đúng sổ quỹ đã chi' USING ERRCODE='42501'; END IF;
 END IF;
 -- Source, active membership, operation permission and custody are checked before replay.
 operation:='reservation.refund.'||action||'.v1';
 op:=app_private.finance_v2_begin_canonical_op(s.organization_id,operation,v.id::text,uid,mid,key,md5(p_input::text),v.id);
 IF op.completed_at IS NOT NULL THEN RETURN op.response_payload; END IF;
 paid:=app_private.reservation_settlement_refunded_v1(s.id);remaining:=s.refund_amount-paid;
 IF p_input->>'basisFingerprint' IS DISTINCT FROM s.basis_fingerprint OR (p_input->>'expectedRemaining')::numeric IS DISTINCT FROM remaining
  OR (p_input->>'expectedApprovalVersion')::bigint IS DISTINCT FROM v.approval_version
  OR (p_input->>'expectedPostingVersion')::bigint IS DISTINCT FROM v.posting_version
  OR (p_input->>'expectedReviewVersion')::bigint IS DISTINCT FROM v.review_version THEN RAISE EXCEPTION 'Phiếu hoặc nghĩa vụ đã thay đổi; tải lại trước khi xử lý' USING ERRCODE='55000'; END IF;
 IF action<>'reverse' AND (remaining<=0 OR v.total_amount IS DISTINCT FROM remaining) THEN RAISE EXCEPTION 'Phiếu phải khớp toàn bộ khoản còn phải hoàn' USING ERRCODE='55000'; END IF;
 IF action IN ('approve','approve_and_post') AND (v.approval_status IS DISTINCT FROM 'UNAPPROVED' OR v.review_state IS DISTINCT FROM 'PENDING' OR v.posting_status IS DISTINCT FROM 'UNPOSTED' OR v.active_posting_id_v2 IS NOT NULL OR EXISTS(SELECT 1 FROM public.income_expense_postings p WHERE p.voucher_id=v.id AND p.event_kind='POSTING' AND NOT EXISTS(SELECT 1 FROM public.income_expense_postings r WHERE r.reversal_of_id=p.id))) THEN RAISE EXCEPTION 'Phiếu không còn ở trạng thái chờ duyệt' USING ERRCODE='55000'; END IF;
 INSERT INTO app_private.reservation_settlement_write_tokens(settlement_id,xid) VALUES(s.id,pg_current_xact_id());
 IF action='request_changes' THEN
  response:=public.request_income_expense_changes_v2(v.id,v.review_version,p_input->>'reason','{}'::jsonb,key||':shared');
 ELSIF action='resubmit' THEN
  response:=public.resubmit_income_expense_v2(v.id,v.review_version,'{}'::jsonb,key||':shared');
 ELSIF action='approve' THEN
  response:=public.approve_income_expense_v2(v.id,v.approval_version,key||':shared');
 ELSIF action='reverse' THEN
  response:=public.reverse_posted_income_expense_v2(v.id,aid,day,p_input->>'reason',key||':shared');
 ELSE
  posting_input:=jsonb_build_object('subjectKind','VOUCHER','subjectId',v.id,'cashbookId',aid,'postedOn',day,'evidenceIds',COALESCE(p_input->'evidenceIds','[]'::jsonb),'expectedApprovalVersion',v.approval_version,'expectedPostingVersion',v.posting_version,'executionRevision',0,'idempotencyKey',key||':shared');
  IF action='approve_and_post' THEN response:=public.approve_and_post_income_expense_v2(posting_input);
  ELSE response:=public.post_approved_income_expense_v2(posting_input); END IF;
 END IF;
 PERFORM app_private.reservation_settlement_assert_v1(s.id);
 IF action IN ('post','approve_and_post') AND app_private.reservation_settlement_refunded_v1(s.id) IS DISTINCT FROM s.refund_amount THEN RAISE EXCEPTION 'Số tiền hoàn ghi sổ không khớp nghĩa vụ' USING ERRCODE='23514'; END IF;
 IF action='reverse' AND app_private.reservation_settlement_refunded_v1(s.id) IS DISTINCT FROM paid-v.total_amount THEN RAISE EXCEPTION 'Số tiền hoàn tác không khớp nghĩa vụ' USING ERRCODE='23514'; END IF;
 DELETE FROM app_private.reservation_settlement_write_tokens WHERE settlement_id=s.id AND xid=pg_current_xact_id();
 SELECT * INTO v FROM public.income_expenses WHERE id=v.id;
 PERFORM app_private.finance_v2_finish_canonical_op(s.organization_id,operation,v.id::text,uid,key,v.id,response,v.posting_status,v.review_version,v.approval_version,v.posting_version);
 PERFORM app_private.finance_v2_log_event(s.organization_id,operation,v.id,uid,key);
 RETURN response;
END $fn$;
REVOKE ALL ON FUNCTION public.execute_reservation_refund_action_v1(jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.execute_reservation_refund_action_v1(jsonb) TO authenticated;
CREATE OR REPLACE FUNCTION app_private.authorize_income_expense_review_v1(p_voucher income_expenses, p_action text)
 RETURNS TABLE(user_id uuid, membership_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE v_uid uuid; v_mid uuid; v_permission text;
BEGIN
  IF p_action NOT IN ('request_changes','resubmit') OR p_action IS NULL THEN
    RAISE EXCEPTION 'Unsupported review operation' USING ERRCODE='22023';
  END IF;
  SELECT r.user_id, r.membership_id INTO v_uid, v_mid
  FROM app_private.resolve_finance_actor_v2(p_voucher.organization_id) r;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o
    WHERE o.id=p_voucher.organization_id AND o.status='ACTIVE') THEN
    RAISE EXCEPTION 'Active organization required' USING ERRCODE='42501';
  END IF;
  IF p_voucher.building_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.buildings b WHERE b.id=p_voucher.building_id
      AND b.organization_id=p_voucher.organization_id AND b.deleted_at IS NULL
      AND app_private.building_org_visible_v1(b.id)
      AND (public.can_access_building(b.id) OR public.ie_all_buildings_scope(b.id))
  ) THEN RAISE EXCEPTION 'Building scope denied' USING ERRCODE='42501'; END IF;
  IF (p_voucher.has_restricted_item AND p_voucher.user_id IS DISTINCT FROM v_uid AND NOT public.can_view_restricted_ie())
    OR ((public.is_admin() OR public.is_super_admin()) AND p_voucher.user_id=ANY(public.demo_user_ids())) THEN
    RAISE EXCEPTION 'Voucher access denied' USING ERRCODE='42501';
  END IF;
  -- No ownership row means an existing legacy voucher; domain owners still fail closed.
  PERFORM app_private.assert_income_expense_flow_owner_v2(p_voucher.id, 'CANONICAL_INCOME_EXPENSE');
  -- Reservation's existing source guard has no review dispatcher. Do not bypass it.
  IF p_voucher.system_source IN ('reservation.refund','reservation.forfeit_revenue','reservation.forfeit_offset')
    OR EXISTS (SELECT 1 FROM public.reservation_deposit_settlements s WHERE s.source_voucher_id=p_voucher.id)
    OR EXISTS (SELECT 1 FROM public.reservation_settlement_vouchers s WHERE s.voucher_id=p_voucher.id) THEN
    IF NOT app_private.reservation_refund_dispatch_authorized_v1(p_voucher.organization_id,p_voucher.id,p_action) THEN
      RAISE EXCEPTION 'Source review dispatcher unavailable' USING ERRCODE='42501';
    END IF;
  END IF;
  IF p_action='resubmit' AND p_voucher.maker_user_id IS NOT NULL THEN
    IF p_voucher.maker_user_id IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'Only the original maker may resubmit' USING ERRCODE='42501';
    END IF;
  ELSE
    v_permission := CASE WHEN p_action='request_changes' THEN 'income_expenses.approve' ELSE 'income_expenses.edit' END;
    IF NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
      v_uid,p_voucher.organization_id,v_permission,p_voucher.building_id,NULL)),false) THEN
      RAISE EXCEPTION 'Review capability required in building scope' USING ERRCODE='42501';
    END IF;
  END IF;
  IF app_private.finance_v2_route_pure_v1('income_expense.workflow.v2',p_voucher.organization_id)='FROZEN' THEN
    RAISE EXCEPTION 'Review workflow frozen' USING ERRCODE='55000';
  END IF;
  RETURN QUERY SELECT v_uid,v_mid;
END
$function$
;
CREATE OR REPLACE FUNCTION app_private.finance_v2_post_manual_voucher(p_ie income_expenses, p_actor_user uuid, p_actor_membership uuid, p_cashbook uuid, p_posted_on date, p_evidence_ids uuid[], p_idempotency_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_posting_id uuid := gen_random_uuid();
  v_gen integer;
  v_signed numeric(18,2);
  v_ev uuid;
  v_ev_count integer := 0;
BEGIN
  IF p_ie.total_amount <= 0 THEN
    RAISE EXCEPTION 'finance_v2_post_manual_voucher: voucher total must be positive to post' USING ERRCODE = '55000';
  END IF;

  -- At least one FINALIZED evidence for a manual posting.
  IF p_evidence_ids IS NULL OR array_length(p_evidence_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'finance_v2_post_manual_voucher: at least one FINALIZED evidence is required' USING ERRCODE = '55000';
  END IF;

  v_signed := CASE WHEN p_ie.type = 'INCOME' THEN p_ie.total_amount ELSE -p_ie.total_amount END;

  -- 7x: re-post sau reversal = thế hệ bút toán MỚI (unique generation giữ 1
  -- POSTING active/thế hệ; bút toán cũ + reversal bất biến).
  SELECT COALESCE(MAX(p2.posting_generation), 0) + 1 INTO v_gen
  FROM public.income_expense_postings p2
  WHERE p2.organization_id = p_ie.organization_id
    AND p2.posting_subject_kind = 'VOUCHER'
    AND p2.posting_subject_id = p_ie.id
    AND p2.event_kind = 'POSTING';

  INSERT INTO public.income_expense_postings (
    id, organization_id, voucher_id, posting_subject_kind, posting_subject_id,
    direction, account_id, gross_amount, voucher_amount_snapshot, amount_basis,
    net_cash_effect, posted_on, posted_by_membership_id, posted_by_user_id,
    approval_version, event_kind, idempotency_key, source_kind, posting_generation, created_at
  ) VALUES (
    v_posting_id, p_ie.organization_id, p_ie.id, 'VOUCHER', p_ie.id,
    p_ie.type, p_cashbook, p_ie.total_amount, p_ie.total_amount, 'VOUCHER_TOTAL',
    v_signed, p_posted_on, p_actor_membership, p_actor_user,
    p_ie.approval_version, 'POSTING', p_idempotency_key || ':posting', CASE WHEN app_private.reservation_refund_dispatch_authorized_v1(p_ie.organization_id,p_ie.id,NULL) THEN 'RESERVATION_REFUND' ELSE 'MANUAL' END, v_gen, now()
  );

  INSERT INTO public.income_expense_posting_lines (
    id, organization_id, posting_id, account_id, line_kind, signed_amount, created_at
  ) VALUES (
    gen_random_uuid(), p_ie.organization_id, v_posting_id, p_cashbook, 'MAIN', v_signed, now()
  );

  -- Attach evidence: lock FINALIZED rows, link ORIGINAL, flip to ATTACHED.
  FOREACH v_ev IN ARRAY p_evidence_ids LOOP
    PERFORM 1 FROM public.finance_evidence_objects e
     WHERE e.id = v_ev AND e.organization_id = p_ie.organization_id
       AND e.state = 'FINALIZED'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'finance_v2_post_manual_voucher: evidence % is not FINALIZED in tenant', v_ev USING ERRCODE = '55000';
    END IF;
    INSERT INTO public.income_expense_posting_evidence (
      id, organization_id, posting_id, evidence_id, relation_kind, created_at
    ) VALUES (
      gen_random_uuid(), p_ie.organization_id, v_posting_id, v_ev, 'ORIGINAL', now()
    );
    UPDATE public.finance_evidence_objects e SET state = 'ATTACHED' WHERE e.id = v_ev;
    v_ev_count := v_ev_count + 1;
  END LOOP;

  IF v_ev_count = 0 THEN
    RAISE EXCEPTION 'finance_v2_post_manual_voucher: at least one FINALIZED evidence is required' USING ERRCODE = '55000';
  END IF;

  RETURN v_posting_id;
END
$function$
;

CREATE OR REPLACE FUNCTION app_private.reservation_refund_facts_v1(p_org uuid,p_settlement uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s public.reservation_deposit_settlements;src public.income_expenses;basis jsonb;paid numeric;remaining numeric;valid boolean;allowed boolean;leg_count integer;route text;
BEGIN
 IF NOT app_private.reservation_refund_visible_v1(p_org,p_settlement,NULL) THEN RAISE EXCEPTION 'Không có quyền xem nguồn hoàn cọc' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT s FROM public.reservation_deposit_settlements WHERE id=p_settlement AND organization_id=p_org;
 SELECT * INTO STRICT src FROM public.income_expenses WHERE id=s.source_voucher_id AND organization_id=p_org;
 basis:=app_private.reservation_settlement_basis_v1(src.id);paid:=app_private.reservation_settlement_refunded_v1(s.id);remaining:=s.refund_amount-paid;
 valid:=COALESCE((basis->>'received')::boolean,false) AND NOT COALESCE((basis->>'mismatch')::boolean,true)
  AND basis->>'fingerprint' IS NOT DISTINCT FROM s.basis_fingerprint AND (basis->>'amount')::numeric IS NOT DISTINCT FROM s.deposit_amount
  AND s.deposit_amount=s.refund_amount+s.retained_amount AND paid BETWEEN 0 AND s.refund_amount
  AND src.contract_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.contract_deposit_links WHERE income_expense_id=src.id);
 SELECT EXISTS(SELECT 1 FROM app_private.authorized_scope_v3('deposits.refund',p_org) p WHERE p.org_wide OR s.building_id=ANY(p.building_ids)) INTO allowed;
 SELECT count(*) INTO leg_count FROM public.reservation_settlement_vouchers WHERE settlement_id=s.id AND kind='REFUND';
 route:=app_private.finance_v2_route_pure_v1('income_expense.workflow.v2',p_org);
 RETURN jsonb_build_object('basisValid',COALESCE(valid,false),'paid',paid,'remaining',remaining,'existingVoucherId',s.refund_voucher_id,
  'canCreate',COALESCE(valid AND allowed AND route='CANONICAL' AND remaining>0 AND s.refund_voucher_id IS NULL AND leg_count=0,false),
  'blockedReason',CASE WHEN NOT COALESCE(valid,false) THEN 'Căn cứ tiền cọc cần được đối chiếu.' WHEN s.refund_voucher_id IS NOT NULL THEN NULL
   WHEN leg_count<>0 THEN 'Liên kết phiếu hoàn cần được đối chiếu.' WHEN remaining<=0 THEN 'Không còn khoản tiền phải hoàn.'
   WHEN NOT allowed THEN 'Bạn chưa có quyền lập phiếu hoàn cọc tại tòa nhà này.' WHEN route IS DISTINCT FROM 'CANONICAL' THEN 'Quy trình chờ duyệt chưa sẵn sàng.' ELSE NULL END);
END $fn$;
REVOKE ALL ON FUNCTION app_private.reservation_refund_facts_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app_private.reservation_refund_facts_v1(uuid,uuid) TO ie_action_snapshot_reader;

CREATE OR REPLACE FUNCTION public.read_reservation_refund_workflow_v1(p_organization_id uuid,p_source_voucher_id uuid,p_settlement_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private SET row_security=on AS $fn$
DECLARE s public.reservation_deposit_settlements;src public.income_expenses;v public.income_expenses;facts jsonb;existing_id uuid;hidden boolean;result jsonb;
BEGIN
 PERFORM app_private.income_expense_action_scope_v1(p_organization_id);
 SELECT * INTO src FROM public.income_expenses WHERE id=p_source_voucher_id AND organization_id=p_organization_id AND deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Không có quyền xem nguồn hoàn cọc' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM public.reservation_deposit_settlements WHERE source_voucher_id=src.id AND organization_id=p_organization_id AND (p_settlement_id IS NULL OR id=p_settlement_id);
 IF NOT FOUND THEN RAISE EXCEPTION 'Nguồn chưa có nghĩa vụ hoàn giữ chỗ phù hợp' USING ERRCODE='P0002'; END IF;
 facts:=app_private.reservation_refund_facts_v1(s.organization_id,s.id);existing_id:=(facts->>'existingVoucherId')::uuid;
 IF existing_id IS NOT NULL THEN SELECT * INTO v FROM public.income_expenses WHERE id=existing_id AND organization_id=s.organization_id AND deleted_at IS NULL; END IF;
 hidden:=existing_id IS NOT NULL AND v.id IS NULL;
 result:=jsonb_build_object('organizationId',s.organization_id,'actorId',auth.uid(),'sourceVoucherId',src.id,'settlementId',s.id,
  'sourceCode',src.code,'payerName',src.payer_name,'sourceDate',src.voucher_date,'settlementDate',s.settlement_date,'today',public.org_today_v1(s.organization_id),
  'basisFingerprint',s.basis_fingerprint,'basisValid',(facts->>'basisValid')::boolean,'depositAmount',s.deposit_amount,'retainedAmount',s.retained_amount,'refundAmount',s.refund_amount,
  'paid',(facts->>'paid')::numeric,'remaining',(facts->>'remaining')::numeric,'canCreate',(facts->>'canCreate')::boolean AND NOT hidden,
  'existingVoucherId',v.id,'hiddenExisting',hidden,'blockedReason',CASE WHEN hidden THEN 'Khoản hoàn đã có phiếu cần người có quyền đối chiếu.' ELSE facts->>'blockedReason' END);
 RETURN result||jsonb_build_object('revision',md5(jsonb_build_array(result,v.approval_status,v.review_state,v.approval_version,v.review_version,v.posting_status,v.posting_version)::text));
END $fn$;
GRANT CREATE ON SCHEMA public TO ie_action_snapshot_reader;
ALTER FUNCTION public.read_reservation_refund_workflow_v1(uuid,uuid,uuid) OWNER TO ie_action_snapshot_reader;
REVOKE CREATE ON SCHEMA public FROM ie_action_snapshot_reader;
REVOKE ALL ON FUNCTION public.read_reservation_refund_workflow_v1(uuid,uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.read_reservation_refund_workflow_v1(uuid,uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION app_private.reservation_refund_capability_v1(p_org uuid,p_voucher uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s public.reservation_deposit_settlements;v public.income_expenses;facts jsonb;
BEGIN
 SELECT parent.* INTO s FROM public.reservation_deposit_settlements parent JOIN public.reservation_settlement_vouchers l ON l.settlement_id=parent.id AND l.organization_id=parent.organization_id
 WHERE l.voucher_id=p_voucher AND l.organization_id=p_org AND l.kind='REFUND';
 IF NOT FOUND OR NOT app_private.reservation_refund_visible_v1(p_org,s.id,p_voucher) THEN RETURN NULL; END IF;
 SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher AND organization_id=p_org;
 IF v.system_source IS DISTINCT FROM 'reservation.refund' OR v.type IS DISTINCT FROM 'EXPENSE' THEN RETURN NULL; END IF;
 facts:=app_private.reservation_refund_facts_v1(p_org,s.id);
 RETURN jsonb_build_object('settlementId',s.id,'sourceVoucherId',s.source_voucher_id,'basisFingerprint',s.basis_fingerprint,
  'remaining',(facts->>'remaining')::numeric,'basisValid',(facts->>'basisValid')::boolean,'current',s.refund_voucher_id=v.id,
  'fullRemaining',v.total_amount=(facts->>'remaining')::numeric AND (facts->>'remaining')::numeric>0);
END $fn$;
REVOKE ALL ON FUNCTION app_private.reservation_refund_capability_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION app_private.income_expense_action_capabilities_v1(p_voucher uuid, p_organization uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE v public.income_expenses%ROWTYPE; f text; pair app_private.termination_forfeit_authorizations%ROWTYPE;
  v_manual boolean := true; v_engine boolean; v_forfeit_allowed boolean := false; v_edit boolean; v_restricted boolean;
BEGIN
  -- Only the non-bypass snapshot owner can call this helper, after materializing
  -- the voucher through authenticated RLS. Clients have no EXECUTE privilege.
  PERFORM app_private.income_expense_action_scope_v1(p_organization);
  SELECT * INTO STRICT v FROM public.income_expenses WHERE id=p_voucher AND organization_id=p_organization AND deleted_at IS NULL;
  SELECT flow_kind INTO f FROM app_private.income_expense_flow_ownership WHERE income_expense_id=v.id AND organization_id=v.organization_id;
  SELECT * INTO pair FROM app_private.termination_forfeit_authorizations
    WHERE organization_id=v.organization_id AND (revenue_voucher_id=v.id OR offset_voucher_id=v.id);
  IF FOUND THEN
    SELECT EXISTS(SELECT 1 FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id
      CROSS JOIN LATERAL app_private.authorized_scope_v3('income_expenses.approve',v.organization_id) p
      WHERE c.id=pair.contract_id AND c.organization_id=v.organization_id
        AND (p.org_wide OR r.building_id=ANY(p.building_ids))) INTO v_forfeit_allowed;
    -- Existing pair writer permits super admin; this flag only mirrors its authority.
    v_forfeit_allowed := v_forfeit_allowed OR public.is_super_admin();
  END IF;
  SELECT EXISTS(SELECT 1 FROM public.approval_requests a WHERE a.subject_type='FINANCIAL_VOUCHER'
    AND a.subject_id=ANY(ARRAY[v.id,pair.revenue_voucher_id,pair.offset_voucher_id])
    AND a.state IN ('PENDING_APPROVAL','POSTED')) INTO v_engine;
  BEGIN PERFORM app_private.assert_manual_voucher_v1(v.id,'sửa');
  EXCEPTION WHEN insufficient_privilege THEN v_manual := false; END;
  v_restricted := NOT COALESCE(v.has_restricted_item,false) OR v.user_id=auth.uid()
    OR public.can_view_restricted_ie() OR public.is_super_admin();
  -- Exact legacy cancel_income_expense_v1 edit guard; no new authority is granted.
  v_edit := v_restricted AND (public.is_super_admin() OR public.is_admin()
    OR public.has_perm_full_scope('income_expenses','edit')
    OR v.building_id IN (SELECT public.permitted_building_ids('income_expenses','edit'))
    OR (v.user_id=auth.uid() AND v.building_id IN (SELECT public.ie_all_buildings_action_ids('edit'))));
  RETURN jsonb_build_object('forfeitPair',pair.revenue_voucher_id IS NOT NULL,'forfeitAllowed',v_forfeit_allowed,
    'engineBlocked',v_engine,'manual',v_manual,'legacyCancelAllowed',COALESCE(v_edit,false),
    'compatCancelOwner',COALESCE(v_restricted AND (v.user_id=auth.uid() OR public.is_super_admin()
      OR app_private.is_org_owner_v1(v.organization_id,auth.uid())),false),
    'birthPrior',v.birth_txid IS NOT NULL AND v.birth_txid IS DISTINCT FROM pg_current_xact_id_if_assigned(),
    'requiresRealAccount',v.shareholder_id IS NOT NULL,
    'reservationMoneyBlocked',COALESCE(v.system_source LIKE 'reservation.%',false)
      OR EXISTS(SELECT 1 FROM public.reservation_deposit_settlements s WHERE s.organization_id=v.organization_id AND s.source_voucher_id=v.id)
      OR EXISTS(SELECT 1 FROM public.reservation_settlement_vouchers leg WHERE leg.organization_id=v.organization_id AND leg.voucher_id=v.id),
    'reservationRefundReverseAllowed',COALESCE(v.system_source='reservation.refund',false)
      AND EXISTS(SELECT 1 FROM public.reservation_settlement_vouchers leg WHERE leg.organization_id=v.organization_id AND leg.voucher_id=v.id)) || jsonb_build_object('reservationRefund',app_private.reservation_refund_capability_v1(p_organization,p_voucher));
END
$function$
;

-- The compatibility reverse entrypoint must take the reservation organization
-- decision lock before it locks the voucher. The dispatcher already holds that
-- organization lock when it calls this function. Keeping one order prevents a
-- direct Thu-chi reverse and a source-owned reverse from waiting on each other.
DO $lock_order$
DECLARE def text; old_auth text; voucher_anchor text; begin_anchor text;
BEGIN
 def:=pg_get_functiondef('public.reverse_posted_income_expense_v2(uuid,uuid,date,text,text)'::regprocedure);
 old_auth:='PERFORM app_private.reservation_authorize_reversal_v1(p_voucher,p_cashbook);';
 voucher_anchor:='SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;';
 begin_anchor:='v_op := app_private.finance_v2_begin_canonical_op(';
 IF strpos(def,old_auth)=0 OR strpos(def,voucher_anchor)=0 OR strpos(def,begin_anchor)=0 THEN
  RAISE EXCEPTION 'Reservation reverse lock-order definition drift';
 END IF;
 IF strpos(def,old_auth)>strpos(def,voucher_anchor) THEN
  def:=replace(def,old_auth||E'\n  '||begin_anchor,begin_anchor);
  IF strpos(def,old_auth)>0 THEN RAISE EXCEPTION 'Reservation reverse lock-order duplicate authorization'; END IF;
  def:=replace(def,voucher_anchor,old_auth||E'\n  '||voucher_anchor);
  EXECUTE def;
 END IF;
END $lock_order$;

NOTIFY pgrst,'reload schema';
-- Keep stable ownership when the deployment principal inherits postgres privileges.
ALTER FUNCTION app_private.reservation_refund_lock_v1(uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION create_reservation_refund_pending_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION execute_reservation_refund_action_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.reservation_refund_dispatch_authorized_v1(uuid,uuid,text) OWNER TO postgres;
ALTER FUNCTION app_private.reservation_create_refund_pending_leg_v1(uuid,uuid,date,numeric,text,text,text) OWNER TO postgres;
ALTER FUNCTION app_private.reservation_refund_facts_v1(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION app_private.reservation_refund_capability_v1(uuid,uuid) OWNER TO postgres;
COMMIT;
