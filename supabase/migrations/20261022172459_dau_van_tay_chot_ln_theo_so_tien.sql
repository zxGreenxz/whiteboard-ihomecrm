-- =============================================================================
-- dau_van_tay_chot_ln_theo_so_tien — dấu vân tay Chốt LN (Profit Close V2) chỉ theo
-- số tiền, theo từng toà (22/10/2026; đợt rà Báo cáo Lợi nhuận 21/10: F19)
-- =============================================================================
-- LỖI
--   profit_monthly.source_hash = "dấu vân tay" từng toà lúc chốt (building_source_hash
--   của _profit_close_preview_core_v2, thuật toán 'profit-close-v2.1').
--   app_private.current_profit_building_source_hash_v1 dựng lại nó từ dữ liệu hiện tại và
--   app_private.profit_monthly_source_is_current_v1 so hai bên; lệch ⇒ "lệch nguồn" ⇒
--   assert_profit_payout_fresh_v2 chặn chi lợi nhuận cổ đông qua app. Dấu v2.1 băm:
--     - số liệu MỌI toà trong lượt chốt KÈM TÊN toà (source_building_bases);
--     - từng dòng phân bổ kèm building_name, type_name, category;
--     - cấu hình cổ đông kèm shareholder_name; quy tắc lương kèm manager_name, label.
--   ⇒ đổi tên một hạng mục / toà / cổ đông / quản lý, hoặc số của MỘT toà bất kỳ, làm
--   MỌI dòng cùng tháng "lệch nguồn". Production 22/10 (chỉ đọc): 30/30 dòng LOCKED
--   không hiện hành (12 dòng chốt V2 lệch hash, 18 dòng cũ chưa có lượt chốt V2).
--
-- THUẬT TOÁN MỚI 'profit-close-v2.2' (chủ chốt 22/10: "dấu vân tay chốt LN chỉ theo số
-- tiền, áp cho LẦN CHỐT MỚI, 30 dòng cũ giữ nguyên")
--   app_private.profit_building_source_hash_v2_2(tài liệu nguồn, toà) — hàm THUẦN, chiếu
--   tài liệu nguồn (cùng hình dạng v2.1) xuống đúng phần ảnh hưởng tới số của toà:
--     - toà: building_id, period_month, doanh thu / chi phí / LN;
--     - dòng phân bổ của toà: month, voucher_id, side, type_id, amount — không tên/nhóm;
--     - cấu hình cổ đông của toà: shareholder_id, percent — không tên;
--     - quy tắc lương điều hành có dính toà: rule_id, manager_id, form, basis, amount,
--       percent, building_ids — không tên/nhãn;
--     - CHỈ quy tắc tính trên tổng nhóm (basis khác 'PER_BUILDING', tức 'TOTAL_GROUP' — xem
--       _profit_management_allocations_v2: chia theo LN dương của cả nhóm) mới kéo thêm
--       doanh thu / chi phí / LN (không tên) của các toà cùng quy tắc đó. Toà không chung
--       quy tắc nhóm không ảnh hưởng nhau.
--   building_ids của quy tắc (kể cả PER_BUILDING) nằm trong dấu theo đúng yêu cầu: thêm/bớt
--   toà khỏi một quy tắc là đổi CẤU HÌNH lương ⇒ các toà của quy tắc đó lệch (cố ý thận trọng).
--   Điều chỉnh tay (adjustment) không thuộc tài liệu nguồn — như v2.1.
--   Số tiền chuẩn hoá bằng trim_scale (100000 và 100000.00 là một), thứ tự sắp COLLATE "C".
--   Preview và đường kiểm độ tươi gọi CÙNG hàm chiếu ⇒ một định nghĩa, không chép công thức.
--
-- GHI NHẬN PHIÊN BẢN — cách ít xâm lấn nhất, KHÔNG đổi bảng, KHÔNG đổi writer
--   _profit_close_preview_core_v2 trả 'algorithm_version' = 'profit-close-v2.2' ở GỐC
--   preview (tài liệu nguồn source_snapshot vẫn 'profit-close-v2.1' ⇒ source_hash toàn tháng
--   — CAS expected_source_hash — giữ nguyên công thức VÀ giá trị). Writer đang chạy
--   (_profit_write_close_v2_base, không đổi) vốn chép v_preview->>'algorithm_version' vào
--   profit_close_revisions.source_snapshot của TỪNG toà và ghi v_preview || … vào
--   profit_close_runs.result_snapshot ⇒ mỗi lần CLOSE/RECLOSE mới tự mang dấu 'v2.2';
--   dòng cũ mang 'v2.1'. Không thêm cột vào profit_monthly: cột mới đổi to_jsonb(pm) trong
--   ảnh chụp/trạng thái, generated types và PostgREST — rộng hơn cần thiết.
--   app_private.profit_building_source_hash_algorithm_v1(pm) đọc dấu đó từ revision ghi
--   source_hash mới nhất của dòng (BASELINE/CLOSE/RECLOSE; với dòng LOCKED chính là revision
--   hiện hành mà v1 dùng); không có dấu 'v2.2' ⇒ 'v2.1'.
--
-- SO THEO ĐÚNG PHIÊN BẢN
--   - app_private.profit_monthly_source_is_current_v1 (giữ chữ ký, kiểu trả về, DEFINER,
--     STABLE, search_path, ACL): dòng 'v2.2' ⇒ current_profit_building_source_hash_v2,
--     dòng còn lại ⇒ current_profit_building_source_hash_v1 Y NGUYÊN (KHÔNG thay hàm v1:
--     md5 pg_get_functiondef 13512e71…, prosrc 36611055… giữ nguyên).
--   - app_private.current_profit_building_source_hash_v2 = thân v1 đang chạy (dựng lại tài
--     liệu nguồn từ dữ liệu hiện tại trên đúng tập toà của lượt chốt, giữ mọi kiểm cấu trúc
--     trả NULL) với hai chỗ đổi đánh dấu "20261022172459": chỉ nhận revision mang
--     'v2.2', và băm bằng hàm chiếu.
--   - _profit_close_preview_core_v2: building_source_hash = dấu v2.2 (writer ghi dấu này cho
--     lần chốt mới); cờ current_hash_mismatch / current_is_stale / current_stale_reason so
--     dòng 'v2.1' với dấu v2.1 cũ (biểu thức giữ nguyên từng chữ), dòng 'v2.2' với dấu v2.2.
--
-- KHÔNG ĐỤNG
--   Dữ liệu (không UPDATE/DELETE profit_monthly / profit_close_* / phân bổ), writer, wrapper,
--   CAS toàn tháng, guard TOTAL_GROUP, current_profit_building_source_hash_v1. 30 dòng cũ vẫn
--   báo "lệch nguồn" như hiện nay — chủ tự mở chốt + chốt lại khi muốn; lần chốt lại đó ghi
--   dấu v2.2. Kiểm cấu trúc fail-closed của v1 (toà trong lượt chốt bị xoá/ảo, cấu hình cổ
--   đông/lương hỏng) giữ nguyên trong v2.
--
-- THÂN GỐC
--   pg_get_functiondef production đọc 22/10/2026, đọc lại 22/10 17:2x UTC trước khi viết
--   bản này (TEST cùng md5, baseline cùng md5; chưa có hàm mới, 0 revision mang 'v2.2'):
--     _profit_close_preview_core_v2           prosrc ff014d6c3b84fb5c4e04f4579f787ce4
--       (repo 20260720215000 lệch thứ tự LOCK — bản production/baseline là gốc ở đây)
--     current_profit_building_source_hash_v1  prosrc 366110557ac4e6c4ec2b6c0176ba3f89
--     profit_monthly_source_is_current_v1     prosrc b33478e043a11eb08ad7d265ae156522
--   Tiền kiểm nhận đúng thân đó hoặc chính thân mới (chạy lại); thân khác ⇒ DỪNG 55000.
--   Ba hàm mới nếu đã có (chạy lại) cũng phải đúng md5 thân bản này.
--
-- ĐƯỜNG LÙI
--   Forward migration CREATE OR REPLACE lại hai thân cũ (preview core ff014d6c…, dispatcher
--   b33478e0…). Dòng đã chốt bằng v2.2 khi đó sẽ hoá "lệch nguồn" (so bằng v1) cho tới khi
--   chốt lại — không mất dữ liệu.
--
-- Chạy được hai lượt liên tiếp (tiền kiểm nhận thân mới; mọi đối tượng CREATE OR REPLACE).
-- =============================================================================

BEGIN;

-- 0. Tiền kiểm — không thay mù lên định nghĩa lạ.
DO $truoc$
DECLARE
  v_md5 text;
  v_src text;
  v_own record;
BEGIN
  IF to_regclass('public.profit_monthly') IS NULL
     OR to_regclass('public.profit_close_runs') IS NULL
     OR to_regclass('public.profit_close_revisions') IS NULL
     OR to_regprocedure('public._profit_management_allocations_v2(uuid,jsonb)') IS NULL
     OR to_regprocedure('public.fa_accrual_allocations(date,date,uuid[])') IS NULL
     OR to_regprocedure('public.fa_monthly_pnl_accrual(date,date,uuid[])') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng/hàm nền của Chốt LN V2 — DỪNG.' USING ERRCODE = '55000';
  END IF;

  -- v2 sao từ thân v1 đang chạy: v1 khác ⇒ bản sao này cũ.
  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('app_private.current_profit_building_source_hash_v1(uuid)');
  IF v_md5 IS DISTINCT FROM '366110557ac4e6c4ec2b6c0176ba3f89' THEN
    RAISE EXCEPTION 'current_profit_building_source_hash_v1 KHÁC bản đã đối chiếu (md5 %) — DỪNG, đọc pg_get_functiondef trước khi replace.',
      v_md5 USING ERRCODE = '55000';
  END IF;

  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('app_private.profit_monthly_source_is_current_v1(uuid)');
  IF v_md5 IS NULL OR v_md5 NOT IN (
       'b33478e043a11eb08ad7d265ae156522',   -- production + TEST + baseline 22/10/2026
       '64468f83cf2e86ad0f5012b2d98112fe'    -- chính bản này (chạy lại)
     ) THEN
    RAISE EXCEPTION 'profit_monthly_source_is_current_v1 KHÁC bản đã đối chiếu (md5 %) — DỪNG, đọc pg_get_functiondef trước khi replace.',
      v_md5 USING ERRCODE = '55000';
  END IF;

  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
  FROM pg_proc p
  WHERE p.oid = to_regprocedure(
    'public._profit_close_preview_core_v2(uuid,date,uuid[],jsonb,text,boolean)'
  );
  IF v_md5 IS NULL OR v_md5 NOT IN (
       'ff014d6c3b84fb5c4e04f4579f787ce4',   -- production + TEST + baseline 22/10/2026
       'd18891741a071eaf74469c39f6ded98e'    -- chính bản này (chạy lại)
     ) THEN
    RAISE EXCEPTION '_profit_close_preview_core_v2 KHÁC bản đã đối chiếu (md5 %) — DỪNG, đọc pg_get_functiondef trước khi replace.',
      v_md5 USING ERRCODE = '55000';
  END IF;

  -- Hàm mới của chính migration này: đã có (chạy lại) thì phải đúng thân bản này — không
  -- đè lên một bản về sau đã sửa.
  FOR v_own IN
    SELECT *
    FROM (VALUES
      ('app_private.profit_building_source_hash_v2_2(jsonb,uuid)',
       '8c450fe0f6d2b884bd787b3620792b81'),
      ('app_private.profit_building_source_hash_algorithm_v1(uuid)',
       'eb80060667005cf8796192d66c55e333'),
      ('app_private.current_profit_building_source_hash_v2(uuid)',
       'b34fee7ef639a55e80ed9df318dee052')
    ) own(signature, expected_md5)
  LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
    FROM pg_proc p
    WHERE p.oid = to_regprocedure(v_own.signature);
    IF v_md5 IS NOT NULL AND v_md5 <> v_own.expected_md5 THEN
      RAISE EXCEPTION '% đã có với thân KHÁC bản này (md5 %) — DỪNG, đọc pg_get_functiondef trước khi replace.',
        v_own.signature, v_md5 USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- Lần áp đầu (preview core còn thân production): chưa revision nào mang dấu 'v2.2' ⇒
  -- mọi dòng đang có giữ cách so v1.
  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
  FROM pg_proc p
  WHERE p.oid = to_regprocedure(
    'public._profit_close_preview_core_v2(uuid,date,uuid[],jsonb,text,boolean)'
  );
  IF v_md5 = 'ff014d6c3b84fb5c4e04f4579f787ce4' AND EXISTS (
    SELECT 1
    FROM public.profit_close_revisions revision
    WHERE revision.source_snapshot->>'algorithm_version' = 'profit-close-v2.2'
  ) THEN
    RAISE EXCEPTION 'Đã có revision mang dấu profit-close-v2.2 trước migration — DỪNG, dòng cũ sẽ đổi cách so.'
      USING ERRCODE = '55000';
  END IF;

  -- Writer KHÔNG thay nhưng là thứ mang dấu phiên bản: phải còn chép algorithm_version của
  -- preview vào revision và lưu building_source_hash + tài liệu nguồn toàn tháng.
  SELECT replace(p.prosrc, chr(13), '') INTO v_src
  FROM pg_proc p
  WHERE p.oid = to_regprocedure(
    'public._profit_write_close_v2_base(text,uuid,date,text,text,text,uuid[],jsonb)'
  );
  IF v_src IS NULL
     OR position('''algorithm_version'', v_preview->>''algorithm_version''' IN v_src) = 0
     OR position('v_row->>''building_source_hash''' IN v_src) = 0
     OR position('v_preview->''source_snapshot''' IN v_src) = 0 THEN
    RAISE EXCEPTION '_profit_write_close_v2_base không còn chép algorithm_version / building_source_hash / source_snapshot của preview — DỪNG.'
      USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- 1. Hàm chiếu THUẦN (không đọc bảng): tài liệu nguồn hình dạng 'profit-close-v2.1' →
--    dấu 'profit-close-v2.2' của MỘT toà. Preview (lúc chốt) và kiểm độ tươi (sau chốt) cùng
--    gọi hàm này nên hai bên không thể lệch công thức. Tài liệu sai hình dạng, toà không có
--    đúng một dòng pnl ⇒ NULL (không bao giờ "khớp").
CREATE OR REPLACE FUNCTION app_private.profit_building_source_hash_v2_2(
  p_source_document jsonb,
  p_building_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO pg_catalog
AS $fn$
  WITH document AS (
    SELECT
      p_source_document AS value,
      p_building_id::text AS building_key
    WHERE p_source_document->>'algorithm_version' = 'profit-close-v2.1'
      AND p_building_id IS NOT NULL
  ),
  pnl AS (
    SELECT
      entry.value->>'building_id' AS building_key,
      trim_scale((entry.value->>'revenue')::numeric) AS revenue,
      trim_scale((entry.value->>'expense')::numeric) AS expense,
      trim_scale((entry.value->>'net')::numeric) AS net
    FROM document
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(document.value->'pnl') = 'array'
          THEN document.value->'pnl'
        ELSE '[]'::jsonb
      END
    ) entry(value)
  ),
  own AS (
    SELECT pnl.revenue, pnl.expense, pnl.net
    FROM pnl
    JOIN document ON document.building_key = pnl.building_key
  ),
  rules AS (
    SELECT entry.value
    FROM document
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(document.value->'manager_salary_rules') = 'array'
          THEN document.value->'manager_salary_rules'
        ELSE '[]'::jsonb
      END
    ) entry(value)
    WHERE jsonb_typeof(entry.value->'building_ids') = 'array'
      AND entry.value->'building_ids' @> jsonb_build_array(document.building_key)
  ),
  -- Chỉ quy tắc tính trên TỔNG NHÓM mới làm số của toà phụ thuộc toà khác
  -- (_profit_management_allocations_v2: basis 'PER_BUILDING' chỉ dùng base của chính
  -- toà; còn lại — 'TOTAL_GROUP' — chia theo LN dương của cả nhóm). Ngoài 'PER_BUILDING'
  -- đều coi là nhóm: basis mới sau này mặc định thận trọng (kéo theo toà cùng nhóm).
  peers AS (
    SELECT DISTINCT member.building_key
    FROM rules
    CROSS JOIN LATERAL jsonb_array_elements_text(
      rules.value->'building_ids'
    ) member(building_key)
    CROSS JOIN document
    WHERE rules.value->>'basis' IS DISTINCT FROM 'PER_BUILDING'
      AND member.building_key <> document.building_key
  )
  SELECT md5(jsonb_build_object(
    'algorithm_version', 'profit-close-v2.2',
    'organization_id', document.value->'organization_id',
    'period_month', document.value->'period_month',
    'building_id', document.building_key,
    'pnl', jsonb_build_object(
      'revenue', own.revenue,
      'expense', own.expense,
      'net', own.net
    ),
    'accrual_lines', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'month', line.value->'month',
          'voucher_id', line.value->'voucher_id',
          'side', line.value->'side',
          'type_id', line.value->'type_id',
          'amount', trim_scale((line.value->>'amount')::numeric)
        ) ORDER BY
          (line.value->>'voucher_id') COLLATE "C",
          (line.value->>'side') COLLATE "C",
          (line.value->>'type_id') COLLATE "C" NULLS FIRST,
          (line.value->>'month') COLLATE "C",
          (line.value->>'amount')::numeric
      )
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(document.value->'accrual_lines') = 'array'
            THEN document.value->'accrual_lines'
          ELSE '[]'::jsonb
        END
      ) line(value)
      WHERE line.value->>'building_id' = document.building_key
    ), '[]'::jsonb),
    'shareholder_config', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'shareholder_id', config.value->'shareholder_id',
          'percent', trim_scale((config.value->>'percent')::numeric)
        ) ORDER BY
          (config.value->>'shareholder_id') COLLATE "C",
          (config.value->>'percent')::numeric
      )
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(document.value->'shareholder_config') = 'array'
            THEN document.value->'shareholder_config'
          ELSE '[]'::jsonb
        END
      ) config(value)
      WHERE config.value->>'building_id' = document.building_key
    ), '[]'::jsonb),
    'manager_salary_rules', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'rule_id', rules.value->'rule_id',
          'manager_id', rules.value->'manager_id',
          'form', rules.value->'form',
          'basis', rules.value->'basis',
          'amount', trim_scale((rules.value->>'amount')::numeric),
          'percent', trim_scale((rules.value->>'percent')::numeric),
          'building_ids', (
            SELECT jsonb_agg(member.building_key ORDER BY member.building_key COLLATE "C")
            FROM jsonb_array_elements_text(rules.value->'building_ids') member(building_key)
          )
        ) ORDER BY (rules.value->>'rule_id') COLLATE "C"
      )
      FROM rules
    ), '[]'::jsonb),
    'total_group_peer_pnl', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'building_id', peers.building_key,
          'revenue', pnl.revenue,
          'expense', pnl.expense,
          'net', pnl.net
        ) ORDER BY peers.building_key COLLATE "C"
      )
      FROM peers
      LEFT JOIN pnl ON pnl.building_key = peers.building_key
    ), '[]'::jsonb)
  )::text)
  FROM document
  CROSS JOIN own
  WHERE (SELECT count(*) FROM own) = 1;
