-- =============================================================================
-- Chặn NULL organization_id — đợt năm: settings
--
--   đợt 1 (20260811010000): 6 bảng, 24 dòng
--   đợt 2 (20260811020000): 3 bảng, 148 dòng
--   đợt 3 (20260811060000): 1 bảng, 5 dòng
--   đợt 4 (20260813030000): 1 bảng, 2 dòng — room_pass_listings
--   đợt 5 (file này):       1 bảng, 1 dòng — settings
--
-- ĐỢT NÀY KHÁC BA ĐỢT TRƯỚC, VÀ CHỖ KHÁC MỚI LÀ ĐIỀU ĐÁNG GHI
--   Ba đợt trước vá nợ CŨ: những dòng đã nằm sẵn ở đó từ trước khi ai đi tìm.
--   Dòng lần này sinh lúc **13/08/2026 00:47:29**, tức SAU khi đợt 4 chạy xong
--   sáng cùng ngày, và nó ra đời từ một thao tác người dùng thật: hoàn tất
--   onboarding. Không phải nợ lịch sử — là đường ghi đang chảy.
--
--   Nó lộ ra vì bốn migration chặn-NULL trước đó đều kết bằng một khối nghiệm
--   thu quét TOÀN BỘ bảng, nên cửa `check-forward-migration-idempotent` (dán
--   thân migration hai lần rồi ROLLBACK) làm cả bốn ngã cùng lúc. Một dòng dữ
--   liệu mới khiến bốn migration cũ "không chạy lại được" — nghe như lỗi
--   migration, thật ra là lỗi ĐƯỜNG GHI.
--
--   Vì thế phần quan trọng của file này KHÔNG phải câu UPDATE một dòng. Là cái
--   trigger. Vá số mà không gắn trigger thì đúng sáng mai lại có dòng thứ hai.
--
-- VÌ SAO SUY ĐƯỢC ORG
--   settings có user_id NOT NULL, và app_private.autofill_org_strict() suy org
--   từ organization_memberships khi user thuộc ĐÚNG MỘT tổ chức đang hoạt động
--   (nhiều hơn một thì nó trả NULL và fail-closed, không đoán bừa).
--
--   Đối chiếu 13/08/2026: bảng có 6 dòng, 5 dòng đã mang org "iHome CRM", dòng
--   thứ 6 là dòng NULL này và chủ của nó cũng chỉ thuộc 1 tổ chức. Tức nhãn suy
--   ra trùng với nhãn của mọi dòng anh em — không phải phỏng đoán.
--
-- VẪN CHƯA GẮN DIỆN RỘNG, cùng lý do đã ghi ở đợt ba: 84 bảng vừa nhận được
-- NULL vừa suy được org, mà autofill_org_strict FAIL-CLOSED. Bảng nào có đường
-- ghi không mang user_id lẫn bảng cha sẽ bắt đầu NỔ thay vì ghi — đổi một chỗ rò
-- im lặng lấy một chỗ hỏng ồn ào ở nơi chưa đo. Vẫn vá theo BẰNG CHỨNG.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

UPDATE public.settings t SET organization_id = m.org
  FROM (SELECT user_id, (array_agg(DISTINCT organization_id))[1] AS org
          FROM public.organization_memberships
         WHERE status = 'ACTIVE'
         GROUP BY user_id HAVING count(DISTINCT organization_id) = 1) m
 WHERE m.user_id = t.user_id AND t.organization_id IS NULL;

DROP TRIGGER IF EXISTS trg_autofill_org_strict ON public.settings;
CREATE TRIGGER trg_autofill_org_strict
  BEFORE INSERT ON public.settings
  FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_strict();

DO $nghiem_thu$
DECLARE
  r record; v_n bigint; v_con text := ''; v_tong bigint := 0;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id'
                         AND a.attnum>0 AND NOT a.attisdropped AND NOT a.attnotnull
     WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
       AND NOT c.relispartition
       AND NOT EXISTS (SELECT 1 FROM app_private.org_null_is_global g WHERE g.table_name = c.relname)
     ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IS NULL', r.relname) INTO v_n;
    IF v_n > 0 THEN v_tong := v_tong + v_n; v_con := v_con || format('%s(%s) ', r.relname, v_n); END IF;
  END LOOP;

  IF v_tong > 0 THEN
    RAISE EXCEPTION 'Còn % dòng NULL ở bảng chưa khai: %', v_tong, v_con;
  END IF;

  SELECT count(*) INTO v_n FROM pg_trigger t
   WHERE t.tgname = 'trg_autofill_org_strict' AND NOT t.tgisinternal;
  RAISE NOTICE 'Sạch dòng NULL. Trigger chặn đang gác % bảng.', v_n;
END
$nghiem_thu$;

COMMIT;
