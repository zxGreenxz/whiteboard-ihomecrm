-- =============================================================================
-- GIẢM NHỊP POLL NETWORK CENTER 60s → 1800s (30 phút) + DỌN LOG CRON
--
-- VÌ SAO — đo trên production 30/08/2026, cửa sổ 4h07m:
--   Telemetry Network Center là ~100% tải GHI của toàn database: ~74.000 lượt
--   ghi dòng / 4h (5,1 dòng/giây), sinh 20 MB partition mỗi ngày. Với retention
--   14 ngày, một mình nó kéo database về ~550 MB — xoá sạch thành quả đợt dọn
--   OpenClaw (894 MB → 327 MB). Mỗi vòng poll còn kích hoạt realtime →
--   invalidate → RPC `network_center_get_building_v1`: 8.625 lượt gọi/4h, 584
--   giây CPU = 28,8% toàn bộ CPU SQL của database.
--
--   Giảm 60s → 1800s cắt nhịp ghi 30 lần: ~0,7 MB/ngày thay vì 20 MB/ngày.
--
-- CHỦ DỰ ÁN CHỌN 30 PHÚT (30/08/2026), không phải 5 phút như bản đề xuất đầu.
--
-- CÁI GIÁ PHẢI BIẾT — và vì sao nó KHÔNG chạm watchdog:
--   `network_center_watchdog_liveness_v1(300)` đo `heartbeat_at` của WORKER
--   (env `NETWORK_CENTER_HEARTBEAT_INTERVAL_MS=60000` trên VPS, KHÔNG đổi ở
--   đây), không đo nhịp poll. Đọc thân `app_private.network_center_watchdog_
--   liveness_scan_v1` trên production để xác nhận trước khi sửa. Nên poll 30
--   phút KHÔNG sinh báo động giả, và migration này cố ý KHÔNG đụng job 19.
--
--   Cái thật sự chậm đi là H196A: `openclaw`-độc-lập, node bị xếp OFFLINE khi
--   `consecutive_absent_polls >= 3` — đếm LƯỢT chứ không đếm giây (xem
--   20260829010000_network_center_h196a_downstream.sql:532). Ba lượt vắng nay là
--   ~90 phút thay vì ~3 phút. Đây là đánh đổi đã được chủ dự án chấp nhận.
--
-- CÁI CỐ Ý KHÔNG LÀM:
--   · KHÔNG giảm retention 14 ngày. Partition theo NGÀY nên dữ liệu cũ không
--     làm chậm truy vấn nóng; sau khi giảm poll, 14 ngày chỉ còn ~10 MB. Chủ dự
--     án muốn giữ dữ liệu để đo lại — giữ là đúng, không phải nợ.
--   · KHÔNG drop `network_*_samples_building_time_idx`. Bản kiểm đầu báo
--     "idx_scan=0 ⇒ vô dụng, 38 MB"; đo lại kỹ thì partition hôm nay có
--     idx_scan=5 / idx_tup_read=282 — index CÓ người dùng. Cộng thêm: sau khi
--     giảm poll 30×, chính nó teo còn ~1 MB, nên drop đổi rủi ro lấy gần như
--     không gì.
--
-- IDEMPOTENT: UPDATE có guard `WHERE ... IS DISTINCT FROM`; cron dùng
-- unschedule-rồi-schedule nên chạy lần hai là no-op.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- (1) Nhịp poll: nguồn sự thật nằm ở DATABASE, không phải env của worker.
--     Ghi chú quan trọng cho lần sau: ngày 30/08/2026 đã có một lần sửa
--     `NETWORK_CENTER_POLL_INTERVAL_MS` trong worker.env trên VPS và tưởng là
--     xong — số liệu ghi vào bảng cho thấy nhịp KHÔNG đổi (vẫn ~65 giây/vòng).
--     Worker đọc `poll_interval_seconds` từ hai bảng dưới đây; env chỉ là cận
--     dưới/mặc định lúc chưa có hồ sơ site.
UPDATE public.network_site_settings
   SET poll_interval_seconds = 1800
 WHERE poll_interval_seconds IS DISTINCT FROM 1800;

UPDATE public.network_device_connections
   SET poll_interval_seconds = 1800
 WHERE poll_interval_seconds IS DISTINCT FROM 1800;

-- (2) Dọn `cron.job_run_details`: bảng log nội bộ của pg_cron, không màn hình
--     nào đọc. Đo 30/08: 18 MB / 111.141 dòng và KHÔNG có retention nào.
--     90% số dòng từng do hai "ghost job" sinh ra (pg_cron chạy theo danh sách
--     cũ trong bộ nhớ sau khi `cron.job` đã bị xoá) — đã chữa bằng restart
--     project cùng ngày; job dọn này là để bảng không phình lại lần nữa.
DO $don_log_cron$
BEGIN
  IF pg_catalog.to_regclass('cron.job') IS NULL THEN
    RETURN;  -- môi trường replay (PGlite) không có pg_cron
  END IF;

  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'don_log_cron_v1';
  PERFORM cron.schedule(
    'don_log_cron_v1',
    '23 19 * * *',  -- 02:23 giờ VN, sau các job đêm
    $job$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'$job$
  );
END $don_log_cron$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — đo trong chính transaction này.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE v integer;
BEGIN
  SELECT count(*) INTO v FROM public.network_site_settings
   WHERE poll_interval_seconds IS DISTINCT FROM 1800;
  IF v > 0 THEN RAISE EXCEPTION 'NGHIEM THU: con % site chua ve 1800s', v; END IF;

  SELECT count(*) INTO v FROM public.network_device_connections
   WHERE poll_interval_seconds IS DISTINCT FROM 1800;
  IF v > 0 THEN RAISE EXCEPTION 'NGHIEM THU: con % connection chua ve 1800s', v; END IF;

  -- 1800 phải nằm trong CHECK (30..3600) — nếu ai đó siết constraint sau này thì
  -- migration replay phải chết ở đây chứ không phải im lặng bỏ qua.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.network_site_settings'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%poll_interval_seconds%3600%'
  ) THEN
    RAISE EXCEPTION 'NGHIEM THU: mat CHECK constraint poll_interval_seconds';
  END IF;

  IF pg_catalog.to_regclass('cron.job') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'don_log_cron_v1') THEN
    RAISE EXCEPTION 'NGHIEM THU: chua dang ky duoc job don_log_cron_v1';
  END IF;
END $nghiem_thu$;

COMMIT;

-- ROLLBACK: UPDATE hai bảng về 60; SELECT cron.unschedule('don_log_cron_v1').
