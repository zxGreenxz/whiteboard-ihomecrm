-- =============================================================================
-- GĐ-R vá tiếp: bị giới hạn tốc độ phải trả HTTP 429, không phải 500
--
-- 20260808130000 dùng ERRCODE '54000' (program_limit_exceeded). PostgREST ánh xạ
-- mã đó thành HTTP 500. Đo trên production: 60 lượt dò lọt, lượt 61 trả
-- `HTTP 500 "rate_limited"` — chặn ĐÚNG, nhưng nói SAI.
--
-- 500 sai ba đường cùng lúc:
--   • Với khách: client bắt !res.ok rồi hiện màn "mất kết nối, thử lại" — người
--     bị giới hạn tốc độ lại tưởng mạng mình hỏng.
--   • Với hạ tầng: Cloudflare và mọi thứ đứng giữa đọc 5xx là "origin đang
--     hỏng". 429 là tín hiệu chuẩn cho "chậm lại", chúng hiểu và tự lùi.
--   • Với người trực: 5xx trên bảng theo dõi là báo động giả, và báo động giả
--     lặp lại thì người ta tắt bảng theo dõi.
--
-- PostgREST có quy ước: SQLSTATE dạng `PTxxx` thì xxx chính là mã HTTP trả về.
-- Nên 'PT429' cho ra đúng 429 Too Many Requests.
--
-- Chỉ đổi ĐÚNG một dòng ERRCODE trong thân hàm; mọi thứ khác giữ nguyên từ
-- 20260808130000 (ngưỡng 60 mã sai / 10 phút / IP, kiểm ngưỡng TRƯỚC khi tra
-- cứu, chỉ đếm mã sai, không có IP tin cậy thì không chặn).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_public_latest_invoice_by_code(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id      uuid;
  v_ip      inet;
  v_cua_so  timestamptz;
  v_so_lan  integer;
  NGUONG    constant integer := 60;      -- mã sai tối đa mỗi cửa sổ, mỗi IP
BEGIN
  IF p_code IS NULL OR p_code = '' THEN
    RETURN NULL;
  END IF;

  v_ip := app_private.ip_dang_tin();
  v_cua_so := date_trunc('hour', now())
              + (floor(extract(minute FROM now()) / 10) * interval '10 minutes');

  -- (1) KIỂM NGƯỠNG TRƯỚC KHI TRA CỨU. Đảo thứ tự là thủng đúng một lần mỗi
  --     cửa sổ, và một lần là đủ để lấy dữ liệu một khách.
  IF v_ip IS NOT NULL THEN
    SELECT so_lan INTO v_so_lan
      FROM app_private.public_code_probe
     WHERE ip = v_ip AND cua_so = v_cua_so;

    IF coalesce(v_so_lan, 0) >= NGUONG THEN
      -- PT429 → PostgREST trả HTTP 429. Xem đầu file vì sao không dùng 54000.
      RAISE EXCEPTION 'rate_limited'
        USING HINT = 'Quá nhiều mã hợp đồng sai từ địa chỉ này. Thử lại sau ít phút.',
              ERRCODE = 'PT429';
    END IF;
  END IF;

  -- (2) Tra cứu.
  SELECT id INTO v_id
    FROM public.contracts
   WHERE public_code = p_code
     AND deleted_at IS NULL;

  -- (3) CHỈ đếm khi mã SAI. Người xem hoá đơn của chính mình luôn gọi đúng mã.
  IF v_id IS NULL THEN
    IF v_ip IS NOT NULL THEN
      INSERT INTO app_private.public_code_probe (ip, cua_so, so_lan)
      VALUES (v_ip, v_cua_so, 1)
      ON CONFLICT (ip, cua_so)
      DO UPDATE SET so_lan = app_private.public_code_probe.so_lan + 1;

      DELETE FROM app_private.public_code_probe
       WHERE cua_so < now() - interval '2 hours';
    END IF;
    RETURN NULL;
  END IF;

  RETURN public.get_public_latest_invoice_by_contract(v_id);
END;
$function$;

DO $nghiem_thu$
DECLARE
  v_payload jsonb;
  v_ma      text;
  v_code    text;
  i         integer;
BEGIN
  SELECT c.public_code INTO v_ma
    FROM public.contracts c
   WHERE c.deleted_at IS NULL AND c.status <> 'TERMINATED' AND c.public_code IS NOT NULL
   LIMIT 1;

  PERFORM set_config('request.headers', '{"cf-connecting-ip":"192.0.2.211"}', true);

  FOR i IN 1..60 LOOP
    PERFORM public.get_public_latest_invoice_by_code('yy' || lpad(i::text, 4, '0'));
  END LOOP;

  BEGIN
    v_payload := public.get_public_latest_invoice_by_code('yy9999');
    RAISE EXCEPTION 'Lượt 61 không bị chặn. DỪNG.';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
    IF v_code <> 'PT429' THEN
      RAISE EXCEPTION 'Bị chặn nhưng SQLSTATE là % chứ không phải PT429 — PostgREST sẽ không trả 429. DỪNG.', v_code;
    END IF;
  END;

  -- Vế còn lại: IP khác vẫn phải dùng được ngay.
  PERFORM set_config('request.headers', '{"cf-connecting-ip":"198.51.100.212"}', true);
  v_payload := public.get_public_latest_invoice_by_code(v_ma);
  IF v_payload IS NULL THEN
    RAISE EXCEPTION 'IP khác không tra được mã đúng — limiter đang chặn nhầm cả hệ thống. DỪNG.';
  END IF;

  RAISE NOTICE 'Nghiệm thu đạt: lượt 61 bị chặn với SQLSTATE PT429, IP khác vẫn dùng được.';
END
$nghiem_thu$;

COMMIT;
