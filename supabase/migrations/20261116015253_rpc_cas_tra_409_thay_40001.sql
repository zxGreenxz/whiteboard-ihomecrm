-- =============================================================================
-- RPC kiểm phiên bản (CAS) trả HTTP 409 thay vì 40001 — PostgREST thôi tự chạy lại không dừng.
--
-- VÌ SAO
--   PostgREST coi SQLSTATE 40001 (serialization_failure) là lỗi tuần tự hoá và TỰ CHẠY LẠI cả giao
--   dịch, không giới hạn số lần. Khi chính hàm ném 40001 vì version / hash / revision client gửi đã
--   cũ, điều kiện không tự hết nên lời gọi treo tới khi gateway cắt. Đo trên TEST 16/11/2026:
--   update_meter_reading_v1 với p_expected_updated_at cũ ⇒ 125,2 giây rồi HTTP 504 "upstream request
--   timeout"; trong lúc đó máy chủ gọi lại hàm liên tục (mỗi lần khoá dòng). Web và Hermes chỉ thấy
--   504, không thấy câu "tải lại".
--   PT409 là mã miền repo đã dùng cho xung đột (20260912091403, 20261031124214 và hơn 150 migration):
--   PostgREST trả HTTP 409 ngay, không chạy lại.
--
-- LÀM GÌ
--   Thay thân 30 hàm: CHỈ đổi chữ ERRCODE '40001' thành 'PT409' ở 44 chỗ ném. Giữ nguyên
--   MESSAGE / DETAIL / HINT, chữ ký, DEFAULT, SECURITY DEFINER/INVOKER, search_path và owner. Thân lấy
--   nguyên văn từ production (pg_get_functiondef, 16/11/2026). Quyền: CREATE OR REPLACE vốn giữ ACL; vẫn
--   cấp lại tường minh trong file định nghĩa sống đúng như ACL production đã đọc (REVOKE PUBLIC + vai API,
--   GRANT EXECUTE đúng các vai đang có) để database dựng lại có cùng quyền với production.
--   Kiểm trước: mỗi hàm phải đúng bản production đã rà — md5(prosrc) (hoặc md5 bản mới — chạy lại được),
--   SECURITY DEFINER/INVOKER, proconfig (search_path), và tập vai có EXECUTE phải CHỨA tập production
--   (thiếu ⇒ PR khác vừa thu quyền; dư như database dựng lại thì REVOKE/GRANT kéo về đúng). Lệch ⇒ 55000,
--   không ghi gì (PR khác vừa thay thân hay quyền thì phải lấy lại định nghĩa và rà lại, không âm thầm đè).
--   Kiểm sau: md5 đúng bản mới, không hàm nào còn ERRCODE '40001', đúng số chỗ PT409, quyền đúng như trước.
--
-- PHÂN LOẠI (rà 16/11/2026: 35 RPC public authenticated gọi được + 19 hàm phụ tự ném 40001; không
-- hàm nào tự ném 40P01 — PostgREST cũng không tự chạy lại 40P01)
--   (a) SỬA Ở ĐÂY — so với giá trị client gửi (p_expected_*, p_revision, hash, basisFingerprint) hoặc với
--       ảnh chụp đã lưu từ giao dịch trước (confirm_cashbook_closing_v1: số dư lúc đề nghị). Lặp lại cùng
--       lời gọi luôn ném lại ⇒ PostgREST lặp vô hạn. Gồm cả hàm phụ mà RPC public truyền thẳng giá trị
--       client vào: _profit_state_change_v2 (profit_unlock_v2 / profit_reset_*), _profit_write_close_v2_base
--       (profit_close_v2 / profit_reclose_v2), app_private.commission_reason_cancel_flex_before_v1
--       (cancel_income_expense_flex_v1). Chỗ ném "phòng thủ" sau UPDATE ... WHERE version = expected trong
--       cùng hàm cũng đổi: chạy lại sẽ gặp đúng chỗ ném CAS client ở trên.
--   (b) GIỮ 40001 — chỉ so hai lần đọc trong cùng giao dịch (dưới khoá); chạy lại hội tụ về lỗi khác hoặc
--       thành công: create_contract_v2, record_meter_readings_v2, undo_invoice_payment_compat_v1,
--       hermes_connection_context_v2/v3, hermes_connection_options_v1/v2/v3, hermes_org_policy_options_v2,
--       app_private.decide_financial_request_v1 / emergency_approve_financial_v1 /
--       self_approve_within_limit_v1 / post_financial_request_v1 (version do hàm gọi tự đọc).
--   (c) GIỮ — không đi qua PostgREST: app_private.hermes_store_* và hermes_claim_v1 (kho bền connector gọi
--       Postgres trực tiếp bằng vai hermes_store_executor), app_private.set_feature_route_v1 (script vận hành).
--
-- Hermes: hàm bọc thao tác đã coi PT409 như 40001 (IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN
-- RAISE; hermes_action_reason_v1 ánh xạ cả hai ⇒ state_changed). Web đổi cùng PR để nhận PT409 / HTTP 409.
-- =============================================================================

BEGIN;

DO $kiem_truoc$
DECLARE
  r record;
  f record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public._profit_state_change_v2(text,uuid,date,text,text,uuid[],text)', '04473f29d8ab55fced31d18ac7708698', 'd9ca5530f2a90ebed9baec67df1db448', true, '{"search_path=pg_catalog, public"}', 'service_role'),
    ('public._profit_write_close_v2_base(text,uuid,date,text,text,text,uuid[],jsonb)', '67f05808d05d408d584e230dce94d2dc', '91741fe340d354139bca715acbcae068', true, '{"search_path=pg_catalog, public"}', 'service_role'),
    ('public.confirm_cashbook_closing_v1(uuid,numeric)', 'e403ef90facb97998d3305d128d8d4c7', '080a1e19af70a2066b6f443689d48e61', true, '{"search_path=pg_catalog, app_private, public"}', 'authenticated'),
    ('public.copilot_plan_approve_v1(uuid,text,text,integer,text)', '50694adcad4d0cca2c5978e3b8b7572c', 'c13b6607429607c0658bde118ca14757', true, '{"search_path=pg_catalog, public, app_private, extensions"}', 'authenticated'),
    ('public.copilot_plan_cancel_v1(uuid,integer,text)', '0088dd0183fb4cebc7259703fcbf35b2', '825e311099fe0dc1e9f6ff1a56bd4758', true, '{"search_path=pg_catalog, public, app_private, extensions"}', 'authenticated'),
    ('public.copilot_plan_execute_step_v1(uuid,integer,integer,uuid)', '80e1695e1f91acb275b02708a3f0dd30', 'c3c39dc5dadcd1287a056d27278ac3b8', true, '{"search_path=pg_catalog, public, app_private, extensions"}', 'authenticated'),
    ('public.copilot_plan_reconcile_step_v1(uuid,integer,integer)', '7e02bfdcb376d60e1b9ff4575ff70b15', '45b8aee714cbc298ace14b4d0c24a1d8', true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated'),
    ('public.decide_financial_voucher(uuid,text,text,bigint)', 'e5f5c5f64cd2699eaf96b3dd958daa67', '95d99a861c58c65face1c31d70251f13', true, '{"search_path=pg_catalog, public"}', 'service_role'),
    ('public.delete_contract_draft_v1(uuid,uuid,integer)', '5bba625c0fbf091d13877e7b7a106152', '39adf63636cdc7925db7c04b5ac30a96', true, '{"search_path=\"\""}', 'authenticated'),
    ('public.job_recurrence_delete_v1(uuid,integer)', 'd17458b674f4f36b2746e5949d5878c7', 'ef5fde692e0eb2ebebec4d273eba5cca', false, '{"search_path=\"\""}', 'authenticated'),
    ('public.job_recurrence_set_paused_v1(uuid,integer,boolean)', '702a8fd4064063314b562aa9799112ad', 'b142806f58eecc89aae0abb1f088c0b0', false, '{"search_path=\"\""}', 'authenticated'),
    ('public.job_recurrence_update_v1(uuid,integer,jsonb)', 'ccc21f5584178b5456fd0a01b1b11bdc', '349bdafec29ccc7676062551135c5999', false, '{"search_path=\"\""}', 'authenticated'),
    ('public.landlord_operation_upsert_v1(uuid,text,numeric,date,uuid[],text,boolean,numeric,boolean,date,numeric,timestamp with time zone,numeric,text)', '2846b0edf9b1e56d8be23d41a104b6a4', 'b0316ccf0b21ce8b0b16d47a1451c1a7', true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated,service_role'),
    ('public.landlord_portal_confirm_v1(text,text,text,date,integer,text)', 'c98e23877c234c486aa4de5522e74237', '5080c884a63219bbd772f2f0690da452', true, '{"search_path=pg_catalog, public, app_private"}', 'anon,authenticated,service_role'),
    ('public.landlord_settlement_close_v1(uuid,date,text,text)', '53e295d74153677fe5f6301b9959184b', '6db68f8d1830d50bc8583866ecd7d178', true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated,service_role'),
    ('public.landlord_settlement_confirm_v1(text,date,integer,text)', '1fd4b01320fb25db2b7a4e0d61ffa432', '007e69f1c831ced39807cfae140d41ee', true, '{"search_path=pg_catalog, public, app_private"}', 'anon,authenticated,service_role'),
    ('public.landlord_settlement_note_update_v1(uuid,date,integer,text)', '3fbe77d09c9098518e24b60e0b1e8d68', 'af18160b607602c2bb552b2d8631ed1e', true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated,service_role'),
    ('public.network_center_resume_organization_v1(uuid,bigint,text,uuid)', '80e9dae0f4d07160110083ca007ac9b8', 'b68f3a0a17df89f25c8f9ab9c57d1517', true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated'),
    ('public.network_center_update_settings_v1(uuid,jsonb,bigint,uuid)', 'c6ca891d1892c233c53357edb54e9d95', 'beb840e2a85c67a82fc8f8c085351cf7', true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated,service_role'),
    ('public.profit_reset_checked_v2(uuid,date,text,text,text,uuid[],uuid[])', '4428e497b778580a1702348fe48d5898', 'fea01099aeb6af885d871a35e0193e92', true, '{"search_path=pg_catalog, public"}', 'authenticated,service_role'),
    ('public.register_contract_draft_document(uuid,uuid,integer,uuid,uuid,jsonb,text,text,jsonb)', '1a32cbfa447bd90211b17a4773102f4b', 'ab50789a66c57289300fafd76c01c5bc', true, '{"search_path=\"\""}', 'authenticated'),
    ('public.save_contract_draft(uuid,uuid,uuid,jsonb,uuid,uuid,integer,uuid)', '644f4e08f2cff9536ba592bfd48edc67', '2996e749c78a5b8912aa993cb1ca2779', true, '{"search_path=\"\""}', 'authenticated'),
    ('public.set_copilot_action_policy_v1(bigint,text,text[],boolean,text,text)', '7f0a6a6f163204ff01e9fce7f4af77c7', '9071db2ed5566ed0e596629895f33d36', true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated'),
    ('public.set_copilot_feature_flag_v2(text,text,text,bigint,uuid,text,text,timestamp with time zone,text)', 'bbec969d3c2982602441ae84dfca2d2e', '9295ca37f8c34897f782bc75de4cc78c', true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated'),
    ('public.settle_reservation_deposit_v1(jsonb)', '14935bc556d03a404df71ab6b1aea3bf', '2c93e21192606acc4ef0b431b17d9e8d', true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated,service_role'),
    ('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])', '1970b0e6ab01a750519599a89117ecaa', 'de09384fa892da2578d5e974977796f4', true, '{"search_path=\"\""}', 'authenticated'),
    ('public.update_member_authorization_v1(uuid,bigint,jsonb,jsonb,text)', 'fad503e09528e5da12cc129443b6c617', '26935e24f24c17b279274a0cfcb43f76', true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated,service_role'),
    ('public.update_meter_reading_v1(uuid,numeric,date,text,text,timestamp with time zone)', 'c0d69213012c56e2fc39ff3547615f23', '328015b7335106fef0b08e45b8bd819c', true, '{search_path=public}', 'authenticated,service_role'),
    ('public.upsert_organization_role_v1(uuid,text,jsonb,bigint,text)', '16962a4061e37340a1aa5e6e1023bfd0', '94b58c1415690e70a2f5802b15beca1c', true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated,service_role'),
    ('app_private.commission_reason_cancel_flex_before_v1(uuid,text,bigint,bigint)', '69c59c762f26ddbda20ff6bca35b1ac9', '7a27b74acb537bf89973bd67980ee30f', true, '{"search_path=pg_catalog, app_private, public"}', '')
  ) AS t(ham, md5_cu, md5_moi, bao_mat, cau_hinh, quyen) LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) AS md5, p.prosecdef AS bao_mat, p.proconfig::text AS cau_hinh,
           COALESCE((SELECT string_agg(g.vai, ',' ORDER BY g.vai)
                       FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS vai
                               FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                              WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) g), '') AS quyen
      INTO f FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure(r.ham);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Không thấy hàm % — dừng, rà lại danh sách', r.ham USING ERRCODE = '55000';
    END IF;
    IF f.md5 NOT IN (r.md5_cu, r.md5_moi) THEN
      RAISE EXCEPTION 'Thân % đã khác bản production đã rà (md5 %) — lấy lại thân rồi rà lại', r.ham, f.md5
        USING ERRCODE = '55000';
    END IF;
    -- Quyền: tập đang có phải CHỨA tập production. Thiếu ⇒ một PR khác vừa thu quyền ⇒ dừng, không cấp lại.
    -- Dư (database dựng lại từ baseline --no-acl + shim cấp EXECUTE cho cả ba vai API) ⇒ REVOKE/GRANT phía
    -- sau kéo về đúng tập production; kiểm sau so tuyệt đối.
    IF f.bao_mat IS DISTINCT FROM r.bao_mat OR f.cau_hinh IS DISTINCT FROM r.cau_hinh
       OR NOT (COALESCE(string_to_array(NULLIF(r.quyen, ''), ','), '{}'::text[])
               <@ COALESCE(string_to_array(NULLIF(f.quyen, ''), ','), '{}'::text[])) THEN
      RAISE EXCEPTION 'Thuộc tính % đã khác production đã rà (SECURITY DEFINER %, proconfig %, EXECUTE cho [%], cần có [%]) — rà lại',
        r.ham, f.bao_mat, f.cau_hinh, f.quyen, r.quyen USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$kiem_truoc$;

-- public._profit_state_change_v2(text,uuid,date,text,text,uuid[],text): 1 chỗ ném
CREATE OR REPLACE FUNCTION public._profit_state_change_v2(p_operation text, p_organization_id uuid, p_period_month date, p_reason text, p_idempotency_key text, p_building_ids uuid[], p_expected_source_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_expected_hash text := NULLIF(lower(btrim(COALESCE(p_expected_source_hash, ''))), '');
  v_building_ids uuid[] := p_building_ids;
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_run public.profit_close_runs%ROWTYPE;
  v_before jsonb;
  v_state_hash text;
  v_result jsonb;
  v_run_id uuid := gen_random_uuid();
  v_building_id uuid;
  v_pm public.profit_monthly%ROWTYPE;
  v_revision bigint;
  v_shareholder_allocations jsonb;
  v_manager_allocations jsonb;
  v_previous_snapshot jsonb;
  v_current_snapshot jsonb;
  v_affected integer := 0;
BEGIN
  IF p_operation NOT IN ('RESET', 'UNLOCK') THEN
    RAISE EXCEPTION 'Invalid state-change operation' USING ERRCODE = '22023';
  END IF;
  IF p_period_month IS NULL
     OR p_period_month <> date_trunc('month', p_period_month)::date THEN
    RAISE EXCEPTION 'period_month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;
  IF char_length(v_reason) NOT BETWEEN 8 AND 1000 THEN
    RAISE EXCEPTION 'reason must contain 8..1000 characters'
      USING ERRCODE = '22023';
  END IF;
  IF char_length(v_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'idempotency_key must contain 8..200 characters'
      USING ERRCODE = '22023';
  END IF;
  IF v_expected_hash IS NOT NULL AND v_expected_hash !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'expected_source_hash must be a 32-character MD5'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public._profit_assert_authorized_v2(
    p_organization_id, 'shareholder_profit.unlock'
  );

  v_request_payload := jsonb_build_object(
    'operation', p_operation,
    'organization_id', p_organization_id,
    'period_month', p_period_month,
    'reason', v_reason,
    'building_ids', to_jsonb(p_building_ids),
    'expected_source_hash', v_expected_hash
  );
  v_request_hash := md5(v_request_payload::text);

  PERFORM pg_advisory_xact_lock(
    hashtext(p_organization_id::text), hashtext('profit-key:' || v_key)
  );

  SELECT *
  INTO v_existing_run
  FROM public.profit_close_runs r
  WHERE r.organization_id = p_organization_id
    AND r.idempotency_key = v_key;
  IF FOUND THEN
    IF v_existing_run.operation <> p_operation
       OR v_existing_run.period_month <> p_period_month
       OR v_existing_run.request_hash <> v_request_hash THEN
      RAISE EXCEPTION 'Idempotency key was already used with a different request'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing_run.result_snapshot
      || jsonb_build_object('idempotent_replay', true);
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(p_organization_id::text), hashtext(p_period_month::text)
  );

  -- NULL intentionally means every current snapshot in the org/period,
  -- including legacy virtual buckets. Close/preview remain real-building-only.
  IF v_building_ids IS NULL THEN
    SELECT array_agg(pm.building_id ORDER BY pm.building_id)
    INTO v_building_ids
    FROM public.profit_monthly pm
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = p_period_month;
  ELSE
    IF array_position(v_building_ids, NULL) IS NOT NULL THEN
      RAISE EXCEPTION 'building_ids cannot contain NULL' USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(*) FROM unnest(v_building_ids) x)
       <> (SELECT count(DISTINCT x) FROM unnest(v_building_ids) x) THEN
      RAISE EXCEPTION 'building_ids contains duplicates' USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(*)
        FROM public.profit_monthly pm
        WHERE pm.organization_id = p_organization_id
          AND pm.period_month = p_period_month
          AND pm.building_id = ANY(v_building_ids))
       <> cardinality(v_building_ids) THEN
      RAISE EXCEPTION 'Every requested building must have a current period snapshot'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  v_building_ids := COALESCE(v_building_ids, '{}'::uuid[]);

  IF NOT public.is_super_admin() AND EXISTS (
    SELECT 1
    FROM unnest(v_building_ids) bid
    WHERE NOT public.authorize_v2(
      'shareholder_profit.unlock', p_organization_id, 'BUILDING', bid
    )
  ) THEN
    RAISE EXCEPTION 'Unlock permission does not cover every requested building'
      USING ERRCODE = '42501';
  END IF;

  IF p_operation = 'UNLOCK' AND EXISTS (
    SELECT 1
    FROM public.profit_monthly pm
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = p_period_month
      AND pm.building_id = ANY(v_building_ids)
      AND pm.status <> 'LOCKED'
  ) THEN
    RAISE EXCEPTION 'UNLOCK requires LOCKED current snapshots'
      USING ERRCODE = '55000';
  END IF;

  IF v_expected_hash IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.profit_monthly pm
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = p_period_month
      AND pm.building_id = ANY(v_building_ids)
      AND pm.source_hash IS DISTINCT FROM v_expected_hash
  ) THEN
    RAISE EXCEPTION 'PROFIT_SOURCE_CONFLICT current snapshots do not match expected hash'
      USING ERRCODE = 'PT409';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'profit_monthly', to_jsonb(pm),
      'shareholder_allocations', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', pa.id,
            'shareholder_id', pa.shareholder_id,
            'percent', pa.percent,
            'amount', pa.amount,
            'created_at', pa.created_at
          ) ORDER BY pa.shareholder_id, pa.id
        )
        FROM public.profit_allocations pa
        WHERE pa.profit_monthly_id = pm.id
      ), '[]'::jsonb),
      'manager_allocations', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', pma.id,
            'manager_id', pma.manager_id,
            'amount', pma.amount,
            'created_at', pma.created_at
          ) ORDER BY pma.manager_id, pma.id
        )
        FROM public.profit_manager_allocations pma
        WHERE pma.profit_monthly_id = pm.id
      ), '[]'::jsonb)
    ) ORDER BY pm.building_id
  ), '[]'::jsonb)
  INTO v_before
  FROM public.profit_monthly pm
  WHERE pm.organization_id = p_organization_id
    AND pm.period_month = p_period_month
    AND pm.building_id = ANY(v_building_ids);

  v_state_hash := md5(v_before::text);
  v_affected := cardinality(v_building_ids);
  v_result := jsonb_build_object(
    'run_id', v_run_id,
    'operation', p_operation,
    'organization_id', p_organization_id,
    'period_month', p_period_month,
    'affected_buildings', v_affected,
    'deleted_current_snapshots', p_operation = 'RESET',
    'state_hash', v_state_hash,
    'idempotent_replay', false
  );

  INSERT INTO public.profit_close_runs (
    id, organization_id, period_month, operation, actor_id, reason,
    idempotency_key, request_payload, request_hash, expected_source_hash,
    source_hash, source_captured_at, source_snapshot, allocation_snapshot,
    result_snapshot
  ) VALUES (
    v_run_id,
    p_organization_id,
    p_period_month,
    p_operation,
    v_actor,
    v_reason,
    v_key,
    v_request_payload,
    v_request_hash,
    v_expected_hash,
    v_state_hash,
    clock_timestamp(),
    jsonb_build_object('kind', 'CURRENT_PROFIT_SNAPSHOT', 'rows', v_before),
    v_before,
    v_result
  );

  FOREACH v_building_id IN ARRAY v_building_ids
  LOOP
    SELECT *
    INTO STRICT v_pm
    FROM public.profit_monthly pm
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = p_period_month
      AND pm.building_id = v_building_id
    FOR UPDATE;

    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', pa.id,
        'shareholder_id', pa.shareholder_id,
        'percent', pa.percent,
        'amount', pa.amount,
        'created_at', pa.created_at
      ) ORDER BY pa.shareholder_id, pa.id
    ), '[]'::jsonb)
    INTO v_shareholder_allocations
    FROM public.profit_allocations pa
    WHERE pa.profit_monthly_id = v_pm.id;

    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', pma.id,
        'manager_id', pma.manager_id,
        'amount', pma.amount,
        'created_at', pma.created_at
      ) ORDER BY pma.manager_id, pma.id
    ), '[]'::jsonb)
    INTO v_manager_allocations
    FROM public.profit_manager_allocations pma
    WHERE pma.profit_monthly_id = v_pm.id;

    v_previous_snapshot := jsonb_build_object(
      'profit_monthly', to_jsonb(v_pm),
      'shareholder_allocations', v_shareholder_allocations,
      'manager_allocations', v_manager_allocations
    );

    SELECT COALESCE(max(r.revision_number), 0) + 1
    INTO v_revision
    FROM public.profit_close_revisions r
    WHERE r.organization_id = p_organization_id
      AND r.building_id = v_building_id
      AND r.period_month = p_period_month;

    DELETE FROM public.profit_allocations
    WHERE profit_monthly_id = v_pm.id;
    DELETE FROM public.profit_manager_allocations
    WHERE profit_monthly_id = v_pm.id;

    IF p_operation = 'RESET' THEN
      DELETE FROM public.profit_monthly WHERE id = v_pm.id;
      v_current_snapshot := NULL;
    ELSE
      UPDATE public.profit_monthly
      SET status = 'DRAFT',
          management_salary = 0,
          locked_at = NULL,
          locked_by = NULL,
          is_stale = true,
          stale_reason = left('UNLOCKED: ' || v_reason, 1000),
          revision_number = v_revision
      WHERE id = v_pm.id;

      SELECT jsonb_build_object(
        'profit_monthly', to_jsonb(pm),
        'shareholder_allocations', '[]'::jsonb,
        'manager_allocations', '[]'::jsonb
      )
      INTO v_current_snapshot
      FROM public.profit_monthly pm
      WHERE pm.id = v_pm.id;
    END IF;

    INSERT INTO public.profit_close_revisions (
      run_id, organization_id, profit_monthly_id, building_id, period_month,
      revision_number, operation, actor_id, reason, source_hash,
      source_captured_at, source_snapshot, shareholder_allocations,
      manager_allocations, previous_snapshot, current_snapshot
    ) VALUES (
      v_run_id,
      p_organization_id,
      v_pm.id,
      v_building_id,
      p_period_month,
      v_revision,
      p_operation,
      v_actor,
      v_reason,
      v_pm.source_hash,
      v_pm.source_captured_at,
      jsonb_build_object(
        'source_revenue', v_pm.source_revenue,
        'source_expense', v_pm.source_expense,
        'source_net_profit', v_pm.source_net_profit,
        'source_hash', v_pm.source_hash,
        'source_captured_at', v_pm.source_captured_at,
        'was_stale', v_pm.is_stale,
        'stale_reason', v_pm.stale_reason
      ),
      v_shareholder_allocations,
      v_manager_allocations,
      v_previous_snapshot,
      v_current_snapshot
    );
  END LOOP;

  RETURN v_result;
