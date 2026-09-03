-- G5-C2 (1/7, nhom A - phan quyen) - Action L5 `member.update_authorization` theo
-- khuon direct_l5_v1 (xem 20260903190255 cho khuon day du + F1 helper).
--
-- BOC RPC GOC: `update_member_authorization_v1(p_membership uuid, p_expected_version
-- bigint, p_role_bindings jsonb, p_overrides jsonb, p_reason text)` (SECURITY
-- DEFINER, doc production 03/09/2026 - tu giai actor qua auth.uid(), quyen qua
-- `require_perm_v1(org,'users.edit',...)`, khong tham so impersonate). Wrapper
-- goi NGUYEN VEN.
--
-- VI SAO NHOM A KHONG BAO GIO GRANTABLE - day la hanh dong SUA QUYEN cua NGUOI
-- KHAC. Registry.grantable=false (bat buoc boi CHECK F3 cua G5-C cho moi
-- direct_l5_v1) da chan duong uy quyen dung, nhung nhom nay them MOT LOP THU
-- HAI doc lap: cot moi `pin_always` + patch `copilot_plan_create_v1` de PIN
-- step-up khong bao gio bi bo qua cho 4 action phan quyen, ke ca neu logic
-- `grantable` sau nay doi nghia. Hang rao thua, co chu dich.
--
-- MUC 0 - THEM COT pin_always. DO-guard, idempotent.
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
-- MUC 0b - VA copilot_plan_create_v1: loai pin_always khoi duong tu-duyet-
-- theo-uy-quyen-dung. Than chep NGUYEN VEN tu production (doc qua Management
-- API ngay truoc khi viet file), chi hai cho doi: (a) mang v_gom ghi them
-- 'pin_always' cung luc voi 'grantable'; (b) dieu kien dau vong lap soat han
-- muc them ve pin_always.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_plan_create_v1(p_organization_id uuid, p_client_request_id text, p_steps jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private', 'extensions'
AS $function$
DECLARE
  v_actor      uuid := auth.uid();
  v_n          int;
  v_i          int;
  v_dem        int;
  v_cu         app_private.copilot_plans%ROWTYPE;
  v_reg        app_private.copilot_action_registry%ROWTYPE;
  v_max_direct text;
  v_policy_rev bigint;
  v_reg_rev    text;
  v_buoc       jsonb;
  v_du_lieu    jsonb;
  v_hanh_dong  text;
  v_kq         jsonb;
  v_canonical  jsonb;
  v_preview    jsonb;
  v_nonce_hex  text;
  v_digest     bytea;
  v_ref        int;
  v_voucher    uuid;
  v_ie         public.income_expenses%ROWTYPE;
  v_gom        jsonb := '[]'::jsonb;
  v_gom_digest jsonb := '[]'::jsonb;
  v_max_risk   text := 'L3';
  v_plan_digest bytea;
  v_plan_id    uuid;
  v_het        timestamptz;
  v_nonce      bytea;
  v_consent_id uuid;
  v_message    text;
  v_standing_enabled boolean;
  v_standing_ok      boolean;
  v_grant_locks      jsonb;
  v_step_entry       jsonb;
  v_j                int;
  v_matched_id       uuid;
  v_grant_row        app_private.copilot_standing_grants%ROWTYPE;
  v_reset_used       int;
  v_planned          int;
  v_needed_actions   text[];
  v_locked_ids       uuid[];
  v_amt_txt          text;
  v_final_grant_ids  uuid[];
  v_first_grant_id   uuid;
  v_grant_key        text;
  v_grant_val        text;
  v_han_grant        timestamptz;
  v_plan_version_moi int;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  IF NOT app_private.copilot_plan_role_allowed_v1(p_organization_id) THEN
    RAISE EXCEPTION 'plan_role_not_allowed' USING ERRCODE = '42501';
  END IF;

  IF NOT app_private.copilot_action_flag_allows_v1('copilot.execution_plan', p_organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = p_organization_id AND o.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'organization_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_client_request_id IS NULL
     OR p_client_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'client_request_id_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_cu
    FROM app_private.copilot_plans
   WHERE user_id = v_actor AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_cu.organization_id IS DISTINCT FROM p_organization_id THEN
      RAISE EXCEPTION 'client_request_id_reused' USING ERRCODE = '22023';
    END IF;
    RETURN app_private.copilot_plan_summary_v1(v_cu.id)
           || jsonb_build_object(
                'ok',            true,
                'error_code',    NULL,
                'consent_nonce', NULL,
                'da_ton_tai',    true);
  END IF;

  IF p_steps IS NULL OR jsonb_typeof(p_steps) <> 'array' THEN
    RAISE EXCEPTION 'plan_steps_invalid' USING ERRCODE = '22023';
  END IF;
  v_n := jsonb_array_length(p_steps);
  IF v_n < 1 OR v_n > 8 THEN
    RAISE EXCEPTION 'plan_step_count: % buoc, cho phep 1..8', v_n USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_dem
    FROM app_private.copilot_plans p
   WHERE p.user_id = v_actor
     AND ((p.status = 'DRAFT' AND p.expires_at > clock_timestamp())
          OR (p.status = 'APPROVED'
              AND COALESCE(p.execute_deadline, p.expires_at) > clock_timestamp()));
  IF v_dem >= 3 THEN
    RAISE EXCEPTION 'plan_limit: dang co % ke hoach mo', v_dem USING ERRCODE = '22023';
  END IF;

  SELECT max_direct_risk, revision INTO v_max_direct, v_policy_rev
    FROM app_private.copilot_action_policy WHERE id;
  IF v_max_direct IS NULL THEN
    RAISE EXCEPTION 'copilot_policy_missing' USING ERRCODE = 'P0002';
  END IF;
  v_reg_rev := app_private.copilot_plan_registry_revision_v1();

  FOR v_i IN 0 .. v_n - 1 LOOP
    v_buoc := p_steps -> v_i;
    IF jsonb_typeof(COALESCE(v_buoc, 'null'::jsonb)) <> 'object' THEN
      RAISE EXCEPTION 'step_invalid:%', v_i + 1 USING ERRCODE = '22023';
    END IF;
    v_hanh_dong := v_buoc ->> 'hanh_dong';
    v_du_lieu := v_buoc -> 'du_lieu';
    IF v_hanh_dong IS NULL
       OR jsonb_typeof(COALESCE(v_du_lieu, 'null'::jsonb)) <> 'object' THEN
      RAISE EXCEPTION 'step_invalid:%', v_i + 1 USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_reg
      FROM app_private.copilot_action_registry
     WHERE action_id = v_hanh_dong;
    IF NOT FOUND OR NOT v_reg.enabled THEN
      RAISE EXCEPTION 'copilot_action_disabled: % (buoc %)', v_hanh_dong, v_i + 1
        USING ERRCODE = '42501';
    END IF;

    IF v_reg.executor_kind <> 'maker_submit_v1'
       AND (CASE v_reg.risk WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END)
         > (CASE v_max_direct WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END) THEN
      RAISE EXCEPTION 'plan_risk_not_allowed: % la % nhung tran hien tai la %',
        v_hanh_dong, v_reg.risk, v_max_direct
        USING ERRCODE = '42501';
    END IF;

    PERFORM app_private.copilot_action_gate_v1(v_hanh_dong, p_organization_id);

    IF v_reg.executor_kind = 'nonce_abi_v1' THEN
      BEGIN
        EXECUTE format('SELECT public.%I($1, $2)', v_reg.preview_rpc)
           INTO v_kq
          USING p_organization_id, v_du_lieu;
      EXCEPTION WHEN others THEN
        GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
        RAISE EXCEPTION 'step_preview_failed:%:%', v_i + 1, v_message USING ERRCODE = '22023';
      END;

      v_canonical := v_kq -> 'canonical';
      v_preview := v_kq -> 'preview';
      v_nonce_hex := v_kq ->> 'confirmation_nonce';
      IF jsonb_typeof(COALESCE(v_canonical, 'null'::jsonb)) <> 'object' THEN
        RAISE EXCEPTION 'step_preview_failed:%:canonical_missing', v_i + 1
          USING ERRCODE = '22023';
      END IF;

      IF v_nonce_hex ~ '^[0-9a-fA-F]{64}$' THEN
        DELETE FROM app_private.copilot_write_confirmations
         WHERE nonce_digest = extensions.digest(decode(v_nonce_hex, 'hex'), 'sha256');
      END IF;
      v_nonce_hex := NULL;

      v_digest := app_private.copilot_payload_hash_v1(v_canonical);
      v_ref := NULL;

    ELSIF v_reg.executor_kind = 'direct_l5_v1' THEN
      -- G5-C2: L5 dung lai dung mo hinh preview/execute cua nonce_abi_v1, y het
      -- nhu nhanh xu ly luc CHAY o copilot_plan_execute_step_v1 - xem cho do.
      BEGIN
        EXECUTE format('SELECT public.%I($1, $2)', v_reg.preview_rpc)
           INTO v_kq
          USING p_organization_id, v_du_lieu;
      EXCEPTION WHEN others THEN
        GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
        RAISE EXCEPTION 'step_preview_failed:%:%', v_i + 1, v_message USING ERRCODE = '22023';
      END;

      v_canonical := v_kq -> 'canonical';
      v_preview := v_kq -> 'preview';
      v_nonce_hex := v_kq ->> 'confirmation_nonce';
      IF jsonb_typeof(COALESCE(v_canonical, 'null'::jsonb)) <> 'object' THEN
        RAISE EXCEPTION 'step_preview_failed:%:canonical_missing', v_i + 1
          USING ERRCODE = '22023';
      END IF;

      IF v_nonce_hex ~ '^[0-9a-fA-F]{64}$' THEN
        DELETE FROM app_private.copilot_write_confirmations
         WHERE nonce_digest = extensions.digest(decode(v_nonce_hex, 'hex'), 'sha256');
      END IF;
      v_nonce_hex := NULL;

      v_digest := app_private.copilot_payload_hash_v1(v_canonical);
      v_ref := NULL;

    ELSIF v_reg.executor_kind = 'maker_submit_v1' THEN
      IF v_du_lieu ? '$ref_step' THEN
        BEGIN
          v_ref := (v_du_lieu ->> '$ref_step')::int;
        EXCEPTION WHEN others THEN
          RAISE EXCEPTION 'step_ref_invalid:%', v_i + 1 USING ERRCODE = '22023';
        END;
        IF v_ref IS NULL OR v_ref < 1 OR v_ref > v_i THEN
          RAISE EXCEPTION 'step_ref_invalid:%', v_i + 1 USING ERRCODE = '22023';
        END IF;
        IF v_reg.consumes_ref_table IS NULL
           OR (v_gom -> (v_ref - 1) ->> 'produces_entity_table') IS NULL
           OR (v_gom -> (v_ref - 1) ->> 'produces_entity_table')
                IS DISTINCT FROM v_reg.consumes_ref_table THEN
          RAISE EXCEPTION 'step_ref_incompatible:%', v_i + 1 USING ERRCODE = '22023';
        END IF;
        v_canonical := jsonb_build_object('$ref_step', v_ref);
        v_preview := jsonb_build_object(
          'loai',       'nop_ho_so',
          'nguon',      'ket qua cua buoc ' || v_ref::text,
          'trang_thai', 'Se nop vao hang cho duyet — AI KHONG duyet');
      ELSIF v_du_lieu ? 'voucher_id' THEN
        BEGIN
          v_voucher := (v_du_lieu ->> 'voucher_id')::uuid;
        EXCEPTION WHEN others THEN
          RAISE EXCEPTION 'step_voucher_invalid:%', v_i + 1 USING ERRCODE = '22023';
        END;
        SELECT * INTO v_ie
          FROM public.income_expenses ie
         WHERE ie.id = v_voucher
           AND ie.deleted_at IS NULL
           AND ie.organization_id = p_organization_id
           AND ie.user_id = v_actor
           AND ie.approval_status = 'UNAPPROVED'
           AND ie.posting_status = 'UNPOSTED';
        IF NOT FOUND THEN
          RAISE EXCEPTION 'step_voucher_invalid:%', v_i + 1 USING ERRCODE = '22023';
        END IF;
        IF EXISTS (
          SELECT 1 FROM public.approval_requests a
           WHERE a.subject_type = 'FINANCIAL_VOUCHER'
             AND a.subject_id = v_voucher
             AND a.state IN ('PENDING_APPROVAL', 'POSTED')
        ) THEN
          RAISE EXCEPTION 'step_voucher_invalid:%', v_i + 1 USING ERRCODE = '22023';
        END IF;
        v_canonical := jsonb_build_object('voucher_id', v_voucher);
        v_preview := jsonb_build_object(
          'loai',       'nop_ho_so',
          'phieu',      v_ie.name,
          'so_tien',    v_ie.total_amount,
          'trang_thai', 'Se nop vao hang cho duyet — AI KHONG duyet');
        v_ref := NULL;
      ELSE
        RAISE EXCEPTION 'step_invalid:%', v_i + 1 USING ERRCODE = '22023';
      END IF;
      v_digest := app_private.copilot_payload_hash_v1(v_canonical);

    ELSE
      RAISE EXCEPTION 'executor_not_supported: %', v_reg.executor_kind USING ERRCODE = '0A000';
    END IF;

    IF (CASE v_reg.risk WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END)
       > (CASE v_max_risk WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END) THEN
      v_max_risk := v_reg.risk;
    END IF;

    v_gom := v_gom || jsonb_build_array(jsonb_build_object(
      'step_no',               v_i + 1,
      'action_id',             v_reg.action_id,
      'action_version',        v_reg.version,
      'label_vi',              v_reg.label_vi,
      'permission_key',        v_reg.permission_key,
      'risk',                  v_reg.risk,
      'executor_kind',         v_reg.executor_kind,
      'produces_entity_table', v_reg.produces_entity_table,
      'grantable',             v_reg.grantable,
      -- G5-C2: dieu kien THU HAI, doc lap voi grantable - xem chu thich dau
      -- file. Hang rao THU NHAT (grantable=false, bat buoc boi CHECK F3) da du
      -- de chan duong nay; cot nay chi la mot lop kiem lai ro rang.
      'pin_always',             v_reg.pin_always,
      'payload',               v_du_lieu,
      'canonical',              v_canonical,
      'payload_digest',        encode(v_digest, 'hex'),
      'preview',               v_preview,
      'ref_step',               v_ref));

    v_gom_digest := v_gom_digest || jsonb_build_array(jsonb_build_object(
      'n', v_i + 1,
      'a', v_reg.action_id,
      'v', v_reg.version,
      'd', encode(v_digest, 'hex')));
  END LOOP;

  SELECT standing_grants_enabled INTO v_standing_enabled
    FROM app_private.copilot_action_policy WHERE id;
  v_standing_ok := COALESCE(v_standing_enabled, false);
  v_grant_locks := '{}'::jsonb;

  IF v_standing_ok THEN
    v_needed_actions := ARRAY(
      SELECT DISTINCT (e ->> 'action_id')
        FROM jsonb_array_elements(v_gom) e
       WHERE COALESCE((e ->> 'grantable')::boolean, false)
         AND NOT COALESCE((e ->> 'pin_always')::boolean, false)
    );

    IF v_needed_actions IS NOT NULL AND cardinality(v_needed_actions) > 0 THEN
      SELECT COALESCE(array_agg(g.id ORDER BY g.id), '{}'::uuid[])
        INTO v_locked_ids
        FROM app_private.copilot_standing_grants g
       WHERE g.organization_id = p_organization_id
         AND g.action_id = ANY(v_needed_actions)
         AND g.revoked_at IS NULL
         AND g.expires_at > clock_timestamp()
       ORDER BY g.id
       FOR UPDATE;
    ELSE
      v_locked_ids := '{}'::uuid[];
    END IF;

    FOR v_j IN 0 .. v_n - 1 LOOP
      v_step_entry := v_gom -> v_j;
      -- G5-C2: `pin_always` chan o DAU vong lap, GIONG HET cach `grantable=false`
      -- da chan tu G5-B/G5-C - bat ke executor_kind/consent_required cua buoc
      -- la gi. Doi voi 4 action phan quyen, dieu kien nay luon dung vi
      -- grantable da la false (CHECK F3), nhung viet tuong minh de khong ai
      -- lam mot action tuong lai "pin_always nhung van grantable" ma khong bi
      -- chan o day.
      IF NOT COALESCE((v_step_entry ->> 'grantable')::boolean, false)
         OR COALESCE((v_step_entry ->> 'pin_always')::boolean, false) THEN
        v_standing_ok := false;
        EXIT;
      END IF;

      v_matched_id := NULL;
      FOR v_grant_row IN
        SELECT * FROM app_private.copilot_standing_grants g
         WHERE g.id = ANY(v_locked_ids)
           AND g.action_id = (v_step_entry ->> 'action_id')
         ORDER BY g.expires_at ASC
      LOOP
        v_reset_used := CASE WHEN v_grant_row.used_on IS DISTINCT FROM current_date
                              THEN 0 ELSE v_grant_row.used_today END;
        v_planned := COALESCE((v_grant_locks ->> v_grant_row.id::text)::int, 0);
        IF v_reset_used + v_planned >= v_grant_row.max_per_day THEN
          CONTINUE;
        END IF;

        v_amt_txt := (v_step_entry -> 'canonical') ->> 'amount';
        IF v_grant_row.constraints ? 'max_amount' THEN
          IF v_amt_txt IS NULL
             OR v_amt_txt !~ '^[0-9]+(\.[0-9]+)?$'
             OR v_amt_txt::numeric > (v_grant_row.constraints ->> 'max_amount')::numeric THEN
            CONTINUE;
          END IF;
        END IF;
        IF v_grant_row.constraints ? 'building_ids' THEN
          IF NOT ((v_step_entry -> 'canonical') ? 'building_id')
             OR NOT ((v_grant_row.constraints -> 'building_ids')
                       ? ((v_step_entry -> 'canonical') ->> 'building_id')) THEN
            CONTINUE;
          END IF;
        END IF;

        v_matched_id := v_grant_row.id;
        v_grant_locks := jsonb_set(v_grant_locks, ARRAY[v_grant_row.id::text],
                                    to_jsonb(v_planned + 1));
        EXIT;
      END LOOP;

      IF v_matched_id IS NULL THEN
        v_standing_ok := false;
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_plan_digest := app_private.copilot_payload_hash_v1(jsonb_build_object(
    'organization_id',   p_organization_id,
    'actor',             v_actor,
    'registry_revision', v_reg_rev,
    'steps',             v_gom_digest));

  v_het := clock_timestamp() + interval '5 minutes';

  BEGIN
    INSERT INTO app_private.copilot_plans (
      user_id, organization_id, client_request_id, status, version, plan_digest,
      registry_revision, policy_revision, max_risk, step_count, expires_at
    )
    VALUES (
      v_actor, p_organization_id, p_client_request_id, 'DRAFT', 1, v_plan_digest,
      v_reg_rev, v_policy_rev, v_max_risk, v_n, v_het
    )
    RETURNING id INTO v_plan_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_cu
      FROM app_private.copilot_plans
     WHERE user_id = v_actor AND client_request_id = p_client_request_id;
    IF v_cu.organization_id IS DISTINCT FROM p_organization_id THEN
      RAISE EXCEPTION 'client_request_id_reused' USING ERRCODE = '22023';
    END IF;
    RETURN app_private.copilot_plan_summary_v1(v_cu.id)
           || jsonb_build_object(
                'ok',            true,
                'error_code',    NULL,
                'consent_nonce', NULL,
                'da_ton_tai',    true);
  END;

  INSERT INTO app_private.copilot_plan_steps (
    plan_id, step_no, action_id, action_version, permission_key, risk, executor_kind,
    payload, canonical, payload_digest, preview, ref_step, status
  )
  SELECT
    v_plan_id,
    (e ->> 'step_no')::int,
    e ->> 'action_id',
    (e ->> 'action_version')::int,
    e ->> 'permission_key',
    e ->> 'risk',
    e ->> 'executor_kind',
    e -> 'payload',
    e -> 'canonical',
    decode(e ->> 'payload_digest', 'hex'),
    e -> 'preview',
    NULLIF(e ->> 'ref_step', '')::int,
    'PENDING'
    FROM jsonb_array_elements(v_gom) e;

  v_nonce := extensions.gen_random_bytes(32);
  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash, permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'lap_ke_hoach', v_plan_digest, 'copilot.execution_plan', v_het)
  RETURNING id INTO v_consent_id;

  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',           'plan_created',
    'organization_id', p_organization_id,
    'plan_id',         v_plan_id,
    'plan_version',    1,
    'permission_key',  'copilot.execution_plan',
    'permission_snapshot', jsonb_build_object(
      'registry_revision', v_reg_rev,
      'policy_revision',   v_policy_rev,
      'max_direct_risk',   v_max_direct,
      'plan_max_risk',     v_max_risk,
      'step_count',        v_n,
      'flag_plan',         true,
      'checked_at',        clock_timestamp()),
    'consent_id',      v_consent_id,
    'payload_digest',  encode(v_plan_digest, 'hex'),
    'outcome', jsonb_build_object(
      'plan_status',       'DRAFT',
      'client_request_id', p_client_request_id,
      'actions',           (SELECT jsonb_agg(e ->> 'action_id') FROM jsonb_array_elements(v_gom) e))
  ));

  IF v_standing_ok THEN
    v_final_grant_ids := ARRAY(SELECT (jsonb_object_keys(v_grant_locks))::uuid);
    v_first_grant_id := v_final_grant_ids[1];

    FOR v_grant_key, v_grant_val IN SELECT * FROM jsonb_each_text(v_grant_locks) LOOP
      UPDATE app_private.copilot_standing_grants
         SET used_today = (CASE WHEN used_on IS DISTINCT FROM current_date
                                 THEN 0 ELSE used_today END) + v_grant_val::int,
             used_on    = current_date
       WHERE id = v_grant_key::uuid;

      INSERT INTO app_private.copilot_standing_grants_audit (
        grant_id, organization_id, action, actor, detail
      )
      VALUES (
        v_grant_key::uuid, p_organization_id, 'used', v_actor,
        jsonb_build_object('plan_id', v_plan_id, 'used', v_grant_val::int)
      );

      PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
        'event',           'grant_used',
        'organization_id', p_organization_id,
        'plan_id',         v_plan_id,
        'grant_id',        v_grant_key::uuid,
        'outcome',         jsonb_build_object('used', v_grant_val::int)));
    END LOOP;

    UPDATE app_private.copilot_write_confirmations
       SET consumed_at = clock_timestamp()
     WHERE id = v_consent_id AND consumed_at IS NULL;

    v_han_grant := clock_timestamp() + interval '30 minutes';
    UPDATE app_private.copilot_plans
       SET status                  = 'APPROVED',
           approved_at             = clock_timestamp(),
           execute_deadline        = v_han_grant,
           consent_confirmation_id = v_consent_id,
           consent_kind            = 'standing_grant',
           standing_grant_ids      = v_final_grant_ids,
           version                 = version + 1,
           updated_at              = clock_timestamp()
     WHERE id = v_plan_id
    RETURNING version INTO v_plan_version_moi;

    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'plan_approved',
      'organization_id', p_organization_id,
      'plan_id',         v_plan_id,
      'plan_version',    v_plan_version_moi,
      'permission_key',  'copilot.execution_plan',
      'consent_id',      v_consent_id,
      'consent_kind',    'standing_grant',
      'grant_id',        v_first_grant_id,
      'payload_digest',  encode(v_plan_digest, 'hex'),
      'outcome', jsonb_build_object(
        'plan_status',        'APPROVED',
        'execute_deadline',   v_han_grant,
        'standing_grant_ids', to_jsonb(v_final_grant_ids))));

    RETURN app_private.copilot_plan_summary_v1(v_plan_id)
           || jsonb_build_object(
                'ok',                     true,
                'error_code',             NULL,
                'consent_nonce',          NULL,
                'da_ton_tai',             false,
                'tu_duyet_theo_uy_quyen', to_jsonb(v_final_grant_ids));
  END IF;

  RETURN app_private.copilot_plan_summary_v1(v_plan_id)
         || jsonb_build_object(
              'ok',            true,
              'error_code',    NULL,
              'consent_nonce', encode(v_nonce, 'hex'),
              'da_ton_tai',    false);
