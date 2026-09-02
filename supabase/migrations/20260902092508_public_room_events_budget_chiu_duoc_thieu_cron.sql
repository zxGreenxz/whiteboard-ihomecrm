-- =============================================================================
-- Vá 20260902091449 cho môi trường KHÔNG CÓ schema `cron` (PANALYTICS-C02).
--
-- VÌ SAO: Restore Drill replay migration đó trên database dựng từ baseline —
-- ở đó `cron` không tồn tại (extension pg_cron thuộc nền tảng Supabase, baseline
-- cố ý không chụp). Lời gọi `cron.unschedule` nằm ở giữa file nên CẢ FILE bị
-- cuộn lại: bản khôi phục MẤT bảng ngân sách, logger có budget và hàm retention
-- — đúng loại drift "chỉ có trên prod" mà 20260902082002 vừa dọn cho PS04.
--
-- VÁ: file này chép NGUYÊN VĂN phần schema của 20260902091449 (bảng + logger +
-- hàm prune) và chỉ bọc PHẦN CRON trong điều kiện `to_regnamespace('cron')`.
-- Trên production: idempotent hoàn toàn (IF NOT EXISTS / CREATE OR REPLACE /
-- unschedule-rồi-schedule). Trên DB diễn tập: chạy SẠCH, chỉ bỏ qua đăng ký cron.
--
-- File 20260902091449 giữ nguyên bytes (forward-only immutable) và được khai
-- trong supabase/baseline/forward-lane-expectations.json là "dừng vì thiếu cron".
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE TABLE IF NOT EXISTS app_private.public_room_event_budgets (
  token      text        NOT NULL,
  ngay       date        NOT NULL,
  so_dong    integer     NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token, ngay)
);

COMMENT ON TABLE app_private.public_room_event_budgets IS
'Đếm số sự kiện analytics công khai đã ghi theo (token, ngày VN). Chặn anon bơm bảng public_room_events lớn vô hạn (PANALYTICS-C02, 02/09/2026). Nằm trong app_private nên KHÔNG lộ qua PostgREST.';

ALTER TABLE app_private.public_room_event_budgets ENABLE ROW LEVEL SECURITY;

