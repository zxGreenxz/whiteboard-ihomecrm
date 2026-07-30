-- =====================================================================
-- SLICE −1 · MẢNG A — SỬA CÁC HÀM ĐỌC ĐANG KHAI SAI TIỀN TRÊN MÀN HÌNH
--
-- Slice −1 là gì: tầng khuyết tật ĐANG SỐNG trên production, độc lập với hai
-- plan `/thu-tien`, đang làm màn hình khai sai tiền NGAY LÚC NÀY (xem
-- docs/superpowers/plans/2026-07-30-danh-gia-2-plan-thu-tien-v2.md §4). Ba
-- trong số chúng làm gate của chính hai plan trở nên bất khả thi, nên chúng
-- đứng TRƯỚC Slice 0. Slice −1 KHÔNG thêm bề mặt tính năng mới, không schema
-- mới: chỉ sửa hàm đọc và chặn ghi sai mới.
--
-- QUYẾT ĐỊNH CỦA CHỦ — RÀNG BUỘC TUYỆT ĐỐI:
--   "tất cả khoản tiền đó giữ nguyên đi, ghi nhận là được, đừng đụng vào."
-- Nghĩa là: migration này KHÔNG UPDATE/DELETE/huỷ/đảo một dòng
-- income_expenses, income_expense_items hay contract_terminations nào. 23 slot
-- phí cố định trùng (47 phiếu / 620.489.725đ, có một cặp 66.000.000đ — cặp đó
-- mang system_source NULL, KHÔNG do pay_period_fee sinh ra) GIỮ NGUYÊN — chúng được
-- GHI NHẬN/PHƠI RA, không được sửa. Vì vậy trong file này **không có một câu
-- DML nào**, chỉ CREATE OR REPLACE / DROP+CREATE hàm đọc, và không có UNIQUE
-- index nào trên dữ liệu lịch sử (index đó sẽ fail ngay lúc tạo).
--
-- File này idempotent, chạy lại được nhiều lần.
--
-- TÓM TẮT BỐN BẢN VÁ (mỗi dòng một sửa):
--   A1 · fee_type_matches       — nhánh 'quan_ly' loại tiền LƯƠNG ra, thôi cộng
--                                 34.206.744đ tiền lương vào ô phí Quản Lý.
--   A2 · get_period_fee_status  — cộng TỔNG HẠNG MỤC KHỚP thay cho total_amount
--                                 cả phiếu (hết đếm hai lần phiếu đa-hạng-mục),
--                                 và `cancellable` loại thêm phiếu flow-owned.
--   A3a · get_period_maintenance — phơi phiếu CHỜ DUYỆT thành trạng thái RIÊNG
--                                 để UI hiện "đã tạo, chờ duyệt" và tắt nút
--                                 đóng, thay vì báo "chưa có phiếu" rồi mời
--                                 đóng lại. KHÔNG tự duyệt gì cả.
--   A3b · (đã BỎ) get_period_utility_status — reader SQL cho Điện/Nước. Không
--                                 ship vì tầng đọc EN vẫn là REST và không có
--                                 caller; khuyết tật §−1.1 của màn EN đã vá
--                                 ngay trong useUtilityBills. Xem khối A3b để
--                                 biết các bẫy phải tránh khi làm thật.
--   A4 · get_refund_forfeit_summary — KPI "Đã hoàn cọc" đọc TIỀN ĐÃ RA KÉT
--                                 (phiếu hoàn POSTED có posting đang hiệu lực),
--                                 không đọc cột GENERATED refund_amount nữa.
--
-- LƯU Ý VỀ VOLATILITY (án lệ 20260730280000_stable_fn_row_lock_regression.sql):
-- hàm public khai STABLE/IMMUTABLE mà chạm `SELECT … FOR SHARE` (trực tiếp hay
-- qua ≤4 tầng lời gọi, ví dụ app_private.authorize_tenant_action_v3) sẽ ném
-- 25006 qua PostgREST, và hàng rào DO $guard$ quét toàn schema sẽ RAISE. Mọi
-- hàm đọc dưới đây khai VOLATILE. Riêng public.fee_type_matches giữ IMMUTABLE
-- vì nó là biểu thức thuần trên tham số (chỉ gọi public.nrm_vn, cũng thuần) —
-- các hàm gọi nó (resolve_fixed_expense_type, pay_period_fee, cancel_period_fee,
-- get_period_fee_status) đều đã VOLATILE nên không có ai bị kéo xuống.
-- Chạy `node scripts/check-stable-fn-locks.mjs` sau khi apply.
--
-- KHÔNG hàm nào dưới đây nằm trong danh sách bị "anchor-patch"
-- (pg_get_functiondef → thay chuỗi mốc → EXECUTE) của Đợt 0–6; đã kiểm bằng
-- grep pg_get_functiondef trên toàn supabase/migrations: 0 hit cho cả bốn tên.
-- Nên redefine ở đây không phá replay của khối 20260730*.
-- =====================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- A1 · public.fee_type_matches — nhánh 'quan_ly' đang khớp cả tiền LƯƠNG
--
-- SAI GÌ. Nhánh quan_ly là `nrm_vn(name) LIKE '%quan ly%'`, nên nó khớp luôn
-- 'Lương quản lý' và 'Ứng lương quản lý'. Hậu quả đo trên prod 30/07/2026:
--   • org thật aaaa: ô phí "Quản Lý" cộng 34.206.744đ TIỀN LƯƠNG
--     (system_source='salary.staff': 13.930.046 + 20.276.698). Ô đang hiện
--     124.706.744đ, số đúng là 90.500.000đ.
--   • org DEMO dddd: KHÔNG có type 'Quản Lý' nào, chỉ có 'Lương quản lý'
--     ⇒ resolve_fixed_expense_type('quan_ly') (ORDER BY is_default DESC,
--     created_at, id LIMIT 1, mọi dòng is_default=false) sẽ GHI MỘT KHOẢN CHI
--     QUẢN LÝ VÀO TYPE TIỀN LƯƠNG. Đây là lỗi ghi, không chỉ lỗi đọc.
--
-- CHỌN DẤU HIỆU PHÂN BIỆT — ĐO THẬT, KHÔNG ĐOÁN. Đề xuất ban đầu là dùng
-- `category`: ở org thật 'Lương quản lý'/'Ứng lương quản lý' có category
-- 'Lương' còn phí thật 'Quản Lý' có category 'Vận Hành'. **Nhưng ở DEMO
-- category của 'Lương quản lý' là RỖNG**, nên chỉ dựa vào category thì DEMO
-- vẫn vỡ. Vì vậy dùng dấu hiệu ở CHÍNH TÊN — 'luong' — cộng thêm category để
-- bắt trường hợp tên không mang chữ lương mà category thì có:
--        nrm_vn(name) LIKE '%quan ly%'
--    AND nrm_vn(name) NOT LIKE '%luong%'
--    AND nrm_vn(category) NOT LIKE '%luong%'
-- Đây đúng kiểu loại trừ đã có tiền lệ trong chính hàm này (nhánh 've_sinh'
-- dùng `AND nrm_vn(p_name) NOT LIKE '%rac%'`), không hardcode org nào.
--
-- VẾ CATEGORY DÙNG `NOT LIKE '%luong%'`, KHÔNG DÙNG `<> 'luong'` (sửa 30/07 sau
-- rà vòng 2). Bản nháp dùng bằng-chính-xác nên category 'Lương thưởng' /
-- 'Lương nhân viên' vẫn lọt vào ô Quản Lý, tức vẫn đúng khuyết tật đang vá, chỉ
-- hẹp hơn một bậc. Nó còn LỆCH với bản mirror TypeScript (`src/lib/feeCategories.ts`
-- dùng `!c.includes('luong')`) trong khi header file đó bắt buộc parity 3 nơi ⇒
-- hai bề mặt sẽ hiện hai con số cho cùng một phiếu. Chọn vế RỘNG hơn
-- (fail-closed, khớp đúng ý "mọi type thuộc category Lương").
-- ĐO TRƯỚC KHI SỬA (read-only, prod 30/07): số type có nrm_vn(category) chứa
-- 'luong' mà KHÁC 'luong' = 0, và số type đổi kết quả khi nới vế này = 0 — tập
-- khớp 'quan_ly' vẫn đúng 1 type ('Quản Lý' / cat 'Vận Hành'). Tức đây là vá
-- chống-hồi-quy + parity, KHÔNG dịch một đồng nào của dữ liệu hiện có.
-- Kiểm trên toàn bộ 23 type expense đang khớp 9 kind của cả hai org: sau vá,
-- 'quan_ly' chỉ còn khớp đúng 1 type ('Quản Lý', cat 'Vận Hành', org aaaa) và
-- 0 type ở DEMO — tức DEMO sẽ TỰ TẠO type 'Quản Lý' đúng ở lần chi đầu thay vì
-- ghi vào type lương.
--
-- ĐÁNH ĐỔI PHẢI GHI RÕ: nếu sau này ai đặt tên một khoản phí quản lý có chứa
-- chữ 'lượng' (nrm_vn cũng ra 'luong', ví dụ 'Quản lý chất lượng') thì nó sẽ bị
-- loại oan. Cách xử lý đúng khi gặp: đổi tên type, hoặc chờ bảng ánh xạ
-- income_expense_type_id → special_fee_kind do chủ duyệt (Plan 1 Task 6) thay
-- hẳn matcher theo tên. Không nới lỏng lại nhánh này.
--
-- GIỮ NGUYÊN: signature (p_category_key, p_cat, p_name), LANGUAGE sql,
-- IMMUTABLE PARALLEL SAFE, và ACL hiện có (CREATE OR REPLACE không đụng ACL;
-- hàm này không SECURITY DEFINER nên `=X` cho PUBLIC là vô hại — nó chỉ là
-- biểu thức trên tham số, không đọc bảng nào).
--
-- TÁC DỤNG LAN SANG BA HÀM GỌI NÓ (đều là mong muốn, đều fail-closed):
--   • get_period_fee_status : 5 phiếu lương rời khỏi ô Quản Lý.
--   • pay_period_fee        : chốt chống trùng thôi đếm phiếu lương là "đã đóng".
--   • cancel_period_fee     : không còn nhận phiếu lương như phiếu phí quản lý
--                             ⇒ hết đường soft-delete phiếu lương từ bảng phí.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fee_type_matches(p_category_key text, p_cat text, p_name text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT CASE p_category_key
    WHEN 'internet'  THEN (public.nrm_vn(p_cat) = 'internet' OR public.nrm_vn(p_name) LIKE '%internet%')
    WHEN 'rac'       THEN (public.nrm_vn(p_name) LIKE '%rac%')
    WHEN 'cong_an'   THEN (public.nrm_vn(p_cat) = 'ca' OR public.nrm_vn(p_name) LIKE '%cong an%')
    WHEN 've_sinh'   THEN ((public.nrm_vn(p_cat) = 've sinh' OR public.nrm_vn(p_name) LIKE '%ve sinh toa nha%')
                             AND public.nrm_vn(p_name) NOT LIKE '%rac%')
    WHEN 'thang_may' THEN (public.nrm_vn(p_name) LIKE '%thang may%')
    WHEN 'dien'      THEN (public.nrm_vn(p_cat) = 'dien' OR public.nrm_vn(p_name) LIKE '%tien dien%')
    WHEN 'nuoc'      THEN (public.nrm_vn(p_cat) = 'nuoc' OR public.nrm_vn(p_name) LIKE '%tien nuoc%')
    WHEN 'tien_nha'  THEN (public.nrm_vn(p_cat) = 'tien nha' OR public.nrm_vn(p_name) LIKE '%tien nha%')
    -- A1: phí quản lý KHÔNG phải tiền lương. Loại 'Lương quản lý',
    -- 'Ứng lương quản lý' và mọi type có category CHỨA 'luong' ('Lương',
    -- 'Lương thưởng', 'Lương nhân viên'…). Vế category phải là NOT LIKE — không
    -- phải `<> 'luong'` — để khớp ĐÚNG bản mirror TypeScript
    -- (src/lib/feeCategories.ts: `!c.includes('luong')`); xem ghi chú A1 đầu file.
    WHEN 'quan_ly'   THEN (public.nrm_vn(p_name) LIKE '%quan ly%'
                             AND public.nrm_vn(p_name) NOT LIKE '%luong%'
                             AND public.nrm_vn(p_cat)  NOT LIKE '%luong%')
    ELSE false
  END
$function$;

COMMENT ON FUNCTION public.fee_type_matches(text, text, text) IS
  'Matcher hạng mục phí cố định (9 kind) dùng chung cho resolve_fixed_expense_type / '
  'pay_period_fee / cancel_period_fee / get_period_fee_status. Slice −1 A1: nhánh '
  'quan_ly loại tiền lương (name CHỨA "luong", hoặc category CHỨA "luong") — trước đó '
  '34.206.744đ lương của org thật bị cộng vào ô phí Quản Lý và DEMO thì không có '
  'type Quản Lý nên khoản chi quản lý bị ghi vào type lương.';

-- ─────────────────────────────────────────────────────────────────────
-- A2 · public.get_period_fee_status — hai lỗi trong cùng một hàm
--
-- SAI GÌ (1) — ĐẾM HAI LẦN. CTE `vperv` chọn `ie.total_amount AS amount`
-- (TỔNG CẢ PHIẾU) rồi GROUP BY (building, category_key, ie.id). Một phiếu chạm
-- hai hạng mục vì thế được cộng NGUYÊN GIÁ vào CẢ HAI ô. Ca thật:
-- phiếu 5916661a-66c2-4a7c-88f1-b90e27d62564 'Tiền Điện + Tiền nước',
-- total_amount 6.384.000, hai item khớp: Điện 5.758.000 + Nước 626.000 ⇒ hôm
-- nay nó góp 6.384.000 vào ô Điện VÀ 6.384.000 vào ô Nước.
-- SỬA: cộng SUM(item khớp) thay cho ie.total_amount. Sau vá ô Điện =
-- 5.758.000, ô Nước = 626.000. Giá trị cả phiếu vẫn trả về trong jsonb
-- (`voucher_total`) để UI hiện được "phiếu 6.384.000đ — phần Điện 5.758.000đ",
-- không mất thông tin nào.
--
-- Vì amount giờ là tổng theo dòng item, phải chống nhân bản: `cat` và `typed`
-- đổi sang SELECT DISTINCT. Trước đây p_category_keys trùng lặp (client gửi hai
-- lần cùng một key) là vô hại vì amount là hằng số theo phiếu; giờ nó sẽ nhân
-- đôi tổng. Đây là bẫy do chính bản vá tạo ra, đã bịt tại đây.
--
-- Loại thêm phiếu LƯƠNG khỏi read model (`system_source LIKE 'salary.%'`) —
-- lớp lưới thứ hai đứng độc lập với A1, theo đúng chỉ dẫn §−1.3 của plan
-- ("trong lúc chờ chủ duyệt bảng ánh xạ thì loại tường minh các category
-- 'Lương' và system_source LIKE 'salary.%' khỏi read model"). Đo trên prod:
-- không một phiếu system_source='salary.%' nào là phiếu phí cố định thật, nên
-- lưới này chỉ bắt rác.
--
-- TRƯỚC/SAU ĐO THẬT (org × kind, kỳ item chồng lấn 2026-01-01..2026-12-31,
-- chỉ APPROVED). Chỉ ba ô đổi số, cả ba đều GIẢM — chủ phải ký nhận con số
-- giảm này, đừng đối chiếu "trước/sau khớp nhau":
--     aaaa quan_ly : 124.706.744 → 90.500.000   (−34.206.744 · A1, tiền lương)
--     aaaa nuoc    :  54.985.819 → 49.227.819   ( −5.758.000 · A2, phần Điện
--                                                 của phiếu 5916661a)
--     aaaa dien    : 447.532.820 → 446.906.820  (   −626.000 · A2, phần Nước
--                                                 của phiếu 5916661a)
--   Sáu ô còn lại (tien_nha, internet, cong_an, rac, thang_may, ve_sinh) và
--   toàn bộ DEMO: KHÔNG ĐỔI MỘT ĐỒNG.
--
-- SAI GÌ (2) — NÚT HUỶ BẬT SÁNG RỒI NÉM LỖI TIẾNG ANH. `cancellable` suy ra
-- CHỈ từ `NOT in_batch`. Nhưng đường huỷ (cancel_period_fee → UPDATE
-- deleted_at) bị hàng rào đông cứng payload của phiếu flow-owned
-- (guard_income_expense_owned_payload) từ chối bằng SQLSTATE 55000. Live có
-- ĐÚNG 9 phiếu như vậy đang hiện trong bảng phí với nút Huỷ bật:
--   • aaaa PC2607096 'phí bỏ rác' 100.000đ, toà dfca120d…, kind 'rac',
--     flow_kind CANONICAL_INCOME_EXPENSE — phiếu THẬT.
--   • dddd PC2607039…PC2607046, 8 phiếu E2E 99.999.000đ, kind 'dien'.
-- SỬA: `cancellable` loại thêm phiếu có dòng trong
-- app_private.income_expense_flow_ownership, và trả kèm `flow_owned` +
-- `cancel_blocked_reason` ('IN_BATCH' | 'FLOW_OWNED') để UI nói được VÌ SAO
-- không huỷ được, thay vì bật nút rồi để server ném 55000.
--
-- KHÔNG ĐỔI trong bản vá này (ghi nợ có chủ ý):
--   • RETURNS TABLE giữ nguyên 13 cột ⇒ CREATE OR REPLACE được, không cần
--     DROP, frontend không phải đổi gì để chạy tiếp.
--   • `typed` vẫn không lọc organization_id (SECURITY DEFINER nên RLS bị bỏ
--     qua). Đây là khuyết tật THẬT nhưng ngoài phạm vi bốn hạng mục được giao;
--     nó chỉ hiện hình khi một phiếu của org A dùng type của org B. Đã ghi vào
--     báo cáo, chưa sửa ở đây vì sửa là đổi số hiển thị mà chủ chưa duyệt.
--   • 5 item APPROVED có start_date/end_date NULL (3 phiếu quan_ly cùng toà
--     cb6592d8… tạo một slot trùng ba VÔ HÌNH) vẫn vô hình, vì vị ngữ kỳ
--     `it.start_date <= v_end AND it.end_date >= v_start` NULL-fail. KHÔNG nới
--     vị ngữ: item không có kỳ thì không thể xếp vào tháng nào một cách đúng
--     đắn, và nới ra sẽ ĐỘT NGỘT THÊM TIỀN vào ô — trái quyết định của chủ.
--     Cách xử lý đúng là vá 5 dòng dữ liệu đó, việc đó cần chủ duyệt riêng.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_period_fee_status(
  p_period_start  text,
  p_period_end    text,
  p_building_ids  uuid[],
  p_category_keys text[]
)
RETURNS TABLE(
  building_id      uuid,
  category_key     text,
  paid_amount      numeric,
  draft_amount     numeric,
  covered_start    date,
  covered_end      date,
  voucher_ids      uuid[],
  vouchers         jsonb,
  has_receipt      boolean,
  account_name     text,
  account_is_empty boolean,
  expected_amount  numeric,
  not_applicable   boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
              ie.posting_status, ie.system_source, ie.voucher_date, ie.account_id, a.name,
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
$function$;

REVOKE ALL ON FUNCTION public.get_period_fee_status(text, text, uuid[], text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_period_fee_status(text, text, uuid[], text[]) TO authenticated;

COMMENT ON FUNCTION public.get_period_fee_status(text, text, uuid[], text[]) IS
  'Trạng thái đã/chưa đóng phí cố định theo toà × hạng mục × kỳ. Slice −1 A2: '
  'paid/draft cộng TỔNG HẠNG MỤC KHỚP (không phải total_amount cả phiếu, vốn '
  'làm phiếu đa-hạng-mục bị đếm hai lần); cancellable loại phiếu in-batch VÀ '
  'phiếu flow-owned (guard payload ném 55000); phiếu system_source salary.* bị '
  'loại khỏi read model.';

-- ─────────────────────────────────────────────────────────────────────
-- A3a · public.get_period_maintenance — phiếu bảo trì tạo ra rồi VÔ HÌNH
--
-- SAI GÌ. `ie_compat_insert_v2` CƯỠNG CHẾ `approval_status='UNAPPROVED'` bất kể
-- số tiền hay ngưỡng; hàm đọc này thì lọc `approval_status = 'APPROVED'`. Tạo
-- batch bảo trì xong, tab Bảo trì vẫn render 'Kỳ này chưa có phiếu bảo trì.'
-- (PeriodFeeSheet.tsx:525) và MỜI NGƯỜI DÙNG TẠO LẠI — đây chính là hình dạng
-- "ghi vô hình → mời tạo lại", lớp lỗi mời chi trùng vô hạn.
--
-- SỬA: nhận cả UNAPPROVED và trả TRẠNG THÁI RIÊNG để UI hiện "đã tạo, chờ
-- duyệt" và TẮT nút đóng. KHÔNG tự duyệt gì cả — ngưỡng duyệt tay là quyết
-- định của chủ, Slice −1 không đụng.
--
-- Vì phải THÊM CỘT OUT nên buộc DROP + CREATE (CREATE OR REPLACE không đổi được
-- return type). Đã kiểm pg_depend: KHÔNG object nào phụ thuộc hàm này (0 view,
-- 0 hàm) nên DROP an toàn. Tiền lệ cùng kiểu trong repo:
-- 20260710120000_period_fee_status_v2.sql:87. Ba cột mới nằm ở CUỐI danh sách
-- nên client cũ đọc theo tên vẫn chạy y nguyên.
--
-- Nhân đây sửa luôn cùng lớp lỗi với A2 (đo trước: 0 ca lệch trên prod, nên
-- đây là vá phòng ngừa, không đổi một đồng nào hôm nay):
--   • `amount` cộng SUM(item bảo trì khớp) thay cho ie.total_amount ⇒ phiếu có
--     kèm hạng mục không-bảo-trì thôi làm phồng ô bảo trì.
--   • gộp theo (phiếu, subtype) thay cho `DISTINCT ON (ie.id)` ⇒ phiếu có cả
--     máy lạnh và máy giặt cho ra HAI dòng đúng, không còn chọn subtype ngẫu
--     nhiên rồi cộng dồn cả phiếu vào một bên.
--   Đo prod 30/07: 91 phiếu bảo trì sống, 0 phiếu lệch total vs item, 0 phiếu
--   hai subtype, 0 phiếu UNAPPROVED ⇒ tổng 31.009.700đ KHÔNG ĐỔI sau vá.
-- ─────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_period_maintenance(text, uuid[]);

CREATE OR REPLACE FUNCTION public.get_period_maintenance(
  p_period_month text,
  p_building_ids uuid[] DEFAULT NULL::uuid[]
)
RETURNS TABLE(
  batch_id        uuid,
  payer_name      text,
  voucher_id      uuid,
  building_id     uuid,
  building_name   text,
  subtype         text,
  amount          numeric,
  account_name    text,
  has_receipt     boolean,
  voucher_date    date,
  is_standalone   boolean,
  -- ── Slice −1 A3: ba cột mới, luôn ở cuối ──
  approval_status text,   -- 'APPROVED' | 'UNAPPROVED'
  posting_status  text,   -- 'POSTED' | 'UNPOSTED' | 'NOT_APPLICABLE' | 'REVERSED' | NULL
  state           text    -- 'PENDING_APPROVAL' | 'APPROVED_UNPOSTED' | 'POSTED'
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_start date;
  v_end   date;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_period_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Kỳ không hợp lệ (cần YYYY-MM)';
  END IF;
  v_start := to_date(p_period_month || '-01', 'YYYY-MM-DD');
  v_end   := (date_trunc('month', v_start) + interval '1 month - 1 day')::date;

  RETURN QUERY
  WITH bld AS (
    SELECT b.id, b.name
      FROM buildings b
     WHERE (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
       AND b.deleted_at IS NULL
       AND (public.can_access_building(b.id)
            OR public.ie_all_buildings_scope(b.id)
            OR b.user_id = auth.uid()
            OR public.is_admin() OR public.is_super_admin())
  ),
  v AS (
    SELECT ie.id AS voucher_id, ie.building_id, ie.account_id, ie.voucher_date,
           ie.attachments, ie.approval_status, ie.posting_status,
           CASE WHEN public.nrm_vn(tp.name) LIKE '%may giat%' THEN 'mg' ELSE 'ml' END AS subtype,
           -- A3/A2: tổng hạng mục bảo trì khớp, không phải tổng cả phiếu.
           SUM(it.amount) AS amount
      FROM income_expenses ie
      JOIN bld ON bld.id = ie.building_id
      JOIN income_expense_items it ON it.income_expense_id = ie.id
      JOIN income_expense_types tp ON tp.id = it.income_expense_type_id
     WHERE ie.type = 'EXPENSE'
       -- A3: phơi cả phiếu CHỜ DUYỆT (ie_compat_insert_v2 luôn tạo UNAPPROVED).
       AND ie.approval_status IN ('APPROVED','UNAPPROVED')
       AND ie.deleted_at IS NULL
       AND (public.nrm_vn(tp.name) LIKE '%bao tri may lanh%'
            OR public.nrm_vn(tp.name) LIKE '%bao tri may giat%'
            OR public.nrm_vn(tp.name) LIKE '%may lanh%'
            OR public.nrm_vn(tp.name) LIKE '%may giat%')
       AND it.start_date <= v_end AND it.end_date >= v_start
     GROUP BY ie.id, ie.building_id, ie.account_id, ie.voucher_date, ie.attachments,
              ie.approval_status, ie.posting_status,
              CASE WHEN public.nrm_vn(tp.name) LIKE '%may giat%' THEN 'mg' ELSE 'ml' END
  )
  SELECT
    bi.batch_id,
    bt.payer_name,
    v.voucher_id, v.building_id, bld.name,
    v.subtype, v.amount,
    a.name,
    (jsonb_typeof(v.attachments) = 'array' AND jsonb_array_length(v.attachments) > 0),
    v.voucher_date::date,
    (bi.batch_id IS NULL),
    v.approval_status,
    v.posting_status,
    (CASE WHEN v.approval_status = 'UNAPPROVED'   THEN 'PENDING_APPROVAL'
          WHEN v.posting_status  = 'POSTED'       THEN 'POSTED'
          ELSE 'APPROVED_UNPOSTED' END)::text
  FROM v
  JOIN bld ON bld.id = v.building_id
  LEFT JOIN accounts a ON a.id = v.account_id
  LEFT JOIN income_expense_batch_items bi ON bi.income_expense_id = v.voucher_id
  LEFT JOIN income_expense_batches bt ON bt.id = bi.batch_id
  ORDER BY bi.batch_id NULLS LAST, bld.name;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_period_maintenance(text, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_period_maintenance(text, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.get_period_maintenance(text, uuid[]) IS
  'Phiếu bảo trì máy lạnh/máy giặt đã có trong kỳ. Slice −1 A3: phơi cả phiếu '
  'UNAPPROVED kèm cột state (PENDING_APPROVAL/APPROVED_UNPOSTED/POSTED) để tab '
  'Bảo trì hiện "đã tạo, chờ duyệt" thay vì "chưa có phiếu" rồi mời tạo lại; '
  'amount cộng theo hạng mục bảo trì khớp và gộp theo (phiếu, subtype).';

-- ──────────────────────────────────────────────────────────────────
-- A3b · public.get_period_utility_status — HOÃN SANG SLICE CÓ DI TRÚ TẦNG ĐỌC EN
--
-- Bản nháp của slice này có một hàm đọc SQL đầy đủ cho tab Điện/Nước (4 trạng
-- thái NONE/PENDING_APPROVAL/APPROVED/POSTED, gộp phiếu chưa gắn đồng hồ thành
-- dòng riêng). Hàm đã bị BỎ khỏi migration vì KHÔNG CÓ MỘT CALLER NÀO: màn EN
-- vẫn query REST trực tiếp trong `useUtilityBills.ts`, và khuyết tật §−1.1 mà
-- A3b nhắm tới đã được vá ở đúng chỗ đó (`.eq(approval_status,APPROVED)` →
--  `.in([APPROVED, UNAPPROVED])` + hai map paidMap/pendingMap tách bạch).
-- Ship một reader SECURITY DEFINER 165 dòng mà không ai gọi = thêm bề mặt
-- schema không có test, không có đường hồi quy — đúng loại nợ mà slice này
-- đang đi trả.
--
-- HAI SỰ THẬT ĐO ĐƯỢC phải giữ lại cho lần làm thật (đo prod 30/07/2026):
--   1. Ngưỡng tự duyệt org thật đã hạ về 600.000đ lúc 2026-07-29T09:39:56Z và
--      64/72 hoá đơn EN sống ≥ 600k ⇒ mọi phiếu EN mới sinh ra UNAPPROVED. Đây
--      là lý do reader PHẢI đọc cả UNAPPROVED (đã vá ở client).
--   2. Phiếu EN không gắn đồng hồ (`utility_account_id IS NULL`) KHÔNG rơi vào
--      ô nào của bảng vì client khoá theo meter id: org thật 9 phiếu APPROVED /
--      7.956.000đ, org DEMO 1 phiếu / 777.000đ. Nay client gom chúng thành một
--      nhóm `noMeterThisKy(toà, loại)` và hiện thành dòng "chưa gắn công tơ"
--      trên thẻ tổng (`useUtilityBills.ts` + `UtilityEnContent.tsx`) — GHI
--      NHẬN, không sửa dữ liệu.
--   Bẫy đã phát hiện, đừng làm lại: nếu reader gắn slot theo utility_account_id
--   mà KHÔNG đòi `building_utility_accounts.utility_type` khớp loại hạng mục thì
--   phiếu 5916661a (toà 158PVC, gắn đồng hồ ĐIỆN nhưng có hạng mục Nước
--   626.000đ) làm 626.000đ rơi khỏi mọi dòng. Và ĐỪNG dùng
--   `fee_type_matches('dien', …)` để chọn phiếu EN: nhánh đó còn khớp 'Mua tủ
--   lạnh' (category 'Điện') và 'thanh toán tiền điện lạnh' (category 'Bảo Trì
--   Máy Lạnh') — hai ca có thật trên prod. Dùng nrm_vn(name) IN ('dong tien
--   dien','dong tien nuoc').
-- ──────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────
-- A4 · public.get_refund_forfeit_summary — KPI "Đã hoàn cọc" của /deposits
--
-- SAI GÌ. Hàm cộng `GREATEST(0, contract_terminations.refund_amount)` trên MỌI
-- termination non-FORFEIT, KHÔNG lọc status, KHÔNG lọc ghi sổ, và đếm cả DRAFT
-- lẫn PENDING_APPROVAL là "lần đã hoàn". `refund_amount` là cột GENERATED (cọc
-- theo hợp đồng trừ khấu trừ) — nó không biết khách có thực đóng cọc hay chưa,
-- cũng không biết phiếu chi đã duyệt/ghi sổ chưa.
-- Live org thật: KPI hiện **8.290.000đ / 3 lần**
-- (2.428.500 + 2.352.000 + 3.509.500) trong khi tiền hoàn ĐÃ RA KÉT chỉ là
-- **4.302.000đ / 2 dòng** (PC2607104 2.852.000 + PC2607119 1.450.000, cả hai
-- APPROVED + posting_status POSTED + active_posting_id_v2 khác NULL) ⇒ thổi
-- phồng 3.988.000đ. Hồ sơ thứ ba (5f8b433f, PC2607153 3.509.500) còn
-- UNAPPROVED/UNPOSTED — tiền chưa ra két.
-- (Con số 8.990.000đ / 11 lần từng ghi trong audit là tổng HAI org qua
-- service-role; hàm này SECURITY INVOKER và contract_terminations/contracts/
-- rooms đều bật RLS nên không người dùng nào thấy con số đó. Phần DEMO là
-- 700.000đ / 8 lần.)
--
-- SỬA. `refund_total`/`refund_count` giờ do PHIẾU HOÀN ĐÃ GHI SỔ lái:
--     ie.system_source = 'termination.refund'
--     AND ie.type = 'EXPENSE' AND ie.deleted_at IS NULL
--     AND ie.approval_status = 'APPROVED'
--     AND ie.posting_status = 'POSTED' AND ie.active_posting_id_v2 IS NOT NULL
--     AND ie.contract_id = termination.contract_id
-- `system_source='termination.refund'` là dấu hiệu SẠCH, đã kiểm trên toàn bộ
-- dữ liệu: phiếu 'termination.offset' (cấn cọc → chuyển doanh thu, cũng mang
-- item accounting_class='DEPOSIT') KHÔNG phải tiền ra két và bị loại đúng; còn
-- lọc theo accounting_class='DEPOSIT' thì sẽ cộng cả phiếu offset.
-- Dùng total_amount của phiếu hoàn (chứ không chỉ dòng item DEPOSIT) vì cả phiếu
-- là số tiền TRẢ LẠI KHÁCH: PC2607104 = 2.352.000 (cọc sau khấu trừ) + 500.000
-- (hoàn tiền thừa) = 2.852.000. Đây đúng con số 4.302.000đ mà kiểm toán chốt.
--
-- BỘ ĐÔI PHIẾU TRÙNG SỐ TỰ HẾT: HĐ a1584980 có PC2606049 (POSTED) và PC2606050
-- (CANCELLED) cùng 2.797.000đ; HĐ aa16a805 có PC2607073 (CANCELLED) và
-- PC2607074 (POSTED) cùng 3.127.400đ. Vị ngữ APPROVED+POSTED giữ đúng một
-- phiếu mỗi cặp ⇒ hết chuyện "2 dòng cho 1 termination" mà plan §−1.7 nêu.
--
-- GIỮ HÌNH DẠNG TRẢ VỀ: bốn khoá cũ (refund_total, refund_count, forfeit_total,
-- forfeit_count) VẪN CÒN, cùng tên, cùng ý nghĩa hiển thị ⇒
-- useDepositDashboard.ts:69-74 chạy nguyên không phải sửa. forfeit_* KHÔNG ĐỔI
-- một dòng logic nào (26 dòng FORFEIT đều COMPLETED nên không có ca DRAFT lẫn
-- vào). Các khoá THÊM MỚI ở dưới là cho WS-D dùng, bỏ qua cũng không sao.
--
-- GHI NHẬN, KHÔNG SỬA — theo đúng quyết định của chủ. Đo trên prod phát hiện
-- một sự thật mà cả ba plan doc chưa nêu: **16/20 phiếu `termination.refund`
-- của org thật KHÔNG CÓ dòng contract_terminations nào**, trong đó **8 phiếu
-- APPROVED+POSTED = 23.737.100đ tiền hoàn THẬT ĐÃ RA KÉT**: PC2606007
-- 3.402.200 · PC2606049 2.797.000 · PC2606194 4.353.000 · PC2606196 3.589.000 ·
-- PC2606199 1.736.000 · PC2606201 1.412.500 · PC2607072 3.320.000 · PC2607074
-- 3.127.400 (chỉ PC2607104 và PC2607119 là có hồ sơ). Một KPI lái bằng
-- termination sẽ không bao giờ thấy 23,7 triệu đó. Vì bảng bên dưới KPI liệt kê
-- theo termination, `refund_total` phải khớp bảng (gate §−1.7 là "KPI = tổng cột
-- của bảng"), nên 23,7 triệu được PHƠI RA ở hai khoá riêng
-- `refund_posted_orphan_*` thay vì bị trộn vào — ghi nhận, không đụng đồng nào.
--
-- ĐỔI STABLE → VOLATILE. Hàm giờ đọc thêm public.income_expenses, và RLS của
-- bảng đó gọi accessible_building_ids/has_full_building_scope; theo án lệ
-- 20260730280000 mọi hàm public non-VOLATILE chạm khoá dòng (dù qua 4 tầng) sẽ
-- ném 25006 trong transaction READ ONLY của PostgREST. FE gọi bằng
-- supabase.rpc() ⇒ POST, nên VOLATILE không mất đường gọi nào.
-- Vẫn SECURITY INVOKER: RLS là hàng rào tenant của hàm này (đã kiểm mọi phiếu
-- termination.refund đều có building_id khác NULL ⇒ policy
-- income_expenses_select_rbac phủ đúng người dùng có toà đó trong phạm vi).
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_refund_forfeit_summary(p_building_ids uuid[] DEFAULT NULL::uuid[])
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT t.id                        AS term_id,
           t.contract_id               AS contract_id,
           t.termination_type          AS tt,
           t.status                    AS tstatus,
           COALESCE(t.total_deposit, 0) AS td,
           COALESCE(t.refund_amount, 0) AS ra
    FROM public.contract_terminations t
    JOIN public.contracts c ON c.id = t.contract_id
    JOIN public.rooms r ON r.id = c.room_id
    WHERE (p_building_ids IS NULL OR r.building_id = ANY(p_building_ids))
  ),
  -- Phiếu hoàn cọc còn sống (kể cả CHƯA DUYỆT — chúng là "chờ chi", phải đếm
  -- vào refund_pending_*; CANCELLED thì loại hẳn). `is_posted` = tiền ĐÃ RA KÉT.
  rv AS (
    SELECT ie.id, ie.contract_id, ie.building_id, ie.total_amount,
           (ie.approval_status = 'APPROVED'
             AND ie.posting_status = 'POSTED'
             AND ie.active_posting_id_v2 IS NOT NULL) AS is_posted
    FROM public.income_expenses ie
    WHERE ie.system_source = 'termination.refund'
      AND ie.type = 'EXPENSE'
      AND ie.deleted_at IS NULL
      AND ie.approval_status IN ('APPROVED','UNAPPROVED')
  ),
  -- Gộp theo từng hồ sơ thanh lý để `td`/`ra` không bị nhân bản khi một HĐ
  -- mang nhiều phiếu hoàn.
  per_term AS (
    SELECT b.*,
           COALESCE(SUM(rv.total_amount) FILTER (WHERE rv.is_posted), 0)     AS posted_amount,
           COUNT(rv.id)                 FILTER (WHERE rv.is_posted)          AS posted_vouchers,
           COALESCE(SUM(rv.total_amount) FILTER (WHERE NOT rv.is_posted), 0) AS unposted_amount,
           COUNT(rv.id)                 FILTER (WHERE NOT rv.is_posted)      AS unposted_vouchers
    FROM base b
    LEFT JOIN rv ON rv.contract_id = b.contract_id
    GROUP BY b.term_id, b.contract_id, b.tt, b.tstatus, b.td, b.ra
  ),
  -- Phiếu hoàn ĐÃ GHI SỔ nhưng KHÔNG có hồ sơ thanh lý nào — chỉ để GHI NHẬN.
  orphan AS (
    SELECT COALESCE(SUM(rv.total_amount), 0) AS amount, COUNT(*) AS cnt
    FROM rv
    WHERE rv.is_posted
      AND (p_building_ids IS NULL OR rv.building_id = ANY(p_building_ids))
      AND NOT EXISTS (SELECT 1 FROM public.contract_terminations t2
                       WHERE t2.contract_id = rv.contract_id)
  ),
  -- QUYẾT ĐỊNH CỦA CHỦ 30/07: KPI "Đã hoàn cọc" phải là TIỀN THẬT ĐÃ RA KHỎI KÉT,
  -- tức MỌI phiếu hoàn đã ghi sổ — kể cả phiếu không nối được hồ sơ thanh lý.
  -- Lý do: nếu chỉ lấy phần nối được hồ sơ (4.302.000đ) thì khai THIẾU 23.737.100đ
  -- tiền đã chi thật, tức đổi lỗi khai thừa hôm nay thành lỗi khai thiếu.
  -- Đối chiếu: refund_total = refund_linked_total + refund_posted_orphan_total.
  posted_all AS (
    SELECT COALESCE(SUM(rv.total_amount), 0) AS amount, COUNT(*) AS cnt
    FROM rv
    WHERE rv.is_posted
      AND (p_building_ids IS NULL OR rv.building_id = ANY(p_building_ids))
  )
  SELECT jsonb_build_object(
    -- ── Bốn khoá CŨ, giữ nguyên tên (frontend đang đọc) ──
    -- Tiền hoàn ĐÃ RA KÉT = TẤT CẢ phiếu hoàn POSTED (org thật: 28.039.100đ / 10).
    -- KHÔNG dùng cột GENERATED, và KHÔNG giới hạn theo hồ sơ thanh lý.
    'refund_total',  (SELECT amount FROM posted_all),
    'refund_count',  (SELECT cnt    FROM posted_all),

    -- Phần nối được hồ sơ thanh lý — đây là phần khớp đúng BẢNG bên dưới KPI
    -- (org thật: 4.302.000đ / 2 hồ sơ). Chênh lệch với refund_total chính là
    -- refund_posted_orphan_total, phải hiện thành một dòng cảnh báo trên UI.
    -- ⚠ ĐƠN VỊ: refund_linked_count đếm HỒ SƠ THANH LÝ (một hồ sơ có thể mang
    -- nhiều phiếu hoàn), KHÁC ĐƠN VỊ với refund_count / refund_posted_orphan_count
    -- (đếm PHIẾU). Cần số phiếu của phần nối được thì dùng refund_voucher_count
    -- ở dưới — đừng trộn hai đơn vị vào một phép trừ/cộng.
    'refund_linked_total', (SELECT COALESCE(SUM(posted_amount), 0) FROM per_term WHERE tt <> 'FORFEIT'),
    'refund_linked_count', (SELECT COUNT(*)                        FROM per_term WHERE tt <> 'FORFEIT' AND posted_vouchers > 0),
    'forfeit_total', (SELECT COALESCE(SUM(td), 0)                 FROM per_term WHERE tt =  'FORFEIT'),
    'forfeit_count', (SELECT COUNT(*)                             FROM per_term WHERE tt =  'FORFEIT'),

    -- ── Khoá MỚI (WS-D dùng; client cũ bỏ qua an toàn) ──
    -- Số PHIẾU hoàn đã ghi sổ NỐI ĐƯỢC hồ sơ thanh lý non-FORFEIT — tức cùng đơn
    -- vị với refund_count/refund_posted_orphan_count, và luôn ≤ refund_count
    -- (refund_count đã đếm MỌI phiếu POSTED, kể cả phiếu mồ côi). Nó có thể lớn
    -- hơn refund_linked_count khi một hồ sơ mang nhiều phiếu hoàn — đó là lý do
    -- khoá này tồn tại. (Ghi chú cũ nói "có thể > refund_count" là SAI đơn vị.)
    'refund_voucher_count',        (SELECT COALESCE(SUM(posted_vouchers), 0)  FROM per_term WHERE tt <> 'FORFEIT'),
    -- Đã tạo phiếu hoàn nhưng CHƯA ghi sổ ⇒ "chờ chi", không phải "đã hoàn".
    'refund_pending_total',        (SELECT COALESCE(SUM(unposted_amount), 0)  FROM per_term WHERE tt <> 'FORFEIT'),
    'refund_pending_count',        (SELECT COUNT(*)                           FROM per_term WHERE tt <> 'FORFEIT' AND unposted_vouchers > 0),
    -- "Net quyết toán lịch sử" = ĐÚNG công thức CŨ (cột GENERATED), giữ lại để
    -- đối chiếu chứ KHÔNG dùng làm KPI tiền ra két. Org thật = 8.290.000đ / 3.
    'refund_net_settlement_total', (SELECT COALESCE(SUM(GREATEST(0, ra)), 0)  FROM per_term WHERE tt <> 'FORFEIT'),
    'refund_net_settlement_count', (SELECT COUNT(*)                           FROM per_term WHERE tt <> 'FORFEIT'),
    -- refund_amount ÂM = khách còn nợ, phải hiện "Khách còn nợ", tuyệt đối
    -- không hiện "Đã hoàn 0đ" (2 HĐ DEMO đang bị vậy, −2.241.000đ mỗi HĐ).
    'customer_debt_total',         (SELECT COALESCE(SUM(-ra), 0)              FROM per_term WHERE tt <> 'FORFEIT' AND ra < 0),
    'customer_debt_count',         (SELECT COUNT(*)                           FROM per_term WHERE tt <> 'FORFEIT' AND ra < 0),
    -- GHI NHẬN (không sửa): phiếu hoàn đã ghi sổ mà không có hồ sơ thanh lý.
    -- Org thật hôm nay: 23.737.100đ / 8 phiếu (đo lại 30/07).
    --
    -- ĐỐI CHIẾU — PHẢI VIẾT ĐÚNG ĐƠN VỊ (sửa 30/07 sau rà vòng 2):
    --   • theo TIỀN  : refund_linked_total (4.302.000) + refund_posted_orphan_total
    --                  (23.737.100) = refund_total (28.039.100)  ← đẳng thức UI dùng
    --   • theo PHIẾU : refund_voucher_count (2) + refund_posted_orphan_count (8)
    --                  = refund_count (10)
    -- KHÔNG viết "2 + 8 = 10 phiếu" với số 2 lấy từ refund_linked_count: khoá đó
    -- đếm HỒ SƠ. Hôm nay hai số trùng nhau (2 hồ sơ mang đúng 2 phiếu) nên đẳng
    -- thức sai đơn vị vẫn "đúng" — nó vỡ ngay lần đầu một hồ sơ mang 2 phiếu hoàn.
    -- Đẳng thức theo phiếu cũng chỉ đúng khi (đo prod 30/07, cả hai = 0):
    -- phiếu hoàn POSTED gắn hồ sơ FORFEIT = 0, và HĐ có >1 hồ sơ thanh lý = 0
    -- (idx_terminations_unique_contract giữ điều thứ hai). Nếu về sau một trong
    -- hai khác 0 thì phần dư nằm ngoài cả linked lẫn orphan — phải bổ sung khoá,
    -- đừng chỉnh con số cho khớp.
    'refund_posted_orphan_total',  (SELECT amount FROM orphan),
    'refund_posted_orphan_count',  (SELECT cnt    FROM orphan)
  );
$function$;

REVOKE ALL ON FUNCTION public.get_refund_forfeit_summary(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_refund_forfeit_summary(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.get_refund_forfeit_summary(uuid[]) IS
  'KPI "Đã hoàn cọc / Bỏ cọc" của /deposits. Slice −1 A4: refund_total/refund_count '
  'lái bằng PHIẾU HOÀN ĐÃ GHI SỔ (system_source=termination.refund, APPROVED, '
  'posting_status=POSTED, active_posting_id_v2 IS NOT NULL) thay cho cột GENERATED '
  'contract_terminations.refund_amount — trước đó org thật hiện 8.290.000đ/3 lần. '
  'QUYẾT ĐỊNH CỦA CHỦ 30/07: refund_total là TIỀN THẬT ĐÃ RA KÉT nên gồm CẢ phiếu '
  'không nối được hồ sơ thanh lý (org thật 28.039.100đ/10 PHIẾU). Phần nối được hồ sơ — '
  'tức phần khớp đúng bảng bên dưới — ở refund_linked_* (4.302.000đ / 2 HỒ SƠ = 2 phiếu, '
  'số phiếu ở refund_voucher_count), phần chưa nối ở refund_posted_orphan_* '
  '(23.737.100đ / 8 PHIẾU) và UI PHẢI hiện nó thành một dòng cảnh báo để KPI và bảng '
  'đối chiếu được — theo TIỀN: refund_linked_total + refund_posted_orphan_total = '
  'refund_total; theo PHIẾU: refund_voucher_count + refund_posted_orphan_count = '
  'refund_count. refund_linked_count là số HỒ SƠ, đừng dùng nó trong phép đối chiếu phiếu. '
  'Công thức GENERATED cũ giữ ở refund_net_settlement_* chỉ để tham chiếu lịch sử.';

COMMIT;

-- PostgREST phải nạp lại schema cache: get_period_maintenance đã DROP+CREATE
-- (thêm 3 cột OUT).
NOTIFY pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────
-- VIỆC BẮT BUỘC NGAY SAU KHI APPLY (không làm được TRƯỚC khi apply)
--
-- `src/integrations/supabase/types.ts` đang LỆCH schema sau slice này:
--   • get_period_maintenance vẫn còn Returns 11 cột cũ (thiếu approval_status /
--     posting_status / state — xem types.ts quanh dòng 21628);
--   • is_org_owner_self_v1 và has_contract_termination_write_v1 (20260731011000)
--     chưa có mặt.
-- Cả ba chỗ gọi đều đi qua `(supabase as any).rpc` (usePeriodFees.ts,
-- useIsOrgOwner.ts, useDepositDashboard.ts) nên `tsc` KHÔNG thấy độ lệch này —
-- tức không có cửa tự động nào bắt được, phải làm tay:
--
--     npm run gen:types        # ghi THẲNG vào src/integrations/supabase/types.ts
--
-- rồi commit CHỈ các hunk của 3 hàm trên. CLAUDE.md cảnh báo repo đang có sẵn
-- drift ~92 quan hệ `network_*` (65 phân mảnh ngày TỰ SINH MỖI NGÀY) — regen sẽ
-- kéo chúng vào diff, đừng gộp vào PR này.
-- KHÔNG chạy gen:types TRƯỚC khi apply: lúc đó live schema vẫn là bản cũ nên
-- lệnh này sẽ GHI ĐÈ bằng chính hình dạng cũ (mất trắng thao tác) và vẫn kéo
-- theo toàn bộ drift network_*.
-- ─────────────────────────────────────────────────────────────────────
