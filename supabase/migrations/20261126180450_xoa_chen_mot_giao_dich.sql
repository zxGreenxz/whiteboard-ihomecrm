-- Đợt 10b (plan sửa khoá vĩnh viễn sau rớt mạng): gộp «xoá rồi chèn lại» vào MỘT giao dịch trên máy chủ.
--
-- VÌ SAO
--   Năm nơi trình duyệt đang ghi thẳng bảng bằng NHIỀU lệnh: xoá mọi dòng cũ, rồi chèn bộ dòng mới (và với ba nơi còn sửa
--   đầu phiếu trước đó). Rớt mạng / máy chủ từ chối giữa hai lệnh thì bộ dòng cũ đã mất mà bộ mới chưa có: toà thiếu dịch
--   vụ mặc định, định mức thiếu bậc, phiếu nhập / phiếu xuất tạm không có dòng nào và TỒN KHO bị tính lại theo trạng thái
--   «chưa có dòng» đó (trigger tính lại từ mọi dòng đang có) cho tới khi người dùng bấm lưu lại. Hai lần bấm chồng nhau
--   (hai tab) còn có thể nhân đôi dòng vật tư (bảng dòng vật tư không có khoá duy nhất).
--
-- NỘI DUNG — năm HÀM MỚI, không thay hàm nào đang chạy, không đổi bảng, không đổi RLS:
--   1. public.replace_building_services_v1(p_building_id, p_services)            dịch vụ mặc định của toà
--   2. public.replace_service_quota_v1(p_quota_id, p_name, p_description, p_tiers) tên/mô tả + bậc của định mức
--   3. public.replace_material_purchase_v1(p_purchase_id, p_purchase_date, p_supplier_id, p_notes, p_items)
--                                                                                đầu phiếu nhập + dòng phiếu nhập
--   4. public.save_job_material_usage_v1(p_job_id, p_usage_date, p_notes, p_items) phiếu xuất vật tư của công việc
--   5. public.replace_contract_services_v1(p_contract_id, p_services)            dịch vụ của hợp đồng khi SỬA hợp đồng
--   Mỗi hàm nhận BỘ ĐÍCH ĐẦY ĐỦ (giá trị tuyệt đối) và trong một giao dịch: khoá → (sửa đầu phiếu) → xoá mọi dòng cũ →
--   kiểm không còn dòng cũ nào → chèn bộ mới → trả về đúng bộ dòng đã ghi (mã + các trường để trình duyệt so biên nhận).
--   Lỗi ở bất kỳ bước nào (một dòng vi phạm ràng buộc, RLS từ chối, mất kết nối trước COMMIT) ⇒ cả giao dịch lùi, dòng cũ
--   còn nguyên. Chạy lại cùng bộ cho cùng kết quả (mã dòng mới, nội dung y hệt).
--
-- QUYỀN — Y NHƯ GHI THẲNG BẢNG HÔM NAY
--   Cả năm hàm là SECURITY INVOKER: mọi câu lệnh chạy bằng quyền của người gọi (vai authenticated), nên RLS của từng bảng
--   (select/insert/delete/update theo quyền toà, quyền công ty, ranh giới công ty, ẩn demo/sandbox) và mọi trigger của bảng
--   áp NGUYÊN như khi trình duyệt ghi thẳng. Hàm không tự kiểm quyền, không đọc bảng nào bằng quyền chủ hàm; nó chỉ gom các
--   lệnh vốn có vào một giao dịch, cộng hai phép kiểm chỉ làm hàm từ chối SỚM hơn (không bao giờ cho phép thêm):
--     - khoá dòng cha FOR UPDATE ở ba nơi mà luồng hôm nay vốn đã UPDATE dòng cha (định mức, phiếu nhập, phiếu xuất của
--       công việc): FOR UPDATE đòi đúng các chính sách SELECT + UPDATE mà lệnh UPDATE đó đòi (cùng quyền, không thêm);
--     - với toà và hợp đồng, luồng hôm nay KHÔNG sửa dòng cha (chỉ xoá/chèn dòng con, quyền services.* / contracts.delete +
--       contracts.create), nên KHÔNG khoá FOR UPDATE dòng cha (sẽ đòi thêm quyền buildings.edit / contracts.edit) mà khoá tư
--       vấn pg_advisory_xact_lock theo mã cha — không cần quyền gì, chỉ xếp hàng hai lệnh cùng cha;
--     - sau lệnh xoá, còn dòng cũ nào NHÌN THẤY được (RLS cho xem mà không cho xoá) ⇒ 42501, lùi cả giao dịch. Ghi thẳng
--       hôm nay khi đó âm thầm xoá 0 dòng rồi chèn thêm (trùng khoá ⇒ 23505, không trùng ⇒ bộ lẫn cũ + mới); nay từ chối rõ.
--   organization_id của dòng con KHÔNG truyền: trigger autofill_org_strict suy từ dòng cha như mọi lần chèn không khai công
--   ty (trước đây trình duyệt khai bằng công ty của dòng cha — hợp đồng, định mức, phiếu nhập — hoặc công ty đang chọn ở
--   dịch vụ toà; công ty của dòng cha là đúng).
--
-- TRIGGER — cho cùng kết quả cuối
--   Tồn kho, giá vốn bình quân (material_items_after_change → recompute_material_stock) và tổng phiếu nhập
--   (material_purchase_recompute_total) đều TÍNH LẠI tuyệt đối từ mọi dòng đang có, mỗi dòng xoá/chèn một lần như ghi
--   thẳng; trạng thái cuối giống hệt cách cũ, chỉ khác là người khác không còn thấy trạng thái «chưa có dòng» ở giữa.
--   autofill_org_strict, khoa_organization_id_v1, set_user_id_from_auth, set_material_usage_code, update_updated_at_column
--   chạy như khi ghi thẳng (cùng câu lệnh, cùng vai).
--
-- TƯƠNG THÍCH NGƯỢC: chỉ thêm hàm. Bundle trình duyệt cũ, Hermes (chỉ đọc các bảng này) vẫn ghi/đọc thẳng như trước vì RLS
--   không đổi. Phần không lùi được: không có (restore từ bản dump của lane bỏ năm hàm).
--
-- AN TOÀN CHẠY LẠI: $requires$ chỉ đọc catalog; năm hàm là CREATE OR REPLACE cùng chữ ký; REVOKE/GRANT lặp lại vô hại.

