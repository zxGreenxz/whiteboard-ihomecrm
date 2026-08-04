-- =====================================================================
-- ĐỢT 2 (kế hoạch 31/07) — LÕI "ĐÚNG LUẬT THÌ TỰ DUYỆT + VÀO SỔ"
--
-- Quyết định của chủ 31/07/2026:
--   1. Trên /thanh-toan: đúng rule cài sẵn ⇒ TỰ DUYỆT + VÀO SỔ luôn.
--      Lệch rule ⇒ phiếu ra CHỜ DUYỆT như bình thường.
--   2. /thu-chi GIỮ NGUYÊN mọi quy tắc hiện có. File này không đụng.
--
-- Ba việc, theo đúng thứ tự phụ thuộc:
--
--   A. GIÁ CHỦ KHAI PHẢI SỐNG SÓT. Hôm nay `building_fee_accounts.default_amount`
--      vừa là chỗ trang Cài đặt ghi giá công bố, VỪA bị `pay_period_fee` ghi đè
--      bằng round(số tiền vừa chi / số tháng) SAU MỖI LẦN CHI. Nghĩa là chủ khai
--      500.000đ, ai đó chi 9.507.910đ, thì "giá đã khai" âm thầm thành 9.507.910đ
--      — và mọi phép so "đúng giá chưa" sau đó là TỰ KHỚP CHÍNH MÌNH, vô nghĩa.
--      (Đo được trên prod: toà 1eae0e82… fee_category='dien' đang mang
--      default_amount = 9.507.910 — đó là một hoá đơn điện cũ, không phải mức phí.)
--      ⇒ Dựng bảng giá CÓ PHIÊN BẢN THEO THÁNG mà đường chi không ghi vào được,
--        và gỡ mệnh đề ghi đè khỏi pay_period_fee.
--
--   B. MÁY KIỂM RULE. Trả lời đúng một câu: "số tiền này có khớp giá đã khai cho
--      đúng những tháng này không?". Ba kết quả:
--        CONFIG_REQUIRED — chưa khai giá  ⇒ GIỮ NGUYÊN HÀNH VI CŨ (vẫn tự duyệt).
--                          Cố ý không fail-closed: 0/21 toà khai đủ 7 loại, chặn
--                          cứng là cả 21 toà hết đóng được tiền ngay hôm nay.
--        VALID           — khớp tuyệt đối ⇒ tự duyệt + vào sổ.
--        AMOUNT_MISMATCH — đã khai giá mà lệch ⇒ CHỜ DUYỆT (đây là phần MỚI).
--
--   C. ADAPTER GHI SỔ CÓ XUẤT XỨ. Hôm nay phiếu sinh ra ở trạng thái APPROVED bị
--      cầu `a85b` (AFTER INSERT) tự ghi sổ với source_kind='LEGACY_BRIDGE' và
--      KHÔNG có khoá replay ngoài. Adapter này thay chỗ đó:
--        phiếu sinh ra UNAPPROVED → đặt token FINANCE_V2_LIFECYCLE (tắt cầu a85/
--        a85b cho đúng transaction này) → lật APPROVED → gọi lõi dùng chung
--        finance_v2_post_voucher_with_source_v1 (source_kind='SPECIAL_PAGE_FEE',
--        khoá replay theo chính phiếu) → đóng dấu posting_status/active_posting_id_v2.
--
-- VÌ SAO PHIẾU KHÔNG ĐƯỢC "FLOW-OWNED": kế hoạch gốc định gắn ownership cho phiếu
-- phí cố định. KHÔNG LÀM, vì ownership làm 11 RPC vòng đời chung ném 42501 ⇒ đúng
-- nhánh "lệch rule thì chờ duyệt" sẽ chết ngay tại nút Duyệt ở /thu-chi, phá thẳng
-- quyết định số 2 của chủ. Phiếu ở đây là PHIẾU THƯỜNG, chỉ khác ở chỗ được máy
-- duyệt hộ khi rule xanh.
--
-- KHÔNG đụng một đồng dữ liệu cũ. Không migration nào ở đây sửa/huỷ/đảo phiếu.
-- =====================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 0. PREFLIGHT — mọi thứ file này dựa vào phải có thật, đúng chữ ký
-- ─────────────────────────────────────────────────────────────────────
DO $preflight$
BEGIN
  IF to_regprocedure('app_private.finance_v2_post_voucher_with_source_v1(uuid,uuid,text,text,uuid,uuid,date,text,bigint)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu lõi ghi sổ dùng chung finance_v2_post_voucher_with_source_v1. DỪNG.';
  END IF;
  IF to_regprocedure('public.org_today_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu org_today_v1. DỪNG.';
  END IF;
  IF to_regclass('public.building_fee_accounts') IS NULL THEN
    RAISE EXCEPTION 'Thiếu building_fee_accounts. DỪNG.';
  END IF;
  IF to_regclass('app_private.ie_transition_authorization') IS NULL THEN
    RAISE EXCEPTION 'Thiếu ie_transition_authorization — không tắt được cầu a85. DỪNG.';
  END IF;
  -- Cầu a85 phải còn nhận diện token theo purpose. Nếu ai đó đổi cơ chế này mà
  -- file vẫn đặt token thì adapter sẽ để cầu VŨ TRANG ⇒ ghi sổ tiền HAI LẦN.
  IF position('FINANCE_V2_LIFECYCLE' IN
        (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'app_private' AND p.proname = 'finance_v2_auto_posting_bridge')) = 0 THEN
    RAISE EXCEPTION
      'Cầu a85 KHÔNG còn tắt theo token FINANCE_V2_LIFECYCLE — adapter sẽ sinh bút toán trùng. DỪNG.';
  END IF;
  IF position('FINANCE_V2_LIFECYCLE' IN
        (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'app_private' AND p.proname = 'finance_v2_auto_posting_bridge_insert')) = 0 THEN
    RAISE EXCEPTION
      'Cầu a85b KHÔNG còn tắt theo token FINANCE_V2_LIFECYCLE — adapter sẽ sinh bút toán trùng. DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- A1. BẢNG GIÁ CÓ PHIÊN BẢN
--
-- Khoá theo THÁNG HIỆU LỰC, đúng luật chủ đã chốt: "đổi giá phải chọn áp dụng
-- từ tháng nào, không sửa kỳ/phiếu cũ". Đổi giá = thêm một dòng mới, dòng cũ ở
-- nguyên để mọi phiếu tháng trước vẫn đối chiếu được với giá của CHÍNH tháng đó.
--
-- Nằm trong app_private: đường chi (pay_period_fee) không được với tới. Đó là
-- cả mục đích của bảng này.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_private.special_fee_price_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  building_id          uuid NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  fee_category         text NOT NULL,
  effective_from_month date NOT NULL,
  amount               numeric(15,2) NOT NULL CHECK (amount > 0),
  status               text NOT NULL DEFAULT 'PUBLISHED'
                         CHECK (status IN ('PUBLISHED','RETIRED')),
  source               text NOT NULL DEFAULT 'OWNER'
                         CHECK (source IN ('OWNER','SEED_FROM_CONFIG')),
  note                 text,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  retired_at           timestamptz,
  CONSTRAINT sfpv_category_chk CHECK (fee_category IN
    ('tien_nha','dien','nuoc','internet','quan_ly','ve_sinh','cong_an','rac','thang_may')),
  CONSTRAINT sfpv_month_first_day CHECK (effective_from_month = date_trunc('month', effective_from_month)::date),
  CONSTRAINT sfpv_retire_shape CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL))
);

