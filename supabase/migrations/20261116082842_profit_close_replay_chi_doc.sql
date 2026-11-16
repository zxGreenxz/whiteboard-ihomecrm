-- =============================================================================
-- Chốt / chốt lại lợi nhuận: lượt gửi lại cùng khoá idempotency (replay) là thao tác CHỈ ĐỌC.
--
-- VÌ SAO
--   public._profit_write_close_v2 (lớp bọc của profit_close_v2 / profit_reclose_v2, từ 20260721110000) gọi
--   phần lõi _profit_write_close_v2_base rồi LUÔN hậu xử lý theo v_result->'buildings': UPDATE 5 cột của
--   profit_monthly (shareholder_percent_total, shareholder_allocated_amount, unallocated_profit,
--   unallocated_disposition, unallocated_disposition_reason), ném 55000 'Profit close did not persist
--   building %' nếu không còn dòng, INSERT profit_unallocated_decisions.
--   Khi phần lõi gặp lại cùng p_idempotency_key với cùng nội dung, nó KHÔNG ghi gì và trả result_snapshot
--   của lượt cũ kèm idempotent_replay = true — nhưng lớp bọc vẫn chạy các bước trên với SỐ CỦA LƯỢT CŨ.
--   Nếu giữa hai lượt đã có mở khoá / đặt lại / chốt lại thì replay:
--     · nhà đã đặt lại (không còn dòng profit_monthly) ⇒ ném 55000, nơi gọi kẹt;
--     · nhà đã chốt lại bằng số khác ⇒ 5 cột của bản chốt HIỆN TẠI bị ghi đè bằng số cũ, lệch với
--       profit_allocations;
--     · nhà đã đặt lại rồi chốt mới (dòng profit_monthly mới) ⇒ thêm cả một dòng
--       profit_unallocated_decisions gắn run cũ vào bản chốt mới.
--   Web không gửi lại cùng khoá (mỗi lượt gọi sinh khoá mới), nhưng nơi gọi khác — tích hợp gọi thẳng RPC
--   qua PostgREST, hoặc lớp HTTP / gateway tự gửi lại nguyên request — vẫn đi vào đường này.
--   Lưu ý cho nơi gọi: kết quả replay là ảnh của LƯỢT CŨ, không phải trạng thái hiện tại của tháng.
--
-- LÀM GÌ
--   Thay thân ĐÚNG MỘT hàm: thêm một nhánh ngay sau lời gọi phần lõi — kết quả mang
--   idempotent_replay = true thì RETURN ngay, vẫn qua _profit_enrich_unallocated_v3 (hàm STABLE, chỉ đọc
--   tài liệu + p_adjustments) nên kết quả replay giữ nguyên hình dạng đang trả. Mọi dòng khác của thân
--   giữ nguyên văn (md5 prosrc 78d8a5b4…: thân trong 20260721110000 = thân trong baseline chụp từ
--   production = md5 đọc trên production 22/10/2026, ghim ở dauVanTayChotLnMigration.test.ts).
--   Lượt ghi thật (idempotent_replay = false) không đổi hành vi. Bỏ hậu xử lý ở replay là an toàn: lượt gốc
--   đã chạy trọn hậu xử lý trong CÙNG giao dịch với dòng profit_close_runs mà replay tìm thấy.
--   Giữ chữ ký, SECURITY DEFINER, search_path, owner. Quyền: CREATE OR REPLACE vốn giữ ACL; vẫn cấp lại
--   tường minh (REVOKE PUBLIC + vai API, GRANT service_role) để database dựng lại có cùng quyền.
--   Kiểm trước: thân phải đúng bản đã rà (md5 cũ, hoặc md5 mới — chạy lại được), SECURITY DEFINER,
--   proconfig, tập vai có EXECUTE phải CHỨA tập đã ghim. Lệch ⇒ 55000, không ghi gì.
--   Kiểm sau: md5 đúng bản mới, SECURITY / proconfig / quyền đúng như đã ghim.
--   Không đụng dữ liệu, bảng hay hàm nào khác.
-- =============================================================================

BEGIN;

