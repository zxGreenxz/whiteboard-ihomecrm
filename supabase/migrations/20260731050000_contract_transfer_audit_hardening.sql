-- =====================================================================
-- Đợt 2 · Task 0 — KHOÁ AUDIT CHUYỂN PHÒNG (fail-closed cả HAI đường)
--
-- Step 0′ ĐÃ KIỂM (điều kiện tiên quyết của plan): grep toàn khối migration
-- 2026073010xxxx → 2026073028xxxx cho `pg_get_functiondef` — **KHÔNG** file nào
-- vá `transfer_room` hay `apply_contract_transfer` theo mẫu neo, nên
-- forward-redefine ở đây an toàn, không phá DO-block của Đợt 0–6.
--
-- HIỆN TRẠNG ĐO TRÊN PROD 30/07/2026 (không suy luận từ file):
--   contract_transfers: **3 dòng, tất cả COMPLETED/ROOM_CHANGE**, 0 dòng thiếu
--   old_room_id, 0 dòng thiếu move_out_date/move_in_date. Contract có
--   status='TRANSFERRED': **0**. Contract có parent_contract_id: **0**
--   ⇒ đường B (trigger) CHƯA TỪNG chạy. Đây là **forward-guard**, KHÔNG phải dọn dữ liệu.
--
-- BỐN LỖ ĐANG MỞ (đọc trực tiếp từ pg_proc, kèm hệ quả người dùng thấy):
--
--   1. AUDIT LÀ "BEST-EFFORT" ⇒ MẤT DẤU VẾT TRONG IM LẶNG. Khối INSERT
--      contract_transfers của transfer_room bọc `EXCEPTION WHEN OTHERS THEN NULL`
--      kèm chú thích "audit best-effort, không chặn nghiệp vụ". Nghĩa là: hợp đồng
--      ĐÃ chuyển sang phòng mới, phòng cũ ĐÃ thành AVAILABLE, phòng mới ĐÃ thành
--      OCCUPIED — mà **không có một dòng nào ghi lại việc đó**. Sau này không ai
--      trả lời được "khách ở phòng nào từ ngày nào", và mọi read model dựng trên
--      contract_transfers sẽ thiếu đoạn. Nay: audit ghi TRƯỚC, không bọc EXCEPTION,
--      lỗi audit ⇒ rollback toàn bộ.
--
--   2. KHÔNG KHOÁ HỢP ĐỒNG. `SELECT * INTO v_contract FROM contracts WHERE id=…`
--      không có `FOR UPDATE`, nên hai lần bấm chuyển phòng song song cùng đọc một
--      trạng thái rồi cùng ghi.
--
--   3. KIỂM PHÒNG ĐÍCH KHÔNG CÓ KHOÁ. `IF EXISTS (… room_id = p_new_room_id …
--      status IN ('ACTIVE','EXTENDED'))` là SELECT trần: HAI hợp đồng khác nhau
--      cùng chuyển vào MỘT phòng thì cả hai đều đọc "phòng trống" rồi cả hai đều
--      vào ⇒ một phòng hai hợp đồng đang hiệu lực. Nay: khoá tư vấn theo TỪNG
--      phòng, lấy theo thứ tự id tăng dần (chống deadlock chéo), rồi mới kiểm lại.
--
--   4. KHÔNG KIỂM PHẠM VI. Không có gì buộc phòng mới cùng TOÀ / cùng ORG với hợp
--      đồng ⇒ chuyển được sang toà khác, thậm chí org khác.
--
--   5. (Đường B) `apply_contract_transfer` GHI ĐÈ `start_date`/`end_date` của hợp
--      đồng bằng `NEW.new_start_date`/`new_end_date`. Đổi phòng KHÔNG được phép
--      đổi kỳ hạn hợp đồng — đó là sửa dữ liệu gốc. Nó còn đặt
--      `status='TRANSFERRED'` + `parent_contract_id=id` cho cả ROOM_CHANGE, khiến
--      một hợp đồng CÒN HIỆU LỰC biến mất khỏi mọi danh sách ACTIVE. Chính
--      transfer_room:87 chú thích là **cố ý né** trigger này bằng cách đặt
--      status='COMPLETED'. Nay chọn phương án (A) của plan Step 2b: giữ trigger
--      nhưng ép nó ghi audit ĐỦ và KHÔNG đụng kỳ hạn / KHÔNG đổi status cho
--      ROOM_CHANGE — để HAI đường sinh ra CÙNG một hình dạng dữ liệu.
--      (Không chọn (B) tắt trigger: nếu có UI nào đang cho duyệt DRAFT→APPROVED
--      thì tắt trigger biến hành động đó thành KHÔNG LÀM GÌ trong im lặng — tệ
--      hơn hiện tại.)
--
-- KHÔNG ĐỤNG TIỀN: file này không chạm income_expenses / items / accounts /
-- payments / invoices. Không backfill dòng transfer nào.
-- =====================================================================
BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.transfer_room(uuid,uuid,numeric,date,text)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu transfer_room/5 — chữ ký đã đổi? DỪNG, không vá mù.';
  END IF;
  IF to_regprocedure('public.apply_contract_transfer()') IS NULL THEN
    RAISE EXCEPTION 'Thiếu apply_contract_transfer() — DỪNG.';
  END IF;
  -- Trigger đường B phải còn đó, vì mục 2b dựa vào nó.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_proc p ON p.oid=t.tgfoid
     WHERE NOT t.tgisinternal AND c.relname='contract_transfers'
       AND p.proname='apply_contract_transfer'
  ) THEN
    RAISE EXCEPTION 'Không thấy trigger apply_contract_transfer trên contract_transfers. DỪNG.';
  END IF;
  -- Các cột mà audit bắt buộc phải có.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='contract_transfers'
       AND column_name IN ('old_room_id','new_room_id','move_out_date','move_in_date','transfer_date')
     GROUP BY table_name HAVING count(*) = 5
  ) THEN
    RAISE EXCEPTION 'contract_transfers thiếu cột audit bắt buộc. DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- 1. Index composite cho projection segments (Task 0 Step 5)
