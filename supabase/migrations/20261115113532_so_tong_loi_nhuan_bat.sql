-- =============================================================================
-- Sổ tổng lợi nhuận cổ đông — ĐỢT 3b: SIẾT ĐỌC THẲNG % / SỐ TOÀ (X5) VÀ BẬT CHI THEO SỔ TỔNG (X6).
--
-- ĐIỀU KIỆN ÁP: CHỈ SAU KHI web Đợt 2 đã lên production và 20261115113530 (Đợt 3a) đã áp.
--
-- ĐIỀN TRƯỚC KHI ÁP (một lệnh, rồi sinh lại provenance — khối tiền kiểm DỪNG nếu còn giữ chỗ):
--   S2 = commit production của web Đợt 2: meta build-sha của trang production hoặc
--        `git rev-parse origin/production` (KHÔNG dùng release:verify để tìm S2; dùng nó để xác nhận S2).
--   Chuỗi giữ chỗ xuất hiện ĐÚNG MỘT LẦN, ở lệnh set_config đầu file; lệnh điền (chạy ở gốc repo):
--   node -e "const fs=require('fs'),f=process.argv[1],s=process.argv[2],k='<<SHA_'+'PRODUCTION_WEB>>',t=fs.readFileSync(f,'utf8');if(!/^[0-9a-f]{40}$/.test(s)||t.split(k).length!==2)throw Error('S2 sai hoặc giữ chỗ không đúng một lần');fs.writeFileSync(f,t.replace(k,s))" supabase/migrations/20261115113532_so_tong_loi_nhuan_bat.sql <S2>
--   rồi: git add supabase/migrations/20261115113532_so_tong_loi_nhuan_bat.sql && npm run -s provenance:generate
--        (TEST: thêm npm run -s provenance:generate -- --env test).
--
-- VÌ SAO
--   X5: ba policy tự xem (profit_allocations, building_shareholders, profit_monthly) cho cổ đông đọc
--       thẳng % và doanh thu/chi phí toà chỉ vì là cổ đông. Sổ tổng tách hai quyền mới
--       (shareholder_profit.view_percent, view_building_totals); web Đợt 2 đọc qua RPC của sổ tổng.
--   X6: bật chi lợi nhuận theo sổ tổng (công tắc ON) với đủ bốn trường danh tính phát hành.
--
-- LÀM GÌ
--   0. Tiền kiểm: S2 đã điền; nền Đợt 1 đúng bản đã rà (md5 F1, E5, E9 phần ghi); Đợt 3a đã áp (công
--      tắc SHADOW, bốn phiếu cũ ra khỏi KQKD, lệnh chi cũ đã thu quyền, đủ bốn mốc); ba policy đang ở
--      bản cũ hoặc bản mới (lượt hai).
--   X5. ALTER POLICY: profit_alloc_self_select, bldg_sh_self_select thêm
--       app_private.profit_viewer_can_v1(organization_id, 'shareholder_profit.view_percent');
--       profit_monthly_self_select thêm view_percent VÀ view_building_totals. Các policy khác giữ nguyên.
--   X6. SHADOW → ON qua app_private.set_feature_route_v1 (CAS config_version đọc lúc chạy):
--       commit_sha = S2; migration_sha256 = sha256 nội dung file 20261115084108_so_tong_loi_nhuan_tao.sql
--       (blob git, LF — trùng sha256 trong supabase/migration-provenance.json, cách tiền lệ
--       20260926172614 dùng); maintenance_window_id = 'MW-<ngày giờ VN lúc áp>-so-tong-loi-nhuan-bat';
--       approval_reference = 'chủ uỷ quyền 15/11/2026'; actor = tài khoản chủ có vai TENANT_OWNER kích
--       hoạt sớm nhất. Hậu kiểm route CANONICAL. Không CANARY (quyết định chủ).
--
-- AN TOÀN CHẠY LẠI: ALTER POLICY ghi lại cùng biểu thức; X6 thấy ON với đúng S2 thì bỏ qua.
--   Công ty thật vắng (Restore Drill) ⇒ X6 và các kiểm dữ liệu bỏ qua; X5 vẫn chạy.
-- LÙI: R6 (policy về USING cũ — luôn TRƯỚC R1), R7a đóng băng / R7b về SHADOW / R7c gỡ đóng băng,
--   R1 về OFF — văn bản trong PR.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

-- S2 — commit production của web Đợt 2 (40 ký tự hex). ĐIỀN TRƯỚC KHI ÁP, xem đầu file.
SELECT set_config('ihomecrm.d3b_commit_sha', 'f29a1599bff0cf0a4d41bad766088b16bab20c94', true);