DO $kiem_truoc$
DECLARE
  r record;
  f record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public._profit_write_close_v2(text,uuid,date,text,text,text,uuid[],jsonb)', '78d8a5b474320e663622da7df461e0a8', 'b1f480706f42b046019d30b28cedbf71', true, '{"search_path=pg_catalog, public"}', 'service_role')
  ) AS t(ham, md5_cu, md5_moi, bao_mat, cau_hinh, quyen) LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) AS md5, p.prosecdef AS bao_mat, p.proconfig::text AS cau_hinh,
           COALESCE((SELECT string_agg(g.vai, ',' ORDER BY g.vai)
                       FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS vai
                               FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                              WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) g), '') AS quyen
      INTO f FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure(r.ham);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Không thấy hàm % — dừng, rà lại', r.ham USING ERRCODE = '55000';
    END IF;
    IF f.md5 NOT IN (r.md5_cu, r.md5_moi) THEN
      RAISE EXCEPTION 'Thân % đã khác bản production đã rà (md5 %) — lấy lại thân rồi rà lại', r.ham, f.md5
        USING ERRCODE = '55000';
    END IF;
    -- Quyền: tập đang có phải CHỨA tập đã ghim. Thiếu ⇒ một PR khác vừa thu quyền ⇒ dừng, không cấp lại.
    -- Dư (database dựng lại từ baseline --no-acl + shim cấp EXECUTE cho cả ba vai API) ⇒ REVOKE/GRANT phía
    -- sau kéo về đúng tập đã ghim; kiểm sau so tuyệt đối.
    IF f.bao_mat IS DISTINCT FROM r.bao_mat OR f.cau_hinh IS DISTINCT FROM r.cau_hinh
       OR NOT (COALESCE(string_to_array(NULLIF(r.quyen, ''), ','), '{}'::text[])
               <@ COALESCE(string_to_array(NULLIF(f.quyen, ''), ','), '{}'::text[])) THEN
      RAISE EXCEPTION 'Thuộc tính % đã khác bản đã ghim (SECURITY DEFINER %, proconfig %, EXECUTE cho [%], cần có [%]) — rà lại',
        r.ham, f.bao_mat, f.cau_hinh, f.quyen, r.quyen USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$kiem_truoc$;

