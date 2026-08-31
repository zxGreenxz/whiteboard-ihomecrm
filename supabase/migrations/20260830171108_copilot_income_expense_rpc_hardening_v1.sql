-- Copilot income/expense hardening.
--
-- This migration deliberately lands before the shared writer replacement.  The
-- private capability starts disabled, so an execute call fails closed until the
-- following writer migration has installed and enabled the draft contract.

BEGIN;
SET LOCAL lock_timeout = '15s';

-- A transaction-local capability without GUCs.  The marker is random and is
-- stored only as a digest; transaction_id prevents a marker from being reused
-- in another transaction.
CREATE TABLE IF NOT EXISTS app_private.copilot_ie_writer_context_v1 (
  transaction_id  text PRIMARY KEY,
  actor_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  context_name    text NOT NULL,
  marker_digest   bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS copilot_ie_writer_context_created_idx
  ON app_private.copilot_ie_writer_context_v1 (created_at);

REVOKE ALL ON app_private.copilot_ie_writer_context_v1
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS app_private.copilot_ie_writer_capabilities_v1 (
  capability_key text PRIMARY KEY,
  enabled        boolean NOT NULL DEFAULT false,
  writer_version text NOT NULL DEFAULT 'disabled',
  enabled_at     timestamptz
);

INSERT INTO app_private.copilot_ie_writer_capabilities_v1
  (capability_key, enabled, writer_version)
VALUES
  ('income_expense_draft_v1', false, 'disabled')
ON CONFLICT (capability_key) DO NOTHING;

REVOKE ALL ON app_private.copilot_ie_writer_capabilities_v1
  FROM PUBLIC, anon, authenticated, service_role;

-- The writer migration enables the singleton only after its replacement has
-- been installed.  Both the execute RPC and the writer call this function.
CREATE OR REPLACE FUNCTION app_private.copilot_ie_writer_ready_v1(
  p_actor  uuid,
  p_org    uuid,
  p_marker text
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public, extensions
AS $f$
  SELECT p_marker IS NOT NULL
     AND btrim(p_marker) <> ''
     AND p_actor IS NOT DISTINCT FROM auth.uid()
     AND EXISTS (
       SELECT 1
         FROM app_private.copilot_ie_writer_capabilities_v1 c
        WHERE c.capability_key = 'income_expense_draft_v1'
          AND c.enabled
     )
     AND EXISTS (
       SELECT 1
         FROM app_private.copilot_ie_writer_context_v1 c
        WHERE c.transaction_id = pg_current_xact_id()::text
          AND c.actor_id = p_actor
          AND c.organization_id = p_org
          AND c.context_name = 'copilot_execute_income_expense_v1'
          AND c.marker_digest = extensions.digest(
                convert_to(p_marker, 'UTF8'), 'sha256')
          AND c.created_at > clock_timestamp() - interval '10 minutes'
     );
$f$;

REVOKE ALL ON FUNCTION app_private.copilot_ie_writer_ready_v1(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Keep the payload hash implementation stable for both preview and execute.
CREATE OR REPLACE FUNCTION app_private.copilot_payload_hash_v1(p_payload jsonb)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $f$
  SELECT extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256');
$f$;

CREATE OR REPLACE FUNCTION public.copilot_preview_income_expense_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $f$
DECLARE
  v_actor      uuid := auth.uid();
  v_loai       text := upper(coalesce(p_payload ->> 'loai', ''));
  v_ie_type    text;
  v_so_tien   numeric;
  v_ten        text := trim(coalesce(p_payload ->> 'ten_phieu', ''));
  v_toa        text := trim(coalesce(p_payload ->> 'toa_nha', ''));
  v_hang_muc   text := trim(coalesce(p_payload ->> 'hang_muc', ''));
  v_ngay       date;
  v_building   record;
  v_type       record;
  v_scope      record;
  v_dem        integer;
  v_nonce      bytea;
  v_canonical  jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  SELECT s.org_wide, s.building_ids
    INTO v_scope
    FROM app_private.authorized_scope_v3(
      'income_expenses.create', p_organization_id) s;
  IF NOT FOUND
     OR (NOT coalesce(v_scope.org_wide, false)
         AND coalesce(cardinality(v_scope.building_ids), 0) = 0) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  IF v_loai NOT IN ('THU', 'CHI') THEN
    RAISE EXCEPTION 'loai_khong_hop_le' USING ERRCODE = '22023';
  END IF;
  v_ie_type := CASE WHEN v_loai = 'THU' THEN 'INCOME' ELSE 'EXPENSE' END;

  BEGIN
    v_so_tien := (p_payload ->> 'so_tien')::numeric;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'so_tien_khong_hop_le' USING ERRCODE = '22023';
  END;
  IF v_so_tien IS NULL OR v_so_tien <= 0 THEN
    RAISE EXCEPTION 'so_tien_khong_hop_le' USING ERRCODE = '22023';
  END IF;
  IF length(v_ten) < 3 THEN
    RAISE EXCEPTION 'ten_phieu_qua_ngan' USING ERRCODE = '22023';
  END IF;

  v_ngay := coalesce(
    (p_payload ->> 'ngay')::date,
    (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
  );

  SELECT count(*)
    INTO v_dem
    FROM public.buildings b
   WHERE b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND (coalesce(v_scope.org_wide, false)
          OR b.id = ANY(coalesce(v_scope.building_ids, '{}'::uuid[])))
     AND b.name ILIKE '%' || v_toa || '%';
  IF v_dem = 0 THEN
    RAISE EXCEPTION 'toa_nha_khong_thay' USING ERRCODE = '22023';
  ELSIF v_dem > 1 THEN
    RAISE EXCEPTION 'toa_nha_mo_ho' USING ERRCODE = '22023';
  END IF;

  SELECT b.id, b.name, b.organization_id
    INTO v_building
    FROM public.buildings b
   WHERE b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND (coalesce(v_scope.org_wide, false)
          OR b.id = ANY(coalesce(v_scope.building_ids, '{}'::uuid[])))
     AND b.name ILIKE '%' || v_toa || '%';

  SELECT count(*)
    INTO v_dem
    FROM public.income_expense_types t
   WHERE t.organization_id = p_organization_id
     AND lower(t.type) = lower(v_ie_type)
     AND t.name ILIKE '%' || v_hang_muc || '%'
     AND NOT coalesce(t.system_only, false)
     AND (
       NOT coalesce(t.is_restricted, false)
       OR public.can_create_restricted_ie()
     );
  IF v_dem = 0 THEN
    RAISE EXCEPTION 'hang_muc_khong_thay' USING ERRCODE = '22023';
  ELSIF v_dem > 1 THEN
    RAISE EXCEPTION 'hang_muc_mo_ho' USING ERRCODE = '22023';
  END IF;

  SELECT t.id, t.name
    INTO v_type
    FROM public.income_expense_types t
   WHERE t.organization_id = p_organization_id
     AND lower(t.type) = lower(v_ie_type)
     AND t.name ILIKE '%' || v_hang_muc || '%'
     AND NOT coalesce(t.system_only, false)
     AND (
       NOT coalesce(t.is_restricted, false)
       OR public.can_create_restricted_ie()
     );

  v_canonical := jsonb_build_object(
    'organization_id', p_organization_id,
    'type',            v_ie_type,
    'name',            v_ten,
    'amount',          v_so_tien,
    'building_id',     v_building.id,
    'type_id',         v_type.id,
    'voucher_date',    v_ngay
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'tao_phieu_thu_chi_nhap', app_private.copilot_payload_hash_v1(v_canonical),
     'income_expenses.create', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'loai',       v_loai,
      'so_tien',    v_so_tien,
      'ten_phieu',  v_ten,
      'toa_nha',    v_building.name,
      'hang_muc',   v_type.name,
      'ngay',       v_ngay,
      'trang_thai', 'CHO DUYET'
    )
  );
END
$f$;

COMMENT ON FUNCTION public.copilot_preview_income_expense_v1(uuid, jsonb) IS
  'Preview resolves organization, building and income/expense type server-side and issues a one-time nonce.';

REVOKE EXECUTE ON FUNCTION public.copilot_preview_income_expense_v1(uuid, jsonb)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_preview_income_expense_v1(uuid, jsonb)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.copilot_execute_income_expense_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $f$
DECLARE
  v_actor          uuid := auth.uid();
  v_hash           bytea;
  v_row            app_private.copilot_write_confirmations%ROWTYPE;
  v_scope          record;
  v_org            uuid;
  v_target_building uuid;
  v_target_row     public.buildings%ROWTYPE;
  v_type_row       public.income_expense_types%ROWTYPE;
  v_voucher        jsonb;
  v_vid            uuid;
  v_key            text;
  v_audit_id       uuid;
  v_prev           public.ai_write_audit%ROWTYPE;
  v_ten_nguoi      text;
  v_marker         text;
  v_ready          boolean;
  v_existing_ie    public.income_expenses%ROWTYPE;
  v_item           public.income_expense_items%ROWTYPE;
  v_item_count     bigint;
  v_expected_type  text;
  v_expected_type_id uuid;
  v_expected_amount numeric;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  -- Never call decode until the nonce has been proven to be exactly 32 bytes
  -- represented as lowercase or uppercase hexadecimal.
  IF p_confirmation_nonce IS NULL
     OR p_confirmation_nonce !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'confirmation_required' USING ERRCODE = '42501';
  END IF;

  v_hash := app_private.copilot_payload_hash_v1(p_payload);

  SELECT *
    INTO v_row
    FROM app_private.copilot_write_confirmations c
   WHERE c.nonce_digest = extensions.digest(
           decode(p_confirmation_nonce, 'hex'), 'sha256')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_row.tool IS DISTINCT FROM 'tao_phieu_thu_chi_nhap'
     OR v_row.permission_key IS DISTINCT FROM 'income_expenses.create' THEN
    RAISE EXCEPTION 'confirmation_contract_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_row.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_row.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;
  IF v_row.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'confirmation_expired' USING ERRCODE = '42501';
  END IF;
  IF v_row.payload_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_org := (p_payload ->> 'organization_id')::uuid;
    v_target_building := (p_payload ->> 'building_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_target_building IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  -- Re-resolve the category after preview.  This closes the revoke and
  -- restricted-category gap between issuing a nonce and consuming it.
  BEGIN
    v_expected_type_id := (p_payload ->> 'type_id')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  SELECT *
    INTO v_type_row
    FROM public.income_expense_types t
   WHERE t.id = v_expected_type_id
     AND t.organization_id = v_org
   FOR SHARE;
  IF NOT FOUND
     OR lower(v_type_row.type) IS DISTINCT FROM
        lower(coalesce(p_payload ->> 'type', ''))
     OR coalesce(v_type_row.system_only, false)
     OR (
       coalesce(v_type_row.is_restricted, false)
       AND NOT public.can_create_restricted_ie()
     ) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- Re-check the selected resource and current permission after preview.
  SELECT b.*
    INTO v_target_row
    FROM public.buildings b
   WHERE b.id = v_target_building
     AND b.deleted_at IS NULL
   FOR UPDATE;
  SELECT s.org_wide, s.building_ids
    INTO v_scope
    FROM app_private.authorized_scope_v3(
      'income_expenses.create', v_org) s;
  IF NOT FOUND
     OR v_target_row.id IS NULL
     OR v_target_row.organization_id IS DISTINCT FROM v_org
     OR (NOT coalesce(v_scope.org_wide, false)
         AND NOT (v_target_row.id = ANY(
           coalesce(v_scope.building_ids, '{}'::uuid[])))) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- Bind idempotency to every security-relevant dimension, not only payload.
  v_key := 'copilot_ie_v2:' || v_actor::text || ':' || v_org::text || ':'
        || v_row.tool || ':' || v_row.permission_key || ':'
        || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  -- Install the private transaction capability before touching the shared
  -- writer.  The following migration flips readiness; until then this call
  -- aborts without creating a voucher.
  v_marker := encode(extensions.gen_random_bytes(32), 'hex');
  INSERT INTO app_private.copilot_ie_writer_context_v1
    (transaction_id, actor_id, organization_id, context_name, marker_digest)
  VALUES
    (pg_current_xact_id()::text, v_actor, v_org,
     'copilot_execute_income_expense_v1',
     extensions.digest(convert_to(v_marker, 'UTF8'), 'sha256'))
  ON CONFLICT (transaction_id) DO UPDATE
    SET actor_id = EXCLUDED.actor_id,
        organization_id = EXCLUDED.organization_id,
        context_name = EXCLUDED.context_name,
        marker_digest = EXCLUDED.marker_digest,
        created_at = clock_timestamp();

  v_ready := app_private.copilot_ie_writer_ready_v1(v_actor, v_org, v_marker);
  IF NOT v_ready THEN
    RAISE EXCEPTION 'writer_not_ready' USING ERRCODE = '55000';
  END IF;

  -- Consume the nonce with a CAS.  Any later failure rolls the whole
  -- transaction back, including this consumption and the context row.
  UPDATE app_private.copilot_write_confirmations
     SET consumed_at = clock_timestamp()
   WHERE id = v_row.id
     AND consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;

  -- A replay is allowed only when every audit/entity/item field still proves
  -- the exact same operation.  An entity_id-only lookup is not sufficient.
  SELECT *
    INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    IF v_prev.user_id IS DISTINCT FROM v_actor
       OR v_prev.organization_id IS DISTINCT FROM v_org
       OR v_prev.tool IS DISTINCT FROM v_row.tool
       OR v_prev.entity_table IS DISTINCT FROM 'income_expenses'
       OR v_prev.entity_id IS NULL
       OR app_private.copilot_payload_hash_v1(v_prev.payload)
            IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'copilot_audit_mismatch' USING ERRCODE = 'P0001';
    END IF;

    SELECT *
      INTO v_existing_ie
      FROM public.income_expenses ie
     WHERE ie.id = v_prev.entity_id;
    IF NOT FOUND
       OR v_existing_ie.organization_id IS DISTINCT FROM v_org
       OR v_existing_ie.user_id IS DISTINCT FROM v_actor
       OR v_existing_ie.building_id IS DISTINCT FROM v_target_building
       OR v_existing_ie.type IS DISTINCT FROM (p_payload ->> 'type')
       OR v_existing_ie.name IS DISTINCT FROM (p_payload ->> 'name')
       OR v_existing_ie.voucher_date IS DISTINCT FROM
          (p_payload ->> 'voucher_date')::date
       OR v_existing_ie.approval_status IS DISTINCT FROM 'UNAPPROVED'
       OR v_existing_ie.posting_status IS DISTINCT FROM 'UNPOSTED'
       OR v_existing_ie.account_id IS NOT NULL
       OR v_existing_ie.active_posting_id_v2 IS NOT NULL
       OR v_existing_ie.posting_id IS NOT NULL
       OR v_existing_ie.approved_by IS NOT NULL
       OR v_existing_ie.approved_at IS NOT NULL
       OR v_existing_ie.repeat_cycle IS DISTINCT FROM 'NONE'
       OR v_existing_ie.repeat_next_date IS NOT NULL
       OR v_existing_ie.repeat_parent_id IS NOT NULL THEN
      RAISE EXCEPTION 'copilot_audit_mismatch' USING ERRCODE = 'P0001';
    END IF;

    BEGIN
      v_expected_type_id := (p_payload ->> 'type_id')::uuid;
      v_expected_amount := (p_payload ->> 'amount')::numeric;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'copilot_audit_mismatch' USING ERRCODE = 'P0001';
    END;
    SELECT count(*)
      INTO v_item_count
      FROM public.income_expense_items i
     WHERE i.income_expense_id = v_prev.entity_id;
    SELECT *
      INTO v_item
      FROM public.income_expense_items i
     WHERE i.income_expense_id = v_prev.entity_id
     LIMIT 1;
    IF v_item_count <> 1
       OR v_item.organization_id IS DISTINCT FROM v_org
       OR v_item.income_expense_type_id IS DISTINCT FROM v_expected_type_id
       OR v_item.quantity <> 1
       OR coalesce(v_item.amount, v_item.quantity * v_item.unit_price)
            IS DISTINCT FROM v_expected_amount THEN
      RAISE EXCEPTION 'copilot_audit_mismatch' USING ERRCODE = 'P0001';
    END IF;

    DELETE FROM app_private.copilot_ie_writer_context_v1
     WHERE transaction_id = pg_current_xact_id()::text
       AND marker_digest = extensions.digest(convert_to(v_marker, 'UTF8'), 'sha256');
    RETURN jsonb_build_object(
      'status', 'da_tao_truoc_do',
      'entity_id', v_prev.entity_id,
      'created_at', v_prev.created_at
    );
  END IF;

  SELECT coalesce(
    u.raw_user_meta_data ->> 'full_name',
    u.raw_user_meta_data ->> 'name',
    u.email,
    'Nguoi dung'
  )
    INTO v_ten_nguoi
    FROM auth.users u
   WHERE u.id = v_actor;

  v_voucher := public.ie_compat_insert_v2(
    p_row := jsonb_build_object(
      'user_id',              auth.uid(),
      'organization_id',      v_org,
      'creator_name',         v_ten_nguoi || ' (AI Copilot)',
      'type',                 p_payload ->> 'type',
      'name',                 p_payload ->> 'name',
      'building_id',          p_payload ->> 'building_id',
      'account_id',           NULL,
      'voucher_date',         p_payload ->> 'voucher_date',
      'attachments',          '[]'::jsonb,
      'notes',                'Tao boi AI Copilot (draft-first, nonce)',
      'repeat_cycle',         'NONE',
      'repeat_infinity',      false,
      'repeat_count',         0,
      'repeat_auto_approve',  false,
      'repeat_next_date',     NULL,
      'repeat_parent_id',     NULL,
      'repeat_remaining',     0,
      'copilot_draft_marker', v_marker
    ),
    p_items := jsonb_build_array(jsonb_build_object(
      'income_expense_type_id', p_payload ->> 'type_id',
      'organization_id',        v_org,
      'description',            p_payload ->> 'name',
      'quantity',               1,
      'unit_price',             (p_payload ->> 'amount')::numeric
    ))
  );

  v_vid := (v_voucher ->> 'id')::uuid;
  IF v_vid IS NULL THEN
    RAISE EXCEPTION 'voucher_not_created' USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_existing_ie
    FROM public.income_expenses ie
   WHERE ie.id = v_vid;
  IF NOT FOUND
     OR v_existing_ie.organization_id IS DISTINCT FROM v_org
     OR v_existing_ie.user_id IS DISTINCT FROM v_actor
     OR v_existing_ie.building_id IS DISTINCT FROM v_target_building
     OR v_existing_ie.type IS DISTINCT FROM (p_payload ->> 'type')
     OR v_existing_ie.name IS DISTINCT FROM (p_payload ->> 'name')
     OR v_existing_ie.voucher_date IS DISTINCT FROM
        (p_payload ->> 'voucher_date')::date
     OR v_existing_ie.approval_status IS DISTINCT FROM 'UNAPPROVED'
     OR v_existing_ie.posting_status IS DISTINCT FROM 'UNPOSTED'
     OR v_existing_ie.account_id IS NOT NULL
     OR v_existing_ie.active_posting_id_v2 IS NOT NULL
     OR v_existing_ie.posting_id IS NOT NULL
     OR v_existing_ie.approved_by IS NOT NULL
     OR v_existing_ie.approved_at IS NOT NULL
     OR v_existing_ie.repeat_cycle IS DISTINCT FROM 'NONE'
     OR v_existing_ie.repeat_next_date IS NOT NULL
     OR v_existing_ie.repeat_parent_id IS NOT NULL THEN
    RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
  END IF;

  v_expected_type_id := (p_payload ->> 'type_id')::uuid;
  v_expected_amount := (p_payload ->> 'amount')::numeric;
  SELECT count(*)
    INTO v_item_count
    FROM public.income_expense_items i
   WHERE i.income_expense_id = v_vid;
  SELECT *
    INTO v_item
    FROM public.income_expense_items i
   WHERE i.income_expense_id = v_vid
   LIMIT 1;
  IF v_item_count <> 1
     OR v_item.organization_id IS DISTINCT FROM v_org
     OR v_item.income_expense_type_id IS DISTINCT FROM v_expected_type_id
     OR v_item.quantity <> 1
     OR coalesce(v_item.amount, v_item.quantity * v_item.unit_price)
          IS DISTINCT FROM v_expected_amount THEN
    RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, v_row.tool, v_key, 'income_expenses', v_vid, p_payload, v_org)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_audit_id;

  IF v_audit_id IS NULL THEN
    SELECT *
      INTO v_prev
      FROM public.ai_write_audit a
     WHERE a.idempotency_key = v_key;
    IF NOT FOUND OR v_prev.entity_id IS NULL
       OR v_prev.user_id IS DISTINCT FROM v_actor
       OR v_prev.organization_id IS DISTINCT FROM v_org
       OR v_prev.tool IS DISTINCT FROM v_row.tool
       OR v_prev.entity_table IS DISTINCT FROM 'income_expenses'
       OR app_private.copilot_payload_hash_v1(v_prev.payload)
            IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'copilot_audit_orphan' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'copilot_idempotency_race' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM app_private.copilot_ie_writer_context_v1
   WHERE transaction_id = pg_current_xact_id()::text
     AND marker_digest = extensions.digest(convert_to(v_marker, 'UTF8'), 'sha256');

  RETURN jsonb_build_object(
    'status',    'da_tao',
    'entity_id', v_vid,
    'audit_id',  v_audit_id
  );
END
$f$;

COMMENT ON FUNCTION public.copilot_execute_income_expense_v1(text, jsonb) IS
  'Consumes a server nonce, rechecks organization/building permission, writes one draft voucher and immutable audit atomically.';

REVOKE EXECUTE ON FUNCTION public.copilot_execute_income_expense_v1(text, jsonb)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_execute_income_expense_v1(text, jsonb)
  TO authenticated;

COMMIT;