-- 0. Tiền kiểm.
DO $truoc$
DECLARE
  c_org     constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  c_khoa    constant text := 'shareholder_profit.ledger_payout.v1';
  c_x3      constant uuid[] := ARRAY['2488536d-1a38-4f8e-840e-d27cb690629c', '33c8b388-079a-48d7-a7a7-ab0141b26eb8',
                                     'd66ba7f7-a7d9-4123-8ed0-4e3e53b6cd45', 'e6bff80c-ec79-4073-9a8a-b7bb4256adba']::uuid[];
  v_sha     text := current_setting('ihomecrm.d3b_commit_sha', true);
  v_thieu   text;
  v_actor   uuid;
  v_ok      boolean;
  f         app_private.server_feature_flags%ROWTYPE;
  r         record;
  v_n       integer;
BEGIN
  PERFORM set_config('ihomecrm.d3b_bo_qua', 'off', true);
  PERFORM set_config('ihomecrm.d3b_actor', '', true);

  IF v_sha IS NULL OR v_sha !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'D3B_CHUA_DIEN_SHA: chưa điền commit production của web Đợt 2 (giữ chỗ còn nguyên) — xem đầu file'
      USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(x.ten, ', ' ORDER BY x.ten) INTO v_thieu
    FROM unnest(ARRAY[
      'app_private.set_feature_route_v1(text,bigint,text,timestamptz,timestamptz,integer,numeric,numeric,text,text,text,text,uuid,text)',
      'app_private.evaluate_feature_route(text,uuid)',
      'app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)',
      'app_private.profit_viewer_can_v1(uuid,text)',
      'app_private.profit_ledger_active_marker_v1(uuid,text,uuid)',
      'app_private.profit_ledger_voucher_live_v1(uuid)',
      'public.current_shareholder_id()'
    ]) AS x(ten)
   WHERE to_regprocedure(x.ten) IS NULL;
  IF v_thieu IS NOT NULL THEN
    RAISE EXCEPTION 'D3B_NEN: thiếu hàm nền: %', v_thieu USING ERRCODE = '55000';
  END IF;
  IF NOT has_function_privilege('authenticated', 'app_private.profit_viewer_can_v1(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'D3B_NEN: authenticated phải gọi được profit_viewer_can_v1 (policy gọi hàm này)' USING ERRCODE = '55000';
  END IF;
  -- Bản đã rà của Đợt 1 — gắn migration_sha256 với mã thật đang chạy:
  --   F1 guard_profit_ledger_payout_v1 (chặn tự duyệt, Hoàn tác / Huỷ duyệt / Khôi phục — M2-chặn),
  --   E5 shareholder_profit_ledger_payout_v1 và phần ghi mốc (M2-tạo, file có sha256 ở X6).
  FOR r IN
    SELECT * FROM (VALUES
      ('app_private.guard_profit_ledger_payout_v1()', '668c5e5c0a1e2c7dda74f0bd7f5f6e3b'),
      ('public.shareholder_profit_ledger_payout_v1(uuid,numeric,uuid,date,text,boolean,text)', '106a24c9450641f073f0be317fdab3bf'),
      ('app_private.profit_ledger_tao_set_marker_v1(uuid,text,uuid,date,text,uuid,boolean,text,uuid)', '6f68c04a7496dc5b63c0618c9a93f5bb')
    ) AS x(ten, md5_than)
  LOOP
    IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.ten))
       IS DISTINCT FROM r.md5_than THEN
      RAISE EXCEPTION 'D3B_NEN: % khác bản Đợt 1 đã rà — sửa sha256 / md5 ở file này sau khi rà lại', r.ten
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- Ba policy: bản cũ (lượt một) hoặc bản mới của file này (lượt hai) — biểu thức khác ⇒ dừng.
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
       AND p.polroles = ARRAY['authenticated'::regrole]::oid[]
       AND md5(replace(pg_get_expr(p.polqual, p.polrelid), 'public.', '')) IN (r.md5_cu, r.md5_moi);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'D3B_X5: policy % trên % không ở bản cũ đã rà cũng không ở bản mới', r.ten, r.bang USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = c_org) THEN
    PERFORM set_config('ihomecrm.d3b_bo_qua', 'on', true);
    RAISE NOTICE 'D3b: không có công ty thật (database dùng một lần) — chỉ áp X5';
    RETURN;
  END IF;

  -- Đợt 3a đã áp.
  SELECT * INTO f FROM app_private.server_feature_flags WHERE feature_key = c_khoa;
  IF NOT FOUND OR f.force_freeze
     OR NOT (f.mode = 'SHADOW' OR (f.mode = 'ON' AND f.commit_sha = v_sha)) THEN
    RAISE EXCEPTION 'D3B_D3A: công tắc phải ở SHADOW (Đợt 3a) — đang %, đóng băng %', f.mode, f.force_freeze
      USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM public.income_expenses ie
       WHERE ie.id = ANY (c_x3) AND ie.business_result_accounting IS FALSE AND ie.kqkd_amount = 0) <> cardinality(c_x3) THEN
    RAISE EXCEPTION 'D3B_D3A: bốn phiếu chia lợi nhuận cũ chưa ra khỏi KQKD (Đợt 3a chưa áp)' USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('authenticated', 'public.distribute_shareholder_profit_v1(uuid,numeric,uuid,date,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'D3B_D3A: lệnh chi lợi nhuận cũ vẫn mở cho authenticated (Đợt 3a chưa áp)' USING ERRCODE = '55000';
  END IF;
  FOR r IN
    SELECT * FROM (VALUES
      ('SHAREHOLDER', '0568d869494cff82b3723d08ce7a7f93', DATE '2026-09-01'),
      ('SHAREHOLDER', '7583daba684a285cf80f34d83f8f578c', DATE '2026-09-01'),
      ('MANAGER', '8ed6564e0e6a931a1b17829ebc824f7e', DATE '2026-05-01'),
      ('MANAGER', 'faa25320f50b68402328d2ea2fffca9a', DATE '2026-05-01')
    ) AS x(kind, md5_id, thang)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM (SELECT s.id FROM public.shareholders s WHERE r.kind = 'SHAREHOLDER' AND s.organization_id = c_org AND md5(s.id::text) = r.md5_id
              UNION ALL
              SELECT m.id FROM public.profit_managers m WHERE r.kind = 'MANAGER' AND m.organization_id = c_org AND md5(m.id::text) = r.md5_id) c
       CROSS JOIN LATERAL app_private.profit_ledger_active_marker_v1(c_org, r.kind, c.id) mk
       WHERE mk.settled_through_month = r.thang) THEN
      RAISE EXCEPTION 'D3B_D3A: thiếu mốc % (Đợt 3a chưa áp hoặc mốc đã bị đổi)', r.md5_id USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- Người bật: như Đợt 3a — vai TENANT_OWNER, ACTIVE, kích hoạt sớm nhất; phải có quyền chi lợi nhuận.
  SELECT m.user_id INTO v_actor
    FROM public.organization_memberships m
    JOIN public.role_bindings rb ON rb.membership_id = m.id
    JOIN public.organization_roles r2 ON r2.id = rb.role_id AND r2.organization_id = m.organization_id
   WHERE m.organization_id = c_org
     AND m.status = 'ACTIVE'
     AND m.activated_at IS NOT NULL
     AND (m.valid_to IS NULL OR m.valid_to > now())
     AND (rb.valid_from IS NULL OR rb.valid_from <= now())
     AND (rb.valid_to IS NULL OR rb.valid_to > now())
     AND r2.system_key = 'TENANT_OWNER'
     AND r2.status = 'ACTIVE'
   ORDER BY m.activated_at, m.user_id
   LIMIT 1;
  SELECT a.allowed INTO v_ok
    FROM app_private.authorize_tenant_action_v3(v_actor, c_org, 'shareholder_profit.distribute', NULL, NULL) a;
  IF v_actor IS NULL OR NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'D3B_ACTOR: không có tài khoản chủ (vai TENANT_OWNER, đã kích hoạt, có quyền chi lợi nhuận)'
      USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('ihomecrm.d3b_actor', v_actor::text, true);