$fn$;

-- 2. Phiên bản thuật toán của profit_monthly.source_hash đang lưu. source_hash chỉ do
--    revision BASELINE / CLOSE / RECLOSE ghi (UNLOCK chỉ đổi trạng thái + revision_number,
--    RESET xoá dòng) ⇒ đọc revision ghi-hash MỚI NHẤT của dòng (<= revision_number). Với
--    dòng LOCKED đó chính là revision hiện hành mà current_profit_building_source_hash_v1/v2
--    dùng; với dòng đã mở chốt (DRAFT) nó là lần chốt đã sinh ra source_hash. Writer chép
--    'algorithm_version' của preview vào revision.source_snapshot; không có dấu 'v2.2'
--    (mọi revision trước migration này, BASELINE) ⇒ 'profit-close-v2.1'.
CREATE OR REPLACE FUNCTION app_private.profit_building_source_hash_algorithm_v1(
  p_profit_monthly_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public, app_private
AS $fn$
  SELECT CASE
    WHEN (
      SELECT revision.source_snapshot->>'algorithm_version'
      FROM public.profit_monthly profit
      JOIN public.profit_close_revisions revision
        ON revision.profit_monthly_id = profit.id
       AND revision.organization_id = profit.organization_id
       AND revision.building_id = profit.building_id
       AND revision.period_month = profit.period_month
       AND revision.revision_number <= profit.revision_number
       AND revision.operation IN ('BASELINE', 'CLOSE', 'RECLOSE')
      WHERE profit.id = p_profit_monthly_id
      ORDER BY revision.revision_number DESC
      LIMIT 1
    ) = 'profit-close-v2.2' THEN 'profit-close-v2.2'
    ELSE 'profit-close-v2.1'
  END;
$fn$;

-- 3. Dựng lại dấu v2.2 từ dữ liệu hiện tại: thân current_profit_building_source_hash_v1
--    đang chạy (366110557…), hai chỗ đổi đánh dấu "20261022172459".
CREATE OR REPLACE FUNCTION app_private.current_profit_building_source_hash_v2(p_profit_monthly_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_profit public.profit_monthly%ROWTYPE;
  v_building_ids uuid[];
  v_hash text;
BEGIN
  SELECT profit.* INTO v_profit
  FROM public.profit_monthly profit
  WHERE profit.id = p_profit_monthly_id;
  IF NOT FOUND OR v_profit.status <> 'LOCKED' THEN
    RETURN NULL;
  END IF;

  SELECT array_agg(
           DISTINCT (source_row.value->>'building_id')::uuid
           ORDER BY (source_row.value->>'building_id')::uuid
         )
    INTO v_building_ids
  FROM public.profit_close_revisions revision
  JOIN public.profit_close_runs run ON run.id = revision.run_id
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(run.source_snapshot->'pnl') = 'array'
        THEN run.source_snapshot->'pnl'
      ELSE '[]'::jsonb
    END
  ) source_row(value)
  WHERE revision.profit_monthly_id = v_profit.id
    AND revision.organization_id = v_profit.organization_id
    AND revision.building_id = v_profit.building_id
    AND revision.period_month = v_profit.period_month
    AND revision.revision_number = v_profit.revision_number
    AND revision.operation IN ('CLOSE', 'RECLOSE')
    AND run.organization_id = v_profit.organization_id
    AND run.period_month = v_profit.period_month
    AND run.source_snapshot->>'algorithm_version' = 'profit-close-v2.1'
    -- 20261022172459: chỉ revision chốt bằng dấu v2.2 (preview ghi vào revision).
    AND revision.source_snapshot->>'algorithm_version' = 'profit-close-v2.2';

  IF v_building_ids IS NULL
     OR NOT (v_profit.building_id = ANY(v_building_ids)) THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(v_building_ids) source_building(building_id)
    LEFT JOIN public.buildings building
      ON building.id = source_building.building_id
    WHERE building.id IS NULL
       OR building.organization_id IS DISTINCT FROM v_profit.organization_id
       OR building.deleted_at IS NOT NULL
       OR building.is_virtual
  ) THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.building_shareholders building_shareholder
    LEFT JOIN public.shareholders shareholder
      ON shareholder.id = building_shareholder.shareholder_id
    WHERE building_shareholder.building_id = ANY(v_building_ids)
      AND (
        building_shareholder.organization_id IS DISTINCT FROM
          v_profit.organization_id
        OR shareholder.id IS NULL
        OR shareholder.organization_id IS DISTINCT FROM
          v_profit.organization_id
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.building_shareholders building_shareholder
    JOIN public.shareholders shareholder
      ON shareholder.id = building_shareholder.shareholder_id
     AND shareholder.organization_id = v_profit.organization_id
     AND shareholder.is_active
     AND shareholder.deleted_at IS NULL
    WHERE building_shareholder.building_id = ANY(v_building_ids)
      AND building_shareholder.organization_id = v_profit.organization_id
    GROUP BY building_shareholder.building_id
    HAVING sum(building_shareholder.percent) > 100
  ) THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profit_manager_salary_buildings salary_building
    JOIN public.profit_manager_salaries salary
      ON salary.id = salary_building.salary_id
    LEFT JOIN public.profit_managers manager ON manager.id = salary.manager_id
    WHERE salary_building.building_id = ANY(v_building_ids)
      AND salary.is_active
      AND (
        manager.id IS NULL
        OR (
          manager.is_active
          AND manager.deleted_at IS NULL
          AND (
            salary_building.organization_id IS DISTINCT FROM
              v_profit.organization_id
            OR salary.organization_id IS DISTINCT FROM
              v_profit.organization_id
            OR manager.organization_id IS DISTINCT FROM
              v_profit.organization_id
          )
        )
      )
  ) THEN
    RETURN NULL;
  END IF;

  WITH selected AS MATERIALIZED (
    SELECT
      building.id AS building_id,
      building.name AS building_name
    FROM public.buildings building
    WHERE building.id = ANY(v_building_ids)
  ),
  vouchers AS MATERIALIZED (
    SELECT
      voucher.id,
      voucher.type::text AS side,
      voucher.voucher_date,
      selected.building_id,
      selected.building_name,
      voucher.total_amount,
      voucher.business_result_accounting AS override,
      CASE
        WHEN voucher.invoice_id IS NOT NULL
         AND invoice.billing_month ~ '^\d{4}-\d{2}$'
          THEN to_date(invoice.billing_month, 'YYYY-MM')
      END AS invoice_month
    FROM selected
    JOIN public.income_expenses voucher
      ON voucher.building_id = selected.building_id
    LEFT JOIN public.invoices invoice
      ON invoice.id = voucher.invoice_id
     AND invoice.deleted_at IS NULL
    WHERE voucher.deleted_at IS NULL
      AND voucher.approval_status = 'APPROVED'
      AND voucher.business_result_accounting IS DISTINCT FROM false
  ),
  invoice_items AS (
    SELECT
      voucher.invoice_month AS month,
      voucher.id AS voucher_id,
      voucher.building_id,
      voucher.building_name,
      voucher.side,
      type_row.id AS type_id,
      type_row.name AS type_name,
      type_row.category,
      COALESCE(item.amount, item.unit_price * item.quantity)::numeric AS amount
    FROM vouchers voucher
    JOIN public.income_expense_items item
      ON item.income_expense_id = voucher.id
    JOIN public.income_expense_types type_row
      ON type_row.id = item.income_expense_type_id
    WHERE voucher.invoice_month IS NOT NULL
      AND (voucher.override IS TRUE OR item.accounting_class = 'PNL')
  ),
  invoice_no_item AS (
    SELECT
      voucher.invoice_month AS month,
      voucher.id AS voucher_id,
      voucher.building_id,
      voucher.building_name,
      voucher.side,
      NULL::uuid AS type_id,
      U&'Kh\00F4ng c\00F3 h\1EA1ng m\1EE5c'::text AS type_name,
      NULL::text AS category,
      voucher.total_amount::numeric AS amount
    FROM vouchers voucher
    WHERE voucher.invoice_month IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.income_expense_items item
        WHERE item.income_expense_id = voucher.id
      )
  ),
  period_items AS (
    SELECT
      (
        date_trunc('month', item.start_date)
        + (series.i || ' month')::interval
      )::date AS month,
      voucher.id AS voucher_id,
      voucher.building_id,
      voucher.building_name,
      voucher.side,
      type_row.id AS type_id,
      type_row.name AS type_name,
      type_row.category,
      (
        round(
          COALESCE(item.amount, item.unit_price * item.quantity)
          * (series.i + 1) / month_count.n
        )
        - round(
          COALESCE(item.amount, item.unit_price * item.quantity)
          * series.i / month_count.n
        )
      )::numeric AS amount
    FROM vouchers voucher
    JOIN public.income_expense_items item
      ON item.income_expense_id = voucher.id
    JOIN public.income_expense_types type_row
      ON type_row.id = item.income_expense_type_id
    CROSS JOIN LATERAL (
      SELECT GREATEST(
        extract(year FROM item.end_date)::integer * 12
          + extract(month FROM item.end_date)::integer
          - extract(year FROM item.start_date)::integer * 12
          - extract(month FROM item.start_date)::integer
          + 1,
        1
      ) AS n
    ) month_count
    CROSS JOIN LATERAL generate_series(
      0, month_count.n - 1
    ) AS series(i)
    WHERE voucher.invoice_month IS NULL
      AND (voucher.override IS TRUE OR item.accounting_class = 'PNL')
      AND item.start_date IS NOT NULL
      AND item.end_date IS NOT NULL
      AND item.end_date >= item.start_date
  ),
  invalid_period_items AS (
    SELECT
      date_trunc('month', item.start_date)::date AS month,
      voucher.id AS voucher_id,
      voucher.building_id,
      voucher.building_name,
      voucher.side,
      type_row.id AS type_id,
      type_row.name AS type_name,
      type_row.category,
      COALESCE(item.amount, item.unit_price * item.quantity)::numeric AS amount
    FROM vouchers voucher
    JOIN public.income_expense_items item
      ON item.income_expense_id = voucher.id
    JOIN public.income_expense_types type_row
      ON type_row.id = item.income_expense_type_id
    WHERE voucher.invoice_month IS NULL
      AND (voucher.override IS TRUE OR item.accounting_class = 'PNL')
      AND item.start_date IS NOT NULL
      AND item.end_date IS NOT NULL
      AND item.end_date < item.start_date
  ),
  no_period_items AS (
    SELECT
      date_trunc('month', voucher.voucher_date)::date AS month,
      voucher.id AS voucher_id,
      voucher.building_id,
      voucher.building_name,
      voucher.side,
      type_row.id AS type_id,
      type_row.name AS type_name,
      type_row.category,
      COALESCE(item.amount, item.unit_price * item.quantity)::numeric AS amount
    FROM vouchers voucher
    JOIN public.income_expense_items item
      ON item.income_expense_id = voucher.id
    JOIN public.income_expense_types type_row
      ON type_row.id = item.income_expense_type_id
    WHERE voucher.invoice_month IS NULL
      AND (voucher.override IS TRUE OR item.accounting_class = 'PNL')
      AND (item.start_date IS NULL OR item.end_date IS NULL)
  ),
  no_item AS (
    SELECT
      date_trunc('month', voucher.voucher_date)::date AS month,
      voucher.id AS voucher_id,
      voucher.building_id,
      voucher.building_name,
      voucher.side,
      NULL::uuid AS type_id,
      U&'Kh\00F4ng c\00F3 h\1EA1ng m\1EE5c'::text AS type_name,
      NULL::text AS category,
      voucher.total_amount::numeric AS amount
    FROM vouchers voucher
    WHERE voucher.invoice_month IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.income_expense_items item
        WHERE item.income_expense_id = voucher.id
      )
  ),
  source_lines AS MATERIALIZED (
    SELECT * FROM invoice_items
    UNION ALL SELECT * FROM invoice_no_item
    UNION ALL SELECT * FROM period_items
    UNION ALL SELECT * FROM invalid_period_items
    UNION ALL SELECT * FROM no_period_items
    UNION ALL SELECT * FROM no_item
  ),
  period_lines AS MATERIALIZED (
    SELECT *
    FROM source_lines
    WHERE month = v_profit.period_month
  ),
  pnl AS MATERIALIZED (
    SELECT
      line.building_id,
      COALESCE(sum(line.amount) FILTER (
        WHERE line.side = 'INCOME'
      ), 0)::numeric AS revenue,
      COALESCE(sum(line.amount) FILTER (
        WHERE line.side = 'EXPENSE'
      ), 0)::numeric AS expense,
      (
        COALESCE(sum(line.amount) FILTER (
          WHERE line.side = 'INCOME'
        ), 0)
        - COALESCE(sum(line.amount) FILTER (
          WHERE line.side = 'EXPENSE'
        ), 0)
      )::numeric AS net
    FROM period_lines line
    GROUP BY line.building_id
  ),
  base AS MATERIALIZED (
    SELECT
      selected.building_id,
      selected.building_name,
      COALESCE(pnl.revenue, 0)::numeric AS source_revenue,
      COALESCE(pnl.expense, 0)::numeric AS source_expense,
      COALESCE(pnl.net, 0)::numeric AS computed_profit
    FROM selected
    LEFT JOIN pnl ON pnl.building_id = selected.building_id
  ),
  share_config AS MATERIALIZED (
    SELECT
      building_shareholder.building_id,
      building_shareholder.shareholder_id,
      shareholder.name AS shareholder_name,
      building_shareholder.percent::numeric AS percent
    FROM public.building_shareholders building_shareholder
    JOIN public.shareholders shareholder
      ON shareholder.id = building_shareholder.shareholder_id
     AND shareholder.organization_id = v_profit.organization_id
     AND shareholder.is_active
     AND shareholder.deleted_at IS NULL
    WHERE building_shareholder.organization_id = v_profit.organization_id
      AND building_shareholder.building_id = ANY(v_building_ids)
  ),
  pnl_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'building_id', base.building_id,
        'building_name', base.building_name,
        'revenue', base.source_revenue,
        'expense', base.source_expense,
        'net', base.computed_profit
      ) ORDER BY base.building_id
    ), '[]'::jsonb) AS value
    FROM base
  ),
  line_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'month', line.month,
        'voucher_id', line.voucher_id,
        'building_id', line.building_id,
        'building_name', line.building_name,
        'side', line.side,
        'type_id', line.type_id,
        'type_name', line.type_name,
        'category', line.category,
        'amount', line.amount
      ) ORDER BY
        line.building_id, line.voucher_id, line.side,
        line.type_id NULLS FIRST, line.amount
    ), '[]'::jsonb) AS value
    FROM period_lines line
  ),
  share_config_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'building_id', config.building_id,
        'shareholder_id', config.shareholder_id,
        'shareholder_name', config.shareholder_name,
        'percent', config.percent
      ) ORDER BY config.building_id, config.shareholder_id
    ), '[]'::jsonb) AS value
    FROM share_config config
  ),
  manager_rules_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'rule_id', salary.id,
        'manager_id', salary.manager_id,
        'manager_name', manager.name,
        'label', salary.label,
        'form', salary.form,
        'basis', salary.basis,
        'amount', salary.amount,
        'percent', salary.percent,
        'building_ids', COALESCE((
          SELECT jsonb_agg(
            salary_building.building_id
            ORDER BY salary_building.building_id
          )
          FROM public.profit_manager_salary_buildings salary_building
          WHERE salary_building.salary_id = salary.id
            AND salary_building.organization_id = v_profit.organization_id
            AND salary_building.building_id = ANY(v_building_ids)
        ), '[]'::jsonb)
      ) ORDER BY salary.id
    ), '[]'::jsonb) AS value
    FROM public.profit_manager_salaries salary
    JOIN public.profit_managers manager
      ON manager.id = salary.manager_id
     AND manager.organization_id = v_profit.organization_id
     AND manager.is_active
     AND manager.deleted_at IS NULL
    WHERE salary.organization_id = v_profit.organization_id
      AND salary.is_active
      AND EXISTS (
        SELECT 1
        FROM public.profit_manager_salary_buildings salary_building
        WHERE salary_building.salary_id = salary.id
          AND salary_building.organization_id = v_profit.organization_id
          AND salary_building.building_id = ANY(v_building_ids)
      )
  ),
  source_document AS MATERIALIZED (
    SELECT jsonb_build_object(
      'algorithm_version', 'profit-close-v2.1',
      'organization_id', v_profit.organization_id,
      'period_month', v_profit.period_month,
      'pnl', pnl_document.value,
      'accrual_lines', line_document.value,
      'shareholder_config', share_config_document.value,
      'manager_salary_rules', manager_rules_document.value
    ) AS value
    FROM pnl_document
    CROSS JOIN line_document
    CROSS JOIN share_config_document
    CROSS JOIN manager_rules_document
  )
  -- 20261022172459: băm bằng hàm chiếu v2.2 dùng chung với preview (chỉ số tiền + id,
  -- chỉ kéo toà cùng quy tắc lương tổng nhóm). Tài liệu nguồn dựng y như v1.
  SELECT app_private.profit_building_source_hash_v2_2(
           source_document.value, v_profit.building_id
         )
    INTO v_hash
  FROM source_document;

  RETURN v_hash;
