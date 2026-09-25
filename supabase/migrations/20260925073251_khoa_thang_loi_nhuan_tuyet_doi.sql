-- =============================================================================
-- khoa_thang_loi_nhuan_tuyet_doi — tháng đã chốt lợi nhuận khoá MỌI phiếu
-- Ngày 25/09/2026 · đợt 1 "sửa phiếu thu chi" · chủ chốt: "chốt tháng lợi nhuận
-- khi đã chốt thì toàn bộ phiếu trong kỳ đó đều bị khóa hết bất kể phiếu nào
-- trạng thái nào"
-- =============================================================================
-- VÌ SAO
--   Khoá tháng đang có ba cửa vượt:
--   1. Chủ công ty / super admin được bỏ qua khoá (nhánh is_org_owner_v1).
--   2. Không có người đăng nhập (job, migration) thì trigger bỏ qua hẳn.
--   3. Phiếu ngoài KQKD do hệ thống sinh không bị xét.
--   Đo production 25/09/2026 (chỉ đọc, change_log + phiếu tạo sau khi chốt): ngoài
--   máy dời lịch phiếu lặp lại, MỌI lần ghi vào tháng đã chốt đều đi cửa 1 (vd
--   PC2609124 ngày 27/07 toà 15KV, sửa ngày 25/09). Và chốt tháng vẫn làm được khi
--   tháng còn phiếu Chờ duyệt.
--
-- LÀM GÌ
--   1. Hàm chung app_private.profit_month_locked_v1 / assert_profit_month_open_v2.
--   2. Viết lại income_expenses_check_profit_lock và
--      income_expense_items_check_profit_lock: xét (toà, NGÀY PHIẾU) cũ và mới ở mọi
--      INSERT/UPDATE/DELETE, với mọi người, mọi loại phiếu. Ngoại lệ KHÔNG đổi
--      tiền, trigger tự kiểm delta chứ không tin lời writer:
--        - chỉ đổi cột trong {repeat_remaining, repeat_next_date, handover_id,
--          verified_at, verified_by, verified_by_name, verified_note,
--          has_restricted_item, updated_at}, cộng posting_mode/posting_status/
--          review_state đi từ NULL sang giá trị;
--        - scope STOP_RECURRING, chỉ chiều tắt lặp (repeat_cycle = 'NONE');
--        - scope LINK_CONTRACT, chỉ gắn contract_id từ NULL (tạo hợp đồng gắn
--          phiếu cọc giữ chỗ có ngày trong tháng đã chốt).
--      Thêm/gỡ ảnh ngay trên phiếu (ANNOTATE) KHÔNG còn là ngoại lệ — dùng Bổ sung.
--   3. assert_period_open_for_edit_v1: bước lợi nhuận dùng hàm chung, bỏ lọc KQKD;
--      bỏ hai bước xét tháng hoá đơn và kỳ hạng mục — chỉ xét ngày phiếu. Phiếu thu
--      ngày tháng đang mở của một hoá đơn tháng đã chốt vẫn huỷ/đổi được.
--   4. Trigger a10_profit_month_lock_requires_no_pending trên profit_monthly: mọi
--      lần đặt locked_at (profit_close_v2/profit_reclose_v2 của màn Chốt lợi nhuận,
--      cả lock_profit_month_v1 cũ) bị từ chối khi toà còn phiếu Chờ duyệt có ngày
--      trong tháng đó.
--   Mở khoá có lý do: đã có profit_unlock_v2 (lý do 8..1000 ký tự, lưu
--   profit_close_runs + profit_close_revisions); giao diện chuyển sang hàm đó.
--
-- KHÔNG ĐỤNG
--   Không sửa dữ liệu đang có. Đo 25/09: 0 phiếu Chờ duyệt nằm trong tháng đã chốt
--   ⇒ không phiếu nào bị kẹt khi khoá thành tuyệt đối.
--   Không đụng hàm/trigger đã ghim (migration-policy.json › idempotencyRetirements),
--   không sửa bộ hàm chốt lợi nhuận V2.
--   Hai trigger function phiếu giữ SECURITY INVOKER + ACL như cũ (giống anh em
--   income_expenses_check_lock): mọi đường ghi thật đi qua RPC definer nên trigger
--   chạy dưới quyền chủ bảng.
--   Migration kỹ thuật sau này buộc phải ghi vào tháng đã chốt thì tự
--   `ALTER TABLE … DISABLE TRIGGER a02_…` trong chính transaction của nó và qua review.
--
-- ĐƯỜNG LÙI
--   CREATE OR REPLACE lại 3 hàm từ bản trước (md5 ở khối preflight, thân lấy từ
--   schema-change evidence/backup); DROP TRIGGER a10_profit_month_lock_requires_no_pending
--   ON public.profit_monthly; DROP FUNCTION app_private.guard_profit_month_lock_pending_v1(),
--   app_private.assert_profit_month_open_v2(uuid, date, text),
--   app_private.profit_month_locked_v1(uuid, date).
--
-- Chạy được hai lượt liên tiếp và trên DB rỗng của Restore Drill.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. Bản đang chạy phải đúng bản đã rà (hoặc đã là bản của file này).
DO $truoc$
DECLARE
  v_ham record;