-- public._profit_write_close_v2(text,uuid,date,text,text,text,uuid[],jsonb): thêm nhánh trả sớm khi replay
CREATE OR REPLACE FUNCTION public._profit_write_close_v2(p_operation text, p_organization_id uuid, p_period_month date, p_expected_source_hash text, p_reason text, p_idempotency_key text, p_building_ids uuid[], p_adjustments jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_result jsonb;
  v_row jsonb;
  v_building_id uuid;
  v_unallocated numeric;
  v_percent numeric;
  v_allocated numeric;
  v_disposition text;
  v_disposition_reason text;
  v_pm_id uuid;
  v_run_id uuid;
BEGIN
  v_result := public._profit_write_close_v2_base(
    p_operation, p_organization_id, p_period_month, p_expected_source_hash,
    p_reason, p_idempotency_key, p_building_ids, p_adjustments
  );

  -- Replay idempotent: phan loi tra lai ket qua cua luot da ghi (cung khoa, cung noi dung) va
  -- khong ghi gi. Tra ngay: khong ghi lai profit_monthly / profit_unallocated_decisions bang so
  -- cua luot cu (ban chot hien tai co the da mo khoa / dat lai / chot lai sau luot do).
  IF (v_result->'idempotent_replay') = 'true'::jsonb THEN
    RETURN public._profit_enrich_unallocated_v3(v_result, p_adjustments);
  END IF;

  v_run_id := NULLIF(v_result->>'run_id', '')::uuid;

  FOR v_row IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(v_result->'buildings', '[]'::jsonb)) x(value)
  LOOP
    v_building_id := (v_row->>'building_id')::uuid;
    v_unallocated := COALESCE((v_row->>'unallocated_profit')::numeric, 0);
    v_percent := COALESCE((v_row->>'shareholder_percent_total')::numeric, 0);
    v_allocated := COALESCE((v_row->>'shareholder_allocated_amount')::numeric, 0);

    IF v_unallocated = 'NaN'::numeric
       OR v_percent = 'NaN'::numeric
       OR v_allocated = 'NaN'::numeric
       OR v_percent < 0 OR v_percent > 100 THEN
      RAISE EXCEPTION 'Profit close returned invalid allocation numbers'
        USING ERRCODE = '55000';
    END IF;

    SELECT
      NULLIF(btrim(a.unallocated_disposition), ''),
      NULLIF(btrim(a.unallocated_disposition_reason), '')
    INTO v_disposition, v_disposition_reason
    FROM jsonb_to_recordset(COALESCE(p_adjustments, '[]'::jsonb)) AS a(
      building_id uuid,
      unallocated_disposition text,
      unallocated_disposition_reason text
    )
    WHERE a.building_id = v_building_id
    LIMIT 1;

    IF abs(v_unallocated) >= 0.01 THEN
      IF v_disposition NOT IN ('RETAINED_EARNINGS', 'CARRY_FORWARD') THEN
        RAISE EXCEPTION
          'Building % has unallocated profit %; choose RETAINED_EARNINGS or CARRY_FORWARD',
          v_building_id, v_unallocated
          USING ERRCODE = '22023';
      END IF;
      IF char_length(COALESCE(v_disposition_reason, '')) NOT BETWEEN 8 AND 500 THEN
        RAISE EXCEPTION 'Unallocated disposition reason must contain 8..500 characters'
          USING ERRCODE = '22023';
      END IF;
    ELSE
      v_disposition := NULL;
      v_disposition_reason := NULL;
    END IF;

    UPDATE public.profit_monthly pm
       SET shareholder_percent_total = v_percent,
           shareholder_allocated_amount = v_allocated,
           unallocated_profit = v_unallocated,
           unallocated_disposition = v_disposition,
           unallocated_disposition_reason = v_disposition_reason
     WHERE pm.organization_id = p_organization_id
       AND pm.building_id = v_building_id
       AND pm.period_month = p_period_month
    RETURNING pm.id INTO v_pm_id;

    IF v_pm_id IS NULL THEN
      RAISE EXCEPTION 'Profit close did not persist building %', v_building_id
        USING ERRCODE = '55000';
    END IF;

    IF abs(v_unallocated) >= 0.01 THEN
      INSERT INTO public.profit_unallocated_decisions (
        run_id, organization_id, profit_monthly_id, building_id, period_month,
        unallocated_profit, disposition, reason, decision_source, actor_id
      ) VALUES (
        v_run_id, p_organization_id, v_pm_id, v_building_id, p_period_month,
        v_unallocated, v_disposition, v_disposition_reason,
        CASE WHEN p_operation = 'RECLOSE' THEN 'RECLOSE_V3' ELSE 'CLOSE_V3' END,
        v_actor
      )
      ON CONFLICT (run_id, profit_monthly_id) WHERE run_id IS NOT NULL
      DO NOTHING;
    END IF;
  END LOOP;

  RETURN public._profit_enrich_unallocated_v3(v_result, p_adjustments);
END
$function$;
REVOKE ALL ON FUNCTION public._profit_write_close_v2(text,uuid,date,text,text,text,uuid[],jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._profit_write_close_v2(text,uuid,date,text,text,text,uuid[],jsonb) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._profit_write_close_v2(text,uuid,date,text,text,text,uuid[],jsonb) TO service_role;

DO $kiem_sau$
DECLARE
  r record;
  f record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public._profit_write_close_v2(text,uuid,date,text,text,text,uuid[],jsonb)', 'b1f480706f42b046019d30b28cedbf71', true, '{"search_path=pg_catalog, public"}', 'service_role')
  ) AS t(ham, md5_moi, bao_mat, cau_hinh, quyen) LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) AS md5, p.prosecdef AS bao_mat, p.proconfig::text AS cau_hinh,
           COALESCE((SELECT string_agg(g.vai, ',' ORDER BY g.vai)
                       FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS vai
                               FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                              WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) g), '') AS quyen
      INTO f FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure(r.ham);
    IF NOT FOUND OR f.md5 <> r.md5_moi THEN
      RAISE EXCEPTION 'Sau khi thay, thân % không đúng bản mới', r.ham USING ERRCODE = '55000';
    END IF;
    IF f.bao_mat IS DISTINCT FROM r.bao_mat OR f.cau_hinh IS DISTINCT FROM r.cau_hinh OR f.quyen IS DISTINCT FROM r.quyen THEN
      RAISE EXCEPTION 'Sau khi thay, % lệch SECURITY / proconfig / quyền', r.ham USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$kiem_sau$;

COMMIT;