--    Đo trước: contract_transfers có 8 index nhưng KHÔNG có composite nào phủ
--    (contract_id, status, transfer_type, transfer_date, id) — đúng khoá mà
--    projection quét theo từng hợp đồng.
-- ─────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_transfers_contract_status_type_date
  ON public.contract_transfers (contract_id, status, transfer_type, transfer_date, id);

COMMENT ON INDEX public.idx_transfers_contract_status_type_date IS
  'Đợt 2 Task 0 Step 5: khoá quét của projection residence segments — theo hợp đồng, '
  'lọc status/transfer_type, xếp theo transfer_date rồi id (thứ tự ổn định).';

-- ─────────────────────────────────────────────────────────────────────
-- 2. public.transfer_room — FAIL-CLOSED
--    Giữ NGUYÊN chữ ký (uuid,uuid,numeric,date,text) → uuid, VOLATILE,
--    SECURITY DEFINER, và ACL (authenticated=X). CREATE OR REPLACE nên ACL không reset.
-- ─────────────────────────────────────────────────────────────────────
-- ⚠ PHẢI giữ NGUYÊN các DEFAULT của tham số. Bỏ default là Postgres từ chối
--   (42P13 "cannot remove parameter defaults from existing function") và bắt
--   DROP FUNCTION trước — mà DROP+CREATE thì hàm mới hứng default privileges
--   (án lệ đã ghi trong repo: anon/service_role tự được EXECUTE). Đã tự cắn lỗi
--   này một lần khi viết file: chữ ký thật là
--   (uuid, uuid, numeric DEFAULT NULL, date DEFAULT CURRENT_DATE, text DEFAULT NULL).
CREATE OR REPLACE FUNCTION public.transfer_room(
  p_contract_id    uuid,
  p_new_room_id    uuid,
  p_new_rent_price numeric DEFAULT NULL::numeric,
  p_transfer_date  date    DEFAULT CURRENT_DATE,
  p_notes          text    DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_contract   RECORD;
  v_old_room   uuid;
  v_old_bld    uuid;
  v_new_bld    uuid;
  v_new_org    uuid;
  v_lock_a     uuid;
  v_lock_b     uuid;
BEGIN
  -- 1) Quyền (giữ đúng như trước) -------------------------------------------
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  IF p_new_room_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu phòng mới';
  END IF;
  IF p_transfer_date IS NULL THEN
    -- Audit phải có mốc ngày, kẻo projection không dựng được đoạn.
    RAISE EXCEPTION 'Thiếu ngày chuyển phòng' USING ERRCODE = '22023';
  END IF;

  -- ══ KHOÁ PHÒNG TRƯỚC KHI ĐỌC ═══════════════════════════════════════
  -- Lỗ 3: kiểm "phòng đích còn trống" là SELECT trần nên hai hợp đồng cùng
  -- chuyển vào một phòng thì cả hai đều lọt. Khoá tư vấn theo TỪNG phòng và lấy
  -- theo THỨ TỰ ID TĂNG DẦN — hai phiên có chung một phòng sẽ xếp hàng, và không
  -- thể chờ chéo nhau (điều kiện đủ để tránh deadlock: mọi phiên khoá cùng thứ tự).
  -- Phải khoá TRƯỚC khi SELECT contract, vì phòng cũ chỉ biết được sau khi đọc
  -- contract ⇒ đọc contract "trần" một lần để lấy phòng cũ, khoá, rồi ĐỌC LẠI
  -- dưới FOR UPDATE và kiểm lại mọi tiền đề trên dữ liệu sau khoá.
  SELECT c.room_id INTO v_old_room
    FROM public.contracts c
   WHERE c.id = p_contract_id AND c.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;

  v_lock_a := LEAST(COALESCE(v_old_room, p_new_room_id), p_new_room_id);
  v_lock_b := GREATEST(COALESCE(v_old_room, p_new_room_id), p_new_room_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended('room:' || v_lock_a::text, 0));
  IF v_lock_b IS DISTINCT FROM v_lock_a THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
              pg_catalog.hashtextextended('room:' || v_lock_b::text, 0));
  END IF;

  -- Lỗ 2: nay khoá dòng hợp đồng. Đọc LẠI sau khoá phòng để thấy trạng thái mới
  -- nhất (phiên trước có thể vừa đổi room_id).
  SELECT * INTO v_contract
    FROM public.contracts
   WHERE id = p_contract_id AND deleted_at IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;
  v_old_room := v_contract.room_id;

  IF NOT (
    public.is_super_admin()
    OR (v_contract.room_id IS NOT NULL AND public.can_do_on_building(
          'contracts', 'edit',
          (SELECT building_id FROM public.rooms WHERE id = v_contract.room_id)))
  ) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên hợp đồng này' USING ERRCODE = '42501';
  END IF;

  -- 2) Tiền điều kiện — kiểm LẠI sau khoá ------------------------------------
  IF v_contract.status NOT IN ('ACTIVE', 'EXTENDED') THEN
    RAISE EXCEPTION 'Chỉ chuyển phòng được khi hợp đồng đang hiệu lực';
  END IF;
  IF p_new_room_id = v_contract.room_id THEN
    RAISE EXCEPTION 'Phòng mới trùng phòng hiện tại';
  END IF;

  -- Lỗ 4: phòng mới phải cùng TOÀ và cùng ORG với phòng hiện tại. Không có mệnh
  -- đề này thì chuyển được hợp đồng sang toà khác — kể cả tổ chức khác.
  SELECT r.building_id, b.organization_id INTO v_new_bld, v_new_org
    FROM public.rooms r
    LEFT JOIN public.buildings b ON b.id = r.building_id
   WHERE r.id = p_new_room_id AND r.deleted_at IS NULL;
  IF v_new_bld IS NULL THEN
    RAISE EXCEPTION 'Phòng mới không tồn tại';
  END IF;

  IF v_old_room IS NOT NULL THEN
    SELECT r.building_id INTO v_old_bld
      FROM public.rooms r WHERE r.id = v_old_room;
    IF v_old_bld IS DISTINCT FROM v_new_bld THEN
      RAISE EXCEPTION
        'Phòng mới thuộc toà khác — chuyển phòng chỉ trong cùng một toà. Muốn đổi toà thì thanh lý hợp đồng rồi tạo hợp đồng mới.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Kiểm phòng đích SAU KHI đã giữ khoá ⇒ kết quả không thể lỗi thời.
  IF EXISTS (
    SELECT 1 FROM public.contracts
     WHERE room_id = p_new_room_id
       AND id <> p_contract_id
       AND status IN ('ACTIVE','EXTENDED')
       AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Phòng mới đã có hợp đồng đang hiệu lực';
  END IF;

  -- 3) AUDIT TRƯỚC, KHÔNG BỌC EXCEPTION -------------------------------------
  -- Lỗ 1: trước đây khối này nằm CUỐI và bọc `EXCEPTION WHEN OTHERS THEN NULL`,
  -- nên chuyển phòng xong mà mất dấu vết là chuyện có thể xảy ra êm ru. Nay ghi
  -- TRƯỚC mọi tác dụng phụ: audit lỗi ⇒ chưa có gì bị đổi, cả transaction rollback.
  -- status='COMPLETED' để KHÔNG kích trigger đường B (giữ đúng ý định cũ).
  INSERT INTO public.contract_transfers (
    user_id, contract_id, transfer_type, transfer_date,
    old_room_id, new_room_id, new_rent_price,
    move_out_date, move_in_date, reason, notes, status, approved_at, approved_by
  ) VALUES (
    v_contract.user_id, p_contract_id, 'ROOM_CHANGE', p_transfer_date,
    v_old_room, p_new_room_id, p_new_rent_price,
    p_transfer_date, p_transfer_date, p_notes, p_notes, 'COMPLETED', NOW(), auth.uid()
  );

  -- 4) Chuyển phòng (GIỮ status ACTIVE/EXTENDED, KHÔNG đụng kỳ hạn) ----------
  UPDATE public.contracts
     SET room_id    = p_new_room_id,
         rent_price = COALESCE(p_new_rent_price, rent_price),
         notes      = CASE
                        WHEN p_notes IS NULL OR length(btrim(p_notes)) = 0 THEN notes
                        WHEN notes  IS NULL OR length(btrim(notes))  = 0 THEN p_notes
                        ELSE notes || E'\n[Chuyển phòng ' || to_char(p_transfer_date,'DD/MM/YYYY') || '] ' || p_notes
                      END,
         updated_at = NOW()
   WHERE id = p_contract_id;

  -- 5) Đồng bộ trạng thái phòng --------------------------------------------
  IF v_old_room IS NOT NULL AND v_old_room <> p_new_room_id THEN
    UPDATE public.rooms SET status = 'AVAILABLE', updated_at = NOW()
     WHERE id = v_old_room
       AND NOT EXISTS (
         SELECT 1 FROM public.contracts
          WHERE room_id = v_old_room
            AND id <> p_contract_id
            AND status IN ('ACTIVE','EXTENDED')
            AND deleted_at IS NULL
       );
  END IF;

  UPDATE public.rooms SET status = 'OCCUPIED', updated_at = NOW() WHERE id = p_new_room_id;

  RETURN p_contract_id;