DO $requires$
DECLARE
  r record;
  v_md5 text;
BEGIN
  IF to_regprocedure('auth.uid()') IS NULL
     OR to_regclass('public.buildings') IS NULL OR to_regclass('public.building_services') IS NULL
     OR to_regclass('public.service_quotas') IS NULL OR to_regclass('public.service_quota_tiers') IS NULL
     OR to_regclass('public.material_purchases') IS NULL OR to_regclass('public.material_purchase_items') IS NULL
     OR to_regclass('public.material_usages') IS NULL OR to_regclass('public.material_usage_items') IS NULL
     OR to_regclass('public.contracts') IS NULL OR to_regclass('public.contract_services') IS NULL
     OR to_regclass('public.materials') IS NULL OR to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION 'xoa_chen_mot_giao_dich: thiếu nền (bảng hoặc auth.uid())' USING ERRCODE = '55000';
  END IF;

  -- Khoá duy nhất mà các hàm dựa vào (một dịch vụ mỗi toà / hợp đồng, một bậc mỗi số, một phiếu xuất mỗi công việc).
  IF to_regclass('public.building_services_unique') IS NULL
     OR to_regclass('public.service_quota_tiers_quota_id_tier_number_key') IS NULL
     OR to_regclass('public.uq_material_usages_job') IS NULL
     OR to_regclass('public.contract_services_contract_id_service_id_key') IS NULL THEN
    RAISE EXCEPTION 'xoa_chen_mot_giao_dich: thiếu khoá duy nhất đã rà' USING ERRCODE = '55000';
  END IF;

  -- RLS phải đang bật: hàm INVOKER dựa hoàn toàn vào RLS của bảng.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.building_services'::regclass, 'public.service_quotas'::regclass,
                              'public.service_quota_tiers'::regclass, 'public.material_purchases'::regclass,
                              'public.material_purchase_items'::regclass, 'public.material_usages'::regclass,
                              'public.material_usage_items'::regclass, 'public.contract_services'::regclass)
                AND NOT c.relrowsecurity) THEN
    RAISE EXCEPTION 'xoa_chen_mot_giao_dich: RLS không bật trên một bảng đã rà — DỪNG' USING ERRCODE = '55000';
  END IF;

  -- Trigger được dựa vào (không bị thay) — thân đổi thì dừng để rà lại «cùng kết quả cuối».
  FOR r IN SELECT * FROM (VALUES
      ('public.recompute_material_stock(uuid)',       '2867345151e0ee5384270b00a993ab62'),
      ('public.material_items_after_change()',        '0cd22f9ed883f00103ec1feb04e89e7c'),
      ('public.material_purchase_recompute_total()',  '352642eef4822cc2d9d1c274554c7dea'),
      ('app_private.autofill_org_strict()',           'ffc89eb36fa19d996d27f1d10e3adc15'),
      ('app_private.khoa_organization_id_v1()',       '1917417dd3d6ae8b5c38decc0c1b515f')
    ) AS v(fn, base_md5) LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.fn);
    IF v_md5 IS DISTINCT FROM r.base_md5 THEN
      RAISE EXCEPTION '% KHÁC thân đã rà (md5 %) — DỪNG, đối chiếu thân đang chạy', r.fn, v_md5 USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- Trigger phải đang gắn và đang bật trên đúng bảng.
  FOR r IN SELECT * FROM (VALUES
      ('public.material_purchase_items', 'trg_mpi_recompute',       'public.material_items_after_change()'),
      ('public.material_purchase_items', 'trg_mpi_total',           'public.material_purchase_recompute_total()'),
      ('public.material_usage_items',    'trg_mui_recompute',       'public.material_items_after_change()'),
      ('public.building_services',       'trg_autofill_org',        'app_private.autofill_org_strict()'),
      ('public.service_quota_tiers',     'trg_autofill_org_strict', 'app_private.autofill_org_strict()'),
      ('public.material_purchase_items', 'trg_autofill_org_strict', 'app_private.autofill_org_strict()'),
      ('public.material_usages',         'trg_autofill_org_strict', 'app_private.autofill_org_strict()'),
      ('public.material_usage_items',    'trg_autofill_org_strict', 'app_private.autofill_org_strict()'),
      ('public.contract_services',       'trg_autofill_org',        'app_private.autofill_org_strict()')
    ) AS v(tbl, tg, fn) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                    WHERE t.tgrelid = r.tbl::regclass AND t.tgname = r.tg
                      AND t.tgfoid = to_regprocedure(r.fn) AND t.tgenabled <> 'D') THEN
      RAISE EXCEPTION 'xoa_chen_mot_giao_dich: trigger % trên % không còn như đã rà — DỪNG', r.tg, r.tbl USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$requires$;