END
$truoc$;

-- X5. Siết ba policy tự xem (contracts I2 của Đợt 1). Không đổi vai, lệnh, kiểu permissive.
ALTER POLICY profit_alloc_self_select ON public.profit_allocations
  USING ((shareholder_id = public.current_shareholder_id())
         AND app_private.profit_viewer_can_v1(organization_id, 'shareholder_profit.view_percent'));

ALTER POLICY bldg_sh_self_select ON public.building_shareholders
  USING ((shareholder_id = public.current_shareholder_id())
         AND app_private.profit_viewer_can_v1(organization_id, 'shareholder_profit.view_percent'));

ALTER POLICY profit_monthly_self_select ON public.profit_monthly
  USING ((EXISTS (SELECT 1
                    FROM public.profit_allocations pa
                   WHERE pa.profit_monthly_id = profit_monthly.id
                     AND pa.shareholder_id = public.current_shareholder_id()))
         AND app_private.profit_viewer_can_v1(organization_id, 'shareholder_profit.view_percent')
         AND app_private.profit_viewer_can_v1(organization_id, 'shareholder_profit.view_building_totals'));

DO $x5_sau$
DECLARE
  r   record;
  v_n integer;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.profit_allocations', 'profit_alloc_self_select', '0f054bd4aff0f0f2e82da2f6758713d8'),
      ('public.building_shareholders', 'bldg_sh_self_select', '0f054bd4aff0f0f2e82da2f6758713d8'),
      ('public.profit_monthly', 'profit_monthly_self_select', '06593fc2ad8e42337a6ac9a1237e3c52')
    ) AS x(bang, ten, md5_moi)
  LOOP
    SELECT count(*) INTO v_n FROM pg_catalog.pg_policy p
     WHERE p.polrelid = to_regclass(r.bang) AND p.polname = r.ten AND p.polcmd = 'r' AND p.polpermissive
       AND p.polroles = ARRAY['authenticated'::regrole]::oid[] AND p.polwithcheck IS NULL
       AND md5(replace(pg_get_expr(p.polqual, p.polrelid), 'public.', '')) = r.md5_moi;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'D3B_X5: hậu kiểm policy % sai', r.ten USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$x5_sau$;

