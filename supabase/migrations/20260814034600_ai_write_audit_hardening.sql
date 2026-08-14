-- =============================================================================
-- `ai_write_audit` thành sổ CHỈ GHI THÊM — trình duyệt hết đường viết vào
--
-- VẤN ĐỀ ĐANG SỬA
--   Bảng này được dựng ở `20260711050000` với hai policy cho vai `authenticated`:
--     ai_write_audit_insert      — INSERT dòng của chính mình
--     ai_write_audit_update_own  — UPDATE dòng của chính mình
--   Cả hai đều cần thiết cho luồng ghi CŨ, nơi trình duyệt tự ghi audit trước,
--   gọi RPC tạo phiếu, rồi quay lại UPDATE `entity_id`.
--
--   Nhưng một cuốn sổ mà chính người bị ghi sổ sửa được thì không phải sổ. Với
--   `UPDATE` own-row, một client (hoặc một đoạn mã chạy trong client) có thể đổi
--   `payload`, đổi `entity_id`, hay trỏ một dòng audit sang một phiếu khác —
--   sau khi việc đã xảy ra. Không có gì trong dữ liệu cho biết điều đó đã diễn
--   ra, vì bản thân bằng chứng là thứ bị sửa.
--
-- VÌ SAO SỬA ĐƯỢC BÂY GIỜ
--   `20260814034500` đưa việc ghi audit vào trong `copilot_execute_income_expense_v1`,
--   chạy SECURITY DEFINER và ghi audit CÙNG giao dịch với phiếu. Không còn ai
--   cần hai policy kia nữa: đường ghi hợp lệ duy nhất đi qua server.
--
-- THỨ TỰ PHÁT HÀNH — BẮT BUỘC ĐỌC
--   Migration này LÀM HỎNG luồng ghi cũ (client sẽ nhận lỗi RLS khi INSERT
--   audit). Timestamp `034600` đặt SAU `034500` có chủ ý: đường ghi mới phải tồn
--   tại trước khi đường ghi cũ bị đóng. Đặt trước sẽ tạo một khoảng — dù chỉ
--   trong một lần apply — mà hệ thống KHÔNG có đường ghi hợp lệ nào.
--
--   Web mới phải được deploy ngay sau khi apply.
--
--   Kiểu hỏng ở giữa hai mốc là AN TOÀN: client cũ INSERT audit TRƯỚC khi tạo
--   phiếu, nên nó dừng ngay ở bước đầu và KHÔNG tạo phiếu nào. Người dùng thấy
--   một thông báo lỗi, không phải dữ liệu hỏng.
--
-- TRIGGER CHỨ KHÔNG CHỈ POLICY
--   Bỏ policy là đủ cho vai `authenticated`. Trigger là để chặn cả những đường
--   KHÔNG đi qua RLS: `service_role`, một hàm SECURITY DEFINER viết ẩu sau này,
--   hay một lần sửa tay trong console. Sổ bất biến thì phải bất biến với mọi
--   người, không chỉ với người dùng cuối.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- 1. Trình duyệt hết đường ghi trực tiếp ---------------------------------------
DROP POLICY IF EXISTS ai_write_audit_insert     ON public.ai_write_audit;
DROP POLICY IF EXISTS ai_write_audit_update_own ON public.ai_write_audit;

REVOKE INSERT, UPDATE, DELETE ON public.ai_write_audit FROM authenticated;

-- 2. Bất biến với MỌI vai ------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.ai_write_audit_bat_bien_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $f$
BEGIN
  RAISE EXCEPTION
    'ai_write_audit chi ghi them: % bi tu choi. Sua mot dong audit la sua chinh bang chung.',
    TG_OP
    USING ERRCODE = '42501';
END
$f$;

DROP TRIGGER IF EXISTS trg_ai_write_audit_bat_bien ON public.ai_write_audit;
CREATE TRIGGER trg_ai_write_audit_bat_bien
  BEFORE UPDATE OR DELETE ON public.ai_write_audit
  FOR EACH ROW EXECUTE FUNCTION app_private.ai_write_audit_bat_bien_v1();