END;
$function$;

COMMENT ON FUNCTION public.transfer_room(uuid,uuid,numeric,date,text) IS
  'Chuyển phòng trong CÙNG một toà, giữ hợp đồng ACTIVE/EXTENDED và KHÔNG đụng kỳ '
  'hạn. Đợt 2 Task 0: audit contract_transfers ghi TRƯỚC và KHÔNG bọc EXCEPTION '
  '(trước đây best-effort ⇒ chuyển phòng xong mà mất dấu vết trong im lặng); khoá '
  'dòng hợp đồng FOR UPDATE; khoá tư vấn theo từng phòng lấy theo thứ tự id tăng '
  'dần nên hai hợp đồng cùng vào một phòng phải xếp hàng và không chờ chéo; kiểm '
  'phòng mới cùng toà. status audit = COMPLETED để không kích trigger đường B.';

-- ─────────────────────────────────────────────────────────────────────
-- 3. public.apply_contract_transfer — ĐƯỜNG B, phương án (A) của plan Step 2b
--    Giữ trigger nhưng ép cùng hình dạng dữ liệu với đường A.
--    SECURITY INVOKER (giữ nguyên: prosecdef=false) — trigger phải soi quyền của
--    chính người gọi, không được nâng quyền.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.apply_contract_transfer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_old_bld uuid;
  v_new_bld uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' THEN

    IF NEW.transfer_type IN ('TENANT_CHANGE', 'BOTH_CHANGE') THEN
      RAISE EXCEPTION 'Nhượng hợp đồng phải đi qua RPC transfer_contract(); không duyệt tay contract_transfers (cột new_tenant_id nay là customers.id, không phải tenants.id)'
        USING ERRCODE = '55000';
    END IF;

    -- ══ FAIL-CLOSED: audit phải ĐỦ trước khi cho áp dụng ═══════════════
    -- Đường A luôn ghi đủ old_room_id/move_out_date/move_in_date. Đường B trước
    -- đây nhận bất cứ gì người duyệt để lại, nên có thể sinh ra dòng transfer
    -- thiếu mốc ⇒ projection segments không dựng được đoạn và phải báo
    -- SEGMENT_HISTORY_INCOMPLETE. Chặn tại gốc thì read model không bao giờ phải
    -- đoán. (Hôm nay 0 dòng đi đường này — đây là forward-guard.)
    IF NEW.transfer_type = 'ROOM_CHANGE' THEN
      IF NEW.new_room_id IS NULL THEN
        RAISE EXCEPTION 'Thiếu phòng mới (new_room_id) — không duyệt được phiếu chuyển phòng'
          USING ERRCODE = '22023';
      END IF;
      IF NEW.old_room_id IS NULL THEN
        RAISE EXCEPTION 'Thiếu phòng cũ (old_room_id) — audit chuyển phòng phải đủ hai đầu, nếu không thì không truy được khách ở phòng nào từ ngày nào'
          USING ERRCODE = '22023';
      END IF;
      IF COALESCE(NEW.move_out_date, NEW.transfer_date) IS NULL
         OR COALESCE(NEW.move_in_date, NEW.transfer_date) IS NULL THEN
        RAISE EXCEPTION 'Thiếu mốc ngày chuyển phòng (move_out_date/move_in_date hoặc transfer_date)'
          USING ERRCODE = '22023';
      END IF;

      -- Cùng toà — cùng mệnh đề như đường A, để hai đường không lệch luật.
      SELECT building_id INTO v_old_bld FROM public.rooms WHERE id = NEW.old_room_id;
      SELECT building_id INTO v_new_bld FROM public.rooms WHERE id = NEW.new_room_id;
      IF v_old_bld IS DISTINCT FROM v_new_bld THEN
        RAISE EXCEPTION 'Phòng mới thuộc toà khác — chuyển phòng chỉ trong cùng một toà'
          USING ERRCODE = '42501';
      END IF;

      -- Điền mốc còn trống bằng transfer_date để audit luôn đủ cột.
      NEW.move_out_date := COALESCE(NEW.move_out_date, NEW.transfer_date);
      NEW.move_in_date  := COALESCE(NEW.move_in_date,  NEW.transfer_date);
    END IF;

    -- ══ KHÔNG đụng kỳ hạn, KHÔNG đổi status hợp đồng ═══════════════════
    -- Trước đây khối này ghi đè start_date/end_date và đặt status='TRANSFERRED'
    -- + parent_contract_id=id cho CẢ ROOM_CHANGE. Đổi phòng KHÔNG phải nhượng
    -- hợp đồng: kỳ hạn không đổi, và hợp đồng vẫn CÒN HIỆU LỰC — đặt TRANSFERRED
    -- là làm nó biến mất khỏi mọi danh sách ACTIVE. Đường A (transfer_room) luôn
    -- giữ ACTIVE/EXTENDED; nay đường B giống hệt.
    UPDATE contracts
    SET
      room_id       = COALESCE(NEW.new_room_id, room_id),
      rent_price    = COALESCE(NEW.new_rent_price, rent_price),
      total_deposit = COALESCE(NEW.new_deposit, total_deposit),
      updated_at    = NOW()
    WHERE id = NEW.contract_id;

    IF NEW.old_room_id IS NOT NULL THEN
      UPDATE rooms
      SET status = 'AVAILABLE', updated_at = NOW()
      WHERE id = NEW.old_room_id
        AND NOT EXISTS (
          SELECT 1 FROM contracts
          WHERE room_id = NEW.old_room_id
            AND id != NEW.contract_id
            AND status IN ('ACTIVE','EXTENDED')
            AND deleted_at IS NULL
        );
    END IF;

    IF NEW.new_room_id IS NOT NULL THEN
      UPDATE rooms
      SET status = 'OCCUPIED', updated_at = NOW()
      WHERE id = NEW.new_room_id;
    END IF;

    IF NEW.new_services IS NOT NULL AND jsonb_array_length(NEW.new_services) > 0 THEN
      DELETE FROM contract_services WHERE contract_id = NEW.contract_id;

      INSERT INTO contract_services (contract_id, service_id, unit_price)
      SELECT
        NEW.contract_id,
        (service->>'service_id')::UUID,
        (service->>'unit_price')::DECIMAL(15,2)
      FROM jsonb_array_elements(NEW.new_services) AS service;
    END IF;

    NEW.approved_by := auth.uid();
    NEW.approved_at := NOW();
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.apply_contract_transfer() IS
  'Trigger đường B (duyệt tay contract_transfers DRAFT→APPROVED). Đợt 2 Task 0 '
  'phương án (A): fail-closed — ROOM_CHANGE phải đủ old_room_id/new_room_id/mốc '
  'ngày và cùng toà, nếu không thì từ chối duyệt; và KHÔNG còn ghi đè '
  'start_date/end_date, KHÔNG còn đặt status=TRANSFERRED/parent_contract_id cho '
  'ROOM_CHANGE (đổi phòng không phải nhượng hợp đồng — đặt TRANSFERRED là làm hợp '
  'đồng còn hiệu lực biến mất khỏi danh sách ACTIVE). Hai đường A/B nay sinh cùng '
  'một hình dạng dữ liệu để projection segments không phải đoán.';

