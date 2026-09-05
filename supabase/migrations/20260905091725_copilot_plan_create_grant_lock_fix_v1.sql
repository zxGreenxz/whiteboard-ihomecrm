-- =============================================================================
-- copilot_plan_create_grant_lock_fix_v1 — gỡ khoá dòng khỏi câu có hàm gộp
-- Ngày 05/09/2026 · đường TỰ DUYỆT (uỷ quyền đứng) đang chết 400 trên production
-- =============================================================================
-- VẤN ĐỀ — NHÁNH TỰ DUYỆT CHẾT NGAY TỪ CÂU ĐẦU, CHƯA TỪNG CHẠY NỔI MỘT LẦN
--   E2E thật (run 33956801431 trên bản dựng 7142a9eb, Mức 3 ĐANG BẬT:
--   max_direct_risk = 'L5' + standing_grants_enabled = true) làm ca 4 của
--   `.e2e-fleet/specs/copilot-plan-l5-matrix.spec.ts` đỏ với HTTP 400 từ
--   `public.copilot_plan_create_v1`:
--
--     FOR UPDATE is not allowed with aggregate functions
--
--   Postgres KHÔNG cho khoá dòng nằm cùng một câu với hàm gộp. Khối soát phủ uỷ
--   quyền đứng — sinh ở 20260903171622_copilot_standing_grants_v1.sql, mang
--   nguyên qua 20260903212600_copilot_action_member_cap_quyen_v1.sql — viết đúng
--   như thế: `SELECT COALESCE(array_agg(g.id ORDER BY g.id), '{}'::uuid[]) INTO
--   v_locked_ids ... ORDER BY g.id` rồi khoá dòng ở cuối cùng một câu.
--
--   Hai bảo đảm mà bản vá F3 hồi ấy nhắm tới đều ĐÚNG (khoá MỘT LẦN thay vì khoá
--   trong vòng lặp; sắp theo id để hai kế hoạch chồng lấn không deadlock) — chỉ
--   cách viết là không chạy được. Hệ quả: MỌI lời gọi `copilot_plan_create_v1`
--   mang bước `grantable` khi cờ `standing_grants_enabled` bật đều nổ 400.
--
--   Vì sao không gate nào bắt được: test regex không phải trình biên dịch
--   plpgsql, và plpgsql chỉ phân tích câu SQL LÚC CHẠY chứ không lúc CREATE
--   FUNCTION — nên `CREATE OR REPLACE` xanh, migration xanh, chỉ có người dùng
--   thật gặp 400. Bài học đã ghi vào test kèm migration này.
--
-- QUYẾT ĐỊNH — TÁCH BA BƯỚC, GIỮ NGUYÊN CẢ HAI BẢO ĐẢM CŨ
--   1) liệt kê ứng viên: SELECT trần, không khoá, không hàm gộp → `v_grant_ids`
--      (vẫn loại `grantable = false` và `pin_always` đúng như trước);
--   2) khoá cả tập MỘT LẦN: `PERFORM 1 ... WHERE g.id = ANY(v_grant_ids) ORDER BY
--      g.id` + khoá dòng. Không hàm gộp nên Postgres nhận; thứ tự id là thứ tự
--      TOÀN CỤC nên hai kế hoạch chồng lấn vẫn không deadlock;
--   3) đọc lại tập ĐÃ KHOÁ, lọc lại đúng ba điều kiện cũ (organization_id /
--      revoked_at / expires_at) → `v_locked_ids`.
--
--   Bước 3 KHÔNG phải trang trí. Khoá dòng cũ tự làm việc đó qua EvalPlanQual:
--   khoá xong thì kiểm lại WHERE trên bản mới nhất, dòng nào không còn khớp thì
--   loại. Tách ra thì phải viết tay, nếu không một hạn mức bị thu hồi TRONG LÚC
--   chờ khoá sẽ vẫn được tính là phủ. Chặn `g.id = ANY(v_grant_ids)` ở bước 3 lo
--   chiều ngược lại: dòng mới INSERT sau bước 1 không lọt vào tập, vì nó chưa
--   được khoá.
--
-- GIỮ NGUYÊN — MỌI THỨ KHÁC SAO NGUYÊN VĂN TỪ BẢN ĐANG CHẠY
--   Thân hàm lấy bằng `pg_get_functiondef` trên production ngày 05/09/2026
--   (md5 = b141539511a5ecbd9858763f48a99b63); bản đó khớp TỪNG BYTE với thân hàm
--   trong 20260903212600, nên không có dòng nào phải chép tay. Chỉ hai chỗ đổi:
--   thêm khai báo `v_grant_ids uuid[]`, và thay đúng khối khoá 13 dòng.
--
--   Không đổi: chữ ký `(uuid, text, jsonb)` · RETURNS jsonb · SECURITY DEFINER ·
--   search_path 4 phần tử · trần rủi ro + `plan_risk_not_allowed` · cờ tính năng ·
--   ảnh chụp digest/registry/policy · xoá nonce mồ côi · nhánh `direct_l5_v1` ·
--   nhánh `maker_submit_v1` · hàng rào `pin_always` · vòng lặp so khớp từng bước ·
--   tăng `used_today`/`used_on` · ba sự kiện sổ `grant_*`.
--   ACL phát lại đúng như production đang có:
--   proacl = {postgres=X/postgres,authenticated=X/postgres}.
--
-- IDEMPOTENT · AN TOÀN TRÊN DB RỖNG
--   Chỉ có CREATE OR REPLACE + REVOKE/GRANT (đều phát lại được) + một khối nghiệm
--   thu CHỈ ĐỌC catalog. Không DDL bảng, không ghi một dòng dữ liệu nào, nên dán
--   hai lượt trong cùng transaction cho kết quả y hệt. Mọi câu đọc catalog nằm
--   sau `to_regprocedure`/`to_regrole` nên chạy được trên baseline schema-only.
--   Một BEGIN/COMMIT duy nhất.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- -----------------------------------------------------------------------------
-- 1) copilot_plan_create_v1 — khối khoá hạn mức tách thành BA BƯỚC
-- -----------------------------------------------------------------------------
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
  v_grant_ids        uuid[];
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
      -- BUOC 1/3 - liet ke UNG VIEN. Khong khoa, khong ham gop: chi lay id de
      -- co mot tap TAT DINH mang sang buoc khoa.
      v_grant_ids := ARRAY(
        SELECT g.id
          FROM app_private.copilot_standing_grants g
         WHERE g.organization_id = p_organization_id
           AND g.action_id = ANY(v_needed_actions)
           AND g.revoked_at IS NULL
           AND g.expires_at > clock_timestamp()
         ORDER BY g.id
      );

      -- BUOC 2/3 - KHOA ca tap MOT LAN, sap theo id (thu tu toan cuc => khong
      -- deadlock giua hai ke hoach chong lan). Cau nay KHONG co ham gop, nen
      -- Postgres nhan duoc — day chinh la cho ban cu chet 0A000.
      PERFORM 1
        FROM app_private.copilot_standing_grants g
       WHERE g.id = ANY(v_grant_ids)
       ORDER BY g.id
       FOR UPDATE;

      -- BUOC 3/3 - doc lai tap DA KHOA va loc lai dung cac dieu kien cu. Day la
      -- phan thay cho EvalPlanQual ma khoa dong tung lam ho: mot giao dich
      -- khac vua thu hoi/het han trong luc cho khoa thi dong do bi loai o day.
      -- Chan `g.id = ANY(v_grant_ids)` dam bao KHONG dong nao chua khoa lot vao.
      v_locked_ids := ARRAY(
        SELECT g.id
          FROM app_private.copilot_standing_grants g
         WHERE g.id = ANY(v_grant_ids)
           AND g.organization_id = p_organization_id
           AND g.action_id = ANY(v_needed_actions)
           AND g.revoked_at IS NULL
           AND g.expires_at > clock_timestamp()
         ORDER BY g.id
      );
    ELSE
      v_grant_ids  := '{}'::uuid[];
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
$function$;

