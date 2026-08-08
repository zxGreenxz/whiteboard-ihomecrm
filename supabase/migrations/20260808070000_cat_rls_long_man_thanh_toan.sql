-- =============================================================================
-- Cắt RLS-lồng-RLS trên hai bảng thanh toán: 14,8 giây → 0,36 giây
--
-- TRIỆU CHỨNG: invoice_payment_allocations chỉ có 292 dòng mà mất 14–22 giây;
-- invoice_payment_collections 274 dòng mất 10–11 giây. Cùng họ với đống cảnh báo
-- `[perf] CHẬM …` trong console.
--
-- KHÔNG PHẢI DO BIÊN GIỚI TỔ CHỨC. Đo trước đây: gỡ policy biên giới ra vẫn
-- 17,07s so với 18,08s khi có (chênh 5%). Ghi lại để không ai đổ tội nhầm cho
-- đợt rào biên giới.
--
-- NGUYÊN NHÂN THẬT: policy SELECT của cả hai bảng là một EXISTS sang bảng KHÁC
-- mà bảng đó cũng có RLS đắt của riêng nó:
--
--   invoice_payment_allocations_select
--     EXISTS (SELECT 1 FROM invoice_payment_collections JOIN invoices …
--             WHERE … AND can_access_building(invoice_row.building_id))
--
-- Chạy CHO TỪNG DÒNG. Mỗi lần chạy, bản thân subquery lại phải lọc
-- invoice_payment_collections và invoices theo policy của CHÚNG — trong đó có
-- can_access_building → can_v3. Chi phí nhân lên theo tầng.
--
-- CÁCH CHỮA — có tiền lệ sẵn trong dự án: building_of_invoice /
-- building_of_contract / building_of_payment là hàm SECURITY DEFINER dùng bên
-- trong policy để cắt RLS lồng. Hai bảng thanh toán chưa được chuyển sang.
--
-- ================================ ĐO ĐƯỢC ====================================
-- Thử nghiệm trên chính production trong BEGIN…ROLLBACK, 7 vai người dùng thật
-- (suy từ organization_memberships, không hard-code), đo HAI mệnh đề cùng lúc:
-- số dòng nhìn thấy VÀ thời gian. Chỉ đo thời gian là chưa đủ — khoá sạch mọi
-- người cũng cho ra 0 giây.
--
--   Vai                | hiện tại (col/alo ms) | PA1 hàm  | PA2 tập hợp (chọn)
--   bosshuy   (thật)   | 11.648 / 14.821       | 4.070/3.485 |   434 /  355
--   nathan    (thật)   | 10.743 / 11.628       | 4.124/4.055 |   553 /  194
--   joey      (thật)   |  6.777 /  6.831       | 3.380/3.976 |   489 /  357
--   super admin        |    311 /    775       |   129/   86 |    39 /   42
--   test.nathan (cccc) | 11.095 /  9.886       |   345/  350 |   800 /  537
--   demo.chunha (dddd) |    547 /    386       |    40/   79 |   464 /  402
--   demo.ketoan (dddd) |    968 /    903       |    64/  132 |   369 /  464
--
-- SỐ DÒNG NHÌN THẤY GIỐNG HỆT NHAU Ở CẢ 14 PHÉP SO (7 vai × 2 bảng).
--
-- Vì sao chọn PA2 (so với tập toà nhà) chứ không PA1 (gọi hàm mỗi dòng): PA1
-- nhanh hơn ở hai vai ÍT DÒNG, nhưng PA2 mới cứu đúng người kêu — vai có nhiều
-- dòng đi từ 14,8s xuống 0,36s. PA2 có sàn cố định ~400ms vì luôn duyệt 51 toà
-- nhà, nhưng kể cả sàn đó thì PA2 VẪN KHÔNG chậm hơn hiện tại với bất kỳ vai
-- nào. Đổi lấy trường hợp xấu nhất từ 14,8s còn 0,55s.
--
-- ============================ HAI CÁI BẪY ĐÃ SẬP =============================
--
-- BẪY 1 — quyền EXECUTE trong policy kiểm theo NGƯỜI GỌI, không theo chủ bảng.
-- Bản đầu đặt hàm ở public rồi REVOKE EXECUTE … FROM PUBLIC, anon, authenticated
-- theo đúng khuyến nghị của finding F3. Policy chết ngay: 42501 permission denied
-- for function. Đặt ở app_private thì chạy — vì hàm giữ EXECUTE mặc định cho
-- PUBLIC, còn đường gọi THẲNG bị chặn bởi thiếu USAGE trên schema (đã kiểm:
-- has_schema_privilege('authenticated','app_private','USAGE') = false, và prod
-- đang có 86 policy khác gọi app_private.* theo đúng lối này). Đó mới là cơ chế
-- thật. Vì vậy file này KHÔNG revoke gì trên ba hàm mới — revoke là làm vỡ.
--
-- BẪY 2 — cắt RLS lồng làm NỚI QUYỀN nếu làm thẳng tay.
-- Đo được: sau khi bỏ EXISTS, super admin thấy THÊM đúng 3 collections và 5
-- allocations. Truy ra: sandbox_org_ids() chỉ chứa cccc (Test); org Demo dddd
-- được giấu bằng một cơ chế KHÁC — invoices_hide_demo_admin lọc theo NGƯỜI DÙNG
-- (user_id ∈ demo_user_ids()) — và policy đó chỉ tồn tại trên invoices. Hôm nay
-- hai bảng thanh toán được che nhờ RLS LỒNG chứ không nhờ policy của chính
-- chúng. Bỏ lồng là bỏ luôn tấm che.
-- Vì vậy file này dựng lại tấm che đó THÀNH POLICY TƯỜNG MINH trên chính hai
-- bảng (…_hide_demo_admin), đúng tên và đúng hình dạng RESTRICTIVE như bản trên
-- invoices. Sau khi thêm, super admin về đúng 251/262 như cũ.
-- Đây là cải thiện chứ không chỉ là bù: che tường minh trên bảng của mình thì
-- không thể bị mất khi ai đó sửa policy của bảng cha.
--
-- Ba thứ KHÔNG cần dựng lại vì đã có sẵn trên chính hai bảng thanh toán:
-- org_boundary (đã có, RESTRICTIVE FOR ALL) và hide_sandbox_admin (đã có).
-- Đã kiểm dữ liệu để chắc chúng phủ đúng: 0 dòng collections lệch
-- organization_id với invoice cha, 0 dòng allocations lệch với collection cha,
-- 0 dòng mồ côi hai chiều, 0 dòng organization_id NULL trên cả hai bảng.
-- =============================================================================

