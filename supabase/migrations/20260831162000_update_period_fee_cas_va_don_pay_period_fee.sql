-- =====================================================================
-- Audit /thanh-toan 31/08 — cụm server Đợt 2 (user duyệt "sửa toàn bộ"):
--
--   (1) P2-05 — update_period_fee: THÊM optimistic concurrency.
--       Trang /thanh-toan cố ý mount 2 bề mặt, mỗi bề mặt một modal Sửa local
--       ⇒ hai modal cùng sửa MỘT phiếu, bản lưu sau nuốt bản lưu trước im lặng
--       (attachments là REPLACE cả mảng). Thêm p_expected_updated_at: client
--       gửi updated_at nó đã thấy khi mở modal; lệch ⇒ 55000 "mở lại".
--       ĐỔI CHỮ KÝ ⇒ DROP rồi CREATE (án lệ: CREATE OR REPLACE đẻ overload,
--       PostgREST chọn nhầm) + cấp lại ACL tường minh.
--
--   (2) P2-07 — pay_period_fee: sổ mặc định hết đoán theo TÊN.
--       Nhánh p_account_id NULL trước đây nhảy thẳng vào sổ '%Thu' của caller,
--       không có thì RAISE 'Bạn chưa có sổ quỹ "…Thu"' — trang CHI tiền rơi vào
--       sổ tên "Thu" là nghịch nghĩa, nhân sự mới kẹt với câu khó hiểu. Nay ưu
--       tiên building_fee_accounts.default_account_id (chính hàm này đang học
--       first-write-wins), rồi mới tới '%Thu', hết thì báo hành-động-được.
--
--   (3) P3-04 — pay_period_fee vệ sinh: v_months tính rồi bỏ → nay KẸP ≤ 36
--       khớp client (setN 1–36; caller RPC trực tiếp hết ghi được kỳ trăm năm);
--       comment dup-check tả sai code (nói "APPROVED"/"chưa mở rộng UNAPPROVED"
--       trong khi code đếm <> 'CANCELLED' tức GỒM UNAPPROVED) → sửa lời cho
--       khớp, hành vi giữ nguyên.
--
--   (4) Reader get_period_fee_status: vouchers[] thêm khoá 'updated_at' để
--       client seed token CAS khi mở modal Sửa. Thêm khoá jsonb — client cũ
--       không đọc thì bỏ qua, không vỡ gì.
--
-- KHÔNG đổi hành vi tiền: (2)(3) chỉ đụng nhánh chọn sổ mặc định + validate
-- input; dup-check, advisory lock, autopost, force-event giữ NGUYÊN VĂN.
-- =====================================================================
BEGIN;

