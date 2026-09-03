-- G5-C2 (3/7, nhom A - phan quyen) - Action L5 `member.invite` theo khuon
-- direct_l5_v1 (xem 20260903190255 cho khuon day du, 20260903212600 cho cot
-- pin_always).
--
-- BOC RPC GOC: `invite_organization_member_v1(p_email text, p_member_type
-- text, p_role_id uuid, p_scope_ids uuid[], p_expires_days integer)`
-- (SECURITY DEFINER, doc production 03/09/2026 - quyen
-- `require_perm_v1(org,'users.create',...)`). Wrapper goi NGUYEN VEN.
--
-- LECH BRIEF CO CHU DICH #1 - rollback_rpc. Brief de `set_membership_status_v1`
-- (thu hoi) nhung LOI MOI khong tao membership - no chi tao mot hang
-- `organization_invitations` cho toi khi nguoi duoc moi bam chap nhan
-- (`accept_organization_invitation_v1`). Doi tuong can thu hoi la LOI MOI, va
-- production CO SAN dung ham cho viec do: `revoke_organization_invitation_v1
-- (p_invitation uuid)`. Dung ten that thay vi brief.
--
-- LECH BRIEF CO CHU DICH #2 - token KHONG BAO GIO ra khoi giao dich. RPC goc
-- tra ve mot `token` THO mot-lan (bearer credential cho duong chap nhan loi
-- moi) va tu no ghi ro "chua co cho gui email — hay gui duong dan nay tay".
-- Wrapper nay CO CHU DICH khong dua token vao bat ky truong nao co the bi ghi
-- so/audit (ai_write_audit.payload la INPUT nen an toan; nhung outcome tra ve
-- va outcome ghi vao copilot_action_ledger deu REDACT token). He qua: loi moi
-- ma AI Copilot tao qua duong ke hoach hien khong the gui duoc tay - nguoi
-- dung phai vao man hinh Thanh vien binh thuong de lay lai token, hoac mot
-- task sau phai them kenh gui token an toan (khong qua ledger). Day la gioi
-- han SAN PHAM, khong phai loi bao mat - ghi ro trong registry.rollback_note.
--
-- MUC 0 - dam bao pin_always da co (idempotent).
BEGIN;
SET LOCAL lock_timeout = '15s';

DO $them_cot_pin_always$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app_private' AND table_name = 'copilot_action_registry'
       AND column_name = 'pin_always'
  ) THEN
    ALTER TABLE app_private.copilot_action_registry
      ADD COLUMN pin_always boolean NOT NULL DEFAULT false;
  END IF;
END
$them_cot_pin_always$;

-- ---------------------------------------------------------------------------
-- MUC 1 - XEM TRUOC member.invite
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_member_moi_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_member_moi$
DECLARE
  v_actor       uuid := auth.uid();
  v_snapshot    jsonb;
  v_email       text;
  v_member_type text;
  v_role_id     uuid;
  v_scope_ids   uuid[];
  v_days        int;
  v_canonical   jsonb;
  v_nonce       bytea;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('member.invite', p_organization_id);

  v_email := lower(btrim(COALESCE(p_payload ->> 'email', '')));
  v_member_type := upper(btrim(COALESCE(p_payload ->> 'member_type', 'STAFF')));
  v_days := COALESCE(NULLIF(p_payload ->> 'expires_days', '')::int, 7);
  BEGIN
    v_role_id := NULLIF(p_payload ->> 'role_id', '')::uuid;
    IF p_payload ? 'scope_ids' AND jsonb_typeof(p_payload -> 'scope_ids') = 'array' THEN
      SELECT array_agg(x::uuid) INTO v_scope_ids
        FROM jsonb_array_elements_text(p_payload -> 'scope_ids') x;
    END IF;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;

  IF v_email = '' OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_member_type NOT IN ('OWNER','STAFF','SHAREHOLDER','PARTNER','SERVICE') THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.organization_memberships m
      JOIN auth.users u ON u.id = m.user_id
     WHERE m.organization_id = p_organization_id AND m.status = 'ACTIVE'
       AND lower(u.email) = v_email
  ) THEN
    RAISE EXCEPTION 'entity_conflict' USING ERRCODE = '23505';
  END IF;

  v_canonical := jsonb_build_object(
    'organization_id', p_organization_id,
    'email',           v_email,
    'member_type',     v_member_type,
    'role_id',         v_role_id,
    'scope_ids',       to_jsonb(COALESCE(v_scope_ids, ARRAY[]::uuid[])),
    'expires_days',    v_days
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'member.invite', app_private.copilot_payload_hash_v1(v_canonical),
     'users.create', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'so_dien_thoai',       v_email,
      'loai_phieu',          v_member_type,
      'trang_thai_hien_tai', 'Chua la thanh vien',
      'hau_qua',             format('Se gui loi moi (het han sau %s ngay) - token KHONG hien qua Copilot, phai lay tay tren man hinh Thanh vien', v_days),
      'canh_bao',            'Token loi moi la bi mat mot-lan, Copilot khong hien no'
    )
  );
