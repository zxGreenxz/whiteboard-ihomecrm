-- =============================================================================
-- GĐ6 (phần một) — Điền organization_id cho những dòng TRUY ĐƯỢC CHA
--
-- 4.189 dòng đang mang organization_id NULL, và 20/21 bảng chứa chúng ĐÃ có biên
-- giới tổ chức. Chúng vẫn hiện cho mọi công ty, vì công thức chuẩn của Sprint 3b
-- mở đầu bằng `organization_id IS NULL OR …`. Nhánh đó là cửa thoát hiểm cố ý
-- (để không vỡ INSERT cũ chưa set cột), nhưng một cửa thoát hiểm mở suốt thì
-- chỉ là một cái cửa.
--
-- ⚠ VÌ SAO KHÔNG DÙNG LẠI app_private._autofill_org().
-- Hàm autofill của Sprint 3b kết thúc bằng:
--     NEW.organization_id := COALESCE(v, PROD);
-- tức dòng nào không truy được cha thì gán thẳng cho CÔNG TY THẬT. Backfill 4.189
-- dòng bằng logic đó sẽ lặng lẽ nhận vơ hàng nghìn dòng của DEMO/Test cho công ty
-- thật — trông như thành công, không một lỗi nào. File này KHÔNG có nhánh mặc
-- định: không suy ra được thì để nguyên và báo số ra ngoài.
--
-- ⚠ VÌ SAO SUY QUA NGƯỜI PHẢI KÈM ĐIỀU KIỆN "ĐÚNG MỘT TỔ CHỨC".
-- Đo thật trên production: cả 3.032 dòng public_room_events đều thuộc một chủ sở
-- hữu có HAI membership ACTIVE. Suy theo owner_id ở đó là tung đồng xu 3.032 lần,
-- mà mặt sai đẩy dữ liệu công ty thật sang DEMO. Chỉ điền khi người đó có ĐÚNG
-- MỘT tổ chức đang hoạt động.
--
-- ⚠ HAI BẢNG CỐ Ý KHÔNG ĐỤNG TỚI, chờ người cho luật:
--   public_room_events — 3.032 dòng, 100% chủ sở hữu đa tổ chức, không có căn cứ.
--   cron_runs          — 72 dòng, bảng KHÔNG có một cột cha nào để mà truy.
--
-- THỨ TỰ DÂY CHUYỀN là một phần của tính đúng đắn, không phải thẩm mỹ:
-- inspection_photos hiện truy được 0 chỉ vì inspection_sessions cha của chúng
-- cũng đang NULL. Vá cha trước thì 335 dòng ảnh tự truy được ở lượt hai.
--
-- Idempotent: chỉ đụng vào dòng organization_id IS NULL.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- Hàm chạy MỘT câu backfill, và phân biệt hai loại kết cục:
--   • chạy được  → cộng vào tổng
--   • bị guard chặn (append-only / immutable / retention) → GHI TÊN LẠI, đi tiếp
--
-- Bị guard chặn KHÔNG phải lỗi của file này: đó là bảng cố ý bất biến, và gỡ nó
-- đòi một quyết định riêng của con người (cùng loại quyết định với việc xoá hai
-- tổ chức Test/Demo). Nhưng "đi tiếp" chỉ chấp nhận được nếu tên bảng được BÁO
-- RA — im lặng bỏ qua đúng là cách nợ trở thành vĩnh viễn.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pg_temp.chay_backfill(p_sql text, p_bang text,
                                                 INOUT p_tong bigint, INOUT p_chan text[])
LANGUAGE plpgsql AS $fn$
DECLARE v_n bigint;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  p_tong := p_tong + v_n;
  IF v_n > 0 THEN RAISE NOTICE '  % dòng ← %', v_n, p_bang; END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE IN ('55000', 'P0001') THEN
    p_chan := p_chan || p_bang;
  ELSE
    RAISE;
  END IF;
END
$fn$;

DO $backfill$
DECLARE
  v_n        bigint;
  v_tong     bigint := 0;
  v_chan     text[] := ARRAY[]::text[];
  r          record;
  -- (bảng con, cột khoá, bảng cha) — cha có tổ chức XÁC ĐỊNH nên không đa nghĩa.
  qua_cha    text[][] := ARRAY[
    ARRAY['inspection_sessions',            'building_id', 'buildings'],
    ARRAY['building_fee_accounts',          'building_id', 'buildings'],
    ARRAY['profit_manager_salary_buildings','building_id', 'buildings'],
    ARRAY['room_pass_listings',             'building_id', 'buildings'],
    ARRAY['invoice_audit_log',              'invoice_id',  'invoices']
  ];
  -- (bảng, cột người) — CHỈ điền khi người đó có đúng một membership ACTIVE.
  qua_nguoi  text[][] := ARRAY[
    ARRAY['salary_award_errors',   'staff_id'],
    ARRAY['salary_attendance_day', 'user_id'],
    ARRAY['salary_streak_state',   'user_id'],
    ARRAY['notifications',         'user_id'],
    ARRAY['material_usages',       'user_id'],
    ARRAY['cash_handovers',        'giver_id'],
    ARRAY['settings',              'user_id'],
    ARRAY['push_subscriptions',    'user_id'],
    ARRAY['profit_managers',       'user_id'],
    ARRAY['profit_manager_salaries','user_id'],
    ARRAY['public_room_share_tokens','owner_id']
  ];
  -- LƯỢT HAI — con của những bảng vừa được vá ở trên.
  day_chuyen text[][] := ARRAY[
    ARRAY['inspection_photos',   'session_id',  'inspection_sessions'],
    ARRAY['cash_handover_items', 'handover_id', 'cash_handovers'],
    ARRAY['material_usage_items','usage_id',    'material_usages']
  ];