BEGIN;

DO $preflight$
DECLARE
  v_n bigint;
BEGIN
  -- Nếu ai đó đã cấp USAGE app_private cho client role thì ba hàm dưới thành
  -- gọi thẳng được, và building_of_* trở thành đường dò building_id của người
  -- khác. Chốt này canh đúng giả định mà cả thiết kế đứng lên.
  IF has_schema_privilege('authenticated', 'app_private', 'USAGE')
     OR has_schema_privilege('anon', 'app_private', 'USAGE') THEN
    RAISE EXCEPTION 'client role đã có USAGE trên app_private — hàm helper sẽ gọi thẳng được. DỪNG.';
  END IF;

  -- Thiết kế dựa vào việc org của dòng con luôn khớp org của cha. Nếu lệch thì
  -- org_boundary của bảng con KHÔNG phủ được thứ mà RLS lồng đang phủ.
  SELECT count(*) INTO v_n
    FROM public.invoice_payment_collections c
    JOIN public.invoices i ON i.id = c.invoice_id
   WHERE c.organization_id IS DISTINCT FROM i.organization_id;
  IF v_n > 0 THEN
    RAISE EXCEPTION '% dòng invoice_payment_collections lệch organization_id với hoá đơn cha — org_boundary của bảng con không thay được RLS lồng. DỪNG.', v_n;
  END IF;

  SELECT count(*) INTO v_n
    FROM public.invoice_payment_allocations a
    JOIN public.invoice_payment_collections c ON c.id = a.collection_id
   WHERE a.organization_id IS DISTINCT FROM c.organization_id;
  IF v_n > 0 THEN
    RAISE EXCEPTION '% dòng invoice_payment_allocations lệch organization_id với phiếu thu cha. DỪNG.', v_n;
  END IF;

  -- Hàm nền phải còn nguyên hình dạng đã đo.
  IF to_regprocedure('public.can_access_building(uuid)') IS NULL
     OR to_regprocedure('public.building_of_invoice(uuid)') IS NULL
     OR to_regprocedure('public.demo_user_ids()') IS NULL THEN
    RAISE EXCEPTION 'Thiếu một trong các hàm nền can_access_building / building_of_invoice / demo_user_ids. DỪNG.';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------