END
$function$;
REVOKE ALL ON FUNCTION public._profit_state_change_v2(text,uuid,date,text,text,uuid[],text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._profit_state_change_v2(text,uuid,date,text,text,uuid[],text) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._profit_state_change_v2(text,uuid,date,text,text,uuid[],text) TO service_role;

-- public._profit_write_close_v2_base(text,uuid,date,text,text,text,uuid[],jsonb): 1 chỗ ném
CREATE OR REPLACE FUNCTION public._profit_write_close_v2_base(p_operation text, p_organization_id uuid, p_period_month date, p_expected_source_hash text, p_reason text, p_idempotency_key text, p_building_ids uuid[], p_adjustments jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_expected_hash text := lower(btrim(COALESCE(p_expected_source_hash, '')));
  v_building_ids uuid[] := p_building_ids;   -- TAP GHI
  v_scope_ids uuid[];                        -- TAP TINH (ca thang)
  v_group_error text;
  v_written jsonb;
  v_written_totals jsonb;
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_run public.profit_close_runs%ROWTYPE;
  v_preview jsonb;
  v_result jsonb;
  v_allocation_snapshot jsonb;
  v_run_id uuid := gen_random_uuid();
  v_row jsonb;
  v_building_id uuid;
  v_owner_user_id uuid;
  v_pm_id uuid;
  v_revision bigint;
  v_existing_pm public.profit_monthly%ROWTYPE;
  v_has_existing boolean;
  v_previous_snapshot jsonb;
  v_current_snapshot jsonb;
  v_old_shareholder_allocations jsonb;
  v_old_manager_allocations jsonb;
  v_source_snapshot jsonb;
BEGIN
  IF p_operation NOT IN ('CLOSE', 'RECLOSE') THEN
    RAISE EXCEPTION 'Invalid close operation' USING ERRCODE = '22023';
  END IF;
  IF p_period_month IS NULL
     OR p_period_month <> date_trunc('month', p_period_month)::date THEN
    RAISE EXCEPTION 'period_month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;
  IF p_operation = 'CLOSE' AND v_reason = '' THEN
    v_reason := 'Initial monthly profit close';
  END IF;
  IF char_length(v_reason) NOT BETWEEN 8 AND 1000 THEN
    RAISE EXCEPTION 'reason must contain 8..1000 characters'
      USING ERRCODE = '22023';
  END IF;
  IF char_length(v_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'idempotency_key must contain 8..200 characters'
      USING ERRCODE = '22023';
  END IF;
  IF v_expected_hash !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'expected_source_hash must be a 32-character lowercase MD5'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public._profit_assert_authorized_v2(
    p_organization_id, 'shareholder_profit.lock'
  );

  v_request_payload := jsonb_build_object(
    'operation', p_operation,
    'organization_id', p_organization_id,
    'period_month', p_period_month,
    'expected_source_hash', v_expected_hash,
    'reason', v_reason,
    'building_ids', to_jsonb(p_building_ids),
    'adjustments', COALESCE(p_adjustments, '[]'::jsonb)
  );
  v_request_hash := md5(v_request_payload::text);

  PERFORM pg_advisory_xact_lock(
    hashtext(p_organization_id::text), hashtext('profit-key:' || v_key)
  );

  SELECT *
  INTO v_existing_run
  FROM public.profit_close_runs r
  WHERE r.organization_id = p_organization_id
    AND r.idempotency_key = v_key;
  IF FOUND THEN
    IF v_existing_run.operation <> p_operation
       OR v_existing_run.period_month <> p_period_month
       OR v_existing_run.request_hash <> v_request_hash THEN
      RAISE EXCEPTION 'Idempotency key was already used with a different request'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing_run.result_snapshot
      || jsonb_build_object('idempotent_replay', true);
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(p_organization_id::text), hashtext(p_period_month::text)
  );

  -- DOI -> (1) Pham vi TINH luon la moi nha that dang hoat dong cua to chuc.
  SELECT array_agg(b.id ORDER BY b.id)
  INTO v_scope_ids
  FROM public.buildings b
  WHERE b.organization_id = p_organization_id
    AND b.deleted_at IS NULL
    AND b.is_virtual = false;

  IF v_scope_ids IS NULL OR cardinality(v_scope_ids) = 0 THEN
    RAISE EXCEPTION 'No real buildings are available for %', p_operation
      USING ERRCODE = '22023';
  END IF;

  IF v_building_ids IS NULL THEN
    IF p_operation = 'CLOSE' THEN
      v_building_ids := v_scope_ids;
    ELSE
      SELECT array_agg(pm.building_id ORDER BY pm.building_id)
      INTO v_building_ids
      FROM public.profit_monthly pm
      JOIN public.buildings b ON b.id = pm.building_id
      WHERE pm.organization_id = p_organization_id
        AND pm.period_month = p_period_month
        AND pm.status = 'LOCKED'
        AND b.deleted_at IS NULL
        AND b.is_virtual = false;
    END IF;
  END IF;

  IF v_building_ids IS NULL OR cardinality(v_building_ids) = 0 THEN
    RAISE EXCEPTION 'No real buildings are available for %', p_operation
      USING ERRCODE = '22023';
  END IF;
  IF array_position(v_building_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'building_ids cannot contain NULL' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM unnest(v_building_ids) x)
     <> (SELECT count(DISTINCT x) FROM unnest(v_building_ids) x) THEN
    RAISE EXCEPTION 'building_ids contains duplicates' USING ERRCODE = '22023';
  END IF;

  -- DOI -> (2) Guard toan-phu cu duoc thay bang hai guard hep hon.
  --   2a. Tap ghi phai la tap con cua nha that dang hoat dong.
  IF EXISTS (
    SELECT 1
    FROM unnest(v_building_ids) bid
    WHERE NOT (bid = ANY(v_scope_ids))
  ) THEN
    RAISE EXCEPTION
      'CLOSE/RECLOSE only accepts active real buildings of the organization'
      USING ERRCODE = '22023';
  END IF;

  --   2b. Tap ghi phai DONG theo tung quy tac luong TOTAL_GROUP. Day la thu that
  --       su giu cho con so khong lech: chot nua nhom thi khoan luong cua ca
  --       nhom bi don sai vao phan nha da chot.
  SELECT format(
           '[TOTAL_GROUP_KHONG_DU] Lương điều hành "%s" chia theo lợi nhuận của cả nhóm nhà nên phải chốt cùng lúc. Còn thiếu: %s.',
           g.rule_label, g.missing_names
         )
  INTO v_group_error
  FROM (
    SELECT
      COALESCE(NULLIF(btrim(s.label), ''), m.name) AS rule_label,
      string_agg(b.name, ', ')
        FILTER (WHERE NOT (rb.building_id = ANY(v_building_ids))) AS missing_names,
      count(*) FILTER (WHERE rb.building_id = ANY(v_building_ids)) AS picked,
      count(*) FILTER (WHERE NOT (rb.building_id = ANY(v_building_ids))) AS missing
    FROM public.profit_manager_salaries s
    JOIN public.profit_managers m
      ON m.id = s.manager_id
     AND m.organization_id = p_organization_id
     AND m.is_active
     AND m.deleted_at IS NULL
    JOIN public.profit_manager_salary_buildings rb
      ON rb.salary_id = s.id
     AND rb.organization_id = p_organization_id
    JOIN public.buildings b
      ON b.id = rb.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.is_virtual = false
    WHERE s.organization_id = p_organization_id
      AND s.is_active
      AND s.basis = 'TOTAL_GROUP'
    GROUP BY s.id, s.label, m.name
    HAVING count(*) FILTER (WHERE rb.building_id = ANY(v_building_ids)) > 0
       AND count(*) FILTER (WHERE NOT (rb.building_id = ANY(v_building_ids))) > 0
  ) g
  LIMIT 1;

  IF v_group_error IS NOT NULL THEN
    RAISE EXCEPTION '%', v_group_error USING ERRCODE = '22023';
  END IF;

  -- DOI -> (3) Guard legacy chi con soi snapshot nam tren nha AO / DA XOA / mo
  --       coi. Ban cu bao loi khi co BAT KY snapshot nao ngoai tap truyen vao —
  --       voi chot le thi cac nha da chot truoc do luon nam ngoai tap, nen ban
  --       cu se chan dung cai viec ma migration nay muon mo.
  IF EXISTS (
    SELECT 1
    FROM public.profit_monthly pm
    LEFT JOIN public.buildings b ON b.id = pm.building_id
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = p_period_month
      AND (
        b.id IS NULL
        OR b.is_virtual
        OR b.deleted_at IS NOT NULL
        OR b.organization_id IS DISTINCT FROM p_organization_id
      )
  ) THEN
    RAISE EXCEPTION
      'Period contains legacy virtual/deleted-building snapshots; run profit_reset_v2 before closing'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profit_monthly pm
    WHERE pm.building_id = ANY(v_building_ids)
      AND pm.period_month = p_period_month
      AND pm.organization_id IS DISTINCT FROM p_organization_id
  ) THEN
    RAISE EXCEPTION 'A current snapshot has an invalid organization boundary'
      USING ERRCODE = '55000';
  END IF;

  IF p_operation = 'CLOSE' AND EXISTS (
    SELECT 1
    FROM public.profit_monthly pm
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = p_period_month
      AND pm.building_id = ANY(v_building_ids)
      AND pm.status = 'LOCKED'
  ) THEN
    RAISE EXCEPTION 'One or more buildings are already closed; use profit_reclose_v2'
      USING ERRCODE = '55000';
  END IF;

  IF p_operation = 'RECLOSE' AND (
    SELECT count(*)
    FROM public.profit_monthly pm
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = p_period_month
      AND pm.building_id = ANY(v_building_ids)
      AND pm.status = 'LOCKED'
  ) <> cardinality(v_building_ids) THEN
    RAISE EXCEPTION 'RECLOSE requires an existing LOCKED snapshot for every building'
      USING ERRCODE = '55000';
  END IF;

  -- DOI -> (4) Preview chay tren TAP TINH (ca thang), khong phai tap ghi. Nho
  --       vay `source_hash` ma CAS kiem dung bang hash giao dien lay tu preview
  --       toan thang, `building_source_hash` giu nguyen cong thuc cu, va luong
  --       TOTAL_GROUP luon chia tren du nhom nha.
  v_preview := public._profit_close_preview_core_v2(
    p_organization_id,
    p_period_month,
    v_scope_ids,
    COALESCE(p_adjustments, '[]'::jsonb),
    'shareholder_profit.lock',
    true
  );

  IF v_preview->>'source_hash' <> v_expected_hash THEN
    RAISE EXCEPTION
      'PROFIT_SOURCE_CONFLICT expected %, current %',
      v_expected_hash, v_preview->>'source_hash'
      USING ERRCODE = 'PT409';
  END IF;

  SELECT COALESCE(jsonb_agg(x.value ORDER BY x.value->>'building_id'), '[]'::jsonb)
  INTO v_written
  FROM jsonb_array_elements(v_preview->'buildings') x(value)
  WHERE (x.value->>'building_id')::uuid = ANY(v_building_ids);

  IF jsonb_array_length(v_written) <> cardinality(v_building_ids) THEN
    RAISE EXCEPTION 'Preview did not cover every requested building'
      USING ERRCODE = '55000';
  END IF;

  SELECT jsonb_build_object(
    'source_revenue', COALESCE(sum((x.value->>'source_revenue')::numeric), 0),
    'source_expense', COALESCE(sum((x.value->>'source_expense')::numeric), 0),
    'computed_profit', COALESCE(sum((x.value->>'computed_profit')::numeric), 0),
    'adjustment_amount', COALESCE(sum((x.value->>'adjustment_amount')::numeric), 0),
    'adjusted_profit', COALESCE(sum((x.value->>'adjusted_profit')::numeric), 0),
    'management_salary', COALESCE(sum((x.value->>'management_salary')::numeric), 0),
    'distributable_profit', COALESCE(sum((x.value->>'distributable_profit')::numeric), 0),
    'shareholder_allocated_amount',
      COALESCE(sum((x.value->>'shareholder_allocated_amount')::numeric), 0),
    'unallocated_profit', COALESCE(sum((x.value->>'unallocated_profit')::numeric), 0)
  )
  INTO v_written_totals
  FROM jsonb_array_elements(v_written) x(value);

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'building_id', x.value->>'building_id',
      'shareholder_allocations', x.value->'shareholder_allocations',
      'manager_allocations', x.value->'manager_allocations'
    ) ORDER BY x.value->>'building_id'
  ), '[]'::jsonb)
  INTO v_allocation_snapshot
  FROM jsonb_array_elements(v_written) x(value);

  -- `source_snapshot` co y giu TOAN THANG: no la tai lieu nguon da bam ra
  -- `source_hash`, va `current_profit_building_source_hash_v1` dung lai hash tu
  -- `run.source_snapshot->'pnl'`. `buildings`/`totals` moi la phan "da ghi".
  v_result := v_preview || jsonb_build_object(
    'buildings', v_written,
    'totals', v_written_totals,
    'scope_building_ids', to_jsonb(v_scope_ids),
    'written_building_ids', to_jsonb(v_building_ids),
    'run_id', v_run_id,
    'operation', p_operation,
    'affected_buildings', cardinality(v_building_ids),
    'idempotent_replay', false
  );

  INSERT INTO public.profit_close_runs (
    id, organization_id, period_month, operation, actor_id, reason,
    idempotency_key, request_payload, request_hash, expected_source_hash,
    source_hash, source_captured_at, source_snapshot, allocation_snapshot,
    result_snapshot
  ) VALUES (
    v_run_id,
    p_organization_id,
    p_period_month,
    p_operation,
    v_actor,
    v_reason,
    v_key,
    v_request_payload,
    v_request_hash,
    v_expected_hash,
    v_preview->>'source_hash',
    (v_preview->>'source_captured_at')::timestamptz,
    v_preview->'source_snapshot',
    v_allocation_snapshot,
    v_result
  );

  FOR v_row IN
    SELECT value
    FROM jsonb_array_elements(v_written) x(value)
    ORDER BY value->>'building_id'
  LOOP
    v_building_id := (v_row->>'building_id')::uuid;

    SELECT b.user_id
    INTO v_owner_user_id
    FROM public.buildings b
    WHERE b.id = v_building_id
      AND b.organization_id = p_organization_id;

    SELECT *
    INTO v_existing_pm
    FROM public.profit_monthly pm
    WHERE pm.building_id = v_building_id
      AND pm.period_month = p_period_month
    FOR UPDATE;
    v_has_existing := FOUND;

    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', pa.id,
        'shareholder_id', pa.shareholder_id,
        'percent', pa.percent,
        'amount', pa.amount,
        'created_at', pa.created_at
      ) ORDER BY pa.shareholder_id, pa.id
    ), '[]'::jsonb)
    INTO v_old_shareholder_allocations
    FROM public.profit_allocations pa
    WHERE v_has_existing AND pa.profit_monthly_id = v_existing_pm.id;

    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', pma.id,
        'manager_id', pma.manager_id,
        'amount', pma.amount,
        'created_at', pma.created_at
      ) ORDER BY pma.manager_id, pma.id
    ), '[]'::jsonb)
    INTO v_old_manager_allocations
    FROM public.profit_manager_allocations pma
    WHERE v_has_existing AND pma.profit_monthly_id = v_existing_pm.id;

    v_previous_snapshot := CASE WHEN v_has_existing THEN
      jsonb_build_object(
        'profit_monthly', to_jsonb(v_existing_pm),
        'shareholder_allocations', v_old_shareholder_allocations,
        'manager_allocations', v_old_manager_allocations
      )
      ELSE NULL
    END;

    SELECT COALESCE(max(r.revision_number), 0) + 1
    INTO v_revision
    FROM public.profit_close_revisions r
    WHERE r.organization_id = p_organization_id
      AND r.building_id = v_building_id
      AND r.period_month = p_period_month;

    v_pm_id := CASE WHEN v_has_existing THEN v_existing_pm.id ELSE gen_random_uuid() END;

    INSERT INTO public.profit_monthly AS pm (
      id, user_id, building_id, period_month, computed_profit,
      adjustment_amount, adjustment_reason, adjustment_by, adjustment_at,
      adjusted_profit, management_salary, status, locked_at, locked_by,
      organization_id, source_revenue, source_expense, source_net_profit,
      source_hash, source_captured_at, is_stale, stale_reason,
      revision_number
    ) VALUES (
      v_pm_id,
      v_owner_user_id,
      v_building_id,
      p_period_month,
      (v_row->>'computed_profit')::numeric,
      (v_row->>'adjustment_amount')::numeric,
      NULLIF(btrim(v_row->>'adjustment_reason'), ''),
      CASE WHEN (v_row->>'adjustment_amount')::numeric <> 0 THEN v_actor END,
      CASE WHEN (v_row->>'adjustment_amount')::numeric <> 0
           THEN (v_preview->>'source_captured_at')::timestamptz END,
      (v_row->>'adjusted_profit')::numeric,
      (v_row->>'management_salary')::numeric,
      'LOCKED',
      (v_preview->>'source_captured_at')::timestamptz,
      v_actor,
      p_organization_id,
      (v_row->>'source_revenue')::numeric,
      (v_row->>'source_expense')::numeric,
      (v_row->>'computed_profit')::numeric,
      v_row->>'building_source_hash',
      (v_preview->>'source_captured_at')::timestamptz,
      false,
      NULL,
      v_revision
    )
    ON CONFLICT (building_id, period_month) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          computed_profit = EXCLUDED.computed_profit,
          adjustment_amount = EXCLUDED.adjustment_amount,
          adjustment_reason = EXCLUDED.adjustment_reason,
          adjustment_by = EXCLUDED.adjustment_by,
          adjustment_at = EXCLUDED.adjustment_at,
          adjusted_profit = EXCLUDED.adjusted_profit,
          management_salary = EXCLUDED.management_salary,
          status = 'LOCKED',
          locked_at = EXCLUDED.locked_at,
          locked_by = EXCLUDED.locked_by,
          organization_id = EXCLUDED.organization_id,
          source_revenue = EXCLUDED.source_revenue,
          source_expense = EXCLUDED.source_expense,
          source_net_profit = EXCLUDED.source_net_profit,
          source_hash = EXCLUDED.source_hash,
          source_captured_at = EXCLUDED.source_captured_at,
          is_stale = false,
          stale_reason = NULL,
          revision_number = EXCLUDED.revision_number
    RETURNING pm.id INTO v_pm_id;

    DELETE FROM public.profit_allocations
    WHERE profit_monthly_id = v_pm_id;
    DELETE FROM public.profit_manager_allocations
    WHERE profit_monthly_id = v_pm_id;

    INSERT INTO public.profit_allocations (
      user_id, profit_monthly_id, shareholder_id, percent, amount,
      organization_id
    )
    SELECT
      v_owner_user_id,
      v_pm_id,
      x.shareholder_id,
      x.percent,
      x.amount,
      p_organization_id
    FROM jsonb_to_recordset(v_row->'shareholder_allocations')
      AS x(shareholder_id uuid, shareholder_name text, percent numeric, amount numeric);

    INSERT INTO public.profit_manager_allocations (
      user_id, profit_monthly_id, manager_id, amount, organization_id
    )
    SELECT
      v_owner_user_id,
      v_pm_id,
      x.manager_id,
      x.amount,
      p_organization_id
    FROM jsonb_to_recordset(v_row->'manager_allocations')
      AS x(manager_id uuid, manager_name text, amount numeric)
    WHERE x.amount <> 0;

    SELECT jsonb_build_object(
      'profit_monthly', to_jsonb(pm),
      'shareholder_allocations', v_row->'shareholder_allocations',
      'manager_allocations', v_row->'manager_allocations'
    )
    INTO v_current_snapshot
    FROM public.profit_monthly pm
    WHERE pm.id = v_pm_id;

    SELECT jsonb_build_object(
      'algorithm_version', v_preview->>'algorithm_version',
      'preview_source_hash', v_preview->>'source_hash',
      'building_source_hash', v_row->>'building_source_hash',
      'source_captured_at', v_preview->'source_captured_at',
      'pnl', COALESCE((
        SELECT x.value
        FROM jsonb_array_elements(v_preview->'source_snapshot'->'pnl') x(value)
        WHERE x.value->>'building_id' = v_building_id::text
        LIMIT 1
      ), '{}'::jsonb),
      'accrual_lines', COALESCE((
        SELECT jsonb_agg(x.value)
        FROM jsonb_array_elements(
          v_preview->'source_snapshot'->'accrual_lines'
        ) x(value)
        WHERE x.value->>'building_id' = v_building_id::text
      ), '[]'::jsonb)
    )
    INTO v_source_snapshot;

    INSERT INTO public.profit_close_revisions (
      run_id, organization_id, profit_monthly_id, building_id, period_month,
      revision_number, operation, actor_id, reason, source_hash,
      source_captured_at, source_snapshot, shareholder_allocations,
      manager_allocations, previous_snapshot, current_snapshot
    ) VALUES (
      v_run_id,
      p_organization_id,
      v_pm_id,
      v_building_id,
      p_period_month,
      v_revision,
      p_operation,
      v_actor,
      v_reason,
      v_row->>'building_source_hash',
      (v_preview->>'source_captured_at')::timestamptz,
      v_source_snapshot,
      v_row->'shareholder_allocations',
      v_row->'manager_allocations',
      v_previous_snapshot,
      v_current_snapshot
    );
  END LOOP;

  RETURN v_result;
END
$function$;
REVOKE ALL ON FUNCTION public._profit_write_close_v2_base(text,uuid,date,text,text,text,uuid[],jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._profit_write_close_v2_base(text,uuid,date,text,text,text,uuid[],jsonb) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._profit_write_close_v2_base(text,uuid,date,text,text,text,uuid[],jsonb) TO service_role;

-- public.confirm_cashbook_closing_v1(uuid,numeric): 1 chỗ ném
CREATE OR REPLACE FUNCTION public.confirm_cashbook_closing_v1(p_request uuid, p_counted_balance numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  r app_private.cashbook_closure_requests%ROWTYPE;
  v_membership uuid;
  v_system numeric;
  v_blockers text;
  v_closure bigint;
  v_after numeric;
  v_diff numeric;
  v_type uuid;
  v_bld uuid;
  v_adj uuid;
  -- WP2_PROXY_SIGNATURE
  v_on_behalf boolean := false;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;

  SELECT * INTO r FROM app_private.cashbook_closure_requests
   WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy đề nghị' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Đề nghị này đã % rồi', lower(r.status) USING ERRCODE = '23505';
  END IF;

  IF v_actor = r.proposed_by THEN
    RAISE EXCEPTION 'Người đề nghị không tự xác nhận được — phải là người nhận bàn giao.'
      USING ERRCODE = '42501';
  END IF;
  IF v_actor <> r.confirmer_user_id AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Đề nghị này được gửi cho người khác xác nhận' USING ERRCODE = '42501';
  END IF;
  -- Tới đây, ký-khác-người-được-chỉ-định chỉ còn một khả năng: super admin.
  v_on_behalf := (v_actor <> r.confirmer_user_id);

  PERFORM 1 FROM public.accounts a WHERE a.id = r.cashbook_id FOR UPDATE;
  PERFORM app_private.lock_org_for_decision_v1(r.organization_id);

  SELECT m.id INTO v_membership FROM public.organization_memberships m
   WHERE m.user_id = v_actor AND m.organization_id = r.organization_id AND m.status = 'ACTIVE' LIMIT 1;

  IF NOT public.is_super_admin()
     AND NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
       v_actor, r.organization_id, 'cashbooks.close_confirm', NULL, r.cashbook_id)), false) THEN
    RAISE EXCEPTION 'Không có quyền xác nhận nhận bàn giao' USING ERRCODE = '42501';
  END IF;

  -- Chạy lại blockers, fail cứng. Loại hai mã vô nghĩa ở phía người ký:
  -- CLOSURE_PENDING chính là cái sắp ký; NO_CONFIRMER đếm người KHÁC người đang
  -- hỏi nên người ký duy nhất sẽ tự chặn chính mình.
  SELECT string_agg(b.detail, ' | ') INTO v_blockers
  FROM public.cashbook_closing_blockers_v1(r.cashbook_id) b
  WHERE b.blocking AND b.code NOT IN ('CLOSURE_PENDING', 'NO_CONFIRMER');
  IF v_blockers IS NOT NULL THEN
    RAISE EXCEPTION 'Không xác nhận được, sổ đã đổi kể từ lúc đề nghị: %', v_blockers
      USING ERRCODE = '55000';
  END IF;

  v_system := round(app_private.cashbook_balance_as_of_v1(r.cashbook_id, r.closed_through), 2);
  IF v_system <> r.system_balance THEN
    RAISE EXCEPTION
      'Số dư hệ thống đã đổi từ % thành % kể từ lúc đề nghị — huỷ đề nghị và đếm lại.',
      r.system_balance, v_system USING ERRCODE = 'PT409';
  END IF;
  IF p_counted_balance IS NULL OR p_counted_balance = 'NaN'::numeric
     OR round(p_counted_balance, 2) <> r.counted_balance THEN
    RAISE EXCEPTION
      'Số tiền bạn đếm (%) khác số người giao khai (%) — hai bên phải đếm lại cùng nhau.',
      round(COALESCE(p_counted_balance, 0), 2), r.counted_balance USING ERRCODE = '22023';
  END IF;

  -- ── PHIẾU CHÊNH LỆCH (plan Đợt 6) ────────────────────────────────
  -- Đếm được nhiều hơn sổ ⇒ THỪA quỹ ⇒ phiếu THU. Ít hơn ⇒ THIẾU ⇒ phiếu CHI.
  -- Ngoài KQKD để không đụng vào số đã chia cho cổ đông.
  -- Lập TRƯỚC khi ghi biên bản: lúc này kỳ chưa đóng nên trigger khoá cho qua.
  v_diff := round(r.counted_balance - v_system, 2);
  IF v_diff <> 0 THEN
    SELECT a.quick_default_building_id INTO v_bld FROM public.accounts a WHERE a.id = r.cashbook_id;
    IF v_bld IS NULL THEN
      SELECT b.id INTO v_bld FROM public.buildings b
       WHERE b.organization_id = r.organization_id AND b.deleted_at IS NULL
       ORDER BY b.created_at LIMIT 1;
    END IF;
    IF v_bld IS NULL THEN
      RAISE EXCEPTION 'Không tìm được toà để ghi phiếu chênh lệch — không chốt được sổ lệch.'
        USING ERRCODE = '55000';
    END IF;

    v_type := app_private.ensure_cash_diff_type_v1(
      r.organization_id, CASE WHEN v_diff > 0 THEN 'income' ELSE 'expense' END);

    INSERT INTO public.income_expenses
      (user_id, organization_id, type, name, building_id, account_id, voucher_date,
       total_amount, approval_status, approved_by, approved_at,
       business_result_accounting, creator_name, system_source, notes)
    VALUES
      (v_actor, r.organization_id,
       CASE WHEN v_diff > 0 THEN 'INCOME' ELSE 'EXPENSE' END,
       CASE WHEN v_diff > 0 THEN 'Thừa quỹ khi chốt sổ' ELSE 'Thiếu quỹ khi chốt sổ' END,
       v_bld, r.cashbook_id, r.closed_through, abs(v_diff), 'APPROVED', v_actor, clock_timestamp(),
       false, 'Chốt sổ & bàn giao quỹ', 'cashbook.closing.diff',
       'Chênh lệch kiểm quỹ khi chốt & bàn giao (đếm ' || r.counted_balance ||
       ' / sổ ' || v_system || ').')
    RETURNING id INTO v_adj;

    INSERT INTO public.income_expense_items
      (income_expense_id, organization_id, income_expense_type_id, description,
       quantity, unit_price, amount, start_date, end_date)
    VALUES (v_adj, r.organization_id, v_type,
            CASE WHEN v_diff > 0 THEN 'Thừa quỹ khi chốt sổ' ELSE 'Thiếu quỹ khi chốt sổ' END,
            1, abs(v_diff), abs(v_diff), r.closed_through, r.closed_through);
  END IF;

  -- HẬU ĐIỀU KIỆN: số dư as-of PHẢI đúng bằng số hai bên đã đếm và ký.
  v_after := round(app_private.cashbook_balance_as_of_v1(r.cashbook_id, r.closed_through), 2);
  IF v_after <> r.counted_balance THEN
    RAISE EXCEPTION
      'Sau khi lập phiếu chênh lệch, số dư sổ (%) vẫn khác số đã đếm (%) — DỪNG, không đóng băng con số sai.',
      v_after, r.counted_balance USING ERRCODE = '55000';
  END IF;

  INSERT INTO app_private.cashbook_closures
    (organization_id, cashbook_id, closed_through, counted_balance, system_balance,
     basis, proposed_by, confirmed_by,
     signed_by_super_admin, designated_confirmer, signer_note)
  VALUES
    (r.organization_id, r.cashbook_id, r.closed_through, r.counted_balance, v_system,
     r.basis, r.proposed_by, v_actor,
     v_on_behalf, r.confirmer_user_id,
     CASE WHEN v_on_behalf THEN format(
       'KÝ THAY BỞI SUPER ADMIN — người được chỉ định nhận bàn giao (%s) KHÔNG ký biên bản này.',
       r.confirmer_user_id) END)
  RETURNING id INTO v_closure;

  UPDATE app_private.cashbook_closure_requests
     SET status = 'CONFIRMED', confirmed_by = v_actor, confirmed_at = now(),
         closure_id = v_closure
   WHERE id = p_request;

  IF app_private.cashbook_closed_through_v1(r.cashbook_id) IS DISTINCT FROM r.closed_through
     AND app_private.cashbook_closed_through_v1(r.cashbook_id) < r.closed_through THEN
    RAISE EXCEPTION 'Ghi biên bản xong nhưng kỳ chưa đóng — dừng lại' USING ERRCODE = '55000';
  END IF;

  UPDATE public.accounts
     SET lock_date = GREATEST(COALESCE(lock_date, r.closed_through), r.closed_through)
   WHERE id = r.cashbook_id;

  RETURN jsonb_build_object(
    'request_id', p_request,
    'closure_id', v_closure,
    'cashbook_id', r.cashbook_id,
    'closed_through', r.closed_through,
    'counted_balance', r.counted_balance,
    'system_balance', v_system,
    'difference', v_diff,
    'difference_voucher_id', v_adj,
    'basis', r.basis,
    'signed_by_super_admin', v_on_behalf,
    'designated_confirmer', r.confirmer_user_id,
    'status', 'CONFIRMED'
  );
END
$function$;
REVOKE ALL ON FUNCTION public.confirm_cashbook_closing_v1(uuid,numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_cashbook_closing_v1(uuid,numeric) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.confirm_cashbook_closing_v1(uuid,numeric) TO authenticated;

-- public.copilot_plan_approve_v1(uuid,text,text,integer,text): 2 chỗ ném
CREATE OR REPLACE FUNCTION public.copilot_plan_approve_v1(p_plan_id uuid, p_consent_nonce text, p_plan_digest text, p_expected_plan_version integer, p_step_up_token text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private', 'extensions'
AS $function$
DECLARE
  v_actor      uuid := auth.uid();
  v_conf       app_private.copilot_write_confirmations%ROWTYPE;
  v_plan       app_private.copilot_plans%ROWTYPE;
  v_reg        app_private.copilot_action_registry%ROWTYPE;
  v_step       app_private.copilot_plan_steps%ROWTYPE;
  v_max_direct text;
  v_policy_rev bigint;
  v_ly_do      text := NULL;
  v_chi_tiet   text := NULL;
  v_buoc_hong  int := NULL;
  v_version    int;
  v_han        timestamptz;
  -- G5-A: hàng token step-up (nếu client trình) và id của nó sau khi tiêu.
  v_step_up    app_private.copilot_write_confirmations%ROWTYPE;
  v_step_up_id uuid := NULL;
  -- G5-E ca 6: MỘT biến cho loại đồng ý. Hàng `copilot_plans`, dòng sổ và vỏ trả về
  -- đều đọc chính biến này. Trước đợt này biểu thức CASE bị chép BỐN lần (hai vào
  -- hàng, hai vào sổ) còn ba vỏ trả về thì không có gì — nên client nhận `undefined`.
  v_consent_kind text := NULL;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- Hình sai thì không cần chạm bảng nonce: một lời gọi không có nonce thật
  -- không được phép soi cả bảng đó.
  IF p_consent_nonce IS NULL OR p_consent_nonce !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'confirmation_required' USING ERRCODE = '42501';
  END IF;
  IF p_plan_digest IS NULL OR p_plan_digest !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'plan_digest_mismatch' USING ERRCODE = '22023';
  END IF;

  -- Khoá hàng nonce ngay từ đầu: hai lần bấm song song phải có đúng một lần thắng.
  SELECT * INTO v_conf
    FROM app_private.copilot_write_confirmations c
   WHERE c.nonce_digest = extensions.digest(decode(p_consent_nonce, 'hex'), 'sha256')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  -- Nonce của người khác trả về cùng một câu với "không tìm thấy" — trả lời khác
  -- đi là xác nhận giúp kẻ gọi rằng nonce đó có thật.
  IF v_conf.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'confirmation_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_conf.tool IS DISTINCT FROM 'lap_ke_hoach'
     OR v_conf.permission_key IS DISTINCT FROM 'copilot.execution_plan' THEN
    RAISE EXCEPTION 'confirmation_contract_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_conf.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;

  BEGIN
    SELECT * INTO v_plan
      FROM app_private.copilot_plans p
     WHERE p.id = p_plan_id AND p.user_id = v_actor
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    -- Hai tab. Không chờ: một trong hai đang ở giữa một chuỗi ghi tiền.
    RAISE EXCEPTION 'plan_busy' USING ERRCODE = '55P03';
  END;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_plan.organization_id IS DISTINCT FROM v_conf.organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;
  -- Ba vế phải trùng nhau: vân tay lưu trong kế hoạch, `payload_hash` của hàng
  -- nonce, và chuỗi giao diện echo lại. Lệch một vế nghĩa là thứ người dùng nhìn
  -- thấy không phải thứ sắp chạy.
  IF v_plan.plan_digest IS DISTINCT FROM decode(p_plan_digest, 'hex')
     OR v_conf.payload_hash IS DISTINCT FROM v_plan.plan_digest THEN
    RAISE EXCEPTION 'plan_digest_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_plan.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'plan_not_draft: dang o %', v_plan.status USING ERRCODE = '22023';
  END IF;
  IF p_expected_plan_version IS NULL OR v_plan.version <> p_expected_plan_version THEN
    RAISE EXCEPTION 'plan_version_stale: dang o %, nguoi goi mong %',
      v_plan.version, p_expected_plan_version
      USING ERRCODE = 'PT409';
  END IF;

  -- QUÁ HẠN. Ghi trạng thái rồi TRẢ VỀ, không RAISE — xem quyết định 4 ở đầu file.
  IF v_plan.expires_at <= clock_timestamp() THEN
    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED', error_code = 'plan_expired'
     WHERE plan_id = v_plan.id AND status = 'PENDING';
    UPDATE app_private.copilot_plans
       SET status = 'EXPIRED', version = version + 1,
           failure_reason = 'plan_expired', updated_at = clock_timestamp()
     WHERE id = v_plan.id
    RETURNING version INTO v_version;
    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'plan_expired',
      'organization_id', v_plan.organization_id,
      'plan_id',         v_plan.id,
      'plan_version',    v_version,
      'permission_key',  'copilot.execution_plan',
      'consent_id',      v_plan.consent_confirmation_id,
      'consent_kind',    v_plan.consent_kind,
      'step_up_id',      v_plan.step_up_confirmation_id,
      'error_code',      'plan_expired',
      'outcome',         jsonb_build_object('giai_doan', 'approve')));
    RETURN jsonb_build_object(
      'ok',               false,
      'error_code',       'plan_expired',
      'plan_id',          v_plan.id,
      'plan_version',     v_version,
      'plan_status',      'EXPIRED',
      'consent_kind',     v_plan.consent_kind,
      'execute_deadline', NULL);
  END IF;

  -- Đổi thứ tự: quá hạn của KẾ HOẠCH được kiểm TRƯỚC quá hạn của
  -- CONFIRMATION, để nhánh ghi-rồi-RETURN plan_expired phía trên với tới được.
  -- Trước đợt này cửa nonce (bên trên, cùng khối duyệt) luôn đứng trước cửa kế
  -- hoạch nên plan_expired là mã chết — vì thời điểm tạo gán CÙNG một hạn cho cả
  -- hai hàng. Xem G3-FIX brief mục 1 + task-G3-E2E-report.md §6.
  IF v_conf.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'confirmation_expired' USING ERRCODE = '42501';
  END IF;

  SELECT max_direct_risk, revision INTO v_max_direct, v_policy_rev
    FROM app_private.copilot_action_policy WHERE id;
  -- Thiếu hàng policy KHÔNG được rơi vào im lặng: `v_max_direct` NULL làm điều
  -- kiện step-up ngay dưới lặng lẽ sai, và phép so trần rủi ro trong vòng lặp
  -- cũng thành vô nghĩa. Van trần rủi ro mà biến mất thì đóng cửa, đừng đoán.
  IF v_max_direct IS NULL OR v_policy_rev IS NULL THEN
    RAISE EXCEPTION 'copilot_policy_missing' USING ERRCODE = 'P0002';
  END IF;

  -- ĐIỂM NỐI #3 — step-up PIN (G5-A). Kế hoạch L5 dưới trần L5 mà không có
  -- token → từ chối ngay, không chạm bảng token.
  IF v_plan.max_risk = 'L5' AND v_max_direct = 'L5' AND p_step_up_token IS NULL THEN
    RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
  END IF;
  IF p_step_up_token IS NOT NULL THEN
    -- Hình sai thì không soi bảng — cùng kỷ luật với nonce cấp kế hoạch ở trên.
    IF p_step_up_token !~ '^[0-9a-fA-F]{64}$' THEN
      RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_step_up
      FROM app_private.copilot_write_confirmations c
     WHERE c.nonce_digest = extensions.digest(decode(p_step_up_token, 'hex'), 'sha256')
     FOR UPDATE;

    -- Mọi nhánh sai của token đều trả CÙNG một mã `step_up_required` — token
    -- của người khác, sai tool/permission_key, đã tiêu, hết hạn, hay lệch tổ
    -- chức đều là "chưa xác thực hợp lệ" dưới góc nhìn của người gọi; phân biệt
    -- ra sẽ xác nhận giúp kẻ tấn công token nào "gần đúng".
    IF NOT FOUND
       OR v_step_up.user_id IS DISTINCT FROM v_actor
       OR v_step_up.tool IS DISTINCT FROM 'step_up'
       OR v_step_up.permission_key IS DISTINCT FROM 'copilot.step_up'
       OR v_step_up.consumed_at IS NOT NULL
       OR v_step_up.expires_at <= clock_timestamp()
       OR v_step_up.organization_id IS DISTINCT FROM v_plan.organization_id
       OR v_step_up.payload_hash IS DISTINCT FROM app_private.copilot_payload_hash_v1(
            jsonb_build_object('org', v_plan.organization_id)) THEN
      RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
    END IF;

    -- Fix round 1 (F3): KHONG tieu token o day nua. Tieu no cung mot diem
    -- voi nonce cap ke hoach (nhanh that bai / nhanh thanh cong ben duoi),
    -- de mot lan RAISE cua kill-switch/policy-missing GIUA cho nay va do
    -- khong dot mat token ma khong duyet duoc gi (bug that: ban truoc tieu
    -- token o day, truoc ca kill-switch, nen mot RAISE ngay sau van thieu
    -- token du no chua bao gio thuc su chay).
  END IF;

  -- Công tắc của cả cơ chế, hỏi LẠI. Tắt giữa lúc lập và lúc bấm là chuyện thật
  -- (đó chính là ý nghĩa của một kill switch), và ở đây chưa có gì để ghi lại
  -- nên NÉM là câu trả lời đúng: kế hoạch ở nguyên DRAFT rồi tự hết hạn.
  IF NOT app_private.copilot_action_flag_allows_v1(
           'copilot.execution_plan', v_plan.organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  -- POLICY ĐƯỢC ÉP LẠI Ở ĐÂY, KHÔNG CHỈ Ở LÚC LẬP.
  --
  --   `copilot_action_gate_v1` KHÔNG biết gì về trần rủi ro hay danh sách vai:
  --   nó đo registry + cờ + cấm khẩn cấp + phạm vi quyền. Nghĩa là nếu policy
  --   chỉ được ép ở `create`, thì một lần hạ trần L4 → L3 (hoặc bỏ `owner` khỏi
  --   `allowed_roles`) ở phút thứ 2 KHÔNG chạm được vào một kế hoạch lập ở phút
  --   0: nó vẫn duyệt được ở phút 3 và chạy tới phút 35. Van mà không có tác
  --   dụng lên thứ đang chờ chạy thì nó không phải van.
  --
  --   Ba vế, và cả ba đi cùng một mã `policy_changed` vì với người bấm chúng là
  --   một chuyện: luật đã đổi kể từ lúc kế hoạch này được lập.
  IF v_policy_rev IS DISTINCT FROM v_plan.policy_revision THEN
    v_ly_do := 'policy_changed';
  ELSIF NOT app_private.copilot_plan_role_allowed_v1(v_plan.organization_id) THEN
    v_ly_do := 'policy_changed';
  END IF;

  -- KIỂM LẠI TOÀN BỘ BƯỚC NGAY TRƯỚC KHI DUYỆT. Giữa lúc lập và lúc bấm có tới 5
  -- phút: đủ để ai đó thu quyền, tắt một action, hoặc kéo cầu dao khẩn cấp.
  FOR v_step IN
    SELECT * FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id ORDER BY step_no
  LOOP
    -- Vế policy ở trên đã chốt lý do thì bước ĐẦU TIÊN mang nó — không chạy tiếp
    -- vòng lặp để một mã lỗi khác đè lên.
    IF v_ly_do IS NOT NULL THEN
      v_buoc_hong := v_step.step_no;
      EXIT;
    END IF;
    BEGIN
      SELECT * INTO v_reg
        FROM app_private.copilot_action_registry
       WHERE action_id = v_step.action_id;
      IF NOT FOUND OR NOT v_reg.enabled OR v_reg.version <> v_step.action_version THEN
        v_ly_do := 'registry_changed';
      -- Trần rủi ro, đo LẠI theo policy của lúc BẤM. Miễn trừ vẫn theo đúng một
      -- `executor_kind` như ở `create`, không theo mức rủi ro.
      ELSIF v_reg.executor_kind <> 'maker_submit_v1'
            AND (CASE v_reg.risk WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END)
              > (CASE v_max_direct WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END) THEN
        v_ly_do := 'policy_changed';
      ELSE
        PERFORM app_private.copilot_action_gate_v1(v_step.action_id, v_plan.organization_id);
      END IF;
    EXCEPTION WHEN others THEN
      -- Giữ nguyên mã lỗi THẬT của cửa đã chặn (`copilot_action_disabled`,
      -- `tenant_emergency_denied`, `not_permitted`…). Ép tất cả về một chữ
      -- `step_not_permitted` sẽ làm người trực sự cố đi sửa phân quyền cho một
      -- lệnh cấm khẩn cấp — cùng lớp lỗi mà thứ tự bốn cửa của G2-A đã sửa.
      GET STACKED DIAGNOSTICS v_chi_tiet = MESSAGE_TEXT;
      v_ly_do := COALESCE(NULLIF(split_part(v_chi_tiet, ':', 1), ''), 'step_not_permitted');
    END;
    IF v_ly_do IS NOT NULL THEN
      v_buoc_hong := v_step.step_no;
      EXIT;
    END IF;
  END LOOP;

  IF v_ly_do IS NOT NULL THEN
    -- NONCE VẪN BỊ TIÊU. Người dùng đã bấm; phiếu đồng ý đó đã được dùng, và
    -- việc kế hoạch không chạy được là câu trả lời chứ không phải một lần bấm
    -- hỏng. Để nonce sống tiếp là mở đường thử lại tới khi lọt.
    UPDATE app_private.copilot_write_confirmations
       SET consumed_at = clock_timestamp()
     WHERE id = v_conf.id AND consumed_at IS NULL;

    -- Fix round 1 (F3): token step-up (neu co) tieu CUNG luc voi nonce --
    -- xem chu thich day du o nhanh thanh cong ben duoi.
    IF v_step_up.id IS NOT NULL THEN
      UPDATE app_private.copilot_write_confirmations
         SET consumed_at = clock_timestamp()
       WHERE id = v_step_up.id AND consumed_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
      END IF;
      v_step_up_id := v_step_up.id;
    END IF;
    v_consent_kind := CASE WHEN v_step_up_id IS NOT NULL THEN 'step_up' ELSE 'click' END;
    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED',
           error_code = CASE WHEN step_no = v_buoc_hong THEN v_ly_do ELSE 'plan_failed' END
     WHERE plan_id = v_plan.id AND status = 'PENDING';

    UPDATE app_private.copilot_plans
       SET status = 'FAILED',
           version = version + 1,
           consent_confirmation_id = v_conf.id,
           consent_kind = v_consent_kind,
           step_up_confirmation_id = v_step_up_id,
           -- Cùng khuôn với `execute_step`: <sự kiện sổ>:<bước>:<mã lỗi thật>.
           -- Mã lỗi thật là `policy_changed`, `registry_changed`,
           -- `copilot_action_disabled`, `tenant_emergency_denied`,
           -- `not_permitted`… — xem khối EXCEPTION ở vòng lặp trên.
           failure_reason = 'step_blocked:' || v_buoc_hong::text || ':' || v_ly_do,
           updated_at = clock_timestamp()
     WHERE id = v_plan.id
    RETURNING version INTO v_version;

    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'step_blocked',
      'organization_id', v_plan.organization_id,
      'plan_id',         v_plan.id,
      'step_no',         v_buoc_hong,
      'plan_version',    v_version,
      'action_id',       (SELECT action_id FROM app_private.copilot_plan_steps
                           WHERE plan_id = v_plan.id AND step_no = v_buoc_hong),
      'permission_key',  'copilot.execution_plan',
      'consent_id',      v_conf.id,
      'consent_kind',    v_consent_kind,
      'step_up_id',      v_step_up_id,
      'error_code',      v_ly_do,
      'outcome',         jsonb_build_object('giai_doan', 'approve', 'plan_status', 'FAILED')));

    RETURN jsonb_build_object(
      'ok',               false,
      'error_code',       v_ly_do,
      'plan_id',          v_plan.id,
      'plan_version',     v_version,
      'plan_status',      'FAILED',
      'consent_kind',     v_consent_kind,
      'execute_deadline', NULL,
      'step_no',          v_buoc_hong);
  END IF;

  -- CAS TIÊU NONCE. `consumed_at IS NULL` trong WHERE là thứ biến hai lần bấm
  -- song song thành một lần duyệt.
  UPDATE app_private.copilot_write_confirmations
     SET consumed_at = clock_timestamp()
   WHERE id = v_conf.id AND consumed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirmation_already_used' USING ERRCODE = '42501';
  END IF;

  -- Fix round 1 (F3): TIEU token step-up O DAY -- CUNG mot diem voi nonce
  -- cap ke hoach (ngay tren). Truoc do token chi duoc VALIDATE (SELECT ...
  -- FOR UPDATE + 7 dieu kien OR), khong bi tieu -- neu khong, mot lan RAISE
  -- kill-switch/policy-missing O TREN diem nay se dot token ma khong duyet
  -- duoc gi (nguoi dung phai xac thuc PIN lai tu dau de lay token moi, dung
  -- luc nonce cap ke hoach VAN CON SONG vi no cung khong bi tieu som).
  IF v_step_up.id IS NOT NULL THEN
    UPDATE app_private.copilot_write_confirmations
       SET consumed_at = clock_timestamp()
     WHERE id = v_step_up.id AND consumed_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';
    END IF;
    v_step_up_id := v_step_up.id;
  END IF;
  v_consent_kind := CASE WHEN v_step_up_id IS NOT NULL THEN 'step_up' ELSE 'click' END;
  v_han := clock_timestamp() + interval '30 minutes';
  UPDATE app_private.copilot_plans
     SET status = 'APPROVED',
         approved_at = clock_timestamp(),
         execute_deadline = v_han,
         consent_confirmation_id = v_conf.id,
         consent_kind = v_consent_kind,
         step_up_confirmation_id = v_step_up_id,
         version = version + 1,
         updated_at = clock_timestamp()
   WHERE id = v_plan.id AND version = p_expected_plan_version
  RETURNING version INTO v_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = 'PT409';
  END IF;

  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',           'plan_approved',
    'organization_id', v_plan.organization_id,
    'plan_id',         v_plan.id,
    'plan_version',    v_version,
    'permission_key',  'copilot.execution_plan',
    'permission_snapshot', jsonb_build_object(
      'registry_revision', v_plan.registry_revision,
      'policy_revision',   v_policy_rev,
      'max_direct_risk',   v_max_direct,
      'plan_max_risk',     v_plan.max_risk,
      'step_count',        v_plan.step_count,
      'is_super_admin',    public.is_super_admin(),
      'checked_at',        clock_timestamp()),
    'consent_id',      v_conf.id,
    'consent_kind',    v_consent_kind,
    'step_up_id',      v_step_up_id,
    'payload_digest',  encode(v_plan.plan_digest, 'hex'),
    'outcome', jsonb_build_object('plan_status', 'APPROVED', 'execute_deadline', v_han)));

  RETURN jsonb_build_object(
    'ok',               true,
    'error_code',       NULL,
    'plan_id',          v_plan.id,
    'plan_version',     v_version,
    'plan_status',      'APPROVED',
    'consent_kind',     v_consent_kind,
    'execute_deadline', v_han);