-- Một ô × một tháng hiệu lực chỉ có MỘT giá đang công bố.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sfpv_slot_effective
  ON app_private.special_fee_price_versions
     (organization_id, building_id, fee_category, effective_from_month)
  WHERE status = 'PUBLISHED';

CREATE INDEX IF NOT EXISTS idx_sfpv_lookup
  ON app_private.special_fee_price_versions
     (organization_id, building_id, fee_category, effective_from_month DESC)
  WHERE status = 'PUBLISHED';

REVOKE ALL ON app_private.special_fee_price_versions
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.special_fee_price_versions IS
  'Giá công bố của phí cố định, CÓ PHIÊN BẢN THEO THÁNG. Cố ý nằm ngoài tầm với '
  'của pay_period_fee: building_fee_accounts.default_amount bị đường chi ghi đè '
  'mỗi lần chi nên không dùng làm giá chuẩn được (nó là ký ức lần chi gần nhất). '
  'Đổi giá = thêm dòng mới với effective_from_month sau, KHÔNG sửa dòng cũ.';

-- ─────────────────────────────────────────────────────────────────────
-- A2. CỐ Ý KHÔNG GIEO GIÁ TỰ ĐỘNG — bảng ra đời RỖNG
--
-- Bản nháp file này từng gieo giá từ `building_fee_accounts.default_amount`.
-- ĐÃ BỎ, vì một đợt kiểm toán chạy trên chính dữ liệu prod ngày 31/07 chứng
-- minh cột đó KHÔNG DÙNG ĐƯỢC làm giá công bố:
--
--   • Toà 405PVB, hạng mục công an: cột đang lưu **7.000đ**, trong khi giá
--     thật đo từ phiếu chi là **500.000đ/tháng**. 7.000đ là số còn sót của một
--     phiếu "Làm tạm trú" — loại phí tính theo ĐẦU NGƯỜI, không phải phí tháng.
--   • Toà 1eae0e82…, hạng mục điện: cột đang lưu **9.507.910đ** — đó là một
--     hoá đơn điện cũ.
--   Nguyên nhân chung: `pay_period_fee` ghi đè cột này sau mỗi lần chi (đã gỡ
--   ở migration 20260801011000).
--
-- Gieo dữ liệu bẩn vào đây thì máy kiểm rule sẽ đối chiếu với số sai: 405PVB
-- đóng đúng 500.000đ sẽ bị coi là LỆCH GIÁ và rơi vào chờ duyệt, còn ai đóng
-- 7.000đ lại được tự duyệt. Sai hướng nguy hiểm.
--
-- ⇒ Bảng rỗng ⇒ mọi ô trả CONFIG_REQUIRED ⇒ HÀNH VI HỆ THỐNG KHÔNG ĐỔI MỘT LY
--   so với hôm nay. Luật chỉ bật lên cho từng ô, đúng lúc chủ công bố giá ô đó
--   qua `public.set_special_fee_price_v1`. Đây là cách bật an toàn nhất: không
--   có "ngày X mọi thứ đổi", chỉ có từng ô sáng dần khi chủ duyệt.
-- ─────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────
-- A3. TRA GIÁ CỦA MỘT THÁNG
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.special_fee_price_for_v1(
  p_org      uuid,
  p_building uuid,
  p_kind     text,
  p_month    date
)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT v.amount
    FROM app_private.special_fee_price_versions v
   WHERE v.organization_id = p_org
     AND v.building_id     = p_building
     AND v.fee_category    = p_kind
     AND v.status          = 'PUBLISHED'
     AND v.effective_from_month <= date_trunc('month', p_month)::date
   ORDER BY v.effective_from_month DESC
   LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION app_private.special_fee_price_for_v1(uuid,uuid,text,date)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.special_fee_price_for_v1(uuid,uuid,text,date) IS
  'Giá công bố có hiệu lực cho THÁNG chỉ định. NULL = chủ chưa khai giá ô này.';