-- Ba hàm cắt lồng. Đặt ở app_private — xem BẪY 1. KHÔNG revoke.
-- ---------------------------------------------------------------------------

COMMENT ON SCHEMA app_private IS 'Hàm nội bộ dùng trong policy RLS. Client role KHÔNG có USAGE — đó là lớp chặn gọi thẳng.';

CREATE OR REPLACE FUNCTION app_private.invoice_of_payment_collection(_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $f$
  SELECT c.invoice_id FROM public.invoice_payment_collections c WHERE c.id = _id;
$f$;

COMMENT ON FUNCTION app_private.invoice_of_payment_collection(uuid) IS
  'Hoá đơn của một phiếu thu, bỏ qua RLS. Dùng TRONG policy để không lồng RLS.';

CREATE OR REPLACE FUNCTION app_private.user_of_invoice(_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $f$
  SELECT i.user_id FROM public.invoices i WHERE i.id = _id;
$f$;

COMMENT ON FUNCTION app_private.user_of_invoice(uuid) IS
  'Người tạo hoá đơn, bỏ qua RLS. Dùng để dựng lại tấm che demo_user_ids trên bảng con.';

-- Đây là thứ đổi độ phức tạp từ O(số dòng) sang O(số toà nhà): tập toà nhà được
-- tính MỘT LẦN như InitPlan rồi tra bằng hash, thay vì gọi can_access_building
-- cho từng dòng. Cùng lối mà invoices_select_rbac đã dùng với
-- accessible_building_ids().
CREATE OR REPLACE FUNCTION app_private.buildings_i_can_see()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $f$
  SELECT b.id FROM public.buildings b WHERE public.can_access_building(b.id);
$f$;

COMMENT ON FUNCTION app_private.buildings_i_can_see() IS
  'Tập toà nhà mà người đang gọi được xem, tính một lần. Định nghĩa bằng CHÍNH can_access_building nên không thể lệch nghĩa với nó.';

-- ---------------------------------------------------------------------------
-- Hai policy SELECT: bỏ EXISTS lồng, tra tập toà nhà.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS invoice_payment_collections_select ON public.invoice_payment_collections;
CREATE POLICY invoice_payment_collections_select
  ON public.invoice_payment_collections
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (public.building_of_invoice(invoice_id) IN (SELECT app_private.buildings_i_can_see()));

DROP POLICY IF EXISTS invoice_payment_allocations_select ON public.invoice_payment_allocations;
CREATE POLICY invoice_payment_allocations_select
  ON public.invoice_payment_allocations
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (public.building_of_invoice(app_private.invoice_of_payment_collection(collection_id))
         IN (SELECT app_private.buildings_i_can_see()));

-- ---------------------------------------------------------------------------
-- Dựng lại tấm che demo THÀNH POLICY TƯỜNG MINH — xem BẪY 2.
-- Hình dạng chép đúng invoices_hide_demo_admin.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS invoice_payment_collections_hide_demo_admin ON public.invoice_payment_collections;
CREATE POLICY invoice_payment_collections_hide_demo_admin
  ON public.invoice_payment_collections
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT ((SELECT public.is_super_admin() OR public.is_admin())
              AND app_private.user_of_invoice(invoice_id) = ANY (public.demo_user_ids())));

DROP POLICY IF EXISTS invoice_payment_allocations_hide_demo_admin ON public.invoice_payment_allocations;
CREATE POLICY invoice_payment_allocations_hide_demo_admin
  ON public.invoice_payment_allocations
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT ((SELECT public.is_super_admin() OR public.is_admin())
              AND app_private.user_of_invoice(
                    app_private.invoice_of_payment_collection(collection_id))
                  = ANY (public.demo_user_ids())));

