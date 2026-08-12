-- =============================================================================
-- Chặn NULL organization_id — đợt ba: ai_usage_logs
--
-- Đợt ba trong hai ngày. Nhịp này tự nó là dữ kiện, nên ghi lại thay vì lặng lẽ
-- vá tiếp:
--
--   đợt 1 (20260811010000): 6 bảng, 24 dòng
--   đợt 2 (20260811020000): 3 bảng, 148 dòng — lộ ra NGAY sau đợt 1
--   đợt 3 (file này):       1 bảng, 5 dòng — nhật ký Copilot sinh trong lúc làm
--
-- Đây KHÔNG phải các đợt trước làm sót. Gate chỉ thấy được bảng ĐANG có dòng
-- NULL; bảng nào chưa kịp có dòng nào thì vô hình. Mỗi lần vá xong, thời gian
-- trôi thêm, và bảng khác kịp tích dòng mới.
--
-- ----------------------- VÌ SAO VẪN CHƯA GẮN DIỆN RỘNG ----------------------
-- Prod có 84 bảng vừa nhận được NULL vừa suy được org. Gắn hết một lượt sẽ chấm
-- dứt trò đuổi bắt này — nhưng app_private.autofill_org_strict() FAIL-CLOSED,
-- nên bảng nào có đường ghi KHÔNG mang user_id lẫn bảng cha sẽ bắt đầu NỔ thay
-- vì ghi. Với 84 bảng chưa đo từng cái, đó là đánh đổi một chỗ rò im lặng lấy
-- một chỗ hỏng ồn ào ở nơi chưa biết — và "ồn ào" ở đây nghĩa là người dùng
-- không lưu được dữ liệu.
--
-- Nên vẫn giữ lối cũ: vá theo BẰNG CHỨNG. Cái giá là còn vài đợt nữa; cái được
-- là mỗi trigger gắn lên một bảng đã biết chắc đường ghi của nó suy được org.
-- Việc gắn diện rộng đáng làm khi có thời gian đo từng đường ghi của 84 bảng —
-- đã ghi vào kế hoạch như việc còn lại, không phải việc bỏ quên.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

UPDATE public.ai_usage_logs t SET organization_id = m.org
  FROM (SELECT user_id, (array_agg(DISTINCT organization_id))[1] AS org
          FROM public.organization_memberships
         WHERE status = 'ACTIVE'
         GROUP BY user_id HAVING count(DISTINCT organization_id) = 1) m
 WHERE m.user_id = t.user_id AND t.organization_id IS NULL;

DROP TRIGGER IF EXISTS trg_autofill_org_strict ON public.ai_usage_logs;
CREATE TRIGGER trg_autofill_org_strict
  BEFORE INSERT ON public.ai_usage_logs
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
