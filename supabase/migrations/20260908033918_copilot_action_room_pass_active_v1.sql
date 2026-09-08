-- G2-D: public listing visibility through the canonical setter and Nonce ABI.
-- Rollback is a NEW authorized consent restoring the previous active value.
-- No failure ledger is claimed after a raised transaction has rolled back.
BEGIN;
SET LOCAL lock_timeout = '15s';

-- One locked observation shared by preview/execute. Parent locks precede the
-- listing lock. A relationship changed while waiting is rejected, never followed.
CREATE OR REPLACE FUNCTION app_private.copilot_room_pass_observe_v1(
  p_organization_id uuid, p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $observe$
DECLARE
  v_id uuid;
  v_listing public.room_pass_listings%ROWTYPE;
  v_building public.buildings%ROWTYPE;
  v_room public.rooms%ROWTYPE;
  v_building_id uuid;
  v_room_id uuid;
  v_revision text;
  v_scope record;
  v_snapshot jsonb;
  v_now timestamptz;
BEGIN
  v_snapshot := app_private.copilot_action_gate_v1('room_pass.set_active', p_organization_id);
  IF NOT COALESCE(app_private.copilot_plan_role_allowed_v1(p_organization_id),false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_payload->'active') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE='22023';
  END IF;
  BEGIN
    v_id := (p_payload->>'listing_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE='22023';
  END;
  IF v_id IS NULL THEN RAISE EXCEPTION 'payload_invalid' USING ERRCODE='22023'; END IF;
  SELECT building_id, room_id INTO v_building_id,v_room_id
    FROM public.room_pass_listings WHERE id=v_id AND organization_id=p_organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'entity_not_found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_building FROM public.buildings
    WHERE id=v_building_id AND organization_id=p_organization_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'entity_not_found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_room FROM public.rooms
    WHERE id=v_room_id AND building_id=v_building_id
      AND organization_id=p_organization_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'entity_not_found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_listing FROM public.room_pass_listings
    WHERE id=v_id AND organization_id=p_organization_id
      AND building_id=v_building_id AND room_id=v_room_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'entity_not_found' USING ERRCODE='P0002'; END IF;
  -- Recheck current policy after acquiring all relationship locks.
  v_snapshot := app_private.copilot_action_gate_v1('room_pass.set_active', p_organization_id);
  SELECT s.org_wide,s.building_ids INTO v_scope
    FROM app_private.authorized_scope_v3('sale_phong.manage_pass_listings',p_organization_id) s;
  IF NOT FOUND OR NOT COALESCE(app_private.copilot_plan_role_allowed_v1(p_organization_id),false)
     OR (NOT COALESCE(v_scope.org_wide,false)
         AND NOT (v_building_id=ANY(COALESCE(v_scope.building_ids,ARRAY[]::uuid[]))))
     OR NOT COALESCE(public.can_manage_pass_listing(v_building_id,v_listing.user_id),false) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE='42501';
  END IF;
  -- The shared gate uses transaction-start now(). After any lock wait, a
  -- scheduled deny may have started or a flag may have expired since then.
  -- Keep that gate and add this action-local wall-clock boundary, without
  -- changing other actions' policy. No relationship lock is acquired below.
  v_now := clock_timestamp();
  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry r
      JOIN public.copilot_feature_flags f
        ON f.scope='action' AND f.contract_id=r.flag_contract_id
    WHERE r.action_id='room_pass.set_active' AND r.enabled
      AND f.state IN ('shadow','enabled')
      AND (f.canary_org IS NULL OR f.canary_org=p_organization_id)
      AND (f.expires_at IS NULL OR f.expires_at>v_now)
  ) THEN
    RAISE EXCEPTION 'copilot_action_disabled' USING ERRCODE='42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app_private.tenant_emergency_denies d
    WHERE d.organization_id=p_organization_id
      AND (d.permission_key IS NULL OR d.permission_key='sale_phong.manage_pass_listings')
      AND d.active_from<=v_now
      AND (d.expires_at IS NULL OR d.expires_at>v_now)
  ) THEN
    RAISE EXCEPTION 'tenant_emergency_denied' USING ERRCODE='42501';
  END IF;
  v_snapshot := v_snapshot || jsonb_build_object('temporal_checked_at',v_now);
  -- Opaque revision includes xmin AND ctid: even same-transaction ABA changes
  -- tuple identity when the canonical setter's now() timestamp stays identical.
  -- Physical rewrites may conservatively expire pending consent; re-preview it.
  SELECT encode(extensions.digest(convert_to(
    l.updated_at::text || ':' || l.xmin::text || ':' || l.ctid::text,'UTF8'),'sha256'),'hex')
    INTO v_revision FROM public.room_pass_listings l WHERE l.id=v_id;
  RETURN jsonb_build_object(
    'canonical',jsonb_build_object('organization_id',p_organization_id,
      'listing_id',v_id,'building_id',v_building_id,'room_id',v_room_id,
      'active',(p_payload->>'active')::boolean,'before_active',v_listing.active,
      'before_revision',v_revision,'building_label',v_building.name,'room_label',v_room.name),
    'preview',jsonb_build_object('toa_nha',v_building.name,'phong',v_room.name,
      'trang_thai_cu',v_listing.active,'trang_thai_moi',(p_payload->>'active')::boolean),
    'permission_snapshot',v_snapshot);
