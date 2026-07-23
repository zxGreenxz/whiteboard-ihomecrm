-- Finance V2 — Stage 11c: evidence upload intent + finalize (plan §6.3, F1 verification).
--
-- Nhánh "Duyệt và Chi" cần ≥1 chứng từ FINALIZED (manual §2.2). Flow §6.3:
--   1) create_finance_evidence_upload_intent_v2: server cấp path ngẫu nhiên
--      (org/membership/uuid) trong bucket private 'income-expense-attachments',
--      ghi registry row state=UPLOAD_INTENT.
--   2) Client upload đúng path (policy ie_attachments_insert hiện hữu cho phép).
--   3) finalize_finance_evidence_v2: verify object tồn tại + đúng uploader, chụp
--      size/mime từ storage.objects.metadata, ghi app_private.storage_object_links
--      (để RESTRICTIVE shield cho member org XEM lại ảnh), state=FINALIZED.
-- Không nhận raw URL từ client; posting RPC chỉ nhận evidence_id đã FINALIZED.

BEGIN;

CREATE OR REPLACE FUNCTION public.create_finance_evidence_upload_intent_v2(
  p_organization_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_org uuid := p_organization_id;
  v_actor record;
  v_id uuid;
  v_object text;
BEGIN
  IF v_org IS NULL THEN
    SELECT m.organization_id INTO v_org FROM public.organization_memberships m
    WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE' LIMIT 1;
  END IF;
  SELECT * INTO v_actor FROM app_private.ie_compat_actor_v2(v_org);
  IF v_actor.membership_id IS NULL THEN
    RAISE EXCEPTION 'Không có membership active trong organization' USING ERRCODE = '42501';
  END IF;

  v_object := 'v2/' || v_org::text || '/' || v_actor.membership_id::text || '/' || gen_random_uuid()::text;
  INSERT INTO public.finance_evidence_objects
    (organization_id, bucket_id, object_name, uploader_membership_id, uploader_user_id,
     provenance_kind, state)
  VALUES (v_org, 'income-expense-attachments', v_object, v_actor.membership_id, v_actor.user_id,
          'UPLOAD', 'UPLOAD_INTENT')
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('evidence_id', v_id,
                            'bucket_id', 'income-expense-attachments',
                            'object_name', v_object);
END
$fn$;

CREATE OR REPLACE FUNCTION public.finalize_finance_evidence_v2(p_evidence_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_row public.finance_evidence_objects%ROWTYPE;
  v_meta jsonb;
BEGIN
  SELECT * INTO v_row FROM public.finance_evidence_objects
  WHERE id = p_evidence_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Evidence không tồn tại' USING ERRCODE = 'P0002'; END IF;
  IF v_row.uploader_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Chỉ người tạo intent được finalize chứng từ này' USING ERRCODE = '42501';
  END IF;
  IF v_row.state = 'FINALIZED' THEN
    RETURN jsonb_build_object('evidence_id', v_row.id, 'state', 'FINALIZED'); -- idempotent
  END IF;
  IF v_row.state <> 'UPLOAD_INTENT' THEN
    RAISE EXCEPTION 'Evidence ở trạng thái % — không finalize được', v_row.state USING ERRCODE = '55000';
  END IF;

  SELECT o.metadata INTO v_meta
  FROM storage.objects o
  WHERE o.bucket_id = v_row.bucket_id AND o.name = v_row.object_name
    AND o.owner = auth.uid();
  IF v_meta IS NULL THEN
    RAISE EXCEPTION 'Chưa thấy file upload đúng path/owner — hãy upload trước khi finalize'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.finance_evidence_objects
     SET state = 'FINALIZED', finalized_at = now(),
         byte_size = NULLIF(v_meta->>'size','')::bigint,
         mime_type = v_meta->>'mimetype'
   WHERE id = p_evidence_id;

  -- Shield đọc storage (PS03): member org xem lại được ảnh chứng từ.
  INSERT INTO app_private.storage_object_links (bucket_id, object_name, organization_id, owner_user_id, derivation)
  VALUES (v_row.bucket_id, v_row.object_name, v_row.organization_id, auth.uid(), 'FINANCE_V2_EVIDENCE')
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('evidence_id', v_row.id, 'state', 'FINALIZED');
END
$fn$;

DO $acl$
DECLARE v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.create_finance_evidence_upload_intent_v2(uuid)',
    'public.finalize_finance_evidence_v2(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    IF to_regrole('anon') IS NOT NULL THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn); END IF;
    IF to_regrole('service_role') IS NOT NULL THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM service_role', v_fn); END IF;
    IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_fn); END IF;
  END LOOP;
END
$acl$;

COMMIT;

NOTIFY pgrst, 'reload schema';