-- ── 2. Logger: thêm kiểm ngân sách, giữ nguyên phần còn lại ──────────────────
CREATE OR REPLACE FUNCTION public.log_public_room_events(
  p_token  text,
  p_events jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_owner   uuid;
  v_count   int := 0;
  v_meta    jsonb;
  r         record;
  v_ngay    date;
  v_da_ghi  int;
  v_con_lai int;
  c_tran    CONSTANT int := 5000;   -- dòng/token/ngày (PANALYTICS-C02)
  v_allowed CONSTANT text[] := ARRAY[
    'session','impression','building_select','view_mode','room_open','image_view',
    'floorplan_view','contact_click','share','download','directions','favorite',
    'deposit_dialog','error'
  ];
BEGIN
  IF p_token IS NULL OR p_token = '' THEN
    RETURN 0;
  END IF;

  -- Token phải tồn tại & chưa thu hồi → resolve owner_id phía server.
  SELECT owner_id INTO v_owner
  FROM public.public_room_share_tokens
  WHERE token = p_token AND revoked = false;
  IF v_owner IS NULL THEN
    RETURN 0;  -- token sai/thu hồi: no-op im lặng
  END IF;

  IF p_events IS NULL
     OR jsonb_typeof(p_events) <> 'array'
     OR jsonb_array_length(p_events) = 0 THEN
    RETURN 0;
  END IF;

  -- NGÂN SÁCH: đã dùng hết hạn mức ngày của token này thì dừng, im lặng.
  v_ngay := (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  INSERT INTO app_private.public_room_event_budgets (token, ngay, so_dong)
  VALUES (p_token, v_ngay, 0)
  ON CONFLICT (token, ngay) DO NOTHING;

  SELECT b.so_dong INTO v_da_ghi
    FROM app_private.public_room_event_budgets b
   WHERE b.token = p_token AND b.ngay = v_ngay;
  v_con_lai := c_tran - COALESCE(v_da_ghi, 0);
  IF v_con_lai <= 0 THEN
    RETURN 0;
  END IF;

  FOR r IN
    SELECT t.e
    FROM jsonb_array_elements(p_events) WITH ORDINALITY AS t(e, ord)
    WHERE t.ord <= LEAST(50, v_con_lai)            -- trần batch VÀ trần ngày còn lại
      AND jsonb_typeof(t.e) = 'object'
      AND NULLIF(t.e->>'session_id','') IS NOT NULL
      AND t.e->>'event_type' = ANY(v_allowed)      -- lọc event_type lạ (tránh CHECK abort)
  LOOP
    BEGIN
      v_meta := CASE
        WHEN r.e->'metadata' IS NULL OR jsonb_typeof(r.e->'metadata') <> 'object'
          THEN '{}'::jsonb
        WHEN length((r.e->'metadata')::text) > 8192
          -- Hạ cấp có chọn lọc: giữ đúng những khóa mà báo cáo cần để gộp nhóm.
          THEN jsonb_strip_nulls(jsonb_build_object(
                 'kind',      r.e->'metadata'->>'kind',
                 'msg',       left(r.e->'metadata'->>'msg', 500),
                 'fp',        r.e->'metadata'->>'fp',
                 'source',    r.e->'metadata'->>'source',
                 'n',         r.e->'metadata'->'n',
                 'is_staff',  r.e->'metadata'->'is_staff',
                 '_truncated', to_jsonb(true)
               ))
        ELSE r.e->'metadata'
      END;

      INSERT INTO public.public_room_events (
        token, owner_id, session_id, event_type,
        room_id, room_name, room_code, building_id, building_name,
        duration_ms, dwell_ms, metadata, created_at
      )
      VALUES (
        p_token,
        v_owner,                                   -- server-resolved; bỏ qua client owner_id
        left(NULLIF(r.e->>'session_id',''), 64),
        r.e->>'event_type',
        CASE WHEN (r.e->>'room_id')     ~ '^[0-9a-fA-F-]{36}$' THEN (r.e->>'room_id')::uuid     END,
        left(r.e->>'room_name', 200),
        left(r.e->>'room_code', 64),
        CASE WHEN (r.e->>'building_id') ~ '^[0-9a-fA-F-]{36}$' THEN (r.e->>'building_id')::uuid END,
        left(r.e->>'building_name', 200),
        CASE WHEN jsonb_typeof(r.e->'duration_ms')='number'
             THEN LEAST(GREATEST((r.e->>'duration_ms')::numeric::int, 0), 86400000) END,
        CASE WHEN jsonb_typeof(r.e->'dwell_ms')='number'
             THEN LEAST(GREATEST((r.e->>'dwell_ms')::numeric::int, 0), 86400000) END,
        v_meta,
        now()                                      -- tin đồng hồ server; bỏ qua client created_at
      );
      v_count := v_count + 1;
    EXCEPTION
      WHEN others THEN
        -- Dòng hỏng chỉ mất chính nó. Đây là điểm khác cốt lõi so với bản cũ:
        -- không được để một sự kiện dị dạng kéo theo cả batch.
        NULL;
    END;
  END LOOP;

  IF v_count > 0 THEN
    UPDATE app_private.public_room_event_budgets b
       SET so_dong = b.so_dong + v_count, updated_at = now()
     WHERE b.token = p_token AND b.ngay = v_ngay;
  END IF;

  RETURN v_count;
EXCEPTION
  WHEN others THEN
    RETURN 0;  -- không bao giờ lộ nội bộ cho anon
END;
$fn$;

COMMENT ON FUNCTION public.log_public_room_events(text, jsonb) IS
'Anon batch logger cho /r/:token. Validate token (chưa revoke), resolve owner_id
server-side, cắt batch <=50, NGÂN SÁCH 5.000 dòng/token/ngày (VN) qua
app_private.public_room_event_budgets, clamp string/duration, lọc event_type lạ.
Ghi TỪNG DÒNG trong sub-transaction: dòng hỏng chỉ mất chính nó, batch vẫn sống.
Metadata > 8192 ký tự bị hạ cấp còn kind/msg/fp/source/n để báo cáo vẫn gộp nhóm
được. Trả số dòng ghi. KHÔNG tin owner_id/created_at từ client.';

REVOKE ALL ON FUNCTION public.log_public_room_events(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_public_room_events(text, jsonb) TO anon, authenticated;

-- ── 3. Retention ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.pra_prune_public_room_events_v1(p_days int DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE v_n int;
BEGIN
  IF p_days IS NULL OR p_days < 30 THEN
    RAISE EXCEPTION 'Retention tối thiểu 30 ngày (nhận %). DỪNG.', p_days;
  END IF;
  DELETE FROM public.public_room_events
   WHERE created_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  DELETE FROM app_private.public_room_event_budgets
   WHERE ngay < (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - make_interval(days => p_days);

  RETURN v_n;
END;
$fn$;

COMMENT ON FUNCTION app_private.pra_prune_public_room_events_v1(int) IS
'Xoá sự kiện analytics công khai cũ hơn N ngày (mặc định 90) + dọn bảng ngân sách. Sàn 30 ngày để không ai lỡ tay xoá sạch. Chạy bởi cron pra_prune_public_room_events_v1 (PANALYTICS-C02, 02/09/2026).';

REVOKE ALL ON FUNCTION app_private.pra_prune_public_room_events_v1(int) FROM PUBLIC, anon, authenticated;

-- ── Cron: chỉ đăng ký khi nền tảng có pg_cron ───────────────────────────────
DO $cronblock$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'Không có schema cron (môi trường diễn tập) — bỏ qua đăng ký retention job.';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pra_prune_public_room_events_v1') THEN
    PERFORM cron.unschedule('pra_prune_public_room_events_v1');
  END IF;
  PERFORM cron.schedule(
    'pra_prune_public_room_events_v1',
    '41 3 * * *',
    $cron$SELECT app_private.pra_prune_public_room_events_v1(90);$cron$
  );
END
$cronblock$;

-- ── Nghiệm thu: schema luôn phải đủ; cron chỉ kiểm khi nền tảng có ──────────
DO $verify$
DECLARE v_src text; v_n int;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'log_public_room_events';
  IF v_src IS NULL OR v_src NOT LIKE '%public_room_event_budgets%' OR v_src NOT LIKE '%c_tran%' THEN
    RAISE EXCEPTION 'log_public_room_events chưa có ngân sách. DỪNG.';
  END IF;

  IF to_regclass('app_private.public_room_event_budgets') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng ngân sách. DỪNG.';
  END IF;

  IF to_regprocedure('app_private.pra_prune_public_room_events_v1(int)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu hàm retention. DỪNG.';
  END IF;

  IF has_function_privilege('anon', 'app_private.pra_prune_public_room_events_v1(int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon EXECUTE được hàm retention. DỪNG.';
  END IF;

  IF to_regnamespace('cron') IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'pra_prune_public_room_events_v1' AND active;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'Cron retention chưa đăng ký (thấy % job). DỪNG.', v_n;
    END IF;
  END IF;
END
$verify$;

COMMIT;