BEGIN
  FOR v_ham IN
    SELECT * FROM (VALUES
      ('public.income_expenses_check_profit_lock()',
       ARRAY['50c8e126914b391bfd04e62509b8f463', '877f88c3b7371acb6633ce5f091e85d4']),
      ('public.income_expense_items_check_profit_lock()',
       ARRAY['a7d1e2b8f54e672132fe23d8b1efa1f5', '74f085be2be71bda5de310ee9d12d27d']),
      ('app_private.assert_period_open_for_edit_v1(uuid,text)',
       ARRAY['72fb2878ffd9b9d5a4a97bd8a8b9699c', 'b80940a9c0aece52868d4489a58ebd20'])
    ) AS t(chu_ky, md5_hop_le)
  LOOP
    IF to_regprocedure(v_ham.chu_ky) IS NOT NULL
       AND md5(pg_get_functiondef(to_regprocedure(v_ham.chu_ky))) <> ALL (v_ham.md5_hop_le) THEN
      RAISE EXCEPTION '% đã đổi so với bản đã rà — chụp lại pg_get_functiondef rồi rà lại', v_ham.chu_ky
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$truoc$;

-- ---------------------------------------------------------------------------
-- 1. Hàm chung.
CREATE OR REPLACE FUNCTION app_private.profit_month_locked_v1(p_building uuid, p_date date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
  -- Tháng của NGÀY PHIẾU ở toà này đã chốt lợi nhuận chưa. Thiếu toà hoặc ngày
  -- thì không thuộc tháng chốt nào của toà nào.
  SELECT p_building IS NOT NULL
     AND p_date IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.profit_monthly pm
        WHERE pm.building_id = p_building
          AND pm.period_month = date_trunc('month', p_date)::date
          AND pm.locked_at IS NOT NULL)
$function$;

