-- =====================================================================
-- Đợt 1 · Step 2 — `organization_timezones` + `org_today_v1`
-- Plan ghi thẳng: "KHÔNG dùng CURRENT_DATE".
--
-- VÌ SAO ĐÂY LÀ LỖI THẬT, KHÔNG PHẢI SẠCH SẼ HÌNH THỨC (đo trên prod 30/07/2026):
--   • `current_setting('TimeZone')` = **UTC**.
--   • Việt Nam là UTC+7. Nên trong khoảng **17:00–24:00 UTC**, tức
--     **00:00–07:00 sáng giờ Việt Nam**, `CURRENT_DATE` trả về **NGÀY HÔM QUA**.
--     Bảy giờ mỗi ngày, đều đặn.
--   • **36 hàm** trong public/app_private đang dùng `CURRENT_DATE`.
--   Hệ quả người dùng thấy: mở app lúc 6 giờ sáng, tạo phiếu/hoá đơn hoặc chốt
--   kỳ thì hệ thống ghi ngày hôm trước; kỳ hạn, hạn nợ, "phiếu hôm nay" đều lệch.
--   Ở thời điểm viết (12:00 UTC = 19:00 VN) chưa lệch, nên bug này VÔ HÌNH nếu
--   chỉ thử vào giờ hành chính — đó là lý do nó sống lâu.
--
-- FILE NÀY CHỈ DỰNG PRIMITIVE, KHÔNG SỬA 36 HÀM KIA. Thay `CURRENT_DATE` trong
-- hàm tiền là đổi HÀNH VI ngày tháng của nghiệp vụ đang chạy — phải làm theo
-- từng nhóm, có review và có bằng chứng trước/sau. Ghi rõ ở đây để người sau
-- không tưởng Đợt 1 đã dọn xong.
--
-- KHÔNG ĐỤNG TIỀN: tạo một bảng cấu hình + hai hàm đọc. Không DML lên bảng tiền.
-- =====================================================================
BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. Bảng múi giờ theo tổ chức
--    Một dòng / một org. Không có dòng ⇒ hàm rơi về mặc định Asia/Ho_Chi_Minh
--    (toàn bộ dữ liệu hiện tại là Việt Nam), và nói rõ đó là mặc định chứ không
--    phải cấu hình — để sau này thêm org nước khác thì thấy ngay chỗ phải khai.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.organization_timezones (
  organization_id uuid PRIMARY KEY
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  timezone        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Chặn chuỗi múi giờ vô nghĩa NGAY LÚC GHI: `now() AT TIME ZONE <rác>` ném lỗi
  -- lúc ĐỌC, tức lỗi nổ ở một hàm tiền cách đó rất xa. Thà chặn tại đây.
  CONSTRAINT organization_timezones_valid_chk
    CHECK (pg_catalog.now() AT TIME ZONE timezone IS NOT NULL)
);

COMMENT ON TABLE public.organization_timezones IS
  'Múi giờ nghiệp vụ của từng tổ chức. Nguồn cho org_today_v1 — thay cho '
  'CURRENT_DATE, vốn trả NGÀY HÔM QUA trong 00:00–07:00 giờ VN vì server chạy UTC. '
  'Không có dòng ⇒ mặc định Asia/Ho_Chi_Minh.';
COMMENT ON COLUMN public.organization_timezones.timezone IS
  'Tên IANA, ví dụ Asia/Ho_Chi_Minh. CHECK bảo đảm Postgres hiểu được ngay lúc ghi.';

ALTER TABLE public.organization_timezones ENABLE ROW LEVEL SECURITY;

-- Đọc: thành viên của org. Ghi: chỉ super admin (đây là cấu hình hệ thống, đổi
-- múi giờ là dịch toàn bộ mốc ngày của tổ chức).
DROP POLICY IF EXISTS org_timezones_select ON public.organization_timezones;
CREATE POLICY org_timezones_select ON public.organization_timezones
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.organization_memberships m
     WHERE m.organization_id = organization_timezones.organization_id
       AND m.user_id = auth.uid() AND m.status = 'ACTIVE'
  ) OR public.is_super_admin());

DROP POLICY IF EXISTS org_timezones_write ON public.organization_timezones;
CREATE POLICY org_timezones_write ON public.organization_timezones
  FOR ALL TO authenticated
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

REVOKE ALL ON public.organization_timezones FROM anon;
GRANT SELECT ON public.organization_timezones TO authenticated;
GRANT ALL ON public.organization_timezones TO service_role;

