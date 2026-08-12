-- =============================================================================
-- Chặn NULL organization_id — đợt bốn: room_pass_listings
--
-- Đợt 4 trong ba ngày, và nhịp vẫn đúng như đợt ba đã dự báo:
--
--   đợt 1 (20260811010000): 6 bảng, 24 dòng
--   đợt 2 (20260811020000): 3 bảng, 148 dòng — lộ ra NGAY sau đợt 1
--   đợt 3 (20260811060000): 1 bảng, 5 dòng   — nhật ký Copilot sinh trong lúc làm
--   đợt 4 (file này):       1 bảng, 2 dòng   — tin đăng pass phòng, sinh 12/08
--
-- Vẫn KHÔNG phải đợt trước làm sót. Bảng này có ĐÚNG 2 dòng, cả hai tạo lúc
-- 12/08 05:32 UTC — tức là sau khi đợt 3 chạy xong. Gate chỉ thấy bảng ĐANG có
-- dòng NULL; một bảng chưa có dòng nào thì vô hình với nó.
--
-- CÁCH NÓ LỘ RA, đáng ghi vì nó là bài học về thứ tự cửa chặn
--   Cửa `check-forward-migration-idempotent` mới bắt được, và chỉ bắt được HÔM
--   NAY. Nó dán thân migration hai lần rồi ROLLBACK, nên lần dán thứ hai chạy
--   lại khối nghiệm thu của đợt 3 và khối đó đếm được 2 dòng mới. Nhưng cửa này
--   nằm SAU bước "Approver provenance" trong cùng job `security-gates`, mà bước
--   đó đang đỏ vì phiếu bàn giao tiền thiếu system_source — GitHub Actions dừng
--   job ở bước hỏng đầu tiên, nên cửa idempotent CHƯA TỪNG CHẠY kể từ khi 2 dòng
--   này xuất hiện. Sửa xong lỗi đứng trước mới nhìn thấy lỗi đứng sau.
--
--   Nói cách khác: một job nhiều bước che giấu số lỗi thật của nó. Con số "1 job
--   đỏ" không bao giờ có nghĩa là "1 lỗi".
--
-- VÌ SAO CHỌN rooms LÀM NGUỒN
--   app_private.autofill_org_strict() suy org theo thứ tự bảng cha rồi tới cột
--   người; với bảng này nó có tới ba đường (room_id → rooms, building_id →
--   buildings, user_id → memberships). Đã đối chiếu cả hai đường cha cho đúng 2
--   dòng đang NULL: cùng trả về "iHome CRM". Hai nguồn độc lập đồng ý thì phép
--   vá không phải là phỏng đoán. Câu UPDATE dưới đây đi qua rooms và bỏ qua dòng
--   nào không suy được, nên nó không bao giờ đoán bừa; khối nghiệm thu cuối file
--   sẽ ngã nếu còn sót.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

UPDATE public.room_pass_listings t SET organization_id = r.organization_id
  FROM public.rooms r
 WHERE r.id = t.room_id
   AND t.organization_id IS NULL
   AND r.organization_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_autofill_org_strict ON public.room_pass_listings;
CREATE TRIGGER trg_autofill_org_strict
  BEFORE INSERT ON public.room_pass_listings
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