-- ── 1. Dịch vụ mặc định của toà ──────────────────────────────────────────────────────────────────────────────────────────
-- Bộ đích: [{service_id, is_active, unit_price_override}] (mảng rỗng = toà không còn dịch vụ mặc định nào).
CREATE OR REPLACE FUNCTION public.replace_building_services_v1(p_building_id uuid, p_services jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY INVOKER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_rows jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_building_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu mã toà' USING ERRCODE = '22023';
  END IF;
  IF p_services IS NULL OR jsonb_typeof(p_services) <> 'array' OR jsonb_array_length(p_services) > 500 THEN
    RAISE EXCEPTION 'Danh sách dịch vụ phải là mảng (tối đa 500 dịch vụ)' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_services) e
              WHERE jsonb_typeof(e) <> 'object'
                 OR jsonb_typeof(e -> 'service_id') IS DISTINCT FROM 'string'
                 OR jsonb_typeof(e -> 'is_active') IS DISTINCT FROM 'boolean'
                 OR coalesce(jsonb_typeof(e -> 'unit_price_override'), 'null') NOT IN ('number', 'null')) THEN
    RAISE EXCEPTION 'Mỗi dịch vụ cần service_id (chuỗi), is_active (đúng/sai), unit_price_override (số hoặc null)' USING ERRCODE = '22023';
  END IF;

  -- Luồng hôm nay không sửa dòng toà nên không khoá FOR UPDATE dòng đó (sẽ đòi thêm quyền sửa toà): khoá tư vấn theo toà,
  -- hai lệnh cùng toà chạy lần lượt; lệnh sau xoá đúng bộ lệnh trước vừa ghi.
  PERFORM pg_advisory_xact_lock(hashtextextended('replace_building_services_v1:' || p_building_id::text, 0));

  DELETE FROM public.building_services WHERE building_id = p_building_id;
  IF EXISTS (SELECT 1 FROM public.building_services WHERE building_id = p_building_id) THEN
    RAISE EXCEPTION 'Chưa gỡ được dịch vụ cũ của toà: tài khoản chưa có quyền gỡ dịch vụ này. Chưa lưu thay đổi nào.' USING ERRCODE = '42501';
  END IF;

  WITH ins AS (
    INSERT INTO public.building_services (building_id, service_id, is_active, unit_price_override)
    SELECT p_building_id, (t.e ->> 'service_id')::uuid, (t.e ->> 'is_active')::boolean, (t.e ->> 'unit_price_override')::numeric
      FROM jsonb_array_elements(p_services) WITH ORDINALITY AS t(e, n)
     ORDER BY t.n
    RETURNING id, building_id, service_id, is_active, unit_price_override
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', ins.id, 'building_id', ins.building_id, 'service_id', ins.service_id,
                                               'is_active', ins.is_active, 'unit_price_override', ins.unit_price_override)
                            ORDER BY ins.service_id), '[]'::jsonb)
    INTO v_rows FROM ins;
  RETURN v_rows;