END
$xem_truoc_member_moi$;

COMMENT ON FUNCTION public.copilot_preview_member_moi_v1(uuid, jsonb) IS
  'direct_l5_v1 - xem truoc moi thanh vien (boc invite_organization_member_v1). Nhom A - grantable=false + pin_always=true.';

REVOKE ALL ON FUNCTION public.copilot_preview_member_moi_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_member_moi$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_member_moi_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_member_moi_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_member_moi_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_member_moi_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_member_moi$;

-- ---------------------------------------------------------------------------
-- MUC 2 - THUC THI member.invite
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_member_moi_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_member_moi$
DECLARE
  v_actor       uuid := auth.uid();
  v_hash        bytea;
  v_row         app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot    jsonb;
  v_org         uuid;
  v_email       text;
  v_member_type text;
  v_role_id     uuid;
  v_scope_ids   uuid[];
  v_days        int;
  v_key         text;
  v_prev        public.ai_write_audit%ROWTYPE;
  v_result      jsonb;
  v_invitation  uuid;
  v_after       jsonb;
  v_audit_id    uuid;
  v_ledger_id   uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_confirmation_nonce IS NULL
     OR p_confirmation_nonce !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'confirmation_required' USING ERRCODE = '42501';
  END IF;

  v_hash := app_private.copilot_payload_hash_v1(p_payload);

  SELECT * INTO v_row
    FROM app_private.copilot_write_confirmations c
   WHERE c.nonce_digest = extensions.digest(
           decode(p_confirmation_nonce, 'hex'), 'sha256')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_row.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_row.tool IS DISTINCT FROM 'member.invite'
     OR v_row.permission_key IS DISTINCT FROM 'users.create' THEN
    RAISE EXCEPTION 'confirmation_contract_mismatch' USING ERRCODE = '42501';
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
    v_org         := (p_payload ->> 'organization_id')::uuid;
    v_email       := p_payload ->> 'email';
    v_member_type := p_payload ->> 'member_type';
    v_role_id     := NULLIF(p_payload ->> 'role_id', '')::uuid;
    v_days        := (p_payload ->> 'expires_days')::int;
    IF p_payload ? 'scope_ids' AND jsonb_typeof(p_payload -> 'scope_ids') = 'array' THEN
      SELECT array_agg(x::uuid) INTO v_scope_ids
        FROM jsonb_array_elements_text(p_payload -> 'scope_ids') x;
    END IF;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  IF NOT app_private.copilot_l5_plan_context_ok_v1('member.invite', v_org) THEN
    RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('member.invite', v_org);

  v_key := 'copilot_action:member.invite:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'organization_invitations',
      'entity_id',    v_prev.entity_id,
      'audit_id',     v_prev.id,
      'ledger_id',    NULL
    );
  END IF;

  UPDATE app_private.copilot_write_confirmations
     SET consumed_at = clock_timestamp()
   WHERE id = v_row.id
     AND consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;

  -- before_digest NULL - day la mot hanh dong TAO (khong co "truoc" tren loi
  -- moi chua ton tai), giong nhanh TAO cua role.upsert va reservation_deposit.create.
  v_result := public.invite_organization_member_v1(
    v_email, v_member_type, v_role_id, v_scope_ids, v_days);
  v_invitation := NULLIF(v_result ->> 'invitationId', '')::uuid;
  IF v_invitation IS NULL THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  -- READBACK - loi moi phai o trang thai PENDING, dung to chuc.
  SELECT to_jsonb(i) INTO v_after
    FROM public.organization_invitations i
   WHERE i.id = v_invitation;
  IF v_after IS NULL
     OR NULLIF(v_after ->> 'organization_id', '')::uuid IS DISTINCT FROM v_org
     OR v_after ->> 'status' IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'member.invite', v_key, 'organization_invitations',
     v_invitation, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  -- REDACT token khoi so hanh dong - xem chu thich dau file.
  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'member.invite',
    'permission_key',      'users.create',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       NULL,
    'after_digest',        encode(extensions.digest(
                             convert_to((v_after - 'token_hash')::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'organization_invitations',
    'entity_id',           v_invitation,
    'audit_id',            v_audit_id,
    'outcome',             jsonb_build_object('status', 'da_thuc_hien', 'invitation_id', v_invitation,
                                                'expires_at', v_result ->> 'expiresAt')
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'organization_invitations',
    'entity_id',    v_invitation,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_member_moi$;

COMMENT ON FUNCTION public.copilot_execute_member_moi_v1(text, jsonb) IS
  'direct_l5_v1 - tieu nonce, tu choi neu khong chay trong ke hoach (l5_requires_plan), goi lai invite_organization_member_v1, doc lai ep status=PENDING, ghi ai_write_audit + so hanh dong. Token bi moi KHONG bao gio vao ledger/outcome.';

REVOKE ALL ON FUNCTION public.copilot_execute_member_moi_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_member_moi$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_member_moi_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_member_moi_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_member_moi_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_member_moi_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_member_moi$;

-- ---------------------------------------------------------------------------
-- MUC 3 - SO DANG KY + CO
-- ---------------------------------------------------------------------------
INSERT INTO app_private.copilot_action_registry (
  action_id, version, label_vi, permission_key, risk, executor_kind,
  consent_required, preview_rpc, execute_rpc, verify_kind,
  produces_entity_table, consumes_ref_table, rollback_rpc, rollback_note,
  flag_contract_id, enabled, grantable, pin_always
)
VALUES (
  'member.invite',
  1,
  'Mời thành viên',
  'users.create',
  'L5',
  'direct_l5_v1',
  'step_up',
  'copilot_preview_member_moi_v1',
  'copilot_execute_member_moi_v1',
  'readback',
  'organization_invitations',
  NULL,
  'revoke_organization_invitation_v1',
  'LECH BRIEF: doi tuong can thu hoi la LOI MOI (chua tao membership), khong phai set_membership_status_v1. Goi revoke_organization_invitation_v1(invitation_id). Token loi moi khong luu o dau ca - nguoi dung phai vao man hinh Thanh vien de lay lai/gui lai neu can.',
  'member.invite',
  true,
  false,
  true
)
ON CONFLICT (action_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', 'v2', true);

INSERT INTO public.copilot_feature_flags (
  scope, contract_id, state, reason, evidence_link, rollback_reference
)
VALUES (
  'action', 'member.invite', 'disabled',
  'seed kill switch cho action L5 moi thanh vien (G5-C2 nhom A) - policy con L4 nen action nay khong the chay ke ca bat co',
  'migration:20260903212605_copilot_action_member_moi_v1',
  'migration:20260903212605_copilot_action_member_moi_v1'
)
ON CONFLICT (scope, contract_id) DO NOTHING;

SELECT set_config('app.copilot_feature_flag_transition', '', true);

-- ---------------------------------------------------------------------------
-- NGHIEM THU
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_ten   text;
  v_thieu text[] := '{}'::text[];
  v_ho    text[] := '{}'::text[];
BEGIN
  FOREACH v_ten IN ARRAY ARRAY[
    'public.copilot_preview_member_moi_v1(uuid, jsonb)',
    'public.copilot_execute_member_moi_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-C2 member_moi: %', array_to_string(v_thieu, ', ');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app_private' AND table_name = 'copilot_action_registry'
       AND column_name = 'pin_always'
  ) THEN
    RAISE EXCEPTION 'cot pin_always chua duoc them';
  END IF;
  IF to_regprocedure('app_private.copilot_l5_plan_context_ok_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_l5_plan_context_ok_v1 missing - 20260903190255 phai chay truoc';
  END IF;
  IF to_regprocedure('public.invite_organization_member_v1(text, text, uuid, uuid[], integer)') IS NULL THEN
    RAISE EXCEPTION 'invite_organization_member_v1 missing - baseline phai co truoc';
  END IF;
  IF to_regprocedure('public.revoke_organization_invitation_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'revoke_organization_invitation_v1 missing - rollback_rpc phai ton tai that';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_member_moi_v1(uuid, jsonb)',
      'public.copilot_execute_member_moi_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-C2 member_moi: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'member.invite'
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'users.create'
       AND grantable = false
       AND pin_always = true
       AND rollback_rpc = 'revoke_organization_invitation_v1'
  ) THEN
    RAISE EXCEPTION 'seed registry member.invite sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'member.invite'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: member.invite';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