END
$function$;
REVOKE ALL ON FUNCTION public.copilot_plan_approve_v1(uuid,text,text,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_plan_approve_v1(uuid,text,text,integer,text) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_plan_approve_v1(uuid,text,text,integer,text) TO authenticated;

-- public.copilot_plan_cancel_v1(uuid,integer,text): 2 chỗ ném
CREATE OR REPLACE FUNCTION public.copilot_plan_cancel_v1(p_plan_id uuid, p_expected_plan_version integer, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private', 'extensions'
AS $function$
DECLARE
  v_actor   uuid := auth.uid();
  v_plan    app_private.copilot_plans%ROWTYPE;
  v_version int;
  v_bo_qua  int;
  v_ly_do   text := left(COALESCE(btrim(p_reason), ''), 500);
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    SELECT * INTO v_plan
      FROM app_private.copilot_plans p
     WHERE p.id = p_plan_id AND p.user_id = v_actor
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'plan_busy' USING ERRCODE = '55P03';
  END;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_plan.status NOT IN ('DRAFT', 'APPROVED') THEN
    RAISE EXCEPTION 'plan_not_cancellable: dang o %', v_plan.status USING ERRCODE = '22023';
  END IF;
  IF p_expected_plan_version IS NULL OR v_plan.version <> p_expected_plan_version THEN
    RAISE EXCEPTION 'plan_version_stale: dang o %, nguoi goi mong %',
      v_plan.version, p_expected_plan_version
      USING ERRCODE = 'PT409';
  END IF;

  -- Tiêu phiếu đồng ý nếu nó còn sống. Với kế hoạch DRAFT thì
  -- `consent_confirmation_id` còn NULL (nó chỉ được điền lúc duyệt), nên tìm
  -- theo `payload_hash` — vốn CHÍNH LÀ `plan_digest`, và đó là quan hệ duy nhất
  -- giữa hàng nonce và kế hoạch trước khi duyệt.
  UPDATE app_private.copilot_write_confirmations
     SET consumed_at = clock_timestamp()
   WHERE user_id = v_actor
     AND tool = 'lap_ke_hoach'
     AND payload_hash = v_plan.plan_digest
     AND consumed_at IS NULL;

  UPDATE app_private.copilot_plan_steps
     SET status = 'SKIPPED', error_code = 'plan_cancelled'
   WHERE plan_id = v_plan.id AND status = 'PENDING';
  GET DIAGNOSTICS v_bo_qua = ROW_COUNT;

  UPDATE app_private.copilot_plans
     SET status = 'CANCELLED',
         version = version + 1,
         failure_reason = NULLIF(v_ly_do, ''),
         updated_at = clock_timestamp()
   WHERE id = v_plan.id AND version = p_expected_plan_version
  RETURNING version INTO v_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = 'PT409';
  END IF;

  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event',           'plan_cancelled',
    'organization_id', v_plan.organization_id,
    'plan_id',         v_plan.id,
    'plan_version',    v_version,
    'permission_key',  'copilot.execution_plan',
    'consent_id',      v_plan.consent_confirmation_id,
    'consent_kind',    v_plan.consent_kind,
    'step_up_id',      v_plan.step_up_confirmation_id,
    'payload_digest',  encode(v_plan.plan_digest, 'hex'),
    'outcome', jsonb_build_object(
      'ly_do',            v_ly_do,
      'buoc_bo_qua',      v_bo_qua,
      'trang_thai_truoc', v_plan.status)));

  RETURN jsonb_build_object(
    'ok',           true,
    'error_code',   NULL,
    'plan_id',      v_plan.id,
    'plan_version', v_version,
    'plan_status',  'CANCELLED',
    'skipped',      v_bo_qua);
END
$function$;
REVOKE ALL ON FUNCTION public.copilot_plan_cancel_v1(uuid,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_plan_cancel_v1(uuid,integer,text) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_plan_cancel_v1(uuid,integer,text) TO authenticated;

-- public.copilot_plan_execute_step_v1(uuid,integer,integer,uuid): 3 chỗ ném
CREATE OR REPLACE FUNCTION public.copilot_plan_execute_step_v1(p_plan_id uuid, p_step_no integer, p_expected_plan_version integer, p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private', 'extensions'
AS $function$
DECLARE
  v_actor       uuid := auth.uid();
  v_plan        app_private.copilot_plans%ROWTYPE;
  v_step        app_private.copilot_plan_steps%ROWTYPE;
  v_reg         app_private.copilot_action_registry%ROWTYPE;
  v_snapshot    jsonb := '{}'::jsonb;
  v_max_direct  text;
  v_policy_rev  bigint;
  v_next        int;
  v_version     int;
  v_kq          jsonb;
  v_ket         jsonb;
  v_canon_moi   jsonb;
  v_nonce       text;
  v_bang        text;
  v_entity_id   uuid;
  v_audit_id    uuid;
  v_trang_thai  text;
  v_after       jsonb;
  v_after_hex   text;
  v_voucher     uuid;
  v_idem        boolean := false;
  v_loi         text := NULL;
  v_chi_tiet    text := NULL;
  v_sqlstate    text := NULL;
  v_su_kien     text := NULL;
  v_ledger_id   uuid;
  v_plan_status text;
  v_buoc_status text;
  v_chan        int[];
  v_j           int;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_id IS NULL OR p_step_no IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    SELECT * INTO v_plan
      FROM app_private.copilot_plans p
     WHERE p.id = p_plan_id AND p.user_id = v_actor
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'plan_busy' USING ERRCODE = '55P03';
  END;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_organization_id IS NULL OR v_plan.organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '42501';
  END IF;

  IF v_plan.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'plan_not_approved: dang o %', v_plan.status USING ERRCODE = '22023';
  END IF;

  IF COALESCE(v_plan.execute_deadline, v_plan.expires_at) <= clock_timestamp() THEN
    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED', error_code = 'plan_expired'
     WHERE plan_id = v_plan.id AND status = 'PENDING';
    UPDATE app_private.copilot_plans
       SET status = 'EXPIRED', version = version + 1,
           failure_reason = 'plan_expired', updated_at = clock_timestamp()
     WHERE id = v_plan.id
    RETURNING version INTO v_version;
    PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'plan_expired',
      'organization_id', v_plan.organization_id,
      'plan_id',         v_plan.id,
      'step_no',         p_step_no,
      'plan_version',    v_version,
      'permission_key',  'copilot.execution_plan',
      'consent_id',      v_plan.consent_confirmation_id,
      'consent_kind',    v_plan.consent_kind,
      'step_up_id',      v_plan.step_up_confirmation_id,
      'error_code',      'plan_expired',
      'outcome',         jsonb_build_object('giai_doan', 'execute')));
    RETURN jsonb_build_object(
      'ok',           false,
      'error_code',   'plan_expired',
      'plan_id',      v_plan.id,
      'plan_version', v_version,
      'plan_status',  'EXPIRED',
      'step', jsonb_build_object(
        'step_no', p_step_no, 'status', 'BLOCKED', 'outcome', NULL,
        'error_code', 'plan_expired'),
      'next_step_no', NULL);
  END IF;

  IF p_expected_plan_version IS NULL OR v_plan.version <> p_expected_plan_version THEN
    RAISE EXCEPTION 'plan_version_stale: dang o %, nguoi goi mong %',
      v_plan.version, p_expected_plan_version
      USING ERRCODE = 'PT409';
  END IF;

  SELECT min(step_no) INTO v_next
    FROM app_private.copilot_plan_steps
   WHERE plan_id = v_plan.id AND status = 'PENDING';
  IF v_next IS NULL THEN
    RAISE EXCEPTION 'plan_no_pending_step' USING ERRCODE = '22023';
  END IF;
  IF p_step_no IS DISTINCT FROM v_next THEN
    RAISE EXCEPTION 'step_order: buoc ke tiep la %', v_next USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND step_no < p_step_no AND status <> 'DONE'
  ) THEN
    RAISE EXCEPTION 'step_order: con buoc truoc chua xong' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_step
    FROM app_private.copilot_plan_steps
   WHERE plan_id = v_plan.id AND step_no = p_step_no
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'step_not_found' USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    IF NOT app_private.copilot_action_flag_allows_v1(
             'copilot.execution_plan', v_plan.organization_id) THEN
      RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
    END IF;

    IF v_plan.consent_kind = 'standing_grant' THEN
      IF EXISTS (
        SELECT 1
          FROM unnest(v_plan.standing_grant_ids) AS gid
         WHERE NOT EXISTS (
           SELECT 1 FROM app_private.copilot_standing_grants g
            WHERE g.id = gid
              AND g.revoked_at IS NULL
              AND g.expires_at > clock_timestamp()
         )
      ) THEN
        RAISE EXCEPTION 'grant_revoked' USING ERRCODE = '42501';
      END IF;
    END IF;

    SELECT * INTO v_reg
      FROM app_private.copilot_action_registry
     WHERE action_id = v_step.action_id;
    IF NOT FOUND OR NOT v_reg.enabled OR v_reg.version <> v_step.action_version THEN
      RAISE EXCEPTION 'registry_changed' USING ERRCODE = '42501';
    END IF;

    SELECT max_direct_risk, revision INTO v_max_direct, v_policy_rev
      FROM app_private.copilot_action_policy WHERE id;
    IF v_max_direct IS NULL OR v_policy_rev IS NULL THEN
      RAISE EXCEPTION 'copilot_policy_missing' USING ERRCODE = 'P0002';
    END IF;
    IF v_policy_rev IS DISTINCT FROM v_plan.policy_revision
       OR NOT app_private.copilot_plan_role_allowed_v1(v_plan.organization_id)
       OR (v_reg.executor_kind <> 'maker_submit_v1'
           AND (CASE v_reg.risk WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END)
             > (CASE v_max_direct WHEN 'L3' THEN 3 WHEN 'L4' THEN 4 ELSE 5 END)) THEN
      RAISE EXCEPTION 'policy_changed' USING ERRCODE = '42501';
    END IF;

    v_snapshot := app_private.copilot_action_gate_v1(v_step.action_id, v_plan.organization_id);

    IF v_step.canonical IS NULL
       OR v_step.payload_digest IS NULL
       OR app_private.copilot_payload_hash_v1(v_step.canonical)
            IS DISTINCT FROM v_step.payload_digest THEN
      RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
    END IF;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_chi_tiet = MESSAGE_TEXT;
    v_loi := split_part(v_chi_tiet, ':', 1);
    v_su_kien := 'step_blocked';
  END;

  IF v_loi IS NULL THEN
    BEGIN
      IF v_reg.executor_kind = 'nonce_abi_v1' THEN
        EXECUTE format('SELECT public.%I($1, $2)', v_reg.preview_rpc)
           INTO v_kq
          USING v_plan.organization_id, v_step.payload;
        v_canon_moi := v_kq -> 'canonical';
        v_nonce := v_kq ->> 'confirmation_nonce';
        IF jsonb_typeof(COALESCE(v_canon_moi, 'null'::jsonb)) <> 'object'
           OR app_private.copilot_payload_hash_v1(v_canon_moi)
                IS DISTINCT FROM v_step.payload_digest THEN
          RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
        END IF;

        EXECUTE format('SELECT public.%I($1, $2)', v_reg.execute_rpc)
           INTO v_ket
          USING v_nonce, v_canon_moi;

      ELSIF v_reg.executor_kind = 'direct_l5_v1' THEN
        EXECUTE format('SELECT public.%I($1, $2)', v_reg.preview_rpc)
           INTO v_kq
          USING v_plan.organization_id, v_step.payload;
        v_canon_moi := v_kq -> 'canonical';
        v_nonce := v_kq ->> 'confirmation_nonce';
        IF jsonb_typeof(COALESCE(v_canon_moi, 'null'::jsonb)) <> 'object'
           OR app_private.copilot_payload_hash_v1(v_canon_moi)
                IS DISTINCT FROM v_step.payload_digest THEN
          RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
        END IF;

        PERFORM set_config('app.copilot_plan_context',
                            v_plan.id::text || ':' || p_step_no::text, true);
        EXECUTE format('SELECT public.%I($1, $2)', v_reg.execute_rpc)
           INTO v_ket
          USING v_nonce, v_canon_moi;
        PERFORM set_config('app.copilot_plan_context', '', true);

      ELSIF v_reg.executor_kind = 'maker_submit_v1' THEN
        IF v_step.ref_step IS NOT NULL THEN
          SELECT NULLIF(s.outcome ->> 'entity_id', '')::uuid INTO v_voucher
            FROM app_private.copilot_plan_steps s
           WHERE s.plan_id = v_plan.id
             AND s.step_no = v_step.ref_step
             AND s.status = 'DONE';
          IF v_voucher IS NULL THEN
            RAISE EXCEPTION 'ref_step_unresolved' USING ERRCODE = '22023';
          END IF;
        ELSE
          v_voucher := NULLIF(v_step.canonical ->> 'voucher_id', '')::uuid;
          IF v_voucher IS NULL THEN
            RAISE EXCEPTION 'step_voucher_invalid' USING ERRCODE = '22023';
          END IF;
        END IF;
        v_ket := app_private.copilot_plan_submit_voucher_v1(
                   v_plan.organization_id, v_voucher, v_plan.id, v_step.step_no);

      ELSE
        RAISE EXCEPTION 'executor_not_supported' USING ERRCODE = '0A000';
      END IF;

      v_trang_thai := COALESCE(v_ket ->> 'status', 'da_thuc_hien');
      v_bang := COALESCE(NULLIF(v_ket ->> 'entity_table', ''), v_reg.produces_entity_table);
      v_entity_id := NULLIF(v_ket ->> 'entity_id', '')::uuid;
      v_audit_id := NULLIF(v_ket ->> 'audit_id', '')::uuid;
      v_idem := v_trang_thai IN ('da_thuc_hien_truoc_do', 'da_tao_truoc_do')
                OR COALESCE((v_ket ->> 'idempotent')::boolean, false);

      IF v_entity_id IS NULL OR v_bang IS NULL OR v_bang !~ '^[a-z_][a-z0-9_]*$' THEN
        RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
      END IF;
      EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1', v_bang)
         INTO v_after
        USING v_entity_id;
      IF v_after IS NULL
         OR NULLIF(v_after ->> 'organization_id', '')::uuid
              IS DISTINCT FROM v_plan.organization_id THEN
        RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
      END IF;

      CASE v_reg.verify_kind
        WHEN 'ie_draft' THEN
          IF v_after ->> 'approval_status' IS DISTINCT FROM 'UNAPPROVED'
             OR v_after ->> 'posting_status' IS DISTINCT FROM 'UNPOSTED'
             OR NULLIF(v_after ->> 'user_id', '')::uuid IS DISTINCT FROM v_actor THEN
            RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
          END IF;
        WHEN 'approval_request_pending' THEN
          IF v_after ->> 'state' IS DISTINCT FROM 'PENDING_APPROVAL'
             OR NULLIF(v_after ->> 'maker_user_id', '')::uuid IS DISTINCT FROM v_actor THEN
            RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
          END IF;
        WHEN 'hold_pending_approval' THEN
          IF v_after ->> 'status' IS DISTINCT FROM 'PENDING_APPROVAL' THEN
            RAISE EXCEPTION 'copilot_draft_invariant_violation' USING ERRCODE = 'P0001';
          END IF;
        ELSE
          -- 'readback' VA 'external_effect' deu roi vao day: readback la
          -- "ton tai + dung to chuc" da la toan bo loi hua; external_effect
          -- khong co bat bien nao them o day - trang thai THAT cua no chi
          -- duoc doi soat sau, boi copilot_plan_reconcile_step_v1.
          NULL;
      END CASE;
    EXCEPTION WHEN others THEN
      PERFORM set_config('app.copilot_plan_context', '', true);
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_chi_tiet = MESSAGE_TEXT;
      v_loi := split_part(v_chi_tiet, ':', 1);
      v_su_kien := 'step_failed';
    END;
  END IF;

  IF v_loi IS NULL THEN
    v_after_hex := encode(
      extensions.digest(convert_to(v_after::text, 'UTF8'), 'sha256'), 'hex');

    -- G5-C2: verify_kind='external_effect' -> buoc dung o UNKNOWN_EFFECT,
    -- KHONG DONE, cho toi khi copilot_plan_reconcile_step_v1 doi soat that.
    v_buoc_status := CASE WHEN v_reg.verify_kind = 'external_effect'
                          THEN 'UNKNOWN_EFFECT' ELSE 'DONE' END;

    UPDATE app_private.copilot_plan_steps
       SET status = v_buoc_status,
           outcome = jsonb_build_object(
             'entity_table', v_bang,
             'entity_id',    v_entity_id,
             'audit_id',     v_audit_id,
             'idempotent',   v_idem,
             'status',       v_trang_thai),
           error_code = NULL,
           error_detail = NULL,
           executed_at = clock_timestamp()
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    -- F4 (review G5-C2 fix round 1): su kien RIENG cho buoc UNKNOWN_EFFECT -
    -- khong con dung chung 'step_done' (truoc day phan biet DUY NHAT qua
    -- outcome.step_status, de lan voi buoc DONE that trong bat ky truy van so
    -- nao loc theo event='step_done').
    v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               CASE WHEN v_buoc_status = 'UNKNOWN_EFFECT'
                                   THEN 'step_unknown_effect' ELSE 'step_done' END,
      'organization_id',     v_plan.organization_id,
      'plan_id',             v_plan.id,
      'step_no',             p_step_no,
      'plan_version',        v_plan.version + 1,
      'action_id',           v_step.action_id,
      'permission_key',      v_step.permission_key,
      'permission_snapshot', v_snapshot,
      'consent_id',          v_plan.consent_confirmation_id,
      'consent_kind',        v_plan.consent_kind,
      'step_up_id',          v_plan.step_up_confirmation_id,
      'payload_digest',      encode(v_step.payload_digest, 'hex'),
      'after_digest',        v_after_hex,
      'entity_table',        v_bang,
      'entity_id',           v_entity_id,
      'audit_id',            v_audit_id,
      'amount',              NULLIF(v_step.canonical ->> 'amount', ''),
      'outcome', jsonb_build_object('status', v_trang_thai, 'idempotent', v_idem,
                                     'step_status', v_buoc_status)));

    UPDATE app_private.copilot_plan_steps
       SET ledger_id = v_ledger_id
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    SELECT min(step_no) INTO v_next
      FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND status = 'PENDING';
    -- G5-C2: mot buoc UNKNOWN_EFFECT khong bao gio dua ke hoach len DONE, bat
    -- ke con buoc PENDING nao khac hay khong - phai cho reconcile.
    v_plan_status := CASE WHEN v_buoc_status = 'UNKNOWN_EFFECT' THEN 'APPROVED'
                          WHEN v_next IS NULL THEN 'DONE' ELSE 'APPROVED' END;

    UPDATE app_private.copilot_plans
       SET status = v_plan_status, version = version + 1, updated_at = clock_timestamp()
     WHERE id = v_plan.id AND version = p_expected_plan_version
    RETURNING version INTO v_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = 'PT409';
    END IF;

  ELSE
    v_buoc_status := CASE WHEN v_su_kien = 'step_blocked' THEN 'BLOCKED' ELSE 'FAILED' END;

    UPDATE app_private.copilot_plan_steps
       SET status = v_buoc_status,
           error_code = v_loi,
           error_detail = left(COALESCE(v_chi_tiet, ''), 1000),
           executed_at = clock_timestamp()
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    SELECT array_agg(step_no ORDER BY step_no) INTO v_chan
      FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND status = 'PENDING' AND step_no <> p_step_no;

    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED', error_code = 'plan_failed'
     WHERE plan_id = v_plan.id AND status = 'PENDING' AND step_no <> p_step_no;

    v_plan_status := 'FAILED';
    UPDATE app_private.copilot_plans
       SET status = 'FAILED',
           version = version + 1,
           failure_reason = v_su_kien || ':' || p_step_no::text || ':' || COALESCE(v_loi, '?'),
           updated_at = clock_timestamp()
     WHERE id = v_plan.id AND version = p_expected_plan_version
    RETURNING version INTO v_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = 'PT409';
    END IF;

    v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',               v_su_kien,
      'organization_id',     v_plan.organization_id,
      'plan_id',             v_plan.id,
      'step_no',             p_step_no,
      'plan_version',        v_version,
      'action_id',           v_step.action_id,
      'permission_key',      v_step.permission_key,
      'permission_snapshot', v_snapshot,
      'consent_id',          v_plan.consent_confirmation_id,
      'consent_kind',        v_plan.consent_kind,
      'step_up_id',          v_plan.step_up_confirmation_id,
      'payload_digest',      encode(v_step.payload_digest, 'hex'),
      'error_code',          v_loi,
      'sqlstate',            v_sqlstate,
      'outcome', jsonb_build_object('plan_status', 'FAILED')));

    UPDATE app_private.copilot_plan_steps
       SET ledger_id = v_ledger_id
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    IF v_chan IS NOT NULL THEN
      FOREACH v_j IN ARRAY v_chan LOOP
        PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
          'event',           'step_blocked',
          'organization_id', v_plan.organization_id,
          'plan_id',         v_plan.id,
          'step_no',         v_j,
          'plan_version',    v_version,
          'action_id',       (SELECT action_id FROM app_private.copilot_plan_steps
                               WHERE plan_id = v_plan.id AND step_no = v_j),
          'permission_key',  'copilot.execution_plan',
          'consent_id',      v_plan.consent_confirmation_id,
          'consent_kind',    v_plan.consent_kind,
          'step_up_id',      v_plan.step_up_confirmation_id,
          'error_code',      'plan_failed',
          'outcome',         jsonb_build_object('nguyen_nhan_tu_buoc', p_step_no)));
      END LOOP;
    END IF;
    v_next := NULL;
  END IF;

  RETURN jsonb_build_object(
    'ok',           v_loi IS NULL,
    'error_code',   v_loi,
    'plan_id',      v_plan.id,
    'plan_version', v_version,
    'plan_status',  v_plan_status,
    'step', jsonb_build_object(
      'step_no',    p_step_no,
      'status',     v_buoc_status,
      'outcome',    CASE WHEN v_loi IS NULL THEN jsonb_build_object(
                           'entity_table', v_bang,
                           'entity_id',    v_entity_id,
                           'audit_id',     v_audit_id,
                           'idempotent',   v_idem)
                         ELSE NULL END,
      'error_code', v_loi),
    'next_step_no', v_next);
