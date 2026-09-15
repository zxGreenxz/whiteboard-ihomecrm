-- P1 — update_room_status_on_contract_change() cập nhật phòng "hụt" trong im lặng.
--
-- HIỆN TRẠNG (đọc thân hàm thật trên production 15/09/2026, oid 110276):
--   Trigger AFTER INSERT OR UPDATE trên contracts, chạy QUYỀN NGƯỜI GỌI
--   (prosecdef = false, proconfig = NULL). Thân hàm `UPDATE rooms SET status = …`
--   nên phải đi qua RLS của rooms. Người gọi không sửa được dòng rooms đó thì
--   UPDATE khớp 0 dòng, plpgsql KHÔNG coi đó là lỗi, trigger trả về bình thường
--   và hợp đồng vẫn ghi — chỉ có trạng thái phòng là sai, không ai biết.
--
--   Đường TẠO hợp đồng hiện an toàn vì `create_contract_v2` tự
--   `UPDATE rooms SET status='OCCUPIED'` trong thân nó. Đường UPDATE trạng thái
--   (thanh lý, chuyển phòng, đổi trạng thái tay) thì KHÔNG có lưới đỡ nào.
--
-- SỬA:
--   1. SECURITY DEFINER + `SET search_path = pg_catalog, public`. Chủ hàm là
--      postgres (rolbypassrls = true, rooms không FORCE ROW LEVEL SECURITY) nên
--      cập nhật trạng thái phòng không còn phụ thuộc RLS của người gõ.
--      Đây là trạng thái SUY RA từ hợp đồng, không phải dữ liệu người dùng nhập:
--      ai được ghi hợp đồng thì hệ quả của hợp đồng đó phải được ghi trọn.
--      Ranh giới công ty vẫn nguyên: muốn chạm được phòng thì phải chèn/sửa được
--      hợp đồng trỏ tới phòng đó, mà việc ĐÓ vẫn qua RLS contracts + _autofill_org.
--
--   2. `IF NOT FOUND THEN RAISE` — nhưng chỉ ở những nhánh mà 0 dòng THẬT SỰ là
--      lỗi. Nhánh trả phòng về AVAILABLE trong bản cũ có sẵn điều kiện NOT EXISTS
--      ngay trong câu UPDATE, nên 0 dòng ở đó là chuyện bình thường (còn hợp đồng
--      hiệu lực khác). File này TÁCH điều kiện ấy ra ngoài thành một phép kiểm
--      riêng, để câu UPDATE còn lại chỉ có đúng một cách hỏng — và cách đó thì
--      đáng nổ. contracts.room_id có FK ON DELETE RESTRICT tới rooms(id), nên sau
--      khi bỏ được RLS thì NOT FOUND nghĩa là hệ đã hỏng thật.
--
-- KHÔNG đổi luật nghiệp vụ: vẫn đúng ba nhánh cũ, vẫn cùng tập trạng thái
-- ('ACTIVE','EXTENDED'), vẫn chỉ đụng rooms.status và rooms.updated_at.
--
-- Idempotent. KHÔNG apply trong session này — chỉ dry-run qua `npm run migrate:forward`.

BEGIN;