CREATE OR REPLACE FUNCTION app_private.assert_profit_month_open_v2(p_building uuid, p_date date, p_action text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_name text;
BEGIN
  IF app_private.profit_month_locked_v1(p_building, p_date) THEN
    SELECT b.name INTO v_name FROM public.buildings b WHERE b.id = p_building;
    RAISE EXCEPTION
      '[PROFIT_LOCKED] Tháng % của toà % đã chốt lợi nhuận — mọi phiếu của tháng này bị khoá, không % được. Nhờ chủ công ty mở khoá tháng.',
      to_char(p_date, 'MM/YYYY'), COALESCE(v_name, '(không rõ tên)'),
      COALESCE(NULLIF(btrim(p_action), ''), 'sửa')
      USING ERRCODE = 'P0001';
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION app_private.profit_month_locked_v1(uuid, date)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.assert_profit_month_open_v2(uuid, date, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Trigger phiếu: khoá theo (toà, ngày phiếu) cũ và mới, không cửa vượt.
CREATE OR REPLACE FUNCTION public.income_expenses_check_profit_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_mien text[];
  v_scope text;
BEGIN
  -- Đường nhanh: cả vị trí cũ lẫn mới đều ở tháng đang mở.
  IF NOT (
    (TG_OP <> 'INSERT' AND app_private.profit_month_locked_v1(OLD.building_id, OLD.voucher_date))
    OR (TG_OP <> 'DELETE' AND app_private.profit_month_locked_v1(NEW.building_id, NEW.voucher_date))
  ) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Cột KHÔNG đổi tiền: máy dời lịch phiếu lặp, gắn/nhả phiên bàn giao tiền
    -- mặt, đánh dấu đã kiểm, cờ hạng mục hạn chế (suy từ loại thu chi).
    v_mien := ARRAY['repeat_remaining', 'repeat_next_date', 'handover_id',
                    'verified_at', 'verified_by', 'verified_by_name', 'verified_note',
                    'has_restricted_item', 'updated_at'];
    -- Ba cột vòng đời được điền khi còn NULL: chỉ miễn đúng chiều NULL -> giá trị.
    IF OLD.posting_mode IS NULL THEN v_mien := v_mien || 'posting_mode'::text; END IF;
    IF OLD.posting_status IS NULL THEN v_mien := v_mien || 'posting_status'::text; END IF;
    IF OLD.review_state IS NULL THEN v_mien := v_mien || 'review_state'::text; END IF;

    IF (to_jsonb(OLD) - v_mien) IS NOT DISTINCT FROM (to_jsonb(NEW) - v_mien) THEN
      RETURN NEW;
    END IF;

    SELECT w.scope INTO v_scope
      FROM app_private.ie_flex_writer_xids w
     WHERE w.income_expense_id = OLD.id
       AND w.transaction_id = pg_current_xact_id()
       AND w.backend_pid = pg_backend_pid();

    -- Dừng lặp lại: chỉ tắt việc sinh phiếu tương lai, không đụng số nào của kỳ.
    IF v_scope = 'STOP_RECURRING'
       AND COALESCE(NEW.repeat_cycle, 'NONE') = 'NONE'
       AND (to_jsonb(OLD) - v_mien - ARRAY['repeat_cycle', 'repeat_infinity', 'repeat_count'])
           IS NOT DISTINCT FROM
           (to_jsonb(NEW) - v_mien - ARRAY['repeat_cycle', 'repeat_infinity', 'repeat_count']) THEN
      RETURN NEW;
    END IF;

    -- Tạo hợp đồng gắn phiếu cọc giữ chỗ: chỉ contract_id đi từ NULL.
    IF v_scope = 'LINK_CONTRACT'
       AND OLD.contract_id IS NULL
       AND NEW.contract_id IS NOT NULL
       AND (to_jsonb(OLD) - v_mien - 'contract_id'::text)
           IS NOT DISTINCT FROM
           (to_jsonb(NEW) - v_mien - 'contract_id'::text) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    PERFORM app_private.assert_profit_month_open_v2(
      OLD.building_id, OLD.voucher_date,
      CASE WHEN TG_OP = 'DELETE' THEN 'xoá phiếu' ELSE 'sửa phiếu' END);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM app_private.assert_profit_month_open_v2(
      NEW.building_id, NEW.voucher_date,
      CASE WHEN TG_OP = 'INSERT' THEN 'lập phiếu' ELSE 'sửa phiếu' END);
  END IF;

  RETURN COALESCE(NEW, OLD);
END
$function$;

-- ---------------------------------------------------------------------------
-- 3. Trigger hạng mục: hạng mục là tiền, không có ngoại lệ.
CREATE OR REPLACE FUNCTION public.income_expense_items_check_profit_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_parent uuid;
  v_building uuid;
  v_date date;
BEGIN
  FOREACH v_parent IN ARRAY ARRAY[
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.income_expense_id END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.income_expense_id END
  ] LOOP
    CONTINUE WHEN v_parent IS NULL;
    SELECT ie.building_id, ie.voucher_date INTO v_building, v_date
      FROM public.income_expenses ie
     WHERE ie.id = v_parent;
    CONTINUE WHEN NOT FOUND;
    PERFORM app_private.assert_profit_month_open_v2(
      v_building, v_date,
      CASE TG_OP WHEN 'INSERT' THEN 'thêm hạng mục'
                 WHEN 'DELETE' THEN 'xoá hạng mục'
                 ELSE 'sửa hạng mục' END);
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END
$function$;

-- ---------------------------------------------------------------------------
-- 4. Chốt kỳ cho các writer sửa/huỷ: bước lợi nhuận theo ngày phiếu, mọi phiếu.
CREATE OR REPLACE FUNCTION app_private.assert_period_open_for_edit_v1(p_voucher uuid, p_action text DEFAULT 'sửa'::text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_row public.income_expenses%ROWTYPE;
  v_acct uuid;
  v_lock date;
  v_name text;
  v_handover text;
BEGIN
  SELECT * INTO v_row FROM public.income_expenses WHERE id = p_voucher;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;

  -- 1) SỔ QUỸ ĐÃ CHỐT & BÀN GIAO. Xét cả sổ chính, sổ thối và sổ làm tròn vì
  --    tồn quỹ cộng theo account của từng dòng bút toán.
  FOREACH v_acct IN ARRAY ARRAY[v_row.account_id, v_row.change_account_id, v_row.rounding_account_id] LOOP
    CONTINUE WHEN v_acct IS NULL;
    v_lock := app_private.cashbook_closed_through_v1(v_acct);
    IF v_lock IS NOT NULL AND v_row.voucher_date <= v_lock THEN
      SELECT a.name INTO v_name FROM public.accounts a WHERE a.id = v_acct;
      RAISE EXCEPTION
        '[CASHBOOK_CLOSED] Sổ quỹ "%" đã chốt & bàn giao tới ngày % — phiếu trong kỳ này không % được nữa. Muốn điều chỉnh, hãy lập phiếu mới ở kỳ hiện tại.',
        COALESCE(v_name, 'không rõ'), to_char(v_lock, 'DD/MM/YYYY'), p_action
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- 2) PHIÊN BÀN GIAO TIỀN MẶT còn sống. Trigger ie_handover_guard cũng chặn,
  --    nhưng nó chỉ nói "[HANDOVER_LOCKED]" — ở đây nêu rõ mã phiên để người
  --    dùng biết phải huỷ phiên nào.
  IF v_row.handover_transfer_id IS NOT NULL THEN
    SELECT h.code INTO v_handover FROM public.cash_handovers h
     WHERE h.id = v_row.handover_transfer_id AND h.status <> 'CANCELLED';
    IF v_handover IS NOT NULL THEN
      RAISE EXCEPTION
        '[HANDOVER_LOCKED] Đây là phiếu chuyển của phiên bàn giao % — muốn % thì phải huỷ phiên đó trước (cần cả hai bên đồng ý).',
        v_handover, p_action USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF v_row.handover_id IS NOT NULL THEN
    SELECT h.code INTO v_handover
    FROM public.cash_handovers h
    WHERE h.id = v_row.handover_id AND h.status <> 'CANCELLED';
    IF v_handover IS NOT NULL THEN
      RAISE EXCEPTION
        '[HANDOVER_LOCKED] Phiếu nằm trong phiên bàn giao % đã xác nhận — muốn % thì phải huỷ phiên đó trước (cần cả hai bên đồng ý).',
        v_handover, p_action
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 3) THÁNG LỢI NHUẬN ĐÃ CHỐT — tuyệt đối theo NGÀY PHIẾU (chủ chốt 25/09/2026):
  --    mọi loại phiếu, kể cả phiếu ngoài KQKD, với mọi người. Không còn xét tháng
  --    của hoá đơn hay kỳ của hạng mục: phiếu thu mang ngày tháng đang mở của một
  --    hoá đơn tháng đã chốt vẫn huỷ/đổi được.
  PERFORM app_private.assert_profit_month_open_v2(v_row.building_id, v_row.voucher_date, p_action);