-- X6. SHADOW → ON.
DO $x6$
DECLARE
  c_org     constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  c_khoa    constant text := 'shareholder_profit.ledger_payout.v1';
  -- sha256 nội dung supabase/migrations/20261115084108_so_tong_loi_nhuan_tao.sql (M2-tạo, LF).
  c_m2_sha256 constant text := 'b3bd97e7b47a58eb396bd95a3d5caa447e9fb0f6e8c1a343b5f547d1468b4a67';
  c_duyet   constant text := 'chủ uỷ quyền 15/11/2026';
  v_sha     text := current_setting('ihomecrm.d3b_commit_sha', true);
  v_actor   uuid := nullif(current_setting('ihomecrm.d3b_actor', true), '')::uuid;
  v_mw      text := 'MW-' || to_char(now() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI') || '-so-tong-loi-nhuan-bat';
  f         app_private.server_feature_flags%ROWTYPE;
  v_ver     bigint;
BEGIN
  IF current_setting('ihomecrm.d3b_bo_qua', true) = 'on' THEN
    RETURN;
  END IF;
  IF v_actor IS NULL OR v_sha IS NULL OR v_sha !~ '^[0-9a-f]{40}$' OR c_m2_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'D3B_X6: thiếu người bật / S2 / sha256 (khối tiền kiểm chưa chạy?)' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO f FROM app_private.server_feature_flags WHERE feature_key = c_khoa FOR UPDATE;
  IF f.mode = 'ON' AND f.commit_sha = v_sha AND NOT f.force_freeze THEN
    RETURN;  -- lượt hai
  END IF;
  IF f.mode <> 'SHADOW' OR f.force_freeze THEN
    RAISE EXCEPTION 'D3B_X6: công tắc phải ở SHADOW, không đóng băng (đang %)', f.mode USING ERRCODE = '55000';
  END IF;
  -- Ở SHADOW không lệnh nào lập được phiếu chi theo sổ tổng; có phiếu sống ⇒ có đường ghi lạ.
  IF EXISTS (SELECT 1 FROM app_private.profit_ledger_payouts p
              WHERE p.organization_id = c_org AND app_private.profit_ledger_voucher_live_v1(p.voucher_id))
     OR EXISTS (SELECT 1 FROM public.income_expenses ie
                 WHERE ie.shareholder_id IS NOT NULL AND ie.system_source IS DISTINCT FROM 'profit.ledger_payout') THEN
    RAISE EXCEPTION 'D3B_X6: đã có phiếu chi lợi nhuận ngoài lệnh sổ tổng trước khi bật — hỏi chủ' USING ERRCODE = '55000';
  END IF;

  v_ver := app_private.set_feature_route_v1(c_khoa, f.config_version, 'ON', NULL, NULL, 0, 0, 0,
             v_sha, c_m2_sha256, v_mw, c_duyet, v_actor,
             'Đợt 3b (20261115113532): bật chi lợi nhuận theo sổ tổng — chủ uỷ quyền 15/11/2026');

  SELECT * INTO f FROM app_private.server_feature_flags WHERE feature_key = c_khoa;
  IF v_ver IS DISTINCT FROM f.config_version
     OR f.mode <> 'ON' OR f.force_freeze OR f.commit_sha IS DISTINCT FROM v_sha
     OR f.migration_sha256 IS DISTINCT FROM c_m2_sha256 OR f.maintenance_window_id IS DISTINCT FROM v_mw
     OR f.approval_reference IS DISTINCT FROM c_duyet
     OR app_private.evaluate_feature_route(c_khoa, c_org) <> 'CANONICAL'
     OR (SELECT count(*) FROM app_private.server_feature_flag_events e
          WHERE e.feature_key = c_khoa AND e.event_type = 'ROUTE_CHANGED'
            AND e.before_mode = 'SHADOW' AND e.after_mode = 'ON' AND e.after_version = v_ver) <> 1 THEN
    RAISE EXCEPTION 'D3B_X6: hậu kiểm bật sai (route không CANONICAL hoặc danh tính thiếu)' USING ERRCODE = '55000';
  END IF;
END
$x6$;

COMMIT;