END
$function$;
REVOKE ALL ON FUNCTION public.copilot_plan_execute_step_v1(uuid,integer,integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_plan_execute_step_v1(uuid,integer,integer,uuid) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_plan_execute_step_v1(uuid,integer,integer,uuid) TO authenticated;

-- public.copilot_plan_reconcile_step_v1(uuid,integer,integer): 3 chỗ ném
CREATE OR REPLACE FUNCTION public.copilot_plan_reconcile_step_v1(p_plan_id uuid, p_step_no integer, p_expected_plan_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_plan           app_private.copilot_plans%ROWTYPE;
  v_step           app_private.copilot_plan_steps%ROWTYPE;
  v_reg            app_private.copilot_action_registry%ROWTYPE;
  v_entity_table   text;
  v_entity_id      uuid;
  v_row            jsonb;
  v_ext_status     text;
  v_new_step_status text;
  v_ledger_id      uuid;
  v_version        int;
  v_plan_status    text;
  v_next           int;
  v_chan           int[];
  v_j              int;
  v_after_outcome  jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_plan_id IS NULL OR p_step_no IS NULL OR p_expected_plan_version IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    SELECT * INTO v_plan
      FROM app_private.copilot_plans p
     WHERE p.id = p_plan_id
       AND (p.user_id = v_actor OR public.is_super_admin())
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'plan_busy' USING ERRCODE = '55P03';
  END;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'plan_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_plan.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'plan_not_approved: dang o %', v_plan.status USING ERRCODE = '22023';
  END IF;
  IF v_plan.version <> p_expected_plan_version THEN
    RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = 'PT409';
  END IF;

  IF NOT app_private.copilot_action_flag_allows_v1(
           'copilot.execution_plan', v_plan.organization_id) THEN
    RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_step
    FROM app_private.copilot_plan_steps s
   WHERE s.plan_id = v_plan.id AND s.step_no = p_step_no
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'step_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_step.status <> 'UNKNOWN_EFFECT' THEN
    RAISE EXCEPTION 'step_not_unknown_effect: dang o %', v_step.status USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_reg
    FROM app_private.copilot_action_registry
   WHERE action_id = v_step.action_id;
  IF NOT FOUND OR v_reg.verify_kind <> 'external_effect' THEN
    RAISE EXCEPTION 'registry_changed' USING ERRCODE = '42501';
  END IF;

  v_entity_table := v_step.outcome ->> 'entity_table';
  v_entity_id    := NULLIF(v_step.outcome ->> 'entity_id', '')::uuid;
  IF v_entity_table IS NULL OR v_entity_id IS NULL
     OR v_entity_table !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
  END IF;

  IF v_entity_table = 'zalo_send_queue' THEN
    SELECT to_jsonb(t) INTO v_row FROM public.zalo_send_queue t
     WHERE t.id = v_entity_id AND t.organization_id = v_plan.organization_id;
    IF v_row IS NULL THEN
      RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
    END IF;
    v_ext_status := CASE v_row ->> 'status'
                      WHEN 'sent' THEN 'DONE'
                      WHEN 'failed' THEN 'FAILED'
                      ELSE 'PENDING'
                    END;
  ELSIF v_entity_table = 'network_commands' THEN
    SELECT to_jsonb(t) INTO v_row FROM public.network_commands t
     WHERE t.id = v_entity_id AND t.organization_id = v_plan.organization_id;
    IF v_row IS NULL THEN
      RAISE EXCEPTION 'copilot_write_readback_mismatch' USING ERRCODE = 'P0001';
    END IF;
    v_ext_status := CASE
                      WHEN v_row ->> 'status' = 'SUCCEEDED' THEN 'DONE'
                      WHEN v_row ->> 'status' IN ('FAILED', 'CANCELLED_BY_KILL_SWITCH') THEN 'FAILED'
                      ELSE 'PENDING'
                    END;
  ELSE
    RAISE EXCEPTION 'executor_not_supported: doi soat khong biet bang %', v_entity_table
      USING ERRCODE = '0A000';
  END IF;

  IF v_ext_status = 'PENDING' THEN
    -- Chua co gi doi - tra ve nguyen trang, KHONG ghi so (client co the hoi
    -- lai nhieu lan), KHONG tang version.
    RETURN jsonb_build_object(
      'ok', true, 'error_code', NULL,
      'plan_id', v_plan.id, 'plan_version', v_plan.version, 'plan_status', v_plan.status,
      'step', jsonb_build_object('step_no', p_step_no, 'status', 'UNKNOWN_EFFECT',
                                  'outcome', v_step.outcome, 'error_code', NULL),
      'next_step_no', NULL);
  END IF;

  v_new_step_status := v_ext_status;
  v_after_outcome := v_step.outcome || jsonb_build_object(
    'reconciled_status', v_new_step_status, 'reconciled_at', clock_timestamp());

  UPDATE app_private.copilot_plan_steps
     SET status = v_new_step_status,
         outcome = v_after_outcome,
         error_code = CASE WHEN v_new_step_status = 'FAILED' THEN 'external_effect_failed' ELSE NULL END,
         executed_at = COALESCE(v_step.executed_at, clock_timestamp())
   WHERE plan_id = v_plan.id AND step_no = p_step_no;

  IF v_new_step_status = 'DONE' THEN
    SELECT min(step_no) INTO v_next
      FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND status IN ('PENDING', 'UNKNOWN_EFFECT');
    v_plan_status := CASE WHEN v_next IS NULL THEN 'DONE' ELSE 'APPROVED' END;

    UPDATE app_private.copilot_plans
       SET status = v_plan_status, version = version + 1, updated_at = clock_timestamp()
     WHERE id = v_plan.id AND version = p_expected_plan_version
    RETURNING version INTO v_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = 'PT409';
    END IF;

    v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'step_reconciled',
      'organization_id', v_plan.organization_id,
      'plan_id',         v_plan.id,
      'step_no',         p_step_no,
      'plan_version',    v_version,
      'action_id',       v_step.action_id,
      'permission_key',  v_step.permission_key,
      'consent_id',      v_plan.consent_confirmation_id,
      'consent_kind',    v_plan.consent_kind,
      'step_up_id',      v_plan.step_up_confirmation_id,
      'outcome', jsonb_build_object('reconciled_status', 'DONE',
                                     'entity_table', v_entity_table, 'entity_id', v_entity_id)));
    UPDATE app_private.copilot_plan_steps SET ledger_id = v_ledger_id
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

  ELSE
    SELECT array_agg(step_no ORDER BY step_no) INTO v_chan
      FROM app_private.copilot_plan_steps
     WHERE plan_id = v_plan.id AND status IN ('PENDING','UNKNOWN_EFFECT') AND step_no <> p_step_no;

    UPDATE app_private.copilot_plan_steps
       SET status = 'BLOCKED', error_code = 'plan_failed'
     WHERE plan_id = v_plan.id AND status IN ('PENDING','UNKNOWN_EFFECT') AND step_no <> p_step_no;

    v_plan_status := 'FAILED';
    UPDATE app_private.copilot_plans
       SET status = 'FAILED', version = version + 1,
           failure_reason = 'step_reconciled_failed:' || p_step_no::text,
           updated_at = clock_timestamp()
     WHERE id = v_plan.id AND version = p_expected_plan_version
    RETURNING version INTO v_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'plan_version_stale' USING ERRCODE = 'PT409';
    END IF;

    v_ledger_id := app_private.copilot_ledger_append_v1(jsonb_build_object(
      'event',           'step_reconciled',
      'organization_id', v_plan.organization_id,
      'plan_id',         v_plan.id,
      'step_no',         p_step_no,
      'plan_version',    v_version,
      'action_id',       v_step.action_id,
      'permission_key',  v_step.permission_key,
      'consent_id',      v_plan.consent_confirmation_id,
      'consent_kind',    v_plan.consent_kind,
      'step_up_id',      v_plan.step_up_confirmation_id,
      'error_code',      'external_effect_failed',
      'outcome', jsonb_build_object('reconciled_status', 'FAILED',
                                     'entity_table', v_entity_table, 'entity_id', v_entity_id)));
    UPDATE app_private.copilot_plan_steps SET ledger_id = v_ledger_id
     WHERE plan_id = v_plan.id AND step_no = p_step_no;

    IF v_chan IS NOT NULL THEN
      FOREACH v_j IN ARRAY v_chan LOOP
        PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
          'event',           'step_blocked',
          'organization_id', v_plan.organization_id,
          'plan_id',         v_plan.id,
          'step_no',         v_j,
          'plan_version',    v_version,
          'action_id',       (SELECT action_id FROM app_private.copilot_plan_steps
                               WHERE plan_id = v_plan.id AND step_no = v_j),
          'permission_key',  'copilot.execution_plan',
          'error_code',      'plan_failed',
          'outcome',         jsonb_build_object('nguyen_nhan_tu_buoc', p_step_no)));
      END LOOP;
    END IF;
    v_next := NULL;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'error_code', NULL,
    'plan_id', v_plan.id, 'plan_version', v_version, 'plan_status', v_plan_status,
    'step', jsonb_build_object(
      'step_no', p_step_no, 'status', v_new_step_status,
      'outcome', v_after_outcome,
      'error_code', CASE WHEN v_new_step_status = 'FAILED' THEN 'external_effect_failed' ELSE NULL END),
    'next_step_no', v_next);