BEGIN
  RAISE NOTICE 'LƯỢT 1 — suy qua bảng cha:';
  FOR i IN 1 .. array_length(qua_cha, 1) LOOP
    SELECT * INTO v_tong, v_chan FROM pg_temp.chay_backfill(format(
      'UPDATE public.%I t SET organization_id = p.organization_id '
      '  FROM public.%I p WHERE p.id = t.%I '
      '   AND t.organization_id IS NULL AND p.organization_id IS NOT NULL',
      qua_cha[i][1], qua_cha[i][3], qua_cha[i][2]), qua_cha[i][1], v_tong, v_chan);
  END LOOP;

  RAISE NOTICE 'LƯỢT 2 — suy qua người có ĐÚNG MỘT tổ chức:';
  FOR i IN 1 .. array_length(qua_nguoi, 1) LOOP
    SELECT * INTO v_tong, v_chan FROM pg_temp.chay_backfill(format(
      'UPDATE public.%I t SET organization_id = m.org '
      '  FROM (SELECT user_id, (array_agg(organization_id))[1] AS org '
      '          FROM public.organization_memberships WHERE status = ''ACTIVE'' '
      '         GROUP BY user_id HAVING count(DISTINCT organization_id) = 1) m '
      ' WHERE m.user_id = t.%I AND t.organization_id IS NULL',
      qua_nguoi[i][1], qua_nguoi[i][2]), qua_nguoi[i][1], v_tong, v_chan);
  END LOOP;

  RAISE NOTICE 'LƯỢT 3 — dây chuyền, con của những bảng vừa vá:';
  FOR i IN 1 .. array_length(day_chuyen, 1) LOOP
    SELECT * INTO v_tong, v_chan FROM pg_temp.chay_backfill(format(
      'UPDATE public.%I t SET organization_id = p.organization_id '
      '  FROM public.%I p WHERE p.id = t.%I '
      '   AND t.organization_id IS NULL AND p.organization_id IS NOT NULL',
      day_chuyen[i][1], day_chuyen[i][3], day_chuyen[i][2]), day_chuyen[i][1], v_tong, v_chan);
  END LOOP;

  RAISE NOTICE 'GĐ6: đã điền tổng cộng % dòng.', v_tong;
  IF array_length(v_chan, 1) > 0 THEN
    RAISE NOTICE 'BỊ GUARD BẤT BIẾN CHẶN (cần quyết định riêng, cùng loại với việc tắt guard để xoá org): %',
      array_to_string(v_chan, ', ');
  END IF;
END
$backfill$;

-- ─────────────────────────────────────────────────────────────────────
-- VERIFY
-- ─────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_lech bigint;
  v_con  bigint;
BEGIN
  -- Con không được mang tổ chức KHÁC cha. Nếu có, phép suy vừa rồi sai chỗ nào đó.
  SELECT count(*) INTO v_lech
    FROM public.inspection_photos t
    JOIN public.inspection_sessions p ON p.id = t.session_id
   WHERE t.organization_id IS NOT NULL AND p.organization_id IS NOT NULL
     AND t.organization_id <> p.organization_id;
  IF v_lech > 0 THEN
    RAISE EXCEPTION '% dòng inspection_photos mang tổ chức khác phiên nghiệm thu cha. DỪNG.', v_lech;
  END IF;

  SELECT count(*) INTO v_lech
    FROM public.cash_handover_items t
    JOIN public.cash_handovers p ON p.id = t.handover_id
   WHERE t.organization_id IS NOT NULL AND p.organization_id IS NOT NULL
     AND t.organization_id <> p.organization_id;
  IF v_lech > 0 THEN
    RAISE EXCEPTION '% dòng cash_handover_items mang tổ chức khác phiên bàn giao cha. DỪNG.', v_lech;
  END IF;

  -- Báo ra số còn lại, kèm tên bảng — im lặng ở đây là cách nợ trở thành vĩnh viễn.
  SELECT count(*) INTO v_con FROM public.public_room_events WHERE organization_id IS NULL;
  RAISE NOTICE 'CÒN LẠI (chờ người cho luật): public_room_events % dòng', v_con;
  SELECT count(*) INTO v_con FROM public.cron_runs WHERE organization_id IS NULL;
  RAISE NOTICE 'CÒN LẠI (không có cột cha): cron_runs % dòng', v_con;
END
$verify$;

COMMIT;

-- =============================================================================
-- ROLLBACK: không có đường lùi tự động — file này ĐIỀN dữ liệu, không đổi schema.
-- Muốn lùi thì khôi phục từ bản dump chụp ngay trước lúc apply (lane tự tạo và
-- ghi đường dẫn vào docs/generated/schema-change-evidence/).
-- =============================================================================