-- ---------------------------------------------------------------------------
-- Nghiệm thu: kiểm HÌNH DẠNG policy, không kiểm số dòng dữ liệu.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  b     text;
  v_n   bigint;
  v_qual text;
BEGIN
  FOREACH b IN ARRAY ARRAY['invoice_payment_collections','invoice_payment_allocations'] LOOP
    -- policy SELECT phải là PERMISSIVE và KHÔNG còn đọc bảng khác trong thân.
    SELECT pg_get_expr(p.polqual, p.polrelid) INTO v_qual
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname = b AND p.polname = b || '_select';
    IF v_qual IS NULL THEN
      RAISE EXCEPTION 'Mất policy %_select. DỪNG.', b;
    END IF;
    IF v_qual ~* '\minvoices\M' OR v_qual ~* '\minvoice_payment_collections\M' THEN
      RAISE EXCEPTION 'Policy %_select vẫn đọc thẳng bảng khác trong thân — RLS lồng chưa bị cắt: %', b, v_qual;
    END IF;

    -- tấm che demo phải tồn tại và phải là RESTRICTIVE (PERMISSIVE là nới quyền).
    SELECT count(*) INTO v_n
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname = b AND p.polname = b || '_hide_demo_admin'
       AND p.polpermissive = false AND p.polcmd = 'r';
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'Thiếu policy %_hide_demo_admin dạng RESTRICTIVE FOR SELECT. DỪNG.', b;
    END IF;

    -- biên giới tổ chức phải còn nguyên: file này không được vô tình dọn nó.
    SELECT count(*) INTO v_n
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname = b AND p.polname = b || '_org_boundary'
       AND p.polpermissive = false AND p.polcmd = '*';
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'Biên giới tổ chức của % không còn nguyên. DỪNG.', b;
    END IF;
  END LOOP;

  -- Lớp chặn gọi thẳng phải còn.
  IF has_schema_privilege('authenticated', 'app_private', 'USAGE') THEN
    RAISE EXCEPTION 'authenticated có USAGE trên app_private sau khi chạy. DỪNG.';
  END IF;

  RAISE NOTICE 'Đã cắt RLS lồng trên hai bảng thanh toán, tấm che demo đã thành policy tường minh, biên giới tổ chức nguyên vẹn.';
END
$verify$;

COMMIT;

-- =============================================================================
-- ROLLBACK: file này chỉ đổi POLICY và thêm HÀM, không đụng dữ liệu.
-- Muốn lùi thì viết một migration forward mới dựng lại hai policy cũ:
--
--   CREATE POLICY invoice_payment_collections_select ON public.invoice_payment_collections
--     AS PERMISSIVE FOR SELECT TO authenticated
--     USING (EXISTS (SELECT 1 FROM invoices invoice_row
--                     WHERE invoice_row.id = invoice_payment_collections.invoice_id
--                       AND can_access_building(invoice_row.building_id)));
--
--   CREATE POLICY invoice_payment_allocations_select ON public.invoice_payment_allocations
--     AS PERMISSIVE FOR SELECT TO authenticated
--     USING (EXISTS (SELECT 1 FROM invoice_payment_collections collection_row
--                      JOIN invoices invoice_row ON invoice_row.id = collection_row.invoice_id
--                     WHERE collection_row.id = invoice_payment_allocations.collection_id
--                       AND can_access_building(invoice_row.building_id)));
--
-- Lùi thì NHỚ xoá hai policy _hide_demo_admin cùng lúc, kẻo che hai lần.
-- =============================================================================