END
$function$;
REVOKE ALL ON FUNCTION public.copilot_plan_reconcile_step_v1(uuid,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copilot_plan_reconcile_step_v1(uuid,integer,integer) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_plan_reconcile_step_v1(uuid,integer,integer) TO authenticated;

-- public.decide_financial_voucher(uuid,text,text,bigint): 1 chỗ ném
CREATE OR REPLACE FUNCTION public.decide_financial_voucher(p_request uuid, p_decision text, p_reason text DEFAULT NULL::text, p_expected_version bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  r public.approval_requests; st public.approval_request_steps;
  v_mem uuid; v_cand uuid; v_approvals int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_decision NOT IN ('APPROVE','REJECT') THEN RAISE EXCEPTION 'decision không hợp lệ'; END IF;
  SELECT * INTO r FROM public.approval_requests WHERE id=p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy request' USING ERRCODE='P0002'; END IF;
  IF r.state <> 'PENDING_APPROVAL' THEN RAISE EXCEPTION 'Request không ở trạng thái chờ duyệt (%).', r.state; END IF;
  IF p_expected_version IS NOT NULL AND r.version <> p_expected_version THEN
    RAISE EXCEPTION 'Xung đột phiên bản (CAS)' USING ERRCODE='PT409'; END IF;

  SELECT id INTO v_mem FROM public.organization_memberships
   WHERE user_id=v_uid AND organization_id=r.organization_id AND status='ACTIVE' LIMIT 1;
  IF v_mem IS NULL THEN RAISE EXCEPTION 'Bạn không thuộc tổ chức' USING ERRCODE='42501'; END IF;

  -- Maker-checker: người tạo KHÔNG tự duyệt.
  IF v_mem = r.maker_membership_id OR v_uid = r.maker_user_id THEN
    RAISE EXCEPTION 'Người tạo phiếu không được tự duyệt (maker-checker)' USING ERRCODE='42501';
  END IF;

  SELECT * INTO st FROM public.approval_request_steps
   WHERE request_id=p_request AND status='PENDING' ORDER BY step_no LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không có bước đang chờ'; END IF;

  -- Actor phải là candidate hiện tại.
  SELECT id INTO v_cand FROM public.approval_request_step_candidates
   WHERE request_step_id=st.id AND membership_id=v_mem AND generation=st.current_generation
     AND (valid_to IS NULL OR valid_to > now());
  IF v_cand IS NULL THEN RAISE EXCEPTION 'Bạn không nằm trong danh sách người duyệt bước này' USING ERRCODE='42501'; END IF;

  INSERT INTO public.approval_decisions (organization_id, request_id, request_step_id, candidate_id,
      candidate_generation, actor_membership_id, actor_user_id, decision, reason, request_version)
  VALUES (r.organization_id, p_request, st.id, v_cand, st.current_generation, v_mem, v_uid, p_decision, p_reason, r.version);

  IF p_decision='REJECT' THEN
    UPDATE public.approval_request_steps SET status='REJECTED' WHERE id=st.id;
    UPDATE public.approval_request_steps SET status='CANCELLED' WHERE request_id=p_request AND status='WAITING';
    UPDATE public.approval_requests SET state='REJECTED', version=version+1 WHERE id=p_request;
    RETURN jsonb_build_object('ok',true,'state','REJECTED');
  END IF;

  -- APPROVE: đếm quorum của step (normal APPROVE, current generation).
  SELECT count(*) INTO v_approvals FROM public.approval_decisions d
   WHERE d.request_step_id=st.id AND d.decision='APPROVE' AND d.candidate_generation=st.current_generation;
  IF v_approvals >= st.min_approvals THEN
    UPDATE public.approval_request_steps SET status='APPROVED' WHERE id=st.id;
    -- promote next WAITING step, else post.
    IF EXISTS(SELECT 1 FROM public.approval_request_steps WHERE request_id=p_request AND status='WAITING') THEN
      UPDATE public.approval_request_steps SET status='PENDING'
       WHERE id=(SELECT id FROM public.approval_request_steps WHERE request_id=p_request AND status='WAITING' ORDER BY step_no LIMIT 1);
      UPDATE public.approval_requests SET version=version+1 WHERE id=p_request;
      RETURN jsonb_build_object('ok',true,'state','PENDING_APPROVAL','promoted',true);
    ELSE
      PERFORM public._post_financial_voucher(r.subject_id, p_request, v_uid);
      RETURN jsonb_build_object('ok',true,'state','POSTED');
    END IF;
  END IF;
  UPDATE public.approval_requests SET version=version+1 WHERE id=p_request;
  RETURN jsonb_build_object('ok',true,'state','PENDING_APPROVAL','approvals',v_approvals);
END; $function$;
REVOKE ALL ON FUNCTION public.decide_financial_voucher(uuid,text,text,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_financial_voucher(uuid,text,text,bigint) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decide_financial_voucher(uuid,text,text,bigint) TO service_role;

-- public.delete_contract_draft_v1(uuid,uuid,integer): 1 chỗ ném
CREATE OR REPLACE FUNCTION public.delete_contract_draft_v1(p_organization_id uuid, p_draft_id uuid, p_expected_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE d public.contract_drafts%ROWTYPE; allowed boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Cần đăng nhập' USING ERRCODE='28000'; END IF;
  IF p_expected_revision IS NULL OR p_expected_revision<1 THEN RAISE EXCEPTION 'Thiếu phiên bản nháp' USING ERRCODE='22023'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO d FROM public.contract_drafts WHERE id=p_draft_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND OR NOT app_private.contract_draft_scope_allowed(p_organization_id,d.building_id,'contracts.delete') THEN
    RAISE EXCEPTION 'Không có quyền xoá bản nháp' USING ERRCODE='42501';
  END IF;
  SELECT a.allowed INTO allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'contracts.delete',d.building_id,NULL) a;
  IF NOT COALESCE(allowed,false) THEN RAISE EXCEPTION 'Không có quyền xoá bản nháp' USING ERRCODE='42501'; END IF;
  IF d.revision<>p_expected_revision THEN RAISE EXCEPTION 'Bản nháp đã thay đổi; tải lại trước khi xoá' USING ERRCODE='PT409'; END IF;
  IF d.status='DELETED' THEN RETURN jsonb_build_object('draft_id',d.id,'deleted',true); END IF;
  IF d.status<>'EDITABLE' OR d.converted_contract_id IS NOT NULL THEN
    RAISE EXCEPTION 'Bản nháp đã ký không thể xoá' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.contract_transfer_links WHERE new_draft_id=d.id AND state='LINKED') THEN
    RAISE EXCEPTION 'Hủy liên kết nhượng trước khi xoá bản nháp' USING ERRCODE='55000';
  END IF;
  UPDATE public.contract_drafts SET status='DELETED',deleted_at=clock_timestamp(),deleted_by=auth.uid(),updated_at=clock_timestamp() WHERE id=d.id;
  RETURN jsonb_build_object('draft_id',d.id,'deleted',true);
END $function$;
REVOKE ALL ON FUNCTION public.delete_contract_draft_v1(uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_contract_draft_v1(uuid,uuid,integer) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_contract_draft_v1(uuid,uuid,integer) TO authenticated;

-- public.job_recurrence_delete_v1(uuid,integer): 2 chỗ ném
CREATE OR REPLACE FUNCTION public.job_recurrence_delete_v1(p_rule_id uuid, p_expected_version integer)
 RETURNS job_recurrence_rules
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE v public.job_recurrence_rules;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'job_recurrence_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO v FROM public.job_recurrence_rules r WHERE r.id=p_rule_id AND r.deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_recurrence_not_found' USING ERRCODE='P0002'; END IF;
  IF p_expected_version IS NOT NULL AND v.version<>p_expected_version THEN RAISE EXCEPTION 'job_recurrence_conflict' USING ERRCODE='PT409'; END IF;
  UPDATE public.job_recurrence_rules r SET deleted_at=now()
    WHERE r.id=p_rule_id AND r.deleted_at IS NULL AND r.version=v.version RETURNING * INTO v;
  IF NOT FOUND THEN
    IF EXISTS(SELECT 1 FROM public.job_recurrence_rules r WHERE r.id=p_rule_id AND r.version<>v.version) THEN
      RAISE EXCEPTION 'job_recurrence_conflict' USING ERRCODE='PT409'; END IF;
    RAISE EXCEPTION 'job_recurrence_denied' USING ERRCODE='42501';
  END IF;
  RETURN v;
END $function$;
REVOKE ALL ON FUNCTION public.job_recurrence_delete_v1(uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.job_recurrence_delete_v1(uuid,integer) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.job_recurrence_delete_v1(uuid,integer) TO authenticated;

-- public.job_recurrence_set_paused_v1(uuid,integer,boolean): 2 chỗ ném
CREATE OR REPLACE FUNCTION public.job_recurrence_set_paused_v1(p_rule_id uuid, p_expected_version integer, p_paused boolean)
 RETURNS job_recurrence_rules
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE v public.job_recurrence_rules;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'job_recurrence_denied' USING ERRCODE='42501'; END IF;
  IF p_paused IS NULL THEN RAISE EXCEPTION 'job_recurrence_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO v FROM public.job_recurrence_rules r WHERE r.id=p_rule_id AND r.deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_recurrence_not_found' USING ERRCODE='P0002'; END IF;
  IF p_expected_version IS NOT NULL AND v.version<>p_expected_version THEN RAISE EXCEPTION 'job_recurrence_conflict' USING ERRCODE='PT409'; END IF;
  IF (v.paused_at IS NOT NULL)=p_paused THEN RAISE EXCEPTION 'job_recurrence_unchanged' USING ERRCODE='22023'; END IF;
  UPDATE public.job_recurrence_rules r SET paused_at=CASE WHEN p_paused THEN now() END
    WHERE r.id=p_rule_id AND r.deleted_at IS NULL AND r.version=v.version RETURNING * INTO v;
  IF NOT FOUND THEN
    IF EXISTS(SELECT 1 FROM public.job_recurrence_rules r WHERE r.id=p_rule_id AND r.version<>v.version) THEN
      RAISE EXCEPTION 'job_recurrence_conflict' USING ERRCODE='PT409'; END IF;
    RAISE EXCEPTION 'job_recurrence_denied' USING ERRCODE='42501';
  END IF;
  RETURN v;
END $function$;
REVOKE ALL ON FUNCTION public.job_recurrence_set_paused_v1(uuid,integer,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.job_recurrence_set_paused_v1(uuid,integer,boolean) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.job_recurrence_set_paused_v1(uuid,integer,boolean) TO authenticated;

-- public.job_recurrence_update_v1(uuid,integer,jsonb): 2 chỗ ném
CREATE OR REPLACE FUNCTION public.job_recurrence_update_v1(p_rule_id uuid, p_expected_version integer, p_changes jsonb)
 RETURNS job_recurrence_rules
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE v public.job_recurrence_rules; c jsonb:=COALESCE(p_changes,'{}'::jsonb);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'job_recurrence_denied' USING ERRCODE='42501'; END IF;
  IF pg_catalog.jsonb_typeof(c)<>'object' OR c='{}'::jsonb OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(c) k WHERE k NOT IN ('title',
      'description','assignee_id','priority','frequency','every','weekdays','month_day','start_date','end_date','due_days')) THEN
    RAISE EXCEPTION 'job_recurrence_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO v FROM public.job_recurrence_rules r WHERE r.id=p_rule_id AND r.deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_recurrence_not_found' USING ERRCODE='P0002'; END IF;
  IF p_expected_version IS NOT NULL AND v.version<>p_expected_version THEN RAISE EXCEPTION 'job_recurrence_conflict' USING ERRCODE='PT409'; END IF;
  UPDATE public.job_recurrence_rules r SET
    title=CASE WHEN c ? 'title' THEN c->>'title' ELSE r.title END,
    description=CASE WHEN c ? 'description' THEN c->>'description' ELSE r.description END,
    assignee_id=CASE WHEN c ? 'assignee_id' THEN (c->>'assignee_id')::uuid ELSE r.assignee_id END,
    priority=CASE WHEN c ? 'priority' THEN c->>'priority' ELSE r.priority END,
    frequency=CASE WHEN c ? 'frequency' THEN c->>'frequency' ELSE r.frequency END,
    every=CASE WHEN c ? 'every' THEN (c->>'every')::smallint ELSE r.every END,
    weekdays=CASE WHEN c ? 'weekdays' THEN (SELECT pg_catalog.array_agg(x::smallint) FROM pg_catalog.jsonb_array_elements_text(
      CASE WHEN pg_catalog.jsonb_typeof(c->'weekdays')='array' THEN c->'weekdays' ELSE '[]'::jsonb END) x) ELSE r.weekdays END,
    month_day=CASE WHEN c ? 'month_day' THEN (c->>'month_day')::smallint ELSE r.month_day END,
    start_date=CASE WHEN c ? 'start_date' THEN (c->>'start_date')::date ELSE r.start_date END,
    end_date=CASE WHEN c ? 'end_date' THEN (c->>'end_date')::date ELSE r.end_date END,
    due_days=CASE WHEN c ? 'due_days' THEN (c->>'due_days')::smallint ELSE r.due_days END
  WHERE r.id=p_rule_id AND r.deleted_at IS NULL AND r.version=v.version
  RETURNING * INTO v;
  IF NOT FOUND THEN
    IF EXISTS(SELECT 1 FROM public.job_recurrence_rules r WHERE r.id=p_rule_id AND r.version<>v.version) THEN
      RAISE EXCEPTION 'job_recurrence_conflict' USING ERRCODE='PT409'; END IF;
    RAISE EXCEPTION 'job_recurrence_denied' USING ERRCODE='42501';
  END IF;
  RETURN v;
END $function$;
REVOKE ALL ON FUNCTION public.job_recurrence_update_v1(uuid,integer,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.job_recurrence_update_v1(uuid,integer,jsonb) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.job_recurrence_update_v1(uuid,integer,jsonb) TO authenticated;

-- public.landlord_operation_upsert_v1(uuid,text,numeric,date,uuid[],text,boolean,numeric,boolean,date,numeric,timestamp with time zone,numeric,text): 1 chỗ ném
CREATE OR REPLACE FUNCTION public.landlord_operation_upsert_v1(p_building_id uuid, p_landlord_name text, p_manager_percent numeric, p_effective_from date, p_landlord_account_ids uuid[], p_note text DEFAULT NULL::text, p_is_active boolean DEFAULT true, p_opening_balance numeric DEFAULT 0, p_opening_confirmed boolean DEFAULT false, p_terms_from date DEFAULT NULL::date, p_opening_seen_pre_start numeric DEFAULT NULL::numeric, p_expected_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_manager_fixed_amount numeric DEFAULT NULL::numeric, p_deposit_holder text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor        uuid := auth.uid();
  v_org          uuid;
  v_opening      numeric := COALESCE(p_opening_balance, 0);
  v_name         text := NULLIF(btrim(COALESCE(p_landlord_name, '')), '');
  v_note         text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_from         date := date_trunc('month', p_effective_from)::date;
  v_ids          uuid[];
  v_bad          integer;
  v_old          app_private.landlord_operations%ROWTYPE;
  v_exists       boolean;
  v_latest       app_private.landlord_operation_terms%ROWTYPE;
  v_prev         app_private.landlord_operation_terms%ROWTYPE;
  v_base         date;
  v_terms_from   date;
  v_first_closed date;
  v_last_closed  date;
  v_blocked      date;
  v_pct_change   boolean;
  v_fixed_change boolean;
  v_ids_change   boolean;
  v_fixed        numeric;
  v_holder       text;
  v_zero_month   date;
  v_pre          numeric;
  v_first_ids_before uuid[];
  v_first_ids_after  uuid[];
  v_reconfirm    boolean := false;
  v_before       jsonb;
  v_after        jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT app_private.landlord_actor_can_manage_v1(p_building_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành'
      USING ERRCODE = '42501';
  END IF;
  SELECT b.organization_id INTO v_org FROM public.buildings b WHERE b.id = p_building_id;

  IF v_name IS NULL OR length(v_name) > 120 THEN
    RAISE EXCEPTION 'Tên chủ nhà phải có, tối đa 120 ký tự' USING ERRCODE = '22023';
  END IF;
  IF p_manager_percent IS NULL OR p_manager_percent < 0 OR p_manager_percent > 100
     OR p_manager_percent <> round(p_manager_percent, 2) THEN
    RAISE EXCEPTION 'Tỷ lệ quản lý phải từ 0 đến 100, tối đa 2 chữ số thập phân' USING ERRCODE = '22023';
  END IF;
  IF p_manager_fixed_amount IS NOT NULL
     AND (p_manager_fixed_amount < 0 OR p_manager_fixed_amount <> round(p_manager_fixed_amount)
          OR p_manager_fixed_amount >= 1e13) THEN
    RAISE EXCEPTION 'Tiền quản lý nhận cố định phải là số nguyên đồng, từ 0 trở lên' USING ERRCODE = '22023';
  END IF;
  IF p_deposit_holder IS NOT NULL AND p_deposit_holder NOT IN ('MANAGER', 'LANDLORD') THEN
    RAISE EXCEPTION 'Người giữ cọc chỉ là quản lý hoặc chủ nhà' USING ERRCODE = '22023';
  END IF;
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'Thiếu tháng bắt đầu áp dụng' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'Ghi chú tối đa 500 ký tự' USING ERRCODE = '22023';
  END IF;
  IF v_opening <> round(v_opening) OR abs(v_opening) >= 1e13 THEN
    RAISE EXCEPTION 'Số dư đầu kỳ phải là số nguyên đồng' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[]) INTO v_ids
    FROM unnest(COALESCE(p_landlord_account_ids, '{}'::uuid[])) AS x
   WHERE x IS NOT NULL;
  IF cardinality(v_ids) = 0 OR cardinality(v_ids) > 20 THEN
    RAISE EXCEPTION 'Chọn từ 1 đến 20 sổ quỹ của chủ nhà' USING ERRCODE = '22023';
  END IF;

  -- khoá cùng chìa với chốt tháng: không đổi cấu hình giữa lúc đang chốt
  PERFORM pg_advisory_xact_lock(hashtextextended('landlord_settlement:' || p_building_id::text, 0));

  SELECT * INTO v_old FROM app_private.landlord_operations o WHERE o.building_id = p_building_id FOR UPDATE;
  v_exists := FOUND;
  -- chống ghi đè: người khác đã lưu sau lúc hộp này mở ⇒ từ chối, không ghi đè số của họ (và không tạo
  -- xác nhận số dư đầu kỳ mới cho con số cũ đang hiện trên hộp)
  IF v_exists AND p_expected_updated_at IS NOT NULL
     AND v_old.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Cài đặt toà vừa được người khác sửa — đóng hộp, mở lại để xem bản mới rồi lưu lại'
      USING ERRCODE = 'PT409';
  END IF;
  -- toà mới: quản lý phải nhận % hoặc tiền cố định (hoặc cả hai)
  IF NOT v_exists AND p_manager_percent = 0 AND COALESCE(p_manager_fixed_amount, 0) = 0 THEN
    RAISE EXCEPTION 'Quản lý phải nhận %% lợi nhuận hoặc tiền cố định (hoặc cả hai) — không để cả hai bằng 0'
      USING ERRCODE = '22023';
  END IF;
  v_before := app_private.landlord_operation_state_v1(p_building_id);
  SELECT * INTO v_latest
    FROM app_private.landlord_operation_terms t
   WHERE t.building_id = p_building_id
   ORDER BY t.valid_from DESC
   LIMIT 1;
  SELECT t.landlord_account_ids INTO v_first_ids_before
    FROM app_private.landlord_operation_terms t
   WHERE t.building_id = p_building_id
   ORDER BY t.valid_from
   LIMIT 1;

  -- sổ phải thuộc công ty của toà. Sổ THÊM MỚI (chưa có ở phiên bản điều khoản nào) còn phải là sổ thật
  -- (không ảo — sổ cấn trừ, làm tròn, tiền thối không giữ tiền của ai) và chưa xoá; sổ đã có ở một phiên bản
  -- mà sau đó bị xoá/đổi ảo thì vẫn giữ được (bỏ nó là quyết định riêng, có tháng áp dụng riêng).
  SELECT count(*) INTO v_bad
    FROM unnest(v_ids) AS x
   WHERE NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = x AND a.organization_id = v_org);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Có sổ quỹ không thuộc công ty của toà — bỏ chọn sổ đó' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_bad
    FROM unnest(v_ids) AS x
    JOIN public.accounts a ON a.id = x
   WHERE a.deleted_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM app_private.landlord_operation_terms tv
                      WHERE tv.building_id = p_building_id AND x = ANY (tv.landlord_account_ids));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Có sổ quỹ đã xoá — bỏ chọn sổ đó' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_bad
    FROM unnest(v_ids) AS x
    JOIN public.accounts a ON a.id = x
   WHERE COALESCE(a.is_virtual, false)
     AND NOT EXISTS (SELECT 1 FROM app_private.landlord_operation_terms tv
                      WHERE tv.building_id = p_building_id AND x = ANY (tv.landlord_account_ids));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Sổ chủ nhà phải là sổ quỹ thật — bỏ chọn sổ ảo' USING ERRCODE = '22023';
  END IF;
  SELECT max(m), min(m) INTO v_last_closed, v_first_closed
    FROM app_private.landlord_closed_months_v1(p_building_id) AS m;

  -- tháng đã chốt phải còn nằm trong thời gian áp dụng (không thì nó biến khỏi Tổng quyết toán)
  IF v_first_closed IS NOT NULL AND v_from > v_first_closed THEN
    RAISE EXCEPTION 'Tháng % đã chốt — không dời tháng bắt đầu áp dụng ra sau tháng đã chốt (mở chốt trước)',
      to_char(v_first_closed, 'MM/YYYY') USING ERRCODE = '55000';
  END IF;

  -- người giữ cọc là cài đặt của TOÀ (áp mọi tháng): NULL = giữ nguyên (toà mới: quản lý). Đổi giữa chừng thì
  -- tiền cọc bên cũ đang giữ không tự bàn giao sang bên mới ⇒ chỉ đổi được khi toà chưa chốt tháng nào
  -- (chủ chốt 23/10/2026)
  v_holder := COALESCE(p_deposit_holder, CASE WHEN v_exists THEN v_old.deposit_holder END, 'MANAGER');
  IF v_exists AND v_holder IS DISTINCT FROM v_old.deposit_holder AND v_first_closed IS NOT NULL THEN
    RAISE EXCEPTION 'Toà đã chốt tháng % — người giữ cọc chỉ đổi được khi chưa chốt tháng nào (đổi giữa chừng thì tiền cọc đang giữ không tự bàn giao)',
      to_char(v_first_closed, 'MM/YYYY') USING ERRCODE = '55000';
  END IF;

  -- dấu xác nhận số dư đầu kỳ xử lý SAU khi điều khoản đã chuẩn hoá (cơ sở xác nhận phụ thuộc
  -- tháng áp dụng, sổ chủ nhà của điều khoản đầu và người giữ cọc)
  INSERT INTO app_private.landlord_operations AS o
    (building_id, organization_id, landlord_name, effective_from, note, is_active,
     opening_balance, deposit_holder, created_by, updated_by)
  VALUES
    (p_building_id, v_org, v_name, v_from, v_note, COALESCE(p_is_active, true),
     v_opening, v_holder, v_actor, v_actor)
  ON CONFLICT (building_id) DO UPDATE
     SET landlord_name = EXCLUDED.landlord_name,
         effective_from = EXCLUDED.effective_from,
         note = EXCLUDED.note,
         is_active = EXCLUDED.is_active,
         opening_balance = EXCLUDED.opening_balance,
         deposit_holder = EXCLUDED.deposit_holder,
         updated_by = v_actor,
         updated_at = clock_timestamp();

  IF NOT v_exists THEN
    INSERT INTO app_private.landlord_operation_terms
      (building_id, valid_from, manager_percent, manager_fixed_amount, landlord_account_ids, created_by)
    VALUES (p_building_id, v_from, p_manager_percent, COALESCE(p_manager_fixed_amount, 0), v_ids, v_actor);
    v_terms_from := v_from;
  ELSE
    -- 1. dời tháng bắt đầu: điều khoản đầu tiên luôn bắt đầu đúng tháng áp dụng
    IF v_from < v_old.effective_from THEN
      UPDATE app_private.landlord_operation_terms t
         SET valid_from = v_from
       WHERE t.building_id = p_building_id
         AND t.valid_from = (SELECT min(t2.valid_from) FROM app_private.landlord_operation_terms t2
                              WHERE t2.building_id = p_building_id);
    ELSIF v_from > v_old.effective_from THEN
      SELECT max(t.valid_from) INTO v_base
        FROM app_private.landlord_operation_terms t
       WHERE t.building_id = p_building_id AND t.valid_from <= v_from;
      DELETE FROM app_private.landlord_operation_terms t
       WHERE t.building_id = p_building_id AND t.valid_from < v_base;
      IF v_base < v_from THEN
        UPDATE app_private.landlord_operation_terms t
           SET valid_from = v_from
         WHERE t.building_id = p_building_id AND t.valid_from = v_base;
      END IF;
    END IF;

    -- 2. đổi % / tiền cố định / sổ chủ nhà TỪNG TRƯỜNG, từ tháng T (p_terms_from, mặc định ngay sau tháng
    --    chốt gần nhất) trở đi: so với điều khoản ĐANG ÁP ở T (đúng thứ màn đã hiện cho tháng đó). Trường nào
    --    đổi thì ghi trường đó cho T và mọi mốc sau T; trường không đổi giữ nguyên ở từng mốc (đổi % không kéo
    --    theo tiền cố định hay sổ của mốc khác, và ngược lại). Tháng trước T giữ điều khoản cũ.
    -- tháng trước tháng áp dụng không có trong quyết toán ⇒ T sớm hơn thì kẹp về tháng áp dụng
    v_terms_from := GREATEST(COALESCE(date_trunc('month', p_terms_from)::date,
                                      CASE WHEN v_last_closed IS NULL THEN v_from
                                           ELSE (v_last_closed + interval '1 month')::date END), v_from);
    SELECT * INTO v_prev
      FROM app_private.landlord_operation_terms t
     WHERE t.building_id = p_building_id AND t.valid_from <= v_terms_from
     ORDER BY t.valid_from DESC
     LIMIT 1;
    v_fixed := COALESCE(p_manager_fixed_amount, v_prev.manager_fixed_amount, 0);
    -- điều khoản màn đang lưu cho tháng T: quản lý phải nhận % hoặc tiền cố định (hoặc cả hai)
    IF p_manager_percent = 0 AND v_fixed = 0 THEN
      RAISE EXCEPTION 'Quản lý phải nhận %% lợi nhuận hoặc tiền cố định (hoặc cả hai) — không để cả hai bằng 0'
        USING ERRCODE = '22023';
    END IF;
    v_pct_change := v_prev.manager_percent IS DISTINCT FROM p_manager_percent;
    v_fixed_change := v_prev.manager_fixed_amount IS DISTINCT FROM v_fixed;
    v_ids_change := v_prev.landlord_account_ids IS DISTINCT FROM v_ids;
    IF NOT (v_pct_change OR v_fixed_change OR v_ids_change) THEN
      v_terms_from := NULL;
    ELSE
      IF v_terms_from < v_from THEN
        RAISE EXCEPTION 'Tháng áp dụng điều khoản mới (%) phải từ tháng bắt đầu áp dụng (%) trở đi',
          to_char(v_terms_from, 'MM/YYYY'), to_char(v_from, 'MM/YYYY') USING ERRCODE = '22023';
      END IF;
      SELECT min(m) INTO v_blocked
        FROM app_private.landlord_closed_months_v1(p_building_id) AS m
       WHERE m >= v_terms_from;
      IF v_blocked IS NOT NULL THEN
        RAISE EXCEPTION 'Tháng % đã chốt — mở chốt tháng đó trước khi đổi tỷ lệ / tiền cố định / sổ chủ nhà từ tháng %',
          to_char(v_blocked, 'MM/YYYY'), to_char(v_terms_from, 'MM/YYYY') USING ERRCODE = '55000';
      END IF;
      INSERT INTO app_private.landlord_operation_terms AS t
        (building_id, valid_from, manager_percent, manager_fixed_amount, landlord_account_ids, created_by)
      VALUES (p_building_id, v_terms_from,
              CASE WHEN v_pct_change THEN p_manager_percent ELSE v_prev.manager_percent END,
              CASE WHEN v_fixed_change THEN v_fixed ELSE v_prev.manager_fixed_amount END,
              CASE WHEN v_ids_change THEN v_ids ELSE v_prev.landlord_account_ids END, v_actor)
      ON CONFLICT (building_id, valid_from) DO UPDATE
         SET manager_percent = EXCLUDED.manager_percent,
             manager_fixed_amount = EXCLUDED.manager_fixed_amount,
             landlord_account_ids = EXCLUDED.landlord_account_ids;
      UPDATE app_private.landlord_operation_terms t
         SET manager_percent = CASE WHEN v_pct_change THEN p_manager_percent ELSE t.manager_percent END,
             manager_fixed_amount = CASE WHEN v_fixed_change THEN v_fixed ELSE t.manager_fixed_amount END,
             landlord_account_ids = CASE WHEN v_ids_change THEN v_ids ELSE t.landlord_account_ids END
       WHERE t.building_id = p_building_id AND t.valid_from > v_terms_from;
      -- đổi một trường mà mốc sau T giữ trường kia ⇒ mốc đó có thể thành 0% + 0đ: không cho lưu
      SELECT min(t.valid_from) INTO v_zero_month
        FROM app_private.landlord_operation_terms t
       WHERE t.building_id = p_building_id AND t.valid_from > v_terms_from
         AND t.manager_percent = 0 AND t.manager_fixed_amount = 0;
      IF v_zero_month IS NOT NULL THEN
        RAISE EXCEPTION 'Từ tháng % quản lý sẽ không nhận gì (0%% và 0đ cố định) — sửa cả điều khoản từ tháng đó',
          to_char(v_zero_month, 'MM/YYYY') USING ERRCODE = '22023';
      END IF;
      -- gộp mốc trùng y điều khoản ngay trước nó
      DELETE FROM app_private.landlord_operation_terms t
       USING (SELECT x.valid_from,
                     x.manager_percent = lag(x.manager_percent) OVER w
                     AND x.manager_fixed_amount = lag(x.manager_fixed_amount) OVER w
                     AND x.landlord_account_ids = lag(x.landlord_account_ids) OVER w AS trung
                FROM app_private.landlord_operation_terms x
               WHERE x.building_id = p_building_id
              WINDOW w AS (ORDER BY x.valid_from)) d
       WHERE t.building_id = p_building_id AND t.valid_from = d.valid_from AND d.trung;
    END IF;
  END IF;

  IF (SELECT min(t.valid_from) FROM app_private.landlord_operation_terms t
       WHERE t.building_id = p_building_id) IS DISTINCT FROM v_from THEN
    RAISE EXCEPTION 'Điều khoản đầu tiên phải bắt đầu đúng tháng áp dụng' USING ERRCODE = 'XX000';
  END IF;

  -- số dư đầu kỳ. Dấu xác nhận:
  --   · giữ nguyên khi số dư, tháng áp dụng, cọc trước kỳ (gợi ý) VÀ người giữ cọc đều y như lúc xác nhận;
  --   · xác nhận MỚI chỉ nhận khi cơ sở KHÔNG đổi trong chính lần lưu này (không phải tạo mới, không
  --     dời tháng áp dụng, không đổi sổ của điều khoản đầu, không đổi người giữ cọc) VÀ số cọc trước kỳ
  --     người dùng đã thấy (p_opening_seen_pre_start) bằng đúng số hiện tại — không ai "xác nhận" một con
  --     số chưa từng thấy;
  --   · còn lại bỏ dấu, báo màn mở lại để đối chiếu (opening_needs_reconfirm).
  -- Đổi người giữ cọc đổi nghĩa của số dư đầu kỳ (cọc trước kỳ bên nào bàn giao cho bên nào) ⇒ luôn phải đối
  -- chiếu lại, kể cả khi gợi ý tình cờ ra cùng một số ở hai chế độ (vd cả hai bằng 0).
  v_pre := app_private.landlord_pre_start_deposits_v1(p_building_id);
  SELECT t.landlord_account_ids INTO v_first_ids_after
    FROM app_private.landlord_operation_terms t
   WHERE t.building_id = p_building_id
   ORDER BY t.valid_from
   LIMIT 1;
  IF COALESCE(p_opening_confirmed, false) THEN
    IF v_exists AND v_old.opening_confirmed_at IS NOT NULL
       AND v_old.opening_balance = v_opening
       AND v_old.opening_confirmed_from = v_from
       AND v_old.opening_confirmed_pre_start = v_pre
       AND v_old.deposit_holder = v_holder THEN
      NULL;  -- xác nhận cũ còn nguyên hiệu lực
    ELSIF v_exists AND v_old.effective_from = v_from
          AND v_first_ids_before IS NOT DISTINCT FROM v_first_ids_after
          AND v_old.deposit_holder = v_holder
          AND p_opening_seen_pre_start IS NOT DISTINCT FROM v_pre THEN
      UPDATE app_private.landlord_operations
         SET opening_confirmed_at = clock_timestamp(), opening_confirmed_by = v_actor,
             opening_confirmed_from = v_from, opening_confirmed_pre_start = v_pre
       WHERE building_id = p_building_id;
    ELSE
      v_reconfirm := true;
      UPDATE app_private.landlord_operations
         SET opening_confirmed_at = NULL, opening_confirmed_by = NULL,
             opening_confirmed_from = NULL, opening_confirmed_pre_start = NULL
       WHERE building_id = p_building_id AND opening_confirmed_at IS NOT NULL;
    END IF;
  ELSE
    UPDATE app_private.landlord_operations
       SET opening_confirmed_at = NULL, opening_confirmed_by = NULL,
           opening_confirmed_from = NULL, opening_confirmed_pre_start = NULL
     WHERE building_id = p_building_id AND opening_confirmed_at IS NOT NULL;
  END IF;

  v_after := app_private.landlord_operation_state_v1(p_building_id);
  IF v_before IS DISTINCT FROM v_after THEN
    INSERT INTO app_private.landlord_operation_changes (organization_id, building_id, actor, before, after)
    VALUES (v_org, p_building_id, v_actor, v_before, v_after);
  END IF;

  RETURN jsonb_build_object('building_id', p_building_id, 'created', NOT v_exists, 'terms_from', v_terms_from,
                            'opening_needs_reconfirm', v_reconfirm,
                            -- sau lần lưu: còn phải đối chiếu số dư đầu kỳ thì mới chốt được
                            'opening_needs_confirm', COALESCE((SELECT c.needs_confirm
                                                                 FROM app_private.landlord_opening_check_v1(p_building_id) AS c), false));
END
$function$;
REVOKE ALL ON FUNCTION public.landlord_operation_upsert_v1(uuid,text,numeric,date,uuid[],text,boolean,numeric,boolean,date,numeric,timestamp with time zone,numeric,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.landlord_operation_upsert_v1(uuid,text,numeric,date,uuid[],text,boolean,numeric,boolean,date,numeric,timestamp with time zone,numeric,text) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.landlord_operation_upsert_v1(uuid,text,numeric,date,uuid[],text,boolean,numeric,boolean,date,numeric,timestamp with time zone,numeric,text) TO authenticated, service_role;

-- public.landlord_portal_confirm_v1(text,text,text,date,integer,text): 1 chỗ ném
CREATE OR REPLACE FUNCTION public.landlord_portal_confirm_v1(p_slug text, p_session text, p_building text, p_month date, p_revision integer, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_slug  text := lower(btrim(COALESCE(p_slug, '')));
  v_user  uuid := app_private.landlord_portal_viewer_v1(lower(btrim(COALESCE(p_slug, ''))), p_session);
  v_bid   uuid;
  v_month date := date_trunc('month', p_month)::date;
  v_note  text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_last  app_private.landlord_settlement_closes%ROWTYPE;
  v_at    timestamptz;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Phiên đăng nhập đã hết — nhập lại mã PIN' USING ERRCODE = 'P0002';
  END IF;
  SELECT t.building_id INTO v_bid FROM app_private.landlord_portal_buildings_v1(v_slug) t WHERE t.ma = p_building;
  IF v_bid IS NULL THEN
    RAISE EXCEPTION 'Toà này không còn trong link — tải lại trang' USING ERRCODE = 'P0002';
  END IF;
  IF v_month IS NULL OR p_revision IS NULL THEN
    RAISE EXCEPTION 'Thiếu tháng hoặc lần chốt cần xác nhận' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'Ghi chú tối đa 500 ký tự' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('landlord_settlement:' || v_bid::text, 0));

  SELECT * INTO v_last
    FROM app_private.landlord_settlement_closes c
   WHERE c.building_id = v_bid AND c.period_month = v_month
   ORDER BY c.revision DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tháng % chưa chốt — xác nhận sau khi bên quản lý chốt tháng', to_char(v_month, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;
  IF v_last.revision <> p_revision THEN
    RAISE EXCEPTION 'Bên quản lý vừa mở chốt hoặc chốt lại tháng % — tải lại trang để xem số mới rồi xác nhận',
      to_char(v_month, 'MM/YYYY') USING ERRCODE = 'PT409';
  END IF;
  IF v_last.action <> 'CLOSE' THEN
    RAISE EXCEPTION 'Tháng % chưa chốt — xác nhận sau khi bên quản lý chốt tháng', to_char(v_month, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app_private.landlord_settlement_confirmations
    (organization_id, building_id, period_month, close_revision, note, share_token, portal_user_id)
  VALUES (v_last.organization_id, v_bid, v_month, v_last.revision, v_note, NULL, v_user)
  ON CONFLICT (building_id, period_month, close_revision) DO NOTHING
  RETURNING confirmed_at INTO v_at;
  IF v_at IS NULL THEN
    SELECT k.confirmed_at INTO v_at
      FROM app_private.landlord_settlement_confirmations k
     WHERE k.building_id = v_bid AND k.period_month = v_month AND k.close_revision = v_last.revision;
    RETURN jsonb_build_object('status', 'ALREADY_CONFIRMED', 'confirmed_at', v_at);
  END IF;
  RETURN jsonb_build_object('status', 'CONFIRMED', 'confirmed_at', v_at);
END
$function$;
REVOKE ALL ON FUNCTION public.landlord_portal_confirm_v1(text,text,text,date,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.landlord_portal_confirm_v1(text,text,text,date,integer,text) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.landlord_portal_confirm_v1(text,text,text,date,integer,text) TO anon, authenticated, service_role;

-- public.landlord_settlement_close_v1(uuid,date,text,text): 1 chỗ ném
CREATE OR REPLACE FUNCTION public.landlord_settlement_close_v1(p_building_id uuid, p_month date, p_expected_hash text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_month date := date_trunc('month', p_month)::date;
  v_now   date := app_private.landlord_current_month_v1();
  v_cfg   app_private.landlord_operations%ROWTYPE;
  v_live  jsonb;
  v_last  app_private.landlord_settlement_closes%ROWTYPE;
  v_has   boolean;
  v_note  text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_rev   integer;
  v_pending integer;
  v_blockers jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT app_private.landlord_actor_can_manage_v1(p_building_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành'
      USING ERRCODE = '42501';
  END IF;
  IF v_month IS NULL THEN
    RAISE EXCEPTION 'Thiếu tháng cần chốt' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN
    RAISE EXCEPTION 'Ghi chú tối đa 1000 ký tự' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('landlord_settlement:' || p_building_id::text, 0));

  SELECT * INTO v_cfg FROM app_private.landlord_operations o WHERE o.building_id = p_building_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Toà này chưa cài đặt vận hành cho chủ nhà' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_cfg.is_active THEN
    RAISE EXCEPTION 'Toà đang ngừng áp dụng vận hành cho chủ nhà' USING ERRCODE = '55000';
  END IF;
  IF v_month < v_cfg.effective_from THEN
    RAISE EXCEPTION 'Tháng % trước tháng bắt đầu áp dụng', to_char(v_month, 'MM/YYYY') USING ERRCODE = '22023';
  END IF;
  IF v_month >= v_now THEN
    RAISE EXCEPTION 'Tháng % chưa kết thúc — chỉ chốt được tháng đã qua', to_char(v_month, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;

  v_live := app_private.landlord_settlement_compute_v1(p_building_id, v_month);
  v_pending := COALESCE((v_live->'pending'->>'voucher_count')::integer, 0);

  SELECT * INTO v_last
    FROM app_private.landlord_settlement_closes c
   WHERE c.building_id = p_building_id AND c.period_month = v_month
   ORDER BY c.revision DESC
   LIMIT 1;
  v_has := FOUND;

  IF v_has AND v_last.action = 'CLOSE' THEN
    IF v_last.source_hash = v_live->>'source_hash' THEN
      RETURN jsonb_build_object('status', 'ALREADY_CLOSED', 'revision', v_last.revision);
    END IF;
    RAISE EXCEPTION 'Tháng % đã chốt nhưng phiếu đã thay đổi — mở chốt rồi chốt lại', to_char(v_month, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;
  IF v_pending > 0 THEN
    RAISE EXCEPTION 'Còn % phiếu chờ duyệt trong tháng % — duyệt hoặc huỷ trước khi chốt',
      v_pending, to_char(v_month, 'MM/YYYY') USING ERRCODE = '55000';
  END IF;
  IF COALESCE((v_live->>'reversed_voucher_count')::integer, 0) > 0 THEN
    RAISE EXCEPTION 'Có % phiếu đã duyệt nhưng bút toán sổ quỹ đã bị đảo (tiền không còn ở sổ nào) trong tháng % — xử lý phiếu trước khi chốt',
      (v_live->>'reversed_voucher_count')::integer, to_char(v_month, 'MM/YYYY') USING ERRCODE = '55000';
  END IF;
  -- các lý do còn lại dùng chung với màn (landlord_close_blockers_v1)
  v_blockers := app_private.landlord_close_blockers_v1(p_building_id, v_month, v_live);
  IF v_blockers ? 'FOREIGN_LANDLORD_ACCOUNT' THEN
    RAISE EXCEPTION 'Có % phiếu trong tháng % dùng sổ chủ nhà của toà vận hành khác — chuyển phiếu về đúng sổ hoặc thêm sổ đó vào sổ chủ nhà của toà này',
      (v_live->>'foreign_account_voucher_count')::integer, to_char(v_month, 'MM/YYYY') USING ERRCODE = '55000';
  END IF;
  IF v_blockers ? 'UNPOSTED_POSTINGS' THEN
    RAISE EXCEPTION 'Có % phiếu đã duyệt nhưng chưa ghi sổ quỹ (tiền chưa thực vào/ra) trong tháng % — ghi sổ hoặc huỷ trước khi chốt',
      (v_live->>'unposted_voucher_count')::integer, to_char(v_month, 'MM/YYYY') USING ERRCODE = '55000';
  END IF;
  IF v_blockers ? 'LANDLORD_ACCOUNT_ELSEWHERE' THEN
    RAISE EXCEPTION 'Có phiếu của toà khác ghi vào sổ chủ nhà của toà này trong tháng % — chuyển phiếu về đúng sổ trước khi chốt',
      to_char(v_month, 'MM/YYYY') USING ERRCODE = '55000';
  END IF;
  IF v_blockers ? 'PRE_START_PENDING' THEN
    RAISE EXCEPTION 'Còn phiếu chờ duyệt ghi ngày trước tháng bắt đầu áp dụng — duyệt hoặc huỷ trước khi chốt tháng đầu tiên'
      USING ERRCODE = '55000';
  END IF;
  IF v_blockers ? 'OPENING_UNCONFIRMED' THEN
    RAISE EXCEPTION 'Chưa xác nhận số dư đầu kỳ với chủ nhà — vào Cài đặt toà, đối chiếu rồi đánh dấu đã xác nhận'
      USING ERRCODE = '55000';
  END IF;
  IF p_expected_hash IS DISTINCT FROM v_live->>'source_hash' THEN
    RAISE EXCEPTION 'Số liệu vừa thay đổi — tải lại màn rồi chốt' USING ERRCODE = 'PT409';
  END IF;

  v_rev := COALESCE(CASE WHEN v_has THEN v_last.revision END, 0) + 1;
  INSERT INTO app_private.landlord_settlement_closes
    (organization_id, building_id, period_month, revision, action,
     snapshot, source_hash, net_amount, reason, actor)
  VALUES
    (v_cfg.organization_id, p_building_id, v_month, v_rev, 'CLOSE',
     v_live, v_live->>'source_hash', (v_live->'totals'->>'landlord_owes_manager')::numeric, v_note, v_actor);

  RETURN jsonb_build_object('status', 'CLOSED', 'revision', v_rev);
END
$function$;
REVOKE ALL ON FUNCTION public.landlord_settlement_close_v1(uuid,date,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.landlord_settlement_close_v1(uuid,date,text,text) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.landlord_settlement_close_v1(uuid,date,text,text) TO authenticated, service_role;

-- public.landlord_settlement_confirm_v1(text,date,integer,text): 1 chỗ ném
CREATE OR REPLACE FUNCTION public.landlord_settlement_confirm_v1(p_token text, p_month date, p_revision integer, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_link  app_private.landlord_share_links%ROWTYPE;
  v_cfg   app_private.landlord_operations%ROWTYPE;
  v_month date := date_trunc('month', p_month)::date;
  v_note  text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_last  app_private.landlord_settlement_closes%ROWTYPE;
  v_at    timestamptz;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{32,64}$' THEN
    RAISE EXCEPTION 'Link không còn hiệu lực — liên hệ bên quản lý để nhận link mới' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_link
    FROM app_private.landlord_share_links l
   WHERE l.token = p_token AND l.revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Link không còn hiệu lực — liên hệ bên quản lý để nhận link mới' USING ERRCODE = 'P0002';
  END IF;
  SELECT o.* INTO v_cfg
    FROM app_private.landlord_operations o
    JOIN public.buildings b ON b.id = o.building_id
   WHERE o.building_id = v_link.building_id AND o.is_active
     AND b.deleted_at IS NULL AND NOT COALESCE(b.is_virtual, false);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Link không còn hiệu lực — liên hệ bên quản lý để nhận link mới' USING ERRCODE = 'P0002';
  END IF;
  IF v_month IS NULL OR p_revision IS NULL THEN
    RAISE EXCEPTION 'Thiếu tháng hoặc lần chốt cần xác nhận' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'Ghi chú tối đa 500 ký tự' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('landlord_settlement:' || v_link.building_id::text, 0));

  SELECT * INTO v_last
    FROM app_private.landlord_settlement_closes c
   WHERE c.building_id = v_link.building_id AND c.period_month = v_month
   ORDER BY c.revision DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tháng % chưa chốt — xác nhận sau khi bên quản lý chốt tháng', to_char(v_month, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;
  -- trang đang cầm lần chốt cũ (bên quản lý đã mở chốt / chốt lại sau đó)
  IF v_last.revision <> p_revision THEN
    RAISE EXCEPTION 'Bên quản lý vừa mở chốt hoặc chốt lại tháng % — tải lại trang để xem số mới rồi xác nhận',
      to_char(v_month, 'MM/YYYY') USING ERRCODE = 'PT409';
  END IF;
  IF v_last.action <> 'CLOSE' THEN
    RAISE EXCEPTION 'Tháng % chưa chốt — xác nhận sau khi bên quản lý chốt tháng', to_char(v_month, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app_private.landlord_settlement_confirmations
    (organization_id, building_id, period_month, close_revision, note, share_token)
  VALUES (v_last.organization_id, v_link.building_id, v_month, v_last.revision, v_note, v_link.token)
  ON CONFLICT (building_id, period_month, close_revision) DO NOTHING
  RETURNING confirmed_at INTO v_at;
  IF v_at IS NULL THEN
    SELECT k.confirmed_at INTO v_at
      FROM app_private.landlord_settlement_confirmations k
     WHERE k.building_id = v_link.building_id AND k.period_month = v_month AND k.close_revision = v_last.revision;
    RETURN jsonb_build_object('status', 'ALREADY_CONFIRMED', 'confirmed_at', v_at);
  END IF;
  RETURN jsonb_build_object('status', 'CONFIRMED', 'confirmed_at', v_at);
END
$function$;
REVOKE ALL ON FUNCTION public.landlord_settlement_confirm_v1(text,date,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.landlord_settlement_confirm_v1(text,date,integer,text) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.landlord_settlement_confirm_v1(text,date,integer,text) TO anon, authenticated, service_role;

-- public.landlord_settlement_note_update_v1(uuid,date,integer,text): 1 chỗ ném
CREATE OR REPLACE FUNCTION public.landlord_settlement_note_update_v1(p_building_id uuid, p_month date, p_revision integer, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_month date := date_trunc('month', p_month)::date;
  v_note  text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_last  app_private.landlord_settlement_closes%ROWTYPE;
  v_cur   text;
  v_cur_at timestamptz;
  v_at    timestamptz;
BEGIN
  IF auth.uid() IS NULL OR NOT app_private.landlord_actor_can_manage_v1(p_building_id) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống được xem và quyết toán toà vận hành'
      USING ERRCODE = '42501';
  END IF;
  IF v_month IS NULL OR p_revision IS NULL THEN
    RAISE EXCEPTION 'Thiếu tháng hoặc lần chốt cần sửa ghi chú' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN
    RAISE EXCEPTION 'Ghi chú bàn giao tối đa 1000 ký tự' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('landlord_settlement:' || p_building_id::text, 0));

  SELECT * INTO v_last
    FROM app_private.landlord_settlement_closes c
   WHERE c.building_id = p_building_id AND c.period_month = v_month
   ORDER BY c.revision DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tháng % chưa chốt — ghi chú bàn giao nhập khi chốt tháng', to_char(v_month, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;
  -- màn đang cầm lần chốt cũ (đã mở chốt / chốt lại sau đó)
  IF v_last.revision <> p_revision THEN
    RAISE EXCEPTION 'Tháng % vừa được mở chốt hoặc chốt lại — tải lại trang rồi sửa ghi chú', to_char(v_month, 'MM/YYYY')
      USING ERRCODE = 'PT409';
  END IF;
  IF v_last.action <> 'CLOSE' THEN
    RAISE EXCEPTION 'Tháng % chưa chốt — ghi chú bàn giao nhập khi chốt tháng', to_char(v_month, 'MM/YYYY')
      USING ERRCODE = '55000';
  END IF;

  SELECT h.note, h.created_at INTO v_cur, v_cur_at
    FROM app_private.landlord_settlement_handovers h
   WHERE h.building_id = p_building_id AND h.period_month = v_month AND h.close_revision = v_last.revision
   ORDER BY h.created_at DESC, h.id DESC
   LIMIT 1;
  IF NOT FOUND THEN
    v_cur := v_last.reason;
    v_cur_at := v_last.created_at;
  END IF;
  IF v_cur IS NOT DISTINCT FROM v_note THEN
    RETURN jsonb_build_object('status', 'UNCHANGED', 'revision', v_last.revision, 'updated_at', v_cur_at);
  END IF;

  INSERT INTO app_private.landlord_settlement_handovers
    (organization_id, building_id, period_month, close_revision, note, actor)
  VALUES (v_last.organization_id, p_building_id, v_month, v_last.revision, v_note, v_actor)
  RETURNING created_at INTO v_at;

  RETURN jsonb_build_object('status', 'UPDATED', 'revision', v_last.revision, 'updated_at', v_at);
END
$function$;
REVOKE ALL ON FUNCTION public.landlord_settlement_note_update_v1(uuid,date,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.landlord_settlement_note_update_v1(uuid,date,integer,text) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.landlord_settlement_note_update_v1(uuid,date,integer,text) TO authenticated, service_role;

-- public.network_center_resume_organization_v1(uuid,bigint,text,uuid): 1 chỗ ném
CREATE OR REPLACE FUNCTION public.network_center_resume_organization_v1(p_anchor_building_id uuid, p_expected_version bigint, p_reason text, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_scope record;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_now timestamptz := clock_timestamp();
  v_hash text;
  v_replay jsonb;
  v_gate public.network_org_mutation_gates%ROWTYPE;
  v_result jsonb;
BEGIN
  IF p_anchor_building_id IS NULL OR p_request_id IS NULL
     OR p_expected_version IS NULL OR p_expected_version < 1
     OR char_length(v_reason) NOT BETWEEN 8 AND 500 THEN
    RAISE EXCEPTION 'Invalid Network Center organization resume request'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_scope
  FROM app_private.network_center_require_execute_permission_v1(
    p_anchor_building_id
  );

  -- Resuming the fleet is the dangerous direction, so it is owner-only. Pausing
  -- deliberately is not: a fail-safe stop must never wait for an owner.
  IF NOT EXISTS (
    SELECT 1
    FROM public.organization_memberships membership
    WHERE membership.organization_id = v_scope.organization_id
      AND membership.user_id = v_scope.actor_id
      AND membership.member_type = 'OWNER'
      AND membership.status = 'ACTIVE'
      AND coalesce(membership.valid_from, '-infinity'::timestamptz) <= v_now
      AND (membership.valid_to IS NULL OR membership.valid_to > v_now)
  ) THEN
    RAISE EXCEPTION 'NETWORK_CENTER_ORG_RESUME_REQUIRES_OWNER'
      USING ERRCODE = '42501';
  END IF;

  v_hash := encode(extensions.digest(jsonb_build_object(
    'action', 'resume_organization',
    'buildingId', p_anchor_building_id,
    'expectedVersion', p_expected_version,
    'reason', v_reason
  )::text, 'sha256'), 'hex');
  v_replay := app_private.network_center_request_replay_v1(
    v_scope.organization_id, v_scope.actor_id, p_request_id, v_hash,
    'resume_organization'
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  SELECT gate.* INTO v_gate
  FROM public.network_org_mutation_gates gate
  WHERE gate.organization_id = v_scope.organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Network Center organization gate not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_gate.version <> p_expected_version THEN
    RAISE EXCEPTION 'Network organization gate changed; reload before resuming'
      USING ERRCODE = 'PT409';
  END IF;

  UPDATE public.network_org_mutation_gates gate
  SET mutations_paused = false,
      paused_reason = NULL,
      paused_at = NULL,
      paused_by = NULL,
      resumed_reason = v_reason,
      resumed_at = v_now,
      resumed_by = v_scope.actor_id,
      version = gate.version + 1,
      updated_at = v_now
  WHERE gate.organization_id = v_scope.organization_id
  RETURNING * INTO v_gate;

  v_result := jsonb_build_object(
    'organizationId', v_gate.organization_id,
    'mutationsPaused', v_gate.mutations_paused,
    'resumedAt', v_gate.resumed_at,
    'version', v_gate.version
  );
  PERFORM app_private.network_center_append_user_audit_v1(
    v_scope.organization_id, p_anchor_building_id, v_scope.actor_id,
    'resume_organization', 'organization', v_scope.organization_id,
    jsonb_build_object('buildingName', v_scope.building_name),
    v_reason,
    jsonb_build_object(
      'permission', 'network_center.execute',
      'requiredMemberType', 'OWNER',
      'expectedVersion', p_expected_version
    ),
    v_result, 'SUCCEEDED', NULL, p_request_id, v_hash
  );
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.network_center_resume_organization_v1(uuid,bigint,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.network_center_resume_organization_v1(uuid,bigint,text,uuid) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_resume_organization_v1(uuid,bigint,text,uuid) TO authenticated;

-- public.network_center_update_settings_v1(uuid,jsonb,bigint,uuid): 1 chỗ ném
CREATE OR REPLACE FUNCTION public.network_center_update_settings_v1(p_building_id uuid, p_settings jsonb, p_expected_version bigint, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_scope record;
  v_current public.network_site_settings%ROWTYPE;
  v_hash text;
  v_replay jsonb;
  v_result jsonb;
  v_poll integer;
  v_backup text;
  v_alert text;
BEGIN
  IF p_request_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 1
     OR p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object'
     OR octet_length(p_settings::text) > 16384
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_settings) key
       WHERE key NOT IN ('pollingSeconds', 'backupHour', 'alertSensitivity', 'dependencyGrouping', 'changesPaused')
     ) THEN
    RAISE EXCEPTION 'Invalid Network Center settings request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_scope FROM app_private.network_center_require_execute_v1(p_building_id);
  SELECT settings.* INTO v_current
  FROM public.network_site_settings settings
  WHERE settings.organization_id = v_scope.organization_id AND settings.building_id = p_building_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Network settings not found' USING ERRCODE = 'P0002'; END IF;

  IF p_settings ? 'pollingSeconds' THEN
    IF (p_settings->>'pollingSeconds') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'Polling seconds must be an integer' USING ERRCODE = '22023';
    END IF;
    v_poll := (p_settings->>'pollingSeconds')::integer;
    IF v_poll NOT BETWEEN 30 AND 300 THEN
      RAISE EXCEPTION 'Polling seconds must be between 30 and 300' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_settings ? 'backupHour' THEN
    v_backup := p_settings->>'backupHour';
    IF v_backup !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' THEN
      RAISE EXCEPTION 'Backup hour must use HH:MM' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_settings ? 'alertSensitivity' THEN
    v_alert := upper(p_settings->>'alertSensitivity');
    IF v_alert NOT IN ('STANDARD', 'STRICT') THEN
      RAISE EXCEPTION 'Invalid alert sensitivity' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF (p_settings ? 'dependencyGrouping' AND jsonb_typeof(p_settings->'dependencyGrouping') <> 'boolean')
     OR (p_settings ? 'changesPaused' AND jsonb_typeof(p_settings->'changesPaused') <> 'boolean') THEN
    RAISE EXCEPTION 'Invalid boolean Network Center setting' USING ERRCODE = '22023';
  END IF;

  v_hash := encode(extensions.digest(jsonb_build_object(
    'action', 'update_settings', 'buildingId', p_building_id,
    'expectedVersion', p_expected_version, 'settings', p_settings
  )::text, 'sha256'), 'hex');
  v_replay := app_private.network_center_request_replay_v1(
    v_scope.organization_id, v_scope.actor_id, p_request_id, v_hash, 'update_settings'
  );
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF v_current.version <> p_expected_version THEN
    RAISE EXCEPTION 'Network settings changed; reload before saving' USING ERRCODE = 'PT409';
  END IF;

  UPDATE public.network_site_settings settings
  SET poll_interval_seconds = coalesce(v_poll, settings.poll_interval_seconds),
      backup_time_local = coalesce(v_backup::time, settings.backup_time_local),
      alert_sensitivity = coalesce(v_alert, settings.alert_sensitivity),
      dependency_grouping = CASE WHEN p_settings ? 'dependencyGrouping'
        THEN (p_settings->>'dependencyGrouping')::boolean ELSE settings.dependency_grouping END,
      changes_paused = CASE WHEN p_settings ? 'changesPaused'
        THEN (p_settings->>'changesPaused')::boolean ELSE settings.changes_paused END,
      version = settings.version + 1
  WHERE settings.id = v_current.id
  RETURNING jsonb_build_object(
    'pollingSeconds', settings.poll_interval_seconds,
    'backupHour', to_char(settings.backup_time_local, 'HH24:MI'),
    'alertSensitivity', lower(settings.alert_sensitivity),
    'dependencyGrouping', settings.dependency_grouping,
    'changesPaused', settings.changes_paused,
    'version', settings.version
  ) INTO v_result;
  PERFORM app_private.network_center_append_user_audit_v1(
    v_scope.organization_id, p_building_id, v_scope.actor_id,
    'update_settings', 'building', p_building_id,
    jsonb_build_object('buildingName', v_scope.building_name),
    'Update Network Center settings', jsonb_build_object('expectedVersion', p_expected_version),
    v_result, 'SUCCEEDED', NULL, p_request_id, v_hash
  );
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.network_center_update_settings_v1(uuid,jsonb,bigint,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.network_center_update_settings_v1(uuid,jsonb,bigint,uuid) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.network_center_update_settings_v1(uuid,jsonb,bigint,uuid) TO service_role, authenticated;

-- public.profit_reset_checked_v2(uuid,date,text,text,text,uuid[],uuid[]): 1 chỗ ném
CREATE OR REPLACE FUNCTION public.profit_reset_checked_v2(p_organization_id uuid, p_period_month date, p_reason text, p_idempotency_key text, p_expected_state_hash text, p_expected_snapshot_ids uuid[], p_target_building_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_expected_hash text := lower(btrim(COALESCE(p_expected_state_hash, '')));
  v_expected_ids uuid[];
  v_existing public.profit_close_runs%ROWTYPE;
  v_existing_ids uuid[];
  v_state jsonb;
  v_current_ids uuid[];
  v_building_ids uuid[];
  v_target_ids uuid[];
  v_current_hash text;
BEGIN
  IF p_period_month IS NULL
     OR p_period_month <> date_trunc('month', p_period_month)::date THEN
    RAISE EXCEPTION 'period_month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;
  IF char_length(v_reason) NOT BETWEEN 8 AND 1000 THEN
    RAISE EXCEPTION 'reason must contain 8..1000 characters'
      USING ERRCODE = '22023';
  END IF;
  IF char_length(v_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'idempotency_key must contain 8..200 characters'
      USING ERRCODE = '22023';
  END IF;
  IF v_expected_hash !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'expected_state_hash must be a 32-character lowercase MD5'
      USING ERRCODE = '22023';
  END IF;
  IF p_expected_snapshot_ids IS NULL
     OR cardinality(p_expected_snapshot_ids) = 0
     OR array_position(p_expected_snapshot_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'expected_snapshot_ids must be a non-empty UUID array'
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(DISTINCT snapshot_id ORDER BY snapshot_id)
  INTO v_expected_ids
  FROM unnest(p_expected_snapshot_ids) snapshot_id;
  IF cardinality(v_expected_ids) <> cardinality(p_expected_snapshot_ids) THEN
    RAISE EXCEPTION 'expected_snapshot_ids contains duplicates'
      USING ERRCODE = '22023';
  END IF;

  IF p_target_building_ids IS NOT NULL THEN
    IF cardinality(p_target_building_ids) = 0
       OR array_position(p_target_building_ids, NULL) IS NOT NULL THEN
      RAISE EXCEPTION 'target_building_ids must be a non-empty UUID array'
        USING ERRCODE = '22023';
    END IF;
    SELECT array_agg(DISTINCT building_id ORDER BY building_id)
    INTO v_target_ids
    FROM unnest(p_target_building_ids) building_id;
    IF cardinality(v_target_ids) <> cardinality(p_target_building_ids) THEN
      RAISE EXCEPTION 'target_building_ids contains duplicates'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  PERFORM public._profit_assert_authorized_v2(
    p_organization_id, 'shareholder_profit.unlock'
  );

  -- Keep the same lock order as _profit_state_change_v2. Both locks are
  -- transaction-scoped and re-entrant when the checked wrapper calls it.
  PERFORM pg_advisory_xact_lock(
    hashtext(p_organization_id::text), hashtext('profit-key:' || v_key)
  );

  SELECT *
  INTO v_existing
  FROM public.profit_close_runs r
  WHERE r.organization_id = p_organization_id
    AND r.idempotency_key = v_key;

  IF FOUND THEN
    SELECT COALESCE(array_agg(
      (entry.value->'profit_monthly'->>'id')::uuid
      ORDER BY (entry.value->'profit_monthly'->>'id')::uuid
    ), '{}'::uuid[])
    INTO v_existing_ids
    FROM jsonb_array_elements(
      COALESCE(v_existing.source_snapshot->'rows', '[]'::jsonb)
    ) entry(value);

    IF v_existing.operation <> 'RESET'
       OR v_existing.period_month <> p_period_month
       OR v_existing.reason <> v_reason
       OR COALESCE(v_existing.result_snapshot->>'state_hash', '') <> v_expected_hash
       OR (
            v_target_ids IS NULL
            AND v_existing_ids IS DISTINCT FROM v_expected_ids
          )
       OR (
            v_target_ids IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM unnest(v_existing_ids) existing_id
              WHERE NOT (existing_id = ANY(v_expected_ids))
            )
          ) THEN
      RAISE EXCEPTION 'Idempotency key was already used with a different request'
        USING ERRCODE = '23505';
    END IF;

    RETURN v_existing.result_snapshot
      || jsonb_build_object('idempotent_replay', true);
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(p_organization_id::text), hashtext(p_period_month::text)
  );

  v_state := public._profit_current_state_v2(
    p_organization_id, p_period_month
  );
  v_current_hash := v_state->>'state_hash';

  SELECT COALESCE(array_agg(value::uuid ORDER BY value::uuid), '{}'::uuid[])
  INTO v_current_ids
  FROM jsonb_array_elements_text(v_state->'snapshot_ids') snapshot_id(value);

  IF v_current_ids IS DISTINCT FROM v_expected_ids
     OR v_current_hash IS DISTINCT FROM v_expected_hash THEN
    RAISE EXCEPTION
      'PROFIT_SNAPSHOT_CONFLICT current snapshots changed; reload before reset'
      USING ERRCODE = 'PT409';
  END IF;

  SELECT COALESCE(array_agg(value::uuid ORDER BY value::uuid), '{}'::uuid[])
  INTO v_building_ids
  FROM jsonb_array_elements_text(v_state->'building_ids') building_id(value);

  IF v_target_ids IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM unnest(v_target_ids) target_id
      WHERE NOT (target_id = ANY(v_building_ids))
    ) THEN
      RAISE EXCEPTION
        'Every target building must have a current period snapshot'
        USING ERRCODE = '22023';
    END IF;
    v_building_ids := v_target_ids;
  END IF;

  RETURN public._profit_state_change_v2(
    'RESET',
    p_organization_id,
    p_period_month,
    v_reason,
    v_key,
    v_building_ids,
    NULL
  );
END
$function$;
REVOKE ALL ON FUNCTION public.profit_reset_checked_v2(uuid,date,text,text,text,uuid[],uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.profit_reset_checked_v2(uuid,date,text,text,text,uuid[],uuid[]) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.profit_reset_checked_v2(uuid,date,text,text,text,uuid[],uuid[]) TO authenticated, service_role;

-- public.register_contract_draft_document(uuid,uuid,integer,uuid,uuid,jsonb,text,text,jsonb): 1 chỗ ném
CREATE OR REPLACE FUNCTION public.register_contract_draft_document(p_organization_id uuid, p_draft_id uuid, p_expected_revision integer, p_document_id uuid, p_template_id uuid, p_template_snapshot jsonb, p_document_sha256 text, p_template_sha256 text, p_document_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_draft public.contract_drafts%ROWTYPE; v_root text; v_document public.contract_draft_documents%ROWTYPE; v_form jsonb; v_rep jsonb; v_allowed boolean;
BEGIN
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO v_draft FROM public.contract_drafts WHERE id = p_draft_id AND organization_id = p_organization_id AND status <> 'DELETED' FOR UPDATE;
  IF NOT FOUND OR NOT app_private.contract_draft_scope_allowed(p_organization_id, v_draft.building_id, 'contracts.print')
    OR NOT (app_private.contract_draft_scope_allowed(p_organization_id, v_draft.building_id, 'contracts.create')
      OR app_private.contract_draft_scope_allowed(p_organization_id, v_draft.building_id, 'contracts.edit')) THEN
    RAISE EXCEPTION 'Không có quyền xuất bản nháp' USING ERRCODE = '42501';
  END IF;
  SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'contracts.print',v_draft.building_id,NULL);
  IF NOT COALESCE(v_allowed,false) THEN RAISE EXCEPTION 'Không có quyền xuất bản nháp' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_document FROM public.contract_draft_documents WHERE draft_id=p_draft_id AND revision=p_expected_revision;
  IF FOUND THEN RETURN to_jsonb(v_document) - 'document_data'; END IF;
  IF p_expected_revision IS NULL OR v_draft.revision <> p_expected_revision THEN RAISE EXCEPTION 'Bản nháp đã thay đổi' USING ERRCODE = 'PT409'; END IF;
  v_form := v_draft.payload->'form';
  SELECT value INTO v_rep FROM jsonb_array_elements(v_draft.payload->'customers') WHERE value->>'is_representative' = 'true';
  IF v_draft.room_id IS NULL OR COALESCE(v_form->>'signed_date','') = '' OR COALESCE(v_form->>'start_date','') = ''
    OR COALESCE(v_form->>'end_date','') = '' OR COALESCE(v_rep->>'full_name','') = '' OR COALESCE(v_rep->>'id_number','') = ''
    OR (SELECT count(*) FROM jsonb_array_elements(v_draft.payload->'customers') WHERE value->>'is_representative' = 'true') <> 1 THEN
    RAISE EXCEPTION 'Thiếu thông tin tài liệu nháp' USING ERRCODE = '22023';
  END IF;
  BEGIN
    IF (v_form->>'end_date')::date <= (v_form->>'start_date')::date THEN RAISE EXCEPTION 'Hạn hợp đồng không hợp lệ' USING ERRCODE = '22023'; END IF;
    PERFORM (v_form->>'signed_date')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'Ngày nháp không hợp lệ' USING ERRCODE = '22023'; END;
  IF v_draft.template_id IS DISTINCT FROM p_template_id OR NOT EXISTS (SELECT 1 FROM public.document_templates t WHERE t.id = p_template_id
    AND t.organization_id = p_organization_id AND t.deleted_at IS NULL AND t.is_active AND t.type = 'lease_contract')
    OR p_template_snapshot->>'id' IS DISTINCT FROM p_template_id::text
    OR jsonb_typeof(p_template_snapshot) <> 'object' OR jsonb_typeof(p_document_data) <> 'object'
    OR p_document_sha256 !~ '^[a-f0-9]{64}$' OR p_template_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Snapshot tài liệu không hợp lệ' USING ERRCODE = '22023';
  END IF;
  v_root := p_organization_id::text || '/' || v_draft.building_id::text || '/' || p_draft_id::text || '/' || p_expected_revision::text || '/' || p_document_id::text;
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'contract-draft-documents' AND name = v_root || '/document.docx' AND owner_id = auth.uid()::text)
    OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'contract-draft-documents' AND name = v_root || '/template.docx' AND owner_id = auth.uid()::text) THEN
    RAISE EXCEPTION 'Chưa lưu đủ tài liệu nháp' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.contract_draft_documents(id,draft_id,revision,organization_id,building_id,document_path,template_path,document_sha256,template_sha256,template_snapshot,document_data,created_by)
    VALUES(p_document_id,p_draft_id,p_expected_revision,p_organization_id,v_draft.building_id,v_root || '/document.docx',v_root || '/template.docx',p_document_sha256,p_template_sha256,p_template_snapshot,p_document_data,auth.uid())
    RETURNING * INTO v_document;
  RETURN to_jsonb(v_document) - 'document_data';
END $function$;
REVOKE ALL ON FUNCTION public.register_contract_draft_document(uuid,uuid,integer,uuid,uuid,jsonb,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_contract_draft_document(uuid,uuid,integer,uuid,uuid,jsonb,text,text,jsonb) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_contract_draft_document(uuid,uuid,integer,uuid,uuid,jsonb,text,text,jsonb) TO authenticated;

-- public.save_contract_draft(uuid,uuid,uuid,jsonb,uuid,uuid,integer,uuid): 2 chỗ ném
CREATE OR REPLACE FUNCTION public.save_contract_draft(p_organization_id uuid, p_building_id uuid, p_room_id uuid, p_payload jsonb, p_template_id uuid DEFAULT NULL::uuid, p_draft_id uuid DEFAULT NULL::uuid, p_expected_revision integer DEFAULT NULL::integer, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_draft public.contract_drafts%ROWTYPE; v_item jsonb; v_form jsonb; v_key text;
  v_replay public.contract_draft_versions%ROWTYPE; v_action text; v_allowed boolean;
BEGIN
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'Thiếu định danh lần lưu nháp' USING ERRCODE = '22023'; END IF;
  v_action := CASE WHEN p_expected_revision IS NULL THEN 'contracts.create' ELSE 'contracts.edit' END;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  IF NOT app_private.contract_draft_scope_allowed(p_organization_id, p_building_id,
    v_action) THEN
    RAISE EXCEPTION 'Không có quyền lưu bản nháp' USING ERRCODE = '42501';
  END IF;
  SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,v_action,p_building_id,NULL);
  IF NOT COALESCE(v_allowed,false) THEN RAISE EXCEPTION 'Không có quyền lưu bản nháp' USING ERRCODE = '42501'; END IF;
  -- RENT_SUPPORT_PRIVATE_DRAFT_V1
  IF p_payload ? 'rent_support' OR EXISTS(SELECT 1 FROM public.contract_drafts d WHERE d.organization_id=p_organization_id AND d.id=p_draft_id AND d.payload ? 'rent_support') THEN
    IF NOT app_private.rent_support_scope_v1(p_organization_id,p_building_id,'income_expenses.view')
      OR NOT app_private.rent_support_scope_v1(p_organization_id,p_building_id,'income_expenses.create') THEN
      RAISE EXCEPTION 'Financial permissions required to edit a support draft' USING ERRCODE='42501';
    END IF;
    IF NOT(p_payload ? 'rent_support') THEN RAISE EXCEPTION 'Cannot silently remove support funding; reconcile explicitly' USING ERRCODE='22023';END IF;
  END IF;
  SELECT * INTO v_replay FROM public.contract_draft_versions WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_replay.organization_id <> p_organization_id OR v_replay.building_id <> p_building_id
      OR v_replay.created_by <> auth.uid() OR v_replay.draft_id IS DISTINCT FROM p_draft_id
      OR v_replay.revision <> COALESCE(p_expected_revision + 1,1) OR app_private.rent_support_draft_payload_v1(p_organization_id,v_replay.draft_id,v_replay.revision,v_replay.payload,true) IS DISTINCT FROM p_payload
      OR v_replay.template_id IS DISTINCT FROM p_template_id OR v_replay.room_id IS DISTINCT FROM p_room_id THEN
      RAISE EXCEPTION 'Định danh lần lưu đã dùng cho nội dung khác' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_draft FROM public.contract_drafts WHERE id = v_replay.draft_id;
    IF v_draft.status='DELETED' THEN RAISE EXCEPTION 'Bản nháp đã được xoá' USING ERRCODE='55000'; END IF;
    RETURN to_jsonb(v_draft) || jsonb_build_object('revision',v_replay.revision,'payload',app_private.rent_support_draft_payload_v1(p_organization_id,v_replay.draft_id,v_replay.revision,v_replay.payload,true),'template_id',v_replay.template_id,'room_id',v_replay.room_id,
      'updated_at',v_replay.created_at,'documents',COALESCE((SELECT jsonb_agg(to_jsonb(x) - 'document_data' ORDER BY x.created_at DESC) FROM public.contract_draft_documents x WHERE x.draft_id=v_replay.draft_id),'[]'::jsonb));
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR octet_length(p_payload::text) > 262144
    OR NOT (p_payload ?& ARRAY['form','customers','services','use_custom_services'])
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('form','customers','services','use_custom_services','owner','editor_state','rent_support'))
    OR jsonb_typeof(p_payload->'form') <> 'object' OR jsonb_typeof(p_payload->'customers') <> 'array'
    OR jsonb_typeof(p_payload->'services') <> 'array' OR jsonb_typeof(p_payload->'use_custom_services') <> 'boolean' THEN
    RAISE EXCEPTION 'Thông tin nháp không hợp lệ' USING ERRCODE = '22023';
  END IF;
  v_form := p_payload->'form';
  IF p_payload ? 'owner' THEN
    IF jsonb_typeof(p_payload->'owner') <> 'object' OR NOT ((p_payload->'owner') ?& ARRAY['name','phone','birthday','id_number','id_issue_place','id_issue_date'])
      OR EXISTS (SELECT 1 FROM jsonb_each(p_payload->'owner') e WHERE e.key NOT IN ('name','phone','birthday','id_number','id_issue_place','id_issue_date') OR jsonb_typeof(e.value) <> 'string') THEN
      RAISE EXCEPTION 'Thông tin chủ nhà nháp không hợp lệ' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF NOT (v_form ?& ARRAY['room_id','signed_date','start_date','end_date','rent_price','total_deposit','payment_cycle','start_billing_date','end_billing_date','notes','discount_months','discount_amount_per_month'])
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_form) k WHERE k NOT IN ('room_id','signed_date','start_date','end_date','rent_price','total_deposit','payment_cycle','start_billing_date','end_billing_date','notes','discount_months','discount_amount_per_month'))
    OR COALESCE(v_form->>'room_id','') IS DISTINCT FROM COALESCE(p_room_id::text,'')
    OR COALESCE(v_form->>'payment_cycle','') NOT IN ('MONTHLY','QUARTERLY','SEMI_ANNUAL','ANNUAL') THEN
    RAISE EXCEPTION 'Thông tin nháp không hợp lệ' USING ERRCODE = '22023';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['rent_price','total_deposit','discount_months','discount_amount_per_month'] LOOP
    IF jsonb_typeof(v_form->v_key) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Số tiền nháp không hợp lệ' USING ERRCODE = '22023';
    END IF;
    IF (v_form->>v_key)::numeric < 0 OR (v_form->>v_key)::numeric > 1.7976931348623157e308::numeric THEN
      RAISE EXCEPTION 'Số tiền nháp không hợp lệ' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (v_form->>'discount_months')::numeric <> trunc((v_form->>'discount_months')::numeric) THEN
    RAISE EXCEPTION 'Số tháng nháp không hợp lệ' USING ERRCODE = '22023';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['room_id','signed_date','start_date','end_date','start_billing_date','end_billing_date','notes'] LOOP
    IF jsonb_typeof(v_form->v_key) <> 'string' THEN RAISE EXCEPTION 'Trường nháp không hợp lệ' USING ERRCODE = '22023'; END IF;
  END LOOP;
  IF p_room_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.rooms r WHERE r.id = p_room_id
    AND r.building_id = p_building_id AND r.organization_id = p_organization_id AND r.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Phòng không thuộc phạm vi bản nháp' USING ERRCODE = '42501';
  END IF;
  IF p_template_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.document_templates t
    WHERE t.id = p_template_id AND t.organization_id = p_organization_id AND t.deleted_at IS NULL AND t.is_active
    AND t.type = 'lease_contract') THEN RAISE EXCEPTION 'Mẫu không thuộc tổ chức' USING ERRCODE = '42501'; END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_payload->'customers') LOOP
    IF jsonb_typeof(v_item) <> 'object' OR NOT (v_item ?& ARRAY['id','full_name','phone','id_number','is_representative','notes'])
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_item) k WHERE k NOT IN ('id','full_name','phone','id_number','is_representative','notes')) THEN
      RAISE EXCEPTION 'Thông tin khách nháp không hợp lệ' USING ERRCODE = '22023';
    END IF;
    -- Nested types must match the draft reader boundary before persisting.
    IF jsonb_typeof(v_item->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item->'full_name') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item->'phone') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item->'is_representative') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(v_item->'id_number') NOT IN ('string','null')
      OR jsonb_typeof(v_item->'notes') NOT IN ('string','null') THEN
      RAISE EXCEPTION 'Thông tin khách nháp không hợp lệ' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id::text = v_item->>'id' AND c.organization_id = p_organization_id AND c.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'Khách hàng nháp không thuộc tổ chức' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_payload->'services') LOOP
    IF jsonb_typeof(v_item) <> 'object' OR NOT (v_item ?& ARRAY['id','name','unit_price','unit','type','pricing_type','initial_reading','quantity'])
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_item) k WHERE k NOT IN ('id','name','unit_price','unit','type','pricing_type','initial_reading','quantity')) THEN
      RAISE EXCEPTION 'Thông tin dịch vụ nháp không hợp lệ' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_item->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item->'name') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item->'type') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item->'unit') NOT IN ('string','null')
      OR jsonb_typeof(v_item->'pricing_type') NOT IN ('string','null') THEN
      RAISE EXCEPTION 'Thông tin dịch vụ nháp không hợp lệ' USING ERRCODE = '22023';
    END IF;
    FOREACH v_key IN ARRAY ARRAY['unit_price','initial_reading','quantity'] LOOP
      IF jsonb_typeof(v_item->v_key) IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'Số dịch vụ nháp không hợp lệ' USING ERRCODE = '22023';
      END IF;
      IF (v_item->>v_key)::numeric < 0 OR (v_item->>v_key)::numeric > 1.7976931348623157e308::numeric THEN
        RAISE EXCEPTION 'Số dịch vụ nháp không hợp lệ' USING ERRCODE = '22023';
      END IF;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM public.services s WHERE s.id::text = v_item->>'id' AND s.organization_id = p_organization_id AND s.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'Dịch vụ nháp không thuộc tổ chức' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF p_payload ? 'editor_state' THEN PERFORM app_private.validate_contract_draft_editor_state_v1(p_payload->'editor_state',p_organization_id); END IF;
  -- RENT_SUPPORT_DRAFT_V2
  IF p_payload ? 'rent_support' THEN
    PERFORM app_private.validate_rent_support_v1(p_payload->'rent_support',NULLIF(p_payload->'form'->>'start_date','')::date,NULLIF(p_payload->'form'->>'end_date','')::date);
    IF NOT app_private.rent_support_scope_v1(p_organization_id,p_building_id,'income_expenses.create') THEN RAISE EXCEPTION 'Financial permission required for support configuration' USING ERRCODE='42501';END IF;
    IF COALESCE((p_payload->'form'->>'discount_months')::numeric,0)<>0 OR COALESCE((p_payload->'form'->>'discount_amount_per_month')::numeric,0)<>0 THEN RAISE EXCEPTION 'V2 schedule cannot also use legacy discount' USING ERRCODE='22023';END IF;
  END IF;
  IF p_expected_revision IS NULL THEN
    IF p_draft_id IS NULL THEN RAISE EXCEPTION 'Thiếu định danh bản nháp' USING ERRCODE = '22023'; END IF;
    IF EXISTS (SELECT 1 FROM public.contract_drafts WHERE id=p_draft_id) THEN RAISE EXCEPTION 'Bản nháp đã tồn tại' USING ERRCODE='PT409'; END IF;
    INSERT INTO public.contract_drafts(id,organization_id, building_id, room_id, payload, template_id, created_by)
      VALUES(p_draft_id,p_organization_id, p_building_id, p_room_id, p_payload, p_template_id, auth.uid()) RETURNING * INTO v_draft;
  ELSE
    SELECT * INTO v_draft FROM public.contract_drafts WHERE id = p_draft_id AND organization_id = p_organization_id FOR UPDATE;
    IF NOT FOUND OR v_draft.building_id <> p_building_id THEN RAISE EXCEPTION 'Không có quyền sửa bản nháp' USING ERRCODE = '42501'; END IF;
    IF p_expected_revision IS NULL OR v_draft.revision <> p_expected_revision THEN
      RAISE EXCEPTION 'Bản nháp đã thay đổi' USING ERRCODE = 'PT409';
    END IF;
    UPDATE public.contract_drafts SET room_id = p_room_id, payload = p_payload, template_id = p_template_id,
      revision = revision + 1, updated_at = now() WHERE id = p_draft_id RETURNING * INTO v_draft;
  END IF;
  INSERT INTO public.contract_draft_versions(draft_id, revision, organization_id, building_id, room_id, payload, template_id, created_by,request_id)
    VALUES(v_draft.id, v_draft.revision, v_draft.organization_id, v_draft.building_id, v_draft.room_id, v_draft.payload, v_draft.template_id, auth.uid(),p_request_id);
  IF p_payload ? 'rent_support' THEN
    INSERT INTO app_private.contract_draft_rent_support_funding(organization_id,draft_id,revision,funding)
    VALUES(p_organization_id,v_draft.id,v_draft.revision,app_private.rent_support_draft_funding_fields_v1(p_payload->'rent_support'));
  END IF;
  RETURN to_jsonb(v_draft) || jsonb_build_object('payload',app_private.rent_support_draft_payload_v1(p_organization_id,v_draft.id,v_draft.revision,v_draft.payload,true),'documents', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM public.contract_draft_documents x WHERE x.draft_id = v_draft.id), '[]'::jsonb));