DO $preflight$
BEGIN
  -- Chịu chạy LẶP (gate idempotent dán thân hai lần một transaction): chấp nhận
  -- nền đang ở chữ ký CŨ (7 tham số) HOẶC đã ở chữ ký MỚI (8 tham số).
  IF to_regprocedure('public.update_period_fee(uuid,uuid,jsonb,numeric,text,text,text)') IS NULL
     AND to_regprocedure('public.update_period_fee(uuid,uuid,jsonb,numeric,text,text,text,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'update_period_fee không tồn tại ở cả chữ ký cũ lẫn mới — nền lệch bản mong đợi. DỪNG.';
  END IF;
  IF to_regprocedure('public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)') IS NULL THEN
    RAISE EXCEPTION 'pay_period_fee(11 tham số) không tồn tại. DỪNG.';
  END IF;
  IF to_regprocedure('public.get_period_fee_status(text,text,uuid[],text[])') IS NULL THEN
    RAISE EXCEPTION 'get_period_fee_status không tồn tại. DỪNG.';
  END IF;
  IF to_regprocedure('public.org_today_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu org_today_v1(uuid). DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- (1) update_period_fee + p_expected_updated_at — DROP rồi CREATE.
-- DROP CẢ HAI chữ ký: chữ ký cũ (đường chính) và chữ ký mới (nhánh chạy lặp
-- của gate idempotent — lượt 2 xoá bản lượt 1 vừa tạo rồi tạo lại y hệt).
-- ─────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.update_period_fee(uuid,uuid,jsonb,numeric,text,text,text);
DROP FUNCTION IF EXISTS public.update_period_fee(uuid,uuid,jsonb,numeric,text,text,text,timestamptz);

CREATE FUNCTION public.update_period_fee(
  p_voucher_id uuid,
  p_account_id uuid DEFAULT NULL::uuid,
  p_attachments jsonb DEFAULT NULL::jsonb,
  p_amount numeric DEFAULT NULL::numeric,
  p_period_start text DEFAULT NULL::text,
  p_period_end text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text,
  p_expected_updated_at timestamptz DEFAULT NULL::timestamptz
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_bld      uuid;
  v_owner    uuid;
  v_del      timestamptz;
  v_creator  uuid;
  v_cur_acc  uuid;
  v_updated  timestamptz;
  v_is_admin boolean;
  v_can_edit boolean;
  v_acc      uuid;
  v_items    int;
  v_ps       date;
  v_pe       date;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT ie.building_id, ie.deleted_at, ie.user_id, ie.account_id, ie.updated_at
    INTO v_bld, v_del, v_creator, v_cur_acc, v_updated
    FROM income_expenses ie
   WHERE ie.id = p_voucher_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiếu' USING ERRCODE = 'P0002'; END IF;
  IF v_del IS NOT NULL THEN RAISE EXCEPTION 'Phiếu đã bị hủy'; END IF;

  -- 31/08 (audit P2-05): optimistic concurrency. Client gửi updated_at nó thấy
  -- khi MỞ modal; phiếu đã bị sửa ở nơi khác (bề mặt kia / người khác) thì từ
  -- chối TRƯỚC khi ghi đè — attachments là REPLACE cả mảng nên ghi đè mù là
  -- nuốt ảnh người kia vừa đính. Client cũ không gửi (NULL) giữ hành vi cũ.
  IF p_expected_updated_at IS NOT NULL AND v_updated IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Phiếu vừa được sửa ở nơi khác — đóng hộp thoại và mở lại để lấy bản mới nhất.'
      USING ERRCODE = '55000';
  END IF;

  SELECT b.user_id INTO v_owner FROM buildings b WHERE b.id = v_bld;

  v_is_admin := public.is_admin() OR public.is_super_admin() OR v_owner = auth.uid();
  v_can_edit := v_is_admin
                OR v_creator = auth.uid()
                OR (v_bld IS NOT NULL AND public.can_do_on_building('income_expenses', 'edit', v_bld));
  IF NOT v_can_edit THEN
    RAISE EXCEPTION 'Bạn không có quyền sửa phiếu này' USING ERRCODE = '42501';
  END IF;

  IF p_account_id IS NOT NULL THEN
    IF NOT v_is_admin AND v_cur_acc IS NOT NULL THEN
      RAISE EXCEPTION 'Chỉ được gán sổ quỹ khi phiếu chưa có sổ' USING ERRCODE = '42501';
    END IF;
    SELECT id INTO v_acc FROM accounts
     WHERE id = p_account_id AND deleted_at IS NULL
       AND (user_id = auth.uid() OR v_is_admin);
    IF v_acc IS NULL THEN
      RAISE EXCEPTION 'Sổ quỹ không hợp lệ hoặc bạn không có quyền ghi chi vào sổ này' USING ERRCODE = '42501';
    END IF;
    UPDATE income_expenses SET account_id = v_acc WHERE id = p_voucher_id;
  END IF;

  IF p_attachments IS NOT NULL THEN
    UPDATE income_expenses SET attachments = p_attachments WHERE id = p_voucher_id;
  END IF;

  IF v_is_admin THEN
    IF p_notes IS NOT NULL THEN
      UPDATE income_expenses SET notes = p_notes WHERE id = p_voucher_id;
    END IF;

    IF (p_amount IS NOT NULL AND p_amount > 0)
       OR (p_period_start ~ '^\d{4}-\d{2}$' AND p_period_end ~ '^\d{4}-\d{2}$') THEN
      SELECT count(*) INTO v_items FROM income_expense_items WHERE income_expense_id = p_voucher_id;
      IF v_items > 1 THEN
        RAISE EXCEPTION 'Phiếu có nhiều dòng hạng mục — sửa số tiền/kỳ ở trang Thu chi';
      END IF;
    END IF;

    IF p_amount IS NOT NULL AND p_amount > 0 THEN
      UPDATE income_expense_items
         SET unit_price = p_amount, quantity = 1
       WHERE income_expense_id = p_voucher_id;
    END IF;
    IF p_period_start ~ '^\d{4}-\d{2}$' AND p_period_end ~ '^\d{4}-\d{2}$'
       AND p_period_start <= p_period_end THEN
      v_ps := to_date(p_period_start || '-01', 'YYYY-MM-DD');
      v_pe := (date_trunc('month', to_date(p_period_end || '-01', 'YYYY-MM-DD')) + interval '1 month - 1 day')::date;
      UPDATE income_expense_items
         SET start_date = v_ps, end_date = v_pe
       WHERE income_expense_id = p_voucher_id;
    END IF;
  END IF;

  -- Chốt token CAS TẤT ĐỊNH: sửa item không đụng header (trigger recalc chỉ
  -- UPDATE header khi total đổi) ⇒ tự tay chạm header để mọi lần lưu thành công
  -- đều bump updated_at — lần lưu thứ hai với token cũ CHẮC CHẮN bị 55000.
  UPDATE income_expenses SET updated_at = now() WHERE id = p_voucher_id;

  RETURN jsonb_build_object('ok', true, 'voucher_id', p_voucher_id);
END;
$_$;

REVOKE ALL ON FUNCTION public.update_period_fee(uuid,uuid,jsonb,numeric,text,text,text,timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_period_fee(uuid,uuid,jsonb,numeric,text,text,text,timestamptz)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.update_period_fee(uuid,uuid,jsonb,numeric,text,text,text,timestamptz) IS
  'Sửa phiếu phí cố định (sổ/ảnh/ghi chú; admin sửa được tiền+kỳ khi phiếu 1 dòng). '
  '31/08: thêm p_expected_updated_at (optimistic concurrency) — client seed từ '
  'vouchers[].updated_at của get_period_fee_status; lệch là 55000 "mở lại", '
  'client cũ gửi NULL giữ hành vi cũ. Mọi lần lưu thành công tự bump updated_at.';

-- ─────────────────────────────────────────────────────────────────────
-- (2)+(3) pay_period_fee — CREATE OR REPLACE cùng chữ ký (không overload).
-- Thân hàm chép NGUYÊN VĂN từ bản đang chạy, chỉ 3 chỗ đổi được đánh dấu
-- "31/08". KHÔNG đụng: advisory lock, dup-check, can_force, autopost, force-events.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pay_period_fee(p_building_id uuid, p_category_key text, p_amount numeric, p_period_start text, p_period_end text, p_voucher_date date DEFAULT NULL::date, p_provider_code text DEFAULT NULL::text, p_account_holder text DEFAULT NULL::text, p_account_id uuid DEFAULT NULL::uuid, p_attachments jsonb DEFAULT NULL::jsonb, p_force boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_owner    uuid;
  v_acc      uuid;
  v_type     uuid;
  v_caller   text;
  v_label    text;
  v_vdate    date;
  v_p_start  date;
  v_p_end    date;
  v_months   int;
  v_period   text;
  v_voucher  uuid;
  v_code     text;
  v_total    numeric;
  v_dup_amt  numeric;
  v_dup_cnt  int;
  v_org      uuid;      -- Slice −1 B3
  v_is_super boolean := false;
  v_is_owner boolean := false;
  -- SPECIAL_FEE_AUTOPOST_V1
  v_rule     jsonb;
  v_verdict  text;
  v_posting  uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Số tiền phải lớn hơn 0';
  END IF;
  IF p_period_start !~ '^\d{4}-\d{2}$' OR p_period_end !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Kỳ không hợp lệ (cần YYYY-MM)';
  END IF;
  IF p_period_start > p_period_end THEN
    RAISE EXCEPTION 'Kỳ bắt đầu phải trước hoặc bằng kỳ kết thúc';
  END IF;
  IF p_category_key NOT IN ('tien_nha','dien','nuoc','internet','quan_ly','ve_sinh','cong_an','rac','thang_may') THEN
    RAISE EXCEPTION 'Hạng mục phí không hợp lệ: %', p_category_key;
  END IF;

  SELECT b.user_id, b.organization_id INTO v_owner, v_org FROM buildings b
   WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà'; END IF;
  IF NOT (public.can_access_building(p_building_id)
          OR public.ie_all_buildings_scope(p_building_id)
          OR v_owner = auth.uid()
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên toà này' USING ERRCODE = '42501';
  END IF;

  IF p_category_key = 'quan_ly' AND NOT public.can_create_restricted_ie() THEN
    RAISE EXCEPTION 'Bạn không có quyền tạo phiếu hạng mục hạn chế' USING ERRCODE = '42501';
  END IF;

  v_p_start := to_date(p_period_start || '-01', 'YYYY-MM-DD');
  v_p_end   := (date_trunc('month', to_date(p_period_end || '-01', 'YYYY-MM-DD')) + interval '1 month - 1 day')::date;
  v_months  := (extract(YEAR FROM age(date_trunc('month', v_p_end), date_trunc('month', v_p_start))) * 12
               + extract(MONTH FROM age(date_trunc('month', v_p_end), date_trunc('month', v_p_start))))::int + 1;

  -- 31/08 (audit P3-04): kẹp trần KHỚP CLIENT (setN 1–36). Trước đây v_months
  -- tính ra rồi không dùng — caller gọi RPC trực tiếp ghi được accrual trải
  -- hàng trăm tháng mà không lớp nào chặn.
  IF v_months > 36 THEN
    RAISE EXCEPTION 'Khoảng kỳ tối đa 36 tháng (đang chọn % tháng) — chia nhỏ đợt đóng.', v_months;
  END IF;

  -- ══ Slice −1 B3: KHOÁ SLOT TRƯỚC KHI ĐO ═══════════════════════════
  -- Phép đo dưới đây là SELECT-rồi-INSERT trần: hai cú bấm song song (hai bề
  -- mặt của /thanh-toan, hai tab, double-click) cùng đọc v_dup_cnt = 0 rồi cùng
  -- ghi ⇒ chốt chống trùng vô hiệu đúng ở khe đua. pay_utility_bill đã lấy khoá
  -- tư vấn cho đúng lý do này (mục 1); pay_period_fee thì chưa, nên bổ sung
  -- cùng khuôn. Khoá cấp transaction ⇒ tự nhả khi commit/rollback, và chỉ xếp
  -- hàng ĐÚNG một slot (org × toà × hạng mục × tháng bắt đầu), không serialize
  -- cả bảng. COALESCE quanh v_org là bắt buộc: pg_advisory_xact_lock STRICT,
  -- truyền NULL là KHÔNG lấy khoá nào mà vẫn trả về êm.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'fixed_fee:' || COALESCE(v_org::text, '-') || ':' || p_building_id::text || ':'
        || p_category_key || ':' || to_char(v_p_start, 'YYYY-MM'),
      0
    )
  );

  -- ══ Slice −1 B3: ĐO ĐẶC QUYỀN "Đóng thêm" NGAY, KỂ CẢ KHI KHÔNG p_force ═══
  -- Hai cờ này phải tính TRƯỚC nhánh trùng, vì payload cảnh báo trùng còn phải
  -- trả `can_force` cho giao diện. Nếu để trong `IF p_force` thì client phải TỰ
  -- đoán mình có quyền hay không — và đó chính là gốc lỗi đang vá: giao diện đoán
  -- bằng is_admin() (nay chỉ còn = is_super_admin()) nên CHỦ TỔ CHỨC THẬT bị nhắc
  -- "phải nhờ chủ tổ chức". Server là nơi DUY NHẤT biết câu trả lời, nên server
  -- nói ra. Cả hai hàm đều STABLE/không lấy khoá dòng ⇒ gọi thêm ở đây không tạo
  -- đường 25006 nào (pay_period_fee vẫn VOLATILE).
  v_is_super := public.is_super_admin();
  v_is_owner := app_private.is_org_owner_v1(v_org, auth.uid());

  -- ── CHỐNG ĐÓNG TRÙNG: đã có phiếu cùng hạng mục giao kỳ? ──
  -- 31/08 (audit P3-04, chỉ SỬA LỜI cho khớp code — hành vi giữ nguyên): phép
  -- đếm lấy approval_status <> 'CANCELLED', tức GỒM CẢ phiếu UNAPPROVED chờ
  -- duyệt — phiếu chờ duyệt là phiếu người khác KHÔNG thấy trên các bảng lọc
  -- APPROVED, chính là nguyên nhân người thứ hai tạo lại (cùng lý do
  -- get_voucher_slot_warning_v1 đếm cả UNAPPROVED). Comment cũ nói "phiếu
  -- APPROVED" và "(Chưa mở rộng sang UNAPPROVED)" là tả một bản đã không còn.
  -- Slice −1: phép ĐO chạy luôn, kể cả khi p_force — sổ vết phải ghi được
  -- "ghi đè lên mấy phiếu, tổng bao nhiêu". Trước đây cả khối này nằm trong
  -- IF NOT p_force nên "Đóng thêm" đi qua trong bóng tối.
  SELECT COALESCE(SUM(d.total_amount), 0), COUNT(*)
    INTO v_dup_amt, v_dup_cnt
    FROM (
      SELECT DISTINCT ie.id, ie.total_amount
        FROM income_expense_items it
        JOIN income_expense_types t ON t.id = it.income_expense_type_id
                                   AND t.type = 'expense'
                                   AND public.fee_type_matches(p_category_key, t.category, t.name)
        JOIN income_expenses ie ON ie.id = it.income_expense_id
                               AND ie.building_id = p_building_id
                               AND ie.type = 'EXPENSE'
                               AND ie.approval_status <> 'CANCELLED'
                               AND ie.deleted_at IS NULL
       WHERE it.start_date <= v_p_end AND it.end_date >= v_p_start
    ) d;

  IF p_force THEN
    -- ══ Slice −1 B3: "Đóng thêm" là quyền của CHỦ ═══════════════════
    -- ⚠ ĐÍNH CHÍNH ATTRIBUTION (đo lại 30/07, đừng để bản nháp cũ dẫn sai):
    -- 24 slot phí cố định trùng / 49 lượt phiếu / 620.496.725đ trên production
    -- KHÔNG có slot nào do hàm này sinh ra. Phân rã theo system_source:
    --     21 slot  → system_source NULL   (đường tạo phiếu CHUNG bên Thu chi)
    --      3 slot  → 'utility.bill'       (đã bịt bằng khoá + chốt ở mục 1; và
    --                                      xem ĐÍNH CHÍNH ở đầu file — 2 trong 3
    --                                      là hai công tơ thật bị gán chung)
    --      0 slot  → 'fixed_fee'          (hàm này đóng dấu 'fixed_fee' vô điều
    --                                      kiện, và cả DB chỉ có ĐÚNG 2 phiếu
    --                                      'fixed_fee': PC2607111 300.000đ và
    --                                      PC2607117 900.000đ, khác toà, khác
    --                                      tiền — không phải một cặp trùng)
    -- Cặp 66.000.000đ 'tiền nhà' 102LVT cách nhau 460ms (created_at
    -- 2026-06-07T05:15:09.361412Z / …821586Z) mang system_source = NULL,
    -- idempotency_key NULL ⇒ KHÔNG do pay_period_fee, cũng KHÔNG do lưới phí cố
    -- định của /thanh-toan. Vậy B3 + khoá slot ở trên là chống trùng CHO LẦN GHI
    -- MỚI của chính hàm này (và bịt khe đua chưa từng có ai bịt), TUYỆT ĐỐI
    -- KHÔNG được ghi nhận là "đã bịt lỗ 24 slot/49 lượt phiếu" — writer tạo phiếu
    -- chung (system_source NULL) vẫn chưa có bất kỳ chốt slot nào và không thuộc
    -- phạm vi slice này.
    -- ĐÃ PHÂN LOẠI 24 ô đó theo "số tiền có bằng nhau không" (30/07) để slice sau
    -- thiết kế đúng, KHÔNG chặn oan:
    --   • 4 ô SỐ TIỀN BẰNG NHAU, tất cả 'tien_nha', tất cả system_source NULL:
    --       102LVT 06/2026 66.000.000×2 — cách 460 ms, MỘT người  ⇒ bấm đôi
    --       32PVC  07/2026 26.000.000×2 — cách ~13,9 giờ, HAI người
    --       405PVB 07/2026 52.500.000×2 — cách ~8,4 ngày,  HAI người
    --       15KV   07/2026 20.000.000×2 — cách ~9,4 ngày,  HAI người
    --     Tổng 164.500.000đ. HAI BỆNH KHÁC NHAU: 1 ca bấm đôi (chữa bằng chống
    --     phát lại / idempotency_key) và 3 ca hai người cùng trả một tháng tiền
    --     nhà (chữa bằng CẢNH BÁO mức ô, không phải khoá thời gian).
    --   • 20 ô SỐ TIỀN KHÁC NHAU ⇒ HỢP LỆ, TUYỆT ĐỐI KHÔNG ĐƯỢC CHẶN. Ví dụ
    --     405PVB công an 07/2026 = 1.000.000đ + 7.000đ; 15KV rác 06/2026 =
    --     300.000đ + 120.000đ. Khoá cứng theo ô sẽ chặn oan 20/24 trường hợp.
    --   Công cụ đã có sẵn nhưng chưa dùng: cột income_expenses.idempotency_key
    --   tồn tại, 42 phiếu có key và cả 42 key phân biệt ⇒ tạo được partial UNIQUE
    --   INDEX ngay với 0 xung đột — NHƯNG hiện KHÔNG có unique index nào trên cột
    --   đó (key chỉ là trang trí) và writer thủ công chỉ gửi key ở 28/1.239 phiếu
    --   (2,3 %). Đó là hạng mục của slice sau, không phải của Slice −1.
    -- (v_is_super / v_is_owner đã tính ở trên — chúng còn phải đi vào payload
    -- cảnh báo trùng dưới dạng `can_force`.)
    IF NOT (v_is_super OR v_is_owner) THEN
      RAISE EXCEPTION
        '[FIXED_FEE_FORCE_DENIED] "Đóng thêm" (ghi đè chốt chống trùng) chỉ dành cho chủ tổ chức hoặc super admin. Kỳ này đang có % phiếu đã duyệt, tổng %đ. Hãy duyệt/huỷ phiếu cũ, hoặc nhờ chủ tổ chức bấm. Nếu kỳ này thực sự chưa có phiếu nào thì bấm "Đóng" bình thường.',
        v_dup_cnt::text,
        round(COALESCE(v_dup_amt, 0))::bigint::text
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_dup_cnt > 0 THEN
    -- `can_force`: MỘT định nghĩa duy nhất của "được đóng thêm", do server phát
    -- ngôn. Giao diện chỉ dùng nó để quyết định mở hộp thoại "Đóng thêm" hay chỉ
    -- báo lỗi — nó KHÔNG phải hàng rào (hàng rào là nhánh `IF p_force` ở trên,
    -- siết theo ĐÚNG org của toà). Client cũ không đọc khoá này vẫn chạy nguyên.
    RETURN jsonb_build_object(
      'warning', 'duplicate',
      'existing_count', v_dup_cnt,
      'existing_amount', v_dup_amt,
      'can_force', (v_is_super OR v_is_owner));
  END IF;

  -- Sổ ghi chi
  IF p_account_id IS NOT NULL THEN
    SELECT id INTO v_acc FROM accounts
     WHERE id = p_account_id AND deleted_at IS NULL
       AND (user_id = auth.uid() OR public.is_admin() OR public.is_super_admin());
    IF v_acc IS NULL THEN
      RAISE EXCEPTION 'Sổ quỹ không hợp lệ hoặc bạn không có quyền ghi chi vào sổ này' USING ERRCODE = '42501';
    END IF;
  ELSE
    -- 31/08 (audit P2-07): ưu tiên SỔ MẶC ĐỊNH toà×hạng mục chủ đã cấu hình
    -- (building_fee_accounts.default_account_id — chính hàm này học first-write-
    -- wins ở INSERT bên dưới) TRƯỚC heuristic tên '%Thu'. Trang CHI tiền nhảy
    -- vào sổ tên "Thu" là nghịch nghĩa; sổ mặc định vẫn phải qua đúng vị ngữ
    -- quyền dùng sổ như nhánh p_account_id (không mượn sổ user khác trừ admin).
    SELECT a.id INTO v_acc
      FROM building_fee_accounts fa
      JOIN accounts a ON a.id = fa.default_account_id AND a.deleted_at IS NULL
     WHERE fa.building_id = p_building_id AND fa.fee_category = p_category_key
       AND fa.deleted_at IS NULL
       AND (a.user_id = auth.uid() OR public.is_admin() OR public.is_super_admin());
    IF v_acc IS NULL THEN
      SELECT id INTO v_acc FROM accounts
       WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'
       ORDER BY is_default DESC NULLS LAST, name LIMIT 1;
    END IF;
    IF v_acc IS NULL THEN
      RAISE EXCEPTION 'Chọn sổ quỹ trước khi đóng — bạn chưa có sổ mặc định cho ô này (chọn sổ ngay trên dòng, hoặc cấu hình sổ mặc định của toà ở Cài đặt phí).';
    END IF;
  END IF;

  v_type := public.resolve_fixed_expense_type(v_owner, p_category_key);
  UPDATE income_expense_types SET is_deposit = FALSE
   WHERE id = v_type AND is_deposit IS DISTINCT FROM FALSE;

  v_vdate  := COALESCE(p_voucher_date, public.org_today_v1(NULL));
  v_period := CASE WHEN p_period_start = p_period_end
                   THEN to_char(v_p_start, 'MM/YYYY')
                   ELSE to_char(v_p_start, 'MM/YYYY') || '–' || to_char(v_p_end, 'MM/YYYY') END;

  v_label := CASE p_category_key
    WHEN 'tien_nha'  THEN 'Tiền nhà'
    WHEN 'dien'      THEN 'Điện'
    WHEN 'nuoc'      THEN 'Nước'
    WHEN 'internet'  THEN 'Internet'
    WHEN 'quan_ly'   THEN 'Quản lý'
    WHEN 've_sinh'   THEN 'Vệ sinh tòa nhà'
    WHEN 'cong_an'   THEN 'Công an'
    WHEN 'rac'       THEN 'Rác'
    WHEN 'thang_may' THEN 'Bảo trì thang máy'
  END;

  SELECT COALESCE(full_name, '') INTO v_caller FROM profiles WHERE id = auth.uid();

  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name,
     attachments, system_source)
  VALUES
    (auth.uid(), 'EXPENSE',
     v_label || ' — kỳ ' || v_period,
     p_building_id, v_acc, v_vdate,
     p_amount, 'UNAPPROVED', TRUE,
     'Đóng ' || lower(v_label) || ' — kỳ ' || v_period
       || COALESCE(' — mã ' || NULLIF(btrim(p_provider_code), ''), '')
       || COALESCE(' — ' || NULLIF(btrim(p_account_holder), ''), ''),
     v_caller,
     COALESCE(p_attachments, '[]'::jsonb), 'fixed_fee')
  RETURNING id INTO v_voucher;

  -- p_amount = TỔNG cả khoảng (đã chốt); accrual chia đều theo start/end.
  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES
    (v_voucher, v_type, v_label || ' kỳ ' || v_period, 1, p_amount, v_p_start, v_p_end);

  -- Học cấu hình: default_amount PER-KỲ + sổ mặc định (first-write-wins cho sổ)
  INSERT INTO building_fee_accounts
    (building_id, fee_category, provider_code, account_holder, default_amount, default_account_id, user_id)
  VALUES
    (p_building_id, p_category_key,
     NULLIF(btrim(p_provider_code), ''), NULLIF(btrim(p_account_holder), ''),
     NULL, v_acc, v_owner)
  ON CONFLICT (building_id, fee_category) WHERE deleted_at IS NULL
  DO UPDATE SET
    provider_code      = COALESCE(NULLIF(btrim(EXCLUDED.provider_code), ''),  building_fee_accounts.provider_code),
    account_holder     = COALESCE(NULLIF(btrim(EXCLUDED.account_holder), ''), building_fee_accounts.account_holder),
    default_amount     = COALESCE(EXCLUDED.default_amount, building_fee_accounts.default_amount),
    default_account_id = COALESCE(building_fee_accounts.default_account_id, EXCLUDED.default_account_id),
    updated_at = now();

  -- Slice −1 B3: mọi lần "Đóng thêm" đều để lại vết, kể cả khi đo ra 0 phiếu.
  IF p_force THEN
    INSERT INTO app_private.period_fee_force_events
      (organization_id, building_id, category_key, period_start, period_end,
       amount, existing_count, existing_amount, voucher_id,
       actor_user_id, actor_is_super_admin, actor_is_org_owner)
    VALUES
      (v_org, p_building_id, p_category_key, p_period_start, p_period_end,
       p_amount, COALESCE(v_dup_cnt, 0), COALESCE(v_dup_amt, 0), v_voucher,
       auth.uid(), v_is_super, v_is_owner);
  END IF;

  -- SPECIAL_FEE_AUTOPOST_V1: đúng luật thì máy duyệt hộ và ghi sổ luôn.
  --   VALID           = số tiền khớp giá chủ đã công bố cho đúng các tháng của kỳ.
  --   CONFIG_REQUIRED = chủ chưa công bố giá ô này ⇒ GIỮ NGUYÊN HÀNH VI CŨ (vẫn
  --                     tự duyệt). Cố ý không chặn: hôm nay còn rất nhiều ô chưa
  --                     khai giá, chặn cứng là cả hệ hết đóng tiền được.
  --   AMOUNT_MISMATCH = đã công bố giá mà số đang chi lệch ⇒ để phiếu CHỜ DUYỆT.
  v_rule := app_private.special_fee_rule_check_v1(
              v_org, p_building_id, p_category_key, v_p_start, v_p_end, p_amount);
  v_verdict := v_rule->>'verdict';

  IF v_verdict IN ('VALID', 'CONFIG_REQUIRED') THEN
    v_posting := app_private.special_fee_approve_and_post_v1(v_voucher, 'SPECIAL_PAGE_FEE');
  END IF;

  SELECT code, total_amount INTO v_code, v_total FROM income_expenses WHERE id = v_voucher;

  RETURN jsonb_build_object(
    'voucher_id', v_voucher, 'code', v_code,
    'total_amount', v_total, 'account_id', v_acc,
    'rule', v_rule,
    'auto_approved', (v_posting IS NOT NULL),
    'posting_id', v_posting,
    'status_note', CASE
      WHEN v_posting IS NOT NULL AND v_verdict = 'VALID'
        THEN 'Đúng giá đã công bố — phiếu đã duyệt và vào sổ.'
      WHEN v_posting IS NOT NULL
        THEN 'Toà này chưa công bố giá cho hạng mục — phiếu vẫn được duyệt và vào sổ như trước.'
      ELSE COALESCE(v_rule->>'reason', 'Phiếu đang chờ duyệt.')
           || ' Phiếu đã tạo và đang CHỜ DUYỆT.'
    END);
END;
$_$;

COMMENT ON FUNCTION public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean) IS
  'Đóng phí cố định theo kỳ cho toà (1 phiếu CHI). Slice −1: p_force ("Đóng thêm") '
  'chỉ mở cho chủ tổ chức / super admin và luôn ghi app_private.period_fee_force_events. '
  '31/08: kẹp kỳ ≤ 36 tháng khớp client; sổ mặc định ưu tiên '
  'building_fee_accounts.default_account_id trước heuristic tên "%Thu". Không đụng dữ liệu lịch sử.';

-- ─────────────────────────────────────────────────────────────────────
-- (4) get_period_fee_status — vouchers[] thêm 'updated_at' (token CAS).
-- Thân chép NGUYÊN VĂN bản đang chạy; đúng 3 dòng thêm, đánh dấu "31/08".
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_period_fee_status(p_period_start text, p_period_end text, p_building_ids uuid[], p_category_keys text[]) RETURNS TABLE(building_id uuid, category_key text, paid_amount numeric, draft_amount numeric, covered_start date, covered_end date, voucher_ids uuid[], vouchers jsonb, has_receipt boolean, account_name text, account_is_empty boolean, expected_amount numeric, not_applicable boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_start          date;
  v_end            date;
  v_can_restricted boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_period_start !~ '^\d{4}-\d{2}$' OR p_period_end !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Kỳ không hợp lệ (cần YYYY-MM)';
  END IF;
  v_start := to_date(p_period_start || '-01', 'YYYY-MM-DD');
  v_end   := (date_trunc('month', to_date(p_period_end || '-01', 'YYYY-MM-DD')) + interval '1 month - 1 day')::date;
  v_can_restricted := public.can_view_restricted_ie();

  RETURN QUERY
  WITH bld AS (
    SELECT b.id, b.hidden_fixed_expenses AS hidden
      FROM buildings b
     WHERE b.id = ANY(p_building_ids) AND b.deleted_at IS NULL
       AND app_private.building_org_visible_v1(b.id)
       AND (public.can_access_building(b.id)
            OR public.ie_all_buildings_scope(b.id)
            OR b.user_id = auth.uid()
            OR public.is_admin() OR public.is_super_admin())
  ),
  -- DISTINCT: p_category_keys trùng lặp không được nhân đôi tổng item (A2).
  cat AS (
    SELECT DISTINCT k FROM unnest(p_category_keys) AS k
     WHERE k IN ('tien_nha','dien','nuoc','internet','quan_ly','ve_sinh','cong_an','rac','thang_may')
  ),
  pairs AS (
    SELECT bld.id AS building_id, cat.k AS category_key,
           cat.k = ANY(bld.hidden) AS is_na
      FROM bld CROSS JOIN cat
  ),
  -- DISTINCT: một kind có thể khớp nhiều type; mỗi (kind, type) chỉ được một dòng.
  typed AS (
    SELECT DISTINCT c.k AS category_key, t.id AS type_id
      FROM cat c
      JOIN income_expense_types t
        ON t.type = 'expense'
       AND public.fee_type_matches(c.k, t.category, t.name)
     WHERE (NOT t.is_restricted OR v_can_restricted)
  ),
  vperv AS (
    SELECT p.building_id, p.category_key,
           ie.id            AS vid,
           -- A2: TỔNG HẠNG MỤC KHỚP kind này, KHÔNG phải tổng cả phiếu.
           SUM(it.amount)   AS amount,
           ie.total_amount  AS vtotal,
           ie.approval_status AS st,
           ie.posting_status  AS pstatus,
           ie.system_source AS source,
           ie.voucher_date  AS vdate,
           ie.updated_at    AS vupdated,  -- 31/08: token CAS cho update_period_fee
           ie.account_id    AS acc_id,
           a.name           AS acc_name,
           ie.attachments   AS atts,
           ie.notes         AS vnotes,
           ie.creator_name  AS vcreator,
           (ie.repeat_parent_id IS NOT NULL
             OR public.nrm_vn(ie.name) LIKE '%tu dong%') AS is_auto,
           EXISTS (SELECT 1 FROM income_expense_batch_items bi WHERE bi.income_expense_id = ie.id) AS in_batch,
           -- A2: phiếu có chủ luồng ⇒ guard_income_expense_owned_payload chặn
           -- UPDATE deleted_at bằng 55000 ⇒ KHÔNG được coi là huỷ được.
           EXISTS (SELECT 1 FROM app_private.income_expense_flow_ownership o
                    WHERE o.income_expense_id = ie.id) AS flow_owned,
           min(it.start_date) AS cstart,
           max(it.end_date)   AS cend,
           count(it.id)       AS item_cnt
      FROM pairs p
      JOIN typed ty ON ty.category_key = p.category_key
      JOIN income_expense_items it ON it.income_expense_type_id = ty.type_id
      JOIN income_expenses ie ON ie.id = it.income_expense_id
                             AND ie.building_id = p.building_id
                             AND ie.type = 'EXPENSE'
                             AND ie.approval_status IN ('APPROVED','UNAPPROVED')
                             AND ie.deleted_at IS NULL
                             -- A1/§−1.3 lưới hai: tiền lương không phải phí cố định.
                             AND COALESCE(ie.system_source, '') NOT LIKE 'salary.%'
      LEFT JOIN accounts a ON a.id = ie.account_id
     WHERE it.start_date <= v_end AND it.end_date >= v_start
     GROUP BY p.building_id, p.category_key, ie.id, ie.total_amount, ie.approval_status,
              ie.posting_status, ie.system_source, ie.voucher_date, ie.updated_at, ie.account_id, a.name,
              ie.attachments, ie.notes, ie.creator_name, ie.name, ie.repeat_parent_id
  )
  SELECT
    p.building_id,
    p.category_key,
    COALESCE(SUM(v.amount) FILTER (WHERE v.st = 'APPROVED'), 0)                    AS paid_amount,
    COALESCE(SUM(v.amount) FILTER (WHERE v.st = 'UNAPPROVED'), 0)                  AS draft_amount,
    MIN(v.cstart) FILTER (WHERE v.st = 'APPROVED')                                 AS covered_start,
    MAX(v.cend)   FILTER (WHERE v.st = 'APPROVED')                                 AS covered_end,
    COALESCE(array_agg(v.vid ORDER BY v.vdate DESC, v.vid) FILTER (WHERE v.vid IS NOT NULL), '{}'::uuid[]) AS voucher_ids,
    COALESCE(jsonb_agg(jsonb_build_object(
        'id', v.vid,
        -- 'amount' = phần thuộc hạng mục này (A2). 'voucher_total' = cả phiếu.
        'amount', v.amount,
        'voucher_total', v.vtotal,
        'status', v.st,
        'posting_status', v.pstatus,
        'date', v.vdate,
        'updated_at', v.vupdated,  -- 31/08: client seed vào p_expected_updated_at
        'source', v.source,
        'is_auto', v.is_auto,
        'in_batch', v.in_batch,
        'flow_owned', v.flow_owned,
        'cancellable', (NOT v.in_batch AND NOT v.flow_owned),
        'cancel_blocked_reason', CASE WHEN v.in_batch THEN 'IN_BATCH'
                                      WHEN v.flow_owned THEN 'FLOW_OWNED'
                                      ELSE NULL END,
        'account_id', v.acc_id,
        'account_name', v.acc_name,
        'attachments', COALESCE(v.atts, '[]'::jsonb),
        'notes', v.vnotes,
        'item_count', v.item_cnt,
        'start', v.cstart,
        'end', v.cend,
        'creator_name', v.vcreator
      ) ORDER BY v.vdate DESC, v.vid) FILTER (WHERE v.vid IS NOT NULL), '[]'::jsonb) AS vouchers,
    COALESCE(bool_or(jsonb_typeof(v.atts) = 'array' AND jsonb_array_length(v.atts) > 0), false) AS has_receipt,
    (array_agg(v.acc_name ORDER BY v.vdate DESC) FILTER (WHERE v.st = 'APPROVED' AND v.acc_name IS NOT NULL))[1] AS account_name,
    COALESCE(bool_or(v.st = 'APPROVED' AND v.acc_id IS NULL), false)               AS account_is_empty,
    CASE WHEN p.category_key = 'quan_ly' AND NOT v_can_restricted THEN NULL
         ELSE MAX(fa.default_amount) END                                           AS expected_amount,
    p.is_na                                                                        AS not_applicable
  FROM pairs p
  LEFT JOIN vperv v ON v.building_id = p.building_id AND v.category_key = p.category_key
  LEFT JOIN building_fee_accounts fa ON fa.building_id = p.building_id
                                    AND fa.fee_category = p.category_key
                                    AND fa.deleted_at IS NULL
  GROUP BY p.building_id, p.category_key, p.is_na;
END;
$_$;

DO $selfcheck$
DECLARE v_cnt int;
BEGIN
  -- Mỗi hàm ĐÚNG MỘT chữ ký (án lệ overload PostgREST).
  FOR v_cnt IN
    SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'update_period_fee'
  LOOP
    IF v_cnt <> 1 THEN RAISE EXCEPTION 'update_period_fee có % chữ ký (kỳ vọng 1). DỪNG.', v_cnt; END IF;
  END LOOP;
  IF to_regprocedure('public.update_period_fee(uuid,uuid,jsonb,numeric,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Chữ ký CŨ 7 tham số của update_period_fee vẫn còn — DROP hỏng. DỪNG.';
  END IF;
  IF to_regprocedure('public.update_period_fee(uuid,uuid,jsonb,numeric,text,text,text,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'Chữ ký MỚI 8 tham số của update_period_fee chưa có. DỪNG.';
  END IF;
  IF NOT has_function_privilege('authenticated',
        'public.update_period_fee(uuid,uuid,jsonb,numeric,text,text,text,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated không chạy được update_period_fee mới. DỪNG.';
  END IF;
  IF has_function_privilege('anon',
        'public.update_period_fee(uuid,uuid,jsonb,numeric,text,text,text,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon chạy được update_period_fee — REVOKE hỏng. DỪNG.';
  END IF;
  IF has_function_privilege('anon',
        'public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon chạy được pay_period_fee — ACL trôi. DỪNG.';
  END IF;
  IF has_function_privilege('anon',
        'public.get_period_fee_status(text,text,uuid[],text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon chạy được get_period_fee_status — ACL trôi. DỪNG.';
  END IF;
END
$selfcheck$;

COMMIT;
