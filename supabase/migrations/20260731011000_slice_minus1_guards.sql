-- =====================================================================
-- Slice −1 · WORKSTREAM B — CHẶN DÒNG MỚI, KHÔNG ĐỤNG DÒNG CŨ
--
-- QUYẾT ĐỊNH CỦA CHỦ, RÀNG BUỘC TUYỆT ĐỐI (30/07/2026):
--   "tất cả khoản tiền đó giữ nguyên đi, ghi nhận là được, đừng đụng vào."
-- ⇒ File này KHÔNG có một câu UPDATE/DELETE nào lên dữ liệu tiền đã có.
--   Không backfill, không huỷ, không đảo, không dọn trùng.
--
--   (a) 2 slot vi phạm khoá (công tơ, tháng) — công tơ fea1d2f4…, kỳ 05/2026
--       PC2605090+PC2605091 = 14.371.816đ và kỳ 06/2026 PC2606107+PC2606108 =
--       14.421.668đ. ⚠ ĐÍNH CHÍNH (đo lại 30/07, bản nháp cũ gọi sai là "trùng"):
--       ĐÂY KHÔNG PHẢI TRẢ HAI LẦN. Toà 1392QT có HAI hợp đồng điện thật, cùng
--       chủ hộ "Hoàng Công Hiệp", hai mã khách hàng khác nhau:
--         fea1d2f4 = PE13000241972 (tạo 19/06/2026)
--         70b8af72 = PE13000241924 (tạo 08/07/2026)
--       Mỗi tháng là MỘT hoá đơn lớn + MỘT hoá đơn nhỏ, gửi trong cùng một cú
--       thao tác: 05/2026 14.324.839 + 46.977 (cách 134 ms), 06/2026 14.391.670
--       + 29.998 (cách 214 ms), 07/2026 12.299.364 + 86.277 (cách 1,27 s).
--       Tháng 05 và 06 cả hai bị dồn vào công tơ duy nhất đang tồn tại; từ 08/07
--       khi công tơ thứ hai được khai, hoá đơn nhỏ đi về đúng công tơ của nó
--       (nên 07/2026 KHÔNG vi phạm khoá). Trùng do bấm lại sẽ cho hai số XẤP XỈ
--       BẰNG NHAU — không phải 14.324.839 vs 46.977. Vậy đây là GÁN SAI CÔNG TƠ
--       trên dữ liệu lịch sử, không phải tiền chi hai lần.
--       ⇒ Vì thế câu lỗi chống trùng phải NÊU TÊN mã khách hàng của công tơ và
--         gợi ý chọn công tơ khác khi toà có nhiều công tơ cùng loại (đã làm ở
--         mục 1) — nếu không, người dùng 1392QT sẽ bị chặn hoá đơn ~12tr/tháng
--         mà không hiểu vì sao.
--       Bằng chứng trực tiếp của lỗi B2 cũng ở đây: công tơ 97959cff cùng toà,
--       provider_code NULL + chủ hộ NULL, tạo 08/07 02:43 (12 phút TRƯỚC công tơ
--       thật 02:55) rồi bị xoá mềm — đúng dấu vết "tự sinh công tơ rồi bỏ".
--
--   (b) 24 slot phí cố định trùng / 49 lượt phiếu / 620.496.725đ (ĐO CANONICAL
--       30/07 — xem "PHÉP ĐO CANONICAL" ngay dưới) được GIỮ NGUYÊN.
--
--   Đó cũng là lý do KHÔNG có `CREATE UNIQUE INDEX` nào ở đây: index trên
--   (công tơ, tháng) sẽ fail ngay lúc tạo trên 2 slot ở (a). Chống trùng phải
--   nằm TRONG hàm, chỉ áp cho lần GHI MỚI.
--
-- PHÉP ĐO CANONICAL SỐ Ô TRÙNG (chốt 30/07 — trước đó có BA số khác nhau)
--   Khoá ô = (org, toà, hạng mục, THÁNG), mỗi item mở ra theo
--   generate_series(date_trunc('month',start_date) … end_date) — đúng khoá mà
--   khoá tư vấn của pay_period_fee dùng. Population: APPROVED, deleted_at NULL,
--   type='EXPENSE'. Tiền = tổng theo phiếu RIÊNG BIỆT (một phiếu trải nhiều
--   tháng chỉ tính một lần).
--     quan_ly CÒN gồm lương (hành vi prod hôm nay): 25 ô / 51 lượt / 654.703.469đ
--     quan_ly ĐÃ loại lương (sau A1) — CANONICAL:   24 ô / 49 lượt / 620.496.725đ
--   Các con số cũ 22/45/614.524.344 và 23/47/620.489.725 là do lưới tháng hẹp hơn.
--   Chỗ phép đo 23-ô bỏ sót, đã truy ra chính xác: 405PVB · công an · 07/2026 —
--   phiếu PC2606014 (1.000.000đ) có item trải 01/06→31/07 nên rơi vào CẢ HAI
--   tháng; đối tác của nó ở tháng 7 là PC2607014 7.000đ. Đúng bằng chênh lệch
--   tiền 620.496.725 − 620.489.725 = 7.000đ.
--   Toàn bộ 24 ô nằm ở org THẬT; DEMO không có ô nào. Một ô có 3 phiếu (Kho Văn
--   Phòng Chung · tiền nhà · 05/2026), 23 ô còn lại 2 phiếu.
--   ⚠ Ba mã phiếu TRÙNG NHAU giữa các toà (PC2607076, PC2607006, PC2607096) —
--     tái xác nhận: mã phiếu duy nhất theo NGƯỜI TẠO, KHÔNG duy nhất theo org.
--
-- Bốn lỗ đang in tiền (đo trên production 30/07 bằng pg_get_functiondef +
-- truy vấn dữ liệu sống, không phải suy luận từ file migration):
--
--   B1. public.pay_utility_bill KHÔNG có bất kỳ kiểm tra trùng nào. Cộng với
--       ngưỡng tự duyệt đã hạ về 600.000đ (org thật, 29/07 09:39:56Z) trong
--       khi bảng điện/nước chỉ đọc APPROVED, mỗi lần bấm lại là MỘT phiếu
--       6–15 triệu mới mà giao diện không hề hiện. Nay: một phiếu / một công
--       tơ / một kỳ, có khoá tư vấn nên hai lần bấm song song cũng xếp hàng.
--
--   B2. Cùng hàm đó, nhánh ELSE tự INSERT một dòng building_utility_accounts
--       mới khi p_utility_account_id IS NULL. Giao diện lại render một dòng
--       tổng hợp accountId=null cho mọi toà/loại chưa khai công tơ ⇒ bấm
--       check bình thường là âm thầm sinh công tơ, và vì map "đã đóng" khoá
--       theo id công tơ nên dòng đó KHÔNG BAO GIỜ hiện "đã đóng".
--       Bằng chứng nhánh này đã chạy và tự xoá dấu vết: 0 phiếu utility.bill
--       có utility_account_id NULL, mà toà d76268b2… lại có 2 công tơ ELECTRIC.
--       Nay: từ chối thẳng, bắt khai công tơ trước. KHÔNG xoá công tơ nào đã
--       bị tự tạo (đó là dữ liệu, chủ đã cấm đụng).
--
--   B3. public.pay_period_fee chạy chốt chống trùng CHỈ khi NOT p_force, mà
--       nút xác nhận trên giao diện ghi thẳng chữ "Đóng thêm" ⇒ ai cũng bấm
--       qua được. Thêm nữa, phép đo trùng là SELECT-rồi-INSERT trần, không khoá,
--       nên hai cú bấm song song đều đọc "chưa có" rồi đều ghi. Nay: p_force chỉ
--       mở cho chủ tổ chức / super admin, MỌI lần dùng để lại vết trong
--       app_private.period_fee_force_events, và có khoá tư vấn theo slot
--       (org × toà × hạng mục × tháng) như pay_utility_bill.
--       ⚠ PHẠM VI THẬT (đo canonical 30/07 — đừng ghi nhận quá): 24 slot phí cố
--       định trùng / 49 lượt phiếu / 620.496.725đ hiện có KHÔNG có slot nào mang
--       system_source='fixed_fee'; 21 slot mang system_source NULL (đường tạo
--       phiếu chung bên Thu chi) và 3 slot 'utility.bill'. Cặp 66tr×2 ở 102LVT
--       cách nhau 460ms cũng là system_source NULL. B3 chỉ đóng đường GHI MỚI
--       của pay_period_fee; writer phiếu chung vẫn hở và KHÔNG thuộc slice này.
--
--   B4. public.contract_terminations UPDATE được qua REST bởi bất kỳ ai có
--       contracts.edit (policy contract_terminations_update_rbac, không ràng
--       buộc cột, không guard trigger). Sửa outstanding_debt / total_deposit /
--       early_termination_fee là ĐỔI LUÔN refund_amount — cột SINH TỰ ĐỘNG
--       (stored generated) — hoặc set status='APPROVED' để trigger
--       update_contract_on_termination_approved tự đặt hợp đồng TERMINATED,
--       không qua writer nào, không sinh bút toán nào. Mọi "snapshot bất
--       biến" sau này đều vô nghĩa khi HÀNG NGUỒN còn sửa được.
--       Nay: guard trigger đông cứng đầu vào quyết toán sau APPROVED/COMPLETED
--       và chặn nhảy thẳng sang APPROVED từ trình duyệt. KHÔNG sửa một dòng
--       contract_terminations nào đang có.
--
-- MÃ LỖI MÁY ĐỌC ĐƯỢC (frontend chỉ còn `error.message` — cả usePayPeriodFee
-- lẫn usePayUtilityBill đều `throw new Error(error.message)` nên `error.code`
-- BỊ MẤT; vì vậy mã phải nằm TRONG câu tiếng Việt, theo đúng án lệ
-- '[CASHBOOK_CLOSED]' / '[PROFIT_LOCKED]' / '[HANDOVER_LOCKED]'):
--   [UTILITY_METER_REQUIRED]      22023  — chưa khai công tơ (B2)
--   [UTILITY_BILL_DUPLICATE]      55000  — kỳ này đã có phiếu (B1)
--   [FIXED_FEE_FORCE_DENIED]      42501  — "Đóng thêm" chỉ dành cho chủ (B3)
--   [TERMINATION_SETTLED]         55000  — hồ sơ đã quyết toán, đóng băng (B4)
--   [TERMINATION_APPROVE_VIA_RPC] 42501  — duyệt phải qua RPC (B4)
-- Không mã nào chứa chuỗi "chưa bật" hay "chưa thuộc luồng canonical", nên
-- isCanonicalFallbackSignal/isIeLifecycleFallbackSignal KHÔNG nhận nhầm chúng
-- là tín hiệu fallback về legacy.
--
-- BỐN CÁI BẪY ĐÃ TRÁNH CÓ CHỦ Ý:
--   (a) 20260724120000 vá pay_utility_bill bằng mẫu neo. Nó tự no-op nếu thân
--       hàm ĐÃ chứa '(user_id, organization_id, type, name'. Thân hàm dưới đây
--       GIỮ NGUYÊN VERBATIM cả hai chuỗi neo đó ('(user_id, organization_id,
--       type, name' và "(auth.uid(), v_org, 'EXPENSE',") nên replay migration
--       cũ vẫn im lặng, không RAISE. Có hàng rào tự kiểm ở mục 5.
--   (b) Hàng rào DO $guard$ của 20260730280000 đổ migration nếu còn hàm public
--       khai STABLE/IMMUTABLE mà chạm khoá dòng. Mọi hàm ở đây để VOLATILE
--       (mặc định của plpgsql) — KHÔNG khai STABLE cho bất cứ thứ gì.
--   (c) Guard trigger PHẢI là SECURITY INVOKER (mặc định): trong hàm SECURITY
--       DEFINER owner postgres thì current_user luôn là postgres, guard kiểm
--       current_user sẽ không chặn được ai. Án lệ: 20260730130000:277,
--       20260730190000:249.
--   (d) KHÔNG redefine writer thanh lý nào. approve_contract_termination_v1
--       không có defining migration nào dưới supabase/migrations/ (chỉ có bản
--       trong scripts/authz-prepared + prod-snapshot); và hai hàm
--       terminate_contract_*_impl bọc INSERT contract_terminations trong
--       `EXCEPTION WHEN OTHERS THEN RAISE WARNING` — nếu guard chặn chúng thì
--       nó sẽ bị NUỐT thành warning và hồ sơ thanh lý mất im lặng. Cả bốn
--       writer đều SECURITY DEFINER owner postgres nên được miễn theo ROLE,
--       không cần đụng một dòng nào của chúng.
--
-- KHÔNG làm ở file này (thuộc workstream khác, ghi ra để khỏi tưởng đã xong):
--   • Reader hiện phiếu UNAPPROVED + nhãn "Chờ duyệt" (−1.1a) — WS-A.
--   • Chốt chống trùng của pay_period_fee ĐẾM CẢ UNAPPROVED (−1.6c) — CỐ Ý
--     KHÔNG làm ở đây: cộng với B3 (siết p_force) nó sẽ khoá cứng nhân viên
--     khỏi mọi kỳ đang có phiếu nháp, tức đổi một lỗ tiền thành một tắc nghẽn
--     nghiệp vụ. Phải làm CÙNG với UI hiện danh sách phiếu đang có.
--   • Hoist state hai bề mặt /thanh-toan (−1.6a) — UI.
--   • REVOKE UPDATE contract_terminations khỏi authenticated (−1.9 phương án
--     mạnh) — cần chủ quyết; guard trigger dưới đây là phương án tối thiểu mà
--     chính §−1.9 nêu làm nước lùi.
--
-- Idempotent, chạy lại được: chỉ CREATE OR REPLACE / CREATE TABLE IF NOT
-- EXISTS / DROP TRIGGER IF EXISTS + CREATE TRIGGER / REVOKE-GRANT.
-- =====================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 0. PREFLIGHT — đổ ngay nếu môi trường không như lúc đo
--
-- Cả bốn thay đổi dưới đây đều là CREATE OR REPLACE trên chữ ký ĐANG CHẠY.
-- Nếu chữ ký đã đổi (ai đó DROP + tạo lại với tham số khác) thì file này sẽ
-- tạo THÊM một overload, PostgREST resolve theo tên tham số và hàm cũ vẫn
-- sống ⇒ lỗ vẫn hở trong im lặng. Thà đổ ở đây.
-- ─────────────────────────────────────────────────────────────────────
DO $preflight$
DECLARE
  v_missing text := '';
BEGIN
  IF to_regprocedure(
       'public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid)'
     ) IS NULL THEN
    v_missing := v_missing || ' pay_utility_bill/10';
  END IF;
  IF to_regprocedure(
       'public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)'
     ) IS NULL THEN
    v_missing := v_missing || ' pay_period_fee/11';
  END IF;
  IF to_regprocedure('app_private.is_org_owner_v1(uuid,uuid)') IS NULL THEN
    v_missing := v_missing || ' app_private.is_org_owner_v1/2';
  END IF;
  IF to_regprocedure('public.is_super_admin()') IS NULL THEN
    v_missing := v_missing || ' is_super_admin/0';
  END IF;
  IF to_regprocedure('public.can_create_restricted_ie()') IS NULL THEN
    v_missing := v_missing || ' can_create_restricted_ie/0';
  END IF;
  IF to_regclass('public.contract_terminations') IS NULL THEN
    v_missing := v_missing || ' contract_terminations';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION
      'Slice −1 WS-B preflight: thiếu đối tượng với chữ ký đã đo —%. DỪNG, không vá mù.',
      v_missing;
  END IF;
  RAISE NOTICE 'Slice −1 WS-B preflight: xanh';
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- 1. B1 + B2 — public.pay_utility_bill
--
-- Thay đổi so với thân hàm đang chạy (đọc bằng pg_get_functiondef 30/07),
-- ngoài bốn điểm này thì GIỮ NGUYÊN từng dòng:
--   (i)   đọc organization_id CÙNG LÚC với user_id của toà (trước đây đọc lại
--         ở giữa hàm, cùng một toà, cùng một giá trị) — cần v_org sớm để dựng
--         khoá chống trùng;
--   (ii)  p_utility_account_id IS NULL ⇒ TỪ CHỐI (B2), thay vì INSERT công tơ mới;
--   (iii) khoá tư vấn theo slot + kiểm trùng TRƯỚC mọi tác dụng phụ (B1);
--   (iv)  UPDATE siêu dữ liệu công tơ dời xuống SAU chốt chống trùng, để một
--         lần bấm bị từ chối không sửa gì cả.
-- Ngưỡng tự duyệt (v_threshold) GIỮ NGUYÊN — đổi nó là quyết định của chủ,
-- không phải hotfix.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pay_utility_bill(
  p_building_id uuid,
  p_utility_type text,
  p_amount numeric,
  p_period_month text,
  p_voucher_date date DEFAULT NULL::date,
  p_provider_code text DEFAULT NULL::text,
  p_account_holder text DEFAULT NULL::text,
  p_account_id uuid DEFAULT NULL::uuid,
  p_attachments jsonb DEFAULT NULL::jsonb,
  p_utility_account_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'app_private'
AS $fn$
DECLARE
  v_owner   uuid;
  v_acc     uuid;
  v_meter   uuid;
  v_type    uuid;
  v_caller  text;
  v_type_nm text;
  v_vdate   date;
  v_p_start date;
  v_p_end   date;
  v_voucher uuid;
  v_code    text;
  v_total   numeric;
  v_org     uuid;        -- t5_28: org của toà để đọc ngưỡng
  v_threshold numeric;   -- ngưỡng tự duyệt phiếu chi (nếu có)
  v_status  text;        -- trạng thái sinh theo ngưỡng
  v_appr_by uuid;
  v_appr_at timestamptz;
  v_kind_vn text;        -- Slice −1: "điện"/"nước" cho câu lỗi
  v_dup_code   text;     -- Slice −1 B1: phiếu đã có của đúng slot này
  v_dup_amount numeric;
  v_dup_status text;
  v_meter_code text;     -- Slice −1 B1: mã khách hàng của công tơ ĐANG chọn
  v_meter_cnt  int;      -- Slice −1 B1: số công tơ cùng loại của toà (>1 thì gợi ý chọn lại)
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  IF p_utility_type NOT IN ('ELECTRIC','WATER') THEN RAISE EXCEPTION 'Loại tiện ích không hợp lệ'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Số tiền phải lớn hơn 0'; END IF;
  IF p_period_month !~ '^\d{4}-\d{2}$' THEN RAISE EXCEPTION 'Kỳ không hợp lệ (cần YYYY-MM)'; END IF;

  v_kind_vn := CASE WHEN p_utility_type = 'ELECTRIC' THEN 'điện' ELSE 'nước' END;

  SELECT b.user_id, b.organization_id INTO v_owner, v_org
    FROM buildings b WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà'; END IF;
  IF NOT (public.can_access_building(p_building_id) OR public.ie_all_buildings_scope(p_building_id)
          OR v_owner = auth.uid() OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên toà này' USING ERRCODE = '42501';
  END IF;

  -- ══ Slice −1 B2: KHÔNG tự tạo công tơ nữa ══════════════════════════
  -- Nhánh ELSE cũ INSERT một dòng building_utility_accounts mới mỗi lần
  -- p_utility_account_id NULL. Giao diện gửi NULL cho MỌI toà/loại chưa khai
  -- công tơ (dòng tổng hợp accountId=null), nên một cú bấm check bình thường
  -- là sinh công tơ trong im lặng; và vì map "đã đóng" khoá theo id công tơ,
  -- dòng vừa sinh không bao giờ hiện "đã đóng" ⇒ mời người dùng bấm lại.
  -- Chặn ở đây là chặn cả hai hệ quả bằng một câu.
  IF p_utility_account_id IS NULL THEN
    RAISE EXCEPTION
      '[UTILITY_METER_REQUIRED] Toà này chưa khai công tơ % — hãy khai công tơ (mã khách hàng / chủ hộ) rồi đóng tiền cho đúng công tơ. Trước đây hệ thống tự tạo công tơ mới mỗi lần bấm, nên dòng đó không bao giờ hiện "đã đóng" và tiền đóng hai lần không ai thấy.',
      v_kind_vn
      USING ERRCODE = '22023';
  END IF;

  SELECT id, NULLIF(btrim(COALESCE(provider_code, '')), '')
    INTO v_meter, v_meter_code
    FROM building_utility_accounts
   WHERE id = p_utility_account_id AND building_id = p_building_id
     AND utility_type = p_utility_type AND deleted_at IS NULL;
  IF v_meter IS NULL THEN RAISE EXCEPTION 'Không tìm thấy đồng hồ điện/nước'; END IF;

  -- Slice −1 B1: toà có MẤY công tơ cùng loại? Cần cho câu lỗi chống trùng.
  -- Ca thật 1392QT: HAI hợp đồng điện riêng (PE13000241972 và PE13000241924,
  -- cùng chủ hộ Hoàng Công Hiệp), mỗi tháng là một hoá đơn lớn + một hoá đơn nhỏ.
  -- Không nói rõ công tơ nào thì người dùng đọc "kỳ này đã có phiếu" sẽ tưởng
  -- mình bấm trùng, trong khi thực tế họ đang trả hoá đơn của công tơ CÒN LẠI.
  SELECT count(*) INTO v_meter_cnt
    FROM building_utility_accounts
   WHERE building_id = p_building_id AND utility_type = p_utility_type
     AND deleted_at IS NULL;

  v_p_start := to_date(p_period_month || '-01', 'YYYY-MM-DD');
  v_p_end   := (date_trunc('month', v_p_start) + interval '1 month - 1 day')::date;

  -- ══ Slice −1 B1: MỘT PHIẾU / MỘT CÔNG TƠ / MỘT KỲ ═════════════════
  -- Khoá tư vấn theo đúng slot TRƯỚC khi đọc: SELECT-rồi-INSERT trần bị đua
  -- (hai tab, hai lần bấm, hai transaction cùng thấy "chưa có" rồi cùng ghi).
  -- Khoá cấp transaction nên tự nhả khi commit/rollback, và chỉ xếp hàng đúng
  -- một slot — không serialize cả bảng.
  -- COALESCE quanh v_org là bắt buộc: pg_advisory_xact_lock STRICT, truyền NULL
  -- thì nó trả NULL và KHÔNG lấy khoá nào — mất chống-đua trong im lặng.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'utility.bill:' || COALESCE(v_org::text, '-') || ':' || v_meter::text || ':'
        || p_utility_type || ':' || to_char(v_p_start, 'YYYY-MM'),
      0
    )
  );

  -- Khoá nghiệp vụ = (org, công tơ, loại tiện ích, tháng tính tiền). Không cần
  -- viết org và loại vào WHERE: id công tơ QUYẾT ĐỊNH cả hai (công tơ thuộc
  -- đúng một toà, và ở trên đã kiểm building_id + utility_type khớp) — thêm
  -- `organization_id = v_org` vào đây chỉ tạo nguy cơ BỎ SÓT nếu có phiếu cũ
  -- org NULL, tức tự vô hiệu hoá chính chốt này.
  -- Tháng lấy từ ITEM (income_expenses không có cột kỳ); date_trunc để chịu
  -- được 19 phiếu lịch sử có start_date không nằm ngày 1.
  -- CỐ Ý ĐẾM CẢ 'UNAPPROVED': phiếu chờ duyệt là phiếu VÔ HÌNH trên bảng
  -- điện/nước (reader lọc APPROVED) — đó chính là lý do người dùng bấm lại.
  -- KHÔNG đếm phiếu đã huỷ: huỷ mềm (cancel_utility_bill đặt deleted_at) hoặc
  -- huỷ linh hoạt Đợt 4 (approval_status='CANCELLED') ⇒ đóng lại được.
  SELECT ie.code, ie.total_amount, ie.approval_status
    INTO v_dup_code, v_dup_amount, v_dup_status
    FROM income_expenses ie
   WHERE ie.system_source = 'utility.bill'
     AND ie.utility_account_id = v_meter
     AND ie.deleted_at IS NULL
     AND ie.approval_status <> 'CANCELLED'
     AND EXISTS (
       SELECT 1 FROM income_expense_items it
        WHERE it.income_expense_id = ie.id
          AND it.start_date IS NOT NULL
          AND date_trunc('month', it.start_date)::date = v_p_start
     )
   ORDER BY ie.created_at, ie.id
   LIMIT 1;

  IF v_dup_code IS NOT NULL THEN
    RAISE EXCEPTION
      '[UTILITY_BILL_DUPLICATE] Kỳ % của công tơ % ĐÃ CÓ phiếu chi % — %đ (%). Không tạo phiếu thứ hai. Nếu phiếu cũ đang chờ duyệt thì DUYỆT nó; nếu phiếu cũ sai thì HUỶ nó rồi đóng lại.%',
      to_char(v_p_start, 'MM/YYYY'),
      COALESCE(v_meter_code, 'này'),
      v_dup_code,
      round(COALESCE(v_dup_amount, 0))::bigint::text,
      CASE v_dup_status WHEN 'UNAPPROVED' THEN 'đang chờ duyệt' ELSE 'đã duyệt' END,
      -- Gợi ý chỉ hiện khi toà THẬT SỰ có nhiều công tơ cùng loại — nếu không thì
      -- thêm câu này chỉ làm người dùng đi tìm một công tơ không tồn tại.
      CASE WHEN COALESCE(v_meter_cnt, 1) > 1
           THEN format(' Lưu ý: toà này có %s công tơ %s. Nếu hoá đơn bạn đang trả thuộc công tơ khác thì hãy chọn đúng công tơ đó rồi đóng lại.',
                       v_meter_cnt, v_kind_vn)
           ELSE '' END
      USING ERRCODE = '55000';
  END IF;

  -- Sổ ghi chi (mặc định "…Thu" caller)
  IF p_account_id IS NOT NULL THEN
    SELECT id INTO v_acc FROM accounts
     WHERE id = p_account_id AND deleted_at IS NULL
       AND (user_id = auth.uid() OR public.is_admin() OR public.is_super_admin());
    IF v_acc IS NULL THEN RAISE EXCEPTION 'Sổ quỹ không hợp lệ hoặc bạn không có quyền ghi chi vào sổ này' USING ERRCODE = '42501'; END IF;
  ELSE
    SELECT id INTO v_acc FROM accounts
     WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'
     ORDER BY is_default DESC NULLS LAST, name LIMIT 1;
    IF v_acc IS NULL THEN RAISE EXCEPTION 'Bạn chưa có sổ quỹ "…Thu" để chi tiền'; END IF;
  END IF;

  -- Học siêu dữ liệu công tơ — dời xuống SAU chốt chống trùng để một lần bấm
  -- bị từ chối không để lại thay đổi nào.
  UPDATE building_utility_accounts SET
    provider_code  = COALESCE(NULLIF(btrim(p_provider_code), ''), provider_code),
    account_holder = COALESCE(NULLIF(btrim(p_account_holder), ''), account_holder),
    updated_at = now()
  WHERE id = v_meter;

  -- t5_28: hoá đơn điện/nước là phiếu CHI → tôn trọng NGƯỠNG tự duyệt của org.
  -- Dưới ngưỡng (hoặc chưa đặt ngưỡng) → tự duyệt như cũ; từ ngưỡng trở lên →
  -- sinh NHÁP chờ duyệt tay (khớp phương án owner + create_income_expense_v1).
  SELECT c.threshold INTO v_threshold
    FROM app_private.ie_auto_approve_config c WHERE c.organization_id = v_org;
  IF v_threshold IS NOT NULL AND p_amount >= v_threshold THEN
    v_status := 'UNAPPROVED'; v_appr_by := NULL; v_appr_at := NULL;
  ELSE
    v_status := 'APPROVED'; v_appr_by := auth.uid(); v_appr_at := now();
  END IF;

  v_type_nm := CASE WHEN p_utility_type = 'ELECTRIC' THEN 'Đóng tiền điện' ELSE 'Đóng tiền nước' END;
  v_type := public._termination_ensure_type(v_owner, 'expense', v_type_nm);
  UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type AND is_deposit IS DISTINCT FROM FALSE;

  v_vdate   := COALESCE(p_voucher_date, CURRENT_DATE);
  SELECT COALESCE(full_name, '') INTO v_caller FROM profiles WHERE id = auth.uid();

  -- ⚠ HAI DÒNG DƯỚI LÀ MẪU NEO của 20260724120000 — giữ VERBATIM (mục 5 tự kiểm).
  INSERT INTO income_expenses
    (user_id, organization_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, approved_by, approved_at,
     business_result_accounting, notes, creator_name,
     attachments, system_source, utility_account_id)
  VALUES
    (auth.uid(), v_org, 'EXPENSE',
     'Đóng ' || lower(v_type_nm) || ' (NCC) — kỳ ' || to_char(v_p_start, 'MM/YYYY'),
     p_building_id, v_acc, v_vdate,
     p_amount, v_status, v_appr_by, v_appr_at, TRUE,
     'Chủ nhà đóng ' || lower(v_type_nm) || ' cho cả toà — kỳ ' || to_char(v_p_start, 'MM/YYYY')
       || COALESCE(' — mã ' || NULLIF(btrim(p_provider_code), ''), '')
       || COALESCE(' — chủ hộ ' || NULLIF(btrim(p_account_holder), ''), ''),
     v_caller,
     COALESCE(p_attachments, '[]'::jsonb), 'utility.bill', v_meter)
  RETURNING id INTO v_voucher;

  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES
    (v_voucher, v_type, 'Đóng ' || lower(v_type_nm) || ' kỳ ' || to_char(v_p_start, 'MM/YYYY'),
     1, p_amount, v_p_start, v_p_end);

  SELECT code, total_amount INTO v_code, v_total FROM income_expenses WHERE id = v_voucher;
  RETURN jsonb_build_object('voucher_id', v_voucher, 'code', v_code,
    'total_amount', v_total, 'account_id', v_acc, 'utility_account_id', v_meter);
END;
$fn$;

REVOKE ALL ON FUNCTION public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid) IS
  'Đóng hoá đơn điện/nước của toà (1 phiếu CHI). Slice −1: bắt buộc có công tơ (không tự tạo) và chống trùng theo (công tơ, loại, tháng) cho phiếu chưa huỷ — kể cả phiếu đang chờ duyệt. Không đụng dữ liệu lịch sử.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. B3 — "Đóng thêm" (p_force) chỉ dành cho CHỦ, và luôn để lại vết