END $function$;
REVOKE ALL ON FUNCTION public.save_contract_draft(uuid,uuid,uuid,jsonb,uuid,uuid,integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_contract_draft(uuid,uuid,uuid,jsonb,uuid,uuid,integer,uuid) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_contract_draft(uuid,uuid,uuid,jsonb,uuid,uuid,integer,uuid) TO authenticated;

-- public.set_copilot_action_policy_v1(bigint,text,text[],boolean,text,text): 1 chỗ ném
CREATE OR REPLACE FUNCTION public.set_copilot_action_policy_v1(p_expected_revision bigint, p_max_direct_risk text DEFAULT NULL::text, p_allowed_roles text[] DEFAULT NULL::text[], p_standing_grants_enabled boolean DEFAULT NULL::boolean, p_reason text DEFAULT NULL::text, p_evidence_link text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_cu     app_private.copilot_action_policy%ROWTYPE;
  v_moi    app_private.copilot_action_policy%ROWTYPE;
  v_actor  uuid := auth.uid();
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'copilot_policy_not_permitted' USING ERRCODE = '42501';
  END IF;

  -- Lý do và bằng chứng là BẮT BUỘC, không phải lịch sự. Van này quyết định
  -- Copilot được tự ghi tới mức nào; một lần lật không kèm lý do là một lần
  -- không ai truy được vì sao hệ thống đổi hành vi.
  IF COALESCE(btrim(p_reason), '') = '' OR COALESCE(btrim(p_evidence_link), '') = '' THEN
    RAISE EXCEPTION 'policy_reason_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_cu FROM app_private.copilot_action_policy WHERE id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'copilot_policy_missing' USING ERRCODE = 'P0002';
  END IF;

  IF p_expected_revision IS NULL OR v_cu.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'copilot_policy_stale_revision: dang o revision %, nguoi goi mong %',
      v_cu.revision, p_expected_revision
      USING ERRCODE = 'PT409';
  END IF;

  IF p_max_direct_risk IS NOT NULL AND p_max_direct_risk NOT IN ('L3', 'L4', 'L5') THEN
    RAISE EXCEPTION 'copilot_policy_risk_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_allowed_roles IS NOT NULL
     AND (cardinality(p_allowed_roles) = 0
          OR NOT (p_allowed_roles <@ ARRAY['superadmin', 'owner', 'manager', 'staff']::text[])) THEN
    RAISE EXCEPTION 'copilot_policy_roles_invalid' USING ERRCODE = '22023';
  END IF;

  -- NULL = giữ nguyên. Người gọi chỉ khai trường mình muốn đổi, nên một lần đổi
  -- trần rủi ro không vô tình reset danh sách vai.
  UPDATE app_private.copilot_action_policy
     SET max_direct_risk         = COALESCE(p_max_direct_risk, v_cu.max_direct_risk),
         allowed_roles           = COALESCE(p_allowed_roles, v_cu.allowed_roles),
         standing_grants_enabled = COALESCE(p_standing_grants_enabled, v_cu.standing_grants_enabled),
         revision                = v_cu.revision + 1,
         reason                  = btrim(p_reason),
         evidence_link           = btrim(p_evidence_link),
         updated_by              = v_actor,
         updated_at              = clock_timestamp()
   WHERE id
  RETURNING * INTO v_moi;

  INSERT INTO app_private.copilot_action_policy_audit (
    revision_before, revision_after, old, new, actor, reason, evidence_link
  )
  VALUES (
    v_cu.revision,
    v_moi.revision,
    jsonb_build_object(
      'max_direct_risk', v_cu.max_direct_risk,
      'allowed_roles', to_jsonb(v_cu.allowed_roles),
      'standing_grants_enabled', v_cu.standing_grants_enabled
    ),
    jsonb_build_object(
      'max_direct_risk', v_moi.max_direct_risk,
      'allowed_roles', to_jsonb(v_moi.allowed_roles),
      'standing_grants_enabled', v_moi.standing_grants_enabled
    ),
    v_actor,
    btrim(p_reason),
    btrim(p_evidence_link)
  );

  -- Sổ hành động cũng phải thấy lần lật van này. `copilot_action_policy_audit`
  -- là sổ riêng của policy; `copilot_action_ledger` là dòng thời gian DUY NHẤT
  -- mà G3/G5 đọc để dựng lại "chuyện gì đã xảy ra". Một thay đổi trần rủi ro
  -- không có mặt ở đó thì dòng thời gian có một lỗ đúng ngay chỗ quan trọng
  -- nhất. Không truyền `organization_id`: van là hàng toàn hệ thống.
  PERFORM app_private.copilot_ledger_append_v1(jsonb_build_object(
    'event', 'policy_changed',
    'outcome', jsonb_build_object(
      'revision_before', v_cu.revision,
      'revision_after', v_moi.revision,
      'max_direct_risk', v_moi.max_direct_risk,
      'allowed_roles', to_jsonb(v_moi.allowed_roles),
      'standing_grants_enabled', v_moi.standing_grants_enabled,
      'reason', btrim(p_reason),
      'evidence_link', btrim(p_evidence_link)
    )
  ));

  RETURN jsonb_build_object(
    'revision', v_moi.revision,
    'max_direct_risk', v_moi.max_direct_risk,
    'allowed_roles', to_jsonb(v_moi.allowed_roles),
    'standing_grants_enabled', v_moi.standing_grants_enabled
  );
END
$function$;
REVOKE ALL ON FUNCTION public.set_copilot_action_policy_v1(bigint,text,text[],boolean,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_copilot_action_policy_v1(bigint,text,text[],boolean,text,text) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_copilot_action_policy_v1(bigint,text,text[],boolean,text,text) TO authenticated;

-- public.set_copilot_feature_flag_v2(text,text,text,bigint,uuid,text,text,timestamp with time zone,text): 1 chỗ ném
CREATE OR REPLACE FUNCTION public.set_copilot_feature_flag_v2(p_scope text, p_contract_id text, p_state text, p_expected_revision bigint, p_canary_org uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text, p_evidence_link text DEFAULT NULL::text, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_rollback_reference text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_current_revision bigint;
  v_row public.copilot_feature_flags%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'expected_revision_required' USING ERRCODE = '22023';
  END IF;
  IF p_scope NOT IN ('page', 'action')
     OR btrim(COALESCE(p_contract_id, '')) = ''
     OR p_state NOT IN ('disabled', 'shadow', 'enabled') THEN
    RAISE EXCEPTION 'invalid_rollout_contract' USING ERRCODE = '22023';
  END IF;
  IF btrim(COALESCE(p_reason, '')) = ''
     OR btrim(COALESCE(p_evidence_link, '')) = ''
     OR btrim(COALESCE(p_rollback_reference, '')) = '' THEN
    RAISE EXCEPTION 'rollout_evidence_required' USING ERRCODE = '22023';
  END IF;

  -- Serialize the global CAS check before locking the individual flag row.
  PERFORM pg_advisory_xact_lock(hashtext('copilot_feature_rollout_global')::bigint);
  SELECT s.last_value
  INTO v_current_revision
  FROM public.copilot_feature_rollout_revision_seq s;
  IF v_current_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'copilot_rollout_stale_revision'
      USING ERRCODE = 'PT409',
            DETAIL = format('expected %s, current %s', p_expected_revision, v_current_revision);
  END IF;

  SELECT f.*
  INTO v_row
  FROM public.copilot_feature_flags f
  WHERE f.scope = p_scope
    AND f.contract_id = btrim(p_contract_id)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_rollout_contract' USING ERRCODE = '22023';
  END IF;
  IF v_row.state = p_state
     OR NOT (
       (v_row.state = 'disabled' AND p_state = 'shadow')
       OR (v_row.state = 'shadow' AND p_state = 'enabled')
       OR (v_row.state = 'shadow' AND p_state = 'disabled')
       OR (v_row.state = 'enabled' AND p_state = 'shadow')
       OR (v_row.state = 'enabled' AND p_state = 'disabled')
     ) THEN
    RAISE EXCEPTION 'invalid_rollout_transition'
      USING ERRCODE = '22023',
            DETAIL = format('%s -> %s', v_row.state, p_state);
  END IF;
  IF p_state = 'disabled' AND (p_canary_org IS NOT NULL OR p_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION 'disabled_rollout_cannot_be_canary_scoped' USING ERRCODE = '22023';
  END IF;
  IF p_canary_org IS NULL AND p_expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'rollout_expiry_requires_canary_org' USING ERRCODE = '22023';
  END IF;
  IF p_canary_org IS NOT NULL
     AND (p_expires_at IS NULL OR p_expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'canary_expiry_required' USING ERRCODE = '22023';
  END IF;
  IF p_canary_org IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.organizations o
    WHERE o.id = p_canary_org
      AND o.status = 'ACTIVE'
      AND NOT (o.id = ANY(public.sandbox_org_ids()))
  ) THEN
    RAISE EXCEPTION 'invalid_canary_organization' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.copilot_feature_flag_transition', 'v2', true);
  UPDATE public.copilot_feature_flags f
  SET state = p_state,
      canary_org = p_canary_org,
      updated_by = v_actor,
      reason = btrim(p_reason),
      evidence_link = btrim(p_evidence_link),
      expires_at = p_expires_at,
      rollback_reference = btrim(p_rollback_reference)
  WHERE f.scope = v_row.scope
    AND f.contract_id = v_row.contract_id
  RETURNING f.* INTO v_row;
  PERFORM set_config('app.copilot_feature_flag_transition', '', true);

  -- The existing AFTER trigger appends the immutable audit event in this
  -- transaction, carrying the trigger-assigned global revision.
  RETURN jsonb_build_object(
    'scope', v_row.scope,
    'contract_id', v_row.contract_id,
    'state', v_row.state,
    'canary_org', v_row.canary_org,
    'expires_at', v_row.expires_at,
    'revision', v_row.revision,
    'updated_by', v_row.updated_by,
    'updated_at', v_row.updated_at,
    'reason', v_row.reason,
    'evidence_link', v_row.evidence_link,
    'rollback_reference', v_row.rollback_reference
  );
END
$function$;
REVOKE ALL ON FUNCTION public.set_copilot_feature_flag_v2(text,text,text,bigint,uuid,text,text,timestamp with time zone,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_copilot_feature_flag_v2(text,text,text,bigint,uuid,text,text,timestamp with time zone,text) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_copilot_feature_flag_v2(text,text,text,bigint,uuid,text,text,timestamp with time zone,text) TO authenticated;

-- public.settle_reservation_deposit_v1(jsonb): 1 chỗ ném
CREATE OR REPLACE FUNCTION public.settle_reservation_deposit_v1(p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE v public.income_expenses; s public.reservation_deposit_settlements; basis jsonb; preview jsonb;
  refund_attachments text[]; refund_vid uuid; sid uuid:=gen_random_uuid(); rev uuid; offid uuid; acc uuid;
  refund numeric; retained numeric; mode text; day date; reason text; reason_text text;
  key text; request_hash text; fingerprint text; mid uuid;
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Dữ liệu xử lý cọc không hợp lệ' USING ERRCODE='22023'; END IF;
  SELECT * INTO v FROM public.income_expenses WHERE id=(p_input->>'voucherId')::uuid;
  IF NOT FOUND OR NOT app_private.reservation_settlement_can_read_v1(v.organization_id,v.building_id) THEN
    RAISE EXCEPTION 'Không có quyền xử lý phiếu cọc này' USING ERRCODE='42501';
  END IF;
  -- Same ordering as create_contract_v2: room -> organization -> source receipt.
  PERFORM 1 FROM public.rooms WHERE id=v.room_id FOR NO KEY UPDATE;
  PERFORM app_private.reservation_settlement_authorize_v1(v.id);
  SELECT * INTO v FROM public.income_expenses WHERE id=v.id FOR UPDATE;
  PERFORM app_private.reservation_settlement_authorize_v1(v.id);
  PERFORM 1 FROM public.income_expense_types t JOIN public.income_expense_items i ON i.income_expense_type_id=t.id
    WHERE i.income_expense_id=v.id FOR SHARE OF t;
  key:=btrim(p_input->>'idempotencyKey'); request_hash:=md5((p_input-'idempotencyKey')::text);
  IF key IS NULL OR length(key) NOT BETWEEN 8 AND 200 THEN RAISE EXCEPTION 'Mã yêu cầu không hợp lệ' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM public.reservation_deposit_settlements WHERE source_voucher_id=v.id FOR UPDATE;
  IF FOUND THEN
    IF s.request_hash IS DISTINCT FROM request_hash THEN RAISE EXCEPTION 'Phiếu cọc đã xử lý với nội dung khác; hãy tải lại' USING ERRCODE='55000'; END IF;
    IF p_input->>'refundMode'='NOW' THEN
      SELECT membership_id INTO mid FROM app_private.resolve_finance_actor_v2(s.organization_id);
      PERFORM app_private.assert_cashbook_access_v2(s.organization_id,(p_input->>'refundAccountId')::uuid,'CUSTODIAN',mid);
    END IF;
    RETURN app_private.reservation_settlement_json_v1(s.id);
  END IF;
  IF EXISTS(SELECT 1 FROM public.reservation_deposit_settlements WHERE organization_id=v.organization_id AND idempotency_key=key) THEN
    RAISE EXCEPTION 'Mã yêu cầu đã dùng cho phiếu khác' USING ERRCODE='22023';
  END IF;
  refund_attachments:=app_private.reservation_refund_attachments_v1(p_input,v.organization_id);
  IF cardinality(refund_attachments)>0 AND p_input->>'refundMode' IS DISTINCT FROM 'NOW' THEN
    RAISE EXCEPTION 'Chỉ thêm ảnh chứng từ khi hoàn tiền ngay' USING ERRCODE='22023';
  END IF;
  preview:=public.preview_reservation_settlement_v1(v.id);
  IF NOT (preview->>'canSettle')::boolean THEN
    RAISE EXCEPTION 'Phiếu cọc chưa nhận tiền, đã được dùng hoặc đang ở kỳ khóa; hãy tải lại' USING ERRCODE='55000',DETAIL=(preview->'blockers')::text;
  END IF;
  basis:=app_private.reservation_settlement_basis_v1(v.id); fingerprint:=p_input->>'basisFingerprint';
  IF fingerprint IS DISTINCT FROM basis->>'fingerprint' THEN
    RAISE EXCEPTION 'Phiếu cọc đã thay đổi; hãy tải lại trước khi xử lý' USING ERRCODE='PT409';
  END IF;
  refund:=(p_input->>'refundAmount')::numeric; mode:=p_input->>'refundMode'; day:=(p_input->>'settlementDate')::date;
  reason:=p_input->>'reasonCode'; reason_text:=btrim(COALESCE(p_input->>'reasonText',''));
  IF refund IS NULL OR refund::text IN ('NaN','Infinity','-Infinity') OR refund<0 OR refund>(basis->>'amount')::numeric OR refund<>trunc(refund)
    OR (refund=0 AND mode IS DISTINCT FROM 'NONE') OR (refund>0 AND COALESCE(mode,'') NOT IN ('NOW','LATER'))
    OR (mode<>'NOW' AND NULLIF(p_input->>'refundAccountId','') IS NOT NULL) THEN
    RAISE EXCEPTION 'Số tiền hoặc cách hoàn cọc không hợp lệ' USING ERRCODE='22023';
  END IF;
  IF day IS NULL OR day<v.voucher_date OR day>public.org_today_v1(v.organization_id)
    OR NOT app_private.finance_v2_is_recognition_period_open(v.organization_id,day) THEN
    RAISE EXCEPTION 'Ngày xử lý cọc không hợp lệ hoặc kỳ đã khóa' USING ERRCODE='55000';
  END IF;
  IF COALESCE(reason,'') NOT IN ('CHANGED_MIND','NO_SHOW','OTHER') OR (reason='OTHER' AND length(reason_text)=0) OR length(reason_text)>2000 THEN
    RAISE EXCEPTION 'Vui lòng nhập lý do bỏ cọc hợp lệ' USING ERRCODE='22023';
  END IF;
  retained:=(basis->>'amount')::numeric-refund;
  IF retained>0 THEN rev:=gen_random_uuid(); offid:=gen_random_uuid(); END IF;
  INSERT INTO app_private.reservation_settlement_write_tokens(settlement_id,xid) VALUES(sid,pg_current_xact_id());
  INSERT INTO public.reservation_deposit_settlements(id,organization_id,source_voucher_id,building_id,room_id,
    deposit_amount,retained_amount,refund_amount,settlement_date,reason_code,reason_text,created_by,basis_fingerprint,
    request_hash,idempotency_key,revenue_voucher_id,offset_voucher_id)
  VALUES(sid,v.organization_id,v.id,v.building_id,v.room_id,(basis->>'amount')::numeric,retained,refund,day,reason,reason_text,
    auth.uid(),fingerprint,request_hash,key,rev,offid);
  IF retained>0 THEN
    acc:=app_private.reservation_internal_account_v1(v.organization_id);
    PERFORM app_private.reservation_create_leg_v1(sid,'OFFSET',offid,acc,day,retained);
    PERFORM app_private.reservation_create_leg_v1(sid,'REVENUE',rev,acc,day,retained);
  END IF;
  IF mode='NOW' THEN
    refund_vid:=app_private.reservation_pay_refund_v1(sid,(p_input->>'refundAccountId')::uuid,public.org_today_v1(v.organization_id));
    UPDATE public.income_expenses SET attachments=to_jsonb(refund_attachments) WHERE id=refund_vid;
    PERFORM app_private.reservation_bind_refund_evidence_v1(sid,refund_vid);
  END IF;
  -- A hold without an exact source link remains intact and is reported to the user.
  IF app_private.reservation_room_blockers_v1(v.room_id)='[]'::jsonb THEN
    PERFORM public.recompute_room_reservation(v.room_id);
  END IF;
  PERFORM app_private.reservation_settlement_assert_v1(sid);
  DELETE FROM app_private.reservation_settlement_write_tokens WHERE settlement_id=sid AND xid=pg_current_xact_id();
  RETURN app_private.reservation_settlement_json_v1(sid);
END $function$;
REVOKE ALL ON FUNCTION public.settle_reservation_deposit_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_reservation_deposit_v1(jsonb) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.settle_reservation_deposit_v1(jsonb) TO authenticated, service_role;

-- public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[]): 4 chỗ ném
CREATE OR REPLACE FUNCTION public.sign_and_checkin_contract_draft_v1(p_organization_id uuid, p_draft_id uuid, p_expected_revision integer, p_document_id uuid, p_document_sha256 text, p_request_id uuid, p_received_on date, p_room_ready boolean, p_terms_confirmed boolean, p_boundary jsonb, p_creation_options jsonb, p_reservation_id uuid DEFAULT NULL::uuid, p_reservation_revision bigint DEFAULT NULL::bigint, p_source_voucher_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE d public.contract_drafts%ROWTYPE; a public.contract_draft_documents%ROWTYPE; s public.contract_draft_signings%ROWTYPE;
  r public.rooms%ROWTYPE; c public.contracts%ROWTYPE; v_room_id uuid; v_building_id uuid; v_allowed boolean;
  v_hash text; v_terms jsonb; f jsonb; v_party jsonb; v_payload jsonb; v_result jsonb; v_id uuid:=gen_random_uuid(); v_count integer; v_rep_count integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_request_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<1 OR p_document_id IS NULL
    OR p_document_sha256 IS NULL OR p_document_sha256 !~ '^[a-f0-9]{64}$'
    OR p_received_on IS NULL OR NOT isfinite(p_received_on) OR p_room_ready IS DISTINCT FROM true OR p_terms_confirmed IS DISTINCT FROM true
    OR jsonb_typeof(p_boundary) IS DISTINCT FROM 'object' OR p_boundary->>'state' IS DISTINCT FROM 'VERIFIED'
    OR jsonb_typeof(p_creation_options) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Cần xác nhận ngày nhận, phòng sẵn sàng, điều khoản và đủ mốc chỉ số' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_creation_options) k WHERE k NOT IN
    ('deposit_debt_mode','deposit_debt_reason','deposit_topup_due_date','first_invoice','deposit_receipts','existing_deposit_voucher_ids','invoice_template_id')) THEN
    RAISE EXCEPTION 'Lựa chọn tạo hợp đồng không hợp lệ; nhánh này không chuyển giữ chỗ hoặc thu cọc' USING ERRCODE='22023';
  END IF;
  IF (p_creation_options ? 'deposit_receipts' AND jsonb_typeof(p_creation_options->'deposit_receipts') IS DISTINCT FROM 'array')
    OR (p_creation_options ? 'existing_deposit_voucher_ids' AND jsonb_typeof(p_creation_options->'existing_deposit_voucher_ids') IS DISTINCT FROM 'array')
    OR (p_creation_options ? 'invoice_template_id' AND jsonb_typeof(p_creation_options->'invoice_template_id') NOT IN ('string','null'))
    OR (p_creation_options->>'invoice_template_id' IS NOT NULL AND p_creation_options->>'invoice_template_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_creation_options->'deposit_receipts')='array' THEN p_creation_options->'deposit_receipts' ELSE '[]'::jsonb END) x WHERE jsonb_typeof(x) IS DISTINCT FROM 'object')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_creation_options->'existing_deposit_voucher_ids')='array' THEN p_creation_options->'existing_deposit_voucher_ids' ELSE '[]'::jsonb END) x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR x#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'Lựa chọn nguồn cọc hoặc mẫu hoá đơn không hợp lệ' USING ERRCODE='22023';
  END IF;
  IF (p_reservation_id IS NULL AND (p_reservation_revision IS NOT NULL OR cardinality(COALESCE(p_source_voucher_ids,ARRAY[]::uuid[]))>0))
    OR (p_reservation_id IS NOT NULL AND (p_reservation_revision IS NULL OR p_reservation_revision<1 OR p_source_voucher_ids IS NULL))
    OR array_position(p_source_voucher_ids,NULL) IS NOT NULL
    OR cardinality(p_source_voucher_ids)<>(SELECT count(DISTINCT x) FROM unnest(p_source_voucher_ids) x) THEN
    RAISE EXCEPTION 'Nguồn giữ chỗ cần đúng ID, phiên bản và danh sách chứng từ không trùng' USING ERRCODE='22023';
  END IF;
  SELECT room_id,building_id INTO v_room_id,v_building_id FROM public.contract_drafts WHERE id=p_draft_id AND organization_id=p_organization_id;
  IF NOT FOUND OR v_room_id IS NULL OR NOT app_private.contract_draft_scope_allowed(p_organization_id,v_building_id,'contracts.create') THEN
    RAISE EXCEPTION 'Không có quyền tạo hợp đồng từ bản nháp' USING ERRCODE='42501';
  END IF;
  -- Existing create_v2 locks room then organization. Keep that order for sign versus direct-create.
  SELECT * INTO r FROM public.rooms WHERE id=v_room_id AND organization_id=p_organization_id AND building_id=v_building_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Phòng không còn thuộc phạm vi bản nháp' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'contracts.create',v_building_id,NULL);
  IF NOT COALESCE(v_allowed,false) OR NOT app_private.contract_draft_scope_allowed(p_organization_id,v_building_id,'contracts.create') THEN
    RAISE EXCEPTION 'Không có quyền tạo hợp đồng' USING ERRCODE='42501';
  END IF;
  SELECT * INTO d FROM public.contract_drafts WHERE id=p_draft_id AND organization_id=p_organization_id FOR UPDATE;
  IF d.room_id IS DISTINCT FROM v_room_id OR d.building_id<>v_building_id OR d.revision<>p_expected_revision THEN
    RAISE EXCEPTION 'Bản nháp đã đổi phiên bản hoặc phòng; tải lại trước khi ký' USING ERRCODE='PT409';
  END IF;
  SELECT * INTO a FROM public.contract_draft_documents WHERE id=p_document_id AND draft_id=d.id AND revision BETWEEN COALESCE(d.customer_revision,d.revision) AND d.revision
    AND organization_id=p_organization_id AND building_id=d.building_id AND document_sha256=p_document_sha256;
  IF NOT FOUND OR a.template_snapshot->>'id' IS DISTINCT FROM d.template_id::text THEN
    RAISE EXCEPTION 'Tài liệu đã xuất không khớp phiên bản nháp' USING ERRCODE='PT409';
  END IF;
  v_hash:=md5(jsonb_build_object('org',p_organization_id,'draft',p_draft_id,'revision',p_expected_revision,'document',p_document_id,
    'document_sha256',p_document_sha256,'received_on',p_received_on,'boundary',p_boundary,'options',p_creation_options,
    'reservation_id',p_reservation_id,'reservation_revision',p_reservation_revision,'source_voucher_ids',COALESCE(p_source_voucher_ids,ARRAY[]::uuid[]))::text);
  SELECT * INTO s FROM public.contract_draft_signings WHERE request_id=p_request_id;
  IF FOUND AND s.draft_id<>d.id THEN RAISE EXCEPTION 'Định danh ký đã dùng cho nháp khác' USING ERRCODE='23505'; END IF;
  SELECT * INTO s FROM public.contract_draft_signings WHERE draft_id=d.id;
  IF FOUND THEN
    IF s.draft_id<>d.id OR s.intent_hash<>v_hash THEN RAISE EXCEPTION 'Định danh ký hoặc bản nháp đã dùng với nội dung khác' USING ERRCODE='23505'; END IF;
    RETURN to_jsonb(s)-'intent_hash';
  END IF;
  IF d.status<>'EDITABLE' THEN RAISE EXCEPTION 'Bản nháp không còn có thể ký' USING ERRCODE='55000'; END IF;
  SELECT payload INTO v_terms FROM public.contract_draft_versions WHERE draft_id=d.id AND revision=d.revision;
  IF v_terms IS DISTINCT FROM d.payload THEN RAISE EXCEPTION 'Nội dung nháp không khớp phiên bản đã lưu' USING ERRCODE='PT409'; END IF;
  f:=v_terms->'form';
  IF f->>'room_id' IS DISTINCT FROM r.id::text OR p_received_on IS DISTINCT FROM (f->>'start_date')::date
    OR p_received_on>public.org_today_v1(p_organization_id) OR (f->>'signed_date')::date>public.org_today_v1(p_organization_id) THEN
    RAISE EXCEPTION 'Ngày nhận phải là ngày bắt đầu đã xuất, không được ở tương lai; sửa và xuất lại nháp nếu đổi ngày' USING ERRCODE='22023';
  END IF;
  IF r.status::text<>'AVAILABLE' AND NOT (r.status::text='RESERVED' AND p_reservation_id IS NOT NULL) THEN RAISE EXCEPTION 'Phòng chưa sẵn sàng nhận khách mới' USING ERRCODE='55000'; END IF;
  IF EXISTS (SELECT 1 FROM public.contracts old WHERE old.organization_id=p_organization_id AND old.room_id=r.id AND old.deleted_at IS NULL
    AND old.status::text IN ('ACTIVE','EXTENDED') AND old.actual_end_date IS NULL) THEN
    RAISE EXCEPTION 'Phòng vẫn có lượt ở chưa trả' USING ERRCODE='55000';
  END IF;
  IF (p_reservation_id IS NULL AND public.room_has_holding_deposit(r.id)) OR EXISTS (SELECT 1 FROM public.room_reservation_holds h WHERE h.room_id=r.id
    AND h.status='PENDING_APPROVAL' AND h.expires_at>clock_timestamp() AND (p_reservation_id IS NULL OR h.held_by<>auth.uid())) THEN
    RAISE EXCEPTION 'Phòng có cọc hoặc giữ chỗ; chưa hỗ trợ chuyển nguồn này từ nháp' USING ERRCODE='55P03';
  END IF;
  PERFORM 1 FROM public.room_turnovers t WHERE t.organization_id=p_organization_id AND t.room_id=r.id FOR SHARE;
  IF EXISTS (SELECT 1 FROM public.room_turnovers t WHERE t.organization_id=p_organization_id AND t.room_id=r.id AND t.status<>'READY') THEN
    RAISE EXCEPTION 'Phòng đang chuẩn bị; xác nhận sẵn sàng trước khi nhận khách' USING ERRCODE='55000';
  END IF;
  SELECT count(*),count(*) FILTER (WHERE (j->>'is_representative')::boolean) INTO v_count,v_rep_count FROM jsonb_array_elements(v_terms->'customers') j;
  IF v_count=0 OR v_rep_count<>1 OR v_count<>(SELECT count(DISTINCT j->>'id') FROM jsonb_array_elements(v_terms->'customers') j) THEN
    RAISE EXCEPTION 'Danh sách khách chưa đủ điều kiện ký' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.customers p WHERE p.id IN (SELECT (j->>'id')::uuid FROM jsonb_array_elements(v_terms->'customers') j) ORDER BY p.id FOR SHARE;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_terms->'customers') j LEFT JOIN public.customers p ON p.id=(j->>'id')::uuid
    WHERE p.id IS NULL OR p.organization_id<>p_organization_id OR p.deleted_at IS NOT NULL
      OR p.full_name IS DISTINCT FROM j->>'full_name' OR COALESCE(p.phone,'') IS DISTINCT FROM j->>'phone'
      OR p.id_number IS DISTINCT FROM j->>'id_number') THEN
    RAISE EXCEPTION 'Thông tin khách đã thay đổi; lưu và xuất lại đúng bản được ký' USING ERRCODE='PT409';
  END IF;
  -- No-claim remains usable before P9 exists; conversion never pretends support when its assertion/consumer is absent.
  IF p_reservation_id IS NOT NULL AND (to_regprocedure('app_private.assert_room_next_claim_for_signing_v1(uuid,uuid,uuid,bigint,uuid[],uuid[])') IS NULL
    OR to_regprocedure('app_private.consume_room_next_claim_v1(uuid,uuid,bigint,uuid)') IS NULL) THEN
    RAISE EXCEPTION 'Chưa hỗ trợ chuyển nguồn giữ chỗ đã chọn' USING ERRCODE='55000';
  END IF;
  IF to_regprocedure('app_private.assert_room_next_claim_for_signing_v1(uuid,uuid,uuid,bigint,uuid[],uuid[])') IS NOT NULL THEN
    PERFORM app_private.assert_room_next_claim_for_signing_v1(p_organization_id,r.id,p_reservation_id,p_reservation_revision,
      ARRAY(SELECT (j->>'id')::uuid FROM jsonb_array_elements(v_terms->'customers') j),COALESCE(p_source_voucher_ids,ARRAY[]::uuid[]));
  END IF;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) INTO v_party FROM public.customers p WHERE p.id IN (SELECT (j->>'id')::uuid FROM jsonb_array_elements(v_terms->'customers') j);
  -- The handover is separate from printed terms. Current create_v2 stores one
  -- incoming scalar per service, so use B's actual verified room measurements.
  PERFORM 1 FROM public.meters m WHERE m.organization_id=p_organization_id AND m.room_id=r.id AND m.building_id=d.building_id
    AND m.status='ACTIVE' AND m.deleted_at IS NULL ORDER BY m.id FOR SHARE;
  PERFORM app_private.validate_meter_boundary_payload_v1(p_organization_id,r.id,d.building_id,p_boundary);
  IF COALESCE((v_terms->>'use_custom_services')::boolean,false) AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_terms->'services') j
    WHERE (j->>'type'='METER_READING' OR j->>'pricing_type'='METER') AND NOT EXISTS (
      SELECT 1 FROM public.meters m WHERE m.organization_id=p_organization_id AND m.room_id=r.id AND m.building_id=d.building_id
        AND m.service_id=(j->>'id')::uuid AND m.status='ACTIVE' AND m.deleted_at IS NULL)) THEN
    RAISE EXCEPTION 'Dịch vụ đo chỉ số chưa có đồng hồ đang hoạt động gắn đúng phòng và dịch vụ' USING ERRCODE='22023';
  END IF;
  IF COALESCE((v_terms->>'use_custom_services')::boolean,false) AND EXISTS (SELECT m.service_id FROM public.meters m JOIN jsonb_array_elements(p_boundary->'readings') b ON m.id=(b->>'meter_id')::uuid
    WHERE m.organization_id=p_organization_id AND m.room_id=r.id AND m.building_id=d.building_id AND m.status='ACTIVE' AND m.deleted_at IS NULL
      AND m.service_id IN (SELECT (j->>'id')::uuid FROM jsonb_array_elements(v_terms->'services') j)
    GROUP BY m.service_id HAVING count(DISTINCT (b->>'reading')::numeric)>1) THEN
    RAISE EXCEPTION 'Nhiều đồng hồ của cùng dịch vụ có số đầu khác nhau; chưa thể ánh xạ vào dịch vụ hiện hành' USING ERRCODE='22023';
  END IF;
  -- RENT_SUPPORT_SIGN_V2
  IF v_terms ? 'rent_support' THEN
    -- RENT_SUPPORT_PRIVATE_SIGN_V1: hydrate only the canonical write input, not the public signing snapshot.
    PERFORM app_private.validate_rent_support_v1(app_private.rent_support_draft_payload_v1(p_organization_id,d.id,d.revision,v_terms,true)->'rent_support',(f->>'start_date')::date,(f->>'end_date')::date);
    IF NOT app_private.rent_support_writers_enabled_v1() THEN RAISE EXCEPTION 'RENT_SUPPORT_WRITERS_DISABLED' USING ERRCODE='55000';END IF;
  END IF;
  v_payload:=jsonb_build_object('contract',jsonb_build_object('room_id',r.id,'signed_date',f->>'signed_date','start_date',f->>'start_date',
    'end_date',f->>'end_date','rent_price',f->'rent_price','total_deposit',f->'total_deposit','payment_cycle',f->>'payment_cycle',
    'start_billing_date',NULLIF(f->>'start_billing_date',''),'end_billing_date',NULLIF(f->>'end_billing_date',''),'notes',f->>'notes',
    'contract_template_id',d.template_id,'discounts',jsonb_build_object('months',f->'discount_months','amount_per_month',f->'discount_amount_per_month'))
    || CASE WHEN v_terms ? 'rent_support' THEN jsonb_build_object('rent_support',app_private.rent_support_draft_payload_v1(p_organization_id,d.id,d.revision,v_terms,true)->'rent_support','discounts',jsonb_build_object('version',2,'kind','RENT_SUPPORT_SCHEDULE')) ELSE '{}'::jsonb END
    ||(p_creation_options-'first_invoice'-'deposit_receipts'-'existing_deposit_voucher_ids'),
    'customers',(SELECT jsonb_agg(jsonb_build_object('customer_id',j->>'id','is_representative',j->'is_representative','notes',j->'notes')) FROM jsonb_array_elements(v_terms->'customers') j),
    'services',CASE WHEN COALESCE((v_terms->>'use_custom_services')::boolean,false) THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('service_id',j->>'id','unit_price',j->'unit_price','initial_reading',
      COALESCE((SELECT to_jsonb(min((b->>'reading')::numeric)) FROM public.meters m JOIN jsonb_array_elements(p_boundary->'readings') b ON m.id=(b->>'meter_id')::uuid
        WHERE m.organization_id=p_organization_id AND m.room_id=r.id AND m.building_id=d.building_id AND m.service_id=(j->>'id')::uuid
          AND m.status='ACTIVE' AND m.deleted_at IS NULL),j->'initial_reading'))) FROM jsonb_array_elements(v_terms->'services') j),'[]'::jsonb) ELSE '[]'::jsonb END,
    'deposit_receipts',COALESCE(p_creation_options->'deposit_receipts','[]'::jsonb),
    'existing_deposit_voucher_ids',to_jsonb(ARRAY(
      SELECT DISTINCT voucher_id FROM (
        SELECT unnest(COALESCE(p_source_voucher_ids,ARRAY[]::uuid[])) AS voucher_id
        UNION ALL
        SELECT (value#>>'{}')::uuid FROM jsonb_array_elements(COALESCE(p_creation_options->'existing_deposit_voucher_ids','[]'::jsonb))
      ) sources ORDER BY voucher_id)));
  IF p_reservation_id IS NOT NULL THEN v_payload:=v_payload||jsonb_build_object('reservation_id',p_reservation_id,'reservation_revision',p_reservation_revision); END IF;
  IF p_creation_options ? 'first_invoice' THEN v_payload:=v_payload||jsonb_build_object('first_invoice',p_creation_options->'first_invoice'); END IF;
  v_result:=public.create_contract_v2(v_payload,'draft-sign:'||d.id::text);
  IF COALESCE((v_result->>'deposit_shortfall')::numeric,0)>=0.01 AND NULLIF(p_creation_options->>'deposit_debt_mode','') IS NULL THEN
    RAISE EXCEPTION 'Cọc còn thiếu cần chọn cách bổ sung hiện hành' USING ERRCODE='22023';
  END IF;
  SELECT * INTO c FROM public.contracts WHERE id=(v_result->'contract'->>'id')::uuid;
  IF NOT FOUND OR c.organization_id<>p_organization_id OR c.room_id<>r.id OR c.status::text<>'ACTIVE' OR c.actual_end_date IS NOT NULL
    OR NULLIF(btrim(c.contract_number),'') IS NULL OR NOT EXISTS (SELECT 1 FROM public.rooms current_room WHERE current_room.id=r.id AND current_room.status::text='OCCUPIED') THEN
    RAISE EXCEPTION 'Core chưa tạo hợp đồng nhận phòng hợp lệ' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.contracts old WHERE old.organization_id=p_organization_id AND old.contract_number=c.contract_number AND old.id<>c.id) THEN
    RAISE EXCEPTION 'Số hợp đồng mới bị trùng; không ghi nhận ký' USING ERRCODE='23505';
  END IF;
  PERFORM app_private.record_contract_meter_boundary_set_v1(p_organization_id,c.id,r.id,'MOVE_IN',p_received_on,p_boundary,'contracts.create');
  PERFORM app_private.assert_contract_move_in_boundaries_v1(p_organization_id,c.id,'contracts.create');
  IF p_reservation_id IS NOT NULL THEN PERFORM app_private.consume_room_next_claim_v1(p_organization_id,p_reservation_id,p_reservation_revision,c.id); END IF;
  INSERT INTO public.contract_draft_signings(id,organization_id,building_id,room_id,draft_id,revision,document_id,document_sha256,template_sha256,
    template_path,template_snapshot,document_data,terms,party_snapshot,creation_options,reservation_id,reservation_revision,source_voucher_ids,received_on,contract_id,contract_number,request_id,intent_hash,signed_by,official_document_path)
  VALUES(v_id,p_organization_id,d.building_id,r.id,d.id,d.revision,a.id,a.document_sha256,a.template_sha256,a.template_path,a.template_snapshot,
    (a.document_data-'DRAFT_TITLE'-'DRAFT_REVISION')||jsonb_build_object('CONTRACT_NUMBER',c.contract_number),v_terms,v_party,p_creation_options,p_reservation_id,p_reservation_revision,COALESCE(p_source_voucher_ids,ARRAY[]::uuid[]),
    p_received_on,c.id,c.contract_number,p_request_id,v_hash,auth.uid(),p_organization_id::text||'/'||d.building_id::text||'/'||v_id::text||'/document.docx') RETURNING * INTO s;
  UPDATE public.contract_drafts SET status='SIGNED',converted_contract_id=c.id WHERE id=d.id;
  RETURN to_jsonb(s)-'intent_hash';