END
$function$;

-- ---------------------------------------------------------------------------
-- 5. Chốt tháng: không chốt khi toà còn phiếu Chờ duyệt trong tháng đó. Gắn ở
--    bảng profit_monthly để phủ MỌI đường đặt locked_at mà không sửa bộ hàm V2.
CREATE OR REPLACE FUNCTION app_private.guard_profit_month_lock_pending_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_n integer;
  v_list text;
  v_name text;
BEGIN
  -- Chỉ xét lúc CHỐT: locked_at nhận giá trị mới. Mở khoá (về NULL) và các lần
  -- ghi không đổi locked_at đi qua.
  IF NEW.locked_at IS NULL
     OR (TG_OP = 'UPDATE' AND OLD.locked_at IS NOT DISTINCT FROM NEW.locked_at) THEN
    RETURN NEW;
  END IF;

  SELECT count(*),
         string_agg(x.nhan, ', ' ORDER BY x.voucher_date, x.nhan) FILTER (WHERE x.rn <= 10)
    INTO v_n, v_list
    FROM (
      SELECT COALESCE(NULLIF(ie.code, ''), 'phiếu chưa có mã') AS nhan,
             ie.voucher_date,
             row_number() OVER (ORDER BY ie.voucher_date, ie.code) AS rn
        FROM public.income_expenses ie
       WHERE ie.building_id = NEW.building_id
         AND ie.voucher_date >= date_trunc('month', NEW.period_month)::date
         AND ie.voucher_date < (date_trunc('month', NEW.period_month) + interval '1 month')::date
         AND ie.approval_status = 'UNAPPROVED'
         AND ie.deleted_at IS NULL
    ) x;

  IF v_n > 0 THEN
    SELECT b.name INTO v_name FROM public.buildings b WHERE b.id = NEW.building_id;
    RAISE EXCEPTION
      'Còn % phiếu chờ duyệt trong tháng % của toà %: % — duyệt hoặc huỷ trước khi chốt.',
      v_n, to_char(NEW.period_month, 'MM/YYYY'), COALESCE(v_name, '(không rõ tên)'),
      v_list || CASE WHEN v_n > 10 THEN ', …' ELSE '' END
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION app_private.guard_profit_month_lock_pending_v1()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS a10_profit_month_lock_requires_no_pending ON public.profit_monthly;
CREATE TRIGGER a10_profit_month_lock_requires_no_pending
  BEFORE INSERT OR UPDATE OF locked_at ON public.profit_monthly
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_month_lock_pending_v1();

