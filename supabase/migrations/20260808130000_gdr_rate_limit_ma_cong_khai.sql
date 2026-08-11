-- =============================================================================
-- GĐ-R — Rate-limit bề mặt hoá đơn công khai (Thiết kế A, thuần DB)
--
-- BỐI CẢNH ĐO ĐƯỢC 08/08/2026:
--   public.get_public_latest_invoice_by_code(text) anon gọi được, nhận mã 6 ký
--   tự. Bảng chữ cái 57 ký tự ⇒ 57^6 = 34.296.447.249 tổ hợp trên 334 mã sống,
--   mật độ trúng ≈ 9,7e-9 ⇒ trung bình ~103 triệu lần thử cho MỘT lần trúng.
--   Không giới hạn tốc độ thì ở 500 req/s là ~2,4 ngày.
--
-- VÌ SAO THIẾT KẾ A CHỨ KHÔNG PHẢI EDGE FUNCTION (spike 20260808110000/120000):
--   • request.headers CÓ phơi trên project này (25 khoá).
--   • cf-connecting-ip KHÔNG giả được — cố giả thì Cloudflare trả 403, request
--     không tới được database. (Kế hoạch từng ghi Cloudflare không đứng trước
--     supabase.co; đo ra là SAI.)
--   • Hop CUỐI của x-forwarded-for luôn là IP thật do hạ tầng nối vào; phần đầu
--     do client tự đặt nên đếm theo nó là limiter GIẢ.
--   • Edge function có đường vòng: kẻ tấn công POST thẳng /rest/v1/rpc là qua
--     mặt limiter, nên nó BẮT BUỘC kèm REVOKE khỏi anon + sửa client + sửa hai
--     file contract. Bộ đếm ở đây nằm BÊN TRONG chính hàm anon gọi — không có
--     đường vòng nào.
--
-- BA QUYẾT ĐỊNH THIẾT KẾ, mỗi cái có lý do:
--
--   1. CHỈ ĐẾM MÃ SAI, không đếm mọi lượt gọi.
--      Người xem hoá đơn của chính mình luôn gọi ĐÚNG mã — mã tới từ QR/link.
--      Kẻ dò thì gọi sai gần như 100%. Đếm mọi lượt gọi sẽ phạt người dùng thật
--      (mở lại trang, F5, chia sẻ link trong nhà) mà chẳng thêm được gì.
--
--   2. KIỂM NGƯỠNG TRƯỚC KHI TRA CỨU.
--      Nếu tra trước rồi mới đếm thì đúng cái request vượt ngưỡng vẫn kịp lấy
--      dữ liệu — thủng đúng một lần mỗi cửa sổ, và một lần là đủ.
--
--   3. KHÔNG CÓ IP TIN CẬY THÌ KHÔNG CHẶN.
--      Gọi từ SQL nội bộ / job / migration thì không có request.headers. Chặn
--      lúc đó là tự bắn vào chân mình, mà cũng chẳng chặn được ai: đường duy
--      nhất anon vào được là qua PostgREST, và qua đó thì luôn có
--      cf-connecting-ip do Cloudflare đặt.
--
-- ĐIỀU PHẢI NÓI THẲNG — cái này KHÔNG chống được:
--   Kẻ tấn công có nhiều IP (botnet, proxy xoay vòng) thì chia nhỏ hạn mức ra
--   nhiều IP là đi tiếp được. Rate-limit theo IP nâng CHI PHÍ tấn công lên nhiều
--   lần chứ không đóng lỗ. Thứ đóng lỗ là xoay mã lên ≥16 ký tự (GĐ0 mục 6a(i),
--   CHƯA LÀM — cả 334 mã vẫn 6 ký tự). File này là phòng thủ chiều sâu, và nó
--   không được dùng làm cớ để hoãn việc xoay mã.
--
-- NGƯỠNG: 60 mã sai / 10 phút / IP.
--   Rộng tay có chủ ý, vì khách sau cùng một NAT hoặc gateway 4G dùng chung một
--   IP. Người thật gõ sai 60 lần trong 10 phút là chuyện không xảy ra.
--   Với kẻ dò: 60/10 phút = 8.640/ngày ⇒ ~103 triệu lần thử cần ~32 NĂM cho một
--   lần trúng, từ một IP.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Bảng đếm. Đặt ở app_private: PostgREST phơi schema `api` (và `public` khi có
-- header Content-Profile), KHÔNG phơi app_private — nên bảng này không thành
-- một endpoint mới.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_private.public_code_probe (
  ip         inet        NOT NULL,
  cua_so     timestamptz NOT NULL,
  so_lan     integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, cua_so)
);

