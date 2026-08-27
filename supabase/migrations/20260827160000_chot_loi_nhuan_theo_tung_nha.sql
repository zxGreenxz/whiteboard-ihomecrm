-- =====================================================================
-- CHỐT LỢI NHUẬN THEO TỪNG NHÀ (Profit Close V2 — partial close)
--
-- VẤN ĐỀ. `_profit_write_close_v2_base` đang bắt CLOSE/RECLOSE phải phủ MỌI nhà
-- thật của tổ chức. Chủ muốn trả phần lợi nhuận đầu tư tháng 7/2026 cho hai nhân
-- viên vừa là cổ đông (JOEY, NATHAN — rải trên 6 nhà) thì phải chốt luôn cả 18
-- nhà, kéo theo khoá phiếu thu-chi của 12 nhà sổ sách chưa xong. Muốn ghi tiếp
-- phải "Mở khoá tháng", mà mở khoá thì XOÁ phần đã phân bổ và phải chốt lại.
--
-- VÌ SAO GUARD ĐÓ TỪNG ĐÚNG. Quy tắc lương điều hành `basis='TOTAL_GROUP'` chia
-- một khoản cho CẢ NHÓM nhà theo lợi nhuận từng nhà (xem
-- `_profit_management_allocations_v2`: `positive_base_sum` cộng trên các nhà của
-- quy tắc CÓ MẶT trong tập truyền vào). Chốt lẻ 1 trong 4 nhà của một quy tắc
-- FIXED 3.000.000đ sẽ dồn gần trọn 3 triệu vào nhà đó, làm sai số đã chia cho cổ
-- đông, và KHÔNG có gì báo. Guard toàn-phủ là cách chữa thô của chuyện này.
--
-- CÁCH CHỮA Ở ĐÂY — tách PHẠM VI TÍNH khỏi PHẠM VI GHI:
--
--   1) Preview canonical + `source_hash` + `building_source_hash` vẫn dựng trên
--      TOÀN BỘ nhà thật của tổ chức, y như trước. Nhờ vậy:
--        - CAS chống-nguồn-đổi vẫn canh cả tháng (mạnh hơn canh từng nhà);
--        - `building_source_hash` GIỮ NGUYÊN công thức, nên snapshot đã LOCKED
--          của các tháng cũ KHÔNG bị hoá "lệch nguồn" sau bản này;
--        - `app_private.current_profit_building_source_hash_v1` dựng lại hash từ
--          `profit_close_runs.source_snapshot->'pnl'` — ta vẫn ghi source_snapshot
--          toàn tháng nên đường canh độ tươi của phiếu chi cổ đông không đổi.
--   2) Chỉ GHI những nhà được yêu cầu.
--   3) Tập ghi phải ĐÓNG THEO TOTAL_GROUP: với mỗi quy tắc TOTAL_GROUP đang
--      active, tập ghi chứa TẤT CẢ hoặc KHÔNG nhà nào của quy tắc đó. Đây là thứ
--      thật sự bảo vệ con số, thay cho guard toàn-phủ.
--
-- Hệ quả của (1)+(3): số hiển thị của nhà được chọn LUÔN bằng số được ghi — điều
-- chỉnh của nhà không được chọn không thể làm lệch nhà được chọn, vì mọi nhà
-- cùng nhóm TOTAL_GROUP bắt buộc nằm chung tập ghi.
--
-- Ba thứ đã sẵn sàng cho chốt lẻ, không phải sửa: trigger khoá phiếu
-- (`assert_period_open_for_edit_v1` so `pm.building_id = v_row.building_id` —
-- theo TỪNG toà), `_profit_state_change_v2` (UNLOCK/RESET) và
-- `unlock_profit_month_v1` đều đã nhận tập toà con.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1) Bản đồ nhóm TOTAL_GROUP cho giao diện.
--
--    Giao diện cần biết "chọn nhà này thì phải chọn thêm nhà nào" TRƯỚC khi bấm
--    chốt, để tự mở rộng vùng chọn và nói rõ lý do — thay vì để người dùng ăn
--    một EXCEPTION sau khi đã điền xong lý do cho từng nhà.
--
--    Cố ý KHÔNG nhét dữ liệu này vào preview: mọi khoá mới trong tài liệu nguồn
--    đều đổi `building_source_hash` và làm mọi snapshot đang LOCKED hoá stale.
--    Đây là cấu hình mức tổ chức, không phụ thuộc tháng, nên đứng riêng là đúng.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.profit_total_group_peers_v2(
  p_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public._profit_assert_authorized_v2(
    p_organization_id, 'shareholder_profit.view'
  );

  WITH rule_buildings AS (
    SELECT
      s.id AS rule_id,
      COALESCE(NULLIF(btrim(s.label), ''), m.name) AS rule_label,
      rb.building_id,
      b.name AS building_name
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
  ),
  pairs AS (
    SELECT DISTINCT
      me.building_id,
      peer.building_id AS peer_id,
      peer.building_name AS peer_name,
      me.rule_label
    FROM rule_buildings me
    JOIN rule_buildings peer ON peer.rule_id = me.rule_id
  ),
  grouped AS (
    SELECT
      building_id,
      jsonb_agg(DISTINCT peer_id) AS peer_ids,
      string_agg(DISTINCT peer_name, ', ') AS peer_names,
      string_agg(DISTINCT rule_label, ', ') AS rule_labels
    FROM pairs
    GROUP BY building_id
  )
  SELECT COALESCE(
    jsonb_object_agg(
      building_id::text,
      jsonb_build_object(
        'peer_ids', peer_ids,
        'peer_names', peer_names,
        'rule_labels', rule_labels
      )
    ),
    '{}'::jsonb
  )
  INTO v_result
  FROM grouped;

  RETURN COALESCE(v_result, '{}'::jsonb);
END
$fn$;

REVOKE ALL ON FUNCTION public.profit_total_group_peers_v2(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.profit_total_group_peers_v2(uuid)
  TO authenticated;
COMMENT ON FUNCTION public.profit_total_group_peers_v2(uuid) IS
  'Ban do nha -> cac nha phai chot cung vi dung chung quy tac luong dieu hanh TOTAL_GROUP. Chi de giao dien mo rong vung chon; KHONG nam trong tai lieu nguon nen khong dung toi building_source_hash.';

-- ---------------------------------------------------------------------
-- 2) Writer: tính cả tháng, ghi tập được chọn.
--
--    Chép nguyên thân bản đang chạy (định nghĩa gốc ở 20260720210000, đã bị
--    ALTER ... RENAME TO _profit_write_close_v2_base ở 20260721110000) và chỉ
--    đổi bốn chỗ, đánh dấu bằng "DOI ->" bên dưới.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._profit_write_close_v2_base(
  p_operation text,
  p_organization_id uuid,
  p_period_month date,
  p_expected_source_hash text,
  p_reason text,
  p_idempotency_key text,
  p_building_ids uuid[],
  p_adjustments jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
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
      USING ERRCODE = '40001';
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
$fn$;

COMMENT ON FUNCTION public._profit_write_close_v2_base(
  text, uuid, date, text, text, text, uuid[], jsonb
) IS
  'Writer CLOSE/RECLOSE. Tinh tren toan bo nha that cua to chuc (source_hash + building_source_hash khong doi cong thuc), chi GHI cac nha trong p_building_ids. Tap ghi phai dong theo tung quy tac luong TOTAL_GROUP.';

-- ---------------------------------------------------------------------
-- 3) Dat lai theo tung nha.
--
--    `profit_reset_checked_v2` truoc day khong co tham so toa va luon reset ca
--    ky. Them `p_target_building_ids`: CAS van o muc TOAN KY (expected_state_hash
--    + expected_snapshot_ids phai khop toan bo snapshot dang co cua thang) —
--    khong noi cho nay, vi no la thu chan reset tren trang thai da cu. Chi RIENG
--    tac dong moi thu hep lai.
--
--    Bat buoc DROP roi CREATE: `CREATE OR REPLACE` voi chu ky khac se de ra
--    overload va PostgREST chon nham ham.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.profit_reset_checked_v2(
  uuid, date, text, text, text, uuid[]
);

CREATE FUNCTION public.profit_reset_checked_v2(
  p_organization_id uuid,
  p_period_month date,
  p_reason text,
  p_idempotency_key text,
  p_expected_state_hash text,
  p_expected_snapshot_ids uuid[],
  p_target_building_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
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
      USING ERRCODE = '40001';
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
$fn$;

REVOKE ALL ON FUNCTION public.profit_reset_checked_v2(
  uuid, date, text, text, text, uuid[], uuid[]
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.profit_reset_checked_v2(
  uuid, date, text, text, text, uuid[], uuid[]
) TO authenticated;
COMMENT ON FUNCTION public.profit_reset_checked_v2(
  uuid, date, text, text, text, uuid[], uuid[]
) IS
  'Hard reset protected by exact snapshot IDs and a deterministic snapshot/allocation state hash. p_target_building_ids NULL = ca ky; khac NULL = chi dat lai cac nha do (CAS van o muc toan ky).';

COMMIT;

NOTIFY pgrst, 'reload schema';
