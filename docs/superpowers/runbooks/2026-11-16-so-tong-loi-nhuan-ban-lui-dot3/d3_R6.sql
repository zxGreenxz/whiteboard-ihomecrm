-- =============================================================================
-- Sổ tổng lợi nhuận cổ đông — BẢN LÙI R6: ba policy tự xem về USING cũ (lùi X5 của Đợt 3b, 20261115113532).
--
-- DÙNG KHI: lùi Đợt 3b. LUÔN chạy TRƯỚC R1: ở LEGACY web cũ đọc thẳng ba bảng này; R1 tự dừng nếu còn X5.
-- CÁCH ÁP — tệp này KHÔNG phải migration, chỉ dùng khi phải lùi; nội dung đã là migration hoàn chỉnh.
--   Runbook: docs/superpowers/runbooks/2026-11-16-so-tong-loi-nhuan-ban-lui-dot3/README.md
--   1. node scripts/tao-ten-migration.mjs so_tong_loi_nhuan_policy_cu   (chỉ IN ra tên <timestamp>_<slug>.sql)
--   2. tạo supabase/migrations/<tên vừa in> chứa NGUYÊN VĂN tệp này → git add <tệp đó> → npm run provenance:generate
--   3. npm run migrate:forward -- <tệp>            (dry-run: lane dán HAI lượt trong một giao dịch rồi ROLLBACK)
--   4. npm run migrate:forward -- <tệp> --apply    (chỉ sau dry-run xanh)
--
-- LÀM GÌ
--   0. Tiền kiểm: mỗi policy (lệnh SELECT, permissive, chỉ vai authenticated) đang ở bản MỚI của X5 hoặc đã ở
--      bản CŨ (lượt hai) — biểu thức khác cả hai ⇒ dừng R6_X5 (ai đó đã sửa tay; không đè mù).
--   1. ALTER POLICY profit_alloc_self_select, bldg_sh_self_select, profit_monthly_self_select về USING cũ
--      (đúng bản trước X5; không đổi vai, lệnh, kiểu permissive).
--   2. Hậu kiểm md5 biểu thức (bỏ "public.") = bản cũ, đúng hình dạng như D3b đã kiểm.
--
-- AN TOÀN CHẠY LẠI: ALTER POLICY ghi lại cùng biểu thức. Công ty thật vắng (Restore Drill) ⇒ VẪN chạy, như X5
--   của D3b (thay đổi schema, không phụ thuộc dữ liệu).
-- THỨ TỰ lùi toàn phần: R7a → R7b → R7c → R6 → R3 → R2 → R4 → (R5) → R1; R6 LUÔN trước R1 — xem runbook.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

DO $r6_truoc$
DECLARE
  r   record;
  v_n integer;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.profit_allocations', 'profit_alloc_self_select',
       '994851d13a12894dc95535a6980dda25', '0f054bd4aff0f0f2e82da2f6758713d8'),
      ('public.building_shareholders', 'bldg_sh_self_select',
       '994851d13a12894dc95535a6980dda25', '0f054bd4aff0f0f2e82da2f6758713d8'),
      ('public.profit_monthly', 'profit_monthly_self_select',
       'bd85d18a46e55d64a6acc38720db3851', '06593fc2ad8e42337a6ac9a1237e3c52')
    ) AS x(bang, ten, md5_cu, md5_moi)
  LOOP
    SELECT count(*) INTO v_n FROM pg_catalog.pg_policy p
     WHERE p.polrelid = to_regclass(r.bang) AND p.polname = r.ten AND p.polcmd = 'r' AND p.polpermissive
       AND p.polroles = ARRAY['authenticated'::regrole]::oid[] AND p.polwithcheck IS NULL
       AND md5(replace(pg_get_expr(p.polqual, p.polrelid), 'public.', '')) IN (r.md5_cu, r.md5_moi);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'R6_X5: policy % trên % không ở bản X5 cũng không ở bản cũ — đã bị sửa tay, kiểm trước khi lùi', r.ten, r.bang
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$r6_truoc$;

ALTER POLICY profit_alloc_self_select ON public.profit_allocations
  USING ((shareholder_id = public.current_shareholder_id()));

ALTER POLICY bldg_sh_self_select ON public.building_shareholders
  USING ((shareholder_id = public.current_shareholder_id()));

ALTER POLICY profit_monthly_self_select ON public.profit_monthly
  USING ((EXISTS (SELECT 1
                    FROM public.profit_allocations pa
                   WHERE pa.profit_monthly_id = profit_monthly.id
                     AND pa.shareholder_id = public.current_shareholder_id())));

DO $r6_sau$
DECLARE
  r   record;
  v_n integer;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.profit_allocations', 'profit_alloc_self_select', '994851d13a12894dc95535a6980dda25'),
      ('public.building_shareholders', 'bldg_sh_self_select', '994851d13a12894dc95535a6980dda25'),
      ('public.profit_monthly', 'profit_monthly_self_select', 'bd85d18a46e55d64a6acc38720db3851')
    ) AS x(bang, ten, md5_cu)
  LOOP
    SELECT count(*) INTO v_n FROM pg_catalog.pg_policy p
     WHERE p.polrelid = to_regclass(r.bang) AND p.polname = r.ten AND p.polcmd = 'r' AND p.polpermissive
       AND p.polroles = ARRAY['authenticated'::regrole]::oid[] AND p.polwithcheck IS NULL
       AND md5(replace(pg_get_expr(p.polqual, p.polrelid), 'public.', '')) = r.md5_cu;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'R6_SAU: policy % chưa về đúng bản cũ', r.ten USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
              WHERE p.policyname IN ('profit_alloc_self_select', 'bldg_sh_self_select', 'profit_monthly_self_select')
                AND p.qual LIKE '%profit_viewer_can_v1%') THEN
    RAISE EXCEPTION 'R6_SAU: còn policy gọi profit_viewer_can_v1' USING ERRCODE = '55000';
  END IF;
END
$r6_sau$;

COMMIT;
