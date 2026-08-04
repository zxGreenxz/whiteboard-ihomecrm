-- =====================================================================
-- Đợt 2 · Task 0 Steps 3–5 — RESIDENCE SEGMENTS (chỉ đọc, fail-closed)
--
-- Trả lời câu hỏi mà hôm nay hệ thống KHÔNG trả lời được:
--   "hợp đồng này ở phòng nào, từ ngày nào đến ngày nào?"
-- Hôm nay `contracts.room_id` chỉ cho biết phòng HIỆN TẠI; lịch sử nằm rải trong
-- `contract_transfers` và chưa ai dựng thành đoạn.
--
-- ⚠ ĐÍNH CHÍNH DẤU HIỆU NHẬN ĐƯỜNG B so với plan Step 3: plan viết dấu hiệu là
--   `contracts.status='TRANSFERRED'` + `parent_contract_id` + transfer APPROVED.
--   Nhưng migration 20260731050000 (cùng đợt, chạy TRƯỚC file này) đã BỎ việc
--   đặt TRANSFERRED/parent_contract_id cho ROOM_CHANGE — vì đổi phòng không phải
--   nhượng hợp đồng. Nên dấu hiệu đó GIỜ KHÔNG CÒN ĐÚNG cho dòng mới.
--   Phân biệt hai đường bằng `contract_transfers.status`:
--       'COMPLETED' ⇒ source_path='TRANSFER_ROOM_COMPLETED'  (đường A, RPC)
--       'APPROVED'  ⇒ source_path='TRIGGER_APPROVED'          (đường B, duyệt tay)
--   Vẫn giữ nhận diện TRANSFERRED/parent như BẰNG CHỨNG CÓ TRANSFER cho dữ liệu
--   lịch sử (hôm nay 0 dòng, nhưng đường code từng sống).
--
-- NGUYÊN TẮC "KHÔNG FALLBACK IM LẶNG" (Step 4): thà nói KHÔNG BIẾT hơn là đoán.
--   • Mốc đầu đoạn thứ nhất chỉ lấy `contracts.start_date` khi hợp đồng KHÔNG có
--     transfer nào VÀ status <> 'TRANSFERRED' VÀ parent_contract_id IS NULL.
--     Lý do bỏ giả định này ở ca khác: `start_date` ĐÚNG LÀ cột mà trigger đường B
--     từng ghi đè, nên với hợp đồng có transfer thì nó không đáng tin.
--     Khi không đáng tin ⇒ `from_date = NULL` (= "chưa biết mốc bắt đầu"), KHÔNG
--     bịa ngày.
--   • Chuỗi có mâu thuẫn ⇒ `trusted=false` cho TOÀN BỘ đoạn của hợp đồng đó, kèm
--     `diagnostic`. Không trả nửa tin nửa không, kẻo phía gọi dùng phần "trông ổn".
--
-- Khoảng dùng [from, to) — nửa mở. `to_date IS NULL` = đang còn ở.
-- Thứ tự ổn định: (eff_in, transfer_date, id) — hai transfer cùng ngày vẫn cho ra
-- cùng một kết quả mọi lần chạy.
--
-- KHÔNG ĐỤNG TIỀN: file chỉ CREATE hai hàm SELECT. Không DML.
-- =====================================================================
BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.transfer_room(uuid,uuid,numeric,date,text)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu transfer_room — chạy 20260731050000 trước. DỪNG.';
  END IF;
  -- File này dựa vào việc 050000 đã bỏ TRANSFERRED cho ROOM_CHANGE (xem đính chính
  -- ở đầu file). Nếu chưa, dấu hiệu nhận đường B sẽ sai.
  IF (SELECT position('''transferred''' IN lower(regexp_replace(p.prosrc,'--[^\n]*','','g'))) > 0
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='apply_contract_transfer') THEN
    RAISE EXCEPTION
      'apply_contract_transfer vẫn đặt status=TRANSFERRED — 20260731050000 chưa apply. DỪNG.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='contract_transfers'
       AND indexname='idx_transfers_contract_status_type_date'
  ) THEN
    RAISE EXCEPTION 'Thiếu index composite — chạy 20260731050000 trước. DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- get_room_residence_segments_v1