-- ─────────────────────────────────────────────────────────────────────
-- B. MÁY KIỂM RULE
--
-- Kỳ trải nhiều tháng thì kỳ vọng = TỔNG giá của từng tháng trong khoảng, nên
-- một lần đổi giá giữa kỳ vẫn tính đúng. Thiếu giá dù chỉ MỘT tháng trong
-- khoảng ⇒ CONFIG_REQUIRED cho cả kỳ (không suy diễn bù bằng tháng khác).
--
-- So khớp: round(…, 2) hai vế rồi so BẰNG TUYỆT ĐỐI. Cố ý không có dung sai —
-- "gần đúng" trên tiền là cách lỗi lọt qua.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.special_fee_rule_check_v1(
  p_org          uuid,
  p_building     uuid,
  p_kind         text,
  p_period_start date,
  p_period_end   date,
  p_amount       numeric
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_m        date;
  v_price    numeric;
  v_expected numeric := 0;
  v_months   int := 0;
  v_missing  int := 0;
BEGIN
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_end < p_period_start THEN
    RETURN jsonb_build_object('verdict','CONFIG_REQUIRED','reason','Kỳ không hợp lệ');
  END IF;

  -- Giá công bố là mức THEO THÁNG, nên chỉ so được khi kỳ phủ TRỌN các tháng.
  -- Kỳ lẻ (vd 15/06→14/07) không quy ra "mấy tháng" một cách không mập mờ: đếm
  -- theo tháng lịch sẽ ra 2 và đòi gấp đôi tiền cho một kỳ dài 30 ngày.
  -- ⇒ Trả CONFIG_REQUIRED = giữ nguyên hành vi cũ, không tự duyệt, không chặn.
  IF p_period_start <> date_trunc('month', p_period_start)::date
     OR p_period_end <> (date_trunc('month', p_period_end) + interval '1 month - 1 day')::date THEN
    RETURN jsonb_build_object(
      'verdict','CONFIG_REQUIRED',
      'reason','Kỳ không trọn tháng nên không đối chiếu được với giá công bố (giá công bố tính theo tháng)');
  END IF;

  -- Trần vòng lặp: kỳ nhập sai kiểu 1900→2099 sẽ quay 2.400 vòng trong lúc
  -- đang giữ khoá phiếu. 120 tháng (10 năm) là quá đủ cho mọi kỳ phí thật.
  IF (date_trunc('month', p_period_end)::date - date_trunc('month', p_period_start)::date) > 3700 THEN
    RETURN jsonb_build_object(
      'verdict','CONFIG_REQUIRED',
      'reason','Kỳ dài bất thường (trên 10 năm) — không đối chiếu tự động');
  END IF;

  v_m := date_trunc('month', p_period_start)::date;
  WHILE v_m <= date_trunc('month', p_period_end)::date LOOP
    v_months := v_months + 1;
    v_price  := app_private.special_fee_price_for_v1(p_org, p_building, p_kind, v_m);
    IF v_price IS NULL THEN
      v_missing := v_missing + 1;
    ELSE
      v_expected := v_expected + v_price;
    END IF;
    v_m := (v_m + interval '1 month')::date;
  END LOOP;

  IF v_missing > 0 THEN
    RETURN jsonb_build_object(
      'verdict','CONFIG_REQUIRED',
      'months', v_months,
      'missing_months', v_missing,
      'reason','Chưa khai giá ở Cài đặt → Phí cố định cho ' || v_missing || '/' || v_months || ' tháng của kỳ này');
  END IF;

  IF round(COALESCE(p_amount,0), 2) = round(v_expected, 2) THEN
    RETURN jsonb_build_object(
      'verdict','VALID', 'months', v_months, 'expected', round(v_expected,2));
  END IF;

  -- Định dạng số kiểu Việt Nam: dấu CHẤM ngăn nghìn. to_char mặc định theo
  -- lc_numeric của máy chủ (đang là kiểu Anh, cho ra "9,507,910đ") — người Việt
  -- đọc dấu phẩy là dấu thập phân nên câu thông báo sẽ gây hiểu nhầm số tiền.
  RETURN jsonb_build_object(
    'verdict','AMOUNT_MISMATCH',
    'months', v_months,
    'expected', round(v_expected,2),
    'actual',   round(COALESCE(p_amount,0),2),
    'reason', format('Giá đã công bố cho kỳ này là %sđ, số đang chi là %sđ',
                     replace(to_char(round(v_expected), 'FM999G999G999G999'), ',', '.'),
                     replace(to_char(round(COALESCE(p_amount,0)), 'FM999G999G999G999'), ',', '.')));
END;
$fn$;

REVOKE ALL ON FUNCTION app_private.special_fee_rule_check_v1(uuid,uuid,text,date,date,numeric)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.special_fee_rule_check_v1(uuid,uuid,text,date,date,numeric) IS
  'Số tiền có khớp giá đã khai cho đúng những tháng của kỳ không? VALID = tự duyệt '
  'được; AMOUNT_MISMATCH = phải chờ người duyệt; CONFIG_REQUIRED = chưa khai giá, '
  'giữ nguyên hành vi cũ (KHÔNG chặn — 0/21 toà khai đủ, chặn là cả hệ hết chi được).';

-- ─────────────────────────────────────────────────────────────────────
-- C. ADAPTER — duyệt hộ rồi ghi sổ CÓ XUẤT XỨ
--
-- Thứ tự bên trong là bản thân tính đúng đắn, đọc kỹ trước khi sửa:
--
--   (1) Khoá phiếu. Hai lượt bấm song song phải xếp hàng ở đây.
--   (2) Đã ghi sổ rồi thì TRẢ LẠI bút toán cũ, không làm gì thêm (replay).
--   (3) Đặt token FINANCE_V2_LIFECYCLE cho ĐÚNG transaction này. Đây là cú tắt
--       cầu a85/a85b. Thiếu bước này thì lệnh UPDATE ở (4) làm cầu tự đúc một
--       posting LEGACY_BRIDGE, rồi lõi ở (5) đúc thêm một cái nữa ⇒ TIỀN VÀO SỔ
--       HAI LẦN. Đây là lỗi tốn kém nhất có thể xảy ra trong file này.
--   (4) Lật APPROVED. Ba lớp khoá kỳ (chốt sổ quỹ / bàn giao / chốt lợi nhuận)
--       nằm ở trigger và sẽ tự chặn ở đây nếu kỳ đã khoá — CỐ Ý không kiểm trước,
--       để chỉ có MỘT nơi phán quyết chuyện khoá kỳ.
--   (5) Gọi lõi dùng chung. Lõi tự lo MAIN + CHANGE + ROUNDING, tự kiểm kỳ lần
--       nữa, tự chống replay theo (external_kind, external_id).
--   (6) Đóng dấu con trỏ posting lên phiếu. Token vẫn còn nên cầu vẫn im.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.special_fee_approve_and_post_v1(
  p_voucher_id  uuid,
  p_source_kind text DEFAULT 'SPECIAL_PAGE_FEE'
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_ie       public.income_expenses;
  v_acc      public.accounts;
  v_posting  uuid;
  v_actor    uuid := auth.uid();
  v_reversed boolean;
  v_mid      uuid;
BEGIN
  SELECT * INTO v_ie FROM public.income_expenses WHERE id = p_voucher_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu %', p_voucher_id USING ERRCODE = 'P0002';
  END IF;
  IF v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu % đã huỷ — không ghi sổ', p_voucher_id USING ERRCODE = '55000';
  END IF;

  -- ══ CHỐT LOẠI PHIẾU — hàng rào quan trọng nhất của hàm này ═════════
  -- Hàm này DUYỆT HỘ NGƯỜI DÙNG. Nó tuyệt đối không được chạm vào loại phiếu
  -- mà chủ đã quyết là phải có người duyệt:
  --   • Chủ chốt 31/07: "riêng HOÀN CỌC vẫn chờ duyệt kể cả khi số khớp".
  --   • Phiếu THU (INCOME) không thuộc phạm vi trang đóng phí.
  -- Không có chốt này thì bất kỳ writer nào lỡ gọi nhầm cũng tự duyệt được một
  -- phiếu hoàn cọc — đúng thứ chủ cấm.
  IF v_ie.type IS DISTINCT FROM 'EXPENSE' THEN
    RAISE EXCEPTION
      'Chỉ tự duyệt được phiếu CHI. Phiếu % là loại %.', p_voucher_id, COALESCE(v_ie.type,'(rỗng)')
      USING ERRCODE = '42501';
  END IF;
  IF COALESCE(v_ie.system_source, '') NOT IN ('special_fee.v1', 'fixed_fee', 'utility.bill') THEN
    RAISE EXCEPTION
      'Phiếu % không thuộc nhóm phí cố định của trang đóng tiền (nguồn: %) — không tự duyệt.',
      p_voucher_id, COALESCE(v_ie.system_source, '(không rõ)')
      USING ERRCODE = '42501';
  END IF;

  -- ══ (2) REPLAY — phải kiểm bút toán còn SỐNG, không chỉ còn con trỏ ══
  -- Bẫy đã đo được: nếu bút toán cũ ĐÃ BỊ ĐẢO thì trả con trỏ cũ ra rồi đóng
  -- dấu POSTED lên nó = phiếu nói "đã chi" trong khi sổ quỹ nói "chưa" — tiền
  -- biến mất khỏi tồn quỹ mà giao diện vẫn xanh. Phải phân biệt ba trạng thái.
  IF v_ie.active_posting_id_v2 IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.income_expense_postings r
       WHERE r.reversal_of_id = v_ie.active_posting_id_v2 AND r.event_kind = 'REVERSAL'
    ) INTO v_reversed;
    IF v_reversed THEN
      RAISE EXCEPTION
        'Phiếu % đã có bút toán bị ĐẢO — muốn ghi sổ lại phải qua đường ghi sổ lại có kiểm soát, không gọi lại hàm tự duyệt.',
        COALESCE(v_ie.code, p_voucher_id::text)
        USING ERRCODE = '55000';
    END IF;
    RETURN v_ie.active_posting_id_v2;
  END IF;

  -- Bút toán tồn tại theo khoá nguồn nhưng phiếu MẤT con trỏ (a85 xoá con trỏ
  -- khi đảo). Không được ghi đè POSTED lên đó.
  SELECT p.id INTO v_posting
    FROM public.income_expense_postings p
   WHERE p.organization_id = v_ie.organization_id
     AND p.external_source_kind = 'SPECIAL_FEE_VOUCHER'
     AND p.external_source_id   = p_voucher_id
     AND p.event_kind = 'POSTING';
  IF v_posting IS NOT NULL THEN
    RAISE EXCEPTION
      'Phiếu % đã từng được ghi sổ (bút toán %) nhưng con trỏ đã bị gỡ — cần rà tay, không tự ghi lại.',
      COALESCE(v_ie.code, p_voucher_id::text), v_posting
      USING ERRCODE = '55000';
  END IF;

  IF v_ie.account_id IS NULL THEN
    RAISE EXCEPTION 'Phiếu % chưa có sổ quỹ — không tự ghi sổ được', p_voucher_id
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_acc FROM public.accounts WHERE id = v_ie.account_id;
  IF NOT FOUND OR v_acc.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Sổ quỹ của phiếu % không còn hiệu lực', p_voucher_id USING ERRCODE = '22023';
  END IF;
  IF v_acc.organization_id IS DISTINCT FROM v_ie.organization_id THEN
    RAISE EXCEPTION 'Sổ quỹ khác tổ chức của phiếu %', p_voucher_id USING ERRCODE = '42501';
  END IF;

  -- (3) TẮT CẦU a85/a85b cho transaction này. Xem khối chú thích ở trên.
  INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  VALUES (p_voucher_id, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
  ON CONFLICT (income_expense_id) DO UPDATE
    SET xid = EXCLUDED.xid, purpose = EXCLUDED.purpose, granted_at = now();

  -- (4) Lật APPROVED nếu chưa. Trigger khoá kỳ sẽ tự lên tiếng ở đây.
  IF v_ie.approval_status IS DISTINCT FROM 'APPROVED' THEN
    UPDATE public.income_expenses
       SET approval_status = 'APPROVED',
           review_state    = 'RESOLVED',
           approved_by     = COALESCE(approved_by, v_actor, user_id),
           approved_at     = COALESCE(approved_at, now())
     WHERE id = p_voucher_id;
  END IF;

  -- ══ SỔ ẢO: DUYỆT NHƯNG KHÔNG GHI SỔ QUỸ ═══════════════════════════
  -- Sổ ảo (cấn cọc, cấn trừ) không có tiền ra khỏi két nên không có bút toán
  -- sổ quỹ. Bản nháp trước NÉM LỖI ở đây — sai, vì hôm nay đóng phí từ sổ ảo
  -- vẫn chạy được (cầu a85b tự bỏ qua sổ ảo và phiếu vẫn APPROVED). Ném lỗi là
  -- LẤY MẤT một năng lực đang có. Giữ đúng hành vi cũ: duyệt, không ghi sổ.
  IF COALESCE(v_acc.is_virtual, false) THEN
    UPDATE public.income_expenses
       SET posting_status = COALESCE(NULLIF(posting_status, 'UNPOSTED'), 'NOT_APPLICABLE'),
           updated_at = now()
     WHERE id = p_voucher_id;
    DELETE FROM app_private.ie_transition_authorization
     WHERE income_expense_id = p_voucher_id AND xid = pg_current_xact_id();
    RETURN NULL;
  END IF;

  -- Lõi đòi một membership để ghi "ai ghi sổ", và cột đó NOT NULL. Người tạo
  -- phiếu có thể đã rời tổ chức ⇒ lõi ném 23502 trần không ai hiểu. Chặn sớm
  -- bằng câu tiếng Việt.
  SELECT om.id INTO v_mid
    FROM public.organization_memberships om
   WHERE om.organization_id = v_ie.organization_id
     AND om.user_id = COALESCE(v_ie.approved_by, v_ie.user_id, v_actor)
     AND om.status = 'ACTIVE'
   LIMIT 1;
  IF v_mid IS NULL AND v_ie.maker_membership_id IS NULL THEN
    RAISE EXCEPTION
      'Không xác định được người ghi sổ cho phiếu % (người tạo không còn là thành viên đang hoạt động) — phiếu đã duyệt nhưng cần vào sổ tay.',
      COALESCE(v_ie.code, p_voucher_id::text)
      USING ERRCODE = '22023';
  END IF;

  -- (5) Lõi dùng chung. Khoá replay là chính phiếu này.
  v_posting := app_private.finance_v2_post_voucher_with_source_v1(
    p_org             => v_ie.organization_id,
    p_voucher_id      => p_voucher_id,
    p_source_kind     => p_source_kind,
    p_external_kind   => 'SPECIAL_FEE_VOUCHER',
    p_external_id     => p_voucher_id,
    p_external_line_id=> NULL,
    p_posted_on       => v_ie.voucher_date,
    p_amount_basis    => 'VOUCHER_TOTAL',
    p_generation      => 1
  );

  -- (6) Con trỏ posting. Token còn hiệu lực nên cầu vẫn im (và a85 không khai
  --     posting_status trong danh sách cột kích hoạt nên nó cũng không chạy).
  UPDATE public.income_expenses
     SET active_posting_id_v2 = v_posting,
         posting_id           = v_posting,
         posting_status       = 'POSTED',
         posting_mode         = COALESCE(posting_mode, 'CASHBOOK'),
         posted_at_v2         = now(),
         updated_at           = now()
   WHERE id = p_voucher_id;

  -- (7) TRẢ TOKEN. Mọi writer cùng họ đều dọn; để lại thì cầu a85 CÂM cho toàn
  --     bộ phần còn lại của transaction — một lệnh xoá/đổi tiền sau đó sẽ không
  --     sinh bút toán đảo, tiền kẹt lại trong sổ.
  DELETE FROM app_private.ie_transition_authorization
   WHERE income_expense_id = p_voucher_id AND xid = pg_current_xact_id();

  RETURN v_posting;
END;
$fn$;

REVOKE ALL ON FUNCTION app_private.special_fee_approve_and_post_v1(uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.special_fee_approve_and_post_v1(uuid,text) IS
  'Duyệt hộ + ghi sổ một phiếu phí cố định đã qua kiểm rule. Đặt token '
  'FINANCE_V2_LIFECYCLE để TẮT cầu a85/a85b — thiếu bước đó là tiền vào sổ HAI '
  'LẦN. Gọi lại trả đúng bút toán cũ. Chỉ writer definer gọi được.';

-- ─────────────────────────────────────────────────────────────────────
-- TỰ KIỂM ADAPTER — soi TÊN CÓ SCHEMA, và khẳng định cái kim tồn tại trước
-- khi so vị trí (bài học 30/07: so chuỗi trần khớp cả tên sai schema ⇒ an toàn giả)
-- ─────────────────────────────────────────────────────────────────────
DO $selfcheck$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app_private' AND p.proname = 'special_fee_approve_and_post_v1';
  IF v_src IS NULL THEN RAISE EXCEPTION 'Không thấy adapter sau khi tạo. DỪNG.'; END IF;

  IF position('app_private.ie_transition_authorization' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Adapter KHÔNG đặt token tắt cầu a85 — sẽ ghi sổ tiền hai lần. DỪNG.';
  END IF;
  IF position('app_private.finance_v2_post_voucher_with_source_v1' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Adapter không gọi lõi dùng chung (có schema). DỪNG.';
  END IF;
  IF position('is_virtual' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Adapter không xử lý sổ ảo. DỪNG.';
  END IF;
  -- Thứ tự: token PHẢI đặt trước lệnh lật APPROVED, không thì cầu đã nổ.
  IF position('ie_transition_authorization' IN v_src)
     > position('SET approval_status' IN v_src) THEN
    RAISE EXCEPTION 'Adapter đặt token SAU khi lật APPROVED — cầu a85 kịp đúc bút toán. DỪNG.';
  END IF;
  -- Chốt loại phiếu: không có nó thì phiếu hoàn cọc tự duyệt được, trái lệnh chủ.
  IF position('reversal_of_id' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Adapter không kiểm bút toán đã bị đảo — sẽ đóng dấu POSTED lên bút toán chết. DỪNG.';
  END IF;
  IF position('''EXPENSE''' IN v_src) = 0 OR position('system_source' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Adapter thiếu chốt loại phiếu — phiếu hoàn cọc/phiếu thu tự duyệt được. DỪNG.';
  END IF;
  IF position('DELETE FROM app_private.ie_transition_authorization' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Adapter không trả token — cầu a85 câm hết transaction. DỪNG.';
  END IF;
END
$selfcheck$;

COMMIT;
