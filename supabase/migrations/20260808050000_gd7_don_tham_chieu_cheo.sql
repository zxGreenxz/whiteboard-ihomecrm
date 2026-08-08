-- =============================================================================
-- Dọn 35 dòng của CÔNG TY THẬT đang trỏ sang dữ liệu Test/Demo
--
-- Đây là mặt GHI của lỗ rò đã vá ở GĐ0–GĐ5, đọng lại thành dữ liệu hỏng. Khi RLS
-- còn cho thấy dữ liệu công ty khác thì người dùng chọn nhầm và hệ thống ghi
-- nhận bình thường — vá phía đọc không tự dọn phần đã ghi.
--
-- Phát hiện ra chúng nhờ một phép kiểm tra khác: trước khi xoá hai tổ chức
-- Test/Demo phải chứng minh chúng KHÔNG bị dữ liệu công ty thật tham chiếu tới.
-- Phép đó thất bại với đúng 35 dòng. Nếu bỏ qua và cứ xoá — mà xoá thì bắt buộc
-- phải tắt FK trigger để vượt ~60 guard append-only — thì 35 dòng này sẽ KHÔNG
-- báo lỗi, chỉ lặng lẽ thành tham chiếu treo trong sổ sách công ty thật.
--
-- HAI BẢN CHẤT KHÁC NHAU, HAI CÁCH XỬ LÝ KHÁC NHAU:
--
-- (1) 28 dòng building_services — XOÁ.
--     7 toà nhà THẬT (102LVT, 15KV, 403PVB, 405PVB, 44TL, 481NVK, 512TT) bị gắn
--     thêm 4 dịch vụ "DEMO Điện / DEMO Nước / DEMO Rác / DEMO Giữ Xe" của tổ
--     chức DEMO. Đo được: các toà này ĐÃ có hệ dịch vụ thật riêng (Điện - AG,
--     Điện 3K1, Điện MB403, Nước… mỗi cái 18–20 toà đang dùng), và **0 hợp đồng
--     nào chảy qua dịch vụ DEMO**. Đây là cấu hình thừa gắn chồng, không phải
--     cấu hình đang vận hành — bỏ đi không mất gì.
--
-- (2) 7 dòng jobs — TRỎ LẠI, không xoá.
--     Chúng trỏ tới job_type tên "sửa" của tổ chức khác, mà công ty thật có sẵn
--     một loại trùng tên. Đây là việc THẬT của công ty thật, chỉ gắn nhầm nhãn
--     loại — xoá là mất việc, trỏ lại mới đúng.
--
-- Gộp hai thứ này làm một sẽ hoặc xoá mất việc thật, hoặc giữ lại rác.
-- =============================================================================

BEGIN;

DO $preflight$
DECLARE
  v_hd    bigint;
  v_loai  bigint;
BEGIN
  -- 28 dòng kia chỉ vô hại CHỪNG NÀO không hợp đồng nào chảy qua chúng. Số này
  -- đo được là 0 lúc 08/08; nếu nó đổi giữa lúc đo và lúc chạy thì xoá là cắt
  -- dịch vụ đang tính tiền của khách.
  --
  -- Phải có CẢ HAI vế. Bản đầu chỉ hỏi "dịch vụ thuộc org khác aaaa" và đếm ra
  -- 244 — nhưng đó là hợp đồng CỦA CHÍNH Test/Demo dùng dịch vụ của chính họ,
  -- hoàn toàn bình thường. Chốt nổ đúng lúc nhưng vì câu hỏi sai, không phải vì
  -- dữ liệu sai. Thứ cần hỏi là: hợp đồng CỦA CÔNG TY THẬT có dùng dịch vụ của
  -- tổ chức khác không.
  SELECT count(*) INTO v_hd
    FROM public.contract_services c
    JOIN public.services s ON s.id = c.service_id
   WHERE c.organization_id = 'aaaa0000-0000-4000-8000-000000000001'
     AND s.organization_id <> 'aaaa0000-0000-4000-8000-000000000001';
  IF v_hd > 0 THEN
    RAISE EXCEPTION 'Có % hợp đồng CỦA CÔNG TY THẬT đang dùng dịch vụ của tổ chức khác — xoá cấu hình lúc này là cắt dịch vụ đang tính tiền. DỪNG.', v_hd;
  END IF;

  -- Loại việc thay thế phải tồn tại và DUY NHẤT. Hai bản trùng tên thì "trỏ lại"
  -- thành trỏ bừa.
  SELECT count(*) INTO v_loai
    FROM public.job_types t
   WHERE t.organization_id = 'aaaa0000-0000-4000-8000-000000000001'
     AND lower(btrim(t.name)) = 'sửa';
  IF v_loai <> 1 THEN
    RAISE EXCEPTION 'Công ty thật có % loại việc tên "sửa" (cần đúng 1) — không trỏ lại an toàn được. DỪNG.', v_loai;
  END IF;
END
$preflight$;

DO $don$
DECLARE
  v_n bigint;
BEGIN
  -- (1) XOÁ cấu hình dịch vụ thừa.
  DELETE FROM public.building_services bs
   USING public.services s
   WHERE s.id = bs.service_id
     AND bs.organization_id = 'aaaa0000-0000-4000-8000-000000000001'
     AND s.organization_id <> 'aaaa0000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'Đã xoá % dòng building_services trỏ sang dịch vụ tổ chức khác.', v_n;

  -- (2) TRỎ LẠI việc thật về loại việc của chính công ty mình.
  UPDATE public.jobs j
     SET job_type_id = (SELECT t.id FROM public.job_types t
                         WHERE t.organization_id = 'aaaa0000-0000-4000-8000-000000000001'
                           AND lower(btrim(t.name)) = 'sửa')
    FROM public.job_types cu
   WHERE cu.id = j.job_type_id
     AND j.organization_id = 'aaaa0000-0000-4000-8000-000000000001'
     AND cu.organization_id <> 'aaaa0000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'Đã trỏ lại % dòng jobs về loại việc của công ty thật.', v_n;
END
$don$;

DO $verify$
DECLARE
  v_bs bigint;
  v_jb bigint;
BEGIN
  SELECT count(*) INTO v_bs
    FROM public.building_services bs JOIN public.services s ON s.id = bs.service_id
   WHERE bs.organization_id = 'aaaa0000-0000-4000-8000-000000000001'
     AND s.organization_id <> 'aaaa0000-0000-4000-8000-000000000001';

  SELECT count(*) INTO v_jb
    FROM public.jobs j JOIN public.job_types t ON t.id = j.job_type_id
   WHERE j.organization_id = 'aaaa0000-0000-4000-8000-000000000001'
     AND t.organization_id <> 'aaaa0000-0000-4000-8000-000000000001';

  IF v_bs > 0 OR v_jb > 0 THEN
    RAISE EXCEPTION 'Còn tham chiếu chéo: building_services %, jobs %. DỪNG.', v_bs, v_jb;
  END IF;

  RAISE NOTICE 'Hai đường tham chiếu chéo đã về 0 — hai tổ chức Test/Demo giờ tách rời được.';
END
$verify$;

COMMIT;

-- =============================================================================
-- ROLLBACK: file này XOÁ và SỬA dữ liệu, không có đường lùi tự động.
-- Khôi phục từ bản dump mà lane tự chụp ngay trước lúc apply — đường dẫn ghi ở
-- docs/generated/schema-change-evidence/.
-- =============================================================================