END
$function$
;

-- ---------------------------------------------------------------------------
-- MUC 1 - XEM TRUOC member.update_authorization
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_preview_member_cap_quyen_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $xem_truoc_member_cap_quyen$
DECLARE
  v_actor      uuid := auth.uid();
  v_snapshot   jsonb;
  v_membership uuid;
  v_expected   bigint;
  v_role_bindings jsonb;
  v_overrides  jsonb;
  v_reason     text;
  v_target_user uuid;
  v_target_org  uuid;
  v_target_email text;
  v_canonical  jsonb;
  v_nonce      bytea;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('member.update_authorization', p_organization_id);

  BEGIN
    v_membership := (p_payload ->> 'membership_id')::uuid;
    v_expected   := (p_payload ->> 'expected_version')::bigint;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END;
  v_role_bindings := p_payload -> 'role_bindings';
  v_overrides     := p_payload -> 'overrides';
  v_reason        := NULLIF(btrim(COALESCE(p_payload ->> 'reason', '')), '');

  IF v_membership IS NULL OR v_expected IS NULL OR v_reason IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;
  IF v_role_bindings IS NULL AND v_overrides IS NULL THEN
    RAISE EXCEPTION 'payload_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT m.organization_id, m.user_id, m.version, u.email
    INTO v_target_org, v_target_user, v_expected, v_target_email
    FROM public.organization_memberships m
    JOIN auth.users u ON u.id = m.user_id
   WHERE m.id = v_membership;
  IF v_target_org IS NULL OR v_target_org IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_target_user = v_actor THEN
    RAISE EXCEPTION 'cannot_edit_self' USING ERRCODE = '42501';
  END IF;

  -- canonical mang LUON expected_version doc THAT tu bang, khong tin so client
  -- gui - mot phien lam viec 30 phut se so khop chinh xac luc execute.
  v_canonical := jsonb_build_object(
    'organization_id',  p_organization_id,
    'membership_id',    v_membership,
    'expected_version', v_expected,
    'role_bindings',    v_role_bindings,
    'overrides',        v_overrides,
    'reason',           v_reason
  );
  v_nonce := extensions.gen_random_bytes(32);

  INSERT INTO app_private.copilot_write_confirmations
    (nonce_digest, user_id, organization_id, tool, payload_hash,
     permission_key, expires_at)
  VALUES
    (extensions.digest(v_nonce, 'sha256'), v_actor, p_organization_id,
     'member.update_authorization', app_private.copilot_payload_hash_v1(v_canonical),
     'users.edit', clock_timestamp() + interval '5 minutes');

  RETURN jsonb_build_object(
    'confirmation_nonce', encode(v_nonce, 'hex'),
    'canonical',          v_canonical,
    'preview', jsonb_build_object(
      'ten_khach_hang',      NULL,
      'so_dien_thoai',       NULL,
      'toa_nha',             NULL,
      'trang_thai_hien_tai', v_target_email,
      'hau_qua',             'Se ghi de vai tro/ngoai le phan quyen cua thanh vien nay',
      'canh_bao',            'PIN step-up bat buoc; khong bao gio duoc uy quyen dung du grantable co doi'
    )
  );