-- -----------------------------------------------------------------------------
-- 2) ACL — phát lại NGUYÊN VĂN bộ quyền production đang có
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.copilot_plan_create_v1(uuid, text, jsonb) FROM PUBLIC;
DO $quyen_lap$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_create_v1(uuid, text, jsonb) FROM anon;
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_create_v1(uuid, text, jsonb) FROM service_role;
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.copilot_plan_create_v1(uuid, text, jsonb) FROM authenticated;
    GRANT EXECUTE ON FUNCTION public.copilot_plan_create_v1(uuid, text, jsonb) TO authenticated;
  END IF;
END
$quyen_lap$;

-- -----------------------------------------------------------------------------
-- 3) NGHIỆM THU — CHỈ ĐỌC catalog. Không đọc một dòng dữ liệu nghiệp vụ nào.
-- -----------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_src   text;
  v_args  text;
  v_ret   text;
  v_sec   boolean;
  v_cfg   text[];
  v_i     int;
  v_dem   int;
  v_truoc text;
  v_cau   text;
BEGIN
  IF to_regprocedure('public.copilot_plan_create_v1(uuid, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'copilot_plan_create_v1(uuid, text, jsonb) khong ton tai sau migration. DUNG.';
  END IF;

  SELECT p.prosrc,
         pg_get_function_identity_arguments(p.oid),
         pg_get_function_result(p.oid),
         p.prosecdef,
         p.proconfig
    INTO v_src, v_args, v_ret, v_sec, v_cfg
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'copilot_plan_create_v1';

  -- (a) ABI: chu ky / RETURNS / SECURITY DEFINER / search_path KHONG doi
  IF v_args IS DISTINCT FROM 'p_organization_id uuid, p_client_request_id text, p_steps jsonb' THEN
    RAISE EXCEPTION 'chu ky copilot_plan_create_v1 doi: %. DUNG.', v_args;
  END IF;
  IF v_ret IS DISTINCT FROM 'jsonb' THEN
    RAISE EXCEPTION 'RETURNS cua copilot_plan_create_v1 doi: %. DUNG.', v_ret;
  END IF;
  IF NOT COALESCE(v_sec, false) THEN
    RAISE EXCEPTION 'copilot_plan_create_v1 mat SECURITY DEFINER. DUNG.';
  END IF;
  IF v_cfg IS NULL
     OR NOT (v_cfg @> ARRAY['search_path=pg_catalog, public, app_private, extensions']) THEN
    RAISE EXCEPTION 'search_path cua copilot_plan_create_v1 doi: %. DUNG.', v_cfg;
  END IF;

  -- (b) DUNG LOI DA VA: cau chua khoa dong PHAI khong co ham gop.
  --     Cat dung cau chua khoa dong (tu dau cham phay truoc do) roi soi cau ay.
  v_dem := (length(v_src) - length(replace(v_src, 'FOR UPDATE', ''))) / length('FOR UPDATE');
  IF v_dem <> 1 THEN
    RAISE EXCEPTION 'than copilot_plan_create_v1 co % chan khoa dong (cho dung 1). DUNG.', v_dem;
  END IF;
  v_i := strpos(v_src, 'FOR UPDATE');
  v_truoc := substr(v_src, 1, v_i - 1);
  v_cau := substr(v_truoc, length(v_truoc) - position(';' IN reverse(v_truoc)) + 2);
  IF strpos(v_cau, 'array_agg') > 0 OR strpos(v_cau, 'count(') > 0 THEN
    RAISE EXCEPTION 'cau khoa dong VAN mang ham gop — Postgres se nem 0A000 luc chay. DUNG.';
  END IF;
  IF strpos(v_cau, 'PERFORM 1') = 0 THEN
    RAISE EXCEPTION 'buoc 2/3 khong con la PERFORM 1 khong-ham-gop. DUNG.';
  END IF;

  -- (c) Ba buoc con du, va thu tu khoa theo id con nguyen (chong deadlock)
  IF strpos(v_src, 'v_grant_ids := ARRAY(') = 0 THEN
    RAISE EXCEPTION 'thieu buoc 1/3 liet ke ung vien vao v_grant_ids. DUNG.';
  END IF;
  IF strpos(v_src, 'v_locked_ids := ARRAY(') = 0 THEN
    RAISE EXCEPTION 'thieu buoc 3/3 doc lai tap da khoa vao v_locked_ids. DUNG.';
  END IF;
  IF strpos(v_src, 'ORDER BY g.id') = 0 THEN
    RAISE EXCEPTION 'mat thu tu khoa theo id — hai ke hoach chong lan co the deadlock. DUNG.';
  END IF;

  -- (d) Hang rao cu VAN CON (mau dai dien, khong phai danh sach day du)
  IF strpos(v_src, 'plan_risk_not_allowed') = 0
     OR strpos(v_src, 'direct_l5_v1') = 0
     OR strpos(v_src, 'maker_submit_v1') = 0
     OR strpos(v_src, 'pin_always') = 0
     OR strpos(v_src, 'used_today = (CASE WHEN used_on IS DISTINCT FROM current_date') = 0
     OR strpos(v_src, 'grant_used') = 0 THEN
    RAISE EXCEPTION 'mot hang rao cu bien mat khoi copilot_plan_create_v1. DUNG.';
  END IF;

  -- (e) ACL dung nhu production: authenticated EXECUTE, anon/service_role KHONG
  IF to_regrole('authenticated') IS NOT NULL
     AND NOT has_function_privilege('authenticated',
              'public.copilot_plan_create_v1(uuid, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated mat EXECUTE tren copilot_plan_create_v1. DUNG.';
  END IF;
  IF to_regrole('anon') IS NOT NULL
     AND has_function_privilege('anon',
           'public.copilot_plan_create_v1(uuid, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon EXECUTE duoc copilot_plan_create_v1. DUNG.';
  END IF;
  IF to_regrole('service_role') IS NOT NULL
     AND has_function_privilege('service_role',
           'public.copilot_plan_create_v1(uuid, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role EXECUTE duoc copilot_plan_create_v1. DUNG.';
  END IF;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