END
$observe$;
REVOKE ALL ON FUNCTION app_private.copilot_room_pass_observe_v1(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.copilot_preview_room_pass_active_v1(
  p_organization_id uuid,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $preview$
DECLARE v_observed jsonb; v_nonce bytea := extensions.gen_random_bytes(32);
BEGIN
  v_observed := app_private.copilot_room_pass_observe_v1(p_organization_id,p_payload);
  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest,user_id,organization_id,tool,payload_hash,permission_key,expires_at)
  VALUES(extensions.digest(v_nonce,'sha256'),auth.uid(),p_organization_id,
    'room_pass.set_active',app_private.copilot_payload_hash_v1(v_observed->'canonical'),
    'sale_phong.manage_pass_listings',clock_timestamp()+interval '5 minutes');
  RETURN jsonb_build_object('confirmation_nonce',encode(v_nonce,'hex'),
    'canonical',v_observed->'canonical','preview',v_observed->'preview');
END
$preview$;

CREATE OR REPLACE FUNCTION public.copilot_execute_room_pass_active_v1(
  p_confirmation_nonce text,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $execute$
DECLARE
  v_confirmation app_private.copilot_write_confirmations%ROWTYPE;
  v_observed jsonb; v_after jsonb; v_hash bytea;
  v_id uuid; v_org uuid; v_active boolean;
  v_audit uuid; v_ledger uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE='28000'; END IF;
  IF p_confirmation_nonce IS NULL OR p_confirmation_nonce !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'confirmation_required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_confirmation FROM app_private.copilot_write_confirmations
    WHERE nonce_digest=extensions.digest(decode(p_confirmation_nonce,'hex'),'sha256') FOR UPDATE;
  IF NOT FOUND OR v_confirmation.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE='42501';
  END IF;
  IF v_confirmation.tool IS DISTINCT FROM 'room_pass.set_active'
     OR v_confirmation.permission_key IS DISTINCT FROM 'sale_phong.manage_pass_listings' THEN
    RAISE EXCEPTION 'confirmation_contract_mismatch' USING ERRCODE='42501';
  END IF;
  IF v_confirmation.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE='42501'; END IF;
  IF v_confirmation.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'confirmation_expired' USING ERRCODE='42501'; END IF;
  v_hash := app_private.copilot_payload_hash_v1(p_payload);
  IF v_hash IS DISTINCT FROM v_confirmation.payload_hash THEN RAISE EXCEPTION 'payload_changed' USING ERRCODE='42501'; END IF;
  v_org := (p_payload->>'organization_id')::uuid;
  IF v_org IS DISTINCT FROM v_confirmation.organization_id THEN RAISE EXCEPTION 'organization_mismatch' USING ERRCODE='42501'; END IF;
  v_observed := app_private.copilot_room_pass_observe_v1(v_org,p_payload);
  IF v_observed->'canonical' IS DISTINCT FROM p_payload THEN RAISE EXCEPTION 'payload_changed' USING ERRCODE='42501'; END IF;
  -- Expiry is checked again after lock waits; a blocked request gets no grace.
  UPDATE app_private.copilot_write_confirmations SET consumed_at=clock_timestamp()
    WHERE id=v_confirmation.id AND consumed_at IS NULL AND expires_at>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'confirmation_expired' USING ERRCODE='42501'; END IF;
  v_id := (p_payload->>'listing_id')::uuid;
  v_active := (p_payload->>'active')::boolean;
  PERFORM public.set_room_pass_listing_active(v_id,v_active);
  SELECT jsonb_build_object('listing_id',l.id,'organization_id',l.organization_id,
    'building_id',l.building_id,'room_id',l.room_id,'active',l.active) INTO v_after
    FROM public.room_pass_listings l WHERE l.id=v_id;
  IF v_after IS NULL OR v_after->>'organization_id' IS DISTINCT FROM v_org::text
     OR v_after->>'building_id' IS DISTINCT FROM p_payload->>'building_id'
     OR v_after->>'room_id' IS DISTINCT FROM p_payload->>'room_id'
     OR v_after->'active' IS DISTINCT FROM p_payload->'active' THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE='P0001';
  END IF;
  INSERT INTO public.ai_write_audit(user_id,organization_id,tool,idempotency_key,entity_table,entity_id,payload)
  VALUES(auth.uid(),v_org,'room_pass.set_active',
    'copilot_action:room_pass.set_active:'||v_confirmation.id::text,
    'room_pass_listings',v_id,p_payload) RETURNING id INTO v_audit;
  v_ledger := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event','action_executed','organization_id',v_org,'action_id','room_pass.set_active',
    'permission_key','sale_phong.manage_pass_listings','permission_snapshot',v_observed->'permission_snapshot',
    'consent_kind','click','consent_id',v_confirmation.id,'payload_digest',encode(v_hash,'hex'),
    'before_digest',encode(app_private.copilot_payload_hash_v1(v_observed->'canonical'),'hex'),
    'after_digest',encode(app_private.copilot_payload_hash_v1(v_after),'hex'),
    'entity_table','room_pass_listings','entity_id',v_id,'audit_id',v_audit,
    'outcome',jsonb_build_object('active',v_active)));
  RETURN jsonb_build_object('status','da_thuc_hien','entity_table','room_pass_listings',
    'entity_id',v_id,'audit_id',v_audit,'ledger_id',v_ledger,'active',v_active);