END;
$function$;

-- ── 2. Định mức: tên, mô tả và toàn bộ bậc ───────────────────────────────────────────────────────────────────────────────
-- Bộ đích: [{tier_number, from_value, to_value, unit_price}].
CREATE OR REPLACE FUNCTION public.replace_service_quota_v1(p_quota_id uuid, p_name text, p_description text, p_tiers jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY INVOKER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_quota jsonb;
  v_tiers jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_quota_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu mã định mức' USING ERRCODE = '22023';
  END IF;
  IF p_tiers IS NULL OR jsonb_typeof(p_tiers) <> 'array' OR jsonb_array_length(p_tiers) > 200 THEN
    RAISE EXCEPTION 'Danh sách bậc phải là mảng (tối đa 200 bậc)' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_tiers) e
              WHERE jsonb_typeof(e) <> 'object'
                 OR jsonb_typeof(e -> 'tier_number') IS DISTINCT FROM 'number'
                 OR jsonb_typeof(e -> 'from_value') IS DISTINCT FROM 'number'
                 OR coalesce(jsonb_typeof(e -> 'to_value'), 'null') NOT IN ('number', 'null')
                 OR jsonb_typeof(e -> 'unit_price') IS DISTINCT FROM 'number') THEN
    RAISE EXCEPTION 'Mỗi bậc cần tier_number, from_value, unit_price (số) và to_value (số hoặc null)' USING ERRCODE = '22023';
  END IF;

  -- Luồng hôm nay vốn UPDATE dòng định mức (tên, mô tả): FOR UPDATE đòi đúng quyền đó (xem + sửa định mức).
  PERFORM 1 FROM public.service_quotas WHERE id = p_quota_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy định mức này hoặc tài khoản chưa có quyền sửa. Tải lại danh sách để kiểm tra.' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.service_quotas SET name = p_name, description = p_description
   WHERE id = p_quota_id
  RETURNING jsonb_build_object('id', id, 'name', name, 'description', description, 'organization_id', organization_id)
    INTO v_quota;
  IF v_quota IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy định mức này hoặc tài khoản chưa có quyền sửa. Tải lại danh sách để kiểm tra.' USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM public.service_quota_tiers WHERE quota_id = p_quota_id;
  IF EXISTS (SELECT 1 FROM public.service_quota_tiers WHERE quota_id = p_quota_id) THEN
    RAISE EXCEPTION 'Chưa gỡ được bậc giá cũ của định mức: tài khoản chưa có quyền gỡ bậc. Chưa lưu thay đổi nào.' USING ERRCODE = '42501';
  END IF;

  WITH ins AS (
    INSERT INTO public.service_quota_tiers (quota_id, tier_number, from_value, to_value, unit_price)
    SELECT p_quota_id, (t.e ->> 'tier_number')::integer, (t.e ->> 'from_value')::numeric, (t.e ->> 'to_value')::numeric,
           (t.e ->> 'unit_price')::numeric
      FROM jsonb_array_elements(p_tiers) WITH ORDINALITY AS t(e, n)
     ORDER BY t.n
    RETURNING id, quota_id, tier_number, from_value, to_value, unit_price
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', ins.id, 'quota_id', ins.quota_id, 'tier_number', ins.tier_number,
                                               'from_value', ins.from_value, 'to_value', ins.to_value, 'unit_price', ins.unit_price)
                            ORDER BY ins.tier_number), '[]'::jsonb)
    INTO v_tiers FROM ins;
  RETURN jsonb_build_object('quota', v_quota, 'tiers', v_tiers);
