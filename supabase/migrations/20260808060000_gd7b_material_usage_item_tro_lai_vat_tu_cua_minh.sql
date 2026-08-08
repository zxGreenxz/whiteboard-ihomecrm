-- =============================================================================
-- Trỏ lại dòng dùng vật tư của CÔNG TY THẬT về bản vật tư của chính mình
--
-- GĐ7 (20260808050000) dọn 35 tham chiếu chéo rồi tuyên bố "tách rời hoàn toàn".
-- Tuyên bố đó dựa trên một phép đo HẸP: khối $verify$ của file kia chỉ hỏi lại
-- đúng hai đường nó vừa sửa (building_services, jobs). Phép đo RỘNG — quét mọi
-- khoá ngoại giữa hai bảng đều có organization_id, nay nằm ở
-- scripts/org-split-prepared/01-chung-minh-tach-roi.sql — chạy lại chiều 08/08
-- thì ra 1 đường còn vi phạm:
--
--   material_usage_items.material_id -> materials
--
-- KHÔNG phải phép đo cũ sai. Đường này DO CHÍNH GĐ6 (20260808040000) sinh ra,
-- sau thời điểm đo:
--   • LƯỢT 2 của GĐ6 suy organization_id cho material_usages qua người dùng
--     (df8d1df5 chỉ thuộc một tổ chức → aaaa).
--   • LƯỢT 3 suy tiếp cho material_usage_items qua cha material_usages → aaaa.
--   • Nhưng material_id thì không ai đụng: nó vẫn trỏ sang "Pin 3A" của tổ chức
--     TEST (cccc). Trước GĐ6 dòng con mang organization_id NULL nên phép đo
--     không thể thấy nó; sau GĐ6 nó mang nhãn aaaa và thành vi phạm.
--
-- Đây là hình mẫu đáng nhớ: một bước VÁ nhãn có thể LỘ RA (và ở đây là tạo ra)
-- một vi phạm toàn vẹn ở chỗ khác. Điều kiện tiên quyết của việc xoá tổ chức
-- phải được đo LẠI ngay trước transaction xoá, không được tin vào lần đo cũ.
--
-- Dữ liệu cụ thể hôm nay:
--   material_usages MU-20260801-0001 "thay pin remote máy lạnh cho 202-1392qt",
--   org aaaa, ngày 01/08. Dòng con trỏ sang materials 948c2493… "Pin 3A" org cccc.
--   Công ty thật CÓ bản "Pin 3A" của chính mình: 3ced8ddd…, cùng code/unit/mô tả,
--   cùng avg_unit_cost 13175, cùng created_at — chỉ khác là đã xoá mềm 04/08,
--   tức lúc phát sinh lần dùng (01/08) nó vẫn đang sống. Trỏ lại bản này mới là
--   phục dựng đúng lịch sử; unit_cost_at_usage 13175 khớp nên KHÔNG đổi tiền.
--
-- VÌ SAO TRỎ LẠI CHỨ KHÔNG XOÁ: đây là lần dùng vật tư THẬT của công ty thật cho
-- một phòng thật. Xoá là mất chi phí đã ghi nhận. Cùng lý lẽ với 7 dòng jobs ở
-- GĐ7.
--
-- KHÔNG cần tắt guard nào: material_usage_items chỉ mang trigger tính lại
-- trg_mui_recompute (AFTER INSERT/UPDATE/DELETE), không có guard append-only /
-- immutable / freeze tài chính. Đã kiểm pg_trigger trước khi viết file này.
--
-- Viết TỔNG QUÁT chứ không hard-code một UUID: nếu tới lúc apply mà số dòng vi
-- phạm đã khác, file phải xử đúng theo dữ liệu lúc đó — hoặc DỪNG nếu không có
-- bản thay thế duy nhất.
-- =============================================================================

BEGIN;

DO $preflight$
DECLARE
  v_vi_pham   bigint;
  v_khong_the bigint;
  r           record;