COMMENT ON TABLE public.ai_write_audit IS
  'So GHI THEM cho thao tac ghi cua Copilot. Trinh duyet KHONG co INSERT/UPDATE/DELETE — duong ghi '
  'hop le duy nhat la copilot_execute_income_expense_v1 (SECURITY DEFINER, ghi cung giao dich voi '
  'phieu). Trigger chan UPDATE/DELETE voi moi vai, ke ca service_role.';

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — đo bằng vai thật, không suy từ định nghĩa.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_id   uuid;
  v_loi  text;
BEGIN
  -- (1) Hai policy cũ phải biến mất.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'ai_write_audit'
       AND policyname IN ('ai_write_audit_insert', 'ai_write_audit_update_own')
  ) THEN
    RAISE EXCEPTION 'Policy ghi cu van con — trinh duyet van viet duoc vao so. DUNG.';
  END IF;

  -- (2) Vai authenticated không còn quyền bảng.
  IF has_table_privilege('authenticated', 'public.ai_write_audit', 'INSERT')
     OR has_table_privilege('authenticated', 'public.ai_write_audit', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.ai_write_audit', 'DELETE') THEN
    RAISE EXCEPTION 'authenticated van con quyen ghi tren ai_write_audit. DUNG.';
  END IF;

  -- (3) SELECT phải còn — người dùng vẫn xem được sổ của mình.
  IF NOT has_table_privilege('authenticated', 'public.ai_write_audit', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated mat luon quyen doc so cua chinh minh. DUNG.';
  END IF;

  -- (4) Trigger phải TỒN TẠI và đang bật. Kiểm trên catalog, luôn chạy được kể
  --     cả trên database rỗng.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.ai_write_audit'::regclass
       AND t.tgname  = 'trg_ai_write_audit_bat_bien'
       AND t.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Trigger bat bien khong ton tai hoac dang bi tat. DUNG.';
  END IF;

  -- (5) Trigger CHẶN THẬT, không chỉ có mặt trong catalog.
  --
  --     Chỉ chạy khi bảng đã có dòng. KHÔNG tự chèn dòng thử: trigger chặn luôn
  --     cả DELETE, nên dòng thử sẽ không xoá được và ở lại vĩnh viễn trong sổ —
  --     một phép nghiệm thu để lại rác trong chính thứ nó vừa tuyên bố là bất
  --     biến thì tự mâu thuẫn.
  SELECT a.id INTO v_id
    FROM public.ai_write_audit a ORDER BY a.created_at DESC LIMIT 1;

  IF v_id IS NULL THEN
    RAISE NOTICE 'So audit dang rong — bo qua phep thu song (5). Phep (1)-(4) van da chay.';
  ELSE
    BEGIN
      UPDATE public.ai_write_audit SET entity_table = 'bi_sua' WHERE id = v_id;
      RAISE EXCEPTION 'Trigger KHONG chan UPDATE — so van sua duoc. DUNG.';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_loi = MESSAGE_TEXT;
      IF v_loi NOT LIKE '%chi ghi them%' THEN
        RAISE EXCEPTION 'UPDATE bi chan nhung khong phai boi trigger nay: %. DUNG.', v_loi;
      END IF;
    END;

    BEGIN
      DELETE FROM public.ai_write_audit WHERE id = v_id;
      RAISE EXCEPTION 'Trigger KHONG chan DELETE — so van xoa duoc. DUNG.';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL; -- đúng như mong đợi
    END;
  END IF;

  RAISE NOTICE 'Nghiem thu dat: policy ghi da go, authenticated het quyen ghi, trigger co mat va chan that.';
END
$nghiem_thu$;

COMMIT;

-- =============================================================================
-- ROLLBACK (chỉ dùng nếu phải quay lại luồng ghi cũ — xem ghi chú thứ tự phát hành):
--   DROP TRIGGER trg_ai_write_audit_bat_bien ON public.ai_write_audit;
--   DROP FUNCTION app_private.ai_write_audit_bat_bien_v1();
--   GRANT INSERT, UPDATE ON public.ai_write_audit TO authenticated;
--   CREATE POLICY ai_write_audit_insert ON public.ai_write_audit
--     FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
--   CREATE POLICY ai_write_audit_update_own ON public.ai_write_audit
--     FOR UPDATE TO authenticated USING (user_id = (SELECT auth.uid()))
--     WITH CHECK (user_id = (SELECT auth.uid()));
-- =============================================================================