END
$xem_truoc_member_cap_quyen$;

COMMENT ON FUNCTION public.copilot_preview_member_cap_quyen_v1(uuid, jsonb) IS
  'direct_l5_v1 - xem truoc sua phan quyen thanh vien (boc update_member_authorization_v1). Nhom A - grantable=false + pin_always=true.';

REVOKE ALL ON FUNCTION public.copilot_preview_member_cap_quyen_v1(uuid, jsonb)
  FROM PUBLIC;
DO $quyen_xem_truoc_member_cap_quyen$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_member_cap_quyen_v1(uuid, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_member_cap_quyen_v1(uuid, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_preview_member_cap_quyen_v1(uuid, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_preview_member_cap_quyen_v1(uuid, jsonb) TO authenticated;
  END IF;
END
$quyen_xem_truoc_member_cap_quyen$;

-- ---------------------------------------------------------------------------
-- MUC 2 - THUC THI member.update_authorization
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copilot_execute_member_cap_quyen_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $thuc_thi_member_cap_quyen$
DECLARE
  v_actor      uuid := auth.uid();
  v_hash       bytea;
  v_row        app_private.copilot_write_confirmations%ROWTYPE;
  v_snapshot   jsonb;
  v_org        uuid;
  v_membership uuid;
  v_expected   bigint;
  v_role_bindings jsonb;
  v_overrides  jsonb;
  v_reason     text;
  v_key        text;
  v_prev       public.ai_write_audit%ROWTYPE;
  v_before     jsonb;
  v_after      jsonb;
  v_result     jsonb;
  v_audit_id   uuid;
  v_ledger_id  uuid;
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
  IF v_row.tool IS DISTINCT FROM 'member.update_authorization'
     OR v_row.permission_key IS DISTINCT FROM 'users.edit' THEN
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
    v_org           := (p_payload ->> 'organization_id')::uuid;
    v_membership    := (p_payload ->> 'membership_id')::uuid;
    v_expected      := (p_payload ->> 'expected_version')::bigint;
    v_role_bindings := p_payload -> 'role_bindings';
    v_overrides     := p_payload -> 'overrides';
    v_reason        := p_payload ->> 'reason';
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;
  IF v_org IS NULL OR v_membership IS NULL OR v_expected IS NULL
     OR v_org IS DISTINCT FROM v_row.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  -- Guard L5 (F1, dung chung voi khuon G5-C - xem 20260903190255).
  IF NOT app_private.copilot_l5_plan_context_ok_v1('member.update_authorization', v_org) THEN
    RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';
  END IF;

  v_snapshot := app_private.copilot_action_gate_v1('member.update_authorization', v_org);

  v_key := 'copilot_action:member.update_authorization:' || v_actor::text || ':'
        || v_org::text || ':' || encode(v_hash, 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));

  SELECT * INTO v_prev
    FROM public.ai_write_audit a
   WHERE a.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',       'da_thuc_hien_truoc_do',
      'entity_table', 'organization_memberships',
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

  SELECT to_jsonb(m) INTO v_before
    FROM public.organization_memberships m
   WHERE m.id = v_membership AND m.organization_id = v_org;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'entity_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_result := public.update_member_authorization_v1(
    v_membership, v_expected, v_role_bindings, v_overrides, v_reason);

  -- READBACK - doc lai tu bang, version phai tang so voi truoc.
  SELECT to_jsonb(m) INTO v_after
    FROM public.organization_memberships m
   WHERE m.id = v_membership;
  IF v_after IS NULL
     OR NULLIF(v_after ->> 'organization_id', '')::uuid IS DISTINCT FROM v_org
     OR (v_after ->> 'version')::bigint <= (v_before ->> 'version')::bigint THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.ai_write_audit
    (user_id, tool, idempotency_key, entity_table, entity_id, payload, organization_id)
  VALUES
    (v_actor, 'member.update_authorization', v_key, 'organization_memberships',
     v_membership, p_payload, v_org)
  RETURNING id INTO v_audit_id;

  v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',               'action_executed',
    'organization_id',     v_org,
    'action_id',           'member.update_authorization',
    'permission_key',      'users.edit',
    'permission_snapshot', v_snapshot,
    'consent_kind',        'click',
    'consent_id',          v_row.id,
    'payload_digest',      encode(v_hash, 'hex'),
    'before_digest',       encode(extensions.digest(
                             convert_to(v_before::text, 'UTF8'), 'sha256'), 'hex'),
    'after_digest',        encode(extensions.digest(
                             convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex'),
    'entity_table',        'organization_memberships',
    'entity_id',           v_membership,
    'audit_id',            v_audit_id,
    'outcome',             jsonb_build_object('status', 'da_thuc_hien', 'result', v_result)
  ));

  RETURN jsonb_build_object(
    'status',       'da_thuc_hien',
    'entity_table', 'organization_memberships',
    'entity_id',    v_membership,
    'audit_id',     v_audit_id,
    'ledger_id',    v_ledger_id
  );
END
$thuc_thi_member_cap_quyen$;

COMMENT ON FUNCTION public.copilot_execute_member_cap_quyen_v1(text, jsonb) IS
  'direct_l5_v1 - tieu nonce, tu choi neu khong chay trong ke hoach (l5_requires_plan), goi lai update_member_authorization_v1, doc lai ep version tang, ghi ai_write_audit + so hanh dong.';

REVOKE ALL ON FUNCTION public.copilot_execute_member_cap_quyen_v1(text, jsonb)
  FROM PUBLIC;
DO $quyen_thuc_thi_member_cap_quyen$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_member_cap_quyen_v1(text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_member_cap_quyen_v1(text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_execute_member_cap_quyen_v1(text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_execute_member_cap_quyen_v1(text, jsonb) TO authenticated;
  END IF;
END
$quyen_thuc_thi_member_cap_quyen$;

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
  'member.update_authorization',
  1,
  'Sửa phân quyền thành viên',
  'users.edit',
  'L5',
  'direct_l5_v1',
  'step_up',
  'copilot_preview_member_cap_quyen_v1',
  'copilot_execute_member_cap_quyen_v1',
  'readback',
  'organization_memberships',
  NULL,
  'update_member_authorization_v1',
  'Goi lai update_member_authorization_v1 voi role_bindings/overrides CU doc tu before_digest cua dong so hanh dong. Khong tu dong goi.',
  'member.update_authorization',
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
  'action', 'member.update_authorization', 'disabled',
  'seed kill switch cho action L5 sua phan quyen thanh vien (G5-C2 nhom A) - policy con L4 nen action nay khong the chay ke ca bat co',
  'migration:20260903212600_copilot_action_member_cap_quyen_v1',
  'migration:20260903212600_copilot_action_member_cap_quyen_v1'
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
  v_than  text;
BEGIN
  FOREACH v_ten IN ARRAY ARRAY[
    'public.copilot_preview_member_cap_quyen_v1(uuid, jsonb)',
    'public.copilot_execute_member_cap_quyen_v1(text, jsonb)'
  ]
  LOOP
    IF to_regprocedure(v_ten) IS NULL THEN
      v_thieu := v_thieu || v_ten;
    END IF;
  END LOOP;
  IF cardinality(v_thieu) > 0 THEN
    RAISE EXCEPTION 'thieu ham G5-C2 member_cap_quyen: %', array_to_string(v_thieu, ', ');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app_private' AND table_name = 'copilot_action_registry'
       AND column_name = 'pin_always'
  ) THEN
    RAISE EXCEPTION 'cot pin_always chua duoc them';
  END IF;

  SELECT pg_get_functiondef('public.copilot_plan_create_v1(uuid, text, jsonb)'::regprocedure)
    INTO v_than;
  IF v_than !~ 'pin_always' THEN
    RAISE EXCEPTION 'copilot_plan_create_v1 chua doc pin_always';
  END IF;

  IF to_regprocedure('app_private.copilot_l5_plan_context_ok_v1(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'copilot_l5_plan_context_ok_v1 missing - 20260903190255 phai chay truoc';
  END IF;
  IF to_regprocedure('public.update_member_authorization_v1(uuid, bigint, jsonb, jsonb, text)') IS NULL THEN
    RAISE EXCEPTION 'update_member_authorization_v1 missing - baseline phai co truoc';
  END IF;

  IF to_regrole('anon') IS NOT NULL THEN
    FOREACH v_ten IN ARRAY ARRAY[
      'public.copilot_preview_member_cap_quyen_v1(uuid, jsonb)',
      'public.copilot_execute_member_cap_quyen_v1(text, jsonb)'
    ]
    LOOP
      IF has_function_privilege('anon', to_regprocedure(v_ten)::oid, 'EXECUTE') THEN
        v_ho := v_ho || v_ten;
      END IF;
    END LOOP;
    IF cardinality(v_ho) > 0 THEN
      RAISE EXCEPTION 'anon goi duoc ham G5-C2 member_cap_quyen: %', array_to_string(v_ho, ', ');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app_private.copilot_action_registry
     WHERE action_id = 'member.update_authorization'
       AND risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'
       AND permission_key = 'users.edit'
       AND grantable = false
       AND pin_always = true
       AND rollback_rpc = 'update_member_authorization_v1'
  ) THEN
    RAISE EXCEPTION 'seed registry member.update_authorization sai hinh hoac thieu';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.copilot_feature_flags f
     WHERE f.scope = 'action' AND f.contract_id = 'member.update_authorization'
  ) THEN
    RAISE EXCEPTION 'copilot_rollout_seed_thieu_action_contract: member.update_authorization';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