COMMENT ON TABLE app_private.public_code_probe IS
  'Đếm số lần dò MÃ SAI trên bề mặt hoá đơn công khai, theo IP và cửa sổ 10 phút. Không đếm lượt gọi đúng mã.';

CREATE INDEX IF NOT EXISTS public_code_probe_cua_so_idx
  ON app_private.public_code_probe (cua_so);

-- ---------------------------------------------------------------------------
-- Rút IP ĐÁNG TIN từ request.headers. Trả NULL khi không có gì đáng tin —
-- người gọi phải hiểu NULL là "không nhận dạng được", không phải "IP rỗng".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.ip_dang_tin()
RETURNS inet
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public
AS $f$
DECLARE
  v_headers jsonb;
  v_txt     text;
BEGIN
  BEGIN
    v_headers := (current_setting('request.headers', true))::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  IF v_headers IS NULL THEN
    RETURN NULL;
  END IF;

  -- Ưu tiên cf-connecting-ip: đo được là client KHÔNG đặt được nó (cố đặt thì
  -- Cloudflare trả 403 trước khi request tới database).
  v_txt := btrim(coalesce(v_headers ->> 'cf-connecting-ip', ''));

  -- Dự phòng: hop CUỐI CÙNG của x-forwarded-for. Luôn là IP thật do hạ tầng nối
  -- vào. TUYỆT ĐỐI không lấy hop đầu — phần đầu do client tự đặt, đổi được mỗi
  -- request, dùng nó để đếm là limiter giả.
  IF v_txt = '' THEN
    v_txt := btrim(coalesce(
      (string_to_array(v_headers ->> 'x-forwarded-for', ','))[
        array_length(string_to_array(v_headers ->> 'x-forwarded-for', ','), 1)
      ], ''));
  END IF;

  IF v_txt = '' THEN
    RETURN NULL;
  END IF;

  BEGIN
    RETURN v_txt::inet;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;   -- header méo mó thì coi như không nhận dạng được
  END;
END;
$f$;

-- ---------------------------------------------------------------------------
-- Hàm công khai, viết lại. Giữ nguyên chữ ký và hình dạng trả về.
-- ---------------------------------------------------------------------------
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
      RAISE EXCEPTION 'rate_limited'
        USING HINT = 'Quá nhiều mã hợp đồng sai từ địa chỉ này. Thử lại sau ít phút.',
              ERRCODE = '54000';
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

      -- Dọn rác cơ hội: giữ 2 giờ gần nhất. Làm ngay tại đây thay vì cron để
      -- bảng không phình mà cũng không phải nuôi thêm một lịch chạy.
      DELETE FROM app_private.public_code_probe
       WHERE cua_so < now() - interval '2 hours';
    END IF;
    RETURN NULL;
  END IF;

  RETURN public.get_public_latest_invoice_by_contract(v_id);
END;
$function$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — chạy thật trong chính transaction này, không suy luận từ mã.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_ma      text;
  v_payload jsonb;
  v_loi     text;
  i         integer;