-- ─────────────────────────────────────────────────────────────────────

-- 2.1 Sổ vết. Bảng riêng trong app_private, append-only, theo đúng khuôn
--     app_private.income_expense_cancellations (20260730140000).
CREATE TABLE IF NOT EXISTS app_private.period_fee_force_events (
  id                   uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id      uuid,
  building_id          uuid NOT NULL,
  category_key         text NOT NULL,
  period_start         text NOT NULL,
  period_end           text NOT NULL,
  amount               numeric(15,2) NOT NULL,
  existing_count       integer NOT NULL DEFAULT 0,   -- phiếu APPROVED đã có lúc ghi đè
  existing_amount      numeric(15,2) NOT NULL DEFAULT 0,
  voucher_id           uuid,                          -- phiếu mới sinh ra
  actor_user_id        uuid,
  actor_is_super_admin boolean,
  actor_is_org_owner   boolean,
  created_at           timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON app_private.period_fee_force_events
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.period_fee_force_events IS
  'Mỗi lần dùng p_force ("Đóng thêm") của pay_period_fee. Append-only. Trước Slice −1, đường này ghi đè chốt chống trùng mà KHÔNG để lại bất kỳ dấu nào — 24 slot / 49 lượt phiếu phí cố định trùng trên production không truy được ai bấm.';

-- search_path GHIM như mọi hàm khác của hai file này: thân hàm hôm nay chỉ RAISE
-- theo TG_OP nên không có tên nào để chiếm, nhưng đây là trigger trên bảng của
-- schema đặc quyền — để trống là bỏ ngỏ đúng lớp bảo vệ mà file này đang dựng.
CREATE OR REPLACE FUNCTION app_private.guard_period_fee_force_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'app_private'
AS $fn$
BEGIN
  RAISE EXCEPTION 'period_fee_force_events là append-only (thao tác %)', TG_OP
    USING ERRCODE = '55000';
END
$fn$;

DROP TRIGGER IF EXISTS a00_period_fee_force_append_only ON app_private.period_fee_force_events;
CREATE TRIGGER a00_period_fee_force_append_only
  BEFORE UPDATE OR DELETE ON app_private.period_fee_force_events
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_period_fee_force_append_only();

-- 2.2 pay_period_fee. Thay đổi so với thân hàm đang chạy:
--   (i)   đọc organization_id của toà (cần cho cổng chủ + sổ vết);
--   (ii)  phép ĐO trùng chạy LUÔN LUÔN — trước đây cả phép đo nằm trong
--         IF NOT p_force, nên "Đóng thêm" không biết mình ghi đè cái gì;
--   (iii) p_force = true ⇒ đòi chủ tổ chức / super admin, nếu không thì 42501;
--   (iv)  mọi lần p_force được chấp nhận đều INSERT một dòng sổ vết.
-- GIỮ NGUYÊN: gate public.can_create_restricted_ie() cho hạng mục 'quan_ly'
-- (gate server THẬT, nằm trong scripts/definer-acl-baseline.json — plan §2.1
-- yêu cầu không đụng), 'APPROVED' hardcode, cách chia accrual, và hình dạng
-- jsonb trả về khi trùng ('warning'/'existing_count'/'existing_amount' —
-- usePeriodFeeState phụ thuộc đúng ba khoá này; Slice −1 THÊM khoá thứ tư
-- 'can_force', client cũ bỏ qua an toàn vì nó chỉ đọc theo tên khoá).
--
-- ⚠ TODO — QUYẾT ĐỊNH CỦA CHỦ CÒN TREO (Slice 0), ĐỪNG ĐOÁN:
--   "Chủ tổ chức" hiện có HAI định nghĩa chạy song song trên production:
--     • app_private.is_org_owner_v1 → khớp CHUỖI TÊN vai trò 'Chủ sở hữu tổ
--       chức', trong thân hàm KHÔNG có chữ member_type nào;
--     • plan văn bản → organization_memberships.member_type = 'OWNER'.
--   Ở org DEMO hai định nghĩa LỆCH NHAU 2/3 người, trong đó có demo.quanly
--   (member_type = STAFF nhưng vẫn là role-owner) — chính tài khoản hạm đội
--   E2E dùng. Ở org thật thì trùng khít (1 người).
--   File này CỐ Ý dùng app_private.is_org_owner_v1 vì đó là hành vi ĐANG chạy
--   ở mọi cổng chủ khác (vd reverse_invoice_collection_v5), tức rủi ro thấp
--   nhất. Rủi ro còn lại đã biết: organization_roles.name là text tự do, đổi
--   tên vai trò sẽ ÂM THẦM tắt cửa chủ ở đây → mục 4bis neo helper vào
--   system_key='TENANT_OWNER' VÀ khoá luôn việc đổi tên vai trò is_system, vì
--   ngoài helper còn 5 hàm khác vẫn so theo chuỗi tên (xem 4bis).
--   NGUỒN SỰ THẬT DUY NHẤT cho "chủ sở hữu" phải do chủ chốt ở Slice 0; khi
--   chốt xong, sửa MỘT chỗ: hai dòng gán v_is_owner/v_is_super bên dưới.
CREATE OR REPLACE FUNCTION public.pay_period_fee(
  p_building_id uuid,
  p_category_key text,
  p_amount numeric,
  p_period_start text,
  p_period_end text,
  p_voucher_date date DEFAULT NULL::date,
  p_provider_code text DEFAULT NULL::text,
  p_account_holder text DEFAULT NULL::text,
  p_account_id uuid DEFAULT NULL::uuid,
  p_attachments jsonb DEFAULT NULL::jsonb,
  p_force boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
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

  -- ── CHỐNG ĐÓNG TRÙNG: đã có phiếu APPROVED cùng hạng mục giao kỳ? ──
  -- Slice −1: phép ĐO chạy luôn, kể cả khi p_force — sổ vết phải ghi được
  -- "ghi đè lên mấy phiếu, tổng bao nhiêu". Trước đây cả khối này nằm trong
  -- IF NOT p_force nên "Đóng thêm" đi qua trong bóng tối.
  -- (Chưa mở rộng sang UNAPPROVED ở slice này — xem ghi chú đầu file.)
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
                               AND ie.approval_status = 'APPROVED'
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
    SELECT id INTO v_acc FROM accounts
     WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'
     ORDER BY is_default DESC NULLS LAST, name LIMIT 1;
    IF v_acc IS NULL THEN
      RAISE EXCEPTION 'Bạn chưa có sổ quỹ "…Thu" để chi tiền';
    END IF;
  END IF;

  v_type := public.resolve_fixed_expense_type(v_owner, p_category_key);
  UPDATE income_expense_types SET is_deposit = FALSE
   WHERE id = v_type AND is_deposit IS DISTINCT FROM FALSE;

  v_vdate  := COALESCE(p_voucher_date, CURRENT_DATE);
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
     p_amount, 'APPROVED', TRUE,
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
     round(p_amount / GREATEST(v_months, 1)), v_acc, v_owner)
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

  SELECT code, total_amount INTO v_code, v_total FROM income_expenses WHERE id = v_voucher;

  RETURN jsonb_build_object(
    'voucher_id', v_voucher, 'code', v_code,
    'total_amount', v_total, 'account_id', v_acc);
END;
$fn$;

REVOKE ALL ON FUNCTION public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean) IS
  'Đóng phí cố định theo kỳ cho toà (1 phiếu CHI). Slice −1: p_force ("Đóng thêm") chỉ mở cho chủ tổ chức / super admin và luôn ghi app_private.period_fee_force_events. Không đụng dữ liệu lịch sử.';