-- ─────────────────────────────────────────────────────────────────────
-- 4. TỰ KIỂM
-- ─────────────────────────────────────────────────────────────────────
DO $selfcheck$
DECLARE
  v_code text;
BEGIN
  -- (a) transfer_room không được còn nuốt lỗi audit.
  SELECT lower(regexp_replace(p.prosrc, '--[^\n]*', '', 'g')) INTO v_code
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='transfer_room';
  IF v_code ~ 'exception\s+when\s+others\s+then\s+null' THEN
    RAISE EXCEPTION 'transfer_room VẪN nuốt lỗi audit (EXCEPTION WHEN OTHERS THEN NULL). DỪNG.';
  END IF;
  IF position('for update' IN v_code) = 0 THEN
    RAISE EXCEPTION 'transfer_room thiếu FOR UPDATE trên hợp đồng. DỪNG.';
  END IF;
  IF position('pg_advisory_xact_lock' IN v_code) = 0 THEN
    RAISE EXCEPTION 'transfer_room thiếu khoá tư vấn theo phòng. DỪNG.';
  END IF;
  IF position('insert into public.contract_transfers' IN v_code) = 0 THEN
    RAISE EXCEPTION 'transfer_room không còn ghi audit. DỪNG.';
  END IF;
  -- Audit phải nằm TRƯỚC câu UPDATE contracts (thứ tự quyết định tính fail-closed).
  IF position('insert into public.contract_transfers' IN v_code)
     > position('update public.contracts' IN v_code) THEN
    RAISE EXCEPTION 'transfer_room ghi audit SAU khi đổi hợp đồng — mất tính fail-closed. DỪNG.';
  END IF;

  -- (b) apply_contract_transfer không được đụng kỳ hạn / đặt TRANSFERRED.
  SELECT lower(regexp_replace(p.prosrc, '--[^\n]*', '', 'g')) INTO v_code
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='apply_contract_transfer';
  IF v_code ~ 'start_date\s*=' OR v_code ~ 'end_date\s*=' THEN
    RAISE EXCEPTION 'apply_contract_transfer VẪN ghi đè start_date/end_date. DỪNG.';
  END IF;
  IF position('''transferred''' IN v_code) > 0 THEN
    RAISE EXCEPTION 'apply_contract_transfer VẪN đặt status=TRANSFERRED. DỪNG.';
  END IF;
  IF position('parent_contract_id' IN v_code) > 0 THEN
    RAISE EXCEPTION 'apply_contract_transfer VẪN đặt parent_contract_id. DỪNG.';
  END IF;
  IF position('old_room_id is null' IN v_code) = 0 THEN
    RAISE EXCEPTION 'apply_contract_transfer chưa fail-closed khi thiếu old_room_id. DỪNG.';
  END IF;

  -- (c) ACL giữ nguyên: authenticated phải chạy được transfer_room.
  IF NOT has_function_privilege('authenticated','public.transfer_room(uuid,uuid,numeric,date,text)','EXECUTE') THEN
    RAISE EXCEPTION 'authenticated mất EXECUTE trên transfer_room. DỪNG.';
  END IF;
  IF has_function_privilege('anon','public.transfer_room(uuid,uuid,numeric,date,text)','EXECUTE') THEN
    RAISE EXCEPTION 'anon chạy được transfer_room — REVOKE. DỪNG.';
  END IF;

  -- (d) Index composite phải có.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='contract_transfers'
       AND indexname='idx_transfers_contract_status_type_date'
  ) THEN
    RAISE EXCEPTION 'Thiếu index composite cho projection segments. DỪNG.';
  END IF;

  -- (e) transfer_room phải VOLATILE (nó lấy khoá dòng — án lệ 25006).
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='transfer_room' AND p.provolatile <> 'v'
  ) THEN
    RAISE EXCEPTION 'transfer_room phải VOLATILE. DỪNG.';
  END IF;
END
$selfcheck$;

COMMIT;