-- Khai cho hai org đang có. Idempotent.
INSERT INTO public.organization_timezones (organization_id, timezone)
SELECT o.id, 'Asia/Ho_Chi_Minh' FROM public.organizations o
ON CONFLICT (organization_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 2. app_private.org_timezone_v1 — tra múi giờ, có mặc định
--    STABLE là ĐÚNG ở đây: chỉ SELECT một bảng cấu hình, KHÔNG lấy khoá dòng nào,
--    nên không sa vào án lệ 25006 (hàm STABLE chạm khoá dòng ⇒ vỡ qua PostgREST).
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.org_timezone_v1(p_organization_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT COALESCE(
    (SELECT t.timezone FROM public.organization_timezones t
      WHERE t.organization_id = p_organization_id),
    'Asia/Ho_Chi_Minh');
$function$;

COMMENT ON FUNCTION app_private.org_timezone_v1(uuid) IS
  'Múi giờ nghiệp vụ của org; mặc định Asia/Ho_Chi_Minh khi chưa khai.';

-- ─────────────────────────────────────────────────────────────────────
-- 3. public.org_today_v1 — "hôm nay" theo giờ của tổ chức
--    Đây là thứ phải dùng thay cho CURRENT_DATE ở mọi chỗ tính ngày nghiệp vụ.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.org_today_v1(p_organization_id uuid DEFAULT NULL)
 RETURNS date
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT (pg_catalog.now() AT TIME ZONE
            app_private.org_timezone_v1(
              COALESCE(
                p_organization_id,
                -- Không truyền org: suy ra từ membership ACTIVE của người gọi.
                -- CỐ Ý để membership THẮNG profiles.organization_id — án lệ đã ghi:
                -- 6/10 profile trỏ SAI org. Nhiều org mà không truyền tham số thì
                -- KHÔNG đoán: `min(...) FILTER (count = 1)` trả NULL ⇒ rơi về mặc
                -- định, chứ không chọn bừa một org.
                -- `min(uuid)` KHÔNG tồn tại trong Postgres ⇒ gộp qua text rồi cast lại.
                (SELECT CASE WHEN count(DISTINCT m.organization_id) = 1
                             THEN min(m.organization_id::text)::uuid END
                   FROM public.organization_memberships m
                  WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE')
              )
            ))::date;
$function$;

REVOKE ALL ON FUNCTION public.org_today_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_today_v1(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.org_today_v1(uuid) IS
  '"Hôm nay" theo múi giờ NGHIỆP VỤ của tổ chức — dùng thay CURRENT_DATE. Server '
  'chạy UTC nên CURRENT_DATE trả NGÀY HÔM QUA trong 00:00–07:00 giờ VN, tức bảy '
  'giờ mỗi ngày; bug đó vô hình nếu chỉ thử vào giờ hành chính. Không truyền org '
  'thì suy từ membership ACTIVE duy nhất của người gọi (membership THẮNG '
  'profiles.organization_id — 6/10 profile trỏ sai org); nhiều org thì KHÔNG đoán, '
  'rơi về mặc định. ⚠ Đợt 1 CHỈ dựng primitive: 36 hàm khác vẫn đang dùng '
  'CURRENT_DATE và phải chuyển theo từng nhóm có review, chưa làm.';

-- ─────────────────────────────────────────────────────────────────────
-- 4. TỰ KIỂM
-- ─────────────────────────────────────────────────────────────────────
DO $selfcheck$
DECLARE
  v_n int;
  v_tz text;
  v_d date;
BEGIN
  -- (a) Mọi org phải có dòng múi giờ.
  SELECT count(*) INTO v_n FROM public.organizations o
   WHERE NOT EXISTS (SELECT 1 FROM public.organization_timezones t
                      WHERE t.organization_id = o.id);
  IF v_n > 0 THEN
    RAISE EXCEPTION '% org chưa có dòng múi giờ. DỪNG.', v_n;
  END IF;

  -- (b) Hàm trả đúng ngày theo giờ VN cho org thật.
  SELECT app_private.org_timezone_v1(id) INTO v_tz FROM public.organizations
   WHERE name = 'iHome CRM' LIMIT 1;
  IF v_tz <> 'Asia/Ho_Chi_Minh' THEN
    RAISE EXCEPTION 'Múi giờ org thật = % (mong đợi Asia/Ho_Chi_Minh). DỪNG.', v_tz;
  END IF;

  SELECT public.org_today_v1(id) INTO v_d FROM public.organizations
   WHERE name = 'iHome CRM' LIMIT 1;
  IF v_d IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN
    RAISE EXCEPTION 'org_today_v1 = % nhưng ngày ở VN = %. DỪNG.',
      v_d, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  END IF;

  -- (c) RLS phải bật, anon không đọc được.
  IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relname='organization_timezones') THEN
    RAISE EXCEPTION 'organization_timezones chưa bật RLS. DỪNG.';
  END IF;
  IF has_table_privilege('anon','public.organization_timezones','SELECT') THEN
    RAISE EXCEPTION 'anon đọc được organization_timezones. DỪNG.';
  END IF;
  IF has_function_privilege('anon','public.org_today_v1(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'anon chạy được org_today_v1. DỪNG.';
  END IF;
  IF NOT has_function_privilege('authenticated','public.org_today_v1(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'authenticated không chạy được org_today_v1. DỪNG.';
  END IF;

  -- (d) CHECK phải thật sự chặn múi giờ rác.
  BEGIN
    INSERT INTO public.organization_timezones (organization_id, timezone)
    SELECT id, 'Khong/Ton_Tai' FROM public.organizations LIMIT 1;
    RAISE EXCEPTION 'CHECK không chặn được múi giờ rác. DỪNG.';
  EXCEPTION
    WHEN check_violation OR invalid_parameter_value OR invalid_datetime_format THEN
      NULL;  -- đúng như mong đợi
    WHEN unique_violation THEN
      NULL;  -- org đã có dòng, CHECK chưa kịp chạy — không kết luận
  END;
END
$selfcheck$;

COMMIT;