BEGIN
  SELECT count(*) INTO v_vi_pham
    FROM public.material_usage_items c
    JOIN public.materials p ON p.id = c.material_id
   WHERE c.organization_id IS NOT NULL
     AND p.organization_id IS NOT NULL
     AND c.organization_id <> p.organization_id;

  IF v_vi_pham = 0 THEN
    RAISE NOTICE 'Không còn dòng material_usage_items trỏ chéo tổ chức — file này thành không-việc.';
    RETURN;
  END IF;

  RAISE NOTICE 'Có % dòng material_usage_items trỏ sang vật tư của tổ chức khác.', v_vi_pham;

  -- Bản thay thế phải TỒN TẠI và DUY NHẤT trong chính tổ chức của dòng con.
  -- Không duy nhất thì "trỏ lại" thành trỏ bừa — đúng chốt mà GĐ7 đã dùng cho
  -- job_types. Nhận diện bản song sinh bằng bộ ba code/name/unit đã chuẩn hoá.
  SELECT count(*) INTO v_khong_the
    FROM public.material_usage_items c
    JOIN public.materials p ON p.id = c.material_id
   WHERE c.organization_id IS NOT NULL
     AND p.organization_id IS NOT NULL
     AND c.organization_id <> p.organization_id
     AND (SELECT count(*) FROM public.materials m
           WHERE m.organization_id = c.organization_id
             AND lower(btrim(m.code)) IS NOT DISTINCT FROM lower(btrim(p.code))
             AND lower(btrim(m.name)) IS NOT DISTINCT FROM lower(btrim(p.name))
             AND lower(btrim(m.unit)) IS NOT DISTINCT FROM lower(btrim(p.unit))) <> 1;

  IF v_khong_the > 0 THEN
    FOR r IN
      SELECT c.id AS item_id, c.organization_id AS item_org,
             p.id AS mat_id, p.organization_id AS mat_org, p.code, p.name, p.unit
        FROM public.material_usage_items c
        JOIN public.materials p ON p.id = c.material_id
       WHERE c.organization_id IS NOT NULL
         AND p.organization_id IS NOT NULL
         AND c.organization_id <> p.organization_id
         AND (SELECT count(*) FROM public.materials m
               WHERE m.organization_id = c.organization_id
                 AND lower(btrim(m.code)) IS NOT DISTINCT FROM lower(btrim(p.code))
                 AND lower(btrim(m.name)) IS NOT DISTINCT FROM lower(btrim(p.name))
                 AND lower(btrim(m.unit)) IS NOT DISTINCT FROM lower(btrim(p.unit))) <> 1
    LOOP
      RAISE WARNING 'Không trỏ lại được: item % (org %) -> vật tư % "%" (org %).',
        r.item_id, r.item_org, r.mat_id, r.name, r.mat_org;
    END LOOP;
    RAISE EXCEPTION '% dòng không có bản vật tư thay thế DUY NHẤT trong tổ chức của mình — trỏ bừa còn tệ hơn để nguyên. DỪNG.', v_khong_the;
  END IF;
END
$preflight$;

DO $tro_lai$
DECLARE
  v_n         bigint;
  v_tien_truoc numeric;
  v_tien_sau   numeric;
BEGIN
  SELECT coalesce(sum(quantity * coalesce(unit_cost_at_usage, 0)), 0)
    INTO v_tien_truoc FROM public.material_usage_items;

  UPDATE public.material_usage_items c
     SET material_id = (
           SELECT m.id FROM public.materials m
            WHERE m.organization_id = c.organization_id
              AND lower(btrim(m.code)) IS NOT DISTINCT FROM lower(btrim(p.code))
              AND lower(btrim(m.name)) IS NOT DISTINCT FROM lower(btrim(p.name))
              AND lower(btrim(m.unit)) IS NOT DISTINCT FROM lower(btrim(p.unit)))
    FROM public.materials p
   WHERE p.id = c.material_id
     AND c.organization_id IS NOT NULL
     AND p.organization_id IS NOT NULL
     AND c.organization_id <> p.organization_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'Đã trỏ lại % dòng material_usage_items về vật tư của chính tổ chức mình.', v_n;

  -- Trỏ lại KHÔNG được làm đổi tiền đã ghi nhận. unit_cost_at_usage là giá
  -- ĐÓNG BĂNG tại thời điểm dùng, nó không được kéo theo material_id. Nếu tổng
  -- chi phí vật tư đổi thì trigger trg_mui_recompute (hoặc thứ gì khác) đang âm
  -- thầm viết lại sổ — nguy hiểm hơn cả tham chiếu treo mà file này đi vá.
  SELECT coalesce(sum(quantity * coalesce(unit_cost_at_usage, 0)), 0)
    INTO v_tien_sau FROM public.material_usage_items;
  IF v_tien_sau <> v_tien_truoc THEN
    RAISE EXCEPTION 'Tổng chi phí vật tư đổi từ % thành % sau khi trỏ lại — việc vá tham chiếu đã sửa sổ tiền. DỪNG.',
      v_tien_truoc, v_tien_sau;
  END IF;
  RAISE NOTICE 'Tổng chi phí vật tư giữ nguyên: %.', v_tien_sau;
END
$tro_lai$;

DO $verify$
DECLARE
  v_con bigint;
BEGIN
  SELECT count(*) INTO v_con
    FROM public.material_usage_items c
    JOIN public.materials p ON p.id = c.material_id
   WHERE c.organization_id IS NOT NULL
     AND p.organization_id IS NOT NULL
     AND c.organization_id <> p.organization_id;
  IF v_con > 0 THEN
    RAISE EXCEPTION 'Còn % dòng trỏ chéo tổ chức sau khi vá. DỪNG.', v_con;
  END IF;

  RAISE NOTICE 'material_usage_items -> materials đã hết trỏ chéo. Chạy lại scripts/org-split-prepared/01-chung-minh-tach-roi.sql để xác nhận TOÀN BỘ đồ thị.';
END
$verify$;

COMMIT;

-- =============================================================================
-- ROLLBACK: file này SỬA dữ liệu, không có đường lùi tự động.
-- Giá trị cũ trước khi apply (đo 08/08 chiều, để khôi phục tay nếu cần):
--   material_usage_items 5657131d-caae-4d27-be2a-e2b2ba993385
--     material_id CŨ = 948c2493-101c-4277-a18c-3b3d4bb872ab  (Pin 3A, org cccc)
--     material_id MỚI = 3ced8ddd-4000-4eb6-b677-28c834127ae5 (Pin 3A, org aaaa)
-- Ngoài ra khôi phục từ bản dump lane tự chụp ngay trước lúc apply — đường dẫn
-- ghi ở docs/generated/schema-change-evidence/.
-- =============================================================================