END
$function$;

-- 4. Kiểm độ tươi: so theo ĐÚNG phiên bản dấu lúc chốt. Chữ ký, kiểu trả về, LANGUAGE sql,
--    STABLE, SECURITY DEFINER, search_path giữ nguyên (CREATE OR REPLACE giữ ACL). Dòng
--    'v2.1' đi nguyên đường cũ: profit.source_hash = current_profit_building_source_hash_v1.
CREATE OR REPLACE FUNCTION app_private.profit_monthly_source_is_current_v1(p_profit_monthly_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
  SELECT COALESCE((
    SELECT profit.status = 'LOCKED'
       AND NOT profit.is_stale
       AND profit.source_hash = CASE
         WHEN app_private.profit_building_source_hash_algorithm_v1(profit.id)
              = 'profit-close-v2.2'
           THEN app_private.current_profit_building_source_hash_v2(profit.id)
         ELSE app_private.current_profit_building_source_hash_v1(profit.id)
       END
    FROM public.profit_monthly profit
    WHERE profit.id = p_profit_monthly_id
  ), false);
$function$;

-- 5. Preview core: thân production (ff014d6c…), các chỗ đổi đánh dấu "20261022172459".
--    Chữ ký, LANGUAGE, VOLATILE, SECURITY DEFINER, search_path giữ nguyên.
CREATE OR REPLACE FUNCTION public._profit_close_preview_core_v2(p_organization_id uuid, p_period_month date, p_building_ids uuid[], p_adjustments jsonb, p_permission_key text, p_lock_sources boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_period_end date;
  v_captured_at timestamptz := clock_timestamp();
  v_result jsonb;
  v_source_consistent boolean;
  v_adj record;
BEGIN
  IF p_period_month IS NULL
     OR p_period_month <> date_trunc('month', p_period_month)::date THEN
    RAISE EXCEPTION 'period_month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;
  v_period_end := (p_period_month + interval '1 month - 1 day')::date;

  PERFORM public._profit_assert_authorized_v2(
    p_organization_id, p_permission_key
  );

  IF p_building_ids IS NULL OR cardinality(p_building_ids) = 0 THEN
    RAISE EXCEPTION 'At least one building is required' USING ERRCODE = '22023';
  END IF;
  IF array_position(p_building_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'building_ids cannot contain NULL' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM unnest(p_building_ids) x)
     <> (SELECT count(DISTINCT x) FROM unnest(p_building_ids) x) THEN
    RAISE EXCEPTION 'building_ids contains duplicates' USING ERRCODE = '22023';
  END IF;

  -- Keep the child-before-parent order introduced by the deadlock fix while
  -- restoring the earlier Profit Close V2 calculation contract.
  IF p_lock_sources THEN
    LOCK TABLE public.income_expense_items,
               public.income_expenses,
               public.income_expense_types,
               public.invoices,
               public.building_shareholders,
               public.shareholders,
               public.profit_managers,
               public.profit_manager_salaries,
               public.profit_manager_salary_buildings,
               public.staff_assignments,
               public.roles,
               public.area_buildings,
               public.super_admins
      IN SHARE MODE;
  END IF;

  PERFORM 1
  FROM public.buildings b
  WHERE b.id = ANY(p_building_ids)
    AND b.organization_id = p_organization_id
    AND b.deleted_at IS NULL
    AND b.is_virtual = false
  FOR SHARE;
  IF (SELECT count(*)
      FROM public.buildings b
      WHERE b.id = ANY(p_building_ids)
        AND b.organization_id = p_organization_id
        AND b.deleted_at IS NULL
        AND b.is_virtual = false)
     <> cardinality(p_building_ids) THEN
    RAISE EXCEPTION 'Every building must be an active real building in the organization'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_super_admin() AND EXISTS (
    SELECT 1
    FROM unnest(p_building_ids) bid
    WHERE NOT public.authorize_v2(
      p_permission_key, p_organization_id, 'BUILDING', bid
    )
  ) THEN
    RAISE EXCEPTION 'Permission does not cover every requested building'
      USING ERRCODE = '42501';
  END IF;

  -- fa_* is the canonical implementation but applies legacy building scope
  -- internally. Fail explicitly instead of silently treating hidden data as 0.
  IF EXISTS (
    SELECT 1
    FROM unnest(p_building_ids) bid
    WHERE NOT COALESCE(public.can_access_building(bid), false)
  ) THEN
    RAISE EXCEPTION
      'Canonical accrual scope denied one or more buildings; no legacy fallback is allowed'
      USING ERRCODE = '42501';
  END IF;

  p_adjustments := COALESCE(p_adjustments, '[]'::jsonb);
  IF jsonb_typeof(p_adjustments) <> 'array' THEN
    RAISE EXCEPTION 'adjustments must be a JSON array' USING ERRCODE = '22023';
  END IF;

  IF (SELECT count(*)
      FROM jsonb_to_recordset(p_adjustments)
        AS a(building_id uuid, adjustment_amount numeric, adjustment_reason text))
     <> (SELECT count(DISTINCT a.building_id)
         FROM jsonb_to_recordset(p_adjustments)
           AS a(building_id uuid, adjustment_amount numeric, adjustment_reason text)) THEN
    RAISE EXCEPTION 'adjustments contains duplicate building_id values'
      USING ERRCODE = '22023';
  END IF;

  FOR v_adj IN
    SELECT *
    FROM jsonb_to_recordset(p_adjustments)
      AS a(building_id uuid, adjustment_amount numeric, adjustment_reason text)
  LOOP
    IF v_adj.building_id IS NULL
       OR NOT (v_adj.building_id = ANY(p_building_ids)) THEN
      RAISE EXCEPTION 'Every adjustment must target a requested building'
        USING ERRCODE = '22023';
    END IF;
    IF v_adj.adjustment_amount IS NULL
       OR v_adj.adjustment_amount::text = 'NaN'
       OR round(v_adj.adjustment_amount, 2) <> v_adj.adjustment_amount
       OR abs(v_adj.adjustment_amount) > 9999999999999.99 THEN
      RAISE EXCEPTION 'adjustment_amount must be a finite numeric with at most 2 decimals'
        USING ERRCODE = '22023';
    END IF;
    IF p_lock_sources AND v_adj.adjustment_amount <> 0
       AND (
         v_adj.adjustment_reason IS NULL
         OR char_length(btrim(v_adj.adjustment_reason)) NOT BETWEEN 8 AND 500
       ) THEN
      RAISE EXCEPTION 'A non-zero adjustment requires a reason of 8..500 characters'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- Legacy mappings to inactive/soft-deleted shareholders are ignored, matching
  -- the established frontend behavior. Missing IDs and cross-org links remain
  -- structural corruption and fail closed.
  IF EXISTS (
    SELECT 1
    FROM public.building_shareholders bs
    LEFT JOIN public.shareholders sh ON sh.id = bs.shareholder_id
    WHERE bs.building_id = ANY(p_building_ids)
      AND (
        bs.organization_id IS DISTINCT FROM p_organization_id
        OR sh.id IS NULL
        OR sh.organization_id IS DISTINCT FROM p_organization_id
      )
  ) THEN
    RAISE EXCEPTION 'Shareholder configuration contains missing or cross-organization rows'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.building_shareholders bs
    JOIN public.shareholders sh
      ON sh.id = bs.shareholder_id
     AND sh.organization_id = p_organization_id
     AND sh.is_active
     AND sh.deleted_at IS NULL
    WHERE bs.building_id = ANY(p_building_ids)
      AND bs.organization_id = p_organization_id
    GROUP BY bs.building_id
    HAVING sum(bs.percent) > 100
  ) THEN
    RAISE EXCEPTION 'Shareholder percentages exceed 100 for a building'
      USING ERRCODE = '23514';
  END IF;

  -- Active rules that reference no manager are structurally corrupt. Rules for
  -- an existing inactive/soft-deleted manager are legacy history and ignored,
  -- including their legacy NULL organization_id fields. A live manager's active
  -- rule and mapping must all be explicitly scoped to this organization.
  IF EXISTS (
    SELECT 1
    FROM public.profit_manager_salary_buildings rb
    JOIN public.profit_manager_salaries s ON s.id = rb.salary_id
    LEFT JOIN public.profit_managers m ON m.id = s.manager_id
    WHERE rb.building_id = ANY(p_building_ids)
      AND s.is_active
      AND (
        m.id IS NULL
        OR (
          m.is_active
          AND m.deleted_at IS NULL
          AND (
            rb.organization_id IS DISTINCT FROM p_organization_id
            OR s.organization_id IS DISTINCT FROM p_organization_id
            OR m.organization_id IS DISTINCT FROM p_organization_id
          )
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Management salary configuration contains a missing manager or live cross/null-organization rows'
      USING ERRCODE = '55000';
  END IF;

  WITH selected AS MATERIALIZED (
    SELECT b.id AS building_id, b.name AS building_name, b.user_id AS owner_user_id
    FROM public.buildings b
    WHERE b.id = ANY(p_building_ids)
      AND b.organization_id = p_organization_id
      AND b.deleted_at IS NULL
      AND b.is_virtual = false
  ),
  adjustments AS MATERIALIZED (
    SELECT
      a.building_id,
      a.adjustment_amount::numeric AS adjustment_amount,
      CASE WHEN a.adjustment_amount <> 0 THEN btrim(a.adjustment_reason) END
        AS adjustment_reason
    FROM jsonb_to_recordset(p_adjustments)
      AS a(building_id uuid, adjustment_amount numeric, adjustment_reason text)
  ),
  pnl AS MATERIALIZED (
    SELECT
      x.building_id,
      sum(x.revenue)::numeric AS revenue,
      sum(x.expense)::numeric AS expense,
      sum(x.net)::numeric AS net
    FROM public.fa_monthly_pnl_accrual(
      p_period_month, v_period_end, p_building_ids
    ) x
    WHERE x.month = p_period_month AND x.is_virtual = false
    GROUP BY x.building_id
  ),
  source_lines AS MATERIALIZED (
    SELECT
      x.month,
      x.voucher_id,
      x.building_id,
      x.building_name,
      x.side,
      x.type_id,
      x.type_name,
      x.category,
      x.amount::numeric AS amount
    FROM public.fa_accrual_allocations(
      p_period_month, v_period_end, p_building_ids
    ) x
    WHERE x.month = p_period_month AND x.is_virtual = false
  ),
  line_totals AS (
    SELECT
      building_id,
      COALESCE(sum(amount) FILTER (WHERE side = 'INCOME'), 0)::numeric AS revenue,
      COALESCE(sum(amount) FILTER (WHERE side = 'EXPENSE'), 0)::numeric AS expense,
      (
        COALESCE(sum(amount) FILTER (WHERE side = 'INCOME'), 0)
        - COALESCE(sum(amount) FILTER (WHERE side = 'EXPENSE'), 0)
      )::numeric AS net
    FROM source_lines
    GROUP BY building_id
  ),
  base AS MATERIALIZED (
    SELECT
      s.building_id,
      s.building_name,
      s.owner_user_id,
      COALESCE(p.revenue, 0)::numeric AS source_revenue,
      COALESCE(p.expense, 0)::numeric AS source_expense,
      COALESCE(p.net, 0)::numeric AS computed_profit,
      COALESCE(a.adjustment_amount, 0)::numeric AS adjustment_amount,
      a.adjustment_reason,
      (COALESCE(p.net, 0) + COALESCE(a.adjustment_amount, 0))::numeric
        AS adjusted_profit
    FROM selected s
    LEFT JOIN pnl p ON p.building_id = s.building_id
    LEFT JOIN adjustments a ON a.building_id = s.building_id
  ),
  management_doc AS MATERIALIZED (
    SELECT public._profit_management_allocations_v2(
      p_organization_id,
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object('building_id', building_id, 'base', adjusted_profit)
          ORDER BY building_id
        ) FROM base
      ), '[]'::jsonb)
    ) AS allocations
  ),
  manager_allocations AS MATERIALIZED (
    SELECT x.manager_id, x.building_id, x.amount::numeric AS amount
    FROM management_doc d
    CROSS JOIN LATERAL jsonb_to_recordset(d.allocations)
      AS x(manager_id uuid, building_id uuid, amount numeric)
  ),
  manager_totals AS (
    SELECT building_id, sum(amount)::numeric AS management_salary
    FROM manager_allocations
    GROUP BY building_id
  ),
  with_salary AS MATERIALIZED (
    SELECT
      b.*,
      COALESCE(mt.management_salary, 0)::numeric AS management_salary,
      (b.adjusted_profit - COALESCE(mt.management_salary, 0))::numeric
        AS distributable_profit
    FROM base b
    LEFT JOIN manager_totals mt ON mt.building_id = b.building_id
  ),
  share_config AS MATERIALIZED (
    SELECT
      bs.building_id,
      bs.shareholder_id,
      sh.name AS shareholder_name,
      bs.percent::numeric AS percent
    FROM public.building_shareholders bs
    JOIN public.shareholders sh
      ON sh.id = bs.shareholder_id
     AND sh.organization_id = p_organization_id
     AND sh.is_active
     AND sh.deleted_at IS NULL
    WHERE bs.organization_id = p_organization_id
      AND bs.building_id = ANY(p_building_ids)
  ),
  share_raw AS (
    SELECT
      ws.building_id,
      sc.shareholder_id,
      sc.shareholder_name,
      sc.percent,
      ws.distributable_profit,
      sum(sc.percent) OVER (PARTITION BY ws.building_id) AS total_percent,
      (ws.distributable_profit * sc.percent / 100)::numeric AS raw_amount,
      round(
        ws.distributable_profit
        * sum(sc.percent) OVER (PARTITION BY ws.building_id)
        / 100
      )::numeric AS target_total
    FROM with_salary ws
    JOIN share_config sc ON sc.building_id = ws.building_id
  ),
  share_based AS (
    SELECT
      sr.*,
      CASE
        WHEN sr.target_total >= 0 THEN floor(sr.raw_amount)
        ELSE ceil(sr.raw_amount)
      END::numeric AS base_part
    FROM share_raw sr
  ),
  share_ranked AS (
    SELECT
      sb.*,
      (
        sb.target_total
        - sum(sb.base_part) OVER (PARTITION BY sb.building_id)
      )::numeric AS delta,
      row_number() OVER (
        PARTITION BY sb.building_id
        ORDER BY
          CASE
            WHEN sb.target_total >= 0 THEN sb.raw_amount - floor(sb.raw_amount)
            ELSE ceil(sb.raw_amount) - sb.raw_amount
          END DESC,
          sb.shareholder_id
      ) AS allocation_rank
    FROM share_based sb
  ),
  shareholder_allocations AS MATERIALIZED (
    SELECT
      building_id,
      shareholder_id,
      shareholder_name,
      percent,
      (
        base_part
        + CASE
            WHEN delta > 0 AND allocation_rank <= delta THEN 1
            WHEN delta < 0 AND allocation_rank <= abs(delta) THEN -1
            ELSE 0
          END
      )::numeric AS amount
    FROM share_ranked
  ),
  shareholder_json AS (
    SELECT
      building_id,
      jsonb_agg(
        jsonb_build_object(
          'shareholder_id', shareholder_id,
          'shareholder_name', shareholder_name,
          'percent', percent,
          'amount', amount
        ) ORDER BY shareholder_id
      ) AS allocations,
      sum(percent)::numeric AS total_percent,
      sum(amount)::numeric AS allocated_amount
    FROM shareholder_allocations
    GROUP BY building_id
  ),
  manager_json AS (
    SELECT
      ma.building_id,
      jsonb_agg(
        jsonb_build_object(
          'manager_id', ma.manager_id,
          'manager_name', m.name,
          'amount', ma.amount
        ) ORDER BY ma.manager_id
      ) AS allocations
    FROM manager_allocations ma
    JOIN public.profit_managers m ON m.id = ma.manager_id
    GROUP BY ma.building_id
  ),
  pnl_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'building_id', building_id,
        'building_name', building_name,
        'revenue', source_revenue,
        'expense', source_expense,
        'net', computed_profit
      ) ORDER BY building_id
    ), '[]'::jsonb) AS value
    FROM base
  ),
  line_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'month', month,
        'voucher_id', voucher_id,
        'building_id', building_id,
        'building_name', building_name,
        'side', side,
        'type_id', type_id,
        'type_name', type_name,
        'category', category,
        'amount', amount
      ) ORDER BY building_id, voucher_id, side, type_id NULLS FIRST, amount
    ), '[]'::jsonb) AS value
    FROM source_lines
  ),
  share_config_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'building_id', building_id,
        'shareholder_id', shareholder_id,
        'shareholder_name', shareholder_name,
        'percent', percent
      ) ORDER BY building_id, shareholder_id
    ), '[]'::jsonb) AS value
    FROM share_config
  ),
  manager_rules_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'rule_id', s.id,
        'manager_id', s.manager_id,
        'manager_name', m.name,
        'label', s.label,
        'form', s.form,
        'basis', s.basis,
        'amount', s.amount,
        'percent', s.percent,
        'building_ids', COALESCE((
          SELECT jsonb_agg(rb.building_id ORDER BY rb.building_id)
          FROM public.profit_manager_salary_buildings rb
          WHERE rb.salary_id = s.id
            AND rb.organization_id = p_organization_id
            AND rb.building_id = ANY(p_building_ids)
        ), '[]'::jsonb)
      ) ORDER BY s.id
    ), '[]'::jsonb) AS value
    FROM public.profit_manager_salaries s
    JOIN public.profit_managers m
      ON m.id = s.manager_id
     AND m.organization_id = p_organization_id
     AND m.is_active
     AND m.deleted_at IS NULL
    WHERE s.organization_id = p_organization_id
      AND s.is_active
      AND EXISTS (
        SELECT 1
        FROM public.profit_manager_salary_buildings rb
        WHERE rb.salary_id = s.id
          AND rb.organization_id = p_organization_id
          AND rb.building_id = ANY(p_building_ids)
      )
  ),
  source_document AS MATERIALIZED (
    SELECT jsonb_build_object(
      'algorithm_version', 'profit-close-v2.1',
      'organization_id', p_organization_id,
      'period_month', p_period_month,
      'pnl', p.value,
      'accrual_lines', l.value,
      'shareholder_config', sc.value,
      'manager_salary_rules', mr.value
    ) AS value
    FROM pnl_document p
    CROSS JOIN line_document l
    CROSS JOIN share_config_document sc
    CROSS JOIN manager_rules_document mr
  ),
  source_meta AS (
    SELECT value, md5(value::text) AS source_hash
    FROM source_document
  ),
  building_rows AS MATERIALIZED (
    SELECT
      ws.building_id,
      ws.building_name,
      ws.owner_user_id,
      bh.building_source_hash,
      ws.source_revenue,
      ws.source_expense,
      ws.computed_profit,
      ws.adjustment_amount,
      ws.adjustment_reason,
      ws.adjusted_profit,
      ws.management_salary,
      ws.distributable_profit,
      COALESCE(sj.total_percent, 0)::numeric AS shareholder_percent_total,
      COALESCE(sj.allocated_amount, 0)::numeric AS shareholder_allocated_amount,
      (ws.distributable_profit - COALESCE(sj.allocated_amount, 0))::numeric
        AS unallocated_profit,
      COALESCE(sj.allocations, '[]'::jsonb) AS shareholder_allocations,
      COALESCE(mj.allocations, '[]'::jsonb) AS manager_allocations,
      pm.status AS current_status,
      pm.revision_number AS current_revision_number,
      pm.source_hash AS current_source_hash,
      (pm.id IS NOT NULL AND pm.source_hash IS DISTINCT FROM cmp.expected_current_hash)
        AS current_hash_mismatch,
      (
        COALESCE(pm.is_stale, false)
        OR (pm.id IS NOT NULL AND pm.source_hash IS DISTINCT FROM cmp.expected_current_hash)
      ) AS current_is_stale,
      CASE
        WHEN pm.id IS NOT NULL AND pm.source_hash IS DISTINCT FROM cmp.expected_current_hash
          THEN 'SOURCE_HASH_MISMATCH'
        ELSE pm.stale_reason
      END AS current_stale_reason,
      CASE WHEN pm.id IS NOT NULL THEN to_jsonb(pm) END AS current_snapshot
    FROM with_salary ws
    LEFT JOIN shareholder_json sj ON sj.building_id = ws.building_id
    LEFT JOIN manager_json mj ON mj.building_id = ws.building_id
    CROSS JOIN source_meta sm
    -- 20261022172459: building_source_hash (writer ghi cho lần chốt mới) = dấu v2.2 từ hàm
    -- chiếu dùng chung; dấu v2.1 giữ nguyên từng chữ, chỉ để so dòng đã chốt bằng v2.1.
    CROSS JOIN LATERAL (
      SELECT md5(jsonb_build_object(
        'algorithm_version', 'profit-close-v2.1',
        'organization_id', p_organization_id,
        'period_month', p_period_month,
        'building_id', ws.building_id,
        -- TOTAL_GROUP salary rules depend on every building in the close set;
        -- include the complete source-base vector, not only this row.
        'source_building_bases', sm.value->'pnl',
        'pnl', jsonb_build_object(
          'revenue', ws.source_revenue,
          'expense', ws.source_expense,
          'net', ws.computed_profit
        ),
        'accrual_lines', COALESCE((
          SELECT jsonb_agg(
            x.value ORDER BY
              x.value->>'voucher_id', x.value->>'side',
              x.value->>'type_id', x.value->>'amount'
          )
          FROM jsonb_array_elements(sm.value->'accrual_lines') x(value)
          WHERE x.value->>'building_id' = ws.building_id::text
        ), '[]'::jsonb),
        'shareholder_config', COALESCE((
          SELECT jsonb_agg(x.value ORDER BY x.value->>'shareholder_id')
          FROM jsonb_array_elements(sm.value->'shareholder_config') x(value)
          WHERE x.value->>'building_id' = ws.building_id::text
        ), '[]'::jsonb),
        'manager_salary_rules', COALESCE((
          SELECT jsonb_agg(x.value ORDER BY x.value->>'rule_id')
          FROM jsonb_array_elements(sm.value->'manager_salary_rules') x(value)
          WHERE x.value->'building_ids' @> to_jsonb(ARRAY[ws.building_id])
        ), '[]'::jsonb)
      )::text) AS legacy_building_source_hash,
      app_private.profit_building_source_hash_v2_2(sm.value, ws.building_id)
        AS building_source_hash
    ) bh
    LEFT JOIN public.profit_monthly pm
      ON pm.organization_id = p_organization_id
     AND pm.building_id = ws.building_id
     AND pm.period_month = p_period_month
    -- 20261022172459: so dòng đã chốt theo ĐÚNG phiên bản dấu lúc chốt.
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN pm.id IS NOT NULL
         AND app_private.profit_building_source_hash_algorithm_v1(pm.id)
             = 'profit-close-v2.2'
          THEN bh.building_source_hash
        ELSE bh.legacy_building_source_hash
      END AS expected_current_hash
    ) cmp
  ),
  rows_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'building_id', building_id,
        'building_name', building_name,
        'building_source_hash', building_source_hash,
        'source_revenue', source_revenue,
        'source_expense', source_expense,
        'computed_profit', computed_profit,
        'adjustment_amount', adjustment_amount,
        'adjustment_reason', adjustment_reason,
        'adjusted_profit', adjusted_profit,
        'management_salary', management_salary,
        'distributable_profit', distributable_profit,
        'shareholder_percent_total', shareholder_percent_total,
        'shareholder_allocated_amount', shareholder_allocated_amount,
        'unallocated_profit', unallocated_profit,
        'shareholder_allocations', shareholder_allocations,
        'manager_allocations', manager_allocations,
        'current_status', current_status,
        'current_revision_number', current_revision_number,
        'current_source_hash', current_source_hash,
        'current_hash_mismatch', current_hash_mismatch,
        'current_is_stale', current_is_stale,
        'current_stale_reason', current_stale_reason,
        'current_snapshot', current_snapshot
      ) ORDER BY building_id
    ), '[]'::jsonb) AS value
    FROM building_rows
  ),
  totals_document AS (
    SELECT jsonb_build_object(
      'source_revenue', COALESCE(sum(source_revenue), 0),
      'source_expense', COALESCE(sum(source_expense), 0),
      'computed_profit', COALESCE(sum(computed_profit), 0),
      'adjustment_amount', COALESCE(sum(adjustment_amount), 0),
      'adjusted_profit', COALESCE(sum(adjusted_profit), 0),
      'management_salary', COALESCE(sum(management_salary), 0),
      'distributable_profit', COALESCE(sum(distributable_profit), 0),
      'shareholder_allocated_amount', COALESCE(sum(shareholder_allocated_amount), 0),
      'unallocated_profit', COALESCE(sum(unallocated_profit), 0)
    ) AS value
    FROM building_rows
  ),
  consistency AS (
    SELECT NOT EXISTS (
      SELECT 1
      FROM base b
      LEFT JOIN line_totals lt ON lt.building_id = b.building_id
      WHERE b.source_revenue <> COALESCE(lt.revenue, 0)
         OR b.source_expense <> COALESCE(lt.expense, 0)
         OR b.computed_profit <> COALESCE(lt.net, 0)
    ) AS ok
  )
  SELECT
    jsonb_build_object(
      -- 20261022172459: phiên bản dấu từng toà; writer chép vào revision.source_snapshot.
      -- Tài liệu nguồn (source_snapshot, source_hash, CAS) vẫn 'profit-close-v2.1'.
      'algorithm_version', 'profit-close-v2.2',
      'organization_id', p_organization_id,
      'period_month', p_period_month,
      'source_hash', sm.source_hash,
      'source_captured_at', v_captured_at,
      'source_snapshot', sm.value,
      'buildings', rd.value,
      'totals', td.value
    ),
    c.ok
  INTO v_result, v_source_consistent
  FROM source_meta sm
  CROSS JOIN rows_document rd
  CROSS JOIN totals_document td
  CROSS JOIN consistency c;

  IF NOT COALESCE(v_source_consistent, false) THEN
    RAISE EXCEPTION
      'Canonical fa_monthly_pnl_accrual and fa_accrual_allocations totals disagree'
      USING ERRCODE = '55000';
  END IF;

  RETURN v_result;