CREATE OR REPLACE FUNCTION public.update_room_status_on_contract_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_con_hd_khac boolean;
BEGIN
  -- INSERT: HĐ mới đang hiệu lực → phòng OCCUPIED
  IF TG_OP = 'INSERT' AND NEW.status IN ('ACTIVE','EXTENDED') THEN
    IF NEW.room_id IS NOT NULL THEN
      UPDATE rooms SET status = 'OCCUPIED', updated_at = NOW() WHERE id = NEW.room_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'update_room_status_on_contract_change: khong cap nhat duoc phong % (INSERT hop dong %)',
          NEW.room_id, NEW.id;
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    -- Rời active-set → phòng AVAILABLE nếu không còn HĐ đang hiệu lực khác
    IF OLD.status IN ('ACTIVE','EXTENDED') AND NEW.status NOT IN ('ACTIVE','EXTENDED') THEN
      IF NEW.room_id IS NOT NULL THEN
        -- Tách phép kiểm ra khỏi câu UPDATE: còn HĐ hiệu lực khác là lý do CHÍNH
        -- ĐÁNG để không đổi gì, và nó phải phân biệt được với "không ghi nổi".
        SELECT EXISTS (
          SELECT 1 FROM contracts
           WHERE room_id = NEW.room_id
             AND deleted_at IS NULL
             AND status IN ('ACTIVE','EXTENDED')
             AND id <> NEW.id
        ) INTO v_con_hd_khac;

        IF NOT v_con_hd_khac THEN
          UPDATE rooms SET status = 'AVAILABLE', updated_at = NOW() WHERE id = NEW.room_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'update_room_status_on_contract_change: khong tra duoc phong % ve AVAILABLE (hop dong %)',
              NEW.room_id, NEW.id;
          END IF;
        END IF;
      END IF;
    END IF;

    -- Vào active-set → phòng OCCUPIED
    IF OLD.status NOT IN ('ACTIVE','EXTENDED') AND NEW.status IN ('ACTIVE','EXTENDED') THEN
      IF NEW.room_id IS NOT NULL THEN
        UPDATE rooms SET status = 'OCCUPIED', updated_at = NOW() WHERE id = NEW.room_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'update_room_status_on_contract_change: khong cap nhat duoc phong % (hop dong % vao active-set)',
            NEW.room_id, NEW.id;
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.update_room_status_on_contract_change() IS
  'AFTER INSERT/UPDATE trên contracts: đồng bộ rooms.status. SECURITY DEFINER vì trạng thái phòng '
  'là hệ quả suy ra của hợp đồng — RLS của người gõ không được phép làm nó hụt trong im lặng.';

-- Trạng thái ACL trước migration đã là {postgres=X,service_role=X} (không có
-- PUBLIC/anon/authenticated). CREATE OR REPLACE giữ nguyên ACL, nhưng khai lại
-- để một lần tạo lại hàm trong tương lai không âm thầm mở về PUBLIC — đúng án lệ
-- 07/08/2026 ghi ở đầu scripts/check-definer-acl.mjs. Hàm trigger không cần
-- EXECUTE của người gọi lúc bắn; Postgres chỉ kiểm quyền đó lúc CREATE TRIGGER.
REVOKE ALL ON FUNCTION public.update_room_status_on_contract_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_room_status_on_contract_change() FROM anon, authenticated;

DO $ktra$
DECLARE
  v_secdef boolean;
  v_cfg    text[];
  v_trg    integer;
BEGIN
  SELECT p.prosecdef, p.proconfig INTO v_secdef, v_cfg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'update_room_status_on_contract_change';

  IF NOT COALESCE(v_secdef, false) THEN
    RAISE EXCEPTION 'update_room_status_on_contract_change phai la SECURITY DEFINER';
  END IF;
  IF v_cfg IS NULL OR NOT (v_cfg::text LIKE '%search_path%') THEN
    RAISE EXCEPTION 'update_room_status_on_contract_change phai ghim search_path';
  END IF;

  -- Trigger phải còn nguyên: CREATE OR REPLACE không đụng trigger, nhưng nếu ai
  -- đó đã gỡ nó thì hàm này vô nghĩa và phải biết ngay.
  SELECT count(*) INTO v_trg
    FROM pg_trigger
   WHERE tgrelid = 'public.contracts'::regclass
     AND tgname = 'trigger_update_room_status'
     AND NOT tgisinternal;
  IF v_trg <> 1 THEN
    RAISE EXCEPTION 'thieu trigger trigger_update_room_status tren contracts (dem = %)', v_trg;
  END IF;

  IF has_function_privilege('anon', 'public.update_room_status_on_contract_change()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon van EXECUTE duoc update_room_status_on_contract_change';
  END IF;
END
$ktra$;

COMMIT;