END $function$;
REVOKE ALL ON FUNCTION public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[]) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[]) TO authenticated;

-- public.update_member_authorization_v1(uuid,bigint,jsonb,jsonb,text): 1 chỗ ném
CREATE OR REPLACE FUNCTION public.update_member_authorization_v1(p_membership uuid, p_expected_version bigint, p_role_bindings jsonb DEFAULT NULL::jsonb, p_overrides jsonb DEFAULT NULL::jsonb, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor    uuid := (select auth.uid());
  v_org      uuid;
  v_user     uuid;
  v_ver      bigint;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_truoc    text[];
  v_sau      text[];
  v_them     text[];
  v_mat      text[];
  v_b        jsonb;
  v_o        jsonb;
  v_id       uuid;
  v_n_bind   int := 0;
  v_n_ov     int := 0;
begin
  if v_actor is null then
    raise exception 'Bạn chưa đăng nhập.' using errcode = '42501';
  end if;
  if p_membership is null or p_expected_version is null then
    raise exception 'Thiếu thành viên hoặc số phiên bản. Hãy tải lại trang rồi thử lại.'
      using errcode = '22023';
  end if;
  if p_role_bindings is null and p_overrides is null then
    raise exception 'Không có gì để lưu.' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Hãy ghi lý do thay đổi phân quyền.' using errcode = '22023';
  end if;

  select m.organization_id, m.user_id into v_org, v_user
    from public.organization_memberships m where m.id = p_membership;
  if v_org is null then
    raise exception 'Không tìm thấy thành viên này.' using errcode = 'P0002';
  end if;

  -- So bằng user_id, KHÔNG bằng membership_id: người có nhiều hồ sơ thành viên
  -- trong cùng tổ chức sẽ lách được nếu chỉ so membership.
  if v_user = v_actor then
    raise exception 'Bạn không thể tự sửa quyền của chính mình. Hãy nhờ chủ sở hữu thực hiện.'
      using errcode = '42501';
  end if;

  perform app_private.require_perm_v1(v_org, 'users.edit', 'sửa phân quyền thành viên');

  -- Khoá dòng RỒI mới so phiên bản (đọc trước khi khoá là sai — hai người cùng
  -- lưu có thể cùng đọc đúng version rồi cùng ghi).
  select m.version into v_ver
    from public.organization_memberships m where m.id = p_membership for update;
  if v_ver <> p_expected_version then
    raise exception 'Có người vừa đổi phân quyền của thành viên này. Hãy tải lại trang để xem thay đổi mới nhất.'
      using errcode = 'PT409';
  end if;

  -- Ảnh chụp quyền TRƯỚC, để trả về "mất gì / được thêm gì".
  v_truoc := app_private.allowed_keys_for_membership_v3(p_membership);

  -- ---- Lớp VAI TRÒ ----
  if p_role_bindings is not null then
    -- role_bindings_check đòi valid_to > valid_from NGHIÊM NGẶT. now() là mốc đầu
    -- giao dịch, nên nếu một binding vừa được tạo rồi bị đóng TRONG CÙNG giao dịch
    -- (lưu hai lần liên tiếp, hoặc kịch bản kiểm thử) thì hai mốc bằng nhau và
    -- ràng buộc nổ. Đẩy thêm 1 micro giây để luôn hợp lệ.
    update public.role_bindings
       set valid_to = greatest(now(), valid_from + interval '1 microsecond'),
           version = version + 1
     where membership_id = p_membership and valid_to is null
       and inherited_from_binding_id IS NULL;

    for v_b in select * from jsonb_array_elements(p_role_bindings) loop
      if not exists (select 1 from public.organization_roles r
                      where r.id = (v_b->>'role_id')::uuid and r.organization_id = v_org) then
        raise exception 'Vai trò không thuộc tổ chức này.' using errcode = '22023';
      end if;
      v_id := gen_random_uuid();
      insert into public.role_bindings (id, organization_id, membership_id, role_id, valid_from, version)
      values (v_id, v_org, p_membership, (v_b->>'role_id')::uuid, now(), 1);

      insert into public.role_binding_scopes (organization_id, role_binding_id, scope_id)
      select v_org, v_id, s.id
        from jsonb_array_elements_text(coalesce(v_b->'scope_ids', '[]'::jsonb)) as t(sid)
        join public.authorization_scopes s on s.id = t.sid::uuid and s.organization_id = v_org;

      if not exists (select 1 from public.role_binding_scopes x where x.role_binding_id = v_id) then
        raise exception 'Vai trò phải kèm ít nhất một phạm vi (toàn tổ chức, khu vực hoặc toà nhà).'
          using errcode = '22023';
      end if;
      v_n_bind := v_n_bind + 1;
    end loop;
  end if;

  -- ---- Lớp NGOẠI LỆ ----
  if p_overrides is not null then
    -- Thu hồi bằng revoked_at, KHÔNG xoá dòng: giữ dấu vết ai từng được cấp gì.
    update public.member_permission_overrides
       set revoked_at = now()
     where membership_id = p_membership and revoked_at is null;

    for v_o in select * from jsonb_array_elements(p_overrides) loop
      if nullif(btrim(coalesce(v_o->>'reason','')), '') is null then
        raise exception 'Ngoại lệ "%": phải ghi lý do.', v_o->>'permission_key'
          using errcode = '22023';
      end if;
      if not exists (select 1 from public.permission_definitions pd
                      where pd.key = v_o->>'permission_key' and pd.is_active
                        and pd.permission_domain = 'TENANT') then
        raise exception 'Quyền "%" không tồn tại hoặc không dùng được.', v_o->>'permission_key'
          using errcode = '22023';
      end if;

      v_id := gen_random_uuid();
      insert into public.member_permission_overrides
        (id, organization_id, membership_id, permission_key, effect, reason,
         expires_at, created_by, created_at, scope_mode)
      values (v_id, v_org, p_membership, v_o->>'permission_key',
              upper(coalesce(v_o->>'effect','ALLOW')), btrim(v_o->>'reason'),
              nullif(v_o->>'expires_at','')::timestamptz, v_actor, now(),
              upper(coalesce(v_o->>'scope_mode','ORGANIZATION')));

      insert into public.member_override_scopes (organization_id, override_id, scope_id)
      select v_org, v_id, s.id
        from jsonb_array_elements_text(coalesce(v_o->'scope_ids','[]'::jsonb)) as t(sid)
        join public.authorization_scopes s on s.id = t.sid::uuid and s.organization_id = v_org;

      -- Kiểm hình dạng ở ĐÂY để báo lỗi tiếng Việt, thay vì để ràng buộc ném lỗi
      -- thô lúc COMMIT (lúc đó người dùng chỉ thấy mã 23514 khó hiểu).
      if upper(coalesce(v_o->>'scope_mode','ORGANIZATION')) = 'ORGANIZATION' then
        if (select count(*) from public.member_override_scopes x
             join public.authorization_scopes s2 on s2.id = x.scope_id
            where x.override_id = v_id and s2.scope_type = 'ORGANIZATION') <> 1
           or (select count(*) from public.member_override_scopes x where x.override_id = v_id) <> 1 then
          raise exception 'Ngoại lệ "%" áp cho toàn tổ chức thì chỉ được chọn đúng phạm vi "toàn tổ chức".',
            v_o->>'permission_key' using errcode = '22023';
        end if;
      else
        if (select count(*) from public.member_override_scopes x where x.override_id = v_id) = 0 then
          raise exception 'Ngoại lệ "%" phải chọn ít nhất một toà nhà, khu vực hoặc sổ quỹ.',
            v_o->>'permission_key' using errcode = '22023';
        end if;
        if exists (select 1 from public.member_override_scopes x
                    join public.authorization_scopes s2 on s2.id = x.scope_id
                   where x.override_id = v_id and s2.scope_type = 'ORGANIZATION') then
          raise exception 'Ngoại lệ "%" theo phạm vi hẹp thì không được chọn "toàn tổ chức".',
            v_o->>'permission_key' using errcode = '22023';
        end if;
      end if;
      v_n_ov := v_n_ov + 1;
    end loop;
  end if;

  update public.organization_memberships
     set version = version + 1
   where id = p_membership;

  -- Ảnh chụp quyền SAU.
  v_sau := app_private.allowed_keys_for_membership_v3(p_membership);

  select coalesce(array_agg(k order by k), '{}'::text[]) into v_them
    from (select unnest(v_sau) except select unnest(v_truoc)) t(k);
  select coalesce(array_agg(k order by k), '{}'::text[]) into v_mat
    from (select unnest(v_truoc) except select unnest(v_sau)) t(k);

  perform app_private.append_authz_audit_v1(
    v_org, 'MEMBER_AUTHORIZATION_UPDATED', 'organization_membership', p_membership,
    jsonb_build_object('permissions', to_jsonb(v_truoc), 'version', v_ver),
    jsonb_build_object('permissions', to_jsonb(v_sau), 'version', v_ver + 1,
                       'role_bindings', v_n_bind, 'overrides', v_n_ov),
    v_reason);

  return jsonb_build_object(
    'membershipId', p_membership, 'version', v_ver + 1,
    'roleBindings', v_n_bind, 'overrides', v_n_ov,
    'permissionsBefore', coalesce(array_length(v_truoc, 1), 0),
    'permissionsAfter', coalesce(array_length(v_sau, 1), 0),
    'gained', to_jsonb(v_them), 'lost', to_jsonb(v_mat));
end
$function$;
REVOKE ALL ON FUNCTION public.update_member_authorization_v1(uuid,bigint,jsonb,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_member_authorization_v1(uuid,bigint,jsonb,jsonb,text) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_member_authorization_v1(uuid,bigint,jsonb,jsonb,text) TO authenticated, service_role;

-- public.update_meter_reading_v1(uuid,numeric,date,text,text,timestamp with time zone): 1 chỗ ném
CREATE OR REPLACE FUNCTION public.update_meter_reading_v1(p_id uuid, p_current_reading numeric DEFAULT NULL::numeric, p_reading_date date DEFAULT NULL::date, p_notes text DEFAULT NULL::text, p_meter_image_url text DEFAULT NULL::text, p_expected_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS meter_readings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_r RECORD;
  v_row public.meter_readings;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;

  SELECT id, building_id, organization_id, updated_at INTO v_r
  FROM public.meter_readings WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy chỉ số' USING ERRCODE='42501'; END IF;
  IF v_r.building_id IS NULL THEN RAISE EXCEPTION 'Chỉ số chưa gắn toà nhà'; END IF;

  IF NOT (v_r.organization_id IS NULL
          OR public.is_super_admin()
          OR v_r.organization_id = ANY(public.my_org_ids())) THEN
    RAISE EXCEPTION 'Chỉ số thuộc tổ chức khác' USING ERRCODE='42501';
  END IF;
  IF NOT public.can_do_on_building('meter_readings','edit', v_r.building_id) THEN
    RAISE EXCEPTION 'Không có quyền sửa chỉ số cho toà này' USING ERRCODE='42501';
  END IF;
  -- LƯU Ý: KHÔNG chặn edit khi APPROVED — giữ parity với đường cũ (form hiện sửa
  -- được chỉ số đã duyệt; chỉ số mới luôn tạo APPROVED). Chặn sẽ là đổi hành vi.
  -- Quyền đã được can_do_on_building enforce; đây không phải chứng từ tiền như invoice.
  IF p_expected_updated_at IS NOT NULL AND v_r.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'Chỉ số đã bị thay đổi bởi người khác (version mismatch)' USING ERRCODE='PT409';
  END IF;
  IF p_current_reading IS NOT NULL AND p_current_reading < 0 THEN
    RAISE EXCEPTION 'Chỉ số không hợp lệ';
  END IF;

  BEGIN
    UPDATE public.meter_readings SET
      current_reading = COALESCE(p_current_reading, current_reading),
      reading_date    = COALESCE(p_reading_date, reading_date),
      notes           = COALESCE(p_notes, notes),
      meter_image_url = COALESCE(p_meter_image_url, meter_image_url)
    WHERE id = p_id AND deleted_at IS NULL
    RETURNING * INTO v_row;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'Chỉ số mới không hợp lệ (phải ≥ chỉ số kỳ trước)' USING ERRCODE='23514';
  END;

  RETURN v_row;
END;
$function$;
REVOKE ALL ON FUNCTION public.update_meter_reading_v1(uuid,numeric,date,text,text,timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_meter_reading_v1(uuid,numeric,date,text,text,timestamp with time zone) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_meter_reading_v1(uuid,numeric,date,text,text,timestamp with time zone) TO authenticated, service_role;

-- public.upsert_organization_role_v1(uuid,text,jsonb,bigint,text): 1 chỗ ném
CREATE OR REPLACE FUNCTION public.upsert_organization_role_v1(p_role_id uuid DEFAULT NULL::uuid, p_name text DEFAULT NULL::text, p_permissions jsonb DEFAULT NULL::jsonb, p_expected_version bigint DEFAULT NULL::bigint, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_id    uuid := p_role_id;
  v_row   public.organization_roles%rowtype;
  v_name  text := nullif(btrim(coalesce(p_name, '')), '');
  v_tao   boolean := (p_role_id is null);
  v_xau   text;
  v_nguoi int;
  v_cu    jsonb;
begin
  if v_actor is null then
    raise exception 'Bạn chưa đăng nhập.' using errcode = '42501';
  end if;

  if v_tao then
    -- Tổ chức của người tạo (thứ tự ổn định vì không có UNIQUE(org,user)).
    select m.organization_id into v_org
      from public.organization_memberships m
      join public.organizations o on o.id = m.organization_id and o.status = 'ACTIVE'
     where m.user_id = v_actor and m.status = 'ACTIVE'
     order by coalesce(o.is_demo,false), m.organization_id limit 1;
    if v_org is null then
      raise exception 'Bạn không thuộc tổ chức nào đang hoạt động.' using errcode = '42501';
    end if;
    if v_name is null then
      raise exception 'Hãy đặt tên cho vai trò.' using errcode = '22023';
    end if;
    if p_permissions is null then
      raise exception 'Vai trò mới phải chọn ít nhất một quyền (hoặc gửi danh sách rỗng nếu cố ý).'
        using errcode = '22023';
    end if;
  else
    select * into v_row from public.organization_roles where id = p_role_id;
    if not found then
      raise exception 'Không tìm thấy vai trò này.' using errcode = 'P0002';
    end if;
    v_org := v_row.organization_id;
  end if;

  perform app_private.require_perm_v1(v_org, 'users.edit', 'quản lý mẫu vai trò');

  if not v_tao then
    select * into v_row from public.organization_roles where id = p_role_id for update;
    if v_row.is_system then
      raise exception 'Vai trò hệ thống "%" không sửa được. Hãy nhân bản rồi sửa bản sao.', v_row.name
        using errcode = '42501';
    end if;
    if p_expected_version is null or v_row.version <> p_expected_version then
      raise exception 'Có người vừa đổi vai trò này. Hãy tải lại trang.' using errcode = 'PT409';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('permission_key', rp.permission_key, 'effect', rp.effect)
                              order by rp.permission_key), '[]'::jsonb)
      into v_cu from public.role_permissions rp where rp.role_id = p_role_id;
  end if;

  -- Kiểm khoá quyền TRƯỚC khi ghi, để báo lỗi rõ thay vì để FK/trigger ném lỗi thô.
  if p_permissions is not null then
    select string_agg(x.k, ', ') into v_xau
      from (select e->>'permission_key' as k from jsonb_array_elements(p_permissions) e) x
     where not exists (select 1 from public.permission_definitions pd
                        where pd.key = x.k and pd.is_active and pd.permission_domain = 'TENANT');
    if v_xau is not null then
      raise exception 'Các quyền sau không dùng được: %', v_xau using errcode = '22023';
    end if;
  end if;

  if v_tao then
    v_id := gen_random_uuid();
    insert into public.organization_roles (id, organization_id, name, is_system, version, created_at, status)
    values (v_id, v_org, v_name, false, 1, now(), 'ACTIVE');
  else
    update public.organization_roles
       set name = coalesce(v_name, name), version = version + 1
     where id = v_id;
  end if;

  if p_permissions is not null then
    delete from public.role_permissions where role_id = v_id;
    insert into public.role_permissions (organization_id, role_id, permission_key, effect)
    select distinct v_org, v_id, e->>'permission_key', upper(coalesce(e->>'effect','ALLOW'))
      from jsonb_array_elements(p_permissions) e;
  end if;

  select count(distinct rb.membership_id) into v_nguoi
    from public.role_bindings rb where rb.role_id = v_id and rb.valid_to is null;

  perform app_private.append_authz_audit_v1(
    v_org, case when v_tao then 'ROLE_CREATED' else 'ROLE_UPDATED' end,
    'organization_role', v_id, v_cu,
    jsonb_build_object('name', coalesce(v_name, v_row.name), 'permissions', p_permissions,
                       'affected_members', v_nguoi),
    nullif(btrim(coalesce(p_reason,'')), ''));

  return jsonb_build_object('roleId', v_id, 'created', v_tao,
    'version', (select version from public.organization_roles where id = v_id),
    'permissions', coalesce(jsonb_array_length(p_permissions), 0),
    'affectedMembers', v_nguoi);
end
$function$;
REVOKE ALL ON FUNCTION public.upsert_organization_role_v1(uuid,text,jsonb,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_organization_role_v1(uuid,text,jsonb,bigint,text) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_organization_role_v1(uuid,text,jsonb,bigint,text) TO authenticated, service_role;

-- app_private.commission_reason_cancel_flex_before_v1(uuid,text,bigint,bigint): 2 chỗ ném
CREATE OR REPLACE FUNCTION app_private.commission_reason_cancel_flex_before_v1(p_voucher uuid, p_reason text, p_expected_approval_version bigint DEFAULT NULL::bigint, p_expected_posting_version bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v public.income_expenses%ROWTYPE;
  v_actor uuid := auth.uid();
  v_membership uuid;
  v_is_super boolean;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_active public.income_expense_postings%ROWTYPE;
  v_rev uuid;
  v_sum numeric;
  v_kind text;
  v_next_posting text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  IF char_length(v_reason) < 8 THEN
    RAISE EXCEPTION 'Phải ghi lý do huỷ (ít nhất 8 ký tự) để còn đối soát về sau.'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v FROM public.income_expenses WHERE id = p_voucher AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002'; END IF;

  -- Kiểm THÀNH VIÊN ngay sau khi tìm thấy phiếu: mọi thông điệp phía dưới
  -- (đã huỷ chưa, system_source gì, tên sổ quỹ, ngày chốt) đều là thông tin
  -- của tổ chức sở hữu phiếu — người ngoài không được nghe.
  IF NOT public.is_super_admin() AND NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m0
     WHERE m0.user_id = v_actor AND m0.organization_id = v.organization_id
       AND m0.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
  END IF;

  IF v.approval_status = 'CANCELLED' THEN
    RETURN jsonb_build_object('id', p_voucher, 'changed', false, 'reason', 'đã huỷ trước đó');
  END IF;

  IF NOT app_private.ie_flex_mode_enabled_v1(v.organization_id) THEN
    RAISE EXCEPTION '[STRICT_MODE] Tổ chức đang bật Chuẩn kế toán — dùng đường Hoàn tác rồi Huỷ như cũ.'
      USING ERRCODE = '55000';
  END IF;

  PERFORM app_private.assert_manual_voucher_v1(p_voucher, 'huỷ');
  PERFORM app_private.assert_period_open_for_edit_v1(p_voucher, 'huỷ');

  v_is_super := public.is_super_admin();
  SELECT m.id INTO v_membership FROM public.organization_memberships m
   WHERE m.user_id = v_actor AND m.organization_id = v.organization_id AND m.status = 'ACTIVE' LIMIT 1;
  IF v_membership IS NULL AND NOT v_is_super THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
  END IF;

  -- Quyền: huỷ thu chi trên toà + đang GIỮ đúng sổ. Chủ tổ chức / super admin
  -- được vào thẳng (quyết định #4). Chế độ linh hoạt nới TRẠNG THÁI, không nới
  -- quyền: income_expenses.cancel vẫn là điều kiện như đường cũ.
  -- Người TẠO phiếu được huỷ phiếu của chính mình (yêu cầu của chủ 29/07).
  IF NOT v_is_super AND NOT app_private.is_org_owner_v1(v.organization_id, v_actor)
     AND v.user_id IS DISTINCT FROM v_actor THEN
    DECLARE v_allowed boolean;
    BEGIN
      SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(
        v_actor, v.organization_id, 'income_expenses.cancel', v.building_id, v.account_id);
      IF NOT COALESCE(v_allowed, false) THEN
        RAISE EXCEPTION 'Không có quyền huỷ phiếu thu chi trên toà này' USING ERRCODE = '42501';
      END IF;
      IF v.account_id IS NOT NULL THEN
        PERFORM app_private.assert_cashbook_access_v2(
          v.organization_id, v.account_id, 'CUSTODIAN', v_membership);
      END IF;
    END;
  END IF;

  IF COALESCE(v.has_restricted_item, false)
     AND v.user_id IS DISTINCT FROM v_actor
     AND NOT public.can_view_restricted_ie() AND NOT v_is_super THEN
    RAISE EXCEPTION 'Phiếu chứa hạng mục hạn chế — không có quyền huỷ' USING ERRCODE = '42501';
  END IF;

  IF p_expected_approval_version IS NOT NULL
     AND COALESCE(v.approval_version, 1) <> p_expected_approval_version THEN
    RAISE EXCEPTION 'Phiếu vừa được người khác thay đổi — hãy tải lại' USING ERRCODE = 'PT409';
  END IF;
  IF p_expected_posting_version IS NOT NULL
     AND COALESCE(v.posting_version, 1) <> p_expected_posting_version THEN
    RAISE EXCEPTION 'Phiếu vừa được người khác ghi sổ — hãy tải lại' USING ERRCODE = 'PT409';
  END IF;

  -- Token: vừa qua được trigger đóng băng, vừa TẮT cầu a85 để nó không đảo
  -- chồng lên bút toán mà hàm này sắp tự viết.
  INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  VALUES (p_voucher, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
  ON CONFLICT (income_expense_id) DO UPDATE
    SET xid = excluded.xid, purpose = excluded.purpose, granted_at = now();

  v_kind := 'CANCELLED_UNPOSTED';
  v_next_posting := CASE WHEN v.posting_mode = 'NON_CASH' THEN 'NOT_APPLICABLE' ELSE 'UNPOSTED' END;

  IF COALESCE(v.posting_status, 'UNPOSTED') = 'POSTED' THEN
    SELECT * INTO v_active FROM public.income_expense_postings p
     WHERE p.id = v.active_posting_id_v2 FOR UPDATE;

    IF v_active.id IS NULL THEN
      -- Phiếu POSTED mà con trỏ rỗng là ca thật: nhánh BRIDGE_UNRESOLVED_POSTER
      -- của cầu a85 ghi dòng ngoại lệ rồi trả về mà không tạo posting.
      RAISE EXCEPTION 'Phiếu ghi nhận đã ghi sổ nhưng không tìm thấy bút toán gốc — báo quản trị trước khi huỷ.'
        USING ERRCODE = '55000';
    END IF;
    IF v_active.event_kind <> 'POSTING' THEN
      RAISE EXCEPTION 'Bút toán đang trỏ tới không phải bút toán gốc' USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.income_expense_postings
      (organization_id, voucher_id, posting_subject_kind, posting_subject_id, direction,
       account_id, gross_amount, voucher_amount_snapshot, amount_basis, net_cash_effect,
       posted_on, posted_by_membership_id, posted_by_user_id, approval_version,
       event_kind, idempotency_key, source_kind, posting_generation, reversal_of_id, reversal_reason)
    VALUES
      (v_active.organization_id, v_active.voucher_id, v_active.posting_subject_kind,
       v_active.posting_subject_id, v_active.direction, v_active.account_id,
       v_active.gross_amount, v_active.voucher_amount_snapshot, v_active.amount_basis,
       -v_active.net_cash_effect, public.org_today_v1(NULL),
       COALESCE(v_membership, v_active.posted_by_membership_id), v_actor,
       COALESCE(v.approval_version, 1), 'REVERSAL',
       'flexcancel:' || v_active.id::text, 'MANUAL', v_active.posting_generation,
       v_active.id, v_reason)
    RETURNING id INTO v_rev;

    INSERT INTO public.income_expense_posting_lines
      (organization_id, posting_id, account_id, line_kind, signed_amount)
    SELECT l.organization_id, v_rev, l.account_id, 'REVERSAL', -l.signed_amount
    FROM public.income_expense_posting_lines l
    WHERE l.posting_id = v_active.id;

    -- Hậu điều kiện: mọi bút toán của phiếu này phải triệt tiêu về 0.
    SELECT COALESCE(sum(l.signed_amount), 0) INTO v_sum
    FROM public.income_expense_posting_lines l
    JOIN public.income_expense_postings p ON p.id = l.posting_id
    WHERE p.posting_subject_kind = 'VOUCHER' AND p.posting_subject_id = p_voucher;
    IF v_sum <> 0 THEN
      RAISE EXCEPTION 'Huỷ phiếu nhưng bút toán không triệt tiêu (còn lệch %) — dừng lại', v_sum
        USING ERRCODE = '55000';
    END IF;

    v_kind := 'CANCELLED_AFTER_POSTING';
    v_next_posting := 'REVERSED';
  END IF;

  UPDATE public.income_expenses SET
    approval_status = 'CANCELLED',
    review_state = 'RESOLVED',
    posting_status = v_next_posting,
    cancellation_kind = v_kind,
    active_posting_id_v2 = CASE WHEN v_rev IS NOT NULL THEN NULL ELSE active_posting_id_v2 END,
    reversed_by_posting_id = COALESCE(v_rev, reversed_by_posting_id),
    approval_version = COALESCE(approval_version, 1) + 1,
    posting_version = COALESCE(posting_version, 1) + CASE WHEN v_rev IS NOT NULL THEN 1 ELSE 0 END
  WHERE id = p_voucher;

  DELETE FROM app_private.ie_transition_authorization WHERE income_expense_id = p_voucher;

  INSERT INTO app_private.income_expense_cancellations
    (income_expense_id, organization_id, cancelled_by, cancel_reason, cancellation_kind,
     created_at_snap, approved_at_snap, amount_snap, cashbook_snap)
  VALUES
    (p_voucher, v.organization_id, v_actor, v_reason, v_kind,
     v.created_at, v.approved_at, v.total_amount, v.account_id)
  ON CONFLICT (income_expense_id) DO NOTHING;

  PERFORM app_private.append_income_expense_event_v1(
    v.organization_id, p_voucher, 'CANCELLED', v_actor, NULL,
    v.approval_status, 'CANCELLED', v_reason);

  RETURN jsonb_build_object(
    'id', p_voucher, 'changed', true,
    'cancellation_kind', v_kind,
    'reversal_posting_id', v_rev
  );
END
$function$;
REVOKE ALL ON FUNCTION app_private.commission_reason_cancel_flex_before_v1(uuid,text,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.commission_reason_cancel_flex_before_v1(uuid,text,bigint,bigint) FROM anon, authenticated, service_role;

DO $kiem_sau$
DECLARE
  r record;
  f record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public._profit_state_change_v2(text,uuid,date,text,text,uuid[],text)', 'd9ca5530f2a90ebed9baec67df1db448', 1, true, '{"search_path=pg_catalog, public"}', 'service_role'),
    ('public._profit_write_close_v2_base(text,uuid,date,text,text,text,uuid[],jsonb)', '91741fe340d354139bca715acbcae068', 1, true, '{"search_path=pg_catalog, public"}', 'service_role'),
    ('public.confirm_cashbook_closing_v1(uuid,numeric)', '080a1e19af70a2066b6f443689d48e61', 1, true, '{"search_path=pg_catalog, app_private, public"}', 'authenticated'),
    ('public.copilot_plan_approve_v1(uuid,text,text,integer,text)', 'c13b6607429607c0658bde118ca14757', 2, true, '{"search_path=pg_catalog, public, app_private, extensions"}', 'authenticated'),
    ('public.copilot_plan_cancel_v1(uuid,integer,text)', '825e311099fe0dc1e9f6ff1a56bd4758', 2, true, '{"search_path=pg_catalog, public, app_private, extensions"}', 'authenticated'),
    ('public.copilot_plan_execute_step_v1(uuid,integer,integer,uuid)', 'c3c39dc5dadcd1287a056d27278ac3b8', 3, true, '{"search_path=pg_catalog, public, app_private, extensions"}', 'authenticated'),
    ('public.copilot_plan_reconcile_step_v1(uuid,integer,integer)', '45b8aee714cbc298ace14b4d0c24a1d8', 3, true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated'),
    ('public.decide_financial_voucher(uuid,text,text,bigint)', '95d99a861c58c65face1c31d70251f13', 1, true, '{"search_path=pg_catalog, public"}', 'service_role'),
    ('public.delete_contract_draft_v1(uuid,uuid,integer)', '39adf63636cdc7925db7c04b5ac30a96', 1, true, '{"search_path=\"\""}', 'authenticated'),
    ('public.job_recurrence_delete_v1(uuid,integer)', 'ef5fde692e0eb2ebebec4d273eba5cca', 2, false, '{"search_path=\"\""}', 'authenticated'),
    ('public.job_recurrence_set_paused_v1(uuid,integer,boolean)', 'b142806f58eecc89aae0abb1f088c0b0', 2, false, '{"search_path=\"\""}', 'authenticated'),
    ('public.job_recurrence_update_v1(uuid,integer,jsonb)', '349bdafec29ccc7676062551135c5999', 2, false, '{"search_path=\"\""}', 'authenticated'),
    ('public.landlord_operation_upsert_v1(uuid,text,numeric,date,uuid[],text,boolean,numeric,boolean,date,numeric,timestamp with time zone,numeric,text)', 'b0316ccf0b21ce8b0b16d47a1451c1a7', 1, true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated,service_role'),
    ('public.landlord_portal_confirm_v1(text,text,text,date,integer,text)', '5080c884a63219bbd772f2f0690da452', 1, true, '{"search_path=pg_catalog, public, app_private"}', 'anon,authenticated,service_role'),
    ('public.landlord_settlement_close_v1(uuid,date,text,text)', '6db68f8d1830d50bc8583866ecd7d178', 1, true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated,service_role'),
    ('public.landlord_settlement_confirm_v1(text,date,integer,text)', '007e69f1c831ced39807cfae140d41ee', 1, true, '{"search_path=pg_catalog, public, app_private"}', 'anon,authenticated,service_role'),
    ('public.landlord_settlement_note_update_v1(uuid,date,integer,text)', 'af18160b607602c2bb552b2d8631ed1e', 1, true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated,service_role'),
    ('public.network_center_resume_organization_v1(uuid,bigint,text,uuid)', 'b68f3a0a17df89f25c8f9ab9c57d1517', 1, true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated'),
    ('public.network_center_update_settings_v1(uuid,jsonb,bigint,uuid)', 'beb840e2a85c67a82fc8f8c085351cf7', 1, true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated,service_role'),
    ('public.profit_reset_checked_v2(uuid,date,text,text,text,uuid[],uuid[])', 'fea01099aeb6af885d871a35e0193e92', 1, true, '{"search_path=pg_catalog, public"}', 'authenticated,service_role'),
    ('public.register_contract_draft_document(uuid,uuid,integer,uuid,uuid,jsonb,text,text,jsonb)', 'ab50789a66c57289300fafd76c01c5bc', 1, true, '{"search_path=\"\""}', 'authenticated'),
    ('public.save_contract_draft(uuid,uuid,uuid,jsonb,uuid,uuid,integer,uuid)', '2996e749c78a5b8912aa993cb1ca2779', 2, true, '{"search_path=\"\""}', 'authenticated'),
    ('public.set_copilot_action_policy_v1(bigint,text,text[],boolean,text,text)', '9071db2ed5566ed0e596629895f33d36', 1, true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated'),
    ('public.set_copilot_feature_flag_v2(text,text,text,bigint,uuid,text,text,timestamp with time zone,text)', '9295ca37f8c34897f782bc75de4cc78c', 1, true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated'),
    ('public.settle_reservation_deposit_v1(jsonb)', '2c93e21192606acc4ef0b431b17d9e8d', 1, true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated,service_role'),
    ('public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[])', 'de09384fa892da2578d5e974977796f4', 4, true, '{"search_path=\"\""}', 'authenticated'),
    ('public.update_member_authorization_v1(uuid,bigint,jsonb,jsonb,text)', '26935e24f24c17b279274a0cfcb43f76', 1, true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated,service_role'),
    ('public.update_meter_reading_v1(uuid,numeric,date,text,text,timestamp with time zone)', '328015b7335106fef0b08e45b8bd819c', 1, true, '{search_path=public}', 'authenticated,service_role'),
    ('public.upsert_organization_role_v1(uuid,text,jsonb,bigint,text)', '94b58c1415690e70a2f5802b15beca1c', 1, true, '{"search_path=pg_catalog, public, app_private"}', 'authenticated,service_role'),
    ('app_private.commission_reason_cancel_flex_before_v1(uuid,text,bigint,bigint)', '7a27b74acb537bf89973bd67980ee30f', 2, true, '{"search_path=pg_catalog, app_private, public"}', '')
  ) AS t(ham, md5_moi, so_cho, bao_mat, cau_hinh, quyen) LOOP
    SELECT p.prosrc AS src, p.prosecdef AS bao_mat, p.proconfig::text AS cau_hinh,
           COALESCE((SELECT string_agg(g.vai, ',' ORDER BY g.vai)
                       FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS vai
                               FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                              WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) g), '') AS quyen
      INTO f FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure(r.ham);
    IF NOT FOUND OR md5(replace(f.src, chr(13), '')) <> r.md5_moi THEN
      RAISE EXCEPTION 'Sau khi thay, thân % không đúng bản mới', r.ham USING ERRCODE = '55000';
    END IF;
    IF f.src ~* $re$errcode\s*=\s*'40001'$re$
       OR (SELECT count(*) FROM regexp_matches(f.src, $re$errcode\s*=\s*'PT409'$re$, 'gi')) <> r.so_cho THEN
      RAISE EXCEPTION 'Sau khi thay, % còn ném 40001 hoặc sai số chỗ PT409', r.ham USING ERRCODE = '55000';
    END IF;
    IF f.bao_mat IS DISTINCT FROM r.bao_mat OR f.cau_hinh IS DISTINCT FROM r.cau_hinh OR f.quyen IS DISTINCT FROM r.quyen THEN
      RAISE EXCEPTION 'Sau khi thay, % lệch SECURITY / proconfig / quyền', r.ham USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$kiem_sau$;

COMMIT;