END
$execute$;
REVOKE ALL ON FUNCTION public.copilot_preview_room_pass_active_v1(uuid,jsonb) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.copilot_execute_room_pass_active_v1(text,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.copilot_preview_room_pass_active_v1(uuid,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.copilot_execute_room_pass_active_v1(text,jsonb) TO authenticated;

INSERT INTO app_private.copilot_action_registry(
  action_id,version,label_vi,permission_key,risk,executor_kind,consent_required,
  preview_rpc,execute_rpc,verify_kind,produces_entity_table,consumes_ref_table,
  rollback_rpc,rollback_note,flag_contract_id,enabled
) VALUES('room_pass.set_active',1,'Đổi trạng thái công khai tin phòng nhờ sale',
  'sale_phong.manage_pass_listings','L3','nonce_abi_v1','click',
  'copilot_preview_room_pass_active_v1','copilot_execute_room_pass_active_v1',
  'readback','room_pass_listings',NULL,'copilot_preview_room_pass_active_v1',
  'Lap de xuat moi voi active cu, xac nhan va thuc thi qua Nonce ABI.',
  'room_pass.set_active',true) ON CONFLICT(action_id) DO NOTHING;
SELECT set_config('app.copilot_feature_flag_transition','v2',true);
INSERT INTO public.copilot_feature_flags(scope,contract_id,state,reason,evidence_link,rollback_reference)
VALUES('action','room_pass.set_active','disabled','G2-D: cho nghiem thu DEMO',
  'migration:20260908033918_copilot_action_room_pass_active_v1',
  'migration:20260908033918_copilot_action_room_pass_active_v1')
ON CONFLICT(scope,contract_id) DO NOTHING;
SELECT set_config('app.copilot_feature_flag_transition','',true);
COMMIT;