BEGIN
  -- Lấy một mã ĐÚNG đang sống để kiểm vế "người thật vẫn dùng được".
  SELECT c.public_code INTO v_ma
    FROM public.contracts c
   WHERE c.deleted_at IS NULL AND c.status <> 'TERMINATED'
     AND c.public_code IS NOT NULL
   LIMIT 1;
  IF v_ma IS NULL THEN
    RAISE EXCEPTION 'Không có hợp đồng sống nào để nghiệm thu. DỪNG.';
  END IF;

  -- Giả lập một IP cụ thể qua đúng GUC mà PostgREST đặt.
  PERFORM set_config('request.headers', '{"cf-connecting-ip":"192.0.2.77"}', true);

  IF app_private.ip_dang_tin() <> '192.0.2.77'::inet THEN
    RAISE EXCEPTION 'ip_dang_tin() không rút được cf-connecting-ip. DỪNG.';
  END IF;

  -- Hop CUỐI của XFF, không phải hop đầu.
  PERFORM set_config('request.headers',
    '{"x-forwarded-for":"9.9.9.9, 8.8.8.8, 192.0.2.88"}', true);
  IF app_private.ip_dang_tin() <> '192.0.2.88'::inet THEN
    RAISE EXCEPTION 'ip_dang_tin() lấy nhầm hop của x-forwarded-for — limiter sẽ đếm theo giá trị kẻ tấn công tự đặt. DỪNG.';
  END IF;

  PERFORM set_config('request.headers', '{"cf-connecting-ip":"192.0.2.77"}', true);

  -- 60 mã SAI phải đi lọt (chưa chạm ngưỡng), và trả NULL chứ không nổ.
  FOR i IN 1..60 LOOP
    v_payload := public.get_public_latest_invoice_by_code('zzz' || lpad(i::text, 3, '0'));
    IF v_payload IS NOT NULL THEN
      RAISE EXCEPTION 'Mã bịa lại tra ra dữ liệu ở lần thứ %. DỪNG.', i;
    END IF;
  END LOOP;

  -- Lần thứ 61 phải bị chặn.
  BEGIN
    v_payload := public.get_public_latest_invoice_by_code('zzz999');
    RAISE EXCEPTION 'Lần dò thứ 61 KHÔNG bị chặn — limiter không có tác dụng. DỪNG.';
  EXCEPTION WHEN sqlstate '54000' THEN
    GET STACKED DIAGNOSTICS v_loi = MESSAGE_TEXT;
    IF v_loi <> 'rate_limited' THEN
      RAISE EXCEPTION 'Bị chặn nhưng sai thông điệp: %. DỪNG.', v_loi;
    END IF;
  END;

  -- Và người thật CŨNG bị chặn ở IP đó — đúng theo thiết kế, vì ta không phân
  -- biệt được người thật với kẻ dò khi cùng một IP đã vượt ngưỡng.
  BEGIN
    v_payload := public.get_public_latest_invoice_by_code(v_ma);
    RAISE EXCEPTION 'Ngưỡng không áp cho mã đúng — kiểm ngưỡng đang chạy SAU khi tra cứu. DỪNG.';
  EXCEPTION WHEN sqlstate '54000' THEN
    NULL;
  END;

  -- Đổi sang IP khác: phải dùng được ngay, chứng minh hạn mức theo TỪNG IP chứ
  -- không phải một cầu dao chung cho cả hệ thống.
  PERFORM set_config('request.headers', '{"cf-connecting-ip":"198.51.100.5"}', true);
  v_payload := public.get_public_latest_invoice_by_code(v_ma);
  IF v_payload IS NULL THEN
    RAISE EXCEPTION 'IP khác vẫn không tra được mã ĐÚNG — limiter đang chặn nhầm cả hệ thống. DỪNG.';
  END IF;
  IF NOT (v_payload ? 'customer') THEN
    RAISE EXCEPTION 'Payload trả về sai hình dạng sau khi viết lại hàm. DỪNG.';
  END IF;

  -- Không có IP đáng tin thì KHÔNG chặn (đường gọi nội bộ).
  PERFORM set_config('request.headers', '', true);
  IF app_private.ip_dang_tin() IS NOT NULL THEN
    RAISE EXCEPTION 'ip_dang_tin() bịa ra IP khi không có header. DỪNG.';
  END IF;
  v_payload := public.get_public_latest_invoice_by_code(v_ma);
  IF v_payload IS NULL THEN
    RAISE EXCEPTION 'Đường gọi nội bộ (không header) bị chặn. DỪNG.';
  END IF;

  RAISE NOTICE 'Nghiệm thu đạt: 60 mã sai lọt, lần 61 bị chặn, IP khác vẫn dùng được, đường nội bộ không bị chặn.';
END
$nghiem_thu$;

COMMIT;

-- =============================================================================
-- ROLLBACK: CREATE OR REPLACE lại bản hàm trước (nằm ở commit trước file này và
-- trong bản dump lane tự chụp), rồi DROP TABLE app_private.public_code_probe và
-- DROP FUNCTION app_private.ip_dang_tin().
--
-- CÒN LẠI, và file này KHÔNG thay thế được:
--   GĐ0 mục 6a(i) — xoay 334 mã public_code lên ≥16 ký tự kèm cửa sổ ân hạn
--   old_public_code/old_code_expires_at. Đó mới là thứ ĐÓNG lỗ; rate-limit chỉ
--   nâng chi phí tấn công. Kẻ có nhiều IP vẫn chia nhỏ hạn mức ra mà đi tiếp.
-- =============================================================================