-- ─────────────────────────────────────────────────────────────────────
-- 3. B4 — đông cứng hàng nguồn quyết toán thanh lý
-- ─────────────────────────────────────────────────────────────────────

-- 3.1 Cửa cho writer (tiền lệ: app_private.ie_flex_writer_xids 20260730120000,
--     app_private.termination_move_out_writer_context).
--
-- HÔM NAY CHƯA AI CẦN CỬA NÀY, và đó là chủ ý: cả BỐN writer hợp lệ đã đo
-- (terminate_contract_move_out_impl, terminate_contract_forfeit_impl,
-- approve_contract_termination_v1, reject_contract_termination_v1) đều là
-- SECURITY DEFINER owner postgres ⇒ trong thân chúng current_user = 'postgres'
-- và guard ở 3.2 tự nhường đường. Nhờ vậy KHÔNG phải CREATE OR REPLACE bất kỳ
-- writer nào (xem bẫy (d) đầu file — vì sao điều đó quan trọng).
-- Cửa này dựng sẵn cho writer canonical của Slice 0 nếu writer đó chạy dưới
-- quyền authenticated (SECURITY INVOKER).
CREATE TABLE IF NOT EXISTS app_private.contract_termination_writer_xids (
  transaction_id   xid8 NOT NULL,
  backend_pid      integer NOT NULL,
  termination_id   uuid NOT NULL,
  scope            text NOT NULL,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transaction_id, backend_pid, termination_id),
  CONSTRAINT contract_termination_writer_xids_scope_chk
    CHECK (scope IN ('SETTLE', 'APPROVE', 'REJECT'))
);