END
$function$;

-- 6. ACL: CREATE OR REPLACE giữ ACL của hàm đã có (production 22/10: dispatcher và
--    current_profit_building_source_hash_v1 chỉ chủ hàm; preview core chủ hàm + service_role).
--    Khẳng định lại vế đóng (no-op trên production) — bản dựng lại (Restore Drill) có default
--    privileges rộng; hàm mới chỉ cho chủ hàm. v1 chỉ được nêu ACL, thân không đổi.
REVOKE ALL ON FUNCTION app_private.current_profit_building_source_hash_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_building_source_hash_v2_2(jsonb, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_building_source_hash_algorithm_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.current_profit_building_source_hash_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_monthly_source_is_current_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._profit_close_preview_core_v2(
  uuid, date, uuid[], jsonb, text, boolean
) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION app_private.profit_building_source_hash_v2_2(jsonb, uuid) IS
  'Dau van tay chot LN profit-close-v2.2 cua MOT toa: chi so tien + id (khong ten), chi keo so cua toa cung quy tac luong tong nhom. Preview va kiem do tuoi cung goi.';
COMMENT ON FUNCTION app_private.profit_building_source_hash_algorithm_v1(uuid) IS
  'Phien ban thuat toan cua profit_monthly.source_hash, doc tu revision BASELINE/CLOSE/RECLOSE moi nhat cua dong: profit-close-v2.2 hoac (mac dinh) profit-close-v2.1.';
COMMENT ON FUNCTION app_private.current_profit_building_source_hash_v2(uuid) IS
  'Dung lai dau van tay profit-close-v2.2 tu du lieu hien tai (than v1 + ham chieu v2.2). Chi cho dong chot bang v2.2.';

-- 7. Tự kiểm (catalog + hàm chiếu trên tài liệu giả — chạy được trên database rỗng).
DO $sau$
DECLARE
  v_fn record;
  v_a text := '00000000-0000-4000-8000-00000000000a';
  v_b text := '00000000-0000-4000-8000-00000000000b';
  v_c text := '00000000-0000-4000-8000-00000000000c';
  v_doc jsonb;
  v_base text;
BEGIN
  FOR v_fn IN
    SELECT *
    FROM (VALUES
      ('app_private.profit_building_source_hash_v2_2(jsonb,uuid)', false, 's',
       'search_path=pg_catalog', 'text'),
      ('app_private.profit_building_source_hash_algorithm_v1(uuid)', true, 's',
       'search_path=pg_catalog, public, app_private', 'text'),
      ('app_private.current_profit_building_source_hash_v2(uuid)', true, 's',
       'search_path=pg_catalog, public, app_private', 'text'),
      ('app_private.current_profit_building_source_hash_v1(uuid)', true, 's',
       'search_path=pg_catalog, public, app_private', 'text'),
      ('app_private.profit_monthly_source_is_current_v1(uuid)', true, 's',
       'search_path=pg_catalog, public, app_private', 'boolean'),
      ('public._profit_close_preview_core_v2(uuid,date,uuid[],jsonb,text,boolean)', true, 'v',
       'search_path=pg_catalog, public', 'jsonb')
    ) expected(signature, definer, volatility, config, result)
  LOOP
    IF to_regprocedure(v_fn.signature) IS NULL OR NOT EXISTS (
      SELECT 1
      FROM pg_proc p
      WHERE p.oid = to_regprocedure(v_fn.signature)
        AND p.prosecdef = v_fn.definer
        AND p.provolatile = v_fn.volatility
        AND replace(array_to_string(p.proconfig, ','), '"', '') = v_fn.config
        AND pg_get_function_result(p.oid) = v_fn.result
    ) THEN
      RAISE EXCEPTION '% sai thuộc tính (DEFINER/volatility/search_path/kiểu trả về)', v_fn.signature
        USING ERRCODE = '55000';
    END IF;
    IF has_function_privilege('anon', to_regprocedure(v_fn.signature), 'EXECUTE')
       OR has_function_privilege('authenticated', to_regprocedure(v_fn.signature), 'EXECUTE') THEN
      RAISE EXCEPTION 'ACL % bị nới cho anon/authenticated', v_fn.signature
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE (n.nspname, p.proname) IN (
         ('app_private', 'profit_building_source_hash_v2_2'),
         ('app_private', 'profit_building_source_hash_algorithm_v1'),
         ('app_private', 'current_profit_building_source_hash_v2'),
         ('app_private', 'profit_monthly_source_is_current_v1'),
         ('public', '_profit_close_preview_core_v2')
       )) <> 5 THEN
    RAISE EXCEPTION 'Sai số overload của hàm dấu vân tay chốt LN' USING ERRCODE = '55000';
  END IF;

  IF position('app_private.profit_building_source_hash_v2_2(sm.value, ws.building_id)' IN
       pg_get_functiondef('public._profit_close_preview_core_v2(uuid,date,uuid[],jsonb,text,boolean)'::regprocedure)) = 0
     OR position('''algorithm_version'', ''profit-close-v2.2''' IN
       pg_get_functiondef('public._profit_close_preview_core_v2(uuid,date,uuid[],jsonb,text,boolean)'::regprocedure)) = 0
     OR position('app_private.current_profit_building_source_hash_v1(profit.id)' IN
       pg_get_functiondef('app_private.profit_monthly_source_is_current_v1(uuid)'::regprocedure)) = 0
     OR position('app_private.current_profit_building_source_hash_v2(profit.id)' IN
       pg_get_functiondef('app_private.profit_monthly_source_is_current_v1(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Preview / kiểm độ tươi chưa mang dấu v2.2 theo phiên bản' USING ERRCODE = '55000';
  END IF;

  -- Hàm chiếu trên tài liệu giả: A và C chung quy tắc TOTAL_GROUP, B chung quy tắc
  -- PER_BUILDING với A. Đổi tên ⇒ không đổi; đổi tiền của A / của C ⇒ đổi; đổi tiền B ⇒
  -- không đổi; 100.00 và 100 là một.
  v_doc := jsonb_build_object(
    'algorithm_version', 'profit-close-v2.1',
    'organization_id', '00000000-0000-4000-8000-000000000001',
    'period_month', '2026-07-01',
    'pnl', jsonb_build_array(
      jsonb_build_object('building_id', v_a, 'building_name', 'Toa A',
        'revenue', 100.00, 'expense', 40, 'net', 60.00),
      jsonb_build_object('building_id', v_b, 'building_name', 'Toa B',
        'revenue', 50, 'expense', 10, 'net', 40),
      jsonb_build_object('building_id', v_c, 'building_name', 'Toa C',
        'revenue', 70, 'expense', 0, 'net', 70)
    ),
    'accrual_lines', jsonb_build_array(
      jsonb_build_object('month', '2026-07-01', 'voucher_id', '00000000-0000-4000-8000-0000000000f1',
        'building_id', v_a, 'building_name', 'Toa A', 'side', 'INCOME',
        'type_id', '00000000-0000-4000-8000-0000000000e1', 'type_name', 'Thu A',
        'category', 'Nhom 1', 'amount', 100.00),
      jsonb_build_object('month', '2026-07-01', 'voucher_id', '00000000-0000-4000-8000-0000000000f2',
        'building_id', v_a, 'building_name', 'Toa A', 'side', 'EXPENSE',
        'type_id', NULL, 'type_name', 'Khong co', 'category', NULL, 'amount', 40),
      jsonb_build_object('month', '2026-07-01', 'voucher_id', '00000000-0000-4000-8000-0000000000f3',
        'building_id', v_b, 'building_name', 'Toa B', 'side', 'INCOME',
        'type_id', '00000000-0000-4000-8000-0000000000e1', 'type_name', 'Thu A',
        'category', 'Nhom 1', 'amount', 50)
    ),
    'shareholder_config', jsonb_build_array(
      jsonb_build_object('building_id', v_a, 'shareholder_id', '00000000-0000-4000-8000-0000000000d1',
        'shareholder_name', 'Co dong 1', 'percent', 60.00),
      jsonb_build_object('building_id', v_b, 'shareholder_id', '00000000-0000-4000-8000-0000000000d1',
        'shareholder_name', 'Co dong 1', 'percent', 100)
    ),
    'manager_salary_rules', jsonb_build_array(
      jsonb_build_object('rule_id', '00000000-0000-4000-8000-0000000000c1',
        'manager_id', '00000000-0000-4000-8000-0000000000b1', 'manager_name', 'Quan ly',
        'label', 'Nhom AC', 'form', 'FIXED', 'basis', 'TOTAL_GROUP', 'amount', 10, 'percent', NULL,
        'building_ids', jsonb_build_array(v_a, v_c)),
      jsonb_build_object('rule_id', '00000000-0000-4000-8000-0000000000c2',
        'manager_id', '00000000-0000-4000-8000-0000000000b1', 'manager_name', 'Quan ly',
        'label', 'Tung toa', 'form', 'PERCENT', 'basis', 'PER_BUILDING', 'amount', NULL,
        'percent', 5, 'building_ids', jsonb_build_array(v_a, v_b))
    )
  );
  v_base := app_private.profit_building_source_hash_v2_2(v_doc, v_a::uuid);
  IF v_base IS NULL OR v_base !~ '^[0-9a-f]{32}$'
     -- đổi tên toà / hạng mục / nhóm / cổ đông / quản lý / nhãn ⇒ KHÔNG đổi
     OR app_private.profit_building_source_hash_v2_2(
          jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_doc,
            '{pnl,0,building_name}', '"Ten moi"'),
            '{pnl,2,building_name}', '"Ten moi C"'),
            '{accrual_lines,0,type_name}', '"Hang muc moi"'),
            '{accrual_lines,0,category}', '"Nhom moi"'),
            '{shareholder_config,0,shareholder_name}', '"Ten co dong moi"'),
            '{manager_salary_rules,0,label}', '"Nhan moi"'),
          v_a::uuid) IS DISTINCT FROM v_base
     OR app_private.profit_building_source_hash_v2_2(
          jsonb_set(v_doc, '{manager_salary_rules,0,manager_name}', '"Ten quan ly moi"'),
          v_a::uuid) IS DISTINCT FROM v_base
     -- 100 và 100.00 là một số tiền
     OR app_private.profit_building_source_hash_v2_2(
          jsonb_set(v_doc, '{accrual_lines,0,amount}', '100'), v_a::uuid) IS DISTINCT FROM v_base
     -- toà B chỉ chung quy tắc PER_BUILDING ⇒ số của B không ảnh hưởng A
     OR app_private.profit_building_source_hash_v2_2(
          jsonb_set(jsonb_set(v_doc, '{pnl,1,revenue}', '51'), '{accrual_lines,2,amount}', '51'),
          v_a::uuid) IS DISTINCT FROM v_base
     -- số tiền của chính A, % cổ đông, quy tắc lương, toà C cùng nhóm ⇒ ĐỔI
     OR app_private.profit_building_source_hash_v2_2(
          jsonb_set(v_doc, '{accrual_lines,0,amount}', '101'), v_a::uuid) = v_base
     OR app_private.profit_building_source_hash_v2_2(
          jsonb_set(v_doc, '{pnl,0,net}', '61'), v_a::uuid) = v_base
     OR app_private.profit_building_source_hash_v2_2(
          jsonb_set(v_doc, '{shareholder_config,0,percent}', '61'), v_a::uuid) = v_base
     OR app_private.profit_building_source_hash_v2_2(
          jsonb_set(v_doc, '{manager_salary_rules,0,amount}', '11'), v_a::uuid) = v_base
     OR app_private.profit_building_source_hash_v2_2(
          jsonb_set(v_doc, '{pnl,2,net}', '71'), v_a::uuid) = v_base
     -- tài liệu sai hình dạng / toà không có dòng pnl ⇒ NULL
     OR app_private.profit_building_source_hash_v2_2(
          jsonb_set(v_doc, '{algorithm_version}', '"khac"'), v_a::uuid) IS NOT NULL
     OR app_private.profit_building_source_hash_v2_2(
          v_doc, '00000000-0000-4000-8000-0000000000ff'::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'Hàm chiếu profit-close-v2.2 không đạt tự kiểm' USING ERRCODE = '55000';
  END IF;
END
$sau$;

NOTIFY pgrst, 'reload schema';

COMMIT;
