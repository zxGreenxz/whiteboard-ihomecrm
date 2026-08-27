BEGIN;
-- ============================================================
-- building_fee_accounts: đặt lại trigger tự điền org KHÔNG cần dữ liệu
--
-- VÌ SAO CÓ FILE NÀY — nó vá một lỗ mà bài diễn tập khôi phục vừa chỉ ra.
--   20260827120000 (cùng ngày) backfill dòng rò rồi gắn public._autofill_org()
--   lên building_fee_accounts. Khối smoke của nó chèn THẬT một dòng thiếu org
--   để chứng minh trigger có điền — phép đo đó đòi một toà nhà có org, nên trên
--   BASELINE SCHEMA-ONLY (manifest.containsData=false) nó dừng với
--     "Smoke: không tìm được toà nhà có org để thử"
--   và CẢ FILE bị cuộn lại. Hệ quả: bản dựng lại từ baseline KHÔNG CÓ trigger.
--   Đo 27/08/2026 trên CI "Migration Restore Drill": 38 chạy sạch · 28 dừng
--   đúng kỳ vọng · 1 LỆCH — chính là file đó.
--
--   Khai 120000 vào forward-lane-expectations.json là ĐÚNG (nó thật sự khẳng
--   định trên dữ liệu), nhưng khai KHÔNG chữa được lỗ: sổ kỳ vọng chỉ nói
--   "dừng ở đây là bình thường", nó không dựng lại cái trigger đã mất. Luật
--   `luatThemEntry` trong chính sổ đó cấm khai entry chỉ để CI xanh. Nên file
--   này gánh phần hiệu ứng, còn sổ kỳ vọng gánh phần giải thích.
--
--   KHÔNG sửa thẳng 120000: nó đã apply lên production và evidence
--   (docs/generated/schema-change-evidence/…120000.json) ghim sha256 của đúng
--   bytes đã chạy. Sửa file là biến bằng chứng đó thành lời khai về một file
--   không còn tồn tại — phá đúng thứ kho evidence sinh ra để giữ.
--
-- KHÁC 120000 Ở ĐÂU: file này KHÔNG khẳng định gì trên dữ liệu. Backfill lọc
-- `IS NULL` (rỗng thì 0 dòng), trigger DROP IF EXISTS + CREATE, và phép kiểm
-- cuối chỉ soi catalog. Chạy sạch trên database rỗng lẫn database đầy.
--
-- Trên production đây là no-op: trigger đã có từ 120000, backfill không còn
-- dòng nào để chạm (đo sau 120000: con_thieu_org = 0).
-- ============================================================

-- Backfill lặp lại cho đường dựng-lại (trên prod đã 0 dòng).
UPDATE public.building_fee_accounts bfa
   SET organization_id = b.organization_id
  FROM public.buildings b
 WHERE bfa.building_id = b.id
   AND bfa.organization_id IS NULL
   AND b.organization_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_autofill_org ON public.building_fee_accounts;
CREATE TRIGGER trg_autofill_org
  BEFORE INSERT ON public.building_fee_accounts
  FOR EACH ROW EXECUTE FUNCTION public._autofill_org();

-- Kiểm bằng catalog, không bằng dữ liệu: đúng một trigger BEFORE INSERT gọi
-- _autofill_org trên bảng này.
DO $kiem$
DECLARE
  v_so integer;
BEGIN
  SELECT count(*) INTO v_so
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE t.tgrelid = 'public.building_fee_accounts'::regclass
    AND p.proname = '_autofill_org'
    AND NOT t.tgisinternal;

  IF v_so <> 1 THEN
    RAISE EXCEPTION 'Kỳ vọng đúng 1 trigger _autofill_org trên building_fee_accounts, đếm được %', v_so;
  END IF;
END
$kiem$;

COMMIT;