REVOKE ALL ON app_private.contract_termination_writer_xids
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE app_private.contract_termination_writer_xids IS
  'Năng lực ghi hồ sơ thanh lý trong ĐÚNG transaction hiện tại. Chỉ writer SECURITY DEFINER mở được (hai hàm begin/end đã REVOKE khỏi mọi role client). Rollback thì dòng biến mất theo.';

CREATE OR REPLACE FUNCTION app_private.begin_contract_termination_write_v1(
  p_termination uuid, p_scope text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF p_termination IS NULL OR p_scope IS NULL THEN
    RAISE EXCEPTION 'begin_contract_termination_write_v1: thiếu tham số' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app_private.contract_termination_writer_xids
    (transaction_id, backend_pid, termination_id, scope)
  VALUES
    (pg_current_xact_id(), pg_backend_pid(), p_termination, p_scope)
  ON CONFLICT (transaction_id, backend_pid, termination_id)
  DO UPDATE SET scope = excluded.scope, opened_at = now();
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.end_contract_termination_write_v1(
  p_termination uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  DELETE FROM app_private.contract_termination_writer_xids w
   WHERE w.transaction_id = pg_current_xact_id()
     AND w.backend_pid = pg_backend_pid()
     AND (p_termination IS NULL OR w.termination_id = p_termination);
END
$fn$;

REVOKE ALL ON FUNCTION app_private.begin_contract_termination_write_v1(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.end_contract_termination_write_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- 3.1bis ĐỌC cửa writer từ trong guard SECURITY INVOKER — BẮT BUỘC phải qua hàm
-- SECURITY DEFINER này, KHÔNG được SELECT thẳng bảng app_private.
--
-- Vì sao: guard ở 3.2 là SECURITY INVOKER (đúng, xem lý do ở đó), nên khi phiếu
-- đi đường REST thì nó chạy dưới role `authenticated`. Role đó KHÔNG có USAGE
-- trên schema app_private — đo trên prod 30/07:
--     pg_namespace.nspacl = {postgres=UC/postgres,ie_canonical_writer=U/postgres}
--     has_schema_privilege('authenticated','app_private','USAGE') = false
-- Một `SELECT ... FROM app_private.<bảng>` trong thân guard vì thế đổ
-- `42501 permission denied for schema app_private` NGAY KHI executor khởi động
-- câu lệnh — kể cả khi mệnh đề bị short-circuit — nên MỌI INSERT/UPDATE REST lên
-- contract_terminations sẽ chết bằng một câu tiếng Anh vô nghĩa, không bao giờ
-- tới được [TERMINATION_SETTLED] / [TERMINATION_APPROVE_VIA_RPC], và những cột
-- mà 3.2 CỐ Ý không đóng băng (notes, internal_notes, refund_method,
-- refund_receipt_url, damage_*, other_fees_description, mọi sửa DRAFT) cũng vỡ
-- theo. Đó lại đúng là "phương án mạnh" của §−1.9 (revoke UPDATE khỏi
-- authenticated) mà chủ chưa quyết — và còn chặn cả INSERT, điều §−1.9 không hề
-- nêu. Bọc qua SECURITY DEFINER là cách duy nhất giữ đúng CẢ HAI: current_user
-- trong guard vẫn là 'authenticated', mà vẫn đọc được bảng cửa.
CREATE OR REPLACE FUNCTION public.has_contract_termination_write_v1(p_termination uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM app_private.contract_termination_writer_xids w
     WHERE w.transaction_id = pg_current_xact_id()
       AND w.backend_pid    = pg_backend_pid()
       AND w.termination_id = p_termination
  );
$fn$;

REVOKE ALL ON FUNCTION public.has_contract_termination_write_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_contract_termination_write_v1(uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.has_contract_termination_write_v1(uuid) IS
  'Cửa writer hồ sơ thanh lý CÓ MỞ trong transaction+backend hiện tại cho đúng hồ sơ này? '
  'SECURITY DEFINER vì guard gọi nó là SECURITY INVOKER và role authenticated KHÔNG có USAGE '
  'trên schema app_private (đọc thẳng bảng ⇒ 42501 permission denied for schema app_private, '
  'chết mọi INSERT/UPDATE REST trước khi tới được mã lỗi tiếng Việt). VOLATILE: đọc trạng thái '
  'transaction (pg_current_xact_id) và tránh án lệ 20260730280000 về hàm STABLE chạm khoá dòng.';

-- 3.2 Guard trigger.
--
-- SECURITY INVOKER (mặc định — KHÔNG khai SECURITY DEFINER) là BẮT BUỘC: trong
-- hàm SECURITY DEFINER owner postgres thì current_user luôn là postgres, guard
-- kiểm current_user sẽ không chặn được ai. Án lệ đã ghi trong repo:
-- 20260730130000:277, 20260730190000:249; guard_invoice_derived_columns là bản
-- mẫu trực tiếp của hàm này.
--
-- VOLATILE (mặc định của plpgsql) — không khai STABLE, kẻo hàng rào DO $guard$
-- của 20260730280000 nổ.
--
-- Đặt tên 'a00_…' để chạy TRƯỚC ba trigger BEFORE đang có
-- (contract_terminations_set_user_id_audit, trg_autofill_org,
-- trigger_auto_calculate_termination_financials) và trước
-- trigger_update_contract_on_termination (status→APPROVED thì đặt hợp đồng
-- TERMINATED). Nhờ vậy guard thấy ĐÚNG ý định client, chưa bị autofill trộn
-- vào, và chặn được nhánh đặt hợp đồng TERMINATED trước khi nó chạy.
-- Đã đo: 35/35 dòng COMPLETED KHÔNG có cột tiền nào NULL, nên autofill (chỉ
-- điền khi NULL) không có gì để âm thầm điền sau lưng guard.
--
-- CỐ Ý KHÔNG đóng băng: notes, internal_notes, refund_method,
-- refund_receipt_url, damage_description, damage_images,
-- other_fees_description — chứng từ/diễn giải bổ sung sau quyết toán là hợp lệ,
-- và không cột nào trong đó vào công thức refund_amount.
CREATE OR REPLACE FUNCTION public.guard_contract_termination_settlement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_frozen text := NULL;
BEGIN
  -- Chỉ soi đường REST của trình duyệt. Writer SECURITY DEFINER chạy dưới
  -- postgres, edge function chạy dưới service_role — cả hai đi thẳng.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- ── INSERT: không cho khai sinh một hồ sơ ĐÃ quyết toán từ trình duyệt.
  -- UNIQUE(contract_id) chỉ chặn được hợp đồng ĐÃ có hồ sơ; hợp đồng chưa có
  -- thì client tự INSERT một dòng status='COMPLETED' với total_deposit tuỳ ý
  -- là xong — không writer nào, không bút toán nào.
  IF TG_OP = 'INSERT' THEN
    -- Qua hàm SECURITY DEFINER ở 3.1bis — KHÔNG SELECT thẳng app_private, xem
    -- lý do ở đó (authenticated không có USAGE ⇒ 42501 ngay lúc khởi động câu).
    IF public.has_contract_termination_write_v1(NEW.id) THEN
      RETURN NEW;
    END IF;

    IF COALESCE(NEW.status, '') IN ('APPROVED', 'COMPLETED') THEN
      RAISE EXCEPTION
        '[TERMINATION_APPROVE_VIA_RPC] Không tạo hồ sơ thanh lý ở trạng thái % từ giao diện. Hồ sơ phải do RPC thanh lý sinh ra (trả phòng / bỏ cọc), hoặc tạo ở trạng thái DRAFT rồi duyệt bằng approve_contract_termination_v1.',
        NEW.status
        USING ERRCODE = '42501';
    END IF;
    IF NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION
        '[TERMINATION_APPROVE_VIA_RPC] approved_by / approved_at do RPC duyệt đóng dấu — không ghi tay từ giao diện.'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- ── UPDATE ─────────────────────────────────────────────────────────
  -- Cửa writer (3.1) — hôm nay chưa writer nào dùng, xem ghi chú ở 3.1.
  -- Đọc qua hàm SECURITY DEFINER ở 3.1bis (lý do: 42501 schema app_private).
  IF public.has_contract_termination_write_v1(OLD.id) THEN
    RETURN NEW;
  END IF;

  -- (1) Hồ sơ ĐÃ quyết toán ⇒ đông cứng đầu vào tiền + mốc nhận diện.
  -- refund_amount và total_deductions là cột SINH TỰ ĐỘNG (stored generated)
  -- từ đúng các cột dưới đây, nên sửa một cột là đổi số tiền phải hoàn mà
  -- không sinh phiếu nào, không để lại vết nào.
  IF COALESCE(OLD.status, '') IN ('APPROVED', 'COMPLETED') THEN
    IF    NEW.total_deposit         IS DISTINCT FROM OLD.total_deposit         THEN v_frozen := 'total_deposit';
    ELSIF NEW.outstanding_debt      IS DISTINCT FROM OLD.outstanding_debt      THEN v_frozen := 'outstanding_debt';
    ELSIF NEW.early_termination_fee IS DISTINCT FROM OLD.early_termination_fee THEN v_frozen := 'early_termination_fee';
    ELSIF NEW.notice_violation_fee  IS DISTINCT FROM OLD.notice_violation_fee  THEN v_frozen := 'notice_violation_fee';
    ELSIF NEW.damage_fee            IS DISTINCT FROM OLD.damage_fee            THEN v_frozen := 'damage_fee';
    ELSIF NEW.cleaning_fee          IS DISTINCT FROM OLD.cleaning_fee          THEN v_frozen := 'cleaning_fee';
    ELSIF NEW.other_fees            IS DISTINCT FROM OLD.other_fees            THEN v_frozen := 'other_fees';
    ELSIF NEW.prorated_rent         IS DISTINCT FROM OLD.prorated_rent         THEN v_frozen := 'prorated_rent';
    ELSIF NEW.prorated_services     IS DISTINCT FROM OLD.prorated_services     THEN v_frozen := 'prorated_services';
    ELSIF NEW.prorated_days         IS DISTINCT FROM OLD.prorated_days         THEN v_frozen := 'prorated_days';
    ELSIF NEW.contract_id           IS DISTINCT FROM OLD.contract_id           THEN v_frozen := 'contract_id';
    ELSIF NEW.termination_type      IS DISTINCT FROM OLD.termination_type      THEN v_frozen := 'termination_type';
    ELSIF NEW.actual_move_out_date  IS DISTINCT FROM OLD.actual_move_out_date  THEN v_frozen := 'actual_move_out_date';
    ELSIF NEW.termination_date      IS DISTINCT FROM OLD.termination_date      THEN v_frozen := 'termination_date';
    ELSIF NEW.refund_date           IS DISTINCT FROM OLD.refund_date           THEN v_frozen := 'refund_date';
    END IF;

    IF v_frozen IS NOT NULL THEN
      RAISE EXCEPTION
        '[TERMINATION_SETTLED] Hồ sơ thanh lý đã ở trạng thái % — không sửa được cột "%" từ giao diện. Số tiền phải hoàn (refund_amount) do các cột này SINH RA, sửa một cột là đổi tiền mà không sinh phiếu nào. Sai sót phát hiện sau quyết toán phải xử lý bằng phiếu điều chỉnh.',
        OLD.status, v_frozen
        USING ERRCODE = '55000';
    END IF;

    -- Không cho hạ trạng thái để "mở băng" rồi sửa vòng hai.
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION
        '[TERMINATION_SETTLED] Hồ sơ thanh lý đã ở trạng thái % — không đổi trạng thái từ giao diện. Mọi thay đổi phải đi qua RPC thanh lý.',
        OLD.status
        USING ERRCODE = '55000';
    END IF;
  END IF;

  -- (2) Không nhảy thẳng sang APPROVED/COMPLETED từ trình duyệt.
  -- Đặt status='APPROVED' kích trigger update_contract_on_termination_approved
  -- ⇒ hợp đồng thành TERMINATED, phòng đổi trạng thái, mà KHÔNG một bút toán
  -- tiền nào được ghi. Đây đúng là việc mà fallback client đã chết
  -- (useApproveTermination → INSERT public.cash_book, bảng KHÔNG tồn tại) làm.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('APPROVED', 'COMPLETED') THEN
    RAISE EXCEPTION
      '[TERMINATION_APPROVE_VIA_RPC] Duyệt/hoàn tất thanh lý phải gọi approve_contract_termination_v1. Đặt status = % trực tiếp sẽ khiến hợp đồng thành TERMINATED mà không sinh bút toán tiền nào.',
      NEW.status
      USING ERRCODE = '42501';
  END IF;

  -- (3) Dấu duyệt do server đóng, không nhận từ client (mọi trạng thái).
  IF NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION
      '[TERMINATION_APPROVE_VIA_RPC] approved_by / approved_at do RPC duyệt đóng dấu — không ghi tay từ giao diện.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.guard_contract_termination_settlement() IS
  'Slice −1 B4: chặn REST sửa đầu vào quyết toán của hồ sơ thanh lý đã APPROVED/COMPLETED, chặn nhảy status sang APPROVED/COMPLETED và chặn khai sinh hồ sơ đã quyết toán ngoài RPC. SECURITY INVOKER bắt buộc (guard kiểm current_user).';

DROP TRIGGER IF EXISTS a00_contract_termination_settlement_guard ON public.contract_terminations;
CREATE TRIGGER a00_contract_termination_settlement_guard
  BEFORE INSERT OR UPDATE ON public.contract_terminations
  FOR EACH ROW EXECUTE FUNCTION public.guard_contract_termination_settlement();

-- ─────────────────────────────────────────────────────────────────────
-- 4. anon không có việc gì với hồ sơ thanh lý
-- TRUNCATE bỏ qua RLS; hiện chỉ được cứu nhờ hình thái khoá ngoại, không phải
-- nhờ phân quyền. (Cùng tinh thần 20260730190000 với invoices/payments.)
-- KHÔNG revoke UPDATE khỏi authenticated ở slice này — đó là phương án mạnh
-- của §−1.9, cần chủ quyết vì nó đóng luôn mọi đường sửa hợp lệ tương lai.
-- ─────────────────────────────────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.contract_terminations FROM anon;
REVOKE TRUNCATE ON public.contract_terminations FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 4bis. THÁO MÌN HẸN GIỜ CỦA "CHỦ SỞ HỮU THEO TÊN VAI TRÒ"  (§−1.10)
--
-- Chủ đã chốt 30/07: giữ định nghĩa "chủ" theo VAI TRÒ (không đổi sang
-- member_type) — xem §1ter.3 của 2026-07-30-danh-gia-2-plan-thu-tien-v2.md.
-- Nhưng `is_org_owner_v1` đang so `organization_roles.name = 'Chủ sở hữu tổ chức'`,
-- mà `name` là TEXT TỰ DO người dùng sửa được trong Cài đặt. Đổi tên vai trò đó
-- là ÂM THẦM SẬP cửa chủ sở hữu ở mọi nơi dựng trên helper này — kể cả
-- `reverse_invoice_collection_v5` và toàn bộ cổng duyệt ngoại lệ của Plan 1.
--
-- May mắn: KHÔNG cần backfill gì cả. Vai trò chủ ở CẢ HAI org đã sẵn có
-- `is_system = true` và `system_key = 'TENANT_OWNER'`, và đó là HAI vai trò duy
-- nhất trong 11 vai trò có system_key. Nên chỉ cần đổi mệnh đề khớp sang
-- `system_key` — một định danh bền, người dùng không sửa được từ UI.
--
-- ĐÃ CHỨNG MINH TƯƠNG ĐƯƠNG trên prod trước khi viết (read-only):
--     khớp theo name = 4 (org,user) · khớp theo system_key = 4 · lost 0 · gained 0
-- Tức KHÔNG ai được thêm quyền, KHÔNG ai mất quyền. Thuần chống hồi quy.
--
-- Vế `system_key IS NULL AND name = ...` giữ lại để org nào chưa gắn system_key
-- vẫn hoạt động y như cũ; nó KHÔNG mở lỗ vì vai trò mới do người dùng tạo mà
-- trùng tên sẽ có system_key IS NULL và vẫn phải trùng tên chính xác như hiện nay.
--
-- ⚠ PHẠM VI CỦA VIỆC NEO NÀY — ĐỌC KỸ TRƯỚC KHI GHI "ĐÃ THÁO MÌN": nó chỉ chữa
-- CHÍNH helper này. Trên prod 30/07 còn NĂM hàm khác tự so chuỗi tên vai trò
-- (_termination_ensure_type, get/set_ie_auto_approve_threshold_v1,
-- set_ie_accounting_standard_v1, set_membership_status_v1) nên quả mìn vẫn còn.
-- Slice −1 xử lý bằng cách KHOÁ luôn việc đổi tên trong trigger dưới đây (fail-closed,
-- không đụng hàm tiền nào) + tự kiểm ở mục 5 để không ai thêm hàm so-theo-tên mới.
-- Neo cả 5 hàm kia sang system_key là việc của slice sau.
-- Giữ nguyên signature / STABLE / SECURITY DEFINER / search_path / ACL.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.is_org_owner_v1(p_org uuid, p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.role_bindings rb
    JOIN public.organization_memberships m
      ON m.id = rb.membership_id
     AND m.organization_id = rb.organization_id
     AND m.user_id = p_user
     AND m.status = 'ACTIVE'
     AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= now()
     AND (m.valid_to IS NULL OR m.valid_to > now())
    JOIN public.organization_roles r
      ON r.id = rb.role_id
     -- Slice −1 §−1.10: neo vào system_key bền thay cho tên tự do.
     AND (
           r.system_key = 'TENANT_OWNER'
        OR (r.system_key IS NULL AND r.name = 'Chủ sở hữu tổ chức')
     )
    WHERE rb.organization_id = p_org
      -- Cửa sổ hiệu lực của CHÍNH binding: đây là cách duy nhất repo thu hồi vai trò.
      AND COALESCE(rb.valid_from, '-infinity'::timestamptz) <= now()
      AND (rb.valid_to IS NULL OR rb.valid_to > now())
  );
$function$;

COMMENT ON FUNCTION app_private.is_org_owner_v1(uuid, uuid) IS
  'Chủ sở hữu tổ chức = có role binding còn hiệu lực tới vai trò system_key=TENANT_OWNER '
  '(Slice −1 §−1.10: trước đây so theo organization_roles.name — text tự do, đổi tên trong '
  'Cài đặt là sập cửa chủ sở hữu). Vế name chỉ còn là fallback cho org chưa gắn system_key. '
  'Đã chứng minh chọn đúng cùng tập 4 (org,user) trên prod 30/07: lost 0, gained 0.';

-- Khoá thêm ở tầng dữ liệu: không cho đổi tên / đổi system_key / xoá vai trò hệ thống.
CREATE OR REPLACE FUNCTION app_private.guard_system_role_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN
      RAISE EXCEPTION 'Không được xoá vai trò hệ thống "%" (system_key=%). '
                      'Vai trò này là cửa phân quyền của chủ sở hữu.',
                      OLD.name, OLD.system_key
        USING ERRCODE = 'P0001', HINT = 'SYSTEM_ROLE_IMMUTABLE';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.is_system AND NEW.system_key IS DISTINCT FROM OLD.system_key THEN
    RAISE EXCEPTION 'Không được đổi system_key của vai trò hệ thống "%" (% -> %).',
                    OLD.name, OLD.system_key, NEW.system_key
      USING ERRCODE = 'P0001', HINT = 'SYSTEM_ROLE_IMMUTABLE';
  END IF;

  IF OLD.is_system AND NEW.is_system = false THEN
    RAISE EXCEPTION 'Không được bỏ cờ is_system của vai trò "%" (system_key=%).',
                    OLD.name, OLD.system_key
      USING ERRCODE = 'P0001', HINT = 'SYSTEM_ROLE_IMMUTABLE';
  END IF;

  -- ĐỔI TÊN CŨNG CHẶN — và đây là chỗ bản nháp nói SAI (sửa 30/07 sau rà vòng 2).
  -- Bản nháp cho đổi tên với lý do "cửa phân quyền đã neo vào system_key ở trên
  -- nên đổi tên không còn làm sập quyền nữa". Câu đó KHÔNG ĐÚNG: neo lại chỉ mới
  -- làm cho app_private.is_org_owner_v1. Quét pg_proc trên prod 30/07 vẫn còn
  -- NĂM hàm khác tự so chuỗi tên vai trò, không đi qua helper:
  --     public._termination_ensure_type(uuid,text,text)        ← nằm trên đường TIỀN
  --                                                             (pay_utility_bill gọi)
  --     public.get_ie_auto_approve_threshold_v1()
  --     public.set_ie_auto_approve_threshold_v1(numeric)       ← ngưỡng tự duyệt (D3)
  --     public.set_ie_accounting_standard_v1(uuid,boolean,text)
  --     public.set_membership_status_v1(uuid,text,text)
  -- Đổi nhãn vai trò TENANT_OWNER là ÂM THẦM tước của chính chủ quyền đặt ngưỡng
  -- tự duyệt và quyền đổi trạng thái thành viên. Vì vậy: khoá luôn cái tên cho tới
  -- khi cả năm hàm đó được neo sang system_key (việc của slice sau, KHÔNG làm ở đây
  -- — mỗi hàm là một CREATE OR REPLACE trên hàm tiền/phân quyền đang chạy, phải đọc
  -- pg_get_functiondef từng cái rồi vá, không thuộc phạm vi Slice −1).
  --
  -- MẤT GÌ: chủ không đổi được NHÃN tiếng Việt của 2 vai trò hệ thống. Hôm nay
  -- đường đó vốn đã không tồn tại trong sản phẩm — `authenticated` chỉ có SELECT
  -- trên public.organization_roles, và writer duy nhất
  -- public.upsert_organization_role_v1 đã RAISE 'Vai trò hệ thống "%" không sửa
  -- được' với mọi dòng is_system. Nên trigger này chỉ bịt đường postgres/service_role
  -- (migration hoặc script) — đúng cái đường mà bản nháp để hở.
  IF OLD.is_system AND NEW.name IS DISTINCT FROM OLD.name THEN
    RAISE EXCEPTION 'Không được đổi tên vai trò hệ thống "%" (system_key=%) thành "%". '
                    'Vẫn còn hàm phân quyền so theo TÊN vai trò (vd set_ie_auto_approve_threshold_v1), '
                    'nên đổi nhãn là âm thầm tước quyền của chính chủ tổ chức.',
                    OLD.name, OLD.system_key, NEW.name
      USING ERRCODE = 'P0001', HINT = 'SYSTEM_ROLE_IMMUTABLE';
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION app_private.guard_system_role_identity() IS
  'Slice −1 §−1.10: vai trò is_system không được xoá, không được đổi/bỏ system_key, '
  'và KHÔNG được đổi tên. Chặn cả tên vì ngoài is_org_owner_v1 (đã neo vào system_key) '
  'còn 5 hàm khác vẫn so theo chuỗi ''Chủ sở hữu tổ chức'' — trong đó có '
  'set_ie_auto_approve_threshold_v1 (ngưỡng tự duyệt) và _termination_ensure_type '
  '(đường tiền). Mở lại vế tên CHỈ SAU KHI cả 5 hàm đó neo sang system_key.';

DROP TRIGGER IF EXISTS a00_system_role_identity_guard ON public.organization_roles;
CREATE TRIGGER a00_system_role_identity_guard
  BEFORE UPDATE OR DELETE ON public.organization_roles
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_system_role_identity();

-- ─────────────────────────────────────────────────────────────────────
-- 4ter. CHO GIAO DIỆN HỎI ĐƯỢC "tôi có phải chủ tổ chức không?"
--
-- Cổng p_force của B3 là `is_super_admin() OR is_org_owner_v1(org, uid)`. Giao
-- diện thì đang lấy cờ `canForce` từ `useIsAdmin() || useIsSuperAdmin()`, mà
-- public.is_admin() trên prod hôm nay CHỈ CÒN `SELECT public.is_super_admin()`
-- (đọc bằng pg_get_functiondef 30/07) ⇒ canForce ≡ super admin. Nghĩa là CHỦ TỔ
-- CHỨC THẬT (4 cặp (org,user) có vai trò TENANT_OWNER, trong đó 'DEMO Chủ Nhà'
-- và 'DEMO Quản Lý' không phải super admin) KHÔNG thấy hộp thoại "Đóng thêm" và
-- bị nhắc "phải nhờ chủ tổ chức" — tức nhờ chính mình. Cờ UI phải soi ĐÚNG vị
-- ngữ của server, nên mở một cửa đọc-chỉ cho client.
--
-- KHÔNG nhận tham số org: cờ này chỉ để KHÔNG MỜI người chắc chắn bị từ chối bấm
-- (server vẫn là hàng rào duy nhất, và nó siết theo ĐÚNG org của toà). Trả true
-- nếu người dùng là chủ ở BẤT KỲ org nào họ còn membership hiệu lực — over-grant
-- duy nhất có thể xảy ra là chủ org A bấm trên toà của org B, và khi đó server
-- ném [FIXED_FEE_FORCE_DENIED] bằng tiếng Việt tử tế. Chiều sai còn lại (khoá
-- chủ thật ra ngoài) mới là chiều gây hại, và nó đang xảy ra.
--
-- VOLATILE, KHÔNG khai STABLE: án lệ 20260730280000 (hàm public STABLE chạm khoá
-- dòng ⇒ 25006 qua PostgREST). FE gọi bằng supabase.rpc() ⇒ POST nên không mất
-- đường gọi nào.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_org_owner_self_v1()
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.organization_memberships m
        WHERE m.user_id = auth.uid()
          AND app_private.is_org_owner_v1(m.organization_id, auth.uid())
     );
$fn$;

REVOKE ALL ON FUNCTION public.is_org_owner_self_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_org_owner_self_v1() TO authenticated, service_role;

COMMENT ON FUNCTION public.is_org_owner_self_v1() IS
  'Người đang đăng nhập có vai trò chủ tổ chức (system_key=TENANT_OWNER) ở ít nhất một org? '
  'Chỉ để giao diện KHÔNG mời bấm nút mà server chắc chắn từ chối (vd "Đóng thêm" của '
  'pay_period_fee). Server vẫn siết theo đúng org của toà — cờ này KHÔNG phải hàng rào. '
  'Trước Slice −1 giao diện dùng is_admin(), mà hàm đó nay chỉ còn = is_super_admin() nên '
  'chủ tổ chức thật bị khoá khỏi chính đặc quyền của mình.';

-- ─────────────────────────────────────────────────────────────────────
-- 5. HÀNG RÀO TỰ KIỂM — migration tự đổ nếu chính nó làm sai
-- Doctrine nào đã cắn nhiều lần thì phải có máy tự bắt, không dựa vào trí nhớ.
-- ─────────────────────────────────────────────────────────────────────
DO $selfcheck$
DECLARE
  v_def    text;
  v_sig    text;
  v_vol    text;
  v_secdef boolean;
  v_bad    text;
BEGIN
  -- (a) Mẫu neo của 20260724120000 còn nguyên ⇒ replay migration đó vẫn no-op,
  --     không RAISE 'pattern không khớp'.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.oid = 'public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid)'::regprocedure;
  IF position('(user_id, organization_id, type, name' IN v_def) = 0
     OR position('(auth.uid(), v_org, ''EXPENSE'',' IN v_def) = 0 THEN
    RAISE EXCEPTION
      'pay_utility_bill: MẤT mẫu neo của 20260724120000 — replay migration đó sẽ RAISE. DỪNG.';
  END IF;
  IF position('[UTILITY_BILL_DUPLICATE]' IN v_def) = 0
     OR position('[UTILITY_METER_REQUIRED]' IN v_def) = 0
     OR position('pg_advisory_xact_lock' IN v_def) = 0 THEN
    RAISE EXCEPTION 'pay_utility_bill: thiếu chốt B1/B2 sau khi replace. DỪNG.';
  END IF;
  IF position('INSERT INTO building_utility_accounts' IN v_def) > 0 THEN
    RAISE EXCEPTION 'pay_utility_bill: vẫn còn nhánh tự tạo công tơ. DỪNG.';
  END IF;

  -- (b) pay_period_fee giữ gate server thật + có cổng chủ + sổ vết.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.oid = 'public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)'::regprocedure;
  IF position('public.can_create_restricted_ie()' IN v_def) = 0 THEN
    RAISE EXCEPTION 'pay_period_fee: MẤT gate can_create_restricted_ie (plan §2.1 cấm đụng). DỪNG.';
  END IF;
  IF position('[FIXED_FEE_FORCE_DENIED]' IN v_def) = 0
     OR position('period_fee_force_events' IN v_def) = 0 THEN
    RAISE EXCEPTION 'pay_period_fee: thiếu cổng chủ hoặc sổ vết cho p_force. DỪNG.';
  END IF;
  IF position('''warning'', ''duplicate''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'pay_period_fee: mất hình dạng jsonb cảnh báo trùng mà UI đang đọc. DỪNG.';
  END IF;
  -- Payload trùng phải mang can_force, kẻo giao diện lại tự đoán đặc quyền "Đóng
  -- thêm" bằng is_admin() (= is_super_admin()) và khoá CHỦ TỔ CHỨC THẬT ra ngoài.
  IF position('''can_force''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'pay_period_fee: payload cảnh báo trùng thiếu can_force — UI sẽ tự đoán quyền "Đóng thêm". DỪNG.';
  END IF;
  -- Phép đo trùng phải nằm SAU một khoá slot, kẻo hai cú bấm song song đều đọc
  -- "chưa có" rồi đều ghi (đúng khe đã sinh cặp phiếu cách nhau 460ms).
  IF position('pg_advisory_xact_lock' IN v_def) = 0 THEN
    RAISE EXCEPTION 'pay_period_fee: thiếu khoá slot pg_advisory_xact_lock trước phép đo trùng. DỪNG.';
  END IF;

  -- (c) Cả hai writer phải còn VOLATILE + SECURITY DEFINER.
  FOR v_sig, v_vol, v_secdef IN
    SELECT p.oid::regprocedure::text, p.provolatile::text, p.prosecdef
      FROM pg_proc p
     WHERE p.oid IN (
       'public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid)'::regprocedure,
       'public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)'::regprocedure)
  LOOP
    IF v_vol <> 'v' THEN
      RAISE EXCEPTION '% không còn VOLATILE — sẽ ném 25006 qua PostgREST. DỪNG.', v_sig;
    END IF;
    IF NOT v_secdef THEN
      RAISE EXCEPTION '% mất SECURITY DEFINER. DỪNG.', v_sig;
    END IF;
  END LOOP;

  -- (d) Guard thanh lý: phải là SECURITY INVOKER, và trigger phải chạy đầu tiên.
  SELECT p.prosecdef INTO v_secdef
    FROM pg_proc p WHERE p.oid = 'public.guard_contract_termination_settlement()'::regprocedure;
  IF v_secdef THEN
    RAISE EXCEPTION
      'guard_contract_termination_settlement là SECURITY DEFINER — current_user sẽ luôn là postgres và guard không chặn được ai. DỪNG.';
  END IF;
  -- (d2) …và vì nó SECURITY INVOKER, nó KHÔNG được chạm thẳng schema app_private:
  --      role authenticated không có USAGE ⇒ 42501 ngay lúc khởi động câu lệnh,
  --      chết mọi INSERT/UPDATE REST trước khi tới được mã lỗi tiếng Việt. Phải
  --      đi qua public.has_contract_termination_write_v1 (SECURITY DEFINER).
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.oid = 'public.guard_contract_termination_settlement()'::regprocedure;
  IF position('app_private.' IN v_def) > 0 THEN
    RAISE EXCEPTION
      'guard_contract_termination_settlement chạm thẳng app_private trong thân hàm SECURITY INVOKER — authenticated không có USAGE trên schema đó nên mọi ghi qua REST sẽ đổ 42501. Dùng public.has_contract_termination_write_v1. DỪNG.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.has_contract_termination_write_v1(uuid)'::regprocedure
       AND p.prosecdef
       AND p.provolatile = 'v'
  ) THEN
    RAISE EXCEPTION
      'public.has_contract_termination_write_v1(uuid) phải tồn tại, SECURITY DEFINER và VOLATILE. DỪNG.';
  END IF;
  IF NOT has_function_privilege('authenticated',
        'public.has_contract_termination_write_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION
      'authenticated không EXECUTE được has_contract_termination_write_v1 — guard sẽ đổ 42501. DỪNG.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.contract_terminations'::regclass
       AND t.tgname = 'a00_contract_termination_settlement_guard'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Thiếu trigger a00_contract_termination_settlement_guard. DỪNG.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.contract_terminations'::regclass
       AND NOT t.tgisinternal
       AND (t.tgtype & 2) <> 0                       -- bit BEFORE
       AND t.tgname < 'a00_contract_termination_settlement_guard'
  ) THEN
    RAISE EXCEPTION
      'Có trigger BEFORE khác chạy TRƯỚC guard thanh lý — guard sẽ không thấy ý định gốc của client. DỪNG.';
  END IF;

  -- (e) KHÔNG được có unique index nào lên dữ liệu tiền lịch sử (chủ đã cấm
  --     đụng 2 slot điện + 24 slot phí cố định đang vi phạm).
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename IN ('income_expenses', 'income_expense_items')
       AND indexdef ILIKE '%UNIQUE%'
       AND (indexdef ILIKE '%utility_account_id%' OR indexdef ILIKE '%system_source%')
  ) THEN
    RAISE EXCEPTION
      'Có unique index chống trùng trên dữ liệu tiền lịch sử — chủ đã cấm đụng. DỪNG.';
  END IF;

  -- (f) Cửa đọc "tôi có phải chủ tổ chức không?" phải gọi được từ authenticated,
  --     nếu không giao diện lại rơi về is_admin() (= is_super_admin()) và KHOÁ
  --     chủ tổ chức thật khỏi nút "Đóng thêm" — đúng lỗi 4ter vừa vá.
  IF NOT has_function_privilege('authenticated', 'public.is_org_owner_self_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated không EXECUTE được is_org_owner_self_v1 — cờ canForce của UI sẽ sai. DỪNG.';
  END IF;
  IF has_function_privilege('anon', 'public.is_org_owner_self_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'is_org_owner_self_v1 đang anon-executable — REVOKE anon. DỪNG.';
  END IF;

  -- (g) MÌN "CHỦ SỞ HỮU THEO TÊN VAI TRÒ" (§−1.10). Hai vế:
  --   (g1) Trigger phải CHẶN đổi tên vai trò is_system. Chừng nào còn hàm so theo
  --        chuỗi tên thì cho đổi tên là để ngỏ đường âm thầm tước quyền của chủ.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.oid = 'app_private.guard_system_role_identity()'::regprocedure;
  IF position('NEW.name IS DISTINCT FROM OLD.name' IN v_def) = 0 THEN
    RAISE EXCEPTION
      'guard_system_role_identity KHÔNG chặn đổi tên vai trò hệ thống, mà vẫn còn hàm phân quyền so theo chuỗi ''Chủ sở hữu tổ chức'' (set_ie_auto_approve_threshold_v1, _termination_ensure_type…). Đổi nhãn = tước quyền chủ. DỪNG.';
  END IF;
  --   (g2) Danh sách hàm còn so theo TÊN phải KHÔNG DÀI RA. Sáu hàm dưới đây là
  --        hiện trạng đo trên prod 30/07 (đã ghi trong 4bis); ai thêm hàm thứ bảy
  --        phải neo vào system_key thay vì chép lại chuỗi tên — hoặc bổ sung tên
  --        vào danh sách này KÈM lý do.
  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY 1) INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'app_private')
     AND p.prokind = 'f'
     AND p.prosrc LIKE '%Chủ sở hữu tổ chức%'
     AND (n.nspname || '.' || p.proname) NOT IN (
       'app_private.is_org_owner_v1',                  -- vế fallback có chủ ý (4bis)
       'public._termination_ensure_type',
       'public.get_ie_auto_approve_threshold_v1',
       'public.set_ie_auto_approve_threshold_v1',
       'public.set_ie_accounting_standard_v1',
       'public.set_membership_status_v1'
     );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'Có hàm MỚI gating theo chuỗi tên vai trò ''Chủ sở hữu tổ chức'': %. Dùng app_private.is_org_owner_v1 (đã neo system_key=TENANT_OWNER) thay vì chép chuỗi tên. DỪNG.',
      v_bad;
  END IF;

  RAISE NOTICE 'Slice −1 WS-B: hàng rào tự kiểm xanh (7 mục)';
END
$selfcheck$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- SAU KHI APPLY: `npm run gen:types` (hai hàm mới ở đây —
-- public.is_org_owner_self_v1, public.has_contract_termination_write_v1 — chưa có
-- trong src/integrations/supabase/types.ts, và tsc KHÔNG thấy vì mọi chỗ gọi đi
-- qua `(supabase as any).rpc`). Xem khối hướng dẫn cuối
-- 20260731010000_slice_minus1_readers.sql, kèm cảnh báo drift network_* của CLAUDE.md.