-- ---------------------------------------------------------------------------
-- 6. Nghiệm thu.
DO $nghiem_thu$
DECLARE
  v_def text;
  v_trg record;
BEGIN
  v_def := regexp_replace(
    pg_get_functiondef('public.income_expenses_check_profit_lock()'::regprocedure), '--[^\n]*', '', 'g');
  IF v_def ~ '(is_org_owner_v1|is_super_admin|business_result_accounting|auth\.uid)'
     OR v_def !~ 'assert_profit_month_open_v2'
     OR v_def !~ 'LINK_CONTRACT' OR v_def !~ 'STOP_RECURRING' THEN
    RAISE EXCEPTION 'nghiem_thu: income_expenses_check_profit_lock chua khoa tuyet doi';
  END IF;

  v_def := regexp_replace(
    pg_get_functiondef('public.income_expense_items_check_profit_lock()'::regprocedure), '--[^\n]*', '', 'g');
  IF v_def ~ '(is_org_owner_v1|is_super_admin|business_result_accounting|auth\.uid)'
     OR v_def !~ 'assert_profit_month_open_v2' THEN
    RAISE EXCEPTION 'nghiem_thu: income_expense_items_check_profit_lock chua khoa tuyet doi';
  END IF;

  v_def := regexp_replace(
    pg_get_functiondef('app_private.assert_period_open_for_edit_v1(uuid,text)'::regprocedure), '--[^\n]*', '', 'g');
  IF v_def ~ '(billing_month|item_row|business_result_accounting)'
     OR v_def !~ 'assert_profit_month_open_v2' THEN
    RAISE EXCEPTION 'nghiem_thu: assert_period_open_for_edit_v1 chua xet theo ngay phieu';
  END IF;

  IF has_function_privilege('authenticated', 'app_private.assert_profit_month_open_v2(uuid,date,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.profit_month_locked_v1(uuid,date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.guard_profit_month_lock_pending_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'nghiem_thu: ham khoa thang dang mo cho authenticated';
  END IF;
  IF app_private.profit_month_locked_v1(NULL, NULL) THEN
    RAISE EXCEPTION 'nghiem_thu: thieu toa/ngay khong duoc coi la da chot';
  END IF;

  FOR v_trg IN
    SELECT * FROM (VALUES
      ('public.income_expenses', 'a02_ie_profit_lock_ins', 'public.income_expenses_check_profit_lock()'),
      ('public.income_expenses', 'a02_ie_profit_lock_upd', 'public.income_expenses_check_profit_lock()'),
      ('public.income_expenses', 'a02_ie_profit_lock_del', 'public.income_expenses_check_profit_lock()'),
      ('public.income_expense_items', 'a02_ie_items_profit_lock', 'public.income_expense_items_check_profit_lock()'),
      ('public.profit_monthly', 'a10_profit_month_lock_requires_no_pending', 'app_private.guard_profit_month_lock_pending_v1()')
    ) AS t(bang, ten, ham)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
       WHERE t.tgrelid = v_trg.bang::regclass
         AND t.tgname = v_trg.ten
         AND t.tgfoid = v_trg.ham::regprocedure
         AND t.tgenabled = 'O') THEN
      RAISE EXCEPTION 'nghiem_thu: trigger % khong con gan dung ham', v_trg.ten;
    END IF;
  END LOOP;
END
$nghiem_thu$;

COMMIT;

NOTIFY pgrst, 'reload schema';