END;
$function$;

-- ── 3. Phiếu nhập vật tư: đầu phiếu + toàn bộ dòng ──────────────────────────────────────────────────────────────────────
-- Bộ đích: [{material_id, quantity, unit_price}] (mảng rỗng = phiếu không còn dòng nào, như sửa phiếu hôm nay).
CREATE OR REPLACE FUNCTION public.replace_material_purchase_v1(p_purchase_id uuid, p_purchase_date date, p_supplier_id uuid, p_notes text, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY INVOKER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_header jsonb;
  v_items  jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_purchase_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu mã phiếu nhập' USING ERRCODE = '22023';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 500 THEN
    RAISE EXCEPTION 'Danh sách dòng phải là mảng (tối đa 500 dòng)' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) e
              WHERE jsonb_typeof(e) <> 'object'
                 OR jsonb_typeof(e -> 'material_id') IS DISTINCT FROM 'string'
                 OR jsonb_typeof(e -> 'quantity') IS DISTINCT FROM 'number'
                 OR jsonb_typeof(e -> 'unit_price') IS DISTINCT FROM 'number') THEN
    RAISE EXCEPTION 'Mỗi dòng cần material_id (chuỗi), quantity và unit_price (số)' USING ERRCODE = '22023';
  END IF;

  -- Luồng hôm nay vốn UPDATE đầu phiếu: FOR UPDATE đòi đúng quyền đó (xem + sửa vật tư). Khoá đầu phiếu cũng chặn lệnh
  -- chèn dòng song song vào phiếu này (khoá ngoại cần khoá chia sẻ trên đầu phiếu) tới khi giao dịch này xong.
  PERFORM 1 FROM public.material_purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu nhập này hoặc tài khoản chưa có quyền sửa. Tải lại danh sách để kiểm tra.' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.material_purchases
     SET purchase_date = p_purchase_date, supplier_id = p_supplier_id, notes = p_notes
   WHERE id = p_purchase_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu nhập này hoặc tài khoản chưa có quyền sửa. Tải lại danh sách để kiểm tra.' USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM public.material_purchase_items WHERE purchase_id = p_purchase_id;
  IF EXISTS (SELECT 1 FROM public.material_purchase_items WHERE purchase_id = p_purchase_id) THEN
    RAISE EXCEPTION 'Chưa gỡ được các dòng cũ của phiếu nhập: tài khoản chưa có quyền xoá dòng. Chưa lưu thay đổi nào.' USING ERRCODE = '42501';
  END IF;

  WITH ins AS (
    INSERT INTO public.material_purchase_items (purchase_id, material_id, quantity, unit_price)
    SELECT p_purchase_id, (t.e ->> 'material_id')::uuid, (t.e ->> 'quantity')::numeric, (t.e ->> 'unit_price')::numeric
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, n)
     ORDER BY t.n
    RETURNING id, purchase_id, material_id, quantity, unit_price
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', ins.id, 'purchase_id', ins.purchase_id, 'material_id', ins.material_id,
                                               'quantity', ins.quantity, 'unit_price', ins.unit_price)
                            ORDER BY ins.material_id, ins.id), '[]'::jsonb)
    INTO v_items FROM ins;

  -- Đầu phiếu đọc SAU khi trigger tính lại tổng từ mọi dòng.
  SELECT jsonb_build_object('id', p.id, 'organization_id', p.organization_id, 'code', p.code, 'purchase_date', p.purchase_date,
                            'supplier_id', p.supplier_id, 'notes', p.notes, 'total', p.total)
    INTO v_header FROM public.material_purchases p WHERE p.id = p_purchase_id;
  RETURN jsonb_build_object('purchase', v_header, 'items', v_items);