--
-- VOLATILE: gọi can_access_building/ie_all_buildings_scope, mà nhánh authz trong
-- repo này có thể lấy khoá dòng ⇒ khai STABLE là ăn 25006 qua PostgREST (án lệ 5 lần).
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_room_residence_segments_v1(
  p_contract_ids uuid[] DEFAULT NULL
)
 RETURNS TABLE (
   contract_id     uuid,
   contract_number text,
   seg_index       int,
   room_id         uuid,
   room_name       text,
   from_date       date,     -- bao gồm; NULL = chưa biết mốc bắt đầu
   to_date         date,     -- KHÔNG bao gồm; NULL = đang còn ở
   source_path     text,     -- ai sinh ra bước chuyển VÀO đoạn này
   transfer_id     uuid,
   trusted         boolean,  -- false ⇒ đừng dùng chuỗi này để tính tiền
   diagnostic      text
 )
 LANGUAGE sql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH c AS (
    SELECT ct.id, ct.contract_number, ct.room_id AS cur_room,
           ct.start_date, ct.status::text AS c_status, ct.parent_contract_id
      FROM contracts ct
      LEFT JOIN rooms r ON r.id = ct.room_id
     WHERE ct.deleted_at IS NULL
       AND (p_contract_ids IS NULL OR ct.id = ANY(p_contract_ids))
       -- Cổng quyền: không có quyền trên toà ⇒ không thấy gì. Segments là tiện
       -- ích đọc, KHÔNG được thành kênh soi lịch sử toà mình không được xem.
       AND (r.building_id IS NULL
         OR public.can_access_building(r.building_id)
         OR public.ie_all_buildings_scope(r.building_id)
         OR public.is_admin() OR public.is_super_admin())
  ),
  -- Bước chuyển hợp lệ. CỐ Ý loại TENANT_CHANGE (đổi người, không đổi phòng),
  -- DRAFT (chưa duyệt) và CANCELLED (đã bỏ) — chúng KHÔNG cắt đoạn phòng.
  t AS (
    SELECT tr.contract_id,
           tr.id            AS transfer_id,
           tr.old_room_id,
           tr.new_room_id,
           COALESCE(tr.move_out_date, tr.transfer_date) AS eff_out,
           COALESCE(tr.move_in_date,  tr.transfer_date) AS eff_in,
           tr.transfer_date,
           CASE tr.status WHEN 'COMPLETED' THEN 'TRANSFER_ROOM_COMPLETED'
                          WHEN 'APPROVED'  THEN 'TRIGGER_APPROVED'
                          ELSE 'UNKNOWN' END AS source_path,
           row_number() OVER (PARTITION BY tr.contract_id
                              ORDER BY COALESCE(tr.move_in_date, tr.transfer_date),
                                       tr.transfer_date, tr.id) AS rn,
           count(*)    OVER (PARTITION BY tr.contract_id) AS n_tr
      FROM contract_transfers tr
      JOIN c ON c.id = tr.contract_id
     WHERE tr.transfer_type IN ('ROOM_CHANGE','BOTH_CHANGE')
       AND tr.status IN ('COMPLETED','APPROVED')
  ),
  -- Chẩn đoán ở mức HỢP ĐỒNG. Bất kỳ mâu thuẫn nào ⇒ cả chuỗi mất tin cậy.
  diag AS (
    SELECT c.id AS contract_id,
           CASE
             -- Có bằng chứng từng chuyển (dữ liệu lịch sử đường B) mà không có dòng nào
             WHEN (c.c_status = 'TRANSFERRED' OR c.parent_contract_id IS NOT NULL)
                  AND NOT EXISTS (SELECT 1 FROM t WHERE t.contract_id = c.id)
               THEN 'SEGMENT_HISTORY_INCOMPLETE: hợp đồng mang dấu vết đã chuyển (status/parent) nhưng không có dòng contract_transfers nào'
             -- Bước chuyển đầu tiên thiếu phòng cũ ⇒ không neo được đoạn đầu
             WHEN EXISTS (SELECT 1 FROM t WHERE t.contract_id=c.id AND t.rn=1 AND t.old_room_id IS NULL)
               THEN 'SEGMENT_HISTORY_INCOMPLETE: bước chuyển đầu tiên thiếu old_room_id'
             -- Thiếu mốc ngày
             WHEN EXISTS (SELECT 1 FROM t WHERE t.contract_id=c.id
                            AND (t.eff_in IS NULL OR t.eff_out IS NULL))
               THEN 'SEGMENT_HISTORY_INCOMPLETE: có bước chuyển thiếu mốc ngày (move_in/move_out/transfer_date đều rỗng)'
             -- Thiếu phòng mới
             WHEN EXISTS (SELECT 1 FROM t WHERE t.contract_id=c.id AND t.new_room_id IS NULL)
               THEN 'SEGMENT_HISTORY_INCOMPLETE: có bước chuyển thiếu new_room_id'
             -- ⚠ THỨ TỰ HAI PHÉP KIỂM DƯỚI ĐÂY LÀ CÓ CHỦ Ý — tôi từng để ngược và
             -- test bắt được: khi hai bước chuyển TRÙNG NGÀY hiệu lực thì
             -- row_number() xếp chúng theo `(eff_in, transfer_date, id)`, mà id là
             -- tuỳ ý ⇒ THỨ TỰ đã không đáng tin. Mọi kết luận của phép kiểm
             -- "chuỗi có nối" đều dựa trên thứ tự đó, nên nếu chạy trước nó sẽ báo
             -- "chuỗi không nối" — đúng là AMBIGUOUS nhưng SAI NGUYÊN NHÂN, khiến
             -- người rà tay đi tìm lỗi nối trong khi lỗi thật là trùng ngày.
             -- Chẩn đoán gốc phải nói trước.
             WHEN EXISTS (
               SELECT 1 FROM t a JOIN t b
                 ON b.contract_id=a.contract_id AND b.transfer_id <> a.transfer_id
                AND b.eff_in = a.eff_in
                WHERE a.contract_id=c.id)
               THEN 'SEGMENT_HISTORY_AMBIGUOUS: hai bước chuyển cùng ngày hiệu lực — không xác định được thứ tự'
             -- Chuỗi không nối: phòng cũ của bước n phải là phòng mới của bước n−1
             WHEN EXISTS (
               SELECT 1 FROM t a JOIN t b ON b.contract_id=a.contract_id AND b.rn=a.rn-1
                WHERE a.contract_id=c.id AND a.old_room_id IS DISTINCT FROM b.new_room_id)
               THEN 'SEGMENT_HISTORY_AMBIGUOUS: chuỗi chuyển phòng không nối (phòng cũ của bước sau khác phòng mới của bước trước)'
             -- Phòng hiện tại phải bằng phòng mới của bước cuối
             WHEN EXISTS (SELECT 1 FROM t WHERE t.contract_id=c.id)
                  AND c.cur_room IS DISTINCT FROM
                      (SELECT t2.new_room_id FROM t t2
                        WHERE t2.contract_id=c.id ORDER BY t2.rn DESC LIMIT 1)
               THEN 'SEGMENT_HISTORY_AMBIGUOUS: contracts.room_id không khớp phòng cuối chuỗi chuyển'
             ELSE NULL
           END AS diagnostic
      FROM c
  ),
  -- Đoạn ĐẦU = phòng cũ của bước chuyển thứ nhất; nếu không có transfer thì là
  -- phòng hiện tại.
  head AS (
    SELECT c.id AS contract_id, c.contract_number, 0 AS seg_index,
           COALESCE((SELECT t.old_room_id FROM t WHERE t.contract_id=c.id AND t.rn=1),
                    c.cur_room) AS room_id,
           -- Step 4: CHỈ tin start_date khi hợp đồng không có transfer và không
           -- mang dấu vết đã chuyển. Ngược lại trả NULL = "chưa biết", KHÔNG bịa.
           CASE WHEN NOT EXISTS (SELECT 1 FROM t WHERE t.contract_id=c.id)
                     AND c.c_status <> 'TRANSFERRED'
                     AND c.parent_contract_id IS NULL
                THEN c.start_date ELSE NULL END AS from_date,
           (SELECT t.eff_out FROM t WHERE t.contract_id=c.id AND t.rn=1) AS to_date,
           'CONTRACT_START'::text AS source_path,
           NULL::uuid AS transfer_id
      FROM c
  ),
  -- Mỗi bước chuyển mở một đoạn mới ở phòng mới.
  tail AS (
    SELECT t.contract_id, c.contract_number, t.rn::int AS seg_index,
           t.new_room_id AS room_id,
           t.eff_in AS from_date,
           (SELECT n.eff_out FROM t n
             WHERE n.contract_id=t.contract_id AND n.rn=t.rn+1) AS to_date,
           t.source_path, t.transfer_id
      FROM t JOIN c ON c.id = t.contract_id
  ),
  allseg AS (SELECT * FROM head UNION ALL SELECT * FROM tail)
  SELECT s.contract_id, s.contract_number, s.seg_index, s.room_id,
         r.name AS room_name, s.from_date, s.to_date, s.source_path, s.transfer_id,
         (d.diagnostic IS NULL) AS trusted,
         d.diagnostic
    FROM allseg s
    JOIN diag d ON d.contract_id = s.contract_id
    LEFT JOIN rooms r ON r.id = s.room_id
   ORDER BY s.contract_number NULLS LAST, s.contract_id, s.seg_index;