END;
$function$;

-- ── 4. Vật tư của công việc (một phiếu xuất mỗi công việc, uq_material_usages_job) ─────────────────────────────────────
-- Bộ đích: [{material_id, quantity, unit_cost_at_usage}]. Giữ nghĩa hiện tại: chưa có phiếu + bộ rỗng ⇒ không làm gì;
-- chưa có phiếu ⇒ tạo phiếu (người lập, công ty, mã phiếu do trigger); có phiếu ⇒ sửa ngày / ghi chú rồi thay toàn bộ dòng;
-- bộ rỗng ⇒ gỡ phiếu. Tài khoản không có quyền xoá phiếu thì phiếu rỗng ở lại (y như ghi thẳng hôm nay) và kết quả nói rõ
-- `removed: false`.
CREATE OR REPLACE FUNCTION public.save_job_material_usage_v1(p_job_id uuid, p_usage_date date, p_notes text, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY INVOKER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_id      uuid;
  v_deleted uuid;
  v_removed boolean := false;
  v_header  jsonb;
  v_items   jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu mã công việc' USING ERRCODE = '22023';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 500 THEN
    RAISE EXCEPTION 'Danh sách vật tư phải là mảng (tối đa 500 dòng)' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) e
              WHERE jsonb_typeof(e) <> 'object'
                 OR jsonb_typeof(e -> 'material_id') IS DISTINCT FROM 'string'
                 OR jsonb_typeof(e -> 'quantity') IS DISTINCT FROM 'number'
                 OR jsonb_typeof(e -> 'unit_cost_at_usage') IS DISTINCT FROM 'number') THEN
    RAISE EXCEPTION 'Mỗi dòng cần material_id (chuỗi), quantity và unit_cost_at_usage (số)' USING ERRCODE = '22023';
  END IF;

  -- Khoá tư vấn theo công việc TRƯỚC khi tra phiếu: hai lần lưu đầu tiên cùng lúc không cùng tạo phiếu (lần sau thấy phiếu
  -- lần trước vừa tạo và đi nhánh sửa). Không khoá dòng công việc (sẽ đòi quyền sửa công việc).
  PERFORM pg_advisory_xact_lock(hashtextextended('save_job_material_usage_v1:' || p_job_id::text, 0));

  SELECT u.id INTO v_id FROM public.material_usages u WHERE u.job_id = p_job_id;

  IF v_id IS NOT NULL THEN
    -- Luồng hôm nay vốn UPDATE đầu phiếu: FOR UPDATE đòi đúng quyền đó (xem + sửa vật tư).
    PERFORM 1 FROM public.material_usages WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Không sửa được phiếu xuất của công việc này: tài khoản chưa có quyền sửa, hoặc phiếu vừa bị xoá. Tải lại để kiểm tra.' USING ERRCODE = 'P0002';
    END IF;
    UPDATE public.material_usages SET usage_date = p_usage_date, notes = p_notes WHERE id = v_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Không sửa được phiếu xuất của công việc này: tài khoản chưa có quyền sửa, hoặc phiếu vừa bị xoá. Tải lại để kiểm tra.' USING ERRCODE = 'P0002';
    END IF;
    DELETE FROM public.material_usage_items WHERE usage_id = v_id;
    IF EXISTS (SELECT 1 FROM public.material_usage_items WHERE usage_id = v_id) THEN
      RAISE EXCEPTION 'Chưa gỡ được vật tư cũ của công việc: tài khoản chưa có quyền xoá dòng. Chưa lưu thay đổi nào.' USING ERRCODE = '42501';
    END IF;
    IF jsonb_array_length(p_items) = 0 THEN
      DELETE FROM public.material_usages WHERE id = v_id RETURNING id INTO v_deleted;
      v_removed := v_deleted IS NOT NULL;
    END IF;
  ELSIF jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('usage_id', NULL, 'usage', NULL, 'removed', false, 'items', '[]'::jsonb);
  ELSE
    INSERT INTO public.material_usages (job_id, usage_date, notes)
    VALUES (p_job_id, p_usage_date, p_notes)
    RETURNING id INTO v_id;
  END IF;

  IF jsonb_array_length(p_items) > 0 THEN
    WITH ins AS (
      INSERT INTO public.material_usage_items (usage_id, material_id, quantity, unit_cost_at_usage)
      SELECT v_id, (t.e ->> 'material_id')::uuid, (t.e ->> 'quantity')::numeric, (t.e ->> 'unit_cost_at_usage')::numeric
        FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, n)
       ORDER BY t.n
      RETURNING id, usage_id, material_id, quantity, unit_cost_at_usage
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', ins.id, 'usage_id', ins.usage_id, 'material_id', ins.material_id,
                                                 'quantity', ins.quantity, 'unit_cost_at_usage', ins.unit_cost_at_usage)
                              ORDER BY ins.material_id, ins.id), '[]'::jsonb)
      INTO v_items FROM ins;
  END IF;

  IF NOT v_removed THEN
    SELECT jsonb_build_object('id', u.id, 'job_id', u.job_id, 'code', u.code, 'usage_date', u.usage_date, 'notes', u.notes,
                              'organization_id', u.organization_id)
      INTO v_header FROM public.material_usages u WHERE u.id = v_id;
  END IF;
  RETURN jsonb_build_object('usage_id', v_id, 'usage', v_header, 'removed', v_removed, 'items', v_items);