$function$;

REVOKE ALL ON FUNCTION public.get_room_residence_segments_v1(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_room_residence_segments_v1(uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_room_residence_segments_v1(uuid[]) IS
  'Đợt 2 Task 0 Steps 3–4: dựng đoạn cư trú [from,to) theo phòng cho từng hợp đồng '
  'từ contract_transfers, phủ CẢ hai đường (status COMPLETED = RPC transfer_room, '
  'APPROVED = duyệt tay qua trigger). KHÔNG fallback im lặng: chỉ tin '
  'contracts.start_date khi hợp đồng không có transfer và không mang dấu vết đã '
  'chuyển (start_date đúng là cột trigger đường B từng ghi đè), ngược lại from_date '
  'NULL = chưa biết. Mọi mâu thuẫn chuỗi ⇒ trusted=false cho TOÀN BỘ đoạn của hợp '
  'đồng đó kèm diagnostic INCOMPLETE/AMBIGUOUS — không trả nửa tin nửa không. '
  'Lọc theo quyền toà. VOLATILE vì nhánh authz có thể lấy khoá dòng.';

-- ─────────────────────────────────────────────────────────────────────
-- get_room_residence_conflicts_v1 — chỉ những hợp đồng KHÔNG tin được
-- (để có một chỗ soi nhanh thay vì lọc tay trên bảng đoạn)
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_room_residence_conflicts_v1(
  p_contract_ids uuid[] DEFAULT NULL
)
 RETURNS TABLE (
   contract_id     uuid,
   contract_number text,
   diagnostic      text,
   seg_count       int
 )
 LANGUAGE sql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT s.contract_id, s.contract_number, min(s.diagnostic), count(*)::int
    FROM public.get_room_residence_segments_v1(p_contract_ids) s
   WHERE NOT s.trusted
   GROUP BY s.contract_id, s.contract_number
   ORDER BY s.contract_number NULLS LAST;
$function$;

REVOKE ALL ON FUNCTION public.get_room_residence_conflicts_v1(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_room_residence_conflicts_v1(uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_room_residence_conflicts_v1(uuid[]) IS
  'Đợt 2 Task 0: chỉ liệt kê hợp đồng có chuỗi cư trú KHÔNG tin được, kèm lý do. '
  'Dùng để rà tay; production 30/07/2026 phải trả 0 dòng (3/3 transfer đều đủ).';

DO $selfcheck$
BEGIN
  IF NOT has_function_privilege('authenticated','public.get_room_residence_segments_v1(uuid[])','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.get_room_residence_conflicts_v1(uuid[])','EXECUTE') THEN
    RAISE EXCEPTION 'authenticated không chạy được hàm segments. DỪNG.';
  END IF;
  IF has_function_privilege('anon','public.get_room_residence_segments_v1(uuid[])','EXECUTE')
     OR has_function_privilege('anon','public.get_room_residence_conflicts_v1(uuid[])','EXECUTE') THEN
    RAISE EXCEPTION 'anon chạy được hàm segments — REVOKE. DỪNG.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname IN ('get_room_residence_segments_v1','get_room_residence_conflicts_v1')
       AND p.provolatile <> 'v'
  ) THEN
    RAISE EXCEPTION 'Hàm segments phải VOLATILE (án lệ 25006). DỪNG.';
  END IF;
END
$selfcheck$;

COMMIT;