END;
$function$;

-- ── 5. Dịch vụ của hợp đồng khi SỬA hợp đồng ─────────────────────────────────────────────────────────────────────────────
-- Bộ đích: [{service_id, unit_price, initial_reading?}]. Chỉ thay bước «xoá rồi chèn lại» dịch vụ của luồng sửa hợp đồng;
-- thông tin hợp đồng và khách của hợp đồng vẫn đi các bước riêng như cũ.
CREATE OR REPLACE FUNCTION public.replace_contract_services_v1(p_contract_id uuid, p_services jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY INVOKER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_rows jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_contract_id IS NULL THEN
    RAISE EXCEPTION 'Thiếu mã hợp đồng' USING ERRCODE = '22023';
  END IF;
  IF p_services IS NULL OR jsonb_typeof(p_services) <> 'array' OR jsonb_array_length(p_services) > 200 THEN
    RAISE EXCEPTION 'Danh sách dịch vụ phải là mảng (tối đa 200 dịch vụ)' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_services) e
              WHERE jsonb_typeof(e) <> 'object'
                 OR jsonb_typeof(e -> 'service_id') IS DISTINCT FROM 'string'
                 OR jsonb_typeof(e -> 'unit_price') IS DISTINCT FROM 'number'
                 OR coalesce(jsonb_typeof(e -> 'initial_reading'), 'null') NOT IN ('number', 'null')) THEN
    RAISE EXCEPTION 'Mỗi dịch vụ cần service_id (chuỗi), unit_price (số), initial_reading (số hoặc null)' USING ERRCODE = '22023';
  END IF;

  -- Bước dịch vụ của luồng sửa hợp đồng không sửa dòng hợp đồng (quyền dòng con: contracts.delete + contracts.create), nên
  -- không khoá FOR UPDATE dòng đó (sẽ đòi thêm quyền sửa hợp đồng): khoá tư vấn theo hợp đồng.
  PERFORM pg_advisory_xact_lock(hashtextextended('replace_contract_services_v1:' || p_contract_id::text, 0));

  DELETE FROM public.contract_services WHERE contract_id = p_contract_id;
  IF EXISTS (SELECT 1 FROM public.contract_services WHERE contract_id = p_contract_id) THEN
    RAISE EXCEPTION 'Chưa gỡ được dịch vụ cũ của hợp đồng: tài khoản chưa có quyền gỡ dịch vụ này. Chưa lưu thay đổi nào.' USING ERRCODE = '42501';
  END IF;

  WITH ins AS (
    INSERT INTO public.contract_services (contract_id, service_id, unit_price, initial_reading)
    SELECT p_contract_id, (t.e ->> 'service_id')::uuid, (t.e ->> 'unit_price')::numeric, (t.e ->> 'initial_reading')::numeric
      FROM jsonb_array_elements(p_services) WITH ORDINALITY AS t(e, n)
     ORDER BY t.n
    RETURNING id, contract_id, service_id, unit_price, initial_reading
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', ins.id, 'contract_id', ins.contract_id, 'service_id', ins.service_id,
                                               'unit_price', ins.unit_price, 'initial_reading', ins.initial_reading)
                            ORDER BY ins.service_id), '[]'::jsonb)
    INTO v_rows FROM ins;
  RETURN v_rows;
END;
$function$;

REVOKE ALL ON FUNCTION public.replace_building_services_v1(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.replace_service_quota_v1(uuid, text, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.replace_material_purchase_v1(uuid, date, uuid, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_job_material_usage_v1(uuid, date, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.replace_contract_services_v1(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_building_services_v1(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.replace_service_quota_v1(uuid, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.replace_material_purchase_v1(uuid, date, uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_job_material_usage_v1(uuid, date, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.replace_contract_services_v1(uuid, jsonb) TO authenticated;

-- ── Hậu kiểm ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
DO $hau_kiem$
DECLARE
  r record;
  v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.replace_building_services_v1(uuid,jsonb)',                    '5ff54ce7ded7553212e082e0978d2a46'),
      ('public.replace_service_quota_v1(uuid,text,text,jsonb)',              '40453b14ba8a9326b348cd2c92fc688b'),
      ('public.replace_material_purchase_v1(uuid,date,uuid,text,jsonb)',     '0f572afddd137642e78a9cdfb1ad0838'),
      ('public.save_job_material_usage_v1(uuid,date,text,jsonb)',            '4933a65582cdb58c9972c5416899d9db'),
      ('public.replace_contract_services_v1(uuid,jsonb)',                    '5644c4779e488047ab61a7fb950b766c')
    ) AS v(fn, file_md5) LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.fn);
    IF v_md5 IS DISTINCT FROM r.file_md5 THEN
      RAISE EXCEPTION 'xoa_chen_mot_giao_dich: % sau áp khác thân của tệp (md5 %)', r.fn, v_md5 USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                    WHERE p.oid = to_regprocedure(r.fn) AND NOT p.prosecdef AND p.provolatile = 'v'
                      AND p.proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
      RAISE EXCEPTION 'xoa_chen_mot_giao_dich: % phải là SECURITY INVOKER, VOLATILE, search_path ghim', r.fn USING ERRCODE = '55000';
    END IF;
    IF NOT has_function_privilege('authenticated', r.fn, 'EXECUTE')
       OR has_function_privilege('anon', r.fn, 'EXECUTE')
       OR has_function_privilege('service_role', r.fn, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = to_regprocedure(r.fn) AND a.grantee = 0) THEN
      RAISE EXCEPTION 'xoa_chen_mot_giao_dich: % sai ACL (chỉ authenticated được gọi)', r.fn USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('replace_building_services_v1', 'replace_service_quota_v1',
             'replace_material_purchase_v1', 'save_job_material_usage_v1', 'replace_contract_services_v1')) <> 5 THEN
    RAISE EXCEPTION 'xoa_chen_mot_giao_dich: mỗi hàm phải còn đúng một bản' USING ERRCODE = '55000';
  END IF;
END
$hau_kiem$;
